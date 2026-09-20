# 门禁断言补测蓝图 · R3 波

- 日期：2026-09-21
- 目标仓库：`D:\dsh\Punky-plugin-onto`（包：`packages/dsh-punky-swarm`）
- 上游基线：HEAD `c761cd1`，测试基线 **1703 tests / 1699 pass / 0 fail / 4 todo**
- 上游依据：`docs/frozen-register-2026-09-21.md` §3「解冻口径」+ §6.5 纪律；`docs/rebuild-blueprint-2026-09-21.md` §0 裁定 ②

---

## 0. 本波的正当性（不是"翻冻"）

冻结登记 §3 逐字写明解冻口径：

> 新引擎定型后按功能重议，**补测优先于删码**，且必须补**生产路径 E2E 断言**（不是白盒直调 `createGates`）。

§6.5 纪律：

> **不得以「无断言」为删除理由**：`testHits = 0` 只证明**测试没覆盖**，不证明**代码是死的**。缺断言 ⇒ 先补测（生产路径 E2E），补完再判要不要删。

⇒ 本波 **不是** 修改冻结项，而是**补上冻结项缺失的那一半证据**。补测是**纯增量**：不动 `lib/**` 一行、不改任何门禁判定、不解除任何冻结。

**与 W6「本波不补测」不冲突**：那句里的「本波」= R2 清理波。R3 是独立波次，有独立蓝图。

---

## 1. 总纪律

1. **零生产代码改动**：`lib/**` 一行不动。任一用例失败 ⇒ 先怀疑夹具，不怀疑门禁。
2. **生产路径驱动**：走 `wave_plan` 工具建批 + `store.setMember` / `store.setPhase`（`store.js` 是唯一写者）⇒ 不用 `createGates(...).checkCompleteGate(batch)` 直调（那是白盒，正是本波要治的病）。
3. **生成物同批**：新增测试文件必须同步重生成 `baselines/test-baseline.json`：
   `node scripts/baseline-snapshot.mjs --reason "<事由>"`（`test/test-baseline.test.js` e2-1 会校验逐文件一致）。
4. **一批一 commit**，批前后各跑一次全量测试。
5. **不留凑数用例**：行为面已被既有断言覆盖的码，**不写重复用例**，改为在甄别表里登记判据。

---

## 2. 先甄别：11 枚里哪些是**真**缺口

判据：该码 **或它的外显形态** 是否存在测试断言。若外显形态已锁，则缺口是假的（哨兵按设计不外显）。

| 门禁码 | 类别 | 外显形态 | 既有断言 | 结论 |
|---|---|---|---|---|
| `GATE_ARTIFACT_MISSING` | 哨兵 | `GATE_EXIT_MISSING_<LAYER>`（出口门重写） | **12 处 / 3 套件**（v3 台账实测：`GATE_EXIT_MISSING_AUDIT` 3 · `GATE_EXIT_MISSING_EXEC` 9） | **假缺口**（映射一旦失效，这 12 处会看到裸哨兵而转红） |
| `GATE_COMPLETE_NO_AUDIT` | 收口主门 | 同名 | **零命中** | **真缺口** ⇒ R3-1 |
| `GATE_COMPLETE_EXEC_PENDING` | 收口主门 | 同名 | **零命中** | **真缺口** ⇒ R3-1 |
| 其余 8 枚（`GATE_NO_DECLARATION` / `GATE_EXEC_INPUT_MISSING` / `GATE_DIFFICULTY_*` / `GATE_EVENT_CONST_MISSING` / `GATE_HANDOFF_*_LEGACY_PASSTHROUGH` / `GATE_SKILL_MISSING`） | 判据/建批/工具/fail-closed/留痕 | 待逐枚核 | 待核 | R3-2（下波逐枚判读） |

**顺带勘误**：冻结登记 §3 的「P0 三枚」应更正为 **P0 两枚**。第三枚 `GATE_ARTIFACT_MISSING` 的行为面已被 12 处断言覆盖（v3 台账口径），不属缺口。

---

## 3. R3-1 施工单（本波）

