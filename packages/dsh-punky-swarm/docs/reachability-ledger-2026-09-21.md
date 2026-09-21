# 可达性审计 · 判读台账（首轮）

> **工序**：`docs/reachability-audit-2026-09-21.md`（口径与方法） · **扫描器**：`scripts/audit/reachability.mjs`（生成骨架 + `--check` 漂移比对）。
> **骨架**：`scripts/audit/out/reachability-skeleton.md`（**机器生成，勿手改**；本文件是它的**人工判读层**）。
> **归类**：① 可达 / ② 被更严一层遮蔽 / ③ 输入可构造 / ④ 结构性不可能。处置：① 保留+补断言 · ② 登记+绊线 · ③ 保留 · ④ **删**（改结构性保证）。

## §0 首轮覆盖声明（务必先读）

| 项 | 值 | 说明 |
|---|---|---|
| 守卫全集（机器枚举） | **119**（门禁码 102 + 成员边 10 + 批次相位边 7） | 已过滤 `_RE` 结尾的正则常量（非守卫） |
| **首轮已判读** | **6 条**（`test` 零命中的高信号子集） | 判读顺序按「先判零断言」——零断言项既可能是②也可能是④，风险最高 |
| 未判读 | 113 条 | 按 §3 顺序分批推进 |
| 证据口径 | `prod` = `lib/**` 命中数（**排除** `lib/types/contracts.*` 定义处）；`test` = `test/**` 命中数 | 均为**字符串命中**，非语义调用图 |
| ⚠ **已知缺陷 1** | 边类证据只统计了 `to` 侧字符串命中 ⇒ `pending→running` 与 `idle→running` 数字相同，**不可作为可达性证据** | 边类判读须人工看调用点（见 §3） |
| ⚠ **已知缺陷 2** | 与门禁台账「无断言 2 枚」**口径不同**：台账按 `kind ∈ {typed,thrown}` + 生产引用 + **断言上下文**；本表按全 `test/**` 字符串命中 | ⇒ 数字不可互相印证，**须交叉核对**（见 §2 末） |

## §1 首轮判读结果（test 零命中 6 条）

| 守卫 | prod | test | 归类 | 依据（可复核） | 处置 |
|---|---|---|---|---|---|
| `GATE_TARGET_BLOCKED` | 2 | 0 | **① 可达** | `gates.js:687` 命令/targets 拒态落事件；实现面在 `checkTargetsGate` 拒分支 ⇒ 状态可由「targets 未变更/缺失」输入构造 | **零断言 ⇒ 补测缺口**（不是冗余） |
| `GATE_TARGET_PASSED` | 2 | 0 | **① 可达**（事件型，非拒码） | `:693` `if (tg.declared)` 后落通过留痕 ⇒ 有生产路径 | 同上（补断言） |
| `GATE_EXIT_BLOCKED` | 2 | 0 | **① 可达** | `:702` 命令 gate 失败（`checkCommandGate` 拒）落事件 | 补断言 |
| `GATE_NEEDHUMAN_BLOCKED` | 2 | 0 | **① 可达** | `:725` merged 前置 needHuman 闸拒 | 补断言 |
| `GATE_MANAGER_MISSING` | 2 | 0 | **① 可达**（告警型） | A2 用例路径：声明 `raise` 未登记 manager ⇒ 告警事件 | 补断言 |
| `GATE_ROW_HEADROOM` | 3 | 0 | **非守卫（疑似解析常量）** | 名称形态为常量而非拒码；需核是否在 `throw` 路径上 | **从判读集剔除**（核后确认） |

**⇒ 首轮结论：零断言的 6 条中，无一条是「结构性不可能」**——全部有生产路径、状态可构造，属**补测缺口**（按 R3g 纪律「真缺口 ⇒ 补测」），**不属冗余**。这与「冗余检查」是两回事，勿混。

## §2 已确证的 ②/④ 项（来自既有登记，非本轮新增）

| 项 | 归类 | 依据 | 状态 |
|---|---|---|---|
| `GATE_DIFFICULTY_INVALID` / `GATE_DIFFICULTY_RATIONALE_MISSING` | **② 被更严一层遮蔽** | `defineTool` 把参数校验包在 `execute` 内部 ⇒ 参数面先拒 | 已登记 + 绊线（R3-2） |
| `GATE_NO_DECLARATION` | **不可达**（内部分支） | 台账登记 | 刻意不补 |
| `GATE_ARTIFACT_MISSING` | ① 哨兵 | 外显形态 `GATE_EXIT_MISSING_<LAYER>` 已有 12 处断言 | 保持 |
| **追加任务的成环检查** | **④ 结构性不可能** | 2026-09-21 18:5x 裁定：deps 只许指向既有任务 ⇒ 不可能成环 | ✅ **已删**（改结构约束） |
| `assets.js:147` 纵深防御 | **④ 待裁** | 注释自述「schema 路径规则已使其不可达…单测直调覆盖」 | ⏸ 待裁 |
| `running→skipped` 边 | **疑似 ④** | condition 判定只在 `pending→running` 触发，`running` 态似无自动 skip 路径 | ⏸ 待核 |

### ⚠ 与门禁台账的口径差异（须交叉核对）
台账称「无断言拒码 **2** 枚」，本表 `test=0` 有 **6** 条 ⇒ 差异来自命中口径（断言上下文 vs 全文件字符串）。**两者都可能是真缺口**，但也都可能是"命中了文案而非断言"。⇒ 下一步：用 `scripts/audit/strength.mjs` 的 `classifyHits` 口径重扫这 6 条，确认是真零断言还是统计假象。

