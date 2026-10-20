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

// 批次路径解析面（session/batch/artifacts 目录与文件定位 + 存量迁移）——
//   【2026-10-02 · 内务批 波 3】随 `createStore` 巨型函数拆分下沉；
//   依赖方向单向：`store.js`（组合器）→ 本文件，本文件不反向 import 组合器。

import fs from 'node:fs';
import path from 'node:path';
// 路径三族单点（W2/A-3 收敛）：本文件只留单行委托，校验与抛错原文在 batch-paths.js
import { sessionDirOf, artifactsDirOf as artifactsDirOfAt, batchFilePathOf, resolveArtifactIn } from '../batch-paths.js';

export function buildPaths(cx) {
  const { sessionsDir, legacyDir } = cx;

  function sessionDir(sessionId) { return sessionDirOf(sessionsDir, sessionId); }
  function batchesDirOf(sessionId) {
    return path.join(sessionDir(sessionId), 'batches');
  }
  function artifactsDirOf(sessionId, batchId) { return artifactsDirOfAt(sessionsDir, sessionId, batchId); }
  // condition 校验的 fileExists DI（machine 纯逻辑，路径解析在本侧）——声明路径经单点解析，逃逸 ⇒ false（不探根外）
  function conditionFileExists(sessionId, batchId) {
    const artifactsDir = artifactsDirOf(sessionId, batchId);
    return (p) => {
      try { return fs.existsSync(resolveArtifactIn(artifactsDir, p)); } catch { return false; }
    };
  }

  // 存量迁移：root/batches/*.json -> sessions/legacy/batches/（一次，幂等）
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
