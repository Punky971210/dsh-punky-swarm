# dsh-punky-swarm 开源前质量评估（2026-08-20）

> 目的：评估插件质量，为独立开源准备材料。评估对象 = 插件（packages/dsh-punky-swarm）+ 模式（presets/jiufeng）+ 指引（skills/jiufeng-team）三件套。
> 方法：代码审读 + 单测实跑 + 仓库体检 + 生态收录标准核对（awesome-dsh-plugin / dsh-market）。评分 1–5，不注水。

## 一、总评

| 维度 | 分数 | 一句话 |
|---|---|---|
| 引擎正确性与测试 | 4.0 | 68 单测全绿、门禁/契约/返工覆盖扎实；但无集成测试与 CI |
| 健壮性 | 2.5 | 无容错（损坏批次会中断恢复）、锁无租约、无重试——与本人自评一致 |
| 设计与可维护性 | 4.0 | 零运行时依赖、ESM、单文件职责清晰、事件驱动 |
| 文档 | 3.0 | 齐全但全中文、含个人路径、部分状态过期 |
| 发布形态 | 1.5 | 无 LICENSE/CI/版本策略；三件套分散三处未入包；test script 在 Windows 不可跑 |
| 生态适配 | 3.0 | bundle manifest 齐全可 dsh plugin add；未发布、未收录 |
| **综合** | **3.0** | 引擎值得开源，发布形态是主要缺口 |

## 二、代码与测试（4.0）

### 强项
- 零运行时依赖（node:test 测试，defineTool 官方接口），ESM；
- 模块边界清晰：schema（状态机）/ wave-plan（DAG+层契约）/ lock / mailbox / batch-store（原子写+门禁+恢复）/ assembly / artifact-types / tools / api / client；
- 68 单测覆盖：拓扑/环检测/防篡改、Entry/L0/Exit/Complete 四道门禁、返工（review→running）、锁冲突/wait/force、mailbox ack、会话隔离、API 路由；
- 原子写（临时文件+rename）+ 事件日志 + 防篡改（validateWavePlan 拒改）。

### 缺口（按严重度）
1. **test script 坏**：package.json `"test": "node --test test/"` 在 Node 24 + Windows 报 MODULE_NOT_FOUND（glob 解析问题），必须改 `node --test`；
2. **peerDependencies 缺 `@deepseek-ai/dsh-tools`**（tools.js 直接 import）；
3. 无集成测试：全部单测是纯逻辑 + 临时目录，未在真实 dsh 宿主冒烟（挂载/工具注册/UI 分页）；
4. 无 lint / typecheck 脚本；
5. readBatch 无容错：单个批次 JSON 损坏会让恢复流程抛错（P0 健壮性）；
6. 错误码散落字符串（GATE_*），未集中枚举。

## 三、健壮性（2.5）——与本人自评一致

| 项 | 现状 | 目标边界内影响 |
|---|---|---|
| worker 失败重试 | failed 即终态，靠 Leader 重派 | 中：单机多子 agent 仍会频繁遇到 |
| 损坏批次容错 | 无 | 高：一次损坏拖垮 recoverBatches |
| 锁泄漏 | 无租约，崩溃后 force 接管 | 中 |
| mailbox 滞留 | 无清理 | 低 |
| 孤儿 subagent | 无感知 | 中 |

## 四、文档（3.0）

- 强：README / USAGE / 快照 / 设计 / 社区对标 分层齐全，命名即文档，边界声明已补；
- 缺口：全中文（开源需 README.en.md）；个人路径已去敏（2026-08-20）；docs 中「待确认/已归档」状态与当前实现存在残留不一致（部分已修正）。

## 五、发布形态（1.5）——开源前必修

| 项 | 现状 | 动作 |
|---|---|---|
| LICENSE | 缺失 | 补 Apache-2.0（与 dsh 生态一致） |
| .gitignore / CHANGELOG / CONTRIBUTING | 缺失 | 补 |
| CI | 缺失 | 加 GitHub Actions（node 22/24，node --test） |
| package.json | private、无 license/repository/files/engines | 修正 |
| 三件套入包 | 模式在 ~/.dsh/.agent-presets/jiufeng，指引在 ~/.agents/skills/jiufeng-team，均不在仓库 | 拷入 packages/dsh-punky-swarm/presets + skills |
| tier3 副本 | dsh-punky-swarm-tier3 与主包引擎一致 | 开源排除或独立包，避免双份维护 |
| npm 发布 / 市场收录 | 未发布 | 先本地仓库达标，再发 npm + 提交 awesome-dsh-plugin / dsh-market |

## 六、开源建议（结论）

1. **先补齐发布形态**（LICENSE/CI/package.json/三件套入包/test script），再谈发布；
2. **README 边界声明**：单机多子 agent 治理，明确硬化/续跑/集群/成本控制不在范围，避免被误用；
3. **去敏**：替换个人路径与机器上下文，docs 状态对齐当前实现；
4. **发布路径建议**：npm（@ 私有名待定）→ dsh plugin add → awesome-dsh-plugin PR + dsh-market 收录；
5. **下一版本（0.2.0）范围**：P0 健壮性（重试/损坏容错）+ 预设自动同步（参照 dsh-liangshen host 启动同步）。
