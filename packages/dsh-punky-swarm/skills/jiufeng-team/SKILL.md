---
name: jiufeng-team
description: |
  蟛蜞模式指引层 + 装配层技能：角色定义（3 层 8 角色，
  见 references/roles/）+ 角色×操作手册装配表（dev*/prd*/review*/doc* 手册映射）。
  行为层（hardening/rail）由 dsh-punky-swarm 承担。
  当需要确定某角色"是谁/能做什么/不能做什么/成功标准/输出格式"，或 Leader 派发 worker
  需按角色装配操作手册技能时加载本技能。
version: "1.0.0"
kind: skill
triggers:
  - "角色定义"
  - "角色指引"
  - "装配表"
  - "这个角色负责什么"
  - "角色的边界"
  - "派发任务"
---

# jiufeng-team — 蟛蜞模式角色 × 装配

> roles 为子目录 `references/roles/`；装配映射与角色定义单一来源均为本技能。行为层 hardening/rail 由 dsh-punky-swarm 承担。

## 角色概览（3 层 8 角色）

| 层 | 角色 | 职责 | 能力层手册 | 可拓展性 |
|----|------|------|-----------|:--------:|
| 任务层 🎯 | Coordinator | 细拆（API 粒度）+ 代码摸底（粗拆已上移 Leader 人工对接） | dev-planner | 固定 |
| 任务层 🎯 | Manager | 任务池调度 + 双线审查路由 + 人审返工门禁 | 治理工具（见装配表） | 固定 |
| 任务层 🎯 | Designer | 四件套产出（plan/coder-tasks/tester-tasks/spec） | dev-designer, spec-writing | 固定 |
| 执行层 ⚡ | Coder 池 | spec 驱动编码 + **最小自检** | dev-coder, efficient-edit 等 | 动态（推荐 3） |
| 执行层 ⚡ | Tester 池 | spec 驱动测试 + **功能验证/全量测试**（端到端、回归、验收执行） | dev-tester | 动态（推荐 2） |
| 执行层 ⚡ | Reviewer | 对抗式审查 + MUST/SHOULD/FYI 分级 | code-review-guideline, report-blind-audit | 固定 |
| 审计层 🛡️ | Supervisor | CBM 全量验收 + gap-list 对账 → 人审门禁 | report-blind-audit, archive | 固定 |
| 审计层 🛡️ | Doc-Manager | 复盘 + 记忆沉淀（dsh-mneme 优先；Mnemopi 降级） | doc-generator, doc-update | 固定 |

## 装配表（角色 → 操作手册）

| 层 | 角色 | 操作手册（skill 工具加载） | 关键产出 |
|---|---|---|---|
| 任务层 | Coordinator | dev-planner | 细拆（API 粒度）+ 代码摸底（task-tree.json / codebase-survey.md） |
| 任务层 | Manager | 治理工具（batch_status/gate_status/mailbox_*/member_*/lane_*） | 只指挥不执行：读黑板/mailbox → mailbox_send 建议派发 → 按 Leader 裁决执行 member_status/member_settle；不派子代理、不写代码、不读产物正文 |
| 执行层 | Designer | dev-designer + spec-writing | design.md / PRD / spec（to-prd 为 disable-model-invocation 命令式技能，不适用于 worker）；plan 层 lane role 强制 designer |
| 执行层 | Coder（池） | dev-coder + efficient-edit + codebase-design | 代码 + dev_plan checklist |
| 执行层 | Tester（池） | dev-tester | 测试集 + 结果 |
| 执行层 | Reviewer | code-review-guideline + report-blind-audit | review.md + acceptance-checklist.md（验收检查清单） |
| 审计层 | Supervisor | report-blind-audit + archive（comet-archive 可选：OpenSpec 变更归档） | acceptance-report.md + gap-list.json（audit 对账） |
| 审计层 | Doc-Manager | doc-generator + doc-update | 文档/复盘 |

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

> 约束：按真实用户行为操作（点击调用链，禁机器式调接口）；产物落盘 `artifacts/<batchId>/`；诚实披露（失败/异常如实记录）；回执简短结构化（对比表/清单）。

