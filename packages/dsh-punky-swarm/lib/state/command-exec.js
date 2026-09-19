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

// command-exec：命令 gate（V1）确定性执行器
// 接口：runCommand({ command, cwd, timeoutMs, retries, env, forbiddenRe, maxOutputBytes }) → { ok, exitCode, output(截断), durationMs, timedOut, forbidden, error }
// 语义：仅退出码判定（exit 0 = 通过；非 0 = 失败，不解析 stdout）；超时 kill；重试容忍瞬态失败；黑名单只读守卫（命中不执行；
//       D1 起含「写盘路径」面——见下方 WRITE_* 常量；`gate:` 命令以 spawnSync(shell:true) 直跑子进程、
//       不经宿主工具面 hook，故工具面写禁须在本执行器的黑名单内等价复现）；
//       凭据只走 env 注入（不入文件/日志/输出）；输出截断入审计。
// 实现决策（同步执行器）：store.setMember 为同步 API（既有工具/测试全同步调用），merged 前置门禁须同步判定；
//       runCommand 采用 spawnSync（child_process.spawn 家族同步形态），接口契约与 design 一致（参数/返回不变），
//       不异步化 setMember，保持既有调用点零破坏、既有测试基线只增不减。
//       超时：spawnSync timeout + killSignal（Windows 上 SIGTERM/SIGKILL 均映射 TerminateProcess，两段式在同步执行器中等价；
//       POSIX 两段式 kill 若需细化留后续评估——见 code-change-summary 披露）。
import { spawnSync } from 'node:child_process';

// ---- 默认值（env 可调，全部有默认）----
export function envNumber(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

// 黑名单初始清单（coder 拟定，tester 验证补充——spec Open Questions）：
// 破坏性（rm -rf / drop / mkfs / format / dd）/ 部署与发布类（git push / npm publish / kubectl / terraform / helm /
// ansible / 部署脚本）/ 覆盖与系统类（chmod -R 777 / shutdown / reboot / poweroff / fork bomb / sudo 提权）
// 注：本数组**只是正则面**；D1 起「写盘路径面」（重定向 / 写 cmdlet / -OutFile / find -exec / 段首写命令名）
//     由下方 WRITE_* 常量与 matchWritePath 承载，经 matchesForbidden 并集生效（见该函数注释）。
export const DEFAULT_FORBIDDEN_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\brm\s+-fr\b/i,
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\b/i,
  /\bdrop\s+database\b/i,
  /\bdrop\s+table\b/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bformat\s+[a-zA-Z]:/i,
  /\bdd\s+if=/,
  /\bgit\s+push\b/i,
  /\bnpm\s+publish\b/i,
  /\byarn\s+publish\b/i,
  /\bpnpm\s+publish\b/i,
  /\bkubectl\s+(apply|delete|destroy|replace)\b/i,
  /\bterraform\s+(apply|destroy)\b/i,
  /\bhelm\s+(install|upgrade|delete|uninstall)\b/i,
  /\bansible-playbook\b/i,
  /(^|[\s;&|])\.?\/?(deploy|release|publish|install)\.(sh|ps1|bat|cmd)\b/i,
  /\bchmod\s+-R\s+777\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\bsudo\b/i,
  /:\(\)\s*\{\s*:\|\s*:\s*&\s*\}\s*;?/,
];

// GATE_FORBIDDEN_RE env 覆盖（JSON 字符串数组，如 '["\\\\brm\\\\s+-rf\\\\b"]'）；解析失败回退默认清单
export function forbiddenReFromEnv() {
  const raw = process.env.GATE_FORBIDDEN_RE;
  if (!raw) return DEFAULT_FORBIDDEN_PATTERNS;
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length > 0) return arr.map((s) => new RegExp(s, 'i'));
  } catch { /* 无效配置回退默认（fail-closed 倾向默认清单） */ }
  return DEFAULT_FORBIDDEN_PATTERNS;
}

