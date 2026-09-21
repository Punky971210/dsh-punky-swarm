/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// lib/state/event-types.js —— 批次事件 type 常量单点：newEvent 调用与事件推导一律引用本模块常量，禁止裸字面量。
// 零依赖纯常量模块：不 import 任何本包模块（避免循环依赖）。
// 事实源 = store.js newEvent 工厂调用点（原裸字面量）——
//   resume/archive/lane-heartbeat/lane-tools/mailbox-tools/merge-agent/core 的写事件
//   （system.restored/archive.done/lane.stalled/lane.over-budget/worktree.*/budget.rejected/gate.role_*）
//   全部改引常量；读端（gates/store/resume/log-tools/lane-tools 的 e.type 比较）同步收敛。
// 纪律：新增事件类型须在本文件登记常量后于调用点引用，禁止散布裸字面量。

// 批次生命周期
export const EVT_BATCH_CREATED = 'batch.created';
// 【M0′-②（2026-09-17 批 `handoff-consolidation-m0m1-20260917`）载荷键纪律 + `reason` 词表】
//   载荷 = `{ from, to, reason? }`：`reason` 是**相位迁移事由**，`batch.phase` 是审计面「为何不推进」的
//   唯一跨会话可核事实源（读端 = `lib/tools/log-tools.js` 的 markdown 时间线渲染 `<from> -> <to> | <reason>`）。
//   形态 = `<source>` 或 `<source>:<detail>`，取值族（**暂停类必须带 source 前缀**，禁裸文案）：
//     · `chain:<分支>`        推进链停轮（写点 `lib/engine/chain-runner.js` 的 `pauseBatch`，与 `out.reason` 同源）
//     · `auto-settle:<判据码>` 自动结算停轮（写点 `lib/engine/auto-settle.js` 的 `pauseForFail`）
//     · `manual:batch_phase[:<phase>]` 工具面显式迁移（写点 `lib/tools/core.js` 的 `batch_phase`；调用方可传 `reason` 覆盖）
//     · `manual:batch_control.<action>` 人工干预面（写点 `lib/tools/core.js` 的 `batch_control`：pause/resume/abort）
//     · `failed-escalate` / `governance-escalate` 存量两源（写点 `lib/state/store.js` 的 `escalatePausedWrite`，**本批不动**）
//   键纪律（**非空才写键**）：`reason` 为空/空白 ⇒ **不写该键**，保持既有 `{from,to}` 形态零污染。
export const EVT_BATCH_PHASE = 'batch.phase';
export const EVT_BATCH_FAILED_ESCALATE = 'batch.failed-escalate';
// 悬挂成员告警（GAP-S3b，2026-09-16 用户裁决 = **折中方案**）：批次被 `batch_phase({phase:'aborted'})`
//   收口时若仍存在**非终态成员**（`lib/schema.js` 的 `isMemberTerminal` 判据；lane 级判定复用单点
//   `lib/watch/lane-heartbeat.js` 的 `isDanglingLane`，不另立一套口径）⇒ **额外落一条本事件**。
//   **不自动改成员状态**（不做隐式批量 `skipped`）：那些成员在终态批上永久无法回收（`member_settle`
//   被拒 `GATE_BATCH_TERMINAL`），`batch_status.danglingLanes` 会永久显示它们 ⇒ 本事件是该事实的
//   **告警留痕**（写端：`lib/tools/core.js` 的 `batch_phase`；读端：`batch_status` / `log_export` 事件清单）。
//   载荷：`{ danglingLanes: [laneId...], count }`（载荷键纪律同 `EVT_BATCH_TEAM_ASSET_RESOLVED`：不得占用 `type` 键）。
//   **反例锁**：无悬挂成员（全终态）的批 abort **不落**本事件；`running` / `paused` / `complete` 三相位零差异。
export const EVT_BATCH_ABORT_DANGLING = 'batch.abort_dangling';
// Manager 拉起登记：C+ 批由 Leader 拉起 Manager（引擎层角色，不占 lane、不落 lanes）时登记本事件 +
// 批次级 `manager` 字段，使「Manager 是否真被拉起」成为治理层**可核事实**（事件流可查），
// 而非仅靠 manager-notes 一类自述旁证。载荷 { agentId, note? }。
export const EVT_BATCH_MANAGER_RAISED = 'batch.manager.raised';
// 团队资产解析快照落盘（批次 `a3-snapshot-b1-20260915` · §8③）：**建批事务内**与批次字段
//   `batch.teamAsset` 同一次 atomicWrite 落盘（档先于批次落盘）——使「这一批按哪份声明冻结」可核。
//   载荷（调用点 = `lib/state/store.js` 的 `createBatch`；构建单点 = `lib/assembly/snapshot.js`）：
//     { team, root, rootKind, assetPath, assetHash, ok, severity, snapshotPath, problems[], unwiredKeys[],
//       snapshotWriteFailed?: true }
//   载荷键纪律：`type` 键承载**事件名**，载荷**不得**占用它（故严重级写 `severity`、问题串写 `problems`）；
//   无资产批（无 hash 不可命名）**不落本事件**（只写 `ok:false` 字段）——保「缺省零差异」。
export const EVT_BATCH_TEAM_ASSET_RESOLVED = 'batch.team-asset.resolved';
// gate-lite Q-G1（2026-09-17 用户裁决「开显式豁免键」）：**冒烟/探针批豁免**建批留痕。
//   语义：`wave_plan({ smoke: true })` ⇒ 本批声明为冒烟/探针批 ⇒ **跳过产物契约类门**
//   （建批 `GATE_PLAN_PRESENCE_MISSING` / `GATE_ORPHAN_PRODUCT`；运行期 entry `consume`、exit
//   `produce`∪`outputs`、`targets`、complete 的 plan 悬空产物判定）；
//   **行为安全门一字不减**：派发准入（难度档 + lane 存在性 + Manager 拉起登记）、lane 单写者锁、
//   终态冻结（`GATE_BATCH_TERMINAL`）、`needHuman` 人工闸、命令门、验收（audit/complete）判据。
//   写端：`lib/tools/core.js` 的 `wave_plan`（`createBatch` 之后同一次调用内 `appendEvent`）；
//   读端：`lib/state/gates.ts` 的 `smokeOf(batch)`（门禁判据单点）+ `batch_status.smoke`（回显，
//   使「本批是 smoke」在工具面可见，不是隐性放行）+ `log_export` 的 `batch.` 前缀事件清单。
//   载荷：`{ batchId }`（载荷键纪律：`type` 键承载事件名，载荷不得占用）。
export const EVT_BATCH_SMOKE = 'batch.smoke';
export const EVT_ARCHIVE_FAILED = 'archive.failed';
export const EVT_ARCHIVE_DONE = 'archive.done';
export const EVT_SYSTEM_RECOVERED = 'system.recovered';
export const EVT_SYSTEM_RESTORED = 'system.restored';

