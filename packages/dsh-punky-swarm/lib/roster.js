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

// roster 面：**内建职位表** ＋ **宿主名册对账**（纯函数，零 I/O、零 ctx 依赖）。
//
// 定位：本仓此前只有「宿主名册里有没有某个约定名」的**单点判定**（`lib/tools/host-surface.js`
//   的 Manager 在册读端）。此面把「本仓认为该有哪些席位」与「宿主实际给了哪些席位」的**差集**
//   显式化，供读端与测试共用同一套判据（禁第二套对账实现）。
//
// 三集合语义（与 `reconcileRoster` 返回键一一对应）：
//   · `matched`     = 两侧都有 ⇒ 已落实的席位；
//   · `builtinOnly` = 内建有、宿主无 ⇒ **宿主名册缺位**（读端据此回显「在册为否」）；
//   · `hostOnly`    = 宿主有、内建无 ⇒ **未知席位**（不阻断，只回显，防静默）。
//
// 纪律（本面刻意保持极薄）：
//   · **纯函数**：同一入参恒得同一出参；不读文件、不取服务、不打日志。
//   · **不持有第二真源**：本表是「本仓内建职位」的唯一登记位；宿主名册仍是成员身份的运行时真源，
//     本函数只做**对账视图**，不缓存、不落盘、不裁决成员状态。
//   · **对外部框架零依赖**：本文件不出现任何外部团队框架的标识符（用户口径：不考虑外部框架适配）。

/**
 * 内建职位表：本仓**自己认为**的席位全集（元素为字符串职位名）。
 *
 * 分组（改动须同步 `tests` 的对账用例与 `references/` 的团队指引）：
 *   ① 软件团队 7 角色（plan `coordinator`·`designer` ／ exec `coder`·`tester`·`reviewer`
 *      ／ audit `supervisor`·`doc-manager`）；
 *   ② 通用位：`manager`（集群治理 Manager 约定席——`host-surface` 的在册判据锚点）、
 *      `lead`（官方名册常驻领队伪行，非可派席位，进表以避免被误报为「未知席位」）。
 */
export const BUILTIN_ROLES = [
  // ① 软件团队 7 角色（plan 2 ／ exec 3 ／ audit 2）
  'coordinator',   // ① plan 层席位
  'designer',      // ① plan 层席位
  'coder',         // ① exec 层席位
  'tester',        // ① exec 层席位
  'reviewer',      // ① exec 层席位
  'supervisor',    // ① audit 层席位
  // G03（批 `punky-g1-gapfix-2026-10-29` · lane `e1-fix`）：旧 camelCase 名 → **`doc-manager`** 统一命名（G03）。
  //   依据：本仓其余三面均为 kebab —— `lib/wave-plan.js` 的 `VALID_ROLES`、
  //   `lib/assembly/schema.js` 的 `REQUIRED_ROLES`、`lib/assembly/defaults.js` 的席位表。
  //   不统一则跨面 `reconcileRoster` 比对时「旧 camelCase 名 ≠ `doc-manager`」⇒ **恒误判该席两边各缺**。
  'doc-manager',   // ① audit 层席位（软件团队文档管理）
  // ② 通用位
  'manager',       // ② 集群治理 Manager 约定席（`host-surface` 的在册判据锚点）
  'lead',          // ② 官方名册常驻领队伪行（非可派席位；进表以避免被误报「未知席位」）
];

/**
 * 宿主名册 ↔ 内建职位表**对账**（纯函数）。
 *
 * @param {Array<string|{name?: string}>} [hostRoster] 宿主名册：元素可为**成员名字符串**或带 `name` 的成员视图行；
 *   空/非数组/无效元素一律按「无该席位」处理（不抛错——读端在服务不可用时也走本函数）。
 * @returns {{matched: string[], builtinOnly: string[], hostOnly: string[]}}
 *   `matched` = 两侧都有；`builtinOnly` = 内建有宿主无；`hostOnly` = 宿主有内建无。
 *   三集合各按**内建表顺序**（`hostOnly` 按宿主出现顺序）稳定排列，便于逐名比对。
 */
export function reconcileRoster(hostRoster = []) {
  const builtin = new Set(BUILTIN_ROLES);
  const host = new Set();
  for (const entry of Array.isArray(hostRoster) ? hostRoster : []) {
    const raw = typeof entry === 'string' ? entry : entry?.name;
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (name) host.add(name);
  }

  const matched = [];
  const builtinOnly = [];
  for (const name of BUILTIN_ROLES) (host.has(name) ? matched : builtinOnly).push(name);
  const hostOnly = [];
  for (const name of host) if (!builtin.has(name)) hostOnly.push(name);

  return { matched, builtinOnly, hostOnly };
}
