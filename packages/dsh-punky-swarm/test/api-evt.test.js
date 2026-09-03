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

// api.js:86 读端字面量收敛回归（契约 §3.2 exec-panel-a 验收③：grep 复核——无裸字面量）
// 源码面断言：api.js 事件读端不得出现裸 'member.settled' 字面量，必须引用 lib/state/event-types.js 的 EVT 常量
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const apiSrc = fs.readFileSync(new URL('../lib/api.js', import.meta.url), 'utf8');

test('api.js:86 收敛：无裸 member.settled 字面量 + EVT 常量引用 + 常量源 import', () => {
  // 裸字面量断言（允许出现在注释/说明文字，但事件比较处不得有字符串字面量比较）
  const bareComparisons = apiSrc.match(/e\.type\s*===\s*'[^']+'/g) ?? [];
  assert.deepEqual(bareComparisons, [], '事件读端无裸字面量比较（实际: ' + JSON.stringify(bareComparisons) + '）');
  // EVT 常量引用
  assert.ok(apiSrc.includes('EVT.EVT_MEMBER_SETTLED'), 'api.js 引用 EVT.EVT_MEMBER_SETTLED');
  assert.ok(apiSrc.includes("from './state/event-types.js'"), '常量源 import 存在');
  // 常量源定义一致性（事实源 = store.js 域常量）
  const evtSrc = fs.readFileSync(new URL('../lib/state/event-types.js', import.meta.url), 'utf8');
  assert.ok(evtSrc.includes("export const EVT_MEMBER_SETTLED = 'member.settled';"), 'event-types.js 定义 member.settled 常量');
});
