# 新引擎形态蓝图 · 2026-09-21（A4 形态裁定 + K1–K4 冲突裁定）

- 施工对象：`D:\dsh\Punky-plugin-onto\packages\dsh-punky-swarm`（基线 HEAD `a944759`；裁定落档于 `37e3151`）
- 上游依据：`_research/punky-new-baseline-vs-jiuwenswarm-cluster-assessment.md`（J1–J14 / P0-P2）· `_research/punky-engine-iteration-roadmap-assessment.md §4`（可借 6 / 不可借 3）· 本仓 `docs/{rebuild,frozen-register,gate-assertion}-2026-09-21.md`
- 性质：**形态裁定 + 路线总表**；施工单在 §7 各波内以「落点 / 影响面 / 验证」三段给出，开工需另行授权
- 已实施内容（commit 级）→ `docs/implemented-inventory-2026-09-21.md`（**本文件不再复述已落地项**）

---

## 0. 裁定输入

### 0.1 A4 形态裁定（2026-09-21 上午）

| # | 裁定 | 作用 |
|---|---|---|
| N1 | 新引擎形态**重点参考任务管理器**（jiuwen `agent_teams/tools/task_manager.py` 形态） | §3 黑板选型 · §5 稳定性四条 |
| N2 | **放宽「不重算」定义到层内** | ⚠ **已被 K1 收窄**，见 §2.3 |
| N3 | 设计目的 = **更细地拆分任务** + **更稳定的高并发** | §4 / §5 |
| N4 | **接受 `wave_plan` 形式修改**，或改用**其他类型的任务黑板** | §3 |

### 0.2 K1–K4 冲突裁定（2026-09-21 10:5x，对 `_research/punky-engine-landed-vs-plan-reconciliation-2026-09-21.md §4` 的回复）

| # | 裁定 | 落点 |
|---|---|---|
| **K1** | **层内不重算；非改派**；拟定引入**公共池**（任务黑板或任务队列）；**派发仍由 Leader 单点发起** | §2 全章重写 · §3 池选型 · §4 拆细 |
| **K2** | 按建议消解命名歧义：**仓内波 = R3g（gate 波）**，路线稿波 1「R3 八项」= **R3-增强** | §7.1 命名口径 |
| **K3** | **去除返工边**；返工走 **gap-list + 新任务批次**；除非有足够健壮的工程实现，否则不引入（避免抬高单任务管理复杂度） | §2.4 + §7 波 N0.5 施工单 |
| **K4** | **在蓝图中重新整理路线** | §7 全章 |

---

## 1. 硬约束（沿用既有红线，不因新形态松动）

| 约束 | 出处 | 本形态下 |
|---|---|---|
| H3 **文件型单真源**（批次 = 单个 JSON，含内嵌 `events[]`） | `lib/types/contracts.ts:286-306` | **保留** ⇒ 排除「独立任务板文件 / SQLite DAO」 |
| H1 **已派发任务不重算**（K1 重申） | 本文件 §2 | **保留**；保护对象由「批级拓扑」细化为「**已派发/已启动任务**」 |
| **失败/冲突 lane 为终态** | K3 + R-01 | **保留且落到代码**（`schema.ts:41` 去边，见 N0.5） |
| **棘轮不可加状态**（覆盖表须为默认表子集） | `lib/state/machine-rules.ts` | **保留** ⇒ 公共池**不得**新增成员状态；`owner: null` 是声明面不是状态 |
| **门禁 > 互通** | 引擎立场 | **保留** |
| 层语义为主、层间有闸；四道硬门**搬时点不搬判据** | 已裁 | **保留** |

---

## 2. ★ 红线：层内不重算 · 非改派 · 公共池

### 2.1 一页口径（K1 后的现行红线）

> **已派发/已启动的任务：不可重算（不可改内容、不可改依赖）、不可改派。**
> **未派发任务存于公共池，池内可自由调整（增/删/拆细/合并/改依赖）——这不构成重算，因为它尚未进入执行态。**
> **派发 = Leader 单点从池中取任务派给 lane；派发即门禁。**

### 2.2 三条边界（机读判据，待随 N1 落闸）

| 边界 | 判据 | 允许动作 |
|---|---|---|
| **池内**（未派发） | `task.owner == null ∧ lane 未创建` | 增 / 删 / 拆细 / 合并 / 改依赖；**不留痕四件套**（尚未产生事实，无需留痕） |
| **已派发**（层内） | `task.owner != null ∨ lane 已存在` | **只可**：`skip`（作废）+ 池内新增替代任务 + gap-list 留痕；**不可**改内容 / 改依赖 / 换人 |
| **产物已被 consume**（跨层） | `downstreamConsumed(task) === true` | 冻结；任何改动走**新批次**（K3），不是追加 lane |

- **留痕四件套**（单次原子写 + `reason/author/revision` + 落 `events[]` + 变更后重跑**该层**建批期校验）**只适用于「已派发」区的动作**；池内调整不触发。
- **未放松的部分**：「禁**隐式**重算」一字未松。K1 收窄的是 A4/N2 的**范围**（层内 → 已派发），不是留痕要求。

### 2.3 ⚠ 对 A4/N2 的收窄（改判，须你确认解读）

- A4 原文：「放宽不重算定义到层内」；K1 定：「**层内不重算**」。二者字面相反，本文件的调和口径是：
  - A4 想放宽的对象是「**已建批但在层内尚未开跑**」这一段的调整自由度；
  - K1 给出的替代方案是**把这段自由度前移到公共池**（未派发即可调整），而不是放开已派发的任务。
- ⇒ **实质保留了「更细拆分」的自由度，撤销了「已派发后可改」**。若你的原意是「层内已派发但未启动的 lane 仍可改」，请驳回本条并按你的口径重写 §2.2 第二行。

### 2.4 返工的唯一通道（K3）

- **去返工边**（`review → running`）⇒ 失败的 lane **没有回边**。
- 返工 = **gap-list 落 `audit/`（supervisor 产出）** + **新任务批次**（新 batch，不是同批追加 lane）。
- 「追加 lane」保留给**同批内的增量补充**（R4-1 形态），**不承担返工语义**——二者不得混用。
- 理由（沿用你的判据）：返工边会把「单任务生命周期管理」（attempt 计数、上下文继承、验收标准再判）压进引擎 ⇒ 抬高单任务管理复杂度；除非有足够健壮的工程实现，否则不引入。

### 2.5 与 jiuwen 的边界（受限采纳）