// 成员迁移
export const EVT_MEMBER_SETTLED = 'member.settled';
// 派发登记事件：装配层 post-execute 观察 Manager 派发工具 → 写侧登记（member.dispatch，
// 见 bridge/dispatch-register.js）；读侧（trajectory.js 原本地字面量）同步收敛为本常量。
export const EVT_MEMBER_DISPATCH = 'member.dispatch';
export const EVT_LANE_SKIPPED = 'lane.skipped';
export const EVT_LANE_NEEDHUMAN = 'lane.needhuman';
export const EVT_LANE_RECYCLED = 'lane.recycled';
export const EVT_HUMAN_DECISION = 'human.decision';
export const EVT_ASSET_CLAIMED = 'asset.claimed';

// 监控/预算/进度事件
export const EVT_LANE_STALLED = 'lane.stalled';
// longrun 档：lane 超时重派探针候选事件——running 持续超 maxDurationMs 且
// 近 noProgressWindowMs 无新 checkpoint 且无活动（严格 AND）→ 探针产候选（事件 + mailbox broadcast 通知 Manager 裁决）。
// 与 lane.stalled 语义区分：stalled=连续 N 拍无活动（失联/假死档）；longrun=时长超阈值+无进展（任务过重/停滞档）。
// 纪律同 stalled：只写事件流不改 lane 状态（schema.js MEMBER_STATES/TRANSITIONS 零改动）。
export const EVT_LANE_LONGRUN_CANDIDATE = 'lane.longrun.candidate';
// longrun 档：候选消费超时事件——候选已投递（broadcast + supervisor/inbox 双通道）但
// 超过 unconsumedTimeoutMs 仍无任何消费方 ack（判据 = mailbox.isAcked(broadcast, 候选.ackId)；
// **不得**用 readUnacked——ack 默认删原消息文件，会把「已消费」读成「不存在」→ 永久误报）→ 产本事件。
// 单次纪律：以 (lane, runningSince) 为去重键（同 hasLongrunCandidate 同构，跨重启幂等）；
//   载荷 { lane, runningSince, durationMs, emittedAt, elapsedMs, unconsumedTimeoutMs, ackId }。
// 纪律同 stalled/longrun：只写事件流，不改成员状态、不自动重派（重派裁决归 Manager/Leader）。
export const EVT_LANE_LONGRUN_UNCONSUMED = 'lane.longrun.unconsumed';
// C+ 批收口告警（**非阻断**）：exec 层 lane ≥3 的批次在 `complete` 时**未登记** `batch.manager`
// （Leader 未按协议拉起 Manager 或未登记）→ 产本事件留痕。取告警而非硬门禁的理由：历史批次无该字段，
// 硬校验会追溯性拦批；本事件使「C+ 强制是否落实」在事件流中可核（读端：batch_status / log_export）。
export const EVT_GATE_MANAGER_MISSING = 'gate.manager_missing';
// gate-lite 第二批 · A2（2026-09-17 用户裁决「全删 + 改造为官方 roster 承抽」）：**Manager 在册缺口**留痕。
//   语义：引擎按 `assembly.managerPlan` 声明核验 **官方 Team roster**（`ctx.get('agentTeams')` →
//   `listMembers(agent)`）中是否存在约定名成员 `manager`；声明 `raise` 而 **roster 可读且确无该成员** ⇒ 落本事件。
//   与 `gate.manager_missing`（批次收口告警，按 `batch.manager` **字段**触发）分工：
//   · 本事件判据 = **roster 事实**（新口径，官方为真源）；后者 = 批次字段（legacy 观察面，历史批可读）；
//   · 只在 **roster 可读**时发射（服务不可用 = 非官方宿主**基线态** ⇒ 不落批次事件，避免把环境事实
//     写成本批事实；该态由 `wave_plan.managerRoster.reason` / `batch_status.managerRoster.reason`
//     **回显**承担可读性，不静默）；
//   · 载荷：`{ managerPlan, rosterName, memberCount }`（`type` 键承载事件名，载荷不得占用）。
export const EVT_GATE_MANAGER_ROSTER_GAP = 'gate.manager_roster_gap';
// longrun 长程豁免（批次级 laneExempt 字段的审计事件）——授予/撤销均只在「派发面」
// （pending→running / idle→running）与成员迁移**同一次 atomicWrite** 落盘：
//   granted：{ lane, from, to:'running', exemptType, multiplier, tierMultiplier, stalled, grantedFrom }
//   revoked：{ lane, exemptType, multiplier, at, grantedAt }（撤销为独立显式调用，不改成员状态）
// 载荷键纪律：`newEvent(type, fields)` 的 `type` 键承载**事件名**（本文件常量），载荷字段**不得**占用它——
//   引擎多处按 `e.type` 读事件名（log_export 的 `e.type.startsWith('gate.')` 过滤、面板 label、
//   batch_status 事件清单），占用会让该事件在过滤/呈现层失名；故豁免类型一律写 `exemptType`。
// 与 lane.stalled/longrun 同纪律：只写事件流，不新增成员态（schema.js MEMBER_STATES/TRANSITIONS 零改动）。
export const EVT_LANE_EXEMPT_GRANTED = 'lane.exempt.granted';
export const EVT_LANE_EXEMPT_REVOKED = 'lane.exempt.revoked';
// longrun 豁免的**继承/清退**两种次生留痕（批次 `gate-techdebt` · D7）：**单点化迁入本文件**
// （设计 §5.1「迁入」项；原文案寄居 `lib/state/store.js:46-51`，理由为「该文件在本批 writeForbidden 内」，
//  该理由随 e1 写域含本文件而失效）。字面值**逐字不变**（`lib/watch/lane-heartbeat.js` 的
//  `exemptClearedAtOf` 按同一字面量反查 ⇒ 改值即静默断链，属红线）。
// `lib/state/store.js` **保留再导出**（`export const EVT_LANE_EXEMPT_* = EVT.EVT_LANE_EXEMPT_*`）
//  以免破坏既有导入面（R-32 断言其再导出值逐字仍在）。
export const EVT_LANE_EXEMPT_INHERITED = 'lane.exempt.inherited';
export const EVT_LANE_EXEMPT_CLEARED = 'lane.exempt.cleared';
export const EVT_LANE_OVER_BUDGET = 'lane.over-budget';
export const EVT_BUDGET_REJECTED = 'budget.rejected';
// ── worktree 与门禁事件（**注释订正**：B3 盲审项，2026-09-15）──────────────────────────────
// 【订正留痕】本段原注释称「本组 9 枚经复核核实为**预留未接线**：lib 内无写端也无读端，仅常量行本身存在；
//   真正有写端的是 worktree.checkpoint / gate.exit / gate.exit_blocked / gate.entry.missing」——
//   **该说法与代码相反**（实测：9 枚**全有写端**；其中 5 枚 worktree.* 另有专用读端，4 枚 gate.* 的专用读端未接线）。
//   本次按**读/写端 grep 矩阵实测**重写，逐枚标写端/读端证据（取证命令与命中见 exec/e4/outputs/fix-e4.md）。
// 实测写端（命令：`Select-String -Path (gci -Recurse lib -Include *.js,*.ts) -Pattern 'EVT_WORKTREE_|\|EVT_GATE_'`）：
//   worktree.created        ← lib/tools/lane-tools.js:265（appendEvent）
//   worktree.checkpoint     ← lib/tools/lane-tools.js:325（appendEvent）
//   worktree.merged         ← lib/tools/lane-tools.js:428（appendEvent）
//   worktree.merge.conflict ← lib/bridge/merge-agent.js:88（appendEvent）
//   worktree.merge.resolved ← lib/bridge/merge-agent.js:122（appendEvent）
//   gate.passed             ← lib/state/store.js:623（newEvent）
//   gate.exit.missing       ← lib/state/store.js:618（newEvent）
//   gate.target_blocked     ← lib/state/store.js:632（newEvent）
//   gate.target.passed      ← lib/state/store.js:638（newEvent）
// 实测读端（命令：同上，检索常量名或 `e.type ===` 比较点）：
//   worktree.checkpoint     → lib/tools/lane-tools.js:380（按 lane 过滤）、lib/watch/lane-heartbeat.js:215（checkpoint 新鲜度）
//   gate.passed / gate.exit.missing / gate.target_blocked / gate.target.passed → 专用读端**未接线**（写端已在，读侧缺口）
//   泛化读端（对以上全部自动生效）：lib/tools/log-tools.js:55/116（`e.type.startsWith('gate.')` / `'worktree.'`）
//   与 batch_status 事件清单 ⇒ 事件**能进导出与视图**，缺的是「按 kind 归并判定」的专用消费者。
// 【真缺口，逐枚——与本段 9 枚**不同**的一组】`gate.escape` / `gate.degrade` / `gate.contract_missing`
//   均**有写端**：escape/degrade 由 `store.setMember` 统一写盘点落盘（store.js:743-751，经 gatePayloads
//   收集点 store.js:583/607/615/629/644/667）；contract_missing 由 `makeContractMissingSink`
//   落盘（store.js:256-270，挂 store.js:584/608/616/630/645/668/800）。缺的是**专用读端**：
//   · gate.escape / gate.degrade —— `gateStrength.escapes/degrades` 汇总位**已存在**（lib/state/gates.ts:1095-1096
//     ；构建产物 lib/state/gates.js:1208-1209，返回面 :1228-1229）但**无专用消费方**（读侧未接线）；
//   · gate.contract_missing —— 无「按 (gateKind, layer) 归并」的专用读端；唯一类型化读点是
//     lib/state/store.js:130 的**写路径去重**（幂等判据，非消费读端）。
//   三枚均只被泛化读端（log_export 的 `startsWith('gate.')` / `batch_status` 事件清单）覆盖。
//   接线（targets 通过与失败、worktree 生命周期专用读端、escape/degrade/contract_missing 消费方）归后续批。
export const EVT_WORKTREE_CREATED = 'worktree.created';
export const EVT_WORKTREE_CHECKPOINT = 'worktree.checkpoint';
export const EVT_WORKTREE_MERGED = 'worktree.merged';
export const EVT_WORKTREE_MERGE_CONFLICT = 'worktree.merge.conflict';
export const EVT_WORKTREE_MERGE_RESOLVED = 'worktree.merge.resolved';

