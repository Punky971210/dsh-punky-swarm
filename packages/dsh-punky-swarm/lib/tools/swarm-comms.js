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

// 成员回报 / Leader 唤醒单点（自 `lib/tools/core.js` **原样搬移**，行为零变更）：目标解析 / 投递 / 事件留痕 / 唤醒节流。
import { laneBindingOf, mailboxRootOf } from '../engine/dispatch.js';
import * as swarmMailbox from '../comms/mailbox.js';
import { readCapability } from '../assembly/schema.js';
import { applyInjectionBudget } from '../comms/inject-budget.js';
import { createAgentPort } from '../provider-dsh/agent.js';

function injectBudgetCfgOf(config) {
  return readCapability(config, 'injectBudget');
}

function budgetWakeSummaryOf(summary, injectCfg) {
  if (injectCfg?.enabled !== true) return { summary, omissions: [] };
  const r = applyInjectionBudget(summary, { surface: 'wake.summary', thresholds: injectCfg, kind: 'perItem' });
  return { summary: r.text, omissions: r.omissions };
}

/** 面 C 编排面（唯一导出薄壳，供 `swarm-report` 工具层单点调用）：读阈值 + 摘要层① 一并返回。 */
export function budgetSummaryForReport(config, summary) {
  const cfg = injectBudgetCfgOf(config);
  return { injectBudget: cfg, ...budgetWakeSummaryOf(summary, cfg) };
}

export const UNBOUND_BATCH_KEY = '(unbound)';
const UNBOUND_LANE_KEY = '(unbound)';

export function reportTargetOf(store, exec, args, logger) {
  const caller = exec?.agent?.session?.id ?? null;
  //   `batch-read-failed:` 两态在本入口也**真可辨**（否则同一条静默缺口在第二个入口原地复发）。
  const bind = laneBindingOf(store, caller, logger);
  const declaredBatchId = typeof args?.batchId === 'string' && args.batchId.trim() ? args.batchId.trim() : null;
  const declaredLane = typeof args?.lane === 'string' && args.lane.trim() ? args.lane.trim() : null;
  if (bind) {
    const parentSession = exec?.agent?.session?.header?.parentSession;
    const wakeSessionId = (typeof parentSession === 'string' && parentSession.length > 0) ? parentSession : bind.sessionId;
    return { caller, bound: true, sessionId: bind.sessionId, wakeSessionId, batchId: declaredBatchId ?? bind.batchId, lane: declaredLane ?? bind.lane };
  }
  return {
    caller, bound: false,
    sessionId: exec?.agent?.session?.header?.parentSession ?? caller,
    batchId: declaredBatchId,
    lane: declaredLane ?? UNBOUND_LANE_KEY,
  };
}

export function deliverSwarmMessage(root, tgt, box, args, kind) {
  if (!tgt.sessionId) return false;
  swarmMailbox.send(mailboxRootOf(root, tgt.sessionId, tgt.batchId ?? UNBOUND_BATCH_KEY), { type: box },
    { lane: tgt.lane, kind, summary: args.summary, artifactPath: args.artifactPath ?? null, from: tgt.caller, unbound: !tgt.bound });
  return true;
}

/** 批次事件留痕（唯一写路径 = store.appendEvent）：批次不可解析/已损坏 ⇒ 回 false（消息已投递，事件面如实回显）。 */
export function appendSwarmEventOf(store, tgt, evtType, kind) {
  if (!tgt.batchId || !tgt.sessionId) return false;
  try {
    store.appendEvent(tgt.sessionId, tgt.batchId, evtType, { lane: tgt.lane, kind, unbound: !tgt.bound });
    return true;
  } catch {
    return false;
  }
}

export const WAKE_TYPES = new Set(['blocked', 'settle-request', 'completed']);
export const WAKE_MIN_INTERVAL_MS = 30_000;
//   生产代码**不得**依赖本导出（工具面唯一消费者 = 本文件内的 `wakeLeaderForReport` / `swarm_report.execute`）。
export const LEADER_WAKE_WINDOWS = new Map();

