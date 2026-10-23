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

// 宿主级生效冒烟的**支撑面**（只依赖 node 内置）：
//   ① 写盘台账（隔离自检的物理依据：每个本级写点都登记绝对路径）；
//   ② 真实 home 守卫面指纹（递归 sha，比对「装载前后逐字相同」）；
//   ③ 生产面探针（真实 session 目录名集 + 生产 sink 里是否出现本次 run tag）；
//   ④ 合成 ctx 夹具（对齐 `test/helpers/gate-fixture.mjs#assemblyCtxWeb` 的**同形自建**——
//      c1 不得 import `test/**`，见 plan §约束-写域冲突-3）；
//   ⑤ 判据原语：`expect` / `skip` / `expectThrow` / 死 pid 探测 / 递归枚举。
//
// 纪律：本文件**零写仓**（唯一写盘入口经 `writeLedgered` / `mkdirLedgered`，落点由调用方给的
//   隔离根决定）；不 import `test/**`；不 import `lib/**`（`lib` 只在主脚本内经**部署面入口**
//   动态载入，避免两个模块实例 —— 见主脚本 H-01/H-02 的装载说明）。

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── 判据原语 ────────────────────────────────────────────────────────────────

/** 断言（失败即该项 FAIL；同一项内的**阳性对照**失败会带 `阳性对照失败` 前缀，表示判据自身可疑）。 */
export function expect(cond, message) {
  if (!cond) throw new Error(message);
}

/** 抛 SKIP（单列、不算 pass；退出码语义见 D-1.4）。 */
export function skip(reason) {
  const error = new Error(reason);
  error.__skip = true;
  throw error;
}

/** 期望 fn()（可 async）抛错，且错误文案匹配 re；返回实得文案。 */
export async function expectThrow(fn, re, label) {
  let got = null;
  try {
    await fn();
  } catch (error) {
    got = String(error?.message ?? error);
  }
  if (got === null) throw new Error(label + '：期望被拒（throw），实际成功返回');
  if (re && !re.test(got)) throw new Error(label + '：拒态文案/码不匹配，期望 ' + String(re) + '，实得 ' + got.slice(0, 400));
  return got;
}

// ── 通用 IO ────────────────────────────────────────────────────────────────

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** 文件 sha256。**不存在 ⇒ 抛 ENOENT**（阳性对照依赖此行为：证明探针真的碰了盘）。 */
export function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function readJsonOrNull(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 递归枚举常规文件（跳过符号链接指向的目录 → 不跟随，防环形）。 */
export function listFiles(root, { maxEntries = 20000 } = {}) {
  const out = [];
  const walk = (dir) => {
    if (out.length >= maxEntries) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= maxEntries) return;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(abs);
    }
  };
  walk(root);
  return out;
}

/** 递归枚举目录名（仅目录，用于「真实 session 零新增」这类集合比对）。 */
export function listDirs(root, { maxEntries = 5000 } = {}) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries.slice(0, maxEntries)) if (entry.isDirectory()) out.push(entry.name);
  return out.sort();
}

/** 递归文件名集合（相对路径 + 大小），用于守卫面指纹。 */
export function treeDigest(root) {
  if (!fs.existsSync(root)) return { exists: false, sha: sha256('(absent)'), files: 0, bytes: 0 };
  const rows = [];
  let bytes = 0;
  for (const abs of listFiles(root)) {
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    rows.push(path.relative(root, abs).split(path.sep).join('/') + '|' + stat.size + '|' + Math.trunc(stat.mtimeMs));
    bytes += stat.size;
  }
  rows.sort();
  return { exists: true, sha: sha256(rows.join('\n')), files: rows.length, bytes };
}

// ── 写盘台账（隔离自检的物理依据）────────────────────────────────────────────

