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

// lib/state/resume.js — 断点续跑骨架（增强恢复落地后回填实现）
import * as schema from '../schema.js';
import { findTask } from './task-utils.js';
import * as EVT from './event-types.js';
import { TERMINAL } from './constants.js';
// `subtasks` 归一化**只走 wave-plan.js 的原单点**（本模块不复制 items 循环：抄一份就有一份漂移面）。
import { normalizeCheckpoints } from '../wave-plan.js';

const RESUME_DEFAULTS = Object.freeze({ enabled: false });

export function resolveResumeConfig(config) {
  const c = config?.resume ?? {};
  return { enabled: c.enabled === true };
}

export function recoverBatches(store, { restoreRunning = false } = {}) {
  if (restoreRunning !== true) return store.recoverBatches();
  return restoreBatches(store);
}

export function restoreBatches(store, { eventType = EVT.EVT_SYSTEM_RESTORED } = {}) {
  const restored = [];
  for (const sessionId of store.listSessions()) {
    for (const batchId of store.listBatches(sessionId)) {
      const batch = store.readBatch(sessionId, batchId);
      if (!batch || schema.isBatchTerminal(batch.phase)) continue;
      const detail = [];
      for (const [lane, state] of Object.entries(batch.lanes ?? {})) {
        if (state !== 'running' && state !== 'review') continue;
        detail.push({
          lane,
          from: state,
          to: state,
          restored: true,
        });
      }
      if (detail.length) {
        store.appendEvent(sessionId, batchId, EVT.EVT_SYSTEM_RECOVERED, {
          batchId, sessionId,
          recoveredLanes: detail.map((d) => d.lane),
          detail,
          restored: true,
        });
        store.appendEvent(sessionId, batchId, eventType, {
          batchId, sessionId,
          restoredLanes: detail.map((d) => d.lane),
          detail,
        });
        restored.push(sessionId + '/' + batchId);
      }
    }
  }
  return restored;
}


//   fallback（事件面为空时回落指针）必须**复用本单点**读取，禁在工具层重写 `batch?.laneProgress?.[lane]` 访问式。
export function laneProgressRead(batch, lane) {
  return batch?.laneProgress?.[lane] ?? null;
}

export function isValidLaneProgress(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  if (p.status !== 'running' && p.status !== 'review') return false;
  if (!Number.isInteger(p.step) || !Number.isInteger(p.total)) return false;
  if (p.step < 1 || p.total < 1 || p.step > p.total) return false;
  return true;
}

export function laneProgressWrite(batch, lane, progress) {
  if (!isValidLaneProgress(progress)) {
    throw new Error('invalid laneProgress: ' + JSON.stringify(progress) + ' (expect { step, total, status: running|review, updatedAt? })');
  }
  return {
    ...batch,
    laneProgress: {
      ...(batch.laneProgress ?? {}),
      [lane]: { ...progress, updatedAt: progress.updatedAt ?? new Date().toISOString() },
    },
  };
}

export function laneProgressClear(batch, lane) {
  if (!batch?.laneProgress?.[lane]) return batch;
  const lp = { ...batch.laneProgress };
  delete lp[lane];
  return { ...batch, laneProgress: Object.keys(lp).length ? lp : undefined };
}

export function overBudgetOf(batch, lane, progress) {
  const task = findTask(batch, lane);
  const budget = task?.checkpoint?.steps ?? null;
  if (budget === null) return { over: false, budget: null };
  const total = progress?.total;
  if (Number.isInteger(total) && total > budget) return { over: true, budget };
  return { over: false, budget };
}

export function hasOverBudgetEvent(batch, lane) {
  return (batch?.events ?? []).some((e) => e.type === EVT.EVT_LANE_OVER_BUDGET && e.lane === lane);
}

export function checkpointTotalMismatchOf(batch, lane, progress) {
  const task = findTask(batch, lane);
  const items = task?.checkpoints?.items;
  const declared = Array.isArray(items) && items.length > 0 ? items.length : null;
  if (declared === null) return { mismatch: false, declared: null, actual: null };
  const total = progress?.total;
  if (!Number.isInteger(total)) return { mismatch: false, declared, actual: null };
  return { mismatch: total !== declared, declared, actual: total };
}

export function hasCheckpointTotalMismatchEvent(batch, lane) {
  return (batch?.events ?? []).some((e) => e.type === EVT.EVT_LANE_CHECKPOINT_TOTAL_MISMATCH && e.lane === lane);
}

export function recordCheckpointTotalMismatch(store, sessionId, batchId, batch, lane, progress, logger = null) {
  try {
    const mm = checkpointTotalMismatchOf(batch, lane, progress);
    if (!mm.mismatch || hasCheckpointTotalMismatchEvent(batch, lane)) return false;
    store.appendEvent(sessionId, batchId, EVT.EVT_LANE_CHECKPOINT_TOTAL_MISMATCH, {
      lane,
      declared: mm.declared,
      actual: mm.actual,
      step: progress?.step ?? null,
      source: 'checkpoints.items',
    });
    return true;
  } catch (e) {
    logger?.warn?.('[lane-checkpoint] total mismatch 留痕失败（不阻断）: ' + String(e?.message ?? e));
    return false;
  }
}

