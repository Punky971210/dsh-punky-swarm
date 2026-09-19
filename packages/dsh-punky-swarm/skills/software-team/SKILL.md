---
name: software-team
description: |
  软件工程团队：角色定义（3 层 7 角色 + 引擎层角色 Manager，
  见 references/roles/）+ 角色 × 能力层技能速查 + **引擎装配资产（team-asset）说明与用途**
  （**装配数据唯一来源 = `presets/software-team/team-asset.yml`**，
  本技能只给可读摘要、角色边界与装配读端，不承载装配数据）。
  行为层（hardening/rail）由 dsh-punky-swarm 承担。
  当需要确定某角色"是谁/能做什么/不能做什么/成功标准/输出格式"、Leader 派发 worker
  需按角色装配能力层技能，或需确认"团队角色怎么落层 / 每个角色加载哪些技能 / 门禁与完成判据怎么取"时加载本技能。
version: "1.0.0"
kind: skill
triggers:
  - "角色定义"
  - "角色指引"
  - "装配表"
  - "这个角色负责什么"
  - "角色的边界"
  - "派发任务"
  - "团队装配"
  - "team-asset"
  - "装配资产"
  - "角色加载哪些技能"
  - "团队怎么装进引擎"
  - "技能选型"
---

# software-team — 软件工程团队角色 × 装配

> roles 为子目录 `references/roles/`；装配映射与角色定义单一来源均为本技能。行为层 hardening/rail 由 dsh-punky-swarm 承担。

## 角色概览（3 层 7 角色 + 引擎层角色 Manager）

| 层 | 角色 | 职责 | 能力层手册 | 可拓展性 |
|----|------|------|-----------|:--------:|
| 任务层 🎯 | Coordinator | 细拆（API 粒度）+ 代码摸底（粗拆已上移 Leader 人工对接） | brainstorming, writing-plans | 固定 |
| 任务层 🎯 | Designer | 四件套产出（plan/coder-tasks/tester-tasks/spec） | brainstorming, writing-plans, spec-writing | 固定 |
| 执行层 ⚡ | Coder 池 | spec 驱动编码 + **最小自检** | test-driven-development, codebase-design, receiving-code-review, requesting-code-review | 动态（推荐 3） |
| 执行层 ⚡ | Tester 池 | spec 驱动测试 + **功能验证/全量测试**（端到端、回归、验收执行） | verification-before-completion, systematic-debugging | 动态（推荐 2） |
| 执行层 ⚡ | Reviewer | 对抗式审查 + MUST/SHOULD/FYI 分级 | review-execution | 固定 |
| 审计层 🛡️ | Supervisor | CBM 全量验收 + gap-list 对账 → 人审门禁 | acceptance-gate, verification-before-completion | 固定 |
| 审计层 🛡️ | Doc-Manager | 复盘 + 记忆沉淀（dsh-mneme 优先；Mnemopi 降级） | doc-generator, retro-and-memory | 固定 |

> 「池」（Coder 池 / Tester 池）：**仅 Agent-team 方案使用；subagent 方案不用**——「池」是声明面（可多实例并行），引擎无校验，不承载分配语义。

> **引擎层角色：Manager——不属本团队角色集**。Manager 为**团队无关的通用治理角色**（Leader 直属下属，由 Leader 以 continuable subagent 拉起），其定义、调度循环与派发模板单一来源为引擎包 `presets/punky-preset/references/manager.md`；不占 `references/roles/` 名额、不参与本团队 7 角色计数（与 `lib/assembly/schema.js:59` `REQUIRED_ROLES` 7 角色 + 显式豁免 manager 的引擎契约一致）。

## 装配资产（team-asset）说明与用途

> **来源**：本节由**已退役**的独立「团队装配资产说明」技能**并入**（该技能目录已整体退役，不再随包分发）——并入后装配资产的说明、读端与维护纪律**只此一处**。

> **单一来源声明**：本技能**不承载**装配数据。层/角色/技能/流程声明的唯一权威是引擎资产
> `presets/software-team/team-asset.yml`（随包分发，引擎按 `presets/<team>/team-asset.yml` 解析）。
> 本节只写**用途与纪律**，避免"技能与引擎资产两处各写一份"造成漂移。

