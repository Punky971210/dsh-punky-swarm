# 门禁断言补测蓝图 · R3 波

- 日期：2026-09-21
- 目标仓库：`D:\dsh\Punky-plugin-onto`（包：`packages/dsh-punky-swarm`）
- 上游基线：HEAD `c761cd1`，测试基线 **1703 tests / 1699 pass / 0 fail / 4 todo**
- 上游依据：`docs/frozen-register-2026-09-21.md` §3「解冻口径」+ §6.5 纪律；`docs/rebuild-blueprint-2026-09-21.md` §0 裁定 ②

---

## 0. 本波的正当性（不是"翻冻"）

冻结登记 §3 逐字写明解冻口径：

> 新引擎定型后按功能重议，**补测优先于删码**，且必须补**生产路径 E2E 断言**（不是白盒直调 `createGates`）。

§6.5 纪律：

> **不得以「无断言」为删除理由**：`testHits = 0` 只证明**测试没覆盖**，不证明**代码是死的**。缺断言 ⇒ 先补测（生产路径 E2E），补完再判要不要删。

⇒ 本波 **不是** 修改冻结项，而是**补上冻结项缺失的那一半证据**。补测是**纯增量**：不动 `lib/**` 一行、不改任何门禁判定、不解除任何冻结。

**与 W6「本波不补测」不冲突**：那句里的「本波」= R2 清理波。R3 是独立波次，有独立蓝图。

---

## 1. 总纪律

1. **零生产代码改动**：`lib/**` 一行不动。任一用例失败 ⇒ 先怀疑夹具，不怀疑门禁。
2. **生产路径驱动**：走 `wave_plan` 工具建批 + `store.setMember` / `store.setPhase`（`store.js` 是唯一写者）⇒ 不用 `createGates(...).checkCompleteGate(batch)` 直调（那是白盒，正是本波要治的病）。
3. **生成物同批**：新增测试文件必须同步重生成 `baselines/test-baseline.json`：
   `node scripts/baseline-snapshot.mjs --reason "<事由>"`（`test/test-baseline.test.js` e2-1 会校验逐文件一致）。
4. **一批一 commit**，批前后各跑一次全量测试。
5. **不留凑数用例**：行为面已被既有断言覆盖的码，**不写重复用例**，改为在甄别表里登记判据。

---

## 2. 先甄别：11 枚里哪些是**真**缺口

判据：该码 **或它的外显形态** 是否存在测试断言。若外显形态已锁，则缺口是假的（哨兵按设计不外显）。

| 门禁码 | 类别 | 外显形态 | 既有断言 | 结论 |
|---|---|---|---|---|
| `GATE_ARTIFACT_MISSING` | 哨兵 | `GATE_EXIT_MISSING_<LAYER>`（出口门重写） | **12 处 / 3 套件**（v3 台账实测：`GATE_EXIT_MISSING_AUDIT` 3 · `GATE_EXIT_MISSING_EXEC` 9） | **假缺口**（映射一旦失效，这 12 处会看到裸哨兵而转红） |
| `GATE_COMPLETE_NO_AUDIT` | 收口主门 | 同名 | **零命中** | **真缺口** ⇒ R3-1 |
| `GATE_COMPLETE_EXEC_PENDING` | 收口主门 | 同名 | **零命中** | **真缺口** ⇒ R3-1 |
| 其余 8 枚 | 判据/建批/工具/fail-closed/留痕 | **逐枚核完 ⇒ 见 §6 判读表**（4 真缺口已补测 · 2 假缺口已收紧 · 2 不可达已登记） | 见 §6 | **R3-2 已落地** |

**顺带勘误**：冻结登记 §3 的「P0 三枚」应更正为 **P0 两枚**。第三枚 `GATE_ARTIFACT_MISSING` 的行为面已被 12 处断言覆盖（v3 台账口径），不属缺口。

---

## 3. R3-1 施工单（本波）

### 3.1 目标

给两枚**零断言**的收口主门补上**生产路径 E2E 断言**，并同时锁住它们的**一级对偶门**（证明「拒」不是夹具问题）。

### 3.2 新增文件

`test/complete-tier-gate-e2e.test.js`（新建，唯一新增文件）

夹具形态（复用既有实现，禁各写一套）：

- `createStore(root)` + `createTools(ctx,{store,root})` + `withDefaultTeam(byName,'software-team')`
- `assessC(store, SESS_ID)`（`wave_plan` 属 C 档动作）
- `seedTeamAssetSkills('software-team')`（P1 起建批期技能面 fail-closed）
- 三层 tasks：`plan/p1` → `exec/e1` → `audit/a1`，`audit.consume` 同时含 `plan/` 与 `exec/`（对齐 software-team 的 `consumes_required: ['plan/','exec/']`）
- 产物播种：`plan/spec.md`（含裸标题 `## 验收标准`）、`exec/e1.md`、`audit/a1.md`

### 3.3 用例设计（4 条）

| # | 用例 | 驱动路径 | 断言 |
|---|---|---|---|
| **A1** | `GATE_COMPLETE_NO_AUDIT` · 二级防线（真机路径） | 建批成功 → `batch_phase running` → 播种产物 → 全 lane 结算 `merged` → **只改持久化 `wavePlan`**：剔除全部 audit task（模拟「建批后被改图 / 存量漂移」形态；`layersOf` 只读 `wavePlan`）→ `store.setPhase('complete')` | 抛错且 message 含 `GATE_COMPLETE_NO_AUDIT`；`batch.phase` **仍为 `running`**（拒即不推进）；`gate.complete_blocked` 事件落痕 **1 条**且 `code` 一致 |
| **A2** | 对偶 · 一级防线（主防线） | 同一三层 tasks **移除 audit lane** 后走 `wave_plan` 工具 | 建批期即拒，message 含 `three-tier: exec layers require at least one audit lane`；**不落盘**批次文件 ⇒ 证明「有 exec 必有 audit」在建批期先拦，收口门是二级防线（两级都在位、码不同） |
| **B1** | `GATE_COMPLETE_EXEC_PENDING` · 真机路径 | 三层批 → `running` → 播种产物 → `p1`/`a1` 结算 `merged`，`e1` **停在 `running`** → `setPhase('complete')` | 抛错且 message 含 `GATE_COMPLETE_EXEC_PENDING` + **pending 回显 `e1`**（`throw new Error(code + ': ' + pending.join(', '))`）；`gate.complete_blocked` 事件载荷 `pending` 深等于 `['e1']`；`batch.phase` 仍为 `running` |
| **B2** | 反向锁（防「夹具本身不合规所以拒」） | 同 B1 夹具，**只改一处**：`e1` 也结算到 `merged` | `setPhase('complete')` **成功**；`batch.phase === 'complete'`；`gate.complete_blocked` **零事件** ⇒ 证明 B1 的拒因是「exec 未终态」本身，不是夹具形态问题 |

### 3.4 刻意不写的用例

- **哨兵裸码** `GATE_ARTIFACT_MISSING` 的直调断言 —— 它是内部值，按设计不外显；写它等于把内部实现焊进测试（且行为面已覆盖）。
- **`GATE_COMPLETE_NO_TIER`** —— 已有 8+ 处断言（`gates.test.js:264,276` 等）。
- **白盒直调 `checkCompleteGate`** —— 本波要治的正是「白盒绿 ≠ 生产路径走过」。

### 3.5 R3-2 施工单（同波第二段）

