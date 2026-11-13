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

// test/checkpoints-gate.test.js —— 批 `punky-checkpoint-enforce-20261112` · lane `e2-gate`
//
// 判据源：`plan/checkpoint-enforce-spec.md`
//   · §D 门（e2）：V-14 派发门拒绝+零状态变更 / V-15 派发门豁免面 / V-16 结算门拒绝+保持 review /
//     V-17 结算门放行（显式覆盖）/ V-18 结算门拒绝（序贯覆盖已废）/ V-19 取源优先序 / V-20 结算门豁免面
//   · §F 自动建 worktree：V-24 触发与失败面 / V-25 不误触
//   · §B V-8 存量零拦截（e1 的 `exec/schema/report.md` §未达成 U-2 显式转交本 lane 承接）
//
// 反例如何能红（逐条可证伪，禁恒真）：
//   · V-14 把门写成「总是拒」⇒ V-8 / V-15 / V-24 必红；把门写成「总是放行」⇒ V-14 必红；
//   · V-16 不落事件 / 不 `commitBatch` ⇒ 事件面断言红；在拒绝前写 `batch.lanes[lane]` ⇒ 「保持 review」红；
//   · V-17 只认序贯覆盖（不认显式 subtask）⇒ 本用例（两条事件均无 step/total）必红；
//   · V-18 若把序贯通道加回（末项进度即算覆盖）⇒ 本用例（唯一事件无 subtaskId，断言**必拒**）必红；
//   · V-19 两处合并取数 / 回落优先序写反 ⇒ `source` 与 `latest` 双向断言必红；
//   · V-24 失败改成拒派（X-6 明禁）⇒「派发继续（lanes[lane]==='running'）」红；
//   · V-25 只按 layer 判触发、不看方言/声明 ⇒ plan/audit/legacy/空声明四条中必有一条出现 `worktree.*` 事件。
//
// 纪律：不写「用例数 / 断言数」型断言（spec §X-10）；G2 用例保存-清除-还原 `PSWARM_HANDOFF_GATE`
//   （本机父进程可能已置 1 ⇒ 不中和会让出口交接门抢答，造出与 checkpoint 无关的假红，见
//   `test/p2-settle-handoff.test.js` 头注实测）。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../lib/state/store.js';
import { createTools } from '../lib/tools/register.js';
import { createGates } from '../lib/state/gates.js';
import { dialectOf, dialectOfLane, declaredSubtasksOf, coveredSubtasksOf, latestCheckpointOf } from '../lib/state/resume.js';
import { threeTierTasks, seedArtifacts, assessC } from './helpers/gate-fixture.mjs';

const SAVED_HANDOFF_ENV = process.env.PSWARM_HANDOFF_GATE;
delete process.env.PSWARM_HANDOFF_GATE; // 见文件头：本套件只验 checkpoint 门，出口交接门一律关着跑
after(() => {
  if (SAVED_HANDOFF_ENV === undefined) delete process.env.PSWARM_HANDOFF_GATE;
  else process.env.PSWARM_HANDOFF_GATE = SAVED_HANDOFF_ENV;
});

const SID = 'sess-ckpt-gate';
const EXEC = { agent: { session: { id: SID } } };
//   ⚠ `dialectOfLane` **必须**在表上：`primsReadyOf` 对缺键 fail-closed ⇒ 漏补会让本套件 10 例门
//   全部 `skipped:'no-checkpoint-primitives'` **假绿**（spec §范围 #10 / C-11 / D-3）。
const PRIMS = { dialectOf, dialectOfLane, declaredSubtasksOf, coveredSubtasksOf, latestCheckpointOf };

/** 门级判据原料（`createGates` 只用来取两道纯判定门；本文件用它做「非工具面」的层/态豁免断言）。 */
const gates = createGates(fs.mkdtempSync(path.join(os.tmpdir(), 'punky-ckptgate-gates-')));

/**
 * 本地 harness（**与** `test/helpers/dispatch-fixture.mjs` 同构，只多两根轴：`tasks` 显式注入 + `smoke`）。
 * 不直接复用共享 helper 的原因：共享 helper 的 `taskExtra` 会把同一 `subtasks` 打到**全部** lane 上，
 * 且无 `smoke` 轴；本套件需要「按 lane 分别声明 subtasks」与「smoke 批」两种形态。
 */