export function createLedger(isolationRoot) {
  const entries = [];
  const root = path.resolve(isolationRoot);
  const under = (abs) => {
    const rel = path.relative(root, path.resolve(abs));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  return {
    root,
    entries,
    /** 登记一次写盘（所有 mkdir/write 必须经此，否则台账不覆盖 ⇒ H-04 FAIL）。 */
    record(abs, kind = 'write') {
      entries.push({ path: path.resolve(abs), kind });
      return path.resolve(abs);
    },
    /** 台账自检：返回越界条目（每一条都必须为空才算隔离成立）。 */
    escapes() {
      return entries.filter((e) => !under(e.path));
    },
    mkdirp(dir) {
      this.record(dir, 'mkdir');
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    writeFile(file, body) {
      this.record(file, 'write');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body, 'utf8');
      return file;
    },
  };
}

// ── 真实 home 守卫面（H-04）──────────────────────────────────────────────────

/**
 * 守卫面指纹：两处「被 `syncAssets()` 真实覆写」的目录递归 + 其余面**仅顶层**。
 * 口径来源 plan §D-1.3 的风险行（递归 sha 太慢时降级，降级必须记 SKIP）。
 * ⚠ 真实 home **只读**：不 mkdir、不写、不 rm。
 */
export function guardFingerprint({ deep = true } = {}) {
  const realHome = realHomeDir();
  const deepRoots = [path.join(realHome, '.agents', 'skills'), path.join(realHome, '.dsh', '.agent-presets')];
  const shallowRoots = [path.join(realHome, '.agents'), path.join(realHome, '.dsh')];
  const rows = [];
  for (const dir of deepRoots) {
    const tree = deep ? treeDigest(dir) : { sha: '(deep-skipped)' };
    rows.push('deep:' + dir + '=' + tree.sha);
  }
  for (const dir of shallowRoots) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }).map((e) => e.name + (e.isDirectory() ? '/' : '')); } catch { entries = ['(absent)']; }
    rows.push('shallow:' + dir + '=' + sha256(entries.sort().join(',')));
  }
  return { sha: sha256(rows.join('\n')), rows, deep };
}

/** 真实 home 真源（`os.userInfo()` 不受 USERPROFILE/HOME 改写影响）。 */
export function realHomeDir() {
  try { return os.userInfo().homedir; } catch { return ''; }
}

/**
 * 生产面探针（真实 session/artifacts/生产日志）。
 * 判据不是「跑完后 mtime 不变」（**活体宿主正在写**，那样必然假红），而是：
 *   ① 真实 `sessions/` 的**目录名集合**不得新增含 runTag 的项；
 *   ② 生产 sink 目录（`<真实 home>/.dsh/logs/punky-swarm`）里不得出现本次 runTag。
 */
export function productionSnapshot() {
  const realHome = realHomeDir();
  const presetRoot = path.join(realHome, '.dsh', 'punky-preset');
  const sessionsDir = path.join(presetRoot, 'sessions');
  return {
    realHome,
    presetRoot,
    sessionsDir,
    sessionNames: listDirs(sessionsDir).map((n) => ({ name: n, artifacts: listDirs(path.join(sessionsDir, n, 'artifacts')) })),
    sinkDir: path.join(realHome, '.dsh', 'logs', 'punky-swarm'),
  };
}

/** 在生产 sink 目录里搜 runTag（读全文件，>8MB 只读首尾各 1MB 并如实标注）。 */
export function findRunTagInProductionSinks(sinkDir, runTag, { maxFileBytes = 8 * 1024 * 1024 } = {}) {
  const hits = [];
  const notes = [];
  for (const abs of listFiles(sinkDir, { maxEntries: 200 })) {
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    let text;
    if (stat.size > maxFileBytes) {
      const fd = fs.openSync(abs, 'r');
      try {
        const head = Buffer.alloc(1024 * 1024);
        const tail = Buffer.alloc(1024 * 1024);
        fs.readSync(fd, head, 0, head.length, 0);
        fs.readSync(fd, tail, 0, tail.length, Math.max(0, stat.size - tail.length));
        text = head.toString('utf8') + tail.toString('utf8');
      } finally { fs.closeSync(fd); }
      notes.push(path.basename(abs) + '：' + stat.size + ' B > 上限，只读首尾各 1MB');
    } else {
      try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    }
    if (text.includes(runTag)) hits.push(abs);
  }
  return { hits, notes };
}

