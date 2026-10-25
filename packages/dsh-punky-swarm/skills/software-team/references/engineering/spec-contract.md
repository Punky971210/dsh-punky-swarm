# 规格契约细则（蟛蜞适配层 · SpecLang）

> **原文来源**：SpecLang **已全文 vendor** 至 `references/vendor/speclang/`（版本钉 `b3ee6ee`，**不锚 `HEAD`**；逐件 sha256 与「未改动，逐字复制」声明见同级 `NOTICE.md`）⇒ **原件为准**，本文件是**蟛蜞适配层**：只写「蟛蜞怎么用」，不设第二套口径。
> **许可与署面**：原件 `LICENSE` 署 **The Cangjie Project**，许可为 `Apache-2.0`（附运行时库例外条款）；**权利人待确认**（不得改写成已确认）。许可原件与变更清单见同目录 `LICENSE` / `NOTICE.md`；vendor 的四条替代约束（原件 / `NOTICE.md` / 署面 / 待确认）**缺任一即红线违反**。
> **不进引擎功能面**（红线）：本文件属**能力层工程细则**，引擎不解析、不据此判定。批次规格的真源仍是批次黑板（`wavePlan.tasks[]` + `handoffs`）；规格只是一份**产物**，由既有 plan 契约门校裸标题 `## 验收标准` 在场 ⇒ **不得成为第二本账**。
> **适用角色**：以 `SKILL.md` §三之二「角色 → 必读 → 落点」表为**真源**；本文件是投影面之一，改挂载**先改表**。
> **只写蟛蜞适配**：规则原文在 vendor 原件；本节只给**映射 / 落地 / 缺口**，与蟛蜞既有机制重复的面一律走指针（附 A），不复述。

---

## S-6 六态证据语法

> **规则真源**：`references/vendor/speclang/speclang-hoare-check/assets/hoare-reasoning-report-template.md`（六态表 ＋ 链兼容标记）与同目录 `SKILL.md`（映射阻断与计分口径）。本节只写**蟛蜞怎么读这六态**。

四档强度 ＋ 两个旁路态。**六态是结论词汇表，不是形容词** —— 每条结论必须落到一个态上。

> **本表是映射摘要，不是第二处定义**：下表六态（四档强度 ＋ 两个旁路态）的**定义以 `references/vendor/speclang/speclang-hoare-check/` 原件为准**（`assets/hoare-reasoning-report-template.md`、同目录 `SKILL.md`）；本表只做「蟛蜞怎么读这六态」的映射摘要。**两者不一致时一律以原件为准**；本表不构成第二套口径，也**无机检保证与原件同步** ⇒ 读到疑似冲突先回原件核对。

> **本表列为原件节选摘要**：下表四列皆为 `references/vendor/speclang/speclang-hoare-check/` 原件的**节选摘要**，仅作速查；**完整判据与边界以原件为准**（本条与上条声明同向，不是第二处口径）。

| 态 | 类别 | 计入通过 | 触发条件 |
|---|---|---|---|
| `PROVED` | 强度档 | 是 | 未发现反例，且证据链**闭合**（每步有行号与规则支撑，收束成立） |
| `SEMI_PROVED` | 强度档 | 是（附条件，见 S-7） | 未发现反例、主体成立，但仍依赖未闭合假设 / 外部语义前提 / 待补证环节 |
| `VIOLATED` | 强度档 | 否（且必入修复清单） | 找到最小反例路径并能回指证据 |
| `UNKNOWN` | 强度档 | **否** | 未找到反例，但证据链**不闭合** |
| `CHAIN_BREAK` | 旁路（链级） | 否（且必入修复清单） | 链上相邻两步断言不蕴含：上游给出的不满足下游需要的 |
| `MAPPING_BLOCKED` | 旁路（映射级） | 否（且必入修复清单） | 无法用证据建立入口 / 调用链 / 状态映射 ⇒ 该对象**全部义务统一判 `UNKNOWN`** |

- **`CHAIN_BREAK` 必带四件**：断裂点（哪两步之间）、上游给定、下游需要、不蕴含原因（一行 ＋ 行号）。缺任一 ⇒ 该结论不成立。
- **`MAPPING_BLOCKED` 的连带规则**最容易误用：它不是「这条先跳过」，而是**整族义务降为 `UNKNOWN`** —— 不得对其中几条另给 `PROVED`。
- 锚点：`speclang-hoare-check/assets/hoare-reasoning-report-template.md:4,45,83,92`；`speclang-hoare-check/SKILL.md:49`

