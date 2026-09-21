# 已实施内容清单 · 2026-09-21

- 对象仓：`D:\dsh\Punky-plugin-onto\packages\dsh-punky-swarm`
- 用途：**「已经做完的事」的唯一台账**。新规划/新施工前先查本文件，避免重复立项；本清单之外的新动作才需要新编号
- 标注口径：**【实测】** = 现场核读/命令取证；**【登记】** = 既有文档自述，未逐条回溯 commit
- ⚠ 本清单**只记已落地**。已裁但未施工的（如 K3 去返工边）**不在此列**，见 `docs/new-engine-blueprint-2026-09-21.md §7`

---

## §0 引擎改装现状摘要（2026-09-21 20:5x，生成时 HEAD `4f6d60f`）

| 轴 | 现状 |
|---|---|
| **波次** | R1 契约加固 → R2 清理波 → R3g 门禁断言波 → A1–A4 裁定 → K1–K4 裁定 → N0.5 去返工边（+恢复路径族收尾）→ **N1-R4-1a/1b/1c/2 公共池与图变更**（当前） |
| **形态** | 池 = `owner == null` 的**视图**（不是容器）；派发 = 唯一出池动作（Leader 单点，不引入 claim）；图变更 = **两个显式写入口**（`store.addPoolTasks` 追加任务 / `store.addTaskEdges` 加边），均单次 `atomicWrite`；不成环靠**结构性保证**（`deps` 只许指向已声明在先 + 同层或上游），不做禁止性断言 |
| **门禁** | 拒码集合 **66 零增删**；无断言项 2（刻意不补）；套件工具 **32**；deny **16**；modeGate **12** |
| **测试** | 1757 tests / 1735 pass / **18 fail 全为环境类 git 回归**（`invalid reference: punky/orch`，根因未定性）⇒ 非环境类 **0**；基线 **148/1714/8351** |
| **可达性审计** | 已落成工序（扫描器 + 口径 + 判读台账），判读覆盖 **119/119**；真守卫 85 条中**无④**；④ 实际只有成环检查一项（已删） |
| **夹具审计** | 已落成工序（`scripts/audit/fixtures.mjs` + `docs/fixture-audit-2026-09-21.md`，与可达性审计同族第二条）：**④死夹具 = 0** · ②空壳 = 技能桩 **33/43** + 自建团队资产 31 文件 · ③重复 = **35 个同名函数 / 156 对高相似**。⇒ **F1 ✅ 已落地**（技能空壳显式化：`HOST_ONLY_SKILLS` 27 名 + 4 条双向断言 + 10 处显式声明；施工中即抓到 **2 个未登记自造名**）；**F2–F5 待开工** |

### task_* 工具计划（当前与后续）

| 工具 | 状态 | 计划 |
|---|---|---|
| `task_pool` | ✅ 已落地（R4-1a） | 无后续改动；随池语义扩展回显 |
| `batch_tasks_add` | ✅ 已落地（R4-1c） | 追加期已启用 `deps` 结构约束；**建批期是否同口径启用仍待裁**（撞 `writing-team-asset` 真实反例：exec 依赖下游 audit，见 §5） |
| `task_update` | ✅ **已落地**（R4-2） | 池内任务**加边**（只增不删）；触 handoffs 补条 + 出口门自动感知（数据源本就是落盘 `wavePlan`）⇒ **无遗留** |
| `task_split` | ❌ **已舍弃** | 无「拆父任务」语义（plan 层摸底/拆分本身即独立任务） |
| （后续候选）`batch_tasks_*` | 未排 | 若需要「池内作废/替换」，按 K1 走「作废 + 池内新增替代 + gap-list 留痕」，不改 `owner` |

### 当前待裁（2 项）
1. **B1 收尾**：`deps` 结构约束**追加期已启用**、**建批期停用**（撞 `writing-team-asset.test.js` 的 exec→audit 真实反例）⇒ 三选一未裁：① 改判该用例 ② 只用于追加期 ③ 层序降为告警。
2. **`assets.js` 纵深防御**：判读更正为**非冗余**，保留（如需删，请先给「不可达」的实证）。

> 已闭合：退役码注释**已字面删除**（12 文件 29 行，保留 5 处防回生断言）。

## §1 代码面（commit 级）

