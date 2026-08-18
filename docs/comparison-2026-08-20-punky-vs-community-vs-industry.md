# 蟛蜞模式 vs 社区集群治理 vs 行业落地（冷静差异对比）

> 2026-08-20 · 目的：修正此前对比中「独有 / 领先」的乐观措辞，改为以差距为中心。

## 〇、目标边界（2026-08-20 确认）

蟛蜞模式的目标 = **单机多子 agent 治理**：在同一 dsh 进程内治理一批 worker（批次 / 门禁 / 通信 / 恢复重置派发）。**硬化、续跑、集群同步、成本控制不在考虑范围内**——本文差距清单按此边界分级；「行业有而蟛蜞没有」的条目仅作记录，不视为范围内差距。
> 三方口径：蟛蜞模式（dsh-punky-swarm 当前代码，13 工具 / 三层门禁 / 会话隔离 v2 / 68 测试）｜社区（dsh 生态 + Claude Code 生态 GitHub 项目）｜行业（生产级框架 / 平台 / 工程流程）。
> 关联：实现快照 docs/snapshot-2026-08-20-dsh-punky-swarm-current.md；此前乐观版 docs/comparison-2026-08-20-punky-liangshen-community.md（已加修正声明）。

## 一、一句话结论

**蟛蜞模式的机制不是新技术**：它是「工作流引擎 + 状态机 + 消息队列 + 分布式锁 + 质量门」这些行业存在 30 年以上的概念，用 JSON 文件在 dsh 单机上重新实现了一遍。它在**社区 GitHub 项目**里完整度少见，但**与行业生产系统比，每一层都是降级版**。

## 二、机制同源表（行业先例 → 蟛蜞文件版）

| 蟛蜞机制 | 行业先例 | 蟛蜞实现形态 | 真实差距 |
|---|---|---|---|
| wavePlan 固定语义 DAG + 防篡改 | 工作流引擎：Temporal / Argo / AWS Step Functions（DAG 定义 + 版本化） | JSON 文件 + 入口校验 + 防篡改 | 无版本化 / 无 DSL / 无可视化编辑；工作流定义与执行代码同文件，无法独立演进 |
| 事件日志 + 状态快照 | 事件溯源（event sourcing）+ 数据库 | 事件只存元数据（不存正文）+ 全量 JSON 快照 | **不可重放 / 不可投影**：事件只是审计痕迹，不是真相来源的补全 |
| 恢复语义（recoverBatches） | 持久执行（durable execution）：Temporal 确定性重放；LangGraph checkpoint | running/review → idle 重置 | **恢复 = 重置到待派发，不是续跑**：worker 上下文、中间产物、对话进度全部丢弃，只保留批次骨架 |
| Entry / L0 / Exit / Complete 门禁 | CI 质量门（SonarQube 等）、PR 强制评审（four-eyes）、发布审批（Azure DevOps / GitHub environment protection） | 文件存在性 + L0 关键词检查（「## 验收标准」「## 约束」） | **门禁是「存在性」，不是「语义质量」**：文件有内容即过；行业门禁做静态分析 / 测试覆盖 / 人工审批流 |
| lane_claim O_EXCL 单写者锁 | 分布式锁：etcd / Redis（lease + 心跳 + 自动续约） | O_EXCL 文件 + token 校验 | **单机语义、无租约**：进程崩溃后锁泄漏，只能靠 force 接管；无心跳 / 自动过期 |
| mailbox 原子写 + ack | 消息队列：Kafka / SQS（at-least-once、重试、死信、TTL、持久化） | 文件队列 + ackId | 无 TTL / 无死信 / 无重试策略 / 无独立存储；ack 机制有但队列本身是目录列举 |
| 会话隔离 v2 | 多租户 namespace（Temporal namespace、K8s namespace） | sessions/<id> 目录 + 命名白名单 | 无配额 / 无权限模型 / 无跨进程并发控制（同 session 双进程会互相覆盖 JSON） |
| 装配注入（role→skills 前缀） | 社区级：hermes 派单 spec、jiufeng-team | assembly.js 可插拔 | 行业框架用 prompt 模板 / 路由，无直接对应；此点蟛蜞与社区同级 |

