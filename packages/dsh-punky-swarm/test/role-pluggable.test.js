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

// R1-f 角色集可插拔：团队可声明扩展角色与额外牵头角色（与引擎基础集**并集**，不替换）
//   ① 缺声明 → 与重构前逐字一致（基础集判定）；
//   ② 团队声明扩展角色 → 该角色不再被判非法（GATE_ROLE_INVALID 消失）；
//   ③ 团队声明额外牵头角色 → 可满足 plan/audit 层齐备检查（非工程团队可用自有角色名）；
//   ④ 声明悬空（牵头角色不在任何层）→ 加载期拒载（TEAM_ASSET_LEAD_NOT_IN_LAYERS）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildWavePlan, collectRoleCompletenessWarnings, normalizeRole, VALID_ROLES, PLAN_LEAD_ROLES, AUDIT_LEAD_ROLES } from '../lib/wave-plan.js';
import { resolveTeamRoles, clearRoleCache, packageRoot } from '../lib/assembly/flows.js';
import { validateTeamAsset, TEAM_ASSET_CODES, loadTeamAsset } from '../lib/assembly/team-asset.js';

function mkPkg(team, roles) {
  const pkg = mkdtempSync(join(tmpdir(), 'roles-pkg-'));
  mkdirSync(join(pkg, 'presets', team), { recursive: true });
  writeFileSync(join(pkg, 'presets', team, 'team-asset.yml'), JSON.stringify({
    team,
    roles,
    layers: {
      plan: { roles: ['outline-designer'], skills: { 'outline-designer': ['writing-trio'] } },
      exec: { roles: ['scribe'], skills: { scribe: ['dev-coder'] } },
      audit: { roles: ['fact-checker'], skills: { 'fact-checker': ['report-blind-audit'] } },
    },
    flows: { plan: { produce_field: 'produce' } },
  }), 'utf8');
  return pkg;
}

const tasks = [
  { id: 'p1', layer: 'plan', role: 'outline-designer', produce: ['plan/outline.md'] },
  { id: 'e1', layer: 'exec', role: 'scribe', consume: ['plan/outline.md'], outputs: ['exec/draft.md'], deps: ['p1'] },
  { id: 'a1', layer: 'audit', role: 'fact-checker', produce: ['audit/check.md'], consume: ['plan/outline.md', 'exec/draft.md'], deps: ['e1'] },
];

test('R1-f：缺声明 → 基础集语义不变（扩展角色仍判非法；牵头集不含团队角色）', () => {
  clearRoleCache();
  assert.equal(normalizeRole('outline-designer'), null, '未声明扩展时新角色非法');
  assert.deepEqual([...PLAN_LEAD_ROLES], ['designer', 'coordinator']);
  assert.deepEqual([...AUDIT_LEAD_ROLES], ['supervisor', 'doc-manager']);
  const w = collectRoleCompletenessWarnings(tasks, [['p1'], ['e1'], ['a1']]);
  assert.equal(w.filter((x) => x.code === 'GATE_ROLE_MISSING').length, 2, 'plan/audit 两层均缺牵头');
});

test('R1-f：团队声明扩展角色 + 额外牵头角色 → 非法告警消失、齐备检查通过（并集语义）', () => {
  const pkg = mkPkg('writing-team', { extra: ['outline-designer', 'scribe', 'fact-checker'], plan_leads: ['outline-designer'], audit_leads: ['fact-checker'] });
  try {
    clearRoleCache();
    const roles = resolveTeamRoles('writing-team', { root: pkg });
    assert.equal(roles.ok, true);
    assert.deepEqual(roles.planLeads, ['outline-designer']);
    assert.deepEqual(roles.auditLeads, ['fact-checker']);
    // 经 buildWavePlan 端到端：无 GATE_ROLE_INVALID / GATE_ROLE_MISSING 告警
    const plan = buildWavePlan({ batchId: 'b-roles', tasks, team: 'writing-team', teamsRoot: pkg });
    const codes = plan.warnings.map((w) => w.code);
    assert.equal(codes.includes('GATE_ROLE_INVALID'), false, '扩展角色不再判非法：' + JSON.stringify(plan.warnings));
    assert.equal(codes.includes('GATE_ROLE_MISSING'), false, '团队牵头的 plan/audit lane 满足齐备：' + JSON.stringify(plan.warnings));
    // 并集语义：基础牵头角色仍有效（不被替换）
    const roles2 = resolveTeamRoles('writing-team', { root: pkg });
    assert.ok(roles2.extra.includes('scribe'));
  } finally { rmSync(pkg, { recursive: true, force: true }); clearRoleCache(); }
});

