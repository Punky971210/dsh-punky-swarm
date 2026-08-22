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

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CAPABILITY_REGISTRY,
  EXCLUSIONS,
  REQUIRED_ROLES,
  BLIND_REVIEW_ROLES,
  BLIND_REVIEW_TEMPLATE_KEYS,
  readCapability,
  validateCapabilities,
  validateAssembly,
  assertAssemblyCompleteness,
} from '../lib/assembly/schema.js';
import { WATCH_DEFAULTS, TRAJECTORY_DEFAULTS, VERIFY_DEFAULTS, DISCOVERY_DEFAULTS } from '../lib/schema.js';
import { DEFAULT_ASSEMBLY } from '../lib/assembly.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── fixture：可解析技能名目录（生产 = ~/.agents/skills/<name>/SKILL.md 存在性解析器）──
const SKILL_NAMES = new Set([
  'dev-planner', 'dev-designer', 'spec-writing', 'design-an-interface',
  'dev-coder', 'efficient-edit', 'codebase-design', 'dev-tester',
  'code-review-guideline', 'report-blind-audit', 'archive', 'doc-generator', 'doc-update',
]);
const catalog = { has: (name) => SKILL_NAMES.has(name) };

const patchYml = readFileSync(join(__dirname, '..', 'cordis.patch.yml'), 'utf8').replace(/\r\n/g, '\n');

// ── 注册表完整性（A1.1/A1.2）──

test('CAPABILITY_REGISTRY registers all 9 capability keys', () => {
  assert.deepEqual(
    new Set(CAPABILITY_REGISTRY.map((e) => e.key)),
    new Set(['aip', 'identity', 'discovery', 'verify', 'watch', 'worktree', 'budget', 'trajectory', 'acps']),
  );
});

test('registry paths match existing consumer key paths', () => {
  const byKey = Object.fromEntries(CAPABILITY_REGISTRY.map((e) => [e.key, e.path]));
  assert.deepEqual(byKey.aip, ['aip']);
  assert.deepEqual(byKey.identity, ['aip', 'identity']); // aip-gb-fix exec-identity：P2/P3 身份体系（默认关）
  assert.deepEqual(byKey.discovery, ['capabilities', 'discovery']);
  assert.deepEqual(byKey.verify, ['capabilities', 'verify']);
  assert.deepEqual(byKey.watch, ['capabilities', 'watch']);
  assert.deepEqual(byKey.worktree, ['capabilities', 'worktree']);
  assert.deepEqual(byKey.budget, ['capabilities', 'budget']);
  assert.deepEqual(byKey.trajectory, ['capabilities', 'trajectory']);
});

test('all registry defaults are ON by default except identity/acps (off — 默认关能力)', () => {
  // 全能力默认开（AIP 为主线 + 治理能力全开）；mergeAgent 嵌套默认关（需宿主注入 spawner，见 registry 注释）；
  // identity 例外：P2/P3 身份体系默认关（config.aip.identity.enabled===true 才激活，零开销零破坏）；
  // acps 例外：ACPs 通讯能力默认关（U-D2 显式开启——对外 mTLS 端点/内部桥均默认不激活，安全默认）
  for (const entry of CAPABILITY_REGISTRY) {
    if (entry.key === 'identity' || entry.key === 'acps') {
      assert.equal(entry.default.enabled, false, entry.key + ' default must be disabled (默认关)');
    } else {
      assert.equal(entry.default.enabled, true, entry.key + ' default must be enabled');
    }
  }
});

test('registry defaults align with lib/schema.js defaults', () => {
  const byKey = Object.fromEntries(CAPABILITY_REGISTRY.map((e) => [e.key, e.default]));
  assert.equal(byKey.watch, WATCH_DEFAULTS);
  assert.equal(byKey.trajectory, TRAJECTORY_DEFAULTS);
  assert.equal(byKey.verify, VERIFY_DEFAULTS);
  assert.equal(byKey.discovery, DISCOVERY_DEFAULTS);
  assert.equal(VERIFY_DEFAULTS.mode, 'advisory');
  assert.equal(DISCOVERY_DEFAULTS.enabled, true);
});

test('cordis.patch.yml aligns with registry defaults (all capabilities ON)', () => {
  for (const key of ['aip', 'trajectory', 'budget', 'watch', 'worktree']) {
    const re = new RegExp(key + ':\n\\s+enabled: true');
    assert.match(patchYml, re, key + ' must be enabled: true in patch.yml');
  }
  // verify 键由 verify-wiring lane 追加；补键后本断言仍须绿（前瞻对齐）
  if (patchYml.includes('verify:')) {
    assert.match(patchYml, /verify:\n\s+enabled: true/);
  }
  // discovery 键由 exec-discovery lane 追加
  if (patchYml.includes('discovery:')) {
    assert.match(patchYml, /discovery:\n\s+enabled: true/);
  }
  // mergeAgent 嵌套默认关（需宿主注入 spawner）
  assert.match(patchYml, /mergeAgent:\n\s+enabled: false/, 'mergeAgent must stay enabled: false in patch.yml');
});

