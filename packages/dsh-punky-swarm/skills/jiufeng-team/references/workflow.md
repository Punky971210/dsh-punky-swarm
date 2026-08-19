# jiufeng 工作流蓝图（蟛蜞模式适配版）

> 2026-08-19 · 源自 jiufeng-expandable-team workflow.md（v1.3.0），适配蟛蜞模式三层门禁。
> 三处调整：① Manager 提前为任务第一对接点（原版仅调度）；② 粗拆上移 Leader 人工对接（原版 Coordinator 粗拆）；③ Coordinator 新增代码摸底（原版无，仅 Supervisor 验收时 CBM 摸底）。

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
        MA -->|lane 任务| CR[coder池]
        MA -->|测试任务| TE[tester池]
        CR -->|代码| RV[reviewer]
        TE -->|测试报告| RV
        RV -->|PASS/REWORK + gap-list.json| SV[supervisor]
    end
    subgraph 审计层🛡️
        SV -->|acceptance-report + CBM 对账| DM[doc-manager]
        DM -->|retrospective-report → 记忆沉淀| CO
    end
```

## 二、核心流转（11 步）

| 步骤 | 动作 | 角色 | 产出物（产物类型） |
|:----|------|------|------|
| ① | 开启任务 + 人工粗拆 | Leader | leader-decision-pack.md + 模块清单（plan/） |
| ② | 细拆 + 代码摸底 | Coordinator | task-tree.json + codebase-survey.md（plan/） |
| ③ | 任务规范设计（四件套） | Designer | plan.md + spec.md + coder-tasks.md + tester-tasks.md（plan/） |
| ④ | 调度分发 | Manager | lane 任务/测试任务（mailbox inbox） |
| ⑤ | 编码实现 | Coder 池 | 代码（exec/） |
| ⑥ | 测试验证 | Tester 池 | 测试报告（exec/） |
| ⑦ | 对抗审查 + gap-list 对账 | Reviewer | review.md + gap-list.json（audit/） |
| ⑧ | 验收审计 | Supervisor | acceptance-report.md（audit/） |
| ⑨ | 复盘沉淀 | Doc-Manager | retrospective-report.md（audit/）→ 记忆库 |
| ⑩ | 回馈循环 | Doc-Manager → Coordinator | 复盘知识 → 下一子模块 |

## 三、产物契约表（对应 wave_plan 的 layer/consume/produce）

| 层 | 产物（相对批次产物根） | 消费方 |
|---|---|---|
| plan 🎯 | leader-decision-pack.md、task-tree.json、codebase-survey.md、plan.md、spec.md、coder-tasks.md、tester-tasks.md | exec（consume spec/task-tree） |
| exec ⚡ | 代码（exec/<lane>/...）、测试报告 | audit（consume 产物） |
| audit 🛡️ | review.md、gap-list.json、acceptance-report.md、retrospective-report.md | 记忆沉淀（dsh-mneme） |

> 引擎只校验存在性 + L0 结构底线（spec 必含 \`## 验收标准\`/\`## 约束\`、task-tree.json 合法）；四件套内部结构见 references/templates/。

## 四、硬化判定点 ↔ 三层门禁

| 原版硬化点 | 蟛蜞模式等价（引擎强制） |
|---|---|
| dp1 分配判定（ready→空闲实例） | Entry Gate（consume 齐备才派发）+ assign_check（A/B/C） |
| dp2 完成确认（产出完整性） | Exit Gate（outputs/produce 落盘才 merged） |
| dp3 审查路由（REWORK/PASS） | review 状态 + member_settle（返工 review→running 保留） |
| dp4 验收判定（gap-list 对账） | Complete Gate（audit 验收完成才 complete） |

## 五、职责分工要点（2026-08-19 确认）

- **Manager**：第一对接点；收发消息（mailbox）、读状态（batch_status/gate_status）、空闲发现与指派（member_status）；DAG 全员只读、指派写权归 Manager/Leader；
- **Leader**：人工粗拆（决策包 + 模块清单），不充当 worker；
- **Coordinator**：细拆（API 粒度）+ 代码摸底（codebase-survey.md）；
- **Designer**：四件套（执行层全部规范，模板见 references/templates/）；
- **Doc-Manager**：复盘产物落盘 + 记忆沉淀（dsh-mneme 优先，Mnemopi 降级）。
