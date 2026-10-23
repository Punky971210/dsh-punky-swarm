#!/usr/bin/env node
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

// 宿主级生效冒烟回路（`npm run smoke:host`）· D-1 的**一条命令 + 明确退出码**操作面。
//
// 为什么不复用 `test/g10-host-smoke.test.js`：那是**测试**——① 只能随全量套件跑；② 跑在测试进程里的
//   模块实例；③ 不产出「本次结论归属哪个 HEAD / 工作树是否干净」的凭据。本脚本把同一条装载路径
//   （`apply(ctx, config)`）搬到一条**可单独执行、退出码有语义、产出 stamp 凭据**的回路里。
//
// ⚠ 本脚本**不 import `test/**`**：`package.json.files` 不含 `test/`（已核），装了包的环境里
//   `scripts/` 随包发出而 `test/` 不在 ⇒ 引用测试 helper 会在发布形态下断链。隔离 preload 与 ctx 夹具
//   因此在 `scripts/smoke/` 内**按同一契约自建**（差异由 audit 抽查，不是复制粘贴的巧合）。
//
// 退出码（D-1.4，与仓内 `check-guidance-sync.mjs` / `pkg-hashes.mjs` / `test-evidence-guard.mjs` 的 `2` 同约定）：
//   0 = 全部 PASS、skip=0、certify 前置成立（干净树）——唯一可写「已生效」的读数
//   1 = 任一 FAIL（门禁红）
//   2 = 用法错误 / 隔离前置失败（隔离根不可建、与真实 home 同路径、隔离根未按契约清理）
//   3 = 无 FAIL，但有 SKIP **或** certify 前置不成立（脏树 / --allow-stale-build 生效）——「不算绿」的显式档
//
// 用法：
//   node scripts/smoke/host-smoke.mjs [--json] [--stamp <path>] [--keep] [--allow-stale-build] [--no-live]
//
//   --json                以 JSON（= stamp 同构）打印结论，不打人类可读表
//   --stamp <path>        另存一份 stamp 到指定路径（缺省只写 <隔离根>/stamp.json）
//   --keep                保留隔离根并打印路径（此时 ③ 守卫面仍须成立，② 清理降级为 SKIP 并单列）
//   --allow-stale-build   H-12「改 .ts 未 build」降级为 SKIP（**不算 pass**）
//   --no-live             H-13 / H-14 进 SKIP（隔离进程内真实 home / 活体进程不可判）

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createLedger, expect, findDeadPid, findRunTagInProductionSinks, git, guardFingerprint, makeAssemblyCtx,
  productionSnapshot, sha256File, toolIndex,
} from './lib/support.mjs';
import { buildK } from './lib/checks-k.mjs';
import { buildS } from './lib/checks-s.mjs';
import { buildX } from './lib/checks-x.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const PRELOAD = path.join(HERE, 'isolate.preload.mjs');
const ISOLATED = process.env.PUNKY_SMOKE_ISOLATED === '1';

const USAGE = [
  '用法：node scripts/smoke/host-smoke.mjs [--json] [--stamp <path>] [--keep] [--allow-stale-build] [--no-live]',
  '',
  '  --json                以 JSON（= stamp 同构）打印结论',
  '  --stamp <path>        另存一份 stamp 到指定路径',
  '  --keep                保留隔离根并打印路径',
  '  --allow-stale-build   H-12 构建新鲜度违规降级为 SKIP（不算 pass）',
  '  --no-live             H-13 / H-14 进 SKIP',
  '',
  '退出码：0 全过（脏树不阻断，只记 stamp）/ 1 有 FAIL / 2 用法或隔离前置失败 / 3 有 SKIP（或用 --strict-dirty 且树脏）',
].join('\n');

