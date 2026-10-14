# B5 立稿 · teammate 席位通道（**设计定稿**）

> **权威性**：本文按用户 **2026-09-24 最新澄清与确认**（权威层级 ①）立稿——**凡与仓库旧文档冲突处，以本文为准**；
> 旧文档（`docs/agent-team-bridge-design-draft-v0-2026-09-21.md` §10–§13）降为**证据与基线**，其结论部分可被本文覆盖。
> **范围**：teammate 席位通道（team 通道）的设计——席位形态、写权、工具面、任务包、交接与结算、缺口与验证判据。
> **不做**：`provider:'agent-team'`（B 方向）**不作施工**——依据用户 **2026-09-25 裁决 C1「不做 provider 分离方案」**：`provider:'agent-team'` 分支方案**作废**（**引擎代调 `spawnTeammate` = 我方臆造**），**不做 provider 分离**。B 方向的**真实落地** = ① **指引重构**（两方向规格差异表 + 选型判据，见 §1a 与 `presets/punky-preset/references/discipline.md` §0p）② **agent-team 侧实操流程固化**。官方板镜像（C，已正式不做）。

---

## §1 定位：三通道分治（**不切换，并存**）

| 通道 | 适用任务 | 派发 | 黑板「执行者」锚点 | 现状 |
|---|---|---|---|---|
| **team**（本文） | **固定任务**（角色与流程可预见；software 口径 = **7 角色 + leader**） | Leader `spawn_teammate`（官方 roster） | **`roster` 成员名**（黑板引用） | **本文立稿** |
| **dispatch** | **需灵活分配的任务** | `lane_dispatch` → 引擎自派（`rt.start`） | `owner` + `member.dispatch{workerSessionId, lane}` | ✅ 在役，**本批不动** |
| **裸 subagent** | 简单 / 单步（B 档） | Leader `subagent` | 无（不进批） | ✅ 在役 |

- **硬口径**：**一个任务只走一条通道**；三通道**不互通**（含与裸 subagent）。
- ⚠ **否弃「切换」叙事**：旧稿「最终切换到 agent-team 模式」及其推出的"切换后 X 变多余"**已作废**；各通道各有其面。

---

## §1a 两方向规格差异表（2026-09-25 用户 C1 裁决）

> **权威来源**：用户 **2026-09-25 裁决 C1**（「**不做 provider 分离方案**」）；本表与 `presets/punky-preset/references/discipline.md` §0p 的「两方向规格差异表」**同源**，逐维口径一致。

| 维度 | **dispatch 方向** | **agent-team 方向** |
|---|---|---|
| **派发工具** | **只用 `subagent` 工具**（宿主 subagent seam；引擎侧 `lane_dispatch` → `rt.start`，`lib/engine/dispatch.js`） | **Leader 手工拉起成员**（`spawn_teammate`，官方 roster）——**非引擎代调** |
| **谁写黑板** | **Leader 写黑板**（`wave_plan` 建批 + `lane_dispatch` 派发；`member.dispatch` 由**引擎自动写**，是唯一写路径） | **Leader 拉起后写黑板通知成员**（写 lane 的 `roster` 引用；「通知」= 任务包投递，非邮箱推送） |
| **推进方式** | **引擎自动派发**（派发即写 `owner`；结算由 `auto-settle` 消费事件判定） | **由事件队列进行交接**（`handoff_submit` → `batch.handoffs` + `lane.handoff`；入边 `submitted` 为下游开工硬前提） |
| **共用面** | **只共用 `wave_plan` 黑板的模式**（Q-3） | 同左（**不做**第二套建批面） |
| **写黑板字段** | `owner`（批 owner 会话，公共池归属声明）+ `member.dispatch{ workerSessionId, lane }`（引擎自动写） | **`roster` 成员名**（= R-3 已落字段；真源恒 `wavePlan.tasks[].roster`）；与 `owner` 并存互不替代（Q-2） |
| **选型判据** | 需**灵活分配、较轻量**的工作（迭代频繁、粒度细、无跨轮续跑需求） | **固定工作**（角色与流程可预见；需 durable 席位 / 跨轮续跑 / 长任务） |
| **provider 分离** | **不做**（C1 正式裁决） | **不做** —— `provider:'agent-team'` 分支方案**作废** |
| **选型主体** | **Leader 自行判断** | 同左 |
| **语义 / 功能** | **相互隔离**（含与 B 档裸 subagent 不互通） | **相互隔离** |
| **不混用** | **一批一方向**（一批只走一条方向，Q-4） | 同左 |

