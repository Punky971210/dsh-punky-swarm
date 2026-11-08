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

//      必须**复用同一语义**（任务包硬要求「不得复制第二份实现，必要时抽共享 helper 并写明落点」）；
import { isDanglingLane } from './lane-state.js';
import { EVT_BATCH_ABORT_DANGLING } from './event-types.js';

/** 悬挂成员名单（纯函数）：批次终态 ∧ lane 非终态的 lane id 列表。 */
export function danglingLanesOf(batch) {
  return Object.keys(batch?.lanes ?? {}).filter((lane) => isDanglingLane(batch, lane));
}

/** abort 告警落点（单点）：**仅**在批相位为终态且存在悬挂成员时落 `batch.abort_dangling`。
 *  **不改任何成员状态**；调用方负责把返回值并入工具出参。 */
export function warnAbortDangling(store, sessionId, batchId, batch) {
  if (batch?.phase !== 'aborted') return null;
  const danglingLanes = danglingLanesOf(batch);
  if (danglingLanes.length === 0) return null;
  store.appendEvent(sessionId, batchId, EVT_BATCH_ABORT_DANGLING, { danglingLanes, count: danglingLanes.length });
  return { danglingLanes, count: danglingLanes.length };
}
