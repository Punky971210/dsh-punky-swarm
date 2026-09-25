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

// 护栏第三类判定面：工具黑名单（工具 × 行为）——判定内核（纯函数、零依赖、确定性）。
//
// 目的：让 Agent 写文件**默认走 edit / write / str-replace-editor 等在册工具**，
//   不经 shell（pwsh）自建写路径落盘——避免编码头/BOM 被写盘破坏（Windows 下 `>` 重定向与
//   `Set-Content` / `Out-File` 可能写 GBK 或带 BOM；该损坏不可逆，与 AGENTS.md 编码铁律同源）。
//
// 拦截面（「仅护栏禁止修改或写文件」）：只判「修改或写文件」这一类动作——
//   ① 重定向（`>` / `>>`）；② 写文件 cmdlet（Set-Content / Add-Content / Out-File / New-Item /
//   Remove-Item / Move-Item / Copy-Item / Export-Csv…）；③ 段首写命令名（rm / mv / cp / del /
//   mkdir / touch / tee / chmod…）；④ 落盘参数（-OutFile / find -exec 写侧）。
//   执行、构建、测试、包管理、网络**一律放行**——`npm run build`（tsc 落盘）、`npm test`、
//   `node x.mjs`、`git status`、`Get-ChildItem` 都不在拦截面内：构建与测试本身要写盘，
//   拦它们会断裂常规开发闭环（用户裁决 Q6）。
//
// 与执行引擎无关（用户裁决 Q4）：本模块**自带**写动作判定，**不 import / 不修改**
//   `lib/tools/readonly.js`（那是难度门禁「只读侦察面」在执行侧使用的共享判定，服务于
//   「评估前能否跑侦察命令」这一另外的问题）。两处判定各自独立、互不影响。
//
// ⚠ 边界（如实声明，勿误读）：本判定是**启发式、非沙箱**——别名（`sc` = Set-Content、`ni`/`ri`/`mi`）、
//   脚本文件（`pwsh -File x.ps1`）、转义参数、编码方式均可绕过；「内联解释器写」
//   （`node -e "fs.writeFileSync(...)"` / `python -c "open(...,'w')"`）**首批不覆盖**（登记 followup）。
//   本模块只收敛「无意识地用 shell 写盘代替 edit/write」这一主路径，**不承诺**等价于 OS 级隔离或
//   编码安全——真正的编码保证来自 edit/write 工具链本身（UTF-8 无 BOM）。
//
// 判定链（顺序固定，fail-closed 边界处理）：
//   ⓪ 空 / 非字符串 → 不命中（无写动作可判，且非 shell 命令形态）；
//   ① 引号掩码（引号内的 `>` / cmdlet 名不参与判定，「引号里提到 Set-Content」不误拦）；
//      未闭合引号 → **命中**（边界不明，保守拒绝，纠正文本指向 edit/write）；
//   ② 剥流合并（`2>&1` / `2>$null` 只合并或丢弃流，不落盘）；
//   ③ 全串写指示符（引号外任意位置）→ 命中；
//   ④ 按 `;` `&&` `||` `|` 换行分段，逐段取段首 token（先剥赋值前缀，再跳过 `(` `&` `.` 包裹），
//      命中写命令名 → 命中；
//   ⑤ 其余 → 放行。
//
// 行为面分派（2026-09-15 B1 修复，fail-open → fail-closed）：条目 behavior **未知 / 缺失**时
//   不落任何写判定面 ⇒ 此前返回 hit:false（**fail-open**：条目在册、工具名已匹配、命令明显写盘
//   却放行，与 readonly 面的 fail-closed 相反）。现改为**命中**（保守拒绝 + 理由写明行为面未实现，
//   收据可溯源）；装载层另有双保险（validateToolBanEntries 拒绝非法 behavior，见 config.ts）。

import type { ToolBanEntry, ToolBanBehavior, Violation } from './types.js';

