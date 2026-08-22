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

// 外部 ADP 发现客户端（Agent Discovery Protocol）：插件 Leader 发现外部 partner。
// POST {adpBaseUrl}/discover 查询外部 discovery-server，返回 DiscoveryResponse
// （result.acsMap / result.agents[].agentSkills / result.routes），供调用方选择调用目标。
//
// 基准（参考实现 ACPs-community v2.1.0，事实源）：
//   - 请求构造/错误语义：demo-leader/leader/assistant/services/discovery_client.py:49-118（discover 86-93）、149-161（DiscoveryClientError）
//   - DiscoveryRequest 模型：acps_sdk/acps_sdk/adp/models.py:245-443（type/query/context/limit/filter/forward*，lowerCamelCase）
//   - DiscoveryResponse 模型：acps_sdk/acps_sdk/adp/models.py:664-757（result 与 error 互斥，CommonResponse 规范）
//   - 服务端 /discover 端点：discovery-server/app/discovery/discovery_api.py:29-83；响应构造 service.py:262-283
//
// 与既有本地查询关系（保留，零改动）：
//   lib/discovery/service.js = 本地进程内查询（插件自身工具/智能体目录，经 /api/dsh-punky-swarm/discover 暴露）；
//   本模块 = 新增外部查询通道，共享同一协议常量与校验（lib/discovery/schema.js
//   QUERY_TYPES/FILTER_OPERATORS/validateDiscoveryRequest/normalizeLimit——与参考实现 acps_sdk/adp 对齐）。
//   查询范围选项 scope：local（仅本地）/ external（仅外部）/ both（本地+外部合并），装配可配（acps.discovery.scope）。
//
// mini-ADSP（可选）：对外提供 /discover 的服务端语义——端点未就绪，
// 仅预留函数签名 createMiniAdsp()（调用抛 NotImplemented，见文末），不实现。
//
// 零新依赖：HTTP 用全局 fetch（Node >= 22）+ AbortSignal.timeout，node:https 内建能力之上。

import {
  QUERY_TYPE_EXPLICIT,
  validateDiscoveryRequest,
  normalizeLimit,
  successResponse,
} from '../discovery/schema.js';

// ── 查询范围选项（装配可配；外部通道与本地目录的组合方式）──
export const DISCOVERY_SCOPES = ['local', 'external', 'both'];
export const DISCOVERY_SCOPE_DEFAULT = 'local';

// DiscoveryRequest 透传白名单（forward*/context 之外的字段不注入，防任意字段污染——对齐
// acps_sdk DiscoveryRequest 公开字段集 models.py:245-443；数值字段由服务器默认值兜底）
const FORWARD_FIELDS = [
  'forwardDepthLimit', 'forwardFanoutLimit', 'forwardFanoutRemaining',
  'forwardChain', 'forwardTrustedServers', 'forwardSignatures',
  'forwardEachTimeoutMs', 'forwardTotalTimeoutMs',
];

export class DiscoveryClientError extends Error {
  // 语义对齐 demo-leader discovery_client.py:149-161：
  // adpError = { code, message, data }（协议级错误载荷，可判 retryable/redirect/client/forward 类别）
  constructor(message, adpError = null) {
    super(message);
    this.name = 'DiscoveryClientError';
    this.adpError = adpError;
  }
}

// 将 lib/discovery/schema.js 校验错误（{ error: { code, message, data } }）转为 DiscoveryClientError
function toClientError(err, prefix) {
  const e = err && err.error ? err.error : {};
  return new DiscoveryClientError(prefix + ': ' + (e.message ?? JSON.stringify(err)), e.code !== undefined ? e : null);
}

// 构造 DiscoveryRequest 载荷（对齐参考实现 discovery_client.py:72-77 形态：
// { type, query, limit, filter } + 可选 context/forward*；lowerCamelCase，exclude_none）
export function buildDiscoveryRequest(query, opts = {}, defaultLimit = 5) {
  const raw = {
    type: opts.type ?? QUERY_TYPE_EXPLICIT,
    query: query ?? null,
    limit: normalizeLimit(opts.limit ?? defaultLimit),
  };
  if (opts.filter !== undefined && opts.filter !== null) raw.filter = opts.filter;
  if (opts.context !== undefined && opts.context !== null) raw.context = opts.context;
  for (const f of FORWARD_FIELDS) {
    if (opts[f] !== undefined && opts[f] !== null) raw[f] = opts[f];
  }
  return raw;
}

