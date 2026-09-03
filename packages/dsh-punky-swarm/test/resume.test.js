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

// B 子项（步数预算）单测：resume.js 超限判定纯函数 + lane-tools.js lane_checkpoint 接线（幂等 appendEvent）
// 用例（spec §子项 B 单测要求）：
//   B1 未声明 checkpoint.steps → overBudgetOf 返回 { over:false, budget:null }（任意 total，B-不变量零感知）
//   B2 total > steps 触发 → { over:true, budget:steps }（{ step:3, total:6 } vs budget 5）
//   B3 total ≤ steps 不触发 → { over:false, budget:steps }（{ step:3, total:5 } vs budget 5）
//   B4 幂等判据 → hasOverBudgetEvent：事件流含该 lane 的 lane.over-budget → true；不含 / 他 lane → false
//   B5 step ≤ total 校验不变 → laneProgressWrite 对 { step:0, total:3 } / step > total throw /invalid laneProgress/
//   B6 集成（worktree 开关启用）：lane_checkpoint 超限 progress → 事件流恰好 1 条 lane.over-budget
//     （重复超限 progress 幂等不重复发）+ 工具仍正常返回（不硬杀）；total ≤ budget 不触发
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { overBudgetOf, hasOverBudgetEvent, laneProgressWrite } from '../lib/state/resume.js';
import { createStore } from '../lib/state/store.js';
import { createTools } from '../lib/tools/register.js';

const EXEC_SESS = { agent: { session: { id: 'sess-budget' } } };

// batch 夹具：wavePlan 单 wave，task 按传入配置生成（id=l1/l2/…），可附加事件流
function makeBatch(taskOpts, events = []) {
  return {
    wavePlan: [{ wave: 1, tasks: taskOpts.map((t, i) => ({ id: 'l' + (i + 1), cmd: 'task ' + (i + 1), ...t })) }],
    events,
  };
}

test('B1 未声明 checkpoint.steps：任意 progress 均不触发（B-不变量零感知）', () => {
  const batch = makeBatch([{ cmd: 'no budget declared' }]);
  assert.deepEqual(overBudgetOf(batch, 'l1', { step: 1, total: 999 }), { over: false, budget: null }, 'total=999 不触发');
  assert.deepEqual(overBudgetOf(batch, 'l1', { step: 1, total: 1 }), { over: false, budget: null }, 'total=1 不触发');
  assert.deepEqual(overBudgetOf(batch, 'l1', null), { over: false, budget: null }, 'progress 缺失不触发');
  // 未知 lane（wavePlan 无该任务）按未声明处理：零感知
  assert.deepEqual(overBudgetOf(batch, 'nope', { step: 1, total: 100 }), { over: false, budget: null });
});

test('B2 total > steps 触发：{ step:3, total:6 } vs budget 5 → { over:true, budget:5 }', () => {
  const batch = makeBatch([{ checkpoint: { steps: 5 } }]);
  assert.deepEqual(overBudgetOf(batch, 'l1', { step: 3, total: 6 }), { over: true, budget: 5 });
});

test('B3 total ≤ steps 不触发：{ step:3, total:5 } vs budget 5 → { over:false, budget:5 }', () => {
  const batch = makeBatch([{ checkpoint: { steps: 5 } }]);
  assert.deepEqual(overBudgetOf(batch, 'l1', { step: 3, total: 5 }), { over: false, budget: 5 }, 'total=budget 不触发');
  assert.deepEqual(overBudgetOf(batch, 'l1', { step: 1, total: 3 }), { over: false, budget: 5 }, 'total<budget 不触发');
});

test('B4 幂等判据：hasOverBudgetEvent 按 lane + 事件类型匹配', () => {
  const withEvent = makeBatch([], [{ type: 'lane.over-budget', lane: 'l1', step: 3, total: 6, budget: 5 }]);
  assert.equal(hasOverBudgetEvent(withEvent, 'l1'), true, '事件流含该 lane lane.over-budget → true');
  assert.equal(hasOverBudgetEvent(withEvent, 'l2'), false, '他 lane → false');
  assert.equal(hasOverBudgetEvent(makeBatch([], []), 'l1'), false, '空事件流 → false');
  // 同类型但非 lane.over-budget 的事件不误判
  const other = makeBatch([], [{ type: 'worktree.checkpoint', lane: 'l1' }]);
  assert.equal(hasOverBudgetEvent(other, 'l1'), false, 'worktree.checkpoint 不误判');
});

test('B5 step ≤ total 校验不变：laneProgressWrite 非法 progress 仍 throw /invalid laneProgress/', () => {
  // { step: 0, total: 3 }（step < 1）→ throw
  assert.throws(() => laneProgressWrite({}, 'l1', { step: 0, total: 3, status: 'running' }), /invalid laneProgress/);
  // step > total → throw
  assert.throws(() => laneProgressWrite({}, 'l1', { step: 4, total: 3, status: 'running' }), /invalid laneProgress/);
  // 缺 status（非 running|review）→ throw（既有校验不变）
  assert.throws(() => laneProgressWrite({}, 'l1', { step: 1, total: 3 }), /invalid laneProgress/);
  // 合法写仍工作：返回新 batch（不突变入参）+ 写 laneProgress[lane]
  const src = {};
  const next = laneProgressWrite(src, 'l1', { step: 1, total: 3, status: 'running' });
  assert.equal(next.laneProgress.l1.step, 1);
  assert.equal(next.laneProgress.l1.total, 3);
  assert.equal(src.laneProgress, undefined, '不突变入参');
});

