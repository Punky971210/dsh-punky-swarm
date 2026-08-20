# dsh-punky-swarm — 蟛蜞模式（Punky Swarm 集群治理）

![license](https://img.shields.io/badge/license-AGPL--3.0-blue) ![node](https://img.shields.io/badge/node-%3E%3D22-green) ![CI](https://github.com/Punky971210/dsh-punky-swarm/actions/workflows/ci.yml/badge.svg)

> dsh（DeepSeek Harness）**单机多子 agent 集群治理**插件：wavePlan 三层 DAG（固定语义，建批后不重算）+ 引擎级门禁（Entry / Plan 契约 / Exit / Complete）+ 状态机 + 锁/mailbox + 会话隔离 + 任务难度路由门禁。附蟛蜞模式预设与 jiufeng-team 角色指引。

English: [README.en.md](README.en.md)

## 边界（Scope）

- **目标**：dsh **单机多子 agent 治理**——在同一 dsh 进程内治理一批 worker（批次 / 门禁 / 通信 / 恢复重置派发）；
- **范围外**：硬化、续跑、分布式集群同步、成本控制——不在考虑范围内，请勿按这些需求使用本项目。

## 设计目的与由来

**目的**：门禁（Entry/Plan 契约/Exit/Complete）与批次、锁、mailbox 等机制的核心目的，是**保障流水线与集群的稳定运行**，而非限制 Agent 自由度——工具层对 Agent 全量开放，模式层只给指引，团队装配可插拔；任务按规模分级（Leader 指派 → 单 Agent 降级）。

**由来**：本项目源于单 Agent 全流程与图式编排之间的取舍：

- 单 Agent 全流程（设计→执行→测试）：人工介入重，人成为流程瓶颈；
- 图式编排（LangGraph 方向）：尝试后放弃——流程写死成图，改动成本高，Agent 自由度被压死；
- 折中：按「九峰」工作模式（Leader 拆解 → 多角色协作 → 门禁裁决）在 JiuwenSwarm 上落地，随后迁移到 dsh 成为本插件。

**现状**：按「个人可用」标准推进。在降级的单 Agent 工作中，采用流水线规范后，可控性与稳定性有体感上的提高，具体 benchmark 待实测；集群治理在真实规模下的效果尚未系统验证，对外只做代码可自证（单测/门禁/CI）范围内的承诺。

## 三件套

| 件 | 位置 | 内容 |
|---|---|---|
| 插件 | packages/dsh-punky-swarm | 引擎：14 治理工具 + Tier3 门禁 + 会话隔离 v2 + 只读 API + 任务难度门禁 + 蟛蜞集群监控面板 |
| 模式 | packages/dsh-punky-swarm/presets/jiufeng | 蟛蜞模式预设：Leader persona + 治理纪律 + tool-bootstrap |
| 指引 | packages/dsh-punky-swarm/skills/jiufeng-team | 3 层 8 角色 × 操作手册装配表 + constitution + 模板 |

## 安装

> 以下指引面向 Agent / 自动化执行，命令可直接运行；`web` 为示例 profile，可替换。
> 插件启动时**自动同步**模式预设（→ `~/.dsh/.agent-presets/jiufeng`）与技能指引（→ `~/.agents/skills/jiufeng-team`），**无需手动放置**；已存在且内容一致则跳过，不一致则覆盖为包内版本。

```sh
git clone https://github.com/Punky971210/dsh-punky-swarm.git
cd dsh-punky-swarm
# 安装 peer 依赖（@deepseek-ai/dsh-tools、@deepseek-ai/cordis，版本由 package-lock.json 固定）
npm ci --prefix packages/dsh-punky-swarm
# POSIX
dsh plugin --profile web add link:$(pwd)/packages/dsh-punky-swarm
# Windows PowerShell
dsh plugin --profile web add link:$PWD\packages\dsh-punky-swarm
dsh web restart
```

> 安装方式即以上 **git 源码 + dsh plugin link**；本项目不另行发布 npm 包。

## 蟛蜞集群监控面板（只读）

插件自带 **蟛蜞集群** 监控面板：会话区头部「对话 / 轨迹 / 蟛蜞集群」第三分页（conversation.view），**安装即得，无需额外配置**。

- **批次列表**：阶段（planning/running/complete…）+ 终态进度 `3/5` + 可自动放行/已完结标记；
- **统计条**：总批次 / 运行中 / 已完结 / 异常（failed+conflict）；
- **批次详情**：lane 状态卡（状态 + 任务简述 + 门禁缺件明细 + 层/依赖）、事件时间线、收件箱（派发/广播）计数；
- **只读**：3s 自动刷新，跟随 Web UI 深浅主题；执行引擎（批次/门禁/状态机）**人工不可修改，只能查看**，治理操作由蟛蜞模式 Leader 执行。

## 工具清单（14）

wave_plan / batch_phase / batch_status / artifact_types / assign_check / asset_claim / gate_status / lane_claim / lane_release / member_status / member_settle / mailbox_send / mailbox_read / mailbox_ack

## wavePlan（固定语义）

- 建批时按任务依赖 DAG 分层为 waves，**批次创建后绝不中途重算**（wavePlan 固定语义）；
- 任务可声明 layer（plan/exec/audit）、consume/produce/outputs、role/skills；team 装配按 role 注入 skill 前缀（可插拔，不绑定 jiufeng）；
- 同 wave 可并行派发；批次/成员状态以状态文件为唯一事实源（事件日志可审计）。

## 任务难度门禁（Task Difficulty Gate）

- **每轮（user turn）动手执行前**，Leader 须经 assign_check 给出任务难度 A/B/C 与执行主体：A=Leader 直做 / B=单个 subagent / C=集群 wave_plan 建批；
- **default to C**：评估对象是完整目标任务（scope=full），任一 C 特征（多环节≥3 / 多角色≥2 / 需门禁 / 外部依赖 / 可恢复性）即判 C；拿不准就填 C；
- **guard 强制**：判 C 后未建批即调用执行型工具（pwsh/write/edit/run/subagent 等）会被引擎拒绝；未评估/评估过期（20 次执行调用或 30 分钟）同样拒绝，只读查询不受限；
- **asset_claim**：判 C 前 Leader 已直做的探索/排障产物，可用 asset_claim 归位为批次资产，不返工。

## 三层门禁（Tier3）

- **建批静态校验**：layer ∈ plan/exec/audit；有 exec 必有 audit；产物路径契约；跨层引用；防篡改；
- **Entry（入口门禁）**：exec 派发前 consume 产物齐备，缺则拒派（GATE_ENTRY_MISSING）；
- **Plan 契约（产物结构门禁）**：plan 产物须含 spec 必填章节（验收标准/约束）+ task-tree 合法 JSON，缺失则拒 merged（GATE_PLAN_CONTRACT）；
- **Exit（产出门禁）**：exec 结算前 outputs 落盘、audit 结算前 produce 落盘，缺则拒 merged（GATE_EXIT_MISSING_*）；
- **Complete（收尾门禁）**：批次 complete 前 audit 层验收完成且无 failed/conflict、exec 层全终态（GATE_COMPLETE_*）。

generic 批次（无 layer）不触发门禁，向后兼容。

## 状态机

```
成员：pending -> running -> review -> merged | failed | skipped | conflict（idle=恢复重派；review->running=返工）
批次：planning -> running -> paused -> aborted | complete（complete 前置三层门禁）
```

## 许可

本项目采用 [GNU AGPL v3](LICENSE)（SPDX: AGPL-3.0-only）授权。在遵守 AGPL-3.0 的前提下可自由使用、修改与分发（含商用）；若修改后通过网络提供服务，须按 AGPL-3.0 公开修改内容。
