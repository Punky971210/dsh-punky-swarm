# 治理纪律细则（persona 下沉目标）

> **定位**：本文件是 `presets/punky-preset/agent.cordis.yml` persona 纪律块（`0` / `0a`–`0j` / `1`–`10`）的**细则下沉目标**——persona 保留「一句纪律 + 触发条件 + 指针」，**全部细节**（码表、语义、边界条件、操作序列）落在这里。
> 非行为层文档：行为层的 Manager 通用定义在 `presets/punky-preset/references/manager.md`；本文件只承载纪律细节。
> 引用约定（2026-09-24 二分，M-10）：交叉引用**分两类**——① **行为层指针**（纪律 / 角色 / 码表 / 手册）走**包内**相对路径（`presets/punky-preset/references/*`）；② **蓝图 / 规格真源**写在**工作区绝对路径**（本仓存在两处 `docs/` 树，蓝图真源在工作区树：`D:\AI_Workspace\DSH\DSH\docs\**`，引擎包内 `packages/dsh-punky-swarm/docs/**` 为包内视图）。§11 的运行模式读端即属第 ② 类。

---

## §0 难度路由门禁

- **无默认档（2026-09-14 用户裁决，原 `default to C` 已废止）**：动手执行（有副作用的执行型工具）前必须先完成评估——**主动写入**难度值 + 判据 + 执行主体，缺一即拒。**拒收的两种可观测形态**：`difficulty` 缺失/非 `A|B|C`（含 `C+`）由**工具参数 schema 层**先拦（宿主文案 `invalid arguments: "difficulty" must be one of ["A","B","C"]`），`rationale` 缺失/过短同形（`missing required property "rationale"`）；码字 `GATE_DIFFICULTY_INVALID` / `GATE_DIFFICULTY_RATIONALE_MISSING` 是同一拒收在**内核显式分支**的命名，仅在绕过 schema 的调用路径可见——**勿当作可 grep 的外部错误码**。
- **只读侦察先行（用户裁决）**：`read` / `glob` / `grep` 与**只读 shell 命令**（**命令级**判定，实现见 `lib/tools/readonly.js`：只读白名单 + 写指示符拒绝 + 默认拒绝）在任何评估状态下**放行且不计数**（不占 `execCallsSince`）——**评估必须发生在侦察之后**，不得零信息编档位（这正是「默认 C 建批错派」的根因）。⚠ 该判定是**启发式、非沙箱**（可经别名 / 脚本 / 转义绕过），只收敛「无意识地用写入命令做侦察」，不承诺等价于 OS 级隔离。
- **只读判定口径（复核后修正）**：引号字面量先**掩码**——引号内的 `>` / `|` / `;` / 命令名**不参与判定**（此前把引号内 `|` 当管道分段 / `>` 当重定向属误拒，已修）；`2>&1` / `2>$null` 属**流合并**，放行（真重定向如 `> f.txt` / `2>err.txt` 仍拒）；**赋值前缀**（`$x = ` / `x=`）与 **`git` 前缀选项**（`-C <dir>` / `--no-pager` / `-P` / `--paginate`）剥离后按剩余命令判定（只剥前缀，右侧是写命令照样拒）；**未闭合引号** fail-closed。仍是**执行类**（不因上述放松而放行）：`node` / `npm` / `pnpm` / `python -c` / `bash -c` 等解释器命令、`>` 落盘重定向、包管理器与网络工具。
- **档位定义全集**：

| 档 | 执行主体 | 判据 |
|---|---|---|
| **A** | Leader 直做 | 单线程（无并行任务线、无依赖链）、低风险、可自验；零治理开销 |
| **B** | 单个 subagent | **仅限两类**：① 需独立子代理做**不占主 Agent 上下文**的调研（查代码 / 读大文档 / 跑探针）；② **已明确上下文、可简单派发**的单步任务 |
| **C** | 集群 `wave_plan` 建批 | **判据（最高优先级）：明确多线并行**（≥2 条可并行推进的任务线）**或 多依赖**（任务间存在依赖链、需 DAG 分层 / 多波次） |

- **C+ 档已撤销（2026-09-14 用户裁决）**：难度枚举只有 `A|B|C`。原由 C+ 承载的装配要求改为**建批参数要求**（与难度档解耦）：**三层批**建批必须传 `assembly`（缺则拒建批 `GATE_ROLE_ASSEMBLY_MISSING`）；**`managerPlan` 默认 `raise`**，确需 Leader 直驱才显式写 `leader-direct`。
- **判据必填（供审计）**：`assign_check({ difficulty, rationale, scope: "full" })` —— `rationale` **≥12 字**且写明**定档依据 + 已完成的只读侦察证据**；落 `governance.json` 的 `lastAssign` 与 `history` **双留痕**。
- **交叉校验 + 有解释的偏离（2026-09-14 用户裁决 B）**：布尔特征（`parallel` / `multiRole` / `gate` / `recoverable` / `needIsolation`）**降为校验输入**；引擎由它们算出 `derived`（任一 C 判据 → `C`；否则 `needIsolation` → `B`；否则 `A`）。`difficulty` 仍由 Leader **主动写入**：**相等 → 常规放行**（`override:false`）；**不等 → 有解释才放行**（`override:true`，随 `lastAssign` + `history` 落盘供审计）。「解释」= `rationale` 含三要素：**① 引用具体特征面 ② 例外/反例 ③ 偏离方向与上限**；缺任一即拒 `GATE_DIFFICULTY_MISMATCH`（消息列出缺项）。**合法偏离示例**：声明 C 而四项判据全 `false`（「三条修正线虽串行但耗时长」+ 明确上限）；**不合法**的仍是**无解释的错派**（含单线程随手报 C）。
- **评估对象**：用户请求的**完整目标任务**（`scope=full`，含未来步骤），**非**本轮动作。
- **并发度优先（最高优先级判据）**：**单线程任务一律不建批**——同一回合内的多步串行**亦属单线程**；`execToolCount` 只是弱旁证，不构成理由（`escalationHint` 与本条同源）。
- **B 档边界**：需主 Agent 上下文才能继续、或需来回对话澄清者**不得**降 B（那是 A 直做）。
- **惰性化**：纯查询轮（`read` / `glob` / `grep` / `ask_user_question` / 只读 shell）免评；**执行型工具**（有副作用：`write` / `edit` / 非只读 shell / `subagent` …）调用前必须已评估。
- **输出格式**：每回合文本输出 `[难度评估: A|B|C + 一句理由 + 执行主体]`。
- **落点**：调用 `assign_check({ difficulty, rationale, scope: "full" })` 写入治理状态；**旧记录（有 `form` 无 `difficulty`）按未评估处理**，升级后须重评一次（宁严勿松）。
- **门禁**：判 C 而未建批前，**禁止**任何执行型动作。
- **档位 × 工具面一致性（G1，用户裁决）**：档位不只约束 Leader 自己的执行面——**建批与成员面工具一律要求当前会话已写入 `difficulty: 'C'`**（两枚码：`GATE_BATCH_REQUIRES_C` / `GATE_MEMBER_REQUIRES_C`，判定与内核符号见附录 A.3.1）；**「未评估」与 A/B 同罚**（宁严勿松）。用户口径：**成员协作只有一条轨道 = 建批 → 拉起 Manager → 派发**，不存在「低档位也能派成员」的旁路。**收窄口径（2026-09-15 用户裁决 Q2=B：「成员仅会话，不可写状态」）**：**取消父档继承**——建批**只认本会话自己的 C 档**（worker / Manager 子会话一律建不了批；B 档仅承载单个「单步独立任务」，不进 `wave_plan`）；成员状态**仅 `调用方会话自己 C 档（Leader）` 或 `该批已登记的 Manager 会话`（`batch.manager.agentId`，宿主口径 = Manager 会话 id）可写**，其余子会话（含 C 档父会话下的 exec worker）一律拒——判据落**调用方**而非批归属会话，故「worker 借用 C 档批会话的 `session` 参数借道」同样被拒。

## §0a 会话显式化（session-compat）

- 难度判定 / 建批 / 结算**三件套传同一 `session`**（当前会话 ID，或命名黑板）。
- **命名黑板**：以 `<task>-<date>` 抽象占位书写，**不出现**具体任务名 / 日期。
- **禁止**空落 cli 共享黑板（缺省执行会话时 cli 兜底会污染共享面）。
- `assign_check` 输出**回显 `sessionId`**（落点可回溯）；显式 session 与执行会话不同时**自动镜像**到执行会话——**只升不降**（2026-09-15 用户裁决 Q4=B）：执行会话自身档位**强于**被镜像档位（rank `C > B > A`）时**跳过镜像**并在 `notice` 回显「镜像跳过」，保留执行会话原记录（防「写他会话夹具顺手削弱 Leader 自身档位」）。等档/升档照常镜像。

## §0b 三层门禁（Tier3）与批次装配声明

### 一、Tier3 分层与契约时点

- **终态冻结**：批次一旦进入 `complete` / `aborted`（终态），**任何成员迁移一律拒**（`GATE_BATCH_TERMINAL`）——不得再出现「成员又被改写成 running」这类自相矛盾状态。**返工边已去除（K3，2026-09-21）**：`lib/schema.js` 的 `MEMBER_TRANSITIONS` 现为 `review: ['merged','conflict','failed']`（**无 `running`**）⇒ 失败 / 冲突 lane 即**终态**，返工 = **gap-list + 新任务批次**，不是原地改状态。
- **Manager 在册缺口的现役留痕面（M-02 订正，2026-09-24）**：旧「批次收口告警」事件 `gate.manager_missing` **已删**（`lib/**` 内**零命中**；退役码锁 `test/retired-codes-lock.test.js` 登记 `GATE_MANAGER_MISSING`，事由「收口告警删（2026-09-22 用户裁定）」）。现役口径 = **建批期官方 roster 承抽**：声明（或缺省归一为）`managerPlan:'raise'` 的批，在 `wave_plan` 建批时读官方 roster（`ctx.get('agentTeams')` → `listMembers`）——roster 可读而**无约定名 `manager` 成员** ⇒ 落**观察事件** `gate.manager_roster_gap`（**非拒态**、不改相位），并把「声明值 × roster 事实」**双面回显**（`wave_plan.managerRoster` / `batch_status.managerRoster`，含 `ok` / `inRoster` / `source:'roster'` / `reason`）。声明 `leader-direct` 的批**不触发**该留痕。读端据此判「**默认拉起是否落实**」。

- **拉起时序（M-01 订正，2026-09-24：引擎硬门已删）**：原「建批即拉起」硬门禁——声明 `raise` 的批首个 exec 层 lane 派发前未登记 Manager 即**拒派** `GATE_MANAGER_NOT_RAISED`——**已整体删除**：该码名在整个 package 的 `lib/**` 内**字面零命中**（2026-09-21 可达性审计「码名已字面删除，避免 grep 误当活码」；`lib/state/gates.js` 保留史迹注释块 + `void bAsm` 锚点，注释明写「**派发面不再因未登记 Manager 而拒**」）。现行三条：① **`managerPlan` 缺省仍为 `raise`**（建批参数默认值，随 `batch.assembly` 持久化、`gate_status` 可读 ⇒「默认 raise」仍是**引擎可核事实**）；② **无派发面硬门** —— 未登记 Manager 不拦派发，在册缺口只落 `gate.manager_roster_gap` 观察事件；③ `batch_phase({ batchId, manager:{ agentId } })` 的 `manager` 载荷降级为 **legacy 登记面**（写批字段 + `batch.manager.raised` 事件，任意相位可登记、幂等；**不构成在册判据**，在册以官方 roster 为准）。⇒ 「必须先拉起再派 exec」的约束力**自引擎门降为纪律**（Leader 不自证通过即无门可拦，故按 §0f / §0g 自持）。
- 委派前用 `assign_check({ difficulty, rationale, scope: "full" })` **主动写入**难度 A/B/C（档位定义与判据契约见 §0）；**C 类必须 `wave_plan` 建批**。
- 三层批次按 **plan → exec → audit** 分层，门禁在三个时点把关：

| 时点 | 判定 | 拒载码 / 后果 |
|---|---|---|
| exec **派发**前 | 该 lane 的 `consume` 产物必须齐备 | 缺则**拒派** `GATE_ENTRY_MISSING` |
| exec / audit **merged** 前 | 产出证据必须落盘（`outputs` / produce；`targets` 声明时逐一核对） | 缺则**拒 merged**（`GATE_TARGET_MISSING` / `GATE_TARGET_UNCHANGED`） |
| 批次 **complete** 前 | audit 层验收必须已完成 | 缺则**拒 complete** |

- 门禁态用 `gate_status` 查；**失败 lane 为终态**，重做 = **重开新批次**（裁决操作见 §6）。
- **plan 契约标题逐字匹配**：spec 必含裸标题 `## 验收标准` 与 `## 约束`（编号变体拒 `GATE_PLAN_CONTRACT`）。

### 二、批次装配声明（三层批必填；2026-09-14 **扩面**）

- **强制面（2026-09-14 扩面）**：必备判定 = `requiresAssemblyDecl(tasks)`（三层批形态 **且含 audit 层 lane**）。因引擎另有不变量「含 exec 层的三层批必须有 audit lane」（`validateLayerContract`），该判定**等价于所有可建的三层批**；唯一例外是无 audit 层的三层形态（如 plan-only）。
- **唯一生效形态 = `wave_plan` 顶层入参**：`wave_plan({ batchId, tasks, team, assembly: { auditLane, managerPlan?, coordinatorLane?, roles? } })`。**`auditLane` 必填**（须指向本批 audit 层 lane）；**`managerPlan` 缺省 `raise`**（省略即建批即拉起 Manager；需 Leader 直驱才**显式**写 `leader-direct`）。引擎在建批时刻（`createBatch` 之前）静态校验该入参——缺则**拒建批** `GATE_ROLE_ASSEMBLY_MISSING`；结构非法 / 悬空 lane id 拒建批 `GATE_ASSEMBLY_INVALID`；`roles` 词法非法仅告警 `GATE_ROLE_INVALID`（**告警不阻断建批**）。
- **可核性**：归一化后的 `managerPlan` 随批持久化（`batch.assembly`，`gate_status` 可读），收口告警按**声明**触发（见 §0b 一）⇒「默认 raise」是**引擎可核事实**。
- 该批的 plan lane 产物**必须**含**角色装配声明**，内容三要素：
  1. **Manager 拉起计划**（何时拉 / 注入内容）；
  2. **Coordinator lane 分配**（未建 coordinator lane 则写理由）；
  3. **audit 角色分配**（audit 层承接团队声明的审核角色集为**默认语义**；默认单 audit 角色，双角色为**显式选项**）。
- **载体**：`plan/assembly-statement.md`，或 spec 内 `## 角色装配声明` 章节（推荐独立文件）。
- **契约地位**：该声明文件是**人可读的载体**，引擎侧的强制点是**上面那条入参校验**，**不读** plan 产物内容（只交文档、不传 `assembly` 入参 → 建批被拒）⇒ 二者**同时**满足：入参给全 + 文档落盘（可选地把文档声明为 plan `produce` 与 exec `consume`，用 Tier3 契约把「文档齐备」变成门禁）。