// 门禁事件（Tier3）
export const EVT_GATE_ENTRY_MISSING = 'gate.entry.missing';
export const EVT_GATE_EXIT_MISSING = 'gate.exit.missing';
export const EVT_GATE_PASSED = 'gate.passed';
export const EVT_GATE_TARGET_BLOCKED = 'gate.target_blocked';
export const EVT_GATE_TARGET_PASSED = 'gate.target.passed';

// ── P1 交接门事件（handoff gate；批次 p1-handoff-gate-20260917）────────────────────────────
// 定式（`docs/p1-handoff-gate-changeplan-20260917.md` §2）：**读端真源 = `batch.handoffs`**（不做事件流重建），
//   本两条是**审计面 + 缺口可读面**（事件不参与判定，判定只读 `batch.handoffs`）。
// · `lane.handoff`（审计真源）：**每次交接提交一条**。写端 = `lib/state/store.js#recordHandoff`
//   （唯一写路径内，与 `batch.handoffs` 同一次 atomicWrite ⇒ 「交了」与「记了」不可分叉）。
//   载荷：`{ lane, from, to, artifacts[], assertions[], handoffBatch }`——载荷键纪律：`type` 槽位承载**事件名**，
//   故批 id 写 `handoffBatch`（不得占用 `type`；引擎多处按 `e.type` 读事件名，占用即失名）。
// · `lane.handoff.gap`（缺口留痕）：**拒下游时落**（`code:'GATE_HANDOFF_MISSING'` + `missing[]`：缺哪条边 / 缺哪件产物），
//   以及**存量批放行时落**（`legacy:true`，裁决 ①=B：不静默、不砸存量）。
//   写端 = `lib/tools/core.js` 的两个交接工具面（拒态留痕）与 entry 门放行侧的存量留痕调用点。
export const EVT_LANE_HANDOFF = 'lane.handoff';
export const EVT_LANE_HANDOFF_GAP = 'lane.handoff.gap';

