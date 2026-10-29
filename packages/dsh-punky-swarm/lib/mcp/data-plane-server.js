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

// MCP 数据面（JSON-RPC 2.0 over HTTP；**协议版本钉 `2025-06-18`**）。
//
// 定位：**薄包装**。本模块只做四件事 —— ① JSON-RPC 帧解/编；② `tools/list` 从注册表视图派生；
//   ③ `tools/call` **原样透传** `arguments`；④ loopback 校验 + 结果/错误分层映射。
//
// **它不是判据层**（C1 硬边界，见包 §2.6）：
//   · 对 `state/store`、`state/gates` **零 import**；
//   · 零判据/策略码（门禁、工具黑名单、模式门、结算资格一律不在此判定）；
//   · 不缓存批状态、不自建 guard、不重试含语义判定。
//
// 为什么「唯一派发点」必须是宿主工具运行时：
//   宿主 `ToolRuntime` 的派发链固定经过 `tools/pre-execute` 水位与 `guardReason` 复核
//   ⇒ 难度门禁与「写族来源守卫」**必然生效**；若在此直调某个工具对象，两条防线都会被绕开。
//   故本文件只有**一处**工具派发调用（见下方 handler 内的唯一调用行），且它必须走宿主运行时。
import { sendJson } from '../json-response.js';
import { SUITE_TOOLS } from '../engine/suite.js';

/** 协议版本（钉死；`2026-07-28` 起的「无握手」形态不在本实现范围）。 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** 服务器自述（`initialize` 回包用）。 */
export const MCP_SERVER_INFO = Object.freeze({ name: 'dsh-punky-swarm-data-plane', version: '1.0.0' });

/** 数据面路径（复用宿主 webServer，不新起端口）。 */
export const MCP_PATH = '/mcp';

/** loopback 三值白名单（按 `req.socket.remoteAddress` 判定；非 loopback 一律拒）。 */
export const LOOPBACK_ADDRESSES = Object.freeze(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** 暴露族（**声明面**）：批内状态读写面 = `blackboard`（S1 迁族后的数据面）∪ `read`（只读投影面）。 */
export const EXPOSED_KINDS = Object.freeze(['blackboard', 'read']);

/**
 * 宿主提供、本仓**不注册**的只读件（声明面里出现、但注册表里查不到属**正常**）：
 * `list_agents` / `wait_agent` 由宿主 Team 面提供（见 `member-tools` 的同伴工具清单）。
 * ⚠ 二者在真宿主的可见性取决于 scope；本仓无法自证 ⇒ **登记未验证项**，不在此层兜底实现。
 */
export const HOST_PROVIDED_TOOLS = Object.freeze(['list_agents', 'wait_agent']);

const MAX_BODY_BYTES = 1 << 20; // 1 MiB：单帧上限（超限按畸形帧处理，不无限缓冲）

/**
 * 暴露集（**派生**，禁手写名单）：`{t │ t.kind ∈ {blackboard, read}}`。
 * 唯一的手写名单在测试侧（冻结基准），生产侧不复制。
 */
export function exposedToolNamesOf(suite = SUITE_TOOLS) {
  const kinds = new Set(EXPOSED_KINDS);
  return suite.filter((t) => t && kinds.has(t.kind)).map((t) => t.name);
}

/**
 * **可调面**（`tools/list` 真正宣告的集合）= 声明面 ∩ 实际可派发面。
 *
 * 为什么必须求交（S4 终验 ★ 缺口）：`log_export` 是**条件注册**（`logs` capability 默认关 ⇒ 不注册）。
 * 若只按 `kind` 静态声明，客户端会拿到一个**假契约**：`tools/list` 里有它，一调就 `unknown tool`。
 * 「声明了再告诉你调不到」是最差的失败形态 ⇒ **能宣告的必须真能调到**。
 *
 * 为什么**必须惰性**（每次请求算，不能安装时算一次）：`installMcpDataPlane` 在 `createTools` 开头调用，
 * 早于工具数组构造 ⇒ 安装时注册表还空着，此刻求交会得到空集（把整个数据面宣告成空）。
 *
 * 宿主件（`HOST_PROVIDED_TOOLS`）豁免求交：本仓不注册它们属正常形态。
 */
export function callableToolNamesOf(ctx, suite = SUITE_TOOLS) {
  const declared = exposedToolNamesOf(suite);
  const hostProvided = new Set(HOST_PROVIDED_TOOLS);
  return declared.filter((name) => {
    if (hostProvided.has(name)) return true; // 宿主提供：本仓未注册是正常
    try {
      return typeof ctx?.tools?.get === 'function' && ctx.tools.get(name) != null;
    } catch { return false; }
  });
}

/** loopback 判定（`remoteAddress` 不在白名单 ⇒ false）。 */
function isLoopback(req) {
  const addr = req?.socket?.remoteAddress;
  return typeof addr === 'string' && LOOPBACK_ADDRESSES.includes(addr);
}

/** 读请求体（UTF-8；超限截断并抛，由调用方转畸形帧）。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('request body too large')); req.destroy?.(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (e) => reject(e));
  });
}

/** JSON-RPC 成功帧。 */
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id: id ?? null, result });

