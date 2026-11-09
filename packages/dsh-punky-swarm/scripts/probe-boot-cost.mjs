#!/usr/bin/env node
/**
 * probe-boot-cost.mjs —— dsh-punky-swarm `apply()` 同步段内「engine root → mailbox sweep」的**分测**探针
 *
 * 背景（判据源 `plan/boot-cost-attribution.md` §证据链 B / §方案 / AC-1）：
 *   宿主 boot 日志里 `engine root`（lib/index.js:1017）→ `mailbox sweep on start`（:232）之间是一段
 *   **24.618s（冷）/ 1.343s（热）的桶**，桶内覆盖 7 个同步步骤：
 *     mkdirSync(:1019) → mountStartupPrelude(:1033 = mountAuditLog + validateCapabilities)
 *     → createEngineStore(:1034) → createRuntimeState(:1038)
 *     → installStartupRecovery(:1040){ migrateLegacy(:168) → syncAssets(:175)
 *        → resumeRecoverBatches(:193-205) → sweepAllMailboxes(:211-227, 调用点 :230) }
 *   桶内只有 `audit log sink mounted` 一条日志路标 ⇒ 现有日志无法把该段归给任何单一子步。
 *   本探针就是把这段在**独立进程**里重放一遍并逐段计时。
 *
 * 口径（禁混用时钟 / 禁估数）：
 *   · 全部读数用 `process.hrtime.bigint()`（单调时钟，纳秒）；**不使用** `Date.now()`，也不读宿主 jsonl 的
 *     `time` / `fields.hostTime` —— 本脚本不产生日志读数，只产生同构代码的本地耗时。
 *   · 冷/热：本脚本**不清任何系统缓存**（用户环境，不得擅动）。冷/热对照由「同一条命令连跑多次」构造：
 *       第 1 次 = `pass1`（本进程首次访问；OS 文件缓存状态 = 宿主实际运行态，**不是**我们清出来的冷态）
 *       第 2 次及以后 = 紧随其后的全新进程（OS 缓存已被上一次跑热）
 *     每次运行都是全新进程（`state.mounted` / `recoveredThisProcess` 等模块级幂等位天然复位），
 *     因此各次之间的差异只可能来自 OS 文件缓存与安全软件实扫，不来自代码路径差异。
 *
 * 同构性（可核）：本文件的每段都**直调 index.js 实际 import 的同一模块**，不是照抄算法：
 *   createStore(:23) / loadRules(:24) / syncAssets(:32) / resumeRecoverBatches(:89) /
 *   validateCapabilities(:43) / mountAuditLog(:94) / mailbox(:79)。
 *   **两处例外**（源头不可 import，已按源码逐字复制并在此标注）：
 *     ① `createRuntimeState`：index.js:810 的模块私有 const（未 export）⇒ 按 :811-819 逐字复制。
 *     ② `sweepAllMailboxes`：index.js:211-227 的闭包（未 export）⇒ 按 :211-227 逐字复制（含 existsSync
 *        + 双层 readdirSync + mailbox.sweep + 四计数聚合）。
 *
 * 副作用（刻意收窄，可核）：
 *   · `mountAuditLog` 走 `PUNKY_AUDITLOG_SINK_DIR` 指向 **%TEMP%** 隔离目录 ⇒ 不碰活宿主
 *     `~/.dsh/logs/punky-swarm/`（原因：该目录下 mount 会跑 pruneByAge/pruneByTotal，且注册 process exit
 *     钩子写 diagnostics；探针不得在活宿主审计面上触发清理/接管）。真实 sink 目录的扫描成本由 `S2c`
 *     以**只读**方式（readdir + stat）复现。
 *   · `syncAssets()` 按 harness 真实调用（无 opts）。`syncDir` 对逐文件 `sameFile` 相同的目标返回
 *     'current' **零写入**；若返回 'synced' 说明真的写了盘，脚本会在 `writes` 字段响亮报出。
 *
 * 用法：
 *   node scripts/probe-boot-cost.mjs --pass=cold
 *   node scripts/probe-boot-cost.mjs --pass=warm --repeat=3 [--root=<path>] [--json=<outfile>]
 */

import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import fs from 'node:fs';

import { createStore } from '../lib/state/store.js';
import { loadRules } from '../lib/state/machine-rules.js';
import { syncAssets } from '../lib/assets.js';
import { recoverBatches as resumeRecoverBatches, resolveResumeConfig } from '../lib/state/resume.js';
import { validateCapabilities } from '../lib/assembly/schema.js';
import { mountAuditLog } from '../lib/auditlog/sink.js';
import * as mailbox from '../lib/comms/mailbox.js';

