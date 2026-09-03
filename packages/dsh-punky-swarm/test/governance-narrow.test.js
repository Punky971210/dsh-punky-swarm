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

// U3 内核单测：NARROW 参数钳制——数值 max/min、enum 收敛、pattern、未知路径跳过、形状/类型不变、空 bounds 零钳制、深拷贝。
// 蓝图：m2-detailed.md §9.1 U3；build-plan §1.2 U3（8 条）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeNarrowedParams } from '../lib/governance/narrow.js';

// U3-1 数值 max 钳制
test('U3-1 numeric max clamp', () => {
  const r = computeNarrowedParams({ amount: 150 }, [{ path: '/amount', max: 100 }]);
  assert.equal(r.narrowed.amount, 100);
  assert.equal(r.changed, true);
  assert.deepEqual(r.clamped, [{ path: '/amount', from: 150, to: 100 }]);
});

// U3-2 数值 min 钳制
test('U3-2 numeric min clamp', () => {
  const r = computeNarrowedParams({ amount: 10 }, [{ path: '/amount', min: 50 }]);
  assert.equal(r.narrowed.amount, 50);
  assert.equal(r.changed, true);
  assert.deepEqual(r.clamped, [{ path: '/amount', from: 10, to: 50 }]);
});

// U3-3 enum 收敛：enum 不含当前值 → 取 enum 首值 + clamped 记录
test('U3-3 enum fallback to first legal value', () => {
  const r = computeNarrowedParams({ scope: 'admin' }, [{ path: '/scope', enum: ['read', 'write'] }]);
  assert.equal(r.narrowed.scope, 'read');
  assert.equal(r.changed, true);
  assert.deepEqual(r.clamped, [{ path: '/scope', from: 'admin', to: 'read' }]);
});

// U3-4 pattern 匹配：原值保留、changed===false
test('U3-4 pattern match keeps value unchanged', () => {
  const r = computeNarrowedParams({ name: 'abc' }, [{ path: '/name', pattern: '^[a-z]+$' }]);
  assert.equal(r.narrowed.name, 'abc');
  assert.equal(r.changed, false);
  assert.deepEqual(r.clamped, []);
});

// U3-5 pattern 不匹配：保留原值 + clamped 记录（不截断、不抛错）
test('U3-5 pattern mismatch keeps value with clamped audit record', () => {
  const r = computeNarrowedParams({ name: 'ABC' }, [{ path: '/name', pattern: '^[a-z]+$' }]);
  assert.equal(r.narrowed.name, 'ABC', 'original value preserved, not truncated');
  assert.deepEqual(r.clamped, [{ path: '/name', from: 'ABC', to: 'ABC' }], 'clamped records the attempt');
});

// U3-6 未知路径跳过：无修改、无抛错
test('U3-6 unknown path is skipped without error', () => {
  const r = computeNarrowedParams({ amount: 150 }, [{ path: '/nope', max: 1 }]);
  assert.equal(r.narrowed.amount, 150);
  assert.equal(r.changed, false);
  assert.deepEqual(r.clamped, []);
});

// U3-7 空 bounds 零钳制
test('U3-7 empty bounds clamp nothing', () => {
  const r = computeNarrowedParams({ amount: 150 }, []);
  assert.equal(r.narrowed.amount, 150);
  assert.deepEqual(r.clamped, []);
  assert.equal(r.changed, false);
});

// U3-8 形状/类型不变 + 深拷贝：嵌套 path 钳制后形状不变、数值类型不变、返回值修改不影响输入
test('U3-8 nested clamp keeps shape/types and deep-copies', () => {
  const input = { a: { b: 150 } };
  const r = computeNarrowedParams(input, [{ path: '/a/b', max: 100 }]);
  assert.equal(r.narrowed.a.b, 100);
  assert.equal(typeof r.narrowed.a.b, 'number', 'value stays numeric');
  assert.deepEqual(Object.keys(r.narrowed.a), ['b'], 'shape unchanged');
  assert.equal(r.changed, true);

  // 深拷贝：修改返回值不影响输入
  r.narrowed.a.b = 999;
  assert.equal(input.a.b, 150, 'input untouched by returned mutation');
  assert.equal(r.narrowed.a.b, 999);
});
