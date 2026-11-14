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
//     已知边界见 `lib/guard/tool-ban.js` 头注（L1 拆分后判据随护栏行搬进 `lib/guard/**`）。
//   ⚠ `lib/state/command-exec.js` 原先另有一份掩码：未闭合引号上**补掩码继续判**（与本件的 fail-closed 相反）。
//     2026-11-11 起两处共用本件的同一 `maskQuoted` ⇒ 未闭合引号在**判定期**即 fail-closed 拒绝
//     （拒绝码 `GATE_EXIT_FORBIDDEN`，零执行零重试），命令 gate 面与工具面同源同向。
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

// ── ④ 写告示表（宽/窄两套值面，各自独立、**禁合并**）· 2026-11-11 ─────────────────────────────
//   两套值面服务**不同语义域**，宽窄差异是设计选择、不是漂移：
//     · 宽表 `WRITE_HEADS_FILE_BAN`（44 项）= 工具面 file-write 禁令，判「这条命令是否会写盘」
//       ⇒ 宁可误拦，粒度粗；
//     · 窄表 `WRITE_HEADS_COMMAND_GATE`（8 项）= 命令 gate 写判定，判「是否属破坏性写操作」
//       ⇒ 要精确，不把改属性 / 复制类命令一律拒。
//   合并两表 ⇒ gate 面从 8 项跳到 44 项 = 混淆语义域（改一处会连带影响另一面），故**禁止合并**。
//   两侧各持一份、各自演进；消费者以 `import { … as <原符号名> }` 别名引用，判定体零改动。
//   ⚠ `WRITE_CMDLET_RE` 同理宽/窄两份（12 类 vs 7 类正则），同样禁合并。
export const WRITE_CMDLET_RE_FILE_BAN = /(?<![\w-])(?:set|add|clear|new|remove|move|copy|rename|out|tee|export)-(?:content|item|itemproperty|file|object|csv|clixml|certificate|pfxcertificate)(?![\w-])/i;
export const WRITE_CMDLET_RE_COMMAND_GATE = /(?<![\w-])(?:set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|export-csv)(?![\w-])/i;
// 宽表：工具面 file-write 禁令（44 项）
export const WRITE_HEADS_FILE_BAN = new Set([
    'rm', 'rmdir', 'rd', 'del', 'erase', 'mv', 'move', 'cp', 'copy', 'xcopy', 'robocopy',
    'mkdir', 'md', 'touch', 'tee', 'truncate', 'chmod', 'chown', 'chgrp', 'ln', 'dd',
    'attrib', 'icacls', 'cacls', 'takeown', 'ren', 'rename',
    'set-content', 'add-content', 'clear-content', 'set-item', 'set-itemproperty',
    'new-item', 'new-itemproperty', 'remove-item', 'remove-itemproperty',
    'move-item', 'copy-item', 'rename-item', 'set-acl',
    'out-file', 'tee-object', 'export-csv', 'export-clixml',
]);
// 窄表：命令 gate 写判定（8 项，**禁与宽表合并** —— 语义域不同）
export const WRITE_HEADS_COMMAND_GATE = new Set([
    'rm', 'mv', 'cp', 'del', 'mkdir', 'touch', 'tee', 'chmod',
]);
