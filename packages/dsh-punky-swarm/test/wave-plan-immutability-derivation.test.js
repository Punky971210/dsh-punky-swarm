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

// 批 `punky-mac-wave-immutability-2026-10-29` · lane `e2-tester` —— **正例面 / 防过度禁止**。
//
// 判据源：任务包 `plan/p2-taskpack-w2.md`
//   · §4.5  tester 必须**独立**断言的三件事（拒态形态 / 消息内容 / 正例不抛且写后读到预期值）
//   · §5    `AC-6`（正例面 0 fail、追加与加边各 ≥1 例、派生状态可写 ≥1 例）
//          `AC-8`（拒态形态 4 项逐条）/ `AC-9`（拒则零落盘）
//   · §6    `C-10` 不写数量断言、不引入 test.todo
//   · Leader 裁定 `D-1`：**已派发只读，未派发追加/加边仍允许（经 plan-mutate 并留痕）**
//   · Leader 裁定 `D-2`：写域互斥 —— 本文件是 tester **唯一**写码面，coder 的
//     `test/wave-plan-immutability.test.js` 与 `lib/state/store.js` 一律不碰（缺陷只进报告）
//
// 结构：① 派生状态可写（成员状态 / 检查点 / 计数，防过度禁止）
//       ④⑤ 未派发图变更仍可用（D-1 的「追加/加边豁免 + 同一次落盘留痕」硬要件）
//       ⑥⑦ 已派发结构被分叉改写 ⇒ 拒 + 拒态形态（AC-8 四项）+ 零落盘（IMM-5）
//
// 反例的构造方式（重要，勿误读）：guard 的唯一入口 `commitBatch` **不在 store 公开面**
//   （实测 `typeof store.commitBatch === 'undefined'`）⇒ 从外部没有「把改写过的 batch 递交落盘」的路径。
//   故 ⑥⑦ 用仓内既有确定性注入缝 `createStore(root, { revRaceHook })`
//   （`lib/state/store.js` 注释明示为**测试缝**，生产不传 ⇒ 零行为；同族先例 `test/f3-rev-cas.test.js:78`）
//   模拟「并发写者在本次读批之后、落盘之前改掉盘上已派发条目」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildWavePlan } from '../lib/wave-plan.js';
import { createStore } from '../lib/state/store.js';

const SILENT = { warn: () => {}, info: () => {}, error: () => {} };

// 稳定 id（禁魔法字符串散落；同时让 AC-8「消息须含出错 lane id」有可核锚点）
const DISPATCHED = 'imm-t-a'; // 会被派发（owner 非空）的条目 —— 「已派发」面的唯一受试对象
const POOLED_B = 'imm-t-b'; // 池内（owner 为 null）—— 加边的目标
const POOLED_C = 'imm-t-c'; // 池内（owner 为 null）—— 加边的上游
const TAMPERED_CMD = 'tampered-by-competing-writer';
const TAMPERED_DEP = 'imm-t-ghost';

function baseTasks() {
  return [
    { id: DISPATCHED, cmd: 'A' },
    { id: POOLED_B, cmd: 'B', deps: [DISPATCHED] },
    { id: POOLED_C, cmd: 'C', deps: [DISPATCHED] },
  ];
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'punky-imm-deriv-'));
}

function setup() {
  const root = tmpRoot();
  const store = createStore(root, { logger: SILENT });
  return { root, store, S: 'sess-imm-deriv' };
}

// 注入缝版：`arm(fn)` 装一次「下一次 commitBatch 入口」的并发写者动作（消费即卸甲）
function setupWithCommitHook() {
  const root = tmpRoot();
  let armed = null;
  const store = createStore(root, {
    logger: SILENT,
    revRaceHook: ({ file }) => {
      if (typeof armed !== 'function') return;
      const fire = armed;
      armed = null;
      fire(file);
    },
  });
  return { root, store, S: 'sess-imm-deriv', arm: (fn) => { armed = fn; } };
}

function mkBatch(store, S, batchId, tasks) {
  store.createBatch(S, { batchId, wavePlan: buildWavePlan({ batchId, tasks }), phase: 'running' });
}

