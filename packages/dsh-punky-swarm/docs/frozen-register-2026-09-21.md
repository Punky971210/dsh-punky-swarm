# 冻结登记 · 2026-09-21（R2 清理波）

> 本文件是**冻结项的单一台账**。冻结 = 「已声明但当前不接线 / 不修改 / 不删除」，等新引擎形态定后逐项裁定。
> **纪律：本表内任何符号不得被当作 AI 幻觉产物删除。** 撤销冻结必须回到本表逐项改判并留痕。

- 基线：`e3e8cd0` → 清理波后 `5a6ce2a`
- 裁定依据：W2（未接线不接）/ W4（schema 随新引擎形态取舍）/ W6（无断言门禁冻结）
- 复现：`node scripts/audit/dead-code2.mjs && node scripts/audit/classify.mjs && node scripts/audit/gates.mjs`

---

## 1. C1 · 生产未接线（26 项，W2 冻结）

判据：**生产路径零调用，仅测试引用**（且本文件内部也不使用）⇒ 声明面先行、运行面欠账。

| 文件 | 符号 | 测试引用 | ts 源 |
|---|---|---:|---|
| `lib/assembly/flows.js` | `clearRoleCache` | 85 | — |
| `lib/assembly/flows.js` | `clearFlowCache` | 67 | — |
| `lib/bridge/lane-handle.js` | `__resetLaneHandles` | 66 | — |
| `lib/assembly/schema.js` | `validateAssembly` | 11 | — |
| `lib/governance/escalation.js` | `DEFAULT_ESCALATION_WINDOW_MS` | 10 | — |
| `lib/aip/agent-descriptor.js` | `ACS_REQUIRED_FIELDS` | 9 | — |
| `lib/state/event-types.js` | `EVT_CHAIN_STEP` | 9 | — |
| `lib/auditlog/sink.js` | `auditlogStats` | 8 | — |
| `lib/acps/registry-client.js` | `decryptEabCredential` | 7 | — |
| `lib/artifact-types.js` | `artifactTypeOf` | 7 | — |
| `lib/acps/registry-client.js` | `API_BASE_PATH` | 6 | — |
| `lib/assembly/audit-blind-review.js` | `BLIND_REVIEW_ORDER` | 6 | — |
| `lib/artifact-types.js` | `typesOfLayer` | 5 | — |
| `lib/engine/dispatch.js` | `parseLabel` | 5 | — |
| `lib/governance/state-store.js` | `clearSessionState` | 5 | — |
| `lib/acps/discovery-client.js` | `flattenAgentSkills` | 4 | — |
| `lib/auditlog/sink.js` | `sinkFilePath` | 4 | — |
| `lib/aip/identity.js` | `isEntityAic` | 3 | — |
| `lib/wave-plan.js` | `MANAGER_PLANS` | 3 | ✅ |
| `lib/acps/registry-client.js` | `ATR_BASE_PATH` | 2 | — |
| `lib/aip/agent-descriptor.js` | `ACS_SKILL_REQUIRED_FIELDS` | 2 | — |
| `lib/bridge/lane-handle.js` | `sweepExpiredHandles` | 2 | — |
| `lib/state/lane-exempt.js` | `DEFAULT_THRESHOLD_MULTIPLIER` | 2 | — |
| `lib/state/machine.js` | `RATCHET_RULES` | 2 | — |
| `lib/schema.js` | `assertMemberTransition` | 1 | ✅ |
| `lib/schema.js` | `assertBatchTransition` | 1 | ✅ |

### 其中特别标注（属测试基础设施，不可删）

- `lib/bridge/lane-handle.js` `__resetLaneHandles`（66 处测试调用）、`sweepExpiredHandles`
- `lib/assembly/flows.js` `clearFlowCache`（67 处）、`clearRoleCache`（85 处）——测试隔离必需

### 新引擎成型时的裁定口径（三选一，逐项落）

