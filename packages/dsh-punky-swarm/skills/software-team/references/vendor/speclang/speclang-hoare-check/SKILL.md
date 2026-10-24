---
name: "speclang-hoare-check"
description: "Semi-formal Hoare logic reasoning verification for SpecLang specifications. Use when checking whether code fulfills SpecLang behavioral contracts, verifying post_condition satisfaction, tracing violation root causes, or the user mentions 'hoare-check', 'spec verify', 'contract compliance', 'code compliance check' '规约检查', '推理验证', '一致性检查'."
---

# SpecLang Hoare Logic Reasoning Verification

本 skill 基于自然语言霍尔逻辑方法论，对 SpecLang 规格与实现代码进行半形式化推理验证。报告以 Obligation 为单位给出逐行推理过程，展示 pre_condition 到 post_condition/side_effects 的完整推导链；`ui_logic_native_pseudocode` 中声明的 UI 触发逻辑与后续 UI 可观察变化也必须作为行为契约的一部分验证；用例验证按正常/异常场景分别推理；所有结论必须可回指到具体代码行与推理步骤。

验证不得把 SpecLang 中的 API 名称、签名或 `ordered_implementation_chain` 直接等同于实现事实。每个 contract 在产出任何 Obligation 推理表之前，必须先输出它在 spec 设计中的 API/usecase 与实际代码入口、实现位置、调用链、数据/状态映射之间的对应关系。允许实现以框架入口、适配层、组合函数、领域服务、事件处理器等形式承载抽象 API/usecase；若无法建立可证据化对应关系，不得继续生成证明过程，该 contract 的 Obligation 必须判为 `UNKNOWN` 并标记 `MAPPING_BLOCKED`。

---

## 输入

使用本 skill 前，必须获取以下输入（通过 Glob/Grep/Read 工具定位并读取）：

1. **SpecLang YAML 规格文件**：包含 `behavioral_contracts.api_specs` 和 `behavioral_contracts.use_case_specs`，每条 contract 含 `hoare_contract.pre_condition` / `post_condition` / `side_effects`，并可能含 `ui_logic_native_pseudocode`
2. **实现代码文件**：任意语言源码，对应规格中 `traceability_and_validation.spec_to_code_trace` 指向的文件
3. **可选：intent_event YAML**：提供 PM 意图上下文

读取顺序：
- 先用 Glob 找到 SpecLang YAML（`**/*speclang*.yaml`）和代码文件（按 `spec_to_code_trace` 中的文件名）
- 用 Read 读取完整内容
- 如果 spec 中 `reuse_and_boundary.related_code_artifacts` 引用了其他文件（如领域模型文件），也必须读取
- 如果 `spec_to_code_trace`、`ordered_implementation_chain` 或 `ui_logic_native_pseudocode` 只给出抽象 API/UI 名称，必须继续读取最近的路由、入口、调用点、UI 组件、事件处理器、状态绑定或适配层，直到能说明实际代码如何承载该 contract，或明确标记 `MAPPING_BLOCKED`

---

## 验证流程

### A. API 合约验证（按函数组织）

以函数为单位组织验证，**每个函数独占一个 `###` 子段落**。对每条 `api_specs` 中 `status == active` 的 contract 执行如下步骤：

#### Step 1: 建立 API contract 实现对应关系

每条 `api_specs` 中 `status == active` 的 contract 在进入 Obligation 拆分、反证优先和逐行推理之前，必须先产出“实现对应关系”。

- 将 `signature`、`contract_id`、`spec_to_code_trace` 作为定位线索，用 Grep/Read 追踪到实际实现入口
- 若实现不是同名函数，必须继续追踪路由、handler、service、adapter、领域方法或调用点，说明抽象 API 由哪些实际代码承载
- 用 Read 读取入口与关键调用链上每个会影响 pre/post/side_effects/UI 可观察行为的实现片段，记录文件名和行号范围
- 输出该 contract 的“实现对应关系”；同一函数承载多个 active contracts 时，每个 contract 都必须各自输出对应关系
- 对应关系必须包含：Spec 设计点（`contract_id`、API `signature`）、实际代码入口、实际调用链、数据/状态映射、UI 事件/状态映射（若该 contract 声明了 `ui_logic_native_pseudocode`）、对应类型
- 对应类型取值与含义：
	- `DIRECT`：Spec API 与一个实现函数基本一一对应，证明边界以该函数为主
	- `ENTRY_WRAPPED`：Spec API 先由路由、handler、controller、adapter、框架回调等入口接住，再转入实际函数；必须给出入口证据和转调链
	- `MULTI_FUNCTION`：一个 contract 需要多个函数或连续步骤共同完成；必须列出完整关键调用链，并按链路整体验证
	- `MAPPING_BLOCKED`：无法用代码证据建立实际入口、关键调用链或数据/状态映射，只能拆分 Obligation 用于追踪并统一判为 `UNKNOWN`
