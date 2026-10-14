# dispatch 一次性执行器化 · 修改方案（2026-09-21 23:5x，待对接）

**裁定来源（用户，2026-09-21 23:47）**：把 dispatch 派发**彻底改为一次性执行器语义**，与 continuous subagent **彻底功能分离**。
**上游**：`docs/dispatch-parent-session-loss-rca-2026-09-21.md`（§5 已定性：spawn=无状态执行器本义；本方案把该语义**从"后端恰好如此"升格为"引擎契约"**）。

---

## §0 语义分界（本方案的"彻底分离"定义）

| 能力 | **dispatch（一次性执行器）** | **continuous subagent（归宿 = teammate runner，B5）** |
|---|---|---|
| 会话生命周期 | 单轮 run-to-completion，结束即弃 | durable 会话，跨轮次存活 |
| 上下文 | 任务包自足（五要素），**零继承**（spawn）/ 可选继承（fork，R-A 正交） | 继承 Lead 已完成轮次（fork） |
| 唤醒 / 续聊（send_message） | **禁**（无对象可唤醒） | 信箱唤醒（step 边界 / idle 唤起） |
| 断点续跑（coldResume） | **无** | 有（离线后恢复） |
| 控制（interrupt / wait） | **禁**（Leader 控制只在黑板面：回收 lane / gap-list） | wait_agent / interrupt_agent |
| 完成感知 | **宿主事件 `subagent/end`**（单向观察） | worker 主动回报 + wait |
| 登记面 | `member.dispatch` 一次（run.id） | 沿用 member.dispatch（teammate 席位） |

判据一句话：**dispatch 之后引擎与 worker 的唯一关系是"等事件"，不是"对话"。**

## §1 现状取证（改造面的依据）

引擎对 continuable API 的**全部**依赖（全库 grep，19 条命中逐条判读）：
1. `dispatch.js:286` `rt.startContinuable(spec)` —— 唯一调用点；用途仅两个：**后台跑**（不阻塞 Leader 回合）+ **拿持久会话 id** 登记；
2. **零** `steerPrompt/queuePrompt/deliverToChild/coldResume` 依赖 —— 引擎从未对 worker 做过任何续聊/续跑；
3. `dispatch-register.js:38` 的 `send_message`（0g worker 唤醒）是**唯一 continuable 专属消费** —— 直派形态里 Leader 用 send_message 唤醒已存在的 worker；
4. 心跳（`lane-heartbeat.js:989`）本就「不 interrupt、不重派」—— 观察者，无控制依赖。

⇒ **改造量比预想小**：引擎语义已经是一次性的，只是**API 选型**（startContinuable）和**唤醒残留**（send_message 登记）还是 continuous 形态。

## §2 修改面（逐文件）

### S1 · dispatch 核心换 API（`lib/engine/dispatch.js`）

- `buildStartSpec` → `buildStartRequest`：产出 one-shot 请求形态（`SubagentStartRequest = { label?, prompt, parent, signal, … }`；**`label` 字段仍在** ⇒ B3 label 机制保留；`toolFilter/persona/maxDepth` 支持面见 §5-V2 活体核）。
- `dispatchLaneCore` ④：`rt.startContinuable(spec)` → **`rt.start(provider, request)`**（`Promise<SubagentRun>`，`SubagentRun = { id: SessionId, result: Promise<SubagentResult>, … }`）—— **只 await 启动、不 await `run.result`**（fire-and-forget，保住"不阻塞 Leader 回合"）。
- `workerSessionIdOf` → 读 `run.id`（SessionId）；`childId/subagentId` 回落防御保留但降级为告警。
- 失败面：`mapSpawnError` 不变；回滚 `failed` / 句柄作废路径不变。
- **result 兜底**：`run.result` 挂 `.catch()` 落 `logger.warn`（一次性 run 失败不许静默崩溃进程），但**不进黑板判定**（结算仍走门禁）。

### S2 · 唤醒退役 + deny 收口

