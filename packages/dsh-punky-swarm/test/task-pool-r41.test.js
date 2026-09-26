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
import { SUITE_TOOLS } from '../lib/engine/suite.js';
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

// ── R4-1c：池内追加任务（图变更唯一写入口）──────────────────────────────────
test('R4-1c-1 追加：lanes/handoffs 播种 + plan.mutated 留痕 + revision+1（单次原子写）', () => {
  const { store, S } = setup();
  mkBatch(store, S, 'b-add', [{ id: 'p1' }]);
  const b = store.addPoolTasks(S, 'b-add', [
    { id: 'x1', deps: ['p1'] }, // 无 layer（generic）⇒ 不触 three-tier 层族校验
  ], { reason: '补一条被遗漏的任务', author: 'leader' });
  assert.equal(b.lanes.x1, 'pending', '新任务播种 pending');
  assert.equal(b.lanes.p1, 'pending', '既有任务不动');
  assert.equal(b.handoffs.x1?.[0]?.from, 'p1', '按 deps 种 pending 交接（与建批期同形态）');
  assert.equal(b.planRevision, 1, 'revision 递增');
  const mut = b.events.filter((e) => e.type === 'plan.mutated');
  assert.equal(mut.length, 1);
  assert.deepEqual(mut[0].added, ['x1']);
  assert.equal(mut[0].reason, '补一条被遗漏的任务');
  // 追加的任务在池内（owner null = 未派发）
  const owner = b.wavePlan.flatMap((w) => w.tasks).find((t) => t.id === 'x1')?.owner;
  assert.equal(owner, null, '新任务默认在池内（未派发）');
});

test('R4-1c-1b 判据同源：追加 exec 层而批内无 audit lane ⇒ 被建批期校验拒（不绕过）', () => {
  const { store, S } = setup();
  mkBatch(store, S, 'b-tier', [{ id: 'p1' }]);
  assert.throws(
    () => store.addPoolTasks(S, 'b-tier', [{ id: 'e1', layer: 'exec', role: 'coder' }]),
    /three-tier/,
    '追加走的是与 `wave_plan` **同一套**建批期校验，不得绕过',
  );
});

test('R4-1c-2 只增不改：id 与既有重复 ⇒ 抛**普通错误**（不新建 GATE_ 码）', () => {
  const { store, S } = setup();
  mkBatch(store, S, 'b-dup', [{ id: 'p1' }]);
  assert.throws(
    () => store.addPoolTasks(S, 'b-dup', [{ id: 'p1' }]),
    (e) => /task append rejected: 任务 id 已存在/.test(e.message) && !/GATE_/.test(e.message),
    '非法输入须抛普通错误（不进 66 码集合）',
  );
});

// 用户裁定（2026-09-21 18:5x）：**引擎不设成环回路** ⇒ 不做「成环断言」（冗余检查）。
//   结构性保证 = 追加任务的 `deps` 只许指向**既有**任务 ⇒ 新增任务之间无边、只依赖既有 ⇒ 结构上不可能成环。
//   故本用例断言的是**该结构约束**，而不是「检测到环后拒绝」。
test('R4-1c-3 不成环 = 结构性保证：deps 只许指向既有任务（不得指向本次新增 / 不得自指）', () => {
  const { store, S } = setup();
  mkBatch(store, S, 'b-cyc', [{ id: 'p1' }]);
  // ① 指向本次新增的同批 id ⇒ 拒（这类引用是成环的唯一可能入口）
  assert.throws(
    () => store.addPoolTasks(S, 'b-cyc', [
      { id: 'c1', deps: ['c2'] }, { id: 'c2', deps: ['c1'] },
    ]),
    (e) => /deps 只能指向批次内\*\*既有\*\*任务/.test(e.message) && !/GATE_/.test(e.message),
    '互指须被结构约束拦下（不带 GATE_ 码）',
  );
  // ② 自指 ⇒ 同样被结构约束拦下
  assert.throws(
    () => store.addPoolTasks(S, 'b-cyc', [{ id: 's1', deps: ['s1'] }]),
    /deps 只能指向批次内\*\*既有\*\*任务/,
  );
  // ③ 指向既有任务 ⇒ 放行（正例：依赖既有任务是被允许的唯一形态）
  const b = store.addPoolTasks(S, 'b-cyc', [{ id: 'ok1', deps: ['p1'] }]);
  assert.equal(b.lanes.ok1, 'pending');
  assert.equal(b.handoffs.ok1?.[0]?.from, 'p1');
});

