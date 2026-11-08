/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/error-family-routing.test.js —— **I-13 行为面**（`grep -c` 型 T-cmd 是弱判据 ⇒ 本文件承接充分性）。
//
// 判据源：`plan/p1-pack.md` I-13 ＋ `e2-errorfamily` handoff 断言基线。
// 纪律：**不断言动作字符串的具体取值**（词表未冻结）——只断「同族相同 / 异族不同」这类**关系**。
//
// 可红形态：
//   E1 若 `repairActionOf` 按 **code** 映射（而非按族）⇒ 同族两 code 动作不同 ⇒ E1 红；
//   E2 若所有族返回同一动作 ⇒ 两对异族断言红；
//   E3 若未映射族返回 null/默认值（而非抛）⇒ E3 红。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  repairActionOf, classifyDenial, ERROR_FAMILY_UNMAPPED,
} from '../lib/governance/denial.js';

test('E1 同族同动作：approval 的两个 code ⇒ 动作 **deepEqual 相同**，且都等于 repairActionOf(approval)', () => {
  const a1 = classifyDenial({ errorFamily: 'approval', errorCode: 'approval-needed' });
  const a2 = classifyDenial({ errorFamily: 'approval', errorCode: 'approval-args-mismatch' });
  assert.deepEqual(a1.action, a2.action,
    '同族不同 code 必须同动作（若按 code 映射 ⇒ 此处必红）；实际 ' + JSON.stringify([a1.action, a2.action]));
  const familyAction = repairActionOf('approval');
  assert.deepEqual(a1.action, familyAction, 'classifyDenial 的动作必须来自该族单点 repairActionOf');
  assert.deepEqual(a2.action, familyAction);
  // 族/码原样回传（分级按根因，不按消息文本）
  assert.equal(a1.errorFamily, 'approval'); assert.equal(a1.errorCode, 'approval-needed');
});

test('E2 异族不同动作（两对，防「恒定单值」也防「只有一对碰巧不同」）', () => {
  const allow = repairActionOf('allowlist');
  const approval = repairActionOf('approval');
  assert.notDeepEqual(allow, approval, 'allowlist 与 approval 的动作必须不同；实际=' + JSON.stringify([allow, approval]));
  const tier = repairActionOf('tier');
  const mode = repairActionOf('mode');
  assert.notDeepEqual(tier, mode, 'tier 与 mode 的动作必须不同；实际=' + JSON.stringify([tier, mode]));
});

test('E3 未映射必抛（禁写成返回 null）：未知族 / 缺 errorCode', () => {
  assert.throws(() => repairActionOf('nope'), new RegExp(ERROR_FAMILY_UNMAPPED),
    '未知族必须抛 ' + ERROR_FAMILY_UNMAPPED + ' 前缀（不得静默归类/返回 null）');
  assert.throws(() => classifyDenial({ errorFamily: 'approval' }), new RegExp(ERROR_FAMILY_UNMAPPED),
    '缺 errorCode 亦必须抛（不得猜）');
});

test('E4 四族都能映射（存在性，断言「非空」而非长度）：tier/mode/allowlist/approval', () => {
  for (const fam of ['tier', 'mode', 'allowlist', 'approval']) {
    const action = repairActionOf(fam);
    assert.equal(typeof action, 'string', fam + ' 族必须给出字符串动作');
    assert.equal(action.length > 0, true, fam + ' 族动作不得为空串');
  }
});