- `dispatch-register.js`：`DEFAULT_DISPATCH_TOOLS` **移除 `send_message`**（一次性 worker 无可唤醒对象；保留 `subagent/subagent_fork` 观察不变）—— 退役登记照 `Q-B 并发闸` 格式写进文件头（禁静默删）。
- worker deny 面：`SUITE_DENY_TOOLS` 或默认 `extraDeny` **追加连续控制族** `send_message / interrupt_agent / list_agents / wait_agent`（worker 不得互唤/互断；与设计稿 T5 同向）。
- 直派形态口径更新：one-shot 下宿主工具后台形态返回 jobId（非会话 id）⇒ 登记走既有显式降级告警（已有，零改动）；文档措辞改「直派 = Leader 手动拉一次性执行器」。

### S3 ·（可选增强）完成观察桥

- 订阅宿主事件 `ctx.on('subagent/end')`（`SubagentRunEndInfo = { runId, provider, id: SessionId, … }`）：`id` 对上 dispatchIndex ⇒ 落一条**观察性事件**（如 `lane.worker_ended`，只留痕、**零判定**）。
- 结算仍走既有门禁（产物在场/交接契约）—— end 事件**不**触发自动结算（维持"事件由引擎写、结算走门禁"纪律）。
- 不做则现状等价（心跳 + 门禁已覆盖），列为独立可选项。

## §3 不改面（负空间）

- 黑板块级并发控制（`planRevision` + append-only）不变；handle 机制（发放/消费/作废）不变；门禁与结算链不变；心跳不改（本就无控制）。
- **provider 选择与 one-shot 正交**：`dispatch.provider: spawn`（零继承）或 `fork`（R-A 带记忆增强）都跑在 one-shot 语义上 —— spawn/fork 只决定 seed，不决定生命周期。
- 工具总数不变（无新增工具）⇒ 冻结数字面只剩 deny 列表变更的 `CASES`/tool-ban 普查。

## §4 continuous subagent 面归宿

durable 会话 / 信箱唤醒 / coldResume / wait_agent / interrupt_agent / fork 继承 —— **全部归 teammate runner**（agent-team 方案，设计稿 §4/B5，等 T0 探针结论单独立稿）。dispatch 与 teammate **共用黑板与门禁，不共用会话语义** —— 与既有裁定「两模式共用任务黑板、席位形态分治」完全一致。

## §5 测试与验收

1. **单测改造**：`buildStartRequest` 形态断言（label/toolFilter/persona 在位）；`workerSessionIdOf` 改读 `run.id`；`DEFAULT_DISPATCH_TOOLS` 无 `send_message`；deny 追加项断言。
2. **登记链回归**：自派成功 ⇒ `member.dispatch { lane, workerSessionId: run.id }` 一次；句柄消费时序不变（先登记后作废）。
3. **全量**：判据面 7 套件 + 全量回归；预期口径不变（4 预期红 + 环境类偶发 ⇒ 非环境类 0）。
4. **冻结面**：deny 列表变更 ⇒ tool-ban `CASES` 双向普查 + `pkg-hashes` + 基线重生成。

## §6 活体验证清单（✅ 2026-09-21 23:5x 已核，报告 = `dispatch-one-shot-verification-2026-09-21.md`）

| # | 验证点 | 结论 |
|---|---|---|
| **V-1** | one-shot 后台存续（run 生命周期是否绑 caller turn） | ✅ **不绑**（driver/宿主运行时/官方工具三层互证；官方后台模式 = jobs 包装 fire-and-forget；`exec.signal` 会随回合中止 ⇒ 引擎自持 signal 缺省正确） |
| V-2 | `toolFilter/persona/label` 的 one-shot 支持面 | ✅ 全支持（与 continuable 同一 `applyChildComposition`；label 进 descriptor ⇒ B3 存活） |
| V-3 | `run.id` 与 `subagent/end` `info.id` 对齐 | ✅ 同为子会话 id（`runId` 是观察 id，勿混用）；end 事件附带 `lastAssistantMessage` |
| V-4 | deny 生效 + 结算链全绿 | ⏸ 随 S2 批内验收 |

