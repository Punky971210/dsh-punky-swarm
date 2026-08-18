# 原 JiuwenSwarm 技能仓库 93 包分类评估（2026-08-18）

> 输入：~/.jiuwenswarm/agent/workspace/skills（93 包）
> 方法：逐包读取 SKILL.md 正文/front matter（name+description 宽松解析），按四类判定。
> 用途：确定哪些技能适合 jiufeng-team 成员聚焦任务；展示/文件生成类按需；团队型搁置待集群模式。

## 一、分类汇总

| 分类 | 数量 | 判定标准 | 处置 |
|---|---|---|---|
| A 实用手册（成员可加载） | 32 | 聚焦开发/设计/测试/评审/排障的操作手册 | 装配给成员或按角色推荐 |
| B 展示/文件生成（按需） | 15 | 产出物为演示/文档/学术文件 | 产出物需要时按需加载 |
| C 团队/运行时（搁置） | 33 | 团队型技能/依赖 JiuwenSwarm 运行时 | 由 dsh-punky 集群模式承担，不迁移 |
| D 不实用/环境特定（剔除） | 13 | 一次性脚手架/环境专属/重复 | 不装配 |

## 二、A 类实用手册明细（32）

| 包 | 用途 | 推荐角色 |
|---|---|---|
| dev-coder | 按 dev_plan/PRD 最小可验证编码 | Coder（已迁移） |
| dev-designer | requirements→design.md | Designer（已迁移） |
| dev-planner | requirements/design→dev_plan+test_plan | Coordinator（已迁移） |
| dev-tester | test_plan 补测/执行 + pr-gate | Tester（已迁移） |
| efficient-edit | 4 级安全降级文件修改链 | 全员（已迁移） |
| codebase-design | 深度模块设计词汇 | Coder（已迁移） |
| spec-writing | 技术规格书 | Designer（已迁移） |
| code-review-guideline | 独立代码审查 | Reviewer（已迁移） |
| report-blind-audit | 评审报告二次盲审 | Reviewer/Supervisor（已迁移） |
| doc-generator | 大纲→结构化文档 | Doc-Manager（已迁移） |
| doc-update | 源码为源核对更新文档 | Doc-Manager（已迁移） |
| archive | 计划归档 .done.md | Supervisor（已迁移） |
| comet-archive | OpenSpec 变更归档 | Supervisor（可选） |
| diagnosing-bugs | 疑难 bug 诊断循环 | Coder |
| system-debug-diagnosis | 系统级故障全链路排查 | Coder |
| system-diagnosis-progressive-fix | 诊断→对比→方案→渐进实现 | Coder/Leader |
| frontend-backend-state-debug | 前后端状态联动调试 | Coder |
| argument-compat-fix | Python 传参不兼容修复 | Coder |
| damaged-file-restoration | 3 级受损文件恢复 | Coder |
| resolving-merge-conflicts | git 冲突解决 | Coder |
| doc-code-auditor | 文档-代码一致性审计（消费端） | Reviewer |
| open-code-review-cli | ocr CLI 评审报告生成 | Reviewer |
| codebase-memory-cli | 代码知识图谱引擎（已作 MCP 实装） | 全员（工具） |
| task-planning-suite | 诊断/规划/评审/执行编排器 | Leader |
| tech-benchmark-planning | 参考项目对标→机制差距→升级方案 | Leader |
| competition-analysis | 竞品系统化对比分析 | Leader |
| triage | issue 状态机收单→brief | Leader |
| handoff | 会话压缩移交文档 | Leader（dsh 下 subagent fork 更优） |
| grilling | 方案质询压力测试（HITL 对接，2026-08-18 已迁移至 dsh 技能库） | Leader（HITL 追问） |
| decision-mapping | 想法→调查 ticket 序列 | Leader |
| design-an-interface | 并行子代理多套接口设计 | Designer |
| domain-modeling | 领域术语/通用语言建模 | Designer |
| skill-creator | 技能创建/修改/导入 | 维护者（可选） |
| archive-completed-work | 已完成工作项归档 | Doc-Manager（与 archive 重叠，可选） |

