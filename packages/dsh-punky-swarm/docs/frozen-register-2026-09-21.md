# 冻结登记 · 2026-09-21（R2 清理波）

> 本文件是**冻结项的单一台账**。冻结 = 「已声明但当前不接线 / 不修改 / 不删除」，等新引擎形态定后逐项裁定。
> **纪律：本表内任何符号不得被当作 AI 幻觉产物删除。** 撤销冻结必须回到本表逐项改判并留痕。

- 基线：`e3e8cd0` → 清理波后 `5a6ce2a` → 台账修正 `c995832`
- 裁定依据：W2（未接线不接）/ W4（schema 随新引擎形态取舍）/ ②（无断言门禁：复核后**不删**，冻结）/ ①（B1 残留 10 项先留着）/ ③（审计追踪：生成器入库 + `REGISTER_OUT` 预览 diff 比对；**本脚本无 `--check` 档**，`--check` 属 `gates.mjs`）
- 生成器：`scripts/audit/gen-register.mjs`（2026-09-21 由 gitignore 的 `out/` 迁入版本控制 ⇒ 登记可复现）
- 复现：`node scripts/audit/dead-code2.mjs && node scripts/audit/classify.mjs && node scripts/audit/gates.mjs && node scripts/audit/gen-register.mjs`

---

## 1. C1 · 生产未接线（9 项，W2 冻结 → **✅ 已判读（N2 第一批，2026-09-22）**）

> **裁定已落**：逐项三选一终裁见 `docs/c1-wiring-audit-2026-09-22.md`（真接线 0 / 降级登记 22 / 缓·设计题 2 / 删 1 缓至第二批）。蓝图「6 守卫接线」意向经代码证据全部修正（双判定源/探针信号面/sig 自愈缓存）。本节清单保留作历史存档。

判据：**生产路径零调用，仅测试引用**（且本文件内部也不使用）⇒ 声明面先行、运行面欠账。

> **⚠ 标题数与下方表格数是「现扫读数」**（随 `dead-code2` 每次跑动而变）：2026-09-22 判读当刻为 **26 项**，其后因团队资产退役（`lib/assembly/chain.js` 整文件删除等）与 C1 判读落地而减少 ⇒ **两者不是同一集合**，勿按标题数推定表格内容。

| 文件 | 符号 | 测试引用 | ts 源 |
|---|---|---:|---|
| `lib/assembly/flows.js` | `clearFlowCache` | 28 | — |
| `lib/assembly/flows.js` | `clearRoleCache` | 12 | — |
| `lib/engine/dispatch.js` | `memberDispatchBudgetKeyOf` | 10 | — |
| `lib/auditlog/sink.js` | `auditlogStats` | 9 | — |
| `lib/schema.js` | `canTransitionBatch` | 9 | ✅ |
| `lib/state/store.js` | `fileIdentityOf` | 8 | — |
| `lib/artifact-types.js` | `ARTIFACT_TYPES` | 6 | — |
| `lib/auditlog/sink.js` | `sinkFilePath` | 1 | — |
| `lib/governance/escalation.js` | `DEFAULT_ESCALATION_WINDOW_MS` | 1 | — |

### 其中特别标注（属测试基础设施，不可删）

- `lib/bridge/lane-handle.js` `__resetLaneHandles`（66 处测试调用）、`sweepExpiredHandles`
- `lib/assembly/flows.js` `clearFlowCache`（67 处）、`clearRoleCache`（85 处）——测试隔离必需

### 新引擎成型时的裁定口径（三选一，逐项落）

