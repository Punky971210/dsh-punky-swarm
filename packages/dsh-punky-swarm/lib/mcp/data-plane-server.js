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

import { sendJson } from '../json-response.js';
import { createToolsPort, createHttpPort } from '../provider-dsh/tools-http.js';
import { SUITE_TOOLS, RESIDENT_TOOL_NAMES } from '../engine/suite.js';
import { HOST_INTERSECT_EXEMPT } from '../governance/host-tools.js';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** 服务器自述（`initialize` 回包用）。 */
export const MCP_SERVER_INFO = Object.freeze({ name: 'dsh-punky-swarm-data-plane', version: '1.0.0' });

/**
 * 面向**模型**的服务器级指导（`InitializeResult.instructions`，2025-06-18 起合规）。
 * 客户端会把它放进 system prompt。
 *
 * 为什么值得有：本面的概念密度高（batch / lane / handoff / 门禁 / 缺口清单），外部模型没有任何
 *   线索；而单工具的 `description` 只能描述**自己**，说不清「先读什么、再写什么」的用法顺序。
 * 它同时是**会话解析缺口（G-1，docs/mcp-data-plane.md）的文档级补偿**：明确告知
 *   「除 batch_status 外都需显式 session」，让外部模型不至于反复撞 `batch not found`。
 * 措辞刻意避开内部黑话（不提 lane 状态机、GATE_* 码、wavePlan），只讲怎么用。
 */
export const MCP_INSTRUCTIONS = [
  '任务黑板服务器：管理多智能体任务的治理状态（批次、任务、交接）。',
  '概念：batch = 一次任务的治理单元；lane = 一个角色的一次执行；handoff = 上游 lane 向下游交付产物与断言。',
  '用法：① 先用 batch_status 列可用批次（按最近活跃排序；返回条数少于 total 即已裁剪，要全量传 limit:0）；',
  '② 用 task_pool 查某批还有哪些任务未派发；③ 用 taskpack_for 取某 lane 的完整任务包；',
  '④ 用 handoff_view 读交接状态，用 handoff_submit 提交上游交接，用 handoff_accept 接受后置入边。',
  '批次拓扑的真源 = 各 lane 的 deps 声明 + 已提交的 handoff 记录（逐边取件见 handoff_view）。',
  '注意：黑板按会话隔离 —— 除 batch_status 外，其余工具均需显式传 session（外部客户端不知道 session 时，先用 batch_status 的返回体查出所属会话）。',
  '写操作受门禁校验：缺前置产物或断言不全会被拒并返回缺口清单，按提示补齐后再提交。',
].join(' ');

/** MCP 显示名（规范优先级：`title` → `annotations.title` → `name`）。仅 MCP 面使用，不改工具定义本身。 */
export const MCP_TOOL_TITLES = Object.freeze({
  batch_status: 'Batch Status',
  handoff_view: 'Handoff View',
  task_pool: 'Task Pool',
  taskpack_for: 'Task Pack',
  role_guide: 'Role Guide',
  handoff_submit: 'Handoff Submit',
  handoff_accept: 'Handoff Accept',
});

/**
 * 工具行为提示（MCP `ToolAnnotations`）。规范明确这些只是 **hint**：
 *   "Clients should never make tool decisions based on ToolAnnotations received from untrusted servers."
 * 但主流客户端确实用 `readOnlyHint` 判断能否自动批准 —— 而此前 7 件全部缺失，
 *   于是「读黑板」与「写黑板」在客户端眼里是同一类动作（对 `handoff_submit` 也自动批准）。
 *
 * 取值纪律：**只设我们有把握的维度**。`destructiveHint` 仅在非只读工具上给（只读时规范说该字段无意义）。
 * 为什么不改宿主 `defineTool`：它不接受这些字段；且 MCP 面元数据本就该由本面维护（不跨包改）。
 */
const READ_ONLY_HINTS = Object.freeze({ readOnlyHint: true, idempotentHint: true, openWorldHint: false });
export const MCP_TOOL_ANNOTATIONS = Object.freeze({
  batch_status: READ_ONLY_HINTS,
  handoff_view: READ_ONLY_HINTS,
  task_pool: READ_ONLY_HINTS,
  taskpack_for: READ_ONLY_HINTS,
  role_guide: READ_ONLY_HINTS,
  // 写面：只追加、不删改已有入边（destructiveHint:false）；但 `overwrite:true` 可替换既有入边 ⇒ 非幂等
  handoff_submit: Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }),
  // 写面：二次提交幂等（响应体带 `idempotent` 标记）；不破坏已有数据
  handoff_accept: Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
});

