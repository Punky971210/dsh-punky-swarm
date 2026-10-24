---
name: video-team
description: |
  视频制作团队模版（引擎的**下游指引**，不作为引擎组件使用）：三层 7 角色
  （plan coordinator·designer / exec producer·captioner·motion-designer·audio-engineer / audit supervisor）
  的职责边界、产物契约、任务包规格（按 spec-writing）、回报与交接通道，
  以及 team 成员的管理面（官方工具，不用 member_*）。
  吞吐分层：coordinator/designer/supervisor = 低~中吞吐；producer/captioner/motion-designer/audio-engineer = 高吞吐且可池化（同类型多实例），Leader 按吞吐分配。
  当需要确定视频团队某角色"是谁/能做什么/不能做什么/成功标准/输出格式"，
  或需要按该团队的三层链路交付可核查的场次产物与成片时加载本技能。
version: "1.0.0"
kind: skill
triggers:
  - "video-team"
  - "视频团队"
  - "场次"
  - "分镜"
  - "字幕"
  - "配音"
  - "动效"
  - "素材合成"
---

# video-team · 视频制作团队模版

> **定位**：本文件是**模版**（引擎的**下游指引**），**不作为引擎组件**使用。
> **重建依据**：本目录于 2026-10-14 工作树批量删除事故中丢失，按用户原话「**video-team 内容参考现在 software-team 的放肆补全架构**」**重建**，参照 `software-team` 架构充分补全。
> **裁定依据**：用户十条裁决（`Q-V1b`..`Q-V9` + Leader 追加）—— 三条**逐字句**见 §一 节末。

---

## 〇、主 Agent 拉起清单（照做）

> 本清单 = **主 Agent（Leader）拉起本团队时按序执行**的动作序列；与 §四「每层的动作序」互补 —— **本节讲发起与收口，§四讲各层内的活**。

1. **查 team-skill**：加载本 skill（`video-team`），据其**角色 / 层 / 产物契约**（§二）定分工。
2. **定 roster**：按层定名册 —— plan（`coordinator-*` / `designer-*`）· exec（`producer-*` / `captioner-*` / `motion-designer-*` / `audio-engineer-*`）· audit（`supervisor-*`）；**七个角色，无第八个**；席位不足时**合规复用**（复用须登记 + lane 记录注明实际执行者，见 §二 池化条目）。
3. **逐个拉起席位（先取件 → 再拼装）**：**先调 `role_guide({ role })` 取件**，把返回的 `guide` 三段（`## 你的职责` / `## 你被授权决定` / `## 交付要求`）**原样拼进 `prompt`**（即 `spawn_teammate` 的 `prompt`）—— 引擎侧**同源单点**，**禁手抄**；随后 `spawn_teammate({ name, description, prompt })` —— **逐个**建 **durable 席位**（**不是**一次性 subagent）。
4. **人工直派同样先取件**：不经 `spawn_teammate`、由 Leader **自写任务包**时（`lane_dispatch` 取回 `firstLine` 后自写首行），**同样先调 `role_guide({ role })` 取件**，把三段**落进任务包**正文，**禁手抄** —— 两条派发路径共用同一取件口，产出与引擎自派**逐字同源**。
5. **写黑板 `wave_plan`**：复用既有 `batch` / `wave_plan`（**不新黑板**）；`tasks[].roster` 写成员名作**声明**；难度档在**引擎层写 `D`**（team 通道档；引擎枚举 `A|B|C|D`——D 与 C **同属建批档、同受建批门禁**，历史以 `C` 声明者仍兼容）。
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

**做视频**：从脚本/分镜到**可验收的场次产物与成片**。

**适用信号**：做视频、场次制作、分镜、字幕、配音、动效、素材合成 —— **凡是"把一个片子做出来"的活**。

**不适用**：改治理引擎内核（不在本团队职责内）｜写软件（走 software-team）｜出设计稿/视觉（走 design-team）｜做调研（走 research-team）。

### 能力层（按 `Q-V2` 全选 · 11 项）

> **写法口径**：本节只写**用途**与**指向**（加载名 = skill 自身的 frontmatter `name`），**不承载装配数据**。

