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

// 心跳**活动判定与内存条目**档（stalled 档的判据来源）
//   （【2026-10-02 · 内务批 波 2】随 `createLaneHeartbeat` 巨型函数拆分下沉，代码逐字搬移）：
//   内存条目生命周期（freshEntry/resetEntry）、四信号活动判定、基线对齐、pending 追问探测、
//   追问文案、stalled 标记、longrun 的 lastActivityAt 取数、批次条目推进。全部只读 `cx`（无新状态）。
import { statSync } from 'node:fs';
import * as EVT from '../../state/event-types.js';
import { findTask } from '../../state/task-utils.js';
import { resolveArtifact, mailboxRootOf, progressSnapshotTsOf, laneKeyOf } from './context.js';

export function freshEntry(nowTs) {
  return {
    lastActivityAt: nowTs,
    lastSeenTs: nowTs,
    lastProbeAt: nowTs, // 新派发 lane 先给 base 档宽限，不立即追问（重派 running 计时重置语义）
    missedCount: 0,
    stalled: false,
    pendingProbeId: null,
    consumeObs: null, // U-4 派发后可解析性观测台账（BR-2 证据来源；**不得**静默丢弃，见 tick 保留语义）
    stintRunningSinceTs: null, // 已登记的 stint 起点（重派检测用；跨态存活的 entry 靠它实现「重派即重置」）
  };
}
export function resetEntry(entry, nowTs) {
  entry.lastActivityAt = nowTs;
  entry.lastSeenTs = nowTs;
  entry.lastProbeAt = nowTs;
  entry.missedCount = 0;
  entry.stalled = false;
  entry.pendingProbeId = null;
  // consumeObs **不在 reset 内清空**：活动重置的是「无活动计时」，不是「派发后观测到的既定事实」——
  //   否则活跃 lane 每次重置都会丢掉 BR-2 的证据（证据一旦观测到即不可变）。
}

// ---- 活动判定（三信号任一，防「长任务无产出误判」）----
// ① batch.events：本 lane 可归因事件比上次扫描新（lane.stalled / lane.longrun.candidate 为引擎自写事件，
//    排除防自重置——写事件零侵入的既有 stalled 纪律扩面到 longrun 档）
//    **并排除「把本 lane 落到其当前态的那条迁移事件」**（`e.to === 当前 lane 态`，如重派的
//    `member.settled{to:'running'}`）：它是**计时重置**（新 stint 起算），不是「有人在干活」的活动信号。
//    不排除的后果：非终态扩面后 entry 不再被删/重建 ⇒ 首个 tick 窥见该事件即判 activity → `resetEntry`
//    并 `continue` → **重派后首拍恒不累计 missed**（W5 回归：期望 missed=1，实得 0）。
export function laneEventActivity(batch, lane, sinceTs, laneState = null) {
  const evs = batch.events ?? [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.type === EVT.EVT_LANE_STALLED || e.type === EVT.EVT_LANE_LONGRUN_CANDIDATE
      || e.type === EVT.EVT_LANE_BINDING_GAP) continue; // D2：绑定缺口同为**引擎自写**事件，须排除防自重置
    if (laneState !== null && e.to === laneState) continue; // 落到当前态的迁移事件 = 计时重置，不算活动
    if (e.lane === lane) {
      const ts = Date.parse(e.ts ?? '');
      if (Number.isFinite(ts) && ts > sinceTs) return true;
    }
  }
  return false;
}
// ② outbox：该 lane outbox 目录出现未 ack 消息
export function outboxActivity(cx, sessionId, batchId, lane) {
  try {
    return cx.mailbox.readUnacked(mailboxRootOf(cx, sessionId, batchId), { type: 'outbox', lane }).length > 0;
  } catch { return false; }
}
// ③ 产物 mtime：artifacts/<batchId>/ 下该 lane 声明产物（outputs/produce）mtime 变化
export function artifactActivity(cx, sessionId, batchId, batch, lane, sinceTs) {
  const t = findTask(batch, lane);
  const rels = [...(t?.outputs ?? []), ...(t?.produce ?? [])];
  for (const rel of rels) {
    try {
      if (statSync(resolveArtifact(cx, sessionId, batchId, rel)).mtimeMs > sinceTs) return true;
    } catch { /* 不存在/不可读 → 无活动 */ }
  }
  return false;
}
// ④ 磁盘进度快照 mtime（进度快照信号）——非 git 进度信号通道：
//    「worker 直写 <artifacts>/<batchId>/<lane>/progress/ 下快照、未调 lane_checkpoint
//    （禁 worktree 批恒 no-op）」的实测场景下，既有三信号全为 false → 对在跑 lane 误报 stalled/longrun。
//    **判据必须用新鲜度窗，不能只用「晚于基线」**：首次建 entry 时 baselineTs 已把 lastSeenTs 对齐到
//    快照 mtime（见下），此后 `m > lastSeenTs` 恒 false → 持续写快照的 lane 照样被判 stalled
//    （实测复现：tick1 missed=1 → tick2 missed=2 → tick3 stalled=true，即两次误报的真实路径）。
//    故本信号按「快照落入 noProgressWindowMs 窗内」判活跃——与 longrun 档的 checkpoint 新鲜度同口径；
//    参考下界取 min(lastSeenTs, nowTs - 窗)，使「窗内新写」与「窗内但早于基线」两种情形都算活跃。
//    停止写快照 → 超窗即回到原判据，stalled 照常触发（探针不被稀释）。
export function progressActivity(cx, sessionId, batchId, lane, sinceTs, nowTs, windowMs) {
  const m = progressSnapshotTsOf(cx, sessionId, batchId, lane);
  if (m === null) return false;
  const windowStart = nowTs - windowMs;
  const ref = Math.min(sinceTs, windowStart);
  return m > ref;
}
export function hasActivity(cx, sessionId, batchId, batch, lane, sinceTs, nowTs, laneState = null) {
  return laneEventActivity(batch, lane, sinceTs, laneState)
    || outboxActivity(cx, sessionId, batchId, lane)
    || artifactActivity(cx, sessionId, batchId, batch, lane, sinceTs)
    || progressActivity(cx, sessionId, batchId, lane, sinceTs, nowTs, cx.lrCfg.noProgressWindowMs);
}

