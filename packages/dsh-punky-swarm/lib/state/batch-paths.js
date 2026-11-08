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

//   `state/archive.js`、`state/store/paths.js`、`state/gates/helpers.ts`、`tools/log-tools.js`
import fs from 'node:fs';
import path from 'node:path';
import { SESSION_RE } from './constants.js';
// 根内判据**复用**（D 轨 WD-3a）：`presence.ts` 的根内判定是唯一实现，禁止在此复制第二份
import { isInsideRoot, isInsideRootResolved } from './gates/presence.js';

export function engineRootOf(sessionsDir) {
  return sessionsDir ? path.dirname(sessionsDir) : null;
}

export function sessionDirOf(sessionsDir, sessionId) {
  if (!SESSION_RE.test(sessionId)) throw new Error('invalid sessionId: ' + sessionId);
  return path.join(sessionsDir, sessionId);
}

export function artifactsDirOf(sessionsDir, sessionId, batchId) {
  return path.join(sessionDirOf(sessionsDir, sessionId), 'artifacts', batchId);
}

export function batchFilePathOf(sessionsDir, sessionId, batchId) {
  if (!SESSION_RE.test(batchId)) throw new Error('invalid batchId');
  return path.join(sessionDirOf(sessionsDir, sessionId), 'batches', batchId + '.json');
}

export function isArtifactInRoot(artifactsRoot, absPath) {
  if (!isInsideRoot(absPath, artifactsRoot)) return false;
  if (!fs.existsSync(absPath)) return true;
  return isInsideRootResolved(absPath, artifactsRoot);
}

export function resolveWriteTargetIn(artifactsDir, absTarget) {
  const abs = path.resolve(absTarget);
  if (!isInsideRoot(abs, artifactsDir)) throw new Error('writeTo escapes artifacts dir: ' + abs);
  if (!isInsideRootResolved(abs, artifactsDir, { allowMissing: true })) {
    throw new Error('writeTo escapes artifacts dir: ' + abs);
  }
  return abs;
}

export function resolveArtifactIn(artifactsDir, rel) {
  const abs = path.resolve(artifactsDir, rel);
  if (!isArtifactInRoot(artifactsDir, abs)) throw new Error('artifact path escapes batch root: ' + rel);
  return abs;
}
