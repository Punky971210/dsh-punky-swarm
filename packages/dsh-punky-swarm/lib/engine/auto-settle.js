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

// engine/auto-settle.js —— P3a **自动结算**（规格 §2 触发面 / §3 判定器 / §4 停轮语义）。
//
// 定位：把「谁触发 lane 结算」从 Leader 手工 `member_settle` 改为**引擎自动**——
//   worker 交付 ⇒ 引擎按团队契约判据判定 ⇒ 全绿自动 `running→review→merged`；
//   任一不满足 ⇒ **停轮**（缺省 `pause`：写事件带 reason + 批 `running→paused`），
//   **不写 failed、不 abort、不改成员状态**（停轮只停推进，不判死）。
//
// ── 双路触发（规格 §2），合并到**单点判定** ─────────────────────────────────────────
//   ① 主路 `subagent/end`（宿主生命周期事件，`lib/index.js` 装配期注册）：
//      **必须** `ctx.on('subagent/end', onChildEnd, { global: true })`——契约卡
//      `plan/host-completion-probe-spec.md` #6/#8/#9 探针实测：被宿主 scope 化的插件 ctx（preset
//      standing mount）下**默认监听漏收**（C/D 行 MISS），`{ global: true }` 短路一切 scope 过滤
//      （`cordis/lib/index.js:263`）。**不得**以「根 ctx 收得到」为由省略（#7 成立仅因未 tag）。
//      回调内**不得**解析子句柄（#12：handle disposal 先于 emit）——结算所需信息只来自 payload，
//      故本模块**不调** `ctx.get('agents')` 一类取句柄的路径。
//   ② 兼底路 `settle-request`（worker 显式交付意图）：成员侧 `swarm_report` 经身份反查
//      （`laneBindingOf(store, callerSessionId)`，判据 = `member.dispatch` 事件）后调 `requestAutoSettle`。
//   **两路共用同一个 `autoSettleLane`**（本文件唯一判定入口，禁第二套口径）；两路同时到达 ⇒
//   幂等键去重后**单次结算**（第二路 **no-op**：不重复写事件、不重复推进）。
//   ⚠ **2026-09-24 用户裁决：幂等闸不再落 `auto.settle.skipped` 留痕** —— 该形态是**纯噪音**：
//     兼底路（worker 主动 `settle-request`）抢先结算后，主路（宿主 `subagent/end`，实测晚 60–63 s）
//     到达必命中该闸 ⇒ 每个 lane 正常结算都会多产一条 `already-settled`。幂等语义不变。
//     其余三处 `auto.settle.skipped`（`lane-terminal` / `phase-*` / audit 职责转移）**保留**。
//
// ── 幂等去重（契约卡 §36：键 =（batchId, lane, 子会话 id）） ────────────────────────
//   键落 `auto.settle.triggered.settleId`；判定**只查批次 JSON**（唯一跨重启持久事实源，
//   与 `EVT_LANE_LONGRUN_UNCONSUMED` / `gate.contract_missing` 同法）⇒ 进程重启后重放不重复写
//   `member.settled`。子会话 id 取 `info.id`（durable 会话 id）而**非** `runId`——契约卡 #11：
//   每 epoch 新 `runId`，取 runId 会让同一 worker 的多 epoch 重复结算。
//
// ── 判定器复用（规格 §3：**禁复制第二套口径**） ────────────────────────────────────
//   `merged` 判据 = 既有 Tier3 校验链**原样复用**，实现上**零复制**：本模块只做「把 lane 推到
//   `review` 再调 `store.setMember(lane,'merged')`」，判据链（produce/outputs 存在、targets 已变更、
//   `gate:` 命令 exit 0、audit 契约、needHuman 转人工闸）全部由**既有**写路径承担：
//     · 判据实现     = `lib/state/gates.ts` 的 `checkExitGate` / `checkTargetsGate` / `checkCommandGate` /
//                      `checkNeedHumanGate`（本模块一行未改）；
//     · 唯一写路径   = `lib/state/store.js` 的 `setMember`（门禁 + 状态迁移 + 事件落盘同一次 atomicWrite）；
//     · 人工闸判据   = `checkNeedHumanGate`（声明 `needHuman: true` 的 lane 自动路同样被拒 ⇒ 转人工）。
//   即：`member_settle`（工具面）与本模块走的是**同一条**写路径，不存在第二套判定。
//   状态机约束：`MEMBER_TRANSITIONS`（`lib/schema.ts:23-32`）里 `running` 只能迁 `review` ⇒
//   「经 review 中转」是**状态机强制**，不是本模块发明的步骤。
//
// ── 链推进（P2 既有语义 · G-02 清退后）──────────────────────────────────────────
//   【已退役 · 2026-09-18】链推进全退役（Q-A=C）⇒ 本模块**不再调用** `advanceChainAfterSettle`
//   （原调用点与 import 随批次 `engine-debt-cleanup-2-20260918` 一并删除，勿回加）；原 GAP-S12 降级口径
//   （`noDispatch:true` + `exec=null` 走「只决策不派发」）**随之失效**——该降级路径由已退役的链推进承载，
//   现无消费者。停轮顺序不变 = 先落 `auto.settle.paused` 事件再 `setPhase('paused')`，
//   保证批次终态事件（`batch.phase`）最后落 ⇒ 审计面读到的「停轮原因」先于「停轮结果」。
//   `chain.step` 事件的冻结语义（冻结新增 + 兼容读）见 `lib/engine/chain-runner.js` 头注释。
//
// ── audit 层 lane 的**结算职责转移**（(b) 定案 · 债清 3 · 2026-09-19）────────────────
//   分叉（债清 2 实测命中）：审计产物写 `verdict: fail`，而本模块**不分层**地把 lane 自动推到 `merged`；
//   完成门的结局函数 `outcomeOf`（`lib/state/gates.ts:1220`）**纯由终态推导**（`merged ⇒ 'pass'`）
//   ⇒ 完成门把「审计判失败」读成 pass（`acceptance-report.md` 与蓝图 L1138/L1211 各记一次）。
//   定案 = **保持「lane 终态 = 唯一真源」**（禁第二真源）：
//     · 本模块**不对 audit 层 lane 结算**——早退分支只读 `wavePlan` 的静态 `layer` 字段，
//       **不读任何产物正文**（与蓝图 L768/L1138「complete 门读成员态、不解析报告正文」逐字一致）；
//     · 失败必须由 Leader 显式 `member_settle(lane,'failed', note)` 落 —— 「review→failed 必须带非空 note」
//       由既有写路径（`lib/state/store.js:569-577`）强制，本模块零改动即已满足；
//     · 早退**不落 `paused`**（不是失败，是**职责转移**）⇒ 不推批次相位，批保持 `running`，Leader 可继续结算；
//     · 该留痕**不进幂等链**（见 `isAuditSettleDeferral`）⇒ 每次触发各留一次痕、**绝不**判 `already-settled`。
//   **不改**：`DEFAULT_ON_FAIL`、`SETTLEABLE_STOP_REASONS`、两路触发、幂等键、`gates.ts` 的 `outcomeOf`。
//
// ── 边界（登记，不静默）─────────────────────────────────────────────────────────
//   · `subagent/end` 是**进程级广播**：会夹带一切非本套件派发的子会话 ⇒ 必须经
//     `info.id` → dispatchIndex 映射；**未命中即静默丢弃**（零事件零状态变化，见 A5 判据）。
//   · 触发资格：命中 lane 须**非终态**（`isMemberTerminal` 单点判据，不另立）；lane 已终态 ⇒
//     `auto.settle.skipped`（`reason:'lane-terminal'`）+ `settleId` 满足则 `already-settled`。
//   · `onFail` 配置键**本轮只落缺省 `pause`**：`review` / `failed` 两个枚举值留给后续批
//     （未发明资产键、未落未实现分支——见 `DEFAULT_ON_FAIL`）。
//   · 监听器全程 `try/catch` 且**不抛**（契约卡约束 6）：宿主对每 listener 独立 containment，
//     但插件侧异常会污染自身状态面。
import { isMemberTerminal } from '../schema.js';
import { laneBindingOf } from './dispatch.js';
import {
  EVT_AUTO_SETTLE_TRIGGERED, EVT_AUTO_SETTLE_PAUSED, EVT_AUTO_SETTLE_SKIPPED,
} from '../state/event-types.js';
// 层判定单点（**不新造第二套遍历**）：`findTask` 即「按 id 在 `batch.wavePlan[].tasks` 里定位任务」的
// 唯一实现（`lib/state/task-utils.js`，零依赖）；本模块只读它的 `layer` 字段。
import { findTask } from '../state/task-utils.js';