| 技能（加载名） | 在本团队里的用途 |
|---|---|
| `hyperframes` | 任何视频/动画/动效件的**总入口**（先读它再动手） |
| `hyperframes-core` | **合成契约**（结构、时间属性、轨道、子合成、确定性渲染规则） |
| `general-video` | **自定义合成**的编写与编排（无专门流程契合时的落点） |
| `motion-graphics` | **动效即信息**的短片单元（无旁白、动效为主） |
| `embedded-captions` | **字幕**嵌入（含成片级字幕处理） |
| `media-use` | **素材解析与取得**（BGM / SFX / 图像 / 图标 / 配音，落为冻结本地文件） |
| `comfyui-use` | **Layer A 配方驱动**产素材图（配方 → 参数槽 → 工具序列 → 质检） |
| `gpt-sovits-tts-synthesis` | **中文 TTS 合成**（长文分段批量、固定 seed 可复现） |
| `voice-breath-trim` | **气口（呼吸）检测与裁剪**（呼吸组口径，整组压缩） |
| `frame-occlusion-audit` | **帧级遮盖/层级/错位审计**（判据主体 = 相交对的身份集合） |
| `slideshow` | **翻页式演示**形态（离散页、片段揭示、分支跳转） |

### 三条用户裁定（逐字）

- **裁定 A**：`按满配成员规格，render 不需要，因为导出是成片之后的工序`
- **裁定 B**：`不要 docManager ⇒ 归档归 supervisor`
- **裁定 C**：`导出是成片之后的工序`

> **口径**：以上三条为**用户原话逐字**，**不得改写标点**；上表之外的能力名**不得增补**（未裁定项不写入）。

---

## 二、三层与角色（**7 个席位 · exec 四个角色均可池化**）

```text
总数 = 7（七）
plan  ┌ coordinator ────── 场次拆线 + 写域划线  ⇒ 产出「场次线清单」（为 designer 提供依据）        [低]
      └ designer ───────── 场次规格 + 单场任务包 ⇒ 串行提交，提交即启动下游                         [中]
exec  ┌ producer ───────── 单场可视产物实现（一个写域 = 一场，可多实例）                            [高·池化]
      ├ captioner ──────── 字幕与气口口径执行（可多实例）                                          [高·池化]
      ├ motion-designer ── 动效与动画实现（可多实例）                                              [高·池化]
      └ audio-engineer ─── 配音与音频实现（可多实例）                                              [高·池化]
audit ┌ supervisor ─────── 全量验收（逐条核对 + 独立复现）+ 归档                                  [低]
```

| 层 | 角色 | 吞吐 | 干什么 | 产物契约 |
|---|---|---|---|---|
| **plan** | **`coordinator`** | 低 | **场次拆线与写域划线者**：只读侦察（现状、素材盘点、**消费方契约摸底**：目标平台/容器的编码与时长约束）+ **拆线**（切出场次线，**逐线判定写域**）+ 定**渲染纪律**（分段渲染：每场 standalone → 合成）+ 标依赖 DAG | `plan/<name>-recon.md`（含 `## 约束清单` / `## 依赖与风险` / `## 写域矩阵`） |
| | **`designer`** | 中 | **场次规格与单场任务包产出者**：① 场次规格（分镜/时间轴/素材清单/字幕口径）② **单场任务包**（每场一份独立 spec，按 `spec-writing` 最小结构）；每包给【**预算行**】+【**验收标准**】+【**约束**】**串行提交，提交即启动下游** | `plan/<name>-spec.md` + `plan/<name>-taskpack-<n>.md` |
| **exec** | **`producer`** | **高·池化** | **单场可视产物实现者**（一个写域 = 一场）：照包产**一个 standalone HTML**（自包含、可独立渲染/截图）；消费 `hyperframes-core` 合成契约与 `general-video`/`slideshow` 场次形态；用 `comfyui-use` Layer A 配方产素材图；用 `frame-occlusion-audit` 自查 | 场次 HTML（写域内）+ `exec/<name>-impl.md` |
| | **`captioner`** | **高·池化** | **字幕与气口口径执行者**：产字幕（`embedded-captions`）；按 `voice-breath-trim` 的**呼吸组**口径标气口；产**逐段人工审核包** | 字幕文件（写域内）+ `exec/<name>-captions.md` |
| | **`motion-designer`** | **高·池化** | **动效与动画实现者**：按 `motion-graphics` 的**原子动效规则**实现动效（`hyperframes` 族提供动效运行时与适配器）；动效**用子合成**组织；产出**动效规格**（时长、缓动、触发） | 动效产出（写域内）+ `exec/<name>-motion.md` |
| | **`audio-engineer`** | **高·池化** | **配音与音频实现者**：TTS 合成（`gpt-sovits-tts-synthesis`）；气口裁剪（`voice-breath-trim`，**按呼吸组整组压缩**）；BGM/SFX 选取与**许可登记**（`media-use`） | 音频文件（写域内）+ `exec/<name>-audio.md` |
| **audit** | **`supervisor`** | 低 | **全量验收者 + 归档者**：① 按各任务包 `## 验收标准` **逐条核对**（**不做二次评审**）② **独立复现**关键读数（**不得只转述上游**）③ **成片验收**④ **归档**（记忆沉淀 `dsh-mneme` 优先 + 产物归档）⑤ 出 `gap-list.json` | `audit/acceptance-report.md` + `audit/gap-list.json` + `audit/retrospective-report.md` |

