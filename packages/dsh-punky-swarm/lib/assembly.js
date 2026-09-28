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

// 装配解析（【2026-09-27 · team-asset 全量退役】已无资产读端）与包根解析
// ─────────────────────────────────────────────────────────────────────────────
// 现语义：**装配数据唯一真源 = `config.assembly`**（外部覆盖层，整份优先）；无覆盖层 ⇒ `null`
//   （调用方自行回落内置常量，如 `lib/tools/register.js` / `lib/acps/server.js` 用 `DEFAULT_ASSEMBLY`）。
//   「包内 `presets/<team>/team-asset.yml` 的 `layers` 段」这一权威源**已随资产面整体删除**
//   （A-5 判据：本文件对 `team-asset` 的 import 面归零）。
//   **零新默认值**：不得在此代造任何 `team → 装配` 映射（`team` 参数自 2026-09-27 起 = 纯归类标签）。
//   punky-preset 团队装配**已弃用**（同上）；`DEFAULT_ASSEMBLY` 保留仅为兼容导出，内容 = software-team 装配。
// 历史（保留可读）：原解析顺序 = ① `config.assembly` → ② 包内团队资产 → ③ 无资产即 `null`。
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

/**
 * 装配解析（**唯一真源 = `config.assembly`**）。
 * 【2026-09-27 · team-asset 全量退役】原「包内团队资产」分支**已整体删除** ⇒ `team` 参数
 *   **不再参与解析**（纯归类标签）；无覆盖层 ⇒ 返回 `null`（调用方按自身缺省处置，本函数不代造默认值）。
 * @param _team 保留形参（调用方签名稳定；**不再被读**）
 * @param configAssembly 外部覆盖层（整份优先）
 * @returns 覆盖层本身；未给出 ⇒ `null`
 */
export function resolveAssembly(team, configAssembly = null, _opts = {}) {
  void team;
  return configAssembly ?? null;
}

/**
 * 从团队资产构造装配。
 * 【2026-09-27 · team-asset 全量退役】**资产面已不存在** ⇒ 恒 `null`（不再读盘、不再解析 yml）。
 *   导出**保形保留**（既有调用方/用例的形状零变化）；本身零副作用、零 I/O。
 */
export function assemblyFromTeamAsset(_team, _root) {
  return null;
}