/** 主路宿主事件名（契约卡 #2：`ctx.on('subagent/end', info)`；`{global:true}` 见 `installAutoSettle`）。 */
export const AUTO_SETTLE_SUBAGENT_END = 'subagent/end';

/** 触发来源（载荷 `trigger`，读端据此分辨主路 / 兼底路）。 */
export const AUTO_SETTLE_TRIGGERS = Object.freeze({ subagentEnd: 'subagent/end', settleRequest: 'settle-request' });

/** 可结算的 `stopReason` 白名单（契约卡 #5 取值域：completed / aborted / error / max-tokens / refusal）。
 *  只放行 `completed`；未知值一律**保守不结算**（fail-safe：宁可漏结算也不谎报成功）。 */
const SETTLEABLE_STOP_REASONS = Object.freeze(['completed']);

/** 失败处置缺省值（规格 §3 末行：`onFail: pause｜review｜failed`，**缺省 `pause`** = 停轮上报）。
 *  本轮只实现缺省值；`review` / `failed` 为后续项（未落未实现分支）。 */
export const DEFAULT_ON_FAIL = 'pause';

/** 【2026-09-26 用户裁决 · 落地 `onFail` 的第二态】判定失败处置的**实现态枚举**（承上方 §3 规划）：
 *  · `pause`（= `DEFAULT_ON_FAIL`）＝ 落 `auto.settle.paused` + `batch.phase=paused`（**停轮**，等人工介入）；
 *  · `report` ＝ **不落 paused、不改相位**，把 gate 拒因**原样回传调用方** ⇒ 调用方 `throw` ⇒
 *    **工具调用失败打回成员**，成员自行修改后重试（批保持 `running`，**不停轮、不需 Leader 介入**）。
 *  取向：**可归因的形态错误（`GATE_*`）打回生产者；不可归因的失败（`error` / `no-lane-binding`）仍走 `pause`**。
 *  ⚠ 规格 §3 提到的 `review` / `failed` 两态**仍未实现**（本次只落 `report`）。 */
