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

// 发现协议（ADP，Agent Discovery Protocol）常量与请求校验 — 独立模块，核心无感知。
// 基准：ACPs-community v2.1.0（acps-sdk/adp + discovery-server/app/discovery，06-ACPs-spec-ADP）。
// 字段名以参考实现逐字为准（lowerCamelCase），不臆造。纯函数 + 数据，零运行时依赖。

// ── 查询类型（QUERY_TYPES，与 acps_sdk/adp/constants.py 一致）──
export const QUERY_TYPES = ['explicit', 'exploratory', 'trending', 'filtered'];
export const QUERY_TYPE_EXPLICIT = 'explicit';

// ── 转发限制（FORWARD_*，与 acps_sdk/adp/constants.py 一致）──
export const FORWARD_DEPTH_LIMIT_DEFAULT = 3;   // 服务器默认
export const FORWARD_DEPTH_LIMIT_MIN = 1;
export const FORWARD_DEPTH_LIMIT_MAX = 5;       // 绝对上限
export const FORWARD_FANOUT_LIMIT_DEFAULT = 1;  // 未提供时默认不允许并发转发
export const FORWARD_FANOUT_LIMIT_MIN = 1;
export const FORWARD_FANOUT_LIMIT_MAX = 5;
export const FORWARD_EACH_TIMEOUT_MS_DEFAULT = 10_000;
export const FORWARD_TOTAL_TIMEOUT_MS_DEFAULT = 60_000;

// ── 查询结果限制（服务器默认 5，上限 50，同 discovery-server/schema.py）──
export const DISCOVERY_LIMIT_DEFAULT = 5;
export const DISCOVERY_LIMIT_MAX = 50;

// ── 过滤运算符全集（FilterOperator，06-ACPs-spec-ADP §4.2.1 逐字 34 个）──
export const FILTER_OPERATORS = [
  // 通用：等值与存在性
  'eq', 'ne', 'exists',
  // 比较：数值、日期、字符串字典序
  'gt', 'gte', 'lt', 'lte', 'between',
  // 集合：值列表匹配
  'in', 'nin',
  // 字符串：模式匹配（默认大小写不敏感）
  'contains', 'notContains', 'startsWith', 'endsWith',
  // 字符串：大小写敏感变体（Cs = Case Sensitive）
  'eqCs', 'neCs', 'inCs', 'ninCs', 'containsCs', 'notContainsCs', 'startsWithCs', 'endsWithCs',
  // 数组：集合运算
  'anyOf', 'allOf', 'noneOf', 'size', 'sizeGt', 'sizeGte', 'sizeLt', 'sizeLte',
  // Map/对象：键检查
  'hasKey', 'hasNoKey', 'hasAnyKey', 'hasAllKeys',
];

// ── ADP 错误码（06-ACPs-spec-ADP §4.1.2 逐字）──
export const ADP_ERROR = {
  MISSING_QUERY: { code: 40001, message: 'MissingQuery' },
  FORWARD_DEPTH_LIMIT_INVALID: { code: 40002, message: 'ForwardDepthLimitInvalid' },
  FORWARD_CHAIN_INVALID: { code: 40003, message: 'ForwardChainInvalid' },
  FILTER_INVALID: { code: 40004, message: 'FilterInvalid' },
  FORWARD_FANOUT_LIMIT_INVALID: { code: 40005, message: 'ForwardFanoutLimitInvalid' },
  BAD_REQUEST: { code: 40000, message: 'BadRequest' },
  INTERNAL_ERROR: { code: 50001, message: 'InternalError' },
};