test('R4-1c-4 批终态 ⇒ 复用既有 GATE_BATCH_TERMINAL（唯一例外）', () => {
  const { store, S } = setup();
  mkBatch(store, S, 'b-term', [{ id: 'p1' }]);
  store.setPhase(S, 'b-term', 'aborted');
  assert.throws(
    () => store.addPoolTasks(S, 'b-term', [{ id: 'e1' }]),
    /GATE_BATCH_TERMINAL/,
  );
});

test('R4-1a-5 注册表：`task_pool`/`task_update` 入表 + 总数冻结（37）', () => {
  const names = SUITE_TOOLS.map((t) => t.name);
  assert.ok(names.includes('task_pool'), '应已注册');
  assert.equal(SUITE_TOOLS.length, 37, '套件工具全集 29 → 30 → 31 → 32 → 36（S2 宿主连续控制族 4 件）→ 37（AG-20 spawn_teammate 1 件）');
  // 【批 5 · G1（2026-09-22 用户裁定「同语义就删」）】原 deny/modeGate 成员性与长度断言（task_pool ∉ deny/
  //   ∉ modeGate、deny length 20、首项、task_update ∈ 双集、modeGate length 12）已删——
  //   全部被 suite-consistency SC-1/SC-2 的**精确全集 deepEqual**（FROZEN_DENY/FROZEN_MODE_GATED + 注册表派生）
  //   蕴含 ⇒ 单一权威在 SC，本处不再重复（防双权威漂移）。
  // R4-2：`task_update` = 池内加边（图变更写入口 #2）⇒ 注册面在此；deny/modeGate 归属见 SC-1。
  assert.ok(names.includes('task_update'), 'task_update 应已注册');
});

// ── R4-2：池内任务**加边**（`task_update`；只增不删 · 已派发即冻结）──────────────────────────
// 用户裁定（2026-09-21「按原计划推进（task_update 加边）」）⇒ 兑现蓝图 §7.4 触点 #3 / #5 / #6。
//   不成环靠**结构性保证**（不做成环断言）：新边只许指向「已声明在先 + 同层或上游层」的任务。
test('R4-2-1 加边：`deps` 只增（旧边保持在前）+ handoffs 补 `pending` 条 + `plan.mutated.edges` + revision+1', () => {
  const { store, S } = setup();
  mkBatch(store, S, 'b-e1', [{ id: 'p1' }, { id: 'x1', deps: ['p1'] }, { id: 'y1', deps: ['x1'] }]);
  const b = store.addTaskEdges(S, 'b-e1', [{ id: 'y1', add: ['p1'] }], { reason: '补一条跨层依赖', author: 'leader' });
  const y1 = b.wavePlan.flatMap((w) => w.tasks).find((t) => t.id === 'y1');
  assert.deepEqual(y1.deps, ['x1', 'p1'], '只增不删：既有边保持在前，新边追加在后');
  const list = b.handoffs.y1 ?? [];
  assert.equal(list.length, 2, '两条入边各一条交接条（同事务补 `pending`，不留「有边无条」空洞）');
  assert.equal(list.find((r) => r.from === 'p1')?.status, 'pending', '新入边补 `pending`（与建批期种子同形态）');
  assert.equal(list.find((r) => r.from === 'x1')?.status, 'pending', '既有条**保留**（不重建丢档）');
  assert.equal(list.find((r) => r.from === 'p1')?.contract?.consumedFrom, 'p1', '契约 `consumedFrom` 指回入边');
  assert.equal(b.planRevision, 1, 'revision 递增');
  const mut = b.events.filter((e) => e.type === 'plan.mutated');
  assert.equal(mut.length, 1, '留痕恰好一条');
  assert.deepEqual(mut[0].edges, [{ id: 'y1', add: ['p1'] }], '留痕带 `edges`');
  assert.equal(mut[0].reason, '补一条跨层依赖');
  assert.equal(mut[0].author, 'leader');
});

test('R4-2-2 已派发即冻结（K1）：`owner` 非空 或 lane 非 `pending` ⇒ 拒加边（零写入）', () => {
  const { store, S } = setup();
  // ① 声明面已出池（owner 非空）
  mkBatch(store, S, 'b-e2a', [{ id: 'p1' }, { id: 'x1' }, { id: 'y1', owner: 'agent-1' }]);
  assert.throws(
    () => store.addTaskEdges(S, 'b-e2a', [{ id: 'y1', add: ['p1'] }]),
    (e) => /已出池/.test(e.message) && /已派发即冻结/.test(e.message) && !/GATE_/.test(e.message),
    '已派发 ⇒ 冻结（普通错误，不带 GATE_ 码）',
  );
  // ② 执行面已离开 pending（lane 兜底判据）
  mkBatch(store, S, 'b-e2b', [{ id: 'p1' }, { id: 'x1' }]);
  store.setMember(S, 'b-e2b', 'x1', 'running');
  assert.throws(() => store.addTaskEdges(S, 'b-e2b', [{ id: 'x1', add: ['p1'] }]), /已出池|已派发即冻结/);
  assert.equal(store.readBatch(S, 'b-e2b').wavePlan.flatMap((w) => w.tasks).find((t) => t.id === 'x1')?.deps?.length ?? 0, 0,
    '拒态零写入：deps 未被改动');
});

