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

// @ts-check

// 派发面 · 模式/层级闸：tier-C 判据、preset、子会话判定、模式开关归一。

export const REPORT_CHANNEL = Object.freeze({ leader: 'broadcast', owner: 'inbox' });

export function evaluateTierCDispatch({ tier, toolName, argsText, handleCheck }) {
  const isDispatchTool = toolName === 'subagent' || toolName === 'subagent_fork';
  if (!isDispatchTool || tier !== 'C') {
    return { applies: false, ok: true, handleReason: null, warnNote: null };
  }
  const r = typeof handleCheck === 'function' ? handleCheck(argsText) : { ok: false, reason: 'no-handle-check' };
  if (r.ok) return { applies: true, ok: true, handleReason: null, warnNote: null };
  const handleReason = r.reason ?? 'invalid-handle';
  return {
    applies: true, ok: true, handleReason,
    warnNote: 'dispatch without valid lane handle under tier C（留痕不拦；`enforce` 拒态已随码删除且**勿回加**）'
      + ' · tool=' + toolName + ' · handle=' + handleReason
      + ' —— 仍建议：先 `lane_dispatch({ batchId, lane })` 取句柄并把 `firstLine` 写入子代理任务包首行。',
  };
}

export const MODE_INACTIVE_CODE = 'GATE_MODE_INACTIVE';

export function presetOfSession(exec) {
  const p = exec?.agent?.session?.header?.agentPreset;
  return typeof p === 'string' && p ? p : null;
}

export function isChildSession(exec) {
  const h = exec?.agent?.session?.header;
  return !!(h && (h.delegationDepth > 0 || h.parentSession));
}

export function normalizeModeGate(raw, warn) {
  if (raw === undefined || raw === null) return null;
  if (Array.isArray(raw)) {
    const bad = raw.filter((x) => typeof x !== 'string' || x === '');
    if (bad.length) {
      warn?.('modes.gate 元素须为非空字符串（got ' + JSON.stringify(bad) + '）⇒ 回落「全模式生效」');
      return null;
    }
    return [...raw];
  }
  warn?.('modes.gate 须为字符串数组或 null（got ' + JSON.stringify(raw) + '）⇒ 回落「全模式生效」');
  return null;
}

/**
 * @param config 当前生效配置快照
 * @param exec   工具调用上下文
 * @returns {boolean} true = 启用（旧行为）；false = 本模式不生效 ⇒ 门禁/计数/套件工具全部不介入
 */
export function modeActiveFor(config, exec, warn) {
  const gate = normalizeModeGate(config?.modes?.gate, warn);
  if (gate === null) return true;
  if (isChildSession(exec)) return true;
  const preset = presetOfSession(exec);
  return preset !== null && gate.includes(preset);
}