| jiuwen 形态 | 原判 | 本形态下 |
|---|---|---|
| **原子图变更 + 后置再校验 + 环检测在变更后图** | 可借（M-1） | **采纳**（`task_manager.py:174 add_graph` / `:487 mutate_dependency_graph`） |
| **变更结果对象** `TaskOpResult{ok,reason,data,refreshed_tasks}` / `GraphMutationResult` | 可借（M-2 / OJ-6） | **采纳** ⇒ C1 中 6 个安全守卫的解冻正门（§6） |
| **在办任务原地改内容 + 通知重读**（M-4） | 冲突 | **不取**（撞「已派发即冻结」）— 已回改路线稿 |
| `task_id:"*"` 全取消 / **改派在办任务** / 取消成员（J1 运行期改图） | 冲突 | **不取**（K1 非改派） |
| **返工回路** `in_review → in_progress`（J2） | 冲突 | **不取**（K3 去边） |
| SQLite DAO + `team.db`（J1/J9） | 冲突（撞 H3） | **不取** |
| **未指派任务入公共看板**（J1 池形态） | 冲突 | **改为受限采纳**：池**只存**，`claim` 自领**不引入**，派发由 Leader 单点 |
| 内容寻址 journal `sig=SHA-256(prompt+opts+schema)` | 可借 | **借作「任务指纹」** ⇒ 重复派发/重复结算的幂等判据（§5.3） |

---

## 3. 公共池 + 任务黑板选型（N4 + K1）

### 3.1 黑板候选（沿用 N4 三选一，结论不变）

| 候选 | 形态 | 判读 |
|---|---|---|
| **B-A** | **改造 `wave_plan`**：批 JSON 内 `tasks[]` 升为**一等任务黑板**（`{id, deps[], owner?, status, revision, sig}`），lane = 任务实例 | ✅ **推荐**。沿用 H3 单真源 + `store.js` 单写者；工具面扩 `task_update` / `task_split`，**不新增真源** |
| B-B 独立任务板文件 | `<root>/tasks.json` 与批 JSON 分离 | ❌ 撞 H3（双真源） |
| B-C 事件溯源 journal | `events[]` 为真源，任务态 = 重放投影 | ❌ 重放即重算；只借其 `sig` 做指纹 |

**推荐 B-A**：唯一「不新增真源」即可达 N3 的路；`wave-plan.ts:306-346 topoWaves` / `:543-627 validateLayerContract` / `:700-729 checkHandoffDeclarations` 可复用 ⇒ 黑板化是**升层**不是重建。

### 3.2 公共池的两种载体（K1 说「任务黑板或任务队列」，二选一，建议前者）

| 载体 | 形态 | 判读 |
|---|---|---|
| **P-A 池 = `tasks[]` 的 `owner == null` 子集**（黑板内建） | 池不是一个文件，是任务黑板上的一个**筛选视图** | ✅ **建议**。零新增真源、零新增结构；`task_pool` 工具只做「列出未指派 + 校验可派发」，派发仍走既有单点 |
| P-B 独立任务队列 | 池与批 JSON 分离的队列结构 | ❌ 撞 H3（同 B-B 的理由） |

⇒ **池 = 视图，不是容器**。这一条直接决定了「不引入 claim 自领」：视图无授权语义，任何认领动作都必须经 Leader 派发这一条路径。

---

## 4. 目标一：更细地拆分任务

- **现状粒度**：lane ≈ 任务，被「层」这个粗桶夹住（plan/exec/audit 各一桶）。
- **新粒度**：**任务是图、层是闸**——层仍承担闸语义，但层内任务数不再受 lane 数约束。
- **拆细落点**：`task.deps`（DAG 边）；`task.owner` 缺省 `null`（= 在池内）。
- **派发**：Leader 单点，从池中取任务 → 指派 `owner` → 创建 lane。**派发是唯一的「出池」动作**，也是门禁点（§3.2）。
- **换人**（原「改派」诉求的实现方式）：目标任务作废（`skip` + `reason`）→ 池内新增替代任务（继承验收标准）→ gap-list 留痕。**不改 `owner` 字段**。
- **防碎判据**：最小任务 = **一个可验收产物**；`task_split` 必须**继承父任务验收标准**，否则拒。

---

## 5. 目标二：更稳定的高并发

### 5.1 WIP 判据

jiuwen J1 是「每成员同时只能有 1 个 `in_progress`（WIP=1）」。蟛蜞 lane 是短生命周期 worker，并发 = 多 lane 并行 ⇒ **WIP=1 天然成立，无需搬**（搬了反而是新约束）。公共池不引入排队竞争 ⇒ 不产生 WIP 语义变化。

### 5.2 稳定性四条

1. **单写者 + 原子写**（`store.js` 既有）：黑板任何变更 = 一次 `atomicWrite`，全成或全败。
2. **槽位与准入口径归一**：Q-B 取消并发闸后，`batch.concurrency` 只作声明/回显、`maxMembers` 是唯一槽位概念 ⇒ 新形态须**实证官方槽位真拦**（见 §8-5；⚠ 编号更正：此项是 `engine-design-adjudication §3` 的 **E4**，**不是**路线稿 O-10——后者是「Onto 已生效契约不可原地改」，二者互不相干）。
3. **幂等 / 重放安全**：任务指纹 `sig` 判「重复派发」「重复结算」。
4. **变更返回结果对象**：`assertMemberTransition` / `assertBatchTransition` 由裸 throw 改 `{ok, reason, data, refreshed}`（M-2 / OJ-6）⇒ 与 C1 解冻同一动作（§6）。

### 5.3 已知短板（J4 对位）

jiuwen 有 6 类探测器 + 4 档 severity + 分级处置 + 强度预算；蟛蜞 `lib/watch/lane-heartbeat.js` 只有「停滞」一维 ⇒ 高并发下「跑飞/反复重试」无分级处置。**列 N3，不阻塞 N1/N2**；集群稿 P0-1「可靠性三段式」亦改挂 N3。

---

## 6. 现存冻结项的解冻映射