| 动作 | 文件 | 内容 |
|---|---|---|
| **新增** | `test/gate-assertion-r32.test.js` | 8 tests：E-A ×2（拒 + 对照）· E-B ×1 · `GATE_SKILL_MISSING` ×2（留痕 + 防误报）· 出口侧 legacy ×1 · `GATE_EVENT_CONST_MISSING` 围栏 ×2 |
| **收紧** | `test/governance.test.js:572` 用例 | 4 条 `assert.rejects` 按**实际拒态层**如实断言 + 绊线（原为 `/difficulty/` · `/rationale/` 分支词） |
| **收紧** | `test/handoff-gate.test.js:338` | 补断言载荷 `code === 'GATE_HANDOFF_LEGACY_PASSTHROUGH'` |
| **文档** | 本文件 §2 / §6 | 8 枚判读表 + 归属失实发现 + 后续施工单 |
| **同步** | `baselines/test-baseline.json` | 生成物同批重生成（`--reason`） |

**R3-2 判据**：`node scripts/audit/gates.mjs` 的「无断言拒码：有生产引用但测试零命中」由 **9 → 2**（实测）。
留下的 2 枚 = §6 判读表的 #7 `GATE_NO_DECLARATION` 与 §2 的 `GATE_ARTIFACT_MISSING`，**均为「不可达内部分支 / 哨兵」** ——
它们**按设计留在榜上**（外显形态已由别的层断言覆盖），本案**刻意不补重复用例**（§1.5）。

> ⚠ **口径自知**：`testHits` 是「该码在 `test/` 内（去注释后）出现的次数」，是**覆盖代理量**、**不是**断言强度的证明 ——
> 一条测试**名字**里写码也算命中。故本波对 4 枚真缺口**不依赖该代理量**：每枚都另有针对**真实抛/落载荷**的正则或 `code` 相等断言
> （`gate-assertion-r32.test.js` 内逐枚可核）；对 2 枚不可达项则**明确不补**。此自知延续 R3-1「乐观方向污染」的教训 ——
> **代理量涨了 ≠ 覆盖面涨了**。

---

## 4. 验收判据

1. 全量测试：`tests` 由 **1703 → 1708**，`todo` 保持 4，且**新增 0 例失败**（`fail` 恒 = 18，全部为 §7 环境缺陷）。
   > **口径修正**：本机 `fail = 0` 不可达（见 §7）。判据改为「新增失败数为 0」，即 Δfail = 0。
2. `node scripts/audit/gates.mjs --check` 报**「已消除无断言项 ≥ 2」**（`GATE_COMPLETE_NO_AUDIT` / `GATE_COMPLETE_EXEC_PENDING` 离榜），台账「有生产引用但无测试断言」由 **11 → ≤9**。
3. `node scripts/baseline-snapshot.mjs --check` 零漂移（基线已随本批重生成）。
4. `git status` 干净；`lib/**` 零 diff（可用 `git diff --stat -- lib` 复核）。

---

## 5. 风险与回滚

| 风险 | 等级 | 缓解 |
|---|---|---|
| 夹具形态不合规导致"拒"被误判为门禁正确 | 中 | **B2 反向锁**：同一夹具只改终态一处即放行 ⇒ 拒因可归因 |
| 新增文件未登记基线 ⇒ e2-1 转红 | 高（必然发生） | 同批跑 `baseline-snapshot.mjs --reason`，生成物同批提交 |
| A1 的"改 `wavePlan`"被误读为"测试在造非法状态" | 低 | 用例注释写明：这是门禁**自述**的威胁模型（`wave-plan.ts:465` 逐字「A1 双点：主防线 = 建批期，二级防线 = 运行期 `checkCompleteGate`」） |
| 误把补测当成"解冻" | 低 | 蓝图 §0 + commit message 双写「纯增量、零解冻」 |

**回滚**：R3-1 = `git revert fda041a`；R3-2 = 按其 commit 单独 revert（两段各自独立：R3-1 只碰新建测试 + 生成物，R3-2 只碰 3 个既有/新增测试 + 文档 + 生成物；**均无生产代码依赖**）。

---

## 6. R3-2 判读表（其余 8 枚逐枚）与处置

判据（本波定稿，逐条可判；④ 是 ③ 的一个子类，单列因为处置不同）：

1. **真缺口** = 无任何测试驱动**产出该码的生产路径**并断言**可判别观测量** ⇒ **补测**（走工具/门禁面真实调用）。
2. **假缺口·断言松动** = 路径已驱动，但断言只锁「分支词 / 共有标记」、锁不住**码** ⇒ **收紧既有断言**（纯增量）。
3. **真缺口·不可达** = 生产路径上的**防御性分支**，其承载的不变量由**另一层的外显形态**承担（该形态已有断言） ⇒ **只登记 + 写绊线**，不写重复用例（§1.5「不留凑数用例」）。
4. **真缺口·不可达（声明面遮蔽）** = 实现面判据被**声明面判据**完全前置遮蔽（同层更严）⇒ **登记 + 证据 + 建议**；本波**零 lib 改动**，只动测试与文档。

