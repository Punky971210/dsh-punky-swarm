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

// state/dangling.js —— **悬挂成员告警单点**（GAP-S3b；P3a control lane 复用）。
//
// 背景：批被 `abort` 时若仍有非终态成员，那些成员**永久无法回收**（`member_settle` 拒 `GATE_BATCH_TERMINAL`），
//   `batch_status.danglingLanes` 会永久显示它们。裁决（2026-09-16）＝**不自动改成员状态**（不做隐式批量
//   `skipped`），只额外落一条告警事件 + 工具返回回显，把既有事实显式化。
//
// 为什么独立成模块（本 lane 的**抽取**动作，非复制）：
//   ① 原实现内联在 `lib/tools/core.js` 的 `batch_phase` execute 内；P3a 新增的 `batch_control(abort)`
//      必须**复用同一语义**（任务包硬要求「不得复制第二份实现，必要时抽共享 helper 并写明落点」）；
//   ② 抽出后消费方 = `batch_phase`（工具面）与 `batch_control`（工具面）——以后任何 abort 入口都指这一份。
//
// 判据**零新口径**（逐字沿用原实现）：
//   · lane 级判定 = `isDanglingLane(batch, lane)`（`lib/watch/lane-heartbeat.js`，语义 = 批次终态 ∧ lane 非终态；
//     与 `batch_status.danglingLanes` **同一实现、同一语义**）；
//   · lane 名单口径 = `Object.keys(batch.lanes)`（与 `batch_status` 的 `derivedOf` 同源）。
//
// 纪律：本模块**绝不改成员状态**（`batch.lanes` 前后逐字不变）——只读判定 + 落一条事件。
import { isDanglingLane } from '../watch/lane-heartbeat.js';
import { EVT_BATCH_ABORT_DANGLING } from './event-types.js';

/** 悬挂成员名单（纯函数）：批次终态 ∧ lane 非终态的 lane id 列表。 */
export function danglingLanesOf(batch) {
  return Object.keys(batch?.lanes ?? {}).filter((lane) => isDanglingLane(batch, lane));
}

/** abort 告警落点（单点）：**仅**在批相位为终态且存在悬挂成员时落 `batch.abort_dangling`。
 *  返回 `null`（无悬挂 ⇒ 调用方不写键、零事件）或 `{ danglingLanes, count }`（调用方回显）。
 *  **不改任何成员状态**；调用方负责把返回值并入工具出参。 */
export function warnAbortDangling(store, sessionId, batchId, batch) {
  if (batch?.phase !== 'aborted') return null; // 只有 aborted 相位触发（running/paused/complete 相位面零差异）
  const danglingLanes = danglingLanesOf(batch);
  if (danglingLanes.length === 0) return null;  // 无悬挂成员 ⇒ 不落事件、不写键（反例锁）
  store.appendEvent(sessionId, batchId, EVT_BATCH_ABORT_DANGLING, { danglingLanes, count: danglingLanes.length });
  return { danglingLanes, count: danglingLanes.length };
}
