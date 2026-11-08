# 待裁决：`hostRoster` 是否补进改图路径（2026-11-07）

> 背景：`punky-engine-core-deepdive-20261107` 的 D-12 修复里，`plan-mutate.js` 的两处 `buildWavePlan`
> 已补 `smoke` / `handoffGate` / `hostRoster` 三项透传（提交 `1c3e5a0`）。其中 `hostRoster` 的
> **数据源**（读宿主 roster）在工具面，而 `task-tools.js` 目前拿不到 ⇒ 实际传的是 `[]`。
> 尝试补齐时撞上架构棘轮，故上报。

## 一、事实（已实测）

### 1. 缺口的性质

`buildWavePlan` 的 F-8「未知席位告警」需要比对基准 = `BUILTIN_ROLES` ∪ 宿主 roster 成员名。
- `wave-plan-tools.js:110`（`wave_plan` 建批）**传了** `hostRoster`；
- `task-tools.js` 的 `batch_tasks_add` / `task_update`（改图）**不传** ⇒ 基准退化为 `BUILTIN_ROLES`。

**影响面**：**只影响告警精度**（宿主自建的 role 名可能被误报为「未知席位」），
**不改变任何门禁判定**（未知席位是 `WARN_` 级，不是 `GATE_` 级，不拒任何操作）。

### 2. 尝试补齐时撞到的约束

给 `task-tools.js` 加 `import { createRosterPort } from '../provider-dsh/roster.js'` 后，
`test/deps-direction.test.js` **判红**：

```
新增依赖：["tools/task-tools.js:createRosterPort"]
本批方向是「引擎不依赖 provider」，新增须显式提交理由（白名单只许减不许增）
```

**这是仓里一条方向性棘轮**：`lib/**` 不得 import `lib/provider-dsh/**`（引擎不依赖 provider）。
`WHITELIST` 现有 **11 条**（A1=3 / A3=8），其中 `createRosterPort` 有 **3 条例外**：

| 文件 | class | 理由 |
|---|---|---|
| `tools/host-surface.js` | A3 | rosterPort 需 per-call agent 凭据（`exec.agent`）⇒ 不可预装配 |
| `tools/wave-plan-tools.js` | A3 | 建批期按 `exec.agent` 现取宿主名册；与上条同理由 |
| `bridge/dispatch-register.js` | A3 | 对账期按 `exec.agent` 现取凭据 |

⇒ 我这条会是**第 4 条**，理由与前三条**完全相同**（同样需要 per-call `exec.agent`）。

**但「白名单只许减不许增」是 spec R-5 的明文纪律**（`:228` 还有一条构成断言钉着 `{A1:3, A3:8}`）。
加一条 = 同时改纪律性判据 + 改构成断言 ⇒ **属架构约束变更，不是实现细节**。

### 3. 已做的处置

已 **revert** 该次改动（`git checkout lib/tools/task-tools.js`）：
- 工作树干净；`handoffGate` 的修复**不受影响**（那部分已在 `1c3e5a0` 提交）
- `deps-direction` 5/5 恢复绿

⇒ 当前状态：D-12 的 `handoffGate` / `smoke` 已修，**只剩 `hostRoster` 的数据源未接**。

## 二、三个选项

### 甲：加白名单第 4 条（最直接）

- **做什么**：`WHITELIST` 加 `{ file: 'tools/task-tools.js', symbol: 'createRosterPort', class: 'A3', reason: '…' }`；`:228` 的构成断言 `{A1:3, A3:8}` → `{A1:3, A3:9}`
- **代价**：突破「只许减不许增」棘轮一次；改一条纪律性断言
- **风险**：低（先例明确：`wave-plan-tools.js` 是第 3 条，同 class 同理由）
- **可逆**：是（删条目即回退）

### 乙：不回补（推荐）

- **做什么**：什么都不做。`hostRoster` 在改图路径保持 `[]`
- **代价**：宿主自建 role 名在改图时可能被误报「未知席位」
- **风险**：**零**（只影响告警精度；`WARN_` 级不拒任何操作）
- **可逆**：不涉及变更

### 丙：注入化（最优但成本高）

- **做什么**：`index.js` 在装配 `deps` 时提供 `rosterPortOf(agent)`；`task-tools.js` / `wave-plan-tools.js` 从 `deps` 取
- **代价**：改 3+ 文件（`index.js` / 两个 tools / 可能 `core.js` 签名）；同时**可以删掉 `wave-plan-tools.js` 那条第 3 白名单**（棘轮「只许减」正向使用）
- **收益**：**零新依赖**，且顺手减一条白名单 —— 这是唯一同时满足「不增依赖」和「补齐功能」的路径
- **风险**：中（动装配面 `index.js`）
- **可逆**：是

## 三、推荐

**短期选乙，中期选丙。**

理由：
- `hostRoster` 的收益是**告警精度**，而甲要付的是**架构棘轮的代价** —— 收益/成本不划算；
- 但丙是**方向正确**的（把「引擎不得依赖 provider」这条约束真正落地：provider 能力经 `deps` 注入，而不是在引擎内部 import），且**能顺手减一条白名单**；
- 若将来 `hostRoster` 变得重要（例如 F-8 告警被误报的投诉变多），走丙而非甲。

## 四、不裁决的后果

- **无默认**：不裁则维持现状（乙）—— 「`hostRoster` 在改图路径为空」记为已知限制，不影响任何门禁行为
- 不阻塞后续工作（这条不影响门禁判定，也不阻塞测试覆盖规划）

## 五、证据

- 缺口：`plan-mutate.js` 两处 `buildWavePlan` 调用（`addPoolTasks` / `addTaskEdges`）
- 数据源：`provider-dsh/roster.js:89` `createRosterPort(ctx, agent)`
- 棘轮：`test/deps-direction.test.js:193-212`（`WHITELIST`）/ `:232-236`（双向相等判据）
- 先例：`test/deps-direction.test.js:201-206`（F-8 返工时新增第 3 条 `createRosterPort`）
- 提交：`1c3e5a0`（`handoffGate` 部分已修）