| # | 码 | 落点 | 判读 | 证据（生产行 · 测试行） | 处置 |
|---|---|---|---|---|---|
| 1 | `GATE_EXEC_INPUT_MISSING` | `lib/tools/core.js:739`（E-A 批级）· `:749`（E-B 逐 lane） | **真缺口** | 既有套件里 `consumes_required` **全指 audit 面**（→ `GATE_AUDIT_INPUT_MISSING`，`audit-contract-gate.test.js:127-137`）；exec 面只以「资产已声明且满足」的**通过态**被顺带走到，**拒态零断言** | **补测 ×3**：E-A 拒（+ 零批次落盘）· E-A 对照放行 · E-B 拒 |
| 2 | `GATE_SKILL_MISSING` | `lib/tools/core.js:776`（`plan.warnings.push`） | **真缺口** | `test/` 零命中；且 `config.assembly` 在 `test/` **零注入** ⇒ 唯一可达路径（覆盖层声明）从未被驱动。可达性推理：无覆盖时 `resolveAssembly` 逐字返回资产 layers（`lib/assembly.js:57-59`），而资产面已由构造期硬门 `TEAM_ASSET_SKILLS_MISMATCH` 把关（`core.js:460-477`）⇒ 告警恒不触发 | **补测 ×2**：覆盖层不可解析 ⇒ 留痕且**不阻断建批** / 全可解析 ⇒ **零告警**（防误报） |
| 3 | `GATE_HANDOFF_SETTLE_LEGACY_PASSTHROUGH` | `lib/state/store.js:742` | **真缺口** | 入口侧同族码有 P1-H6 覆盖（`handoff-gate.test.js:326-356`）；**出口侧从未被驱动**（全仓 `LEGACY_PASSTHROUGH` 在 `test/` 零命中）。三条件须同时成立（`gates.ts:1676-1695`）：出口门开启 · lane 有下游 · `batch.handoffs` 缺位 | **补测 ×1**：存量批 + 出口门开启 ⇒ 放行 + 落码 + `legacy:true` |
| 4 | `GATE_HANDOFF_LEGACY_PASSTHROUGH` | `lib/state/store.js:647` | **假缺口·断言松动** | 路径已驱动（P1-H6）；但只断言 `legacy === true` —— 该标记**入口/出口两侧共有**，锁不住「本条是入口侧」 | **收紧**：`handoff-gate.test.js:338` 补断言载荷 `code` |
| 5 | `GATE_DIFFICULTY_INVALID` | `lib/tools/core.js:1021` | **真缺口·不可达（声明面遮蔽）** | 实测（Node 22.22.2）：`parameters` 已声明 `difficulty:{required:true,enum:['A','B','C']}`（`core.js:1002`）⇒ **缺字段**与**非法值**两条分支均被 DSH 工具参数校验前置拦下（`ToolArgsError: missing required property "difficulty"` / `must be one of ["A","B","C"]`）⇒ 引擎门拿不到球，**其全部调用形态均不可达** | **登记 + 绊线**：`governance.test.js:572` 用例改为断言「拒态来自声明面**且引擎码不出现**」，遮蔽一旦解除即转红并提示改判 |
| 6 | `GATE_DIFFICULTY_RATIONALE_MISSING` | `lib/tools/core.js:1027` | **真缺口·部分可达** | 「值过短」分支**可达**（schema 只声明 `type:string`，无 `minLength`）⇒ 实测抛引擎码；「缺字段」分支被声明面遮蔽（`ToolArgsError: missing required property "rationale"`） | **收紧 + 登记**：可达分支锁**全码**；遮蔽分支走同一绊线 |
| 7 | `GATE_NO_DECLARATION` | `lib/state/gates.js:390`（`presenceJudge` 内部 code） | **真缺口·不可达（内部分支）** | 三处调用点恒传 `declared:[p]`（长度 1：`wave-plan.ts:525` · `gates.js:680` · `gates.js:993`）；建批期空声明更早被 `GATE_PLAN_PRESENCE_MISSING` 拦下（`wave-plan.ts:519-522`）；运行期「零声明」由 `GATE_EXIT_NO_DECLARATION` 承担（`gates.ts:1079`）。**两个外显形态均已有断言**：`gate-lite-smoke.test.js:92`（建批期）· `gate-hardening-red.test.js:351,365,366,766,945`（运行期） | **只登记**（等价不变量的"零声明拒"已由外显形态覆盖 ⇒ 不写重复用例） |
| 8 | `GATE_EVENT_CONST_MISSING` | `lib/state/store.js:75`（`requireEventType`，唯一守卫） | **真缺口·本波降级覆盖** | 设计**自述预留注入缝**（`store.js:146-148`：「供探针以『人为缺常量』实测守卫行为」），但 `resolveGateEventTypes` **未导出**，且已登记在 C1「未接线」清单（`docs/audit-2026-09-21-unwired.json`）⇒ 导出 = **解冻 C1 项**（本波禁止）。默认实参是 ESM 命名空间，**实测不可改**：`Object.isExtensible(ns) === false`，`delete ns.EVT_GATE_ESCAPE` ⇒ `TypeError: Cannot delete property 'EVT_GATE_ESCAPE' of [object Module]` | **围栏 ×2**（源码面 5 条 + 前置面），**如实标注「围栏 ≠ §6.5 的 E2E」**；真 E2E 做法见 §6.2 |

### 6.1 本波最重要的发现：归属被**声明面**改写

> **⚠ 2026-09-21 勘误（用户裁定 A2，见 §11.2）**：本节标题与「归属失实」的**定性**是错的——该分层是**既有已登记的设计口径**（`CHANGELOG.md:314` / `docs/governance-technical.md:81` / `discipline.md:328` 三处），引擎码被登记为「**内核显式分支**的命名，仅在绕过 schema 的调用路径可见，勿当作可 grep 到的外部错误码」。
> **观测事实不变**（外部可观测量 = `invalid arguments`，引擎码当前不可达），**结论改判**：不是「契约失实」，是「**内核兜底 + 外显形态分离**」。`lib/**` 与 `description` **一字不改**；绊线保留。以下原文按「勘误后」阅读。

`GATE_DIFFICULTY_INVALID` / `GATE_DIFFICULTY_RATIONALE_MISSING` 的**外显归属**被声明面接管：同一不变量被**两层**判据覆盖，而 `parameters`（声明面）比引擎门（实现面）**更严** ⇒ 实现面在**常规调用形态**下不可达（保留为绕过 schema 路径上的兜底）。

- **方向是 fail-closed**（拒得更早，不是更少）⇒ **不是安全洞**，优先级低。
- 但 `assign_check` 的 `description` **逐字宣称**「不填即拒（`GATE_DIFFICULTY_INVALID` / `GATE_DIFFICULTY_RATIONALE_MISSING`）」⇒ **契约归属失实**：按码分类的消费者（审计按 `code` 归类、外部 catch 该码）**永远等不到**这两个码。
- **建议（三选一，本波零 lib 改动只登记）**：① 删引擎死分支（当哨兵不算数，直接删）；② 改 `description` 的归属说法为「参数面拒 / 引擎面拒」分述；③ 放松 schema（去 `required`/`enum`）让引擎门接管，保住「码即契约」。
- **可复用通则**：**判据分层时，更严的一层会把更宽的一层变成死码** —— 与 R3-1 的「乐观方向污染」互补：那条讲"把没覆盖看成覆盖"，这条讲"把不可达看成可达"（台账口径上二者**都算"有生产引用 + 有测试覆盖"**，实则引擎门从未被走到）。**故「有引用」不等于「可达」，须核声明面是否前置拦截。**

### 6.2 后续（R3-3 及以后）

- **R3-3**：`GATE_AUDIT_CRITERIA_MISSING` **两处实现**判据单点化（`gates.ts` 收一处）—— 属重构，须独立波。
  → **已执行（`r3-3` 波）：上游前提被现场核查推翻** ⇒ 无抽取对象；改判为「勘误 + 钉死 + 缺口登记」。**结论与实证见 §8**。
- **R3-4（可选加强）**：`GATE_EVENT_CONST_MISSING` 的**真 E2E** —— 子进程 + `module.register()` loader 钩子：在 `load()` 里把 `lib/state/event-types.js` 的 `export const <CONST> = …` 改写为 `= undefined`，再驱动一条产 `gate.escape` 的路径（如 `gate-techdebt-red.test.js` R-01 的 standalone 逃生），断言「抛且**零落盘**」。成本 ≈ 1 loader + 1 子进程脚本；收益 = 把"源被改"从围栏升级为行为证明。**前置**：确认与 C1 未接线清单不冲突。
  → **已执行（`r3-4` 波）**：R3-2 该枚的「**降级覆盖**」（围栏 + 前置面）已替换为**真 E2E**——5 tests（对照 ×1 · 破坏 ×3 · 负向对照 ×1）。
  **C1 前置已核**：不改任何生产源码、不解冻任何登记项（破坏全在**加载期**完成）。**结论与实证见 §9**。
- **仍未解冻**：C1 26 项接线 / B1 10 项存废 / schema 消环 / 13 个 `_RE`… 均等新引擎形态。本波不解冻任何一项。

---

## 7. 环境缺陷（**与 R3 无关**，但影响「fail = 0」验收口径）

本机跑全量测试时，**3 个 git 依赖套件**恒失败 18 例（`worktree-tools.test.js` 6 · `merge-agent.test.js` 9 · `resume.test.js` 2），
报错一律 `worktree add (lane …) failed: fatal: invalid reference: punky/orch`。**已定位为环境缺陷，非 R3 引入**：