// ── 派发套件事件（2026-09-15 用户裁决：集群内部同步事件走套件工具；写端/读端见括号） ──
//   swarm.report       ← 成员侧套件工具 `swarm_report`（写端：lib/tools/core.js；读端：Leader mailbox inbox）
//   swarm.cc           ← 成员侧套件工具 `swarm_cc`（写端：同上；读端：Manager 通道 supervisor/inbox）
//   lane.binding_gap   ← 心跳探测（写端：lib/watch/lane-heartbeat.js；读端：Leader mailbox inbox + batch_status 事件清单）
export const EVT_SWARM_REPORT = 'swarm.report';
export const EVT_SWARM_CC = 'swarm.cc';
export const EVT_LANE_BINDING_GAP = 'lane.binding_gap';
export const EVT_GATE_EXIT_BLOCKED = 'gate.exit_blocked';
export const EVT_GATE_EXIT = 'gate.exit';
export const EVT_GATE_NEEDHUMAN_BLOCKED = 'gate.needhuman_blocked';
export const EVT_GATE_COMPLETE_BLOCKED = 'gate.complete_blocked';
// 【2026-09-18 · Q-B 取消并发闸 —— 本常量为**冻结兼容读**（写点已删，常量保留）】
// 上游裁决：`docs/engine-design-adjudication-20260918.md:182`（`concurrency` 不再作运行期准入判定，
//   高并发不得被限流）。
//   · **写点已删除**：唯一写端原为 `lib/engine/dispatch.js` 的并发闸执行点（判据 → 拒态留痕 → 抛），随闸整体
//     移除 ⇒ 新批**不可能**再产生本事件（`lib/engine/dispatch.js` 的「取消并发闸 · 退役登记」段）。
//   · **保留理由**：历史批磁盘事件流**真实存在**本事件（27 批中 5 批计数非 0，见
//     `docs/engine-design-adjudication-20260918.md:93`）⇒ 删常量会让历史事件面**无法按名取**
//     （`log_export` 的 `gate.*` 过滤 / `batch_status` 事件清单 / 事后审计取证）。
//   · 原载荷契约（**历史数据留档**，逐字）：`{ lane, code:'GATE_CONCURRENCY_EXCEEDED', occupied, limit,
//     limitSource, occupiedLanes[], candidateLanes[] }`。
// 读端（不变）：`log_export` 的 `e.type.startsWith('gate.')` 过滤 + `batch_status` 事件清单（自动生效）。
export const EVT_GATE_CONCURRENCY_BLOCKED = 'gate.concurrency_blocked';
export const EVT_GATE_ROLE_MISSING = 'gate.role_missing';
export const EVT_GATE_ROLE_INVALID = 'gate.role_invalid';
// 建批期告警**按码专用化**（GAP-S9）：`GATE_COMPLETE_OUTCOMES_EMPTY`（audit_contract.verdict 与 complete
//   白名单 {pass,skip} 交集为空）此前落在**共享 catch-all** 事件 `gate.role_invalid` 上 ⇒ 审计按事件 type
//   归类时会把它误读成「role 非法」（载荷 `code` 正确、事件 type 误导）。
// 写端：`lib/tools/core.js` 的 `wave_plan` 告警事件化**按码映射表**（`WARN_EVENT_OF`）。
// 读端：`log_export` 的 `e.type.startsWith('gate.')` 过滤 + `batch_status` 事件清单（自动生效）。
// **残留（GAP-S9）**：映射表未命中的告警码（如 `GATE_AUDIT_CONTRACT_EXEMPT` / `GATE_SKILL_MISSING`）
//   **保持现状 = `gate.role_invalid`**（向后兼容：不迁移既有事件 type，避免既有断言与外部消费者漂移）；
//   未来把每个告警码都映射到专用类型属后续批，本任务不做。
export const EVT_GATE_COMPLETE_OUTCOMES_EMPTY = 'gate.complete_outcomes_empty';

