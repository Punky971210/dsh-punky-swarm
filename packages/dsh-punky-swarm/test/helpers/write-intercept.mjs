// test/helpers/write-intercept.mjs —— **写入拦截**（隔离的因果判据；lane p1-intercept）
//
// ── 与 G3 的分工（本模块存在的唯一理由）────────────────────────────────────────
//   G3（`test/home-isolation.test.js` 的「写点归属」）= **事后归属**：解析 apply() 的**日志自报**落点
//     + 断言**隔离根文件数增长**。两个结构性盲区：
//     ① 日志没覆盖的写点 ⇒ 抓不到（写点不在自报清单里就永远不会被看见）；
//     ② `rm` / `unlink` / `rename` 这类**删除型**入口 ⇒ 不增长计数、也不产生「自报落点」⇒ 抓不到。
//   本模块 = **因果拦截**：在**被测代码 import 之前**（preload 时相，见下）包裹变更型 `fs` 入口，
//     按**目标 realpath** 判 `⊆ 隔离根`；越界即记录 violation（可配 throw）。删除型与新增型同一条判据。
//
// ── 为什么必须装在 preload（不能装在测试体内）────────────────────────────────
//   ESM 静态 `import` 的求值**早于**测试模块体：在测试体里包裹只能覆盖「包裹之后」的调用，
//   而被测模块（`lib/**`）在 `import '../lib/index.js'` 时就已求值完毕。
//   故安装点 = `--import ./test/helpers/write-intercept.preload.mjs`（与 isolated-home.preload 串联）。
//
// ── 三条 fail-closed 纪律（禁静默）──────────────────────────────────────────
//   ① 目标解析不出根 ⇒ 记 `unknown-target`，**不放过**（宁可误报）；
//   ② 未声明拦截根 / 未声明报告路径 ⇒ preload 直接非零退出，拒绝以「未拦截」状态继续；
//   ③ **命名导入**是否被包裹（CJS 命名导出可能是快照）⇒ 由 `selfCheck().namedImportCaught`
//      实测作答；调用方**必须**对它断言，否则「包了但没生效」会变成静默假绿。
//
// ── 已知覆盖边界（如实登记，不假装全覆盖）──────────────────────────────────
//   · 只包**同步**入口与 `fs.promises.*`；回调式 `fs.writeFile(path, data, cb)` 未包（本仓 `lib/**` 零使用，
//     见 `npm run check` 之外的 grep：`grep -n "fs.writeFile(" lib` = 0）。
//   · 不经 `fs` 的写路径（`process.stdout`、原生 addon、`child_process` 里子的写）不在拦截面。
//   · 硬链接/符号链接：按**解析后**目标判（`realpath` 逐级解析），不按调用方给的字符串判。

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

/** 变更型同步入口 → **需要判定的目标参数位数组**（多目标 api 取两个：源与落点都要 ⊆ 根）。 */
const MUTATING_SYNC = {
  writeFileSync: [0],
  appendFileSync: [0],
  mkdirSync: [0],
  rmSync: [0],
  rm: [0],
  unlinkSync: [0],
  rmdirSync: [0],
  renameSync: [0, 1],   // oldPath **与** newPath 都要在根内（任一越界即违规：既要防「搬出去」也要防「搬进来」）
  copyFileSync: [0, 1], // src 与 dest 同理
  cpSync: [0, 1],
  symlinkSync: [1],     // 参数 0 是链接指向（可以不存在的远端），落点是 1
  linkSync: [0, 1],
  truncateSync: [0],
  openSync: [0],        // 仅写模式才算变更（见 WRITE_OPEN_FLAGS）
};

/** `fs.openSync` 的**写模式**判据（只读模式不算变更型，否则正常读盘会被误报）。 */
const WRITE_OPEN_FLAGS = /[wa+]/;

/** 变更型 promise 入口 → 需要判定的目标参数位数组。 */
const MUTATING_PROMISES = [
  'writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'rmdir',
  'rename', 'copyFile', 'cp', 'symlink', 'link', 'truncate', 'open',
];
const PROMISE_TARGET_IDX = {
  rename: [0, 1],
  copyFile: [0, 1],
  cp: [0, 1],
  symlink: [1],
  link: [0, 1],
};

