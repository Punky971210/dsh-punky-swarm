# dsh-punky-swarm — 蟛蜞模式（Punky Mode）

![license](https://img.shields.io/badge/license-Apache--2.0-blue) ![node](https://img.shields.io/badge/node-%3E%3D22-green) ![tests](https://img.shields.io/badge/tests-68%2F68%20passing-brightgreen)

> dsh（DeepSeek Harness）**单机多子 agent 集群治理引擎**：wavePlan 三层 DAG + 引擎级门禁（Entry/L0/Exit/Complete）+ 状态机 + 锁/mailbox + 会话隔离。附蟛蜞模式预设与 jiufeng-team 角色指引（三件套）。

English: [README.en.md](README.en.md)

## 定位

- **能力面**（dsh 承担）：模型/工具/上下文/记忆/技能/MCP——让每个 worker 更强；
- **治理面**（本插件核心）：上下文卸载（task packets + 状态文件）、状态操作（状态机 + 原子写 + 锁 + 恢复）、任务指派（wavePlan + 并发池 + mailbox + 回写）、**三层门禁（plan/exec/audit 引擎级强制）**。

> ⚠️ **边界**：目标是 **dsh 单机多子 agent 治理**。硬化 / 续跑 / 集群同步 / 成本控制不在范围内（详见 docs/comparison-2026-08-20-punky-vs-community-vs-industry.md）。

## 三件套

| 件 | 位置 | 内容 |
|---|---|---|
| 插件 | packages/dsh-punky | 引擎：13 治理工具 + Tier3 门禁 + 会话隔离 v2 + 只读 API |
| 模式 | packages/dsh-punky/presets/jiufeng | 蟛蜞模式预设：Leader persona + 治理纪律 + tool-bootstrap |
| 指引 | packages/dsh-punky/skills/jiufeng-team | 3 层 8 角色 × 操作手册装配表 + constitution + 模板 |

## 安装

```sh
# 开发（本地 link）
dsh plugin --profile web add link:<repo>/packages/dsh-punky

# 模式预设（当前需手动放置，0.2.0 计划启动自动同步）
# 将 packages/dsh-punky/presets/jiufeng 拷贝到 ~/.dsh/.agent-presets/jiufeng
# 将 packages/dsh-punky/skills/jiufeng-team 拷贝到 ~/.agents/skills/jiufeng-team
```

## 工具清单（13）

wave_plan / batch_phase / batch_status / artifact_types / assign_check / gate_status / lane_claim / lane_release / member_status / member_settle / mailbox_send / mailbox_read / mailbox_ack —— 详见 [docs/USAGE.md](docs/USAGE.md)。

## 三层门禁（Tier3）

- **建批静态校验**：layer ∈ plan/exec/audit；有 exec 必有 audit；产物路径契约；跨层引用；防篡改；
- **Entry Gate**：exec 派发前 consume 齐备；
- **L0**：plan merged 前 spec 必填章节 / JSON 可解析；
- **Exit Gate**：exec→outputs、audit→produce 存在；
- **Complete Gate**：audit 全终态且无 failed/conflict，exec 全终态。

generic 批次（无 layer）不触发门禁，向后兼容。

## 状态机

```
成员：pending -> running -> review -> merged | failed | skipped | conflict（idle=恢复重派；review->running=返工）
批次：planning -> running -> paused -> aborted | complete（complete 前置三层门禁）
```

## 工作台（个人功能，开源包不含）

本地 web UI 的「蟛蜞集群」工作台分页（client.js）为个人需求，**不随 npm 包发布**（files 排除 lib/client.js）。本地 `link:` 挂载时可用。

## 验证

- 单测：68/68（node --test，Node >= 22；状态机/拓扑/锁/mailbox/门禁/契约/返工/13 工具/API）；
- 集成与端到端：2026-08-17 记录（headless 实例 LLM 治理闭环、真实 subagent 写文件批次 complete）；
- 社区对标与行业差异：docs/ 下快照、设计、评估、对比文档。

## 文档

| 文档 | 内容 |
|---|---|
| docs/USAGE.md | 安装 / 13 工具 / 三层门禁 / 会话隔离 / 治理流程 |
| docs/OPENSOURCE.md | 开源发布说明与 checklist |
| docs/open-source-review-2026-08-20.md | 开源前质量评估 |
| docs/comparison-2026-08-20-punky-vs-community-vs-industry.md | 与社区/行业差异（冷静版） |
| docs/snapshot-2026-08-20-dsh-punky-swarm-current.md | 实现快照 |

## 许可与贡献

- License: [Apache-2.0](LICENSE)；
- 贡献见 [CONTRIBUTING.md](CONTRIBUTING.md)；变更见 [CHANGELOG.md](CHANGELOG.md)。
