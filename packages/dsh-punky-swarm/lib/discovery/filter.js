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

// ADP 过滤条件引擎（DiscoveryFilter → 布尔）：独立模块，核心无感知。
// 语义对齐 06-ACPs-spec-ADP §4.2.2：{ field, op, value } 条件数组 + groups 嵌套 + logic(and/or/not)。
// 数组字段：条件应用于每个元素，任意元素满足即匹配（FilterCondition.field 注释语义）。
// 运算符：35 个 FilterOperator 全集（eq/ne/exists/gt/gte/lt/lte/between/in/nin/contains/…/hasAllKeys）。
// 纯函数，零依赖。

import { FILTER_OPERATORS } from './schema.js';

// ── 字段路径解析：点号分隔；数组字段逐元素取值（任意元素满足即匹配）──
// 返回候选值数组（可能为空）。对对象路径逐级下钻，遇数组则展平。
export function resolveField(record, field) {
  if (typeof field !== 'string' || field.length === 0) return [];
  const segs = field.split('.').filter((s) => s.length > 0);
  let current = [record];
  for (const seg of segs) {
    const next = [];
    for (const node of current) {
      if (node === null || node === undefined) continue;
      if (Array.isArray(node)) {
        // 数组字段：逐元素取 seg（如 skills.tags → 每个 skill 的 tags）
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

// ── 单值 vs 运算符（大小写不敏感为默认，Cs 变体大小写敏感）──
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
  // 数值优先；否则字符串字典序（版本号场景）
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

// ── 数组语义：候选值数组上应用运算符，任意一个满足即匹配（hasAllKeys 除外：需全键）──
// op 对 value 的语义按参考实现 operators 表：
//   eq/ne/gt/gte/lt/lte/between/in/nin/contains/notContains/startsWith/endsWith/exists 作用于候选值
//   anyOf/allOf/noneOf/size* 作用于「数组字段的整体」（候选值为数组时）
//   hasKey/hasNoKey/hasAnyKey/hasAllKeys 作用于「对象字段」（候选值为对象时）
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
      // value=true：字段存在且非空；value=false：字段不存在或为空
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
    // ── 数组集合运算：候选值数组（可能是数组字段的整体）──
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
    // ── Map/对象键检查 ──
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

// ── 单条件求值 ──
export function matchCondition(record, condition) {
  if (!condition || typeof condition !== 'object') return false;
  if (typeof condition.field !== 'string' || !FILTER_OPERATORS.includes(condition.op)) return false;
  const candidates = resolveField(record, condition.field);
  return matchOp(condition.op, candidates, condition.value);
}

// ── DiscoveryFilter 递归求值（conditions + groups + logic and/or/not）──
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