async function mkHarness({ batchId, tasks, smoke = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-ckptgate-'));
  const store = createStore(root);
  const captured = [];
  const ctx = {
    tools: { register: () => {}, guard: () => () => {} },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    subagents: {
      start: async (provider, request) => {
        captured.push({ provider, ...request });
        return { id: 'worker-stub-1', result: Promise.resolve({ output: [], stopReason: 'completed' }) };
      },
    },
  };
  const { tools } = createTools(ctx, { store, root, config: { dispatch: { provider: 'spawn' } } });
  // `team` 显式传（不用 `helpers/skill-paths.mjs#withDefaultTeam`：那条注入面有使用方允许名单账本
  //   `test/fixture-team-ledger.test.js` F2-6，本 lane 无写域改账本 ⇒ 显式标签等价且零账本漂移）。
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  assessC(store, SID, { rationale: 'fixture：checkpoint 门用例的建批前置评估（三层 DAG 多依赖 ⇒ C 档）' });
  await by.wave_plan.execute({ batchId, team: 'software-team', tasks, assembly: { auditLane: 'a1' }, ...(smoke ? { smoke: true } : {}) }, EXEC);
  await by.batch_phase.execute({ batchId, phase: 'running' }, EXEC);
  seedArtifacts(root, SID, batchId, ['e1']);
  return { root, store, by, captured, batchId };
}

/** 三层合规批 + 按 lane 注入 `subtasks`（未出现在 `byLane` 里的 lane **不带**该键 ⇒ 不参与方言判定）。 */
function tasksWith(byLane = {}) {
  return threeTierTasks(['e1']).map((t) => (Object.prototype.hasOwnProperty.call(byLane, t.id)
    ? { ...t, subtasks: byLane[t.id] }
    : t));
}

const AB = [{ id: 'a', target: 'exec/a.md' }, { id: 'b', target: 'exec/b.md' }];
const eventsOf = (store, batchId) => (store.readBatch(SID, batchId)?.events ?? []);
const ofType = (store, batchId, type) => eventsOf(store, batchId).filter((e) => e.type === type);
const worktreeEvents = (store, batchId) => eventsOf(store, batchId).filter((e) => String(e.type ?? '').startsWith('worktree.'));

/** 取该 lane 的 `subtasks` 声明的持久形态（供「键在场 / 归一形态」断言）。 */
const laneTaskOf = (batch, lane) => (Array.isArray(batch?.wavePlan) ? batch.wavePlan : [])
  .flatMap((w) => (Array.isArray(w?.tasks) ? w.tasks : []))
  .find((t) => t && t.id === lane) ?? null;

// ══ V-14 派发门拒绝 + 零状态变更（`dispatch-gate-reject`）══════════════════════════════════════
test('dispatch-gate-reject [V-14] exec + subtasks 方言 + 归一后为空 + from=pending ⇒ 拒 GATE_CHECKPOINTS_REQUIRED，零状态变更', async () => {
  const h = await mkHarness({ batchId: 'b-v14', tasks: tasksWith({ e1: [] }) });
  const phaseBefore = h.store.readBatch(SID, 'b-v14').phase;
  // 前置：`subtasks: []` 落盘后**键在场**且归一为 `{items:[…]}`（这才是「声明了但为空」的要拒形状）
  const task = laneTaskOf(h.store.readBatch(SID, 'b-v14'), 'e1');
  assert.equal('subtasks' in task, true, '前置：`subtasks` 键必须在场（方言判据 = 键存在性）');
  assert.deepEqual(task.subtasks, { items: [] }, '前置：空数组归一为 `{items:[]}`（与 checkpoints 同款降级）');
  assert.equal(dialectOf(h.store.readBatch(SID, 'b-v14')), 'subtasks', '前置：任一条 task 含键 ⇒ 批级方言 subtasks');

  await assert.rejects(
    () => h.by.lane_dispatch.execute({ batchId: 'b-v14', lane: 'e1' }, EXEC),
    (e) => {
      assert.match(String(e.message), /^GATE_CHECKPOINTS_REQUIRED/, '须以新码拒派：' + e.message);
      return true;
    },
  );
  const batch = h.store.readBatch(SID, 'b-v14');
  assert.equal(batch.lanes.e1, 'pending', '拒后 lane 必须仍 pending（零状态变更）');
  assert.equal(batch.phase, phaseBefore, '拒后批相位不变');
  assert.equal(ofType(h.store, 'b-v14', 'member.dispatch').length, 0, '拒派不得落 member.dispatch');
  assert.equal(h.captured.length, 0, '拒派不得拉起 worker（无 start 调用）');
  const evts = ofType(h.store, 'b-v14', 'gate.checkpoints.required');
  assert.equal(evts.length, 1, '须恰落 1 条 gate.checkpoints.required，实测 ' + JSON.stringify(evts.map((e) => e.type)));
  assert.equal(evts[0].lane, 'e1');
  assert.equal(evts[0].code, 'GATE_CHECKPOINTS_REQUIRED');
  assert.equal(evts[0].declared, false, '事件须显式带 declared:false（spec §E-3）');
  assert.equal(evts[0].dialect, 'subtasks', '事件须显式带 dialect（spec §E-3）');
  // 零写入对照：`member_settled` 事件里不得出现 e1 的 running 迁移
  assert.equal(eventsOf(h.store, 'b-v14').filter((e) => e.type === 'member.settled' && e.lane === 'e1').length, 0,
    '拒派不得落 member.settled（迁移表未被调用）');
});

// ══ V-15 派发门豁免面（`dispatch-gate-exempt`）════════════════════════════════════════════════
test('dispatch-gate-exempt [V-15] idle→running / plan / audit / smoke 四例各自不抛', async () => {
  // ① idle→running：恢复重派必须放行（与 entry 门 G-1 同向；`idle` 只能由恢复/回收进入 ⇒ 门级构造）
  const idleBatch = {
    batchId: 'b-idle', phase: 'running', lanes: { e1: 'idle' }, events: [],
    wavePlan: [{ wave: 1, tasks: [{ id: 'e1', layer: 'exec', subtasks: { items: [] } }] }],
  };
  const rIdle = gates.checkCheckpointsDispatchGate(SID, 'b-idle', idleBatch, 'e1', PRIMS);
  assert.equal(rIdle.ok, true, 'idle 续跑须放行（实测 ' + JSON.stringify(rIdle) + '）');
  assert.equal(rIdle.skipped, 'not-first-dispatch', '放行成因须可判（非首次派发）');
  // 同批把态改成 pending ⇒ 同一门必须拒（证「放行不是恒真」，对照组）
  const rSame = gates.checkCheckpointsDispatchGate(SID, 'b-idle', { ...idleBatch, lanes: { e1: 'pending' } }, 'e1', PRIMS);
  assert.equal(rSame.ok, false, '同一夹具 pending 态必须拒（对照组：证明 idle 分支有分辨力）');
  assert.equal(rSame.code, 'GATE_CHECKPOINTS_REQUIRED');

  // ② plan 层：行为面（entry 门对 plan 层早退，故走完整派发链路）
  const hp = await mkHarness({ batchId: 'b-v15p', tasks: tasksWith({ e1: [] }) });
  const dp = await hp.by.lane_dispatch.execute({ batchId: 'b-v15p', lane: 'p1' }, EXEC);
  assert.equal(dp.status, 'running', 'plan 层 lane 不受 checkpoint 派发门约束（实测 ' + JSON.stringify(dp) + '）');
  assert.equal(ofType(hp.store, 'b-v15p', 'gate.checkpoints.required').length, 0, 'plan 层不得落 checkpoint 拒码事件');

  // ③ audit 层：门级（audit 层在 entry 门有独立契约，此处只判本门不越界）
  const auditBatch = {
    batchId: 'b-audit', phase: 'running', lanes: { a1: 'pending' }, events: [],
    wavePlan: [{ wave: 1, tasks: [{ id: 'a1', layer: 'audit', subtasks: { items: [] } }] }],
  };
  const rAudit = gates.checkCheckpointsDispatchGate(SID, 'b-audit', auditBatch, 'a1', PRIMS);
  assert.equal(rAudit.ok, true, 'audit 层不受本门约束（实测 ' + JSON.stringify(rAudit) + '）');
  assert.equal(rAudit.skipped, 'layer-not-exec');
  const rAuditSettle = gates.checkCheckpointsSettleGate(SID, 'b-audit', auditBatch, 'a1', PRIMS);
  assert.equal(rAuditSettle.ok, true, 'audit 层不受结算门约束');

  // ④ smoke 批：行为面（`smoke:true` ⇒ 建批期即落 batch.smoke，产物契约类门豁免）
  const hs = await mkHarness({ batchId: 'b-v15s', tasks: tasksWith({ e1: [] }), smoke: true });
  assert.equal(ofType(hs.store, 'b-v15s', 'batch.smoke').length, 1, '前置：smoke 批须有 batch.smoke 事件');
  const ds = await hs.by.lane_dispatch.execute({ batchId: 'b-v15s', lane: 'e1' }, EXEC);
  assert.equal(ds.status, 'running', 'smoke 批不受 checkpoint 派发门约束（实测 ' + JSON.stringify(ds) + '）');
  assert.equal(ofType(hs.store, 'b-v15s', 'gate.checkpoints.required').length, 0, 'smoke 批不得落拒码事件');
});

// ══ V-8 存量零拦截（`legacy-passthrough`；e1 的 U-2 转交本 lane 承接）══════════════════════════
test('legacy-passthrough [V-8] legacy 批（无 subtasks 键）⇒ 派发与结算两次迁移均不抛 GATE_CHECKPOINTS_*，事件零条', async () => {
  const h = await mkHarness({ batchId: 'b-v8', tasks: threeTierTasks(['e1']) });
  assert.equal(dialectOf(h.store.readBatch(SID, 'b-v8')), 'legacy', '前置：本批是 legacy 方言');
  const d = await h.by.lane_dispatch.execute({ batchId: 'b-v8', lane: 'e1' }, EXEC);
  assert.equal(d.status, 'running', 'legacy 批派发必须照常成功');
  await h.by.member_set_status.execute({ batchId: 'b-v8', lane: 'e1', status: 'review' }, EXEC);
  const m = await h.by.member_settle.execute({ batchId: 'b-v8', lane: 'e1', status: 'merged' }, EXEC);
  assert.equal(m.status, 'merged', 'legacy 批结算必须照常成功（存量零感知）');
  const ckptEvts = eventsOf(h.store, 'b-v8').filter((e) => String(e.type ?? '').startsWith('gate.checkpoints.'));
  assert.deepEqual(ckptEvts.map((e) => e.type), [], 'legacy 批事件流中 gate.checkpoints.* 必须零条');
});

// ══ V-16 结算门拒绝 + 保持 review（`settle-gate-reject`）═══════════════════════════════════════
test('settle-gate-reject [V-16] 声明 2 项但只留痕 1 项 ⇒ 拒 GATE_CHECKPOINTS_INCOMPLETE，missing 恰为 [b]，lane 保持 review', async () => {
  const h = await mkHarness({ batchId: 'b-v16', tasks: tasksWith({ e1: AB }) });
  assert.deepEqual(declaredSubtasksOf(h.store.readBatch(SID, 'b-v16'), 'e1'), ['a', 'b'], '前置：声明序 = [a,b]');
  await h.by.member_set_status.execute({ batchId: 'b-v16', lane: 'e1', status: 'running' }, EXEC);
  const c1 = await h.by.lane_checkpoint.execute({ batchId: 'b-v16', laneId: 'e1', message: '做 a', subtaskId: 'a' }, EXEC);
  assert.equal(c1.ok, true, '无 worktree 的 checkpoint 仍须 ok（B1 降级留痕）: ' + JSON.stringify(c1));
  await h.by.member_set_status.execute({ batchId: 'b-v16', lane: 'e1', status: 'review' }, EXEC);

  await assert.rejects(
    () => h.by.member_settle.execute({ batchId: 'b-v16', lane: 'e1', status: 'merged' }, EXEC),
    (e) => {
      assert.match(String(e.message), /^GATE_CHECKPOINTS_INCOMPLETE/, '须以新码拒 settle：' + e.message);
      return true;
    },
  );
  const batch = h.store.readBatch(SID, 'b-v16');
  assert.equal(batch.lanes.e1, 'review', '拒后 lane 必须保持 review（不许落到 merged）');
  const evts = ofType(h.store, 'b-v16', 'gate.checkpoints.incomplete');
  assert.equal(evts.length, 1, '须恰落 1 条 gate.checkpoints.incomplete');
  assert.deepEqual(evts[0].missing, ['b'], 'missing 必须**按声明序**只点名未留痕项，实测 ' + JSON.stringify(evts[0].missing));
  assert.deepEqual(evts[0].declared, ['a', 'b'], '事件须带完整声明面（有序）');
  // AC-3（批 `punky-g2-closeout-20261113` · C1/H3=A）：门写入的载荷键集固定 `{lane, code, missing, declared}`，
  //   **无序贯读数** —— 原断言 `evts[0].sequential === false` 随「序贯覆盖」通道整体删除而失效（成因见 D-2 台账）。
  //   `ts`/`type` 是 `newEvent` 的公共头（`store/events.js:105`），`lanes` 是落盘前统一追加的 lane 态戳记
  //   （`store.js:297-307 stampGateLaneSnapshot`，只对 `gate.*` 事件补键）⇒ 二者不属于门载荷。
  const gatePayloadKeys = Object.keys(evts[0]).filter((k) => !['ts', 'type', 'lanes'].includes(k)).sort();
  assert.deepEqual(gatePayloadKeys, ['code', 'declared', 'lane', 'missing'],
    '拒绝事件载荷须恰为四键（无序贯读数）；实测=' + JSON.stringify(Object.keys(evts[0])));
  assert.equal(evts[0].code, 'GATE_CHECKPOINTS_INCOMPLETE');
});

// ══ V-17 结算门放行（显式覆盖；`settle-gate-pass-explicit`）════════════════════════════════════
test('settle-gate-pass-explicit [V-17] 2 项 + 2 条显式 subtask 事件（均无 step/total）⇒ merged 放行', async () => {
  const h = await mkHarness({ batchId: 'b-v17', tasks: tasksWith({ e1: AB }) });
  await h.by.member_set_status.execute({ batchId: 'b-v17', lane: 'e1', status: 'running' }, EXEC);
  // 刻意**不带 progress** ⇒ 序贯覆盖判据不成立（`latest === null`），放行只能来自显式覆盖
  await h.by.lane_checkpoint.execute({ batchId: 'b-v17', laneId: 'e1', message: 'a', subtaskId: 'a' }, EXEC);
  await h.by.lane_checkpoint.execute({ batchId: 'b-v17', laneId: 'e1', message: 'b', subtaskId: 'b' }, EXEC);
  assert.equal(latestCheckpointOf(h.store.readBatch(SID, 'b-v17'), 'e1'), null,
    '前置：两条事件都无 step/total ⇒ 序贯判据不成立（本用例不借序贯档放行）');
  await h.by.member_set_status.execute({ batchId: 'b-v17', lane: 'e1', status: 'review' }, EXEC);
  const m = await h.by.member_settle.execute({ batchId: 'b-v17', lane: 'e1', status: 'merged' }, EXEC);
  assert.equal(m.status, 'merged', '显式覆盖齐备 ⇒ 必须放行');
  assert.equal(ofType(h.store, 'b-v17', 'gate.checkpoints.incomplete').length, 0, '放行路径不得落拒码事件');
});

// ══ V-18 结算门拒绝（序贯覆盖已废；`settle-gate-pass-sequential`）══════════════════════════════
//   批 `punky-g2-closeout-20261113`（裁定 H3=A）：本用例原为「序贯覆盖放行」的**正例**，是 G-03 后门的断言化锁。
//   序贯通道删除后它必然反转 ⇒ 改写为「单次报末项必须被拒」的判据（断言强度不降：原断「放行」→ 现断「拒绝」）。
test('settle-gate-pass-sequential [V-18] 2 项 + 1 条 progress{step:2,total:2}（无 subtaskId）⇒ 拒 GATE_CHECKPOINTS_INCOMPLETE', async () => {
  const h = await mkHarness({ batchId: 'b-v18', tasks: tasksWith({ e1: AB }) });
  await h.by.member_set_status.execute({ batchId: 'b-v18', lane: 'e1', status: 'running' }, EXEC);
  await h.by.lane_checkpoint.execute({ batchId: 'b-v18', laneId: 'e1', message: '走到末项', progress: { step: 2, total: 2 } }, EXEC);
  const batch = h.store.readBatch(SID, 'b-v18');
  assert.deepEqual(coveredSubtasksOf(batch, 'e1').ids.size, 0, '前置：显式覆盖为空（没有任何 subtask 字段）');
  assert.deepEqual(Object.keys(coveredSubtasksOf(batch, 'e1')), ['ids'],
    'AC-1：覆盖原料键集恰为 [ids] —— 序贯读数已随通道删除，实测=' + JSON.stringify(Object.keys(coveredSubtasksOf(batch, 'e1'))));
  assert.deepEqual(latestCheckpointOf(batch, 'e1')?.latest, { step: 2, total: 2 },
    '前置：进度确实走到末项（total===2 且 step>=2）—— 旧判据在这一形态下会放行');
  await h.by.member_set_status.execute({ batchId: 'b-v18', lane: 'e1', status: 'review' }, EXEC);
  await assert.rejects(
    () => h.by.member_settle.execute({ batchId: 'b-v18', lane: 'e1', status: 'merged' }, EXEC),
    (e) => {
      assert.match(String(e.message), /^GATE_CHECKPOINTS_INCOMPLETE/,
        '单次报末项不得再放行（序贯覆盖已废）：' + e.message);
      return true;
    },
  );
  const evts = ofType(h.store, 'b-v18', 'gate.checkpoints.incomplete');
  assert.deepEqual(evts[0].missing, ['a', 'b'], 'missing 须按声明序全列（无任何逐项留痕）');
  assert.equal(h.store.readBatch(SID, 'b-v18').lanes.e1, 'review', '拒后 lane 必须保持 review');
});

// ══ V-19 取源优先序（`latest-source-precedence`）════════════════════════════════════════════════
test('latest-source-precedence [V-19] 事件面与 laneProgress 冲突 ⇒ 取事件值（source=event）；事件面空 ⇒ 回落 laneProgress', async () => {
  const h = await mkHarness({ batchId: 'b-v19a', tasks: tasksWith({ e1: AB }) });
  h.store.appendEvent(SID, 'b-v19a', 'worktree.checkpoint', { lane: 'e1', commit: null, message: 'e', mode: 'no-worktree', step: 2, total: 2 });
  h.store.updateLaneProgress(SID, 'b-v19a', 'e1', { step: 1, total: 2, status: 'review' });
  const both = latestCheckpointOf(h.store.readBatch(SID, 'b-v19a'), 'e1');
  assert.equal(both.source, 'event', '两源并存 ⇒ 事件胜出（不做数值合并）');
  assert.deepEqual(both.latest, { step: 2, total: 2 }, '取事件值 2/2，而不是指针的 1/2');

  const h2 = await mkHarness({ batchId: 'b-v19b', tasks: tasksWith({ e1: AB }) });
  h2.store.updateLaneProgress(SID, 'b-v19b', 'e1', { step: 1, total: 2, status: 'review' });
  const fallback = latestCheckpointOf(h2.store.readBatch(SID, 'b-v19b'), 'e1');
  assert.equal(fallback.source, 'laneProgress', '事件面无 step/total ⇒ 回落断点指针');
  assert.deepEqual(fallback.latest, { step: 1, total: 2 });
});

// ══ V-20 结算门豁免面（`settle-gate-exempt`）═══════════════════════════════════════════════════
test('settle-gate-exempt [V-20] skipped / failed / conflict 三次结算均不抛；smoke 批 merged 不抛', async () => {
  // 三条非 merged 终态：本门只在 merged 链 ⇒ 逐条都必须放行（且无需任何 checkpoint 留痕）。
  // 形态取**真实链路**（`MEMBER_TRANSITIONS` 口径：running→{review,failed,skipped}；review→{merged,conflict,failed}）
  const mkTerminal = async (batchId, status) => {
    const h = await mkHarness({ batchId, tasks: tasksWith({ e1: AB }) });
    await h.by.member_set_status.execute({ batchId, lane: 'e1', status: 'running' }, EXEC);
    if (status === 'conflict') {
      // conflict 只从 review 出发（迁移表：review → {merged, conflict, failed}）
      await h.by.member_set_status.execute({ batchId, lane: 'e1', status: 'review' }, EXEC);
    }
    const r = await h.by.member_settle.execute({ batchId, lane: 'e1', status, note: 'fixture: ' + status }, EXEC);
    assert.equal(r.status, status, status + ' 结算不得被 checkpoint 门拦');
    assert.equal(eventsOf(h.store, batchId).filter((e) => e.type === 'gate.checkpoints.incomplete').length, 0,
      status + ' 豁免面不得落 checkpoint 拒码事件');
    return h;
  };
  await mkTerminal('b-v20sk', 'skipped');
  await mkTerminal('b-v20fa', 'failed');
  await mkTerminal('b-v20co', 'conflict');
  // smoke 批：声明 2 项、零 checkpoint ⇒ merged 也不得被拦
  const hs = await mkHarness({ batchId: 'b-v20s', tasks: tasksWith({ e1: AB }), smoke: true });
  await hs.by.member_set_status.execute({ batchId: 'b-v20s', lane: 'e1', status: 'running' }, EXEC);
  await hs.by.member_set_status.execute({ batchId: 'b-v20s', lane: 'e1', status: 'review' }, EXEC);
  const sm = await hs.by.member_settle.execute({ batchId: 'b-v20s', lane: 'e1', status: 'merged' }, EXEC);
  assert.equal(sm.status, 'merged', 'smoke 批 merged 不得被 checkpoint 结算门拦');
  assert.equal(eventsOf(hs.store, 'b-v20s').filter((e) => e.type === 'gate.checkpoints.incomplete').length, 0);
});

// ══ V-24 自动建 worktree：触发与失败面（`autoworktree`）════════════════════════════════════════
test('autoworktree [V-24] 成功 ⇒ 恰 1 条 worktree.created(auto:true)；git 不可用 ⇒ 1 条 worktree.autocreate.failed 且派发继续', async () => {
  // B-1 修复后（用户裁 R2）：自动建为**显式 opt-in**（env `PUNKY_AUTOWORKTREE=1`）⇒ 本用例显式开启。
  const prevOptIn = process.env.PUNKY_AUTOWORKTREE;
  process.env.PUNKY_AUTOWORKTREE = '1';
  // ① 成功面
  const h = await mkHarness({ batchId: 'b-v24a', tasks: tasksWith({ e1: AB }) });
  const d = await h.by.lane_dispatch.execute({ batchId: 'b-v24a', lane: 'e1' }, EXEC);
  assert.equal(d.status, 'running', '派发须成功（实测 ' + JSON.stringify(d) + '）');
  const created = ofType(h.store, 'b-v24a', 'worktree.created');
  assert.equal(created.length, 1, '须恰 1 条 worktree.created，实测 ' + JSON.stringify(worktreeEvents(h.store, 'b-v24a').map((e) => e.type)));
  assert.equal(created[0].auto, true, '自动建须带 auto:true（与手调 lane_worktree_create 区分）');
  assert.equal(created[0].lane, 'e1');
  assert.equal(ofType(h.store, 'b-v24a', 'worktree.autocreate.failed').length, 0, '成功路径不得落失败事件');

  // ② 失败面：`DSH_GIT_BIN` 指向不存在路径 ⇒ 告警不拒派（X-6 明禁改成拒派）
  const hf = await mkHarness({ batchId: 'b-v24f', tasks: tasksWith({ e1: AB }) });
  const prev = process.env.DSH_GIT_BIN;
  process.env.DSH_GIT_BIN = 'git-definitely-not-installed-xyz';
  try {
    const df = await hf.by.lane_dispatch.execute({ batchId: 'b-v24f', lane: 'e1' }, EXEC);
    assert.equal(df.status, 'running', 'git 不可用 ⇒ 自动建失败但**派发继续**（告警级）');
    const failed = ofType(hf.store, 'b-v24f', 'worktree.autocreate.failed');
    assert.equal(failed.length, 1, '须恰 1 条 worktree.autocreate.failed');
    assert.equal(failed[0].code, 'GATE_WORKTREE_AUTOCREATE_FAILED', '载荷须带码（spec §E-3）');
    assert.equal(typeof failed[0].reason, 'string', '载荷须带 reason');
    assert.ok(failed[0].reason.length > 0, 'reason 不得为空');
  } finally {
    if (prev === undefined) delete process.env.DSH_GIT_BIN; else process.env.DSH_GIT_BIN = prev;
  }
  // 失败点必须早于 `setMember(running)` ⇒ lane 已 running 说明「失败没回滚任何状态」，且无 worktree.created
  assert.equal(ofType(hf.store, 'b-v24f', 'worktree.created').length, 0, '失败路径不得落 worktree.created');
  if (prevOptIn === undefined) delete process.env.PUNKY_AUTOWORKTREE; else process.env.PUNKY_AUTOWORKTREE = prevOptIn;
});

// ══ V-24b 自动建默认关闭（B-1 修复 · 用户裁 R2）════════════════════════════════════════════════
test('autoworktree [V-24b] 未 opt-in ⇒ 不建 worktree、零 worktree.* 事件、派发继续（不再造合成空仓）', async () => {
  const prevOptIn = process.env.PUNKY_AUTOWORKTREE;
  delete process.env.PUNKY_AUTOWORKTREE;
  try {
    const h = await mkHarness({ batchId: 'b-v24off', tasks: tasksWith({ e1: AB }) });
    const d = await h.by.lane_dispatch.execute({ batchId: 'b-v24off', lane: 'e1' }, EXEC);
    assert.equal(d.status, 'running', '未 opt-in 不得影响派发（实测 ' + JSON.stringify(d) + '）');
    assert.deepEqual(worktreeEvents(h.store, 'b-v24off').map((e) => e.type), [],
      '默认关闭时不得落任何 worktree.* 事件（含 created / autocreate.failed）');
    // 直接单点核 `skipped` 口径（触发面第 ④ 条）
    const { maybeAutoCreateWorktree } = await import('../lib/engine/dispatch-autoworktree.js');
    const skippedRes = maybeAutoCreateWorktree({
      root: fs.mkdtempSync(path.join(os.tmpdir(), 'punky-autowt-off-')),
      sessionId: SID, batchId: 'b-v24off', lane: 'e1',
      laneTask: { id: 'e1', layer: 'exec' },
      batch: { wavePlan: [{ tasks: [{ id: 'e1', layer: 'exec', subtasks: { items: [{ id: 's1', target: 'x' }] } }] }] },
      store: { appendEvent: () => { throw new Error('不得落事件'); } },
    });
    assert.equal(skippedRes.skipped, 'opt-in-off', '未 opt-in 须报 skipped=opt-in-off（实测 ' + JSON.stringify(skippedRes) + '）');
    assert.equal(skippedRes.attempted, false, '跳过面 attempted 必须为 false');
  } finally {
    if (prevOptIn === undefined) delete process.env.PUNKY_AUTOWORKTREE; else process.env.PUNKY_AUTOWORKTREE = prevOptIn;
  }
});

// ══ V-25 不误触（`autoworktree-skip`）══════════════════════════════════════════════════════════
test('autoworktree-skip [V-25] plan / audit / legacy / 声明为空 四种派发 ⇒ 零条 worktree.* 事件', async () => {
  // ① plan 层（批是 subtasks 方言，但该 lane 是 plan）
  const hp = await mkHarness({ batchId: 'b-v25p', tasks: tasksWith({ e1: AB }) });
  await hp.by.lane_dispatch.execute({ batchId: 'b-v25p', lane: 'p1' }, EXEC);
  assert.deepEqual(worktreeEvents(hp.store, 'b-v25p').map((e) => e.type), [], 'plan 层不得触发自动建 worktree');

  // ② audit 层
  const ha = await mkHarness({ batchId: 'b-v25a', tasks: tasksWith({ e1: AB }) });
  await ha.by.lane_dispatch.execute({ batchId: 'b-v25a', lane: 'a1' }, EXEC);
  assert.deepEqual(worktreeEvents(ha.store, 'b-v25a').map((e) => e.type), [], 'audit 层不得触发自动建 worktree');

  // ③ legacy 批（无任何 subtasks 键）
  const hl = await mkHarness({ batchId: 'b-v25l', tasks: threeTierTasks(['e1']) });
  await hl.by.lane_dispatch.execute({ batchId: 'b-v25l', lane: 'e1' }, EXEC);
  assert.deepEqual(worktreeEvents(hl.store, 'b-v25l').map((e) => e.type), [], 'legacy 批不得触发自动建 worktree');

  // ④ 声明为空（方言是 subtasks，但归一后 0 项 ⇒ A1 触发面第三判据不成立）
  const he = await mkHarness({ batchId: 'b-v25e', tasks: tasksWith({ e1: [] }) });
  await assert.rejects(() => he.by.lane_dispatch.execute({ batchId: 'b-v25e', lane: 'e1' }, EXEC), /GATE_CHECKPOINTS_REQUIRED/);
  assert.deepEqual(worktreeEvents(he.store, 'b-v25e').map((e) => e.type), [], '声明为空时既不建 worktree 也不落失败事件');
});
