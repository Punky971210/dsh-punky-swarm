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

// CAP-W2（批 `punky-mac-wave-immutability-2026-10-29` · lane `e1-coder`）：
//   「波次固定语义」的**反例面 / 杀伤力**测试 —— 已派发 lane 的 `wavePlan` 条目及其 `deps` 只读；
//   未派发任务的追加/加边仍允许，但图变更必须在同一次落盘内留 `plan.mutated`。
//   正例面（派生状态可写 / 追加与加边仍可用 / 拒态形态独立断言）由
//   `test/wave-plan-immutability-derivation.test.js`（tester，D-2 写域互斥）独立承担，本文件不越界。
//
// 为什么本文件需要「构造手法」而不是直接调用 guard：
//   `commitBatch` 是 store 闭包内的私有函数（`composeStore` 不导出），guard 亦不 export（任务包 §3.2）。
//   ⇒ 本文件改用仓内**既有公开测试缝** `revRaceHook`（F3/K-1 确定性构造缝；语义 = 「对手在我读完盘之后、
//   落盘之前写了一次」）在**盘面**注入一个与本次提交不一致的 `wavePlan`，再走真实写路径（`setMember`）触发 guard。
//   判据因此是**双向**的：无论偏离发生在盘侧还是内存侧，只要「盘上已提交的 wavePlan」≠「本次要落盘的 wavePlan」
//   （模 `wave`/`sig` 白名单），就是「wavePlan 被中途改写」，guard 必须拒。
//
// 判据来源：任务包 `plan/p2-taskpack-w2.md` §4.1 IMM-1..IMM-5 + §4.2 拒绝形态。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildWavePlan } from '../lib/wave-plan.js';
import { createStore } from '../lib/state/store.js';

const SILENT = { warn: () => {}, info: () => {}, error: () => {} };

// 开工前置：写域自证落点（本文件只碰 test/wave-plan-immutability.test.js；guard 在 lib/state/store.js）
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-w2-imm-'));
  let forge = null; // 测试缝载荷：本次 commitBatch 落盘前对**盘面**做的改写（缺省 null = 不干预）
  const store = createStore(root, {
    logger: SILENT,
    revRaceHook: (info) => { if (typeof forge === 'function') forge(info); },
  });
  return { root, store, S: 'sess-w2-imm', setForge: (fn) => { forge = fn; } };
}

function mkBatch(store, S, batchId, tasks) {
  const plan = buildWavePlan({ batchId, tasks });
  store.createBatch(S, { batchId, wavePlan: plan, phase: 'running' });
  return plan;
}

// 盘面改写：直接改盘上批次 JSON（`__rev` 原样保留 ⇒ rev CAS 仍与调用方声明值一致，
//   ⇒ 拒绝必须来自 guard，而不是 BATCH_VERSION_CONFLICT）
function forgeDisk(store, S, batchId, mutate) {
  const file = store.batchFile(S, batchId);
  const b = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(b);
  fs.writeFileSync(file, JSON.stringify(b, null, 2));
}

function taskOf(batch, id) {
  return (batch.wavePlan ?? []).flatMap((w) => (Array.isArray(w?.tasks) ? w.tasks : []))
    .find((t) => t && t.id === id);
}