const isWin = process.platform === 'win32';

/** 归一化比较键（Windows 大小写不敏感）。 */
function cmpKey(p) {
  const n = path.normalize(path.resolve(p));
  return isWin ? n.toLowerCase() : n;
}

/**
 * 解析「**变更目标**」的 realpath：目标可能**尚不存在**，故逐级向上找到第一个存在的祖先再做 realpath，
 * 再把不存在的尾段按原样接回。这样符号链接/`..`/大小写漂移都会被消解到真实位置。
 */
export function resolveTarget(p) {
  const raw = String(p ?? '');
  if (!raw) return { ok: false, reason: 'empty-path' };
  let abs;
  try { abs = path.resolve(raw); } catch (e) { return { ok: false, reason: 'resolve-failed: ' + String(e && e.message) }; }
  const tail = [];
  let cursor = abs;
  for (let i = 0; i < 64; i += 1) {
    try {
      if (fs.existsSync(cursor)) {
        const real = fs.realpathSync.native ? fs.realpathSync.native(cursor) : fs.realpathSync(cursor);
        return { ok: true, real: path.join(real, ...tail.slice().reverse()) };
      }
    } catch { /* 继续向上 */ }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    tail.push(path.basename(cursor));
    cursor = parent;
  }
  return { ok: false, reason: 'no-existing-ancestor' };
}