**六态 → 引擎面映射**（适配层新增；目的只有一个 —— 防把证据强度写进结论值）

| 六态 | 蟛蜞读数面怎么用 | 进 `verdict`？ |
|---|---|---|
| `PROVED` | 证据链闭合 ⇒ 该条可计入通过 | **不进** |
| `SEMI_PROVED` | 可计入通过，但风险说明须见补证计划（S-7） | **不进** |
| `VIOLATED` | 不计通过；必入修复清单 | **不进** |
| `UNKNOWN` | 不计通过（与「没做」等价）；必入修复清单 | **不进** |
| `CHAIN_BREAK` | 不计通过；断裂四件缺一则该结论不成立 | **不进** |
| `MAPPING_BLOCKED` | 该对象整族义务降 `UNKNOWN`；必入修复清单 | **不进** |

- **强度 ≠ `verdict`**：强度档是**读数**（`gate_status` 面），`verdict` 是**结论值**；`complete` 门白名单仍只收 `{pass, skip}` ⇒ 把 `PROVED` 一类写进 `verdict` = 越界。

## S-7 记分口径与修复清单位置

> **规则真源**：`references/vendor/speclang/speclang-hoare-check/SKILL.md`（计分与修复指导段）。本节只留蟛蜞侧的**加严口径**与落点。

- **`UNKNOWN` 不计通过**：计数里不进分子。理由：证据链不闭合的结论与「没做」等价。
- **`SEMI_PROVED` 可计通过，但必须补证**：风险说明须给三件 —— **原因**、**风险范围**、**补证计划**。三件齐备才计入通过；缺项时**本团队口径**按 `UNKNOWN` 计。
  - **口径来源须标注**：源侧只要求「解释原因、范围与补证计划」，**未规定**缺项后果 —— 缺项降级是本团队加严，不得写成源侧规定。
- **必入修复清单四态**：`UNKNOWN`、`VIOLATED`、`MAPPING_BLOCKED`、`CHAIN_BREAK` —— 四者**任一**不出现在修复清单 = 报告不完整。
- **概要行分族计数**：按「API 类 / 用例类」两族**分别**给六态计数，不合并成一个总数（合并会掩盖「一类全证、另一类全挂」）。
- **本团队落点**：`tester` / `reviewer` / `supervisor` 的产物给该计数；`supervisor` 的验收结论**不得**把 `UNKNOWN` 计入通过项。

## S-8 报告机读行与退出码

> **规则真源**：`references/vendor/speclang/speclang-waterfall/assets/reporting_requirements.md`（五字段块 ＋ 机读行）；校验器实发口径见同目录的 `references/vendor/speclang/speclang-waterfall/assets/validate_speclang_mechanical.rb`。本节只写**蟛蜞落地方式**。

- **逐条块形态**（五字段，固定顺序；字段名是**协议词**，不得改写）：

| 字段 | 取值 | 要求 |
|---|---|---|
| `CHECK` | `[<规则族>-<n>]: <检查名>` | 一条检查一行 |
| `STATUS` | `PASS` / `FAIL` / `WARN` | 三值互斥 |
| `FINDING` | 具体发现 | 不写「有问题」类空话 |
| `LOCATION` | `<段.字段>` 或 `<文件:行>` | 精确到可定位 |
| `ACTION REQUIRED` | 交付前须修什么 | 可执行，不写「建议优化」 |

- **汇总行**：**独立一行**，以 `SUMMARY:` 起，两个计数（失败数、警告数）＋ 方括号内**单一**门控词 —— 失败数 > 0 用 `BLOCK`，否则用 `PROCEED`；**二者互斥，不得并列**。
- **排序纪律**：先列全部失败，再列警告；同族按规则 id 分组。
- **退出码口径**：失败数 > 0 ⇒ `1`；失败数 = 0 ⇒ `0`。**警告多少不影响退出码**（警告是记账，不是阻断）。
- **硬失败边界**：机械或合规类失败属**交付前硬失败**，在解决前不得进入语义评审、不得交下游交接。
- **本团队落点**：`tester` 的测试报告与 `reviewer` 的审查报告尾部给该行；该行可直接作任务包 `gate: <命令>` 的阻断判据（与 `verification.md` V-2「失败是否真的阻断」联动）。
- 锚点：`speclang-waterfall/assets/reporting_requirements.md:6-10,16,19`；`speclang-waterfall/assets/validate_speclang_mechanical.rb:1086,1090`