// ── 请求校验（对齐 discovery-server validator.py + schema.py 语义）──
// 返回 { error } 或 null。error = { code, message, data? }（CommonResponse.error 形态）
export function validateDiscoveryRequest(raw = {}) {
  const error = (e, data) => ({ error: { code: e.code, message: e.message, data } });

  // type 合法性
  const type = raw.type ?? QUERY_TYPE_EXPLICIT;
  if (!QUERY_TYPES.includes(type)) {
    return error(ADP_ERROR.BAD_REQUEST, '无效的查询类型: ' + JSON.stringify(type) + '，允许: ' + QUERY_TYPES.join('/'));
  }

  // explicit 必填 query（SDK DiscoveryRequest.validate_explicit_query）
  if (type === QUERY_TYPE_EXPLICIT && !(typeof raw.query === 'string' && raw.query.trim().length > 0)) {
    return error(ADP_ERROR.MISSING_QUERY, "type='explicit' 时 query 字段必填且不能为空字符串");
  }

  // filtered 必填 filter（reference _handle_filtered_discovery 语义：40000 BadRequest）
  if (type === 'filtered' && !raw.filter) {
    return error(ADP_ERROR.BAD_REQUEST, 'filtered 查询必须提供 filter 参数');
  }

  // forwardDepthLimit 1..5（validator.py：不在 1-5 区间 → 40002）
  if (raw.forwardDepthLimit !== undefined && raw.forwardDepthLimit !== null
    && (raw.forwardDepthLimit < FORWARD_DEPTH_LIMIT_MIN || raw.forwardDepthLimit > FORWARD_DEPTH_LIMIT_MAX)) {
    return error(ADP_ERROR.FORWARD_DEPTH_LIMIT_INVALID, 'forwardDepthLimit 不在 ' + FORWARD_DEPTH_LIMIT_MIN + '-' + FORWARD_DEPTH_LIMIT_MAX + ' 区间');
  }

  // forwardFanoutLimit 1..5
  if (raw.forwardFanoutLimit !== undefined && raw.forwardFanoutLimit !== null
    && (raw.forwardFanoutLimit < FORWARD_FANOUT_LIMIT_MIN || raw.forwardFanoutLimit > FORWARD_FANOUT_LIMIT_MAX)) {
    return error(ADP_ERROR.FORWARD_FANOUT_LIMIT_INVALID, 'forwardFanoutLimit 不在 ' + FORWARD_FANOUT_LIMIT_MIN + '-' + FORWARD_FANOUT_LIMIT_MAX + ' 区间');
  }

  // forwardChain AIC 安全（validator.py validata_aics_safe）
  if (raw.forwardChain !== undefined && raw.forwardChain !== null) {
    const chain = Array.isArray(raw.forwardChain) ? raw.forwardChain : [raw.forwardChain];
    if (!chain.every((aic) => typeof aic === 'string' && aic.trim().length > 0)) {
      return error(ADP_ERROR.FORWARD_CHAIN_INVALID, 'forwardChain 包含非法 AIC');
    }
  }

  // filter 结构与运算符合法性（spec：不合法条件 → 40004 FilterInvalid）
  if (raw.filter !== undefined && raw.filter !== null) {
    const fe = validateFilterShape(raw.filter);
    if (fe) return error(ADP_ERROR.FILTER_INVALID, fe);
  }

  return null;
}

// 过滤条件结构校验：field 非空字符串、op ∈ 运算符全集、value 可选
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

// limit 归一化：缺省 DISCOVERY_LIMIT_DEFAULT，钳制 [1, DISCOVERY_LIMIT_MAX]
export function normalizeLimit(limit) {
  if (!Number.isFinite(Number(limit))) return DISCOVERY_LIMIT_DEFAULT;
  const n = Math.floor(Number(limit));
  if (n < 1) return 1;
  if (n > DISCOVERY_LIMIT_MAX) return DISCOVERY_LIMIT_MAX;
  return n;
}

// 成功/失败响应构造（DiscoveryResponse：result 与 error 互斥，reference DiscoveryResponse.success/failure）
export function successResponse(result) {
  return { result };
}

export function failureResponse(code, message, data) {
  return { error: { code, message, data } };
}
