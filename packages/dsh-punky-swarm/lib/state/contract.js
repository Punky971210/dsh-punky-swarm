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

import { createHash } from 'node:crypto';

/** 断链拒因前缀（普通字符串：不新增 GATE_ 码族）。 */
export const SUPERSEDES_MISSING = 'supersedes-missing:';

/** 环状取代拒因前缀（防御；正常登记路径会先拦住，见 `registerContract`）。 */
export const SUPERSEDES_CYCLE = 'supersedes-cycle:';

/**
 * 规范化序列化：**对象键排序**、数组保序、标量带类型标记。
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
 * 契约的规范化摘要（**全仓唯一实现**）：`sha256:<64 hex>`。
 */
export function canonicalSha256(contract) {
  return 'sha256:' + createHash('sha256').update(canonicalFormOf(contract, new Set()), 'utf8').digest('hex');
}

/** 契约身份 = 其规范化摘要（同一份契约在任何书写顺序下都是同一个 id）。 */
export function contractIdOf(contract) {
  return canonicalSha256(contract);
}

function tableGet(table, id) {
  if (table instanceof Map) return table.get(id) ?? null;
  if (table && typeof table === 'object' && Object.prototype.hasOwnProperty.call(table, id)) return table[id];
  return null;
}

function tableSet(table, id, record) {
  if (table instanceof Map) { table.set(id, record); return record; }
  if (table && typeof table === 'object') { table[id] = record; return record; }
  throw new TypeError('registerContract requires a Map or a plain object table');
}

/**
 * 登记契约：校验 `supersedesContractId` 指向的契约**确实存在**，然后写入调用方提供的表。
 * **fail-closed**：取代目标不存在 ⇒ 抛 `supersedes-missing: <id>` 且**零写入**
 * @param {Map<string,object>|object} table 调用方持有的契约表
 * @param {object} contract 契约内容（可含 `supersedesContractId`）
 * @returns {{id: string, contract: object, superseded: string|null}}
 */
export function registerContract(table, contract) {
  if (!contract || typeof contract !== 'object') throw new TypeError('registerContract requires a contract object');
  const id = contractIdOf(contract);
  const existing = tableGet(table, id);
  if (existing !== null) {
    return { id, contract: existing, superseded: existing.supersedesContractId ?? null };
  }

  const supersedes = typeof contract.supersedesContractId === 'string' && contract.supersedesContractId.length > 0
    ? contract.supersedesContractId
    : null;
  if (supersedes !== null) {
    const target = tableGet(table, supersedes);
    if (target === null) throw new Error(SUPERSEDES_MISSING + ' ' + supersedes);
    // 环检测：顺着被取代者的链走，若回到自身 ⇒ 拒绝（否则 `chainOf` 会无限展开）
    let cursor = target;
    const seen = new Set([id]);
    while (cursor) {
      const nextId = typeof cursor.supersedesContractId === 'string' ? cursor.supersedesContractId : null;
      if (nextId === null) break;
      if (seen.has(nextId)) throw new Error(SUPERSEDES_CYCLE + ' ' + id);
      seen.add(nextId);
      cursor = tableGet(table, nextId);
      if (cursor === null) throw new Error(SUPERSEDES_MISSING + ' ' + nextId);
    }
  }

  const record = { ...contract, contractId: id };
  tableSet(table, id, record);
  return { id, contract: record, superseded: supersedes };
}

/**
 * 读时**同样 fail-closed**：链上任一环缺失 ⇒ 抛（表可能被外部改动，登记期校验不足为凭）。
 */
export function chainOf(table, id) {
  if (typeof id !== 'string' || id.length === 0) throw new Error(SUPERSEDES_MISSING + ' ' + String(id));
  const chain = [];
  const seen = new Set();
  let cursor = tableGet(table, id);
  if (cursor === null) throw new Error(SUPERSEDES_MISSING + ' ' + id);
  while (cursor) {
    const cursorId = typeof cursor.contractId === 'string' ? cursor.contractId : contractIdOf(cursor);
    if (seen.has(cursorId)) throw new Error(SUPERSEDES_CYCLE + ' ' + cursorId);
    seen.add(cursorId);
    chain.push(cursor);
    const nextId = typeof cursor.supersedesContractId === 'string' && cursor.supersedesContractId.length > 0
      ? cursor.supersedesContractId
      : null;
    if (nextId === null) break;
    const next = tableGet(table, nextId);
    if (next === null) throw new Error(SUPERSEDES_MISSING + ' ' + nextId);
    cursor = next;
  }
  return chain;
}

/**
 * 完成归属：该契约声明的「谁有权宣布完成」。
 */
export function completionAuthorityOf(table, id) {
  const record = tableGet(table, id);
  if (record === null) return null;
  return record.completionAuthority ?? null;
}
