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

//   ⇒ 「历史」不是靠另存副本保住，而是靠**方向不可逆**自身保住：任何能撤销历史的写入都不合法。

export const POLICY_NOT_MONOTONIC = 'policy-not-monotonic:';

const memberSetOf = (value) => (Array.isArray(value) ? new Set(value) : (value instanceof Set ? new Set(value) : new Set()));
const limitsOf = (policy) => ({ ...(policy?.limits ?? {}) });

export function normalizePolicy(policy) {
  return {
    allowed: [...memberSetOf(policy?.allowed)].sort(),
    denied: [...memberSetOf(policy?.denied)].sort(),
    limits: limitsOf(policy),
  };
}

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
    if (priorValue === undefined) continue;
    if (typeof value === 'number' && typeof priorValue === 'number' && value > priorValue) {
      violations.push('limits 上调：' + key + ' ' + priorValue + ' → ' + value + '（只降不升）');
    }
  }

  return violations;
}

/**
 * @returns {boolean}
 */
export function isAtLeastAsTight(prev, next) {
  return monotonicViolations(prev, next).length === 0;
}

const samePolicy = (a, b) => JSON.stringify(normalizePolicy(a)) === JSON.stringify(normalizePolicy(b));

/**
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
