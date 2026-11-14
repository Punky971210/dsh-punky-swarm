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

// 惰性过期：读时比较 until vs now，过期即视为 idle 并清理状态文件——【禁止 setInterval/后台定时器】
//   （无 redis/bullmq/setInterval；恢复语义 = 惰性过期自动恢复，零命令面/零 HTTP/零 resume 端点）。
import fs from 'node:fs';
import path from 'node:path';
import { SESSION_RE } from '../state/constants.js';

export const DEFER_RETRY_MS = 30_000;
export const PAUSE_WINDOW_MS = 60_000;

export function stateFileOf(root, sessionId) {
  const sid = String(sessionId ?? 'cli');
  if (!SESSION_RE.test(sid)) throw new Error('invalid sessionId: ' + sessionId);
  return path.join(root, 'governance', 'state', sid + '.json');
}

function writeStateAtomically(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  try {
    const written = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    if (written.status !== state.status) throw new Error('write verify failed: status mismatch');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {  }
    throw new Error('state write failed (fail closed): ' + file + ' — ' + String(e?.message ?? e));
  }
}

function isExpired(until, now) {
  if (typeof until !== 'string' || Number.isNaN(Date.parse(until))) return true;
  return Date.parse(until) <= now;
}

export function readSessionState(root, sessionId) {
  const file = stateFileOf(root, sessionId);
  if (!fs.existsSync(file)) return { status: 'idle' };
  let st;
  try {
    st = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    try { fs.unlinkSync(file); } catch {  }
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
    try { fs.unlinkSync(file); } catch {  }
    return { status: 'idle' };
  }
  try { fs.unlinkSync(file); } catch {  }
  return { status: 'idle' };
}

export function setDeferred(root, sessionId, { deferId, retryAfterMs } = {}) {
  const sid = String(sessionId ?? 'cli');
  const dId = deferId ?? globalThis.crypto.randomUUID();
  const ms = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? retryAfterMs
    : DEFER_RETRY_MS;
  const until = new Date(Date.now() + ms).toISOString();
  writeStateAtomically(stateFileOf(root, sid), { status: 'deferred', deferId: dId, retryAfterMs: ms, until });
  return { deferId: dId, retryAfterMs: ms, until };
}

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