| 冻结项（规模） | 新形态下处置 | 前置 |
|---|---|---|
| **C1 生产未接线 26 项**（W2） | 6 个安全守卫（`assertMemberTransition` / `assertBatchTransition` / `artifactTypeOf` / `typesOfLayer` / `sweepExpiredHandles` / `clear*Cache`）→ **接线并改为返回结果对象**；3 个测试钩 → **降级登记**；`validateAssembly` / `assertAssemblyCompleteness` → **删**（保常量表） | N1 池形态定 |
| **B1 残留 10 项** | 随形态判「声明面还要不要」 | 同上 |
| **schema 循环依赖**（W4） | 保留 `assembly` ⇒ 常量下沉叶子模块；黑板化 ⇒ 随结构重划 | 形态定 |
| **R4 受控追加 lane** | 保留为**同批增量补充**；**不承担返工**（K3） | §2.2 判据落闸 |
| **A3 判据配置化**（`gates.ts:903/:994`） | 随黑板化一并做（`plan_spec.sections` 声明面）⇒ 顺带消 fail-open | 形态定 + W6 解冻 |
| **无断言拒码 2 枚** | 补生产路径 E2E 的时机到（口径原即「新引擎定型后」） | 形态定 |
| **C2 白盒面 200 项** | 黑板化后「任务」成为生产面 ⇒ 可转生产路径断言 | 同上 |

---

## 7. ★ 路线总表（K4：本轮重排）

### 7.1 命名口径（K2，先行钉死）

| 旧写法 | 现行写法 | 含义 |
|---|---|---|
| 「R3」 | **R3g** | 本仓门禁断言波（`r3-1 … r3-6`，**已收尾**，纯增量 `lib/**` 零 diff） |
| 「R3 八项」 | **R3-增强** | 路线稿波 1 的能力增强包（**几乎全未落地**） |
| 「O-10」 | **必须带文件简称** | `adjudication E4`（槽位真拦）/ `路线稿 O-10`（Onto 契约不可原地改）/ 其余引用一律改写 |

⚠ 任何文档说「R3 已完成」⇒ 指 R3g；**不得**被读成「R3-增强已完成」。

### 7.2 波次总表

| 波 | 内容 | 依赖 | 状态 |
|---|---|---|---|
| **（已完）** R1 / R2 / R3g / A1–A4 裁定 | 见 `docs/implemented-inventory-2026-09-21.md` | — | ✅ 已落地 |
| **N0** | 形态裁定收口：确认 §2.3 解读（层内不重算 vs 已派发不重算）、池载体 P-A、防碎判据 | 你 | ⏸ 待裁（§8-1/2/3） |
| **N0.5** | **去返工边**（K3）— 独立批，见 7.3 施工单 | 无（可先行） | ✅ 已完成（含恢复路径族收尾，`5642d3b`/`d1c9504` + 本批） |
| **N1** | **公共池 + 任务黑板**：`tasks[]` 升一等 + `task_pool` / `task_update` / `task_split` + 原子变更 + 后置重校验 + 环检测 | N0 + N0.5 | ⏸ |
| **N1.5** | **plan 产出规格本地化**（A3 方案①，零代码行为变更） | 无（可并行） | ⏸ 待 A3 三选一裁定 |
| **N2** | C1 接线（结果对象化）+ 门禁判据配置化（A3③） | N1 | ⏸ |
| **N3** | 高并发稳定性实证：槽位真拦（`adjudication E4`）、幂等、P0-1 三段式、§5.3 分级处置 | N1 | ⏸ |

**继承关系（K0，防重复规划）**：路线稿**波 2（R4 图修订）已并入 N1**——两者落点同源（`wave-plan.ts:306-346 / :543-627 / :700-729` + `store.js` 播种 + `gates.js:1793-1857`）。路线稿 §4.5 的 **13 触点与 R4-1/R4-2/R4-3 切片直接搬入 N1，不重新定位**。【实测】`contracts.ts` 的 `WavePlanDoc` **已有 `tasks`** ⇒ B-A 是升一等，不是新增键。

### 7.3 N0.5 施工单：去返工边（K3）

| 项 | 内容 |
|---|---|
| **落点** | `lib/schema.ts:41` `review: ['merged','conflict','failed','running']` → **删 `running`**（连带注释「running = REWORK 返工」一并删） |
| **派生落点** | `lib/schema.js:26` + `lib/schema.d.ts:10` = **构建产物** ⇒ ⚠ `schema` 在 `scripts/copy-ts-built.mjs` 回拷清单首行 ⇒ **必须走 `npm run build`（tsc → copy-ts-built）**，**禁止手改 `.js`/`.d.ts`** |
| **影响面·消费侧** | `lib/state/machine-rules.ts:33` `DEFAULT_MEMBER_RULES = MEMBER_TRANSITIONS`（同引用，自动继承）；`lib/schema.ts:80 canTransitionMember` 读表 |
| **影响面·测试** | ⚠ `test/machine.test.js:46` 显式用例 `['review','running', true]` ⇒ **须同批改判为 `false`**（这是它的绊线价值：去边后它应当转红，改判即留痕） |
| **影响面·配置** | 【实测】`presets/**` **零 `ratchet` 覆盖声明** ⇒ 去边不撞「覆盖表须为默认表子集」 |
| **验证** | ① `npm run build` 零错；② 全量 `fail = 0`（改判后基线断言数不变）；③ `git diff --stat -- lib` 只有 schema 三件套；④ 冻结台账与 `docs/gate-assertion-blueprint §7` 无新增待办 |
| **纪律** | 一批一 commit；与 N1 **不同批**（N0.5 是既有裁定的施工兑现，N1 是新形态） |

#### 7.3.1 施工结果（2026-09-21 11:2x）

- ✅ 已完成：`lib/schema.ts:41` 删 `running` → `npm run build` → `lib/schema.js:26` / `lib/schema.d.ts:10` 同步（**三件套，零其它产物漂移**）。
- ✅ 已改判（返工能力族，反向锁死）：`test/machine.test.js:46` · `test/rework.test.js`（3 例）· `test/gate-techdebt-red.test.js` R-21（R-CAS-4 反转）。基线 `asserts 8245 → 8248 (+3)`。
- ⏸→✅ **已闭合（2026-09-21 11:5x，恢复路径族）**：裁定见 §8.8（**不改状态机、不改「门禁拒 = 零写入」**）。
  - ✅ `lib/engine/dispatch.js:287`（+ `:210` 注释 + 错误提示）—— 派发失败回滚目标 `review` → **`failed`**（`running→failed` 在迁移表内，**零新增边**）；提示改为「已置 failed ⇒ 恢复 = gap-list + 新任务批次，**不可原地重派**」。`dispatch` 不在 `copy-ts-built` 回拷清单 ⇒ 直接改 `.js`，无需 build。
  - ✅ 改判 5 例：`gates.test.js`（Exit Gate audit / O2 T8）· `governance.test.js` A3 · `outcome-typing.test.js` C5-4 · `dispatch-failure-rollback.test.js` DR-2 · `suite-consistency-and-hot.test.js` SC-3。基线 `asserts 8248 → 8256 (+8)`。