// 引号字面量掩码（替代符刻意选无语义 token：不会被写指示符命中，也不会被当命令名）
const QUOTE_MASK = '__Q__';
// 段内赋值的环境前缀（PowerShell `$x = ` / POSIX `x=`）：只剥前缀，右侧照原判定
const ASSIGN_RE = /^\s*(?:\$[A-Za-z_][\w]*|[A-Za-z_][\w]*)\s*=\s*/;

// ③ 写文件 cmdlet（动词-名词组合，只取**落盘 / 改文件**语义；Set-Alias / Start-Process 等不在此列）
const WRITE_CMDLET_RE =
  /(?<![\w-])(?:set|add|clear|new|remove|move|copy|rename|out|tee|export)-(?:content|item|itemproperty|file|object|csv|clixml|certificate|pfxcertificate)(?![\w-])/i;

// ③ 落盘参数（明确「把结果写到文件」；刻意**不取** `--output`——其语义常为「输出到 stdout」）
const OUTFILE_RE = /(?<![\w-])-outfile\b/i;

// ③ find 的写侧动作
const FIND_WRITE_RE = /\s-(?:exec|execdir|delete|fdelete)\b/i;

// ③ 全串写指示符（出现在引号外任意位置即判写文件）
const GLOBAL_WRITE: ReadonlyArray<readonly [RegExp, string]> = [
  [/>/, '含重定向（> / >>）'],
  [WRITE_CMDLET_RE, '含写文件 cmdlet（Set-Content / Out-File / New-Item / Remove-Item 等）'],
  [OUTFILE_RE, '含落盘参数 -OutFile'],
  [FIND_WRITE_RE, '含 find 的写侧动作（-exec / -delete）'],
];

// ④ 段首写命令名（只在命令位判定：段首 token 完全等于它才命中）
const WRITE_HEADS = new Set([
  // POSIX / cmd 的写文件命令
  'rm', 'rmdir', 'rd', 'del', 'erase', 'mv', 'move', 'cp', 'copy', 'xcopy', 'robocopy',
  'mkdir', 'md', 'touch', 'tee', 'truncate', 'chmod', 'chown', 'chgrp', 'ln', 'dd',
  'attrib', 'icacls', 'cacls', 'takeown', 'ren', 'rename',
  // PowerShell 写文件 cmdlet 全名（段首形态；混在管道中段尾的由 ③ 全串判定兜住）
  'set-content', 'add-content', 'clear-content', 'set-item', 'set-itemproperty',
  'new-item', 'new-itemproperty', 'remove-item', 'remove-itemproperty',
  'move-item', 'copy-item', 'rename-item', 'set-acl',
  'out-file', 'tee-object', 'export-csv', 'export-clixml',
]);

// 纠正文本（拒绝后回复原因，如改用 edit、write 等工具）
export const WRITE_CHANNEL_HINT =
  '；文件写请改用 edit / write / str-replace-editor 等在册工具（护栏写通道路由：shell 写盘易破坏文件编码头）';

export interface FileWriteVerdict {
  hit: boolean;
  reason: string;      // 命中理由（判定依据）或放行说明
  segment?: string;    // 命中的段（④ 段首判定时给出，便于溯源）
}

// 判定理由前缀：行为面未实现 / 非法（fail-closed 命中）——导出供单测与收据断言对齐口径
export const UNIMPLEMENTED_BEHAVIOR_REASON_PREFIX = '行为面未实现或非法：';
// 缺 code 条目的收据退路标记（拒绝文案绝不留空；条目 id 优先，无 id 才落此常量）
export const UNKNOWN_VIOLATION_CODE = 'unknown';

