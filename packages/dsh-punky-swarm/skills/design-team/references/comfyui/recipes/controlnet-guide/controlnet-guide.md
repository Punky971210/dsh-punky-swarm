# controlnet-guide 配方卡（SDXL 1.0 base + ControlNet 构图引导 · 参考图→结构引导重绘）

- 配方：`controlnet-guide` ｜ 配套：`controlnet-guide.workflow.json`（12 节点 API-format 模板 = poster 7 + CN 5）+ `controlnet-guide.schema.json`（11 poster 槽 + 8 cn_* 槽 = 19 参数槽）
- 消费方：板1 `comfy_run`（`workflow:{json:{...}}` 内联提交形态；cn_* 槽由调用侧按本卡替换注入，见 §5 L-gap）；实机基线：ai-paint-cntest exec（896×1152 直出 success，CN 链 39.9s）
- 权威副本：本批资产 `exec/recipe/`（本目录）；技能包镜像 `~/.agents/skills/Comfyui-use/recipes/controlnet-guide/`（内容一致）
- 素材来源：cg-reference（ai-paint-cg-research/exec）40 参考条目；数值性建议均标「社区参考，非权威」，权威档 = 实机 A/B 校正（cntest 已实跑档位行内注明）

## 1. 用途

**构图/结构参考引导生图**：用一张参考图（构图/边缘/线稿/姿态/深度）经 ControlNet 约束 SDXL 1.0 base 的采样过程，产出「保留参考图构图结构、内容按提示词语义重绘」的海报底图。典型场景（cg-reference §0）：

- 参考图构图保持 → 文案重绘（Img2Img+CN 约束构图，保留原图结构、风格更自由）；
- 主体位置/边缘走向/画面分区约束 → 海报底图向排版留白仍由 CSS 层承载；
- 8GB 档：单 CN、fp16、≤1024 基准（cntest 实测 896×1152 首跑即成功，39.9s/张）。

**双分支/条件用法**：`cn_enabled=false` → 纯 poster-sdxl-base txt2img 链（节点 1–7，等价既有 poster 配方，零回归）；`cn_enabled=true` → 12 节点 CN 构图引导链。schema 兼容性关键：默认 false，老调用不变。

## 2. 默认档（schema 契约基线；实机数据可校正推荐范围，不回写槽名/类型）

poster 11 槽默认档同 `poster-sdxl-base`（width 1024 / height 1536 / steps 24 / cfg 6.5 / euler / normal / ckpt sd_xl_base_1.0.safetensors）。cn_* 8 槽：

| 槽 | 类型 | 默认 | 说明 |
|---|---|---|---|
| cn_enabled | boolean | false | CN 门；true=CN 构图引导链 |
| cn_ref_image | string | 必填（enabled） | 参考图文件名（input 目录相对名，LoadImage node 8） |
| cn_type | string | `canny/lineart/anime_lineart/mlsd` | union 实测 combo 值（语义 canny；0.34 无裸 canny 值勿直传） |
| cn_model | string | `diffusion_pytorch_model_promax.safetensors` | 实测在册 union promax 文件名 |
| cn_preprocessor | string | `Canny` | 内置 Detect Edges (Canny)，class_type=Canny，免 aux |
| cn_strength | number | 0.7 | 0.5–0.9 社区参考，非权威；0.7 为 cntest 实跑值 |
| cn_start_percent | number | 0.0 | 生效起始步段 |
| cn_end_percent | number | 1.0 | 生效结束步段；构图保型可试 <1 |

8GB 尺寸注意：CN 链下 SDXL+CN 先验 <1024² 起手（cntest 896×1152 直出，未触发降档）；纯 poster（cn_enabled=false）仍可 1024×1536。

## 3. 链结构与注入点映射（12 节点 API-format）

poster 7 节点（沿用 poster-sdxl-base 骨架，node id 1–7 一致）：`CheckpointLoaderSimple`(1) → `CLIPTextEncode`×2(2,3) → `EmptyLatentImage`(4) → `KSampler`(5) → `VAEDecode`(6) → `SaveImage`(7)。