// ── 参数 ────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const hit = argv.find((a) => a === '--' + name || a.startsWith('--' + name + '='));
  if (!hit) return dflt;
  if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1);
  const i = argv.indexOf(hit);
  return argv[i + 1] ?? dflt;
};
const PASS = String(argOf('pass', 'unknown'));
const ROOT_ARG = argOf('root', null);
const JSON_OUT = argOf('json', null);
// --sweep=inline（缺省）= 复现**改造前**形态：sweep 在 apply 同步段内被计时
// --sweep=deferred   = 复现**改造后**形态：sweep 经 setImmediate 挪出同步段，在首个 tick 后才计时
//   ⇒ 两者是同一份测量代码的两种调度，AC-2 的「apply 同步耗时下降 ≥50%」因此是**实测对实测**，
//     不是「实测 − 算术减项」。
const SWEEP_MODE = String(argOf('sweep', 'inline'));
if (!['inline', 'deferred'].includes(SWEEP_MODE)) {
  process.stderr.write('非法 --sweep 值：' + SWEEP_MODE + '（仅 inline|deferred）\n');
  process.exit(2);
}
// --assets=inline（缺省）= 复现**改造前**形态：S7（syncAssets）在 apply 同步段内被计时
// --assets=deferred   = 复现**改造后**形态：S7 经 setImmediate 挪出同步段，在首个 tick 后才计时
//   ⇒ 与 --sweep 同形：同一份测量代码的两种调度，AC-2 的判据因此是**实测对实测**。
//   ⚠ deferred 形态下 `S7` 的 `ms` 与 `writes` 读数**照样存在**（在首个 tick 内测得）——
//     这是「挪走了」而不是「测没了」的证据（AC-2 第二条）。
const ASSETS_MODE = String(argOf('assets', 'inline'));
if (!['inline', 'deferred'].includes(ASSETS_MODE)) {
  process.stderr.write('非法 --assets 值：' + ASSETS_MODE + '（仅 inline|deferred）\n');
  process.exit(2);
}

// ── 计时原语：唯一时钟 = process.hrtime.bigint() ─────────────────────────────────
const t = () => process.hrtime.bigint();
const msOf = (a, b) => Number(b - a) / 1e6;

/** 段登记表：每段 = { id, label, src, ms, note } —— src 指回 index.js 的真实行号 */
const segments = [];
const record = (id, label, src, ms, note) => {
  const rec = { id, label, src, ms: Number(ms.toFixed(3)), note: note ?? null };
  segments.push(rec);
  return rec;   // ← 返回登记项：deferred 形态要在首个 tick 后**就地回填** ms/note
};
/** 包一段同步调用：返回 { value, ms } */
const timed = (fn) => {
  const a = t();
  const value = fn();
  const b = t();
  return { value, ms: msOf(a, b) };
};

// ── 配置：与宿主实装一致（profile cordis.patch.yml 无 dsh-punky-swarm config 行 ⇒ apply 的 config 缺省 {}）──
const config = {};

// 假 ctx：mountAuditLog 的身份判定是「不用 instanceof，要求 logger.exporter 是函数」（sink.js:139）。
const fakeCtx = () => {
  const info = [];
  const warn = [];
  const logger = {
    info: (line) => info.push(String(line)),
    warn: (line) => warn.push(String(line)),
    exporter: () => () => {},   // 注册即返回 disposer；探针不让 logger 发记录 ⇒ 零写入
  };
  return { ctx: { logger, root: { logger } }, info, warn };
};

