# sig · 任务内容指纹 设计提案（2026-09-22 04:5x，待裁）

**定位**：N3-② 实施提案。采纳裁定已下（「sig 可采用，设计需考虑形式和作用」）；本文给出形式与作用的具体设计，**待裁后施工**。参考来源：JiuwenSwarm J11 内容寻址 journal（蓝图 §89 借鉴裁定）；包内实现先例 = `lib/verify/selector.js`（`canonicalizeArgs` + `createHash('sha256')`）。

## §1 形式

### 1.1 落点：lane/task 级 `tasks[].sig`

- 指纹粒度 = **单任务**（重复判定的真实粒度是"同一内容的任务被派发/结算两次"，batch 级总签名无法定位重复面）；
- 随 `wavePlan` 持久化（append-only 落盘纪律不变）；契约面 = `WaveTask` 新可选字段（不参与既有门禁判定，风格同 `owner`）。

### 1.2 哈希构成（= C-4 裁定项，proposal）

```
sig = sha256(canonicalJSON({
  id, layer, role,
  deps:      [...保序],      // 依赖顺序 = 声明顺序（语义面）
  produce:   [...保序],      // 产物声明（exit 门 produce∪outputs 判定面）
  outputs:   [...保序],
  cmd:       <原文>,         // 命令/说明原文（prompt 语义载体）
  assemblyRef,               // 装配表签名（复用 assembly/snapshot.js sha256 先例）
}))
```

- **含 `assemblyRef`**：同任务不同装配可执行语义不同（角色/技能绑定变了 = 内容变了）⇒ 装配变即重签（严格判等）；
- **不含**：updatedAt / planRevision 等易变或派生元数据（planRevision 变化不必然代表该任务内容变化；任务内容真变了 sig 自然变）；
- **截断**：16 hex（`selector.js` 先例 12 hex 同级；内部判等碰撞概率可忽略，留全长扩展位）。

### 1.3 写入时机（唯一计算点纪律）

| 时机 | 动作 |
|---|---|
| `buildWavePlan` 建批 | 全量计算落盘（**唯一计算入口**） |
| `addPoolTasks` 追加任务 | 新任务补算 |
| `addTaskEdges` 加边 | deps 变化 ⇒ 受影响任务 sig 重算（加边 = 内容变化；发生在池内未派发任务 ⇒ 与 K1 不冲突；已派发任务结构上不可达此处） |
| 已派发（`owner≠null`） | **sig 冻结**（K1 内容冻结的结构推论，非新纪律） |

## §2 作用（消费点 = 幂等判等）

| 消费点 | 判等语义 |
|---|---|
| **派发面**：`lane_dispatch` 准入 | 同批次内存在 sig 相同且状态 ∈ {running, review, merged} 的**其他** lane ⇒ 幂等拒绝（防同内容任务重复派发） |
| **结算面**：`member_settle` / autoSettle 前置 | 同 sig 已 merged ⇒ 幂等拒绝/跳过 |
| **红线支撑**：禁隐式/无痕重算 | sig 随任务持久化 + 计算点唯一 ⇒ 任务内容任何变化必现 sig 差异；"同一内容无声重算"在机器上不可表达 |

**边界**：sig 不参与 Tier3 验收判定（不改变既有 66 拒码语义）；幂等拒绝只阻断动作 + 事件留痕，不新增治理状态。

## §3 待裁点

| # | 议题 | Proposal |
|---|---|---|
| D-sig-1 | 哈希是否含 `assemblyRef` | 含（装配变即重签，严格判等） |
| D-sig-2 | 幂等拒绝形态 | 直抛新拒码（如 `GATE_SIG_DUPLICATE`，入 union +1）vs 仅事件留痕——**建议拒码**（幂等拒绝是治理动作，须可断言） |
| D-sig-3 | 精度 | 16 hex |
| D-sig-4 | 加边重算 sig | 允许（池内未派发任务；已派发结构不可达，与 K1 无冲突） |

## §4 施工切面（获裁后）

- `lib/wave-plan.ts`：buildWavePlan 计算 + `WaveTask.sig` 字段；`addPoolTasks`/`addTaskEdges` 补算；
- `lib/tools/core.js`：lane_dispatch 准入判等；`member_settle`/autoSettle 前置判等；
- 冻结面：工具总数不变（零新工具）；拒码 union +1（若 D-sig-2 取拒码案）；测试 = 新建 sig 幂等套件 + 既有派发/结算套件回归；
- 预估：中批（1-2 个 commit），需基线重生成。
