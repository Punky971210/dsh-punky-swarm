---
name: jiufeng-team
description: |
  蟛蜞模式指引层 + 装配层统合技能：角色定义（源自 jiufeng-expandable-team v1.3.0 的 3 层 8 角色，
  见 references/roles/）+ 角色×操作手册装配表（dev*/prd*/review*/doc* 手册映射）。
  行为层（hardening/rail）不迁移，由 dsh-punky-swarm 承担。
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

# jiufeng-team — 蟛蜞模式角色 × 装配（统合版）

> 2026-08-19 统合：原 jiufeng-roles（指引层角色定义）已并入本技能，roles 为子目录 `references/roles/`；装配映射与角色定义单一来源均为本技能。行为层 hardening/rail 由 dsh-punky-swarm 承担。

## 角色概览（3 层 8 角色，源自 jiufeng-expandable-team v1.3.0）

| 层 | 角色 | 职责 | 能力层手册 | 可拓展性 |
|----|------|------|-----------|:--------:|
| 任务层 🎯 | Coordinator | 细拆（API 粒度）+ 代码摸底（粗拆已上移 Leader 人工对接） | dev-planner | 固定 |
| 任务层 🎯 | Manager | 任务池调度 + 双线审查路由 + HATL 返工门禁 | dev-planner | 固定 |
| 任务层 🎯 | Designer | 四件套产出（plan/coder-tasks/tester-tasks/spec） | dev-designer, spec-writing | 固定 |
| 执行层 ⚡ | Coder 池 | spec 驱动编码 + 自检 | dev-coder, efficient-edit 等 | 动态（推荐 3） |
| 执行层 ⚡ | Tester 池 | spec 驱动测试，不打回约束 | dev-tester | 动态（推荐 2） |
| 执行层 ⚡ | Reviewer | 对抗式审查 + Converge 差距扫描 | code-review-guideline, report-blind-audit | 固定 |
| 审计层 🛡️ | Supervisor | CBM 全量验收 + gap-list 对账 → HITL 门禁 | report-blind-audit, archive | 固定 |
| 审计层 🛡️ | Doc-Manager | 复盘 + 记忆沉淀（dsh-mneme 优先；Mnemopi 降级） | doc-generator, doc-update | 固定 |

## 装配表（角色 → 操作手册）

| 层 | 角色 | 操作手册（skill 工具加载） | 关键产出 |
|---|---|---|---|
| 任务层 | Coordinator/Manager | dev-planner | 排期 / 派发 manifest |
| 执行层 | Designer | dev-designer + spec-writing | design.md / PRD / spec（to-prd 为 disable-model-invocation 命令式技能，不适用于 worker） |
| 执行层 | Coder（池） | dev-coder + efficient-edit + codebase-design | 代码 + dev_plan checklist |
| 执行层 | Tester（池） | dev-tester | 测试集 + 结果 |
| 执行层 | Reviewer | code-review-guideline + report-blind-audit | review.md + gap-list.json |
| 审计层 | Supervisor | report-blind-audit + archive（comet-archive 可选：OpenSpec 变更归档） | 验收报告（HITL 门禁） |
| 审计层 | Doc-Manager | doc-generator + doc-update | 文档/复盘 |

### 任务包最小结构（Leader 派发模板）

wave_plan 的 lane 任务包只含**角色/目标/契约/验收**，Leader 不预写实现（蟛蜞模式纪律 0e：调用链设计、脚本实现由被指派 worker 全权负责）：

```json
{ id, role: 'Coder'|'Tester'|'Supervisor', layer: 'plan'|'exec'|'audit',
  cmd: '加载 <手册技能>，按任务包自行设计实现并落盘产物',
  consume: [...], produce: [...],
  验收标准: [...] }
```

## 使用方式

1. **查角色**：读 `references/roles/<role>.md`（身份/触发条件/协作模式/Success Criteria/Boundary/输出 schema）。
2. **装配**：Leader 派发时按上方装配表加载对应能力层手册；角色边界要点可内联进 task.cmd。
3. **治理原则**：`references/constitution.md` 为项目级不可协商原则（编码/安全/合规/架构/门禁 5 章 MUST/SHOULD），角色细则引用格式「参考 Constitution §[章节]：[条目]」。
4. **工作流蓝图**：`references/workflow.md`（角色 DAG + 11 步流转 + 产物契约表）；Designer 四件套等模板见 `references/templates/`。

