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

// lane-heartbeat：lane 过期检测引擎（能力补全 C1，watch 域，新建）
// 成熟模式：dsh-plugin-heartbeat 退避/硬停引擎（退避/硬停机制）
// 语义：running lane 无活动 → 退避档位追问（默认 10→20→30 分钟，冷场越久间隔越长）→
//       连续 N 拍（默认 3）无活动 → appendEvent('lane.stalled', {lane, missed})，停止追问。
//       只标记不自动处置（Manager/Leader 人审），不新增成员状态（stalled 用事件表达，不碰
//       schema.js MEMBER_STATES/MEMBER_TRANSITIONS——写事件零侵入，加状态要动 schema/测试/面板/complete gate）。
// 依赖注入：deps.store（readBatch/appendEvent/listSessions/listBatches/artifactsDirOf）
//                          deps.mailbox（comms/mailbox.js：send/readUnacked，追问投递与 pending 探测）
//                          deps.config（capabilities.watch：enabled/intervalsMinutes/maxMissed/scanIntervalMinutes/probeTemplate）
//                          deps.root（可选，mailbox 根；缺省由 store.sessionsDir 推导）
//                          deps.now（可选，时钟注入，测试用；缺省 Date.now）
// 本文件仅导出引擎与工具定义；lane_heartbeat 工具的组装（lane-tools.js/register.js）
// 组装进 lane-tools.js（避免与 lane-tools 主文件耦合）；本模块只动
// watch/ 新域 + index.js 挂载 + schema.js watch 配置键 + cordis.patch.yml 注释。
import { join, dirname } from 'node:path';
import { statSync } from 'node:fs';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveWatchConfig, WATCH_DEFAULTS } from '../schema.js';
import { sessionOf, TEXT_OUTPUT } from '../tools/shared.js'; // P2-01：watch 域不再 import tools/core（共享辅助下沉零依赖 shared.js）
import { isAbsPath } from '../state/constants.js'; // P1-07 单点（原 :77 内联正则收敛）
import { findTask } from '../state/task-utils.js'; // P1-04 单点（原 :69 本地定义删除）
// R-01/R-07 收敛：lane.stalled 事件字面量（发端 :188 + 读端 :101/:139）改引 EVT 常量单点
import * as EVT from '../state/event-types.js';

// 退避档位（分钟 → ms，单调化钳制）：档位单调不减，冷场越久追问间隔越长
export function buildSchedule(intervalsMinutes) {
  const src = Array.isArray(intervalsMinutes) && intervalsMinutes.length > 0
    ? intervalsMinutes
    : WATCH_DEFAULTS.intervalsMinutes;
  const list = src.map((m) => {
    const n = Number(m);
    return Number.isFinite(n) && n >= 0 ? n * 60_000 : 0;
  });
  for (let i = 1; i < list.length; i++) list[i] = Math.max(list[i], list[i - 1]);
  return list;
}

