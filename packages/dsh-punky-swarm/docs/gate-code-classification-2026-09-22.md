# 门禁码全量分类清单（N2 收口 · 可达性标准，2026-09-22 02:2x，待裁决）

**方法**：全库 `GATE_*` 字面量普查（lib js+ts 写点 / test 命中）去重 **112** 项，按可达性四分类标准 + 噪声/退役扩展类逐码归类；分类机器枚举 + 人工精修映射（`.tmp-run/gate-cls-final.json` 为机读底稿）。

## §0 总览与裁决请求

| 类 | 数量 | 处置建议 | 是否须裁 |
|---|---:|---|---|
| A1 拒码·在役（union 29 + 直抛 30） | **59** | **保留**（内核运行必要门禁） | 否 |
| A2 事件留痕码 | **6** | **保留**（治理观察面） | 否 |
| B 被遮蔽/内部分支 | **3** | 保留现状（R3-2 既有登记+绊线） | 否 |
| B 零断言（事件型） | **5** | **判定更正（04:3x）**：四件实有断言（事件字符串口径）；manager_missing 已删 | 否 |
| C 退役/历史 | **8** | 注释保留 + 统一【已退役码·勿引用】前缀标记 | **✅ 须裁** |
| D 模板/哨兵/常量 | **10** | 保留（拼接面/哨兵面） | 否 |
| N 非守卫（配置键/解析器/兼容标记） | **21** | scanner 白名单剔除（防统计污染「66/112」口径） | **✅ 须裁** |

## §1 类型一致性设计题 · 结论（按同一标准闭合）

`artifactTypeOf`/`typesOfLayer` 的唯一接线点 = gates 产物**类型一致性**校验（produce ∈ typesOfLayer(layer)）。按可达性标准判定：输入**可构造但未被要求**（在役门禁已核 produce **在场性**，类型一致性是治理加强而非内核运行必要）⇒ **建议：不新增拒码、不接线，两符号永久降级为声明/读视图面**（`artifact_types` 工具读视图已在役）。**待裁确认**。

## §2 全量清单（112 行）

### A1 拒码·在役+断言（29）—— GateErrorCode union 成员，在役拒态写点 + 测试断言 ⇒ **内核运行必要，保留**

| 码 | prod | test | 写点 |
|---|---:|---:|---|
| `GATE_AUDIT_CRITERIA_MISSING` | 9 | 10 | assembly\flows.js · assembly\team-asset.js |
| `GATE_PLAN_CONTRACT` | 9 | 33 | assembly\flows.js · state\gates.js |
| `GATE_SETTLE_NOTE_MISSING` | 5 | 7 | engine\auto-settle.js · state\store.js |
| `GATE_COMPLETE_AUDIT_FAILED` | 7 | 15 | engine\auto-settle.js · state\gates.js |
| `GATE_EXIT_SPAWN_FAIL` | 8 | 8 | state\command-exec.js · state\command-exec.js |
| `GATE_EXIT_TIMEOUT` | 5 | 5 | state\command-exec.js · state\gates.js |
| `GATE_EXIT_NO_COMMAND` | 19 | 19 | state\command-exec.js · state\gates.js |
| `GATE_EXIT_FORBIDDEN` | 7 | 8 | state\command-exec.js · state\gates.js |
| `GATE_ENTRY_MISSING` | 14 | 54 | state\event-types.js · state\gates.js |
| `GATE_HANDOFF_MISSING` | 25 | 26 | state\event-types.js · state\gates.js |
| `GATE_COMPLETE_OUTCOMES_EMPTY` | 12 | 5 | state\event-types.js · state\event-types.js |
| `GATE_TOKEN_UNKNOWN` | 13 | 17 | state\gates.d.ts · state\gates.js |
| `GATE_VOCAB_INVALID` | 12 | 5 | state\gates.d.ts · state\gates.js |
| `GATE_NEEDHUMAN_PENDING` | 19 | 14 | state\gates.js · state\gates.js |
| `GATE_AUDIT_INPUT_MISSING` | 13 | 15 | state\gates.js · state\gates.ts |
| `GATE_EXIT_NONZERO` | 4 | 19 | state\gates.js · state\gates.ts |
| `GATE_TARGET_MISSING` | 7 | 9 | state\gates.js · state\gates.js |
| `GATE_TARGET_UNCHANGED` | 7 | 11 | state\gates.js · state\gates.js |
| `GATE_COMPLETE_NO_AUDIT` | 4 | 3 | state\gates.js · state\gates.ts |
| `GATE_EXIT_PENDING_AUDIT` | 4 | 6 | state\gates.js · state\gates.ts |
| `GATE_COMPLETE_EXEC_PENDING` | 4 | 3 | state\gates.js · state\gates.ts |
| `GATE_EXEMPT_NOT_DISPATCH` | 9 | 14 | state\lane-exempt.js · state\store.js |
| `GATE_EXEMPT_INVALID` | 6 | 5 | state\lane-exempt.js · state\lane-exempt.js |
| `GATE_EXEMPT_TYPE_UNKNOWN` | 9 | 4 | state\lane-exempt.js · state\lane-exempt.js |
| `GATE_EXEMPT_REVOKE_REQUIRED` | 5 | 6 | state\lane-exempt.js · state\store.js |
| `GATE_BATCH_REQUIRES_C` | 3 | 10 | tools\core.js · types\contracts.d.ts |
| `GATE_MEMBER_REQUIRES_C` | 3 | 6 | tools\core.js · types\contracts.d.ts |
| `GATE_EXIT_MISSING_EXEC` | 2 | 12 | types\contracts.d.ts · types\contracts.ts |
| `GATE_EXIT_MISSING_AUDIT` | 2 | 3 | types\contracts.d.ts · types\contracts.ts |

