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

// U4 内核单测：组合序全链路——空规则恒 ALLOW / 规则命中全链路 / tools 白名单 / 多规则 ruleRefs / op 全语义 / path 缺省 / 收据构造。
// 蓝图：m2-detailed.md §9.1 U4；build-plan §1.2 U4（8 条）。
// P0 扩展（harden-plan §6 P0 组 K-N×4）：NARROW 运行期接线——narrowable+flag.on→NARROW+narrowedParams；
//   flag.off→DENY 回退（narrowedParams 按契约填充）；未知 path bounds 跳过不抛错；hard+narrowable→DENY（P2 优先）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGovernanceKernel, createRefusalReceipt } from '../lib/governance/kernel.js';

const DEFAULT_FLAGS = { pause: false, narrow: false, defer: false };

const baseConfig = (rules, flags = DEFAULT_FLAGS) => ({
  enabled: true,
  rules,
  defaults: { deny: 'DENY' },
  flags,
});

const hardViolation = (code, message) => ({ code, category: 'hard', message });

// U4-1 空规则表恒 ALLOW
test('U4-1 empty rules always ALLOW', () => {
  const kernel = createGovernanceKernel(baseConfig([]));
  const d = kernel.decide({ name: 'bash', arguments: { cmd: 'rm -rf /' } });
  assert.deepEqual(d, { primitive: 'ALLOW', priority: -1, reason: '', ruleRefs: [] });
});

// U4-2 规则命中全链路：regex 匹配 /cmd → hard 违规 → DENY priority 2 ruleRefs==['R001']
test('U4-2 rule match end-to-end yields DENY with ruleRefs', () => {
  const kernel = createGovernanceKernel(baseConfig([{
    id: 'R001',
    tools: ['bash'],
    match: { path: '/cmd', op: 'regex', pattern: 'rm -rf' },
    violations: [hardViolation('V001', 'rm -rf 危险命令')],
  }]));
  const d = kernel.decide({ name: 'bash', arguments: { cmd: 'rm -rf /' } });
  assert.equal(d.primitive, 'DENY');
  assert.equal(d.priority, 2);
  assert.deepEqual(d.ruleRefs, ['R001']);
  assert.ok(d.reason.length > 0);
});

// U4-3 tools 白名单：bash 命中 DENY；node 同名参数 → ALLOW
test('U4-3 tools whitelist restricts rule to listed tools', () => {
  const kernel = createGovernanceKernel(baseConfig([{
    id: 'R003',
    tools: ['bash'],
    match: { path: '/cmd', op: 'regex', pattern: 'rm -rf' },
    violations: [hardViolation('V003', 'danger')],
  }]));
  assert.equal(kernel.decide({ name: 'bash', arguments: { cmd: 'rm -rf /' } }).primitive, 'DENY');
  assert.equal(kernel.decide({ name: 'node', arguments: { cmd: 'rm -rf /' } }).primitive, 'ALLOW');
});

// U4-4 tools 缺省=全工具：任意工具名命中
test('U4-4 missing tools matches any tool', () => {
  const kernel = createGovernanceKernel(baseConfig([{
    id: 'R004',
    match: { path: '/cmd', op: 'regex', pattern: 'rm -rf' },
    violations: [hardViolation('V004', 'danger')],
  }]));
  assert.equal(kernel.decide({ name: 'bash', arguments: { cmd: 'rm -rf /' } }).primitive, 'DENY');
  assert.equal(kernel.decide({ name: 'node', arguments: { cmd: 'rm -rf /' } }).primitive, 'DENY');
});

// U4-5 多规则命中 ruleRefs 收集（去重/保序以实现为准，断言集合）
test('U4-5 multiple matching rules collect all ruleRefs', () => {
  const kernel = createGovernanceKernel(baseConfig([
    {
      id: 'RA',
      match: { path: '/cmd', op: 'regex', pattern: 'rm' },
      violations: [hardViolation('VA', 'a')],
    },
    {
      id: 'RB',
      match: { path: '/cmd', op: 'regex', pattern: 'rm -rf' },
      violations: [hardViolation('VB', 'b')],
    },
  ]));
  const d = kernel.decide({ name: 'bash', arguments: { cmd: 'rm -rf /' } });
  assert.deepEqual([...d.ruleRefs].sort(), ['RA', 'RB']);
  assert.equal(d.primitive, 'DENY');
});