/** 数据面路径（复用宿主 webServer，不新起端口）。 */
export const MCP_PATH = '/mcp';

/** loopback 三值白名单（按 `req.socket.remoteAddress` 判定；非 loopback 一律拒）。 */
export const LOOPBACK_ADDRESSES = Object.freeze(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** 暴露族（**声明面**）：批内状态读写面 = `blackboard`（S1 迁族后的数据面）∪ `read`（只读投影面）。 */
export const EXPOSED_KINDS = Object.freeze(['blackboard', 'read']);

// 【M1 · `:56` 删除本地定义】原处手写 `Object.freeze(['list_agents','wait_agent'])`（2 件的
//   **求交豁免子集**，却顶着「宿主提供」的名字）⇒ 已下沉到 `lib/governance/host-tools.js` 的
//   `HOST_INTERSECT_EXEMPT`（策略语义），本处仅保留**同名再导出**以不破外部消费面。
//   ⚠ 再导出**取值 = HOST_INTERSECT_EXEMPT（2 件）**，不是 7 件事实集：本符号的**既有消费方**
//   （如 `test/mcp-data-plane.test.js:102` 按它建宿主桩）依赖的是「2 件豁免子集」这一行为；
//   若换成 7 件全集，桩循环会静默从 2 次变 7 次（**行为变更藏在一个改名里**，正是本批要治的病）。
/** @deprecated **名字骗人**：语义 = **求交豁免子集**（2 件），非「宿主提供全集（7 件）」。新代码请直接用 `HOST_INTERSECT_EXEMPT` / `HOST_PROVIDED_TOOLS`。 */
export const HOST_PROVIDED_TOOLS = HOST_INTERSECT_EXEMPT;

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
 * **求交豁免**（`HOST_INTERSECT_EXEMPT`）：这 2 件不参与求交 —— 它们是宿主 Team 面只读件，
 * 本仓不注册它们属正常形态，且本仓无法自证其在真宿主的可见性（登记未验证）。
 * ⚠ **M1 语义更正**：本行原写 `HOST_PROVIDED_TOOLS`（那曾是个 2 件数组）；求交需要的从来是
 * **豁免子集（策略）**，不是「宿主提供全集（事实 7 件）」——若误用全集，会把 `subagent` 等
 * 未注册件一并豁免，等于放宽「能宣告必须真能调到」。故改为 `HOST_INTERSECT_EXEMPT`。
 */
export function callableToolNamesOf(ctx, declaredNames = RESIDENT_TOOL_NAMES) {
  // 【2026-11-09 常驻面收窄】声明基准从「kind ∈ EXPOSED_KINDS 的 21 件」改为**显式常驻名单 7 件**
  //   （`lib/engine/suite.js` 的 RESIDENT_TOOL_NAMES）。两个理由：
  //     ① 排除项横跨 blackboard/read 两族（gate_status/artifact_types/log_export 在族内、lane_checkpoint_status 在 read）
  //        ⇒ kind 派生无法表达逐件取舍；
  //     ② 宿主面 `list_agents`/`wait_agent` 若仍走 `HOST_INTERSECT_EXEMPT` 豁免，会被**无条件宣告**，
  //        而宿主对二者硬要求 `exec.agent` ⇒ MCP 通道结构性调不通 = 假契约（违反下方 :60-62 的判据原则）。
  //   `hostProvided` 仍参与判断（名单命中时豁免求交），但常驻集不含宿主件 ⇒ 当前恒不命中；
  //   保留它以不破坏「宿主提供面如何豁免」这一既有策略表达。
  const hostProvided = new Set(HOST_INTERSECT_EXEMPT);
  return declaredNames.filter((name) => {
    if (hostProvided.has(name)) return true;
    try {
      return createToolsPort(ctx).probeTool(name).state === 'present';
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

/**
 * 结构化输出提升：宿主 `tools.execute` 把工具的**原始返回值**放在自定义字段 `value` 上，
 * 而 MCP 2025-06-18 的标准字段是 `structuredContent`（JSON **object**）。
 * 标准客户端（Claude Desktop / codex 等）只认 `structuredContent`，读不到 `value`
 * ⇒ 修复前所有工具在它们眼里只有 `content` 里那一行 render 摘要（数据面实际不可用）。
 *
 * 三条刻意的边界（均为显式决策，非遗漏）：
 *   ① **不声明 `Tool.outputSchema`**。规范规定：工具一旦声明 outputSchema，`structuredContent`
 *      即变为**必填且必须匹配该 schema**，客户端会校验并在不匹配时报错。7 个常驻工具的
 *      `output.schema` 与真实返回体是否逐字段一致，是**另一件事**；与该修复捆在一起会把
 *      「补一个标准字段」变成「可能让现有调用变红」。未声明时 `structuredContent` 是可选字段，
 *      客户端当数据处理、不校验 ⇒ 本改动是纯增量。
 *   ② **不在 `content` 里追加序列化 JSON**（规范只是 SHOULD）。`content` 会整段进模型上下文；
 *      511 批场景追加 JSON 等于把全量数据灌进 prompt。`structuredContent` 已是标准通路。
 *      该偏离连同理由记录在 `docs/mcp-data-plane.md`。
 *   ③ **保留 `value` 原字段**。旧消费方（含本仓自己的探针）已按 `value` 读，删掉即破坏兼容。
 *
 * @param {object} raw 宿主回包 `{content, isError, value?}`
 * @returns {object} 需要并入结果的字段（非 object 的 `value` 一律不提升：数组/标量不合规范）
 */
function structuredContentOf(raw) {
  const v = raw?.value;
  return (v !== null && typeof v === 'object' && !Array.isArray(v)) ? { structuredContent: v } : {};
}

/** 工具结果 → MCP `CallToolResult`。宿主已产出 `{content,isError}` 时原样透传并补标准结构化字段，否则包成 text 项。 */
function callResultOf(raw) {
  if (raw && typeof raw === 'object' && Array.isArray(raw.content)) return { ...raw, ...structuredContentOf(raw) };
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
  return { content: [{ type: 'text', text }], isError: false };
}

/**
 * 降级兜底错误帧（**单点构造**）：入口 B 的外层 `catch` 复用本函数，禁在监听器里再写一份帧字面量
 * （C-2：协议面只有一处构造点）。仅在 handler 自身 reject 的**不可达常态**下使用（R-5）。
 */
export function mcpInternalErrorFrame(message) {
  return rpcError(null, -32603, message ?? 'internal error');
}

/**
 * MCP 协议面工厂 —— **两入口共用的唯一逻辑源**（C-2 禁第二套实现）。
 *
 * 【2026-11-09 · 批 `punky-mcp-l1-wiring` · 判据源 §3.1】从 `installMcpDataPlane` 抽出。抽出的**唯一理由**：
 *   入口 B（`lib/mcp/loopback-listener.js` 自建 `node:http`）必须与入口 A（宿主 `webServer` 路由）共用同一份
 *   协议逻辑，而 `installMcpDataPlane` 在 `createHttpPort(ctx).available === false` 时**早退**（见下方
 *   `notMounted`）—— 若把入口 B 装在它内部，宿主 webServer 缺席时入口 B 也一并消失，恰好废掉 L1 模式
 *   唯一的价值场景（webServer 缺席仍可用 = AC-10）。
 *   ⇒ 本工厂**不接触 webServer**（不出现宿主 webServer 服务取件形态，全部经 `createHttpPort` 端口层）；
 *     装配点在各自入口：A = `installMcpDataPlane`（下方）；B = `lib/tools/register.js#createTools`。
 *
 * @param {object} ctx 宿主上下文（需 `tools.get` / `tools.execute`；**不需要** `webServer`）
 * @param {object} deps 可选 `{ logger }`
 * @returns {{ handler: (req: object, res: object) => Promise<unknown> }} 纯 `node:http` 签名的 handler
 */
export function createMcpHandler(ctx, deps = {}) {
  const logger = deps.logger ?? ctx?.logger ?? null;

  /** 注册表视图里的工具定义（取不到 ⇒ null，**不抛**；`errored` 与「无定义」在此同归 null）。 */
  const definitionOf = (name) => {
    try {
      const probed = createToolsPort(ctx).probeTool(name);
      return probed.state === 'present' ? probed.definition : null;
    } catch { return null; }
  };

  /** 单件 `tools/list` 条目（`inputSchema` 取注册表视图的 parameters；缺失给最小 object 形状）。
   *  `title` / `annotations` 由**本面**补：宿主 `defineTool` 的定义里没有这两项，
   *  而它们是 MCP 客户端识别「显示名」与「能否自动批准」的唯一依据。 */
  const listItemOf = (name) => {
    const def = definitionOf(name);
    const params = def && typeof def.parameters === 'object' && def.parameters !== null ? def.parameters : null;
    return {
      name,
      description: (def && typeof def.description === 'string' && def.description.length > 0)
        ? def.description
        : (name + '（数据面工具）'),
      inputSchema: params ?? { type: 'object', properties: {} },
      ...(MCP_TOOL_TITLES[name] ? { title: MCP_TOOL_TITLES[name] } : {}),
      ...(MCP_TOOL_ANNOTATIONS[name] ? { annotations: MCP_TOOL_ANNOTATIONS[name] } : {}),
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
        // 2025-06-18 的 `InitializeResult` 支持 `instructions`（面向模型、客户端放进 system prompt）。
        //   本面概念密度高，没有它外部模型只能靠 description 试错；同时它是 G-1 会话缺口的文档级补偿。
        instructions: MCP_INSTRUCTIONS,
      };
    },
    'tools/list'() {
      // 惰性求交：此时的注册表已是装配完成态（见 `callableToolNamesOf` 的时序说明）
      return { tools: callableToolNamesOf(ctx).map(listItemOf) };
    },
    async 'tools/call'(params) {
      const name = params && typeof params.name === 'string' ? params.name : '';
      if (!name) return { protocolError: { code: -32602, message: 'invalid params: tools/call requires `name`' } };
      // 【M2 三态 · 查询失败 ≠ 不存在】**必须在 -32601 分支之前**判定：注册表查询抛错时，
      //   若落到 unknown tool 分支，模型会看到「工具不存在」而真相是「数据面坏了」。
      //   ⇒ errored 一律映射 -32603 并带原文；absent 才走 -32601（维持不变）。
      const probedForCall = createToolsPort(ctx).probeTool(name);
      if (probedForCall.state === 'errored') {
        logger?.warn?.('[mcp][degraded] tool registry query failed: ' + name + '：' + probedForCall.reason);
        return { protocolError: { code: -32603, message: probedForCall.reason } };
      }
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
        // 【signal 缺陷根治 · C-5】宿主必读 exec.signal（缺则 Node 原生 TypeError 且 execute 体不进）。
      //   本层持有**真实 AbortSignal**。⚠ **显式登记的降级**：`handlers[tools/call]` 由外层 `:210 handler(frame.params)` 调用，`req` 不在本层作用域 ⇒ 无法接 req 的 close/aborted 事件面 ⇒
      //   此处**每请求新建一个永不 abort 的 AbortController**（满足宿主对真实 AbortSignal 的要求，但**不会**随连接关闭而取消）。
      //   升级路径 = 把外层 handler 的 req 透传进本层后接 close/aborted。**禁默认静默**：此降级已在 exec/e2-ports.md 登记。
      const requestAbort = new AbortController();
      const raw = await createToolsPort(ctx).invokeTool({ name, args, signal: requestAbort.signal, correlation: execInput.callId });
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

  return { handler };
}

/**
 * 安装 MCP 数据面（入口 A：宿主 `webServer` 路由 `POST /mcp`）。
 *
 * 对外返回契约与 `installed` 语义**逐字不变**（R-1/R-12）：`!available` ⇒ `installed=false` 的 no-op disposer；
 *   `mountRoute` 返回的 disposer 非函数 ⇒ `installed=false`（第三态，见文末）。
 *
 * @param {object} ctx 宿主上下文（需 `webServer.register` / `tools.get` / `tools.execute`）
 * @param {object} deps 可选 `{ logger }`
 * @returns {() => void} disposer（注销路由）
 */
export function installMcpDataPlane(ctx, deps = {}) {
  const logger = deps.logger ?? ctx?.logger ?? null;
  const declaredCount = RESIDENT_TOOL_NAMES.length;
  const { handler } = createMcpHandler(ctx, deps);

  const httpPort = createHttpPort(ctx);
  if (!httpPort.available) {
    logger?.debug?.('[mcp] data plane not mounted：HTTP 功能面不可用（provider 端口 available=false，合法部署形态）');
    const notMounted = () => {};
    notMounted.installed = false;
    return notMounted;
  }

  const mounted = httpPort.mountRoute({ method: 'POST', path: MCP_PATH, handler });
  const dispose = mounted.dispose;
  logger?.info?.('[mcp] data plane mounted at ' + MCP_PATH + '（protocol ' + MCP_PROTOCOL_VERSION
    + '，声明 ' + declaredCount + ' 件；实际宣告按可调面惰性求交）');
  const dispo = typeof dispose === 'function' ? dispose : () => {};
  // 【第三态】register 返回非函数（宿主实现差异 / 注册被拒）⇒ **未装**：不可只因「没抛异常」就报 true。
  dispo.installed = typeof dispose === 'function';
  return dispo;
}