test('EXCLUSIONS is an empty reserved table (no natural mutex today)', () => {
  assert.deepEqual(EXCLUSIONS, []);
});

test('readCapability reads by path with default merge', () => {
  const cfg = { capabilities: { verify: { enabled: true, mode: 'enforce' } } };
  assert.deepEqual(readCapability(cfg, 'verify'), { enabled: true, mode: 'enforce' });
  assert.deepEqual(readCapability({}, 'verify'), { enabled: true, mode: 'advisory' });
  const budgetOnly = { capabilities: { budget: { enabled: true } } };
  assert.deepEqual(readCapability(budgetOnly, 'budget'), { enabled: true, maxChainHops: 4, maxChainRoundTrips: 2 });
  assert.deepEqual(readCapability({ aip: { enabled: true } }, 'aip'), { enabled: true });
  assert.deepEqual(readCapability({}, 'aip'), { enabled: true }); // 缺省默认开启（与 CAPABILITY_REGISTRY 默认一致）
  assert.equal(readCapability({}, 'nope'), undefined);
});

// ── validateCapabilities（A1.3）──

test('validateCapabilities: enabled-all legitimate combo yields zero errors', () => {
  const allOn = {
    aip: { enabled: true },
    capabilities: {
      verify: { enabled: true, mode: 'enforce' },
      watch: { enabled: true, maxMissed: 3, scanIntervalMinutes: 1 },
      worktree: { enabled: true },
      budget: { enabled: true, maxChainHops: 4, maxChainRoundTrips: 2 },
      trajectory: { enabled: true, autoFail: true, poll: { enabled: false, baseUrl: null } },
    },
  };
  assert.deepEqual(validateCapabilities(allOn).errors, []);
});

test('validateCapabilities DEP-1: verify.mode must be advisory|enforce', () => {
  const bad = { capabilities: { verify: { enabled: true, mode: 'bogus' } } };
  const { errors } = validateCapabilities(bad);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /DEP-1/);
});

test('validateCapabilities DEP-2: trajectory.autoFail=true requires enabled=true', () => {
  const bad = { capabilities: { trajectory: { autoFail: true } } };
  const { errors } = validateCapabilities(bad);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /DEP-2/);
});

test('validateCapabilities DEP-3: trajectory.poll.enabled=true requires non-empty baseUrl', () => {
  for (const poll of [{ enabled: true }, { enabled: true, baseUrl: '' }]) {
    const { errors } = validateCapabilities({ capabilities: { trajectory: { poll } } });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /DEP-3/);
  }
  const ok = validateCapabilities({ capabilities: { trajectory: { poll: { enabled: true, baseUrl: 'https://x' } } } });
  assert.deepEqual(ok.errors, []);
});

test('validateCapabilities DEP-4: budget chain params must be positive integers', () => {
  for (const budget of [
    { enabled: true, maxChainHops: 0 },
    { enabled: true, maxChainRoundTrips: 1.5 },
  ]) {
    const { errors } = validateCapabilities({ capabilities: { budget } });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /DEP-4/);
  }
});

test('validateCapabilities DEP-5: watch params bounds', () => {
  for (const watch of [
    { enabled: true, maxMissed: 0 },
    { enabled: true, scanIntervalMinutes: 0.05 },
  ]) {
    const { errors } = validateCapabilities({ capabilities: { watch } });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /DEP-5/);
  }
});

test('validateCapabilities: disabled capability illegal values are ignored (zero-break)', () => {
  const disabled = {
    capabilities: {
      verify: { enabled: false, mode: 'bogus' },
      watch: { enabled: false, maxMissed: 0, scanIntervalMinutes: 0 },
      budget: { enabled: false, maxChainHops: 0 },
    },
  };
  assert.deepEqual(validateCapabilities(disabled).errors, []);
  assert.deepEqual(validateCapabilities({}).errors, []);
});

// ── validateAssembly（A1.4）──

test('validateAssembly passes DEFAULT_ASSEMBLY and external config.assembly shapes', () => {
  assert.deepEqual(validateAssembly(DEFAULT_ASSEMBLY).errors, []);
  const external = {
    team: 'my-team',
    layers: {
      exec: { roles: ['coder'], skills: { coder: ['dev-coder'] } },
    },
  };
  assert.deepEqual(validateAssembly(external).errors, []);
});

test('validateAssembly rejects malformed shapes', () => {
  assert.match(validateAssembly(null).errors[0], /object/);
  assert.match(validateAssembly(42).errors[0], /object/);
  // role 缺 skills
  const noSkills = { team: 'jiufeng', layers: { exec: { roles: ['coder'], skills: {} } } };
  assert.match(validateAssembly(noSkills).errors[0], /coder missing or empty/);
  // skills 空数组
  const emptySkills = { team: 'jiufeng', layers: { exec: { roles: ['coder'], skills: { coder: [] } } } };
  assert.match(validateAssembly(emptySkills).errors[0], /coder missing or empty/);
  // roles 非数组
  const badRoles = { team: 'jiufeng', layers: { exec: { roles: 'coder', skills: { coder: ['dev-coder'] } } } };
  assert.match(validateAssembly(badRoles).errors[0], /roles must be a non-empty array/);
});

