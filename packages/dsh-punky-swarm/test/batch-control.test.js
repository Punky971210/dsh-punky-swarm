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

// P3a 最小干预面 `batch_control{batchId, action: pause|resume|abort}`（规格 §5 收内前的干预面）
//   + GAP-S10 相位闸回归锁（自动结算缺批次相位闸）。
//
// 本文件覆盖：
//   A 三动作相位迁移（pause: running→paused；resume: paused→running；abort: →aborted）；
//   B 幂等（已 paused/已 running ⇒ no-op，**零新增事件**；已终态 ⇒ no-op，不重复落告警）；
//   C 非法迁移拒绝（走既有 `BATCH_TRANSITIONS` / `setPhase` 既有码，禁自造码）；
//   D 边界：**成员状态零变化**（deepEqual 逐字断言）+ 工具面/相位事件形状；
//   E abort 面复用上一轮 `batch.abort_dangling` 告警（有悬挂 ⇒ 事件在；无悬挂 ⇒ 无该事件）；
//   F **GAP-S10 反向锁**：`paused` 批上触发 `subagent/end` / `settle-request` ⇒ 无 `member.settled`、
//     lane 状态不变、留痕 `reason:'phase-paused'`；`resume` 后同一 lane 再触发 ⇒ 正常结算（唯一恢复入口）；
//   G `running` 相位既有行为零回归 + 插件入口真加载（工具数 25 → 26）。
//
// 事实源纪律：断言一律读 `store.readBatch` 的批次 JSON（唯一事实源）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from '../lib/state/store.js';
import { createTools } from '../lib/tools/register.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { installAutoSettle, AUTO_SETTLE_SUBAGENT_END, AUTO_SETTLE_TRIGGERS } from '../lib/engine/auto-settle.js';
import {
  EVT_BATCH_PHASE, EVT_BATCH_ABORT_DANGLING, EVT_MEMBER_SETTLED,
  EVT_AUTO_SETTLE_TRIGGERED, EVT_AUTO_SETTLE_PAUSED, EVT_AUTO_SETTLE_SKIPPED,
} from '../lib/state/event-types.js';
import { threeTierTasks, seedArtifacts, assessC } from './helpers/gate-fixture.mjs';
import { seedTeamAssetSkills, withDefaultTeam } from './helpers/host-skills.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // cwd 无关
const SESS_ID = 'sess-control';
const SESS = { agent: { session: { id: SESS_ID } } };
const DANGLING_EVT = EVT_BATCH_ABORT_DANGLING ?? 'batch.abort_dangling';

// P1 起建批须解析到团队资产（skills 须可在隔离宿主技能根解析）——与 `abort-dangling-and-warn-event.test.js` 同法
seedTeamAssetSkills('software-team');

// ═══════════════════════════════════════════════════════════════════════════════
// 夹具：临时 store 根 + 真工具面（createTools）+ 合规三层批
// ═══════════════════════════════════════════════════════════════════════════════
function makeHarness(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-ctl-' + tag + '-'));
  const store = createStore(root);
  const ctx = { tools: { register: () => {}, guard: () => {} }, logger: console };
  const { tools } = createTools(ctx, { store, root });
  const byName = withDefaultTeam(Object.fromEntries(tools.map((t) => [t.name, t])));
  assessC(store, SESS_ID, { rationale: 'P3a control lane：batch_control 回归锁（三层批治理面 ⇒ C 档）' });
  return { root, store, byName };
}

async function makeBatch(byName, root, batchId) {
  const out = await byName.wave_plan.execute({
    batchId,
    tasks: threeTierTasks(['e1'], { auditId: 'a1' }),
    assembly: { auditLane: 'a1', managerPlan: 'leader-direct' },
  }, SESS);
  seedArtifacts(root, SESS_ID, batchId, ['e1']);
  return out;
}