/** JSON-RPC 错误帧（协议面错误；工具业务错**不**走这里 —— 见 P-5 分层）。 */
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** 工具结果 → MCP `CallToolResult`。宿主已产出 `{content,isError}` 时原样透传，否则包成 text 项。 */
function callResultOf(raw) {
  if (raw && typeof raw === 'object' && Array.isArray(raw.content)) return raw;
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
  return { content: [{ type: 'text', text }], isError: false };
}

/**
 * 安装 MCP 数据面。
 *
 * @param {object} ctx 宿主上下文（需 `webServer.register` / `tools.get` / `tools.execute`）
 * @param {object} deps 可选 `{ logger }`
 * @returns {() => void} disposer（注销路由）
 */
export function installMcpDataPlane(ctx, deps = {}) {
  const logger = deps.logger ?? ctx?.logger ?? null;
  const declaredCount = exposedToolNamesOf().length;

  /** 注册表视图里的工具定义（取不到 ⇒ null，**不抛**）。 */
  const definitionOf = (name) => {
    try {
      return typeof ctx?.tools?.get === 'function' ? ctx.tools.get(name) : null;
    } catch { return null; }
  };

  /** 单件 `tools/list` 条目（`inputSchema` 取注册表视图的 parameters；缺失给最小 object 形状）。 */
  const listItemOf = (name) => {
    const def = definitionOf(name);
    const params = def && typeof def.parameters === 'object' && def.parameters !== null ? def.parameters : null;
    return {
      name,
      description: (def && typeof def.description === 'string' && def.description.length > 0)
        ? def.description
        : (name + '（数据面工具）'),
      inputSchema: params ?? { type: 'object', properties: {} },
    };
  };

  /** 协议方法表：只实现契约卡 P-2 的三个方法（未知方法 ⇒ 调用方回 -32601）。 */
  const handlers = {
    initialize(params) {
      // 客户端版本不支持时回自己的最新版（P-7）。本实现只有一个版本 ⇒ 恒回钉死值。
      return {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...MCP_SERVER_INFO },
      };
    },
    'tools/list'() {
      // 惰性求交：此时的注册表已是装配完成态（见 `callableToolNamesOf` 的时序说明）
      return { tools: callableToolNamesOf(ctx).map(listItemOf) };
    },
    async 'tools/call'(params) {
      const name = params && typeof params.name === 'string' ? params.name : '';
      if (!name) return { protocolError: { code: -32602, message: 'invalid params: tools/call requires `name`' } };
      // 可调面之外 ⇒ 未知工具（**不落到工具层**：不该让未暴露的能力有机会执行）。
      //   含「条件注册未开」（如 `log_export`：logs 默认关）—— 它对客户端就是不存在，符合事实。
      if (!callableToolNamesOf(ctx).includes(name)) {
        return { protocolError: { code: -32601, message: 'unknown tool: ' + name } };
      }
      const args = (params && typeof params.arguments === 'object' && params.arguments !== null) ? params.arguments : {};
      // `arguments` **原样透传**（含或不含 `sourceRunId` 都不改写：缺 L1 的拒由守卫负责，
      //   本层**禁**兜底填来源、**禁**拿 `arguments.session` 冒充 run 身份）。
      const execInput = { callId: 'mcp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), name, arguments: args };
      try {
        const raw = await ctx.tools.execute(execInput);
        return { result: callResultOf(raw) };
      } catch (e) {
        // 【P-5 分层】工具**业务错**（含参数坏 / 记录不存在 / 上游故障）= 成功的 JSON-RPC 结果 + isError，
        //   模型能读到并自行恢复；**不**包成 error 帧（那样模型看不到原因）。
        const reason = String(e?.message ?? e);
        logger?.warn?.('[mcp] tool call failed: ' + name + '：' + reason);
        return { result: { content: [{ type: 'text', text: 'Error: ' + reason }], isError: true } };
      }
    },
  };

  /** 单帧处理：返回响应帧（通知无 id ⇒ 返回 null，不回包）。 */
  async function frameResultOf(frame) {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return rpcError(null, -32600, 'invalid request: frame must be an object');
    if (frame.jsonrpc !== '2.0' || typeof frame.method !== 'string' || frame.method.length === 0) {
      return rpcError(frame.id ?? null, -32600, 'invalid request: requires jsonrpc="2.0" + method');
    }
    const isNotification = !Object.prototype.hasOwnProperty.call(frame, 'id');
    // 客户端握手的第二步（通知，无回包）；本实现无需状态变更，收到即接受。
    if (frame.method === 'notifications/initialized') return null;
    const handler = handlers[frame.method];
    if (typeof handler !== 'function') {
      if (isNotification) return null;
      return rpcError(frame.id, -32601, 'method not found: ' + frame.method);
    }
    try {
      const out = await handler(frame.params);
      if (isNotification) return null;
      if (out && typeof out === 'object' && out.protocolError) {
        return rpcError(frame.id, out.protocolError.code, out.protocolError.message);
      }
      if (out && typeof out === 'object' && Object.prototype.hasOwnProperty.call(out, 'result')) {
        return rpcResult(frame.id, out.result);
      }
      return rpcResult(frame.id, out);
    } catch (e) {
      if (isNotification) return null;
      return rpcError(frame.id, -32603, 'internal error: ' + String(e?.message ?? e));
    }
  }

  const handler = async (req, res) => {
    // ── loopback-only（handler 首行校验；非 loopback 一律拒）───────────────────────────
    if (!isLoopback(req)) {
      logger?.warn?.('[mcp] rejected non-loopback request from ' + String(req?.socket?.remoteAddress));
      return sendJson(res, 200, rpcError(null, -32600, 'invalid request: loopback only'));
    }
    // ── 只开 POST（本面只做请求-响应；流式/SSE 不在本批）────────────────────────────
    if (String(req?.method ?? '').toUpperCase() !== 'POST') {
      return sendJson(res, 200, rpcError(null, -32600, 'invalid request: POST only'));
    }
    let frame;
    try {
      const text = await readBody(req);
      frame = JSON.parse(text);
    } catch (e) {
      // 帧无法解析 ⇒ -32700（解析错误）/ 超限按畸形帧 -32600
      const tooLarge = /too large/.test(String(e?.message ?? ''));
      return sendJson(res, 200, rpcError(null, tooLarge ? -32600 : -32700, tooLarge ? 'invalid request: body too large' : 'parse error'));
    }
    const out = await frameResultOf(frame);
    if (out === null) { res.statusCode = 202; res.end(); return undefined; }
    return sendJson(res, 200, out);
  };

  // 宿主无 webServer 服务 ⇒ **本面不装是正常形态**（CLI / stdio 部署没有 webServer 法定面），
  //   不是异常：故此处**不发 warn**（`debug` 留痕即可，避免让下游用日志过滤去消化合法形态的噪声），
  //   也不抛（不可把「本面未挂载」升级成「整块工具面装配失败」）。
  //   ⚠ 可观测性不靠日志：返回的 disposer 上带 `installed` 布尔（**fail-closed 判据在返回值**，
  //     与 `installWriteProvenanceGuard` 的 true/false 同族）。
  if (typeof ctx?.webServer?.register !== 'function') {
    logger?.debug?.('[mcp] data plane not mounted：ctx.webServer.register 不可用（合法部署形态）');
    const notMounted = () => {};
    notMounted.installed = false;
    return notMounted;
  }

  const dispose = ctx.webServer.register({ method: 'POST', kind: 'exact', path: MCP_PATH, handler });
  logger?.info?.('[mcp] data plane mounted at ' + MCP_PATH + '（protocol ' + MCP_PROTOCOL_VERSION
    + '，声明 ' + declaredCount + ' 件；实际宣告按可调面惰性求交）');
  const dispo = typeof dispose === 'function' ? dispose : () => {};
  // 【第三态】register 返回非函数（宿主实现差异 / 注册被拒）⇒ **未装**：不可只因「没抛异常」就报 true。
  dispo.installed = typeof dispose === 'function';
  return dispo;
}
