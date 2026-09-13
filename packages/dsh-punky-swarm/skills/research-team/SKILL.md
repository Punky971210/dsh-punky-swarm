---
name: research-team
description: |
  调研团队指引（团队层 skill，与 software-team / design-team 平级）：三层角色
  research-planner / researcher / research-auditor 的职责边界、粒度口径与产物契约
  （plan/ exec/ audit/），以及调研纪律（来源分级 A/B/C、逐条溯源、audit 抽查 ≥3 条引用可复现）。
  装配数据（角色 × 层 × 技能 × flows）的唯一来源是引擎团队资产
  `presets/research-team/team-asset.yml`——本技能不复制该数据，只声明指针与用途。
  能力层指向本机既有调研技能池（加载名 = 宿主 SKILL.md frontmatter 的 name）：
  spec-writing / decision-mapping / tech-benchmark-planning / ara-compiler /
  ara-research-manager / citation-evaluator / arxiv-translator / ara-rigor-reviewer / acceptance-gate。
  当需要确定调研团队某角色"是谁/能做什么/不能做什么/成功标准/输出格式"，
  或需要按调研链路产出可核查的调研产物时加载本技能。
version: "1.0.0"
kind: skill
triggers:
  - "调研团队"
  - "调研角色"
  - "调研团队装配"
  - "research-team"
  - "来源分级"
  - "引用核查"
  - "调研任务派发"
---

# research-team — 调研团队指引（三层角色 × 产物契约 × 调研纪律）

> **装配数据唯一来源声明**：本技能**不承载**装配数据。角色/层/技能/flows 的唯一权威是引擎团队资产
> `presets/research-team/team-asset.yml`（随包分发，引擎按 `presets/<team>/team-asset.yml` 解析）。
> 本技能只写**用途、职责与纪律**，避免"技能与引擎资产两处各写一份"造成漂移（口径同 `software-team-assembly`）。
> 行为层（persona 纪律 0–10、三层门禁 Tier3、Manager 定义）由 dsh-punky-swarm 承担，本技能不重复。

## 团队用途（何时加载）

| 场景 | 本技能给什么 |
|---|---|
| Leader 选团队建批（`wave_plan({team:'research-team'})`） | 该团队的层归属、角色集、粒度口径与产物契约 |
| Leader / Manager 派发 worker | 目标角色的职责边界、可用/禁用动作、成功标准与期望输出格式 |
| 调研任务收口 | 判据来源：plan 的调研判据 → exec 的逐条溯源 → audit 的独立核查 |
| 排查"角色缺操作手册" | 技能映射的**读端位置**与当前取值（真源在团队资产，不在本文件） |

## 三层角色（3 角色，全部为团队自定义角色）

| 层 | 角色 | 职责（一句话） | 关键产物 |
|---|---|---|---|
| plan | `research-planner` | 界定问题与**调研判据**（问题清单、来源分级 A/B/C、覆盖矩阵、停止条件），牵头 plan 层 | `plan/research-spec.md`（含 `## 验收标准` / `## 约束`）+ `plan/task-tree.json` |
| exec | `researcher` | 执行调研：**来源可核、逐条溯源**（每条结论带出处与获取方式），不杜撰 | `exec/research-report.md`（含引用清单）+ `exec/evidence.json` |
| audit | `research-auditor` | **独立核实**：抽查 ≥3 条引用可复现、标记无法核实的结论、给 gap-list；只读不改，牵头 audit 层 | `audit/source-verification.md` + `audit/gap-list.json` |

> 三个角色名均不在引擎基础角色集内，故在团队资产里全部按自定义（扩展）角色声明，并由该资产的
> `plan_leads` / `audit_leads` 认可 `research-planner` / `research-auditor` 承担对应层的牵头（逐字取值见资产，本文件不复制）。

## 产物契约（三层，沿用引擎既有目录约定，不新增产物类型）

| 层 | 产物路径 | 契约要点 |
|---|---|---|
| plan | `plan/research-spec.md` + `plan/task-tree.json` | plan 契约由引擎强制：产物须含**独立裸标题行** `## 验收标准` 与 `## 约束`（编号/前缀变体一律被 `GATE_PLAN_CONTRACT` 拒） |
| exec | `exec/research-report.md` + `exec/evidence.json` | `exec/research-report.md` 须含引用清单；`evidence.json` 为逐条证据（结论 → 出处 → 获取方式 → 时间） |
| audit | `audit/source-verification.md` + `audit/gap-list.json` | 验收结论与未闭合项清单；audit 层带 `needhuman`，收口需人工裁决证据 |

> 层间入口要求由资产的 `flows` 强制（exec/audit 的 `entry_requires: ["consume"]`）：上游产物缺失时派发被拒
> （`GATE_ENTRY_MISSING`），这是门禁行为而非流程建议。

## 调研纪律（执行面硬要求）

1. **来源分级 A/B/C 先行**：A = 官方文档 / 一手规范 / 源码 / 作者本人声明；B = 权威二手（同行评议论文、官方镜像的转述、可信媒体）；
   C = 论坛帖 / 博客 / 二手转述 / 模型记忆。**C 级不得单独支撑结论**，只能作线索，且必须回落到 A/B 级复核或明确标注"C 级未复核"。
2. **逐条溯源**：每条结论必须可回溯到具体来源（URL + 获取方式 + 获取时间；代码须给仓库 + 文件 + 行；论文须给 DOI/arXiv ID + 版本）。
   无法给出来源的结论不得写入 `exec/research-report.md`——宁缺勿造。
3. **禁止杜撰引用**：不得凭印象写引文、不得拼凑 DOI/编号、不得把模型记忆当作来源。存疑即标注存疑。
4. **audit 抽查 ≥3 条引用可复现**：`research-auditor` 独立复跑/复读**至少 3 条**引用（含至少 1 条 A 级），核对结论与来源是否一致；
   不可复现的引用逐条进 `audit/gap-list.json`，并标记受影响结论。
5. **冲突不掩盖**：来源之间冲突时两条都保留并标注分歧，不以"多数票"或"看起来更权威"的方式静默取一。
6. **停止条件**：plan 层须写明何时算查够了（覆盖矩阵饱和 / 边际新增为 0 / 触碰外部依赖或额度上限），exec 层不得无限扩张检索面。

## 与引擎读端的关系

| 读端 | 作用 | 位置 |
|---|---|---|
| `resolveAssembly(team, config.assembly)` | 解析 `layers`（角色 + 技能），建批时注入 `[skills=…]` 前缀 | `lib/assembly.js` |
| `resolveTeamFlows(team)` / `resolveTeamRoles(team)` | 解析 `flows` 与 `roles`（扩展角色、额外牵头） | `lib/assembly/flows.js` |
| `loadTeamAsset(root, team)` | 加载 + 加载期不变量校验（拒载非法声明） | `lib/assembly/team-asset.js` |

**维护纪律**：改装配 = 改 `presets/research-team/team-asset.yml`，再同步本技能的作用描述；
装配引用的技能必须能被宿主加载（技能声明值 = 宿主 `SKILL.md` 的 frontmatter `name`，**不是**宿主目录名——例如
宿主目录 `research-compiler` 的加载名是 `ara-compiler`，目录 `rigor-reviewer` 的加载名是 `ara-rigor-reviewer`）。