1. **接线**：有安全价值者（`assertMemberTransition` / `assertBatchTransition` / `artifactTypeOf` / `typesOfLayer` / `sweepExpiredHandles` / `clear*Cache`）。参考 jiuwen `agent_teams/tools/task_manager.py` 的 `TaskResult` / `GraphMutationResult`——变更返回**显式结果对象**而非仅 throw。
2. **降级**：测试专用面显式登记为测试钩子（去 `export` 则断测试，故只能保留）。
3. **删**：无价值者（`validateAssembly` / `assertAssemblyCompleteness` 撤函数**保常量表**——`BLIND_REVIEW_ROLES` 被 `wave-plan.ts` 消费、`PRODUCE_LAYERS` / `FLOW_SECTIONS` 被 `team-asset.js` 消费）。

**【2026-10-08 订正】**（批 `engine-techdebt-cleanup-20261008` · `R-3@techdebt2`）：上述「三选一」的**第 3 项（删）未执行**，且与**第 2 项（降级保留）**构成**自相冲突** —— 第 2 项主张「测试专用面显式登记为测试钩子（**去 `export` 则断测试，故只能保留**）」，第 3 项主张「删」。`assertAssemblyCompleteness` 的处置**以 `docs/rebuild-blueprint-2026-09-21.md:91` 为准**（「`validateAssembly` / `assertAssemblyCompleteness` | 删函数保常量表 | **冻结**（W2 明示"再考虑重新引入或清理"）。常量表已列入保留」）⇒ **判「留」**。两处原文**均保留可读**（史实不删）。

---

## 2. B1 残留 · 真死但自带声明语义（0 项：B1 已按 Q-9@closeout 清零）

判据：**内外皆零引用，但注释自带显式声明语义**（预留格式 / 骨架契约 / 白名单 / 外部规范对齐 / 版本口径 / 读端契约名）⇒ 删除等于替用户裁定「这声明还要不要」。

**0 项 —— B1 已按裁决 `Q-9@closeout`（2026-10-23，用户选「7 条全删」）清零**：原 7 项由批 `punky-closeout-20261023` 删除（**显式覆盖** 2026-09-21 冻结裁定①，非静默推翻）。本节标题与下方两段原文**保留作历史对账**；「撤销冻结必须回本表改判」的入口不变（新入册符号照常补行）。

**裁定 ①（2026-09-21）**：**先留着，等新引擎落地再议** —— 这些符号的存废取决于新形态是否还需要该声明面，属设计决策而非清理决策。

**批注（`punky-fix-p2-20261023` / `A1-P2-12`，2026-10-23）**：本批**不覆盖**裁定①，只按裁决做两件事 —— ①4 枚 `FORWARD_*_DEFAULT` **保留**，理由列改写为诚实表述（外部规范对齐表 / 仓内零消费 / 勿据以推断行为）；②「豁免清退」reason 常量（值 `exempt-cleared`）**删除**：仓内零读零写，且该字面值与实写 reason `explicit-revoke` 不一致 ⇒ 留着会诱导未来读端按错误字面量比对而恒 false（探针读端实际走事件名 + `laneExemptCleared` 字段，不读 reason）。

**【2026-10-23 · 批 `punky-closeout-20261023` 覆盖】**：上述裁定①与 p2 批注里的「保留」口径**已被 `Q-9@closeout` 覆盖** —— 7 项（`assemblyFromTeamAsset` / 4 枚 `FORWARD_*_DEFAULT` / `workerResumeChapter` / `renderVerdictReport`）已删除，本表清空。两段原文一律保留（史实不删），但**勿据以判现状**。

---

## 3. 无断言门禁（0 个，冻结）

判据：**有生产引用但测试零断言**。硬拒收口门漏断言 = 白盒测试绿 ≠ 生产路径走过。

**口径（2026-09-21 v3 定稿）**：台账**拒码真源 = `lib/types/contracts.ts` 的 `GateErrorCode` union**；
正则 `\bGATE_[A-Z0-9_]+\b` 只作**候选收集器**，候选再按「出现上下文」分类，非码一律移出本口径。
本表 = `kind ∈ {typed, thrown}` + 有生产引用 + 测试零命中。逐项判读见下。