### 用途（何时加载本节）

| 场景 | 本节给什么 |
|---|---|
| Leader 选团队建批（`wave_plan({team:'software-team'})`） | 该团队在引擎里的**层归属、角色集、技能映射**是什么，以及为什么这么装 |
| Manager/Leader 派发 worker | 目标角色应加载哪个技能（角色 → 技能映射的**读端位置**与当前取值） |
| 角色行为异常（如 worker 缺操作手册） | 排查"装配是否引用了**不存在/已退役**的技能" |
| 装配变更 | 改哪里、按什么顺序改（见下"维护纪律"） |

### 角色作用与装配（3 层 7 角色；Manager 属引擎层，不入本团队）

| 层 | 角色 | 作用（一句话） | 装入的技能（技能=操作手册，给"怎么做"） |
|---|---|---|---|
| plan | coordinator | API 粒度细拆 + 代码摸底（CBM 索引为据） | `brainstorming`, `writing-plans` |
| plan | designer | 设计四件套 + 验收/约束章节（产出前 CBM 架构复核） | `brainstorming`, `writing-plans`, `spec-writing` |
| exec | coder | spec 驱动编码 + **最小自检**（全量验证剥离给 tester） | `test-driven-development`, `codebase-design`, `receiving-code-review`, `requesting-code-review` |
| exec | tester | 功能验证与**全量测试**（端到端/回归/验收执行） | `verification-before-completion`, `systematic-debugging` |
| exec | reviewer | 对抗式审查 + MUST/SHOULD/FYI + **结构化 verdict** | `review-execution` |
| audit | supervisor | 全量验收 + gap-list 对账 → 人审门禁 + **结构化 verdict** | `acceptance-gate`, `verification-before-completion` |
| audit | doc-manager | 复盘 + 记忆沉淀（dsh-mneme 优先） | `doc-generator`, `retro-and-memory` |

> **层角色集 ≠ 技能键全集**：层角色集仍按上表只列 `plan` 的 coordinator/designer、`exec` 的 coder/tester/reviewer、`audit` 的 supervisor/doc-manager；`skills` 段**只允许出现 roles 内的键**——为 roles 外的角色（如把 reviewer 塞进 audit 层）写技能键是**悬空声明**（引擎按 `roles` 注入，写了不生效），不得写入。

### 引擎侧读端（谁消费这份装配）

| 读端 | 作用 | 位置 |
|---|---|---|
| `resolveAssembly(team, config.assembly)` | 解析 `layers`（角色 + 技能），供建批时注入 `[skills=…]` 前缀 | `lib/assembly.js` |
| `resolveTeamFlows(team)` | 解析 `flows`（产物字段 / 入口要求 / 内容契约 / 完成判据开关） | `lib/assembly/flows.js` |
| `resolveTeamRoles(team)` | 解析 `roles`（扩展角色、额外牵头角色） | `lib/assembly/flows.js` |
| `loadTeamAsset(root, team)` | 加载 + **加载期不变量校验**（拒载非法声明） | `lib/assembly/team-asset.js` |

### 维护纪律（防止漂移）

1. **改装配 = 改引擎资产**：先改 `presets/software-team/team-asset.yml`，再同步本节（`skills/software-team/SKILL.md`）的"作用描述"；
   本技能**永不**成为装配数据的第二副本。
2. **技能必须真实存在**：装配引用的每个技能都要能在宿主技能目录解析到
   （`~/.agents/skills/<name>/SKILL.md`）。**已退役技能不得留在装配里**——引擎只做前缀注入，
   不校验技能存在性，引用退役技能会**静默降级**（worker 少一份操作手册而无人报错）。
3. **改动后跑装配冒烟**：`test/software-team-asset.test.js`（覆盖：对指引一致性、退役技能禁用、
   端到端建批的技能前缀注入），并跑 `node scripts/check-team-assets.mjs` 核「资产引用 vs 技能文档」双向差集。
