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

// test/lane-session-bind.test.js —— 批 `d-override-fix-20261011` · lane `e4-session-bind` 专测
//
// 缺陷（实测原始回执）：引擎自派 worker 是**子会话**，`lib/tools/shared.js#sessionOf(args, exec)` 仅三级回落
//   `args.session → exec.agent.session.id → 'cli'` ⇒ worker **未传 session** 时落到 **workerSessionId**，
//   而批次归属键 = 派发方（Leader）会话 ⇒ 治理工具一律被拒：
//     `Error: batch not found: <batchId> @<workerSessionId>`
//   （lane `e2-guidance` 实测 4 次；本 lane 首步 `batch_status` / `lane_checkpoint` 同样命中同一文案。）
//
// 修法（本 lane 实现）：`sessionOf` 增**可选第三参数** resolver（注入的函数；保持 `shared.js` 零 import 红线），
//   resolver 单点 = `lib/engine/dispatch.js#batchSessionIdOfWorker`（唯一 worker→批 反查点，数据源 = 既有
//   `dispatchIndex`，**不建第二套索引**）；装配层经 `deps.resolveBatchSession` 透传给批内工具。
//
// 本文件的覆盖面（如实声明）：
//   · **真实调用链**：经 `lib/tools/register.js#createTools` 建工具表 → 调 `tool.execute(...)`——
//     与宿主 `ToolRegistry` 走同一条 `execute` 面（不是只测纯函数）。
//   · **真实 store**：真 `createStore(tmpRoot)` + 真落盘批次 JSON（`asset_claim` 用例端到端命中归属校验）。
//   · **零宿主改造**：不启宿主进程、不触网、不碰真实用户目录。
//   · **不覆盖**（如实登记，交 Leader 的 AC-8 宿主冒烟）：宿主进程重启后经真实 LLM worker 的调用链。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sessionOf } from '../lib/tools/shared.js';
import {
  batchSessionIdOfWorker, batchSessionIdOfWorkerResolved, dispatchIndexEntryOf,
} from '../lib/engine/dispatch.js';
import { createTools } from '../lib/tools/register.js';
// 【批 `session-bind-index-fix-20261012` · lane `e2-assert`】回归-c（真实组装路径）所需：
//   `createCoreTools`（`lane_dispatch` 的真实组装面）+ `buildWavePlan`（三层夹具）+ 句柄单例复位。
import { createCoreTools } from '../lib/tools/core.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { __resetLaneHandles } from '../lib/bridge/lane-handle.js';
import { createStore } from '../lib/state/store.js';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSrc = (rel) => fs.readFileSync(path.join(PKG, rel), 'utf8');

// ── 夹具（单点，全部用例共用）────────────────────────────────────────────────────────────
const LEADER_SESSION = 'session-leader-0001';   // 批归属会话（= 批文件所在会话 = member.dispatch.sessionId）
const WORKER_SESSION = '74dd2c56-1111-4222-8333-444455556666'; // 引擎自派 worker 子会话 id
const BATCH_ID = 'b-session-bind';

/** 真实批次 JSON 与会话根（隔离临时根；零写工作区 / 零写真实用户目录）。 */
function makeFixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-lane-session-bind-'));
  const store = createStore(root);
  store.createBatch(LEADER_SESSION, {
    batchId: BATCH_ID,
    wavePlan: { team: null, wavePlan: [{ wave: 1, tasks: [{ id: 'e1', layer: 'exec', deps: [] }] }] },
  });
  return { root, store };
}

/** 引擎侧 resolver 注入值（**生产同形**：装配层闭包捕获同一 dispatchIndex 引用）。 */
function makeResolveBatchSession(dispatchIndex) {
  return (exec) => batchSessionIdOfWorker(dispatchIndex, exec);
}

/** 宿主形态的 `exec`（worker 子会话：`exec.agent.session.id` = workerSessionId）。 */
const workerExec = (id = WORKER_SESSION) => ({ agent: { session: { id } } });

/** 最小 ctx（`createTools` 只需 `tools.register` 与 `logger`）。 */
function makeCtx() {
  return {
    tools: { register: () => {}, guard: () => {} },
    logger: { info() {}, warn() {}, error() {} },
    on: () => () => {},
    get: () => undefined,
  };
}

/** 建工具表（`extraDeps` = 生产装配注入面）。 */
function makeTools(store, root, extraDeps = {}) {
  const { tools } = createTools(makeCtx(), { store, root, ...extraDeps });
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}
// ── Q-C 派生面（批 `session-bind-index-fix-20261012` · lane `e2-assert`）────────────────────
// 前批（e7）把「两参残留集合」写成**冻结常量清单**（逐字 5 个文件名）⇒ 任何**合法接线**
// （某残留文件被补齐三参）都会让清单失配、假红。本批改为**派生清单**：扫 `lib/tools/**` 现算。
//
// 权威读数（本轮只读扫描；`sessionOf` 两参 = 未接线，三参 = 已接线；**注释内出现不计**）：
//   · **已接线、零两参**（8 件）：asset/handoff/lane/log/mailbox/member/query/shared ⇒ 要求「**零**两参」。
//   · **混合既有形态**（1 件）：`task-tools.js`（三参 ×1 + 两参 ×2，其两参点属写域外存量）
//     ⇒ 文件级一刀切会把**既有事实**判红 = 另一种假红 ⇒ 只锁**调用点数**（新增一个未接线点即红）。
//   · **未接线**（3 件）：assign-tools(1) / core(2) / wave-plan-tools(1) ⇒ 派生残留集。
//   · e7 旧清单第 4 项 `tier-gate.js` **只在注释里**写过 `sessionOf(args, exec)` ⇒ 按代码面它**不是**残留
//     （＝冻结清单与代码事实脱节的又一例证；由 Q-C 用例 §③ 留档）。
//
// 派生判据（逐条钉死；`twoArgResidualOf` / `detectorViolationsOf` 是唯一定义点）：
//   ① **已接线文件不得回退**：文件内有任一处三参调用、且两参调用点数 > 在册值 ⇒ 判红
//      （`detectorViolationsOf` 报 `<file>:two-arg-in-wired-file xN`）。
//   ② **混合形态按调用点锁**：`MIXED_LEGACY_TWO_ARG` 登记既有两参点数。**空表 = 按「零两参」严判**
//      （`MIXED_LEGACY_TWO_ARG['<file>'] ?? 0`）——故「未登记的新混合件」自动被严判判红，无需额外分支。
//      ⚠ 它**不是**残留文件名清单：不参与残留集派生，只在混合文件上作计数对照。
//   ③ **残留集派生**：只有两参、零三参的文件（扫描现算）；同时不得引用 resolver 面。
//   ④ 分区自洽：接线集 ∪ 残留集 = 全部含 `sessionOf` 调用的文件（见 Q-C 用例 §⑥）。
//   ⚠ 一切计数都在**去注释**后的代码视图上做（注释/文档里写的调用形态不得被计入——
//      否则注释里的 `sessionOf(args, exec)` 会把「已接线」文件误判成残留：`tier-gate.js` 即实测一例）。
/** 混合文件的**既有**两参调用点数（登记既有事实；未在册者按 0 严判）。 */
const MIXED_LEGACY_TWO_ARG = Object.freeze({ 'task-tools.js': 2 });

