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

//   ② **携带**：Leader 把该行**原样**写进子代理任务包（宿主**不允许 pre-execute 改写 exec.arguments**
//      ⇒ 引擎只能读、不能注入）；
import { randomBytes } from 'node:crypto';

export const LANE_HANDLE_TTL_MS = 30 * 60 * 1000;

const LANE_HANDLE_RE = /\[swarm-lane:([^/\][]+)\/([^#\]]+)#([0-9a-f]{16})\]/;

const handles = new Map();

function newToken() {
  return randomBytes(8).toString('hex');
}

export function firstLineOf(batchId, lane, token) {
  return '[' + 'swarm-lane:' + batchId + '/' + lane + '#' + token + ']';
}

export function issueLaneHandle({ batchId, lane, sessionId, now = Date.now() }) {
  const token = newToken();
  handles.set(token, { batchId, lane, sessionId: sessionId ?? null, at: now, used: false });
  return { token, firstLine: firstLineOf(batchId, lane, token), ttlMs: LANE_HANDLE_TTL_MS, at: now };
}

export function parseLaneHandleFromText(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const m = LANE_HANDLE_RE.exec(text);
  if (!m) return null;
  return { batchId: m[1], lane: m[2], token: m[3] };
}

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

export function verifyLaneHandle(token, { batchId = null, lane = null, now = Date.now() } = {}) {
  const h = handles.get(token);
  if (!h) return { ok: false, reason: 'unknown-handle' };
  if (h.used) return { ok: false, reason: 'handle-consumed' };
  if (now - h.at > LANE_HANDLE_TTL_MS) return { ok: false, reason: 'handle-expired' };
  if (batchId !== null && h.batchId !== batchId) return { ok: false, reason: 'batch-mismatch' };
  if (lane !== null && h.lane !== lane) return { ok: false, reason: 'lane-mismatch' };
  return { ok: true, entry: { batchId: h.batchId, lane: h.lane, sessionId: h.sessionId } };
}

export function consumeLaneHandle(token, opts = {}) {
  const v = verifyLaneHandle(token, opts);
  if (!v.ok) return v;
  handles.get(token).used = true;
  return { ok: true, entry: v.entry };
}


export function pendingHandles(now = Date.now()) {
  return [...handles.entries()]
    .filter(([, v]) => !v.used)
    .map(([token, v]) => ({ token, batchId: v.batchId, lane: v.lane, sessionId: v.sessionId, at: v.at, expired: now - v.at > LANE_HANDLE_TTL_MS }));
}

export function __resetLaneHandles() {
  handles.clear();
}
