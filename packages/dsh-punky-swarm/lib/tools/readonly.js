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

// 只读 shell 判定（难度门禁「只读侦察面」的判定内核）
//
// 目的：难度路由门禁原先把 shell 类工具（pwsh/bash）一刀切当执行型 ⇒ 主 Agent 在评估前
//   **跑不了任何侦察命令**（列目录、git status、读文件都得先编一个档位），只能在零信息下评档，
//   于是保守取 C → 建批错派。本模块把「只读命令」从执行型里摘出来，让评估发生在侦察之后。
//
// 形态（对标梁神模式的两阶段锚定）：未评估态只放行**只读面**（read/glob/grep + 只读 shell 命令），
//   评估写入后回到全工具面。只读命令不是「执行型动作」，故**任何评估状态下都放行**，且**不计数**。
//   ✅ 活体实测（2026-09-16，N12 改字）：该判定**已恢复生效**——成因即「guard 阶段的 `arguments` 与执行期不同源」，
//   由 `commandOf()` 兼容取值修好（对象 / JSON 字符串 / 多键名三种承载）。复验读数：同一条纯只读命令后
//   `execToolCount` **未增长**，且 guard 侧 `readonly-shape` 取证日志**零输出**（即判定为只读、未走非只读分支）。
//   【2026-09-16 用户裁决】`execToolCount` / `lastAssign.execCallsSince` **仅作观察提示**，不再是档位/过期依据
//   （见 lib/state/store.js stale() 注释）；本判定仍决定「是否计入执行型动作」这一观察量。
//
// 判定链（默认拒绝 / fail-closed）：
//   ⓪ 空 / 非字符串 / **引号未闭合** → 非只读（无法静态定位边界）；
//   ① 预处理：**引号掩码**（把 `"…"` / `'…'` 字面量替成 `__Q__`，使引号内的 `>`、`|`、`;`、
//      命令名不参与判定——修「引号内 `|` 被误当管道分段、引号内 `>` 被误当重定向」的误拒）、
//      剥离流合并 `2>&1` / `2>$null`（只合并流、不落盘，不算写）；
//   ② **全串**写指示符（重定向、危险动词前缀 Set-/New-/Remove-/Out-…、`-OutFile`、find 写侧旗标）→ 非只读；
//   ②′ **原文** find 段复扫写侧旗标：掩码会把 `find . "-fprint" o.txt` 的旗标 token 一并抹成 `__Q__`
//       （掩码是修「引号内 `|`/`>` 误判」的代价）⇒ 对原文按同一套分隔符切段、**仅段首为 find 的段**复扫；
//       作用域收窄的理由 = 只读检索里的同名文本（`grep -rn "-delete" lib`）不得被误拒；
//   ③ 按 `;` `&&` `||` `|` 换行**分段**（引号已掩码 ⇒ 引号内分隔符不再误分段），逐段判定，任一段非只读 → 整条非只读；
//   ④ 段内取**命令位首 token**（先剥赋值前缀 `$x = ` / `x=`，再跳过 `(` `&` `.` 包裹）：
//        · 命中写命令名（rm/npm/curl/git 写子命令/eval…）→ 非只读；
//        · `git` 先剥只读前缀选项（`-C <dir>` / `--no-pager` / `-P` / `--paginate`）再判子命令 + 参数；
//        · 命中只读白名单（Get-ChildItem/Get-Content/git status…）→ 只读；
//        · 其余一律非只读（默认拒绝）。
//
// ⚠ 边界声明（明示，勿误读）：这是**启发式**判定，**不是沙箱**——shell 可经别名、脚本文件、
//   转义参数、编码方式绕过；本模块只收敛「无意识地用写入命令做侦察」这一主路径，靠
//   「默认拒绝 + 写指示符优先 + 逐段判定」把误放压到最小，**不承诺**等价于 OS 级隔离。
//   要强隔离请走内核级只读工具位（另案）。

// shell 类工具（判定只作用于这两种；其余执行型工具行为零变化）
export const SHELL_TOOLS = ['pwsh', 'bash'];

// 引号字面量掩码（替代符刻意选无语义 token：不会被写指示符命中，也不会被当命令名）
const QUOTE_MASK = '__Q__';
// 段内赋值的环境前缀（PowerShell `$x = ` / POSIX `x=`）：只剥前缀，右侧照原判定
const ASSIGN_RE = /^\s*(?:\$[A-Za-z_][\w]*|[A-Za-z_][\w]*)\s*=\s*/;
// git 只读前缀选项（改工作目录 / 不分页）：剥掉后按子命令判定
const GIT_PREFIX_RE = /^(?:-C\s+(?:__Q__|\S+)|--no-pager|-P|--paginate)\s+/i;

