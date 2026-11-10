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

// 接口：runCommand({ command, cwd, timeoutMs, retries, env, forbiddenRe, maxOutputBytes }) → { ok, exitCode, output(截断), durationMs, timedOut, forbidden, error }
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripStreamMerges, segmentCommands } from '../shell-text.js';

// B-04：Windows `.cmd/.bat` 的同步进程树守卫入口（职责与退出码契约见该文件头注释）。
const TREE_GUARD = fileURLToPath(new URL('./command-tree-guard.mjs', import.meta.url));

function envNumber(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

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

function forbiddenReFromEnv() {
  const raw = process.env.GATE_FORBIDDEN_RE;
  if (!raw) return DEFAULT_FORBIDDEN_PATTERNS;
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length > 0) return arr.map((s) => new RegExp(s, 'i'));
  } catch {  }
  return DEFAULT_FORBIDDEN_PATTERNS;
}


const WRITE_REDIRECT_RE = /(?<![=\-])>>?/;

const WRITE_CMDLET_RE =
  /(?<![\w-])(?:set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|export-csv)(?![\w-])/i;

const WRITE_OUTFILE_RE = /(?<![\w-])-outfile\b/i;
const WRITE_FIND_EXEC_RE = /(?<![\w-])-exec(?:dir)?\b/i;

const WRITE_HEADS = new Set(['rm', 'mv', 'cp', 'del', 'mkdir', 'touch', 'tee', 'chmod']);

const QUOTE_MASK = '__Q__';


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
  if (quote) out += QUOTE_MASK;
  return out;
}

