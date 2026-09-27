# software-team 工作流蓝图（蟛蜞模式）

> 说明：**Manager 为引擎层角色（Leader 直属、团队无关，定义见 `presets/punky-preset/references/manager.md`），不属本团队角色集**；其为任务第一对接点——**exec 层 lane 数≥3 的三层批**（建批须传 `assembly`）running 后、**首个 exec lane 派发前**强制拉起并 `batch_phase` **登记**（未登记即拒派 `GATE_MANAGER_NOT_RAISED`）；`managerPlan` **缺省 `raise`**，**需 Leader 直驱时必须在建批 `assembly` 显式声明 `managerPlan:'leader-direct'`**（显式出口，缺省不是直驱；`leader-direct` 批回执走单通道 `report → Leader`、不写 `outbox`，Leader 代行 watch），普通 C 批 Leader 可代行（留痕「本批由 Leader 直驱」）；粗拆由 Leader 人工对接；Coordinator 按触发装配——exec 层 lane 数≥3 或需细拆产物时 plan 层建 role=coordinator lane；**`task-tree.json` 按需声明**（需要任务树的批次由**建批 `tasks` 面**声明，未声明即不产出，不得默认代产）；audit 承接 supervisor+reviewer 审核职能为默认语义，双角色为显式选项。

## 一、角色 DAG（谁产出 → 谁消费 → 谁验证）

```mermaid
graph TD
    L[Leader 组织层]
    MA[Manager 引擎层角色 · 团队无关]
    subgraph 任务层🎯（本团队 2 角色）
        CO[coordinator]
        DE[designer]
    end
    subgraph 执行层⚡（本团队 3 角色）
        CR[coder池]
        TE[tester池]
        RV[reviewer]
    end
    subgraph 审计层🛡️（本团队 2 角色）
        SV[supervisor]
        DM[doc-manager]
    end
    L -->|人工对接+粗拆决策包| MA
    L -->|模块清单| CO
    CO -->|task-tree.json（需要任务树的批次按需声明）+ codebase-survey.md| DE
    DE -->|四件套: plan/spec/coder-tasks/tester-tasks| MA
    MA -.->|建议派发| L
    L -->|lane 任务| CR
    L -->|测试任务| TE
    CR -->|代码| RV
    TE -->|测试报告| RV
    RV -->|PASS/REWORK（review.md）| SV
    SV -->|acceptance-report + gap-list.json + 图谱对账| DM
    DM -->|retrospective-report → 记忆沉淀| CO
```

> **节点归属（D-1 口径）**：DAG 中 `L`（Leader）与 `MA`（Manager）为**引擎/组织层节点**，不属本团队角色集——`MA` 由引擎包 `presets/punky-preset/references/manager.md` 定义（Leader 直属、团队无关、由 Leader 以 continuable subagent 拉起）；任务层/执行层/审计层三个 subgraph 内的 7 个节点才是本团队角色（2 + 3 + 2 = 7）。

> 「池」（Coder 池 / Tester 池）：**仅 Agent-team 方案使用；subagent 方案不用**——「池」是声明面（可多实例并行），引擎无校验，不承载分配语义。

## 二、核心流转（11 步）

