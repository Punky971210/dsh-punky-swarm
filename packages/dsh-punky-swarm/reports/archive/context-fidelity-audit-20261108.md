# 引擎上下文保真度审计：为什么成员与 Leader 在大项目下"降智"

- 审计对象：`packages/dsh-punky-swarm` 运行期信息面（成员输入 / Leader 输入）
- 判据：真实批次实测 + 引擎源码逐点核对；不采信回执与口述
- 日期：2026-11-08
- 难度档：A（Leader 直做只读诊断，无并行线）

---

## 0. 一句话结论

**不是模型问题，是两处信息面设计的合成结果：成员侧信噪比 2.6%，Leader 侧信噪比约 2.1%，两侧都被「全量倾倒 + 恒定模板」拖累。小项目下无害，lane 数一多就致命。**

---

## 1. 成员侧：worker 执行时实际拿到的信息

### 1.1 实测任务包构成

工具：直接调用 `composeWorkerPrompt`（引擎自派路径的同一函数），参数取一条典型 exec lane。

| 段 | 字符 | 占比 | 是否随任务变化 |
|---|---|---:|---|
| `## 纪律`（7 条 + 3 条层相关） | 748 | **31.8%** | ❌ 全部 lane 恒定 |
| `# 任务包` 头契约（lane/层/角色/目标/消费件/产物/产物根/批归属会话） | 548 | **23.3%** | ❌ 仅路径变，措辞恒定 |
| `## 你的职责 / 你被授权决定 / 交付要求`（role 三段） | 531 | 22.6% | ❌ 同 role 跨批恒定 |
| `## 开工前必做`（preflight 四段） | 291 | 12.4% | ⭕ 声明了才变，多数为空建议行 |
| `## checkpoint 计划` | 145 | 6.2% | ⭕ 半变 |
| **`## 任务要点（Leader 补充）`** | **60** | **2.6%** | ✅ **唯一任务特有** |
| **合计** | **2351 字符 / 61 行** | 100% | |

### 1.2 关键否证：不是预算截断

- `lib/assembly/schema.js:51`：`injectBudget` 默认 `enabled:true`，`perItemBytes:3072`、`perBlockBytes:12288`、`totalBytes:32768`、`headBytes:2048`、`tailBytes:1024`
- 实测任务包经 UTF-8 后约 7 KB，**总量上限 32768 字节远未触顶**
- `leaderPrompt` 单条目上限 3072 字节，Leader 实际只用了 60 字（约 180 字节）

⇒ **那 2.6% 不是引擎截断造成的，是 Leader 只写了这么多。引擎给了 3072 字节的位子，用掉 6%。**

### 1.3 恒定模板里的具体冗余（抽样）

- 「批归属会话」一句约 180 字符，只为说明「调治理工具时要传 session」这一个事实
- `## 纪律` 7 条全部是跨 lane 相同的护栏（写盘只用 edit/write、禁 git 写、断言前先核、显式回报…）
- 这些内容对**每条 lane、每个批次、每个项目**都逐字相同 ⇒ 属于「已知恒真的前提下重复告知」

### 1.4 D 档（官方 Team 席位）更糟：零引擎装配

| 事实 | 位置 | 含义 |
|---|---|---|
| `spawn_teammate` 为 `providedBy:'host:agent-team', registeredByEngine:false` | `lib/governance/host-tools.js:55` | 引擎**不注册**该工具 |
| `dispatch-register.js` 只在 post-execute **事后**登记 worker→lane 映射 | `lib/bridge/dispatch-register.js:214-279` | 观察者，**不碰 prompt** |
| `spawn_teammate` 参数面无 role 位 | 宿主工具面 | 只能靠「引擎给件 → Leader 取件拼装」 |

⇒ **D 档任务包 100% 由 Leader 手写**：没有 lane 契约、没有产物根、没有纪律注入、没有 consume/produce 声明。
（`taskpack_for` 正是为此设计，但当前**搁置**未启用。）

---

## 2. Leader 侧：安排任务时读到什么

### 2.1 真实大项目批次实测

批次 `edu-backend-refactor-20261015`（本机真实历史批，非构造样本）：

