---
name: software-team
description: |
  软件工程团队模版（引擎的**下游指引**，不作为引擎组件使用）：三层 7 角色
  （plan coordinator·designer / exec coder·tester·reviewer / audit supervisor·docManager[可选]）
  的职责边界、产物契约、任务包规格（按 spec-writing）、回报与交接通道，
  以及 team 成员的管理面（官方工具，不用 member_*）。
  吞吐分层：coordinator/designer/reviewer/supervisor/docManager = 低~中吞吐；coder/tester = 高吞吐且可池化（同类型多实例），Leader 按吞吐分配。
  当需要确定软件团队某角色"是谁/能做什么/不能做什么/成功标准/输出格式"，
  或需要按该团队的三层链路交付可核查的改动时加载本技能。
version: "2.0.0"
kind: skill
triggers:
  - "软件团队"
  - "software-team"
  - "软件工程团队"
  - "三层角色"
  - "任务包"
  - "池化"
  - "team 成员管理"
---

# software-team · 软件工程团队模版

> **定位**：本文件是**模版**（引擎的**下游指引**），**不作为引擎组件**使用。
> **不依赖 `team-asset.yml`**：同目录若仍存在该文件，属待清理面。

---

## 〇、主 Agent 拉起清单（照做）

> 本清单 = **主 Agent（Leader）拉起本团队时按序执行**的动作序列；与 §四「每层的动作序」互补 —— **本节讲发起与收口，§四讲各层内的活**。

1. **加载本 skill**（`software-team`），据其**角色 / 层 / 产物契约**（§二）定分工。
2. **定 roster**：按层定名册 —— plan（`coordinator-*` / `designer-*`）· exec（`coder-*` / `tester-*` / `reviewer-*`）· audit（`supervisor-*` / 可选 `docManager-*`）；**不限席**；席位不足时**合规复用**（复用须登记 + lane 记录注明实际执行者，见 §二 池化条目）。
3. **逐个拉起席位（先取件 → 再拼装）**：**先调 `role_guide({ role })` 取件**，把返回的 `guide` 三段（`## 你的职责` / `## 你被授权决定` / `## 交付要求`）**原样拼进 `prompt`**（即 `spawn_teammate` 的 `prompt`）—— 引擎侧**同源单点**，**禁手抄**；随后 `spawn_teammate({ name, description, prompt })` —— **逐个**建 **durable 席位**（**不是**一次性 subagent）。
4. **人工直派同样先取件**：不经 `spawn_teammate`、由 Leader **自写任务包**时（`lane_dispatch` 取回 `firstLine` 后自写首行），**同样先调 `role_guide({ role })` 取件**，把三段**落进任务包**正文，**禁手抄** —— 两条派发路径共用同一取件口，产出与引擎自派任务包**逐字同源**。
5. **写黑板 `wave_plan`**：复用既有 `batch` / `wave_plan`（**不新黑板**）；`tasks[].roster` 写成员名作**声明**；难度档在**引擎层写 `D`**（team 通道档；引擎枚举 `A|B|C|D`——D 与 C **同属建批档、同受建批门禁**，既有以 `C` 声明的批次仍兼容）。
6. **派活**：`send_message(target=<成员名>, message=…)` —— **派活与唤醒的唯一正式通道**。
7. **入边交接**：上游出件后 `handoff_submit(from, to, artifacts, assertions)`（**成员自交**，Leader 可代交）⇒ 下游 `handoff_view` 报 `READY` 才开工。
8. **lane 进度与终态**：`member_status`（进度）→ `member_status(review)` → **`member_settle(merged|failed|conflict|skipped)`**；**audit 席位必须显式 settle**（不 settle ⇒ 批永久挂 `running`）。
9. **批相位收口**：`batch_phase(complete)`（**须先经 `running`**；`planning → complete` 非法）。

### 流转时序（谁唤醒谁）

```text
Leader ──spawn_teammate──▶ 席位（plan / exec / audit 各层，durable）
Leader ──send_message────▶ 派活（成员在最近步骤边界收到；inactive 会被唤醒）
成员   ──handoff_submit──▶ 下游入边（submitted = 下游开工硬前提）
成员   ──swarm_report + send_message──▶ Leader（回报双写：留痕 + 唤醒）
Leader ──list_agents / wait_agent──▶ 观测成员状态（wait_agent 只观察、不唤醒）
Leader ──member_status / member_settle──▶ lane 账本（引擎真源）
Leader ──batch_phase(complete)──▶ 批相位终态
```

