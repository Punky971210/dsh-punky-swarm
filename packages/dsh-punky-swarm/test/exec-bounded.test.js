/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/exec-bounded.test.js —— **X1 有界执行**（I-07 双时钟 / I-08 停止三阶段）的模块级判据。
//
// 判据原文（口径源，禁改写）：
//   · I-07：**思考期不计时**（判据不是「有 deadline」）——`begin` 只记 startedAt，`deadline` **只在 settle 之后**设定；
//   · I-08：三阶段四档 `thinking`/`with_grace`/`grace_exceeded`/`timed_out`，**未知不当已停**。
//
// 每条判据的**可红形态**（实现若写错 ⇒ 本用例红）：
//   T1 态① 若 `classify` 改用 `now() - startedAt` 起算 ⇒ elapsed=10×hardMs > hardMs ⇒ 红（这正是「把 begin 当 deadline 起点」的退化形态）；
//   T2 态② 若 `timedOut` 恒置 false ⇒ 红；
//   T3 态③ 若把边界写成 `elapsed < hardMs`（而非 `<=`）⇒ 恰 −1 处仍绿、`+1` 处红 ⇒ 由 T2 抓；若把 hardMs 当 graceMs ⇒ 红；
//   T4 四档 若少写一档（如缺 `timed_out`）⇒ 集合相等判据红；
//   T5 未知 若把未知 runId 分类成 `'timed_out'` / `timedOut:true`（把未知当已停）⇒ 红；
//   T6 未知结算 若 `settle` 对未知 runId 静默记账 ⇒ `assert.throws` 红；
//   T7 常量 若把 60_000 改成 60 或 graceMs 写成 6000 ⇒ 红（行为面 + 常量面双锚）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBoundedExec, BOUNDED_PHASES, HARD_TIMEOUT_MS, GRACE_TIMEOUT_MS,
} from '../lib/exec/bounded.js';

/** 可推进时钟（注入 now，模块不自持时间语义）。 */
function clockOf(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; return t; } };
}

test('T1 【I-07 态①·本意判据】begin 后时钟前进 10×hardMs ⇒ phase==="thinking" ∧ timedOut===false ∧ deadlineAt===null（思考期不计时）', () => {
  const clock = clockOf();
  const b = createBoundedExec({ now: clock.now });
  b.begin('r1');
  clock.advance(HARD_TIMEOUT_MS * 10);
  assert.deepEqual(b.classify('r1'), { phase: 'thinking', timedOut: false });
  assert.equal(b.deadlineAt('r1'), null, '未结算 ⇒ 不得有 deadline（思考不算执行超时）');
});

test('T2 【I-07 态②】settle 后前进 hardMs+1 ⇒ phase==="grace_exceeded" ∧ timedOut===true', () => {
  const clock = clockOf();
  const b = createBoundedExec({ now: clock.now });
  b.begin('r2');
  clock.advance(5_000); // 思考 5s（不计时）
  b.settle('r2', 'ok');
  clock.advance(HARD_TIMEOUT_MS + 1);
  assert.deepEqual(b.classify('r2'), { phase: 'grace_exceeded', timedOut: true });
});

test('T3 【I-07 态③】settle 后前进 hardMs-1 ⇒ phase==="with_grace" ∧ timedOut===false（边界严格）', () => {
  const clock = clockOf();
  const b = createBoundedExec({ now: clock.now });
  b.begin('r3');
  clock.advance(5_000);
  b.settle('r3', 'ok');
  clock.advance(HARD_TIMEOUT_MS - 1);
  assert.deepEqual(b.classify('r3'), { phase: 'with_grace', timedOut: false });
});

test('T3b 【I-07 双钟对照】同样「时钟前进 hardMs+1」，未结算 ⊂ 不超时 / 已结算 ⊂ 超时（唯一变量 = 是否结算）', () => {
  const clock = clockOf();
  const b = createBoundedExec({ now: clock.now });
  b.begin('thinking-run');
  b.begin('settled-run');
  b.settle('settled-run', 'ok');
  clock.advance(HARD_TIMEOUT_MS + 1);
  assert.deepEqual(b.classify('thinking-run'), { phase: 'thinking', timedOut: false }, '思考期（未结算）同刻不超时');
  assert.equal(b.classify('settled-run').timedOut, true, '已结算同刻必超时');
});

test('T4 【I-08】四档常量逐档在场，且**不含** stopped（未知不是一种「已停」态）', () => {
  assert.deepEqual([...BOUNDED_PHASES].sort(), ['grace_exceeded', 'thinking', 'timed_out', 'with_grace']);
  assert.equal(BOUNDED_PHASES.includes('stopped'), false);
});

test('T5 【I-08 拒绝态】从未 begin / 已 cancel 的 runId ⇒ classify 一律 {phase:"thinking",timedOut:false}（未知不当已停）', () => {
  const clock = clockOf();
  const b = createBoundedExec({ now: clock.now });
  assert.deepEqual(b.classify('never-begun'), { phase: 'thinking', timedOut: false }, '从未 begin');
  b.begin('r5');
  b.settle('r5', 'ok');
  clock.advance(HARD_TIMEOUT_MS + 1);
  assert.equal(b.classify('r5').timedOut, true, '阳性前置：已结算必超时');
  b.cancel('r5');
  assert.deepEqual(b.classify('r5'), { phase: 'thinking', timedOut: false }, 'cancel 后回落未知态（不得保留「已停」记忆）');
});

test('T6 【I-08 拒绝态】settle 未知 runId ⇒ 抛普通 Error（不得伪造「已结算」记录）', () => {
  const b = createBoundedExec({ now: () => 1_000_000 });
  assert.throws(() => b.settle('ghost', 'ok'), /unknown runId/);
  assert.deepEqual(b.classify('ghost'), { phase: 'thinking', timedOut: false }, '抛错后不得留下伪造记录');
});

test('T7 【阈值】两常量行为面生效：HARD=60000 / GRACE=600000，且 grace 边界可用', () => {
  assert.equal(HARD_TIMEOUT_MS, 60_000);
  assert.equal(GRACE_TIMEOUT_MS, 600_000);
  const clock = clockOf();
  const b = createBoundedExec({ now: clock.now });
  b.begin('r7');
  b.settle('r7', 'ok');
  clock.advance(HARD_TIMEOUT_MS + 1);
  assert.equal(b.classify('r7').phase, 'grace_exceeded');
  clock.advance(GRACE_TIMEOUT_MS); // 越过 grace 上界
  assert.deepEqual(b.classify('r7'), { phase: 'timed_out', timedOut: true });
});
