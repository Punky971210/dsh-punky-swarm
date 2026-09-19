---
name: engine-team
description: |
  引擎团队指引（团队层 skill，与 software-team / design-team / research-team / writing-team 平级）：
  做 dsh-punky-swarm 引擎自身改造的团队——三层角色 designer / coder / reviewer / supervisor 的
  职责边界、每层技能装配（spec-writing、codebase-design、dev-coder、efficient-edit、
  review-execution、acceptance-gate、verification-before-completion 共 7 件）、
  产物契约（plan/ exec/ audit/）与交接门禁要点。
  装配数据（角色 × 层 × 技能 × flows × chain）的唯一来源是引擎团队资产
  `presets/engine-team/team-asset.yml`——本技能不复制该数据，只声明指针与用途。
  当需要确定引擎团队某角色"是谁/能做什么/不能做什么/成功标准/输出格式"，
  或需要按该团队的三层链路产出可核查的改造产物时加载本技能。
version: "1.0.0"
kind: skill
triggers:
  - "引擎团队"
  - "engine-team"
  - "引擎改造团队"
  - "引擎团队装配"
  - "引擎自身改造"
  - "引擎团队角色"
---

# engine-team — 引擎团队指引（三层角色 × 技能装配 × 产物契约）

> **装配数据唯一来源声明**：本技能**不承载**装配数据。角色/层/技能/flows/chain 的唯一权威是引擎团队资产
> `presets/engine-team/team-asset.yml`（随包分发，引擎按 `presets/<team>/team-asset.yml` 解析）。
> 本技能只写**用途、职责边界与契约**，避免"技能与引擎资产两处各写一份"造成漂移（口径同 `skills/software-team/SKILL.md`、
> `skills/research-team/SKILL.md`）。行为层（persona 纪律、三层门禁 Tier3、Manager 定义）由 dsh-punky-swarm 承担，本技能不重复。

## 团队定位（何时加载）

| 场景 | 本技能给什么 |
|---|---|
| Leader 选团队建批（`wave_plan({team:'engine-team'})`） | 该团队的层归属、角色集与产物契约 |
| Leader / Manager 派发 worker | 目标角色的职责边界、可用/禁用动作、成功标准与期望输出格式 |
| 引擎自身改造收口 | 判据来源：plan 的规格与验收标准 → exec 的实测读数 → audit 的逐条对照 |
| 排查"引擎团队角色缺操作手册" | 技能映射的**读端位置**与当前取值（真源在团队资产，不在本文件） |

## 三层角色（4 个声明角色，覆盖 3 层）

| 层 | 角色 | 职责（一句话） | 牵头 |
|---|---|---|:--:|
| plan | `designer` | 界定改造范围并写死**验收标准与约束**（可核判据 + 证据点），不写实现 | ✔ |
| exec | `coder` | 按 plan 规格实现变更，附**实测读数**与产物 | — |
| exec | `reviewer` | 按 plan 判据验证行为（跑校验与套件给读数）并做对抗式评审 | — |
| audit | `reviewer` | 验收：按 plan 判据**逐条对照**，未闭合项进 gap-list | ✔ |
| audit | `supervisor` | 交叉一致性核对 + 终门禁裁决（人审面） | — |

> `reviewer` 同时出现在 exec 与 audit 两层，`supervisor` 只在 audit 层——层归属以资产 `layers` 为准；
> 角色到技能的映射**只在资产里**，本文件不复制逐角色清单。

## 每层技能装配（7 件，按角色归层）

> 下表只列**层 → 技能**这层信息（可读摘要）；**角色 → 技能**的逐条映射以资产为准。

| 层 | 装配技能（加载名 = 宿主 `SKILL.md` frontmatter 的 `name`） | 该层要用它做什么 |
|---|---|---|
| plan | `spec-writing`、`codebase-design` | 写可被门禁接受的规格（必含裸标题 `## 验收标准` 与 `## 约束`）；先摸清被改造代码的既有形态再定方案 |
| exec | `dev-coder`、`efficient-edit` | 按规格落地实现；改动面收敛，只碰本 lane 写域，避免误覆写既有文件 |
| exec（验证/评审） | `review-execution` | 对照规格与验收标准做对抗式审查，输出结构化 verdict（approve / reject + blocking issues + followups），只读不改码 |
| audit | `review-execution`、`acceptance-gate` | 逐条判据对照；全量验收 + gap-list 对账后给出门禁结论 |
| audit（终门禁） | `acceptance-gate`、`verification-before-completion` | 收口前完成验证前置：未跑不得报数、未实测值不得预填，判据未闭合不得判通过 |

