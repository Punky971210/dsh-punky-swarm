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

// 策略**单调收紧**（I-23）：策略只允许变紧，永不放宽。
//
// ── 三轴方向（钉死）──────────────────────────────────────────────────────────────
//   `allowed`（许可集）  **只减不增**：`next.allowed ⊆ prev.allowed` —— 出现既有之外项 = 放宽
//   `denied`（拒绝集）   **只增不减**：`next.denied ⊇ prev.denied` —— 少了既有项 = **擦除历史拒绝**
//   `limits`（数值上限） **只降不升**：`next.limits[k] ≤ prev.limits[k]` —— 变大 = 放宽
//
// ── 为什么是「单调」而不是「等于」────────────────────────────────────────────────
//   单调允许**逐步收紧**（每次只动一轴也可），同时**堵死回退**：
//     · 一次写入若能把已收紧的项**加回去**（洗白）⇒ 拒（allowed 只减、limits 只降）；
//     · 一次写入若能把历史拒绝项**拿掉**（擦除）⇒ 拒（denied 只增）。
//   ⇒ 「历史」不是靠另存副本保住，而是靠**方向不可逆**自身保住：任何能撤销历史的写入都不合法。
//
// ── 单点判定 ────────────────────────────────────────────────────────────────────
//   全部判定收敛在 `monotonicViolations()` 一处；`isAtLeastAsTight()` 与 `tightenPolicy()`
//   **共用**它（前者判 boolean、后者据以抛错+归并结果）⇒ 不存在第二份方向判定会与之漂移。
//
// ── 边界 ────────────────────────────────────────────────────────────────────────
//   纯函数：**零依赖、零 IO、零事件**。不读盘、不写盘、不碰 store —— 落盘与行锁是调用方的事。

/** 拒态前缀（普通 `Error`；非 `GATE_`、无 `err.code`）。 */
export const POLICY_NOT_MONOTONIC = 'policy-not-monotonic:';

const memberSetOf = (value) => (Array.isArray(value) ? new Set(value) : (value instanceof Set ? new Set(value) : new Set()));
const limitsOf = (policy) => ({ ...(policy?.limits ?? {}) });

/** 归一化：`{ allowed: string[], denied: string[], limits: object }`（顺序稳定，便于深等比较）。 */
export function normalizePolicy(policy) {
  return {
    allowed: [...memberSetOf(policy?.allowed)].sort(),
    denied: [...memberSetOf(policy?.denied)].sort(),
    limits: limitsOf(policy),
  };
}

/**
 * **唯一判定实现**：返回违反单调的明细数组（空数组 = 至少同样紧）。
 * 三轴各一条规则，逐轴比对；不做 IO、不抛错。
 *
 * @param {object} prev 既有策略
 * @param {object} next 目标策略（缺项视为「该轴不变」）
 * @returns {string[]} 违反明细（每条含轴名 + 具体项 + 方向说明）
 */
function monotonicViolations(prev, next) {
  const before = normalizePolicy(prev);
  const violations = [];

  if (next?.allowed !== undefined) {
    const nextAllowed = memberSetOf(next.allowed);
    const addedBack = [...nextAllowed].filter((item) => !before.allowed.includes(item)).sort();
    if (addedBack.length > 0) {
      violations.push('allowed 放宽：新增 ' + JSON.stringify(addedBack) + '（只减不增）');
    }
  }

  if (next?.denied !== undefined) {
    const nextDenied = memberSetOf(next.denied);
    const erased = before.denied.filter((item) => !nextDenied.has(item)).sort();
    if (erased.length > 0) {
      violations.push('denied 擦除历史拒绝：' + JSON.stringify(erased) + '（只增不减）');
    }
  }

  const nextLimits = limitsOf(next);
  for (const [key, value] of Object.entries(nextLimits)) {
    const priorValue = before.limits[key];
    if (priorValue === undefined) continue; // 既有没该项 ⇒ 新增约束本身即收紧，不算违反
    if (typeof value === 'number' && typeof priorValue === 'number' && value > priorValue) {
      violations.push('limits 上调：' + key + ' ' + priorValue + ' → ' + value + '（只降不升）');
    }
  }

  return violations;
}

/**
 * 判定 `next` 是否**至少与 `prev` 同样紧**（三轴全部不违反）。
 * 测试与实现同源：`tightenPolicy` 内部调用的就是同一个 `monotonicViolations`。
 *
 * @returns {boolean}
 */
export function isAtLeastAsTight(prev, next) {
  return monotonicViolations(prev, next).length === 0;
}

const samePolicy = (a, b) => JSON.stringify(normalizePolicy(a)) === JSON.stringify(normalizePolicy(b));

/**
 * 收紧策略。**单调 + 幂等**；违反方向即抛。
 *
 * 归并语义（缺项 = 该轴不变）：
 *   · `allowed` → 取 `next.allowed`（判定已保证它是 `prev.allowed` 的子集）
 *   · `denied`  → 取 `prev.denied ∪ next.denied`（**显式并集**：历史拒绝项一个都不会丢）
 *   · `limits`  → `{...prev.limits, ...next.limits}`（缺项保留既有上限，不会被"写没"）
 *
 * @param {object} prev 既有策略
 * @param {object} next 目标策略
 * @returns {{policy: object, changed: boolean}} `changed=false` ⇒ 没有任何收紧（幂等重复调用）
 * @throws {Error} 违反单调 ⇒ `Error`，消息以 `policy-not-monotonic:` 开头并附明细
 */
export function tightenPolicy(prev, next) {
  const violations = monotonicViolations(prev, next);
  if (violations.length > 0) {
    throw new Error(POLICY_NOT_MONOTONIC + ' ' + violations.join('；'));
  }

  const before = normalizePolicy(prev);
  const policy = {
    allowed: next?.allowed !== undefined ? normalizePolicy({ allowed: next.allowed }).allowed : before.allowed,
    denied: [...new Set([...before.denied, ...normalizePolicy({ denied: next?.denied }).denied])].sort(),
    limits: { ...before.limits, ...limitsOf(next) },
  };

  return { policy, changed: !samePolicy(prev, policy) };
}