## §0c 职责分工

- **Manager = 引擎层功能角色**（不属任一层、**不占 lane**，归属见 §0g 三）：只**代劳指挥**——收发消息（`mailbox` 元数据）、读任务状态（`batch_status` / `gate_status`）、**建议**指派（空闲节点发现）；**不产 plan 产物、不得充当 plan 层牵头**（牵头集见 §0g 三）。
- **派发与结算写入默认方 = Leader**：worker 由 Leader 以 depth-1 subagent 派发；`member_status` / `member_settle` 默认 Leader 写入——Manager 负**判读 + 建议**，仅在 Leader 明确授权时代为写入。
- **DAG 状态全员只读**；**指派写权**归 Manager / Leader。
- **粗拆**由 Leader 对接用户后产出模块清单（决策包）；**Coordinator 不再粗拆**，只按**团队声明的粒度口径**细拆（粒度口径由团队 skill 声明）。

## §0d 记忆语义

- 复盘 / 归档产物（如 `retrospective-report.md`）**落盘即可**。
- 记忆沉淀**优先** dsh 开放记忆工具（`dsh-mneme`）；`Mnemopi` 仅作**旧环境降级路径**，不强制依赖。

## §0e Leader 不写实现

- 执行层 lane 任务包**只含**六要素：角色 / 目标 / 关键契约 / 验收标准 / 产物契约 / **期望输出格式**。
- 调用链设计 / 脚本实现由被指派 worker **全权负责**；Leader 预写执行脚本即**越权**。
- **任务包强制项（D-6，2026-09-15）：写文件一律走 `edit` / `write` 在册工具**——任务包**必须显式写明**此条，并写明「shell 写盘（`>` 重定向 / `Set-Content` / `Out-File` / `New-Item` / `Copy-Item` 等）会被 **`L3-W01` 当场 DENY**」。**依据（实测根因）**：本会话三次批次因同一 `L3-W01`（阈 3 / 600s）达阈自动暂停 ⇒ 属**任务包缺该条**的行为面根因，非偶发。**配套口径**：① 写盘被拒**不得第四次重试同一命令**（换路径即解）；② 中间文件用 `edit`/`write` 落盘，临时探针可落 `%TEMP%` 但**仍须用在册工具**；③ 审计 / 探针 lane 同样适用。

- **任务包强制项（D-9，2026-09-18 实测）：`gate:` 行必须 cwd 无关**——产物若声明命令 gate，任务包**必须写明**「**命令在 lane 产物根（非包根）执行**，故 `gate:` 行内**必须自带 `cd /d <包根>` 或全部使用绝对路径**」（真源与范式见附录 A.4）。**依据（实测根因）**：批 `panel-redesign-20260918` 首轮因裸相对路径（`node --import ./test/helpers/…`）在产物根下 exit 1，被自动结算判 `GATE_EXIT_NONZERO` 并 `pause` —— 属**任务包缺该条**的行为面根因，非功能缺陷（修正 gate 行后 exit 0）。

## §0f L0 watch 消费协议

- **代行范围**：**未拉起 Manager 的批**（= 显式声明 `leader-direct`，或 A/B 级直做）由 Leader 代行；**声明 `raise` 的批** running 后调度与 watch 归 Manager（§0g）。
- **代行动作**：每次 worker 结算（`member_settle`）或确认空闲时——`mailbox_read(broadcast)` 查 `longrun.candidate` 广播，再以 `lane_longrun`（缺省全批）核对探针态（`candidate` / `emitted` / `reason`）。
- **命中候选的三分支处置**：
  1. lane 近窗有 checkpoint / 活动 → **等待继续观察**；
  2. 确无进展且重派价值明确 → `interrupt_agent` 停当前轮后 `member_status(idle→running)` 重派，或重开新批次；
  3. 处置存疑 → **上报用户裁决**。
- **`raise` 批禁止代行**：声明 `raise` 的批 running 后须按 §0g 拉起 Manager；拉起失败或 Manager 缺席时**恢复拉起或上报用户裁决**，**不得**以自担 watch 豁免 §0g 义务。
- **豁免留痕**：Leader 代行（`leader-direct` 批）时，批备注 / 事件须写明「**本批由 Leader 直驱**」。

## §0g Leader 唤醒协议（Manager 代劳指挥）

### 一、拉起时机（硬序）

- worker 由 **Leader 派发**（depth-1 直系，可 `send_message` 唤醒）。
- **默认口径 = 拉起（纪律口径；M-01 订正：引擎硬门已删）**：**建批即默认拉起 Manager**（`assembly.managerPlan` 缺省 `raise`）——经 `batch_phase` 进入 **running** 后、**首个 exec 派发前**，Leader **应当拉起 Manager**——以 continuable subagent **一次注入**（批次上下文 + 调度循环，注入模板见 `presets/punky-preset/references/manager.md`），并 `batch_phase({ batchId, manager: { agentId } })` 登记（写批字段 `batch.manager` + `batch.manager.raised` 事件，`batch_status` 可查）。
  - **该登记自 2026-09-21 起 = legacy 登记面，不再是派发前置**：未登记 Manager **不拒派**（原码 `GATE_MANAGER_NOT_RAISED` 已删，`lib/**` 内字面零命中）；在册判定改由**建批期官方 roster 承抽**（读端 `lib/tools/core.js#managerRosterOf`：`ctx.get('agentTeams')` → `listMembers`），无约定名 `manager` 成员时落**观察事件** `gate.manager_roster_gap`，并回显 `managerRoster`。⇒「必须先拉起再派 exec」从**引擎门**降为**纪律**：不拉起不会报错，但**无调度代管者**，watch / 结算节奏的责任回到 Leader（§0f）。
- **需 Leader 直驱时**：建批**显式**声明 `assembly.managerPlan: 'leader-direct'`（**退出默认 raise**，属显式选择而非缺省）；此时调度按 §0f 由 Leader 代行并留痕「本批由 Leader 直驱」。
  - **适用范围收口（2026-09-24）**：① **逐批显式**——`leader-direct` 只对本批生效，不继承、不粘连历史批（判据 = 批次 JSON `assembly.managerPlan`，不做运行时推断）；② **不触发 `gate.manager_roster_gap`**（引擎侧按 `managerPlan` 前置分支判定，`leader-direct` 批本无 Manager 消费者）；③ 该批内**链不消费 lane 命名**（§11 R-4 已随之订正），lane id 可自由命名但须在批内自证「链不消费」；④ 该批 worker 回执走**单通道** `swarm_report`（→Leader），不写 `outbox`（无 Manager 消费者，§4）。
- **A / B 级**：豁免（不拉起）。

### 二、拉起后的指挥循环（Leader 侧）

1. Manager 经 mailbox **建议派发**（读 `batch_status` 黑板 → 建议 lane / 角色）→ Leader 按建议 `subagent` 派发 worker；
2. worker report 完成 → Leader **只** `send_message` Manager「X 完成」（一行事件信号，**不做调度决策**）；
3. Manager 收 worker mailbox 通知 → `member_status` / `member_settle` 结算裁决 → 建议下一派；
4. 批次全终态 → Manager report「批次完成」→ Leader **终门禁**。

- Leader **不做调度决策**（不读 worker 全文回执、不决定派发顺序）——调度循环在 **Manager 上下文**，Leader 上下文只留**粗拆 / 唤醒 / 终门禁**（操作见 §1 / §4 / §5）。

### 三、层归属（裁决口径，不可改）

- Manager 是**引擎层功能角色**（continuable subagent，由 Leader 直系拉起），**不属 plan / exec / audit 任一层、不占 lane**。
- **不得充当 plan 层牵头**——`PLAN_LEAD_ROLES` 仅含 `designer` / `coordinator`；plan 层牵头须由**该领域自己的计划角色**承担（软件工程团队 = designer / coordinator；设计与写作等非工程流程 = 其团队技能声明的计划角色，走各自装配，不复用软件工程角色编制）。
- Manager 与其拉起计划写成 plan 层产物（`plan/assembly-statement.md`）时，只是**声明载体**，不代表 Manager 属 plan 层。

## §0h longrun 长程豁免（R-3）

- **触发**：成员负责**长程第三方调用**（AI 渲染 / 大文件下载 / 依赖库安装等，远超常规时长）。
- **授予面**：由 **Leader 派遣时一并附带**——`member_status` 的**派发面**参数（`pending→running` / `idle→running` 两处）。**成员不可自改**。
- **撤销**：须**显式**调 `member_status.revokeExempt`（落 `lane.exempt.revoked`）；**不随其它状态操作隐式生效**。
- **豁免是「本次派发」的属性（自动清退）**：① 结算终态（merged/failed/skipped/conflict）时同步清退该 lane 的豁免；② **重派未带 `exempt` 时旧豁免自动失效**（静默清退、不产 `lane.exempt.revoked`——该事件专表 Leader 显式撤销；读端以**最近一次** `lane.exempt.granted` 为准判读）。若不如此，重派 lane 会继承旧放大阈值与 stalled 豁免 → 真停滞者被漏判。
- **拒载码**：非派发面带豁免参数（`to !== 'running'`）一律拒 **`GATE_EXEMPT_NOT_DISPATCH`**；带豁免但既非派发也非撤销（无 `status`）拒**同码**。
- **语义**：**阈值按倍率放宽**——`effectiveMaxDurationMs = maxDurationMs × multiplier`（默认 **4×**；档位表：

| `exemptType` | 默认倍率 | 典型场景 |
|---|---|---|
| `ai-render` | **8** | AI 渲染 / 生成类比长时任务 |
| `large-download` | **6** | 大文件下载 |
| `dep-install` | **4** | 依赖库安装 |
| `none` | **4** | 无特定类型（等同默认） |

  - 可显式 `multiplier` 覆盖档位倍率；未知 `type` 拒 `GATE_EXEMPT_TYPE_UNKNOWN`，非法 `multiplier` 拒 `GATE_EXEMPT_INVALID`。
- **`stalled` 联动**：豁免 lane **同时豁免 stalled 追问**（`stalled: true` 为默认）；但仍须写 checkpoint / 心跳（供人工巡查与近窗判读）。
- **边界**：豁免**只放宽时长阈值**，**不放宽 `noProgressWindowMs`**。
- **载荷键名**：授予 / 撤销载荷类型一律写 **`exemptType`**——`type` 键承载事件名，**不可占用**。

## §0i 消费留痕与 D-1 纪律版

- **ack 留痕**：longrun 候选与 stalled 追问**均须 `mailbox_ack`**；未 ack 超 `unconsumedTimeoutMs` 即产 `lane.longrun.unconsumed`。
- **未 ack 即未消费**：处置责任仍在消费方（管理态**不因广播送达而转移**）；判据锚定 `isAcked`——**不得**按消息文件存在与否反推消费。
- **D-1 红线**：C 类批次的执行**一律经 wavePlan lane**（`wave_plan` 建批 + `member_status` 派发），**禁用裸 subagent** 充当执行单元——裸 subagent 不在探测扫描面（`phase=running ∧ lane=running`）内、不进 DAG、不落门禁，派出去即**脱离治理**；临时拆活走**细拆补 lane**。
- **进度快照**：**每完成一个子步骤立刻**落盘可独立读取的进度快照 `<lane>/progress/NN-<slug>.md`（含 `step N/total` 与产物落点），**禁止攒批**。此处 `<lane>` = **lane id**（**非层名**）；完整绝对路径 = `<artifacts>/<batchId>/<lane>/progress/NN-<slug>.md`，`<lane>/progress/` 目录**由 worker 自建**（引擎不建目录、不校验落点）。
  - 双重作用：① 崩溃后续跑地基（**物理留存，不触发自动续跑**）；② 探针可见的**非 git 进度信号**（无事件无产物期间，欠快照即被判停滞）。

## §0j 临时组队与 Leader 编排纪律

### 一、临时组队（无预置团队时）

- **形态与落点**：无预置团队时，Leader 可在**会话级** `teamsRoot` 下写临时团队资产，并以 `wave_plan({team, teamsRoot})` 建批；落点 `<teamsRoot>/presets/<team>/team-asset.json`（JSON 优先；`team-asset.yml` 亦可，按 JSON 子集书写、容忍 BOM），建议 `teamsRoot = <批次产物根>/teams`（绝对路径）。
- **`teamsRoot` 参数契约**：
  - 类型 `string`，**必须绝对路径**；缺省（不传）= **包内 `presets/<team>/team-asset.{json,yml}` 解析**。
  - **装配数据的唯一权威来源 = 团队资产**：引擎**不再**以内置常量兜底任何团队装配。**punky-preset 团队装配已弃用**（`presets/punky-preset/team-asset.yml` 已移除）——`team='punky-preset'` 等价于「无资产的团队」；各团队以自身资产为准。**无资产时构造期拒建批**（`TEAM_ASSET_NOT_FOUND`；零批次 JSON 落盘、`pendingBatch` 保留可补声明重试）——旧「告警 + 照常建批」的**假绿灯已废**（旧码 `GATE_TEAM_ASSET_MISSING` 在 `lib/**` 内**零命中**，退役码锁 `test/retired-codes-lock.test.js` 登记；同口径见 §0o 第一条）。
  - 语义 = **资产根**：loader 在其下解析 `presets/<team>/team-asset.{json,yml}`（loader 的资产目录常量即 `presets`）。
  - 生命周期：会话 / 批次内，**不进包**；随产物根留存可审计。登记口径：建批返回值 + plan spec 装配段落记「临时团队」来源与 `teamsRoot` 绝对值；**不改**包内 `presets/` 与 asset-manifest。
