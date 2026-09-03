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

// P1-7 棘轮形式化 + P1-4 lane 条件 —— machine.js / machine-rules.js 纯逻辑单测
import test from 'node:test';
import assert from 'node:assert/strict';
import * as schema from '../lib/schema.js';
import { DEFAULT_MEMBER_RULES, DEFAULT_BATCH_RULES, loadRules } from '../lib/state/machine-rules.js';
import { RATCHET_RULES, applyMemberTransition, applyBatchTransition, checkDispatchCondition } from '../lib/state/machine.js';

const MEMBER = schema.MEMBER_TRANSITIONS;
const BATCH = schema.BATCH_TRANSITIONS;

// ---- R1 默认 = 现行约束（单一事实源：machine-rules 引用 schema 常量，不拷贝）----
test('loadRules default: same-reference as schema constants (single source of truth)', () => {
  const d = loadRules();
  assert.equal(d.memberRules, MEMBER);
  assert.equal(d.batchRules, BATCH);
  assert.equal(d.source, 'default');
  const d2 = loadRules({});
  assert.equal(d2.memberRules, MEMBER);
  assert.equal(d2.batchRules, BATCH);
  assert.equal(RATCHET_RULES, MEMBER); // machine 缺省 = 默认（同引用）
  assert.equal(DEFAULT_MEMBER_RULES, MEMBER);
  assert.equal(DEFAULT_BATCH_RULES, BATCH);
});

test('applyMemberTransition default matches schema.canTransitionMember', () => {
  const cases = [
    ['pending', 'running', true], ['pending', 'failed', true], ['pending', 'skipped', true], ['pending', 'merged', false],
    ['running', 'review', true], ['running', 'skipped', true], ['running', 'merged', false],
    ['review', 'merged', true], ['review', 'conflict', true], ['review', 'running', true],
    ['idle', 'running', true], ['merged', 'running', false], ['conflict', 'merged', false],
    ['bogus', 'running', false], ['pending', 'bogus', false],
  ];
  for (const [from, to, ok] of cases) {
    const r = applyMemberTransition(from, to);
    assert.equal(r.ok, ok, from + ' -> ' + to);
    assert.equal(schema.canTransitionMember(from, to), ok);
    if (!ok) assert.equal(r.code, 'INVALID_MEMBER_TRANSITION');
  }
});

test('applyBatchTransition default matches schema.canTransitionBatch', () => {
  const cases = [
    ['planning', 'running', true], ['planning', 'aborted', true], ['planning', 'complete', false],
    ['running', 'paused', true], ['running', 'complete', true], ['running', 'aborted', true],
    ['paused', 'running', true], ['aborted', 'running', false], ['complete', 'paused', false],
  ];
  for (const [from, to, ok] of cases) {
    const r = applyBatchTransition(from, to);
    assert.equal(r.ok, ok, from + ' -> ' + to);
    assert.equal(schema.canTransitionBatch(from, to), ok);
    if (!ok) assert.equal(r.code, 'INVALID_BATCH_TRANSITION');
  }
});

// ---- R2 收紧允许（配置只许删）----
test('ratchet: removing transitions is allowed (tightening)', () => {
  const rules = loadRules({ ratchet: { memberRules: { pending: ['running'] } } }); // 删掉 pending→failed / pending→skipped
  assert.equal(rules.source, 'config');
  // 被删的迁移被拒
  assert.equal(applyMemberTransition('pending', 'skipped', { rules }).ok, false);
  assert.equal(applyMemberTransition('pending', 'failed', { rules }).ok, false);
  // 其余不受影响（未声明键继承默认表）
  assert.equal(applyMemberTransition('pending', 'running', { rules }).ok, true);
  assert.equal(applyMemberTransition('running', 'review', { rules }).ok, true);
  assert.equal(applyMemberTransition('review', 'merged', { rules }).ok, true);
});

test('ratchet: batchRules tightening works the same', () => {
  const rules = loadRules({ ratchet: { batchRules: { running: ['paused'] } } });
  assert.equal(applyBatchTransition('running', 'complete', { rules }).ok, false);
  assert.equal(applyBatchTransition('running', 'paused', { rules }).ok, true);
  assert.equal(applyBatchTransition('planning', 'running', { rules }).ok, true); // 未声明键默认
});

