# 引擎统一设计面 · Leader 裁决稿（2026-09-18）

> **本稿性质**：Leader 终门禁裁决（消重 → 标冲突 → 核证据），输入 = `docs/engine-redesign-eval-20260918.md`（评估稿，453 行，sha `c69063277025042c`）。
> **本稿只写「更正 / 取舍 / 裁决」，不复制评估稿正文**；分类总表仍以评估稿 §4 为全量清单，本稿在其上改判。
> **行号口径** = **原始字节**（评估稿 §0）；凡本稿引用的行号均已用原始字节复核，未复核者标注「采信评估稿」。
> **复核状态字段**：`已核`（Leader 亲自读到字节）/ `采信`（未逐条复核，沿用评估稿证据）。

---

## §1 三项更正（复核后推翻 / 收紧评估稿）

### 1.1 T-01 降档：技术债（假判据） ⇒ **观测项（并入 T-04 决策组）**　【已核】

| 面 | 评估稿主张 | 复核结论 | 证据（原始字节） |
|---|---|---|---|
| 性质 | 「**静默**失效：返工上限永不及触发」 | **不成立**——引擎**自己登记**了该状态，并写明保留理由 | `lib/assembly/chain.js:787`「`chain.rework.max_attempts` 变成「**只对历史批有效**」的影子配置」；`:788-789`「仍保留代码（不删）的判据：删则静默丢掉 rework 语义（历史批的跨重启幂等 + M4 口径迁移都要用），与 `countReworkAttempts` …**同一口径、同一注记**」 |
| 写侧 | 白名单已删 `on.*` | **成立** | `lib/assembly/chain.js:123` `CHAIN_STEP_VIA = ['next','onFail','anyFailure']`；`lib/engine/chain-runner.js:34-35`（写侧白名单，不在册写 `null`） |
| 读侧 | 只认 `on.fail/on.conflict` | **成立，且为有意兼容读** | `lib/engine/chain-runner.js:403-404`「**匹配的是历史 `via` 取值族**…新写入面不再产生这些 `via` ⇒ 本计数**只对历史批非零**」；`:409` 判定行 |
| 现行行为 | 上限「不生效」 | **半成立**：pause 分支仍在，但**只可能被历史批触发** | `lib/assembly/chain.js:791-792`（`maxAttempts > 0 && reworkAttempts >= maxAttempts` ⇒ `pause`，reason `rework-max-attempts(n/m)`） |

**裁决**：T-01 **不是**「静默失效的假判据」，而是**登记在案、有注记、有保留理由的影子配置**。
⇒ 它**不具备独立可还性**：其唯一真判据是「链声明有无运行期消费者」（= T-04）。**移出技术债档，并入 G-T04 决策组**（§3）。
⇒ **不许**以「修 rework 计数」为名单独改 `countReworkAttempts`：该函数注释与 `chain.js:787-789` 是**同一口径的两端**，单改一端即造出注释与行为分叉（正是台账反复出现的债型）。

### 1.2 T-08 闭合：技术债（误导 + 无法验收） ⇒ **已闭合（仅余文字瑕疵）**　【已核】

评估稿引的三处「错文本」（`skills/engine-team/SKILL.md:71-72`、`:80-81`、`skills/design-team/SKILL.md:133`）**在当前字节上不成立**——系**台账转述**（N-2 / N-4），非现行文件。

| 扫描面 | 命中数 | 全部形态 | 结论 |
|---|---|---|---|
| `skills/**` | 8 处 | 一律 `<lane>/progress/NN-<slug>.md`（**lane 域**） | 无层域残留 |
| `presets/punky-preset/**` | 4 处 | `agent.cordis.yml:43` / `discipline.md:154`（并显式写「此处 `<lane>` = **lane id**（非层名）」）/ `:222` / `:381` | 无层域残留 |
| 逐条落点 | — | `engine-team/SKILL.md:71/72/184`、`design-team/SKILL.md:134/255`、`writing-team/SKILL.md:154`、`research-team/SKILL.md:117`、`acceptance-gate/SKILL.md:48` | 均已修 |

`discipline.md:383` 亦已把 W-13 记为「**写端落点与读端契约错位（写端错位）**，非读端缺失」——与 Leader 早前更正一致。
`progress_contract` 键已退役（声明即拒，`lib/assembly/team-asset.js:63/154`）。

**残余（不立技术债）**：① 历史批的层域快照读不到 ⇒ 评估稿 O-04（F-6b 双路读）已裁**不做**（误绿 + 跨 lane 串味）；② `presets/punky-preset/references/manager.md:101` 写 `progress/NN-<slug>.md` 缺 `<lane>/` 前缀——该文件为**冻结资产**（sha `646FED8DEA824A95`），仅文字面，随其解冻一并修。
⇒ **实施序「序 1 = T-08 文本统一」作废**（已完成），后续档位编号顺延。