### A1 直抛拒码（30）—— store/tools 直抛码（typed 面之外），在役写点 + 断言 ⇒ **内核运行必要，保留**

| 码 | prod | test | 写点 |
|---|---:|---:|---|
| `GATE_DISPATCH_FAILED` | 3 | 5 | engine\dispatch.js · engine\dispatch.js |
| `GATE_DISPATCH_CAPABILITY_MISSING` | 1 | 5 | engine\dispatch.js |
| `GATE_DISPATCH_PROVIDER_INVALID` | 1 | 1 | engine\dispatch.js |
| `GATE_MODE_INACTIVE` | 3 | 15 | engine\dispatch.js · engine\suite.js |
| `GATE_BATCH_TERMINAL` | 15 | 11 | state\dangling.js · state\event-types.js |
| `GATE_PLAN_PRESENCE_MISSING` | 15 | 9 | state\event-types.js · state\gates.js |
| `GATE_ORPHAN_PRODUCT` | 16 | 19 | state\event-types.js · state\gates.js |
| ~~`GATE_SKILL_MISSING`~~ | ~~6~~ | ~~7~~ | ~~state\event-types.js · tools\core.js~~ ⇒ **2026-09-27 已退役，见 §3** |
| `GATE_CONTRACT_MISSING` | 5 | 9 | state\event-types.js · state\store.js |
| `GATE_ESCAPE` | 4 | 19 | state\event-types.js · state\gates.js |
| `GATE_DEGRADE` | 4 | 10 | state\event-types.js · state\gates.js |
| `GATE_LANE_NOT_IN_PLAN` | 8 | 6 | state\gates.js · state\gates.js |
| `GATE_ARTIFACT_OUTSIDE_ROOT` | 6 | 2 | state\gates.js · state\gates.js |
| `GATE_ARTIFACT_NOT_A_FILE` | 10 | 5 | state\gates.js · state\gates.js |
| `GATE_ARTIFACT_EMPTY_NO_REASON` | 6 | 6 | state\gates.js · state\gates.js |
| `GATE_PLAN_NO_DECLARATION` | 4 | 3 | state\gates.js · state\gates.js |
| `GATE_LANE_LAYER_MISSING` | 2 | 17 | state\gates.js · state\gates.ts |
| `GATE_EXIT_NO_DECLARATION` | 4 | 7 | state\gates.js · state\gates.ts |
| `GATE_COMPLETE_NO_TIER` | 4 | 14 | state\gates.js · state\gates.js |
| `GATE_EVENT_CONST_MISSING` | 5 | 12 | state\store.js · state\store.js |
| ~~`GATE_TEAMS_ROOT_ASSET_NOT_FOUND`~~ | ~~3~~ | ~~5~~ | ~~tools\core.js · tools\core.js~~ ⇒ **2026-09-27 已退役，见 §3 第 8 条** |
| ~~`GATE_TEAMS_ROOT_INVALID`~~ | ~~7~~ | ~~10~~ | ~~tools\core.js · tools\core.js~~ ⇒ **2026-09-27 已退役，见 §3 第 7 条** |
| `GATE_ROLE_ASSEMBLY_MISSING` | 12 | 13 | tools\core.js · tools\core.js |
| `GATE_ASSEMBLY_INVALID` | 30 | 22 | tools\core.js · tools\core.js |
| `GATE_AUDIT_CONTRACT_MISSING` | 2 | 5 | tools\core.js · tools\core.js |
| `GATE_EXEC_INPUT_MISSING` | 3 | 6 | tools\core.js · tools\core.js |
| `GATE_BATCH_CONTROL_ACTION_INVALID` | 1 | 3 | tools\core.js |
| `GATE_DIFFICULTY_MISMATCH` | 4 | 5 | tools\core.js · tools\core.js |
| `GATE_ROLE_MANAGER_AS_LANE` | 4 | 6 | wave-plan.js · wave-plan.js |
| `GATE_PAIRING_CARDINALITY_DRIFT` | 2 | 3 | wave-plan.js · wave-plan.ts |

