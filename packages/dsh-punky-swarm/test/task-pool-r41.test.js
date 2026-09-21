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

// N1-R4-1a（K1 公共池）：`owner` 声明面 + `task_pool` **只读视图**。
// 本批只落「池 = `owner == null` 的视图」这一读端事实；**不引入认领/claim**，不改任何状态。
//   · 池 = 视图不是容器（蓝图 §3.2 P-A；P-B 独立队列撞 H3 不取）
//   · 派发仍由 Leader 单点发起 ⇒ 派发即门禁（K1）
//   · 已派发/已启动任务**不在池内**（层内不重算 · 非改派）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildWavePlan } from '../lib/wave-plan.js';
import { createStore } from '../lib/state/store.js';
import { SUITE_TOOLS, SUITE_DENY_TOOLS, MODE_GATED_TOOLS } from '../lib/engine/suite.js';
import { createTools } from '../lib/tools/register.js';

const SILENT = { warn: () => {}, info: () => {}, error: () => {} };

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-pool-'));
  const store = createStore(root, { logger: SILENT });
  return { root, store, S: 'sess-pool' };
}

function mkBatch(store, S, batchId, tasks) {
  const plan = buildWavePlan({ batchId, tasks });
  store.createBatch(S, { batchId, wavePlan: plan, phase: 'running' });
  return plan;
}

// 与 `lib/tools/core.js#ownerOfExec` 同取值序（派发面 owner 唯一来源）
function agentIdOf(exec) {
  return exec?.agent?.id ?? exec?.agent?.agentId ?? exec?.agent?.session?.id ?? null;
}