CN 5 节点（并入采样链，KSampler positive/negative 改接 ApplyAdvanced 输出）：

| node | class_type | 关键注入 | 说明 |
|---|---|---|---|
| 8 | LoadImage | image=`<cn_ref_image>` | 参考图（input 文件名） |
| 9 | Canny（内置） | low_threshold=0.3 / high_threshold=0.7（模板常量，勿注入） | 提示图预处理器（cn_preprocessor 默认 Canny；阈值可改链微调） |
| 10 | ControlNetLoader | control_net_name=`<cn_model>`（**实测 input 名，非 ckpt_name**） | 载入 models/controlnet/ 模型 |
| 11 | SetUnionControlNetType | type=`<cn_type>`（**字符串 combo，实测值**） | union 模型必设类型 |
| 12 | ControlNetApplyAdvanced | strength=`<cn_strength>` / start_percent=`<cn_start_percent>` / end_percent=`<cn_end_percent>`；positive←[2,0]、negative←[3,0]、control_net←[11,0]、image←[9,0]、vae←[1,2] | 约束注入；KSampler(5) positive=[12,0]、negative=[12,1] |

workflow JSON 以 `<槽名>` / `<槽名: 默认>` 标记注入点（同 poster 约定）。11 poster 槽由 comfy_run 槽注入写定；cn_* 槽由调用侧替换注入（§5）。

## 4. 链变体（官方单类型 / aux 预处理器 / 关闭 CN）

| 变体 | 条件 | 改链动作 |
|---|---|---|
| 纯 poster | cn_enabled=false | 提交节点 1–7 子图（等价 poster-sdxl-base 模板；KSampler positive/negative 接 [2,0]/[3,0]） |
| union promax（默认） | cn_model=promax | 节点 10→11→12 完整链（本模板即此形态） |
| 官方单类型 | cn_model=canny/depth fp16 | 删除节点 11（SetUnionControlNetType）→ 节点 12.control_net 直连 [10,0]（模型自带类型；cn_type 槽忽略） |
| aux 预处理器 | cn_preprocessor=aux 类名 | 节点 9 class_type 换 aux 在册类（如 CannyEdgePreprocessor/DepthAnythingV2Preprocessor/OpenposePreprocessor），并按该类输入契约改接线/参数（进阶，先 object_info 实测该类输入 schema） |

## 5. L-gap 结论（板1 内联 json 支持，2026-09-09 exec-author 只读核对）

板1 comfyui-glue `lib/client.js` + `lib/index.js` 实测结论（只读，未改板1 代码）：

1. **`comfy_run` 支持 `workflow:{json:{...}}` 内联整图提交**：client.js `buildInjectedGraph` 非 template 分支克隆 `workflow.json` 为提交图（BAD_WORKFLOW 校验对象形态）；README/工具表明示 `{template:'poster-sdxl-base'}` 或 `{json:{...}}` 二选一 → **本配方可经 json 内联跑新链，无需板1 注册扩展**。
2. **11 槽注入语义对 json 内联同样生效**：`injectSlots` 按 class_type 泛化注入 ckpt_name/width/height/seed/steps/cfg/sampler_name/scheduler/filename_prefix，CLIPTextEncode 按节点 id 升序取前两节点分派 positive/negative（本模板节点 2=positive、3=negative，id 顺序保证语义正确）；json 内联模式 args 全量进 resolved（含任意键）但注入仍按 class_type 映射 → **poster 11 槽照常注入**。
3. **cn_* 8 槽无板1 泛化注入**（CLASS_SLOT_KEYS 不含 CN 节点类）→ 调用侧负责：提交前把模板内 cn_* 占位符按 schema 值替换为实际值（如 `<cn_model: ...>` → 实测文件名、`<cn_strength: 0.7>` → 0.7），再以 `workflow:{json: <替换后图>}` 提交。11 槽可继续走槽注入（或同法替换）。**推荐调用形态：占位符全量替换后 json 内联提交**。
4. 参考图取用：LoadImage 消费 input 目录文件名；上传走 ComfyUI `/upload/image`（multipart，返回 {name, subfolder:'', type:'input'}）落 input 后再引用（cntest 已按此取用 m1_s1.png）；板1 4 工具无上传面 → 参考图先由调用侧上传/放置 input 再提交。

