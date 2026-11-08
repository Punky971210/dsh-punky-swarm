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

// 参数规范形 + 稳定短哈希：证据行按「工具名 + 规范化入参」定键，
//   同一入参无论键序如何都落到同一个 `selectorKey`（台账据此可去重、可对照）。
import { createHash } from 'node:crypto';

export function canonicalizeArgs(value) {
  if (Array.isArray(value)) return value.map(canonicalizeArgs);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      const v = canonicalizeArgs(value[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return value;
}

export function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(canonicalizeArgs(value))).digest('hex').slice(0, 12);
}