const main = async () => {
  const startedAt = new Date().toISOString();

  // ═══ S0：root 解析（index.js:1015-1016）—— 单列，不进桶和 ═══
  const s0 = timed(() => {
    const rawRoot = config.root ?? '~/.dsh/punky-preset';
    return rawRoot.startsWith('~') ? join(homedir(), rawRoot.slice(1)) : rawRoot;
  });
  const root = ROOT_ARG ? ROOT_ARG : s0.value;
  record('S0', 'root 解析（homedir/join）', 'index.js:1015-1016', s0.ms, '桶外；仅为可复跑显式化');

  // ═══ S1：mkdirSync(root) —— index.js:1019 ═══
  const s1 = timed(() => fs.mkdirSync(root, { recursive: true }));
  record('S1', 'mkdirSync(root)', 'index.js:1019', s1.ms);

  // ═══ S2a：mountAuditLog —— index.js:1033 → mountStartupPrelude(:135) ═══
  //   sink 目录指向 %TEMP% 隔离面（见文件头「副作用」）；代价点相同：解析配置 + mkdir +
  //   takeoverExistingSegment(逐段 stat) + pruneByAge(readdir/stat) + pruneByTotal(scanSinkDir 全量 readdir/stat)。
  const tmpSink = join(tmpdir(), 'punky-probe-boot-cost', String(process.pid) + '-' + PASS);
  fs.mkdirSync(tmpSink, { recursive: true });
  const probeEnv = { ...process.env, PUNKY_AUDITLOG_SINK_DIR: tmpSink };
  const { ctx, info, warn } = fakeCtx();
  const s2a = timed(() => mountAuditLog(ctx, { root, config, env: probeEnv }));
  const mountRes = s2a.value;
  record('S2a', 'mountAuditLog（mountStartupPrelude 前半）', 'index.js:1033→:128-141', s2a.ms,
    'sink→%TEMP% 隔离；mounted=' + String(mountRes?.mounted) + ' reason=' + String(mountRes?.reason ?? '-'));

  // ═══ S2b：validateCapabilities —— index.js:1033 → :145 ═══
  const s2b = timed(() => validateCapabilities(config));
  record('S2b', 'validateCapabilities（mountStartupPrelude 后半）', 'index.js:1033→:145', s2b.ms,
    'errors=' + String(s2b.value?.errors?.length ?? 0));

  // ═══ S2c：活宿主审计目录扫描的只读复现（补 S2a 因隔离而省掉的真实 sink 读）═══
  //   只读：readdirSync + statSync，不 mount、不 prune、不写。
  const liveSink = join(homedir(), '.dsh', 'logs', 'punky-swarm');
  const s2c = timed(() => {
    if (!fs.existsSync(liveSink)) return { files: 0, bytes: 0 };
    const names = fs.readdirSync(liveSink);
    let bytes = 0;
    for (const n of names) {
      try { const st = fs.statSync(join(liveSink, n)); if (st.isFile()) bytes += st.size; } catch { /* 单项失败不阻断读数 */ }
    }
    return { files: names.length, bytes };
  });
  record('S2c', '真实 sink 目录扫描（只读复现 S2a 省掉的真实读）', 'sink.js:165-185 的读形状', s2c.ms,
    'files=' + s2c.value.files + ' bytes=' + s2c.value.bytes);

  // ═══ S4：createEngineStore —— index.js:1034 → :152-162 ═══
  //   注意 loadRules(config) 在真实代码里**发生在 createEngineStore 内部**（:156）⇒ 必须计入本段。
  const s4 = timed(() => {
    const topicSink = { emit: null };
    const store = createStore(root, {
      rules: loadRules(config),
      onStateChange: (ev) => { try { topicSink.emit?.(ev); } catch { /* 隔离：同 :159 */ } },
    });
    return { store, topicSink };
  });
  const store = s4.value.store;
  record('S4', 'createEngineStore（= createStore + loadRules）', 'index.js:1034→:152-162', s4.ms);

  // ═══ S5：createRuntimeState —— index.js:1038 ═══
  //   源：index.js:810-820 的模块私有 const（未 export）⇒ 逐字复制（基对象 21 字段；无 sink ⇒ 纯对象）
  const s5 = timed(() => ({
    hotConfig: null, watchTimer: null, sweepTimer: null, heartbeat: null, heartbeatRef: null,
    watchInstalledCfg: null, apiDispose: null, trajectory: null, topicRuntime: null, topicAttachUn: null,
    panelStream: null, verifyMount: null, governanceHook: null, governanceInstalledCfg: null,
    dispatchReg: null, autoSettle: null, autoSettleEnabled: null, laneWake: null, acpsEndpoint: null,
    lastRatchetJson: null,
  }));
  record('S5', 'createRuntimeState（纯对象，无 sink）', 'index.js:1038→:810-820', s5.ms,
    '源头未 export，按源码逐字复制');

  // ═══ S6：migrateLegacy —— index.js:1040 → installStartupRecovery :168 ═══
  const s6 = timed(() => store.migrateLegacy());
  record('S6', 'migrateLegacy（root/batches/*.json → sessions/legacy）', 'index.js:1040→:166-172', s6.ms,
    'moved=' + String(s6.value ?? 0));

  // ═══ S7：syncAssets —— index.js:1040 → :173-185 ═══
  // 【AC-2 双形态】同一份测量代码的两种调度（`--assets=inline|deferred`）：
  //   inline   = 改造前（syncAssets 落在 apply 同步段内，被计时）
  //   deferred = 改造后（syncAssets 经 setImmediate 挪到首个 tick，同步段不计时；读数照样在 tick 内测得）
  const assetNote = (v) => {
    const w = (v?.results ?? []).filter((r) => r.status === 'synced');
    return 'manifest=' + String(v?.manifest) + ' synced=' + w.length
      + (w.length ? ' ⚠写盘=' + w.map((r) => r.asset).join(',') : '（全部 current ⇒ 零写盘）');
  };
  let assetMs = null;
  let assetValue = null;
  let assetErr = null;
  let s7record;
  if (ASSETS_MODE === 'inline') {
    const s7 = timed(() => syncAssets());
    assetMs = s7.ms; assetValue = s7.value;
    s7record = record('S7', 'syncAssets（预设/技能目录幂等同步 · inline = 改造前形态）', 'index.js:1040→:173-185', s7.ms, assetNote(s7.value));
  } else {
    s7record = record('S7', 'syncAssets（首个 tick 内 · deferred = 改造后形态）', 'index.js:1040→:173-185（改造后）', 0,
      'deferred：ms/writes 于首个 tick 内测得（下方回填）');
    setImmediate(() => {
      const a = t();
      try { assetValue = syncAssets(); } catch (e) { assetErr = String(e?.message ?? e); } finally { assetMs = msOf(a, t()); }
    });
  }

  // ═══ S8：resumeRecoverBatches —— index.js:1040 → :193-205 ═══
  const s8 = timed(() => {
    const resumeCfg = resolveResumeConfig(config);
    return resumeRecoverBatches(store, { restoreRunning: resumeCfg.enabled });
  });
  record('S8', 'resumeRecoverBatches（= resume.recoverBatches）', 'index.js:1040→:193-205', s8.ms,
    'recovered=' + (Array.isArray(s8.value) ? s8.value.length : 0)
    + ' corrupt=' + (Array.isArray(s8.value?.corrupt) ? s8.value.corrupt.length : 0));

  // ═══ S9：sweepAllMailboxes —— index.js:211-227 定义 / :230 调用 ═══
  //   按 :211-227 逐字复制（闭包未 export）。调用两次：S9a = boot 的那一次；S9b = AC-4 幂等/可重入读数。
  const sweepAllMailboxes = () => {
    const agg = { scanned: 0, removed: 0, quarantined: 0, failed: 0 };
    const mbBase = join(root, 'sessions');
    if (fs.existsSync(mbBase)) {
      for (const sid of fs.readdirSync(mbBase)) {
        const mbRoot = join(mbBase, sid, 'mailbox');
        if (!fs.existsSync(mbRoot)) continue;
        for (const bid of fs.readdirSync(mbRoot)) {
          try {
            const r = mailbox.sweep(join(mbRoot, bid));
            agg.scanned += r.scanned; agg.removed += r.removed; agg.quarantined += r.quarantined; agg.failed += r.failed;
          } catch { agg.failed++; }
        }
      }
    }
    return agg;
  };
  // 【AC-2 双形态】同一份测量代码的两种调度：
  //   inline   = 改造前（sweep 落在 apply 同步段内，被计时）
  //   deferred = 改造后（sweep 经 setImmediate 挪到首个 tick，同步段不计时）
  let sweepMs;
  let sweepValue;
  if (SWEEP_MODE === 'inline') {
    const s9a = timed(sweepAllMailboxes);
    sweepMs = s9a.ms; sweepValue = s9a.value;
    record('S9a', 'sweepAllMailboxes（boot 那一次 · inline = 改造前形态）',
      'index.js:211-227 / 调用点 :230', s9a.ms, JSON.stringify(s9a.value));
  } else {
    let deferredMs = null;
    let deferredValue = null;
    setImmediate(() => {
      const a = t();
      try { deferredValue = sweepAllMailboxes(); } finally { deferredMs = msOf(a, t()); }
    });
    // 同步段到此结束（= apply 返回）。等首个 tick，让上面的 setImmediate 跑完。
    await new Promise((r) => setImmediate(r));
    sweepMs = Number((deferredMs ?? 0).toFixed(3));
    sweepValue = deferredValue ?? { scanned: null, removed: null, quarantined: null, failed: null, note: 'deferred 回调未在本窗口内完成' };
    record('S9a', 'sweepAllMailboxes（首个 tick 内 · deferred = 改造后形态）',
      'index.js:211-227 / 调用点 :230（改造后）', sweepMs, JSON.stringify(sweepValue));
  }
  // 第 2 次：AC-4 幂等/可重入读数（sweep 无状态，第二次应 removed/quarantined=0）
  const s9b = timed(sweepAllMailboxes);
  record('S9b', 'sweepAllMailboxes（第 2 次，AC-4 幂等读数）', 'index.js:211-227', s9b.ms, JSON.stringify(s9b.value));

  // ── deferred 资产同步读数回填（首个 tick 之后；AC-2 要求 deferred 下 S7 的 ms 与 writes 仍存在）──
  if (ASSETS_MODE === 'deferred') {
    // sweep 形态若也是 deferred，其分支内已等过一个 tick；这里再等一个，确保上面登记的
    // syncAssets 回调**必然**已执行（两个 immediate 的登记序：S7 先于 S9a）。
    await new Promise((r) => setImmediate(r));
    s7record.ms = Number((assetMs ?? 0).toFixed(3));
    s7record.note = (assetErr ? '⚠syncAssets 抛错: ' + assetErr + '；' : '')
      + assetNote(assetValue) + (assetMs === null ? ' ⚠deferred 回调未在本窗口完成' : '（deferred：首个 tick 内测得）');
  }
  const writes = (assetValue?.results ?? []).filter((r) => r.status === 'synced');

  // ── 汇总 ────────────────────────────────────────────────────────────────────
  // apply 同步段 = apply() 返回前执行的那些段。
  //   assets inline   ⇒ 含 S7（改造前）；deferred ⇒ 不含 S7（改造后）
  //   sweep  inline   ⇒ 含 S9a（改造前）；deferred ⇒ 不含 S9a（改造后）
  // 日志区间 `engine root` → `mailbox sweep on start` 的**总工作量**在两种形态下都 = 同步段 + 被挪出的段
  //   （deferred 下两条日志分别在 apply 内与首个 tick ⇒ 改造后该区间在日志上**跨 tick**，这一点写进 notice）。
  const applySyncIds = ['S1', 'S2a', 'S2b', 'S2c', 'S4', 'S5', 'S6'];
  if (ASSETS_MODE === 'inline') applySyncIds.push('S7');
  applySyncIds.push('S8');
  if (SWEEP_MODE === 'inline') applySyncIds.push('S9a');
  const applySyncMs = segments.filter((s) => applySyncIds.includes(s.id)).reduce((a, s) => a + s.ms, 0);
  // 总工作量 = 同步段 + 被挪出同步段的那些段（各计一次，绝不重复计数）。
  const deferredMs = (ASSETS_MODE === 'deferred' ? Number(assetMs ?? 0) : 0)
    + (SWEEP_MODE === 'deferred' ? sweepMs : 0);
  const bucketMs = applySyncMs + deferredMs;

  const out = {
    tool: 'probe-boot-cost.mjs',
    clock: 'process.hrtime.bigint()（单调纳秒；未使用 Date.now()，不带日志 time/hostTime 口径）',
    pass: PASS,
    startedAt,
    pid: process.pid,
    node: process.version,
    root,
    config: '{}（宿主 profile cordis.patch.yml 无 dsh-punky-swarm config 行 ⇒ apply 缺省 {}）',
    coldWarmNote: '本进程首次访问；OS 文件缓存未被人为清空 ⇒ cold 仅是「宿主当下缓存态下的首访」',
    totals: {
      assetsMode: ASSETS_MODE,
      sweepMode: SWEEP_MODE,
      applySyncMs: Number(applySyncMs.toFixed(3)),
      applySyncIds,
      bucketMs: Number(bucketMs.toFixed(3)),
      bucketNote: '总工作量 = apply 同步段 + 被挪出同步段的段（deferred 下 logs 区间跨首个 tick）',
      assetSyncMs: assetMs === null ? null : Number(Number(assetMs).toFixed(3)),
      assetWrites: writes.map((r) => r.asset),
      sweepMs,
      sweepShareOfBucketPct: bucketMs > 0 ? Number((sweepMs / bucketMs * 100).toFixed(2)) : null,
      assetShareOfBucketPct: bucketMs > 0 && assetMs !== null ? Number((Number(assetMs) / bucketMs * 100).toFixed(2)) : null,
    },
    ac4: {
      first: sweepValue,
      second: s9b.value,
      idempotent: Number(s9b.value.removed) === 0 && Number(s9b.value.quarantined) === 0 && Number(s9b.value.failed) === 0,
    },
    writes: writes.map((r) => r.asset),
    engineInfo: info,
    engineWarn: warn,
    segments,
  };

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2), 'utf8');
  }
  process.stdout.write(JSON.stringify(out) + '\n');
};

main().then(
  () => process.exit(0),
  (e) => { process.stderr.write('PROBE FAILED: ' + (e?.stack ?? e) + '\n'); process.exit(1); },
);