- **加载期校验与拒载码（不回落）**：
  - `teamsRoot` 非字符串 / 非绝对路径 / 含 `..` 路径段 → 拒建批 **`GATE_TEAMS_ROOT_INVALID`**；
  - `team` 名不匹配 `^[a-z][a-z0-9-]*$`（含 `/`、`\`、`..`、空白、绝对路径片段）→ 拒建批 **`GATE_TEAMS_ROOT_INVALID`**；
  - 词法 / 防逃逸校验**先于任何 resolve**执行；
  - `<teamsRoot>/presets/<team>/team-asset.{json,yml}` 均不存在 → **`GATE_TEAMS_ROOT_ASSET_NOT_FOUND`**（**不**回落包内 `presets/` 兜底）；
  - 资产存在但加载期不变量校验不过 → **原样透出** `TEAM_ASSET_*` 码（见附录 A）；
  - 双保险：解析出的资产路径须落在 `<teamsRoot>/presets/<team>/` 前缀内，越界 → `GATE_TEAMS_ROOT_INVALID`；
  - 拒建批时**无批次 JSON 落盘**；**拒绝静默回落**（回落会把非法临时资产静默降级为内置资产，造「建批成功但装配不是临时团队」的假绿灯）。
- **`config.assembly` 的优先级**：`config.assembly` **整份存在时优先于 `teamsRoot`**——此时技能前缀仍来自 `config.assembly`，临时资产仍被强制要求存在且合法（无静默回落口子）。
- **内置团队并存**：团队资产每团队一份（D-1）——**内置团队走包内 `presets/<team>/`、临时团队走会话级根**；两者走**同一加载器、同一加载期校验器、同一 Tier3 门禁**（装配面同级）。

### 二、红线（不可绕过）

- 放开的是**层 / 角色 / 技能 / `flows` 的组装**；**执行单元仍必须是 wavePlan lane**（§0i D-1 不变）——临时拆活走**细拆补 lane**，**禁**裸 subagent。

### 三、Leader 编排纪律

1. **目标澄清先行**：派发前明确目标 / 约束 / 交付物 / **验收标准**；给成员足够上下文与**期望输出格式**。
2. **主动补齐**：发现覆盖缺口 / 结论冲突 / 证据不足 → **要求补充分析**（返工或细拆补 lane）；**不掩盖分歧、不以投票了事**。
3. **假设显式化**：信息不足且**会实质改变方案** → 向用户确认；**可安全假设** → **写明假设后继续**（假设落盘，可追溯）。
4. **终门禁综合**：**不直接拼接成员输出**——先消重、标注冲突、核证据，再给结论（与 §4 / §5 一致）。

### 四、如实披露（硬要求，防「假契约」）

- **装配面与 `flows` 面均已生效（同级）**：建批时 `teamsRoot` 随批次**持久化**（批次字段 `teamsRoot`，缺省不写键），门禁读端据此解析该团队的 `flows` 声明——判据**按临时资产生效**，与内置团队走**同一解析器与门禁语义**。解析根优先级：① 批次级 `teamsRoot` → ② 引擎注入的 `flowsRoot`（测试缝）→ ③ 包根。
- **缺省（内置团队）**：`teamsRoot` 不写键 ⇒ flows 按包根解析，行为与重构前逐字一致。

### 五、自定义团队的角色声明（实证口径，2026-09-14 订正）

- **角色词法集 = 资产声明面（同源）**：`layers[<层>].roles` 里的角色名**即为**该团队的合法角色——`task.role` 与 `assembly.roles` 都按「引擎基础集（8）∪ 装配扩展（盲审三角色）∪ **资产各层声明角色** ∪ `roles.extra`」判定；`roles.extra` 是**可选补充**，**不是**隐藏必填项。
  - 2026-09-14 前的旧口径（**已作废**）：`extra` 只读 `roles.extra` ⇒ 「角色写进 layers 却没抄进 `roles.extra`」的团队每个自定义角色被判 `GATE_ROLE_INVALID`（实测 5 条非法告警 + 2 条缺牵头告警）。
- **牵头角色仍须显式声明**（本次未改，语义保留）：引擎基础牵头集 = `designer` / `coordinator`（plan）与 `supervisor` / `doc-manager`（audit）；自定义团队若用**其它角色**承担计划/验收牵头，须在资产 `roles.plan_leads` / `roles.audit_leads` 显式声明（与引擎基础集**并集**，不替换）。**未声明** → 建批产生 `GATE_ROLE_MISSING` 告警（**不是**引擎锁死角色）——「角色可用」与「角色可牵头」是两件事。
- **实证**（探针 `scripts/probes/flex-assembly-audit.mjs` + 回归 `test/flex-assembly-roles.test.js` F1–F5）：资产只在 layers 写自有角色、另声明 `plan_leads`/`audit_leads` → **`warnings=[]`**，技能前缀按资产注入（`[role=brief-owner] [skills=SPEC-SKILL]`）；负向对照：未在任何层 / `roles.extra` 出现的角色仍判 `GATE_ROLE_INVALID`。
- **资产改动即时生效**：读端缓存以「资产路径 + mtime + size」签名判新旧（`lib/assembly/team-asset.js#teamAssetSignature`）——同进程内补声明后**重建批即消警**（旧行为：缓存陈旧 ⇒ 第二次仍读旧值直到重启）。
- **配套**：`assembly` 须由调用方按**同一 root** 解析后传入（`resolveAssembly(team, null, {root: teamsRoot})`）——只给 `teamsRoot` 不带 `assembly` 时，lane 只有 `[role=…]`、**无** `[skills=…]` 前缀（`wave_plan` 工具面已接线，直调 lib 者自行对齐）。

### 六、已知踩坑与运行事实（如实记录）

- **生效面 = 进程粒度（D-2 实测）**：引擎改动（`lib/**`，含纯 JS 与 `npm run build` 产物）**只在宿主进程重启后生效**——「已 build / 已通过测试」**不等于**已生效（实测：同一构造重启前返回旧码、重启后返回新码）。**进程不是单一来源**：会话进程与 **Web/面板进程**可能加载不同代代码（实测 `:3080 /api/…` 读端滞后）⇒ 判定「某改动是否已生效」必须**指明进程**。
- **`runtime.json` 热更的拾取延迟 ≈ 30–40s（D-2 实测）**：代码常量 `pollMs=1000`/`debounceMs=300`，实测写入到被处理约 **30–40s** ⇒ 验证窗口须 **≥60s**，否则会把「未拾取」误判为「未生效」。另：`ratchet` 属**重启生效面**（热更只校验 + 告警）。
- **Windows 上 `node --test` 不接受 URL 参数（D-2 实测）**：`--test file:///D:/…` ⇒ `Could not find`（exit 1）；**preload 用 `--import file:///…`、测试文件用绝对路径**方可 cwd 无关；`--import` 给裸 `D:/…` ⇒ `ERR_UNSUPPORTED_ESM_URL_SCHEME`。

- **命令 gate cwd 契约**：`gate: <命令>` 在**批次产物根**（非仓库目录）执行 → gate 行必须 **cwd 无关**。两条实测反例：① `gate: npm test` 在产物根下因 npm 上溯到错误包根 `Missing script: "test"` → 拒 `GATE_EXIT_NONZERO`；② 写绝对路径**仍不够**——**被调脚本自身**依赖 cwd（`process.cwd()` 相对夹具路径）必 `ENOENT`。判据 = 该 gate 行在**产物根**与**仓库根**各跑一次**均 exit 0**。修法：(a) 脚本/测试用 `__dirname`/`import.meta.url` 推导绝对路径（推荐）；(b) 命令内显式设 cwd（稳健性差）。返工路径 = `review → running` 重开同一 lane（引擎**会再跑一次** gate）。
- **批次「Manager 是否真拉起」的留痕方式**：拉起 Manager 后**必须**调 `batch_phase({ batchId, manager: { agentId, note? } })` 登记（可单独调用、不带 `phase`；须在 `phase=running` 时登记）——写批次字段 `manager={agentId,raisedAt}` + `batch.manager.raised` 事件，`batch_status` / `log_export` 可查。**局限（如实）**：登记是**显式声明**，`complete` 门禁**不校验**该字段（旧批次无此字段也照常收口），故它把「是否拉起」从「自述旁证」升级为「可核事实」，但**不是**自动强制。

## §0k audit 职责与收敛口径（用户裁决 A）

**定性**：audit 层 = **验收**。工程团队的 `tester → reviewer → supervisor` 是同一语义的**三段实现**（reviewer 承担 exec 层自检），非工程团队的单 audit 角色为**单段实现**，不扩大职责。

| 面 | 口径 |
|---|---|
| **职责** | 按 plan 层「验收标准 / 验收信号」**逐条核对** exec 产物与证据，输出 verdict；**不做二次评审**（不重做 exec 的设计/实现判断、不新增 exec 未声明的质量维度） |
| **输入** | plan 层验收标准载体（`## 验收标准`）+ 各 exec lane 的产物/证据（`outputs` / produce）。缺任一 → 拒（机制面 = P1） |
| **输出** | `acceptance-report.md`（逐条结论 + 总 verdict）+ `gap-list.json`（**唯一**未决项载体）；verdict ∈ `{pass, fail, skip}` |
| **收敛判据（满足即必须收口）** | a. 验收标准条目 **100% 逐条有结论**（不留「待定」）；b. 未决怀疑须落成 gap-list 条目并标 `blocking` / `followup`，**过程形式的追加不算载体**；c. `blocking` = 「不满足即无法判定某条验收标准」，其余一律 `followup` |
| **长跑防治** | 每轮落 `<lane>/progress/NN-<slug>.md`；「证据不足以判定」→ 记 gap-list **并给出结论**（fail 或 pass-with-gap），**不得以「继续调查」为默认终点**（`GATE_EXIT_PENDING_AUDIT` 卡整批 complete） |
| **与机制面的关系** | 本节是**语义口径**；P1（**判据来源锚定**）与 P2（`audit_contract` 声明化）**均已落地**（后两段 + 附录 A.4） |

**P1 机制面（全局严格）**

- **建批期**：三层批中只要有 audit lane 声明 `consume`，则**至少一条** audit lane 必须消费到 **plan 层产物**（判定：路径以 `plan/` 开头，或由某条 `layer:'plan'` lane 在 `produce`/`outputs` 声明）；否则**拒建批** `GATE_AUDIT_INPUT_MISSING`。判据落**批级**而非逐 lane——多 audit lane 设计不必每条直接消费 spec；未声明 `consume` 的 audit lane 由 `entry_requires: ['consume']` 在派发面拦。
- **entry 期**：audit lane 派发前，其 `consume` 里的 plan 产物至少一份**正文含裸标题行 `## 验收标准`**（与 `GATE_PLAN_CONTRACT` 同判据）；否则**拒派** `GATE_AUDIT_CRITERIA_MISSING`（载荷 `problems`）——路径锚上而内容是空壳/跑题 ⇒ 仍无标准可依。
- **语义依据**：audit 层对的是**总体任务验收**，判据只能来自 plan 的验收标准；exec 层的 `reviewer`（消费 tester 结果）是**初步 audit，不外延到总体验收**，**不构成替代**。

**P2 机制面（fail-closed）**

- **声明位置**：团队资产 `flows.audit.audit_contract`——与同层 `contract`（产出内容契约：`artifact_globs`/`required_sections`）**不同键**。结构 `{ criteria_from?, consumes_required?, verdict?, exempt?, reason? }`（校验见 `lib/assembly/team-asset.js`）。
- **字段消费状态（逐字段核实）**：

| 字段 | 消费点（引擎在哪读它） | 语义 |
|---|---|---|
| `criteria_from` | **entry 期**（`gates.ts checkEntryGate`）：声明存在时按其 **glob 指名**锚点产物，**未被指名的 plan 产物带 `## 验收标准` 不顶用**；缺省回落（consume 中 plan 产物任一） | 判据来自哪份 plan 产物 |
| `consumes_required` | **建批期**（`core.js`）：声明的**每个层前缀**须至少被一条 audit lane 的 `consume` 命中，否则拒建批 `GATE_AUDIT_INPUT_MISSING`（团队叠加约束） | audit 必须覆盖哪些层 |
| `verdict` | **complete 门禁**（`gates.ts checkCompleteGate`）：**唯一真源**；团队未声明时按**引擎基线** `['pass','skip']`（legacy `flows.complete.require_audit_outcomes` 回落已**完全清退**）。取值 ∈ `{pass, skip, fail, conflict}` | audit 结论取值域 |
| `exempt` / `reason` | **建批期**：`exempt` 决定豁免分支，`reason` 进 `GATE_AUDIT_CONTRACT_EXEMPT` 告警载荷 | 显式豁免 + 理由 |
| ~~`checklist_anchor`~~ | **已移除**：自由文本**不可机器判定** ⇒ 归**技能手册/文档面**（`acceptance-gate/SKILL.md §2.5`），不占引擎声明面 | — |
- **建批期门禁**：批次**含 audit lane** 且**解析到团队资产**时，缺 `audit_contract` → **拒建批** `GATE_AUDIT_CONTRACT_MISSING`；**显式空 `{}` 或 `{exempt:true}`** → 放行但落**留痕告警** `GATE_AUDIT_CONTRACT_EXEMPT`（带 `reason` 则一并记）。
- **边界**：无团队资产（`generic` / 已退役团队 → 按引擎基线）→ **跳过**（零感知）；不含 audit lane 的批同样不触发。
- **为什么 fail-closed**：缺声明仅告警在无人读告警时等于**幽灵通过**；fail-closed 让「忘了声明」被拦、「明确不约束」必须**写出来**。**走豁免建议带理由**：`{"exempt": true, "reason": "…"}`。

**自检问句（audit lane 开跑前）**：① 判据来自哪份 plan 产物的哪几条验收标准？② 本轮做的是「逐条核对」还是「重新设计」？③ 能否给结论？若否：缺哪条证据、进 gap-list 哪个字段？

## §0l 能力发现前置（本部署的实机检索口径）

**规则（硬）**：断言「没有某工具 / 没有某技能」**之前必须先检索**，并在回执**写明检索词与检索面**；缺检索记录的「能力缺失」结论视为**未验证**。

**检索面三层（本部署实测，2026-09-24）**——逐层给证据，弱证据不得单独成结论：

| 层 | 手段 | 判据形态 |
|---|---|---|
| ① 注入面自陈 | 看本会话工具清单 / 技能清单（`skill` 工具的目录） | 「本会话未见」= **弱证据**，**不构成**不存在 |
| ② 实机检索 | `grep` / `glob` 扫宿主安装面与引擎包源码；只读 `pwsh` 枚举包目录 | 「`<面>` 内**零文件命中**（随条写明检索词）」 |
| ③ 实调验证 | **按名直接调用**一次，读回执形态 | 回执 `unknown global tools "X"` = **不存在**；返回**领域错误**（如 `agent "…" is not a member of an active Agent Team`）= **调用到达工具本体 ⇒ 工具存在** |

**降级披露（本部署，如实）**：旧版本节记载的「元工具检索」路径在本部署**无对象**——`tools_search` / `tools_schema` / `skill_search` 三件在宿主安装面（`D:\Program Files\npm-global\node_modules\@deepseek-ai\dsh`，扫描 17732 件 `*.js/*.json/*.mjs/*.cjs/*.ts`）内**零文件命中**；其前提符号 `tool-folder` / `skill-folder` / `META_TOOLS` / `missingMetaTools` 同样**零文件命中**，`~/.dsh/state/`（`tool-folder-state.json` 的父目录）**不存在**。⇒ 本节按上表 ② / ③ 执行；**若该三件日后在册**，即回到「检索到名字后按名调用、需参数细节先展开 schema」的路径（本节即该口径，无需再改）。

**技能面（现役）**：技能目录经 `skill` 工具自陈（会话技能清单）；任务明显需要某能力而清单无对应描述时，可用 `ask_user_question` 兜底确认，**不得**臆断「环境不支持」。**工具面（现役）**：`tools_schema` 不存在 ⇒ 参数细节以**实调回执**或源码为准（`lib/tools/*.js` 的 `parameters` 即 schema 真源）。

**Leader 派发义务**：worker 任务包「纪律」字段内附本条 + 触发场景（子代理只继承自己的注入面，缺同款约束会把「没看见」误判为「没有」）。