**Leader 选型判据（可直接抄入 §0p，Q-4 落地形态）**：

1. 任务是否**固定可预见**（角色/流程定死、有官方 roster 对应成员类型）⇒ **是则 team**；
2. 是否需要 **durable 席位**（跨轮续跑、可再唤起、活性可查）⇒ **是则 team**；
3. 是否需**灵活分配、粒度细、较轻量**、一次性执行即可 ⇒ **则 dispatch（`subagent`）**；
4. 判不准时按 Q-3 先建 `wave_plan` 批，**批级**声明 `channel`（`dispatch` | `team`），**一批不改向**。

---

## §2 席位形态（**分离式**）

| 项 | 口径 | 依据 |
|---|---|---|
| 拉起 | **Leader `spawn_teammate`** | §12.2 |
| 上下文 | **无 fork、无父会话记忆**；上下文**全来自黑板任务包 + 工具读取** | §11.2（**升格为设计原则**）|
| 交接 | **只经黑板**（`handoff_submit` / `handoff_view`） | §11.2 |
| 探针 | **无需**——原生工具即 Leader↔teammate 可达性 | §12.2 |
| 生命周期 | **durable**（跨轮存活、可再唤起、活性可查 `list_agents`） | 官方 roster 独有优势 |

**成员命名**：**Leader 拉起时定，拉起后即固定**（不再改名 / 重绑）。
**池化**：**= 同类型角色的多实例池**——roster **绑成员类型**（`coder` / `tester` …）；同类型**可拉起多个成员**，**各承接不同 lane**；上限 **`maxMembers`（默认 16，超限码 `TEAM_MEMBER_LIMIT`，实测见 §9）**；分配由 **Leader 按合理吞吐自觉**决定（自动化后续优化）。

---

## §3 写权模型（两层）

| 层 | 判据 | 状态 |
|---|---|---|
| **Layer 1** | 调用方限**该批 owner** 或**该批已登记 Manager**（"谁能碰这个批"） | ✅ 在役 |
| **Layer 2** | **角色 / lane 粒度**：只写"**属于自己的待交接内容**"（"能碰批的人能改哪条边"） | ❌ **未接线**（R-1） |

**Layer 2 的两通道写法（不共用）**：

| 通道 | 执行者标识 | 校验路径 |
|---|---|---|
| **dispatch** | `workerSessionId` | 查 `member.dispatch` ⇒ 得 lane ⇒ 仅准写该 lane |
| **team** | **roster 成员名** | 查"**哪些 lane 的 `roster` = 我**" ⇒ 仅准写这些 lane（池化时天然覆盖其承担的多条 lane） |
| Leader | 批 owner | 全批（含代提交入边） |

**共同语义**（用户 Q-2 口径）：**角色只写属于自己的待交接内容**。

---

## §4 席位工具面（**白名单**，Q-5）

| 类别 | 工具 | 理由 |
|---|---|---|
| **保留** | `handoff_submit` / `handoff_view` / `task_pool` / `swarm_report` / `send_message` / `member_settle` | 交接必需 + 回报 + 结算 |
| **不开放**（Leader 治理面） | `wave_plan` / `batch_phase` / `batch_control` / `lane_dispatch` / `lane_claim` / `lane_release` / `asset_claim` / `task_update` / `batch_tasks_add` / `assign_check` | 控制权归 Leader（S2 语义） |

**实测背景**：teammate 席位当前**完全开放 22/22**（含上述治理写面），而 dispatch worker 被 deny **19 件** ⇒ **两轨不对称**是本节动因。
**注入机制待设计**：teammate **不经 `buildStartRequest`**（§13 边界）⇒ deny 的唯一注入点不适用，需另找注入面（R-4 的核心难点）。

---

## §5 席位任务包（**必须携带**）