- `signature`、`spec_to_code_trace` 只能作为定位线索，不能替代实际代码对应关系
- 只有对应关系非 `MAPPING_BLOCKED` 时，才能进入反证优先与逐行证明；若只能找到抽象 API 设计点，找不到实际入口或关键调用链，必须标记 `MAPPING_BLOCKED`，只拆分 Obligation 用于追踪并统一判为 `UNKNOWN`

#### Step 2: Obligation 拆分

把每条 `post_condition` / `side_effects` / `ui_logic_native_pseudocode` 拆成 API Obligation。命名格式：

- `OBL-API-<contract_id>-<n>`

拆分规则：

- YAML 中每一条 `- "..."` 列表项对应一个 Obligation
- 禁止把多条列表项合并为一个 Obligation
- 禁止把一条列表项拆成多个 Obligation
- `implies` 整条作为一个 Obligation
- `ui_logic_native_pseudocode` 每一条列表项必须拆成一个普通 API Obligation，编号仍使用 `OBL-API-<contract_id>-<n>`；若一条语句同时包含触发动作与后续 UI 变化，仍保持为一个 Obligation，但推理表中必须分别证明触发前置与后续可观察结果

`ui_logic_native_pseudocode` 作为 API Obligation 时的语义：

- `ui_logic_native_pseudocode` 左侧触发动作（例如点击、输入、提交、手势、生命周期事件）等价于该 API 可由此 UI 条件触发的前置契约：实现代码必须存在对应 UI 元素、事件绑定、参数/状态映射、以及必要的启用/禁用或校验逻辑。
- `ui_logic_native_pseudocode` 中 API 调用后的 UI 操作（例如显示/隐藏、导航、文本更新、列表刷新、错误展示、加载/空态/失败态切换）等价于成功、失败或分支路径的后置契约：实现代码必须在对应路径上产生这些可观察 UI 变化。
- 若一条 UI 语句没有显式后续 UI 操作，则仍必须证明触发动作确实调用了目标 API 或用例链，并且调用前的 UI 输入/状态被正确映射到代码参数。
- 若 UI 后置变化依赖异步回调、状态管理、框架绑定或渲染循环，必须把“事件处理器 -> 状态写入 -> 绑定/渲染观察结果”的链路作为证明对象；不得只写“框架会更新 UI”。

#### Step 3: 反证优先 + 逐行推理

对每个 Obligation 必须先执行“反证优先”，再输出逐行推理表。默认粒度为基本块级（L2）。

反证优先要求：

- 先尝试构造最小反例路径（最少分支、最短调用链、最少状态假设）。
- 若找到可执行反例且违反条件原文，结论直接判定为 `VIOLATED`，并给出反例输入、路径和代码位置。
- 若未找到反例，不得直接判 `PROVED`，必须继续完成逐行推理并检查证据链是否闭合。

逐行推理表字段：

- `步骤`
- `代码位置`
- `执行前断言`
- `执行语句/动作`
- `使用规则`
- `执行后断言`
- `行类型`
- `验证依据`

核心约束：

- 每一行都必须满足：`前一行后断言 + 当前行语义 => 当前行后断言`
- 结尾必须给出：`Pn => 条件原文`
- 不允许仅给一句结论而不展开推理过程

`ui_logic_native_pseudocode` 来源的 Obligation 额外要求：

- 对触发侧，结尾必须给出：`Pn => UI触发条件成立时会调用目标 API/usecase/function chain`，并说明参数来自哪个 UI 状态、事件载荷或绑定变量。
- 对后置侧，结尾必须给出：`Pn => <逐字抄写的 UI 后续变化>`，并说明该变化如何被用户或测试观察到（组件属性、导航栈、可见性、文本、列表数据、错误区域、loading/empty/failure 状态等）。
- 若代码只更新内部状态但没有绑定到 UI，或只存在 UI 元素但没有事件调用链，必须判为 `VIOLATED` 或 `UNKNOWN`，不能用内部 Hoare post_condition 替代 UI 证明。