**要点**：**唤醒成员**走 `send_message`（唯一真推送）｜**推进 lane 账本**走 `member_*`｜**推进批相位**走 `batch_phase` —— 三者**不可互替**。

---

## 一、这个团队是干什么的

**做软件工程**：从需求到可用、可测、可维护的代码交付。

**适用信号**：新增/改造业务功能、修缺陷、重构、接第三方 SDK、写测试与工程化改造 —— **凡是"改变产品行为"的活**。

**不适用**：改治理引擎内核（不在本团队职责内）｜写文章/文档交付（走 writing-team）｜出设计稿/视觉（走 design-team）｜做调研（走 research-team）。

---

## 二、三层与角色（**7 个席位 · coder/tester 可池化**）

```text
plan  ┌ coordinator ── 现状摸底 + 可并行内容拆解  ⇒ 产出「并行任务线清单」（为 designer 提供依据）   [低]
      └ designer ────── ① 四件套（线路级） ② 单步任务包（任务级）⇒ 串行提交队列，提交即启动下游      [中]
exec  ┌ coder  ─────── 照包实现（高吞吐，可多实例）                                                [高·池化]
      └ tester ─────── 照【同一个包】写测试套件，与 coder 并行                                     [高·池化]
      └ reviewer ───── ① 跑测试套件 + 出测试报告 ② 对抗式审查（MUST/SHOULD/FYI，只读不改码）        [低]
audit ┌ supervisor ──── 全量验收（逐条核对）+ 漂移评判 + 通过/返工建议 + 复盘                       [低]
      └ docManager ──── 记忆沉淀 + 文档/知识库归档（**可选席位**）                                  [低·可选]
```

| 层 | 角色 | 吞吐 | 干什么 | 产物契约 |
|---|---|---|---|---|
| **plan** | **`coordinator`** | 低 | **任务摸底**（现状、约束、**消费方契约**）+ **可并行内容拆解**：切成**可并行**的任务线，逐线标 **写域互斥**与依赖，**为 designer 提供依据** | `plan/<name>-recon.md`（摸底报告 + 任务线清单） |
| | **`designer`** | 中 | **① 线路级：设计四件套**；**② 任务级：单步任务包**（**每包一份独立 spec**）。**同线路任务包产出串行**；**每包串行提交队列，提交即启动下游，不等全量** | `plan/...` 四件套 + `plan/<name>-taskpack-<n>.md` |
| **exec** | **`coder`** | **高·池化** | 照包**实现**；自证读数（原始回显） | `exec/<name>-impl.md`（改动 + 原始读数 + 逐条判据对照） |
| | **`tester`** | **高·池化** | **照【同一个任务包】写测试套件** —— 不是"事后验 coder"，而是**与 coder 并行**独立产出测试工件 | `exec/<name>-tests.md`（测试套件路径 + **真实命令的原始输出** + 覆盖了哪几条验收标准） |
| | **`reviewer`** | 低 | **① 执行测试**：消费 `tester` 的套件，**在真实环境跑一遍**，出**测试报告**；**② 对抗式审查**：对照包挑缺陷，**只读不改码** | 测试报告 + 结构化 verdict（approve/reject + blocking + followup） |
| **audit** | **`supervisor`** | 低 | **逐条验收**（按包的 `## 验收标准`，不做二次评审）+ **漂移/未实现评判** + **通过或返工建议** + **复盘** | `audit/acceptance-report.md` + `audit/gap-list.json` + `audit/retrospective-report.md` |
| | **`docManager`**（**可选**） | 低 | **记忆沉淀**（`dsh-mneme` 优先）+ **文档/知识库归档** | `audit/retrospective-report.md` 等 |

### 四条铁律

