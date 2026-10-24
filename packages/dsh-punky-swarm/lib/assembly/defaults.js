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
//   punky-preset 团队装配**已弃用**（同上）；`DEFAULT_ASSEMBLY` = **活路径**：它是 `lib/tools/register.js:64` 与 `lib/acps/server.js:134` 的**缺省回落值**，并供 `lib/index.js:321` 派生 agent descriptors；内容 = software-team 装配。
// 历史（保留可读）：原解析顺序 = ① `config.assembly` → ② 包内团队资产 → ③ 无资产即 `null`。
// 【W5/R-9 · 2026-10-18】本常量自 `lib/assembly.js` **原样迁出**（内容与注释逐字未改）——
//   单点 = 本文件；包级根 `lib/assembly.js` 保形再导出，消费方一行不改。
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
        reviewer: ['code-review'],
      },
    },
    audit: {
      roles: ['supervisor', 'doc-manager'],
      skills: {
        supervisor: ['verification-before-completion'],
        'doc-manager': ['doc-generator'],
      },
    },
  },
};
