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
| 插件 | packages/dsh-punky-swarm | 引擎：**20 治理工具** + Tier3 门禁 + 会话隔离 v2 + 只读 API（含 AIP /tools 端点）+ 任务难度门禁 + 蟛蜞集群监控面板 |
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

> 装配开关（cordis.patch.yml）：aip / discovery / verify / watch / worktree / budget / trajectory / logs 默认开启，可显式 `enabled: false` 逐键关闭；mergeAgent 默认关闭（需宿主注入 spawner）。默认关能力：`aip.identity`（身份体系）与 `acps`（ACPs 通讯，见下章）。

## 国标 AIP 兼容

兼容《人工智能 智能体互联》国标（GB/Z 185-2026）工具/智能体描述结构，仅增不改、可插拔：

- **工具 6 属性**：每工具提供 toolId / name / description / version / inputParam / outputParam（toolId = `dsh.punky-swarm.<name>` 反向域唯一；inputParam/outputParam 为 JSON Schema，required 恒在）；
- **智能体描述（P4，ACS 字段集）**：装配配置 → 每角色 ACS AgentCapabilitySpec 描述（根对象 20 键 = 必填 14：aic / active / lastModifiedTime / protocolVersion / name / description / version / provider / securitySchemes / endPoints / capabilities / defaultInputModes / defaultOutputModes / skills，可选 6：iconUrl / documentationUrl / webAppUrl / entityUserId / entityMeta / certificate；AgentSkill 8 键 = 必填 5：id / name / description / version / tags，可选 3：examples / inputModes / outputModes；协议 02.01）；旧「14+8 属性」（agentId/accessAddress/…）为二手解读，降级为 toLegacyDescriptor 兼容映射层（仅审计对比，不参与对外契约）；
- **消息/任务/会话映射**：mailbox 消息、wavePlan 任务、批次状态 → 国标结构（纯映射只读不改存储，ackId 原子写保留）；
- **身份体系**（默认关，`aip.identity.enabled=true` 激活）：AIC 身份码（OID 前缀 `1.2.156.3088` + CRC-16/CCITT-FALSE + Base36 校验码）+ CAI 身份证书 + 可插拔签名（默认 ECDSA-P256 / RSA-2048）+ 信任链验证；SM2 暂不支持（签名接口可插拔，默认 ECDSA-P256 / RSA-2048，`algorithm='sm2'` 显式拒绝）；
- **装配开关**：`aip.enabled`（默认开启）→ 生成工具 6 属性目录 + `GET /api/dsh-punky-swarm/tools`（可 `?name=` 过滤）。

## ACPs 通讯方式（默认关）

ACPs（Agent Communication Protocol Standard）通讯能力：对外 mTLS 服务端点 + 内部 mailbox↔ACPs 桥接 + registry 半自动注册与外部 ADP 发现对接。**全部默认关**（安全默认）——`acps.enabled` 与 `acps.endpoint.enabled` 均默认 `false`，显式开启才加载监听/客户端，关闭时零运行时路径（无监听、无定时器、无网络）。

### 能力总览

| 能力 | 装配键 | 默认 | 用途 |
|---|---|---|---|
| 对外 mTLS 端点 | `acps.enabled` + `acps.endpoint.enabled` | 关 | 对外提供 AIP JSON-RPC / ACS / 健康检查（TLSv1.3 + 双向证书） |
| 内部桥接 | `acps.bridge` | 关（inbound 再子门控关） | mailbox ↔ ACPs 消息进程内双向投影/投递 |
| registry 注册 | `acps.registry` | 关 | 半自动注册客户端（需 registry.url + 用户凭据） |
| discovery 发现 | `acps.discovery` | 关 | 外部 ADP 发现客户端（POST /discover） |

### 对外 mTLS 服务端点