| 读数 | 值 |
|---|---|
| 批次状态文件 | 524,260 字节 |
| lane 数 | **52** |
| 事件数 | 447 |
| lane 终态分布 | merged 44 / failed 3 / skipped 4 / pending **1** |

### 2.2 `batch_status` 单次调用的返回体积

`lib/tools/query-tools.js:134` 的投影：

```js
return { ..., lanes: b.lanes, ...derivedOf(b), wavePlan: b.wavePlan, ...,
         recentEvents: b.events.slice(-20), ... };
```

`wavePlan: b.wavePlan` 是**全量**，无任何裁剪。

| 投影项 | 字节 | 说明 |
|---|---:|---|
| `wavePlan`（全量） | **75,935** | 52 lane 全部 `cmd` 合计 46,214 字节；其中 **51/52 = 98% 的 lane 已终态** |
| `recentEvents`（末 20 条） | 11,894 | 历史事件 |
| `lanes` | 1,093 | 状态映射 |
| **合计** | **≈ 88,922 字节** | ≈ 30K+ token（中文按 1.5 字/token 保守估） |
| 真正需要看的 | ≈ 1,900 | 1 个 pending lane 的 cmd ≈ 900 + 状态 1,000 |
| **信噪比** | **≈ 2.1%** | |

### 2.3 噪声的三个具体来源

| 来源 | 量 | 性质 |
|---|---:|---|
| 已终态 lane 的历史 `cmd` | 约 45 KB | **纯噪声**：44 merged + 4 skipped 的任务描述对当前决策无信息 |
| 恒 `null` 字段 | 418 个 / 约 7.5 KB | `model` / `tools` / `skills` / `consume` / `standalone` / `standaloneReason` / `condition` / `checkpoint` / `targets` / `targetsMarker` 每 lane 各 8-11 个 null |
| `produce` ≡ `outputs` 重复 | 1,492 字节 | 同路径写两遍 |
| 单 lane `cmd` 内部结构 | avg 889 字节 | 内含 `[role=…] 角色/目标/关键契约/验收标准/产物契约/期望输出格式` 六段套话 |

### 2.4 没有「只看未完成」的读面

`batch_status` 参数面只有 `batchId` / `ids` / `session`（`query-tools.js:57`）。
`gate_status` 同样的形态：`Object.keys(batch.lanes).map(...)` **逐 lane 全量投影**（`query-tools.js:179`）。

⇒ Leader 想看「剩下 1 条 pending 该怎么派」，必须先把 51 条已完成的历史任务描述读进上下文。

---

## 3. 降智机制：两侧合成

```
                      ┌─────────────────────────────────────┐
   Leader 侧           │ batch_status 全量投影 89 KB          │
   每轮决策读一次  ───▶ │   ├ 98% 是已终态 lane 的历史 cmd     │
                      │   ├ 418 个 null 字段                 │
                      │   └ produce ≡ outputs 重复           │
                      └──────────────┬──────────────────────┘
                                     │ Leader 在 2% 信噪比里做判断
                                     ▼
                      ┌─────────────────────────────────────┐
   Leader 写作          │ 每 lane 只能写一句 cmd + 60 字要点    │
   （位子有 3072 字节） │  （实际用掉 6% 预算）                │
                      └──────────────┬──────────────────────┘
                                     │
                                     ▼
                      ┌─────────────────────────────────────┐
   成员侧              │ 任务包 2351 字                       │
   执行时读到      ───▶ │   ├ 97.4% 跨 lane 恒定模板           │
                      │   └ 2.6% 任务特有                    │
                      │ ⇒ 缺「这个改动在系统里意味着什么」    │
                      └─────────────────────────────────────┘
```

### 为什么「小项目」不暴露、「大项目」才暴露

| 场景 | lane 数 | batch_status | 成员任务包 | 表现 |
|---|---:|---|---|---|
| 小任务 | 1-3 | 2-6 KB，信噪比 30-50% | 目标自足，模板无害 | 正常 |
| 大项目 | 40-52 | **89 KB，信噪比 2.1%** | 仍是 97.4% 模板 + 一句目标 | **Leader 决策漂移 + 成员"不懂上下文"** |

