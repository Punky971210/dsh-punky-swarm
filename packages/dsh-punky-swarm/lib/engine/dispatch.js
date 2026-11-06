/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// engine/dispatch.js —— **引擎自派**（engine-side dispatch）：C 档集群派发的执行通道。
// 定位：
//   · **按次收窄是唯一按次可用的收窄通道**：宿主 `subagent` 工具的模型面参数**不含** `toolFilter`
//     （`dsh-tool-subagent/lib/index.js:402-428`；`toolFilter` 只在插件配置 zod schema `:255-269` = 部署期静态），
//     而调用面 `rt.start(provider, request)` 的 `request.toolFilter` 是**按次**的（one-shot 与 continuable 走
//     **同一** `applyChildComposition`，`dsh-subagent-in-process-driver/lib/index.js:173-176`）
//     ⇒ 只有程序化调用者（= 本模块）能按次收窄。
//   · **宿主两代启动入口（2026-10-22 · A1-P2-04 校正；原「`start`/`startContinuable` 二选一」表述作废）**：
//       - `start(provider, request)` = **旧形态**：`request.toolFilter` / `request.persona` **按次生效**
//         ⇒ 本模块**唯一调用形态**（探针 `form==='start'`）；
//       - `startActivation(spec)` = **新形态**：spec **不承载** `toolFilter`/`persona`（宿主只按 `agentPreset`
//         组子会话 composition）⇒ 本模块**不接调用**，改**前置 fail-closed 拒派**
//         （`GATE_DISPATCH_CAPABILITY_UNAVAILABLE`，见 `dispatchLaneCore` ⓿）：照调 = worker 拿到**未收窄**的完整工具面
//         （含治理工具），与「能力位前置 / 不以弱换强」直接冲突；迁移（Agent Preset 承载）由单开批 F4 承接。
//   · **能力位前置**（调研收敛点 K4，5 源共识）：provider 不支持 `toolFilter` 时**拒派**，不「以弱换强」。
//   · **唯一写路径**（改善 W6）：自派成功后由引擎**直接写** `member.dispatch{lane, workerSessionId}`，
//     不再依赖 post-execute 事后观察（观察保留为兜底，覆盖 Leader 直派旧形态）。
//   · **失败显式**（修 W5）：任何失败路径都给出可读原因，不静默降级。
// 本模块是**纯函数 + 策略常量**（便于单测）；真正的调用点 = `lib/tools/member-tools.js:110` 的 `lane_dispatch`
//   （经 `dispatchLaneCore`；必须在**工具流水线内**执行：`exec.agent` 在场，子会话才能正确挂到本会话）。
//   【A1-P2-04 · 2026-10-22】原写「在 `lib/tools/core.js` 的 `lane_dispatch` 内」为**陈旧锚点**（该文件现 209 行、
//   无 `lane_dispatch`）——同一处错误的第二落点，一并订正，勿回写。
//
// ── 【2026-09-22 · one-shot 化（用户裁定「dispatch 彻底改为一次性执行器语义」）】 ──────────
//   · **spawn 通道**：**`rt.start(provider, request)`**（one-shot，fire-and-forget；探测判据 `form==='start'`）：
//     ⚠ 新宿主形态 `startActivation(spec)` **不接调用** ⇒ `dispatchLaneCore` ⓿ 前置拒派
//     （零状态变更 / 零句柄 / 零 `member.dispatch`）；run 生命周期属主 = 本模块 `activeRuns` 持有的 run 对象（`dsh-subagent-in-process-driver` 文件头：
//     "the one quiescent lifecycle owner held by the provider's caller"），**与 Leader 工具回合无关**；
//     引擎持引用、不调 `dispose` ⇒ worker 跑到完成（V-1 三层互证，见活体核报告）。
//   · **signal 纪律（禁透传 `exec.signal`）**：官方工具 foreground 用 `exec.signal`、background **故意新建
//     controller**（`dsh-tool-subagent/lib/index.js:559 / :543`）——`exec.signal` 随工具调用结束而中止 ⇒
//     本模块缺省**自持永不中止 signal**（`new AbortController().signal`），保 worker 跨回合跑完。
//   · **能力退役**：引擎侧**零** steer/queuePrompt/coldResume 依赖（2026-09-22 全库取证，19 条命中逐条判读）；
//     send_message worker 唤醒（continuous 专属）随 S2 退役。durable 会话/唤醒/续跑等 continuous 能力
//     **全部归 teammate runner**（agent-team 方案，`docs/agent-team-bridge-design-draft-v0-2026-09-21.md` §4/B5）
//     —— 两方案共用黑板与门禁，**不共用会话语义**。
//   · 依据：`docs/dispatch-one-shot-redesign-plan-2026-09-21.md` + 活体核
//     `docs/dispatch-one-shot-verification-2026-09-21.md`（V-1/V-2/V-3 全过）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { issueLaneHandle, consumeLaneHandle, firstLineOf } from '../bridge/lane-handle.js';
// 【P2 · arch-context】架构上下文注入件（独立成件；逻辑不进本文件 —— 本文件已逾千行）。
import { renderArchContext } from './arch-context.js';
// 【宿主端口面 · e3-agentport】成员执行面收进端口：引擎不再自己 `typeof rt.startActivation === 'function'` 判形态。
import { createAgentPort } from '../provider-dsh/agent.js';
// 派发登记事件常量（原在 `lib/tools/core.js` 侧引用；派发核心抽出后由本模块写，故此处直引）
// 【2026-09-18 · Q-B 取消并发闸】原同址直引的 `EVT_GATE_CONCURRENCY_BLOCKED` 已从本模块写端移除（唯一写点
//   随闸删除）；常量本体仍在 `lib/state/event-types.js` **冻结保留**（历史批磁盘事件面读端逐字不变）。
import { EVT_MEMBER_DISPATCH } from '../state/event-types.js';
// 【2026-09-18 · Q-B】原 `isBatchTerminal` 只为并发闸判据的「让位面」而引（`concurrencyVerdictOf`
//   的 `batch-terminal` 分支）；闸取消后本模块**零读点** ⇒ import 一并删除（不保留第二套批终态判据）。

/** 成员 deny 集（B2 的 deny 清单，S2 起含宿主连续控制族 4 件 ⇒ 20 项）+ 模式门覆盖集：**单点注册表在 `engine/suite.js`**（`SUITE_TOOLS`），
 *  本模块 `import` 后**再导出**（导出名不变、内容随注册表演进；不得退回字面量）。
 *  ⚠ 必须 `import` + `export {}` 两句分开写：`export … from` 只做透传、**不建本地绑定**，
 *  而本模块的 `buildStartRequest({ denyTools = SUITE_DENY_TOOLS })` 缺省值依赖本地符号（活体实测报 ReferenceError）。
 *  口径边界、`subagent`/`subagent_fork` 必 deny 的理由、以及 `mcp__*` 不入表的口径，均随实现迁至 `suite.js` 表头注释。 */
import { SUITE_DENY_TOOLS, MODE_GATED_TOOLS } from './suite.js';
export { SUITE_DENY_TOOLS, MODE_GATED_TOOLS };
// 【L2 注入预算】面 A · 任务包骨架：comms/inject-budget.js = 纯函数（阈值由调用方传入）；
//   assembly/schema.js 只取 readCapability 作**阈值唯一取值源**的读端（无反向依赖：schema.js 零 import 本模块）。
import { readCapability } from '../assembly/schema.js';
// 【D 档可达性修复 · 批 `punky-dgate-reachable-20261102`】续用绑定会话的**单点**：
//   `expectedWorkerSessionOf(batch, lane)` 纯读本批事件流、倒序取**最近一次** `member.dispatch` 的 worker 会话。
//   与 verify 面 `bindingDecision` **同源**（同一「lane 的绑定会话」定义）⇒ 不建第二真源。
import { expectedWorkerSessionOf } from '../verify/binding.js';
import { applyInjectionBudget } from '../comms/inject-budget.js';
// 【ckpt-wire · 批 `punky-checkpoint-wire-20261106` · lane `e1-resume`】A 通道（`resume` 条款）的**唯一取字源**：
//   `resumeClauseFor(task)` 返回 `RESUME_CLAUSE` 或 `null`（`lib/wave-plan.js:645`；文本定义 `:643`）。
//   硬口径 ★：**禁**在本文件复制 `RESUME_CLAUSE` 字符串（R-3 禁第二真源），只经该函数取。
//   循环依赖已核：`lib/wave-plan.js` 的 import 面（`assembly/schema.js` / `state/gates.js` /
//   `state/constants.js` / `types/guards.js` / `sig-fingerprint.js` / `roster.js` / `state/handoff-gate.js`）
//   **不含**本模块 ⇒ 单向依赖，无环。
import { resumeClauseFor } from '../wave-plan.js';

/**
 * 第二绑定键（B3，学 agent-teams 的 label 做法）：可从**子会话事件/描述**反解析 (batchId, lane)，
 * 不依赖引擎内存，重启后仍可核。
 */
const LABEL_PREFIX = 'punky-swarm:';

// N1-R4-1b：**派发面 owner 取值**（唯一来源 = 调用方 Agent 标识）。取不到 ⇒ `null` ⇒ `setMember` **零写入**
//   （既有行为不变）——owner 是声明面，缺失只影响池视图，不阻断任何门禁。
const ownerOfExec = (exec) => exec?.agent?.id ?? exec?.agent?.agentId ?? exec?.agent?.session?.id ?? null;
export function labelOf(batchId, lane) {
  return LABEL_PREFIX + String(batchId) + ':' + String(lane);
}

// ── 唤醒寻址（批 `lane-wake-mainpath-fix-20261010`；判据源 `plan/scope.md`）────────────────────
// 缺陷（P-1/P-2）：主路 `subagent/end`（`lib/index.js:597-665`）把**治理落点**（批归属键；命名黑板批下 =
//   黑板名）当**唤醒寻址**用 ⇒ `ctx.get('agents').get(黑板名)` = undefined ⇒ `leader-not-live`、静默；
//   而 `subagent/end` 的 `info` 载荷**不含**任何父会话键（L-AC-1 前置命题）⇒ 唯一解 = **派发期记录**
//   「发起该次派发的 agent 会话 id」进 `member.dispatch` 载荷，读端按它寻址。
// 分工（§约束 1 / L-AC-5）：`ownerSessionId` **只**解决「唤醒谁」；批归属键（`member.dispatch` 的读端
//   `sessionId` / 批文件落盘路径 / mailbox / 结算入参 / 候选面）**逐字不变**。
// **唯一解析单点**（§约束 2 / C-2）：字段名只在本段解析；三处读点
//   （`lib/index.js` 的启动重建与唤醒本体、`lib/engine/auto-settle.js` 的惰性重建）一律经本段取值，
//   **禁**各处自写字段名（同批1 的「唯一映射点」纪律）。
// 回退语义（C-3，**硬**）：缺失 / 空串 / 非字符串 ⇒ 寻址值**恰等于** `hit.sessionId` ⇒ 与 `dd1fbf0` 逐字相同。
//   ⚠ **不得**用 `??` 直连字段：空串会被 `??` 放行 ⇒ 唤醒侧退化成 `no-leader-session`（批1 已因此收紧过一次）。
// 取值式（R-6 钉死）：**统一** `exec?.agent?.session?.id` —— 与派发面 `parent: exec.agent`（`:701-702`）的父会
//   话口径同源，且与 `ctx.get('agents')` 的**会话 id 键**同族；**不**复用 `ownerOfExec`（其
//   `agent.id ?? agent.agentId ?? session.id` 键序会与写点 B 落值分叉 —— 见判据源 R-6）。
// R-7：取不到会话 ⇒ 不得写该键（`'cli'` 一类兜底值永不可能 live，进载荷即制造死地址）。
const asSessionId = (v) => (typeof v === 'string' && v.length > 0 ? v : null);
/** 写侧单点：`exec` → 发起该次派发的 agent **会话 id**（两写点共用；取不到 ⇒ `null`，不猜兜底）。 */
export function ownerSessionIdOfExec(exec) {
  return asSessionId(exec?.agent?.session?.id);
}
/** 读侧单点：`member.dispatch` 事件 / `dispatchIndex` 值 → 已记录的 owner 会话 id（非法形态 ⇒ `null`）。 */
export function ownerSessionIdOf(source) {
  return asSessionId(source?.ownerSessionId);
}
/** 唤醒寻址单点（含回退）：记录值合法 ⇒ 用之；否则回退批归属键（= 改前行为，逐字）。 */
export function wakeAddressOf(hit) {
  return ownerSessionIdOf(hit) ?? hit?.sessionId ?? null;
}

// ── 批归属会话解析（批 `d-override-fix-20261011` · lane `e4-session-bind`；判据源 = 本 lane 任务包 AC-2/AC-5）──
// 缺陷（实测原始回执）：引擎自派 worker 是**子会话**，`lib/tools/shared.js#sessionOf(args, exec)` 仅三级回落
//   `args.session → exec.agent.session.id → 'cli'` ⇒ worker **未传 session** 时落到 **workerSessionId**，
//   而批次归属键 = 派发方（Leader）会话 ⇒ `store.readBatch(workerSessionId, batchId)` 恒拒：
//     `Error: batch not found: <batchId> @<workerSessionId>`（lane `e2-guidance` 实测 4 次；本 lane 首步同样命中）。
// 修法（**单点**）：本函数 = worker 会话 → **批归属会话** 的唯一反查点，供 `sessionOf` 的可选第三参数消费
//   （注入链：`lib/tools/register.js#createTools` 经 `deps.resolveBatchSession` 透传给各批内工具）。
//
// 语义（逐条钉死）：
//   · **唯一数据源** = `dispatchIndex`（既有索引；三写点共用 `dispatchIndexEntryOf` 构造）——
//     **禁建第二套 worker→批 索引**，本函数只 `get`。
//   · **取键 = worker 会话 id** = 调用方 agent 会话 id（`ownerSessionIdOfExec` 同取值式 ⇒ 单一键口径）。
//   · 命中判据 = 索引值的 `sessionId` 为非空字符串（与 `lib/index.js:627` / `auto-settle.js:395` 同形）；
//     非法形态一律 `null`。
//   · **取不到 ⇒ `null`**（**不猜兜底**）：Leader 会话 / 未登记会话 / 索引冷启窗口 ⇒ 不命中 ⇒
//     `sessionOf` 逐字回落原三级路径（Leader 自身行为**零变化**）。
export function batchSessionIdOfWorker(dispatchIndex, exec) {
  if (!(dispatchIndex instanceof Map)) return null;
  const workerSessionId = ownerSessionIdOfExec(exec);
  if (!workerSessionId) return null;
  const hit = dispatchIndex.get(workerSessionId);
  return asSessionId(hit?.sessionId);
}

/** 索引**读**单点（模块私有；`batchSessionIdOfWorkerResolved` 取回填结果用）。
 *  **不导出**：导出面净增 0（C-8），且避免新增「测试可直接改索引」的面。
 *  `Map.prototype.get` 在本文件**只**出现在本函数体内 —— 逐字保持判据源强制口径
 *  「`lib/**` 内 `dispatchIndex[^\n]*\.get\(` 的消费文件集恰 3 件」在案（`test/lane-session-bind.test.js:274` AC-5 ②），
 *  与 `auto-settle.js:395`（先 `has` 后取）/ `index.js:521`（同类读点）**同形**。 */
function dispatchIndexHitOf(dispatchIndex, workerSessionId) {
  return dispatchIndex.get(workerSessionId);
}

// ── 批归属解析 resolver **外壳**（批 `session-bind-index-fix-20261012` · lane `e1-fix` · 修复①：未命中回落 + 回填）──
// 缺陷（P-3 ③）：引擎自派路径写 `member.dispatch` 事件但**不写** `dispatchIndex` ⇒ 「事件在盘上、索引里没有」
//   ⇒ `batchSessionIdOfWorker` 恒未命中 ⇒ `sessionOf` 回落 workerSessionId ⇒ `batch not found`。
//
// 分工（本批 Q-A 甲）：**主路** = 自派写点同步写索引（`dispatchLaneCore` 侧，见该函数内注释）；
//   本函数 = **兜底**（跨进程 / 历史批 / 漏登记 / 热更窗口）。两者共用值构造单点 `dispatchIndexEntryOf`
//   ⇒ 冷/热读数逐字相同（L-AC-5）。
//
// 形态（逐条钉死，守 scope §约束 5/6 与 techdebt §问题 S-a/S-b/S-d）：
//   · `batchSessionIdOfWorker` **逐字不动**（上函数零改动；S-a 的「冷索引 ⇒ `null`」断言天然不红）。
//   · 反查**复用** `laneBindingOf`（本文件 `:918-932`）—— **不建第二套反查、不建第二套索引、无负缓存**。
//   · 回填值**经** `dispatchIndexEntryOf`（3 键冻结 + `ownerSessionId` 非枚举；S-d）。
//   · 返回值**再经** `batchSessionIdOfWorker` 取（命中判据单点 ⇒ 冷/热读数同源；D-1.4）。
//   · 幂等判据（2026-10-22 · A1-P1-04 起，**取代**原「`has` 守卫」）三条：① 首写（索引无该键）⇒ 写；
//     ② 已存在但**缺 owner** 且本次反查取到**真值** ⇒ 就地升级（覆盖同一键）；③ 已带 owner ⇒ 整段不写（不重扫）。
//   · 全函数 try/catch ⇒ 失败一律 `null`（不炸工具面；C-5 / R-8）。
//   · **禁**写字面 `.get(`（Map 读一律走 `dispatchIndexHitOf` 单点）—— D-1.8。
//   · **不回写事件**（读侧补位只写索引，防「读触发写」；D-6 / §约束 3）。
//
// ✅ **已接线（2026-10-22 · A1-P2-04 校正；原「未接线 ⇒ 本函数零调用」表述作废）**：`lib/index.js` 的
//   `installTools` 已注入 `resolveBatchSession: (exec) => batchSessionIdOfWorkerResolved(store, dispatchIndex, exec)`
//   （按符号检索 `resolveBatchSession` —— 本批另一 lane 正在 `lib/index.js` 并行改动，行号会漂移，勿写死行号）。
//   接线后零行为变化保证（R-2）：未命中且无 `store` / 反查无果 ⇒ 逐字回原三级回落。
/**
 * @param {{listAllBatches?: Function, readBatch?: Function}|null|undefined} store 事件流数据源（缺 ⇒ 不命中）
 * @param {Map|null|undefined} dispatchIndex 既有**唯一** worker→批 索引（缺 / 非 Map ⇒ 不命中）
 * @param {{agent?: {session?: {id?: string}}}|null|undefined} exec 调用方 Agent（取键口径同写侧单点）
 * @param {object|undefined} logger 可选 cordis logger（**生产必传**，见 `lib/index.js` 调用方）：
 *   仅用于把 `laneBindingOf` 的 `batch-enum-failed:` / `batch-read-failed:` 两态**真可辨**；
 *   不传 = 静默（向后兼容），但生产路径不传 = M-1「能力在、接不到」的重演。
 * @returns {string|null} 批归属会话 id；未命中 / 数据源不可用 / 反查抛错 ⇒ `null`
 */
