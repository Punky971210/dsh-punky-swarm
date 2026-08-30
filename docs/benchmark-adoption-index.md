# 对标落地索引（Benchmark Adoption Index）

> 用途：6 个插件对标 study（源自 punky-market-adapt 批次源码级借鉴复核）的采纳项 → 落地位置/状态索引表，保证「对标结论 → 落地 → 可追踪」审计链不因 CHANGELOG 笼统记载而断裂。
> 数据基准：techdebt-audit-0827 批次 exec/config-docs-report.md §5 追踪表（2026-08-27 实测，6/6 已落地；仅 taskswarm M5 面板 SSE 未落地）+ 源码证据（行号随版本漂移，以 git HEAD 复核为准）。
> 维护约定：新对标 study 采纳后在本表追加行；落地机制变更时同步更新落地位置与状态。
> 项目根（相对路径基准）：`packages/dsh-punky-swarm/`；docs/ 为仓库级目录（不入 npm 发布包）。

## 一、study 清单与采纳结论总览

| # | study | 来源批次 | 采纳结论 | 落地装配键/模块 | 落地状态 |
|---|---|---|---|---|---|
| 1 | trajectory-governance | punky-market-adapt | 借鉴（以内部桥接实现替代直接装第三方插件） | `capabilities.trajectory` | ✅ 已落地 |
| 2 | heartbeat | punky-market-adapt | 借鉴（P0 修正为借鉴机制） | `capabilities.watch` + lane_heartbeat | ✅ 已落地 |
| 3 | taskswarm | punky-market-adapt | 借鉴（M1-M4 落地；M5 面板 SSE 参考级未落地） | `capabilities.worktree`（+mergeAgent 默认关） | ✅ 已落地（M1-M4）/ ⏳ 未落地（M5） |
| 4 | verification | punky-market-adapt | 借鉴 | `capabilities.verify` | ✅ 已落地 |
| 5 | review-workflow | punky-market-adapt | 借鉴 | lib/assembly/audit-blind-review.js（audit 层增强） | ✅ 已落地 |
| 6 | dsh-team | punky-market-adapt | 借鉴 | `capabilities.budget` | ✅ 已落地 |

> 采纳结论口径：**装**=直接安装第三方插件；**借鉴**=机制借鉴、内部实现落地；**不采纳**=机制保留参考、不落地（当前 6 study 无一「直接装」，trajectory 原判「直接装+桥接」落地时改为内部桥接实现）。

## 二、逐 study 采纳项明细

### 1. study-trajectory-governance（诊断桥接）

| 机制/借鉴点 | 采纳结论 | 落地位置 | 状态 |
|---|---|---|---|
| 诊断桥接 notify（异常诊断 → sessionId→lane 映射 → notify；autoFail 可选） | 借鉴 | lib/assembly/schema.js `TRAJECTORY_DEFAULTS`；cordis.patch.yml `trajectory.enabled:true / autoFail:false / failConfidence:0.85` | ✅ 已落地（以内部桥接实现替代直接装第三方插件，与 study 桥接方案一致） |

### 2. study-heartbeat（心跳/过期检测）

| 机制/借鉴点 | 采纳结论 | 落地位置 | 状态 |
|---|---|---|---|
| 退避状态机 / 硬停 stalled / 定时器链 watchdog | 借鉴 | lib/watch/lane-heartbeat.js（lane_heartbeat 工具 + watchdog）；lib/schema.js；cordis.patch.yml `watch` 键 | ✅ 已落地 |

### 3. study-taskswarm（worktree / checkpoint / merge / wavePlan / 面板）

| 机制/借鉴点 | 采纳结论 | 落地位置 | 状态 |
|---|---|---|---|
| M1 worktree 三工具（物理隔离） | 借鉴 | lib/tools/lane-tools.js：lane_worktree_create / lane_worktree_merge / lane_checkpoint / lane_checkpoint_status | ✅ 已落地 |
| M2 checkpoint 提交保全 | 借鉴 | 同上（lane_checkpoint / lane_checkpoint_status） | ✅ 已落地 |
| M3 merge conflict 半套（冲突保留现场，不自动处置） | 借鉴 | cordis.patch.yml `worktree.mergeAgent.enabled:false`（默认关，需宿主注入 spawner） | ✅ 已落地（半套） |
| M4 wavePlan 落盘（建批固定语义） | 借鉴 | lib/state/store.js createBatch 落盘 wavePlan；lib/wave-plan.js | ✅ 已落地 |
| M5 面板 SSE（实时推送） | 不采纳（参考级） | lib/panel/main.js 保持 setInterval 3s 轮询，无 SSE | ⏳ 未落地——已立项 P2-12（功能级需设计先行，另行排期） |

### 4. study-verification（验收证据）

| 机制/借鉴点 | 采纳结论 | 落地位置 | 状态 |
|---|---|---|---|
| audit lane 消费模式（post-execute 捕获 + advisory/enforce 三态裁决） | 借鉴 | lib/assembly/schema.js `VERIFY_DEFAULTS`；lib/verify/evidence.js + lib/verify/gate.js；cordis.patch.yml `verify.enabled:true / mode:advisory` | ✅ 已落地（advisory 默认与 study 一致；enforce 未显式启用） |

### 5. study-review-workflow（评审工作流）

| 机制/借鉴点 | 采纳结论 | 落地位置 | 状态 |
|---|---|---|---|
| 多评委盲审 M1-M6（audit 层增强：盲审面板/聚合/评审角色分离） | 借鉴 | lib/assembly/audit-blind-review.js + BLIND_REVIEW 三角色（audit-panelist / aggregate / critic + 6 模板键）；lib/assembly/schema.js | ✅ 已落地（audit-blind-review.test.js 佐证） |

### 6. study-dsh-team（循环防护）

| 机制/借鉴点 | 采纳结论 | 落地位置 | 状态 |
|---|---|---|---|
| 循环防护三件套：maxChainHops / maxChainRoundTrips / 一字不差重复消息拒发 | 借鉴 | lib/assembly/schema.js `budget` 默认 `{enabled:true, maxChainHops:4, maxChainRoundTrips:2}`；cordis.patch.yml `budget` 键；lib/comms/budget.js | ✅ 已落地 |

## 三、未采纳/挂起项

| 项 | study | 未落地原因 | 状态 |
|---|---|---|---|
| taskswarm M5 面板 SSE | study-taskswarm | 参考级机制；现 3s 轮询满足只读面板需求；SSE 属功能级增强需设计先行 | 已立项 P2-12（另行排期） |
| enforce 模式（verification） | study-verification | advisory 默认与 study 一致，enforce 需策略评估后显式启用 | 未启用（可配置） |
| mergeAgent 自动冲突化解 | study-taskswarm | 需宿主注入 spawner；未注入时保持 conflict 状态由 Manager/Leader 裁决（更符合治理语义） | 默认关（可配置） |

## 四、可追溯性说明

- 6 study 采纳机制在 CHANGELOG 0.3.x 无逐机制条目（仅 0.3.0「8 批次能力升级…7 能力域」笼统记载）——本表为逐机制落地索引的单一入口，替代代码反查。
- 落地点以 lib 实现 + 装配键 + 配置示例三处互相印证；行号锚点以 techdebt-audit-0827 追踪表为准，实施/复核时以 git HEAD 为准。
- 关联文档：`docs/benchmark-2026-08-20-*.md`（对标原始评估）、techdebt-audit-0827 批次 exec/config-docs-report.md（追踪表出处）。