### A2 事件留痕（4）—— gate.* 事件留痕码（非拒码）：治理观察面 ⇒ **保留**

| 码 | prod | test | 写点 |
|---|---:|---:|---|
| `GATE_ROLE_INVALID` | 35 | 46 | assembly\flows.js · assembly\team-asset.js |
| `GATE_ROLE_MISSING` | 19 | 56 | assembly\flows.js · assembly\team-asset.js |
| `GATE_MANAGER_ROSTER_GAP` | 2 | 5 | state\event-types.js · tools\core.js |
| `GATE_AUDIT_CONTRACT_EXEMPT` | 5 | 9 | state\event-types.js · tools\core.js |

### A2 留痕事件码·在役+断言（2）—— 同上（事件型）⇒ **保留**

| 码 | prod | test | 写点 |
|---|---:|---:|---|
| `GATE_EXIT_MISSING` | 3 | 2 | state\event-types.js · state\store.js |
| `GATE_COMPLETE_BLOCKED` | 3 | 2 | state\event-types.js · state\store.js |

### B 被遮蔽（2）—— ② 参数面先拒（R3-2 登记 + 绊线）⇒ **保留现状**

| 码 | prod | test | 写点 |
|---|---:|---:|---|
| `GATE_DIFFICULTY_INVALID` | 2 | 3 | tools\core.js · tools\core.js |
| `GATE_DIFFICULTY_RATIONALE_MISSING` | 2 | 4 | tools\core.js · tools\core.js |

### B 被遮蔽(内部分支)（1）—— 不可达内部分支（台账已登记「刻意不补」）⇒ **保留现状**

| 码 | prod | test | 写点 |
|---|---:|---:|---|
| `GATE_NO_DECLARATION` | 2 | 1 | state\gates.js · state\gates.ts |

### B 零断言(事件)（5）—— ① 可达（输入可构造）但零断言 ⇒ **保留 + 补测缺口**（R3g 既裁方向；补测时机随活体批）

| 码 | prod | test | 写点 |
|---|---:|---:|---|
| `GATE_MANAGER_MISSING` | — | — | **✂ 已删（2026-09-22 用户裁定；防回生锁在册）** |
| `GATE_TARGET_BLOCKED` | 3 | 0 | state| **判定更正（2026-09-22 04:3x）**：事件字符串断言在案（gates/batch-store/gate-spawn-fail/panel-render）——原「零断言」系普查口径漏判（大写码常量 grep 漏小写事件字符串） |event-types.js · state\store.js |
| `GATE_TARGET_PASSED` | 3 | 0 | state| **判定更正（2026-09-22 04:3x）**：事件字符串断言在案（gates/batch-store/gate-spawn-fail/panel-render）——原「零断言」系普查口径漏判（大写码常量 grep 漏小写事件字符串） |event-types.js · state\store.js |
| `GATE_EXIT_BLOCKED` | 3 | 0 | state| **判定更正（2026-09-22 04:3x）**：事件字符串断言在案（gates/batch-store/gate-spawn-fail/panel-render）——原「零断言」系普查口径漏判（大写码常量 grep 漏小写事件字符串） |event-types.js · state\store.js |
| `GATE_NEEDHUMAN_BLOCKED` | 3 | 0 | state| **判定更正（2026-09-22 04:3x）**：事件字符串断言在案（gates/batch-store/gate-spawn-fail/panel-render）——原「零断言」系普查口径漏判（大写码常量 grep 漏小写事件字符串） |event-types.js · state\store.js |

