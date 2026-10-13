// G-10 工具面接线 · 定向探针（**只读形态**：自建 os.tmpdir() 根，零触碰真实状态根）——
//   lane `e3-toolface` · 批 `g10-fix-20261012`。用途 = 逐点取「修前口径 / 修后读数」，落
//   `exec/g10-toolface/probe-output.txt`（判据源：`plan/scope.md` §6 的 `L-AC-9` + 用户裁决 Q-H2）。
//
// 覆盖：
//   ① 注册面前像：真实 `createTools` 在册名集 / `SUITE_TOOLS` 表长 / 表内是否有 handoff_accept；
//      SC-4 断言② 的前像/后像（证「注册新工具的必要前提在禁改面」）。
//   ② 视图同源（L-AC-9）：同一构型下「修前口径 = deps-only 投影」vs「修后 = 门禁单点」，边数 1 → 2；
//      视图 READY/BLOCKED 与门禁同判；逐边 `source` 标注 + 渲染面 `[source=…]`。
//   ③ 声明留痕（Q-H2）：活体批 JSON 原文（修前代码写的载荷）vs 修复后载荷（`declared` 逐条枚举）。
//   ④ S-c 真实构型：声明序 `a1-audit` 先于追加 lane ⇒ 拒；追加 lane 先于 audit lane ⇒ 放行。
//   ⑤ 零回归：无 accept 边的批 ⇒ 视图边集合 ≡ `deps`（逐字）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { SUITE_TOOLS } from '../lib/engine/suite.js';
import { buildWavePlan } from '../lib/wave-plan.js';

const SESSION = 'sess-g10-toolface-probe';
const SESS = { agent: { session: { id: SESSION } } };
const SPEC_OK = '# spec\n## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准\n- x\n## 约束\n- y\n';
const LIVE_BATCH = process.argv[2] ?? null; // 活体批 JSON 路径（可选取证：③ 修前载荷原文）

