# 决策类注释清理台账（cleaned-comments-log）

- **执行批**：`onto-engine-v2-realign-20260924`｜**lane**：`exec-cleanup`（exec 层 · reviewer）｜**执行日**：2026-09-24
- **判据源**：`plan/cleanup-inventory.md`（口径 A = 232 行候选；本 lane 按 §2 逐处执行，**不放宽判定分界**）
- **写域**：`lib/**` + `docs/**`（**未触碰** `presets/**`、`test/**`、`pkg-hashes.txt`、`baselines/**`、`scripts/**`）
- **本件用途**：旧 → 新对照（逐文件计数），供 audit 按 §2 编号抽条复核

## 0 计数总表（逐文件）

> 计数口径：**清单 §2 逐行**（口径 A = 232 行候选）。同一处约束在 `.ts` 源与其构建产物 `.js` 中各占一行，故两行都在清单内（见 §0.1 的【产物】规则）。

| 文件（本 lane 实改） | 清单命中行 | 压缩改写 | 删除 | 保留 | **实改行** |
|---|---:|---:|---:|---:|---:|
| `lib/assembly/chain.js` | 14 | 8 | 2 | 4 | **10** |
| `lib/assembly/flows.js` | 2 | 1 | 1 | 0 | **2** |
| `lib/assembly/team-asset.js` | 15 | 13 | 1 | 1 | **14** |
| `lib/bridge/dispatch-register.js` | 1 | 1 | 0 | 0 | **1** |
| `lib/engine/dispatch.js` | 12 | 7 | 0 | 5 | **7** |
| `lib/engine/suite.js` | 2 | 0 | 0 | 2 | 0（另清单外 E-01 修正 1 处） |
| `lib/governance/config.ts` | 1 | 1 | 0 | 0 | **1** |
| `lib/governance/kernel.ts` | 3 | 1 | 0 | 2 | **1** |
| `lib/governance/tool-ban.ts` | 5 | 3 | 0 | 2 | **3** |
| `lib/governance/types.ts` | 2 | 1 | 0 | 1 | **1** |
| `lib/hot/config-watch.js` | 3 | 2 | 0 | 1 | **2** |
| `lib/index.js` | 6 | 2 | 0 | 4 | **2**（另 C-3 标注 +1 行） |
| `lib/state/event-types.js` | 9 | 5 | 0 | 4 | **5**（另 C-4 行内改 +1） |
| `lib/state/gates.ts` | 26 | 12 | 1 | 13 | **13**（另 C-4 行内改 +2） |
| `lib/state/store.js` | 17 | 8 | 0 | 9 | **8**（另 C-4 行内改 +1） |
| `lib/tools/core.js` | 23 | 14 | 0 | 9 | **14**（另 C-4 行内改 +2） |
| `lib/types/contracts.ts` | 4 | 2 | 0 | 2 | **2**（另 C-4 行内改 +1） |
| `lib/wave-plan.ts` | 8 | 5 | 0 | 3 | **5** |
| **小计** | **153** | **86** | **5** | **62** | **91** |

**§0.1 未手工改的【产物】行（20 行，源行已覆盖）**——`.js` / `.d.ts` 为同名 `.ts` 的构建产物，清单规则：只改 `.ts` 源，`.js` 由 `npm run build` 重生成（本批**禁** build，故这些文件文本暂留旧貌）：

| 产物文件 | 清单命中行 | 其中已改（经 `.ts` 源行） | 保留 |
|---|---:|---:|---:|
| `lib/governance/config.js` | 1 | 1 | 0 |
| `lib/governance/tool-ban.js` | 1 | 1 | 0 |
| `lib/state/gates.js` | 26 | 13 | 13 |
| `lib/wave-plan.js` | 8 | 5 | 3 |
| **小计** | **36** | **20** | **16** |

**§0.2 全清单闭合**：`153 + 36 + 43（其余仅含「保留」行的文件）= 232`；`86 + 5 + 20（产物行）+ 121 = 232` ✓（与清单 §1.5 汇总一致：保留 121 / 压缩改写 105 / 删除 6）。

