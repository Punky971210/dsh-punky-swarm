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

// 为什么必须纯（不是洁癖，是可测性）：
//   判定若在 guard 闭包里现场取值（配置快照、时钟、句柄、会话），那它只能被「装起来跑一遍」检验，
//   而装起来的那套东西本身也会漂移——于是判定和判定的检验一起长在同一个真源上，谁也证不了谁。
// 纪律（本文件**全文**成立）：不做任何外部读取，不取当前时间，不用随机数；
//   需要时间或审批事实时，由调用方经 `facts` 注入。
import { createHash } from 'node:crypto';

export const ALLOWLIST_DENIED = 'allowlist-denied:';

export const ASK_REQUIRED = 'approval-needed:';

function canonicalFormOf(value, seen) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const type = typeof value;
  if (type === 'number') return 'n:' + String(value);
  if (type === 'boolean') return 'b:' + String(value);
  if (type === 'bigint') return 'n:' + value.toString(10) + 'n';
  if (type === 'string') return 's:' + JSON.stringify(value);
  if (type === 'function' || type === 'symbol') return type + ':' + String(value);

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
 * @param {unknown} args 待摘要的参数（任意可序列化结构）
 * @returns {string}
 */
export function canonicalDigest(args) {
  return 'sha256:' + createHash('sha256').update(canonicalFormOf(args, new Set()), 'utf8').digest('hex');
}

function toolNamesOf(entry) {
  if (typeof entry === 'string') return [entry];
  if (!entry || typeof entry !== 'object') return [];
  if (typeof entry.tool === 'string') return [entry.tool];
  if (Array.isArray(entry.tools)) return entry.tools.filter((n) => typeof n === 'string');
  return [];
}

function entryFor(allowlist, toolName) {
  for (const entry of allowlist) {
    if (toolNamesOf(entry).includes(toolName)) return entry;
  }
  return null;
}

function argsSatisfy(entry, args) {
  if (!entry || typeof entry !== 'object') return true;
  const constraint = entry.args;
  if (!constraint || typeof constraint !== 'object') return true;
  const actual = args && typeof args === 'object' ? args : {};
  return Object.keys(constraint).every((key) => actual[key] === constraint[key]);
}

function requiresApprovalOf(entry) {
  return Boolean(entry && typeof entry === 'object' && (entry.requireApproval === true || entry.ask === true));
}

/**
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
  if (!argsSatisfy(entry, args)) {
    return { decision: 'deny', reason: ALLOWLIST_DENIED + ' ' + toolName };
  }
  if (requiresApprovalOf(entry) && facts.approval !== true) {
    return { decision: 'ask', reason: ASK_REQUIRED + ' ' + toolName };
  }
  return { decision: 'allow' };
}
