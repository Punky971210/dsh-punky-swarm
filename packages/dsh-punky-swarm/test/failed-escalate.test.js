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

// C 子项：连续失败升级（spec C）单测——计数纯函数 + setMember failed 分支触发集成
// 覆盖：连续 3 failed 触发 paused / 中间 merged 归零 / 阈值 2 不触发 / paused 后不重复 / resume 后重新评估 / failed 终态不变
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore, countConsecutiveFailedSettles } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-esc-'));
const store = createStore(root);
const S = 'sess-esc';

function makeRunningBatch(batchId, lanes) {
  const plan = buildWavePlan({ batchId, tasks: lanes.map((id) => ({ id })) });
  store.createBatch(S, { batchId, wavePlan: plan, phase: 'running' });
}
const failed = (batchId, lane) => store.setMember(S, batchId, lane, 'failed');
const merged = (batchId, lane) => {
  store.setMember(S, batchId, lane, 'running');
  store.setMember(S, batchId, lane, 'review');
  store.setMember(S, batchId, lane, 'merged');
};
const escalateEvents = (batchId) => store.readBatch(S, batchId).events.filter((e) => e.type === 'batch.failed-escalate');
const phaseEvents = (batchId) => store.readBatch(S, batchId).events.filter((e) => e.type === 'batch.phase');
const mkEvent = (type, fields = {}) => ({ ts: '2026-08-23T00:00:00.000Z', type, ...fields });

// ---- 纯函数：countConsecutiveFailedSettles ----

test('countConsecutiveFailedSettles 纯函数：空/undefined → 0', () => {
  assert.equal(countConsecutiveFailedSettles([]), 0);
  assert.equal(countConsecutiveFailedSettles(undefined), 0);
  assert.equal(countConsecutiveFailedSettles(null), 0);
});

test('countConsecutiveFailedSettles 纯函数：混合事件流（非 member.settled 不打断）计数正确', () => {
  const events = [
    mkEvent('batch.created'),
    mkEvent('worktree.checkpoint', { lane: 'f1', step: 1, total: 2 }),
    mkEvent('member.settled', { lane: 'f1', from: 'pending', to: 'failed' }),
    mkEvent('batch.phase', { from: 'running', to: 'paused', reason: 'failed-escalate' }),
    mkEvent('member.settled', { lane: 'f2', from: 'pending', to: 'failed' }),
    mkEvent('gate.entry.missing', { lane: 'f3' }),
    mkEvent('member.settled', { lane: 'f3', from: 'pending', to: 'failed' }),
  ];
  assert.equal(countConsecutiveFailedSettles(events), 3); // 尾部连续 3 failed，batch.phase/gate/worktree 事件不打断
});

test('countConsecutiveFailedSettles 纯函数：任一非 failed 结算归零', () => {
  const events = [
    mkEvent('member.settled', { lane: 'f1', from: 'pending', to: 'failed' }),
    mkEvent('member.settled', { lane: 'f2', from: 'pending', to: 'failed' }),
    mkEvent('member.settled', { lane: 'm1', from: 'review', to: 'merged' }),
    mkEvent('member.settled', { lane: 'f3', from: 'pending', to: 'failed' }),
  ];
  assert.equal(countConsecutiveFailedSettles(events), 1); // 末尾 f3 之后遇 merged 停止
});

test('countConsecutiveFailedSettles 纯函数：conflict/skipped/review/running 同样归零', () => {
  for (const stopTo of ['conflict', 'skipped', 'review', 'running']) {
    const events = [
      mkEvent('member.settled', { lane: 'a', from: 'pending', to: 'failed' }),
      mkEvent('member.settled', { lane: 'a', from: 'pending', to: 'failed' }),
      mkEvent('member.settled', { lane: 'b', from: 'running', to: stopTo }),
    ];
    assert.equal(countConsecutiveFailedSettles(events), 0, 'stop at ' + stopTo);
  }
});

// ---- 集成：setMember failed 分支触发 ----