- **判定**：把 R3 新增文件暂移出 `test/`（此时 `test/` 树与 HEAD `c761cd1` 逐字节一致）后重跑，同样 16 例失败 ⇒ 与 R3 无因果。
- **最小复现**：`USERPROFILE` 指向非真实主目录时，**git 无法创建带斜杠的「嵌套 ref」**——
  `git branch punky/orch` **退出码 0、无任何报错**，但 `.git/refs/heads/punky/orch` 不存在；
  平坦名（`git branch flatbr`）正常。根因是中间目录 `.git/refs/heads/punky` 的创建被静默跳过，
  锁文件回落到 `.git/` 根（实测留下 `tXXXXXX` 形态残留临时文件），`commit_lock_file` 的失败未被上报。
- **触发路径**：`test/helpers/isolated-home.preload.mjs` 逐字 `process.env.USERPROFILE = root`（隔离根 = 临时目录）
  ⇒ 测试进程内所有 git 嵌套 ref 写入失效。**而引擎的分支命名全部嵌套**（`punky/main` / `punky/orch` / `punky/<lane>`）。
- **环境**：`git version 2.55.0.windows.5`；与本仓代码无关，`lib/**` 零 diff 亦复现。
- **不接受的做法**：改 `isolated-home.preload.mjs`（隔离纪律是安全面，不得为过测试而削）；改引擎分支命名为平坦名（行为变更 + 破坏 `punky/*` 语义约定）。
### 7.0 ⚠ 2026-09-21 03:5x 状态更新：18 例失败**不再复现**，且「git 版本」归因**已被实验证伪**

全量测试在本机首次跑出 **1729 tests / 1725 pass / **0 fail** / 4 todo**。
即长期挂在帐上的 18 例 git 依赖失败（`invalid reference: punky/orch`）**消失了**。查证过程与结论：

| 步骤 | 观测 | 结论 |
|---|---|---|
| ① 复跑两套件（`worktree-tools` + `merge-agent`） | **20/20 pass**（此前恒 18 例失败） | 缺陷确已消失，非"读到了未完成输出" |
| ② 枚举本机 git | 两个：`…\.workbuddy\binaries\PortableGit\…\git.exe` = **2.55.0.windows.3**（现 PATH 首个）；`D:\Program Files\Git\cmd\git.exe` = **2.55.0.windows.5**（记录过缺陷的那个） | PATH **顺序变了**（平台注入了 PortableGit） |
| ③ 因果验证：把 windows.5 提到 PATH 首位 | 进程内 `git --version` 确为 windows.5，但测试**仍 20/20 pass** | ❌ **git 版本归因被证伪** —— 换成旧 git 也复现不了 |
| ④ 最小 PATH（只留系统 git，`env -i`） | git 直接 `ENOENT`（环境被截太狠），失败模式不同 ⇒ 无效实验 | 该次实验不可采信 |

⇒ **根因仍未定性**。已知事实只有：该缺陷依赖 `isolated-home.preload.mjs` 的
`USERPROFILE = os.tmpdir()/punky-isolated-home-<pid>` 重定向（去掉 preload 即全绿），
但**在同一台机器上已无法复现** ⇒ 推测触发面还包含某个已随之改变的环境因素（候选：tmp 落点、
tmp 所在卷/权限、PortableGit 注入带来的 `/etc` 级配置），**无证据支撑，不写成结论**。

**验收口径据此收紧（同时保留回退）**：

- **现口径 = `fail = 0`**（可直接要求全绿；先前「18 例环境豁免」的容差**不再默认启用**）。
- ⚠ **但不得把「0 fail」当环境证毕**：若 18 例 `invalid reference: punky/` **回归**，先跑 `where git` 取证、
  把结果补进本节，再切回 Δfail 口径；**禁止**不问缘由直接恢复豁免。
- §7.1 的 `GATE_EXIT_TIMEOUT` 抖动仍可能偶发（满负载）⇒ 判据仍是「超时型须**单跑复现为绿**」。

### 7.1 第二类环境缺陷：满负载下的 flaky 超时（**R3-4 后复跑时新观察到**）

`test/command-exec.test.js` 的 **D1-A8**（"无重定向的同一条命令仍正常执行"**对照组**）在**全量并发**下偶发失败：

```
{ok:false, exitCode:null, output:"", durationMs:5023, timedOut:true, error:"GATE_EXIT_TIMEOUT"}
```

- **判定（实测）**：`node --test test/command-exec.test.js` **单跑 26/26 pass / 0 fail** ⇒ **与代码无关**，
  是 5s 执行上限在满负载（100+ 测试文件并发 + 内部 spawn）下被打爆。
- **为什么记在这里**：它使**全量 fail 数本身是个抖动值**（本机观测既有 18 也有 19）。⇒ **Δfail 的判据必须写成
  「新增失败均为 §7 两类之一」**：① 含 `invalid reference: punky/`；② `GATE_EXIT_TIMEOUT` 型超时且**单跑复现为绿**。
  仅凭「fail 计数变多 1」判回归，会把这类抖动误读为回归。
- **不要做的事**：为过测试而抬高该套件的超时上限（生产行为面；且抖动源是机器负载，不是阈值本身）。

---

## 8. R3-3：`GATE_AUDIT_CRITERIA_MISSING` 「判据两处」勘误与 fail-open 缺口登记

上游条目（§6.2 原文）称「**两处实现**、同为 `includes('## 验收标准')`」⇒ 可单点化。现场核查**推翻了该前提**。

### 8.1 勘误：两处共用字面量，但**不是**同一判据

| 落点 | 所属门 / 拒码 | 判据（现场逐字） | 语义集合 |
|---|---|---|---|
| `gates.ts:903` | entry 判据来源门 / `GATE_AUDIT_CRITERIA_MISSING` | `fs.readFileSync(...).includes('## 验收标准')` | 锚点产物**任一**含验收标准 |
| `gates.ts:994` | plan 契约门（引擎基线 `*spec.md` 分支）/ `GATE_PLAN_CONTRACT` | `content.includes('## 验收标准')` ∧ `content.includes('## 约束')` | **每份** `*spec.md` **两章都要** |

⇒ 二者**共用同一字符串字面量，判据集合不同**（「任一含 A」vs「每份含 A∧B」）⇒ **不存在重复实现，无抽取对象**。
`rebuild-blueprint §3.4` 的 W6 行把「共用字面量」误述为「同一判据的两份实现」，**已就地加勘误**。
本波不执行任何抽取 —— W6 冻结依旧成立，只是**标的已消失**。

**证据**：`test/gate-criteria-parity-r33.test.js` 用例 1 —— 同一内容 `# Spec\n## 验收标准\n- x\n`（缺 `## 约束`）下，
entry 门**放行**、plan 契约门**拒**（`lacks "## 约束"`）⇒ 差异被钉成**可执行证据**（防未来误合并 / 误抽取）。

### 8.2 真缺陷：两处**实现落后于契约**，方向 fail-open

两处的判据形态是 `content.includes(...)`（**子串**），而：

- 代码注释逐字宣称「正文含**裸标题行** `## 验收标准`（与 `GATE_PLAN_CONTRACT` 同判据）」（`gates.ts:876-877`；`:993` 同）；
- 外部纪律文档逐字同调（`presets/punky-preset/references/discipline.md:228` / `:391` / `:595`）；
- **同文件内**既有 `sectionLineHit`（`gates.ts:399`）/ `elementLineHit`（`:411`）**正是**行首锚定 + 整行匹配，
  且其注释明写「不用 `content.includes(id)` … `includes` 会把任意词命中 ⇒ 判据不可靠（**假绿风险**）」（`:407-408`）。

⇒ 这是**同文件内已确立的判据同源纪律**（O-4.3）在这两处被违反；方向 **fail-open**（比宣称更宽 ⇒ 假绿）。

