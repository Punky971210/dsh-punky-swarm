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

// 数组字段：条件应用于每个元素，任意元素满足即匹配（FilterCondition.field 注释语义）。

import { FILTER_OPERATORS } from './schema.js';

export function resolveField(record, field) {
  if (typeof field !== 'string' || field.length === 0) return [];
  const segs = field.split('.').filter((s) => s.length > 0);
  let current = [record];
  for (const seg of segs) {
    const next = [];
    for (const node of current) {
      if (node === null || node === undefined) continue;
      if (Array.isArray(node)) {
        for (const item of node) {
          if (item !== null && item !== undefined && typeof item === 'object' && seg in item) next.push(item[seg]);
        }
      } else if (typeof node === 'object' && seg in node) {
        const v = node[seg];
        if (Array.isArray(v)) {
          for (const item of v) next.push(item);
        } else {
          next.push(v);
        }
      }
    }
    current = next;
    if (current.length === 0) break;
  }
  return current;
}

function isCs(op) {
  return typeof op === 'string' && op.endsWith('Cs');
}

function baseOp(op) {
  return isCs(op) ? op.slice(0, -2) : op;
}

function norm(v, cs) {
  return (typeof v === 'string' && !cs) ? v.toLowerCase() : v;
}

function compareValues(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

export function matchOp(op, candidates, value) {
  const cs = isCs(op);
  const b = baseOp(op);
  const vals = Array.isArray(candidates) ? candidates : [candidates];

  switch (b) {
    case 'eq':
      return vals.some((v) => norm(v, cs) === norm(value, cs));
    case 'ne':
      return vals.every((v) => norm(v, cs) !== norm(value, cs));
    case 'exists':
      return value === true ? vals.length > 0 : vals.length === 0;
    case 'gt':
      return vals.some((v) => compareValues(v, value) > 0);
    case 'gte':
      return vals.some((v) => compareValues(v, value) >= 0);
    case 'lt':
      return vals.some((v) => compareValues(v, value) < 0);
    case 'lte':
      return vals.some((v) => compareValues(v, value) <= 0);
    case 'between': {
      const [lo, hi] = Array.isArray(value) ? value : [value, value];
      return vals.some((v) => compareValues(v, lo) >= 0 && compareValues(v, hi) <= 0);
    }
    case 'in': {
      const list = Array.isArray(value) ? value : [value];
      return vals.some((v) => list.some((x) => norm(x, cs) === norm(v, cs)));
    }
    case 'nin': {
      const list = Array.isArray(value) ? value : [value];
      return vals.every((v) => !list.some((x) => norm(x, cs) === norm(v, cs)));
    }
    case 'contains':
      return vals.some((v) => norm(String(v ?? ''), cs).includes(norm(String(value ?? ''), cs)));
    case 'notContains':
      return vals.every((v) => !norm(String(v ?? ''), cs).includes(norm(String(value ?? ''), cs)));
    case 'startsWith':
      return vals.some((v) => norm(String(v ?? ''), cs).startsWith(norm(String(value ?? ''), cs)));
    case 'endsWith':
      return vals.some((v) => norm(String(v ?? ''), cs).endsWith(norm(String(value ?? ''), cs)));
    case 'anyOf': {
      const list = Array.isArray(value) ? value : [value];
      const flat = candidates.flat(Infinity);
      return list.some((x) => flat.some((v) => norm(v, cs) === norm(x, cs)));
    }
    case 'allOf': {
      const list = Array.isArray(value) ? value : [value];
      const flat = candidates.flat(Infinity);
      return list.every((x) => flat.some((v) => norm(v, cs) === norm(x, cs)));
    }
    case 'noneOf': {
      const list = Array.isArray(value) ? value : [value];
      const flat = candidates.flat(Infinity);
      return list.every((x) => !flat.some((v) => norm(v, cs) === norm(x, cs)));
    }
    case 'size': {
      const arr = candidates.find((v) => Array.isArray(v));
      return (arr ?? []).length === Number(value);
    }
    case 'sizeGt':
    case 'sizeGte':
    case 'sizeLt':
    case 'sizeLte': {
      const arr = candidates.find((v) => Array.isArray(v));
      const len = (arr ?? []).length;
      const n = Number(value);
      if (b === 'sizeGt') return len > n;
      if (b === 'sizeGte') return len >= n;
      if (b === 'sizeLt') return len < n;
      return len <= n;
    }
    case 'hasKey': {
      const keys = Array.isArray(value) ? value : [value];
      return vals.some((v) => v !== null && typeof v === 'object' && !Array.isArray(v) && keys.every((k) => k in v));
    }
    case 'hasNoKey': {
      const keys = Array.isArray(value) ? value : [value];
      return vals.every((v) => v === null || typeof v !== 'object' || Array.isArray(v) || keys.every((k) => !(k in v)));
    }
    case 'hasAnyKey': {
      const keys = Array.isArray(value) ? value : [value];
      return vals.some((v) => v !== null && typeof v === 'object' && !Array.isArray(v) && keys.some((k) => k in v));
    }
    case 'hasAllKeys': {
      const keys = Array.isArray(value) ? value : [value];
      return vals.some((v) => v !== null && typeof v === 'object' && !Array.isArray(v) && keys.every((k) => k in v));
    }
    default:
      return false;
  }
}

export function matchCondition(record, condition) {
  if (!condition || typeof condition !== 'object') return false;
  if (typeof condition.field !== 'string' || !FILTER_OPERATORS.includes(condition.op)) return false;
  const candidates = resolveField(record, condition.field);
  return matchOp(condition.op, candidates, condition.value);
}

export function evaluateFilter(record, filter) {
  if (!filter || typeof filter !== 'object') return true; // 无 filter = 不约束
  const logic = filter.logic ?? 'and';
  const results = [];

  if (Array.isArray(filter.conditions)) {
    for (const c of filter.conditions) results.push(matchCondition(record, c));
  }
  if (Array.isArray(filter.groups)) {
    for (const g of filter.groups) results.push(evaluateFilter(record, g));
  }

  if (logic === 'or') return results.some(Boolean);
  if (logic === 'not') return !results.every(Boolean);
  return results.every(Boolean); // and（默认）
}
