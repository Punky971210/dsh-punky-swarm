# 成功模式种子

> 本文档预置蟛蜞模式首轮复盘可复用的成功模式。
> Doc-Manager 在首轮复盘时可参考这些种子进行模式提取，
> 也可逐条通过 dsh-mneme 落库作为初始知识库。
> 格式：每条种子包含归属阶段 + 描述 + 复用建议 + dsh-mneme 等价写法，与复盘 Output Schema 对齐。

---

## 粗拆阶段

### SP-01：前后端分离 + 依赖链路粗拆

- **描述**：按前后端分离（BE/FE/Both）标注每子模块，再按依赖链路排序（无依赖的优先）。避免出现跨前后端的混合子模块。
- **复用建议**：所有粗拆场景通用。如遇不可分离的跨端功能，标注为 Both 并在细拆时再分离。
- **dsh-mneme 语义**：`memory_save(type='history', title='SP-01 前后端分离+依赖链路粗拆', importance=3)`（成功模式）

### SP-02：约束清单逐项对照

- **描述**：粗拆后逐项对照 Leader 约束清单的 4 类约束（技术/边界/交付/风险），确保粗拆不越界、不遗漏。
- **复用建议**：每次粗拆必做约束对账，发现冲突立即上报 Leader。
- **dsh-mneme 语义**：`memory_save(type='history', title='SP-02 约束清单逐项对照', importance=3)`（成功模式）

---

## 设计排期阶段

### SP-03：单子模块逐个迭代

- **描述**：每子模块独立过设计排期 → 细拆 → 执行 → 验收 → 复盘 全链路，不并行处理多个子模块的设计。
- **复用建议**：除非子模块间完全无依赖关系（极少情况），否则坚持单子模块串行迭代。
- **dsh-mneme 语义**：`memory_save(type='history', title='SP-03 单子模块逐个迭代', importance=3)`（成功模式）

---

## 细拆排期阶段

### SP-04：API 粒度细拆

- **描述**：Coordinator 先按 spec.md 中的 API 定义将 Coder 任务细拆到单个 API 级别（一个 API = 一个子任务，产出 task-tree.json），Designer 再消费 task-tree 产出任务包（四件套），Leader 复核后派发。
- **复用建议**：API 级细拆让 Coder 和 Tester 的任务边界清晰，避免"一个任务做太多事"。
- **dsh-mneme 语义**：`memory_save(type='history', title='SP-04 API 粒度细拆', importance=3)`（成功模式）

---

## 编码阶段

### SP-05：Coder 自检后交付 + 测试两段式

- **描述**：Coder 完成代码后先做最小自检（语法检查/lint/编译/已改文件单测冒烟），确认无基本问题后再交付；测试套件准备与 code 同 wave 并行（只依赖 plan 产物），执行段在 code 完成自检后立即触发，不等 Coder 通知。
- **复用建议**：减少 Tester 因编译错误或基本语法问题被动打回的次数；两段式让测试准备与编码并行、执行紧贴自检完成，缩短串行等待。
- **dsh-mneme 语义**：`memory_save(type='history', title='SP-05 Coder 自检后交付+测试两段式', importance=3)`（成功模式）

---

## 测试阶段

### SP-06：Spec 驱动测试（非 Manager 驱动）

- **描述**：Tester 收到任务后自主读取 spec.md 的 Acceptance Criteria 构建测试集，不等待 Manager 逐条下达。
- **复用建议**：减少 Manager 的沟通开销，Tester 的测试更全面（spec 覆盖度更高）。
- **dsh-mneme 语义**：`memory_save(type='history', title='SP-06 Spec 驱动测试', importance=4)`（成功模式）

### SP-07：每次打回记录失败模式

- **描述**：Tester/Reviewer 每次打回时，在打回裁定中附带失败模式标签（如"需求偏差/spec 不清晰/实现遗漏/测试不足"）。
- **复用建议**：为 Doc-Manager 复盘积累结构化失败数据，便于根因分析。
- **dsh-mneme 语义**：`memory_save(type='history', title='SP-07 每次打回记录失败模式', importance=4)`（成功模式）

---

## 审查阶段

