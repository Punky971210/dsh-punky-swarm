# 引擎三面深挖 · 待裁决事项（2026-11-07）

> 批次 `punky-engine-core-deepdive-20261107`（5 lane 全 merged，audit verdict=approve / blocking=4 / followup=8）
> 代码锚定 HEAD `5753d46`，`git status --porcelain` **空**（全批零源码改动，纯分析）
> 本文件是 grilling 对接的完整背景。对话里只给摘要，裁决见 `ask_user_question`。

---

## 〇、先交代「这批到底做了什么」

用户要求深挖引擎三面：**任务黑板 / 交接 / 多成员协作**。5 个 lane：

| lane | 产出 | 规模 |
|---|---|---|
| `p1-scope` | 划读域（105 件归属表）+ 三份提纲各 12 问 + 交叉口径 11 行 | 442 行 |
| `e1-board` | 黑板面 B1-B12 全答 + **17 条不变量**（每条含潜在破坏场景）+ 11 条续补背离 | 873 行 |
| `e2-handoff` | 交接面 H1-H12 全答 + **H8 定论** + 14 条缺陷 + 探针 | 525 行 + 8.2KB |
| `e3-collab` | 协作面 C1-C12 全答 + 成员态机（10 边 + 46 未声明组合）+ 20 条失败模式 | 499 行 |
| `a1-gate` | 逐面抽验 + 跨面缺陷汇总 + 交叉一致性 + 可测性评估 | 277 行 + gap-list |

**核心悬念 H8 已解**（这是本轮最重要成果）：
> 运行期「必须成立的边集合」真源**只有一个** —— `declaredInboundEdgesOf`（单点 `gates/helpers.js:198-226`）= `depsOf(t) ∪ {handoffs[lane].from}`，逐边带 `source:'deps'|'accept'`。
> **拓扑/顺序只认 `deps`；边是否成立认并集；两侧不一致一律按「缺」拒（`rec=null` 分支，无静默取一方）；`handoffs ⊋ deps` 唯一合法来源是 `handoff_accept`（净收紧）；存量批 `handoffs === undefined` = 本批不受门约束。**

**audit 还抓到一处 exec 间实质矛盾**（已由 Leader 订正）：
> `board.md:346` 说「`handoffs` 保留既有条目（不重建丢档）」⟂ `handoff.md` D-1 说「accept 边被整条丢弃」。按代码裁定 **交接面对、黑板面错** —— `plan-mutate.js:239` 是 `deps.map(...)`，新数组只由 `deps` 生成；`:238` 注释的作用域只在 `from ∈ deps`。**黑板面是复述注释而没核代码**（它自己还报了 11 条注释背离）。`board.md:346` 已订正。

---

## 一、五条缺陷的事实基础（裁决的前提）

它们不是五个独立问题，而是**同一个主题的三个侧面**：

> **门依赖的东西（状态位 / 终态 / 配置），在某条路径上不受保护。**

| 编号 | 名称 | 门的哪个依赖失守 | 攻击/触发方式 | 后果方向 |
|---|---|---|---|---|
| **BL-2 = U-3** | `handoffs` 无防篡改守卫 | **状态位**（`handoffs[to][i].status`） | 手改批 JSON 3 个键（`status`/`artifacts`/`contract.assertions`） | 外部伪造 → **假满足** |
| **BL-3 = D-1** | `accept` 边被 `task_update` 静默丢弃 | **边集合**（`source:'accept'` 的条目） | 引擎自己的合法路径 | 净收紧**静默免义务** |
| **BL-4 = D-2** | 终态批仍可 `handoff_submit` | **终态**（`recordHandoff` 零终态校验） | `batch_phase(aborted)` 后照常提交 | 终态后仍可写 |
| **D-12**（新核） | 图变更路径交接门读**空配置** | **配置**（`handoffGate` 透传断裂） | `task_update` → `buildWavePlan` 未传 `handoffGate` | 门与真实配置脱钩 |
| **B-7** | `evaluateTierCDispatch` 恒 `ok:true` | **凭证**（token 从"拦截"降为"留痕"） | 有意放宽，但配置面仍回显 `enforce` | 审计误读 |

### 1.1 BL-2 / U-3：`handoffs` 无任何防篡改守卫

