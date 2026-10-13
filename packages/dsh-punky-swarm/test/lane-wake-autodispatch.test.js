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

// test/lane-wake-autodispatch.test.js —— 批 `swarm-report-wake-autodispatch-20261009` / lane `e01-impl`
//   的**实现判据套件**（甲：完成类唤醒；乙：主路并行订阅取 Leader 句柄；D-3 甲：只建议不派发）。
//
// 判据源 = `plan/survey-and-options.md`「## 待裁点回填」（用户 2026-10-09 裁定 D-1..D-5）：
//   · D-5 **甲**：新增 `type='completed'` 并纳入 `WAKE_TYPES`；**不触发结算**（与 `settle-request` 解耦）；
//     ⚠ 须同步扩 input schema `enum`，并核 output schema（`additionalProperties:false` 的真实假失败先例）。
//   · D-2 **甲**（准）：允许在 `subagent/end` 面**并行新增一路订阅**，附三条件
//     ① 仅取 Leader 句柄（`ctx.get('agents')`），**不取子句柄**；② **不改**既有 `onSubagentEnd` 结算逻辑；
//     ③ 新增订阅**独立**且 `dispose` 可热切。
//   · D-3 **甲**：引擎按 `poolViewOf()` 算「deps 已满足 + `owner===null` + lane `pending`」候选，
//     唤醒 Leader **并附候选清单**；**禁止**调用 `dispatchLaneCore` 真派。
//   · D-4 **乙**：本期**不补** `dispatch.provider`（不做真派发）。
//
// 读法（本仓纪律）：本文件只读 `lib/**`、只写 `test/**`；跑法**禁 `npm test`**（build 相位会重写 lib/*.js）：
//   node --import ./test/helpers/isolated-home.preload.mjs \
//        --import file:///<pkg>/test/helpers/host-dep-fallback.mjs --test test/lane-wake-autodispatch.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { apply } from '../lib/index.js';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { createCoreTools } from '../lib/tools/core.js';
import { WAKE_TYPES, LEADER_WAKE_WINDOWS, WAKE_MIN_INTERVAL_MS } from '../lib/tools/swarm-comms.js';
import { poolViewOf } from '../lib/tools/task-tools.js';
import { EVT_MEMBER_DISPATCH } from '../lib/state/event-types.js';
import { outputSchemaOf, schemaViolations } from './helpers/schema-conformance.mjs';
import { seedArtifactFile, SPEC_OK } from './helpers/gate-fixture.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(PKG, rel), 'utf8');
const reading = (tag, v) => console.log('[lane-wake] ' + tag + ' = ' + JSON.stringify(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LEADER = 'sess-leader';
const WORKER = 'ws-e2';

// ── 夹具：三层批（p1 / e1 / e2 / a1），e2 = 本批「正在执行」的 lane ──────────────────────────
//   池判据（`poolViewOf`）落点：`e1`（无 deps + owner null + lane pending）⇒ **可派发候选**；
//   `e2`（owner 非空 ⇒ 出池）；`a1`（deps=['e2'] 未终态 + lane pending）⇒ 有 blocker ⇒ **非候选**。
function seedLaneBatch(store, root, { batchId, workerSessionId = WORKER, leaderSession = LEADER } = {}) {
  const plan = buildWavePlan({
    batchId,
    tasks: [
      { id: 'p1', layer: 'plan', role: 'coordinator', cmd: 'plan 规格', produce: ['plan/spec.md'], outputs: ['plan/spec.md'], owner: leaderSession },
      { id: 'e1', layer: 'exec', role: 'coder', cmd: '待派实现', consume: ['plan/spec.md'], outputs: ['exec/e1.md'] },
      { id: 'e2', layer: 'exec', role: 'tester', cmd: '在跑验证', consume: ['plan/spec.md'], outputs: ['exec/e2.md'], owner: leaderSession },
      { id: 'a1', layer: 'audit', role: 'supervisor', cmd: '审计', deps: ['e2'], consume: ['plan/spec.md', 'exec/e2.md'] },
    ],
  });
  store.createBatch(leaderSession, { batchId, wavePlan: plan, phase: 'running' });
  // 产物**先于**成员态迁移落盘：`setMember(lane,'running')`（= 派发/开跑）会过 **entry 门**
  //   （exec/audit 的 `consume` 声明的产物须全部在场，否则 `GATE_ENTRY_MISSING`）。
  // spec 用 `SPEC_OK`（六项裸标题齐备）——与 `threeTierTasks` / `seedArtifacts` 同口径。
  seedArtifactFile(root, leaderSession, batchId, 'plan/spec.md', SPEC_OK);
  seedArtifactFile(root, leaderSession, batchId, 'exec/e2.md');
  seedArtifactFile(root, leaderSession, batchId, 'audit/a1.md');
  store.setMember(leaderSession, batchId, 'p1', 'running');
  store.setMember(leaderSession, batchId, 'e2', 'running');
  store.appendEvent(leaderSession, batchId, EVT_MEMBER_DISPATCH, { lane: 'e2', workerSessionId });
  return leaderSession;
}

/** 装配级 fake ctx：形状对齐 `test/helpers/gate-fixture.mjs#assemblyCtxOpts` + `get('agents')` 非注入读面。 */
function assemblyCtxOf({ agents } = {}) {
  const listeners = new Map();
  const calls = { info: [], warn: [], error: [] };
  const logger = {
    info: (...a) => calls.info.push(a.join(' ')),
    warn: (...a) => calls.warn.push(a.join(' ')),
    error: (...a) => calls.error.push(a.join(' ')),
  };
  return {
    listeners, calls, logger,
    tools: { register() {}, guard: () => () => {} },
    webServer: { register: () => () => {} },
    subagents: { start: async () => ({ id: 'w-stub', result: Promise.resolve({ output: [], stopReason: 'completed' }) }) },
    emit() {},
    get: (name) => (name === 'agents' ? agents : undefined),
    on(event, fn, opts) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add({ fn, opts });
      return () => { for (const e of listeners.get(event) ?? []) if (e.fn === fn) listeners.get(event).delete(e); };
    },
  };
}

/** 桩 Leader 句柄（记录 `followup` 入参；零宿主依赖）。 */
function stubLeader() {
  const messages = [];
  return { status: 'idle', messages, followup(msg) { messages.push(msg); this.status = 'running'; } };
}

const agentsOf = (leader) => ({ get: (id) => (id === LEADER ? leader : undefined) });

/** 主路回调调用面（同 `auto-settle.test.js:71-73`）：逐个 listener 调用，模拟宿主 `subagent/end` 广播。 */
async function emitSubagentEnd(ctx, info) {
  for (const { fn } of [...(ctx.listeners.get('subagent/end') ?? [])]) await fn(info);
}
const endInfoOf = (id, stopReason = 'completed') => ({ runId: 'run-' + id, provider: 'spawn', id, local: false, stopReason });

const batchEvents = (store, batchId) => (store.readBatch(LEADER, batchId)?.events ?? []);

/** 装配一个真 `apply()` 的批次夹具（真 store + 真插件装配，仅 ctx 为桩）。 */
async function mountAssembly({ batchId, agents, label }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-lanewake-' + label + '-'));
  const store = createStore(root);
  seedLaneBatch(store, root, { batchId });
  const ctx = assemblyCtxOf({ agents });
  const disposer = apply(ctx, { root });
  await sleep(60);
  return { root, store, ctx, disposer, batchId };
}

// ══════════════════════════════════════════════════════════════════════════════
// 甲（D-5 甲）：`type='completed'` 纳入唤醒集、**不触发结算**、schema 同步
// ══════════════════════════════════════════════════════════════════════════════
test('甲-1 (D-5甲)：`WAKE_TYPES` 含 `completed`；`swarm_report` input schema `enum` 同步扩（不改 progress 语义）', async () => {
  reading('甲-1 WAKE_TYPES', [...WAKE_TYPES]);
  assert.equal(WAKE_TYPES.has('completed'), true, 'D-5甲：完成类纳入唤醒触发集');
  assert.equal(WAKE_TYPES.has('progress'), false, 'Q-2 逐字不变：progress 保持「留痕不打扰」');
  assert.equal(WAKE_TYPES.has('blocked'), true, '既有成员不回归');
  assert.equal(WAKE_TYPES.has('settle-request'), true, '既有成员不回归');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-lanewake-schema-'));
  const store = createStore(root);
  const tools = createCoreTools(assemblyCtxOf({}), { store, root, config: {} });
  const rep = tools.find((t) => t.name === 'swarm_report');
  const enumVals = rep.parameters?.properties?.type?.enum ?? rep.parameters?.type?.enum ?? [];
  reading('甲-1 swarm_report type enum', enumVals);
  assert.deepEqual([...enumVals].sort(), ['blocked', 'completed', 'progress', 'settle-request'],
    'D-5甲：input schema `enum` 须同步扩（漏改即宿主侧参数面拒收）');
});

test('甲-2 (D-5甲)：`swarm_report(completed)` ⇒ 唤醒 + 留痕双写，**不结算**（与 settle-request 解耦）', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const leader = stubLeader();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-lanewake-done-'));
  const store = createStore(root);
  const batchId = 'b-done';
  seedLaneBatch(store, root, { batchId });
  const ctx = assemblyCtxOf({ agents: agentsOf(leader) });
  const rep = createCoreTools(ctx, { store, root, config: {} }).find((t) => t.name === 'swarm_report');

  const before = batchEvents(store, batchId).length;
  const out = await rep.execute({ type: 'completed', summary: 'lane e2 完成', lane: 'e2' }, { agent: { session: { id: WORKER } } });
  reading('甲-2 返回值', out);
  reading('甲-2 followup 次数', leader.messages.length);

  assert.equal(out.delivered, true, '留痕双写面不变：消息投递');
  assert.equal(out.eventWritten, true, '留痕双写面不变：批事件');
  assert.equal(out.wake.woke, true, 'D-5甲：completed ⇒ 唤醒路径被触发');
  assert.equal(out.wake.reason, 'woke');
  assert.equal(leader.messages.length, 1, '唤醒动作唯一 = followup 恰 1 次');
  assert.equal(out.settle, undefined, 'D-5甲：**不触发结算**（解耦；返回值无 settle 键）');
  assert.equal(store.readBatch(LEADER, batchId).lanes.e2, 'running', '不结算 ⇒ lane 状态不动（仍 running）');
  assert.equal(batchEvents(store, batchId).length, before + 1, '零自增：仅在既有 `swarm.report` 上 +1');
  assert.equal(batchEvents(store, batchId).filter((e) => String(e.type).startsWith('auto.settle')).length, 0,
    'D-5甲：completed 不产生任何 auto.settle.* 留痕');
});