- ⚠ **施工单影响面评估不足（如实登记）**：原估「1 条测试改判」，实测 **15 条断言**受影响（返工能力族 6 + 恢复路径族 4 + 派发回滚族 2 + 连带 3）。**教训**：改状态机前须按「能力族 + 恢复族 + 回滚族 + 连带」四类扫影响面，不能只扫直接引用。
- ⏸ **遗留（不属本批）**：`presets/punky-preset/references/discipline.md:298` 仍写「派发失败已回滚到 `review`、`review→running` 是既定返工入口」⇒ **事实失实**，归资产会话同步（与 A2 处置一致）。

### 7.4 N1 施工单：公共池 + 任务黑板（P-A）

> **继承（K0）**：路线稿 §4.5 的 13 触点与 R4-1/R4-2/R4-3 切片**直接搬入，不重新定位**。下表行号为 **2026-09-21 12:0x 实测校正**（路线稿原文行号有多处已漂移，见「校正」列）。

| # | 落点 | 现状（实测） | 追加后必须做 | 切片 | 校正 |
|---|---|---|---|---|---|
| 1 | `wave-plan.ts:306 topoWaves` | 建批期跑一次 | 变更后在**变更后图**重跑（无环 / 未知 id） | R4-1 | 行号同 |
| 2 | `wave-plan.ts:514 / :543` `validateLayerContract` + `checkPlanPresenceContract` | 建批期跑一次 | 重跑；**新 plan 任务的产物必须被 consume**，否则 `GATE_ORPHAN_PRODUCT` | R4-1 | 原 543-627 → 现 :514/:543 |
| 3 | `wave-plan.ts:700 checkHandoffDeclarations` | 建批期跑一次 | 重跑；新入边上游须有 `produce`/`outputs` | R4-2 | 行号同 |
| 4 | `store.js:299-302` lanes 播种 | 建批时全量种 `pending` | 新任务必须在**同一次原子写**内种 `pending` | R4-1 | 原 304-306 → 现 299-302 |
| 5 | `store.js:341-356` handoffs 逐边播种 | 建批时按 `deps` 种条 | 新入边必须在**同一事务**内补 `pending` 交条件（否则「有边无条」空洞） | R4-2 | 原 341-358 → 现 341-356 |
| 6 | `gates.js:1793 checkSettleHandoffGate`（下游集合 `:1798-1800` 只按静态声明） | 只按静态声明（语义正确，防「猜下游」） | 改读**当前 revision** 的声明（判定逻辑不变，只换数据源） | R4-2 | 行号同 |
| 7 | `gates.js` complete 门 offenders | 从 audit lane 现算 | 追加的未结算 audit lane 会自然进 offenders ⇒ 须**留痕**（防静默拒） | R4-1 | 行号待定 |
| 8 | `store.js` 单写者锁 + `atomicWrite`（:357） | 唯一写路径 | 变更事务**复用**该路径；**禁新增写入口** | R4-1 | 行号同 |
| 9 | `event-types.js` | 无图变更事件 | 新增 `plan.mutated`（revision / added / edges / reason / author） | R4-1 | — |
| 10 | `api.js:122` + `panel/*` + `batch_status` | 直投影 `batch.wavePlan` | 回显 `revision` + 变更历史（只读）+ **池视图**（`owner==null`） | R4-1 | 行号同 |
| 11 | `contracts.ts` `Batch:286` / `WavePlanDoc:175` / `WavePlanTask:97` | 无 revision、无 `owner` | **新增可选字段**（「新增可选项不破坏存量」= 可取写法）：`WavePlanTask.owner`（缺省 `null` = 在池内）+ `revision` | R4-1 | 行号同 |
| 12 | `machine-rules.js:29-49` 棘轮 | 只许收紧 | **不动**（A 不触迁移表——选 A 不选 B 的核心理由） | — | 原 36-72 → 现 29-49 |
| 13 | 工具面 | 裸 20 / 全开 21 | 新增池/任务工具 ⇒ 工具数、注册表、`pkg-hashes`、测试基线同步 | R4-1 | **数量待裁**见 §8-9 |

| 项 | 内容 |
|---|---|
| **派发语义** | Leader 单点：`task_pool`（只读视图）→ 指派 `owner` → 建 lane。**派发是唯一出池动作 + 门禁点**；不引入 claim 自领（§3.2） |
| **换人** | 目标任务作废（`skip` + `reason`）→ 池内新增替代任务（**继承验收标准**）→ gap-list 留痕。**不改 `owner`** |
| **防碎** | 最小任务 = **一个可验收产物**；`task_split` 必须继承父任务验收标准，否则拒（§4） |
| **影响面（四类扫）** | 能力族 = 3 新工具 + 2 可选字段 + 1 新事件；**恢复族/回滚族 = 无**（不触状态机）；连带族 = 测试基线、`pkg-hashes`、工具注册表、`frozen-register`（C1 26）、`gates --check` 66→66 |
| **验证** | ① 新增 `test/task-pool-*.test.js`；② 基线**先重生成再跑全量**；③ 非环境类 `fail = 0`；④ `gates --check` 66→66；⑤ `gen-register` 预览零漂移；⑥ 旧批（无 `owner`/`revision`）**零迁移可读** |
| **纪律** | 一批一 commit；与 N2（C1 接线 + 判据配置化）**不同批**；R4-1 与 R4-2 **分两片独立验收** |

#### 7.4.0 R4-1a 施工结果（2026-09-21 12:5x，✅ 已落地）

