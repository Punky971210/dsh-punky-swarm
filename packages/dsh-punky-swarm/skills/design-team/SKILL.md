---
name: design-team
description: |
  设计团队指引（团队层 skill，与 software-team 平级）：plan 层角色
  coordinator / designer 定义（见 references/roles/）+ 三层产物契约
  （plan/ exec/ audit/）+ 设计侧能力层装配表 —— 执行侧能力指向
  Comfyui-use 的 Layer A（自研配方驱动：配方 → 参数槽 → 板1 comfy_*
  工具序列 → 质检 → 审计回执），Layer A 正文与 recipes/ 全树已迁入
  references/comfyui/。
  本轮只建 plan 层两角色，执行层留空（由 Leader 代劳填充设计任务）。
  当需要确定设计团队某角色"是谁/能做什么/不能做什么/成功标准/输出格式"，
  或需要按配方驱动链路产出设计产物/图像底图时加载本技能。
version: "1.0.0"
kind: skill
triggers:
  - "设计团队"
  - "设计角色"
  - "设计团队装配表"
  - "ComfyUI 配方"
  - "海报底图配方"
  - "设计任务派发"
---

# design-team — 设计团队指引（plan 层角色 × 装配）

> roles 为子目录 `references/roles/`；三层产物契约沿用引擎既有 `plan/` `exec/` `audit/` 目录约定；行为层（hardening/rail / 治理工具）由 dsh-punky-swarm 承担。
> 本轮（批次 `punky-engine-generalize-m1`）只建立 **plan 层两角色**（`coordinator` / `designer`）；**执行层留空**，见下文「执行层现状」。

## 团队定位

本技能是**团队层指引**，与软件工程团队 `software-team` 平级：二者共享引擎通用治理语义（persona 纪律 0–10、三层门禁 Tier3、Manager 通用定义见 `presets/jiufeng/references/manager.md`），差异只在**团队自身的角色编制、粒度口径与能力层装配**。

| 项 | 设计团队（本技能） | 软件工程团队（`software-team`） |
|---|---|---|
| 层数编制 | **本轮仅 plan 层**（2 角色） | 3 层 7 角色 + 引擎层 Manager |
| 角色 | `coordinator` / `designer` | coordinator / designer / coder / tester / reviewer / supervisor / doc-manager + 引擎层 Manager |
| 粒度口径 | 配方与契约粒度（配方卡 / 参数槽 schema / 交付契约） | API 粒度（细拆为接口级任务） |
| 能力层 | ComfyUI **Layer A** 配方驱动（`references/comfyui/`） | dev-* / review* / doc* 操作手册映射 |
| 产物契约 | 沿用 `plan/` `exec/` `audit/`（**不新增产物类型**） | 同左 |

## 角色概览（plan 层 2 角色）

| 层 | 角色 | 职责 | 能力层手册 | 可拓展性 |
|----|------|------|-----------|:--------:|
| 任务层 🎯 | Coordinator | 设计侧细拆（配方/契约粒度）+ 被消费方契约摸底 | dev-planner | 固定 |
| 任务层 🎯 | Designer | 设计产物（配方契约 / 参数槽规格 / 交付口径）含验收与约束章节 | spec-writing、design-an-interface | 固定 |

> **执行层 ⚡（本轮留空）**：Coder / Tester / Reviewer 等执行与审核角色**本轮不建**。执行层的设计任务（配方实机产出、图像底图生成、质检回执落盘）**本阶段由 Leader 代劳填充**，直至执行层角色与 audit 层角色按前瞻段补齐。

## 装配表（角色 → 操作手册 → 关键产出）

| 层 | 角色 | 操作手册（skill 工具加载） | 关键产出 |
|---|---|---|---|
| 任务层 | Coordinator | dev-planner | 设计侧细拆（配方/契约粒度任务清单）+ 被消费方契约摸底（`survey/<target>-contract.md`） |
| 任务层 | Designer | spec-writing + design-an-interface | 设计产物：配方契约 / 参数槽规格 / 交付口径（含验收标准与约束章节），落 `plan/` |
| 执行层 | （**本轮留空**，由 Leader 代劳） | 指向 `Comfyui-use` Layer A（配方驱动链路） | 配方实机产物 / 图像底图 / 质检回执，落 `exec/<lane>/` |
| 审计层 | （**本轮未建**，见前瞻段） | report-blind-audit + archive（届时按 C+ 装配规则声明） | 验收报告 / gap-list |

### 执行层现状与代劳声明