**触发场景（任务包内附）**：① 用户提到外部系统 / 服务（SSH、GitHub、ComfyUI、知识库…）而注入面未见对应工具；② 涉及具体文件格式或领域能力（PDF、Excel、论文、视频、写作…）而不确定加载哪个技能；③ **写下「环境不支持 / 没有该工具 / 无法完成」之前**；④ 收到 `<skill-route>` 提示时直接 `skill` 加载。

## §0p 官方 roster × 蟛蜞自建治理面（**A 方案**分工，2026-09-24 用户认可）

> 来源：`D:\AI_Workspace\DSH\DSH\reports\onto-agentteam-vs-blackboard-followup-20260924.md`（§2.1 官方板 8 项缺陷 + §2.2 onto 自建面实测全通 + §2.3 roster 面官方优势 + §3 三方案）。

**一句话口径**：**官方管「人」（roster 生命周期），蟛蜞管「活」（任务与交接）**。

### 一、分工表（A 方案，零代码改动）

| 面 | 归属 | 在册工具 | 依据 |
|---|---|---|---|
| 成员生命周期（roster） | **官方** | `spawn_teammate` / `list_agents` / `send_message` / `interrupt_agent`（**4 件**） | durable 成员（跨轮存活、可再唤起、活性可查）是官方**唯一**且真实的优势；onto 侧只有引擎自派的 **one-shot worker**（无唤醒 / 续聊对象；`lane_heartbeat` 是 **lane 级**而非会话成员级） |
| 任务真源 | **蟛蜞自建** | `wave_plan` / `task_pool` / `batch_tasks_add` / `task_update` / `lane_dispatch` | 批次 JSON 单写者 + 原子写；派发写 `owner`、结算写终态、`auto-settle` 消费事件（**推进者是引擎，不是 Leader 手动）** |
| 交接 | **蟛蜞自建** | `handoff_submit`（**逐件校验在场** + `assertions`）/ `handoff_view`（含 `readable` 回显） | 入边 `submitted` 是下游开工**硬前提**（`GATE_HANDOFF_MISSING`，§5 / §11 R-3） |
| 结算 / 留痕 | **蟛蜞自建** | `member_settle` / `mailbox_send`·`mailbox_read`·`mailbox_ack` / `log_export` / `swarm_report` | 事件流可导出（`log_export`），门禁与三契面在册 |

### 二、官方 `team_task_*` 五件**不进治理真源**（理由，逐条实测）

| # | 缺项 | 实测证据（2026-09-24） |
|---|---|---|
| 1 | **无自动回调** | `list_agents` 显示成员 `inactive`，而板任务仍 `in_progress` ⇒ 成员回合结束**不推进**板状态 |
| 2 | **CAS 手动推进** | 每次 `team_task_update` 递增 `revision`（1→2→3），Leader 必须**显式**收口 |
| 3 | **无产物契约** | 板字段仅 `subject` / `description` / `write_scopes` / `blocked_by`——**无** `consume` / `produce` / `outputs` |
| 4 | **无交接动作** | 没有「上游把产物交给下游」的显式动作，也没有逐件在场校验 |
| 5 | **无事件流** | 板无审计序列、不可导出 |
| 6 | **无终态冻结 / 门禁** | 无「批次终态拒写」「契约未过不得 `merged`」这类门 |
| 7 | **无分层与角色** | 板无 `layer` / `role` 概念（只有自由文本 `subject`）⇒ 挂不上三层与角色装配 |
| 8 | **写域限 workspace-relative** | 传工作区外的绝对路径被拒（`invalid workspace-relative write scope`）⇒ **工作区外的目标仓无法声明写域** |

- **实践后果（必读）**：A 方案下**成员完成 ⇒ Leader 必须显式 `member_settle` 收口**（或走 `auto-settle` 事件的自动结算判定），**不得**等官方板自己变状态。
- **「官方 task 五件」的界限**：`team_task_create` / `team_task_list` / `team_task_get` / `team_task_update` / `team_task_delete` 属**host 面工具**，成员可自行调用，但**其状态不构成治理真源**（`batch_status` / `gate_status` / `handoff_view` 才是）。

### 三、派发面 `provider` 边界（B 为方向、C 标不做）

| 方案 | 内容 | 状态 |
|---|---|---|
| **A** | roster 4 件用官方；**任务与交接一律走蟛蜞自建** | **已认可**；本批落指引（本节） |
| **B** | onto 的 dispatch 增 **`provider:'agent-team'`** 分支：用 `spawn_teammate` 替代宿主 `rt.start` seam 承载 lane worker；**任务 / 交接 / 黑板仍全走 onto** | **方向（待实施，未排期）**——现役唯一实现 = 宿主 subagent seam（`config.dispatch.provider`，本机取值 `subagent`；`lib/engine/dispatch.js` 走 `rt.start`）。引擎内**今日**与官方 Agent Teams 的关系只有两处**读 / 登记面**：① Manager 在册承抽的 **roster 读端**（`ctx.get('agentTeams')` → `listMembers`，§0g 一）；② durable 会话控制面（`wait_agent` 等）的**成员 deny 登记**（`lib/engine/suite.js`）——**没有** `provider:'agent-team'` 派发分支（设计稿：`docs/agent-team-bridge-design-draft-v0-2026-09-21.md`） |
| **C** | 在 `member_settle` 路径**镜像双写官方板**（真填 `officialTaskId`） | **不做（正式确认）**——会把上表 8 项缺陷引入治理链；官方板为实验性、契约不稳定 |

- **口径纪律**：`officialTaskId` 一类「双写」字段在本引擎**未接线**——无消费点、无校验、无判定；任何回显**不得**读作「已双写」。

## §1 任务指派

- 用 `wave_plan` 按依赖 DAG 分层为 **waves**——**固定语义**，启动后**绝不中途重算**。
- 用 `member_status` 派发（`pending→running`）。
- **公共池面（G-10 补名）**：任务入池用 `batch_tasks_add`、池视图用 `task_pool`（**只读视图**：列未派发任务 + 可派发性判定，**不授权、不认领、不改状态**）、加边用 `task_update`（`blocked_by` 依赖边）——派发仍由 Leader 单点经 `lane_dispatch` 发起（**不引入 claim 自领**）。

## §2 状态操作

- 状态以**状态文件为唯一事实源**（persona 纪律 2 同源，此处不重复展开）；迁移面：`batch_phase`（`planning→running→paused→aborted|complete`）、`member_status` / `member_settle`（`running→review→merged|failed|skipped|conflict`；`review` 的终态集**不含** `running`——K3 去返工边，见 §0b 一）。
- **批次相位工具面（G-10 补名）**：`batch_control`（相位/并发等控制面动作）与 `batch_phase` 并列；产物类型读面用 `artifact_types`。

## §3 并发与锁

- 同 wave **并行**派发 subagent。
- 写同一 lane 前用 **`lane_claim`** 拿单写者锁（冲突先拒绝，必要时 `wait` / `force`），用完 **`lane_release`**。
- 同 wave 多 lane 写**同一物理资源域**时，先取**域级物理隔离单元**（与 `lane_claim` 逻辑单写者锁**互补不可替代**），并把路径**注入任务包**；同批合并**串行化**；冲突**保留现场**由 Manager / Leader 裁决。
- **物理隔离单元工具面（G-10 补名）**：`lane_worktree_create`（为 lane 建独立 git worktree 作 cwd 契约，幂等）／`lane_worktree_merge`（把 lane 分支并回集成分支，**串行化**；冲突保留现场、不自动处置）。域级隔离与 `lane_claim` 的分工不变：前者管**物理文件树 / 分支**，后者管**批次状态 / 产物写入**。

## §4 黑板通信

- 跨上下文用 `mailbox`（在册工具 `mailbox_send` / `mailbox_read` / `mailbox_ack`）：`inbox` = 派发指令、`outbox` = 成员回执、`broadcast` = 广播。**成员→Leader 的回执入口 = `swarm_report`**（引擎套件、在册；`swarm_cc` 为成员→Manager 的抄送入口）——**G-05 订正**：旧文写的 `report` 在**本部署不存在**（宿主安装面无 `subagent-report` 包；成员回执的现役通道就是 `swarm_report`）。**`leader-direct` 批（无 Manager）：成员回执只走 `swarm_report`→Leader（单通道），`outbox` 不写**（写了无消费者）。
- **只写元数据，不复制正文**。

## §0m 派发套件（2026-09-16 落地：**派发收进引擎**）

- **唯一凭证**：C 档派发须携 **lane 句柄**——`lane_dispatch({ batchId, lane })` 发放（**一次性 / TTL 30min**），返回 `firstLine`（形如 `[swarm-lane:<batchId>/<lane>#<token>]`），**原样写入子代理任务包首行**（引擎只读 `exec.arguments`、不注入参数）。
- **引擎自派**：`lane_dispatch` 置 `running` 后由引擎在**工具流水线内**调 `ctx.subagents.startContinuable`（`exec.agent` 作 parent）⇒ ①**按次收窄成员工具面**（`toolFilter.deny` 套件外治理工具；**G-08 订正：准确表述 = 「按次收窄，收窄面以实测为准」**——2026-09-24 实测：`assign_check`/`wave_plan`/`member_*`/`batch_phase`/`lane_*`(写面)/`gate_status`/`artifact_types`/`asset_claim`/`batch_tasks_add`/`task_update`/`subagent`/`subagent_fork` 等**治理与派发面已不见于成员会话**，但 `send_message`/`interrupt_agent`/`list_agents`/`wait_agent` 四件**仍可见且可达**（`list_agents` 实调返回**领域错误**而非 `unknown tool`），`spawn_teammate`/`workflow`/`ralph` 亦可见 ⇒ **不得**再写「deny 名单 ⇒ 成员会话里不出现」这种全称断言）②`label=punky-swarm:<batchId>:<lane>`（**第二绑定键**，可从子会话事件反解析）③成功后**引擎直写** `member.dispatch`（**唯一写路径**，不再依赖事后观察）。
- **能力位前置**：provider 不支持 `toolFilter`/`depthLimit`，或未配 `config.dispatch.provider` ⇒ **拒派**（不以弱换强）；宿主无 `ctx.subagents` ⇒ 降级为「**仅发句柄**」并显式说明（不静默）。
- **门禁（软启用；M-03 订正：`enforce` 分支已无对象，2026-09-24）**：`config.dispatch.gate` 缺省 `'warn'`（C 档无句柄派发**只留痕不拦**，防自锁）；**`'enforce'` 不再可产拒态**——拒态码 `GATE_SUBAGENT_OUTSIDE_LANES` **已退役**（`lib/**` 内**零命中**；退役码锁 `test/retired-codes-lock.test.js` 登记，事由「gate-lite 第二批 · B：官方 profile 已 disable 宿主派发工具」）⇒ 切 `enforce` 是**无判据的操作面**（历史注记，不构成现役约束）。**B 档单步子代理不受限**；A 档由既有门禁 3 拒。
- **成员侧通信**：`swarm_report`（→Leader）/`swarm_cc`（→Manager）为**套件通信入口**；身份由 `member.dispatch` **best-effort 反查绑定**——**未绑定不再拒**（gate-lite Q-G2 · 2026-09-17 用户裁决「删除这一项」：官方 Team 成员天然无 lane 绑定属**常态**，原 `GATE_SWARM_UNBOUND_REPORT` 硬门已删）；未绑定时消息照发（批次键 `(unbound)`）、事件按「批次可否解析」如实落/不落，回显 `unbound` / `eventWritten` / `notice`；参数只给「类型 + 摘要 + 产物路径」，**不复制正文**。
- **绑定缺口观测**：心跳档族新增 `lane.binding_gap`（running 无 dispatch / 句柄超 TTL 未消费），**只标记不处置**；**不新增 mailbox box**（三个既有 box 的计数契约不可挪用：inbox=追问、broadcast=长跑候选、outbox=lane 活动信号）。
- **任务包书写规范（D-8，2026-09-16）**：**不要**在 lane 的 `cmd` 里手写 `[role=…]`/`[skills=…]` 前缀——**引擎会自动注入**；手写会出现重复前缀（实测已见 `"[role=designer] [role=designer] …"`），污染任务包与审计面。leader 补充要点走 `lane_dispatch` 的 `prompt`，不重复写契约（角色/层/consume/produce/outputs 由引擎从 wavePlan 注入）。
- **成员侧口径（D-7 订正，2026-09-24）**：被收窄的工具在成员侧**准确表述 = 「按次收窄，收窄面以实测为准」**——① 旧文「`tools_search`/`tools_schema` 走**目录面**仍能查到全量定义」**不成立**：该两件在本部署**不存在**（宿主安装面零文件命中，见 §0l），故**无目录面**可走；② 验证某工具在成员侧是否可用，用 **实调回执形态**判（`unknown global tools` = 不可用；领域错误 = 可用，见 §0l 表第 ③ 行）；③ 验收断言**不得**写「工具不存在 / 不可见」这类全称命题（2026-09-24 实测已见 4 件 S2 家族工具仍在成员会话可见且可达）。
- **成员侧只禁派发与治理（G-06 订正：13 项 → 20 项，2026-09-24）**：`SUITE_DENY_TOOLS`（**20 项，逐字**）＝ 治理套件 `assign_check` / `wave_plan` / `member_status` / `member_settle` / `batch_phase` / `batch_control` / `asset_claim` / `batch_tasks_add` / `task_update` ｜ 派发与锁 `lane_dispatch` / `lane_claim` / `lane_release` ｜ 只读治理面 `gate_status` / `artifact_types` ｜ 宿主子代理 `subagent` / `subagent_fork` ｜ 官方 roster 面 `send_message` / `interrupt_agent` / `list_agents` / `wait_agent`。**红线不变**：成员**不得再行派发**（含 `subagent`/`subagent_fork`；且**不得**以「某件未列入 deny」为由自起嵌套派发——§0i D-1）；**MCP 等普通工具对成员全量开放**，不得扩列。
  - **未列入 deny 面的三件（如实登记）**：`spawn_teammate` / `workflow` / `ralph`（均可产子代理 / 并行代理）**不在** `SUITE_DENY_TOOLS` 内，且 2026-09-24 实测在成员会话**可见**。「登记为有意放行，还是补入 deny 面」= 批 `onto-engine-v2-realign-20260924` **待裁项 Q-3**；**裁决前按「未列入 ≠ 已授权」执行**——成员侧仍受 D-1 红线约束。
- **派发失败恢复（D-3；K3 改判 2026-09-21）**：`lane_dispatch` 失败时引擎把 lane 回滚到 **`failed`**（`lib/engine/dispatch.js` 失败路径；`running→failed` 在迁移表内、**零新增边**），并作废已发放句柄；报错文案自带恢复指引：**「不可原地重派」**（返工边 `review→running` 已去除，重派会被 `invalid member transition` 拒）⇒ 恢复 = **记入 gap-list + 开新任务批次**；人工核查用 `gate_status({ batchId, lane })`。**旧文「回滚到 `review`、按样例重派即可」已作废**（那会把 lane 卡在非终态且无法重派）。
- **结算路径（D-4，2026-09-16）**：`running → merged/skipped` **不在迁移表内**（`running→skipped` 仅在 dispatch condition 不满足时由引擎自动走）⇒ 结算须先 `member_status({ batchId, lane, status: "review" })` 再 `member_settle`；非法迁移的报错现已自带该下一步样例。
- **未落**：W7（Manager 登记非协议判定）入台账待下轮专项。