4. **未接线声明不得写入**：引擎尚未消费的声明段（如 `flows.exec.contract`）一律不写——"看着已生效"比没有更危险。
   **已退役键**（顶层 `state_machine` / 顶层 `rework` / `flows.*.progress_contract` / 链级 `chain.needHuman`）**声明即拒**
   `TEAM_ASSET_FIELD_NOT_ALLOWED`（台账 `lib/assembly/team-asset.js` `RETIRED_TOP_KEYS`/`RETIRED_FLOW_KEYS`、`lib/assembly/chain.js` `RETIRED_CHAIN_KEYS`）。

### 与引擎纪律的关系

- 角色边界（能做什么/禁止什么）由 `presets/punky-preset/agent.cordis.yml`（persona 纪律）+ 角色注入段承载；
- 层归属与牵头角色由 `lib/wave-plan.js` 的 `PLAN_LEAD_ROLES` / `AUDIT_LEAD_ROLES` 决定；
- 本节只回答"**这个团队在引擎里怎么装、装了什么**"。

## 装配表（角色 → 操作手册）

> 角色 → 技能的装配数据**唯一来源**是 `presets/software-team/team-asset.yml`；本表为可读摘要，冲突以资产为准。

> 本表列**本团队 7 角色**（Coordinator / Designer / Coder / Tester / Reviewer / Supervisor / Doc-Manager）；**引擎层角色 Manager 不在本表**——其履职定义与操作面（治理工具 batch_status/gate_status/mailbox_*/member_*/lane_*）见 `presets/punky-preset/references/manager.md`。

| 层 | 角色 | 操作手册（skill 工具加载） | 关键产出 |
|---|---|---|---|
| 任务层 | Coordinator | brainstorming + writing-plans | 细拆（API 粒度）+ 代码摸底（codebase-survey.md）；`task-tree.json` **按需声明**——需要任务树的批次由**建批 `tasks` 面**声明 |
| 执行层 | Designer | brainstorming + writing-plans + spec-writing | design.md / PRD / spec（to-prd 为 disable-model-invocation 命令式技能，不适用于 worker）；plan 层 lane role 强制 designer |
| 执行层 | Coder（池） | test-driven-development + codebase-design + receiving-code-review + requesting-code-review | 代码 + dev_plan checklist |
| 执行层 | Tester（池） | verification-before-completion + systematic-debugging | 测试集 + 结果 |
| 执行层 | Reviewer | review-execution | review.md + acceptance-checklist.md（验收检查清单） |
| 审计层 | Supervisor | acceptance-gate + verification-before-completion | acceptance-report.md + gap-list.json（audit 对账） |
| 审计层 | Doc-Manager | doc-generator + retro-and-memory | 文档/复盘 |

### 角色注入（Worker 上下文补全）

派发子代理时，Leader 从 `references/roles/<role>.md` 取「## Persona（注入用）」与「## 权限边界（注入用）」两段，内联进任务包 prompt 的『角色注入』段——让 worker 自带角色边界（防越界：Tester 不改码/Reviewer 只读），**不依赖自觉**。

- **注入内容**：仅 Persona + 权限边界 2 段；
- **不注入全量 role**：职责/协作由 Leader 驱动（任务包已含目标/契约/回执要求），全量注入污染上下文；
- **示例**：
  ```
  **角色注入**：你是 <Role>——<Persona 一句话>；权限：<白名单>；禁止：<边界>。
  ```

### worker 公共约束（单一来源）