### 1.3 T-04 确认并升为「组首」　【已核】

| 判据 | 读数 | 证据 |
|---|---|---|
| 链声明有无运行期消费者 | **无**（`expandChainBranches` 全仓仅定义 + 测试引用） | 定义 `lib/assembly/chain.js:812`；引用仅 `test/chain-v3-assembly.test.js:37`（导入）、`:101`（调用） |
| 真批是否系统性不一致 | **是** | 评估稿 §1.3 N-6：`cleanup-wave-20260918` 声明 3 exec 分支 + `pair_with:"exec"`，实批 **1 条聚合 audit lane**，`chain.step` 计数 0 |
| 建批期是否拦 | **不拦**（拦在运行期） | `lib/engine/chain-runner.js:247-251`（`no-lane-for-step`）/ `:259-266`（`no-paired-lane`） |
| 建批入口是否收链参数 | **不收** | `lib/wave-plan.js:734`（`buildWavePlan`） |

**同祖归并（Leader 归并结果）**：`T-04` + `T-01` + `T-05`（分支级 `cmd` 死声明，`chain.js:842` 只读步级）+ `Q-11`（链声明 lane 名不在批内 ⇒ 静默判链外，`chain.js:649-657`）+ `O-03`（分支级 `template` 回退）= **一个决策组 `G-T04`**。
⇒ **一次裁决，一揽子落地**；禁止拆成多条并行 lane（互为前提，拆则重复真源固化）。

---

## §2 X-11 裁决：**不阻断**（结论 + 反证 + 残余）　【已核】

评估稿将其列为「需一次真机探针，否则双轨是否真并存无法定论」。Leader 复核后**直接定案（不需探针即可定案的部分）**：

| 命题 | 核验结果 | 证据 |
|---|---|---|
| ① 官方 agent-team profile 层**在役** | **成立** | `C:\Users\Administrator\.dsh\profiles\web\package.json` → `dsh.profile.bundles` 末项 `@deepseek-ai/dsh-experimental-agent-team-profile`；依赖含 `-agent-team` / `-agent-team-profile` / `-tool-agent-team` 三者 `0.1.6-alpha.1` |
| ② 该层**禁用宿主 subagent 系工具插件** | **成立** | `…\dsh-experimental-agent-team-profile\cordis.patch.yml:4-14`（`tool-subagent-control` / `tool-subagent-list-agents` / `tool-subagent` / `tool-subagent-fork` 四行 `disabled: true`） |
| ③ 被禁的是**工具**，Subagent **服务**仍在 | **成立（官方自述）** | 同包 `README.zh.md:41`「Workflow 保留 base profile 的 `spawn` 提供方，**底层 Subagent 服务和两个提供方仍供 teammate 与 workflow 使用**」 |
| ④ 引擎自派依赖的是**服务**，非工具 | **成立** | `lib/index.js:86` `export const inject = ['tools','webServer','subagents']`；`:82-83` 注释（未声明 inject 即抛 `cannot get property "subagents" without inject`） |

**裁决**：⇒ 引擎自派（`lane_dispatch` → `ctx.subagents.startContinuable`）**在官方 profile 下照常可用**；「官方禁 subagent ⇒ 引擎自派在官方轨无对应物」的论断**改判**为：

> **轨道不同、载体共用**：引擎走**自建 FSM + 自建账本**（`member.*` 八态、`batch.handoffs`、lane 句柄），官方走 **roster + 任务板**；两条轨**并不同死**，代价是**双真源**（T-10 成员态 / T-11 拓扑 / T-12 通道 / T-07 回显位）。

**残余两项（登记，不阻断）**：

- **Q-12（新）**：本会话工具表仍含 `subagent` / `subagent_fork`（与 patch 意图不符；`profiles\web\cordis.patch.yml:220` 另把 `subagent` 列入 tool-folder `core` 目录）。⇒ 需**一次低成本探针**实证「在官方 profile 下该工具是否真可调」。**不影响本裁决**（引擎不依赖该工具）。
- 纪律面口径（**Leader 定，不需用户裁**）：**派发一律走 `lane_dispatch`**；禁止把「用 `subagent` 工具派 worker」写进任何任务包/纪律——该工具在官方 profile 下的可用性是**配置依赖**，不可作为契约。

---

## §3 过滤结果（裁决版三档）

