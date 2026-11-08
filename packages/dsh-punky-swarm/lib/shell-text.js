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

// ── ③ 引号掩码 / 段首词 / 赋值前缀（⑤-2 · 2026-11-09 裁决乙「只消重复、词表不动」）────────
//   三件此前在 `lib/tools/readonly.js` 与 `lib/governance/tool-ban.js` 里**逐字各存一份**
//   （`QUOTE_MASK` / `ASSIGN_RE` / `maskQuoted` / `headToken`）⇒ 收敛于此，两处引用。
//   ⚠ 只搬实现，**不动任何词表**：两套判定的**用途不同**（只读放行 vs 文件写禁令），
//     词表宽窄差异是设计选择，不是漂移（实测「tool-ban 判写 ∧ readonly 判只读」的危险组合 = 0）。
//     已知边界见 `lib/governance/tool-ban.js` 头注。
//   ⚠ `lib/state/command-exec.js` 里另有一份**故意不同**的掩码（未闭合引号**不 fail-closed**，
//     而是补掩码继续判）——那是命令 gate 的既有边界语义，本批**不并入**（并进去等于改它的失败模式）。
export const QUOTE_MASK = '__Q__';
export const ASSIGN_RE = /^\s*(?:\$[A-Za-z_][\w]*|[A-Za-z_][\w]*)\s*=\s*/;

/** 引号掩码：把 `"…"` / `'…'` 字面量替成一个掩码 token。引号未闭合 ⇒ `ok:false`（fail-closed）。 */
export function maskQuoted(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) { quote = null; out += QUOTE_MASK; }
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    out += ch;
  }
  if (quote) return { ok: false, masked: '' };
  return { ok: true, masked: out };
}

/** 段首 token（跳过 `(` `&` `.` 包裹；掩码后引号字面量已成 token）——小写。 */
export function headToken(seg) {
  const m = seg.match(/^[&.(]*\s*["']?([^\s"']+)/);
  return (m?.[1] ?? '').toLowerCase();
}