const flatOf = (batch) => (batch?.wavePlan ?? []).flatMap((w) => (Array.isArray(w?.tasks) ? w.tasks : []));
const taskOf = (batch, id) => flatOf(batch).find((t) => t && t.id === id) ?? null;

// 派发 = owner 写入声明面（`to === 'running'` 且给 owner 字符串）；本批受试批次的入口动作
function dispatchFixture(store, S, batchId) {
  store.setMember(S, batchId, DISPATCHED, 'running', null, undefined, 'agent-imm');
}

// ── ① 派生状态可写：成员状态（派发迁移 + owner）──────────────────────────────────
test('imm-derivation-1 派生状态可写：派发迁移与 owner 写入不被拦（防过度禁止）', () => {
  const { store, S } = setup();
  const B = 'b-imm-deriv-1';
  mkBatch(store, S, B, baseTasks());

  const before = store.readBatch(S, B);
  assert.equal(taskOf(before, DISPATCHED).owner, null, '前置：建批后该条目在池内（owner === null）');

  assert.doesNotThrow(
    () => dispatchFixture(store, S, B),
    '派生写（成员状态迁移 + owner 写入）必须成功：guard 只冻结 wavePlan 结构，不得禁止派生面',
  );

  const after = store.readBatch(S, B);
  assert.equal(taskOf(after, DISPATCHED).owner, 'agent-imm', '派发 ⇒ owner 写入声明面（D-1：未派发部分可写）');
  assert.equal(after.lanes[DISPATCHED], 'running', '执行面 lanes 同步迁移');
  assert.ok(
    after.events.some((e) => e && e.type === 'task.owner.assigned'),
    '出池须留痕 task.owner.assigned（与 owner 同一次落盘）',
  );
  assert.notEqual(after.__rev, before.__rev, '派生写确实落盘（__rev 已推进，非空操作）');
});

// ── ② 派生状态可写：检查点（laneProgress）────────────────────────────────────────
test('imm-derivation-2 派生状态可写：检查点写入不被拦且不改动 wavePlan', () => {
  const { store, S } = setup();
  const B = 'b-imm-deriv-2';
  mkBatch(store, S, B, baseTasks());
  dispatchFixture(store, S, B);

  const planBefore = JSON.stringify(store.readBatch(S, B).wavePlan);

  assert.doesNotThrow(
    () => store.updateLaneProgress(S, B, POOLED_B, { step: 2, total: 5, status: 'running' }),
    '检查点写入属派生状态（计数/成员状态/检查点），必须不被 guard 拦',
  );

  const after = store.readBatch(S, B);
  assert.equal(after.laneProgress[POOLED_B].step, 2, '检查点须落到 laneProgress');
  assert.equal(after.laneProgress[POOLED_B].total, 5, '检查点 total 原样保留');
  assert.equal(JSON.stringify(after.wavePlan), planBefore, '检查点写不得改动 wavePlan（逐字相等）');
});

// ── ③ 派生状态可写：计数记账（chains）───────────────────────────────────────────
test('imm-derivation-3 派生状态可写：批次计数记账写入不被拦且不改动 wavePlan', () => {
  const { store, S } = setup();
  const B = 'b-imm-deriv-3';
  mkBatch(store, S, B, baseTasks());
  dispatchFixture(store, S, B);

  const planBefore = JSON.stringify(store.readBatch(S, B).wavePlan);
  const budgets = { chains: { [DISPATCHED]: { budget: 3, used: 1 } }, order: [DISPATCHED] };

  assert.doesNotThrow(
    () => store.updateChains(S, B, budgets),
    '计数/记账（chains）属派生状态，必须不被 guard 拦',
  );

  const after = store.readBatch(S, B);
  assert.deepEqual(after.chains.chains[DISPATCHED], { budget: 3, used: 1 }, '计数须落盘且值原样');
  assert.deepEqual(after.chains.order, [DISPATCHED], '记账 order 原样保留');
  assert.equal(JSON.stringify(after.wavePlan), planBefore, '计数写不得改动 wavePlan（逐字相等）');
});

