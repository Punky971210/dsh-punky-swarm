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


export const HOST_PORT_INVALID = 'host-port-invalid:';

export function serviceOf(ctx, name) {
  try {
    const direct = ctx?.[name];
    if (direct !== undefined && direct !== null) return direct;
  } catch {  }
  try {
    const viaGet = typeof ctx?.get === 'function' ? ctx.get(name) : null;
    return viaGet ?? null;
  } catch { return null; }
}

export const HOST_PORT_QUERY_FAILED = 'host-port-query-failed:';

const isAbortSignalLike = (signal) => Boolean(signal)
  && typeof signal === 'object'
  && typeof signal.aborted === 'boolean';

/**
 * @param {object} ctx 插件上下文（只在这里被读；调用方拿不到它）
 * @returns {{available:boolean, hasTool:Function, getTool:Function, registerTool:Function, installGuard:Function, invokeTool:Function}}
 */
export function createToolsPort(ctx) {
  const tools = serviceOf(ctx, 'tools');
  const available = Boolean(tools);

  return {
    available,

    hasTool(name) {
      const probed = this.probeTool(name);
      if (probed.state === 'errored') throw new Error(probed.reason);
      return probed.state === 'present';
    },

    probeTool(name) {
      if (!available || typeof tools.get !== 'function') return { state: 'absent', reason: 'port-unavailable' };
      try {
        const definition = tools.get(name);
        return definition == null ? { state: 'absent' } : { state: 'present', definition };
      } catch (e) {
        return { state: 'errored', reason: HOST_PORT_QUERY_FAILED + ' ' + String(e?.message ?? e) };
      }
    },

    getTool(name) {
      const probed = this.probeTool(name);
      if (probed.state === 'errored') throw new Error(probed.reason); // 查询失败 ⇒ 抛，禁返 null
      return probed.state === 'present' ? probed.definition : null;
    },

    registerTool(toolDef) {
      if (!available || typeof tools.register !== 'function') return false;
      tools.register(toolDef);
      return true;
    },

    installGuard(guardFn) {
      if (!available || typeof tools.guard !== 'function') return false;
      tools.guard(guardFn);
      return true;
    },

    async invokeTool(request = {}) {
      const { name, args = {}, signal, correlation } = request;
      if (!isAbortSignalLike(signal)) {
        const got = signal === null ? 'null' : typeof signal;
        throw new Error(HOST_PORT_INVALID + ' invokeTool 需要 AbortSignal（收到 ' + got + '）');
      }
      if (!available || typeof tools.execute !== 'function') {
        throw new Error(HOST_PORT_INVALID + ' ctx.tools.execute 不可用');
      }
      const exec = {
        callId: typeof correlation === 'string' && correlation.length > 0
          ? correlation
          : 'port-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        name,
        arguments: args,
        signal,
      };
      return tools.execute(exec);
    },
  };
}

export function createHttpPort(ctx) {
  const web = serviceOf(ctx, 'webServer');
  const available = Boolean(web) && typeof web.register === 'function';

  return {
    available,

    mountRoute({ method, path: routePath, match, handler } = {}) {
      if (!available) return { mounted: false, dispose: () => {} };
      const dispose = web.register({ method, kind: match ?? 'exact', path: routePath, handler });
      return { mounted: true, dispose: typeof dispose === 'function' ? dispose : () => {} };
    },
  };
}