| 步骤 | 动作 | 角色 | 产出物（产物类型） |
|:----|------|------|------|
| ① | 开启任务 + 人工粗拆 | Leader | leader-decision-pack.md + 模块清单（plan/） |
| ② | 细拆 + 代码摸底（按触发装配：仅 **exec 层 lane 数≥3 的三层批**或需细拆产物批建 coordinator lane；`task-tree.json` **按需声明**——需要任务树的批次由**建批 `tasks` 面**声明，未声明即不产出） | Coordinator / Designer | codebase-survey.md（+ 按需声明的 task-tree.json）（plan/） |
| ③ | 任务规范设计（四件套） | Designer | plan.md + spec.md + coder-tasks.md + tester-tasks.md（plan/） |
| ④ | 建议派发 | Manager（**引擎层角色**，Leader 直属，非本团队角色集成员） | 派发建议（mailbox inbox/broadcast）→ Leader 按建议 subagent 派发 worker（depth-1） |
| ⑤ | 编码实现（**`exec-work` 步**） | Coder 池 | 代码（exec/） |
| ⑥a | 测试套件编写（**`exec-work` 步 · 与 ⑤ 同 wave 并行、deps 为空 ⇒ 互不依赖**） | Tester 池 | 可执行测试套件（exec/）——consume 指向 **plan 产物**，不待 code 完成 |
| ⑥b | 运行测试套件出测试报告（**`exec-work` 步 · 与 ⑤/⑥a 并行，不设 code 前置依赖**） | Tester 池 | 测试报告（exec/）；gap-list 对账归 Supervisor（audit 段） |
| ⑦ | 独立跑测试 + 对抗审查 + 向下游汇总（**`exec-review` 步**） | Reviewer | review.md + 独立测试记录（exec/）——reviewer **独立复跑测试**（不依赖 tester 的测试结论），产物交下游 **audit lane** consume |
| ⑧ | 验收审计 + gap-list 对账 | Supervisor | acceptance-report.md + gap-list.json（audit/） |
| ⑨ | 复盘沉淀 | Doc-Manager | retrospective-report.md（audit/）→ 记忆库 |
| ⑩ | 回馈循环 | Doc-Manager → Coordinator | 复盘知识 → 下一子模块 |

> 注（**exec 形态，D-1**）：⑤ 编码、⑥a 套件编写、⑥b 执行**同属 `exec-work` 步且同 wave 并行**——该步内 coder 与 tester 两条 lane 的 **deps 均为空 ⇒ 互不依赖**，tester 的 consume 指向 **plan 产物**；⑦ 落在**独立 `exec-review` 步**：reviewer **独立跑测试**（自带复跑，不依赖 tester 的测试结论）+ 对抗审查，产物向下游 **audit lane** 汇总。
> **⑥d 派发套件（2026-09-16）**：C 档派发**唯一通道** = `lane_dispatch`（发一次性句柄 + 引擎自派 + **按次收窄成员工具面** + **唯一写路径**登记 `member.dispatch`）；把返回的 `firstLine` 写进子代理任务包首行。成员侧通信走 `swarm_report`（→Leader）/`swarm_cc`（→Manager），**不再散落用通用通信工具**。C 档裸派在 `config.dispatch.gate='enforce'` 时拒 `GATE_SUBAGENT_OUTSIDE_LANES`（缺省 `warn` 只留痕，防自锁）；**B 档单步子代理不受限**。
> **⑥c 审计时点（2026-09-15 用户裁决 · 完成即审）**：任一 exec lane `merged` 后**立即**为其开 audit lane（可多条并行），**不等**同批其他 lane 收口、也不等其他并行批结束。单 lane 审计（产出 `audit/<lane>-acceptance.md`）与跨 lane 聚合（`gap-list` 对账 + 全量回归 + 消重标冲突）**分属两层职责**——后者是 Leader 终门禁，不得成为前者延期的理由。已完结批的补审可另开审计批（用 plan + exec 占位产物满足 audit 契约）。

**装配裁剪（普通 C 批）**：上表为**全装配蓝图**，适用于 **exec 层 lane 数≥3 的三层批**（建批须传 `assembly`；`managerPlan` **缺省 `raise`**——须 Manager 的批在派发首个 exec lane 前拉起并 `batch_phase` 登记，未登记即拒派；**需 Leader 直驱时显式声明 `managerPlan:'leader-direct'`**）/ 复杂批（完整启用 ② Coordinator、④ Manager 指挥——Manager 为**引擎层角色**，非本团队角色集成员）。普通 C 批（批内 exec 层 lane 数<3）可裁剪为 plan（细拆分**按需声明**——由建批 `tasks` 面声明任务树，未声明即不产出）→ exec（`exec-work` 并行段 → `exec-review` 审查段）→ audit（audit 承接 supervisor+reviewer 审核职能为默认语义，双角色为显式选项），Manager 职责由 Leader 代行并留痕「本批由 Leader 直驱」。角色 DAG 图为全装配形态示意（引擎/组织层节点 L/MA 与团队 7 角色分层标注），普通 C 批按本注记执行。