**实证**（Node 22.22.2；两门各自真实调用；探针 `.tmp-run/probe-r33.mjs`）：

| 产物正文形态 | entry 判据来源门 | plan 契约门 | 契约宣称 |
|---|---|---|---|
| 裸标题行 `## 验收标准` | 放行 | 放行 | 放行 ✔ |
| **行内提及** `本文件不设该章，详见 ## 验收标准 一节` | **放行** | **放行** | 应拒 ✘ |
| **代码围栏内** `\`\`\`\n## 验收标准\n\`\`\`` | **放行** | — | 应拒 ✘ |
| 编号变体 `## 5. 验收标准` | 拒 | 拒 | 拒 ✔（被拒是子串不匹配的**副作用**，非判据使然） |
| 有验收标准、缺 `## 约束` | 放行 | **拒** | —（两门语义差异的正向证据） |

> **与 §6.1 的方向对照**：§6.1 = 更严的**声明面**把实现面变成死码（**fail-closed**，不是安全洞 ⇒ 优先级低）；
> 本条 = 实现比宣称**更宽**（**fail-open** ⇒ 假绿）⇒ **优先级高于 §6.1**。
> 两条的共同教训：**「宣称为真」不等于「实现为真」** —— 须逐处核**判据形态**，而非只核拒码是否存在。

### 8.3 本波处置（纯增量）

`test/gate-criteria-parity-r33.test.js`（**5 tests / 15 asserts / 171 行**）：

- **勘误锁 ×1**：同内容下两门判定不同 ⇒ 证据化「非同一判据」。
- **绊线 ×3 处**（用例 2 / 3 / 5 前半）：断言**当前**（宽松）行为，断言消息逐条标注
  「【绊线 · 已登记缺口】非期望行为」+「一旦解冻收紧 ⇒ 本断言**须改为『拒』**」。
  **刻意不写成"应当放行"** —— 收紧后必然转红，不静默漂移。
- **正锁 ×1**：编号变体拒 + 缺章拒 + 裸标题两章齐备两门均放行（对照，排除夹具副作用）。

纪律：**`lib/**` 零 diff、零解冻、零门禁行为变更**（同 R3 全域）。

### 8.4 解冻建议与裁定（**2026-09-21 用户裁定：维持冻结**）

原建议：把两处的 `content.includes('<section>')` 换成既有的 `sectionLineHit(content, '<section>')`（与 `required_sections` 判据同源）：

- **收益**：消除 fail-open 假绿；注释 / 纪律文档的宣称与实现一致；判据同源（O-4.3）。
- **障碍**：属**行为变更（更严）** ⇒ 撞 `rebuild-blueprint §3.4` 的「门禁行为冻结」（W6 字面冻结对象是"抽取"，
  但其**精神面**是"不改门禁行为"）⇒ 须用户裁决。
- **附带待决**：代码围栏内的标题行 `sectionLineHit` **同样拦不住**（它只锚行首 / 整行）⇒ 解冻时须**一并裁**
  「围栏内是否算命中」，否则只修一半。
- **回滚**：单点两行改动；§8.3 的绊线断言即回滚探针。

> **裁定（2026-09-21）：维持冻结，本波零执行。**
> 理由：门禁行为冻结（W6 精神面）优先于 fail-open 收紧；且可行性本身不完整（`sectionLineHit` 拦不住围栏内标题行，
> 单改函数只修一半）。**该缺口已由 §8.3 的绊线 ×3 显式登记**（断言现行宽松行为、标注"已登记缺口，非期望行为"）
> ⇒ 缺口不是"被忘掉"，而是"被有意延后并留下触发器"。
> **解冻条件**（缺一不可）：① 新引擎形态定型，W6 冻结自然解除；② 同时给出围栏内命中的判定口径。
> 届时改判信号 = 本波绊线转红（转红即提示重裁，非回归）。

### 8.5 验收判据（本波）

1. 静态基线：`files 144 → 145` · `tests 1677 → 1682`（+5）· `asserts 8192 → 8207`（+15）· `todos` 保持 4。
2. 运行期全量：`tests 1716 → 1721`，**Δfail = 0**（18 例环境缺陷不计，见 §7）。
3. `node scripts/baseline-snapshot.mjs --check` 零漂移（基线已随本批重生成）。
4. `git diff --stat -- lib` **空**（纯增量）。
5. `node scripts/audit/gates.mjs --check`：无断言项集合**不变**（本波不增删拒码，只钉判据形态）。

---

## 9. R3-4：`GATE_EVENT_CONST_MISSING` 真 E2E（把"降级覆盖"换成"行为证明"）

R3-2 该枚只落了「围栏 + 前置面」并**如实标注 `围栏 ≠ E2E`**（§6 行 8 / `test/gate-assertion-r32.test.js:325-341`）。
本波补齐这半块证据：**在"源被改"的条件下走生产路径**，断言守卫的真实行为（抛 + 零落盘）。

### 9.1 为什么必须"改源"：进程内三条路全堵死（R3-2 实证，本波沿用）

| 路 | 是否可行 | 依据 |
|---|---|---|
| 进程内 `delete EVT.EVT_GATE_ESCAPE` | ✗ | ESM 命名空间 `Object.isExtensible === false` ⇒ `TypeError: Cannot delete property … of [object Module]`（Node 22.22.2 实测） |
| 导出注入缝 `resolveGateEventTypes(evt)` | ✗ | 它是**模块私有**；导出 = 解冻 **C1** 未接线登记项（`docs/audit-2026-09-21-unwired.json`） |
| **加载期改写 `event-types.js` 源码** | ✔ | 不触碰任何生产源码文件、不解冻任何登记项、不动模块导出面 |

**威胁模型对齐**：该守卫的真实触发场景本就不是运行期事件，而是「有人改 `event-types.js` 把常量删掉 / 改名」——
**源码面事件**。故加载期改写不是"人造场景"，而是对该事件的忠实模拟（只把 `export const X = <字面量>;` 的右值换成 `undefined;`）。

### 9.2 交付物（4 个新文件，全在 `test/` 内；`lib/**` 零 diff）

| 文件 | 职责 |
|---|---|
| `test/helpers/event-const-loader.mjs` | module loader hook：目标模块源码改写（点名常量置 `undefined`）+ 负向对照档（守卫判据置 `false`） |
| `test/helpers/event-const-sabotage.preload.mjs` | `register(hook, url, { data })` 注册（**用 `data` 而非 env 跨线程传参**，不依赖未承诺行为） |
| `test/helpers/event-const-missing-child.mjs` | 子进程驱动：建批 → `setMember(e1,'running')` → 采集事实（**只采集不判定**，判定全在父测试） |
| `test/gate-event-const-e2e-r34.test.js` | 5 例；含**父测试独立复算 sha**（防"子进程自述即通过"） |

驱动路径 = 本包既有 RED 用例 **R-01** 同一条生产路径（`test/gate-techdebt-red.test.js:277` 的 standalone 逃生）：
建「exec lane 确无 plan 上游 + `standaloneReason` 齐备」批 ⇒ `setMember(…, 'running')` ⇒ entry 门放行并产 **escape 载荷** ⇒ 统一写盘点 `resolveGateEventTypes()` 解析 3 常量。

### 9.3 四档实测（本机 Node 22.22.2；每档 = 一个**全新子进程**，因模块图进程内只求值一次）

