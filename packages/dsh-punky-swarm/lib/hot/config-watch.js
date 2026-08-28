/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// lib/hot/config-watch.js —— R1 热更新运行时（能力开关实时生效，叠加非替换）
// 设计依据：exec/panel-design.md §3.1（触发源/传播/生效语义）+ §3.1.5（判定语义双套保留、值传播）
// 链路：<root>/config/runtime.json（JSON）──fs.watch + 防抖 300ms──▶ 原子读重试 ──▶ 覆盖键校验 ──▶
//       deepMerge（导出复用 assembly/schema.js，禁止复制）──▶ 新快照 ──▶ onChange({key,value,config}) 广播
// 语义：
//   - 叠加非替换：只影响被覆盖键的后续读取；不写任何静态文件、不改变 cordis.patch.yml 读取结果（D2）
//   - 缺省 {} → 快照 = 静态 config 原样（零行为变化，启动不广播）
//   - 覆盖键校验：仅既有 schema 路径（注册表能力根 + 插件消费配置段），拒绝未知顶层键/未知 capabilities 子键
//   - 快照 diff：无变化键不广播（防 fs.watch 重复事件抖动）
//   - 坏 JSON / 读取失败：保持旧快照零行为变化（不广播），warn 留痕
//   - 零新依赖：node:fs watch + JSON.parse（D1）
// 实施回注（本环境实测，2026-08-29）：设计 §3.1.3「对文件所在目录 watch」在本部署（Windows/Node v24）不可用——
//   目录级 fs.watch 在目录内任意文件写入/重命名时触发 libuv 断言崩溃（src\win\fs-event.c:72，原生 abort 不可捕获，
//   探针复现：direct write 与 tmp+rename 两种写入模式均崩）。改为「文件级 fs.watch（runtime.json 直 watch）+
//   存在性轮询 bootstrap（文件缺失时低频探测，出现即建 watch + 触发一次重读）」。文件级 watch 在本环境实测稳定
//   （direct write→change 事件、tmp+rename→rename 事件均正常，探针通过）。此回注写入 exec/panel-a-fix.md。
// 生命周期：start()（幂等）/ stop()（幂等）/ dispose()；watcher/timer 均 unref（不阻塞进程退出）
// 宿主事件广播由装配侧（index.js）承担：ctx.emit('dsh-punky-swarm/config.changed', payload)；
//   本模块只负责文件 watch → 快照 → onChange 回调（可单测，无宿主依赖）
import { watch, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deepMerge, CAPABILITY_REGISTRY } from '../assembly/schema.js';

// cordis 总线事件名（config.changed 广播契约；装配侧 ctx.emit 用）
export const CONFIG_CHANGED_EVENT = 'dsh-punky-swarm/config.changed';

const DEFAULT_DEBOUNCE_MS = 300;   // 防抖窗口（设计 §3.1.3）
const PARSE_RETRY_MS = 50;         // 原子读重试间隔（写半文件/并发写窗口）
const PARSE_RETRY_MAX = 4;         // 重试上限（仍失败 → 保持旧快照）
const DEFAULT_POLL_MS = 1000;      // 存在性轮询间隔（文件缺失 bootstrap；文件级 watch 需文件存在）

// 允许的 runtime.json 顶层键：注册表能力根（aip/acps/capabilities）+ 插件消费的非能力配置段
// （mailbox/resume/ratchet/escalation）。热更新只做值传播、只覆盖既有 schema 路径——
// 拒绝未知顶层键防拼写漂移产生幽灵配置（设计 §3.1.3「拒绝未知顶层键」；契约验收④）
export const ALLOWED_TOP_KEYS = new Set([
  'aip', 'acps', 'capabilities',
  'mailbox', 'resume', 'ratchet', 'escalation',
]);

// capabilities 子键白名单（注册表 path[0]==='capabilities' 的既有键）——
// 拒绝 capabilities.<未知> 幽灵配置（discovery/verify/watch/worktree/budget/trajectory/logs/topic）
export const ALLOWED_CAPS_KEYS = new Set(
  CAPABILITY_REGISTRY.filter((e) => e.path[0] === 'capabilities').map((e) => e.path[1]),
);