**两次勘误（均由「乐观污染」触发：让『没覆盖』看起来像『已覆盖』）**：
- v1（原始）在**源码原文**上计数 ⇒ **注释里提到某码**也算「有断言 / 有生产引用」。实测：在新增测试的注释里写一句 `GATE_ARTIFACT_MISSING`，其 `testHits` 由 0 变非 0，`--check` 误报「已消除无断言项」。
- v2 **去注释**（`scripts/audit/gates.mjs` 的 `shieldComments`；刻意**不**去字符串——断言普遍写成 `'GATE_X'` 字面量，必须计入）。
- v3 **改用拒码真源**：正则把 `GATE_*` 的**非码标识符**也当码收，实测混入 14 个（正则常量 4 · 环境变量名 7 · 前缀伪影 2 · 已退役码留痕 1）。
  · 环境变量名（**不是码**）：`GATE_ENABLED`（逃生阀）· `GATE_REPO_ROOT` · `GATE_TARGETS_MODE` · `GATE_TIMEOUT_MS` · `GATE_RETRY` · `GATE_MAX_OUTPUT_BYTES` · `GATE_FORBIDDEN_RE`
  · 正则常量（**不是码**）：`GATE_OFF_LINE_RE` / `GATE_EMPTY_LINE_RE` / `GATE_LINE_RE` / `GATE_SCRIPT_SHA_RE`
  · 前缀伪影：`GATE_EXIT_` / `GATE_EXIT_MISSING_` 是源码模板拼接（`'GATE_EXIT_MISSING_' + layer`）被正则截成的残片
  · 已退役码留痕：`GATE_DIFFICULTY_DOWNGRADE_BLOCKED`（`lib/types/contracts.ts:415-428` / `lib/state/store.js:930` 逐字记「已删除」）

**P0 两枚**（收口主门，此前零断言 ⇒ 已由 R3-1 补**生产路径 E2E 断言**离榜）：`GATE_COMPLETE_EXEC_PENDING` / `GATE_COMPLETE_NO_AUDIT`（`test/complete-tier-gate-e2e.test.js`）。
> 原记「P0 三枚」，第三枚 `GATE_ARTIFACT_MISSING` 经复核为**假缺口**：它是出口门内部哨兵，按设计被重写为 `GATE_EXIT_MISSING_<LAYER>` 才外显，而该外显形态已有 12 处断言 / 3 套件（`GATE_EXIT_MISSING_AUDIT` 3 · `GATE_EXIT_MISSING_EXEC` 9）。

| 门禁码 | 类别 | 拦什么 | 生产引用点 |
|---|---|---|---|

**裁定（2026-09-21，替代原 W6「都删」）**：**不删，冻结至新引擎落地**。

- 原裁定「无断言门禁都删」所依据的清单（上游报告记 15）**含 2 个前缀伪影**（`GATE_EXIT_` / `GATE_EXIT_MISSING_`，模板拼接 `'GATE_EXIT_MISSING_' + layer` 被正则截出的残片），照字面执行会去删两个不存在的码。
- 去伪影后逐枚实地看过（v2 口径 11 项），抛出点**全在生产路径上** —— 收口主门 ×2（exec 未终态 / 无 audit ⇒ 拒 complete）、判据门、建批门（exec 未消费 `plan/`）、工具门 ×2（`assign_check` 难度档位与判据）、fail-closed 守卫（事件常量缺位 ⇒ 拒写入）、留痕/告警码 ×3、哨兵 ×1。其中两枚收口主门已由 R3-1 补测离榜，余 9 项为**裁定当刻**的冻结面（该 9 项已由 R3 波逐枚处置，结果见下「进展」；本表标题与表格是**台账实测**，故数字随补测推进而减）。
- 它们 `testHits = 0` ⇒ **删除效果无法由测试判定**（可能静默放行，也可能被别的门先拦而"看起来没变化"）⇒ 属**静默回归风险**，不是等价重构；且删门禁是**行为变更**，与蓝图 §2「修改/重构 = 本波不做」冲突。