// ── 参数 ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { json: false, keep: false, allowStaleBuild: false, noLive: false, stamp: null, help: false, error: null, passthrough: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--keep') out.keep = true;
    else if (arg === '--allow-stale-build') out.allowStaleBuild = true;
    else if (arg === '--no-live') out.noLive = true;
    else if (arg === '--stamp') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) { out.error = '--stamp 需要一个 path 参数'; break; }
      out.stamp = path.resolve(value);
      out.passthrough.push(arg, out.stamp); // 归一化为绝对路径后再下传（子进程 cwd 可能不同）
      i += 1;
      continue;
    } else if (arg === '--help' || arg === '-h') out.help = true;
    else if (!out.error) out.error = '未知参数：' + arg;
    out.passthrough.push(arg);
  }
  return out;
}

// ── 退出码裁决（纯函数 —— M-01 元层自检直接对它做逐档对照）─────────────────────

/**
 * 退出码单点。**纯函数**（无 I/O、无环境读）：`0` 档的可达性因此可以被机检证明，
 * 而不必先制造一个「干净树」的现场。
 * @param {{fails?: number, skips?: number, dirty?: boolean, usage?: boolean}} state
 * @returns {0|1|2|3}
 */
export function decideExit(state = {}) {
  const fails = Number(state.fails ?? 0);
  const skips = Number(state.skips ?? 0);
  if (state.usage) return 2;
  if (fails > 0) return 1;                       // FAIL 优先于一切（含脏树 / SKIP）
  if (skips > 0) return 3;                       // SKIP 恰恰是「判据不可达却被读成通过」的那种状态
  // 2026-10-23 Leader 裁决（Q-C1）：`dirty` **不参与**退出码。
  //   理由：冒烟的全部价值是「改完立刻能跑」，而改完必然脏树 ⇒ 旧语义（dirty ⇒ 3）让 `0` 在真实工作流里
  //   结构性不可达 = 永远拿不到绿灯。脏树改为**只记 stamp + 一行提示**，不再阻断 certify；
  //   需要严格档时由调用方显式传 `strictDirty: true`。
  if (state.dirty === true && state.strictDirty === true) return 3;
  return 0;
}

/** M-01：退出码四档逐条对照（**元层自检**，不属 D-1 的 14 项；它证明 `0` 档可达、`1` 优先于 `3`）。 */
function metaExitCheck() {
  const cases = [
    { label: '全绿干净树', state: { fails: 0, skips: 0, dirty: false }, want: 0 },
    { label: '任一 FAIL', state: { fails: 1, skips: 0, dirty: false }, want: 1 },
    { label: 'FAIL 优先于脏树+SKIP', state: { fails: 2, skips: 1, dirty: true }, want: 1 },
    { label: '有 SKIP', state: { fails: 0, skips: 1, dirty: false }, want: 3 },
    // 2026-10-23 Leader 裁决（Q-C1）：脏树不再阻断绿灯（只记 stamp）；严格档由 strictDirty 显式开启。
    { label: '全 PASS + 脏树（新语义：仍绿）', state: { fails: 0, skips: 0, dirty: true }, want: 0 },
    { label: '全 PASS + 脏树 + strictDirty（严格档）', state: { fails: 0, skips: 0, dirty: true, strictDirty: true }, want: 3 },
    { label: '用法错', state: { usage: true, fails: 0, skips: 0, dirty: false }, want: 2 },
  ];
  const bad = cases.filter((c) => decideExit(c.state) !== c.want);
  expect(bad.length === 0, '退出码裁决自检失败：' + bad.map((c) => c.label + ' ⇒ ' + decideExit(c.state) + '（期望 ' + c.want + '）').join('; '));
  return cases.map((c) => c.label + '⇒' + c.want).join(' · ');
}

// ── 父进程：创建隔离根并自重启进隔离 ─────────────────────────────────────────