// 首次追踪某 lane 时把 lastSeenTs 基线对齐到「已知信号最新时间」（本 lane 事件 ts / 声明产物 mtime /
// 磁盘进度快照 mtime 的最大值）。
// 防时钟偏移/测试注入时钟时把历史活动误判为新鲜活动（历史事件 ts > 冷启动 nowTs 时会被误判持续活动）
export function baselineTs(cx, sessionId, batchId, batch, lane, nowTs) {
  let t = nowTs;
  const evs = batch.events ?? [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.type === EVT.EVT_LANE_STALLED || e.type === EVT.EVT_LANE_LONGRUN_CANDIDATE
      || e.type === EVT.EVT_LANE_BINDING_GAP) continue; // D2：绑定缺口同为**引擎自写**事件，须排除防自重置
    if (e.lane === lane) {
      const ts = Date.parse(e.ts ?? '');
      if (Number.isFinite(ts) && ts > t) t = ts;
    }
  }
  const task = findTask(batch, lane);
  for (const rel of [...(task?.outputs ?? []), ...(task?.produce ?? [])]) {
    try {
      const m = statSync(resolveArtifact(cx, sessionId, batchId, rel)).mtimeMs;
      if (m > t) t = m;
    } catch { /* 不存在 → 忽略 */ }
  }
  const pm = progressSnapshotTsOf(cx, sessionId, batchId, lane);
  if (pm !== null && pm > t) t = pm;
  return t;
}

// 同 lane 至多 1 条 pending 追问（多拍合并语义：mailbox 无 replace → 读 inbox 未 ack 追问，存在则跳过）。
// 追问 ts 早于最近一次活动 → 视为已被活动满足的陈旧追问，不再当作未答拍（活动后 reset 语义）
export function pendingProbe(cx, sessionId, batchId, lane, sinceTs) {
  try {
    const items = cx.mailbox.readUnacked(mailboxRootOf(cx, sessionId, batchId), { type: 'inbox' });
    for (const it of items) {
      if (it.message?.kind !== 'probe' || it.message?.lane !== lane) continue;
      const ts = Date.parse(it.ts ?? '');
      if (Number.isFinite(ts) && ts < sinceTs) continue; // 陈旧追问：活动发生在它之后
      return it;
    }
    return null;
  } catch { return null; }
}

export function probeText(cx, lane, batchId, missed) {
  if (cx.cfg.probeTemplate) {
    return cx.cfg.probeTemplate
      .replaceAll('{lane}', lane)
      .replaceAll('{batchId}', batchId)
      .replaceAll('{missed}', String(missed));
  }
  // 轻量追问模板：≤5 句、含 lane 标识、不调工具、不复盘全部历史
  return [
    `Manager 心跳：lane「${lane}」（批次 ${batchId}）已连续 ${missed} 拍无活动信号。`,
    '请用 ≤3 句汇报当前进度或阻塞点（走 outbox）。',
    '不调工具、不复盘全部历史。',
    '本消息为自动追问，任何活动即重置计时。',
  ].join('\n');
}