行类型必须归类为以下之一：

- `独立验证点`：引入状态变化或新语义约束（如赋值、分支入口/出口、调用边界、循环关键点、异常路径、返回、合流）
- `规则派生点`：通过霍尔规则组织推理结构（如 Sequence、Consequence、If 合成、Call 衔接）
- `继承/重述点`：仅做语义等价重述（命名映射、断言重排、上下文承接）

禁止项：

- 禁止将新增约束伪装为“继承/重述”
- 禁止出现未归类行
- 禁止出现无行号依据的关键断言

#### Step 4: 结论判定

每个 Obligation 使用统一结论等级：

- `PROVED`
- `SEMI_PROVED`
- `VIOLATED`
- `UNKNOWN`

说明：

- 找到最小反例路径并可回指代码证据时，必须判定为 `VIOLATED`。
- 未找到反例且证据链完整闭合（每步可由行号与规则支撑，且最终 `Pn => 条件原文` 成立）时，才能判定为 `PROVED`。
- 未找到反例，主体推理基本成立，但仍依赖未闭合假设、外部语义前提或待补证环节时，可判定为 `SEMI_PROVED`。
- 未找到反例但证据链不闭合时，必须判定为 `UNKNOWN`。
- `UNKNOWN` 不能计入通过
- `SEMI_PROVED` 可以计入通过，但必须在“风险说明”中解释原因、风险范围与补证计划
- `VIOLATED`、`UNKNOWN`、`CHAIN_BREAK` 和 `MAPPING_BLOCKED` 必须进入修复指导

#### Step 5: 循环处理

遇到循环必须显式写出：

- 候选不变式 `I`
- 初始化：入口满足 `I`
- 保持性：循环体后仍满足 `I`
- 退出利用：`I and not cond` 如何推出目标条件

保持性无法证明时，结论至少降级为 `SEMI_PROVED` 或 `UNKNOWN`。

### B. 用例合约验证（按场景组织）

对每条 `use_case_specs` 中 `status == active` 的 contract，必须按场景独立验证：

- `Happy Path`
- `Business Exception`
- `Technical Exception`

#### Step 1: 建立 usecase contract 实现对应关系与场景链路

- 将 usecase 场景、`ordered_implementation_chain`、相关 API contract 作为 spec 设计链路线索
- 读取实际入口（如 UI 操作、CLI 命令、HTTP 路由、消息订阅、定时任务、测试驱动入口）与后续调用链；若存在 `ui_logic_native_pseudocode`，还必须读取 UI 组件、事件处理器、状态绑定、导航/呈现逻辑与异步结果处理逻辑，输出该场景的“实现对应关系”
- 实际调用链可以不同于 `ordered_implementation_chain`，但必须说明每个 spec 设计节点由哪段实际代码承载，或为何被合并/拆分/替代
- 输出字段按报告模板中的“实现对应关系”填写，并补充设计链到实际链映射
- 对每个实际链路节点承接上一步后断言，检查 mapped `API_i post => API_(i+1) pre`
- 不满足则标记 `CHAIN_BREAK`；无法建立入口或关键调用链则标记 `MAPPING_BLOCKED`，该场景相关 Obligation 结论为 `UNKNOWN`

#### Step 2: 条件拆分与 Obligation

对每条 `post_condition` 与 `ui_logic_native_pseudocode` 拆分用例 Obligation。命名格式：

- `OBL-UC-<contract_id>-<scenario>-<n>`

条件列必须逐字抄写 YAML 原文。

`ui_logic_native_pseudocode` 作为用例 Obligation 时必须证明：

- 触发动作能进入场景对应的实际入口，而不是只证明底层 API 存在。
- `ordered_implementation_chain` 中每个由 UI 触发或影响 UI 结果的节点，都有对应的调用、状态传递和结果处理证据。
- Happy Path、Business Exception、Technical Exception 以及 `branch_scenarios` 的 UI 后置变化必须分别证明；不能用 Happy Path 的 UI 结果覆盖异常或分支路径。

#### Step 3: 逐行推理

每个 Obligation 必须输出逐行推理表，并给出：

- 场景入口断言
- 链路中间断言传递
- 终态断言与条件原文关系

若存在 `CHAIN_BREAK`，必须写清：

