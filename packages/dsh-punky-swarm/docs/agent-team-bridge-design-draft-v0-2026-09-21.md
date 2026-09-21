# 任务黑板共用 · agent-team 桥接 · 初版设计稿 v0（2026-09-21，待对接）

**性质**：设计稿（未施工）。上游评估 = `_research/punky-blackboard-shared-agentteam-assessment-2026-09-21.md`（Q1–Q3 已裁结论本文直接继承）。
**裁定记录（2026-09-21 23:2x 用户拍板）**：① 结算工具定名 **`engine_team_settle`**；② **D-1…D-8 全部按 proposal 通过**（§8 逐行标注）；③ 追加调查项：**dispatch 脱离父会话缺陷根因未知，须查明**（设计稿 §4 只登记了现象，根因调查另立 `docs/dispatch-parent-session-loss-rca-2026-09-21.md`）。
**对接方式**：待裁项已全部闭合 ⇒ 按 §7 切批施工（B1 探针可先行）。

---

## 0. 设计理念（本稿所有取舍的判据，与引擎既有纪律一一对应）

| 理念 | 在本设计中的落点 |
|---|---|
| **门禁 > 互通** | 成员对官方板的**一切写操作经引擎包装工具**；直调 `team_task_update` 走 deny。互通是增益，治理是底线 |
| **真源唯一** | 治理真源 = 蟛蜞批次黑板（`wavePlan[].tasks[]` + `handoffs` + 事件流），**不改**；官方 `TeamTaskView` 只是**单向写镜像**，不参与任何判定 |
| **append-only + 双写入口** | 蟛蜞侧并发控制**维持**批级 `planRevision` + `addPoolTasks`/`addTaskEdges`，**不引入**逐任务 CAS（CAS 只用于镜像面） |
| **拒 = 零写入** | 结算门拒绝 ⇒ 黑板、镜像、事件流**均不变** |
| **禁静默 · 可辨降级** | 镜像失败落 `mirror.gap` 事件（不进拒绝路径）；未挂 agent-team 插件 ⇒ 四级降级为零感知（沿 `managerRosterOf` 既有模式） |
| **失败态必须存在** | 官方 4 态缺 `failed` ⇒ 失败面**不上官方板**，由蟛蜞事件流 + gap-list 承载（Onto「不得只有成功路径」佐证） |
| **不搬编排** | 官方 team / Jiuwen 出「编排 + durable 席位」，蟛蜞出「门禁 + 证据 + 护栏」；不在 DSH 侧重造一遍编排再补门禁 |

---

## 1. 总体形态（一张图）

```
                    ┌──────────────────────────────────────────┐
                    │           蟛蜞批次黑板（治理真源，不改）      │
                    │  wavePlan[].tasks[] · handoffs · 事件流    │
                    │  门禁 66 拒码 · deny/modeGate · 审计        │
                    └──────┬───────────────────────▲───────────┘
                 建批/图变更/结算通过          │            │
                    （单向写镜像）             │            │ 结算门通过后才 CAS
                    ┌────────────────────────▼───┐   ┌────┴─────────────┐
                    │  官方 TeamTaskView（镜像面）  │   │ engine_team_settle │
                    │  create/update/CAS·可见性    │   │ （T1 包装工具）     │
                    └────────────────────────────┘   └──────────────────┘
                              ▲                              ▲
                    durable teammate 可见/续会话/表意向      成员唯一结算通道
```

三句话（继承评估 §2）：**蟛蜞黑板 = 判定全在这里；官方板 = 让 durable 成员看得见、可跨会话续、可表意向；未挂插件 = 镜像面零感知**。

---

## 2. 契约面设计

### 2.1 字段映射（官方 TeamTaskView ← 蟛蜞黑板）

