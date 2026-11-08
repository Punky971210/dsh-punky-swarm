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

/**
 * ## 管什么（只有一件事）
 * ## 为什么上界必须是常量（而不是函数里写死一个字面量）
 */

/** 续跑上界：**唯一真源**（策略常量；判定处一律引用它，禁在比较里写死字面量）。 */
export const MAX_LIVENESS_CONTINUATION = 2;

export const CONTINUABLE_REASONS = Object.freeze(['empty_response']);

const NOT_CONTINUABLE = 'liveness-not-continuable:';
const LIMIT = 'liveness-limit:';

/**
 * 已续跑次数归一：缺省 / 非有限数 / 负数 ⇒ 0（= 尚未续跑过）。
 */
function continuationCountOf(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  const whole = Math.trunc(raw);
  return whole > 0 ? whole : 0;
}

/**
 * 续跑判定（**纯函数**：无 I/O、无时钟、无随机、不改入参）。
 * @param {{stopReason?: string, continuationCount?: number}} [input]
 * @returns {{continueAllowed: boolean, reason?: string}}
 */
export function continuationDecision(input = {}) {
  const facts = (input && typeof input === 'object') ? input : {};
  const stopReason = facts.stopReason;

  // 门 1（先行）：原因必须可续跑 —— 否证态（如 `completed`）即使次数未到上界也拒。
  if (!CONTINUABLE_REASONS.includes(stopReason)) {
    return {
      continueAllowed: false,
      reason: NOT_CONTINUABLE + ' stopReason=' + String(stopReason)
        + '（只有 ' + CONTINUABLE_REASONS.join('/') + ' 可续跑；空转可由证据面复核：lib/bus/index.js 的 classifyProgress；该实现当前生产零调用、冻结待用）',
    };
  }

  const used = continuationCountOf(facts.continuationCount);
  const limit = MAX_LIVENESS_CONTINUATION;
  if (used > limit) {
    return {
      continueAllowed: false,
      reason: LIMIT + ' continuationCount=' + used + ' 已超过上界 ' + limit
        + '（B4：空转不产第 3 次 run）',
    };
  }

  return { continueAllowed: true };
}
