# video-team 工作流蓝图（蟛蜞模式）

> 说明：**Manager 为引擎层角色（Leader 直属、团队无关）**，**不属本团队角色集**——本团队满配 **7 席**。Manager 是任务第一对接点：**exec 层 lane 数≥3 的三层批** running 后、**首个 exec lane 派发前**强制拉起并 `batch_phase` **登记**；`managerPlan` **缺省 `raise`**，**需 Leader 直驱时必须在建批 `assembly` 显式声明 `managerPlan:'leader-direct'`**（显式出口，缺省不是直驱）。
> 粗拆由 Leader 人工对接；`coordinator` 按触发装配（exec 层 lane 数≥3 或需细拆产物时 plan 层建 role=coordinator lane）。

## 一、角色 DAG（谁产出 → 谁消费 → 谁验证）

```mermaid
graph TD
    L[Leader 组织层]
    MA[Manager 引擎层角色 · 团队无关]
    subgraph 任务层🎯（本团队 2 角色）
        CO[coordinator]
        DE[designer]
    end
    subgraph 执行层⚡（本团队 4 角色）
        PR[producer池]
        CA[captioner池]
        MO[motion-designer池]
        AU[audio-engineer池]
    end
    subgraph 审计层🛡️（本团队 1 角色）
        SV[supervisor]
    end
    L -->|人工对接 + 决策包| CO
    L -->|派活 send_message| PR
    CO -->|场次摸底 + 写域矩阵| DE
    DE -->|场次规格 + 单场任务包| L
    L -->|lane 任务| CA
    L -->|lane 任务| MO
    L -->|lane 任务| AU
    PR -->|场次产物| SV
    CA -->|字幕产物| SV
    MO -->|动效产物| SV
    AU -->|音频产物| SV
    SV -->|acceptance-report + gap-list.json + 复盘归档| L
```

> **节点归属（D-1 口径）**：DAG 中 `L`（Leader）与 `MA`（Manager）为**引擎/组织层节点**，**不属本团队角色集**——`MA` 由引擎包定义（Leader 直属、团队无关）；**任务层 / 执行层 / 审计层三个 subgraph 内的 7 个节点才是本团队角色**（2 + 4 + 1 = 7）。
> 「**池**」：**仅 Agent-team 方案使用**；「池」是**声明面**（可多实例并行），引擎无校验，**不承载分配语义**——席位不足时须**登记复用**，不得把「池」当成已存在的席位。

## 二、核心流转（10 步）

| 步骤 | 动作 | 角色 | 产出物（产物类型） |
|:----|------|------|------|
| ① | 开启任务 + 人工粗拆（grill 质询 + 细节对接） | Leader | `leader-decision-pack.md` + 场次清单（plan/） |
| ② | 场次摸底（约束 / 依赖与风险 / 写域矩阵） | Coordinator | `plan/<name>-recon.md`（plan/） |
| ③ | 逐线出包（场次规格 + 单场任务包，**按 `spec-writing` 写**） | Designer | `plan/<name>-spec.md` + `plan/<name>-taskpack-<n>.md`（plan/） |
| ④ | 派活（**唯一真推送 = `send_message`**） | Leader | 成员任务包（首行含角色取件） |
| ⑤ | 场次实现（**`exec-work` 步 · 四角色同 wave 并行、deps 为空 ⇒ 互不依赖**） | producer / captioner / motion-designer / audio-engineer | 场次产物（exec/）+ `exec/<name>-<面>.md` |
| ⑥ | 入边交接（上游 `handoff_submit` ⇒ 下游 `handoff_view` 报 `READY` 才开工） | 上游 lane | 交接入边（`batch.handoffs`） |
| ⑦ | 成片验收（**逐条核对 + 独立复现，不得只转述上游**） | Supervisor | `audit/acceptance-report.md` + `audit/final-acceptance.md`（audit/） |
| ⑧ | gap-list 对账（**唯一产出者 = supervisor**） | Supervisor | `audit/gap-list.json`（audit/） |
| ⑨ | 复盘归档（记忆沉淀 + 产物归档；**本团队无归档专席 ⇒ 归 supervisor**） | Supervisor | `audit/retrospective-report.md` + `success-pattern-seeds.md` 种子（audit/） |
| ⑩ | 反馈循环 | Leader | 复盘结论 → 下一场次 / 下一批 |