所有角色共用的「约束」行收敛于此单一来源，roles/*.md 权限边界只保留差异、不再内联（去多副本）：

> 约束：按真实用户行为操作（点击调用链，禁机器式调接口）；产物落盘 `artifacts/<batchId>/`；诚实披露（失败/异常如实记录）；回执简短结构化（对比表/清单）；**能力发现前置（2026-09-15 用户裁决 L1+L3）**：断言「没有某工具/技能」之前必须先 `tools_search` / `skill_search` 检索（为空才可下结论，并写明检索词）；**被折叠的工具仍可按名直调**（参数细节先用 `tools_schema` 展开），折叠 ≠ 禁用。

roles 权限边界引用格式：`约束：公共约束见 SKILL.md §worker 公共约束；本角色差异：<仅差异>`——差异为空时省略「；本角色差异」后缀，只留指针行。

### 任务包最小结构（Leader 派发模板）

wave_plan 的 lane 任务包只含**角色/目标/契约/验收** + 角色注入，Leader 不预写实现（调用链设计、脚本实现由被指派 worker 全权负责）。顶层字段 ≤10（id/role/layer/cmd/角色注入/产物落盘/契约/回执/纪律/验收标准），五字段必保（角色/目标/契约/验收/产物落盘），示例 ≤800 字符：

```json
{ id, role, layer,
  cmd: '加载 <手册技能>，按任务包自行设计实现并落盘产物',
  角色注入: '<Persona 一段 ≤50 字>；<权限边界 可执行/禁止 各 ≤1 行，公共约束不重复>',
  产物落盘: '引擎产物根见 SKILL.md 单一来源（两档写法/asset_claim），本 lane 落 <layer>/<lane>/',
  契约: { consume: [...], produce: [...] },
  worker 回执: "report 回报 Leader（一行）+ mailbox_send outbox 通知 Manager；`leader-direct` 批（无 Manager）只走单通道 report→Leader，不写 outbox",
  纪律: '见 SKILL.md §纪律要点；本 lane 适用=<≤2 条裁剪>',
  验收标准: [...] }
```

### 纪律要点（派发前速查）

- exec 层 code/test 职能分离：Coder 最小自检（语法/lint/编译/已改文件单测冒烟），全量回归/端到端/验收归 Tester；
- **exec 形态（D-1，2026-09-17）**：exec 拆两步——`exec-work`（**tester ∥ coder**：两条 lane 的 deps 均为空 ⇒ 互不依赖，consume 指向 **plan 产物**，不待 code 完成）与 `exec-review`（**reviewer 独立跑测试**：自带测试复跑、不依赖 tester 的测试结论，并向下游 **audit lane** 汇总产物）；exec 层 lane 数仍为 3，装配强制面不变；
- plan 四件套归 Designer（role=designer，禁止 manager 代产）；
- audit worker 完成即终态，追加任务=新 lane 新派发，禁止 send_message 复用；
- 派发 sessionId/产物根从 batch_status 读取注入，禁手写；
- audit lane 统一命名 audit-accept/audit-verify；报告措辞「待 Leader 处置的 gap 清单（不得由 audit 执行）」；
- test 产可执行测试套件（PASS/FAIL 证据），review 产验收检查清单（MUST/SHOULD/FYI），二者互补不重复；
- worker 每完成子步骤即 lane_checkpoint 提交保全（崩溃后 git log 可查、人工可抢救），禁止攒批；续跑前 lane_checkpoint_status 查询跳过已完成步骤（checkpoint 纪律单一来源，roles 不再重复详述）；
- C 类多 lane 写同一 git 仓库时：exec 派发前 lane_worktree_create 建独立 worktree，将返回路径注入任务包作 cwd 契约（物理隔离，防 git 锁冲突）；
- **任务包强制项（D-6，2026-09-15）**：任务包**必须显式写明**「**写文件一律走 `edit` / `write` 在册工具**；shell 写盘（`>` 重定向 / `Set-Content` / `Out-File` / `New-Item` / `Copy-Item`）会被 **`L3-W01` 当场 DENY**」。依据：本会话**三次**批次因成员反复用 shell 写盘撞同一规则，触发 governance escalation 达阈（阈 3 / 600s）**自动暂停批次**（每次需人工 `batch_phase(running)` 恢复）⇒ 升级为任务包必填项；写盘被拒**不得第四次重试同一命令**，换 `edit`/`write` 即解（临时探针落 `%TEMP%` 亦须用在册工具）；
- 治理工具豁免难度门禁：batch_*/member_*/mailbox_*/lane_*/gate_status/assign_check/artifact_types/log_export 等治理/查询工具属非执行型放行（防死锁——治理循环中 Leader 必须能查询/结算）；豁免仅限难度门禁，其余 guard 语义（EXEC_TOOLS 名单、计数）不受影响（口径与引擎 lib/tools/core.js installDifficultyGuard 注释一致）；
- **成员面动作只认 C 档（G1，2026-09-14 用户裁决；2026-09-15 Q2=B 收窄）**：`wave_plan` / `member_status` / `member_settle` 在**工具面**另有前置断言（`lib/tools/core.js#assertMemberActionTierC`）——**建批只认本会话自己的 C 档**（**取消父档继承**：worker / Manager 子会话一律建不了批）；**成员状态仅「本会话 C（Leader）」或「该批已登记 Manager 会话」可写**，否则拒 `GATE_BATCH_REQUIRES_C`（建批）/ `GATE_MEMBER_REQUIRES_C`（成员状态）；**未评估与 A/B 同罚**。⇒ **派给 worker 的任务包不含建批/管成员职责**：worker 只施工 + 回执，成员状态迁移归 Manager / Leader（**成员仅作为会话存在，不可写状态**）；归属错位（批次落在 worker 名下）会使装配声明 / Manager 拉起 / audit 责任人全部错位；
- 不引入 audit 预算/节流字段（省 token、避免机械限制审计深度）。

