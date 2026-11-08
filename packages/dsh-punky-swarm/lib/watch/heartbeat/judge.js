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

// watch 域 · 判定本体：`blindRunVerdict` + `judgeLongrun`（状态面一态一判据）。
// 只依赖 verdict.js 的读数原语，不反向依赖分片或门面。

import * as schema from '../../schema.js';
import { isDanglingLane } from '../../state/lane-state.js';
import { REASON_DANGLING_MEMBER, REASON_NOT_SCANNED_PLANNING, REASON_PAUSED_DWELL, REASON_PENDING_UNDISPATCHED, REASON_REVIEW_AWAITING_SETTLE, REASON_IDLE_AWAITING_RESUME, REASON_BLIND_RUN_NO_DEPS, REASON_BLIND_RUN_UPSTREAM_MISSING, REASON_BLIND_RUN_UPSTREAM_NEVER_READY, stateAnchorOf, batchPausedAnchorOf, laneConsumePathsOf, stintRunningSinceOf } from './primitives.js';
import { LONGRUN_DEFAULTS, LONGRUN_REASON, LONGRUN_REASON_EXEMPT_ACTIVE, LONGRUN_REASON_STALE_BATCH, lastCheckpointTsOf, lastEventTsOf, isStaleBatch, laneHasEmptyDeps, upstreamMissingEvidenceOf } from './verdict.js';

function blindRunVerdict({
  batch, lane, nowTs, durationMs, blindRunGraceMs = LONGRUN_DEFAULTS.blindRunGraceMs,
  exempt = null, progressTsMs = null, consumeObs = null, resolveConsume = null, exemptClearedAtMs = null,
}) {
  const out = {
    evaluated: false, reason: null, candidate: false, code: null,
    graceExceeded: false, consumePaths: [], dispatchTs: null, progressTs: null, exemptClearedAt: null,
  };
  if (typeof resolveConsume !== 'function') return out; // 无解析面 ⇒ 不判（缺省零行为变化）
  out.evaluated = true;
  const paths = laneConsumePathsOf(batch, lane);
  const emptyDeps = laneHasEmptyDeps(batch, lane);
  const graceExceeded = durationMs !== null && durationMs > blindRunGraceMs;
  out.graceExceeded = graceExceeded;
  out.consumePaths = paths;
  out.dispatchTs = stintRunningSinceOf(batch, lane);
  out.progressTs = progressTsMs ?? null;
  out.exemptClearedAt = exemptClearedAtMs ?? null;
  if (!graceExceeded) return out; // 宽限窗内不判任何盲跑档（与 running 长跑阈值正交，不掩盖）
  // 当前可解析面（逐路径；空路径集 → false）
  let anyNow = false;
  for (const rel of paths) {
    if (resolveConsume(rel) === true) { anyNow = true; break; }
  }
  // BR-2：派发时刻曾可解析 ∧ 探针时刻不可解析（**前置于** BR-1：有实证的具体诊断优先）
  if (paths.length > 0) {
    const ev = upstreamMissingEvidenceOf(consumeObs, out.dispatchTs, anyNow);
    if (ev !== null) {
      out.reason = REASON_BLIND_RUN_UPSTREAM_MISSING;
      out.candidate = true;
      out.code = 'BR-2';
      out.evidenceSource = ev.evidenceSource;
      out.evidenceTs = ev.evidenceTs;
      return out;
    }
  }
  // BR-1：空依赖在跑（wavePlan 登记在案为前提；未登记 ⇒ emptyDeps=false ⇒ 不产）
  if (emptyDeps) {
    out.reason = REASON_BLIND_RUN_NO_DEPS;
    out.candidate = true;
    out.code = 'BR-1';
    return out;
  }
  // BR-3：上游从未就绪（提示档；非候选）；带豁免标注 ⇒ 不产（豁免即已声明长程意图）
  if (paths.length > 0 && exempt == null && anyNow === false) {
    const neverResolvable = !consumeObs || consumeObs.neverResolvable === true || consumeObs.resolvedAtTs === 0
      || consumeObs.resolvedAtTs == null;
    if (neverResolvable) {
      out.reason = REASON_BLIND_RUN_UPSTREAM_NEVER_READY;
      out.candidate = false; // §4.1 产出列：BR-3 = **提示档**（非候选）
      out.code = 'BR-3';
      return out;
    }
  }
  return out;
}