| 档 | 破坏 | `threw` | 批文件 | lane | `events`（磁盘复读） | `undefinedTypeCount` |
|---|---|---|---|---|---|---|
| **对照** | 无 | `false` | **被改写** | `e1: running` | `batch.created` · `batch.team-asset.resolved` · **`gate.escape{kind:"standalone"}`** · `member.settled` | 0 |
| **破坏 ①** | 缺 `EVT_GATE_ESCAPE` | **`true`** | **逐字节不变** | `e1: pending` | 仅建批期 2 条 | 0 |
| **破坏 ②** | 缺 `EVT_GATE_DEGRADE`（本路径未用到） | **`true`** | **逐字节不变** | `e1: pending` | 仅建批期 2 条 | 0 |
| **破坏 ③** | 缺 `EVT_GATE_CONTRACT_MISSING`（本路径未用到） | **`true`** | **逐字节不变** | `e1: pending` | 仅建批期 2 条 | 0 |
| **负向对照** | 缺 `EVT_GATE_ESCAPE` **且** 削弱守卫 | `false` | 被改写 | `e1: running` | `…` · **`[type: undefined]{kind:"standalone"}`** · `member.settled` | **1** |

破坏档错误消息（逐字，可归因）：
> `GATE_EVENT_CONST_MISSING: event type constant "EVT_GATE_ESCAPE" is absent/empty in lib/state/event-types.js ⇒ 拒绝写入（fail-closed：不得写 type:undefined；请先落常量再由写端发射）`

**「零落盘」的三重判据**（互不依赖）：① 父测试读盘复算 sha256 === 子进程自述；② 复算值 === 建批后基线 sha（逐字节不变）；③ 磁盘 `events` 仍只有建批期 2 条、成员仍 `pending`。

**负向对照的意义**（本波**最重要的一条**）：上四档断言的"零落盘 / 零失名"若是**无条件成立**（例如 `atomicWrite` 恰好因别的原因不执行），它们就**不构成对守卫的证据**。
故设第 5 档：同一路径 + 守卫判据置 `false` ⇒ **放行并真写下 `type: undefined` 的事件**（实测 `[null,"standalone"]`）。
⇒ 反证那三个"零"确是**守卫的功劳**，且本套件**能看见**污染。**绊线**：将来删/弱化该守卫 ⇒ 本档转红。

### 9.4 实现坑（如实记录，均为"自证机制抓到"）

- **`nextLoad()` 的 `source` 是 `Buffer`（`TypedArray`），不是 string** —— 复核确证，非推测。
  观测法：独立 preload 里 `register(hook, url)`，`load()` 内把 `result.source` 的**运行时事实**落盘（只观测、不改写）。
  Node **22.22.2** 对本包 `lib/state/event-types.js` 实测载荷：
  `{ format: "module", typeofSource: "object", ctor: "Buffer", isUint8Array: true, isArrayBuffer: false,
  isString: false, byteLength: 25929, bytesFirst10: [47,42,10,67,111,112,121,114,105,103] }`
  （前 10 字节译出即 `/*\nCopyrig`，与该文件首行注释吻合 ⇒ 观测对象正确）。
  Node 文档对 `load()` 返回 `source` 的口径是 `string | ArrayBufferView | ArrayBuffer` ⇒ 运行时给 `Buffer` 属**正常实现**，非本包特有。
  **首版 loader 按 `typeof source === 'string'` 判定、"非 string 即放行" ⇒ 钩子静默失效**（破坏没改到源、测试照旧通过）。
  **抓到它的是子进程自证**：`control.sabotageApplied === false`（点名常量 import 后仍为 `'gate.escape'`）。
  ⇒ 修法（经复核后**收敛为一行**，不再分层判定形态）：`typeof raw === 'string' ? raw : new TextDecoder('utf8').decode(raw)`
  ——一次性覆盖三种合法形态，**未知形态由 `TextDecoder` 直接抛**（天然 fail-loud），另加「目标模块无 `source` 即抛」一道显式守卫。
  **这是 R3-1/R3-2「乐观污染」的第三种形态**：前两种是"把没覆盖看成覆盖""把注释当判据"，
  这次是「**把'破坏没生效'看成'守卫是死码'**」——同属"让证据看起来比实际更强"。
  ⇒ 通则：**任何"人为制造条件"的测试，必须自带"条件确实成立了"的自证**，否则它证明的可能是**什么都没发生**。
- **`register()` 的 specifier 必须是 URL**：`register('D:/…')` ⇒ `ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'd:'`（Windows 盘符被当 scheme）。
  正式实现用 `register('./event-const-loader.mjs', import.meta.url)`（相对 specifier + parentURL）。
- **`--import` 可重复**：两个 preload（隔离 home + 破坏钩子）串接即可，顺序无关（二者互不依赖）。
- **`node --test` 会把 `test/**` 下「所有模块」当测试文件收集执行**（本仓既有惯例：`test/helpers/gate-fixture.mjs` /
  `host-skills.mjs` / `isolated-home.preload.mjs` 等各在运行日志里占一条**文件级 Subtest**）。
  ⇒ 本波新增 3 个 helper，运行期 `# tests` 因此 **+3**（文件级空测试）。
  但本波的两个 helper 与既有"纯导出型"不同：一个是**可执行脚本**（被收集时会真跑一遍建批、往 stdout 打一行 `##R34##`），
  一个是 **preload**（被收集时会把 loader hook 注册进**主测试进程**）。
  ⇒ 各加一道**自带防线**：`event-const-missing-child.mjs` 无 `PSWARM_R34_CHILD=1` 即 `process.exit(0)`；
  `event-const-sabotage.preload.mjs` 无 `PSWARM_EVENT_CONST_HOOK=1` 即**不注册**。
  **通则：放进 `test/` 的模块必须假定"会被当测试执行"** —— 无标记即静默无副作用，而不是指望收集器放过它。

### 9.5 一条**语义锁**（须明确：锁的是现状，不是规范主张）

`resolveGateEventTypes()`（`lib/state/store.js:149-156`）**无条件解析三常量** ⇒ **任一缺位即拒**，
即便本次载荷只用其中一枚（破坏档 ②③ 所证）。方向 **fail-closed**，且使"常量缺位"在**任何**门禁留痕路径上立即暴露，
而非等到该类型首次被用到 —— 从"最紧"角度看是优点。
本波把它钉成断言，含义是：**若将来改为按需（lazy）解析，这两档必然转红**，届时须**重新裁决该语义**（转红 = 提示重裁，非回归）。

### 9.6 验收判据（本波）

1. 新套件单跑 **5/5 pass**（对照 ×1 · 破坏 ×3 · 负向对照 ×1）。
2. 静态基线：`files 145 → 146`（`baseline-snapshot` 只数**测试文件**，`test/helpers/*` 不计）·
   `tests 1682 → 1686`（+4）· `asserts 8207 → 8245`（+38）· `todos` 保持 4。
3. 运行期全量：`1721 → 1729`（**+8** = 新套件 **+5** 例 + 新 helper **+3** 条文件级空测试，见 §9.4）· **Δfail = 0**（18 例环境缺陷不计，见 §7）。
   ⚠️ **静态 +4 与运行期 +5 的差额是 `baseline-snapshot` 的固有口径**：破坏档 ②③ 由 `for` 循环产出
   （源码内只出现**一次** `test(` 调用）⇒ 静态按 1 计、运行期计 2。
   **故静态基线是"源码面的下界"，运行期计数才是用例数**——两者不一致时须解释口径，不得据静态数倒推用例数。
