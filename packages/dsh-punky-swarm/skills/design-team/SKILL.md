---
name: design-team
description: |
  设计团队指引（团队层 skill，与 software-team 平级）：3 层 4 角色
  （plan `design-planner` / exec `workflow-builder`·`producer` / audit
  `workflow-auditor`）的职责与产物契约 + 设计侧能力层装配 —— 执行侧能力
  指向 `comfyui-use`（技能加载名 = frontmatter `name`；部署目录名保持
  `Comfyui-use`）的 Layer A（自研配方驱动：配方 → 参数槽 → 板1 comfy_*
  工具序列 → 质检 → 审计回执），Layer A 正文与 recipes/ 全树已迁入
  references/comfyui/。
  角色 → 技能的装配数据**唯一来源**是 `presets/design-team/team-asset.yml`，
  本技能只声明指针、不复制装配数据；生产走**新批次**（`producer` lane 必须
  consume audit 产物，审核通过才开产）。
  当需要确定设计团队某角色"是谁/能做什么/不能做什么/成功标准/输出格式"，
  或需要按配方驱动链路产出设计产物/图像底图时加载本技能。
version: "1.1.0"
kind: skill
triggers:
  - "设计团队"
  - "设计角色"
  - "设计团队装配表"
  - "ComfyUI 配方"
  - "海报底图配方"
  - "设计任务派发"
  - "工作流搭建"
  - "工作流审核"
  - "设计生产批次"
---

# design-team — 设计团队指引（三层 4 角色 × 产物契约）

> roles 为子目录 `references/roles/`；三层产物契约沿用引擎既有 `plan/` `exec/` `audit/` 目录约定；行为层（hardening/rail / 治理工具）由 dsh-punky-swarm 承担。

## 装配数据唯一来源（先读这一条）

- **装配数据（角色 × 层 × 技能 × flows）唯一来源 = `presets/design-team/team-asset.yml`**；本技能**不复制**装配数据，只给指针。
- 引擎建批时按该资产的 `layers[*].roles` / `layers[*].skills` 注入角色前缀与技能前缀；本文件的层级职责表用于**人读与角色选型**（装配面见「三层职责与产物契约」一节）。
- 修改装配（增删角色、调整某角色的技能集、改 flows 口径）**只改资产文件**；本文件的角色名/产物路径必须与资产保持可对账（角色集合相等、产物路径一致）。
- 口径对照：本技能与 `skills/software-team/SKILL.md` §装配资产（team-asset）说明与用途同类 —— 「团队技能说的是**怎么用**，资产说的是**怎么装**」（该章节由已退役的独立装配说明技能并入，落点即此）。

## 团队定位

本技能是**团队层指引**，与软件工程团队 `software-team` 平级：二者共享引擎通用治理语义（persona 纪律 0–10、三层门禁 Tier3、Manager 通用定义见 `presets/punky-preset/references/manager.md`），差异只在**团队自身的角色编制、粒度口径与能力层装配**。

| 项 | 设计团队（本技能） | 软件工程团队（`software-team`） |
|---|---|---|
| 层数编制 | **3 层 4 角色**（plan 1 / exec 2 / audit 1） | 3 层 7 角色 + 引擎层 Manager |
| 角色 | `design-planner` / `workflow-builder` / `producer` / `workflow-auditor` | coordinator / designer / coder / tester / reviewer / supervisor / doc-manager + 引擎层 Manager |
| 粒度口径 | 配方与契约粒度（配方卡 / 参数槽 schema / 交付契约） | API 粒度（细拆为接口级任务） |
| 能力层 | ComfyUI **Layer A** 配方驱动（`references/comfyui/`） | dev-* / review* / doc* 操作手册映射 |
| 产物契约 | 沿用 `plan/` `exec/` `audit/`（**不新增产物类型**） | 同左 |
| 生产 | **另开新批次**派 `producer`（须 consume audit 产物） | 同批内 exec 层直接续跑 |

## 角色概览（三层 4 角色）

