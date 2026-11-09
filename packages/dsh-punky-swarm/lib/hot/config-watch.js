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

// lib/hot/config-watch.js —— 热更新运行时（能力开关实时生效，叠加非替换）
// 设计要点：触发源/传播/生效语义 + 判定语义双套保留、值传播
// 链路：<root>/config/runtime.json（JSON）──fs.watch + 防抖 300ms──▶ 原子读重试 ──▶ 覆盖键校验 ──▶
//       deepMerge（导出复用 assembly/schema.js，禁止复制）──▶ 新快照 ──▶ onChange({key,value,config}) 广播
// 语义：
//   - 叠加非替换：只影响被覆盖键的后续读取；不写任何静态文件、不改变 cordis.patch.yml 读取结果
//   - 缺省 {} → 快照 = 静态 config 原样（零行为变化，启动不广播）
//   - 覆盖键校验：仅既有 schema 路径（注册表能力根 + 插件消费配置段），拒绝未知顶层键/未知 capabilities 子键
//   - 快照 diff：无变化键不广播（防 fs.watch 重复事件抖动）
//   - 坏 JSON / 读取失败：保持旧快照零行为变化（不广播），warn 留痕
//   - 零新依赖：node:fs watch + JSON.parse
// 实施回注（本环境实测）：目录级 fs.watch 在目录内任意文件写入/重命名时触发 libuv 断言崩溃
//   （src\win\fs-event.c:72，原生 abort 不可捕获，探针复现：direct write 与 tmp+rename 两种写入模式均崩）。
//   改为「文件级 fs.watch（runtime.json 直 watch）+ 存在性轮询 bootstrap（文件缺失时低频探测，
//   出现即建 watch + 触发一次重读）」。文件级 watch 在本环境实测稳定
//   （direct write→change 事件、tmp+rename→rename 事件均正常，探针通过）。
// 生命周期：start()（幂等）/ stop()（幂等）/ dispose()；watcher/timer 均 unref（不阻塞进程退出）
// 宿主事件广播由装配侧（index.js）承担：ctx.emit('dsh-punky-swarm/config.changed', payload)；
//   本模块只负责文件 watch → 快照 → onChange 回调（可单测，无宿主依赖）
import fs from 'node:fs';
import { join } from 'node:path';
import { deepMerge, CAPABILITY_REGISTRY, injectBudgetValueErrors } from '../assembly/schema.js';
import { loadRules } from '../state/machine-rules.js';

// cordis 总线事件名（config.changed 广播契约；装配侧 ctx.emit 用）
export const CONFIG_CHANGED_EVENT = 'dsh-punky-swarm/config.changed';

const DEFAULT_DEBOUNCE_MS = 300;   // 防抖窗口
const PARSE_RETRY_MS = 50;         // 原子读重试间隔（写半文件/并发写窗口）
const PARSE_RETRY_MAX = 4;         // 重试上限（仍失败 → 保持旧快照）
const DEFAULT_POLL_MS = 1000;      // 存在性轮询间隔（文件缺失 bootstrap；文件级 watch 需文件存在）
// 缺口修复：watch 建立失败的重试策略——**禁止一次性锁死**。
//   实测缺陷：外部工具改写 runtime.json 时 Windows 抛 EBUSY，`watch()` 失败被永久降级
//   （日志 'config hot reload disabled, restart to apply' 且此后不重试）→ 后续即便经官方 API 写入也不重载。
//   现策略：退避重试至上限；仍失败才降级并保留手动 reload 能力（reload 仍可显式调用）。
const WATCH_RETRY_MAX = 5;
const WATCH_RETRY_MS = 200;

export function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}
function parseJsonText(text) {
  return JSON.parse(stripBom(text));
}