test('C: 连续 3 failed 触发 → phase paused + batch.failed-escalate {count:3}', () => {
  makeRunningBatch('b-esc1', ['f1', 'f2', 'f3']);
  failed('b-esc1', 'f1');
  failed('b-esc1', 'f2');
  failed('b-esc1', 'f3');
  const b = store.readBatch(S, 'b-esc1');
  assert.equal(b.phase, 'paused');
  assert.deepEqual(b.lanes, { f1: 'failed', f2: 'failed', f3: 'failed' }); // failed 终态不变
  const esc = escalateEvents('b-esc1');
  assert.equal(esc.length, 1);
  assert.equal(esc[0].lane, 'f3');
  assert.equal(esc[0].count, 3);
  const ph = phaseEvents('b-esc1').filter((e) => e.reason === 'failed-escalate');
  assert.equal(ph.length, 1);
  assert.deepEqual({ from: ph[0].from, to: ph[0].to, reason: ph[0].reason }, { from: 'running', to: 'paused', reason: 'failed-escalate' });
});

test('C: 中间 merged 归零（failed→merged→failed×2 → streak=2 不触发）', () => {
  makeRunningBatch('b-reset', ['f1', 'm1', 'f2', 'f3']);
  failed('b-reset', 'f1');
  merged('b-reset', 'm1');
  failed('b-reset', 'f2');
  failed('b-reset', 'f3');
  const b = store.readBatch(S, 'b-reset');
  assert.equal(b.phase, 'running'); // 未触发
  assert.equal(escalateEvents('b-reset').length, 0);
});

test('C: 阈值 2 不触发（phase 仍 running、无 batch.failed-escalate）', () => {
  makeRunningBatch('b-thr', ['f1', 'f2']);
  failed('b-thr', 'f1');
  failed('b-thr', 'f2');
  const b = store.readBatch(S, 'b-thr');
  assert.equal(b.phase, 'running');
  assert.equal(escalateEvents('b-thr').length, 0);
});

test('C: paused 后不重复（继续 failed → 事件仍 1 条、phase 仍 paused）', () => {
  makeRunningBatch('b-norep', ['f1', 'f2', 'f3', 'f4']);
  failed('b-norep', 'f1');
  failed('b-norep', 'f2');
  failed('b-norep', 'f3');
  assert.equal(store.readBatch(S, 'b-norep').phase, 'paused');
  failed('b-norep', 'f4'); // paused 后继续 failed 结算
  const b = store.readBatch(S, 'b-norep');
  assert.equal(b.phase, 'paused');
  assert.equal(b.lanes.f4, 'failed'); // 结算照常写入（仅不触发升级）
  assert.equal(escalateEvents('b-norep').length, 1);
});

test('C: resume 后重新评估（paused→running→failed 再达阈值 → 再次 paused + 第 2 条事件）', () => {
  makeRunningBatch('b-resume', ['f1', 'f2', 'f3', 'f4']);
  failed('b-resume', 'f1');
  failed('b-resume', 'f2');
  failed('b-resume', 'f3');
  assert.equal(store.readBatch(S, 'b-resume').phase, 'paused');
  store.setPhase(S, 'b-resume', 'running'); // 人工 resume
  failed('b-resume', 'f4'); // 计数从当前事件流重新评估：连续 failed = 4 ≥ 3 → 再次触发
  const b = store.readBatch(S, 'b-resume');
  assert.equal(b.phase, 'paused');
  const esc = escalateEvents('b-resume');
  assert.equal(esc.length, 2);
  assert.equal(esc[1].lane, 'f4');
  assert.equal(esc[1].count, 4);
});

test('C: 不自动重试（failed 终态语义不变）', () => {
  makeRunningBatch('b-term', ['f1', 'f2', 'f3']);
  failed('b-term', 'f1');
  failed('b-term', 'f2');
  failed('b-term', 'f3');
  const b = store.readBatch(S, 'b-term');
  assert.equal(b.phase, 'paused');
  assert.equal(b.lanes.f1, 'failed'); // failed 仍为终态
  assert.throws(() => store.setMember(S, 'b-term', 'f1', 'running')); // 终态不可回退（无自动重试路径）
  // 触发仅追加事件，不引入 running 态 / 重试结算
  const retried = b.events.filter((e) => e.type === 'member.settled' && e.lane === 'f1' && e.to === 'running');
  assert.equal(retried.length, 0);
});
