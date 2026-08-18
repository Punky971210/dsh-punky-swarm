# 蟛蜞三层模式：层间门禁设计（Tier3 验证版）
> 更新（2026-08-20）：tier3 副本已退役删除，能力已回填 dsh-punky-swarm；包名由 dsh-punky 改为 dsh-punky-swarm。

> 2026-08-19 · 状态：**设计已归档 v1（评审完成）** · 载体：dsh-punky-tier3 副本 · 下一步：MVP 启动
> 前置：归档见 docs/design-2026-08-19-community-borrowing-gate-hardening.md（§5 三层 DAG 强化草案）；本设计将其落到**层间门禁**的引擎语义。

---

## 一、问题定义（来自实跑观察）

| # | 问题 | 现状根因 | 后果 |
|---|---|---|---|
| G1 | **执行前不消费任务层产物**：派一个子代理下去，直接把规范定完了，不经过任务层 | wave_plan 的 task.cmd 自由度高，引擎不校验执行前置产物 | 无 spec/design/task 定义即开工，规范随 worker 随手定，质量不可控、口径漂移 |
| G2 | **执行完没有验收动作**：执行完成后直接收尾，无审计层验收 | 批次 complete 只要求全 merged；settle 不校验验收证据 | 无 gap-list 对账 / 无 Supervisor 验收 / 无归档，门禁形同虚设 |

> 目标：这两个 gap 是三层图与门禁之间要解决的核心——**门禁不是装饰，是把"必须经过任务层 / 必须经过验收"变成引擎强制语义**。

## 二、设计目标与原则

1. **层间门禁由引擎强制**：不靠 Leader 自觉（persona/手册只作解释，引擎作拦截）。
2. **产物契约显式声明**：每个 lane 声明 consume / produce，门禁校验即契约校验。
3. **保持固定语义**：wavePlan 建批时确定并持久化，门禁规则随批次落盘，绝不中途重算。
4. **保持 P2 显式人审**：验收动作是"证据齐备才放行"，不引入自动评审链。
5. **简单任务旁路不变**：任务分级（简单→单 Agent 直做）不进入三层门禁。

## 三、批次三层模型与产物契约

### 3.1 三层 lane 定义

| 层 | lane 角色 | 必须消费（consume） | 必须产出（produce） |
|---|---|---|---|
| **plan 层** 🎯 | 拆解/设计/排期（Coordinator/Designer） | 需求输入（用户/任务书，可选声明） | spec.md、design.md、task-tree.json（产物契约） |
| **exec 层** ⚡ | 编码/测试（Coder/Tester） | **plan 层产物**（spec.md / task-tree.json 至少其一，按任务声明） | 代码产物（outputs，可选声明）+ review 提交 |
| **audit 层** 🛡️ | 验收/对账/归档（Reviewer/Supervisor） | exec 层产物（产出物 + 测试结果） | review.md、gap-list.json、验收报告 |

### 3.2 产物目录

```
<root>/sessions/<sessionId>/artifacts/<batchId>/
  plan/   spec.md, design.md, task-tree.json      # plan 层 lane 写入
  exec/   <lane>/...                               # exec 层 lane 产出（代码/测试报告）
  audit/  review.md, gap-list.json                 # audit 层 lane 写入
```

产物路径支持相对（批次 artifacts 根）与绝对（工作区路径）两种声明。

### 3.3 运行时契约形态（字段 + 校验点，2026-08-19 补充：消除"抽象规范"歧义）

> 契约不是文档，是**批次 JSON 里的结构化字段 + batch-store 里的校验函数**。当前 wave_plan 的任务只有自由文本 cmd（引擎无法校验）；Tier3 为每个任务增加 3 个机器可读字段，引擎在固定状态迁移点硬校验。

**任务定义（schema v2 示例）**：

```json
{ "id": "p1-plan",  "layer": "plan",  "produce": ["plan/spec.md", "plan/task-tree.json"], "cmd": "产出 spec.md + task-tree.json 到 artifacts/<batchId>/plan/" },
{ "id": "e1-code",  "layer": "exec",  "consume": ["plan/spec.md", "plan/task-tree.json"], "outputs": ["exec/e1/src/main.py"], "cmd": "按 plan/spec.md 实现 main.py" },
{ "id": "a1-audit", "layer": "audit", "consume": ["plan/spec.md", "exec/e1/src/main.py"], "produce": ["audit/review.md", "audit/gap-list.json"], "cmd": "对照 spec 审查，产出 review.md + gap-list.json" }
```

