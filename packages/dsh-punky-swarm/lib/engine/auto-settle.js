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

//   **两路共用同一个 `autoSettleLane`**（本文件唯一判定入口，禁第二套口径）；两路同时到达 ⇒
//   幂等键去重后**单次结算**（第二路 **no-op**：不重复写事件、不重复推进）。
import { isMemberTerminal, autoSettleEnabledOf, SETTLEABLE_STOP_REASONS } from '../schema.js';
import { laneBindingOf, ownerSessionIdOf, dispatchIndexEntryOf } from './dispatch.js';
import { createBoundedExec, BOUNDED_PHASES } from '../exec/bounded.js';
import {
  EVT_AUTO_SETTLE_TRIGGERED, EVT_AUTO_SETTLE_PAUSED, EVT_AUTO_SETTLE_SKIPPED,
} from '../state/event-types.js';
// 层判定单点（**不新造第二套遍历**）：`findTask` 即「按 id 在 `batch.wavePlan[].tasks` 里定位任务」的
// 唯一实现（`lib/state/task-utils.js`，零依赖）；本模块只读它的 `layer` 字段。
import { findTask } from '../state/task-utils.js';

const settleBounded = createBoundedExec();
const boundedBegun = new Set();
const BOUNDED_BEGUN_MAX = 512;
function ensureBoundedBegin(tracker, runKey) {
  if (!runKey || boundedBegun.has(runKey)) return;
  tracker.begin(runKey);
  boundedBegun.add(runKey);
  if (boundedBegun.size > BOUNDED_BEGUN_MAX) {
    const oldest = boundedBegun.values().next().value;
    boundedBegun.delete(oldest);
  }
}

export const AUTO_SETTLE_SUBAGENT_END = 'subagent/end';

export const AUTO_SETTLE_TRIGGERS = Object.freeze({ subagentEnd: 'subagent/end', settleRequest: 'settle-request' });


export const DEFAULT_ON_FAIL = 'pause';

export const AUTO_SETTLE_ON_FAIL = Object.freeze({ pause: DEFAULT_ON_FAIL, report: 'report' });

export const AUDIT_SETTLE_DEFERRAL_REASON = 'audit-explicit-settle-required';

const AUTO_SETTLE_DISABLED_REASON = 'auto-settle-disabled';

//   语义冻结：**只有显式 `false` 才停用**；`undefined`（键缺省）/ 键缺失 / 任何非布尔值 ⇒ `true`
//   （既有批行为**逐字不变**）。⚠ **禁真值判断**：`!enabled` 会把 `0` / `''` / `null` 一并当停用 ⇒ **越权关停**。

export function isAuditLayerLane(batch, lane) {
  return findTask(batch, lane)?.layer === 'audit';
}

function isAuditSettleDeferral(e) {
  return e?.type === EVT_AUTO_SETTLE_SKIPPED && e?.reason === AUDIT_SETTLE_DEFERRAL_REASON;
}

function isAutoSettleDisabledSkip(e) {
  return e?.type === EVT_AUTO_SETTLE_SKIPPED && e?.reason === AUTO_SETTLE_DISABLED_REASON;
}

/** 瞬时/非幂等留痕的**统一排除面**（单点）：相位闸留痕 + audit 职责转移留痕 + **停用策略留痕**。
 *  三族语义不同（相位不对 / 职责不在引擎 / 本批策略为停用），但**幂等口径相同**
 *  ⇒ 在此合流，避免多处各自维护「哪些 skipped 不算判重」而漂移。 */
function isTransientSkip(e) {
  return isPhaseGateSkip(e) || isAuditSettleDeferral(e) || isAutoSettleDisabledSkip(e);
}

/** 幂等键归一：`(batchId, lane, 子会话 id)` 的第三元（缺 id 时**不得**伪造键 ⇒ 返回 null，调用方拒）。 */
export function settleIdOf(workerSessionId) {
  return typeof workerSessionId === 'string' && workerSessionId.length > 0 ? workerSessionId : null;
}

export function hasAutoSettleRecord(batch, lane, settleId) {
  const events = Array.isArray(batch?.events) ? batch.events : [];
  for (const e of events) {
    if (!e || (e.type !== EVT_AUTO_SETTLE_TRIGGERED && e.type !== EVT_AUTO_SETTLE_SKIPPED)) continue;
    if (e.lane !== lane) continue;
    if (isTransientSkip(e)) continue;
    if (e.type === EVT_AUTO_SETTLE_TRIGGERED && e.settleable === false) continue;
    const key = settleIdOf(e.settleId ?? e.workerSessionId ?? null);
    if (settleId !== null && key === settleId) return true;
  }
  return false;
}

function isPhaseGateSkip(e) {
  return e?.type === EVT_AUTO_SETTLE_SKIPPED && typeof e.reason === 'string' && e.reason.startsWith('phase-');
}


const inFlight = new Set();
const flightKeyOf = (sessionId, batchId, lane, settleId) => String(sessionId) + '\u0000' + String(batchId) + '\u0000' + String(lane) + '\u0000' + String(settleId);