- **口径 A 复算（改前 → 改后）**：`lib/**`（`*.js`/`*.ts`，排除 `node_modules/**`）行首注释形态 ∧ `裁决|清债|评审` ⇒ **232 → 148**（−84 行；`裁决` 141 · `清债` 5 · `评审` 4，部分行含两词）。差值 = 本 lane 改写/删除的行失去线索词；**未手工改的 `.js` 产物仍保留旧文本**（§0.1），待 `npm run build` 重生成后会进一步下降。
- **行号口径**：下表位置为**清单扫描时点行号**；5 处整行删除（#5/#9/#15/#24/#131）之后的同文件行号下移 1。

## 1 (a) 内部决策注释 · 逐条旧→新

> 记法：`#清单编号 位置｜旧关键片段 → 新关键片段`。未列入的行即清单判「保留」，本 lane 一字未动。

### 1.1 `lib/assembly/chain.js`（10）

| # | 位置 | 旧 → 新 |
|---|---|---|
| 1 | chain.js:36 | `唯一规范位（Leader 裁决 ①，2026-09-16）：` → `唯一规范位：` |
| 2 | chain.js:52 | `【M1 · 步级条件边 on 声明面已下线（2026-09-17 用户裁决，批 handoff-consolidation-m0m1-20260917）】` → `步级条件边 on 声明面已下线：` |
| 5 | chain.js:85 | **整行删除**（`⇒ 2026-09-18 清债轮（用户裁决「清理冗余设计与死代码」）从声明位摘除，声明即拒`；同约束在 #4 行在位） |
| 6 | chain.js:213 | `唯一规范位（Leader 裁决 ①）：` → `唯一规范位：` |
| 7 | chain.js:234 | `` `ok` 语义（**R2-3 裁决 B，2026-09-17 改语义**）： `` → `` `ok` 语义： `` |
| 8 | chain.js:598 | `⑧【M1，2026-09-17 用户裁决】on（步级条件边）声明面已下线` → `⑧ on（步级条件边）声明面已下线` |
| 9 | chain.js:602 | **整行删除**（`（chain.join.anyFailure / chain.onFail，M4 迁 rework）；skipped 分支 → deps + Leader 裁决。`；逐字同义句在 #3 保留行在位） |
| 10 | chain.js:643 | `规则（Leader 裁决 ④，2026-09-16）：` → `规则：` |
| 13 | chain.js:767 | `（**不静默推进**，见头注释 M1 段）。` → `（**不静默推进**）。` |
| 14 | chain.js:904 | `【与 validateChain/chainProblemsOf 同口径（R2-3 裁决 B，2026-09-17）】` → `【与 validateChain/chainProblemsOf 同口径】` |

### 1.2 `lib/assembly/flows.js`（2）

| # | 位置 | 旧 → 新 |
|---|---|---|
| 15 | flows.js:26 | **整行删除**（`⚠ r1 的「缺声明逐字回落现状」措辞在 r2 已被 ① 取代（用户裁决 Q-r2②／原则①）；`，纯措辞演进史） |
| 16 | flows.js:141 | `【gate-lite 第二批 · 放行 4（2026-09-17 用户裁决）】**原「团队资产缺失」码已删**` → `**原「团队资产缺失」码已删**（勿回加）` |

### 1.3 `lib/assembly/team-asset.js`（14）