| 层 | 角色 | 职责 | 关键产物 |
|----|------|------|-----------|
| plan 🎯 | `design-planner` | 评估需求 → 研判风格 → 设计 ComfyUI 使用资产（模型/配方/LoRA/参数档、商用许可红线、可用性前提） | `plan/plan-designer-spec.md`（含 `## 验收标准` / `## 约束`）＋ `plan/task-tree.json` |
| exec ⚡ | `workflow-builder` | 搭建 ComfyUI 工作流 + **初步冒烟** | `exec/workflow.json` ＋ `exec/smoke-report.md` |
| exec ⚡ | `producer` | 实跑生产（**新批次**派发，consume audit 产物） | `exec/production/*` ＋ `exec/production-report.md` |
| audit 🛡️ | `workflow-auditor` | 审核工作流：工具使用是否合理、实操是否符合设计目的（只读不改） | `audit/workflow-review.md` ＋ `audit/gap-list.json` |

> 与基础计划角色（`coordinator` / `designer`）的关系：本团队 **plan 层牵头 = `design-planner`**（由资产声明、引擎认可），细拆由 plan 层 lane 自履；`coordinator` / `designer` 属引擎基础角色，仅作 lane 层选型备选（其定义见 `references/roles/coordinator.md`、`references/roles/designer.md`）。角色是否被本团队认可**以资产为准**，本文件不复述其声明内容。

## 三层职责与产物契约

### plan 🎯 — `design-planner`

- **职责**：读需求与约束 → 研判风格/用途 → 产出**设计规格与用资产**：模型档、配方选择（`poster-sdxl-base` / `controlnet-guide`）、LoRA、参数档（11 槽或 19 槽默认值）、商用许可红线核对、可用性前提（服务/ckpt/节点在册）。
- **产物**：`plan/plan-designer-spec.md`（**必含独立裸标题行** `## 验收标准` 与 `## 约束`，任何编号变体如 `## 5. 验收标准` 会被 `GATE_PLAN_CONTRACT` 拒）＋ `plan/task-tree.json`。
- **权限边界**：只出规格与判据；**不实跑**生成、**不搭工作流**（属 exec）；不得改引擎门禁。

### exec ⚡ — `workflow-builder`

- **职责**：按 `plan/plan-designer-spec.md` 把设计规格**搭成可执行的 ComfyUI 工作流**并做**初步冒烟**（RED→GREEN 中间 checkpoint，禁攒批到终验）：
  1. 先 `comfy_probe`（服务就绪 / ckpt 在册 / 队列不积压）→ 拒绝在不可达时盲跑；
  2. 再 `comfy_object_info`（全量）校验参数槽与模型是否在册（防 422）；
  3. 然后 `comfy_run` **小样冒烟**（小尺寸/少步数先跑通）→ 冒烟通过再按规格档位出样；
  4. 冒烟证据（prompt_id / seed / 参数快照 / 失败与修复轨迹）落 `exec/smoke-report.md`，**失败记录保留**、重提必得新 prompt_id。
- **产物**：`exec/workflow.json`（workflow 模板 + 槽位 schema/注入说明）＋ `exec/smoke-report.md`（冒烟记录与质检回执）。
- **权限边界**：不自定设计目的与验收标准（读 `plan/plan-designer-spec.md`）；不引用未经 plan 许可的模型/LoRA（商用许可红线见 §Layer A A5）；不下载模型。

### audit 🛡️ — `workflow-auditor`

- **职责**：**审核工作流**：① 工具使用是否合理（探测/槽校验/提交/取图/记账链路齐备，参数档与配方契约一致）；② 实操是否符合**设计目的**（逐条对照 `plan/plan-designer-spec.md` 的风格、资产、验收标准）。**只读不改**，缺陷走报告不自行修复。
- **产物**：`audit/workflow-review.md`（结构化 verdict：approve / reject + blocking issues + followups，逐条对账验收标准）＋ `audit/gap-list.json`（未闭合项与 followups；本层是 gap-list 的唯一产出者）。
- **权限边界**：不改 `exec/` 产物、不改 plan 规格；不足则要求补证，不代替 exec 返工。
- **人工闸**：若存在需人工裁决项，产物以**独立行**声明 `needHuman: true`，`merged` 时须携带裁决证据契约 `human:<裁决人>:<时间>:<结论>`（audit 层 `needhuman: true` 口径）。

