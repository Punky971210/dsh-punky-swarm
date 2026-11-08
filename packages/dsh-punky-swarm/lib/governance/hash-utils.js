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

export function canonicalize(value) {
  return c(value);
}

function c(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value)) return 'null';
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((x) => (x === undefined ? 'null' : c(x))).join(',') + ']';
  }
  if (t === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + c(value[k])).join(',') + '}';
  }
  if (value === undefined) return 'null';
  throw new Error('canonicalize: unsupported value type ' + t);
}

export function sha256Hex(str) {
  return createHash('sha256').update(String(str), 'utf8').digest('hex');
}

export function hashContent(receipt, prevHash) {
  if (!receipt || typeof receipt !== 'object') throw new Error('hashContent: receipt required');
  const { anchor, ...body } = receipt;
  const content = { ...body, prevHash: prevHash ?? null };
  return sha256Hex(canonicalize(content));
}

export function makeAnchor(receipt, prevHash) {
  const hash = hashContent(receipt, prevHash);
  return { version: 1, alg: 'sha256', prevHash: prevHash ?? null, hash };
}
