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

// shell 文本预处理**单点**（`(lib-root)` 中立件），两个同族导出：
//   ① `stripStreamMerges`：只读判定链（`lib/tools/readonly.js`）与命令 gate 执行器（`lib/state/command-exec.js`）
//      原先各持一份逐字同体的实现 ⇒ 收敛于此（W1a / A-6）。判据：`2>&1` / `2>$null` 只合并或丢弃流，不落盘 ⇒ 不算写动作。
//   ② `segmentCommands`：命令**分段**单点（DEBT-3 真单点化）——三处判定面（只读 `lib/tools/readonly.js`、
//      命令 gate 黑名单 `lib/state/command-exec.js`、护栏第三类 `lib/governance/tool-ban.ts`）原先各持一份
//      逐字同体的分隔正则 ⇒ 收敛于此，分隔符集合与顺序**冻结**（改分隔符 = 改全仓判定语义）。
//      护栏侧改走本中立件而**不再自抄第三份**（口径同步：`docs/governance-boundaries.md` §5）。
export function stripStreamMerges(text) {
  return text.replace(/2>&1/g, ' ').replace(/2>\$null/gi, ' ');
}

/** 命令分段单点：按 `;` / `&&` / `||` / `|` / 裸 `&` / 换行 切段（非字符串 ⇒ 空数组）。 */
export function segmentCommands(text) {
  if (typeof text !== 'string') return [];
  return text.split(/;|&&|\|\||\||&|\r?\n/);
}
