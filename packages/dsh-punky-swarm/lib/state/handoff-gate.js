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

//   **为什么下沉**：原实装住在 `wave-plan.js`，而 `state/gates/entry.js` / `state/gates/handoff.js`
export const HANDOFF_GATE_ENV = 'PSWARM_HANDOFF_GATE';

const asBool = (v) => (typeof v === 'boolean' ? v : null);
/** 解析门态（**唯一真源**）。优先级（**逐段独立**）：段级 runtime 键 > 段内 `enabled` > env 兜底 > 缺省关。
 *  连带开另一段）⇒ 未显式声明的段一律走 `enabled`/env/缺省，不连坐。 */
export function handoffGateStateOf(liveConfig, env = process.env) {
  const raw = String(env?.[HANDOFF_GATE_ENV] ?? '').toLowerCase();
  const envOn = raw === '1' || raw === 'true' || raw === 'on';
  const gates = (liveConfig && typeof liveConfig === 'object' && !Array.isArray(liveConfig))
    ? liveConfig.gates : null;
  const handoff = (gates && typeof gates === 'object' && !Array.isArray(gates))
    ? gates.handoff : null;
  if (handoff && typeof handoff === 'object' && !Array.isArray(handoff)) {
    const h = handoff;
    const enabled = asBool(h.enabled);
    const eRaw = asBool(h.entry);
    const sRaw = asBool(h.settle);
    const entry = eRaw ?? enabled ?? envOn;
    const settle = sRaw ?? enabled ?? envOn;
    const explicit = eRaw !== null || sRaw !== null || enabled !== null;
    if (explicit) return { entry, settle, source: 'runtime' };
  }
  if (envOn) return { entry: true, settle: true, source: 'env' };
  return { entry: false, settle: false, source: 'default' };
}
/** 单段判定（薄封装；三处消费点用这个）。 */
export function handoffGateEnabledOf(liveConfig, stage = 'entry', env = process.env) {
  return handoffGateStateOf(liveConfig, env)[stage];
}