test('甲-3 (D-5甲 · 回归锁)：`progress` 仍不唤醒；返回值过自身 output.schema（additionalProperties:false 面）', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const leader = stubLeader();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-lanewake-prog-'));
  const store = createStore(root);
  const batchId = 'b-prog';
  seedLaneBatch(store, root, { batchId });
  const ctx = assemblyCtxOf({ agents: agentsOf(leader) });
  const rep = createCoreTools(ctx, { store, root, config: {} }).find((t) => t.name === 'swarm_report');

  const prog = await rep.execute({ type: 'progress', summary: '进度 50%', lane: 'e2' }, { agent: { session: { id: WORKER } } });
  reading('甲-3 progress', prog.wake);
  assert.equal(prog.wake.reason, 'type-not-in-wake-set', 'progress 仍不打扰（Q-2 逐字不变）');
  assert.equal(leader.messages.length, 0, '零 followup');
  assert.deepEqual(schemaViolations(prog, outputSchemaOf(rep)), [],
    '返回值须满足自身 output.schema（宿主 `invalid output` 假失败面）');

  const done = await rep.execute({ type: 'completed', summary: '完成', lane: 'e2' }, { agent: { session: { id: WORKER } } });
  assert.deepEqual(schemaViolations(done, outputSchemaOf(rep)), [],
    'completed 形态同样须过 output.schema（本仓 `additionalProperties:false` 真实先例）');
});

