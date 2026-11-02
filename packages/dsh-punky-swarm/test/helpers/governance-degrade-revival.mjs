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

// test/helpers/governance-degrade-revival.mjs
//
// **G-a（governance-escalate 粒度）四条归档用例的「复活前提」谓词**（批 `punky-adapter-channels-20261101`
//   · lane `mod-todo-exec`）。
//
// ## 为什么需要这个谓词（而不是直接把人肉断言搬回来）
//
// `test/gate-techdebt-red.test.js` 的 R-16…R-19 原以 `test.todo('<name>')`（**无回调**）形态存在
//   ⇒ **永不执行 ⇒ 无法自动转绿 ⇒ 没人知道它们什么时候该转正**（这正是 a1 要求 A-1 记账的理由）。
//
// 而它们的**复活前置条件**在文件注释里早已逐字写死（不是新发明）：
//   「若将来实施 G-a ⇒ 先登记常量 `EVT_LANE_GOVERNANCE_DEGRADE`，再接线写端，再复活本用例。」
// 当前状态（实测）：用户 2026-09-14 裁决 **G-a 不实施、维持现状** ⇒
//   `lib/state/event-types.js` **不新增** `EVT_LANE_GOVERNANCE_DEGRADE`（`event-types.js:272` 留注释说明），
//   `lane.governance-degrade` / `batch.governanceDegrade` / `governanceEscalatedAt` **全部无写者**。
//
// ⇒ 本谓词把上面那句**人话**变成**可机检**：
//     ① 事件常量已登记（`lib/state/event-types.js` 的 `export const EVT_LANE_GOVERNANCE_DEGRADE`）；
//     ② 写端在场（`lib/**` 代码面出现该事件常量或 `governanceDegrade` 的写入/发射）。
//   两条同时成立 ⇒ `revival:true` ⇒ **4 条 todo 的断言会自动转绿 + 锁的升格门 L6 会红**（「该转正了」）。
//   这正是「不靠人看输出、由门禁发现」的实现。
//
// ## 计数口径（**必须剥注释**）
//
// 全部走 `codeOnly()`（仓内唯一计数内核）：`event-types.js:272` 那行「**未登记** `lane.governance-degrade`」
//   是**注释**，裸 grep 会把「未登记」读成「已登记」（假绿的反向版）。⇒ 只认代码面。
import fs from 'node:fs';
import path from 'node:path';
import { codeOnly } from '../../scripts/baseline-snapshot-core.mjs';

/** 本谓词服务的四条归档用例（供调用方与产物对账用；不参与判定）。 */
export const GOVERNANCE_DEGRADE_CASES = Object.freeze(['R-16', 'R-17', 'R-18', 'R-19']);

/** 归属批号（A-1 记账要件：只登记条数而不写批号 = 新的待办黑洞）。 */
export const GOVERNANCE_DEGRADE_DUE_BATCH = 'punky-governance-degrade-2026Q4';

/** 两个复活条件（顺序即判定顺序；`key` 供产物/审计引用）。 */
export const GOVERNANCE_DEGRADE_CONDITIONS = Object.freeze([
  {
    key: 'event-constant',
    label: '事件常量已登记（`lib/state/event-types.js` 出现 `export const EVT_LANE_GOVERNANCE_DEGRADE`）',
  },
  {
    key: 'writer',
    label: '写端在场（`lib/**` 代码面出现 `EVT_LANE_GOVERNANCE_DEGRADE` 或 `governanceDegrade` 的写入/发射）',
  },
]);

const readUtf8 = (abs) => fs.readFileSync(abs, 'utf8');

/**
 * 求值复活前提。
 *
 * @param {string} pkgRoot 包根（`test/` 的上一级）
 * @returns {{revival: boolean, missing: string[], detail: {eventConstant: boolean, writer: boolean, writerSites: string[]}}}
 */
export function governanceDegradeRevivalOf(pkgRoot) {
  // ① 事件常量：只看 `event-types.js` 的**代码面**导出声明（注释里的「未登记」不算）。
  const eventTypesAbs = path.join(pkgRoot, 'lib', 'state', 'event-types.js');
  const eventTypesCode = fs.existsSync(eventTypesAbs) ? codeOnly(readUtf8(eventTypesAbs)) : '';
  const eventConstant = /export\s+const\s+EVT_LANE_GOVERNANCE_DEGRADE\b/.test(eventTypesCode);

  // ② 写端：扫 `lib/**/*.js` 代码面（排除 `event-types.js` 自身 —— 常量声明不算写端）。
  const writerSites = [];
  const walk = (absDir) => {
    for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
      const abs = path.join(absDir, ent.name);
      if (ent.isDirectory()) { walk(abs); continue; }
      if (!ent.name.endsWith('.js')) continue;
      const rel = path.relative(pkgRoot, abs).split(path.sep).join('/');
      if (rel === 'lib/state/event-types.js') continue;
      const code = codeOnly(readUtf8(abs));
      if (/EVT_LANE_GOVERNANCE_DEGRADE|governanceDegrade/.test(code)) writerSites.push(rel);
    }
  };
  walk(path.join(pkgRoot, 'lib'));
  const writer = writerSites.length > 0;

  const missing = GOVERNANCE_DEGRADE_CONDITIONS
    .filter((c) => (c.key === 'event-constant' ? !eventConstant : !writer))
    .map((c) => c.label);

  return { revival: eventConstant && writer, missing, detail: { eventConstant, writer, writerSites } };
}
