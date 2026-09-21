# C1 生产未接线 26 项 · 三选一判读台账（N2 第一批，2026-09-22 01:5x）

**裁定背景**：用户令「只做内核改装和接线使用必要的项目」⇒ N2 解冻 C1（W2 冻结，`frozen-register §1` + `docs/audit-2026-09-21-unwired.json` C1=29 条 ≈26 逻辑项，js/ts 重复计）。
**方法**：逐项取代码证据判读，**不以蓝图意向为准**（蓝图 §150 的「6 守卫接线」经证据全部修正，见 §2）。
**结论总览**：真接线 **0** · 降级登记 **22** · 缓（设计题）**2** · 删 **1**（缓至第二批，连带 11 处测试）。

---

## §1 蓝图意向 vs 代码证据（本批核心产出：避免 6 处错误接线）

| 蓝图意向（§150「接线并改返回结果对象」） | 代码证据 | 修正处置 |
|---|---|---|
| `assertMemberTransition` / `assertBatchTransition` 接线 | `store.js:805/821` **已在役** `machine.applyMemberTransition`（machine-rules，带 ratchet 注入，更强）；接线 = **双判定源**，违反「禁第二套」纪律 | ❌ 不接线 ⇒ **降级登记**（声明面兼容导出；判定真源 = machine-rules） |
| `sweepExpiredHandles` 接线（心跳/生产清扫） | **过期句柄正是绑定缺口探针的信号面**（`bindingGapOf` 消费 `token-ttl-expired` 判「幽灵悬挂意图」）；自动清扫会**抹掉缺口信号** | ❌ 不接线 ⇒ **降级登记**（显式维护钩子；句柄量级 = 派发频次，内存可忽略） |
| `clearFlowCache` / `clearRoleCache` 接线（热更失效） | 两缓存是 **sig 自愈型**（`flows.js:81/294`：sig = 资产路径+mtime+size，变即重读）⇒ 热更/资产变更**无需清**；本质 = 测试隔离钩子 | ❌ 不接线 ⇒ **降级登记**（测试隔离钩） |

## §2 逐项终裁（26 逻辑项）

| # | 文件 | 符号 | 测试引用 | 处置 | 依据 |
|---|---|---|---:|---|---|
| 1 | assembly/flows.js | `clearRoleCache` | 85 | **降级**（测试隔离钩） | §1 sig 自愈 |
| 2 | assembly/flows.js | `clearFlowCache` | 67 | **降级**（测试隔离钩） | 同上 |
| 3 | bridge/lane-handle.js | `__resetLaneHandles` | 66 | **降级**（测试隔离钩） | 测试基础设施 |
| 4 | assembly/schema.js | `validateAssembly` | 11 | **删**（撤函数保常量表：`BLIND_REVIEW_ROLES` 被 wave-plan 消费）——缓至第二批（连带 11 处测试改判） | frozen-register 三选一③ |
| 5 | governance/escalation.js | `DEFAULT_ESCALATION_WINDOW_MS` | 10 | **降级**（声明面常量，测试锁值） | 无生产调用点 |
| 6 | aip/agent-descriptor.js | `ACS_REQUIRED_FIELDS` | 9 | **降级**（声明面） | 同上 |
| 7 | state/event-types.js | `EVT_CHAIN_STEP` | 9 | **退役登记**（链自动推进已退役 Q-A=C；常量冻结保留历史读端，同 `GATE_CONCURRENCY_BLOCKED` 先例） | 事件常量不判可达性 |
| 8 | auditlog/sink.js | `auditlogStats` | 8 | **降级**（观测面） | — |
| 9 | acps/registry-client.js | `decryptEabCredential` | 7 | **降级**（声明面） | — |
| 10 | artifact-types.js | `artifactTypeOf` | 7 | **缓 · 设计题**：唯一有意义接线点 = gates 产物类型一致性校验（produce ∈ typesOfLayer(layer)），属**行为变更**（新增拒态），须单独裁定 | gates.ts 零引用；类型面无在役消费 |
| 11 | acps/registry-client.js | `API_BASE_PATH` | 6 | **降级** | — |
| 12 | assembly/audit-blind-review.js | `BLIND_REVIEW_ORDER` | 6 | **降级** | — |
| 13 | artifact-types.js | `typesOfLayer` | 5 | **缓 · 设计题**（同 #10） | 同上 |
| 14 | engine/dispatch.js | `parseLabel` | 5 | **降级**（B3 声明面；绑定探针若需反解析 label 再议接线） | — |
| 15 | governance/state-store.js | `clearSessionState` | 5 | **降级** | — |
| 16 | acps/discovery-client.js | `flattenAgentSkills` | 4 | **降级** | — |
| 17 | auditlog/sink.js | `sinkFilePath` | 4 | **降级** | — |
| 18 | aip/identity.js | `isEntityAic` | 3 | **降级** | — |
| 19 | wave-plan.js/.ts | `MANAGER_PLANS` | 3 | **降级**（声明面） | — |
| 20 | acps/registry-client.js | `ATR_BASE_PATH` | 2 | **降级** | — |
| 21 | aip/agent-descriptor.js | `ACS_SKILL_REQUIRED_FIELDS` | 2 | **降级** | — |
| 22 | bridge/lane-handle.js | `sweepExpiredHandles` | 2 | **降级**（探针信号面，§1） | — |
| 23 | state/lane-exempt.js | `DEFAULT_THRESHOLD_MULTIPLIER` | 2 | **降级** | — |
| 24 | state/machine.js | `RATCHET_RULES` | 2 | **降级**（棘轮表声明面；判定真源 = `loadRules` 注入表） | — |
| 25 | schema.js/.ts | `assertMemberTransition` | 1 | **降级**（真源 = machine-rules，§1） | — |
| 26 | schema.js/.ts | `assertBatchTransition` | 1 | **降级**（同上） | — |