// ==================== D1：写盘路径（工具面写禁的等价面） ====================
// 缺口（盲审 D1）：本黑名单原只含破坏性/部署类模式，而 `gate:` 命令由 spawnSync(shell:true) 直跑子进程、
//   **不经宿主工具面 hook** ⇒ lane 只要在产物写一行 `gate: <写盘命令>` 即可绕过 L3 写禁。
// 收窄口径（用户裁决，逐字）：只追加「**已有 Agent 工具替代、且已在工具配置里禁掉的那一类 pwsh 写盘路径**」，
//   其它类型一律开放——故本面**不是** tool-ban 全量清单的复制，只取权威清单 `presets/hook-rules/l3-tool-ban.json`
//   的 `scope` 逐项；该 preset 的 `not_in_scope`（执行/构建/测试/包管理/只读）与 `boundary`（别名 sc/ni/ri/mi、
//   `pwsh -File`、转义参数；**内联解释器写 node -e fs.writeFileSync / python -c open(w) 不覆盖**）**一并继承**，
//   其中内联解释器写以 followup 登记（见 exec/e3/outputs/fix-e3.md），不在本 lane 覆盖范围内。

// scope ①：重定向 `>` / `>>`。误伤控制（三条负向判据，见 test：D1-A6）：
//   a) `=>` 与 `->`：箭头/函数式语法，`>` 前邻为 `=` 或 `-` ⇒ 不属于重定向（lookbehind 直接排除）；
//   b) `2>&1` / `2>$null`：流合并/丢弃，属 L3 明示的「不算落盘」⇒ 前置剥除后再判；
//   c) 引号字面量内：字符串里的 `>` 不是重定向（如 `Select-String -Pattern "->"`）⇒ 引号掩码后不参与判定。
const WRITE_REDIRECT_RE = /(?<![=\-])>>?/;

// scope ②：写文件 cmdlet（逐个点名，不用 tool-ban 的宽泛「动词-名词」族：本面要求**误伤可控**，
//   不把 `Set-Alias` / `Clear-Host` / `Rename-Computer` 一类非文件动作拉进来）。
const WRITE_CMDLET_RE =
  /(?<![\w-])(?:set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|export-csv)(?![\w-])/i;

// scope ③：落盘参数 `-OutFile`。
const WRITE_OUTFILE_RE = /(?<![\w-])-outfile\b/i;
// scope ③：`find -exec` 写侧（`-exec` / `-execdir` 的 cmd 内可含任意写动作）。
const WRITE_FIND_EXEC_RE = /(?<![\w-])-exec(?:dir)?\b/i;

// scope ④：段首写命令名（只在**命令位**判定：段首 token 完全等于它才命中，故 `xargs rm` 不误伤）。
const WRITE_HEADS = new Set(['rm', 'mv', 'cp', 'del', 'mkdir', 'touch', 'tee', 'chmod']);

// 引号掩码：`"…"` / `'…'` 字面量整体替成一个无语义 token（内容不入判定）。
// 未闭合引号**不 fail-closed**：本面刻意**窄于** L3 工具面（L3 在边界不明时按写文件处理，此处不新开拒绝位，
//   未闭合引号退化为「只看引号外文本」）——这是与 tool-ban 的**有意差异**，登记于 fix-e3.md。
const QUOTE_MASK = '__Q__';

// 流合并不算写（L3 同款判据）：`2>&1` / `2>$null` 只合并或丢弃流，不落盘。
function stripStreamMerges(text) {
  return text.replace(/2>&1/g, ' ').replace(/2>\$null/gi, ' ');
}

// 引号掩码函数（下方 maskQuoted）：`"…"` / `'…'` 字面量整体替成一个无语义 token（内容不入判定）。
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
  if (quote) out += QUOTE_MASK; // 未闭合：剩余部分整体掩码（窄口径，见上方注释）
  return out;
}