独立 HTTPS 监听器（node:https + node:tls 原生，零新依赖），默认端口 `9443`（`acps.endpoint.port` 可配）、host 默认 `127.0.0.1`；TLSv1.3（`minVersion` 默认，可配 TLSv1.2）+ 双向证书（`requestCert` + `rejectUnauthorized` = CERT_REQUIRED）；`devInsecure` 仅显式开发开关（默认 `false`，生产不允许降级）。装配条件：`acps.enabled` 与 `acps.endpoint.enabled` **双真**；证书缺失/不可用 → 启动告警并保持禁用，不阻塞主进程。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/acps/rpc` | POST | AIP JSON-RPC（jsonrpc 2.0，method=`rpc`，params.command=TaskCommand → TaskResult accepted/rejected）；客户端证书 CN 须为合法 AIC（否则 400） |
| `/.well-known/acs.json` | GET | ACS 直取（14 必填键 + securitySchemes.mutualTLS + endPoints JSONRPC） |
| `/health` | GET | 健康检查（agent/status/tasks/groups） |

证书：CA 自签（node:crypto 原生 X.509 + ECDSA P-256），实体证书 CN=AIC、SAN=URI:acps://{AIC}，默认生成于 `<root>/acps/certs`（ca.pem/ca.key/server.pem/server.key）；`cert/key/ca` 三路径可配置覆盖。

### 内部桥接

`acps.bridge`（进程内双向，默认关；mode=`inprocess`）：
- **inbound**（默认关，`acps.bridge.inbound=true` 显式开启）：外部 ACPs TaskCommand → mailbox 消息，**经 lib/comms/mailbox.js 公共接口原子写 inbox（ackId 由 mailbox 生成，绝不绕过、无旁路写）**；写入目标仅 inbox（按 mentions/groupId 推导 lane 进 meta），outbox 不可外部直接写，broadcast 外部投递不支持；
- **outbound**：mailbox 消息 → ACPs Message/TaskResult（复用 aip-format 三映射），只投影/投递视图，不反写 mailbox 存储；
- **/rpc→bridge 接线**：`POST /acps/rpc` 收到的 TaskCommand 经 `handleInbound` 落 mailbox；`bridge.inbound=false` 时协议级 `rejected`（INBOUND_DISABLED，HTTP 200 返回——传输成功、协议层拒绝）；bridge 未装配时回 P1 独立 accepted（向后兼容）；
- **mailbox 红线保留**：ackId 原子写、三 box（inbox/outbox/broadcast）、lane 隔离语义逐字保留；
- **零路径**：`enabled=false` 时不加载不实例化（mountBridge 返回 null）。

### registry / discovery 对接（默认关）

- **registry**（`acps.registry`，半自动注册客户端）：需 `registry.url` + 用户凭据（username/password 或 token，config/env 注入，不硬编码不落仓库）；流程 login → upsertAgent → submitAgent（**人工审批，不自动化跳过**）→ requestEab → queryAcs；EAB macKey **AES-256-GCM 加密存证**（`eabKey` 未配置时仅返回明文凭据由调用方自存）；
- **discovery**（`acps.discovery`，ADP 客户端）：POST `{baseUrl}/discover` 查询外部 Agent（type 四类 / 34 运算符，与本地 discovery 共享协议常量）；`scope` = local（仅本地既有目录）/ external（仅外部）/ both（本地+外部合并，acsMap 外部优先）；timeout 默认 10s、limit 默认 5。

### 配置示例

```yaml
# ACPs 通讯能力（全部默认关，安全默认）
acps:
  enabled: true                # 能力总开关
  endpoint:
    enabled: true              # 对外 mTLS 端点（与总开关双真才装配）
    port: 9443                 # 默认 9443
    host: 127.0.0.1            # 默认仅本机
    certDir: null              # 缺省 <root>/acps/certs（自动生成）
    minVersion: TLSv1.3        # 默认 TLSv1.3（可 TLSv1.2）
    devInsecure: false         # 仅显式开发；生产不允许降级
  bridge:
    enabled: false             # 内部桥（进程内双向）
    inbound: false             # 外部写 mailbox 需显式 true
  registry:
    enabled: false             # 半自动注册
    url: null                  # registry public API 基址（必需）
    username: null             # config/env 注入，不硬编码
    password: null
    eabKey: null               # EAB macKey 加密存证密钥（AES-256-GCM）
  discovery:
    enabled: false             # 外部 ADP 发现客户端
    baseUrl: ''                # 外部 discovery-server 根地址
    scope: local               # local / external / both
    timeout: 10000             # 默认 10s
    limit: 5                   # 默认返回上限
```

### 与既有 AIP 能力的关系

- 既有端点（`GET /api/dsh-punky-swarm/tools`、`GET /api/dsh-punky-swarm/agents`、`POST /api/dsh-punky-swarm/discover`、`GET /.well-known/aip`）**一字不动**——ACPs 对外独立 9443 监听 + `/acps/*` 前缀，路径零冲突；
- 既有本地发现（`capabilities.discovery`，默认开）为进程内查询通道；`acps.discovery` 为外部查询通道，`scope=both` 时合并两通道结果；
- ACPs 通讯复用的既有资产：`aip-format` 三映射（Message/TaskCommand/Session）、`lib/aip/identity.js`（AIC 校验/证书）、`lib/discovery/schema.js`（协议常量与校验）；
- 与 `aip.identity`（默认关）同属默认关能力；CAPABILITY_REGISTRY 现 9 键（aip/identity/discovery/verify/watch/worktree/budget/trajectory/acps）。

### 能力边界（未实现）

- **P4 工具调用**：未实现（待国标正式文本定义），不宣称已实现；
- **SM2 签名**：暂不支持——sign 为可插拔接口，默认 ECDSA-P256 / RSA-2048，`algorithm='sm2'` 显式拒绝；
- **mini-ADSP**：对外 `/discover` 服务端语义仅预留函数签名（createMiniAdsp），未实现；

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
