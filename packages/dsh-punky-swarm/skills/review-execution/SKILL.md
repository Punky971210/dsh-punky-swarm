---
name: review-execution
description: |
  执行层评审角色（reviewer）的操作手册：对代码/产物做**对抗式审查**，对照 spec 与验收标准输出
  **结构化 verdict**（approve / reject + blocking issues + followups），只读不改码，缺陷走报告不自行修复。
  适用于 lane 角色为 reviewer 的评审任务，或需要判断"这份实现是否达标、阻断项有哪些"时加载。
version: "1.0.0"
kind: skill
triggers:
  - "对抗式审查"
  - "评审代码"
  - "review"
  - "输出 verdict"
  - "MUST SHOULD FYI 分级"
  - "阻断项清单"
---

# review-execution — 评审执行手册（reviewer）

> 本技能替代旧 `code-review-guideline`（已退役）与旧 `pr-review-team` 的评审用法，但**职责语义以引擎为准**：
> reviewer 是**执行层**角色（不是审计层），产出评审报告与 verdict，**不承担验收门禁**（验收归 supervisor）。

## 1 角色边界（先读这条，防越权）

- **只读**：可 read/grep/glob/pwsh/skill；**禁**改业务源码、禁改 spec、禁修 bug。
- **不自行修复**：发现问题 → 写进报告的 `blocking issues` / `followups`，修复**必须经新批次 exec lane** 执行。
- **不自行验收**：不要写"验收通过"这类结论词 —— 验收结论归 supervisor（见 `acceptance-gate`）。
- **命名纪律**：lane 名用 `audit-accept` / `audit-verify` 一类中性名；**禁止**把"修复""定论""方案评估"写进任务名。

## 2 审查方法（对抗式，不是附和式）

1. **先对齐判据**：读取该 lane 的 `consume` 上游（spec / task-tree / 实现产物）与 `plan/spec.md` 的验收标准章节；判据缺失 → 作为 blocking issue 提出（"无判据可依"本身是缺陷）。
2. **逐项对照**：按 spec 的验收标准逐条比对实现，**每条给证据**（`file:line` + 关键片段），不凭印象下结论。
3. **主动找反例**：对每条"看起来通过"的项，尝试构造**会让它失败**的输入/边界；构造不出再标通过。
4. **只在判据内下结论**：判据没写的维度，只能进 `followups`，不得升级为 blocking（**审计者不得越权裁决优劣**）。

## 3 产出契约（结构化 verdict 必填）

产物落 `<产物根>/exec/review-<lane>.md`（或按批次 produce 声明落盘），必须含：

```
结论: approve | reject          ← 显式二选一，缺了视为评审未完成
blocking issues:                ← reject 时必列；approve 时可为空
  - [B-1] <现象> | 证据 file:line | 与哪条验收标准冲突
followups:                      ← 跟进项（非阻断）
  - [F-1] <观察> | 建议归属（下批/观察项）
证据对照表: <验收标准条目> → <实现位置 file:line> → <判定 PASS/FAIL + 依据>
待 Leader 处置的 gap 清单:      ← 只登记；**不得由本 lane 执行修复**
```

**反例（会被打回）**：只写"总体没问题""建议合并""验收通过"——无 approve/reject、无阻断项、无跟进项，
视为**评审未完成**，Leader 可按 conflict 驳回要求补全。

## 4 与门禁的关系

| 门禁 | 本角色的义务 |
|---|---|
| entry | `consume` 必须在派发前齐备（引擎强制，不齐则拒派） |
| exit | `produce` 声明的产物必须落盘（否则拒 merged） |
| 内容契约 | 产物命中团队 `contract.artifact_globs` 时须含声明章节 |
| needHuman | 若评审结论需要人裁决，在产物里写独立行 `needHuman: true` → merged 须带 `human:<裁决人>:<时间>:<结论>` 证据 |
| 命令 gate | 若产物声明了 `gate: <命令>`，merged 前引擎会确定性执行，exit 0 才放行。**注意「空声明 ≠ 未声明」**（F-7，2026-09-15）：写了 `gate:` 行却**没给命令**（空行/仅空白/尾随空格）⇒ **拒 `GATE_EXIT_NO_COMMAND`**（lane 留 review + `gate.exit_blocked`）；**完全没写** `gate:` 行 ⇒ 零感知；`gate: false` ⇒ 显式关闭留痕（`command-declared-off`），不拒 |

## 5 自检清单（提交前逐条过）

- [ ] verdict 是 `approve` / `reject` 之一（不是"建议""倾向"）
- [ ] 每条 blocking issue 都有 `file:line` 证据与对应判据
- [ ] 没有把"我觉得可以更好"写成 blocking（那是 followup）
- [ ] 没有修改任何业务文件（只写了报告）
- [ ] gap 清单只登记、未执行