**S1 实现细节固化**：① 默认 = `activeRuns` Map 持引用 + `result.catch` 告警；`jobs` 包装为选配增强档（非 inject 取用、缺 service 降级）；② signal 纪律：**严禁**透传 `exec.signal`（官方 foreground/background 分叉实证）。

## §7 施工切批

| 批 | 内容 | 前置 |
|---|---|---|
| **S1** | dispatch 核心 one-shot 化（§2-S1）+ 单测 | V-1/V-2 活体核 ✅ |
| **S2** | 唤醒退役 + deny 收口 + 直派口径（§2-S2）+ 冻结面普查 | S1 |
| **S3**（可选） | `subagent/end` 观察桥（§2-S3） | S1 + V-3 |

每批独立提交；`lib/**` 改动全量回归按既定口径验收。

---


## §8 施工台账

- **S1 ✅ 已落地（2026-09-22 00:1x）**：`lib/engine/dispatch.js`（`buildStartSpec`→`buildStartRequest` 平铺形态 / `subagentRuntimeOf` 探测面 →`start` / `rt.start(provider, request)` fire-and-forget / `activeRuns` Map + `trackOneShotRun`（终态自动摘除、失败告警不进判定）/ 新增观测面 `activeRunCount()`）/ `lib/index.js` 注释同步；13 个测试文件桩与断言改造（13/13 绿）。

- **验收**：判据面受影响 13 套件全绿；全量 **1783 / 1757 pass / 22 fail / 4 todo** = 4 团队资产预期红 + 18 环境类 ⇒ **非环境类 0**（与上一基线分布逐条同构）；基线 152/1738/8426（asserts +7 / lines +15）；pkg-hashes 423。

- **批内 E2E 说明**：`dsh-agent-loop-testkit` 未随运行时安装（devDependency）⇒ 真实宿主 one-shot E2E 留待下一次活体批次（与 `suite-live` 同路径）；批内验收 = 单测全绿 + V-1/V-2/V-3 源码级核。

- S2（唤醒退役 + deny 收口）· S3（`subagent/end` 观察桥）待续。

## §9 S2 台账 + S3 作废登记（2026-09-22 00:3x）

- **S2 ✅ 已落地**：① `suite.js` 表尾追加**宿主连续控制族 4 件**（`send_message`/`interrupt_agent`/`list_agents`/`wait_agent`，memberDeny:true / modeGate:false / 宿主工具不占模式门）⇒ `SUITE_TOOLS` 32→**36**、`SUITE_DENY_TOOLS` 16→**20**（worker `toolFilter.deny` 经 `buildStartRequest` 缺省自动收口）；② `dispatch-register.js` `DEFAULT_DISPATCH_TOOLS` 移除 `send_message`（退役登记照 Q-B 格式；`extractWorkerSessionId` send_message 分支保留为纯函数防御面）；③ `lib/index.js`:537 注释同步。

- **冻结面普查**：`suite-consistency`（FROZEN_DENY 精确集 +4 / POST_LEGACY_DENY_ADDED +4 / NOT_REGISTERED_BY_DEFAULT +4）、`task-pool-r41`（36/20/12 三断言）、`dispatch-register`（R8 契约改两件；R4 改「退役透传零登记零告警」；R4b 载体迁移到 subagent 载荷无 id——T-14/G-10#3 不静默锁保留在在役路径）；受影响 8 套件 **117/117 绿**。

- **S3 ⏹ 作废登记（防重复建设）**：装配面**已存在** `installAutoSettle`（P3a 规格装配，`lib/index.js:565`）——订阅宿主 `subagent/end`（`global:true` 硬性要求）+ `info.id → dispatchIndex` 映射（V-3 的对齐在生产面早被消费）→ `autoSettleLane` 单点判定（复用 Tier3 校验链，缺省 onFail=pause）。本方案 §2-S3 的「观察桥」是其子集，**不另建第二座桥**；「`lane.worker_ended` 留痕事件」随自动结算的既有事件面（member.settled / auto.settle.*）覆盖，零缺口。

- 验收口径同 S1（4 预期红 + 环境类偶发 ⇒ 非环境类 0）。