| # | 位置 | 旧 → 新 |
|---|---|---|
| 17 | team-asset.js:48 | `↑ F-4（2026-09-15 用户裁决 Q-D=A，严控勿松）落点：` → `↑ 严控勿松落点：` |
| 18 | team-asset.js:56 | `【2026-09-18 清债】原 ESCALATIONS…已删除：` → `原 ESCALATIONS…已删除：` |
| 19 | team-asset.js:58 | `退役声明键（2026-09-18 清债，用户裁决「保留核心、清冗余」）：` → `退役声明键：` |
| 20 | team-asset.js:81 | `【2026-09-18 清债】三个 STATE_* 码已删除（` → `三个 STATE_* 码已删除（` |
| 21 | team-asset.js:103 | `【Q1 回退（2026-09-17 用户裁决 Q1：「都不降（回到严格）」）】**撤回 gate-lite 第二批 · D 的降档**——` → `【现行 = 严格档「都不降」】**已撤回此前的降档**——` |
| 22 | team-asset.js:105 | `Agent-team 交接任务」）；Q1 裁决回到严格：` → `Agent-team 交接任务」）⇒ 现行口径回到严格：` |
| 23 | team-asset.js:116 | `**末条 = 2026-09-18 用户裁决（原 K-2）**：` → `**末条（现行）**：` |
| 24 | team-asset.js:153 | **整行删除**（`**2026-09-18 清债（用户裁决：保留引擎运行核心、清理冗余设计与技术债）**：三条历史条目全部移除 ——`，纯清债过程叙述） |
| 25 | team-asset.js:171 | `2026-09-18 清债后**台账为空** ⇒` → `**台账为空** ⇒` |
| 26 | team-asset.js:292 | `complete 段（**F-4 已清退**，2026-09-15 用户裁决 Q-D=A）：` → `complete 段（**已清退**）：` |
| 27 | team-asset.js:296 | `（**2026-09-18 K-2 裁决后为 warning 级** ⇒ **不拒载**` → `（**现行 = warning 级** ⇒ **不拒载**` |
| 28 | team-asset.js:317 | `exec 消费门两键（2026-09-18 用户裁决 E-A/E-B）——` → `exec 消费门两键（E-A / E-B）——` |
| 29 | team-asset.js:367 | `audit_contract（P2，2026-09-14 用户裁决 B）：` → `audit_contract：` |
| 31 | team-asset.js:398 | `④⑤ 退役键守门（2026-09-18 清债）：` → `④⑤ 退役键守门：` |

### 1.4 `lib/bridge/dispatch-register.js`（1）

| # | 位置 | 旧 → 新 |
|---|---|---|
| 32 | dispatch-register.js:135 | `（2026-09-15 用户裁决「不写 token 即禁止派发」）：` → `（「不写 token 即禁止派发」）：` |

### 1.5 `lib/engine/**`（8）

| # | 位置 | 旧 → 新 |
|---|---|---|
| 39 | engine/dispatch.js:19 | `// 定位（2026-09-16 用户裁决 + 调研批结论）：` → `// 定位：` |
| 40 | engine/dispatch.js:148 | `worker 会话 id（D-2 清债，2026-09-16；one-shot 化语义更新 2026-09-22）。` → `worker 会话 id（one-shot 化语义）。` |
| 43 | engine/dispatch.js:306 | `N2 清债（2026-09-16 评审）：denyTools/persona…` → `denyTools/persona…` |
| 46 | engine/dispatch.js:343 | `D-2（2026-09-16 清债）：worker 会话 id 定点取值` → `worker 会话 id 定点取值` |
| 47 | engine/dispatch.js:363 | `语义（2026-09-16 用户裁决「不写 token 即禁止派发」）：` → `语义（「不写 token 即禁止派发」）：` |
| 48 | engine/dispatch.js:368 | `【gate-lite 第二批 · B（2026-09-17 用户裁决）】**'enforce' 拒态已删**` → `**'enforce' 拒态已删**（勿回加）` |
| 49 | engine/dispatch.js:412 | `【gate-lite 第二批 · B（2026-09-17 用户裁决）】**恒 ok:true（不再拒）**` → `**恒 ok:true（不再拒）**` |
| E-01 | engine/suite.js:26-27 | **事实修正**：`SUITE_DENY_TOOLS（14 项）` / `MODE_GATED_TOOLS（10 项）` → `（20 项 = 冻结的 14 条 + 图变更写入口 2 件 + S2 连续控制族 4 件）` / `（12 项…）`（实测 `import('./lib/engine/suite.js')`：36 / 20 / 12；判据源 `plan/baseline-diff.md` E-01） |

### 1.6 `lib/governance/**`、`lib/hot/**`（8）

