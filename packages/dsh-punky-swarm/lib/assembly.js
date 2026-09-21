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

// 团队资产解析（包内 presets/<team>/team-asset.yml）与包根解析
import { loadTeamAsset } from './assembly/team-asset.js';
import { packageRoot } from './assembly/flows.js';

// 可插拔装配数据：team → layer → role → skills
// 引擎只认 "role 契约 + skill 前缀" 通用格式，不感知 team；换团队 = 换装配（外部路径 config.assembly 或团队资产）
// ── 权威源：**包内团队资产** ──
//   解析顺序：① `config.assembly`（外部覆盖层，整份优先）；
//             ② 包内 `presets/<team>/team-asset.yml` 的 `layers` 段（**装配数据唯一权威来源**）；
//             ③ 无资产 → **null**（不补 skills；无资产/不可解析已在**构造期前置拒载** `TEAM_ASSET_NOT_FOUND` / `TEAM_ASSET_SKILLS_MISMATCH`；原 `「团队资产缺失」码(已删)` 码与告警已删，见 `lib/tools/core.js:691-694`）。
//   punky-preset 团队装配**已弃用**：引擎不再以内置常量兜底 punky-preset 装配；各团队以自身资产为准
//   （software-team 及其它团队）。DEFAULT_ASSEMBLY 保留仅为兼容导出，内容 = software-team 装配。
export const DEFAULT_ASSEMBLY = {
  team: 'software-team',
  layers: {
    plan: {
      roles: ['coordinator', 'designer'],
      skills: { coordinator: ['brainstorming', 'writing-plans'], designer: ['brainstorming', 'writing-plans', 'spec-writing'] },
    },
    exec: {
      roles: ['coder', 'tester', 'reviewer'],
      skills: {
        coder: ['test-driven-development', 'codebase-design', 'receiving-code-review', 'requesting-code-review'],
        tester: ['verification-before-completion', 'systematic-debugging'],
        reviewer: ['review-execution'],
      },
    },
    audit: {
      roles: ['supervisor', 'doc-manager'],
      skills: {
        supervisor: ['acceptance-gate', 'verification-before-completion'],
        'doc-manager': ['doc-generator', 'retro-and-memory'],
        reviewer: ['review-execution'],
      },
    },
  },
};

export function resolveAssembly(team, configAssembly = null, { root = packageRoot() } = {}) {
  if (configAssembly) return configAssembly;
  // 团队资产优先且唯一：缺资产 → null（不静默回落任何内置常量；原 `「团队资产缺失」码(已删)` 告警已删——无资产/不可解析在构造期即拒载，见 `lib/tools/core.js:691-694`）
  return assemblyFromTeamAsset(team, root);
}

// 从包内 `presets/<team>/team-asset.yml` 的 layers 段构造装配（团队资产为权威源）
// 失败/缺资产 → null（调用方按**引擎基线**处理——legacy 间接层已于 2026-09-15 完全清退）；**不抛错**（加载期问题由 team-asset 校验面报告）
export function assemblyFromTeamAsset(team, root = packageRoot()) {
  if (typeof team !== 'string' || team.trim().length === 0) return null;
  const r = loadTeamAsset(root, team);
  if (!r.ok || !r.asset || !r.asset.layers || typeof r.asset.layers !== 'object') return null;
  return { team, layers: r.asset.layers };
}