4. `git diff --stat -- lib` **空**（纯增量；破坏全在加载期，生产源码零改动）。
5. 台账口径：拒码集合 **66 → 66**（零增删）；无断言项 **2 → 2**（本波只把 `GATE_EVENT_CONST_MISSING` 的断言从"降级覆盖"升为"E2E 行为证明"，不改变集合）。
6. 负向对照档**必须绿**（否则本套件的"零"无判别力）。
7. 冻结登记正档与生成物 **零漂移**（§9.7：`REGISTER_OUT=<preview>` 重生成后 diff 为空）。

### 9.7 顺带修正：冻结登记正档与生成物的漂移（本波发现）

R3-2 已把无断言项从 9 降到 2，但 **`docs/frozen-register-2026-09-21.md` 未随台账推进** ——
正档仍写「## 3. 无断言门禁（**9 个**，冻结）」且表列 9 行，与台账实测的 2 项**直接矛盾**
（生成物重跑后标题/表格会变成 2，`--check` 亦报「已消除无断言项 (7)」）。
根因不是谁写错，而是**「登记是生成物」这条纪律只被执行了一半**：`gates.mjs --check` 更新的是 `out/`（gitignore），
而正档 `docs/…` 需**显式重跑 `gen-register.mjs`** —— 中间没有任何检查会发现二者已不同步。

处置（本波）：

- 重跑 `gates.mjs --check`（刷新 `out/` 台账）+ `gen-register.mjs`（**刷新正档**）⇒ 正档反映实测：标题 **2 个**、表 2 行。
- **新增「进展（R3 波）」段**（写进 `gen-register.mjs` 的固定文案 ⇒ 重生成不丢）：解释 9 → 2 的来龙去脉，
  逐波列出被覆盖的 9 项与处置，使"数字变小"不会读成"凭空消失"。
- **生成器新增输出路径覆盖** `REGISTER_OUT=<path>`（缺省 = 正档，行为不变）⇒ 使「生成物 vs 版本控制内文件」的
  漂移**可校验**：`REGISTER_OUT=scripts/audit/out/frozen-register.preview.md node scripts/audit/gen-register.mjs`
  再 diff 预览与正档即可，**不必覆盖正档**。本波实测：**零漂移**（逐字节一致）。
- 附注：`gates.mjs --check` 的基线留档 `docs/audit-2026-09-21-gate-ledger.json` **刻意停在 R3-1 时点**
  （它是"当时快照"，推进它会让 `--check` 失去"发现新漂移"的能力）；故本波 `--check` 会持续报
  「已消除无断言项 (7)」—— 这是 **R3-2 的成果**，属**预期漂移**，不是错误。

> **教训（并入 R3 通则）**：生成物纪律要覆盖**全链**——只重跑"数据段"而忘记"正档"，
> 会让台账与叙述长期背离，而任何 `--check` 都发现不了（因为 `--check` 比的是数据段）。
> 与 §6.1「宣称为真 ≠ 实现为真」同族：**「生成了」≠「正档已更新」**。

---

## 10. R3-5：断言强度台账（`testHits` 的分辨率补全）

### 10.1 动机：`testHits > 0` 只能证「被提到」，不能证「被拴住」

`gates.mjs` 原有口径把每个拒码的测试命中数记为 `testHits`。§6.1 之后已知它是**覆盖代理量**，
但缺一台静态机器把这层分辨率补上：`testHits` 不区分

- 命中落在**测试标题**（`test('… GATE_X …', …)`）⇒ **零**证明力；
- 命中落在**夹具常量 / 注释残句** ⇒ 非断言；
- 命中落在**真实断言的期望值** ⇒ 才是「码被拴住」。

故本波把每个命中按**出现位置**分为四类：`title` / `exact` / `weak` / `other`，
并新增两档「弱断言」清单（`node scripts/audit/gates.mjs`）：

| 桶 | 判据 | 处置意义 |
|---|---|---|
| `title` | 落在 `test()/it()/describe()` 的标题字面量内 | 点名而已，须补真断言 |
| `exact` | 落在断言语句窗口内，且窗口含**整码证据**（整码字面量 / 前缀锚定消息正则 / 常量别名标识符 / 自定义助手实参） | 已拴住 |
| `weak` | 落在断言窗口内但找不到整码证据 | 只锁了附带标记 |
| `other` | 其余（夹具 / 常量声明 / 非断言表达式） | 非断言 |

### 10.2 判别力自证（`--selftest`，9 例）

**探测器必须自证有分辨率** —— 否则它本身可能空转并把"永远绿"伪装成"零缺陷"（R3-4 教训的同族要求）。
`strengthSelfTest()` 用 9 段内联源码锁住分类行为：`node scripts/audit/gates.mjs --selftest`。

### 10.3 三轮修复：每一轮都是**自证先转绿、真实数据再收敛**（不是一次性写对）

| 轮 | 触发 | 修法 |
|---|---|---|
| 1 | 初版对新仓数据报 **11 枚**弱断言，`exact = 0` | 其中 4 枚（`GATE_COMPLETE_EXEC_PENDING` 等）实为 `const CODE_X = 'GATE_X';` 声明后**用标识符断言** ⇒ 补常量别名解析 ⇒ 降到 **6** |
| 2 | `GATE_EXEC_INPUT_MISSING` 等断言写成 `/^GATE_X: flows…/`（**前缀锚定 + 消息**） | 放宽整码判据到「以码开头且后续非词字符」⇒ 降到 **3** |
| 3 | `GATE_ARTIFACT_NOT_A_FILE` 等走自定义助手 `assertRejected(...)` | `ASSERT_RE` 由 `assert.*(` 放宽为 `assert<任意标识符>(` ⇒ 降到 **1** |

> ⚠ **每一轮的教训是同一个**：**静态审计器的假阴与假阳同等危险** —— 假阳诱发无效补测，
> 假阴让真缺口躺在"已覆盖"的名单里。故「新规则上线」必须与「自证通过」成对出现，
> 且要用**真实仓数据**复核收敛过程（不是只看自证绿）。

### 10.4 最终扫描结果（2026-09-21，`lib/**` 零 diff）

- **点名但无载荷断言：1 枚** —— `GATE_BATCH_CONTROL_ACTION_INVALID`（`test/batch-control.test.js:220`）。
- **有命中但无载荷断言：0 枚**。
- **无断言拒码：仍为 2 枚**（`GATE_ARTIFACT_MISSING` 哨兵 + `GATE_NO_DECLARATION` 不可达分支，刻意不补）。

**余下那 1 枚的人工判读（工具分辨率之外，须显式记录）**：

看似「窗口不够长」：断言 `{ ... }` 中该码出现在 `assert.rejects(` 起点 400 字符之外。
但顺着读下去发现的是另一回事 —— 该断言写成 **OR**：

```js
(e) => /invalid arguments: "action" must be one of \[…\]/.test(String(e.message))
   || /^GATE_BATCH_CONTROL_ACTION_INVALID: /.test(String(e.message)),
```

⇒ 只需**任一**成立即通过；而注释明写「实到 = ①（参数面先于 execute）」。
这与 §6.1 的 `GATE_DIFFICULTY_INVALID` 是**同一族**（**声明面把实现面变死码**，fail-closed、非安全洞），
只是本例额外叠了一层：**OR 让断言对该码永远不承担责任**。
**静态工具无法估值 OR 语义** ⇒ 本波**只登记不处置**（与 §8.4「维持冻结」口径一致：不动 `lib/**`）。