// 响应结构校验 + 协议级错误识别（对齐 acps_sdk DiscoveryResponse 语义 models.py:664-757）：
// - HTTP 200 但 body.error 存在 → 协议级错误（DiscoveryClientError + adpError）
// - result 必须为对象；agents 若存在必须为数组；acsMap 若存在必须为对象
export function parseDiscoveryResponse(json, throwOnProtocolError = true) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new DiscoveryClientError('发现服务返回无效响应: 非 JSON 对象');
  }
  if (json.error !== undefined && json.error !== null) {
    const err = (typeof json.error === 'object') ? json.error : { message: String(json.error) };
    const adpError = { code: err.code, message: err.message, data: err.data };
    if (throwOnProtocolError) {
      throw new DiscoveryClientError('发现服务返回协议错误: ' + (err.message ?? ''), adpError);
    }
    return { error: adpError };
  }
  if (json.result === undefined || json.result === null || typeof json.result !== 'object' || Array.isArray(json.result)) {
    throw new DiscoveryClientError('发现服务返回无效响应: 缺少 result 对象');
  }
  const result = json.result;
  if (result.agents !== undefined && !Array.isArray(result.agents)) {
    throw new DiscoveryClientError('发现服务返回无效响应: result.agents 非数组');
  }
  if (result.acsMap !== undefined
    && (result.acsMap === null || typeof result.acsMap !== 'object' || Array.isArray(result.acsMap))) {
    throw new DiscoveryClientError('发现服务返回无效响应: result.acsMap 非对象');
  }
  if (result.routes !== undefined && !Array.isArray(result.routes)) {
    throw new DiscoveryClientError('发现服务返回无效响应: result.routes 非数组');
  }
  return successResponse(result);
}

// 便利遍历：展平 result.agents[].agentSkills，关联 acsMap 中的 ACS——
// 对齐 DiscoveryResult.iter_agent_skills（acps_sdk/adp/models.py:609-626）：
// 返回 [{ aic, acs, skillId, ranking, memo, group }]，acs 缺失时为 {}
export function flattenAgentSkills(result) {
  const acsMap = (result && typeof result.acsMap === 'object' && !Array.isArray(result.acsMap)) ? result.acsMap : {};
  const out = [];
  const agents = Array.isArray(result?.agents) ? result.agents : [];
  for (const group of agents) {
    const skills = Array.isArray(group?.agentSkills) ? group.agentSkills : [];
    for (const s of skills) {
      out.push({
        aic: s?.aic,
        acs: acsMap[s?.aic] ?? {},
        skillId: s?.skillId,
        ranking: s?.ranking,
        memo: s?.memo,
        group: group?.group,
      });
    }
  }
  return out;
}

// 合并本地+外部响应（scope=both）：acsMap 键合并（外部优先）、agents 分组拼接、routes 拼接
function mergeResponses(local, external) {
  const lr = local?.result ?? {};
  const er = external?.result ?? {};
  const acsMap = { ...(lr.acsMap ?? {}), ...(er.acsMap ?? {}) };
  const agents = [...(Array.isArray(lr.agents) ? lr.agents : []), ...(Array.isArray(er.agents) ? er.agents : [])];
  const routes = [...(Array.isArray(lr.routes) ? lr.routes : []), ...(Array.isArray(er.routes) ? er.routes : [])];
  const result = { acsMap, agents };
  if (routes.length > 0) result.routes = routes;
  return successResponse(result);
}