### 3.1 目标

给两枚**零断言**的收口主门补上**生产路径 E2E 断言**，并同时锁住它们的**一级对偶门**（证明「拒」不是夹具问题）。

### 3.2 新增文件

`test/complete-tier-gate-e2e.test.js`（新建，唯一新增文件）

夹具形态（复用既有实现，禁各写一套）：

- `createStore(root)` + `createTools(ctx,{store,root})` + `withDefaultTeam(byName,'software-team')`
- `assessC(store, SESS_ID)`（`wave_plan` 属 C 档动作）
- `seedTeamAssetSkills('software-team')`（P1 起建批期技能面 fail-closed）
- 三层 tasks：`plan/p1` → `exec/e1` → `audit/a1`，`audit.consume` 同时含 `plan/` 与 `exec/`（对齐 software-team 的 `consumes_required: ['plan/','exec/']`）
- 产物播种：`plan/spec.md`（含裸标题 `## 验收标准`）、`exec/e1.md`、`audit/a1.md`

### 3.3 用例设计（4 条）

| # | 用例 | 驱动路径 | 断言 |
|---|---|---|---|
| **A1** | `GATE_COMPLETE_NO_AUDIT` · 二级防线（真机路径） | 建批成功 → `batch_phase running` → 播种产物 → 全 lane 结算 `merged` → **只改持久化 `wavePlan`**：剔除全部 audit task（模拟「建批后被改图 / 存量漂移」形态；`layersOf` 只读 `wavePlan`）→ `store.setPhase('complete')` | 抛错且 message 含 `GATE_COMPLETE_NO_AUDIT`；`batch.phase` **仍为 `running`**（拒即不推进）；`gate.complete_blocked` 事件落痕 **1 条**且 `code` 一致 |
| **A2** | 对偶 · 一级防线（主防线） | 同一三层 tasks **移除 audit lane** 后走 `wave_plan` 工具 | 建批期即拒，message 含 `three-tier: exec layers require at least one audit lane`；**不落盘**批次文件 ⇒ 证明「有 exec 必有 audit」在建批期先拦，收口门是二级防线（两级都在位、码不同） |
| **B1** | `GATE_COMPLETE_EXEC_PENDING` · 真机路径 | 三层批 → `running` → 播种产物 → `p1`/`a1` 结算 `merged`，`e1` **停在 `running`** → `setPhase('complete')` | 抛错且 message 含 `GATE_COMPLETE_EXEC_PENDING` + **pending 回显 `e1`**（`throw new Error(code + ': ' + pending.join(', '))`）；`gate.complete_blocked` 事件载荷 `pending` 深等于 `['e1']`；`batch.phase` 仍为 `running` |
| **B2** | 反向锁（防「夹具本身不合规所以拒」） | 同 B1 夹具，**只改一处**：`e1` 也结算到 `merged` | `setPhase('complete')` **成功**；`batch.phase === 'complete'`；`gate.complete_blocked` **零事件** ⇒ 证明 B1 的拒因是「exec 未终态」本身，不是夹具形态问题 |

### 3.4 刻意不写的用例

- **哨兵裸码** `GATE_ARTIFACT_MISSING` 的直调断言 —— 它是内部值，按设计不外显；写它等于把内部实现焊进测试（且行为面已覆盖）。
- **`GATE_COMPLETE_NO_TIER`** —— 已有 8+ 处断言（`gates.test.js:264,276` 等）。
- **白盒直调 `checkCompleteGate`** —— 本波要治的正是「白盒绿 ≠ 生产路径走过」。

---

## 4. 验收判据

1. 全量测试：`tests` 由 **1703 → 1708**，`todo` 保持 4，且**新增 0 例失败**（`fail` 恒 = 18，全部为 §7 环境缺陷）。
   > **口径修正**：本机 `fail = 0` 不可达（见 §7）。判据改为「新增失败数为 0」，即 Δfail = 0。
