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

import { stripStreamMerges, segmentCommands, ASSIGN_RE, maskQuoted, headToken } from '../shell-text.js';

//       作用域收窄的理由 = 只读检索里的同名文本（`grep -rn "-delete" lib`）不得被误拒；

export const SHELL_TOOLS = ['pwsh', 'bash'];

const GIT_PREFIX_RE = /^(?:-C\s+(?:__Q__|\S+)|--no-pager|-P|--paginate)\s+/i;

const FIND_WRITE_FLAG_RE = /[\s("']-(?:fprint\d*|fprintf|fls|exec|execdir|delete|ok|okdir|fdelete)\b/i;

const GLOBAL_DENY = [
  [/>/, '含重定向（> / >>）'],
  [/\$\(/, '含命令替换 $()，无法静态判定'],
  [/`/, '含命令替换（反引号），无法静态判定'],
  // PowerShell 危险动词前缀（Set-Content/New-Item/Remove-Item/Out-File/Tee-Object/…）
  [/\b(?:Set|New|Remove|Add|Clear|Move|Copy|Rename|Start|Stop|Restart|Install|Uninstall|Enable|Disable|Import|Export|Mount|Dismount|Register|Unregister|Compress|Expand|Grant|Revoke|Block|Lock|Update|Out|Tee)-\w+/i, '含写动词 cmdlet'],
  [/--output(?:=|\s)|-OutFile\b/i, '含落盘输出参数'],
  [FIND_WRITE_FLAG_RE, '含 find 的写侧动作'],
];
// ④ 段首写命令名（只在命令位判定：段首 token 完全等于它才拒）
const HEAD_DENY_EXACT = new Set([
  // POSIX 写 / 变更
  'rm', 'rmdir', 'mv', 'cp', 'del', 'erase', 'mkdir', 'mdfind', 'touch', 'tee', 'truncate',
  'chmod', 'chown', 'chgrp', 'ln', 'dd', 'sudo', 'su', 'kill', 'pkill', 'taskkill', 'shutdown', 'reboot',
  'robocopy', 'xcopy', 'install', 'curl', 'wget', 'scp', 'sftp', 'ssh', 'ssh-keygen', 'ftp', 'telnet',
  // 包管理器 / 构建 / 容器
  'npm', 'npx', 'pnpm', 'yarn', 'pip', 'pip3', 'conda', 'poetry', 'uv', 'gem', 'cargo', 'go', 'mvn', 'gradle',
  'cmake', 'make', 'docker', 'docker-compose', 'kubectl', 'helm', 'terraform', 'ansible', 'apt', 'apt-get',
  'yum', 'dnf', 'apk', 'brew', 'choco', 'scoop', 'winget',
  // 解释器（可内联执行任意代码；仅显式版本查询形式在白名单里放行）
  'node', 'nodejs', 'python', 'python3', 'py', 'ruby', 'perl', 'php', 'dotnet', 'java',
  'pwsh', 'powershell', 'pwsh.exe', 'cmd', 'cmd.exe', 'sh', 'bash', 'zsh', 'fish',
  // 内联执行 / 环境改写
  'eval', 'exec', 'source', 'call', 'start', 'stop-process', 'start-process', 'start-job',
  'invoke-expression', 'add-type', 'set-executionpolicy', 'set-alias', 'set-variable', 'set-itemproperty',
  'new-item', 'new-itemproperty', 'remove-item', 'remove-itemproperty', 'move-item', 'copy-item', 'rename-item',
  'set-content', 'add-content', 'clear-content', 'set-item', 'set-acl', 'out-file', 'tee-object',
  'export-csv', 'export-clixml', 'import-module', 'import-csv', 'new-service', 'set-service', 'stop-service',
  'start-service', 'restart-computer', 'reg', 'sc', 'schtasks', 'wmic', 'netsh', 'bcdedit', 'diskpart', 'format',
]);

// ④ 只读白名单：段首 token（大小写不敏感）
const READ_ONLY_TOKENS = new Set([
  // 目录 / 文件读取
  'get-childitem', 'gci', 'ls', 'dir', 'get-content', 'gc', 'cat', 'type', 'more', 'less', 'head', 'tail',
  'get-item', 'gi', 'get-itemproperty', 'gp', 'get-filehash', 'test-path', 'resolve-path', 'rvpa', 'split-path',
  'join-path', 'stat', 'file', 'wc', 'tree', 'basename', 'dirname', 'realpath', 'readlink', 'du', 'df', 'find',
  // 检索 / 过滤 / 管道段 / 格式化
  'select-string', 'sls', 'findstr', 'grep', 'rg', 'where', 'where.exe', 'which', 'command',
  'select-object', 'select', 'where-object', 'measure-object', 'measure', 'sort-object', 'sort', 'uniq',
  'group-object', 'group', 'compare-object', 'compare', 'format-table', 'ft', 'format-list', 'fl', 'format-wide',
  'out-string', 'convertfrom-json', 'convertfrom-csv', 'convertfrom-stringdata', 'jq', 'cut', 'tr', 'diff', 'cmp',
  // 无副作用输出 / 环境只读
  'write-output', 'write-host', 'echo', 'printenv', 'env', 'pwd', 'get-location', 'gl',
  // 定位类（只改当前目录，不落盘；多语句仍逐段判定，`cd x && rm y` 的第二段照样拦）
  'cd', 'chdir', 'pushd', 'popd', 'set-location', 'sl',
  // 进程 / 系统 / 网络只读信息
  'get-process', 'gps', 'ps', 'tasklist', 'get-command', 'gcm', 'get-date', 'date', 'get-help', 'help', 'man',
  'get-member', 'gm', 'get-variable', 'gv', 'get-alias', 'get-module', 'get-host', 'get-psdrive', 'get-history',
  'get-service', 'gsv', 'get-ciminstance', 'gcim', 'get-wmiobject', 'gwmi', 'get-nettcpconnection', 'get-netadapter',
  'get-volume', 'get-disk', 'get-eventlog', 'get-winevent', 'get-counter', 'nvidia-smi', 'ipconfig', 'netstat',
  'systeminfo', 'uname', 'whoami', 'hostname', 'id', 'uptime', 'ss', 'ver', 'nslookup', 'ping', 'tracert', 'dig',
  // git 走专用分支（子命令 + 参数双白名单），不在此集合
]);

// 两词形式白名单（段首 token + 第二词完全匹配才放行）：解释器/运行时的版本查询
const TWO_WORD_READ_ONLY = new Set([
  'node -v', 'node --version', 'nodejs -v', 'nodejs --version',
  'python -v', 'python --version', 'python3 --version', 'py --version',
  'npm --version', 'pnpm --version', 'git --version',
]);

// git：子命令 + 参数两段白名单（子命令本身可能既读又写，如 branch/tag/config/stash ⇒ 参数形态再判）
// 值 = 对「子命令之后剩余串」的允许式（`/^/` = 参数自由，重定向/落盘参数已由 GLOBAL_DENY 拦）
const GIT_SUB_ALLOW = new Map([
  ['status', /^/], ['diff', /^/], ['log', /^/], ['show', /^/], ['rev-parse', /^/], ['ls-files', /^/],
  ['ls-tree', /^/], ['cat-file', /^/], ['blame', /^/], ['describe', /^/], ['shortlog', /^/],
  ['for-each-ref', /^/], ['whatchanged', /^/], ['grep', /^/], ['version', /^/], ['help', /^/],
  // 条目类：只认「列出 / 查询」参数形态
  ['stash', /^\s*(?:list|show)\b/],
  ['config', /^\s*(?:--get\w*|--list|-l\b|--show-origin|--show-scope)/],
  ['tag', /^\s*(?:-l\b|-n\b|-v\b|--list\b|--contains\b|--points-at\b|--merged\b|--no-merged\b|--format\b|--sort\b)*\s*$/],
  ['branch', /^\s*(?:-a\b|-r\b|-v\b|-vv\b|-av\b|-l\b|--list\b|--all\b|--verbose\b|--show-current\b|--contains\b|--merged\b|--no-merged\b|--sort\b|--format\b|--points-at\b)*\s*$/],
  ['remote', /^\s*(?:-v\b|--verbose\b|show\b.*)?\s*$/],
  ['worktree', /^\s*(?:list\b.*)?\s*$/],
  ['submodule', /^\s*(?:status\b.*|summary\b.*)?\s*$/],
]);

// ① 引号掩码 / 段首 token：单点在 `lib/shell-text.js`（⑤-2 去重；与 tool-ban 共用同一实现）

// ① 流合并不算写：`2>&1` / `2>$null` 只合并或丢弃流，不落盘（实现单点 = lib/shell-text.js）

// ④ 段首第二词（`git --version` 这类两词白名单用）
function secondToken(seg) {
  const m = seg.match(/^[&.(]*\s*["']?[^\s"']+["']?\s+(--?[A-Za-z][A-Za-z-]*)/);
  return (m?.[1] ?? '').toLowerCase();
}

//   只判 find 段 = 有意收窄：只读检索里的同名文本（`grep -rn "-delete" lib`）不得被误拒。
//   已知误拒边界（落在 fail-closed 侧，接受）：`find . -name "-delete"`（把被引号包裹的**旗标名**
function findWriteFlagInRaw(command) {
  for (const raw of segmentCommands(command)) {
    const seg = raw.replace(ASSIGN_RE, '').trim();
    const head = headToken(seg);
    if (head !== 'find' && head !== 'find.exe') continue;
    const m = seg.match(FIND_WRITE_FLAG_RE);
    if (m) return 'find 含写侧动作（含引号包裹形态）: ' + m[0].trim();
  }
  return null;
}

function judgeSegment(raw) {
  let seg = raw.trim();
  if (seg.length === 0) return null;
  const afterAssign = seg.replace(ASSIGN_RE, '');
  if (afterAssign !== seg) {
    seg = afterAssign.trim();
    if (seg.length === 0) return '赋值右侧为空（fail-closed）';
  }
  for (const [re, why] of GLOBAL_DENY) {
    if (re.test(seg)) return why + '（' + String(re) + '）';
  }
  const head = headToken(seg);
  const second = secondToken(seg);
  if (second && TWO_WORD_READ_ONLY.has(head + ' ' + second)) {
    const tail = seg.replace(/^[&.(]*\s*["']?[^\s"']+["']?\s+["']?[^\s"']+["']?/, '').trim();
    if (tail.length === 0) return null;
  }
  if (HEAD_DENY_EXACT.has(head)) return '段首命令不在只读面（写/执行类）: ' + head;
  if (head === 'git') {
    let rest = seg.replace(/^[&.(]*\s*["']?git["']?\s*/, '').trim();
    for (;;) {
      const mm = rest.match(GIT_PREFIX_RE);
      if (!mm) break;
      rest = rest.slice(mm[0].length).trim();
    }
    if (/^--version\b/.test(rest)) return null;
    const sub = (rest.match(/^([^\s-][^\s]*)/)?.[1] ?? '').toLowerCase();
    const allow = GIT_SUB_ALLOW.get(sub);
    if (!allow) return 'git 子命令不在只读白名单: ' + (sub || '(none)');
    if (!allow.test(rest.slice(sub.length))) return 'git ' + sub + ' 参数含写侧形态';
    return null;
  }
  if (READ_ONLY_TOKENS.has(head)) return null;
  return '段首命令不在只读白名单: ' + (head || '(empty)');
}

export function judgeShellCommand(command) {
  if (typeof command !== 'string' || command.trim().length === 0) {
    return { readonly: false, reason: '命令为空或非字符串（fail-closed）' };
  }
  const masked = maskQuoted(stripStreamMerges(command));
  if (!masked.ok) return { readonly: false, reason: '含未闭合引号，边界不明（fail-closed）' };
  const text = masked.masked;
  for (const [re, why] of GLOBAL_DENY) {
    if (re.test(text)) return { readonly: false, reason: why + '（' + String(re) + '）' };
  }
  const rawFind = findWriteFlagInRaw(command);
  if (rawFind) return { readonly: false, reason: rawFind };
  for (const seg of segmentCommands(text)) {
    const reason = judgeSegment(seg);
    if (reason != null) return { readonly: false, reason, segment: seg.trim() };
  }
  return { readonly: true, reason: '全部段均为只读命令' };
}

//   走 fail-closed 判为**非只读**：① `arguments` 整体是 **JSON 字符串**；② 命令文本挂在**别的键名**下。
/** 从工具参数里取出 shell 命令文本（兼容对象 / JSON 字符串 / 多键名）。 */
export function commandOf(args) {
  if (typeof args === 'string') {
    const t = args.trim();
    if (t.startsWith('{')) {
      try {
        const parsed = JSON.parse(t);
        if (parsed && typeof parsed.command === 'string') return parsed.command;
      } catch {  }
    }
    return args;
  }
  if (!args || typeof args !== 'object') return undefined;
  for (const k of ['command', 'cmd', 'script', 'commandLine']) {
    if (typeof args[k] === 'string') return args[k];
  }
  return undefined;
}

export function isReadOnlyShellCall(execution) {
  if (!execution || !SHELL_TOOLS.includes(execution.name)) return false;
  return judgeShellCommand(commandOf(execution?.arguments)).readonly;
}
