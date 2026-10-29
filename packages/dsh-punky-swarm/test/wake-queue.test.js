/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/wake-queue.test.js —— **I-09 唤醒队列**（模块级判据）。
//
// 回线判据原文（口径源，禁改写）：**「空转仍产新 run ⇒ 停 G4」**。
//   它说的不是性能，而是本模块有没有存在价值：空转（没有新事件）仍能产出新 run ⇒ 整条队列等于没做。
//
// 断言形态纪律（B1/A1 教训）：**禁 `drain().length <= 2` 这类恒绿写法**（0 条也 ≤ 2）；
//   一律用「恰 1 条 / `deepEqual` 定值 / 集合相等」。
//
// 每条判据的**可红形态**（实现若写错 ⇒ 本用例红）：
//   W1 空转  若 `drain()` 把起过的 run 重新入队（M5 空转自唤醒）⇒ 三轮 `[0,0,0]` 变 `[1,1,1]` ⇒ 红；
//   W2 合并  若无 coalescing（每次 enqueue 各排一条）⇒ `drain().length` 3 ≠ 1 ⇒ 红；
//   W3 上界  若无续跑上界（不记账）⇒ 三轮 `[1,1,1]` ≠ `[1,1,0]` ⇒ 红（= 「空转产新 run」）；
//   W4 抑制  若 `suppressSelf` 只返回 true 而不落账 ⇒ 被抑制 lane 仍产 run ⇒ 红；
//   W5 跨 lane 若合并键写成常量 ⇒ `['L1']` ≠ `['L1','L2']` ⇒ 红；
//   W6 回零  若 drain 后保留残留队列 ⇒ 第二次 drain 非空 ⇒ 红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWakeQueue } from '../lib/state/wake-queue.js';

test('W1 【存在价值判据】首次产出 1 条后，连续三轮**空转** drain ⇒ 每轮 deepEqual([])（空转不产第 2 次 run）', () => {
  const q = createWakeQueue();
  q.enqueue({ lane: 'L1', reason: 'evt-1' });
  assert.deepEqual(q.drain().map((r) => r.lane), ['L1'], '第 1 轮恰 1 条');
  // 之后**不再有任何 enqueue** —— 纯空转
  assert.deepEqual(q.drain(), [], '空转第 1 轮');
  assert.deepEqual(q.drain(), [], '空转第 2 轮');
  assert.deepEqual(q.drain(), [], '空转第 3 轮');
});

test('W2 【coalescing】同 lane 连续 3 次 enqueue（未 drain）⇒ drain **恰 1 条**；coalesced 标志 [false,true,true]；runId 与首条一致', () => {
  const q = createWakeQueue();
  const a = q.enqueue({ lane: 'L1', reason: 'a' });
  const b = q.enqueue({ lane: 'L1', reason: 'b' });
  const c = q.enqueue({ lane: 'L1', reason: 'c' });
  assert.deepEqual([a.coalesced, b.coalesced, c.coalesced], [false, true, true]);
  assert.deepEqual([b.runId, c.runId], [a.runId, a.runId], '合并后 runId 必须与首条相同');
  const runs = q.drain();
  assert.equal(runs.length, 1, '恰 1 条（无 coalescing 会是 3）');
  assert.deepEqual(runs.map((r) => r.lane), ['L1']);
  assert.equal(runs[0].reason, 'c', '合并且 reason 取最新');
});

test('W3 【续跑上界 2】同 lane 三轮 drain→enqueue ⇒ run 数 deepEqual([1,1,0])（第 3 轮不产 run）', () => {
  const q = createWakeQueue({ maxResumes: 2 });
  const rounds = [];
  for (let i = 1; i <= 3; i += 1) {
    q.enqueue({ lane: 'L1', reason: 'r' + i });
    rounds.push(q.drain().length);
  }
  assert.deepEqual(rounds, [1, 1, 0], '上界 2 ⇒ 第 3 轮必须为 0（这是「空转不产第 3 次 run」的落点）');
  const after = q.enqueue({ lane: 'L1', reason: 'r4' });
  assert.deepEqual({ coalesced: after.coalesced, runId: after.runId }, { coalesced: false, runId: null }, '预算耗尽后 enqueue 回执不产 run');
});

test('W4 【自 block 抑制】suppressSelf 后该 lane 的 enqueue 回执 runId===null、drain deepEqual([])；他 lane 不受影响', () => {
  const q = createWakeQueue();
  assert.equal(q.isSuppressed('L1'), false);
  q.suppressSelf('L1', 'self-produced');
  assert.equal(q.isSuppressed('L1'), true);
  assert.deepEqual(q.enqueue({ lane: 'L1', reason: 'self' }), { coalesced: false, runId: null });
  assert.deepEqual(q.drain(), [], '被抑制 lane 不得产 run');
  q.enqueue({ lane: 'L2', reason: 'other' });
  assert.deepEqual(q.drain().map((r) => r.lane), ['L2'], '旁证：抑制只作用于该 lane');
});

test('W4b 【自 block】抑制**撤销已在队**的自产条目（不得先唤醒自己再抑制）', () => {
  const q = createWakeQueue();
  q.enqueue({ lane: 'L1', reason: 'queued-before-suppress' });
  q.suppressSelf('L1');
  assert.deepEqual(q.drain(), []);
});

test('W5 【跨 lane 不误合并】L1 + L2 各 1 次 ⇒ drain 的 lane 集合 deepEqual(["L1","L2"]) 且 runId 互不相同', () => {
  const q = createWakeQueue();
  q.enqueue({ lane: 'L1', reason: 'a' });
  q.enqueue({ lane: 'L2', reason: 'b' });
  const runs = q.drain();
  assert.deepEqual(runs.map((r) => r.lane).sort(), ['L1', 'L2'], '误合并会只剩 1 条 ⇒ 语义丢失');
  assert.equal(new Set(runs.map((r) => r.runId)).size, 2, 'runId 必须互异');
});

test('W6 【内存有界】drain 后队列回零（连续两次 drain 均 deepEqual([])）', () => {
  const q = createWakeQueue();
  q.enqueue({ lane: 'L1' });
  q.enqueue({ lane: 'L2' });
  q.drain();
  assert.deepEqual(q.drain(), []);
  assert.deepEqual(q.drain(), []);
});

test('W7 【入参纪律】enqueue 缺 lane 抛 TypeError（不得静默排入「未命名 lane」）', () => {
  const q = createWakeQueue();
  assert.throws(() => q.enqueue({}), TypeError);
  assert.throws(() => q.enqueue({ lane: '' }), TypeError);
});
