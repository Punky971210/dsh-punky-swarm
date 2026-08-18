# 蟛蜞模式现状对比（2026-08-20）

> ⚠️ 修正（2026-08-20）：本文件部分「独有 / 领先」表述过于乐观——行业先例（工作流引擎 / 消息队列 / 分布式锁 / 质量门）早于蟛蜞数十年，蟛蜞是这些机制的单机文件版重实现。权威差异对比见 docs/comparison-2026-08-20-punky-vs-community-vs-industry.md。

> 三方对比：蟛蜞模式（dsh-punky-swarm 当前实现代码）｜梁神模式（dsh-liangshen 0.1.17）｜社区对标（dsh 生态 + Claude Code 生态）。
> 方法：六维机制对照，全部结论以当前实现代码 / 已核实仓库为准。
> 关联：归档差距核实见 docs/evaluation-2026-08-20-community-counterpart-current.md；快照见 docs/snapshot-2026-08-20-dsh-punky-swarm-current.md。

## 一、现状基线

| | 蟛蜞模式 | 梁神模式 |
|---|---|---|
| 本质 | **集群治理引擎**（治理面：一批 worker 可治理/可验收/可审计） | **推理轨迹锚定预设**（单 Agent 质量修补） |
| 载体 | dsh-punky-swarm 插件（13 治理工具）+ jiufeng 预设 | dsh-liangshen 插件（0.1.17）+ 梁神预设 |
| 核心机制 | wavePlan 固定语义三层 DAG + 引擎级门禁 + 状态机 + 锁/mailbox + 会话隔离 v2 | 首轮 2 工具锚定 → 晋升 PTC Code Mode（anchorGate/延迟注入/maxTokens 兜底） |
| 验证 | 68/68 单测全绿（Tier3 门禁/契约/返工全覆盖） | 实测 98/99（均值 98.5），第二轮零 let me |
| 社区同族 | dsh 生态 16+ 编排插件；Claude Code 生态 TaskPlane/UltraCode/metaswarm 等 | anchored-standard 家族 4+（xiaobright/Jungod1121/KDB-Wind/dbydd Pi 移植） |

## 二、六维机制对照（蟛蜞 vs 社区编排同类）

| 维度 | 蟛蜞模式（当前实现） | 社区最近对标 | 判定 |
|---|---|---|---|
| 1 任务编排 | 固定语义 DAG 分层 waves + 入口校验 + 防篡改 + **层契约**（plan/exec/audit、跨层引用、有 exec 必有 audit） | deepseek-harness-orchestrate（声明式 DAG 校验）、TaskPlane waves、agent-wave-orchestrator、dsh-captain（GPT 规划 + 异构执行） | ✅ 层契约 + 防篡改社区无；模型路由（captain 式）蟛蜞未做 |
| 2 门禁/验收 | **引擎级四道门禁**：Entry（consume 齐备）/L0（spec 必填章节）/Exit（outputs/produce 存在）/Complete（audit 全终态）；拒绝即抛错 + gate.* 事件 | metaswarm（TDD 强制，提示/技能级）、dsh-proof（每轮只读 verifier）、dsh-doublecheck、hermes（派单 spec + 质量门） | ✅ 引擎强制是差异点；评审证据（review.md/gap-list）未到 lane 级（差距①） |
| 3 通信/协调 | 文件 mailbox（原子写 + ack，inbox/outbox/broadcast）+ O_EXCL lane 锁（token 校验） | dsh-agent-relay（HMAC broker）、plugin-team-board（任务认领/流转）、hermes（git 唯一写者约定） | ✅ 文件语义简单可靠；broker 跨进程广播蟛蜞未做 |
| 4 隔离 | 会话隔离 v2（root/sessions/<id>/ + legacy 迁移）；lane 间靠锁/纪律 | TaskPlane / dsh-taskswarm（**git worktree 物理隔离**）、agent_team_gui（每成员独立模型/工具策略） | ⚠️ worktree 物理隔离未落地（差距②，win32 受限）；成员级工具面隔离蟛蜞依赖 dsh 能力面 |
| 5 恢复/审计 | 状态机 + 原子写 + recoverBatches（running/review→idle + system.recovered）；事件链只存元数据 | TaskPlane lane-state crash recovery、dsh_workflow（可生成/保存/治理/观察/恢复） | ⚠️ 同级；事件驱动 + attempt≥3 升级标记（UI 级，差距④） |
| 6 可视/工作台 | conversation.view 第三分页「蟛蜞集群」+ GateBadge/AttemptBadge + 只读 API（含 lanesGate） | affaan-m/claude-swarm（TUI 可视化）、agent_team_gui（Web 管理面板）、TaskPlane（透明化 light-factory） | ❌ 完整工作台未做（差距③，WORKBENCH.md 待实现） |

## 三、蟛蜞 vs 梁神（同为 dsh「模式」的定位差异）

| 维度 | 蟛蜞模式 | 梁神模式 | 关系 |
|---|---|---|---|
| 目标 | 多 worker 治理闭环（编排/门禁/通信/恢复） | 首轮轨迹锚定，减少 let me 式空转 | 不同层：治理面 vs 推理质量 |
| 作用对象 | 一批 subagent/worker + 批次状态 | 单个 agent 会话的 wire/工具目录 | 可叠加：梁神管会话质量，蟛蜞管批次治理 |
| 可迁移性 | 引擎 + 装配可插拔（不绑定 jiufeng）；generic 批次向后兼容 | 机制绑定 DeepSeek V4 Pro 轨迹特性；社区已有 Pi 移植 | 蟛蜞跨团队/跨任务分级，梁神跨平台移植已发生 |
| 评估 | 门禁事件 + 状态机 + 测试（68/68） | 社区评测分（98.5 vs 91-92 基线） | 蟛蜞可审计，梁神可量化 |
| 组合价值 | — | — | 同一会话可先梁神锚定（轨迹），再蟛蜞治理（批次）——无冲突 |

## 四、结论

1. **蟛蜞模式**：当前为引擎级三层门禁治理，社区（含 Claude Code 生态）无「固定语义三层 DAG + 引擎门禁 + 会话隔离 + 锁/mailbox + 分级降级」的完整对应；TaskPlane 概念最近但缺门禁语义。剩余差距按优先级：① 评审证据门禁到 lane 级 ② worktree 物理隔离 ③ 工作台完整面板 ④ attempt≥3 升引擎级。
2. **梁神模式**：概念非独家（anchored-standard 家族 4+ 同族），但工程化最全（anchorGate/延迟注入/晋升 PTC/maxTokens 兜底/plan-mode 支持）；描述抽象问题在于面向机制而非效果，建议简介改为「减少 let me 空转、推理分 98.5 vs 91」。
3. **两者互补不冲突**：梁神管单会话推理质量，蟛蜞管多 worker 治理闭环；均建立在 dsh「底层工具全 agent 可用、模式只供指引」的三层架构之上。