| TeamTaskView | 来源（蟛蜞） | 写时机 | 备注 |
|---|---|---|---|
| `id` | `team_task_create` 返回值 | 建批/图变更后 | 回填 `officialTaskId`（见 2.3） |
| `subject` | 任务五要素摘要（目标一句话） | 创建时 | 只在创建写，后续不改 |
| `description` | 任务包摘要 + **产物清单声明段**（T2） | 创建时 | 产物在场性校验**仍在蟛蜞门**，官方板只是可见性 |
| `status` | 状态映射（见 2.2） | 派发/结算时 | 见 D-1 |
| `ownerName` | Leader 派发时写 lane 名 | 派发后 | 成员侧意向回显见 D-2 |
| `blockedBy` | `deps` 的入边任务的 officialTaskId | 创建时 | 依赖镜像；上游未镜像 ⇒ 先占位后补（D-6） |
| `revision` | —（CAS 凭据，不落黑板） | 每次 update | 读-改-写失败重试一次，再败落 `mirror.gap`（D-7） |
| `writeScopes` | —（不映射） | — | 治理走蟛蜞 deny/modeGate（T5），映射无意义 |

### 2.2 状态映射（proposal，待裁 D-1）

| 蟛蜞 lanes 态 | 官方 status | 说明 |
|---|---|---|
| 池内（`owner==null`） | `pending` | 建批/追加任务即镜像 |
| `running` / `review` | `in_progress` | 派发（`lane_dispatch` 成功）后 CAS |
| `merged`（结算门通过） | `completed` | **唯一出口**：成员经 `engine_team_settle`，门过 ⇒ 引擎 CAS |
| `failed` / `conflict` | **不镜像** | 失败面留蟛蜞（事件流 + gap-list）；官方板保持 `in_progress` + Lead 收 `send_message` 通知 |
| `skipped` | `deleted`（proposal） | 从官方板可见面移除；或保留 in_progress + 通知，待裁 |
| `idle` | `in_progress` | 不额外翻动（idle 是投影态非终态） |

### 2.3 `officialTaskId` 落位（契约变更，待裁 D-4）

现状：`LaneHandoff.officialTaskId`（handoff 粒度，只读回显）。
本设计需要**任务粒度**镜像（池内任务在派发前就上官方板）⇒ proposal：

- `tasks[]` 任务对象**新增** `officialTaskId?: string | null`（归一化恒写，缺省 null，与 `owner` 同风格；**不参与任何判定**，注释沿用「不参与判定、写失败只落 mirror.gap」措辞）；
- `LaneHandoff.officialTaskId` **保留**（交接粒度回显不变，既有消费方零破坏）；
- 契约面登记：`contracts.ts` 两处注释同步改「只读回显」→「单向写镜像（写端 = mirror 模块）」。

---

## 3. 工具面设计（T0–T5 具体化）

### T0 · 会话桥只读探针（前置，无 lib 改动）

- **目的**：验证蟛蜞 worker（`startContinuable` 子会话）是否出现在官方 `listMembers` / `list_agents`、可否被 `send_message` 触达。agent-team profile 已 patch 掉 subagent-control（交接单 §7.2 登记未实测）。
- **做法**：隔离 home `teams-web`（已建）+ web profile 挂 agent-team 0.1.6 + punky 插件；跑最小批次（1 lane），探针只读：`ctx.get('agentTeams').listMembers(exec.agent)` 回显 worker agent 的在册性。
- **产出**：探针报告（三种结论之一：现成互通 / 需桥 / 不通）。**不通 ⇒ D-5 fallback**，其余各批全部暂停。

### T1 · `engine_team_settle`（结算门包装，P0）

```
engine_team_settle { batchId, lane, note? }     // 成员唯一结算通道
```

- 执行序：① 结算门全套判据（产物在场 presence / 交接契约 assertions / 验收章节 / TARGET 一致——**全部复用既有判据，不新造**）⇒ 拒 = **零写入**（黑板/镜像/事件流均不变，拒码沿用既有集合）；② 门过 ⇒ 蟛蜞侧 `member_settle` 同路径落账 + 官方板 CAS `completed`；③ CAS 失败 ⇒ 黑板已落、镜像落 `mirror.gap`（可辨，不阻塞）。
- 成员**禁止**直调 `team_task_update`（T5 deny，见下）。
- 上游参考：Jiuwen J2 验证闸（author 完成 → reviewer 验证 → completed）。

