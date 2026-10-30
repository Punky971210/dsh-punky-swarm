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

// 批次干预的**预演**（I-20 preview）：只算「会发生什么」，不碰任何状态。
//
// 为什么单独一个模块，而不是塞进工具层：
//   工具层（`lib/tools/core.js#batch_control`）已经有相位机、台账、告警三件事；
//   再往里加一段「算但不算作数」的分支，读的人会分不清哪条路径在写。
//   这里**纯读**：零写盘、零事件、零 lane 状态改动 —— 判据就是「进出一模一样」。
//
// 与「执行」的关系（两阶段）
//   同一次工具调用无法「先返回再继续」⇒ preview 前置 = 调用方**先** `preview:true` 看结果、
//   **再**不带 `preview` 真执行（两次调用）。**刻意不做**「执行后回放」——那不是预演，是日志。
import { BATCH_TRANSITIONS, isMemberTerminal } from '../schema.js';

/** 本预演支持的干预动作（与 `batch_control` 的 `action` 枚举同源；不新增动作）。 */
export const PREVIEW_ACTIONS = Object.freeze(['pause', 'resume', 'abort']);

/** 动作 → 目标相位（唯一映射，不读调用方传的相位）。 */
const TARGET_PHASE_OF = Object.freeze({ pause: 'paused', resume: 'running', abort: 'aborted' });

/**
 * 相位迁移是否合法：**读** `lib/schema.js` 的 `BATCH_TRANSITIONS`（相位机同源）。
 * 刻意不在此另写字面量表 —— 两张表迟早会分叉，而这张表决定「执行会不会被拒」。
 */
export function canTransitionPhase(from, to) {
  const allowed = BATCH_TRANSITIONS?.[from];
  return Array.isArray(allowed) ? allowed.includes(to) : false;
}

/**
 * 预演一次批次干预：**纯读**，返回「若真执行会发生什么」。
 *
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
  // 参数面与工具层同口径（非法动作是**调用错误**，不是预演结果）
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
  /** 预测相位：只有「合法且确有变化」时才是目标相位；其余保持现状（预演不夸口）。 */
  let phase = from;

  if (from === target) {
    // 幂等：真执行时是 no-op（不重复写相位事件）⇒ 没有任何 lane 会被改
    warnings.push('no-op：批次相位已是 ' + target + '（真执行不会重复写相位事件）');
    skipped.push(...laneNames);
  } else if (!canTransitionPhase(from, target)) {
    // 非法迁移：真执行会按既有相位机报错 ⇒ 预演如实提示，且不声称相位会变
    warnings.push('非法迁移 ' + from + ' → ' + target + '：真执行将被相位机拒绝（预演不预测相位变化）');
    skipped.push(...laneNames);
  } else {
    phase = target;
    for (const name of laneNames) {
      // 干预**只动相位与留痕、绝不动成员态**；这里按「终态成员不再受干预影响」分账
      if (isMemberTerminal(batch.lanes[name])) skipped.push(name);
      else affected.push(name);
    }
    if (action === 'abort' && affected.length > 0) {
      // ⚠ 这里**不**用 `danglingLanesOf`：它的判据是「批次已终态 ∧ 成员仍非终态」，
      //   而 abort 合法的前提恰恰是批次**未**终态 ⇒ 在预演时刻它恒为空（写它会是个永不触发的分支）。
      //   预演能做的是**预测**：收口后这些非终态 lane 将变成悬挂成员，且不自动清理。
      warnings.push('abort 收口后 ' + affected.length + ' 个非终态 lane 将成为悬挂成员（不自动清理）：' + affected.join(', '));
    }
  }

  void deps; // 预留位：当前预演无需外部依赖（保持签名稳定，避免将来改调用点）
  return {
    batchId,
    action,
    phase,
    preview: {
      affected,
      skipped,
      warnings,
      // 展示位（不作判据）：判据一律看上面两个名集
      totals: { affected: affected.length, skipped: skipped.length },
    },
  };
}