// ══════════════════════════════════════════════════════════════════════════════
// 乙（D-2 甲）：主路并行订阅 —— 独立、{global:true}、取 Leader 句柄、不改既有结算路
// ══════════════════════════════════════════════════════════════════════════════
test('乙-1 (D-2甲 条件③)：装配后 `subagent/end` 面**并行两路**订阅，各自独立且均 `{global:true}`', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const leader = stubLeader();
  const m = await mountAssembly({ batchId: 'b-two', agents: agentsOf(leader), label: 'two' });
  try {
    const hooks = [...(m.ctx.listeners.get('subagent/end') ?? [])];
    reading('乙-1 subagent/end 订阅条数', hooks.length);
    reading('乙-1 opts', hooks.map((h) => h.opts));
    assert.equal(hooks.length, 2, 'D-2甲：主路**并行新增一路**订阅（结算路 + 唤醒路，各自独立）');
    for (const h of hooks) assert.deepEqual(h.opts, { global: true }, '两路均须带 {global:true}（scope 化 ctx 默认漏收）');
    assert.notEqual(hooks[0].fn, hooks[1].fn, '两路是不同回调（新增订阅**独立**，非在结算回调内联）');
  } finally { m.disposer(); }
});

test('乙-2 (D-2甲 + D-3甲)：命中 lane 的 `subagent/end` ⇒ 唤醒 Leader 并**附可派发候选清单**', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const leader = stubLeader();
  const m = await mountAssembly({ batchId: 'b-wake', agents: agentsOf(leader), label: 'wake' });
  try {
    // ⚠ 归因纪律：本条**只调唤醒路那一个 listener**（`hooks[1]`；`hooks[0]` = 结算路，`乙-1` 已证两路独立）。
    //   理由：两路在同一事件上并行，「零批面写」只有**单路调用**才可归因——整轮各调一次会把结算路的
    //   `auto.settle.*` / `member.settled` 记到唤醒路头上（假红）。结算路不受影响的判据见 `乙-3`。
    const hooks = [...(m.ctx.listeners.get('subagent/end') ?? [])];
    assert.equal(hooks.length, 2, '前置：两路订阅在场');
    const eventsBefore = batchEvents(m.store, m.batchId).length;
    await hooks[1].fn(endInfoOf(WORKER));
    await sleep(20);
    reading('乙-2 唤醒消息', leader.messages[0]?.content?.[0]?.text ?? null);

    assert.equal(leader.messages.length, 1, '命中 lane 的完成事实 ⇒ 唤醒恰 1 次（不依赖 worker 自觉回报）');
    const text = leader.messages[0].content[0].text;
    assert.ok(text.startsWith('[swarm] b-wake/e2 completed：'), '消息首行 = 元数据摘要（批/lane/终态）；实测=' + text);
    assert.ok(text.includes('可派发候选'), 'D-3甲：唤醒须**附候选清单**（引擎只建议）');

    // 候选面 = `poolViewOf()` 同一判据的**活体读数**（此处 lane 态未被结算路改动 ⇒ 期望值可确定性算出）。
    const view = poolViewOf(m.store.readBatch(LEADER, m.batchId));
    const expected = view.pool.filter((t) => t.dispatchable).map((t) => t.id);
    const blocked = view.pool.filter((t) => !t.dispatchable).map((t) => t.id);
    const listed = (text.split('可派发候选（引擎只建议，派发仍由 Leader 决定）：')[1] ?? '').split('\n')[0].split(', ').filter(Boolean);
    reading('乙-2 候选读数', { expected, blocked, listed });
    assert.ok(expected.includes('e1'), '前置：e1（deps 已满足 + owner null + lane pending）应可派发');
    assert.ok(blocked.includes('a1'), '前置：a1（deps e2 未终态）应被 blocker 拦下 —— 负控非空转');
    assert.deepEqual(listed, expected, '候选清单 = `poolViewOf` 判为可派发的 lane id 集（**单点判据**，无第二套口径）');
    assert.equal(listed.includes('a1'), false, '候选**不含** blocker 未清者（a1）—— 负控成立');

    assert.equal(batchEvents(m.store, m.batchId).length, eventsBefore, '唤醒路**零批面写**（不落事件）');
    assert.equal(m.store.readBatch(LEADER, m.batchId).lanes.e2, 'running', '不改成员状态（唤醒 ≠ 结算）');
    const e1 = m.store.readBatch(LEADER, m.batchId).wavePlan.flatMap((w) => w.tasks).find((t) => t.id === 'e1');
    assert.equal(e1.owner ?? null, null, 'D-3甲：**不派发** —— 候选 lane 的 owner 仍为空（派发归 Leader 单点）');
  } finally { m.disposer(); }
});