### 装配模式与角色装配决策（何时配谁 · exec 层 lane≥3 的三层批强制装配）

装配按难度档（A/B/C，档位定义归 persona 纪律 0）与建批参数（`assembly`）决定角色组成。本技能不参与判档，只写「谁必须配、谁可代行、谁承接审核」的可执行判据：

- **何时配 Manager（`managerPlan` 缺省 `raise`）**：**exec 层 lane 数≥3 的三层批**（建批须传 `assembly`）running 后、**首个 exec lane 派发前**，Leader 必须拉起 Manager 并 `batch_phase({batchId, manager:{agentId}})` **登记**——continuable subagent 一次注入（批次上下文 + 调度循环，注入模板见 `presets/punky-preset/references/manager.md`）；**未登记则 exec 层 lane 派不出**（入口门禁拒 `GATE_MANAGER_NOT_RAISED`）。**需 Leader 直驱时必须在建批 `assembly` 显式声明 `managerPlan:'leader-direct'` 退出默认**——直驱是**显式出口**，缺省**不是**直驱；`leader-direct` 批的 worker 回执走**单通道** `report → Leader`（**不写 `outbox`**，无 Manager 消费者）、并由 Leader 代行 watch（persona 纪律 0f/0g）。exec 层 lane 数<3 的普通 C 批：Leader 可代行（豁免留痕「本批由 Leader 直驱」），拉起 Manager 为可选增强；A/B 级不配。
- **何时配 Coordinator**：**exec 层 lane 数≥3 的三层批**（建批须传 `assembly`）**或**粗拆决策需细拆产物（API 粒度任务清单 / codebase-survey）时，plan 层建 role=coordinator lane（produce=codebase-survey.md，**需要任务树时另在 `tasks` 面声明 `plan/task-tree.json`**，consume=leader-decision-pack）；无细拆需求不必配。**`task-tree.json` 一律按需声明**：需要任务树的批次由**建批 `tasks` 面**（`produce:['plan/task-tree.json']`）显式声明；未声明即不产出，**不得由 Designer/Leader 默认代产**（新形态下 task-tree 非常规产物）。
- **audit 承接 supervisor+reviewer 审核职能为默认语义**：audit 层 lane 承接验收 + 对抗审查（取代式装配可接受——实证取代率≈55.3%，用户已认可）；**双角色分离**（reviewer 独立 exec 对抗 lane + supervisor audit 验收）为**显式选项**，供需对抗审查的高危/合规批选用（规范样本见 references/templates/success-pattern-seeds.md，P2-1 存档）。
- **装配声明（exec 层 lane 数≥3 的三层批）**：该类批 plan lane 产物须含角色装配声明（Manager 拉起计划 / Coordinator lane 分配 / audit 角色分配）——**建批须传 `assembly`**（`managerPlan` **缺省 `raise`**：须 Manager 的批在派发首个 exec lane 前拉起并 `batch_phase` 登记，未登记即拒派 `GATE_MANAGER_NOT_RAISED`；需 Leader 直驱时**显式**声明 `managerPlan:'leader-direct'`；缺 `assembly` 则拒建批 `GATE_ROLE_ASSEMBLY_MISSING`），机制见 persona 纪律 0b/0g；本技能 plan lane 任务包与模板示例同步含该章节占位（Leader 派发该类批 plan lane 时注入）。

