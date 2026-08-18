# 蟛蜞工作台（集群治理面板）设计 v0.1

> 2026-08-17 · 状态：思路设计（待实现）
> 目标：把 dsh-punky-swarm 的治理状态可视化，对标 jiuwen(WorkSwarm) 的 /swarmflows 运行树与 TeamMonitor，做成 dsh web 内的「集群工作台」面板。

## 一、形态选项

| 选项 | 形态 | 优点 | 缺点 | 建议 |
|---|---|---|---|---|
| A. 内嵌面板 | dsh web 侧边栏入口「集群工作台」，client bundle + host API | 复用 dsh 客户端插件体系；与聊天同屏 | 受主 UI 布局约束 | **推荐（主路径）** |
| B. 独立工作台 | host 提供 /jiufeng 独立前端页（脱离聊天） | 布局自由、专注监控 | 需独立前端基建 | 可选扩展（V3） |
| C. TUI/CLI 视图 | headless/终端输出批次树 | 零前端成本 | 交互弱 | 顺手补（低优先） |

## 二、参考实现对照

| 参考 | 来源 | 可借鉴点 |
|---|---|---|
| /swarmflows 运行树 | jiuwen(WorkSwarm) TUI | 批/任务运行树、阶段推进可视化 |
| TeamMonitor | jiuwen(WorkSwarm) | 成员状态查询（含降级 DB 直查） |
| dsh-git-graph | @linxin666 dsh-web-ui | **提交 DAG 泳道渲染**（wave 泳道可直接借用视觉/交互） |
| dsh-task-board | @linxin666 dsh-web-ui | **看板状态卡 + 侧边栏入口 + 客户端挂载模式** |
| dsh-mneme | 已实装 | **host API routes + client 面板**的插件双端模式 |

## 三、数据模型 → 视图映射

| 数据（~/.dsh/jiufeng） | 视图 |
|---|---|
| batches/<id>.json | 批次卡片（phase 色标、concurrency、事件数、settled 徽标） |
| wavePlan | wave 泳道（每 wave 一泳道，任务节点按依赖连线——仿 git-graph DAG） |
| lanes | 状态卡（pending/running/review/merged/failed/skipped/conflict/idle 色标 + 锁图标） |
| events[] | 事件时间线（batch.created/batch.phase/member.settled/system.recovered） |
| mailbox/<id>/ | 收件箱视图（inbox/outbox/broadcast 未读计数 + 消息元数据 + ack 状态） |
| .locks/ | 锁标记（lane 上的锁图标与持有者） |

## 三·四、可见性边界（2026-08-17 用户界定）

| 内容 | 可见性 | 理由 |
|---|---|---|
| **任务批次列表 + 批次详情** | **核心展示（最高优先）** | 人机交互最重要：进度、门禁、异常、终态、审计 |
| **收件箱（mailbox）** | **可见不可改（只读）** | 成员间/集群间通信，Human 不参与；展示但无 ack/写入操作 |
| **锁状态（.locks）** | **不展示** | 运行状态由成员自主决定、自主运行；锁是内部机制，人无需关心 |
| 面板操作 | **一律只读** | 治理操作（batch_phase/member_settle 等）由蟛蜞模式 Leader 执行，面板不做治理旁路 |

### jiufeng-team 人审门禁模式支持（2026-08-17 评估+补齐）

| jiufeng-team 机制 | 引擎支持 | 展示层呈现 |
|---|---|---|
| 双线审查（通过线/返工线） | ✅ review→merged（通过）/ review→running（返工，新边） | lane 卡显示 review 轮次与结果 |
| HATL 返工门禁（同一子模块 3 次打回→Leader 指挥方向） | ✅ 返工边 + attempt 从事件推导（review→running 计数） | attempt x/3 徽标；≥3 高亮「升级人工/Leader 指挥」 |
| 全额通过自动放行 | ✅ batchAutoReleaseable（全 merged 且无 conflict/failed）；预设规则自动 batch_phase complete | 批次卡「可自动放行」徽标 |
| HITL 最终验收（显式） | ✅ 保留显式（batch_phase complete 由 Leader/人触发，P2 显式控制） | 终态批次「已完结」+ 完成时间 |

> 展示推导规则：attempt = events 中该 lane 的 review→running 次数（不改存储结构）；升级标记 = attempt ≥ 3 且当前 review/failed。
### 批次/详情中「人机交互重要内容」（按优先级）
| 优先级 | 内容 | 人机价值 |
|---|---|---|
| P0 | **review 状态的 lane**（待人工裁决） | 人审门禁点（P2 显式控制）：需要人拍板 merged/conflict |
| P0 | **异常 lane**（failed/skipped/conflict） | 需人介入处理/重派 |
| P1 | **批次进度**（running/merged 计数、当前 wave） | 一眼看清集群状态 |
| P1 | **批次终态**（complete/aborted 与时间） | 交付确认 |
| P2 | **事件时间线**（member.settled/batch.phase/system.recovered） | 审计与恢复追踪 |
| P2 | **wavePlan 结构**（wave 分层、任务依赖） | 理解执行顺序 |

> 补充：stalled/超时未结算（用户已要求补死成员/超时检测）在详情中高亮为「需关注」；complete/aborted 终态批次在面板显示为「已完结」（面板层语义，不改引擎 batchSettled）。

---
## 三·五、分页机制确认（2026-08-17 源码实证）