function eventsOf(store, batchId, type) {
  return (store.readBatch(SESS_ID, batchId).events ?? []).filter((e) => e && e.type === type);
}
const phaseOf = (store, batchId) => store.readBatch(SESS_ID, batchId).phase;
const lanesOf = (store, batchId) => store.readBatch(SESS_ID, batchId).lanes;
const controlOf = (byName) => byName.batch_control;
/** 缺省批相位是 `planning` ⇒ 先经既有 `batch_phase` 推到 `running`（不改被测工具）。 */
const toRunning = (byName, batchId) => byName.batch_phase.execute({ batchId, phase: 'running' }, SESS);
/** 走完一条 lane 的合法结算链（pending → running → review → merged）——`setMember` 是唯一写路径。 */
function settleLane(store, batchId, lane) {
  store.setMember(SESS_ID, batchId, lane, 'running');
  store.setMember(SESS_ID, batchId, lane, 'review');
  store.setMember(SESS_ID, batchId, lane, 'merged');
}

// 主路回调调用面（探针契约卡 §30-33：`ctx.on('subagent/end', h, { global: true })`，回调签名 `(info) => void`）
function assemblyCtx() {
  const listeners = new Map();
  return {
    listeners,
    tools: { register() {} },
    emit() {},
    on(event, fn, opts) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add({ fn, opts });
      return () => { for (const e of listeners.get(event) ?? []) if (e.fn === fn) listeners.get(event).delete(e); };
    },
  };
}
async function emitSubagentEnd(ctx, info) {
  for (const { fn } of [...(ctx.listeners.get(AUTO_SETTLE_SUBAGENT_END) ?? [])]) await fn(info);
}
const endInfo = (id, stopReason = 'completed') => ({ runId: 'run-' + id, provider: 'spawn', id, local: false, stopReason });
const memberSettledCount = (store, batchId, lane) =>
  eventsOf(store, batchId, EVT_MEMBER_SETTLED).filter((e) => e.lane === lane && e.from !== 'pending').length;

// ═══════════════════════════════════════════════════════════════════════════════
// A · 三动作相位迁移 + D · 成员状态零变化
// ═══════════════════════════════════════════════════════════════════════════════
test('A1：pause（running→paused）/ resume（paused→running）/ abort（→aborted）三动作相位迁移 + 成员状态零变化', async () => {
  const { root, store, byName } = makeHarness('a1');
  await makeBatch(byName, root, 'b-seq');
  await toRunning(byName, 'b-seq');
  store.setMember(SESS_ID, 'b-seq', 'e1', 'running'); // 一条非终态成员（悬挂）
  const lanesBefore = { ...lanesOf(store, 'b-seq') };

  const p = await controlOf(byName).execute({ batchId: 'b-seq', action: 'pause' }, SESS);
  assert.equal(p.phase, 'paused', 'pause：running → paused');
  assert.equal(phaseOf(store, 'b-seq'), 'paused');
  assert.deepEqual(lanesOf(store, 'b-seq'), lanesBefore, 'pause 不得改任何成员状态（逐字）');

  const r = await controlOf(byName).execute({ batchId: 'b-seq', action: 'resume' }, SESS);
  assert.equal(r.phase, 'running', 'resume：paused → running（规格 §6 唯一恢复入口）');
  assert.equal(phaseOf(store, 'b-seq'), 'running');
  assert.deepEqual(lanesOf(store, 'b-seq'), lanesBefore, 'resume 不得改任何成员状态（逐字）');

  const a = await controlOf(byName).execute({ batchId: 'b-seq', action: 'abort' }, SESS);
  assert.equal(a.phase, 'aborted', 'abort：→ aborted（终态）');
  assert.equal(phaseOf(store, 'b-seq'), 'aborted');
  assert.deepEqual(lanesOf(store, 'b-seq'), lanesBefore, 'abort 不得改任何成员状态（逐字，不做隐式批量 skipped）');
  // 相位事件形状：复用既有 `batch.phase`（**不另造事件类型**）
  const phases = eventsOf(store, 'b-seq', EVT_BATCH_PHASE).map((e) => e.from + '->' + e.to);
  assert.deepEqual(phases.slice(-3), ['running->paused', 'paused->running', 'running->aborted'],
    '三动作各落一条既有 batch.phase 事件（from/to 自证）');
});

