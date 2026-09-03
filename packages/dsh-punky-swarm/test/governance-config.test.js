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

// I2 集成测试（build-plan §2.6 I2，4 条）：resolveGovernanceConfig 默认合并 + cordis.patch.yml governance 键对齐断言
// （对齐 assembly-schema.test.js:96-111 patch 断言模式：readFileSync + regex）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGovernanceConfig, GOVERNANCE_DEFAULTS } from '../lib/governance/config.js';
import { createGovernanceKernel } from '../lib/governance/kernel.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const patchYml = readFileSync(join(__dirname, '..', 'cordis.patch.yml'), 'utf8').replace(/\r\n/g, '\n');

// 全默认期望（蓝图 §7 yaml，已敲定 2026-08-31：enabled:true 默认开启可显式关闭）
// M5-a（2026-09-02）：resolve 扩 escalation 段（D-5）——默认关形态（enabled:false / threshold:3 /
//   windowMs:600000 / primitives:['DENY','NARROW']）；本期望随 config.js resolve 输出结构同步。
const EXPECT_DEFAULTS = {
  enabled: true,
  rules: [],
  defaults: { deny: 'DENY' },
  flags: { pause: false, narrow: false, defer: false },
  escalation: { enabled: false, threshold: 3, windowMs: 600000, primitives: ['DENY', 'NARROW'] },
};

test('I2-1 默认合并：resolveGovernanceConfig(undefined) 与 resolveGovernanceConfig({}) → 全默认', () => {
  assert.deepEqual(resolveGovernanceConfig(undefined), EXPECT_DEFAULTS);
  assert.deepEqual(resolveGovernanceConfig({}), EXPECT_DEFAULTS);
  assert.equal(GOVERNANCE_DEFAULTS.enabled, true);
});

test('I2-2 部分覆盖保留默认：传 {rules:[...]} → enabled 仍 true、flags 仍默认、defaults.deny 仍 DENY', () => {
  const c = resolveGovernanceConfig({ rules: [{ id: 'R1', match: {}, violations: [] }] });
  assert.equal(c.enabled, true);
  assert.deepEqual(c.flags, { pause: false, narrow: false, defer: false });
  assert.equal(c.defaults.deny, 'DENY');
  assert.equal(c.rules.length, 1);
});

test('I2-3 显式关闭：传 {enabled:false} → enabled===false（rules 空表时 decide 恒 ALLOW 行为不变）', () => {
  const c = resolveGovernanceConfig({ enabled: false });
  assert.equal(c.enabled, false);
  const kernel = createGovernanceKernel(c);
  const d = kernel.decide({ name: 'bash', arguments: { cmd: 'rm -rf /' } });
  assert.deepEqual(d, { primitive: 'ALLOW', priority: -1, reason: '', ruleRefs: [] });
});

test('I2-4 cordis.patch.yml 对齐断言：governance.hook 键 → enabled:true、rules:[], defaults.deny:DENY、flags 全 false', () => {
  assert.match(patchYml, /governance:\n\s+hook:\n\s+enabled: true/, 'governance.hook.enabled must default true');
  assert.match(patchYml, /rules: \[\]/, 'rules empty by default (零拦截)');
  assert.match(patchYml, /deny: DENY/, 'defaults.deny must be DENY (fail-closed 兜底)');
  // flags 行允许行尾注释（pause 行带 CAGE feature-flag 说明）
  assert.match(patchYml, /pause: false[^\n]*\n\s+narrow: false[^\n]*\n\s+defer: false/, 'flags must all default false');
});

test('I2-5 兜底值域校验（P0 死配置修复）：defaults.deny 合法拒绝类原语生效、ALLOW 回退 DENY、非法值回退 DENY', () => {
  // 合法拒绝类原语（非 ALLOW）→ 配置真实生效（死配置修复：resolve 不再丢弃该键）
  const req = resolveGovernanceConfig({ defaults: { deny: 'REQUIRE_APPROVAL' } });
  assert.equal(req.defaults.deny, 'REQUIRE_APPROVAL', 'configurable fallback takes effect');
  // 兜底不可 ALLOW（fail-closed 纪律 hook-eval A.4）→ resolve 校验回退 DENY
  const allow = resolveGovernanceConfig({ defaults: { deny: 'ALLOW' } });
  assert.equal(allow.defaults.deny, 'DENY', 'ALLOW fallback rejected → DENY');
  // 非法值（非 6 原语）仍回退 DENY（既有校验保留）
  const bogus = resolveGovernanceConfig({ defaults: { deny: 'FOO' } });
  assert.equal(bogus.defaults.deny, 'DENY', 'non-primitive rejected → DENY');
});