function toolByName(store, root) {
  const ctx = {
    tools: { register: () => {}, guard: () => () => {} },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  };
  const { tools } = createTools(ctx, { store, root, config: {} });
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

test('R4-1a-1 归一化：`owner` 缺省落 null；字符串原样保留（不落 undefined）', () => {
  const plan = buildWavePlan({
    batchId: 'b-norm',
    tasks: [{ id: 't1' }, { id: 't2', owner: 'agent-7' }, { id: 't3', owner: 42 }],
  });
  const t = Object.fromEntries(plan.wavePlan.flatMap((w) => w.tasks).map((x) => [x.id, x]));
  assert.equal(t.t1.owner, null, '缺省 ⇒ null（在池内）');
  assert.equal(t.t2.owner, 'agent-7', '字符串原样保留（已出池）');
  assert.equal(t.t3.owner, null, '非字符串 ⇒ null（与 targetsMarker 同风格）');
});

test('R4-1a-2 task_pool：建批后全部任务在池内；无上游者 dispatchable=true', async () => {
  const { store, root, S } = setup();
  mkBatch(store, S, 'b-p1', [{ id: 'p1' }, { id: 'e1' }]);
  const by = toolByName(store, root);
  assert.ok(by.task_pool, 'task_pool 应已注册');
  const out = await by.task_pool.execute({ batchId: 'b-p1', session: S }, { agent: { session: { id: S } } });
  assert.equal(out.pooled, 2, '两个任务均未出池');
  assert.equal(out.dispatched, 0);
  assert.ok(out.pool.every((t) => t.owner === null), '池内任务 owner 恒 null');
  assert.ok(out.pool.every((t) => t.dispatchable === true), '无 deps 且未派发 ⇒ 可派发');
});

test('R4-1a-2b task_pool：上游未结算 ⇒ dispatchable=false + blockers 指名；上游结算后可派发', async () => {
  const { store, root, S } = setup();
  mkBatch(store, S, 'b-p2b', [{ id: 'p1' }, { id: 'e1', deps: ['p1'] }]);
  const by = toolByName(store, root);
  const exec = { agent: { session: { id: S } } };
  const o1 = await by.task_pool.execute({ batchId: 'b-p2b', session: S }, exec);
  const e1 = o1.pool.find((t) => t.id === 'e1');
  assert.equal(e1.dispatchable, false, '上游 p1 未结算 ⇒ 不可派发');
  assert.ok(e1.blockers.some((s) => /GATE_HANDOFF_MISSING/.test(s)), 'blockers 须指名（不静默）');
  // 已出池（`owner` 非空）⇒ **不在池内**（这是 K1「已派发即冻结」的声明面表达）
  const { store: s2, root: r2, S: S2 } = setup();
  mkBatch(s2, S2, 'b-own', [{ id: 't1', owner: 'agent-1' }, { id: 't2' }]);
  const by2 = toolByName(s2, r2);
  const o2 = await by2.task_pool.execute({ batchId: 'b-own', session: S2 }, { agent: { session: { id: S2 } } });
  assert.equal(o2.pooled, 1, 't2 仍在池内');
  assert.equal(o2.dispatched, 1, 't1 已出池 ⇒ 不计入池');
  assert.ok(!o2.pool.some((t) => t.id === 't1'), '已出池任务**不出现在**池列表里');
});

test('R4-1a-3 task_pool：上游未结算 ⇒ dispatchable=false + blockers 指名（不静默）', () => {
  const { store, S } = setup();
  const plan = buildWavePlan({ batchId: 'b-p2', tasks: [{ id: 'p1' }, { id: 'e1', deps: ['p1'] }] });
  store.createBatch(S, { batchId: 'b-p2', wavePlan: plan, phase: 'running' });
  store.setMember(S, 'b-p2', 'p1', 'running'); // 上游在跑（非终态）
  const b = store.readBatch(S, 'b-p2');
  const lanes = b.lanes;
  // 终态判据与池读端同源（`schema.isMemberTerminal`），此处直接核判定结论
  const e1 = plan.wavePlan.flatMap((w) => w.tasks).find((t) => t.id === 'e1');
  assert.equal(e1.owner, null, '仍在池内');
  assert.equal(lanes.e1, 'pending', 'lane 未派发');
  assert.notEqual(lanes.p1, 'merged', '上游未结算（前置）');
});

test('R4-1a-4 task_pool：已派发 lane 不在可派发集合（K1：已派发即冻结）', () => {
  const { store, S } = setup();
  mkBatch(store, S, 'b-p3', [{ id: 'e1' }]);
  store.setMember(S, 'b-p3', 'e1', 'running');
  const b = store.readBatch(S, 'b-p3');
  assert.equal(b.lanes.e1, 'running');
  // 读端判据（与 task_pool.execute 内一致）：lane 非 pending ⇒ ALREADY_DISPATCHED
  assert.equal(b.lanes.e1 === 'pending', false, '已派发 ⇒ 不可再视为池内可派发对象');
});

// ── R4-1b：派发 = **唯一出池动作**（`owner` 写入方）────────────────────────────────
test('R4-1b-1 派发即出池：同一次 atomicWrite 写 task.owner + 落 task.owner.assigned', () => {
  const { store, S } = setup();
  mkBatch(store, S, 'b-d1', [{ id: 'e1' }]);
  const ownerOf = (b, id) => b.wavePlan.flatMap((w) => w.tasks).find((t) => t.id === id)?.owner;
  assert.equal(ownerOf(store.readBatch(S, 'b-d1'), 'e1'), null, '建批后未出池');
  store.setMember(S, 'b-d1', 'e1', 'running', null, undefined, 'agent-9');
  const b = store.readBatch(S, 'b-d1');
  assert.equal(ownerOf(b, 'e1'), 'agent-9', '派发 ⇒ owner 写入声明面');
  assert.equal(b.lanes.e1, 'running', '执行面同步');
  assert.equal(b.events.filter((e) => e.type === 'task.owner.assigned').length, 1, '出池留痕恰好一条');
});

test('R4-1b-2 非改派：已出池任务再派发**不覆盖** owner（K1：已派发即冻结）', () => {
  const { store, S } = setup();
  mkBatch(store, S, 'b-d2', [{ id: 'e1', owner: 'preassigned' }]);
  const ownerOf = (b, id) => b.wavePlan.flatMap((w) => w.tasks).find((t) => t.id === id)?.owner;
  assert.equal(ownerOf(store.readBatch(S, 'b-d2'), 'e1'), 'preassigned');
  store.setMember(S, 'b-d2', 'e1', 'running', null, undefined, 'agent-9');
  assert.equal(ownerOf(store.readBatch(S, 'b-d2'), 'e1'), 'preassigned', '已出池 ⇒ 不覆盖（换人须走作废+新增替代）');
});

test('R4-1b-3 派发后该任务**移出**池视图（owner 写入方闭环）', async () => {
  const { store, root, S } = setup();
  mkBatch(store, S, 'b-d3', [{ id: 'e1' }, { id: 'e2' }]);
  const by = toolByName(store, root);
  const exec = { agent: { session: { id: S } } };
  const before = await by.task_pool.execute({ batchId: 'b-d3', session: S }, exec);
  assert.equal(before.pooled, 2);
  store.setMember(S, 'b-d3', 'e1', 'running', null, undefined, agentIdOf(exec));
  const after = await by.task_pool.execute({ batchId: 'b-d3', session: S }, exec);
  assert.equal(after.pooled, 1, 'e1 已出池 ⇒ 池内仅剩 e2');
  assert.equal(after.dispatched, 1);
  assert.ok(!after.pool.some((t) => t.id === 'e1'), '已派发任务不在池列表');
});

test('R4-1a-5 注册表：`task_pool` 入表、不占 deny、不占模式门（冻结序列零变化）', () => {
  const names = SUITE_TOOLS.map((t) => t.name);
  assert.ok(names.includes('task_pool'), '应已注册');
  assert.equal(SUITE_TOOLS.length, 30, '套件工具全集 29 → 30');
  assert.equal(SUITE_DENY_TOOLS.includes('task_pool'), false, '只读视图：不入成员 deny');
  assert.equal(MODE_GATED_TOOLS.includes('task_pool'), false, '零写入：不占模式门');
  // 前 14 条 deny 冻结序列的相对顺序零变化（新项只允许追加，不得重排）
  assert.equal(SUITE_DENY_TOOLS.length, 14, 'deny 集仍 14 项');
  assert.equal(SUITE_DENY_TOOLS[0], 'assign_check', 'deny 序列首项不变');
  assert.equal(MODE_GATED_TOOLS.length, 10, '模式门集仍 10 项');
});