### exec（**新批次**）⚡ — `producer`

- **职责**：在**新批次**内经被指派档位**实跑生产**（按审核通过的工作流与规格批量出成品/中间素材，逐笔记账）。
- **进料**：其 lane 必须声明 `consume: ["audit/workflow-review.md","audit/gap-list.json"]`（路径相对批次产物根）。
- **产物**：`exec/production/*`（成品与中间素材，按 lane 独占目录）＋ `exec/production-report.md`（逐笔记账汇总：prompt_id / runLabel / seed / 参数快照 / 产物路径）。
- **权限边界**：不改工作流契约与设计规格（要改回搭建批）；不下载模型。

## 生产口径：团队搭资产，**生产由 Leader 在交接后执行**（2026-09-18 用户裁决）

| 阶段 | 谁做 | 形态 |
|---|---|---|
| **搭建批**（团队） | plan `design-planner` → exec `exec-build`（lane `exec-workflow-builder`）→ audit `audit-pair`（lane `audit-exec-workflow-builder`）→ `accept` | 链步**不含生产**；收口判据 = audit verdict approve + `gap-list.json` 无 blocking |
| **交接** | 团队 → Leader | 走 `handoff_submit`（交付件 = 工作流资产 + audit 结论） |
| **生产（跑资产）** | **Leader** | 交接后**在后台执行**——**不占团队链步、不派 lane**；`producer` 仍保留在资产 `layers.exec.roles`（能力声明与技能映射），但**不是链步** |

- 链形态固定为 `plan → exec-build → audit-pair → accept`（**生产步已从链中移除**）；`pair_with: "exec-build"` ⇒ audit 恰 **1 条**配对 lane。
- 「**审核通过才开产**」仍是**硬要求**：团队链先收口（audit verdict approve），Leader 才接手跑资产；缺 audit 结论不进入生产。
- 该口径与 writing-team 一致（其「发布」同样改为 Leader 执行）——**两家都把最后交付动作移出团队链**。

## 能力层：ComfyUI Layer A（迁入副本）

设计团队的执行侧能力指向朋友技能 `comfyui-use` 的 **Layer A（自研配方驱动层）**。按 Q-5B「整段迁入」字面要求，Layer A 正文与 `recipes/` 全树已**复制**（非引用）进本技能：

| 项 | 落点 |
|---|---|
| Layer A 正文（A1–A5） | 本文件 §Layer A（迁入副本） |
| `recipes/` 全树（穷尽复制，逐文件哈希与源一致） | `references/comfyui/recipes/` |

- **迁入源（只读）**：宿主技能目录下的 `Comfyui-use`（技能加载名 `comfyui-use`）的 `SKILL.md` §Layer A + `recipes/` 全树。
- **Layer B 不迁**：`expert/`（上游 MCKRUZ/ComfyUI-Expert 子树，含自有 `.git`）**不搬移、不复制**，只写引用指针 —— 权威路由为宿主技能目录下 `Comfyui-use/expert/SKILL.md`（见该文件及 `Comfyui-use/SKILL.md` §双层总览）。

### Layer A 迁入副本的「变更时双改」纪律（强制）

> **变更时双改**：Layer A 正文或 `recipes/` 内容在任一侧发生变更，**必须在同一批次内同步另一侧**，并在回执中标注「双改」与两侧哈希/差异证据；未双改视为该 lane 未完成。
>
> - 两侧指：① 源侧 = 宿主技能目录下的 `Comfyui-use/`（`SKILL.md` §Layer A + `recipes/`）；② 副本侧 = `skills/design-team/`（`SKILL.md` §Layer A + `references/comfyui/recipes/`）。
> - 双向都成立：源侧变更 → 同步副本；副本侧变更 → 同步源侧（并同步 `Comfyui-use\SKILL.md` 顶层指针注记中的文件清单与快照日期）。
> - 漂移控制手段 = 指针注记（源侧顶层标注副本存在）+ 本条双改纪律 + audit 逐文件哈希对照；**禁止**只改一侧后以「另一侧是引用」为由跳过同步（本技能采用复制口径，不存在被引用的单一副本）。