| # | 位置 | 旧 → 新 |
|---|---|---|
| 54 | governance/config.ts:294 | `2026-09-14 用户裁决：preset 的**单值字符串形态（单选遗产）已废除**` → `preset 的**单值字符串形态（单选遗产）已废除**` |
| 56 | governance/kernel.ts:20 | `第三类判定面（工具黑名单，用户裁决 2026-09-14）：` → `第三类判定面（工具黑名单）：` |
| 63 | governance/tool-ban.ts:20 | `目的（2026-09-14 用户裁决）：` → `目的：` |
| 64 | governance/tool-ban.ts:24 | `拦截面（用户裁决 Q3「仅护栏禁止修改或写文件」）：` → `拦截面（「仅护栏禁止修改或写文件」）：` |
| 67 | governance/tool-ban.ts:95 | `纠正文本（用户裁决 Q4：拒绝后回复原因…）` → `纠正文本（拒绝后回复原因…）` |
| 68 | governance/types.ts:106 | `（用户裁决 2026-09-14 Q1：新维度…）` → `（新维度…）` |
| 76 | hot/config-watch.js:76 | `modes（E 阶段模式跟随，2026-09-16 用户裁决）：` → `modes（模式跟随）：` |
| 77 | hot/config-watch.js:81 | `gates（P1/P2 交接门开关；task-27 2026-09-17 用户裁决）：` → `gates（P1/P2 交接门开关）：` |

### 1.7 `lib/index.js`（2 + C-3 标注）

| # | 位置 | 旧 → 新 |
|---|---|---|
| 82 | index.js:581 | `真派仍由 Leader/Manager 在工具面执行（与 S12 裁决一致）；` → `真派仍由 Leader/Manager 在工具面执行；` |
| 84 | index.js:723 | `**重启生效面**（G-3 收口，2026-09-15 用户裁决 Q-9=A）——` → `**重启生效面**——` |
| C-3 | index.js:93 后 | **新增标注行**：`// ↑ 引擎状态根：**声明在 :92、消费在 :93（homedir() 派生真值）**——引用本处请写 lib/index.js:92-93，勿只引 :92 当调用点。` |

### 1.8 `lib/state/**`（26）

| # | 位置 | 旧 → 新 |
|---|---|---|
| 91 | state/event-types.js:40 | `（GAP-S3b，2026-09-16 用户裁决 = **折中方案**）：` → `（**aborted 收口时留痕**）：` |
| 92 | state/event-types.js:61 | `gate-lite Q-G1（2026-09-17 用户裁决「开显式豁免键」）：` → `（显式豁免键 smoke: true）。` |
| 95 | state/event-types.js:102 | `gate-lite 第二批 · A2（2026-09-17 用户裁决「全删 + 改造为官方 roster 承抽」）：` → `（该判定改由官方 roster 承抽）。` |
| 96 | state/event-types.js:183 | `（legacy:true，裁决 ①=B：不静默、不砸存量）` → `（legacy:true：不静默、不砸存量）` |
| 97 | state/event-types.js:188 | `（2026-09-15 用户裁决：集群内部同步事件走套件工具…）` → `（集群内部同步事件一律走套件工具…）` |
| 130 | state/gates.ts:65 | `gate-lite Q-G1（2026-09-17 用户裁决「开显式豁免键」）：冒烟/探针批判定**单点**` → `冒烟/探针批判定**单点**（显式豁免键）` |
| 130 | state/gates.ts:352 | `口径（用户裁决 Q-r2② + O-4）：` → `口径：` |
| 131 | state/gates.ts:567 | **整行删除**（`被误判未变更。修复：批次 gate-targets-baseline-fix / lane e1-fix-baseline，用户裁决 C）；`，纯修复史） |
| 132 | state/gates.ts:632 | `Q-7（用户裁决）：complete = …` → `complete = …` |
| 133 | state/gates.ts:682 | `（batch.handoffs === undefined，裁决 ①=B）⇒ 整门放行` → `（batch.handoffs === undefined）⇒ 整门放行` |
| 135 | state/gates.ts:691 | `交接判据的**单点实现**（P2-A 裁决 ②，2026-09-17）` → `交接判据的**单点实现**` |
| 137 | state/gates.ts:745 | `不受新门约束（裁决 ①=B）：放行 + 留痕` → `不受新门约束：放行 + 留痕` |
| 139 | state/gates.ts:832 | `G2（2026-09-14 用户裁决 A）：**建批即拉起**` → `G2：**建批即拉起**` |
| 140 | state/gates.ts:838 | `【gate-lite 第二批 · A（2026-09-17 用户裁决「全删 + 改造为官方 roster 承抽」）】` → `【改造为官方 roster 承抽】` |
| 141 | state/gates.ts:877 | `P1 内容面（2026-09-14 用户裁决 Q3=B，**全局生效**）：` → `P1 内容面（**全局生效**）：` |
| 142 | state/gates.ts:917 | `handoffLegacy = 存量批标记（裁决 ①=B）——写端` → `handoffLegacy = 存量批标记——写端` |
| 148 | state/gates.ts:1668 | `P2-A（裁决 D3，2026-09-17）：出口侧` → `P2-A：出口侧` |
| 149 | state/gates.ts:1678 | `（裁决 ①=B 在出口侧的同一口径：不静默、不砸存量）` → `（出口侧同一口径：不静默、不砸存量）` |
| 157 | state/store.js:358 | `（建批期意图声明 = 裁决 ②=A 的判据来源）` → `（建批期意图声明 = 本门判据来源）` |
| 160 | state/store.js:878 | `P1 交接门拒态（2026-09-17）：码 = GATE_HANDOFF_MISSING（裁决 ④=A 新造独立码）` → `P1 交接门拒态：码 = GATE_HANDOFF_MISSING（独立码）` |
| 161 | state/store.js:891 | `P1 存量批放行留痕（裁决 ①=B：**不静默、不砸存量**）` → `P1 存量批放行留痕（**不静默、不砸存量**）` |
| 162 | state/store.js:910 | `audit lane 产物含 needHuman 声明 → 事件 lane.needhuman 留痕（Manager 转达人工裁决）` → `audit 产物含 needHuman 声明 → 落 lane.needhuman 事件（人工裁决转达）` |
| 164 | state/store.js:981 | `P2-A（裁决 D3，2026-09-17）：出口侧收紧` → `P2-A：出口侧收紧` |
| 166 | state/store.js:1148 | `M0′-②（2026-09-17 裁决）：相位迁移**事由**` → `相位迁移**事由**` |
| 167 | state/store.js:1197 | `【gate-lite 第二批 · A（2026-09-17 用户裁决「全删 + 改造为官方 roster 承抽」）】` → `【改造为官方 roster 承抽】` |
| 171 | state/store.js:1487 | `【2026-09-16 用户裁决】原 execCallsSince ≥ maxCalls(20) 判据**已移除**` → `原 execCallsSince ≥ maxCalls(20) 判据**已移除**` |

