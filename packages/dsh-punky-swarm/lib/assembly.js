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

// 缺省装配数据单点已迁出（W5/R-9）：`lib/assembly/defaults.js`；本文件**保形再导出**，
//   消费方（`lib/acps/server.js` / `lib/tools/register.js` / `lib/index.js`）一行不改。
//   语义注释与常量内容随迁（逐字未改）。
export { DEFAULT_ASSEMBLY } from './assembly/defaults.js';

/**
 * 装配解析（**唯一真源 = `config.assembly`**）。
 * 【2026-09-27 · team-asset 全量退役】原「包内团队资产」分支**已整体删除** ⇒ `team` 参数
 *   **不再参与解析**（纯归类标签）；无覆盖层 ⇒ 返回 `null`（调用方按自身缺省处置，本函数不代造默认值）。
 * @param team 保留形参——调用方签名稳定（`lib/tools/register.js:64` 仍传 `'punky-preset'`）；函数体 `void team` ⇒ 不参与解析
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