function runOrchestrator() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(USAGE + '\n'); process.exitCode = 0; return; }
  if (args.error) { process.stderr.write('[host-smoke] ' + args.error + '\n\n' + USAGE + '\n'); process.exitCode = 2; return; }

  const isoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-host-smoke-'));
  const env = {
    ...process.env,
    PUNKY_SMOKE_ISOLATED: '1',
    PUNKY_SMOKE_ISOLATED_HOME: isoRoot,
    PUNKY_SMOKE_ALLOW_ANY_ROOT: '1', // 父进程已确认落点（mkdtemp 在 os.tmpdir()），避免子进程重复判据误伤
  };
  if (args.keep) env.PUNKY_SMOKE_KEEP_ISOLATED_HOME = '1';

  const childArgs = ['--import', pathToFileURL(PRELOAD).href, fileURLToPath(import.meta.url), ...args.passthrough];
  const child = spawnSync(process.execPath, childArgs, { stdio: 'inherit', env, windowsHide: true });
  if (child.error) {
    process.stderr.write('[host-smoke] 无法启动隔离子进程：' + String(child.error.message ?? child.error) + '\n');
    process.exitCode = 2;
    return;
  }
  const code = typeof child.status === 'number' ? child.status : 1;

  const residual = fs.existsSync(isoRoot);
  if (residual && !args.keep) {
    for (let i = 0; i < 5; i += 1) { try { fs.rmSync(isoRoot, { recursive: true, force: true }); } catch { /* 重试 */ } if (!fs.existsSync(isoRoot)) break; sleepSync(50); }
  }
  if (!args.keep && fs.existsSync(isoRoot)) {
    process.stderr.write('[host-smoke] 隔离根未按契约自清理：' + isoRoot + ' ⇒ 隔离前置失败（退出码 2）\n');
    process.exitCode = 2;
    return;
  }
  if (args.keep) process.stderr.write('[host-smoke] --keep：隔离根保留在 ' + isoRoot + '\n');
  process.exitCode = code;
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 退化：不睡 */ }
}

// ── 子进程（已隔离）：跑完 14 项 + 元层自检 + 隔离后置自检 ─────────────────────

