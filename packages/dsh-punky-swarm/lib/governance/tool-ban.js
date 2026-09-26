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
// 合法行为面枚举（用于「未实现」退路的提示文案；config.ts 不 import 本模块 ⇒ 无循环依赖）
import { TOOL_BAN_BEHAVIORS } from './config.js';
// 引号字面量掩码（替代符刻意选无语义 token：不会被写指示符命中，也不会被当命令名）
const QUOTE_MASK = '__Q__';
// 段内赋值的环境前缀（PowerShell `$x = ` / POSIX `x=`）：只剥前缀，右侧照原判定
const ASSIGN_RE = /^\s*(?:\$[A-Za-z_][\w]*|[A-Za-z_][\w]*)\s*=\s*/;
// ③ 写文件 cmdlet（动词-名词组合，只取**落盘 / 改文件**语义；Set-Alias / Start-Process 等不在此列）
const WRITE_CMDLET_RE = /(?<![\w-])(?:set|add|clear|new|remove|move|copy|rename|out|tee|export)-(?:content|item|itemproperty|file|object|csv|clixml|certificate|pfxcertificate)(?![\w-])/i;
// ③ 落盘参数（明确「把结果写到文件」；刻意**不取** `--output`——其语义常为「输出到 stdout」）
const OUTFILE_RE = /(?<![\w-])-outfile\b/i;
// ③ find 的写侧动作
const FIND_WRITE_RE = /\s-(?:exec|execdir|delete|fdelete)\b/i;
// ③ 全串写指示符（出现在引号外任意位置即判写文件）
const GLOBAL_WRITE = [
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
// ⑤ 等待 / 休眠类命令名（**2026-09-26 新增**：用户裁决「禁用 wait_agent 工具和 sleep 能力，
//   避免 Agent 滥用等待功能」）。只在**段首命令位**判定（与 ④ 写命令名同构）。
//   边界（同 file-write 的启发式口径，如实声明）：别名、脚本文件（`pwsh -File x.ps1`）、
//   内联解释器（`node -e "setTimeout(...)"` / `python -c "time.sleep(5)"`）**不在列**——
//   本判定只收敛「shell 里直接 sleep / 等待」这一主路径，不承诺等价于 OS 级隔离。
const WAIT_SLEEP_HEADS = new Set([
    // PowerShell
    'start-sleep', 'sleep', 'wait-event', 'wait-process', 'wait-job', 'wait-service',
    // POSIX / cmd
    'wait', 'timeout',
]);
// 判定单条 shell 命令是否属于「等待 / 休眠」（`wait-sleep` 行为面）。
//   判定链与 judgeFileWriteCommand 同构：空/非串 → 不命中；未闭合引号 → fail-closed 命中；
//   按 `;` `&&` `||` `|` 换行分段 → 段首 token 命中即拒；其余放行。
//   ⇒ 放行面举例：`npm test`（段首是 npm）、`Get-ChildItem`、`git status`。
export function judgeWaitSleepCommand(command) {
    if (typeof command !== 'string' || command.trim().length === 0) {
        return { hit: false, reason: '命令为空或非字符串（无等待动作可判）' };
    }
    const masked = maskQuoted(stripStreamMerges(command));
    if (!masked.ok) {
        return { hit: true, reason: '含未闭合引号，命令边界不明（fail-closed 按等待处理）' };
    }
    for (const seg of masked.masked.split(/;|&&|\|\||\||\r?\n/)) {
        let s = seg.trim();
        if (s.length === 0)
            continue;
        const afterAssign = s.replace(ASSIGN_RE, '');
        if (afterAssign !== s)
            s = afterAssign.trim();
        if (s.length === 0)
            continue;
        const head = headToken(s);
        if (head.length > 0 && WAIT_SLEEP_HEADS.has(head)) {
            return { hit: true, reason: '段首为等待/休眠命令: ' + head, segment: seg.trim() };
        }
    }
    return { hit: false, reason: '不含等待/休眠动作（执行 / 构建 / 只读命令，放行）' };
}
// 纠正文本（拒绝后回复原因，如改用 edit、write 等工具）
export const WRITE_CHANNEL_HINT = '；文件写请改用 edit / write / str-replace-editor 等在册工具（护栏写通道路由：shell 写盘易破坏文件编码头）';
// 判定理由前缀：行为面未实现 / 非法（fail-closed 命中）——导出供单测与收据断言对齐口径
export const UNIMPLEMENTED_BEHAVIOR_REASON_PREFIX = '行为面未实现或非法：';
// 缺 code 条目的收据退路标记（拒绝文案绝不留空；条目 id 优先，无 id 才落此常量）
export const UNKNOWN_VIOLATION_CODE = 'unknown';
// 引号掩码：把 `"…"` / `'…'` 字面量替成 QUOTE_MASK（一处字面量 → 一个掩码 token）。
// 引号未闭合 → ok:false（fail-closed：边界不明，按写文件处理）。
function maskQuoted(text) {
    let out = '';
    let quote = null;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === quote) {
                quote = null;
                out += QUOTE_MASK;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        out += ch;
    }
    if (quote)
        return { ok: false, masked: '' };
    return { ok: true, masked: out };
}
// ② 流合并不算写：`2>&1` / `2>$null` 只合并或丢弃流，不落盘
function stripStreamMerges(text) {
    return text.replace(/2>&1/g, ' ').replace(/2>\$null/gi, ' ');
}
// ④ 段首 token（跳过 `(` `&` `.` 包裹；引号字面量已掩码）
function headToken(seg) {
    const m = seg.match(/^[&.(]*\s*["']?([^\s"']+)/);
    return (m?.[1] ?? '').toLowerCase();
}
// 判定单条 shell 命令是否属于「修改或写文件」。
export function judgeFileWriteCommand(command) {
    if (typeof command !== 'string' || command.trim().length === 0) {
        return { hit: false, reason: '命令为空或非字符串（无写动作可判）' };
    }
    const masked = maskQuoted(stripStreamMerges(command));
    if (!masked.ok) {
        return { hit: true, reason: '含未闭合引号，命令边界不明（fail-closed 按写文件处理）' };
    }
    const text = masked.masked;
    for (const [re, why] of GLOBAL_WRITE) {
        if (re.test(text))
            return { hit: true, reason: why };
    }
    for (const seg of text.split(/;|&&|\|\||\||\r?\n/)) {
        let s = seg.trim();
        if (s.length === 0)
            continue;
        const afterAssign = s.replace(ASSIGN_RE, '');
        if (afterAssign !== s)
            s = afterAssign.trim();
        if (s.length === 0)
            continue;
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
function judgeBehavior(behavior, command) {
    if (behavior === 'file-write')
        return judgeFileWriteCommand(command);
    if (behavior === 'wait-sleep')
        return judgeWaitSleepCommand(command);
    // `tool-disabled`：**无条件禁用该工具** —— 不看任何参数。
    //   用途：`wait_agent` 这类**没有 `command` 参数**的工具（走 file-write 会因「命令为空」而放行）。
    if (behavior === 'tool-disabled') {
        return { hit: true, reason: '工具已被护栏整体禁用（tool-disabled：不看参数）' };
    }
    // 未实现 / 未知行为面 ⇒ **fail-closed 命中**（2026-09-15 B1：此前 hit:false 属 fail-open）
    return {
        hit: true,
        reason: UNIMPLEMENTED_BEHAVIOR_REASON_PREFIX +
            String(behavior) +
            '（该行为面无判定实现，保守按命中处理；合法值: ' +
            TOOL_BAN_BEHAVIORS.join(' / ') +
            '）',
    };
}
// 第三类判定入口：按条目逐条匹配（工具名 + 行为面），命中产出 Violation（交既有 classify 分类）。
// 语义与 Rule 命中同构：violations 逐条 push（不去重）、ruleRefs 收集条目 id（kernel 层保序去重）。
export function matchToolBan(entries, exec) {
    const violations = [];
    const ruleRefs = [];
    if (!Array.isArray(entries) || entries.length === 0)
        return { violations, ruleRefs };
    const name = exec?.name;
    const args = exec?.arguments;
    for (const entry of entries) {
        if (!entry || typeof entry !== 'object')
            continue;
        if (entry.tool !== name)
            continue;
        const verdict = judgeBehavior(entry.behavior, args?.command);
        if (!verdict.hit)
            continue;
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
