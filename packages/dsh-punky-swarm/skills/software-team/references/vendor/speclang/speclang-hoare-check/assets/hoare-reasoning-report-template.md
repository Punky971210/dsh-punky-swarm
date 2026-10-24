# 霍尔逻辑推理验证报告

**生成状态**: SKELETON / IN_PROGRESS / COMPLETE
**概要**: API合约 验证N/PROVED A/SEMI_PROVED B/VIOLATED C/UNKNOWN D | 用例合约 验证N/PROVED A/SEMI_PROVED B/VIOLATED C/UNKNOWN D | CHAIN_BREAK P | MAPPING_BLOCKED M | 待修复 C+D+P+M
**检查结论**: 生成中 / PASS / FAIL（或：生成中 / 通过 / 不通过）

> 推理精度（L1/L2/L3）及升级策略的规范定义以 `SKILL.md` 为准。
> `ui_logic_native_pseudocode` 是行为契约的一部分：UI 触发逻辑视为函数/用例入口前置契约，后续 UI 可观察变化视为后置契约。

---

## 生成进度

**进度**: Obligation 总数 N / 已完成 A / 待处理 B | 当前批次 <id> | 异常项 <无/OBL-ID>

---

## API合约验证

> 每个函数独占一个 `###` 子段落；每个 Obligation 独占一个 `####` 子段落，并输出逐行推理表。

### `<函数名>` | `<文件>:<起始行>-<结束行>` | 合约: <id1>, <id2>, ...

**实现对应关系 | <contract_id>**

- **Spec设计点**: API `<signature或抽象功能点>` | contract `<contract_id>`
- **对应类型**: DIRECT / ENTRY_WRAPPED / MULTI_FUNCTION / MAPPING_BLOCKED（定义见 `SKILL.md`）
- **实际代码入口**: `<file:line symbol>`
- **实际调用链**: `<file:line symbol>` → `<file:line symbol>` → `<file:line symbol>`
- **数据/状态映射**: `<spec输入/状态/副作用>` => `<代码变量/字段/对象/外部资源>`
- **UI事件/状态映射**: `<UI元素/事件/状态>` => `<事件处理器/参数/绑定状态/可观察UI结果>`；若无 UI pseudocode，写“无”

> 若对应类型为 `MAPPING_BLOCKED`，不得输出下方逐行推理表；该 contract 的相关 Obligation 结论统一为 `UNKNOWN`，并进入修复指导。

#### OBL-API-<contract_id>-<n> | 条件: <逐字抄写YAML原文> | 推理精度: <L1/L2/L3>

**条件来源**: hoare_contract.post_condition / hoare_contract.side_effects / ui_logic_native_pseudocode
**精度说明**: <若由默认L2升级，说明升级触发条件；否则写“默认L2”>
**反证优先**: <发现反例 / 未发现反例> | <最小反例路径或未发现说明>

| 步骤 | 代码位置 | 执行前断言 | 执行语句/动作 | 使用规则 | 执行后断言 | 行类型 | 验证依据 |
|------|----------|------------|----------------|----------|------------|--------|----------|
| 1 | <file:line> | <P0> | <stmt/action> | <rule> | <P1> | 独立验证点/规则派生点/继承重述点 | <行号或规则依据> |

**结论**: PROVED / SEMI_PROVED / VIOLATED / UNKNOWN
**收束**: `Pn => <逐字抄写YAML原文>` 或 `不成立（给出偏离原因与行号）`

若条件来源为 `ui_logic_native_pseudocode`，必须在同一个 Obligation 中补充：

- **触发侧收束**: `Pn => UI触发条件成立时会调用目标 API/function chain` 或 `不成立（给出偏离原因与行号）`
- **后置侧收束**: `Pn => <逐字抄写的UI后续变化>` 或 `不成立/不适用（给出原因与行号）`

---

## 用例合约验证

> 每个用例按场景独占 `###` 子段落：Happy Path / Business Exception / Technical Exception。

### <contract_id> | 场景: <Happy Path / Business Exception / Technical Exception> | Spec链: <id1> → <id2> → ...

**实现对应关系 | <contract_id> | 场景: <Happy Path / Business Exception / Technical Exception>**

