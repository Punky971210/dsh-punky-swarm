# role 主动注入：侦查结论与方案（2026-11-07）

> 触发：用户「如果是把 roster 注入成员上下文，我打算把 role 信息和对应的 role 执行规范也做成主动注入」
> 本轮只做侦查与定方案，**不动代码**。

## 一、侦查结论（六条实测事实）

### 1. role 资产**早已结构化**，不是散文

`skills/<team>/references/roles/*.md` —— **23 个角色文件 / 5 个团队**（software-team 7 / video-team 7 /
writing-team 4 / research-team 3 / design-team 2）。每份是 YAML frontmatter + 正文，字段完整：

```yaml
mission / responsibilities / authorities / deliverables(form + must_contain)
acceptance_hints
tools: { allow, deny_derived }        ← 权限面
model_tier: worker                     ← 模型档
skills: [software-team]                 ← 技能加载建议
discipline_refs: [0e, 0i, 10]           ← 纪律索引
---
## Persona（注入用）                    ← 自己标了「注入用」
```

⇒ 记忆里那条「先做岗位档案数据化」的判断，**实际已经做完了**（至少数据层）。

### 2. 渲染单点已覆盖 **6 个字段**（不是我以为的 3 个）

`renderRoleGuide`（`dispatch.js:728-762`）实际渲染：
1. `## 你的职责` —— `- **使命**：{mission}` + `- {responsibility}` × N
2. `## 你被授权决定` —— `- {authority}` × N（空则显式「（role 未声明）」）
3. `## 交付要求` —— `- 交付件：{form}` + `  - 必含结构：{must_contain}`
4. **`- 规格：见技能 {skills}`**（`:756-757`）
5. **`- 达标提示：{acceptance_hints}`**（`:758-760`）

⇒ **用户之前要的「任务包加入 skill 使用建议」，其实已经有了**（`:756`）。

### 3. 真正闲置的只有 **4 个字段**

| 字段 | 状态 |
|---|---|
| `## Persona` | **闲置**（文件里标了「注入用」，但无任何渲染点） |
| `tools` | **已消费但未注入**：`roleToolVocabulary` / `deriveDenyTools` 拿它算 deny 面，但**不进任务包文本** |
| `model_tier` | **闲置** |
| `discipline_refs` | **闲置** |

### 4. C 档已自动注入，而且是完整骨架

`composeWorkerPrompt`（`dispatch.js:800`）注释逐字：
> 成员任务包**骨架**（B1）：引擎侧给出「角色 / 目标 / 契约 / 产物 / 纪律」，Leader 的 `prompt` 作为任务要点追加。

⇒ C 档（引擎自派 `push_execute`）**任务包是自动生成的**。

### 5. D 档**结构上无法自动注入**（宿主约束，非引擎懒惰）

`query-tools.js:185-186` 原文：
> **为什么是「取件口」而非「自动注入」**：`spawn_teammate` 参数面无 role 位 ⇒
> **闭环只能是「引擎给件 → Leader 取件拼装」**

⇒ 宿主工具 `spawn_teammate` 的签名里没有 role/team 参数，引擎插不进去。

### 6. 但 `role_guide` 这个取件口**本轮完全没用上**

用户这几轮看到的 D 档任务包，是 **Leader 凭 SKILL.md 散文手写**的，不是从 `role_guide` 取的件。
⇒ 手写件与 `roles/*.md` 的定义**可能不一致**，且每次重复劳动。

## 二、缺口归纳（两件事，不是一件）

| 编号 | 缺口 | 性质 |
|---|---|---|
| **G-1** | `role_guide` 只给三段（+skills+hints），**`Persona` / `tools` / `model_tier` / `discipline_refs` 无取件口** | 能力缺口（可修） |
| **G-2** | **D 档的任务包骨架没有生成器** ⇒ Leader 全靠手写 | 能力缺口（可修）——「注入」在宿主层面做不到，但「**给件**」可以做到极致 |

## 三、方案（三档）