export function batchSessionIdOfWorkerResolved(store, dispatchIndex, exec, logger) {
  try {
    const hot = batchSessionIdOfWorker(dispatchIndex, exec); // 热路径：命中即返回（①⑤ 短路）
    if (hot) return hot;
    const workerSessionId = ownerSessionIdOfExec(exec); // 取键单点（与索引建键同口径）
    if (!workerSessionId) return null;
    if (!(dispatchIndex instanceof Map)) return null; // fail-safe：非 Map ⇒ 不写不猜
    // 【U-b（批 `punky-presmoke-2026-10-31`）】下传 logger ⇒ 反查失败的**两态可辨**（枚举坏/读坏），
    //   否则本函数的 `null` 与「真无绑定」同形（静默失败）。
    const bind = laneBindingOf(store, workerSessionId, logger); // 复用同文件既有反查（:918-932）
    if (!bind) return null; // 无 store / 无事件 ⇒ 逐字原回落（R-2 / L-AC-2）
    // 【2026-10-22 · A1-P1-04】回填**取真值 owner**（改前此处硬传 `null`）：
    //   ① 改前的 `null` 让 `wakeAddressOf` 在该 worker 上**永久**退化为批归属键（冷索引批的唤醒投错会话）；
    //   ② 改前的 `has` 守卫一旦为真就**永不再写** ⇒ 把 `auto-settle.js` 主路「带 owner 的惰性重建」**永久压制**
    //      （那条重建只在 `!hit` 时触发，而本函数已先把键写进去 ⇒ 重建永不触发）。
    //   取真值的唯一来源 = `laneBindingOf` 按解析单点 `ownerSessionIdOf(ev)` 带回的非枚举字段（同一反查、不建第二套）。
    //   命中判据（**允许覆盖**这条；幂等性以「已带 owner 则整段不写」守住，故不退化）：
    //     · 首写（无该键） ⇒ 写；
    //     · 已存在但**缺 owner** 且本次取到真值 ⇒ 就地升级（覆盖同一键）；
    //     · 已带 owner ⇒ 不写。
    //   ⚠ **末句可达面（如实登记，勿当「已修」读）**：热路径 `batchSessionIdOfWorker` 命中即短路
    //     （`test/lane-session-bind.test.js` 回归-b 以「二次调用零扫盘」锁死该短路）⇒ 「既有条目 sessionId **合法**
    //     但缺 owner」这一形态**走不到本段**（规格 §B T-2.3 与该锁结构性冲突，已登记待裁决）。
    //     本段升级分句的可达面 = 既有条目 **sessionId 非法/空**（热路径不命中）⇒ 以真值修复它。
    //     正常缺 owner 条目的处置：冷/热重建侧（启动重建 `lib/index.js`、登记点、`auto-settle` 惰性重建）本就
    //     经 `ownerSessionIdOf(ev)` 带值 ⇒ 重启后不再存在这类条目（Q5 口径「改完不重启」⇒ 重启后自然消解）。
    //   值仍经**值构造单点** `dispatchIndexEntryOf` ⇒ 枚举键恒为 3 键（`ownerSessionId` 非枚举，形状锁不变）。
    const existing = dispatchIndexHitOf(dispatchIndex, workerSessionId); // 读单点（禁本函数写字面 `.get(`）
    const owner = ownerSessionIdOf(bind);
    if (!existing || (ownerSessionIdOf(existing) === null && owner)) {
      dispatchIndex.set(workerSessionId,
        dispatchIndexEntryOf(bind.sessionId, bind.batchId, bind.lane, owner));
    }
    return batchSessionIdOfWorker(dispatchIndex, exec); // 返回经既有单点 ⇒ 读数同源（D-1.4）
  } catch {
    return null; // 吞错 = 视为不命中（工具面不得因归属解析而炸；C-5 / R-8）
  }
}

/**
 * `dispatchIndex` **值构造单点**（三写点共用：装配启动重建 / 结算路惰性重建 / 登记点热更新）。
 *
 * 形状契约（**既有**，不得改）：索引值的对外形状 = `{ sessionId, batchId, lane }`。它是**在案冻结面**——
 *   `installDispatchRegistration().mapping()` 的回显形状，且 `test/dispatch-register.test.js` 以 4 条
 *   `deepEqual` 形状锁（R2 / R2b / R6 / R10）逐字钉住它（判据源 L-AC-11 要求该套件**零新增失败**）。
 *   ⇒ 本批新增的唤醒寻址读数**不得**让值变成 4 键。
 * 承载方式：`ownerSessionId` 以**非枚举自有属性**附加 ⇒ `Object.keys` / `deepStrictEqual` / JSON 序列化 /
 *   面板回显**逐字保持既有形状**；取值面 `ownerSessionIdOf` 按属性名直读 ⇒ 三读点读数一致。
 *   ⚠ 这是**声明式附加**而非遮蔽：`Object.getOwnPropertyNames(v)` 可见该字段；`member.dispatch` **载荷**里
 *     它是普通**可枚举键**（落盘可见、审计可核）。被冻结的只有**索引值的形状**。
 */
export function dispatchIndexEntryOf(sessionId, batchId, lane, ownerSessionId) {
  const entry = { sessionId, batchId, lane };
  if (ownerSessionId) {
    Object.defineProperty(entry, 'ownerSessionId', {
      value: ownerSessionId, enumerable: false, writable: true, configurable: true,
    });
  }
  return entry;
}

// ── role 数据面（P2 · 批 `role-injection-refactor-20261006` / lane `e02-inject`）─────────────────
// 三处注入（依据判据源 `plan/role-injection-spec.md` 的 R-3/R-4/R-5 ＋ 计划 §2.3/§2.4）：
//   ① `composeWorkerPrompt()`：role 独占「## 你的职责 / ## 你被授权决定 / ## 交付要求」三段；
//   ② `buildStartRequest().persona`：由 role 的 `title` + `mission` + 工作方式（正文 Persona 段）派生
//      —— 同 role 跨批稳定；
//   ③ `buildStartRequest().toolFilter.deny`：由 `tools.allow` **反推**，与冻结集 `SUITE_DENY_TOOLS` 合并。
// **结构隔离代替优先级判定**（计划 §2.4）：Leader 的 `prompt` 只有一个落点
//   `## 任务要点（Leader 补充）`，role 三段与「## 纪律」段 Leader **无位置可写** ⇒ 不存在覆盖问题；
//   故本段**不含**任何「谁优先」的判定器（一处都不许有 —— 那是被明令否决的实现路径）。
// **降级路径**（计划 §10.4 Q-5 = 乙→甲）：role **已声明但解析不到** ⇒ **拒派**（`GATE_ROLE_UNRESOLVED`），
//   **不得**静默退回硬编码骨架（零静默，C-8）。**未声明 role**（`null` / `undefined` / 空串，如 generic
//   lane）不是「查不到」⇒ 维持既有骨架形态（**零行为变化**）。
// **单点真源**（N-1）：role 解析 + allow→deny 反推各只有一处实现（本段）；`lib/wave-plan.ts` 只做 role
//   **归一化与合法集校验**（layer 缺省 + `GATE_ROLE_INVALID` 告警），不持有任何数据面解析。

/** role 解析不到的**拒派码**（与「能力位前置 = 拒派」同口径；零静默）。 */
export const ROLE_UNRESOLVED_CODE = 'GATE_ROLE_UNRESOLVED';

/** 三段**裸标题**（行首逐字、**无后缀**）：写成 `## 你的职责（…）` 会让裸标题判据失配。 */
export const ROLE_SECTION_TITLES = Object.freeze({
  responsibilities: '## 你的职责',
  authorities: '## 你被授权决定',
  deliverables: '## 交付要求',
});

/** 必填字段（计划 §3.2「缺一即拒」）。**`deliverables` 不在其中**（本批 R-1 起转**可选**）：
 *  它是角色级**形态提示**，不是硬真源 —— 批次级产物路径归 `wavePlan.produce/outputs` ＋ `handoff_submit`；
 *  故缺席**不判缺、不抛 `GATE_ROLE_UNRESOLVED`、不回落**（零静默由「交付要求段少行/占位」表达，不由拒派表达）。
 *  **只对文件解析面生效**：模块级直调传入的 role 对象不强制，
 *  因为直调只构造需要的字段位（见判据源 L-AC-3/L-AC-4 的可达构造）。 */
export const ROLE_MANDATORY_FIELDS = Object.freeze(['id', 'title', 'layer', 'mission', 'responsibilities']);

/** 默认团队（同 id 跨团队重名时的**团队序首位**）。依据 = 仓库既有约定
 *  `test/helpers/skill-paths.mjs` 的 `withDefaultTeam(byName, team = 'software-team')`，非本段新造。 */
const DEFAULT_ROLE_TEAM = 'software-team';
const ROLE_DIR_SEGMENTS = ['references', 'roles'];

/** 包根（`lib/engine/` → 包根）：role 语料库（`<包根>/skills/<team>/references/roles/`）的起点。 */
export function roleCorpusRoot() {
  return fileURLToPath(new URL('../../', import.meta.url));
}

/** 角色语料目录（**团队序**：默认团队优先，其余按目录名字典序）。目录不在场 ⇒ 该团队不参与解析。 */
export function roleTeamDirs({ root = roleCorpusRoot(), fsImpl = fs } = {}) {
  const skillsRoot = path.join(root, 'skills');
  let names = [];
  try {
    names = fsImpl.readdirSync(skillsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return []; }
  const withRoles = names.filter((n) => {
    try { return fsImpl.statSync(path.join(skillsRoot, n, ...ROLE_DIR_SEGMENTS)).isDirectory(); } catch { return false; }
  });
  const ordered = (withRoles.includes(DEFAULT_ROLE_TEAM) ? [DEFAULT_ROLE_TEAM] : [])
    .concat(withRoles.filter((n) => n !== DEFAULT_ROLE_TEAM).sort());
  return ordered.map((n) => path.join(skillsRoot, n, ...ROLE_DIR_SEGMENTS));
}

// ── YAML frontmatter 子集解析（**无第三方依赖**，只覆盖 role 语料的实际形态）──────────────────────
// 覆盖面：顶层 `key: 标量` / `key: [a, b]` / `key:` + `  - 标量` / `key:` + `  - k: v`（含续行）
//         / 嵌套映射（`tools:` + `  allow: […]`）。**不覆盖**多行块标量、锚点、注释块——语料内不存在。
const KV_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(.*))?$/;

function stripQuotes(raw) {
  const s = String(raw ?? '').trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/** inline 列表 `[a, b]` → 数组（**引号内的逗号不算分隔符**）；非列表形态 ⇒ null。 */
function inlineListOf(raw) {
  const s = String(raw ?? '').trim();
  if (!s.startsWith('[') || !s.endsWith(']')) return null;
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of s.slice(1, -1)) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ',') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(stripQuotes).filter((x) => x !== '');
}

function yamlScalar(raw) {
  const t = String(raw ?? '').trim();
  const list = inlineListOf(t);
  if (list) return list;
  if (t === 'true') return true;
  if (t === 'false') return false;
  return stripQuotes(t);
}

/** 块体解析：`- 标量` 列表 / `- k: v`（含续行）对象列表 / 映射。 */
function yamlBlockOf(blockLines) {
  if (blockLines.some((l) => /^\s*-\s/.test(l))) {
    const items = [];
    let cur = null;
    for (const line of blockLines) {
      const dash = /^\s*-\s*(.*)$/.exec(line);
      if (dash) {
        const kv = KV_LINE.exec(dash[1].trim());
        cur = kv ? { map: { [kv[1]]: yamlScalar(kv[2]) } } : { scalar: yamlScalar(dash[1]) };
        items.push(cur);
        continue;
      }
      const kv = KV_LINE.exec(line.trim());
      if (kv && cur?.map) cur.map[kv[1]] = yamlScalar(kv[2]);
    }
    return items.map((it) => (it.map ? it.map : it.scalar));
  }
  const map = {};
  for (const line of blockLines) {
    const kv = KV_LINE.exec(line.trim());
    if (kv) map[kv[1]] = yamlScalar(kv[2]);
  }
  return map;
}

/** 解析 role 文件的 YAML frontmatter（`---` 围栏之间的顶层键）。无围栏 ⇒ null。 */
export function parseRoleFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ''));
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = KV_LINE.exec(line);
    if (!kv) continue;
    const rest = kv[2];
    if (rest !== undefined && rest.trim() !== '') { out[kv[1]] = yamlScalar(rest); continue; }
    const block = [];
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i]);
    out[kv[1]] = block.length ? yamlBlockOf(block) : '';
  }
  return out;
}

/** 正文段抽取（行首恰为 `## <heading>` 起、至下一个 `## ` 前）：取「工作方式」= `## Persona（注入用）`。 */
function bodySectionOf(text, heading) {
  const lines = String(text ?? '').split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === heading);
  if (at < 0) return '';
  const out = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    if (lines[i].trim()) out.push(lines[i].trim());
  }
  return out.join(' ');
}

function missingMandatoryOf(fm) {
  return ROLE_MANDATORY_FIELDS.filter((k) => {
    const v = fm[k];
    return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
  });
}

/** 文件文本 → role 数据对象（必填缺一即抛 `GATE_ROLE_UNRESOLVED`）。 */
function roleDataOfText(text, source) {
  const fm = parseRoleFrontmatter(text);
  if (!fm) throw new Error(ROLE_UNRESOLVED_CODE + ': 角色文件无可用 YAML frontmatter · ' + source);
  const missing = missingMandatoryOf(fm);
  if (missing.length) {
    throw new Error(ROLE_UNRESOLVED_CODE + ': 角色 ' + String(fm.id ?? '(无 id)') + ' 缺必填字段 '
      + missing.join('/') + ' · ' + source);
  }
  return { ...fm, persona_text: bodySectionOf(text, '## Persona（注入用）'), source };
}

/**
 * role 解析（**单点真源**）：
 *   · 已是对象 ⇒ 原样直用（模块级直调 / 引擎内部已解析面）；对象缺字段**不**在此强制（直调只构造需要的位）；
 *   · 非空字符串 ⇒ 按团队序在语料库内查 `<team>/references/roles/<id>.md`；零命中 ⇒ **抛 `GATE_ROLE_UNRESOLVED`**；
 *     多命中（同 id 跨团队重名，如 `designer` / `coordinator`）⇒ 按团队序取首个并**留痕告警**（确定性 + 可复现）；
 *   · `null` / `undefined` / 空串 ⇒ **null**（= 未声明，**不是**「查不到」）⇒ 调用方维持既有形态。
 * @returns {object|null} role 数据对象
 */
export function resolveRoleRef(roleRef, { root = roleCorpusRoot(), team, fsImpl = fs, warn } = {}) {
  if (roleRef && typeof roleRef === 'object') return roleRef;
  const id = typeof roleRef === 'string' ? roleRef.trim() : '';
  if (!id) return null;
  const dirs = team
    ? [path.join(root, 'skills', String(team), ...ROLE_DIR_SEGMENTS)]
    : roleTeamDirs({ root, fsImpl });
  const hits = [];
  for (const dir of dirs) {
    const file = path.join(dir, id + '.md');
    try { if (fsImpl.statSync(file).isFile()) hits.push(file); } catch { /* 该团队无此 role */ }
  }
  if (!hits.length) {
    throw new Error(ROLE_UNRESOLVED_CODE + ': role "' + id + '" 在 ' + dirs.length + ' 个角色目录内零命中'
      + '（' + (team ? 'team=' + team : '团队序=' + dirs.join(' | ')) + '）'
      + ' ⇒ 拒派（role 数据面缺失**不得**静默退回硬编码骨架）');
  }
  if (hits.length > 1) {
    warn?.('[dsh-punky-swarm] role "' + id + '" 在 ' + hits.length + ' 个团队内重名 ⇒ 按团队序取首个：'
      + hits[0] + '（其余：' + hits.slice(1).join(' · ') + '）');
  }
  return roleDataOfText(fsImpl.readFileSync(hits[0], 'utf8'), hits[0]);
}

function allowOfRole(roleData) {
  const allow = roleData?.tools?.allow;
  return Array.isArray(allow) ? allow.filter((t) => typeof t === 'string' && t.trim() !== '') : [];
}

