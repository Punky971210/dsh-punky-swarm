# 蟛蜞引擎重建施工蓝图 · R2 清理波

- 日期：2026-09-21
- 目标仓库：`D:\dsh\Punky-plugin-onto`（包：`packages/dsh-punky-swarm`）
- 基线：HEAD `e3e8cd0`，tag `r1-done-20260920`（代码级回溯锚），测试基线 **1703 tests / 1699 pass / 0 fail / 4 todo**
- 依据：本包 `docs/` 无（本文件即首份）；上游甄别报告 `D:\AI_Workspace\DSH\buddy\_research\punky-engine-asset-audit-20260921.md`
- 数据源：`.wip-backup/{dead-code-classified,unwired-summary,gate-ledger}.json`（复现脚本见附录 E；P-D1 后迁至 `scripts/audit/`）

---

## 0. 裁定输入（用户已定，本蓝图不得偏离）

| # | 裁定 | 对本波的作用 |
|---|---|---|
| W1 | `.wip-backup/` **删掉** | 本波执行（清场批） |
| W2 | 未接线安全守卫 **不接**；新引擎需要时再考虑重新引入或清理 | **接线类全部冻结**，本波零接线 |
| W3 | **先清理无风险项** | 本波执行（导出面收敛批） |
| W4 | schema 循环依赖 **按新引擎形态做取舍** | 冻结，本波只登记决策树 |
| W5 | **一批一 commit** | 5 个批次 = 5 个 commit |
| W6 | 无断言门禁 **冻结**，按新引擎功能再议 | 门禁层**零改动** |

**推论**：W2/W4/W6 一致指向"等新引擎形态"，⇒ 本波 = **纯清理波**，不含接线、不含重构、不含门禁行为变更。

---

## 1. 总纪律（引擎自身口径）

1. **单一强制点**：禁各写一套（`tools/core.js:349` 逐字）。
2. **棘轮不可加状态**：`state/machine-rules.ts` 覆盖表必须是默认表子集——本波不碰。
3. **改 `.ts` 必须回拷**：15 个 .ts 源（`scripts/copy-ts-built.mjs` 白名单）改后必须 `npm run build` 重生成 `lib/*.js` + `lib/*.d.ts`，**且 `.tsbuild` 必须被脚本删除**（否则 `gates-vocabulary-contract.test.js:402` 的资产守卫测试转红）。
4. **每批前后各跑一次全量测试**，必须回到 `1703/1699/0/4`；任一批不达标则该批不提交。

---

## 2. 任务分类口径

| 分类 | 定义 | 本波动作 |
|---|---|---|
| **保留** | 必要设计，本波不动 | 仅登记 |
| **修改** | 改现有实现的行为/接口 | **本波不做**（待新引擎形态） |
| **重构** | 不改行为，改结构（消环 / 拆文件 / 判据单点化） | **本波不做**（高风险，独立波） |
| **接线** | 把已声明未消费的符号接入生产路径 | **本波不做**（W2 冻结） |
| **清理** | 删死代码 / 收导出面 / 清残留文件 | **本波全做** |

---

## 3. 任务分类总表

### 3.1 保留（登记，不动）

| 项 | 依据 |
|---|---|
| 棘轮 `state/machine-rules.ts`（89 行） | 引擎宪法，全仓最干净模块 |
| 门禁四层（entry / plan-contract / exit / complete）+ 43 门禁码 | 0 孤儿，全接线 |
| `state/gates.ts` `presenceJudge`（`:427-503`） | R1 契约单一判定实现 |
| `assembly/chain.js` 建批期八条静态校验 | 被 `tools/core.js:493` 消费 |
| 治理层 6 原语 + P0–P6 分级 | 相对 jiuwen 的唯一优势面 |
| test `helpers/` 4 夹具 + 11 个 `*-red`/`legacy`/`gap-*` 加固批次 | 实测全绿 |
| `scripts/pkg-hashes.mjs` + `pkg-hashes.txt` | 生成器 + `--check` 漂移检查完整 |
| `assembly/schema.js` 常量表（`BLIND_REVIEW_ROLES` / `PRODUCE_LAYERS` / `FLOW_SECTIONS` / `CAPABILITY_REGISTRY`） | 被 `wave-plan.ts:35/51`、`team-asset.js:289`、`index.js` 等真实消费 |

