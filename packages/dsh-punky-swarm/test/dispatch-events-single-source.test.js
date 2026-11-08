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

// `member.dispatch` 读取口径的**显式化**判据（等价重构的回归锁，不是 RED→GREEN）：
//   统一前「取最近一次」与「取首个命中」两套扫描在代码里长得一模一样，改一处就会静默改掉派发归属。
//   本文件把两种口径钉成两个具名行为：DE-1 最近 / DE-2 首个 / DE-3 lane 集合 / DE-4 绑定层用「最近」。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dispatchRecordsOf, expectedWorkerSessionOf, workerLanesOf, firstDispatchOfSession,
} from '../lib/state/dispatch-events.js';
import { dispatchBindingDecision } from '../lib/verify/binding.js';

// 同一 lane 被重派：e1 → W1（首派），e2 → W1，e1 → W2（重派）
const events = [
  { type: 'member.dispatch', lane: 'e1', workerSessionId: 'W1', ts: 't1' },
  { type: 'member.status', lane: 'e1', status: 'running' },
  { type: 'member.dispatch', lane: 'e2', workerSessionId: 'W1', ts: 't2' },
  { type: 'member.dispatch', lane: 'e1', workerSessionId: 'W2', ts: 't3' },
  { type: 'member.dispatch', lane: '', workerSessionId: 'W3' },        // 缺 lane ⇒ 丢弃
  { type: 'member.dispatch', lane: 'e3', workerSessionId: null },      // 缺 worker ⇒ 丢弃
];
const batch = { events };

test('DE-1 「最近一次」口径：同一 lane 重派后以最后一条为准', () => {
  assert.equal(expectedWorkerSessionOf(batch, 'e1'), 'W2', '缺省 latest');
  assert.equal(expectedWorkerSessionOf(batch, 'e2'), 'W1');
  assert.equal(expectedWorkerSessionOf(batch, 'nope'), null, '从未派发 ⇒ null');
});

test('DE-2 「首个命中」口径：必须显式调用，且与 latest 结果不同', () => {
  assert.equal(expectedWorkerSessionOf(batch, 'e1', 'first'), 'W1', 'first 口径取首派');
  assert.equal(firstDispatchOfSession(batch, 'W1').lane, 'e1', 'W1 的首个派发 = e1');
  assert.equal(firstDispatchOfSession(batch, 'W2').lane, 'e1');
  assert.equal(firstDispatchOfSession(batch, 'W3'), null, '缺字段的记录不计入');
  // 两种口径在「重派」场景下必须给出不同答案 —— 这正是不许混用的原因
  assert.notEqual(expectedWorkerSessionOf(batch, 'e1'), firstDispatchOfSession(batch, 'W1').workerSessionId);
});

test('DE-3 lane 集合：按首次出现序去重', () => {
  assert.deepEqual(workerLanesOf(batch, 'W1'), ['e1', 'e2']);
  assert.deepEqual(workerLanesOf(batch, 'W2'), ['e1']);
  assert.deepEqual(workerLanesOf(batch, 'nobody'), []);
  assert.deepEqual(workerLanesOf(batch, null), [], '非法 sessionId ⇒ 空集（不抛）');
});

test('DE-4 过滤面：缺 lane / 缺 workerSessionId / 非 dispatch 事件一律不进记录集', () => {
  const recs = dispatchRecordsOf(events);
  assert.equal(recs.length, 3, '三条合法派发');
  assert.deepEqual(recs.map((r) => r.lane), ['e1', 'e2', 'e1'], '保持事件序');
  assert.deepEqual(dispatchRecordsOf(null), []);
  assert.deepEqual(dispatchRecordsOf({}), []);
});

test('DE-5 绑定层用「最近」：重派前的旧 worker 冒名该 lane ⇒ 拒；重派后的新 worker ⇒ 放行', () => {
  // W1 曾是 e1 的 worker（也接过 e2）⇒ 但它已不是 e1 的当前归属
  const stale = dispatchBindingDecision({ batch, lane: 'e1', caller: 'W1', where: 'de-5' });
  assert.equal(stale.ok, false, '旧 worker 对已重派的 lane 不得再写');
  assert.match(String(stale.reason), /binding-mismatch/, '拒因口径不变');
  const fresh = dispatchBindingDecision({ batch, lane: 'e1', caller: 'W2', where: 'de-5' });
  assert.equal(fresh.ok, true, '当前归属者放行');
  const outsider = dispatchBindingDecision({ batch, lane: 'e1', caller: 'W-other', where: 'de-5' });
  assert.equal(outsider.ok, true, '与本批无派的会话按治理面处理（既有语义，未改）');
});