### Manager 角色派发模板 → 已上移引擎层

> Manager 通用定义、指挥循环与派发模板**不再由本团队技能承载**，已上移引擎包：`presets/punky-preset/references/manager.md`（persona 纪律 0g 的引用目标亦改指该文件）。
> 本团队层只保留软件工程专属条款；Manager 为团队无关的治理角色，其定义随引擎层演进——**变更时只改引擎包一处，本文件不复制副本**，避免双份正文漂移。

## 使用方式

1. **查角色**：读 `references/roles/<role>.md`（Persona（注入用）/职责与产出/权限边界（注入用）/协作方式，4 段）。
2. **装配**：Leader 派发时按上方装配表加载对应能力层手册；角色边界要点可内联进 task.cmd。
3. **治理原则**：`references/constitution.md` 为项目级不可协商原则（编码/安全/合规/架构/门禁 5 章 MUST/SHOULD），角色细则引用格式「参考 Constitution §[章节]：[条目]」。
4. **工作流蓝图**：`references/workflow.md`（角色 DAG + 11 步流转（`exec` 拆 `exec-work`/`exec-review` 两步）+ 产物契约表）；Designer 四件套等模板见 `references/templates/`。
5. **Leader 派发 task.cmd 示例**：wave_plan 的 task.cmd 示例——
   ```
   { id: 'mod-a', cmd: '加载 software-team 后按 designer 手册：spec-writing 产出 design.md', tools: ['skill','fs'] }
   ```

### 治理工具补充（artifact_types / log_export）

> 两工具已注册于治理工具面（README 治理工具 20 清单内），此处补用途/触发/装配键口径（与引擎实现一致）。

| 工具 | 实现 | 用途 | 触发场景 | 装配键 |
|---|---|---|---|---|
| `artifact_types` | lib/artifact-types.js | 产物类型注册表只读查询：产物类型 → 层/目录前缀约定（plan/exec/audit），供 wave_plan 声明 consume/produce/outputs 与模板对齐；不绑定团队模板 | wave_plan 建批前声明产物归属、或核对产物路径契约时 | 恒注册（core 工具面） |
| `log_export` | lib/tools/log-tools.js | 批次事件日志只读导出（store.readBatch 纯读投影，零副作用）：lane/type/since 过滤 + json/markdown 格式 + 可选 writeTo 落盘引擎产物根（批次内相对路径防逃逸） | 审计/复盘需完整事件时间线（batch_status 事件摘要之外的明细）时 | `capabilities.logs`（默认关；显式 `logs.enabled:true` 注册，如 cordis.patch.yml） |

## C 类触发后的执行机制（难度判定归蟛蜞模式）

> 分层边界：任务难度判定（A/B/C 三档路由、**无默认档**——Leader 须用 `assign_check({ difficulty, rationale, scope: "full" })` 主动写入难度值 `difficulty`（A|B|C）与判据 `rationale`（≥12 字），旧「default to C」口径已废止；不再有 C+ 档，**exec 层 lane≥3 的三层批**建批须传 `assembly` 且 `managerPlan` **缺省 `raise`**——须 Manager 的批在派发首个 exec lane 前拉起并 `batch_phase` 登记（未登记即拒派）；需 Leader 直驱时**显式**声明 `managerPlan:'leader-direct'`，装配强制见上节「装配模式与角色装配决策」）由蟛蜞模式难度门禁负责（assign_check guard），本技能**不参与难度判定**——只描述 C 类任务确定后的执行方式。