function toolsJsOf(toolsDir) {
  return walkJs(toolsDir)
    .map((p) => ({ file: path.basename(p), src: fs.readFileSync(p, 'utf8') }))
    .sort((a, b) => a.file.localeCompare(b.file));
}
/**
 * 去注释代码视图（逐字符状态机：`//` 行注释 + 块注释剔除）。
 * ⚠ 只做**注释**剔除，**不**解析字符串/正则字面量——本仓 `lib/tools/**` 广泛使用含引号/斜杠的
 *   正则与字符串（如 `/['"]/`、带反引号的模板串），把它们当字面量解析会让状态机错吞后续代码、
 *   进而**漏计**调用形态（首轮实测：`tier-gate.js` 的调用点被整段吞掉）。
 *   故取**保守**口径：注释剔除 + 调用形态正则匹配——字符串/正则里恰好写出 `sessionOf(args, exec)`
 *   的假阳性概率可忽略，且只会**多**报不会漏报 ⇒ 落在安全侧。
 */
function codeViewOf(src) {
  let code = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (ch === '/' && next === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1; i += 2; continue; }
    code += ch;
    i += 1;
  }
  return code;
}
const thirdArgCallCount = (src) => (codeViewOf(src).match(/sessionOf\(args, exec, resolveBatchSession\)/g) ?? []).length;
const twoArgCallCount = (src) => (codeViewOf(src).match(/sessionOf\(args, exec\)/g) ?? []).length;
/** 已接线文件集：至少一处三参调用。 */
function wiredFilesOf(inventory) {
  return inventory.filter((f) => thirdArgCallCount(f.src) > 0).map((f) => f.file).sort();
}
/** 未接线调用点清单（文件 × 出现次数）：**新增未接线调用点**的主判据（含混合件计数）。 */
function unwiredCallSitesOf(inventory) {
  return inventory.filter((f) => twoArgCallCount(f.src) > 0)
    .map((f) => f.file + ' x' + twoArgCallCount(f.src)).sort();
}
/** 派生残留集：只有两参、零三参（现算，无冻结常量）。 */
function twoArgResidualOf(inventory) {
  return inventory
    .filter((f) => twoArgCallCount(f.src) > 0 && thirdArgCallCount(f.src) === 0)
    .map((f) => f.file).sort();
}
/** 检测力判据：已接线文件内不得**新增**两参调用；混合既有形态按**调用点数**锁（未在册 ⇒ 按 0 严判）。 */
function detectorViolationsOf(inventory) {
  const out = [];
  for (const f of inventory) {
    const two = twoArgCallCount(f.src);
    const three = thirdArgCallCount(f.src);
    if (two === 0) continue;
    if (three === 0) {
      // 未接线文件：合法登记为残留（但不得同时引用 resolver 面 ⇒ 那才是混杂态）
      if (/resolveBatchSession/.test(codeViewOf(f.src))) out.push(f.file + ':residual-with-resolver');
      continue;
    }
    const legacy = MIXED_LEGACY_TWO_ARG[f.file] ?? 0;
    if (two > legacy) out.push(f.file + ':two-arg-in-wired-file x' + (two - legacy));
  }
  return out;
}
/** 沙箱扫描：把 <文件名, 源码> 物化到临时 tools 目录，跑**与断言同一份**派生算法（零写 lib/**）。 */
function sandboxInventoryOf(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-qc-sandbox-'));
  try {
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body, 'utf8');
    return toolsJsOf(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
// ── 沙箱素材（三个**单形态**模块 + 一个注释陷阱模块）──────────────────────────────────────
/** 纯已接线（零两参）。 */
const wiredOnlyJs = [
  'export const w1 = (args, exec, resolveBatchSession) => sessionOf(args, exec, resolveBatchSession);',
].join('\n') + '\n';
/** 纯未接线（零三参）⇒ 派生残留。 */
const unwiredOnlyJs = [
  'export const u1 = (args, exec) => sessionOf(args, exec);',
].join('\n') + '\n';
/** 混合既有形态：三参 ×1 + 两参 ×2（与在册 `MIXED_LEGACY_TWO_ARG["task-tools.js"] = 2` 同形）。 */
const mixedToolsJs = [
  'export const m0 = (args, exec, resolveBatchSession) => sessionOf(args, exec, resolveBatchSession);',
  'export const m1 = (args, exec) => sessionOf(args, exec);',
  'export const m2 = (args, exec) => sessionOf(args, exec);',
].join('\n') + '\n';
/** 注释陷阱：两参字样只在注释里（不得计入）。 */
const commentedToolsJs = [
  '// 说明：此处**不改用** sessionOf(args, exec)',
  'export const c1 = (args, exec, resolveBatchSession) => sessionOf(args, exec, resolveBatchSession);',
].join('\n') + '\n';

/** 自派夹具：plan 产物 + C 档治理（供真实组装路径的 `lane_dispatch` 用）。 */
function makeDispatchFixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-lane-dispatch-bind-'));
  const store = createStore(root);
  const artRoot = path.join(root, 'sessions', LEADER_SESSION, 'artifacts', BATCH_ID);
  fs.mkdirSync(path.join(artRoot, 'plan'), { recursive: true });
  fs.writeFileSync(path.join(artRoot, 'plan', 'spec.md'), '# 规格夹具\n', 'utf8');
  store.createBatch(LEADER_SESSION, {
    batchId: BATCH_ID,
    wavePlan: buildWavePlan({
      batchId: BATCH_ID,
      tasks: [
        { id: 'p1', cmd: 'plan', layer: 'plan', role: 'coordinator', produce: ['plan/spec.md'], outputs: ['plan/spec.md'] },
        { id: 'e1', cmd: 'impl', layer: 'exec', role: 'coder', deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/e1/o.md'] },
        { id: 'a1', cmd: 'audit', layer: 'audit', role: 'supervisor', deps: ['e1'], consume: ['plan/spec.md'] },
      ],
    }),
    phase: 'running',
  });
  store.writeGovernance(LEADER_SESSION, {
    lastAssign: { difficulty: 'C', form: 'C', scope: 'full', rationale: 'e2-assert 夹具：自派前置评估', reasons: [], at: new Date().toISOString(), execCallsSince: 0 },
  });
  return { root, store };
}

/** 自派运行时桩：`rt.start` 返回定点 worker 会话 id（`SubagentRun.id` 契约字段）。 */
function makeSpawnRuntime(workerSessionId) {
  return { start: async () => ({ id: workerSessionId, result: Promise.resolve({ output: [], stopReason: 'completed' }) }) };
}

/** 记录型 store（事件流反查面）：实现 `laneBindingOf` 消费的两个方法，并计数扫盘次数。 */
function makeBindingStore({ bind = null } = {}) {
  const scans = { n: 0 };
  return {
    scans,
    listAllBatches() { scans.n += 1; return bind ? [{ sessionId: LEADER_SESSION, batchId: BATCH_ID }] : []; },
    readBatch(sessionId, batchId) {
      if (!bind) return null;
      return { sessionId, batchId, events: [{ type: 'member.dispatch', lane: 'e1', workerSessionId: bind.workerSessionId }] };
    },
  };
}

/**
 * 无 I/O 的**记录型 store**：只实现被 `lane_checkpoint_status` 用到的 `readBatch`，
 * 把「引擎解析出的归属会话」原样记录下来。用于 `sessionOf → 工具 execute` 的**取值链**断言
 * （不依赖 git / 文件系统）。
 */
function makeRecordingStore() {
  const calls = [];
  return {
    calls,
    readBatch(sessionId, batchId) {
      calls.push({ sessionId, batchId });
      // 「命中归属会话 ⇒ 批次可读；否则不可读」——与真实 `store.readBatch` 的拒态同形
      if (sessionId !== LEADER_SESSION) return null;
      return { schema: 1, sessionId, batchId, phase: 'running', lanes: { e1: 'running' }, wavePlan: [], events: [] };
    },
  };
}

// ══ AC-1 显式优先：传 args.session ⇒ 用该值（零回归）══════════════════════════════════════
test('AC-1 显式优先：args.session 压过 resolver 与执行会话（零回归）', () => {
  const dispatchIndex = new Map();
  dispatchIndex.set(WORKER_SESSION, dispatchIndexEntryOf(LEADER_SESSION, BATCH_ID, 'e1', LEADER_SESSION));
  const resolve = makeResolveBatchSession(dispatchIndex);
  const exec = workerExec();

  // ① 三级全在场：显式值必须赢
  assert.equal(sessionOf({ session: 'session-explicit' }, exec, resolve), 'session-explicit');
  // ② 显式值为空串 ⇒ 视为未传（与既有判据 `args.session.length` 逐字一致）⇒ 走 resolver
  assert.equal(sessionOf({ session: '' }, exec, resolve), LEADER_SESSION);
  // ③ 显式值非字符串 ⇒ 视为未传（既有判据原样）⇒ 走 resolver
  assert.equal(sessionOf({ session: 123 }, exec, resolve), LEADER_SESSION);
  // ④ 显式值在**工具**面同样优先（走真实 execute）。断言形态：让 readBatch 在「不是显式值」时也返回批次，
  //    ⇒ 若显式值未被优先采用（被 resolver 改写成批归属会话），execute 会成功而**不会**抛；
  //    故「抛且文案含显式值」本身即「显式优先」的判据（RED 对照形态，比只断言成功更锐）。
  const store = {
    calls: [],
    readBatch(sessionId, batchId) {
      this.calls.push({ sessionId, batchId });
      if (sessionId === 'session-explicit') return null; // 「我只认显式值」的反向 store
      return { schema: 1, sessionId, batchId, phase: 'running', lanes: { e1: 'running' }, wavePlan: [], events: [] };
    },
  };
  const tools = makeTools(store, os.tmpdir(), { resolveBatchSession: resolve });
  return tools.lane_checkpoint_status
    .execute({ batchId: BATCH_ID, laneId: 'e1', session: 'session-explicit' }, exec)
    .then(() => { throw new Error('显式值未被优先采用：execute 未抛（说明落在了批归属会话）'); })
    .catch((e) => {
      assert.match(String(e?.message ?? e), /batch not found: b-session-bind @session-explicit/,
        'readBatch 收到的会话必须是**显式值**（逐字回显）');
      assert.equal(store.calls.at(-1).sessionId, 'session-explicit');
    });
});

// ══ AC-2 绑定命中：dispatchIndex 命中（worker 会话）+ 不传 session ⇒ 批归属会话 ══════════
test('AC-2 绑定命中：resolver 单点把 worker 会话解析为批归属会话', () => {
  const dispatchIndex = new Map();
  dispatchIndex.set(WORKER_SESSION, dispatchIndexEntryOf(LEADER_SESSION, BATCH_ID, 'e1', LEADER_SESSION));
  const resolve = makeResolveBatchSession(dispatchIndex);

  // ① 单点探针原文
  assert.equal(batchSessionIdOfWorker(dispatchIndex, workerExec()), LEADER_SESSION);
  assert.equal(sessionOf({}, workerExec(), resolve), LEADER_SESSION);
  assert.equal(sessionOf(undefined, workerExec(), resolve), LEADER_SESSION);

  // ② 未绑定会话 / 无 exec / 非 Map 索引 / 空 sessionId ⇒ 一律 null（不猜兜底）
  assert.equal(batchSessionIdOfWorker(dispatchIndex, workerExec('session-someone-else')), null);
  assert.equal(batchSessionIdOfWorker(dispatchIndex, undefined), null);
  assert.equal(batchSessionIdOfWorker(null, workerExec()), null);
  assert.equal(batchSessionIdOfWorker(new Map([[WORKER_SESSION, { sessionId: '' }]]), workerExec()), null);

  // ③ **真实调用链**：`lane_checkpoint_status.execute`（不传 session）⇒ 落到批归属会话
  const store = makeRecordingStore();
  const tools = makeTools(store, os.tmpdir(), { resolveBatchSession: resolve });
  return tools.lane_checkpoint_status.execute({ batchId: BATCH_ID, laneId: 'e1' }, workerExec()).then((out) => {
    assert.equal(store.calls.at(-1).sessionId, LEADER_SESSION, 'readBatch 必须收到批归属会话');
    assert.equal(store.calls.at(-1).batchId, BATCH_ID);
    assert.equal(out.ok, true);
    assert.deepEqual(out.checkpoints, []);
    assert.equal(out.latest, null);
  });
});

test('AC-2b 端到端（真 store + 真落盘批）：asset_claim 未传 session 在 worker 会话内成功归位', () => {
  const { root, store } = makeFixtureRoot();
  const dispatchIndex = new Map();
  dispatchIndex.set(WORKER_SESSION, dispatchIndexEntryOf(LEADER_SESSION, BATCH_ID, 'e1', LEADER_SESSION));
  const tools = makeTools(store, root, { resolveBatchSession: makeResolveBatchSession(dispatchIndex) });

  const src = path.join(root, 'src-artifact.md');
  fs.writeFileSync(src, 'x\n', 'utf8');

  // RED 对照（同一次执行内取）：**不注入** resolver ⇒ 工具回落到 worker 子会话 ⇒ 真实 store 拒
  const bare = makeTools(store, root);
  return bare.asset_claim.execute({ batchId: BATCH_ID, source: src, target: 'exec/e1/a.md' }, workerExec())
    .then(() => { throw new Error('RED 对照不得成功（未注入 resolver 时 worker 会话不可能是批归属会话）'); })
    .catch((e) => {
      assert.match(String(e?.message ?? e), /batch not found/, 'RED 回执须是真实拒态文案');
    })
    .then(() => tools.asset_claim.execute({ batchId: BATCH_ID, source: src, target: 'exec/e1/a.md' }, workerExec()))
    .then((out) => {
      assert.equal(out.ok, true);
      assert.equal(out.batchId, BATCH_ID);
      // GREEN 的物理事实：产物落在**批归属会话**的批次产物根下（真盘在场地可核）
      const landed = path.join(store.artifactsDirOf(LEADER_SESSION, BATCH_ID), 'exec', 'e1', 'a.md');
      assert.equal(fs.existsSync(landed), true, '产物应落 <root>/sessions/<批归属会话>/artifacts/<batchId>/exec/e1/a.md');
      assert.equal(fs.readFileSync(landed, 'utf8'), 'x\n');
    });
});

// ══ AC-3 Leader 零回归：无绑定会话 + 不传 session ⇒ 逐字回落 exec.agent.session.id ═════════
test('AC-3 Leader 零回归：无 worker 绑定 ⇒ resolver 不命中 ⇒ 取值与改动前逐字相同', () => {
  const dispatchIndex = new Map();
  dispatchIndex.set(WORKER_SESSION, dispatchIndexEntryOf(LEADER_SESSION, BATCH_ID, 'e1', LEADER_SESSION));
  const resolve = makeResolveBatchSession(dispatchIndex);
  const leaderExec = { agent: { session: { id: LEADER_SESSION } } };

  // ① resolver 在场但不命中 ⇒ 回落执行会话（= Leader 自身会话，与改动前同一取值式）
  assert.equal(batchSessionIdOfWorker(dispatchIndex, leaderExec), null);
  assert.equal(sessionOf({}, leaderExec, resolve), LEADER_SESSION);
  assert.equal(sessionOf({}, leaderExec), LEADER_SESSION); // 不注入 ⇒ 逐字同值
  // ② 无 exec（'cli' 兜底语义不变）
  assert.equal(sessionOf({}, undefined, resolve), 'cli');
  assert.equal(sessionOf({}, undefined), 'cli');
  // ③ resolver 抛错 / 返回非字符串 / 返回空串 ⇒ 静默回落（工具面不得因归属解析而炸）
  assert.equal(sessionOf({}, leaderExec, () => { throw new Error('boom'); }), LEADER_SESSION);
  assert.equal(sessionOf({}, leaderExec, () => 42), LEADER_SESSION);
  assert.equal(sessionOf({}, leaderExec, () => ''), LEADER_SESSION);
  assert.equal(sessionOf({}, leaderExec, 'not-a-function'), LEADER_SESSION);
  // ④ 生产形态对照：**Leader 调同一工具**，readBatch 收到 Leader 会话（与改动前同类读数）
  const store = makeRecordingStore();
  const tools = makeTools(store, os.tmpdir(), { resolveBatchSession: resolve });
  return tools.lane_checkpoint_status.execute({ batchId: BATCH_ID, laneId: 'e1' }, leaderExec).then((out) => {
    assert.equal(store.calls.at(-1).sessionId, LEADER_SESSION);
    assert.equal(out.ok, true);
  });
});

// ══ AC-4 零依赖红线：shared.js 仍无任何 import ════════════════════════════════════════════
test('AC-4 零依赖红线：lib/tools/shared.js 无任何 import/require/动态 import', () => {
  const src = readSrc('lib/tools/shared.js');
  const lines = src.split('\n');
  const importLines = lines.filter((l) => /^\s*import[\s({*'"]/.test(l) || /^\s*export\s+.*\s+from\s+['"]/.test(l));
  assert.deepEqual(importLines, [], 'shared.js 不得出现静态 import / re-export from');
  assert.equal(/\brequire\s*\(/.test(src), false, 'shared.js 不得出现 require(');
  assert.equal(/\bimport\s*\(/.test(src), false, 'shared.js 不得出现动态 import(');
  // 红线注释在册（判据：该文件明写「不得 import 任何模块」）
  assert.match(src, /本文件不得 import 任何模块/, '零依赖红线注释须在册');
  // resolver 只接受注入函数（不自造索引、不 import 任何模块）
  assert.match(src, /typeof resolveBatchSession === 'function'/, 'resolver 须为注入函数（非模块级索引）');
});

test('AC-4b 回落顺序单点：`sessionOf` 定义恰 1 处，且顺序 = 显式 → resolver → 执行会话 → cli', () => {
  const src = readSrc('lib/tools/shared.js');
  assert.equal((src.match(/export function sessionOf\(/g) ?? []).length, 1, 'sessionOf 定义须恰 1 处（禁第二套回落顺序）');
  const body = src.slice(src.indexOf('export function sessionOf('));
  const idx = (needle) => body.indexOf(needle);
  const iExplicit = idx('args.session');
  const iResolver = idx('resolveBatchSession(exec)');
  const iExec = idx('exec?.agent?.session?.id');
  const iCli = idx("?? 'cli'");
  assert.ok(iExplicit > 0 && iResolver > iExplicit, '顺序：显式值须先于 resolver');
  assert.ok(iExec > iResolver, '顺序：resolver 须先于执行会话回落');
  assert.ok(iCli > iExec, "顺序：'cli' 兜底须在最后");
});

// ══ AC-5 单点：lib/** 内 worker→批 索引仍仅 dispatchIndex 一处 ═══════════════════════════
function walkJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJs(p));
    else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('AC-5 单点：worker→批 反查只经 dispatchIndex（禁建第二套索引）', () => {
  const libJs = walkJs(path.join(PKG, 'lib'));
  const rel = (p) => path.relative(PKG, p).replace(/\\/g, '/');
  // ① 索引**构造**单点：`new Map()` 承载 worker→批 映射的只有装配层那一处
  const mapCtor = libJs.filter((p) => /dispatchIndex\s*=\s*new Map\(/.test(fs.readFileSync(p, 'utf8'))).map(rel);
  assert.deepEqual(mapCtor, ['lib/index.js'], 'dispatchIndex 的 Map 构造须恰 1 处（装配层）');
  // ② 索引**读**点：`dispatchIndex.get(...)` 的消费面（本 lane 新增 batchSessionIdOfWorker 为其一）
  const readers = libJs.filter((p) => /dispatchIndex[^\n]*\.get\(/.test(fs.readFileSync(p, 'utf8'))).map(rel).sort();
  assert.deepEqual(readers, ['lib/engine/auto-settle.js', 'lib/engine/dispatch.js', 'lib/index.js'].sort(),
    'worker→批 反查文件集须恰为这三件（新增第二套索引会让本断言变红）');
  // ③ 反查单点：本 lane 的新函数定义恰 1 处，且**只**在 dispatch.js
  const definers = libJs.filter((p) => /export function batchSessionIdOfWorker\(/.test(fs.readFileSync(p, 'utf8'))).map(rel);
  assert.deepEqual(definers, ['lib/engine/dispatch.js'], '反查单点须恰 1 处');
  // ④ `sessionOf` 的 resolver 注入面**不**自持索引（只转发注入函数）
  const shared = readSrc('lib/tools/shared.js');
  assert.equal(/dispatchIndex|new Map\(/.test(shared), false, 'shared.js 不得接触任何索引');
});

// ══ AC-6 任务包双保险：lane_dispatch 骨架含批归属会话 id 与 session 传参提示 ═══════════════
test('AC-6 任务包双保险：composeWorkerPrompt 明写批归属会话 + session 传参提示（golden）', async () => {
  const { composeWorkerPrompt } = await import('../lib/engine/dispatch.js');
  const base = {
    batchId: BATCH_ID, lane: 'e1', cmd: 'c', layer: 'exec', role: null,
    consume: [], produce: [], outputs: [], firstLine: 'HANDLE-LINE', leaderPrompt: '', artifactsRoot: '/art',
  };
  // ① 缺省（不传 batchSessionId）⇒ 逐字不含新行（零回归）
  const without = composeWorkerPrompt(base);
  assert.equal(/批归属会话/.test(without), false, '未注入 batchSessionId ⇒ 任务包逐字节不变（不加新行）');
  // ② 注入 ⇒ 恰 1 行，含 id 与可照抄的 session 传参提示
  const withId = composeWorkerPrompt({ ...base, batchSessionId: LEADER_SESSION });
  const lines = withId.split('\n').filter((l) => l.includes('批归属会话'));
  assert.equal(lines.length, 1, '批归属会话行须恰 1 行');
  const line = lines[0];
  assert.match(line, new RegExp('`' + LEADER_SESSION + '`'), '须含批归属会话 id（反引号包裹）');
  assert.match(line, /session:"session-leader-0001"/, '须含可照抄的 session 传参形态');
  assert.match(line, /lane_checkpoint/, '须点名治理工具（lane 族）');
  assert.match(line, /handoff_submit/, '须点名治理工具（交接族）');
  assert.match(line, /mailbox_\*/, '须点名治理工具（通信族）');
  // ③ 位置契约：在**纪律段之前**（worker 先读到再动手）
  assert.ok(withId.indexOf('批归属会话') < withId.indexOf('## 纪律'), '双保险行须落在 lane 契约块内（## 纪律 之前）');
  // ④ 空串 / 非字符串 ⇒ 不产该行（无一字漂移）
  assert.equal(/批归属会话/.test(composeWorkerPrompt({ ...base, batchSessionId: '' })), false);
  assert.equal(/批归属会话/.test(composeWorkerPrompt({ ...base, batchSessionId: null })), false);
  // ⑤ 生产接线可核：`dispatchLaneCore` 的 composeWorkerPrompt 调用点传了 batchSessionId
  const dispatchSrc = readSrc('lib/engine/dispatch.js');
  assert.match(dispatchSrc, /batchSessionId:\s*sessionId/, 'dispatchLaneCore 须把落点会话（= 批归属会话）传进任务包');
});

// ══ 覆盖面自证：本 lane 覆盖的治理工具清单（防「改了 A 漏了 B」）═════════════════════════
test('覆盖面：任务包点名的治理工具均消费 resolver（注册表 + 调用点双读）', () => {
  const expected = {
    'lib/tools/lane-tools.js': [/lane_worktree_create/, /lane_checkpoint'/, /lane_checkpoint_status/, /lane_worktree_merge/],
    'lib/tools/member-tools.js': [/lane_claim/, /lane_release/, /member_settle/, /lane_dispatch/, /member_status/],
    'lib/tools/handoff-tools.js': [/handoff_submit/, /handoff_view/],
    'lib/tools/mailbox-tools.js': [/mailbox_send/, /mailbox_read/, /mailbox_ack/],
    'lib/tools/asset-tools.js': [/asset_claim/],
    'lib/tools/log-tools.js': [/log_export/],
  };
  for (const [file, toolMarks] of Object.entries(expected)) {
    const src = readSrc(file);
    // ① 该文件已接线：调用点用三参形态，且 resolver 取自注入面
    const wired = (src.match(/sessionOf\(args, exec, resolveBatchSession\)/g) ?? []).length;
    assert.ok(wired > 0, file + '：须至少一处三参 sessionOf');
    assert.match(src, /resolveBatchSession/, file + '：须从注入面取 resolver');
    // ② 声明的工具仍在该文件内（防改名/搬移后本测静默失效）
    for (const mark of toolMarks) assert.match(src, mark, file + ' 缺少工具声明 ' + String(mark));
  }
  // ③ 双参数形态的**残留清单**必须恰为「非本写域」文件（任何本写域文件回退到两参形态即红）
  const twoArgFiles = walkJs(path.join(PKG, 'lib/tools'))
    .filter((p) => /sessionOf\(args, exec\)/.test(fs.readFileSync(p, 'utf8')))
    .map((p) => path.basename(p)).sort();
  // ⚠ 【批 `session-bind-index-fix-20261012` · lane `e2-assert` · **Q-C**】以下**不再**依赖冻结常量清单：
  //   判据改为**派生**（唯一定义点 = 本文件上方 `detectorViolationsOf` / `twoArgResidualOf`）：
  //     · 已接线文件（任一三参调用）内**新增**两参调用 ⇒ 判红（本写域文件回退即红，检测力不削弱）；
  //     · 混合既有形态按**调用点数**锁；未接线文件派生进残留集（扫描现算，去注释口径）；
  //     · 旧硬编码清单已失配两项（`query-tools.js` 已接线 / `tier-gate.js` 的两参只在注释里）
  //       ——失配事实由 Q-C 用例 §③ 留档。
  const inventory = toolsJsOf(path.join(PKG, 'lib', 'tools'));
  assert.deepEqual(detectorViolationsOf(inventory), [], '已接线文件不得回退两参 / 残留件不得引用 resolver 面');
  const residual = twoArgResidualOf(inventory);
  assert.equal(residual.length, 3, '残留文件数（现算）：' + residual.join(', '));
  for (const f of ['assign-tools.js', 'core.js', 'wave-plan-tools.js']) {
    assert.equal(residual.includes(f), true, '残留集须含（既有未接线件）：' + f);
  }
  for (const f of ['query-tools.js', 'tier-gate.js', 'task-tools.js']) {
    assert.equal(residual.includes(f), false, '不得进残留集（已接线 / 混合形态）：' + f);
  }
});

// ══ 回归 (a) 修复①：只有事件、无内存索引 ⇒ 反查命中（冷索引 + 事件在盘）════════════════════
test('回归-a 修复①：冷索引（内存无该 worker 键）+ 事件在盘 ⇒ resolver 反查命中并回填', () => {
  const workerSessionId = '74dd2c56-aaaa-4bbb-8ccc-00000000000a';
  const store = makeBindingStore({ bind: { workerSessionId } });
  const dispatchIndex = new Map();
  const exec = workerExec(workerSessionId);

  // ⓪ 前置：内存索引**冷**（本用例的命题前提，先立起来）
  assert.equal(batchSessionIdOfWorker(dispatchIndex, exec), null, '前置：内存索引内无该 worker 键');
  // ① 反查命中：冷索引 + store 可用 + 事件在盘 ⇒ 返回**批归属会话 id**（非 null）
  assert.equal(batchSessionIdOfWorkerResolved(store, dispatchIndex, exec), LEADER_SESSION);
  // ② 回填可核：同一构造下 Map 事后含该 worker 键
  assert.equal(dispatchIndex.has(workerSessionId), true, '回填后 Map 须含该 worker 键');
  // ③ 值形状冻结：经 dispatchIndexEntryOf 单点构造 ⇒ 恰 3 键
  assert.deepEqual(Object.keys(dispatchIndex.get(workerSessionId)), ['sessionId', 'batchId', 'lane']);
  // ④ 阴性面：无 store / 空 store / 无 exec ⇒ null（逐字原回落，不猜兜底）
  assert.equal(batchSessionIdOfWorkerResolved(undefined, new Map(), exec), null);
  assert.equal(batchSessionIdOfWorkerResolved({}, new Map(), exec), null);
  assert.equal(batchSessionIdOfWorkerResolved(store, new Map(), undefined), null);
});

// ══ 回归 (b) 修复①回填缓存：二次调用不再扫盘（幂等）═════════════════════════════════════
test('回归-b 回填缓存：冷查 1 次扫盘、二次调用走缓存零扫盘；已热则整段不扫', () => {
  const workerSessionId = '74dd2c56-bbbb-4ccc-8ddd-00000000000b';
  const store = makeBindingStore({ bind: { workerSessionId } });
  const dispatchIndex = new Map();
  const exec = workerExec(workerSessionId);

  // ① 冷查 ⇒ 扫 1 次
  assert.equal(batchSessionIdOfWorkerResolved(store, dispatchIndex, exec), LEADER_SESSION);
  assert.equal(store.scans.n, 1, '冷查须恰扫盘 1 次');
  // ② 二次调用 ⇒ 走回填缓存（零新增扫盘；幂等）
  assert.equal(batchSessionIdOfWorkerResolved(store, dispatchIndex, exec), LEADER_SESSION);
  assert.equal(store.scans.n, 1, '二次调用不得再扫盘（走回填缓存）');
  // ③ 索引已热 ⇒ 热路径短路，整段不扫盘
  assert.equal(batchSessionIdOfWorkerResolved(store, dispatchIndex, exec), LEADER_SESSION);
  assert.equal(store.scans.n, 1, '热路径短路 ⇒ 零扫盘');
  // ④ 键数不因回填而增（同键覆盖语义）
  assert.equal(dispatchIndex.size, 1, '同键覆盖：Map 键数恒 1');
  // ⑤ 无绑定（事件流无该 worker）⇒ 不命中且零回填（不猜兜底）
  const other = '74dd2c56-cccc-4ddd-8eee-00000000000c';
  const store2 = makeBindingStore({ bind: null });
  const idx2 = new Map();
  assert.equal(batchSessionIdOfWorkerResolved(store2, idx2, workerExec(other)), null);
  assert.equal(idx2.size, 0, '未命中不得回填');
});

// ══ 回归 (c) 修复③：lane_dispatch 路径下索引条目存在（真实组装路径）══════════════════════
test('回归-c 修复③：lane_dispatch 路径 ⇒ 同一 workerSessionId 在 dispatchIndex 内立即可查', async () => {
  __resetLaneHandles();
  const { root, store } = makeDispatchFixtureRoot();
  const workerSessionId = 'ws-eng-dispatch-bind-1';
  const dispatchIndex = new Map();
  const ctx = { ...makeCtx(), subagents: makeSpawnRuntime(workerSessionId) };
  // 真实组装面（deps 注入：store/root/config/dispatchIndex/resolveBatchSession）——与生产同形
  const tools = Object.fromEntries(createCoreTools(ctx, {
    store, root, config: { dispatch: { provider: 'spawn-in-process' } },
    resolveBatchSession: (exec) => batchSessionIdOfWorkerResolved(store, dispatchIndex, exec),
    dispatchIndex,
  }).map((t) => [t.name, t]));
  const leaderExec = { agent: { session: { id: LEADER_SESSION } } };

  // ⓪ 前置：派发前索引内无该 worker 键（命题前提）
  assert.equal(dispatchIndex.has(workerSessionId), false, '前置：派发前索引冷');
  const out = await tools.lane_dispatch.execute({ batchId: BATCH_ID, lane: 'e1', prompt: 'e2 夹具' }, leaderExec);
  // ① 派发成功 + 证据 1：事件流留痕（member.dispatch）
  assert.equal(out.spawned, true, '自派须成功（provider 已在夹具注入）');
  assert.equal(out.workerSessionId, workerSessionId);
  const dispatched = store.readBatch(LEADER_SESSION, BATCH_ID).events.filter((e) => e.type === 'member.dispatch');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].workerSessionId, workerSessionId);
  // ② 证据 2：**无需任何反查**，同一 worker 键在 Map 内立即可查（修复③ 主路）
  assert.equal(dispatchIndex.has(workerSessionId), true, 'lane_dispatch 返回后索引须已含该 worker 键（同步写，非反查）');
  // ③ 条目值：批归属会话 id + 形状冻结（恰 3 键；ownerSessionId 非枚举）
  const entry = dispatchIndex.get(workerSessionId);
  assert.equal(entry.sessionId, LEADER_SESSION);
  assert.equal(entry.batchId, BATCH_ID);
  assert.equal(entry.lane, 'e1');
  assert.deepEqual(Object.keys(entry), ['sessionId', 'batchId', 'lane']);
  assert.deepEqual(Object.getOwnPropertyNames(entry), ['sessionId', 'batchId', 'lane', 'ownerSessionId']);
  // ④ 消费面读同一 Map 引用 ⇒ 无需反查即命中
  assert.equal(batchSessionIdOfWorker(dispatchIndex, workerExec(workerSessionId)), LEADER_SESSION);
  __resetLaneHandles();
});

// ══ Q-C 检测力自证：任一「未接线两参调用点」的新增 ⇒ 判据**必须**判红 ══════════════════════
test('Q-C 检测力自证：注入未接线两参调用点 ⇒ 判红；注入点改三参 ⇒ 复原为绿（沙箱，零写 lib/**）', () => {
  // ⓪ 沙箱基线（单形态：纯已接线 + 纯未接线）⇒ 违例清零、残留集 = 未接线那件
  const clean = sandboxInventoryOf({ 'a-wired.js': wiredOnlyJs, 'b-unwired.js': unwiredOnlyJs });
  assert.deepEqual(detectorViolationsOf(clean), []);
  assert.deepEqual(twoArgResidualOf(clean), ['b-unwired.js'], '纯未接线文件即派生残留（读法自洽）');
  // ① 新增未接线调用点落在**已接线**文件 ⇒ 判红（旧硬编码清单抓不到这一形态）
  const injectedWired = sandboxInventoryOf({
    'a-wired.js': wiredOnlyJs + 'export const stray = (args, exec) => sessionOf(args, exec);\n',
  });
  assert.deepEqual(detectorViolationsOf(injectedWired), ['a-wired.js:two-arg-in-wired-file x1'],
    '新增未接线两参调用点 ⇒ 必须产生 viol（不得为转绿而恒真）');
  // ② 在册混合件（`MIXED_LEGACY_TWO_ARG` 有登记）在**未增未减**下不判红；新增一个未接线点即红
  const asIsMixed = sandboxInventoryOf({ 'task-tools.js': mixedToolsJs });
  assert.deepEqual(detectorViolationsOf(asIsMixed), [], '在册混合形态（恰好等于在册点数）不判红');
  assert.deepEqual(twoArgResidualOf(asIsMixed), [], '有任一三参调用 ⇒ 不进残留集');
  const injectedMixed = sandboxInventoryOf({
    'task-tools.js': mixedToolsJs + 'export const stray = (args, exec) => sessionOf(args, exec);\n',
  });
  assert.deepEqual(detectorViolationsOf(injectedMixed), ['task-tools.js:two-arg-in-wired-file x1'],
    '在册混合件上新增未接线点 ⇒ 判红');
  // ③ 未在册的混合件 ⇒ 按「零两参」严判（两处两参全数点名，不得静默放过）
  const unregisteredMixed = sandboxInventoryOf({ 'x-new.js': mixedToolsJs });
  assert.deepEqual(detectorViolationsOf(unregisteredMixed), ['x-new.js:two-arg-in-wired-file x2'],
    '未在册混合件 ⇒ 零容忍（严判）');
  // ④ 复原：注入点改回三参 ⇒ 违规清零（证判决非恒真、可逆）
  const restored = sandboxInventoryOf({
    'a-wired.js': wiredOnlyJs + 'export const stray = (args, exec, resolveBatchSession) => sessionOf(args, exec, resolveBatchSession);\n',
  });
  assert.deepEqual(detectorViolationsOf(restored), [], '注入点改三参 ⇒ 违规清零（判据非恒真）');
  // ⑤ 阴性对照一：**未接线**文件（零三参）⇒ 只进残留集、不判红（登记在册的既有事实）
  assert.deepEqual(detectorViolationsOf(clean), [], '纯未接线文件是登记在册残留 ⇒ 不判红');
  assert.deepEqual(unwiredCallSitesOf(clean), ['b-unwired.js x1'], '未接线调用点计数留档');
  // ⑥ 阴性对照二：**注释里的**两参字样不得被计入（去注释口径；`tier-gate.js` 实测坑）
  const commented = sandboxInventoryOf({ 'c-comment.js': commentedToolsJs });
  assert.deepEqual(detectorViolationsOf(commented), [], '注释里的两参字样不计入检测面');
  assert.deepEqual(twoArgResidualOf(commented), [], '注释里的两参字样不得把已接线文件误判成残留');
});

// ══ Q-C 派生化本体：仓内清单派生 + 旧硬编码清单失配登记（去过严侧假红，不削弱检测力）══════════
test('Q-C 派生化：残留清单现算（旧硬编码清单已失配）+ 检测力不削弱', () => {
  const inventory = toolsJsOf(path.join(PKG, 'lib', 'tools'));
  const residual = twoArgResidualOf(inventory);
  // ① 检测力：任一「已接线文件内新增两参调用点」/「残留文件引用 resolver 面」即红
  assert.deepEqual(detectorViolationsOf(inventory), [], '已接线文件不得回退两参 / 残留件不得引用 resolver 面');
  // ② 派生残留集：只有两参、零三参（现算，非清单）
  assert.deepEqual(residual, ['assign-tools.js', 'core.js', 'wave-plan-tools.js']);
  assert.equal(residual.length, 3, '残留文件数（现算）：' + residual.join(', '));
  // ③ **去过严侧**取证（两条）：旧硬编码清单的两项都不再是残留
  assert.equal(residual.includes('query-tools.js'), false, 'query-tools.js 已三参接线 ⇒ 旧清单第 1 项失配');
  assert.equal(residual.includes('tier-gate.js'), false, 'tier-gate.js 的两参只在**注释**里 ⇒ 旧清单第 4 项亦失配（去掉过严侧误报）');
  // ④ 三类分区自洽：已接线(零两参) / 混合既有形态（在册点数） / 未接线（残留集）
  const wired = wiredFilesOf(inventory);
  const mixed = wired.filter((f) => twoArgCallCount(inventory.find((x) => x.file === f).src) > 0);
  const pureWired = wired.filter((f) => !mixed.includes(f));
  assert.deepEqual(mixed, Object.keys(MIXED_LEGACY_TWO_ARG).sort(), '混合既有形态件须与在册登记逐字一致');
  assert.equal(pureWired.length, 8, '已接线且零两参的文件数（现算）：' + pureWired.join(', '));
  assert.equal(wired.length, 8 + Object.keys(MIXED_LEGACY_TWO_ARG).length, '已接线文件数 = 纯已接线 + 在册混合件');
  // ⑤ 未接线调用点**计数**留档（新增未接线调用点会让本行数字变 ⇒ 审计可见）
  assert.deepEqual(unwiredCallSitesOf(inventory), [
    'assign-tools.js x1', 'core.js x2', 'task-tools.js x2', 'wave-plan-tools.js x1',
  ]);
  // ⑥ 分区完备：已接线集 ∪ 残留集 = 全部含 `sessionOf` 调用的文件（集合相等、互斥无重复）
  const declare = inventory
    .filter((f) => twoArgCallCount(f.src) > 0 || thirdArgCallCount(f.src) > 0)
    .map((f) => f.file).sort();
  assert.deepEqual([...new Set([...wired, ...residual])].sort(), declare, '接线集 ∪ 残留集 = 声明集');
  assert.deepEqual(wired.filter((f) => residual.includes(f)), [], '两集互斥（同一文件不得既接线又残留）');
});
