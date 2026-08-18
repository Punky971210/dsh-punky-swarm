# dsh-punky 现状快照（回写 Tier3 增量前的基线）
> 更新（2026-08-20）：历史快照，包名已改为 dsh-punky-swarm，tier3 副本已退役删除。

> 2026-08-19 · 用途：回写三层门禁增量前的**回滚锚点**；出问题时按本快照还原或回滚增量。
> 关联：备份目录 `backups/dsh-punky-0.1.0-20260819/`（tier3 开发开始时全量拷贝，与当前一致）。

## 一、版本与挂载

| 项 | 值 |
|---|---|
| 包 | dsh-punky 0.1.0（private, ESM, 零运行时依赖） |
| profile 挂载 | `link:<repo>/packages/dsh-punky`（web profile bundles 含 dsh-punky） |
| 工具面 | 10 个（wave_plan/batch_phase/batch_status/lane_claim/lane_release/member_status/member_settle/mailbox_send/read/ack） |
| API | /api/dsh-punky/*（batches/sessions/batch/mailbox/locks） |
| 预设 | ~/.dsh/.agent-presets/jiufeng（蟛蜞模式，persona 含任务分级纪律 0） |

## 二、文件哈希（SHA-256 前 12 位，回滚校验用）

| 文件 | 哈希 |
|---|---|
| lib/api.js | a769b00387ab |
| lib/batch-store.js | 5ac56bdfd1d1 |
| lib/client.js | 428abad78529 |
| lib/index.js | 848dca8408c7 |
| lib/lock.js | c406c7bfada3 |
| lib/mailbox.js | 58cb6cb499f0 |
| lib/schema.js | 06eda7cf3878 |
| lib/tools.js | 99d4f7494bf6 |
| lib/wave-plan.js | 080caec87036 |
| test/api.test.js | 7bfd3e0a14d1 |
| test/batch-store.test.js | b3d0f795a77e |
| test/lock.test.js | 86a1848d4081 |
| test/mailbox.test.js | f51b7e624f99 |
| test/rework.test.js | 3deca39b4459 |
| test/schema.test.js | 52896125bad7 |
| test/tools.test.js | af0d1d6ca622 |
| test/wave-plan.test.js | 8340578648f7 |
| package.json | 386ca4d1c8cb |
| cordis.patch.yml | 025e9209397c |

## 三、测试基线

`node --test test/*.test.js` → **46/46 全绿**（api 8 + batch-store + lock + mailbox + rework + schema + tools + wave-plan）

## 四、数据现状（~/.dsh/jiufeng）

- legacy：b-diag / b-e2e / b-swarm / pengqi-dep-check（4 个历史批次）
- session-209c0b59：punky-edu-audio-persist / diagnosis / fix-r1 / voice-submit（4 个实跑批次）
- session-7dcd78d5：demo-fallback-check（1 个）
- 回写后：新批次将带 layer 字段；存量批次按 generic 读取（向后兼容，不迁移不损坏）

## 五、回写增量清单（tier3 → dsh-punky，待确认后执行）

| 文件 | 增量 | 回写注意 |
|---|---|---|
| lib/wave-plan.js | schema v2：layer/consume/produce/outputs/role/skills/team + assembleCmd 注入 + 三层静态校验 | 路径/API 保持 dsh-punky 名 |
| lib/batch-store.js | Entry/Exit/Complete Gate + L0 checkPlanContract + gateStatus + 门禁事件 | 同 |
| lib/assembly.js | 新增：可插拔装配（N7） | 新增文件 |
| lib/tools.js | 12 工具：wave_plan 扩展 + assign_check + gate_status | 同 |
| lib/api.js | /batch 加 lanesGate | 路径 /api/dsh-punky/* 不变 |
| lib/client.js | GateBadge 门禁徽标 + lanesGate 渲染 | id/NS/api 路径保持 dsh-punky |
| test/ | contract.test.js + gates.test.js 移植 + tools/api 测试更新 | 断言路径用 /api/dsh-punky |
| 预设 | jiufeng 预设可选加纪律 0b（三层门禁说明） | 与 jiufeng-tier3 预设并存 |

## 六、回滚方式

1. **整包回滚**：`backups/dsh-punky-0.1.0-20260819/` 覆盖 `packages/dsh-punky/`（或 git 还原）；
2. **增量回滚**：按 §二 哈希差异定位变更文件，从备份还原对应文件；
3. **数据回滚**：回写不迁移存量批次；新三层批次若需清理，删除 `~/.dsh/jiufeng/sessions/<sid>/batches/<新批次>.json` 即可。