- `consume`：派发（member_status running）前必须存在的文件，相对批次产物根 `artifacts/<batchId>/`；
- `produce` / `outputs`：结算（member_settle merged）前必须落盘的文件；
- 字段随批次 JSON 持久化（buildWavePlan 写入），运行中不变。

**四个引擎硬校验点**：

| 校验点 | 工具调用 | 引擎动作 | 失败返回 |
|---|---|---|---|
| Entry Gate | member_status(lane,'running') | stat consume 全部存在且非空，缺失拒迁移 | GATE_ENTRY_MISSING: [缺失清单] |
| Exit·产物 | member_settle(lane,'merged')（exec） | stat outputs 存在 | GATE_EXIT_MISSING_OUTPUT |
| Exit·验收 | member_settle(lane,'merged')（audit） | stat produce（review.md/gap-list.json）存在 | GATE_EXIT_MISSING_EVIDENCE |
| 批次完成 | batch_phase('complete') | exec 全 settle 且 audit 已 merged 且证据落盘，否则拒绝 | GATE_EXIT_PENDING_AUDIT |

> 校验点详述见 §四（Entry Gate）与 §五（Exit Gate）。

**建批静态校验**（wave_plan 调用时）：exec.consume 必须能在 plan.produce 中找到（或显式外部路径）；"有 exec 必有 audit"；字段类型合法——不满足建批即失败。

**实现位置**：wave-plan.js（字段解析+静态校验）+ batch-store.js setMember/batchPhase 内 checkGate()（纯文件 stat，可单测）。

**L0 产物结构校验（checkPlanContract）**：plan lane merged 前置——spec.md 必填章节（含 `## 验收标准`、`## 约束`）+ task-tree.json JSON schema + exec.outputs 与 task-tree output_path 引用一致性（§12.2 #4/#5 处置的引擎化）。

**Leader 完整操作序列**：wave_plan 建批 → p1-plan running/merged（produce 落盘校验）→ e1-code running（consume 校验；未先做 plan 则被拒）→ e1-code merged（outputs 校验）→ a1-audit running/merged（produce 校验）→ batch_phase complete（验收齐备）。

**单测用例**：拒派（consume 缺）/ 拒 settle（produce 缺）/ 拒 complete（audit 未完成）/ 建批拒（跨层引用无效）/ 正常三层闭环。

**与"直接 subagent"问题的分工**：本门禁约束**批次内** lane 顺序；"不建批次直接 subagent"由 §十 委派形态判定（A/B/C + assign_check）约束——两个机制分层，分别处理。

## 四、执行前门禁（Entry Gate）——解决 G1

**规则**：exec lane 派发（member_status → running）前，引擎校验该 lane 声明的 `consume` 产物**全部存在且非空**；缺失 → **拒绝派发**，返回缺失清单。

| 项 | 语义 |
|---|---|
| 触发点 | `member_status(batchId, lane, 'running')` 执行时 |
| 校验源 | lane.consume（wave_plan 建批时持久化） |
| 通过条件 | consume 全部产物存在（stat + 非 0 字节） |
| 失败行为 | 拒绝迁移，返回 `GATE_ENTRY_MISSING: [spec.md]`；Leader 需先派 plan 层补产物 |
| 旁路 | 层 = plan 或 consume 为空（任务本身无前置）→ 不校验（显式豁免，默认从严） |

**对 G1 的机制保障**：worker 派下去时，spec/design/task 定义必然已落盘——"顺手定规范"不再可能（未定规范 = 派发被拒）。

## 五、执行后门禁（Exit Gate / 验收）——解决 G2

### 5.1 exec lane 收口

`member_settle(batchId, lane, 'merged')` 时：
- 若 lane 声明 `outputs`：校验产物存在（防止空转交付）——缺失拒绝 merged；
- 强制要求该 lane 先经过 `review` 状态（状态机已含，由 Leader 提交）→ merged 由 Leader 按评审结论裁决；audit 层独立验收见 5.2（时间序在 exec 收口之后，不做 exec merged 的前置校验）。

### 5.2 验收动作强制

| 规则 | 语义 |
|---|---|
| exec 全 settled（merged/failed/skipped）后，**引擎放行 audit 层派发许可**（不再由 Leader 拍脑袋决定要不要验收；派发动作仍由 Leader 显式执行） | 批次运行到 exec 收口 = 验收必须发生 |
| audit lane 的 `produce`（review.md / gap-list.json）落盘前，该 lane 不可 settle merged | 验收证据缺失 = 验收未完成 |
| **批次 complete 前置**：audit 层全部 settled 且无 failed/conflict；存在未验收的 exec lane → `batch_phase complete` 拒绝（`GATE_EXIT_PENDING_AUDIT`） | "执行完没有验收"被引擎拦截 |