// ── ④ 正例·未派发追加仍可用（D-1）──────────────────────────────────────────────
test('imm-derivation-4 未派发追加仍可用：addPoolTasks 成功 + 同一次落盘留痕 + 已派发条目逐字不变', () => {
  const { store, S } = setup();
  const B = 'b-imm-deriv-4';
  mkBatch(store, S, B, baseTasks());
  dispatchFixture(store, S, B);

  const before = store.readBatch(S, B);

  assert.doesNotThrow(
    () => store.addPoolTasks(S, B, [{ id: 'imm-t-d', cmd: 'D', deps: [DISPATCHED] }], {
      reason: 'imm-derivation-4 追加正例',
      author: 'e2-tester',
    }),
    'D-1：未派发的追加**仍允许**（guard 不得把合法图变更判成改写）',
  );

  const after = store.readBatch(S, B);
  assert.ok(taskOf(after, 'imm-t-d'), '追加任务须落盘');
  assert.deepEqual(taskOf(after, 'imm-t-d').deps, [DISPATCHED], '追加任务的 deps 原样保留');
  assert.deepEqual(
    taskOf(after, DISPATCHED),
    taskOf(before, DISPATCHED),
    '已派发条目必须逐字不变（重归一化不得被误判为改写 ⇒ 防过度禁止的核心断言）',
  );
  assert.ok(
    after.events.slice(before.events.length).some((e) => e && e.type === 'plan.mutated'),
    '图变更须在**同一次落盘**的追加段内留下 plan.mutated（IMM-4 硬要件）',
  );
});

// ── ⑤ 正例·未派发加边仍可用（D-1）──────────────────────────────────────────────
test('imm-derivation-5 未派发加边仍可用：addTaskEdges 成功 + deps 尾部追加 + 留痕 + 已派发条目不变', () => {
  const { store, S } = setup();
  const B = 'b-imm-deriv-5';
  mkBatch(store, S, B, baseTasks());
  dispatchFixture(store, S, B);

  const before = store.readBatch(S, B);
  assert.deepEqual(taskOf(before, POOLED_C).deps, [DISPATCHED], '前置：目标条目已有旧边');

  assert.doesNotThrow(
    () => store.addTaskEdges(S, B, [{ id: POOLED_C, add: [POOLED_B] }], {
      reason: 'imm-derivation-5 加边正例',
      author: 'e2-tester',
    }),
    'D-1：未派发任务加边**仍允许**（K1 池内可调依赖；guard 不得拦）',
  );

  const after = store.readBatch(S, B);
  assert.deepEqual(
    taskOf(after, POOLED_C).deps,
    [DISPATCHED, POOLED_B],
    '加边须为「旧边在前 + 新边尾部追加」（IMM-3② 前缀性质），不得重排或插队',
  );
  assert.deepEqual(
    taskOf(after, DISPATCHED),
    taskOf(before, DISPATCHED),
    '已派发条目必须逐字不变（加边不得串改已派发结构）',
  );
  assert.ok(
    after.events.slice(before.events.length).some((e) => e && e.type === 'plan.mutated'),
    '加边须在**同一次落盘**的追加段内留下 plan.mutated（IMM-4 硬要件）',
  );
});