/** 取 Leader 句柄（**非注入读 + fail-safe**）：永不抛；返回值区分「服务缺失」与「取不到该会话」。
 *  （`lib/provider-dsh/agent.js#notifyLeader`）⇒ 引擎侧**不再持有、也不再解引用**宿主对象。 */

/**
 *  纪律（J-9）：**只传摘要元数据，零复制正文**——载体是调用方显式给出的 `type` / `summary` / `artifactPath`
 *  候选清单的显示上限（本模块内单点，不导出）= `WAKE_CANDIDATES_MAX`：超出只报总数，防超大批次撑爆消息。 */
const WAKE_CANDIDATES_MAX = 12;

function leaderWakeMessageOf(input, merged) {
  const candidates = Array.isArray(input.candidates) ? input.candidates : [];
  const line = '[swarm] ' + (input.batchId ?? UNBOUND_BATCH_KEY) + '/' + (input.lane ?? UNBOUND_LANE_KEY)
    + ' ' + input.type + '：' + input.summary
    + (input.artifactPath ? '\n产物：' + input.artifactPath : '')
    + (candidates.length > 0
      ? '\n可派发候选（引擎只建议，派发仍由 Leader 决定）：' + candidates.slice(0, WAKE_CANDIDATES_MAX).join(', ')
        + (candidates.length > WAKE_CANDIDATES_MAX ? ' 等 ' + candidates.length + ' 条' : '')
      : '')
    + (merged > 0 ? '\n（另合并 ' + merged + ' 条同类回报）' : '');
  const budgeted = applyInjectionBudget(line, { surface: 'wake.total', thresholds: input.injectBudget, kind: 'total' });
  return {
    // id 不可省、不可复用：inbox 投影对 pending 消息做 id 去重，重复即抛
    message: {
      id: globalThis.crypto.randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: budgeted.text }],
      source: { kind: 'user' },
    },
    omissions: budgeted.omissions,
  };
}

/**
 * 唤醒 Leader（**唯一唤醒动作 = `leader.followup(msg)`**）。
 */
export function wakeLeaderForReport(ctx, input) {
  const out = { attempted: false, woke: false, reason: null, merged: 0 };
  try {
    const leaderSessionId = input?.leaderSessionId ?? null;
    if (!leaderSessionId) { out.reason = 'no-leader-session'; return out; }
    if (input?.callerSessionId && input.callerSessionId === leaderSessionId) { out.reason = 'self'; return out; }
    out.attempted = true;
    const key = leaderSessionId + '\0' + (input.batchId ?? '');
    const win = LEADER_WAKE_WINDOWS.get(key) ?? null;
    const now = typeof input.now === 'number' ? input.now : Date.now();
    if (win && now - win.at < WAKE_MIN_INTERVAL_MS) {
      win.merged += 1;
      out.reason = 'throttled';
      out.merged = win.merged;
      return out;
    }
    const merged = win ? win.merged : 0;
    const assembled = leaderWakeMessageOf(input, merged);
    //   provider 以**返回值**表达投递结果（契约：不可用/失败**不抛**，成因用功能面词汇）；
    //     （与旧「取不到句柄/句柄不可推送」两态合流，语义等价）。
    const notified = createAgentPort(ctx).notifyLeader({ sessionId: leaderSessionId, message: assembled.message });
    if (!notified.delivered) {
      //   `deliver-failed: …`        ⇒ 异常态 `error: …`（保持既有 `error:` 族，异常不得被误归因为「会话不在」）；
      const why = String(notified.reason ?? '');
      out.reason = why === 'agent-runtime-unavailable'
        ? 'service-unavailable'
        : (why.startsWith('deliver-failed: ') ? 'error: ' + why : 'leader-not-live');
      return out;
    }
    LEADER_WAKE_WINDOWS.set(key, { at: now, merged: 0 });
    out.woke = true;
    out.reason = 'woke';
    out.merged = merged;
    if (assembled.omissions.length > 0) out.omissions = assembled.omissions;
    return out;
  } catch (e) {
    // fail-safe（规格约束 3）：任何异常（含宿主抛错、UUID 不可用…）一律收敛为回显，**不得**外抛。
    out.woke = false;
    out.reason = 'error: ' + String(e?.message ?? e);
    return out;
  }
}