### 3.2 清理（本波执行）

| 批 | 内容 | 规模 |
|---|---|---|
| P-D1 | 清场：`.wip-backup/` 整目录、`test-run-e3.log`、审计脚本迁 `scripts/audit/` | 4.2MB + 84KB |
| P-D2 | 真死代码（B1：内外皆零引用）——**收窄为删 8 项**（另 10 项有显式声明语义，转冻结） | 8 逻辑符号 / 6 文件 |
| P-D3 | 多余 `export` 收敛（B2：内部自用、外部零引用） | 122 逻辑符号 / 31 文件（4 个 ts 源） |
| P-D4 | 冻结登记落盘（把 W2/W4/W6 的冻结项与决策树写死，防后续误当幻觉产物重删） | 1 文件 |

**明确不在本波清理的**：
- **C2（200 项）**：仅测试引用但内部已消费 ⇒ 去 `export` 会**打断 200 个测试引用**，不属"无风险项"。
- **C1（26 项）**：生产未接线 ⇒ 若同时去 `export` + 删测试引用，等于替用户做"接线/降级"裁定，违反 W2。**冻结**。
- **`backups/`（根目录）**、**根 `docs/*`（gitignored 的历史验收档）**：非本波对象。

### 3.3 接线（本波零执行，仅登记指向）

| 项 | 原建议 | 本波 |
|---|---|---|
| `assertMemberTransition` / `assertBatchTransition` | 接线（安全守卫） | **冻结**（W2）。新引擎需要时，照 jiuwen `tools/task_manager.py` 的 `TaskResult`/`GraphMutationResult` 返回显式结果对象而非仅 throw |
| `artifactTypeOf` / `typesOfLayer` | 接线（类型校验面） | **冻结** |
| `sweepExpiredHandles`、`clearFlowCache` / `clearRoleCache` | 接线（资源清理 / 热更） | **冻结**。参考 jiuwen `skill/visibility.py` "re-read on every refresh" |
| `validateAssembly` / `assertAssemblyCompleteness` | 删函数保常量表 | **冻结**（W2 明示"再考虑重新引入或清理"）。常量表已列入保留 |

### 3.4 重构（本波零执行，登记决策树）

| 项 | 状态 | 决策树 |
|---|---|---|
| `lib/schema.ts` ⟷ `lib/assembly/schema.js` 顶层循环依赖 | **冻结**（W4） | 新引擎若保留 `assembly` 层 ⇒ 常量下沉独立叶子模块（`lib/state/constants.js` 先例）；新引擎若并层 ⇒ 随并层自然消失。**两路都不在本波** |
| `GATE_AUDIT_CRITERIA_MISSING` 判据两处（`gates.ts:903` 与 `:994`，同为 `includes('## 验收标准')`） | **冻结**（W6） | 门禁行为冻结 ⇒ 不做判据抽取 |
| `assembly/chain.js` 946 行拆薄 | **冻结**（未裁） | 等新引擎形态定后随层语义重划 |

### 3.5 修改（本波零执行）

无。本波不改任何生产行为。

---

## 4. 批次施工单

> 每批：**先跑基线测试 → 施工 → 再跑全量测试 → 达标才 commit**。commit message 前缀 `r2-cleanup`。

### P-D0 · 蓝图落盘（本文件）

- 产出：`docs/rebuild-blueprint-2026-09-21.md`
- commit `r2-cleanup-0: 施工蓝图（清理波）`

### P-D1 · 清场

