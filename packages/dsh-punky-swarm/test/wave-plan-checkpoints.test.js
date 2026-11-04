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

// test/wave-plan-checkpoints.test.js —— `normalizeCheckpoints` **行为**用例
// （批 `punky-wp-ts-restore-20261103` · lane `impl`）
//
// 为什么要这份用例：`normalizeCheckpoints` 曾**只存在于构建产物** `lib/wave-plan.js`（提交 `0521292` 手改、
//   未写 `.ts`）⇒ 一次 build 静默擦除后，**全量测试仍然全绿** ⇒ 功能丢失无人发现。
//   守卫（`scripts/build-sync-guard.mjs`）只能证明「符号在两侧都在」——**证明不了行为是对的**。
//   ⇒ 本文件补上行为面：**覆盖五条语义**（未声明 / 坏项丢弃 / 绝对路径丢弃 / rounds 归一 / 零 throw）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCheckpoints, buildWavePlan } from '../lib/wave-plan.js';

// ── ① 未声明 ⇒ null（调用方据此**不写键** ⇒ 存量批零感知）────────────────────────────────
test('CP-1 未声明（null / undefined / 非数组以外的缺省）⇒ null', () => {
  assert.equal(normalizeCheckpoints(null), null);
  assert.equal(normalizeCheckpoints(undefined), null);
});

// ── ② 已声明但形态坏 ⇒ **仍返回对象**（渲染层据此给一行降级警示，而不是当没声明）──────────
test('CP-2 非数组 / 数组里全坏项 ⇒ 返回 { items: [] }（不是 null）', () => {
  assert.deepEqual(normalizeCheckpoints({ id: 'x' }), { items: [] }, '非数组 ⇒ 空数组（对象仍在）');
  assert.deepEqual(normalizeCheckpoints([null, 42, 'str', []]), { items: [] }, '坏项全丢但对象仍在');
});

// ── ③ 坏项丢弃：无 id / id 重复 / 绝对路径 target ──────────────────────────────────────────
test('CP-3 id 必填且唯一；绝对路径 target 丢弃（与 targets 语义相反）', () => {
  const r = normalizeCheckpoints([
    { id: 'a', target: 'exec/x.md' },
    { id: 'a', target: 'exec/y.md' },          // 重复 id ⇒ 丢
    { target: 'exec/z.md' },                    // 无 id ⇒ 丢
    { id: 'b', target: 'C:\\abs\\path.md' },     // 绝对路径 ⇒ 丢
    { id: 'c', target: '/abs/posix.md' },        // 绝对路径 ⇒ 丢
    { id: 'd' },                                 // 缺 target ⇒ **保留**
  ]);
  assert.deepEqual(r.items.map((i) => i.id), ['a', 'd'], '只剩首个 a 与 d');
  assert.equal(r.items[0].target, 'exec/x.md', '相对 target 保留');
  assert.equal(r.items[1].target, '', '缺 target ⇒ 空串（不静默丢，渲染成「（未声明目标）」）');
});

// ── ④ rounds / ctxBudget 归一 ─────────────────────────────────────────────────────────────
test('CP-4 rounds 非法 ⇒ 1；ctxBudget 非正/NaN/非数字 ⇒ null', () => {
  const r = normalizeCheckpoints([
    { id: 'a', rounds: 3, ctxBudget: 8000 },
    { id: 'b', rounds: 0 },                     // <1 ⇒ 1
    { id: 'c', rounds: 2.5 },                   // 非整数 ⇒ 1
    { id: 'd', rounds: '4' },                   // 非 number ⇒ 1
    { id: 'e', ctxBudget: 0 },                  // 非正 ⇒ null
    { id: 'f', ctxBudget: Number.NaN },          // NaN ⇒ null
  ]);
  const by = Object.fromEntries(r.items.map((i) => [i.id, i]));
  assert.equal(by.a.rounds, 3);
  assert.equal(by.a.ctxBudget, 8000);
  assert.equal(by.b.rounds, 1);
  assert.equal(by.c.rounds, 1);
  assert.equal(by.d.rounds, 1);
  assert.equal(by.e.ctxBudget, null);
  assert.equal(by.f.ctxBudget, null);
});

