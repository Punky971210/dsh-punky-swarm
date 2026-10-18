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

// shell 文本预处理**单点**（`(lib-root)` 中立件）：只读判定链（`lib/tools/readonly.js`）与命令 gate
//   执行器（`lib/state/command-exec.js`）原先各持一份逐字同体的 `stripStreamMerges` ⇒ 收敛于此（W1a / A-6）。
// 判据：`2>&1` / `2>$null` 只合并或丢弃流，不落盘 ⇒ 不算写动作。
// 范围：`lib/governance/tool-ban.ts` 的第三份实现属冻结面（`docs/governance-boundaries.md:52`），**不并入**。
export function stripStreamMerges(text) {
  return text.replace(/2>&1/g, ' ').replace(/2>\$null/gi, ' ');
}
