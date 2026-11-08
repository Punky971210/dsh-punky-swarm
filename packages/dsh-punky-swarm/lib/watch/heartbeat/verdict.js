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

// watch 域 · 长跑/僵尸/豁免判定的**读数原语**（纯函数，零副作用）+ 长跑配置解析。
// 本层位于 heartbeat/ 分片层，是 lane-heartbeat.js 与各分片的公共下界（拆环要点）。

import { WATCH_DEFAULTS } from '../../schema.js';
import * as EVT from '../../state/event-types.js';
import { findTask } from '../../state/task-utils.js';
import { pendingHandles } from '../../bridge/lane-handle.js';
import { join } from 'node:path';
import { statSync, readdirSync } from 'node:fs';
import { parseEvTs } from './primitives.js';

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
export const LONGRUN_REASON_STALE_BATCH = 'stale-batch';

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

export function laneHasEmptyDeps(batch, lane) {
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
export function upstreamMissingEvidenceOf(consumeObs, runningSinceTs, nowResolvable) {
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