const dump = (label, v) => console.log(label + ': ' + (typeof v === 'string' ? v : JSON.stringify(v)));

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-g10-tf-probe-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'runtime.json'),
    JSON.stringify({ gates: { handoff: { entry: true, settle: true } } }, null, 2), 'utf8');
  const store = createStore(root);
  const ctx = { tools: { register: () => {} }, logger: { info() {}, warn() {}, error() {} } };
  const { tools } = createTools(ctx, { store, root, config: {} });
  return { root, store, byName: Object.fromEntries(tools.map((t) => [t.name, t])), names: tools.map((t) => t.name) };
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
function threeTier(store, batchId) {
  const tasks = [
    { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 'plan' },
    { id: 'e2', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e2.md'], deps: ['p1'], cmd: 'build' },
    { id: 'a1', layer: 'audit', consume: ['plan/spec.md', 'exec/e2.md'], produce: ['audit/a1.md'], deps: ['e2'], cmd: 'verify' },
  ];
  store.createBatch(SESSION, { batchId, wavePlan: buildWavePlan({ batchId, tasks, team: null, concurrency: 5 }), phase: 'running' });
  seed(store, batchId, 'plan/spec.md', SPEC_OK);
  seed(store, batchId, 'exec/e2.md', 'out');
  seed(store, batchId, 'audit/a1.md', 'out');
}

const h = harness();

// ══ ① 工具注册面（在册名集 / 单点表 / SC-4 断言② 前像·后像）═════════════════════════════════
console.log('== ① 工具注册面（前像 = 现状；后像 = 仅改 lib/tools/** 追加注册 handoff_accept）==');
dump('① 在册工具数', h.names.length);
dump('① 在册交接族', h.names.filter((n) => n.startsWith('handoff')));
dump('① 在册是否含 handoff_accept', h.names.includes('handoff_accept'));
dump('① SUITE_TOOLS 表长', SUITE_TOOLS.length);
dump('① 表内是否含 handoff_accept', SUITE_TOOLS.some((t) => t.name === 'handoff_accept'));
const NOT_REG = ['subagent', 'subagent_fork', 'log_export', 'send_message', 'interrupt_agent', 'list_agents', 'wait_agent', 'spawn_teammate'];
const minus = (reg) => reg.filter((n) => !SUITE_TOOLS.some((t) => t.name === n));
dump('① SC-4 断言② 前像（注册 − 表）', minus(h.names));
dump('① SC-4 断言② 后像（注册 − 表｜模拟仅改 lib/tools/**）', minus([...h.names, 'handoff_accept']));
dump('① SC-4 断言① （表 − 注册）≡ NOT_REGISTERED_BY_DEFAULT', JSON.stringify(SUITE_TOOLS.map((t) => t.name).filter((n) => !h.names.includes(n))) === JSON.stringify(NOT_REG));

// ══ ② 视图同源（L-AC-9）：deps-only（修前口径）vs 门禁单点（修后读数）═════════════════════════
console.log('\n== ② handoff_view 视图同源（构型：p1→e2→a1；批运行中追加 e3，其入边经 recordHandoffAccept 声明）==');
threeTier(h.store, 'p-ok');
h.store.addPoolTasks(SESSION, 'p-ok', [
  { id: 'e3', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e3.md'], deps: ['p1'], cmd: 'late' },
], { reason: '探针：追加后置 lane（声明序在 a1 之前）', author: 'probe' });
seed(h.store, 'p-ok', 'exec/e3.md', 'late product');
const sub = h.store.recordHandoff(SESSION, 'p-ok', {
  from: 'e2', to: 'a1', artifacts: ['exec/e2.md'], assertions: ['e2 产物可被 a1 直接消费'],
  caller: { sessionId: SESSION, from: 'e2' },
});
dump('② 前置：建批期已声明边 e2->a1 提交', { ok: sub.ok, code: sub.code });
const viewBefore = await h.byName.handoff_view.execute({ batchId: 'p-ok', lane: 'a1' }, SESS);
dump('② 修前口径复算（deps-only 投影）边数', (laneTaskOf(h.store, 'p-ok', 'a1').deps ?? []).length);
dump('② 修前口径 ready（audit §D 同形：视图 READY，而门禁已因 accept 边阻塞）', viewBefore.ready);
const acc = h.store.recordHandoffAccept(SESSION, 'p-ok', { from: 'e3', to: 'a1', reason: '下游接受后置上游', author: 'probe' });
dump('② 下游声明接受（写方 = 下游 audit lane）', { ok: acc.ok, idempotent: acc.idempotent, revision: acc.revision });
const b1 = h.store.readBatch(SESSION, 'p-ok');
const t1 = laneTaskOf(h.store, 'p-ok', 'a1');
const gate = h.store.declaredInboundEdgesOf(b1, 'a1', t1);
dump('② 门禁侧单点 edges', gate.edges);
dump('② 门禁侧单点 sources', gate.sources);
const viewAfter = await h.byName.handoff_view.execute({ batchId: 'p-ok', lane: 'a1' }, SESS);
dump('② 修后：视图边数（前像 1 → 后像 2）', viewAfter.edges.length);
dump('② 修后：视图 edges（from / status / source）', viewAfter.edges.map((e) => ({ from: e.from, status: e.status, source: e.source })));
dump('② 修后：视图 readonly 字段 deps（拓扑面语义不变）', viewAfter.deps);
dump('② 修后：视图 ready / blocking / pending', { ready: viewAfter.ready, blocking: viewAfter.blocking, pending: viewAfter.pending });
dump('② 同源判定（视图 froms ≡ 单点 edges）', JSON.stringify(viewAfter.edges.map((e) => e.from)) === JSON.stringify(gate.edges));
dump('② 渲染面（逐行）', '\n' + (h.byName.handoff_view.output.render({ batchId: 'p-ok', lane: 'a1' }, viewAfter) ?? []).map((x) => x.text ?? '').join('\n'));
const idem = h.store.recordHandoffAccept(SESSION, 'p-ok', { from: 'e3', to: 'a1' });
const b1b = h.store.readBatch(SESSION, 'p-ok');
dump('② 幂等复查（二次声明）', { idempotent: idem.idempotent, revision: b1b.planRevision, mutatedEvents: (b1b.events ?? []).filter((e) => e.type === 'plan.mutated').length });

// ══ ⑤ 零回归：无 accept 边的批 ════════════════════════════════════════════════════════════════
console.log('\n== ⑤ 零回归（无 accept 边 ⇒ 视图边集合 ≡ deps，逐字）==');
threeTier(h.store, 'p-reg');
const regSub = h.store.recordHandoff(SESSION, 'p-reg', {
  from: 'e2', to: 'a1', artifacts: ['exec/e2.md'], assertions: ['e2 产物可被 a1 直接消费'],
  caller: { sessionId: SESSION, from: 'e2' },
});
dump('⑤ 建批期已声明路径提交', { ok: regSub.ok, code: regSub.code });
const viewReg = await h.byName.handoff_view.execute({ batchId: 'p-reg', lane: 'a1' }, SESS);
dump('⑤ 视图 edge froms ≡ deps', { viewEdges: viewReg.edges.map((e) => e.from), deps: laneTaskOf(h.store, 'p-reg', 'a1').deps });
dump('⑤ 视图 sources', viewReg.edges.map((e) => e.source));
dump('⑤ 视图 ready / blocking', { ready: viewReg.ready, blocking: viewReg.blocking });

// ══ ④ S-c（声明序）在本批真实构型下会拒「后置 lane → 早于它的 audit lane」═════════════════════
console.log('\n== ④ S-c 真实构型复核（声明序）==');
threeTier(h.store, 'p-sc');
// 追加 lane 的 deps 指向 exec 层 ⇒ 深度 = a1 同波、落**其后** ⇒ orderOf(from) > orderOf(to)（= 本批 a1-audit(2) < e3-toolface(4) 的同形）
h.store.addPoolTasks(SESSION, 'p-sc', [
  { id: 'e3', layer: 'exec', consume: ['exec/e2.md'], outputs: ['exec/e3.md'], deps: ['e2'], cmd: 'late' },
], { reason: '探针：追加后置 lane（声明序在 a1 之后，复现本批真实序）', author: 'probe' });
const flat = (h.store.readBatch(SESSION, 'p-sc').wavePlan ?? []).flatMap((w) => (w.tasks ?? []).map((t) => t.id));
dump('④ 声明序（flat）', flat);
dump('④ orderOf(a1) / orderOf(e3)', [flat.indexOf('a1'), flat.indexOf('e3')]);
let scOut;
try {
  const r = h.store.recordHandoffAccept(SESSION, 'p-sc', { from: 'e3', to: 'a1', reason: 'S-c 负控', author: 'probe' });
  scOut = { ok: r.ok, idempotent: r.idempotent, revision: r.revision };
} catch (e) { scOut = { ok: false, code: 'HANDOFF_ACCEPT_REJECTED', message: String(e?.message ?? e) }; }
dump('④ S-c 负控（from 声明序晚于 to）', scOut);
dump('④ 拒态零写入（planRevision / handoffs.a1 是否留条）', {
  planRevision: h.store.readBatch(SESSION, 'p-sc').planRevision,
  a1Entries: (h.store.readBatch(SESSION, 'p-sc').handoffs.a1 ?? []).map((r) => r.from),
});

// ══ ③ 声明留痕（Q-H2）：修复后载荷 vs 活体批修前载荷原文 ═══════════════════════════════════════
console.log('\n== ③ 声明留痕（Q-H2）：`plan.mutated` 是否逐条列出本次播种的入边声明 ==');
threeTier(h.store, 'p-trail');
const rev0 = h.store.readBatch(SESSION, 'p-trail').planRevision ?? 0;
const after = h.store.addPoolTasks(SESSION, 'p-trail', [
  { id: 'e9', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e9.md'], deps: ['p1'], cmd: 'late' },
], { reason: 'Q-H2 探针：追加即声明', author: 'probe' });
const mut = (after.events ?? []).filter((e) => e.type === 'plan.mutated');
dump('③ 修复后：addPoolTasks 的 plan.mutated 载荷', mut.map((e) => ({ added: e.added ?? null, declared: e.declared ?? null, revision: e.revision })));
dump('③ 修复后：planRevision 递增', rev0 + ' -> ' + after.planRevision);
dump('③ 修复后：`declared` ≡ `handoffs[e9]` 实际播种面', JSON.stringify(after.handoffs.e9.map((r) => ({ from: r.from, to: r.to }))));
if (LIVE_BATCH) {
  const live = JSON.parse(fs.readFileSync(LIVE_BATCH, 'utf8'));
  console.log('③ 修前口径：活体批 `' + (live.batchId ?? '?') + '` 的 plan.mutated 原文载荷（无 `declared` 键）');
  for (const e of live.events ?? []) {
    if (e.type === 'plan.mutated') dump('   ', { ts: e.ts, added: e.added ?? null, declared: e.declared ?? null, revision: e.revision, reason: String(e.reason ?? '').slice(0, 40) + '…' });
  }
  const gap = (live.events ?? []).find((e) => e.type === 'lane.handoff.gap' && (e.lane === 'e2-g10'));
  dump('③ 修前口径：同批 `lane.handoff.gap` 的 missing[]（逐字 ⇒ 证明声明条目当时**存在且 pending**）', gap ? gap.missing : null);
}

console.log('\nprobe root(s) under ' + os.tmpdir());
fs.rmSync(h.root, { recursive: true, force: true });