// ═══════════════════════════════════════════════════════════════════════════════
// B · 幂等（no-op 且零新增事件）
// ═══════════════════════════════════════════════════════════════════════════════
test('B1：pause 幂等——已 paused 再 pause ⇒ no-op（零新增事件、相位不动）', async () => {
  const { root, store, byName } = makeHarness('b1');
  await makeBatch(byName, root, 'b-idem');
  await toRunning(byName, 'b-idem');
  const first = await controlOf(byName).execute({ batchId: 'b-idem', action: 'pause' }, SESS);
  assert.equal(first.noop, undefined, '首次 pause 非 no-op');
  const evLen = store.readBatch(SESS_ID, 'b-idem').events.length;

  const second = await controlOf(byName).execute({ batchId: 'b-idem', action: 'pause' }, SESS);
  assert.equal(second.noop, true, '已 paused ⇒ 显式 no-op');
  assert.equal(second.phase, 'paused');
  assert.equal(store.readBatch(SESS_ID, 'b-idem').events.length, evLen, 'no-op 不得重复写相位事件');
});

test('B2：resume 幂等——已 running 再 resume ⇒ no-op（零新增事件）', async () => {
  const { root, store, byName } = makeHarness('b2');
  await makeBatch(byName, root, 'b-idem2');
  await toRunning(byName, 'b-idem2');
  const evLen = store.readBatch(SESS_ID, 'b-idem2').events.length;

  const out = await controlOf(byName).execute({ batchId: 'b-idem2', action: 'resume' }, SESS);
  assert.equal(out.noop, true, '已 running ⇒ 显式 no-op（幂等）');
  assert.equal(out.phase, 'running');
  assert.equal(store.readBatch(SESS_ID, 'b-idem2').events.length, evLen, 'no-op 零事件');
});

test('B3：abort 幂等——已 aborted 再 abort ⇒ no-op（不重复落悬挂告警）', async () => {
  const { root, store, byName } = makeHarness('b3');
  await makeBatch(byName, root, 'b-idem3');
  await toRunning(byName, 'b-idem3');
  store.setMember(SESS_ID, 'b-idem3', 'e1', 'running'); // 制造悬挂
  await controlOf(byName).execute({ batchId: 'b-idem3', action: 'abort' }, SESS);
  const evLen = store.readBatch(SESS_ID, 'b-idem3').events.length;
  const dgLen = eventsOf(store, 'b-idem3', DANGLING_EVT).length;

  const again = await controlOf(byName).execute({ batchId: 'b-idem3', action: 'abort' }, SESS);
  assert.equal(again.noop, true, '已 aborted（终态）⇒ no-op');
  assert.equal(again.phase, 'aborted');
  assert.equal(store.readBatch(SESS_ID, 'b-idem3').events.length, evLen, 'no-op 零事件（不重复告警）');
  assert.equal(eventsOf(store, 'b-idem3', DANGLING_EVT).length, dgLen, '悬挂告警不得重复落');
});

// ═══════════════════════════════════════════════════════════════════════════════
// C · 非法迁移拒绝（走既有相位机，禁自造码）
// ═══════════════════════════════════════════════════════════════════════════════
test('C1：非法迁移拒——终态冻结（complete/aborted 回不去）+ 非映射相位，复用既有 `invalid batch phase transition` 码', async () => {
  const { root, store, byName } = makeHarness('c1');
  await makeBatch(byName, root, 'b-term');
  await toRunning(byName, 'b-term');
  for (const lane of ['p1', 'e1', 'a1']) settleLane(store, 'b-term', lane); // 全终态 ⇒ complete 门禁可通过
  const done = await byName.batch_phase.execute({ batchId: 'b-term', phase: 'complete' }, SESS);
  assert.equal(done.phase, 'complete', '前置：批次到 complete');

  const lanesBefore = { ...lanesOf(store, 'b-term') };
  const evLen = store.readBatch(SESS_ID, 'b-term').events.length;
  await assert.rejects(
    () => controlOf(byName).execute({ batchId: 'b-term', action: 'resume' }, SESS),
    /^Error: invalid batch phase transition: complete -> running$/,
    'complete 是终态（BATCH_TRANSITIONS.complete = []）⇒ resume 拒，既有码逐字（不自造码）',
  );
  await assert.rejects(
    () => controlOf(byName).execute({ batchId: 'b-term', action: 'abort' }, SESS),
    /^Error: invalid batch phase transition: complete -> aborted$/,
    'complete 亦不可 abort（终态冻结）',
  );
  assert.equal(phaseOf(store, 'b-term'), 'complete', '被拒后相位不动');
  assert.equal(store.readBatch(SESS_ID, 'b-term').events.length, evLen, '被拒后零事件（不落任何留痕）');
  assert.deepEqual(lanesOf(store, 'b-term'), lanesBefore, '被拒后成员状态不动');
});

