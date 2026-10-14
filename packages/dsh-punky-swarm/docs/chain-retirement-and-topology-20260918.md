# 链声明退役后的拓扑口径 · 交接门缺省可见性 · 会话通道口径

- **批次**：`engine-retire-chain-20260918` ｜ **lane**：`exec-honesty-cleanup`（层 exec / 角色 coder）
- **上游裁决（硬前提）**：`docs/engine-design-adjudication-20260918.md`（Q-A=C 弃用链声明；Q-B 取消并发闸；本批硬边界 = 禁改 `presets/**`）
- **设计规格**：`plan/retire-spec.md`（本批 plan 层产物）
- **本文性质**：**读端口径文档**（叙事面/契约面），零行为改动；引擎实现见 `lib/**` 同名读端注释
- **证据**：`exec/honesty-cleanup.md` 的判据原始读数 + 探针 `readend-proof.json`

---

## 1. 拓扑真源（唯一口径）

**运行期 DAG 真源 = 批次 `wavePlan[].tasks[].deps`（入边声明） + `batch.handoffs`（逐边交接事实）。**

| 面 | 落点 | 语义 |
|---|---|---|
| 入边声明 | 批次 JSON 的 `wavePlan[].tasks[].deps` | 「这条 lane 依赖谁」——建批期一次写定，**建批后绝不中途重算** |
| 逐边交接事实 | 批次 JSON 顶层的 `batch.handoffs`（**新建批恒写**；存量批无本键 = 未必受门约束，回 `legacy:true`） | 「上游把产物交给了下游」——`handoff_submit` 写、`handoff_view` 读 |
| 判定单点 | `lib/state/gates.js` 的 `depsOf` → 每条入边一条 `handoffs[lane]` 记录 → `handoffRecordVerdict` | collection 语义：**每条** `deps` 入边都成立才算「入边齐」 |

**两条禁令**：

1. **不引入第三份真源**：`chain` 段退役后不再承担建批期展开（今日也已不承担），故不存在「链拓扑 vs `deps` 拓扑」的双写面。
2. **不从回显反推拓扑**：`batch_status.chain` 是**历史回显**（见 §2），任何消费方**不得**据它推导运行期可达性。

### 1.1 链声明退役的边界（今日仍在做什么）

- 五队资产（`presets/{engine,software,design,research,writing}-team/team-asset.yml`）**仍声明** `chain`（含 `steps`/`branches`/`pair_with`/`join`/`onFail`/`rework`）。
- 本批**禁改 `presets/**`** ⇒ 引擎侧取**容忍口径**：合法声明**不报错**、**无静默副作用**（不再驱动任何 lane / 相位 / 事件）。
- **「声明即拒」未开**：把 `chain` 追加进 `RETIRED_TOP_KEYS` 须待**资产面清零**（由另一会话书面回报）之后，否则会立刻打断既有建批。触发条件见 `plan/retire-spec.md` §3.3。

---

## 2. 链读端分类（冻结 / 删）

| 类别 | 口径 | 代表位 |
|---|---|---|
| **冻结 · 兼容读** | 代码保留、仅读历史/既有数据、**不新增写点、不参与任何运行期决策**；代码内标 `【冻结 · 兼容读 · 勿删】` + 一条保住理由 | `lib/assembly/chain.js` 的 `chainEchoOf`/`chainOfBatch`/`chainProblemsOf`；`lib/state/event-types.js` 的 `chain.step` 常量 |
| **删** | 只服务运行期决策的读端（随推进链退役一并失去唯一调用方） | `chainStepForLane`/`chainLanesOfStep`/`chainNextOf`/`perLaneTargetOf`/`pairedLaneOf`；`lib/engine/chain-runner.js` 的推进语义；`lib/engine/replay.js` 的链重放 |

**为什么「历史批」不能顺手删**：磁盘上 `chain.step` 事件**真实存在**（27 批中 5 批计数非 0），且 `via` 的历史取值族（`on.fail`/`on.conflict`）仍被读端兼容 ⇒ 凡「输入可能来自磁盘历史批」的读端一律**冻结**而非删。

### 2.1 `batch_status.chain` 的两处同源约束（硬）