export function recordEarlyExitProgress(store, sessionId, batchId, batch, lane, progress, logger = null) {
  if (!progress) return false;
  try {
    if (TERMINAL.includes(batch?.lanes?.[lane])) return false;
    store.updateLaneProgress(sessionId, batchId, lane, { ...progress, status: 'running' });
    return true;
  } catch (e) {
    logger?.warn?.('[lane-checkpoint] early-exit laneProgress write failed（不阻断）: ' + String(e?.message ?? e));
    return false;
  }
}

// ── 批 `punky-checkpoint-enforce-20261112` · checkpoint 强制化：方言 / 取源 / 声明 / 覆盖 四个**纯函数** ──
//   为什么落本模块：`lib/state/resume.js` 是既有「断点 / 进度」单点（`laneProgressRead:73` /
//   `hasOverBudgetEvent:114` / `checkpointTotalMismatchOf:118` 均在此）⇒ 门（e2-gate）只许调用下面四个函数，
//   **禁在门里另写事件遍历**（spec §R-2「单点实现」；抄一份就有一份漂移面）。
//   四者一律**纯读、零副作用**：不写 store、不 normalize 入参、不改 `batch`（spec V-7 以
//   `JSON.stringify(batch)` 调用前后逐字相等为判据）。

const SUBTASKS_DIALECT = 'subtasks';
const LEGACY_DIALECT = 'legacy';

/** 展平 `batch.wavePlan[].tasks[]`（`wavePlan` 是 wave 数组，不是 task 数组）。 */
function flatTasksOf(batch) {
  const waves = Array.isArray(batch?.wavePlan) ? batch.wavePlan : [];
  const out = [];
  for (const w of waves) {
    if (!w || !Array.isArray(w.tasks)) continue;
    for (const t of w.tasks) {
      if (t && typeof t === 'object') out.push(t);
    }
  }
  return out;
}

/**
 * 方言判定：**批内任一** task 自身含 `subtasks` 键 ⇒ `'subtasks'`；否则 `'legacy'`。
 *   ⚠ 判据是「**键在场**」（`'subtasks' in task`），不是「值非空」：声明了但归一后 `items:[]` 仍算新方言
 *     （那正是派发门要拒的形状，spec V-14）。方言**读盘时计算**，不落任何持久字段（spec §RQ-3-7）。
 */
export function dialectOf(batch) {
  for (const t of flatTasksOf(batch)) {
    if ('subtasks' in t) return SUBTASKS_DIALECT;
  }
  return LEGACY_DIALECT;
}

/**
 * 最新进度取源（**逐字复用** `lib/tools/lane-worktree-tools.js` `lane_checkpoint_status` 的优先序）：
 *   ① 事件面倒序取最近一条同时带整数 `step`/`total` 的 `worktree.checkpoint` ⇒ `source:'event'`；
 *   ② 事件面无此类 ⇒ 回落 `laneProgressRead` ⇒ `source:'laneProgress'`；
 *   ③ 两处都无 ⇒ `null`。
 *   ⚠ **冲突时事件胜出**，不做数值合并（事件是「确实调用过」的痕迹，指针是缓存）。
 * @returns {{ latest: { step: number, total: number }, source: 'event'|'laneProgress' } | null}
 */
export function latestCheckpointOf(batch, lane) {
  const events = (batch?.events ?? []).filter((e) => e
    && e.type === EVT.EVT_WORKTREE_CHECKPOINT && e.lane === lane);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (Number.isInteger(e.step) && Number.isInteger(e.total)) {
      return { latest: { step: e.step, total: e.total }, source: 'event' };
    }
  }
  const lp = laneProgressRead(batch, lane);
  if (lp && Number.isInteger(lp.step) && Number.isInteger(lp.total)) {
    return { latest: { step: lp.step, total: lp.total }, source: 'laneProgress' };
  }
  return null;
}

/**
 * 已声明的 subtask id 清单（**按声明序**）。
 *   归一化走 `normalizeCheckpoints` 单点（= `subtasks` 的唯一归一实现）；未声明 ⇒ `[]`。
 */
export function declaredSubtasksOf(batch, lane) {
  const declared = normalizeCheckpoints(findTask(batch, lane)?.subtasks);
  const items = Array.isArray(declared?.items) ? declared.items : [];
  return items.map((it) => it.id);
}

/**
 * 已被事件覆盖的 subtask 面（结算门 G2 的达标判据原料）。
 *   · `ids` = 事件面**显式** `subtask` 字段集合（`worktree.checkpoint` 事件，B1 降级路径也落该字段）；
 *   · `sequential` = 序贯覆盖：最新进度 `total === 声明长度` 且 `step >= 声明长度`
 *     （成员没写 `subtaskId`、但确实按 `step/total` 走到末项 ⇒ 照算覆盖）。
 *   两条判据为 **∨** 关系（spec §R-5 G2 判据⑥），本函数只出原料，不做裁决。
 */
export function coveredSubtasksOf(batch, lane) {
  const ids = new Set();
  for (const e of (batch?.events ?? [])) {
    if (!e || e.type !== EVT.EVT_WORKTREE_CHECKPOINT || e.lane !== lane) continue;
    const id = typeof e.subtask === 'string' ? e.subtask.trim() : '';
    if (id) ids.add(id);
  }
  const declared = declaredSubtasksOf(batch, lane);
  const latest = latestCheckpointOf(batch, lane)?.latest ?? null;
  const sequential = declared.length > 0 && latest !== null
    && latest.total === declared.length && latest.step >= declared.length;
  return { ids, sequential };
}
