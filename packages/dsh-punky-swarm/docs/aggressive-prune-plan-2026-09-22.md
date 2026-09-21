# 激进删除冗余 · 分批对接方案（2026-09-22 02:4x，批次 1 已执行）

**裁定**：全部激进删除冗余，仅保留必要内容；未接线、无断言、与核心门禁无关内容都删 —— 采用「分批对接」执行。
**数据源**：`gate-code-classification-2026-09-22.md`（112 码分类）· `redundancy-candidates-2026-09-22.md`（G1–G8）· `c1-wiring-audit-2026-09-22.md`（C1 26 项）。

---

## 批次 1 ✅ 已执行（零运行时影响，本 commit）

- **N 类 21 项剔除出统计口径**：`reachability.mjs` 注入 `NON_GUARD` 白名单（配置键/解析器常量/兼容标记/常量片段）⇒ 守卫全集 **119 → 101**（门禁码 96 → 84）。**常量本体不删**（生产在用：`GATE_ENABLED` 等是活配置键），只剔口径——"删"落在统计面。
- 骨架重生成（`reachability-skeleton.md`）；`test 零命中 6` / `prod 零引用 2` 两清单随新口径刷新。

## 批次 2（待确认）· 退役痕迹清理：注释删除 + 防回生锁合并

- **C 类 8 项注释删除**（激进档）：`contracts.ts:383-385/422-449/432-440` 等处已退役码的历史说明段整段删除（含 `GATE_SUBAGENT_OUTSIDE_LANES`/`GATE_CONCURRENCY_EXCEEDED`/`GATE_SWARM_UNBOUND_REPORT`/`GATE_MANAGER_*` 三码/`GATE_TEAM_ASSET_MISSING`）；`EVT_CHAIN_STEP` 退役常量**保留**（历史批磁盘读端依赖）。
- **G3 防回生锁合并**：4 文件散布锁（gate-lite-batch2 / concurrency-gate / governance / writing-team-asset）→ 新建单一「退役码登记锁」测试（退役码数组遍历断言 lib 零命中，数据源 = 分类清单 C 类）；原散布断言删除。
- **影响**：注释面少了历史叙事（删除理由改为由分类清单承载）；测试 −4 处散布 +1 处单表。

## 批次 3（待确认）· 未接线导出删除（C1 降级项激进档）

- **删**：`assertMemberTransition`/`assertBatchTransition`（testUse=1，测试改用 `machine.applyMemberTransition`）；`sweepExpiredHandles`（testUse=2，测试改手写清理或删该用例）；`artifactTypeOf`/`typesOfLayer`（testUse 7/5，整组类型分类测试删除——判定真源 = gates 在场性校验）；`parseLabel`（testUse=5，B3 声明面测试删除）；`clearSessionState`（5）；`isEntityAic`（3）；`auditlogStats`/`sinkFilePath`（8/4）；`flattenAgentSkills`/`decryptEabCredential`/`API_BASE_PATH`/`ATR_BASE_PATH`（acps 面，共 18）；`ACS_REQUIRED_FIELDS`/`ACS_SKILL_REQUIRED_FIELDS`（11）；`BLIND_REVIEW_ORDER`（6）；`DEFAULT_ESCALATION_WINDOW_MS`（10）；`DEFAULT_THRESHOLD_MULTIPLIER`（2）；`RATCHET_RULES`（2）；`MANAGER_PLANS`（3）。
- **保留（必要边界）**：`clearFlowCache`/`clearRoleCache`/`__resetLaneHandles`（测试隔离钩，66–85 处引用，删除=砸测试基础设施）。
- **影响**：lib 导出面收缩 ~19 符号；测试改写 ~60–80 处引用；基线大幅下降（预估 asserts −40±）。

## 批次 4（待确认 ⚠ 有运行时可见性损失）· 零断言事件门禁删除