### 甲：扩充 `role_guide` 的返回字段（最小）

- **做什么**：`role_guide` 增加**可选**返回键 `persona` / `tools` / `modelTier` / `disciplineRefs`
  （照既有 `preflight` 的「可选键」先例 —— 不传就返回键集逐字不变）
- **动谁**：`query-tools.js` 的 schema + 一个新渲染函数（**不改 `renderRoleGuide`** ⇒ C 档任务包零影响）
- **代价**：小。`resolveRoleRef` 已返回全字段，纯读取件
- **风险**：**零**（可选键 + 独立函数 ⇒ C 档字节不变，既有读端零回归）
- **收益**：Leader 能拿到完整 role 面

### 乙：新增 `taskpack_for({ batchId, lane })` —— **真正解决 G-2**

- **做什么**：从黑板读 `wavePlan.tasks[].{role, cmd, layer, consume, produce, outputs}`，
  调 `composeWorkerPrompt` 生成**完整任务包**，返回给 Leader 直接作 `spawn_teammate` 的 prompt
- **动谁**：新增一个只读工具（`lib/tools/query-tools.js` 旁）+ `suite.js` 登记 + 白名单无关（零新依赖）
- **代价**：中。**核心是复用 `composeWorkerPrompt`（纯函数，不需改它）**
- **风险**：中低。只读、零副作用；风险在「返回的任务包与引擎自派路径是否逐字一致」（可测）
- **收益**：**大** —— Leader 派 D 档不再手写角色段/纪律段/回报要求，直接取件，且**与 C 档同源**
- **额外好处**：取件内容与 C 档**同一渲染单点** ⇒ 两条通道的任务包不会再漂移

### 丙：甲 + 乙（分两步做）

先乙（解决实际痛点），再甲（补齐 role 面）。**推荐这一档。**

## 四、我打算怎么做（如果你不否决）

1. **先乙**：`taskpack_for({ batchId, lane })` —— 只读工具，复用 `composeWorkerPrompt`，零新依赖
2. **验证方式**：拿本批已完成的某个 lane（如 `e2-handoff`）当样本，比对「工具产出的任务包」
   与「引擎自派路径 `composeWorkerPrompt` 的输出」是否逐字一致；再与我手写的那份做 diff，
   看手写件漏了什么（这就是量化的增益读数）
3. **再甲**：`role_guide` 补 4 个可选字段
4. **不动**：`renderRoleGuide`（C 档三段字节冻结）、`spawn_teammate` 的调用形态、role 语料文件

## 五、不做什么（防漂移）

- **不试图改宿主 `spawn_teammate` 签名**（那是宿主工具，不在引擎权限内）
- **不改 `renderRoleGuide`**（它是 C 档字节的真源；扩它会同时改 C 档任务包，属未评估的行为变更）
- **不改 role 语料文件**（23 个文件现状够用；`Persona` 段已在文件里，只是没人读）
- **不引入新的 role 真源**（`resolveRoleRef` 是解析单点，`renderRoleGuide` 是渲染单点，两单点不合并）

## 六、不确定项（需要你定调的地方）

1. **`taskpack_for` 的返回形态**：整份任务包文本（可直接粘）／还是结构化 JSON（Leader 自己拼）？
   我倾向**两者都给**（`text` 便于粘贴、`fields` 便于核对）。
2. **`discipline_refs` 要不要真的把纪律正文展开**：现在只存编号（`0e` / `0i` / `10`）。
   展开需要读 `references/discipline.md` 的对应段 —— 会显著加长任务包（纪律全文 1000+ 行）。
   我倾向**只给编号 + 一行摘要**，不展开全文。
3. **`tools` 要不要进任务包**：它已经是**执行面的 deny 计算源**（`deriveDenyTools`）。
   写进任务包是给 worker 看的「你有哪些工具」，价值中等（worker 自己看工具列表即可）。
   我倾向**给 allow 列表但不给 deny**（deny 是引擎侧的收窄实现细节）。
