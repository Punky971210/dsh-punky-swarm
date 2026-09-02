# dsh-punky-swarm — Punky Swarm 集群治理

![license](https://img.shields.io/badge/license-AGPL--3.0-blue) ![node](https://img.shields.io/badge/node-%3E%3D22-green) ![CI](https://github.com/Punky971210/dsh-punky-swarm/actions/workflows/ci.yml/badge.svg)

> dsh（DeepSeek Harness）**单机多子 agent 集群治理**插件：wavePlan 三层 DAG（固定语义，建批后不重算）+ 引擎级门禁（Entry / Plan 契约 / Exit / Complete）+ 状态机 + 锁/mailbox + 会话隔离 + 任务难度路由门禁 + 国标 AIP 兼容 + 治理能力增强（心跳/watchdog、worktree 物理隔离、验收证据、mailbox 环防护、诊断桥接、日志导出）。附 Punky Swarm 预设与 jiufeng-team 角色指引。

English: [README.en.md](README.en.md)

## 边界（Scope）

- **目标**：dsh **单机多子 agent 治理**——在同一 dsh 进程内治理一批 worker（批次 / 门禁 / 通信 / 恢复重置派发）；
- **范围外**：分布式集群同步、成本控制、模型分层路由；续跑仅提供 checkpoint 保全与恢复审计（失败 lane 仍终态、重做仍开新批次）。

## 设计目的与由来

**目的**：门禁（Entry/Plan 契约/Exit/Complete）与批次、锁、mailbox 等机制的核心目的，是**保障流水线与集群的稳定运行**，而非限制 Agent 自由度——工具层对 Agent 全量开放，模式层只给指引，团队装配可插拔；任务按规模分级（Leader 指派 → 单 Agent 降级）。

**由来**：本项目源于单 Agent 全流程与图式编排之间的取舍：

- 单 Agent 全流程（设计→执行→测试）：人工介入重，人成为流程瓶颈；
- 图式编排（LangGraph 方向）：尝试后放弃——流程写死成图，改动成本高，Agent 自由度被压死；
- 折中：按 Leader 拆解 → 多角色协作 → 门禁裁决的工作模式在早期 Swarm 集群运行时上落地，随后迁移到 dsh 成为本插件。

## 三件套

| 件 | 位置 | 内容 |
|---|---|---|
| 插件 | packages/dsh-punky-swarm | 引擎：**20 治理工具** + Tier3 门禁 + 会话隔离 v2 + 只读 API（含 AIP /tools 端点）+ 任务难度门禁 + Punky Swarm 集群监控面板 |
| 模式 | packages/dsh-punky-swarm/presets/jiufeng | Punky Swarm 预设：Leader persona + 治理纪律 + tool-bootstrap |
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

## Punky Swarm 集群监控面板（只读）

插件自带 **Punky Swarm 集群** 监控面板：会话区头部「对话 / 轨迹 / Punky Swarm 集群」第三分页（conversation.view），**安装即得，无需额外配置**。

- **批次列表**：阶段（planning/running/complete…）+ 终态进度 `3/5` + 可自动放行/已完结标记；
- **统计条**：总批次 / 运行中 / 已完结 / 异常（failed+conflict）；
- **批次详情**：lane 状态卡（状态 + 任务简述 + 门禁缺件明细 + 层/依赖）、事件时间线、收件箱（派发/广播）计数；
- **只读**：3s 自动刷新，跟随 Web UI 深浅主题；执行引擎（批次/门禁/状态机）**人工不可修改，只能查看**，治理操作由 Punky Swarm Leader 执行。

## 治理工具（20）

> 口径说明：**20 为 cordis.patch.yml 全开口径**（`logs.enabled: true` 时含 `log_export`）。
> 缺省配置（config 无 capabilities 键）下 7 键默认开（aip/discovery/verify/watch/worktree/budget/trajectory），
> 工具总数 19（不含 `log_export`）；`logs` 默认关，patch 显式开启后达 20。显式 `enabled: false` 可逐键关闭。

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
- **智能体描述（GB/Z 185.4-2026 第 4 部分：智能体描述；ACS 字段集）**：装配配置 → 每角色 ACS AgentCapabilitySpec 描述（根对象 20 键 = 必填 14：aic / active / lastModifiedTime / protocolVersion / name / description / version / provider / securitySchemes / endPoints / capabilities / defaultInputModes / defaultOutputModes / skills，可选 6：iconUrl / documentationUrl / webAppUrl / entityUserId / entityMeta / certificate；AgentSkill 8 键 = 必填 5：id / name / description / version / tags，可选 3：examples / inputModes / outputModes；协议 02.01）；
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
- **/rpc→bridge 接线**：`POST /acps/rpc` 收到的 TaskCommand 经 `handleInbound` 落 mailbox；`bridge.inbound=false` 时协议级 `rejected`（INBOUND_DISABLED，HTTP 200 返回——传输成功、协议层拒绝）；bridge 未装配时回端点缺省 accepted（向后兼容）；
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

- **工具调用（GB/Z 185.7-2026 第 7 部分：智能体工具调用）**：未实现；
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
- 任务可声明 layer（plan/exec/audit）、consume/produce/outputs、role/skills；team 装配按 role 注入 skill 前缀（可插拔，不绑定特定团队）；
- 同 wave 可并行派发；批次/成员状态以状态文件为唯一事实源（事件日志可审计）。

## 任务难度门禁（Task Difficulty Gate）

- **每轮（user turn）动手执行前**，Leader 须经 assign_check 给出任务难度 A/B/C 与执行主体：A=Leader 直做 / B=单个 subagent / C=集群 wave_plan 建批；
- **default to C**：评估对象是完整目标任务（scope=full），任一 C 特征（多环节≥3 / 多角色≥2 / 需门禁 / 外部依赖 / 可恢复性）即判 C；拿不准就填 C；
- **guard 强制**：判 C 后未建批即调用执行型工具（pwsh/write/edit/run/subagent 等）会被引擎拒绝；未评估/评估过期（20 次执行调用或 30 分钟）同样拒绝，只读查询不受限；
- **asset_claim**：判 C 前 Leader 已直做的探索/排障产物，可用 asset_claim 归位为批次资产，不返工。

## 工具调用级护栏（Governance Hook，M2）

订阅宿主 `tools/pre-execute` + `tools/post-execute` 双阶段（零宿主改造，插件侧增量），CAGE 6 原语纯函数内核裁决（`lib/governance/`，TS 编译回拷）：

- **分层语义**（与任务级门禁互补，不冲突）：

| 层 | 机制 | 位点 | 语义 |
|---|---|---|---|
| 任务级（派发前）| `ctx.tools.guard`（任务难度门禁）| 评估/建批状态机 | 「该执行型调用是否允许发生」|
| 调用级（执行时）| 本 hook pre-execute kernel | `tools/pre-execute` waterfall | 「该次调用的参数/工具是否越界」（规则表）|

  执行序：pre-execute waterfall（kernel）→ ask 解析 → 难度门禁（guardReason）→ dispatch；kernel 判 ALLOW → 难度门禁照常生效（两门禁串行叠加）；kernel 判 deny/ask → 难度门禁不再参与（不变量：难度门禁只可能「收紧」不可能被绕过）。

### ① 原语运行期语义（6/6）

| 原语 | 落地形态 | 触发档位 |
|---|---|---|
| `ALLOW` | 透传不拦截（`next()`）| 规则未命中 / 命中零违规 |
| `DENY` | `{kind:'deny'}` 拒绝执行 | hard（P2）；pausable/narrowable/soft 在对应 flag 关闭时回退 DENY（P3-P5）|
| `REQUIRE_APPROVAL` | `{kind:'ask'}` → 宿主 approval 通道（serviceAsk）| manual_review（P1）/ ftra（P0）/ soft 置信达标（P6）|
| `NARROW` | `{kind:'deny'}` + 参数收窄指引 + 收据 `narrowedParams` | flag.narrow=true 且 narrowable（P4）|
| `DEFER` | `{kind:'deny'}` + 会话延后挂起（状态文件 + 收据 `deferMeta`）| flag.defer=true 且 soft（P5）|
| `PAUSE` | `{kind:'deny'}` + 会话暂停（状态文件 + 收据 `pauseMeta`）| flag.pause=true 且 pausable（P3）|

- **统一拒绝消息格式**：`[governance:<primitive>] <reason>`（primitive ∈ ALLOW/DENY/REQUIRE_APPROVAL/DEFER/NARROW/PAUSE；对齐难度门禁 `[task-difficulty-gate]` 前缀风格）——模型侧可区分「任务级未评估」vs「调用级越界」。DENY/DEFER/NARROW/PAUSE 统一以 `{kind:'deny'}` 落地（2.2 简版 + 收据元信息）；REQUIRE_APPROVAL → `{kind:'ask'}`。
- **REQUIRE_APPROVAL ask 行为（显式化）**：pre 同步落盘 `ask: {channel:'host-serviceAsk', initiated, requestId(=callId)}`，post 尽力补记 `outcome`（denied-no-approval / denied-no-agent / denied-rejected / denied-cancelled / unavailable / allowed-once）。**依赖宿主 approval 通道（serviceAsk），无审批服务 / 无 agent = 降级 deny**（行为不变，记录显式化）；allowed-once → allow。
- **DEFER/PAUSE 文件态简版状态机（flag 开启后真实生效）**：`flags.defer: true`（soft 违规）→ 会话挂起延后（状态文件 `<root>/governance/state/<sessionId>.json`，窗口 30s，收据含 `deferMeta`）；`flags.pause: true`（pausable 违规）→ 会话暂停（窗口 60s，收据含 `pauseMeta`）。挂起/暂停期间同会话调用统一 `[governance:DEFER|PAUSE]` deny（reason 含 retry-after / pauseToken / until），**惰性过期自动恢复**（读时清理，无定时器 / 无 resume 端点）；flag-off 折叠 DENY 无状态副作用（与「会话延后/暂停中」可区分）。

### ② 配置指南与示例规则（可复制）

- **配置**：`cordis.patch.yml` 顶层键 `governance.hook`——`enabled: true`（**默认开**，已敲定 2026-08-31；显式 `enabled: false` 可关）/ `rules: []` / `defaults.deny: DENY`（fail-closed 兜底，可配其他拒绝类原语，不可为 ALLOW）/ `flags: {pause:false, narrow:false, defer:false}`（原语开关默认关 → 对应档回退 DENY）。规则表按 `Rule` 结构（`id` / `tools?` / `match{path?,op?,pattern?,value?}` / `violations[{code,category,severity?,message,path?}]` / `narrow?`）。
- ⚠️ **出厂默认 `rules: []` = 零拦截**（decide 恒 ALLOW，行为不变）——勿误以为护栏在生效；以下示例复制到 `governance.hook`（替换 `rules` 与 `flags` 段）即真实生效，亦可写入 `<root>/config/runtime.json` 热更新覆盖（见 ⑤）。

```yaml
# 复制到 cordis.patch.yml 的 governance.hook 段（替换既有 rules: [] 与 flags 即可生效）
# 预期行为：示例 1 命中 → DENY；示例 2 命中 → NARROW（收窄指引 + narrowedParams 落收据）；
#            示例 3 命中 → REQUIRE_APPROVAL ask（依赖宿主 approval 通道，无通道则降级 deny）
governance:
  hook:
    enabled: true
    flags:
      pause: false
      narrow: true      # 示例 2 需开启 narrow 原语（默认 false——不开则示例 2 回退 DENY + 收窄指引）
      defer: false
    rules:
      # 示例 1：禁止强制删除（hard → DENY）——tools 按宿主实际工具名（bash/pwsh/…）
      - id: example-forbid-force-delete
        tools: [bash, pwsh]
        match: { path: /cmd, op: regex, pattern: 'rm -rf|Remove-Item -Recurse|del /f /s /q' }
        violations:
          - code: EX1
            category: hard
            message: 强制删除命令被护栏禁止（rm -rf / Remove-Item -Recurse / del /f /s /q）
      # 示例 2：超时参数收窄（narrowable + narrow bounds → flag.narrow=true 时 NARROW）
      - id: example-timeout-narrow
        tools: [bash]
        match: { path: /timeout, op: gt, value: 3600 }
        violations:
          - code: EX2
            category: narrowable
            message: 超时参数超过 3600s，需收窄
        narrow:
          - path: /timeout
            max: 3600
      # 示例 3（可选）：审批门（manual_review → REQUIRE_APPROVAL）
      - id: example-admin-approval
        match: { path: /scope, op: eq, value: admin }
        violations:
          - code: EX3
            category: manual_review
            message: 高危管理操作需人工复核
```

预期行为（喂 kernel 裁决）：示例 1（`bash` + `cmd: "rm -rf /data"`）→ `DENY`（priority 2，ruleRefs `['example-forbid-force-delete']`）；示例 2（`bash` + `timeout: 7200`）在 `flags.narrow: true` → `NARROW` + `narrowedParams`（`/timeout` 7200 → 3600 钳制明细），flag-off 则回退 `DENY`；示例 3（任意工具 + `scope: "admin"`）→ `REQUIRE_APPROVAL`。

### ③ 收据证据信封（哈希锚定 + 验签）

- **拒绝收据**：`<root>/governance/refusals/<sessionId>/<receiptId>.json`（原子写 tmp+rename）+ `ledger-<sessionId>.jsonl`（追加）。**基础八键**：receiptId / ts / tool / callId / sessionId / decision（primitive+priority+reason）/ attemptedParams / ruleRefs；**可选扩展**（P0-P2，向后兼容，旧收据无字段不炸）：`narrowedParams`（NARROW / DENY-含窄域的钳制指引）、`deferMeta` / `pauseMeta`（DEFER/PAUSE 元信息）、`ask`（REQUIRE_APPROVAL 记录）、`anchor`（哈希锚定）。
- **哈希锚定（P2，M5-d 简版）**：同 session 收据按 ts 序串 sha256 哈希链——`anchor: {version: 1, alg: 'sha256', prevHash, hash}`；hash 覆盖收据除 anchor 自身外全部字段（含 prevHash），篡改任一收据即破坏其后整条链。
- **验签**：`lib/governance/receipt-store.js` `verifyRefusals(root, sessionId)` → `{ok, brokenAt, count, receipts}`——逐条 `{receiptId, ts, anchored, ok, issue?}`，issue = `hash-mismatch`（自身内容被篡改）/ `link-break`（prevHash 与链上前一不符 = 缺链/伪造重锚）；旧收据（无 anchor）不参与链校验、不判失败（兼容）。审计可复跑：改 1 字节 → verify 失败且 brokenAt 定位。
- **能力边界**：canonical 为 RFC8785 简版（键排序 + 无空白 + undefined/NaN 对齐 JSON.stringify）；完整 RFC8785 数字规范化/逐字符转义与真签名（WORM）归 M5（见 ⑥）。

### ④ 双层桥接（批级事件流）

收据落盘 → 装配层 `onRefusal` 回调 → 批级事件流 `<root>/governance/events/refusal-<sessionId>.jsonl`（每行 `{type:'governance.refusal.recorded', ts, sessionId, receiptId, primitive, tool, callId}`），与 refusals 收据/ledger 并行可观测——**分层治理「收据层 → 批级事件流」协同**（hook-eval A.3 批判 6 关闭）。仅事件可见性，**不触发批级状态迁移**（DEFER/PAUSE → batch_phase paused/aborted 联动归 M5-a）；回调抛错隔离 warn 不阻断裁决；dispose 后断开；热更新重挂后桥接随动重新注入（见 ⑤）。

### ⑤ 热更新（免重启）

- governance 键已纳入 runtime.json 顶层白名单（`lib/hot/config-watch.js` `ALLOWED_TOP_KEYS`）——`governance.hook` 任一**生效子键变化**（enabled 翻转 / rules / flags / defaults）经装配侧 `applyConfigChange` ⑤ dispose + 重挂**即时生效，免重启**（对齐 verify ④ 模式；kernel 闭包持有旧配置 → 统一重挂，不引入 updateConfig API）。重挂后运行时状态重置（refusals count 归零、跨重挂在途 ask 的 outcome 补记丢失——收据 `ask.initiated` 已在 pre 落盘不丢审计）；DEFER/PAUSE 会话状态为文件态（state-store），不随重挂丢失。
- **覆盖示例**（写入 `<root>/config/runtime.json`，原子写 tmp+rename；深度合并叠加，静态配置零改动）：

```json
{ "governance": { "hook": { "enabled": false } } }
```

  写 `enabled: false` → 热切卸载（pre 不再触发，调用不再被拦）；写回 `true` 或删除该键（恢复默认 true）→ 重挂生效。rules 覆盖示例（数组整体替换，其余子键保留静态值）：

```json
{ "governance": { "hook": { "rules": [ { "id": "runtime-deny-shutdown", "tools": ["bash"], "match": { "path": "/cmd", "op": "regex", "pattern": "shutdown" }, "violations": [ { "code": "RT1", "category": "hard", "message": "禁止 shutdown 命令" } ] } ] } } }
```

  预期：写入后重挂 → 新规则立即拦截 `shutdown` 调用（DENY + 收据落盘），无需重启进程。

### ⑥ 不做清单（修订）

防范围蔓延（M2 施工边界，修订后仍完整）：MCP 网关/进程外路径（N-1）、8-tier 金融层（N-2）、NeMo/Presidio/spaCy 重依赖（N-3）、K8s/云集成（N-4）、模型侧 LLM 拦截（N-5）、路由封条 seal（N-6）、DEFER/PAUSE **完整**状态机（N-7，指 Redis 状态机/队列语义——文件态简版已落地 P1，见 ①；禁 setInterval/禁端点核查保持）、NARROW 透明参数改写（N-8，宿主禁止输入改写，以 deny+指引落地）、流事件 tools/result+SSE（N-9）、哈希锚定/签名证据信封（N-10，指完整 RFC8785/真签名——M5-d **sha256 链简版已落地 P2**，见 ③）、WORM（N-11，维持不做）。完整核查方法见批次 `exec/tester-report.md`。

- 残留 #3/#5/#6/#9 已裁定边界与复核结论：[governance-boundaries.md](docs/governance-boundaries.md)

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