> 判据沿用用户给定口径：**技术债** = 不还就静默失效 / 误导 / 无法验收 / 重复真源；**待增强备用方案** = 不做不影响正确性；**观测项** = 过程/纪律/未验证面。
> 「评估稿差异」列 = 本稿的改判（其余沿用评估稿 §4）。

### 档位 1 —— **真技术债（8 项，裁决保留）**

| # | 项 | 一眼判据 | 与评估稿差异 | 复核 |
|---|---|---|---|---|
| **D1** | **G-T04 链声明真源/消费者缺口**（T-04+T-01+T-05+Q-11+O-03） | 同一拓扑两处声明、无同步器；链声明零运行期消费者 | **组首**；T-01 由此组吸收（原独立技术债）；O-03 由此组吸收（原「单独立项」） | 已核 |
| **D2** | **T-03** `GATE_HANDOFF_MISSING` 门由 env 开关控制且不在既有读面 | 真批**两次**被暂停（需人工 resume）；同批行为取决于 `config/runtime.json` 一个键 | 无 | 采信 |
| **D3** | **T-02** `template.consume` 叙事双真源 | 校验器只收 `id/cmd/produce`，而资产/文本叙事暗示链上可声明 consume | 无（**不做字段**，只做口径澄清） | 采信 |
| **D4** | **T-07** `officialTaskId` 只有回显位、无写者无消费者 | 读端会以为「双写已成立」 | 无 | 采信 |
| **D5** | **T-12** `swarm_report`/`swarm_cc` 与官方 `send_message` 通道重复 | 台账 W-1：观察名单含**同名** `send_message` 且取 `args.subagent_id` ⇒ 官方调用误登记风险 | 无 | 采信 |
| **D6** | **T-06** `dispatch.provider` 注释与事实不符 | 注释称读热更快照，实测只能由插件 patch 静态配置 ⇒ 运维按注释改 `runtime.json` **不生效** | 无（保留双轨则**仍活**） | 采信 |
| **D7** | **T-05（组内同时）」分支级 `cmd` 死声明 | 写了不生效（当前无错，因展开器未接线） | 已并入 D1 | 已核（读侧定点） |
| **D8** | **T-09** `chain.step` 事件在 `leader-direct` 批恒不产生，读端仍当一等公民 | 27 批中 22 批该事件计数 0 | 无（**冻结新增 + 兼容读**，不删） | 采信 |

**⚠ 冻结（等 agent-team 定型，**现在不还**）**：T-10（八态 × roster 双真源）、T-11（`blockedBy` × `deps` 双真源）、T-13（`next`/`deps` 双轴无冲突校验）。
理由：三者都指向「**删一侧**」还是「**双写 + 检查点**」，取决于官方面接多深（评估稿 §6 已标）；今日动手 = 白还 + 可能造出第三份真源。

### 档位 2 —— **待增强备用方案（裁决保留 6 项）**

| # | 项 | 为什么只是增强 | 备注 |
|---|---|---|---|
| E1 | O-02 audit `consume` 覆盖校验（零新键） | 用校验替代声明键，不做亦无正确性损失 | 依赖 D3 口径 |
| E2 | O-05 并发闸自动排队（当前口径 = 直接拒） | fail-closed 已安全；排队只是体验 | 需用户裁「双轴 or 收敛」 |
| E3 | O-08 官方成员长跑监管探针 | 观测能力缺口，不改判定 | 等 agent-team 定型 |
| E4 | O-10 官方成员工具面收窄实证（W-6） | 不生效则「成员不碰治理工具」不变量失守 | **M-5，接官方前必做** |
| E5 | O-07 官方任务板双写（M-6 全量） | 今日「只写引擎黑板」正确 | 接官方后升「必须」 |
| E6 | O-09 难度门禁覆盖官方派发轨 | 现以 Leader 纪律兜（W-7 实测无挂点） | 挂点形态未知 |

### 档位 3 —— **不做（4 项）**

| # | 项 | 理由 |
|---|---|---|
| N1 | R-01 `expandChainBranches` 接线为建批来源 | 前置（D1 内的 T-05/T-04/M2′）全未满足；接线会把「双真源」固化为「单真源但语义未定」 |
| N2 | O-04 F-6b 双路读 | 误绿 + 跨 lane 串味（`lane-heartbeat.js:774-777`）；T-08 已闭合 ⇒ 更无理由 |
| N3 | O-01 `template.consume` 字段 | 逆「删 `criteria_from`」方向 + 造第二真源 |
| N4 | R-02 research-team 形态 / 面板治理配置页 | 用户已裁搁置 |

### 观测项（12 项，**保留但不占批**）