## 三、B 类展示/文件生成（15，按需）

academic-writing-skill-set、research-writing、writing-trio（+revision-patterns）、citation-evaluator、office-academic-skill（原名 codex-claude-academic-skills）、baoyu-article-illustrator（原名 swarmskill-creator 未版本化）、flowchart、ppt-animation、network-protocol-viz、scholar-notes、dynamic-archify、gpt-sovits-tts-synthesis、ivt-poem-analyzer

> 判定说明：codex-claude-academic-skills 的 name 实为 office-academic-skill（中文向 Word/PPT 工作流）→ B；swarmskill-creator（无版本号）name 实为 baoyu-article-illustrator（文章配图）→ B；swarmskill-creator_1.0.0 才是技能创建工具 → C。

## 四、C 类团队/运行时（33，搁置）

> 2026-08-18 更新：jiufeng-expandable-team 按三层拆分处置——**指引层**（8 角色定义 + Constitution）已保真抽取并并入本机技能 `jiufeng-team`（~/.agents/skills/jiufeng-team/，references/roles/*.md 与 references/constitution.md 为子目录；2026-08-19 统合）；**能力层**（dev*/review*/doc* 手册）已就绪；**行为层**（hardening/ 脚本、bind.md 约束、DAG、rail）不迁移，由 dsh-punky（wavePlan 状态机/文件黑板 mailbox/互斥锁/人审门禁）承担。

jiufeng-expandable-pipeline、wisedev-team_1.0.0、systematic-debug-team（×2 版本）、api-design-review-team、pr-review-team、prd-review-team、design-review-team、incident-response-team、data-analysis-team、research-to-ppt-team、competitive-analysis（团队版）、competitive-benchmark-planning、fitness-plan-team、k12-academic-growth-coach、mental-wellness-check-team、resume-review-team、survey-design-team、tech-stack-selection-team、testing-pyramid-team、ascendc-operator-dev-optimize-team、aidlc-dev-skill_1.0.0、task-plan-exec-skill-workspace（实为 planning-and-task-breakdown，但已由 task-planning-suite/dev-planner 覆盖）、team-pipeline-creator、team-skill-creator、team-skill-troubleshoot、team-skill-troubleshoot-workspace、swarmskill-creator_1.0.0、skill-gen-4-enterprise-doc、openJiuwen-DeepSearch

## 五、D 类不实用/环境特定（13，剔除）

- Claude Code 专属：git-guardrails-claude-code
- JiuwenSwarm 运行时专属：delayed-restart-app、openJiuwen-DeepSearch（多 Agent 深度检索）
- 交互式/会话型：qa（交互 QA+GitHub issue）、handoff（会话移交，dsh 下由 subagent fork 替代）
- 一次性脚手架/教学：scaffold-exercises、teach、ask-matt（技能路由器）、setup-matt-pocock-skills、setup-pre-commit、migrate-to-shoehorn、obsidian-vault、prototype、llm-wiki（知识库，mneme/codebase-memory 已覆盖）、doc（无 SKILL.md，仅残留报告）
- 不可加载：to-prd（disable-model-invocation:true）

## 六、推荐结论

1. **成员装配**：沿用装配表 dev*/review*/doc* 主手册；补充清单见 jiufeng-team/SKILL.md「成员扩展技能推荐」。
2. **展示类**：仅当任务产出物为演示/学术文件时按需加载（flowchart/ppt 系列/office-academic-skill 等）。
3. **团队型**：全部搁置；集群模式（dsh-punky）落地后按角色映射，不迁移原仓库团队技能。
4. **工具面**：codebase-memory-cli 已作为 MCP 实装；open-code-review-cli 依赖 npm 包 @alibaba-group/open-code-review（ocr CLI），装配前需确认可用。