// U4-6 op 语义全覆盖：eq/gt/gte/lt/lte/in/regex 各一例命中/不命中（含 path 缺省 eq 例在 U4-7）
test('U4-6 every op semantic hits and misses correctly', () => {
  const mk = (match) => createGovernanceKernel(baseConfig([{
    id: 'R-op', match, violations: [hardViolation('V-op', 'op')],
  }]));

  // eq
  let k = mk({ path: '/cmd', op: 'eq', value: 'abc' });
  assert.equal(k.decide({ name: 'bash', arguments: { cmd: 'abc' } }).primitive, 'DENY');
  assert.equal(k.decide({ name: 'bash', arguments: { cmd: 'xyz' } }).primitive, 'ALLOW');

  // gt
  k = mk({ path: '/n', op: 'gt', value: 5 });
  assert.equal(k.decide({ name: 'bash', arguments: { n: 10 } }).primitive, 'DENY');
  assert.equal(k.decide({ name: 'bash', arguments: { n: 3 } }).primitive, 'ALLOW');

  // gte
  k = mk({ path: '/n', op: 'gte', value: 5 });
  assert.equal(k.decide({ name: 'bash', arguments: { n: 5 } }).primitive, 'DENY');
  assert.equal(k.decide({ name: 'bash', arguments: { n: 4 } }).primitive, 'ALLOW');

  // lt
  k = mk({ path: '/n', op: 'lt', value: 5 });
  assert.equal(k.decide({ name: 'bash', arguments: { n: 3 } }).primitive, 'DENY');
  assert.equal(k.decide({ name: 'bash', arguments: { n: 7 } }).primitive, 'ALLOW');

  // lte
  k = mk({ path: '/n', op: 'lte', value: 5 });
  assert.equal(k.decide({ name: 'bash', arguments: { n: 5 } }).primitive, 'DENY');
  assert.equal(k.decide({ name: 'bash', arguments: { n: 6 } }).primitive, 'ALLOW');

  // in
  k = mk({ path: '/color', op: 'in', value: ['red', 'blue'] });
  assert.equal(k.decide({ name: 'bash', arguments: { color: 'red' } }).primitive, 'DENY');
  assert.equal(k.decide({ name: 'bash', arguments: { color: 'green' } }).primitive, 'ALLOW');

  // regex
  k = mk({ path: '/cmd', op: 'regex', pattern: '^rm ' });
  assert.equal(k.decide({ name: 'bash', arguments: { cmd: 'rm -rf' } }).primitive, 'DENY');
  assert.equal(k.decide({ name: 'bash', arguments: { cmd: 'ls -la' } }).primitive, 'ALLOW');
});

// U4-7 path 缺省：无 match.path → op:'eq' 对整个 arguments 求值
test('U4-7 missing match.path evaluates eq against whole arguments', () => {
  const kernel = createGovernanceKernel(baseConfig([{
    id: 'R007',
    match: { op: 'eq', value: { cmd: 'abc' } },
    violations: [hardViolation('V007', 'whole-args eq')],
  }]));
  assert.equal(kernel.decide({ name: 'bash', arguments: { cmd: 'abc' } }).primitive, 'DENY');
  assert.equal(kernel.decide({ name: 'bash', arguments: { cmd: 'xyz' } }).primitive, 'ALLOW');
});

// U4-8 createRefusalReceipt：receiptId 非空、ts 为 ISO、attemptedParams 深拷贝
test('U4-8 createRefusalReceipt builds receipt with deep-copied params', () => {
  const decision = { primitive: 'DENY', priority: 2, reason: 'rm -rf 危险命令', ruleRefs: ['R001'] };
  const attemptedParams = { cmd: 'rm -rf /' };
  const receipt = createRefusalReceipt({
    tool: 'bash',
    callId: 'call-1',
    sessionId: 'sess-1',
    decision,
    attemptedParams,
  });

  assert.ok(typeof receipt.receiptId === 'string' && receipt.receiptId.length > 0, 'receiptId non-empty');
  assert.ok(!Number.isNaN(Date.parse(receipt.ts)), 'ts parses as ISO date');
  assert.match(receipt.ts, /^\d{4}-\d{2}-\d{2}T/, 'ts ISO 8601');
  assert.equal(receipt.tool, 'bash');
  assert.equal(receipt.callId, 'call-1');
  assert.equal(receipt.sessionId, 'sess-1');
  assert.deepEqual(receipt.decision, { primitive: 'DENY', priority: 2, reason: 'rm -rf 危险命令' });
  assert.deepEqual(receipt.ruleRefs, ['R001']);
  assert.deepEqual(receipt.attemptedParams, { cmd: 'rm -rf /' });

  // attemptedParams 深拷贝：改收据不影响原对象
  receipt.attemptedParams.cmd = 'changed';
  assert.equal(attemptedParams.cmd, 'rm -rf /', 'input untouched by receipt mutation');
});