## §3 批次切分

- **本批（已落地）**：判读落档 + 6 处关键定义点打处置标记（防后人按蓝图错误接线）+ `EVT_CHAIN_STEP` 退役登记 + `frozen-register §1` 回填裁定指针。**零行为变更、零测试改动**。
- **第二批（待开工）**：`validateAssembly` 删除（连带 11 处测试改判；撤函数保 `BLIND_REVIEW_ROLES`/`PRODUCE_LAYERS`/`FLOW_SECTIONS` 常量表）。
- **第三批（设计题，须裁定）**：gates 产物**类型一致性**校验（produce ∈ `typesOfLayer(layer)`）—— 行为变更（新增拒态），裁定后 `artifactTypeOf`/`typesOfLayer` 才接线；不裁则永久降级。

## §4 与蓝图/台账的对账

- `new-engine-blueprint-2026-09-21.md §6`「6 守卫接线」行 ⇒ **以本台账为准修正**（证据优先于蓝图意向）；
- `frozen-register-2026-09-21.md §1` ⇒ C1 26 项自本批起**状态 = 已判读**（三选一已落，见 §2；不再等「新引擎形态」）；
- `reachability-ledger`（守卫可达性 119 条）与本题**正交**（那是「守卫可达吗」，这是「未接线的导出符号怎么处置」），勿混。

## §5 第二批落地（2026-09-22 02:1x，commit 745d27b）

- `validateAssembly` 已删（lib/assembly/schema.js；撤函数保常量表：BLIND_REVIEW_ROLES/BLIND_REVIEW_TEMPLATE_KEYS/CAPABILITY_REGISTRY/EXCLUSIONS/REQUIRED_ROLES 全保留）。

- 判定真源 = 在役 `assertAssemblyCompleteness`（视图 1 严格覆盖原形状校验且更强；在役消费方 `audit-blind-review.js`）。

- 测试迁移：assembly-schema.test.js 两个自产自销用例 → 迁移到在役判定源（DEFAULT_ASSEMBLY ok + 5 类畸形 not ok），行为覆盖不丢。

- 验收：受影响套件绿；全量 1783/1757/22 fail/4 todo（4 预期红 + 18 环境类 ⇒ 非环境类 0）；基线 152/1738/8425（asserts -2）；pkg-hashes 424。

- **C1 26 项至此全部闭合**（22 降级 + 2 设计题挂起 + 1 删 + 1 历史退役登记）。剩余开放项：第三批类型一致性（须裁定）。

## §6 A3③ 判据配置化延伸 · 收口普查（2026-09-22 02:1x）

普查 `lib/state/gates.ts` 判据面：**硬编码章节字面量零残留** —— `criteria_section`（audit 声明键）/ `required_sections`（plan 声明键）双通道齐备，缺声明回落单一真源 `ENGINE_BASELINE_*` 并落首触事件。⇒ **A3③「判据配置化」完备，N2 全部闭合**；延伸无剩余项。