## 三层产物契约（沿用引擎既有目录，不新增产物类型）

| 层 | 产物落点 | 设计团队适用产物 |
|---|---|---|
| plan 🎯 | `plan/` | `plan/plan-designer-spec.md`（含 `## 验收标准` / `## 约束`）、`plan/task-tree.json`、设计侧细拆、参数槽规格、被消费方契约摸底（`survey/<target>-contract.md`） |
| exec ⚡ | `exec/<lane>/` | `exec/workflow.json`、`exec/smoke-report.md`、`exec/production/*`、`exec/production-report.md`、`runs.json` 记账、质检回执、步骤级进度快照 `<lane>/progress/NN-<slug>.md` |
| audit 🛡️ | `audit/` | `audit/workflow-review.md`、`audit/gap-list.json`（验收结论与未闭合项） |

- **角色声明以资产为准**：本团队 4 个角色（`design-planner` / `workflow-builder` / `producer` / `workflow-auditor`）的可派发性由 `presets/design-team/team-asset.yml` 声明；另可声明引擎基础角色（`coordinator` / `designer` 用作计划角色，`reviewer` / `supervisor` 用作审核角色）。**本文件不复述声明的字段内容**。
- **不新增产物类型**：产物目录只用既有 `plan/` `exec/` `audit/` 前缀。
- **禁止**产出名为 `spec.md` 的 plan 产物：Plan Contract 门禁对任何 `spec.md` 强制软件工程体裁的两章（`## 验收标准` / `## 约束`），设计团队以**其他命名**承载设计规格（`design-spec.md` / `<配方>-contract.md`），**不改引擎门禁**。
- `exec/` 下产物按 lane 独占目录书写；`references/comfyui/recipes/` 为**只读**参考树，实机产物不写回该树。

## 使用方式

1. **查装配**：读 `presets/design-team/team-asset.yml`（角色 / 层 / 技能 / flows 的唯一真源）。
2. **查角色**：读本文件「三层职责与产物契约」；基础角色另有 `references/roles/<role>.md`（Persona / 职责与产出 / 权限边界 / 协作方式）。
3. **查能力层**：读本文件 §Layer A（迁入副本）与 `references/comfyui/recipes/<配方>/*.md` 配方卡。
4. **建批**：Leader/Manager 按资产装配面派 lane —— plan 层 `design-planner`、exec 层 `workflow-builder`、audit 层 `workflow-auditor`；生产另开批次派 `producer` 并 `consume` 两个 audit 产物。角色边界要点内联进 `task.cmd`。
5. **纪律**：引擎通用治理纪律见 persona（纪律 0–10）；本团队差异仅「粒度口径 = 配方/契约粒度」与「生产另开新批次」两条。

## 边界

- 本技能**不含**操作流程手册本体（用 spec-writing / interaction-design-principles / acceptance-gate / review-execution 等能力层）与运行时调度（用 dsh-punky-swarm 工具）。
- 本技能**不复制**装配数据（角色×层×技能×flows），唯一真源 = `presets/design-team/team-asset.yml`。
- 本技能**不承载** Manager 通用定义（落点 `presets/punky-preset/references/manager.md`）。
- 本技能**不复制** Layer B（`expert/`）任何文件，只写引用指针。
- 角色职责与产物契约以本文件「三层职责与产物契约」为准；装配生效以资产文件为准。

---

## Layer A（迁入副本）— 自研配方驱动（板1 comfy_* 工具 + recipes/）

> **本节为迁入副本**：正文复制自宿主技能目录下 `Comfyui-use/SKILL.md` §Layer A（源文件快照哈希随发布说明维护），源侧已加指针注记；两侧受「变更时双改」纪律约束（见上文）。
> 副本内相对路径按副本根解析：`recipes/...` = `references/comfyui/recipes/...`。

### A1 前置条件（不满足即停并上报，不盲目重试）

1. 板1 `comfy_*` 4 工具在册可调（`comfy_probe` / `comfy_object_info` / `comfy_run` / `comfy_fetch_output`）。
2. ComfyUI 运行于 `127.0.0.1:8188`（本地绑定；本技能只绑 127.0.0.1）。
3. ckpt `sd_xl_base_1.0.safetensors` 已就位（`comfy_probe`/`comfy_object_info` 核对命中）；未就位 → 拒绝执行并上报，**不触发下载**。

