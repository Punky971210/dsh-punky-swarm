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

// G-10 断言件（批 `g10-fix-20261012` · lane `e2-g10`）——
//   判据源：`plan/design.md` §A.10（`J-1..J-8`）与 `plan/scope.md` §6（`L-AC-6` / `L-AC-7` / `L-AC-8`）。
// 本件只断言「**本通道**（受限反向声明 `recordHandoffAccept`）的行为与其不改面」，不重复 e1-g10 的探针读数。
process.env.PSWARM_HANDOFF_GATE = '1';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';

const SPEC_OK = '# spec\n## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准\n- x\n## 约束\n- y\n';
const SESSION = 'sess-g10-accept';

/** 临时根 + 交接门开启（真源 = runtime.json；env 仅兜底）——与 `test/handoff-gate.test.js` 同形。 */
function freshStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-g10-accept-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'runtime.json'),
    JSON.stringify({ gates: { handoff: { entry: true, settle: true } } }, null, 2), 'utf8');
  return { root, store: createStore(root) };
}

const seed = (store, batchId, rel, body = 'out') => {
  const abs = path.join(store.artifactsDirOf(SESSION, batchId), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
  return abs;
};

/** 三层批（p1 plan → e2 exec → a1 audit；a1.deps=['e2']），再**批运行中追加**后置 lane `e3`。 */
function batchWithAppendedLane(store, batchId, opts = {}) {
  const tasks = [
    { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 'plan-it' },
    { id: 'e2', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e2.md'], deps: ['p1'], cmd: 'build' },
    { id: 'a1', layer: 'audit', consume: ['plan/spec.md', 'exec/e2.md'], produce: ['audit/a1.md'], deps: ['e2'], cmd: 'verify' },
  ];
  store.createBatch(SESSION, {
    batchId, wavePlan: buildWavePlan({ batchId, tasks, team: null, concurrency: 5 }), phase: 'running',
  });
  for (const [rel, body] of [['plan/spec.md', SPEC_OK], ['exec/e2.md', 'out'], ['audit/a1.md', 'out']]) seed(store, batchId, rel, body);
  // 后置 lane（G-10 的真实形态：追加 lane 是**产出方**，其产物本应交给既有 audit lane）。
  // 形态分两种，按用例需要选：
  //   · 缺省（`withUpstream: false`）= **无 deps / 无 consume** —— 只声明产出。用于测「入边声明通道」本身
  //     （该 lane 不可派发，与本通道无关）；
  //   · `withUpstream: true` = `deps:[p1]` + `consume:['plan/spec.md']`（消费 **plan 层**产物，不撞既有
  //     `GATE_CONSUME_DEPS_ASYMMETRY` 的强制域）—— 使 entry 门对该 lane **可放行**，从而能实测「上游
  //     缺交被 settle 门拦」的 D3 闭合（本通道正是把这条边变成「已声明」才让 settle 门看得见它）。
  const appended = opts.withUpstream
    ? { id: 'e3', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e3.md'], deps: ['p1'], cmd: 'late-fix' }
    : { id: 'e3', layer: 'exec', outputs: ['exec/e3.md'], cmd: 'late-fix' };
  store.addPoolTasks(SESSION, batchId, [appended],
    { reason: 'G-10 用例：批运行中追加的后置 lane', author: 'test' });
  seed(store, batchId, 'exec/e3.md', 'late product');
}

/** 让**追加 lane** 具备可派发形态（补交 `p1 -> e3` 这条既有入边；上游视为 Leader 代交，与真实批同形）。 */
function submitUpstreamOfAppended(store, batchId) {
  return store.recordHandoff(SESSION, batchId, {
    from: 'p1', to: 'e3', artifacts: ['plan/spec.md'], assertions: ['plan 判据源已交付'],
    caller: { sessionId: SESSION, from: 'p1' },
  });
}

/** 从 lane **当前态**起尝试走完剩余结算链（终态 + 门禁拒态都记入轨迹；首个「当前态:start」项证实在跑）。 */
function settleTrail(store, batchId, lane, note) {
  const TERMINAL = ['merged', 'conflict', 'failed', 'skipped'];
  const chain = ['pending', 'running', 'review', 'merged'];
  const trail = [];
  let idx = Math.max(0, chain.indexOf(store.readBatch(SESSION, batchId).lanes?.[lane]));
  trail.push(chain[idx] + (TERMINAL.includes(chain[idx]) ? ':terminal-precheck' : ':start'));
  if (TERMINAL.includes(chain[idx])) return trail;
  for (idx += 1; idx < chain.length; idx += 1) {
    const to = chain[idx];
    try { store.setMember(SESSION, batchId, lane, to, note); trail.push(to + ':ok'); }
    catch (e) { trail.push(to + ':rejected[' + String(e?.message ?? e).split('\n')[0] + ']'); break; }
  }
  return trail;
}

/** 负控专用：不经过结算链，直接把 lane 置为终态（`merged`）——本通道对终态的判定只读 `batch.lanes`。 */
function markLaneTerminal(store, batchId, lane) {
  const b = store.readBatch(SESSION, batchId);
  b.lanes[lane] = 'merged';
  fs.writeFileSync(store.batchFile(SESSION, batchId), JSON.stringify(b, null, 2), 'utf8');
  return 'merged';
}

// ══ L-AC-6 / J-1 + J-2：可达构型（后置 lane 的产物真进已声明下游的取件面）══════════════════════
test('G-10/J-1 可达：后置 lane 交产物 ⇒ 修前逐字拒；下游接受该入边后 ⇒ 提交放行且产物进下游取件面', () => {
  const { store } = freshStore();
  const B = 'g10-j1';
  batchWithAppendedLane(store, B);

  // 修前（RED）：后置 lane 无声明位 ⇒ 逐字拒（与 e1-g10 探针 ③ 同读数）
  const pre = store.recordHandoff(SESSION, B, {
    from: 'e3', to: 'a1', artifacts: ['exec/e3.md'], assertions: ['e3 产物可核'],
    caller: { sessionId: SESSION, from: 'e3' },
  });
  assert.equal(pre.ok, false);
  assert.equal(pre.code, 'GATE_HANDOFF_MISSING');
  assert.deepEqual(pre.missing, ['edge:e3->a1']);

  // 新通道：下游 a1（audit）声明接受后置上游 e3
  const acc = store.recordHandoffAccept(SESSION, B, { from: 'e3', to: 'a1', reason: 'a1 接受 e3', author: 'test' });
  assert.equal(acc.ok, true);
  assert.equal(acc.idempotent, false);
  const rec = store.readBatch(SESSION, B).handoffs.a1.find((r) => r.from === 'e3');
  assert.equal(rec.status, 'pending');       // 与建批期种子同形态
  assert.equal(rec.source, 'accept');        // 边来源标注（防审计把「补声明」误读成「建批期就声明了」）
  assert.equal(rec.acceptedBy.lane, 'a1');   // 写方 = 下游

  // 修后（GREEN）：既有判据一字未动，只因为「声明位」已存在而放行
  const sub = store.recordHandoff(SESSION, B, {
    from: 'e3', to: 'a1', artifacts: ['exec/e3.md'], assertions: ['e3 产物可核'],
    caller: { sessionId: SESSION, from: 'e3' },
  });
  assert.equal(sub.ok, true);
  const after = store.readBatch(SESSION, B).handoffs.a1.find((r) => r.from === 'e3');
  assert.equal(after.status, 'submitted');
  assert.deepEqual(after.artifacts, ['exec/e3.md']);
});

// ══ L-AC-6 / J-4：D3 闭合 —— 声明一旦存在，上游「缺交」必须转红（治静默本体）═══════════════════
test('G-10/J-4 不静默：已接受该入边但未提交 ⇒ 上游结算被拒 GATE_HANDOFF_MISSING 且落 lane.handoff.gap', () => {
  const { store } = freshStore();
  const B = 'g10-j4';
  batchWithAppendedLane(store, B, { withUpstream: true });
  // 顺序硬要求：`handoff_accept` 只接受「**尚无**该边声明」的对（已有声明 ⇒ 幂等返回、不新建边）。
  store.recordHandoffAccept(SESSION, B, { from: 'e3', to: 'a1', reason: '只接受、不提交', author: 'test' });
  const up = submitUpstreamOfAppended(store, B);
  assert.equal(up.ok, true, '追加 lane 的既有入边（p1 -> e3）须可正常提交');
  store.setMember(SESSION, B, 'e3', 'running');
  const trail = settleTrail(store, B, 'e3');
  // 「有下游」集合经本通道扩为并集后，`e3` **立刻**成为有下游的 lane ⇒ 缺交时**必须**在下一步被拦
  //   （拒码复用既有 `GATE_HANDOFF_MISSING`，不新造）。修前该集合为空 ⇒ 本步 `ok` 直到 `merged`（静默）。
  assert.equal(trail.length, 3, '必须在 merged 一步被拦（review 放行，与既有「review 仍放行」口径一致）');
  assert.equal(trail[0], 'running:start');
  assert.equal(trail[1], 'review:ok', 'review 仍放行（既有口径不变）');
  assert.match(trail[2], /^merged:rejected\[GATE_HANDOFF_MISSING/);
  const gaps = store.readBatch(SESSION, B).events.filter((e) => e.type === 'lane.handoff.gap');
  assert.ok(gaps.length >= 1, '缺态必须落既有缺口事件（不静默）');
  assert.equal(gaps[0].code, 'GATE_HANDOFF_MISSING');
  assert.equal(store.readBatch(SESSION, B).lanes.e3, 'review', '被拒后停在被拒前一步（未进终态）');
  // 对照面：同一条边**提交后**即可正常结算（GREEN）⇒ 拒态确实只由「缺交」引起，而非本通道制造的硬堵
  const sub = store.recordHandoff(SESSION, B, {
    from: 'e3', to: 'a1', artifacts: ['exec/e3.md'], assertions: ['e3 产物可核'],
    caller: { sessionId: SESSION, from: 'e3' },
  });
  assert.equal(sub.ok, true);
  assert.deepEqual(settleTrail(store, B, 'e3'), ['review:start', 'merged:ok'], '提交后即可走完剩余结算链');
  assert.equal(store.readBatch(SESSION, B).lanes.e3, 'merged');
});

// ══ L-AC-6 / J-3：审计留痕（新通道必须留痕；事件类不新造）══════════════════════════════════════
test('G-10/J-3 留痕：一次接受 ⇒ 一条 plan.mutated{accepts} + revision+1；提交 ⇒ 既有 lane.handoff', () => {
  const { store } = freshStore();
  const B = 'g10-j3';
  batchWithAppendedLane(store, B);
  const revBefore = store.readBatch(SESSION, B).planRevision ?? 0;
  const acc = store.recordHandoffAccept(SESSION, B, { from: 'e3', to: 'a1', reason: '留痕用例', author: 'tester' });
  assert.equal(acc.revision, revBefore + 1);
  const b = store.readBatch(SESSION, B);
  const mutated = b.events.filter((e) => e.type === 'plan.mutated');
  const last = mutated[mutated.length - 1];
  assert.deepEqual(last.accepts, [{ from: 'e3', to: 'a1' }]);
  assert.equal(last.author, 'tester');
  assert.equal(last.revision, revBefore + 1);
  store.recordHandoff(SESSION, B, {
    from: 'e3', to: 'a1', artifacts: ['exec/e3.md'], assertions: ['a'], caller: { sessionId: SESSION, from: 'e3' },
  });
  const handoffs = store.readBatch(SESSION, B).events.filter((e) => e.type === 'lane.handoff');
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].from, 'e3');
});

// ══ L-AC-8 / J-5：受限开面负控（四类全拒）+ 幂等（不重复落事件、不递增 revision）═══════════════
test('G-10/J-5 反例：非 audit 下游 / 非后置 from / 声明序 / 终态参与 / 存量批 ⇒ 全拒', () => {
  const { store } = freshStore();
  const B = 'g10-j5';
  batchWithAppendedLane(store, B);
  // S-a：`to` 非 audit 层
  assert.throws(() => store.recordHandoffAccept(SESSION, B, { from: 'e3', to: 'e2' }), /S-a|≠ audit|audit 面/);
  // S-b：`from` 非后置 lane（建批期即存在）
  assert.throws(() => store.recordHandoffAccept(SESSION, B, { from: 'e2', to: 'a1' }), /后置 lane/);
  // S-a 姊妹条（层序）：`to` 非 audit ⇒ 拒（两例：既有 exec 下游 / 追加链上的后续 lane）
  assert.throws(() => store.recordHandoffAccept(SESSION, B, { from: 'e3', to: 'e2' }), /audit 面|≠ audit/);
  const B5 = 'g10-j5e';
  batchWithAppendedLane(store, B5);
  store.addPoolTasks(SESSION, B5, [{ id: 'e4', layer: 'exec', outputs: ['exec/e4.md'], cmd: 'later' }], { reason: '层序用例', author: 't' });
  assert.throws(() => store.recordHandoffAccept(SESSION, B5, { from: 'e3', to: 'e4' }), /audit 面|≠ audit/);
  // S-c 声明序判据的正确性证明（构造性）：S-a 要求 `to.layer === 'audit'`，而追加 lane 恒落声明序末尾
  //   ⇒ 「`to` 是 audit」与「`from` 已声明在先」在可达构型下**互为蕴含** ⇒ 合法构型必须**不被**声明序判据误拒。
  //   （因此该判据是 fail-closed 的兜底：若 `to` 是**更早**声明的 audit lane，本函数**必须**放行 —— 实测放行。）
  const B6 = 'g10-j5f';
  batchWithAppendedLane(store, B6);
  const okOrder = store.recordHandoffAccept(SESSION, B6, { from: 'e3', to: 'a1', reason: '声明序放行面', author: 't' });
  assert.equal(okOrder.ok, true);
  // S-e：`to` 已终态（先把既有入边 `e2 -> a1` 交付掉，避免被 settle 门的**既有**判据提前拦下）
  const B2 = 'g10-j5b';
  batchWithAppendedLane(store, B2);
  store.recordHandoff(SESSION, B2, {
    from: 'e2', to: 'a1', artifacts: ['exec/e2.md'], assertions: ['e2 产物可核'],
    caller: { sessionId: SESSION, from: 'e2' },
  });
  for (const to of ['running', 'review', 'merged']) store.setMember(SESSION, B2, 'a1', to, 'human:t:2026-10-12:ok');
  assert.equal(store.readBatch(SESSION, B2).lanes.a1, 'merged');
  assert.throws(() => store.recordHandoffAccept(SESSION, B2, { from: 'e3', to: 'a1' }), /已结算/);
  // S-e：`from` 已终态（负控只读 `batch.lanes` ⇒ 直接置终态，不依赖结算链可达性）
  const B3 = 'g10-j5c';
  batchWithAppendedLane(store, B3);
  assert.equal(markLaneTerminal(store, B3, 'e3'), 'merged');
  assert.throws(() => store.recordHandoffAccept(SESSION, B3, { from: 'e3', to: 'a1' }), /已结算/);
  // S-d：存量批（无 `handoffs` 字段）
  const B4 = 'g10-j5d';
  batchWithAppendedLane(store, B4);
  const legacy = store.readBatch(SESSION, B4);
  delete legacy.handoffs;
  fs.writeFileSync(store.batchFile(SESSION, B4), JSON.stringify(legacy, null, 2), 'utf8');
  assert.throws(() => store.recordHandoffAccept(SESSION, B4, { from: 'e3', to: 'a1' }), /存量形态/);
  // 拒态零写入：上述全部拒绝路径都不得改动批（revision 不变 = 仅 addPoolTasks 那一次）
  assert.equal(store.readBatch(SESSION, B).planRevision ?? 0, 1, '拒绝路径必须零写入');
  assert.equal(store.readBatch(SESSION, B).handoffs.a1.some((r) => r.from === 'e3'), false, '拒绝路径不得留条');
});

test('G-10/J-5 幂等：同一 (to, from) 重复接受 ⇒ 不重复落事件、不递增 planRevision', () => {
  const { store } = freshStore();
  const B = 'g10-idem';
  batchWithAppendedLane(store, B);
  const r1 = store.recordHandoffAccept(SESSION, B, { from: 'e3', to: 'a1', reason: 'first', author: 't' });
  assert.equal(r1.idempotent, false);
  const b1 = store.readBatch(SESSION, B);
  const n1 = b1.events.filter((e) => e.type === 'plan.mutated').length;
  const r2 = store.recordHandoffAccept(SESSION, B, { from: 'e3', to: 'a1', reason: 'again', author: 't' });
  assert.equal(r2.ok, true);
  assert.equal(r2.idempotent, true);
  const b2 = store.readBatch(SESSION, B);
  assert.equal((b2.events ?? []).filter((e) => e.type === 'plan.mutated').length, n1, '幂等路径零事件');
  assert.equal(b2.planRevision, b1.planRevision, '幂等路径不递增 revision');
  assert.equal(b2.handoffs.a1.filter((r) => r.from === 'e3').length, 1, '不重复落条');
});

// ══ L-AC-7 / J-7：拓扑零变更（不写 deps / waves 逐波相同）═════════════════════════════════════
test('G-10/J-7 拓扑零变更：声明前后 wavePlan(deps + waves) deepEqual 不变，真实反向 deps 仍被拒', () => {
  const { store } = freshStore();
  const B = 'g10-j7';
  batchWithAppendedLane(store, B);
  const snap = (batchId) => (store.readBatch(SESSION, batchId).wavePlan ?? [])
    .map((w) => ({ wave: w.wave, tasks: (w.tasks ?? []).map((t) => ({ id: t.id, layer: t.layer, deps: Array.isArray(t.deps) ? t.deps : [] })) }));
  const before = JSON.stringify(snap(B));
  store.recordHandoffAccept(SESSION, B, { from: 'e3', to: 'a1', reason: 'J-7', author: 'test' });
  assert.equal(JSON.stringify(snap(B)), before, '`wavePlan` / `waves` / 逐任务 `deps` 必须逐字不变');
  // 负控（本通道**不得**任何形式改写既有拓扑校验口径，也不得成为绕过它的第二入口）：
  //   ① 指向**不存在**的上游 ⇒ 既有校验拒；
  //   ② 反向 `deps`（给 `a1` 加一条指向后置 lane 的 `deps`）在**已出池**时被 K1 冻结拒（真实反例形态）。
  assert.throws(
    () => store.addTaskEdges(SESSION, B, [{ id: 'a1', add: ['ghost'] }], { reason: 'J-7 负控①' }),
    /上游任务不存在/,
    '既有「加边只许指向批次内既有任务」判据不得被本通道绕过',
  );
  // 让 `a1` 出池（`owner` 非空 = 声明面唯一真源）⇒ 再加边必须被 K1 冻结拒
  const bNow = store.readBatch(SESSION, B);
  const a1task = (bNow.wavePlan ?? []).flatMap((w) => w.tasks ?? []).find((t) => t.id === 'a1');
  a1task.owner = 'worker-x';
  fs.writeFileSync(store.batchFile(SESSION, B), JSON.stringify(bNow, null, 2), 'utf8');
  assert.throws(
    () => store.addTaskEdges(SESSION, B, [{ id: 'a1', add: ['e3'] }], { reason: 'J-7 负控②' }),
    /已派发即冻结/,
    'K1「已派发即冻结」不得被本通道绕过',
  );
});

// ══ 零回归：建批期已声明路径逐字不变（A2 形态：同一批内两条入边共存）═════════════════════════
test('G-10/零回归 建批期已声明路径逐字不变：e2 -> a1 的提交在混入 accept 边后仍照旧成立', () => {
  const { store } = freshStore();
  const B = 'g10-regress';
  batchWithAppendedLane(store, B);
  const r0 = store.recordHandoff(SESSION, B, {
    from: 'e2', to: 'a1', artifacts: ['exec/e2.md'], assertions: ['e2 产物可核'],
    caller: { sessionId: SESSION, from: 'e2' },
  });
  assert.equal(r0.ok, true);
  store.recordHandoffAccept(SESSION, B, { from: 'e3', to: 'a1', reason: 'regress', author: 'test' });
  const list = store.readBatch(SESSION, B).handoffs.a1;
  const e2rec = list.find((r) => r.from === 'e2');
  assert.equal(e2rec.status, 'submitted', '既有已提交状态不得被新声明改动');
  assert.deepEqual(e2rec.artifacts, ['exec/e2.md']);
  assert.equal(e2rec.source, undefined, '建批期条目不写来源键（逐字不变）');
  // entry 面强度不变：下游 a1 仍要求其**全部已声明入边**成立
  const r1 = store.recordHandoff(SESSION, B, {
    from: 'e3', to: 'a1', artifacts: ['exec/e3.md'], assertions: ['e3 产物可核'],
    caller: { sessionId: SESSION, from: 'e3' },
  });
  assert.equal(r1.ok, true);
  assert.equal(store.readBatch(SESSION, B).handoffs.a1.filter((r) => r.status === 'submitted').length, 2);
});
