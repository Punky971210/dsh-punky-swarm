# dsh-punky-swarm — 蟛蜞模式（Punky Swarm 集群治理）

![license](https://img.shields.io/badge/license-AGPL--3.0-blue) ![node](https://img.shields.io/badge/node-%3E%3D22-green) ![CI](https://github.com/Punky971210/dsh-punky-swarm/actions/workflows/ci.yml/badge.svg)

> dsh（DeepSeek Harness）**单机多子 agent 集群治理**插件：wavePlan 三层 DAG（固定语义，建批后不重算）+ 引擎级门禁（Entry / Plan 契约 / Exit / Complete）+ 状态机 + 锁/mailbox + 会话隔离 + 任务难度路由门禁 + 国标 AIP 兼容 + 治理能力增强（心跳/watchdog、worktree 物理隔离、验收证据、mailbox 环防护、诊断桥接、日志导出）。附蟛蜞模式预设与 jiufeng-team 角色指引。

English: [README.en.md](README.en.md)

## 边界（Scope）

- **目标**：dsh **单机多子 agent 治理**——在同一 dsh 进程内治理一批 worker（批次 / 门禁 / 通信 / 恢复重置派发）；
- **范围外**：分布式集群同步、成本控制、模型分层路由；续跑仅提供 checkpoint 保全与恢复审计（失败 lane 仍终态、重做仍开新批次）。

## 设计目的与由来

**目的**：门禁（Entry/Plan 契约/Exit/Complete）与批次、锁、mailbox 等机制的核心目的，是**保障流水线与集群的稳定运行**，而非限制 Agent 自由度——工具层对 Agent 全量开放，模式层只给指引，团队装配可插拔；任务按规模分级（Leader 指派 → 单 Agent 降级）。

**由来**：本项目源于单 Agent 全流程与图式编排之间的取舍：

- 单 Agent 全流程（设计→执行→测试）：人工介入重，人成为流程瓶颈；
- 图式编排（LangGraph 方向）：尝试后放弃——流程写死成图，改动成本高，Agent 自由度被压死；
- 折中：按「九峰」工作模式（Leader 拆解 → 多角色协作 → 门禁裁决）在早期 Swarm 集群运行时上落地，随后迁移到 dsh 成为本插件。

## 三件套

| 件 | 位置 | 内容 |
|---|---|---|
| 插件 | packages/dsh-punky-swarm | 引擎：**20 治理工具** + Tier3 门禁 + 会话隔离 v2 + 只读 API（含 AIP /tools·/agents·/discover 端点）+ 任务难度门禁 + 蟛蜞集群监控面板 |
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

> 也可通过 npm 安装：`npm install -g dsh-punky-swarm`（版本见 [package.json](packages/dsh-punky-swarm/package.json)）；git 源码 + dsh plugin link 为开发/调试方式。

### npm 安装

```sh
npm install -g dsh-punky-swarm
dsh plugin --profile web add dsh-punky-swarm
dsh web restart
```

> npm 包的 `dsh plugin add` 用法以发布后实际验证为准（0.3.1 起）。

## 蟛蜞集群监控面板（只读）

插件自带 **蟛蜞集群** 监控面板：会话区头部「对话 / 轨迹 / 蟛蜞集群」第三分页（conversation.view），**安装即得，无需额外配置**。

- **批次列表**：阶段（planning/running/complete…）+ 终态进度 `3/5` + 可自动放行/已完结标记；
- **统计条**：总批次 / 运行中 / 已完结 / 异常（failed+conflict）；
- **批次详情**：lane 状态卡（状态 + 任务简述 + 门禁缺件明细 + 层/依赖）、事件时间线、收件箱（派发/广播）计数；
- **只读**：3s 自动刷新，跟随 Web UI 深浅主题；执行引擎（批次/门禁/状态机）**人工不可修改，只能查看**，治理操作由蟛蜞模式 Leader 执行。

## 治理工具（20）

按功能分类：

### 批次规划
| 工具 | 说明 |
|---|---|
| `wave_plan` | 按依赖 DAG 分层为 waves 建批（固定语义，建批后不重算） |
| `batch_phase` | 批次阶段迁移（planning→running→paused→aborted/complete） |
| `batch_status` | 查询批次状态（phase/lanes/wavePlan/事件摘要） |

### 任务分级与门禁
| 工具 | 说明 |
|---|---|
| `assign_check` | 任务难度判定 A/B/C 与执行主体（guard 门禁依据） |
| `gate_status` | 查询 lane 门禁状态（consume/produce/outputs 缺件清单） |
| `artifact_types` | 查询产物类型注册表（层/目录前缀约定） |

### 资产与锁
| 工具 | 说明 |
|---|---|
| `asset_claim` | 已直做产物归位为批次资产（复制入引擎产物根） |
| `lane_claim` | 以 O_EXCL 单写者锁认领 lane（冲突先拒） |
| `lane_release` | 释放 lane 锁 |

### 成员状态
| 工具 | 说明 |
|---|---|
| `member_status` | 成员状态操作（pending/running/review/idle） |
| `member_settle` | 成员结算（merged/failed/skipped/conflict，含门禁校验） |

### 通信（mailbox）
| 工具 | 说明 |
|---|---|
| `mailbox_send` | 发送消息（inbox/outbox/broadcast，原子写 + ackId） |
| `mailbox_read` | 读取未确认消息 |
| `mailbox_ack` | 确认消费消息 |

### 心跳与过期检测
| 工具 | 说明 |
|---|---|
| `lane_heartbeat` | lane 心跳查询/触发（watchdog 扫描，stalled 标记） |

### worktree 物理隔离
| 工具 | 说明 |
|---|---|
| `lane_worktree_create` | 为 lane 建独立 git worktree（从 orch HEAD 基线） |
| `lane_worktree_merge` | 合并 lane 分支进 orch（冲突保留现场 + 清单） |
| `lane_checkpoint` | lane 内 checkpoint 提交（git add+commit，保产物） |
| `lane_checkpoint_status` | 查询 checkpoint 历史与进度（续跑契约入口） |

### 日志
| 工具 | 说明 |
|---|---|
| `log_export` | 只读事件流导出（lane/type/since 过滤 + json/markdown + 引擎产物根落盘） |

> 装配开关（cordis.patch.yml）：aip / discovery / verify / watch / worktree / budget / trajectory / logs 默认开启，可显式 `enabled: false` 逐键关闭；identity 默认关闭（`aip.identity.enabled: true` 显式开启）；mergeAgent 默认关闭（需宿主注入 spawner）。

## 国标 AIP 兼容

兼容《人工智能 智能体互联》国标（GB/Z 185-2026）智能体互联结构，仅增不改、可插拔（字段名以参考实现 ACPs-community v2.1.0 原文为准）：

- **工具 6 属性（GB/Z 185.7-2026 第 7 部分：智能体工具调用）**：每工具提供 toolId / name / description / version / inputParam / outputParam（toolId = `dsh.punky-swarm.<name>` 反向域唯一；inputParam/outputParam 为 JSON Schema，required 恒在）；
- **智能体描述（GB/Z 185.4-2026 第 4 部分：智能体描述；ACS 字段集）**：装配配置 → 每角色 ACS AgentCapabilitySpec 描述（根对象 20 键 = 必填 14：aic / active / lastModifiedTime / protocolVersion / name / description / version / provider / securitySchemes / endPoints / capabilities / defaultInputModes / defaultOutputModes / skills，可选 6：iconUrl / documentationUrl / webAppUrl / entityUserId / entityMeta / certificate；AgentSkill 8 键 = 必填 5：id / name / description / version / tags，可选 3：examples / inputModes / outputModes；协议 02.01）；
- **消息/任务/会话映射（GB/Z 185.6-2026 第 6 部分）**：mailbox 消息、wavePlan 任务、批次状态 → ACPs AIP 结构（Message：id / sentAt / senderRole / senderId / dataItems / mentions；TaskCommand；Session——纯映射只读不改存储，ackId 原子写保留）；`/mailbox` items 与 `/batch` 附 ACPs 投影（缺省不注入时响应不变）；
- **身份体系（GB/Z 185.2/185.3-2026 第 2/3 部分，默认关）**：AIC 身份码（前缀 1.2.156.3088 + 10 级编码 + CRC-16/CCITT-FALSE + Base36 校验码）+ CAI 身份证书（CN=AIC、SAN=acps://、EAB 凭证）+ 可插拔签名（默认 ECDSA-P256 / 可选 RSA-2048）+ 信任链验证；SM2 暂不支持（`algorithm='sm2'` 显式拒绝）；装配键 `aip.identity` 默认关（经模块 API 暴露，不注册新治理工具）；
- **发现服务（GB/Z 185.5-2026 第 5 部分：智能体发现/ADP，默认开）**：`POST /api/dsh-punky-swarm/discover`（type 四类 explicit/exploratory/trending/filtered、filter 34 运算符、错误码 40000~40005/50001）+ `GET /.well-known/aip`（协议 ACPs 02.01）；active 语义替代 discoverable（节点 active=false 不出现于查询结果）；
- **装配开关**：`aip.enabled`（缺省默认开启，显式 `false` 关闭）→ 生成工具 6 属性目录 + `GET /api/dsh-punky-swarm/tools`（可 `?name=` 过滤）+ ACS 智能体目录 + `GET /api/dsh-punky-swarm/agents`。

## 治理能力

| 能力 | 装配键 | 机制 |
|---|---|---|
| 心跳/过期检测 | `capabilities.watch` | watchdog 定时器 + lane_heartbeat 工具；退避档位追问 + 连续 N 拍无活动 → lane.stalled 标记 |
| worktree 物理隔离 | `capabilities.worktree` | lane_worktree_create/merge/checkpoint（git worktree 隔离 + checkpoint 提交）；与 lane_claim 逻辑锁互补 |
| 验收证据 | `capabilities.verify` | post-execute 证据捕获（内容寻址 blob + ledger）+ 三态裁决（done/failed/blocked）+ 完成门禁（advisory/enforce） |
| mailbox 环防护 | `capabilities.budget` | 链跳数上限 / 同有序对往返上限 / 重复消息拒发；inbox 豁免 |
| 诊断桥接 | `capabilities.trajectory` | 异常诊断（死锁/无效重试/目标漂移）→ sessionId→lane 映射 → notify（autoFail 默认关） |
| 日志导出 | `capabilities.logs` | log_export 工具：只读事件流投影，lane/type/since 过滤 + json/markdown + 引擎产物根落盘（防逃逸） |
| topic 订阅 | —（纯模块） | subscribeTopic/emitTopic：进程内分发 + mailbox broadcast 落盘（ackId 原子写） |
| merge agent | `worktree.mergeAgent`（默认关） | 冲突语义化解（需宿主注入 spawner；未注入 spawner 时保持 conflict 状态） |

## 生命周期

- **lane 条件**：建批静态声明（依赖产物/文件存在），派发前校验，不满足落 skipped；
- **archive 自动归档**：complete 后自动单向归档（产物打包保留可查，不可回滚）；
- **needHuman 人工挂起**：audit 产物声明 needHuman → lane 挂 review，Manager 转达人工裁决（merged/conflict），不新增成员态；
- **棘轮规则表**：状态迁移配置化（只许删不许增，allowRelax 逃生门默认关）；
- **恢复机制**：checkpoint 保全 + 恢复审计 + 崩溃后 idle 归位重派（新 worker 可查 checkpoint 跳过已完成步骤）；断点续跑接口预留。

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
- **Complete（收尾门禁）**：批次 complete 前 audit 层验收完成且无 failed/conflict、exec 层全终态（GATE_COMPLETE_*）；
- **硬化（dp1-dp4）= 上述门禁引擎化**（映射见 skills/jiufeng-team/references/workflow.md §四）：dp1 分配判定 → Entry + assign_check；dp2 完成确认 → Exit；dp3 审查路由 → review + member_settle；dp4 验收判定 → Complete——属已实现能力，从「范围外」移除。

generic 批次（无 layer）不触发门禁，向后兼容。

## 状态机

```
成员：pending -> running -> review -> merged | failed | skipped | conflict（idle=恢复重派；review->running=返工）
批次：planning -> running -> paused -> aborted | complete（complete 前置三层门禁）
```

## 许可与商业授权

本项目以 **GNU AGPL v3（AGPL-3.0）为唯一许可**：

- 在遵守 [AGPL-3.0](LICENSE) 的前提下，可自由使用、修改、分发（含商用）；若修改后通过网络提供服务，须按 AGPL-3.0 公开修改内容。
- 如需其他许可（如闭源商用），请联系作者获得许可。
