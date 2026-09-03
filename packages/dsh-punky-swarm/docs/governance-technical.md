# Governance 引擎技术手册（批级）

> 本文档描述 dsh-punky-swarm 的批级治理引擎：三层门禁、状态机、wavePlan 契约、任务难度门禁、生命周期、治理工具、配置装配键与架构边界。调用级护栏（6 原语内核）见 [guardrails-hook.md](guardrails-hook.md)；能力边界声明见 [governance-boundaries.md](governance-boundaries.md)。
> English: [governance-technical.en.md](governance-technical.en.md)

治理分两层，本文档覆盖批级层，调用级见 guardrails-hook.md：

| 层 | 机制 | 位点 | 语义 |
|---|---|---|---|
| 任务级（派发前） | 任务难度门禁（`ctx.tools.guard`） | 评估/建批状态机 | 「该执行型调用是否允许发生」 |
| 调用级（执行时） | 护栏 hook pre-execute 内核 | `tools/pre-execute` 事件链 | 「该次调用的参数/工具是否越界」（规则表） |

## 1. 三层门禁（Tier3）

批内任务按 `layer` 分层：plan（出方案）→ exec（执行）→ audit（审查）。generic 批次（任务无 layer 声明）不触发门禁，行为向后兼容。

### 1.1 建批静态校验

建批（wave_plan）时校验：

- `layer` ∈ plan/exec/audit；
- 有 exec 必有 audit（audit 层消费 exec 产物做验收）；
- 产物路径契约：consume/produce/outputs 均解析到批次产物根；
- 跨层引用关系合法（consume 的产物须由前序层 produce）；
- 状态文件防篡改（唯一事实源 + 事件日志可审计）。

### 1.2 逐层门禁

| 门禁 | 触发时机 | 校验 | 不通过处置 |
|---|---|---|---|
| Entry（入口） | exec 派发前 | consume 产物齐备 | 拒派 `GATE_ENTRY_MISSING` |
| Plan 契约（产物结构） | plan 产物结算前 | spec 必填章节（验收标准/约束）+ task-tree 合法 JSON | 拒 merged `GATE_PLAN_CONTRACT` |
| Exit（产物） | exec 结算前 outputs 落盘；audit 结算前 produce 落盘 | 产物存在性 | 拒 merged `GATE_EXIT_MISSING_*` |
| Complete（收尾） | 批次 complete 前 | audit 层验收完成且无 failed/conflict；exec 层全终态 | 拒 complete `GATE_COMPLETE_*` |

门禁状态可用 `gate_status` 查询（consume/produce/outputs 缺件清单），批次与 lane 状态以状态文件为唯一事实源。

## 2. 状态机

```
成员：pending -> running -> review -> merged | failed | skipped | conflict
      （idle = 恢复重派；review -> running = 返工）
批次：planning -> running -> paused -> aborted | complete
      （complete 前置三层门禁）
```

- 批次阶段迁移：`batch_phase`（planning→running→paused→aborted|complete），终态后拒绝再写；
- **paused 三触发源**：手动 `batch_phase(paused)`；或自动失败升级——同批连续失败 ≥3（`reason='failed-escalate'`）；或护栏违规计数升级——`governance.hook.escalation` 开启且归属批次的规则拒绝（DENY/NARROW）10 分钟窗口内 ≥3（`reason='governance-escalate'`，可配 threshold/windowMs/primitives）；均经棘轮校验后自动转入 paused，恢复=人工 `batch_phase(running)`。
- 成员状态操作：pending→running（派发）/ running→review（提交评审）/ idle→running（恢复重派）；终态结算 merged/failed/skipped/conflict 走 `member_settle`，含对应门禁校验（plan merged 前 Plan 契约校验、exec merged 前 outputs 校验、audit merged 前 produce 校验）；
- lane 声明 targets 时，merged 前逐一核对落盘（缺则拒 merged `GATE_TARGET_MISSING`，未变更拒 merged `GATE_TARGET_UNCHANGED`）；
- audit 层产物含 `needHuman: true` 独立行时，merged 须携带人工裁决证据（契约 `human:<裁决人>:<时间>:<结论>`），缺失拒 merged `GATE_NEEDHUMAN_PENDING`。

## 3. wavePlan 任务声明契约

建批时按任务依赖 DAG 分层为 waves；**批次创建后绝不中途重算**（固定语义）。任务可声明字段：

| 字段 | 说明 |
|---|---|
| `layer` | plan / exec / audit（三层门禁判定依据） |
| `consume` | 依赖的批次内产物（相对批次产物根；exec 派发前须齐备） |
| `produce` / `outputs` | 本任务产出（相对批次产物根；结算前须落盘） |
| `role` | 角色（team 装配按 role 注入 skill 前缀，可插拔，不绑定特定团队） |
| `skills` | 显式技能前缀 |
| `deps` | 任务间依赖（形成 DAG → waves） |

同 wave 可并行派发；并发上限在建批时声明。

## 4. 任务难度门禁（Task Difficulty Gate）

每轮（user turn）动手执行前，须经 `assign_check` 给出任务难度与执行主体：

| 难度 | 执行主体 | 适用 |
|---|---|---|
| A | Leader 直做 | 单步可验证、低风险、单角色、无外部依赖（零治理开销） |
| B | 单个 worker | 单角色但需独立上下文/工具面 |
| C | 建批（wave_plan） | 多环节 ≥3 / 多角色 ≥2 / 需门禁 / 外部依赖 / 需可恢复性——任一命中即 C |