- 工具面：`lib/tools/core.js` 的 `batch_status` 读端 —— `const chainView = chainEchoOf(b, chainOfBatch(b).chain)`。
- HTTP 面：`lib/api.js` 的 `batch_status` 读端 —— **同一实现**（`chainEchoOf + chainOfBatch`）。
- **两处必须逐字同源**：禁用「一删一留」、禁用只改单侧（单侧改动 = 两个读端口径分裂）。
- **字段名不改**（改名 = 破既有消费者）；**无 `chain` 声明 ⇒ 不写键**（与「字段存在但为空」是两种形态，审计须按**字段消失**判，不按字段为空判）。
- 工具描述今日**已**写明「`chain` 回显 = 建批期声明投影 + 历史 `chain.step` 事件（**不是**运行期真源）」⇒ 本项**零改动**，仅登记。

---

## 3. T-03：交接门的**缺省可见性**（`handoffGate` 回显口径）

**问题（技术债 T-03）**：`GATE_HANDOFF_MISSING` 入口/出口门的开关由 **env/配置**控制，曾有真批因此被暂停两次——同一批的行为取决于 `config/runtime.json` 的一个键，而该键**不在**批次读面 ⇒ 门禁缺席**不可见**。

**口径（读端可见性是硬要求：缺省关是策略，不得隐形）**：

| 项 | 规定 |
|---|---|
| 唯一解析点 | `lib/wave-plan.js#handoffGateStateOf`（薄封装 `handoffGateEnabledOf(liveConfig, stage)`） |
| 真源优先级（**逐段独立**） | 段级 runtime 键（`gates.handoff.entry` / `.settle`）> 段内 `gates.handoff.enabled` > env 兜底（`PSWARM_HANDOFF_GATE`）> **缺省关** |
| 逐段独立的理由 | 只写一段（如 `{handoff:{settle:true}}`）时，未显式声明的段**不连坐** env——否则会出现「写了 settle 却把 entry 交给环境变量」的静默半开面 |
| 读端回显 | `batch_status.handoffGate = { enabled, entry, settle, source }`；`entry`/`settle` 取值 `enforced｜observation`；`source ∈ runtime｜env｜default` |
| 回显纪律 | **只标注不改行为**；渲染面同样显示（缺省关必须看得见） |
| 环境变量约束 | `process.env.PSWARM_HANDOFF_GATE` **只允许出现在 `lib/wave-plan.js` 内**（`grep` 判据）；**禁两套读取** |

**实读样本**（探针原始 JSON 截取，未配置 runtime 键时）：

```json
"handoffGate": { "enabled": false, "entry": "observation", "settle": "observation", "source": "default" }
```

⇒ 读端可据此直接判定「本批的交接门是**观测态**（缺省关）还是**强制态**」，不必翻 `config/runtime.json`。

---

## 4. 会话通道口径（**唯一通道**，防双写与串味）

集群内部通信有**两条不相交的通道**，不是替代关系：

| 通道 | 工具 | 方向 | 落痕 | 用途 |
|---|---|---|---|---|
| **套件通道**（集群内部同步事件） | `swarm_report` | 成员 → **Leader** | 批事件 `swarm.report` + Leader 通道（broadcast） | `progress` / `blocked` / `settle-request` |
| | `swarm_cc` | 成员 → **Manager** | 批事件 `swarm.cc` + Manager 通道（`supervisor/inbox`） | `anomaly` / `decision-request` / `longrun-candidate` |
| **宿主通道**（agent 间消息） | 官方 `send_message` | 任意 agent → 其直接子/父 agent | **不落**批次事件、**不进** mailbox | 唤醒 / 转向子代理 |

**口径（写死）**：

1. **集群内部同步事件一律走套件工具**（`swarm_report`/`swarm_cc`），不再散落用通用通信工具——理由：套件工具**同一次**动作里完成 ①批次事件留痕 ②mailbox 投递 ③`settle-request` 触发自动结算（与主路 `subagent/end` 同一单点判定）；官方 `send_message` **三者皆无**。
2. **官方 `send_message` 不落治理面**：用它替代 `swarm_report` 会得到「消息到了、事件没了、结算没触发」的静默降级 ⇒ 明确禁止。
3. **命名面**：`swarm_report`/`swarm_cc` 是**本插件注册**的工具；官方 `send_message` 是**宿主注册**的工具。二者**名字不重叠**，唯一的名字重叠面在装配层**观察者**：`lib/bridge/dispatch-register.js` 的 `DEFAULT_DISPATCH_TOOLS = ['subagent','subagent_fork','send_message']` —— 它**观察**宿主工具（post-execute waterfall），**不注册、不覆盖**同名工具 ⇒ **不存在同名工具被本插件劫持**的风险（详见 §6 未决项 1 的如实登记）。
4. **身份解析是 best-effort**：`swarm_report`/`swarm_cc` 靠 `member.dispatch.workerSessionId` 反查 `{batchId, lane}`；**未绑定不再拒**（官方 Team 成员天然无 lane 绑定是常态）⇒ 消息照发、事件照留痕（能解析到批次才落事件），回显 `unbound`/`eventWritten`/`notice`。