/**
 * 引擎 role 语料库的**工具词汇表** = 全部 role 文件 `tools.allow` 的并集（保序去重）。
 * ⚠ 结构安全（**这是「反推全集」的选型理由，勿改回 `SUITE_TOOLS`**）：词汇表**只由 role 语料自身生成**
 *   ⇒ 它**结构上不可能**含引擎治理面工具（`handoff_submit` / `swarm_report` / `lane_checkpoint` /
 *   `batch_status` … 都不在任何 role 的 allow 内）⇒ 反推**不可能** deny 掉 worker 的回报/交接面。
 *   若把全集取成 `SUITE_TOOLS`（38 件），反推会把上述治理面整体 deny ⇒ **worker 再也交不了接、回不了报**
 *   （与任务包纪律「必须 `handoff_submit`」直接矛盾）—— 该路径已实测排除。
 */
export function roleToolVocabulary({ root = roleCorpusRoot(), fsImpl = fs, warn } = {}) {
  const vocab = [];
  for (const dir of roleTeamDirs({ root, fsImpl })) {
    let files = [];
    try { files = fsImpl.readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { continue; }
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        for (const t of allowOfRole(roleDataOfText(fsImpl.readFileSync(full, 'utf8'), full))) {
          if (!vocab.includes(t)) vocab.push(t);
        }
      } catch (e) {
        warn?.('[dsh-punky-swarm] role 语料解析跳过 ' + full + '：' + String(e?.message ?? e));
      }
    }
  }
  return vocab;
}

/** `tools.allow` **反推 deny**（R-5）：`词汇表 \ allow`。
 *  未声明 / 空 `allow` ⇒ 返回 `[]`（**不反推**）—— 否则「无工具声明」会被反推成「全词汇表 deny」，
 *  静默阉割 worker 的读写能力（零静默：宁可不禁，不许误禁）。 */
export function deriveDenyTools(allow, opts = {}) {
  const list = (Array.isArray(allow) ? allow : [])
    .filter((t) => typeof t === 'string' && t.trim() !== '')
    .map((t) => t.trim());
  if (!list.length) return [];
  return roleToolVocabulary(opts).filter((t) => !list.includes(t));
}

/** 人格级注入（R-4）：`title` + `mission` + 工作方式（role 正文 `## Persona（注入用）` 段）。 */
export function personaOfRole(roleData) {
  if (!roleData || typeof roleData !== 'object') return undefined;
  const parts = [roleData.title, roleData.mission, roleData.persona_text]
    .map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
  return parts.length ? parts.join('；') : undefined;
}

function listOf(v) { return Array.isArray(v) ? v : []; }

// ── 【批 `punky-guidance-preflight-20261025` · lane `c1-preflight`】P0-1「开工前必做」四段内联 ────────
// 任务包本段 = 把「本任务该查哪个库 / 用哪个技能 / 用哪个 MCP / 照哪几条检查表」**逐字**写进任务包，
// 不再留给成员推断（根因：技能与工具的选择发生在「打开任务之前」，任务包不点名，成员没有信息去选）。
//
// **单点渲染**（落点 = 丙）：本组函数是**唯一**渲染实现，两处共同调用 ——
//   ① 引擎自派路径：`composeWorkerPrompt`（本文件）；
//   ② Leader 直派取件口：`lib/tools/query-tools.js` 的 `role_guide`（薄壳，零模板）。
// 两处输出**逐字一致**由结构保证（同一函数、同一阈值来源），禁各自拼模板、禁在工具面复制一份。
// ⚠ 本段文案不得掺元信息（批次号/版本号/来源追溯）：只写当下可执行的事实。
const PREFLIGHT_SECTION_TITLE = '## 开工前必做';
// 四段头**恒出**（保证锚点稳定：某段空也照样出段头，只把子项位置成占位行）。
const PREFLIGHT_HEADERS = Object.freeze([
  '1. 查知识库（`weknora_search`）——命中即按「正向做法」执行并登记来源；无命中写一行「无命中」照常推进：',
  '2. 调用技能（`skill`）——开工前先读该技能正文，按其契约做事：',
  '3. 使用 MCP——行尾写用途，否则不知道该拿它干什么：',
  '4. 本任务检查表——逐条照做，不用翻文档：',
]);
const PREFLIGHT_SUBITEM_ABSENT = '   - （本任务未声明此项）';
const PREFLIGHT_MCP_WHY_ABSENT = '（用途未声明）';
const PREFLIGHT_KB_SOLE_HINT = '   - （提示：知识库关键词建议 2-3 个，当前仅 1 个）';
// 分支②：**完全未声明**时的唯一输出（段头恰 1 行 + 警示恰 1 行）。它是「不静默」的落点，不是错误码。
const PREFLIGHT_UNDECLARED_LINE = '> ⚠ 本任务未声明开工前必做项（`preflight` 的 kb / skills / mcp / checklist 四段全缺）：'
  + '请自行判断是否需要查知识库、调用技能、使用 MCP，并把结论写进回报的 `knowledge_hits` / `skills_used` / `mcp_used`。';

// ── 【批 `punky-engine-fix2-20261106` · lane `e4-ckpt-aux`】四段**单项文本**的共享格式化单点 ────────
// 存在理由（判据源 S5-3「复用 `renderPreflightLines` 的文案与词汇，禁另造一套」）：
//   `## 开工前必做`（任务级，`renderPreflightLines`）与 `## checkpoint 计划` 的逐项子行
//   （`renderCheckpointsBlock`）是**同一套词汇的两个落点** ⇒ 三种单项文本只允许一份表达式。
//   **不改口径**：下三式与抽取前 `renderPreflightLines` 内的内联表达式**逐字等价**（输出字节相同），
//   仅把「拼字符串」抽到一处，防两处各写一遍后漂移（漂移症状 = 成员在两个段里看到不同指令形态）。
const kbItemTextOf = (k) => '`weknora_search("' + k + '")`';
const skillItemTextOf = (s) => '`skill("' + s + '")`';
/** MCP 单项：`` `<tool>` —— <why> ``；缺 `why` ⇒ 逐字占位 `PREFLIGHT_MCP_WHY_ABSENT`（E4-K8）。 */
const mcpItemTextOf = (m) => '`' + String(m.tool).trim() + '` —— '
  + ((typeof m.why === 'string' ? m.why.trim() : '') || PREFLIGHT_MCP_WHY_ABSENT);

/** 声明判定（纯函数、零 IO、零抛错）：`task.preflight` 是 plain object ⇒ 已声明；其余（缺省/null/数组/标量）⇒ 未声明。
 *  **区分「未声明」与「声明了但四段全空」是本函数唯一的判断**（二者渲染形态不同：警示行 vs 四段+占位）。
 *  读值异常（getter 抛错等）⇒ 按**未声明**降级（fail-safe：本字段的用途是提示，绝不能阻断派发）。 */
export function preflightOf(task) {
  try {
    const raw = task?.preflight;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { declared: false, decl: null };
    return { declared: true, decl: raw };
  } catch {
    return { declared: false, decl: null };
  }
}

/** 分支 ③④⑤ 的组装单点（纯函数）：给定**已判定**的声明对象（`null` = 未声明）返回段文本行。
 *  逐条口径：
 *   · 四段头**恒出**（声明了就是声明了：空段渲染占位行，与「未声明」的警示行**形态可辨**）；
 *   · `kb` 恰 1 个 ⇒ 子项后追加软提示行（少于建议的 2-3 个；**不拒建批、不抛错**）；
 *   · `mcp` 项缺 `why`（`''`）⇒ 行尾渲染显式占位「（用途未声明）」（不静默丢项）。 */
export function renderPreflightLines(decl) {
  if (!decl || typeof decl !== 'object' || Array.isArray(decl)) {
    return [PREFLIGHT_SECTION_TITLE, PREFLIGHT_UNDECLARED_LINE];
  }
  const stringsOf = (v) => listOf(v).filter((x) => typeof x === 'string' && x.trim() !== '');
  const kb = stringsOf(decl.kb);
  const skills = stringsOf(decl.skills);
  const mcp = listOf(decl.mcp).filter((m) => m && typeof m === 'object' && typeof m.tool === 'string' && m.tool.trim() !== '');
  const checklist = stringsOf(decl.checklist);
  const L = [PREFLIGHT_SECTION_TITLE];
  L.push(PREFLIGHT_HEADERS[0]);
  if (kb.length) {
    for (const k of kb) L.push('   - ' + kbItemTextOf(k));
    if (kb.length === 1) L.push(PREFLIGHT_KB_SOLE_HINT);
  } else L.push(PREFLIGHT_SUBITEM_ABSENT);
  L.push(PREFLIGHT_HEADERS[1]);
  if (skills.length) for (const s of skills) L.push('   - ' + skillItemTextOf(s));
  else L.push(PREFLIGHT_SUBITEM_ABSENT);
  L.push(PREFLIGHT_HEADERS[2]);
  if (mcp.length) {
    for (const m of mcp) L.push('   - ' + mcpItemTextOf(m));
  } else L.push(PREFLIGHT_SUBITEM_ABSENT);
  L.push(PREFLIGHT_HEADERS[3]);
  if (checklist.length) for (const c of checklist) L.push('   - ' + c.trim());
  else L.push(PREFLIGHT_SUBITEM_ABSENT);
  return L;
}

/** 开工前必做段**整块**渲染（唯一导出面；两处调用点共用）。
 *  **fail-safe（硬）**：整段包 try/catch —— 任何异常（畸形声明 / getter 抛错 / undefined 访问）⇒ 降级为
 *  **分支② 警示行**，**绝不向上抛**。理由：`composeWorkerPrompt` 在 `setMember(running)` 之后、`rt.start` 之前
 *  执行，它抛错会落进 `dispatchLaneCore` 的 catch ⇒ lane 置 `failed` + 句柄作废 + **不可原地重派**（代价 = 整批作废）。
 *  **注入预算**：面名 `taskpack.preflight`、层② `perBlock`（整块一层）；未超限 ⇒ **原值本身**，
 *  超限 ⇒ 既有省略标记 `…[omitted <N>B @ taskpack.preflight]`（消费方当场可辨）。
 *  `injectBudget` 缺省 `null` ⇒ `applyInjectionBudget` 零动作（`thresholds.enabled !== true` 即原值返回）。
 * @param {object|null|undefined} preflight `WavePlanTask.preflight`（已声明对象 / `null` = 未声明）
 * @param {{injectBudget?: object|null}} [opts]
 * @returns {string} 段文本（**不含**前导空行；前导空行归调用方，与 `renderRoleGuide` 同款边界约定）
 */
// ── 【pk-impl · 批 `punky-taskpkg-checkpoint-20261101`】`checkpoints` 读取 + 渲染（单点）──────────
// 与 `preflight` 的两处**刻意差异**（防误抄）：
//   · **缺省不警示**：`preflight` 未声明会出「未声明开工前必做项」警示行；`checkpoints` 缺省 ⇒ **完全不出段**。
//     理由：存量批海量，给缺省加警示会污染**全部**派发。
//   · **仅当「声明了但归一后为空」才给恰一行降级警示**（坏项被丢弃这件事本身要可见，不静默）。
// 【e4-ckpt-aux · 2026-11-06】四段扩展（`skills` / `kb` / `mcp` / `checklist`）追加在**逐项**层级 ⇒ 第三处
//   **刻意差异**：`preflight` 是任务级唯一区块（四段恒出、空段占位）；本段是**逐项子行**（**有才出**），
//   某项四段全空 ⇒ **恰一行**建议性警示（不铺 4 行占位，E4-K5 判红「多行噪声」）。全空 ≠ 未声明：
//   四键在归一阶段就不写（`lib/wave-plan.ts#normalizeCheckpoints`）⇒ 渲染层只认「子行 0 行」。
/** 声明判定（纯函数、零 IO、零抛错）：`task.checkpoints` 已声明 ⇒ `{ items }`；未声明/读值异常 ⇒ `null`。
 *  **区分「未声明」与「声明了但归一后为空」是本函数唯一的判断**（二者渲染形态不同：不出段 vs 一行警示）。 */
export function checkpointsOf(task) {
  try {
    const cp = task?.checkpoints;
    if (cp == null) return null;
    return { items: Array.isArray(cp?.items) ? cp.items : [] };
  } catch {
    return null; // 读值异常 ⇒ 按未声明降级（fail-safe：本字段只用于提示，绝不能阻断派发）
  }
}

/** 单项四段**全空**时的**恰一行**建议性警示（判据源 S5-3；E4-K5 明令「四段全缺 ⇒ 恰一行、不许每段一行占位」）。
 *  ⚠ 与 `PREFLIGHT_UNDECLARED_LINE` 不是同一件事：那条是**任务级** `preflight` 未声明（`>` 引用块形态）；
 *  本条是**逐项** `checkpoints[]` 的四段全空（缩进列表项形态，与 item 行同层）。措辞保留「建议性 / 不阻断」。 */
const CP_AUX_ABSENT_LINE = '  - ⚠ 本 checkpoint 未声明 skills / kb / mcp / checklist 四段（建议性：开工前自行判断；不阻断）';

/** 单项四段的**缩进子行**（纯函数、零 IO）：**有才出**（控体积 —— item 数 × 4 行的常驻噪声不可接受）。
 *  词序照判据源 S5-3 样例：skills → kb → mcp → checklist；词汇全部走共享单点（`skillItemTextOf` 等）。
 *  @param {object} it 归一后的 `CheckpointItem`（四键可能**不在**：全空即未声明）
 *  @returns {string[]} 0..4 行（0 行 ⇒ 调用方补 `CP_AUX_ABSENT_LINE`） */
function checkpointAuxLinesOf(it) {
  const strs = (v) => listOf(v).filter((x) => typeof x === 'string' && x.trim() !== '');
  const skills = strs(it?.skills);
  const kb = strs(it?.kb);
  const mcp = listOf(it?.mcp).filter((m) => m && typeof m === 'object'
    && typeof m.tool === 'string' && m.tool.trim() !== '');
  const checklist = strs(it?.checklist);
  const L = [];
  if (skills.length) L.push('  - skills：' + skills.map(skillItemTextOf).join(' / '));
  if (kb.length) L.push('  - kb：' + kb.map(kbItemTextOf).join(' / '));
  if (mcp.length) L.push('  - mcp：' + mcp.map(mcpItemTextOf).join('；'));
  if (checklist.length) L.push('  - checklist：' + checklist.map((c) => c.trim()).join(' / '));
  return L;
}

/** 单点渲染：`null` ⇒ 空串（不出段）；`items` 空 ⇒ 恰一行警示；否则清单 + **一行**建议行。
 *  【e4-ckpt-aux】每条 item 正文行之后追加四段缩进子行（**有才出**，至多 4 行；全空 ⇒ 恰 1 行
 *  `CP_AUX_ABSENT_LINE`）。三态口径（E4-K5/K6）：
 *   ① 未声明 `checkpoints` ⇒ `''`（存量批零感知）；② 声明了但该项四段全空 ⇒ 1 行建议性警示；
 *   ③ 任一段非空 ⇒ 只出对应子行、**无**警示。既有正文行字节**不变**。 */
export function renderCheckpointsBlock(checkpoints) {
  if (checkpoints == null) return '';
  const items = Array.isArray(checkpoints?.items) ? checkpoints.items : [];
  if (items.length === 0) {
    return '## checkpoint 计划\n'
      + '> ⚠ 本任务声明了 `checkpoints`，但归一化后为空（缺 `id` / `id` 重复 / `target` 为绝对路径的项会被丢弃）'
      + ' ⇒ 本 lane 无 checkpoint 计划；如需留痕请自行调用 `lane_checkpoint`。';
  }
  const lines = ['## checkpoint 计划'];
  // 「建议」措辞 + **`total` 由成员自己填**：引擎**不比对**本行的 N（`lane-tools.js` 的校验块逐字不动）。
  lines.push('本 lane 共 ' + items.length + ' 个 checkpoint；建议 `lane_checkpoint(progress:{step,total:' + items.length + '})`'
    + '（`total` 由你自己填，引擎不与本行的 ' + items.length + ' 比对）。');
  for (const it of items) {
    const target = typeof it?.target === 'string' && it.target ? it.target : '（未声明目标）';
    const rounds = Number.isInteger(it?.rounds) && it.rounds >= 1 ? it.rounds : 1;
    const extra = [];
    if (Array.isArray(it?.outputs) && it.outputs.length > 0) extra.push('产出=' + it.outputs.join(' / '));
    if (typeof it?.acceptance === 'string' && it.acceptance) extra.push('验收=' + it.acceptance);
    if (it?.ctxBudget != null) extra.push('ctxBudget=' + it.ctxBudget);
    if (rounds > 1) extra.push('rounds=' + rounds);
    lines.push('- `' + (typeof it?.id === 'string' ? it.id : '?') + '` → ' + target
      + (extra.length > 0 ? '（' + extra.join('；') + '）' : ''));
    // 【e4-ckpt-aux · E4-K4/K5/K8】四段子行：**有才出**；四段全空 ⇒ 恰一行建议性警示（不阻断）。
    const aux = checkpointAuxLinesOf(it);
    if (aux.length > 0) lines.push(...aux);
    else lines.push(CP_AUX_ABSENT_LINE);
  }
  return lines.join('\n');
}

export function renderPreflightBlock(preflight, { injectBudget = null } = {}) {
  let text;
  try {
    text = renderPreflightLines(
      (preflight && typeof preflight === 'object' && !Array.isArray(preflight)) ? preflight : null,
    ).join('\n');
  } catch {
    text = [PREFLIGHT_SECTION_TITLE, PREFLIGHT_UNDECLARED_LINE].join('\n');
  }
  try {
    const budgeted = applyInjectionBudget(text, { surface: 'taskpack.preflight', thresholds: injectBudget, kind: 'perBlock' });
    return typeof budgeted?.text === 'string' ? budgeted.text : text;
  } catch {
    return text;
  }
}

