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

// governance/state-store.js —— DEFER/PAUSE 文件态简版状态机（P1，harden-plan §5.2 A，JS 文件 IO）
// 载体对齐 receipt-store.js 模式：node:fs 原子写（tmp+rename）+ SESSION_RE 校验 + 零新依赖。
// 位置：<root>/governance/state/<sessionId>.json（per-session 单文件，幂等读写）；root = 引擎根。
// 状态机：idle | deferred({deferId, retryAfterMs, until}) | paused({pauseToken, until})。
// 惰性过期：读时比较 until vs now，过期即视为 idle 并清理状态文件——【禁止 setInterval/后台定时器】
//   （维持 N-7 核查：无 redis/bullmq/setInterval；恢复语义 = 惰性过期自动恢复，零命令面/零 HTTP/零 resume 端点）。
// 与 flag-off 折叠 deny 的区分（关键语义，classify P3/P5 flag=false → DENY 无状态副作用）：
//   本模块只被 wiring 在 flag-on 且命中（decision DEFER/PAUSE）或状态门拒绝路径调用；
//   flag-off 折叠 DENY 不触碰状态文件（S6 断言）。
// 内核纯度：纯函数内核（kernel/classify）零 IO；本 JS 触点供 wiring 层调用。
import fs from 'node:fs';
import path from 'node:path';
import { SESSION_RE } from '../state/constants.js';

// 窗口常量（harden-plan §5.2 A.5/A.6「建议默认常量，worker 定并文档化」）：
//   DEFER 延后窗口 30s（数据水合前挂起、稍后自动恢复为可重试状态）；
//   PAUSE 暂停窗口 60s（同 session 任意工具调用被拒，过期自动恢复）。
export const DEFER_RETRY_MS = 30_000;
export const PAUSE_WINDOW_MS = 60_000;

// 状态文件目录：<root>/governance/state/<sessionId>.json（sessionId 缺省 'cli'；目录与 refusals 并列）
// 导出供测试/审计抽查（惰性过期后可改写 until 模拟窗口流逝）
export function stateFileOf(root, sessionId) {
  const sid = String(sessionId ?? 'cli');
  if (!SESSION_RE.test(sid)) throw new Error('invalid sessionId: ' + sessionId);
  return path.join(root, 'governance', 'state', sid + '.json');
}

// 原子写（对齐 receipt-store writeRefusal：tmp + writeFileSync + rename；写失败清理 tmp 后上抛，
//   由 wiring 按观察者纪律 catch → warn，不阻断裁决）。
function writeStateAtomically(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  try {
    const written = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    if (written.status !== state.status) throw new Error('write verify failed: status mismatch');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败忽略 */ }
    throw new Error('state write failed (fail closed): ' + file + ' — ' + String(e?.message ?? e));
  }
}

// 过期判定（纯函数，惰性）：until 缺失/非法/已过 → expired
function isExpired(until, now) {
  if (typeof until !== 'string' || Number.isNaN(Date.parse(until))) return true;
  return Date.parse(until) <= now;
}

// 读会话状态（幂等；惰性过期 = 读时比较 now，过期即清理文件并视为 idle——无定时器，恢复语义自动）。
// 返回：{ status:'idle' } | { status:'deferred', deferId, retryAfterMs, until } | { status:'paused', pauseToken, until }
// 文件缺失/损坏 → idle（损坏文件删除自愈，不阻塞会话）。
export function readSessionState(root, sessionId) {
  const file = stateFileOf(root, sessionId);
  if (!fs.existsSync(file)) return { status: 'idle' };
  let st;
  try {
    st = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // 损坏状态文件：删除自愈（原子写防半成品；解析失败仅异常残留）
    try { fs.unlinkSync(file); } catch { /* 忽略 */ }
    return { status: 'idle' };
  }
  const now = Date.now();
  if (st?.status === 'deferred') {
    if (!isExpired(st.until, now)) {
      return {
        status: 'deferred',
        deferId: typeof st.deferId === 'string' ? st.deferId : '',
        retryAfterMs: typeof st.retryAfterMs === 'number' ? st.retryAfterMs : DEFER_RETRY_MS,
        until: st.until,
      };
    }
  } else if (st?.status === 'paused') {
    if (!isExpired(st.until, now)) {
      return {
        status: 'paused',
        pauseToken: typeof st.pauseToken === 'string' ? st.pauseToken : '',
        until: st.until,
      };
    }
  } else {
    // 未知 status（未来版本兼容/异常写入）→ 视为损坏，清理
    try { fs.unlinkSync(file); } catch { /* 忽略 */ }
    return { status: 'idle' };
  }
  // 过期：清理状态文件（惰性过期自动恢复），返回 idle
  try { fs.unlinkSync(file); } catch { /* 忽略 */ }
  return { status: 'idle' };
}

// 写 DEFER 状态（幂等覆盖）：返回 { deferId, retryAfterMs, until } 供收据 deferMeta 同源落盘。
// retryAfterMs 缺省 = DEFER_RETRY_MS（wiring 触发路径用常量；测试可传短窗口验证过期）。
export function setDeferred(root, sessionId, { deferId, retryAfterMs } = {}) {
  const sid = String(sessionId ?? 'cli');
  const dId = deferId ?? globalThis.crypto.randomUUID(); // node≥19 WebCrypto（标准库内建，kernel.ts 先例）
  const ms = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? retryAfterMs
    : DEFER_RETRY_MS;
  const until = new Date(Date.now() + ms).toISOString();
  writeStateAtomically(stateFileOf(root, sid), { status: 'deferred', deferId: dId, retryAfterMs: ms, until });
  return { deferId: dId, retryAfterMs: ms, until };
}

// 写 PAUSE 状态（幂等覆盖）：返回 { pauseToken, until } 供收据 pauseMeta 同源落盘。
// windowMs 缺省 = PAUSE_WINDOW_MS。
export function setPaused(root, sessionId, { pauseToken, windowMs } = {}) {
  const sid = String(sessionId ?? 'cli');
  const token = pauseToken ?? globalThis.crypto.randomUUID();
  const ms = typeof windowMs === 'number' && Number.isFinite(windowMs) && windowMs > 0
    ? windowMs
    : PAUSE_WINDOW_MS;
  const until = new Date(Date.now() + ms).toISOString();
  writeStateAtomically(stateFileOf(root, sid), { status: 'paused', pauseToken: token, until });
  return { pauseToken: token, until };
}

// 清空会话状态（幂等；文件不存在不抛错）。供测试与恢复清理。
export function clearSessionState(root, sessionId) {
  const file = stateFileOf(root, sessionId);
  try { fs.unlinkSync(file); } catch { /* 不存在忽略（幂等） */ }
}
