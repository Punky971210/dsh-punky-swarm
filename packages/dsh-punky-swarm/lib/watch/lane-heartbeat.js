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

import { join } from 'node:path'; // `dirname` 随 cx 组装下沉 `./heartbeat/context.js`（波 2；本文件不再直引）
import { statSync, readdirSync, existsSync } from 'node:fs';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveWatchConfig, WATCH_DEFAULTS } from '../schema.js';
// 状态域只读消费：非终态扫描面 / 批次终态判定单一来源（禁硬编码状态字符串，零迁移）
import * as schema from '../schema.js';
import { sessionOf, TEXT_OUTPUT } from '../tools/shared.js'; // watch 域不再 import tools/core（共享辅助下沉零依赖 shared.js）
// `isAbsPath` 单点（原内联正则收敛）随 `resolveArtifact` 下沉 `./heartbeat/context.js`（波 2；本文件不再直引）。
import { findTask } from '../state/task-utils.js'; // 单点（原本地定义删除）
// lane.stalled 事件字面量（发端 + 读端）改引 EVT 常量单点
import * as EVT from '../state/event-types.js';
// 状态域谓词单点（W4 拆环：`state -> watch` 归零）；本文件原定义处改为保形再导出
import { laneStateOf, isScannedLaneState, isDanglingLane } from '../state/lane-state.js';
import { pendingHandles } from '../bridge/lane-handle.js'; // D2：未消费派发句柄（TTL 缺口探测）
// W1-① 重放/恢复（周期兜底）：与装配期扫描（lib/index.js）**同一单点**，不另写第二套判定
// 【波 2】`replayBatch` 直引随重放档下沉 `./heartbeat/replay.js`（本文件不再直引）。

import { createHeartbeatContext } from './heartbeat/context.js';
import {
  REASON_DANGLING_MEMBER, REASON_NOT_SCANNED_PLANNING, REASON_PAUSED_DWELL,
  REASON_PENDING_UNDISPATCHED, REASON_REVIEW_AWAITING_SETTLE, REASON_IDLE_AWAITING_RESUME,
  REASON_BLIND_RUN_NO_DEPS, REASON_BLIND_RUN_UPSTREAM_MISSING, REASON_BLIND_RUN_UPSTREAM_NEVER_READY,
  parseEvTs, stateAnchorOf, batchPausedAnchorOf, laneConsumePathsOf,
} from './heartbeat/primitives.js';
import { probeTick } from './heartbeat/stalled.js';
import { longrunStatusOf } from './heartbeat/longrun.js';
import { laneStatusOf, resetLane, disposeEngine, replayInFlightOf } from './heartbeat/state-surface.js';

export function bindingGapOf(batch, lane, nowTs = Date.now(), stintTs = null) {
  const evs = Array.isArray(batch?.events) ? batch.events : [];
  const stintMs = stintTs ? Date.parse(stintTs) : null;
  const dispatches = evs.filter((e) => e
    && e.type === EVT.EVT_MEMBER_DISPATCH
    && e.lane === lane
    && (stintMs === null || !Number.isFinite(stintMs) || Date.parse(e.ts ?? e.at ?? 0) >= stintMs));
  // ① 已绑定（本 stint 内有 dispatch 且 workerSessionId 非空）⇒ 无缺口；句柄是否残留不影响该结论
  const bound = dispatches.some((e) => typeof e.workerSessionId === 'string' && e.workerSessionId.length > 0);
  if (bound) return { hit: false, reason: null };
  // ② 无任何 dispatch 事件 ⇒ 归属缺失（既有语义不变）
  if (dispatches.length === 0) return { hit: true, reason: 'no-dispatch' };
  // ③ 有 dispatch 事件但未绑定 + 超 TTL 未消费句柄 ⇒ 悬挂意图（既有语义不变）
  const dangling = pendingHandles(nowTs).find((h) => h && h.batchId === batch?.batchId && h.lane === lane && h.expired === true);
  if (dangling) return { hit: true, reason: 'token-ttl-expired' };
  return { hit: false, reason: null };
}