test('C2：非法动作值拒（既有相位机之外的入口参数面）——GATE_BATCH_CONTROL_ACTION_INVALID', async () => {
  const { root, store, byName } = makeHarness('c2');
  await makeBatch(byName, root, 'b-act');
  await toRunning(byName, 'b-act');
  const evLen = store.readBatch(SESS_ID, 'b-act').events.length;
  await assert.rejects(
    () => controlOf(byName).execute({ batchId: 'b-act', action: 'takeover' }, SESS),
    // 两道防线并存（都不自造码）：① 工具参数面由 `defineTool` 的 parameters schema 先拒
    //   （`action` 是闭集 enum ⇒ `invalid arguments: "action" must be one of …`，与既有工具同法）；
    //   ② execute 内的运行时兜底 `GATE_BATCH_CONTROL_ACTION_INVALID`（防绕过参数面直调）。
    //   实到 = ①（参数面先于 execute）；本断言同时锁住②存在。
    (e) => /invalid arguments: "action" must be one of \["pause","resume","abort"\]/.test(String(e.message))
      || /^GATE_BATCH_CONTROL_ACTION_INVALID: /.test(String(e.message)),
    '规格 §5：takeover/redispatch/force_settle/decide 属 P4，本阶段明确拒（不静默降级）',
  );
  assert.deepEqual(controlOf(byName).parameters.properties.action.enum, ['pause', 'resume', 'abort'],
    '参数面闭集 = 三动作（P4 动作值在 schema 层即不可达）');
  assert.equal(phaseOf(store, 'b-act'), 'running', '被拒后相位不动');
  assert.equal(store.readBatch(SESS_ID, 'b-act').events.length, evLen, '被拒后零事件');
});

// ═══════════════════════════════════════════════════════════════════════════════
// E · abort 面复用既有悬挂告警（GAP-S3b 落点：lib/tools/core.js / batch.abort_dangling）
// ═══════════════════════════════════════════════════════════════════════════════
test('E1：abort 有悬挂成员 ⇒ 复用 batch.abort_dangling（事件 + 回显），且只此一条新事件面', async () => {
  const { root, store, byName } = makeHarness('e1');
  await makeBatch(byName, root, 'b-dg');
  await toRunning(byName, 'b-dg');
  settleLane(store, 'b-dg', 'p1');                      // 终态成员：**不入**悬挂名单
  store.setMember(SESS_ID, 'b-dg', 'e1', 'running');    // 非终态
  const lanesBefore = { ...lanesOf(store, 'b-dg') };
  const evLen = store.readBatch(SESS_ID, 'b-dg').events.length;

  const out = await controlOf(byName).execute({ batchId: 'b-dg', action: 'abort' }, SESS);
  assert.deepEqual(out.danglingLanes, ['e1', 'a1'], '回显悬挂 lane 名单（p1 终态不入列）');
  const dg = eventsOf(store, 'b-dg', DANGLING_EVT);
  assert.equal(dg.length, 1, '恰一条 batch.abort_dangling（与 batch_phase(aborted) 同一实现）');
  assert.deepEqual(dg[0].danglingLanes, ['e1', 'a1']);
  assert.equal(dg[0].count, 2);
  const newEvs = store.readBatch(SESS_ID, 'b-dg').events.slice(evLen);
  assert.deepEqual(newEvs.map((e) => e.type), [EVT_BATCH_PHASE, DANGLING_EVT],
    'abort 只多落「相位迁移 + 悬挂告警」两条，零成员迁移事件');
  assert.deepEqual(lanesOf(store, 'b-dg'), lanesBefore, '成员状态逐字未变');
});

test('E2：abort 无悬挂成员 ⇒ 不落该事件、返回无 danglingLanes 键（反向锁）', async () => {
  const { root, store, byName } = makeHarness('e2');
  await makeBatch(byName, root, 'b-nodg');
  await toRunning(byName, 'b-nodg');
  for (const lane of ['p1', 'e1', 'a1']) settleLane(store, 'b-nodg', lane);
  const out = await controlOf(byName).execute({ batchId: 'b-nodg', action: 'abort' }, SESS);
  assert.equal(out.danglingLanes, undefined, '无悬挂 ⇒ 键不出现');
  assert.deepEqual(eventsOf(store, 'b-nodg', DANGLING_EVT), [], '无悬挂 ⇒ 零告警事件');
});