export const AUTO_SETTLE_ON_FAIL = Object.freeze({ pause: DEFAULT_ON_FAIL, report: 'report' });

/** audit 层 lane 的**结算职责转移**码（(b) 定案）：本模块遇到 audit 层 lane 时的 `auto.settle.skipped.reason`。
 *  **沿用既有事件类型**（`auto.settle.skipped`），与 `phase-*` / `lane-terminal` / `already-settled` 同列
 *  ⇒ **不新增事件常量**、不新增 `GATE_*` 拒绝码（拒面仍由 `GATE_SETTLE_NOTE_MISSING` /
 *  `GATE_COMPLETE_AUDIT_FAILED` 承担）。指引附录 A 的登记条目见本批 exec 产物「待 Leader 收进指引」段。 */
export const AUDIT_SETTLE_DEFERRAL_REASON = 'audit-explicit-settle-required';

/** audit 层 lane 判定（单点）：lane 的层取 `batch.wavePlan[].tasks` 中 `id === lane` 的 `layer` 字段
 *  （经 `findTask` 单点，**不新造第二套遍历**；同款读法见 `lib/tools/core.js:712`）。
 *  **缺失 / 非法层 ⇒ 不作为 audit**（保守：仍走既有全自动路，零行为变化）——层是 `wavePlan` 的静态声明，
 *  不读任何产物正文。 */
export function isAuditLayerLane(batch, lane) {
  return findTask(batch, lane)?.layer === 'audit';
}

/** 「audit 层结算职责转移」留痕判定（单点）：`auto.settle.skipped` 且 `reason` = `AUDIT_SETTLE_DEFERRAL_REASON`。
 *  **不进幂等链**（与 `isPhaseGateSkip` 同族）：该留痕是「本 lane 的结算职责不在引擎」的**持久策略事实**，
 *  不是「已结算/已判重」的事实——若计入幂等，Leader 显式结算前的每次触发都会被判成 `already-settled`
 *  而**再也不留痕**（职责转移的可见性被幂等键吞掉）。故每次触发各留一次痕。 */
