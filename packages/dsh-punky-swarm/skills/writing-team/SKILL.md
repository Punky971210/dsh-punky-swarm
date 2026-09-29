---
name: writing-team
description: |
  写作团队指引（团队层 skill，与 software-team / design-team / research-team 平级）：三层角色
  writing-planner（plan）/ drafter·polisher·publisher（exec）/ writing-auditor（audit）的职责边界、
  产物契约（plan/ exec/ audit/）与写作交付纪律（按规格成稿 → 修订去 AI 痕 → 判据对照审稿 →
  审核通过才排版交付）。
  装配数据面**已整体退役**（2026-09-27 用户裁决 ＋ 批 retire-team-chain-20260927 清尾，**进退役锁**）：
  引擎不再解析任何团队资产，**现行装配 = 引擎基线 ＋ 成员槽位 ＋ 指引**。
  本技能只写用途、职责与纪律（不承载、也不指向装配数据）。
  能力层指向本机既有写作技能池（加载名 = 宿主 SKILL.md frontmatter 的 name）：
  spec-writing / writing-trio / wechat-writing-style / humanizer / lieflat-less-ai-tone /
  revision-patterns / baoyu-markdown-to-html / acceptance-gate / review-execution。
  当需要确定写作团队某角色"是谁/能做什么/不能做什么/成功标准/输出格式"，
  或需要按写作链路产出可交付稿件（成稿 / 改稿 / 排版交付）时加载本技能。
version: "1.0.0"
kind: skill
triggers:
  - "写作团队"
  - "写作角色"
  - "写作团队装配"
  - "writing-team"
  - "写作"
  - "成稿"
  - "改稿"
  - "去 AI 味"
  - "排版交付"
  - "公众号排版"
  - "写作任务派发"
---

# writing-team — 写作团队指引（三层 5 角色 × 产物契约 × 写作交付纪律）

> **装配面已退役声明**：团队资产装配方案**已整体退役**（2026-09-27 用户裁决 ＋ 批 `retire-team-chain-20260927` 清尾，**进退役锁**）——引擎**不再解析**任何团队资产，`team` 退为可选自由标签。
> **现行装配面** = **引擎基线（引擎基础角色集与缺省门禁）＋ 成员槽位（roster / lane 角色）＋ 指引（本团队 skill 与 persona 纪律）**；本技能**不承载、也不指向**装配数据。
> 本技能只写**用途、职责与纪律**，避免"技能与引擎两处各写一份"造成漂移（口径同 `skills/software-team/SKILL.md` 的团队资产退役说明）。
> 行为层（persona 纪律 0–10、三层门禁 Tier3、Manager 定义）由 dsh-punky-swarm 承担，本技能不重复。

## 团队用途（何时加载）

| 场景 | 本技能给什么 |
|---|---|
| Leader 选团队建批（`wave_plan({team:'writing-team'})`） | 该团队的层归属、角色集、粒度口径与产物契约 |
| Leader / Manager 派发 worker | 目标角色的职责边界、可用/禁用动作、成功标准与期望输出格式 |
| 写作任务收口 | 判据来源：plan 的写作规格 → exec 的成稿/修订 → audit 的判据对照审稿 |
| 排查"角色缺操作手册" | 技能映射的**读端位置**与当前取值（真源在团队资产，不在本文件） |

## 三层角色（5 角色，全部为团队自定义角色）

| 层 | 角色 | 职责（一句话） | 关键产物 |
|---|---|---|---|
| plan | `writing-planner` | 评估需求（读者/平台/体裁/篇幅/风格/交付形态）→ 定**写作规格**，牵头 plan 层 | `plan/plan-writer-spec.md`（含 `## 验收标准` / `## 约束`）+ `plan/task-tree.json` |
| exec | `drafter` | 按规格成稿 | `exec/draft.md` |
| exec | `polisher` | 修订 / 去 AI 痕 / 密度压缩（逐处改动与依据留痕） | `exec/polish-report.md` |
| audit | `writing-auditor` | 判据对照审稿（结构完整、风格一致、事实与引用可核、AI 痕清单命中）；**只读不改稿**，牵头 audit 层 | `audit/editorial-review.md` + `audit/gap-list.json` |
| **Leader**（最后交付） | `publisher` | 排版与交付（如公众号 HTML）——**由 Leader 在交接后执行**，**不占团队链步** | `exec/publish/<platform>.html` + `exec/delivery-report.md` |

> 五个角色名均不在引擎基础角色集内，故在团队资产里全部按自定义（扩展）角色声明，并由该资产的
> `plan_leads` / `audit_leads` 认可 `writing-planner` / `writing-auditor` 承担对应层的牵头
> （逐字取值见资产，本文件不复制）。

## 三层职责与产物契约

### plan — `writing-planner`

- **职责**：评估需求（**读者 / 平台 / 体裁 / 篇幅 / 风格 / 交付形态**）→ 定**写作规格**：受众与平台基调、体裁与结构骨架、篇幅区间、风格取向、事实与引用要求、交付形态（如公众号 HTML）。
- **产物**：`plan/plan-writer-spec.md`（**必含独立裸标题行** `## 验收标准` 与 `## 约束`，任何编号变体如 `## 5. 验收标准` 会被 `GATE_PLAN_CONTRACT` 拒）＋ `plan/task-tree.json`。
- **权限边界**：只出规格与判据；**不成稿、不改稿、不排版**（属 exec）；不得改引擎门禁。

### exec — `drafter`

