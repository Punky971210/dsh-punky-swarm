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
      （idle = **空闲态**（字面意义的空闲，非崩溃态）→ running = 返工/续跑重派；review -> running = 返工）
批次：planning -> running -> paused -> aborted | complete
      （complete 前置三层门禁）
```

- 批次阶段迁移：`batch_phase`（planning→running→paused→aborted|complete），终态后拒绝再写；
- **paused 三触发源**：手动 `batch_phase(paused)`；或自动失败升级——同批连续失败 ≥3（`reason='failed-escalate'`）；或护栏违规计数升级——`governance.hook.escalation` 开启且归属批次的规则拒绝（DENY/NARROW）10 分钟窗口内 ≥3（`reason='governance-escalate'`，可配 threshold/windowMs/primitives）；均经棘轮校验后自动转入 paused，恢复=人工 `batch_phase(running)`。
- 成员状态操作：pending→running（派发）/ running→review（提交评审）/ **idle→running（空闲态重派：返工/续跑；`idle` 非崩溃态）**；终态结算 merged/failed/skipped/conflict 走 `member_settle`，含对应门禁校验（plan merged 前 Plan 契约校验、exec merged 前 outputs 校验、audit merged 前 produce 校验）；
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

同 wave 可并行派发；**并发声明**在建批时声明（**已不参与运行期准入**——Q-B 取消并发闸，2026-09-18：不再有超限拒绝与排队，字段仅声明 + 回显）。

> 拓扑真源（`tasks[].deps` + `batch.handoffs`）、链声明退役后的读端口径、交接门（`handoffGate`）缺省可见性与会话通道口径，见 `docs/chain-retirement-and-topology-20260918.md`。

## 4. 任务难度门禁（Task Difficulty Gate）

每轮（user turn）动手执行前，须由 Leader 用 `assign_check({ difficulty, rationale, scope: "full" })` **主动写入**任务难度与执行主体（**无默认档**，不填即拒）：

| 难度 | 执行主体 | 适用 |
|---|---|---|
| A | Leader 直做 | 单线程（无并行任务线、无依赖链）、低风险、可自验（零治理开销） |
| B | 单个 worker | **仅限两类**：① 需独立子代理做**不占用主 Agent 上下文**的调研（查代码 / 读大文档 / 跑探针）；② 其他**已明确上下文、可简单派发**的单步任务 |
| C | 建批（wave_plan） | **判据（最高优先级）：明确多线并行**（≥2 条可并行推进的任务线）**或 多依赖**（任务间依赖链需 DAG 分层 / 多波次）；**单线程任务一律不建批**（环节数 / 字数不构成升 C 理由） |

- **并发度优先（2026-09-13 用户裁决）**：升 C 只看「多线并行 / 多依赖」；`execToolCount` 只是弱旁证，提示（`escalationHint`）**不得**读作「必须建批」；
- **主动写入、无默认档**：`difficulty`（枚举 `A|B|C`，**必填**）与 `rationale`（判据，**必填**且 ≥12 字）由 Leader 主动写入，落 `governance.json` 的 `lastAssign{ difficulty, rationale, derived, override, form, reasons }` + `history` 供审计；缺 `difficulty` / 不在 `A|B|C`（含 `C+`）一律拒——**外部可观测形态 = 工具参数 schema 层**（`invalid arguments: "difficulty" must be one of ["A","B","C"]`），码字 `GATE_DIFFICULTY_INVALID` 是同一拒收在**内核显式分支**的命名（仅在绕过 schema 的调用路径可见，**勿当作可 grep 到的外部错误码**）；缺/过短 `rationale` 同形（schema 层 `missing required property "rationale"` ⇔ 内核 `GATE_DIFFICULTY_RATIONALE_MISSING`）；旧口径「default to C」「拿不准就填 C」**已废止**；评估对象为完整目标任务（scope=full，含未来步骤）；
- **布尔特征降为交叉校验 + 有解释的偏离（2026-09-14 用户裁决 B）**：`parallel` / `multiRole` / `gate` / `recoverable` / `needIsolation` 不再唯一决定档位，只作校验输入；引擎据此算出 **`derived`**（任一 C 判据 → `C`；否则 `needIsolation` → `B`；否则 `A`）。`difficulty` 与 `derived` **相等即放行**（`override:false`）；**不等时「有解释才放行」**（记 `override:true`）——「解释」= `rationale` 含三要素：① 引用具体特征面 ② 例外/反例 ③ 偏离方向与上限；缺任一即拒 `GATE_DIFFICULTY_MISMATCH`（消息列出缺项）。例：声明 C 而四项判据全 false、rationale 给出「三条修正线虽串行但耗时长」的例外与上限 ⇒ 放行；**无解释**的同类声明仍拒（含「单线程随手报 C」）；
- **只读侦察面**：`read` / `glob` / `grep` 与**只读 shell 命令**（pwsh/bash 的**命令级**判定，实现 `lib/tools/readonly.js`：只读白名单 + 写指示符拒绝 + 默认拒绝）在**任何评估状态下放行且不计数**（不占 `execCallsSince` 评估窗口）；执行型工具（write/edit/**非只读 shell**/subagent 等）调用前仍须先评估。**边界（如实标注）**：该判定是**启发式、非沙箱**——可经别名、脚本文件、转义参数、编码方式绕过，只收敛「无意识地用写命令做侦察」这一主路径，**不承诺**等价于 OS 级隔离；**判定口径（2026-09-14 复核后修正）**：引号字面量先**掩码**（引号内的 `>` / `|` / `;` 不参与判定，修误拒）、`2>&1` / `2>$null` 属**流合并**放行（真重定向仍拒）、赋值前缀（`$x = ` / `x=`）与 `git` 前缀选项（`-C <dir>` / `--no-pager` / `-P` / `--paginate`）**剥离后**按剩余命令判定、未闭合引号 fail-closed；`node` / `pnpm` / `python -c` 等解释器命令仍判**执行类**（本意，非缺陷）；
- **C+ 档已撤销（难度档）**：难度枚举只有 `A|B|C`，不再出现「C+ 档」。装配面**与难度档解耦**：**三层批**（任一 task 声明 layer）建批必须传 `assembly`（2026-09-14 **扩面**，原为「exec 层 lane≥3」；缺则拒建批 `GATE_ROLE_ASSEMBLY_MISSING`），`auditLane` 必填且指向本批 audit 层 lane，**`managerPlan` 缺省 `raise`**（省略即建批即拉起 Manager；确需 Leader 直驱才显式写 `leader-direct`）。**收口告警已删（2026-09-22 用户裁定）**：原「声明 `raise` 而未登记 `batch.manager` → 落 `gate.manager_missing`」退役；未登记 Manager 的在册缺口由建批期 `gate.manager_roster_gap` 留痕。**声明 `leader-direct` 的批不再误报**（旧口径按 lane 数触发属语义矛盾）；
- **guard 门禁 1 收紧**：旧记录（有 `form` 无 `difficulty`）按**未评估**处理，须重评一次；
- **档位 × 工具面一致（G1，2026-09-14 用户裁决）**：`wave_plan` / `member_status` / `member_settle` **一律要求当前会话已写入 `difficulty: 'C'`**——未评估 / A / B 档调用分别拒 `GATE_BATCH_REQUIRES_C`（建批）与 `GATE_MEMBER_REQUIRES_C`（成员状态），实现 `lib/tools/core.js#assertMemberActionTierC`（调用点：`wave_plan` / `member_settle` / `member_status`）。**严格档**：未评估与 A/B 同罚。**收窄口径（2026-09-15 用户裁决 Q2=B：「成员仅会话，不可写状态」）**：**取消父档继承**——建批只认**本会话自己的 C 档**（worker / Manager 子会话一律建不了批；B 档仅承载单步独立任务，不入 `wave_plan`）；成员状态仅 **调用方会话自己 C 档（Leader）** 或 **该批已登记的 Manager 会话**（`batch.manager.agentId`，宿主口径 = continuable 的 `subagentId = childId = 会话 id`）可写；判据落**调用方**而非批归属会话 ⇒「worker 借 C 档批会话的 `session` 参数借道」亦被拒。口径：成员协作只有**一条轨道** = 评估 C → 建批 → 建批即拉起 Manager → 由 Manager/Leader 派发与结算；A/B 档 `subagent` 仅限「不占主上下文的调研」或「已明确上下文的单步派发」；
- **镜像只升不降（Q4=B，2026-09-15 用户裁决）**：`assign_check` 在「显式 `session` ≠ 执行会话」时把评估**镜像**到执行会话（guard 落点兼容）；**只升不降**——执行会话自身档位更强（rank `C > B > A`）时**跳过镜像**（`notice` 回显「镜像跳过」、不写 `mirroredTo`），保留执行会话自身的 `lastAssign` / `pendingBatch` 不动。动机（实测）：为写「他会话」夹具而调 `assign_check` 时，镜像会把 Leader 自己已记录的 C 档覆盖成夹具档位；等档/升档照常镜像。
- **建批即拉起（G2，2026-09-14 用户裁决 A：硬门禁前移）**：`assembly.managerPlan === 'raise'`（含缺省归一化的 raise）的批，**首个 exec 层 lane 派发前**必须已登记 `batch.manager`（`batch_phase({ batchId, manager: { agentId } })`），否则 entry 门禁拒派 `GATE_MANAGER_NOT_RAISED`（实现 `lib/state/gates.ts#checkEntryGate`）。边界：① 只拦 **exec** 层（plan 层设计/计划可先于拉起）；② 判定走 `reject()` ⇒ 继承 **G-1「空闲态不堵」**（lane 处于 `idle` = **空闲态**（非崩溃态，返工/续跑可调用）时降级为告警放行 + 留痕）；③ 显式 `leader-direct` 的批不受此门。与收口告警 `gate.manager_missing` **同源**（`managerPlan`）：一个事前拦、一个事后核；
- **guard 强制**：判 C 后未建批即调用执行型工具会被引擎拒绝；未评估或评估过期（20 次执行调用或 30 分钟）同样拒绝；只读查询不受限；
- **guard 窗口**：评估状态随执行调用计数与时间双过期；
- **资产归位**：判 C 前 Leader 已直做的探索/排障产物，可用 `asset_claim` 复制归位为批次资产（进入批次资产根），不返工。

