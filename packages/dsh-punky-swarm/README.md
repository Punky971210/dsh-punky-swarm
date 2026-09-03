# dsh-punky-swarm — Punky Swarm 集群治理

![license](https://img.shields.io/badge/license-AGPL--3.0-blue) ![node](https://img.shields.io/badge/node-%3E%3D22-green) ![CI](https://github.com/Punky971210/dsh-punky-swarm/actions/workflows/ci.yml/badge.svg)

> **定位**：dsh（DeepSeek Harness）的集群治理插件——在**本地**把一批 Agent 子进程编排为可门禁、可审计、可恢复的批次流水线。**零云依赖，默认零网络暴露**，编排、裁决与留痕全部在 dsh 进程内完成。

English: [README.en.md](README.en.md)

## 特性

- **双层治理，两道防线**——批级编排与调用级护栏叠加生效：批级决定「任务怎么派」，护栏决定「每次工具调用是否越界」，互不绕过。
- **自动三层门禁**——批次按 plan → exec → audit 分层推进，入口、方案契约、产物、收尾逐层校验（Entry / Plan / Exit / Complete），缺件即拦截，问题不流入批次结果。
- **任务难度分级路由**——任务先判难度（A 直做 / B 单 worker / C 建批），复杂任务自动进入批次流水线；判定 C 而未建批不放行执行。
- **并发安全，多 lane 并行**——lane 单写者锁 + git worktree 物理隔离，多个 lane 并行写同一仓库互不覆盖，冲突保留现场、裁决后处置。
- **进程内消息与环防护**——mailbox 三箱（inbox / outbox / broadcast）原子写与确认，环防护抑制消息风暴，通信路径可追踪。
- **崩溃可恢复**——心跳过期检测 + 进度 checkpoint 保全：崩溃后现场与产物可查、新 worker 可接续；不自动续跑，失败任务重做即开新批次。
- **只读监控面板**——Web UI 直接查看批次、lane 状态与事件时间线，只读不干预，人工不可误改。
- **工具调用级护栏（6 原语）**——双层治理中的调用级防线（本地优先、证据可审计）：除派发前难度门禁外，每次工具调用再按 ALLOW / DENY / REQUIRE_APPROVAL / NARROW / DEFER / PAUSE 六原语逐调用裁决是否越界，命中即产出**可验篡改的拒绝收据**（sha256 哈希链锚定，复核可定位篡改位置）。裁决确定、可预期、便于测试，适合需要**可审计防越界、确定性可测试治理**的本地多 Agent 编排。护栏事件以收据与事件流文件留痕、可复核（事件级可观测），暂无独立 UI 面板；出厂 `rules` 为空即零拦截，按需配置规则后生效。
- **热更新配置，免重启**——护栏规则与开关写入 `runtime.json` 即时生效，进程无需重启。
- **国标 AIP 兼容**——遵循《人工智能 智能体互联》GB/Z 185-2026 描述结构（工具 6 属性 / 智能体 ACS / 消息任务会话映射），仅增不改、可插拔。
- **可选的 ACPs 通讯**——对外 mTLS 服务端点、registry 注册与外部发现，默认全部关闭（安全默认）。
- **本地运行，开箱即用**——零云依赖、默认零网络暴露；单一 npm 包内含插件引擎、Punky Swarm 预设与 jiufeng-team 角色指引，附中英双语文档。

## 安装

前置要求：Node.js ≥ 22 与 dsh 运行环境；以下命令中的 `web` 为示例 profile，可替换为实际使用的 profile。

### 快速路线（npm）

```sh
npm install -g dsh-punky-swarm
dsh plugin --profile web add dsh-punky-swarm
dsh web restart
```

### 开发路线（git 源码）

```sh
git clone https://github.com/Punky971210/dsh-punky-swarm.git
cd dsh-punky-swarm
npm ci --prefix packages/dsh-punky-swarm
# POSIX
dsh plugin --profile web add link:$(pwd)/packages/dsh-punky-swarm
# Windows PowerShell
dsh plugin --profile web add link:$PWD\packages\dsh-punky-swarm
dsh web restart
```

`web` 为示例 profile，可替换为实际使用的 profile。插件启动时自动同步内置预设与技能指引到用户目录（`~/.dsh/.agent-presets/jiufeng`、`~/.agents/skills/jiufeng-team`），无需手动放置；内容一致则跳过，不一致则更新为包内版本。

## 快速开始

装好插件后三步即可跑通第一个批次：

1. **启用插件**：执行上方安装命令，`dsh web restart` 后插件与监控面板即加载。
2. **建第一个批次**：向 Leader 说明目标，Leader 完成难度判定后调用 `wave_plan` 建批，任务按依赖自动分层为 waves。最小任务意图示例：
   > 拆分为三层批次：plan 层产出实现方案；exec 层按方案实现并补测试，依赖 plan 产物；audit 层核对后放行。
3. **看进度**：打开监控面板（会话页「Punky Swarm 集群」分页），查看批次阶段、lane 状态与事件时间线；批次完成后产物自动归档，全程可查。

任务会先经难度路由（A 直做 / B 单 worker / C 建批），复杂任务自动进入批次，避免小任务大流程。工具调用与建批契约细节见 [docs/governance-technical.md](docs/governance-technical.md)。

## 监控面板

插件自带**只读**监控面板，位于会话区头部「对话 / 轨迹 / Punky Swarm 集群」第三分页，安装即得、无需额外配置：

- **批次列表**：阶段与完结进度、可放行/已完结标记；
- **统计条**：总批次 / 运行中 / 已完结 / 异常（failed + conflict）；
- **批次详情**：lane 状态卡（状态、任务简述、门禁缺件、层与依赖）、事件时间线、收件箱计数；
- **只读设计**：3 秒自动刷新，跟随深浅主题；批次与门禁状态只能查看，治理操作由 Leader 通过治理工具完成。

## 配置速览

插件配置集中在 `cordis.patch.yml`，关键装配键与默认值：

| 能力 | 装配键 | 默认 |
|---|---|---|
| 治理工具与监视能力（aip / discovery / verify / watch / worktree / budget / trajectory） | `capabilities.*` | 开 |
| 日志导出（`log_export`）、冲突化解 agent | `capabilities.logs` / `capabilities.worktree.mergeAgent` | 关 |
| 工具调用级护栏 | `governance.hook` | 开；出厂 `rules` 为空（零拦截） |
| 国标 AIP 目录与查询端点 | `aip.enabled` | 开 |
| 身份体系（AIC / CAI / 签名） | `aip.identity.enabled` | 关 |
| ACPs 通讯（mTLS 端点 / 桥接 / registry / discovery） | `acps.*` | 关（关闭时无监听、无定时器、无网络） |

各键语义、配置示例与规则写法见 [docs/governance-technical.md](docs/governance-technical.md) 与 [docs/guardrails-hook.md](docs/guardrails-hook.md)。

### 安全默认

- **出厂零拦截**：护栏 `rules` 默认为空，装上即用、不改变既有行为；规则按需启用。
- **网络能力默认关**：ACPs 等网络类能力默认关闭，关闭状态下无监听、无定时器、无网络路径。
- **本地即用**：无需分布式基础设施、无需外部服务；本地起 dsh 即具备完整治理能力。

## 核心概念

- **批次与 lane**：`wave_plan` 把目标任务按依赖关系（DAG）分层为 waves，每个最小工作单元是一个 lane；分层在创建时确定、之后不重算，流程可预期。
- **三层结构**：批内任务分 plan（出方案）→ exec（执行）→ audit（审查）三层，逐层校验产物、缺件不放行；审查不过的任务不并入批次结果。
- **双层治理**：批级编排管「任务怎么派」，调用级护栏管「每次工具调用是否越界」——两层叠加、串行生效，护栏只可能收紧、不可能被绕过。
- **状态可追踪**：批次（planning → running → paused → aborted / complete）与 lane（pending → running → review → merged / failed / skipped / conflict）由状态机驱动，事件全程留痕、可审计，恢复与复核有据可查。

一次典型批次流水线：

```mermaid
flowchart LR
    A[plan 出方案] -->|方案契约校验| B[exec 执行]
    B -->|产物落盘校验| C[audit 审查]
    C -->|收尾校验| D[complete 归档]
```

**由来**：单 Agent 全流程人工介入重、流程写死成图则改动成本高且自由度低；本插件取中间路线——Leader 拆解、多角色协作、门禁裁决，兼顾流程可控与 Agent 自由度。

**边界（不提供）**：本插件面向单机进程内治理，不提供跨机分布式集群同步、多机编排、成本控制与模型分层路由；崩溃恢复为 checkpoint 保全 + 人工可查可接续，不自动续跑。

机制细节、状态机与工具参考见 [docs/governance-technical.md](docs/governance-technical.md)。

## 文档导航

技术细节均沉淀在 `docs/` 下（每份文档同步提供英文版）：

| 文档 | 内容 |
|---|---|
| [docs/governance-technical.md](docs/governance-technical.md) | 批级治理技术手册：三层门禁、状态机、wavePlan 契约、20 治理工具参考、装配键表、生命周期 |
| [docs/guardrails-hook.md](docs/guardrails-hook.md) | 调用级护栏技术手册：6 原语运行期语义、规则配置与示例、拒绝收据与验签、热更新、边界与不提供项、能力边界与取舍 |
| [docs/aip-compliance.md](docs/aip-compliance.md) | 国标 AIP 兼容明细：工具 6 属性、ACS 字段集、消息/任务/会话映射、身份体系 |
| [docs/acps-communication.md](docs/acps-communication.md) | ACPs 通讯明细：mTLS 端点、内部桥接、registry / discovery、配置示例、能力边界 |
| [docs/governance-boundaries.md](docs/governance-boundaries.md) | 能力边界声明：哈希链与 canonical 边界、规则示例与测试同步维护口径 |

## 许可与商业授权

本项目以 **GNU AGPL v3（AGPL-3.0）为唯一许可**：

- 在遵守 [AGPL-3.0](LICENSE) 的前提下，可自由使用、修改、分发（含商用）；若修改后通过网络提供服务，须按 AGPL-3.0 公开修改内容。
- 如需其他许可（如闭源商用），请联系作者获得许可。