### A2 工具面映射表

| 工具 | 用途（一句话） | 关键参数 | 使用时机 | 返回要点 |
|---|---|---|---|---|
| `comfy_probe` | 服务健康与能力探测（提交前门禁） | host?/port?（缺省走配置 127.0.0.1:8188） | 每次生图链第一步：确认服务就绪、ckpt ∈ 清单、队列不积压 | ready / comfyVersion / device / ckpts / queueLength |
| `comfy_object_info` | 节点/模型定义查询（参数槽校验数据源） | classType?（空=全量；TTL 60s 缓存） | 参数决策后提交前：核对 ckpt_name/sampler_name/scheduler ∈ 选项（防 422） | inputs 槽 schema / models 选项清单 |
| `comfy_run` | 注入参数提交 workflow 并同步等待（核心） | workflow（template: poster-sdxl-base 或内联 json）+ 参数槽 + timeoutMs? | 探测+校验通过后：注入槽 → POST /prompt（**不传客户端 prompt_id**，服务端返回 UUID；seed 写定）→ 轮询 /history 至终态；runs.json 记 runLabel | prompt_id（服务端 UUID） / status / durationMs / images[] |
| `comfy_fetch_output` | 按 prompt_id/文件名取图归位 + runs.json 记账 | promptId? 或 filename?/subfolder?/type?；targetDir? | comfy_run 返回 success 后立即取图归位（默认走配置 outputDir） | files[{absPath,size}] / ledger 摘要 |

### A3 配方表

| 配方 | 定位 | workflow 模板 | 参数槽 | 默认档 | 产出定位 |
|---|---|---|---|---|---|
| `poster-sdxl-base` | SDXL 1.0 base txt2img（7 内建节点，零第三方节点） | `recipes/poster-sdxl-base/poster-sdxl-base.workflow.json`（与板1 `comfy_run` 内建 template 同构） | 11 槽：ckpt_name/seed/positive/negative/width/height/steps/cfg/sampler_name/scheduler/filename_prefix（schema：`recipes/poster-sdxl-base/poster-sdxl-base.schema.json`） | 竖版 1024×1536、steps 24、cfg 6.5、euler/normal、ckpt sd_xl_base_1.0 | 底图向（主体+留白；文字走文字图层（路径一）/ 可分离为 `path` 矢量层（路径二）） |
| `controlnet-guide` | SDXL 1.0 + ControlNet 构图引导（参考图结构/边缘引导重绘；cn_enabled=false 回落纯 poster） | `recipes/controlnet-guide/controlnet-guide.workflow.json`（12 节点：poster 7 + CN 5；经板1 `comfy_run` `{json:{...}}` 内联提交，cn_* 占位由调用侧替换注入） | 11 槽（同 poster）+ 8 cn_* 槽：cn_enabled/cn_ref_image/cn_type/cn_model/cn_preprocessor/cn_strength/cn_start_percent/cn_end_percent（schema：`recipes/controlnet-guide/controlnet-guide.schema.json`） | cn_enabled=false 默认回落 poster；true 时 cn_type=canny/lineart/anime_lineart/mlsd、cn_model=diffusion_pytorch_model_promax.safetensors、cn_preprocessor=Canny、cn_strength 0.7、cn_start 0.0、cn_end 1.0 | 构图/结构参考引导底图（参考图结构 + 文案重绘；文字走文字图层（路径一）/ 可分离为 `path` 矢量层（路径二）） |

配方卡（用途/调参/质检/回执模板/使用示例）：`recipes/poster-sdxl-base/poster-sdxl-base.md`（poster）、`recipes/controlnet-guide/controlnet-guide.md`（controlnet-guide）。扩展：后续 LoRA 等配方按同表补行（workflow 模板 + schema + 配方卡三件同构）。

### A4 流程层（选配方 → 参数决策 → 探测 → 槽校验 → 提交等待 → 取图归位 → 质检 → 审计回执）