### 5.3 与既有语义的衔接

- 全额通过自动放行：改为"exec 全 merged + audit 全 merged（含 gap-list 对账）→ 自动可 complete"；
- failed/skipped lane：审计层需对失败 lane 出具处置记录（produce 中 `audit/summary.json` 记录失败处置）后才可 complete——失败也必须有验收闭环。

## 六、与现有机制的兼容

| 机制 | 关系 |
|---|---|
| wavePlan 固定语义 | 三层建模在 **buildWavePlan 时确定**（tasks 增加 layer/consume/produce/outputs 字段），持久化后不变 |
| 状态机（pending→running→review→merged…） | 不变；门禁是**迁移前置校验**（setMember/settle 加 gate），不是新状态 |
| mailbox / lane 锁 | 不变；门禁只读产物目录与批次状态 |
| 事件链 | 新增门禁事件：`gate.entry.missing` / `gate.exit.pending_audit` / `gate.passed`（只存元数据） |
| 恢复语义 | 重启后 in-flight → idle；门禁产物仍在磁盘，重派时继续校验（幂等） |
| 简单任务降级 | 不建批次 → 不进门禁；三层只约束批次内 lane |

## 七、引擎变更点（dsh-punky-tier3）

| 文件 | 变更 |
|---|---|
| wave-plan.js | `buildWavePlan` 接受 layer/consume/produce/outputs；validateWavePlan 校验字段类型与**跨层引用合法性**（exec 的 consume 必须能在 plan 层 produce 中找到或显式外部路径） |
| batch-store.js | setMember/settle 增加 gate 校验函数（entry/exit）；plan merged 前置 L0 checkPlanContract（§3.3）；complete 前置 audit 检查；新事件类型 |
| tools.js | wave_plan 参数扩展；member_status/settle 失败返回门禁原因；新增 `gate_status` 只读工具（查某 lane 缺什么） |
| schema | batch schema v2（加 layers/contracts 字段，向后兼容读取 v1） |
| client.js | 工作台 lane 卡显示门禁状态（缺产物/待验收徽标）——二期 |

## 八、实施路线

| 阶段 | 内容 | 验证 |
|---|---|---|
| MVP | entry gate（consume 校验）+ exit gate（produce/audit 校验 + complete 前置）+ 事件 + 测试 | 单测：拒派/拒 settle/拒 complete 三场景 + 正常闭环 |
| M1 | gate_status 只读工具 + 工作台门禁徽标 | 实跑一个三层批次 |
| M2 | 恢复语义 + 失败 lane 处置记录 | 重启注入测试 |

## 九、风险与边界（运行期风险；设计盲点清单见 §12.2）

1. **误拒风险**：产物路径声明错误 → 派发被拒。缓解：gate_status 明示缺失项；产物路径支持通配（`plan/*.md`）。
2. **audit 层缺人**：批次需要 audit lane 才有验收。缓解：wave_plan 建批时校验"有 exec 必有 audit"（跨层完整性校验，纳入 §7 validateWavePlan）；audit failed 的处置见 §12.2 #1。
3. **适配范围收窄**（既定接受）：三层模式只服务"可声明产物契约"的任务；通用任务走简单降级或 generic 批模板（后续可选）。
4. **不引入自动评审**：验收仍由 audit lane 的 Reviewer/Supervisor 执行（P2 显式），引擎只保证"验收必须发生且证据落盘"。

## 十、委派形态判定（旁路规则，2026-08-19 实跑反馈补充）

> G1 的实跑形态不止"批次内不消费任务层产物"，更常见的是：**Leader 不建批次、直接 subagent 委派**——完全绕过流水线。简单任务可接受，但习惯性绕过使模式退化为"无治理的委派习惯"。本设计补充**何时允许直派、何时必须走流水线**的显式判定。

### 10.1 三种委派形态

| 形态 | 行为 | 治理 | 适用 |
|---|---|---|---|
| **A 直做** | Leader 自己完成（不派） | 零治理 | 规则 0 简单任务（单步/低风险/单角色） |
| **B 轻量委派** | subagent 直派（不建批次） | 无批次、建议留痕 | **全部满足**：单任务、无并行/依赖、无多角色、无门禁、单次交付 |
| **C 流水线** | wave_plan 建批次 | 全治理（三层 / generic 单层） | 命中任一强制条件 |