**`SUMMARY:` 行落地**（适配层新增）

- 该行可直接作产物 `gate: <命令>` 的阻断判据 —— 引擎按退出码判，不解析文案。
- 退出码三档，与 `scripts/speclang-validate.mjs` 薄壳**同构**：失败数 > 0 ⇒ `1`；失败数 = 0 ⇒ `0`；**无法判定 ⇒ `2`**，且文案必须标 `UNKNOWN`（不许用 `0` / `1` 冒充「没判」）。

**薄壳用法与 ruby 定位**（适配层新增）

- 首选 `node scripts/speclang-validate.mjs <spec>`；ruby 不在**当前进程** PATH 时显式给绝对路径：
  `node scripts/speclang-validate.mjs --ruby="D:/Program Files/Ruby40-x64/bin/ruby.exe" <spec>`。
- 找 ruby：Windows `where ruby`；bash / macOS / Linux `command -v ruby`。**禁靠猜路径** —— 实测本机「机器 PATH 有 ruby、
  进程 PATH 无」，直接调只会得到 `exit 2 UNKNOWN`，被误当成"校验器坏了"。
- 四态：① ruby 可用 ⇒ 原样透传 rb 的退出码与输出；② ruby 不可用 ⇒ `exit 2` ＋ stderr 标 `UNKNOWN`；
  ③ rb 原件缺失 ⇒ `exit 2` ＋ 给缺失绝对路径；④ `-h` / `--help` ⇒ `0`。**②③ 都是 UNKNOWN，不计通过。**
- 骨架与负控模板：`references/engineering/spec-templates/`（`speclang.yaml.tpl` 规格骨架、
  `mc-negative-controls.tpl.mjs` 负控跑法）。**绿行不是充分证据**，依赖哪条规则就给哪条构造变异体。

## S-10 plan 派下的规格类检查：已有机械门（`check-spec-accounting`）

> **规则真源**：`references/vendor/speclang/speclang-waterfall/assets/MECHANICAL_RULES.md`（记账规则的**范围边界**）
> ＋ `reporting_requirements.md`（覆盖清单属**工作流输出**，非校验器）。本节写蟛蜞侧的**落地门**。

**两类缺口，分开说**：

1. **需求点 → 契约** 这一跳，源侧放在人工/AI 判断的工作流输出里，**仍不属机械面**。眼下由 `reviewer` 人工核对，
   结论标 `SEMI_PROVED` 并写明「人工核，非机器已证」。要机器化，最小可行判据 =「spec 内需求编号集 ⊆ 验收段覆盖集」，
   且**先给可达负例**（构造一条漏接需求应判红）——改前就已绿的判据即假绿，不得采用。
2. **plan 派下的 `CC-*` / `hoare-check` 有没有被交代** —— 这一跳**已装牙**（见下），因为它可机械判。

### 已装牙：`scripts/check-spec-accounting.mjs`

**事故驱动**（可核）：批次 `edu-backend-m0-r6` 的 `plan/r6-scope.md` 把 `CC-*` 与 `hoare-check` 派给 `r6-audit`，
并写明「若不可用须显式记未执行 + 原因」；而 `audit/r6-acceptance.md` 与 `audit/r6-gap-list.json` 对二者的命中**均为 0**，
批次照样 `complete`。⇒ 计划里的要求可以静默蒸发。本门就是堵这个。

```sh
node scripts/check-spec-accounting.mjs --plan <plan.md> --acceptance <audit.md>
```

- **要求集**：plan 内 `spec-accounting:` 声明块（`- <id>` 逐条）；无块时退化为「plan 正文提及的 `CC-*` / `hoare-check`」——
  因为上述事故正是「只在正文提过、没进块」这一形态。族形态 `CC-*` 按前缀匹配（验收给任意 `CC-xxx` 读数即算交代）。
- **交代两种合法形态**：① 读数（该行含 id 且有 `读数/PASS/FAIL/exit/SUMMARY:` 或数字）；
  ② **显式未执行 + 原因**（含 `未执行` 且同行给原因 ≥8 字符）。**只写"未执行"不给原因判红**（否则它就是万能豁免）。
