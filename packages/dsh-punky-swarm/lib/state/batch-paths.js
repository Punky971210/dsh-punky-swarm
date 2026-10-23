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
import fs from 'node:fs';
import path from 'node:path';
import { SESSION_RE } from './constants.js';
// 根内判据**复用**（D 轨 WD-3a）：`presence.ts` 的根内判定是唯一实现，禁止在此复制第二份
import { isInsideRoot, isInsideRootResolved } from './gates/presence.js';

/**
 * 引擎根推导**单点**（A2-G08）：`sessionsDir` → 引擎根（= 其父目录）。
 * 原两处各自对 `store.sessionsDir` 取父目录（`watch/heartbeat/context.js` 推导 `engineRoot`、
 *   `bridge/trajectory.js` 取 mailbox 落盘根）⇒ 收成一份；逆向（引擎根 → `<root>/sessions`）仍由
 *   各消费方既有 `path.join(root,'sessions')` 承担，**不在本函数内**。
 * 未提供 `sessionsDir`（如裸 store 桩）⇒ `null`（由消费方沿用既有 null 语义）。
 */
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

/**
 * 根内判据「**存在驱动**」单点（A1-P1-03 · F2；声明/运行期通用）：
 *   · 词法档**必过**（既有拒绝面逐字保留：`..` / 根外绝对 / 跨盘盘符 / UNC）；
 *   · **已落盘**⇒ 追加解权档（`isInsideRootResolved`）：根内 junction/软链指向根外 ⇒ `false`（修到的缺陷面）；
 *   · **未落盘**⇒ `true`：由消费点沿用既有 missing 语义（`GATE_ARTIFACT_MISSING` 等，**码不变**，
 *     规格 §2.2/非目标 4：不把「声明了但未落盘」改成 escape 判）。
 * 「存在驱动」策略**只此一处**（`resolveArtifactIn` / `detectGate` 等消费点都调本函数，不复制）。
 */
export function isArtifactInRoot(artifactsRoot, absPath) {
  if (!isInsideRoot(absPath, artifactsRoot)) return false;
  if (!fs.existsSync(absPath)) return true; // 未落盘：missing 语义归消费点
  return isInsideRootResolved(absPath, artifactsRoot); // 已落盘：软链逃逸必拒
}

/**
 * **写面**根内判据单点（A1-P1-03 波及面 · F2）：目标可能尚不存在。
 *   · 词法档必过 ⇒ 否则 throw `writeTo escapes artifacts dir: <abs>`；
 *   · 解权档以 `allowMissing` 档判：解权「最近既有祖先」+ 剩余段 ⇒ 根内 junction/软链指向根外必拒；
 *   · 文案复用既有族（零新码）：与 `lib/tools/log-tools.js` 的 `writeTo escapes artifacts dir:` 同族。
 */
export function resolveWriteTargetIn(artifactsDir, absTarget) {
  const abs = path.resolve(absTarget);
  if (!isInsideRoot(abs, artifactsDir)) throw new Error('writeTo escapes artifacts dir: ' + abs);
  if (!isInsideRootResolved(abs, artifactsDir, { allowMissing: true })) {
    throw new Error('writeTo escapes artifacts dir: ' + abs);
  }
  return abs;
}

/**
 * 产物声明路径解析（**声明解析唯一入口**，fail-closed；D 轨 WD-3a）：
 *   · 合法声明（相对路径 / 根内绝对路径）⇒ 返回绝对路径（与旧式
 *     `isAbsPath(p) ? p : path.join(artifactsDir, p)` 语义等价，仅多一次路径规范化）；
 *   · 声明面非法（根外绝对路径 / `..` 逃逸 / 命名空间外逃逸 / **已落盘且解权后出根**）⇒ **throw**
 *     `artifact path escapes batch root: <rel>`（R-4 声明期口径；文案逐字未变）；
 *   · **不判存在性**：合法但未落盘 ⇒ 原样返回，由消费点沿用既有 missing 语义（R-4 运行期口径）。
 * 根内判据**复用**「存在驱动」单点 `isArtifactInRoot`（不复制第二份逻辑）。
 */
export function resolveArtifactIn(artifactsDir, rel) {
  const abs = path.resolve(artifactsDir, rel);
  if (!isArtifactInRoot(artifactsDir, abs)) throw new Error('artifact path escapes batch root: ' + rel);
  return abs;
}