test('乙-3 (D-2甲 条件②)：结算主路逐字不变 —— 同一事件仍走既有判定（completed ⇒ lane 仍被结算到 review/merged 路）', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const leader = stubLeader();
  const m = await mountAssembly({ batchId: 'b-settle', agents: agentsOf(leader), label: 'settle' });
  try {
    const before = batchEvents(m.store, m.batchId).filter((e) => String(e.type).startsWith('auto.settle')).length;
    await emitSubagentEnd(m.ctx, endInfoOf(WORKER));
    await sleep(40);
    const after = batchEvents(m.store, m.batchId).filter((e) => String(e.type).startsWith('auto.settle'));
    reading('乙-3 auto.settle.* 增量', { before, after: after.map((e) => e.type + ':' + String(e.reason ?? '')) });
    assert.ok(after.length > before, '既有结算路仍在同一事件上生效（新增订阅未顶掉它）');
    assert.equal(batchEvents(m.store, m.batchId).filter((e) => e.type === 'swarm.report').length, 0,
      '唤醒路径不写 `swarm.report`（不自构成触发源、不放大留痕）');
  } finally { m.disposer(); }
});

test('乙-4 (契约 §1.1)：未命中 dispatchIndex ⇒ 静默丢弃（进程级广播夹带非本套件子会话）', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const leader = stubLeader();
  const m = await mountAssembly({ batchId: 'b-miss', agents: agentsOf(leader), label: 'miss' });
  try {
    await emitSubagentEnd(m.ctx, endInfoOf('ws-not-ours'));
    await sleep(20);
    reading('乙-4 未知子会话', { followupCalls: leader.messages.length, status: leader.status });
    assert.equal(leader.messages.length, 0, '未命中 ⇒ 零唤醒（零事件零状态变化）');
    assert.equal(leader.status, 'idle', 'Leader 保持 idle');
  } finally { m.disposer(); }
});