1. **选配方**：生图诉求 → 配方表命中 `poster-sdxl-base`（海报/底图向默认）；构图/结构参考引导走 `controlnet-guide`。
2. **参数决策**：按 11 槽决策（positive/negative 按起草策略先定可命名主体/前景 → 构图与层次 → 环境光效 → 风格克制；尺寸按 8 GB 档约束：1024 起步、竖版 1536 默认、方形 1024 可覆盖）。拒绝裸 base+抽象背景词堆叠（已知病态：粉红抽象渐变堆叠）。
3. **探测**：`comfy_probe`（服务就绪 + ckpt 在册 + 队列不积压；不可达即停、上报 ready:false，不盲目重试）。
4. **槽校验**：`comfy_object_info`（**全量**，防单类校验集残缺误报）核对 ckpt_name/sampler_name/scheduler ∈ 选项（防 422）。
5. **提交等待**：`comfy_run`（workflow 按配方形态——poster 走 `{template:"poster-sdxl-base"}` + 槽注入；controlnet-guide 走占位符全量替换后 `{json:{...}}` 内联提交，见其配方卡 §5-§6；记账（可选）：设 env `COMFYUI_RUN_PREFIX=<批次>-<lane>` 即得批次化 runLabel=<批次>-<lane>-<NNNN>；**不设则默认前缀 `comfyui-glue`** + 全局序列号（`client.js:112-114`）（runs.json 记录）；**prompt_id 由服务端生成 UUID**（ComfyUI≥0.34 拒非 UUID 客户端 prompt_id，客户端不传）；`filename_prefix` 派生 = `<COMFYUI_RUN_PREFIX>_seed<N>`；seed 显式写定）。
6. **取图归位**：`comfy_fetch_output`（promptId 回传 → 下载落 targetDir + runs.json upsert 记账：prompt_id/seed/参数槽快照/ts/status/durationMs/files）。
7. **质检**：Q1–Q5（poster）或 Q-CN1..4（controlnet-guide）逐项过；不过 → 回步骤 2/4 调文案/参数、seed 挑样重跑，**重提必须用新 prompt_id**（旧记录保留）。
8. **审计回执**：按配方卡模板落盘（三件套齐备），随产物归档。

**质检清单 Q1–Q5（fail 即回炉）**：Q1 主体明确（可命名主体/前景，非纯抽象渐变/无意义色块堆叠）；Q2 构图可辨（主次/位置/留白可辨，非整幅同质纹理；海报底图向时主体区留有版式余地）；Q3 负面强化（negative 覆盖 text/watermark/low quality/blurry/deformed/extra limbs 基线 + 按需扩展）；Q4 文字留白（图内不交 SDXL 画文字，文字由**文字图层**承载、出图区留白；旧称「CSS 版式层」已作废，见 A5 双路径口径）；Q5 seed 挑样（同参数 ≥2 seed 挑样 1 作为交付，挑样证据入 evidence，写定种子供复跑）。

**审计回执模板**（controlnet-guide 另含 cn_* 8 槽 = 19 槽快照，见其配方卡 §9）：`prompt_id`（服务端 UUID，单查 /history 一致）/ `runLabel`（<COMFYUI_RUN_PREFIX>-<job>，治理批关联键）/ `seed`（写定值）/ `模板: <配方>@<版本>`（workflow JSON 随产物归档）/ `ckpt: sd_xl_base_1.0.safetensors` / `参数快照: 槽 JSON（同 runs.json params）` / `复跑: 同 seed + 模板 + ckpt 重提应复现`。

### A5 红线（Layer A 约束层，不可谈判，逐条遵守）