七件技能名汇总（便于核对）：`spec-writing` / `codebase-design` / `dev-coder` / `efficient-edit` / `review-execution` / `acceptance-gate` / `verification-before-completion`。

## 产物契约（三层，沿用引擎既有目录约定，不新增产物类型）

| 层 | 产物路径 | 契约要点 |
|---|---|---|
| plan | `plan/*spec.md` | 由资产 `flows.plan.contract` 强制：须含**独立裸标题行** `## 验收标准` 与 `## 约束`（编号/前缀变体一律被 `GATE_PLAN_CONTRACT` 拒）；进度快照落 `<lane>/progress/NN-<slug>.md` |
| exec | `exec/*.md` | **内容判据不来自资产**：`flows.exec.contract` 键**无运行期读点**（全仓 `contractOf` 只以 `plan` 调用：`lib/assembly/flows.js:503`、`lib/state/gates.js:778`）⇒ 该键已从本队资产**删除**（2026-09-18）；exec 的**硬门** = entry `consume` 在场 / exit `produce ∪ outputs` 在场 / `targets`（声明即核落盘）/ 命令 gate（产物独立行 `gate:`）。产物统一落批次产物根，进度快照落 `<lane>/progress/NN-<slug>.md` |
| audit | `audit/**` | 判据源取 `plan/**`（资产 `audit_contract.criteria_from`），且必须同时消费 `plan/` 与 `exec/`；verdict ∈ pass / fail / skip |

> 层间入口要求由资产 `flows` 强制（exec/audit 的 `entry_requires: ["consume"]`）：上游产物缺失时派发被拒
> （`GATE_ENTRY_MISSING`），这是门禁行为而非流程建议。audit 层另带 `needhuman`，收口需人工裁决证据。

## 链步形态（engine-team **自建** · 2026-09-18 用户裁决）

> 通用团队流程 = 一套共用骨架（`plan → exec → audit → accept`），**层内形态按队自建**（裁语：「exec 形态自建」）；
> 五队统一口径 = **exec 层内不限 lane 数量、分支间无 `deps`（可高并发并行）**（2026-09-18 用户裁决）。
> 本队 exec 形态 = **单步三分支并行**（`exec-coder` ∥ `exec-verifier` ∥ `exec-reviewer`）——与 software-team 的
> 「work 并行（coder ∥ tester）+ review 串行」并列，差别只在**分支数与角色集**，不在依赖形态。

| 序 | 链步 | lane id（= 分支 id，R-4 命名纪律） | 角色 | 产物与职责 |
|---|---|---|---|---|
| 1 | `plan` | `plan-designer` | designer | `plan/plan-designer-spec.md`——验收标准与约束（可核判据 + 证据点） |
| 2 | `exec` | `exec-coder` | coder | `exec/exec-coder.md`——实现变更 + 自证读数 |
| 2 | `exec`（同一步） | `exec-verifier` | reviewer | `exec/exec-verifier.md`——**独立复跑**套件/检查器，给原始读数（只读、不改码） |
| 2 | `exec`（同一步） | `exec-reviewer` | reviewer | `exec/exec-reviewer.md`——对抗式评审（对照 plan 判据） |
| 3 | `audit-pair` | `audit-exec-coder` / `audit-exec-verifier` / `audit-exec-reviewer` | supervisor | `audit/exec-coder.md` 等——按 plan 判据**逐条对照**（**逐分支各一条 lane**） |
| 4 | `accept` | `accept` | supervisor | `audit/acceptance-report.md`——交叉一致性核对 + 终门禁 |