// ---- 集成（可选，spec §单测要求注）：worktree 开关启用时 lane_checkpoint 超限 progress → 事件流恰好 1 条 ----
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-budget-'));
  const store = createStore(root);
  const ctx = { tools: { register: () => {} }, logger: console };
  const { tools } = createTools(ctx, {
    store, root,
    config: { capabilities: { worktree: { enabled: true } } },
  });
  return { root, store, byName: Object.fromEntries(tools.map((t) => [t.name, t])) };
}

test('B6 集成：lane_checkpoint 超限 progress → 事件流恰好 1 条 lane.over-budget（幂等）+ 不硬杀', async () => {
  const { root, store, byName } = setup();
  await byName.wave_plan.execute({ batchId: 'b-b1', tasks: [{ id: 'l1', checkpoint: { steps: 5 } }] }, EXEC_SESS);
  await byName.lane_worktree_create.execute({ batchId: 'b-b1', laneId: 'l1' }, EXEC_SESS);
  const lane = path.join(root, 'sessions', 'sess-budget', 'worktrees', 'b-b1', 'l1');
  const overBudgetEvents = () => store.readBatch('sess-budget', 'b-b1').events
    .filter((e) => e.type === 'lane.over-budget' && e.lane === 'l1');

  // 首次超限 checkpoint（total 6 > budget 5）→ 工具正常返回（不硬杀）+ 事件 1 条
  fs.writeFileSync(path.join(lane, 'a.txt'), 'over');
  const c1 = await byName.lane_checkpoint.execute({ batchId: 'b-b1', laneId: 'l1', message: 'over', progress: { step: 3, total: 6 } }, EXEC_SESS);
  assert.equal(c1.ok, true, '超限不硬杀：lane_checkpoint 照常返回成功');
  assert.equal(c1.committed, true);
  let ob = overBudgetEvents();
  assert.equal(ob.length, 1, '事件流恰好 1 条 lane.over-budget');
  assert.equal(ob[0].step, 3);
  assert.equal(ob[0].total, 6);
  assert.equal(ob[0].budget, 5);

  // 重复超限 progress → 幂等（仍 1 条，hasOverBudgetEvent 判据）
  fs.writeFileSync(path.join(lane, 'b.txt'), 'over again');
  const c2 = await byName.lane_checkpoint.execute({ batchId: 'b-b1', laneId: 'l1', message: 'over again', progress: { step: 5, total: 6 } }, EXEC_SESS);
  assert.equal(c2.ok, true);
  assert.equal(overBudgetEvents().length, 1, '幂等：重复超限 progress 不重复 appendEvent');

  // total ≤ budget（step 3/5）→ 不触发
  fs.writeFileSync(path.join(lane, 'c.txt'), 'within');
  const c3 = await byName.lane_checkpoint.execute({ batchId: 'b-b1', laneId: 'l1', message: 'within', progress: { step: 3, total: 5 } }, EXEC_SESS);
  assert.equal(c3.ok, true);
  assert.equal(overBudgetEvents().length, 1, 'total ≤ budget 不新增 lane.over-budget');
  // 未携带 progress → 不触发（现状行为不变）
  fs.writeFileSync(path.join(lane, 'd.txt'), 'plain');
  const c4 = await byName.lane_checkpoint.execute({ batchId: 'b-b1', laneId: 'l1', message: 'plain' }, EXEC_SESS);
  assert.equal(c4.ok, true);
  assert.equal(overBudgetEvents().length, 1, '无 progress → 不触发');
});

test('B6 集成：未声明 checkpoint.steps 的任务，超限 progress 零感知（不产生 lane.over-budget）', async () => {
  const { root, store, byName } = setup();
  await byName.wave_plan.execute({ batchId: 'b-b2', tasks: [{ id: 'l1' }] }, EXEC_SESS);
  await byName.lane_worktree_create.execute({ batchId: 'b-b2', laneId: 'l1' }, EXEC_SESS);
  const lane = path.join(root, 'sessions', 'sess-budget', 'worktrees', 'b-b2', 'l1');
  fs.writeFileSync(path.join(lane, 'a.txt'), 'x');
  const c = await byName.lane_checkpoint.execute({ batchId: 'b-b2', laneId: 'l1', message: 'no budget', progress: { step: 1, total: 100 } }, EXEC_SESS);
  assert.equal(c.ok, true);
  const batch = store.readBatch('sess-budget', 'b-b2');
  assert.equal(batch.events.some((e) => e.type === 'lane.over-budget'), false, '未声明 checkpoint.steps → 零感知');
});