**勘误链**：上游甄别报告记「15 个」→ v1 台账（含注释污染 + 前缀伪影 + 非码标识符）**15** → v2 去注释 **11** → v3 拒码真源口径 **9**（其中两枚收口门已由 R3-1 补测离榜）。

**进展（R3 波，2026-09-21）**：本表 9 项已逐枚判读处置 ⇒ **余 2 项刻意不补**（`GATE_ARTIFACT_MISSING` 假缺口 · `GATE_NO_DECLARATION` 不可达内部分支）。
判读口径「真缺口 ⇒ 补测 / 断言松动 ⇒ 收紧 / 不可达 ⇒ 只登记 + 绊线」与逐枚证据见 `docs/gate-assertion-blueprint-2026-09-21.md`：
§6（R3-2 判读表）· §6.1（`GATE_DIFFICULTY_*` 分层口径，**2026-09-21 §11.2 勘误：非失实**）· §8（R3-3 判据「两处」勘误 + fail-open 缺口）· §9（R3-4 真 E2E）· §11（A1/A2/A3 用户裁定）。

| 波 | 覆盖 | 处置 |
|---|---|---|
| R3-1 | `GATE_COMPLETE_EXEC_PENDING` · `GATE_COMPLETE_NO_AUDIT` | 生产路径 E2E ⇒ **离榜** |
| R3-2 | `GATE_EXEC_INPUT_MISSING` · `GATE_SKILL_MISSING` · `GATE_HANDOFF_SETTLE_LEGACY_PASSTHROUGH` · `GATE_EVENT_CONST_MISSING` | 补测（末项为**降级覆盖**：围栏 + 前置面） |
| R3-2 | `GATE_HANDOFF_LEGACY_PASSTHROUGH` · `GATE_DIFFICULTY_RATIONALE_MISSING` | 收紧既有断言（补载荷码 / 锁全码） |
| R3-2 | `GATE_DIFFICULTY_INVALID` | **已登记分层口径**（内核分支命名，非外显契约）⇒ **保留 + 绊线**，不判失实（2026-09-21 用户裁定勘误，见 §11.2） |
| R3-2 | `GATE_ARTIFACT_MISSING` · `GATE_NO_DECLARATION` | **刻意不补**（假缺口·哨兵 / 不可达内部分支）⇒ 只登记 |
| R3-4 | `GATE_EVENT_CONST_MISSING` | 降级覆盖 ⇒ **真 E2E**（加载期改源 ×3 档 + 负向对照） |
| R4-3 | `rework_budget` 读端可见 | ⏸ **冻结**（2026-09-21 12:4x 用户裁定，**非作废**）：K3 后返工不进引擎、`attempt` 已登记为能力已移除 ⇒ 该预算**无数据来源**。解冻条件 = 以「**新批次计数**」另立口径且**不接回状态机** |

**本表冻结裁定一字未变**（不删、冻结至新引擎落地）：上述全部为**纯增量补测**，`lib/**` 零 diff、零门禁行为变更。

**解冻口径**：新引擎定型后按功能重议，**补测优先于删码**，且必须补**生产路径 E2E 断言**（不是白盒直调 `createGates`）。

参考：jiuwen `schema/status.py:274-302` 的**两个镜像闸**（`PLANNING` 前 / `IN_REVIEW` 后，逐字 structurally identical mirrors）⇒ 蟛蜞 entry/exit 对偶门应有对称断言组。

---

## 4. schema 循环依赖（W4 冻结，给决策树）

**实测**：`lib/schema.ts:244` 注释逐字承认 `lib/schema.ts ⟷ lib/assembly/schema.js` **顶层循环依赖**（assembly 顶层初始化需本文件常量，静态 import 会 TDZ）。现靠运行时时序侥幸，属结构性定时炸弹。

