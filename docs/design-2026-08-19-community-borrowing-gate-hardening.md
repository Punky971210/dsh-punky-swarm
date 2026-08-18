# 社区对标借鉴点 × 门禁强化设计（归档）

> 2026-08-19 · 蟛蜞模式（dsh-punky）· 状态：**已归档，推进项待用户确认**
> 更新（2026-08-20）：三层门禁已按本设计 §5 实装（引擎级），并按当前代码重评社区对标——见 docs/evaluation-2026-08-20-community-counterpart-current.md
> 背景：对标 awesome-dsh-plugin 社区索引（987 行，Workflow & Automation + 全库扫描），识别 16 个多 Agent 编排同类插件（五派），提炼 3 个借鉴点并核实门禁差距。

---

## 一、社区对标盘点（2026-08-19）

| 派别 | 代表插件 | 定位 |
|---|---|---|
| DAG/waves 编排 | dsh-taskswarm（TaskPlane 移植）、deepseek-harness-orchestrate、dsh_workflow、dsh-captain | 依赖序分层并行执行 |
| 模型路由分工 | dsh-swarm-router、dsh-longtask-orchestrator、dsh-tier-router | 异构模型分工（成本/能力路由） |
| swarm/团队 | dsh-kimicode-swarm、agent_team_gui、dsh-expert-mode、dsh-agent-teams | 批量派发/持久 agent squad |
| 通信/任务总线 | dsh-task-relay、dsh-agent-relay、plugin-team-board | 跨会话任务队列/消息中继 |
| 监控/审查/调度 | dsh-task-dag、dsh-subagent-monitor、dsh-auto-review、dsh-proof、cron 类 | 可视化/第二模型评审/定时触发 |

**差异结论**：社区插件均为"编排工具"（覆盖 1-3 项能力）；蟛蜞模式是唯一完整治理闭环（固定语义 DAG + 文件状态机 + 锁/黑板 + 门禁 + 工作台 + 任务分级降级）。

---

## 二、借鉴点 1：git-worktree 并行 lane（dsh-taskswarm）

- **机制**：依赖序 waves × **git-worktree lane 隔离**——每个 lane 挂独立 worktree，冲突天然隔离；任务包 + 跨模型评审 + crash recovery。
- **借鉴价值**：真工作区隔离，比共用工作区抗冲突（当前 worker 共用工作区，lane 间写冲突依赖锁/纪律）。
- **落地思路**（候选）：wave_plan 任务增加可选 `worktree: true` 元数据 → 派发前按 lane 创建 git worktree → worker 在该 worktree 内工作 → settle 后合并回主工作树。
- **注意**：仅适用于 git 仓库任务；依赖 dsh bash 能力（当前 win32 受限），需评估。

## 三、借鉴点 2：声明式 DAG 入口校验（deepseek-harness-orchestrate）

- **机制**：声明式 task-DAG；建批前**校验依赖图合法性**（环/悬空引用/类型），拓扑分层并行，确定性失败传播。
- **冲突核实（2026-08-19，源码证据）**：**与池化不冲突**。蟛蜞模式已在 `lib/wave-plan.js` 内置等价且更强的校验：
  - `topoWaves`：task id 必填 / 重复 id 拒绝 / **未知 dep 拒绝** / **环检测**（Kahn + guard）；
  - `buildWavePlan`：**建批次入口即校验**（wave_plan 调用时），随后持久化——校验→固定→池化执行，顺序无冲突；
  - `validateWavePlan`：持久化后一致性校验（含环检测），**拒绝被篡改的 plan**（防中途重算）。
  - 测试覆盖 14 项（含 cycle / unknown dep / forged plan）。
- **可借鉴残差**：仅"声明式 DAG 文件"形态（DAG 存为可复用文件而非每次调用构造）与错误信息友好度——**非必要，优先级低**。

## 四、借鉴点 3：第二模型评审流（dsh-auto-review / dsh-proof）

### 4.1 社区机制

| 插件 | 机制 | 强制点 |
|---|---|---|
| dsh-auto-review | 第二模型只读评审子代理挂在**审批链**，结构化 allow/deny + 理由，**fail-closed** | 每个审批请求必经 |
| dsh-proof | 每个 top-level turn 关闭前派生只读验证器，未通过把差距导回 agent | 每轮强制，无法绕过 |

### 4.2 jiufeng Reviewer 现状与差距核实（2026-08-19）