lane 数增长时：
- Leader 侧成本按 **O(lane)** 增长（全量投影）
- 成员侧任务特有信息**不增长**（模板恒定，cmd 仍是一句）
- ⇒ 两者的信息断层随项目规模**线性扩大**

---

## 4. 已排除项（不要往这三个方向找原因）

| 怀疑 | 判据 | 结论 |
|---|---|---|
| `injectBudget` 截断 | 上限 3072/32768，实测 7 KB / 180 字节 | ❌ 未触顶 |
| `model_tier` / 模型档位 | 宿主仅全局 `deepseek-flash`，无 tier 概念 | ❌ 幻觉字段，已裁决撤销 |
| role 语料缺失 / persona 送不进 | role 三段注入正常；persona 已补进任务包首行 | ❌ 已修复 |

---

## 5. 待裁决的三个修法（不自行实施）

### 甲 · `batch_status` 加裁剪读面

- **做什么**：参数面加 `view: 'summary' | 'active' | 'full'`；`active` 只返回非终态 lane 的 wavePlan 条目
- **代价**：`query-tools.js` 一处投影改 + schema + 测试；约半天
- **收益**：89 KB → ≈ 2 KB（砍 98%）；这是**最高杠杆点**
- **风险**：调用方若依赖全量形状会破；需保留 `full` 缺省兼容
- **推荐**：**首选**。单点改动，直接消除 Leader 侧读放大。

### 乙 · 任务包模板瘦身 / 分层裁剪

- **做什么**：`## 纪律` 按 lane 类型裁剪（audit 不念 handoff 交接条、单件写盘 lane 不念 progress 条——后者已有）；「批归属会话」长句压成一行短句
- **代价**：`composeWorkerPrompt` 改造 + 逐字节回归面 E-CK6 要重算；1-2 天
- **收益**：任务包 2351 → 约 1500 字，纪律占比 31.8% → 15%
- **风险**：**降低护栏 = 可能提高停轮率**（现有 7 条纪律里 2 条是收 5 次 `auto.settle.paused` 教训才加的）；动了要有停轮率对照读数
- **推荐**：次选。需先拿「纪律条 ↔ 停轮事件」的对应读数证明某条可以删，否则不动。

### 丙 · per-lane 项目上下文位

- **做什么**：给 `wave_plan` 的 task 加 `context` 字段（Leader 可写该项目/该域的既有约定与历史坑），注入任务包
- **代价**：`wave-plan.js` schema + `composeWorkerPrompt` + 契约校验；2-3 天
- **收益**：解决根因——成员终于能拿到「项目知识」而不只是「任务目标」
- **风险**：新增字段 = 新增注入面，需同步过 `injectBudget` 预算面与文档；且现状 `archContext` 已占一个相近位（但只覆盖引擎仓自己的跨域白名单，对用户项目无效）
- **推荐**：**根因修法**。甲是止血，丙是治病。建议甲先上，丙单独立批。

---

## 5.5 附带发现（核实过程中实测撞出来的）：C 档自派在 designer / doc-manager 角色上结构性不可用

### 现象

`lane_dispatch` 对 role=`designer` 的 lane 返回：

```
mode: rejected
code: GATE_DISPATCH_CAPABILITY_UNAVAILABLE
"通道在，但本次 ask 的收窄不可核：已配置 config.dispatch.agentPreset，
 但适配层无法核对它对本次请求的收窄……"
```

lane 保持 pending，零副作用（无句柄、无 `member.dispatch`、批相位不变）。

### 根因（逐层定位，不是猜测）

| 层 | 事实 | 证据 |
|---|---|---|
| 配置 | `~/.dsh/punky-preset/config/runtime.json` 的 `dispatch` 段**已配齐** | `agentPreset: "punky-preset"`；`presetCoverage["punky-preset"].tools = [read, glob, grep, pwsh, skill, write]` |
| 判据 | `presetFor(ask)` 读 `deny ∩ covers`，相交 ⇒ 返回 `null` ⇒ 端口判 `canNarrow=false` | `lib/engine/dispatch.js:1216-1231` |
| `covers` | 上述 6 个工具 | 同上 |
| `deny` | `SUITE_DENY_TOOLS` ∪ `deriveDenyTools(role.tools.allow)` | `dispatch.js:505-511`、`:1196-1198` |
| `deriveDenyTools` | = `roleToolVocabulary()` **减去** `allow` | `dispatch.js:510` |