roles 权限边界引用格式：`约束：公共约束见 SKILL.md §worker 公共约束；本角色差异：<仅差异>`——差异为空则整行省略。

### 任务包最小结构（Leader 派发模板）

wave_plan 的 lane 任务包只含**角色/目标/契约/验收** + 角色注入，Leader 不预写实现（调用链设计、脚本实现由被指派 worker 全权负责）。顶层字段 ≤10（id/role/layer/cmd/角色注入/产物落盘/契约/回执/纪律/验收标准），五字段必保（角色/目标/契约/验收/产物落盘），示例 ≤800 字符：

```json
{ id, role, layer,
  cmd: '加载 <手册技能>，按任务包自行设计实现并落盘产物',
  角色注入: '<Persona 一段 ≤50 字>；<权限边界 可执行/禁止 各 ≤1 行，公共约束不重复>',
  产物落盘: '引擎产物根见 SKILL.md 单一来源（两档写法/asset_claim），本 lane 落 <layer>/<lane>/',
  契约: { consume: [...], produce: [...] },
  worker 双通道回执: 'report 回报 Leader（一行）+ mailbox_send outbox 通知 Manager',
  纪律: '见 SKILL.md §纪律要点；本 lane 适用=<≤2 条裁剪>',
  验收标准: [...] }
```

### 纪律要点（派发前速查）

- exec 层 code/test 职能分离：Coder 最小自检（语法/lint/编译/已改文件单测冒烟），全量回归/端到端/验收归 Tester；
- test/review 与 code 并行准备验收套件（准备段同 wave、执行段 code 完成即触发），consume 指向 plan 产物；
- plan 四件套归 Designer（role=designer，禁止 manager 代产）；
- audit worker 完成即终态，追加任务=新 lane 新派发，禁止 send_message 复用；
- 派发 sessionId/产物根从 batch_status 读取注入，禁手写；
- audit lane 统一命名 audit-accept/audit-verify；报告措辞「待 Leader 处置的 gap 清单（不得由 audit 执行）」；
- test 产可执行测试套件（PASS/FAIL 证据），review 产验收检查清单（MUST/SHOULD/FYI），二者互补不重复；
- worker 每完成子步骤即 lane_checkpoint 提交保全（崩溃后 git log 可查、人工可抢救），禁止攒批；续跑前 lane_checkpoint_status 查询跳过已完成步骤（checkpoint 纪律单一来源，roles 不再重复详述）；
- C 类多 lane 写同一 git 仓库时：exec 派发前 lane_worktree_create 建独立 worktree，将返回路径注入任务包作 cwd 契约（物理隔离，防 git 锁冲突）；
- 治理工具豁免难度门禁：batch_*/member_*/mailbox_*/lane_*/gate_status/assign_check/artifact_types/log_export 等治理/查询工具属非执行型放行（防死锁——治理循环中 Leader 必须能查询/结算）；豁免仅限难度门禁，其余 guard 语义（EXEC_TOOLS 名单、计数）不受影响（口径与引擎 lib/tools/core.js installDifficultyGuard 注释一致）；
- 不引入 audit 预算/节流字段（省 token、避免机械限制审计深度）。

### Manager 角色派发模板（代劳指挥 · continuable subagent）

Leader 拉起 Manager（一次，注入批次上下文 + 调度循环说明）时按下方模板注入。**Manager 定位：代劳指挥——只指挥不执行、不派发子代理（worker 由 Leader 派发，depth-1 直系）；Manager 只读黑板/mailbox、做结算裁决，不经 subagent 创建 worker**。

**指挥循环**（每 turn）：
1. `batch_status` 读黑板 → 发现可派 lane（deps 已满足且 pending）；
2. `mailbox_send` inbox/broadcast 建议 Leader 派发（lane id + 角色建议）；
3. `mailbox_read` outbox 收 worker 完成通知；
4. `member_status` running→review → `member_settle` 结算裁决；
5. 循环至批次全终态 → report「批次完成」给 Leader。

**Leader 职责对应**：按 Manager 建议 subagent 派发 worker（depth-1 直系，任务包注明双通道回执）；worker report 完成 → `send_message` Manager 事件唤醒（一行，不做调度决策）。