1. **`reviewer` 在 exec 层做「初步审查」**（**含跑测试**），**总体验收归 audit 层 `supervisor`** —— `reviewer` 的 `approve` **不等于**批次验收通过，**不可替代** audit 层结论；**reviewer 只读不改码**（缺陷走报告，修复须新批次）。
2. **`tester` 与 `coder`【并行】、同源不同向**：**两者读【同一个任务包】**；coder 产出**实现**，tester 产出**测试套件**。⇒ **tester 不是"验收 coder 的产物"**（那是 `supervisor` 的活），而是**把任务包里的验收标准翻译成可执行的测试**。⇒ 并行意味着 **tester 不等 coder 完成**。
3. **plan 层两步不可合并**：**先摸底拆线（coordinator）⇒ 再逐线出包（designer）**。摸底没做完就出包 = 猜。
4. **下游统一按任务包验收** —— **任务包是唯一验收单元**；包外的追加要求一律回 plan 层补包。

### 池化（同类型多实例）

**`coder` 与 `tester` 可在团队内池化**：

- **同类型可拉起多个成员**（如 `coder-1` / `coder-2` / `tester-1`）；
- **Leader 按吞吐情况分配**：把不同任务包派给不同的同类型成员（**并行吞吐**）；
- **`roster` 是声明，不是席位名**：`tasks[].roster` 写**成员名作声明**（引擎据此判定写权归属）；**不要求**与 `spawn_teammate` 的 `name` **逐字一致**；
- **席位不限**：同类型成员**按需拉起**（`coder-1…N` / `tester-1…N` / …），无固定席位数；
- **席位不足时的合规复用**：复用须**登记**（落批次产物根，如 `exec/roster-deviation.md`）**并在 lane 记录中注明实际执行者**；**无登记不得复用**；
- 管理面见 §七（**官方工具**）。

---

## 三、任务包规格（**按 `spec-writing` 写**）

`designer` 出包**必须遵循 `spec-writing` 的规格**，最小结构：

| 段 | 内容 | 硬性 |
|---|---|---|
| **角色** | 谁来执行（coder / tester / …） | 必填 |
| **目标** | 一步活，**可独立交付** | 必填 |
| **关键契约** | 要遵守的接口/数据形状/不变量 | 必填 |
| **`## 验收标准`** | **逐条可判**，每条给**可核读数形态** | **必填**（**裸标题**，audit 判据源锚点） |
| **`## 约束`** | 边界（写域、不许动什么、依赖前提） | **必填** |
| **产物契约** | 落盘路径与文件名 | 必填 |
| **期望输出格式** | 汇报里要有什么（原始读数 / 表格 / 清单） | 必填 |
| **预算行** | `W ≈ …M（C≈…K × T≈…轮）；切法：…` | 必填 |

**判据措辞纪律**：**带限定量词**（禁裸「零命中」；写「`src/api/` 内零**调用**」这类可核形态）。

**粗判据（超任一即改拆法）**：改动 >8 文件 ｜ 跨模块 >2 ｜ 全量套件 >3 轮 ｜ 预估 >45 轮。

---

## 三之二、工程规范面（**按角色与规则分配**）

> **分工**：本文件 + `references/workflow.md` = **治理面**（谁在什么阶段交什么产物、过什么门禁）；`references/engineering/` = **工程面**（代码与验证要满足什么）。

**真源分层（避免双源）**：

| 层 | 承载 | 内容 |
|---|---|---|
| 宿主全局 | 环境 `AGENTS.md` | 机器/用户级规则（编码铁律、语言、风格） |
| 项目级 | `references/constitution.md` **实例化后** | 技术栈、目录、命名、自定义约定、错误码表 |
| 团队通用 | `references/engineering/` | 前端治理 / 后端治理 / 检查与验证细则 |
| 外部能力层（SpecLang **vendor**） | `references/vendor/speclang/`（上游原文副本，**29 件** = 27 件资产 ＋ `LICENSE` ＋ `NOTICE.md`）；适配层 `references/engineering/spec-contract.md` | 规格结构与证据语法 —— **原件为准**：规则原文是仓内 vendor 全文（逐件 sha256 见 `NOTICE.md`）；蟛蜞只写适配面（六态→引擎映射 / 机读行落地 / 缺口留档）。挂载见下表与本节末「推荐技能」 |

⇒ **不新建独立 AGENTS 文件**：全局 AGENTS + 项目 constitution 已占真源位，再加一套 = 双源冲突。项目约定由 constitution 承载，团队通用细则由 engineering/ 承载。

**角色 → 必读 → 落点**：

