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

// test/types-guards.test.js —— `isStringArray` 谓词的**真假两路**用例
// （批 `punky-type-assert-purge-20261103` · lane `impl`）
//
// 为什么要用例：这个谓词是为了**取代 6 处 `as string[]` 断言**而引入的。
//   断言被删掉后，「元素类型由运行时检查真实保证」这句话就**只能靠用例兑现** ——
//   没有用例，删断言 = 把类型安全从「声明的」变成「假定的」。
import test from 'node:test';
import assert from 'node:assert/strict';

import { isStringArray } from '../lib/types/guards.js';

// ── 真路：确实该判 true 的形态 ────────────────────────────────────────────────────────────
test('G-1 真路：字符串数组（含空数组）⇒ true', () => {
  assert.equal(isStringArray([]), true, '空数组天然满足（空集）');
  assert.equal(isStringArray(['a']), true);
  assert.equal(isStringArray(['a', '', ' b ']), true, '空串/带空格仍是 string ⇒ true（不做 trim 判定）');
});

// ── 假路：各类非 string[] 形态 ────────────────────────────────────────────────────────────
test('G-2 假路：非数组 / 含非字符串元素 / 类数组 ⇒ false', () => {
  assert.equal(isStringArray(null), false);
  assert.equal(isStringArray(undefined), false);
  assert.equal(isStringArray('abc'), false, '字符串本身不是数组（易踩：string 有 length）');
  assert.equal(isStringArray({ 0: 'a', length: 1 }), false, '类数组对象不是数组');
  assert.equal(isStringArray(['a', 1]), false, '含数字 ⇒ false');
  assert.equal(isStringArray(['a', null]), false);
  assert.equal(isStringArray([undefined]), false);
  assert.equal(isStringArray([['a']]), false, '嵌套数组元素不是 string');
  assert.equal(isStringArray([new String('a')]), false, 'String 包装对象不是原始 string');
  assert.equal(isStringArray(new Set(['a'])), false, 'Set 不是 Array');
});

// ── 窄化契约：判 true 后元素可直接按 string 用（这是它替代断言的根据）──────────────────────
test('G-3 窄化契约：true ⇒ 元素可安全当作 string（trim/拼接不炸）', () => {
  const x = ['a ', ' b'];
  assert.equal(isStringArray(x), true);
  if (isStringArray(x)) {
    assert.equal(x.map((s) => s.trim()).join('|'), 'a|b', 'true 分支内元素必须是 string');
  }
});
