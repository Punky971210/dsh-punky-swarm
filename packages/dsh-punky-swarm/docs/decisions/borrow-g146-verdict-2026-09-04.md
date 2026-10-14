# borrow-g146 · 三视频方法论借鉴事项（G1/G4/G6）验收与搁置留档

> 批次：`borrow-g146`（session-9d524b4b-9e81-461a-b956-87dbfd1d2689）｜状态：complete（2026-09-04）｜audit 人工裁决：`human:user@2026-09-04:accept`——验收通过、实施搁置，仅留档与记忆录入。
> 批次产物根：`~/.dsh/jiufeng/sessions/session-9d524b4b-9e81-461a-b956-87dbfd1d2689/artifacts/borrow-g146/`

## 一、背景与来源

以「三视频方法论 vs 蟛蜞模式插件」对照分析（素材综述：`D:\蟛蜞小记\bili-summary\out\AI_agent工作流_三视频_合并综述.md`）为输入，对照三个视频的方法论：

- BV1kCbR6YEgX《焚诀》——聊清楚与写代码分线程，grill→spec→goal/fork→task 自动回传；
- BV16MtE6oEfd——Anthropic 官方 AI 原生 SDLC（intent.md→spec→plan artifact chain、worktree、hooks、PR 门禁、CI 评估）；
- BV1r8tJ6aECx——Loop Engineering 课程（Goal–Act–Observe–Evaluate、错误处理/重试六问、checkpoint/幂等、上下文预算）。

对照结论：验证面 13 处与蟛蜞既有机制同构（门禁化完成标准、护栏边界、checkpoint 不自动续跑、worktree、needHuman、难度路由、Leader 上下文精简）；借鉴面筛选出 G1/G4/G6 三项，经用户裁决：G1、G4 值得做，G6 排期另设。本批完成三事项的方案产出与 audit 验收；**实施全部搁置**（见 §四）。

## 二、方案（三项，均为产出物，未落地实施）

### G1 · 失败结算 note 六问结构化（文档/指引层）

将 `member_settle(failed)` 的 note 从自由文本升级为六问压缩结构，辅助 Manager 裁决「重开 or 终态」，对齐 Loop Engineering 错误处理课「重试六问」。

- 模板六字段：`attempt`（允许尝试次数）/ `gap`（间隔退避）/ `budget`（超时预算）/ `sideFx`（副作用防护）/ `verifiable`（重试有效性验证）/ `escalate`（停止升级条件）；配 reopen（Leader 重开新批）/ terminal（终态归档）/ escalated（升级人工）三向判读表。
- 红线：仅约束 note 元数据；failed 终态不变、重做=重开新批次、不引入自动续跑；gate/needHuman/targets 契约与状态机零变化。
- 改动位点候选（实测）：`roles/manager.md` L19（建议改）、`SKILL.md` L42/L106（建议改，另 L100 待澄清）、`agent.cordis.yml` L49 纪律 5（建议改）、`docs/governance-technical.md`（建议**不改**，避免引擎手册与指引层漂移）、`templates/` 新增 `settle-failed-six-questions.md`、用户镜像副本双写同步（仓库装配源为单一事实源）。
- 落地稿：`exec/g1/six-questions-template.md`（v1 全文）；改动建议稿：`exec/g1/guide-draft.md`。

### G4 · review 驳回修正意见回投（调研 + 路径决策，推荐指引层协议化）

调研「驳回时把修正意见自动投回 lane」的可行性（对齐《焚诀》v3 全自动回传循环）。

- **引擎能力核实**：mailbox 三箱物理映射 inbox→`supervisor/inbox`（无 per-lane inbox）、outbox→`<lane>/outbox`、broadcast→根级；原子写+ackId、ack 默认即删、sweep TTL 7d/quarantine 30d、未 ack 永不清；收件感知=纯拉取 `mailbox_read`，无事件推送；`member_settle`/`store.setMember` **零 mailbox 副作用**（引擎自动投递现状无实现，机制上可做但改动面=结算分支+事件类型+装配开关，落点候选已列供另批）。
- **真实使用率**（379 批次 json 全量）：merged 1286 / conflict 仅 4 / failed 仅 7 / review→running 返工仅 4——对 merged ≈1%，**目标场景罕见**；mailbox 213 个批次根有文件、现存 734 消息（inbox 292/outbox 345/broadcast 97）；note 全为自由文本无结构化；现协议已有「回投雏形」真实样例（Manager→inbox `settle-blocked`/`dispatch-advice`，meta from:manager to:leader，含 evidence 引用）。
- **推荐路径**：指引层协议化半自动回投（correctionRefs 引用契约 `{artifactPath,itemId,reason}`，只写元数据不复制正文）；引擎自动投递入 backlog（1% 量级不支撑投入）。C3 引擎小改不采纳，落点候选留档供驳回频率上升时另批。
- 调研报告：`exec/g4/mailbox-report.md`。

