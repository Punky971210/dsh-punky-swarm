# dsh-punky-swarm — 蟛蜞模式（Punky Swarm 集群治理）

![license](https://img.shields.io/badge/license-Apache--2.0-blue) ![node](https://img.shields.io/badge/node-%3E%3D22-green) ![CI](https://github.com/Punky971210/dsh-punky-swarm/actions/workflows/ci.yml/badge.svg)

> dsh（DeepSeek Harness）**单机多子 agent 集群治理**插件：wavePlan 三层 DAG + 引擎级门禁（Entry/L0/Exit/Complete）+ 状态机 + 锁/mailbox + 会话隔离。附蟛蜞模式预设与 jiufeng-team 角色指引。

English: [README.en.md](README.en.md)

## 边界（Scope）

- **目标**：dsh **单机多子 agent 治理**——在同一 dsh 进程内治理一批 worker（批次 / 门禁 / 通信 / 恢复重置派发）；
- **范围外**：硬化、续跑、分布式集群同步、成本控制——不在考虑范围内，请勿按这些需求使用本项目。

## 设计目的与由来

**目的**：门禁（Entry/L0/Exit/Complete）与批次、锁、mailbox 等机制的核心目的，是**保障流水线与集群的稳定运行**，而非限制 Agent 自由度——工具层对 Agent 全量开放，模式层只给指引，团队装配可插拔；任务按规模分级（Leader 指派 → 单 Agent 降级）。

**由来**：本项目源于单 Agent 全流程与图式编排之间的取舍：

- 单 Agent 全流程（设计→执行→测试）：人工介入重，人成为流程瓶颈；
- 图式编排（LangGraph 方向）：尝试后放弃——流程写死成图，改动成本高，Agent 自由度被压死；
- 折中：按「九峰」工作模式（Leader 拆解 → 多角色协作 → 门禁裁决）在 JiuwenSwarm 上落地，随后迁移到 dsh 成为本插件。

**现状**：按「个人可用」标准推进。在降级的单 Agent 工作中，采用流水线规范后，可控性与稳定性有体感上的提高，具体 benchmark 待实测；集群治理在真实规模下的效果尚未系统验证，对外只做代码可自证（单测/门禁/CI）范围内的承诺。

## 三件套

| 件 | 位置 | 内容 |
|---|---|---|
| 插件 | packages/dsh-punky-swarm | 引擎：13 治理工具 + Tier3 门禁 + 会话隔离 v2 + 只读 API + 蟛蜞集群监控面板 |
| 模式 | packages/dsh-punky-swarm/presets/jiufeng | 蟛蜞模式预设：Leader persona + 治理纪律 + tool-bootstrap |
| 指引 | packages/dsh-punky-swarm/skills/jiufeng-team | 3 层 8 角色 × 操作手册装配表 + constitution + 模板 |

## 安装

> 以下指引面向 Agent / 自动化执行，命令可直接运行；`web` 为示例 profile，可替换。
> 插件启动时**自动同步**模式预设（→ `~/.dsh/.agent-presets/jiufeng`）与技能指引（→ `~/.agents/skills/jiufeng-team`），**无需手动放置**；已存在且内容一致则跳过，不一致则覆盖为包内版本。

### 1. 获取插件（GitHub）

```sh
git clone https://github.com/Punky971210/dsh-punky-swarm.git
cd dsh-punky-swarm
```

### 2. 初始化插件依赖（安装 peer 依赖）

```sh
cd packages/dsh-punky-swarm
npm ci
```

> 插件以 `link:` 方式挂载后，Node 会从插件目录向上解析依赖；仓库已提交 `package-lock.json`，`npm ci` 一条命令装齐 `@deepseek-ai/dsh-tools`、`@deepseek-ai/cordis`，无需手动建链接。

### 3. 挂载插件

```sh
# POSIX
dsh plugin --profile web add link:$(pwd)/packages/dsh-punky-swarm
# Windows PowerShell
dsh plugin --profile web add link:$PWD\packages\dsh-punky-swarm
```

### 4. 重启 dsh web（首次启动完成预设/技能同步）

```sh
dsh web restart
```

### 5. 验证

1. 新建会话，预设选择器出现「蟛蜞模式」；
2. 工具面含 13 个治理工具：wave_plan / batch_phase / batch_status / artifact_types / assign_check / gate_status / lane_claim / lane_release / member_status / member_settle / mailbox_send / mailbox_read / mailbox_ack；
3. 预设与技能就位：`ls ~/.dsh/.agent-presets/jiufeng/preset.yml` 与 `ls ~/.agents/skills/jiufeng-team/SKILL.md`。
4. 会话右上角出现「蟛蜞集群」分页（对话/轨迹/蟛蜞集群第三页），点开可实时查看批次监控（只读）；

> 安装方式即以上 **git 源码 + dsh plugin link**；本项目不另行发布 npm 包。

## 蟛蜞集群监控面板（只读）

插件自带 **蟛蜞集群** 监控面板：会话区头部「对话 / 轨迹 / 蟛蜞集群」第三分页（conversation.view），**安装即得，无需额外配置**。

- **批次列表**：阶段（planning/running/complete…）+ 终态进度 `3/5` + 可自动放行/已完结标记；
- **统计条**：总批次 / 运行中 / 已完结 / 异常（failed+conflict）；
- **批次详情**：lane 状态卡（状态 + 任务简述 + 门禁缺件明细 + 层/依赖）、事件时间线、收件箱（派发/广播）计数；
- **只读**：3s 自动刷新，跟随 Web UI 深浅主题；执行引擎（批次/门禁/状态机）**人工不可修改，只能查看**，治理操作由蟛蜞模式 Leader 执行。

## 工具清单（13）

wave_plan / batch_phase / batch_status / artifact_types / assign_check / gate_status / lane_claim / lane_release / member_status / member_settle / mailbox_send / mailbox_read / mailbox_ack

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

## 许可

Apache-2.0，见 [LICENSE](LICENSE)。
