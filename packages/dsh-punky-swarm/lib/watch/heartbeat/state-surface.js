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

// 状态面查询档（`status` 只读投影 + 状态派生 + 生命周期入口）
//   （【2026-10-02 · 内务批 波 2】随 `createLaneHeartbeat` 巨型函数拆分下沉，代码逐字搬移）。
import * as schema from '../../schema.js';
import { exemptClearedAtOf, isDanglingLane, laneStateOf } from '../lane-heartbeat.js';
import {
  STATE_WINDOW_KEY,
  stateAnchorOf, batchPausedAnchorOf,
  REASON_DANGLING_MEMBER,
  REASON_NOT_SCANNED_PLANNING,
  REASON_PAUSED_DWELL,
  REASON_PENDING_UNDISPATCHED,
  REASON_REVIEW_AWAITING_SETTLE,
  REASON_IDLE_AWAITING_RESUME,
} from './primitives.js';
import { laneKeyOf } from './context.js';
import { resetEntry } from './activity.js';

// 只读：lastActivityAt/当前档位/missed/stalled/pendingProbeId + 状态面字段（state/stateAnchorTs/
//   stateResidentMs/dangling）。ctx 由工具侧传入（batch + 派生所见）；缺省 = 老调用点零变化。
//   注：`tracked` 语义已随「删静默丢态」扩面——非终态 lane 一律 tracked（entry 恒在），
//   不再等于「running 才被追踪」（旧口径见 C-2/§W-6）。
export function laneStatusOf(cx, laneKey, ctx = null) {
  const entry = cx.state.get(laneKey);
  // laneKey = `${sessionId}/${batchId}/${lane}`；lane 未约束可含 '/'，按前两个斜杠定位
  const i1 = laneKey.indexOf('/');
  const i2 = i1 >= 0 ? laneKey.indexOf('/', i1 + 1) : -1;
  const sessionId = i1 >= 0 ? laneKey.slice(0, i1) : null;
  const batchId = i2 >= 0 ? laneKey.slice(i1 + 1, i2) : null;
  const lane = i2 >= 0 ? laneKey.slice(i2 + 1) : null;
  // 状态面字段（与 longrunStatus 同源：同一阶梯 + 同一阈值映射；reason 由调用方给 override 时优先取之）
  const stateFields = deriveStateFields(cx, ctx?.batch ?? null, lane, ctx?.nowTs ?? null, ctx?.reasonOverride ?? null);
  if (!entry) {
    return {
      laneKey, tracked: false, lastActivityAt: null, tier: 0, intervalMs: cx.schedule[0],
      missed: 0, stalled: false, pendingProbeId: null, lastProbeAt: null,
      sessionId, batchId, lane, ...stateFields,
    };
  }
  const tier = Math.min(entry.missedCount, cx.schedule.length - 1);
  return {
    laneKey,
    tracked: true,
    sessionId,
    batchId,
    lane,
    lastActivityAt: new Date(entry.lastActivityAt).toISOString(),
    tier,
    intervalMs: cx.schedule[tier],
    missed: entry.missedCount,
    stalled: entry.stalled,
    pendingProbeId: entry.pendingProbeId,
    lastProbeAt: entry.lastProbeAt ? new Date(entry.lastProbeAt).toISOString() : null,
    ...stateFields,
  };
}

// 状态面派生（只读、纯）：state = 批次档优先（终态/planning/paused 三档先判，与 judgeLongrun 同序），
//   批次档不覆盖 lane 时取 lane 自身态；锚点取 stateAnchorOf / batchPausedAnchorOf（与 state 同源）；
//   reason 用**同一套阶梯**（§2 分派表 + U-3 优先级）在查询面复算——lane_heartbeat 与 lane_longrun
//   对同一 lane 必须给出同一 (state, reason)（U-5：同一 state 语义不能在多工具面分裂）。
//   （盲跑档 BR-* 需解析回调与台账，只在 longrunStatus 侧产出；查询面命中即取之——见 createHeartbeatTools。）
function deriveStateFields(cx, batch, lane, nowTsRef, reasonOverride = null) {
  const out = {
    state: null, stateAnchorTs: null, stateResidentMs: null, dangling: false,
    exemptClearedAt: null, reason: null,
  };
  if (!batch || lane == null) return out;
  const laneSt = laneStateOf(batch, lane);
  const tNow = nowTsRef ?? cx.clock();
  out.exemptClearedAt = (() => {
    const ms = exemptClearedAtOf(batch, lane);
    return ms === null ? null : new Date(ms).toISOString();
  })();
  out.dangling = isDanglingLane(batch, lane);
  let state = laneSt;
  let anchorTs = null;
  let reason;
  if (schema.isBatchTerminal(batch.phase)) {
    // 终态批：快照式（无阈值、无锚点）；非终态 lane = 悬挂成员，不产候选
    state = laneSt; anchorTs = null;
    reason = out.dangling ? REASON_DANGLING_MEMBER : 'batch-terminal-lane-terminal';
  } else if (batch.phase === 'planning') {
    state = laneSt; anchorTs = null;
    reason = REASON_NOT_SCANNED_PLANNING;
  } else if (batch.phase === 'paused') {
    state = 'paused'; anchorTs = batchPausedAnchorOf(batch);
    const over = anchorTs !== null && (tNow - anchorTs) > cx.lrCfg.pausedWindowMs;
    reason = over ? REASON_PAUSED_DWELL : 'paused-in-window';
  } else {
    state = laneSt; anchorTs = stateAnchorOf(batch, lane);
    const over = anchorTs !== null && (tNow - anchorTs) > cx.lrCfg[STATE_WINDOW_KEY[state] ?? ''] ;
    if (state === 'running') reason = null; // running 的 reason 由 longrunStatus 的完整判定给出
    else if (state === 'review') reason = over ? REASON_REVIEW_AWAITING_SETTLE : 'review-in-window';
    else if (state === 'idle') reason = over ? REASON_IDLE_AWAITING_RESUME : 'idle-in-window';
    else if (state === 'pending') reason = over ? REASON_PENDING_UNDISPATCHED : 'pending-in-window';
    else reason = 'lane-terminal-not-scanned';
  }
  out.state = state;
  out.stateAnchorTs = anchorTs === null ? null : new Date(anchorTs).toISOString();
  out.stateResidentMs = anchorTs === null ? null : tNow - anchorTs;
  out.reason = reasonOverride ?? reason;
  return out;
}

// 活动信号外部入口：missedCount=0 回 tier0
export function resetLane(cx, laneKey) {
  const entry = cx.state.get(laneKey);
  if (entry) resetEntry(entry, cx.clock());
}

export function disposeEngine(cx) {
  cx.disposed = true;
  cx.state.clear();
}

// `replayInFlight()`：返回本拍 W1-① 重放的 in-flight Promise（未跑过 ⇒ null）。
//   生产路径不消费它（tick 同步返回即结束）；测试/审计用它把「本拍补决策已落盘」变成可等待的事实，
//   避免用 sleep 猜时序（GAP-S11 的 20ms 时序 flake 同类陷阱）。
export function replayInFlightOf(cx) { return cx.replayInFlight; }