/** 任务级三段渲染**单点**（D-0 / R-1）——**role 独占**：职责（含 mission）/ 授权 / 交付要求
 *  （形态 `form` + `must_contain` + 规格指向 `skills` + `acceptance_hints`）。
 *
 *  **边界约定（防行为漂移，逐字受判据源 `## 方案` 3 约束）**：
 *   · 返回**不含前导空行**、**不含尾随空行**的三段块文本（以 `\n` 连接）；
 *   · 首行**恰为** `ROLE_SECTION_TITLES.responsibilities`；末行 = 最后一条交付件/达标提示行；
 *   · 前导空行归**调用方**（`appendRoleSections` 的 `L.push('')`）、尾随空行归 `composeWorkerPrompt`
 *     —— **二者都不得**被吸进本单点（吸进来即改变 C-1 产出的字节）。
 *
 *  **纯函数、零 IO**：只吃**已解析**的 role 对象。**禁**把 `resolveRoleRef` 搬进来、**禁**接受 role id 字符串
 *  —— 解析单点（`resolveRoleRef`）与渲染单点（本函数）**两个单点、不许合并**（N-1）。
 *  三段标题**只**经 `ROLE_SECTION_TITLES` 产出（R-5：禁在别处再写字面量）。
 * @param {object} roleData 已解析的 role 数据对象
 * @returns {string} 三段块文本
 */
export function renderRoleGuide(roleData) {
  const L = [];
  L.push(ROLE_SECTION_TITLES.responsibilities);
  const mission = typeof roleData?.mission === 'string' ? roleData.mission.trim() : '';
  if (mission) L.push('- **使命**：' + mission);
  for (const r of listOf(roleData?.responsibilities)) L.push('- ' + r);
  L.push('');
  L.push(ROLE_SECTION_TITLES.authorities);
  const authorities = listOf(roleData?.authorities);
  if (authorities.length) for (const a of authorities) L.push('- ' + a);
  else L.push('- （role 未声明）');
  L.push('');
  L.push(ROLE_SECTION_TITLES.deliverables);
  const deliverables = listOf(roleData?.deliverables);
  for (const d of deliverables) {
    // 【本批 R-2/R-3】只读**形态**（`form`）：`path` 键**不读、不回落** ⇒ 段内「零路径」由**代码保证**，
    //   不依赖语料侧自觉（语料漏改也不会把路径渲进任务包）。
    //   形态**不加反引号**：反引号在本渲染色里表示「可照抄的字面量」，形态是自然语言，加引号会误导。
    //   缺形态 ⇒ 显式占位**非空串**（省成空串会渲染出空反引号对，破 R-2b 的零空反引号护栏）。
    const form = (typeof d === 'string') ? d.trim() : String(d?.form ?? '').trim();
    const must = (d && typeof d === 'object' && Array.isArray(d.must_contain)) ? d.must_contain : [];
    L.push('- 交付件：' + (form || '（形态未声明）'));
    if (must.length) L.push('  - 必含结构：' + must.map((x) => '`' + x + '`').join(' / '));
  }
  // 【本批 R-4】role 的 `skills:` 字段**成为注入源**（通道 B · 规格指向）：保序、原样、不筛选、不去重。
  //   与 `lib/wave-plan.ts` 的 `[skills=…]` 前缀通道（通道 A · 装配声明）**无优先级关系** —— B **不回填** A
  //   （不写 `t.skills`、不进 `cmd`、不入任务 sig）；两通道**并存渲染、零仲裁器**。
  //   `skills` **不进** `ROLE_MANDATORY_FIELDS`：未声明 ⇒ 本段**少一行**（可见、不静默），不拒派、不回落。
  const skills = listOf(roleData?.skills);
  if (skills.length) L.push('- 规格：见技能 ' + skills.map((s) => '`' + s + '`').join(' / '));
  const hints = listOf(roleData?.acceptance_hints);
  if (!deliverables.length && !skills.length && !hints.length) L.push('- （role 未声明）');
  for (const h of hints) L.push('- 达标提示：' + h);
  return L.join('\n');
}

/** `composeWorkerPrompt` 侧的三段**适配器**（薄壳，零逻辑）：前导空行由本层给，三段块本体来自单点。
 *  等价式（判据源 `## 方案` 3 写死）：`appendRoleSections(L, roleData)` ≡ `L.push('')`
 *  ＋ `L.push(...renderRoleGuide(roleData).split('\n'))`。**禁**在此再写任何三段模板/标题字面量。 */
function appendRoleSections(L, roleData) {
  L.push('');
  L.push(...renderRoleGuide(roleData).split('\n'));
}

/** 头行「角色」格：`<裸 role 名>（<title>）` —— **保留裸名**（既有读端断言 `` `coder` `` 不破）＋ 补标题。 */
function roleCellOf(roleRef, roleData) {
  const bare = (typeof roleRef === 'string' && roleRef.trim())
    ? roleRef.trim()
    : String(roleData?.id ?? roleData?.title ?? '-');
  return roleData?.title ? '`' + bare + '`（' + roleData.title + '）' : '`' + bare + '`';
}

/**
 * 【C-5 · ④】`member.dispatch` 载荷的**预算留痕键**（**单一判定点**，供载荷与单测共用）。
 *
 * 语义（冻结口径 C-5「非空才写键」）：仅当 `injectBudget.enabled === false` 时返回
 * `{ budgetEnabled: false }`；其余一切形态（含 `enabled === true` = 注册表默认、缺省 `null`）
 * 返回 `{}` ⇒ 载荷键集与键序**逐字零变化**（存量读端/断言不受影响）。
 *
 * 存在理由：`enabled === false` 时 `composeWorkerPrompt` 内 `budgeted` 为假 ⇒ perItem 层整条跳过，
 * 此前**无任何留痕**，事后无法分辨「预算没生效」是「入参未超限」还是「被配置关掉」。
 * @param {object|null|undefined} injectBudget 热更快照读出的 `capabilities.injectBudget`
 * @returns {{budgetEnabled?: false}} 追加键（空对象 = 不追加）
 */
export function memberDispatchBudgetKeyOf(injectBudget) {
  return injectBudget?.enabled === false ? { budgetEnabled: false } : {};
}

/**
 * 成员任务包**骨架**（B1）：引擎侧给出「角色 / 目标 / 契约 / 产物 / 纪律」，Leader 的 `prompt` 作为任务要点追加。
 * 契约要点（与 discipline §0e 一致）：只给要素、不写实现；写盘走 edit/write；产物落批次产物根。
 */
export function composeWorkerPrompt({
  batchId, lane, cmd, layer, role, consume = [], produce = [], outputs = [], firstLine, leaderPrompt = '', artifactsRoot,
  // 【批 `d-override-fix-20261011` · lane `e4-session-bind`】**双保险**（本 lane 任务包必做项 ④）：
  //   批归属会话 id（缺省 `undefined` ⇒ **任务包逐字节不变**，零回归）。非空时任务包明写
  //   「批归属会话 + 治理工具须传 session」——覆盖 `dispatchIndex` 的**重启重建窗口**：
  //   内存索引未就绪（进程刚起、`rebuildDispatchIndex()` 尚未跑完、或事件流写失败）时，
  //   `sessionOf` 的注入 resolver **不命中**，此时唯一起作用的路径 = worker **显式传参**。
  //   取值来源 = `dispatchLaneCore` 的落点会话参数（= 批文件所在会话 = `member.dispatch.sessionId`）。
  batchSessionId,
  // 【2026-09-27 · GR-13】「单件写盘 lane」显式声明位（缺省 `false` ⇒ 既有任务包逐字不变）。
  //   直调调用方可显式置 `true`；派发路径的**自动判定**见函数内 `singleArtifactWriteLane`。
  singleArtifactWrite = false,
  // 【2026-10-07 · P2】role 语料定位位（缺省 = 包根 `skills/`）；直调与隔离测试可显式指定。
  roleRoot, roleTeam,
  // 【pk-impl · 批 `punky-taskpkg-checkpoint-20261101`】checkpoint 计划清单（`tasks[].checkpoints` 的归一产物）。
  //   缺省 `null` ⇒ **不渲染任何内容、不加警示**（存量批海量，给缺省加警示会污染全部派发）；
  //   仅当「声明了但归一后为空」才给**恰一行**降级警示（见 `renderCheckpointsBlock`）。
  //   【e4-ckpt-aux】每项的四段（`skills`/`kb`/`mcp`/`checklist`）由同一函数渲染成**缩进子行** ⇒
  //   经下方 `L.push(...checkpointsBlock.split('\n'))` **进 prompt 正文**（用户硬要求：成员真能读到，
  //   不是只写在字段里）。四段**不加注入预算**（E4-K10：本批不登记 checkpoint 段的新预算面 ⇒
  //   `renderCheckpointsBlock` 内不得出现任何 `applyInjectionBudget` 调用）。
  checkpoints = null,
  // 【ckpt-wire · 批 `punky-checkpoint-wire-20261106` · lane `e1-resume`】A 通道：`resume` 契约条款开关
  //   （取值面 = `WavePlanTask.resume`，建批恒写、缺省 `false`；见 `types/contracts.ts:142`、
  //   `wave-plan.ts:1386`）。缺省 `false` ⇒ **不 push 任何行** ⇒ 任务包与改动前**逐字节相同**
  //   （零回归，与 `injectBudget` / `archContext` 同款「可选位缺省 ⇒ 零字节变化」惯例）。
  resume = false,
  // 【L2 注入预算】面 A 的阈值入参（缺省 `null` ⇒ **零动作**：不改任何文本、不产省略）。
  //   生产路径由 `dispatchLaneCore` 从热更快照 `capabilities.injectBudget` 读出后传入；
  //   直调调用方（含既有单测）不传 ⇒ 本函数输出与改动前**逐字节相同**（零回归口径 C）。
  //   本函数保持**纯**：只返回预算后的文本，**不发射事件、不写盘**（唯一发射点在 `swarm_report`）。
  injectBudget = null,
  // 【P2 · arch-context】架构约束段（调用方已裁剪好的文本，来自 `.punky/arch.yml`）。
  //   缺省 `null` ⇒ **不 push 任何行** ⇒ 任务包与改动前**逐字节相同**（零回归口径，与 `injectBudget` 同款）。
  archContext = null,
  // 【批 `punky-guidance-preflight-20261025` · lane `c1-preflight`】P0-1「开工前必做」四段声明的**取值位**
  //   （调用方传 `WavePlanTask.preflight`）。缺省 `null` ⇒ **走警示行**（不是「零变化」：用户裁的「不静默」
  //   是硬要求，本批唯一被接受的任务包字节变化）。
  preflight = null,
  // 【同批】降级告警落点（缺省 `null` ⇒ 零输出；`dispatchLaneCore` 传 `ctx.logger`）。
  //   只用于「段渲染异常 ⇒ 降级为警示行」这一条路径的一次 warn —— 本函数其余部分保持纯。
  logger = null,
}) {
  // role 解析（**单点真源**）：对象直用 / id 串查语料库（查不到 ⇒ 抛 `GATE_ROLE_UNRESOLVED`）/ 未声明 ⇒ null。
  const roleData = resolveRoleRef(role, { root: roleRoot ?? roleCorpusRoot(), team: roleTeam });
  // 面 A · 层①单条目：目标行 `cmd`（`taskpack.cmd`）与 Leader 补充（`taskpack.leaderPrompt`）各按单条目层收窄。
  //   未超限 ⇒ 原值、零省略（零回归）。role 三段与 consume/produce/outputs 清单**不设上限**（声明面天然有界）。
  const budgeted = injectBudget?.enabled === true;
  const cmdBudget = budgeted
    ? applyInjectionBudget(String(cmd ?? '（未声明 cmd）'), { surface: 'taskpack.cmd', thresholds: injectBudget, kind: 'perItem' }).text
    : cmd;
  const leaderPromptBudget = budgeted
    ? applyInjectionBudget(leaderPrompt, { surface: 'taskpack.leaderPrompt', thresholds: injectBudget, kind: 'perItem' }).text
    : leaderPrompt;
  // 【P2 · arch-context】架构约束段**同受单条目预算**（与 `cmd` / `leaderPrompt` 同构：
  //   面名 `taskpack.archContext`、层① `perItem`；未超限 ⇒ 原值本身、零省略）。
  //   面名口径据 `inject-budget.js`「本模块不校验集合，校验归调用方/测试」⇒ 新增面名无需登记表；
  //   超限时省略标记形如 `…[omitted <N>B @ taskpack.archContext]`，消费方当场可辨。
  const archContextBudget = budgeted && typeof archContext === 'string' && archContext.length > 0
    ? applyInjectionBudget(archContext, { surface: 'taskpack.archContext', thresholds: injectBudget, kind: 'perItem' }).text
    : archContext;
  const L = [];
  L.push(firstLine); // 首行：句柄标记（唯一凭证；引擎只读 exec.arguments，不注入参数）
  L.push('');
  L.push('# 任务包（引擎自派 · ' + labelOf(batchId, lane) + '）');
  L.push('- **lane**：`' + lane + '`｜**层**：`' + (layer ?? '-') + '`｜**角色**：' + roleCellOf(role, roleData));
  L.push('- **目标**：' + String(cmdBudget ?? '（未声明 cmd）'));
  if (consume.length) L.push('- **消费件**：' + consume.map((p) => '`' + p + '`').join('、'));
  if (produce.length) L.push('- **产出面**：' + produce.map((p) => '`' + p + '`').join('、'));
  if (outputs.length) L.push('- **产物**：' + outputs.map((p) => '`' + p + '`').join('、'));
  if (artifactsRoot) L.push('- **批次产物根**：`' + artifactsRoot + '`（产物落此处，勿落工作区根）');
  // 【批 `d-override-fix-20261011` · lane `e4-session-bind`】**双保险**（必做项 ④ / AC-6）：
  //   明写**批归属会话 id** 与「治理工具须传 `session:"<批归属会话>"`」。
  //   ① 主路 = 引擎侧注入的归属解析（`sessionOf` 第三参数）——**本条不依赖它**；
  //   ② 本条 = **重启重建窗口的兜底**：`dispatchIndex` 由批次事件重建（`lib/index.js:535-553`），
  //      进程刚起 / 重建未跑完 / 事件流写失败时索引为空 ⇒ resolver 不命中 ⇒ 若不显式传参，
  //      worker 的 `sessionOf` 会回落到**自己的子会话**，`store.readBatch` 即抛
  //      `batch not found: <batchId> @<workerSessionId>`（本批 e2-guidance 实测形态）。
  //   位置 = 任务包**头部信息区**（`## 纪律` 之前的 lane 契约块内），保证 worker 先读到再动手；
  //   文案给**可照抄形态**（含 id 与键名），不给解释性长句（纪律面另有条目）。
  if (typeof batchSessionId === 'string' && batchSessionId.length > 0) {
    L.push('- **批归属会话**：`' + batchSessionId + '`——**调用治理工具（`lane_checkpoint` / `handoff_submit` / `mailbox_*` / '
      + '`member_settle` / `asset_claim` / `log_export` 等）时必须显式传 `session:"' + batchSessionId + '"`**；'
      + '省略时引擎按 worker 绑定自动归属（重启重建窗口内可能解析不到 ⇒ 显式传参是唯一可靠路径）。');
  }
  // 【2026-10-07 · P2】role 三段（**结构隔离**，计划 §2.4）：本段由 role 数据独占，Leader 的 `leaderPrompt`
  //   只落在末尾的 `## 任务要点（Leader 补充）` ⇒ **结构上不存在覆盖关系**（无「谁优先」判定器）。
  if (roleData) appendRoleSections(L, roleData);
  // 【P2 · arch-context】架构约束段：位置 = **role 三段之后、`## 纪律` 之前**
  //   （结构隔离：既不挤占 role 独占段，也不挤占末尾的 Leader 补充段）。
  //   缺省 `null` ⇒ 不 push ⇒ 既有任务包逐字节不变（零回归）。
  if (typeof archContextBudget === 'string' && archContextBudget.length > 0) {
    L.push('');
    L.push(archContextBudget);
  }
  // ── 【P0-1】`## 开工前必做` 段：位置 = **archContext 段之后、`## 纪律` 之前** ──────────────────
  //   位置理由：开工动作清单紧贴纪律段 = 成员「动手前最后读到的内容」（同时满足「角色/目标之后、纪律之前」）。
  //   本段自带前导空行（与 archContext 段同款）。既有段落相对顺序**零改动**。
  //   fail-safe：`renderPreflightBlock` 内部已包 try/catch（永不抛）；此处再兜一层 —— 万一将来有人改坏它，
  //   代价也必须是「降级为警示行」而不是「lane failed」（见该函数注释的代价说明）。
  let preflightBlock;
  try {
    preflightBlock = renderPreflightBlock(preflight, { injectBudget });
  } catch (e) {
    try {
      logger?.warn?.('[dsh-punky-swarm] composeWorkerPrompt: 开工前必做段渲染失败 ⇒ 降级为警示行（不阻断派发）：'
        + String(e?.message ?? e));
    } catch { /* 告警本身失败也不得外溢 */ }
    preflightBlock = renderPreflightBlock(null, { injectBudget });
  }
  // ── 【pk-impl】`checkpoint 计划` 段：位置 = **`## 开工前必做` 之前**（设计要求）────────────────
  //   fail-safe（双 try/catch，照 `renderPreflightBlock` 的代价说明）：**渲染抛错绝不阻断派发** ——
  //   代价必须是「跳过该段」而不是「lane failed」。直派与 team 两路都经 `composeWorkerPrompt` ⇒ 同点覆盖。
  let checkpointsBlock = '';
  try {
    checkpointsBlock = renderCheckpointsBlock(checkpoints);
  } catch (e) {
    try {
      logger?.warn?.('[dsh-punky-swarm] composeWorkerPrompt: checkpoint 计划段渲染失败 ⇒ 跳过该段（不阻断派发）：'
        + String(e?.message ?? e));
    } catch { /* 告警本身失败也不得外溢 */ }
    checkpointsBlock = '';
  }
  if (checkpointsBlock) {
    L.push('');
    L.push(...String(checkpointsBlock).split('\n'));
  }
  // ── 【ckpt-wire · A 通道】`RESUME_CLAUSE` 条款段 ─────────────────────────────────────────────
  //   位置 = **`## checkpoint 计划` 段之后、`## 开工前必做` 段之前**（批 `punky-checkpoint-wire-20261106`
  //   · lane `e1-resume`；判据源 `plan/ckpt-spec.md` §方案 3.1(c)）。三条否证：
  //   ① **不做成 `## 纪律` 的第 N 条**：纪律段用 `rule()` 计数器编号（见下方 `ruleNo`）⇒ 条件条款会让
  //      同一批不同 lane 的规则序号漂移，且直接污染 E-CK6 零回归面；
  //   ② **不落 `## 任务要点（Leader 补充）`**：该段是 Leader 独占区（结构隔离，无优先级判定器）；
  //   ③ **不落头部契约区**：本条款是**开工/续跑时**的指令，语义上后置，紧贴纪律段（成员动手前最后读到），
  //      且与同族的 `## checkpoint 计划` 相邻（A/B 两通道条款并读）。
  //   空行口径（对齐 `:880` / `:912` / `:915` / `:961` 四处同款惯例）：块**前** `L.push('')` **恰一个**；
  //   块**后不给** —— 紧随的 preflight 段自带前导空行，再给即产出**连续两个空行**（破坏逐字节形态）。
  //   裸段（不新造 `## 标题`）：`RESUME_CLAUSE` 本身是完整条款句且不含 `\n` ⇒ 恒为**一行**；
  //   加标题需在本文件新造标题字面量 ⇒ 第二个文案面（与 archContext 裸文本段惯例一致）。
  //   缺省 `resume = false` ⇒ `resumeClauseFor` 返回 `null` ⇒ **零 push**（E-CK6 逐字节零回归）。
  const resumeClause = resumeClauseFor({ resume });
  if (resumeClause) {
    L.push('');
    L.push(resumeClause);
  }
  L.push('');
  L.push(...String(preflightBlock).split('\n'));
  L.push('');
  L.push('## 纪律');
  // 【2026-09-27 · 规则编号动态化】原为**字面 1..6**（第 6 条按层裁剪）⇒ 新增规则会撞号。
  //   改为**计数器**逐条编号：规则文本逐字不变，仅编号由 `rule()` 递增产出（缺规则也不会跳号）。
  let ruleNo = 0;
  const rule = (text) => { ruleNo += 1; L.push(ruleNo + '. ' + text); };
  rule('写盘只用 `edit`/`write`；临时件用 `node -e` 的 `fs`；UTF-8 无 BOM、LF。');
  rule('禁 `git` 写；禁重启宿主；只碰本 lane 文件域。');
  rule('断言「没有某工具/技能」前先实机核：`grep`/`glob` 扫宿主安装面与引擎源码，或按名直调看回执（折叠 ≠ 禁用），勿凭印象断言「没有」。');
  rule('完成/失败均**显式回报**（不给静默降级）；回报只给元数据与结论，不复制正文。');
  // ── 【2026-09-27 引导缺口补强】收本会话 5 次 `auto.settle.paused` 的教训 ──────────────
  //   实证：批 onto-engine-slim-20260926 中 4 次停轮源于「exec 线漏向聚合 audit lane 交接」
  //   （`GATE_HANDOFF_MISSING`）、1 次源于「plan 产物缺裸标题 `## 约束`」（`GATE_PLAN_CONTRACT`）。
  //   **根因不是成员失职，而是任务包没写清** —— 故在此把两条硬要求前置到骨架里。
  rule('**【交接】完成时必须 `handoff_submit` 向【本 lane 的全部出边】交接**（含**聚合 audit lane**）——');
  L.push('   若本批含 audit 层而本 lane 是 plan/exec 层，则该边**必须交**；漏交会被 `GATE_HANDOFF_MISSING` 拒，');
  L.push('   批会被停轮。对 `a1-*` 这类**聚合 audit lane**（有多个入边），**每条上游线都要各自交一次**。');
  if (layer === 'plan') {
    rule('**【plan 产物】正文必须含六个【裸标题】**（行首恰为该串，非 `###`、无缩进/前缀）：');
    L.push('   `## 概述` / `## 问题` / `## 方案` / `## 需求` / `## 验收标准` / `## 约束`；');
    L.push('   **内容允许为空，标题一个都不能缺** —— 缺任一即被 `GATE_PLAN_CONTRACT` 拒（内容不校，只校标题）。');
  }
  // ── 【2026-09-27 · GR-12】回报编号口径消歧（收「exec 验收项被写成 spec 自检项编号」的停轮教训）──
  //   背景：任务包曾把「exec 报告的验收项」称作自检项的编号；而判据源 `## 验收标准` 章内的自检项编号
  //   与 **exec 验收项**（落在判据源的**验收项专章**，章号与编号族随规格自定，如 `§6` + `L-AC-1..N`，或 `V-1..V-28`）是**两套编号** ⇒ worker 按错位编号回报。
  rule('**【回报编号口径】**本 lane 的**验收项**编号以**判据源中承载 exec 验收项的那一章**为准（**章号与编号形态随判据源自定**：如 `§6` + `L-AC-1..N`，或 `V-1..V-28`）；');
  L.push('   判据源 `## 验收标准` 章内的自检项编号属于**规格自检**，**不是**本 lane 的验收项。');
  L.push('   回报引用验收项时：**照抄该章的编号 + 原文**（禁自行重排、禁把自检项编号当作验收项回填）。');
  // ── 【2026-09-27 · GR-13】「单件写盘 lane」与纪律 progress 快照的冲突处置 ──
  //   背景：audit 聚合 lane 的硬约束「只写一件」（判据源明列）与「每完成一子步骤即落 progress 快照」
  //   直接冲突，worker 只能靠自行判断 ⇒ 引擎侧按 lane 的**写盘约束**自动抑制 progress 行。
  //   判定（保守、可机检）：① 显式 `singleArtifactWrite === true`；**或** ② **audit 层**且声明写盘面
  //   （`produce ∪ outputs` 去重）**恰一件**。exec / plan 层**不自动判**（progress 是其工作流组成部分）
  //   ⇒ 只走显式声明位。
  const writeTargets = [...new Set([...produce, ...outputs].filter((p) => typeof p === 'string' && p.trim().length > 0))];
  const singleArtifactWriteLane = singleArtifactWrite === true || (layer === 'audit' && writeTargets.length === 1);
  if (singleArtifactWriteLane) {
    rule('**【progress 快照 · 本 lane = 单件写盘 lane】**写盘约束 = **只写声明的这一件产物**；');
    L.push('   ⇒ 本任务包**自动抑制**「每完成一子步骤即落 progress 快照」一行（该纪律与本 lane 的**单件写盘约束直接冲突**，'
      + '两条打架时**以更严者为准** = 单件约束）；');
    L.push('   子步骤记录写进**该件产物正文**或**汇报**里，**不得**另开进度快照文件（多写一件即越界）。');
  } else {
    rule('**【progress 快照】**每完成一个子步骤即落 `<lane>/progress/NN-<slug>.md`（禁攒批；崩溃后新 worker 据此跳过已完成步骤）。');
  }
  if (leaderPromptBudget) {
    L.push('');
    L.push('## 任务要点（Leader 补充）');
    L.push(leaderPromptBudget);
  }
  const composed = L.join('\n');
  // 面 A · 层②总量：整个任务包（`taskpack.total`）在 join 之后、返回之前施加总量硬上限。
  //   固定顺序 = 单条目（`cmd` / `leaderPrompt`，上方）→ 总量（本处）。未超限 ⇒ **原值本身**返回（零回归）。
  if (!budgeted) return composed;
  return applyInjectionBudget(composed, { surface: 'taskpack.total', thresholds: injectBudget, kind: 'total' }).text;
}