## 6. 调用序列（cn_enabled=true 时）

1. **选图**：参考图（构图/边缘清晰的竖版或方版素材；尺寸方向与目标 width/height 一致为宜）。
2. **上传/放置**：经 ComfyUI `/upload/image` 上传（返回 name 记作 cn_ref_image）或确认文件名已入 input 目录。
3. **前置核对**（object_info 只读）：`ControlNetLoader` 在册且 `control_net_name` 含所选 cn_model；`Canny` 在册（内置）；cn_type ∈ union combo 实测值；ckpt/sampler/scheduler ∈ 选项（沿用 poster 纪律）。
4. **占位替换 + 注入**：按 schema 替换模板内 cn_* 占位符（cn_ref_image/cn_model/cn_type/cn_strength/cn_start_percent/cn_end_percent；cn_preprocessor 默认 Canny 不变即不改链）；positive/negative/seed 等 11 槽经 comfy_run 槽注入（seed 显式写定，-1 由实现随机写定）。
5. **提交等待**：`comfy_run(workflow:{json: <替换后 12 节点图>}, <11 槽>)` → POST /prompt 不传客户端 prompt_id（服务端生成 UUID）→ 轮询 /history 终态；记账 runs.json（prompt_id=服务端 UUID / runLabel=<COMFYUI_RUN_PREFIX>-<job> / seed / 19 槽参数快照）。
6. **取图归位**：`comfy_fetch_output(promptId=<服务端 UUID>)` 落 targetDir + runs.json upsert。
7. **质检**：Q-CN1..4 逐项过；不过回步骤 4 调（先改 positive/文案或 strength/end，再试阈值/参考图；每次动 1 变量、seed 写定对照），重提必得新 UUID。
8. **审计回执**：按 §8 模板落盘归档。

## 7. 调参经验（引 cg-reference；数值标社区参考非权威，权威档=实机 A/B）

| # | 经验点 | 表述 |
|---|---|---|
| E1 | Canny 阈值语义 | 阈值控边缘密度：低阈值→更多细边。内置 Detect Edges (Canny)（kornia，0-1 归一域，默认 0.4/0.8）；cntest 实跑 0.3/0.7 出图成功。与 WebUI/社区 0-255 域口径不同，勿混用。数值社区参考，实机 A/B 校正。 |
| E2 | strength/denoise | 板2 链 denoise 恒 1.0 → CN 是唯一结构源，strength 主导约束强弱（构图参考要结构不要原图纹理 → CN-only 正合）；denoise<1 需另配 img2img 复合链（非本配方默认）。 |
| E3 | 何时 end<1 | 结构只在前期需要（构图定型后放开材质/光照/细节）或 CN 过约束产生伪影时，提前 end（如 0.7–0.85）收尾；需全程强结构（锁构图/边缘）用 end=1。数值社区参考非权威。 |
| E4 | 过强症状与降档 | 过约束症状：边缘线复制僵硬/伪影/色彩断层 → 降 cn_strength 或降 Canny 阈值或 end<1，三旋钮按症状选；无效果优先查：模型放错目录 / union 未 SetType / 提示图为空/黑。 |
| E5 | 8GB 档 | 单 CN、fp16 模型、batch=1；尺寸 ≤1024 基准（cntest 896×1152 直出 39.9s）；显存置换频繁时速度下降属预期；>1024×1152 慎用。 |
| E6 | 素材边界 | 模型/aux/annotator 权重均为「用户手动下载」项；本配方只出下载指引不执行下载。 |
| E7 | 伪字抑制与留白 | CN 构图引导底图仍可能产出 SDXL 伪字/乱码文字（冒烟实测）→ positive 避免文字类词（标题/文案词勿入描述），negative 强化 text/letters/typography/words 等；确需图内文字时构图留白，统一交 wb 文字层覆盖；伪字已现 → 降 cn_strength 或换 seed 重试（每次动 1 变量、seed 写定对照）。 |

