# MCP 数据面（任务黑板）契约与缺口台账

> 状态：**活文档**（入库版，单一真源）。新增缺口请追加；修完标注日期与提交，**不要删历史条目**（留溯源）。
> 最近更新：2026-11-09（元数据补齐 `b209e31` / 结构化输出 `607f00b` / 多批读面预算 `f7d3a9a`）
> 位置说明：包内 `docs/` 按仓库政策不入库（`.gitignore:50`），故本台账落在**入库的 `reports/`**。

## 1. 这个面是什么

蟛蜞引擎把任务黑板（批次状态机 / 交接门 / 任务池 / 任务包）以 MCP 协议暴露，
使**外部 MCP 客户端**（Claude Desktop、codex 等）无需进入 punky 模式也能读写这批通用任务状态。

| 项 | 值 | 定义面 |
|---|---|---|
| 端点 | `http://127.0.0.1:3918/mcp` | `MCP_LOOPBACK_DEFAULTS`（`lib/schema.js`） |
| 协议版本 | `2025-06-18` | `MCP_PROTOCOL_VERSION`（`lib/mcp/data-plane-server.js`） |
| `serverInfo.name` | `dsh-punky-swarm-data-plane` | `MCP_SERVER_INFO` |
| 常驻工具 | **7 件**（读 5 / 写 2） | `RESIDENT_TOOL_NAMES`（`lib/engine/suite.js`） |
| 监听形态 | 插件自有 `node:http`，绑 `127.0.0.1` | `lib/mcp/loopback-listener.js` |

7 件：`batch_status`、`handoff_view`、`task_pool`、`taskpack_for`、`role_guide`、
`handoff_submit`、`handoff_accept`。

**为什么不走宿主路由**：宿主 `browserAccess: false` 时所有非 GUI 的 HTTP 请求返回
`403 Browser access is disabled`，且该闸门**只包裹** `webServer.register` / `registerFallback`
注册的路由、**无路径级放行**。插件自建监听器不经过它 ⇒ 结构性免疫。
两入口共用同一份协议逻辑（`createMcpHandler`）：A = 宿主路由（webServer 缺席时早退），
B = 自建 loopback（不依赖 webServer，L1 模式的唯一可用路径）。

### 元数据与服务器指导（2025-06-18 合规面，提交 `b209e31`）

`tools/list` 每条 = `{name, title, description, inputSchema, annotations}`；`initialize` 回包含 `instructions`。
三项均为增量，不改任何工具的调用行为：

| 字段 | 内容 | 为什么需要 |
|---|---|---|
| `title` | 英文显示名 | 客户端显示名优先级 `title → annotations.title → name` |
| `annotations` | 5 读件 `readOnlyHint:true`；2 写件 `readOnlyHint:false` + `destructiveHint:false`；`handoff_accept` 幂等、`handoff_submit` 非幂等（`overwrite` 会改入边） | 客户端据此判断能否自动批准；**缺它则写黑板与读黑板在客户端眼里同类** |
| `instructions` | 面向模型的用法指导（概念 / 先读后写顺序 / `session` 必填 / `limit:0` 取全量） | 概念密度高，单工具 `description` 说不清顺序；兼作 G-1 会话缺口的文档级补偿 |

取值纪律：`ToolAnnotations` 在规范里只是 **hint**（客户端不应据此做安全决策）⇒ 只设有把握的维度；
只读件不设 `destructiveHint`（规范说只读时该字段无意义）。元数据表在 `lib/mcp/data-plane-server.js`
（`MCP_TOOL_TITLES` / `MCP_TOOL_ANNOTATIONS` / `MCP_INSTRUCTIONS`），**不改宿主 `defineTool`**。
`test/mcp-spec-metadata.test.js` 的 M-1 双向锁住「表键集 = 常驻名单」——加工具不配元数据即红。

## 2. 缺口台账

### G-1 会话解析缺口 —— **待适配其他宿主时再改**（用户 2026-11-09 裁决）

**现状**：只有 `batch_status` 做了会话兜底（未解析到调用方会话 ⇒ 全会话并集，`sessionScope:'all'`）。
其余 3 件读黑板件（`task_pool` / `handoff_view` / `taskpack_for`）的 `sessionOf` 回落到 `'cli'` 哨兵，
MCP 直连（无 `exec.agent`）时**必然查不到真实批次**。

实测（真实盘面）：

| 工具 | 不带 `session` | 带 `session` |
|---|---|---|
| `batch_status {}` | ✅ `sessionScope:all`，511 批 | ✅ 4 批 |
| `task_pool` | ❌ `batch not found: ... @cli` | ✅ `pooled=0 dispatched=3` |
| `handoff_view` | ❌ `batch not found: ...` | ✅ `handoff A1: READY (edges=2)` |
| `taskpack_for` | ❌ `batch not found: ...` | ✅ 52 行任务包 |

**裁决记录**：先留档，不改。理由（用户原话）：*"MCP 化之前是绑会话的，之后再定方案"* ——
MCP 化前所有工具语义本就建立在会话绑定上，会话解析不是缺陷而是既有设计前提。
缓解手段（已实装）：`instructions` 里明确告知「除 `batch_status` 外均需显式 `session`，
外部客户端不知道 session 时先用 `batch_status` 的返回体查出所属会话」。