C 类任务确定后的执行方式：`wave_plan` 建批次 → `member_status` 派发 → 治理闭环（状态机/mailbox/锁/结算）。

## 三层门禁（Tier3）

| 层 | 引擎强制语义 |
|---|---|
| plan 🎯 | 产物契约：spec.md 必含 `## 验收标准`/`## 约束` 章节——merged 前 Plan 契约校验（GATE_PLAN_CONTRACT）；`task-tree.json` **声明了才校验**（**按需声明**：需要任务树的批次由建批 `tasks` 面声明，声明了则须合法 JSON） |
| exec ⚡ | 派发前 consume 产物齐备（缺则拒派 GATE_ENTRY_MISSING）；结算前 outputs 落盘（缺则拒 merged） |
| audit 🛡️ | 结算前 produce（review.md 归 Reviewer；gap-list.json/acceptance-report.md 由 Supervisor audit 对账产出）落盘；批次 complete 前置 audit 验收完成（缺则拒 complete） |

- **委派判定**：assign_check 输出 A/B/C + 判据（`difficulty` 主动写入、**无默认档**；`rationale` ≥12 字）——C 类（多线并行或多依赖）必须 wave_plan 建批；**exec 层 lane≥3 的三层批**另须传 `assembly`（`managerPlan` **缺省 `raise`**——须 Manager 的批在派发首个 exec lane 前拉起并 `batch_phase` 登记，未登记即拒派；需 Leader 直驱时**显式**声明 `managerPlan:'leader-direct'`，含 Manager+Coordinator 强制装配，见「装配模式与角色装配决策」节）；
- **失败处理**：failed 为终态，重做=重开新批次；返工（review→running）保留；
- **状态查询**：gate_status 查 lane 缺什么产物/契约问题；
- **needHuman 契约（audit）**：产物可含独立行 `needHuman: true` 声明——merged 须带人工裁决证据 `human:<裁决人>:<时间>:<结论>`（如 `human:user@2026-08-21:accept`），缺则 GATE_NEEDHUMAN_PENDING 拒 merged；
- **gate 契约（exec）**：产物可含独立行 `gate: <命令>`（行首锚定，可多行顺序执行）——merged 前置确定性执行，exit 0 通过；失败拒 merged（GATE_EXIT_*，lane 留 review）；失败且产物声明 needHuman: true → 转人工闸。

**产物契约表**（详见 `references/workflow.md` §三）：plan→（leader-decision-pack/codebase-survey/四件套，`task-tree` **按需声明**）；exec→（代码/测试报告）；audit→（review/gap-list/acceptance/retrospective）。

**模板↔产物映射表**（详见 `references/workflow.md` §三末）：references/templates/ 6 模板（5 md：leader-decision-pack / plan / call-chain-matrix / endpoint-behavior / success-pattern-seeds + 1 json 数据模板：gap-list）→ 产出物 → layer/consume 归属逐条可查。

## 蟛蜞治理集成（worker 视角）

1. 你在 wavePlan 的一个 lane 中执行；任务指令（task.cmd）会注明要加载的手册技能名——先 `skill` 加载再动手。
2. 按手册的产出格式工作，产物结构化落盘（勿在回执里复制正文）。
3. 完成后由 Leader 结算：通过线=merged，返工线=打回重做（同一 lane 3 次后升级人工/Leader 指挥方向）。
4. 评审类角色按双线审查：通过线/返工线输出 MUST-FIX 清单（见 review-execution / acceptance-gate）。
5. 全员短生命周期：专注当前任务，不假设跨轮上下文（跨轮信息走 mailbox 元数据与状态文件）。

## 边界

