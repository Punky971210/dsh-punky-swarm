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

// command-exec：命令 gate（V1）确定性执行器（设计 §组件 3 / spec G4-G8、C6-C7）
// 接口：runCommand({ command, cwd, timeoutMs, retries, env, forbiddenRe, maxOutputBytes }) → { ok, exitCode, output(截断), durationMs, timedOut, forbidden, error }
// 语义：仅退出码判定（exit 0 = 通过；非 0 = 失败，不解析 stdout）；超时 kill；重试容忍瞬态失败；黑名单只读守卫（命中不执行）；
//       凭据只走 env 注入（不入文件/日志/输出）；输出截断入审计。
// 实现决策（同步执行器）：store.setMember 为同步 API（既有工具/测试全同步调用），merged 前置门禁须同步判定；
//       runCommand 采用 spawnSync（child_process.spawn 家族同步形态），接口契约与 design 一致（参数/返回不变），
//       不异步化 setMember，保持既有调用点零破坏（C2 签名零改动、既有测试基线只增不减）。
//       超时：spawnSync timeout + killSignal（Windows 上 SIGTERM/SIGKILL 均映射 TerminateProcess，两段式在同步执行器中等价；
//       POSIX 两段式 kill 若需细化留 V2 评估——见 code-change-summary 披露）。
import { spawnSync } from 'node:child_process';

// ---- 默认值（env 可调，全部有默认）----
export function envNumber(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

// 黑名单初始清单（coder 拟定，tester 验证补充——spec Open Questions）：
// 破坏性（rm -rf / drop / mkfs / format / dd）/ 部署与发布类（git push / npm publish / kubectl / terraform / helm /
// ansible / 部署脚本）/ 覆盖与系统类（chmod -R 777 / shutdown / reboot / poweroff / fork bomb / sudo 提权）
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

// 统一黑名单判定：单个 RegExp 或 RegExp[]；/g 正则 lastIndex 重置防状态泄漏
export function matchesForbidden(command, patterns) {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  for (const re of list) {
    if (!(re instanceof RegExp)) continue;
    re.lastIndex = 0;
    if (re.test(command)) return true;
  }
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