## 使用方式

1. **查角色**：读 `references/roles/<role>.md`（Persona（注入用）/职责与产出/权限边界（注入用）/协作方式，4 段）。
2. **装配**：Leader 派发时按上方装配表加载对应能力层手册；角色边界要点可内联进 task.cmd。
3. **治理原则**：`references/constitution.md` 为项目级不可协商原则（编码/安全/合规/架构/门禁 5 章 MUST/SHOULD），角色细则引用格式「参考 Constitution §[章节]：[条目]」。
4. **工作流蓝图**：`references/workflow.md`（角色 DAG + 11 步流转 + 产物契约表）；Designer 四件套等模板见 `references/templates/`。
5. **Leader 派发 task.cmd 示例**：wave_plan 的 task.cmd 示例——
   ```
   { id: 'mod-a', cmd: '加载 jiufeng-team 后按 Designer 手册（dev-designer+spec-writing）产出 design.md', tools: ['skill','fs'] }
   ```

### 治理工具补充（artifact_types / log_export）

> 两工具已注册于治理工具面（README 治理工具 20 清单内），此处补用途/触发/装配键口径（与引擎实现一致）。

| 工具 | 实现 | 用途 | 触发场景 | 装配键 |
|---|---|---|---|---|
| `artifact_types` | lib/artifact-types.js | 产物类型注册表只读查询：产物类型 → 层/目录前缀约定（plan/exec/audit），供 wave_plan 声明 consume/produce/outputs 与模板对齐；不绑定团队模板 | wave_plan 建批前声明产物归属、或核对产物路径契约时 | 恒注册（core 工具面） |
| `log_export` | lib/tools/log-tools.js | 批次事件日志只读导出（store.readBatch 纯读投影，零副作用）：lane/type/since 过滤 + json/markdown 格式 + 可选 writeTo 落盘引擎产物根（批次内相对路径防逃逸） | 审计/复盘需完整事件时间线（batch_status 事件摘要之外的明细）时 | `capabilities.logs`（默认关；显式 `logs.enabled:true` 注册，如 cordis.patch.yml） |

## C 类触发后的执行机制（难度判定归蟛蜞模式）

> 分层边界：任务难度判定（A/B/C 路由，default to C）由蟛蜞模式难度门禁负责（assign_check guard），本技能**不参与难度判定**——只描述 C 类任务确定后的执行方式。

C 类任务确定后的执行方式：`wave_plan` 建批次 → `member_status` 派发 → 治理闭环（状态机/mailbox/锁/结算）。

## 三层门禁（Tier3）

| 层 | 引擎强制语义 |
|---|---|
| plan 🎯 | 产物契约：spec.md 必含 `## 验收标准`/`## 约束` 章节 + task-tree.json 合法 JSON——merged 前 Plan 契约校验（GATE_PLAN_CONTRACT） |
| exec ⚡ | 派发前 consume 产物齐备（缺则拒派 GATE_ENTRY_MISSING）；结算前 outputs 落盘（缺则拒 merged） |
| audit 🛡️ | 结算前 produce（review.md 归 Reviewer；gap-list.json/acceptance-report.md 由 Supervisor audit 对账产出）落盘；批次 complete 前置 audit 验收完成（缺则拒 complete） |

- **委派判定**：assign_check 输出 A/B/C——C 类（并行/多角色/门禁/可恢复）必须 wave_plan 建批；
- **失败处理**：failed 为终态，重做=重开新批次；返工（review→running）保留；
- **状态查询**：gate_status 查 lane 缺什么产物/契约问题；
- **needHuman 契约（audit）**：产物可含独立行 `needHuman: true` 声明——merged 须带人工裁决证据 `human:<裁决人>:<时间>:<结论>`（如 `human:user@2026-08-21:accept`），缺则 GATE_NEEDHUMAN_PENDING 拒 merged；
- **gate 契约（exec）**：产物可含独立行 `gate: <命令>`（行首锚定，可多行顺序执行）——merged 前置确定性执行，exit 0 通过；失败拒 merged（GATE_EXIT_*，lane 留 review）；失败且产物声明 needHuman: true → 转人工闸。