- **为何是「一步三分支」而不是「三步串行」**：`pair_with` 只指向**步 id**，配对步按「上游步在本批的**每条 lane** 1:1」实例化（`lib/assembly/chain.js:821-836`）——一步三分支 ⇒ `audit-pair` 派生 **3 条** lane，audit 面**逐分支留痕**（口径同 software-team 的 Q-A1=③：配对对象 = 链末 exec 步的**全部** lane，不合并成一条）；`pair_with: "exec"` 指的就是该 exec 步本身。
- **为何并行而非串行**：用户裁决「exec 层内不限 lane 数量、可高并发并行」⇒ 三条 lane **同 wave 起**（分支间**无 `deps`**）；时序保障**不靠串行排步**，而靠 ① plan 产物在场（exec 消费门 `consumes_required: ["plan/"]` ⇒ plan 产物不在场即派不出）② 复核类 lane 的判据一律取 `plan/plan-designer-spec.md`（**不依赖 coder 的中间态**）。
- **实测展开**（`expandChainBranches(chain)`，2026-09-18 实测）：plan 1 / exec 3 / audit-pair 3 / accept 1，共 **8 lane**（`plan-designer`｜`exec-coder`·`exec-verifier`·`exec-reviewer`｜`audit-exec-coder`·`audit-exec-verifier`·`audit-exec-reviewer`｜`accept`）；`loadTeamAsset` 与 `chainProblemsOf` 均 `problems: []`、`expand.ok = true`。

- **命令 gate 的 cwd 是「批次产物根」，不是包根（2026-09-18 实测）**：exec 产物若声明 `gate: <命令>`，**行内必须自带 `cd /d <包根>` 或全部使用绝对路径**——否则在产物根下**必然 exit 1** ⇒ 拒 merged `GATE_EXIT_NONZERO` + `auto.settle` **`pause`**（批 `panel-redesign-20260918` 首轮实测的「门禁假红」）。真源 = `lib/state/gates.js` `commandCwd()` 三级兜底（lane worktree → env `GATE_REPO_ROOT` → 产物根）；口径见 `references/discipline.md` §0e D-9 + 附录 A.4。

## 交接与门禁要点

- **门禁看资产，不看本文件**：`flows` 的 `entry_requires` / `contract.required_sections`（**仅 plan 层有读点**）与 `chain` 的 `join` / `onFail` / `rework` 是运行期判据；本文件只做解释，冲突以资产为准。
  **「无读点」键的现役口径（2026-09-18 清债轮更新）**：`chain.needHuman`（链级人工闸提示）与 `flows.*.progress_contract`
  **均已退役**——零运行期读点 ⇒ **声明即拒** `TEAM_ASSET_FIELD_NOT_ALLOWED`（台账 `lib/assembly/chain.js` `RETIRED_CHAIN_KEYS`、
  `lib/assembly/team-asset.js` `RETIRED_FLOW_KEYS`），自此**不存在「写了不生效」的静默面**；链级人工闸的**唯一**承载面
  = `flows.audit.needhuman: true`（**不设双真源**）。`flows.exec.contract` 仍为**未接线声明**（仅加载期结构校验、
  零运行期读点）⇒ 同样**非**运行期判据。
- **写域先切分再动手**：exec lane 的写域按**文件粒度**切分（每个 lane 只碰自己声明的文件），跨 lane 依赖用
  `handoff_submit` 表达；上游未交接即开工会被 entry 门拒。
- **收口不拼接成员输出**：终门禁先消重、标注冲突、核证据再下结论；分歧不掩盖、不以投票了事（口径同 `acceptance-gate`）。
- **实测读数优先**：报数须带命令与原始输出；未跑写「未测」，不得以断言冒充（口径同 `verification-before-completion`）。

## 本轮新件入册（工程文档指针）

> **口径**：本节登记**本轮新增的工程文档指针**（清债波 & 面板重构批的产物与规格）。
> **两类树须分清**：`包内` = 本仓 `docs/**`（随包分发）；`外部台账` = 撰写期落盘的 workspace `docs/` 树（**未纳 VCS**、不在本包分发面内）。
> **外部台账一律写绝对路径**：包内相对路径 `docs/<名>.md` 在此树**不存在** ⇒ 按相对写法即产生悬空引用（同 `lib/assembly/chain.js` 的 F-5 缺陷形态）。