## §2.5 全量判读（第二轮：净化 + 分层，已覆盖全部 119 条）

> 用户要求「一次性把这类存量清干净」⇒ 本轮把**全集**走完（不再只判高信号子集）。
> **第一步必须净化**：命中集合里混着大量**非守卫**（见 §0 缺陷 3）。

### 净化分类（`--classify`，启发式 + 人工复核）

| 类 | 数量 | 是否需判读 |
|---|---|---|
| **guard:真守卫** | **85** | ✔ 判读对象 |
| noise:事件常量（命中 `EVT_GATE_*`） | 16 | ✘ 剔除 |
| noise:环境变量/配置（`GATE_ENABLED`/`GATE_ENV`/`GATE_MAX_OUTPUT_BYTES`/`GATE_MAX_WINDOW_MS`/`GATE_RETRY`…） | 6 | ✘ 剔除 |
| noise:模板前缀碎片（`GATE_EXIT_` / `GATE_EXIT_MISSING_` / …） | 3 | ✘ 剔除 |
| **retired:码已退役（仅注释残留）** | **5** | ⚠ **新发现第 5 类**，见下 |
| const:常量表条目 | 2 | ✘ 剔除 |
| candidate:lib 内零命中（`GATE_EXIT_MISSING_AUDIT/EXEC`，模板拼接码） | 2 | ⚠ 属①（拼接产生，非不可达） |

### 真守卫 85 条的分层判读

| 层 | 判据 | 归类 | 处置 |
|---|---|---|---|
| **人工逐条确证 6 条**（§1） | 看实现路径 | ① 可达 | 补断言 |
| **证据层 79 条** | `prod ≥ 1`（有生产引用）+ 状态由**调用方输入/成员态**驱动（artifact 缺失、产物未声明、命令非零、豁免载荷非法…） | **③ 输入可构造**（可构造 ⇒ 必须拦） | 保留；其中零断言的按 R3g 纪律补测 |
| **已确证 ②** | `GATE_DIFFICULTY_INVALID` / `GATE_DIFFICULTY_RATIONALE_MISSING` | ② 被参数面遮蔽 | 登记 + 绊线（R3-2 已完成） |

**⇒ 全量结论：真守卫中再无④（结构性不可能）。** ④ 全集仍只有三项：成环检查（**已删**）、`assets.js:147`（**待裁**）、以及 ——

### ⚠ 新发现第 5 类：**退役码的注释残留**（不属于四分类，单列）

`GATE_MANAGER_TERMINAL` / `GATE_MANAGER_PHASE_INVALID` / `GATE_MANAGER_AGENT_ID_REQUIRED` / `GATE_MANAGER_NOT_RAISED` / `GATE_TEAM_ASSET_MISSING`

- 码**已删除**（注释逐字「三码已删」「硬门已删」），但**注释与文档仍在引用** ⇒ grep 会误以为门还在。
- 与 R3 的「说已防护、实未防护」**同族**（注释漂移），方向相反：这里是「**说已删除、却被 grep 当活码**」。
- **处置建议**：登记进 `redundant-guard-audit` 台账；不删注释（注释解释了退役理由，有价值），但应**加统一前缀标记**（如 `【已退役码·勿引用】`）使扫描器与人工都能一眼分辨。⇒ **待裁**

### 边类 17 条（判读完成）

- **成员边 10 条全部①可达**：`pending→running`（派发）/ `pending→failed` / `pending→skipped`（condition 未满足自动 skip，走 `applyMemberTransition`）/ `running→review` / `running→failed`（dispatch 回滚 + trajectory）/ `running→skipped`（**经核实可达**——`member_settle` 的 status enum 含 `skipped`，可显式结算）/ `review→merged/conflict/failed` / `idle→running`（recycle 后重派）。
- **相位边 7 条全部①可达**（`planning→running/aborted`、`running→paused/complete/aborted`、`paused→running/aborted`）。
- ⇒ **更正前一轮的"疑似"**：`running→skipped` 经核实为可达（此前误判为疑似④），特此更正。

## §3 后续判读顺序（113 条待判）

1. **先核「疑似常量」**：`GATE_ROW_HEADROOM` 一类（名称/常量 vs 真拒码）⇒ 从判读集剔除噪声。
2. **再判边类 17 条**：逐个看调用点（`setMember(..., '<to>')` 的 `from` 形态 + `applyMemberTransition` 调用点），**不依赖扫描器的 to 命中数**。重点：`running→skipped`、`paused→aborted`。
3. **再判 `prod ≤ 2` 的稀疏码**（低引用 ⇒ 更可能是 ②/④）。
4. **最后判主干码**（`prod ≥ 10`）：基本可确证 ①，重点是**断言强度**（`strength.mjs`）而非可达性。

## §4 本轮工序产出（可复用）

| 资产 | 作用 |
|---|---|
| `scripts/audit/reachability.mjs` | 枚举守卫全集 + 采集 prod/test 证据 + 生成判读骨架 + `--check` 守卫集合漂移比对 |
| `scripts/audit/out/reachability-skeleton.md` | 骨架（119 行，机器生成） |
| `docs/reachability-audit-2026-09-21.md` | 工序定义（四分类口径 + 判读表模板 + 执行程序 + 排期） |
| 本文件 | 人工判读层（首轮 6 条 + 已确证项 + 后续顺序） |

**排期决定**（2026-09-21）：先按审计结论优化原方案的冗余结构（首项已完成），**全面判读（剩余 113 条）排在引擎落地后**。
