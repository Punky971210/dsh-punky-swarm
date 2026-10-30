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

// 执行面策略的**唯一纯函数实现**（I-24）。
//
// 为什么必须纯（不是洁癖，是可测性）：
//   判定若在 guard 闭包里现场取值（配置快照、时钟、句柄、会话），那它只能被「装起来跑一遍」检验，
//   而装起来的那套东西本身也会漂移——于是判定和判定的检验一起长在同一个真源上，谁也证不了谁。
//   这里把输入**全部作为参数**：工具名、参数、白名单、事实。相同输入必然相同输出，测试直接传对象即可。
//
// 纪律（本文件**全文**成立）：不做任何外部读取，不取当前时间，不用随机数；
//   需要时间或审批事实时，由调用方经 `facts` 注入。
//
// 单点声明：`canonicalDigest` 是本仓**唯一**的摘要实现 —— 三态路（I-19）的「签名参数重放」直接复用它。
//   再造第二份摘要，等于给「同一组参数」两个身份。
import { createHash } from 'node:crypto';

/** 未命中白名单的拒因前缀（普通字符串，不新增 GATE_ 码族）。 */
export const ALLOWLIST_DENIED = 'allowlist-denied:';

/** 命中但需人工批准的标识前缀。 */
export const ASK_REQUIRED = 'approval-needed:';

/**
 * 规范化值 → 稳定字符串（canonical form）。
 *
 * 规则（写死，供重放方对齐）：
 *   · 对象：**键排序后**逐对输出 ⇒ 键的书写顺序不影响摘要；
 *   · 数组：**保持顺序**（顺序是语义的一部分）；
 *   · 标量：**带类型前缀**（`n:` / `s:` / `b:` / `null` / `undefined`）⇒ `1` 与 `'1'` 摘要必然不同。
 */
function canonicalFormOf(value, seen) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const type = typeof value;
  if (type === 'number') return 'n:' + String(value);
  if (type === 'boolean') return 'b:' + String(value);
  if (type === 'bigint') return 'n:' + value.toString(10) + 'n';
  if (type === 'string') return 's:' + JSON.stringify(value);
  if (type === 'function' || type === 'symbol') return type + ':' + String(value);

  // 引用环：显式标注（不静默展开，也不抛——摘要仍需可算）
  const trail = seen ?? new Set();
  if (trail.has(value)) return '[circular]';
  trail.add(value);
  try {
    if (Array.isArray(value)) return '[' + value.map((item) => canonicalFormOf(item, trail)).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalFormOf(value[key], trail)).join(',') + '}';
  } finally {
    trail.delete(value);
  }
}

/**
 * 稳定摘要：`sha256:<hex>`。
 *
 * **唯一实现**（全仓仅此一处）。用于「签名参数重放」：同一组参数 ⇒ 同一摘要；
 * 参数**类型**或（数组）**顺序**变化 ⇒ 摘要必变。
 *
 * @param {unknown} args 待摘要的参数（任意可序列化结构）
 * @returns {string}
 */
export function canonicalDigest(args) {
  return 'sha256:' + createHash('sha256').update(canonicalFormOf(args, new Set()), 'utf8').digest('hex');
}

/** 白名单条目 → 匹配面：字符串即工具名；对象可取 `tool` / `tools`。 */
function toolNamesOf(entry) {
  if (typeof entry === 'string') return [entry];
  if (!entry || typeof entry !== 'object') return [];
  if (typeof entry.tool === 'string') return [entry.tool];
  if (Array.isArray(entry.tools)) return entry.tools.filter((n) => typeof n === 'string');
  return [];
}

/** 取该工具对应的条目声明（用于 requireApproval / args 约束）。 */
function entryFor(allowlist, toolName) {
  for (const entry of allowlist) {
    if (toolNamesOf(entry).includes(toolName)) return entry;
  }
  return null;
}

/** 参数约束是否满足：`entry.args` 缺省 = 不约束；给定时逐键严格相等（浅比较，够用且可预期）。 */
function argsSatisfy(entry, args) {
  if (!entry || typeof entry !== 'object') return true;
  const constraint = entry.args;
  if (!constraint || typeof constraint !== 'object') return true;
  const actual = args && typeof args === 'object' ? args : {};
  return Object.keys(constraint).every((key) => actual[key] === constraint[key]);
}

/** 是否被标记为「需人工批准」。 */
function requiresApprovalOf(entry) {
  return Boolean(entry && typeof entry === 'object' && (entry.requireApproval === true || entry.ask === true));
}

/**
 * 策略判定（纯）：`{ decision: 'allow' | 'deny' | 'ask', reason?: string }`。
 *
 * 语义（钉死）：
 *   · **default deny** —— 白名单为空或未命中 ⇒ `deny` + `allowlist-denied: <tool>`
 *     （**刻意不做「空即放行」**：白名单的用途是收窄，空表意味着没有任何工具被许可）；
 *   · 命中且参数在约束内 ⇒ `allow`；
 *   · 命中但被标记需批准 ⇒ `ask` + `approval-needed: <tool>`；若 `facts.approval === true`（调用方已拿到批准）⇒ `allow`。
 *
 * @param {{toolName?: string, args?: object, allowlist?: Array<string|object>, facts?: object}} input
 * @returns {{decision: 'allow'|'deny'|'ask', reason?: string}}
 */
export function decide(input = {}) {
  const toolName = typeof input.toolName === 'string' ? input.toolName : '';
  const allowlist = Array.isArray(input.allowlist) ? input.allowlist : [];
  const args = input.args && typeof input.args === 'object' ? input.args : {};
  const facts = input.facts && typeof input.facts === 'object' ? input.facts : {};

  const entry = entryFor(allowlist, toolName);
  if (entry === null || toolName.length === 0) {
    return { decision: 'deny', reason: ALLOWLIST_DENIED + ' ' + toolName };
  }
  // 参数越界 ⇒ 与「未命中」同路拒（白名单里写明的参数范围就是许可边界的全部）
  if (!argsSatisfy(entry, args)) {
    return { decision: 'deny', reason: ALLOWLIST_DENIED + ' ' + toolName };
  }
  if (requiresApprovalOf(entry) && facts.approval !== true) {
    return { decision: 'ask', reason: ASK_REQUIRED + ' ' + toolName };
  }
  return { decision: 'allow' };
}