/** `target ⊆ root`（按归一化键比较，含等于）。 */
export function isInside(root, target) {
  const r = cmpKey(root);
  const t = cmpKey(target);
  return t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/**
 * 安装拦截。
 *
 * @param {object} opts
 * @param {string} opts.root   隔离根（**必填**；不推导、不给默认值，防「装错根 = 全放行」）
 * @param {string[]} [opts.allow] 额外放行路径（如本模块自己的报告文件）
 * @param {(v:object)=>void} [opts.onViolation] 违规回调（默认只入数组）
 * @param {boolean} [opts.throwOnViolation=false] 违规即抛（子进程构造「必须红」时用）
 * @returns {object} 拦截句柄（含 `violations` / `allowed` / `covered` / `uninstall` / `selfCheck`）
 */
export function installWriteIntercept(opts = {}) {
  const { root, allow = [], onViolation, throwOnViolation = false } = opts;
  if (!root || typeof root !== 'string') {
    throw new Error('write-intercept: root 必填（拒绝以空根安装 ⇒ 否则一切路径都在根内，等于无拦截）');
  }
  const rootReal = resolveTarget(root);
  if (!rootReal.ok) {
    throw new Error('write-intercept: 隔离根解析失败（' + rootReal.reason + '）⇒ 拒绝以未解析根安装');
  }
  const allowKeys = allow.map((p) => { const r = resolveTarget(p); return r.ok ? cmpKey(r.real) : cmpKey(p); });
  const originals = new Map();
  const violations = [];
  const allowed = [];
  const covered = [];

  const record = (api, rawPath, kind) => {
    const resolved = resolveTarget(rawPath);
    const entry = {
      api,
      kind,
      rawPath: String(rawPath),
      resolvedPath: resolved.ok ? resolved.real : null,
      resolveReason: resolved.ok ? null : resolved.reason,
      root: rootReal.real,
      pid: process.pid,
    };
    if (!resolved.ok) {                                // ① 解析不出去 ⇒ 记 unknown-target，不放过
      violations.push({ ...entry, verdict: 'unknown-target' });
      return true;
    }
    const key = cmpKey(resolved.real);
    if (allowKeys.includes(key)) { allowed.push({ ...entry, verdict: 'allowlisted' }); return false; }
    if (isInside(rootReal.real, resolved.real)) { allowed.push({ ...entry, verdict: 'inside-root' }); return false; }
    violations.push({ ...entry, verdict: 'outside-root' });
    return true;
  };

  /** 逐个目标位判定；返回本次调用是否产生了新的违规。 */
  const guard = (api, targetIdxs, kind) => (args) => {
    let hit = false;
    for (const idx of targetIdxs) {
      if (idx >= args.length) continue;
      if (record(api, args[idx], kind)) hit = true;
    }
    if (hit && throwOnViolation) {
      throw new Error('write-intercept: 越界写/删被拦截（' + api + ' → ' + String(args[0]) + '）');
    }
  };

  // ── 同步入口 ──
  for (const [api, targetIdxs] of Object.entries(MUTATING_SYNC)) {
    const original = fs[api];
    if (typeof original !== 'function') continue;
    originals.set('fs.' + api, original);
    fs[api] = function wrapped(...args) {
      const isOpen = api === 'openSync';
      const flags = isOpen ? String(args[1] ?? 'r') : '';
      if (isOpen && !WRITE_OPEN_FLAGS.test(flags)) return original.apply(fs, args);   // 只读 open 不算变更
      guard(api, targetIdxs, isOpen ? 'open-for-write' : 'sync')(args);
      return original.apply(fs, args);
    };
    covered.push('fs.' + api);
  }

  // ── promise 入口 ──
  for (const api of MUTATING_PROMISES) {
    const original = fsPromises[api];
    if (typeof original !== 'function') continue;
    originals.set('fsp.' + api, original);
    const targetIdxs = PROMISE_TARGET_IDX[api] ?? [0];
    fsPromises[api] = function wrapped(...args) {
      const isOpen = api === 'open';
      const flags = isOpen ? String(args[1] ?? 'r') : '';
      if (isOpen && !WRITE_OPEN_FLAGS.test(flags)) return original.apply(fsPromises, args);
      guard(api, targetIdxs, isOpen ? 'open-for-write' : 'async')(args);
      return original.apply(fsPromises, args);
    };
    covered.push('fs.promises.' + api);
  }

  return {
    root: rootReal.real,
    violations,
    allowed,
    covered,
    originals,
    /** 解除拦截（用**原始**函数写报告/收尾，避免自触发）。 */
    uninstall() {
      for (const [key, fn] of originals) {
        if (key.startsWith('fs.')) fs[key.slice(3)] = fn;
        else fsPromises[key.slice(4)] = fn;
      }
    },
    /**
     * 机制自证（三条都要真跑，任何一条假 ⇒ 拦截不可信）。
     * @param {string} [probeOutside] 一个**确定在根外**的路径（缺省由调用方提供；不给则跳过 syncCaught）
     */
    async selfCheck(probeOutside) {
      const result = { patchTook: covered.length > 0, syncCaught: null, namedImportCaught: null, covered: covered.slice() };
      const outRaw = () => { const r = resolveTarget(probeOutside); return r.ok ? r.real : probeOutside; };
      if (probeOutside) {
        const before = violations.length;
        try { fs.writeFileSync(outRaw(), 'x'); } catch { /* 只关心是否被记录 */ }
        result.syncCaught = violations.length > before;
      }
      // 命名导入是否也被包裹：动态 import 取**命名绑定**，再经它调用一次越界写。
      const before2 = violations.length;
      try {
        const named = await import('node:fs');
        const w = named.writeFileSync;
        if (typeof w === 'function') { try { w(probeOutside ?? path.join(rootReal.real, '.selfcheck'), 'y'); } catch { /* 记录为准 */ } }
      } catch { /* import 失败 ⇒ namedImportCaught 保持 null */ }
      result.namedImportCaught = violations.length > before2;
      return result;
    },
  };
}

/**
 * 写拦截报告（**用原始函数**写，避免自触发；`@@REPORT@@…@@END@@` 与仓内既有报告协议同形）。
 * @param {string} reportPath
 * @param {object} handle installWriteIntercept 的返回值
 */
export function writeInterceptReport(reportPath, handle) {
  const payload = {
    pid: process.pid,
    root: handle.root,
    covered: handle.covered,
    violations: handle.violations,
    allowed: handle.allowed,
    counts: { violations: handle.violations.length, allowed: handle.allowed.length },
  };
  const original = (key) => (handle.originals.get('fs.' + key) ?? fs[key]);
  const write = original('writeFileSync');
  try { write(reportPath, '@@REPORT@@' + JSON.stringify(payload) + '@@END@@\n', 'utf8'); } catch { /* 报告失败不影响判定（父进程会读到缺报告 ⇒ 判红） */ }
  return payload;
}