async function runMain() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(USAGE + '\n'); process.exitCode = 0; return; }
  if (args.error) { process.stderr.write('[host-smoke] ' + args.error + '\n\n' + USAGE + '\n'); process.exitCode = 2; return; }

  const isoRoot = process.env.PUNKY_SMOKE_ISOLATED_HOME;
  if (!isoRoot || !path.isAbsolute(isoRoot)) {
    process.stderr.write('[host-smoke] 未隔离或隔离根非法（PUNKY_SMOKE_ISOLATED_HOME=' + String(isoRoot) + '）⇒ 退出码 2\n');
    process.exitCode = 2;
    return;
  }
  const engineRoot = path.join(isoRoot, 'engine');
  const ledger = createLedger(isoRoot);
  ledger.mkdirp(engineRoot);

  // ── 必须在**任何 lib/** 装载之前**取的真实面基线 ──
  const beforeGuard = guardFingerprint();
  const productionBefore = productionSnapshot();

  // 审计 sink 落点显式钉在隔离根内（`PUNKY_AUDITLOG_SINK_DIR` 优先级最高）：
  //   否则 sink 会按 `DSH_HOME` 派生 —— 那也在隔离根内，但显式钉死让「生产日志零污染」这件事
  //   不依赖 DSH_HOME 的解析细节。
  process.env.PUNKY_AUDITLOG_AGGREGATE = 'off';        // 关聚合 ⇒ 单次 export 即落盘，写盘面可数
  process.env.PUNKY_AUDITLOG_SINK_DIR = path.join(isoRoot, 'audit-sink');

  const runTag = 'smoke-' + Date.now().toString(36) + '-' + process.pid;
  const session = runTag;

  // ── 部署面入口（D-1.1-2：加载的是**部署面**，不是仓内路径）──
  const realHome = productionBefore.realHome;
  const deployPkgDir = path.join(realHome, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-punky-swarm');
  const deployEntry = path.join(deployPkgDir, 'lib', 'index.js');
  const repoEntry = path.join(REPO_ROOT, 'lib', 'index.js');
  const entryPath = fs.existsSync(deployEntry) ? deployEntry : repoEntry;
  const entryBase = path.dirname(entryPath);

  const head = git(['rev-parse', 'HEAD'], REPO_ROOT);
  const dirtyAtStart = (git(['status', '--porcelain'], REPO_ROOT) ?? '').trim().length > 0;

  let mod;
  try {
    mod = await import(pathToFileURL(entryPath).href);
  } catch (error) {
    process.stderr.write('[host-smoke] 插件入口不可加载（' + entryPath + '）：' + String(error?.stack ?? error) + '\n');
    process.exitCode = 1;
    return;
  }
  const { createStore } = await import(pathToFileURL(path.join(entryBase, 'state', 'store.js')).href);
  const sink = await import(pathToFileURL(path.join(entryBase, 'auditlog', 'sink.js')).href);
  const dispatch = await import(pathToFileURL(path.join(entryBase, 'engine', 'dispatch.js')).href);
  const tierGate = await import(pathToFileURL(path.join(entryBase, 'tools', 'tier-gate.js')).href);

  const store = createStore(engineRoot);

  /** G1 种子：把会话治理状态写成「已评估为 C 档」（形状与 `assign_check({difficulty:'C'})` 落盘形态一致）。 */
  const seedTierC = (sid) => {
    const prev = store.readGovernance(sid) ?? {};
    const at = new Date().toISOString();
    const rationale = 'host-smoke：声明 C 档以让 wave_plan / lane_claim / lane_dispatch 面可达（冒烟前置，不构成真实评估）';
    const entry = { turn: (prev.history?.length ?? 0) + 1, difficulty: 'C', form: 'C', derived: 'C', derivedChannel: 'dispatch', override: false, overrideKind: null, at, reasons: ['smoke 前置'], rationale };
    store.writeGovernance(sid, {
      lastAssign: { difficulty: 'C', form: 'C', scope: 'full', rationale, derived: 'C', derivedChannel: 'dispatch', override: false, overrideKind: null, at, reasons: entry.reasons, execCallsSince: 0 },
      history: [...(prev.history ?? []), entry],
    });
  };
  seedTierC(session);

  const batchFileOf = (batchId) => {
    try { return store.batchFile(session, batchId); } catch { return path.join(engineRoot, 'sessions', session, 'batches', batchId + '.json'); }
  };

  const sm = {
    repoRoot: REPO_ROOT, isoRoot, engineRoot, session, runTag, ledger,
    realHome, deployEntry, repoEntry, entryPath, mod, store, sink,
    dispatchProbe: dispatch.subagentRuntimeProbeOf,
    noLive: args.noLive, allowStaleBuild: args.allowStaleBuild, guardDeep: true,
    beforeGuard, productionBefore,
    deadPid: findDeadPid(),
    h05BatchId: 'smoke-h05-ok',
    h07BatchId: 'smoke-h07',
    batchOf: (batchId) => store.readBatch(session, batchId),
    batchExists: (batchId) => fs.existsSync(batchFileOf(batchId)),
    artifactsDirOf: (batchId) => store.artifactsDirOf(session, batchId),
    seedTierC,
    /** 真实装载插件（与宿主同一入口）并回收工具面。 */
    mount(config = {}, { subagents } = {}) {
      const ctx = makeAssemblyCtx();
      if (subagents) ctx.subagents = subagents;
      const disposer = mod.apply(ctx, { root: engineRoot, ...config });
      return { ctx, disposer, registered: ctx.registered, tools: toolIndex(ctx.registered) };
    },
    /** 生产面后置快照（H-04 用；惰性 + 缓存）。 */
    productionAfter: (() => { let cached = null; return () => (cached ??= productionSnapshot()); })(),
    /** 生产 sink 里的 runTag 命中（H-04 用；惰性 + 缓存）。 */
    get prodHits() {
      if (!this._prodHits) this._prodHits = findRunTagInProductionSinks(productionBefore.sinkDir, runTag);
      return this._prodHits;
    },
  };
  // `lockPath(root, sessionId, batchId, lane)` —— 单点引用（不在此手拼路径）
  sm.lockPathOf = (batchId, lane) => tierGate.lockPath(engineRoot, session, batchId, lane);

  // ── 跑 14 项（M-01 元层自检先跑：它证明退出码四档都可达）──
  const results = [];
  const record = async (id, title, run, group) => {
    const started = Date.now();
    try {
      const detail = await run();
      results.push({ id, group, title, status: 'PASS', detail: String(detail ?? ''), ms: Date.now() - started });
    } catch (error) {
      const isSkip = error?.__skip === true;
      results.push({
        id, group, title,
        status: isSkip ? 'SKIP' : 'FAIL',
        detail: String(error?.message ?? error),
        ms: Date.now() - started,
      });
    }
  };

  await record('M-01', '退出码裁决四档自检（元层，不属 14 项；证明 0 档可达 + 1 优先于 3）', metaExitCheck, 'M');
  for (const item of [...buildK(sm), ...buildS(sm), ...buildX(sm)]) await record(item.id, item.title, item.run, item.id.slice(0, 1));

  const checks = results.filter((r) => r.group !== 'M');
  const meta = results.filter((r) => r.group === 'M');
  const fails = results.filter((r) => r.status === 'FAIL');
  const skips = results.filter((r) => r.status === 'SKIP');

  // ── 隔离后置自检：清理 + 结构性确认（F4：任一不成立 ⇒ 2）──
  let isolation = { root: isoRoot, kept: args.keep, removed: false, residual: 0 };
  if (!args.keep) {
    for (let i = 0; i < 5; i += 1) {
      try { fs.rmSync(isoRoot, { recursive: true, force: true }); } catch { /* 重试 */ }
      if (!fs.existsSync(isoRoot)) break;
      sleepSync(50);
    }
    isolation.removed = !fs.existsSync(isoRoot);
    isolation.residual = isolation.removed ? 0 : 1;
  }

  const exitCode = decideExit({ fails: fails.length, skips: skips.length, dirty: dirtyAtStart });
  const effective = isolation.removed || args.keep ? exitCode : 2;

  const stamp = {
    tool: 'host-smoke', stampVersion: 1, ts: new Date().toISOString(), runTag, session,
    node: process.version, platform: process.platform,
    repoRoot: REPO_ROOT, head: head ?? '(git 不可用)', dirty: dirtyAtStart,
    entryPath, entrySha256: fs.existsSync(entryPath) ? sha256File(entryPath) : null,
    deployEntryPresent: fs.existsSync(deployEntry),
    isolation: {
      root: isoRoot, engineRoot, kept: args.keep, removed: isolation.removed,
      vars: ['DSH_HOME', 'USERPROFILE', 'HOME'],
      dshHome: process.env.DSH_HOME ?? null, userProfile: process.env.USERPROFILE ?? null, home: process.env.HOME ?? null,
      realHome, guardShaBefore: beforeGuard.sha, guardShaAfter: (results.find((r) => r.id === 'H-04')?.status === 'PASS' ? beforeGuard.sha : null),
    },
    counts: { total: checks.length, pass: checks.filter((r) => r.status === 'PASS').length, skip: skips.length, fail: fails.length, meta: meta.length },
    checks: results.map(({ id, group, title, status, detail, ms }) => ({ id, group, title, status, detail, ms })),
    skip: skips.map((r) => ({ id: r.id, reason: r.detail })),
    fail: fails.map((r) => ({ id: r.id, reason: r.detail })),
    exitCode: effective,
    boundary: 'H-14「改完忘了重启」判据 = 活体进程启动时间 vs 部署面最新 mtime ⇒ **时间序推断，不是内容比对**；'
      + '不证明进程内已加载模块内容 ≡ 盘上内容（升级需 lib/api.js 增 moduleDigest 端点，不在 D-1 写域）。',
    certify: {
      note: 'exit 0 = 唯一可写「已生效」的读数；dirty=true 时 certify 前置不成立 ⇒ 3（半撰写工作树不能归属任何 HEAD）',
      dirty: dirtyAtStart,
    },
  };

  // stamp 落盘：<隔离根>/stamp.json（随隔离根清理）+ 可选的 --stamp 外部路径
  if (!isolation.removed || args.keep) {
    try { ledger.writeFile(path.join(isoRoot, 'stamp.json'), JSON.stringify(stamp, null, 2) + '\n'); } catch { /* 已清理 */ }
  }
  if (args.stamp) {
    fs.mkdirSync(path.dirname(args.stamp), { recursive: true });
    fs.writeFileSync(args.stamp, JSON.stringify(stamp, null, 2) + '\n', 'utf8');
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(stamp, null, 2) + '\n');
  } else {
    process.stdout.write(renderReport(stamp, results, isolation) + '\n');
  }
  if (!isolation.removed && !args.keep) {
    process.stderr.write('[host-smoke] 隔离根清理失败（' + isoRoot + '）⇒ 隔离前置失败（退出码 2）\n');
  }
  process.exitCode = effective;
}