| 新引擎形态 | 处置 |
|---|---|
| 保留独立的 `assembly` 层 | 把 assembly 顶层初始化所需常量**下沉为独立叶子模块**（`lib/state/constants.js` 已是先例），让 `schema.ts` 单向依赖 |
| 并入其他层 | 随并层自然消失，不需专门消环 |
| 本波 | **不动**（动 `schema.ts` 波及 43 个门禁码的类型面，须独立波 + 独立 commit） |

参考：jiuwen `workflow/engine/primitives.py:67` `_MAX_WORKFLOW_DEPTH = 1`（子工作流 = 独立脚本 + 自己的 META）⇒ **用文件边界切依赖层**；与 Onto `SUB_FLOW_CALL` 不得成环（v6 `:2530`）同构。

---

## 5. C2 · 白盒面（200 项，非冗余，登记备查）

判据：**仅测试引用，但本文件内部已消费** ⇒ `export` 多余却**不可去**（去 export 会断 200 处测试引用）。

> 判读：这 200 项把「未接线」这件事**测没了**——测试直捅内部实现，测试绿只证明内部函数对，不证明生产路径走了它。
> 这是 0 个无断言门禁（§3）的同一枚硬币另一面，处置同归 §3 裁定（冻结至新引擎落地）。

---

## 6. 冻结项处置纪律

1. **不得删**：本表 §1 / §2 / §3 的符号在后续任何「清理 AI 幻觉产物」的 wave 中**一律跳过**，除非回到本表对应行改判并留痕。§5 的 200 项仅可去 `export` 之念，不可去 `export` 之实（会断测试引用）。
2. **不得静默接线**：接线属行为变更，须新引擎形态先定 + 独立 commit + 补对应测试。
3. **改判留痕**：撤销冻结时，在本文件对应行加「解冻日期 + 依据 + commit」。
4. **单一强制点**：接线时不得新写一套，必须接既有实现（`tools/core.js:349` 逐字「禁各写一套」）。
5. **不得以「无断言」为删除理由**：`testHits = 0` 只证明**测试没覆盖**，不证明**代码是死的**。缺断言 ⇒ 先补测（生产路径 E2E），补完再判要不要删。

> 【自动保留】本节为人工注记，由 gen-register 原样搬运，不参与重生成。

## 后期订正

> 【2026-10-23 · 批 punky-closeout-20261023 回填】本节的「不重生成正档」前提**已由本批执行**：
> 正档 §2 已按 `Q-9@closeout` 重生成（**10 → 0**）。本节保留作**历史对账**，其中「正档 10 项 /
> 实扫 7 项」为 2026-10-23 前的读数，**勿据以判现状**。

> 【2026-10-23 · 批 `punky-fix-house-20261023`（H-E）】本节只**追加**，不改写上方历史。
> 动机：§2 标题「B1 残留（10 项）」是 **2026-09-21 的实测**；此后经团队资产退役与 B 批清理，实扫已变
> （**正档 10 项 / B 批前实扫 8 项 / B 批后实扫 7 项**）。本节把正档与实扫逐条对账，使**差额可追溯**，
> **不重生成正档** —— 重生成 = 另开批：`scripts/audit/gen-register.mjs` 会**整档覆写**，且会把 chain 退役、
> B 批等历史漂移混入同一笔 diff，违背「一批一事」与「不改写历史」。

### B1 对账（正档 10 项 + 实扫新入 1 项 = 11 行）