难度门禁与调用级护栏串行叠加：内核判 ALLOW → 难度门禁照常生效；内核判 deny/ask → 难度门禁不再参与（不变量：难度门禁只可能「收紧」不可能被绕过）。

## 5. 生命周期

- **lane 条件**：建批静态声明（依赖产物/文件存在），派发前校验，不满足落 skipped；
- **archive 自动归档**：complete 后自动单向归档（产物打包保留可查，不可回滚）；
- **needHuman 人工挂起**：audit 产物声明 needHuman → lane 挂 review，Manager 转达人工裁决（merged/conflict），不新增成员态；
- **棘轮规则表**：状态迁移配置化（只许删不许增，allowRelax 逃生门默认关）；**生效时点 = 装配期**（`createStore({ rules: loadRules(config) })`，2026-09-15 接线）——**热更不应用**：`runtime.json` 的 `ratchet` 变更经热更守卫（`ratchetHotGuard`）**当场校验 + 告警「需重启生效」**（非法变更同样当场告警，但重启装配仍会 fail-closed 失败），不静默吞掉；
- **恢复机制**：checkpoint 保全 + 恢复审计 + **在途 lane 落 `idle`（空闲态）后可重派（返工/续跑）**（新 worker 可查 checkpoint 跳过已完成步骤）；失败 lane 为终态，重做 = 重开新批次（不自动续跑）。

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
| `assign_check` | 任务难度**主动写入**（`difficulty` A/B/C + `rationale` 判据，二者必填，无默认档）与执行主体（guard 门禁依据；`parallel`/`multiRole`/`gate`/`recoverable`/`needIsolation` 仅作交叉校验） |
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
| `lane_heartbeat` | lane 心跳查询/触发（watchdog 扫描，stalled 标记；lane 缺省 → 返回该批全部 running lane） |
| `lane_longrun` | lane 长跑超时重派探针查询/触发（longrun 档：runningSince/时长/无进展窗/候选状态；lane 缺省 → 返回该批全部 running lane；watch 与 longrun 子开关均开启时注册） |

