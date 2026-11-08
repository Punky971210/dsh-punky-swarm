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


export const QUERY_TYPES = ['explicit', 'exploratory', 'trending', 'filtered'];
export const QUERY_TYPE_EXPLICIT = 'explicit';

const FORWARD_DEPTH_LIMIT_MIN = 1;
const FORWARD_DEPTH_LIMIT_MAX = 5;       // 绝对上限
const FORWARD_FANOUT_LIMIT_MIN = 1;
const FORWARD_FANOUT_LIMIT_MAX = 5;

const DISCOVERY_LIMIT_DEFAULT = 5;
export const DISCOVERY_LIMIT_MAX = 50;

export const FILTER_OPERATORS = [
  'eq', 'ne', 'exists',
  'gt', 'gte', 'lt', 'lte', 'between',
  'in', 'nin',
  'contains', 'notContains', 'startsWith', 'endsWith',
  'eqCs', 'neCs', 'inCs', 'ninCs', 'containsCs', 'notContainsCs', 'startsWithCs', 'endsWithCs',
  'anyOf', 'allOf', 'noneOf', 'size', 'sizeGt', 'sizeGte', 'sizeLt', 'sizeLte',
  'hasKey', 'hasNoKey', 'hasAnyKey', 'hasAllKeys',
];

export const ADP_ERROR = {
  MISSING_QUERY: { code: 40001, message: 'MissingQuery' },
  FORWARD_DEPTH_LIMIT_INVALID: { code: 40002, message: 'ForwardDepthLimitInvalid' },
  FORWARD_CHAIN_INVALID: { code: 40003, message: 'ForwardChainInvalid' },
  FILTER_INVALID: { code: 40004, message: 'FilterInvalid' },
  FORWARD_FANOUT_LIMIT_INVALID: { code: 40005, message: 'ForwardFanoutLimitInvalid' },
  BAD_REQUEST: { code: 40000, message: 'BadRequest' },
  INTERNAL_ERROR: { code: 50001, message: 'InternalError' },
};

export function validateDiscoveryRequest(raw = {}) {
  const error = (e, data) => ({ error: { code: e.code, message: e.message, data } });

  const type = raw.type ?? QUERY_TYPE_EXPLICIT;
  if (!QUERY_TYPES.includes(type)) {
    return error(ADP_ERROR.BAD_REQUEST, '无效的查询类型: ' + JSON.stringify(type) + '，允许: ' + QUERY_TYPES.join('/'));
  }

  if (type === QUERY_TYPE_EXPLICIT && !(typeof raw.query === 'string' && raw.query.trim().length > 0)) {
    return error(ADP_ERROR.MISSING_QUERY, "type='explicit' 时 query 字段必填且不能为空字符串");
  }

  if (type === 'filtered' && !raw.filter) {
    return error(ADP_ERROR.BAD_REQUEST, 'filtered 查询必须提供 filter 参数');
  }

  if (raw.forwardDepthLimit !== undefined && raw.forwardDepthLimit !== null
    && (raw.forwardDepthLimit < FORWARD_DEPTH_LIMIT_MIN || raw.forwardDepthLimit > FORWARD_DEPTH_LIMIT_MAX)) {
    return error(ADP_ERROR.FORWARD_DEPTH_LIMIT_INVALID, 'forwardDepthLimit 不在 ' + FORWARD_DEPTH_LIMIT_MIN + '-' + FORWARD_DEPTH_LIMIT_MAX + ' 区间');
  }

  if (raw.forwardFanoutLimit !== undefined && raw.forwardFanoutLimit !== null
    && (raw.forwardFanoutLimit < FORWARD_FANOUT_LIMIT_MIN || raw.forwardFanoutLimit > FORWARD_FANOUT_LIMIT_MAX)) {
    return error(ADP_ERROR.FORWARD_FANOUT_LIMIT_INVALID, 'forwardFanoutLimit 不在 ' + FORWARD_FANOUT_LIMIT_MIN + '-' + FORWARD_FANOUT_LIMIT_MAX + ' 区间');
  }

  if (raw.forwardChain !== undefined && raw.forwardChain !== null) {
    const chain = Array.isArray(raw.forwardChain) ? raw.forwardChain : [raw.forwardChain];
    if (!chain.every((aic) => typeof aic === 'string' && aic.trim().length > 0)) {
      return error(ADP_ERROR.FORWARD_CHAIN_INVALID, 'forwardChain 包含非法 AIC');
    }
  }

  if (raw.filter !== undefined && raw.filter !== null) {
    const fe = validateFilterShape(raw.filter);
    if (fe) return error(ADP_ERROR.FILTER_INVALID, fe);
  }

  return null;
}

export function validateFilterShape(filter, depth = 0) {
  if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) return 'filter 必须是对象';
  if (depth > 3) return 'filter 嵌套深度超过建议上限 3 层';

  const conditions = Array.isArray(filter.conditions) ? filter.conditions : [];
  const groups = Array.isArray(filter.groups) ? filter.groups : [];
  if (filter.logic !== undefined && !['and', 'or', 'not'].includes(filter.logic)) {
    return "logic 必须是 'and' | 'or' | 'not'";
  }
  for (const c of conditions) {
    if (c === null || typeof c !== 'object') return 'condition 必须是对象';
    if (typeof c.field !== 'string' || c.field.trim().length === 0) return 'condition.field 必须是非空字符串';
    if (!FILTER_OPERATORS.includes(c.op)) return 'condition.op 非法: ' + JSON.stringify(c.op);
  }
  for (const g of groups) {
    const ge = validateFilterShape(g, depth + 1);
    if (ge) return ge;
  }
  return null;
}

export function normalizeLimit(limit) {
  if (!Number.isFinite(Number(limit))) return DISCOVERY_LIMIT_DEFAULT;
  const n = Math.floor(Number(limit));
  if (n < 1) return 1;
  if (n > DISCOVERY_LIMIT_MAX) return DISCOVERY_LIMIT_MAX;
  return n;
}

export function successResponse(result) {
  return { result };
}

export function failureResponse(code, message, data) {
  return { error: { code, message, data } };
}