// 允许的 runtime.json 顶层键：注册表能力根（aip/acps/capabilities）+ 插件消费的非能力配置段
// （mailbox/resume/ratchet/escalation/governance——governance 纳入热更：
//   子键覆盖由 deepMerge 传播，仅顶层校验，与 mailbox 等非能力段同口径；装配侧 applyConfigChange
//   消费 governance 变化做 dispose+重挂）。
// 热更新只做值传播、只覆盖既有 schema 路径——拒绝未知顶层键防拼写漂移产生幽灵配置
export const ALLOWED_TOP_KEYS = new Set([
  'aip', 'acps', 'capabilities',
  'mailbox', 'resume', 'ratchet', 'escalation', 'governance',
  // modes（模式跟随）：`modes.gate` 白名单 = 哪些 agent preset 启用蟛蜞治理。
  //   纳入热更 ⇒ 切模式/改白名单**无需重启**（guard 与套件工具读的是热更快照）。
  'modes',
  // dispatch（C/E 阶段派发面）：provider / gate 纳入热更，便于「先 warn 观察 → 配齐后切 enforce」不重启。
  'dispatch',
  // gates（P1/P2 交接门开关）：**门禁只与插件有关**——开关必须落在
  //   `<root>/config/runtime.json`（本白名单内），**不得**依赖启动父进程的环境块（Desktop 应用派生
  //   web 宿主的场景下 env 永远带不进来 ⇒ 门永远开不了/关不掉）。
  //   形态：`{ "gates": { "handoff": { "entry": true, "settle": true } } }`（两段可各自开关；
  //   也可写段级 `"enabled": true` 作两段共同缺省）。**放入本白名单 = 允许热更**——漏加会被
  //   `validateOverlay` 判 `unknown top-level key` 而**静默保持旧快照**（本类改动的经典坑）。
  'gates',
  'autoSettle',
]);

let CURRENT_SNAPSHOT = null;
/** 读「当前生效运行时快照」；未生效 ⇒ 返回 `fallback`（缺省 `{}`）。 */
export function readRuntimeSnapshot(fallback = {}) {
  return CURRENT_SNAPSHOT ?? fallback;
}
function publishRuntimeSnapshot(v) {
  CURRENT_SNAPSHOT = v;
}

export function ratchetHotGuard({ next, lastJson, loadRulesFn = loadRules }) {
  const json = JSON.stringify(next?.ratchet ?? null);
  if (json === lastJson) return { json, changed: false, valid: true, message: null };
  let valid = true;
  let message = null;
  try {
    loadRulesFn(next ?? {});
    message = 'ratchet 变更已接受但**需重启生效**（棘轮表在装配期注入 createStore({rules})，热更不应用）';
  } catch (e) {
    valid = false;
    message = 'ratchet 变更非法（本次热更未应用；**且下次重启时装配将失败**）: ' + String(e?.message ?? e);
  }
  return { json, changed: true, valid, message };
}

// capabilities 子键白名单（注册表 path[0]==='capabilities' 的既有键）——
// 拒绝 capabilities.<未知> 幽灵配置（discovery/verify/watch/worktree/budget/trajectory/logs/topic）
const ALLOWED_CAPS_KEYS = new Set(
  CAPABILITY_REGISTRY.filter((e) => e.path[0] === 'capabilities').map((e) => e.path[1]),
);

// 覆盖层校验（纯函数，单测面）：返回 { ok, errors }
export function validateOverlay(overlay) {
  const split = splitOverlay(overlay);
  return split.fatal
    ? { ok: false, errors: ['runtime overlay must be a JSON object'] }
    : { ok: split.rejected.length === 0, errors: split.rejected.map((r) => r.reason) };
}