// ── P0 组 K-N（harden-plan §6）：NARROW 运行期接线 ──

// narrowable 规则（A2 显式 narrow bounds：/timeout max=100）
const narrowRule = (over = {}) => ({
  id: 'RN01',
  tools: ['bash'],
  match: { path: '/timeout', op: 'gt', value: 100 },
  violations: [{ code: 'VN01', category: 'narrowable', message: '超时参数需收窄' }],
  narrow: [{ path: '/timeout', max: 100 }],
  ...over,
});

// K-N1 narrowable + flag.narrow=true → primitive NARROW + narrowedParams 填充（钳制后参数 + clamped 明细）
test('K-N1 narrowable with narrow flag on → NARROW with narrowedParams', () => {
  const kernel = createGovernanceKernel(baseConfig([narrowRule()], { pause: false, narrow: true, defer: false }));
  const d = kernel.decide({ name: 'bash', arguments: { timeout: 150 } });
  assert.equal(d.primitive, 'NARROW');
  assert.equal(d.priority, 4);
  assert.ok(d.narrowedParams, 'narrowedParams present');
  assert.equal(d.narrowedParams.narrowed.timeout, 100, 'clamped to max');
  assert.deepEqual(d.narrowedParams.clamped, [{ path: '/timeout', from: 150, to: 100 }]);
  assert.equal(d.narrowedParams.changed, true);
});

// K-N2 flag.narrow=false → DENY 回退，且 narrowedParams 按契约填充（P4 flag-off 回退亦携带钳制指引，修正依据）
test('K-N2 narrowable with narrow flag off → DENY fallback with narrowedParams (contract: filled)', () => {
  const kernel = createGovernanceKernel(baseConfig([narrowRule()], DEFAULT_FLAGS));
  const d = kernel.decide({ name: 'bash', arguments: { timeout: 150 } });
  assert.equal(d.primitive, 'DENY');
  assert.equal(d.priority, 4);
  assert.ok(d.narrowedParams, 'DENY fallback still carries narrowedParams (修正依据)');
  assert.equal(d.narrowedParams.narrowed.timeout, 100);
  assert.equal(d.narrowedParams.changed, true);
});

// K-N3 未知 path bounds 跳过不抛错：narrow path 不存在 → narrowedParams 仍返回（changed=false, clamped=[]）
test('K-N3 unknown-path bounds are skipped without throwing', () => {
  const kernel = createGovernanceKernel(
    baseConfig([narrowRule({ narrow: [{ path: '/nope', max: 1 }] })], { pause: false, narrow: true, defer: false }),
  );
  const d = kernel.decide({ name: 'bash', arguments: { timeout: 150 } });
  assert.equal(d.primitive, 'NARROW');
  assert.ok(d.narrowedParams, 'narrowedParams present even when bound path unknown');
  assert.equal(d.narrowedParams.changed, false, 'no clamp happened');
  assert.deepEqual(d.narrowedParams.clamped, []);
  assert.deepEqual(d.narrowedParams.narrowed, { timeout: 150 }, 'input unchanged (deep copy)');
});

// K-N4 hard + narrowable 多违规 → DENY（P2 优先），且 narrowedParams 按契约填充（窄域指引仍作修正依据）
test('K-N4 hard+narrowable multi-violation → DENY (P2 first) with narrowedParams filled', () => {
  const rule = {
    id: 'RN04',
    tools: ['bash'],
    match: { path: '/cmd', op: 'regex', pattern: 'rm -rf' },
    violations: [
      { code: 'VH', category: 'hard', message: '禁止删除命令' },
      { code: 'VN', category: 'narrowable', message: '超时参数可收窄' },
    ],
    narrow: [{ path: '/timeout', max: 100 }],
  };
  const kernel = createGovernanceKernel(baseConfig([rule], { pause: false, narrow: true, defer: false }));
  const d = kernel.decide({ name: 'bash', arguments: { cmd: 'rm -rf /', timeout: 150 } });
  assert.equal(d.primitive, 'DENY', 'hard (P2) outranks narrowable (P4)');
  assert.equal(d.priority, 2);
  assert.ok(d.narrowedParams, 'narrowedParams filled on multi-violation DENY (修正依据)');
  assert.equal(d.narrowedParams.narrowed.timeout, 100, 'narrowable clamp still computed');
  assert.equal(d.narrowedParams.changed, true);
});
