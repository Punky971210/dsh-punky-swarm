# probe 通道探针（plan 层 · coordinator）

## 概述

本 lane 为引擎自派通道探针：目标指令为「回复 OK」，不承载实现型工作。本文件记录探针结论与目标回执，作为本 lane 的 plan 层产物。

## 问题

需确认「引擎自派 worker → 成员落产物 → 回报 Leader」这条链路在真实宿主下可通。可疑点有三：任务包能否正确带出批次产物根与批归属会话；worker 能否在产物根落盘；回报能否回到父 agent。

## 方案

按最小可核路径执行：只读侦察批次（`batch_status` / `gate_status` / `task_pool` / `handoff_view`）→ 落 `plan/probe.md` → 向父 agent 回报。不做任何实现型改动，不碰工作区源码。

## 需求

- 批次 `probe-e1` 存在且 lane `probe` 为在册任务（已核：pooled=0 / dispatched=1）。
- lane 层级为 plan，产物面声明 `plan/probe.md`。
- 本 lane 入边 0 条、出边 0 条（已核 `handoff_view`：`READY (edges=0)`），批内仅此 1 条 lane、无 audit 层 ⇒ 无交接义务。

## 验收标准

- 批次产物根下存在 `plan/probe.md`，且含六个裸标题（概述 / 问题 / 方案 / 需求 / 验收标准 / 约束）。
- 进度快照 `probe/progress/01-*.md` 落盘。
- 已向父 agent `session-01aceb50-838f-4e95-b4db-8266c2195b03` 显式回报结论（含 `knowledge_hits` / `skills_used` / `mcp_used`）。

## 约束

- 只碰本 lane 文件域；禁 `git` 写、禁重启宿主。
- 写盘只走 `write`/`edit`，UTF-8 无 BOM、LF。
- 探针性质：本批已标 `SMOKE`（产物契约类门豁免），不做代码摸底以外的扩展调研。