2. `node scripts/audit/gates.mjs --check` 报**「已消除无断言项 ≥ 2」**（`GATE_COMPLETE_NO_AUDIT` / `GATE_COMPLETE_EXEC_PENDING` 离榜），台账「有生产引用但无测试断言」由 **11 → ≤9**。
3. `node scripts/baseline-snapshot.mjs --check` 零漂移（基线已随本批重生成）。
4. `git status` 干净；`lib/**` 零 diff（可用 `git diff --stat -- lib` 复核）。

---

## 5. 风险与回滚

| 风险 | 等级 | 缓解 |
|---|---|---|
| 夹具形态不合规导致"拒"被误判为门禁正确 | 中 | **B2 反向锁**：同一夹具只改终态一处即放行 ⇒ 拒因可归因 |
| 新增文件未登记基线 ⇒ e2-1 转红 | 高（必然发生） | 同批跑 `baseline-snapshot.mjs --reason`，生成物同批提交 |
| A1 的"改 `wavePlan`"被误读为"测试在造非法状态" | 低 | 用例注释写明：这是门禁**自述**的威胁模型（`wave-plan.ts:465` 逐字「A1 双点：主防线 = 建批期，二级防线 = 运行期 `checkCompleteGate`」） |
| 误把补测当成"解冻" | 低 | 蓝图 §0 + commit message 双写「纯增量、零解冻」 |

**回滚**：`git revert <R3-1 commit>` 即可（单文件 + 一个生成物，无生产代码依赖）。

---

## 6. 后续（R3-2 及以后）

- **R3-2**：其余 8 枚逐枚判读「真缺口 / 假缺口（外显形态已覆盖）」，真缺口补测，假缺口登记判据与**覆盖它的既有断言行号**。
- **R3-3**：`GATE_AUDIT_CRITERIA_MISSING` **两处实现**判据单点化（`gates.ts` 收一处）—— 属重构，须独立波。
- **仍未解冻**：C1 26 项接线 / B1 10 项存废 / schema 消环 / 13 个 `_RE`… 均等新引擎形态。本波不解冻任何一项。

---

## 7. 环境缺陷（**与 R3 无关**，但影响「fail = 0」验收口径）

本机跑全量测试时，**3 个 git 依赖套件**恒失败 18 例（`worktree-tools.test.js` 6 · `merge-agent.test.js` 9 · `resume.test.js` 2），
报错一律 `worktree add (lane …) failed: fatal: invalid reference: punky/orch`。**已定位为环境缺陷，非 R3 引入**：

- **判定**：把 R3 新增文件暂移出 `test/`（此时 `test/` 树与 HEAD `c761cd1` 逐字节一致）后重跑，同样 16 例失败 ⇒ 与 R3 无因果。
- **最小复现**：`USERPROFILE` 指向非真实主目录时，**git 无法创建带斜杠的「嵌套 ref」**——
  `git branch punky/orch` **退出码 0、无任何报错**，但 `.git/refs/heads/punky/orch` 不存在；
  平坦名（`git branch flatbr`）正常。根因是中间目录 `.git/refs/heads/punky` 的创建被静默跳过，
  锁文件回落到 `.git/` 根（实测留下 `tXXXXXX` 形态残留临时文件），`commit_lock_file` 的失败未被上报。
- **触发路径**：`test/helpers/isolated-home.preload.mjs` 逐字 `process.env.USERPROFILE = root`（隔离根 = 临时目录）
  ⇒ 测试进程内所有 git 嵌套 ref 写入失效。**而引擎的分支命名全部嵌套**（`punky/main` / `punky/orch` / `punky/<lane>`）。
- **环境**：`git version 2.55.0.windows.5`；与本仓代码无关，`lib/**` 零 diff 亦复现。
- **不接受的做法**：改 `isolated-home.preload.mjs`（隔离纪律是安全面，不得为过测试而削）；改引擎分支命名为平坦名（行为变更 + 破坏 `punky/*` 语义约定）。
- **本波验收口径据此修正**：R3 的判据是 **「新增 0 例失败」**（18 例全部归因环境），而非「全量 fail = 0」；
  两枚目标门禁的 E2E 断言在**不含 git 的套件**内已全绿（5 tests / 25 asserts）。

