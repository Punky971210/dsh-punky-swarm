# jiufeng 工作流蓝图（蟛蜞模式）

> 说明：Manager 为任务第一对接点；粗拆由 Leader 人工对接；Coordinator 负责细拆与代码摸底。

## 一、角色 DAG（谁产出 → 谁消费 → 谁验证）

```mermaid
graph TD
    subgraph 任务层🎯
        L[Leader] -->|人工对接+粗拆决策包| MA[Manager]
        L -->|模块清单| CO[coordinator]
        CO -->|task-tree.json + codebase-survey.md| DE[designer]
        DE -->|四件套: plan/spec/coder-tasks/tester-tasks| MA
    end
    subgraph 执行层⚡
        MA -.->|建议派发| L
        L -->|lane 任务| CR[coder池]
        L -->|测试任务| TE[tester池]
        CR -->|代码| RV[reviewer]
        TE -->|测试报告| RV
        RV -->|PASS/REWORK（review.md）| SV[supervisor]
    end
    subgraph 审计层🛡️
        SV -->|acceptance-report + gap-list.json + CBM 对账| DM[doc-manager]
        DM -->|retrospective-report → 记忆沉淀| CO
    end
```

## 二、核心流转（11 步）

| 步骤 | 动作 | 角色 | 产出物（产物类型） |
|:----|------|------|------|
| ① | 开启任务 + 人工粗拆 | Leader | leader-decision-pack.md + 模块清单（plan/） |
| ② | 细拆 + 代码摸底 | Coordinator | task-tree.json + codebase-survey.md（plan/） |
| ③ | 任务规范设计（四件套） | Designer | plan.md + spec.md + coder-tasks.md + tester-tasks.md（plan/） |
| ④ | 建议派发 | Manager | 派发建议（mailbox inbox/broadcast）→ Leader 按建议 subagent 派发 worker（depth-1） |
| ⑤ | 编码实现 | Coder 池 | 代码（exec/） |
| ⑥a | 测试套件编写 + 验收检查清单准备（**准备段·与 code 同 wave 并行**） | Tester 池 / Reviewer | 测试套件 + 验收检查清单（exec/）——只依赖 plan 产物，不依赖 code 产物 |
| ⑥b | 运行测试套件出测试报告（**执行段·code 完成后立即**） | Tester 池 | 测试报告（exec/）——code 完成即跑，不等串行排期；gap-list 对账归 Supervisor（audit 段） |
| ⑦ | 对抗审查（执行段产物汇总） | Reviewer | review.md（audit/） |
| ⑧ | 验收审计 + gap-list 对账 | Supervisor | acceptance-report.md + gap-list.json（audit/） |
| ⑨ | 复盘沉淀 | Doc-Manager | retrospective-report.md（audit/）→ 记忆库 |
| ⑩ | 回馈循环 | Doc-Manager → Coordinator | 复盘知识 → 下一子模块 |

> 注：⑤ 编码与 ⑥a 准备段同 wave 并行；⑥b 在 code 完成后立即触发（非全串行直链）。

### 两段式 wave 示例

```
wave1: [plan-四件套]
wave2: [code-A, code-B, test-套件准备, review-清单准备]   ← 并行
wave3: [test-执行, review-执行]                            ← code 完成后触发
wave4: [audit-验收]
```

> 注记：test/review lane 的 consume 指向 **plan 产物**（spec/tester-tasks）而非 code 产物；wave3 触发条件=code 完成，不依赖串行排期。

## 三、产物契约表（对应 wave_plan 的 layer/consume/produce）

| 层 | 产物（相对批次产物根） | 消费方 |
|---|---|---|
| plan 🎯 | leader-decision-pack.md、task-tree.json、codebase-survey.md、plan.md、spec.md、coder-tasks.md、tester-tasks.md | exec（consume spec/task-tree） |
| exec ⚡ | 代码（exec/<lane>/...）、测试报告、可执行测试套件（推荐） | audit（consume 产物） |
| audit 🛡️ | review.md、gap-list.json、acceptance-checklist.md（验收检查清单，推荐）、acceptance-report.md、retrospective-report.md | 记忆沉淀（dsh-mneme） |