## 8. 质检清单 Q-CN1..4（每轮产出逐项核对，fail 即回炉）

| # | 检查项 | 判据（fail 即回炉） |
|---|---|---|
| Q-CN1 | 构图遵循 | 产出主体位置/分区/边缘走向与参考图构图骨架一致（对照 cn_ref_image 与提示图）；非构图漂移/参考失效 |
| Q-CN2 | 主体-语义一致 | 产出主体与 positive 描述一致、非纯参考图复制（CN 引导结构、文案决定内容）；无边缘线僵硬复制伪影 |
| Q-CN3 | 画质基线 | 沿用 poster Q3/Q4：negative 覆盖 text/watermark/low quality/blurry/deformed/extra limbs；图内不画字（CSS 层）；无 CN 引入的带状/断层伪影 |
| Q-CN4 | seed 挑样 + 回执 | 同参数 ≥2 seed 挑样 1 交付（证据入 evidence，写定种子供复跑）；审计回执含 19 槽快照（11 poster + 8 cn_*） |

## 9. 审计回执模板（填好后随产物归档）

```text
- prompt_id: <服务端 UUID>                    # 单查 /history/{prompt_id} 应一致（POST /prompt 响应返回）
- runLabel: <COMFYUI_RUN_PREFIX>-<job>          # runs.json 治理批关联键
- seed: <写定值>                             # 审计复跑三件套之一
- 模板: controlnet-guide@<版本>               # workflow JSON 随产物归档（三件套之二）
- ckpt: sd_xl_base_1.0.safetensors           # 三件套之三
- cn_enabled: true|false                      # false=纯 poster（等价 poster-sdxl-base）
- cn_ref_image: <input 文件名>                # /upload/image 返回 name 或 input 现成文件
- cn_type: <union combo 实测值>               # 默认 canny/lineart/anime_lineart/mlsd
- cn_model: <实测文件名>                      # 默认 diffusion_pytorch_model_promax.safetensors
- cn_preprocessor: <class_type>               # 默认 Canny（内置）；aux 类名须在册
- cn_strength / cn_start_percent / cn_end_percent: <值>   # 默认 0.7 / 0.0 / 1.0
- 参数快照: 19 槽 JSON（11 poster + 8 cn_*，同 runs.json params）
- 复跑: 同 seed + 模板 + ckpt + cn_* 全槽重提应复现
```

示例（占位示意）：`prompt_id: <服务端 UUID，如 1cf01b5e-…>`；`runLabel: <批次>-<lane>-0001`；`seed: <写定值>`；`模板: controlnet-guide@1.0.0`；`cn_type: canny/lineart/anime_lineart/mlsd`；`cn_model: diffusion_pytorch_model_promax.safetensors`；`cn_strength: 0.7`；复跑判据：同 seed+模板+ckpt+cn_* 重提，产物一致。

## 10. 红线与边界（沿用 poster/板2 纪律）

- 不下载模型：cn_model/cn_preprocessor 依赖均须已在册（object_info 核对），未就位拒绝执行并上报，绝不触发下载。
- 商用许可档：仅可商用模型素材（union promax Apache-2.0；官方 canny/depth fp16 OpenRAIL++；A1111/FLUX-dev/NovelAI 系禁入）。
- 只写知识不写执行；不 push、不重启 dsh web；板1 comfyui-glue 代码不改（本卡 L-gap 已按「不改板1」给调用侧替换方案）。
