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

// 文件 mailbox：worker <-> supervisor 异步通信（原子写 + ack），不共享上下文
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const LANE_RE = /^[a-zA-Z0-9._-]+$/;

export function sanitizeLane(lane) {
  if (!lane || !LANE_RE.test(lane)) throw new Error('invalid lane: ' + String(lane));
  return lane;
}

// box: { type: 'inbox' | 'outbox' | 'broadcast', lane?: string }
export function boxDir(root, box) {
  if (box.type === 'inbox') return path.join(root, 'supervisor', 'inbox');
  if (box.type === 'broadcast') return path.join(root, 'broadcast');
  if (box.type === 'outbox') {
    return path.join(root, sanitizeLane(box.lane), 'outbox');
  }
  throw new Error('unknown mailbox type: ' + String(box.type));
}

function ackDir(dir) {
  return path.join(dir, '.acks');
}

// 发送：原子写消息文件，返回 ackId（文件名）
export function send(root, box, message, meta = null) {
  const dir = boxDir(root, box);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(ackDir(dir), { recursive: true });
  const ackId = Date.now().toString(36) + '-' + randomUUID().slice(0, 8) + '.json';
  const payload = {
    ackId,
    ts: new Date().toISOString(),
    box,
    message,
    meta: meta ?? null,
  };
  const tmp = path.join(dir, '.' + ackId + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, path.join(dir, ackId));
  return { ok: true, ackId };
}

export function readUnacked(root, box, { sinceTs = 0 } = {}) {
  const dir = boxDir(root, box);
  if (!fs.existsSync(dir)) return [];
  const acked = new Set();
  if (fs.existsSync(ackDir(dir))) {
    for (const f of fs.readdirSync(ackDir(dir))) acked.add(f.replace(/\.acked$/, ''));
  }
  const items = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (f.startsWith('.') || acked.has(f)) continue;
    try {
      const p = path.join(dir, f);
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      const ts = Date.parse(data.ts ?? 0) || 0;
      if (ts >= sinceTs) items.push(data);
    } catch {
      // 跳过损坏消息（不阻塞）
    }
  }
  return items;
}

export function ack(root, box, ackId) {
  const dir = boxDir(root, box);
  if (!ackId || typeof ackId !== 'string' || ackId.includes('..')) throw new Error('invalid ackId');
  fs.mkdirSync(ackDir(dir), { recursive: true });
  fs.writeFileSync(path.join(ackDir(dir), ackId + '.acked'), JSON.stringify({ ackedAt: new Date().toISOString() }));
  return { ok: true, ackId };
}

export function isAcked(root, box, ackId) {
  return fs.existsSync(path.join(ackDir(boxDir(root, box)), ackId + '.acked'));
}