1. **接线**：有安全价值者（`assertMemberTransition` / `assertBatchTransition` / `artifactTypeOf` / `typesOfLayer` / `sweepExpiredHandles` / `clear*Cache`）。参考 jiuwen `agent_teams/tools/task_manager.py` 的 `TaskResult` / `GraphMutationResult`——变更返回**显式结果对象**而非仅 throw。
2. **降级**：测试专用面显式登记为测试钩子（去 `export` 则断测试，故只能保留）。
3. **删**：无价值者（`validateAssembly` / `assertAssemblyCompleteness` 撤函数**保常量表**——`BLIND_REVIEW_ROLES` 被 `wave-plan.ts` 消费、`PRODUCE_LAYERS` / `FLOW_SECTIONS` 被 `team-asset.js` 消费）。

---

## 2. B1 残留 · 真死但自带声明语义（10 项，冻结不删）

判据：**内外皆零引用，但注释自带显式声明语义**（预留格式 / 骨架契约 / 白名单 / 外部规范对齐 / 版本口径 / 读端契约名）⇒ 删除等于替用户裁定「这声明还要不要」。

| 文件 | 符号 | 声明语义 |
|---|---|---|
| `lib/assembly/chain.js` | `CHAIN_VERSION` | 版本口径（`CHAIN_VERSIONS[0]` = 缺省语义版本） |
| `lib/assembly/chain.js` | `CHAIN_GUIDANCE_INJECTS` | `flows.<layer>.guidance.inject` 白名单（禁自由文本） |
| `lib/assembly/flows.js` | `flowsDeclarationOf` | 自述「gateStrength / 诊断面板的取数入口」 |
| `lib/discovery/schema.js` | `FORWARD_DEPTH_LIMIT_DEFAULT` | 节标题「与 `acps_sdk/adp/constants.py` 一致」⇒ 外部规范对齐表 |
| `lib/discovery/schema.js` | `FORWARD_FANOUT_LIMIT_DEFAULT` | 同上（外部规范对齐表） |
| `lib/discovery/schema.js` | `FORWARD_EACH_TIMEOUT_MS_DEFAULT` | 同上（外部规范对齐表） |
| `lib/discovery/schema.js` | `FORWARD_TOTAL_TIMEOUT_MS_DEFAULT` | 同上（外部规范对齐表） |
| `lib/state/resume.js` | `workerResumeChapter` | 自述「**骨架**，增强恢复落地后填充」+ `enabled:false` 声明面 |
| `lib/verify/gate.js` | `renderVerdictReport` | 自述「落盘格式（**预留**：audit/verify-verdict.md）」 |
| `lib/watch/lane-heartbeat.js` | `REASON_EXEMPT_CLEARED` | 读端契约名（读端走字面量，本批无写者） |

---

## 3. 无断言门禁（13 个，W6 冻结）

判据：**有生产引用但测试零断言**。硬拒收口门漏断言 = 白盒测试绿 ≠ 生产路径走过。

| 门禁码 | 生产引用点 |
|---|---|
| `GATE_ARTIFACT_MISSING` | lib/state/gates.js×7 · lib/state/gates.ts×7 |
| `GATE_COMPLETE_EXEC_PENDING` | lib/state/gates.js×1 · lib/state/gates.ts×1 · lib/types/contracts.ts×1 |
| `GATE_COMPLETE_NO_AUDIT` | lib/state/gates.js×1 · lib/state/gates.ts×1 · lib/types/contracts.ts×1 |
| `GATE_DIFFICULTY_INVALID` | lib/tools/core.js×2 |
| `GATE_DIFFICULTY_RATIONALE_MISSING` | lib/tools/core.js×2 |
| `GATE_EVENT_CONST_MISSING` | lib/state/store.js×5 |
| `GATE_EXEC_INPUT_MISSING` | lib/tools/core.js×3 |
| `GATE_EXIT_MISSING_` | lib/state/gates.js×2 · lib/state/gates.ts×2 |
| `GATE_HANDOFF_LEGACY_PASSTHROUGH` | lib/state/store.js×1 |
| `GATE_HANDOFF_SETTLE_LEGACY_PASSTHROUGH` | lib/state/store.js×1 |
| `GATE_NO_DECLARATION` | lib/state/gates.js×1 · lib/state/gates.ts×1 |
| `GATE_SKILL_MISSING` | lib/state/event-types.js×1 · lib/tools/core.js×5 |
| `GATE_TEAMS_ROOT_` | lib/tools/core.js×3 |

