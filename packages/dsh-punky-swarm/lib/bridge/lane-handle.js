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

// bridge/lane-handle.js —— 派发句柄（lane dispatch handle）：C 档集群派发的**唯一凭证**。
// 用户裁决（2026-09-15）：「**不写 token 即禁止派发**」——token 取代原先「最后一个 member_status 意图」
//   的启发式推断，成为派发与登记的**唯一依据**。
// 生命周期：
//   ① **发放**：Leader 调 `lane_dispatch({ batchId, lane })` → 本模块发一次性句柄（16 hex），
//      并返回**可直接粘贴的一行** `[swarm-lane:<batchId>/<lane>#<token>]`；
//   ② **携带**：Leader 把该行**原样**写进子代理任务包（宿主**不允许 pre-execute 改写 exec.arguments**
//      ⇒ 引擎只能读、不能注入）；
//   ③ **消费**：派发类工具（`subagent`/`subagent_fork`）的 post-execute 由本模块解析该行并**一次性消费**
//      —— 消费成功即以 (batchId, lane) **精确登记** `member.dispatch`（并行 N 条 lane 因此可全登记）；
//   ④ **过期/悬挂**：TTL 30min；过期未消费的句柄由心跳探测报为「意图未消费」（P4）。
// 形态：纯内存、进程内单例（同一引擎实例一份），无 IO、不落盘——登记结果由调用方写批次事件。
import { randomBytes } from 'node:crypto';

/** 句柄有效期（毫秒）：过期即不可消费。 */
export const LANE_HANDLE_TTL_MS = 30 * 60 * 1000;

/** 任务包内携带形态（行内标记，可出现在任意文本字段；推荐**首行**）。 */
const LANE_HANDLE_RE = /\[swarm-lane:([^/\][]+)\/([^#\]]+)#([0-9a-f]{16})\]/;

/** token -> { batchId, lane, sessionId, at, used }（进程内单例）。 */
const handles = new Map();

/** 生成 token（16 hex）。 */
function newToken() {
  return randomBytes(8).toString('hex');
}

/** 任务包内应原样粘贴的一行（唯一推荐形态）。 */
export function firstLineOf(batchId, lane, token) {
  return '[' + 'swarm-lane:' + batchId + '/' + lane + '#' + token + ']';
}

/**
 * 发放句柄：绑定 (batchId, lane, sessionId)，记发放时刻；返回 firstLine 供 Leader 粘贴。
 * @returns {{token: string, firstLine: string, ttlMs: number, at: number}}
 */
export function issueLaneHandle({ batchId, lane, sessionId, now = Date.now() }) {
  const token = newToken();
  handles.set(token, { batchId, lane, sessionId: sessionId ?? null, at: now, used: false });
  return { token, firstLine: firstLineOf(batchId, lane, token), ttlMs: LANE_HANDLE_TTL_MS, at: now };
}

/**
 * 从任意文本（任务包拼接字段）解析出句柄三元组。
 * @returns {{batchId: string, lane: string, token: string} | null}
 */
export function parseLaneHandleFromText(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const m = LANE_HANDLE_RE.exec(text);
  if (!m) return null;
  return { batchId: m[1], lane: m[2], token: m[3] };
}

/**
 * 从派发工具的参数面收集**可扫描文本**（宿主参数形态各异：prompt / description / content / chatMessage…）。
 * 只做浅层字符串收集（含一层数组），避免深递归带来成本与误匹配面。
 */
export function textOfDispatchArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const parts = [];
  const push = (v) => {
    if (typeof v === 'string') { parts.push(v); return; }
    if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') parts.push(x);
  };
  for (const k of ['prompt', 'description', 'content', 'message', 'chatMessage', 'text', 'task']) push(args[k]);
  return parts.join('\n');
}

/** 校验（不改状态）：命中且未过期且未消费 ⇒ ok。 */
export function verifyLaneHandle(token, { batchId = null, lane = null, now = Date.now() } = {}) {
  const h = handles.get(token);
  if (!h) return { ok: false, reason: 'unknown-handle' };
  if (h.used) return { ok: false, reason: 'handle-consumed' };
  if (now - h.at > LANE_HANDLE_TTL_MS) return { ok: false, reason: 'handle-expired' };
  if (batchId !== null && h.batchId !== batchId) return { ok: false, reason: 'batch-mismatch' };
  if (lane !== null && h.lane !== lane) return { ok: false, reason: 'lane-mismatch' };
  return { ok: true, entry: { batchId: h.batchId, lane: h.lane, sessionId: h.sessionId } };
}

/**
 * 一次性消费：成功返回登记所需的 (batchId, lane, sessionId)；重复消费/过期/未知一律拒。
 * @returns {{ok: boolean, reason?: string, entry?: {batchId: string, lane: string, sessionId: string|null}}}
 */
export function consumeLaneHandle(token, opts = {}) {
  const v = verifyLaneHandle(token, opts);
  if (!v.ok) return v;
  handles.get(token).used = true;
  return { ok: true, entry: v.entry };
}

/** 清理过期句柄（供心跳/测试调用）；返回清理条数。 */
export function sweepExpiredHandles(now = Date.now()) {
  let n = 0;
  for (const [k, v] of handles.entries()) {
    if (now - v.at > LANE_HANDLE_TTL_MS) { handles.delete(k); n++; }
  }
  return n;
}

/** 未消费句柄视图（只读；供心跳探测与审计）。 */
export function pendingHandles(now = Date.now()) {
  return [...handles.entries()]
    .filter(([, v]) => !v.used)
    .map(([token, v]) => ({ token, batchId: v.batchId, lane: v.lane, sessionId: v.sessionId, at: v.at, expired: now - v.at > LANE_HANDLE_TTL_MS }));
}

/** 测试专用：清空单例（生产路径不得调用）。 */
export function __resetLaneHandles() {
  handles.clear();
}
