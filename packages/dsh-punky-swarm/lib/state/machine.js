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

// Machine：状态迁移判定 + 棘轮规则消费 + lane 派发条件校验
// archive 逻辑归 archive.js、needHuman 逻辑归 gates.js/store.js，不得写入本文件。
import { DEFAULT_MEMBER_RULES, DEFAULT_BATCH_RULES } from './machine-rules.js';
import { findTask } from './task-utils.js';


export function applyMemberTransition(from, to, { rules } = {}) {
  const table = rules?.memberRules ?? DEFAULT_MEMBER_RULES;
  if (!table || typeof table !== 'object' || !Array.isArray(table[from])) {
    return { ok: false, code: 'INVALID_MEMBER_TRANSITION' };
  }
  return table[from].includes(to)
    ? { ok: true }
    : { ok: false, code: 'INVALID_MEMBER_TRANSITION' };
}

export function applyBatchTransition(from, to, { rules } = {}) {
  const table = rules?.batchRules ?? DEFAULT_BATCH_RULES;
  if (!table || typeof table !== 'object' || !Array.isArray(table[from])) {
    return { ok: false, code: 'INVALID_BATCH_TRANSITION' };
  }
  return table[from].includes(to)
    ? { ok: true }
    : { ok: false, code: 'INVALID_BATCH_TRANSITION' };
}

export function checkDispatchCondition(sessionId, batchId, batch, lane, { fileExists }) {
  const task = findTask(batch, lane);
  const condition = task?.condition ?? null;
  if (condition == null) return { ok: true };
  if (typeof fileExists !== 'function') {
    throw new Error('checkDispatchCondition: fileExists must be injected (DI)');
  }
  const missing = [];
  for (const c of condition) {
    if (!c || typeof c.path !== 'string' || !c.path) continue;
    if (!fileExists(c.path)) missing.push(c.path);
  }
  return missing.length ? { ok: false, missing } : { ok: true };
}