- **职责**：按写作规格成稿（按规格的结构骨架与篇幅区间落笔，事实与引用按规格要求标注）。
- **产物**：`exec/draft.md`。
- **权限边界**：不自定验收标准（读 `plan/plan-writer-spec.md`）；不越规格改写体裁/篇幅口径；不自行排版交付。

### exec — `polisher`

- **职责**：修订 / 去 AI 痕 / 密度压缩——逐处改动并给出依据（命中哪条 AI 痕规则、哪条修订模式、压缩前后的信息密度对照）。
- **产物**：`exec/polish-report.md`（含**逐处改动与依据**：位置 → 原文 → 改后 → 依据）。
- **权限边界**：不改写作规格；不得为"像人写的"强加人称/口语或改变文章框架而超出技能规则清单；改动必须可回溯到依据。

### audit — `writing-auditor`

- **职责**：**判据对照审稿**——按 `plan/plan-writer-spec.md` 的验收标准逐条核对：结构完整、风格一致、事实与引用可核、AI 痕清单命中；**只读不改稿**，缺陷走报告不自行修复。
- **产物**：`audit/editorial-review.md`（结构化 verdict：approve / reject + blocking issues + followups）＋ `audit/gap-list.json`（未闭合项；本层是 gap-list 的唯一产出者）。
- **权限边界**：不改 `exec/` 产物、不改 plan 规格；不足则要求补证，不代替 exec 返工。
- **人工闸**：若存在需人工裁决项，产物以**独立行**声明 `needHuman: true`，`merged` 时须携带裁决证据契约 `human:<裁决人>:<时间>:<结论>`（audit 层 `needhuman: true` 口径）。

### 最后交付（**Leader 执行**）— `publisher`

- **归属（2026-09-18 用户裁决）**：发布/排版交付等**最后交付步骤改由 Leader 执行**（同 design-team 的生产口径）⇒ **不在团队链步内、不派 lane**；`publisher` 仍保留在资产 `layers.exec.roles`（能力声明与技能映射）。
- **职责**：排版与交付（如公众号 HTML）——把审稿通过的成稿按目标平台排版成型并交付（含交付记录）。
- **进料**：Leader 在**团队链收口后**接手——链形态 `plan → exec-draft → exec-polish → audit-pair → accept`（`pair_with: "exec-polish"` ⇒ audit 恰 1 条配对 lane）；交付前须已取到 `audit/editorial-review.md` + `audit/gap-list.json`（缺则不进入交付）。
- **产物**：`exec/publish/<platform>.html` ＋ `exec/delivery-report.md`。
- **权限边界**：不改稿件正文与写作规格（要改回 drafting/polishing）；排版只做形式加工，不夹带未审内容。

## 定位边界（不做什么）

- 本团队**团队链**只做写作与审稿：plan 定写作规格 → exec 成稿 → exec 修订 → audit 审稿；**最后交付（排版/发布）由 Leader 在交接后执行**（不占链步）。
- **不承担调研**（选题的来源核查与外部资料取证归 `research-team`）；本团队只做「事实与引用可核」的**审稿核对**，不做外部取证。
- **不承担视觉底图**（图像/海报底图/版式素材归 `design-team` 的能力层）。
- 不新增产物类型：产物目录只用引擎既有 `plan/` `exec/` `audit/` 前缀。

## 触发与装配时机

| 时机 | 加载面 |
|---|---|
| plan 层产规格 | `writing-planner` 加载 `spec-writing` / `writing-trio` / `wechat-writing-style`（定规格与结构骨架） |
| exec 层按规格写作 | `drafter` 加载 `writing-trio` / `wechat-writing-style`（成稿）；`polisher` 加载 `humanizer` / `lieflat-less-ai-tone` / `revision-patterns` / `writing-trio`（修订） |
| audit 层按验收信号核对 | `writing-auditor` 加载 `acceptance-gate` / `review-execution` / `humanizer`（判据对照 + 对抗式审查 + AI 痕清单命中） |
| 最后交付（**Leader 执行**） | `publisher` 能力层：`baoyu-markdown-to-html`（Markdown → 平台 HTML 排版）；**不占团队链步** |

> 触发词见 frontmatter `triggers`：说「写作 / 成稿 / 改稿 / 去 AI 味 / 排版交付」等即命中本团队装配面。

## 与引擎读端的关系

| 读端 | 作用 | 位置 |
|---|---|---|
| `resolveAssembly(team, config.assembly)` | 解析 `layers`（角色 + 技能），建批时注入 `[skills=…]` 前缀 | `lib/assembly.js` |
| `resolveTeamFlows(team)` / `resolveTeamRoles(team)` | 解析 `flows` 与 `roles`（扩展角色、额外牵头） | `lib/assembly/flows.js` |
> ⚠ **装配面已整体退役**（2026-09-27 裁决 ＋ 批 `retire-team-chain-20260927` 清尾，**进退役锁**）⇒ 上表**不含资产装载行**；
> `resolveTeamFlows` / `resolveTeamRoles` 为**保形空实现**（恒返「无声明」/ 空集），角色集回落**引擎基础集**。

**维护纪律**：装配面**已退役**（无资产文件可改）——现行装配只随**引擎基线 / 成员槽位 / 本指引**三者变化；
改本文件的作用描述即可，**不得**再引入按团队解析的装配数据。
装配引用的技能必须能被宿主加载（技能声明值 = 宿主 `SKILL.md` 的 frontmatter `name`，**不是**宿主目录名）。

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
- **止轮与收口**：需止住自动推进用 `batch_control(pause)`（非终态、可逆）；**先了结成员态（`member_settle`）→ 再迁相位到终态**（写成员态属 C 档动作）。