无 Manager（或 Manager 缺席）批次的 watch 消费由 Leader 兜底承担：每次 worker 结算或确认空闲时，Leader 以 `mailbox_read(broadcast)` 查 longrun.candidate 广播，再以 `lane_longrun` 缺省全批查询核对探针态（candidate/emitted/reason）；命中候选按半自动重派处置——近窗有 checkpoint/活动则等待继续观察，确无进展则停轮重派或重开批次，处置存疑则上报用户裁决；批次拉起 Manager 后调度交还 Manager。

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
| 心跳/过期检测 | `capabilities.watch` | 开 | watchdog 定时器 + lane_heartbeat；退避档位追问 + 连续 N 拍无活动 → lane.stalled 标记（只标记不自动处置）；热更/重启对账生效面 5 键 = {`enabled`, `longrun.enabled`, `scanIntervalMinutes`, `longrun.maxDurationMs`, `longrun.noProgressWindowMs`}——长跑阈值可经治理配置页表单（分钟换算 ms）或 runtime.json 写入并生效 |
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

## 9. longrun 长程豁免与探针语义（Long-running Exemption and Probe Semantics）

> 本节覆盖 longrun 档（§6「心跳与过期检测」）的**豁免属性**、**扫描面边界**与**冷窗不变量**。**不在范围内**：裸 subagent 的探针、调用级护栏（见 [guardrails-hook.md](guardrails-hook.md)）。