Q-01…Q-11 原样保留；**新增 Q-12**（官方 profile 下 `subagent` 工具可用性探针，§2）。**移除 T-08**（已闭合）。

---

## §4 落盘后的实施序（裁决版，替换评估稿 §6）

| 序 | 内容 | 前置 | 判据 |
|---|---|---|---|
| **0** | **用户裁决 `G-T04` 方向**（§5 Q-A） | — | — |
| **1** | D3/D4/D5/D6 诚实化整改（T-02 口径行 + `officialTaskId` 显式「未启用」+ `swarm_*` 与官方通道关系 + `dispatch.provider` 注释修正） | 无 | 零新声明键；`UNWIRED_DECLARATIONS` 仍 `[]`；全仓零改行为 |
| **2** | D2 handoff 门显式化（`handoffGate` 回显已存在 ⇒ 补「默认值 + 来源」读端文档，或把缺省改为 fail-closed） | 用户裁（如需改缺省） | 同批行为可预测、读端可见 |
| **3** | **longrun 工具改造批**（含 **U-2/U-5 行为面验证**：写 `<lane>/progress/` ⇒ `lastProgressTs` 非空 / `progressFresh:true` / 无候选） | T-08 已闭合 | 真批：写侧落盘 ⇒ 探针可见 |
| **4** | **M4**（策略迁批次级；含 D1 组内 T-01 的 rework 口径一并定） | 序 0 | 既有策略行为逐字不变；真实批可读出返工计数 ≥1（若选「接线」） |
| **5** | **M3**（推进改挂 `lane.handoff`） | M4 | 真批：交接成立即派；缺交接仍拒 `GATE_HANDOFF_MISSING` |
| **6** | **M2′**（`next` 双向链表 + 至少一头 + 矛盾报码） | 序 0 | 真删判据 ①②（`handoff-semantics §8.2 ④`） |
| **7** | **M5′**（`chain.step` 冻结新增 + 读端兼容） | CH-2（序 4）∧ CH-3（读端迁移） | CH-3 未做前不动 |
| **8** | gap-list §1.3–§1.8 剩余（Q-01/Q-02 观测项、文档漂移批 Q-06 **须错峰**） | — | 套件回绿 + `--check` 不下降 |

---

## §5 待裁决清单（用户）

### Q-A `G-T04`：链声明（`chain.steps/branches/pair_with/rework`）的**去向**　**（阻塞序 1–7 的最大一组）**

- **背景与触发**：链声明今日**无运行期消费者**（`expandChainBranches` 仅定义 `lib/assembly/chain.js:812` + 测试引用），而批的 lane 由 `wave_plan.tasks` 决定；真批已证两者系统性不一致（`cleanup-wave-20260918`：声明 3 exec 分支 + `pair_with:"exec"` ⇒ 实批 1 条聚合 audit lane）。连带 `chain.rework.max_attempts`（`chain.js:787-792`）与分支级 `cmd`（`:842`）成为「影子配置 / 死声明」。涉及：`lib/assembly/chain.js`、`lib/engine/chain-runner.js`、五队 `team-asset.yml`、`lib/wave-plan.js:734`。
- **选项与代价**：
  - **A. 接线**（`expandChainBranches` 成为建批来源）：代价 = 须同批修分支级 `cmd`/`produce` 回退 + 五队资产 + 反投影自证；风险 = 语义未定前接线会把双真源固化为单真源，且 `pair_with` 基数（1:1 按本批 lane 数）在多分支步只建部分 lane 时停轮 `no-paired-lane`。
  - **B. 只做一致性校验**（链声明保留为**声明意图**，建批期与 `tasks` 交叉校验、不一致即拒）：代价 = 新增一条建批门（可复用 `MISSING_FIELD` 或新码）；风险低，但仍留两处声明。
  - **C. 弃用链声明**（`chain.steps/branches/pair_with` 退役为**只读历史**，拓扑唯一真源 = `tasks.deps` + `handoffs`）：代价 = 五队资产须删链段 + `chainEchoOf`/`chainNextOf` 读端迁移；风险 = 丢掉「步级语义（join/onFail/rework）」这一层表达能力，M2′/M3 需重新定义语义落点。
