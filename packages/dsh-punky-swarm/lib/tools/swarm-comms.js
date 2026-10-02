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

// 成员回报 / Leader 唤醒单点（自 `lib/tools/core.js` **原样搬移**，行为零变更）：目标解析 / 投递 / 事件留痕 / 唤醒节流。
//   导出面经 `lib/tools/core.js` re-export 保持（WAKE_MIN_INTERVAL_MS / LEADER_WAKE_WINDOWS / wakeLeaderForReport）。
import { laneBindingOf, mailboxRootOf } from '../engine/dispatch.js';
import * as swarmMailbox from '../comms/mailbox.js'; // 成员回报投递（文件 mailbox）

// ── 成员回报**目标解析**（身份门已删） ──────
// 背景（普查 `gate-census-20260917`（原文档未随仓分发） + 本轮实测）：官方 Team 成员由宿主 `spawn_teammate` 拉起，
//   **天然无 `member.dispatch` 绑定** ⇒ 「未绑定」是该场景的**常态**而非异常；原
// 现口径 = **不再拒**，改 best-effort 解析（不猜批次、不静默）：
//   ① 有 dispatch 绑定 ⇒ 既有路径逐字不变（owner 会话 + 绑定批次 + 绑定 lane）；
//   ② 无绑定 ⇒ 目标批次由调用方**显式** `batchId` 给出（可选参数，缺省即无批次面），归属会话取宿主父会话
//      （官方成员的 Leader 会话）→ 本会话兜底；`lane` 缺省 `(unbound)` 仅作展示占位。
// 消息**照发**（Leader / Manager 通道 mailbox 落盘；未绑定时批次键 `(unbound)`，读端仍可见文件）；
//   批次事件**仅在目标批次真实存在时**可写（无批次文件即无事件面）——失败不回滚、不抛、不静默：
//   回显 `eventWritten:false` + `notice`，使「消息已投递 / 事件未落」这一真实状态对调用方与审计都可见。
export const UNBOUND_BATCH_KEY = '(unbound)';
const UNBOUND_LANE_KEY = '(unbound)';

export function reportTargetOf(store, exec, args) {
  const caller = exec?.agent?.session?.id ?? null;
  const bind = laneBindingOf(store, caller);
  const declaredBatchId = typeof args?.batchId === 'string' && args.batchId.trim() ? args.batchId.trim() : null;
  const declaredLane = typeof args?.lane === 'string' && args.lane.trim() ? args.lane.trim() : null;
  if (bind) {
    return { caller, bound: true, sessionId: bind.sessionId, batchId: declaredBatchId ?? bind.batchId, lane: declaredLane ?? bind.lane };
  }
  return {
    caller, bound: false,
    sessionId: exec?.agent?.session?.header?.parentSession ?? caller,
    batchId: declaredBatchId,
    lane: declaredLane ?? UNBOUND_LANE_KEY,
  };
}

/** 投递成员消息（无 sessionId ⇒ 无处可投，回 false，绝不抛——Q-G2「不再因身份未绑定而拒」）。 */
export function deliverSwarmMessage(root, tgt, box, args, kind) {
  if (!tgt.sessionId) return false;
  swarmMailbox.send(mailboxRootOf(root, tgt.sessionId, tgt.batchId ?? UNBOUND_BATCH_KEY), { type: box },
    { lane: tgt.lane, kind, summary: args.summary, artifactPath: args.artifactPath ?? null, from: tgt.caller, unbound: !tgt.bound });
  return true;
}

/** 批次事件留痕（唯一写路径 = store.appendEvent）：批次不可解析/已损坏 ⇒ 回 false（消息已投递，事件面如实回显）。 */
export function appendSwarmEventOf(store, tgt, evtType, kind) {
  if (!tgt.batchId || !tgt.sessionId) return false;
  try {
    store.appendEvent(tgt.sessionId, tgt.batchId, evtType, { lane: tgt.lane, kind, unbound: !tgt.bound });
    return true;
  } catch {
    return false;
  }
}