function isAuditSettleDeferral(e) {
  return e?.type === EVT_AUTO_SETTLE_SKIPPED && e?.reason === AUDIT_SETTLE_DEFERRAL_REASON;
}

/** 瞬时/非幂等留痕的**统一排除面**（单点）：相位闸留痕 + audit 职责转移留痕。
 *  两族语义不同（前者「本拍相位不对」，后者「本 lane 的结算职责不在引擎」），但**幂等口径相同**
 *  ⇒ 在此合流，避免两处各自维护「哪些 skipped 不算判重」而漂移。 */
function isTransientSkip(e) {
  return isPhaseGateSkip(e) || isAuditSettleDeferral(e);
}

/** 幂等键归一：`(batchId, lane, 子会话 id)` 的第三元（缺 id 时**不得**伪造键 ⇒ 返回 null，调用方拒）。 */
export function settleIdOf(workerSessionId) {
  return typeof workerSessionId === 'string' && workerSessionId.length > 0 ? workerSessionId : null;
}

/** 幂等判据（纯函数，跨重启幂等）：批次事件流里已存在同 `(lane, settleId)` 的自动结算留痕。
 *  查**两条**留痕面：`auto.settle.triggered`（已触发过）与 `auto.settle.skipped`（已判过重复）——
 *  后者纳入使「同一 lane 反复重放」不再逐次追加事件（零噪音 + 幂等自证）。
 *  **瞬时/非幂等留痕除外**（`isTransientSkip` 单点，两族）：
 *    · 相位闸留痕（GAP-S10）：`reason` 前缀 `phase-` 是「本拍相位不对」的**瞬时**事实，不是「已结算」的持久事实
 *      ——若把它计入幂等，`resume` 后同一 lane 的首次真实触发会被判成 `already-settled` 而**永远结算不了**
 *      （恢复入口被相位闸毒化）⇒ 该族**不进**幂等链；
 *    · audit 职责转移留痕（(b) 定案）：`reason` = `audit-explicit-settle-required` 是「结算职责不在引擎」的
 *      **持久策略**事实，同样不是「已结算/已判重」⇒ 计入会让 Leader 结算前的每次触发都被判 `already-settled`
 *      而**不再留痕**（职责转移的可见性被吞）⇒ 该族同样**不进**幂等链。 */
export function hasAutoSettleRecord(batch, lane, settleId) {
  const events = Array.isArray(batch?.events) ? batch.events : [];
  for (const e of events) {
    if (!e || (e.type !== EVT_AUTO_SETTLE_TRIGGERED && e.type !== EVT_AUTO_SETTLE_SKIPPED)) continue;
    if (e.lane !== lane) continue;
    if (isTransientSkip(e)) continue;
    const key = settleIdOf(e.settleId ?? e.workerSessionId ?? null);
    if (settleId !== null && key === settleId) return true;
  }
  return false;
}

/** 相位闸留痕判定（单点）：`auto.settle.skipped` 且 `reason` 为 `phase-*`。 */
function isPhaseGateSkip(e) {
  return e?.type === EVT_AUTO_SETTLE_SKIPPED && typeof e.reason === 'string' && e.reason.startsWith('phase-');
}

/** ⚠ **已移除（2026-09-24）**：`hasSkipRecord(batch, lane, settleId)` —— 它唯一的调用点是**幂等闸的
 *  「already-settled 只落一次」**；该留痕已按用户裁决**关闭**（纯噪音，见 `autoSettleLane` 幂等闸注释），
 *  函数随之成为死代码 ⇒ 删除（不保留未用导出）。其余三处 `auto.settle.skipped`（`lane-terminal` /
 *  `phase-*` / audit 职责转移）仍走各自的落点，与 `hasSkipRecord` 无关（它们本就不进幂等链）。 */

/** 进程内并发闸（与持久幂等键互补，不替代）：同一 (session, batch, lane, settleId) 的判定段**同步执行**
 *  （本模块在首个 `await` 之前完成「读批 → 追加留痕事件 → setMember 落盘」），故同时到达的两路必然串行：
 *  先到者已落 `auto.settle.triggered`（持久留痕）⇒ 后到者经 `hasAutoSettleRecord` 判重。 */
