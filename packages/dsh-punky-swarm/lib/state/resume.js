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
