# 成功模式种子

> 本文档预置九蜂流水线首次运行时可复用的成功模式。
> Doc-Manager 在首轮复盘时可参考这些种子进行模式提取，
> 也可逐条手动写入 Mnemopi 作为初始知识库。
> 格式：每条种子包含归属阶段 + 描述 + 复用建议，与复盘 Output Schema 对齐。

---

## 粗拆阶段

### SP-01：前后端分离 + 依赖链路粗拆

- **描述**：按前后端分离（BE/FE/Both）标注每子模块，再按依赖链路排序（无依赖的优先）。避免出现跨前后端的混合子模块。
- **复用建议**：所有粗拆场景通用。如遇不可分离的跨端功能，标注为 Both 并在细拆时再分离。
- **Mnemopi 标识**：`kind=meta, importance=0.7`

### SP-02：约束清单逐项对照

- **描述**：粗拆后逐项对照 Leader 约束清单的 4 类约束（技术/边界/交付/风险），确保粗拆不越界、不遗漏。
- **复用建议**：每次粗拆必做约束对账，发现冲突立即上报 Leader。
- **Mnemopi 标识**：`kind=meta, importance=0.6`

---

## 设计排期阶段

### SP-03：单子模块逐个迭代

- **描述**：每子模块独立过设计排期 → 细拆 → 执行 → 验收 → 复盘 全链路，不并行处理多个子模块的设计。
- **复用建议**：除非子模块间完全无依赖关系（极少情况），否则坚持单子模块串行迭代。
- **Mnemopi 标识**：`kind=meta, importance=0.7`

---

## 细拆排期阶段

### SP-04：API 粒度细拆

- **描述**：Designer 产出四件套后，Coordinator 按 spec.md 中的 API 定义将 Coder 任务细拆到单个 API 级别（一个 API = 一个子任务）。
- **复用建议**：API 级细拆让 Coder 和 Tester 的任务边界清晰，避免"一个任务做太多事"。
- **Mnemopi 标识**：`kind=meta, importance=0.7`

---

## 编码阶段

### SP-05：Coder 自检后再通知 Tester

- **描述**：Coder 完成代码后，先执行语法检查/lint/单元测试，确认无基本问题后再通知 Reviewer/Tester。
- **复用建议**：减少 Tester 因编译错误或基本语法问题被动打回的次数。
- **Mnemopi 标识**：`kind=meta, importance=0.6`

---

## 测试阶段

### SP-06：Spec 驱动测试（非 Manager 驱动）

- **描述**：Tester 收到任务后自主读取 spec.md 的 Acceptance Criteria 构建测试集，不等待 Manager 逐条下达。
- **复用建议**：减少 Manager 的沟通开销，Tester 的测试更全面（spec 覆盖度更高）。
- **Mnemopi 标识**：`kind=meta, importance=0.8`

### SP-07：每次打回记录失败模式

- **描述**：Tester/Reviewer 每次打回时，在打回裁定中附带失败模式标签（如"需求偏差/spec 不清晰/实现遗漏/测试不足"）。
- **复用建议**：为 Doc-Manager 复盘积累结构化失败数据，便于根因分析。
- **Mnemopi 标识**：`kind=meta, importance=0.8`

---

## 审查阶段

### SP-08：打回时附带 MUST-FIX 清单

- **描述**：Reviewer 打回 REWORK 时，必须输出结构化 MUST-FIX 清单（条目编号、预期行为、严重级别），不输出模糊描述。
- **复用建议**：减少 Coder 理解打回意图的认知开销，提高返工效率。
- **Mnemopi 标识**：`kind=meta, importance=0.7`

---

## 复盘阶段

### SP-09：复盘必读 6 类产出物

- **描述**：Doc-Manager 复盘时逐个读取 Leader 决策包、Designer 四件套、Coder 代码、Tester 报告、Reviewer 裁定、Supervisor 验收报告——缺一不可。
- **复用建议**：缺失任何一类产出物，复盘结论的完整性就有缺口。
- **Mnemopi 标识**：`kind=meta, importance=0.8`

### SP-10：成功/失败模式结构化入库

- **描述**：每轮复盘提取的模式必须按 `kind=meta`（成功）和 `kind=correction`（失败）分类写入 Mnemopi，且每条标注归属阶段。
- **复用建议**：结构化入库确保后续 Coordinator 的 mnemopi_recall 能按阶段过滤检索。
- **Mnemopi 标识**：`kind=meta, importance=0.8`

---

## 入库脚本（可选）

如果希望将以上种子批量写入 Mnemopi，可用以下 Mnemopi 命令逐个写入：

```python
# 示例：写入 SP-01
# mnemo工具: mnemopi_shared_remember(
#   content="SP-01: 前后端分离+依赖链路粗拆。按前后端分离标注每子模块，按依赖链路排序。",
#   kind="meta",
#   importance=0.7
# )
```

首轮运行时，建议至少写入 SP-01、SP-04、SP-06、SP-09、SP-10 作为最小种子集。