| 角色 | 必读 | 产物落点 |
|---|---|---|
| `coordinator` | `backend.md` B-1/B-3/B-4 + `frontend.md` F-1/F-6 + `spec-contract.md` S-10 ＋ 附 A（需求编号族） | `codebase-survey.md` 约束清单：点名能力**唯一归属**与**可复用面**；把上游需求编号带进清单，并标出「需求→契约」未被覆盖的项 |
| `designer` | `frontend.md` 全部 + `backend.md` B-1..B-6 + `spec-contract.md` 附 A（结构自检 / 编号与引用 / DAG / 编号族） | spec 的「前端行为」「后端能力归属」「异常边界」章节 + 结构自检（段落齐 / 编号唯一 / 引用可解析）+ `AC-` `RULE-` 编号族 |
| `coder` | `frontend.md` F-1..F-6 + `backend.md` 全部 + `spec-contract.md` S-7 ＋ 附 A（编号与引用） | 实现说明：逐条对照 + 最小自检读数 + 每处改动带**真实存在**的条目号；未验证项不得计通过 |
| `tester` | `verification.md` 全部 + `spec-contract.md` S-6/S-7/S-8 | 测试报告：**四态计数** + 代码状态锚定 + 六态结论与 `SUMMARY:` 机读行 |
| `reviewer` | `frontend.md` + `backend.md` + `verification.md` + `spec-contract.md` S-6/S-8 ＋ 附 A（结构失败先于语义） | 审查清单 MUST/SHOULD/FYI，逐条给条目号（F-x / B-x / V-x / S-x）；结构缺项判 MUST |
| `supervisor` | `verification.md` V-5/V-6/V-7 + `spec-contract.md` S-7/S-8 | 验收报告：证据锚定与四态核对；`UNKNOWN` 不计通过，结论带单一门控词 |
| `docManager` | `frontend.md` + `backend.md` + `verification.md` 全部 | 复盘：规则失效点 + 新增检查建议 |

> **`docManager` 不挂 `spec-contract.md`（显式理由）**：复盘角色不产出规格面（无规格产物可比对）；且其「工程规范」节标题为「复盘校准用」，不属必读节，要挂须先把标题统一为裸标题范式 —— 那属**扩大改动面**，本批不做。其「必读」列已收敛为 `engineering/` 同节三份，避免「全部」被读成含规格细则。

**本团队不含**：独立 AGENTS 文件 · task-brief / finish-review · planning-with-files 三件套 · 强制 TDD（测试面走 spec 驱动 + `tester ∥ coder` 并行建套件）。

**MCP 面纪律**：

- **只列 MCP 类别，不写具体工具名**：工具名随宿主 / 插件版本漂移，写死即失效 ⇒ 指引里统一写「代码图谱类 MCP（只读）」，用前**以当前会话实际注册的工具为准**。
- **不把 MCP 工具名写进 `tools.allow`**（也不写 `mcp` 这类类别名）：引擎按「词汇表 \ 该角色 allow」**反推 deny**（`lib/engine/dispatch.js#deriveDenyTools`，词汇表 = 全角色 allow 并集）⇒ 写进 allow 会让该名字进词汇表，反而把它从**其他**角色的工具面里禁掉。MCP 面**默认不被收窄**，**不写即正确**。

**推荐技能（recommend 语义，非装配）**：

| 项 | 内容 |
|---|---|
| 技能源 | 外部资产 **SpecLang**，版本钉 `SpecLang@b3ee6ee`（**不锚 `HEAD`**）｜来源 `https://gitcode.com/xuanjz/SpecLang` |
| 四个技能 | `speclang-waterfall`（规格编写 ＋ 机械校验）｜`speclang-hoare-check`（霍尔逻辑推理验证）｜`prd-guide`（需求编号纪律）｜`ui-component-registry`（UI 组件种类目录） |
| 与本团队的关系 | **recommend**：**按需启用、非装配、不进入引擎装配面**；不在册**不构成失败**，也不影响任何门禁。资产**已 vendor 进仓**（`references/vendor/speclang/`，**29 件** = 27 件资产 ＋ `LICENSE` ＋ `NOTICE.md` ＋ 逐件 sha256 变更清单）⇒ **读法 = 直接读仓内 vendor 原件**，不依赖宿主是否装了同名技能；**vendor 不改变 recommend 语义**（仍不进装配面） |
| 许可与署面 | 源仓 `LICENSE` 署 **The Cangjie Project**（Apache-2.0 with Runtime Library Exception），**权利人待确认**（不得改写成已确认）⇒ 已按用户裁决**解除**上批「禁全文拷贝」自保红线，改为**允许 vendor ＋ 四条替代约束**：① `LICENSE` 原件随目录 ② `NOTICE.md`（含逐件 sha256 变更清单）③ 署面保留 ④ 权利人待确认 ｜ 条件缺任一即视为红线违反 |