- **推荐与理由**：**推荐 B**（先冻结语义、把「不一致」变成建批期可拒的事实），**待 agent-team 定型后再决定 A/C**——因为官方轨的拓扑真源是任务板 `blockedBy`（评估稿 T-11/M-2），A 会把引擎链声明固化成第二种官方无对应物的表达，C 则会丢掉 M3/M2′ 仍需要的步级语义。
- **影响面与可逆性**：B 可逆（删校验即回今日行为）；A 半可逆（资产已改，回退需重写五队链段）；C 不可逆面 = 历史批的链语义只余只读。**不改**：`lane_dispatch`、handoff 门、并发闸。
- **不裁决的后果**：序 1–7 全线阻塞（M4 的「策略迁到哪」、M2′/M5′ 的去留、T-01 口径均挂在此）；无时窗，但每拖一轮则 D1 组继续以「影子配置 + 死声明 + 静默停轮」形态带病运行。
- **落点**：本文件 §3 D1、评估稿 §3.1 同源组矩阵、`docs/gap-list-20260917.md §1.3 N-5/N-6`。

### Q-B `Rw-5`：并发闸（自建容量）与官方槽位（`maxMembers`）**是否收敛**　（**可延后，无时窗**）

- **背景**：今日刻意不同轴（`lib/engine/dispatch.js:196`；`gap-list §4` 记「后期迭代」）；切官方后「谁是真容量」无口径。选项：**留双轴**（代价 = 两处限流语义、故障时难判谁拒）/ **收敛为官方槽位**（代价 = 引擎侧并发闸退为投影，需实证官方槽位真拦）。
- **推荐**：**留双轴**至官方轨真接（M-5/O-10 实证后）再议——当前无官方成员在场，收敛无收益。
- **影响面/可逆性**：全可逆；不裁决不阻塞任何序。
- **默认值**：Leader 按「留双轴」执行，不另立动作（即今日行为不变）。

---

## §6 本稿对评估稿的净变化一览

| 变化 | 项 |
|---|---|
| **降档** | T-01 技术债 → 观测项（并入 D1） |
| **闭合** | T-08（文本面已修；序 1 作废） |
| **升组首** | T-04 → D1（吸收 T-01/T-05/Q-11/O-03） |
| **改判** | §5.1.1 D-1「官方轨无对应物」→「轨道不同、载体共用」（X-11 §2） |
| **新增** | Q-12（官方 profile 下 `subagent` 工具可用性探针） |
| **冻结不动** | T-10 / T-11 / T-13（等 agent-team 定型） |
| **实施序** | 序 1（T-08）删除，其余重排为 §4 |

---

## §7 用户裁决落实（2026-09-18，Q-A / Q-B）

| 裁决 | 用户口径 | 本稿的落实 |
|---|---|---|
| **Q-A = C** | 「弃用链声明；步级 Join 不需要，已有 audit 层内 Join 和 exec-audit 跨层 Join 实现；`onFail` 不涉及当前引擎语义；`rework` 使用 gap-list 表达」 | ① **`chain.steps/branches/pair_with/join/onFail/rework` 全部停止消费**；② 拓扑唯一真源 = `wavePlan.tasks[].deps` + `batch.handoffs`；③ 步级 join 语义由 `deps`（层内/跨层 Join）承担，不另造机制；④ `rework` 不进引擎：失败 lane 终态、重做=**重开新批**，返工诉求记 `gap-list`；⑤ **T-01 随之闭合**（影子配置随声明退役一并删除，不再需要「换计数口径」）；⑥ **M2′/M5′ 取消独立立项**（其语义载体=链声明本身）。 |
| **Q-B = 取消并发闸** | 「并发闸其实意义不大，反而会让运行高并发场景受限恶心」 | ① 移除运行期准入判定（`GATE_CONCURRENCY_EXCEEDED` / `gate.concurrency_blocked` / `concurrencyVerdictOf` 族）；② `batch.concurrency` **只作声明与回显、零判定**；③ 原 Q-B「双轴 or 收敛」议题**消失**（自建轴取消，官方 `maxMembers` 自然成为唯一槽位概念）；④ `concurrency-gate-20260917` 批的 19 例测试随之处置。 |

**对实施序的影响**：§4 序 4（M4）、序 6（M2′）、序 7（M5′）**合并进链退役批**——M4 的「迁到哪」由 Q-A=C 直接答定（迁到 `deps` + `handoffs`），M2′/M5′ 的语义载体退役后不再需要。

**本批（`engine-retire-chain-20260918`）**：plan(designer) → exec-engine-retire ∥ exec-honesty-cleanup → audit-acceptance；`managerPlan: leader-direct`（星型直驱，不拉起 Manager）；**硬边界** = 五队 `team-asset.yml` 的 `chain` 段由**另一会话**处置，本批禁改 `presets/**`，引擎侧**容忍不报错**（「声明即拒」待资产清空后再开）。

---

**裁决人**：Leader（本会话）　**落盘时间**：2026-09-18（§7 追加于用户裁决后）　**证据复核**：T-01/T-04/T-08/X-11 逐条原始字节；其余行标「采信」
