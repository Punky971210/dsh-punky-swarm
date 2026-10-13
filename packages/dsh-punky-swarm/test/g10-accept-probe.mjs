// G-10 修复后定向探针（**只读形态**：自建 os.tmpdir() 根，零触碰真实状态根；不写任何 lib/**）——
//   lane `e2-g10` · 批 `g10-fix-20261012`。用途 = 逐点取「修后 GREEN 列」，与 e1-g10 的「修前 RED 列」对照。
//
// 覆盖（对应 `plan/design.md` §A.10 的 J-1..J-8 中本 lane 可达的面）：
//   ① 可达构型（V2 形态）：后置 lane `e3` → 已声明下游 `a1`，经 `recordHandoffAccept` 补声明
//      ⇒ 逐字拒态消失、`handoff_submit` 放行、产物真进下游 consume 面（`handoff_view` 可读）；
//   ② D3 闭合（治静默本体）：声明后不提交而试图结算上游 ⇒ **逐字拒** `GATE_HANDOFF_MISSING`
//      + 既有 `lane.handoff.gap` 事件（对照：修前同构型 `merged` 无拒态，见 e1-g10 的 ⑤ 读数）；
//   ③ 反例（新通道不过宽）：S-a 非 audit / S-b 非后置 from / S-c 声明序 / S-e 终态 / S-d 存量批 / 幂等；
//   ④ 零回归：建批期已声明路径（`e2 → a1`）逐字不变；拓扑真源（deps / waves）声明前后 deepEqual 不变。
//
// 运行：`node test/g10-accept-probe.mjs`（本件为**读数件**，不是断言件；断言件 = `test/g10-accept-edge.test.js`）
process.env.PSWARM_HANDOFF_GATE = '1';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';

const SESSION = 'sess-e2-g10-probe';
const SPEC_OK = '# spec\n## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准\n- x\n## 约束\n- y\n';
const line = (s) => process.stdout.write(s + '\n');
const dump = (label, v) => line(label + ': ' + JSON.stringify(v));
const err1 = (e) => String(e?.message ?? e).split('\n')[0];

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-g10-accept-probe-'));
fs.mkdirSync(path.join(root, 'config'), { recursive: true });
fs.writeFileSync(path.join(root, 'config', 'runtime.json'),
  JSON.stringify({ gates: { handoff: { entry: true, settle: true } } }, null, 2), 'utf8');

