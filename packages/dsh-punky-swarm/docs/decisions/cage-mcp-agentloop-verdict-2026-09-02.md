# 决策备忘：CAGE 评估结论 + MCP 协议边界 + agentLoop 植入分级判定

- 日期：2026-09-02
- 主题：治理内核跨 harness 的承载形态（MCP 网关 vs 进程内 guard）与"通用 agent 能否 agentLoop 级插件植入"评估
- 决策状态：结论已收敛（与 2026-08 既有决策一致，本备忘补协议级证据与分级判定）
- 归属：蟛蜞模式 / dsh-punky-swarm 架构决策系列
- 关联批次会话：cage-agentloop-verdict（镜像 session-7dad5e65-8f74-4b60-a16a-cf77b8aca4f3）

---

## 0. 结论摘要（三条判定）

1. **判定 A（成立）**：治理内核做成 MCP 无法囊括 agent 会话生命周期——MCP 是"能力面"（agent↔工具）无状态协议，官方正主动无状态化（SEP-2567），会话/任务生命周期属于任务协议层与有状态运行时，不属于 MCP。
2. **判定 B（成立，需分级校准）**："通用 agent 暂时无法实现 agentLoop 级别的插件植入"基本成立，但必须按 harness 开放深度分级表述；dsh（Cordis 内核）属**引擎级（L2）例外**，属架构属性而非标准能力。
3. **判定 C（架构推论）**：蟛蜞模式跨大厂 harness 的现实形态 = L0 能力面（工具/MCP/hook）+ 协议层任务治理（AIP/ACPs/A2A task）+ 自有有状态运行时；"把 dsh 引擎级治理完整搬上托管平台"不可行（平台运行时黑盒），开源/本地框架可行但需重写适配器。

---

## 1. agentLoop 植入深度分级阶梯（评估的坐标系）

| 级 | 名称 | 能做什么 | 谁可达 |
|---|---|---|---|
| L0 | 能力面（callable） | 工具/插件作为可调用项注册；治理只能 per-call 拦截（gate 检查点） | 一切平台：MCP tools、Coze 插件、Aily 自定义智能体工具、WorkBuddy 生态能力、元器插件 |
| L1 | 迭代内 hook | agentLoop 内模型调用/工具调用前后拦截（pre/post tool、流事件订阅） | 开源/本地框架（LangGraph 节点、Agent SDK middleware/hooks、Claude Agent SDK）；Claude Code hooks 类半例外；托管 SaaS 不可达（运行时黑盒） |
| L2 | 引擎级插件 | 进程内 guard/状态机/生命周期事件/会话事实源/客户端注入 | dsh（Cordis 内核插件化 + cordis.patch.yml + dsh-tools 契约 + client inject）——目前事实上的唯一深度例外 |

**校准要点**：
- Claude Code / CodeBuddy 类本地 CLI harness 可达 L1（tool 前后 hooks），但无批次状态机、无多 agent 会话黑板、无结算回写——治理语义仍需外部有状态层，故不算 L2。
- 托管平台若开放"自定义运行时/自托管节点"，可把 agentLoop 移到自己进程，但那已不是"该平台的 agent"，而是平台外的 agent——不算平台支持植入。
- 未来若 AIP 国标 / A2A task 生命周期被平台采纳，任务级治理可经协议表达（L2 部分语义外溢到协议层），但那仍是"任务协议治理"，非"agentLoop 插件植入"。

## 2. 判定 B 的完整表述

> **托管式通用 agent 平台（Coze / 飞书 Aily / 豆包工作 / WorkBuddy / 元器类）当前无法让第三方做 agentLoop 级插件植入**——只开放 L0（能力面），L1 hooks 亦不开放。
> 开源/本地框架可达 L1；L2 仅 dsh 类"自建内核插件化"harness 可达。
> **dsh/Cordis 属例外且非普适**：dsh-punky-swarm 能深入 agent 生命周期（引擎级门禁强制、guard 进程内、14 治理工具、checkpoint 落盘续跑、客户端注入、会话文件事实源），是因为 Cordis 内核本身插件化 + 引擎契约开放，是架构属性，不是协议/标准能力——这正说明通用平台短期不会跟进到 L2。

## 3. CAGE 评估结论（既有决策回溯 + 协议证据）

### 3.1 rails 体系（openjiuwen rails）
- 四维兼容性 3/4 不满足、提示注入防护 4/4 不满足、模型侧需新增宿主 API → **舍弃移植**。
- 仅保留设计借鉴：流事件 / tiered_policy / 动态装配 / 提示注入挂起。