// find 写侧旗标族（`-fprint*`（含 `-fprint0`）/ `-fprintf` / `-fls` / `-exec*` / `-ok*` / `-delete`）**单表单源**，
//   两处消费：② GLOBAL_DENY（掩码后全串）与 ②′ findWriteFlagInRaw（原文 find 段）。
//   前导类 `[\s("']` 同时覆盖「空格分隔」与「被引号包裹」两种写法——在掩码后的文本里引号已消失，
//   退化为 `\s`；在原文扫描里则拦下 `find . "-fprint" o.txt` 这类借引号掩码逃逸的形态。
//   ⚠ 只列**写盘/执行**旗标：`-print` / `-print0` / `-printf`（仅 stdout）不在其列，只读用法照旧放行。
const FIND_WRITE_FLAG_RE = /[\s("']-(?:fprint\d*|fprintf|fls|exec|execdir|delete|ok|okdir|fdelete)\b/i;

// ①② 全串写指示符：出现在命令任意位置（引号外）即判非只读
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

// ① 引号掩码：把 `"…"` / `'…'` 字面量替成 QUOTE_MASK（一处字面量 → 一个掩码 token）。
//   引号未闭合 → ok:false（fail-closed：边界不明，拒绝判定为只读）。
function maskQuoted(text) {
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

// ① 流合并不算写：`2>&1` / `2>$null` 只合并或丢弃流，不落盘
function stripStreamMerges(text) {
  return text.replace(/2>&1/g, ' ').replace(/2>\$null/gi, ' ');
}

// ④ 段首 token（跳过 `(` `&` `.` 包裹；引号字面量已掩码，故 `["']?` 只为兜底）
function headToken(seg) {
  const m = seg.match(/^[&.(]*\s*["']?([^\s"']+)/);
  return (m?.[1] ?? '').toLowerCase();
}
function secondToken(seg) {
  const m = seg.match(/^[&.(]*\s*["']?[^\s"']+["']?\s+(--?[A-Za-z][A-Za-z-]*)/);
  return (m?.[1] ?? '').toLowerCase();
}

// ②′ 原文 find 段复扫写侧旗标（补引号掩码的失敏面）：掩码后的文本里引号已消失，
//   `find . "-fprint" o.txt` 的旗标 token 无从识别 ⇒ 对**原文**按同一套分隔符切段、
//   只对段首为 `find` 的段（剥赋值前缀后判定，口径同 judgeSegment）复扫。
//   只判 find 段 = 有意收窄：只读检索里的同名文本（`grep -rn "-delete" lib`）不得被误拒。
//   已知误拒边界（落在 fail-closed 侧，接受）：`find . -name "-delete"`（把被引号包裹的**旗标名**
//   当字面文件名检索）会判非只读；需检索该字面名时改用前导非引号的写法（如 `find . -name '*-delete*'`）。
function findWriteFlagInRaw(command) {
  for (const raw of command.split(/;|&&|\|\||\||\r?\n/)) {
    const seg = raw.replace(ASSIGN_RE, '').trim();
    const head = headToken(seg);
    if (head !== 'find' && head !== 'find.exe') continue;
    const m = seg.match(FIND_WRITE_FLAG_RE);
    if (m) return 'find 含写侧动作（含引号包裹形态）: ' + m[0].trim();
  }
  return null;
}

// ④ 单段判定：返回 null = 只读；返回字符串 = 非只读原因
function judgeSegment(raw) {
  let seg = raw.trim();
  if (seg.length === 0) return null;
  // 赋值前缀：只剥前缀，右侧照原判定（`$x = rm -rf y` 的右侧仍会被拒）
  const afterAssign = seg.replace(ASSIGN_RE, '');
  if (afterAssign !== seg) {
    seg = afterAssign.trim();
    if (seg.length === 0) return '赋值右侧为空（fail-closed）';
  }
  for (const [re, why] of GLOBAL_DENY) {
    if (re.test(seg)) return why + '（' + String(re) + '）';
  }
  // 解释器/运行时的显式版本查询：整段两词形式，且段内无其它 token
  const head = headToken(seg);
  const second = secondToken(seg);
  if (second && TWO_WORD_READ_ONLY.has(head + ' ' + second)) {
    const tail = seg.replace(/^[&.(]*\s*["']?[^\s"']+["']?\s+["']?[^\s"']+["']?/, '').trim();
    if (tail.length === 0) return null;
  }
  if (HEAD_DENY_EXACT.has(head)) return '段首命令不在只读面（写/执行类）: ' + head;
  if (head === 'git') {
    let rest = seg.replace(/^[&.(]*\s*["']?git["']?\s*/, '').trim();
    // 剥离只读前缀选项（-C <dir> / --no-pager / -P / --paginate）
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

// 命令级判定：{ readonly, reason, segment? }
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
  // ②′ 掩码后的文本看不到引号内的旗标 ⇒ 对原文的 find 段复扫一次（口径与收窄理由见 findWriteFlagInRaw）
  const rawFind = findWriteFlagInRaw(command);
  if (rawFind) return { readonly: false, reason: rawFind };
  for (const seg of text.split(/;|&&|\|\||\||\r?\n/)) {
    const reason = judgeSegment(seg);
    if (reason != null) return { readonly: false, reason, segment: seg.trim() };
  }
  return { readonly: true, reason: '全部段均为只读命令' };
}

// guard 入口：仅判 shell 类工具的只读性（其余工具走既有名单语义）
// D-6（2026-09-16 取证 + 加固）：活体实测「只读 pwsh 每次仍 +1 计数」⇒ 疑 guard 时刻的
//   `execution.arguments` 与执行期不同源（宿主在另一阶段才 snapshot 参数，见
//   `dsh-tools/lib/types/index.js:804-808`）。两种成因都会让 `judgeShellCommand(undefined)`
//   走 fail-closed 判为**非只读**：① `arguments` 整体是 **JSON 字符串**；② 命令文本挂在**别的键名**下。
//   故此处双管：(a) `commandOf` 兼容取值；(b) `lib/tools/core.js` guard 侧加**常驻形状取证**日志，
//   下一轮重启即可按日志定案（是形状不符还是另有其因）。
/** 从工具参数里取出 shell 命令文本（兼容对象 / JSON 字符串 / 多键名）。 */
export function commandOf(args) {
  if (typeof args === 'string') {
    const t = args.trim();
    if (t.startsWith('{')) {
      try {
        const parsed = JSON.parse(t);
        if (parsed && typeof parsed.command === 'string') return parsed.command;
      } catch { /* 非 JSON ⇒ 当作裸命令文本 */ }
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
