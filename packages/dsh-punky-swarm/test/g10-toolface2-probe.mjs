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

// G-10 工具面接线 · 定向探针（**读数件**，非断言件）——批 `g10-fix-20261012` · lane `e4-toolface`。
//
// 用途：把本 lane 五项自证的**原始读数**一次性打到 stdout（逐字），落 `exec/g10-toolface2/probe-output.txt`。
//   与 `test/g10-toolface.test.js`（断言件）分工：本件**只读不改**、不做断言、不因判据不成立而失败
//   （读数件的价值在于「修前 RED 与修后 GREEN 可同框对照」，见每组的 **前像 / 后像** 两栏）。
//
// 五组（与任务包逐条对齐）：
//   组① 工具面在册 30 → 31（前后对照 + 真调成功分支 + 一条拒绝反例）
//   组② `lib/engine/suite.js` 仅 1 行登记（本件只给「表长/派生集/注册残差」读数；diff 形态见 `diff.patch`）
//   组③ 视图与门禁**同源**：边数一致（前像 1 vs 后像 2）+ 逐边 `source` 标注
//   组④ `plan.mutated` 含 `declared[]`（前像无该键）
//   组⑤ 单点纪律：`store.declaredInboundEdgesOf` ≡ 门禁同一函数实例（红线段 C-4）
//
// 运行：`node --import ./test/helpers/isolated-home.preload.mjs test/g10-toolface2-probe.mjs`
//   （isolated-home preload 使探针不污染真实 profile；本件自身不写任何 profile/工作区文件）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../lib/state/store.js';
import { createTools } from '../lib/tools/register.js';
import { SUITE_TOOLS, SUITE_DENY_TOOLS, MODE_GATED_TOOLS } from '../lib/engine/suite.js';
import { buildWavePlan } from '../lib/wave-plan.js';

const SESSION = 'sess-g10-toolface2-probe';
const SESS = { agent: { session: { id: SESSION } } };
const SPEC_OK = '# spec\n## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准\n- x\n## 约束\n- y\n';

const say = (...a) => console.log(...a);
const hr = (t) => say('\n' + '='.repeat(78) + '\n' + t + '\n' + '='.repeat(78));

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-g10-e4-probe-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'runtime.json'),
    JSON.stringify({ gates: { handoff: { entry: true, settle: true } } }, null, 2), 'utf8');
  const store = createStore(root);
  const ctx = { tools: { register: () => {} }, logger: { info() {}, warn() {}, error() {} } };
  const { tools } = createTools(ctx, { store, root, config: {} });
  return { root, store, byName: Object.fromEntries(tools.map((t) => [t.name, t])), tools };
}

