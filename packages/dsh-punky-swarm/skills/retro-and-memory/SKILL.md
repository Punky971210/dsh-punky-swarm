---
name: retro-and-memory
description: |
  审计层复盘角色（doc-manager）的操作手册：批次收口时产出结构化复盘报告（retrospective-report.md）
  并把可复用经验沉淀进跨会话记忆（dsh-mneme 优先，Mnemopi 仅作降级路径）。
  需要"这个批次学到什么、下次怎么避免、哪些模式值得复用"时加载。
version: "1.0.0"
kind: skill
triggers:
  - "批次复盘"
  - "retrospective"
  - "经验沉淀"
  - "记忆沉淀"
  - "成功模式 / 失败模式"
  - "归档收口"
---

# retro-and-memory — 复盘与记忆沉淀手册（doc-manager）

> 替代旧 `archive` / `comet-archive` 的收口用法；文档生成仍用 `doc-generator`（保留技能）。
> 本角色是**审计层**：产出复盘与记忆，**不改业务源码、不改 spec**。

## 1 角色边界

- **可执行**：read/glob/grep/write/skill + `memory_save`/`memory_search`（记忆沉淀：dsh-mneme 优先，Mnemopi 降级）。
- **禁止**：改业务源码、改 spec、改门禁产物（acceptance-report / gap-list 归 supervisor）。
- **命名即文档**：归档文件名用 kebab-case，从名字可推断用途；不写 `tmp`/`untitled` 一类无意义名。

## 2 复盘方法（证据驱动，不是感想）

1. **拉事实基线**：读批次事件流（`log_export`）、`batch_status`、`gap-list.json`、各 lane 的 checkpoint/结算记录。
   复盘结论必须以**事件与产物**为据 —— 不采信"我记得当时…"。
2. **四栏对账**：
   - **做对了什么**：可被复用的做法（带证据：哪条 lane、哪个产物、什么信号证明有效）。
   - **错在哪**：失败/返工 lane 的**根因**（不是现象），如"漏 import 导致跨文件断裂"而非"测试失败"。
   - **门禁拦住了什么 / 漏放了什么**：gate 事件里出现过的拒码、以及本应触发却未触发的门禁。
   - **下次怎么做**：写成**可执行动作**（加什么断言、在哪一步先摸底、派发时补什么声明），不写"要加强意识"。
3. **模式提炼**：
   - 成功模式 → `memory_save(type=history 或 project, importance 3~4)`；
   - 失败/踩坑 → `memory_save(type=pitfall 或 decision, importance 3~4)`（症状 + 根因 + 修法三段式）；
   - 参考 `skills/software-team/references/templates/success-pattern-seeds.md` 的等价写法。
4. **去重**：沉淀前先 `memory_search` 查同题；已有条目则**更新**而非新增（避免记忆库注水）。

## 3 产出契约

```
<产物根>/audit/retrospective-report.md      ← 四栏对账 + 模式提炼 + 下批建议
记忆条目：memory_save 调用记录（type/title/importance），在报告末尾列出条目标题以便溯源
```

- 声明为 lane 的 `produce` 时必须落盘（exit 门禁会核）。
- 复盘**只写结论与证据指针**，不复制大段日志正文（省 token，也便于审计）。

## 4 与门禁的关系

| 门禁 | 本角色的义务 |
|---|---|
| entry | `consume` 齐备才能派发（通常消费 audit 的 acceptance-report + gap-list） |
| exit | `produce` 声明的复盘产物必须存在 |
| needHuman | 复盘若需人裁决（如"是否放弃该方向"），写独立行 `needHuman: true` + merged 带 `human:` 证据 |
| complete | 复盘 lane 的 outcome 须落在团队 `require_audit_outcomes` 内，否则批次无法 complete |

## 5 自检清单

- [ ] 每条结论都有事件/产物证据指针（lane id、事件类型、文件路径）
- [ ] 失败项写的是根因，不是现象
- [ ] "下次怎么做"是动作，不是口号
- [ ] 沉淀前查过重（`memory_search`），未新增重复条目
- [ ] 未修改任何业务文件 / spec / 他人的门禁产物