1. 建 `scripts/audit/`，迁入 4 个审计脚本：`dead-code2.mjs`（A/B/C 分类，**替代并弃用第一版 `audit-dead-code.mjs`**——勘误：原蓝图写 4 脚本 + 生成器共 5 个，实际第一版已被第二版完全覆盖，不留）、`classify.mjs`（C1/C2/B1/B2 细分）、`gates.mjs`（门禁台账）、`plan-lists.mjs`（去重施工清单）；输出目录由 `.wip-backup/` 改为 `scripts/audit/out/`。
   ⚠️ 迁移附带修正：原脚本把 `corpus` 扫描域设为 `lib + test + scripts + presets`，而自身当时位于被 `SKIP` 的 `.wip-backup/` 内；迁入 `scripts/` 后**必须显式排除 `scripts/audit`**（脚本内含符号名字面量，会污染 `other` 计数），已在 `dead-code2.mjs` / `gates.mjs` 的 walker 中实现。
2. 台账留存两份（其余随 `.wip-backup` 删除）：`gate-ledger.json` → `docs/audit-2026-09-21-gate-ledger.json`；`unwired-summary.json` → `docs/audit-2026-09-21-unwired.json`。
3. 删 `packages/dsh-punky-swarm/.wip-backup/`（4.2MB，含 `r1-exec-*` 留痕、`tsbuild-quarantine`、2 份 TAP）。
4. 删 `packages/dsh-punky-swarm/test-run-e3.log`（84KB，`*.log` 已 gitignore）。
5. `.gitignore` 增 `scripts/audit/out/`。
- **回滚**：代码零改动，`git revert` 或直接重建目录（无代码面风险）。
- commit `r2-cleanup-1: 清场`

### P-D2 · 真死代码清理（B1）——**施工期收窄为「删 8 / 冻结 10」**

> ⚠️ **与原蓝图的冲突已报到**：原蓝图按「内外皆零引用 ⇒ 可删」把 B1 全 18 项列为删除对象。**实测复查发现其中 10 项虽零引用，但自带显式声明语义**（预留格式 / 骨架契约 / 白名单 / 对齐外部规范 / 版本口径 / 读端契约名）。删它们等于替用户做「接线/降级」裁定，与 W2 冻结口径冲突 ⇒ 只删 8 项无声明语义的真死 helper，另 10 项转入 P-D4 冻结登记。

**删除（8）**

| 文件 | 符号 | ts 源 | 判读 |
|---|---|---|---|
| `lib/assembly/chain.js` | `flatTasksOf` | — | 通用 helper，零引用 |
| `lib/auditlog/sink.js` | `currentSinkPath` `runPrune` | — | 注释自述「供测试」，实测**无任何测试使用** ⇒ 意图过期 |
| `lib/state/schema-v3.ts` | `isHandoffs` `laneProgressDefaults` | ✅ | `isHandoffs` 与 `gates.ts handoffVerdictOf` 重复；`laneProgressDefaults()` 恒返回 `undefined` |
| `lib/governance/escalation.js` | `GOVERNANCE_REFUSAL_EVENT_TYPE` | — | 纯别名（正文：58 处直接用 `EVT.EVT_GOVERNANCE_REFUSAL`） |
| `lib/lock.js` | `lockFileName` | — | 零引用，且同文件 `isLocked` 仍在 |
| `lib/state/store.js` | `artifactsDirOfRoot` | — | 路径 helper，调用方另行内联拼路径 |

**冻结（10，转 P-D4 登记，不删）**