function pauseForFail(store, sessionId, batchId, { lane, reason, code, trigger, settleId, workerSessionId, startPhase }) {
  const listed = startPhase !== 'running';
  if (!listed) {
    store.appendEvent(sessionId, batchId, EVT_AUTO_SETTLE_PAUSED, {
      lane, action: DEFAULT_ON_FAIL, reason, code: code ?? null, trigger, settleId, workerSessionId: workerSessionId ?? null,
    });
    try {
      store.setPhase(sessionId, batchId, 'paused', { reason: 'auto-settle:' + (reason ?? 'unspecified') });
    } catch {
    }
  }
  return { written: !listed };
}

export async function autoSettleLane({ ctx, store, root, liveConfig, bounded } = {}, {
  onFail = AUTO_SETTLE_ON_FAIL.pause,
  sessionId, batchId, lane, workerSessionId = null, stopReason = null, trigger,
} = {}) {
  const out = { ok: true, action: 'none', reason: null, lane: lane ?? null, status: null };
  if (!store || !sessionId || !batchId || !lane) { out.ok = false; out.action = 'error'; out.reason = 'missing-params'; return out; }
  const settleId = settleIdOf(workerSessionId);
  const flight = settleId ? flightKeyOf(sessionId, batchId, lane, settleId) : null;
  let finish = false;
  try {
    if (flight) {
      if (inFlight.has(flight)) { out.action = 'skipped'; out.reason = 'in-flight'; return out; }
      inFlight.add(flight);
      finish = true;
    }
    const batch = store.readBatch(sessionId, batchId);
    if (!batch) { out.ok = false; out.action = 'error'; out.reason = 'no-batch'; return out; }
    if (!(lane in (batch.lanes ?? {}))) { out.ok = false; out.action = 'error'; out.reason = 'no-lane'; return out; }
    const runKey = settleId ?? null;
    const tracker = bounded ?? settleBounded;
    ensureBoundedBegin(tracker, runKey);
    if (runKey) {
      const cls = tracker.classify(runKey);
      out.boundedPhase = cls.phase;
      if (cls.timedOut === true) {
        try { ctx?.logger?.warn?.('[dsh-punky-swarm] auto-settle bounded ' + cls.phase + ' (runId=' + runKey + ')'); } catch {  }
      }
    }
    if (settleId && hasAutoSettleRecord(batch, lane, settleId)) {
      out.action = 'skipped'; out.reason = 'already-settled';
      return out;
    }
    const from = batch.lanes[lane];
    if (isMemberTerminal(from)) {
      if (settleId) store.appendEvent(sessionId, batchId, EVT_AUTO_SETTLE_SKIPPED, { lane, reason: 'lane-terminal', settleId, trigger });
      out.action = 'skipped'; out.reason = 'lane-terminal'; out.status = from;
      return out;
    }
    if (batch.phase !== 'running') {
      store.appendEvent(sessionId, batchId, EVT_AUTO_SETTLE_SKIPPED, {
        lane, reason: 'phase-' + batch.phase, phase: batch.phase, settleId, trigger,
      });
      out.action = 'skipped'; out.reason = 'phase-' + batch.phase; out.status = from;
      return out;
    }
    if (isAuditLayerLane(batch, lane)) {
      store.appendEvent(sessionId, batchId, EVT_AUTO_SETTLE_SKIPPED, {
        lane, reason: AUDIT_SETTLE_DEFERRAL_REASON, settleId, trigger,
      });
      out.action = 'skipped'; out.reason = AUDIT_SETTLE_DEFERRAL_REASON; out.status = from;
      return out;
    }
    const settleable = SETTLEABLE_STOP_REASONS.includes(stopReason);
    store.appendEvent(sessionId, batchId, EVT_AUTO_SETTLE_TRIGGERED, {
      lane, trigger, settleId, workerSessionId, stopReason, settleable, from,
    });
    if (!settleable) {
      out.action = 'recorded'; out.reason = 'stop-reason-not-settleable'; out.status = from;
      return out;
    }
    if (runKey) {
      try { tracker.settle(runKey, stopReason); } catch {  }
    }
    const settledCls = runKey ? tracker.classify(runKey) : { phase: 'thinking', timedOut: false };
    out.boundedPhase = settledCls.phase;
    if (settledCls.timedOut === true) {
      try {
        ctx?.logger?.warn?.('[dsh-punky-swarm] auto-settle bounded ' + settledCls.phase
          + ' (runId=' + runKey + ', settle 后超过 ' + BOUNDED_PHASES.length + ' 档阈值)' );
      } catch {  }
    }
    let gateCode = null;
    try {
      if (batch.lanes[lane] === 'running') store.setMember(sessionId, batchId, lane, 'review');
      store.setMember(sessionId, batchId, lane, 'merged');
    } catch (e) {
      const msg = String(e?.message ?? e);
      gateCode = (/^[A-Z][A-Z0-9_]+/.exec(msg) ?? [null])[0];
      if (onFail === AUTO_SETTLE_ON_FAIL.report) {
        store.appendEvent(sessionId, batchId, EVT_AUTO_SETTLE_SKIPPED, {
          lane, reason: 'gate-rejected-to-member: ' + msg, code: gateCode, trigger, settleId, workerSessionId, status: from,
        });
        out.ok = false; out.action = 'rejected'; out.reason = msg; out.code = gateCode;
        out.status = (store.readBatch(sessionId, batchId)?.lanes ?? {})[lane] ?? null;
        return out;
      }
      const p = pauseForFail(store, sessionId, batchId, {
        lane, reason: msg, code: gateCode, trigger, settleId, workerSessionId, startPhase: batch.phase,
      });
      out.ok = false; out.action = 'paused'; out.reason = msg; out.code = gateCode;
      out.status = (store.readBatch(sessionId, batchId)?.lanes ?? {})[lane] ?? null;
      out.pausedWritten = p.written;
      return out;
    }
    const after = store.readBatch(sessionId, batchId);
    out.action = 'merged'; out.status = after?.lanes?.[lane] ?? null;
  } catch (e) {
    out.ok = false; out.action = 'error'; out.reason = String(e?.message ?? e);
    try { ctx?.logger?.warn?.('[dsh-punky-swarm] auto-settle failed (isolated): ' + out.reason); } catch {  }
    return out;
  } finally {
    if (finish && flight) inFlight.delete(flight);
  }
  return out;
}