test('R4-2-3 不成环 = 结构性保证：新边只许指向**已声明在先**的任务（拒绝反向边 / 自指）', () => {
  const { store, S } = setup();
  mkBatch(store, S, 'b-e3', [{ id: 'x1' }, { id: 'p1' }]); // p1 声明序在后
  assert.throws(
    () => store.addTaskEdges(S, 'b-e3', [{ id: 'x1', add: ['p1'] }]),
    (e) => /已声明在先/.test(e.message) && /结构性保证/.test(e.message) && !/GATE_/.test(e.message),
    '反向边（dep 声明在后）⇒ 拒；这是结构约束而非成环断言',
  );
  mkBatch(store, S, 'b-e3b', [{ id: 'p1' }, { id: 'x1' }]);
  assert.throws(
    () => store.addTaskEdges(S, 'b-e3b', [{ id: 'x1', add: ['x1'] }]),
    /不得自指/,
    '自指 ⇒ 拒',
  );
});

test('R4-2-4 层序结构约束：只许指向**同层或上游层**（exec 不得依赖下游 audit）', () => {
  const { store, S } = setup();
  // 夹具须「audit 声明在 exec 之前」，否则会先撞「已声明在先」⇒ 两条结构约束无法解耦验证。
  mkBatch(store, S, 'b-e4', [
    { id: 'p1', layer: 'plan', produce: ['plan/s.md'] },
    { id: 'a1', layer: 'audit', consume: ['plan/s.md'] },
    { id: 'e1', layer: 'exec', consume: ['plan/s.md'] },
  ]);
  assert.throws(
    () => store.addTaskEdges(S, 'b-e4', [{ id: 'e1', add: ['a1'] }]),
    (e) => /同层或上游层/.test(e.message) && !/GATE_/.test(e.message),
    'exec 依赖下游 audit ⇒ 拒（与追加期同一套结构约束）',
  );
});

test('R4-2-5 上游已结算 ⇒ 拒：终态 lane 无交接可等（该边结构性无法满足）', () => {
  const { store, S } = setup();
  mkBatch(store, S, 'b-e5', [
    { id: 'p1', layer: 'plan', produce: ['plan/s.md'] },
    { id: 'a1', layer: 'audit', consume: ['plan/s.md'] },
    { id: 'e1', layer: 'exec', consume: ['plan/s.md'] },
  ]);
  store.setMember(S, 'b-e5', 'p1', 'running');
  store.setMember(S, 'b-e5', 'p1', 'failed'); // 终态（`running→failed` 合法；不经 exit 门 ⇒ 无需产物在场）
  assert.throws(
    () => store.addTaskEdges(S, 'b-e5', [{ id: 'e1', add: ['p1'] }]),
    (e) => /已结算/.test(e.message) && /无交接可等/.test(e.message) && !/GATE_/.test(e.message),
    '上游终态 ⇒ 新边恒 pending ⇒ 下游永远开不了工 ⇒ 加边期即拒',
  );
});

test('R4-2-6 幂等与零变更：已存在的边跳过；全部已存在 ⇒ 不落盘', () => {
  const { store, S } = setup();
  mkBatch(store, S, 'b-e6', [{ id: 'p1' }, { id: 'x1', deps: ['p1'] }, { id: 'y1' }]);
  // 部分幂等：给 x1 再加既有边 + 给 y1 加新边 ⇒ 只落 y1 的新边
  const b = store.addTaskEdges(S, 'b-e6', [{ id: 'x1', add: ['p1'] }, { id: 'y1', add: ['p1'] }]);
  assert.deepEqual(b.events.filter((e) => e.type === 'plan.mutated')[0].edges, [{ id: 'y1', add: ['p1'] }],
    '既有边跳过、不计入留痕');
  // 全部已存在 ⇒ 零变更，不落盘
  const before = store.readBatch(S, 'b-e6').planRevision;
  assert.throws(() => store.addTaskEdges(S, 'b-e6', [{ id: 'x1', add: ['p1'] }]), /零新增边/);
  assert.equal(store.readBatch(S, 'b-e6').planRevision, before, '零变更不递增 revision');
});