- 本阶段（本轮）**执行层角色槽为空**：无 Coder / Tester / Reviewer 角色定义，`references/roles/` 下只有 `coordinator.md` 与 `designer.md` 两个文件。
- 需要执行侧动作（配方实机产出、图像底图生成、质检与审计回执落盘）时，**本阶段由 Leader 代劳填充设计任务**：Leader 直接承担执行层职责并按 `references/comfyui/` 的配方链路执行，不另行派生执行角色定义。
- 执行侧能力层来自 **`Comfyui-use` 的 Layer A**（见下节「能力层：ComfyUI Layer A」），本团队不自建第二套配方驱动实现。

## 能力层：ComfyUI Layer A（迁入副本）

设计团队的执行侧能力指向朋友技能 `Comfyui-use` 的 **Layer A（自研配方驱动层）**。按 Q-5B「整段迁入」字面要求，Layer A 正文与 `recipes/` 全树已**复制**（非引用）进本技能：

| 项 | 落点 |
|---|---|
| Layer A 正文（A1–A5） | 本文件 §Layer A（迁入副本） |
| `recipes/` 全树（穷尽复制，逐文件哈希与源一致） | `references/comfyui/recipes/` |

- **迁入源（只读）**：`C:\Users\Administrator\.agents\skills\Comfyui-use\SKILL.md` §Layer A + `recipes/` 全树。
- **Layer B 不迁**：`expert/`（上游 MCKRUZ/ComfyUI-Expert 子树，含自有 `.git`）**不搬移、不复制**，只写引用指针 —— 权威路由 `C:\Users\Administrator\.agents\skills\Comfyui-use\expert\SKILL.md`（见该文件及 `Comfyui-use/SKILL.md` §双层总览）。

### Layer A 迁入副本的「变更时双改」纪律（强制）

> **变更时双改**：Layer A 正文或 `recipes/` 内容在任一侧发生变更，**必须在同一批次内同步另一侧**，并在回执中标注「双改」与两侧哈希/差异证据；未双改视为该 lane 未完成。
>
> - 两侧指：① 源侧 `C:\Users\Administrator\.agents\skills\Comfyui-use\`（`SKILL.md` §Layer A + `recipes/`）；② 副本侧 `packages/dsh-punky-swarm/skills/design-team/`（`SKILL.md` §Layer A + `references/comfyui/recipes/`）。
> - 双向都成立：源侧变更 → 同步副本；副本侧变更 → 同步源侧（并同步 `Comfyui-use\SKILL.md` 顶层指针注记中的文件清单与快照日期）。
> - 漂移控制手段 = 指针注记（源侧顶层标注副本存在）+ 本条双改纪律 + audit 逐文件哈希对照；**禁止**只改一侧后以「另一侧是引用」为由跳过同步（本技能采用复制口径，不存在被引用的单一副本）。

## 三层产物契约（沿用引擎既有目录，不新增产物类型）

| 层 | 产物落点 | 设计团队适用产物 |
|---|---|---|
| plan 🎯 | `plan/` | 设计侧细拆（task-tree）、配方契约、参数槽规格、被消费方契约摸底（`survey/<target>-contract.md`） |
| exec ⚡ | `exec/<lane>/` | 配方实机产物、图像底图、`runs.json` 记账、质检回执、步骤级进度快照 `exec/<lane>/progress.json` |
| audit 🛡️ | `audit/` | 验收报告、gap-list（本轮未建 audit 角色，见前瞻段） |

- **不新增引擎角色**：只用引擎既有白名单角色名（`coordinator` / `designer`，执行层阶段可声明既有 `reviewer` / `supervisor`）。
- **不新增产物类型**：产物目录只用既有 `plan/` `exec/` `audit/` 前缀。
- **禁止**产出名为 `spec.md` 的 plan 产物：Plan Contract 门禁对任何 `spec.md` 强制软件工程体裁的两章（`## 验收标准` / `## 约束`），设计团队以**其他命名**承载设计规格（如 `design-spec.md` / `<配方>-contract.md`），**不改引擎门禁**。
- `exec/` 下产物按 lane 独占目录书写；`references/comfyui/recipes/` 为**只读**参考树，实机产物不写回该树。

## 前瞻：进入执行层阶段后的批次（Q-C）

