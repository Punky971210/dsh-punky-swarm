# 三方案可行性核实报告（上下文保真度修复）

- 核实基线：HEAD `795b43db23040203262e0338f485f37d75f17113`，branch `main`，工作区仅 1 个未跟踪文件（审计报告）
- 快照 tag：`snapshot/pre-context-fidelity-20261108`（annotated，指向上述 HEAD）
- 核实方式：只读代码核对 + 502 个真实批次全量统计；未做任何修改
- 日期：2026-11-08

---

## 0. 快照清单（改动前 sha256 基线）

| 文件 | sha256 | 字节 |
|---|---|---:|
| `lib/tools/query-tools.js` | `c9ca403f…12fac41` | 32,657 |
| `lib/engine/dispatch.js` | `7364d297…5ca9d81` | 135,371 |
| `lib/wave-plan.js` | `dcc17d8d…8bd5021` | 101,100 |
| `lib/tools/wave-plan-tools.js` | `efaa6508…384d7b` | 28,488 |
| `lib/assembly/schema.js` | `3488005b…2475bed8` | 18,652 |
| `lib/engine/arch-context.js` | `d132a9f0…89896a47` | 6,057 |
| `lib/state/store/plan-mutate.js` | `6c61d36d…229ee6ff` | 20,466 |

---

## 甲 · `batch_status` 裁剪读面

### 可行性：**高**（单文件、缺省兼容）

| 项 | 结论 |
|---|---|
| 改动点 | `lib/tools/query-tools.js:57`（`parameters`）+ `:134`（投影） |
| 是否需改双源 | ❌ 不需要（`query-tools.js` 是手写 JS，无对应 `.ts`） |
| 缺省兼容 | 加 `view: 'summary' \| 'active' \| 'full'`，缺省 `full` ⇒ 现有行为逐字不变 |

### 影响面实测

29 个测试文件引用 `.wavePlan`，但**断言长度的只有 4 处**，且：

| 位置 | 断言内容 | 是否受 `view` 影响 |
|---|---|---|
| `wave-plan.test.js:47` | `plan.wavePlan.length === 2` | ❌ 断的是 `buildWavePlan` 直调返回值 |
| `consume-deps-asymmetry-gate.test.js:177` | `r.value.wavePlan.length === waves` | ⚠ **受影响**（`r.value` 是工具返回值） |
| `archive.test.js:99` | `m.wavePlan.waves` 逐字相等 | ❌ 断的是 `readBatch` 原始返回 |
| `gate-techdebt-red.test.js:470` | 观测 `buildWavePlan` 直调 | ❌ 直调 |

⇒ 只有 1 处需要确认，且该测试走的必然是 `full`（无 `view` 参数）⇒ 零改动。

### 必须同时做的两件事（否则引入新风险）

1. **显式裁剪标记**：返回体加 `viewApplied: 'active'`。理由：纪律 #2「以状态文件为唯一事实源」——裁剪后若读者不知情，会把「过滤视图」误当「全量事实源」，比慢更糟。
2. **保留 `eventCount` 与全量 `settled`**：`view` 只裁 `wavePlan`，不动 `lanes` / `eventCount` / `settled` / `danglingLanes`（这些是判定用的，不是噪声）。

### 预期收益（按 52-lane 实测批外推）

| view | 字节 | 说明 |
|---|---:|---|
| `full` | ≈ 88,922 | 现状 |
| `active` | ≈ 2,700 | 1 条 pending 的 task + lanes + 20 条事件 |

### 工作量

0.5 天（含测试面确认）。

---

## 乙 · 任务包模板瘦身

### 可行性：**中 —— 有硬约束，只能动表述冗余**

### 判据源已取得（这是之前缺的东西）

扫描 `~/.dsh/punky-preset/sessions/**/batches/*.json` 全部 **502 个批次**：

| 事件 | 次数 |
|---|---:|
| `auto.settle.skipped` | 637 |
| `auto.settle.triggered` | 361 |
| **`auto.settle.paused`** | **24** |

停轮 code 分布（24 次的 100%）：

| code | 次数 | 占比 | 任务包纪律段对应条 |
|---|---:|---:|---|
| `GATE_HANDOFF_MISSING` | **18** | **75%** | `## 纪律` 第 5 条「**【交接】完成时必须 `handoff_submit`**」 |
| `GATE_EXIT_NONZERO` | 3 | 12.5% | 无对应纪律条（执行失败） |
| `GATE_EXIT_MISSING_EXEC` | 1 | 4.2% | 无对应 |
| `GATE_LANE_LAYER_MISSING` | 1 | 4.2% | 无对应 |
| (无 code) | 1 | 4.2% | — |

### 由此得到的两条硬约束

1. **纪律第 5 条（交接）不可动**：18/24 = 75% 的停轮由它收口，实证强度最高。
2. **其余 6 条零停轮事件对应** —— 但**这不证明它们可以删**：它们防的是"未发生的错误"，零事件既可能因为"念了才没犯"，也可能因为"本来就不犯"。**这个判据方向不可证伪**，不能作为删除依据。

### 因此安全瘦身范围只有「表述冗余」，不碰纪律条本体

| 可动项 | 现状 | 可压到 | 依据 |
|---|---|---:|---|
| 「批归属会话」解释句 | ≈180 字符 / 1 条长句 | ≈60 字符 | 只说结论「传 `session:"<id>"`」，删掉「重启重建窗口可能解析不到」的机制解释 |
| 纪律第 5 条下的 2 行续行 | 2 行 | 可合并为 1 行 | 语义不变，只压行 |
| 纪律第 6 条（回报编号口径）的 3 行 | 3 行 | 可合并为 2 行 | 同上 |
| 纪律第 7 条（progress 快照）的解释 | 1 长条 | 压一半 | 同上 |