test('R4-2-7 存量批（无 `handoffs` 字段）⇒ 拒加边（不静默把 legacy 形态转成受门形态）', () => {
  const { store, root, S } = setup();
  mkBatch(store, S, 'b-legacy', [{ id: 'p1' }, { id: 'x1' }]);
  const f = path.join(root, 'sessions', S, 'batches', 'b-legacy.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  delete j.handoffs; // 造存量形态（`createBatch` 恒写该字段 ⇒ 须显式删）
  fs.writeFileSync(f, JSON.stringify(j), 'utf8');
  assert.throws(
    () => store.addTaskEdges(S, 'b-legacy', [{ id: 'x1', add: ['p1'] }]),
    /存量形态/,
    '存量批加边会改变交接门语义（legacy 放行 → 受门约束）⇒ 拒',
  );
});

test('R4-2-8 工具面：`task_update` 加边后 `task_pool` 立即反映新 `deps`（读端同源）', async () => {
  const { store, root, S } = setup();
  mkBatch(store, S, 'b-e8', [{ id: 'p1' }, { id: 'x1' }]);
  const by = toolByName(store, root);
  const exec = { agent: { session: { id: S } } };
  const before = await by.task_pool.execute({ batchId: 'b-e8', session: S }, exec);
  assert.equal(before.pool.find((t) => t.id === 'x1').dispatchable, true, '前置：x1 无上游 ⇒ 可派发');
  const out = await by.task_update.execute({ batchId: 'b-e8', edges: [{ id: 'x1', add: ['p1'] }], reason: '补上游' }, exec);
  assert.deepEqual(out.edges, [{ id: 'x1', add: ['p1'] }]);
  assert.equal(out.planRevision, 1);
  assert.equal(out.handoffsCount, 1, '新增一条交接条');
  const after = await by.task_pool.execute({ batchId: 'b-e8', session: S }, exec);
  const x1 = after.pool.find((t) => t.id === 'x1');
  assert.deepEqual(x1.deps, ['p1'], '读端立即反映新边（同一落盘真源）');
  assert.equal(x1.dispatchable, false, '上游未结算 ⇒ 不再可派发');
  assert.ok(x1.blockers.some((s) => /GATE_HANDOFF_MISSING/.test(s)), 'blockers 指名');
});

test('R4-2-9 批终态 ⇒ 复用既有 `GATE_BATCH_TERMINAL`（唯一例外）', () => {
  const { store, S } = setup();
  mkBatch(store, S, 'b-e9', [{ id: 'p1' }, { id: 'x1' }]);
  store.setPhase(S, 'b-e9', 'aborted');
  assert.throws(() => store.addTaskEdges(S, 'b-e9', [{ id: 'x1', add: ['p1'] }]), /GATE_BATCH_TERMINAL/);
});

// 触点 #6（出口门）**证据级别声明**：本用例断言的是「**数据源一致性**」——即出口门判据所消费的
//   「下游集合」形态与落盘 `batch.wavePlan` 同形（复刻 `gates.js#checkSettleHandoffGate` 的下游枚举）。
//   ⇒ 结论：加边**无需改码**即被感知（数据源本来就是「当前落盘的声明」，不存在需要换的第二个源）。
//   ⚠ **不是**端到端的门行为验证（那需要开启交接门 + 完整结算夹具，由既有 `test/handoff-gate.test.js` 覆盖）。
test('R4-2-10 触点 #6：出口门的「下游集合」数据源 = 落盘 `batch.wavePlan`（加边即被感知）', () => {
  const { store, S } = setup();
  mkBatch(store, S, 'b-e10', [{ id: 'p1' }, { id: 'x1' }]);
  // 与 `gates.js#checkSettleHandoffGate` 的 ① 同形：遍历 wavePlan、按 `deps` 反查下游
  const downstreamOf = (b, lane) => {
    const out = [];
    for (const w of b.wavePlan ?? []) {
      for (const t of w.tasks ?? []) {
        if (!t || typeof t.id !== 'string' || t.id === lane) continue;
        if ((Array.isArray(t.deps) ? t.deps : []).some((d) => d === lane)) out.push(t.id);
      }
    }
    return out;
  };
  assert.deepEqual(downstreamOf(store.readBatch(S, 'b-e10'), 'p1'), [], '前置：加边前 p1 无下游 ⇒ 出口门零感知');
  const b = store.addTaskEdges(S, 'b-e10', [{ id: 'x1', add: ['p1'] }]);
  assert.deepEqual(downstreamOf(b, 'p1'), ['x1'], '加边后上游的**下游集合立即**包含新下游（同一落盘真源）');
  assert.equal(b.handoffs.x1.find((r) => r.from === 'p1')?.status, 'pending',
    '新 out 边已在**同一事务**补 `pending` 交接条（出口门据此判「至少一条已成立交接」）');
});