**未来方案候选**（未采用，仅备查）：
- 只读面：session 解析为 `'cli'` 且给了 `batchId` 时，用 `listAllBatches()` 按 batchId 反查
  真实会话（`lib/engine/dispatch-bind.js` 已有同款兜底可参照）。
- **写面绝不猜**：`handoff_submit` / `handoff_accept` 按猜测的会话写入会污染真源，
  必须显式 `session`，否则拒绝。

### G-2 结构化输出 —— **已修**（2026-11-09，`607f00b`）

**问题**：`tools/call` 返回体顶层键曾是 `{isError, content, value}` —— 真实数据在**自定义** `value`，
标准字段是 `structuredContent`。标准客户端只认后者 ⇒ 只能看到 `content` 里那一行 render 摘要，数据面不可用。

**修法**：`callResultOf` 把 object 形态的 `value` 提升为标准 `structuredContent`，同时保留 `value`（零破坏）。

两条**刻意不做**（各有理由，勿当遗漏"顺手补上"，测试反向锁住）：

1. **不声明 `Tool.outputSchema`**：声明后 `structuredContent` 变为必填且必须匹配，客户端会校验并报错
   （见 [MCP Tools 规范](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)、
   [RFC #371](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/371)）。7 件工具的
   `output.schema` 与真实返回体是否逐字段一致是**独立的一件事**，不与该修复捆绑。
2. **不向 `content` 追加序列化 JSON**（规范只是 SHOULD）：`content` 整段进模型上下文，
   511 批场景等于把全量数据灌进 prompt；`structuredContent` 已是标准通路。

反向锁：`test/mcp-structured-content.test.js` 的 SC-3 / SC-4。

### G-3 多批读面成本 —— **已修**（2026-11-09，`f7d3a9a`）

fallback 并集读面此前对每批都 `readBatch`，成本随批数线性增长。现改为按批文件 mtime 降序 +
`limit`（缺省 50，0 = 不限），`total` 回显裁剪前总数、`limitApplied` 回显生效上限（0 = 未裁剪）。

实测（真实根 101 会话 / 511 批、热缓存）：完整工具调用 **226.9ms → 41.7ms（−81.6%）**；
store 层逐批读盘 202.9ms → 43.3ms（stat 0.03ms/批 vs readBatch 0.40ms/批，快 14.4×）。
复跑：`node scripts/probe-batch-status-budget.mjs`。

⚠ `limit` 缺省 50 ⇒ `batch_status {}` 不再返回 511 条全量，要全量须显式传 `limit: 0`。

### G-4 工具元数据缺失 —— **已修**（2026-11-09，`b209e31`）

此前 `tools/list` 条目恒为 `["name","description","inputSchema"]`、`initialize` 恒无 `instructions`。
已补齐，详见 §1。配套：`handoff_view` / `handoff_submit` / `handoff_accept` 的 `batchId` 补描述
（此前 3 件必填参数里只有它没有 description；`session` 本来就有）；`batch_status` description
911 → 约 190 字符（细节移交 `instructions`），瘦身保留 `test/session-fallback.test.js` 锁住的两句契约文本。

⚠ **侦查纠正（记录以免后人重走弯路）**：一度怀疑参数里 property 级 `"required":true` 与
`"type":"json"` 不合 JSON Schema，**实测不成立** —— 宿主 `defineTool` 在注册时已把源码方言
规范化为标准 JSON Schema（活体 property 级 required 残留 0 处、非法 type 0 处）。
**源码书写格式 ≠ `tools/list` 发出的内容** ⇒ 判断 MCP 合规性必须看活体回包，不能只读源码。

### 明确不做的

| 项 | 理由 |
|---|---|
| 分页 `nextCursor` | 7 件固定集，一次返回完；规范里 cursor 可选 |
| `_meta` 版本戳 | 无消费方需求 |
| 给 `inputSchema` 注入 `additionalProperties:false` | 服务端实际宽松（忽略多余参数），客户端严格会与服务端行为不一致 |

## 3. 验证方式

```bash
# 协议面 / 结构化输出 / 元数据（不启监听，直接驱动 handler）
node --import ./test/helpers/isolated-home.preload.mjs --test test/mcp-data-plane.test.js
node --import ./test/helpers/isolated-home.preload.mjs --test test/mcp-structured-content.test.js
node --import ./test/helpers/isolated-home.preload.mjs --test test/mcp-spec-metadata.test.js

# 入口 B 监听生命周期（真监听 + 真 fetch）
node --import ./test/helpers/isolated-home.preload.mjs --test test/mcp-loopback.test.js

# 活体验收（宿主在跑时）
curl -s -X POST http://127.0.0.1:3918/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'
```

⚠ 服务是否存活**只认直接请求**：`Get-NetTCPConnection` / `netstat` 过滤都出现过假阴性
（端口在听却读成没听），不可作为否定证据。