// 退避档位（分钟 → ms，单调化钳制）：档位单调不减，冷场越久追问间隔越长
export function buildSchedule(intervalsMinutes) {
  const src = Array.isArray(intervalsMinutes) && intervalsMinutes.length > 0
    ? intervalsMinutes
    : WATCH_DEFAULTS.intervalsMinutes;
  const list = src.map((m) => {
    const n = Number(m);
    return Number.isFinite(n) && n >= 0 ? n * 60_000 : 0;
  });
  for (let i = 1; i < list.length; i++) list[i] = Math.max(list[i], list[i - 1]);
  return list;
}

export const LONGRUN_DEFAULTS = Object.freeze({
  enabled: true, // 出厂默认开（半自动件默认开防漏检；显式 false 才关）
  maxDurationMs: 1_200_000, // 默认 20min（长跑超时阈值；正整数 ms，非法回退默认）
  noProgressWindowMs: 300_000, // 默认 5min（无进展窗；正整数 ms，非法回退默认）
  staleBatchMs: 86_400_000, // 默认 24h（僵尸批次活跃度阈值；**0 = 关闭过滤**，非非法值）
  unconsumedTimeoutMs: 1_800_000, // 默认 30min（候选消费超时阈值；**0 = 关闭该档**）
  pendingWindowMs: 1_200_000, // 默认 20min（pending 未派发时长：锚点 = 最近 batch.phase→running）
  reviewWindowMs: 4_800_000, // 默认 80min（review 待结算时长 = 4×基准；**明文禁用「无活动」判**）
  idleWindowMs: 1_200_000, // 默认 20min（idle 待恢复时长：锚点 = 最近 →idle 迁移 ts）
  pausedWindowMs: 1_200_000, // 默认 20min（paused 批次滞留：锚点 = 最近 batch.phase→paused ts）
  blindRunGraceMs: 1_200_000, // 默认 20min（盲跑 BR-1/BR-3 宽限：派发后越此窗才判）
});
export const LONGRUN_REASON = 'duration-exceeded-no-progress';
// 非候选 reason 取值（既有值一字不改，回归锚）：豁免生效中 / 磁盘进度快照新鲜 / 僵尸批次
export const LONGRUN_REASON_EXEMPT_ACTIVE = 'exempt-active';
const LONGRUN_REASON_STALE_BATCH = 'stale-batch';

const EVT_LANE_EXEMPT_CLEARED_LITERAL = 'lane.exempt.cleared';

export function resolveLongrunConfig(config) {
  const c = config?.capabilities?.watch?.longrun ?? {};
  const posMs = (v) => (Number.isFinite(Number(v)) && Number(v) >= 1 ? Math.floor(Number(v)) : null);
  const zeroOffMs = (v, fallback) => (Number(v) === 0 ? 0 : (posMs(v) ?? fallback));
  return {
    enabled: c.enabled !== false, // 缺省 = LONGRUN_DEFAULTS.enabled(true)，显式 false 才关
    maxDurationMs: posMs(c.maxDurationMs) ?? LONGRUN_DEFAULTS.maxDurationMs,
    noProgressWindowMs: posMs(c.noProgressWindowMs) ?? LONGRUN_DEFAULTS.noProgressWindowMs,
    staleBatchMs: zeroOffMs(c.staleBatchMs, LONGRUN_DEFAULTS.staleBatchMs),
    unconsumedTimeoutMs: zeroOffMs(c.unconsumedTimeoutMs, LONGRUN_DEFAULTS.unconsumedTimeoutMs),
    pendingWindowMs: posMs(c.pendingWindowMs) ?? LONGRUN_DEFAULTS.pendingWindowMs,
    reviewWindowMs: posMs(c.reviewWindowMs) ?? LONGRUN_DEFAULTS.reviewWindowMs,
    idleWindowMs: posMs(c.idleWindowMs) ?? LONGRUN_DEFAULTS.idleWindowMs,
    pausedWindowMs: posMs(c.pausedWindowMs) ?? LONGRUN_DEFAULTS.pausedWindowMs,
    blindRunGraceMs: posMs(c.blindRunGraceMs) ?? LONGRUN_DEFAULTS.blindRunGraceMs,
  };
}