// judgeLongrun 纯函数（判定要素取自批次事件流 + 心跳内存 lastActivityAt + 磁盘进度快照 mtime + 派发后
// 首个观测台账 consumeObs，不调 git、不改状态）。
// 语义已从「双 running 门 + 单判据」扩为**状态面一态一判据**（§1.2 准入矩阵 + §2 分派表 + U-3 优先级阶梯，
//   完整契约见文件头「状态面扩面」注释块）。running 态的长跑判据**逐字保留**：
//   candidate = state==='running' ∧ batch.phase==='running' ∧ !僵尸批次 ∧
//               durationMs > effectiveMaxDurationMs（严格 >；effective = maxDurationMs × 豁免倍率）∧
//               !checkpointFresh ∧ !activityFresh（三窗均严格 <）
// 载荷携带原始 fresh 值供 Leader 复核（若后续需改 OR 语义，纯函数单点即可）。
export function judgeLongrun({
  batch, lane, nowTs,
  maxDurationMs = LONGRUN_DEFAULTS.maxDurationMs,
  noProgressWindowMs = LONGRUN_DEFAULTS.noProgressWindowMs,
  lastActivityAtMs = null, // 心跳内存最近活动（ms）；引擎重启后为空 → 引擎侧以 baselineTs 兜底传入
  exempt = null, // 长程豁免记录（LaneExemptGrant）或 null/undefined（无豁免）
  progressTsMs = null, // 磁盘进度快照最新 mtime（ms）；null = 无快照（非 git 进度信号）
  staleBatchMs = LONGRUN_DEFAULTS.staleBatchMs, // 僵尸批阈值（<=0 = 关闭；判据见 isStaleBatch）
  // ---- 状态面新增入参（缺省 = 零行为变化：新增档在缺参时不产）----
  pendingWindowMs = LONGRUN_DEFAULTS.pendingWindowMs,
  reviewWindowMs = LONGRUN_DEFAULTS.reviewWindowMs,
  idleWindowMs = LONGRUN_DEFAULTS.idleWindowMs,
  pausedWindowMs = LONGRUN_DEFAULTS.pausedWindowMs,
  blindRunGraceMs = LONGRUN_DEFAULTS.blindRunGraceMs,
  consumeObs = null, // U-4 证据通道：派发后首个观测台账 { resolvedAtTs, neverResolvable, observedTs, resolvableNow, paths }
  resolveConsume = null, // 可解析判定回调 (rel) => boolean（可解析 = 存在**且非空**）；缺省 = 不判盲跑
  exemptClearedAtMs = null, // D7 次选留痕（显式清退时刻，ms）；供「可见的重新计时」透出
}) {
  const laneState = batch?.lanes?.[lane];
  const batchPhase = batch?.phase;
  const thresholdMultiplier = Number.isFinite(exempt?.multiplier) ? exempt.multiplier
    : (exempt == null ? 1 : 1);
  const effectiveMaxDurationMs = maxDurationMs * thresholdMultiplier;
  const base = {
    lane, laneState, phase: batchPhase,
    maxDurationMs, noProgressWindowMs,
    exempt: exempt ?? null, effectiveMaxDurationMs, thresholdMultiplier,
    runningSince: null, runningSinceTs: null, durationMs: null,
    lastCheckpointTs: null, checkpointFresh: false,
    lastProgressTs: null, progressFresh: false,
    lastActivityAt: null, activityFresh: false,
    staleBatch: false, lastEventTs: null,
    candidate: false, reason: null,
    // ---- 状态面新增字段（§2 实现要点 2：state / stateAnchorTs / stateResidentMs 一并透出）----
    state: null, batchState: null, stateAnchorTs: null, stateResidentMs: null,
    dangling: false, specialTask: false, exemptClearedAt: null,
    // 盲跑证据透出（只读、零破坏；人工复核 BR-2 的「派发时刻可解析」判据用）
    blindRun: null,
  };
  const clearedFields = { exemptClearedAt: exemptClearedAtMs === null ? null : new Date(exemptClearedAtMs).toISOString() };

  // ── ① 状态与锚点（state 与锚点同源；reason 恒与 state 对齐）─────────────────────────────
  const dangling = isDanglingLane(batch, lane);
  // 批次档先判（U-3 阶梯 ①②③）：终态 / planning / paused 三档**先于**任何 lane 判据
  if (schema.isBatchTerminal(batchPhase)) {
    // 终态批：**只出悬挂视图，不产任何候选**（快照式，无阈值；**不受僵尸批过滤**——用了会自我抹掉）
    return {
      ...base, ...clearedFields,
      state: laneState, stateAnchorTs: null, stateResidentMs: null,
      dangling,
      reason: dangling ? REASON_DANGLING_MEMBER : 'batch-terminal-lane-terminal',
    };
  }
  if (batchPhase === 'planning') {
    // planning：**只许登记不扫成员**（显式取舍）——state 照透，reason 恒为「未扫描」
    return {
      ...base, ...clearedFields,
      state: laneState, stateAnchorTs: null, stateResidentMs: null,
      reason: REASON_NOT_SCANNED_PLANNING,
    };
  }
  if (batchPhase === 'paused') {
    // paused 批：**独立滞留提示档**（Q-B：不并入长跑候选）
    const anchorTs = batchPausedAnchorOf(batch);
    const residentMs = anchorTs === null ? null : nowTs - anchorTs;
    const dwell = residentMs !== null && residentMs > pausedWindowMs;
    return {
      ...base, ...clearedFields,
      state: 'paused', batchState: laneState, // state = 批次档（与 reason 对齐）；batchState 保留 lane 态原值
      stateAnchorTs: anchorTs === null ? null : new Date(anchorTs).toISOString(),
      stateResidentMs: residentMs,
      candidate: false, // 提示档：恒非候选（§3 T3 不计入 T1）
      reason: dwell ? REASON_PAUSED_DWELL : 'paused-in-window',
    };
  }
  // 批次 = running（主面）：逐态分派
  const anchorTs = stateAnchorOf(batch, lane);
  const residentMs = anchorTs === null ? null : nowTs - anchorTs;
  // 信号新鲜度（**全态透出**，不只 running）：RS-2 (b) 要求 review 行也带 checkpointFresh，
  //   因为「review 是否在用无活动判」只能靠「它新鲜却仍产 review 档」来判别——不透出即无法证伪。
  //   三窗语义与 running 侧逐字同源（严格 <）。
  const cpEventTsAll = lastCheckpointTsOf(batch, lane);
  const lastCheckpointTsAll = cpEventTsAll !== null && progressTsMs !== null
    ? Math.max(cpEventTsAll, progressTsMs)
    : (cpEventTsAll !== null ? cpEventTsAll : progressTsMs);
  const freshFields = {
    lastCheckpointTs: lastCheckpointTsAll === null ? null : new Date(lastCheckpointTsAll).toISOString(),
    checkpointFresh: lastCheckpointTsAll !== null && (nowTs - lastCheckpointTsAll) < noProgressWindowMs,
    lastProgressTs: progressTsMs === null ? null : new Date(progressTsMs).toISOString(),
    progressFresh: progressTsMs !== null && (nowTs - progressTsMs) < noProgressWindowMs,
    lastActivityAt: lastActivityAtMs === null ? null : new Date(lastActivityAtMs).toISOString(),
    activityFresh: lastActivityAtMs !== null && (nowTs - lastActivityAtMs) < noProgressWindowMs,
  };
  const stateFields = {
    ...clearedFields,
    state: laneState,
    stateAnchorTs: anchorTs === null ? null : new Date(anchorTs).toISOString(),
    stateResidentMs: residentMs,
    ...freshFields,
  };
  if (laneState === 'review') {
    // 待结算时长：**明文禁用「无活动」判**（review 本就不活动 ⇒ 判据只看时长），不适用豁免倍率
    const over = residentMs !== null && residentMs > reviewWindowMs;
    return { ...base, ...stateFields, reason: over ? REASON_REVIEW_AWAITING_SETTLE : 'review-in-window' };
  }
  if (laneState === 'idle') {
    // 待恢复时长（idle = **崩溃恢复落位态**，非静息常驻态；不据此推导「超时即催促成员」），不适用豁免倍率
    const over = residentMs !== null && residentMs > idleWindowMs;
    return { ...base, ...stateFields, reason: over ? REASON_IDLE_AWAITING_RESUME : 'idle-in-window' };
  }
  if (laneState === 'pending') {
    // 未派发时长：锚点 = 最近 batch.phase→running（**不是** member.dispatch——pending lane 无 dispatch）
    const over = residentMs !== null && residentMs > pendingWindowMs;
    return { ...base, ...stateFields, reason: over ? REASON_PENDING_UNDISPATCHED : 'pending-in-window' };
  }
  if (laneState !== 'running') {
    // 终态 lane（merged/failed/skipped/conflict）：不扫判据
    return { ...base, ...stateFields, reason: 'lane-terminal-not-scanned' };
  }

  // ── ② running 态 ────────────────────────────────────────────────────────────────────
  const lastEventTs = lastEventTsOf(batch);
  const staleBatch = isStaleBatch(batch, nowTs, staleBatchMs);
  const staleFields = { staleBatch, lastEventTs: lastEventTs === null ? null : new Date(lastEventTs).toISOString() };
  const runningSinceTs = stintRunningSinceOf(batch, lane);
  const durationMs = runningSinceTs === null ? null : nowTs - runningSinceTs;

  const blind = blindRunVerdict({
    batch, lane, nowTs, durationMs, blindRunGraceMs, exempt,
    progressTsMs, consumeObs,
    resolveConsume: typeof resolveConsume === 'function' ? resolveConsume : null,
    exemptClearedAtMs,
  });
  const blindFields = { blindRun: blind };
  if (blind.reason !== null) {
    // BR-2 > BR-1 > BR-3 已在 blindRunVerdict 内定序；此处只落 reason + candidate
    return {
      ...base, ...stateFields, ...staleFields, ...blindFields,
      runningSince: runningSinceTs === null ? null : new Date(runningSinceTs).toISOString(),
      runningSinceTs, durationMs,
      candidate: blind.candidate,
      reason: blind.reason,
    };
  }

  // ── ④ 既有 running 长跑判据（守恒：stale-batch > 无进展窗 > 豁免态）──────────────────────
  if (staleBatch) return { ...base, ...stateFields, ...staleFields, ...blindFields, reason: LONGRUN_REASON_STALE_BATCH };
  if (runningSinceTs === null) {
    return { ...base, ...stateFields, ...staleFields, ...blindFields, reason: 'no-running-since' };
  }
  // checkpoint 信号 = 事件流 worktree.checkpoint ∨ 磁盘进度快照 mtime（取较新，见 lastProgressTsOf）
  const cpEventTs = lastCheckpointTsOf(batch, lane);
  const lastCheckpointTs = cpEventTs !== null && progressTsMs !== null
    ? Math.max(cpEventTs, progressTsMs)
    : (cpEventTs !== null ? cpEventTs : progressTsMs);
  const checkpointFresh = lastCheckpointTs !== null && (nowTs - lastCheckpointTs) < noProgressWindowMs;
  // progressFresh：仅反映「快照通道本身新鲜」，与 checkpointFresh 分开透出——便于人工区分
  //   「事件流有 checkpoint」与「只有磁盘快照」，也便于 audit 单独核对进度快照修复的生效面。
  const progressFresh = progressTsMs !== null && (nowTs - progressTsMs) < noProgressWindowMs;
  const activityFresh = lastActivityAtMs !== null && (nowTs - lastActivityAtMs) < noProgressWindowMs;
  const exceeded = durationMs > effectiveMaxDurationMs;
  const out = {
    ...base,
    ...stateFields,
    ...staleFields,
    ...blindFields,
    runningSince: new Date(runningSinceTs).toISOString(),
    runningSinceTs,
    durationMs,
    lastCheckpointTs: lastCheckpointTs === null ? null : new Date(lastCheckpointTs).toISOString(),
    checkpointFresh,
    lastProgressTs: progressTsMs === null ? null : new Date(progressTsMs).toISOString(),
    progressFresh,
    lastActivityAt: lastActivityAtMs === null ? null : new Date(lastActivityAtMs).toISOString(),
    activityFresh,
    candidate: exceeded && !checkpointFresh && !activityFresh,
    // §3 T1x：豁免 lane 越**放宽后**阈值（但仍在原基准之上）⇒ 独立档位标注，**不计入**正常长跑统计。
    //   豁免未越放宽阈值（duration ≤ effective）恒 false——那是 T1 之外的观察期，不是 T1x。
    specialTask: exempt != null && exceeded,
  };
  out.reason = out.candidate ? LONGRUN_REASON : (exceeded
    ? (checkpointFresh ? 'checkpoint-fresh' : (activityFresh ? 'activity-fresh' : 'no-longrun-candidate'))
    : (durationMs > maxDurationMs ? LONGRUN_REASON_EXEMPT_ACTIVE : 'duration-not-exceeded'));
  return out;
}