| # | 落地项 | commit / 时间 | 核验 |
|---|---|---|---|
| 1 | **R1 契约加固**：`vocabulary.json` + 元素级契约 + pending marker | `e3e8cd0`（09-20 14:09），tag `r1-done-20260920` | 【实测】`lib/state/vocabulary.json` 565B 在盘 |
| 2 | **链声明退役**（Q-A = C）：拓扑真源 = `wavePlan.tasks[].deps` + `batch.handoffs`；步级 join 由 `deps` 承担；`rework` 不进引擎 | adjudication §7 | 【实测】`lib/assembly/chain.js:833 expandChainBranches` 仅剩定义、零生产消费；读端 `chainEchoOf`（`:918`）保留兼容 |
| 3 | **并发闸取消**（Q-B）：`assertConcurrencyAdmit` / `concurrencyVerdictOf` / `CONCURRENCY_EXCEEDED_CODE` 删除；`GATE_CONCURRENCY_EXCEEDED` 出 union | adjudication §7 | 【实测】`lib/engine/dispatch.js:179-185 / :217` 删除留痕注释在案；`concurrency` 仅存声明与回显 |
| 4 | **R2 清理波**：`.wip-backup/` 删；B1 删 8 / 冻 10；B2 收敛 122；`scripts/audit/` 生成器链；冻结台账 | `17b6b97 … c761cd1`（09-21 01:07–01:34） | 【实测】`.wip-backup` 已不存在；`scripts/audit/` = `dead-code2 / classify / gates / gen-register / plan-lists / strength` |
| 5 | **R3g 门禁断言波**（纯增量，`lib/**` 零 diff）：无断言拒码 9 → **2**；拒码集合 66 → 66 零增删；真 E2E（loader 钩子 + 负向对照）；断言强度台账 | `fda041a … a944759`（09-21 02:16–04:05） | 【实测】1729 tests / 1725 pass / **0 fail** / 4 todo（连续两轮稳定） |
| 6 | **N0.5 去返工边**（K3）：`schema.MEMBER_TRANSITIONS.review` 删 `running`（`schema.ts:41` + 产物 `.js:26`/`.d.ts:10`，走 `npm run build`）；返工能力族断言**反向改判**（`machine.test.js:46` / `rework.test.js` 3 例 / `gate-techdebt-red` R-21）；基线 8245 → **8248** | `5642d3b`（09-21 11:3x） | 【实测】`git diff --stat -- lib` 仅 schema 三件套 |
| 11 | **N1-R4-2 池内加边**（`task_update`）：`store.addTaskEdges`（只增不删；单次 `atomicWrite`：wavePlan 重归一化 + handoffs 补 `pending` 条 + `plan.mutated.edges` + `planRevision+1`）+ 新工具 **`task_update`**（入 deny + 模式门）+ 结构性保证（已声明在先 + 同层或上游）+ 新增两条语义边界（上游已结算 ⇒ 拒 / 存量批 ⇒ 拒）；连带 套件 31→32、工具数 28→29、deny 15→16、modeGate 11→12 | 本批（09-21 20:3x） | 【实测】`task-pool-r41` **24/24**；全量 **1753 / 1731 / 18 fail 全为环境类** ⇒ 非环境类 0；基线 147/1710/**8341** |
| 10 | **N1-R4-1c 池内追加任务**（图变更写入口）：`store.addPoolTasks`（单次 atomicWrite：wavePlan 重归一化 + lanes 播种 + handoffs 播种 + `plan.mutated` 留痕 + `planRevision+1`）+ 新工具 **`batch_tasks_add`**（入 deny + 模式门）；⚠ 不成环改为**结构性保证**（承 R4-1d：不建成环断言）；判据与建批期**同源**（`buildWavePlan` + `topoWaves`）；只增不改；**不新建拒码**（非法输入抛普通 Error，批终态复用 `GATE_BATCH_TERMINAL`） | `01707aa`（09-21 13:5x） | 【实测】`task-pool-r41.test.js` **14/14**（含反例：追加 exec 无 audit ⇒ 被 `three-tier` 校验拒）；套件 30→31、工具数 27→28、deny 14→**15**、modeGate 10→**11**；全量 1743 / 1720 pass / **19 fail（18 环境 + 1 偶发，单跑 26/26 为绿）** ⇒ 非环境类 0；基线 147/1700/**8303** |
| 9 | **N1-R4-1b 派发 = 唯一出池动作**（`owner` 写入方闭环）：`store.setMember` 第 7 参 `owner`（可选项）+ `EVT_TASK_OWNER_ASSIGNED` 出池留痕 + 派发面调用点（`core.js member_status` / `dispatch.js:221`）；**非改派**（已出池不覆盖）；fail-open 边界（取不到 Agent 标识 ⇒ 零写入） | `2c5e87e`（09-21 13:3x） | 【实测】`task-pool-r41.test.js` **9/9**；全量 1738 / 1716 pass / **18 fail 全为环境类** ⇒ **非环境类 0**；基线 147/1695/**8291** |
| 8 | **N1-R4-1a 公共池只读地基**：`WavePlanTask.owner`（可选声明面，缺省 `null` = 在池内）+ `wave-plan.ts` 归一化 + 新增 **`task_pool`** 只读工具（池 = `owner==null` 的**视图**，不引入 claim）+ 注册表 29→30；判据 = 上游 `deps` 全终态 ∧ lane 仍 `pending`，否则 `blockers[]` 指名 | 本批（09-21 12:5x） | 【实测】新测试 `task-pool-r41.test.js` **6/6**；`suite-consistency`+`wave-plan`+`batch-store` **52/52**；基线 147/1692/**8281**；`pkg-hashes` 370→398。⚠ **`owner` 尚无写入方**（见下） |
| 7 | **N0.5 收尾 · 恢复路径族闭合**：`dispatch.js:287` 派发失败回滚目标 `review` → **`failed`**（`running→failed`，**零新增边**）+ 提示改「不可原地重派 ⇒ 恢复 = gap-list + 新批次」；**否决**「门禁拒置 failed」（撞既有纪律「门禁拒 = 零写入」，`batch-store.test.js:317` 明断言）；改判 5 例（`gates` Exit Gate audit / O2 T8 · `governance` A3 · `outcome-typing` C5-4 · `dispatch-failure-rollback` DR-2 · `suite-consistency` SC-3）；`attempt` 登记为**能力已移除**；基线 8248 → **8256** | `3c1f549`（09-21 11:5x） | 【实测】全量 1729 / 1707 pass / 4 todo；**fail 18 全为环境类**（git `invalid reference` 回归），**非环境类 0** |
| 12 | **夹具审计 F1 · 技能空壳显式化**（台账 §3.1）：`HOST_ONLY_SKILLS` **27 名**名单 + `seedHostSkills` 缺省**拒绝造桩**（读真实资产路径受保护）+ 10 处自造调用点显式 `{ stub: true }` + 新 `test/fixture-skill-ledger.test.js` **4 条**双向断言（含负向真抛错）⇒ 施工中即抓到 **2 个未登记自造名**（`dev-tester` / `ta-mand-seeded-skill`）；**仅 `test/**`**、`lib/**` 零 diff | 本批（09-21 21:1x） | 【实测】全量 **1757 / 1735 pass / 18 fail 全为环境类** ⇒ 非环境类 0；基线 147/1710/8341 → **148/1714/8351** |

> R3g 子波：`fda041a`（R3-1 补测）· `035426d`（R3-2 判读）· `0d280ea`（R3-3 前提推翻 + fail-open）· `43c4b29`（R3-4 真 E2E）· `a3dcf22`（R3-3 冻结 + 源类型实证）· `a944759`（R3-5 强度台账）。

## §1.5 任务级（`task_*`）工具族 ↔ 引擎核心设计映射

> 口径：**任务级治理** = 池的「入池 / 视图 / 出池」三件事。出池**不属于** `task_*`（派发面在 `member_status` / `lane_dispatch`），这是 K1 的刻意划分。

| 工具 | 面 | 引擎核心设计项 | 施工单落点 |
|---|---|---|---|
| **`task_pool`** | 只读 | **K1 公共池**（蓝图 §3.2 **P-A**：池 = `owner == null` 的**视图**，不是容器；不引入 claim 自领） | 触点 10（读端回显）+ 13（工具面）；R4-1a |
| **`batch_tasks_add`** | 写（入池） | **K1「派发是唯一出池动作」的入口侧** + **A4 目标一：更细拆分**（§4）；判据与建批期同源（`buildWavePlan` + `topoWaves`） | 触点 4/5/8（lanes/handoffs 播种 + 单写者 `atomicWrite`）+ 9（`plan.mutated`）+ 11（`revision` 可选字段）；切片 **R4-1（只追加 lane，不加边）** |
| ~~`task_split`~~ | — | **已舍弃**（2026-09-21 13:3x）：plan 层摸底/拆分本身即独立任务 ⇒ **无「拆父任务」语义** | 见 §4 第 8 条 |
| **`task_update`** | 写（加边） | K1「**未派发**任务在池内可自由调整依赖」+ 触点 #3（重跑 `checkHandoffDeclarations`）/ #5（同事务补 `pending` 条）/ #6（出口门读当前声明） | 触点 3/5/6；**R4-2 ✅ 已落地**（只增不删；已派发即冻结；不成环靠结构性保证） |
| `member_status` / `lane_dispatch`（**非 `task_*`**） | 写（**出池**） | K1「派发 = 唯一出池动作 + 门禁点」⇒ 派发面写 `owner`（R4-1b） | 触点 8（复用既有单写者路径） |
| `lane_claim` | 写（锁） | 派发串行化（既有，非本轮新增） | — |

## §2 裁定面（未动代码或只动文档/生成器）

| # | 项 | 裁定 | 落地 | commit |
|---|---|---|---|---|
| 6 | **A1** | `GATE_BATCH_CONTROL_ACTION_INVALID` **冻结**（不删不改不拆 OR） | `gate-assertion-blueprint §11.1` + 冻结台账 | `37e3151` |
| 7 | **A2** | `assign_check` **保留原样**；「归属失实」改判为「已登记分层口径」（定性勘误） | `§11.2`；`lib/**` 与 `description` **零改动** | `37e3151` |
| 8 | **A3** | `sectionLineHit` **实证存在**（`gates.ts:399`，被 `:978/:987` 消费），非幻觉；新增「plan 产出规格 × 判据字面量」冲突 | `§11.3`；三选一**仍待裁** | `37e3151` |
| 9 | **A4** | 新引擎形态：任务管理器中心 + 更细拆分 + 更稳高并发 + 黑板 B-A | `docs/new-engine-blueprint-2026-09-21.md` | `37e3151` |
| 10 | **K1** | 层内不重算 · 非改派 · 引入公共池 · 派发 Leader 单点 | 蓝图 §2 / §3.2 / §4 | 本批 |
| 11 | **K2** | 仓内波称 **R3g**；路线稿波 1 称 **R3-增强**；`O-10` 引用须带文件简称 | 蓝图 §7.1 / §5.2-2 | 本批 |
| 12 | **K3** | 去返工边；返工 = gap-list + 新任务批次 | 蓝图 §2.4 + **§7.3 施工单（未开工）** | 本批 |
| 13 | **K4** | 路线在蓝图中重排（N0 / N0.5 / N1 / N1.5 / N2 / N3） | 蓝图 §7.2 | 本批 |

## §3 新增资产（既有规划里没有的，防止被重复规划）

| 资产 | 与既有规划的关系 |
|---|---|
| `scripts/audit/strength.mjs`（断言强度 title/exact/weak/other，`--selftest` 9 例） | 与路线稿 **O-01「判定等级机读化」部分同向但不等价**：O-01 = 运行期判定等级；strength = 测试断言强度分辨率。**不得互替代** |
| 冻结台账生成器链（`gen-register.mjs` + `REGISTER_OUT` 预览 + `--check` 漂移比对） | 落实裁决 ③；既有规划未覆盖 |
| 门禁台账 v3（拒码真源 = `contracts.ts` `GateErrorCode` union，66 项） | 取代旧「15 个无断言码」口径 |
| 判据分层通则（声明面 vs 内核兜底；「有引用 ≠ 可达」三分型） | 方法论资产，跨波复用 → `_research/punky-engine-judging-rules.md` |
| `docs/implemented-inventory-2026-09-21.md`（本文件） | 已落地台账；配合 `new-engine-blueprint §7` 使用 |
| 夹具审计工序（`scripts/audit/fixtures.mjs` + `docs/fixture-audit-2026-09-21.md`） | 用户 2026-09-21 20:4x 提出「清理冗余夹具（技能装配空壳 / 团队装配夹具 / 其他疑似）」⇒ 与可达性审计**同族第二条工序**；既有规划未覆盖 |

## §4 明确「不要重做」

1. **不重新定位/盘点拓扑与门禁** —— R3g 已完成（66 码真源、强度台账、冻结台账、`--check` 漂移比对）
2. **不重开「无断言门禁」** —— 余 2 枚（哨兵 `GATE_ARTIFACT_MISSING` + 不可达 `GATE_NO_DECLARATION`）**刻意不补**；A1 已裁冻结
3. **不再做链声明 / 并发闸** —— Q-A=C、Q-B 已闭合
4. **不重做 Jiuwen 对位** —— 路线稿 §4.2（可借 6 / 不可借 3）+ 集群稿 §6（不搬 4）已覆盖；新蓝图 §2.5 只做「受限采纳」增量
5. **不重排 C1 26 / B1 残留 10 / schema 消环 / C2 200** —— 蓝图 §6 已给批量解冻映射，只等形态定
6. **不重排路线稿波 2（R4 图修订）** —— 已并入 **N1**，13 触点与 R4-1/2/3 切片直接继承
7. **不复审 / 不做 `wave_plan_revise`** —— 2026-09-21 12:4x **舍弃裁定**（上下游审计见 `new-engine-blueprint §7.4.2`）。理由三条：① 出生目的 = 评估稿 §2 提案①「**返工**回路 + 追加 lane」，与 **K3**（返工 = gap-list + 新批次；追加 lane 只承担同批增量）**正面冲突**；② 其前置「gap-list 从 `audit/` 迁 `plan/`」与既有裁定（落 `audit/`，产出者 supervisor）**相反**；③ 前提「返工边仍在役」已被 **N0.5** 推翻。⇒ **名字一并弃用**（自带返工语义）。日后若需「同批追加 lane」，立**中性命名**工具并在 `description` 显式声明不承担返工（已由 **`batch_tasks_add`** 承担，见 §1-10）。
8. **不做 `task_split`（无「拆父任务」语义）** —— 2026-09-21 13:3x 用户裁定：**plan 层的调查摸底、拆分本身就是独立任务**，其产物由下游 exec/audit 层 `consume` ⇒ 细拆分 =「plan 任务产出细化规格」+「池内追加任务（`batch_tasks_add`）」两件事，**不存在拆分父任务**。原「父任务处置」三选一随之消解。另：**暂不新建拒码**（迁移门禁再议）⇒ 非法输入一律抛普通 Error。
9. **不重复「夹具清理」的盘点工作** —— 清单 / 口径 / 分片见 `docs/fixture-audit-2026-09-21.md`（§3 判读 + §4 F1–F5）；直接按分片执行，**不再重新枚举夹具**。

## §5 未闭合（随 N0.5 暴露，需裁定后才可收尾）

| 项 | 内容 | 状态 |
|---|---|---|
| ~~**恢复路径断裂族**~~（4+1 例断言） | 详见 §1-7 | ✅ **已闭合**（`3c1f549`）：取方案①的**派发面**、否决其**门禁面**（撞「门禁拒 = 零写入」）。裁定全文见 `new-engine-blueprint §8.8` |
| ~~**`attempt` 升级标记**~~ | 派生源（`member.settled review→running`）随去边消失 | ✅ **登记为「能力已移除」**（`outcome-typing` C5-4 已改判为「attempt 无派生源」）；N1 后若确需，另立「按新批次计数」口径 |
| **环境类 18 例**（`invalid reference: punky/orch`） | 与去边**无关**。受控实验：PortableGit 置 PATH 首位后仍 7/7 失败 ⇒ **git 版本归因二次证伪** | ⏸ 根因未定性，独立登记。⚠ **分布会漂移**：N0.5 前 = `worktree` 7 + `merge-agent` 9 + `resume` 2；本轮 = `worktree` 7 + `merge-agent` 9 + `lane_checkpoint` 2（`resume` 转绿）⇒ 缺陷**不稳定**，不可按文件名单豁免 |
| **A3 产出规格 × 判据字面量** | `spec-writing` 规格为英文 13 章 ⇒ 照此产出必被 `GATE_PLAN_CONTRACT` 拒 | ⏸ 三选一未裁（建议①规格本地化，排期 N1.5） |
| **A4 §2.3 解读** | K1「层内不重算」与 A4「放宽到层内」字面相反的调和口径 | ⏸ 待用户确认 |

---

*本文件随施工推进**追加**，不覆盖；已落地项不因后续冻结/解冻而删除，只可标注「已被 X 取代」。*