- **Spec设计点**: usecase `<usecase_id/名称>` | 场景 `<scenario>` | 设计链 `<ordered_implementation_chain>`
- **对应类型**: DIRECT / ENTRY_WRAPPED / MULTI_FUNCTION / MAPPING_BLOCKED（定义见 `SKILL.md`）
- **实际代码入口**: `<file:line symbol/route/event>`
- **实际调用链**: `<file:line symbol>` → `<file:line symbol>` → `<file:line symbol>`
- **设计链到实际链映射**: `<spec API/usecase节点>` => `<实际代码节点或合并/拆分说明>`
- **数据/状态映射**: `<spec输入/状态/副作用>` => `<代码变量/字段/对象/外部资源>`
- **UI事件/状态映射**: `<UI元素/事件/状态>` => `<事件处理器/参数/绑定状态/可观察UI结果>`；若无 UI pseudocode，写“无”

> 若对应类型为 `MAPPING_BLOCKED`，不得输出下方逐行推理表；该场景相关 Obligation 结论统一为 `UNKNOWN`，并进入修复指导。

#### OBL-UC-<contract_id>-<scenario>-<n> | 条件: <逐字抄写YAML原文> | 推理精度: <L1/L2/L3>

**条件来源**: hoare_contract.post_condition / ui_logic_native_pseudocode
**精度说明**: <若由默认L2升级，说明升级触发条件；否则写“默认L2”>
**反证优先**: <发现反例 / 未发现反例> | <最小反例路径或未发现说明>

| 步骤 | 代码位置 | 执行前断言 | 执行语句/动作 | 使用规则 | 执行后断言 | 行类型 | 验证依据 |
|------|----------|------------|----------------|----------|------------|--------|----------|
| 1 | <file:line> | <P0> | <stmt/action> | <rule> | <P1> | 独立验证点/规则派生点/继承重述点 | <行号或规则依据> |

**链兼容**: ✓ / ❌ CHAIN_BREAK

若 `CHAIN_BREAK`，必须补充：

- 断裂点: <API_i -> API_(i+1)>
- 上游给定: <断言>
- 下游需要: <断言>
- 不蕴含原因: <1行 + 行号>

**结论**: PROVED / SEMI_PROVED / VIOLATED / UNKNOWN
**收束**: `Pn => <逐字抄写YAML原文>` 或 `不成立（给出偏离原因与行号）`

若条件来源为 `ui_logic_native_pseudocode`，必须在同一个 Obligation 中补充：

- **触发侧收束**: `Pn => UI触发条件成立时会调用目标 usecase/function chain` 或 `不成立（给出偏离原因与行号）`
- **后置侧收束**: `Pn => <逐字抄写的UI后续变化>` 或 `不成立/不适用（给出原因与行号）`

---

## 修复指导

> 对 VIOLATED / UNKNOWN / CHAIN_BREAK / MAPPING_BLOCKED 输出修复指导，每个函数、断裂点、UI缺口或映射缺口独占一个 `###` 子段落。

### `<函数名、断裂点、UI缺口或映射缺口>` | `<文件>`
- **关联Obligation**: <OBL-...>
- **问题**: <1行偏离描述>
- **映射缺口**: <若为MAPPING_BLOCKED，说明缺失的入口、调用链、数据/状态映射或证据；否则写“无”>
- **UI缺口**: <若该 API/用例 Obligation 来自 ui_logic_native_pseudocode，说明缺失的组件、事件绑定、参数映射、状态写入、渲染绑定或可观察结果；否则写“无”>
- **触发测试**: <输入值 -> 期望<期望输出> | 实际<实际输出> | assert <断言>>

## 风险说明

> 对 `SEMI_PROVED`，必须输出风险说明和补证计划，每个 Obligation 独占一个 `###` 子段落；`SEMI_PROVED` 可接受，但解释必须放在本节，不放入“修复指导”。

### `<函数名>` | `<文件>`
- **关联Obligation**: <OBL-...>
- **风险说明**: <说明当前仅能判为 SEMI_PROVED 的原因、潜在偏离规约的触发条件与影响范围>
- **补证计划**: <列出补齐到 PROVED 所需的证据、测试、断言或外部依赖验证动作>
