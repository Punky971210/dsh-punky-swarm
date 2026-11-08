# 交接门五缺陷修法计划（2026-11-07）

> 依据：用户裁决 **Q-1=甲**（一批全修 5 条）/ **Q-2=甲**（D-12 升 blocking）/ **Q-3=甲**（B-7 顺带清三处）/ **Q-4=丙**（Leader 自己认领）
> 执行形态：**Leader 单线程直做**，不派 worker；改完统一提交一次。锚定 HEAD `5753d46`。

## 一、五条修法

### ① D-1 · `accept` 边被静默丢弃（`plan-mutate.js`，纯 JS）

**根因**：`plan-mutate.js:239` `handoffs[p.id] = deps.map((from) => byFrom.get(from) ?? {…种子…})` —— 新数组**只由 `deps` 生成**，`from ∉ deps` 的旧条目（accept 边）整条消失。

**修法（两层，缺一不可）**：
1. **根因修**：新数组改为 **`byFrom` 全量保留 ∪ deps 补新**（accept 条不再消失）
2. **防御留痕**：`edgesLog` 增 `dropped` 字段 —— 若因任何原因有条目被丢，必须记录（正常路径应为空）

**验证**：accept 后 `task_update` 加边 ⇒ accept 边仍在；若构造出丢弃 ⇒ `plan.mutated{dropped}` 非空。

### ② D-12 · 图变更路径交接门读空配置（`task-tools.js` + `plan-mutate.js`，纯 JS）

**根因**：`task-tools.js:150` 的 options 只有 `{reason, author}` ⇒ `plan-mutate.js:225-227` 调 `buildWavePlan` 只传 5 参 ⇒ `wave-plan.js:949` 回落 `handoffGateEnabledOf({}, 'entry')`（**空配置**）。对照 `wave-plan-tools.js:110` 是传 `handoffGateEnabledOf(readLiveConfig(deps), 'entry')` 的。

**修法**：`task-tools.js` 用 `readLiveConfig(deps)` 解析 `handoffGate` 并传进 `addTaskEdges` options；`plan-mutate.js` 调 `buildWavePlan` 时透传（同补 `smoke` / `hostRoster`，三者都是 `wave_plan` 面已在传的）。

**验证**：门开时构造「缺交接声明」的加边 ⇒ 必拒；门关时同构造 ⇒ 放行。**两态都要测**。

### ③ U-3 · `handoffs` 无防篡改守卫（`store.js`，纯 JS）

**根因**：`assertWavePlanImmutable`（`store.js:559-616`）只比 `wavePlan[].tasks[]`，零处触及 `handoffs`。

**修法（audit 候选 B，与 IMM-4 同构）**：新增 `assertHandoffsIntegrity`，在 `commitBatch` 内紧随 `assertWavePlanImmutable`：
- **判据**：`handoffs` 的 `status` 或**条目集合**发生变化 ⇒ 本次 commit 的**追加段**必须出现 `lane.handoff`（或 `plan.mutated` 且覆盖该变化）
- 照抄 `store.js:601-615` 的 `slice(prev.events.length)` 判「本次新增」，避免历史事件假绿
- **无需白名单**：`recordHandoff` / `recordHandoffAccept` 正常路径自身落事件 ⇒ 天然满足

**验证**：手改 `status: 'submitted'` 后触发任意 commit ⇒ 必拒；正常 `handoff_submit` ⇒ 放行。

### ④ D-2 · 终态批仍可提交交接（`store/handoff.js`，纯 JS）

**根因**：`recordHandoff`（`store/handoff.js:93-189`）无终态校验；`commitBatch` 终态门只拦 phase 改写。

**修法**：`recordHandoff` 开头加终态拒（`phase ∈ {complete, aborted}`）；并**订正 `handoff_accept` 的 S-e 拒绝理由文案**（原文「终态 lane 无法再提交交接」与代码相反）。

**验证**：`batch_phase(aborted)` 后 `handoff_submit` 必拒；`overwrite:true` 路径也覆盖。

### ⑤ B-7 · `readGateMode` 配置面撒谎（`dispatch.js`，纯 JS + 文档）

**根因**：`dispatch.js:1545-1548` 仍原样返回 `'enforce'`，被回显进 `mode`/`warnNote`（「mode=enforce，留痕不拦」）⇒ 审计读成「enforce 已开且放行」。

**修法（三处）**：
1. `readGateMode` 不再原样回显 `enforce` —— 返回**实际生效档**（`'warn'`）；若调用方需区分「配置写了什么」，加独立函数，不混入 `mode`
2. **补裁决留痕**：该段注释写明「`enforce` 已按用户裁决废弃，理由 = 原门拦的 `subagent`/`subagent_fork` 在官方 profile 已 disable」
3. **改对外表述**：全仓 grep「不写 token 即禁止派发」等旧表述并订正

**风险**：`enforce` 可能被存量配置引用 ⇒ **改前必须 grep 全仓 `enforce` 引用点**，确认不会进「未知 mode」分支。

## 二、实施顺序（有依赖理由）

```
① D-1（保留 accept 条）    ← 最独立、纯 JS，先做
② D-12（配置透传）         ← 独立
③ U-3（handoffs 守卫）     ← 必须在 ① 之后
④ D-2（终态校验）          ← 独立
⑤ B-7（readGateMode）      ← 需先 grep enforce
⑥ 全量验证 + 基线重冻 + 提交
```

**为什么 U-3 排在 D-1 之后**：若先加守卫再修 D-1，守卫会把「引擎自己合法路径造成的丢弃」误判成篡改 ⇒ **假红**。先修根因再上守卫。

## 三、验证要求（每条都要）

| 类别 | 要求 |
|---|---|
| **RED 构造** | 每条都要「修前必红、修后必绿」双向证据，**禁止只给绿** |
| **两态覆盖** | D-12 必须测门开/门关两态 |
| **双门前置** | U-3 与 D-12 的夹具必须**先开交接门**，否则门关时改前也不红 ⇒ RED 假绿（audit 的 T-8 警告） |
| **禁数量断言** | 用集合/身份表述 |
| **基线** | 改测试后 `node scripts/baseline-snapshot.mjs` 重冻并提交 |
| **全量** | 提交后跑完整 `npm test`（6 段） |

## 四、不做什么（防漂移）

- **不重开架构选择**：H8 已定论（合成真源），本次只补「保护不足」，不改真源结构
- **不动 `handoff_accept` 的净收紧语义**（它是 `handoffs ⊋ deps` 的唯一合法来源）
- **不把 `enforce` 逻辑加回来**（`dispatch.js:1541-1544` 逐字「勿回加」）
- **不改 `wavePlan` 的 IMM-0..5**（它是对的，只给 `handoffs` 补对等守卫）