- **商用许可档**：仅可用「可商用档」模型与素材。FLUX-dev 系衍生（非商用许可）与 NovelAI 系（专有/禁入）一律禁入，不得作为 ckpt 或素材来源（与 Layer B 选型同口径，见合并口径 R1）。
- **不下载模型**：模型档仅 `sd_xl_base_1.0.safetensors`（已就位并经 object_info 核对命中）及配方卡在册依赖；任何动作不得触网下载模型/任何大文件；未就位即拒绝执行并上报，不触发下载。
- **A1111 冻结**：本机 A1111 安装目录（不入包、不入库）不修改、不启动、不共享资产；板1 `comfyui-glue` 代码不改。
- **只写知识不写执行**：本技能/SKILL.md/recipes 不内嵌 HTTP 客户端逻辑；执行全部委托板1 `comfy_*` 工具。
- **只绑 127.0.0.1**：ComfyUI 访问仅限本地 `127.0.0.1:8188`（缺省走配置），不指向远端实例。
- **双路径文字承载**（替代 2026-09-13【已作废】的「文字走 CSS 层」）：两条交付路径均**不把文字交给 SDXL**（Q4 不变，出图区留白）。
  - **路径一「一步渲染」**：文字由**文字图层**（`text` 层，版式 JSON）承载；不产出独立矢量 / 栅格素材，素材不单列。
  - **路径二「素材分离」**：**矢量类素材（图标 / 框 / 字形 / 文字）以 SVG 输出**（落 `path` 层矢量路径）；**底图保持 PNG**，不转格式；栅格类中间素材为 RGBA PNG。
- **路径二素材归属规则（P-1…P-6，逐条判据见 `plan/recycle-spec.md` §2.2）**：
  - **P-1**：判定「矢量类」的唯一依据是**素材的几何性质**、不是来源——字形 / 图标 / 框 / 线 → SVG；照片向 / 纹理向 / 连续色调 → PNG。
  - **P-2**：字形与文字在路径二下**必须**落 `path` 层（SVG `d` 矢量路径）；**禁止**把字形渲成 PNG 当 `image` 层（栅格化兜底）。
  - **P-3**：**底图在两条路径下均为 PNG**（`mode ∈ {RGB,RGBA}`、尺寸 == canvas）；路径二**不**把底图转 SVG。
  - **P-4**：路径一（及路径二 `text` 层）的字体族**必须**命中字体白名单；发布物**不内嵌**字体文件。
  - **P-5**：路径二把文字转为矢量路径**不豁免许可留痕**——`path` 层仍须带 `glyphSetSrc` 溯源，glyph-set 仍须落许可字段（`licenseClass` / `licenseName` / `licenseURL`）。
  - **P-6**：两条路径**共用同一 layout 契约**（`image` / `rect` / `text` / `path` 混排，`LAYER_TYPES` 为唯一事实源）；差异只在「哪些层被物化成交付物」。

- **字体白名单（硬口径，非商用一律排除）**：权威清单 = `plan/font-whitelist.md`。
  - **Tier A（本机已验证，可立即消费）**：`Noto Sans SC`、`Noto Serif SC`、`HarmonyOS Sans SC`（后者**内嵌许可文本为空**，不得作为发布路径的唯一字体）。
  - **Tier B（常用可商用，本机无文件 → 落地前须下载并复验内嵌许可）**：`LXGW WenKai`、`Alibaba PuHuiTi`(+2.0/3.0)、`Source Han Serif`、`MiSans`、`Smiley Sans`。
  - **Tier C（非商用 / 系统受限，一律禁用、硬拦）**：`Microsoft YaHei`、`SimSun`/`NSimSun`、`SimHei`、`KaiTi`/`FangSong`、以及任何无官方许可页 / 无内嵌许可的「免费下载站」字体。
  - **字面量口径**：`fontFamily` 一律使用字体**内嵌英文族名**（`nameID 1`），不使用中文别名——否则 Node canvas 会静默回落默认字面量 `sans-serif`（`lib/render.js:35`，实测）。

- **门禁脚本模板（v2 版本集 / 双守门口径，提法同步）**：layout 门禁脚本以 **v2 模板**为准——
  - **版本集** `ACCEPTED_VERSIONS=("0.2","0.3")`（append-only，`0.1` 不入集）、`PATH_LAYER_MIN_VERSION="0.3"`（`path` 层自 0.3 起）、`path` 层 z 带 `[10,19]`；`schemaVersion` 不在版本集即拒。
  - **双守门**：**G-α 版本门**（版本集 + `path` 层与版本相容 + z 带，check `pathlayers`/`schema`）与 **G-β 指纹门**（非 `path` 层指纹逐字不变）并用；两门域正交 —— G-α 查版本相容、G-β 查非 path 层是否被偷改。换族/重排一致性另有 **G-β′ 字体掩蔽指纹门**（掩蔽 `fontFamily`）。
  - **基线禁止自比**：两条指纹门只比**常量基线**；禁止 `ensure_baseline()` 式「先以当前 layout 覆写基线再与刚写的基线比较」口径（恒真 = 空门）。
  - **模板命名**：`gate-check.py`（v2 实现，幂等、本地、零网络）；只在技能库内**提法同步**，不内嵌脚本实现（实现归宿主/门禁 lane）。