### T5 · 治理通道统一（与 T1 同批）

- `FROZEN_DENY` **追加**：成员会话 `team_task_update` / `team_task_create` / `team_task_delete`（如存在）——官方板写权收敛到 Leader（镜像模块）+ 包装工具。
- `FROZEN_MODE_GATED`：包装工具与镜像写端按 mode 门控（与既有工具族同规则）。
- ⚠ 连带族（快照 §5.4 纪律）：① 工具总数冻结数字断言（现 29 → 新增后同步全量普查）② AIP `TOOL_NAMES` ③ `CASES` 双向相等 ④ `pkg-hashes` + 基线重生成。

### T3 · 镜像写端（`lib/mirror/team-task-mirror.ts`，独立模块）

- **写时机**（三处，全部 Leader 侧、after-commit 同步写，D-7）：
  1. 建批（`buildWavePlan` 提交后）：为池内任务逐个 `team_task_create`（blockedBy ← deps 镜像）；
  2. 图变更（`addPoolTasks` / `addTaskEdges` 提交后）：增量 create / blockedBy 补写；
  3. 结算通过（T1 ②）：CAS `completed`；派发成功后 CAS `in_progress` + 写 `ownerName`。
- **失败语义**：任何一步失败 ⇒ 事件 `mirror.gap`（带 task id + 官方错误原文），**不进拒绝路径**（与 `LaneHandoff.officialTaskId` 注释既有语义一致）；`officialTaskId` 回填走**单次 `atomicWrite`**（只补字段，不触 `planRevision`——镜像不是图变更）。
- **降级**：`ctx.get('agentTeams')` 不可用 ⇒ 模块整体 no-op + 一次性 `mirror.degraded` 事件（四级可辨，沿 `managerRosterOf` 风格）。

### T2 · 产物契约（镜像面声明 + 蟛蜞面校验）

- 官方板 `description` 追加固定段 `【产物清单】`（来自任务 produce 声明）——**纯可见性**；
- 在场性校验**不搬家**：仍在蟛蜞结算门（真源 = `handoffs.artifacts` 逐个存在）。官方板上的清单与黑板不一致时**以黑板为准**（真源唯一）。

### T4 · 人工闸

- 映射：蟛蜞 `needhuman` 语义 ⇒ `send_message(target: 'lead')` + 事件流留痕；`wait_agent` 已能等 task 变化（官方原生）。
- 本批只做**通知面**，不做审批流（审批三态 APPROVE/REJECT/RETURN 借 Onto 语义，列 D-8 暂缓）。

---

## 4. 会话双轨：dispatch 缺陷的补法

| | dispatch（现役，保留） | durable teammate（新增 runner，待裁 D-3） |
|---|---|---|
| 生命周期 | lane 短生命周期 + 一次性句柄 + B3 label | `spawn_teammate` durable 信箱，跨会话续 |
| 父会话 | **缺陷现场**（丢失父上下文） | `context: 'fork'` 继承 Lead 已完成轮次 ⇒ **官方解法** |
| 本设计动作 | 不动 | 成员注册声明 `runner: 'subagent' \| 'teammate'`（assembly 声明面）；teammate 路径派发 = Lead `spawn_teammate` + 五要素任务包投递，结算同走 `engine_team_settle` |

**互补判断**：teammate 补会话连续性，蟛蜞补治理——两轨共用同一块黑板、同一套门禁，只是**席位形态**不同。T0 探针结论决定 teammate 路径的桥接成本。

---

## 5. 门禁语义汇总（新增/变更面）

| 项 | 规则 |
|---|---|
| 结算 | 成员只能经 `engine_team_settle`；直调官方 update = deny；门拒 = 零写入 |
| 派发 | 仍 Leader 单点（K1 不动）；官方板 `ownerName` 由 Leader 写，成员写 = 意向回显（D-2） |
| 图变更 | 只增不删两入口不变；官方板镜像跟随，**不反向**（官方板改动永不写回黑板） |
| 失败态 | 不上官方板；Lead 经 `send_message` + 事件流知情 |
| 镜像 | 单向、after-commit、可辨降级、失败不阻塞、不触 planRevision |