// ---- longrun 档（超时重派探针，与 stalled 档并列，design longrun-probe-design §1-§5）----
// 语义：running lane 持续超 maxDurationMs（默认 20min）且近 noProgressWindowMs（默认 5min）无新 checkpoint
//       且无活动（严格 AND）→ 探针产候选：appendEvent('lane.longrun.candidate') + mailbox broadcast 通知
//       Manager 裁决。动作即止：不改 lane 状态（同 stalled 纪律——写事件零侵入，不碰 schema.js）。
//       去重以批次事件流为唯一事实源：同 stint（lane + runningSince 相同）只产一次，跨重启幂等。
//       runningSince = 事件流最近 member.dispatch / member.settled{to:'running'}（取较新）；重派（新 running
//       stint）即更新 → 计时重置。checkpoint 最新 ts 从事件流 worktree.checkpoint 事件读（resume 契约同源）。
// 配置（用户定案修订：出厂默认开，非设计默认关）：capabilities.watch.longrun{enabled,maxDurationMs,noProgressWindowMs}
// resolve 独立实现于本模块（schema.js 红线不改；键根/非法回退风格对齐 resolveWatchConfig）。
export const LONGRUN_DEFAULTS = Object.freeze({
  enabled: true, // 出厂默认开（定案修订：半自动件默认开防漏检；显式 false 才关）
  maxDurationMs: 1_200_000, // 默认 20min（长跑超时阈值；正整数 ms，非法回退默认）
  noProgressWindowMs: 300_000, // 默认 5min（无进展窗；正整数 ms，非法回退默认）
});
export const LONGRUN_REASON = 'duration-exceeded-no-progress';
export function resolveLongrunConfig(config) {
  const c = config?.capabilities?.watch?.longrun ?? {};
  const posMs = (v) => (Number.isFinite(Number(v)) && Number(v) >= 1 ? Math.floor(Number(v)) : null);
  return {
    enabled: c.enabled !== false, // 缺省 = LONGRUN_DEFAULTS.enabled(true)，显式 false 才关（对齐 resolveWatchConfig P1-01 语义）
    maxDurationMs: posMs(c.maxDurationMs) ?? LONGRUN_DEFAULTS.maxDurationMs,
    noProgressWindowMs: posMs(c.noProgressWindowMs) ?? LONGRUN_DEFAULTS.noProgressWindowMs,
  };
}

// 纯事件流读取（零依赖批次对象）：runningSince（stint 起点）＝最近 member.dispatch 或 member.settled{to:'running'}
function parseEvTs(e) {
  const n = Date.parse(e?.ts ?? '');
  return Number.isFinite(n) ? n : null;
}
export function stintRunningSinceOf(batch, lane) {
  const evs = batch?.events ?? [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e?.lane !== lane) continue;
    if (e.type === EVT.EVT_MEMBER_DISPATCH) return parseEvTs(e);
    if (e.type === EVT.EVT_MEMBER_SETTLED && e.to === 'running') return parseEvTs(e);
  }
  return null;
}
export function lastCheckpointTsOf(batch, lane) {
  const evs = batch?.events ?? [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e?.type === EVT.EVT_WORKTREE_CHECKPOINT && e?.lane === lane) return parseEvTs(e);
  }
  return null;
}
export function hasLongrunCandidate(batch, lane, runningSinceMs) {
  if (runningSinceMs == null) return false;
  return (batch?.events ?? []).some((e) => {
    if (e?.type !== EVT.EVT_LANE_LONGRUN_CANDIDATE || e?.lane !== lane) return false;
    const ms = Date.parse(e?.runningSince ?? '');
    return Number.isFinite(ms) && ms === runningSinceMs;
  });
}
// judgeLongrun 纯函数（判定要素全部取自批次事件流 + 心跳内存 lastActivityAt，不调 git、不改状态）：
// candidate = laneState==='running' ∧ batch.phase==='running' ∧ durationMs>maxDurationMs（严格 >）
//             ∧ !checkpointFresh ∧ !activityFresh（checkpoint/activity 窗均严格 <）
// 载荷携带原始 fresh 值供 Manager 复核（若后续需改 OR 语义，纯函数单点即可）。
export function judgeLongrun({
  batch, lane, nowTs,
  maxDurationMs = LONGRUN_DEFAULTS.maxDurationMs,
  noProgressWindowMs = LONGRUN_DEFAULTS.noProgressWindowMs,
  lastActivityAtMs = null, // 心跳内存最近活动（ms）；引擎重启后为空 → 引擎侧以 baselineTs 兜底传入
}) {
  const laneState = batch?.lanes?.[lane];
  const batchPhase = batch?.phase;
  const base = {
    lane, laneState, phase: batchPhase,
    maxDurationMs, noProgressWindowMs,
    runningSince: null, runningSinceTs: null, durationMs: null,
    lastCheckpointTs: null, checkpointFresh: false,
    lastActivityAt: null, activityFresh: false,
    candidate: false, reason: null,
  };
  if (laneState !== 'running') return { ...base, reason: 'lane-not-running' };
  if (batchPhase !== 'running') return { ...base, reason: 'batch-not-running' };
  const runningSinceTs = stintRunningSinceOf(batch, lane);
  if (runningSinceTs === null) return { ...base, reason: 'no-running-since' };
  const durationMs = nowTs - runningSinceTs;
  const lastCheckpointTs = lastCheckpointTsOf(batch, lane);
  const checkpointFresh = lastCheckpointTs !== null && (nowTs - lastCheckpointTs) < noProgressWindowMs;
  const activityFresh = lastActivityAtMs !== null && (nowTs - lastActivityAtMs) < noProgressWindowMs;
  const out = {
    ...base,
    runningSince: new Date(runningSinceTs).toISOString(),
    runningSinceTs,
    durationMs,
    lastCheckpointTs: lastCheckpointTs === null ? null : new Date(lastCheckpointTs).toISOString(),
    checkpointFresh,
    lastActivityAt: lastActivityAtMs === null ? null : new Date(lastActivityAtMs).toISOString(),
    activityFresh,
    candidate: durationMs > maxDurationMs && !checkpointFresh && !activityFresh,
  };
  out.reason = out.candidate ? LONGRUN_REASON : (durationMs > maxDurationMs
    ? (checkpointFresh ? 'checkpoint-fresh' : (activityFresh ? 'activity-fresh' : 'no-longrun-candidate'))
    : 'duration-not-exceeded');
  return out;
}

