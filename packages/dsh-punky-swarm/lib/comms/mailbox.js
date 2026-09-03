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

// 损坏消息 quarantine 目录（④，D-005）：<boxDir>/.quarantine/，保留现场供人工检视
export function quarantineDir(dir) {
  return path.join(dir, '.quarantine');
}

const DEFAULT_SWEEP_TTL_MS = 7 * 24 * 60 * 60 * 1000; // ack 标记保留期（默认 7d）
const DEFAULT_QUARANTINE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // quarantine 保留期（默认 30d）

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

export function ack(root, box, ackId, { pruneOnAck = true } = {}) {
  const dir = boxDir(root, box);
  if (!ackId || typeof ackId !== 'string' || ackId.includes('..')) throw new Error('invalid ackId');
  fs.mkdirSync(ackDir(dir), { recursive: true });
  fs.writeFileSync(path.join(ackDir(dir), ackId + '.acked'), JSON.stringify({ ackedAt: new Date().toISOString() }));
  if (pruneOnAck) {
    // ack 即删原消息文件（④，D-004，默认开；pruneOnAck:false 保留，保兼容）：
    // 删除失败仅记录不 throw——.acked 已写，readUnacked 仍跳过该消息（INV-6），残留交下次 sweep 按 TTL 清
    try {
      const msgFile = path.join(dir, ackId);
      if (fs.existsSync(msgFile)) fs.unlinkSync(msgFile);
    } catch { /* 保留现场，sweep 兜底 */ }
  }
  return { ok: true, ackId };
}

export function isAcked(root, box, ackId) {
  return fs.existsSync(path.join(ackDir(boxDir(root, box)), ackId + '.acked'));
}

// ---- 滞留清理（④，T-CODE-4）：ack 标记 TTL sweep + 损坏消息 quarantine + 孤儿 .acked 清理 ----
// sweep(root, { ttlMs=7d, quarantineTtlMs=30d, now })：遍历 root 下全部 box 目录（supervisor/inbox、
// broadcast、<lane>/outbox）：
//   - acked 且标记超 TTL → 删消息文件 + 删 .acked 标记（消息删除失败则标记保留，下轮 sweep 重试）
//   - 损坏消息（JSON.parse 失败）→ 移 .quarantine/（保留现场）；quarantine 内文件按 quarantineTtlMs 清
//   - 孤儿 .acked（无对应消息文件）→ 按 TTL 删标记
//   - 未 ack 未超期消息 → 不动（保守，D-005：仅记录不删）
// 幂等可重入（INV-7）：无状态全量扫描；单文件失败 catch 跳过 + failed 计数，不中断。
// 返回 { scanned, removed, quarantined, failed }；readUnacked/isAcked/send 语义零变化。
function boxDirs(root) {
  const dirs = [];
  if (!fs.existsSync(root)) return dirs;
  const supervisor = path.join(root, 'supervisor', 'inbox');
  if (fs.existsSync(supervisor)) dirs.push(supervisor);
  const broadcast = path.join(root, 'broadcast');
  if (fs.existsSync(broadcast)) dirs.push(broadcast);
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith('.')) continue;
    if (name === 'supervisor' || name === 'broadcast') continue;
    const ob = path.join(root, name, 'outbox');
    if (fs.existsSync(ob)) dirs.push(ob);
  }
  return dirs;
}

function sweepBoxDir(dir, stats, { ttlMs, quarantineTtlMs, now }) {
  if (!fs.existsSync(dir)) return;
  const acksPath = ackDir(dir);
  const acked = new Map(); // ackId -> ackedAt(ms)（.acked 内容 ackedAt；损坏标记按 mtime 兜底）
  if (fs.existsSync(acksPath)) {
    for (const f of fs.readdirSync(acksPath)) {
      if (!f.endsWith('.acked')) continue;
      const ackId = f.slice(0, -6);
      let ackedAt = null;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(acksPath, f), 'utf8'));
        ackedAt = Date.parse(data.ackedAt) || null;
      } catch { /* 标记损坏 → mtime 兜底 */ }
      if (!ackedAt) {
        try { ackedAt = fs.statSync(path.join(acksPath, f)).mtimeMs; } catch { ackedAt = 0; }
      }
      acked.set(ackId, ackedAt);
    }
  }
  // 1) 消息文件：acked 且超 TTL → 删消息+删标记；损坏 → quarantine；未 ack 未超期 → 不动
  for (const f of fs.readdirSync(dir).sort()) {
    if (f.startsWith('.')) continue;
    const p = path.join(dir, f);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (!st.isFile()) continue;
    stats.scanned++;
    const ackedAt = acked.get(f);
    if (ackedAt !== undefined) {
      if (now - ackedAt >= ttlMs) {
        try {
          fs.unlinkSync(p);
          stats.removed++;
          // SHOULD-FIX-1：仅消息删除成功才删 .acked 标记（删除顺序不变：先消息后标记）。
          // 消息 unlink 失败时标记保留——.acked 继续保护 readUnacked 不重复暴露已消费消息，
          // 消息留待下轮 sweep 重试（与 ack() 路径『.acked 先写，删除失败 sweep 兜底』意图一致）。
          try { fs.unlinkSync(path.join(acksPath, f + '.acked')); } catch { /* 标记可能已删 */ }
          acked.delete(f);
        } catch { stats.failed++; /* 消息删除失败：保留 .acked 标记，下轮 sweep 重试 */ }
      }
      // acked 未超期：消息与标记均保留（readUnacked 仍跳过）
      continue;
    }
    // 未 ack：损坏消息 → quarantine（保留现场）
    try {
      JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      try {
        const q = quarantineDir(dir);
        fs.mkdirSync(q, { recursive: true });
        fs.renameSync(p, path.join(q, f));
        stats.quarantined++;
      } catch { stats.failed++; }
      continue;
    }
    // 未 ack 未超期 → 不动（D-005：保守，仅记录）
  }
  // 2) 孤儿 .acked（无对应消息文件）→ 按 TTL 删标记
  for (const [ackId, ackedAt] of acked) {
    if (fs.existsSync(path.join(dir, ackId))) continue; // 有对应消息：acked 超 TTL 已在 1) 处理
    if (now - ackedAt >= ttlMs) {
      try { fs.unlinkSync(path.join(acksPath, ackId + '.acked')); stats.removed++; } catch { stats.failed++; }
    }
  }
  // 3) quarantine TTL：q 内文件 mtime 超 quarantineTtlMs → 删
  const q = quarantineDir(dir);
  if (fs.existsSync(q)) {
    for (const f of fs.readdirSync(q)) {
      if (f.startsWith('.')) continue;
      const p = path.join(q, f);
      try {
        if (now - fs.statSync(p).mtimeMs >= quarantineTtlMs) { fs.unlinkSync(p); stats.removed++; }
      } catch { stats.failed++; }
    }
  }
}

export function sweep(root, { ttlMs = DEFAULT_SWEEP_TTL_MS, quarantineTtlMs = DEFAULT_QUARANTINE_TTL_MS, now = Date.now() } = {}) {
  const stats = { scanned: 0, removed: 0, quarantined: 0, failed: 0 };
  for (const dir of boxDirs(root)) {
    try { sweepBoxDir(dir, stats, { ttlMs, quarantineTtlMs, now }); } catch { stats.failed++; }
  }
  return stats;
}