### 1.9 `lib/tools/core.js`（14）

| # | 位置 | 旧 → 新 |
|---|---|---|
| 173 | tools/core.js:94 | `G1（2026-09-14 用户裁决 B，**严格档**；2026-09-15 用户裁决 **Q2=B 收窄**）：` → `G1（**严格档**，后经 Q2=B 收窄）：` |
| 176 | tools/core.js:179 | `N8 清债（2026-09-16 评审）：原此处绑定` → `原此处绑定` |
| 177 | tools/core.js:197 | `⓪′ 模式跟随（E 阶段，2026-09-16 用户裁决「全局装载、不全局生效」）：` → `⓪′ 模式跟随（「全局装载、不全局生效」）：` |
| 178 | tools/core.js:251 | `【gate-lite 第二批 · B（2026-09-17 用户裁决）】**已改为只留痕不拦**` → `**已改为只留痕不拦**` |
| 179 | tools/core.js:508 | `gate-lite Q-G2（2026-09-17 用户裁决：「**删除这一项**」）：成员回报**目标解析**（身份门已删）` → `成员回报**目标解析**（身份门已删）` |
| 183 | tools/core.js:667 | `P2（2026-09-14 用户裁决 B）：**audit 职责声明化**` → `P2：**audit 职责声明化**` |
| 184 | tools/core.js:725 | `exec 消费门（2026-09-18 用户裁决：E-A/E-B 一并加）——` → `exec 消费门（E-A / E-B）——` |
| 185 | tools/core.js:785 | `gate-lite Q-G1（2026-09-17 用户裁决「开显式豁免键」）：**冒烟/探针批**留痕` → `**冒烟/探针批**留痕（显式豁免键）` |
| 187 | tools/core.js:831 | `【gate-lite 第二批 · A（2026-09-17 用户裁决「全删」）】原「准入 = …」` → `原「准入 = …」` |
| 188 | tools/core.js:848 | `GAP-S3b（2026-09-16 用户裁决 = 折中方案）：aborted 收口时若…存在**非终态成员**，` → `aborted 收口时若…存在**非终态成员**（折中方案）：` |
| 189 | tools/core.js:958 | `不再「写了不生效」（task-27 增量裁决）。` → `不再「写了不生效」。` |
| 190 | tools/core.js:1039 | `③ 交叉校验（2026-09-14 用户裁决 B「有解释的偏离」）：` → `③ 交叉校验（「有解释的偏离」）：` |
| 193 | tools/core.js:1350 | `门整体放行（裁决 ①=B）⇒ ready:true` → `门整体放行 ⇒ ready:true` |
| 194 | tools/core.js:1465 | `**Q-B 取消并发闸**（2026-09-18 用户裁决）整体删除：` → `并发闸已取消：` |

