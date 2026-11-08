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


import {
  QUERY_TYPE_EXPLICIT,
  validateDiscoveryRequest,
  normalizeLimit,
  successResponse,
} from '../discovery/schema.js';

export const DISCOVERY_SCOPES = ['local', 'external', 'both'];
export const DISCOVERY_SCOPE_DEFAULT = 'local';

const FORWARD_FIELDS = [
  'forwardDepthLimit', 'forwardFanoutLimit', 'forwardFanoutRemaining',
  'forwardChain', 'forwardTrustedServers', 'forwardSignatures',
  'forwardEachTimeoutMs', 'forwardTotalTimeoutMs',
];

export class DiscoveryClientError extends Error {
  constructor(message, adpError = null) {
    super(message);
    this.name = 'DiscoveryClientError';
    this.adpError = adpError;
  }
}

function toClientError(err, prefix) {
  const e = err && err.error ? err.error : {};
  return new DiscoveryClientError(prefix + ': ' + (e.message ?? JSON.stringify(err)), e.code !== undefined ? e : null);
}

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
    get isConfigured() {
      return serverBaseUrl.length > 0;
    },

    async discover(query, opts = {}) {
      const effectiveScope = opts.scope ?? scope;
      if (!DISCOVERY_SCOPES.includes(effectiveScope)) {
        throw new DiscoveryClientError('scope 非法: ' + JSON.stringify(effectiveScope));
      }

      const raw = buildDiscoveryRequest(query, opts, limit);
      const verr = validateDiscoveryRequest(raw);
      if (verr) throw toClientError(verr, '请求参数校验失败');

      const runLocal = async () => {
        if (!localService || typeof localService.discover !== 'function') {
          throw new DiscoveryClientError('scope=' + effectiveScope + ' 需要本地发现服务（capabilities.discovery.enabled），但未装配');
        }
        const resp = localService.discover(raw);
        if (resp && resp.error) throw toClientError({ error: resp.error }, '本地查询返回错误');
        return resp;
      };

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
          throw new DiscoveryClientError('发现服务调用失败: ' + (e?.message ?? String(e)));
        }
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

      if (effectiveScope === 'local') return runLocal();
      if (effectiveScope === 'external') return runExternal();
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

export function createMiniAdsp() {
  throw new Error(
    'mini-ADSP 预留接口（未实现）：对外 /discover 服务端语义待 endpoint 就绪后按需实现'
  );
}