## C 类触发后的执行机制（难度判定归蟛蜞模式）

> 分层边界：任务难度判定（A/B/C 路由，default to C）由蟛蜞模式难度门禁负责（preset persona 纪律 0 + assign_check guard），本技能**不参与难度判定**——只描述 C 类任务确定后的执行方式。

| 级别 | 判据 | 执行方式 |
|---|---|---|
| A（Leader 直做） | 单步可验证、低风险、无需多角色协作（小改动/单文件生成/快速查询） | Leader 直接完成：不建批次、不派发、不写 mailbox，零治理开销（是否判 A 由蟛蜞模式门禁裁决） |
| C（复杂/大型） | 需并行、多角色、多轮协作或高门禁 | wave_plan 建批次 → member_status 派发 → 治理闭环（状态机/mailbox/锁/结算） |

## 三层门禁（Tier3，2026-08-19 回填）

| 层 | 引擎强制语义 |
|---|---|
| plan 🎯 | 产物契约：spec.md 必含 `## 验收标准`/`## 约束` 章节 + task-tree.json 合法 JSON——merged 前 L0 校验（GATE_PLAN_CONTRACT） |
| exec ⚡ | 派发前 consume 产物齐备（缺则拒派 GATE_ENTRY_MISSING）；结算前 outputs 落盘（缺则拒 merged） |
| audit 🛡️ | 结算前 produce（review.md/gap-list.json）落盘；批次 complete 前置 audit 验收完成（缺则拒 complete） |

- **委派判定**：assign_check 输出 A/B/C——C 类（并行/多角色/门禁/可恢复）必须 wave_plan 建批；
- **失败处理**：failed 为终态，重做=重开新批次；返工（review→running）保留；
- **状态查询**：gate_status 查 lane 缺什么产物/契约问题。

**产物契约表**（详见 `references/workflow.md` §三）：plan→（leader-decision-pack/task-tree/codebase-survey/四件套）；exec→（代码/测试报告）；audit→（review/gap-list/acceptance/retrospective）。

## 蟛蜞治理集成（worker 视角）

1. 你在 wavePlan 的一个 lane 中执行；任务指令（task.cmd）会注明要加载的手册技能名——先 `skill` 加载再动手。
2. 按手册的产出格式工作，产物结构化落盘（勿在回执里复制正文）。
3. 完成后由 Leader 结算：通过线=merged，返工线=打回重做（同一 lane 3 次后升级人工/Leader 指挥方向）。
4. 评审类角色按双线审查：通过线/返工线输出 MUST-FIX 清单（见 code-review-guideline / report-blind-audit）。
5. 全员短生命周期：专注当前任务，不假设跨轮上下文（跨轮信息走 mailbox 元数据与状态文件）。

## 使用方式（Leader）

wave_plan 的 task.cmd 示例：
```
{ id: 'mod-a', cmd: '加载 jiufeng-team 后按 Designer 手册（dev-designer+spec-writing）产出 design.md', tools: ['skill','fs'] }
```

## jiuwen 运行时绑定 → 蟛蜞模式等价（行为层不迁移）