- 断裂点 API 边界
- 上游给定断言
- 下游所需断言
- 不蕴含原因及代码位置

#### Step 4: `ui_logic_native_pseudocode` 覆盖检查

对 active API、usecase 与 branch scenario 中的每条 `ui_logic_native_pseudocode` 必须拆成其所属 API 或用例的普通 Obligation，并纳入对应 API/用例通过/不通过统计。

覆盖检查必须确认：

- 每条 UI pseudocode 原文在报告中有且只有一个对应 API/usecase Obligation。
- UI 触发动作有代码证据：组件/元素存在、事件绑定存在、事件到函数或用例链入口的调用路径存在。
- UI 输入和 UI 状态到函数参数、领域状态或请求 payload 的映射可追踪。
- 后续 UI 变化有代码证据：状态写入、渲染绑定、导航/呈现调用、错误/加载/空态切换、列表/表单更新等能被观察。
- 异步链路必须覆盖 pending/success/failure/branch 的结果处理；若 spec 只声明其中一部分，则至少证明被声明的部分，并在风险说明中指出未声明路径。
- API 层若声明了 UI pseudocode，必须验证该 API 的 UI wrapper/adapter/handler；若纯领域 API 本身没有 UI 代码但由上层 UI 调用，必须在对应关系中标明 `ENTRY_WRAPPED` 或 `MULTI_FUNCTION`，并把 UI 证据放入同一 API Obligation。

### C. 修复指导

对所有 `VIOLATED` / `UNKNOWN` / `CHAIN_BREAK` / `MAPPING_BLOCKED` 输出修复指导，按函数、链路断点、UI 触发缺口、UI 后置缺口或映射缺口组织，格式如下：

```markdown
### `<函数名、链路断点或UI缺口>` | `<文件>`
- **问题**: <1行：什么输入下、什么逻辑导致了什么偏离>
- **触发测试**: <输入值 -> 期望<期望输出> | 实际<实际输出> | assert <断言>>
```

同一函数（或同一链路断点）有多条问题时，在同一子段落逐条列出。

---

## 输出格式

产出一份中文推理验证报告，模板见 `assets/hoare-reasoning-report-template.md`。

### 渐进式报告写入（强制）

- 报告采用渐进式写入方式，避免一次性输出过大内容导致模型中断或丢失上下文，严格禁止一次性输出完整报告，必须按以下步骤用先骨架、再填充的方式执行。
- 先枚举全部 Obligation，再创建含所有章节、映射和 Obligation 标题的骨架；用 `<!-- HOARE:PENDING:<ID> -->` 标记，骨架完成前不填正文。
- 原位分批填充，每批不超过 3 个 Obligation 或 20 KB；单项过大则按路径/基本块拆批。完成项改为 `HOARE:DONE` 并同步进度；续写时跳过 `DONE`。
- 全部完成后确认无行首 `HOARE:PENDING`、ID 唯一且统计/板块完整，再标记 `COMPLETE`；失败时保留现有文件供续写。

### 推理精度与升级策略

精度等级定义：

- `L1`（关键语句级）
	- 覆盖会影响合约成立与否的关键语句/关键语义动作。
	- 至少包含：分支条件与出口、循环关键点（不变式初始化/保持/退出）、调用边界、异常路径、返回点、状态更新点、合流点。

- `L2`（基本块级，默认）
	- 在 `L1` 基础上，展开关键控制流块内的中间过渡步骤。
	- 适用于链路较长、分支较多、`L1` 下证据不足以解释结论的情况。
	- 报告颗粒度要求（“中间过渡步骤”必须至少覆盖以下语句类型）：
		- 条件判定语句：`if/elif/else`、`switch/match` 的判定表达式求值、分支进入条件、分支出口断言。
		- 调用语句：调用前实参/关键前置条件、调用返回值与副作用承接、异常返回路径承接。
		- 状态更新语句：赋值、复合赋值、集合增删改、对象字段更新后的中间状态断言。
		- 循环语句：循环入口、单次迭代保持、迭代后关键变量更新、退出条件成立后的出口断言。
		- 错误处理语句：`throw/raise`、`catch/except`、错误码分支的触发条件与后置断言。
		- 返回语句：返回值构造过程中的关键变换步骤与最终返回断言映射。
		- 合流语句：多分支/多路径在 join 点的统一断言形成过程。
	- L2 最小输出单元：
		- 对每个关键控制流块，至少输出“入口断言 -> 块内关键过渡 -> 出口断言”三段链路。
		- 同一块内连续的纯重命名或等价重述可合并为一步，但不得跨越状态变化语句。

