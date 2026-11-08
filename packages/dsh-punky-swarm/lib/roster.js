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