### 1.10 `lib/types/**`、`lib/wave-plan.ts`（7）

| # | 位置 | 旧 → 新 |
|---|---|---|
| 198 | types/contracts.ts:147 | `建批期意图声明（裁决 ②=A 的判据来源）：` → `建批期意图声明（本门判据来源）：` |
| 199 | types/contracts.ts:149 | `缺省口径（裁决 ①=B）：存量批无` → `缺省口径：存量批无` |
| 225 | wave-plan.ts:187 | `装配声明必备判定（2026-09-14 用户裁决：Manager 见批即默认 raise…）` → `装配声明必备判定（Manager 见批即默认 raise…）` |
| 226 | wave-plan.ts:259 | `C+ 装配门禁裁决（纯函数…）` → `装配门禁裁决（纯函数…）`（C+ 档已撤销） |
| 227 | wave-plan.ts:550 | `P1（2026-09-14 用户裁决，**全局严格**）：` → `P1（**全局严格**）：` |
| 228 | wave-plan.ts:615 | `gate-lite Q-G1（2026-09-17 用户裁决「开显式豁免键」）——**冒烟/探针批**（smoke: true）跳过本段：` → `**冒烟/探针批**（smoke: true，显式豁免键）跳过本段：` |
| 230 | wave-plan.ts:725 | `P1 交接门：建批期校验（裁决 ②=A，2026-09-17）` → `P1 交接门：建批期校验` |

## 2 (b) 冗余文件面

本 lane 对 §3 清单的处置见 `exec/cleanup.md` §4：**全部为「留」（0 动作）或「越写域 / 需 Leader 裁认」（0 执行）**——`docs/**` 面 1 的 44 件「移」需归档根与引用点同步（清单 §3.2 约束要求 Leader 裁认）、`scripts/audit/out/**` 的 15 件「删」在 `scripts/**`（本 lane 禁碰）、`docs/gap-list-2026-09-22.md` 的「纳入版本控制」需 git 写（本 lane 禁 git 写）。**逐条登记，不静默降级**。

## 3 (c) 幻觉产物「不实」项修正（改错 / 改标注）

