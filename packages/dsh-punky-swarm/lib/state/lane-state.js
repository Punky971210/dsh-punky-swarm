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

// lane 状态谓词**单点**（`state` 域）：三谓词自 watch 侧逐字迁入，供 `state/dangling.js` 与
//   watch 侧（经 `lib/watch/lane-heartbeat.js` 保形再导出）共用 ⇒ 拆掉 `state -> watch` 回指边（W4）。
//   谓词体与注释**逐字搬移**（拆环不是修缺陷，行为零变更）。
import * as schema from '../schema.js';

// ---- 状态域（§1.1/§1.2）：扫描面 = 非终态；终态集合与判定单一来源 = lib/schema.js（不硬编码字符串）----
export function laneStateOf(batch, lane) {
  return batch?.lanes?.[lane] ?? null;
}

// ---- 状态域（§1.1/§1.2）：扫描面 = 非终态；终态集合与判定单一来源 = lib/schema.js（不硬编码字符串）----
export function isScannedLaneState(batch, lane) {
  const s = laneStateOf(batch, lane);
  return s !== null && !schema.isMemberTerminal(s);
}

export function isDanglingLane(batch, lane) {
  // 悬挂成员 = 批次**终态** ∧ lane **非终态**（快照式，无阈值；不产候选，不受僵尸批过滤）
  return schema.isBatchTerminal(batch?.phase) && isScannedLaneState(batch, lane);
}