- **三条可核边界（`recommend` ≠ 装配面）**：① **禁**写入任何 role 文件 frontmatter 的 `skills:` 字段；② **禁**把本条写成装配式措辞（强制安装 / 硬依赖 / 未就绪即拒批一类表述）；③ 技能名解析不到 ⇒ **不构成拒态**：`GATE_SKILL_MISSING` 已于 `b8380a8` 移除（`discipline.md` §0o 记载 `skills` 名可解析性 = 纯 recommend）。
- **按需加载**：用到哪面读哪面（写规格 → `speclang-waterfall`；量证据强度 → `speclang-hoare-check`；需求编号 → `prd-guide`）；**常规任务不加载亦无影响**。

**何时读哪一面**（按任务取件；读的都是**仓内 vendor 原件**，不联网、不依赖宿主安装）：

| 任务 | 读这里 |
|---|---|
| 写 / 改 PRD（需求点 · 场景 · 验收检查点） | `references/vendor/speclang/prd-guide/` |
| 规格结构与机械校验（`MC-*` 规则与校验器） | `references/vendor/speclang/speclang-waterfall/` |
| 证据强度、Hoare 推理报告模板 | `references/vendor/speclang/speclang-hoare-check/` |
| UI kind / operation 目录 | `references/vendor/speclang/ui-component-registry/` |
| 蟛蜞侧怎么落（六态→引擎映射 · 机读行落地 · 缺口留档） | `references/engineering/spec-contract.md` |

> **必读 = 适配层映射；选读 = vendor 原件**：角色必读表里点名的 `spec-contract.md` 是**适配层映射**（讲「蟛蜞怎么用」），其规则**定义**来自 vendor 原件（`references/vendor/speclang/`，**选读**、按需加载）；**两者冲突以原件为准**。选读面**永不**构成必读义务：不在册、未加载、未读均**不构成失败，也不影响任何门禁**。

---

## 四、每层的动作序（照做）

### plan · coordinator（摸底 + 拆线）

1. **只读侦察先行**：`read` / `glob` / `grep` + 只读 shell；
2. **消费方契约摸底**（要接的 API/SDK/框架扩展点，**先找它的校验实现，以其报错分支为约束文档**；对照仓库内合规样例；跑最小探针）；
3. **拆线**：切出**可并行**任务线，逐线写清**写域**（哪些文件/目录）⇒ **写域互斥**；有依赖的画 DAG；
4. 落 `plan/<name>-recon.md` + 进度快照；
5. `handoff_submit` 交下游 designer。

### plan · designer（出单步任务包）

1. 读 coordinator 的任务线清单；
2. **逐线出包**（§三的规格）；
3. 落 `plan/<name>-taskpack-<n>.md` + 进度快照；
4. `handoff_submit` 交 exec（**coder 与 tester 都消费同一个包**）。

### exec · coder / tester（**并行**）

1. **读批**：`batch_status({ batchId, session: '<批次归属 session 键>' })` —— **不带 `session` 会 `batch not found`**；
2. **各自照包开工，互不等待**：coder 做实现，tester 写测试套件；
3. **每完成一子步骤**即落 `exec/progress/NN-<slug>.md`（**禁止攒批**）；
4. ⚠ **落盘只用 `write`/`edit`** —— 本机 `pwsh` 写盘会被护栏拒（报 L3 拒绝）；
5. **自证**：每条结论配**原始回显**（不转述、不美化、**未验证就写「未验证」**）；
6. `handoff_submit` ⇒ **双写回报**（见 §五）。

### exec · reviewer（**跑测试 + 对抗审查**）

