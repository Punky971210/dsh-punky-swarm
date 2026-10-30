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

// 幂等回执指纹（I-06）：**纯函数** —— 指纹、查重、幂等登记。
//
// ── 与持久化的边界（**零重叠**，刻意划死）────────────────────────────────────────
//   治理层已有一个拒收据**持久化**模块（写盘/读盘）在 `lib/governance/` 下。
//   本文件**只做内存里的纯计算**：零 IO、不写盘、不读盘、**不引用那个模块**。
//   ⇒ 想落盘请由调用方拿着 `recordReceipt()` 返回的 ledger 交给持久化层。
//   两边若各写一份持久化，就会出现「同一份收据两个真源」——那正是本仓反复清理的病。
//
// ── 为什么指纹是「op + args」而不是「op」──────────────────────────────────────────
//   只按操作名算指纹 ⇒ 「同一个工具、不同参数」被判成同一次重放 ⇒ **假幂等**：
//   真正要防的是「同一次操作被重放两次」，而不是「同一个工具只许用一次」。
//   所以 args **任一字段变化**都必须让指纹变化。
//
// ── 零环境依赖 ─────────────────────────────────────────────────────────────────
//   不读文件系统、不读环境变量、不取系统时间、不用随机数
//   ⇒ 同一输入在任何机器、任何时刻都给同一指纹（可复算、可对账）。
//   需要时间戳/随机值的地方，由**调用方传入**（本文件不制造不确定性）。

import { createHash } from 'node:crypto';

/** 幂等拒因前缀（普通字符串；非 `GATE_`、无 `err.code`）。 */
export const RECEIPT_ALREADY_APPLIED = 'receipt-already-applied:';

/**
 * 规范化：对象键**排序**、数组**保序**、标量带类型前缀（`n:`/`s:`/`b:`/`z:`/`u:`）。
 * 目的：键序变化不影响指纹；而 `1` 与 `'1'`、`[1,2]` 与 `[2,1]` 必须不同。
 */
function canonicalOf(value) {
  if (value === undefined) return 'u:';
  if (value === null) return 'z:';
  if (typeof value === 'number') return 'n:' + String(value);
  if (typeof value === 'boolean') return 'b:' + String(value);
  if (typeof value === 'string') return 's:' + JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalOf).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalOf(value[k])).join(',') + '}';
  }
  return 'x:' + String(value);
}

/**
 * 指纹：`op` + `args` 的规范化摘要 ⇒ `'sha256:<hex>'`。
 *
 * @param {{name?: string, toolName?: string, args?: unknown}} op 操作描述（`args` 缺省 = 无参）
 * @returns {string} 稳定的摘要串
 */
export function receiptFingerprint(op) {
  const name = typeof op?.name === 'string' ? op.name : (typeof op?.toolName === 'string' ? op.toolName : '');
  const args = op?.args === undefined ? {} : op.args;
  const material = 'name=' + name + ';args=' + canonicalOf(args);
  return 'sha256:' + createHash('sha256').update(material, 'utf8').digest('hex');
}

const receiptsOf = (ledger) => (ledger && typeof ledger.receipts === 'object' && ledger.receipts !== null ? ledger.receipts : {});

/**
 * 查重：该指纹是否已登记过。
 *
 * @param {object} ledger 回执账（缺省/异常形状 ⇒ 视为空账）
 * @param {string} fp `receiptFingerprint()` 的返回值
 * @returns {{run: boolean, reason?: string}} 未登记 ⇒ `{run:true}`；已登记 ⇒ `{run:false, reason}`
 */
export function shouldRun(ledger, fp) {
  const key = String(fp);
  const receipts = receiptsOf(ledger);
  if (Object.prototype.hasOwnProperty.call(receipts, key)) {
    return { run: false, reason: RECEIPT_ALREADY_APPLIED + ' ' + key };
  }
  return { run: true };
}

/**
 * 幂等登记：把该指纹记入**新的** ledger，并把执行计数 +1。
 * **不修改入参**（纯函数）；重复登记同一指纹 ⇒ 计数不再 +1（幂等）。
 *
 * @param {object} ledger 回执账
 * @param {string} fp 指纹
 * @param {object} [meta] 调用方附带的元数据（原样保存，不解释、不补时间戳）
 * @returns {object} 新 ledger `{ receipts, execCount }`
 */
export function recordReceipt(ledger, fp, meta = {}) {
  const key = String(fp);
  const receipts = receiptsOf(ledger);
  const execCount = typeof ledger?.execCount === 'number' ? ledger.execCount : 0;
  if (Object.prototype.hasOwnProperty.call(receipts, key)) {
    // 已有 ⇒ 只回一份新账，**不重复计数**（幂等的落点）
    return { receipts: { ...receipts }, execCount };
  }
  return {
    receipts: { ...receipts, [key]: meta },
    execCount: execCount + 1,
  };
}