| 字段 | 值 | 说明 |
|---|---|---|
| **`batchId`** | 批次 ID | **查阅入口一律用 `batchId`**（不新造按 taskId/sig 反查的入口） |
| **`sig`** | 本 lane 的**任务包指纹** | `sha256(canonicalJSON({id,layer,role,deps,produce,outputs,cmd}))[:16]`；**用于身份识别与对账，不作查找键** |
| **`session`** | **批次归属会话键** | ⚠ **必带**（否则回落席位自身会话 ⇒ `batch not found`）；取值 = Leader 会话 ID **或**该批的命名黑板键 |

**⚠ 关于 `session` 的实测结论（UX-1，2026-09-24 闭合）**：

- **命名黑板键**（`<task>-<date>` 抽象占位）对 **teammate 席位**实测 **4/4 通**（`batch_status` / `task_pool` / `handoff_view` / `log_export`）；
- 但该键**严格等于「批次归属 session 键」**，**不是共享命名空间**——用命名黑板键去读**别的**批 ⇒ `batch not found`（对照已证）；
- ⇒ **席位形态不影响可达性，键才是决定项**；**每个批各自一个键**，派席位时**注入该批的键**。

---

## §6 交接与结算

| 项 | 口径 |
|---|---|
| **交接** | 成员用 `handoff_submit`（`from` = 自己所属 lane）；入边 `submitted` 是下游开工**硬前提**（`GATE_HANDOFF_MISSING`） |
| **时序** | **⚠ 先 `handoff_submit`，后 `swarm_report`** —— 反序会触发 `GATE_HANDOFF_MISSING` 并**停轮**（**已三次独立踩坑实证**） |
| **结算** | **走 in役 `member_settle`**（不新造工具） |
| **⚠ audit 层** | **audit 层 lane 不走 `auto-settle`**（`isAuditLayerLane`，明写"**职责转移，不是失败**"）⇒ **须 Leader 显式** `member_status(review)` → `member_settle(merged)`，**且结算前先 `handoff_submit` 到其下游** |
| **回报** | 成员通知 Lead 用 `swarm_report`（落事件 + mailbox）**或** `send_message`（**真推送**，S-3 已放开成员唤 Lead）；**轮询机制后建** |

---

## §7 与既裁的不冲突自查

| 既裁 | 本文 | 关系 |
|---|---|---|
| §11.2 成员会话与父会话分离，交接只经黑板 | §2 | ✅ 一致 |
| §11.3 无镜像面 / 官方板不进真源 | §1（三通道） | ✅ 一致 |
| §11.4 结算走在役 `member_settle` | §6 | ✅ 一致 |
| §12.2 无探针 | §2 | ✅ 一致（且已实测） |
| §12.4「deny 是否延伸到 teammate」 | **§4 改为正面白名单**（方向反转：不是"延伸 deny"而是"**要不要设防**"） | ⚠ **修正**（用户 Q-5 口径） |
| §13 deny 只作用 dispatch 通道 | §4 承认该边界，**并指出 teammate 侧缺注入点**（R-4 难点） | ✅ 一致 + 补充 |
| A 方案（官方管人、蟛蜞管活） | 全文 | ✅ 一致（本文即其**席位形态落地**） |
| Q-6（入口 batchId、sig 为指纹） | §5 | ✅ 一致 |
| U-2（maxMembers 8–16） | §2（**实测默认 16**） | ✅ 一致（命中上限） |
| **C1 两方向规格（2026-09-25）** | **§1a** | ⚠ **更正**（`provider:'agent-team'` 分支方案**作废**；两方向表见 §1a，同源 §0p） |

---

## §8 未接线缺口与后续批（P4 输入）