### 四条铁律

1. **plan 层两步不可合并**：先**摸底拆线**（`coordinator`）⇒ 再**逐线出包**（`designer`）。摸底没做完就出包 = 猜。
2. **下游统一按任务包验收** —— **任务包是唯一验收单元**；包外的追加要求**一律回 plan 层补包**。
3. **写域互斥 + 一个写域一个写者**：并行 lane 的写域**交集为空**（可机核）；lane **只写自己的写域**，跨域改动**另开 lane**。
4. **`supervisor` 只读不改码 + 归档归它**：缺陷走**报告**，**修复走新批次**；**归档（记忆沉淀 + 产物归档）归 `supervisor`**。

### 池化（同类型多实例）

**exec 层四个角色（`producer` / `captioner` / `motion-designer` / `audio-engineer`）均可在团队内池化**：

- **同类型可拉起多个成员**（如 `producer-1` / `producer-2` / `captioner-1`）；
- **Leader 按吞吐情况分配**：把不同场次/不同面派给不同的同类型成员（**并行吞吐**）；
- **`roster` 是声明，不是席位名**：`tasks[].roster` 写**成员名作声明**（引擎据此判定写权归属）；**不要求**与 `spawn_teammate` 的 `name` **逐字一致**；
- **席位不限**：同类型成员**按需拉起**，无固定席位数；
- **席位不足时的合规复用**：复用须**登记**（落批次产物根，如 `exec/roster-deviation.md`）**并在 lane 记录中注明实际执行者**；**无登记不得复用**；
- 管理面见 §七（**官方工具**）。

---

## 三、任务包规格（**按 `spec-writing` 写**）

`designer` 出包**必须遵循 `spec-writing` 的规格**，最小结构 **8 段**：

| 段 | 内容 | 硬性 |
|---|---|---|
| **角色** | 谁来执行（`producer` / `captioner` / `motion-designer` / `audio-engineer` / …） | 必填 |
| **目标** | 一场活，**可独立交付** | 必填 |
| **关键契约** | 要遵守的接口/数据形状/不变量 | 必填 |
| **`## 验收标准`** | **逐条可判**，每条给**可核读数形态** | **必填**（**裸标题**，audit 判据源锚点） |
| **`## 约束`** | 边界（写域、不许动什么、依赖前提） | **必填** |
| **产物契约** | 落盘路径与文件名（**批次产物根内**） | 必填 |
| **期望输出格式** | 汇报里要有什么（原始读数 / 表格 / 清单） | 必填 |
| **预算行** | `W ≈ …M（C≈232K × T≈…轮）；切法：…` | 必填 |

**任务包骨架（机读形态，供校准脚本 S1 计顶层键）**：

```json
{
  "role": "<角色名：§二 七个之一>",
  "goal": "<一场活，可独立交付>",
  "contract": "<关键契约：接口 / 数据形状 / 不变量>",
  "acceptance": ["<判据：带限定量词 + 可核读数形态>"],
  "constraints": ["<边界：写域 / 不许动什么 / 依赖前提>"],
  "artifacts": ["<落盘路径：批次产物根内>"],
  "outputFormat": "<汇报里要有什么>",
  "budget": "W ≈ <N>M（C≈232K × T≈<N> 轮）；切法：…"
}
```

**判据措辞纪律**：**带限定量词**（禁裸「零命中」；写「`exec/` 内零**调用**」这类可核形态）。

**粗判据（超任一即改拆法）**：改动 >8 文件 ｜ 跨场次 >2 ｜ 全量套件 >3 轮 ｜ 预估 >45 轮。

---

## 四、每层的动作序（照做）

### plan · coordinator（摸底 + 拆线）

1. **只读侦察先行**：`read` / `glob` / `grep` + 只读 shell；
2. **消费方契约摸底**（目标平台/容器的**编码与时长约束**，**先找它的校验实现，以其报错分支为约束文档**；对照仓库内合规样例；跑最小探针）；
3. **拆线**：切出**场次线**，逐线写清**写域**（哪些文件/目录）⇒ **写域互斥**；有依赖的画 DAG；
4. **渲染纪律**：定「分段渲染」口径（每场先出 standalone，再合成）；⚠ **写域形态不写死** ——「每场一个 standalone HTML = 一个写域」仅为**历史实证形态参考**，**判据权归 `coordinator`**；
5. 落 `plan/<name>-recon.md` + 进度快照；
6. `handoff_submit` 交下游 `designer`。