function headToken(seg) {
  const m = seg.match(/^[&.(]*\s*([^\s]+)/);
  return (m?.[1] ?? '').toLowerCase();
}

// 写盘路径判定（scope ①②③④ 逐项）。返回命中依据字符串；未命中返回 null。
export function matchWritePath(command) {
  const text = maskQuoted(stripStreamMerges(command));
  if (WRITE_REDIRECT_RE.test(text)) return '含重定向（> / >>）';
  if (WRITE_CMDLET_RE.test(text)) return '含写文件 cmdlet';
  if (WRITE_OUTFILE_RE.test(text)) return '含落盘参数 -OutFile';
  if (WRITE_FIND_EXEC_RE.test(text)) return '含 find -exec 写侧';
  for (const seg of text.split(/;|&&|\|\||\||\r?\n/)) {
    const s = seg.trim();
    if (s.length === 0) continue;
    const head = headToken(s);
    if (head.length > 0 && WRITE_HEADS.has(head)) return '段首为写文件命令: ' + head;
  }
  return null;
}

// 统一黑名单判定：单个 RegExp 或 RegExp[]；/g 正则 lastIndex 重置防状态泄漏
// D1 起：正则面 + 写盘路径面**并集**（正则面保持数据化，写盘面因需引号掩码/分段取段首故为过程式）。
export function matchesForbidden(command, patterns) {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  for (const re of list) {
    if (!(re instanceof RegExp)) continue;
    re.lastIndex = 0;
    if (re.test(command)) return true;
  }
  if (typeof command === 'string' && matchWritePath(command) !== null) return true;
  return false;
}

// 输出截断（默认 8192B，截断部分入审计事件由调用方记录）
export function truncateOutput(buf, maxBytes) {
  const s = typeof buf === 'string' ? buf : String(buf ?? '');
  if (s.length <= maxBytes) return { output: s, truncated: false };
  return { output: s.slice(0, maxBytes), truncated: true };
}

function execOnce(command, { cwd, timeoutMs, env, maxOutputBytes }) {
  const start = Date.now();
  // maxBuffer 宽松兜底（保证命令能跑完、退出码可取），审计截断由 truncateOutput 自行完成；
  // 输出超 maxBuffer（默认 1MB，随 maxOutputBytes 抬升）视为 spawn 级异常（GATE_EXIT_SPAWN_FAIL），诚实披露
  const maxBuffer = Math.max(1024 * 1024, maxOutputBytes + 4096);
  const r = spawnSync(command, {
    cwd,
    env,
    shell: true,
    windowsHide: true,
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
    maxBuffer,
    encoding: 'utf8',
  });
  const durationMs = Date.now() - start;
  const timedOut = r.error && (r.error.code === 'ETIMEDOUT' || r.signal === 'SIGTERM');
  const raw = String(r.stdout ?? '') + String(r.stderr ?? '');
  const { output, truncated } = truncateOutput(raw, maxOutputBytes);
  if (r.error && !timedOut) {
    // spawn 异常（cwd 无效、shell 不可用、输出超 maxBuffer 等）——声明不可执行语义
    return { ok: false, exitCode: r.status ?? null, output, durationMs, timedOut: false, forbidden: false, truncated, error: 'GATE_EXIT_SPAWN_FAIL: ' + (r.error.message ?? String(r.error)) };
  }
  if (timedOut) {
    return { ok: false, exitCode: r.status ?? null, output, durationMs, timedOut: true, forbidden: false, truncated, error: 'GATE_EXIT_TIMEOUT' };
  }
  return { ok: r.status === 0, exitCode: r.status, output, durationMs, timedOut: false, forbidden: false, truncated, error: null };
}

/**
 * 确定性命令执行：黑名单 → 执行（超时 kill + 退出码判定）→ 非 0/超时按 retries 重试 → 仍失败返回失败。
 * @param {{command: string, cwd?: string, timeoutMs?: number, retries?: number, env?: object, forbiddenRe?: RegExp|RegExp[], maxOutputBytes?: number}} opts
 * @returns {{ok: boolean, exitCode: number|null, output: string, durationMs: number, timedOut: boolean, forbidden: boolean, truncated: boolean, error: string|null}}
 */
export function runCommand(opts = {}) {
  const command = opts.command;
  const timeoutMs = opts.timeoutMs ?? envNumber('GATE_TIMEOUT_MS', 120000);
  const retries = opts.retries ?? envNumber('GATE_RETRY', 1);
  const maxOutputBytes = opts.maxOutputBytes ?? envNumber('GATE_MAX_OUTPUT_BYTES', 8192);
  const forbiddenRe = opts.forbiddenRe ?? forbiddenReFromEnv();
  const env = opts.env !== undefined ? opts.env : process.env;
  const cwd = opts.cwd;

  if (typeof command !== 'string' || command.trim() === '') {
    return { ok: false, exitCode: null, output: '', durationMs: 0, timedOut: false, forbidden: false, truncated: false, error: 'GATE_EXIT_NO_COMMAND' };
  }
  if (matchesForbidden(command, forbiddenRe)) {
    return { ok: false, exitCode: null, output: '', durationMs: 0, timedOut: false, forbidden: true, truncated: false, error: 'GATE_EXIT_FORBIDDEN' };
  }
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = execOnce(command, { cwd, timeoutMs, env, maxOutputBytes });
    if (last.ok) break; // 成功即停（重试仅容忍瞬态失败）
  }
  return last;
}