export async function requestAutoSettle(deps = {}, { workerSessionId, trigger = AUTO_SETTLE_TRIGGERS.settleRequest, stopReason = null } = {}) {
  const { store } = deps;
  const bind = store ? laneBindingOf(store, workerSessionId, deps?.ctx?.logger ?? deps?.logger) : null;
  if (!bind) return { ok: false, action: 'unbound', reason: 'no-lane-binding', lane: null, status: null };
  return autoSettleLane(deps, {
    sessionId: bind.sessionId, batchId: bind.batchId, lane: bind.lane, workerSessionId, stopReason, trigger,
  });
}

async function onSubagentEnd(info, { store, dispatchIndex, ctx, root, liveConfig }) {
  try {
    if (!info || typeof info !== 'object') return;
    const id = info.id;
    if (typeof id !== 'string' || id.length === 0) return;
    let hit = dispatchIndex instanceof Map ? dispatchIndex.get(id) : null;
    if (!hit && store && typeof store.listAllBatches === 'function') {
      try {
        for (const { sessionId, batchId } of store.listAllBatches()) {
          const b = store.readBatch(sessionId, batchId);
          for (const ev of b?.events ?? []) {
            if (ev?.type === 'member.dispatch' && ev.workerSessionId === id && ev.lane) {
              hit = dispatchIndexEntryOf(sessionId, batchId, ev.lane, ownerSessionIdOf(ev));
              if (dispatchIndex instanceof Map) dispatchIndex.set(id, hit);
              break;
            }
          }
          if (hit) break;
        }
      } catch {  }
    }
    if (!hit || !hit.sessionId || !hit.batchId || !hit.lane) return;
    await autoSettleLane({ ctx, store, root, liveConfig }, {
      sessionId: hit.sessionId, batchId: hit.batchId, lane: hit.lane,
      workerSessionId: id, stopReason: info.stopReason ?? null, trigger: AUTO_SETTLE_TRIGGERS.subagentEnd,
    });
  } catch (e) {
    try { ctx?.logger?.warn?.('[dsh-punky-swarm] auto-settle subagent/end handler failed (isolated): ' + String(e?.message ?? e)); } catch {  }
  }
}

export function installAutoSettle(ctx, deps = {}) {
  const { store, dispatchIndex, root, liveConfig, enabled, logger = ctx?.logger } = deps;
  const inert = (reason) => ({ installed: false, inert: true, reason, count: () => 0, dispose() {} });
  if (!autoSettleEnabledOf(enabled)) {
    try {
      logger?.info?.('[dsh-punky-swarm] auto-settle disabled (autoSettle.enabled === false)：主路 subagent/end 未订阅；'
        + '结算责任归 Leader（member_set_status(review) → member_settle(...)）；兼底路 swarm_report 回报面照常，不再触发结算');
    } catch {  }
    return inert(AUTO_SETTLE_DISABLED_REASON);
  }
  if (!store || typeof ctx?.on !== 'function') return inert('ctx.on unavailable or store missing');
  let hits = 0;
  const handler = (info) => {
    hits++;
    return onSubagentEnd(info, { store, dispatchIndex, ctx, root, liveConfig }).catch((e) => {
      try { logger?.warn?.('[dsh-punky-swarm] auto-settle handler rejected (isolated): ' + String(e?.message ?? e)); } catch {  }
    });
  };
  const dispose = ctx.on(AUTO_SETTLE_SUBAGENT_END, handler, { global: true });
  return {
    installed: true,
    count: () => hits,
    dispose() { try { if (typeof dispose === 'function') dispose(); } catch {  } },
  };
}
