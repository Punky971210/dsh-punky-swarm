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

// 完成契约表 ＋ 版本链（I-05）。纯逻辑：**不自建存储、不写盘、不落事件**。
//
// 三个字段都**真参与计算**（不是写进注释凑 T-cmd）：
//   · 契约的**身份** = 其规范化内容的 sha256（`canonicalSha256` / `contractIdOf`）；
//   · 版本链 = 新契约用 `supersedesContractId` 声明「我取代谁」⇒ 链**不可断**（断链即抛，禁静默接受）；
//   · 完成归属 = 契约声明的 `completionAuthority`（谁有权宣布这条批完成），按契约**逐条读回**。
//
// 为什么身份用内容哈希而不是自增号：契约一旦登记就不该被"就地升级"。
//   内容变 ⇒ 身份变 ⇒ 必须**新登记一条并声明取代谁**。自增号会允许"同一身份不同内容",
//   那正是版本链要防的那种静默漂移。
import { createHash } from 'node:crypto';

/** 断链拒因前缀（普通字符串：不新增 GATE_ 码族）。 */
export const SUPERSEDES_MISSING = 'supersedes-missing:';

/** 环状取代拒因前缀（防御；正常登记路径会先拦住，见 `registerContract`）。 */
export const SUPERSEDES_CYCLE = 'supersedes-cycle:';

/**
 * 规范化序列化：**对象键排序**、数组保序、标量带类型标记。
 *
 * ⚠ **禁用 `JSON.stringify` 直接哈希**：它的输出受**属性书写顺序**影响，
 *   而「同内容不同书写顺序」是同一份契约 —— 若直接哈希，同一契约会有两个身份，
 *   版本链立刻失去意义（每改一次字段顺序就"新版本"）。
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
 *
 * 两态（判据）：同内容但**键顺序打乱** ⇒ 摘要**相同**；任一字段值变化 ⇒ 摘要**不同**。
 */
export function canonicalSha256(contract) {
  return 'sha256:' + createHash('sha256').update(canonicalFormOf(contract, new Set()), 'utf8').digest('hex');
}

/** 契约身份 = 其规范化摘要（同一份契约在任何书写顺序下都是同一个 id）。 */
export function contractIdOf(contract) {
  return canonicalSha256(contract);
}

/** 表读写：同时接受 `Map` 与普通对象（**不新建存储**：表由调用方持有）。 */
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
 *
 * **fail-closed**：取代目标不存在 ⇒ 抛 `supersedes-missing: <id>` 且**零写入**
 *   —— 不允许「标记 broken 后放行」：一条断链的契约若进了表，后续 `chainOf` 就再也无法自证完整。
 *
 * @param {Map<string,object>|object} table 调用方持有的契约表
 * @param {object} contract 契约内容（可含 `supersedesContractId`）
 * @returns {{id: string, contract: object, superseded: string|null}}
 */
export function registerContract(table, contract) {
  if (!contract || typeof contract !== 'object') throw new TypeError('registerContract requires a contract object');
  const id = contractIdOf(contract);
  const existing = tableGet(table, id);
  if (existing !== null) {
    // 同内容再登记 ⇒ 幂等（同 id 即同契约，不做"覆盖"）
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
 * 版本链（新 → 旧）：`chainOf(table, C2)` ⇒ `[C2, C1, …]`。
 *
 * 读时**同样 fail-closed**：链上任一环缺失 ⇒ 抛（表可能被外部改动，登记期校验不足为凭）。
 * 未知 id ⇒ 抛 `supersedes-missing: <id>`（调用方要的是链，链不存在即错，**不用空数组冒充完整**）。
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
 *
 * 逐契约读回（两份契约声明不同 `completionAuthority` ⇒ 读回不同值）。
 * 未知契约 ⇒ `null`（查询语义，不抛：问"这份契约的归属是什么"，不存在就是没有）。
 */
export function completionAuthorityOf(table, id) {
  const record = tableGet(table, id);
  if (record === null) return null;
  return record.completionAuthority ?? null;
}
