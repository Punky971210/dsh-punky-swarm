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


import fs from 'node:fs';
import path from 'node:path';
import { sessionDirOf, artifactsDirOf as artifactsDirOfAt, batchFilePathOf, resolveArtifactIn } from '../batch-paths.js';

export function buildPaths(cx) {
  const { sessionsDir, legacyDir } = cx;

  function sessionDir(sessionId) { return sessionDirOf(sessionsDir, sessionId); }
  function batchesDirOf(sessionId) {
    return path.join(sessionDir(sessionId), 'batches');
  }
  function artifactsDirOf(sessionId, batchId) { return artifactsDirOfAt(sessionsDir, sessionId, batchId); }
  function conditionFileExists(sessionId, batchId) {
    const artifactsDir = artifactsDirOf(sessionId, batchId);
    return (p) => {
      try { return fs.existsSync(resolveArtifactIn(artifactsDir, p)); } catch { return false; }
    };
  }

  function migrateLegacy() {
    if (!fs.existsSync(legacyDir)) return 0;
    let moved = 0;
    for (const f of fs.readdirSync(legacyDir)) {
      if (!f.endsWith('.json')) continue;
      const dst = path.join(batchesDirOf('legacy'), f);
      fs.mkdirSync(batchesDirOf('legacy'), { recursive: true });
      fs.renameSync(path.join(legacyDir, f), dst);
      moved++;
    }
    try { fs.rmdirSync(legacyDir); } catch {}
    return moved;
  }

  function batchFile(sessionId, batchId) { return batchFilePathOf(sessionsDir, sessionId, batchId); }

  return { sessionDir, batchesDirOf, artifactsDirOf, conditionFileExists, migrateLegacy, batchFile };
}