### C 退役(注释)（7）—— 码已退役、仅注释/测试残留 ⇒ **建议：注释保留 + 统一前缀【已退役码·勿引用】标记**（防 grep 误判活码）——待裁

| 码 | prod | test | 写点 |
|---|---:|---:|---|
| `GATE_SUBAGENT_OUTSIDE_LANES` | 8 | 2 | bridge\dispatch-register.js · bridge\dispatch-register.js |
| `GATE_CONCURRENCY_EXCEEDED` | 3 | 7 | engine\dispatch.js · state\event-types.js |
| `GATE_SWARM_UNBOUND_REPORT` | 2 | 3 | tools\core.js · types\contracts.ts |
| `GATE_MANAGER_TERMINAL` | 1 | 1 | tools\core.js |
| `GATE_TEAM_ASSET_MISSING` | 0 | 3 | — |
| `GATE_MANAGER_PHASE_INVALID` | 0 | 1 | — |
| `GATE_MANAGER_AGENT_ID_REQUIRED` | 0 | 1 | — |

### C 退役(已入防回生锁)（2）—— **2026-09-27 补登**（原 A1 直抛 ⇒ 退役；事由 / 依据见 §3 第 7、8 条）

| 码 | prod | test | 写点 |
|---|---:|---:|---|
| ~~`GATE_TEAMS_ROOT_INVALID`~~ | ~~7~~ | ~~10~~ | ~~tools\core.js~~ ⇒ **2026-09-27 退役：`lib/**` 零字面量命中、已入 `RETIRED_CODES`（防回生）** |
| ~~`GATE_TEAMS_ROOT_ASSET_NOT_FOUND`~~ | ~~3~~ | ~~5~~ | ~~tools\core.js~~ ⇒ **同上（同批退役）** |

### C 事件常量冻结(历史读端)（1）—— 事件常量冻结保留（历史批磁盘读端不变）⇒ **保留**

| 码 | prod | test | 写点 |
|---|---:|---:|---|
| `GATE_CONCURRENCY_BLOCKED` | 3 | 1 | engine\dispatch.js · engine\dispatch.js |

### D 模板前缀（7）—— 拼接模板前缀（GATE_EXIT_MISSING_ + layer）⇒ **保留**（候选码拼接面）

| 码 | prod | test | 写点 |
|---|---:|---:|---|
| `GATE_EXIT` | 3 | 0 | state\event-types.js · state\store.js |
| `GATE_EXIT_MISSING_` | 4 | 1 | state\gates.js · state\gates.js |
| `GATE_EXIT_` | 3 | 1 | state\store.js · tools\core.js |
| `GATE_TEAMS_ROOT_` | 3 | 0 | tools\core.js · tools\core.js |
| `GATE_AUDIT_CONTRACT_` | 0 | 3 | — |
| `GATE_TEAM_ASSET_` | 0 | 5 | — |
| `GATE_ROLE_` | 0 | 7 | — |

### D 模板/哨兵（1）—— 哨兵码/模板 ⇒ **保留**

| 码 | prod | test | 写点 |
|---|---:|---:|---|
| `GATE_STANDALONE_UNJUSTIFIED` | 14 | 11 | state\gates.js · state\gates.js |

### D 哨兵（1）—— 同上

| 码 | prod | test | 写点 |
|---|---:|---:|---|
| `GATE_ARTIFACT_MISSING` | 14 | 1 | state\gates.js · state\gates.js |