| 候选 | 三态 | 本 lane 落地动作 |
|---|---|---|
| **C-1** 官方任务板双写（M-6） | 实证（引擎已如实降级） | **无仓内改动**（`lib/tools/core.js:1215` 已逐字写明「未启用…不写、不校验、不据以判定」）；改法 B（补发布面文档一行）涉及 `pkg-hashes.txt` 账目面 ⇒ 登记待 Leader 裁认 |
| **C-2** `wait_agent` 已从内核移除 | 实证为「历史失真、现已修订」 | 无需再修（`lib/engine/suite.js` 现文面已写明「保留 + 由 agent-team 层注册」） |
| **C-3** `lib/index.js:92` 引为调用点 | 实证（偏差 1 行：声明 ≠ 消费） | **已改标注**：`lib/index.js:93` 后新增引用纪律行（引用请写 `:92-93`）；仓内既有 `docs/engine-load-smoke-recipe.md:12` 表述已正确；`docs/decisions/watch-default-open-ruling-2026-09-05.md:75` 另引 `:92/:298`（本地裁决记录，行号已随代码演进失锚）⇒ 登记 followup |
| **C-4** 7 份仓内文档失件（12 处引用） | 实证（basename 全仓零在场） | **已改标注 10 行**（见下） |
| **C-5** 在场文档/锚点引用 | 不实（非幻觉，已验证面） | 不动（登记为已验证面，防 audit 误判整类失效） |
| **C-6** reachability-audit §5「首轮实测」表 | **本 lane 复现为实证**（表内「实测值/判读」两列自始为空） | **已改标注**：`docs/reachability-audit-2026-09-21.md` 表后追加「回填状态标注」块 |
| **C-7** implemented-inventory 台账滞后 | **本 lane 复现为实证**（`git rev-list --count 9d91047..HEAD` = **24**） | **已改标注**：`docs/implemented-inventory-2026-09-21.md` 头部追加「时效标注」行；「§0 与 §1 口径相反」未复现 ⇒ 不主张 |
| **C-8** aggressive-prune-plan 批 2–5 标题「待确认」 | **本 lane 复现为实证**（标题 4 处仍作「（待确认）」） | **已改标注**：`docs/aggressive-prune-plan-2026-09-22.md` 头部追加「状态标注」块（断言实际处置状态未复核，不作主张） |
| **C-9** `gen-register.mjs --check`「只读校验」 | **本 lane 复现为实证**（脚本内**零 `process.argv` / `--check` 分支**；`OUT_MD` 缺省 = `docs/frozen-register-2026-09-21.md`） | **仓内无改动**（修复点在 `scripts/**`，本 lane 禁碰；且不应执行该脚本）⇒ 登记 followup |

### 3.1 C-4 落地明细（10 行改标注）

统一改法：路径 token 由 `` `docs/<name>.md` `` 改为 `` `<name>`（原文档未随仓分发） ``——**保留可追溯的文档名与 § 锚**，同时**明示读端不可达**（不静默删路径）。

| 位置 | 文档名 |
|---|---|
| `lib/assembly/chain.js:92` / `:93` / `:94` | `w2-assembly-spec-20260916` / `chain-model-upgrade-spec-20260916` / `handoff-semantics-consolidation-20260917` |
| `lib/state/event-types.js:176`、`lib/types/contracts.ts:143`、`lib/state/gates.ts:678`、`lib/state/store.js:1233` | `p1-handoff-gate-changeplan-20260917`（四处同一失件） |
| `lib/state/gates.ts:1669` | `p2-settle-narrowing-changeplan-20260917` |
| `lib/tools/core.js:509` / `:601` | `gate-census-20260917` / `member-governance-redesign-20260917` |

**未覆盖面（越写域，登记）**：`test/**` 内另有 **5 处**引用同名失件（`chain-v2-declaration.test.js:30`、`chain-v2-pairing.test.js:20`、`chain-v3-assembly.test.js:24`、`handoff-gate.test.js:20`、`p2-settle-handoff.test.js:20`）——本 lane 禁碰 `test/**`。`lib/state/gates.js:686` / `:1788` 为同名 `.ts` 的构建产物 ⇒ 待 `npm run build` 重生成，本 lane **不手工双改**。

## 4 未落地面（清单明确要求但越本 lane 写域 / 需裁决）

| 项 | 清单要求 | 未落地原因 | 归属 |
|---|---|---|---|
| §3.2 面 1：仓根 `docs/**` 44 件「移」入归档根 | 移 | 需归档根落点 + 引用点同步 = 清单 §3.2 约束 2 明示「移动须 Leader 裁认」 | Leader 裁认 |
| §3.2 面 2：`docs/gap-list-2026-09-22.md` 纳入版本控制 | 移（git add） | 本 lane 禁 git 写 | Leader |
| §3.2 面 3：`scripts/audit/out/**` 15 件「删」 | 删 | 在 `scripts/**`（本 lane 禁碰）；且清单要求与任何 `audit/*.mjs` 执行分批 | 另批 |
| 清单 §1.2 口径裁认（205 vs 232） | — | 本 lane 按清单 §1.2 默认口径 **A（232）** 执行，未缩表 | 已成事实，audit 可核 |
| C-1 改法 B（发布面补一行） | — | 触 `pkg-hashes.txt` 账目面（单写者 = Leader） | Leader 裁认 |

---

*本件由 lane `exec-cleanup` 生成，随批产物 `exec/cleanup.md` 一并交付；只改注释与标注，未改任何运行时行为。*