### plan · designer（出单场任务包）

1. 读 `coordinator` 的场次线清单；
2. **逐线出包**（§三的 8 段规格），每包含 `## 验收标准` + `## 约束` + 预算行；
3. 落 `plan/<name>-spec.md` + `plan/<name>-taskpack-<n>.md` + 进度快照；
4. `handoff_submit` 交 exec —— **含 `motion` / `captions` / `sfx-audio` 面时须分别指向对应 exec 角色**。

### exec · producer / captioner / motion-designer / audio-engineer（**并行**）

1. **读批**：`batch_status({ batchId, session: '<批次归属 session 键>' })` —— **不带 `session` 会 `batch not found`**；
2. **各自照包开工，互不等待**：`producer` 做场次可视产物；`captioner` 做字幕与气口；`motion-designer` 做动效；`audio-engineer` 做配音与音频；
3. **每完成一子步骤**即落 `exec/progress/NN-<slug>.md`（**禁止攒批**）；
4. ⚠ **落盘只用 `write`/`edit`** —— 本机 `pwsh` 写盘会被 L3 护栏拒（`L3-W01`）；
5. **自证**：每条结论配**原始回显**（不转述、不美化、**未验证就写「未验证」**）；
6. `handoff_submit` ⇒ **双写回报**（见 §五）。

### exec · 验证（并入 supervisor 的独立复现）

**本团队不设 `reviewer` 席位**；exec 层各角色的产物**由 `supervisor` 独立复现**。

> **口径**：`software-team` 把「跑测试」交给 `reviewer`；本团队七个角色里没有该席位。⇒ 改由 `supervisor` 的**独立复现**承担 —— 其验收标准本就含「**独立复现、不得只转述上游**」，再加一个 exec 层测试席会**与其职责重叠**。

### audit · supervisor（**全量验收 + 归档**）

1. **读判据源**（各任务包的 `## 验收标准`）+ 上游产物（**实现件与素材登记表都要读**）；
2. **逐条核对**（**不做二次评审**）；**独立复现**关键读数（**不得只转述上游**）；
3. **成片验收**：按任务包 `## 验收标准` 逐条核对 + 独立复现；⚠ **「导出」不属团队工序**（见 §一 裁定 C）⇒ **不得**把导出当验收项；
4. 出 `audit/acceptance-report.md` + `audit/gap-list.json`；**归档**（记忆沉淀 + 产物归档）**归本角色**；
5. **未决项只进 `gap-list`** ⇒ **不得以「继续调查」收尾**。

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

**⇒ 关于 lane 状态（team 批两条 `member_*` 都用）**：

- **`member_status`** 登记 lane **进度**（`pending` / `running` / `review` / `idle` 的跃迁在 `batch_status` 可见）；
- **`member_settle`** 登记 lane **终态**（`merged` / `failed` / `conflict` / `skipped`）。

**audit 席位不自动结算**（引擎 `auto.settle.skipped` 的 `audit-explicit-settle-required`）⇒ **必须由 Leader 显式 `member_status(review)` → `member_settle(merged|conflict)`**，否则**批会永久挂在 `running`**。⇒ 省掉这一步 = **批收不了口**。

**批相位**仍由 **`batch_phase`** 推进（`complete` 须先经 `running`）；**lane 终态与批相位是两本账，各管各的**（见本节开头的分工铁律）。

---

## 八、完成判据（DoD）

- **产物落盘**（批次产物根，**不落工作区根**）；
- **每条结论有原始读数**（可复核）；
- **交接已 `submitted`**（下游 `handoff_view` 报 `READY`）；
- **验收标准逐条对照**（audit 出 verdict）；
- **素材许可登记齐备**（BGM / 字体 / 图像 / 配音四类，逐项给来源与许可）；
- **宿主冒烟已跑**：产出运行于宿主/消费路径时，完成判据必含一次**真实加载/启动冒烟**（语法的 `node --check`、单测**不算**完成）—— 先搭会失败的版本（RED）再做到通过（GREEN），**禁攒批到终验**；
- ⚠ **导出不属团队工序**（见 §一 裁定 C）。

---

## 九、Leader 收口

1. **发现完成**（worker 完成**不推送**给 Leader 之外的观察面）：① `batch_status`（lane 跃迁）② `log_export`（`swarm.report` / `member.settled` / `lane.handoff` / `auto.settle.*` 的 `reason`）③ 产物根 glob；
2. **成员管理** ⇒ 见 §七（**官方工具**，**不是 `member_*`**）；
3. **批终态**：`batch_phase(complete)`（**须先经 `running`**）。