// 纯事件流读取 `parseEvTs` 已随波 2 下沉 `./heartbeat/primitives.js`（顶部 import 取用）。
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
export function lastCheckpointTsOf(batch, lane) {
  const evs = batch?.events ?? [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e?.type === EVT.EVT_WORKTREE_CHECKPOINT && e?.lane === lane) return parseEvTs(e);
  }
  return null;
}
export function hasLongrunCandidate(batch, lane, runningSinceMs) {
  if (runningSinceMs == null) return false;
  return (batch?.events ?? []).some((e) => {
    if (e?.type !== EVT.EVT_LANE_LONGRUN_CANDIDATE || e?.lane !== lane) return false;
    const ms = Date.parse(e?.runningSince ?? '');
    return Number.isFinite(ms) && ms === runningSinceMs;
  });
}
// 同 stint 的候选事件对象（候选消费超时判据的输入：取它携带的 ackId）。
// 反向扫描取**最新**一条：同 stint 理论唯一（hasLongrunCandidate 去重）——取最新只是防御性口径。
export function longrunCandidateOf(batch, lane, runningSinceMs) {
  if (runningSinceMs == null) return null;
  const evs = batch?.events ?? [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e?.type !== EVT.EVT_LANE_LONGRUN_CANDIDATE || e?.lane !== lane) continue;
    const ms = Date.parse(e?.runningSince ?? '');
    if (Number.isFinite(ms) && ms === runningSinceMs) return e;
  }
  return null;
}
// 单次纪律：以 (lane, runningSince) 为去重键（与 hasLongrunCandidate 完全同构，跨重启幂等）。
export function hasLongrunUnconsumed(batch, lane, runningSinceMs) {
  if (runningSinceMs == null) return false;
  return (batch?.events ?? []).some((e) => {
    if (e?.type !== EVT.EVT_LANE_LONGRUN_UNCONSUMED || e?.lane !== lane) return false;
    const ms = Date.parse(e?.runningSince ?? '');
    return Number.isFinite(ms) && ms === runningSinceMs;
  });
}
export function lastEventTsOf(batch) {
  const evs = batch?.events ?? [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const ts = parseEvTs(evs[i]);
    if (ts !== null) return ts;
  }
  const u = Date.parse(batch?.updatedAt ?? '');
  return Number.isFinite(u) ? u : null;
}
export function isStaleBatch(batch, nowTs, staleBatchMs) {
  if (!(Number(staleBatchMs) > 0)) return false;
  const lastTs = lastEventTsOf(batch);
  if (lastTs === null) return false; // 无任何时间信号 → 不判僵尸（保守：宁可扫也不误跳）
  return nowTs - lastTs > staleBatchMs;
}

// ---- 状态域（§1.1/§1.2）：谓词已下沉 `../state/lane-state.js`（W4 拆环：`state -> watch` 归零）----
//   保形再导出：原路径/原名可继续导入（22 个导出名一个不少），本文件内部消费走顶部 import。
export { laneStateOf, isScannedLaneState, isDanglingLane };

export function exemptClearedAtOf(batch, lane) {
  const direct = batch?.laneExemptCleared?.[lane];
  const ms = typeof direct === 'string' ? Date.parse(direct) : (typeof direct === 'number' ? direct : NaN);
  if (Number.isFinite(ms)) return ms;
  const evs = batch?.events ?? [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e?.lane !== lane || e?.type !== EVT_LANE_EXEMPT_CLEARED_LITERAL) continue;
    const t = parseEvTs(e) ?? (Number.isFinite(Date.parse(e?.clearedAt ?? '')) ? Date.parse(e.clearedAt) : null);
    if (t !== null) return t;
  }
  return null;
}

