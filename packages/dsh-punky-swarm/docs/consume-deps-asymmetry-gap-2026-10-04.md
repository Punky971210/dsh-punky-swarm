# 缺口登记：`consume` × `deps` 不对称（首建批面）⇒ 交接边永久不可补

> 编号：**GAP-CONSUME-DEPS-2026-10-04**
> 类型：**指引缺口（Leader 侧建批规范）+ 引擎候选护栏**（**不是上游内核缺陷**；上游缺陷见同目录 `upstream-defects.md`，本项与 dsh / cordis 无关）
> 状态：**已裁决**（2026-10-04 grilling 六条落定；裁决口径、两条偏离的推演与施工编制见同目录 `consume-deps-asymmetry-assessment-2026-10-04.md` **§8**；落地批次 `consume-deps-guard-20261004`）
> 落盘：`docs/consume-deps-asymmetry-gap-2026-10-04.md`（本文件）
> 复现环境：Windows，Node v24.18.0，引擎仓 HEAD `75f5c9c6`（落盘时工作树 clean）
> 附件口径：证据全部来自**近两日两个真实批次**的事件流与产物根，均为实测，非推断。

---

## 0. 一句话

**建批期若某 lane 的 `consume` 引用了同批他 lane 的产物，但未在 `deps` 声明对应边 ⇒ 该交接边永远不会成立**；且因为「加边要求上游未结算」「删边不提供」，**一旦上游 lane 结算，该缺口即不可逆**——引擎不校验这个不对称，指引也未写明首建批必须核，故已在两批中连续复现（第二次是本项的触发事件）。

---

## 1. 与既有条文的关系（**先说明为什么这不是重复项**）

`presets/punky-preset/references/discipline.md` **已有**同族条文，但**只覆盖「建批后追加 lane」面**：

> **规则**：**建批后追加 lane**（修复 / 补做）时，**同批**做两步并留痕：① 更新目标 **audit lane 的 `consume`**（纳入追加产物的逐条路径）；② 声明**追加 lane → audit** 的**入边**（`deps`）……
> **反例**：本会话实测 **同一批内 3 次追加、0 条规则** ⇒ 追加 lane 的产物**既无 DAG 出边、也不在 audit 的 `consume` 内** ⇒ `handoff_submit` 被 `GATE_HANDOFF_MISSING` 拒……
> —— `discipline.md` 该节（追加 lane 面）

**本项是同一不对称在「首建批」面的镜像情形**，两处差异使既有条文**不覆盖**它：

| 维度 | 既有条文覆盖面（追加 lane） | 本项（首建批面） |
|---|---|---|
| 发生时机 | `wave_plan` 建批**之后**追加 | `wave_plan` **建批当时** |
| 方向 | 「产物不在 audit 的 `consume` 里」为主 | 反向：**`consume` 里有产物，但 `deps` 没有边** |
| 可补救性 | **可补**（同批补两步：consume 纳入 + 声明边并留痕） | **不可补**（见 §3）——这是本项独立于既有条文的关键 |

⇒ 建议做法**不是新写一套**，而是把既有条文里的规则**上升为一般规则**并挂到 §12「建批规范（Leader 必做）」的建批时点（见 §5.A）。

---

## 2. 现象与实证（两个真实批次）

### 2.1 实例一：`openmaic-fork-upstream-update-20261003`（首现）

- 建批声明：`p02-impact-merge-plan` 的 `consume = ['plan/upstream-delta-inventory.md']`，但 **`deps = []`**（p01 是它的上游产物来源，边未声明）；`p01/p02 → a01` 亦无边。
- 表现：① 引擎反复落 `lane.handoff.gap GATE_HANDOFF_MISSING`（`edge:p01-baseline-delta->a01-audit-verify`、`edge:p02-impact-merge-plan->e01-merge-execute`）；② p01 的 worker 尝试向 a01 与 p02 各交一次，**两次均被 `GATE_HANDOFF_MISSING` 拒**（它照实登记、未强行造边 —— **下游行为正确**）。
- 登记：该批 audit `gap-list` 的 **A-G-07**。

### 2.2 实例二：`openmaic-pivot-design-20261003`（本次触发）

- 建批声明（`a01-design-audit`，audit 层）：
  - `consume = ['plan/pivot-plan.md', 'plan/openmaic-capability-survey.md', 'plan/host-impact-survey.md']` —— **3 项，且按 §12 建批规范「audit consume = plan 判据源 + 上游产物」写成**
  - `deps = ['p03-pivot-plan']` —— **仅 1 条边**
- ⇒ 不对称：`consume` 引用了 p01 / p02 的产物，但**没有任何边**连接它们。
- 表现：① 引擎落 `lane.handoff.gap GATE_HANDOFF_MISSING`；② p01 的 worker 尝试 `handoff_submit p01→a01` 被拒，登记待裁（未造边）。
- 影响面：**不阻塞 a01 开工**（入口门只校验**已声明 deps** 的入边 = `p03→a01`，已于 `2026-10-03T16:2x` submitted）；另两份产物的在场性走独立校验。**损失的是可追溯性**：a01 的两个输入没有交接记录。

---

## 3. 为什么事后不可补（本项最硬的事实）

| 动作 | 引擎约束 | 后果 |
|---|---|---|
| `task_update` **加边** | 只对**未派发**任务生效，且要求**上游未结算**（终态 lane 无交接可等 ⇒ 该边结构性无法满足） | p01/p02 一 `merged`，这两条边**永久不可能**补 |
| **删边** | **不提供**（属重算） | 写错了只能留着 |
| `handoff_submit` **补交** | 须 `to` 的 `deps` 中已声明该边 | worker 想交也交不了（实例二已实测被拒） |

