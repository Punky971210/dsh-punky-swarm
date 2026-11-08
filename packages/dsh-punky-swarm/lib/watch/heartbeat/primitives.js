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

import { findTask } from '../../state/task-utils.js'; // 单点（原本地定义删除）
import * as EVT from '../../state/event-types.js';
import { laneStateOf, isScannedLaneState } from '../../state/lane-state.js'; // 谓词真源（不走聚合器中转）
// A1-P2-01 补丁①：`reason` 常量与 `STATE_WINDOW_KEY` 已下沉到**零依赖叶子** `./reasons.js`
//   （TDZ 根因：`heartbeat/notice.js` 在模块顶层读这些 `const`，而本文件位于 9 模块环内）。
//   此处**保形再导出**（导出面冻结：`lane-heartbeat.js` / `state-surface.js` 等既有消费点逐字不动）。
import {
  REASON_DANGLING_MEMBER, REASON_NOT_SCANNED_PLANNING, REASON_PAUSED_DWELL,
  REASON_PENDING_UNDISPATCHED, REASON_REVIEW_AWAITING_SETTLE, REASON_IDLE_AWAITING_RESUME,
  REASON_BLIND_RUN_NO_DEPS, REASON_BLIND_RUN_UPSTREAM_MISSING, REASON_BLIND_RUN_UPSTREAM_NEVER_READY,
  STATE_WINDOW_KEY,
} from './reasons.js';

// 纯事件流读取（零依赖批次对象）：runningSince（stint 起点）＝最近 member.dispatch 或 member.settled{to:'running'}
function parseEvTs(e) {
  const n = Date.parse(e?.ts ?? '');
  return Number.isFinite(n) ? n : null;
}

// ---- 状态锚点（§2 实现要点 1）：纯事件流反向扫描，返回**与 state 匹配**的最近迁移 ts ----
// 锚点与状态同源（state 现读 batch.lanes[lane]，不缓存）；缺锚点 → null（state 照常透出）。
function stateAnchorOf(batch, lane) {
  const st = laneStateOf(batch, lane);
  if (st === null) return null;
  const evs = batch?.events ?? [];
  if (st === 'running') return stintRunningSinceOf(batch, lane); // = 最近 member.dispatch ∨ member.settled{to:'running'}
  if (st === 'pending') {
    // pending 计时锚点 = 最近 batch.phase→running 事件 ts（**不是** member.dispatch——pending lane 无 dispatch）
    for (let i = evs.length - 1; i >= 0; i--) {
      const e = evs[i];
      if (e?.type !== EVT.EVT_BATCH_PHASE || e?.to !== 'running') continue;
      const ts = parseEvTs(e);
      if (ts !== null) return ts;
    }
    return null;
  }
  if (st === 'review' || st === 'idle') {
    // 最近一次 →review / →idle 迁移事件 ts（member.settled{to} 为主；兼容 member_set_status 直写镜像的 to 字段）
    for (let i = evs.length - 1; i >= 0; i--) {
      const e = evs[i];
      if (e?.lane !== lane) continue;
      if (e?.type !== EVT.EVT_MEMBER_SETTLED && e?.type !== EVT.EVT_MEMBER_DISPATCH) continue;
      if (e?.to !== st) continue;
      const ts = parseEvTs(e);
      if (ts !== null) return ts;
    }
    return null;
  }
  return null; // 其余态（终态/未知）无时间判据 ⇒ 无锚点
}
// 批次档锚点：最近 batch.phase→paused（paused 档的先判锚点）
function batchPausedAnchorOf(batch) {
  const evs = batch?.events ?? [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e?.type !== EVT.EVT_BATCH_PHASE || e?.to !== 'paused') continue;
    const ts = parseEvTs(e);
    if (ts !== null) return ts;
  }
  return null;
}

function laneConsumePathsOf(batch, lane) {
  const t = findTask(batch, lane);
  if (!t) return []; // wavePlan 缺该项 ⇒ 零观测面（BR-1/BR-3 反例；不存在即「不可判」而非「可判为真」）
  return Array.isArray(t.consume) ? t.consume.filter((p) => typeof p === 'string' && p) : [];
}

// 【⑨-2】纯事件流读取：最近一次 `member.dispatch` 或 `member.settled(running)` 的时刻。
//   为何住在 primitives 而非 verdict：它是「纯事件流读取原语」，verdict / judge / 本文件都要用；
//   若放在 verdict 层，primitives → verdict → primitives 会形成环（实测踩中过）。
export function stintRunningSinceOf(batch, lane) {
  const evs = batch?.events ?? [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e?.lane !== lane) continue;
    if (e.type === EVT.EVT_MEMBER_DISPATCH) return parseEvTs(e);
    if (e.type === EVT.EVT_MEMBER_SETTLED && e.to === 'running') return parseEvTs(e);
  }
  return null;
}

export {
  REASON_DANGLING_MEMBER, REASON_NOT_SCANNED_PLANNING, REASON_PAUSED_DWELL,
  REASON_PENDING_UNDISPATCHED, REASON_REVIEW_AWAITING_SETTLE, REASON_IDLE_AWAITING_RESUME,
  REASON_BLIND_RUN_NO_DEPS, REASON_BLIND_RUN_UPSTREAM_MISSING, REASON_BLIND_RUN_UPSTREAM_NEVER_READY,
  STATE_WINDOW_KEY,
  parseEvTs, isScannedLaneState, stateAnchorOf, batchPausedAnchorOf, laneConsumePathsOf,
};
