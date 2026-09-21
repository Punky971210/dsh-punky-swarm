# dispatch 脱离父会话 · 根因分析报告（2026-09-21 23:3x）

**现象（用户报告）**：引擎 subagent dispatch 派发模式的 worker 会丢失父会话；缺陷根因未知。
**结论先行**：**结构性根因，已定性** —— worker 由 **spawn 后端**拉起，该后端的实现契约就是**零父上下文**；「是否继承父会话」在 DSH 里是 **provider 后端的选择**，不是引擎参数，也不是 bug。

---

## 1. 取证链（全部源码/实测，无推测）

### 1.1 引擎侧：`parent` 有传，但只做挂载不做继承

`lib/engine/dispatch.js:276-282`（`buildStartSpec`）：**有传 `parent: exec.agent`**。但宿主 `@deepseek-ai/dsh-subagent/lib/types/continuation.js:103-141` 中，`parent` 只用于：
- 会话树挂载与授权（`assertAdmitting(parent)` / `authorizeLineage` / `resolveChildDepth`）；
- 父会话归属 hold（`holdOwnership`）。

**子会话看到什么上下文，由 `host.prepareContinuable(...)` 返回的 `seed` 决定**（`continuation.js:141-142`：`inheritedEventCount = SessionLogOffset(prepared.seed?.length ?? 0)`）—— seed 为空 ⇒ 子会话从零开始。

### 1.2 后端实现：两个 provider，语义相反（源码全文已核）

| 后端包 | `inheritsParentContext` | `prepareContinuable` 返回 | 实现自述 |
|---|---|---|---|
| `dsh-subagent-spawn-in-process` | `false` | **空 `{}`** | "runs each child as a **fresh** child Agent … **zero parent context**. **The cheapest transport**" |
| `dsh-subagent-fork-in-process` | `true` | seed = 父会话日志**已完成 turn 前缀**（截至最后一个 `turn/end`；进行中 turn 不可重放，被排除） | "SEEDED with a prefix of the parent's session log — so the child **inherits the parent's conversation context**" |

### 1.3 现网配置（`--dump-config --profile web` 实测，0.1.6-alpha.1）

- 两个后端**都已注册**（`subagent-spawn-in-process` / `subagent-fork-in-process`，dsh-base 依赖两者）。
- 官方工具实例 `tool-subagent`（工具名 `subagent`）：**`provider: spawn`**、`backgroundMode: continuable`、`disabled: true`。
- `tool-subagent-fork`（工具名 `subagent_fork`）：`provider: fork`、`backgroundMode: one-shot`、**`disabled: true`**（fork 后端有注册但**无可用的官方工具入口**）。
- `tool-ralph`（disabled）同样配 `subagentProvider: spawn` ⇒ 内核默认取向 = spawn。
- 蟛蜞引擎自派 provider = `punky-preset/config/runtime.json` 的 `dispatch.provider` —— **该段缺失**（实测无此键）⇒ `lane_dispatch` 走「仅发句柄」降级；**直派形态**实际落到官方 `subagent` 工具 = **spawn 后端**。

## 2. 根因定性

> **dispatch 丢父会话 = spawn 后端的既定语义，不是缺陷触发的偶发现象。**
> DSH 的子会话上下文继承模型：`parent` 只管**树/授权/深度**；上下文继承 = provider 的 `inheritsParentContext` + `prepareContinuable` 的 seed。spawn = 最廉价传输，刻意不给父上下文；fork = 给（已完成 turn 的前缀）。现网一切派发面（官方 `subagent` 工具、ralph）都指向 spawn，fork 又无可用入口 ⇒ 观察到的 dispatch **必然**丢父会话。

**附带定性**：即便切到 fork，「继承」也有边界 —— seed 只含**已完成 turn**，派发那一刻进行中的工具调用轮不在 seed 里（fork 注释明言「当前轮 unbalanced 不可重放」）。任务指令本身仍靠 prompt 传递 ⇒ 蟛蜞五要素任务包（自足设计）正好适配此边界。

## 3. 修复选项

