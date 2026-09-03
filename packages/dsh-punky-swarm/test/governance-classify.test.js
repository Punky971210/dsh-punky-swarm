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

// U2 内核单测：分类器六分路 P0-P6 逐档 + 多违规取最高 + fail-closed。
// 蓝图：m2-detailed.md §9.1 U2；build-plan §1.2 U2（12 条）。
// P0 扩展（harden-plan §6 P0 组 K-D×3）：defaults.deny 死配置修复——兜底读配置真实生效（REQUIRE_APPROVAL）、
//   默认 DENY 回归、ALLOW 双保险回退 DENY（classify 防御；resolve 校验见 governance-config.test.js I2 扩展）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyViolation } from '../lib/governance/classify.js';

const FLAGS_OFF = { pause: false, narrow: false, defer: false };
const FLAGS_ON = { pause: true, narrow: true, defer: true };

const v = (category, message = 'msg') => ({ code: `C-${category}`, category, message });

// U2-1 P0：ftra → REQUIRE_APPROVAL（priority 0）
test('U2-1 P0 ftra → REQUIRE_APPROVAL', () => {
  const d = classifyViolation({ tool: 'bash', params: {}, violations: [v('ftra')], flags: FLAGS_OFF });
  assert.equal(d.primitive, 'REQUIRE_APPROVAL');
  assert.equal(d.priority, 0);
});

// U2-2 P1：manual_review（无 hard）→ REQUIRE_APPROVAL（priority 1）
test('U2-2 P1 manual_review → REQUIRE_APPROVAL', () => {
  const d = classifyViolation({ tool: 'bash', params: {}, violations: [v('manual_review')], flags: FLAGS_OFF });
  assert.equal(d.primitive, 'REQUIRE_APPROVAL');
  assert.equal(d.priority, 1);
});

// U2-3 P2：hard → DENY（priority 2）
test('U2-3 P2 hard → DENY', () => {
  const d = classifyViolation({ tool: 'bash', params: {}, violations: [v('hard')], flags: FLAGS_OFF });
  assert.equal(d.primitive, 'DENY');
  assert.equal(d.priority, 2);
});

// U2-4 P3 flag off：pausable + flags.pause=false → DENY（回退）
test('U2-4 P3 pausable with flag off falls back to DENY', () => {
  const d = classifyViolation({ tool: 'bash', params: {}, violations: [v('pausable')], flags: FLAGS_OFF });
  assert.equal(d.primitive, 'DENY');
});

// U2-5 P3 flag on：pausable + flags.pause=true → PAUSE
test('U2-5 P3 pausable with flag on → PAUSE', () => {
  const d = classifyViolation({ tool: 'bash', params: {}, violations: [v('pausable')], flags: FLAGS_ON });
  assert.equal(d.primitive, 'PAUSE');
});

// U2-6 P4 flag off：narrowable + flags.narrow=false → DENY（回退，含 narrowedParams 指引语义）
test('U2-6 P4 narrowable with flag off falls back to DENY', () => {
  const d = classifyViolation({ tool: 'bash', params: {}, violations: [v('narrowable')], flags: FLAGS_OFF });
  assert.equal(d.primitive, 'DENY');
  assert.ok(d.reason.length > 0);
});

// U2-7 P4 flag on：narrowable + flags.narrow=true → NARROW
test('U2-7 P4 narrowable with flag on → NARROW', () => {
  const d = classifyViolation({ tool: 'bash', params: {}, violations: [v('narrowable')], flags: FLAGS_ON });
  assert.equal(d.primitive, 'NARROW');
});

// U2-8 P5 flag off：soft + confidence=0.5 + flags.defer=false → DENY（默认回退）
test('U2-8 P5 soft below threshold with defer off → DENY', () => {
  const d = classifyViolation({ tool: 'bash', params: {}, violations: [v('soft')], confidence: 0.5, flags: FLAGS_OFF });
  assert.equal(d.primitive, 'DENY');
});

// U2-9 P5 flag on：soft + confidence=0.5 + flags.defer=true → DEFER
test('U2-9 P5 soft below threshold with defer on → DEFER', () => {
  const d = classifyViolation({ tool: 'bash', params: {}, violations: [v('soft')], confidence: 0.5, flags: FLAGS_ON });
  assert.equal(d.primitive, 'DEFER');
});

// U2-10 P6：soft + confidence=0.80 → REQUIRE_APPROVAL（≥0.70 阈值）
test('U2-10 P6 soft at/above 0.70 → REQUIRE_APPROVAL', () => {
  const d = classifyViolation({ tool: 'bash', params: {}, violations: [v('soft')], confidence: 0.8, flags: FLAGS_OFF });
  assert.equal(d.primitive, 'REQUIRE_APPROVAL');
  assert.equal(d.priority, 6);
});

