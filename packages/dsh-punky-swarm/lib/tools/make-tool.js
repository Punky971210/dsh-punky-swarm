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

// `makeTool`：工具**入参形状 / 前置校验**的唯一落点（S2）。
//
// ── 它是什么 ────────────────────────────────────────────────────────────────────
//   把「参数不合法就不进业务」这件事收成一个可复用的构造器：`execute` 的**最外层**先校验，
//   通过后才调用 `handler`。⇒ 非法入参**永远不会抵达** handler。
//
// ── 它不是什么（**禁做**：这道边界必须写死，否则会造出第二个治理门）────────────────
//   **禁止承载任何策略判定**：
//     · 权限 / 角色判定      → 归工具面守卫层（难度门禁口径，不在本文件）
//     · 模式门（是否放行）    → 归治理内核的模式开关
//     · 批状态 / 相位判定     → 归门禁模块（gates 目录）
//     · 重试策略 / 配额       → 归各自的执行层
//   本文件只回答一个问题：「**这几个字段是否**是**这些形状**」。任何「该不该允许」都不在这里。
//   理由：两份门禁必然漂移 —— 一旦这里也做策略判定，同一问题就有了两个答案源，
//   而调用方只会看见先执行的那一份。
//
// ── 零依赖 ──────────────────────────────────────────────────────────────────────
//   本仓 `package.json` **没有 `dependencies` 键**（生产零依赖），且 devDeps 无 schema 库
//   ⇒ **禁引任何 schema / 校验库**。以下校验全部手写、只用语言内置。

/** 拒态前缀（**普通 Error**；不进 `GATE_*` 拒码集合，不设 `err.code`）。 */
export const TOOL_INPUT_INVALID_PREFIX = 'tool-input-invalid:';

/** 支持的字段类型（纯形状，不含语义）。 */
export const TOOL_INPUT_TYPES = ['string', 'number', 'boolean', 'object', 'array'];

const typeOfValue = (value) => {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value; // 'string' | 'number' | 'boolean' | 'object' | 'undefined' | …
};

/** 构造拒态。**普通 `Error`、不设 `code`、消息以固定前缀开头**（不扩拒码集合）。 */
function rejectInput(toolName, field, detail) {
  return new Error(TOOL_INPUT_INVALID_PREFIX + ' ' + toolName + ' · ' + field + '：' + detail);
}

/**
 * 校验入参形状。**纯函数 + 抛错**；不做任何策略判定。
 *
 * @param {string} toolName 工具名（进拒态消息，便于定位）
 * @param {Record<string, object>} rules 每字段的**形状**规则：
 *   `{ type?: 'string'|'number'|'boolean'|'object'|'array', required?: boolean,
 *      nonEmpty?: boolean, pattern?: RegExp, enum?: unknown[] }`
 * @param {object} args 入参
 * @returns {true} 全部通过
 * @throws {Error} 首个不合格字段 ⇒ 普通 Error（前缀 `tool-input-invalid:`、无 `code`）
 */
export function assertToolInput(toolName, rules, args) {
  const input = args ?? {};
  for (const [field, rule] of Object.entries(rules ?? {})) {
    const value = input[field];
    const absent = value === undefined || value === null;

    if (rule?.required === true && absent) {
      throw rejectInput(toolName, field, '必填项缺失（required）');
    }
    if (absent) continue; // 可选且未提供 ⇒ 不做后续形状判定

    if (typeof rule?.type === 'string') {
      const actual = typeOfValue(value);
      if (actual !== rule.type) {
        throw rejectInput(toolName, field, '类型不符：期望 ' + rule.type + '，实际 ' + actual);
      }
    }
    if (rule?.nonEmpty === true && typeOfValue(value) === 'string' && value.length === 0) {
      throw rejectInput(toolName, field, '不得为空串（nonEmpty）');
    }
    if (rule?.pattern instanceof RegExp && typeOfValue(value) === 'string' && !rule.pattern.test(value)) {
      throw rejectInput(toolName, field, '不匹配 pattern ' + String(rule.pattern));
    }
    if (Array.isArray(rule?.enum) && !rule.enum.includes(value)) {
      throw rejectInput(toolName, field, '取值不在 enum 内：' + JSON.stringify(rule.enum));
    }
  }
  return true;
}

/**
 * 造一个**带前置校验**的工具。
 *
 * `execute` 的顺序（本文件最重要的三行）：
 *   1. `assertToolInput(...)`  ← 不合法即抛，**handler 不被调用**
 *   2. `handler(args, exec)`   ← 原样透传（不拷贝、不改写入参）
 *   3. `return` 上述结果       ← 返回值原样透传（不做包装/裁剪）
 *
 * @param {object} def
 * @param {string} def.name 工具名
 * @param {string} [def.description]
 * @param {object} [def.parameters] 对外参数声明（原样透出，供工具面注册）
 * @param {Record<string, object>} [def.rules] 形状规则（见 `assertToolInput`）
 * @param {(args: object, exec?: object) => unknown} def.handler 业务实现
 */
export function makeTool({ name, description = '', parameters = {}, rules = {}, handler }) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('makeTool rejected: `name` 须为非空字符串');
  }
  if (typeof handler !== 'function') {
    throw new Error('makeTool rejected: `handler` 须为函数');
  }
  return {
    name,
    description,
    parameters,
    output: parameters.output ?? undefined,
    async execute(args, exec) {
      assertToolInput(name, rules, args); // ① 前置校验（本文件唯一职责）
      return handler(args, exec); // ② ③ 原样透传
    },
  };
}
