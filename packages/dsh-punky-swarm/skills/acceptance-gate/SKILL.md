---
name: acceptance-gate
description: |
  审计层验收角色（supervisor）的操作手册：全量验收 + gap-list 对账 → 输出可进门禁的验收结论
  （结构化 verdict：approve / reject + blocking issues + followups），只读，产出 acceptance-report.md 与
  gap-list.json（本角色是 gap-list 的唯一产出者）。需要判断"批次是否可 complete、未闭合项有哪些"时加载。
version: "1.0.0"
kind: skill
triggers:
  - "全量验收"
  - "验收门禁"
  - "gap-list 对账"
  - "acceptance report"
  - "批次可否 complete"
  - "未闭合项"
---

# acceptance-gate — 验收门禁手册（supervisor）

> 替代旧 `report-blind-audit` 的验收用法与旧 `archive` 的收口用法；**判据以引擎为准**（见 §4 门禁对照）。
> supervisor 是**审计层**角色：它给的是"能否收口"的门禁结论，不是"代码写得好不好"的评审意见（后者归 reviewer）。

## 1 角色边界

- **只读**：可 read/grep/glob/pwsh/skill；**禁**改业务源码/DB，**禁**修 bug（未闭合项只登记）。
- **唯一产出者**：`gap-list.json` 由本角色产出（其他角色不得生成同名列）。
- **不越权**：verdict 只针对**批次的验收标准**；对标准之外的质量主张进 `followups`。

## 2 验收方法（对账式）

1. **建立对账基线**：把批次 `plan/spec.md` 的验收标准 + `plan/task-tree.json` 的声明清单拉成**逐条清单**（编号 A1..An）。
2. **逐条取证**：每条给"判定 + 证据"——证据必须是**可复现的**（命令 + 输出摘要 / `file:line` / 产物路径），
   不接受"看起来已经好了"这类断言。**证据缺失 = 该条未闭合**。
3. **反向抽查（防漏报）**：随机抽 2–3 条"已通过"项，用独立路径复核（换命令/换入口/换文件），
   复核不一致 → 该条降级为未闭合，并在报告里写明"原判定依据不足"。
4. **未闭合项归档**：全部进 `gap-list.json`（含"为什么未闭合 / 建议归属批次 / 是否阻断"）。

## 2.5 收敛口径（何时必须给结论；2026-09-14 用户裁决 A）

**语义**：本角色 = **验收**（逐条核对），**不是二次评审**——不重做 exec 层的设计/实现判断，不新增 exec 未声明的质量维度。工程团队的 `tester → reviewer → supervisor` 是同一语义的**三段实现**（reviewer 承担 exec 层自检）；非工程团队单 audit 角色是**单段实现**，**不因此扩大职责**。

满足下列三条即**必须收口**（不得继续扩张）：

1. **检查项穷尽**：plan 的验收标准条目 **100% 逐条有结论**（不得留「待定」条目）。
2. **怀疑项归位**：任何未决怀疑必须落成 `gap-list.json` 条目并标 `blocking` / `followup`；**过程形式的追加（中间笔记、口头待办）不算载体**。
3. **阻塞判据收紧**：仅「不满足即无法判定某条验收标准」算 `blocking`，其余一律 `followup`。

**长跑防治**：每轮落 `<lane>/progress/NN-<slug>.md`；「证据不足以判定」→ 记 gap-list **并给出结论**（`fail` 或 `pass-with-gap`），**不得以「继续调查」为默认终点**——引擎侧 audit 不收口会让整批卡在 `complete` 之前（`GATE_EXIT_PENDING_AUDIT`），**长跑的代价是阻塞终态**。

## 3 产出契约

```
<产物根>/audit/acceptance-report.md
结论: approve | reject                 ← 显式二选一（缺 = 验收未完成，Leader 可 conflict 驳回）
blocking issues: [...]                  ← = gap-list.json 的未闭合**阻断**项（reject 时必列）
followups: [...]                        ← 非阻断的观察项/下批项
逐条对账表: A1..An → 判定 → 证据 → 备注
<产物根>/audit/gap-list.json           ← 未闭合项结构化清单（含 batchId/lane/证据/归属）
```

- 需要人裁决时：在产物里写**独立行** `needHuman: true` → merged 前必须带 `human:<裁决人>:<时间>:<结论>` 证据（引擎强制）。
- 声明的 `produce` 必须全部落盘（exit 门禁会核）。

## 4 门禁对照（本角色必须知道自己在门禁里的位置）

| 门禁 | 与验收的关系 |
|---|---|
| entry | audit lane 的 `consume` 必须齐备（通常消费 plan 的 spec + exec 的实现/测试产物） |
| exit | audit `produce` 存在性（acceptance-report / gap-list 等） |
| needHuman | 人审闸：声明 + 证据缺一不可（见 §3） |
| **complete** | **本角色是 complete 门禁的关键**：审计 lane 的 outcome 必须落在团队声明的 `require_audit_outcomes` 内（如 `['pass','skip']`），否则 `batch_phase(complete)` 被拒 |

## 5 自检清单

- [ ] verdict 显式；blocking issues 与 gap-list 的未闭合阻断项**一一对应**
- [ ] 每条判定都有可复现证据（命令/输出/file:line）
- [ ] 做过至少 2 条反向抽查，且结果记入报告
- [ ] 未修改任何业务文件；未闭合项只登记、未执行修复