test('R1-f：团队声明只扩展角色、不声明牵头 → 齐备仍缺（并集不替代基础规则）', () => {
  const pkg = mkPkg('roles-only-team', { extra: ['outline-designer', 'scribe', 'fact-checker'] });
  try {
    clearRoleCache();
    const plan = buildWavePlan({ batchId: 'b-roles2', tasks, team: 'roles-only-team', teamsRoot: pkg });
    const codes = plan.warnings.map((w) => w.code);
    assert.equal(codes.includes('GATE_ROLE_INVALID'), false, '扩展角色合法');
    assert.equal(codes.includes('GATE_ROLE_MISSING'), true, '未声明额外牵头 → plan/audit 齐备告警仍在');
    const miss = plan.warnings.find((w) => w.code === 'GATE_ROLE_MISSING' && w.layer === 'plan');
    assert.equal(miss.missing, 'designer|coordinator', '缺 role 文案不含团队扩展角色');
  } finally { rmSync(pkg, { recursive: true, force: true }); clearRoleCache(); }
});

test('R1-f：加载期不变量——牵头角色悬空（不在任何层）→ 拒载并归因', () => {
  clearRoleCache();
  const bad = {
    team: 'x',
    roles: { extra: ['ghost-lead'], plan_leads: ['ghost-lead'] },
    layers: { plan: { roles: ['designer'], skills: { designer: ['x'] } } },
    flows: { plan: { produce_field: 'produce' } },
  };
  const r = validateTeamAsset(bad);
  // 【R2-3 一致性（2026-09-17 裁决 B）改语义】原断言 `assert.equal(r.ok, false)` 改为「不再拒载 + 警告必须留痕」：
  //   `ok = 无 blocking`，而 `LEAD_NOT_IN_LAYERS` **不在** `BLOCKING_CODES`（`lib/assembly/team-asset.js:96-106`
  //   九条内无此码）⇒ 它是 **warning 级** ⇒ 悬空牵头不再否决整份资产（旧语义下此处 false）。
  //   本用例意图（加载期不变量真在跑）**未削弱**：① 断言翻转 + ② 显式补 problems 非空
  //   （旧断言由 ok 隐含）+ ③ 码面断言（:107）与对照组（:112）**一字不动**。
  assert.equal(r.ok, true, 'R2-3 后：warning 级不得否决');
  assert.ok(r.problems.length > 0, '必须留痕（不得静默）');
  assert.ok(r.problems.some((p) => p.code === TEAM_ASSET_CODES.LEAD_NOT_IN_LAYERS), JSON.stringify(r.problems));
  // 合法形态：牵头角色在层内 → 通过
  const good = JSON.parse(JSON.stringify(bad));
  good.layers.plan.roles = ['ghost-lead'];
  good.layers.plan.skills = { 'ghost-lead': ['x'] };
  assert.equal(validateTeamAsset(good).ok, true, JSON.stringify(validateTeamAsset(good).problems));
});

test('R1-f：software-team 声明不含额外牵头 → 加载通过且与基础集语义一致', () => {
  const r = loadTeamAsset(packageRoot(), 'software-team');
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.asset.roles?.extra?.length ?? 0, 0, 'software-team 无扩展角色（软件工程 7 角色即基础集）');
  assert.equal(r.asset.roles?.plan_leads, undefined, 'software-team 未改牵头集 → 走引擎基础集');
  assert.ok(VALID_ROLES.includes('designer'));
  // 退役语义：punky-preset 团队装配已弃用（资产文件已删）⇒ 拒载；角色读端 ok:false ⇒ 回落引擎基础集（不注入团队牵头）
  const jf = loadTeamAsset(packageRoot(), 'punky-preset');
  assert.equal(jf.ok, false, 'punky-preset 团队装配已退役：无资产 ⇒ 拒载');
  assert.equal(jf.asset, null);
  clearRoleCache();
  const jfRoles = resolveTeamRoles('punky-preset', { root: packageRoot() });
  assert.equal(jfRoles.ok, false, '退役团队无声明 ⇒ 角色读端回落引擎基础集');
  assert.deepEqual([...jfRoles.planLeads], [], '退役后不注入任何团队牵头角色');
  assert.deepEqual([...jfRoles.auditLeads], []);
  assert.deepEqual([...jfRoles.extra], [], '退役后不注入任何扩展角色');
  clearRoleCache();
});