test('乙-5 (J-6/J-9 复用)：Leader 句柄取不到（服务缺失）⇒ 不抛、零唤醒；self 构造（id === Leader 会话）⇒ 零唤醒', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const noSvc = await mountAssembly({ batchId: 'b-nosvc', agents: undefined, label: 'nosvc' });
  try {
    let thrown = null;
    try { await emitSubagentEnd(noSvc.ctx, endInfoOf(WORKER)); } catch (e) { thrown = String(e?.message ?? e); }
    reading('乙-5 服务缺失', { thrown });
    assert.equal(thrown, null, '服务缺失 ⇒ 唤醒路 fail-safe（永不外抛）');
  } finally { noSvc.disposer(); }

  LEADER_WAKE_WINDOWS.clear();
  const leader = stubLeader();
  const self = await mountAssembly({ batchId: 'b-self', agents: agentsOf(leader), label: 'self' });
  try {
    // self 构造：dispatchIndex 命中的 workerSessionId 恰 = Leader 会话（本批自派形态）
    self.store.appendEvent(LEADER, 'b-self', EVT_MEMBER_DISPATCH, { lane: 'e2', workerSessionId: LEADER });
    await emitSubagentEnd(self.ctx, endInfoOf(LEADER));
    await sleep(20);
    reading('乙-5 self 闸', { followupCalls: leader.messages.length });
    assert.equal(leader.messages.length, 0, 'self 闸：不得唤醒自己（零自激）');
  } finally { self.disposer(); }
});

test('乙-6 (复用既有节流)：同批同 Leader 窗内多 worker 完成 ⇒ 唤醒恰 1 次（禁第二套节流口径）', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const leader = stubLeader();
  const m = await mountAssembly({ batchId: 'b-throttle', agents: agentsOf(leader), label: 'throttle' });
  try {
    m.store.appendEvent(LEADER, 'b-throttle', EVT_MEMBER_DISPATCH, { lane: 'e2', workerSessionId: 'ws-e2b' });
    await emitSubagentEnd(m.ctx, endInfoOf(WORKER));
    await emitSubagentEnd(m.ctx, endInfoOf('ws-e2b'));
    await sleep(20);
    reading('乙-6 窗内两 worker', { followupCalls: leader.messages.length, windows: [...LEADER_WAKE_WINDOWS.keys()] });
    assert.equal(leader.messages.length, 1, '窗内（30s）合并 ⇒ 唤醒 ≤ ⌈跨度/W⌉+1 = 1（与完成条数解耦）');
    assert.equal(WAKE_MIN_INTERVAL_MS, 30_000, '节流口径 = 既有单点常量（未另写第二套）');
  } finally { m.disposer(); }
});

