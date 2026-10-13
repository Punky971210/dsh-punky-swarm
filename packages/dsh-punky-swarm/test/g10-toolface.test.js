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

// G-10 工具面接线断言件（批 `g10-fix-20261012` · lane `e3-toolface`）——
//   判据源：`plan/scope.md` §6 的 `L-AC-9`（读端一致性：`handoff_view` 与门禁**同源** + 显式标注边来源）
//           与用户裁决 Q-H2（代交/声明留痕：补边必落**声明事件**，事后可审计）。
//
// 覆盖（三条，逐条给「修前 RED 口径 / 修后 GREEN 读数」）：
//   T1 视图同源：`handoff_view.edges` **不再只由 `deps` 生成**，而是取门禁侧同一单点
//      （`store.declaredInboundEdgesOf` = `lib/state/gates/helpers.ts#declaredInboundEdgesOf`）。
//      修前口径（复算 `deps.map(...)`）= 1 边且 `ready:true`；audit 的独立前像读数见
//      `audit/acceptance-report.md` §D（`viewEdgeCount:1` / `viewBlocking:[]` / `viewReady:true`，
//      而门禁侧 `declaredInboundEdgesOf` 已是 2 边）⇒ 本用例锁死「同源」。
//   T2 边来源标注：每条边带 `source`（`deps` / `accept`），渲染面显式出现 `[source=…]`（防审计误读）。
//   T3 声明留痕（Q-H2）：追加 lane 的 `plan.mutated` 载荷**逐条列出本次播种的入边声明**（`declared`），
//      且 `planRevision` 递增 ⇒ 数据面可区分「合法补边」与「手改批 JSON」。
//   T4 零回归：无 accept 边的批（纯 `deps`）⇒ 视图边集合与 `deps` **逐字相同**，仅多一个 `source` 键。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createStore } from '../lib/state/store.js';
import { createTools } from '../lib/tools/register.js';
import { buildWavePlan } from '../lib/wave-plan.js';

const SESSION = 'sess-g10-toolface';
const SESS = { agent: { session: { id: SESSION } } };
const SPEC_OK = '# spec\n## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准\n- x\n## 约束\n- y\n';

/** 临时根（交接门 entry+settle 双开，真源 = runtime.json）+ **真实装配的工具面**（`createTools` 同一入口）。 */
function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-g10-toolface-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'runtime.json'),
    JSON.stringify({ gates: { handoff: { entry: true, settle: true } } }, null, 2), 'utf8');
  const store = createStore(root);
  const ctx = { tools: { register: () => {} }, logger: { info() {}, warn() {}, error() {} } };
  const { tools } = createTools(ctx, { store, root, config: {} });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { root, store, byName };
}