// ── ⑥ 反例·已派发 cmd 被分叉改写 ⇒ 拒 + 形态 4 项 + 零落盘 ─────────────────────
test('imm-derivation-6 已派发结构被改写 ⇒ 普通 Error 拒（形态 4 项）且零落盘', () => {
  const { store, S, arm } = setupWithCommitHook();
  const B = 'b-imm-deriv-6';
  mkBatch(store, S, B, baseTasks());
  dispatchFixture(store, S, B);

  const baseline = store.readBatch(S, B);

  // 并发写者：在本次「读批之后、落盘之前」把盘上已派发条目改掉（保留 __rev ⇒ rev CAS 不先行拦下）
  arm((file) => {
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    const victim = flatOf(disk).find((t) => t && t.id === DISPATCHED);
    victim.cmd = TAMPERED_CMD;
    fs.writeFileSync(file, JSON.stringify(disk, null, 2), 'utf8');
  });

  let caught = null;
  try {
    store.updateLaneProgress(S, B, POOLED_B, { step: 1, total: 3, status: 'running' });
  } catch (err) {
    caught = err;
  }

  assert.ok(
    caught,
    '已派发条目被改写（与本次提交分叉）⇒ 必须拒。'
    + '此处为 null 只有两种成因：① guard 未接线（AC-5 的 RED 态，待 coder 接线后复跑转绿）；'
    + '② guard 判据漏了 cmd 字段。两种都须如实登记，不得靠放宽用例掩盖',
  );

  // ── AC-8：拒态形态 4 项，逐条独立断言 ────────────────────────────────────────
  assert.ok(caught instanceof Error, '形态①：拒态必须是 Error 实例');
  assert.equal(caught.code, undefined, '形态②：拒态不得设置 err.code（否则会进拒码集合）');

  const message = String(caught.message);
  assert.match(message, /^\[wave-plan-immutable\]/, '形态③a：消息前缀须固定为 [wave-plan-immutable]');
  assert.ok(!/^GATE_/.test(message), '形态③b：消息**开头**不得出现 GATE_ 前缀（否则二次扩大拒码集合）');
  assert.ok(!/GATE_/.test(message), '形态③c：消息**任意位置**不得出现 GATE_（拒码集合零新增）');
  assert.ok(message.includes(B), '形态④a：消息须含 batchId（可定位到批次）');
  assert.ok(message.includes(DISPATCHED), '形态④b：消息须含出错的 lane/task id（可定位到条目）');

  // ── AC-9 / IMM-5：拒则零落盘 ────────────────────────────────────────────────
  const after = store.readBatch(S, B);
  assert.equal(after.__rev, baseline.__rev, 'IMM-5：拒绝须发生在 atomicWrite 之前 ⇒ __rev 不得推进');
  assert.equal(
    taskOf(after, DISPATCHED).cmd,
    TAMPERED_CMD,
    'IMM-5：本次提交被拒 ⇒ 盘上该值保持原样，**不得**被静默覆盖（覆盖即 lost update）',
  );
});

// ── ⑦ 反例·已派发 deps 被分叉改写 ⇒ 拒（IMM-2 的 deps 条款独立受试）───────────
test('imm-derivation-7 已派发条目的 deps 被改写 ⇒ 拒（deps 条款单独可达）', () => {
  const { store, S, arm } = setupWithCommitHook();
  const B = 'b-imm-deriv-7';
  mkBatch(store, S, B, baseTasks());
  dispatchFixture(store, S, B);

  const baseline = store.readBatch(S, B);
  assert.deepEqual(taskOf(baseline, DISPATCHED).deps, [], '前置：已派发条目的 deps 为空');

  arm((file) => {
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    const victim = flatOf(disk).find((t) => t && t.id === DISPATCHED);
    victim.deps = [TAMPERED_DEP]; // 给已派发条目凭空插一条边
    fs.writeFileSync(file, JSON.stringify(disk, null, 2), 'utf8');
  });

  let caught = null;
  try {
    store.addPoolTasks(S, B, [{ id: 'imm-t-e', cmd: 'E' }], {
      reason: 'imm-derivation-7 反例',
      author: 'e2-tester',
    });
  } catch (err) {
    caught = err;
  }

  assert.ok(
    caught,
    '已派发条目的 deps 被改写 ⇒ 必须拒（IMM-2 的 deps 条款）。'
    + '此处为 null ⇒ guard 未接线或 deps 未纳入比对，须如实登记',
  );
  assert.ok(caught instanceof Error, '拒态必须是 Error 实例');
  assert.equal(caught.code, undefined, '拒态不得设置 err.code');
  const message = String(caught.message);
  assert.ok(!/GATE_/.test(message), '消息任意位置不得出现 GATE_');
  assert.ok(message.includes(DISPATCHED), '消息须含出错的 lane/task id');

  const after = store.readBatch(S, B);
  assert.equal(after.__rev, baseline.__rev, 'IMM-5：拒则零落盘（__rev 不推进）');
  assert.deepEqual(
    taskOf(after, DISPATCHED).deps,
    [TAMPERED_DEP],
    'IMM-5：盘上被分叉的值保持原样，不得被静默覆盖',
  );
});