export function markStalled(cx, sessionId, batchId, lane, entry, nowTs) {
  try {
    cx.store.appendEvent(sessionId, batchId, EVT.EVT_LANE_STALLED, { lane, missed: entry.missedCount });
  } catch { /* 批次已终态/不存在等 → 忽略（下轮不再扫） */ }
  entry.stalled = true;
  entry.lastSeenTs = nowTs; // 自写事件不触发自身重置
  entry.lastProbeAt = null;
}

// ---- longrun 档（超时重派探针）：----
// 与 stalled 档互不干扰：同一 tick 扫描、同一内存表；只读判定 + 候选产出（动作即止），不改 lane 状态、
// 不 interrupt、不重派（成员控制归 Leader）。判定前置于心跳扫描执行：内存 entry 尚为本 tick 前状态
// （无 fresh 宽限污染——引擎重启后内存空 → 以事件/产物基线兜底）。
// lastActivityAt 来源：state 内存 entry.lastActivityAt（含 outbox 未 ack 活动信号）；entry 缺失 → baselineTs 兜底。
// baselineTs 已并入磁盘进度快照 mtime（非 git 进度信号），故「worker 直写快照」的 lane
//   在 entry 缺失（引擎重启）时也不会被当成「零活动」。
export function longrunLastActivityAt(cx, sessionId, batchId, batch, lane) {
  const entry = cx.state.get(laneKeyOf(sessionId, batchId, lane));
  if (entry?.lastActivityAt != null) return entry.lastActivityAt;
  return baselineTs(cx, sessionId, batchId, batch, lane, 0); // 无内存条目 → 事件/产物/快照最新信号（无信号=0→非新鲜）
}

// 内存条目保留策略（design §1.2「必须删除的既有短路」）：
//   原 `dropBatchEntries(batch)`（整批 `state.delete`）与逐 lane `state.delete(laneKey)` 会**主动清除内存条目**
//   ⇒「非 running lane 不可见」+「终态批整批不可见」= 悬挂成员不可见的第二重成因。
//   现语义：**非终态 lane 的条目一律保留**（只读查询面恒可见）；批次转终态/planning 时也不删，
//   只把 lastSeenTs 推进到当前拍（解冻/恢复后不因陈旧基线瞬时判 stalled），**不追问、不产候选**。
//   唯一的 `state.delete` 落在 dispose()（显式销毁语义），不再存在任何静默丢态路径。
export function touchBatchEntries(cx, sessionId, batchId, batch, nowTs) {
  for (const lane of Object.keys(batch.lanes ?? {})) {
    const entry = cx.state.get(laneKeyOf(sessionId, batchId, lane));
    if (entry) entry.lastSeenTs = nowTs;
  }
}

// ── P1（phase 预筛）：预筛跳过批的**前缀式**条目推进 ────────────────────────────────────
// 为什么需要：phase 预筛命中（planning/complete/aborted）的批**不 parse** ⇒ 拿不到 `batch.lanes`，
//   故按 laneKey 前缀推进：entry key = `${sessionId}/${batchId}/${lane}`（`laneKeyOf` 单点），
//   前缀 = 前两段（sessionId / batchId 均不含 `/`：`SESSION_RE` 在 store 路径面已保证；lane 可含 `/`）。
// 等价性：原 `touchBatchEntries` 遍历 `batch.lanes` 逐个 `state.get(laneKeyOf(...))` 推进——
//   · 前缀命中的 entry 必属该批；
//   · 该批 lane 集合之外的陈旧 entry 原实现不碰，但**终态/planning 批的 entry 不参与任何判定**
//     （longrun 档与 stalled 档都整批跳过；唯一读端是只读查询面，其按 batch.lanes 取值）
//     ⇒ 推进与否无可观测差异。
// 索引一次建好（**不在每个预筛批上全表扫描**）：Map<`${sessionId}/${batchId}`, entry[]>。
export function batchEntryIndex(cx) {
  const index = new Map();
  for (const [key, entry] of cx.state) {
    const i1 = key.indexOf('/');
    if (i1 < 0) continue;
    const i2 = key.indexOf('/', i1 + 1);
    if (i2 < 0) continue;
    const prefix = key.slice(0, i2);
    const list = index.get(prefix);
    if (list) list.push(entry); else index.set(prefix, [entry]);
  }
  return index;
}
export function touchBatchEntriesByPrefix(index, nowTs, sessionId, batchId) {
  const list = index.get(sessionId + '/' + batchId);
  if (!list) return;
  for (const entry of list) entry.lastSeenTs = nowTs;
}
