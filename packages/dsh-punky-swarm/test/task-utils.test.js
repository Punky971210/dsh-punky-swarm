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

// P1-04 findTask 单点测试（task-utils.js）：7 用例——
// 正常命中 / 未命中 null / wavePlan 缺省 / tasks 缺省 / batch null / tasks 含 null 跳过 / 提前返回语义。
// 消费方（gates/machine/store/lane-heartbeat/resume）行为等价性由全量回归（44 文件）兜底。
import test from 'node:test';
import assert from 'node:assert/strict';
import { findTask } from '../lib/state/task-utils.js';

test('P1-04：正常命中（多 wave 多 task，lane id 匹配返回任务对象）', () => {
  const batch = {
    wavePlan: [
      { tasks: [{ id: 'a' }, { id: 'b' }] },
      { tasks: [{ id: 'c' }, { id: 'd' }] },
    ],
  };
  const t = findTask(batch, 'c');
  assert.ok(t);
  assert.equal(t.id, 'c');
});

test('P1-04：未命中 → null', () => {
  const batch = { wavePlan: [{ tasks: [{ id: 'a' }] }] };
  assert.equal(findTask(batch, 'missing'), null);
});

test('P1-04：wavePlan 缺省（undefined）→ null 不抛', () => {
  assert.equal(findTask({}, 'a'), null);
  assert.equal(findTask({ wavePlan: undefined }, 'a'), null);
});

test('P1-04：tasks 缺省（wave 无 tasks 字段）→ 跳过该 wave，不抛', () => {
  const batch = { wavePlan: [{ tasks: [{ id: 'a' }] }, { name: 'no-tasks-wave' }, { tasks: [{ id: 'b' }] }] };
  assert.equal(findTask(batch, 'a').id, 'a');
  assert.equal(findTask(batch, 'b').id, 'b');
  assert.equal(findTask(batch, 'no-tasks-wave'), null);
});

test('P1-04：batch 为 null → null 不抛', () => {
  assert.equal(findTask(null, 'a'), null);
  assert.equal(findTask(undefined, 'a'), null);
});

test('P1-04：tasks 含 null 元素 → 跳过不抛（防御最全形态）', () => {
  const batch = { wavePlan: [{ tasks: [null, undefined, { id: 'x' }, null] }] };
  const t = findTask(batch, 'x');
  assert.ok(t);
  assert.equal(t.id, 'x');
  // 全 null 亦不抛，返回 null
  assert.equal(findTask({ wavePlan: [{ tasks: [null, null] }] }, 'x'), null);
  // 非数组 tasks（防御）跳过不抛
  assert.equal(findTask({ wavePlan: [{ tasks: 'not-an-array' }, { tasks: [{ id: 'y' }] }] }, 'y').id, 'y');
});

test('P1-04：提前返回语义（命中后不再遍历后续——首个匹配优先，后续同名/异常不触发）', () => {
  const batch = {
    wavePlan: [
      { tasks: [{ id: 'dup', marker: 'first' }] },
      // 后续 wave 同名任务即便为 null / 缺 id，也不应被触碰（提前返回证明）
      { tasks: [null, { id: 'dup', marker: 'second' }] },
    ],
  };
  const t = findTask(batch, 'dup');
  assert.ok(t);
  assert.equal(t.marker, 'first', '应返回首个 wave 的匹配任务（找到即返回）');
});