// ── ⑤ outputs 过滤 + acceptance trim + 零 throw ───────────────────────────────────────────
test('CP-5 outputs 过滤非字符串/空白；acceptance trim；坏输入不抛（零 throw 全软）', () => {
  const r = normalizeCheckpoints([{ id: 'a', outputs: ['x', 1, '  ', 'y  '], acceptance: '  ok  ' }]);
  assert.deepEqual(r.items[0].outputs, ['x', 'y'], '只留非空字符串并 trim');
  assert.equal(r.items[0].acceptance, 'ok', 'acceptance trim');
  // 零 throw：getter 抛错也不得炸穿（**实际语义 = 整块视同未声明**，见下）
  const evil = { get id() { throw new Error('boom'); } };
  assert.doesNotThrow(() => normalizeCheckpoints([evil]), '坏数据不得阻断建批');
  // ⚠ 实测语义（0521292 原样）：循环体在 try 内 ⇒ **任一项抛错 ⇒ 最外层 catch ⇒ 返回 null**
  //   （不是「丢该项、其余照常」）。这与「永不抛」一致，但**粒度是整块**——登记在此防误读。
  assert.equal(normalizeCheckpoints([evil]), null, '任一项抛错 ⇒ 整块视同未声明（返回 null）');
  // 对照：**非抛错**的坏项只丢该项，其余照常
  assert.deepEqual(normalizeCheckpoints([{ id: 'ok' }, { noId: true }]).items.map((i) => i.id), ['ok'],
    '非抛错的坏项 ⇒ 只丢该项');
});

// ── ⑥ 端到端：`buildWavePlan` 的**落盘形状** ─────────────────────────────────────────────
test('CP-6 端到端：未声明 ⇒ 不写键；已声明 ⇒ 写归一结果；contract 非法 ⇒ 普通 Error（非 GATE_）', () => {
  const base = (t) => ({ batchId: 'b-cp', tasks: [{ id: 'l1', ...t }] });

  const plain = buildWavePlan(base({}));
  // 形状无关：`buildWavePlan` 可能返回数组或 `{ wavePlan }` ⇒ 统一取任务列表
  const tasksOf = (plan) => {
    const waves = Array.isArray(plan) ? plan
      : (plan && Array.isArray(plan.wavePlan) ? plan.wavePlan : (plan && Array.isArray(plan.tasks) ? [{ tasks: plan.tasks }] : []));
    return waves.flatMap((w) => (Array.isArray(w?.tasks) ? w.tasks : []));
  };
  const t0 = tasksOf(plain).find((x) => x.id === 'l1');
  assert.ok(t0, '任务应在产出里');
  assert.equal('checkpoints' in t0, false, '未声明 ⇒ **不写键**（存量批零感知）');
  assert.equal('contract' in t0, false, '未声明 ⇒ 不写键');

  const withCp = buildWavePlan(base({ checkpoints: [{ id: 'a', target: 'exec/x.md', rounds: 2 }], contract: { id: 'c1', sha256: null } }));
  const t1 = tasksOf(withCp).find((x) => x.id === 'l1');
  assert.deepEqual(t1.checkpoints.items.map((i) => i.id), ['a'], '已声明 ⇒ 写归一结果');
  assert.equal(t1.checkpoints.items[0].rounds, 2);
  assert.deepEqual(t1.contract, { id: 'c1', sha256: null }, 'contract 归一写盘');

  // contract 非法 ⇒ fail-closed，且**普通 Error**（禁 `GATE_*` 前缀 —— 验收 5）
  let err = null;
  try { buildWavePlan(base({ contract: { id: '' } })); } catch (e) { err = e; }
  assert.ok(err instanceof Error, 'contract.id 非法必须抛');
  assert.equal(/^GATE_/.test(String(err.message)), false, '不得新造 GATE_ 前缀：' + err.message);
});