- **契约层（完备，反超社区）**：`jiufeng-team/references/roles/reviewer.md`（216 行）——对抗式双线审查（返工/通过线）、MUST-FIX/SHOULD-FIX/FYI 三级、前端 EP-REVIEW + CHAIN-REVIEW、Converge gap-list、修复盯防清单、H 级 HITL 门禁。
- **机制层（缺口）**：
  - `member_settle` 状态机枚举 merged/failed/skipped/conflict，**纯迁移无前置条件**——Leader 可直接跳过评审 settle merged；
  - `batch-store.js` grep review/gap-list/evidence：**零校验**（hasEvidenceCheck: false）；
  - 全 merged → 自动放行 complete，评审质量依赖 Leader 自觉 + Reviewer 执行质量。
- **差距定性**：评审从"自觉派发"到"强制环节"之间**缺引擎证据门禁**。

### 4.3 门禁强化设计（候选方案，推荐 A）

| 方案 | 做法 | 成本 | 效果 | 结论 |
|---|---|---|---|---|
| **A（推荐）** | **引擎评审证据门禁**：member_settle merged 前校验该 lane 存在评审证据（mailbox 评审回执 / review.md / gap-list.json 落盘），缺失拒绝 settle；autoReleaseable 同条件 | 小（batch-store gate + 测试） | 评审不可跳过，仍由 Leader 显式派 reviewer（保持 P2 显式人审） | ✅ 主推 |
| B | wavePlan 拓扑强制：执行 lane 挂 reviewer 依赖边（评审产物作 deps） | 中（wave-plan 扩展） | 评审进 DAG 结构强制 | 二期候选 |
| C | 借鉴社区挂 hook（自动第二模型评审） | 大 + 改变门禁语义 | 自动评审链 | ❌ 与"P2 显式人审"设计边界冲突 |

---

## 五、待确认方向：三层 DAG 强化（用户提出，2026-08-19）

> 若确定做门禁强化，应把"不再靠 Leader 自觉"推广到**三层编排全部层级**，而非只补 review 证据门禁。

### 5.1 jiufeng 三层（角色 × 编排面）

| 层 | 角色 | 现编排形态 | DAG 强化方向 |
|---|---|---|---|
| 任务层 🎯 | Coordinator/Manager/Designer | 排期/拆解靠 Leader（自觉） | **规划 DAG**：需求→设计→task 树，入口校验（环/覆盖/规格完整性） |
| 执行层 ⚡ | Coder/Tester/Reviewer | wavePlan 执行 DAG（已有） | **执行 DAG 强化**：reviewer 依赖边强制（方案 B 并入）+ 评审证据门禁（方案 A） |
| 审计层 🛡️ | Supervisor/Doc-Manager | 验收/对账靠 Leader 触发 | **验收 DAG**：gap-list 对账→HITL 门禁→归档，入口校验（证据齐备） |

### 5.2 批次结构强化草案（重新设计）

- 批次建模从"单层 task 集"升级为**三层子图**：`plan` 层 → `exec` 层（含强制 review 边）→ `audit` 层；
- 每层独立 wavePlan（固定语义，建批时确定并持久化）+ 层间门禁（plan 完成→exec 可派；exec 全 merged 且评审证据齐→audit 可跑）；
- 门禁强化（4.3 方案 A/B）作为 **exec→audit 边上的 gate** 并入新设计；
- 状态机扩展：批次阶段（planning→running→paused→aborted|complete）增加层内子阶段或 `layer` 维度。

### 5.3 风险评估（用户提示）

- **风险**：三层强化后，蟛蜞模式将**只支持适配三层编排的任务**（代码模块开发类）；通用/一次性任务不再适用。
- **缓解选项**：
  a) 保留任务分级（简单任务降级单 Agent，已落地）——继续覆盖小任务；
  b) 批模板化：`generic`（现状单层）/ `three-tier`（强化三层）可选，按任务类型选择；
  c) 封装新预设（如"蟛蜞-研发批次"模式）与现预设并存，避免模式语义膨胀。

---

## 六、决策记录

| 项 | 状态 |
|---|---|
| 借鉴点 1（worktree lane） | 已归档，待评估（git 依赖 + win32 bash 限制） |
| 借鉴点 2（声明式 DAG 校验） | ✅ 已内置（wave-plan.js 入口校验 + 防篡改），无需追加；声明式文件形态可选 |
| 借鉴点 3（评审流） | 差距核实完成，门禁强化方案 A 主推待确认 |
| 三层 DAG 强化（重新设计） | 草案见 §5，待用户确认是否立项 |
| 模式适配范围风险 | 见 §5.3，待用户决策（批模板 or 新预设） |
