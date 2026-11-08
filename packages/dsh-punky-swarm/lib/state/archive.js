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

// Archive：done→archive——complete 后自动归档、单向（产物打包保留可查 + 不可回滚标记）
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { migrateV2toV3 } from './schema-v3.js';
import { sessionDirOf, artifactsDirOf as artifactsDirOfAt, batchFilePathOf } from './batch-paths.js';
import { SESSION_RE } from './constants.js';
import * as EVT from './event-types.js';

export function createArchive(root, deps = {}) {
  const sessionsDir = path.join(root, 'sessions');
  const commitBatch = typeof deps.commitBatch === 'function' ? deps.commitBatch : null;
  const writeBatchJson = (sessionId, batchId, batch) => {
    if (commitBatch) return commitBatch(sessionId, batchId, batch);
    return atomicWrite(batchFileOf(sessionId, batchId), batch);
  };

  function sessionDir(sessionId) { return sessionDirOf(sessionsDir, sessionId); }
  function batchFileOf(sessionId, batchId) { return batchFilePathOf(sessionsDir, sessionId, batchId); }
  function artifactsDirOf(sessionId, batchId) { return artifactsDirOfAt(sessionsDir, sessionId, batchId); }
  function archiveDirOf(sessionId, batchId) {
    return path.join(sessionDir(sessionId), 'archive', batchId);
  }
  function manifestFileOf(sessionId, batchId) {
    return path.join(archiveDirOf(sessionId, batchId), 'manifest.json');
  }

  function readBatch(sessionId, batchId) {
    const file = batchFileOf(sessionId, batchId);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }
  function atomicWrite(file, data) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  function readManifest(sessionId, batchId) {
    const file = manifestFileOf(sessionId, batchId);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  function listArchived(sessionId) {
    const dir = path.join(sessionDir(sessionId), 'archive');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => SESSION_RE.test(f) && fs.existsSync(path.join(dir, f, 'manifest.json')))
      .sort();
  }

  function sha256Of(file) {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  function collectArtifacts(dir) {
    const out = [];
    const walk = (d, rel) => {
      for (const name of fs.readdirSync(d)) {
        const abs = path.join(d, name);
        const relPath = rel ? rel + '/' + name : name;
        const st = fs.statSync(abs);
        if (st.isDirectory()) walk(abs, relPath);
        else if (st.isFile()) out.push({ path: relPath, size: st.size, sha256: sha256Of(abs) });
      }
    };
    walk(dir, '');
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  function recordFailure(sessionId, batchId, reason) {
    try {
      const b = readBatch(sessionId, batchId);
      if (!b) return;
      const nb = migrateV2toV3(b);
      nb.events = nb.events ?? [];
      nb.events.push({ ts: new Date().toISOString(), type: EVT.EVT_ARCHIVE_FAILED, reason });
      nb.updatedAt = new Date().toISOString();
      writeBatchJson(sessionId, batchId, nb);
    } catch {  }
  }

  function archiveBatch(sessionId, batchId) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    const next = migrateV2toV3(batch);
    if (next.archived === true) return readManifest(sessionId, batchId) ?? { batchId, sessionId, archived: true };
    const existing = readManifest(sessionId, batchId);
    if (existing) return existing;

    const srcDir = artifactsDirOf(sessionId, batchId);
    if (!fs.existsSync(srcDir)) {
      recordFailure(sessionId, batchId, 'artifacts dir missing: ' + srcDir);
      return { ok: false, reason: 'artifacts dir missing: ' + srcDir };
    }
    try {
      const dstDir = archiveDirOf(sessionId, batchId);
      fs.cpSync(srcDir, dstDir, { recursive: true });
      const artifacts = collectArtifacts(dstDir);
      const archivedAt = new Date().toISOString();
      const manifest = {
        batchId,
        sessionId,
        archivedAt,
        schema: next.schema,
        phase: next.phase,
        wavePlan: { waves: (next.wavePlan ?? []).length, lanes: Object.keys(next.lanes ?? {}).length },
        lanes: { ...(next.lanes ?? {}) },
        artifacts,
        eventCount: (next.events ?? []).length,
      };
      atomicWrite(manifestFileOf(sessionId, batchId), manifest);
      // 单向标记：批次 JSON 置 archived:true + archive.done 事件（无 unarchive 入口 = 不可回滚）
      next.archived = true;
      next.events = next.events ?? [];
      next.events.push({ ts: archivedAt, type: EVT.EVT_ARCHIVE_DONE, archivedAt });
      next.updatedAt = archivedAt;
      writeBatchJson(sessionId, batchId, next);
      return manifest;
    } catch (err) {
      recordFailure(sessionId, batchId, String((err && err.message) || err));
      return { ok: false, reason: String((err && err.message) || err) };
    }
  }

  return { archiveBatch, readManifest, listArchived };
}