| 原 roles/*.md 中的 jiuwen 绑定 | 蟛蜞模式等价物（dsh-punky-swarm） |
|---|---|
| send_message 空闲上报/任务包派发 | wavePlan lane 任务 + mailbox（inbox/outbox/broadcast）+ member_status |
| manifest.json 状态标记（ready/in_progress/done） | 批次状态机（pending/running/review/merged/failed）+ 事件日志 |
| spawn 顺序/池化实例协议（bind.md） | wave_plan 并发池 + 任务 deps 分层（不迁移 spawn 脚本） |
| HITL/HATL 门禁（3 次打回→Leader） | 人审门禁：全额通过自动放行；同子模块 3 次打回→Leader 指挥方向 |
| 官方状态机/事件/checkpoint 端点（hardening/*） | 本地文件黑板 + 状态文件 + O_EXCL 锁（不迁移 hardening/） |
| 复盘记忆入库 | dsh-mneme（开放记忆语义）；Mnemopi 降级 |

## 边界

- 本技能**不含**操作流程（用 dev-coder 等能力层）与运行时调度（用 dsh-punky-swarm 工具）。
- roles/*.md 为 v1.3.0 原文保真；其中 jiuwen 协作协议（send_message/manifest/spawn）在蟛蜞模式下按上表映射。

## 成员扩展技能推荐（2026-08-18 全量盘点定稿 · 2026-08-19 迁移/弃用更新）

> 依据：原 JiuwenSwarm 技能仓库 93 包逐包读 SKILL.md 判定（分类全表见 docs/skills-evaluation.md）。
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
| Designer | design-an-interface ✅ | 并行子代理生成多套接口设计（契合集群并行，2026-08-19 已迁移） | 中 |
| Supervisor / Doc-Manager | archive、comet-archive | 归档闭环（计划归档 / OpenSpec 变更归档） | 高 |
| Leader / Manager | tech-benchmark-planning ✅ | 技术参考项目对标→机制差距→升级方案（2026-08-19 已迁移） | 高 |
| Leader / Manager | team-orchestration | 子代理编排指南（派发参考） | 中 |
| Leader / Manager | competition-analysis ✅ | 竞品系统化对比分析（2026-08-19 已迁移） | 低 |
| Leader / Manager | grilling | 方案质询压力测试（HITL 对接，已迁移至 dsh 技能库，走 ask_user_question） | 中 |
| Leader / Manager | decision-mapping ✅ | 松散想法→调查 ticket 序列→逐项推进（2026-08-19 已迁移） | 低 |
| Leader / Manager | team-skill-troubleshoot | 装配/角色注册排查 | 低 |

### 弃用（2026-08-19 声明，不再装配/迁移）

以下技能曾列于推荐补充，现**声明弃用**：不迁移、不装配，声明中的引用即失效（引用方已同步清理）。

| 技能 | 原推荐角色 | 弃用原因 |
|---|---|---|
| resolving-merge-conflicts | Coder | 低频；git 冲突处理可由 efficient-edit 流程覆盖 |
| domain-modeling | Designer | 与 codebase-design / CONTEXT.md 术语表约定重叠 |
| doc-code-auditor | Reviewer | 文档-代码一致性审计并入 doc-update 流程 |
| open-code-review-cli | Reviewer | 依赖 npm 包 @alibaba-group/open-code-review（ocr CLI），装配前需确认可用，暂不迁移 |
| task-planning-suite | Leader | 与 dev-planner 编排功能重叠 |
| triage | Leader | 低频；issue 收单由团队/人工直接处理 |

### 明确不装配（评估剔除）

| 技能 | 剔除原因 |
|---|---|
| git-guardrails-claude-code | Claude Code 专属 hooks，dsh 无对应运行时 |
| to-prd | disable-model-invocation 命令式，worker 不可加载 |
| qa / handoff / llm-wiki | 交互式会话/旧运行时会话移交/知识库（mneme 已覆盖） |
| prototype / scaffold-exercises / teach / ask-matt | 一次性脚手架/教学向，非成员聚焦 |
| obsidian-vault / migrate-to-shoehorn / setup-* / delayed-restart-app / openJiuwen-DeepSearch | 环境特定或 JiuwenSwarm 运行时专属 |
| 展示/文件生成类（flowchart、ppt-animation、network-protocol-viz、scholar-notes、dynamic-archify、office-academic-skill、academic-writing-skill-set、writing-trio、revision-patterns、citation-evaluator、research-writing、gpt-sovits-tts-synthesis、ivt-poem-analyzer、baoyu-article-illustrator） | 产出物是演示/文档文件时按需加载，不默认装配 |
| 全部 *-team / *_team 团队技能（33 个） | 团队型运行时，由 dsh-punky-swarm 集群模式承担，暂不迁移 |