const store = createStore(root);
// 批次读取单点（本件内部一律经它 —— 防 `(sessionId, batchId)` 实参顺序写错）
const readB = (batchId) => store.readBatch(SESSION, batchId);
const seed = (batchId, rel, body = 'out') => {
  const abs = path.join(store.artifactsDirOf(SESSION, batchId), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
};
// 结算轨迹（走真实写路径 `store.setMember`；出口门唯一调用点在 `lib/state/store/member-gates.js`）：
//   从 lane **当前态**起走完剩余链；首个「<当前态>:start」项证实在跑（`pending` 第一跳不过门）。
const settleOf = (batchId, lane, note) => {
  const TERMINAL = ['merged', 'conflict', 'failed', 'skipped'];
  const chain = ['pending', 'running', 'review', 'merged'];
  const trail = [];
  let idx = Math.max(0, chain.indexOf(readB(batchId).lanes?.[lane]));
  trail.push(chain[idx] + (TERMINAL.includes(chain[idx]) ? ':terminal-precheck' : ':start'));
  if (TERMINAL.includes(chain[idx])) return trail;
  for (idx += 1; idx < chain.length; idx += 1) {
    const to = chain[idx];
    try { store.setMember(SESSION, batchId, lane, to, note); trail.push(to + ':ok'); }
    catch (e) { trail.push(to + ':rejected[' + err1(e) + ']'); break; }
  }
  return trail;
};
// 负控专用：不经过结算链，直接把 lane 置终态（本通道对终态的判定只读 `batch.lanes`）。
const markLaneTerminal = (batchId, lane) => {
  const b = readB(batchId);
  b.lanes[lane] = 'merged';
  fs.writeFileSync(store.batchFile(SESSION, batchId), JSON.stringify(b, null, 2), 'utf8');
  return 'merged';
};
const depsSnapshot = (batchId) => (store.readBatch(SESSION, batchId).wavePlan ?? [])
  .map((w) => ({ wave: w.wave, tasks: (w.tasks ?? []).map((t) => ({ id: t.id, layer: t.layer, deps: Array.isArray(t.deps) ? t.deps : [] })) }));
const acceptErr = (batchId, from, to) => {
  try { store.recordHandoffAccept(SESSION, batchId, { from, to, reason: 'probe', author: 'probe' }); return { ok: true, code: null, message: null }; }
  catch (e) { return { ok: false, code: err1(e).split(':')[0], message: err1(e) }; }
};

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 构型 A：三层批 p1(plan) → e2(exec) → a1(audit)；a1.deps=['e2']；批运行中追加后置 lane `e3`（V2 形态）
// ══════════════════════════════════════════════════════════════════════════════════════════════
const BA = 'g10-probe-A';
const tasksA = [
  { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 'plan-it' },
  { id: 'e2', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e2.md'], deps: ['p1'], cmd: 'build' },
  { id: 'a1', layer: 'audit', consume: ['plan/spec.md', 'exec/e2.md'], produce: ['audit/a1.md'], deps: ['e2'], cmd: 'verify' },
];
store.createBatch(SESSION, { batchId: BA, wavePlan: buildWavePlan({ batchId: BA, tasks: tasksA, team: null, concurrency: 5 }), phase: 'running' });
for (const [rel, body] of [['plan/spec.md', SPEC_OK], ['exec/e2.md', 'out'], ['audit/a1.md', 'out']]) seed(BA, rel, body);
store.addPoolTasks(SESSION, BA, [
  { id: 'e3', layer: 'exec', outputs: ['exec/e3.md'], cmd: 'late-fix' }, // 无 deps / 无 consume（避免撞 consume×deps 不对称门）
], { reason: 'probe：批运行中追加的后置 lane', author: 'probe' });
seed(BA, 'exec/e3.md', 'late product');

line('== 构型 A：' + BA + '（p1 → e2 → a1；批运行中追加后置 lane e3；a1.deps=[' + JSON.stringify(['e2']) + ']）==');
dump('① 追加后 handoffs keys', Object.keys(store.readBatch(SESSION, BA).handoffs));
dump('① a1 的入边声明条（仅建批期 deps 种子）', store.readBatch(SESSION, BA).handoffs.a1.map((r) => ({ from: r.from, status: r.status, source: r.source ?? null })));

// ── ② 修前 RED（复现 e1-g10 的 ③）：后置 lane 向已声明下游交产物 ⇒ 逐字拒 ───────────────────────
const pre = store.recordHandoff(SESSION, BA, {
  from: 'e3', to: 'a1', artifacts: ['exec/e3.md'], assertions: ['probe: e3 产物可核'],
  caller: { sessionId: SESSION, from: 'e3' },
});
dump('② 修前 RED：recordHandoff(e3 -> a1)', { ok: pre.ok, code: pre.code, missing: pre.missing, problems: pre.problems });

// ── ③ 新通道：下游 a1 声明接受后置上游 e3（写方 = 下游）─────────────────────────────────────────
const acc = store.recordHandoffAccept(SESSION, BA, { from: 'e3', to: 'a1', reason: 'probe：a1 接受 e3 的交接', author: 'probe' });
dump('③ recordHandoffAccept(e3 -> a1)', { ok: acc.ok, idempotent: acc.idempotent, revision: acc.revision });
dump('③ 声明条落点（source=accept；不写 deps）', store.readBatch(SESSION, BA).handoffs.a1.map((r) => ({ from: r.from, status: r.status, source: r.source ?? null, acceptedBy: r.acceptedBy ?? null })));
dump('③ 审计留痕 plan.mutated（accepts）', store.readBatch(SESSION, BA).events.filter((e) => e.type === 'plan.mutated').map((e) => ({ added: e.added ?? null, accepts: e.accepts ?? null, revision: e.revision })));

// ── ④ 可达构型 GREEN：产物真进下游取件面 ────────────────────────────────────────────────────────
const sub = store.recordHandoff(SESSION, BA, {
  from: 'e3', to: 'a1', artifacts: ['exec/e3.md'], assertions: ['probe: e3 产物可核'],
  caller: { sessionId: SESSION, from: 'e3' },
});
dump('④ 修后 GREEN：recordHandoff(e3 -> a1)', { ok: sub.ok, code: sub.code });
dump('④ 审计留痕 lane.handoff', store.readBatch(SESSION, BA).events.filter((e) => e.type === 'lane.handoff').map((e) => ({ from: e.from, to: e.to, artifacts: e.artifacts, assertions: e.assertions })));

// ── ⑤ D3 闭合：声明一旦存在，上游**必须交** ──────────────────────────────────────────────────────
//   本批 A 已完成提交 ⇒ 需另造一批（A2）来实测「只接受、不提交」的形态。
//   形态要点（`plan-mutated` 的「零依赖拒派」B1）：追加 lane 若**无 consume** 则不可派发（与本通道无关）⇒
//   D3 实测必须用**形态合规**的追加 lane（`consume:['plan/spec.md']` + `deps:['p1']`，消费 plan 层产物）。
const BA2 = 'g10-probe-A2';
store.createBatch(SESSION, { batchId: BA2, wavePlan: buildWavePlan({ batchId: BA2, tasks: tasksA, team: null, concurrency: 5 }), phase: 'running' });
for (const [rel, body] of [['plan/spec.md', SPEC_OK], ['exec/e2.md', 'out'], ['audit/a1.md', 'out']]) seed(BA2, rel, body);
store.addPoolTasks(SESSION, BA2, [
  { id: 'e3', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e3.md'], deps: ['p1'], cmd: 'late-fix' },
], { reason: 'probe D3', author: 'probe' });
seed(BA2, 'exec/e3.md', 'late product');
store.recordHandoffAccept(SESSION, BA2, { from: 'e3', to: 'a1', reason: 'probe：只接受、不提交', author: 'probe' });
const upHa = store.recordHandoff(SESSION, BA2, {
  from: 'p1', to: 'e3', artifacts: ['plan/spec.md'], assertions: ['plan 判据源已交付'],
  caller: { sessionId: SESSION, from: 'p1' },
});
line('⑤ D3 前置：追加 lane 的既有入边 p1 -> e3 提交换行（使该 lane 形态合规、入口门可放行） ok=' + upHa.ok);
store.setMember(SESSION, BA2, 'e3', 'running');
dump('⑤ D3：e3 已接受 e3->a1 但**未提交** ⇒ 结算轨迹', settleOf(BA2, 'e3'));
dump('⑤ D3：e3 结算后状态（不得进终态）', { e3: readB(BA2).lanes.e3 });
dump('⑤ D3：拒态留痕 lane.handoff.gap', readB(BA2).events.filter((e) => e.type === 'lane.handoff.gap').map((e) => ({ lane: e.lane, code: e.code, missing: e.missing })));
line('⑤ D3 结论：修前同构型为 `running:ok → review:ok → merged:ok`（零拒态，见 e1-g10 的 ⑤ 读数）；'
  + '修后「有下游」集合含该 accept 边 ⇒ **在 merged 被逐字拒** + 落缺口事件 ⇒ **静默已闭合**。');

// ── ⑥ 反例（新通道不过宽）：受限开面逐条 ────────────────────────────────────────────────────────
const BA3 = 'g10-probe-A3';
store.createBatch(SESSION, { batchId: BA3, wavePlan: buildWavePlan({ batchId: BA3, tasks: tasksA, team: null, concurrency: 5 }), phase: 'running' });
store.addPoolTasks(SESSION, BA3, [{ id: 'e3', layer: 'exec', outputs: ['exec/e3.md'], cmd: 'late' }], { reason: 'probe 反例', author: 'probe' });
dump('⑥ 反例 S-a（to 非 audit 层；e2 为 exec）', acceptErr(BA3, 'e3', 'e2'));
dump('⑥ 反例 S-b（from 非后置 lane；e2 建批期即存在）', acceptErr(BA3, 'e2', 'a1'));
dump('⑥ 幂等（重复声明同一对 ⇒ 不重复落事件、不递增 revision）', (() => {
  const before = readB(BA3);
  const n0 = { revision: before.planRevision ?? 0, mutated: (before.events ?? []).filter((e) => e.type === 'plan.mutated').length };
  const r1 = store.recordHandoffAccept(SESSION, BA3, { from: 'e3', to: 'a1', reason: 'first', author: 'probe' });
  const r2 = store.recordHandoffAccept(SESSION, BA3, { from: 'e3', to: 'a1', reason: 'again', author: 'probe' });
  const after = readB(BA3);
  const n1 = { revision: after.planRevision ?? 0, mutated: (after.events ?? []).filter((e) => e.type === 'plan.mutated').length };
  return { firstIdempotent: r1.idempotent, secondIdempotent: r2.idempotent, revision: n0.revision + '->' + n1.revision, mutated: n0.mutated + '->' + n1.mutated };
})());
dump('⑥ 反例 S-e（to 已终态）：先把 a1 走到终态（其两条入边均需已成立），再试图接受新入边', (() => {
  for (const [rel, body] of [['plan/spec.md', SPEC_OK], ['exec/e2.md', 'out'], ['exec/e3.md', 'late product'], ['audit/a1.md', 'out']]) seed(BA3, rel, body);
  // a1 的入边：① 建批期已声明的 `e2->a1`；② 追加 lane 的 `e3->a1`（本通道新声明）——两条都须先成立
  store.recordHandoff(SESSION, BA3, {
    from: 'e2', to: 'a1', artifacts: ['exec/e2.md'], assertions: ['e2 产物可核'], caller: { sessionId: SESSION, from: 'e2' },
  });
  store.recordHandoff(SESSION, BA3, {
    from: 'e3', to: 'a1', artifacts: ['exec/e3.md'], assertions: ['e3 产物可核'], caller: { sessionId: SESSION, from: 'e3' },
  });
  const trail = settleOf(BA3, 'a1', 'human:probe:2026-10-12:verdict');
  return { trail, a1: readB(BA3).lanes.a1, rejectNewInbound: acceptErr(BA3, 'e3', 'a1') };
})());
dump('⑥ 反例 S-e（from 已终态；负控只读 batch.lanes ⇒ 直接置终态）', (() => {
  const B = 'g10-probe-A4';
  store.createBatch(SESSION, { batchId: B, wavePlan: buildWavePlan({ batchId: B, tasks: tasksA, team: null, concurrency: 5 }), phase: 'running' });
  store.addPoolTasks(SESSION, B, [{ id: 'e3', layer: 'exec', outputs: ['exec/e3.md'], cmd: 'late' }], { reason: 'probe 反例', author: 'probe' });
  markLaneTerminal(B, 'e3');
  return acceptErr(B, 'e3', 'a1');
})());
// 反例 S-d（存量批：无 handoffs 字段）—— 手工造一份 legacy 形态批次文件（仅探针临时根内）
const BL = 'g10-probe-legacy';
{
  const legacy = {
    schema: 3, sessionId: SESSION, batchId: BL, phase: 'running', concurrency: 5, team: null,
    wavePlan: store.readBatch(SESSION, BA3).wavePlan, lanes: { p1: 'merged', e2: 'pending', a1: 'pending' },
    chains: {}, archived: false, events: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    // ⚠ 刻意**不写** `handoffs` 键（= 存量形态）
  };
  fs.mkdirSync(path.dirname(store.batchFile(SESSION, BL)), { recursive: true });
  fs.writeFileSync(store.batchFile(SESSION, BL), JSON.stringify(legacy, null, 2), 'utf8');
}
dump('⑥ 反例 S-d（存量批无 handoffs 字段）', acceptErr(BL, 'e3', 'a1'));

// ── ⑦ 零回归：建批期已声明路径逐字不变 + 拓扑真源声明前后 deepEqual ──────────────────────────────
const BB = 'g10-probe-B';
store.createBatch(SESSION, { batchId: BB, wavePlan: buildWavePlan({ batchId: BB, tasks: tasksA, team: null, concurrency: 5 }), phase: 'running' });
for (const [rel, body] of [['plan/spec.md', SPEC_OK], ['exec/e2.md', 'out'], ['audit/a1.md', 'out']]) seed(BB, rel, body);
store.addPoolTasks(SESSION, BB, [{ id: 'e3', layer: 'exec', outputs: ['exec/e3.md'], cmd: 'late' }], { reason: 'probe 零回归', author: 'probe' });
const beforeDeps = depsSnapshot(BB);
store.recordHandoffAccept(SESSION, BB, { from: 'e3', to: 'a1', reason: 'probe', author: 'probe' });
const afterDeps = depsSnapshot(BB);
dump('⑦ 拓扑零变更：声明前后 wavePlan(deps/waves) deepEqual', JSON.stringify(beforeDeps) === JSON.stringify(afterDeps));
const reg = store.recordHandoff(SESSION, BB, {
  from: 'e2', to: 'a1', artifacts: ['exec/e2.md'], assertions: ['probe: e2 产物可核（建批期已声明路径）'],
  caller: { sessionId: SESSION, from: 'e2' },
});
dump('⑦ 零回归：建批期已声明路径 recordHandoff(e2 -> a1)', { ok: reg.ok, code: reg.code });
dump('⑦ 零回归：a1 的入边状态', store.readBatch(SESSION, BB).handoffs.a1.map((r) => ({ from: r.from, status: r.status, source: r.source ?? null })));

line('');
line('== 备注 ==');
line('  · 本通道**只补声明条目、不写 deps**（拓扑真源零改动）；被追加 lane 若改用 `consume` 反向引用上游产物，');
line('    仍会在重归一化期撞既有 `GATE_CONSUME_DEPS_ASYMMETRY`（该门单点 = lib/wave-plan.ts#consumeDepsAsymmetryOf，');
line('    形参只有 WaveTask[]、不持有 batch）⇒ 属本 lane 写域外的既有边界，不在本修复的开面内。');
line('probe root: ' + root);