test('乙-7 (D-2甲 条件①/② 静态面)：`lib/index.js` 不引用 `dispatchLaneCore`；`auto-settle.js` 未被改动为唤醒路', () => {
  const indexSrc = read('lib/index.js');
  const settleSrc = read('lib/engine/auto-settle.js');
  assert.equal(indexSrc.includes('dispatchLaneCore('), false,
    'D-3甲：**禁止调用 `dispatchLaneCore` 真派**（只建议不派发；判定式为调用点 `(` 形态，注释里的点名不算）');
  for (const needle of ['wakeLeaderForReport', 'poolViewOf', 'leaderWake']) {
    assert.equal(settleSrc.includes(needle), false,
      'D-2甲 条件②：结算主路（`lib/engine/auto-settle.js`）不得被改造成唤醒路（实测命中 ' + needle + '）');
  }
  assert.ok(read('lib/tools/swarm-comms.js').includes('2026-10-09') && read('lib/tools/swarm-comms.js').includes('D-2'),
    'D-2甲：J-4 旧句须**改注**（标废而非删）并引 2026-10-09 裁定 D-2 甲');
});

test('乙-8 (验收② 净增 0)：导出面 / 事件常量 / `GATE_*` 码净增 = 0', () => {
  const exportNamesOf = (src) => [...src.matchAll(/^export\s+(?:const|function|class|let)\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]).sort();
  reading('乙-8 导出面', {
    'lib/index.js': exportNamesOf(read('lib/index.js')),
    'lib/tools/swarm-comms.js': exportNamesOf(read('lib/tools/swarm-comms.js')),
    'lib/tools/swarm-tools.js': exportNamesOf(read('lib/tools/swarm-tools.js')),
  });
  assert.deepEqual(exportNamesOf(read('lib/index.js')), ['apply', 'inject', 'name'], '装配入口导出面逐字不变');
  // 【跨批登记 · 批次 `d-override-fix-20261011` / lane `e3-tests`】导出面多出 `budgetSummaryForReport`：
  //   该薄壳由**前序批次** `punky-spec-adopt-l1l2-20261011`（注入预算面）加入 `lib/tools/swarm-comms.js`，
  //   并由 `lib/tools/swarm-tools.js:60` 真实消费（`swarm_report` 的 summary 预算）⇒ 属另一次已收口改造的
  //   合法新增；**本批零触碰该文件**（`git status` 的 M 项为前序 lane 遗留）。同符号已在该前序批次的
  //   `test/swarm-wake-addressing.test.js:609` 自己的冻结清单里登记 ⇒ 本处属**遗留未同步**。
  //   断言强度不降：仍为逐字 `deepEqual` 冻结（增删任一符号即红），只是把存量事实如实入册。
  assert.deepEqual(exportNamesOf(read('lib/tools/swarm-comms.js')),
    ['LEADER_WAKE_WINDOWS', 'UNBOUND_BATCH_KEY', 'WAKE_MIN_INTERVAL_MS', 'WAKE_TYPES',
      'appendSwarmEventOf', 'budgetSummaryForReport', 'deliverSwarmMessage', 'reportTargetOf', 'wakeLeaderForReport'],
    '唤醒单点模块导出面冻结（乙路净增 0 + 跨批如实登记 1：budgetSummaryForReport）');
  assert.deepEqual(exportNamesOf(read('lib/tools/swarm-tools.js')), ['buildSwarmTools'], '工具面导出净增 0');
  // 事件常量/门禁码：本改造**零新增**（唤醒路不落任何事件；completed 复用既有 `swarm.report`）
  const evtSrc = read('lib/state/event-types.js');
  assert.equal(evtSrc.includes('swarm.wake'), false, '不新增唤醒类事件常量');
  // 装配段 `GATE_*` 码面冻结锁（既有词表）：[GATE_ENABLED]（环境变量名，非门禁码）
  const gateTokens = [...new Set(read('lib/index.js').match(/GATE_[A-Z0-9_]+/g) ?? [])].sort();
  assert.deepEqual(gateTokens, ['GATE_ENABLED'], '装配段不新增任何 `GATE_*` 码（净增 0）');
});