## §0n 模式跟随（2026-09-16 裁决：**全局装载、不全局生效**）

- **`execToolCount` 仅提示**（同日裁决）：执行型调用计数与 `lastAssign.execCallsSince` **只作观察**，**不再是升档或评估过期依据**（档位依据 = 每回合主动写入的 `difficulty` + 判据）；过期只认「从未评估 / 距上次评估 ≥30min / 时间戳非法」。

- **语义**：插件的治理面**跟随模式**——`config.modes.gate`（agent preset 白名单；**本机部署**在 `cordis.patch.yml` 写 `['punky-preset','jiufeng']`；**包缺省 = 未配置 = 全模式生效**）名单内的会话才启用难度门禁 / G1 档位门禁 / 套件工具；**名单外模式零介入**（门禁全放行、**不计数**、不写任何治理状态）。
- **绑定口径（2026-09-16 裁决；N7 改字——原文误写「包缺省=白名单」）**：引擎与门禁**有且只有绑定蟛蜞模式**：①`agentPreset === 'punky-preset'` 启用；②`jiufeng` 是**同一模式的旧 id 别名**（过渡期保留，待旧会话自然消亡后从白名单与 `~/.dsh/.agent-presets/` 一并移除）；③**其它 preset（standard/minimal/ptc/cordis/liangshen…）不启用**；④**无 `agentPreset` 的会话不启用**（fail-open 为**明写红线**，不加日志噪音）；⑤子会话（`delegationDepth>0` / `parentSession`）**继承父会话模式**（实证：成员会话 header 沿用父 preset，16/16 采样）。
- **热更**：`modes` 与 `dispatch` 已入 `ALLOWED_TOP_KEYS` ⇒ 写 `<engineRoot>/config/runtime.json` 的 `{ "modes": { "gate": [...] } }` **即热生效，无需重启**；`null` = 回到旧行为（全模式生效），`[]` = 显式停用。
- **子会话继承**：Manager / worker 会话模式随父（`delegationDepth>0` 或 `parentSession`）⇒ **结算面不被非白名单误锁**。
- **拒态码**：名单外模式调套件写面工具 → `GATE_MODE_INACTIVE`（先于 G1，报「本模式未启用蟛蜞治理」，不报蟛蜞内部档位语义）。
- **零介入面 = 注册表 modeGate 集**（单点真源，不靠人肉同步）：受模式门约束的工具 = `lib/engine/suite.js` 的 `SUITE_TOOLS.filter(t => t.modeGate)`（再导出为 `MODE_GATED_TOOLS`，**现 12 件**：`assign_check` / `wave_plan` / `member_status` / `member_settle` / `batch_phase` / `batch_control` / `lane_dispatch` / `lane_claim` / `lane_release` / `asset_claim` / `batch_tasks_add` / `task_update`——**G-07 订正：由 9 件改为 12 件**，补入 `batch_control` / `batch_tasks_add` / `task_update`）——各件 `execute` **首行**落 `assertModeActive`（或经 `assertMemberActionTierC` 链式覆盖），故名单外模式**零治理写入**（不计数、不落锁、不写 `lastAssign`）；覆盖面与实现面的双向一致由 `test/suite-consistency-and-hot.test.js` SC-1/SC-4 + `test/mode-gate.test.js` T3 锁定。
- **别名过渡**：`jiufeng` 为**旧 preset id**，留在名单里只为既有会话（header 已记 `agentPreset: jiufeng`）续跑不中断；**新会话一律 `punky-preset`**。
- **红线（M-03 订正：降为历史注记，2026-09-24）**：`dispatch.gate` **保持缺省 `warn`**。原记载的「切 `enforce` 的前置 = 模式跟随先行，否则非白名单模式的 `subagent` 派发会被 `GATE_SUBAGENT_OUTSIDE_LANES` 卡死」**已失效**——该拒态码已退役（`lib/**` 内**零命中**，退役码锁登记），`enforce` 分支**无判据可产拒态**。

## §0o 团队资产必填与缺省链口径（P1 必填化 + P2 接线，2026-09-16）