- `L3`（近逐语句级）
	- 在 `L2` 基础上，展开到接近逐可执行语句级的推理与证据映射。
	- 适用于高风险审计、复杂故障复盘、细粒度定位反例场景。
	- 报告颗粒度要求（“近逐语句级”必须至少覆盖以下拆分粒度）：
		- 一条可执行语句对应一步推理；禁止把多个状态变化语句合并为一步。
		- 复合表达式需拆分为“关键子表达式求值 -> 主表达式结果 -> 状态写回”。
		- 调用语句需拆分为“参数约束检查 -> 调用边界 -> 返回/异常两条后继路径”。
		- 循环体需按“头部判定 -> 体内关键语句序列 -> 迭代变量更新 -> 回边条件”展开。
		- 异常路径需与正常路径并列逐步展开，直到在同一语义层级比较后置断言。
		- 外部副作用（存储、消息、IO）需单独成步，记录触发点、影响对象与可观察结果。
	- L3 最小输出单元：
		- 推理表中每一步都必须能唯一对应到具体代码行与单一语义动作。
		- 任一步若同时包含“条件判定 + 状态写入”两类动作，必须拆分。

L3 强制触发条件（命中任一即必须升级到 `L3`）：

- 循环不变式存在争议，或保持性无法在当前粒度下闭合。
- 存在跨模块调用关键依赖，且被调方语义对结论成立是必要前提。
- 出现 `CHAIN_BREAK` 且断裂证据在当前粒度下不闭合。
- 任一关键 Obligation 首轮结论非 `PROVED`（即 `SEMI_PROVED` / `VIOLATED` / `UNKNOWN`）。

强制执行要求：

- 不允许停留在“应升级但未升级”状态。
- 命中触发条件后，必须在同一 Obligation 内补齐 `L3` 推理或明确输出无法继续验证的阻塞原因。

填报要求：

- 每个 Obligation 必须标注当前推理精度：`L1` / `L2` / `L3`。
- 若发生升级，必须在该 Obligation 下记录升级原因与触发条件。
- 每个 Obligation 必须记录“反证优先”结果：`发现反例` / `未发现反例`。

### 颗粒度示例（好/坏对照）

示例代码片段：

```python
if amount <= 0:
	 raise ValueError("invalid amount")
fee = amount * rate
total = amount + fee
return total
```

反例目标条件：`post_condition: "return_value == amount + amount * rate and return_value > amount"`

坏示例（L2 不合格，跳步）：

```text
步骤1: 输入合法。
步骤2: 计算 total。
步骤3: 返回满足 post_condition。
```

不合格原因：

- 缺少条件判定语句展开（`amount <= 0` 分支未说明）。
- 缺少状态更新中间步骤（`fee` 与 `total` 的断言承接缺失）。
- 结论无法回指到逐行证据。

好示例（L2 合格，块级三段链路）：

```text
块A 入口断言: amount > 0 and rate >= 0
A1 条件判定: amount <= 0 为假，进入正常路径
块A 出口断言: 执行流到达费用计算块

块B 入口断言: amount > 0 and rate >= 0
B1 状态更新: fee = amount * rate  => fee >= 0
B2 状态更新: total = amount + fee => total == amount + amount * rate
块B 出口断言: total > amount

块C 入口断言: total == amount + amount * rate and total > amount
C1 返回语句: return total
块C 出口断言: return_value == amount + amount * rate and return_value > amount
```

好示例（L3 合格，近逐语句级）：

```text
1 [L10] 判定表达式求值: amount <= 0
	前: amount > 0
	后: 判定为 False，异常分支不可达
2 [L12] 子表达式求值: amount * rate
	前: amount > 0 and rate >= 0
	后: tmp_fee >= 0
3 [L12] 状态写回: fee = tmp_fee
	前: tmp_fee >= 0
	后: fee >= 0
4 [L13] 子表达式求值: amount + fee
	前: fee >= 0
	后: tmp_total == amount + fee
5 [L13] 状态写回: total = tmp_total
	前: tmp_total == amount + fee
	后: total == amount + amount * rate and total > amount
6 [L14] 返回
	前: total == amount + amount * rate and total > amount
	后: return_value == amount + amount * rate and return_value > amount
```

