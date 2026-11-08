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

// 损坏批次旁路清单
import fs from 'node:fs';
import path from 'node:path';
import { SESSION_RE } from './constants.js';

const CORRUPT_SCHEMA = 1;

export function corruptFileOf(root, sessionId) {
  if (!SESSION_RE.test(sessionId)) throw new Error('invalid sessionId: ' + sessionId);
  return path.join(root, 'sessions', sessionId, 'corrupt-batches.json');
}

export function createCorruptRegistry(root) {
  function readList(sessionId) {
    const file = corruptFileOf(root, sessionId);
    if (!fs.existsSync(file)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(data?.corrupt) ? data.corrupt : [];
    } catch {
      return [];
    }
  }

  function writeList(sessionId, list) {
    const file = corruptFileOf(root, sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ schema: CORRUPT_SCHEMA, corrupt: list }, null, 2));
    fs.renameSync(tmp, file);
  }

  function markBatchCorrupt(sessionId, batchId, error) {
    const list = readList(sessionId);
    if (list.some((c) => c.batchId === batchId)) return { first: false };
    const entry = {
      sessionId,
      batchId,
      file: path.join('sessions', sessionId, 'batches', batchId + '.json'),
      error: String((error && error.message) || error),
      detectedAt: new Date().toISOString(),
    };
    list.push(entry);
    writeList(sessionId, list);
    return { first: true };
  }

  function listCorruptBatches(sessionId) {
    if (sessionId) return readList(sessionId);
    const out = [];
    const sessionsDir = path.join(root, 'sessions');
    if (fs.existsSync(sessionsDir)) {
      for (const s of fs.readdirSync(sessionsDir).sort()) {
        if (!SESSION_RE.test(s)) continue;
        out.push(...readList(s));
      }
    }
    return out;
  }

  function clearCorruptMark(sessionId, batchId) {
    const list = readList(sessionId);
    const next = list.filter((c) => c.batchId !== batchId);
    if (next.length === list.length) return { removed: false };
    writeList(sessionId, next);
    return { removed: true };
  }

  function isCorrupt(sessionId, batchId) {
    return readList(sessionId).some((c) => c.batchId === batchId);
  }

  return { markBatchCorrupt, listCorruptBatches, clearCorruptMark, isCorrupt, corruptFileOf };
}
