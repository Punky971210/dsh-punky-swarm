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

// governance/hash-utils.js —— P2 证据信封哈希工具（harden-plan §5.3 A，M5-d 简版）
// 零依赖（node:crypto 为 Node 标准库内建模块，非 package.json 依赖——§3 零新依赖红线内）。
// 提供：canonicalize（RFC 8785 简版确定性 JSON 序列化）+ sha256Hex + hashContent（收据锚定哈希）。
// 边界（简版，注释留痕，harden-plan §7.5 待定项）：
//   - 数字：JSON.stringify（IEEE-754 最短往返；-0 → "0"；无指数格式规范化——V8 输出确定）
//   - 字符串转义：JSON.stringify 最小转义（不转义 U+2028/2029；合法 JSON、UTF-8 输出确定）
//   - 键排序：Object.keys().sort()（UTF-16 code unit 序；ASCII 键域与 RFC 8785 一致）
//   - undefined：对象键跳过、数组元素 → null（对齐 JSON.stringify 语义——收据落盘 JSON 往返后一致）
//   - NaN / ±Infinity：→ null（对齐 JSON.stringify 语义）
// 完整 RFC 8785（数字规范化 / 逐字符转义表）不做——简版覆盖确定性证据信封需求（M5-d 留档全量）。

import { createHash } from 'node:crypto';

// 确定性 JSON 序列化（RFC 8785 简版）：键排序 + 无空白 + undefined/非有限数对齐 JSON.stringify。
export function canonicalize(value) {
  return c(value);
}

function c(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value)) return 'null'; // NaN/±Infinity → null（JSON.stringify 语义）
    return JSON.stringify(value); // -0 → "0"（V8 已如此）
  }
  if (Array.isArray(value)) {
    // 数组元素 undefined → null（对齐 JSON.stringify([undefined]) → "[null]"）
    return '[' + value.map((x) => (x === undefined ? 'null' : c(x))).join(',') + ']';
  }
  if (t === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    // 对象键 undefined 跳过（对齐 JSON.stringify 丢键语义——哈希与落盘 JSON 往返一致的关键）
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + c(value[k])).join(',') + '}';
  }
  if (value === undefined) return 'null';
  throw new Error('canonicalize: unsupported value type ' + t);
}

// sha256 hex（证据信封摘要；零依赖 node:crypto）
export function sha256Hex(str) {
  return createHash('sha256').update(String(str), 'utf8').digest('hex');
}

// 收据锚定哈希：hash = sha256(canonical(收据除 anchor 外全部字段 + prevHash))（harden-plan §5.3 A.1/A.4）——
//   hash 覆盖 receipt 除 anchor 自身外全部字段（含 prevHash）；anchor.hash 字段本身不参与。
// receipt 可含 anchor（重算场景：patch 级联重锚时传入盘上对象），剥离后取 body。
export function hashContent(receipt, prevHash) {
  if (!receipt || typeof receipt !== 'object') throw new Error('hashContent: receipt required');
  const { anchor, ...body } = receipt; // anchor 剥离（自身不参与哈希）
  const content = { ...body, prevHash: prevHash ?? null };
  return sha256Hex(canonicalize(content));
}

// anchor 对象构造（version 1：sha256 内容哈希链，M5-d 简版信封）
export function makeAnchor(receipt, prevHash) {
  const hash = hashContent(receipt, prevHash);
  return { version: 1, alg: 'sha256', prevHash: prevHash ?? null, hash };
}