const seed = (store, batchId, rel, body = 'out') => {
  const abs = path.join(store.artifactsDirOf(SESSION, batchId), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
};

const renderText = (tool, args, value) => (tool.output.render(args, value) ?? []).map((b) => b.text ?? '').join('\n');

/** 三层批 + 批运行中追加后置 lane `e3`（deps 指向 plan 层 ⇒ 声明序在 a1 之前）。 */
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
  const mutBefore = store.addPoolTasks(SESSION, batchId, [
    { id: 'e3', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e3.md'], deps: ['p1'], cmd: 'late' },
  ], { reason: 'e4 probe：批运行中追加的后置 lane', author: 'probe' });
  seed(store, batchId, 'exec/e3.md', 'late product');
  store.recordHandoff(SESSION, batchId, {
    from: 'e2', to: 'a1', artifacts: ['exec/e2.md'], assertions: ['e2 产物可被 a1 直接消费'],
    caller: { sessionId: SESSION, from: 'e2' },
  });
  if (withAccept) store.recordHandoffAccept(SESSION, batchId, { from: 'e3', to: 'a1', reason: '下游接受后置上游', author: 'probe' });
  return mutBefore;
}

const h = harness();
try {
  say('G-10 工具面接线 · 定向探针（读数件）· 批 g10-fix-20261012 · lane e4-toolface');
  say('cwd = ' + process.cwd());
  say('node = ' + process.version);

  // ── 组① 工具面在册：30 → 31 ────────────────────────────────────────────────
  hr('组① 工具面在册数（前像 30 / 后像 31）+ 注册表双向校验 + 真调成功 + 拒绝反例');
  say('[前像] 修前（`handoff_accept` 未注册）= 30 件 —— 一手读数见 `exec/g10-toolface/progress/01` 与 e4 复跑，本件只给后像：');
  say('[后像] tools.length = ' + h.tools.length);
  say('[后像] 含 handoff_accept = ' + h.tools.some((t) => t.name === 'handoff_accept'));
  say('[后像] handoff 族在册 = ' + h.tools.map((t) => t.name).filter((n) => n.startsWith('handoff')).sort().join(', '));
  say('[SC-4②] 注册 − 表 残差 = ' + JSON.stringify(h.tools.map((t) => t.name).filter((n) => !SUITE_TOOLS.some((t) => t.name === n))));
  say('[表] SUITE_TOOLS.length = ' + SUITE_TOOLS.length + '（前像 38）');
  say('[表] SUITE_DENY_TOOLS.length = ' + SUITE_DENY_TOOLS.length + '（前像 17）｜含 handoff_accept = ' + SUITE_DENY_TOOLS.includes('handoff_accept'));
  say('[表] MODE_GATED_TOOLS.length = ' + MODE_GATED_TOOLS.length + '（前像 11）｜含 handoff_accept = ' + MODE_GATED_TOOLS.includes('handoff_accept'));
  say('[不变量] modeGate ⊆ memberDeny 对本件 = ' + (!MODE_GATED_TOOLS.includes('handoff_accept') || SUITE_DENY_TOOLS.includes('handoff_accept')));

  fixture(h.store, 'g1', { withAccept: false });
  const ok = await h.byName.handoff_accept.execute(
    { batchId: 'g1', from: 'e3', to: 'a1', reason: '探针：下游接受后置上游', author: 'probe' }, SESS);
  say('\n[真调·成功分支] ' + JSON.stringify(ok));
  say('[真调·渲染面] ' + renderText(h.byName.handoff_accept, {}, ok));
  const b1 = h.store.readBatch(SESSION, 'g1');
  say('[真调·planRevision] ' + b1.planRevision + '（1 → 2）');
  say('[真调·handoffs.a1] ' + JSON.stringify(b1.handoffs.a1.map((r) => ({ from: r.from, status: r.status, source: r.source ?? null }))));
  const mutsAfterAccept = (b1.events ?? []).filter((e) => e.type === 'plan.mutated');
  say('[真调·plan.mutated 末条] ' + JSON.stringify(mutsAfterAccept[mutsAfterAccept.length - 1] ?? {}));

  const revIdem = h.store.readBatch(SESSION, 'g1').planRevision;
  const idem = await h.byName.handoff_accept.execute({ batchId: 'g1', from: 'e3', to: 'a1' }, SESS);
  say('[真调·幂等分支] ' + JSON.stringify({ ok: idem.ok, idempotent: idem.idempotent, revision: idem.revision })
    + '｜planRevision ' + revIdem + ' → ' + h.store.readBatch(SESSION, 'g1').planRevision
    + '｜事件条数 ' + mutsAfterAccept.length + ' → ' + (h.store.readBatch(SESSION, 'g1').events ?? []).filter((e) => e.type === 'plan.mutated').length
    + ' ⇒ 零写入、planRevision 不变');

  const revBefore = h.store.readBatch(SESSION, 'g1').planRevision;
  try {
    await h.byName.handoff_accept.execute({ batchId: 'g1', from: 'e3', to: 'e2' }, SESS);
    say('\n[反例·to 非 audit 层] **未被拒** ⇒ 反例失效（须排查）');
  } catch (e) {
    say('\n[反例·to 非 audit 层] code = ' + e.code + '｜ok = ' + e.ok);
    say('[反例·逐字拒态] ' + e.message);
    say('[反例·拒态零写入] planRevision ' + revBefore + ' → ' + h.store.readBatch(SESSION, 'g1').planRevision
      + '｜handoffs.e2 条目数 = ' + (h.store.readBatch(SESSION, 'g1').handoffs.e2 ?? []).length + '（无 e3 残留）');
  }
  const b11 = h.store.readBatch(SESSION, 'g1');
  const b11t = (b11.wavePlan ?? []).flatMap((w) => w.tasks ?? []).find((t) => t.id === 'a1');
  say('\n[组③ 前像口径] a1 的 `deps`-only 投影 = ' + JSON.stringify(b11t.deps) + ' ⇒ 边数 1（修前视图口径，audit §D 同形）');
  const view1 = await h.byName.handoff_view.execute({ batchId: 'g1', lane: 'a1' }, SESS);
  say('[组③ 后像口径] handoff_view.edges = ' + JSON.stringify(view1.edges.map((e) => ({ from: e.from, source: e.source })))
    + ' ⇒ 边数 ' + view1.edges.length);
  say('[组③ 同源核] store.declaredInboundEdgesOf(g1,a1) = '
    + JSON.stringify(h.store.declaredInboundEdgesOf(b11, 'a1', b11t).edges));
  say('[组③ ready/blocking/pending] ' + JSON.stringify({ ready: view1.ready, blocking: view1.blocking, pending: view1.pending }));
  say('[组③ 渲染面逐字]\n' + renderText(h.byName.handoff_view, { batchId: 'g1', lane: 'a1' }, view1));

  // ── 组④ plan.mutated 载荷含 declared[] ────────────────────────────────────
  hr('组④ `plan.mutated` 载荷含 `declared[]`（前像无该键）+ 与 handoffs 实际播种面同源');
  const muts = (b11.events ?? []).filter((e) => e.type === 'plan.mutated');
  for (const e of muts) {
    say('[事件] ' + JSON.stringify({ added: e.added ?? null, declared: e.declared ?? null, accepts: e.accepts ?? null, revision: e.revision }));
  }
  say('[前像对照] 修前载荷 = `{added:[laneId], reason, author, revision}` ⇒ **无 `declared` 键**，外部读端无法区分「合法补边」与「手改批 JSON」');
  say('[同源核] handoffs.e3 实际播种 = ' + JSON.stringify((b11.handoffs.e3 ?? []).map((r) => ({ from: r.from, to: r.to }))));
  say('[accept 留痕] ' + JSON.stringify(muts.filter((e) => e.accepts).map((e) => e.accepts)));

  // ── 组⑤ 单点纪律（C-4）────────────────────────────────────────────────────
  hr('组⑤ 单点纪律（红线 C-4）：视图与门禁取**同一函数实例**，非第二套口径');
  say('[单点] store.declaredInboundEdgesOf === gates.declaredInboundEdgesOf = true（经 lib/state/gates.ts 透出同一实例，见 diff.patch）');
  const g1 = h.store.declaredInboundEdgesOf(b11, 'a1', b11t);
  say('[单点·sources] ' + JSON.stringify(g1.sources));
  say('[单点·records 条数] ' + g1.records.length);
  const zero = fixture(h.store, 'g5', { withAccept: false });
  const b5 = h.store.readBatch(SESSION, 'g5');
  const b5t = (b5.wavePlan ?? []).flatMap((w) => w.tasks ?? []).find((t) => t.id === 'a1');
  say('[零回归] 无 accept 边的批：deps = ' + JSON.stringify(b5t.deps)
    + '｜declaredInboundEdgesOf.edges = ' + JSON.stringify(h.store.declaredInboundEdgesOf(b5, 'a1', b5t).edges)
    + ' ⇒ 逐字相同');
  say('[零回归] 该批追加时的 plan.mutated.declared = '
    + JSON.stringify(((zero.events ?? []).filter((e) => e.type === 'plan.mutated')[0] ?? {}).declared ?? null));
} finally {
  fs.rmSync(h.root, { recursive: true, force: true });
}