### D 非守卫常量（1）—— 常量非守卫（台账已剔除）⇒ **保留现状**

| 码 | prod | test | 写点 |
|---|---:|---:|---|
| `GATE_ROW_HEADROOM` | 3 | 0 | auditlog\sink.js · auditlog\sink.js |

### N 配置键（7）—— 配置键名（非门禁码）⇒ **建议：scanner 白名单剔除**（防统计污染）——待裁

| 码 | prod | test | 写点 |
|---|---:|---:|---|
| `GATE_WINDOW_MS` | 4 | 2 | auditlog\sink.js · auditlog\sink.js |
| `GATE_MAX_WINDOW_MS` | 4 | 2 | auditlog\sink.js · auditlog\sink.js |
| `GATE_ENABLED` | 22 | 30 | index.js · index.js |
| `GATE_TIMEOUT_MS` | 1 | 4 | state\command-exec.js |
| `GATE_RETRY` | 1 | 1 | state\command-exec.js |
| `GATE_MAX_OUTPUT_BYTES` | 1 | 4 | state\command-exec.js |
| `GATE_ENV` | 5 | 5 | wave-plan.d.ts · wave-plan.js |

### N 解析器常量（4）—— 解析器/常量（非门禁码）⇒ **同上**——待裁

| 码 | prod | test | 写点 |
|---|---:|---:|---|
| `GATE_FORBIDDEN_RE` | 2 | 0 | state\command-exec.js · state\command-exec.js |
| `GATE_LINE_RE` | 15 | 2 | state\gates.d.ts · state\gates.js |
| `GATE_EMPTY_LINE_RE` | 9 | 2 | state\gates.d.ts · state\gates.js |
| `GATE_OFF_LINE_RE` | 4 | 0 | state\gates.js · state\gates.js |

### N 解析器片段（1）—— 同上

| 码 | prod | test | 写点 |
|---|---:|---:|---|
| `GATE_PASSED` | 3 | 1 | state\event-types.js · state\store.js |

### N 常量（7）—— 同上

| 码 | prod | test | 写点 |
|---|---:|---:|---|
| `GATE_REPO_ROOT` | 4 | 11 | state\gates.js · state\gates.js |
| `GATE_TARGETS_MODE` | 4 | 9 | state\gates.js · state\gates.js |
| `GATE_CODES` | 6 | 4 | state\lane-exempt.js · state\lane-exempt.js |
| `GATE_COUNT_FILE` | 0 | 4 | — |
| `GATE_MARKER` | 0 | 4 | — |
| `GATE_KINDS` | 0 | 2 | — |
| `GATE_RUNTIME_JS` | 0 | 4 | — |

### N 兼容标记（2）—— legacy 兼容标记（非拒码）⇒ **保留现状**

| 码 | prod | test | 写点 |
|---|---:|---:|---|
| `GATE_HANDOFF_LEGACY_PASSTHROUGH` | 1 | 2 | state\store.js |
| `GATE_HANDOFF_SETTLE_LEGACY_PASSTHROUGH` | 1 | 5 | state\store.js |

