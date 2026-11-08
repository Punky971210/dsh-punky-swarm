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


/** 半径上限：**导出常量**（唯一真源；判定处引用它或其别名 `limit`，禁裸写字面量）。 */
export const MAX_RADIUS_CHANGED_TASKS = 20;

export const RADIUS_MODES = Object.freeze(['log_only', 'enforce']);

const MODE_INVALID = 'radius-mode-invalid:';
const INPUT_INVALID = 'radius-input-invalid:';

function idOf(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(INPUT_INVALID + ' ' + field + ' 须为非空字符串（实际=' + JSON.stringify(value ?? null) + '）');
  }
  return value;
}

/**
 * @param {{mode?: 'log_only'|'enforce', limit?: number}} [options]
 *   `mode` 缺省 **`log_only`**（先观测）；`limit` 缺省 = `MAX_RADIUS_CHANGED_TASKS`。
 * @returns {{
 *   record: (runId: string, taskId: string) => {count: number, over: boolean, blocked: boolean},
 *   snapshot: (runId: string) => {count: number, over: boolean},
 *   setMode: (next: 'log_only'|'enforce') => string,
 *   mode: () => 'log_only'|'enforce',
 *   limit: () => number
 * }}
 */
export function createRadiusCounter({ mode = 'log_only', limit = MAX_RADIUS_CHANGED_TASKS } = {}) {
  let activeMode = mode;
  if (!RADIUS_MODES.includes(activeMode)) {
    throw new Error(MODE_INVALID + ' 缺省模式非法：' + String(activeMode) + '（合法值=' + RADIUS_MODES.join('/') + '）');
  }
  // 上限必须为正有限数；非法 ⇒ fail-fast（否则 `over` 恒假，观测面静默失效 —— 比抛错危险得多）
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    throw new Error(INPUT_INVALID + ' limit 须为正有限数（实际=' + String(limit) + '）');
  }

  const changedByRun = new Map();

  function tasksOf(runId) {
    let set = changedByRun.get(runId);
    if (!set) {
      set = new Set();
      changedByRun.set(runId, set);
    }
    return set;
  }

  function overOf(count) {
    return count > limit;
  }

  function blockedOf(over) {
    return over && activeMode === 'enforce';
  }

  return {
    record(runId, taskId) {
      const r = idOf(runId, 'runId');
      const t = idOf(taskId, 'taskId');
      const set = tasksOf(r);
      set.add(t);
      const count = set.size;
      const over = overOf(count);
      return { count, over, blocked: blockedOf(over) };
    },

    snapshot(runId) {
      const r = idOf(runId, 'runId');
      const count = changedByRun.get(r)?.size ?? 0;
      return { count, over: overOf(count) };
    },

    setMode(next) {
      if (!RADIUS_MODES.includes(next)) {
        throw new Error(MODE_INVALID + ' 非法模式：' + String(next) + '（合法值=' + RADIUS_MODES.join('/') + '）');
      }
      activeMode = next;
      return activeMode;
    },

    mode() {
      return activeMode;
    },

    limit() {
      return limit;
    },
  };
}
