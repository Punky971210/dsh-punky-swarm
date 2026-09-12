# poster-sdxl-base 配方卡（SDXL 1.0 base · txt2img · 海报/底图向）

- 配方：`poster-sdxl-base` ｜ 配套：`poster-sdxl-base.workflow.json`（7 节点 API-format 模板）+ `poster-sdxl-base.schema.json`（11 参数槽）
- 消费方：板1 `comfy_run`（`workflow:{template:"poster-sdxl-base"}` 内建同构，或经 11 槽注入后等价内联提交）；exec-verify 实机 A/B 以此为 B 侧配方
- 权威副本：本批资产 `exec/recipe/`（本目录）；技能包镜像 `~/.agents/skills/Comfyui-use/recipes/poster-sdxl-base/`（内容一致）

## 1. 用途

海报底图/图像生成向 SDXL 基础配方：SDXL 1.0 base 单模型、7 内建节点（零第三方 custom_nodes）、11 参数槽直控。产出定位 = **底图向**：主体可命名 + 构图留白（顶部/侧边留出标题文字区），图内不画文字，文字由 CSS 版式层承载（Q4）。

## 2. 默认档（schema 契约基线；实机数据可校正推荐范围，不回写槽名/类型）

| 槽 | 类型 | 默认 | 推荐范围 |
|---|---|---|---|
| ckpt_name | string | `sd_xl_base_1.0.safetensors` | 固定（object_info 核对命中） |
| seed | integer | -1（runner 生成写定） | 任意整数 |
| positive | string | 起草文案（见 §4） | 主体明确+构图优先 |
| negative | string | 强化负面清单 | 基线+按需扩展 |
| width | integer | 1024 | 1024–1344 |
| height | integer | 1536 | 1024–1536 |
| steps | integer | 24 | 20–40 |
| cfg | number | 6.5 | 5.0–8.0 |
| sampler_name | string | euler | ∈ object_info options |
| scheduler | string | normal | normal / karras |
| filename_prefix | string | 派生（见 §5） | 显式覆盖合法 |

尺寸档：**竖版海报档 1024×1536（默认）**；**方版 1024×1024** 经 width=1024,height=1024 覆盖；均 1024 起步，>1344 有 8 GB 显存风险。

## 3. 节点骨架与注入点映射

7 节点链：`CheckpointLoaderSimple`(1) → `CLIPTextEncode`×2(2,3) → `EmptyLatentImage`(4) → `KSampler`(5, denoise 恒 1.0) → `VAEDecode`(6) → `SaveImage`(7)；节点 id 与连线同 BOD1 §9（API-format）。

注入点映射（schema 槽名 → workflow 注入位置）：

| 槽 | workflow 注入位置 |
|---|---|
| ckpt_name | node "1".inputs.ckpt_name |
| positive / negative | node "2" / "3".inputs.text |
| width / height | node "4".inputs.width / height（batch_size 恒 1） |
| seed / steps / cfg / sampler_name / scheduler | node "5".inputs.* |
| filename_prefix | node "7".inputs.filename_prefix |

workflow JSON 以 `<槽名>` / `<槽名: 默认>` 标记注入点（与 BOD1 §9 骨架同构）：未标记默认的槽（positive/negative/seed/filename_prefix）提交前**必须**由 comfy_run 槽注入写定；带默认的槽未显式传参时用模板默认（= §2 默认档）。

## 4. positive/negative 默认文案（A5 教训驱动）

- **板2 默认 positive**（起草策略：主体→构图层次→光效→风格克制，自证非裸基底）：
  `a white ceramic coffee cup with saucer on a light oak wooden table, soft diffused window light from the left, warm off-white minimalist background wall, centered composition with clean negative space above for a title area, subtle shadow under the cup, professional advertising still-life photography, crisp details`
- **默认 negative**（强化清单）：`text, watermark, low quality, blurry, deformed, extra limbs, jpeg artifacts, oversaturated`
- A/B 对照（exec-verify A 侧复现专用，**非板2 默认**）：A5 基线 positive = `clean minimalist poster background, soft gradient studio lighting, subtle geometric shapes, professional advertising composition`（全抽象背景词无主体 → A5 实测粉红抽象堆叠）。

