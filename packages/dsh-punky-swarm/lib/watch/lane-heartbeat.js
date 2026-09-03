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

export function createLaneHeartbeat({ store, mailbox, config, root, now }) {
  const cfg = resolveWatchConfig(config);
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
  // ① batch.events：本 lane 可归因事件比上次扫描新（lane.stalled 为引擎自写事件，排除防自重置）
  function laneEventActivity(batch, lane, sinceTs) {
    const evs = batch.events ?? [];
    for (let i = evs.length - 1; i >= 0; i--) {
      const e = evs[i];
      if (e.type === EVT.EVT_LANE_STALLED) continue;
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
      if (e.type === EVT.EVT_LANE_STALLED) continue;
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

  // 扫描全部会话 running lane：
  // - 仅扫 batch.phase === 'running' 且 lane === 'running'；paused/planning/终态批次、idle/终态 lane 不挂心跳
  //   （恢复语义：running→idle 后不挂，重派 running 时以 fresh entry 重置计时）
  function tick() {
    if (disposed) return;
    const nowTs = clock();
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

  return { tick, status, reset, dispose };
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