- **default to C**：评估对象为完整目标任务（scope=full，含未来步骤）；拿不准就填 C；
- **guard 强制**：判 C 后未建批即调用执行型工具会被引擎拒绝；未评估或评估过期（20 次执行调用或 30 分钟）同样拒绝；只读查询不受限；
- **guard 窗口**：评估状态随执行调用计数与时间双过期；
- **资产归位**：判 C 前 Leader 已直做的探索/排障产物，可用 `asset_claim` 复制归位为批次资产（进入批次资产根），不返工。

难度门禁与调用级护栏串行叠加：内核判 ALLOW → 难度门禁照常生效；内核判 deny/ask → 难度门禁不再参与（不变量：难度门禁只可能「收紧」不可能被绕过）。

## 5. 生命周期

- **lane 条件**：建批静态声明（依赖产物/文件存在），派发前校验，不满足落 skipped；
- **archive 自动归档**：complete 后自动单向归档（产物打包保留可查，不可回滚）；
- **needHuman 人工挂起**：audit 产物声明 needHuman → lane 挂 review，Manager 转达人工裁决（merged/conflict），不新增成员态；
- **棘轮规则表**：状态迁移配置化（只许删不许增，allowRelax 逃生门默认关）；
- **恢复机制**：checkpoint 保全 + 恢复审计 + 崩溃后 idle 归位重派（新 worker 可查 checkpoint 跳过已完成步骤）；失败 lane 为终态，重做 = 重开新批次（不自动续跑）。

## 6. 治理工具参考

工具按功能分组；注册受装配键控制（见 §7），`log_export` 仅当 `capabilities.logs` 开启时注册。

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
| `lane_worktree_create` | 为 lane 建独立 git worktree（从集成分支 HEAD 基线） |
| `lane_worktree_merge` | 合并 lane 分支进集成分支（冲突保留现场 + 清单） |
| `lane_checkpoint` | lane 内 checkpoint 提交（git add+commit，保产物） |
| `lane_checkpoint_status` | 查询 checkpoint 历史与进度（续跑契约入口） |

### 日志

| 工具 | 说明 |
|---|---|
| `log_export` | 只读事件流导出（lane/type/since 过滤 + json/markdown + 引擎产物根落盘） |

## 7. 配置装配键

装配集中在 `cordis.patch.yml`；运行期覆盖见 guardrails-hook.md 热更新节。键值语义以代码事实为准（`lib/assembly/schema.js` CAPABILITY_REGISTRY 为注册表单一事实源）：

| 能力 | 装配键 | 默认 | 机制 |
|---|---|---|---|
| 发现服务（ADP） | `capabilities.discovery` | 开 | 挂载 `POST /api/dsh-punky-swarm/discover` + `GET /.well-known/aip`；nodes 可逐节点 active=false 隐藏 |
| 诊断桥接 | `capabilities.trajectory` | 开（autoFail=false） | 异常诊断 → sessionId→lane 映射 → notify；autoFail=true 时才自动 failed（failConfidence 阈值） |
| mailbox 环防护 | `capabilities.budget` | 开（hops=4 / roundTrips=2） | outbox/broadcast 发送前 checkBudget；inbox（Leader 下行派发）永不受限 |
| 心跳/过期检测 | `capabilities.watch` | 开 | watchdog 定时器 + lane_heartbeat；退避档位追问 + 连续 N 拍无活动 → lane.stalled 标记（只标记不自动处置） |
| worktree 物理隔离 | `capabilities.worktree` | 开 | lane_worktree_create/merge/checkpoint；与 lane_claim 逻辑锁互补 |
| 验收证据 | `capabilities.verify` | 开（mode=advisory） | post-execute 证据捕获（内容寻址 blob + ledger）；三态裁决（done/failed/blocked）；mode=enforce 时拦截 |
| 日志导出 | `capabilities.logs` | 关 | log_export 工具注册（patch 显式开启） |
| topic 订阅 | `capabilities.topic` | 关 | subscribeTopic/emitTopic：进程内分发 + mailbox broadcast 落盘 |
| 冲突化解 agent | `capabilities.worktree.mergeAgent` | 关 | 需宿主注入 spawner；未注入时冲突保持 conflict 态 |
| AIP 目录/端点 | `aip.enabled` | 开 | 工具 6 属性目录 + `GET /api/dsh-punky-swarm/tools` |
| 身份体系 | `aip.identity.enabled` | 关 | AIC/CAI/签名/信任链（细节见 aip-compliance.md） |
| ACPs 通讯 | `acps.*` | 全关 | mTLS 端点/桥接/registry/discovery（细节见 acps-communication.md） |
| 调用级护栏 | `governance.hook` | 开（rules 空表=零拦截） | 6 原语内核 pre/post 裁决（细节见 guardrails-hook.md） |

装配开关语义：`enabled` 缺省合并注册表 default；显式 `enabled: false` 关闭对应能力（工具不注册、hook 不挂载、零运行时路径）。`mergeAgent` 需宿主注入 spawner。

## 8. 架构边界

- **进程内治理**：批次/门禁/状态机/通信全部在 dsh 插件进程内完成，治理对象为同一进程内编排的一批 Agent 子进程；
- **零外部依赖**：引擎实现使用 Node.js 原生能力（node:fs / node:crypto / node:https / node:tls），peer 依赖仅宿主运行时（@deepseek-ai/dsh-tools、@deepseek-ai/cordis）；
- **网络能力默认关**：ACPs 等网络类能力全部默认关闭；关闭时无监听、无定时器、无网络路径（零运行时足迹）；
- **单机能力边界**：面向单机进程内治理；跨机分布式同步、多机编排等不提供，详见 [single-machine-capabilities.md](single-machine-capabilities.md)。
