# dsh-punky-swarm 现状快照（Tier3 三层门禁 + 会话隔离 v2）

> 2026-08-20 · 按当前插件实现代码重新盘点（上一轮更新未归档，本文为补档）。
> 前置：基线见 docs/snapshot-2026-08-19-dsh-punky-swarm-baseline.md（10 工具）；回写记录见 docs/snapshot-2026-08-19-dsh-punky-swarm-after-backfill.md（10→12）。
> 回滚锚点：backups/dsh-punky-swarm-0.1.0-20260819/（Tier3 回写前全量拷贝，10 工具基线）。

## 一、版本与挂载

| 项 | 值 |
|---|---|
| 包 | dsh-punky-swarm 0.1.0（发布名；tier3 验证副本已于 2026-08-20 退役删除） |
| 工具面 | **13 个**（wave_plan / batch_phase / batch_status / artifact_types / assign_check / gate_status / lane_claim / lane_release / member_status / member_settle / mailbox_send / mailbox_read / mailbox_ack） |
| API | /api/dsh-punky-swarm/batches｜sessions｜batch｜mailbox｜locks（只读，按 session 隔离） |
| client | conversation.view 第三分页「蟛蜞集群」+ GateBadge（缺 N）+ AttemptBadge（返工计数 ≥3 升级标记） |
| 存储 | root/sessions/<sessionId>/batches|mailbox|.locks；存量 root/batches 自动迁移 sessions/legacy |
| 预设 | jiufeng（蟛蜞模式，~/.dsh/.agent-presets/jiufeng） |

## 二、Tier3 三层门禁（引擎级强制，已实装）

### 建批静态校验（wave-plan.js validateLayerContract）
- layer ∈ plan/exec/audit；**有 exec 必有 audit**；
- 路径契约：consume/produce/outputs 相对路径必须在本批次产物根内（plan/|exec/|audit/ 前缀）或绝对路径；跨批次 artifacts/ 引用 MVP 先禁（N6）；
- 跨层引用：exec.consume 的 plan/ 路径必须由 plan 层 produce 提供；
- role/skills 声明校验（非空字符串 / 非空字符串数组）。

### 运行时门禁（batch-store.js）
| 门禁 | 触发点 | 语义 |
|---|---|---|
| Entry Gate | exec lane 派发（→running） | consume 必须全部存在且非空，缺失拒绝（GATE_ENTRY_MISSING） |
| L0 Plan Contract | plan lane merged | spec.md 必含「## 验收标准」「## 约束」；.json 可解析（GATE_PLAN_CONTRACT） |
| Exit Gate | exec/audit lane merged | exec→outputs 存在；audit→produce 存在（GATE_EXIT_MISSING_*） |
| Complete Gate | batch →complete | 三层批次：audit 存在、全终态、无 failed/conflict；exec 全终态（GATE_COMPLETE_*） |

generic 批次（无 layer）不触发门禁，向后兼容。

## 三、会话隔离 v2

- 批次/产物/mailbox/锁全部按 session 隔离：root/sessions/<sessionId>/…；
- 工具缺省绑定当前执行会话（exec.agent.session.id），可被 args.session 覆盖，cli 兜底；
- 存量 root/batches/*.json 启动时一次幂等迁移到 sessions/legacy/batches/。

## 四、装配与产物注册表（增量）

- assembly.js：DEFAULT_ASSEMBLY（jiufeng：plan=coordinator/designer，exec=coder/tester，audit=reviewer/supervisor/doc-manager，各角色挂 skills）；resolveAssembly(team, config.assembly) 可插拔，引擎只认「role 契约 + skill 前缀」，不感知团队；
- wave_plan 建批时按 role 注入 [role=…][skills=…] cmd 前缀；
- artifact-types.js：10 类产物注册表（plan/spec/taskTree/survey/code/testReport/review/gapList/acceptance/retrospective），与三层目录契约一致，只读工具 artifact_types 暴露。

## 五、事件（只存元数据）

batch.created / batch.phase / member.settled / gate.entry.missing / gate.exit.missing / gate.complete_blocked / gate.passed / system.recovered

## 六、验证记录

- 单元：**68/68 通过**（node --test，Node v24）——状态机/拓扑/锁/mailbox/原子库/门禁（entry/L0/exit/complete）/三层契约/返工（review→running ×2）/13 工具/API；
- 恢复语义：进程启动时 in-flight running/review → idle + system.recovered（每进程一次，跨全部 session）。

## 七、与 2026-08-19 归档的差异（本轮增量）

| 项 | 2026-08-19 归档 | 当前（2026-08-20） |
|---|---|---|
| 工具面 | 12（assign_check/gate_status） | **13（+artifact_types）** |
| 三层门禁 | 设计归档待确认（方案 A/B） | **引擎级实装**（entry/L0/exit/complete） |
| 装配 | 草案（§12.1/§14.2） | assembly.js 实装（jiufeng 默认 + config 可插拔） |
| 产物契约 | 无 | artifact-types 注册表 + 路径契约校验 |
| API/UI | 无门禁信息 | API lanesGate + client GateBadge/AttemptBadge |
| 测试 | 29 | **68** |