参考：Temporal 架构（[github.com/temporalio/temporal](https://github.com/temporalio/temporal/blob/v1.30.0-144.4/docs/architecture/README.md)）；对 LangGraph/CrewAI/ADK checkpoint 的行业批判（[diagrid.io：Why Checkpoints Aren't Durable Execution](https://www.diagrid.io/blog/checkpoints-are-not-durable-execution-why-langgraph-crewai-google-adk-and-others-fall-short-for-production-agent-workflows)）；编排模式综述（[Zylos：DAG / Event-Driven / Actor](https://zylos.ai/research/2026-04-14-agent-workflow-orchestration-patterns/)）；发布审批（[Microsoft Learn](https://learn.microsoft.com/en-nz/training/modules/explore-release-strategy-recommendations/3-explore-release-approvals)）。

## 三、vs 社区（GitHub 项目级）：真实差异

### 蟛蜞相对社区强的地方（谨慎表述）
- **门禁进引擎**：Entry/L0/Exit/Complete 是引擎拒绝（抛错 + gate.* 事件），社区多为提示 / 技能级（dsh-proof 每轮 verifier、metaswarm 提示级质量门）；
- **可审计**：事件链 + 只读 API + 工作台分页；
- **装配可插拔**：不绑定 jiufeng；
- **分级降级**：assign_check A/B/C（Leader 直做 / 轻量 subagent / 批次）；
- **会话隔离**：dsh 生态多数插件无此概念。

### 社区相对蟛蜞强的地方
- **物理隔离**：TaskPlane / dsh-taskswarm 的 git worktree lane（蟛蜞靠锁 + 纪律）；
- **跨模型路由**：dsh-captain（GPT 规划 / DeepSeek 执行 / GPT 评审）、dsh-longtask-orchestrator；
- **跨进程通信**：dsh-agent-relay（HMAC broker）；
- **可视化成熟度**：affaan-m/claude-swarm TUI、agent_team_gui Web 面板。

## 四、vs 行业（生产级）：行业有、蟛蜞没有的

> 边界注：下表多数能力（分布式 / 租约锁 / 确定性重放 / 云托管等）属于**硬化 / 集群 / 续跑范畴，按目标边界不在蟛蜞考虑范围内**；保留仅为记录行业标杆存在这些能力，不构成蟛蜞的差距项。

1. **分布式执行**：多节点 worker、水平扩展（Temporal / Step Functions）；
2. **租约锁 + 心跳**：崩溃自动释放，无需 force；
3. **持久化消息**：Kafka/SQS 级别的 TTL / 死信 / 重试 / 独立存储；
4. **确定性重放**：恢复后从 checkpoint 续跑，而不是重置派发；
5. **可观测性**：OTel 追踪 / 指标 / 审计平台（蟛蜞只有事件日志）；
6. **版本化工作流**：定义演进与存量执行并存；
7. **门禁的语义质量**：静态分析 / 测试覆盖 / 人工审批链，而非文件存在性；
8. **多语言 SDK / 云托管 / 租户配额**。

行业侧的共识性教训（多 Agent 生产失败常在编排而非模型）：两个 Agent 协作会互相捣乱（[阿里云：多 Agent 协作现实](https://developer.aliyun.com/article/1744508)）；生产失败的主因是缺持久执行与治理（[vertesiahq：Why Production AI Fails](https://vertesiahq.com/blog/why-production-ai-fails)）。蟛蜞的门禁方向是对的，但强度远低于行业。

## 五、结论（按目标边界分级）

1. **定位（已确认）**：蟛蜞模式的目标 = **单机多子 agent 治理**。行业标杆的硬化 / 续跑 / 集群同步 / 成本控制功能不在考虑范围内，不再作为差距项要求。
2. **真实价值（边界内成立）**：dsh 单机场景下零依赖、文件可读可审计、引擎级门禁、会话隔离、装配可插拔。
3. **范围内差距（按优先级；节点健壮性为当前首要）**：
   - **P0 节点健壮性**（用户确认待提升）：worker 失败 / 超时的重试策略（次数 / 退避）；孤儿 subagent 清理；损坏批次文件隔离（readBatch 容错，不因单个 JSON 损坏拖垮恢复）；mailbox 滞留消息清理（age 字段 / dead-letter 目录）；
   - **P1 治理加固**：锁龄过期模拟租约（单机崩溃锁泄漏，低成本）；事件里补接续元数据（人工沿事件链接手时够用）；
   - **候选（待定）**：门禁语义升级（存在性 → 第二模型过审）——若视为「硬化」则按边界排除。
4. **范围外（不再要求）**：确定性重放 / 续跑（LangGraph checkpoint 方案撤销）、集群同步、分布式锁租约 / 心跳、成本控制、水平扩展、云托管 / 多语言 SDK。