判定提示：

- 若一步同时写“判定 + 写回”，通常不满足 L3。
- 若只写“计算完成，条件成立”而缺少中间断言链，通常不满足 L2。

### 报告板块

报告必须包含以下板块：

1. 概要
2. API 合约验证
3. 用例合约验证
4. 修复指导
5. 风险说明（用于 `SEMI_PROVED`）

### API/用例段落规范

- 每个函数、每个用例场景独占一个 `###` 子段落
- 每个 contract 必须先输出“实现对应关系”，且该段落必须出现在该 contract 的任何 Obligation 推理表之前
- 对应关系为 `MAPPING_BLOCKED` 时，不得输出逐行推理表；必须拆分 Obligation 并统一判定为 `UNKNOWN`，同时进入修复指导
- 每个 Obligation 必须独立展示
- 条件文本必须逐字抄写 YAML 原文
- 推理过程必须逐行展示，不得压缩成“1行证明”
- `ui_logic_native_pseudocode` 来源的 Obligation 必须与其他 API/用例 Obligation 使用相同结论等级、相同逐行推理表字段和相同通过标准；不得放入独立于 API/用例的报告章节

### 概要统计建议

概要至少包含：

- API 合约：验证总数、PROVED、SEMI_PROVED、VIOLATED、UNKNOWN
- 用例合约：验证总数、PROVED、SEMI_PROVED、VIOLATED、UNKNOWN
- `CHAIN_BREAK` 数
- `MAPPING_BLOCKED` 数
- 待修复项数

### 检查通过标准

仅当同时满足以下条件时，才能在报告概要中标记“检查通过”：

- 所有 `api_specs` 与 `use_case_specs` 中 `status == active` 的 contract 均已完成验证，无遗漏
- 所有 contract 均已先完成实现对应关系映射，且不存在 `MAPPING_BLOCKED`
- 所有 Obligation 结论均为 `PROVED` 或 `SEMI_PROVED`
- 所有 active API、usecase 与 branch scenario 的 `ui_logic_native_pseudocode` 均已拆分并证明为其所属 API/usecase Obligation，无遗漏
- 所有链路承接检查 `API_i post => API_(i+1) pre` 成立，不存在 `CHAIN_BREAK`
- 不存在 `VIOLATED`、`UNKNOWN`、`MAPPING_BLOCKED`
- 待修复项数为 0
- 所有 `SEMI_PROVED` 均已在“风险说明”中给出充分理由、影响范围与补证计划

任一条件不满足，检查结论必须标记为“检查不通过”，并在概要中明确列出阻塞项。

---

## 执行纪律

1. 必须先读取所有输入文件后再开始推理
2. 每条 active contract 必须先完成实现对应关系映射，再开始 Obligation 推理
3. 每条 active contract 必须验证，不可跳过
4. 每条 active contract、branch scenario 中的 `ui_logic_native_pseudocode` 必须验证，不可跳过
5. 分支路径必须覆盖：if/elif/else 独立推理
6. `implies` 条件：前件成立时验证后件；前件不成立时说明真值原因
7. 跨模块依赖必须追溯到代码或已验证 contract
8. UI 触发与 UI 后置变化必须追溯到代码、绑定、框架入口或已验证 contract；不得用内部状态证明替代 UI 可观察行为证明
9. 结论必须基于代码实际行为，不得按规格期望替代实现事实
10. 每行推理都必须有行号或规则依据，禁止无依据跳步
11. 报告文件必须严格按模板生成，并遵循“先完整骨架、后分批填充”
12. 代码行为变更后必须重跑验证；若结果含 `VIOLATED` / `UNKNOWN` / `CHAIN_BREAK` / `MAPPING_BLOCKED`，或待修复项数大于 0，任务不得标记完成；若存在 `SEMI_PROVED`，必须补齐“风险说明”后方可标记完成

---

## 适用范围

适用于：

- SpecLang-first benchmark 的代码合规验证
- 具有 Hoare contract 的规格与代码一致性验证
- 代码生成 Agent 产出质量的推理验证

不适用于：

- 仅结构性 YAML 检查（不涉及代码推理）
- 无 hoare_contract 的规格
- 需要运行时执行结果才能判定的验证

---

## Asset Reference

- 推理验证报告模板：`assets/hoare-reasoning-report-template.md`
