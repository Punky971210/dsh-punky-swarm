# dsh-punky 现状快照（Tier3 增量回写后）
> 更新（2026-08-20）：历史快照，包名已改为 dsh-punky-swarm。

> 2026-08-19 · 回写完成：三层门禁增量已并入 dsh-punky（tier3 副本保留不动）。
> 回滚锚点：`backups/dsh-punky-0.1.0-20260819/`（回写前全量拷贝）；回写前基线见 `docs/snapshot-2026-08-19-dsh-punky-baseline.md`。

## 一、版本与挂载（不变）

- 包 dsh-punky 0.1.0；profile link 挂载；API /api/dsh-punky/*；预设 jiufeng（蟛蜞模式）
- **工具面：10 → 12**（新增 assign_check / gate_status）

## 二、回写增量（tier3 → dsh-punky）

| 文件 | 增量 |
|---|---|
| lib/wave-plan.js | schema v2（layer/consume/produce/outputs/role/skills/team）+ assembleCmd 注入 + 三层静态校验 |
| lib/batch-store.js | Entry/Exit/Complete Gate + L0 checkPlanContract + gateStatus + 门禁事件 |
| lib/assembly.js | **新增**：可插拔装配（N7） |
| lib/tools.js | 12 工具（wave_plan 扩展 + assign_check + gate_status） |
| lib/api.js | /batch 加 lanesGate（路径保持 /api/dsh-punky） |
| lib/client.js | GateBadge 门禁徽标 + lanesGate 渲染（id/NS 保持 dsh-punky） |
| test/ | +contract.test.js +gates.test.js +tools/api 断言更新 |

## 三、测试基线（回写后）

`node --test test/*.test.js` → **67/67 全绿**（基线 46 + 新增 21：contract 9 + gates 9 + tools 2 + api 1）

## 四、文件哈希（SHA-256 前 12 位，回滚校验用）

| 文件 | 哈希 |
|---|---|
| lib/api.js | 8b50ac778784 |
| lib/assembly.js | 944b14721317 |
| lib/batch-store.js | 41139a8a0639 |
| lib/client.js | 144f53b2b7c5 |
| lib/index.js | 848dca8408c7 |
| lib/lock.js | c406c7bfada3 |
| lib/mailbox.js | 58cb6cb499f0 |
| lib/schema.js | 06eda7cf3878 |
| lib/tools.js | bcb622a96a64 |
| lib/wave-plan.js | 4fe7e12f95de |
| test/api.test.js | 6bcc9d8e52fa |
| test/batch-store.test.js | b3d0f795a77e |
| test/contract.test.js | 41c57dae6230 |
| test/gates.test.js | 21025af99c1f |
| test/lock.test.js | 86a1848d4081 |
| test/mailbox.test.js | f51b7e624f99 |
| test/rework.test.js | 3deca39b4459 |
| test/schema.test.js | 52896125bad7 |
| test/tools.test.js | aebfaa1ec911 |
| test/wave-plan.test.js | 8340578648f7 |
| package.json | 386ca4d1c8cb |
| cordis.patch.yml | 025e9209397c |

## 五、数据兼容

- 存量 9 批次（legacy 4 + punky-edu 4 + demo 1）无 layer 字段 → generic 读取，零迁移；
- 新三层批次写入同目录（layer 字段随批次落盘）。


## 七、2026-08-19 补充增量（详见 docs/archive-2026-08-19-workflow-refine-memory-semantics.md）

- 新增 lib/artifact-types.js（产物类型注册表）+ artifact_types 工具（13 个）；测试基线 68/68；
- persona 补 0c（Manager 职责/粗拆分工）+ 0d（记忆语义）；jiufeng-team 角色文件记忆语义修正（Mnemopi 降级）。
## 六、回滚方式

1. 整包回滚：backups 覆盖 packages/dsh-punky/；
2. 增量回滚：按 §四 哈希定位变更文件，从 backups 还原对应文件；
3. 预设：jiufeng 预设未改（0b 纪律待确认）；tier3 预设 jiufeng-tier3 独立存在。