> 注（**exec 形态**）：⑤ 四个执行角色的 **deps 均为空 ⇒ 互不依赖**，其 consume 指向 **plan 产物**（任务包），**不待彼此的产物完成**——这保证「并行」是**真并行**而非串行伪装。
> 注（**审计时点**）：任一 exec lane `merged` 后**立即**为其开 audit 面，**不等**同批其他 lane 收口；**单 lane 验收**与**跨 lane 聚合对账**分属两层职责，后者不得成为前者延期的理由。
> 注（**本团队不设专职测试席**）：exec 层各角色的产物**由 `supervisor` 独立复现**（其验收标准本就含「独立复现、不得只转述上游」）⇒ 跑测试不另设 exec 席。

### 两段式 wave 示例

```
wave1: [plan-出包：coordinator 摸底 → designer 逐线出包]
wave2: [exec-work：producer ∥ captioner ∥ motion-designer ∥ audio-engineer]   ← 同 wave 并行（deps 均为空）
wave3: [audit：supervisor 逐条对账 + 独立复现 + gap-list + 复盘归档]
```

## 三、产物契约表（对应 wave_plan 的 layer/consume/produce）

| 层 | 产物（相对批次产物根） | 消费方 |
|---|---|---|
| plan 🎯 | `leader-decision-pack.md`、`<name>-recon.md`、`<name>-spec.md`、`<name>-taskpack-<n>.md` | exec（consume 任务包） |
| exec ⚡ | 场次产物（`exec/<lane>/...`：画面 / 字幕 / 动效 / 音频）+ `exec/<name>-<面>.md` | audit（consume 产物） |
| audit 🛡️ | `acceptance-report.md`、`final-acceptance.md`、`gap-list.json`、`retrospective-report.md` | 记忆沉淀（`dsh-mneme` 优先） |

> 引擎只校验**存在性** + Plan 契约结构底线（任务包必含 `## 验收标准` / `## 约束`）；三层的目录前缀（`plan/`、`exec/`、`audit/`）即 wave_plan 的 layer 路径契约。

### 模板 ↔ 产物映射表（6 模板逐一指名引用）

| 模板（`references/templates/`） | 产出物 | 产物类型 | layer / 目录 | 产出角色 | consume 归属 |
|---|---|---|---|---|---|
| `scene-spec-template.md` | `<name>-spec.md`（场次规格） | spec（执行规范） | plan/ | designer（出包） | exec 四角色（实现依据） |
| `storyboard-template.md` | 场次分镜（spec 的「分镜」章节 / 独立分镜产物） | spec 内部章节 | plan/ 或 exec/ | designer 预填骨架、producer 填满 | producer（实现依据） |
| `final-acceptance-template.md` | `final-acceptance.md`（成片验收对账面） | acceptance | audit/ | supervisor | Leader（门禁裁决） |
| `gap-list.json` | `gap-list.json`（未闭合项数据） | gapList | audit/ | supervisor（**唯一产出者**） | Leader（门禁裁决） |
| `leader-decision-pack.md` | `leader-decision-pack.md`（待裁决项六要素） | plan（任务层产物） | plan/ | Leader（人工对接 + grill 后） | coordinator / 用户（裁决输入） |
| `success-pattern-seeds.md` | 记忆种子（`dsh-mneme`，`type=history` / `decision`） | retrospective | audit/ | supervisor（复盘归档，**非文件产物**） | 后续批次检索复用 |

> **`gap-list.json` 的两点填写口径**（防两个常见误用）：
> 1. **顶层键 = `batchId` + `items[]`**（**不是**两个顶层数组）；每项 = `{id, desc, blocking, owner, evidence}`。
> 2. **`blocking` 是「条目标注」而非顶层分区**：**仅**「不满足即无法判定某条验收标准」记 `blocking: true`，**其余一律 `false`**（非阻断的观察项 / 下批项同样进 `items[]`，只是 `blocking: false`）。
> 3. **`evidence` 必填**：给路径或可直接粘贴执行的命令；**无证据的怀疑项不算载体**（中间笔记、口头待办不算）。