// U2-11 边界与多违规取最高：
//   [soft, 0.70] → REQUIRE_APPROVAL（=0.70 属 P6）；[soft, 0.69, defer=false] → DENY；
//   [manual_review, hard] → DENY（P2 优先于 P1）；[soft 0.8, hard] → DENY（P2 最高）
test('U2-11 boundary confidence and multi-violation take highest priority', () => {
  const at70 = classifyViolation({ tool: 'bash', params: {}, violations: [v('soft')], confidence: 0.7, flags: FLAGS_OFF });
  assert.equal(at70.primitive, 'REQUIRE_APPROVAL', '0.70 counts as P6');

  const below69 = classifyViolation({ tool: 'bash', params: {}, violations: [v('soft')], confidence: 0.69, flags: FLAGS_OFF });
  assert.equal(below69.primitive, 'DENY', '0.69 with defer off falls back to DENY');

  const hardBeatsManual = classifyViolation({
    tool: 'bash', params: {}, violations: [v('manual_review'), v('hard')], flags: FLAGS_OFF,
  });
  assert.equal(hardBeatsManual.primitive, 'DENY', 'hard (P2) outranks manual_review (P1)');

  const hardBeatsSoft = classifyViolation({
    tool: 'bash', params: {}, violations: [v('soft'), v('hard')], confidence: 0.8, flags: FLAGS_OFF,
  });
  assert.equal(hardBeatsSoft.primitive, 'DENY', 'hard (P2) outranks soft (P6)');
});

// U2-12 fail-closed：[unknown] → DENY；confidence 缺省（undefined 按 0）→ soft → 默认 flag off → DENY
test('U2-12 unknown category and missing confidence fail closed to DENY', () => {
  const unknown = classifyViolation({ tool: 'bash', params: {}, violations: [v('unknown')], flags: FLAGS_OFF });
  assert.equal(unknown.primitive, 'DENY', 'unknown → DENY (fail-closed)');

  const noConfidence = classifyViolation({ tool: 'bash', params: {}, violations: [v('soft')], flags: FLAGS_OFF });
  assert.equal(noConfidence.primitive, 'DENY', 'undefined confidence treated as 0 → defer off → DENY');

  const emptyFlags = classifyViolation({ tool: 'bash', params: {}, violations: [v('soft')], confidence: 0.5, flags: {} });
  assert.equal(emptyFlags.primitive, 'DENY', 'missing flag fields behave as false');
});

// ── P0 组 K-D（harden-plan §6）：defaults.deny 死配置修复（兜底读配置真实生效）──

// K-D1 defaults.deny=REQUIRE_APPROVAL + unknown 违规 → 兜底 REQUIRE_APPROVAL（配置真实生效，不再硬编码 DENY）
test('K-D1 defaults.deny=REQUIRE_APPROVAL → unknown falls back to REQUIRE_APPROVAL', () => {
  const d = classifyViolation({
    tool: 'bash', params: {}, violations: [v('unknown')], flags: FLAGS_OFF,
    defaults: { deny: 'REQUIRE_APPROVAL' },
  });
  assert.equal(d.primitive, 'REQUIRE_APPROVAL', 'fallback reads configured primitive');
  assert.equal(d.priority, 7, 'FALLBACK_PRIORITY unchanged');
  assert.ok(d.reason.startsWith('[fail-closed]'), '[fail-closed] prefix kept');
});

// K-D2 默认 DENY 回归：defaults 缺省 / defaults.deny=DENY → 兜底仍 DENY（fail-closed 回归不变）
test('K-D2 default (missing / DENY) fallback stays DENY', () => {
  const missing = classifyViolation({ tool: 'bash', params: {}, violations: [v('unknown')], flags: FLAGS_OFF });
  assert.equal(missing.primitive, 'DENY', 'defaults missing → DENY (回归)');
  const explicit = classifyViolation({
    tool: 'bash', params: {}, violations: [v('unknown')], flags: FLAGS_OFF, defaults: { deny: 'DENY' },
  });
  assert.equal(explicit.primitive, 'DENY');
});

// K-D3 defaults.deny=ALLOW → classify 双保险回退 DENY（fail-closed 纪律：兜底绝不 ALLOW；resolve 校验见 config I2）
test('K-D3 defaults.deny=ALLOW → classify guard falls back to DENY (never ALLOW)', () => {
  const d = classifyViolation({
    tool: 'bash', params: {}, violations: [v('unknown')], flags: FLAGS_OFF, defaults: { deny: 'ALLOW' },
  });
  assert.equal(d.primitive, 'DENY', 'ALLOW configured as fallback is rejected (fail-closed)');
  assert.equal(d.priority, 7);
});