// ---- R3 放宽拒绝（棘轮 fail-closed；allowRelax 默认 false）----
test('ratchet: adding a transition not in defaults throws (relaxation blocked)', () => {
  assert.throws(() => loadRules({ ratchet: { memberRules: { conflict: ['merged'] } } }), /relaxing transition "conflict -> merged"/);
  assert.throws(() => loadRules({ ratchet: { batchRules: { complete: ['running'] } } }), /relaxing/);
  // 默认规则不受污染
  assert.equal(applyMemberTransition('conflict', 'merged').ok, false);
  assert.equal(schema.canTransitionMember('conflict', 'merged'), false);
});

test('ratchet: allowRelax defaults to false (explicit true required)', () => {
  // 未显式 allowRelax: true → 恒拒绝
  assert.throws(() => loadRules({ ratchet: { memberRules: { review: ['merged', 'rework'] } } }));
  assert.throws(() => loadRules({ ratchet: { memberRules: { review: ['merged', 'rework'] }, allowRelax: false } }));
  // 显式逃生门放行
  const rules = loadRules({ ratchet: { memberRules: { review: ['merged', 'rework'] }, allowRelax: true } });
  assert.equal(rules.source, 'config');
  assert.equal(applyMemberTransition('review', 'rework', { rules }).ok, true);
});

test('ratchet: structural validation fail-closed', () => {
  assert.throws(() => loadRules({ ratchet: { memberRules: 'pending' } }), /must be an object/);
  assert.throws(() => loadRules({ ratchet: { memberRules: { nope: ['running'] } } }), /unknown state "nope"/);
  assert.throws(() => loadRules({ ratchet: { memberRules: { pending: 'running' } } }), /array of non-empty strings/);
  assert.throws(() => loadRules({ ratchet: { memberRules: { pending: ['running', 'running'] } } }), /duplicate targets/);
  assert.throws(() => loadRules({ ratchet: { memberRules: { pending: [42] } } }), /array of non-empty strings/);
  // allowRelax 逃生门仍保持结构校验（未知状态不可新增）
  assert.throws(() => loadRules({ ratchet: { memberRules: { nope: ['running'] }, allowRelax: true } }), /unknown state/);
});

// ---- P1-4 checkDispatchCondition 纯逻辑（fileExists DI）----
const BATCH_WP = {
  wavePlan: [
    { wave: 1, tasks: [{ id: 'cond-lane', condition: [{ path: 'plan/spec.md', exists: true }, { path: 'exec/out.json', exists: true }] }] },
    { wave: 2, tasks: [{ id: 'no-cond' }, { id: 'str-cond', condition: [{ path: 'plan/spec.md', exists: true }] }] },
  ],
};

test('checkDispatchCondition: no condition is always ok', () => {
  const r = checkDispatchCondition('s', 'b', BATCH_WP, 'no-cond', { fileExists: () => false });
  assert.deepEqual(r, { ok: true });
});

test('checkDispatchCondition: all conditions met -> ok', () => {
  const exists = (p) => p === 'plan/spec.md' || p === 'exec/out.json';
  const r = checkDispatchCondition('s', 'b', BATCH_WP, 'cond-lane', { fileExists: exists });
  assert.deepEqual(r, { ok: true });
});

test('checkDispatchCondition: missing file -> { ok: false, missing }', () => {
  const exists = (p) => p === 'plan/spec.md'; // exec/out.json 缺失
  const r = checkDispatchCondition('s', 'b', BATCH_WP, 'cond-lane', { fileExists: exists });
  assert.deepEqual(r, { ok: false, missing: ['exec/out.json'] });
});

test('checkDispatchCondition: unknown lane / null condition -> ok', () => {
  assert.deepEqual(checkDispatchCondition('s', 'b', BATCH_WP, 'ghost', { fileExists: () => false }), { ok: true });
  assert.deepEqual(checkDispatchCondition('s', 'b', { wavePlan: [] }, 'x', { fileExists: () => false }), { ok: true });
});

test('checkDispatchCondition: missing fileExists DI throws (pure logic guard)', () => {
  assert.throws(() => checkDispatchCondition('s', 'b', BATCH_WP, 'cond-lane', {}), /fileExists must be injected/);
});
