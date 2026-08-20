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

// O_EXCL 单写者锁（最小可行）：原子创建锁文件，冲突先拒绝（wait/force 可选）
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function acquire(lockPath, { waitMs = 0, pollMs = 50, force = false } = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify({ token, ts: Date.now(), pid: process.pid }));
      fs.closeSync(fd);
      return { ok: true, token, lockPath };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (force) {
        try { fs.unlinkSync(lockPath); } catch {}
        continue;
      }
      if (Date.now() >= deadline) {
        return { ok: false, conflict: true, lockPath };
      }
      await sleep(Math.max(10, pollMs));
    }
  }
}

export function release(lockPath, token) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const cur = JSON.parse(raw);
    // 仅当持有者 token 匹配时释放（防 force 接管后误释放）
    if (token && cur.token !== token) return { ok: false, reason: 'token-mismatch' };
    fs.unlinkSync(lockPath);
    return { ok: true };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true };
    throw e;
  }
}

export function isLocked(lockPath) {
  return fs.existsSync(lockPath);
}

export function lockFileName(batchId) {
  return path.join('.locks', batchId + '.lock');
}