---
**口径说明**：`prod` = lib js+ts 字面量写点数（含注释命中——退役码正是靠此暴露）；`test` = test/** 命中数。与 reachability 台账（119 守卫全集）/ 门禁拒码 66 口径不同源，本表为**全量字面量**口径（最宽，用于必要性裁决）。

---

## §3 追加：2026-09-27 变更（用户裁「按既有退役流程补登」）

> **背景**：本台账落于 2026-09-22；此后引擎有 3 批变化未回写。本节补登，**处置流程沿用本文件既有机制**
> （数据源 = 本文件，加码 = `test/retired-codes-lock.test.js` 的 `RETIRED_CODES`）。

| # | 码/族 | 本台账原位置 | **2026-09-27 现状** | 处置 |
|---|---|---|---|---|
| **1** | **`GATE_SKILL_MISSING`** | A1 直抛 | **代码已彻底移除**（提交 `b8380a8`，用户裁「技能 recommend 不再设门禁」） | ✅ **已加入退役锁** + 本表 A1 行已标删 |
| **2** | **`TEAM_ASSET_*`（19 个）** | A1 / D / N 分散 | **`team-asset` 方案全面弃用**（2026-09-27 用户裁决，见 `reports/decision-team-asset-retire-20260927.md`） | ⏸ **随弃用 4 批计划的批 3** 清（删码表 + 断引用 + 入退役锁） |
| **3** | **`GATE_CONCURRENCY_EXCEEDED`** | C 退役 | 已在退役锁（`:31`） | ✅ 无动作（**记录以免再次被误判为孤儿码**） |
| **4** | **`GATE_CONCURRENCY_BLOCKED`（事件常量）** | — | 常量**冻结**（读历史批用，无新写点），见 `chain-retirement-and-topology-20260918.md:111` | ✅ 无动作（**有意冻结，非废码**） |
| **5** | **判据面变更** | — | `ENGINE_BASELINE_PLAN_SECTIONS` 由 2 项扩为 **6 项**（提交 `7060ab0`）⇒ `GATE_PLAN_CONTRACT` 的**判定集合扩面**（**码本身未变**） | 📝 登记（**码面无新增**） |
| **6** | **拒态文案变更** | — | 四处拒绝路径（`GATE_PLAN_CONTRACT` / `GATE_HANDOFF_MISSING` / `GATE_ENTRY_MISSING` / `GATE_AUDIT_CRITERIA_MISSING`）**追加「【怎么做】」指引项**（提交 `892afcb`） | 📝 登记（**只加文案，判据集合逐字不变**） |
| **7** | **`GATE_TEAMS_ROOT_INVALID`** | A1 直抛（`tools\core.js`；prod 7 / test 10） | **已退役**（2026-09-27）。**原语义** = 显式 `teamsRoot` 词法 / 防逃逸**拒建批**（非空绝对路径 / 不含 `..` 段 / 标签须 kebab-case / 资产路径越界双保险）。**退役事由** = 用户裁「`team` 降为**可选标签**（内容宽松）⇒ **相关门禁做退役处理**」，本码属 A 级「立即可退役」：拒态家族随 `team` 可选化整体退出工具面——**判据逐字保留**，出口由 `throw` 改**纯判定返回值**（`teamsRootLexicalProblem`，恒不抛；不可用 ⇒ `TEAMS_ROOT_IGNORED` 留痕 + 不写批次键）。**依据** = 用户裁决（覆盖性快照 `reports/decision-team-optional-and-gate-retire-20260927.md` §三 A 级）+ 本批（工作树基线 `4412a9f`；提交由 Leader 复核后进行） | ✅ **已加入退役锁**（`RETIRED_CODES` 9 ⇒ 11）+ 本表 A1 行标删、C 类已收 |
| **8** | **`GATE_TEAMS_ROOT_ASSET_NOT_FOUND`** | A1 直抛（`tools\core.js`；prod 3 / test 5） | **已退役**（2026-09-27，与第 7 条同批）。**原语义** = 显式 `teamsRoot` 下 `<teamsRoot>/presets/<team>/team-asset.{json,yml}` **均不存在** ⇒ 拒建批（不回落包内 `presets/`）。**退役事由** = 承接函数 `assertTeamsRootAsset` **未接线**（全仓无 import / 调用 / 测试引用）+ 工具面出口早已降级为「无资产」路径 + `TEAM_ASSET_NOT_FOUND` 留痕 ⇒ 本批删函数即**两码在 `lib/**` 归零**。**依据** = 同上（用户裁决覆盖性快照 §三 A 级 + 本批） | ✅ **已加入退役锁**（同批 9 ⇒ 11）+ 本表 A1 行标删、C 类已收 |

> **同批实测补注（不改写历史读数）**：D 模板前缀行 `GATE_TEAMS_ROOT_`（本表 §D，2026-09-22 计数 prod 3 / test 0）的写点已随本批**归零**（三函数删/改后，`lib/**` 不再拼该家族前缀）；该行按「历史普查读数」原样保留。
> **自证读数（2026-09-27 本批）**：`lib/**` 两码**零字面量命中**（含注释）；`RETIRED_CODES.length` = **11**。

**⇒ 处置纪律（沿用本文件 §0）**：**A 类保留 / C 类退役入锁 / N 类 scanner 白名单剔除**；新增退役码**只需入 `RETIRED_CODES`**。