function renderReport(stamp, results, isolation) {
  const lines = [];
  lines.push('══ 宿主级生效冒烟 · host-smoke ══');
  lines.push('HEAD ' + String(stamp.head).slice(0, 12) + ' · 工作树' + (stamp.dirty ? '**脏**' : '干净')
    + ' · runTag=' + stamp.runTag);
  lines.push('入口 ' + stamp.entryPath + (stamp.deployEntryPresent ? '（部署面）' : '（仓内 —— 部署面缺失）'));
  lines.push('隔离根 ' + isolation.root + '（DSH_HOME / USERPROFILE / HOME 三变量齐隔离；真实 home=' + stamp.isolation.realHome + '）');
  lines.push('');
  for (const r of results) {
    const head = '[' + r.status + '] ' + r.id + ' ' + r.title;
    lines.push(head);
    const body = String(r.detail ?? '');
    for (const line of body.split('\n')) if (line.trim()) lines.push('        ' + line);
  }
  lines.push('');
  lines.push('── 汇总 ──');
  lines.push('14 项：PASS ' + stamp.counts.pass + ' · SKIP ' + stamp.counts.skip + ' · FAIL ' + stamp.counts.fail
    + '（共 ' + stamp.counts.total + '）· 元层 M-01：' + (stamp.checks.find((c) => c.id === 'M-01')?.status ?? '?'));
  if (stamp.skip.length) lines.push('SKIP 清单（**不算 pass**）：' + stamp.skip.map((s) => s.id).join(', '));
  if (stamp.fail.length) lines.push('FAIL 清单：' + stamp.fail.map((s) => s.id).join(', '));
  lines.push('隔离后置自检：' + (isolation.kept ? '--keep 保留（清理降级为 SKIP）' : (isolation.removed ? '隔离根已清理 ✓' : '**隔离根残留 ✗ ⇒ 2**')));
  lines.push('certify 前置：' + (stamp.dirty ? '**不成立**（工作树脏 ⇒ 结论不可归属任何 HEAD）' : '成立（干净树）'));
  lines.push('退出码 ' + stamp.exitCode + '（0 全过（脏树不阻断）/ 1 有 FAIL / 2 用法或隔离前置失败 / 3 有 SKIP）');
  if (stamp.exitCode === 3 && !stamp.skip.length && stamp.dirty) {
    lines.push('  ↳ 本次 3 的唯一成因 = 工作树脏（无 FAIL、无 SKIP）。提交后复跑应得 0。');
  }
  lines.push('边界：' + stamp.boundary);
  return lines.join('\n');
}

if (!ISOLATED) runOrchestrator();
else await runMain();
