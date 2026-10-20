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

// shell-text 单点（DEBT-3 分段器真单点化）：`segmentCommands` 的边界与分段口径。
// 2026-10-20 补（SWEEP-FU-SEG-2）：单点化时新增「非字符串 → []」分支（旧实现会抛），
//   而该分支此前无直接单测（上一批 AC-2 因此判 PARTIAL）⇒ 本件补齐。
// 判据纪律：**每条「返回空」断言必须配同输入可非空的阳性对照**——否则「永远返回 []」
//   的实现也能让非字符串断言全绿（不可证伪）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentCommands, stripStreamMerges } from '../lib/shell-text.js';

test('S2-1 非字符串输入返回空数组（不抛）', () => {
  // 5 种非字符串形态；旧实现（text.split 直接调用）在这些输入上会抛 TypeError
  const NON_STRING = [null, undefined, 42, true, {}, ['a;b']];
  for (const v of NON_STRING) {
    assert.deepEqual(segmentCommands(v), [], `非字符串 ${Object.prototype.toString.call(v)} 应返回 []`);
  }
});

test('S2-2 阳性对照：同函数对字符串必须能返回非空 —— 证明 S2-1 的「空」有意义', () => {
  // 若 segmentCommands 被写成恒返回 []，S2-1 全绿而 S2-2 必红
  assert.deepEqual(segmentCommands('a;b'), ['a', 'b'], '分号分段应产出 2 段');
  assert.ok(segmentCommands('echo ok').length >= 1, '纯字符串应至少 1 段');
  assert.notDeepEqual(segmentCommands('a;b'), [], '字符串结果不得为空（与 S2-1 形成对照）');
});

test('S2-3 五种分隔符与换行均被切分（与单点化前正则等价）', () => {
  const CASES = [
    ['a;b', ['a', 'b']],
    ['a&&b', ['a', 'b']],
    ['a||b', ['a', 'b']],
    ['a|b', ['a', 'b']],
    ['a&b', ['a', 'b']],
    ['a\r\nb', ['a', 'b']],
    ['a\nb', ['a', 'b']],
  ];
  for (const [input, expected] of CASES) {
    assert.deepEqual(segmentCommands(input), expected, `分隔符切分：${JSON.stringify(input)}`);
  }
});

test('S2-4 空字符串与非空但无分隔符的分段形态（边界不吞段）', () => {
  assert.deepEqual(segmentCommands(''), [''], '空串按 split 语义返回单段空串');
  assert.deepEqual(segmentCommands('single'), ['single'], '无分隔符返回单段');
  // 阳性对照：加了分隔符才变成多段
  assert.equal(segmentCommands('single;two').length, 2, '有分隔符才是 2 段');
});

test('S2-5 单点未被内联复写：stripStreamMerges 仍在本模块导出且行为不变', () => {
  assert.equal(typeof stripStreamMerges, 'function', 'stripStreamMerges 应仍可导入');
  // 断言「行为性质」而非精确空白数：剥除记号 + 只余两侧内容；配无记号时原样返回的阳性对照
  const stripped = stripStreamMerges('a 2>&1 b');
  assert.ok(!stripped.includes('2>&1'), '2>&1 应被剥除');
  assert.ok(/^a\s+b$/.test(stripped), `剥除后应仅余 a 与 b 及空白（实得 ${JSON.stringify(stripped)}）`);
  assert.equal(stripStreamMerges('a b'), 'a b', '阳性对照：无流合并记号时原样返回');
});