// ── assertAssemblyCompleteness 三视图（A1.5 / P1-8）──

test('completeness view 1 (forward): DEFAULT_ASSEMBLY self-consistent', () => {
  const r = assertAssemblyCompleteness(DEFAULT_ASSEMBLY, catalog);
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
});

test('completeness view 1 (forward): unresolvable skill reported', () => {
  const bad = {
    ...DEFAULT_ASSEMBLY,
    layers: {
      ...DEFAULT_ASSEMBLY.layers,
      exec: { ...DEFAULT_ASSEMBLY.layers.exec, skills: { ...DEFAULT_ASSEMBLY.layers.exec.skills, coder: ['dev-coder', 'not-a-real-skill'] } },
    },
  };
  const r = assertAssemblyCompleteness(bad, catalog);
  assert.equal(r.ok, false);
  assert.ok(r.missing.some((m) => m.includes('not-a-real-skill')));
});

test('completeness view 1 (forward): role missing skills reported', () => {
  const bad = {
    ...DEFAULT_ASSEMBLY,
    layers: {
      ...DEFAULT_ASSEMBLY.layers,
      exec: { roles: ['coder', 'tester'], skills: { tester: DEFAULT_ASSEMBLY.layers.exec.skills.tester } },
    },
  };
  const r = assertAssemblyCompleteness(bad, catalog);
  assert.equal(r.ok, false);
  assert.ok(r.missing.some((m) => m.includes('coder') && m.includes('missing or empty')));
});

test('completeness view 2 (reverse): 7 required roles present, manager exempt', () => {
  assert.deepEqual(REQUIRED_ROLES, ['coordinator', 'designer', 'coder', 'tester', 'reviewer', 'supervisor', 'doc-manager']);
  assert.equal(REQUIRED_ROLES.includes('manager'), false);
  const r = assertAssemblyCompleteness(DEFAULT_ASSEMBLY, catalog);
  assert.equal(r.ok, true);
  assert.ok(!r.missing.some((m) => m.includes('manager')));
});

test('completeness view 2 (reverse): dropped role reported as missing', () => {
  const noCoordinator = {
    ...DEFAULT_ASSEMBLY,
    layers: {
      ...DEFAULT_ASSEMBLY.layers,
      plan: { roles: ['designer'], skills: { designer: DEFAULT_ASSEMBLY.layers.plan.skills.designer } },
    },
  };
  const r = assertAssemblyCompleteness(noCoordinator, catalog);
  assert.equal(r.ok, false);
  assert.ok(r.missing.some((m) => m.includes('"coordinator"')));
});

test('completeness view 3 (extension): blindReview on → roles + 6 templates OK', () => {
  const assembled = {
    ...DEFAULT_ASSEMBLY,
    layers: {
      ...DEFAULT_ASSEMBLY.layers,
      audit: {
        roles: [...DEFAULT_ASSEMBLY.layers.audit.roles, ...BLIND_REVIEW_ROLES],
        skills: {
          ...DEFAULT_ASSEMBLY.layers.audit.skills,
          'audit-panelist': ['report-blind-audit', 'code-review-guideline'],
          'audit-aggregate': ['report-blind-audit'],
          'audit-critic': ['report-blind-audit'],
        },
      },
    },
    extensions: {
      blindReview: {
        enabled: true,
        templates: Object.fromEntries(BLIND_REVIEW_TEMPLATE_KEYS.map((k) => [k, {}])),
      },
    },
  };
  const r = assertAssemblyCompleteness(assembled, catalog);
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
});

test('completeness view 3 (extension): missing template key reported', () => {
  const assembled = {
    ...DEFAULT_ASSEMBLY,
    layers: {
      ...DEFAULT_ASSEMBLY.layers,
      audit: {
        roles: [...DEFAULT_ASSEMBLY.layers.audit.roles, ...BLIND_REVIEW_ROLES],
        skills: {
          ...DEFAULT_ASSEMBLY.layers.audit.skills,
          'audit-panelist': ['report-blind-audit'],
          'audit-aggregate': ['report-blind-audit'],
          'audit-critic': ['report-blind-audit'],
        },
      },
    },
    extensions: { blindReview: { enabled: true, templates: { bundle: {}, panelist: {}, aggregate: {}, checklist: {}, config: {} } } },
  };
  const r = assertAssemblyCompleteness(assembled, catalog);
  assert.equal(r.ok, false);
  assert.ok(r.missing.some((m) => m.includes('template "critic" missing')));
});

test('completeness view 3 (extension): disabled by default → zero impact', () => {
  const r = assertAssemblyCompleteness(DEFAULT_ASSEMBLY, catalog);
  assert.equal(r.ok, true);
  assert.ok(!r.missing.some((m) => m.includes('blindReview')));
});

test('completeness requires skillCatalog', () => {
  assert.throws(() => assertAssemblyCompleteness(DEFAULT_ASSEMBLY), TypeError);
});