// ── worker → Leader **唤醒**（`swarm_report` 兼底路直达；判据源 `plan/notify-spec.md`）──────
// 命题：`swarm_report` 在既有「留痕双写（mailbox + 批事件）」之上，**真正把 Leader 唤起来**——
//   用宿主自用原语 `Agent.followup(msg)`（`dsh-agent-loop/lib/index.js:800-814`，语义 =
//   `send(msg, 'next-turn', wake=true)`：idle ⇒ **同步**开新 turn；running ⇒ latch 进 next-turn 队列）。
//   口径澄清（承 S-2 裁认）：只有 `followup` 是「推送」；`inject()` wake=false **不唤醒**（J-7）。
// 硬边界（J-4）：本能力**只落 `swarm_report` 兼底路**；`subagent/end` 主路（`lib/engine/auto-settle.js`）
//   全文零变更——主路回调内 handle disposal 先于 emit，**不得**取子句柄（该文件 `:31-32` 的原口径）。
// 通道取舍（J-8）：**不用** `send_message` / `ctx.subagents.sendMessage`——one-shot lane worker 必抛
//   `UNAUTHORIZED`（`dsh-subagent/lib/index.js:1762-1775`）。
// 注入面取舍（J-6）：**不把 `agents` 加进插件 `inject`**（`lib/index.js:86`）——加硬 inject 会使本插件在
//   未挂官方 agent 服务的宿主上**失去加载能力**；故走 `ctx.get('agents')` **非注入读**（先例同文件
//   `:572` 的 `ctx.get('agentTeams')`：cordis「无 inject 要求，服务未提供即 undefined」）。
// 幂等 / 防自激 / 节流：见 `wakeLeaderForReport` 内注释（`self` 闸 + leading-edge 合并窗 + `merged` 计数）。
export const WAKE_TYPES = new Set(['blocked', 'settle-request']); // 触发集固定：progress 保持「留痕不打扰」
// 合并窗 = **30s**（leading-edge：窗内首报立即唤醒，其后只累加合并计数）。
//   依据（`plan/notify-spec.md` §3.2）：① 一次唤醒 = Leader 一整轮 LLM，波次密集收口下 N 报 N 轮不可接受；
//   ② 一个波次收口跨度为秒级 ⇒ 30s 覆盖「一波多报 ⇒ 1 次唤醒」；③ 唤醒次数 ≤ ⌈跨度/W⌉+1，**与报告条数解耦**（可判）。
// 不复用既有常量：`DEFAULT_DEBOUNCE_MS = 300`（hot/config-watch.js:45）与 `DEBOUNCE_MS = 300`（panel/stream.js:51）
//   是 **fs 事件防抖**，量级与语义均不同 ⇒ 本常量在此**唯一**定义一次（禁别处另写第二套节流口径）。
export const WAKE_MIN_INTERVAL_MS = 30_000;
// 窗状态：key = leaderSessionId + '\0' + batchId（同批同 Leader 共一窗，不同批互不影响）。
//   **进程内存态、不落盘**：进程重启 ⇒ 允许一次额外唤醒（可接受的松弛，已由规格显式登记）。
//   导出 = **测试专属注入缝**（与 `__resetLaneHandles` 同类）：exec-tests 的 G-4/G-5 需清窗/读窗，
//   生产代码**不得**依赖本导出（工具面唯一消费者 = 本文件内的 `wakeLeaderForReport` / `swarm_report.execute`）。
export const LEADER_WAKE_WINDOWS = new Map();

/** 取 Leader 句柄（**非注入读 + fail-safe**）：永不抛；返回值区分「服务缺失」与「取不到该会话」。 */
function leaderAgentOf(ctx, leaderSessionId) {
  let svc = null;
  try { svc = typeof ctx?.get === 'function' ? ctx.get('agents') : null; } catch { svc = null; }
  // 服务缺失（宿主未挂 dsh-agent）：语义上是**基线态**而非异常，与 managerRosterOf 的 `service-unavailable` 同码面。
  if (!svc || typeof svc.get !== 'function') return { service: false, agent: null };
  try { return { service: true, agent: svc.get(leaderSessionId) ?? null }; } catch { return { service: true, agent: null }; }
}