> 设计团队进入**执行层阶段**后的批次，按引擎**通用 C+ 装配规则**走：`exec` 层 lane ≥3 时须在 `wave_plan` 声明批次级装配 `assembly.managerPlan` 与 `assembly.auditLane`（Manager 已通用化，可直接按 `presets/jiufeng/references/manager.md` 拉起代管调度）；届时**必须同步补齐 audit 层角色**（可声明引擎既有 `reviewer` / `supervisor` 承接审核职能，audit 层承接团队声明的审核角色集为默认语义、默认单 audit 角色）。本阶段仅 plan 层、exec 层留空，C+ 张力尚不存在；进入执行层阶段时按上述规则一次性补齐角色与装配声明，不预留规避性裁剪。

## 使用方式

1. **查角色**：读 `references/roles/<role>.md`（Persona（注入用）/ 职责与产出 / 权限边界（注入用）/ 协作方式）。
2. **查能力层**：读本文件 §Layer A（迁入副本）与 `references/comfyui/recipes/<配方>/*.md` 配方卡。
3. **装配**：Leader 派发时按上方装配表加载对应能力层手册；角色边界要点内联进 `task.cmd`。
4. **纪律**：引擎通用治理纪律见 persona（纪律 0–10）；本团队差异仅「粒度口径 = 配方/契约粒度」与「执行层本轮留空、由 Leader 代劳」两条。

## 边界

- 本技能**不含**操作流程手册本体（用 dev-planner / spec-writing 等能力层）与运行时调度（用 dsh-punky-swarm 工具）。
- 本技能**不承载** Manager 通用定义（落点 `presets/jiufeng/references/manager.md`）。
- 本技能**不复制** Layer B（`expert/`）任何文件，只写引用指针。
- 角色语义以 `references/roles/<role>.md` 为准；执行层与 audit 层角色本轮不建，按前瞻段在进入执行层阶段时补齐。

---

## Layer A（迁入副本）— 自研配方驱动（板1 comfy_* 工具 + recipes/）

> **本节为迁入副本**：正文复制自 `C:\Users\Administrator\.agents\skills\Comfyui-use\SKILL.md` §Layer A（源文件快照 SHA256 见 `exec/design-team/changes.md`），源侧已加指针注记；两侧受「变更时双改」纪律约束（见上文）。
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
| `poster-sdxl-base` | SDXL 1.0 base txt2img（7 内建节点，零第三方节点） | `recipes/poster-sdxl-base/poster-sdxl-base.workflow.json`（与板1 `comfy_run` 内建 template 同构） | 11 槽：ckpt_name/seed/positive/negative/width/height/steps/cfg/sampler_name/scheduler/filename_prefix（schema：`recipes/poster-sdxl-base/poster-sdxl-base.schema.json`） | 竖版 1024×1536、steps 24、cfg 6.5、euler/normal、ckpt sd_xl_base_1.0 | 底图向（主体+留白；文字 CSS 层） |
| `controlnet-guide` | SDXL 1.0 + ControlNet 构图引导（参考图结构/边缘引导重绘；cn_enabled=false 回落纯 poster） | `recipes/controlnet-guide/controlnet-guide.workflow.json`（12 节点：poster 7 + CN 5；经板1 `comfy_run` `{json:{...}}` 内联提交，cn_* 占位由调用侧替换注入） | 11 槽（同 poster）+ 8 cn_* 槽：cn_enabled/cn_ref_image/cn_type/cn_model/cn_preprocessor/cn_strength/cn_start_percent/cn_end_percent（schema：`recipes/controlnet-guide/controlnet-guide.schema.json`） | cn_enabled=false 默认回落 poster；true 时 cn_type=canny/lineart/anime_lineart/mlsd、cn_model=diffusion_pytorch_model_promax.safetensors、cn_preprocessor=Canny、cn_strength 0.7、cn_start 0.0、cn_end 1.0 | 构图/结构参考引导底图（参考图结构 + 文案重绘；文字 CSS 层） |

配方卡（用途/调参/质检/回执模板/使用示例）：`recipes/poster-sdxl-base/poster-sdxl-base.md`（poster）、`recipes/controlnet-guide/controlnet-guide.md`（controlnet-guide）。扩展：后续 LoRA 等配方按同表补行（workflow 模板 + schema + 配方卡三件同构）。

### A4 流程层（选配方 → 参数决策 → 探测 → 槽校验 → 提交等待 → 取图归位 → 质检 → 审计回执）

