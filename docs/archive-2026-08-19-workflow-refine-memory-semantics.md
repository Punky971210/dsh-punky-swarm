# 归档：工作流重定义与固化落地（2026-08-19）
> 更新（2026-08-20）：tier3 插件副本已删除；发布名改为 dsh-punky-swarm（见 docs/OPENSOURCE.md）。

> 状态：**已落盘** · 背景：三层门禁回填 dsh-punky 后，按 jiufeng 团队合作模式重定义工作流（用户描述 + 原版溯源）。
> 溯源依据：`jiufeng-expandable-team/workflow.md`（角色 DAG + 11 步流转 + dp1-dp4 硬化点）、roles/*.md 原版。

## 一、工作流蓝图（确认版）

```
Leader 开启任务 → Manager（第一对接点：mailbox 收发/读状态/空闲发现/指派）
  → Leader 人工粗拆（模块清单，不再由 Coordinator 粗拆）
  → Coordinator 细拆（API 粒度）+ 代码摸底（新职责，产出 codebase-survey.md）
  → Designer 四件套（plan.md/spec.md/coder-tasks.md/tester-tasks.md，执行层全部规范）
  → 执行层 coder → test → reviewer（双线审查 + Converge gap-list）
  → 审批层 Supervisor（acceptance-report + CBM 对账）
  → Doc-Manager（retrospective-report → 记忆沉淀 + 归档 → 回馈任务层）
```

三处对原版调整：① Manager 提前为第一对接点（原版仅调度）；② 粗拆上移 Leader（原版 Coordinator 粗拆）；③ Coordinator 新增代码摸底（原版无，仅 Supervisor 验收时 CBM 摸底）。

## 二、固化决策（分层）

| 层 | 决策 | 状态 |
|---|---|---|
| 引擎 | **不补** three-tier 批模板产物清单（防引擎绑 jiufeng 模板） | ✅ 已定 |
| 引擎 | **补** 通用产物类型注册表（产物类型→层/目录前缀，通用任务治理模式） | ✅ 已落地 |
| 预设 | persona 补 0c（Manager 职责 + Leader 粗拆分工）+ 0d（记忆语义） | ✅ 已落地 |
| 模板 | workflow 蓝图迁入 / 四件套模板 / Coordinator 摸底职责 / 验收复盘模板 | ⏳ M2 待办 |

**固化准则**：能机器校验的进引擎（存在性+结构底线），行为规则的进预设（指派权/对接点/分工），产物格式与流程的进模板（四件套/摸底/验收/复盘内部结构）。

## 三、本轮增量清单（已落盘）

| 文件 | 改动 |
|---|---|
| `packages/dsh-punky/lib/artifact-types.js` | **新增**：产物类型注册表（plan/spec/taskTree/survey/code/testReport/review/gapList/acceptance/retrospective，三层目录约定，不绑 jiufeng） |
| `packages/dsh-punky/lib/tools.js` | +**artifact_types** 只读工具（13 个）；import ARTIFACT_TYPES |
| `packages/dsh-punky/test/tools.test.js` | 13 工具断言 + artifact_types 注册表用例 |
| `~/.dsh/.agent-presets/jiufeng/agent.cordis.yml` | persona 纪律 **0c**（Manager 第一对接点/指派权/DAG 全员只读/粗拆分工）+ **0d**（记忆语义） |
| `~/.agents/skills/jiufeng-team/references/roles/*.md`（7 文件） | 记忆语义修正：doc-manager 操作层 → 记忆库（dsh-mneme 优先）；SP-XX 经验编号标注「记忆库经验」；「Mnemopi 参考」→「记忆库参考（Mnemopi 降级）」 |

**测试基线**：`node --test test/*.test.js` → **68/68 全绿**（67 + artifact_types 1）。

## 四、记忆语义决策（用户修正）

```
复盘产物（retrospective-report.md）落盘 audit/（引擎只认存在）
  → 记忆沉淀：dsh-mneme（memory_save/search，开放语义）✅ 主路径
  → 降级：Mnemopi（旧环境 MCP 手动调用，不强制）
```

## 五、固化分层现状（截至本归档）

| 层 | 已固化 |
|---|---|
| 引擎 | 三层门禁（Entry/Exit/Complete/L0）+ 产物类型注册表 + 13 工具（wave_plan/assign_check/gate_status/artifact_types 等）+ 可插拔装配（assembly） |
| 预设 | 纪律 0/0b/0c/0d（任务分级/三层门禁/Manager 职责+粗拆/记忆语义） |
| 模板 | 三层门禁段 + 记忆语义修正；workflow 蓝图/四件套模板/摸底职责/验收复盘模板 → M2 |


## 七、架构分层（2026-08-19 确认：不绑定模式，三层）

> 决策：工具不绑模式——所有 agent 可用；蟛蜞模式对如何使用这套工具有明确指引；团队指引可插拔接入。

| 层 | 内容 | 载体 | 现状 |
|---|---|---|---|
| **L1 底层工具**（全部 agent 可用） | 13 个治理工具（wave_plan/batch_phase/batch_status/assign_check/gate_status/artifact_types/lane_claim/lane_release/member_status/member_settle/mailbox_send/read/ack）+ 引擎门禁（Entry/Exit/Complete/L0）+ 可插拔装配 | dsh-punky：lib/tools.js、batch-store.js、wave-plan.js、assembly.js、artifact-types.js | ✅ 已落地（68/68） |
| **L2 模式使用指引**（蟛蜞模式语义） | 对工具套件的使用指引——纪律 0/0b/0c/0d + 1-8（任务分级 / 三层门禁 / Manager 职责+粗拆 / 记忆语义）；语义开放，指引不锁工具 | ~/.dsh/.agent-presets/jiufeng（persona） | ✅ 已落地 |
| **L3 团队指引接入**（可插拔） | jiufeng 团队（或其他团队）指引接入：角色定义 + 装配表 + workflow 蓝图 + 产物模板；非 jiufeng 团队 = 换 assembly.json + 团队 skill | jiufeng-team skill + assembly.js | ⚠️ 部分：角色/装配/三层门禁段/记忆语义已；**workflow 蓝图 / 四件套模板 / Coordinator 摸底职责 / 验收复盘模板（M2）待补** |

**分层原则**：
1. L1 机制强制**不依赖** L2/L3（梁神会话也能跑集群治理，引擎门禁两侧有效）；
2. L2 语义指引**不锁** L1（预设只管"怎么用"，不管"谁能用"）；
3. L3 可插拔**不绑** L2（assembly.json 通用化，非 jiufeng 团队换装配即可）。

**落地验证**：本会话（梁神模式）成功调用 wave_plan（三层建批）/member_status/gate_status/assign_check/artifact_types——L1 跨预设可见实证。


## 八、L3 模板/装配补充（2026-08-19 落地）

| 项 | 内容 | 状态 |
|---|---|---|
| **workflow 蓝图** | 新增 `jiufeng-team/references/workflow.md`：角色 DAG + 11 步流转 + 产物契约表 + 硬化判定点↔三层门禁 + 三处调整（Manager 第一对接/Leader 粗拆/Coordinator 摸底） | ✅ |
| **模板迁入** | 旧库 docs/templates/ 6 个模板 → `jiufeng-team/references/templates/`（plan-template / endpoint-behavior / call-chain-matrix / gap-list.json / leader-decision-pack / success-pattern-seeds） | ✅ |
| **Coordinator 摸底职责** | coordinator.md 改造：粗拆上移 Leader → 代码摸底（codebase-survey.md：现状/入口/依赖/风险）作为 Designer consume | ✅ |
| **装配补全** | assembly.js audit 层补 doc-manager（doc-generator/doc-update），dsh-punky + tier3 同步 | ✅ |
| **引用一致性** | SKILL.md 使用方式加 workflow 引用；角色文件模板路径统一 references/templates/（constitution → references/）；doc-manager 记忆语义（dsh-mneme 优先） | ✅ |
| 测试 | dsh-punky 68/68（assembly 改动后回归通过） | ✅ |

**jiufeng-team 结构（17 文件）**：SKILL.md + references/{constitution.md, workflow.md, roles/×8, templates/×6}——L3 团队指引完整可插拔（换团队 = 换 assembly.json + 团队 skill 目录）。


## 九、预设收敛（2026-08-19：jiufeng-tier3 退役）

- **决策**：蟛蜞模式（jiufeng）与蟛蜞三层模式（jiufeng-tier3）引擎同一（dsh-punky）、指引几乎一致（tier3 缺 0c/0d），功能重复 → **退役 jiufeng-tier3 预设**；
- 验证/日常使用统一用「蟛蜞模式」（指引最全：0/0b/0c/0d + 1-8；三层能力已回填 dsh-punky，wave_plan team=jiufeng 即可跑三层批次）；
- tier3 插件副本（packages/dsh-punky-tier3）保留为仓库开发参照/回滚备份（未挂载，不影响 profile）；
- 回滚锚点不变：Punky-plugin/docs/snapshot-2026-08-19-dsh-punky-baseline.md + backups/dsh-punky-0.1.0-20260819/。

## 六、待办

1. 重启 web 验证 13 工具 + lanesGate + 工作台徽标 + 存量 9 批次兼容；
2. M2 模板补强（workflow 蓝图迁入 jiufeng-team、Designer 四件套模板引用、Coordinator 摸底职责、验收/复盘模板）；
3. 端到端演练（§14.3 LLM 行为实测：三层批次 + 事件链审计）。
