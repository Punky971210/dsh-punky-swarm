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
 * @returns {{available:boolean, probeTool:Function, toolVisibilityFor:Function, registerTool:Function, installGuard:Function, invokeTool:Function}}
 */
export function createToolsPort(ctx) {
  const tools = serviceOf(ctx, 'tools');
  const available = Boolean(tools);

  return {
    available,

    /** 注册表三态探针（**唯一查询面**）：`present` / `absent` / `errored`。
     *  「有/无定义」由调用方按 `state` 自行取——不再另设 `hasTool` / `getTool` 两套薄封装
     *  （二者都只是本函数加一次分支，且 `errored` 的处理在三处已各写一遍）。 */
    probeTool(name) {
      if (!available || typeof tools.get !== 'function') return { state: 'absent', reason: 'port-unavailable' };
      try {
        const definition = tools.get(name);
        return definition == null ? { state: 'absent' } : { state: 'present', definition };
      } catch (e) {
        return { state: 'errored', reason: HOST_PORT_QUERY_FAILED + ' ' + String(e?.message ?? e) };
      }
    },

    /**
     * 某 agent **视角**的工具可见性三态（宿主注册表按 scope 分层，`get(name, scope)` 的 scope = agent）。
     *
     * 为什么需要它（2026-11-08 活体实测死锁）：治理工具面已改为**装配隔离**（只注册在 punky-preset 的
     *   scope 层），而执行时模式门 `modes.gate` 按**会话 header 的 preset id** 判定 —— 两者可能不一致：
     *   会话若在工具面注册**之前**创建、或 preset 重挂换代（老会话链到旧 generation），
     *   header 仍写 `punky-preset` ⇒ 门禁照旧生效，但该会话**看不到 `assign_check`**，
     *   于是「被拦 + 无工具可解套」= 死锁（实测：宿主 shell/edit 全被 difficulty 门拒绝）。
     *   ⇒ 门禁必须自己以**真实注册表**为准判「这个会话能不能照做」，不能只看 header。
     *
     * 三态而非布尔：`unknown`（端口不可用 / 查询抛错 / 无 `tools.get`）必须**保留旧行为**——
     *   夹具与半装配宿主里没有真注册表，据此放宽等于把门禁关掉；只有注册表**明确报告缺席**才放宽。
     *
     * @param {object|undefined} agent 调用方 agent（即 scope）；undefined = 全局视图
     * @param {string} name 工具名
     * @returns {'visible'|'absent'|'unknown'}
     */
    toolVisibilityFor(agent, name) {
      if (!available || typeof tools.get !== 'function') return 'unknown';
      try {
        return tools.get(name, agent) != null ? 'visible' : 'absent';
      } catch { return 'unknown'; }
    },

    /**
     * 注册到本端口 ctx 所属的 scope 层。
     * **返回宿主 `register()` 的 disposer**（宿主可能返回 undefined ⇒ 回落 true）。
     * 调用方必须保留它并在 `ctx.effect` 上释放：否则插件关→开会对同层重复注册，
     * 宿主抛 `tool "X" is already registered`（宿主 tools/index.js:385）。
     */
    registerTool(toolDef) {
      if (!available || typeof tools.register !== 'function') return false;
      const dispose = tools.register(toolDef);
      return typeof dispose === 'function' ? dispose : true;
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
      const callId = typeof correlation === 'string' && correlation.length > 0
        ? correlation
        : 'port-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      // 【宿主契约 · 0.2.2-rc.1 起 execute 为**批式**（本仓必须照此调用）】
      //   入参：`{ calls: [{ id, name, arguments }], signal, agent?, log?, toolSet? }`
      //   返回：`{ results: [{ callId, result }], additionalContexts, concluded }`
      //   单条 call 的 `result` 形状 = `{ content, isError }`（pipeline.js:29/33/55，BatchSettlement.result :236-253）。
      //   ⚠ 旧单 exec 形态（`{callId,name,arguments,signal}`）在新宿主里取 `calls === undefined` ⇒
      //     `toolCalls.map` 原生 TypeError（发生在任何 name 解析之前）⇒ 本方法此前在全宿主不可用。
      //   ⚠ 不保留旧形态回退：旧宿主对批式输入会静默按 unknown tool 返回，无可靠异常可判 ⇒
      //     双形态探测不可信（会把真错误误读为版本差异）。运行时下限随宿主 0.2.2-rc.1。
      const batch = { calls: [{ id: callId, name, arguments: args }], signal };
      const out = await tools.execute(batch);
      if (out && Array.isArray(out.results)) {
        const first = out.results[0];
        return first ? first.result : { content: [], isError: true };
      }
      return out;
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