| 项 | 内容 |
|---|---|
| **本片范围** | **只读地基**：`owner` 声明面 + `task_pool` 只读视图。**不做**加边（R4-2）、**不做** `task_split`（R4-1b）、**不改**派发写路径 |
| **落点** | ① `contracts.ts` `WavePlanTaskInput.owner?`（可选）/ `WavePlanTask.owner: string｜null`（恒写，缺省 `null`）② `wave-plan.ts` 归一化（非字符串含缺省 ⇒ `null`，与 `targetsMarker` 同风格）③ `core.js` 新增 `task_pool` 工具（只读）④ `suite.js` 注册表 +1（第 15 条后非 deny 区块 ⇒ deny 冻结序列零变化） |
| **判据** | 池内 = `owner == null`；可派发 = 上游 `deps` 全部 `isMemberTerminal` ∧ lane 仍 `pending`；否则 `blockers[]` **指名**（`GATE_HANDOFF_MISSING` / `ALREADY_DISPATCHED`），**不静默** |
| **影响面（四类扫）** | 能力族 = 1 工具 + 1 可选字段；**恢复族/回滚族 = 无**；连带族 = 注册表（29→**30**）、`pkg-hashes`（370→**398** 件）、测试基线（147/1692/**8281**） |
| **验证** | `test/task-pool-r41.test.js` **6/6**（含断言 `SUITE_DENY_TOOLS` 仍 14、`MODE_GATED_TOOLS` 仍 10、deny 序列首项不变）；`suite-consistency` + `wave-plan` + `batch-store` **52/52** |
| **⚠ R4-1a 未闭环** | `owner` 当时无写入方 ⇒ 池视图恒等于「未派发 lane 集合」 |

#### 7.4.0b R4-1b 施工结果：派发 = **唯一出池动作**（`owner` 写入方，✅ 已落地）

| 项 | 内容 |
|---|---|
| **落点** | ① `event-types.js` 新增 `EVT_TASK_OWNER_ASSIGNED = 'task.owner.assigned'`（出池留痕）② `store.setMember` **第 7 参 `owner`**（可选项，`undefined` = 零写入 ⇒ 既有调用行为一字不变）③ 派发面调用点传 `ownerOfExec(exec)`：`core.js` `member_status` + `dispatch.js:221` |
| **写入时机** | 仅 `to === 'running'`（派发面），写在 `batch.lanes[lane] = to` **之后、统一 `atomicWrite` 之前** ⇒ 声明面（`wavePlan[].tasks[].owner`）与执行面（`lanes[lane]`）**同一次落盘，不会漂移** |
| **非改派** | 已出池（`owner` 非空）⇒ **不覆盖**：换人只能走「作废 + 池内新增替代 + gap-list 留痕」，不改 `owner`（K1） |
| **fail-open 边界** | `ownerOfExec` 取不到 Agent 标识 ⇒ `null` ⇒ **零写入**（刻意）：owner 是声明面，缺失只影响池视图，**不阻断任何门禁** |
| **影响面（四类扫）** | 能力族 = 1 事件常量 + 1 可选参数；**恢复族/回滚族 = 无**；连带族 = 基线 + `pkg-hashes`（**新增工具已在上片完成，本片无工具数变化**） |
| **验证** | `task-pool-r41.test.js` **9/9**（含「派发即出池」「已出池不覆盖」「派发后移出池视图」三条） |

#### 7.4.0e R4-2 施工结果：池内**加边**（`task_update`，✅ 已落地）

> 用户裁定（2026-09-21 20:2x「按原计划推进（task_update 加边）」）⇒ 兑现 §7.4 触点 **#3 / #5 / #6**。
> 定位：K1「**未派发**任务在池内可自由调整依赖」⇒ 加边是**池内**动作，不在红线保护对象内。

| 项 | 内容 |
|---|---|
| **落点** | ① `store.js#addTaskEdges(sessionId, batchId, edges, {reason, author})`（`edges: [{ id, add: [dep…] }]`）② `core.js` 新增 `task_update` 工具（读写面：入 deny + 模式门）③ `suite.js` 注册表 31 → **32** |
| **单次原子写** | wavePlan 重归一化（`buildWavePlan` ⇒ **重跑** `checkHandoffDeclarations` / `topoWaves` / `validateLayerContract`，判据与建批期同源）+ handoffs 按新 `deps` 补 `pending` 条（**保留既有条目状态**）+ `plan.mutated`（带 `edges`）+ `planRevision+1` |
| **只增不删** | **不提供删边**：删边会毁掉既有交接声明与下游已消费的事实 ⇒ 属「重算」，撞 K1 红线 |
| **K1 边界（冻结面）** | 目标任务 `owner` 非空 **或** lane 已离开 `pending` ⇒ **拒**（已派发即冻结）。换人仍走「作废 + 池内新增替代 + gap-list」，**不改 `owner`** |
| **不成环 = 结构性保证** | 新边须 ① **已声明在先**（声明序严格前进）② **同层或上游层**（`generic`/无 layer 不参与层序）。⇒ 依赖图严格偏序 ⇒ 成环结构上不可能（**不做成环断言**，与 R4-1d 同口径） |
| **新增语义边界（可否决）** | 上游**已结算**（终态）⇒ **拒加边**：终态 lane 无法再 `handoff_submit` ⇒ 新边恒 `pending` ⇒ 下游 entry 门（开启时）永拒 ⇒ **结构性死锁**。若只需其产物在场 ⇒ 用 `consume` 声明；若确需等待交接 ⇒ 建批期声明 |
| **存量批保护** | 批无 `handoffs` 字段（legacy 形态）⇒ **拒加边**（否则会把它静默转成受门形态，改变交接门语义） |
| **拒码零增删** | 非法输入一律抛**普通 Error**（不带 `GATE_` 前缀）；唯一例外 = 批终态，复用既有 `GATE_BATCH_TERMINAL`（承 §7.4.1b 裁定） |
| **触点 #6 结论** | **无需改码**：出口门 `checkSettleHandoffGate` 的「下游集合」（`gates.js:1802-1810`）本就**直接遍历落盘 `batch.wavePlan`**（= 当前 revision 的声明）⇒ 加边后自动感知。§7.4 表列的「改读当前 revision 的声明」其真相 = **数据源本来就是它**（本片补断言锁住，见 R4-2-10；证据级别 = **数据源一致性**，非端到端门行为） |
| **影响面（四类扫）** | 能力族 = 1 新工具 + 1 store 写函数 + 1 新语义边界；**恢复族/回滚族 = 无**（不触状态机）；连带族 = 套件 31→**32**、工具数 28→**29**（10 处冻结断言）、`deny` 15→**16**、`modeGate` 11→**12**、AIP `TOOL_NAMES`、普查 `CASES`、`pkg-hashes`、基线 147/1700/8306 → **147/1710/8341** |
| **验证** | `task-pool-r41.test.js` **24/24**（R4-2 十条：加边原子写 / 已派发即冻结 / 已声明在先 / 自指 / 层序 / 上游终态 / 幂等与零变更 / 存量批 / 工具面读端同源 / 批终态）；工具面与注册表回归 **138/138**；全量 **1753 / 1731 / 18 fail（全为环境类）⇒ 非环境类 0** |

⇒ **N1 的池侧三片（R4-1a / R4-1b / R4-1c / R4-2）全部落地**：池 = 视图、派发 = 唯一出池动作、图变更 = 两个显式写入口（追加任务 / 加边）。

#### 7.4.0d 核查记录：`topoWaves` 是否冗余（2026-09-21 18:4x，用户质疑 ⇒ 核实）

**结论：非冗余，不得删。它是「拓扑违规」的**唯一判定单点**，但**测试零直接覆盖**（真缺口，待补）。**

| 面 | 实证 |
|---|---|
| **定义** | `wave-plan.ts:306` `topoWaves(tasks): { waves, order }` |
| **消费者（2 处真接线，❗已更正）** | ① `buildWavePlan`（`:814` `const { waves } = topoWaves(tasks)`，建批期分层）② `validateWavePlan`（`:983` `topoWaves(flat)`，建批后二级校验）。⚠ 本表原列的第三处「`store.addPoolTasks` 前置环检测」**已于 R4-1d 拆除**（用户裁定「引擎内不设成环回路 ⇒ 成环检查属冗余」）⇒ 该函数现用**结构性保证**（`deps` 只许指向既有/已声明在先 + 同层或上游）取代运行期判环 |
| **语义单点（其它校验器不抢答）** | `:698`「`deps` 指向不存在 id 由 `topoWaves` 报（`depends on unknown id`），本函数不抢答」；`:719-720`「自指由 `topoWaves` 报 / 悬空 id 由 `topoWaves` 报（不抢答）」；`validateDepsStructure` 同纪律（`:755-756` 自指与悬空**均 continue**，只约束「已存在且声明在先」） |
| **被既有裁定引用为可达性依据** | `:738-742`（G-08 替换判据）：旧 audit 配对判据被判「零可达性的空转校验」，理由正是「要满足即须自指环，而自指环在建批期先被 `topoWaves` 以 `cycle detected` 拒绝」⇒ 它的存在是该退役结论的**前提** |
| **⚠ 覆盖缺口** | `grep topoWaves test/` **零命中** ⇒ 环 / 悬空 id 的报错路径**此前无任何直接断言**（只经 `buildWavePlan` 间接、且不完整）。R4-1c-3 是第一条直接断言（成环）；**`depends on unknown id`（悬空）仍无直接断言** |

⇒ 处置：**保留 + 建议补测**（按 R3g 纪律「真缺口 ⇒ 补测」），不进「冗余待删」。补测项：`topoWaves` 直接单测三条（成环 / 悬空 id / 重复 id）。

### 7.4.1 ★ N1 开工前置冲突（须先裁，否则不动 `lib/**`）

| # | 冲突 | 我的建议 |
|---|---|---|
| ~~**C-1**~~ | ~~工具数量口径不一~~ | ✅ **冲突已消解**（`wave_plan_revise` **舍弃**，见 §7.4.2）⇒ N1-R4-1 只上 `task_pool` + `task_split`；`task_update` 并 R4-2；「同批追加 lane」通道日后是**另立中性命名**的工具，不复用 `wave_plan_revise` |
| ~~**C-2**~~ | ~~R4-3 与 K3 直接冲突~~ | ✅ **用户裁定 2026-09-21 12:4x：暂时冻结**（**非作废**）⇒ 登记冻结台账 `frozen-register` R4-3 行并附解冻条件（口径改「按新批次计数」且**不接回状态机**） |
| **C-3** | **N0 三项未裁**（§8-1/2/3：§2.3 解读 / 池载体 P-A / 防碎判据）而 N1 依赖 N0 | 建议按本文件 §2.2 + §3.2 + §4 的既定口径**视为已裁**（你已通过 K1 裁定「引入公共池、派发 Leader 单点」间接确认了 P-A；防碎判据见 §4 末行），并请你对 §2.3 单独点头 |
| **C-4** | 任务指纹 `sig` 入参集合（§8-4 未取证） | 属「幂等」目标（§5.2-3）；建议 **N1 只落字段与写入时机，不做判等消费**，实证推到 N3 |

### 7.4.1b ★ 2026-09-21 13:3x 用户裁定（细拆分 / 拒码）

| 裁定 | 内容 | 后果 |
|---|---|---|
| **细拆分的定位** | **plan 层的调查摸底、拆分本身就是独立任务**；plan 任务完成后其**产物由下游 exec / audit 层 `consume`** | ⇒ **不存在「拆父任务」语义** ⇒ 原 `task_split`（含「父任务处置」三选一）**设计前提不成立，舍弃**（与 §7.4.2 的 `wave_plan_revise` 同理）。细拆分 = 「plan 任务产出细化规格」+「**池内追加任务**」两件事，后者由 `batch_tasks_add` 承担 |
| **拒码** | **暂时不新建拒码**，迁移门禁时再议 | ⇒ `batch_tasks_add` 的非法输入（id 重复/为空、deps 成环或悬空、批不存在）一律抛**普通 Error**（不带 `GATE_` 前缀，**不进 66 码集合**）；唯一例外 = 批终态复用既有 `GATE_BATCH_TERMINAL`。校验本身**不放松**：建批期校验（`three-tier` 层族等）照旧由 `buildWavePlan` 拦 |

### 7.4.2 ★ `wave_plan_revise` 上下游审计 ⇒ 裁定**舍弃**

> 触发：2026-09-21 12:4x 用户指示「`wave_plan_revise` 可能不是通过审核的设计，查看其上下游，如果和既有设计冲突则舍弃」。

**溯源（上下游全景）**

| 项 | 事实 | 坐标 |
|---|---|---|
| 唯一出处 | `_research/punky-engine-design-basics-vs-jiuwen-ontology-assessment.md` **§2 提案①「返工回路用 gap-list 表达 ＋ 追加 lane 覆盖」**；工具载体见该稿 §5 **P-2** | 评估稿 `:60` / `:301` |
| 传播路径 | 路线稿触点 #13 引用为「新增 1 个工具（如 `wave_plan_revise`）」→ 本文件 §7.4 触点 #13 | 路线稿 `:153` |
| **仓内引用** | **零实现、零其它引用**（全仓 grep 仅命中本施工单自身；已排除 `node_modules`/`.git`/`.tsbuild`） | 【实测】 |
| 上游前置三件 | (a) `gapKind` 改词（避 `blocking` 撞车）(b) gap-list 从 `audit/` 迁 `plan/` (c) 上下文靠既有三件（gapList + 原 lane 产物 + `handoff.assertions`） | 评估稿 `:79` / `:93` / `:103` |
| 上游借鉴 | M-4「投递时**按真源现渲染**，不带上下文快照」 | 评估稿 `:124-129` |
| 下游被引用面 | 仅路线稿 **R4-1（追加 lane）/ R4-2（加边）** ⇒ 即本施工单触点 #13 | 路线稿 `:157-158` |

**★ 冲突三条 ⇒ 命中你的舍弃条件**

1. **出生目的与 K3 正面冲突**：提案①标题逐字是「**返工**回路…＋ 追加 lane 覆盖」（`:60` 标题、`:114` 「返工 lane 的 `consume = [gapList, 原 lane 产物]`」）。而 **K3 裁定**：`rework` **不进引擎**，返工 = **gap-list + 新任务批次**；追加 lane **只承担同批增量、不承担返工**。N0.5 已去返工边、`attempt` 已登记为**能力已移除** ⇒ 该工具的主用例在法律上已不存在。
2. **前置 (b) 与既有裁定相反**：§2.3(b) 主张 gap-list 从 `audit/` 迁 **`plan/`**；既有口径是 gap-list 落 **`audit/`**（`discipline.md` 逐字「唯一未决项载体」，产出者 **supervisor**）。该迁移当时未被采纳。
3. **前提已被 N0.5 推翻**：§2.1 取证首条「返工边**仍在役**（`schema.ts:38-47`）」⇒ 现已去除。

**裁定：`wave_plan_revise` 舍弃** —— 不做、不复审、不进 N1。舍弃的不仅是实现，**还包括这个名字本身**（它自带返工语义，复用会持续误导）。

**保留的能力（不冲突，日后另立）**：K1 红线本来就允许「**显式留痕的图修订**」（显式调用 + 单次原子写 + `reason/author/revision` + 落 `events[]` + 变更后重跑建批期校验）。⇒ 若 N1 后确需「同批追加 lane」，立**中性命名**工具（暂拟 `batch_tasks_add`），并在工具 `description` 里显式声明**不承担返工**（返工 = gap-list + 新批次）。

**登记**：进 `implemented-inventory` §4「不要重做」**第 7 条**（防日后重新提出）。

### 7.5 N1.5 施工单：plan 产出规格本地化（A3 方案①）

| 项 | 内容 |
|---|---|
| **落点** | 新增/改写 **plan 产出规格模板**：保留 `spec-writing` 13 章骨架，但把 `## Acceptance Criteria` → **`## 验收标准`**、`## Requirements`/`### Non-Functional` → **`## 约束`**（其余章节名可保留英文，引擎只判这两章） |
| **零行为变更** | 引擎判据（`gates.ts:903` / `:994`）**一字不动** ⇒ 不触 W6 冻结 |
| **待裁** | ① 模板落点：引擎包内新增 `presets/**`（**归资产会话**）vs 会话侧 skill 文件（`~/.jiuwenswarm/agent/workspace/skills/spec-writing/`）vs 包内 `docs/` 只给映射表 ⇒ **建议先只落「映射表」（包内 `docs/`，零归属争议），模板本地化等资产会话** |
| **验证** | 取一份按映射表产出的 spec，实测 `GATE_PLAN_CONTRACT` **放行**；同时实测照原英文规格产出**仍被拒**（负向对照，证明判据未松动） |

---

## 7.6 三项裁定执行（B1 / A3 / A4，2026-09-21 22:2x 用户拍板）

**用户裁定原文**：① `deps` 层序约束全局化，但团队资产全部搁置，等引擎形态落地再说；② plan 产出规格按宿主侧 `spec-writing/SKILL.md`，判据改为全中文，且配置化；③ A4 §2.3 按建议（「已派发即冻结 + 池内自由」确认）。

### 7.6.1 B1 · deps 层序约束 **全局化** ✅

- `wave-plan.ts#buildWavePlan` 启用 `validateDepsStructure`（此前注释停用）⇒ **建批期 + 追加期（`addPoolTasks`）+ 加边期（`addTaskEdges`）同一套结构约束**（已声明在先 + 同层或上游；generic 不参与层序；自指/悬空仍由 `topoWaves` 报，不抢答）。
- **影响面实测（全量）**：4 条非环境类失败，**全部属团队资产**——`writing-team A2/A3运行面/A4` + `team-assets-fill A4`，根因同形：夹具的 `prod1(exec) deps→a1(audit)`（「审核通过才开产」的既有合法形态）被全局层序约束拒。
- **团队资产整块搁置**（用户裁定）：4 条用例**原样保留、不 skip、不改判** ⇒ **跑红即预期、忽略**；每条用例上方已加 `【预期红·搁置·B1】` 显式登记注释（原因 + 解冻条件 = 引擎形态定稿并重定团队资产依赖形态）。⇒ **验收口径临时改为：`fail = 4（团队资产预期红）+ 环境类偶发 ⇒ 非团队资产/非环境类 fail = 0`**；恢复 `fail = 0` 口径的时点 = 团队资产解冻。

### 7.6.2 A3 · 判据全中文 + 配置化 ✅（规格与判据解耦）

- **单一真源**：`flows.js` 新增 `ENGINE_BASELINE_CRITERIA_SECTION = '## 验收标准'`；`ENGINE_BASELINE_PLAN_SECTIONS` 改为从它**派生**（首项恒为 criteria 章）⇒ 「验收标准」章节名全仓只剩**一个字面量**。
- **锚点门** `GATE_AUDIT_CRITERIA_MISSING`（`gates.ts`）：章节名 = `flow.audit_contract.criteria_section`（**新声明键**）优先，缺声明回落基线常量；`problems` 按声明章节名逐字指名。
- **契约门** `GATE_PLAN_CONTRACT`（`gates.ts` 缺声明分支）：原两行硬编码改为遍历 `ENGINE_BASELINE_PLAN_SECTIONS`（单点派生，不再写字面量）。
- `team-asset.js`：`audit_contract.criteria_section` 类型校验（非空字符串，`TEAM_ASSET_BAD_TYPE` fail-closed）。
- **产出规格中文化**：`docs/plan-spec-template-2026-09-21.md` —— 宿主侧 `spec-writing/SKILL.md`（英文 13 章）的中文对应物，含英中对照表与两处结构归并说明（`Non-Functional`+`Key Dependencies` → `## 约束`）；`presets/**` 不在处置范围（归资产会话）。
- **配置化通道汇总**：plan 层 `contract.required_sections`（既有）+ audit 层 `audit_contract.criteria_section`（新）⇒ 团队用英文章节名只需资产声明，**代码零改动**。
- 新测试 `test/plan-criteria-config.test.js` **6/6**：C1 常量真源 / C2·C3 锚点门声明覆盖（正负例 + 逐字指名）/ C4 缺声明回落（只认中文，且证明 plan/audit 两通道独立）/ C5 契约门 `required_sections` 声明覆盖（正负例）/ C6 非法类型拒载。

### 7.6.3 A4 §2.3 ✅ 按建议确认（无施工）

- K1「已派发即冻结 + 池内自由」获确认 ⇒ 蓝图 §2 全章口径**不变**；§8-1 闭合。

### 7.6.4 验收

- `lib/**` diff = `wave-plan.ts/js`（启用调用）+ `flows.js`（常量派生）+ `gates.ts/js`（两门配置化）+ `team-asset.js`（新键校验）；`git diff --stat -- lib` 均已在案。
- 判据面回归 7 套件 **110/110**；配置化套件 **6/6**；全量数字见施工快照（fail = 4 预期红 + 环境类偶发）。

---

## 8. 待裁 / 未取证（本文件不闭合）

| # | 事项 | 我的建议 |
|---|---|---|
| 1 | ~~§2.3 解读确认~~ | ✅ **已裁**（2026-09-21 22:2x）：按建议确认「已派发即冻结 + 池内自由」，见 §7.6.3 |
| 2 | 池载体是否取 **P-A**（池 = `owner==null` 视图，非独立结构） | 取 P-A；P-B 撞 H3 |
| 3 | 任务最小粒度判据（防碎） | 「一个可验收产物」+ `task_split` 继承验收标准 |
| 4 | 任务指纹 `sig` 的入参集合 | 建议 `SHA-256(deps + owner + 验收标准 + 规格引用)`；**未取证** |
| 5 | **`adjudication E4`**：官方 `maxMembers` 槽位是否真拦 | 未实证 ⇒ N3 必做；**不得**据「声明有」推断「真拦」 |
| 6 | 路线稿 U-1..U-6 未取证项 | 进 N1 前置取证，不得当证据用 |
| 7 | ~~N0.5 是否现在开工~~ | ✅ 已开工（2026-09-21 11:1x），结果见 §7.3.1 |
| **8** | ~~★ 恢复路径断裂族~~ | ✅ **已裁**（2026-09-21 11:5x）：取方案①的**派发面**、否决其**门禁面**，见 §8.8 |
| **9** | ~~★ N1 开工前置冲突~~ C-1·C-2 已裁；**C-3**（N0 三项）：§2.3 ✅ 已确认（§7.6.3）、P-A 与防碎判据已随 K1 间接确认 ⇒ **全部闭合**；**C-4**（sig 入参）未裁（N3 前） | C-1 ⇒ 见 **§7.4.2**（`wave_plan_revise` **舍弃**）；C-2 ⇒ **冻结**并登记 `frozen-register` R4-3 行 |

### 8.8 ★ 恢复路径断裂族（去返工边的系统性代价）—— ✅ 已裁

**现象**：`review` 现在只能 → `merged`/`conflict`/`failed`，但既有实现把 `review` 当作「**待重试中间态**」用了至少两处：

1. `lib/engine/dispatch.js:287` —— 派发失败回滚 `setMember(..., 'review')`，错误提示「`review→running` 为既定返工入口，直接重派」⇒ 去边后**提示失实 + 重派被拒**，lane 卡死。
2. 门禁拒后（`exit` 门 produce 缺失等）lane 停在 `review`，补产物后需再 `running` ⇒ 被拒（即 4 条未闭合测试的成因）。

**三选一（须裁）**：

| 方案 | 形态 | 判读 |
|---|---|---|
| **① 拒后即终态**（K3 严格） | 派发失败 / 门禁拒 ⇒ lane 置 **`failed`** | **拆分采纳**（见下） |
| ② 拒后留在 `running` | 被拒时**不写** `review` ⇒ 修因后直接 `merged` | ❌ 不取：与「review = 已提交待判」语义冲突 |
| ③ 换中间态 `idle` | 新增 `review→idle` | ❌ 不取：**返工边换皮**，与 K3 精神直接冲突 |

**★ 裁定（方案①拆分）**：

- ✅ **采纳①的「派发面」**：`dispatch.js` 派发失败 ⇒ 回滚目标 `review` → **`failed`**。理由：派发异常回滚**不是门禁拒**，本就在写状态；`running→failed` 在表内 ⇒ **零新增边**；且 `review` 是非终态，回滚到它会让 lane **卡死且无法重派**（正是去边后的死路）。
- ❌ **否决①的「门禁面」**（即「门禁拒 ⇒ 置 failed」）：撞既有纪律 **「门禁拒 = 零写入」**——`test/batch-store.test.js:317` 明写 `assert.equal(b.lanes.e1, 'review', '成员态不变（拒 merged 不改状态）')`，且 `GATE_SETTLE_NOTE_MISSING` 等一系列拒码都以「零写入」为前提。改它会推翻一族既有语义，远超 N0.5 范围。
- ⇒ **门禁拒后 lane 停在 `review`（非终态）不是缺陷，而是「零写入」的既有语义**；恢复路径按 K3 = **gap-list + 新任务批次**，原地重来本就是 K3 要禁的东西。4 例测试按此改判（断言「拒 = 状态不变 + 重派被拒 + 新批次可结算」）。

**连带结论**：`attempt` 升级标记（「≥3 次打回」）派生自 `review→running` 事件计数 ⇒ 去边后**该派生源消失**，`laneAttempts` 恒无计数。处置：**登记为「能力已移除」**（`outcome-typing.test.js` C5-4 已改判为「attempt 无派生源」）；若 N1 后确需该能力，另立派生口径（按新批次计数）。

**环境类失败（与去边无关，单独登记）**：本轮全量出现 `fatal: invalid reference: punky/orch` 类失败 **16 例**（`worktree-tools` 7 + `merge-agent` 9 + `resume` 2）。受控实验：把 PortableGit 2.55.0.windows.3 置 PATH 首位后**仍 7/7 失败** ⇒ **git 版本归因二次证伪**（与 §7 环境缺陷登记一致），根因仍未定性。

---

## 9. 验收判据（形态层）

1. §8 七条全部有裁决或明确标注「未取证」。
2. 任一波施工后：`git diff --stat -- lib` 有 diff 时须说明**是否触碰 §1 硬约束**；触碰即回本文件改判并留痕。
3. 全量测试 `fail = 0`；形态波允许**基线数值变化**，但须先重生成基线再跑（防 `e2-1`/`e2-2` 误红）。
4. 任何解冻动作须回 `docs/frozen-register-2026-09-21.md` 逐项改判留痕。