**预估**：任务包 2351 → **约 2050 字符**（纪律 748 → 约 460，占比 31.8% → 22%）。**不会**降到原估的 1500——那需要删条，判据不支持。

### 风险

- `## 纪律` 段有逐字节回归面（`checkpoint-aux.test.js` / `checkpoint-resume-wire.test.js` / `preflight-packet.test.js` 等断言段序与条数）⇒ 改动后要逐个复核
- `accept-pack1-guidance` 类验收锁的是**指引文件**（不是任务包），不受影响

### 工作量

1 天（含回归面复核）。

---

## 丙 · per-lane `context` 字段

### 可行性：**中 —— 链路 5 处，含 ts/js 双源同步**

### 改动链路（逐点已核实）

| # | 文件 | 要做什么 | 是否有双源 |
|---|---|---|---|
| 1 | `lib/types/contracts.js` | `WavePlanTaskInput` 加 `context?: string` | 需确认同名 `.ts` |
| 2 | `lib/wave-plan.ts` **和** `lib/wave-plan.js` | `:1288-1352` 归一化返回对象加 `context`；`:1341` 决定是否进 sig | ✅ **双源，必须同改** |
| 3 | `lib/engine/dispatch.js` | `composeWorkerPrompt` 加 `context` 入参 + 注入段 | ❌ 手写 JS |
| 4 | `lib/tools/wave-plan-tools.js` | `wave_plan` 参数透传 | ❌ 手写 JS |
| 5 | 测试面 | 新增字段的正反向用例 | — |

**双源守卫已存在**：`scripts/build-sync-guard.mjs`，双向判据 ——
- `.ts` 缺符号 ⇒ `源缺，下次 build 会擦除`（危险但可救）
- `.js` 缺符号 ⇒ `产物缺，当前已丢`（**已经丢了**）

⇒ **只改 `.js` 会被守卫抓红，必须两边同改**。这是本方案最大的工时变量。

### 关键裁决点：`context` 进不进 `sig`

`sig` 哈希输入面 = `computeTaskSig({ id, layer, role, deps, produce, outputs, cmd })`（`lib/wave-plan.js:1341-1351`，`sig-fingerprint.js:108`）。

| 选项 | 后果 |
|---|---|
| **不进 sig**（照 `roster` / `singleArtifactWrite` / `preflight` 三处先例，源码注释逐字写「不进 `sig` ⇒ 既有 sig 基线零漂移」） | ✅ 存量批零漂移、IMM-2 不破、工时短<br>⚠️ 已派发 lane 的 `context` 可被静默改写，guard 不拒 |
| **进 sig** | ✅ 已派发即冻结，语义正确<br>⚠️ 存量批无该字段 ⇒ 重算 sig 变 ⇒ **破 IMM-2**，需额外兼容分支（旧批 `context` 缺省时不参与哈希） |

**我的倾向：不进 sig（先例一致、零漂移）**，理由：`context` 是"执行时参考信息"，与 `preflight` 同权重级，不是"任务内容"；且 IMM-2 破的代价远大于"已派发可篡改"的残余风险（篡改需要直改批次 JSON，已有 `assertHandoffsIntegrity` 之外的写面审计）。

### 与 `archContext` 的边界（必须写清，否则两个注入面打架）

| 面 | 来源 | 粒度 | 覆盖范围 |
|---|---|---|---|
| `archContext`（既有） | `.punky/arch.yml` 自动裁剪 | 全局规则 + lane 涉域 | **只对引擎仓自身有内容**（`domainsOfTargets` 要求目标在 `lib/` 下 ⇒ `lib/engine/arch-context.js:86`），对用户项目**恒 null** |
| `context`（新） | Leader 在 `wave_plan` 里手写 | **per-lane** | 用户项目知识（既有约定、历史坑、当前进度） |

⇒ 二者**不重叠**，`context` 段位置建议 = `archContext` 段之后、`## 开工前必做` 之前。

### 工作量

2-3 天（双源同步 + 5 处接线 + 测试）。

---

## 三方案横向对比

| 项 | 甲 · 读面裁剪 | 乙 · 模板瘦身 | 丙 · context 字段 |
|---|---|---|---|
| 解决哪侧问题 | Leader 侧 | 成员侧（部分） | 成员侧（根因） |
| 效用 | 89 KB → 2.7 KB（砍 97%） | 2351 → 2050 字符（砍 13%） | 任务特有信息从 2.6% 起可增长 |
| 可行性 | **高** | 中（只能动冗余） | 中（双源 + 5 处） |
| 改动文件数 | 1 | 1 | 5（含 ts/js 双份） |
| 存量批风险 | 无（缺省 full） | 低（段落回归面） | 取决于 sig 裁决 |
| 工时 | 0.5 天 | 1 天 | 2-3 天 |
| 可逆性 | 完全可逆 | 完全可逆 | 完全可逆（新字段可缺省不写） |
| 判据支撑强度 | **强**（实测 89 KB / 信噪比 2.1%） | **弱**（零事件≠可删，只能动表述） | 中（根因明确，但收益是长期的、无法一次量化） |
| 我的排序 | **1（先做）** | 3（最后，或不做） | **2（单独立批）** |

---

## 待裁决点（3 个）

1. **甲**：是否采纳「加 `view` 参数 + 缺省 `full` + 显式 `viewApplied` 标记」？
2. **丙**：`context` 是否进 `sig`？（我倾向不进）
3. **乙**：只动表述冗余（约砍 13%）、还是先不做？

另有一个附带发现待处置：`renderCheckpointsBlock` 对"未归一形态"（传裸数组）零容错，且报错文案误导（说"缺 id / id 重复 / target 为绝对路径"，真实原因却是形态不对）。**低优先级**，可并入甲批顺手修。