> 引擎只校验存在性 + Plan 契约结构底线（spec 必含 \`## 验收标准\`/\`## 约束\`、task-tree.json 合法）；四件套内部结构见 references/templates/。

### 模板 ↔ 产物映射表（P2-17 收敛：6 模板（5 md + 1 json 数据模板）指名引用）

> references/templates/ 6 模板逐一映射：模板 → 产出物 → 产物类型（artifact_types 注册表）→ layer/目录 → 产出角色 → consume 归属。call-chain-matrix / endpoint-behavior 为 **spec.md 内部章节模板**（非独立产物），由 Designer 四件套组装时填充；gap-list.json 为 **audit 对账数据模板**（非独立文件产物），由 Supervisor 对账时按 schema 落盘。

| 模板（references/templates/） | 产出物 | 产物类型 | layer / 目录 | 产出角色 | consume 归属 |
|---|---|---|---|---|---|
| leader-decision-pack.md | leader-decision-pack.md（粗拆决策包） | plan（任务层产物） | plan/ | Leader（人工对接 + grill 后） | Coordinator（细拆输入） |
| plan-template.md | plan.md（四件套之一） | plan（排期） | plan/ | Designer（dev-designer + spec-writing） | Coder/Tester/Reviewer（spec 参照） |
| call-chain-matrix-template.md | spec.md 的「调用链矩阵」章节（CH-*） | spec（执行规范） | plan/ | Designer（四件套组装时填充） | Coder/Tester（实现/测试依据） |
| endpoint-behavior-template.md | spec.md 的「端点行为」章节（EP-*） | spec（执行规范） | plan/ | Designer（四件套组装时填充） | Coder/Tester（实现/测试依据） |
| success-pattern-seeds.md | dsh-mneme 记忆（type=history/decision，SP-01~10 种子） | retrospective（复盘） | audit/ | Doc-Manager（复盘落库，非文件产物） | 记忆沉淀（后续批次检索复用） |
| gap-list.json | gap-list.json（audit 对账数据，schema 见模板） | gapList（audit 对账） | audit/ | Supervisor（audit 对账唯一产出者） | Leader（门禁裁决） |

> 产物类型名（plan/spec/taskTree/survey/code/testReport/review/gapList/acceptance/retrospective）与 lib/artifact-types.js 注册表一致；目录前缀（plan/、exec/、audit/）即 wave_plan layer 路径契约。

## 四、硬化判定点 ↔ 三层门禁

| 硬化判定点 | 三层门禁（引擎强制） |
|---|---|
| dp1 分配判定（ready→空闲实例） | Entry Gate（consume 齐备才派发）+ assign_check（A/B/C） |
| dp2 完成确认（产出完整性） | Exit Gate（outputs/produce 落盘才 merged）；exec 层产物可含独立行 `gate: <命令>`（行首锚定，可多行顺序执行）→ merged 前置确定性执行、exit 0 通过（失败拒 merged 留 review；声明 needHuman 则转人工闸） |
| dp3 审查路由（REWORK/PASS） | review 状态 + member_settle（返工 review→running 保留）；audit 层产物可含独立行 `needHuman: true` → merged 须带 `human:<裁决人>:<时间>:<结论>` 证据（缺则 GATE_NEEDHUMAN_PENDING） |
| dp4 验收判定（gap-list 对账） | Complete Gate（audit 验收完成才 complete） |

## 五、职责分工要点

- **Manager**：第一对接点；收发消息（mailbox）、读状态（batch_status/gate_status）、空闲发现（只读 member_status 查询）；**建议派发经 mailbox_send；member_status 写按 Leader 裁决执行**；DAG 全员只读、指派写权归 Leader；
- **Leader**：人工粗拆（决策包 + 模块清单），不充当 worker；
- **Coordinator**：细拆（API 粒度）+ 代码摸底（codebase-survey.md）；
- **Designer**：四件套（执行层全部规范，模板见 references/templates/）；
- **Doc-Manager**：复盘产物落盘 + 记忆沉淀（dsh-mneme 优先，Mnemopi 降级）。