const inFlight = new Set();
const flightKeyOf = (sessionId, batchId, lane, settleId) => String(sessionId) + '\u0000' + String(batchId) + '\u0000' + String(lane) + '\u0000' + String(settleId);

/** 停轮（缺省 `onFail=pause`）：写 `auto.settle.paused`（带 reason）+ 批 `running→paused`。
 *  **不写 failed、不 abort、不改成员状态**；批次非 `running` 时**不重复推进**（幂等，`startPhase` 已读）。
 *  顺序：事件先落、相位后落（读端先见原因、后见结果；批次终态事件保持最后）。 */
function pauseForFail(store, sessionId, batchId, { lane, reason, code, trigger, settleId, workerSessionId, startPhase }) {
  const listed = startPhase !== 'running';
  if (!listed) {
    store.appendEvent(sessionId, batchId, EVT_AUTO_SETTLE_PAUSED, {
      lane, action: DEFAULT_ON_FAIL, reason, code: code ?? null, trigger, settleId, workerSessionId: workerSessionId ?? null,
    });
    try {
      store.setPhase(sessionId, batchId, 'paused', { reason: 'auto-settle:' + (reason ?? 'unspecified') });
    } catch {
      // 相位写失败不抛（观察者纪律）：停轮留痕已落盘，相位由人工 `batch_control`/`batch_phase` 处置
    }
  }
  return { written: !listed };
}

/**
 * 判定器**单点**（两路共用；规格 §2「双路必须合并到同一判定函数」）。
 *
 * 同步段（首个 `await` 之前）内完成：① 读批 + 幂等判重；② 触发资格（lane 非终态）；
 * ③ 追加 `auto.settle.triggered`；④ 若可结算则 `running→review` + `review→merged`（复用既有门禁写路径）。
 * 【G-02 清退后】原「之后才 `await advanceChainAfterSettle`（P2 既有链推进；无 `chain` ⇒ no-op）」
 * 随链推进全退役一并删除（2026-09-18 Q-A=C）⇒ 本判定器**不再触发任何链推进**。
 *
 * @returns {Promise<{ok:boolean, action:string, reason:string|null, lane:string, status:string|null, code?:string|null}>}
 *   action ∈ merged | paused | skipped | unbound | no-batch | no-lane | error | recorded（已留痕但不可结算）
 *   `action:'skipped'` 的 `reason` 取值：`lane-terminal` | `already-settled` | `phase-<相位>` |
 *   `audit-explicit-settle-required`（(b) 定案：audit 层 lane 的结算职责归 Leader）| `in-flight`。
 *   **不抛错**（观察者纪律；异常隔离为 `{ok:false, action:'error'}`）。
 */