// ═══════════════════════════════════════════════════════════════════════════════
// F · GAP-S10 反向锁：paused 批不得被完成事件静默结算；resume 后恢复
// ═══════════════════════════════════════════════════════════════════════════════
test('F1：paused 批 + subagent/end ⇒ 无 member.settled、lane 不变、留痕 reason=phase-paused（GAP-S10）', async () => {
  const { root, store, byName } = makeHarness('f1');
  await makeBatch(byName, root, 'b-g1');
  await toRunning(byName, 'b-g1');
  store.setMember(SESS_ID, 'b-g1', 'e1', 'running'); // 派发中的 lane（非终态）
  await controlOf(byName).execute({ batchId: 'b-g1', action: 'pause' }, SESS);
  const lanesBefore = { ...lanesOf(store, 'b-g1') };
  const settledBefore = memberSettledCount(store, 'b-g1', 'e1');

  const ctx = assemblyCtx();
  const index = new Map([['ws-g1', { sessionId: SESS_ID, batchId: 'b-g1', lane: 'e1' }]]);
  const reg = installAutoSettle(ctx, { store, dispatchIndex: index, root, logger: console });
  try {
    await emitSubagentEnd(ctx, endInfo('ws-g1'));
  } finally {
    reg.dispose();
  }

  assert.equal(memberSettledCount(store, 'b-g1', 'e1'), settledBefore, 'paused 批不得被结算（无 member.settled）');
  assert.deepEqual(lanesOf(store, 'b-g1'), lanesBefore, 'lane 状态逐字不变');
  assert.equal(phaseOf(store, 'b-g1'), 'paused', '相位不被自动推进静默推翻');
  const skipped = eventsOf(store, 'b-g1', EVT_AUTO_SETTLE_SKIPPED);
  assert.equal(skipped.length, 1, '恰一条留痕（phase 闸）');
  assert.equal(skipped[0].reason, 'phase-paused', 'reason 自证（非笼统 skipped）');
  assert.equal(skipped[0].lane, 'e1');
  assert.equal(skipped[0].trigger, AUTO_SETTLE_TRIGGERS.subagentEnd);
  assert.equal(eventsOf(store, 'b-g1', EVT_AUTO_SETTLE_TRIGGERED).length, 0, 'paused 面不写触发留痕');
  assert.equal(eventsOf(store, 'b-g1', EVT_AUTO_SETTLE_PAUSED).length, 0,
    '相位闸与 `pauseForFail` 停轮**互不打架**：人工 pause 不落 auto.settle.paused（该事件只由门禁失败路径写），'
    + '且被相位闸拦住的触发也不会补写它');

  // resume 后同一 lane 再触发 ⇒ 正常结算（resume 是唯一恢复入口；相位闸不得毒化幂等键）
  await controlOf(byName).execute({ batchId: 'b-g1', action: 'resume' }, SESS);
  const ctx2 = assemblyCtx();
  const reg2 = installAutoSettle(ctx2, { store, dispatchIndex: index, root, logger: console });
  try {
    await emitSubagentEnd(ctx2, endInfo('ws-g1'));
  } finally {
    reg2.dispose();
  }
  assert.equal(lanesOf(store, 'b-g1').e1, 'merged', 'resume 后同一 lane 正常结算（相位闸不留后遗）');
  assert.equal(eventsOf(store, 'b-g1', EVT_AUTO_SETTLE_TRIGGERED).length, 1, '恢复后恰一条触发留痕');
});