## 四、硬化判定点 ↔ 三层门禁

| 硬化判定点 | 三层门禁（引擎强制） |
|---|---|
| dp1 分配判定（ready→空闲实例） | **Entry Gate**（consume 齐备才派发）+ `assign_check`（A/B/C/D 档）；exec 层 lane 需 consume 齐备 |
| dp2 完成确认（产物完整性） | **Exit Gate**（outputs/produce 落盘才 merged）；exec 层产物可含独立行 `gate: <命令>`（行首锚定）⇒ merged 前置确定性执行、exit 0 通过 |
| dp3 审查路由（通过 / 返工） | `review` 状态 + `member_settle`；audit 层产物可含独立行 `needHuman: true` ⇒ merged 须带 `human:<裁决人>:<时间>:<结论>` 证据 |
| dp4 验收判定（gap-list 对账） | **Complete Gate**（audit 验收完成才 `complete`）；**audit 席位不自动结算 ⇒ 必须显式 `member_settle`**，否则批永久挂 `running` |

> **本域的硬化项补充**（video 特有，落在 dp2/dp4）：
> - **帧级自查**：帧内元素的遮盖 / 层级 / 错位须逐帧可判；**采样密度必须写明**（**计数不可跨采样密度比较**，判据主体是相交对的**身份集合**而非总数）。
> - **气口处置**：按**呼吸组**识别、**整组压缩**；**判据未成立时只报不裁**，并产出**逐组**人工审核包。
> - **素材许可登记**：DoD 必含项——每个素材有一行许可（自产 / 授权 / 公有领域 / 生成式产出）；**未确权的素材不得进入交付**。
> - **⭐ 导出不属团队工序**：`导出` 在成片之后，**不得**作为验收项、**不得**作为完成判据。

## 五、职责分工要点

| 角色 | 层 | 干什么（要点） |
|---|---|---|
| `coordinator` | plan 🎯 | 场次摸底（约束清单 / 依赖与风险 / 写域矩阵）；**不产出任务包** |
| `designer` | plan 🎯 | 逐线出包：场次规格 + 单场任务包（**任务包是唯一验收单元**） |
| `producer` | exec ⚡ | 场次画面实现（帧级自查、素材许可登记） |
| `captioner` | exec ⚡ | 字幕清单 + **气口普查表** + 可疑段标注（**逐组留痕**） |
| `motion-designer` | exec ⚡ | 动效清单（触发 / 时长 / 缓动）+ 复现命令 + 原始回显 |
| `audio-engineer` | exec ⚡ | 音频清单 + **素材许可登记表** + 合成命令与原始回显 |
| `supervisor` | audit 🛡️ | 全量验收 + 独立复现 + gap-list 对账 + **归档（记忆沉淀 + 产物归档）**；**只读不改码** |

### 三条通道（**不可互替**）

| 通道 | 用途 | 铁律 |
|---|---|---|
| `handoff_submit` | **交接面**（上游 → 下游） | 下游 `handoff_view` 报 `READY` 才开工；缺交接下游拒 `GATE_HANDOFF_MISSING` |
| `swarm_report` | **审计面**（成员 → Leader，留痕） | **必须带 `batchId`**；报 `unbound` 属预期 |
| `send_message` | **唤醒面**（唯一真推送） | 只发前者 ⇒ 留痕不唤醒；只发后者 ⇒ 唤醒不留痕 ⇒ **成员回报 = 双写** |

### 管理面分工铁律

**官方工具管「人」｜引擎 `member_*` 管「lane」，两本账并列不互替**：管理面（`list_agents` / `send_message` / `interrupt_agent` / `wait_agent` / `spawn_teammate`）操作**席位**；`member_status` / `member_settle` 操作 **lane 账本**；批相位走 `batch_phase`（**须先经 `running`**）。三者不可互替。