- **`team` 必填，且必须解析到资产**：`wave_plan` 的 `team` 缺失 / 空串 ⇒ 构造期拒建批（`TEAM_ASSET_MISSING_FIELD`）；解析不到资产 ⇒ 构造期拒建批（`TEAM_ASSET_NOT_FOUND`）——**拒后零批次 JSON 落盘**、`pendingBatch` 不释放（补声明可重试），不再有「告警 + 照常建批」的假绿灯。判定序全 fail-closed：① `team` 词法/必填 → ② 资产加载 + 加载期不变量 → ③ `skills` 可解析 → ④ 才进 `buildWavePlan` / `createBatch`；拒态文案**可读可自救**（点名「该团队无资产 ⇒ 改用有资产的团队」）。
- **无资产的 `team` 名一律拒**：含已废除的 `generic`、**已退役的 `jiufeng`**（`presets/jiufeng/team-asset.yml` 早已移除）、以及**模式名误用**如 `punky-preset`。「legacy 兜底」只是直调 `buildWavePlan` 的**已登记差异面（W-2）**，**不得在工具面构成「有资产」**。
- **命名空间消歧**：`presets/<team>/team-asset.{json,yml}` = **团队资产**（装配声明：层 × 角色 × 技能 × flows）；`presets/punky-preset/`（或旧 id `jiufeng/`）= **预设（模式）资产**（`agent.cordis.yml` / `references/` / `preset.yml`），**不是团队资产** ⇒ 把模式名当 `team` 传同样「无资产 ⇒ 拒」。可用团队以**动态扫描** `presets/*/team-asset.{json,yml}` 为准。
- **团队资产要求（内置与自建团队同门同码）**：资产取 `<root>/presets/<team>/team-asset.{json,yml}`（显式 `teamsRoot` 时只读该根、**不回落**包内）；结构须合法（层/角色/**牵头角色不悬空**）；每个 role 的 `skills` 须**非空且可在宿主技能根 `~/.agents/skills` 解析**（可解析名 = 技能**目录名** ∪ `SKILL.md` frontmatter 的 `name`；技能根不存在/不可读**同码拒**、不静默跳过）——不可解析 ⇒ `TEAM_ASSET_SKILLS_MISMATCH` **整份拒载、拒建批**。
- **缺省链口径**：无 `chain` 声明 ⇒ 引擎缺省退化链 = **现行 3 层直线链 `plan → exec → audit`**（字段映射逐字不变，向后兼容）；含 `tester`/`review` 的多段链（`plan→exec→tester→review→audit`）**由团队资产各自声明**，属团队执行模式、**不属引擎缺省**。
- **`chain` 的运行期推进已整体退役（M-05 订正 · Q-A=C，2026-09-18）**：**唯一规范位 = 顶层 `chain`**（与资产顶层平级；显式声明 `flows.chain` 即拒 `TEAM_ASSET_FIELD_NOT_ALLOWED`，禁双真源、不设兼容分支）；**八条静态校验**（层白名单 / 角色悬空 / 悬空 `next` / 到不了的环节 / 环须由 `rework` 承认 / 链尾唯一 / `join:any` 必带 `anyFailure` / 只收枚举 token）在**构造期**（`wave_plan`，`createBatch` **之前**）fail-closed 执行，逐条复用既有 `TEAM_ASSET_*` 码（零新造）——**这是 `chain` 段今日唯一的消费面**（容忍期：五队资产仍带 `chain` 段 ⇒ 不报错、不静默改语义）。P1 的「只登记不接线」台账条目（`UNWIRED_DECLARATIONS` 的 `key:'chain'`）已整条删除——回归锁见 `test/team-asset-mandatory.test.js` P1-4a。
  - **已退役面（勿再按旧文理解）**：`member.settled` **不再**触发「算下一环 + 自派」；`chain.step` **不再新增**（写点已删）；`onFail` / `join.anyFailure` / `pair_with` / `rework` / `template` **无运行期消费者**。入口 `advanceChainAfterSettle`（`lib/engine/chain-runner.js`）**首行 no-op**（自述「链运行期推进 · 已退役」，返回 `reason:'retired'` / `note:'chain-advance-retired-20260918'`），`lib/` 内 **`CALL=0 / IMPORT=0`**；建批期展开的消费点亦已清退——`expandChainBranches` 在 `lib/**` 内**唯一命中 = 其定义行**（**零调用点**）。
  - **失败面改由什么承载**：失败 / 冲突 lane 即**终态**（K3 去返工边），失败面用 **gap-list（`blocking` / `followup`）** 表达，重做 = **开新任务批次**；`pair_with` 的 1:1 配对语义改由 **audit lane 的 `deps`** 表达。
- **`chain` / 拓扑的现行口径（M-05 订正）**：`chain` = **仅八条静态校验**（容忍期；建批期**不再展开**）；**运行期 DAG 真源 = 批次 `lanes[].deps` + `handoffs`**，判定单点 = `lib/state/gates.js` 的 `handoffRecordVerdictOf`；`chain.step` 仅作**历史事件**回显（读端 `chainEchoOf` / `log_export`），新批**恒零新增**。两条现行硬口径——
  - **链推进对全部批恒 no-op（原 `leader-direct` 专属分支的推广）**：原判据 = 批次 JSON 的 `assembly.managerPlan`（`chain-runner.js` 前置分支，先于相位闸、不看 roster）。链退役后该分支结果对 `leader-direct` 与 `raise` **恒同为 no-op** ⇒ 两形态在链推进面上**不再有差异**，其**现行**差别只在调度与 watch（§0f / §0g）。
  - **`batch.phase` 事件带 `reason`**（暂停类必须带 source 前缀，禁裸文案）：词表 = `chain:<分支>` / `auto-settle:<判据码>` / `manual:batch_phase[:<phase>]` / `manual:batch_control.<action>`，存量两源 `failed-escalate` / `governance-escalate` 不动；**空/空白 ⇒ 不写该键**（既有 `{from,to}` 形态零污染）；读端渲染 `<from> -> <to> | <reason>`（`log_export` markdown = 「为何不推进」的唯一解释入口）。
  - **步级条件边 `on` 声明面已下线（M1）**：声明即拒 `TEAM_ASSET_FIELD_NOT_ALLOWED` @ `chain.steps.<id>.on`（**不静默失能**——只删校验会让声明被忽略，比拒更糟）；正路路由用 `next`，失败面用批次级策略（`chain.join.anyFailure` / `chain.onFail`，M4 迁 `rework`）。**读侧保留历史兼容**：历史 `chain.step` 事件的 `via` 照常回显（`chainEchoOf` 不校验 `via`），写侧白名单已收窄（新写不可能产出历史 `on` 族取值）。
- **两段式拒态（G-2，排查建批失败必先分段）**：`wave_plan` 的拒态由**两段不同来源**产生，读拒态文案时必须先判段，勿把两段混作一谈——
  - **段一 · 框架参数面**：宿主在进入 `execute` **之前**按工具参数 schema 拒（`required` 缺失 / 类型或枚举非法 / `additionalProperties:false` 命中）。特征：文案由**宿主**生成（形如 `missing required property "team"` / `invalid arguments`），**不带** `TEAM_ASSET_*` / `GATE_*` 引擎码；本插件对该段**无构造序控制权**。
  - **段二 · 业务构造期面**：进入 `wave_plan.execute` 后的判定序（① `team` 词法/必填 → ② `teamsRoot` 面 → ③ 资产加载 + 加载期不变量 + `skills` 可解析 → ④ `chain` 八条静态校验 → ⑤ 装配声明门 → ⑥ audit 契约门），全部位于 `store.createBatch` **之前**。特征：文案**首行原样透出引擎码**（`TEAM_ASSET_*` / `GATE_*`），可照码分流与自救。
  - **共同判据**：两段拒后均为「**零批次 JSON 落盘** + `pendingBatch` 保留（补声明可重试）」；故「批没建起来」的正确诊断入口 = 先看文案属于哪一段，再决定是补参数形态（段一）还是改声明/资产（段二）。

## §5 事件回写与终门禁综合

- 成员完成 / 失败用 `member_settle` 结算（`member.settled`）；只做**异常判断与简短处置**，不转述完整消息（省 token）。
- **终门禁综合**：**不拼接**成员输出——先**消重**、**标注冲突**、**核证据**再下结论；分歧**不掩盖**、**不以投票了事**。
- **审计时点（完成即审，不等同批）**：exec lane `merged` 后立即开其 audit lane（可并行），不得等同批其他 lane/批收口。单 lane 审计 ⊥ 跨 lane 聚合（gap-list / 回归 / 消重 = Leader 终门禁），后者不构成前者延期理由；已完结批可另开审计批（plan+exec 占位满足 `consumes_required`）。反例：压到最后一波。**星型直驱下该条的落实 = §11 R-1（结算即派）+ R-2（复核并行，不得挡在派发前）。**
- **交接门工具面（G-10 补名）**：lane 间产物传递用 **`handoff_submit`**（`{batchId, from, to, artifacts[], assertions[]}`——`artifacts` **逐个必须在场**，缺则拒并落 `lane.handoff.gap` 事件；提交成功即尝试把 `from` 释放 / `to` 获取的写权一并转移）与 **`handoff_view`**（读端：逐边列 `submitted`/`pending`、解析后**绝对路径 + 是否可读**、上游 `assertions`、`blocking` 缺口）。**下游开工硬前提 = 其入边 `submitted`**（缺 ⇒ entry 门拒 `GATE_HANDOFF_MISSING`，§11 R-3）；存量无 `batch.handoffs` 的历史批回 `legacy:true`（放行 + 留痕）。

## §6 门禁

- `review` 阶段按门禁语义裁决 `merged` / `conflict`；批次**终态**（`complete` / `aborted`）后**拒绝再写**（persona 纪律 6 同源）。

## §7 恢复

- **`idle` 语义（用户澄清）：字面意义的「空闲态」**——成员当前无在跑动作，**不是崩溃态**；故 `idle → running` 是常规操作（**续跑 / 重派**的合法入口），不必先有「故障」。**注意（K3，2026-09-21）**：「返工」**不走状态机**（`review → running` 已去除）——返工 = gap-list + 新任务批次；`idle` 同时是进程重启的在途 lane 落位态（见下条）。
- 进程重启后 in-flight 成员**自动落 `idle`**（`system.recovered`）；用 `batch_status` 核对后用 `member_status` 重派。
- `lane_heartbeat` 过期检测：`stalled` 用**事件**表达、**不改成员状态**；`lane_longrun` 探针同 tick 产 `candidate` 事件 + broadcast，**只标记不改状态**。
- **步骤级断点保全**：worker 每完成一子步骤即落盘可独立读取的进度快照（含 `step N/total` 与产物落点），**禁止攒批**；崩溃后由新 worker 读取快照**跳过已完成步骤**；保全**只做物理留存**，**不触发自动续跑**。
  - **配套工具面（G-10 补名）**：`lane_checkpoint`（在 lane worktree 内 `git add -A && git commit`，无变更则 no-op；可带 `progress:{step,total}`——commit message 与 `worktree.checkpoint` 事件内嵌 `step N/total`）／`lane_checkpoint_status`（**只读**：从批次事件流读该 lane 的 checkpoint 历史与 latest 进度，**不依赖 git 调用**）——续跑前的唯一查询入口。
- Leader 直做产物用 `asset_claim` 复制归位进批次资产根。

## §8 输出偏好

- 总结用「**对比表 + 清单 + 摘要**」三层结构。
- 对用户**只报治理结论与关键状态**，不报冗长中间过程。

## §9 消费方契约摸底先行

- **触发**：凡任务消费宿主 API / 第三方 DSL / 框架扩展点 / 外部运行时协议。
- **职责归位**：摸底属 **plan 层**（Leader 决策包 / Designer 粗摸底、Coordinator 细拆补全）；exec 实现角色只 **consume**、**不自摸底**（批外 A/B 级任务由 Leader 直做摸底并入任务包）。
- **产物** `survey/<target>-contract.md` = 约束清单（**以被消费方校验器 / 解析器报错分支为证据**）+ 支持 / 不支持矩阵 + 仓库内合规样例 + 最小探针结论 + 特性自查对照。
- **四步法**：定位被消费方校验 / 解析实现 → 读其报错分支（**报错即约束文档**）→ 对照仓库内合规样例 → 最小探针验证。
- **契约强制**：C 类批次把摸底产物声明为 **plan 层 produce**、实现 lane **consume** → Tier3 缺 consume 拒派，强制「摸底齐备才写实现」。
- **任务包**加「**外部依赖**」栏：有依赖 → 填摸底产物路径 + 宿主冒烟命令；无 → 填「无」。

## §10 宿主级自验证 DoD

- **触发**：产出运行于**真实宿主 / 消费路径**（本机实例：dsh 插件、工具注册、前端插件、Web 服务）。
- **完成判据必须含宿主级加载 / 启动冒烟**——走真实消费入口（如插件经 `dsh web plugin tree` 加载成功）。
- **语法 / 局部级检查**（`node --check` / lint / 单测）**仅作中间自检**（Coder 自检边界见 discipline-v1 D1），**不得充当完成判据**。
- **冒烟形态**：批内归团队声明的验证角色执行；或声明为 exec 产物 `gate: <宿主冒烟命令>`（`member_settle merged` 前引擎确定性执行，exit 0 放行，失败留 `review`、配 `needHuman` 转人工闸）。
- **RED→GREEN**：冒烟须作**中间 checkpoint**（先搭会失败的冒烟再实现），**禁止攒批到终验**一次性暴露批量错误。
- 批外 A/B 级 dev 同适用（DoD 必写宿主冒烟命令）；audit 验收加「**契约对照**」项（核对摸底产物先于首编辑、宿主冒烟 gate 已执行，缺证据打回）。

## §11 运行模式：星型直驱（leader-direct star，2026-09-17 用户裁决）

- **适用**：`assembly.managerPlan='leader-direct'` 的批（Manager 线**暂缓期**；用户裁决「暂时忽略 Manager，暂时用星型跑引擎」）。
- **R-1 结算即派**：任一 lane `merged` ⇒ **立即派其下游 lane**（本模式下 Leader 是唯一派发者），**不得**先做 Leader 复核、**不得**等整批。判据：上游 `member.settled` 与下游 `lane.dispatch` 的时间差 **≤ 1 个回合**，且上游交接已 `submitted`。与 §5「审计时点（完成即审，不等同批）」同源，是其在星型模式下的**动作化**。
- **R-2 复核并行**：Leader 独立复核与 audit lane **并行**；默认**抽查**（关键指纹 / 冲突读数 / 抽样复算），**不重复全量重跑**（除自报与 audit 读数冲突）。复核服务于**终门禁综合**，**不构成派发前置闸门**。
- **R-3 单点派发**：本模式下 **Leader 是唯一派发者**；lane 之间只以 **handoff** 传递产物，「入边交接 submitted」是下游开工的硬前提（缺口 = `GATE_HANDOFF_MISSING`）。
- **R-4 星型 ≠ 无链（M-05 订正，2026-09-24）**：`chain` = **仅八条静态校验**（容忍期；**建批期不再展开**）；**运行期 DAG 真源 = `lanes[].deps` + `handoffs`**（逐边取件用 `handoff_view`，判定单点 `lib/state/gates.js` 的 `handoffRecordVerdictOf`）。
  - **lane 命名纪律：整条作废（2026-09-18 Q-A=C）**。原纪律「凡可能被链推进消费的批（`raise`，或 M3 之后由 `lane.handoff` 触发的自动派发），lane id **必须逐字等于**资产 `branches[].id`，否则落 `no-lane-for-step`」——链运行期推进退役后**无消费方**，**且所引锚点已越界**（该文件现 **82 行**，`chain-runner.js:249-251` 不存在）⇒ **lane id 可自由命名**（唯一硬约束：与 `deps` / `handoffs` 中引用的 id **逐字一致**）。`chainStepForLane` / `chainLanesOfStep` / `chainNextOf` 等符号**「定义在」而「`lib/` 读端为零」**（冻结面，判据措辞见 §15.1）。
- **R-5 监管二源**：判 lane 停滞须**二源共振**（文件时效 + 官方/子会话活动）；`<lane>/progress/*` 与工作区文件 mtime 属**单源**，只报数**不动作**；**误报不得触发 interrupt / 重派**（重派会丢在制改动）。
- **R-6 模式可退出**：需真推进 / 代管调度时切 `raise` 并拉起 Manager；或待 **M3**（推进改挂 `lane.handoff`，入边齐 ⇒ 自动派下游）落地后回到自动派发。**下游自动化 = M3，不是改门禁。**
- **已知缺口（登记，不阻塞）**：W-11 官方成员无 lane 绑定（watch 看不见）｜W-13 `<lane>/progress/*` **写端落点与读端契约错位（写端错位）**，**非读端缺失**——读端 `laneProgressDirOf` 早已按 **lane id** 拼接，历史误报 `longrun.candidate` 的成因是写端落在层域（`<layer>/progress/`）⇒ 快照不可见，须手工 ack｜成员会话工具面不含 `assign_check` / `gate_status`（成员侧难度无法落机位）｜**无自动派发 ⇒ 强依赖 Leader 在场**。
- **读端**：运行模式唯一读端 = 工作区 `docs/run-mode-star-leader-direct-20260917.md`（含评估 J-1..J-4 与示例批设计）；本节为其**行为约束版**（随指引注入）。

## §12 audit 非盲审：判据源硬门与建批规范（2026-09-17 用户口径 + 实测）

- **用户口径**：「audit 审核 exec 层内容时**也要消费 plan 层产物做对照**，并不是盲审」。
- **引擎侧已内建（逐 lane 硬门，不是批级放松）** —— 实现位 = `lib/state/gates.js` 的 **`checkEntryGate`**（audit 判据源锚点段；行号易漂，按符号定位）：
  - audit lane **派发前**：其 `consume` 中若无**判据源锚点**的产物 ⇒ **拒派** `GATE_AUDIT_INPUT_MISSING`（**不吃 plan 产物根本派不出去 ⇒ 盲审在引擎上不可能**）。锚点取值**二态**（判据在 `lib/state/gates.ts:705-708`）：① **声明 `criteria_from`** 的资产按其 **glob 指名**锚点（engine / design / research / writing 四资产均 `"plan/**"`，`software-team` 原为精确路径 `plan/plan-designer-spec.md`）；② **未声明**的资产回落**引擎既有口径**——`isPlanProduct`：`consume` 中以 `plan/` 前缀者即锚点，**任一带 `## 验收标准` 即放行**。**software-team 于 2026-09-17 采用 ②**（删键，用户裁决）：精确路径式指名是**更窄的前置约束**（audit lane 每多列一份 plan 产物就多一处失配面），而 ② 与其余四资产**同一判据面**，且不缩小验收强度——判据源仍在 `consume` 声明面（Leader 侧）强制；
  - 命中的锚点产物**正文须含裸标题行 `## 验收标准`**，否则 `GATE_AUDIT_CRITERIA_MISSING`（路径对上、内容空壳/跑题仍拒）。
  - 建批期另有两条：`GATE_AUDIT_CONTRACT_MISSING`（解析到团队资产且含 audit lane ⇒ 资产必须声明 `audit_contract`）＋ `consumes_required` 的**批级**前缀覆盖（每个前缀 ≥1 条 audit lane 命中）。
- **资产表达面（原「唯一缺口」；M-05 订正后已随链退役消解）**：`chain.steps[].template` **只解释 `id` / `cmd` / `produce`**，**不支持 `consume`**；而 `chain` 的建批期展开消费点已清退（`expandChainBranches` 在 `lib/**` 内**零调用点**，唯一命中 = 定义行）⇒ 该模板**今日无展开消费者**，此缺口**不再构成约束**。**不变的部分**：判据源只能由**建批 tasks 的 `consume`**（Leader 侧）表达（本节硬要求）。
- **建批规范（Leader 必做，即时生效）**：每条 audit lane 的 `consume` **必须**含 ① **plan 层判据源**（如 `plan/<…>spec.md`）② **本链上游 exec 产物**；聚合 lane（如 `accept`）还需含其**全部入边**的 audit 产物。**实测反例**：本会话示例批首次建批即被 `GATE_AUDIT_INPUT_MISSING` 拒（audit 只声明了 exec 产物），补 `plan/demo-spec.md` 后才建成。
- **引擎候选（登记、不夹带）**：给 `template` 增 `consume` 字段（带 `${lane}`/`${branch}` 插值）⇒ 让「非盲审」成为**资产默认**而非建批手工；与 G-8（分支级 `template` 死声明）同批评估。

## §13 指引维护（Guidance maintenance）

- **双层结构**：`agent.cordis.yml` = **注入面**（每会话必进系统提示，只放规范句 + `#§X` 指针）｜`references/discipline.md` = **正文**（按需读，放细则/码表/证据）。**正文小节必须同时在注入面有一条**（详情面白名单：§0m/§0n/§0o）。
- **双副本纪律**：preset 五件（`agent.cordis.yml` / `references/discipline.md` / `references/manager.md` / `preset.yml` / `asset-manifest.json`）在 **repo**（`presets/punky-preset/**`）与 **live**（`%USERPROFILE%\.dsh\.agent-presets\punky-preset\**`）**必须同 sha256**；改一份即改另一份。
- **收口命令（硬）**：`node scripts/check-guidance-sync.mjs` —— 三条判据：① repo↔live 五件同 sha ② 注入面指针 `#§X` 在正文真实存在 ③ **反向**：正文每个 `## §X` 都在注入面有条目（白名单除外）。**GREEN（exit 0）才算收口**；未跑即视为未收口。
- **反例（本规则的由来）**：2026-09-17 新增 §11/§12 时只写了正文、漏了注入面 ⇒ 新规则「写了但注入不到」，下一会话的 Leader 看不到。该漂移本可被 ③ 自动拦住。

---

## §14 任务包预算与拆分（token 消费窗口，2026-09-18 用户裁决）

> 适用对象 = **主 Agent（Leader）＋ plan 层**。**本 § 是纪律，不新增引擎门**（除 §14.6 的 longrun 接线另批实现）。

### 14.1 窗口定义（唯一口径，供 longrun 工具共用）

- **一条 lane 任务包 = 一个消费窗口**；其**总 token 消费 `W` 必须落 `4M ≤ W ≤ 10M`**。
- **`W` 的计量口径**：`W = Σ(输入 + 输出 + 推理 + 缓存读)`——即「账面对模型装载过的全部 token」，**含缓存读**。理由：缓存读就是「同一上下文反复装载」的主项，也是长跑与漂移的真实成本项（本机实测 2026-09-18 段：`input 20.6M / output 2.79M / cacheRead 602M / calls 2597` ⇒ 缓存读占 **96%+**）。若只算 input+output，会把「跑了几十万 token 的大活」误判成「窗口内」，判据失真。
- **估算式（派发前必算）**：`W ≈ T × C`
  - `C` = 单轮装载（系统提示 ＋ 工具 schema ＋ 任务包 ＋ 已读文件 ＋ 对话历史）；本机实测均值 ≈ **232K/轮**（`~/.dsh/dsh-usage/usage-ledger.json` 2026-09-18：cacheRead 602,176,768 ÷ calls 2,597）。
  - `T` = 轮次，经验带：侦察 **3–8** ＋ 实现 **10–40** ＋ 验证 **5–15**。
  - 参考点：`T≈20 ⇒ W≈4.6M`（窗口下沿）｜`T≈45 ⇒ W≈10.4M`（**越界**）。
- **双向判据**：`W > 10M ⇒ 必须拆`；`W < 4M ⇒ 不拆`（合并，或降为 Leader 直做 A 档）。

### 14.2 拆分四切法（按优先级取用）

1. **按写域切**（文件簇/目录互斥）——首选，天然满足「一文件一写者」；
2. **按阶段切**（侦察 · 实现 · 验证分 lane）；
3. **按层切**（plan / exec / audit 本身即切法）；
4. **按验证面切**（全量套件 vs 定向子集、真批冒烟 vs 静态检查）。

**禁切法**：① 把**同一文件的原子改造**拆给两条 lane（造双写者，违反 §3）；② 把不可分的门禁/接口改造按行号切开（锚点必漂）；③ 为「凑窗口」把一条完整判据链拆成上下游两 lane 而不给交接断言（下游必然重建口径）。

### 14.3 主 Agent（Leader）义务

- **派发前任务包必须带预算行**：`预算：W≈<X>M（C≈<…>K × T≈<…>轮）；切法：<四切法之一>；若超窗：理由 ＋ 豁免 ＋ 分段`。**无预算行的任务包不得派发**（纪律自查项，非引擎门）。
- **粗判据（超任一即改拆法）**：单 lane 改动文件 > **8**｜跨模块（层/子系统）> **2**｜需全量套件轮次 > **3**｜预估轮次 > **45**。
- **在途监管**：成员 `W` 逼近 10M（或时长 > 20 min 且轮次 > 60）⇒ 按 **§0f 三分支**处置；**优先「按已完成进度拆分 ＋ 另开新批」**（重派会丢在制改动，见 §11 R-5；本批 wavePlan 建批后不重算 ⇒ 批内无法加 lane）。
- **下界不滥用**：< 4M 的活不要硬拆；碎片化的固定成本（派发 ＋ 上下文重建 ＋ 锚点重算 ≈ **0.3–1M/条**）会吃掉拆分收益。

### 14.4 plan 层义务

- 产出 task-tree 时**逐 lane 标注** `est_tokens` ＋ `basis`（读入 KB ／ 改动文件数 ／ 验证轮数），并把**预算表**写进 spec 的 `## 约束` 段（`## 约束` 是 `GATE_PLAN_CONTRACT` 必填裸标题，天然是预算的落点）。
- **合计超窗的 lane 在 tree 内就地拆条**，拆分结果必须是**写域互斥**的 lanes（含只读支持 lane），并在 tree 中给出依赖（谁消费谁）。
- **拆分不得改变验收标准**：判据不拆散、只分派；每条拆出的 lane 仍须能被 audit 层逐条核对。

### 14.5 超窗例外（原子任务）

允许超 10M，但**三件套缺一不可**：① plan 产物写明**超窗理由 ＋ 预估 W**；② 派发时**附 longrun 豁免**（§0h）；③ 强制**分段 checkpoint**（每子步骤落 `<lane>/progress/NN-<slug>.md`）。

### 14.6 与 longrun 工具的衔接（口径预告；实现另批）

- **判据升级方向**：从「纯时长」升级为「**消费窗口比 + 上下文膨胀 + 时长兜底**」三档：
  | 档 | 判据 | 处置 |
  |---|---|---|
  | 候选 | `ratio = W/10M ≥ 1` **且** `noProgress`（无进度快照/无活动） | 建议停轮 ＋ 按 §14.2 拆分重开新批 |
  | 早警（观察） | `0.6 ≤ ratio < 1` 且**单轮装载 `C` 持续攀升**（上下文膨胀，比总时长更早暴露漂移） | 只报数 ＋ 要求 checkpoint ＋ 收窄读入面 |
  | 兜底 | 时长口径（现行 `maxDurationMs 1200000` / `noProgressWindowMs 300000`）**保留** | 防 token 采集缺失时判据全盲 |
- **数据源缺口（先补再接线）**：引擎**当前无 token 计量面**——`lib/**` 内 `token` **字面命中 188 处**（本 lane 2026-09-24 复跑：`Get-ChildItem -Recurse -File -Filter *.js 'lib' | Select-String -SimpleMatch 'token' | Measure-Object`；旧文「131 处」= **陈旧读数，已作废**），逐处复核**未见「模型用量读取」点**（命中集中在鉴权 token / 句柄 token 与证书 `keyUsage` 族）；`~/.dsh/dsh-usage/usage-ledger.json` 只到「**日 × provider × model**」粒度，**无 session / lane 维度**。⇒ 接线二选一：① 宿主 usage 读端（按会话/成员聚合，首选）；② 引擎自计「轮次 × 装载估算」（零依赖但精度低）。
- **精度标记（硬）**：自计路径的读数**必须带 `estimated: true`**，不得让读端把估算当实测（同附录 A「有牙」检验：读什么、怎么判、谁消费）。
- **在此之前**：longrun 维持现行时长口径，**本 §14 为人工估算口径**（Leader/plan 层派发前自负其责）。

---

## §15 判据措辞 / 基线流程 / 并行窗口读数纪律（2026-09-18 债清轮沉淀）

> 来源 = 批 `engine-retire-chain-20260918` 审计 gap-list（G-04/G-07/G-08/G-09）与批 `engine-debt-cleanup-2-20260918` 的 lane 回报（F-1/F-2/F-3）。**本 § 是纪律，不新增引擎门。**

### 15.1 判据措辞：禁裸「零命中」（G-09）

「grep 某符号零命中」类判据在语义正确实现下**天然不成立**（定义本体、注释、被明令冻结的常量必然命中）⇒ 判据必须带**限定量词**，四选一：

| 限定量词 | 含义 | 例 |
|---|---|---|
| `lib/` 内零**调用** | 只有定义与注释命中不算违反 | 链五符号清退后 `CALL=0 / IMPORT=0` |
| 零**代码引用** | 注释与冻结常量命中不算违反 | 并发闸族（10 处注释 + `event-types.js` 冻结常量） |
| **运行期不可达** | 闭包内自调用存在但无外部调用方 ⇒ 不算可达 | `chain.js` 内 2 处自调用 |
| 冻结符号**分两类** | 「定义本体仍在」与「读端仍在」分别声明，禁一句「已冻结」了事 | `expandChainBranches`（定义在、lib 读端零） |

**反例（本教训由来）**：规格写「grep `chainStepForLane|chainLanesOfStep|chainNextOf` 零命中」，实读 **17 命中** ⇒ 按字面判 fail、按语义判 pass，**同一批两种结论**。

### 15.2 改前快照先落盘（G-04）

- 任何改码/改测**动手前**落 `progress/NN-anchors`：**逐文件 sha256** + `baseline-snapshot --check` 三项原始值（asserts / tests / tautologies）。
- **`HEAD` 不是有效回滚锚**（本仓多文件 untracked，或 blob 与工作树不等，已实测）⇒ 回滚路径 = **反向补丁 + 复跑判据**；不得写「`git restore` 即回滚」。
- 「词法净变化 0」这类表述**必须给可复算依据**（批前值 + 批后值 + 命令）；不可独立复算即视为未证。

### 15.3 `baselines/**` 单写者 = Leader（F-2，两轮重复摩擦）

- **测试面 lane 一律禁写** `baselines/test-baseline.json`、禁运行 `scripts/baseline-snapshot.mjs`；lane 只在自己的产物里**列出**造成的词法计数变化（逐文件 asserts/tests 增减）。
- **收口期由 Leader 统一重生成一次**（`--reason` 留痕）**再派 audit**；否则 audit 复跑必然看到 `e2-1/e2-2` 红（护栏语义 = 低于基线即红；净增合法但需基线一致）。
- **同类账目文件**（`baselines/test-baseline.json`、`pkg-hashes.txt` 等「随本批改动即失效」的校验账目）**一律按本条处置**：lane 禁写、收口期 Leader 统一重生成。注意 **`baseline-snapshot --check` exit 0 只证明「相对基线是纯增量」，不等于「测试树与基线一致」**（`e2-1/e2-2` 要求逐文件零漂移）——两者是不同判据，不得互相顶替。
- **写域表义务**：凡 lane 会动 `test/**`，其写域表**必须显式包含**该文件并注明「归 Leader 收口期重生成」。

### 15.4 并行窗口读数纪律（F-3）

- 同 wave 多 lane **共享一个工作树** ⇒ 全量套件读数在窗口期内**不可稳定观测**（他 lane 在途编辑会制造与己无关的红）。
- lane 自证口径 = **写域子集 + 通过数不下降 + 失败集合逐条归因**（归因不到自己的失败须具名他 lane 与文件 mtime）。
- **批级读数只在全部 exec lane 收口后取终值**，该终值是 **audit 的判据**；窗口期读数只作归因用，不得写进验收结论。

### 15.5 空转校验反模式（G-08 教训）

- 新增校验/告警**必须同时给出「可达构造」**——什么输入会命中；**无命中构造**的校验 = **空转**，读端不得以为「已被校验」。
- 处置只有两条：**重设计到可达** 或 **删除并如实登记**；audit 须**独立复现命中**（不采信实现方结论）。
- 反例：`collectAuditPairingWarnings` 判据 `own ⊆ upDeps` **不可满足**（要求上游 exec 依赖自身 ⇒ 必为环 ⇒ 建批先被 `topoWaves` 拒）⇒ 13 构造逐格 0 命中。

### 15.6 批边界归属（G-07）

- 批的硬边界（例：「禁改 `presets/**`」）**约束对象 = 被派发的 lane**，不约束 Leader 在批外的正当动作（§13 指引维护、`baselines/**` 收口重生成）。
- Leader 在批窗口外触碰该面时**必须显式裁认留痕**（写进收口事由/结算备注），不得默认沉默——否则读端会把「Leader 动作」误读成「lane 违规」。

### 15.7 四条配套口径（2026-09-18 债清 3 轮沉淀）

1. **在飞追加指令无消费保证**：Leader 通过 mailbox 向**已派发**的成员下达的变更/裁认，**不保证被消费**（成员可能不读、不 ack、不报；已实证：指令落 inbox 后成员在其最后窗口内未执行且未登记）。⇒ **关键裁认必须在「派发任务包阶段」下达**；mailbox 只作辅助，且须**显式要求在进度快照里 ack**。写了写域变更而不能确认消费的，**按未下达处理**（收口时的缺失不得归因于成员「保守」）。
2. **规格不得包含互斥判据**：例「强制新增测试用例」×「全量 `not ok` = 0」不可同时成立（新增用例必改 `test/**` 词法计数 ⇒ 撞基线零漂移锁）。⇒ 全量口径只能写成 **「写域子集绿 ＋ 收口后全量绿」**；lane 的判据不得以批级读数为自证。
3. **蓝图/契约引用一律写绝对真源路径**：本仓存在**两处 `docs/` 树**（引擎包内 `packages/dsh-punky-swarm/docs/**` 与工作区 `D:\AI_Workspace\DSH\DSH\docs\**`），蓝图真源在工作区树。任务包引蓝图**必须给绝对路径**，否则成员会读到缺失并自行找源（已发生一次）。
4. **两套计数口径必须并列**：`baseline-snapshot` 的 **lexical** 计数（例：tests 1588）与 TAP 运行器的 **tests 1633** 是**不同口径**，不可互相校验；`--check` delta 全 0 也**不等于**测试树与基线一致（后者由 `test-baseline.test.js` 的逐文件零漂移锁把守）。**批级终读数只在全部 exec lane 收口 + 账目重算之后取**。

---

## 附录 A 门禁码表（码 → 触发条件 → 载荷 / 处置）

> 本表**不杜撰**语义，与引擎实现冲突时以引擎为准（`TEAM_ASSET_*` 15 枚为复用码，不新增、不改码）。载荷为抛出的 `Error.message` 单行形态（`<...>` 为占位）。

**三档可判定性分级（D-1）** — 每枚码**必须**归入且仅归入一档（防「绿灯但无约束」的假安全感）：

| 档 | 语义 | 判据 | 代表码（分组示例，非穷举） |
|---|---|---|---|
| **① 拒态（blocking）** | 拒绝该动作、**状态不前进**、必留痕 | 唯一写面 + 结构性拒绝（码 + 事件 + 载荷） | A.1/A.3/A.4/A.5 表中「拒 / 拒派 / 拒建批 / 拒 merged」类（含 `GATE_EXIT_*`、`TEAM_ASSET_*` 拒载类） |
| **② 留痕放行（escape / warned pass）** | **放行但必留痕**（有意逃生阀） | 走 `escape` 载荷 + 事件（`gate.escape{kind:…}`） | G-1 空闲态放行（`idle-recovery-passthrough`）、`standalone`、`env-gate-disabled`（`GATE_ENABLED=false`）、`command-declared-off`/`targets-off`/`needhuman-off`、`empty-artifact-noted`、`GATE_AUDIT_CONTRACT_EXEMPT`、`GATE_ROLE_INVALID` |
| **③ 观察（observe-only）** | **非拒态、只上报** | 事件落盘 + 计数，不改判定 | `gate.contract_missing`（首触）、`gate.degrade{kind:'produce-field-widened'}`、`lane.over-budget`、`lane.stalled`、`lane.longrun.candidate`、`governance.refusal` |

- **归口纪律**：新增任何码/事件**必须同批**把档位写进本表（否则视为「未登记门禁面」）；档位**只许收紧**（②→① / ③→① 可，反向须用户裁决）。
- **判定「有牙」的检验**：① 能答「读什么、怎么判、拒哪一步、留什么痕」；② 能答「放行时以什么载荷证明**有意**放行」；③ 能答「这是给谁看的信号、谁消费它」。答不出者**降级为纪律**。

### A.1 `teamsRoot` 参数面（本批新增 2 枚）

| 码 | 触发条件 | 载荷（message 形态） | 处置 |
|---|---|---|---|
（含 `/`、`..`、空白）；⑤（双保险）资产路径经 `relative()` 越出 `<teamsRoot>/presets/<team>/` | `GATE_TEAMS_ROOT_INVALID: <判定句> (got: <原值>)`；判定句五种（非空绝对路径 / 不含 `..` 段 / 须为绝对路径 / `team` 词法 / 路径越界），英文原句见 `lib/assembly/team-asset.js` | throw → **拒建批**（无批次 JSON 落盘）；判定在**词法面** |
| `GATE_TEAMS_ROOT_ASSET_NOT_FOUND` | 显式 `teamsRoot` 且 `<teamsRoot>/presets/<team>/team-asset.{json,yml}` **均不存在** | `GATE_TEAMS_ROOT_ASSET_NOT_FOUND: no team asset under <期望目录> (expected team-asset.json / team-asset.yml; explicit teamsRoot does not fall back to the packaged presets/)` | throw → **拒建批**；**不回落**包内 `presets/` 兜底 |

### A.2 团队资产加载期不变量（`TEAM_ASSET_*` 15 枚复用）

| 码 | 触发条件 |
|---|---|
| `TEAM_ASSET_NOT_FOUND` | 资产文件不存在 / 读失败 |
| `TEAM_ASSET_BAD_JSON` | 内容非合法 JSON（YAML 子集解析失败） |
| `TEAM_ASSET_BAD_TYPE` | 顶层 / 字段类型不符 |
| `TEAM_ASSET_MISSING_FIELD` | 必填字段缺失 |
| `TEAM_ASSET_FIELD_NOT_ALLOWED` | 出现未允许字段 |
| `TEAM_ASSET_ENTRY_REQUIRE_UNKNOWN` | `entry_requires` 取值未知 |
| `TEAM_ASSET_CONTRACT_EMPTY` | `contract` 声明为空 |
| `TEAM_ASSET_LAYER_UNKNOWN` | **flows 段的层名不在允许层集**（`lib/assembly/team-asset.js` 白名单，**允许集恰为 `plan`/`exec`/`audit`**；**F-4 起 `complete` 已移除**）⇒ **整份拒载**（`severity='blocking'`，**不降为告警 / 不加兼容分支**）；处置 = **删除该段** |
| `TEAM_ASSET_ROLE_LEXICAL` | 角色名词法非法 |
| `TEAM_ASSET_SKILLS_MISMATCH` | 每个 role 必须有**非空** `skills` 数组。**本行只描述「资产层结构校验段」**（`lib/assembly/team-asset.js` 只判**非空**）；**技能可解析性由构造期另一单点承载**——`lib/assembly/schema.js` 的 `assertAssemblyCompleteness`（要求 `skillCatalog.has(name)`，生产侧 = 宿主技能根 `~/.agents/skills/<name>/SKILL.md` 的存在性解析）⇒ 不可解析即**拒载、拒建批**（M-09 订正：旧文「只校验非空，不校验技能存在」**表述过宽**） |
| ~~`TEAM_ASSET_STATE_OVERRIDE_UNKNOWN_STATE`~~ / ~~`TEAM_ASSET_STATE_OVERRIDE_WIDENS`~~ / ~~`TEAM_ASSET_STATE_KIND_INVALID`~~ | **三码已退役（M-14 订正，2026-09-24）**：`state_machine` 族随 2026-09-18 清债轮改为**声明即拒**（`TEAM_ASSET_FIELD_NOT_ALLOWED`）后整体退场，三码**无任何实现**——本行原为「退役后未摘的旧行」。限定量词：三码在**引擎与测试面（`lib/**` + `test/**`）零命中**（2026-09-24 复跑），本表即为包内**唯一**字面出处；已按退役摘除，保留本注记以免读者再从旧稿找码 |
| `TEAM_ASSET_REWORK_INVALID` | `rework` 声明非法 |
| `TEAM_ASSET_LEAD_NOT_IN_LAYERS` | 声明的 lead 角色（`roles.plan_leads` / `roles.audit_leads`）**未出现在任何层的 `layers[*].roles` 中**（声明悬空）。本码只判「是否存在于某一层」，**不判层次归属**——该层是否构成牵头，由 `lane.layer` + 牵头集（引擎基础集 ∪ 团队 `plan_leads`/`audit_leads`）判定；**牵头角色 ≠ Manager**（见 §0g） |

- **透出形态**（显式 `teamsRoot` 时）：`<原码>: <path> — <原 message> (temporary team asset rejected; explicit teamsRoot does not fall back to the packaged presets/)`；原码**原样透出**（调用方可按原码分流），**不降级**为内置资产。
- **消费点裁决（防假契约；逐条给结论不留悬置）**：

| 声明 | 裁决 | 依据 |
|---|---|---|
| `flows.plan.contract` | **有**消费点 | plan 契约标题校验 |
| `flows.audit.audit_contract`（`criteria_from` / `consumes_required` / `verdict`） | **有**消费点 | P2：entry 读 `criteria_from`、建批读 `consumes_required`、complete 读 `verdict` |
| `flows.*.consume_field` | **已接线**（非假契约） | entry 门经 `consumeFieldNameOf` 按声明取字段名 |
| `flows.audit.contract`（旧泛键） | **已标废删除** | 现役真源 = `audit_contract`；保留 = 双真源隐患 |
| 顶层 `state_machine` / `flows.<layer>.progress_contract` / 顶层 `rework` / 链级 `chain.needHuman` | **已退役（声明即拒）** | 原为「仅加载期校验、**无运行期消费者**」的声明位；2026-09-18 清债轮（用户裁决「保留引擎运行的核心内容，清理冗余设计/技术债/死代码」）改为**声明即拒** `TEAM_ASSET_FIELD_NOT_ALLOWED`（台账 `lib/assembly/team-asset.js` `RETIRED_TOP_KEYS`/`RETIRED_FLOW_KEYS`、`lib/assembly/chain.js` `RETIRED_CHAIN_KEYS`）——「写了不生效」比拒更糟（同步级 `on` 的 M1 裁决）。已接线的 `config.ratchet`（经 `createStore({rules})` 生效、台账 `status:'wired'`）不受影响 |
| 事件 `gate.target_blocked` / `gate.target.passed` | **不删，维持既有留痕**（原「无写端无读端」经复核证伪） | 写端 `lib/state/store.js` 的 target-gate 判定段（旧引 `:632` / `:638` = **陈旧行号**，M-08 订正；按符号/段落定位，勿照抄行号）；读端 `test/gates.test.js` O2 组、`test/batch-store.test.js:309/:323` |
- `standalone` / `disabledBy` 仅有**返回值契约**（`standalone: true`、`disabledBy: 'team-asset:*'`），**未落事件**——审计需读返回值，**不得**称「已留痕」。
- 蓝图 §8③（解析结果落快照）/ §8⑤（运行期首触校验）**已落地，两处均有读端**（2026-09-15 订正，**2026-09-24 复锚 M-08**）：快照读端 `lib/assembly/snapshot.js:155`（`teamAssetRefOf` 定义行——本组锚点中**唯一逐字复核命中**的一条）→ `lib/state/store.js:320` 写批字段 `batch.teamAsset`（事件 `batch.team-asset.resolved`）+ `lib/state/gates.js:1606`（`teamAssetViewOf` **定义行**；旧引 `:1158` = 陈旧行号，该行实为局部变量声明）；首触读端 `lib/state/store.js:126`（`contractMissingEvents` 定义行；旧引 `:121` = 陈旧行号，发 `gate.contract_missing`，档位 ③ 观察档见附录 A 分级）。**锚点纪律**：本文件内 `path:line` 一律按**符号定位 + 落笔时重读**（§15.2），行号仅作辅助。

### A.3 装配声明面（三层批必填）与难度档 × 工具面（G1）

| 码 | 触发条件 | 处置 |
|---|---|---|
| `GATE_ROLE_ASSEMBLY_MISSING` | 三层批未携带批次级装配声明 `assembly`（缺 `managerPlan` / `auditLane`） | **拒建批** |
| `GATE_ASSEMBLY_INVALID` | 装配声明**结构非法**，或 `coordinatorLane` / `auditLane` **悬空**（lane id 不存在），或层错配（`auditLane` 非 audit 层） | **拒建批** |
| `GATE_ROLE_INVALID` | `roles` 词条**词法非法** | **告警，不阻断** |
| `GATE_BATCH_REQUIRES_C` | 当前会话**未评估**或档位 A / B 时调用 `wave_plan`（内核 `core.js#assertMemberActionTierC`） | **拒**（不落批） |
| `GATE_MEMBER_REQUIRES_C` | 当前会话**未评估**或档位 A / B 时调用 `member_status` / `member_settle` | **拒**（状态不变） |

- 详见 §0（G1）与 A.3.1（同一判据只留一处）。

### A.4 派发 / 结算 / 完成面（Tier3 与命令 gate）

| 码 | 触发条件 | 处置 |
|---|---|---|
| `GATE_ENTRY_MISSING` | exec 派发前 lane 的 `consume` 产物缺失 | **拒派**（lane 留 pending） |
| `GATE_EXEC_INPUT_MISSING` | **建批期**：团队资产 `flows.exec.consumes_required` 声明的**每个层前缀**未被任何 exec lane 的 `consume` 命中；或 `consumes_required_per_lane` 声明的前缀在**某个** exec lane 上缺位（M-15 补登记：五队资产**都**声明该键） | **拒建批**（`lib/tools/core.js` 的 `wave_plan` 构造期抛出，`createBatch` 之前 ⇒ 零批次 JSON 落盘；载荷列出缺位的前缀 / `lane:prefix`） |
| `GATE_HANDOFF_MISSING` | 下游 lane **入边交接未 `submitted`**（建批期 `deps` 已声明，但上游未 `handoff_submit`）或交接产物不在场 | **拒派**（缺口同时落 `lane.handoff.gap` 事件；存量无 `batch.handoffs` 的历史批走 `legacy` 放行 + 留痕） |
| `GATE_TARGET_MISSING` | lane 声明 `targets`，merged 前某 target **未落盘** | **拒 merged** |
| `GATE_TARGET_UNCHANGED` | 声明的 target 已落盘但**未变更** | **拒 merged** |
| `GATE_PLAN_CONTRACT` | plan 层 spec 缺必填裸标题（`## 验收标准` / `## 约束`，**逐字**匹配） | **拒 merged** |
| `GATE_NEEDHUMAN_PENDING` | 产物含独立行 `needHuman: true`，而 merged 的 note **缺**人工裁决证据（`human:<裁决人>:<时间>:<结论>`） | **拒 merged**（转人工闸） |
| `GATE_EXIT_PENDING_AUDIT` | 批次 `complete` 前 audit 层验收未完成 | **拒 complete** |
| `GATE_AUDIT_INPUT_MISSING` | 三层批中有 audit lane 声明了 `consume`，但**无任何** audit lane 消费到 plan 层产物（判据来源缺失） | **拒建批**（P1-a） |
| `GATE_AUDIT_CRITERIA_MISSING` | audit lane 派发前，其消费的 plan 产物**正文缺裸标题行 `## 验收标准`**（载荷 `problems`） | **拒派**（P1-b） |
| `GATE_AUDIT_CONTRACT_MISSING` | 批次含 audit lane 且**解析到团队资产**，而该资产 `flows.audit.audit_contract` **缺失** | **拒建批**（P2） |
| `GATE_AUDIT_CONTRACT_EXEMPT` | 资产**显式**声明 `audit_contract: {}` 或 `{exempt:true}`（= 明确决定不约束 audit 职责） | **告警留痕，不阻断**（P2） |
| ~~`GATE_MANAGER_NOT_RAISED`~~ | **已退役 / 幽灵码（M-11 订正，2026-09-24）：勿再引用**——`lib/**` 内**零命中**（含注释；2026-09-21 可达性审计按「**码名已字面删除**」处理，防 grep 误当活码）。Manager 在册判定改由**建批期官方 roster 承抽**（`gate.manager_roster_gap` 观察事件 + `managerRoster` 回显，见 §0b 一 / §0g 一）；**派发面已无此拒态** | — |
| `GATE_EXIT_*` | exec 产物声明 `gate: <命令>`，merged 前确定性执行**非 0** 退出 | **拒 merged**（lane 留 review；配 `needHuman: true` → 转人工闸） |
| `GATE_EXIT_NO_COMMAND` | **已声明 `gate:` 行但命令解析为空**（空行/仅空白/尾随空格）（载荷 `path` 指向该产物）；完全未声明 `gate:` 行仍**零感知**；`gate: false` 走「显式关闭」留痕面（`command-declared-off`），**不拒** | **拒 merged**（lane 留 review + `gate.exit_blocked`）；**F-7 起真正可达**——此前被 `declared` 早退遮蔽而长期不可达，属修正而非新增语义 |

- 命令 gate 的 **cwd 契约（真源 `lib/state/gates.js` 的 `commandCwd()`）**：lane worktree 根 → env `GATE_REPO_ROOT` → **批次产物根兜底**（**不是包根**）；执行器 = `runCommand` → `spawnSync(command, { cwd, shell: true })`（Windows 即 `cmd.exe`）。
  - **两种合规范式**：① `gate:` 行内自带 `cd /d <包根> && <原命令>`（cmd 内置；路径含空格时**成对引号**）；② 命令内全部使用**绝对路径**。
  - **反例（实测假红，2026-09-18）**：裸相对路径 `gate: node --import ./test/helpers/… --test test/…` 在产物根下**必然 exit 1** ⇒ `GATE_EXIT_NONZERO` ⇒ `auto.settle` **`pause`**（批 `panel-redesign-20260918` 首轮实测；lane 留 `review`）。
  - **任务包义务**：见 **§0e D-9**（Leader 派发时必须写明该条）。

### A.5 长程豁免面（R-3，`member_status` 派发面）

| 码 | 触发条件 | 处置 |
|---|---|---|
| `GATE_EXEMPT_NOT_DISPATCH` | 非派发面（`to !== 'running'`）携带豁免参数；或带豁免但既非派发也非撤销（无 `status`） | **拒** |
| `GATE_EXEMPT_TYPE_UNKNOWN` | `exempt.type` 不在 `ai-render` / `large-download` / `dep-install` / `none` 白名单内 | **拒** |
| `GATE_EXEMPT_INVALID` | `multiplier` 非法（超出 `[1,100]`） | **拒** |
| `GATE_EXEMPT_REVOKE_REQUIRED` | `revokeExempt: true` 而该 lane 无既有豁免 | **拒** |

### A.6 消费面事件（非码，供审计）

`lane.longrun.unconsumed`（未 ack 超 `unconsumedTimeoutMs`）、`lane.exempt.revoked`（显式撤销）、`gate.entry.missing` / `gate.complete_blocked`（门禁留痕）、`system.recovered`（重启恢复）、`asset.claimed` / `member.settled` / `worktree.checkpoint`。

---

### A.7 `auto.settle.skipped` 的 `reason` 取值（结算分流留痕，4 族）

> 由批 `engine-debt-cleanup-3-20260918`（verdict↔lane 终态分叉修复）**补齐登记**——此前三族取值均未登记，新码会成为「已登记族里的唯一成员」。

| `reason` 取值 | 触发条件 | 载荷 | 档 | 处置 |
|---|---|---|---|---|
| `phase-<相位>` | 批次相位非 `running`（`planning` / `paused` / `aborted`） | `{lane, reason, phase, settleId, trigger}` | ③ 观察 | 不结算、不改成员态；**不进幂等链**（恢复入口不被毒化） |
| `lane-terminal` | 命中 lane 已终态 | `{lane, reason, settleId, trigger}` | ③ 观察 | 不结算 |
| `already-settled` | 同 `(lane, settleId)` 已有自动结算留痕 | `{lane, reason, settleId, trigger}` | ③ 观察 | 不重复结算（幂等自证；**只落一次**） |
| **`audit-explicit-settle-required`**（2026-09-18 新增） | 命中 lane 的 `wavePlan.layer === 'audit'`（层缺失/非法**不命中**） | `{lane, reason, settleId, trigger}` | **③ 观察** | **audit 层 lane 的结算职责归 Leader**：本路不 `setMember`、不落 `paused`、不推相位、**不读产物正文**；失败须 Leader 显式 `member_settle(lane,'failed', <非空 note>)`；**不进幂等链** |

- **本条修的债**：此前 audit 层 lane 会被 auto-settle 自动结为 `merged`，而引擎 outcome 由 lane 终态推导（`merged ⇒ 'pass'`）⇒ **产物写 `verdict: fail` 也会被完成门读成 pass**（真源分叉，能骗过门禁）。修法 = 保持「lane 终态 = 单真源」，**audit 层一律不走 auto-settle**。
- **归口纪律补句**：`auto.settle.skipped` 的 `reason` **新增取值同属登记面**（须同批登记档位）；**声明「不进幂等链」的取值必须在实现侧有单一判定函数**（本批 = `isTransientSkip`）。
- **零新增**：无新 `GATE_*` 码（拒面由既有 `GATE_SETTLE_NOTE_MISSING` / `GATE_COMPLETE_AUDIT_FAILED` 承担）、无新事件类型（沿用既有 `auto.settle.skipped`）。

---

## 附录 B 参考要点归属表（外部参考 5 条 → 本指引落点）

> 外部参考 5 条要点（`leader-persona` / `leader-AGENT` / `Modes` / `DistributedTeam`），**不新增编号**：

| # | 参考要点 | 落点 | 落法 |
|---|---|---|---|
| 1 | **目标澄清**（先明确目标 / 约束 / 交付物 / **验收标准**） | §0b + §0j-三.1 | plan 产物必含裸标题 `## 验收标准` / `## 约束`（逐字匹配）；派发前验收标准先定 |
| 2 | **按任务性质选成员 + 给足上下文与格式** | §0e + §0j-三.1 | 任务包六要素含「期望输出格式」 |
| 3 | **主动补齐**（缺口 / 冲突 / 证据不足 → 要求补充分析） | §5 + §0j-三.2 | 并入终门禁综合句「不掩盖分歧、不以投票了事」 |
| 4 | **假设显式化**（实质改变方案 → 问用户；可安全假设 → 写明后继续） | §0j-三.3（独立纪律） | 假设落盘可追溯 |
| 5 | **终门禁综合**（不拼接成员输出：先消重、标冲突、核证据） | §5 + §0j-三.4 | 同 §5 与 §4 |