## 5. 使用示例（COMFYUI_RUN_PREFIX 记账）

```text
进程 env 注入：COMFYUI_RUN_PREFIX=ai-paint-board2-exec-verify     # = <批次>-<lane>（runLabel 前缀）
comfy_run:
  workflow: { template: "poster-sdxl-base" }
  11 槽注入（positive/negative 用 §4 默认文案或按需起草；seed 显式写定）
→ POST /prompt 不传客户端 prompt_id；服务端生成 UUID 返回（ComfyUI≥0.34 拒非 UUID）
→ filename_prefix 派生 = ai-paint-board2-exec-verify_seed2026090801（runLabel 前缀）
→ comfy_fetch_output(promptId=<服务端 UUID>, targetDir=<归位目录>)
   → 取图落盘 + runs.json upsert（prompt_id=服务端 UUID / runLabel=<前缀>-<job> / seed / 11 槽参数快照 / ts / status / durationMs / files）
```

纪律：每次提交服务端必发新 UUID（旧记录保留）；seed 每次显式写定并记 runs.json，供审计复跑；`runLabel`（=<COMFYUI_RUN_PREFIX>-<job>）为治理批关联键。

## 6. 质检清单 Q1-Q5（每轮产出逐项核对，fail 即回炉重跑）

| # | 检查项 | 判据（fail 即回炉） |
|---|---|---|
| Q1 | 主体明确 | 产出含可命名主体/前景元素，非纯抽象渐变/无意义色块堆叠 |
| Q2 | 构图可辨 | 主次/位置/留白可辨，非整幅同质纹理；底图向时主体区留有版式余地 |
| Q3 | 负面强化 | negative 覆盖 text/watermark/low quality/blurry/deformed/extra limbs 基线 + 按需扩展 |
| Q4 | 文字留白 | 图内不交 SDXL 画文字（中文尤其）；文字由 CSS 版式层承载，出图区留白 |
| Q5 | seed 挑样 | 同参数 ≥2 seed 挑样 1 交付（挑样证据入 ab-evidence；写定种子供复跑） |

## 7. 审计回执模板（填好后随产物归档）

```text
- prompt_id: <服务端 UUID>                    # 单查 /history/{prompt_id} 应一致（POST /prompt 响应返回）
- runLabel: <COMFYUI_RUN_PREFIX>-<job>          # runs.json 治理批关联键
- seed: <写定值>                             # 审计复跑三件套之一
- 模板: poster-sdxl-base@<版本>              # workflow JSON 随产物归档（三件套之二）
- ckpt: sd_xl_base_1.0.safetensors           # 三件套之三
- 参数快照: 11 槽 JSON（同 runs.json params）
- 复跑: 同 seed + 模板 + ckpt 重提应复现
```

示例（占位示意）：`prompt_id: <服务端 UUID，如 0cf78432-…>`；`runLabel: ai-paint-board2-exec-verify-0001`；`seed: 2026090801`；`模板: poster-sdxl-base@1.0.0`；`ckpt: sd_xl_base_1.0.safetensors`；参数快照 = 11 槽 JSON 全量；复跑判据：同 seed+模板+ckpt 重提，产物一致。

## 8. 调参建议（SDXL 1.0 / 8 GB 档）

- 主体不清晰/过抽象 → 回 §4 起草策略重写 positive（先定主体，再构图/光效），勿只堆风格词。
- 出现文字/水印/糊 → 先验 negative 基线覆盖 + 检查是否误把文字需求交给 SDXL（应走 CSS 层，Q4）。
- 构图失衡/主体溢出 → 调 width/height 档（方版↔竖版海报）或改 positive 中位置/留白词。
- 步数/CFG 微调：steps 20–40、cfg 5.0–8.0 区间试；每次仅动 1 个变量并保持 seed 写定对照。
- 显存紧张（>1344 或 8 GB 边缘）→ 回落 1024² 档；<1024 不入推荐（A5 实测基线 1024 起步）。
