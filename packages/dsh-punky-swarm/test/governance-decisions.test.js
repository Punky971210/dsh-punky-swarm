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

// U1 内核单测：6 原语枚举完备 / isGovernancePrimitive 边界 / primitiveToPreDecision 映射 / primitiveLabel 中文标签。
// 蓝图：m2-detailed.md §9.1 U1；build-plan §1.2 U1（4 条）。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOVERNANCE_PRIMITIVES,
  isGovernancePrimitive,
  primitiveToPreDecision,
  primitiveLabel,
} from '../lib/governance/decisions.js';

// U1-1 枚举完备：长度 6 且集合 == 六原语（对照 hf.md:76-77）
test('U1-1 GOVERNANCE_PRIMITIVES enumerates exactly the six primitives', () => {
  assert.equal(GOVERNANCE_PRIMITIVES.length, 6);
  const set = new Set(GOVERNANCE_PRIMITIVES);
  assert.deepEqual(
    [...set].sort(),
    ['ALLOW', 'DEFER', 'DENY', 'NARROW', 'PAUSE', 'REQUIRE_APPROVAL'].sort(),
  );
  assert.equal(set.size, 6, 'no duplicates');
});

// U1-2 isGovernancePrimitive 边界：大小写敏感；非法/undefined → false
test('U1-2 isGovernancePrimitive guards exactly the canonical spellings', () => {
  assert.equal(isGovernancePrimitive('ALLOW'), true);
  assert.equal(isGovernancePrimitive('allow'), false);   // 大小写敏感
  assert.equal(isGovernancePrimitive('FOO'), false);
  assert.equal(isGovernancePrimitive(undefined), false);
  assert.equal(isGovernancePrimitive(null), false);
  assert.equal(isGovernancePrimitive(42), false);
});

// U1-3 primitiveToPreDecision 映射：
//   DENY/DEFER/NARROW/PAUSE → {kind:'deny', reason 非空}；REQUIRE_APPROVAL → {kind:'ask', reason}；ALLOW → 'pass'
test('U1-3 primitiveToPreDecision maps per blueprint §3', () => {
  for (const p of ['DENY', 'DEFER', 'NARROW', 'PAUSE']) {
    const d = primitiveToPreDecision(p);
    assert.equal(d.kind, 'deny');
    assert.ok(d.reason.length > 0, `${p} deny reason non-empty`);
  }
  const ask = primitiveToPreDecision('REQUIRE_APPROVAL');
  assert.equal(ask.kind, 'ask');
  assert.ok(ask.reason.length > 0, 'ask reason non-empty');
  assert.equal(primitiveToPreDecision('ALLOW'), 'pass');
});

// U1-4 primitiveLabel：六原语中文标签非空且互不相同（与 decisions.ts 建议文案一致）
test('U1-4 primitiveLabel returns distinct non-empty Chinese labels', () => {
  const expected = {
    ALLOW: '放行',
    DENY: '拒绝',
    REQUIRE_APPROVAL: '需审批',
    DEFER: '延后',
    NARROW: '收窄',
    PAUSE: '暂停',
  };
  const seen = new Set();
  for (const p of GOVERNANCE_PRIMITIVES) {
    const label = primitiveLabel(p);
    assert.ok(typeof label === 'string' && label.length > 0, `${p} label non-empty`);
    assert.equal(label, expected[p], `${p} label matches canonical text`);
    assert.ok(!seen.has(label), `${label} unique`);
    seen.add(label);
  }
});