/** 组装 `rt.start(provider, request)` 的 **one-shot 请求载荷**（纯函数，便于单测）。
 *  【2026-09-22 · one-shot 化】原 `buildStartSpec`（continuable 嵌套形态 `{provider,label,signal,request:{…}}`）
 *  改为**平铺 one-shot 请求**（`SubagentStartRequest`：`{label,prompt,parent,signal,toolFilter,persona?,maxDepth}`）；
 *  `provider` 改由调用方直传 `rt.start(provider, request)`（原 `spec.provider` 字段随形态删除）。
 *  ⚠ 活体实测（2026-09-16，批次 `suite-live-20260916` 首派第二层报错抓出）：宿主 `signal` 是**运行时必需字段**
 *  （缺它即抛 `Cannot read properties of undefined (reading 'throwIfAborted')`，由本模块 `mapSpawnError`
 *  归一为 `GATE_DISPATCH_FAILED`）——本字段纪律延续。
 *  ⚠ **signal 纪律（one-shot 化新增，禁透传 `exec.signal`）**：缺省给**自持永不中止**的 signal（worker 不随
 *  Leader 回合取消而中断；官方 background 分支实证 `exec.signal` 会随工具调用结束 abort，见头部「signal 纪律」）；
 *  调用方可注入自有 signal 以显式支持取消。
 *  `label`（B3）由宿主快照进子会话 descriptor（`dsh-subagent/lib/index.js:3155-3159`）⇒ 重启后仍可核。 */
export function buildStartRequest({
  batchId, lane, parent, prompt, denyTools = SUITE_DENY_TOOLS, extraDeny = [], persona, role, roleRoot, roleTeam,
  maxDepth = 1, signal,
}) {
  // 【2026-10-07 · P2】role 派生面（**单点真源**：与 `composeWorkerPrompt` 同一解析函数 `resolveRoleRef`）：
  //   ② 人格级 `persona`（R-4）：调用方**显式给值优先**（缺省派生位），否则由 role 的
  //      `title` + `mission` + 工作方式（正文 Persona 段）派生 —— 同 role 跨批稳定；
  //   ③ 权限级 `toolFilter.deny`（R-5）：冻结集 `SUITE_DENY_TOOLS` ∪ **allow 反推集** ∪ 追加集，
  //      **去重后保序**（冻结集逐项不缩水）。
  const roleData = resolveRoleRef(role, { root: roleRoot ?? roleCorpusRoot(), team: roleTeam });
  const effectivePersona = persona !== undefined ? persona : personaOfRole(roleData);
  const derivedDeny = deriveDenyTools(roleData?.tools?.allow, { root: roleRoot ?? roleCorpusRoot() });
  return {
    label: labelOf(batchId, lane),
    signal: signal ?? new AbortController().signal,
    parent,
    prompt: [{ type: 'text', text: prompt }],
    toolFilter: { deny: [...new Set([...denyTools, ...derivedDeny, ...extraDeny])] },
    ...(effectivePersona !== undefined ? { persona: effectivePersona } : {}),
    maxDepth,
  };
}

/**
 * spawn 失败的**显式映射**（B4 能力位前置 + B6 失败显式）：
 * 宿主在 provider 缺 `toolFilter`/`depthLimit` 能力时会自行拒绝（`dsh-tool-subagent/lib/index.js:370/377`），
 * 本函数把其文案归一到我们的码面，便于调用方与审计识别。
 * @returns {{code: string, message: string}}
 */
export function mapSpawnError(err) {
  const raw = String(err?.message ?? err ?? '');
  if (/capabilit|toolFilter|depthLimit/i.test(raw)) {
    return { code: 'GATE_DISPATCH_CAPABILITY_UNAVAILABLE', message: 'provider 能力位不足（toolFilter/depthLimit）⇒ 拒派，不以弱换强：' + raw };
  }
  if (/provider|unknown provider|not resolvable/i.test(raw)) {
    return { code: 'GATE_DISPATCH_PROVIDER_INVALID', message: 'provider 不可解析（检查 config.dispatch.provider）：' + raw };
  }
  return { code: 'GATE_DISPATCH_FAILED', message: '引擎自派失败：' + raw };
}

/** `rt.start` 返回的 `SubagentRun` → worker 会话 id（one-shot 化语义）。
 *  **主字段 = `id`**（`SubagentRun.id` = 子会话 id，`dsh-subagent-in-process-driver` :166/:219 实证；
 *  与宿主 `subagent/end` 事件的 `info.id` 同源 —— V-3 已核，S3 观察桥据此对齐）。
 *  兼容回落 `childId`/`subagentId`（continuable 时代契约字段，防御宿主形态漂移）：回落命中**显式告警**。
 *  旧写法 `start.id ?? start.subagentId ?? start.childId` 是**猜字段且不告警**：宿主形态一变即静默 null。
 *  取不到时**不静默**：返回 null，由调用方带**原始载荷**报错。
 *  ⚠ 勿与 `runId`（宿主观察 id，`observeRun` 的 `SubagentRunId(randomUUID())`）混淆 —— 登记面只用**会话 id**。 */
export function workerSessionIdOf(start, warn) {
  if (!start || typeof start !== 'object') return null;
  if (typeof start.id === 'string' && start.id) return start.id;
  for (const k of ['childId', 'subagentId']) {
    if (typeof start[k] === 'string' && start[k]) {
      warn?.('start 未返回实现面字段 `id` → 回落 `' + k + '`（continuable 时代契约字段，防御性保留；若两者皆缺请查宿主返回形态）');
      return start[k];
    }
  }
  return null;
}

// ── 形态探测**已迁出引擎**（W3-S2 · 批 `punky-adapter-split-20261031` · lane `w3-engine-entry`）──
//
// 原 `subagentRuntimeProbeOf(ctx)` / `subagentRuntimeOf(ctx)` 在本文件内做宿主形态自判
// （`typeof rt.startActivation` / `typeof rt.start`）并给引擎一个可调用句柄 —— 属 **J6-e 禁止面**
// （引擎不得因「宿主长什么样」改路径）与 **AC-5″ 禁止面**（引擎不得消费宿主形态值）。
//
// 现拆成两半，各归其位：
//   · **成因判定** → 搬进修 provider（`lib/provider-dsh/agent.js` 的 `reason` 读数，功能面三态）；
//   · **入口选择** → provider 内部（同文件的 `formOf` 单点 + `spawn` 内部分派）。
// ⇒ 引擎侧保留的只有**功能面读数**（`agentPort.available` / `agentPort.reason` / `agentPort.canNarrow`），
//   据此「因功能拿不到」而拒/降级 —— 这正是 J6-e 的**允许面**（`canNarrow` 拒派见下方 ⓿）。
//
// ⚠ 删除范围实测：`subagentRuntimeProbeOf` / `subagentRuntimeOf` 在 `lib/**` 内**零剩余消费者**；
//   `test/engine-dispatch.test.js` 的 P5 用例随本删除同批移除（属同一次搬迁的测试面，见产物 §三删）。

/** 降级文案**三档单点**（`available===false` 时）：每档互不相同、各含自身成因关键词。
 *  入参 = provider 的**功能面** `reason`（不是宿主形态值）。
 *  ⚠ **禁反向归因**：本机真实态是「服务在、入口形态不匹配」，把它写成「宿主没给这个服务」
 *  会让后面每一次排障都从错误的一侧开始 —— 这正是 A1-P1-01 的第二个缺陷面。
 *  ⚠ 文案去宿主名属 **W4 `codename`** 的活（本 lane 只搬成因来源，**逐字保留**文案）。 */
function spawnNoteOf(reason) {
  const tail = '⇒ 仅发句柄（请把 firstLine 交给直派形态；该形态门禁属 C 阶段）';
  if (reason === 'runtime-unavailable') {
    return '适配层 agent 功能面不可用（端口 `available=false`，成因 runtime-unavailable：服务未注入，或取值被 provider 侧守卫拒绝）' + tail;
  }
  return '适配层 agent 功能面**在位但不含可用启动入口**（成因 no-start-entry：两个入口皆不可调用；入口选择属 provider 内部）' + tail;
}

// ── 【2026-09-22 · one-shot 化】run 生命周期属主登记 ──────────────────────────────
// `activeRuns` = 本进程在飞的 one-shot worker run 表（key = workerSessionId）。**唯一的 quiescent
//   lifecycle owner 是调用方持有的 run 对象**（driver 文件头明言）⇒ 引擎必须持引用直到 result settle，
//   既防 GC 语义歧义，也为将来「批次中止 ⇒ 取消 worker」留取消入口（`run.dispose()`，本批不接线）。
//   result settle ⇒ 自动摘除；rejection ⇒ **显式告警留痕**（一次性 run 失败不许静默），**不进黑板判定**
//   （结算仍走门禁——"事件由引擎写、结算走门禁"纪律不变）。
const activeRuns = new Map();
/** one-shot run 终态跟踪（非抛出：跟踪失败只告警，绝不影响派发成功路径）。 */
function trackOneShotRun(workerSessionId, run, warn) {
  if (!run || typeof run !== 'object' || !(run.result instanceof Promise)) {
    warn?.('start 返回载荷缺 `result`（Promise）⇒ run 终态不可跟踪（留痕不阻断；若宿主形态变更请按本载荷适配）');
    return;
  }
  activeRuns.set(workerSessionId, run);
  run.result.then(
    () => { activeRuns.delete(workerSessionId); },
    (e) => {
      activeRuns.delete(workerSessionId);
      warn?.('one-shot worker run 失败（留痕不进判定，结算走门禁）：' + String(e?.message ?? e) + ' · worker=' + workerSessionId);
    },
  );
}


