# 疑似冗余完整清单（门禁类型 × 测试内容，2026-09-22 02:3x，待裁决）

**口径**：机器扫描（重复标题 / 覆盖扇出 / 退役码存活形态 / deny 断言分布 / 注册断言分布）+ 人工判读；**只列不删**，逐项待裁。
**上游**：`gate-code-classification-2026-09-22.md`（112 码分类）· `redundant-guard-audit-2026-09-21.md`（守卫冗余既有台账，本清单不重复其已登记项）· `reachability-ledger`（可达性）。

---

## G1 · deny 集断言三处重叠（疑似冗余：成员/长度断言 ×3）

| 位置 | 断言内容 |
|---|---|
| `suite-consistency-and-hot.test.js` SC-1 | `FROZEN_DENY` **deepEqual 全集精确**（20 项）+ 派生同源 + mcp 泄漏 |
| `member-deny-boundary.test.js` DB-1/DB-3 | 派发工具 ⊆ deny + 长度 ≥13 + 泄漏面（ordinary/mcp） |
| `task-pool-r41.test.js` :241-247 | deny 长度 20 + 首项 `assign_check` + `task_pool`/`task_update` 成员性 |

- **重叠维度**：deny 集成员性与长度被三处断言；SC-1 为唯一全集权威。
- **独有维度（保留）**：DB-2（deny ⇒ `toolFilter.deny` 落地面，全仓唯一）；SC-1 的 derived 同源与顺序锁。
- **建议**：R41 的长度/首项断言降为「只断长度」或删除（SC-1 已全集锁死）；DB-1/DB-3 保留泄漏面与 ⊆ 面。**待裁**。

## G2 · 注册/Schema 断言三处重叠（疑似冗余：注册完整性 ×2 套）

| 位置 | 断言内容 |
|---|---|
| `suite-consistency-and-hot.test.js` SC-4 | 注册表 ↔ `createTools` **双向**（表内必注册 + 注册必登记）+ `NOT_REGISTERED_BY_DEFAULT` 白名单 |
| `tool-schema-conformance.test.js` | 全工具 schema 形态一致性 |
| `tool-descriptor.test.js` | 工具描述面 |

- **疑似重复**：注册完整性在 SC-4 与 conformance 各有一套。
- **建议**：明确分工——SC-4 管「注册表单点」（表↔注册双向），conformance 管「schema 形态」，descriptor 管「描述文案」；若 conformance 内含注册断言则删其注册面。**待裁（含一次逐用例核对）**。

## G3 · 退役码防回生锁散布 4 文件（疑似冗余：可合并为单表）

| 位置 | 锁的码 |
|---|---|
| `gate-lite-batch2.test.js:162-174` | `GATE_SWARM_UNBOUND_REPORT` / `GATE_TEAM_ASSET_MISSING` 零命中 |
| `concurrency-gate.test.js:430/596/607` | `GATE_CONCURRENCY_EXCEEDED` 零命中（3 处） |
| `governance.test.js:216` | `GATE_MANAGER_TERMINAL/PHASE_INVALID/AGENT_ID_REQUIRED` 零命中 |
| `writing-team-asset.test.js:139` | `GATE_TEAM_ASSET_MISSING` 不在告警码 |

- **判定**：**不是冗余断言**（是防回生绊线，有价值）；冗余在于**形态散布**——每处手写一个 `!includes` 变体。
- **建议**：合并为单一「退役码登记锁」测试（退役码数组遍历断言 lib 零命中，配 `docs/gate-code-classification §C 类` 为数据源）；原散布式可删或保留。**待裁**。

## G4 · 零断言门禁 5 件（非冗余——缺口清单，供补测排期）

`GATE_MANAGER_MISSING` · `GATE_TARGET_BLOCKED` · `GATE_TARGET_PASSED` · `GATE_EXIT_BLOCKED` · `GATE_NEEDHUMAN_BLOCKED`
—— 全部①可达（`gates.js` 事件写点，输入可构造）；补测随下一次活体批（R3g 既裁）。

## G5 · 门禁码 C 类 8 + N 类 21（口径污染，前批清单引用）

见 `gate-code-classification-2026-09-22.md` §0/§2：C 类 8（退役注释标记待裁）· N 类 21（scanner 白名单剔除待裁）。

## G6 · 已处置引用（证明清单非遗漏）

- `schema.js assert*` 双判定源 ⇒ machine-rules 取代，N2 第一批降级（`661485e`）；
- `validateAssembly` 自产自销测试 ⇒ 已删并迁移（`745d27b`）；
- 夹具审计死夹具 0（F1–F5 收尾）；基线 tautologies=0（无恒真断言）。

## G7 · 测试夹具近似重复（低优先，维护性冗余）

- `seedBatch`：`engine-dispatch.test.js:52-74` 与 `concurrency-gate.test.js:95+` 各一份（后者注释自述「复用形态」但为独立实现）；
- `harness(start)`：`dispatch-failure-rollback.test.js` 与 `dispatch-prompt-compose.test.js` 相似构装。
- **建议**：下沉 `test/helpers/`（沿 gate-fixture 模式）；收益 = 维护性非正确性。**待裁（低优先）**。

## G8 · 阴性结论（机器扫描未发现）

- 跨文件**重复测试标题**：0 组（归一化后）；
- 恒真断言（tautology）：0（基线口径）；
- 死夹具：0（F1–F5 既有结论）。

---

## 裁决请求汇总

| # | 组 | 动作 | 优先级 |
|---|---|---|---|
| 1 | G1 | SC-1 保留全集权威；R41 deny 断言瘦身 | 低 |
| 2 | G2 | conformance 注册面与 SC-4 分工核对，删重复 | 低 |
| 3 | G3 | 4 处防回生锁合并为单表登记锁 | 中 |
| 4 | G4 | 5 件零断言补测（随活体批） | 中 |
| 5 | G5 | C 类标记 + N 类白名单（前批 D-1/D-2 同项） | 中 |
| 6 | G7 | seedBatch/harness 下沉 helpers | 低 |

全部「疑似」—— 未删任何测试；逐项拍板后执行。

## §9 裁决执行回填（2026-09-22 03:5x）

- **G1 ✅ 已执行**（用户口径「同语义就删」）：R4-1a-5 deny/modeGate 7 行断言删 + DB-1/DB-3 删；DB-2 与 R41 计数锁保留（SC 无此维度）。

- **G2 ⏹ 阴性关闭**：TSC-1（CASES 覆盖图）与 SC-4（注册表）分工不同，无实义重叠，无可删项。

- **G4（=批 4 五件零断言事件）⏸ 留待裁决**：取证判定五件均为在役门禁**唯一持久留痕**（targets/command/needHuman/manager 声明核对），无同语义门禁/工具覆盖；建议补 5 条断言而非删。

- G3/G5/G7 状态不变（G3 已随批 2 合并；G5 引用分类清单；G7 低优先）。