// 引号掩码：把 `"…"` / `'…'` 字面量替成 QUOTE_MASK（一处字面量 → 一个掩码 token）。
// 引号未闭合 → ok:false（fail-closed：边界不明，按写文件处理）。
function maskQuoted(text: string): { ok: boolean; masked: string } {
  let out = '';
  let quote: string | null = null;
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

// ② 流合并不算写：`2>&1` / `2>$null` 只合并或丢弃流，不落盘
function stripStreamMerges(text: string): string {
  return text.replace(/2>&1/g, ' ').replace(/2>\$null/gi, ' ');
}

// ④ 段首 token（跳过 `(` `&` `.` 包裹；引号字面量已掩码）
function headToken(seg: string): string {
  const m = seg.match(/^[&.(]*\s*["']?([^\s"']+)/);
  return (m?.[1] ?? '').toLowerCase();
}

// 判定单条 shell 命令是否属于「修改或写文件」。
export function judgeFileWriteCommand(command: unknown): FileWriteVerdict {
  if (typeof command !== 'string' || command.trim().length === 0) {
    return { hit: false, reason: '命令为空或非字符串（无写动作可判）' };
  }
  const masked = maskQuoted(stripStreamMerges(command));
  if (!masked.ok) {
    return { hit: true, reason: '含未闭合引号，命令边界不明（fail-closed 按写文件处理）' };
  }
  const text = masked.masked;
  for (const [re, why] of GLOBAL_WRITE) {
    if (re.test(text)) return { hit: true, reason: why };
  }
  for (const seg of text.split(/;|&&|\|\||\||\r?\n/)) {
    let s = seg.trim();
    if (s.length === 0) continue;
    const afterAssign = s.replace(ASSIGN_RE, '');
    if (afterAssign !== s) s = afterAssign.trim();
    if (s.length === 0) continue;
    const head = headToken(s);
    if (head.length > 0 && WRITE_HEADS.has(head)) {
      return { hit: true, reason: '段首为写文件命令: ' + head, segment: seg.trim() };
    }
  }
  return { hit: false, reason: '不含写文件动作（执行 / 构建 / 只读命令，放行）' };
}

// 行为面分派：首批仅 'file-write'；**未知 / 缺失 behavior ⇒ fail-closed 命中**
//   （2026-09-15 B1：此前返回 hit:false = fail-open——条目在册却被静默绕过；与 readonly 面
//    fail-closed 口径对齐。理由写明未实现的行为面，落进 Violation.message 供收据溯源。）
function judgeBehavior(behavior: ToolBanBehavior, command: unknown): FileWriteVerdict {
  if (behavior === 'file-write') return judgeFileWriteCommand(command);
  return {
    hit: true,
    reason: UNIMPLEMENTED_BEHAVIOR_REASON_PREFIX + String(behavior) + '（该行为面无判定实现，保守按命中处理；合法值: file-write）',
  };
}

// 第三类判定入口：按条目逐条匹配（工具名 + 行为面），命中产出 Violation（交既有 classify 分类）。
// 语义与 Rule 命中同构：violations 逐条 push（不去重）、ruleRefs 收集条目 id（kernel 层保序去重）。
export function matchToolBan(
  entries: readonly ToolBanEntry[] | undefined,
  exec: { name: string; arguments: unknown },
): { violations: Violation[]; ruleRefs: string[] } {
  const violations: Violation[] = [];
  const ruleRefs: string[] = [];
  if (!Array.isArray(entries) || entries.length === 0) return { violations, ruleRefs };
  const name = exec?.name;
  const args = exec?.arguments as Record<string, unknown> | null | undefined;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.tool !== name) continue;
    const verdict = judgeBehavior(entry.behavior, args?.command);
    if (!verdict.hit) continue;
    ruleRefs.push(entry.id);
    // code 退路（2026-09-15 B1）：条目缺/空 code 时**不留空**——优先沿用条目 id（与 ruleRefs 同源、
    //   可回查预设文件），无 id 才落显式 'unknown'（此前直接传 entry.code ⇒ 拒绝文案 code=undefined）。
    //   装载层（validateToolBanEntries）已拒缺 code 条目，此为运行期双保险（内联构造/旧快照直喂内核时兜住）。
    const code = typeof entry.code === 'string' && entry.code.length > 0 ? entry.code : (entry.id || UNKNOWN_VIOLATION_CODE);
    violations.push({
      code,
      category: entry.category ?? 'hard',
      message: entry.message + '（判定依据：' + verdict.reason + '）' + WRITE_CHANNEL_HINT,
      path: '/command',
    });
  }
  return { violations, ruleRefs };
}
