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

// A3 配置化（2026-09-21 用户裁定「判据改为全中文，且配置化」）：plan 判据两门的章节名不再硬编码——
//   · **锚点门** `GATE_AUDIT_CRITERIA_MISSING`：audit 层 `audit_contract.criteria_section`（新键）优先，
//     缺声明回落引擎基线 `ENGINE_BASELINE_CRITERIA_SECTION`（`## 验收标准`，全中文单一真源）；
//   · **契约门** `GATE_PLAN_CONTRACT`：`flows.plan.contract.required_sections`（既有键）优先，
//     缺声明回落 `ENGINE_BASELINE_PLAN_SECTIONS`（从 criteria 常量派生）。
// ⇒ 规格与判据解耦：团队用英文章节名 ⇒ 资产声明即可，代码零改动。
// 测试以「复制内置资产再改一处」构造（同 `audit-contract-gate.test.js` 手法，避免手搓资产骨架）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
// 【2026-09-27 批 3 · T-15/D-6 归因】原 `import { loadTeamAsset, TEAM_ASSET_CODES } from '../lib/assembly/team-asset.js'`
//   已删（**本体已删除**，A-5/A-6/A-9 实测 0 命中 ⇒ 该 import 是文件级 ESM 缺符号的直接根因）；
//   原 `import { writeTempTeam } from './helpers/team-fixture.mjs'` 亦删（真实骨架已删，T-4/A-9）。
import { clearFlowCache, ENGINE_BASELINE_CRITERIA_SECTION, ENGINE_BASELINE_PLAN_SECTIONS } from '../lib/assembly/flows.js';
import { assessC, registerManager, seedArtifactFile } from './helpers/gate-fixture.mjs';
// 【2026-09-27 批 3 · T-15/D-6 归因】`writeTempTeam` 导入已随 C2–C6 五例删除（真实骨架已删）。

const SESS = { agent: { session: { id: 'sess-acfg' } } };
const SID = SESS.agent.session.id;

// ── 已删（2026-09-27 批 3 · T-15/D-6 归因，五例同因）：原 test「C2 锚点门·声明覆盖（正例）」
//    / 「C3 锚点门·声明覆盖（负例）」/ 「C4 锚点门·缺声明回落引擎基线（全中文）」/ 「C5 契约门·required_sections
//    声明覆盖」/ 「C6 声明面校验：criteria_section 非字符串 ⇒ TEAM_ASSET_BAD_TYPE」──
//   面已消失 = **A3「判据配置化」所依赖的团队资产声明面**（`audit_contract.criteria_section` /
//   `flows.plan.contract.required_sections`）：T-6（`resolveTeamFlows` 读端删除 ⇒ 恒返「无声明」）+ T-1
//   （`lib/assembly/team-asset.js` 本体删除，`TEAM_ASSET_BAD_TYPE` 等 13 码入退役锁，A-10）⇒ 五例的**被检面整体不存在**；
//   夹具 `writeTempTeam` 读已删的 5 件真实骨架（T-4/A-9）⇒ 调用即抛。
//   **不可等值反转**：C4 的「缺声明回落」若反转即与本文件 C1 + `gate-flows` 的引擎基线用例重复且恒真空转（纪律 15⑤）；
//   C6 的「坏声明面校验」无载体（`loadTeamAsset` 已不存在）。
//   **存活面**：C1（判据真源常量：`ENGINE_BASELINE_CRITERIA_SECTION` 为 `ENGINE_BASELINE_PLAN_SECTIONS` 成员、
//   六裸标题、冻结、单一字面量）——这正是「锚点**今日仅一态 = 引擎基线**」的机检锚，原样在册。
//   随之删除的死代码：`makeHarness` / `tasks3` / `driveBatch` / `baseSpec` 四处助手（其全部调用点仅在被删五例内）。

test('C1 判据真源：ENGINE_BASELINE_CRITERIA_SECTION 全中文且为 PLAN_SECTIONS 成员（单一字面量）', () => {
  assert.equal(ENGINE_BASELINE_CRITERIA_SECTION, '## 验收标准');
  // 【2026-09-27 扩面】2 项 → 6 项（用户裁决：引擎校验技能的所有必要裸标题）
  assert.ok(Array.isArray(ENGINE_BASELINE_PLAN_SECTIONS) && ENGINE_BASELINE_PLAN_SECTIONS.length === 6);
  assert.equal(ENGINE_BASELINE_PLAN_SECTIONS.includes(ENGINE_BASELINE_CRITERIA_SECTION), true, '契约门须含 criteria 真源');
  assert.deepEqual([...ENGINE_BASELINE_PLAN_SECTIONS], ['## 概述', '## 问题', '## 方案', '## 需求', '## 验收标准', '## 约束']);
  assert.ok(Object.isFrozen(ENGINE_BASELINE_PLAN_SECTIONS), '基线章节集须冻结');
  // 单一字面量：flows.js 中 `## 验收标准` 只允许出现在常量定义处（防再硬编码）——
  // 由 fixture-helper-ledger 的全文扫描口径覆盖，此处锁运行期引用面。
});

// （C2 / C3 / C4 / C5 / C6 五例已删，归因见上方「已删用例」区块；本文件仅保留 C1 判据真源机检锚）