/** 唤醒消息（**零依赖手工构造**，形状 = `dsh-llm` `createUserMessage`；UUID 先例 `lib/governance/kernel.js:196`）。
 *  纪律（J-9）：**只传摘要元数据，零复制正文**——载体是调用方显式给出的 `type` / `summary` / `artifactPath`。 */
function leaderWakeMessageOf(input, merged) {
  const line = '[swarm] ' + (input.batchId ?? UNBOUND_BATCH_KEY) + '/' + (input.lane ?? UNBOUND_LANE_KEY)
    + ' ' + input.type + '：' + input.summary
    + (input.artifactPath ? '\n产物：' + input.artifactPath : '')
    + (merged > 0 ? '\n（另合并 ' + merged + ' 条同类回报）' : '');
  return {
    // id 不可省、不可复用：inbox 投影对 pending 消息做 id 去重，重复即抛
    //   `message "<id>" is already pending`（`dsh-agent-loop/lib/index.js:190-193`）——该抛会被本函数 catch 吞掉 ⇒ 静默丢唤醒。
    id: globalThis.crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: line }],
    source: { kind: 'user' },
  };
}

/**
 * 唤醒 Leader（**唯一唤醒动作 = `leader.followup(msg)`**）。
 * 契约：**永不抛**；返回值恒为 `{ attempted, woke, reason, merged }`；
 *   零批面写（不调 `store.appendEvent` / 不调 `swarm_report` / 不调 `deliverSwarmMessage`）⇒ 不构成新的唤醒触发源（零回环）。
 * `now` 仅作**测试注入**（默认 `Date.now()`）——生产路径不传。
 */
export function wakeLeaderForReport(ctx, input) {
  const out = { attempted: false, woke: false, reason: null, merged: 0 };
  try {
    // ① 防自激闸（可达构造见规格 §4.1）：`reportTargetOf` 的未绑定分支在 `session.header` 缺 `parentSession`
    //    时 `sessionId` **恰等于 caller 自身** ⇒ 无此闸即「worker 唤醒自己 ⇒ 自己再回报 ⇒ 自激」。
    const leaderSessionId = input?.leaderSessionId ?? null;
    if (!leaderSessionId) { out.reason = 'no-leader-session'; return out; }
    if (input?.callerSessionId && input.callerSessionId === leaderSessionId) { out.reason = 'self'; return out; }
    out.attempted = true;
    // ② 合并窗（leading-edge）：窗内 ⇒ 只累加计数、不唤醒（`woke=false`）。
    const key = leaderSessionId + '\0' + (input.batchId ?? '');
    const win = LEADER_WAKE_WINDOWS.get(key) ?? null;
    const now = typeof input.now === 'number' ? input.now : Date.now();
    if (win && now - win.at < WAKE_MIN_INTERVAL_MS) {
      win.merged += 1;
      out.reason = 'throttled';
      out.merged = win.merged;
      return out;
    }
    // ③ 取 Leader 句柄（服务缺失 / 取不到 ⇒ 降级回显，**不抛、不影响既有留痕面**）。
    const lookup = leaderAgentOf(ctx, leaderSessionId);
    if (!lookup.service) { out.reason = 'service-unavailable'; return out; }
    const leader = lookup.agent;
    if (!leader || typeof leader.followup !== 'function') { out.reason = 'leader-not-live'; return out; }
    // ④ 唤醒：上一次窗内被合并的条数随本次消息**可见**（合并不丢信息）并清零。
    const merged = win ? win.merged : 0;
    leader.followup(leaderWakeMessageOf(input, merged));
    LEADER_WAKE_WINDOWS.set(key, { at: now, merged: 0 });
    out.woke = true;
    out.reason = 'woke';
    out.merged = merged;
    return out;
  } catch (e) {
    // fail-safe（规格约束 3）：任何异常（含宿主抛错、UUID 不可用…）一律收敛为回显，**不得**外抛。
    out.woke = false;
    out.reason = 'error: ' + String(e?.message ?? e);
    return out;
  }
}