### 10.2 判定协议

**允许 B（全部满足）**：
1. 单任务，无并行、无依赖（无需 DAG）；
2. 单角色可完成（无需 review/tester/audit 角色分离）；
3. 无门禁/审计需求（不需要人审、gap-list、验收）；
4. 单次交付，无需跨轮治理与恢复。

**必须 C（任一命中）**：
1. 需并行或任务间依赖（DAG 结构）；
2. 需多角色协作（编码+测试+审查分离）；
3. 需门禁/审计（人审、验收、可审计/可恢复要求）；
4. 任务产出需要事后追踪与复盘。

### 10.3 机制化（防"习惯性绕过"）

1. **判定显式化**：persona 与 jiufeng-team 增加委派判定表（A/B/C 条件），Leader 每次委派前先判定；
2. **判定工具**（Tier3 MVP 含）：`assign_check` 只读工具——输入任务特征（并行?/多角色?/门禁?/产物?）→ 输出"允许 B / 必须 C（原因）"；C 类任务输出后仍直派 = 违反模式（记录事件 `assign.violation`）；
3. **低成本合规**：单任务需 C 时提供 **generic 单 lane 批模板**（建批→派发→结算，无三层开销）——让"走流水线"对单任务不昂贵，降低绕过动机；
4. **全强制边界**：平台级 subagent 拦截 hook（approval 链模式）需 dsh 平台支持，列为长期项；Tier3 以"判定工具 + 事件留痕 + 规则"实现半强制。

### 10.4 与门禁关系

- A 形态 = 规则 0（Leader 直接完成），零治理，不进任何门禁；
- B 形态无批次 → 不进门禁（判定通过才允许）；
- C 形态进门禁：三层批模板（plan/exec/audit 全门禁）或 generic 单层（**仅 settle 校验**，无 consume/audit 门禁；layer 默认 generic，见 §14.1 兼容性）。

## 十一、评审点（2026-08-19 已全部确认）

五项评审点（Entry Gate / Exit Gate / 有 exec 必有 audit / 产物契约字段 / 委派形态判定）均已认可，逐项决策见 §十三 决策记录；本节保留为评审历史。


## 十二、盲点与风险（2026-08-19 评审补充）

### 12.1 概念澄清（评审更正）：Role 与 Skill 的分层

- **Role = 身份契约**：jiufeng-team 角色定义（层级/职责/边界/Success Criteria/输出 schema），**不承载操作流程**；
- **Skill = 能力工具**：能力层技能（dev-coder / dev-tester / code-review-guideline 等），是角色在 role 基础上**聚焦开发任务的能力提升工具，不是"角色操作手册"**；
- **装配 = 角色 → 技能 映射**（jiufeng-team 装配表）：如 Coder → dev-coder + efficient-edit + codebase-design；
- 引擎注入 cmd 前缀的语义（装配注入见 §14.2；本概念为 2026-08-19 评审更正）：**按该 lane 的 role 契约 + 装配的 skill 能力**拉起成员——Leader 只写任务内容，引擎注入"加载 <skill> 能力工具"前缀；**不是**"cmd 必须引用 dev-coder"式字符串校验。

### 12.2 盲点清单与处置

| # | 盲点 | 风险 | 处置 |
|---|---|---|---|
| 1 | 门禁死锁路径未定义（plan/audit failed → 批次永久卡死） | 高 | **已定：重开**（§15.2）——failed 为终态，批次带失败收尾（audit/summary.json），重做 = Leader 重开新批次；不提供批次内 lane 重试 |
| 2 | assign_check 自评可绕过（输入为 Leader 自述特征） | 高 | 结构化表单强制逐项回答；定位**半强制**：assign.violation 留痕 + 工作台曝光为威慑 |
| 3 | cmd 装配校验脆弱 + 装配双份漂移 | 高 | **引擎注入前缀取代字符串校验**；装配单一来源（assembly.json 由装配表生成/校验） |
| 4 | 门禁承诺边界未划清（文件存在≠内容合格；note≠真实审计） | 高 | 分层承诺：**门禁=流程保证，audit=质量保证**；L0 校验内容（章节/JSON schema）而非仅存在性；note 只作留痕 |
| 5 | 恢复与半成品产物（重启后残缺文件通过 stat） | 中 | L0 内容校验（非空+结构）+ 恢复幂等测试 |
| 6 | 产物路径逃逸（绝对路径指向无关文件骗过门禁） | 中 | **已定：契约一致性校验**（§15.3 N2 影响）——产物路径限定批次产物根或显式声明路径内（建批校验），防门禁被无关文件骗过 |
| 7 | 跨批次产物复用（一个 spec 供多 exec 批次） | 中 | schema 预留跨批次引用（artifacts/<otherBatch>/...）或先禁后补 |
| 8 | 审计独立性（Leader 自产自审 spec） | — | **不纳入本次设计**（2026-08-19 评审决策） |
| 9 | tier3 与 dsh-punky 合并策略（回填/并存/取代；schema v1→v2 存量迁移） | 演进 | **已定：回填**（§14.1） |
| 10 | role 绑定收窄非 jiufeng 团队兼容性 | 演进 | **已定：可插拔**（§14.2） |
| 11 | LLM 行为无法单测（引擎前缀/assign_check 是否被遵循） | 演进 | **已定：实测**（§14.3） |
| 12 | 工具名冲突（同 profile 不能并存 dsh-punky 与 tier3） | 演进 | **已定：独立验证环境**（§14.4），回填后消失 |