- **退出码**：`0` 全部有交代 / `1` 有要求未交代（逐条点名）/ `2` 用法或文件错误（fail-closed）。
- **机读行**：`SUMMARY: spec-accounting <declared> declared, <covered> covered, <missing> missing. [PROCEED|BLOCK]`
- **不判**：读数真假属评审面，本门只判「有没有交代」——别把它当成"读数正确性校验"。

用法建议：写进审计产物的 `gate:` 行，引擎在 merged 前真跑，按退出码判定。

- 锚点：`speclang-waterfall/assets/MECHANICAL_RULES.md:85`；`speclang-waterfall/assets/reporting_requirements.md:23-29`

---

## 附 A 不复述清单：与蟛蜞既有机制的对应

原 10 节里以下各面**蟛蜞已有实现且更强**，故本文件不再复述，只给真源指针（要改请改那边）：

| 原提炼面 | 蟛蜞既有真源 | 处置 |
|---|---|---|
| 机械规则清单（`MC-1` / `MC-2` / `MC-3` / `MC-4` / `MC-5` / `MC-6` / `MC-7` / `MC-8`） | `scripts/check-guidance-sync.mjs`（段落/编号/引用）、`scripts/arch-check.mjs`（分层与依赖方向）、`scripts/evidence-guard.mjs`（防假绿）、`lib/state/gates/*`（14 个门模块） | 不复述；按需读判据实现（规则原文另见 vendor 的 `speclang-waterfall/` 资产） |
| 结构失败先于语义评审 | 引擎门序本身即结构门先于语义核对（`entry` / `exit` / `plan-contract` 先于 audit 逐条核） | 不复述 |
| 编号唯一与引用可解析 | `check-guidance-sync.mjs` 判据②/②b/③、`scripts/id-anchor-count.mjs`、`test/retired-codes-lock.test.js` | 不复述 |
| 追溯记账与依赖 DAG | 真源 = `wavePlan.tasks[]` + `lanes[].deps` + `handoffs` + `consume/produce/outputs` | 不复述（引擎即真源） |
| UI 树结构有效性 | 蟛蜞无 UI 面（交互面由 `frontend.md` F-1..F-7 承载） | 不适用；**UI 组件目录原件已 vendor**（`references/vendor/speclang/ui-component-registry/`），不适用即不加载 |
| 需求编号族（`REQ-` / `SCN-` / `RULE-` / `IDX-` / `AC-`） | `presets/punky-preset/references/discipline.md` §0s（跨批短码）+ 本仓 `AC-xx` / `AG-xx` 惯例 | 不复述；仅保留一条：**跨族不得互相顶替**（`AC-` 不当需求编号用，`REQ-` 不当验收 id 用） |

---

## 附 B 已知缺口（不阻塞）

> 本批（`speclang-followup-20261025`）按「**登记、不回改原文**」处置三项已知缺口；均为**判据源/单据面**问题，不影响任何在册判据的执行口径。

| id | 缺口 | 现状与依据 | 处置 |
|---|---|---|---|
| `GAP-A1-03` | 判据源滞留 | `plan/p1-wiring-spec.md` 的 AC-11③ 文案仍写「含 vendor 指针的 role 须 ≥5」，**已被 R-23 覆盖为「恰 6 个」**（现役实现见 `AC-pack3-15`） | 按 **R-16 型**记「**执行按裁决、plan 原文滞留**」；**不回改** p1 原文 |
| `GAP-A1-04` | 陈述有误（非缺陷） | R-22 引用的「53 窗」是 `e2` **v1 草稿态**读数；**现态与改前态散文面均为 0**（`AC-pack3-6` 现 pass） | 记录「**偏离成立、陈述有误**」；后续引用该读数须注明「v1 草稿态」 |
| `GAP-A1-08` | 单据滞留 | `exec/e2-adapter-check.md` 的基线三值（**18／57／499**；全角分隔是刻意的 —— 该串的**半角形态**在现行判据里要求零命中，见下）为 **R-23 前旧读数** | **历史值**：`18/59/522` @ 提交 `533e330`（该时点曾为现行，**现已过期**）。**现行冻结值一律只读 `baselines/test-baseline.json`**——本文件**不抄**任何「现行」数字（抄了必随重冻滞后，`-06` 落地后已发生过一次）；e2 报告**不回改**，按「已结算产物不回改」登记 |
