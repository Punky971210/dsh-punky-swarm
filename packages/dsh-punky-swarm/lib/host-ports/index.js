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

// 宿主端口面：把「我们怎么用宿主」收成两个**具名语义**端口。
//
// ── 为什么要有这一层（而不是到处直接摸 ctx）──────────────────────────────────────
//   现状问题不是「耦合了宿主」本身，而是**耦合点散落**：调用方直接读 `ctx.tools.get` /
//   `ctx.webServer.register` / 拼 `exec` 对象 ⇒ 宿主签名一变，改动面按调用点数量扩散，
//   而且**宿主字段（`callId` / `kind:'exact'`）泄漏到了业务代码里**。
//   端口层把这三件事收进来：① 可用性判定 ② 宿主字段构造 ③ **前置校验**。
//
// ── 禁把宿主原始签名原样透出 ────────────────────────────────────────────────────
//   `(exec) => ctx.tools.execute(exec)` 之类的**转发**等于没适配：调用方仍在拼宿主 exec 形状、
//   仍要知道 `signal` 的宿主语义。本端口要求**具名参数**，宿主 exec 在端口**内部**组装。
//
// ── `signal` 缺陷根治（C-1）──────────────────────────────────────────────────────
//   宿主导读 `exec.signal`（`dsh-tools/lib/index.js:1531` 直取，无 `?.` 无 `??`），
//   缺它时**抛 Node 原生 TypeError**（`ERR_INVALID_ARG_TYPE` / `signals[0] is not of type AbortSignal.`）
//   —— 宿主**没有**自己的校验文案，`execute` 体根本不进。
//   ⇒ 端口层**强制** signal 必填，并在缺失时抛**自己的**码（`host-port-invalid:`），
//     让「参数不对」这件事以**业务可识别**的形态暴露，而不是下沉成 Node 原生 TypeError。
//
// ── 张力（只登记，本批不实现）────────────────────────────────────────────────────
//   本层是「单宿主语义适配」，**不是**宿主无关插件系统。演进路径见 `exec/e2-ports.md`。

/** 端口层拒态前缀（**普通 `Error`**；非 `GATE_`、无 `err.code`）。 */
export const HOST_PORT_INVALID = 'host-port-invalid:';

const isAbortSignalLike = (signal) => Boolean(signal)
  && typeof signal === 'object'
  && typeof signal.aborted === 'boolean';

/**
 * 工具端口。
 *
 * @param {object} ctx 插件上下文（只在这里被读；调用方拿不到它）
 * @returns {{available:boolean, hasTool:Function, getTool:Function, registerTool:Function, installGuard:Function, invokeTool:Function}}
 */
export function createToolsPort(ctx) {
  const tools = ctx?.tools ?? null;
  const available = Boolean(tools);

  return {
    /** 宿主工具面是否可用（不可用时各方法按**降级语义**返回，不抛）。 */
    available,

    /**
     * 是否已注册（宿主 `get` 未注册按约定返回 `null` —— C-3）。
     * @param {string} name
     * @returns {boolean}
     */
    hasTool(name) {
      if (!available || typeof tools.get !== 'function') return false;
      try { return tools.get(name) != null; } catch { return false; }
    },

    /**
     * 取工具定义；不可用/未注册 ⇒ `null`（承接 C-3 的 `null` 约定，不抛）。
     * @param {string} name
     */
    getTool(name) {
      if (!available || typeof tools.get !== 'function') return null;
      try { return tools.get(name); } catch { return null; }
    },

    /**
     * 注册工具（装配期；宿主会校验 `parameters` 可无损 JSON 化 —— C-2，本层不重复校验）。
     * @param {object} toolDef
     * @returns {boolean} 是否真的调了宿主注册
     */
    registerTool(toolDef) {
      if (!available || typeof tools.register !== 'function') return false;
      tools.register(toolDef);
      return true;
    },

    /**
     * 安装 guard（追加语义；guard **返回非空字符串即拒** —— C-4）。
     * @param {(execution:object)=>string|undefined} guardFn
     * @returns {boolean}
     */
    installGuard(guardFn) {
      if (!available || typeof tools.guard !== 'function') return false;
      tools.guard(guardFn);
      return true;
    },

    /**
     * 调用工具。**具名参数**；宿主 `exec` 在内部组装。
     *
     * @param {object} request
     * @param {string} request.name 工具名
     * @param {object} [request.args] 入参
     * @param {AbortSignal} request.signal **必填**（缺失/非法 ⇒ 抛 `host-port-invalid:`）
     * @param {string} [request.correlation] 关联 id（宿主 `callId`，由本层填充）
     * @returns {Promise<unknown>} 宿主返回值（原样透传，不解释、不裁剪）
     * @throws {Error} `signal` 缺失/非法；或工具面不可用
     */
    async invokeTool(request = {}) {
      const { name, args = {}, signal, correlation } = request;
      if (!isAbortSignalLike(signal)) {
        const got = signal === null ? 'null' : typeof signal;
        throw new Error(HOST_PORT_INVALID + ' invokeTool 需要 AbortSignal（收到 ' + got + '）');
      }
      if (!available || typeof tools.execute !== 'function') {
        throw new Error(HOST_PORT_INVALID + ' ctx.tools.execute 不可用');
      }
      // 宿主字段（callId）在此组装，**不外泄**给调用方
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

/**
 * HTTP 端口。
 *
 * ⚠ `ctx.webServer` **可缺**（CLI/stdio 部署无此服务 —— C-5）⇒ `mountRoute` 在不可用时
 *  **返回 `{mounted:false, dispose:noop}` 而不抛**（沿用本仓 `data-plane-server.js:218-226` 的降级先例）。
 *
 * @param {object} ctx
 * @returns {{available:boolean, mountRoute:Function}}
 */
export function createHttpPort(ctx) {
  const web = ctx?.webServer ?? null;
  const available = Boolean(web) && typeof web.register === 'function';

  return {
    available,

    /**
     * 挂载路由。
     *
     * @param {object} route
     * @param {string} route.method HTTP 方法
     * @param {string} route.path 路径
     * @param {Function} route.handler 处理函数（宿主签名由本层适配）
     * @returns {{mounted:boolean, dispose:Function}}
     */
    mountRoute({ method, path: routePath, handler } = {}) {
      if (!available) return { mounted: false, dispose: () => {} };
      const dispose = web.register({ method, kind: 'exact', path: routePath, handler });
      return { mounted: true, dispose: typeof dispose === 'function' ? dispose : () => {} };
    },
  };
}