- Web 壳层 tab 栏（对话/轨迹）由 `dsh-client-ui-conversation` 渲染：`views.list()` 遍历 **`conversation.view` 槽位** → 每个注册项渲染一个 `<button role=tab>`；激活视图写入 store `s.view`；视图内容经 `renderSlot("conversation.view", {id})` 渲染。
- 轨迹分页即模板：`ctx.slots.inject("conversation.view", () => ctx.slots.register({ name: "conversation.view", id: "trajectory", order: 10, locale: NS, label: () => t("view.trajectory"), inject: (sessionId) => ({...}), render }, TrajectoryView))`。
- **第三分页「集群工作台」= 注册 `conversation.view` 槽位（id: "cluster", order: 20, label: t("view.cluster")="集群工作台"）**，render 为工作台 React 组件（fetch `/api/dsh-punky-swarm/*` 只读展示）。
- 客户端包格式：CJS bundle（`module.exports = { apply, inject }`），依赖 `@deepseek-ai/dsh-client-{locale,runtime,ui-slots}` 等（trajectory 同构）。
- 已落地 P6a：host 只读 API 4 端点（batches/batch/mailbox/locks），35/35 测试通过。

---
## 四、技术方案

### 4.1 host 侧（dsh-punky-swarm 插件扩展）
```
新增 API（复用 mneme createApi 模式，只读优先）：
  GET /api/dsh-punky-swarm/batches           批次列表（id/phase/lanes 摘要）
  GET /api/dsh-punky-swarm/batch/:id         单批次（wavePlan/lanes/events 摘要/锁）
  GET /api/dsh-punky-swarm/mailbox/:id?box=  收件箱未读（inbox/outbox/broadcast）
  GET /api/dsh-punky-swarm/locks             .locks 扫描（batchId.lane -> 持有者 pid/ts）
刷新：轮询 3-5s（MVP）→ SSE（V3）
```
### 4.2 client 侧（client bundle）
```
package.json dsh: { client: { inject: [...], platform: 'web' }, bundle: { patch: './cordis.patch.yml' } }
client/sidebar-entry.ts    侧边栏「集群工作台」入口（仿 task-board）
client/workbench-mount.tsx 面板挂载（批次列表 → 详情 → 泳道 → 收件箱）
泳道渲染：CSS/SVG 仿 git-graph（wave 横排、任务节点纵向连线）
```
### 4.3 原则
- 面板**只读投影**：状态文件是唯一事实源，操作（batch_phase/member_settle 等）仍由 agent/预设执行，面板提供操作指引而非直接改。
- 数据不缓存于前端：每次轮询读 host API（host 读状态文件）。

## 五、功能分级

| 级 | 内容 |
|---|---|
| MVP | 批次列表 + 单批次详情（phase/lanes 状态卡/事件时间线）+ 3-5s 轮询 |
| V2 | wave 泳道 DAG + mailbox 收件箱 + 锁标记 + 恢复提示（system.recovered 高亮） |
| V3 | SSE 实时 + 独立工作台页（选项 B）+ 批次导出（JSON） |

## 五·五、实施进度（2026-08-17）

| 项 | 状态 |
|---|---|
| P6a host 只读 API（4 端点 + laneAttempts/upgrades/autoReleaseable/viewSettled 扩展） | ✅ 40/40 测试 |
| P6b 客户端第三分页（conversation.view 槽位 id=cluster + 批次列表/详情 + 只读收件箱 + 3s 轮询） | ✅ 已写 lib/client.js + dsh.client 配置，待 web 重启加载验证 |
| 可见性边界 | ✅ 已定稿（批次核心展示 / mailbox 只读 / 锁不展示 / 面板只读） |
| jiufeng 门禁模式（返工边/自动放行/attempt） | ✅ 引擎 40/40 + 展示字段齐备 |
| **P6d v2：批次绑定 session**（2026-08-18） | ✅ 存储 `root/sessions/<sessionId>/{batches,mailbox,.locks}`；工具 `sessionOf = args.session ?? exec.agent.session.id ?? 'cli'`；API/client 按 session 过滤（新增 /sessions 端点）；存量迁移到 `sessions/legacy/`；46/46 测试全绿 |
| **P6e：蟛蜞模式专属工作台**（2026-08-18） | ✅ tab 中文名「蟛蜞集群」/ 英文名「Punky swarm」；inject 回调读 `session.header.agentPreset`，不绑定 agentPreset：只要 dsh-punky-swarm 引擎在线即渲染（2026-08-19 决策——agentPreset 门控过严且 header 值不可靠，移除）。tab 为全局注册，面板按当前会话展示该会话批次（与轨迹面板同语义） |

## 六、实施阶段（P6）

1. P6a：host API（4 端点只读）+ 单测（node:test 用临时 root 直测）。
2. P6b：client bundle MVP（批次列表 + 详情 + 轮询），web profile 挂载实测。
3. P6c：wave 泳道 + 收件箱 + 锁标记（V2）。
4. 可选：独立工作台页 + SSE（V3）。

## 七、参考

- openJiuwen-ai/jiuwenswarm README（Swarmflow /swarmflows 运行树）与 DistributedTeam（TeamMonitor）。
- dsh-web-ui：dsh-client-ui-git-graph（DAG 泳道）、dsh-client-ui-task-board（看板/侧边栏）。
- dsh-mneme（host API + client 面板双端模式，已实装）。