export async function autoSettleLane({ ctx, store, root, liveConfig } = {}, {
  onFail = AUTO_SETTLE_ON_FAIL.pause,
  sessionId, batchId, lane, workerSessionId = null, stopReason = null, trigger,
} = {}) {
  const out = { ok: true, action: 'none', reason: null, lane: lane ?? null, status: null };
  if (!store || !sessionId || !batchId || !lane) { out.ok = false; out.action = 'error'; out.reason = 'missing-params'; return out; }
  const settleId = settleIdOf(workerSessionId);
  const flight = settleId ? flightKeyOf(sessionId, batchId, lane, settleId) : null;
  let finish = false;
  try {
    if (flight) {
      if (inFlight.has(flight)) { out.action = 'skipped'; out.reason = 'in-flight'; return out; }
      inFlight.add(flight);
      finish = true;
    }
    const batch = store.readBatch(sessionId, batchId);
    if (!batch) { out.ok = false; out.action = 'error'; out.reason = 'no-batch'; return out; }
    if (!(lane in (batch.lanes ?? {}))) { out.ok = false; out.action = 'error'; out.reason = 'no-lane'; return out; }
    // 幂等去重（跨重启）：同 (lane, id) 已有留痕 ⇒ 第二路 no-op。
    // 判据只读批次 JSON（唯一持久事实源）；**首见**同一 (lane, id) 的重复**落一条 skipped 留痕**
    // （「被跳过」可审计，不是静默丢弃）——但**只落一次**：重复超过两次时零新增（幂等自证）。
    if (settleId && hasAutoSettleRecord(batch, lane, settleId)) {
      // 【2026-09-24 用户裁决：关闭 skipped（仅幂等闸这一路）】本闸**不再落事件** —— 它是**纯噪音**：
      //   兼底路（worker 主动 `settle-request`）抢先结算后，主路（宿主 `subagent/end`，实测晚 **60–63 s**）
      //   到达必命中本闸 ⇒ **每个 lane 正常结算都会额外产出一条 `already-settled`**，稀释信噪比。
      //   幂等语义**逐字不变**（仍跳过、不改状态、不重复推进）；只是不再往事件流写这条。
      //   ⚠ 其余三处 `auto.settle.skipped` **保留**（`lane-terminal` / `phase-*` / audit 职责转移）：
      //     它们是**异常路径**的诊断留痕（回答「为何不结算」），非每-lane 必产。
      out.action = 'skipped'; out.reason = 'already-settled';
      return out;
    }
    // 触发资格：命中 lane 须非终态（单点判据，不另立一套）
    const from = batch.lanes[lane];
    if (isMemberTerminal(from)) {
      if (settleId) store.appendEvent(sessionId, batchId, EVT_AUTO_SETTLE_SKIPPED, { lane, reason: 'lane-terminal', settleId, trigger });
      out.action = 'skipped'; out.reason = 'lane-terminal'; out.status = from;
      return out;
    }
    // ── GAP-S10：**批次相位闸**（与链推进侧同构；`lib/engine/chain-runner.js:111-118` 仅 `running` 相位推进）──
    //   规格 §4/§6：停轮（`paused`）＝人工介入 ⇒ **停止自动推进**，A恢复的唯一入口是 `batch_control(resume)`
    //   （`paused → running`）。缺此闸时，`pause` 会被本路（宿主 `subagent/end` 或兼底 `settle-request`）的
    //   下一次触发**静默推翻**——`store.setMember` 照跑、lane 被结算掉，停轮形同虚设。
    //   语义边界：**只拦「相位不对」，不拦正常结算**——`running` 相位行为逐字不变（闸在 `running` 上恒不命中）；
    //   `planning`（建批后未开跑）/`paused`（停轮）/`aborted`（收口，终态）三相位一律不结算。
    //   留痕：复用既有 `auto.settle.skipped`，`reason` 取 `phase-<相位>`（自证，不写笼统 `skipped`）；
    //   该留痕**不进幂等链**（见 `isPhaseGateSkip`）⇒ `resume` 后同一 lane 再触发能正常结算。
    if (batch.phase !== 'running') {
      store.appendEvent(sessionId, batchId, EVT_AUTO_SETTLE_SKIPPED, {
        lane, reason: 'phase-' + batch.phase, phase: batch.phase, settleId, trigger,
      });
      out.action = 'skipped'; out.reason = 'phase-' + batch.phase; out.status = from;
      return out;
    }
    // ── (b) 定案·分叉修复：**audit 层 lane 不走本路自动 `merged`**（职责转移，不是失败）──────────────
    //   为什么在此处（判定段入口、`auto.settle.triggered` **之前**）：职责转移是**策略判定**，
    //   不进「触发/判定」留痕面 ⇒ 事件流只多一条 `auto.settle.skipped`，**无** `auto.settle.triggered`
    //   （读端据此一眼分辨「没走到判定」与「判定后停轮」）。
    //   判据单点 = `isAuditLayerLane`（只读 `wavePlan` 静态 `layer`，**不读产物正文**）；层缺失/非法**不作为 audit**
    //   ⇒ 非 audit 层与旧批逐字同路（零行为变化）。
    //   不落 `paused`、不改相位、不改成员态：批保持 `running` 供 Leader 显式结算（`failed` 须带非空 note）。
    if (isAuditLayerLane(batch, lane)) {
      store.appendEvent(sessionId, batchId, EVT_AUTO_SETTLE_SKIPPED, {
        lane, reason: AUDIT_SETTLE_DEFERRAL_REASON, settleId, trigger,
      });
      out.action = 'skipped'; out.reason = AUDIT_SETTLE_DEFERRAL_REASON; out.status = from;
      return out;
    }
    // 非可结算 `stopReason`（含未知枚举）：**留痕但不结算**（不静默丢、不谎报成功）
    const settleable = stopReason === null || SETTLEABLE_STOP_REASONS.includes(stopReason);
    store.appendEvent(sessionId, batchId, EVT_AUTO_SETTLE_TRIGGERED, {
      lane, trigger, settleId, workerSessionId, stopReason, settleable, from,
    });
    if (!settleable) {
      out.action = 'recorded'; out.reason = 'stop-reason-not-settleable'; out.status = from;
      return out;
    }
    // ── 判定链（复用既有写路径；**零复制**）：running → review → merged ──
    // 判据不满足时 `store.setMember` 抛（GATE_* + 已把门禁留痕事件 atomicWrite），此处捕获 ⇒ 停轮。
    let gateCode = null;
    try {
      if (batch.lanes[lane] === 'running') store.setMember(sessionId, batchId, lane, 'review');
      store.setMember(sessionId, batchId, lane, 'merged');
    } catch (e) {
      const msg = String(e?.message ?? e);
      gateCode = (/^[A-Z][A-Z0-9_]+/.exec(msg) ?? [null])[0];
      // 【2026-09-26 用户裁决】onFail 二态：
      //   · 'pause'（缺省，存量行为逐字不变）：落 auto.settle.paused + batch.phase=paused（停轮，等人工）
      //   · 'report'（兼底路 settle-request 用）：**不落 paused、不改相位**，把 gate 拒因**回传调用方**
      //     ⇒ 调用方（工具 execute）据此 throw ⇒ **工具调用失败打回成员**，成员自行修改后重试。
      //     设计意图：可归因的形态错误（GATE_*）应打回生产者；不可归因的失败（error 等）仍走 pause。
      if (onFail === AUTO_SETTLE_ON_FAIL.report) {
        store.appendEvent(sessionId, batchId, EVT_AUTO_SETTLE_SKIPPED, {
          lane, reason: 'gate-rejected-to-member: ' + msg, code: gateCode, trigger, settleId, workerSessionId, status: from,
        });
        out.ok = false; out.action = 'rejected'; out.reason = msg; out.code = gateCode;
        out.status = (store.readBatch(sessionId, batchId)?.lanes ?? {})[lane] ?? null;
        return out;
      }
      const p = pauseForFail(store, sessionId, batchId, {
        lane, reason: msg, code: gateCode, trigger, settleId, workerSessionId, startPhase: batch.phase,
      });
      out.ok = false; out.action = 'paused'; out.reason = msg; out.code = gateCode;
      out.status = (store.readBatch(sessionId, batchId)?.lanes ?? {})[lane] ?? null;
      out.pausedWritten = p.written;
      return out;
    }
    const after = store.readBatch(sessionId, batchId);
    out.action = 'merged'; out.status = after?.lanes?.[lane] ?? null;
  } catch (e) {
    out.ok = false; out.action = 'error'; out.reason = String(e?.message ?? e);
    try { ctx?.logger?.warn?.('[dsh-punky-swarm] auto-settle failed (isolated): ' + out.reason); } catch { /* 隔离 */ }
    return out;
  } finally {
    if (finish && flight) inFlight.delete(flight);
  }
  // 【G-02 死调用清退 · 2026-09-18】原此处 try/catch 调 `advanceChainAfterSettle`（`noDispatch:true` +
  //   `exec=null` 的 GAP-S12 降级路）。链推进已全退役（Q-A=C）⇒ 该调用**零行为**且降级参数无人消费，
  //   故整块（含 import）随批次 `engine-debt-cleanup-2-20260918` 删除，勿回加。
  //   推进缺口（handoff 成功触发自动推进）与 `chain.step` 冻结语义见 `lib/engine/chain-runner.js` 头注释。
  return out;
}

