# 已实施内容清单 · 2026-09-21

- 对象仓：`D:\dsh\Punky-plugin-onto\packages\dsh-punky-swarm`
- 用途：**「已经做完的事」的唯一台账**。新规划/新施工前先查本文件，避免重复立项；本清单之外的新动作才需要新编号
- 标注口径：**【实测】** = 现场核读/命令取证；**【登记】** = 既有文档自述，未逐条回溯 commit
- ⚠ 本清单**只记已落地**。已裁但未施工的（如 K3 去返工边）**不在此列**，见 `docs/new-engine-blueprint-2026-09-21.md §7`

---

## §1 代码面（commit 级）

| # | 落地项 | commit / 时间 | 核验 |
|---|---|---|---|
| 1 | **R1 契约加固**：`vocabulary.json` + 元素级契约 + pending marker | `e3e8cd0`（09-20 14:09），tag `r1-done-20260920` | 【实测】`lib/state/vocabulary.json` 565B 在盘 |
| 2 | **链声明退役**（Q-A = C）：拓扑真源 = `wavePlan.tasks[].deps` + `batch.handoffs`；步级 join 由 `deps` 承担；`rework` 不进引擎 | adjudication §7 | 【实测】`lib/assembly/chain.js:833 expandChainBranches` 仅剩定义、零生产消费；读端 `chainEchoOf`（`:918`）保留兼容 |
| 3 | **并发闸取消**（Q-B）：`assertConcurrencyAdmit` / `concurrencyVerdictOf` / `CONCURRENCY_EXCEEDED_CODE` 删除；`GATE_CONCURRENCY_EXCEEDED` 出 union | adjudication §7 | 【实测】`lib/engine/dispatch.js:179-185 / :217` 删除留痕注释在案；`concurrency` 仅存声明与回显 |
| 4 | **R2 清理波**：`.wip-backup/` 删；B1 删 8 / 冻 10；B2 收敛 122；`scripts/audit/` 生成器链；冻结台账 | `17b6b97 … c761cd1`（09-21 01:07–01:34） | 【实测】`.wip-backup` 已不存在；`scripts/audit/` = `dead-code2 / classify / gates / gen-register / plan-lists / strength` |
| 5 | **R3g 门禁断言波**（纯增量，`lib/**` 零 diff）：无断言拒码 9 → **2**；拒码集合 66 → 66 零增删；真 E2E（loader 钩子 + 负向对照）；断言强度台账 | `fda041a … a944759`（09-21 02:16–04:05） | 【实测】1729 tests / 1725 pass / **0 fail** / 4 todo（连续两轮稳定） |

> R3g 子波：`fda041a`（R3-1 补测）· `035426d`（R3-2 判读）· `0d280ea`（R3-3 前提推翻 + fail-open）· `43c4b29`（R3-4 真 E2E）· `a3dcf22`（R3-3 冻结 + 源类型实证）· `a944759`（R3-5 强度台账）。

## §2 裁定面（未动代码或只动文档/生成器）

| # | 项 | 裁定 | 落地 | commit |
|---|---|---|---|---|
| 6 | **A1** | `GATE_BATCH_CONTROL_ACTION_INVALID` **冻结**（不删不改不拆 OR） | `gate-assertion-blueprint §11.1` + 冻结台账 | `37e3151` |
| 7 | **A2** | `assign_check` **保留原样**；「归属失实」改判为「已登记分层口径」（定性勘误） | `§11.2`；`lib/**` 与 `description` **零改动** | `37e3151` |
| 8 | **A3** | `sectionLineHit` **实证存在**（`gates.ts:399`，被 `:978/:987` 消费），非幻觉；新增「plan 产出规格 × 判据字面量」冲突 | `§11.3`；三选一**仍待裁** | `37e3151` |
| 9 | **A4** | 新引擎形态：任务管理器中心 + 更细拆分 + 更稳高并发 + 黑板 B-A | `docs/new-engine-blueprint-2026-09-21.md` | `37e3151` |
| 10 | **K1** | 层内不重算 · 非改派 · 引入公共池 · 派发 Leader 单点 | 蓝图 §2 / §3.2 / §4 | 本批 |
| 11 | **K2** | 仓内波称 **R3g**；路线稿波 1 称 **R3-增强**；`O-10` 引用须带文件简称 | 蓝图 §7.1 / §5.2-2 | 本批 |
| 12 | **K3** | 去返工边；返工 = gap-list + 新任务批次 | 蓝图 §2.4 + **§7.3 施工单（未开工）** | 本批 |
| 13 | **K4** | 路线在蓝图中重排（N0 / N0.5 / N1 / N1.5 / N2 / N3） | 蓝图 §7.2 | 本批 |

## §3 新增资产（既有规划里没有的，防止被重复规划）

| 资产 | 与既有规划的关系 |
|---|---|
| `scripts/audit/strength.mjs`（断言强度 title/exact/weak/other，`--selftest` 9 例） | 与路线稿 **O-01「判定等级机读化」部分同向但不等价**：O-01 = 运行期判定等级；strength = 测试断言强度分辨率。**不得互替代** |
| 冻结台账生成器链（`gen-register.mjs` + `REGISTER_OUT` 预览 + `--check` 漂移比对） | 落实裁决 ③；既有规划未覆盖 |
| 门禁台账 v3（拒码真源 = `contracts.ts` `GateErrorCode` union，66 项） | 取代旧「15 个无断言码」口径 |
| 判据分层通则（声明面 vs 内核兜底；「有引用 ≠ 可达」三分型） | 方法论资产，跨波复用 → `_research/punky-engine-judging-rules.md` |
| `docs/implemented-inventory-2026-09-21.md`（本文件） | 已落地台账；配合 `new-engine-blueprint §7` 使用 |

## §4 明确「不要重做」

1. **不重新定位/盘点拓扑与门禁** —— R3g 已完成（66 码真源、强度台账、冻结台账、`--check` 漂移比对）
2. **不重开「无断言门禁」** —— 余 2 枚（哨兵 `GATE_ARTIFACT_MISSING` + 不可达 `GATE_NO_DECLARATION`）**刻意不补**；A1 已裁冻结
3. **不再做链声明 / 并发闸** —— Q-A=C、Q-B 已闭合
4. **不重做 Jiuwen 对位** —— 路线稿 §4.2（可借 6 / 不可借 3）+ 集群稿 §6（不搬 4）已覆盖；新蓝图 §2.5 只做「受限采纳」增量
5. **不重排 C1 26 / B1 残留 10 / schema 消环 / C2 200** —— 蓝图 §6 已给批量解冻映射，只等形态定
6. **不重排路线稿波 2（R4 图修订）** —— 已并入 **N1**，13 触点与 R4-1/2/3 切片直接继承

---

*本文件随施工推进**追加**，不覆盖；已落地项不因后续冻结/解冻而删除，只可标注「已被 X 取代」。*