// ══════════════════════════════════════════════════════════════════════════════
// ⑩ 真宿主加载冒烟（#10）：真 cordis Context + **真插件入口** `lib/index.js` + 真事件投递
//    （宿主核心包根不可解析 ⇒ 本组 skip；其余各组的判据不因此静默失效）
// ══════════════════════════════════════════════════════════════════════════════
const HOST_ROOT_CANDIDATES = [
  process.env.DSH_CORE_ROOT,
  'D:/Program Files/npm-global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
];
function resolveHostRoot() {
  for (const root of HOST_ROOT_CANDIDATES) {
    if (!root) continue;
    try { if (fs.existsSync(path.join(root, 'cordis', 'lib', 'index.js'))) return root; } catch { /* 继续 */ }
  }
  return null;
}
const HOST_ROOT = resolveHostRoot();
const loadHost = (pkg) => import(pathToFileURL(path.join(HOST_ROOT, pkg, 'lib', 'index.js')).href);

test('⑩ HOST：真宿主加载 —— 真 cordis Context 装载真插件入口，`subagent/end` 真投递 ⇒ 真唤醒',
  { skip: HOST_ROOT === null && '宿主核心包根不可解析（需含 cordis 的 dsh 发行目录）⇒ 本组 skip' }, async () => {
    LEADER_WAKE_WINDOWS.clear();
    const { Context } = await loadHost('cordis');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-lanewake-host-'));
    const store = createStore(root);
    const batchId = 'b-host';
    seedLaneBatch(store, root, { batchId });

    const leader = stubLeader();
    const app = new Context();
    app.provide('tools', { register() {}, guard: () => () => {} });
    app.provide('webServer', { register: () => () => {} });
    app.provide('subagents', { start: async () => ({ id: 'w-host', result: Promise.resolve({ output: [], stopReason: 'completed' }) }) });
    app.provide('agents', agentsOf(leader));

    const plugin = await import(pathToFileURL(path.join(PKG, 'lib', 'index.js')).href);
    let thrown = null;
    let fiber = null;
    try { fiber = await app.plugin(plugin, { root }); } catch (e) { thrown = String(e?.message ?? e); }
    reading('⑩ 真宿主装载', { thrown, fiberState: fiber?.state ?? null, hostRoot: HOST_ROOT, inject: plugin.inject });

    assert.equal(thrown, null, '真宿主插件生命周期装载不得抛错（RED 对照：缺能力时本组的行为断言全灭）');
    // cordis `FiberState`：`state = 2` = ACTIVE（`cordis/lib/index.js:1105` 置 2；0=idle/待载、3=FAILED、4=DISPOSED）
    assert.equal(fiber?.state, 2, 'fiber 处于 ACTIVE（真宿主加载完成，非仅 node --check）');
    assert.equal(typeof fiber?.ctx?.on, 'function', 'fiber ctx 可用（真宿主上下文）');
    assert.equal(typeof app.get('agents'), 'object', '宿主服务面就绪（leader 句柄可解析）');

    // 真投递：从**根 ctx** 发宿主 `subagent/end`（事件名 = 引擎既有契约 `AUTO_SETTLE_SUBAGENT_END`）
    app.emit('subagent/end', endInfoOf(WORKER));
    await sleep(120);
    const wakeText = leader.messages[0]?.content?.[0]?.text ?? null;
    reading('⑩ 真链路唤醒读数', { followupCalls: leader.messages.length, wakeText });

    assert.equal(leader.messages.length, 1, '真宿主链路上：完成类事件 ⇒ Leader 被唤醒（新增能力的可观测效果）');
    assert.ok(String(wakeText).startsWith('[swarm] b-host/e2 '), '唤醒消息 = 摘要元数据（批/lane）');
    assert.ok(String(wakeText).includes('可派发候选'), 'D-3甲：候选清单在真链路上同样附上');
    assert.equal(fiber.ctx.get('agents'), app.get('agents'), '唤醒取的是**Leader 句柄**（父会话，经 ctx.get 非注入读 J-6）');
    fiber?.dispose?.();
  });