---

## 6. 验收判据（测试计划概要）

1. **镜像正确性**：建批 ⇒ 官方板 create 数 = 池内任务数；blockedBy 与 deps 同构；`officialTaskId` 回填且 `planRevision` 不变。
2. **结算门**：门拒 ⇒ 黑板/镜像/事件零变更（对齐 `batch-store.test.js:317` 既有断言风格）；门过 ⇒ 蟛蜞落账 + 官方 CAS completed。
3. **deny 面**：成员直调 `team_task_update` ⇒ FROZEN_DENY 命中；包装工具放行路径正向可过。
4. **降级**：无 agentTeams service ⇒ mirror no-op + 一次性 degraded 事件；黑板功能全绿（**不依赖官方板**）。
5. **镜像失败**：注入 CAS 失败 ⇒ `mirror.gap` 事件 + 黑板不受损。
6. **冻结数字**：工具总数 / `TOOL_NAMES` / `CASES` / `pkg-hashes` / 基线全量重生成。
7. **T0 探针报告**落 `_research/`（三种结论之一 + 证据）。

---

## 7. 施工切批（每批独立提交，lib 改动独立批）

| 批 | 内容 | lib 改动 | 前置 |
|---|---|---|---|
| **B1** | T0 只读探针 + 报告 | 无 | —（成本最低，先跑） |
| **B2** | T1+T5：`engine_team_settle` + deny/modeGate 收敛 + 冻结数字普查 | 有 | D-2 |
| **B3** | T3：镜像模块 + `officialTaskId` 任务粒度字段 + 契约注释升级 | 有 | D-1/D-4/D-6/D-7 |
| **B4** | T2 产物清单镜像 + T4 人工闸通知面 | 有 | B3 |
| **B5** | teammate runner 双轨（D-3 若裁「本批接」） | 有 | T0 结论 + D-3 |

---

## 8. 待裁项（✅ 2026-09-21 23:2x 用户拍板：**全部按 proposal 通过**）

| # | 议题 | Proposal（默认建议） | 裁定 |
|---|---|---|---|
| **D-1** | 失败/跳过态是否镜像 | `failed/conflict` 不上官方板；`skipped` → `deleted` | ✅ 按 proposal |
| **D-2** | 成员意向回显 | 本版**不做**（成员对官方板零写权，最简最稳；Lead 派发时已写 ownerName） | ✅ 按 proposal |
| **D-3** | teammate runner 双轨范围 | 本设计稿只做**桥接面**（B1–B4）；teammate 接入（B5）等 T0 结论后单独立稿 | ✅ 按 proposal |
| **D-4** | `officialTaskId` 任务粒度新字段 | 批准 `tasks[].officialTaskId` 新键（不参与判定，风格同 `owner`） | ✅ 按 proposal |
| **D-5** | T0 不通的 fallback | 维持 dispatch 现役 + 仅做 T1/T5 治理面（不依赖互通） | ✅ 按 proposal |
| **D-6** | blockedBy 上游未镜像 | 先占位创建、上游 officialTaskId 就绪后补写 | ✅ 按 proposal |
| **D-7** | 镜像写时机 | after-commit **同步**写（简单、可测、失败零阻塞） | ✅ 按 proposal |
| **D-8** | Lead 审批三态闸（APPROVE/REJECT/RETURN） | **暂缓**（T4 只做通知面）；登记到冻结项待引擎形态 | ✅ 按 proposal |

---

## 9. 明确不做（负空间，防蔓延）

- 不把官方板升级为真源 / 不引入 claim（K1）/ 不改 append-only 与双写入口纪律；
- 不搬 Jiuwen N-a 运行期改图、N-b 批内返工、N-c SQLite 真源、N-d OTel；
- 不做运行期编排（Onto 教训：声明有 ≠ 运行期有；本设计全部面都有明确运行期写端）；
- 不映射 `writeScopes`（治理走蟛蜞 deny/modeGate，双轨治理 = 双真源，禁）。