- 本技能**不含**操作流程（用 team-asset.yml 声明的能力层技能）与运行时调度（用 dsh-punky-swarm 工具）。
- roles/*.md 采用 4 段骨架；角色语义以 `references/roles/<role>.md` 为准。

## 成员扩展技能推荐

> 原则：worker 短生命周期，加载技能聚焦当前任务；展示/文件生成类技能按产出物需要按需加载，不默认装配。

### 推荐补充（成员可加载）

| 角色 | 推荐补充技能 | 用途 | 优先级 |
|---|---|---|---|
| Coder | diagnosing-bugs | 疑难 bug 诊断入口 | 高 |
| Coder | system-diagnosis-progressive-fix | 系统性故障渐进修复（对比评估→方案→分层实现） | 高 |
| Coder | system-debug-diagnosis | 系统级排查（配置/集成/服务类） | 中 |
| Coder | frontend-backend-state-debug | 前后端状态联动调试 | 中 |
| Coder | argument-compat-fix | Python 传参不兼容修复 | 中 |
| Coder | damaged-file-restoration | 受损文件 3 级恢复 | 中 |
| Designer | design-an-interface ✅ | 并行子代理生成多套接口设计（契合集群并行） | 中 |
| Supervisor / Doc-Manager | retro-and-memory、comet-archive | 归档闭环（计划归档 / OpenSpec 变更归档） | 高 |
| Leader / Manager | tech-benchmark-planning ✅ | 技术参考项目对标→机制差距→升级方案 | 高 |
| Leader / Manager | team-orchestration | 子代理编排指南（派发参考） | 中 |
| Leader / Manager | competition-analysis ✅ | 竞品系统化对比分析 | 低 |
| Leader / Manager | grilling | 方案质询压力测试（人审对接，走 ask_user_question） | 中 |
| Leader / Manager | decision-mapping ✅ | 松散想法→调查 ticket 序列→逐项推进 | 低 |
| Leader / Manager | team-skill-troubleshoot | 装配/角色注册排查 | 低 |

### 弃用（不装配）

> 本节为历史记录（记录当时的取舍），不代表当前装配；当前装配以 presets/software-team/team-asset.yml 为准。

以下技能弃用，不装配。

| 技能 | 角色 | 弃用原因 |
|---|---|---|
| resolving-merge-conflicts | Coder | 低频；git 冲突处理可由 efficient-edit 流程覆盖 |
| domain-modeling | Designer | 与 codebase-design / CONTEXT.md 术语表约定重叠 |
| doc-code-auditor | Reviewer | 文档-代码一致性审计由 doc-update 流程覆盖 |
| open-code-review-cli | Reviewer | 依赖 npm 包 @alibaba-group/open-code-review（ocr CLI），装配前需确认可用，不装配 |
| task-planning-suite | Leader | 与 writing-plans 编排功能重叠 |
| triage | Leader | 低频；issue 收单由团队/人工直接处理 |

### 明确不装配

> 本节为历史记录（记录当时的取舍），不代表当前装配；当前装配以 presets/software-team/team-asset.yml 为准。

| 技能 | 剔除原因 |
|---|---|
| git-guardrails-claude-code | Claude Code 专属 hooks，dsh 无对应运行时 |
| to-prd | disable-model-invocation 命令式，worker 不可加载 |
| qa / handoff / llm-wiki | 交互式会话/旧运行时会话移交/知识库（mneme 已覆盖） |
| prototype / scaffold-exercises / teach / ask-matt | 一次性脚手架/教学向，非成员聚焦 |
| obsidian-vault / migrate-to-shoehorn / setup-* / delayed-restart-app / openJiuwen-DeepSearch | 环境特定或 dsh 环境不可用的运行时专属 |
| 展示/文件生成类（flowchart、ppt-animation、network-protocol-viz、scholar-notes、dynamic-archify、office-academic-skill、academic-writing-skill-set、writing-trio、revision-patterns、citation-evaluator、research-writing、gpt-sovits-tts-synthesis、ivt-poem-analyzer、baoyu-article-illustrator） | 产出物是演示/文档文件时按需加载，不默认装配 |
| 全部 *-team / *_team 团队技能（33 个） | 团队型运行时，由 dsh-punky-swarm 集群模式承担，不装配（**不含本仓自带团队技能**：本技能 `software-team` 与同仓 `design-team` 为集群模式下的团队技能本体，属装配表定义对象，不在本行排除范围内） |