**事实**（audit 独立验证）：
- `assertWavePlanImmutable`（`store.js:559-616`）的 `flatTasks/byId` **只取 `wavePlan[].tasks[]`**，全函数**零处**触及 `handoffs`
- 扩查 5 种模式（`handoffs.*immutab` / `handoffsImmutab` / `assertHandoffs` / `handoffs.*snapshot` / `handoffs.*sha`）在 `lib+test+scripts` **全 0 命中**
- 建批种子（`store/batch.js:107-113`）已满足 `contract.consumedFrom` ⇒ **攻击只需改 3 键**
- **settle 出口门被同一记录一并绕过**：`gates/handoff.js:84-90` 遍历 `Object.values(map)` 的**全部**记录找 `rec.from === lane` ⇒ **一条**伪造记录同时满足「下游 entry 的 ∀」和「上游出口的 ∃」
- 5 个旁路面全验无效：`handoff_view` 走同一单点 / `replay-verify` 只折 `member.settled`·`batch.phase` 不碰 handoffs / 事件流全仓仅 2 条注释写明「读端真源 = `batch.handoffs`，不做事件流重建」（`event-types.js:204` / `contracts.ts:207`）⇒ **无一致性校验器** / IMM 不覆盖 / 手改不改 `__rev` 故 CAS 不冲突

**对比**：同一个批 JSON 里 `wavePlan` 有 IMM-0..5 全套护栏，`handoffs` 一条没有。

### 1.2 BL-3 / D-1：`accept` 边被静默丢弃

**事实**：`plan-mutate.js:239` 是 `handoffs[p.id] = deps.map((from) => byFrom.get(from) ?? {…种子…})` ⇒ 新数组**只由 `deps` 生成**，`from ∉ deps` 的条目（accept 边永不写 deps）整条消失。

**实测**（交接面探针）：accept 后 `edges=['e1','z1']` → `task_update` 加边后 `edges=['e1','x1']`，`z1EdgeSurvived:false`。

**零留痕**：`:244` 是 `edgesLog.push({id, add})`、`:253-255` 是 `plan.mutated{edges}` —— **无 `dropped` 字段**。

**影响双向**：
1. 下游「多等一条上游」的义务静默减少
2. **上游出口门「有无下游」集合同步少一条 ⇒ `downstream:[]` ⇒ 该门零感知**（`gates/handoff.js:60-71`）⇒ G-10 的净收紧被静默回退

### 1.3 BL-4 / D-2：终态批仍可提交交接

**事实**：`recordHandoff`（`store/handoff.js:93-189`）通读**无终态校验**；`commitBatch` 的终态门只拦 phase 改写。

**实测**：`batch_phase(aborted)` 后 `handoff_submit` 返回 `{ok:true, code:'HANDOFF_OK'}`，`handoffs.e1.status` 由 `pending` → `submitted`，事件流 +1 条 `lane.handoff`，`planRevision` 不变。

**最讽刺**：`handoff_accept` 有 S-e 终态拒（`handoff-accept.js:97-99`/`:120-129`），而它的拒绝理由原文写着「**终态 lane 无法再提交交接**」—— **与代码事实相反**：提交能，接受不能。

### 1.4 D-12：图变更路径的交接门读空配置（Leader 本轮亲核）

**事实**：
- `plan-mutate.js:225-227` 调 `buildWavePlan({ batchId, tasks: merged, team, concurrency })` —— **只传 5 参，未传 `handoffGate`、`smoke`、`hostRoster`**
- `wave-plan.js:949`（`checkHandoffDeclarations` 内）：`const gateOn = opts.handoffGate ?? handoffGateEnabledOf({}, 'entry')` ⇒ **未传就回落到空配置**
- 对照 `wave-plan-tools.js:110`（`wave_plan` 工具面）：`handoffGate: handoffGateEnabledOf(readLiveConfig(deps), 'entry')` —— **传了**

**后果**：`task_update` 改图后的交接声明校验**与真实 `runtime.json` 配置脱钩**；`hostRoster` 同样没传 ⇒ F-8 的 `gate.roster_unknown` 告警在这条路径上也不触发。

**为什么说这是第三条独立路径**：U-3 是「状态位可伪造」、D-2 是「终态不校验」、D-12 是「配置透传断裂」—— 三种不同的失守方式。

**附带疑点**：`smoke` 未传 ⇒ 改图路径上 `smoke` 批的豁免也不生效（待核，本文件记为待验证）。

### 1.5 B-7：`evaluateTierCDispatch` 恒 `ok:true` —— 是「有意放宽」不是「能力退化」

**代码逐字**（`dispatch.js:1541-1544`）：
> `'enforce'` 拒态已删（**勿回加**）… 原码拦的 `subagent`/`subagent_fork` 在官方 profile 里**不存在**（`cordis.patch.yml:10-14` 已 disable）⇒ 闸门拦的工具在官方场景不存在

**且**派发面其它闸仍在（`canNarrow` fail-closed）。

**但三处不干净**（audit 记为 FU-2）：
1. **配置面撒谎**：`readGateMode` 仍把 `'enforce'` 原样返回并被回显进 `mode` 与 `warnNote`（「mode=enforce，留痕不拦」）⇒ **审计会读成「enforce 已开且放行」**
2. 该降级**无裁决留痕**（只有代码注释 + `A1-P2-04` 指向的「双层真相」）
3. 对外仍写「不写 token 即禁止派发」

