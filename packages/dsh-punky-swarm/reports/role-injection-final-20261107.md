# role 注入：完整图景（2026-11-07 · 核实终版）

> 依据用户裁决：①`model_tier` 未裁决过，派发面模型选择由宿主管理、引擎只取功能接线，
> 若非宿主声明则撤销（系旧功能衍生的幻觉）；②`discipline_refs` 可加，但需核实纪律内容、
> 可能适当压缩、不全量注入；③继续摸底给完整图景。

## 一、注入面的真实结构（三层，只有第一层真正到达 worker）

### 第一层 · 任务包文本（**唯一真到达的通道**）

`composeWorkerPrompt` 渲染（`dispatch.js:861-1000`），实测段结构：

```
firstLine（C 档 = lane 句柄；D 档 = 空）
# 任务包（引擎自派 · <label>）          ← ⚠ 标题写死「引擎自派」，D 档取件时事实错误
- lane / 层 / 角色 | 目标(cmd) | 消费件 | 产出面 | 产物 | 批次产物根 | 批归属会话
## 你的职责 / ## 你被授权决定 / ## 交付要求   ← role 三段（含「规格：见技能」＋「达标提示」）
<archContext> <checkpoint 计划> <RESUME_CLAUSE>
## 开工前必做（preflight）
## 纪律（硬编码 6 条 + 层特化，与 role **无关**）
## 任务要点（Leader 补充）
```

**投递路径**：C 档引擎自派时自动生成；D 档由 `taskpack_for` 取件后作 `spawn_teammate` 的 prompt。

### 第二层 · 宿主请求载荷（**只有 C 档有**）

| 形态 | 载荷 | persona | model |
|---|---|---|---|
| `start(provider, request)` | `SubagentStartRequest`：`{label, prompt, parent, signal, toolFilter, persona?, maxDepth}` | ✅ 消费 | ❌ 无位 |
| `startActivation(spec)`（**本宿主形态**，`formOf` 新形态优先） | 更窄 | ❌ **不承载** | ❌ 无位 |

### 第三层 · 权限面（`toolFilter.deny`）

`SUITE_DENY_TOOLS` ∪ `deriveDenyTools(role.tools.allow)` —— **`tools.allow` 在这里被消费**，不进文本。

## 二、role 全部字段的最终定性

| 字段 | 消费状态 | 走哪条通道 | 处置 |
|---|---|---|---|
| `id` / `title` / `layer` / `mission` / `responsibilities` | ✅ | 任务包三段（`ROLE_MANDATORY_FIELDS` 必填） | 保持 |
| `authorities` / `deliverables(form + must_contain)` | ✅ | 任务包三段 | 保持 |
| `skills` | ✅ | 任务包「- 规格：见技能 …」 | 保持 |
| `acceptance_hints` | ✅ | 任务包「- 达标提示：…」 | 保持 |
| **`tools.allow`** | ✅ | **权限面**（`deriveDenyTools` 反推 deny） | 保持 |
| **`## Persona`** | ⚠️ 解析了但送不进 | C 档 `request.persona`（本宿主 `activation` 不消费） | **改进任务包文本** |
| **`model_tier`** | ❌ **零通道** | 无 | **撤销** |
| **`discipline_refs`** | ❌ | 应进 `## 纪律` 段 | **加（引用不内联）** |

## 三、`model_tier` 撤销：三重核实

**用户的判断成立** —— 它不是宿主的声明。

| 核实项 | 结果 |
|---|---|
| 宿主有无模型档位 | **无**。`desktop/cordis.patch.yml:126-130` 只有 `agent-default-model` 的单一 `model: deepseek-flash` |
| `worker` / `research` / `writing` 在本仓的真实语义 | `worker` = **执行型成员**（相对 Leader/Manager）；`research`/`writing` = **团队名**（`research-team`/`writing-team`）的截断 |
| 引擎是否消费 | **零消费**（`lib/**` 全仓零命中） |
| 有无测试断言 | **零命中**（`test/**`） |
| 是否必填 | 否（`ROLE_MANDATORY_FIELDS` = `id`/`title`/`layer`/`mission`/`responsibilities`） |

⇒ **撤销 = 23 个 role 文件各删一行，零风险、零连带改动。**

**但如果将来宿主提供 per-agent 模型选择**：引擎的正确做法是**只做接线**（从 role 读值 → 传给宿主），**不自造档位枚举**。用户原话：「派发面的模型选择由宿主管理，引擎只取功能接线」。