### 9.1 豁免属性语义

豁免**由 Leader 在派发面附带**（`member_status` 的 `pending→running` / `idle→running`）：**成员不可自改**，**撤销须显式调用**（`revokeExempt` → `lane.exempt.revoked`）。语义是**阈值按倍率放宽**，不是关掉探针：

| 档 | 默认倍率 | 有效阈值 `effectiveMaxDurationMs` | 默认绝对窗（`maxDurationMs` 默认 20 min） |
|---|---|---|---|
| `none`（无豁免） | 4 | 20 min × 4 | 80 min |
| `dep-install` | 4 | 20 min × 4 | 80 min |
| `large-download` | 6 | 20 min × 6 | 120 min |
| `ai-render` | 8 | 20 min × 8 | 160 min |

- 豁免**只放宽时长阈值**（候选更晚出现），**不放宽 `noProgressWindowMs`**；
- `stalled` 联动：豁免 lane **同时豁免 stalled 追问**，但**豁免 lane 仍须写 checkpoint / 心跳**（供人工巡查与近窗判读）；
- 超时重派**仍然生效**（`n × multiplier` 之后照常判候选），**无进展判据仍是严格 AND**；
- 授予 / 撤销事件载荷类型一律写 `exemptType`；候选对象上另有一个 `exempt` 键承载豁免状态快照——**两键分属不同载荷**，勿混读。

### 9.2 扫描面边界与错误码

| 项 | 边界 |
|---|---|
| longrun 扫描面 | **仅 punky-preset 批次 lane**（`phase = running ∧ lane = running`），逐批逐 lane 判时长与进展 |
| 裸 subagent | **不含裸 subagent**——**不在扫描面内**（无 lane、无持久批状态、无事件/进度信号）——派给裸 subagent 即脱离 longrun 保护与 stalled 追问；故 C 类批次执行一律经 wavePlan lane（D-1，可检索锚点） |
| 僵尸批次（D-4） | 批次整体超 `staleBatchMs` 无活动（默认 24 h）→ **整批跳过**（防误杀长期归档批）；`staleBatchMs = 0` 为**显式关闭过滤**（写 `0` 才有逃生阀语义）——只作用于 longrun 档，不影响 stalled 面 |
| 未消费候选（D-2） | 候选 / 追问**须 ack 留痕**（`isAcked` 判据）；未 ack 超 `unconsumedTimeoutMs` → `lane.longrun.unconsumed` 事件 |
| 双投（D-3） | 候选同时投 broadcast 与 `supervisor/inbox`；两处 `ackId` 互相独立，**须各 ack 一次** |

### 9.3 重启冷窗（零增量 ≠ 失效）

**进程重启把在途 lane 落 `idle`（空闲态，非崩溃态）**；重派后 `runningSince` 重置 → 在 `maxDurationMs × multiplier` 窗口内**结构上不可能**产出 longrun 候选：

| 档 | 冷窗长度 |
|---|---|
| 默认 / `dep-install` / `none`（4×） | **80 min** |
| `large-download`（6×） | **120 min** |
| `ai-render`（8×） | **160 min** |

窗口内「零增量」**不得**读作探针失效——这是**结构上的不可能**，而非探针沉默；跨窗后才具备观测意义。

### 9.4 非 git 进度信号与诚实边界

- **扫描面收窄**：`<lane>/progress/` 子树 + `<lane>/*.md`；
- **进度快照**：每完成一个子步骤立刻落盘 `<lane>/progress/NN-<slug>.md`（含 `step N/total` 与产物落点，禁止攒批）——既保续跑（崩溃后新 worker 读快照跳过已完成步骤；**物理留存、不自动续跑**），也是探针在非 git 面上的**唯一进展信号**；成因：lane 在写代码 / 读代码期间不产事件、不落盘产物 → 探针与 liveness 判读**同时判无进展**，欠快照即被误判为停滞；
- **诚实边界**：**工具层无 caller identity**——引擎**不能判定调用者身份**，无法排除他人代劳 / 人工改文件；结构层强制仅限于「running 无 running/idle 后继」，起**记录与可见性**作用，**不构成访问控制**。

### 9.5 门禁错误码（豁免相关）

| 错误码 | 触发 |
|---|---|
| `GATE_EXEMPT_NOT_DISPATCH` | 非派发面带豁免参数（`to !== 'running'`），或带豁免但既非派发也非撤销 |
| `GATE_EXIT_MISSING_EXEC` | exec 层 outputs 未落盘即结算（§1.2 Exit 门禁，非豁免特性） |