### G6 · 需求采集 intent 产物化（设计稿 + 排期，未实施）

对齐 Anthropic AI 原生 SDLC 的 intent.md：发起人/代理访谈→痛点提炼→intent 文档产物化进入批次，与现有 grilling 技能衔接。

- intent 模板六要素：意图/背景与领域上下文/预期结果/范围（含排除）/约束与风险/成功证据（EVID-* 直通 spec 验收→plan 检查项→audit 四层一致链）；附 PAIN-*、OPEN-* 与 frontmatter 状态机（draft→confirmed→superseded）。
- 批次位置：workflow.md §二 步骤①改写为 ①a 需求采集（intent.md confirmed）→①b 粗拆（Leader consume intent）；产物契约表/模板映射表加 intent 行；采集主体推荐 Coordinator 扩展职责 + Leader confirmed 确认闸。
- grilling 衔接：三模式零改动全复用，新增「intent 采集衔接」节与「质询结论回写 intent.md」产出契约。
- 引擎影响：v1 指引层落地不需改引擎；artifact_types 注册/plan 契约强制校验=引擎改动，另批、试点证据触发。
- 排期：S1 模板先行 → S2 流程插入（C 批+audit）→ S3 试点验证 → S4 引擎增强（证据触发）。
- 设计稿：`exec/g6/g6-design.md`。

## 三、audit 验收结论

auditor 独立核验（不盲信 exec，亲测源码/位点/样例原文），三 exec 产物全部 ✅，gap 8 条全轻微无阻塞（plan 层 2：scope 契约路径滞后 wavePlan targets、grilling 行数过时 59→80；G1 2：SKILL.md L100 位点、措辞；G4 1：统计为抽样核验；G6 1：引擎落点待引擎 lane 接力；流程 1：会话隔离须显式 session；交叉 1：六问 reopen 与返工通道区分）。

验收报告：`audit/review.md`（含逐条对照表、gap-list、人工裁决表）。

## 四、决策（用户裁决 2026-09-04）

1. **验收通过**：三产物（G1 模板+改动稿 / G4 调研报告 / G6 设计稿）与 audit/review.md 全部收编留档。
2. **实施搁置**：G1 不合入指引、G4 不落地 correctionRefs 协议、G6 不启动 S1 排期——三项作为已验收方案留档，待后续另行发起实施批次（决策证据 `human:user@2026-09-04:accept`）。

## 五、设计依据摘要（为何如此设计）

- **G1**：Loop 12 课「重试可能掩盖生产问题」→ failed 终态语义 + 六问结构化 note 只辅助裁决不改变状态机；note 属指引层约定，引擎技术手册描述强制语义，故 C1-3 不改 governance-technical.md。
- **G4**：引擎自动投递=结算副作用（改 store.js setMember + 事件类型 + 装配开关），而目标场景实测 ≈1%（conflict 4/failed 7/返工 4 vs merged 1286）→ 引擎投入不划算，指引层 correctionRefs 契约零引擎改动先满足「驳回有修正指引」；会话分根（mailbox 落 worker 会话非批属会话）风险要求任何回投方案显式对齐 session（纪律 0a）。
- **G6**：intent 产物化=把「访谈→痛点→文档」从口头流程变成批次一等产物，EVID-* 直通四层一致链使验收标准可追溯；v1 纯指引层（wave_plan consume/produce 为相对路径+存在性校验，intent 归 plan/ 前缀即可），引擎增强（类型注册/强制校验）以试点证据触发、缺证据不开。

## 六、产物索引（批次产物根 artifacts/borrow-g146/）

| 产物 | 路径 |
|---|---|
| 实施范围与验收基准 | `plan/scope.md` |
| G1 改动建议稿 | `exec/g1/guide-draft.md` |
| G1 六问模板 v1 | `exec/g1/six-questions-template.md` |
| G4 调研报告 | `exec/g4/mailbox-report.md` |
| G6 设计稿 | `exec/g6/g6-design.md` |
| audit 验收+裁决表 | `audit/review.md` |