### SP-08：打回时附带 MUST-FIX 清单

- **描述**：Reviewer 打回 REWORK 时，必须输出结构化 MUST-FIX 清单（条目编号、预期行为、严重级别），不输出模糊描述。
- **复用建议**：减少 Coder 理解打回意图的认知开销，提高返工效率。
- **dsh-mneme 语义**：`memory_save(type='history', title='SP-08 打回时附带 MUST-FIX 清单', importance=3)`（成功模式）

---

## 复盘阶段

### SP-09：复盘必读 6 类产出物

- **描述**：Doc-Manager 复盘时逐个读取 Leader 决策包、Designer 四件套、Coder 代码、Tester 报告、Reviewer 裁定、Supervisor 验收报告——缺一不可。
- **复用建议**：缺失任何一类产出物，复盘结论的完整性就有缺口。
- **dsh-mneme 语义**：`memory_save(type='history', title='SP-09 复盘必读 6 类产出物', importance=4)`（成功模式）

### SP-10：成功/失败模式结构化入库

- **描述**：每轮复盘提取的模式必须分类写入 dsh-mneme：成功模式 `memory_save(type='history', ...)`、失败模式 `memory_save(type='decision', ...)`，且每条标注归属阶段。
- **复用建议**：结构化入库确保后续 Doc-Manager/Coordinator 能按阶段与类型检索复用。
- **dsh-mneme 语义**：成功模式 `memory_save(type='history', title='SP-10 成功/失败模式结构化入库', importance=4)`；失败模式 `memory_save(type='decision', title='SP-10 失败模式入库', importance=4)`

---

## 入库脚本（可选）

如果希望将以上种子批量写入 dsh-mneme，可用以下 memory_save 命令逐个写入（成功模式 `type='history'`，失败模式 `type='decision'`，importance 3~4）：

```python
# 示例：批量写入种子（dsh-mneme）
# memory_save(type='history', title='SP-01 前后端分离+依赖链路粗拆',
#             content='按前后端分离（BE/FE/Both）标注子模块，再按依赖链路排序。', importance=3)
# memory_save(type='history', title='SP-02 约束清单逐项对照',
#             content='粗拆后逐项对照 Leader 约束清单 4 类约束，确保不越界、不遗漏。', importance=3)
# memory_save(type='history', title='SP-03 单子模块逐个迭代',
#             content='每子模块独立过设计排期→细拆→执行→验收→复盘全链路，不并行处理多个子模块设计。', importance=3)
# memory_save(type='history', title='SP-04 API 粒度细拆',
#             content='Coordinator 先按 spec.md API 定义将 Coder 任务细拆到单个 API 级别（task-tree.json），Designer 再消费产出任务包。', importance=3)
# memory_save(type='history', title='SP-05 Coder 自检后交付+测试两段式',
#             content='Coder 最小自检通过后交付；测试套件准备与 code 同 wave 并行，执行段在自检完成后立即触发。', importance=3)
# memory_save(type='history', title='SP-06 Spec 驱动测试',
#             content='Tester 自主读取 spec.md Acceptance Criteria 构建测试集，不等待 Manager 逐条下达。', importance=4)
# memory_save(type='history', title='SP-07 每次打回记录失败模式',
#             content='打回时附带失败模式标签，为 Doc-Manager 复盘积累结构化失败数据。', importance=4)
# memory_save(type='history', title='SP-08 打回时附带 MUST-FIX 清单',
#             content='Reviewer 打回 REWORK 时输出结构化 MUST-FIX 清单（编号/预期行为/严重级别）。', importance=3)
# memory_save(type='history', title='SP-09 复盘必读 6 类产出物',
#             content='复盘逐个读取 Leader 决策包/Designer 四件套/Coder 代码/Tester 报告/Reviewer 裁定/Supervisor 验收报告。', importance=4)
# memory_save(type='history', title='SP-10 成功/失败模式结构化入库',
#             content='每轮复盘提取的模式按成功/失败分类写入 dsh-mneme，并标注归属阶段。', importance=4)
```

首轮运行时，建议至少写入 SP-01、SP-04、SP-06、SP-09、SP-10 作为最小种子集。