1. **等 coder 与 tester 都出件**（单个任务包的 code、test 完成产出后）；
2. **① 跑测试**：**执行 `tester` 的测试套件**（真实环境），产出**测试报告**（命令原文 + 原始输出 + 通过/失败清单）；
3. **② 对抗审查**：对照包挑缺陷，输出 **MUST/SHOULD/FYI 分级** + 结构化 `verdict`（approve/reject + blocking + followup）；
4. **只读不改码**：缺陷走报告，**修复须新批次 exec**；
5. ⚠ **`reviewer` 的 `approve` ≠ 批次验收通过** —— 总体验收归 audit 层 `supervisor`。

### audit · supervisor（**全量验收 + 复盘**）

1. **读判据源**（任务包的 `## 验收标准`）+ 上游产物（**实现与测试两件都要读**，含 `reviewer` 的测试报告）；
2. **逐条核对**（**不做二次评审**）；**独立复现**关键读数（**不得只转述上游**，**测试要自己重跑**）；
3. **漂移评判**：给出**未实现内容**与**任务实现漂移**的评判 + **通过/返工建议**；
4. 出 `audit/acceptance-report.md` + `audit/gap-list.json`；`supervisor` 另出复盘；
5. **未决项只进 gap-list** ⇒ **不得以「继续调查」收尾**。

---

## 五、回报与交接通道

| 通道 | 用途 | 要害 |
|---|---|---|
| **`handoff_submit`** | **交接**（上游→下游，写 `handoffs` + `lane.handoff` 事件） | 下游开工的**硬前提**；**先交后报** |
| **`swarm_report({batchId, lane, …})`** | **审计面**（落 `swarm.report` 事件） | ⚠ **必须带 `batchId`**，否则不落事件流 |
| **`send_message(target='lead')`** | **唤醒面**（真推送） | 成员的**唯一真推送**通道 |

**⇒ 成员回报 = 双写**（`swarm_report` + `send_message`）：**只发前者 ⇒ 留痕不唤醒；只发后者 ⇒ 唤醒不留痕。**

**写权**：成员**只能写自己 lane 的出边**；越权 ⇒ `GATE_HANDOFF_UNAUTHORIZED` **且零写入**（安全，不是 bug）。

---

## 六、实机踩过的坑（务必读）

| # | 坑 | 真相 |
|---|---|---|
| 1 | **`batch not found`** | 成员是新会话 ⇒ 读批**必须传 `session: 'session-<uuid>'`**（裸 UUID、命名黑板形态**都不命中**） |
| 2 | **越权探针「没反应」** | `handoff_submit` 的拒态**有固定门序**：**产物在场性 → 覆盖保护 → 权限判定**。指向一条**已 `submitted`** 的入边会被 `GATE_HANDOFF_OVERWRITE_UNDECLARED` **遮蔽** ⇒ 测权限须避开前两步 |
| 3 | **`log_export` 计数对不上** | **裸计数在并发席位下会被污染** ⇒ 零写入判据须取「**事件类型 + 记录在场性**」，**裸计数不构成证据** |
| 4 | **`swarm_report` 显示 `unbound`** | **预期**（team 席位无 `member.dispatch` 绑定）⇒ 只要**带 `batchId`** 就照样落事件流 |
| 5 | **`pwsh` 报 L3 拒绝** | 本机护栏禁 shell 写盘 ⇒ 一律走 `write`/`edit` |
| 6 | **技能解析不到** | `GATE_SKILL_MISSING` **只告警不拒建批**（recommend 语义） |

---

## 七、team 成员的管理面（**官方工具**）

> ⚠ **分工铁律：官方工具管「人」｜引擎 `member_*` 管「lane」。两本账并列，不互替。**
> · **人（成员生命周期）** ⇒ **官方工具**：`spawn_teammate` 拉起 · `send_message` 派活/唤醒 · `list_agents` 查状态 · `wait_agent` 等动静 · `interrupt_agent` 打断当前轮。
> · **lane（引擎真源）** ⇒ **`member_status` / `member_settle`**：登记 lane **进度**与**终态**（使 `batch_status` 的 lane 跃迁可见、使下游交接与 audit 结算的入边前提成立）；**批相位**由 `batch_phase` 推进。
> **为什么必须两本账**：`member_*` 改的是**批次里 lane 的状态**（状态文件），**不触达成员的会话**；反之官方工具**只管人、不改 lane 状态**。⇒ 少一本账就会出现两种坏账：「成员在做、lane 无痕」或「lane 已结、成员还在跑」。

