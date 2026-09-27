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
> **依据**：2026-09-26 用户裁决 —— 团队内容只是模版，相当于引擎的下游指引，不再作为组件使用，相关测试不再检验。
> **角色职责依据**：**2026-09-27 用户裁决**（`C-1` reviewer 合并职责 / `C-2` designer 四件套+任务包并列 / `C-3` docManager 可选 / `E-1` 弃用旧代码图谱工具、改用 `codegraph` 等 MCP）—— 角色职责**以用户版为准**。
> **⚠ `team-asset.yml` 已全面弃用**（2026-09-27 用户裁决）：本 skill **不再依赖**该资产；同目录若仍存在该文件，**属待清理面**。

---

## 一、这个团队是干什么的

**做软件工程**：从需求到可用、可测、可维护的代码交付。

**适用信号**：新增/改造业务功能、修缺陷、重构、接第三方 SDK、写测试与工程化改造 —— **凡是"改变产品行为"的活**。

**不适用**：改治理内核（走 engine-team）｜写文章/文档交付（走 writing-team）｜出设计稿/视觉（走 design-team）｜做调研（走 research-team）。

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
- **roster 名 = 成员名**（`tasks[].roster` 必须与 `spawn_teammate` 的 `name` 逐字一致 —— 引擎据此判定写权归属）；
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
4. ⚠ **落盘只用 `write`/`edit`** —— 本机 `pwsh` 写盘会被 L3 护栏拒（`L3-W01`）；
5. **自证**：每条结论配**原始回显**（不转述、不美化、**未验证就写「未验证」**）；
6. `handoff_submit` ⇒ **双写回报**（见 §五）。

### exec · reviewer（**跑测试 + 对抗审查**，2026-09-27 `C-1`）

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
| 2 | **越权探针「没反应」** | `handoff_submit` 的拒态**有固定门序**：**产物在场性 → R-2 覆盖保护 → 权限判定**。指向一条**已 `submitted`** 的入边会被 `GATE_HANDOFF_OVERWRITE_UNDECLARED` **遮蔽** ⇒ 测权限须避开前两步 |
| 3 | **`log_export` 计数对不上** | **裸计数在并发席位下会被污染** ⇒ 零写入判据须取「**事件类型 + 记录在场性**」，**裸计数不构成证据** |
| 4 | **`swarm_report` 显示 `unbound`** | **预期**（team 席位无 `member.dispatch` 绑定）⇒ 只要**带 `batchId`** 就照样落事件流 |
| 5 | **`pwsh` 报 L3 拒绝** | 本机护栏禁 shell 写盘 ⇒ 一律走 `write`/`edit` |
| 6 | **技能解析不到** | `GATE_SKILL_MISSING` **只告警不拒建批**（recommend 语义） |

---

## 七、team 成员的管理面（**官方工具**）

> ⚠ **铁律：team 方案【不走】`member_status` / `member_settle` 这类 `member_*` 工具收口。**
> **理由（引擎事实）**：`member_*` 改的是**批次里 lane 的状态**（状态文件），**不触达成员的会话**；且引擎侧**没有任何 team 成员生命周期接线**（全仓 `spawnTeammate` / `interruptAgent` / `teamTask*` **零调用**，唯一消费 `agentTeams` 的地方是 `managerRosterOf` —— 判定 Manager 是否在册）。
> ⇒ ⇒ **用 `member_*` 管 team 成员 = 改了一个成员看不见的字段**。

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

**⇒ 关于 `roster` 与 lane**：`wave_plan` 建批时 `tasks[].roster` 只作**声明**（引擎只做词法校验 + 写权归属判定）；**真正把活交到成员手上的是 `send_message`**。

**⇒ 关于 lane 状态**（2026-09-26 用户裁决）：**team 批只保留 `member_status`** —— 它只用于**登记 lane 进度**（让 `batch_status` 的 lane 跃迁可见），**`member_settle` 不用于 team 批**（它管不了成员，写 lane 终态对 team 无治理意义）。**lane 终态与批相位一律由 `batch_phase` 推进。**

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
