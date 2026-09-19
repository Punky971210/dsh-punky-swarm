# 引擎统一设计面评估稿（2026-09-18）

> **裁决面（后置）**：本稿的分类与实施序已被 Leader 逐条复核并**部分改判**——见 `docs/engine-design-adjudication-20260918.md`（T-01 降档、T-08 闭合、T-04 升为 G-T04 组首、X-11 裁决不阻断）。**以裁决稿为准**。

> **用户指令**：把四类工作（① `pair_with` 配对粒度 ② `M4→M3→M2′→M5′` ③ 引擎候选 / ④ gap-list 挂起项）**并入同一设计面**，按引擎现状重评、判重合、分类，并按 **agent-team 模式**重评。
> **本轮性质**：**只出评估与建议，不改任何代码/资产**。唯一写盘 = 本文件。
> **关键前提（用户点出，本稿贯彻）**：当前引擎的全部实施仍停留在 **subagent 模式**——引擎自派 worker 走宿主 `ctx.subagents` seam、自建 `member.*` 状态机 / mailbox / 黑板 / chain 推进；**官方 agent-team 能力面（roster、任务板、消息、长生命周期成员）尚未接进实施**（只有交接门等少数面）⇒ 每一项评估都回答「保留 / 改写 / 变多余 / 变必须」。

## §0 口径与证据纪律（读本稿前必读）