⇒ **冲突项是 `pwsh`**：covers 含 `pwsh`，而部分角色的 `tools.allow` 不含 `pwsh` ⇒ `pwsh` 落入 deny ⇒ 相交 ⇒ 拒派。

### 逐角色实测（`skills/software-team/references/roles/*.md` 的 `tools.allow`）

| role | `tools.allow` | 与 covers 冲突 |
|---|---|---|
| coder | read, write, edit, glob, grep, pwsh, skill | ✅ 无 |
| coordinator | read, glob, grep, pwsh, skill, write | ✅ 无 |
| **designer** | read, glob, grep, skill, write, edit, memory_search | ❌ **`pwsh`** |
| **doc-manager** | read, glob, grep, write, skill, memory_save, memory_search | ❌ **`pwsh`** |
| reviewer | read, glob, grep, pwsh, skill, write | ✅ 无 |
| supervisor | read, glob, grep, pwsh, skill, write | ✅ 无 |
| tester | read, glob, grep, pwsh, skill, write | ✅ 无 |

### 性质判定：**不是引擎缺陷，是配置与角色语料的结构性错配**

引擎的行为是**正确的**：若放行，`designer` lane 的 worker 会实际拿到 `pwsh`（越权），因为 `presetCoverage` 声明该 preset 含 `pwsh`，而 preset 是固定组合、无法按次裁剪。

但**结构上**这暴露了一个限制：`config.dispatch.agentPreset` 是**全局单一值**，而 `tools.allow` 是**per-role** 的 ⇒ 只要有一个角色不允许 preset 里的某个工具，该角色的 lane 就永远派不出去。**plan 层的 `designer` 与 `doc-manager` 正好是这类角色。**

### 三条可选修法（未实施，待裁决）

| 选项 | 做法 | 代价 | 风险 |
|---|---|---|---|
| 甲 | 从 `presetCoverage.tools` **移除 `pwsh`** | 改 1 行 runtime.json，热生效 | 声明与实际不符 ⇒ designer 仍会实际拿到 pwsh（把越权藏起来，而不是消掉） |
| 乙 | 给 `designer` / `doc-manager` 的 `tools.allow` **加 `pwsh`** | 改 2 个 role 语料文件 | 放宽角色边界（设计层不需要命令行） |
| 丙 | **按角色分 preset**：`dispatch.agentPreset` 支持 per-role 映射 | 改引擎 `presetFor` 契约 + 配置面 | 正确但工时大；需新增 `presetCoverage` 与角色的匹配层 |

**本批采用零改动的绕法**：plan 层 lane 的 role 用 `coordinator`（同 plan 层、covers 全覆盖），既不撒谎也不放宽权限。

---

## 6. 证据索引

| 断言 | 证据位置 |
|---|---|
| 任务包分段字符数 | 探针 `probe-taskpack-density.mjs` 实测 `composeWorkerPrompt` 产出 |
| injectBudget 默认值 | `lib/assembly/schema.js:51` |
| 预算模块不内置默认、由调用方传 | `lib/comms/inject-budget.js:45-46, 159-161` |
| D 档零引擎注册 | `lib/governance/host-tools.js:55` |
| dispatch-register 只事后登记 | `lib/bridge/dispatch-register.js:214-279` |
| batch_status 投影形状 | `lib/tools/query-tools.js:134` |
| gate_status 逐 lane 全量 | `lib/tools/query-tools.js:174-179` |
| 52-lane 批次实测数字 | `~/.dsh/punky-preset/sessions/session-4b164321-…/batches/edu-backend-refactor-20261015.json` |
| archContext 仅覆盖引擎仓跨域白名单 | `lib/engine/arch-context.js:99-133` |
| checkpoint 归一化丢项（探针形态错误） | `lib/wave-plan.js:512-514`（只认 `{items}` 形态）、`lib/engine/dispatch.js:668` |