/** 兼底路入口（`swarm_report(type='settle-request')` 调用面）：
 *  身份反查 = `laneBindingOf(store, workerSessionId)`（判据 = `member.dispatch` 事件，与
 *  `swarm_report`/`swarm_cc` 同一单点）⇒ 命中后走**同一个** `autoSettleLane`；未绑定 ⇒ 明确拒（不猜、不静默）。 */
export async function requestAutoSettle(deps = {}, { workerSessionId, trigger = AUTO_SETTLE_TRIGGERS.settleRequest, stopReason = null } = {}) {
  const { store } = deps;
  const bind = store ? laneBindingOf(store, workerSessionId) : null;
  if (!bind) return { ok: false, action: 'unbound', reason: 'no-lane-binding', lane: null, status: null };
  return autoSettleLane(deps, {
    sessionId: bind.sessionId, batchId: bind.batchId, lane: bind.lane, workerSessionId, stopReason, trigger,
  });
}

/** 主路回调（`subagent/end`）：payload → lane 归属 → 单点判定。**全程 try/catch 且不抛**。 */
async function onSubagentEnd(info, { store, dispatchIndex, ctx, root, liveConfig }) {
  try {
    if (!info || typeof info !== 'object') return;
    const id = info.id;
    if (typeof id !== 'string' || id.length === 0) return; // 无 durable 子会话 id ⇒ 静默丢弃
    let hit = dispatchIndex instanceof Map ? dispatchIndex.get(id) : null;
    if (!hit && store && typeof store.listAllBatches === 'function') {
      // 映射 miss 的惰性重建（对齐 `lib/index.js` 的 refusal 桥接口径：登记后无需重启即生效）
      try {
        for (const { sessionId, batchId } of store.listAllBatches()) {
          const b = store.readBatch(sessionId, batchId);
          for (const ev of b?.events ?? []) {
            if (ev?.type === 'member.dispatch' && ev.workerSessionId === id && ev.lane) {
              hit = { sessionId, batchId, lane: ev.lane };
              if (dispatchIndex instanceof Map) dispatchIndex.set(id, hit);
              break;
            }
          }
          if (hit) break;
        }
      } catch { /* 重建失败 ⇒ 仍按未命中处理（静默丢弃） */ }
    }
    if (!hit || !hit.sessionId || !hit.batchId || !hit.lane) return; // 非本套件派发的子会话 ⇒ 静默丢弃
    await autoSettleLane({ ctx, store, root, liveConfig }, {
      sessionId: hit.sessionId, batchId: hit.batchId, lane: hit.lane,
      workerSessionId: id, stopReason: info.stopReason ?? null, trigger: AUTO_SETTLE_TRIGGERS.subagentEnd,
    });
  } catch (e) {
    try { ctx?.logger?.warn?.('[dsh-punky-swarm] auto-settle subagent/end handler failed (isolated): ' + String(e?.message ?? e)); } catch { /* 隔离 */ }
  }
}