// ── 合成 ctx 夹具（对齐 `test/helpers/gate-fixture.mjs#assemblyCtxWeb` 的同形自建）─────

/**
 * 装配 ctx 基线：`on` 项存**平坦 fn**（与 assemblyCtxWeb 同形）；`calls` 收集 logger 三档；
 * `tools.register` 收集注册实例（供按名取工具）；`webServer.register` 收集路由；
 * `logger.exporter` 收集 cordis logger exporter（审计 sink 挂载的前置：缺该函数 ⇒ sink 走 no-logger 分支）。
 * `ctx.get()` 返回 undefined —— 宿主「未 inject 服务」的**如实缺省**（不伪造宿主服务）。
 */
export function makeAssemblyCtx({ exporter = true } = {}) {
  const listeners = new Map();
  const calls = { info: [], warn: [], error: [] };
  const registered = [];
  const routes = [];
  const exporters = [];
  const logger = {
    info: (...a) => calls.info.push(a.join(' ')),
    warn: (...a) => calls.warn.push(a.join(' ')),
    error: (...a) => calls.error.push(a.join(' ')),
  };
  if (exporter) logger.exporter = (exp) => { exporters.push(exp); return () => { const i = exporters.indexOf(exp); if (i >= 0) exporters.splice(i, 1); }; };
  const ctx = {
    listeners, calls, logger, registered, routes, exporters,
    tools: { register: (t) => { registered.push(t); return () => { const i = registered.indexOf(t); if (i >= 0) registered.splice(i, 1); }; } },
    webServer: { register: (r) => { routes.push(r); return () => {}; } },
    emit: () => {},
    get: () => undefined,
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => { listeners.get(event)?.delete(fn); };
    },
  };
  return ctx;
}

/** 按名索引工具面（注册实例 → Map<name, tool>）。 */
export function toolIndex(registered) {
  const map = new Map();
  for (const tool of registered) if (tool && typeof tool.name === 'string') map.set(tool.name, tool);
  return map;
}

// ── 进程面 ─────────────────────────────────────────────────────────────────

/** 探一个**确实不存在**的 pid（`process.kill(pid,0)` 抛 ESRCH）——stale lock 构造用。 */
export function findDeadPid() {
  for (const pid of [999991, 999992, 999993, 888887, 777773, 666661]) {
    try { process.kill(pid, 0); } catch (error) { if (error?.code === 'ESRCH') return pid; }
  }
  return null;
}

/** 活动 handle 计数（H-02「卸载后无定时器残留」的读数面）。 */
export function activeHandlesCount() {
  const handles = typeof process._getActiveHandles === 'function' ? process._getActiveHandles() : [];
  const requests = typeof process._getActiveRequests === 'function' ? process._getActiveRequests() : [];
  return { handles: handles.length, requests: requests.length, total: handles.length + requests.length };
}

/** 跑 pwsh 查询（**只读**；H-14 的进程枚举）。返回值 `{ok, rows, error}`，失败不抛（由调用方决定 SKIP/FAIL）。 */
export function pwshJson(script, { timeoutMs = 25000 } = {}) {
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) return { ok: false, rows: null, error: String(result.error?.message ?? result.error) };
  if (result.status !== 0) return { ok: false, rows: null, error: 'exit ' + result.status + '：' + String(result.stderr ?? '').slice(0, 400) };
  const text = String(result.stdout ?? '').trim();
  if (!text) return { ok: true, rows: [], error: null };
  try {
    const parsed = JSON.parse(text);
    return { ok: true, rows: Array.isArray(parsed) ? parsed : [parsed], error: null };
  } catch (error) {
    return { ok: false, rows: null, error: 'JSON 解析失败：' + String(error?.message ?? error) };
  }
}

/** 跑 git（只读子命令）。失败返回 null，不抛。 */
export function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout ?? '').trim();
}