### 两段式 wave 示例

```
wave1: [plan-四件套]
wave2: [exec-work：coder-A, coder-B, tester-套件+执行]   ← 同 wave 并行（tester ∥ coder，deps 均为空）
wave3: [exec-review：reviewer 独立跑测试 + 对抗审查]      ← 独立 exec 步，产物向下游 audit 汇总
wave4: [audit-pair / accept：验收 + 对账]
```

> 注记：test lane 的 consume 指向 **plan 产物**（spec/tester-tasks）而非 code 产物；`exec-work` 步内 coder 与 tester **互不依赖**（无串行直链），`exec-review` 是**独立 exec 步**（reviewer 不依赖 tester 的测试结论）。

## 三、产物契约表（对应 wave_plan 的 layer/consume/produce）

| 层 | 产物（相对批次产物根） | 消费方 |
|---|---|---|
| plan 🎯 | leader-decision-pack.md、codebase-survey.md、plan.md、spec.md、coder-tasks.md、tester-tasks.md、**按需声明**的 task-tree.json | exec（consume spec/**按需声明的 task-tree**） |
| exec ⚡ | 代码（exec/<lane>/...）、测试报告、可执行测试套件（推荐） | audit（consume 产物） |
| audit 🛡️ | review.md、gap-list.json、acceptance-checklist.md（验收检查清单，推荐）、acceptance-report.md、retrospective-report.md | 记忆沉淀（dsh-mneme） |

> 引擎只校验存在性 + Plan 契约结构底线（spec 必含 \`## 验收标准\`/\`## 约束\`；`task-tree.json` **声明了**则须合法 JSON——**按需声明**：需要任务树的批次由建批 `tasks` 面声明，未声明即不参与校验）；四件套内部结构见 references/templates/。

### 模板 ↔ 产物映射表（P2-17 收敛：6 模板（5 md + 1 json 数据模板）指名引用）

> references/templates/ 6 模板逐一映射：模板 → 产出物 → 产物类型（artifact_types 注册表）→ layer/目录 → 产出角色 → consume 归属。call-chain-matrix / endpoint-behavior 为 **spec.md 内部章节模板**（非独立产物），由 Designer 四件套组装时填充；gap-list.json 为 **audit 对账数据模板**（非独立文件产物），由 Supervisor 对账时按 schema 落盘。

| 模板（references/templates/） | 产出物 | 产物类型 | layer / 目录 | 产出角色 | consume 归属 |
|---|---|---|---|---|---|
| leader-decision-pack.md | leader-decision-pack.md（粗拆决策包） | plan（任务层产物） | plan/ | Leader（人工对接 + grill 后） | Coordinator（细拆输入） |
| plan-template.md | plan.md（四件套之一） | plan（排期） | plan/ | Designer（spec-writing） | Coder/Tester/Reviewer（spec 参照） |
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

- **Manager（引擎层角色，非本团队角色集）**：第一对接点；收发消息（mailbox）、读状态（batch_status/gate_status）、空闲发现（只读 member_status 查询）；**建议派发经 mailbox_send；member_status 写按 Leader 裁决执行**；DAG 全员只读、指派写权归 Leader；定义见引擎包 `presets/punky-preset/references/manager.md`；
- **Leader**：人工粗拆（决策包 + 模块清单），不充当 worker；
- **Coordinator**：细拆（API 粒度）+ 代码摸底（codebase-survey.md）；
- **Designer**：四件套（执行层全部规范，模板见 references/templates/）；
- **Doc-Manager**：复盘产物落盘 + 记忆沉淀（dsh-mneme 优先，Mnemopi 降级）。