解冻条件与 §8.4 相同：① 新引擎定型解除 W6；② 给出「要么拆 OR 为两条独立断言，要么承认该分支不可达并从 description 移除归属」的口径。

### 10.5 验收判据（本波）

1. `node scripts/audit/gates.mjs --selftest` ⇒ **9 例通过**（退出码 0）。
2. `node scripts/audit/gates.mjs` ⇒ 新两档清单如上；**无断言拒码仍为 2**（不得因本波改变集合）。
3. `node scripts/audit/gates.mjs --check` ⇒ 拒码集合 **66 → 66**（零增删）。
4. 全量测试 **Δfail = 0**（新增文件在 `scripts/audit/`，不进测试计数；静态基线零漂移）。
5. `git diff --stat -- lib` **空**。

---

## 11. 2026-09-21 用户裁定（A1 / A2 / A3）与两处勘误

### 11.1 A1 · `GATE_BATCH_CONTROL_ACTION_INVALID`：**冻结**（不删、不改、不拆 OR）

- **用户裁定**：「删掉或冻结」。
- **实测否决了「拆 OR + 直调补断言」这条路**：`defineTool`（`node_modules/@deepseek-ai/dsh-tools/lib/index.js:836`）把参数校验**包在返回对象的 `execute` 内部**——`:862` 是包装体、`:864` `throw new ToolArgsError(violations)`，位置在 `userExecute` **之前**。⇒ 直调 `tool.execute(args, ctx)` **同样走校验**，**不存在「绕过 `parameters` 的调用形态**」（`userExecute` 闭包外部拿不到）。
- ⇒ 方案①（补一条引擎面直调断言）**不可行**；方案③（删分支 / 改 `description`）动 `lib/**` 且会丢 fail-closed 兜底、撞「不得以『无断言』为删除理由」。
- **裁定：冻结**。保留现有 OR 断言与引擎兜底分支，登记为「声明面遮蔽 + 内核兜底」，与 `GATE_DIFFICULTY_INVALID` 同族。**绊线**：`action` 的 `enum` 声明一旦被移除/放宽，OR 的第二支即升为真断言 ⇒ 届时改判。

### 11.2 A2 · `assign_check` 保留；「不可达」的**定性勘误**（非失实，是既有分层口径）

- **用户裁定**：保留 `assign_check`；Agent 需填的参数是对的；门禁也生效过 ⇒ 核查「哪里不符合预期」。
- **核查结论：我的事实观测对，定性错。** 三处既有登记早已写明该分层，且是**设计意图**：
  - `CHANGELOG.md:314`：「`difficulty` 枚举/缺参由**工具参数 schema 层**先行拒（`invalid arguments: …`）；`GATE_DIFFICULTY_INVALID` / `GATE_DIFFICULTY_RATIONALE_MISSING` 是同一拒收在**内核显式分支**的命名（勿当外部错误码 grep）」
  - `docs/governance-technical.md:81`：「码字 `GATE_DIFFICULTY_INVALID` 是同一拒收在**内核显式分支**的命名（**仅在绕过 schema 的调用路径可见**，**勿当作可 grep 到的外部错误码**）」
  - `presets/punky-preset/references/discipline.md:328`：「段一 · 框架参数面：宿主在进入 `execute` **之前**按工具参数 schema 拒…文案由**宿主**生成，**不带** `GATE_*` 引擎码」
- ⇒ 「门禁也生效过」成立：该分支在 schema 加 `required`/`enum` 之前是**唯一防线**，且按登记它至今仍是「绕过 schema 的调用路径」上的兜底。我在 R3-2 把它当作新发现并定性为「归属失实」，是**未先检索既有登记**的流程缺陷，**不是代码缺陷**。
- **处置**：`lib/**` 零改动、`description` 一字不改；§6.1 结论改判；绊线保留（schema 一旦放宽 ⇒ 引擎码重新外显 ⇒ 转红提示改判）。
- **附带一处措辞偏差（如实登记，本波不动）**：`discipline.md:328` 的「宿主在进入 `execute` **之前**」，实测是「`defineTool` 包装体内、用户 `execute` 体之前」（同 §11.1）。语义无误但易读成「宿主层、插件无控制权」。属 `presets/**`，归资产会话。

### 11.3 A3 · `sectionLineHit` **不是幻觉**（实证）；plan 产出规格与判据**正面冲突**（新增，须裁定）

- **实证（非幻觉）**：`lib/state/gates.ts:399` `function sectionLineHit(content: string, section: string): boolean`；构建产物 `lib/state/gates.js:352` 同；且被**真实消费**——`gates.ts:978` `requiredSections.some((s) => sectionLineHit(content, s))`、`:987` 子章节判据。⇒ §8.2「同文件内既有行首锚定 + 整行匹配的判据函数」这一论据成立。
- **你拟定的 plan 产出规格** `C://Users//Administrator//.jiuwenswarm//agent//workspace//skills//spec-writing//SKILL.md` 与现行判据**正面冲突**：该规格 13 章全为英文——`## Overview` / `## Problem` / `## Solution` / `## Requirements`（`### Functional` `### Non-Functional`）/ `## API Design` / `## Key Dependencies` / `## API Contracts 引用` / **`## Acceptance Criteria`** / `## Testing Strategy` / `## Success Metrics` / `## Timeline` / `## Open Questions`；**无 `## 验收标准`、无 `## 约束`** ⇒ 照此规格产出的每份 spec **都会被 `GATE_PLAN_CONTRACT` 拒**（`gates.ts:994` 要求两章齐备）。
- ⇒ A3 的实质**上移一层**：不再是「`includes` vs `sectionLineHit` 的形态之争」，而是「**章节名字面量是否与产出规格一致**」；且引擎**已有配置化通道** `required_sections` + `sectionLineHit`（`gates.ts:978`）⇒ 硬编码的 `:903`/`:994` 是与该通道并存的**第二套判据**（这是 §8.1「无抽取对象」之外、更值得抽的一处）。
- **三选一（须你裁定）**：
  ① **规格本地化**：模板保留 spec-writing 骨架，但把 `## Acceptance Criteria` **映射**为中文 `## 验收标准`、`## Requirements`/`### Non-Functional` 映射为 `## 约束`。⇒ 引擎判据**零改动**，可立即开工。
  ② **判据改英文名**（或中英任一命中）。⇒ **行为变更**，须先解冻 W6。
  ③ **判据配置化**：把 `:903`/`:994` 的硬编码章节名收敛进 `required_sections`（或新增 `plan_spec.sections` 声明面），规格可换而代码不改；**顺带消掉 §8.2 的 fail-open**（配置化时一并定命中形态）。⇒ 代价最大，且与 A4 新引擎形态同向。
- **我的建议**：③ 与你的新引擎形态（更细拆分 / 黑板可变）同向，但属门禁行为与结构变更 ⇒ 应随新引擎独立波落地；**过渡期若要先用 spec-writing 规格，取 ①**（零改动即可开工）。

### 11.4 本波（§11）验收判据

1. `git diff --stat -- lib` **空**；`git diff --stat -- test` **空**（纯文档 + 生成器文案）。
2. `REGISTER_OUT=<preview> node scripts/audit/gen-register.mjs` 与正档 diff **零漂移**。
3. `node scripts/audit/gates.mjs --check`：拒码集合 **66 → 66**；无断言项 **2 → 2**。
4. 全量测试 **Δfail = 0**（文档与生成器改动不进测试计数；若跑则须仍为 1729 / 0 fail / 4 todo）。