| 指针 | 树 | 绝对路径 / 包内路径 | 用途（何时读） |
|---|---|---|---|
| 面板重构规格（设计稿 + 五条用户裁决） | 外部台账 | `D:\AI_Workspace\DSH\DSH\docs\panel-redesign-spec-20260918.md` | 改面板（`lib/panel/**`）前读；Q-2 密度边界出处 |
| 面板重构侦察底稿（改造前的现状盘点） | 外部台账 | `D:\AI_Workspace\DSH\DSH\docs\panel-survey-20260918.md` | 判断面板某段改动的影响面时对照 |
| 引擎台账（结项/技术债/「本轮新件」登记位） | 外部台账 | `D:\AI_Workspace\DSH\DSH\docs\engine-status-and-debt-20260918.md` | 收口前核「该项是否已结项」；技术债编号（TD-*）真源 |
| 冻结节拍 · 清债波（`cleanup-wave-*` 批） | 批次产物根 | `…\artifacts\<批次>\plan\<batch>-spec.md`（根见工作区台账） | 该批 exec/audit 的判据源（写域矩阵 / 验收标准 / 约束） |
| 面板模型段（本包新增件） | 包内 | `lib/panel/panel-model.js` | 面板纯逻辑段（过滤器 / 排序 / 派生视图）；改面板前先读它再读视图段 |

> **维护纪律（防二次漂移）**：新增/改名/删除上述任一文件 ⇒ **同批**回改本表；**本表是「本轮新件」的唯一登记位**
> （包外台账只留一句结论，不重复登记指针）。本表**不承载**装配数据——角色/层/技能/flows 的唯一权威仍是
> `presets/engine-team/team-asset.yml`（见 §维护纪律）。

## 与引擎读端的关系

| 读端 | 作用 | 位置 |
|---|---|---|
| `loadTeamAsset(root, team)` | 加载 + 加载期不变量校验（拒载非法声明） | `lib/assembly/team-asset.js` |
| `resolveAssembly(team, config.assembly)` | 解析 `layers`（角色 + 技能），建批时注入 `[skills=…]` 前缀 | `lib/assembly.js` |
| `resolveTeamFlows(team)` / `resolveTeamRoles(team)` | 解析 `flows` 与 `roles`（扩展角色、额外牵头） | `lib/assembly/flows.js` |

**维护纪律**：改装配 = 改 `presets/engine-team/team-asset.yml`，再同步本文件的作用描述与技能名清单，
然后跑 `node scripts/check-team-assets.mjs` 复核一致性。该检查器**只以正向两项判失败**——
「资产引用了但技能根（宿主根 ∪ 包内根）不可解析」（`unresolved`）与「资产引用了但团队文档未提及」（`notInDoc`）；
反向差集 `docOnlySkills`（文档提及但资产未装配）**仅是 ⚠ 信息项、不参与失败判定**——跨团队引用、自指与路径段都会计入，
非空属正常，**不得为了让它归零而删掉跨团队引用**。

## 两个技能根的边界（易混点）

| 根 | 读端 | 本文件的关系 |
|---|---|---|
| 包内技能根 `<pkgRoot>/skills/` | 一致性检查器取「宿主根 ∪ 包内根」的并集 | 本文件所在之处 |
| 宿主技能根 `<home>/.agents/skills` | 运行期技能门**只读此根** | 包内新增经资产同步落到此根后才对运行期可见 |

> 因此「检查器绿」只证明**声明与文档一致**，不等于运行期可加载；运行期可见性属于资产同步（部署窗口）的事，
> 不是本文件能担保的面。

## 使用方式

| 场景 | 本技能给什么 |
|---|---|
| Leader 选团队建批（`wave_plan({team})`） | 层归属、角色集与产物契约的**读解**（真源是资产，不是本文件） |
| Leader / Manager 派发 worker | 目标角色的职责边界、可用/禁用动作、成功标准与期望输出格式 |
| worker 收工自检 | 产物落点与门禁要求（产物契约 + 交接件） |
| 排查「角色缺操作手册」 | 技能映射的读端位置与当前取值 |

