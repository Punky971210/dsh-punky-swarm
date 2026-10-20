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

// 批次路径**单点**（`state` 域）：会话目录 / 产物目录 / 批次文件三族路径原先在
//   `state/archive.js`、`state/store/paths.js`、`state/gates/helpers.ts`、`tools/log-tools.js`
//   四处各持一份实现（含校验与抛错原文）⇒ 本波收敛于此，四处只留单行委托（W2 / A-3）。
// 契约：`sessionsDir` 显式入参（调用方自持闭包根）；`sessionId` 校验失败抛 `invalid sessionId: <id>`；
//   `batchFilePathOf` 校验失败抛 `invalid batchId`（不回显 id）；`artifactsDirOf` 不校验 batchId（与四处现状一致）。
import path from 'node:path';
import { SESSION_RE } from './constants.js';
// 根内判据**复用**（D 轨 WD-3a）：`presence.ts` 的根内判定是唯一实现，禁止在此复制第二份
import { isInsideRoot } from './gates/presence.js';

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

/**
 * 产物声明路径解析（**声明解析唯一入口**，fail-closed；D 轨 WD-3a）：
 *   · 合法声明（相对路径 / 根内绝对路径）⇒ 返回绝对路径（与旧式
 *     `isAbsPath(p) ? p : path.join(artifactsDir, p)` 语义等价，仅多一次路径规范化）；
 *   · 声明面非法（根外绝对路径 / `..` 逃逸 / 命名空间外逃逸）⇒ **throw**
 *     `artifact path escapes batch root: <rel>`（R-4 声明期口径）；
 *   · **不判存在性**：合法但未落盘 ⇒ 原样返回，由消费点沿用既有 missing 语义（R-4 运行期口径）。
 * 根内判据**复用** `presence.ts` 的根内判定（不复制第二份逻辑）。
 */
export function resolveArtifactIn(artifactsDir, rel) {
  const abs = path.resolve(artifactsDir, rel);
  if (!isInsideRoot(abs, artifactsDir)) throw new Error('artifact path escapes batch root: ' + rel);
  return abs;
}
