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

import { buildWavePlan, collectRoleCompletenessWarnings, normalizeRole, VALID_ROLES } from '../lib/wave-plan.js';
import { writeSyntheticTeam } from './helpers/team-fixture.mjs';
import { resolveTeamRoles, clearRoleCache, packageRoot } from '../lib/assembly/flows.js';
import { validateTeamAsset, TEAM_ASSET_CODES, loadTeamAsset } from '../lib/assembly/team-asset.js';

function mkPkg(team, roles) {
  const pkg = mkdtempSync(join(tmpdir(), 'roles-pkg-'));
  // F2：合成资产 ⇒ 单点写入（本套件验的是 `roles` 声明面）。
  writeSyntheticTeam(pkg, team, {
    team,
    roles,
    layers: {
      plan: { roles: ['outline-designer'], skills: { 'outline-designer': ['writing-trio'] } },
      exec: { roles: ['scribe'], skills: { scribe: ['dev-coder'] } },
      audit: { roles: ['fact-checker'], skills: { 'fact-checker': ['report-blind-audit'] } },
    },
    flows: { plan: { produce_field: 'produce' } },
  }, { filename: 'team-asset.yml' });
  return pkg;
}

const tasks = [
  { id: 'p1', layer: 'plan', role: 'outline-designer', produce: ['plan/outline.md'] },
  { id: 'e1', layer: 'exec', role: 'scribe', consume: ['plan/outline.md'], outputs: ['exec/draft.md'], deps: ['p1'] },
  { id: 'a1', layer: 'audit', role: 'fact-checker', produce: ['audit/check.md'], consume: ['plan/outline.md', 'exec/draft.md'], deps: ['e1'] },
];

// ── 已删（2026-09-26 · Q-8-C 全链删除）：原 test「R1-f：缺声明 → 基础集语义不变（扩展角色仍判非法；牵头集不含团队角色）', () =>…」
//   该 test 依托 `plan_leads`/`audit_leads` 或 `GATE_ROLE_MISSING`/`PLAN_LEAD_ROLES` —— 已随
//   用户裁决全链移除（引擎并集逻辑 + 资产级 LEAD_NOT_IN_LAYERS 校验 + 三队资产子键）。

// ── 已删（2026-09-26 · Q-8-C 全链删除）：原 test「R1-f：团队声明扩展角色 + 额外牵头角色 → 非法告警消失、齐备检查通过（并集语义）',…」
//   该 test 依托 `plan_leads`/`audit_leads` 或 `GATE_ROLE_MISSING`/`PLAN_LEAD_ROLES` —— 已随
//   用户裁决全链移除（引擎并集逻辑 + 资产级 LEAD_NOT_IN_LAYERS 校验 + 三队资产子键）。

// ── 已删（2026-09-26 · Q-8-C 全链删除）：原 test「R1-f：团队声明只扩展角色、不声明牵头 → 齐备仍缺（并集不替代基础规则）', () =>…」
//   该 test 依托 `plan_leads`/`audit_leads` 或 `GATE_ROLE_MISSING`/`PLAN_LEAD_ROLES` —— 已随
//   用户裁决全链移除（引擎并集逻辑 + 资产级 LEAD_NOT_IN_LAYERS 校验 + 三队资产子键）。

// ── 已删（2026-09-26 · Q-8-C 全链删除）：原 test「R1-f：加载期不变量——牵头角色悬空（不在任何层）→ 拒载并归因', () => {…」
//   该 test 依托 `plan_leads`/`audit_leads` 或 `GATE_ROLE_MISSING`/`PLAN_LEAD_ROLES` —— 已随
//   用户裁决全链移除（引擎并集逻辑 + 资产级 LEAD_NOT_IN_LAYERS 校验 + 三队资产子键）。

// ── 已删（2026-09-26 · Q-8-C 全链删除）：原 test「R1-f：software-team 声明不含额外牵头 → 加载通过且与基础集语义一致', …」
//   该 test 依托 `plan_leads`/`audit_leads` 或 `GATE_ROLE_MISSING`/`PLAN_LEAD_ROLES` —— 已随
//   用户裁决全链移除（引擎并集逻辑 + 资产级 LEAD_NOT_IN_LAYERS 校验 + 三队资产子键）。