// 覆盖层**逐键**拆分（纯函数，单测面）：{ accepted, rejected:[{key,reason}], fatal }
// ── 为什么必须逐键（P0 · D-07 修复，判据源 RQ-7 / AC-13）────────────────────────
// 「整份接受或整份拒绝」的后果不是「配置没生效」而是**静默 fail-open**：坏键 ⇒ 整份被拒 ⇒
//   `publishRuntimeSnapshot` 不执行 ⇒ `CURRENT_SNAPSHOT` 恒 `null` ⇒ `readRuntimeSnapshot({})` = `{}`
//   ⇒ `gates.*` 全部解析为**缺省关**（交接门 / 结算门 / targets 门同时静默失效），唯一信号是一行 warn；
//   且写通道对整份 overlay 跑同一校验 ⇒ 用户**无法经面板修掉自己写坏的那个键**（只能手改文件）。
// 口径：坏键**只废该键**（进 `rejected` 供日志点名），其余合法键照常生效；
//   `capabilities` 段按**子键**粒度裁剪（一个坏子键不得连带废掉整段能力开关）。
// `fatal` = overlay 根本不是对象（形态错）⇒ 无「逐键」可言，调用方须保持旧快照。
/** @returns {{accepted: Record<string, unknown>, rejected: Array<{key: string, reason: string}>, fatal: boolean}} */
export function splitOverlay(overlay) {
  const rejected = [];
  if (overlay === null || typeof overlay !== 'object' || Array.isArray(overlay)) {
    return { accepted: {}, rejected: [], fatal: true };
  }
  const accepted = {};
  for (const [k, v] of Object.entries(overlay)) {
    if (!ALLOWED_TOP_KEYS.has(k)) {
      rejected.push({ key: k, reason: 'unknown top-level key: ' + k + ' (allowed: ' + [...ALLOWED_TOP_KEYS].join(', ') + ')' });
      continue;
    }
    if (k === 'capabilities' && v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const kept = {};
      for (const ck of Object.keys(v)) {
        if (!ALLOWED_CAPS_KEYS.has(ck)) {
          rejected.push({ key: k + '.' + ck, reason: 'unknown capabilities key: ' + ck + ' (allowed: ' + [...ALLOWED_CAPS_KEYS].join(', ') + ')' });
          continue;
        }
        if (ck === 'injectBudget') {
          const errs = injectBudgetValueErrors(v[ck]);
          if (errs.length > 0) {
            rejected.push({ key: k + '.' + ck, reason: errs.join('; ') });
            continue;
          }
        }
        kept[ck] = v[ck];
      }
      accepted[k] = kept;
      continue;
    }
    accepted[k] = v;
  }
  return { accepted, rejected, fatal: false };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 原子读：JSON.parse 失败短等待重试（原子写 = tmp+rename，读者只会看到旧或新完整文件；
// 首次创建窗口仍可能读到半文件——重试兜底）；重试耗尽抛错（保持旧快照由调用方处置）
async function readOverlayFile(file) {
  for (let i = 0; i < PARSE_RETRY_MAX; i++) {
    try {
      if (!fs.existsSync(file)) return {};
      const parsed = parseJsonText(fs.readFileSync(file, 'utf8'));
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

export function createConfigWatcher({ root, config, onChange, logger, debounceMs = DEFAULT_DEBOUNCE_MS, useWatcher = true, pollMs = DEFAULT_POLL_MS, watchFn = null } = {}) {
  const configDir = join(root, 'config');
  const runtimeFile = join(configDir, 'runtime.json');
  const log = logger ?? null;
  // watch 实现可注入（测试模拟 EBUSY/失败重试）；生产缺省 = node:fs watch
  const watchImpl = typeof watchFn === 'function' ? watchFn : fs.watch;
  let snapshot = config;       // 缺省 = 静态 config 原样（零行为变化）
  let overlay = {};            // 当前生效覆盖层
  let fileWatcher = null;      // 文件级 watch（本环境目录级 watch 触发 libuv 断言崩溃，实施回注）
  let existenceTimer = null;   // 文件缺失 bootstrap 轮询
  let debounceTimer = null;
  let watchRetry = 0;          // watch 建立失败退避计数
  let watchRetryTimer = null;  // 退避重试定时器
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
    publishRuntimeSnapshot(snapshot); // `task-27`：门开关的模块级只读投影（与 snapshot 同一次写入）
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
    const split = splitOverlay(nextOverlay);
    if (split.fatal) {
      log?.warn?.('[dsh-punky-swarm] runtime.json overlay rejected (keep previous snapshot): runtime overlay must be a JSON object');
      return { ok: false, reason: 'invalid-overlay', errors: ['runtime overlay must be a JSON object'] };
    }
    // 逐键生效（D-07）：坏键只废该键并**点名**留在日志里，合法键照常生效
    if (split.rejected.length > 0) {
      log?.warn?.('[dsh-punky-swarm] runtime.json overlay partially applied — ignored keys: '
        + split.rejected.map((r) => r.key).join(', ')
        + '（原因：' + split.rejected.map((r) => r.reason).join('; ') + '；其余合法键已生效）');
    }
    overlay = split.accepted;
    return { ok: true, ignored: split.rejected, ...mergeAndNotify(split.accepted) };
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
    if (!fs.existsSync(runtimeFile)) {
      if (!existenceTimer) {
        existenceTimer = setInterval(() => {
          if (disposed || !started) { clearInterval(existenceTimer); existenceTimer = null; return; }
          if (fs.existsSync(runtimeFile)) {
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
      fileWatcher = watchImpl(runtimeFile, () => {
        ensureWatching(); // 跟随原子替换重建（幂等）
        handleFsChange().catch(() => {});
      });
      if (typeof fileWatcher.unref === 'function') fileWatcher.unref();
      fileWatcher.on?.('error', (e) => {
        log?.warn?.('[dsh-punky-swarm] runtime.json watch error (config hot reload degraded): ' + String(e?.message ?? e));
        ensureWatching();
      });
      watchRetry = 0; // 成功建立 → 重置退避计数
    } catch (e) {
      // 瞬时错（Windows 文件占用 → EBUSY）退避重试，不再一次性永久降级
      fileWatcher = null;
      watchRetry += 1;
      const msg = String(e?.message ?? e);
      if (watchRetry <= WATCH_RETRY_MAX) {
        log?.warn?.('[dsh-punky-swarm] runtime.json watch failed (retry ' + watchRetry + '/' + WATCH_RETRY_MAX + '): ' + msg);
        if (watchRetryTimer) clearTimeout(watchRetryTimer);
        watchRetryTimer = setTimeout(() => {
          watchRetryTimer = null;
          if (!disposed && started) ensureWatching();
        }, WATCH_RETRY_MS * watchRetry);
        if (typeof watchRetryTimer.unref === 'function') watchRetryTimer.unref();
      } else {
        log?.warn?.('[dsh-punky-swarm] runtime.json watch failed (config hot reload disabled after ' + WATCH_RETRY_MAX + ' retries; manual reload still available, restart to re-arm watch): ' + msg);
      }
    }
  }

  function start() {
    if (started) return { started: true, snapshot };
    started = true;
    fs.mkdirSync(configDir, { recursive: true });
    // 初始 overlay 同步读取（启动不广播——启动时静态 config 即现状；缺省 {} → 快照 = 静态 config 原样）
    if (fs.existsSync(runtimeFile)) {
      try {
        const init = parseJsonText(fs.readFileSync(runtimeFile, 'utf8'));
        const split = splitOverlay(init);
        if (split.fatal) {
          log?.warn?.('[dsh-punky-swarm] runtime.json initial overlay must be a JSON object (use static config)');
        } else {
          // 逐键生效（D-07）：坏键只废该键且**点名**进启动日志；合法键照常发布快照
          if (split.rejected.length > 0) {
            log?.warn?.('[dsh-punky-swarm] runtime.json initial overlay partially applied — ignored keys: '
              + split.rejected.map((r) => r.key).join(', ')
              + '（原因：' + split.rejected.map((r) => r.reason).join('; ') + '；其余合法键已生效）');
          }
          overlay = split.accepted;
          snapshot = deepMerge(config, split.accepted);
          publishRuntimeSnapshot(snapshot); // `task-27`：启动期初始 overlay 生效即发布（工具/门禁均可读）
        }
      } catch (e) {
        log?.warn?.('[dsh-punky-swarm] runtime.json initial read failed (use static config): ' + String(e?.message ?? e));
      }
    }
    // 文件级 watch（实施回注：本环境目录级 watch 触发 libuv 断言崩溃，改直 watch 文件）+ 存在性轮询 bootstrap
    if (useWatcher && typeof watchImpl === 'function') {
      ensureWatching();
    }
    return { started: true, snapshot };
  }

  function stop() {
    started = false;
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (watchRetryTimer) { clearTimeout(watchRetryTimer); watchRetryTimer = null; }
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