**W6 冻结口径**：本波不改门禁行为、不补测。新引擎定型后按功能重议（补测优先，且必须补**生产路径 E2E 断言**，不是白盒直调 `createGates`）。

**勘误**：上游甄别报告记「15 个」，本轮实测台账为 **13 个**。差异根因：报告把 `GATE_FORBIDDEN_RE`（`_RE` 正则常量，非门禁码）计入，且把 `GATE_HANDOFF_SETTLE_LEGACY_PASSTHROUGH` 误截为 `GATE_SETTLE_LEGACY_PASSTHROUGH`（前缀码截断所致）。

**P0 三枚**（收口主门，优先补测）：`GATE_COMPLETE_EXEC_PENDING` / `GATE_COMPLETE_NO_AUDIT` / `GATE_ARTIFACT_MISSING`。

参考：jiuwen `schema/status.py:274-302` 的**两个镜像闸**（`PLANNING` 前 / `IN_REVIEW` 后，逐字 structurally identical mirrors）⇒ 蟛蜞 entry/exit 对偶门应有对称断言组。

---

## 4. schema 循环依赖（W4 冻结，给决策树）

**实测**：`lib/schema.ts:244` 注释逐字承认 `lib/schema.ts ⟷ lib/assembly/schema.js` **顶层循环依赖**（assembly 顶层初始化需本文件常量，静态 import 会 TDZ）。现靠运行时时序侥幸，属结构性定时炸弹。

| 新引擎形态 | 处置 |
|---|---|
| 保留独立的 `assembly` 层 | 把 assembly 顶层初始化所需常量**下沉为独立叶子模块**（`lib/state/constants.js` 已是先例），让 `schema.ts` 单向依赖 |
| 并入其他层 | 随并层自然消失，不需专门消环 |
| 本波 | **不动**（动 `schema.ts` 波及 43 个门禁码的类型面，须独立波 + 独立 commit） |

参考：jiuwen `workflow/engine/primitives.py:67` `_MAX_WORKFLOW_DEPTH = 1`（子工作流 = 独立脚本 + 自己的 META）⇒ **用文件边界切依赖层**；与 Onto `SUB_FLOW_CALL` 不得成环（v6 `:2530`）同构。

---

## 5. C2 · 白盒面（200 项，非冗余，登记备查）

判据：**仅测试引用，但本文件内部已消费** ⇒ `export` 多余却**不可去**（去 export 会断 200 处测试引用）。

> 判读：这 200 项把「未接线」这件事**测没了**——测试直捅内部实现，测试绿只证明内部函数对，不证明生产路径走了它。
> 这是 13 个无断言门禁（§3）的同一枚硬币另一面，处置归 W6。

---

## 6. 冻结项处置纪律

1. **不得删**：本表 §1 / §2 的符号在后续任何「清理 AI 幻觉产物」的 wave 中一律跳过，除非回到本表改判。
2. **不得静默接线**：接线属行为变更，须新引擎形态先定 + 独立 commit + 补对应测试。
3. **改判留痕**：撤销冻结时，在本文件对应行加「解冻日期 + 依据 + commit」。
4. **单一强制点**：接线时不得新写一套，必须接既有实现（`tools/core.js:349` 逐字「禁各写一套」）。