**正确的成员管理面**：

| 想做什么 | 用什么 |
|---|---|
| **看成员在不在、在不在跑** | **`list_agents`**（`inactive` = 无轮在执行；**不代表任务完成/失败**） |
| **给成员派活 / 通知收工 / 追问** | **`send_message(target=<成员名>)`** —— 运行中的成员在**最近步骤边界**收到；**inactive 成员会被唤醒** |
| **打断成员当前轮** | **`interrupt_agent(target=<成员名>)`** —— 保留其待处理收件箱 |
| **等成员动静** | **`wait_agent`** —— 只观察**调用之后**的变化；**不会唤醒**任何成员；无其他成员在跑时立刻返回 |
| **拉起新成员** | **`spawn_teammate(name, description, prompt)`** |

**⇒ 收口动作序（team 方向）**：

1. **`list_agents`** 确认成员状态；
2. 成员仍在跑且不需要了 ⇒ **`interrupt_agent`**（打断）；
3. 需要它继续/收工 ⇒ **`send_message`**（告知结论或收工指令）；
4. **批相位收口** ⇒ **`batch_phase(complete)`**（**须先经 `running`**；`planning → complete` 非法）。

**⇒ 关于 `roster` 与 lane**：`wave_plan` 建批时 `tasks[].roster` 只作**声明**（引擎只做词法校验 + 写权归属判定）。

**两条通道并列（勿混为一谈）**：

| 动作 | 用什么 | 要害 |
|---|---|---|
| **派活 / 唤醒 / 通知收工 / 追问** | **`send_message(target=<成员名>)`** | **真正把活交到成员手上**的是它；成员的**唯一真推送**通道（inactive 成员会被唤醒） |
| **交接**（上游→下游，DAG 硬前提） | **`handoff_submit(from, to, artifacts, assertions)`** | **成员自交**（Leader 可代交）；下游 `handoff_view` 报 `READY` 才开工 |

**⇒ 关于 lane 状态**：**team 批两条 `member_*` 都用** ——

- **`member_status`** 登记 lane **进度**（`pending` / `running` / `review` / `idle` 的跃迁在 `batch_status` 可见）；
- **`member_settle`** 登记 lane **终态**（`merged` / `failed` / `conflict` / `skipped`）。

**旧口径「`member_settle` 不用于 team 批」已废止**：聚合 audit lane 的成员完成后**不会自动结算**（引擎 `auto.settle.skipped` 的 `audit-explicit-settle-required`）⇒ **必须由 Leader 显式 `member_status(review)` → `member_settle(merged|conflict)`**，否则**批会永久挂在 `running`**。⇒ 省掉这一步 = **批收不了口**。

**批相位**仍由 **`batch_phase`** 推进（`complete` 须先经 `running`）；**lane 终态与批相位是两本账，各管各的**（见 §七 开头的分工铁律）。


---

## 八、完成判据（DoD）

- **产物落盘**（批次产物根，**不落工作区根**）；
- **每条结论有原始读数**（可复核）；
- **交接已 `submitted`**（下游 `handoff_view` 报 `READY`）；
- **验收标准逐条对照**（audit 出 verdict）；
- **测试真跑过**：`tester` 的产物必须是**真实命令的原始输出**，不是「应该能过」；
- ⚠ **产出运行于宿主/消费路径时，完成判据必含一次真实加载/启动冒烟**（语法的 `node --check`、单测**不算**完成）—— 先搭会失败的版本（RED）再做到通过（GREEN），**禁攒批到终验**。

---

## 九、Leader 收口

1. **发现完成**（worker 完成**不推送**给 Leader 之外的观察面）：① `batch_status`（lane 跃迁）② `log_export`（`swarm.report` / `member.settled` / `lane.handoff` / `auto.settle.*` 的 `reason`）③ 产物根 glob；
2. **成员管理** ⇒ 见 §七（**官方工具**，**不是 `member_*`**）；
3. **批终态**：`batch_phase(complete)`（**须先经 `running`**）。
