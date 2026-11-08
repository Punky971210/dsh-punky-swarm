# role 注入：修正版方案（2026-11-07）

> 触发：用户「由于注入结构有变，现已有任务包注入，此前设计的注入内容可能需要改动」
> 本文取代 `role-injection-plan-20261107.md` 里的「方案甲（`role_guide` 补 4 个键）」——
> 该设计在 `taskpack_for` 落地后**已不成立**。

## 一、为什么原方案甲不成立了

原方案甲假设「Leader 用 `role_guide` 取角色面，自己拼任务包」，所以要把 `role_guide` 补成完整的角色视图。

但 `taskpack_for` 落地后，**D 档的主路径变成了「取整份任务包」**（内含 role 三段 + skills + hints +
纪律 + checkpoint），`role_guide` 退回「纯查询角色定义」的角色。

⇒ 再给 `role_guide` 补 4 个键，产出的是一份**没有使用场景的角色说明书**——取件人拿到也不会塞进任务包（因为任务包已由 `taskpack_for` 生成）。

**更根本的问题**：这 4 个字段里，**大部分根本不该进 prompt 文本**。它们是**引擎侧参数**，不是给 worker 读的话。

## 二、逐字段定性（实测依据）

| 字段 | 值的形态 | 该去哪 | 依据 |
|---|---|---|---|
| **`## Persona`** | 一句话角色定位<br>（如 coder：`spec 驱动实现与最小自检；按 spec 改码，验证面交 Tester。`） | **宿主的 `persona` 参数位** | `buildStartRequest` 的 `SubagentStartRequest` 形如 `{label, prompt, parent, signal, toolFilter, persona?, maxDepth}` ⇒ **有 `persona?` 位，但从未从 `## Persona` 段取值**。这是**真缺口** |
| **`tools.allow`** | `['read','write','edit',...]` | **不进 prompt** | 已被 `roleToolVocabulary` + `deriveDenyTools` 消费成**执行面的 deny 计算源**。写进文本是给 worker 复述它自己能在工具列表里看到的東西 |
| **`model_tier`** | `worker` | **无处可去** | 宿主 C 档 `start` 的请求形态**没有 model 位**（同上签名）。这是**宿主能力缺口**，不是引擎该塞进 prompt 的东西 |
| **`discipline_refs`** | `[0e, 0i, 10]` | **不进 prompt** | 展开会把任务包撑到 1000+ 行（`discipline.md` 全文）；而 `## 纪律` 段**已经**把可执行规则逐条写进任务包了 ⇒ 编号引用是冗余 |

**一句话**：`persona` 该进（但走宿主参数位）；`tools` / `discipline_refs` 不该进；`model_tier` 无处可去。

## 三、探针实测（两个疑点一真一假）

用 `composeWorkerPrompt` 直接跑三种 `firstLine`：

```
firstLine: undefined → 前4行 ["", "", "# 任务包（引擎自派 · punky-swarm:bt:l1）", "- **lane**：…"]
firstLine: ""        → 同上（首行为空串）
firstLine: "【D 档 · …】" → 前4行 ["【D 档 · Leader 直派（无 lane 句柄）】", "", "# 任务包（引擎自派 · …）", …]
```

| 疑点 | 结论 |
|---|---|
| `firstLine: undefined` 会渲染出字符串 `"undefined"` | **假** —— `Array.prototype.join` 把 `undefined`/`null` 转空串 ⇒ 输出是空行，不是 "undefined" |
| 标题写死「引擎自派」 | **真** —— `dispatch.js:864` 硬编码 `'# 任务包（引擎自派 · ' + labelOf(...)`，D 档取件时**事实错误** |

**另一个顺带发现的语义损失**：`firstLine` 留空虽不出错，但 **D 档 worker 丢失了"我没有 lane 句柄"这个信息**——它读到的任务包与 C 档长得一样，可能会去找句柄、或误以为自己是引擎自派的。

**段结构实测**（`firstLine: ''` 全量段标题）：
```
# 任务包（引擎自派 · …）
## 你的职责 / ## 你被授权决定 / ## 交付要求
## 开工前必做
## 纪律
```
（`## 任务要点（Leader 补充）` 仅在给了 `leaderPrompt` 时出现 —— 符合设计）

## 四、修正后的方案（三件事，全部小改）

### ① `taskpack_for` 的通道标识（修我上批的实现缺陷）

- **问题**：标题写死「引擎自派」+ 首行留空 ⇒ D 档任务包**冒充** C 档
- **修法**：`composeWorkerPrompt` 增一个**可选**参数（如 `channelLabel` / `firstLineKind`），缺省 `undefined`
  ⇒ **C 档字节逐字不变**（零回归），D 档由 `taskpack_for` 传「Leader 直派」标识
- **判据**：C 档调用点不传 ⇒ 输出与改动前**逐字节相同**（可用现有 `engine-dispatch` 测试的逐字节断言验证）

### ② `## Persona` → 宿主 `persona` 位（真缺口）

- **做什么**：`roleDataOfText` 解析 md 正文的 `## Persona` 段（现在只解析 frontmatter）；`buildStartRequest` 把它填进 `persona`
- **影响面**：**只影响 C 档**（D 档走 `spawn_teammate`，无该参数位）
- **风险**：低——`persona` 是宿主既有参数，填它不改变任何治理语义
- **需确认**：`persona` 的实际语义（宿主如何使用它？是 system prompt 前缀还是别的）——**这条要摸宿主源码**

### ③ `model_tier` 登记为「宿主能力缺口」（不实现）

- **做什么**：只在文档/快照里记一条：`role.model_tier` 已声明但宿主 C 档请求无 model 位 ⇒ 无处消费
- **不做什么**：不塞进 prompt（那是把派发决策当成 worker 的指令，语义错位）

## 五、不做（明确划界）

- **不给 `role_guide` 补任何键**（原方案甲作废）
- **不把 `tools` / `discipline_refs` 写进 prompt**
- **不改 `renderRoleGuide`**（C 档三段字节冻结）
- **不改 `spawn_teammate`**（宿主工具，不在引擎权限内）

## 六、待确认（需宿主源码或用户定调）

1. **`persona` 在宿主里的实际语义**：是 system prompt 的独立段？还是 `prompt` 的前缀？决定我们该往 `## Persona` 段里写什么（现在那段的文字是「注入用」，但如果宿主把它当 system prompt，措辞风格可能要变）。
2. **`model_tier` 是否值得推动宿主支持**：如果 C 档永远无法指定模型，`model_tier` 字段就是个恒不生效的声明——要么删字段，要么留作「跨宿主移植的元数据」。
3. **`taskpack_for` 的通道标识用哪种形态**：新增参数（改 `composeWorkerPrompt` 签名，但零回归）／还是在 `taskpack_for` 里对返回文本做**首行替换后处理**（不改 `composeWorkerPrompt`，但引入第二处文案面）。

  我倾向**前者**（签名 + 零回归），因为后者会造出「任务包的标题有两个来源」。