function headToken(seg) {
  const m = seg.match(/^[&.(]*\s*([^\s]+)/);
  return (m?.[1] ?? '').toLowerCase();
}

function matchWritePath(command) {
  const text = maskQuoted(stripStreamMerges(command));
  if (WRITE_REDIRECT_RE.test(text)) return '含重定向（> / >>）';
  if (WRITE_CMDLET_RE.test(text)) return '含写文件 cmdlet';
  if (WRITE_OUTFILE_RE.test(text)) return '含落盘参数 -OutFile';
  if (WRITE_FIND_EXEC_RE.test(text)) return '含 find -exec 写侧';
  for (const seg of segmentCommands(text)) {
    const s = seg.trim();
    if (s.length === 0) continue;
    const head = headToken(s);
    if (head.length > 0 && WRITE_HEADS.has(head)) return '段首为写文件命令: ' + head;
  }
  return null;
}

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

const SHELL_META_RE = /[|&;<>`\r\n]|\$\(|\$\{/;
// Windows 追加：`^` 是 cmd 转义符（`^>` 可拼出被禁字符）；`%VAR%` 是变量展开（可拼出路径/命令）。
const SHELL_META_WIN_RE = /\^|%[^%\s]+%/;

/** 元字符判定（**剥引号后**）：返回命中依据；无命中返回 null。 */
function matchShellMeta(command) {
  const masked = maskQuoted(command);
  if (SHELL_META_RE.test(masked)) return '含 shell 元字符（| & ; < > 反引号 $() ${ 换行）';
  if (process.platform === 'win32' && SHELL_META_WIN_RE.test(masked)) return '含 Windows 元字符（^ / %VAR%）';
  return null;
}

/**
 * 引号感知的**空白分词**（只剥引号 + 按空白切分）：给 `shell:false` 的 spawnSync 提供 argv。
 * @returns {{argv: string[], unclosed: boolean}} `unclosed` = 引号未闭合（调用方按 spawn 失败处置）
 */
function splitCommandArgs(command) {
  const argv = [];
  let cur = '';
  let quote = null;
  let seen = false;
  for (const ch of command) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; seen = true; continue; }
    if (/\s/.test(ch)) { if (seen || cur.length > 0) { argv.push(cur); cur = ''; seen = false; } continue; }
    cur += ch;
    seen = true;
  }
  const unclosed = quote !== null;
  if (seen || cur.length > 0) argv.push(cur);
  return { argv, unclosed };
}

/**
 * Windows 专用：`shell:false` **无法**直接启动 `.cmd` / `.bat`（`npm` / `npx` 即此类）。
 * 按 `PATHEXT` 解析首个 token：解析到 `.cmd/.bat` 返回其路径，否则返回 null（`spawn` 自行报 ENOENT）。
 */
function resolveBatchTarget(file) {
  if (process.platform !== 'win32') return null;
  if (/[\\/]/.test(file) || /\.[a-z0-9]+$/i.test(file)) return null;
  const exts = String(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean);
  const dirs = String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const ext of exts) {
      const cand = path.join(d, file + ext);
      try { if (fs.existsSync(cand)) return /\.(cmd|bat)$/i.test(cand) ? cand : null; } catch {  }
    }
  }
  return null;
}

export function truncateOutput(buf, maxBytes) {
  const s = typeof buf === 'string' ? buf : String(buf ?? '');
  if (s.length <= maxBytes) return { output: s, truncated: false };
  return { output: s.slice(0, maxBytes), truncated: true };
}

/** 取首行（去 CR）：给 launcher 的 `TREE-GUARD-SPAWN-FAIL:` marker 定界。 */
function firstLineOf(text) {
  const s = String(text ?? '');
  const at = s.indexOf('\n');
  return (at === -1 ? s : s.slice(0, at)).replace(/\r$/, '');
}

function execOnce(command, { cwd, timeoutMs, env, maxOutputBytes }) {
  const start = Date.now();
  const maxBuffer = Math.max(1024 * 1024, maxOutputBytes + 4096);
  const { argv, unclosed } = splitCommandArgs(command);
  if (unclosed || argv.length === 0) {
    return {
      ok: false, exitCode: null, output: '', durationMs: Date.now() - start, timedOut: false,
      forbidden: false, truncated: false,
      error: 'GATE_EXIT_SPAWN_FAIL: ' + (unclosed ? '命令含未闭合引号（拒绝交给 shell 猜测）' : '命令为空 argv'),
    };
  }
  let file = argv[0];
  let args = argv.slice(1);
  // Windows `.cmd/.bat`（npm/npx）不能以 shell:false 直接启动 ⇒ 回落 ComSpec。
  const batch = resolveBatchTarget(file);
  if (batch) {
    file = process.env.ComSpec || 'cmd.exe';
    args = ['/d', '/s', '/c', command];
  }
  // B-04：`spawnSync` 的 `killSignal` 只作用于**直接子进程**（cmd.exe），`.cmd/.bat` 里真正干活的
  // 孙进程会成孤儿继续写盘（引擎已报 GATE_EXIT_TIMEOUT 之后仍与重试实例并发写同一产物）。
  // 故 `.cmd/.bat` 回落分支改走**同步 launcher**：内核内部 `spawn` 拿得到活 pid，超时用
  // `taskkill /F /T /PID` 杀整棵树。父层仍是 `spawnSync` ⇒ `runCommand` 的同步面不变。
  // 非 batch 分支（`node -e …` 直连）路径与选项逐字不变。
  const viaTreeGuard = process.platform === 'win32' && batch !== null;
  if (viaTreeGuard) {
    file = process.execPath;
    args = [TREE_GUARD, '--timeoutMs=' + timeoutMs, '--', command];
  }
  const r = spawnSync(file, args, {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    // launcher 路径下 +5000 只作 launcher 自身卡死的兜底：正常超时由 launcher 内部计时并以 124 收口。
    timeout: viaTreeGuard ? timeoutMs + 5000 : timeoutMs,
    killSignal: 'SIGTERM',
    maxBuffer,
    encoding: 'utf8',
  });
  const durationMs = Date.now() - start;
  // B-04：launcher 以 124 报「已杀整棵树」的超时；其余分支语义（含 ETIMEDOUT/SIGTERM）不变。
  const timedOut = (r.error && (r.error.code === 'ETIMEDOUT' || r.signal === 'SIGTERM')) || r.status === 124;
  const raw = String(r.stdout ?? '') + String(r.stderr ?? '');
  const { output, truncated } = truncateOutput(raw, maxOutputBytes);
  // B-04：launcher 的 spawn 失败以 126 ＋ stderr 首行 marker 表达 —— 与 spawn 级异常同归类。
  const firstLine = firstLineOf(r.stderr);
  if (r.status === 126 || firstLine.startsWith('TREE-GUARD-SPAWN-FAIL:')) {
    return {
      ok: false, exitCode: r.status ?? null, output, durationMs, timedOut: false, forbidden: false, truncated,
      error: 'GATE_EXIT_SPAWN_FAIL: ' + (firstLine.length > 0 ? firstLine : 'launcher 报 spawn 失败（无 stderr）'),
    };
  }
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
  const meta = matchShellMeta(command);
  if (meta !== null) {
    return { ok: false, exitCode: null, output: '', durationMs: 0, timedOut: false, forbidden: true, truncated: false, error: 'GATE_EXIT_FORBIDDEN' };
  }
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = execOnce(command, { cwd, timeoutMs, env, maxOutputBytes });
    if (last.ok) break;
  }
  return last;
}