// 拒绝形态（任务包 §4.2）：普通 Error / 不设 code / 不以 GATE_ 开头 / 消息含 batchId 与出事 lane
function rejectFormOf(batchId, laneId, invariant) {
  return (err) => {
    assert.ok(err instanceof Error, '必须是 Error 实例');
    assert.equal(err.code, undefined, '不得设 err.code（禁 GATE_ 码）');
    assert.equal(/^GATE_/.test(String(err.message)), false, '消息不得以 GATE_ 开头');
    assert.match(String(err.message), new RegExp(batchId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '消息须含 batchId');
    assert.ok(String(err.message).includes(laneId), '消息须含出事的 lane/task id');
    assert.ok(String(err.message).includes(invariant), '消息须含不变量编号 ' + invariant);
    return true;
  };
}

// ── IMM-2｜已派发条目逐字冻结：cmd 被改写 ⇒ 拒 ──────────────────────────────────
test('IMM-2 已派发任务的 cmd 被改写 ⇒ 拒（普通 Error，非 GATE_ 前缀，含 batchId + lane）', () => {
  const { store, S, setForge } = setup();
  const BID = 'b-imm2-cmd';
  mkBatch(store, S, BID, [{ id: 't1' }, { id: 't2' }]);
  store.setMember(S, BID, 't1', 'running', null, undefined, 'agent-9'); // 派发 ⇒ owner 非空 = 已派发
  assert.equal(taskOf(store.readBatch(S, BID), 't1').owner, 'agent-9', '前置：t1 已派发');

  setForge(() => forgeDisk(store, S, BID, (b) => { taskOf(b, 't1').cmd = '被改写的 cmd'; }));
  try {
    assert.throws(
      () => store.setMember(S, BID, 't2', 'running', null, undefined, 'agent-10'),
      rejectFormOf(BID, 't1', 'IMM-2'),
      '已派发任务的 cmd 不在可改写面内（IMM-2）',
    );
  } finally { setForge(null); }
});

// ── IMM-2｜已派发条目逐字冻结：deps 被改写 ⇒ 拒 ─────────────────────────────────
test('IMM-2 已派发任务的 deps 被改写 ⇒ 拒（sig 冻结掩盖不了 deps 篡改）', () => {
  const { store, S, setForge } = setup();
  const BID = 'b-imm2-deps';
  mkBatch(store, S, BID, [{ id: 't0' }, { id: 't1', deps: ['t0'] }, { id: 't2' }]);
  store.setMember(S, BID, 't1', 'running', null, undefined, 'agent-9');
  assert.deepEqual(taskOf(store.readBatch(S, BID), 't1').deps, ['t0'], '前置：t1 已派发且带 1 条入边');

  setForge(() => forgeDisk(store, S, BID, (b) => { taskOf(b, 't1').deps = ['t0', 't2']; }));
  try {
    assert.throws(
      () => store.setMember(S, BID, 't2', 'running', null, undefined, 'agent-10'),
      rejectFormOf(BID, 't1', 'IMM-2'),
      '已派发任务的 deps 不得插边/改边（IMM-2）',
    );
  } finally { setForge(null); }
});

// ── IMM-1｜任务集合只增不删 ⇒ 删任务被拒 ─────────────────────────────────────
test('IMM-1 既有任务在本次提交中消失 ⇒ 拒（只增不删）', () => {
  const { store, S, setForge } = setup();
  const BID = 'b-imm1-del';
  mkBatch(store, S, BID, [{ id: 't1' }, { id: 't2' }]);
  store.setMember(S, BID, 't1', 'running', null, undefined, 'agent-9');

  // 盘上存在 t9（= 已被接受的既有任务），而本次提交的 wavePlan 不含它 ⇒ 等价于「删任务」
  setForge(() => forgeDisk(store, S, BID, (b) => {
    b.wavePlan[0].tasks.push({ id: 't9', cmd: 'hand-forged', deps: [], owner: null });
  }));
  try {
    assert.throws(
      () => store.setMember(S, BID, 't2', 'running', null, undefined, 'agent-10'),
      rejectFormOf(BID, 't9', 'IMM-1'),
      '既有任务不得消失（IMM-1：只增不删）',
    );
  } finally { setForge(null); }
});

// ── IMM-3｜未派发条目 deps 只许尾部追加（旧边必须是前缀）──────────────────────
test('IMM-3 未派发任务的 deps 非「旧边前缀 + 新尾」⇒ 拒（禁删/禁插/禁重排）', () => {
  const { store, S, setForge } = setup();
  const BID = 'b-imm3-prefix';
  mkBatch(store, S, BID, [{ id: 'a' }, { id: 'b' }, { id: 't2', deps: ['a'] }, { id: 't3' }]);
  assert.deepEqual(taskOf(store.readBatch(S, BID), 't2').deps, ['a'], '前置：t2 未派发，入边 = [a]');

  // 盘上 t2 的入边被换成 [b]（同长度、非前缀 ⇒ 不是「旧边前缀 + 新尾」）
  setForge(() => forgeDisk(store, S, BID, (b) => { taskOf(b, 't2').deps = ['b']; }));
  try {
    assert.throws(
      () => store.setMember(S, BID, 't3', 'running', null, undefined, 'agent-10'),
      rejectFormOf(BID, 't2', 'IMM-3'),
      '未派发任务的既有 deps 位次不得被改写（IMM-3）',
    );
  } finally { setForge(null); }
});

// ── IMM-4｜图变更必须留痕：deps 增长但追加段无 plan.mutated ⇒ 拒 ──────────────
test('IMM-4 deps 增长但本次 commit 追加段无 plan.mutated ⇒ 拒（绕过 plan-mutate 的改写）', () => {
  const { store, S, setForge } = setup();
  const BID = 'b-imm4-trace';
  mkBatch(store, S, BID, [{ id: 'a' }, { id: 't2', deps: ['a'] }, { id: 't3' }]);

  // 盘上 t2 尚无入边；本次提交的 wavePlan 已带 ['a']（= 加边），但事件追加段只有成员事件、无 plan.mutated
  setForge(() => forgeDisk(store, S, BID, (b) => { taskOf(b, 't2').deps = []; }));
  try {
    assert.throws(
      () => store.setMember(S, BID, 't3', 'running', null, undefined, 'agent-10'),
      rejectFormOf(BID, 't2', 'IMM-4'),
      '图变更（加边）必须在同一份落盘内留 plan.mutated（IMM-4）',
    );
  } finally { setForge(null); }
});

// ── IMM-5｜拒则零落盘（rev 不推进、wavePlan 与成员态均不变）──────────────────
test('IMM-5 拒绝后零落盘：__rev 不推进、wavePlan 与 lanes 均保持盘上原值', () => {
  const { store, S, setForge } = setup();
  const BID = 'b-imm5-nowrite';
  mkBatch(store, S, BID, [{ id: 't1' }, { id: 't2' }]);
  store.setMember(S, BID, 't1', 'running', null, undefined, 'agent-9');
  const revBefore = store.readBatch(S, BID).__rev;
  const cmdOnDisk = taskOf(store.readBatch(S, BID), 't1').cmd;

  setForge(() => forgeDisk(store, S, BID, (b) => { taskOf(b, 't1').cmd = '盘上被改写值'; }));
  try {
    assert.throws(() => store.setMember(S, BID, 't2', 'running', null, undefined, 'agent-10'));
  } finally { setForge(null); }

  const after = store.readBatch(S, BID);
  assert.equal(taskOf(after, 't1').cmd, '盘上被改写值', 'wavePlan：落盘前的盘面内容不得被本次提交覆盖');
  assert.notEqual(cmdOnDisk, '盘上被改写值', '对照：改写确实发生在盘侧（构造有效）');
  assert.equal(after.__rev, revBefore, '拒绝必须发生在 atomicWrite 之前 ⇒ __rev 不推进');
  assert.equal(after.lanes.t2, 'pending', '被拒的派生状态改动同样不得落盘');
});

// ── 反例的边界（防误杀）：经 plan-mutate 留痕的合法加边必须放行 ────────────────
test('边界对照：经 addTaskEdges 留痕的合法加边不抛（guard 不误杀未派发图变更）', () => {
  const { store, S } = setup();
  const BID = 'b-ok-edge';
  mkBatch(store, S, BID, [{ id: 'a' }, { id: 't2' }, { id: 't3' }]);
  store.setMember(S, BID, 't3', 'running', null, undefined, 'agent-9'); // 已派发 lane 在批内也不受影响

  const b = store.addTaskEdges(S, BID, [{ id: 't2', add: ['a'] }], { reason: '合法加边', author: 'probe' });
  assert.deepEqual(taskOf(b, 't2').deps, ['a'], '未派发任务的加边仍允许（D-1：只冻结已派发）');
  assert.deepEqual(taskOf(b, 't3').deps ?? [], [], '已派发条目的既有 deps 未被触碰');
});
