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
// 本文件只含迁移判定 + 派发条件——
// archive 逻辑归 archive.js、needHuman 逻辑归 gates.js/store.js，不得写入本文件。
// 纯逻辑（无 IO）：fileExists 经 DI 注入（store.js 接线时绑定 artifactsDir），可独立单测。
import { DEFAULT_MEMBER_RULES, DEFAULT_BATCH_RULES } from './machine-rules.js';
// P1-04 单点：findTask 收敛至 task-utils.js（原 :69 本地定义删除——原「避免 machine→gates 依赖」由零依赖单点承担）
import { findTask } from './task-utils.js';

// 缺省规则 = 默认表（与 schema 常量同引用，行为不变）
export const RATCHET_RULES = DEFAULT_MEMBER_RULES;

// 成员迁移判定：查规则表（rules 可注入；缺省 = 默认强约束）
// 返回 { ok: true } | { ok: false, code: 'INVALID_MEMBER_TRANSITION' }
export function applyMemberTransition(from, to, { rules } = {}) {
  const table = rules?.memberRules ?? DEFAULT_MEMBER_RULES;
  if (!table || typeof table !== 'object' || !Array.isArray(table[from])) {
    return { ok: false, code: 'INVALID_MEMBER_TRANSITION' };
  }
  return table[from].includes(to)
    ? { ok: true }
    : { ok: false, code: 'INVALID_MEMBER_TRANSITION' };
}

// 批次阶段迁移判定：同上（batchRules 表）
export function applyBatchTransition(from, to, { rules } = {}) {
  const table = rules?.batchRules ?? DEFAULT_BATCH_RULES;
  if (!table || typeof table !== 'object' || !Array.isArray(table[from])) {
    return { ok: false, code: 'INVALID_BATCH_TRANSITION' };
  }
  return table[from].includes(to)
    ? { ok: true }
    : { ok: false, code: 'INVALID_BATCH_TRANSITION' };
}

// 派发条件校验：读任务 condition（对象数组 {path, exists}，建批时已规范化）→ 逐个 fileExists → AND 求值。
// fileExists(path) 由 store.js 注入（相对路径解析在注入侧，本函数保持纯逻辑）。
// 无 condition → 恒 { ok: true }。返回 { ok: true } | { ok: false, missing: [path...] }。
export function checkDispatchCondition(sessionId, batchId, batch, lane, { fileExists }) {
  const task = findTask(batch, lane);
  const condition = task?.condition ?? null;
  if (condition == null) return { ok: true };
  if (typeof fileExists !== 'function') {
    throw new Error('checkDispatchCondition: fileExists must be injected (DI)');
  }
  const missing = [];
  for (const c of condition) {
    if (!c || typeof c.path !== 'string' || !c.path) continue; // 防御：非法元素按恒满足跳过（建批时已静态校验）
    if (!fileExists(c.path)) missing.push(c.path);
  }
  return missing.length ? { ok: false, missing } : { ok: true };
}