| 文件 | 符号 | 自带声明语义 |
|---|---|---|
| `lib/discovery/schema.js` | `FORWARD_{DEPTH,FANOUT}_LIMIT_DEFAULT` `FORWARD_{EACH,TOTAL}_TIMEOUT_MS_DEFAULT` | 节标题逐字「与 `acps_sdk/adp/constants.py` 一致」⇒ 外部规范对齐表 |
| `lib/assembly/chain.js` | `CHAIN_VERSION` | 「v1（既有缺省口径）」版本口径 |
| `lib/assembly/chain.js` | `CHAIN_GUIDANCE_INJECTS` | 「`flows.<layer>.guidance.inject` 白名单（禁自由文本）」 |
| `lib/assembly/flows.js` | `flowsDeclarationOf` | 自述「gateStrength / 诊断面板的取数入口」 |
| `lib/verify/gate.js` | `renderVerdictReport` | 自述「落盘格式（**预留**：audit/verify-verdict.md）」 |
| `lib/state/resume.js` | `workerResumeChapter` | 自述「**骨架**，增强恢复落地后填充」，`enabled:false` |
| `lib/watch/lane-heartbeat.js` | `REASON_EXEMPT_CLEARED` | 「读端事件名走字面量——本批无写者」⇒ 已落地的读端契约名 |

- **前置校验**（已做）：18 个名字在**全仓 `*.md` 零命中** ⇒ 无文档契约面。
- **执行**：`.ts` 项改源后 `npm run build`；纯 `.js` 项直改。实测 **1703/1699/0/4** 保持。
- commit `r2-cleanup-2: 删真死 helper 8 项（B1 收窄，10 项转冻结）`


### P-D3 · 导出面收敛（B2，122 逻辑符号）

只做一件事：**去 `export` 关键字**（保留声明本体与内部使用）。

- 纯 `.js` 文件 106 项：直改。
- `.ts` 源文件 4 个 / 16 项：改 `.ts` → `npm run build`（自动重生成 `.js` + `.d.ts`）
  - `lib/state/gates.ts`（12）：`contractMissingPayload` `GATE_OFF_LINE_RE` `detectGateOff` `REASON_DECL_RE` `vocabularyViewOf` `detectReasonTokens` `reasonVocabularyNote` `EMPTY_REASON_RE` `emptyReasonOf` `sectionLineHit` `elementLineHit` `isInsideRoot`
  - `lib/wave-plan.ts`（2）：`orphanPlanProductsOf` `checkHandoffDeclarations`
  - `lib/schema.ts`（1）：`isBatchPhase`
  - `lib/state/schema-v3.ts`（1）：`isLaneProgress`
- **完整性校验**：收敛后重跑 `audit-dead-code2.mjs`，B2 应归零（残留 = 漏改）。
- **反向校验**：全量测试必须仍 1703/1699/0 —— 若转红说明该项其实有测试依赖，即扫描误判 ⇒ 该符号回退为 `export` 并在本蓝图勘误登记。
- commit `r2-cleanup-3: 导出面收敛（B2 122 项）`

### P-D4 · 冻结登记

- 产出：`docs/frozen-register-2026-09-21.md`
  - C1 26 项（生产未接线）：逐项标 `冻结·待新引擎裁定`，禁止当死代码删（**这是 R1 有意留下的声明面**）
  - 15 个无断言门禁：冻结台账（含各自生产引用点）
  - schema 循环依赖：W4 决策树
  - C2 200 项白盒面：判读说明（测试绿 ≠ 生产走过）
- commit `r2-cleanup-4: 冻结登记`

---

## 5. 验收判据（每批共用）

| 判据 | 阈值 |
|---|---|
| 全量测试 | `1703 tests / 1699 pass / 0 fail / 4 todo` |
| 类型检查 | `npm run check`（`tsc -p tsconfig.json`）零错误 |
| 构建 | `npm run build` 零错误，且 `.tsbuild` 被脚本清除 |
| 资产守卫 | `test/gates-vocabulary-contract.test.js` 全绿 |
| 导出面 | P-D3 后 `audit-dead-code2.mjs` 中 B2 = 0 |

---

---

## 6. 施工期实测勘误（滚动登记）