// B2（蓝图 §8⑤ 运行期**首触校验**，批 `core-debt-parallel-20260915` · lane e1）：团队资产**未声明**某检查项
//   ⇒ 引擎缺省接管时**首次触发**落本事件 + 一次告警（`logger.warn`，与事件同源一次）。
// 口径（规格 §1.1 R-1..R-6，逐条）：
//   · **非拒态**：**不新增 `GateErrorCode`**、不改任何判定、不改任何 exit code——本常量是**事件码**，不是 GATE 码；
//   · 去重键 = `(batchId, gateKind, layer)`（**不含 lane**）⇒「**只报一次/批**」；
//   · **跨重启幂等**：判据 = 批次 JSON 的 `batch.events` 已存同键事件 ⇒ 不再发（与 `EVT_LANE_LONGRUN_UNCONSUMED` 同法）；
//   · **只由写路径发射**：门禁函数只**产载荷**；落盘唯一在 `lib/state/store.js` 的 `setMember` / `setPhase`
//     ⇒ 只读视图（`gate_status` / `batch_status` 等）**零事件**（R-5 硬边界；注意 `gateStatus` 内含
//     `checkPlanContract` 调用，故该边界必须由「只产载荷」结构性保证，而非调用点自觉）；
//   · **不做读法 B 的迁移面子面**（Q-7 已裁不纳入）⇒ 载荷内不得出现 `state_machine.overrides` 任何字段。
// 载荷契约（`BatchEvent` 判别分支同形，见 `lib/types/contracts.ts`）：
//   { cause:'undeclared'|'declared-off'|'unresolvable', gateKind, layer, lane, declared, source,
//     degrade:{kind,note}, problems:[] }；本批**只产 `cause:'undeclared'`**（清退 legacy 后转 `declared-off` 的枚举预留）。
// gateKind 六值（判定位逐一见 `lib/state/gates.ts`）：entry_requires / contract / needhuman / gate_command / targets / complete。
// 读端：`log_export` 按 `e.type.startsWith('gate.')` 过滤 ⇒ 本事件自动进导出（无需改白名单）。
export const EVT_GATE_CONTRACT_MISSING = 'gate.contract_missing';