export function createLaneHeartbeat({ store, mailbox, config, root, now }) {
  const cfg = resolveWatchConfig(config);
  const lrCfg = resolveLongrunConfig(config); // longrun 档配置（出厂默认开；关态 tick 不跑判定）
  const schedule = buildSchedule(cfg.intervalsMinutes);
  const hardStop = cfg.maxMissed; // 硬停拍数：连续 N 拍无活动 → stalled
  const clock = typeof now === 'function' ? now : () => Date.now();
  const engineRoot = root ?? (store?.sessionsDir ? dirname(store.sessionsDir) : null);
  // 状态表 Map<laneKey, { lastActivityAt, lastSeenTs, lastProbeAt, missedCount, stalled, pendingProbeId }>
  // laneKey = `${sessionId}/${batchId}/${lane}`
  const state = new Map();
  let disposed = false;

  function mailboxRootOf(sessionId, batchId) {
    if (!engineRoot) throw new Error('lane-heartbeat: no root (pass deps.root or store.sessionsDir)');
    return join(engineRoot, 'sessions', sessionId, 'mailbox', batchId);
  }
  const laneKeyOf = (sessionId, batchId, lane) => `${sessionId}/${batchId}/${lane}`;

  // 产物解析（自持只读实现，与 gates.js resolveArtifact/fileExistsNonEmpty 同源模式，避免循环依赖）
  function resolveArtifact(sessionId, batchId, rel) {
    const base = store.artifactsDirOf(sessionId, batchId);
    return isAbsPath(rel) ? rel : join(base, rel);
  }

  function freshEntry(nowTs) {
    return {
      lastActivityAt: nowTs,
      lastSeenTs: nowTs,
      lastProbeAt: nowTs, // 新派发 lane 先给 base 档宽限，不立即追问（重派 running 计时重置语义）
      missedCount: 0,
      stalled: false,
      pendingProbeId: null,
    };
  }
  function resetEntry(entry, nowTs) {
    entry.lastActivityAt = nowTs;
    entry.lastSeenTs = nowTs;
    entry.lastProbeAt = nowTs;
    entry.missedCount = 0;
    entry.stalled = false;
    entry.pendingProbeId = null;
  }

  // ---- 活动判定（三信号任一，防「长任务无产出误判」）----
  // ① batch.events：本 lane 可归因事件比上次扫描新（lane.stalled / lane.longrun.candidate 为引擎自写事件，
  //    排除防自重置——写事件零侵入的既有 stalled 纪律扩面到 longrun 档）
  function laneEventActivity(batch, lane, sinceTs) {
    const evs = batch.events ?? [];
    for (let i = evs.length - 1; i >= 0; i--) {
      const e = evs[i];
      if (e.type === EVT.EVT_LANE_STALLED || e.type === EVT.EVT_LANE_LONGRUN_CANDIDATE) continue;
      if (e.lane === lane) {
        const ts = Date.parse(e.ts ?? '');
        if (Number.isFinite(ts) && ts > sinceTs) return true;
      }
    }
    return false;
  }
  // ② outbox：该 lane outbox 目录出现未 ack 消息
  function outboxActivity(sessionId, batchId, lane) {
    try {
      return mailbox.readUnacked(mailboxRootOf(sessionId, batchId), { type: 'outbox', lane }).length > 0;
    } catch { return false; }
  }
  // ③ 产物 mtime：artifacts/<batchId>/ 下该 lane 声明产物（outputs/produce）mtime 变化
  function artifactActivity(sessionId, batchId, batch, lane, sinceTs) {
    const t = findTask(batch, lane);
    const rels = [...(t?.outputs ?? []), ...(t?.produce ?? [])];
    for (const rel of rels) {
      try {
        if (statSync(resolveArtifact(sessionId, batchId, rel)).mtimeMs > sinceTs) return true;
      } catch { /* 不存在/不可读 → 无活动 */ }
    }
    return false;
  }
  function hasActivity(sessionId, batchId, batch, lane, sinceTs) {
    return laneEventActivity(batch, lane, sinceTs)
      || outboxActivity(sessionId, batchId, lane)
      || artifactActivity(sessionId, batchId, batch, lane, sinceTs);
  }

  // 首次追踪某 lane 时把 lastSeenTs 基线对齐到「已知信号最新时间」（本 lane 事件 ts / 声明产物 mtime 的最大值）。
  // 防时钟偏移/测试注入时钟时把历史活动误判为新鲜活动（历史事件 ts > 冷启动 nowTs 时会被误判持续活动）
  function baselineTs(sessionId, batchId, batch, lane, nowTs) {
    let t = nowTs;
    const evs = batch.events ?? [];
    for (let i = evs.length - 1; i >= 0; i--) {
      const e = evs[i];
      if (e.type === EVT.EVT_LANE_STALLED || e.type === EVT.EVT_LANE_LONGRUN_CANDIDATE) continue;
      if (e.lane === lane) {
        const ts = Date.parse(e.ts ?? '');
        if (Number.isFinite(ts) && ts > t) t = ts;
      }
    }
    const task = findTask(batch, lane);
    for (const rel of [...(task?.outputs ?? []), ...(task?.produce ?? [])]) {
      try {
        const m = statSync(resolveArtifact(sessionId, batchId, rel)).mtimeMs;
        if (m > t) t = m;
      } catch { /* 不存在 → 忽略 */ }
    }
    return t;
  }

  // 同 lane 至多 1 条 pending 追问（多拍合并语义：mailbox 无 replace → 读 inbox 未 ack 追问，存在则跳过）。
  // 追问 ts 早于最近一次活动 → 视为已被活动满足的陈旧追问，不再当作未答拍（活动后 reset 语义）
  function pendingProbe(sessionId, batchId, lane, sinceTs) {
    try {
      const items = mailbox.readUnacked(mailboxRootOf(sessionId, batchId), { type: 'inbox' });
      for (const it of items) {
        if (it.message?.kind !== 'probe' || it.message?.lane !== lane) continue;
        const ts = Date.parse(it.ts ?? '');
        if (Number.isFinite(ts) && ts < sinceTs) continue; // 陈旧追问：活动发生在它之后
        return it;
      }
      return null;
    } catch { return null; }
  }

  function probeText(lane, batchId, missed) {
    if (cfg.probeTemplate) {
      return cfg.probeTemplate
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

  function markStalled(sessionId, batchId, lane, entry, nowTs) {
    try {
      store.appendEvent(sessionId, batchId, EVT.EVT_LANE_STALLED, { lane, missed: entry.missedCount });
    } catch { /* 批次已终态/不存在等 → 忽略（下轮不再扫） */ }
    entry.stalled = true;
    entry.lastSeenTs = nowTs; // 自写事件不触发自身重置
    entry.lastProbeAt = null;
  }

  // ---- longrun 档（超时重派探针，design longrun-probe-design §1/§3/§5）：----
  // 与 stalled 档互不干扰：同一 tick 扫描、同一内存表；只读判定 + 候选产出（动作即止），不改 lane 状态、
  // 不 interrupt、不重派（成员控制归 Leader）。判定前置于心跳扫描执行：内存 entry 尚为本 tick 前状态
  // （无 fresh 宽限污染——设计 §1.2：引擎重启后内存空 → 以事件/产物基线兜底）。
  // lastActivityAt 来源：state 内存 entry.lastActivityAt（含 outbox 未 ack 活动信号）；entry 缺失 → baselineTs 兜底。
  function longrunLastActivityAt(sessionId, batchId, batch, lane) {
    const entry = state.get(laneKeyOf(sessionId, batchId, lane));
    if (entry?.lastActivityAt != null) return entry.lastActivityAt;
    return baselineTs(sessionId, batchId, batch, lane, 0); // 无内存条目 → 事件/产物最新信号（无信号=0→非新鲜）
  }
  // 候选产出（动作即止 2 项）：① 事件流留痕 ② mailbox broadcast 直写（底层 send，治理系统件不过 budget）。
  // 事件流去重（同 stint 已产 → skip）覆盖同 tick/多次 tick/引擎重启恢复三种情形；先事件后消息
  // （事件失败 → 不写消息；消息失败仅 warn 语义静默——事件为唯一事实源，面板/Leader 可查）。
  function emitLongrunCandidate(sessionId, batchId, batch, lane, nowTs) {
    const verdict = judgeLongrun({
      batch, lane, nowTs,
      maxDurationMs: lrCfg.maxDurationMs,
      noProgressWindowMs: lrCfg.noProgressWindowMs,
      lastActivityAtMs: longrunLastActivityAt(sessionId, batchId, batch, lane),
    });
    if (!verdict.candidate) return;
    if (hasLongrunCandidate(batch, lane, verdict.runningSinceTs)) return; // 事件流去重
    const payload = {
      lane,
      runningSince: verdict.runningSince,
      durationMs: verdict.durationMs,
      maxDurationMs: verdict.maxDurationMs,
      noProgressWindowMs: verdict.noProgressWindowMs,
      lastCheckpointTs: verdict.lastCheckpointTs,
      lastActivityAt: verdict.lastActivityAt,
      checkpointFresh: verdict.checkpointFresh,
      activityFresh: verdict.activityFresh,
      reason: verdict.reason,
    };
    try {
      store.appendEvent(sessionId, batchId, EVT.EVT_LANE_LONGRUN_CANDIDATE, payload);
    } catch { return; /* 批次终态/不存在 → 不产消息（事件失败即止） */ }
    try {
      mailbox.send(mailboxRootOf(sessionId, batchId), { type: 'broadcast' }, {
        kind: 'longrun.candidate', sessionId, batchId, ...payload,
      });
    } catch { /* 消息写失败：事件已留痕，静默（下轮同 stint 去重不再重发） */ }
  }
  // longrun 扫描档：仅扫 batch.phase==='running' 且 lane==='running'（与心跳 tick 扫描条件一致）
  function longrunTick(nowTs) {
    for (const sessionId of store.listSessions()) {
      for (const batchId of store.listBatches(sessionId)) {
        const batch = store.readBatch(sessionId, batchId);
        if (!batch) continue;
        if (batch.phase !== 'running') continue;
        for (const [lane, st] of Object.entries(batch.lanes ?? {})) {
          if (st !== 'running') continue;
          try { emitLongrunCandidate(sessionId, batchId, batch, lane, nowTs); }
          catch { /* 单 lane 探针失败隔离（不阻断整轮扫描） */ }
        }
      }
    }
  }
  // 只读：单 lane longrun 探针状态（lane_longrun 工具查询用；不依赖本 tick 是否已跑——实时判定）
  function longrunStatus(sessionId, batchId, lane, nowTs) {
    const batch = store.readBatch(sessionId, batchId);
    if (!batch) return { laneKey: laneKeyOf(sessionId, batchId, lane), tracked: false, candidate: false, reason: 'batch-not-found' };
    const verdict = judgeLongrun({
      batch, lane, nowTs: nowTs ?? clock(),
      maxDurationMs: lrCfg.maxDurationMs,
      noProgressWindowMs: lrCfg.noProgressWindowMs,
      lastActivityAtMs: longrunLastActivityAt(sessionId, batchId, batch, lane),
    });
    return {
      laneKey: laneKeyOf(sessionId, batchId, lane),
      sessionId, batchId, lane,
      tracked: state.has(laneKeyOf(sessionId, batchId, lane)),
      enabled: lrCfg.enabled,
      maxDurationMs: lrCfg.maxDurationMs,
      noProgressWindowMs: lrCfg.noProgressWindowMs,
      runningSince: verdict.runningSince,
      runningSinceTs: verdict.runningSinceTs,
      durationMs: verdict.durationMs,
      lastCheckpointTs: verdict.lastCheckpointTs,
      lastActivityAt: verdict.lastActivityAt,
      checkpointFresh: verdict.checkpointFresh,
      activityFresh: verdict.activityFresh,
      candidate: verdict.candidate,
      emitted: hasLongrunCandidate(batch, lane, verdict.runningSinceTs),
      reason: verdict.reason,
    };
  }

  // 扫描全部会话 running lane：
  // - 仅扫 batch.phase === 'running' 且 lane === 'running'；paused/planning/终态批次、idle/终态 lane 不挂心跳
  //   （恢复语义：running→idle 后不挂，重派 running 时以 fresh entry 重置计时）
  function tick() {
    if (disposed) return;
    const nowTs = clock();
    // longrun 档（并列，同 tick 同引擎）：置于心跳扫描之前执行——此时内存 entry 为本 tick 前状态
    // （freshEntry 宽限不污染 lastActivityAt 判定；重启后 entry 缺失 → baselineTs 兜底，design §1.2）。
    if (lrCfg.enabled) longrunTick(nowTs);
    for (const sessionId of store.listSessions()) {
      for (const batchId of store.listBatches(sessionId)) {
        const batch = store.readBatch(sessionId, batchId);
        if (!batch) continue;
        if (batch.phase !== 'running') { dropBatchEntries(batch); continue; }
        for (const [lane, st] of Object.entries(batch.lanes ?? {})) {
          const laneKey = laneKeyOf(sessionId, batchId, lane);
          if (st !== 'running') { state.delete(laneKey); continue; }
          let entry = state.get(laneKey);
          if (!entry) {
            entry = freshEntry(nowTs);
            entry.lastSeenTs = baselineTs(sessionId, batchId, batch, lane, entry.lastSeenTs);
            state.set(laneKey, entry);
          }
          // 活动 → 重置回 tier0（W3）
          if (hasActivity(sessionId, batchId, batch, lane, entry.lastSeenTs)) { resetEntry(entry, nowTs); continue; }
          // 已 stalled：只标记，停止追问（W2）
          if (entry.stalled) continue;
          // 退避档位：tier = min(missedCount, len-1)，档位单调（W4）
          const tier = Math.min(entry.missedCount, schedule.length - 1);
          if (entry.lastProbeAt !== null && nowTs - entry.lastProbeAt < schedule[tier]) continue;
          // 一拍 = 一次追问轮次；同 lane 至多 1 条 pending（W1），pending 存在则这一拍=已发未答
          const pending = pendingProbe(sessionId, batchId, lane, entry.lastActivityAt);
          if (!pending) {
            const r = mailbox.send(mailboxRootOf(sessionId, batchId), { type: 'inbox' }, {
              kind: 'probe',
              lane,
              batchId,
              missed: entry.missedCount + 1,
              text: probeText(lane, batchId, entry.missedCount + 1),
            });
            entry.pendingProbeId = r.ackId;
          }
          entry.missedCount += 1;
          entry.lastProbeAt = nowTs;
          // 硬停：连续 N 拍无活动 → lane.stalled（只标记不自动处置，不新增成员状态）
          if (entry.missedCount >= hardStop) markStalled(sessionId, batchId, lane, entry, nowTs);
        }
      }
    }
  }

  function dropBatchEntries(batch) {
    for (const lane of Object.keys(batch.lanes ?? {})) state.delete(laneKeyOf(batch.sessionId, batch.batchId, lane));
  }

  // 只读：lastActivityAt/当前档位/missed/stalled/pendingProbeId
  function status(laneKey) {
    const entry = state.get(laneKey);
    // laneKey = `${sessionId}/${batchId}/${lane}`；lane 未约束可含 '/'，按前两个斜杠定位
    const i1 = laneKey.indexOf('/');
    const i2 = i1 >= 0 ? laneKey.indexOf('/', i1 + 1) : -1;
    const sessionId = i1 >= 0 ? laneKey.slice(0, i1) : null;
    const batchId = i2 >= 0 ? laneKey.slice(i1 + 1, i2) : null;
    const lane = i2 >= 0 ? laneKey.slice(i2 + 1) : null;
    if (!entry) {
      return { laneKey, tracked: false, lastActivityAt: null, tier: 0, intervalMs: schedule[0], missed: 0, stalled: false, pendingProbeId: null, lastProbeAt: null };
    }
    const tier = Math.min(entry.missedCount, schedule.length - 1);
    return {
      laneKey,
      tracked: true,
      sessionId,
      batchId,
      lane,
      lastActivityAt: new Date(entry.lastActivityAt).toISOString(),
      tier,
      intervalMs: schedule[tier],
      missed: entry.missedCount,
      stalled: entry.stalled,
      pendingProbeId: entry.pendingProbeId,
      lastProbeAt: entry.lastProbeAt ? new Date(entry.lastProbeAt).toISOString() : null,
    };
  }

  // 活动信号外部入口：missedCount=0 回 tier0
  function reset(laneKey) {
    const entry = state.get(laneKey);
    if (entry) resetEntry(entry, clock());
  }

  function dispose() {
    disposed = true;
    state.clear();
  }

  return { tick, status, reset, dispose, longrunStatus };
}

// lane_heartbeat 工具定义（只读查询 + 可选手动触发一拍）。
// 组装进 lane-tools.js；enabled=false 时本工具不注册。
// deps: { store, root, config, heartbeat? } —— heartbeat 缺省时自建（注册侧懒加载，与挂载引擎共享状态文件）
export function createHeartbeatTools(ctx, deps = {}) {
  if (resolveWatchConfig(deps.config).enabled !== true) return [];
  const heartbeat = deps.heartbeat
    ?? createLaneHeartbeat({ store: deps.store, mailbox: deps.mailbox, config: deps.config, root: deps.root });
  return [
    defineTool({
      name: 'lane_heartbeat',
      description: '查询/手动触发 lane 心跳（watch 能力 C1，只读+可选手动一拍）：返回指定批次 running lane 的过期检测状态（lastActivityAt/当前档位/missed/stalled/pendingProbeId）；beat=true 时先跑一拍扫描再返回。不改变任何成员状态（stalled 用事件表达）。enabled=false 时不注册。',
      parameters: {
        batchId: { type: 'string', required: true, description: '批次 ID' },
        lane: { type: 'string', description: 'lane ID；缺省返回该批全部 running lane' },
        session: { type: 'string', description: '批次归属会话' },
        beat: { type: 'boolean', description: '手动触发一拍扫描（tick）后再返回状态' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {
          batchId: { type: 'string', required: true },
          sessionId: { type: 'string', required: true },
          lanes: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        } },
        render: (_args, value) => TEXT_OUTPUT('lane heartbeat: ' + value.lanes.length + ' lane(s)'),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        if (args.beat === true) heartbeat.tick();
        const batch = deps.store.readBatch(sessionId, args.batchId);
        if (!batch) throw new Error('batch not found: ' + args.batchId);
        const laneIds = args.lane
          ? [args.lane]
          : Object.keys(batch.lanes ?? {}).filter((l) => batch.lanes[l] === 'running');
        return {
          batchId: args.batchId,
          sessionId,
          lanes: laneIds.map((l) => heartbeat.status(`${sessionId}/${args.batchId}/${l}`)),
        };
      },
    }),
  ];
}

// lane_longrun 工具定义（只读查询 + 可选手动触发一拍；longrun 档并列注册，lane_heartbeat 输出零变化）。
// 组装进 lane-tools.js；门控 = watch.enabled && watch.longrun.enabled（出厂默认开——用户定案修订；显式
// capabilities.watch.longrun.enabled:false 时不注册，tick 亦不跑 longrun 判定，零事件零消息零行为变化）。
// deps: { store, root, config, heartbeat? } —— heartbeat 缺省时自建（与挂载引擎共享状态文件/内存表）
export function createLongrunTools(ctx, deps = {}) {
  if (resolveWatchConfig(deps.config).enabled !== true) return [];
  if (resolveLongrunConfig(deps.config).enabled !== true) return [];
  const heartbeat = deps.heartbeat
    ?? createLaneHeartbeat({ store: deps.store, mailbox: deps.mailbox, config: deps.config, root: deps.root });
  return [
    defineTool({
      name: 'lane_longrun',
      description: '查询/手动触发 lane 超时重派探针（watch 能力，longrun 档，只读+可选手动一拍）：返回指定批次 running lane 的长跑档状态（runningSince/durationMs/maxDurationMs/noProgressWindowMs/lastCheckpointTs/lastActivityAt/checkpointFresh/activityFresh/candidate/emitted/reason）；beat=true 时先跑一拍扫描（心跳 stalled 档与 longrun 档并列）再返回。探针只产候选（事件 + mailbox broadcast），不改任何成员状态；重派裁决归 Manager/Leader。watch.longrun.enabled=false 时不注册。',
      parameters: {
        batchId: { type: 'string', required: true, description: '批次 ID' },
        lane: { type: 'string', description: 'lane ID；缺省返回该批全部 running lane' },
        session: { type: 'string', description: '批次归属会话' },
        beat: { type: 'boolean', description: '手动触发一拍扫描（tick）后再返回状态' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {
          batchId: { type: 'string', required: true },
          sessionId: { type: 'string', required: true },
          lanes: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        } },
        render: (_args, value) => TEXT_OUTPUT('lane longrun probe: ' + value.lanes.length + ' lane(s)'),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        if (args.beat === true) heartbeat.tick();
        const batch = deps.store.readBatch(sessionId, args.batchId);
        if (!batch) throw new Error('batch not found: ' + args.batchId);
        const laneIds = args.lane
          ? [args.lane]
          : Object.keys(batch.lanes ?? {}).filter((l) => batch.lanes[l] === 'running');
        return {
          batchId: args.batchId,
          sessionId,
          lanes: laneIds.map((l) => heartbeat.longrunStatus(sessionId, args.batchId, l, null)),
        };
      },
    }),
  ];
}
