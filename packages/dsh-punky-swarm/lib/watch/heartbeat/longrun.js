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

// longrun 档（超时重派探针）：候选产出 / 消费超时 / 扫描准入 / 只读查询
//   （【2026-10-02 · 内务批 波 2】随 `createLaneHeartbeat` 巨型函数拆分下沉，代码逐字搬移）。
//   判据本体（`judgeLongrun` / 盲跑 `blindRunVerdict`）仍在 `../lane-heartbeat.js`（导出面不动），
//   本文件只承载「闭包内」的候选投递与扫描编排（环依赖为**函数声明**，运行期调用安全）。
import * as schema from '../../schema.js';
import * as EVT from '../../state/event-types.js';
import {
  exemptClearedAtOf, hasLongrunCandidate, hasLongrunUnconsumed, isStaleBatch, judgeLongrun,
  laneStateOf, longrunCandidateOf, stintRunningSinceOf,
} from '../lane-heartbeat.js';
import { isScannedLaneState } from './primitives.js';
import { laneExemptOf, laneKeyOf, mailboxRootOf, progressSnapshotTsOf } from './context.js';
import { longrunLastActivityAt } from './activity.js';
import { consumeCtxOf } from './evidence.js';
import { emitNotice } from './notice.js';

// 候选产出（动作即止）：① 事件流留痕（载荷携带 broadcast 那条的 ackId 供消费判据用）
// ② mailbox broadcast 直写（Leader 兜底路径读 broadcast——纪律 0f 口径）
// ③ 同投 supervisor/inbox（Manager 通道；实测该通道可达——实测两次 stalled 追问经它送达）。
// 事件流去重（同 stint 已产 → skip）覆盖同 tick/多次 tick/引擎重启恢复三种情形；先事件后消息
// （事件失败 → 不写消息；消息失败仅 warn 语义静默——事件为唯一事实源，面板/Leader 可查）。
// 两条投递**各自 ackId 独立**，事件载荷锚定 broadcast 那条（锚 inbox 会把
//   「Manager 忙」误判成「无人消费」）。
export function emitLongrunCandidate(cx, sessionId, batchId, batch, lane, nowTs) {
  const entry = cx.state.get(laneKeyOf(sessionId, batchId, lane));
  const verdict = judgeLongrun({
    batch, lane, nowTs,
    maxDurationMs: cx.lrCfg.maxDurationMs,
    noProgressWindowMs: cx.lrCfg.noProgressWindowMs,
    lastActivityAtMs: longrunLastActivityAt(cx, sessionId, batchId, batch, lane),
    exempt: laneExemptOf(batch, lane), // R-3：豁免倍率放宽时长阈值
    progressTsMs: progressSnapshotTsOf(cx, sessionId, batchId, lane), // 进度快照信号（扫描面收窄：progress/ 子树 + lane 根 *.md）
    staleBatchMs: cx.lrCfg.staleBatchMs, // 僵尸批阈值
    // 状态面新增入参（同源单点：阈值取 lrCfg，证据取内存台账 + 只读解析回调）
    pendingWindowMs: cx.lrCfg.pendingWindowMs,
    reviewWindowMs: cx.lrCfg.reviewWindowMs,
    idleWindowMs: cx.lrCfg.idleWindowMs,
    pausedWindowMs: cx.lrCfg.pausedWindowMs,
    blindRunGraceMs: cx.lrCfg.blindRunGraceMs,
    exemptClearedAtMs: exemptClearedAtOf(batch, lane),
    ...consumeCtxOf(cx, sessionId, batchId, batch, lane, entry),
  });
  if (!verdict.candidate) {
    // 提示档（BR-3 / review / idle / pending / paused 滞留）**不产候选**；但零静默要求「可被观测」：
    //   留痕走**既有**事件类型 `lane.longrun.candidate`（**不新增常量**：event-types.js 本批无写者，
    //   禁越域），以 payload `{candidate:false, tier:'T-notice', notice:true}` 与真候选区分
    //   （既有 hasLongrunCandidate 判据只认 candidate 候选，不受影响；消费超时档也不受污染）。
    //   **不在这里写事件**（否则每拍对每个非候选 lane 写一条 → 事件流噪音，且引擎自写事件会推高
    //   batch.updatedAt 掩盖真实停滞）——改由 tick 按「状态+锚点」去重后落一次、跨重启幂等。
    emitNotice(cx, sessionId, batchId, batch, verdict);
    return;
  }
  // 事件流去重（同 stint；盲跑候选亦锚 (lane, runningSinceTs)）
  if (hasLongrunCandidate(batch, lane, verdict.runningSinceTs)) return;
  const payload = {
    lane,
    state: verdict.state, // D2：reason 与 state 对齐（新增，既有读端零破坏）
    stateAnchorTs: verdict.stateAnchorTs,
    stateResidentMs: verdict.stateResidentMs,
    specialTask: verdict.specialTask,
    blindRun: verdict.blindRun,
    runningSince: verdict.runningSince,
    durationMs: verdict.durationMs,
    maxDurationMs: verdict.maxDurationMs,
    noProgressWindowMs: verdict.noProgressWindowMs,
    lastCheckpointTs: verdict.lastCheckpointTs,
    lastActivityAt: verdict.lastActivityAt,
    checkpointFresh: verdict.checkpointFresh,
    activityFresh: verdict.activityFresh,
    reason: verdict.reason,
    // 只增不改的扩展字段（既有读端零破坏；面板/日志容忍多余字段）
    effectiveMaxDurationMs: verdict.effectiveMaxDurationMs,
    thresholdMultiplier: verdict.thresholdMultiplier,
    lastProgressTs: verdict.lastProgressTs,
    progressFresh: verdict.progressFresh,
    exemptClearedAt: verdict.exemptClearedAt,
  };
  const root = mailboxRootOf(cx, sessionId, batchId);
  let broadcastAckId = null;
  // 消费判据的「句柄」= broadcast 那条的 ackId。先投递（拿 ackId）后落事件——事件载荷因此一次写全
  //   （避免「先写事件再补 ackId」的两次写盘）；反序的唯一代价是「消息已成而事件写失败」，
  //   该情形下消息无事件可指（惰性孤儿，同 stint 无事件则下轮仍会重产），属可接受退化。
  try {
    const r = cx.mailbox.send(root, { type: 'broadcast' }, {
      kind: 'longrun.candidate', sessionId, batchId, ...payload,
    });
    broadcastAckId = r?.ackId ?? null;
  } catch { /* 消息写失败：事件仍须留痕（事件为唯一事实源），静默 */ }
  // 同投 supervisor/inbox（{type:'inbox'} → <root>/supervisor/inbox）。ackId 与 broadcast 独立，
  //   消费判据仍锚 broadcast 那条。
  try {
    cx.mailbox.send(root, { type: 'inbox' }, {
      kind: 'longrun.candidate', channel: 'inbox', sessionId, batchId, ...payload,
    });
  } catch { /* 第二条投递失败：事件仍留痕，静默（同 stint 去重不再重发） */ }
  try {
    cx.store.appendEvent(sessionId, batchId, EVT.EVT_LANE_LONGRUN_CANDIDATE, { ...payload, ackId: broadcastAckId });
  } catch { /* 批次终态/不存在 → 静默（无事件则同 stint 下轮会重产，不丢探测能力） */ }
}
// 候选消费超时 → lane.longrun.unconsumed（只产事件不改成员态）。
// 独立一趟扫描（**不得**挂在 hasLongrunCandidate 的 early-return 之后——那会让本分支永不执行）：
//   扫描面与 longrunTick 同一口径（listSessions → listBatches → phase==='running' → running lane）；
//   对每个 running lane 取**当前 stint 的候选事件**，判据：
//     elapsed = nowTs - Date.parse(candidate.ts) > unconsumedTimeoutMs
//     ∧ candidate.ackId 存在 ∧ !mailbox.isAcked(root, {type:'broadcast'}, candidate.ackId)
//   **必须用 isAcked**：ack 默认删原消息文件，readUnacked 会把「已消费」读成「不存在」→ 永久误报。
//   单次纪律：以 (lane, runningSince) 去重（hasLongrunUnconsumed 同构，跨引擎重建幂等）。
//   unconsumedTimeoutMs <= 0（显式 0 = 关闭该档）→ 整趟跳过。
export function emitUnconsumed(cx, sessionId, batchId, batch, lane, nowTs) {
  if (!(cx.lrCfg.unconsumedTimeoutMs > 0)) return;
  const runningSinceTs = stintRunningSinceOf(batch, lane);
  if (runningSinceTs === null) return;
  const cand = longrunCandidateOf(batch, lane, runningSinceTs);
  if (!cand?.ackId) return; // 无候选 / 旧候选无 ackId（升级前产的事件）→ 无从判消费
  const emittedAt = Date.parse(cand.ts ?? '');
  if (!Number.isFinite(emittedAt)) return;
  const elapsedMs = nowTs - emittedAt;
  if (!(elapsedMs > cx.lrCfg.unconsumedTimeoutMs)) return;
  let acked = false;
  try { acked = cx.mailbox.isAcked(mailboxRootOf(cx, sessionId, batchId), { type: 'broadcast' }, cand.ackId); }
  catch { return; /* 判据不可得 → 本轮不判（保守：宁可晚报也不误报） */ }
  if (acked) return;
  if (hasLongrunUnconsumed(batch, lane, runningSinceTs)) return; // 单次纪律
  try {
    cx.store.appendEvent(sessionId, batchId, EVT.EVT_LANE_LONGRUN_UNCONSUMED, {
      lane,
      runningSince: cand.runningSince,
      durationMs: cand.durationMs,
      emittedAt: cand.ts,
      elapsedMs,
      unconsumedTimeoutMs: cx.lrCfg.unconsumedTimeoutMs,
      ackId: cand.ackId,
    });
  } catch { /* 批次终态/不存在 → 静默 */ }
}
// longrun 扫描档（状态面扩面后的准入矩阵，§1.2）：
//   批次 {running, paused} 扫；批次 {planning} 不扫成员（只许登记）；批次终态 {aborted, complete} 整批跳过
//   （悬挂视图由只读查询面恒显，探针侧**不产任何候选/不写任何事件**——终态批不可再写）。
//   lane 侧：**非终态全集合** {pending, running, review, idle} 各走自身判据（一态一判据）；终态 lane 跳过。
//   僵尸批次（末事件早于 staleBatchMs）整批跳过——其 running 是历史残留，扫描只产噪音；
//   阈值 0 = 显式关闭过滤（逃生阀）。过滤只作用本档，不影响 stalled 档与批次状态
//   （**悬挂视图不受该过滤**——终态批天然「末事件早于 24h」，沿用会让该视图自我抹掉）。
export function longrunScan(cx, nowTs) {
  for (const sessionId of cx.store.listSessions()) {
    for (const batchId of cx.store.listBatches(sessionId)) {
      const batch = cx.store.readBatch(sessionId, batchId);
      if (!batch) continue;
      if (schema.isBatchTerminal(batch.phase)) continue; // 终态批：只出悬挂视图，不产候选、不写事件
      if (batch.phase === 'planning') continue; // planning：只许 Manager 登记，不扫成员判据
      if (isStaleBatch(batch, nowTs, cx.lrCfg.staleBatchMs)) continue; // 僵尸批跳过
      for (const lane of Object.keys(batch.lanes ?? {})) {
        if (!isScannedLaneState(batch, lane)) continue; // 非终态全集合；终态 lane 不扫
        try { emitLongrunCandidate(cx, sessionId, batchId, batch, lane, nowTs); }
        catch { /* 单 lane 探针失败隔离（不阻断整轮扫描） */ }
        // 消费超时档只对 running lane 有意义（候选只在 running 态产出）
        if (laneStateOf(batch, lane) !== 'running') continue;
        try { emitUnconsumed(cx, sessionId, batchId, batch, lane, nowTs); } // 消费超时独立趟（不挂 early-return 后）
        catch { /* 单 lane 失败隔离 */ }
      }
    }
  }
}
// 只读：单 lane longrun 探针状态（lane_longrun 工具查询用；不依赖本 tick 是否已跑——实时判定）
export function longrunStatusOf(cx, sessionId, batchId, lane, nowTs) {
  const batch = cx.store.readBatch(sessionId, batchId);
  if (!batch) {
    return {
      laneKey: laneKeyOf(sessionId, batchId, lane),
      sessionId, batchId, lane,
      tracked: false, candidate: false, reason: 'batch-not-found',
      state: null, stateAnchorTs: null, stateResidentMs: null, dangling: false, specialTask: false,
    };
  }
  const t = nowTs ?? cx.clock();
  const entry = cx.state.get(laneKeyOf(sessionId, batchId, lane));
  const verdict = judgeLongrun({
    batch, lane, nowTs: t,
    maxDurationMs: cx.lrCfg.maxDurationMs,
    noProgressWindowMs: cx.lrCfg.noProgressWindowMs,
    lastActivityAtMs: longrunLastActivityAt(cx, sessionId, batchId, batch, lane),
    exempt: laneExemptOf(batch, lane),
    progressTsMs: progressSnapshotTsOf(cx, sessionId, batchId, lane),
    staleBatchMs: cx.lrCfg.staleBatchMs,
    // 状态面新增入参（与 tick 侧逐字同源：同一 lrCfg / 同一台账 / 同一只读解析回调）
    pendingWindowMs: cx.lrCfg.pendingWindowMs,
    reviewWindowMs: cx.lrCfg.reviewWindowMs,
    idleWindowMs: cx.lrCfg.idleWindowMs,
    pausedWindowMs: cx.lrCfg.pausedWindowMs,
    blindRunGraceMs: cx.lrCfg.blindRunGraceMs,
    exemptClearedAtMs: exemptClearedAtOf(batch, lane),
    ...consumeCtxOf(cx, sessionId, batchId, batch, lane, entry),
  });
  return {
    laneKey: laneKeyOf(sessionId, batchId, lane),
    sessionId, batchId, lane,
    tracked: cx.state.has(laneKeyOf(sessionId, batchId, lane)),
    enabled: cx.lrCfg.enabled,
    maxDurationMs: cx.lrCfg.maxDurationMs,
    noProgressWindowMs: cx.lrCfg.noProgressWindowMs,
    // 豁免态透出（R-3/R-4 可观测性）：未豁免 lane = null / 基础阈值 / 1
    exempt: verdict.exempt,
    effectiveMaxDurationMs: verdict.effectiveMaxDurationMs,
    thresholdMultiplier: verdict.thresholdMultiplier,
    staleBatchMs: cx.lrCfg.staleBatchMs,
    staleBatch: verdict.staleBatch,
    runningSince: verdict.runningSince,
    runningSinceTs: verdict.runningSinceTs,
    durationMs: verdict.durationMs,
    lastCheckpointTs: verdict.lastCheckpointTs,
    lastProgressTs: verdict.lastProgressTs,
    lastActivityAt: verdict.lastActivityAt,
    checkpointFresh: verdict.checkpointFresh,
    progressFresh: verdict.progressFresh,
    activityFresh: verdict.activityFresh,
    candidate: verdict.candidate,
    emitted: hasLongrunCandidate(batch, lane, verdict.runningSinceTs),
    reason: verdict.reason,
    // ---- 状态面新增字段（D2：state / stateAnchorTs / stateResidentMs；reason 与之对齐）----
    state: verdict.state,
    stateAnchorTs: verdict.stateAnchorTs,
    stateResidentMs: verdict.stateResidentMs,
    dangling: verdict.dangling,
    specialTask: verdict.specialTask,
    exemptClearedAt: verdict.exemptClearedAt,
    blindRun: verdict.blindRun,
  };
}