// 治理违规计数：EVT_GOVERNANCE_REFUSAL 为可计入事件（recordGovernanceRefusal 追加、
// countGovernanceRefusals 纯函数读端）；EVT_BATCH_GOVERNANCE_ESCALATE 为升级事件
// （计数达阈值经棘轮后批 paused）。
// 登记纪律：先登记常量后于调用点引用（见本文件头注释）。
export const EVT_GOVERNANCE_REFUSAL = 'governance.refusal';
export const EVT_BATCH_GOVERNANCE_ESCALATE = 'batch.governance-escalate';

// 零静默逃生/降级留痕（批次 `gate-techdebt` · V-4 事件面接线）：**读端原有字面量**单点化。
// 载荷契约（e1 产载荷 / e2 在 store.js 写盘点落盘）：
//   gate.escape  ← gates.ts 的 `escape{kind,lane,reason?}` / `escapes[{kind,artifact?,reason?}]`
//   gate.degrade ← gates.ts 的 `degrades[{kind,…}]`（如 'produce-field-widened'）
// 读端：gates.ts `gateStrength.escapes/degrades` 汇总 ＋ log_export 的 `type.startsWith('gate.')` 过滤。
// **未登记 `lane.governance-degrade`**：G-a（governance-escalate 粒度）经裁决**不实施**（维持现状）
//   ⇒ 该事件在本批**无消费者**，按「不添加未被要求的灵活性」不预留常量（若将来实施，先登记常量再接调用点）。
export const EVT_GATE_ESCAPE = 'gate.escape';
export const EVT_GATE_DEGRADE = 'gate.degrade';
// 【退役登记（N2 第一批 C1 判读，docs/c1-wiring-audit-2026-09-22.md）】chain 自动推进已退役（Q-A=C，单通道）
//   ⇒ `chain.step` 事件无生产写端；常量**冻结保留**（历史批磁盘事件读端不变），勿引用其可达性。
export const EVT_CHAIN_STEP = 'chain.step';

