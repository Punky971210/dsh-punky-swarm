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

// test/gate-status-subtasks.test.js —— 批 `punky-ckpt-followup-20261112` · lane `e1-impl` · subtask `s2`
//
// 判据源：`plan/ckpt-followup-spec.md`
//   · V-11 两键值语义六例（含 legacy 恒 `null` **≠ 0**）
//   · V-12 覆盖口径与 G2 判据⑥同源（含序贯覆盖）
//
// 反例如何能红（防假绿）：
//   · 把 legacy / corrupt / orphan 的 `null` 写成 `0` ⇒ V-11 第 4/5/6 例的 `notEqual(v, 0)` 必红；
//   · 覆盖口径只算显式 `ids`、不看 `sequential` ⇒ V-12 例 b 的 `covered === 2` 必红（读面会谎报「未覆盖」）；
//   · 覆盖口径把未声明 id 计入 ⇒ V-12 例 c 的 `covered === 0` 必红；
//   · 投影三分支漏一支（D-4）⇒ 对应例取不到键 ⇒ 必红（另有 `tool-schema-conformance` 的结构性锁）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../lib/state/store.js';
import { createGates } from '../lib/state/gates.js';
import { CHECKPOINT_PRIMITIVES } from '../lib/state/store/member.js';
import * as EVT from '../lib/state/event-types.js';
import { threeTierTasks, seedArtifacts, assessC } from './helpers/gate-fixture.mjs';

const SID = 'sess-gate-status-subtasks';
const EXEC = { agent: { session: { id: SID } } };
const AB = [{ id: 's1', target: 'exec/a.md' }, { id: 's2', target: 'exec/b.md' }];

/** 建一个三层合规批；`byLane` 里的 lane 追加 `subtasks` 声明（其余 lane 不带该键）。 */
async function mkBatch({ batchId, laneIds = ['e1'], byLane = {}, legacy = false }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-gs-subtasks-'));
  const store = createStore(root);
  const ctx = {
    tools: { register: () => {}, guard: () => () => {} },
    logger: { warn() {}, info() {}, error() {} },
    subagents: { start: async () => ({ id: 'w', result: Promise.resolve({ output: [], stopReason: 'completed' }) }) },
  };
  const { tools } = (await import('../lib/tools/register.js')).createTools(
    ctx, { store, root, config: { dispatch: { provider: 'spawn' } } },
  );
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  assessC(store, SID, { rationale: 'fixture：gate_status subtask 两键用例（三层 DAG ⇒ C 档）' });
  const tasks = threeTierTasks(laneIds).map((t) => (byLane && Object.prototype.hasOwnProperty.call(byLane, t.id)
    ? { ...t, subtasks: byLane[t.id] }
    : t));
  await by.wave_plan.execute({ batchId, team: 'software-team', tasks, assembly: { auditLane: 'a1' } }, EXEC);
  await by.batch_phase.execute({ batchId, phase: 'running' }, EXEC);
  seedArtifacts(root, SID, batchId, laneIds);
  // 门与投影共用**同一个** frozen prims 对象（DI 缝，V-10 / RQ-B5）
  const gates = createGates(root, { checkpointPrimitives: CHECKPOINT_PRIMITIVES });
  return { root, store, by, gates, batchId, legacy };
}

/** 落一条 `worktree.checkpoint` 事件（`subtask` 为显式覆盖面；缺省则模拟「序贯覆盖」形态）。 */
function appendCheckpoint(store, batchId, payload) {
  store.appendEvent(SID, batchId, EVT.EVT_WORKTREE_CHECKPOINT, { lane: 'e1', commit: null, message: 'fixture', ...payload });
}

const countsOf = (store, batchId, lane) => {
  const v = store.gateStatus(SID, batchId, lane);
  return { declared: v.subtasksDeclared, covered: v.subtasksCovered };
};

