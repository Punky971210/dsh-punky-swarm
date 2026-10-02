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
import { SESSION_RE, isAbsPath } from '../constants.js'; // 单点（原本文件定义迁出）

export function buildPaths(cx) {
  const { sessionsDir, legacyDir } = cx;

  function sessionDir(sessionId) {
    if (!SESSION_RE.test(sessionId)) throw new Error('invalid sessionId: ' + sessionId);
    return path.join(sessionsDir, sessionId);
  }
  function batchesDirOf(sessionId) {
    return path.join(sessionDir(sessionId), 'batches');
  }
  function artifactsDirOf(sessionId, batchId) {
    return path.join(sessionDir(sessionId), 'artifacts', batchId);
  }
  // condition 校验的 fileExists DI（machine 纯逻辑，路径解析在本侧）——相对路径解析到批次产物根，绝对路径直接用；存在性判定（existsSync）
  function conditionFileExists(sessionId, batchId) {
    const artifactsDir = artifactsDirOf(sessionId, batchId);
    return (p) => fs.existsSync(isAbsPath(p) ? p : path.join(artifactsDir, p));
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

  function batchFile(sessionId, batchId) {
    if (!SESSION_RE.test(batchId)) throw new Error('invalid batchId');
    return path.join(batchesDirOf(sessionId), batchId + '.json');
  }

  return { sessionDir, batchesDirOf, artifactsDirOf, conditionFileExists, migrateLegacy, batchFile };
}
