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


import * as EVT from '../state/event-types.js';

export const DEFAULT_ESCALATION_PRIMITIVES = ['DENY', 'NARROW'];

/**
 * @param {Array<object>|null|undefined} events 批事件流（batch.events）——仅统计
 *   e.type === EVT_GOVERNANCE_REFUSAL 且 e.primitive ∈ primitives 且 ts 落在 [now-windowMs, now] 的事件；
 *   非目标事件 continue（不打断）；undefined/null → 0。
 * @param {{windowMs?: number, primitives?: string[], now?: number}} [options]
 *   - windowMs 滚动窗口（毫秒，默认 600000；边界精确：ts === now-windowMs 计、ts < now-windowMs 不计）
 *   - primitives 计入原语集（默认 ['DENY','NARROW']；DENY 计入、NARROW 计入、DEFER/PAUSE 默认不计）
 *   - now 评估基准时刻（epoch 毫秒；缺省 = 调用时刻——调用方应显式注入以保确定性）
 * @returns {number} 窗口内计入违规数（不含 threshold 比较——阈值比较在调用点）
 */
export const DEFAULT_ESCALATION_WINDOW_MS = 600000;
export function countGovernanceRefusals(events, { windowMs = DEFAULT_ESCALATION_WINDOW_MS, primitives = DEFAULT_ESCALATION_PRIMITIVES, now } = {}) {
  const evs = events ?? [];
  const t = typeof now === 'number' ? now : Date.now();
  const windowStart = t - windowMs;
  const primitiveSet = new Set(primitives);
  let count = 0;
  for (const e of evs) {
    if (!e || e.type !== EVT.EVT_GOVERNANCE_REFUSAL) continue;
    if (!primitiveSet.has(e.primitive)) continue;
    const tsMs = typeof e.ts === 'number' ? e.ts : Date.parse(String(e.ts ?? ''));
    if (Number.isNaN(tsMs)) continue;
    if (tsMs < windowStart) continue;
    count++;
  }
  return count;
}
