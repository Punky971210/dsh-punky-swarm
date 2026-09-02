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

// M5-a 违规计数内核（C5）：纯函数滚动时间窗评估 + 类别（primitive）过滤。
// 计数事实源 = 批事件流（batch.events，读取幂等、可重放）；本模块只做「读 + 统计」，
// 零 IO / 零副作用 / 不 mutate 入参；threshold 比较在调用点（§3 exec-wiring），本函数只返回窗口计数。
// 窗口语义（非「连续」语义）：统计 ts ∈ [now-windowMs, now] 的目标事件数——穿插非目标事件
// （member.settled / worktree.checkpoint / batch.phase 等）不打断、不参与（镜像 countConsecutiveFailedSettles
// 的「非目标事件 continue」模式，lib/state/store.js:54-59）。
// 仅可 import lib/state/event-types.js 常量（零依赖纯模块，无循环依赖）。

import * as EVT from '../state/event-types.js';

// 配置默认值对齐（§4 escalation 键；纯函数不读配置源——值由调用方注入，签名内默认缺省对齐语义）：
//   windowMs 默认 600000（10 分钟）；primitives 默认 ['DENY','NARROW']（DENY/NARROW 计入，DEFER/PAUSE
//   默认不计、可显式扩入；REQUIRE_APPROVAL 与状态门收据（ruleRefs=[]）由调用方过滤，本函数不判 ruleRefs）。
export const DEFAULT_ESCALATION_WINDOW_MS = 600000;
export const DEFAULT_ESCALATION_PRIMITIVES = ['DENY', 'NARROW'];

// 目标事件类型（C10 常量：governance.refusal）——recordGovernanceRefusal 追加（C4）→ 本函数读端。
export const GOVERNANCE_REFUSAL_EVENT_TYPE = EVT.EVT_GOVERNANCE_REFUSAL;

/**
 * 违规计数纯函数（设计 C5 / plan §2.2）：
 * 从批事件流统计滚动时间窗内可计入的 governance.refusal 事件数。
 *
 * @param {Array<object>|null|undefined} events 批事件流（batch.events）——仅统计
 *   e.type === EVT_GOVERNANCE_REFUSAL 且 e.primitive ∈ primitives 且 ts 落在 [now-windowMs, now] 的事件；
 *   非目标事件 continue（不打断）；undefined/null → 0（T1）。
 * @param {{windowMs?: number, primitives?: string[], now?: number}} [options]
 *   - windowMs 滚动窗口（毫秒，默认 600000；边界精确：ts === now-windowMs 计、ts < now-windowMs 不计，T2）
 *   - primitives 计入原语集（默认 ['DENY','NARROW']；DENY 计入、NARROW 计入、DEFER/PAUSE 默认不计，T3）
 *   - now 评估基准时刻（epoch 毫秒；缺省 = 调用时刻——调用方应显式注入以保确定性）
 * @returns {number} 窗口内计入违规数（不含 threshold 比较——阈值比较在调用点）
 */
export function countGovernanceRefusals(events, { windowMs = DEFAULT_ESCALATION_WINDOW_MS, primitives = DEFAULT_ESCALATION_PRIMITIVES, now } = {}) {
  const evs = events ?? [];
  const t = typeof now === 'number' ? now : Date.now();
  const windowStart = t - windowMs;
  const primitiveSet = new Set(primitives);
  let count = 0;
  for (const e of evs) {
    // 非目标事件：不打断、不参与（窗口语义关键——穿插任意事件不影响计数，T4/T5）
    if (!e || e.type !== EVT.EVT_GOVERNANCE_REFUSAL) continue;
    // 类别过滤（C3 纯函数侧）：仅 primitive ∈ primitives 计入（T3）
    if (!primitiveSet.has(e.primitive)) continue;
    // ts 归一化：批事件流 ts 由 newEvent 基座携带（ISO 串，store.js:113）；兼容 epoch 数值
    const tsMs = typeof e.ts === 'number' ? e.ts : Date.parse(String(e.ts ?? ''));
    // ts 缺失/非法 → 无法判定窗口 → 不计（防御，不 throw——纯函数容错）
    if (Number.isNaN(tsMs)) continue;
    // 窗口边界：ts < now-windowMs 不计；ts === now-windowMs 计（边界精确，T2）
    if (tsMs < windowStart) continue;
    count++;
  }
  return count;
}