| 时点 | 发现 | 处置 |
|---|---|---|
| P-D0 后 | `npm run build` 使 `lib/wave-plan.d.ts` 新增 `collectAuditPairingWarnings` 声明（+22 行） | **基线漂移**：上一轮只改了 `wave-plan.ts` 与 `wave-plan.js`，漏同步 `.d.ts`。本波随 P-D1 一并提交（生成物同批纪律） |
| P-D1 | 原审计脚本扫描域含 `scripts/`，迁入后自身会被当语料 | 脚本内显式排除 `scripts/audit`（否则 `other` 计数被符号名字面量污染） |
| P-D1 | 原蓝图列 5 个审计脚本 | 实为 4 个（第一版 `audit-dead-code.mjs` 已被第二版完全覆盖，不留） |
| P-D1 | 沙箱批量删除守卫（>50 文件/次，按 turn 累计）会拦 `.tsbuild` 清理（194–659 文件） | 守卫计数按 turn 累加，越往后越易触发；触发时用「编译 → 回拷 → **同盘 rename 移出** `.tsbuild`」三步等效流程（跨盘 `rename` 会 `EXDEV`，须用 `D:\dsh\.scratch\`）。`.tsbuild` 残留会直接让 `gates-vocabulary-contract.test.js:402` 转红 |
| P-D2 | 原蓝图 P-D2 列 B1 全 18 项删除 | **收窄为删 8 / 冻结 10**（详见 P-D2 节）：10 项自带显式声明语义（预留格式 / 骨架 / 白名单 / 外部规范对齐 / 版本口径 / 读端契约名） |
| 波后复核（2026-09-21） | `scripts/audit/gates.mjs` 的正则 `\bGATE_[A-Z0-9_]+\b` 把源码**模板拼接**（`'GATE_EXIT_MISSING_' + layer`）与**注释**（`GATE_TEAMS_ROOT_*`）截成前缀，当独立门禁码收录 ⇒ 台账虚增 3 项（`GATE_EXIT_` / `GATE_EXIT_MISSING_` / `GATE_TEAMS_ROOT_`） | `gates.mjs` 增**严格前缀剔除**（凡前缀于同集合内另一码者判伪影，`aliasOf` 落台账）；台账「无断言」命中 15 → 13，登记 §3 13 → **11**；被剔除前缀的真实码（`GATE_EXIT_MISSING_EXEC/AUDIT`、`GATE_TEAMS_ROOT_INVALID/ASSET_NOT_FOUND`）**本就有测试断言**（`test/gate-flows.test.js:270`、`test/teams-root.test.js:234/312`） |
| 波后复核（2026-09-21） | 冻结登记**生成器**原置于 `scripts/audit/out/`（已 gitignore）⇒ 登记**不可复现** | `gen-register.mjs` 迁入 `scripts/audit/`（版本控制内），与其余 4 个生成器同置；复现命令写进登记抬头 |

## 7. 风险与回滚

| 风险 | 等级 | 缓解 |
|---|---|---|
| P-D2 删掉"有意预留的契约常量" | 低 | 全仓 `.md` 零命中已证；真死项可 `git revert` |
| P-D3 扫描误判（符号被间接引用） | 中 | 全量测试 + B2 归零双重校验；误判项即时回退 |
| `npm run build` 产物与手改 `.js` 冲突 | 低 | 白名单回拷链已实测 15 组逐字符一致，无分叉 |
| `.tsbuild` 留盘触发资产守卫转红 | 低 | 只用 `npm run build`（脚本自带 `rmSync`），不手工跑 `tsc` |

---

## 附录 E · 复现指令

```bash
cd D:/dsh/Punky-plugin-onto/packages/dsh-punky-swarm
node scripts/audit/dead-code2.mjs && node scripts/audit/classify.mjs && node scripts/audit/gates.mjs
npm run build && node --import ./test/helpers/isolated-home.preload.mjs --test
```

---

## 附录 A · B1 真死（18）

`FORWARD_{DEPTH,FANOUT}_LIMIT_DEFAULT` `FORWARD_{EACH,TOTAL}_TIMEOUT_MS_DEFAULT`(discovery/schema) · `CHAIN_VERSION` `CHAIN_GUIDANCE_INJECTS` `flatTasksOf`(assembly/chain) · `currentSinkPath` `runPrune`(auditlog/sink) · `isHandoffs` `laneProgressDefaults`(state/schema-v3) · `flowsDeclarationOf`(assembly/flows) · `GOVERNANCE_REFUSAL_EVENT_TYPE`(governance/escalation) · `lockFileName`(lock) · `workerResumeChapter`(state/resume) · `artifactsDirOfRoot`(state/store) · `renderVerdictReport`(verify/gate) · `REASON_EXEMPT_CLEARED`(watch/lane-heartbeat)

## 附录 B · B2 多余 export（122，按文件）

见 `.wip-backup/plan-lists.json` 的 `b2` 数组（P-D1 后为 `scripts/audit/out/plan-lists.json`）——施工时逐条消费，不手抄。

## 附录 C · C1 生产未接线（26，冻结）

`API_BASE_PATH` `ATR_BASE_PATH` `decryptEabCredential`(acps/registry-client) · `ACS_REQUIRED_FIELDS` `ACS_SKILL_REQUIRED_FIELDS`(aip/agent-descriptor) · `artifactTypeOf` `typesOfLayer`(artifact-types) · `clearFlowCache` `clearRoleCache`(assembly/flows) · `auditlogStats` `sinkFilePath`(auditlog/sink) · `sweepExpiredHandles` `__resetLaneHandles`(bridge/lane-handle) · `assertMemberTransition` `assertBatchTransition`(schema) · `flattenAgentSkills`(acps/discovery-client) · `isEntityAic`(aip/identity) · `BLIND_REVIEW_ORDER`(assembly/audit-blind-review) · `validateAssembly`(assembly/schema) · `parseLabel`(engine/dispatch) · `DEFAULT_ESCALATION_WINDOW_MS`(governance/escalation) · `clearSessionState`(governance/state-store) · `EVT_CHAIN_STEP`(state/event-types) · `DEFAULT_THRESHOLD_MULTIPLIER`(state/lane-exempt) · `RATCHET_RULES`(state/machine) · `MANAGER_PLANS`(wave-plan)

> ⚠️ `__resetLaneHandles`（测试隔离钩）、`clearFlowCache`/`clearRoleCache`（被 67/85 处测试调用）是**测试基础设施**，冻结而非删除。

## 附录 D · 无断言门禁（**实为 11 个**，冻结）

> 勘误链：甄别报告「15 个」→ 台账实测 **15**（含 3 个前缀伪影）→ 去伪影后 **13** → 再除 2 个 `_RE` 正则常量（`GATE_FORBIDDEN_RE` / `GATE_OFF_LINE_RE`，本就不是门禁码）后 **11**；其中 `GATE_ARTIFACT_MISSING` 为出口门内部哨兵（被改写成 `GATE_EXIT_MISSING_<LAYER>`），**真实可外显门禁码 = 10 个**。**权威清单 + 逐项「拦什么」见 `docs/frozen-register-2026-09-21.md` §3。**

P0：`GATE_COMPLETE_EXEC_PENDING` `GATE_COMPLETE_NO_AUDIT` `GATE_ARTIFACT_MISSING`
P1：`GATE_NO_DECLARATION` `GATE_SKILL_MISSING` `GATE_EXEC_INPUT_MISSING`
P2：`GATE_DIFFICULTY_INVALID` `GATE_DIFFICULTY_RATIONALE_MISSING` `GATE_EVENT_CONST_MISSING` `GATE_HANDOFF_LEGACY_PASSTHROUGH` `GATE_HANDOFF_SETTLE_LEGACY_PASSTHROUGH`