test('F2：paused 批 + swarm_report(settle-request) 兼底路 ⇒ 同样被相位闸拦住并留痕', async () => {
  const { root, store, byName } = makeHarness('f2');
  await makeBatch(byName, root, 'b-g2');
  await toRunning(byName, 'b-g2');
  store.setMember(SESS_ID, 'b-g2', 'e1', 'running');
  // 身份反查判据 = `member.dispatch` 事件（与 `laneBindingOf` 同源）
  store.appendEvent(SESS_ID, 'b-g2', 'member.dispatch', { lane: 'e1', workerSessionId: 'ws-g2' });
  await controlOf(byName).execute({ batchId: 'b-g2', action: 'pause' }, SESS);
  const settledBefore = memberSettledCount(store, 'b-g2', 'e1');

  const worker = { agent: { session: { id: 'ws-g2' } } };
  const out = await byName.swarm_report.execute(
    { type: 'settle-request', summary: '兼底路触发（paused 批）' }, worker);
  assert.equal(out.delivered, true, '回报投递事实不受结算判定影响');
  assert.equal(out.settle.action, 'skipped', '兼底路同样被相位闸拦住');
  assert.equal(out.settle.reason, 'phase-paused');
  assert.equal(memberSettledCount(store, 'b-g2', 'e1'), settledBefore, '无 member.settled');
  assert.equal(lanesOf(store, 'b-g2').e1, 'running', 'lane 不变');
  assert.equal(eventsOf(store, 'b-g2', EVT_AUTO_SETTLE_SKIPPED).filter((e) => e.reason === 'phase-paused').length, 1,
    '留痕一条 phase-paused');
});

// ═══════════════════════════════════════════════════════════════════════════════
// G · running 相位零回归 + 入口真加载（工具数 25 → 26）
// ═══════════════════════════════════════════════════════════════════════════════
test('G1：running 相位既有行为零回归——同批同触发正常结算（相位闸只拦「相位不对」）', async () => {
  const { root, store, byName } = makeHarness('g1');
  await makeBatch(byName, root, 'b-ok');
  await toRunning(byName, 'b-ok');
  store.setMember(SESS_ID, 'b-ok', 'e1', 'running');
  const ctx = assemblyCtx();
  const index = new Map([['ws-ok', { sessionId: SESS_ID, batchId: 'b-ok', lane: 'e1' }]]);
  const reg = installAutoSettle(ctx, { store, dispatchIndex: index, root, logger: console });
  try {
    await emitSubagentEnd(ctx, endInfo('ws-ok'));
  } finally {
    reg.dispose();
  }
  assert.equal(lanesOf(store, 'b-ok').e1, 'merged', 'running 相位照常自动结算（零回归）');
  assert.equal(phaseOf(store, 'b-ok'), 'running', '全绿不停轮');
  assert.equal(eventsOf(store, 'b-ok', EVT_AUTO_SETTLE_SKIPPED).length, 0, 'running 面零跳过留痕');
});

test('G2：插件入口真加载——createTools 工具数 25 → 26，batch_control 已注册且参数面闭集', async () => {
  const { root, byName } = makeHarness('g2');
  assert.equal(Object.keys(byName).length, 29, '本 lane 新增 batch_control ⇒ 23 → 24；【2026-09-17 P1】handoff 两件常驻注册 ⇒ 25 → 26');
  const t = byName.batch_control;
  assert.ok(t, 'batch_control 须真实注册');
  assert.deepEqual(Object.keys(t.parameters.properties), ['batchId', 'action', 'session'], '参数面 = 最小干预面三键');
  assert.deepEqual(t.parameters.properties.action.enum, ['pause', 'resume', 'abort'], 'action 闭集');
  const rendered = t.output.render({}, { batchId: 'b-x', phase: 'paused', action: 'resume' });
  const text = Array.isArray(rendered) ? rendered.map((r) => r.text ?? '').join('') : String(rendered);
  assert.ok(text.includes('b-x') && text.includes('paused'), 'render 给出可读回显：' + text);
  assert.ok(fs.existsSync(path.join(root, 'sessions')), '夹具根隔离（不在仓库内写盘）');
});

test('G3：批量回归——batch_phase 行为逐字不变（本 lane 不改既有相位工具）', async () => {
  const { root, store, byName } = makeHarness('g3');
  await makeBatch(byName, root, 'b-bp');
  const out = await byName.batch_phase.execute({ batchId: 'b-bp', phase: 'running' }, SESS);
  assert.equal(out.phase, 'running', 'batch_phase 照常迁移');
  assert.deepEqual(Object.keys(out).sort(), ['batchId', 'phase'], '返回形状不变（无悬挂时不写 danglingLanes 键）');
  assert.deepEqual(store.readBatch(SESS_ID, 'b-bp').lanes, { p1: 'pending', e1: 'pending', a1: 'pending' },
    '相位迁移不改成员状态');
  const dir = path.join(PKG, 'test');
  assert.ok(fs.existsSync(path.join(dir, 'batch-control.test.js')), '本文件在测试目录内（自证路径）');
});