⇒ 因此这不是「晚点补上」的事：**首建批这一刻写对是唯一窗口**。

---

## 4. 危害分级

| 级别 | 危害 | 说明 |
|---|---|---|
| **低（不阻塞）** | a01 仍可开工 | 入口门只看已声明 deps；产物品走独立存在性校验 |
| **中（噪声）** | `lane.handoff.gap` 反复落盘 | 读端每看一次门禁就多一条缺口事件，污染缺口面信噪比 |
| **中（可追溯性）** | 输入无交接记录 | 下游「从谁那儿、拿到什么、承诺了什么断言」在黑板里缺一段 |
| **中（worker 挫败）** | worker 主动交接被拒 | 两次实测：worker 做了正确动作却拿到失败返回，须自行判断「是否要造边」（幸而两次都未被诱导造边） |

---

## 5. 建议改正（两条，**建议同时采纳**，但互为独立）

### A. 指引条文（必做，低成本）

**插点**：`presets/punky-preset/references/discipline.md` **§12「建批规范（Leader 必做，即时生效）」**（现文已列「每条 audit lane 的 `consume` 必须含 ① plan 判据源 ② 本链上游 exec 产物」），在其后补一条**对称性必核**：

> **建批规范补充（2026-10-04）：`consume` 与 `deps` 必须双向对齐** —— 建批时逐 lane 核：
> ① **正向**：`consume` 中**每一项**若来自同批某 lane 的 `produce ∪ outputs`，则**必须**在 `deps` 声明该 lane 的边（例外：该产物由**跨批 / Leader 直做**提供 —— 此时须在任务包写明来源，不声明边）；
> ② **反向**：`produce ∪ outputs` 中**每一项**必须被**至少一条同批 lane 的 `consume`** 引用（否则 `GATE_ORPHAN_PRODUCT`）。
> **判据（肯定式）**：`deps ⊇ { consume 项的 lane 来源 }`；命中条数 = `consume` 项的 lane 来源条数。
> **为什么必须在建批期核**：加边要求「上游未结算」、删边不提供 ⇒ 上游一结算，不对称即**不可逆**（见本仓 `docs/consume-deps-asymmetry-gap-2026-10-04.md` §3）。
> **与既有条文的关系**：本节是既有「**建批后追加 lane**」条文的一般化——同一条规则，打在**首建批**时点。

### B. 引擎候选护栏（可选，建议分两步）

| 步 | 内容 | 风险 |
|---|---|---|
| B-1（低风险，先做） | **建批期观察事件**：`wave_plan` 建批时，若某 lane 的 `consume` 命中了他 lane 的 `produce ∪ outputs` 而 `deps` 未含该 lane ⇒ 落观察事件（如 `gate.consume_deps_asymmetry`，**非拒态、不改相位**）+ 在 `wave_plan` 回显中双面呈现（类似既有 `gate.manager_roster_gap` / `managerRoster` 的做法），把静默不对称变成可见 | 低（只加观察面，零行为变更） |
| B-2（视 B-1 实测再定） | 升级为**建批拒态**（`GATE_CONSUME_DEPS_ASYMMETRY`） | 中（会拒掉历史写法的批；建议先跑 B-1 收集一段真实使用面再裁） |

> 判定单点建议落在**建批期**（`lib/wave-plan.js` 的建批校验路径，与 `GATE_ORPHAN_PRODUCT` / `GATE_AUDIT_INPUT_MISSING` 同层），**不要**二次判定（与「单点判定」纪律一致）。

---

## 6. 改后如何验证（判据）

1. **指引侧**：改 `references/discipline.md` 与 `agent.cordis.yml`（注入面）后**必须**跑 `node scripts/check-guidance-sync.mjs`，**GREEN（exit 0）才算收口**（§13 既有纪律；含 repo↔live 五件同 sha、注入面指针在正文存在、**反向下正文每个 `## §X` 在注入面有条目**）。
2. **规则侧（可达构造）**：造一个**必失败**的建批样例 —— 某 lane `consume` 写他 lane 产物、`deps` 留空 ⇒ ①（B-1）应见观察事件且 `wave_plan` 回显标记，②（B-2）应被拒建批；再造一个**必通过**样例（`deps` 补齐）⇒ 应无事件、建批成功。**两个构造缺一即空转**（§15⑤ 空转校验反模式）。
3. **回归面**：既有批（存量 `batch.handoffs` 缺字段者走 `legacy` 放行）**不得**因新护栏改变行为——须核历史批仍可读、可结算。

---

## 7. 待用户裁决项（每条含推荐）

| # | 裁决项 | 选项与代价 | 推荐 |
|---|---|---|---|
| **D-1** | 是否采纳 §5.A 指引条文 | 甲=采纳（改 `discipline.md` §12 + 跑 sync 检查；代价≈1 段文字 + 一次 lockstep 验证）／乙=暂不采纳（缺口继续靠 Leader 自觉） | **甲** |
| **D-2** | 是否同时采纳 §5.B 引擎护栏 | 甲=只做 B-1 观察事件（低风险）／乙=B-1+B-2 直接拒建批（有拒历史写法风险）／丙=都不做 | **甲（先 B-1）** |
| **D-3** | 已知两批的不对称是否追溯处置 | 甲=不追溯（按「死件不回填」口径，只在各自 gap-list 内保留登记）／乙=追溯补登记（无法补边，只能补文档） | **甲** |
| **D-4** | 本文件是否并入既有档案 | 甲=独立保留本文件（现状态）／乙=摘要并入 `docs/gap-list-2026-09-22.md` | **甲** |

> **不裁决的后果**：无阻塞——缺口不阻塞任何 lane 开工，只是持续产生缺口噪声与可追溯性损失；但**同类错误会第三次发生**（已连续两批）。