> **不做判档**：难度（A/B/C）由 Leader 用 `assign_check({difficulty, rationale, scope:'full'})` 主动写入；本技能不判档、不替代 `wave_plan` 门禁。

## 三层门禁（Tier3 · 引擎强制）

| 门 | 触发点 | 拒绝码 |
|---|---|---|
| Plan 契约 | plan lane merged 前：产物含**独立裸标题行** `## 验收标准` / `## 约束` | `GATE_PLAN_CONTRACT` |
| Entry | exec/audit lane 派发前：`consume` 齐备且逐个在场；DAG 入边须已 `handoff_submit` | `GATE_ENTRY_MISSING` / `GATE_HANDOFF_MISSING` |
| Exit | merged 前：`produce ∪ outputs` 在场（以 `/` 结尾者按**目录**判：存在且非空） | `GATE_ARTIFACT_MISSING` / `GATE_ARTIFACT_NOT_A_FILE` |
| Targets | lane 声明 `targets` 时逐一核落盘（存在性 + 变更性） | `GATE_TARGET_MISSING` / `GATE_TARGET_UNCHANGED` |
| 命令 gate | exec 产物独立行 `gate: <命令>` ⇒ merged 前执行，exit 0 通过 | `GATE_EXIT_*` |
| 人工闸 | audit 产物独立行 `needHuman: true` ⇒ merged 须带 `human:<裁决人>:<时间>:<结论>` | `GATE_NEEDHUMAN_PENDING` |
| 终态冻结 | 批次终态（`complete`/`aborted`）后任何成员态迁移一律拒 | `GATE_BATCH_TERMINAL` |

## 蟛蜞治理集成（worker 视角）

- **lane id 纪律**：须逐字等于资产 `branches[].id`，否则链推进落 `no-lane-for-step`。
- **交接顺序**：产出后**先 `handoff_submit`、再发 `settle-request`**（顺序反了 auto-settle 判 `GATE_HANDOFF_MISSING` 并使批暂停）。
- **exec ↔ plan 依赖（**三道门**）**：**exec 分支之间无 `deps`**（可高并发并行、lane 数不限），但**每个 exec lane 必须消费 plan 产物**——由引擎在建批期强制：`flows.exec.consumes_required_per_lane: ["plan/"]`（**逐 lane**，任一 exec lane 缺该前缀 ⇒ 拒建批 `GATE_EXEC_INPUT_MISSING`）＋ `flows.exec.consumes_required: ["plan/"]`（**批级**覆盖）；另 `GATE_ORPHAN_PRODUCT` 保证 plan 产物不被孤儿化（plan 层硬拒），entry 门 `GATE_ENTRY_MISSING` 保证声明的 consume **逐个在场**后才派发。⇒ **exec 形态自由（无 deps），但与 plan 的依赖是硬门禁**；lane 间真实依赖由建批 `tasks[].deps` 声明。
- **通信**：`mailbox_send`（inbox/outbox/broadcast）只写元数据；`swarm_report` 回 Leader、`swarm_cc` 抄送 Manager。
- **进度**：每完成一子步骤落 `<lane>/progress/NN-<slug>.md`（**lane 域**，勿落层域）。
- **长程**：longrun 豁免由 Leader **派发时附带**，成员不得自改。
- **止轮与收口**：需止住自动推进用 `batch_control(pause)`（非终态、可逆）；**先了结成员态（`member_settle`）→ 再迁相位到终态**（写成员态属 C 档动作）。

## 边界

- 本技能**不承载装配数据**：唯一权威是 `presets/engine-team/team-asset.yml`；本文件只写用途、职责边界与契约，冲突以资产为准。
- **不替代引擎门禁**：文中「须/必须」若落在**非运行期判据**上（`flows.exec.contract` = 未接线声明；`chain.needHuman`、`flows.*.progress_contract` = **已退役、声明即拒**），视为约定而非门禁行为。
- 只声明**本团队**角色与技能；跨团队引用只作指针，不复制他队角色定义。
- 不新增产物类型：只用引擎既有 `plan/` `exec/` `audit/` 前缀。
