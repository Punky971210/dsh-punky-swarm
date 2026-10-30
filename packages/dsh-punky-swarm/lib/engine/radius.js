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
 * `lib/engine/radius.js` —— I-21 **爆炸半径观测**（采纳蓝图 D2）。
 *
 * ## 管什么
 * 计数「**同一个 run 内跨了多少个不同任务**」，并与上限比较，给出三元读数
 * `{ count, over, blocked }`。上限是**导出常量**（`MAX_RADIUS_CHANGED_TASKS`），
 * 判定处一律引用它（或构造参数 `limit`），**源码里不出现裸写的上限字面量**。
 *
 * ## 两种模式（**先观测、后收紧**，顺序不可倒）
 * | 模式 | 超限时 `over` | 超限时 `blocked` | 语义 |
 * |---|---|---|---|
 * | **`log_only`（缺省）** | `true` | **`false`** | **只观测、不阻止** —— 先拿到真实半径分布，再决定要不要拦 |
 * | **`enforce`** | `true` | **`true`** | 超限即拦 |
 *
 * ⚠ **本文件最容易做反的地方**：`log_only` 下「顺手也拦了」。那就不再是「只观测」，
 * 而是「无开关的强制」——上线前既无分布数据、又已经改变了行为。
 * ⇒ 判定式写成 `blocked = over && mode === 'enforce'`（**两个条件缺一不可**），
 * 并由 `over` 单独承载「超限事实」，与「是否拦」解耦：观测面与执行面不共用一位。
 *
 * ## 幂等
 * 同一 `(runId, taskId)` 记多次**只算一次**（按 run 内 task 集合去重）——
 * 半径的语义是「跨了多少个**不同**任务」，同一任务被反复触碰不构成半径扩张。
 *
 * ## 边界
 * - **不落盘、不落事件、不读时钟、不读环境**：纯内存计数（快照即读数）；
 * - **不做策略决策**：要不要把 `mode` 切到 `enforce`、超限后怎么处置（拒/告警/降级），**不归本文件**；
 * - 跨 run 不共享计数（每个 `runId` 独立），不设全局上限。
 */

/** 半径上限：**导出常量**（唯一真源；判定处引用它或其别名 `limit`，禁裸写字面量）。 */
export const MAX_RADIUS_CHANGED_TASKS = 20;

/** 合法模式集合（冻结；`setMode` 的取值域即此集合）。 */
export const RADIUS_MODES = Object.freeze(['log_only', 'enforce']);

/** 模式非法（普通 `Error`，无 `err.code`、非 `GATE_` 前缀：不扩拒码集合）。 */
const MODE_INVALID = 'radius-mode-invalid:';
/** 入参非法（调用缺陷，**不是**半径拒绝 —— 与本文件的 `blocked` 语义无关）。 */
const INPUT_INVALID = 'radius-input-invalid:';

/** 非空字符串校验（runId / taskId 都必须是可区分身份的字符串）。 */
function idOf(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(INPUT_INVALID + ' ' + field + ' 须为非空字符串（实际=' + JSON.stringify(value ?? null) + '）');
  }
  return value;
}

/**
 * 建一个半径计数器（**纯内存**：一个实例一份状态，互不共享）。
 *
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

  /** runId → Set<taskId>（每 run 独立；只增不去重之外的清除动作，本文件不提供 clear） */
  const changedByRun = new Map();

  /** 当前 run 的已变更任务集合（不存在则建空集，语义 = 该 run 还没有任何变更）。 */
  function tasksOf(runId) {
    let set = changedByRun.get(runId);
    if (!set) {
      set = new Set();
      changedByRun.set(runId, set);
    }
    return set;
  }

  /** 超限判定：**严格大于**上限才算超（达到上限本身仍在上界内）。比较走 `limit`，不写死字面量。 */
  function overOf(count) {
    return count > limit;
  }

  /** 是否拦截：**超限 ∧ enforce**，两个条件缺一不可（`log_only` 下永为 false）。 */
  function blockedOf(over) {
    return over && activeMode === 'enforce';
  }

  return {
    /**
     * 记录「该 run 变更了某任务」，返回**当前**三元读数。
     * 幂等：同一 `(runId, taskId)` 重复记录不改 `count`（返回读数与首次相同）。
     */
    record(runId, taskId) {
      const r = idOf(runId, 'runId');
      const t = idOf(taskId, 'taskId');
      const set = tasksOf(r);
      set.add(t); // Set 天然幂等：同一个 task 只占一个槽位
      const count = set.size;
      const over = overOf(count);
      return { count, over, blocked: blockedOf(over) };
    },

    /** 只读快照（不产生任何状态变更；未记录过的 run ⇒ `{count:0, over:false}`）。 */
    snapshot(runId) {
      const r = idOf(runId, 'runId');
      const count = changedByRun.get(r)?.size ?? 0;
      return { count, over: overOf(count) };
    },

    /** 切换模式；非法值 ⇒ 抛（普通 `Error`，前缀 `radius-mode-invalid:`）。返回切换后的模式。 */
    setMode(next) {
      if (!RADIUS_MODES.includes(next)) {
        throw new Error(MODE_INVALID + ' 非法模式：' + String(next) + '（合法值=' + RADIUS_MODES.join('/') + '）');
      }
      activeMode = next;
      return activeMode;
    },

    /** 当前模式（只读）。 */
    mode() {
      return activeMode;
    },

    /** 当前上限（只读；便于调用方回显"这套判定用的是哪个上限"）。 */
    limit() {
      return limit;
    },
  };
}