---

## 二、已明确、无需裁决的部分

| 项 | 结论 |
|---|---|
| H8 真源 | 已定论（见 §〇），audit 代码复核成立 |
| BL-1 结论错报 | **已订正**（`board.md:346`，附订正说明与实测对照） |
| `push_execute` 三件裁决 | 已实装（改名 / 从黑板读 / C-D 双通道） |
| `unbound` 成因 | 已定论：`member.dispatch` 只有 2 写者（`dispatch.js:1509` / `dispatch-register.js:206`），`member_settle` 不写；走 `spawn_teammate` 天然无绑定 |
| B-7 定性 | **有意放宽**，非退化 |
| 可测性 | 17/17 不变量、24/24 态机边、5/5 跨面缺陷、20/20 失败模式可测 |
| 8 项不该设计测试 | 含 **T-4 `batch.policy` 仓内无写点 ⇒ 不可达，别写测试**（写了必假绿）、**T-8 U-3 构造须先开双门否则 RED 假绿** |
| 行数漂移 5 处 | `schema.js/.ts` 315/502、`replay-verify.js` 147、`replay.js` 45、`wave-plan.ts` 1496 —— 属文档债，纯记录 |

---

## 三、四条待裁决（详见对话中的 ask_user_question）

### Q-1 · 五条缺陷怎么修（批次形态）

- **甲（推荐）**：**一批全修 5 条**，用 audit 给的「一条留痕判据」方案一次修完 U-3 + D-1（`status` 或条目集合变化必须伴随 `lane.handoff` / `plan.mutated{dropped[]}` 事件），同批带上 D-2（终态校验）+ D-12（配置透传）+ B-7 配置面清理
- **乙**：只修 P0 两条（U-3 + D-1 留痕判据），D-2 / D-12 / B-7 另批
- **丙**：暂不修，只留档（进 `reports/` 快照）

**推荐甲的理由**：五条都落在同一批文件（`store.js` / `plan-mutate.js` / `gates/handoff.js` / `store/handoff.js`），分开修会重复碰同一批文件并重复建批；且 audit 明确说「**禁止只修 U-3 或只修 D-1**」（两者同族、方向相反，只修一边等于留半边门）。

**不裁的后果**：五条都是 fail-open 且零留痕，拖得越久，"门看着在、实际漏一个检查面" 的债越难清；且后续任何写测试的批都会踩到 D-12（改图路径门关）与 T-8（RED 假绿）。

### Q-2 · D-12 是否升为 blocking（而非 followup）

- **甲（推荐）**：**升 blocking** —— 它让 `task_update` 这条**常用路径**的交接校验与真实配置脱钩，与 U-3/D-2 同类
- **乙**：保持 followup（它只在「配置里开了交接门」时才显形，用户当前是否开了需确认）

**补充事实**：当前 `runtime.json` 的实际配置我这轮没查（`~/.dsh/punky-preset/config/runtime.json` 里有 `gates.handoff.entry: true` 的历史记录）。若门是开的，D-12 就是**真实生效的缺口**；若门本来关着，影响面小。

### Q-3 · B-7 的「配置面撒谎」怎么处理

- **甲（推荐）**：**顺带清三处** —— ① `readGateMode` 不再把 `enforce` 原样回显（改为如实报「已废弃」）② 补裁决留痕 ③ 改对外表述
- **乙**：只改 ①（最小）
- **丙**：不动（`enforce` 可能是存量配置值，改了怕影响兼容）

**风险提示**：`enforce` 若仍被某处配置引用，直接删值可能触发「未知 mode」路径 ⇒ 需先 grep 存量引用。

### Q-4 · 两个责任空档归谁（G-1 / G-2）

- **甲**：按 audit 建议 —— `handoffs` 行为整体判**黑板面**、成立性语义由**交接面复核**；D-12 判**协作面**
- **乙（推荐）**：**全判黑板面**（`store.js` / `plan-mutate.js` 都是黑板文件级主写），但要求**交接面在修批里做复核方**（写验收判据）
- **丙**：Leader 自己认领（不派 worker）

**推荐乙的理由**：判给协作面会造成「文件在黑板、语义在协作」的二次分裂（正是 G-1/G-2 形成的原因）。但交接面必须进修批做复核 —— 它最懂成立性语义。

---

## 四、如果你不裁决

- **Q-1 无默认**：不裁则五条缺陷全部留档，本会话不推进修复
- **Q-2 无默认**：不裁则 D-12 保持 followup
- **Q-3 无默认**：不裁则 `readGateMode` 继续回显 `enforce`（审计会误读）
- **Q-4 无默认**：不裁则修批时归属仍空白，可能复制「三面都以为归对方」的老问题

**唯一有默认的**：`reports/` 里的已知问题快照我会照旧维护，不会因为这些不裁而阻塞。