// ---- 假阳性修复：磁盘进度快照作为「非 git 进度信号」纳入活跃度/checkpoint 新鲜度判定 ----
// 实测根因：worker 直写磁盘进度快照（<artifacts>/<batchId>/<lane>/*.md）、未调
//   lane_checkpoint（禁 worktree 批次里它恒 no-op）→ 事件流 checkpoint 类事件 0 条，而磁盘快照 12 份，
//   探针既看不到 checkpoint 也不从快照 mtime 推活跃 → 对**实际在跑**的 lane 报假候选。
// 判据：该 lane 的产物目录（<artifacts>/<batchId>/<lane>/ 及其子目录，深度受限）下进度快照的最新 mtime。
//   - 为什么是 lane 目录扫描而非声明产物清单：声明产物（outputs/produce）语义是「最终交付物」——
//     开工前不存在、收尾才写；progress 快照按每子步骤落盘，才是**进行中**的进度信号（本修复的靶点）。
//   - 与既有 artifactActivity/baselineTs 的关系：那两处只管声明产物路径；本函数补快照通道，两者互补。
//   - 深度上限 3 层（lane/progress/step.md 即 2 层）+ 单目录条目上限 200：防异常大树拖慢 tick。
// 只读、失败即静默（不存在/不可读 → null = 无进展信号），永不 throw。
const PROGRESS_DIR_MAX_DEPTH = 3;
const PROGRESS_DIR_MAX_ENTRIES = 200;
export function lastProgressTsOf(progressDir, { maxDepth = PROGRESS_DIR_MAX_DEPTH, maxEntries = PROGRESS_DIR_MAX_ENTRIES, onlyMarkdown = false } = {}) {
  if (!progressDir) return null;
  let latest = null;
  let budget = maxEntries;
  const walk = (dir, depth) => {
    if (budget <= 0) return;
    let names;
    try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      if (budget-- <= 0) return;
      const p = join(dir, d.name);
      try {
        if (d.isDirectory()) {
          if (depth < maxDepth) walk(p, depth + 1); // 深度上限：depth 层目录已读，不再向下（maxDepth=0 → 只读本目录文件）
          continue;
        }
        if (!d.isFile()) continue;
        // onlyMarkdown：收窄到快照命名口径（*.md），供「lane 根兜底扫描」使用——lane 根混有非快照文件时
        //   不把任意文件的 mtime 当进度信号（收窄信号面，避免误判活跃）。
        if (onlyMarkdown && !/\.md$/i.test(d.name)) continue;
        const m = statSync(p).mtimeMs;
        if (Number.isFinite(m) && (latest === null || m > latest)) latest = m;
      } catch { /* 单条目失败隔离：跳过，不阻断扫描 */ }
    }
  };
  walk(progressDir, 0);
  return latest;
}

