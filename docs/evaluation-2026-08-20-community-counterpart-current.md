# 社区对标重评（按 2026-08-20 实现代码）

> 2026-08-20 · 前置：docs/design-2026-08-19-community-borrowing-gate-hardening.md（16 个同类插件五派盘点）；本文按当前 dsh-punky-swarm 实现代码（13 工具 + 三层门禁 + 会话隔离 v2）更新结论。
> 外部参考：TaskPlane（HenryLach/taskplane）、UltraCode dynamic workflows、metaswarm（dsifry/metaswarm）、dsh-taskswarm、deepseek-harness-orchestrate、dsh_workflow、dsh-proof、dsh-auto-review、agent-wave-orchestrator 等。

## 一、结论

蟛蜞模式已从「编排工具」（覆盖 1–3 项能力）升级为**引擎级三层门禁治理**：社区同类中，TaskPlane 概念最接近（waves/lanes/任务包/崩溃恢复），但无引擎门禁语义；metaswarm 有质量门但属提示/技能级。**「固定语义三层 DAG + 引擎门禁 + 会话隔离 + 锁/mailbox + 分级降级」的组合，社区无完整对应**。

## 二、机制对照（当前实现 vs 社区）

| 蟛蜞机制 | 当前实现（2026-08-20） | 社区最近对标 | 判定 |
|---|---|---|---|
| wavePlan DAG 分层 | 固定语义 + 入口校验 + 防篡改 + **层契约** | deepseek-harness-orchestrate（声明式 DAG 校验）、TaskPlane waves、agent-wave-orchestrator | ✅ 领先（层契约 + 防篡改社区没有） |
| 引擎级门禁 | entry/L0/exit/complete 四道，拒绝即抛错+事件 | metaswarm（TDD 强制，提示级）、dsh-proof（每轮只读 verifier，流程级）、dsh-doublecheck | ✅ 引擎强制是差异点 |
| 会话隔离 + 恢复 | sessions/<id> + legacy 迁移 + system.recovered | TaskPlane lane-state crash recovery、dsh-taskswarm | ⚠️ 同级；会话维度绑定 dsh 会话模型是差异点 |
| lane 单写者 | O_EXCL + token 校验 + wait/force | hermes 唯一写者约定（git 级）、TaskPlane worktree lane（物理隔离） | ⚠️ 锁语义更细，但无物理隔离（借鉴点 1 未落地） |
| 任务通信 | 文件 mailbox 原子写 + ack | dsh-agent-relay（HMAC broker）、plugin-team-board（认领/流转） | ✅ 文件语义简单可靠 |
| 角色装配 | assembly.js 可插拔，role→skills 前缀注入 | Cavan-Ou/hermes（派单 spec + 质量门）、jiufeng-team | ✅ 通用不绑定团队 |
| 分级降级 | assign_check A/B/C（直做/轻量 subagent/批次） | 社区无直接对应 | ✅ 独有 |
| 产物治理 | artifact_types 注册表 + 路径契约 | TaskPlane 任务包（无类型注册表） | ✅ 独有 |
| 返工/升级 | review→running 返工 + attempt≥3 UI 升级标记 | 社区无 | ⚠️ 目前 UI 级，建议升引擎级 |
| 工作台 | conversation.view 第三分页 + GateBadge，完整面板未做 | affaan-m/claude-swarm TUI、agent_team_gui Web 面板 | ❌ 差距（WORKBENCH.md 待实现） |
| 自动第二模型评审 | 不在设计内（P2 显式人审） | dsh-auto-review（审批链 fail-closed）、dsh-proof | ➖ 设计边界差异，不追 |

## 三、2026-08-19 归档差距的现状核实

| 归档项 | 2026-08-19 状态 | 2026-08-20 现状 |
|---|---|---|
| 借鉴点 2 声明式 DAG 校验 | 已内置（topoWaves 环/未知 dep/防篡改） | ✅ 维持，并扩展层契约（跨层引用/路径/有 exec 必有 audit） |
| 三层 DAG 强化（§5 草案） | 待确认 | ✅ 实装：建批层契约 + entry/exit/complete 门禁 |
| 方案 A 评审证据门禁 | 主推待确认 | ⚠️ **部分落地**：audit 层结构与 complete gate 强制 audit merged；但 exec lane merged 只查 outputs 存在，**不强制评审证据**（review.md/gap-list.json），Leader 仍可无评审产物直接 merge exec |
| 借鉴点 1 worktree lane | 待评估（win32） | ➖ 未落地，保持待评估 |

## 四、剩余差距（按优先级）

1. **评审证据门禁细则**（方案 A 收尾）：exec lane merged 前校验 audit 层评审证据（audit/review.md 或 gap-list.json 落盘），或 wavePlan 强制每个 exec lane 被 audit lane consume 覆盖——否则「评审不可跳过」只到批次级，未到 lane 级。
2. **worktree lane 物理隔离**：真工作区隔离，仅 git 仓库任务适用，受 win32 bash 限制——待集群/CI 场景。
3. **工作台完整实现**（WORKBENCH.md）：API 雏形（lanesGate）已有，缺完整面板。
4. **attempt≥3 升级标记升引擎级**：目前由事件推导 + UI 展示，未进状态机语义。