1. **选配方**：生图诉求 → 配方表命中 `poster-sdxl-base`（海报/底图向默认）；构图/结构参考引导走 `controlnet-guide`。
2. **参数决策**：按 11 槽决策（positive/negative 按起草策略先定可命名主体/前景 → 构图与层次 → 环境光效 → 风格克制；尺寸按 8 GB 档约束：1024 起步、竖版 1536 默认、方形 1024 可覆盖）。拒绝裸 base+抽象背景词堆叠（已知病态：粉红抽象渐变堆叠）。
3. **探测**：`comfy_probe`（服务就绪 + ckpt 在册 + 队列不积压；不可达即停、上报 ready:false，不盲目重试）。
4. **槽校验**：`comfy_object_info`（**全量**，防单类校验集残缺误报）核对 ckpt_name/sampler_name/scheduler ∈ 选项（防 422）。
5. **提交等待**：`comfy_run`（workflow 按配方形态——poster 走 `{template:"poster-sdxl-base"}` + 槽注入；controlnet-guide 走占位符全量替换后 `{json:{...}}` 内联提交，见其配方卡 §5-§6；记账：进程 env `COMFYUI_RUN_PREFIX=<批次>-<lane>` 得 runLabel=<批次>-<lane>-<NNNN>（runs.json 记录）；**prompt_id 由服务端生成 UUID**（ComfyUI≥0.34 拒非 UUID 客户端 prompt_id，客户端不传）；`filename_prefix` 派生 = `<COMFYUI_RUN_PREFIX>_seed<N>`；seed 显式写定）。
6. **取图归位**：`comfy_fetch_output`（promptId 回传 → 下载落 targetDir + runs.json upsert 记账：prompt_id/seed/参数槽快照/ts/status/durationMs/files）。
7. **质检**：Q1–Q5（poster）或 Q-CN1..4（controlnet-guide）逐项过；不过 → 回步骤 2/4 调文案/参数、seed 挑样重跑，**重提必须用新 prompt_id**（旧记录保留）。
8. **审计回执**：按配方卡模板落盘（三件套齐备），随产物归档。

**质检清单 Q1–Q5（fail 即回炉）**：Q1 主体明确（可命名主体/前景，非纯抽象渐变/无意义色块堆叠）；Q2 构图可辨（主次/位置/留白可辨，非整幅同质纹理；海报底图向时主体区留有版式余地）；Q3 负面强化（negative 覆盖 text/watermark/low quality/blurry/deformed/extra limbs 基线 + 按需扩展）；Q4 文字留白（图内不交 SDXL 画文字，文字由 CSS 版式层承载、出图区留白）；Q5 seed 挑样（同参数 ≥2 seed 挑样 1 作为交付，挑样证据入 evidence，写定种子供复跑）。

**审计回执模板**（controlnet-guide 另含 cn_* 8 槽 = 19 槽快照，见其配方卡 §9）：`prompt_id`（服务端 UUID，单查 /history 一致）/ `runLabel`（<COMFYUI_RUN_PREFIX>-<job>，治理批关联键）/ `seed`（写定值）/ `模板: <配方>@<版本>`（workflow JSON 随产物归档）/ `ckpt: sd_xl_base_1.0.safetensors` / `参数快照: 槽 JSON（同 runs.json params）` / `复跑: 同 seed + 模板 + ckpt 重提应复现`。

### A5 红线（Layer A 约束层，不可谈判，逐条遵守）

- **商用许可档**：仅可用「可商用档」模型与素材。FLUX-dev 系衍生（非商用许可）与 NovelAI 系（专有/禁入）一律禁入，不得作为 ckpt 或素材来源（与 Layer B 选型同口径，见合并口径 R1）。
- **不下载模型**：模型档仅 `sd_xl_base_1.0.safetensors`（已就位并经 object_info 核对命中）及配方卡在册依赖；任何动作不得触网下载模型/任何大文件；未就位即拒绝执行并上报，不触发下载。
- **A1111 冻结**：`D:\stable-diffusion-webui`（A1111）不修改、不启动、不共享资产；板1 `comfyui-glue` 代码不改。
- **只写知识不写执行**：本技能/SKILL.md/recipes 不内嵌 HTTP 客户端逻辑；执行全部委托板1 `comfy_*` 工具。
- **只绑 127.0.0.1**：ComfyUI 访问仅限本地 `127.0.0.1:8188`（缺省走配置），不指向远端实例。
- **文字走 CSS 层**：图内不交 SDXL 画文字（Q4）；海报文字由版式层（CSS）承载，出图区留白。
- **不 push、不重启宿主**：git 改动只本地 commit 不 push；不重启/重载 dsh web 宿主进程。
- **审计可复跑**：每次 job 记账齐备（prompt_id=服务端 UUID / runLabel / seed / 参数快照 / ts / status / files），seed 写定、旧失败记录保留、重提必得新 UUID。