- **删**：5 件事件写点 + 常量：`GATE_MANAGER_MISSING` / `GATE_TARGET_BLOCKED` / `GATE_TARGET_PASSED` / `GATE_EXIT_BLOCKED` / `GATE_NEEDHUMAN_BLOCKED`（`gates.ts` 写点 + `event-types` 常量）。
- **代价（须明知）**：`batch_status`/`log_export` 不再显示 targets/needHuman/exit 的 BLOCKED/PASSED 留痕事件 —— 治理**观察面收窄**；门禁拒态本身不受影响（拒码走 GateFail 面保留）。
- **备选**：不删事件、改为补 5 条断言（R3g 原方向）——二选一。

## 批次 5（待确认）· 测试断言重叠收敛（G1/G2）

- R41 deny 断言瘦身（保留 SC-1 权威）；tool-schema-conformance 注册面删除（保留 SC-4 双向）。

---

## 裁决请求

| 批 | 内容 | 建议 |
|---|---|---|
| 1 | 统计口径剔除 | ✅ 已执行 |
| 2 | 退役注释删 + 锁合并 | 建议过 |
| 3 | 未接线导出删（~19 符号 + 测试改写） | 建议过 |
| 4 | 零断言事件删（⚠ 观察面损失）vs 补断言 | **二选一，须明确** |
| 5 | 断言重叠收敛 | 建议过 |

回复「2–5 全过」或逐批口径，即继续。

## §10 批 4/5 判定结论（2026-09-22 03:5x，口径：有同语义门禁/工具 ⇒ 删；核心功能 ⇒ 留待裁决）

**批 4 · 五件零断言事件 —— 全部留下待裁决（无一可删）**：逐码取证写点（\x60store.js\x60:907/913/922/945/1140）判定——

- \x60gate.target_blocked\x60/\x60gate.target.passed\x60 = targets 门（\x60checkTargetsGate\x60）拒侧/过侧**唯一持久留痕**（payload 携 code/missing/unchanged；throw 只进调用方响应不留盘）；门禁本体在役核心。

- \x60gate.exit_blocked\x60 = command 门拒侧留痕（含 command/exitCode/escalation 转人工路径）；\x60gate.needhuman_blocked\x60 = merged 面人工闸缺证据拒侧留痕。均无同语义覆盖（\x60gate.exit_missing\x60 只覆盖 exit 形状门）。

- \x60gate.manager_missing\x60 = complete 期「按声明 raise 且 batch.manager 未登记」收口告警。与 \x60gate.manager_roster_gap\x60（建批期 roster 面判定）**同意图但异源异时互补**（legacy 登记面 vs roster 成员面），非完全同语义 ⇒ 保守留。

**建议**：五件按 R3g 方向**补 5 条断言**（对齐 exit gate 断言强度，成本极低）；不删。

**批 5 · G1 ✅ 已执行删除**：R41 deny/modeGate 成员性与长度断言 7 行 + DB-1/DB-3 整用例删——全部被 SC-1/SC-2 精确全集 deepEqual 蕴含（同语义就删）；保留 DB-2（deny→toolFilter 落地面，SC 无此维度）与 R41 计数锁（总数 36，SC 无全名集 deepEqual）。**G2 阴性关闭**：\x60tool-schema-conformance TSC-1\x60 守 \x60CASES\x60 覆盖图键集，SC-4 守注册表权威——分工不同非重叠，无可删。

## §11 批 4 终裁（2026-09-22 03:5x 用户裁定）
- **`gate.manager_missing` ✂ 已删**（事件常量 + store.js 收口写点 + A2/A2b 用例 + 各处注释引用；防回生锁 retired-codes-lock 纳入在册）。
- **其余四件保留**（targets 门拒/过侧、command 门拒侧、needHuman merged 面拒侧 = 在役门禁唯一持久留痕）。补 5 条断言的建议**仅适用四件**；是否补测待后续裁定。