// 覆盖层校验（纯函数，单测面）：返回 { ok, errors }
export function validateOverlay(overlay) {
  const errors = [];
  if (overlay === null || typeof overlay !== 'object' || Array.isArray(overlay)) {
    return { ok: false, errors: ['runtime overlay must be a JSON object'] };
  }
  for (const [k, v] of Object.entries(overlay)) {
    if (!ALLOWED_TOP_KEYS.has(k)) {
      errors.push('unknown top-level key: ' + k + ' (allowed: ' + [...ALLOWED_TOP_KEYS].join(', ') + ')');
      continue;
    }
    if (k === 'capabilities' && v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const ck of Object.keys(v)) {
        if (!ALLOWED_CAPS_KEYS.has(ck)) {
          errors.push('unknown capabilities key: ' + ck + ' (allowed: ' + [...ALLOWED_CAPS_KEYS].join(', ') + ')');
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 原子读：JSON.parse 失败短等待重试（原子写 = tmp+rename，读者只会看到旧或新完整文件；
// 首次创建窗口仍可能读到半文件——重试兜底）；重试耗尽抛错（保持旧快照由调用方处置）
async function readOverlayFile(file) {
  for (let i = 0; i < PARSE_RETRY_MAX; i++) {
    try {
      if (!existsSync(file)) return {};
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('runtime.json must be a JSON object');
      }
      return parsed;
    } catch (e) {
      if (i === PARSE_RETRY_MAX - 1) throw e;
      await sleep(PARSE_RETRY_MS * (i + 1));
    }
  }
  return {};
}

export function createConfigWatcher({ root, config, onChange, logger, debounceMs = DEFAULT_DEBOUNCE_MS, useWatcher = true, pollMs = DEFAULT_POLL_MS } = {}) {
  const configDir = join(root, 'config');
  const runtimeFile = join(configDir, 'runtime.json');
  const log = logger ?? null;
  let snapshot = config;       // 缺省 = 静态 config 原样（零行为变化）
  let overlay = {};            // 当前生效覆盖层
  let fileWatcher = null;      // 文件级 watch（本环境目录级 watch 触发 libuv 断言崩溃，实施回注）
  let existenceTimer = null;   // 文件缺失 bootstrap 轮询
  let debounceTimer = null;
  let started = false;
  let disposed = false;

  function mergeAndNotify(nextOverlay) {
    const next = deepMerge(config, nextOverlay);
    // 快照 diff：只广播实际变化的顶层键（无变化键不广播——防 fs.watch 重复事件/无意义变更抖动）
    const changed = [];
    const keys = new Set([...Object.keys(snapshot), ...Object.keys(next)]);
    for (const k of keys) {
      if (JSON.stringify(snapshot[k]) !== JSON.stringify(next[k])) changed.push(k);
    }
    if (changed.length === 0) return { changed: [] };
    snapshot = next;
    for (const k of changed) {
      try {
        onChange?.({ key: k, value: next[k], config: next });
      } catch (e) {
        log?.warn?.('[dsh-punky-swarm] hot config onChange failed: ' + String(e?.message ?? e));
      }
    }
    log?.info?.('[dsh-punky-swarm] runtime config applied: ' + changed.join(', ') + '（热更新叠加，静态配置零改动）');
    return { changed };
  }

  // 重读 runtime.json → 校验 → 合并 → 广播（坏 JSON/未知键 → 保持旧快照零行为变化）
  async function reload() {
    if (disposed) return { ok: false };
    let nextOverlay;
    try {
      nextOverlay = await readOverlayFile(runtimeFile);
    } catch (e) {
      log?.warn?.('[dsh-punky-swarm] runtime.json read failed (keep previous snapshot): ' + String(e?.message ?? e));
      return { ok: false, reason: 'read-failed' };
    }
    const v = validateOverlay(nextOverlay);
    if (!v.ok) {
      log?.warn?.('[dsh-punky-swarm] runtime.json overlay rejected (keep previous snapshot): ' + v.errors.join('; '));
      return { ok: false, reason: 'invalid-overlay', errors: v.errors };
    }
    overlay = nextOverlay;
    return { ok: true, ...mergeAndNotify(nextOverlay) };
  }

  async function handleFsChange() {
    if (disposed || !started) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { reload().catch(() => {}); }, debounceMs);
  }

  // 文件级 watch 建立/重建（幂等）：每次事件后重建以跟随原子替换（tmp+rename 换 inode）；
  // 文件缺失 → 存在性轮询 bootstrap（低频，unref），出现后建 watch + 触发一次重读
  function ensureWatching() {
    if (disposed || !started) return;
    if (fileWatcher) {
      try { fileWatcher.close(); } catch {}
      fileWatcher = null;
    }
    if (!existsSync(runtimeFile)) {
      if (!existenceTimer) {
        existenceTimer = setInterval(() => {
          if (disposed || !started) { clearInterval(existenceTimer); existenceTimer = null; return; }
          if (existsSync(runtimeFile)) {
            clearInterval(existenceTimer); existenceTimer = null;
            ensureWatching();
            handleFsChange().catch(() => {}); // 文件出现 → 重读一次（覆盖建 watch 前的首次写入）
          }
        }, pollMs);
        if (typeof existenceTimer.unref === 'function') existenceTimer.unref();
      }
      return;
    }
    try {
      fileWatcher = watch(runtimeFile, () => {
        ensureWatching(); // 跟随原子替换重建（幂等）
        handleFsChange().catch(() => {});
      });
      if (typeof fileWatcher.unref === 'function') fileWatcher.unref();
      fileWatcher.on?.('error', (e) => {
        log?.warn?.('[dsh-punky-swarm] runtime.json watch error (config hot reload degraded): ' + String(e?.message ?? e));
        ensureWatching();
      });
    } catch (e) {
      log?.warn?.('[dsh-punky-swarm] runtime.json watch failed (config hot reload disabled, restart to apply): ' + String(e?.message ?? e));
      fileWatcher = null;
    }
  }

  function start() {
    if (started) return { started: true, snapshot };
    started = true;
    mkdirSync(configDir, { recursive: true });
    // 初始 overlay 同步读取（启动不广播——启动时静态 config 即现状；缺省 {} → 快照 = 静态 config 原样）
    if (existsSync(runtimeFile)) {
      try {
        const init = JSON.parse(readFileSync(runtimeFile, 'utf8'));
        if (init !== null && typeof init === 'object' && !Array.isArray(init)) {
          const v = validateOverlay(init);
          if (v.ok) {
            overlay = init;
            snapshot = deepMerge(config, init);
          } else {
            log?.warn?.('[dsh-punky-swarm] runtime.json initial overlay rejected (use static config): ' + v.errors.join('; '));
          }
        } else {
          log?.warn?.('[dsh-punky-swarm] runtime.json initial overlay must be a JSON object (use static config)');
        }
      } catch (e) {
        log?.warn?.('[dsh-punky-swarm] runtime.json initial read failed (use static config): ' + String(e?.message ?? e));
      }
    }
    // 文件级 watch（实施回注：本环境目录级 watch 触发 libuv 断言崩溃，改直 watch 文件）+ 存在性轮询 bootstrap
    if (useWatcher && typeof watch === 'function') {
      ensureWatching();
    }
    return { started: true, snapshot };
  }

  function stop() {
    started = false;
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (fileWatcher) { try { fileWatcher.close(); } catch {} fileWatcher = null; }
    if (existenceTimer) { clearInterval(existenceTimer); existenceTimer = null; }
    return { stopped: true };
  }

  function dispose() {
    disposed = true;
    stop();
  }

  function readSnapshot() {
    return snapshot;
  }

  return { start, stop, dispose, reload, readSnapshot, validateOverlay, runtimeFile, eventName: CONFIG_CHANGED_EVENT };
}