### 12.3 采纳情况

- **采纳**：盲点 1-7 处置、role/skill 概念澄清（§12.1）、引擎注入前缀（#3）、分层承诺（#4）、结构化表单（#2）、路径白名单（#6）、跨批次引用预留（#7）；
- **不采纳**：盲点 8（审计独立性暂不考虑）；
- **已定**：9-12 演进处置（见 §14：合并=回填、装配=可插拔、LLM=实测、工具冲突=独立验证环境）。

## 十三、决策记录（2026-08-19）

| 项 | 决策 |
|---|---|
| 门禁核心（Entry/Exit/complete 前置） | 认可（§四/§五/§3.3） |
| 产物契约字段与目录（layer/consume/produce/outputs） | 认可（§3.3） |
| "有 exec 必有 audit"建批即拒 | 认可 |
| 委派形态判定（A/B/C + assign_check + generic 单 lane + 违规留痕） | 认可（§十） |
| Role vs Skill 概念 | **更正**：role=身份契约，skill=能力工具；装配=角色→技能；引擎注入 skill 前缀 |
| 审计独立性（L2 独立评审） | **不纳入** |
| 设计状态 | 已归档 v1；MVP 待启动（dsh-punky-tier3） |
| 演进：合并策略 | **回填**（tier3 验证后回填 dsh-punky，副本退役） |
| 演进：装配绑定 | **可插拔**（assembly.json 通用化，不绑定 jiufeng） |
| 演进：LLM 行为验证 | **实测**（端到端演练批次 + 事件链审计，不阻塞 MVP） |
| 再评估：安全模型（N2） | **不设沙箱**：Agent 自由开放，人工控制外部风险；#6 白名单改为契约一致性校验 |
| 再评估：失败处理（N1） | **重开**：failed=终态，批次带失败收尾，重做=重开新批次 |
| 再评估：N3-N8 | 按建议处置（§15.3）：A/B 边界补判据 / skill 存在性校验 / L0 范围声明 / 跨批次先禁后补 / role 来源可插拔 / generic 定义简化 |

## 十四、演进路线（2026-08-19 决策）

> 演进盲点 #9-12 处置更新：合并策略 = **回填**；装配 = **可插拔（不绑定 jiufeng）**；LLM 行为验证 = **实测**。

### 14.1 合并策略：tier3 验证后回填 dsh-punky

| 项 | 内容 |
|---|---|
| 方向 | tier3 验证通过后，将核心能力**回填 dsh-punky 主线**，tier3 副本退役（或作为发布分支留存） |
| 回填分层 | ① 引擎：wave-plan schema v2 + batch-store gates + checkPlanContract → ② 工具：wave_plan 扩展 / assign_check / gate_status → ③ 客户端：工作台门禁徽标 → ④ 预设：蟛蜞三层模式 preset |
| 兼容性 | schema v1 存量批次**向后兼容**（读 v1 按"无门禁"处理，不迁移不损坏）；wave_plan 参数不加必填新字段（layer 默认 generic） |
| 回填时机 | tier3 单测全绿 + 端到端演练批次通过 + 工作台展示确认后 |
| 回填后形态 | 蟛蜞模式 = 三层 + generic 双批模板 + 简单任务降级（A 形态），适配范围收窄为既定接受 |

### 14.2 装配可插拔：不绑定 jiufeng