## 四、`discipline_refs` 的压缩方案（数据支撑）

### 全量不可行，压缩可以是零损失的

| 读数 | 值 |
|---|---|
| `discipline.md` 总行数 | **1097** |
| 章节数（`## §N`） | **32** |
| 最大单章 | **`§15` = 380 行** / `§0p` = 201 行（两章占一半） |
| 被 role 引用的 10 个引擎级章节合计 | **568 行**（`§15` 就占 380） |

### 引用频次（22 个 role 去重统计）

| 章节 | 被几个 role 引用 |
|---|---|
| **`§12`** audit 非盲审 | **7** |
| **`§0k`** audit 职责与收敛口径 | **6** |
| `§9` 消费方契约摸底先行 | 4 |
| `§0c` 职责分工 | 4 |
| `§14` 任务包预算与拆分 | 4 |
| `§15` 判据措辞/基线流程 | 2 |
| `§0e` / `§0i` | 各 2 |
| `§0d` / `§10` | 各 1 |
| `C-01`…`C-24`（video-team） | 1–2 各 |

### 压缩方案：**只给编号 + 标题，不给正文**

**为什么零损失**：worker 的 cwd 就是引擎仓，**能自己 `read presets/punky-preset/references/discipline.md`** 查对应 `## §N` 章节。内联正文反而会把任务包撑到 568 行。

**渲染形态**（`## 纪律` 段末尾加 2 行）：
```
N. **本 role 重点纪律**：`§12`（audit 非盲审）· `§0k`（audit 职责与收敛口径）· `§9`（消费方契约摸底先行）
   细则按需读取：`presets/punky-preset/references/discipline.md` 的对应 `## §N` 章节（**不内联**）
```

**必须做前缀分流**（两套编号层级）：
- `C-xx` ⇒ `skills/video-team/references/constitution.md`（团队宪章）
- 其它 ⇒ `presets/punky-preset/references/discipline.md`（引擎级）

## 五、待做的四件事（按依赖排序）

| # | 事项 | 依赖 | 影响面 |
|---|---|---|---|
| **①** | **撤销 `model_tier`**（23 个 role 文件各删一行） | 无 | 纯删除，零风险 |
| **②** | **`discipline_refs` 进 `## 纪律` 段**（编号+标题+分流） | ① | 改 `composeWorkerPrompt` ⇒ **C 档任务包字节变** |
| **③** | **`## Persona` 进任务包文本**（宿主送不进 persona 位，只能走文本） | ② | 同上 |
| **④** | **`taskpack_for` 通道标识**（标题参数化 + D 档首行标识） | 无 | 我上批的实现缺陷 |

**②③ 都会改 `composeWorkerPrompt` 的输出 ⇒ C 档任务包一起变**。两种做法：
- **甲**：无条件加（两档一致）⇒ 需同步改 `engine-dispatch.test.js` 的结构断言
- **乙**：加可选开关（`taskpack_for` 传 true、C 档不传）⇒ C 档零变化，但**两档任务包不一致**（隐患）

**建议甲** —— 两档任务包不一致本身就是隐患；且 `## Persona` 与纪律引用对 C 档成员同样有用。

## 六、不做（明确划界）

- **不给 `role_guide` 补任何键**（原方案甲作废 —— `taskpack_for` 已覆盖取件主路径）
- **不把 `toolFilter.deny` 写进 prompt**（权限面细节，worker 无需知道反推逻辑）
- **不把纪律正文内联**（568 行，会撑爆任务包）
- **不自造模型档位枚举**（宿主无此概念；将来只做接线）
- **不改 `renderRoleGuide`**（C 档三段字节冻结，除非走甲方案统一改）

## 七、未核实 / 待确认

1. **本宿主 `form` 的实际值**：从历史拒派记录与 `formOf` 新形态优先逻辑**推断为 `activation`**，但**未实测**（需要插件内真实 `ctx`）。这决定 `request.persona` 是否真的送不进去。
2. **`§0p`（201 行）为何零引用**：它是「官方 roster × 蟛蜞自建治理面」分工，可能只对 Leader 相关、不对 role 引用 —— 属合理。
3. **`§0j`（48 行）/ `§0b`（41 行）零引用**：大型章节未被任何 role 引用，是否需要让某些 role 引用它们（如 coordinator 引 `§0b` 三层门禁）—— 属 role 语料的质量问题，不在本批范围。