// ── 派发核心（**唯一实现**：工具面与链引擎共用，禁第二套） ──────────────────────
// P2（批次 `p2-chain-autodrive-20260916`，lane e-chain）抽出：原实现内联在
//   `lib/tools/core.js` 的 `lane_dispatch.execute`；推进链的自动派发（`lib/engine/chain-runner.js`）
//   必须与工具面**走同一条**派发路径（同 Tier3 entry 门、同句柄、同 worker 任务包骨架、同
//   `member.dispatch` 登记），否则「链自派」与「人工派发」会在门禁/登记面分裂。
//
// 句柄生命周期口径（P0 修复，Leader 裁决 ⑤，2026-09-16）——**自派即发放即作废、仅直派形态需长期有效**：
//   · **成功自派**：`member.dispatch` 登记后会立即 `consumeLaneHandle` ⇒ 句柄从 `pendingHandles` 摘除
//     （形态：引擎已把 worker 拉起来，句柄的「派发凭证」使命已完成；留着只会让绑定缺口探针
//     `bindingGapOf` 把已绑定的 lane 误报成 `token-ttl-expired` 幽灵信号）。
//   · **降级「仅发句柄」两分支**（宿主无 `ctx.subagents` / 未配置 `config.dispatch.provider`）：
//     **不得消费**——此时句柄是 Leader **人工直派形态**的唯一凭证（把 `firstLine` 原样写进子代理
//     任务包首行），消费掉它等于把「直派形态」堵死；该形态的硬门禁属 C 阶段。
//   · **失败路径**：维持既有消费（派发失败已把 lane 置 `failed`（K3 起；此前为 `review`），句柄若留在 pending 会被探针
//     报成悬挂意图）；语义等价「已回收」。
//
// @returns {Promise<{batchId, lane, status, token, firstLine, ttlMs, spawned: boolean,
//                    workerSessionId?: string, spawnNote?: string}>}
//   硬失败（spawn 抛错 / 取不到 worker 会话 id）**抛错**：错误文案自带回滚事实与恢复步骤。
// @param {Map|null} [dispatchIndex] 既有**唯一** worker→批 索引（与读侧同引用）。
//   提供 ⇒ 自派成功后与 `member.dispatch` 事件**同一次逻辑动作**内同步写索引（修复③ 主路）；
//   缺省 / 非 Map ⇒ 整段跳过（**逐字零行为变化**，守 R-2 兼容红线）。取不到索引 ⇒ 退化为既有行为，
//   由兜底路 `batchSessionIdOfWorkerResolved` 在 worker 首个治理调用时补位。
//   ✅ **写点存活（2026-10-22 · A1-P2-04 校正；原「入参面无该参 ⇒ 恒跳过（dormant）」表述作废）**：
//   本参数**在签名内**；唯一调用点 `lib/tools/member-tools.js` 的 `dispatchLaneCore({ ..., dispatchIndex: deps?.dispatchIndex })`
//   **已传**，`lib/index.js` 的 `installTools` deps 面亦**已注入**同一 Map 引用
//   （按符号检索 `dispatchIndex`，勿写死行号 —— 本批另一 lane 正在 `lib/index.js` 并行改动）。
export async function dispatchLaneCore({ ctx, store, root, liveConfig, exec, sessionId, batchId, lane, leaderPrompt = '', exempt, dispatchIndex }) {
  // ⓿ 【2026-10-22 · A1-P1-01；2026-10-31 · e3-agentport 端口面改造】宿主**能力位前置**。
  //   位置**硬要求**：必须早于 ① `store.setMember(...,'running')` 与 ② 句柄发放（与下方 role 前置拒派同族）
  //   ⇒ 效果 = **零状态变更 / 零句柄发放 / 零 `member.dispatch` 事件**（工具调用直接失败，lane 仍 `pending`）。
  //   能力位判定**改问端口**（引擎不再自己 `probe.form`）：`createAgentPort` 内部判形态并**显式声明**
  //   `narrowVia`（工具面/人格经哪条路生效）与 `depthVia`（深度经哪条路生效）。
  //   ⚠ **表述订正（原三处有两处不准，取证见 `lib/provider-dsh/agent.js` 头）**：
  //     · `toolFilter`：`startActivation` 的 `request`（= `Omit<SubagentStartRequest,'label'|'signal'>`）**确无此字段** ⇒ 收窄只能经 `agentPreset`（原表述 ✅ 对）；
  //     · `persona`：宿主**无 `persona` 字段**，人格只能经 `agentPreset` 组 composition（原写「不承载 request.persona」⚠ 表述不准）；
  //     · `maxDepth`：**`request.maxDepth` 原生可用**（`SubagentStartRequest.maxDepth?: number`，受 `capabilities.depthLimit` 约束）⇒ 原「不承载 maxDepth」**是错的**。
  //   ⇒ 因此 activation 形态**不是「什么都做不了」**：**需要 `agentPreset` 承载收窄/人格、`maxDepth` 原生可用**。
  //     仅当**解析不出 `agentPreset`**（无法保证按次收窄）时才拒派（「不以弱换强」不变）。
  //
  // ── 【S-0 · 顺序重构（批 `punky-adapter-split-20261031` · lane `w3-meter`）】──────────────
  //   动机（P0-6 **F-4**）：拒派闸要问**真实 ask**（`{role, toolFace, persona}`），但三份输入原先
  //   全在闸**之后**才产出 ⇒ 闸只能传 `{}`（**F-1**：假读数的第一层）。
  //   ⇒ 把 `laneTask` / `roleData` / `askToolFace` 的解析**整体前移到闸之前**，
  //     但仍**早于**状态变更（`store.setMember(...,'running')`）—— 拒派必须零状态变更这条纪律不变。
  //   ⚠ 与既有 ⓿-b「role 前置解析」是同一纪律的**扩展**：原先只前移 role（为 GATE_ROLE_UNRESOLVED），
  //     现在把 role 的**派生产物**（toolFace）也一并前移，否则闸拿不到工具面。
  let laneTask = null;
  try {
    const wp = store.readBatch(sessionId, batchId)?.wavePlan ?? [];
    const flat = Array.isArray(wp) ? wp.flatMap((w) => w?.tasks ?? []) : (wp.tasks ?? []);
    laneTask = flat.find((t) => t && t.id === lane) ?? null;
  } catch { laneTask = null; }
  const roleData = resolveRoleRef(laneTask?.role, { warn: (m) => ctx?.logger?.warn?.(m) });
  // 本次派发的**真实工具面**（= `buildStartRequest` 后续合成的同一份 deny 集）。
  //   与下游 `buildStartRequest({ denyTools: denyAll, role: roleData })` **同源同算**：
  //   同一 `denyAll` 常量 + 同一 `deriveDenyTools(roleData.tools.allow)` ⇒ 两次调用结果恒等，
  //   不是「两处各判」（那会漂移）。`denyDropped`（宿主未知工具名的自愈）只影响**实际请求**，
  //   故 ask 侧的 deny 是**超集** ⇒ 判定更严 ⇒ fail-closed，方向正确。
  const denyAllForAsk = [...new Set([...SUITE_DENY_TOOLS, ...(liveConfig?.dispatch?.denyTools ?? [])])];
  const askToolFace = {
    deny: [...new Set([...denyAllForAsk, ...deriveDenyTools(roleData?.tools?.allow, { root: roleCorpusRoot() })])],
  };
  // 本次派发要求的**人格**（与 `buildStartRequest` 的 `effectivePersona` 同源）：
  //   显式配置优先，缺省由 role 派生 —— 两者只要有一个非空，就是「本次有收窄需求」。
  const askPersona = liveConfig?.dispatch?.persona !== undefined
    ? liveConfig.dispatch.persona
    : personaOfRole(roleData);
  const agentPort = createAgentPort(ctx, {
    // activation 形态的收窄/人格来源：热更快照里的 `config.dispatch.agentPreset`（配置驱动，端口不猜）。
    //
    // 【W3 · 真读数（P0-6 F-2 / D-2 W-2）】本解析器**必须消费 `ask` 并给出可核对见证**，不能只回一个 id。
    //   三种返回形态（端口侧据此判「能否宣称已收窄」，判定单点在端口）：
    //     · `null`                ⇒ 解析不出可用 preset（未配置，或**本 preset 覆盖了本次要禁的工具**）
    //     · 裸字符串 `'<id>'`      ⇒ 有 id **无覆盖声明** ⇒ 无见证（「配了名字」≠「收窄了」）
    //     · `{ preset, covers }`  ⇒ 有见证：`covers` = 该 preset **实际拿到**的工具面（来自
    //                               `config.dispatch.presetCoverage[<id>].tools`）
    //   ⚠ **真读 `ask`**：覆盖声明与本次 `ask.toolFace.deny` 相交 ⇒ 该 preset 拿到的工具里含有本次
    //     必须禁掉的 ⇒ 它**无法**覆盖本次请求 ⇒ 返回 `null`（而不是给出一个「能收窄」的假事实）。
    //     这条使不同 `ask` 得到不同解析结果（RL-2 区分力），解析器不再是「忽略入参的闭包」。
    presetFor: (ask) => {
      const presetId = typeof liveConfig?.dispatch?.agentPreset === 'string'
        && liveConfig.dispatch.agentPreset.length > 0
        ? liveConfig.dispatch.agentPreset
        : null;
      if (!presetId) return null;
      const coverage = liveConfig?.dispatch?.presetCoverage;
      const entry = coverage !== null && typeof coverage === 'object' ? coverage[presetId] : null;
      const tools = entry !== null && typeof entry === 'object' && Array.isArray(entry.tools) ? entry.tools : null;
      // 无覆盖声明 ⇒ 只有 id（无见证）。交由端口判「不可宣称」，不在此伪造事实。
      if (tools === null) return presetId;
      // 真读 ask：覆盖与本次 deny 相交 ⇒ 本 preset 覆盖不了本次请求 ⇒ 解析不出可用 preset。
      const deny = Array.isArray(ask?.toolFace?.deny) ? ask.toolFace.deny : [];
      if (deny.some((t) => tools.includes(t))) return null;
      return { preset: presetId, covers: [...tools] };
    },
  });
  // 【W3 · 真读数（P0-6 F-1）】闸必须问**真实 ask**。
  //   原写法 `canNarrow({})` 传空对象 ⇒ 形参全 `undefined` ⇒ 端口只能回「配置里有没有 preset 字符串」
  //   （e1-G06 的「名义收窄」）。现已具备真实 ask（S-0 把 `laneTask`/`roleData`/`askToolFace` 前移）：
  //   `role` 判该 lane 的角色工具面；`toolFace` = 本次实际要禁的工具集；`persona` = 本次要注入的人格。
  //   ⚠ 判据仍是「**能按次收窄吗**」（能力位），不是「哪个入口」——入口选择已完全归 provider。
  if (agentPort.available && !agentPort.canNarrow({ role: laneTask?.role, toolFace: askToolFace, persona: askPersona })) {
    // 成因分档（**码名已改**：W4 `codename` 把 `CAPABILITY_MISSING` → `CAPABILITY_UNAVAILABLE`，不可逆 + 原子提交，旧码永不回生）。
    //   ① 未配置 preset ⇒ **逐字保留**原文案（`test/f1-dispatch-activation-gate.test.js` 对该文案逐词冻结）；
    //   ② 已配置但**无法核实**覆盖（无 `presetCoverage` / 覆盖为空 / 覆盖与本次 deny 相交）
    //      ⇒ 用真读数文案（只讲「见证不可得」，不再宣称「未配置」）。
    const presetConfigured = typeof liveConfig?.dispatch?.agentPreset === 'string'
      && liveConfig.dispatch.agentPreset.length > 0;
    // 【D-1 · 批 `punky-d1d2-impl-20261103`】**拒派从 throw 改为返回**（统一返回形状 · 方案乙）：
    //   本闸位于 `store.setMember(…,'running')` 与 `issueLaneHandle(...)` **之前** ⇒ 此刻**没有 `base`、没有句柄**。
    //   故本路径**手写字段**（不含 token/firstLine/ttlMs）——「无句柄」是**事实**而非妥协：
    //   拒派本就打在状态变更之前（lane 保持待派发、无 `member.dispatch`、批相位不变）。
    //   `status` 直接取字面量 `'pending'`（**不读 `batch.lanes[lane]`**：本作用域内没有 `batch` 变量，
    //   且本闸位于 `store.setMember(…,'running')` 之前 ⇒ 不管存储怎么实现，此刻 lane 状态**必然**是待派发）。
    const rejectedOf = (note) => ({
      batchId,
      lane,
      status: 'pending',
      spawned: false,
      mode: 'rejected',
      code: 'GATE_DISPATCH_CAPABILITY_UNAVAILABLE',
      spawnNote: note,
    });
    if (!presetConfigured) {
      return rejectedOf('通道在，但本次 ask 的收窄不可核：未配置 `config.dispatch.agentPreset`（无收窄见证）⇒ 拒派，不以弱换强。'
        + '功能面读数 = agent 端口 `available=true` 但 `canNarrow(本次 ask)` = false（收窄只能经 `agentPreset` 组 composition）；'
        + ' ⚠ 但 **`maxDepth` 原生可用**（`request.maxDepth`，受 `capabilities.depthLimit` 约束）——不是「什么都做不了」。'
        + ' 填 `config.dispatch.agentPreset`（指向已按 toolFace 收窄的 preset）后即可正常自派。'
        + ' ｜ 拒派打在状态变更之前：lane=' + lane + ' 保持待派发（无句柄、无 `member.dispatch` 事件、批相位不变）。');
    }
    return rejectedOf('通道在，但本次 ask 的收窄不可核：已配置 `config.dispatch.agentPreset`，'
      + '但适配层**无法核对**它对**本次**请求的收窄（真读数口径，P0-6 D-2）：需要 '
      + '`config.dispatch.presetCoverage[<preset 名>].tools` 声明该 preset **实际拿到**的工具面，'
      + '且该声明必须**非空**、并与本次要禁的工具集**不相交**（「声明为空集」不算收窄 —— 空集与任何集的交集恒为空，'
      + '那会让判据退化成恒真）。'
      + ' ⚠ **这不是「配置问题」**：`a1-gate` 上批实测 —— 纯 D 宿主**已配** `agentPreset` + `presetCoverage` 仍被拒，'
      + '成因是「**本次 ask** 的收窄不可核」，不是配置缺项、也不是通道不存在。'
      + ' ⇒ 拒派（不宣称未核实的收窄）｜ lane=' + lane + ' 保持待派发（无句柄、无 `member.dispatch` 事件、批相位不变）。');
  }
  // ⓿-b role 数据面**前置解析** —— 已在 **S-0**（本 lane）上移到能力位闸**之前**，见上方「顺序重构」段。
  //   纪律不变：解析失败 ⇒ 抛 `GATE_ROLE_UNRESOLVED`，**零状态变更、零句柄发放**。
  //   ⚠ 任务包里的 `batch.wavePlan` 存的是 **wave 数组**（`[{wave, tasks:[…]}]`），旧写法读 `wavePlan.tasks`
  //     恒取不到 ⇒ 任务包「目标」位退化成 `（未声明 cmd）`。上移后仍拍平所有 wave 的 tasks（B1 活体教训）。
  const artifactsRoot = root
    ? String(root).replace(/[\\/]+$/, '') + '/sessions/' + sessionId + '/artifacts/' + batchId
    : undefined;
  // ⓿ 【2026-09-18 · Q-B 取消并发闸】原「闸位单点」调用 `assertConcurrencyAdmit(...)` 已删 ⇒ 本函数
  //   **零容量判定**（高并发不得被限流；`batch.concurrency` 只作声明 + 回显）。删除面与理由见本文件
  //   「并发闸 · 退役登记」段。
  // ① 置 running（含 Tier3 entry 门：consume 齐备 / condition / Manager 拉起）
  // 第 7 参 owner：派发面写入 ⇒ **派发即出池**（K1）；取不到 ⇒ null ⇒ 零写入（行为不变）。
  const b = store.setMember(sessionId, batchId, lane, 'running', null, exempt, ownerOfExec(exec));
  // ② 发放一次性句柄（任务包首行形态）
  const h = issueLaneHandle({ batchId, lane, sessionId });
  const base = { batchId, lane, status: b.lanes[lane], token: h.token, firstLine: h.firstLine, ttlMs: h.ttlMs };
  // ③ 降级「仅发句柄」（**入口选择已不在引擎**：两形态统一由 provider 的 `spawn` 内部分派）：
  //   · `available===false` ⇒ 降级，文案按 provider 给的**功能面** `reason` 分档（未注入 / 无启动入口）
  //   · `available===true`  ⇒ 继续走 ④，由端口内部分派到对应宿主入口（引擎不再知道自己拿的是哪种入口）
  if (!agentPort.available) {
    // 【D-1】`mode:'degraded'`：面不可用 ⇒ 仅发句柄（`code` 不给 ⇒ 与 `rejected` 两轨语义可分）。
    return { ...base, spawned: false, mode: 'degraded', spawnNote: spawnNoteOf(agentPort.reason) };
  }
  // N2/D6 三事实（2026-09-18 债清 3 · 逐条实测，勿再按印象改写）：
  //   ① **可热更**：`dispatch` 在 `lib/hot/config-watch.js:80` 的 `ALLOWED_TOP_KEYS` 白名单内
  //      ⇒ `<root>/config/runtime.json` 的 `dispatch.*` 改动经 watcher 生效，**无需重启宿主**。
  //      （白名单外的顶层键会被 `validateOverlay` 判 unknown 后**静默保持旧快照**——本类改动的经典坑。）
  //   ② **读端是热更快照**：`lib/index.js:282` 的 `readConfig` 注入 = `hotConfig.readSnapshot()`
  //      ⇒ 本行 `liveConfig?.dispatch?.provider` 取的是**当前生效快照**，不是启动期静态 config。
  //   ③ **「改不生效」的第一因不是代码，是配置缺失**：现网 `C:\Users\Administrator\.dsh\punky-preset\config\runtime.json`
  //      （2026-09-18 实读 573 B）顶层键只有 `gates` / `governance` / `capabilities`，**没有 `dispatch` 段**
  //      ⇒ `liveConfig.dispatch` 为 undefined ⇒ `provider` 恒 null ⇒ 走「仅发句柄」降级分支（下文 B4）。
  //      **排查顺序**：先看 `runtime.json` 有没有写 `dispatch.provider`，再怀疑热更链路。
  //   · **调用点唯 1 处**：`lib/tools/member-tools.js:110`（`lane_dispatch` → `dispatchLaneCore`）。
  //     原引 `lib/tools/core.js` 的 `:1369` 为**陈旧锚点**（该文件现 209 行、无 `lane_dispatch`），勿回写。
  //     历史「多调用点」表述随链推进全退役（2026-09-18 Q-A=C；chain-runner 模块已删除，
  //     不引文件锚点）**作废**，勿回加。
  const provider = liveConfig?.dispatch?.provider ?? null; // 热更快照（见上三事实；原读静态 config ⇒ 假热更）
  if (!provider) {
    // B4 能力位/配置前置：不猜 provider、不「以弱换强」。
    // ⚠ N1 清债（2026-09-16 评审）：此处**不得抛错**——抛错会**丢掉刚发放的句柄**，留下
    //   「lane=running、无 worker、无句柄」的僵尸态（只能靠心跳 `lane.binding_gap` 事后发现）。
    //   与「宿主无 ctx.subagents」同族 ⇒ 同走**降级为仅发句柄**：lane 保持 running、句柄原样返回
    //   （**不消费**，见本函数头 P0 口径），Leader 可补配置后重派，或用返回的 `firstLine` 走直派形态。
    ctx?.logger?.warn?.('[dsh-punky-swarm] lane_dispatch: 未配置 config.dispatch.provider ⇒ 仅发句柄（不猜 provider）· lane=' + lane);
    // 【D-1】**第二条 degraded 路径**（未配置 `dispatch.provider`）：同为「仅发句柄」⇒ 必须带 `mode:'degraded'`
    //   （`mode` 在 output schema 里是 **required** ⇒ 漏给会让实际返回与 schema 不一致）。
    return { ...base, spawned: false, mode: 'degraded', spawnNote: '未配置 config.dispatch.provider ⇒ 仅发句柄（补配置后重派，或用 firstLine 直派）' };
  }
  // ④ 任务包骨架：lane 契约 + role 三段 + 纪律 + 句柄首行（B2/B3 由 buildStartRequest 注入 toolFilter/label）
  // 【2026-10-07 · P2】`laneTask` / `artifactsRoot` 的读取已**上移**到 ⓿（role 拒派须先于状态变更）；
  //   `role` 传**已解析的 role 对象**（非裸名）⇒ 三段注入生效，且「同 role 跨批稳定」。
  // 【C-5 · lane `e5-c5-quietfix`】注入预算配置的**取值单点**（hoist 到调用前）：既供任务包面 A
  //   （下方 `composeWorkerPrompt({ injectBudget })` 实参），也供 `member.dispatch` 载荷的
  //   **消费侧留痕**（④，见本函数后段）—— 同一次读取、同一快照 ⇒ 两面读数不可能分裂。
  //   行为零变化：原先在实参处**内联** `readCapability(liveConfig, 'injectBudget')`，此处只是提前取值。
  const injectBudget = readCapability(liveConfig, 'injectBudget');
  const prompt = composeWorkerPrompt({
    batchId, lane, cmd: laneTask?.cmd, layer: laneTask?.layer, role: roleData,
    consume: laneTask?.consume ?? [], produce: laneTask?.produce ?? [], outputs: laneTask?.outputs ?? [],
    firstLine: h.firstLine, leaderPrompt, artifactsRoot,
    // 【批 `d-override-fix-20261011` · lane `e4-session-bind` · 必做项 ④】任务包**双保险**：
    //   注入批归属会话 id（= 本函数落点会话 = 批文件所在会话 = `member.dispatch.sessionId`），
    //   使命中面覆盖 `dispatchIndex` 的重启重建窗口（详见 `composeWorkerPrompt` 参数注释）。
    batchSessionId: sessionId,
    // 【2026-09-27 · GR-13；2026-10-23 批 punky-logfix-20261023 更正】lane 声明位现已**持久化**：
    //   `lib/wave-plan.js:1078`（`singleArtifactWrite: t.singleArtifactWrite === true,`，批 cleanup-settle-20260929 G-4 甲）
    //   ⇒ 派发路径的直读**会生效**，不再是恒 `false` 的逃生位。`composeWorkerPrompt` 内
    //   「audit 层 + 声明写盘面恰一件」的**自动判定同时保留**（两者取「或」，见该函数 `singleArtifactWriteLane`）。
    singleArtifactWrite: laneTask?.singleArtifactWrite === true,
    // 【L2 注入预算】面 A 阈值：从**热更快照**读（与上方 `liveConfig?.dispatch?.provider` 同一快照口径
    //   ⇒ runtime.json 改 `capabilities.injectBudget` 即生效，无需重启宿主）。
    //   唯一取值源 = 注册表 `capabilities.injectBudget`（经 readCapability 缺省合并 ⇒ 默认开）。
    injectBudget,
    // 【P2 · arch-context】架构上下文：按本 lane 的**目标文件**（`targets`，绝对路径，见
    //   `types/contracts.ts`）裁剪 `.punky/arch.yml`，让 worker 开工即知「涉域 + 允许依赖 + 禁区」。
    //   取不到 targets（缺省 null）/ 取不到 arch.yml / 域集合为空 ⇒ 返回 `null` ⇒ 任务包零变化（零回归）。
    archContext: renderArchContext({ targets: laneTask?.targets ?? null }),
    // 【批 `punky-guidance-preflight-20261025` · lane `c1-preflight`】P0-1 开工前必做四段：
    //   取值 = 该 lane 的 `WavePlanTask.preflight`（建批归一化恒写：未声明落 `null`）⇒ 未声明即走警示行。
    //   接线约束：`preflight` **不进** `cmd` / **不进** `sig` / **不回写** `skills`（D3 三通道并存）。
    preflight: laneTask?.preflight ?? null,
    // 【pk-impl】checkpoint 计划清单（缺省 `null` ⇒ 任务包零感知，不新增任何文本段）。
    checkpoints: laneTask?.checkpoints ?? null,
    // 【ckpt-wire · A 通道】`WavePlanTask.resume`（建批恒写、缺省 `false`）⇒ 任务包注入 `RESUME_CLAUSE`。
    //   `laneTask` 已在同处被读（`laneTask?.checkpoints` / `laneTask?.preflight`）⇒ 不新增取值路径、
    //   不改 `dispatchLaneCore` 的任何前置逻辑（不触状态机、不触门禁）。
    //   严格 `=== true`：非 `true`（`false` / `undefined` / `null`）一律不注入（fail-safe 向零回归）。
    resume: laneTask?.resume === true,
    // 段渲染异常时的降级告警落点（唯一消费点，见该函数 logger 参数注释）。
    logger: ctx?.logger ?? null,
  });
  // 【2026-09-22 · one-shot 化】`startContinuable(spec)` → **`rt.start(provider, request)`**：
  //   one-shot 请求**平铺**（label/prompt/parent/signal/toolFilter/persona/maxDepth 同层）；
  //   **只 await 启动、不 await `run.result`**（fire-and-forget，保住「不阻塞 Leader 回合」）；
  //   run 交 `trackOneShotRun` 持引用（终态自动摘除，失败显式告警不进判定）。
  let start = null;
  try {
    if (!exec?.agent) throw new Error('缺少调用方 Agent —— 派发必须在工具流水线内调用（exec.agent 决定子会话挂载点）');
    // 【2026-09-24 · 0.1.7-rc.1 兼容自愈（A 方案）】宿主 `tools.restrict()` 对 `toolFilter.deny` 里的
    //   **未知工具名严格抛错**（不忽略）⇒ 名单残留一个**「该 scope 不可 restrict」**的名字即触发（实例：
    //   `wait_agent` —— 它由 agent-team 层注册，**仅在启用该层的 profile 上可 restrict**；未启用则不在
    //   `restrictableNames` 内），本次自派
    //   即**确定性失败**、lane 落 `failed` 终态（K3 不可原地重派 ⇒ 代价 = 整批作废）。
    //   自愈口径：从错误文案解析未知名 → **仅从本次 deny 名单移除** → **同一次派发内重试**（句柄只发放
    //   一次、不重复消费）；非该形态的错误**照旧抛出**（绝不吞错，守 B6「失败显式」纪律）。
    const denyAll = [...new Set([...SUITE_DENY_TOOLS, ...(liveConfig?.dispatch?.denyTools ?? [])])];
    const denyDropped = new Set();
    for (let attempt = 0; ; attempt++) {
      try {
        // 【宿主端口面】分派**完全收进端口**（W3-S2 收口）：本文件既不自探形态、也不直调宿主入口，
        //   只组装**请求载荷**并交 `agentPort.spawn(...)`；具体走 `start` 还是 `activation` 由 provider 决定
        //   （`request` 由 provider 内部按能力落位：`agentPreset` / `maxDepth` / `toolFilter`）。
        const builtRequest = buildStartRequest({
          batchId, lane, parent: exec.agent, prompt,
          // denyTools/persona 同样读**热更快照**；【2026-10-07 · P2】`role` 传已解析对象 ⇒
          //   ② persona 由 role 派生（R-4：`title` + `mission` + 工作方式），③ deny 并入 allow 反推集（R-5）。
          denyTools: denyAll.filter((n) => !denyDropped.has(n)),
          extraDeny: [], // 已并入 denyAll（合并后再过滤，避免两路名单各有未知名时自愈失效）
          persona: liveConfig?.dispatch?.persona,
          role: roleData,
        });
        // 【W3-S2 · 批 `punky-adapter-split-20261031` · lane `w3-engine-entry`】
        // **入口选择已从引擎删除**：原 `if (agentPort.form === 'activation') { spawn } else { rt.start }`
        //   两分支合一为**唯一**一次 `agentPort.spawn(...)` ⇒ 分派由 provider 的 `formOf` 单点内部完成
        //   （AC-5′ 目标态：形态定义点 engine = 0 / provider = 1；AC-5″：引擎不消费宿主形态值）。
        // ⚠ **`toolFace` 必须真传**：原 activation 分支不传 ⇒ 收窄通道整键丢失（P0-6 **F-3**）；
        //   统一后两形态拿到同一份载荷，按次收窄不再依赖「另一条独立路径」。
        //   （⇒ F-3 的**症状**随本统一消失；见证核对与量具口径仍归 `w3-meter`，本 lane 不改量具。）
        // 【ly-impl · 批 `punky-arch-refine-20261101`】派发动词改为契约 `push_execute(spec, options)`：
        //   `spec` = `ExecSpec`（**从黑板读**：`wavePlan.tasks[]` 的 lane 任务 + 绑定会话 + 契约引用）；
        //   `options` = **非契约第二参**（R-5）：承载 C 通道所需的 `provider/label/prompt/parent/signal/
        //   role/toolFace/persona/maxDepth`（`toolFace` 必须原样到 provider，F-3 复发防线）。
        //   ⚠ **通道选路在 provider 单点完成**（引擎不判形态、不选通道）。
        // 续用绑定：本 lane **最近一次** `member.dispatch` 登记的 worker 会话（纯读本批事件流）。
        //   ⚠ **为何不用 `laneBindingOf(store, sessionId)`**：它的语义是「**本会话作为 worker 的归属**」
        //   （见本文件 `laneBindingOf` 的注释），返回**单个**对象、其 `sessionId` 字段是**那个批的归属会话**；
        //   而这里要的是「**本 lane 续用哪个子会话**」—— 两者不是一回事：
        //     · Leader 通常不是 worker ⇒ 恒 `null`（D 档仍不可达，形同死码）；
        //     · 若 Leader 自己也曾是 worker ⇒ 取到**上层批**的归属会话并当成续用会话 ⇒ **错派**（比不可达更危险）。
        //   ⇒ 必须用**按 lane 查**的单点 `expectedWorkerSessionOf`（`lib/verify/binding.js:52`）。
        const boundSessionId = expectedWorkerSessionOf(store.readBatch(sessionId, batchId), lane);
        const pushed = await agentPort.push_execute(
          {
            runId: h.token, // 一次性句柄 token（C 档派发的唯一凭证；与既有语义同源）
            // AC-8：`targetId` **由 Leader 给定**（`lanes[].roster`）；缺省回落 lane id（与既有 label 同源），
            //   适配器**不得自选成员、不得扩员**。
            targetId: laneTask?.roster ?? lane,
            member: { id: laneTask?.roster ?? lane, title: laneTask?.role ?? undefined },
            session: { id: boundSessionId, params: null },
            // ★ DAG 真源：`wave` / `deps` 直接取自黑板 lane 任务（蟛蜞模式拓扑）。
            taskPkg: { id: lane, wave: laneTask?.wave, deps: laneTask?.deps ?? [] },
            // R-4（已裁）：`contract` 由 Leader 建批时写入 `wavePlan.tasks[].contract`；缺失容忍（存量批兼容）。
            contract: {
              id: laneTask?.contract?.id ?? lane,
              sha256: laneTask?.contract?.sha256 ?? null,
            },
          },
          {
            provider,
            label: builtRequest.label,
            prompt: builtRequest.prompt,
            parent: exec.agent,
            signal: builtRequest.signal,
            role: laneTask?.role,
            // 工具面：`builtRequest.toolFilter` 即 `buildStartRequest` 合成的按次 deny 集。
            toolFace: builtRequest.toolFilter,
            // 【死参数说明（批 `punky-presmoke-2026-10-31`；统一入口后仍成立）】**接收但不转发生效**：
            //   activation 入口的宿主**无 `persona` 字段**（人格只能经 `agentPreset` 组合生效）⇒ 该路径下不起作用。
            //   **这不是缺陷**：保留传参是为让 `start` / `activation` **两形态签名一致**。**禁删**。
            persona: builtRequest.persona,
            maxDepth: builtRequest.maxDepth,
            // D 通道成功判据的凭据（`listMembers(agent)` 要求 live Team member 的 agent）。
            agent: exec.agent,
          },
        );
        // 【AC-16 · ly-impl】**不可确认 ⇒ 不写绑定、lane 保持 running**（既不置 failed、也不写 member.dispatch）：
        //   判据 = `errorCode:'PUSH_UNCONFIRMED'`（工具 ok 但名册反查未命中 = 观测面缺失，不是执行失败）。
        //   交既有兜底（`post-execute` 观察 + `laneBindingOf` 惰性重建）补登记，见设计 §②。
        if (pushed && pushed.errorCode === 'PUSH_UNCONFIRMED') {
          // 【D-1】三分法裁（批 `punky-d1d2-impl-20261103`）：`rejected` = **我们主动拒绝派**；
          //   `degraded` = **派了/该派但没法保证**。本条是「**已尝试派发，但确认不了**」⇒ 不是拒绝，是降级 + 待确认
          //   ⇒ `mode:'degraded'`。`unconfirmed` 是 AC-16 的核心信号（「不可确认 ≠ 失败」），不得因 schema 收紧而删。
          //   字段职责边界：`reason` = 机器可判短码（`'PUSH_UNCONFIRMED'`）；`spawnNote` = 人读长文 —— 两者并存、不互相冒充。
          return { ...base, spawned: false, mode: 'degraded', unconfirmed: true, reason: 'PUSH_UNCONFIRMED' };
        }
        // 成功：C 档有 `run`（子会话句柄）；D 档无 run，但有名册反查到的 `sessionId` ⇒ 统一成 `{ id }` 形态
        //   交给既有 `workerSessionIdOf` 取值单点（不新造第二套取值逻辑）。
        start = pushed?.run ?? { id: pushed?.sessionId ?? null };
        break;
      } catch (e) {
        // 【P-2 修正（2026-09-24，独立复核发现）】宿主模板对 **≥2 个未知名** 用**复数**文案
        //   `unknown global tools "X", "Y"`（`${unknown.length > 1 ? 's' : ''}`）⇒ 正则须收 `tools?`，
        //   否则复数形态失配、`unknownName=null`、自愈静默退化为原始确定性失败（＝白做）。
        const um = /unknown global tools?\s+["'`]?([A-Za-z0-9_.:-]+)/i.exec(String(e?.message ?? e));
        const unknownName = um ? um[1] : null;
        if (unknownName && !denyDropped.has(unknownName) && denyDropped.size < 8) {
          denyDropped.add(unknownName);
          ctx?.logger?.warn?.('[dsh-punky-swarm] lane_dispatch: 宿主工具面无 "' + unknownName
            + '" ⇒ 从 deny 名单移除后重试（0.1.7 兼容自愈，第 ' + (attempt + 1) + ' 次）');
          continue;
        }
        throw e;
      }
    }
  } catch (e) {
    const m = mapSpawnError(e); // B6 失败显式：归一为可读码面，绝不静默
    // D-3（2026-09-16 清债）：派发失败**必须回滚 lane**——否则 lane 停在 `running` 却无 worker。
    //   K3（2026-09-21）改判：返工边 `review→running` 已去除 ⇒ 回滚到 `review` 会把 lane 卡在**非终态且无法重派**。
    //   回滚目标改取 `failed`（`running→failed` 在迁移表内，**零新增边**）：派发失败即终态，
    //   恢复按 K3 走「gap-list + 新任务批次」，**不再原地重派**。回滚为 best-effort，**不吞原始错误**。
    try { store.setMember(sessionId, batchId, lane, 'failed', 'dispatch-failed'); } catch { /* best-effort */ }
    // N5 清债（2026-09-16 评审）：失败路径**必须作废已发放的句柄**——否则它留在 `pendingHandles` 里，
    //   绑定缺口观测（`bindingGapOf`）会把它报成 `token-ttl-expired` 幽灵信号。句柄面没有 revoke API，
    //   故用一次性消费（`consumeLaneHandle`）把它从 pending 中摘除：token 从此作废，语义等价「已回收」。
    try { consumeLaneHandle(h.token, { batchId, lane }); } catch { /* best-effort */ }
    throw new Error(m.code + ': ' + m.message
      + ' ｜ 已将 lane=' + lane + ' 置 failed（无 worker 挂载；派发失败即终态）⇒ 恢复步骤：记入 gap-list 并开新任务批次，'
      + '**不可原地重派**（K3：返工边 review→running 已去除，重派会被 `invalid member transition` 拒）；'
      + '如需人工核查：`gate_status({ batchId: "' + batchId + '", lane: "' + lane + '" })`。');
  }
  // worker 会话 id **定点取值**（`SubagentRun.id` = 子会话 id），不再静默猜字段；
  //   兼容回落会**显式告警**，取不到则带原始载荷显式报错（不静默 null ⇒ 不留「绑定失败但无根因」）。
  const workerSessionId = workerSessionIdOf(start, (msg) => ctx?.logger?.warn?.('[dsh-punky-swarm] ' + msg));
  if (!workerSessionId) {
    throw new Error('GATE_DISPATCH_FAILED: rt.start 未返回 worker 会话 id（载荷=' + JSON.stringify(start)
      + '） —— 契约字段为 `id`（`SubagentRun.id` = 子会话 id；与 `subagent/end` 事件 `info.id` 同源）；'
      + '宿主返回形态若变更请按本载荷适配。');
  }
  // 【2026-09-22 · one-shot 化】run 生命周期属主登记（持引用防 GC 语义歧义；终态自动摘除；失败显式告警）。
  trackOneShotRun(workerSessionId, start, (msg) => ctx?.logger?.warn?.('[dsh-punky-swarm] ' + msg));
  // ⑤ B5 唯一写路径：自派成功即由引擎直接登记（不依赖 post-execute 事后观察）
  //   【批 `lane-wake-mainpath-fix-20261010` · W-1】载荷**纯加法**：既有 2 键语义一字不动，
  //   追加 `ownerSessionId` = 本次派发的发起方 agent 会话 id（写侧单点取值）。取不到 ⇒ **不写该键**
  //   （R-7：不得写 `'cli'`/空串一类死地址；读端按「缺失」走 C-3 回退 ⇒ 与改前逐字相同）。
  //   该值是主路（`subagent/end`）唤醒的**唯一**寻址来源（`info` 载荷不含父会话，L-AC-1）。
  const ownerSessionId = ownerSessionIdOfExec(exec);
  // 【C-5 · ④ 消费侧静默面】`capabilities.injectBudget.enabled === false` 时，`composeWorkerPrompt` 的
  //   `budgeted` 判定为假 ⇒ **perItem 层整条跳过**，此前**无任何留痕** ⇒ 事后无法分辨「预算没生效」是
  //   「入参未超限」还是「被配置关掉」（同族静默面）。
  //   ⇒ 在**既有** `member.dispatch` 载荷上追加 `budgetEnabled: false` 予以显式化。
  //   ⚠ **非空才写键**（冻结口径 C-5）：`enabled === true`（= 注册表默认）时**不写该键**
  //   ⇒ 存量载荷键集与键序**逐字零变化**（既有读端与断言不受影响）。
  const budgetKey = injectBudget?.enabled === false ? { budgetEnabled: false } : {};
  store.appendEvent(sessionId, batchId, EVT_MEMBER_DISPATCH, ownerSessionId
    ? { lane, workerSessionId, ownerSessionId, ...budgetKey }
    : { lane, workerSessionId, ...budgetKey });
  // ⑤′ **同步写索引**（批 `session-bind-index-fix-20261012` · lane `e1-fix` · 修复③ **主路**）：
  //   消除「事件有、索引无」的分裂 —— 本行是「引擎自派 worker 拿不到批归属索引」的**确定性根源修复**。
  //   写序（硬）：**先** `appendEvent`（绑定事实落盘）**后** `set`（索引即时生效），与下方句柄作废序同构。
  //   值与**登记点热登记**（`lib/bridge/dispatch-register.js:108`）**同源**：`dispatchIndexEntryOf` 值构造单点
  //   ⇒ 冷/热读数逐字相同（L-AC-5）。取不到 owner 会话 ⇒ 索引值以 `null` 表达（**非枚举字段缺席**）；
  //   ⚠ 与**事件载荷**「取不到不写该键」**语义不同、不得合并**（载荷口径属 `member.dispatch` 冻结面 R-7/C-9）。
  //   fail-safe：`dispatchIndex` 缺省 `undefined` / 非 Map ⇒ 整段跳过（逐字零行为变化）。
  //   ✅ **写点存活（2026-10-22 · A1-P2-04 校正；原「入参面无该参 ⇒ 恒跳过（dormant）」表述作废）**：
  //   本参数在 `dispatchLaneCore` 签名内；唯一调用点 `lib/tools/member-tools.js` 的 `dispatchLaneCore({...})`
  //   已传 `dispatchIndex: deps?.dispatchIndex`，`lib/index.js` 的 `installTools` deps 面亦已注入同一 Map 引用
  //   （按符号检索 `dispatchIndex`，勿写死行号 —— 本批另一 lane 正在 `lib/index.js` 并行改动）。
  //   ⇒ 生产路径**本段确实在写**（`test/lane-session-bind.test.js` 的「回归-c」即以真实组装面锁定这一点）。
  if (dispatchIndex instanceof Map && workerSessionId && !dispatchIndex.has(workerSessionId)) {
    dispatchIndex.set(workerSessionId,
      dispatchIndexEntryOf(sessionId, batchId, lane, ownerSessionId)); // 幂等守卫：同键覆盖不重复写
  }
  // ⑥ **P0**：成功自派 ⇒ 立即作废句柄（口径见本函数头「自派即发放即作废、仅直派形态需长期有效」）。
  //   顺序要点：必须在 `member.dispatch` 登记**之后**——先有绑定事实、再无悬赏意图，
  //   否则「无 dispatch 事件 + 句柄已消费」会在探针面构造成一个无人认领的中间态。
  try { consumeLaneHandle(h.token, { batchId, lane }); } catch { /* best-effort：句柄面为进程内单例，不该抛 */ }
  return { ...base, spawned: true, workerSessionId };
}

// ── C 阶段：C 档派发面门禁（**软启用**，防自锁） ─────────────────────────────────
// 语义（「不写 token 即禁止派发」）：
//   · **B 档**：`subagent`/`subagent_fork` **一律放行**（单步调研/单步派发，无 lane 绑定）；
//   · **A 档**：由既有门禁 3 拒（本函数不重复判）；
//   · **C 档**：须携带**有效 lane 句柄**（`lane_dispatch` 发放；一次性 + TTL）。
// 落地形态 = `config.dispatch.gate`：`'warn'`（缺省，**只留痕告警不拦**）。
// **`'enforce'` 拒态已删**（勿回加）—— 原码
//   `subagent`/`subagent_fork`（`dsh-experimental-agent-team-profile/cordis.patch.yml:10-14`）
//   ⇒ 闸门拦的工具在官方场景不存在。现语义 = **只留痕不拦**（`evaluateTierCDispatch` 恒 `ok:true`
//   + `warnNote`）；`readGateMode` 保留（配置面仍在，供审计/热更观测，不再决定拦截）。
export function readGateMode(config) {
  const m = config?.dispatch?.gate;
  return m === 'enforce' ? 'enforce' : 'warn';
}

// ── D 阶段：成员侧套件通信（`swarm_report` → Leader / `swarm_cc` → Manager） ─────────
// 身份**由引擎反查绑定**（不靠成员自报）：`member.dispatch` 的 workerSessionId → { batchId, lane }。
// 【gate-lite 第一批 · E① 清理（2026-09-17）】**已删 `UNBOUND_REPORT_CODE` 导出与「未绑定即拒」语义**：
//   官方 Team 成员（宿主 `spawn_teammate` 拉起）**天然无 lane 绑定** ⇒ 未绑定是**常态**，硬拒即误拦
//   （实测命中 `replay-lock` / `asset-chain`）。现口径 = best-effort：消息照发、事件按「批次可否解析」
//   如实落/不落、回显 `unbound`/`eventWritten`/`notice`（唯一实现见 `lib/tools/swarm-comms.js:63` 的 `reportTargetOf`；
//   历史上曾误引 `lib/tools/core.js` 的一个不存在符号（该文件现 209 行），**勿回写**）。
//   本段只留史迹，**不再提供常量导出**（防读端回生旧语义）。

/** 从批次事件流反查该会话绑定的 lane（worksWith 引擎自派与直派两种登记形态）。
 *
 *  【2026-10-22 · A1-P1-04】返回值**同时带回唤醒寻址字段**：事件带 `ownerSessionId` ⇒ 以**非枚举自有属性**
 *  附加上去（与 `dispatchIndexEntryOf` **同法**，不引入第二种附加机制）；取值统一经解析单点 `ownerSessionIdOf`。
 *  ⇒ `Object.keys` / `deepStrictEqual` / JSON 序列化**逐字仍是 3 键**（既有形状锁不变）；
 *     事件**不带** owner（R-7 事件侧口径：取不到即不写该键）⇒ **不附加**该属性（键**缺席**，不是 `null`）。 */
//   【S-4a/S-4b（批 `punky-qa2-fix-2026-10-31`）】静默失败两处收口（**两态可辨**，见下方各 catch 注释）：
//   · `listAllBatches` **抛错** ⇒ `warn('batch-enum-failed: …')` 后返 null（枚举坏了 ≠ 没有批绑定）；
//     枚举成功但**空数组** ⇒ 无 warn、仍返 null（正常态）。
//   · 单批 `readBatch` **抛错** ⇒ `warn('batch-read-failed: <session>/<batch> …')`；**返回 falsy（批不存在）**
//     ⇒ 无 warn、照常 `continue`（不把「读坏了」与「没这批」混同）。
export function laneBindingOf(store, sessionId, logger) {
  if (!sessionId || !store || typeof store.listAllBatches !== 'function') return null;
  let all = [];
  try {
    all = store.listAllBatches() ?? [];
  } catch (e) {
    logger?.warn?.('[dsh-punky-swarm] batch-enum-failed: ' + String(e?.message ?? e)
      + '（laneBindingOf · session=' + sessionId + '）⇒ 返 null；这是**枚举失败**，不是「无批绑定」');
    return null;
  }
  for (const { sessionId: ownerSession, batchId } of all) {
    let b = null;
    try {
      b = store.readBatch(ownerSession, batchId);
    } catch (e) {
      logger?.warn?.('[dsh-punky-swarm] batch-read-failed: ' + String(ownerSession) + '/' + String(batchId)
        + '（' + String(e?.message ?? e) + '）⇒ 跳过该批继续；这是**读失败**，不是「批不存在」');
      continue;
    }
    for (const ev of b?.events ?? []) {
      if (ev?.type === 'member.dispatch' && ev.workerSessionId === sessionId && ev.lane) {
        const bind = { sessionId: ownerSession, batchId, lane: ev.lane };
        const owner = ownerSessionIdOf(ev); // 解析单点（禁在本函数直读字段名）
        if (owner) {
          Object.defineProperty(bind, 'ownerSessionId', {
            value: owner, enumerable: false, writable: true, configurable: true,
          });
        }
        return bind;
      }
    }
  }
  return null;
}

/**
 * 批次邮箱根（与 lane-heartbeat 同口径）：<engineRoot>/sessions/<sessionId>/mailbox/<batchId>。
 * **实现单点** = `lib/mailbox-paths.js::mailboxRootOf`（A1-P2-10：本文件原有一份手写派生，与
 *   `comms/mailbox-paths` / `bridge/trajectory` / `watch/heartbeat/context` 三份同形 ⇒ 已收成一份）。
 * 本处**保形再导出**（导出名 / 参数个数 / 语义逐字不变，消费方 `tools/swarm-comms.js` 零改动）。
 * 唯一行为边界：root 为 `null`/`undefined` 由「产出 `/sessions/…` 无根路径」改为 **throw**（fail-closed，
 *   见单点文件顶部声明）。
 */
export { mailboxRootOf } from '../mailbox-paths.js';

/** 成员回报的通路（0f/Manager 通道口径）：Leader 读 broadcast；Manager 读 supervisor/inbox。 */
export const REPORT_CHANNEL = Object.freeze({ leader: 'broadcast', manager: 'inbox' });

/**
 * 纯函数：给定档位/工具名/参数文本/配置，判定 C 档派发面的**留痕**处置。
 * **恒 `ok:true`（不再拒）**：原 `mode==='enforce'`
*   分支已随码删除（**双层真相**：宿主顶层 profile 的派发工具区段写 `disabled: true`
*   ——**该文件由 loader 在 boot 期重写，行号不稳定 ⇒ 本注释刻意不引行号**，
*   而 preset 层 `cordis.yml:770-780` 与 `presets/punky-preset/agent.cordis.yml:220-232` **未禁用**
*   ⇒「官方 profile 已 disable」只在顶层成立；与 `lib/bridge/dispatch-register.js` 的订正同口径，
*   见 gap-list A1-P2-04）。
 *   `mode` 仍回显（`warn`/`enforce` = 配置面事实，供审计观测），但**不再影响判定**；无有效句柄一律产 `warnNote`。
 * @returns {{applies: boolean, ok: boolean, mode: 'warn'|'enforce', handleReason: string|null, denyReason: null, warnNote: string|null}}
 */
export function evaluateTierCDispatch({ tier, toolName, argsText, config, handleCheck }) {
  const mode = readGateMode(config);
  const isDispatchTool = toolName === 'subagent' || toolName === 'subagent_fork';
  if (!isDispatchTool || tier !== 'C') {
    return { applies: false, ok: true, mode, handleReason: null, denyReason: null, warnNote: null };
  }
  const r = typeof handleCheck === 'function' ? handleCheck(argsText) : { ok: false, reason: 'no-handle-check' };
  if (r.ok) return { applies: true, ok: true, mode, handleReason: null, denyReason: null, warnNote: null };
  const handleReason = r.reason ?? 'invalid-handle';
  return {
    applies: true, ok: true, mode, handleReason, denyReason: null,
    warnNote: 'dispatch without valid lane handle under tier C（mode=' + mode
      + '，留痕不拦；原 enforce 拒态已随码删除）'
      + ' · tool=' + toolName + ' · handle=' + handleReason
      + ' —— 仍建议：先 `lane_dispatch({ batchId, lane })` 取句柄并把 `firstLine` 写入子代理任务包首行。',
  };
}

// ── E 阶段：模式跟随（全局装载、不全局生效） ────────────────────────────────────
// 用户裁决（2026-09-16）：插件绑定指引使用，切到别的模式后门禁仍开着会把没有蟛蜞指引的 Agent
//   直接卡死。诉求 = 「全局装载，但不全局生效」——**运作跟随模式开关**（静态 config 或热更入口）。
// 语义（`config.modes.gate`）：
//   · 未配置 / `null` → **全模式生效**（旧行为；包缺省保持向后兼容，不因升级悄悄开启或关闭任何人）；
//   · 字符串数组      → **白名单**：只有 `header.agentPreset ∈ 白名单` 的会话启用蟛蜞治理
//     （门禁、执行型计数、套件工具一律不介入其他模式）；
//   · `[]`            → 显式停用（谁都不生效）；
//   · 其它形态        → 回落「全模式生效」+ 告警（防拼写漂移悄悄关掉门禁；宁可见旧行为也不要幽灵配置）。
// 读端：传入的 config 必须是**当前生效快照**（index.js 注入热更快照读取器）⇒ 改 runtime.json 的
//   `modes.gate` 即热生效，无需重启。
export const MODE_INACTIVE_CODE = 'GATE_MODE_INACTIVE';

/** 会话所属模式（agent preset id）：来自会话 header 的创建事实（宿主 dsh-session 校验为 string）。 */
export function presetOfSession(exec) {
  const p = exec?.agent?.session?.header?.agentPreset;
  return typeof p === 'string' && p ? p : null;
}

/** 子会话（Manager / worker）：宿主语义下 join 父会话的 standing 组合 ⇒ 模式随父，不因缺 header 被误判。 */
export function isChildSession(exec) {
  const h = exec?.agent?.session?.header;
  return !!(h && (h.delegationDepth > 0 || h.parentSession));
}

/** 归一 `config.modes.gate`（纯函数，可单测）：null = 全模式生效；数组 = 白名单。 */
export function normalizeModeGate(raw, warn) {
  if (raw === undefined || raw === null) return null;
  if (Array.isArray(raw)) {
    const bad = raw.filter((x) => typeof x !== 'string' || x === '');
    if (bad.length) {
      warn?.('modes.gate 元素须为非空字符串（got ' + JSON.stringify(bad) + '）⇒ 回落「全模式生效」');
      return null;
    }
    return [...raw];
  }
  warn?.('modes.gate 须为字符串数组或 null（got ' + JSON.stringify(raw) + '）⇒ 回落「全模式生效」');
  return null;
}

/**
 * 本会话是否启用蟛蜞治理（纯函数）。
 * @param config 当前生效配置快照
 * @param exec   工具调用上下文
 * @returns {boolean} true = 启用（旧行为）；false = 本模式不生效 ⇒ 门禁/计数/套件工具全部不介入
 */
export function modeActiveFor(config, exec, warn) {
  const gate = normalizeModeGate(config?.modes?.gate, warn);
  if (gate === null) return true;
  if (isChildSession(exec)) return true; // 子会话继承父会话模式（Manager 结算面不被误锁）
  const preset = presetOfSession(exec);
  return preset !== null && gate.includes(preset);
}