| 项 | 口径 |
|---|---|
| **行号口径** | 全部 `file:line` 取自**原始字节**（`node:fs` 读字节 → 按 `\n` 切分计数）。与 `read` 工具逐行核对**一致**（抽查 `lib/assembly/chain.js:135/691/703/802/812/849`、`lib/engine/chain-runner.js:130/153/211/260` 逐条相等）⇒ 本稿行号**非渲染视图**。`.yml/.json/.ts` 锚点同法。 |
| **旧检出禁令** | `D:\dsh\Punky-plugin\...`（陈旧构建检出）**未引用**；本稿全部路径 = `D:\dsh\Punky-plugin - new\packages\dsh-punky-swarm\`（canonical）或宿主只读面。 |
| **只读面** | 引擎包（读）、工作区 `D:\AI_Workspace\DSH\DSH\docs\**`（读）、在役 profile `C:\Users\Administrator\.dsh\profiles\web\node_modules\@deepseek-ai\dsh-experimental-{agent-team,tool-agent-team,agent-team-profile}`（读）、批次真源 `~/.dsh/punky-preset/sessions/**`（读）。**未跑测试、未跑 build、未重启宿主、未 git 写。** |
| **能力发现前置（纪律 0l）** | 本稿未断言任何「引擎没有某工具/技能」。为对齐纪律仍实检索一次：`tools_search("subagent spawn child agent isolation")`（13 命中，含 `subagent` / `subagent_fork` / 官方九工具中的 `list_agents`）、`skill_search("evaluate engine design / audit engine", k=5)`（命中 `engine-team` / `skill-governance-toolkit` / `design-team` / `research-team` / `writing-team`）。检索**未发现**「本引擎具备 agent-team 实施面」的证据。 |
| **未实测处的处置** | 任何未实测/无法确证者一律标 **未验证/未知**，见 **§7**，不预填结论。 |

---

## §1 现状重评（as-is）

### 1.1 四面的**实际实现模式**（全部 = subagent 模式位点）

| 面 | 实际实现模式 | 具体位点（file:line，字节口径） |
|---|---|---|
| **成员面** | **引擎自建八态状态机**（`pending/running/review/merged/failed/skipped/conflict/idle`）+ 自建迁移表 + 自建结算门；官方 roster **只作读端标注**（`stateSource`/`memberStatesLegacy`），**不参与判定** | `lib/schema.js:17`（`MEMBER_STATES`）/ `:23`（`MEMBER_TRANSITIONS`）/ `:48`（`isMemberTerminal`）；写路径单点 `lib/state/store.js:542`（`setMember`）、导出 `:1240`；读端 legacy 标注 `lib/tools/core.js:599-604`（`MERGE_STATE_SOURCE` / `MEMBER_STATES_LEGACY`） |
| **派发面** | **引擎自派走宿主 `ctx.subagents` seam**：`buildStartSpec` → `rt.startContinuable(spec)`；**能力探测失败即降级「仅发句柄」**（不崩、不硬失败） | seam 依赖声明 `lib/index.js:86`（`export const inject = ['tools','webServer','subagents']`）；能力探测 `lib/engine/dispatch.js:161`（`subagentRuntimeOf`）；自派核心 `:312`（`dispatchLaneCore`，`startContinuable` 调用在 `:365`）；降级分支 `:325` / `:335`；并发闸单点 `:271`（`assertConcurrencyAdmit`，与 `:318` 置 running 之间无 `await`）；绑定登记唯一写路径 `:389` |
| **派发面（旁路）** | **装配层 post-execute 观察器**（零宿主改造）也写同一个 `member.dispatch`——两写点同事件、同形状，**读端不可区分** | `lib/bridge/dispatch-register.js:74`（`installDispatchRegistration`）/ `:88`（`appendEvent`）；看护句柄面 `lib/bridge/lane-handle.js` |
| **任务与交接面** | **双真源**：声明面 = 建批 tasks 的 `deps`；运行期 = 自建 `batch.handoffs` 黑板 + `lane.handoff` 事件；**官方任务板只有「只读回显位」** `officialTaskId`（不参与判定） | 交接门单点 `lib/state/gates.js:549/603`（`handoffRecordVerdict`，entry 与 exit 同源）；建批期判据 `lib/wave-plan.js:691/728/737`（`GATE_HANDOFF_MISSING`）；官方任务板回显 `lib/tools/core.js:1322`（`officialTaskId: rec`） |
| **推进面（chain）** | 自建 chain 推进器：**由 `member_settle` 工具调用后触发**（⇒ 触发源是「成员结算」，不是「交接成立」）；`leader-direct` 批**全程 no-op** | 触发点 `lib/tools/core.js:1196`（`await advanceChainAfterSettle(...)`，紧接 `:1190` 的 `setMember`）；推进器 `lib/engine/chain-runner.js:130`；`leader-direct` no-op `:153-157`；配对收窄 `:211`（`perLaneTargetOf`）/ `:260`（`pairedLaneOf`）；留痕 `:361`（`EVT_CHAIN_STEP`） |
| **观测与监管面** | **自建**：文件 mailbox（`lib/comms/mailbox.js`）+ 自建心跳档 / longrun 档探针（读**磁盘**进度快照 + 批次事件流）+ 自建 dangling 视图 | 探针 `lib/watch/lane-heartbeat.js:383`（`lastProgressTsOf`）/ `:768`（`laneProgressDirOf`）/ `:778`（`progressSnapshotTsOf`）/ 消费点 `:1058`、`:1208`；mailbox `lib/comms/mailbox.js:25+` |
| **成员回报面** | 自建 `swarm_report` / `swarm_cc` → Leader broadcast / Manager inbox；身份 best-effort 反查 `member.dispatch` | `lib/engine/dispatch.js:414-419`（已删「未绑定即拒」）/ `:422`（`laneBindingOf`）；工具面 `lib/tools/core.js:1370`（`swarm_report`）/ `:1408`（`swarm_cc`） |

### 1.2 agent-team 侧**已接 / 未接**清单

| 官方能力 | 状态 | 证据（file:line） |
|---|---|---|
| `ctx.agentTeams` 服务（roster 读端） | ✅ **已接（唯一一处）** | `lib/tools/core.js:567`（`managerRosterOf`）→ `svc.listMembers(exec.agent)`（`:574`）；取用口 `ctx.get('agentTeams')`（`:569`），**刻意不进 `inject`**（`:557-560`） |
| `managerRoster` 回显（声明 `raise` 而无 Manager → `gate.manager_roster_gap`） | ✅ 已接 | `lib/tools/core.js:586`（`managerViewOf`）/ `:794`（batch_status 单批回显） |
| 官方任务板（`team_task_create/list/get/update`） | ⚠️ **仅回显位**（`officialTaskId` 只读，不参与判定、不写、不查） | `lib/tools/core.js:1207`（参数面）/ `:1229`（写入 handoffs 记录）/ `:1322`（读端回显） |
| 官方成员（`spawn_teammate`）/ 成员态（5 态） | ❌ **未接**：引擎 `member.*` 八态与官方 `running/idle/inactive/provisioning/failed` **两套并存**，官方侧仅 legacy 标注 | `lib/tools/core.js:593-604`（明写「成员身份/状态的真源 = 官方 roster（5 态）…引擎八态是投影⇒一律标 legacy（**不改判定**）」） |
| 官方消息面（`send_message` durable mailbox） | ❌ **未接**：自建文件 mailbox 独立；官方 `send_message` 与引擎同名工具**不同物**（引擎侧 `send_message` 是宿主子代理工具） | 自建 mailbox `lib/comms/mailbox.js`；旁路误登记风险见 `member-governance-redesign §9.1 W-1`（`dispatch-register` 名单含同名 `send_message`） |
| 官方成员槽位（`maxMembers`） | ❌ 未读（**刻意**：并发闸与官方槽位**不同轴**） | `lib/engine/dispatch.js:196`（明写「本段判据**不读** `agentTeams` / `managerRoster` / `maxMembers`」） |
| 官方 roster → 官方任务的 DAG（`blockedBy`/`ready`） | ❌ 未接：DAG 在引擎自建链/`deps` 上 | 见 §1.1「任务与交接面」 |

### 1.3 **本次侦察新增的实测事实**（原台账未记，本稿首记）

| # | 事实 | 读数 / 证据 |
|---|---|---|
| **N-1** | **在役 web profile 已挂官方 agent-team，且官方 profile 层已 `disabled` 掉宿主 `subagent` / `subagent_fork` / `subagent-control` / `subagent-list-agents` 四个插件** | `~/.dsh/profiles/web/package.json` bundles 含 `@deepseek-ai/dsh-experimental-agent-team-profile`；`.../dsh-experimental-agent-team-profile/cordis.patch.yml:4-14`（四条 `disabled: true`）；九工具注册面 `.../dsh-experimental-tool-agent-team/lib/index.js:239/244/289/316/325/347/360/395/439/452` |
| **N-2** | **但 `ctx.subagents` 服务本身仍在**（官方 profile patch 只禁**工具**插件，不禁服务插件 `id: subagent`）⇒ 引擎自派**架构上仍可用** | 服务插件 `@deepseek-ai/dsh-subagent` 由 dsh-base 提供（`D:\dsh\npm\0.1.6-alpha.1\node_modules\@deepseek-ai\dsh-base\cordis.patch.yml:328-329`）；服务契约 `.../dsh-subagent/lib/types/index.d.ts:58-60`（`Context` 增 `subagents: SubagentRuntime`）、`:117`（`startContinuable`） |
| **N-3** | **引擎 `dispatch.provider` 只在插件 patch 配、不在 runtime.json** ⇒ 热更面无法覆盖它；当前值 = `spawn` | `packages/dsh-punky-swarm/cordis.patch.yml:23-24`（`dispatch: { provider: spawn }`）；`~/.dsh/punky-preset/config/runtime.json` 仅含 `gates/governance/capabilities`**三键**，**无 `dispatch` 段**（⇒ `liveConfig.dispatch.provider` 读的是静态配置，`:327` 的「热更快照」在该键上不成立） |
| **N-4** | **27 个存量批中，`raise`（非 leader-direct）批只有 2 个，且二者 `chain.step` 计数均为 0** ⇒ 「引擎链推进」**从未在真实批里产生过推进留痕**；`chain.step` 的全部出现的批次均为 `leader-direct`（该形态已 no-op） | 逐批统计（`~/.dsh/punky-preset/sessions/*/batches/*.json`）：`suite-live-20260916`（raise，chain.step=0）、`suite-live2-20260916`（raise，chain.step=0）；`smoke-chain`/`v2-smoke4`/`panel-hotfix`/`handoff-consolidation-m0m1`/`techdebt-bom-reader` 均有 chain.step 但 `managerPlan=leader-direct` |
| **N-5** | **`expandChainBranches` 只被测试面与自身导出引用，未接入任何建批路径**（373 文件扫，除定义外**仅 1 命中**） | `lib/assembly/chain.js:812`（定义）；唯一外部引用 `test/chain-v3-assembly.test.js:101`；`presets/**`、`lib/**`、`scripts/**` 其余零命中 ⇒ 链资产**不生成**批次 lane，lane 由 Leader 在 `wave_plan({tasks})` 手写 |
| **N-6** | **链资产声明的拓扑与真实批的拓扑可以系统性不一致，且建批期不拦**（拦在运行期） | 真批 `cleanup-wave-20260918`（session-ea465acf）：实际 5 lane = `plan-designer / exec-build / exec-panel-docs / exec-longtail / audit-wave`，`assembly={managerPlan:'leader-direct', auditLane:'audit-wave'}`，`chain.step=0`、`batch.phase` 含 `manual:batch_control.resume`；而 `presets/engine-team/team-asset.yml` 的 chain 声明 `exec` 步有 3 分支（`exec-coder/exec-verifier/exec-reviewer`）+ `audit-pair` **pair_with: "exec"** ⇒ 按声明应为 3 条 audit lane，实批 1 条聚合 audit lane（`lane` 名 `audit-wave` 不在链声明的 step id / branch id 内） |
| **N-7** | **`pair_with` 的 1:1 语义在真批里已被实证**（per-lane audit lane + `deps` 恰为 1 条上游 lane） | 真批 `software-team-opt-20260917`（session-ea465acf）6 lane：`audit-swopt-asset` 的 `deps=["exec-swopt-asset"]`、`audit-swopt-docs` 的 `deps=["exec-swopt-docs"]`；两条 exec 无 `deps`（同层并行） |
| **N-8** | **真批的 `member.dispatch` 确实带 `workerSessionId`** ⇒ 引擎自派（或旁路登记）**在本机真实发生**；同时这些 child 会话正是官方 `list_agents` / `send_message` 的寻址对象 | `star-demo-parallel-20260917` 6 条（`plan-demo→79fd64d6…`、`exec-alpha→3ab9efbf…`、`exec-beta→c79f62b8…`、`audit-beta→0f59549e…`、`audit-alpha→1d42530a…`、`accept→5d8fb1b8…`）；`suite-live-20260916` 4 条 |
| **N-9** | **门禁缺席可复现地改变批次轨迹**：缺交接 ⇒ 自动结算抛 `GATE_HANDOFF_MISSING` ⇒ `running→paused`，须 `batch_control(resume)` 恢复 | `cleanup-wave-20260918` 的 `batch.phase` 事件逐字：`running->paused(auto-settle:GATE_HANDOFF_MISSING: handoff:plan-designer->(exec-build/exec-panel-docs/exec-longtail) …)` → `paused->running(manual:batch_control.resume)`（共 2 轮） |
| **N-10** | **进度快照落点已迁移**（新批 lane 域、旧批层域共存），`U-2` 的「写端已按新口径」有独立复核读数 | 批 `concurrency-gate-20260917` 产物根 depth-1 含 `audit-concurrency-gate / exec-concurrency-gate / plan-concurrency-gate` 三 lane 域目录，其下 `progress/*.md` 在位（例：`exec-concurrency-gate/progress/01-red-t1.md`）；同批**仍有**层域目录 `audit/ exec/ plan/`（内含交付物 `audit/gate-verdict.md`、`exec/gate-impl.md`）⇒ 新旧命名**共存**，读端口径（`lane-heartbeat.js:768/778`）只认 lane 域 |

---

## §2 四类工作逐项重评

### 2.1 ① `pair_with` 配对粒度

#### 2.1.1 语义复核（逐条对证据，先确认用户已核的三处**

| 断言 | 复核结果 | 证据 |
|---|---|---|
| `pair_with` 是 `perLane` 的**可读别名** | ✅ **成立**：校验器**同码位同文案**、实例化**同一代码路径**；二者**禁同时声明**（不设双真源） | 别名声明 `lib/assembly/chain.js:314-321`（注释）、`:442`（`pairingId` 判定）、`:444-446`（`pair_with`+`perLane` 同声明 ⇒ `MISSING_FIELD`）；展开路径 `:849`（`pairTarget = pair_with ?? perLane`）；拓扑边同义 `:485-490`（`via:'perLane'` / `via:'pair_with'`）；模板校验同支 `:460-462` |
| 配对步**按上游步在本批的每条 lane 1:1 实例化** | ✅ **成立** | 语义写死 `lib/assembly/chain.js:802-804`（「按**上游步在本批的每条 lane** 实例化一条（1:1），lane id = `template.id` 的 `${lane}` 插值，`deps` **恰为** `[上游 lane]`」）；实现 `:850-863`（`upstream = lanesOfStep.get(pairTarget)` ⇒ 逐条 push，`deps:[up]`）；真批实证见 §1.3 N-7；夹具锁 `test/chain-v3-assembly.test.js:103-111` |
| 上游步 lane 集的来源 = **该步自己的展开结果**，**不是**全链上游 | ✅ **成立**（此点原台账未单列，本稿补全） | `lib/assembly/chain.js:851`（`lanesOfStep.get(pairTarget)` —— `lanesOfStep` 只装**本函数已展开的步**，`s.branches` 分支在 `:832-848` 写入、普通步在 `:867-874` 写入）；⇒ `pair_with:"X"` 的基数 = **步 X 在本批的 lane 数**，与步 X 更上游有多少 lane **无关** |

#### 2.1.2 关键问题：上游步只有 1 条 lane ⇒ 是否恰好 1 条 audit lane？

**结论：`确认无需改`（引擎侧零改动）。** 但必须先区分两种「只有 1 条 lane」——现行资产正好各有一个样本：

| 情形 | 判定 | 证据（现状位点） |
|---|---|---|
| **(a) 上游步声明单分支（`branches.length===1`）** ⇒ 该步天然只 1 条 lane ⇒ 配对步**恰 1 条 audit lane** | ✅ **恰好 1 条**，无需改动 | **`presets/software-team/team-asset.yml:86-95`（`exec-review` 步）**：`branches` 恰 1 个 `exec-reviewer`（`:92`）；`audit-pair` 步 `pair_with: "exec-review"`（`:100`）⇒ 展开基数 1 ⇒ `audit-exec-reviewer` 1 条。同形旁证：`design-team`（`:89` `pair_with:"exec-build"`，其 `exec-build` 单分支 `:81`）、`research-team`（`:88`/`:80`）、`writing-team` 上游 `exec` 有 2 分支 ⇒ 2 条 audit（**正确**，非单例） |
| **(b) 上游步多分支，但**本批只建了其中 1 条 lane** | ⚠️ **不是「恰好 1 条」，而是「凑不齐」** ⇒ 运行期停轮 `no-paired-lane`（**不静默、不退回全派、不新造 lane**） | 判据 `lib/assembly/chain.js:699-713`（`pairedLaneOf`：要求目标步 lane 的 `deps` **恰为** `[sourceLane]`，找不到 ⇒ `null`）；停轮点 `lib/engine/chain-runner.js:259-266`（`no-paired-lane` ⇒ `pauseBatch`，`chain.step{dispatch:{ok:false,mode:'rejected',reason:'no-paired-lane'}}`） |
| **(c) 上游步 0 条 lane（本批该步无 lane）** | ⚠️ 更早停轮：`no-lane-for-step` | `lib/engine/chain-runner.js:247-251` |

**为什么 (a) 无需改（反证）**：`chain-runner` 对**无配对后继**的步也把 `group.lanes` 收窄为触发 lane 一条（`lib/engine/chain-runner.js:211-212`：`const branchStep = perLaneTargetOf(chain, step.id); const joinLanes = branchStep ? [lane] : group.lanes;`）。单分支步的 `group.lanes` **本来就只有 1 条** ⇒ 两分支**同值**，`join:'all'` 仍成立、`chainNextOf` 不会 `wait`。配对目标解析同理命中唯一一条（`deps` 恰为 `[该 lane]`）。⇒ **单分支场景下「配对」与「非配对」行为收敛，无歧义、无额外实例。**

**反例清单（有反例、但不构成「需要改引擎」）**：

| 反例 | 触发条件 | 现状行为 | 是否要改 |
|---|---|---|---|
| **R-a（改名未同步）** | 步 id 改名而未同步 `next`/`pair_with`/依赖 | `pair_with` 悬空 ⇒ **建批期**拒（`MISSING_FIELD` @ `chain.steps.<id>.pair_with`） | 无需改（已 fail-closed） |
| **R-b（基数不符）** | 上游步多分支、本批只建部分 lane | 运行期停轮 `no-paired-lane`（带 lane 名） | 无需改（**不猜、不静默**正是设计意图） |
| **R-c（分支 lane 名与模板不符）** | 配对 lane id 不命中 `template.id` 的 `${lane}` 模式 | 运行期「映射到链外」（`chainStepForLane` 判 `step:null`）⇒ 推进不触发（**静默**在链面，但批次面无事件） | ⚠️ **登记为观测项（O-11）**：这是「写了不生效」的**潜在**形态，但只发生在**手工写 batch lane 而不按链声明**时；`expandChainBranches` 自带反投影自证（`lib/assembly/chain.js:876-882`）可拦，只是**该函数未接线**（§1.3 N-5） |

**⇒ 本项判定**：**确认无需改引擎**。若要做点什么，只有**文档/契约面**（把「pair_with 基数 = 被指步在本批的 lane 数」与「多分支步只建部分 lane ⇒ 停轮」写进指引与任务包模板），该动作登记为 **Q-07（技术债/文档同步，非引擎改动）**。

---

### 2.2 ② `M4 → M3 → M2′ → M5′`（`handoff-semantics-consolidation §10.3`）

#### 2.2.1 逐项现状位点

| 项 | 内容 | 现状 | 证据 |
|---|---|---|---|
| **M0′-①** | `leader-direct` 批推进 **no-op** | ✅ **已落地** | `lib/engine/chain-runner.js:142-157`（`if ((batch.assembly?.managerPlan ?? null) === 'leader-direct') { out.reason='manager-plan-leader-direct'; out.note='leader-direct-noop'; return out; }`，**先于相位闸**） |
| **M0′-② / CH-1** | `batch.phase` **补 `reason`** | ✅ **已落地**（停轮面自带 `chain:<分支>`） | 工具面 `lib/tools/core.js:836`（`setPhase(..., { reason: args.reason ?? ('manual:batch_phase:'+args.phase) })`）；链停轮 `lib/engine/chain-runner.js:390-395`（`store.setPhase(..., 'paused', { reason: 'chain:' + reason })`）；事件载荷说明 `lib/state/event-types.js:29-34`；真批实例见 §1.3 N-9 |
| **M1** | 删 `on` 声明面（**声明即拒**） | ✅ **已落地** | `lib/assembly/chain.js:571-586`（第 ⑧ 条：`if (s.on == null) continue;` ⇒ `FIELD_NOT_ALLOWED` @ `chain.steps.<id>.on`，三版本同拒）；`CHAIN_ON_TOKENS` 导出**已不存在**（全 `lib/**` 零命中）；`CHAIN_STEP_VIA` 收窄为 `['next','onFail','anyFailure']`（`lib/assembly/chain.js:123`）；历史 `via` 兼容读保留（`chainEchoOf` `:897-914` 不校验 `via`，`:893-895` 注释明写「禁在此新增校验」） |
| **M4** | 策略（`join`/`rework`/`terminal`/`onFail`）由 chain **迁批次级** | ❌ **未开始** | `lib/wave-plan.js` 对 `rework`/`terminal`/`onFail` **零命中**（`grep` 实测）；`join` 的 11 处命中全为 `Array.join` 用法（与本议题无关）；策略**仍在链级**被消费：`lib/engine/chain-runner.js:40-54`（注释）+ `:203`（`countReworkAttempts`）+ `:213`（`chainNextOf(..., { reworkAttempts })`） |
| **—— CH-2（M4 内含）** | `rework` 计数换口径 | ❌ **未做，且已「失触发路径」** | 现口径按 `chain.step` 事件条数：`lib/engine/chain-runner.js:409`（`e.via === 'on.fail' \|\| e.via === 'on.conflict'`）；但 M1 后**写侧白名单已不含 `on.*`**（`lib/assembly/chain.js:123`）⇒ **新事件不可能再带这两个 `via` ⇒ 计数恒 0**。台账已登记为 `F-3`（`gap-list-20260917.md §1.3`） |
| **M3** | 推进触发改挂 **`lane.handoff`** | ❌ **未做**（当前触发源 = `member_settle` 工具调用） | 触发点 `lib/tools/core.js:1196`（`await advanceChainAfterSettle(...)`，注释 `:1191-1195` 明写「**结算事实已落盘之后**触发自动推进」）；推进器入口 `lib/engine/chain-runner.js:130` |
| **M2′** | `next` 双向链表化 + 「至少一头挂」+ 矛盾报码 | ❌ **未做**（当前：`next` 保留、无「至少一头」建批期校验） | `next` 仍在校验/推进正路：`lib/assembly/chain.js:475-478`（悬空校验）、`:174-182`（`edgesOfStep` 只产 `next` 边）、`lib/engine/chain-runner.js:24/192/220` |
| **M5′** | 舍弃 `chain.step` 事件（推进事实改由 `member.settled`+`lane.handoff` 表达） | ❌ **未做**（该事件**仍在写**） | 写点 `lib/engine/chain-runner.js:224/233/243/249/262/282/336/346/361`（9 处）；读端 ① `chainEchoOf` `lib/assembly/chain.js:897`（经 `lib/tools/core.js:972` 进 `batch_status.chain`）② `lib/engine/replay.js:69`（重放判据）③ rework 计数 `lib/engine/chain-runner.js:409`；事件常量 `lib/state/event-types.js:260` |
| **—— CH-3（M5′ 前置）** | `replay.js` + `chainView` 读端迁移/兼容 | ❌ **未做** | `lib/engine/replay.js:40`（复用 `chain.step` 作重放留痕）/ `:69`（`hasAdvancedSince`）；`lib/tools/core.js:972`（`chainEchoOf` 装配进 `batch_status`） |
| **—— Q-C4 / M5 改名面** | `chain.step` 事件名歧义 | ❌ 未做（事件名仍与声明 `chain.steps[]` 同名） | 同 M5′ 位点 |

#### 2.2.2 **在 agent-team 模式下逐项是否仍必要**（本项回答是本节的落点）

| 项 | agent-team 模式判定 | 理由（证据） |
|---|---|---|
| **M1（删 `on`）** | **已做完 ⇒ 无需再评；结论：改动本身与模式无关**（死声明面，0/5 资产使用） | `lib/assembly/chain.js:577-585`（声明即拒、能力去处写明） |
| **M4（策略迁批次级）** | **改写** | 官方侧策略位落在**任务板**：`TeamTaskSnapshot.blockedBy`（依赖）/ `writeScopes`（写域）/ `status`（`pending/in_progress/completed/deleted`）——见 `.../dsh-experimental-agent-team/lib/types/types.d.ts:53-65`。**但**引擎需要的 `join:any/all`（汇合语义）、`rework.max_attempts`（返工上限）、`terminal`（终态判定）**官方无对应物**（官方任务板无「汇合闸」「返工计数」概念）⇒ **M4 在两种模式都仍需做**，只是「迁到哪」不同：子代理模式迁**批次声明**；agent-team 模式应迁**批次声明 + 官方 `blockedBy` 双写（M-6 协议）** |
| **M3（推进改挂 `lane.handoff`）** | **保留，但降为「次优触发」** | ① **agent-team 模式下官方**没有「交接成立 ⇒ 唤醒下游」机制：`readiness` **不启动 owner**（官方语义，见 `.../tool-agent-team/lib/index.js:395-437` 的 `team_task_list` 只回显 `ready` 标志、文档口径见 `member-governance-redesign §0`）；唤醒只能 `send_message`（宿主 `send_message` 与本插件工具同名不同物）⇒ **引擎若不自建触发，就没人推进**。② 直接证据：官方成员**天然无 lane 绑定**（`lib/engine/dispatch.js:414-419` 已删「未绑定即拒」）⇒ 官方成员的结算**不产生 `member_settle`**，M3 之后「谁触发推进」在官方轨上**更缺**。⇒ **M3 仍需做，且应从「成员结算触发」改为「交接成立触发」（这正是 M3 的原文），并在 agent-team 模式下成为唯一可行触发。** |
| **M2′（`next` 双向链表 + 至少一头）** | **保留（偏「变必须」）** | 官方任务板**有**依赖表达（`blockedBy`）但**无「声明面至少一头挂」的静态校验**；M2′ 的「两者皆空 ⇒ 建批期拒」「并存且矛盾 ⇒ 报码拒，禁静默取一」正是补官方缺口。今日的 `no-lane-for-step` 停轮（`lib/engine/chain-runner.js:247-251`）与真批实证（§1.3 N-6：声明 3 条 exec lane、实批 1 条聚合 audit 且 `chain.step=0`）**都指向同一根因：链声明与批次声明无双真源检测** |
| **M5′（舍弃 `chain.step`）** | **改写：保留事件 → 降为「审计投影」，不删** | ① 该事件的两处真实消费者**都要活**（`replay.js` 重放、`chainEchoOf` 回显）；② 更关键：**它在真实批里计数为 0**（§1.3 N-4：27 批只有 5 批有，且全在 `leader-direct`），其历史作用已被 `batch.phase.reason`（CH-1）部分取代；③ 官方模式下推进留痕天然存在于**官方侧**（`team/task`、`team/member`、`team/message/*` 事件，见 `types.d.ts:177-205`）⇒ 「用一个自建事件表达推进」在官方模式下**是冗余表达**，但在子代理模式仍是唯一表达。⇒ **改写为：M5′ 从「舍弃」改「冻结新增语义 + 保留读端兼容」，等 agent-team 定型后再决定删否** |
| **CH-2（rework 计数换口径）** | **保留（且是**当前就成立**的真债，与模式无关）** | M1 已把写侧 `on.*` 白名单删掉 ⇒ **计数恒 0**（`lib/engine/chain-runner.js:409` × `lib/assembly/chain.js:123`）。这不是「待迭代」，是**当前态的功能失效**（详见 §3 同源组 G-3） |
| **CH-3（读端迁移）** | **保留为 M5′ 的前置**（与模式无关） | 同上读端四处 |

**§2.2 一句话**：`M4 → M3 → M2′ → M5′` 四步在 agent-team 模式下**没有一步「自然消失」**；其中 **M3 更必要**（官方不自动唤醒）、**M5′ 应降级为「冻结 + 兼容」而非删**、**M4/M2′ 保留**。

---

### 2.3 ③ 引擎候选三项

#### ③-a `template.consume` 字段（让「audit 非盲审」成为资产默认）

| 维度 | 评估 |
|---|---|
| **现状** | `template` 目前**只允许三键**：`{ id?, cmd, produce[] }`——校验器 `lib/assembly/chain.js:323-367`（`checkTemplate`）逐项限定，且**白名单变量只有 `${lane}`/`${branch}`**（`lib/assembly/chain.js:135-137`：`CHAIN_V3_STEP_KEYS = ['branches','pair_with','template']`、`CHAIN_TEMPLATE_VARS = ['lane','branch']`）⇒ **`template.consume` 不存在**，声明即被 `FIELD_NOT_ALLOWED` 拦（未知变量/表达式面同码）。展开器 `expandChainBranches` 的产物**只含** `layer/role/skills/deps/cmd/produce`（`lib/assembly/chain.js:806-807` 明写「跨层 `consume`、门禁、产物在场等**归 W3 提交面**——本函数不猜、不代造」） |
| **「audit 非盲审」现状谁在承** | **两处**：① audit 层 `entry_requires:['consume']` + 引擎 entry 门（`lib/state/gates.js` entry 判据）；② 建批期 audit 锚点门：`GATE_AUDIT_INPUT_MISSING`（`lib/wave-plan.js:552-574`，判据 = 至少一条 audit lane 的 `consume` 命中 `plan/` 前缀产物（`isPlanProduct`））+ audit 契约的 `criteriaFrom` 回落（`lib/state/gates.js:728-737`：`criteria_from` 空 ⇒ `anchors = consume.filter(isPlanProduct)`，任一锚点正文含 `## 验收标准` 即放行） |
| **代价** | ① 校验器 + 展开器 + 至少 5 份团队资产 + 相关测试同步（面不小）；② **双真源风险**：`consume` 将同时出现在链声明与本批 tasks（后者是运行期唯一真源，见 N-5）⇒ 若无一致性校验，就制造出**第二个「写了不生效」面**；③ `criteria_from` **刚被用户裁决删除**（蓝图 §10.36：`presets/software-team/team-asset.yml` 键集 `{criteria_from,…}`→`{consumes_required, verdict}`），方向是「**减少**声明面 + 用既有回落」——此时新增 `template.consume` **逆裁决方向** |
| **是否值得做** | **不建议做（备用方案 O-01）**。理由：它解决的是「链资产没写 consume 时 audit 会盲审」的**假设**问题；而现状已由两处门禁承住（含 `criteria_from` 删除后的 `isPlanProduct` 回落），且 directions 上是**加声明面**。**若不做会怎样**：链资产作者仍须在建批 tasks 里为 audit 写 `consume`（**本来就必须**，因为 tasks 才是运行期真源），无正确性损失；至多损失「声明面自解释性」 |
| **前置替代（更便宜）** | 若确实要「非盲审成为资产默认」，成本更低的路径 = 在**建批期校验**加一条「audit lane 的 `consume` 必须覆盖被指上游步的 produce ∪ outputs」（纯校验、零新声明键、零双真源）——登记为 **O-02（增强）** |

#### ③-b 分支级 `template` 回退候选（分支级 `produce`/`cmd` 死声明问题）

| 维度 | 评估 |
|---|---|
| **现状（实测）** | 五队资产的**分支级 `template` 只声明 `cmd`**（`presets/{software,design,research,writing,engine}-team/team-asset.yml` 各分支行：`{ "id": …, "role": …, "template": { "cmd": "…（${branch}）" } }`），`produce` 全部上移**步级**（如 `software-team:79` `"template": { "produce": ["exec/${branch}.md"] }`）。而**展开器只读步级模板**：`lib/assembly/chain.js:842`（分支 lane 的 `produce: produceOf(tpl, vars)`，`tpl` = **步级** `s.template`；`produceOf` 定义 `:827`，读 `tpl.produce`）⇒ **分支级的 `produce` 今天会写而不生效**（这正是 G-8 当年触发的问题面）；分支级 `cmd` 则**同样不被展开器读**（`:842` 的 `cmd: interp(tpl.cmd, vars)` 取步级 `tpl.cmd`，而五队步级模板**都不含 `cmd`** ⇒ **分支级 cmd 是当前唯一 cmd 来源，却读不到**） |
| **判据（死声明是否成立）** | **成立但被「不上移」掩盖**：`produce` 已按 G-8 上移 ⇒ 分支级 `produce` 现在**没人写**；`cmd` **仍写在分支级**、而读端只认步级 ⇒ **`cmd` 是活跃的死声明**（写了不生效）。**但**：建批不读链声明（§1.3 N-5：`expandChainBranches` 未接线）⇒ 今日**没有任何运行期消费者**，`cmd` 的死声明**不产生**错误行为，只是「资产自述与引擎读法不一致」 |
| **代价** | ① 若做「分支级优先、步级回退」：校验器（`lib/assembly/chain.js:343-366`）+ 展开器（`:837-843`）+ 5 资产 + 测试；② 若同时补 `cmd` 回退，还要定「同名键优先级」口径（分支 vs 步）；③ **必须同时决定**「链声明是否重新接线为建批来源」（否则修了也仍无人读，**又一次写了不生效**） |
| **是否值得做** | **不建议现在做（备用方案 O-03）**。判据：它**不解决任何当前错误**（无运行期消费者），却引入新优先级语义；正确顺序是**先决定链声明接线与否**（见 §6 档位 3「不建议做」与 O-04），再谈回退。**若不做会怎样**：资产里继续存在「分支级 `cmd` 无人读」的现状；一旦将来把 `expandChainBranches` 接线为建批来源，**同一天就变成真错误**（cmd 全空）⇒ 因此**至少应登记为「接线前置条件」**，不可遗忘 |
| **最小可判动作** | 登记 **T-09（技术债：链声明 vs 批次声明无一致性校验/无消费者）** 时，把「分支级 `cmd` 死声明」列为**接线前置**一并处理 |

#### ③-c F-6 双路读（`<lane>/progress` 新旧路径兼容）

| 维度 | 评估 |
|---|---|
| **现状** | 读端**只认 lane 域**：`lib/watch/lane-heartbeat.js:768-770`（`laneProgressDirOf` = `join(<artifacts>/<batchId>, lane)`，注释明写「用原始 laneId 拼接…须与 worker 实际落盘逐字一致」）；扫描面 `:778-785`（`progressSnapshotTsOf` = `lane/progress` 子树 ∨ `lane/*.md` 顶层，**二者互补、只增不减信号面**）；消费点 `:1058`、`:1208`；底层扫盘 `:383`（`lastProgressTsOf`） |
| **事实（本稿实测，与蓝图 §10.26 / §10.35 一致）** | **写端已迁移**：新批产物根出现 lane 域目录且 `progress/*.md` 在位（§1.3 N-10 读数）；**旧批层域遗留仍在**（同批 `audit/ exec/ plan/` 三目录并存，内含非快照交付物）⇒ 「双路读」的收益面 = **历史批 + 未按指引落盘的成员** |
| **代价** | 低（读端加一路 `join(<artifacts>/<batchId>, <layer>)` 扫描 + 去重取最新）。**但有三个副作用**：① **误绿风险**：层域目录里同时放着**交付物**（`audit/gate-verdict.md` 等）⇒ 扫层域会把「收尾交付」读成「仍在跑」（`lib/watch/lane-heartbeat.js:774-777` 的收窄注释正是为防这个而写）；② **跨 lane 串味**：层域是多 lane 共享目录，无法归因到具体 lane ⇒ `lastProgressTs` 会**张冠李戴**；③ 与 `O-1` 落地方向（**统一未来落点**）相反，等于给「错落点」发长期许可证 |
| **是否值得做** | **不建议做（备用方案 O-04）；登记但降级**。判据：收益面只在历史批（历史批已终态、探针只对非终态 lane 有意义）与「不守纪律的成员」，而代价是**误绿 + 串味**两类假信号 —— 违反探针「宁缺勿假」的取向。**若不做会怎样**：历史批的 `progressTs` 继续为 null（**已知、已冻结**，见蓝图 §10.26「L1 只统一未来落点，历史 56 份仍不可见」），新批不受影响（N-10）。⇒ U-3 的既有裁决「**不立引擎项，登记 followup**」**结论维持**（蓝图 §10.26 U-3） |
| **同源组** | F-6 ↔ `W-13` ↔ `O-1` ↔ `G4/V-5/U-2` 同源（见 §3） |

---

### 2.4 ④ gap-list 挂起项（`gap-list-20260917.md §1.3–§1.8`）——全量列出 + 同源合并 + 三分类

> **口径**：本表**原样转录**各节的挂起项，**不改判**；「同源组」列指 §3 的组号；「分类」列给 `技术债 / 待增强备用方案 / 观测项` 三分类草案。**注意两处编号事实**：① **§1.7 在源文件中不存在**（`gap-list-20260917.md:106` 之后直接是 `:111` 的 §1.8）——本稿不臆造；② **`F-6` 在源文件中被两条不同条目占用**（§1.3 的 F-6 = `baselines/**` 批外写面缺留痕；§1.5 的「N-9/N-11/**F-5/F-6**」里的 F-6 = **引擎双路读**）⇒ 本稿以 **F-6a / F-6b** 消歧。

#### §1.3 批 `handoff-consolidation-m0m1-20260917`（followup 7）

| id | 项 | 分类 | 同源组 | 现状补充（本稿实测） |
|---|---|---|---|---|
| F-1 | 宿主级 reload 冒烟未做（约束禁重启宿主） | 观测项 | G-1 | ⚠️ **已被后世批次覆盖（部分）**：`engine-status-and-debt-20260918.md §6.1` 记 2026-09-18 重启后 reload 冒烟完成、十面 sha 全等；但那是**另一次窗口**，本项的「时点」记录不追改 |
| F-2 | 指引面 `presets/punky-preset/references/discipline.md` live 生效待重启 | 观测项 | G-1 | 同上（`§6.1` 记 `syncAssets()` 幂等同步 + 十面 0 mismatch） |
| F-3 | R2 回边预算段（K3）+ `countReworkAttempts`（K2）**失去新触发路径** | **技术债** | G-3 | ✅ **本稿实测证实**：写侧白名单已无 `on.*`（`lib/assembly/chain.js:123`），读侧仍按 `on.fail/on.conflict` 计数（`lib/engine/chain-runner.js:409`）⇒ **计数恒 0** |
| F-4 | `lane-heartbeat` 的 `reason` 消费增强 | 待增强备用方案 | G-4 | 与 O-04 同族（观测增强） |
| F-5 | `chain.js` 注释引用包内不存在的 `docs/` 路径 | 观测项（文档） | G-5 | ✅ **已部分闭合**：`lib/assembly/chain.js` 现为 `[docs-ref]` 锚记（蓝图 §7.1 「TD-15 部分结项」）；**同形残留 16 处**（`engine-status…§7.3 audit F-4`）⇒ 保留为观测项 |
| **F-6a** | 基线重算属**批外写面**且 `baselines/` 未纳入 VCS ⇒ 缺留痕 | 观测项（流程） | G-2 | 与 `f-04` 同源；`engine-status…§5` 记 `scripts/pkg-hashes.mjs` + `pkg-hashes.txt` 已重算（356 件），但 `baselines/` VCS 面未变 |
| F-7 | `w1-conditional-edges.test.js` tests −1 / asserts −7（等价改写；全库净 +74、恒真 0） | 观测项（计数） | G-2 | 台账自证「断言账目等价」 |

#### §1.4 批 `skill-asset-sync-20260917`（12 条去重 + 3 unverified）

| id | 项 | 分类 | 同源组 |
|---|---|---|---|
| f-01 | `scripts/check-guidance-sync.mjs` 落在窗口内、**不在 281 条快照面** ⇒ 仅 mtime 单证 | 观测项（证据强度） | G-2 |
| f-02 | `exec/skill-link.md` 两处行号漂移（`:131`→`:144`；`:131`→`:133`），**已更正留痕** | 观测项（**已闭合**） | G-6 |
| f-03 | 宿主技能根 `skills/engine-team` 落地 = `syncAssets()` 随宿主启动生效 ⇒ **U-1 未验证** | 观测项 | G-1 |
| f-04 | `baselines/test-baseline.json` 重生成 = 对「禁写 `baselines/**`」的**已声明松弛** | 观测项（流程） | G-2 |
| f-05..f-12 | 其余 8 条（skill 文档围栏语言标签 / exec 并发归因 / `skills/**` 快照覆盖缺口 / 宿主级冒烟 / 窗口内可写对象漂移 / 链 B verdict 支撑语句失准（D-1）/ 被否件 mtime 时序（D-2）等） | 观测项（doc-hygiene/evidence/observation 混合） | G-5 / G-2 / G-1 |
| U-1..U-3（未验证面） | `skills/engine-team` 落地 / 宿主级加载冒烟 / `npm test`+`npm run build` | 观测项（未验证） | G-1 / G-7 |

#### §1.5 批 `asset-consistency-20260917`（12 条）

| id | 项 | 分类 | 同源组 | 现状补充 |
|---|---|---|---|---|
| N-2 | `skills/engine-team/SKILL.md:71-72` 层域口径冲突 + `:80-81` 把**未接线**的 `progress_contract` 称「运行期判据」= **假判据** | **技术债** | G-4 | ⚠️ **根因已消失、文本面待核**：`progress_contract` 已于 2026-09-18 **退役（声明即拒）**（`lib/assembly/team-asset.js:62` `RETIRED_FLOW_KEYS`；`:146-163` `UNWIRED_DECLARATIONS` 清空为 `[]`）⇒ 该文本要么已删、要么成为**指向已退役键的误导**（本稿**未逐字复读该 SKILL 文件** ⇒ 见 §7 未知项） |
| N-4 | 漏项：`skills/design-team/SKILL.md:133` 写 `exec/<lane>/progress/…`（第三种形态，读端不可见） | **技术债** | G-4 | 同上：文本面真缺陷（读端只认 `<lane>/progress`，见 ③-c 证据） |
| N-5 | 事实错误：exec 称「`skills/**` 无 live 镜像」不成立（`root:'skill'` + `syncAssets()` 幂等同步） | **技术债**（文档事实） | G-5 | `engine-status…§6.1` 已实测十面 0 mismatch ⇒ **事实面已被推翻**，文本面待改 |
| N-6 | `manager.md:101` 实为**无维度**写法；污染源在 `plan/consistency-spec.md:159` | 观测项（doc-hygiene） | G-5 | 蓝图 §10.27 记「全文仅 101 行」 |
| A-F-1 / N-7 / N-8 | exec 清单 ROOTS 口径与计数互斥（`baselines/**` **空覆盖**进了报告与 handoff assertion；「8 处」≠ 自表 11 处；撞名计数自相矛盾） | 观测项（证据强度） | G-2 / G-6 | 蓝图 §10.27 给权威计数（4 批 8 组 / 跨 lane 5 组） |
| G-2（新增） | 入边 assertion 把 `7563`（asserts）并入 **tests 口径段** ⇒ 基线口径混源 | 观测项（证据强度） | G-2 | — |
| A-F-2 / N-10 | 无字节级改前副本（证据级别 B）；`check-guidance-sync.mjs:87` 的 `hasPointer` 赋值后未使用 | 观测项（**部分闭合**） | G-2 | **N-10 已由 Leader 直做删除并复跑 GREEN**（蓝图 §10.27）；`RC-5` 另记「该处不存在 `hasPointer`、真死点是载荷字段 `line`（已删）」 |
| A-F-4 + 必核项 | `software-team` plan 层不再声明 `plan/task-tree.json` ⇒ 须核 coordinator 角色产物声明面是否仍称产出该件 | 观测项（语义后果） | G-5 | — |
| N-9 / N-11 / F-5 / **F-6b** | 行号更正（`:994`→`:1004`）｜层域遗留 66/39 时效说明｜docs 悬空引用｜**引擎双路读（不立项，登记）** | 观测项 | G-6 / G-5 / G-4 | **F-6b 即 ③-c 的对象**：蓝图 §10.26 U-3 已裁「**不立引擎项，登记 followup**」 |
| UV-1..UV-4（未验证面） | 重载后核 sha（含 C 面 `~/.agents/skills/`）/ 宿主级加载冒烟 / `npm test`+`build` / L1 行为面翻面 | 观测项（未验证） | G-1 / G-7 / G-4 | 蓝图 §10.35 §（一）记 **U-5 已「closed by environment change」**、**U-2 仍缺「写→读」端到端** |
| 落地批硬约束 | 不得采用 `exec/progress-scope.md §4.1`，须以 `audit/progress-scope-verdict.md §6.4` 为准 | 观测项（纪律） | G-4 | — |

#### §1.6 批 `o1-progress-landing-20260917`（7 组）

| id | 项 | 分类 | 同源组 |
|---|---|---|---|
| G1 | `.yml`/`.json` 行号锚定必须用**原始字节取证**（渲染视图会偏移） | 观测项（**本稿已贯彻**） | G-6 |
| G2 | 改前样本须**先落盘归档** | 观测项（流程） | G-2 |
| G3 | `plan/o1-spec.md §1.1#3/§2.4-A` 目标表述未同步冻结裁决 | 观测项（doc-hygiene） | G-5 |
| G4 | `U-2` **V-5 行为面**（读端是否真消费 `<lane>/progress/`） | 观测项（未验证） | G-4 |
| G5 | `U-3` **C 面 live 落后**（`~/.agents/skills/**` repo vs live sha 不一致） | 观测项（未验证） | G-1 |
| G6 | `U-4` **B 面 live 落后** + `U-5`（live 落后态下读端行为） | 观测项（未验证） | G-1 / G-4 |
| G7 | 共享落点建议：后续批验证产物**一律落 `<lane>/progress/`**（层域 `exec/progress/` 会被跨 lane 覆盖）+ `U-1` 历史件越域未闭合 + 并发窗口口径 | 待增强备用方案 | G-4 |
| D-1 | `plan/o1-spec.md §2.1` 写「去 `:38/:47/:58` 尾逗号」**字节实测为 `:38/:47/:59`** | 观测项 | G-6 |

#### §1.8 批 `concurrency-gate-20260917`（followup 7）

| id | 项 | 分类 | 同源组 |
|---|---|---|---|
| F1 | spec §10.1 的 6 条**改前锚**不可独立验证（根因 = 动手前未落全量哈希基线） | 观测项（**Leader 已裁「不阻断」**） | G-2 |
| F2 | `plan/gate-spec.md §7.6/§9.2-T13/§11-U3` 三处旧登记与实施相反 + A1 预期命中集须补 `lib/tools/core.js` | 观测项（doc-hygiene） | G-5 |
| F7 | exec §5.2 的 A/B 读数与失败清单**已漂移**（9 → 实测 6）⇒ 不得再作当前事实引用 | 观测项（doc-hygiene） | G-5 |
| F3–F6 | 未落改前全量基线｜既有失败清单漂移｜`lib/tools/core.js` 纯 CRLF + 包根散落他会话产物｜`contracts.d.ts` 生成物手改须在 build 后复核 | 观测项（process/evidence） | G-2 |
| U1–U5（未验证面） | 宿主真机派发冒烟｜**跨进程并发**｜存量批「缺省 5」真实行为｜`deferred` 真机链推进｜U3 仅单测面覆盖、真机未测 | 观测项（未验证） | G-7 / G-1 |

#### **同源合并后**（本节归并结果，供 §3 引用）

| 同源组 | 覆盖条目 | 共同根因（一句话） |
|---|---|---|
| **G-1 宿主重载/部署窗口** | F-1, F-2, f-03, UV-1, G5, G6, U1, U2, UV-2, U-3/U-2（部分） | 「引擎落盘 → 宿主进程读取」之间有**进程代差**，只能靠一次重载窗口整批翻面 |
| **G-2 证据强度/基线/账目** | F-6a, f-01, f-04, F-7, A-F-1/N-7/N-8, G-2（第二义）, A-F-2, G1（G-2 组：改前归档）, F1, F3, G2 | 「改前/改后口径未同期固化 + 账目混源」⇒ 事后不可独立复算 |
| **G-3 rework 计数失触发** | **F-3**（+ CH-2） | M1 删写侧白名单、读侧口径未迁 ⇒ 计数恒 0 |
| **G-4 进度快照落点** | **N-2, N-4, F-6b, F-4, G4/U-2/V-5, G6/U-5, G7, UV-4, U-1 越域** | 「读端 lane 限定 vs 文本/写端层域」系统性错位 |
| **G-5 文档漂移/事实错误** | F-5, N-5, N-6, N-9, N-11, G3, F2, F7, A-F-4, f-05..f-12（多数） | 文本面滞后于实现，含**指向已退役键**的误导句 |
| **G-6 编号/行号/引用精度** | G1（字节口径）, D-1, f-02, N-9, A-F-1/N-8 | 渲染视图 vs 原始字节、编号口径不一致 |
| **G-7 真机未验证** | U1–U5, UV-3, U-3（`npm` 面）, U2（跨进程） | 只有单测/夹具面，缺真机读数 |

---

## §3 重合与冲突矩阵

### 3.1 同源组矩阵（同一根因 ⇒ 应**合并处置**）

| 同源组 | 成员 | 同源判据（证据） | 合并后应做**一件事** |
|---|---|---|---|
| **G-3** | `F-3` ≍ `CH-2` ≍ M4 内含项 | 写侧白名单 `lib/assembly/chain.js:123`（无 `on.*`）× 读侧计数 `lib/engine/chain-runner.js:409`（只认 `on.fail/on.conflict`） | 随 M4 一次性改口径（换判据到 `member.settled{to:'failed'\|'conflict'}` 或批次级 `rework` 计数） |
| **G-4** | `N-2` ≍ `N-4` ≍ `F-6b` ≍ `W-13` ≍ `O-1` ≍ `G4/U-2/V-5` ≍ `G7` ≍ `F-4` | 同一读端点 `lib/watch/lane-heartbeat.js:768/778`；同批同时存在 lane 域与层域目录（§1.3 N-10） | ① 文本面统一（权威清单 12 处）；② 落点纪律进任务包模板；③ **不做**读端双路（O-04） |
| **G-5** | `F-5` ≍ `N-5` ≍ `N-6` ≍ `G3` ≍ `F2` ≍ `F7` ≍ `A-F-4` ≍ `N-9/N-11` | 全是「文本滞后/错误/悬空」；无一处涉及行为 | 一次文档同步批（**可合并同批，但须错峰**：改 `lib/**` 注释触 15 组回拷，见 `engine-status…§7.3 audit F-4`） |
| **G-2** | `F-6a` ≍ `f-04` ≍ `F1` ≍ `F3` ≍ `G2` ≍ `A-F-1/N-7/N-8` ≍ `F-7` | 共因 = 「改前样本未落盘 + 账目口径混源」 | 立一条**通用前置纪律**（动手前落全量哈希基线 + 改前快照随产物落盘），比逐条补更省 |
| **G-6** | `G1` ≍ `D-1` ≍ `f-02` ≍ `N-9` | 都是「渲染视图 vs 原始字节」的编号精度 | 已由 `G1` 写成纪律（本稿 §0 贯彻）；`f-02/N-9` 已闭合 ⇒ 可结项 |
| **G-1** | `F-1` ≍ `F-2` ≍ `f-03` ≍ `UV-1` ≍ `G5` ≍ `G6` ≍ `U1` | 都等「一次宿主重载/启动」 | 一次窗口整批翻（`engine-status…§6` 已示范） |
| **G-7** | `U1–U5` ≍ `UV-3` ≍ `U2`（跨进程） | 都缺真机读数 | 排「最小真批（2–3 lane）+ 真机派发冒烟」一次取证 |

### 3.2 冲突 / 互斥矩阵（做了 A 就不必做 B；或做了 A 会让 B 变错）

| # | A | B | 关系 | 判据 |
|---|---|---|---|---|
| **X-1** | **`template.consume`**（③-a，新增声明键） | **删 `criteria_from`**（用户已裁，蓝图 §10.36） | **方向冲突**（A 加声明面、B 减声明面） | `presets/software-team/team-asset.yml` 键集已从 `{criteria_from, consumes_required, verdict}` **删成** `{consumes_required, verdict}`（蓝图 §10.36 读数：`D49000D0…`→`1377ADE5…`）；回落面 `lib/state/gates.js:732-737`（空 `criteria_from` ⇒ `isPlanProduct`） |
| **X-2** | **F-6 双路读**（O-04，读端兼容层域） | **O-1 落点统一**（G-4 文本面 + 任务包模板） | **互斥**：A 给「错落点」发长期许可，抵消 B 的统一效果；且 A 引入**误绿**（层域含交付物）与**跨 lane 串味** | 读端收窄理由写死 `lib/watch/lane-heartbeat.js:774-777`；蓝图 §10.26 U-3 已裁「不立引擎项」 |
| **X-3** | **M5′（舍弃 `chain.step`）** | **`replay.js` 重放判据**（`chain.step` 作唯一「已推进」证据） | **强依赖 ⇒ 做 A 必先做 B 的替代**（CH-3） | `lib/engine/replay.js:69`（`hasAdvancedSince` 读 `EVT_CHAIN_STEP`）；CH-3 明确列 M5′ 硬前置（`handoff-semantics §10.2`） |
| **X-4** | **M5′** | **CH-1（`phase.reason`）** | **前置关系**（CH-1 已在，M5′ 才可谈） | CH-1 已落地：`lib/tools/core.js:836` + `lib/engine/chain-runner.js:390-395` ⇒ **该前置已解**，M5′ 只剩 CH-2/CH-3 |
| **X-5** | **M3（推进改挂交接）** | **`leader-direct` 批推进 no-op**（M0′-①） | **作用域互斥（不是矛盾）**：`leader-direct` 批永不走引擎推进 ⇒ M3 只对 `raise` 批有意义 | no-op 早退 `lib/engine/chain-runner.js:153-157`（先于相位闸） |
| **X-6** | **`leader-direct` 形态 + 引擎自派** | **官方 `raise` 形态（Manager 代管）** | **运行期互斥**：no-op 早退在**任何**自派判定之前 ⇒ 只要 `leader-direct`，链自派不可能发生（**即使 `ctx.subagents` 可用**） | 同上 + `lib/tools/core.js:1196` 的触发点仍会调用（返回 no-op） |
| **X-7** | **并发闸（自建容量）** | **官方 `maxMembers` 槽位** | **刻意不同轴、不合并**（不是冲突，是**边界**：不可互为代理） | `lib/engine/dispatch.js:171-204`（§6/§8 轴边界：不读 `agentTeams`/`maxMembers`/`laneExempt`/锁） |
| **X-8** | **`member.*` 八态（引擎）** | **官方 roster 5 态** | **真源冲突（当前以「标注」缓和，未解）** | `lib/tools/core.js:593-604`（明写「真源 = 官方 roster；八态 = 投影 ⇒ 标 legacy，**不改判定**」）；台账 `member-governance-redesign §9.1 W-4` |
| **X-9** | **`batch.handoffs` 自建黑板** | **官方任务板 `blockedBy`/`status`** | **双真源冲突（M-6 双写协议缓和）** | `lib/tools/core.js:1207/1229/1322`（`officialTaskId` **只读回显**，不参与判定）；台账 `W-5` |
| **X-10** | **`swarm_report`/`swarm_cc`（自建回报）** | **官方 `send_message` durable mailbox** | **通道重复**（唯一通道原则已裁，落地未做） | `member-governance-redesign §9.1 W-3`（「已裁唯一通道原则（对外投递归官方）」）；自建面 `lib/tools/core.js:1370/1408` |
| **X-11** | **官方 profile 禁 `subagent` 工具** | **引擎 `lane_dispatch` 走 `ctx.subagents`** | **表面冲突、实测不冲突**（服务仍在；被禁的是**工具**插件） | `.../agent-team-profile/cordis.patch.yml:4-14`（禁 `tool-subagent*`）× `dsh-base/cordis.patch.yml:328-329`（服务 `id: subagent` 仍挂）× `lib/index.js:86`（引擎声明 `inject: [...,'subagents']`）。**⚠️ 边界：`subagent` 工具的**模型可见性**在本会话无法核（见 §7） |

---

## §4 分类总表（核心交付）

> 分类判据（用户给定）：**技术债** = 不还就会**静默失效 / 误导 / 无法验收 / 重复真源**；**待增强备用方案** = 不做也不影响正确性，只是能力/效率提升；**观测项** = 过程/纪律/未验证面，既不改码也不改判定。
> 行号口径 = 原始字节（§0）。

| 编号 | 内容 | 类别 | 判定理由（为何落此档） | 证据（file:line） | agent-team 模式下 |
|---|---|---|---|---|---|
| **T-01** | **`rework` 计数恒 0**（读侧只认 `on.fail/on.conflict`，写侧白名单已删 `on.*`） | **技术债**（假判据） | 不还会**静默失效**：返工上限永不及触发，`rework.max_attempts` 成为**不生效的硬限** | `lib/engine/chain-runner.js:409`（判据）× `lib/assembly/chain.js:123`（写侧白名单）；台账 `F-3` | **保留**（官方任务板无返工计数概念：`types.d.ts:150-161` 仅 `reopen`） |
| **T-02** | **`template.consume` 不存在**，而团队资产与文本面**暗示** consume 属装配声明 | **技术债**（引导性误导 + 双真源风险） | 若有人按 ③-a 的设想在 `template` 里写 `consume` ⇒ **声明即拒**（好），但**文档/资产叙事**若不澄清，会持续诱导「链上声明 consume」；且新增该键会造出**第二个 consume 真源**（运行期真源 = 批次 tasks） | 校验器 `lib/assembly/chain.js:323-367`（只收 `id/cmd/produce`）、展开器 `:806-807`（明写 consume 不属本函数）；运行期真源 `lib/wave-plan.js:823/826`（tasks 的 `consume/produce`） | **变多余**（官方任务板不消费产物在场；「非盲审」落 audit lane 的 `consume` + entry 门，见 ③-a） |
| **T-03** | **`GATE_HANDOFF_MISSING` 入口/出口门缺省由 env 开关控制**，且有**真实批因此被暂停两次** | **技术债**（可复现的轨迹分叉） | 「门禁缺席 ⇒ 批次被暂停 + 需人工 resume」是**可验收性**问题：同一批的行为取决于一个 env，而 env **不在** `batch_status` 的既有读面（现由 `handoffGate` 键回显「缺省关不得隐形」） | 真批读数（§1.3 N-9，`cleanup-wave-20260918` 两条 `chain:`/`auto-settle:` 暂停）；开关真源单点 `lib/wave-plan.js:682`（`handoffGateEnabledOf`，真源 = `<root>/config/runtime.json` 的 `gates.handoff`）+ 回显面 `lib/tools/core.js:956-960`（`handoffGateView`：`{enabled, settle, entry, source}`） | **保留**（官方无产物在场概念：`TeamTaskView` 只有 `writeScopes`，`types.d.ts:67-78`） |
| **T-04** | **链声明（`chain.steps/branches/pair_with`）与批次 lane 声明（`wave_plan.tasks`）无一致性校验、且链声明无运行期消费者** | **技术债**（重复真源） | 真批已证两者可系统性不一致（§1.3 N-6：声明 3 exec lane + pair 3 audit lane，实批 1 聚合 audit lane），而**建批期不拦**（拦在运行期 `no-lane-for-step`，`lib/engine/chain-runner.js:247-251`）⇒ 同一事实两处声明、无同步器 | `lib/assembly/chain.js:812`（展开器未接线，§1.3 N-5）；建批入口 `lib/wave-plan.js:734`（`buildWavePlan`，无链参数） | **改写**（官方面为 `team_task_*` 声明 + `blockedBy`；本项应收敛为「**单一拓扑声明**」= M2′ 的目标） |
| **T-05** | **分支级 `template.cmd` 是死声明**（展开器只读步级 `template.cmd`，而五队步级模板都不含 `cmd`） | **技术债**（写了不生效） | 判据直接命中「写了不生效」：`lib/assembly/chain.js:842` 读 `tpl.cmd`（步级），分支级 `cmd` 无人读；当前**无错误行为**仅因展开器未接线 ⇒ 一旦接线即全空 | 展开器 `lib/assembly/chain.js:842`；五队资产分支行（如 `presets/software-team/team-asset.yml:81/82/92`）；台账 `GAP-S12`/`F-4` 同族（`§10.25` R-1 实证） | **改写**（接线为建批来源时同批修） |
| **T-06** | **引擎 `dispatch.provider` 不在热更白名单**，`runtime.json` 无 `dispatch` 段 ⇒ 「热更快照」注释对该键不成立 | **技术债**（注释与事实不符 ⇒ 误导） | 代码注释断言读的是热更快照（`lib/engine/dispatch.js:327`），但实测该键只能由插件 patch 静态配置（§1.3 N-3）⇒ 运维按注释改 `runtime.json` **不会生效** | `packages/dsh-punky-swarm/cordis.patch.yml:23-24`；`~/.dsh/punky-preset/config/runtime.json`（三键，无 `dispatch`）；注释 `lib/engine/dispatch.js:327` | **变多余**（若切官方模式，自派 provider 概念消失） |
| **T-07** | **官方任务板只有「回显位」**：`officialTaskId` 写入交接记录却**从不被写、不参与判定** | **技术债**（形式化声明） | 形式上是「双写协议 M-6 的挂钩」，实质是**单向只读镜像**：写了键但无写者、无消费者 ⇒ 读端会以为双写已成立 | `lib/tools/core.js:1207`（参数）/ `:1229`（写入）/ `:1322`（回显）；台账 `W-5` | **变必须**（接官方任务板后，该键应从「回显」升为「双写真源 + 一致性检查点」） |
| **T-08** | **进度落点纪律仍被三处文本写错**（层域 / 第三种形态 `/exec/<lane>/progress/`） | **技术债**（误导 + 无法验收） | 读端**只认** `<lane>/progress`（`lib/watch/lane-heartbeat.js:768/778`）⇒ 按错文本落盘的成员，其进度对引擎**不可见**（`progressTsMs` 恒 null）⇒ `U-2/V-5` 永远无法验收 | 读端 `lib/watch/lane-heartbeat.js:768/778/1058/1208`；错文本落点：`skills/engine-team/SKILL.md:71-72`、`:80-81`（台账 `N-2`）、`skills/design-team/SKILL.md:133`（台账 `N-4`） | **变多余**（官方模式下「快照」不再是引擎活性信号；成员活性 = roster `status`） |
| **T-09** | **`chain.step` 事件在 `leader-direct` 批里永不产生，但读端仍以它为一等公民** | **技术债**（真源悬空） | `batch_status.chain.edges` / `replay` 的判据都建在这个事件上；27 批里 22 批该事件计数 0（§1.3 N-4）⇒ 读端在主流形态下**恒空**（不算错，但「回显已推进」的能力名存实亡） | 写点 `lib/engine/chain-runner.js:361`（被 `:153` 早退吞掉）；读端 `lib/assembly/chain.js:897`、`lib/engine/replay.js:69`、`lib/tools/core.js:972` | **变多余**（官方侧推进事实在 `team/task` / `team/member` 事件，`types.d.ts:177-205`） |
| **T-10** | **`member.*` 八态 × 官方 roster 5 态双真源**（现仅「标注」，判定仍走八态） | **技术债**（重复真源） | 「同一成员两处状态」是台账自认冲突（`W-4`）；标注缓解可读性，但不解决「谁说了算」——`member_settle` 会让引擎态与 roster 态分叉 | `lib/tools/core.js:593-604`（`MERGE_STATE_SOURCE` / `MEMBER_STATES_LEGACY`）；`lib/schema.js:17/23/48`；台账 `W-4` | **变多余**（官方模式下应只读 roster；引擎八态退为 lane 级投影或删） |
| **T-11** | **官方任务板 `blockedBy`/`ready` 与引擎 `deps` 双真源**（M-6 双写未落） | **技术债**（重复真源） | 两处各写一份 DAG（台账 `W-5` 自认）；且官方 `readiness` **不启动 owner**（只回显 `ready`）⇒ 即便双写，唤醒仍缺 | 引擎面 `lib/wave-plan.js:823/826`（tasks deps）+ `lib/state/gates.js` entry 门；官方面 `types.d.ts:63/76`（`blockedBy`/`ready`）、`tool-agent-team/lib/index.js:395-437`（`team_task_list` 只回显） | **变必须**（接官方后成为唯一拓扑声明） |
| **T-12** | **`swarm_report` / `swarm_cc` 与官方 `send_message` 通道重复**（唯一通道原则已裁未落） | **技术债**（通道重复 + 同名不同物风险） | 台账 `W-1`（`dispatch-register` 观察名单含**同名** `send_message`、取 `args.subagent_id` ⇒ 官方调用取不到 ⇒ 误登记风险）与 `W-3`（双通道）同族 | 自建面 `lib/tools/core.js:1370/1408`；观察名单 `lib/bridge/dispatch-register.js`（`W-1` 引 `:35`）；官方面 `tool-agent-team/lib/index.js:289` | **变必须**（改写入官方 durable mailbox；自建面收窄为引擎告警） |
| **T-13** | **`chain.step` 与声明 `chain.steps[]` 同名，且 `next`/`deps` 双轴并存无冲突校验** | **技术债**（消歧 + 双真源） | 与 T-09/T-04 同族但**独立可判**：M5（改名）与 M2′（双向链表 + 矛盾报码）各自解决一半；今日 `no-lane-for-step`/`no-paired-lane` 停轮就是「静默取一」的后果 | 事件名 `lib/state/event-types.js:260`；声明解析 `lib/assembly/chain.js:174-182`（`edgesOfStep` 只产 `next` 边）+ `:475-478`；台账 §3「改名消歧」 | **变多余**（官方下推进事实另有载体，见 T-09） |
| **O-01** | `template.consume` 字段（让 audit 非盲审成资产默认） | 待增强备用方案 | 现状已由两处门禁承住 ⇒ 不做无正确性损失 | 见 ③-a | **变多余** |
| **O-02** | 建批期加一条**校验**：audit lane 的 `consume` 须覆盖被指上游步的 `produce ∪ outputs`（零新声明键） | 待增强备用方案 | 用**校验**替代**声明键**，成本远低于 O-01 | `lib/wave-plan.js:552-574`（既有 audit 锚点门可扩） | **改写**（官方模式下改为任务板 `blockedBy` 一致性检查） |
| **O-03** | 分支级 `template` **回退**（分支级 `produce`/`cmd` 优先、步级兜底） | 待增强备用方案 | 不解决当前错误（无消费者），却引入新优先级语义；**须与「链声明是否接线」同批决定** | 见 ③-b | **变多余** |
| **O-04** | **F-6b 双路读**（读端同时扫描层域旧路径并与 lane 域取最新） | 待增强备用方案 | 收益只在历史批/不守纪律成员，代价是**误绿 + 跨 lane 串味**（违反探针「宁缺勿假」） | 见 ③-c；`lib/watch/lane-heartbeat.js:774-777`（收窄理由） | **变多余** |
| **O-05** | 并发闸「**自动排队**」（Q-HC1 方案 B；当前口径 = 直接拒） | 待增强备用方案 | 不影响正确性（拒 = fail-closed）；只是效率/体验提升 | `lib/engine/dispatch.js:171-204`（当前「超限直接拒、零写入」）；`gap-list §4` 记「后期迭代」 | **保留**（自建容量与官方槽位不同轴，见 X-7） |
| **O-06** | `merge-agent`（worktree 冲突 LLM 化解）当前 `enabled:false` | 待增强备用方案 | 关闭时路径完整（保留现场 + 冲突清单） | `packages/dsh-punky-swarm/cordis.patch.yml:62-71` | **保留** |
| **O-07** | 官方任务板**双写**（M-6 全量：`team_task_create` → `officialTaskId` 回填 → 一致性检查点） | 待增强备用方案（**接官方前置**） | 「只写引擎黑板」当前正确；双写是**接官方后的必须**，今日不做不产生错误 | `lib/tools/core.js:1207/1229/1322`；`member-governance-redesign §7.1` | **变必须** |
| **O-08** | `lane_longrun` 探针接入官方 roster（补 `W-11` 覆盖缺口：官方成员 unbound ⇒ 引擎探针看不见） | 待增强备用方案 | 观测能力缺口，不影响判定 | 台账 `W-11`；探针 `lib/watch/lane-heartbeat.js` | **变必须** |
| **O-09** | 引擎侧**难度门禁**（`assign_check` / `EXEC_TOOLS`）覆盖官方派发轨 | 待增强备用方案 | 台账 `W-7` 已实测「官方轨道无难度门禁」；当前以 Leader 纪律兜 | 台账 `W-7`；门禁面 `lib/governance/*` | **改写**（官方轨须另找挂点，或明确放弃） |
| **O-10** | 引擎 `toolFilter` 收窄对**官方产生的成员**是否生效（探针） | 待增强备用方案 | 台账 `W-6` 标「未实证」 | `lib/engine/dispatch.js:20-24`（收窄通道分析）；台账 `W-6` | **变必须**（须实测，见 §7） |
| **Q-01** | 宿主重载窗口（一次翻掉 G-1 组 ~10 条未验证面） | 观测项 | 过程/验证面，不改码 | `gap-list §1.3 F-1/F-2`、`§1.4 f-03`、`§1.6 G5/G6`；`engine-status…§6`（已示范一次） | 保留 |
| **Q-02** | 真机验证批（最小 2–3 lane）+ 真机派发冒烟（翻 G-7 组） | 观测项 | 同上 | `engine-status…§10.35`（U-2 验证配方）；`gap-list §1.8 U1–U5` | 保留 |
| **Q-03** | `.yml/.json` **原始字节行号**纪律落地（写进判据源与 `docs/**` 规范） | 观测项（**本稿已用**） | 过程纪律 | `gap-list §1.6 G1`、`:105 D-1` | 保留 |
| **Q-04** | 改前样本**先落盘归档** + 动手前落全量哈希基线 | 观测项（流程） | 过程纪律（G-2 组共因） | `gap-list §1.3 F-6a`、`§1.4 f-04`、`§1.6 G2`、`§1.8 F1/F3` | 保留 |
| **Q-05** | 基线/账目口径纠正（ROOTS 口径、asserts 并入 tests 段、mtime 单证表述） | 观测项（证据强度） | 表述与证据级别问题 | `gap-list §1.5 A-F-1/N-7/N-8/G-2`、`§1.4 f-01` | 保留 |
| **Q-06** | 文档漂移批（F-5/N-5/N-6/G3/F2/F7/A-F-4 + 16 处悬空包内 `docs/` 引用） | 观测项（文档） | 不改行为；须**错峰**（触 15 组回拷） | `engine-status…§7.3 audit F-4`；`gap-list` 各处 | 保留 |
| **Q-07** | 指引/任务包模板补「**配对基数口径**」（`pair_with` 基数 = 被指步在本批的 lane 数；多分支步只建部分 lane ⇒ 停轮 `no-paired-lane`） | 观测项（文档） | 本稿 ② 结论的落地动作（**非引擎改动**） | 本稿 §2.1.2；`lib/engine/chain-runner.js:259-266` | 保留 |
| **Q-08** | 跨进程并发无互斥（两台宿主共享同一 session 根） | 观测项（已知边界） | 已在代码登记为已知边界，不掩盖 | `lib/engine/dispatch.js:203-204` | 保留 |
| **Q-09** | `lib/**` 129 处、`test/**` 108 处「内部决策信息/批次 id」残留 | 观测项（发布面） | 发布卫生，非功能 | `engine-status…§7.3`（发布面 F-1 残留量） | 保留 |
| **Q-10** | `.wip-backup/`（8–10 件，含 277 KB）去留 | 观测项 | 已判「保留为回滚/证据资产至 X」 | `engine-status…§5 RC-6` | 保留 |
| **Q-11** | **链声明写了不生效的残余面**（链声明的 lane 名不在批内 ⇒ 静默判链外） | 观测项（与 T-04 同祖，独立登记以免被吞） | 当前无害（因无消费者），但是「写了不生效」的**潜势**，须在 T-04 落地时一并核 | `lib/assembly/chain.js:649-657`（v3 步只按「分支 id / 模板模式」认 lane，未命中即 `step:null`）；§1.3 N-6 | 改写（随 T-04） |
| **R-01** | 把 `expandChainBranches` 接线为建批来源（链声明自动生成 lane） | **不建议现在做** | 前置未满足：① 分支级 `cmd` 死声明（T-05）同批必先修 ② 链声明与批声明一致性口径（T-04/M2′）未定 ③ M2′ 未做 ⇒ 接线即把「双真源」固化成「单真源但语义未定」 | `lib/assembly/chain.js:812`；`:842`（T-05）；M2′ 未做（§2.2.1） | **不建议**（官方模式有替代：任务板 `blockedBy`） |
| **R-02** | research-team 形态重设计 / 面板「治理配置」页重做 | **不建议现在做** | 用户已裁「搁置」（恢复条件由用户定） | `engine-status…§3 TD-14 / TD-20` | 不建议 |

---

## §5 agent-team 模式重评专节

> **前提重申**：用户点出「实施仍在 subagent 模式，官方 agent-team 能力面（roster、任务板、消息、长生命周期成员）尚未接进实施」。**本稿实测补一层**：官方 profile 已在役（§1.3 N-1），且**已把宿主 `subagent` 系工具插件禁掉**，只留引擎侧 `ctx.subagents` 服务（§1.3 N-2）——即**两种模式的物理载体同时在场**，引擎仍只用了自建那一套。

### 5.1 三分类：**变多余 / 变必须 / 需改写**

#### 5.1.1 **变多余**（切官方后应删或冻结——**你据此决定哪些不必还**）

| # | 机制 | 为什么变多余（证据） |
|---|---|---|
| **D-1** | **引擎自派面**：`lane_dispatch` 句柄 + `dispatchLaneCore` + `buildStartSpec` | 官方模式派成员用 `spawn_teammate`（`tool-agent-team/lib/index.js:244`）；且官方 profile 已禁 `subagent` 工具（`agent-team-profile/cordis.patch.yml:10-14`）⇒ 「自派 worker 走 `ctx.subagents`」在官方轨**无对应物**（台账 `C-2` 已认「引擎派发在官方轨道无对应物」） |
| **D-2** | **`member.*` 八态状态机 + `member_status`/`member_settle` 的**成员身份**语义 | 官方 roster 5 态为身份/状态真源（`types.d.ts:42-52`；`lib/tools/core.js:593-604` 自认）；切换后引擎八态在成员层**冗余**（但其 **lane 级产物门禁语义**仍活，见「需改写」） |
| **D-3** | **句柄面**（`lane-handle` 一次性 token + TTL；「仅发句柄」降级） | 句柄是「人工直派形态的凭证」，其存在前提 = 引擎自派；官方模式下成员由 roster 具名寻址（`target: <name>`，`types.d.ts:132-136`）⇒ 句柄无消费者 |
| **D-4** | **`chain.step` 事件 + `batch_status.chain.edges` 作为推进真源** | 官方侧推进事实在 `team/task` / `team/member` / `team/message/*`（`types.d.ts:177-205`）；且该事件在主流形态下**计数恒 0**（§1.3 N-4）⇒ 已是「名存实亡」 |
| **D-5** | **进度快照（`<lane>/progress`）作为活性信号**（T-08 + F-6b 整族） | 官方模式下活性 = roster `status`（`running/idle/inactive`，`types.d.ts:46`）⇒ 无需扫盘；**⇒ T-08 / O-04 / F-4 / G7 / UV-4 / U-2 这一整族（涉 §2.4 的 G-4 组）切换后自然消失，不必还** |
| **D-6** | **引擎 `dispatch.provider` 配置面**（T-06） | 自派消失 ⇒ 该键消失 |
| **D-7** | **`swarm_report`/`swarm_cc` 作为成员→Leader 通道**（T-12 的「自建通道」部分） | 官方 `send_message` 持久化 + 投递即持久（禁重发）⇒ 唯一通道原则落地后自建通道收窄为引擎告警面 |
| **D-8** | **引擎难度门禁的「派发前」语义**（O-09 的现状形态） | 官方轨派发不走 `EXEC_TOOLS`（台账 `W-7` 实测）⇒ 现形态在该轨不可达（须改写，非保留） |

#### 5.1.2 **变必须**（切官方后应补）

| # | 机制 | 为什么变必须 |
|---|---|---|
| **M-1** | **官方任务板双写**（`team_task_create` + `officialTaskId` 回填 + 一致性检查点） | 今日 `officialTaskId` 只有回显位（T-07）⇒ 双写是接官方后**唯一**能把官方任务板纳入治理的路径（台账 `W-5`） |
| **M-2** | **`blockedBy` ↔ `deps` 一致性校验**（T-11） | 官方 `readiness` **不启动 owner**、只回显 `ready`（`tool-agent-team/lib/index.js:395-437`）⇒ 依赖正确性**完全依赖写入方**，必须校验 |
| **M-3** | **唤醒路径**（交接成立 ⇒ `send_message` 唤醒下游） | 官方无自动唤醒 ⇒ **M3 的「推进改挂交接」在官方模式下是唯一可行触发**（本稿 §2.2.2 已论证） |
| **M-4** | **roster 只读承抽扩展**（现只有 `managerRosterOf`，`lib/tools/core.js:567`） | 官方模式下成员/状态/寻址全在 roster ⇒ 必须扩为「成员面唯一读端」 |
| **M-5** | **官方成员的工具面收窄实证**（O-10 / 台账 `W-6`） | 引擎 `SUITE_DENY_TOOLS`/`toolFilter`（`lib/engine/suite.js`、`lib/engine/dispatch.js:113`）在官方成员上**是否有作用未实证** ⇒ 若不生效，则「成员不能碰治理工具」这条不变量**在官方轨失守** |
| **M-6** | **官方成员的长跑监管**（O-08 / 台账 `W-11`） | 官方成员天然 unbound ⇒ 引擎 `lane_longrun` / `lane_heartbeat` **看不见它们**（现探针按 lane 归属 + `member.dispatch` 判绑定，`lib/engine/dispatch.js:422`） |
| **M-7** | **官方成员的产物在场门禁挂点** | 官方任务板**无产物/变更概念**（台账 `C-3`）⇒ 引擎的 `produce ∪ outputs` 在场门（`lib/state/gates.js` targets/exit 面）必须**自己找挂点**（现挂在 `member_settle` 上，官方轨不走它） |

#### 5.1.3 **需改写**

| # | 机制 | 改写方向 |
|---|---|---|
| **Rw-1** | `member_settle` 一肩挑「成员结算 + 产物门禁 + 链推进」三职（`lib/tools/core.js:1187-1202`） | 拆三：① 成员结算 → 官方任务板 `complete`（CAS：`expected_revision`，`tool-agent-team/lib/index.js:460-463`）；② 产物门禁 → 挂在「交接/交付」事件（今日 `handoff_submit`，`lib/tools/core.js:1205`）；③ 推进 → M3 交接触发 |
| **Rw-2** | M4 策略迁移的**目标位** | 子代理模式迁**批次声明**；官方模式应迁**批次声明 + 任务板 `blockedBy`/`writeScopes` 双写**（`types.d.ts:63-64`） |
| **Rw-3** | M5′ 语义：从「**舍弃** `chain.step`」改为「**冻结新增 + 保留兼容读**，待官方模式定型再定去留」 | 该事件仍是子代理模式下唯一推进留痕（`replay.js:69`） |
| **Rw-4** | `batch.handoffs` 黑板 ↔ 官方任务板映射 | 逐边映射：`from/to` → 上游/下游任务；`artifacts` → `writeScopes`；`assertions` → 官方任务 `description`（官方无 assertion 位，见 §7 未验证） |
| **Rw-5** | 并发闸（自建容量）与官方槽位（`maxMembers`）的**关系口径** | 今日刻意不同轴（`lib/engine/dispatch.js:196`）。切官方后「谁是真容量」必须重裁：留双轴，或收敛为官方槽位 |

### 5.2 **切换后会自然消失的技术债**（省得白还）

| 技术债 | 为何消失 | 但**注意**（不可盲目跳过） |
|---|---|---|
| **T-06**（`dispatch.provider` 非热更） | 自派面消失 | 若**保留**双轨（用户已裁双轨分离），该债仍活 ⇒ 只在「全切官方」前提消失 |
| **T-08**（进度落点文本错） | 快照不再是活性信号 | 若快照仍作**人读证据**，文本错仍是误导（降为文档债） |
| **T-09 / T-13 的「事件承载推进」部分** | 官方另有事件载体 | 其**「双轴无冲突校验」部分**转为 M2′（仍要做） |
| **T-10 / T-11 的「双真源」** | 若真切官方且引擎态退为投影 | **只有真删引擎态才消失**；若保留双写，双真源**加重** |
| **T-12 的自建通道** | 唯一通道原则落地 | 官方 `send_message` **投递即持久、禁重发**（`types.d.ts:132-141`）⇒ 自建 mailbox 的 ack/重发语义与之冲突，须先对齐再删 |
| **Q-08**（跨进程无互斥） | 官方 roster/journal 由宿主单点承载 | **仅当**所有写路径都走官方；引擎侧文件写面（批次 JSON/黑板）仍无互斥 |

---

## §6 建议实施序

> 门禁口径沿用既有纪律：**全量套件回绿 + `--check` 不下降 + 五队资产零改动仍可建批/派发/交接（回归面）+ 真批冒烟**（`handoff-semantics §7`）；写域互斥、基线单写者 = Leader（`blueprint §10.5`）。

### 档位 1：**必须先做（技术债）**——按依赖排序，一次一条

| 序 | 项 | 依赖 | 门禁 / 判据 |
|---|---|---|---|
| **1** | **T-08 文本面落点统一**（G-4 组的文本部分：`skills/engine-team/SKILL.md`、`skills/design-team/SKILL.md:133` + 权威清单 12 处） | 无（零码改动） | ① 读端行号逐条对得上（`lane-heartbeat.js:768/778`）② `check-guidance-sync` GREEN ③ repo↔live 双副本同 sha |
| **2** | **T-01 rework 计数换口径**（= CH-2，随 M4 一并） | M4（策略迁批次级）同批 | ① 既有策略行为逐字不变（同判据回归）② 计数在真实批可读出 ≥1（R2 回边预算段有触发路径） |
| **3** | **T-04 + T-05 + O-03 合并决策**：链声明与批次声明的**关系**定案（接线 or 只做校验 or 弃用声明） | **须先做决策**（见下「等 agent-team 定型」） | ① 若接线：分支级 `cmd`/`produce` 回退同批落地 + 全 5 资产 + 反投影自证（`chain.js:876-882`）② 若只校验：一致性问题在建批期拒（新码或复用 `MISSING_FIELD`） |
| **4** | **T-02 `template.consume` 口径澄清**（**不做字段**，只把「consume 归 tasks、不归 chain 模板」写成单点口径；并把「audit consume 须覆盖上游 produce∪outputs」登记为 O-02） | 无 | 全仓零新增声明键；`UNWIRED_DECLARATIONS` 仍为 `[]`（`lib/assembly/team-asset.js:146-163`） |
| **5** | **T-12 + T-07 通道/回显面诚实化**：`officialTaskId` 若短期不双写，则**降为「未启用」显式标注**；`swarm_*` 与官方通道关系写进文档 | 无 | 读端不出现「看起来已双写」的误导 |
| **6** | **Q-03 / Q-04 纪律落地**（行号字节口径 + 改前归档/全量基线） | 无 | 已在 `gap-list §1.6 G1` 立项；本稿即示范 |

### 档位 2：**可后做（增强）**

| 序 | 项 | 依赖 | 门禁 |
|---|---|---|---|
| 7 | **O-02** audit `consume` 覆盖校验 | T-02（口径澄清） | 不新增声明键；`GATE_AUDIT_INPUT_MISSING` 语义不放松 |
| 8 | **O-05** 并发闸自动排队（若仍要） | 用户裁决（当前口径 = 直接拒） | 不得改变「超限零写入」（`lib/engine/dispatch.js:193-195`） |
| 9 | **O-08 + O-10** 观测增强（官方成员监管探针 + 工具面收窄实证） | **等 agent-team 定型** | 探针不改成员状态（既有纪律） |
| 10 | **M2′**（`next` 双向链表 + 至少一头 + 矛盾报码） | T-04 定案 | 真删判据 ①②（`handoff-semantics §8.2 ④`） |
| 11 | **M3**（推进改挂 `lane.handoff`） | M4（含 T-01） | 真批：交接成立即派；缺交接仍拒 `GATE_HANDOFF_MISSING` |
| 12 | **M5′（改写版）**：`chain.step` 冻结新增语义 + 读端兼容 | **CH-2（序 2）∧ CH-3（读端迁移）** | CH-3 未做前不动（`handoff-semantics §10.2`） |

### 档位 3：**不建议做（备用）**

| # | 项 | 为什么不做 |
|---|---|---|
| 13 | **R-01** `expandChainBranches` 接线为建批来源 | 前置（T-05 死声明 + T-04 口径 + M2′）全未满足；接线会把「双真源」固化为「单真源但语义未定」 |
| 14 | **O-04** F-6b 双路读 | 误绿 + 跨 lane 串味（`lane-heartbeat.js:774-777`）；U-3 已裁「不立引擎项」 |
| 15 | **O-01** `template.consume` 字段 | 逆「删 `criteria_from`」方向 + 造第二真源 |
| 16 | **O-03** 分支级 `template` 回退（单独做） | 无消费者时纯增语义；**并入序 3 的决策**，不单独立项 |
| 17 | **R-02** research-team 形态 / 面板治理配置页 | 用户已裁搁置 |

### **显式标注：哪些项应等 agent-team 模式定型后再定**

| 项 | 为什么不现在定 |
|---|---|
| **M4 的「迁到哪」**（批次声明 vs 任务板双写） | 取决于官方任务板是否成为真源（T-11 / O-07）；今日双写未落 |
| **M5′ 的「删否」** | 取决于官方侧推进事件是否成为唯一载体 |
| **T-09 / T-10 / T-11 / T-12（四类双真源）** | 「双真源」的解法是「删一侧」还是「双写 + 检查点」，取决于官方面接得多深 |
| **Rw-5 并发闸 vs `maxMembers`** | 需要一次「双轴 or 收敛」的用户裁决 |
| **X-11 的实证面**（官方禁 `subagent` 工具 vs 引擎依赖 `ctx.subagents` 服务） | 需一次真机探针（见 §7），否则「双轨是否真并存」无法定论 |
| **O-09 难度门禁在官方轨的挂点** | 台账 `W-7` 已实测「无挂点」，改写的目标形态取决于官方是否有等价钩子（未知） |

---

## §7 未验证 / 未知（显式列出，**不预填结论**）

| # | 项 | 为什么未验证 / 未知 | 需要什么才能定 |
|---|---|---|---|
| **U-01** | **引擎自派在**当前宿主**上是否真能成功**（`ctx.subagents.startContinuable` 可用性 + 是否真 spawn 出 child） | 未实跑派发（本会话为**只读调研**，且任务禁止执行型动作）。可确证的**间接面**：`member.dispatch` 事件带 `workerSessionId`（§1.3 N-8）——但该事件有**两个写点**（自派 `dispatch.js:389` × post-execute 观察器 `dispatch-register.js:88`，同事件同形状），**读端不可区分** ⇒ 无法据此判定是「引擎自派成功」还是「旁路登记命中」 | 真机跑一次 `lane_dispatch`（或读当时进程日志）+ 区分两写点（建议给事件加来源字段后复测） |
| **U-02** | **`inject: ['tools','webServer','subagents']` 在官方 profile 下是否造成加载失败** | 官方 profile 禁的是 `tool-subagent*` **工具**插件，服务插件 `id: subagent` 仍在（§1.3 N-1/N-2），**推演上不应失败**；但**未实测宿主启动日志** ⇒ 此为**推断**，非读数 | 读宿主启动日志/trace（`plugin tree` 是否含 `dsh-punky-swarm` + 是否报 `without inject`） |
| **U-03** | **本会话 `subagent` 工具是宿主可见还是仅本子代理工具面注入** | 本会话是**delegated subagent**，工具面 = 注入面 ⇒ **不能反推宿主主会话**；且本会话**不调用**该工具（禁止执行型动作） | 由 Leader 在主会话核 `tools_search`/工具目录，或读宿主工具注册清单 |
| **U-04** | **官方 `listMembers` 是否把宿主 `subagent` 工具拉起的 continuable child 计入 roster**（N-8 的 child 是否「官方成员」） | 未调用（`managerRosterOf` 只在工具执行路径被触发，本会话无批次） | 一次 `batch_status`（会回显 `managerRoster`）对照 `list_agents` |
| **U-05** | **`skills/engine-team/SKILL.md` / `skills/design-team/SKILL.md` 的**当前字节**是否仍含 N-2/N-4 所述误导文本** | 本会话未逐字复读这两个 SKILL 文件（`progress_contract` 已于 2026-09-18 退役 ⇒ 文本可能已随之修改）⇒ **不敢断言「仍是缺陷」** | 逐字读同 sha 的 repo + live 双副本 |
| **U-06** | **`chain.step` 在 `raise` 批里是否真的会产生**（是否只是「恰好没触发」） | 2 个 raise 批的 `chain.step=0`，但可能是「无链声明」「资产链非法」或「无人调 `member_settle` 之外路径」等任一原因；本稿未逐批追因 | 逐批读 raise 批的 `teamAsset.chain` 是否加载 + 是否有 `member.settled` 事件 |
| **U-07** | **官方任务板是否承载 assertion / 产物在场语义**（Rw-4 的映射可行性） | 官方 `TeamTaskSnapshot` 只有 `subject/description/blockedBy/writeScopes/status`（`types.d.ts:56-65`）⇒ 本稿据类型面推「无 assertion 位」；**未读官方实现js 确认 description 是否被结构化消费** | 读 `dsh-experimental-agent-team/lib/**` 实现（本轮只读类型面） |
| **U-08** | **并发闸的「跨进程无互斥」在真实双宿主场景的触发率** | 登记为已知边界（`lib/engine/dispatch.js:203-204`），**未实测** | 跨进程真跑（`gap-list §1.8 U2`） |
| **U-09** | **`baselines/**` 是否真的未纳入 VCS** | 本稿未跑 git 查询（禁 git 写；只读也未执行）⇒ 采信台账 `F-6a`/`f-04` 的自述 | 只读 `git status`/`git check-ignore`（**Leader 面**） |
| **U-10** | **`gap-list-20260917.md` 是否存在 §1.7** | 字节级读该文件 `:106` 后直接是 `:111` 的 §1.8 ⇒ 本稿判「不存在」；但**不排除**是整理时遗漏（非我能定） | 由 Leader 确认表格迁移历史 |
| **U-11** | **链声明 `pair_with` 指向「多分支但只建部分 lane」时的最佳行为**（停轮 vs 自动补建 lane） | 现状 = 停轮（`no-paired-lane`）——本稿判「无需改」，但**这是设计取向判断**，非实测结论；用户若要「自动补建」则为**新需求** | 用户裁决 |

---

## §8 一页摘要

| 面 | 结论 |
|---|---|
| **①②③④ 并入同一设计面** | 四条工作**同祖**：① 配对粒度 = 装配轴（今日无消费者）；② M 系列 = 拓扑/推进轴（3 项未做、1 项已做）；③ 引擎候选 = 同一批「声明面 vs 运行期真源」问题（③-a/③-b 皆因**链声明未接线**而悬空）；④ gap-list = 上述问题的**证据与留痕累积**。**⇒ 真正该做的不是四件事，而是一条主轴：把「声明面（chain）— 运行期真源（tasks/deps/handoffs）」的关系定案，并把挂在声明面上的死键一次性清干净。** |
| **① 的答案** | `pair_with` 是 `perLane` 别名、按**被指步在本批的每条 lane** 1:1 实例化（**不是**全链上游）；上游步**单分支** ⇒ **恰好 1 条 audit lane** ⇒ **确认无需改引擎**。反例（多分支只建部分 lane）走既有 `no-paired-lane` 停轮，正确。唯一遗留 = 文档口径（Q-07）。 |
| **② 的答案** | **M1 已落地、CH-1 已落地**；**M4 / M3 / M2′ / M5′ 全部未做**，且 **CH-2 已导致 `rework` 计数恒 0（真债）**。agent-team 模式下：M3 **更必要**（官方不自动唤醒）、M5′ 应**改写为冻结+兼容**而非删、M4/M2′ 保留。 |
| **③ 的答案** | 三项**均不建议现在做**（O-01/O-03/O-04）；其中 ③-b 分支级 `cmd` **是真死声明**（登记为 T-05，随 T-04 合并处理）；**不做不会立刻出错**，因为链声明**根本没有运行期消费者**（§1.3 N-5）——这正是 T-04 的判据。 |
| **④ 的答案** | §1.3–§1.8 共 **34 行条目**（含 F-6 消歧为 a/b）；同源合并为 **7 组**（G-1..G-7）；分类草案：**技术债 13 / 待增强 10 / 观测 11**（§4）。其中 **G-4（进度落点）与 G-3（rework 计数）是本批唯一「会静默失效」的两族**，其余多为留痕/验证面。 |
| **一句话** | **能力不缺口，缺口在「声明面无人读」与「两套真源并存」；切 agent-team 会让 T-06/T-08/T-09/T-10/T-11/T-12 整族自然消失——因此建议只先还 G-3 与 G-4 两族（各一条动作），其余按 §6 档位 3 挂起等定型。** |