---

## 5. 官方任务板双写（M-6）= **未启用**（如实登记）

- **事实**：本引擎**未接线**官方任务板——`lib/**` 无任何 `team_task_create` 调用点；宿主工具面**有**这些工具（`team_task_create` / `team_task_get` / `team_task_list` / `team_task_update`，可实调；`tools_search` 检索词「official task board team_task_create 官方任务板 双写」命中），**但引擎侧无消费点、无校验、无判定** ⇒ 不构成治理真源（**宿主有工具 ≠ 引擎已接线**；本行口径与 `lib/tools/core.js:1239` 的 `handoff_submit` 工具描述同源）。
- **因此**：`handoff_submit` 的 `officialTaskId` 参数是**调用方自填**的原样回填位（不填恒 `null`），引擎**不写、不校验、不据以判定**；`handoff_view` 逐边回显的 `officialTaskId` 同属该面。
- **读端纪律**：任何回显**不得**读作「已双写」。参数本身**保留**（删参数会破既有调用方与测试）。
- **字段落点**：`store.recordHandoff({..., officialTaskId})` 仅在调用方显式给出时写入（`lib/state/store.js`），默认 `null`。

---

## 6. 并发**声明**（零判定）的读端口径

- `concurrency` **保留为纯声明 + 回显、零判定**：字段名/类型/缺省（5）/落盘位/`batch_status` 回显/面板数字**全部不变**；引擎内**不再有任何**分支读取它做准入（Q-B 取消并发闸）。
- **读端不得读作「已限流」**：面板文案为「**并发声明（未启用限流）**」；`wave_plan.concurrency` 参数描述已改述为「并发**声明**（默认 5）；已不参与运行期准入」。
- 已移除的准入面（**不得回加**）：`lib/engine/dispatch.js` 的 `assertConcurrencyAdmit`/`concurrencyVerdictOf`/`concurrencyLimitOf`/`CONCURRENCY_EXCEEDED_CODE` 等，以及 `lib/tools/core.js` 内 `member_status(status='running')` 处的准入调用。
- 历史事件面 `gate.concurrency_blocked` 常量**冻结**（历史批磁盘仍有），仅不再有新写点。

---

## 7. 未决项 / 移交（不在本批闭合）

| # | 事项 | 现状 | 建议去向 |
|---|---|---|---|
| 1 | 派发登记观察者在宿主 0.1.6-alpha.1 上**整体失效**（静默） | `lib/bridge/dispatch-register.js` 的 `extractWorkerSessionId` 对 `send_message` 取 `args.subagent_id`，而宿主 `send_message` 的参数键是 **`agent_id`**；`subagent`/`subagent_fork` 在本宿主**不存在**（`tools_search` 检索词「subagent subagent_fork 派发子代理 continuable child」）。⇒ 提取恒 `null` ⇒ 早退不登记（**不是误登记**，是**漏登记**） | 新批（须带宿主契约摸底）：键名适配 + 反向断言；本批**不改行为**（改键名会破 `test/dispatch-register.test.js` 既有断言） |
| 2 | 面板 `assembly.chain` 标签仍以「链」叙事 | `lib/panel/batch-detail.js` 只在 `d.chain.steps` 非空时显示步骤名序列 | 新批：改为「链回显（历史）」文案（本批未列，避免越界） |
| 3 | `presets/punky-preset/references/discipline.md` 的链/拓扑口径 | 归另一会话（本批**禁改** `presets/**`） | 资产会话收口时同步 |
| 4 | `chain` 入 `RETIRED_TOP_KEYS`（声明即拒） | 待资产面清零 | 见 `plan/retire-spec.md` §3.3 四条件 |