/**
 * 装配置点（`lib/index.js` 调用一次）：
 *   `ctx.on('subagent/end', onChildEnd, { global: true })`——**`{ global: true }` 为硬性要求**
 *   （契约卡 #8/#9：被 scope 化的插件 ctx 默认监听漏收；`global` 短路一切 scope 过滤）。
 *   返回 `{ installed, reason?, count(), dispose() }`；`ctx.on` 缺失 ⇒ inert 静默降级（宿主能力缺失不炸）。
 *   `count()` = **监听调用次数**（每次事件都进回调；命中与否由 `dispatchIndex` 过滤，未命中零写入）。 */
export function installAutoSettle(ctx, deps = {}) {
  const { store, dispatchIndex, root, liveConfig, logger = ctx?.logger } = deps;
  const inert = (reason) => ({ installed: false, reason, count: () => 0, dispose() {} });
  if (!store || typeof ctx?.on !== 'function') return inert('ctx.on unavailable or store missing');
  let hits = 0;
  const handler = (info) => {
    hits++;
    // 不 await：宿主对 listener 的 containment 不覆盖异步悬空 ⇒ 自行 catch（handler 内已包 try/catch）
    return onSubagentEnd(info, { store, dispatchIndex, ctx, root, liveConfig }).catch((e) => {
      try { logger?.warn?.('[dsh-punky-swarm] auto-settle handler rejected (isolated): ' + String(e?.message ?? e)); } catch { /* 隔离 */ }
    });
  };
  const dispose = ctx.on(AUTO_SETTLE_SUBAGENT_END, handler, { global: true });
  return {
    installed: true,
    count: () => hits,
    dispose() { try { if (typeof dispose === 'function') dispose(); } catch { /* 幂等 */ } },
  };
}