const seed = (store, batchId, rel, body = 'out') => {
  const abs = path.join(store.artifactsDirOf(SESSION, batchId), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
};

const laneTaskOf = (store, batchId, lane) => {
  const b = store.readBatch(SESSION, batchId);
  for (const w of b.wavePlan ?? []) for (const t of w.tasks ?? []) if (t && t.id === lane) return t;
  return null;
};

/** 渲染面文本（与 `test/handoff-gate-hotconfig.test.js` 同一取法：`TEXT_OUTPUT` 返回块数组）。 */
const renderText = (tool, args, value) => (tool.output.render(args, value) ?? []).map((b) => b.text ?? '').join('\n');

/**
 * 三层批（p1 plan → e2 exec → a1 audit）+ **批运行中追加**后置 lane `e3`（deps 指向 plan 层 ⇒ 深度 1
 * ⇒ 声明序落在 `a1` 之前，`handoff_accept` 的 S-c 可过）。`e2 -> a1` 这条**建批期声明边**先行提交，
 * 使「门禁多出的一条 accept 边」成为唯一变量（复现 audit §D 的构型：视图 READY 但门禁已 BLOCKED）。
 */
function fixture(store, batchId, { withAccept = true } = {}) {
  const tasks = [
    { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 'plan' },
    { id: 'e2', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e2.md'], deps: ['p1'], cmd: 'build' },
    { id: 'a1', layer: 'audit', consume: ['plan/spec.md', 'exec/e2.md'], produce: ['audit/a1.md'], deps: ['e2'], cmd: 'verify' },
  ];
  store.createBatch(SESSION, { batchId, wavePlan: buildWavePlan({ batchId, tasks, team: null, concurrency: 5 }), phase: 'running' });
  seed(store, batchId, 'plan/spec.md', SPEC_OK);
  seed(store, batchId, 'exec/e2.md', 'out');
  seed(store, batchId, 'audit/a1.md', 'out');
  // 后置 lane：消费 **plan 层**产物（不撞既有 `GATE_CONSUME_DEPS_ASYMMETRY` 的强制域）
  store.addPoolTasks(SESSION, batchId, [
    { id: 'e3', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e3.md'], deps: ['p1'], cmd: 'late' },
  ], { reason: 'G-10 工具面用例：批运行中追加的后置 lane', author: 'test' });
  seed(store, batchId, 'exec/e3.md', 'late product');
  // 建批期已声明边（e2 -> a1）先行提交 ⇒ 该边不再是缺口（唯一变量 = 后加的 accept 边）
  const sub = store.recordHandoff(SESSION, batchId, {
    from: 'e2', to: 'a1', artifacts: ['exec/e2.md'], assertions: ['e2 产物可被 a1 直接消费'],
    caller: { sessionId: SESSION, from: 'e2' },
  });
  assert.equal(sub.ok, true, '前置：建批期已声明边须可提交（' + JSON.stringify(sub) + '）');
  if (withAccept) {
    const acc = store.recordHandoffAccept(SESSION, batchId, { from: 'e3', to: 'a1', reason: '下游接受后置上游', author: 'test' });
    assert.equal(acc.ok, true, '前置：下游接受后置上游须成立（' + JSON.stringify(acc) + '）');
  }
}

// ══ T1/T2：视图与门禁**同源** + 边来源显式标注（`L-AC-9`）══════════════════════════════════
test('G-10/T1 视图同源：accept 边在 handoff_view 中可见，且边集合 ≡ 门禁同一单点（修前口径 = 1 边）', async () => {
  const h = harness();
  try {
    fixture(h.store, 'v1');
    const b = h.store.readBatch(SESSION, 'v1');
    const t = laneTaskOf(h.store, 'v1', 'a1');
    // 门禁侧单点（entry 门 `handoffVerdictOf` 与 settle 出口门 `checkSettleHandoffGate` 的同一取值源）
    const gate = h.store.declaredInboundEdgesOf(b, 'a1', t);
    assert.deepEqual(gate.edges, ['e2', 'e3'], '前置：门禁侧「已声明入边」须含 accept 边');
    assert.deepEqual(gate.sources, [{ from: 'e2', source: 'deps' }, { from: 'e3', source: 'accept' }],
      '前置：逐边来源须由单点产出（deps / accept）');
    // 修前口径复算（旧实现 `const deps = …t.deps; deps.map(…)`）——用于对照，证「同源」不是同义反复
    const depsOnly = Array.isArray(t.deps) ? t.deps : [];
    assert.deepEqual(depsOnly, ['e2'], '修前口径：deps-only 投影 = 1 边（audit §D 的 viewEdgeCount:1 同形）');
    assert.notEqual(depsOnly.length, gate.edges.length, '修复前后读数必须可分（1 ≠ 2）');

    const view = await h.byName.handoff_view.execute({ batchId: 'v1', lane: 'a1' }, SESS);
    assert.deepEqual(view.edges.map((e) => e.from), gate.edges,
      '视图边集合必须 ≡ 门禁同一单点（禁第二套口径，红线 C-4）');
    assert.deepEqual(view.edges.map((e) => e.source), ['deps', 'accept'], 'T2：每条边须带来源标注');
    // 视图与门禁**同判**：accept 边未提交 ⇒ 该 lane 不可开工（修前视图 `ready:true` / `blocking:[]` 即分叉本体）
    assert.equal(view.ready, false, 'accept 边未提交 ⇒ 视图须与门禁同判为 BLOCKED');
    assert.ok(view.blocking.some((x) => x.includes('edge:e3->a1')), '缺口清单须点名该 accept 边：' + JSON.stringify(view.blocking));
    assert.ok(view.pending.includes('e3->a1'), 'pending 须点名该 accept 边：' + JSON.stringify(view.pending));
    assert.equal(view.deps.length, 1, '拓扑 `deps` 字段语义不变（仍只回显 deps 面，1 条）');
    // 渲染面显式标注（防审计误读：declare ≠ 建批期 deps）
    const text = renderText(h.byName.handoff_view, { batchId: 'v1', lane: 'a1' }, view);
    assert.match(text, /e3 → pending {2}\[source=accept\]/, '渲染面须显式标注 accept 边来源：' + text);
    assert.match(text, /e2 → submitted {2}\[source=deps\]/, '渲染面须显式标注 deps 边来源：' + text);
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test('G-10/T4 零回归：无 accept 边的批 ⇒ 视图边集合与 deps 逐字相同（仅多 source 键）', async () => {
  const h = harness();
  try {
    fixture(h.store, 'v2', { withAccept: false });
    const t = laneTaskOf(h.store, 'v2', 'a1');
    const view = await h.byName.handoff_view.execute({ batchId: 'v2', lane: 'a1' }, SESS);
    assert.deepEqual(view.edges.map((e) => e.from), t.deps, '无 accept 边 ⇒ 视图边集合 ≡ deps（逐字相同）');
    assert.deepEqual(view.edges.map((e) => e.source), ['deps'], '无 accept 边 ⇒ 来源恒 deps');
    assert.equal(view.ready, true, '建批期边已齐备 ⇒ 视图 READY（零回归）');
    assert.deepEqual(view.blocking, [], '零回归：无缺口');
    // 存量批（无 handoffs 字段）⇒ legacy 放行语义不变
    assert.equal(view.legacy, false, '新批（有 handoffs 面）⇒ 非 legacy');
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

// ══ T3：代交/声明留痕（用户裁决 Q-H2）══════════════════════════════════════════════════════
test('G-10/T3 声明留痕：追加 lane 的 plan.mutated 逐条列出播种的入边声明 + planRevision 递增', () => {
  const h = harness();
  try {
    const tasks = [
      { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 'plan' },
      { id: 'e2', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e2.md'], deps: ['p1'], cmd: 'build' },
      { id: 'a1', layer: 'audit', consume: ['plan/spec.md', 'exec/e2.md'], produce: ['audit/a1.md'], deps: ['e2'], cmd: 'verify' },
    ];
    h.store.createBatch(SESSION, { batchId: 't3', wavePlan: buildWavePlan({ batchId: 't3', tasks, team: null, concurrency: 5 }), phase: 'running' });
    const before = h.store.readBatch(SESSION, 't3');
    const rev0 = before.planRevision ?? 0;
    const b = h.store.addPoolTasks(SESSION, 't3', [
      { id: 'e3', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e3.md'], deps: ['p1'], cmd: 'late' },
    ], { reason: 'Q-H2 用例', author: 'test' });
    const mut = (b.events ?? []).filter((e) => e.type === 'plan.mutated');
    assert.equal(mut.length, 1, '追加 ⇒ 一条 plan.mutated');
    const evt = mut[0];
    assert.equal(b.planRevision, rev0 + 1, 'planRevision 递增（修订前后对照）');
    assert.equal(evt.revision, rev0 + 1, '事件侧 revision 同步');
    assert.deepEqual(evt.added, ['e3'], '既有载荷键逐字保留（零回归）');
    assert.equal(evt.reason, 'Q-H2 用例', '既有载荷键逐字保留（零回归）');
    // 本 lane 新增：**逐条**声明留痕（行形态与 `handoff-accept.js` 的 `accepts:[{from,to}]` 同形）
    assert.deepEqual(evt.declared, [{ from: 'p1', to: 'e3' }],
      '补边必须落**声明事件**：本次播种的入边须逐条列出（修前只有 `added:[laneId]` ⇒ 数据面形同手改 JSON）');
    // 与真源一致：事件里声明的边 ≡ `handoffs[e3]` 实际播种的条目
    assert.deepEqual(h.store.readBatch(SESSION, 't3').handoffs.e3.map((r) => ({ from: r.from, to: r.to })), evt.declared,
      '声明留痕必须与 `handoffs` 实际播种面同源（不是另写一份口径）');
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});