| # | 修法 | 成本 | 评估 |
|---|---|---|---|
| **R-A** | **配置面修复**：`punky-preset/config/runtime.json` 补 `"dispatch": { "provider": "fork" }` —— 引擎 `startContinuable` **直连 provider registry**（不经过 disabled 的工具实例），fork 后端已注册可用 | 极低（热更快照，改配置即生效，无需重启） | **推荐首选**。生效后 worker = fork 子会话，继承 Lead 已完成轮次 |
| R-B | 官方工具面：patch 翻转 `tool-subagent` 的 provider 为 fork | 低 | 但该实例 `disabled: true`，且改内核默认配置影响面大；蟛蜞自派不走工具实例，无必要 |
| R-C | teammate runner（设计稿 §4/B5） | 中 | agent-team `spawn_teammate` 的 fork 是另一条官方解法，按 D-3 等 T0 结论 |

**切 fork 前须评估的两点（R-A 的代价面）**：
1. **token 翻倍**：worker 上下文 = Lead 全部已完成轮次 + 自己的任务 —— 长会话 Leader 下成本显著；
2. **persona 带偏风险**：继承的对话可能压过任务包 persona（fork 实现支持 `persona` scoped shadowing，蟛蜞 `buildStartSpec` 已透传 `dispatch.persona`，可用）。

## 4. 验证建议（活体，未做）

1. 隔离 home 配 `dispatch.provider: "fork"` 跑最小批次，核对 worker 首轮是否可见 Lead 历史（`inheritedEventCount > 0`）；
2. 验证 spawn→fork 切换后五要素任务包 + persona 的行为面无回归；
3. 结论与本报告合并入设计稿 B5（teammate runner）施工前评估。

**取证文件**：`dsh-subagent/lib/types/continuation.js`（seed 机制）· `dsh-subagent-{spawn,fork}-in-process/lib/index.js`（全文 46/62 行）· `dsh-tool-subagent/lib/index.js:333-344`（`providerWording` 按 `inheritsParentContext` 变文案）· dump-config 275-288/333-338 行。

## 5. 与 agent-team 方案的关系澄清（2026-09-21 23:4x 用户追问）

**问**：dispatch 工具设计上只适用于 subagent 方案 —— 丢父会话是不是和 agent-team 方案混用了？

**答：代码路径上没有混用；「缺陷感」来自语义期望错位。**

1. **两条栈无交叉（取证）**：dispatch 派发路径（`lane_dispatch → dispatchLaneCore → rt.startContinuable`）**只触 `ctx.subagents` 服务**（`dispatch.js` 全文无任何 `agentTeams` 引用）；agent-team（`spawn_teammate`/`TeamTaskView`/`forkProvider`）是独立插件栈，有自己的 roster 与任务板。引擎里唯一的 agent-team 接触面是 `managerRosterOf` **只读回显**（`core.js:576`），不在派发路径上。
2. **丢父会话发生在纯 subagent 栈内**：spawn 后端零 seed 是它自己的设计定位（"cheapest transport"、fresh child），与 agent-team 无关。且 subagent 栈内**本就有** fork 后端（`dsh-subagent-fork-in-process`，可继承已完成 turn）—— 继承能力不是 agent-team 专属。
3. **错位所在**：spawn 的设计契约 = **无状态一次性执行器**（任务包自足、用完即弃）—— 这正是「subagent 方案」的本义；「worker 应该带着父会话记忆、是长期成员」是 **agent-team（durable teammate + fork）方案**的语义。把后者的期望套在前者上，「设计如此」就体验成了「缺陷」。
4. **处置含义（修正 R-A 的定位）**：
   - 若 dispatch 定位 = **一次性隔离执行器**（现设计）⇒ 丢父会话**不是缺陷**，五要素任务包自足正是为此；R-A（切 fork）应视为**可选增强**（「带记忆的子代理」），不是修 bug；
   - 若需要**继承父会话的长期成员** ⇒ 正解是 **agent-team 方案**（设计稿 §4/B5 teammate runner），dispatch 不改造、不背这个职责；
   - 两方案按设计稿 §4 双轨共存：同一块黑板、同一套门禁，席位形态分治。