// ══ V-11 两键值语义（六例，逐例精确）════════════════════════════════════════════════════════════
test('V-11 两键值语义六例：subtasks 计数精确、legacy/corrupt/orphan 恒 null（≠0）', async () => {
  // 例 1：subtasks 批，声明 2 项，事件面已留痕 s1 ⇒ 2 / 1
  {
    const h = await mkBatch({ batchId: 'b-v11-1', byLane: { e1: AB } });
    appendCheckpoint(h.store, 'b-v11-1', { subtask: 's1', step: 1, total: 2 });
    const c = countsOf(h.store, 'b-v11-1', 'e1');
    assert.equal(c.declared, 2, '例1 declared 须 === 2，实测 ' + JSON.stringify(c));
    assert.equal(c.covered, 1, '例1 covered 须 === 1，实测 ' + JSON.stringify(c));
    fs.rmSync(h.root, { recursive: true, force: true });
  }

  // 例 2：subtasks 批，声明 2 项，零留痕 ⇒ 2 / 0
  {
    const h = await mkBatch({ batchId: 'b-v11-2', byLane: { e1: AB } });
    const c = countsOf(h.store, 'b-v11-2', 'e1');
    assert.equal(c.declared, 2, '例2 declared 须 === 2');
    assert.equal(c.covered, 0, '例2 covered 须 === 0（声明了 2 但一项未做，与 legacy 的 null 必须可分）');
    fs.rmSync(h.root, { recursive: true, force: true });
  }

  // 例 3：subtasks 批，lane 含键但归一后为空（`subtasks:[]`）⇒ 0 / 0（正是 G1 要拒的形状，必须能读出来）
  {
    const h = await mkBatch({ batchId: 'b-v11-3', byLane: { e1: [] } });
    const c = countsOf(h.store, 'b-v11-3', 'e1');
    assert.equal(c.declared, 0, '例3 declared 须 === 0');
    assert.equal(c.covered, 0, '例3 covered 须 === 0');
    fs.rmSync(h.root, { recursive: true, force: true });
  }

  // 例 4：legacy 批（无任何 subtasks）⇒ null / null，且**不得**是 0
  {
    const spec = { asset: null };
    const h = await mkBatch({ batchId: 'b-v11-4', laneIds: ['e1'], byLane: {}, legacy: true });
    //  legacy 批：把 e1 的 subtasks 键去掉（threeTierTasks 不带该键 ⇒ 天然 legacy）
    const c = countsOf(h.store, 'b-v11-4', 'e1');
    assert.strictEqual(c.declared, null, '例4 declared 须严格 null（实测 ' + JSON.stringify(c) + '）');
    assert.strictEqual(c.covered, null, '例4 covered 须严格 null');
    assert.notEqual(c.declared, 0, '例4 declared 禁为 0（0 与「声明了 0 项」不可区分，C-3）');
    assert.notEqual(c.covered, 0, '例4 covered 禁为 0');
    void spec;
    fs.rmSync(h.root, { recursive: true, force: true });
  }

  // 例 5：orphan lane（不在 wavePlan）⇒ null / null
  {
    const h = await mkBatch({ batchId: 'b-v11-5', byLane: { e1: AB } });
    //  把 lanes 表加一个不在 wavePlan 的幽灵 lane（orphan 分支的触发条件）
    const batch = h.store.readBatch(SID, 'b-v11-5');
    batch.lanes.ghost = 'running';
    const c = countsOf(h.store, 'b-v11-5', 'ghost');
    assert.equal(h.store.gateStatus(SID, 'b-v11-5', 'ghost').gates, 'orphan', '前置：须判为 orphan 分支');
    assert.strictEqual(c.declared, null, '例5 declared 须严格 null（orphan 分支）');
    assert.strictEqual(c.covered, null, '例5 covered 须严格 null');
    assert.notEqual(c.declared, 0, '例5 declared 禁为 0');
    fs.rmSync(h.root, { recursive: true, force: true });
  }

  // 例 6：corrupt 批（批文件存在但读不出）⇒ null / null
  {
    const h = await mkBatch({ batchId: 'b-v11-6', byLane: { e1: AB } });
    fs.writeFileSync(h.store.batchFile(SID, 'b-v11-6'), '{ not valid json !!');
    const v = h.store.gateStatus(SID, 'b-v11-6', 'e1');
    assert.equal(v.corrupt, true, '前置：须判为 corrupt 分支');
    assert.strictEqual(v.subtasksDeclared, null, '例6 declared 须严格 null（corrupt 分支）');
    assert.strictEqual(v.subtasksCovered, null, '例6 covered 须严格 null');
    assert.notEqual(v.subtasksDeclared, 0, '例6 declared 禁为 0');
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

// ══ V-12 覆盖口径与 G2 判据⑥同源（含序贯）════════════════════════════════════════════════════════
test('V-12 覆盖口径与 G2 同源：显式 1/2 拒、序贯 2/2 放行、未声明 id 不计入', async () => {
  // 例 a：声明 ['s1','s2']，仅留痕 s1 ⇒ covered=1 ∧ G2 拒且 missing=['s2']
  {
    const h = await mkBatch({ batchId: 'b-v12-a', byLane: { e1: AB } });
    appendCheckpoint(h.store, 'b-v12-a', { subtask: 's1' });
    const c = countsOf(h.store, 'b-v12-a', 'e1');
    const batch = h.store.readBatch(SID, 'b-v12-a');
    const g2 = h.gates.checkCheckpointsSettleGate(SID, 'b-v12-a', batch, 'e1', CHECKPOINT_PRIMITIVES);
    assert.equal(c.covered, 1, '例a covered 须 === 1');
    assert.equal(g2.ok, false, '例a G2 须拒');
    assert.equal(g2.code, 'GATE_CHECKPOINTS_INCOMPLETE', '例a G2 码须为 GATE_CHECKPOINTS_INCOMPLETE');
    assert.deepEqual(g2.missing, ['s2'], '例a missing 须为 [s2]');
    assert.ok(c.covered < c.declared, '例a 同源判据：covered < declared ⇔ 门拒');
    fs.rmSync(h.root, { recursive: true, force: true });
  }

  // 例 b：同上但留痕 progress{step:2,total:2} 且**无** `subtask` 字段（序贯覆盖）⇒ covered=2 ∧ G2 放行
  {
    const h = await mkBatch({ batchId: 'b-v12-b', byLane: { e1: AB } });
    appendCheckpoint(h.store, 'b-v12-b', { step: 2, total: 2 });
    const c = countsOf(h.store, 'b-v12-b', 'e1');
    const batch = h.store.readBatch(SID, 'b-v12-b');
    const g2 = h.gates.checkCheckpointsSettleGate(SID, 'b-v12-b', batch, 'e1', CHECKPOINT_PRIMITIVES);
    assert.equal(c.covered, 2, '例b covered 须 === 2（序贯覆盖必须可见，否则读面谎报未覆盖）');
    assert.equal(g2.ok, true, '例b G2 须放行');
    assert.equal(g2.sequential, true, '例b G2 须标 sequential:true');
    assert.equal(c.covered, c.declared, '例b 同源判据：covered === declared ⇔ 门放行（两条断言缺一即红）');
    fs.rmSync(h.root, { recursive: true, force: true });
  }

  // 例 c：声明 ['s1','s2']，事件面只含**未声明**的 id 'zzz' ⇒ covered=0 ∧ G2 拒且 missing 全量
  {
    const h = await mkBatch({ batchId: 'b-v12-c', byLane: { e1: AB } });
    appendCheckpoint(h.store, 'b-v12-c', { subtask: 'zzz' });
    const c = countsOf(h.store, 'b-v12-c', 'e1');
    const batch = h.store.readBatch(SID, 'b-v12-c');
    const g2 = h.gates.checkCheckpointsSettleGate(SID, 'b-v12-c', batch, 'e1', CHECKPOINT_PRIMITIVES);
    assert.equal(c.covered, 0, '例c covered 须 === 0（未声明 id 不计入）');
    assert.equal(g2.ok, false, '例c G2 须拒');
    assert.deepEqual(g2.missing, ['s1', 's2'], '例c missing 须为 [s1,s2]');
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

// ══ 值域不变量：0 ≤ covered ≤ declared（subtasks 方言下）════════════════════════════════════════
test('V-11 附 值域不变量：subtasks 方言下 0 ≤ covered ≤ declared 恒成立', async () => {
  const h = await mkBatch({ batchId: 'b-range', byLane: { e1: AB } });
  for (const ev of [{ subtask: 's1' }, { subtask: 's2' }, { subtask: 'zzz' }, {}]) {
    appendCheckpoint(h.store, 'b-range', ev);
    const c = countsOf(h.store, 'b-range', 'e1');
    assert.equal(Number.isInteger(c.declared), true, 'declared 须为整数：' + JSON.stringify(c));
    assert.equal(Number.isInteger(c.covered), true, 'covered 须为整数：' + JSON.stringify(c));
    assert.ok(c.covered >= 0 && c.covered <= c.declared, '须满足 0 ≤ covered ≤ declared：' + JSON.stringify(c));
  }
  fs.rmSync(h.root, { recursive: true, force: true });
});