| 符号 | 位置（正档行） | 现状 | 原因分类 | 证据 |
|---|---|---|---|---|
| `CHAIN_VERSION` | §2 | **已离册** | **已删** | `lib/assembly/chain.js` **整文件删除**（`ec4efc2` 团队类引擎内资产全量退役）；生产 / 测试 / 脚本零引用，仅 `scripts/audit/gen-register.mjs` 的 `WHY` 映射与 docs 留痕 |
| `CHAIN_GUIDANCE_INJECTS` | §2 | **已离册** | **已删** | 同上（同一文件同批删除） |
| `flowsDeclarationOf` | §2 | **已离册** | **仅注释提及**（非「生产调用」） | `lib/assembly/flows.js` 定义 + 同文件注释自陈；`dead-code2` 判 `selfUse:1` ⇒ `classify.mjs` 归 **B2**（B1 判据要求 `selfUse === 0`）⇒ **属扫描器未去注释的口径副作用**，见下「待修口径」 |
| `assemblyFromTeamAsset` | **无此行** | **在册** | **从未登记**（反向差额） | `lib/assembly.js` 定义；B1 实扫**新入册**，正档缺此行 |
| `FORWARD_DEPTH_LIMIT_DEFAULT` | §2 | 在册 | 一致 | 零引用（外部规范对齐表） |
| `FORWARD_FANOUT_LIMIT_DEFAULT` | §2 | 在册 | 一致 | 同上 |
| `FORWARD_EACH_TIMEOUT_MS_DEFAULT` | §2 | 在册 | 一致 | 同上 |
| `FORWARD_TOTAL_TIMEOUT_MS_DEFAULT` | §2 | 在册 | 一致 | 同上 |
| `workerResumeChapter` | §2 | 在册 | 一致 | 骨架声明（`enabled:false`） |
| `renderVerdictReport` | §2 | 在册 | 一致 | 预留落盘格式 |
| `REASON_EXEMPT_CLEARED` | §2 | **已离册** | **已删（B 批）** | `9aba643` 逐字删除该 `export const` ⇒ 解释「B 批后 8 → 7」 |

**差额恒等式**：正档 10 − 已删 3 − 仅注释 1 + 反向新入 1 = **实扫 7**。

### 复算口径（不写死行号）

- **B1 判据**（`scripts/audit/classify.mjs`）：`prod + testUse + other === 0` **且** `selfUse === 0`。
- **复算命令**：`node scripts/audit/dead-code2.mjs && node scripts/audit/classify.mjs` ⇒ 读 `out/unwired-summary.json` 的 `B1` 数组。
  ⚠ 该两步**会写 `scripts/audit/out/`**（`.gitignore` 覆盖）；只读环境请在整包副本内跑，或跑完 `rm -rf scripts/audit/out`。
- **2026-10-23 实测**（本批在**整包副本**内重生成取得，未污染真仓 `out/`）：`B1 = 7` —— `assemblyFromTeamAsset`、`FORWARD_DEPTH_LIMIT_DEFAULT`、`FORWARD_FANOUT_LIMIT_DEFAULT`、`FORWARD_EACH_TIMEOUT_MS_DEFAULT`、`FORWARD_TOTAL_TIMEOUT_MS_DEFAULT`、`workerResumeChapter`、`renderVerdictReport`。
- **删除了哪个提交**：`git log --oneline -S 'REASON_EXEMPT_CLEARED' -- lib`（命中 `9aba643`）；chain 面用 `git log --oneline --diff-filter=D -- lib/assembly/chain.js`（命中 `ec4efc2`）。
- **本文件 §1 / §3 的口径不受本节影响**：本节只对账 §2，不重判 §1（C1 · 生产未接线）与 §3（无断言门禁）。

### 一条待修的口径副作用（登记 followup，本批不修）

`selfUse` 计数**未去注释** ⇒ 「在注释里提一句自己的名字」即可把符号从 B1 移出（`flowsDeclarationOf` 即此形态：
其 `selfUse:1` 来自**注释**，不是调用）。属 `scripts/audit/dead-code2.mjs` 的**口径缺陷**；修它会改变历史分类结果 ⇒
须单开批处理，本批只登记**不动手**。同理留意的还有 `gates.mjs` 的 `shieldComments`（§3 已登记去注释口径）——
两处口径**方向不一致**（一个去注释、一个不去），属同一族欠账。