- **assembly.json 通用化**：不再是 jiufeng 专用清单，而是通用装配数据（team → layer → role → skills），引擎只认"role 契约 + skill 前缀"通用格式，**不感知 team 是谁**：

```json
{
  "team": "jiufeng",
  "layers": {
    "plan":  { "roles": ["coordinator","designer"],
               "skills": { "coordinator": ["dev-planner"],
                           "designer": ["dev-designer","spec-writing","design-an-interface"] } },
    "exec":  { "roles": ["coder","tester"],
               "skills": { "coder": ["dev-coder","efficient-edit","codebase-design"],
                           "tester": ["dev-tester"] } },
    "audit": { "roles": ["reviewer","supervisor","doc-manager"],
               "skills": { "reviewer": ["code-review-guideline","report-blind-audit"],
                           "supervisor": ["report-blind-audit","archive"] } }
  }
}
```

- 可插拔点：wave_plan 建批时 `team` 参数（默认 jiufeng）→ 引擎读对应装配 → 注入 cmd 前缀 `[role=xxx][skills=a,b,c]`；非 jiufeng 团队 = 换一个 assembly.json（内置 default + 外部装配路径 `config.assemblyDirs` 或批次级 assembly 参数）；
- 意义：恢复"非 jiufeng 集群可复用引擎"的兼容性（盲点 #10 解除），引擎与团队解耦。

### 14.3 LLM 行为验证：实测（不可单测部分）

- **不可单测**：Leader 是否先做委派判定（A/B/C）、worker 是否遵循注入的 role/skill 前缀、note/审计是否真实——这些只能真实会话观察；
- **实测方法**：MVP 后安排端到端演练批次（三层 + generic + B 形态各一），用事件链审计（assign.violation / plan.audited / gate.* / 产物齐备率 / 违规事件数）度量合规；
- **时机**：不阻塞 MVP 实现，作为验证阶段活动。

### 14.4 工具名冲突与验证环境

- dsh-punky 与 tier3 工具名相同（wave_plan 等），**同 profile 不能并存**；
- 验证期：独立 profile（如 `dsh-tier3`）或 headless 实例挂载 tier3；回填后不存在并存问题（tier3 退役）。

## 十五、再评估决策（N1-N8，2026-08-19）

### 15.1 安全模型声明（N2）

- **当前不设沙箱**：Agent 默认自由开放，外部风险由人工控制（权限预设 + 人审门禁）；产物目录（~/.dsh/jiufeng/...）与工作区外写入均可。
- **影响**：#6 白名单从"安全机制"改为"**契约一致性校验**"（防产物路径指向无关文件骗过门禁），非安全防护。

### 15.2 失败处理：重开（N1，用户倾向确认）

- **failed = 终态**（settled）；批次可带失败收尾（audit/summary.json 记录失败处置）后 complete/aborted；
- **重做 = Leader 重开新批次**（新 batchId，基于失败分析重新 wave_plan）；
- **不提供批次内 lane 重试**；返工（review→running 非终态）仍保留——MVP 避免复杂重试语义。

### 15.3 N3-N8 处置（按建议定稿）

| # | 项 | 决策 |
|---|---|---|
| N3 | A/B 形态边界 | **A = Leader 有把握直接完成**（当前会话单 Agent 可完成）；**B = 需独立上下文/工具面差异**（查代码、跑测试等需独立工作区）才派 subagent——补入 §十 判定协议 |
| N4 | skill 存在性 | 建批时校验装配引用的 skill 在技能库可解析（wave-plan 静态校验） |
| N5 | L0 范围声明 | **L0 仅校验 plan 产物结构**（spec 必填章节 + task-tree JSON schema）；exec/audit 只做存在性（代码无法 schema 校验，避免承诺误读） |
| N6 | 跨批次引用 | **MVP 先禁后补**：consume 仅限本批次产物根；跨批次引用（artifacts/<otherBatch>/...）列为二期 |
| N7 | 可插拔 role 来源 | assembly.json 按 team 引用 **role 定义文件路径**（roles/ 目录按团队组织），引擎读 role 契约 + skills |
| N8 | generic 单 lane | generic 任务定义 = **cmd（必填）+ outputs（可选）**，无 consume/layer 门禁，仅 settle 校验 |

### 15.4 决策影响

- 门禁核心（§3.3/§四/§五）不变；
- §12.2 #1/#6 处置已同步更新；
- MVP 实现清单追加：wave-plan（skill 存在性校验 + N6 先禁跨批次）+ 失败收尾（audit/summary.json）+ generic 定义简化。


