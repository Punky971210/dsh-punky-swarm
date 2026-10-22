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

// 提示档**留痕**单点（零静默纪律）
//   （【2026-10-02 · 内务批 波 2】随 `createLaneHeartbeat` 巨型函数拆分下沉，代码逐字搬移）。
import * as EVT from '../../state/event-types.js';
import {
  REASON_BLIND_RUN_UPSTREAM_NEVER_READY,
  REASON_PAUSED_DWELL,
  REASON_REVIEW_AWAITING_SETTLE,
  REASON_IDLE_AWAITING_RESUME,
  REASON_PENDING_UNDISPATCHED,
} from './reasons.js'; // A1-P2-01 补丁①：**必须**直连零依赖叶子（经 `primitives.js` 会在本文件顶层读环内 `const` ⇒ TDZ）

// 提示档留痕（零静默的**单次纪律**）：同一 (lane, reason, stateAnchorTs) 只落一条，跨重启幂等。
//   为什么单次：提示档（BR-3 / T3 paused / T4 review·idle·pending）本就会在**每拍**重算为真，
//   若每拍写一条即事件流噪音 + batch.updatedAt 被自写事件不断推高（掩盖真实停滞，反向伤害探测）。
//   事件类型复用既有 `lane.longrun.candidate`（不新增常量：event-types.js 本批无写者）——
//   以 `{candidate:false, tier:'T-notice', notice:true}` 与真候选区分（真候选判据恒 candidate=true，
//   hasLongrunCandidate / emitUnconsumed 均不受影响）。
const NOTICE_REASONS = new Set([
  REASON_BLIND_RUN_UPSTREAM_NEVER_READY,
  REASON_PAUSED_DWELL,
  REASON_REVIEW_AWAITING_SETTLE,
  REASON_IDLE_AWAITING_RESUME,
  REASON_PENDING_UNDISPATCHED,
]);
const noticeKeyOf = (lane, reason, anchor) => `${lane}\u0000${reason}\u0000${anchor ?? ''}`;
function hasNotice(batch, lane, reason, anchor) {
  const key = noticeKeyOf(lane, reason, anchor);
  return (batch?.events ?? []).some((e) => {
    if (e?.type !== EVT.EVT_LANE_LONGRUN_CANDIDATE || e?.notice !== true || e?.lane !== lane) return false;
    return noticeKeyOf(e.lane, e.reason, e.stateAnchorTs) === key;
  });
}
export function emitNotice(cx, sessionId, batchId, batch, verdict) {
  if (!verdict?.reason || !NOTICE_REASONS.has(verdict.reason)) return;
  if (hasNotice(batch, verdict.lane, verdict.reason, verdict.stateAnchorTs)) return;
  try {
    cx.store.appendEvent(sessionId, batchId, EVT.EVT_LANE_LONGRUN_CANDIDATE, {
      lane: verdict.lane,
      state: verdict.state,
      reason: verdict.reason,
      candidate: false,
      tier: 'T-notice',
      notice: true,
      stateAnchorTs: verdict.stateAnchorTs,
      stateResidentMs: verdict.stateResidentMs,
    });
  } catch { /* 批次终态/不存在 → 静默（提示档无候选义务；视图面仍由 lane_heartbeat 实时给出） */ }
}