// P3a 自动结算（规格 §2/§3/§4）：**引擎自动**判定 lane 交付 ⇒ 全绿自动 `merged`，任一不满足 ⇒ 停轮。
// 三事件分工（写端 = `lib/engine/auto-settle.js`；读端 = `log_export` 事件清单 + `batch_status` recentEvents）：
//   · `auto.settle.triggered`：**触发留痕**（主路 `subagent/end` 或兼底路 `settle-request`）。
//     载荷 `{ lane, trigger, settleId, workerSessionId, stopReason, settleable, from }`——
//     `settleId` 即幂等键第三元（**子会话 durable id**，非 `runId`：契约卡 #11 每 epoch 新 runId）；
//     `settleable:false` 用于「非 `completed` 的 `stopReason`」——**留痕但不结算**（不静默丢、不谎报成功）。
//   · `auto.settle.paused`：**停轮留痕**（缺省 `onFail=pause`）——载荷 `{ lane, action, reason, code, … }`，
//     与「批 `running→paused`」是**同一次停轮的两面**：本事件先落（原因），`batch.phase` 后落（结果）。
//     停轮**不写 failed、不 abort、不改成员状态**（沿用 P2 既有停轮口径，不新造语义）。
//   · `auto.settle.skipped`：**幂等/资格留痕**——`already-settled`（同 (lane, settleId) 已结算，第二路 no-op）
//     或 `lane-terminal`（触发资格：命中 lane 须非终态）。存在的意义 = 「第二路被跳过」**可审计**，
//     而不是静默丢弃（与「零静默」纪律一致；同时是幂等自证：跨重启重放不再逐次追加事件）。
// 载荷键纪律：同既有约定，`type` 键承载事件名，载荷不得占用（豁免类型故写 `exemptType` 之先例）。
export const EVT_AUTO_SETTLE_TRIGGERED = 'auto.settle.triggered';
export const EVT_AUTO_SETTLE_PAUSED = 'auto.settle.paused';
export const EVT_AUTO_SETTLE_SKIPPED = 'auto.settle.skipped';

// N1-R4-1b（K1 公共池）：**出池留痕**——派发（唯一出池动作）把 `owner` 写进任务声明面时落一条。
//   载荷 `{ lane, owner, from }`：出池**是谁**、从哪个成员态派发，可供审计重放「池 → 已派发」的时间点。
//   语义边界：**非改派**——已出池任务再派发时不覆盖 owner（K1：已派发即冻结；换人 = 作废 + 池内新增替代 + gap-list）。
//   写端 = `store.setMember`（派发面唯一写盘点，与迁移同一次 atomicWrite）；读端 = 事件面（无门禁消费）。
export const EVT_TASK_OWNER_ASSIGNED = 'task.owner.assigned';

// N1-R4-1c：**图变更留痕**（池内追加任务）。载荷 `{ added:[taskId…], reason, author, revision }`。
//   与 `task.owner.assigned` 分工：后者记「出池（谁领了）」，本条记「入池（谁加的、为什么加）」。
//   写端 = `store.addPoolTasks`（单次 atomicWrite）；**不接回状态机**（不改成员态、不新增迁移）。
export const EVT_PLAN_MUTATED = 'plan.mutated';