| # | 缺口 | 判据 | 归属 |
|---|---|---|---|
| **R-1** | `handoff_submit` **无写权校验**（非 owner/Manager 亦可写） | 越权写入被拒且零写入 + 测试锁 | P4 |
| **R-2** | `handoff_submit` **覆盖式**（同边重交静默覆盖 assertions） | 覆盖需显式声明 + 旧值留痕 | P4 |
| **R-3** | **`roster` 承载字段**缺失（lane ← roster 成员名） | 支持同类型多成员、一成员多 lane | P4 |
| **R-4** | **席位工具面收窄** —— ⚠ **用户 2026-09-25 裁决：「先不动收窄，暂时搁置，或者用 `lib/governance/` 实现」⇒ 搁置，但路径已定**。**探针已完成（三层事实）**：① 官方席位通道**无收窄参数**（`spawn_teammate` 仅 `name`/`description`/`prompt`/`context`；`roster.spawnAdmitted` 建会话只传 `{childId, provider, label, request:{prompt,parent}, signal}`）；② profile 层**无配置面**（`dsh-experimental-agent-team-profile/lib/index.js` 仅 **11 B**，全包零工具/权限键）；③ ⇒ **硬收窄**（工具不出现在席位 schema）**当前不可行**；**软收窄**（调用被 DENY）**可行**且**零宿主改造**——用 onto 既有钩子：`lib/governance/wiring.js:19`「订阅 `tools/pre-execute`（**deny→Error**）」+ `classify.js` 6 原语裁决（fail-closed）。**⇒ 已定路径**：在 `lib/governance/` 规则面加一条「**调用方是 roster 席位成员 ∧ 目标工具 ∈ Leader 治理面 ⇒ DENY**」（需配套 roster 名 → 席位身份解析）。 | 席位侧治理工具**调用被拒**（工具名仍可见） | **搁置（路径已定）** |
| **R-5** | **通道归属声明**缺失（批级需标明走 team / dispatch） | 混用被拒或显式告警 | P4 |
| **搁置** | `mailbox_read` 假阴性（F-1）+ `batch_status` 静默面（F-5） | 用户 Q-4：与 longrun 一同搁置 | 登记 |
| **后续** | `provider:'agent-team'`（B 方向）**作废**——**引擎代调 `spawnTeammate` = 我方臆造，C1 正式作废**；轮询机制（U-3）**原样保留** | — | **仅轮询机制（U-3）** |

---

## §9 验证判据（V 系）

| # | 判据 |
|---|---|
| **V1** | teammate 席位由 Leader `spawn_teammate` 真实拉起，`list_agents` 可查活性 |
| **V2** | 任务与交接**全走蟛蜞黑板**；官方 `team_task_*` 在 `lib/**` 内**零调用点**（限定量词） |
| **V3** | 结算**走 `member_settle`**，门禁判据链复用不新造 |
| **V4** | 上下文**只来自黑板任务包 + 工具读取**（无 fork 继承） |
| **V5** | `dispatch` 通道**零回归**（既有链路逐字不变） |
| **V6** | 三通道**共存不冲突**（任务分配不共用） |
| **V7** | 席位工具面白名单生效（治理工具**不可见**） |
| **V8** | Layer 2 写权生效（越权写入被拒 + 零写入） |
| **V9** | 两方向**不混用**——批级 `channel` ∈ {`dispatch`,`team`} 时，lane 的 `roster` 分布**与声明一致**（`dispatch` ⇒ **零条** lane 有 roster；`team` ⇒ **每条** lane 有 roster） |

---

## §10 实测证据索引（本文所有关键读数的来源）

| 项 | 读数 | 来源 |
|---|---|---|
| teammate 工具面 | **22/22 在场**，0 `unknown tool`；8 件实调有真实返回 | `reports/onto-teammate-seat-probe-20260924.md` |
| 数据面（teammate） | 无 session ⇒ `batch not found`；带 Leader session ⇒ 四项全通 | 同上 |
| 命名黑板（subagent 席位） | 实验组 4/4 通；对照组 `batch not found`（**C4 单变量对照**） | 批 C `audit/probe-acceptance.md` |
| 命名黑板 × teammate（交叉） | **A 组 4/4 通**；B 组证否"共享命名空间" | 本轮 teammate 第三组回报 |
| `maxMembers` | **默认 16**；`TEAM_MEMBER_LIMIT` | `dsh-experimental-agent-team/lib/types/{index,roster}.js` |
| 五项缺口（F-1…F-5） | 见各条 | `onto-teammate-seat-probe` + `onto-swarm-report-push-solution` |
| `subagent_report` | **内核 276 包全扫 = 0 命中**（确认不存在） | `reports/onto-subagent-report-investigation-20260924.md` |
