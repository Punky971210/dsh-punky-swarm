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

import { BATCH_TRANSITIONS, isMemberTerminal } from '../schema.js';

export const PREVIEW_ACTIONS = Object.freeze(['pause', 'resume', 'abort']);

/** 动作 → 目标相位（唯一映射，不读调用方传的相位）。 */
const TARGET_PHASE_OF = Object.freeze({ pause: 'paused', resume: 'running', abort: 'aborted' });

/**
 * 刻意不在此另写字面量表 —— 两张表迟早会分叉，而这张表决定「执行会不会被拒」。
 */
export function canTransitionPhase(from, to) {
  const allowed = BATCH_TRANSITIONS?.[from];
  return Array.isArray(allowed) ? allowed.includes(to) : false;
}

/**
 * @param {object} input
 * @param {object} input.store 批次存储（只调 `readBatch`）
 * @param {string} input.sessionId 批归属会话
 * @param {string} input.batchId 批次 ID
 * @param {'pause'|'resume'|'abort'} input.action 干预动作
 * @param {object} [input.deps] 预留（当前不消费；保持与工具层同签名，便于将来接 logger）
 * @returns {{batchId: string, action: string, phase: string,
 *            preview: {affected: string[], skipped: string[], warnings: string[],
 *                      totals: {affected: number, skipped: number}}}}
 */
export function previewBatchControl({ store, sessionId, batchId, action, deps = {} } = {}) {
  if (!PREVIEW_ACTIONS.includes(action)) {
    throw new Error('GATE_BATCH_CONTROL_ACTION_INVALID: batch_control action 只允许 pause|resume|abort（收到 ' + JSON.stringify(action ?? null) + '）');
  }
  const batch = store.readBatch(sessionId, batchId);
  if (!batch) throw new Error('batch not found: ' + batchId);

  const from = batch.phase;
  const target = TARGET_PHASE_OF[action];
  const laneNames = Object.keys(batch.lanes ?? {});
  const affected = [];
  const skipped = [];
  const warnings = [];
  let phase = from;

  if (from === target) {
    warnings.push('no-op：批次相位已是 ' + target + '（真执行不会重复写相位事件）');
    skipped.push(...laneNames);
  } else if (!canTransitionPhase(from, target)) {
    warnings.push('非法迁移 ' + from + ' → ' + target + '：真执行将被相位机拒绝（预演不预测相位变化）');
    skipped.push(...laneNames);
  } else {
    phase = target;
    for (const name of laneNames) {
      if (isMemberTerminal(batch.lanes[name])) skipped.push(name);
      else affected.push(name);
    }
    if (action === 'abort' && affected.length > 0) {
      warnings.push('abort 收口后 ' + affected.length + ' 个非终态 lane 将成为悬挂成员（不自动清理）：' + affected.join(', '));
    }
  }

  void deps;
  return {
    batchId,
    action,
    phase,
    preview: {
      affected,
      skipped,
      warnings,
      totals: { affected: affected.length, skipped: skipped.length },
    },
  };
}