- **不 push、不重启宿主**：git 改动只本地 commit 不 push；不重启/重载 dsh web 宿主进程。
- **审计可复跑**：每次 job 记账齐备（prompt_id=服务端 UUID / runLabel / seed / 参数快照 / ts / status / files），seed 写定、旧失败记录保留、重提必得新 UUID。

## 三层门禁（Tier3 · 引擎强制）

| 门 | 触发点 | 拒绝码 |
|---|---|---|
| Plan 契约 | plan lane merged 前：产物含**独立裸标题行** `## 验收标准` / `## 约束` | `GATE_PLAN_CONTRACT` |
| Entry | exec/audit lane 派发前：`consume` 齐备且逐个在场；DAG 入边须已 `handoff_submit` | `GATE_ENTRY_MISSING` / `GATE_HANDOFF_MISSING` |
| Exit | merged 前：`produce ∪ outputs` 在场（以 `/` 结尾者按**目录**判：存在且非空） | `GATE_ARTIFACT_MISSING` / `GATE_ARTIFACT_NOT_A_FILE` |
| Targets | lane 声明 `targets` 时逐一核落盘（存在性 + 变更性） | `GATE_TARGET_MISSING` / `GATE_TARGET_UNCHANGED` |
| 命令 gate | exec 产物独立行 `gate: <命令>` ⇒ merged 前执行，exit 0 通过 | `GATE_EXIT_*` |
| 人工闸 | audit 产物独立行 `needHuman: true` ⇒ merged 须带 `human:<裁决人>:<时间>:<结论>` | `GATE_NEEDHUMAN_PENDING` |
| 终态冻结 | 批次终态（`complete`/`aborted`）后任何成员态迁移一律拒 | `GATE_BATCH_TERMINAL` |

## 蟛蜞治理集成（worker 视角）

- **lane id 纪律**：须逐字等于资产 `branches[].id`，否则链推进落 `no-lane-for-step`。
- **交接顺序**：产出后**先 `handoff_submit`、再发 `settle-request`**（顺序反了 auto-settle 判 `GATE_HANDOFF_MISSING` 并使批暂停）。
- **exec ↔ plan 依赖（**三道门**）**：**exec 分支之间无 `deps`**（可高并发并行、lane 数不限），但**每个 exec lane 必须消费 plan 产物**——由引擎在建批期强制：`flows.exec.consumes_required_per_lane: ["plan/"]`（**逐 lane**，任一 exec lane 缺该前缀 ⇒ 拒建批 `GATE_EXEC_INPUT_MISSING`）＋ `flows.exec.consumes_required: ["plan/"]`（**批级**覆盖）；另 `GATE_ORPHAN_PRODUCT` 保证 plan 产物不被孤儿化（plan 层硬拒），entry 门 `GATE_ENTRY_MISSING` 保证声明的 consume **逐个在场**后才派发。⇒ **exec 形态自由（无 deps），但与 plan 的依赖是硬门禁**；lane 间真实依赖由建批 `tasks[].deps` 声明。
- **通信**：`mailbox_send`（inbox/outbox/broadcast）只写元数据；`swarm_report` 回 Leader、`swarm_cc` 抄送 Manager。
- **进度**：每完成一子步骤落 `<lane>/progress/NN-<slug>.md`（**lane 域**，勿落层域）。
- **止轮与收口**：需止住自动推进用 `batch_control(pause)`（非终态、可逆）；**先了结成员态（`member_settle`）→ 再迁相位到终态**（写成员态属 C 档动作）。