**产物契约表**（详见 `references/workflow.md` §三）：plan→（leader-decision-pack/task-tree/codebase-survey/四件套）；exec→（代码/测试报告）；audit→（review/gap-list/acceptance/retrospective）。

**模板↔产物映射表**（详见 `references/workflow.md` §三末）：references/templates/ 6 模板（5 md：leader-decision-pack / plan / call-chain-matrix / endpoint-behavior / success-pattern-seeds + 1 json 数据模板：gap-list）→ 产出物 → layer/consume 归属逐条可查。

## 蟛蜞治理集成（worker 视角）

1. 你在 wavePlan 的一个 lane 中执行；任务指令（task.cmd）会注明要加载的手册技能名——先 `skill` 加载再动手。
2. 按手册的产出格式工作，产物结构化落盘（勿在回执里复制正文）。
3. 完成后由 Leader 结算：通过线=merged，返工线=打回重做（同一 lane 3 次后升级人工/Leader 指挥方向）。
4. 评审类角色按双线审查：通过线/返工线输出 MUST-FIX 清单（见 code-review-guideline / report-blind-audit）。
5. 全员短生命周期：专注当前任务，不假设跨轮上下文（跨轮信息走 mailbox 元数据与状态文件）。

## 边界

- 本技能**不含**操作流程（用 dev-coder 等能力层）与运行时调度（用 dsh-punky-swarm 工具）。
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
| Supervisor / Doc-Manager | archive、comet-archive | 归档闭环（计划归档 / OpenSpec 变更归档） | 高 |
| Leader / Manager | tech-benchmark-planning ✅ | 技术参考项目对标→机制差距→升级方案 | 高 |
| Leader / Manager | team-orchestration | 子代理编排指南（派发参考） | 中 |
| Leader / Manager | competition-analysis ✅ | 竞品系统化对比分析 | 低 |
| Leader / Manager | grilling | 方案质询压力测试（人审对接，走 ask_user_question） | 中 |
| Leader / Manager | decision-mapping ✅ | 松散想法→调查 ticket 序列→逐项推进 | 低 |
| Leader / Manager | team-skill-troubleshoot | 装配/角色注册排查 | 低 |

### 弃用（不装配）

以下技能弃用，不装配。

| 技能 | 角色 | 弃用原因 |
|---|---|---|
| resolving-merge-conflicts | Coder | 低频；git 冲突处理可由 efficient-edit 流程覆盖 |
| domain-modeling | Designer | 与 codebase-design / CONTEXT.md 术语表约定重叠 |
| doc-code-auditor | Reviewer | 文档-代码一致性审计由 doc-update 流程覆盖 |
| open-code-review-cli | Reviewer | 依赖 npm 包 @alibaba-group/open-code-review（ocr CLI），装配前需确认可用，不装配 |
| task-planning-suite | Leader | 与 dev-planner 编排功能重叠 |
| triage | Leader | 低频；issue 收单由团队/人工直接处理 |

### 明确不装配

| 技能 | 剔除原因 |
|---|---|
| git-guardrails-claude-code | Claude Code 专属 hooks，dsh 无对应运行时 |
| to-prd | disable-model-invocation 命令式，worker 不可加载 |
| qa / handoff / llm-wiki | 交互式会话/旧运行时会话移交/知识库（mneme 已覆盖） |
| prototype / scaffold-exercises / teach / ask-matt | 一次性脚手架/教学向，非成员聚焦 |
| obsidian-vault / migrate-to-shoehorn / setup-* / delayed-restart-app / openJiuwen-DeepSearch | 环境特定或 dsh 环境不可用的运行时专属 |
| 展示/文件生成类（flowchart、ppt-animation、network-protocol-viz、scholar-notes、dynamic-archify、office-academic-skill、academic-writing-skill-set、writing-trio、revision-patterns、citation-evaluator、research-writing、gpt-sovits-tts-synthesis、ivt-poem-analyzer、baoyu-article-illustrator） | 产出物是演示/文档文件时按需加载，不默认装配 |
| 全部 *-team / *_team 团队技能（33 个） | 团队型运行时，由 dsh-punky-swarm 集群模式承担，不装配 |