// ADP 客户端工厂。
// 参数：
//   baseUrl      外部 discovery-server 根地址（如 http://127.0.0.1:9020）；空 = 未配置（discover 抛错，mirror is_configured）
//   timeout      单次请求超时 ms（默认 10000）
//   limit        默认返回上限（默认 5，对齐参考实现 discovery_config limit=5）
//   scope        查询范围 local/external/both（默认 local）
//   localService 既有本地查询服务（lib/discovery/service.js 实例；scope=local/both 时必需）
//   request      可注入 HTTP 实现（默认全局 fetch；测试用 stub 替换）
export function createAcpsDiscoveryClient({
  baseUrl = '',
  timeout = 10_000,
  limit = 5,
  scope = DISCOVERY_SCOPE_DEFAULT,
  localService = null,
  request = null,
} = {}) {
  if (!DISCOVERY_SCOPES.includes(scope)) {
    throw new TypeError('acps discovery scope 非法: ' + JSON.stringify(scope) + '，允许: ' + DISCOVERY_SCOPES.join('/'));
  }
  const serverBaseUrl = String(baseUrl ?? '').replace(/\/+$/, '');
  const requestImpl = request ?? ((url, options) => fetch(url, options));

  return {
    scope,
    baseUrl: serverBaseUrl,
    // mirror discovery_client.py:44-47 is_configured
    get isConfigured() {
      return serverBaseUrl.length > 0;
    },

    // discover(query, opts)：query=自然语言能力查询；opts = { type, limit, filter, context, scope?, ...forward* }
    // scope 缺省用客户端装配 scope；返回 { result: { acsMap, agents, routes? } }（与本地 service.discover 同形）
    async discover(query, opts = {}) {
      const effectiveScope = opts.scope ?? scope;
      if (!DISCOVERY_SCOPES.includes(effectiveScope)) {
        throw new DiscoveryClientError('scope 非法: ' + JSON.stringify(effectiveScope));
      }

      // 请求参数校验（提前捕获 query 为空/filter 非法等——对齐 discovery_client.py:80-83 validate_discovery_request）
      const raw = buildDiscoveryRequest(query, opts, limit);
      const verr = validateDiscoveryRequest(raw);
      if (verr) throw toClientError(verr, '请求参数校验失败');

      // local 分支：既有本地查询服务
      const runLocal = async () => {
        if (!localService || typeof localService.discover !== 'function') {
          throw new DiscoveryClientError('scope=' + effectiveScope + ' 需要本地发现服务（capabilities.discovery.enabled），但未装配');
        }
        const resp = localService.discover(raw);
        // 本地服务校验失败返回 { error } 形态（failureResponse）——转为客户端错误保持一致语义
        if (resp && resp.error) throw toClientError({ error: resp.error }, '本地查询返回错误');
        return resp;
      };

      // external 分支：POST {baseUrl}/discover（对齐 discovery_client.py:86-93）
      const runExternal = async () => {
        if (!serverBaseUrl) {
          throw new DiscoveryClientError('发现服务未配置 server_base_url');
        }
        const url = serverBaseUrl + '/discover';
        const body = JSON.stringify(raw);
        let res;
        try {
          res = await requestImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            signal: AbortSignal.timeout(Number.isFinite(Number(timeout)) && Number(timeout) > 0 ? Number(timeout) : 10_000),
          });
        } catch (e) {
          const name = e?.name ?? '';
          if (name === 'TimeoutError' || name === 'AbortError' || e?.code === 'UND_ERR_CONNECT_TIMEOUT') {
            throw new DiscoveryClientError('发现服务请求超时');
          }
          // 连接失败等（fetch failed / ECONNREFUSED 等）——对齐 discovery_client.py:116-118
          throw new DiscoveryClientError('发现服务调用失败: ' + (e?.message ?? String(e)));
        }
        // HTTP 状态错误——对齐 discovery_client.py:110-112 raise_for_status
        if (!res || typeof res.ok !== 'boolean') {
          throw new DiscoveryClientError('发现服务返回无效响应: 缺少 HTTP 响应');
        }
        if (!res.ok) {
          throw new DiscoveryClientError('发现服务返回错误 ' + (res.status ?? 'unknown'));
        }
        let json;
        try {
          json = await res.json();
        } catch {
          throw new DiscoveryClientError('发现服务响应不是有效 JSON');
        }
        return parseDiscoveryResponse(json);
      };

      // 按 scope 分发
      if (effectiveScope === 'local') return runLocal();
      if (effectiveScope === 'external') return runExternal();
      // both：本地 + 外部合并；通道不可用时如实降级（缺本地 → 仅外部；缺外部 → 仅本地）
      const localResp = localService && typeof localService.discover === 'function' ? await runLocal() : null;
      let externalResp = null;
      if (serverBaseUrl) {
        try {
          externalResp = await runExternal();
        } catch (e) {
          if (!(e instanceof DiscoveryClientError)) throw e;
          if (!localResp) throw e; // 无本地结果可兜底 → 如实上抛
        }
      }
      if (!localResp && !externalResp) {
        throw new DiscoveryClientError('scope=both 无可用通道: 需本地发现服务或配置 server_base_url');
      }
      if (!externalResp) return localResp;
      if (!localResp) return externalResp;
      return mergeResponses(localResp, externalResp);
    },
  };
}

// ── mini-ADSP（可选，预留）──
// 对外提供 /discover 的服务端语义（本插件作为 ADP 服务端被外部查询）。
// mini-ADSP 非门禁；对外 /acps/rpc + .well-known/acs.json 端点就绪前
// 仅预留本签名，不实现。实现路径（就绪后）：复用 lib/discovery/service.js 的 discover 语义，
// 经 acps.endpoint 挂载对外 /discover。
export function createMiniAdsp() {
  throw new Error(
    'mini-ADSP 预留接口（未实现）：对外 /discover 服务端语义待 endpoint 就绪后按需实现'
  );
}
