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
import { TOOL_BAN_BEHAVIORS } from './config.js';
import { segmentCommands, stripStreamMerges } from '../shell-text.js';
const QUOTE_MASK = '__Q__';
const ASSIGN_RE = /^\s*(?:\$[A-Za-z_][\w]*|[A-Za-z_][\w]*)\s*=\s*/;
const WRITE_CMDLET_RE = /(?<![\w-])(?:set|add|clear|new|remove|move|copy|rename|out|tee|export)-(?:content|item|itemproperty|file|object|csv|clixml|certificate|pfxcertificate)(?![\w-])/i;
const OUTFILE_RE = /(?<![\w-])-outfile\b/i;
const FIND_WRITE_RE = /\s-(?:exec|execdir|delete|fdelete)\b/i;
const GLOBAL_WRITE = [
    [/>/, '含重定向（> / >>）'],
    [WRITE_CMDLET_RE, '含写文件 cmdlet（Set-Content / Out-File / New-Item / Remove-Item 等）'],
    [OUTFILE_RE, '含落盘参数 -OutFile'],
    [FIND_WRITE_RE, '含 find 的写侧动作（-exec / -delete）'],
];
const WRITE_HEADS = new Set([
    'rm', 'rmdir', 'rd', 'del', 'erase', 'mv', 'move', 'cp', 'copy', 'xcopy', 'robocopy',
    'mkdir', 'md', 'touch', 'tee', 'truncate', 'chmod', 'chown', 'chgrp', 'ln', 'dd',
    'attrib', 'icacls', 'cacls', 'takeown', 'ren', 'rename',
    'set-content', 'add-content', 'clear-content', 'set-item', 'set-itemproperty',
    'new-item', 'new-itemproperty', 'remove-item', 'remove-itemproperty',
    'move-item', 'copy-item', 'rename-item', 'set-acl',
    'out-file', 'tee-object', 'export-csv', 'export-clixml',
]);
const WAIT_SLEEP_HEADS = new Set([
    'start-sleep', 'sleep', 'wait-event', 'wait-process', 'wait-job', 'wait-service',
    'wait', 'timeout',
]);
export function judgeWaitSleepCommand(command) {
    if (typeof command !== 'string' || command.trim().length === 0) {
        return { hit: false, reason: '命令为空或非字符串（无等待动作可判）' };
    }
    const masked = maskQuoted(stripStreamMerges(command));
    if (!masked.ok) {
        return { hit: true, reason: '含未闭合引号，命令边界不明（fail-closed 按等待处理）' };
    }
    for (const seg of segmentCommands(masked.masked)) {
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
export const WRITE_CHANNEL_HINT = '；文件写请改用 edit / write / str-replace-editor 等在册工具（护栏写通道路由：shell 写盘易破坏文件编码头）';
export const UNIMPLEMENTED_BEHAVIOR_REASON_PREFIX = '行为面未实现或非法：';
export const UNKNOWN_VIOLATION_CODE = 'unknown';
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
function headToken(seg) {
    const m = seg.match(/^[&.(]*\s*["']?([^\s"']+)/);
    return (m?.[1] ?? '').toLowerCase();
}
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
    for (const seg of segmentCommands(text)) {
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
function judgeBehavior(behavior, command) {
    if (behavior === 'file-write')
        return judgeFileWriteCommand(command);
    if (behavior === 'wait-sleep')
        return judgeWaitSleepCommand(command);
    if (behavior === 'tool-disabled') {
        return { hit: true, reason: '工具已被护栏整体禁用（tool-disabled：不看参数）' };
    }
    return {
        hit: true,
        reason: UNIMPLEMENTED_BEHAVIOR_REASON_PREFIX +
            String(behavior) +
            '（该行为面无判定实现，保守按命中处理；合法值: ' +
            TOOL_BAN_BEHAVIORS.join(' / ') +
            '）',
    };
}
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