function laneHasEmptyDeps(batch, lane) {
  const t = findTask(batch, lane);
  if (!t) return false; // 未登记 wavePlan ⇒ 不判（零静默：以 unverified 记账，不猜——BR-1 的关键反例）
  const consumeExplicitlyEmpty = Array.isArray(t.consume) && t.consume.length === 0;
  if (!consumeExplicitlyEmpty) return false;
  const depsEmpty = t.deps == null || (Array.isArray(t.deps) && t.deps.length === 0);
  if (!depsEmpty) return false;
  if (batchHasDependencyEdges(batch)) return false;
  return batchLaneCount(batch) === 1;
}
// 批内 lane 数（wavePlan[].tasks 全量计数）；无 wavePlan ⇒ 0（无法判定）
function batchLaneCount(batch) {
  const waves = batch?.wavePlan;
  if (!Array.isArray(waves)) return 0;
  let n = 0;
  for (const w of waves) n += (w?.tasks ?? []).length;
  return n;
}
// 批内是否存在任何依赖边（wavePlan[].tasks[].deps 非空即为真）；无 wavePlan ⇒ 保守判 true（不判盲跑）
function batchHasDependencyEdges(batch) {
  const waves = batch?.wavePlan;
  if (!Array.isArray(waves)) return true;
  let sawTask = false;
  for (const w of waves) {
    for (const t of w?.tasks ?? []) {
      sawTask = true;
      if (Array.isArray(t?.deps) && t.deps.length > 0) return true;
    }
  }
  return sawTask ? false : true; // 空 wavePlan 无法判定结构 ⇒ 保守不判盲跑
}
// BR-2 的「派发时刻可解析」证据 = 派发之后**首个观测**的既定事实（U-4）：
//   观测时刻须**晚于**该 lane 当前 stint 起点（member.dispatch / settled→running），否则不构成「派发后」证据；
//   观测结果与当前结果不一致（曾可解析 ∧ 现不可解析）⇒ BR-2 成立。
function upstreamMissingEvidenceOf(consumeObs, runningSinceTs, nowResolvable) {
  if (!consumeObs || runningSinceTs === null) return null;
  const { resolvedAtTs = null, neverResolvable = false, observedTs = null } = consumeObs;
  const afterDispatchTs = observedTs !== null && observedTs > runningSinceTs ? observedTs : null;
  const hadEvidence = (!neverResolvable) && (resolvedAtTs > 0 || afterDispatchTs !== null);
  const evidenceTs = resolvedAtTs > 0 ? resolvedAtTs : afterDispatchTs;
  if (!hadEvidence || evidenceTs === null) return null;
  if (nowResolvable !== false) return null; // 未被观测为「当前不可解析」⇒ BR-2 不成立
  return { evidenceSource: resolvedAtTs > 0 ? 'dispatch-window-tick-observation' : 'dispatch-window-tick-first-observation', evidenceTs };
}
// 产出裁定（U-3 阶梯 ⑤ 的**档内**定序）：BR-2 > BR-1 > BR-3；未命中 → reason=null。
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

export function createLaneHeartbeat({ store, mailbox, config, root, now, liveConfig, logger }) {
  // 闭包上下文 `cx`：承载原闭包内共享变量（cfg/lrCfg/schedule/hardStop/clock/engineRoot/ctxOf/state
  //   + disposed/replayInFlight 两个可变位），**每引擎实例一份**——不得提升为模块级单例（纪律：不新增真源）。
  const cx = createHeartbeatContext({ store, mailbox, config, root, now, liveConfig, logger });
  // 各探针档从**同一 `cx`** 取值；返回键序 = 拆分前 `return { ... }` 的键序（行为零变更）。
  //   薄包装保持原签名与形参表（arity 逐字不变）：tick（stalled 档，内嵌 longrun 扫描与重放兜底）/
  //   status / reset / dispose / longrunStatus / replayInFlight。
  function tick() { return probeTick(cx); }
  function status(laneKey, ctx = null) { return laneStatusOf(cx, laneKey, ctx); }
  function reset(laneKey) { return resetLane(cx, laneKey); }
  function dispose() { return disposeEngine(cx); }
  function longrunStatus(sessionId, batchId, lane, nowTs) { return longrunStatusOf(cx, sessionId, batchId, lane, nowTs); }
  function replayInFlight() { return replayInFlightOf(cx); }
  return { tick, status, reset, dispose, longrunStatus, replayInFlight };
}

function laneIdsFor(batch, only) {
  const all = Object.keys(batch.lanes ?? {});
  if (only) return [only];
  if (schema.isBatchTerminal(batch.phase)) return all;
  return all.filter((l) => !schema.isMemberTerminal(batch.lanes[l]));
}