### 3.2 CAGE 的 MCP 接入（进程外网关）
- **实效性问题成立**：进程外 MCP 网关把编排状态压扁成散落独立调用；门禁长挂起（needHuman）、checkpoint 恢复、mailbox 异步、事件流审计、结算回写全部失真。
- **收敛决策**：不做 MCP 网关 → dsh 原生 guard 进程内 + CAGE 纯函数内核嵌入；仅借鉴工具调用 hook 层。
- 反例印证：agent-governance-mcp（MCP server 做多 IDE agent 门禁）的能力边界即单次调用拦截（shared state/rule drift/lost updates per-call gate），够不到编排生命周期。

## 4. MCP 语义边界证据（为什么囊括不了会话生命周期）

| 治理需求 | MCP 能否表达 |
|---|---|
| 批次/DAG 分波推进（wavePlan 状态机） | ❌ 无批次/任务对象，调用无状态 |
| 门禁长挂起（needHuman 人工闸） | ❌ 请求-响应模型，无长时运行/恢复 |
| checkpoint 断点 + 崩溃续跑 | ❌ 无持久化会话，恢复信息全外置 |
| mailbox 异步投递（黑板） | ❌ 无队列/订阅一等语义 |
| 锁/并发/结算回写（settle 状态机） | ❌ 无状态写模型 |
| 事件流审计（批次事件回放） | ❌ 无事件存储语义 |
| **工具调用 hook / gate 拦截点** | ✅ 本职能力 |

官方与学术佐证：
- SEP-2567 "Sessionless MCP via Explicit State Handles"（modelcontextprotocol.io）——MCP 正把会话状态显式推出协议，状态句柄外置。
- New Relic《MCP is going stateless》；it168《MCP无状态化之后：Agent协议真正开始竞争什么？》。
- arXiv 2606.19135《A Technical Taxonomy of LLM Agent Communication Protocols》——MCP=agent↔tool 能力协议；agent↔agent 编排/任务生命周期=A2A/ACPs 类任务协议。
- arXiv 2607.23884《A Comparative Study of MCP and A2A for Inter-Agent Coordination》。
- A2A v1.0 Builder's Guide（Discovery/Tasks/Clients）——任务生命周期语义所在层。

## 5. 对"蟛蜞模式改装大厂 harness"设想的推论

1. 跨平台可携带的是：L0 治理内核（纯函数/库形态进程内嵌入）+ L2 标准通信层（AIP 国标主线 + ACPs 桥 + MCP 工具面）+ jiufeng-team 技能资产。
2. 需要按目标重写的是：L1 harness 适配器——字节侧第一落点 = 治理能力面挂 Coze（官方支持基于 MCP 建插件）+ Aily 自定义智能体 API（任务/会话在平台运行时内）；腾讯侧唯一现成规格 = CodeBuddy CLI 插件文档（形态同构，深度待精读）；WorkBuddy 走生态伙伴制、互操作规格未公开。
3. 实效性边界：托管控件的治理深度封顶在 L0+L1-hook；要达到 dsh 的 L2 治理深度，只能选"内核插件化"的 harness 或自建运行时——这是选型硬约束，不是工程技巧问题。

## 6. 未核实项 / 后续复核点

- CAGE 项目公开仓库未能从公开检索锁定（评估基于既有源码级结论 + 协议规范证据，不依赖项目识别）。
- WorkBuddy"五大生态能力"清单与 agent 互操作开放度未公开——决定腾讯侧落地深度。
- CodeBuddy 插件文档深度（是否 L1/L2）待精读后补注。
- 关注 AIP 国标 / A2A task 生命周期被腾讯、字节采纳的时点——采纳即打开协议层治理通道。

## 7. 来源

- SEP-2567：https://modelcontextprotocol.io/seps/2567-sessionless-mcp
- New Relic：https://newrelic.com/pt/blog/ai/mcp-is-going-stateless
- it168：https://m.it168.com/article_6944196.html
- arXiv 2606.19135：https://arxiv.org/html/2606.19135v1
- arXiv 2607.23884：https://arxiv-org.ezproxy.obspm.fr/html/2607.23884v1
- A2A v1.0 Builder's Guide：https://aaif.io/blog/a2a-v1-0-a-builder-s-guide-part-1-discovery-tasks-and-clients
- agent-governance-mcp（反例）：https://github.com/Paul-hengChen/agent-governance-mcp

## 8. 变更记录

- 2026-09-02：建档。判定 A/B/C 三条收敛；CAGE 既有决策（rails 舍弃、MCP 网关不做、纯函数内核嵌入）补协议级证据归档。
