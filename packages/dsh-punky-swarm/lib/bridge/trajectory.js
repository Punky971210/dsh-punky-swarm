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

// bridge/trajectory.js —— C5 诊断桥接（成熟模式：LangGraph 观测层 / dsh-trajectory-governance）
// 订阅 trajectory 异常（anomaly）→ sessionId→lane 映射 → notify（默认 notify-only，auto-fail 默认关）
// 原则（决策包 §5.1/§5.2）：只读消费告警载荷、不 mutate 载荷、不碰内核、不调插件任何控制面动作（红线 R5/R6）
// 事件契约：'member.dispatch' 记录派发映射（既有事件通道，零新字段）；'lane.anomaly' 记录异常证据；broadcast 提示 Manager
import { join } from 'node:path';
import { TRAJECTORY_DEFAULTS } from '../schema.js';

const ANOMALY_EVENT = 'trajectory/anomaly'; // 首选通道：同运行时实时订阅（Cordis 总线事件）
const DISPATCH_EVENT = 'member.dispatch';   // 派发时记录 worker 会话 id（桥接器 recordDispatch 写入）
const ANOMALY_RECORD = 'lane.anomaly';      // 异常留痕事件（batch.events，面板可见）
const MAILBOX_KIND = 'anomaly';             // broadcast 消息 kind

// 装配开关（红线 R3：enabled 默认关，对齐 aip.enabled 先例；false 时桥接不挂载，零运行时开销）
export function isTrajectoryEnabled(config) {
  return config?.capabilities?.trajectory?.enabled === true;
}

export function createTrajectoryBridge(ctx, deps) {
  const { store, config = {}, mailbox } = deps;
  const trajCfg = config?.capabilities?.trajectory ?? {};
  const failConfidence = typeof trajCfg.failConfidence === 'number'
    ? trajCfg.failConfidence
    : TRAJECTORY_DEFAULTS.failConfidence;

  // sessionId(worker 会话) → { sessionId, batchId, lane }；
  // 派发时经 recordDispatch 记录；进程重启后从批次事件重建（幂等，R1）
  const laneBySession = new Map();
  let pollTimer = null;
  let lastPollSince = 0;
  let subscribed = false;
  let detach = null; // ctx.on 返回的退订函数（若存在）

  function mailboxRootOf(sessionId, batchId) {
    // 与 tools/mailbox-tools.js boxRoot 同源：<root>/sessions/<sessionId>/mailbox/<batchId>
    return join(store.sessionsDir, sessionId, 'mailbox', batchId);
  }

  // 重启重建：扫全部批次事件，幂等（重复调用只覆盖不膨胀）
  function rebuildFromEvents() {
    let n = 0;
    for (const { sessionId, batchId } of store.listAllBatches()) {
      const batch = store.readBatch(sessionId, batchId);
      if (!batch?.events) continue;
      for (const ev of batch.events) {
        if (ev.type === DISPATCH_EVENT && ev.workerSessionId && ev.lane) {
          laneBySession.set(ev.workerSessionId, { sessionId, batchId, lane: ev.lane });
          n++;
        }
      }
    }
    return n;
  }

  // 派发记录（member_status → running 派发时的 worker 会话 id 落事件；零新字段，store.appendEvent 既有通道）
  function recordDispatch({ sessionId, batchId, lane, workerSessionId }) {
    if (!sessionId || !batchId || !lane || !workerSessionId) {
      throw new Error('recordDispatch: sessionId/batchId/lane/workerSessionId 均必填');
    }
    store.appendEvent(sessionId, batchId, DISPATCH_EVENT, { lane, workerSessionId });
    laneBySession.set(workerSessionId, { sessionId, batchId, lane });
    return { ok: true, workerSessionId, batchId, lane };
  }

  // 只读快照：sessionId → { sessionId, batchId, lane }（gate_status 可选 advisory 展示用，不改门禁语义）
  function mapping() {
    const out = {};
    for (const [k, v] of laneBySession) out[k] = { ...v };
    return out;
  }

  // notify（默认 notify-only）：lane.anomaly 事件 + broadcast 提示 Manager；不自动结算（Manager 按纪律裁决）
  // 注：store.newEvent 展开为 { ts, type, ...fields }——载荷若含顶层 type 会覆盖事件类型（store.js:56-58），
  //     故 AnomalyAlert 载荷嵌套于 alert 字段（决策包 §5.1 载荷原样保留，事件 type 恒为 lane.anomaly）
  function notify(hit, alert) {
    const { sessionId, batchId, lane } = hit;
    const { anomalyId, type, confidence, severity, message } = alert;
    store.appendEvent(sessionId, batchId, ANOMALY_RECORD, { lane, alert: { anomalyId, type, confidence, severity, message } });
    mailbox.send(mailboxRootOf(sessionId, batchId), { type: 'broadcast' }, {
      kind: MAILBOX_KIND,
      anomalyId, type, confidence, severity, message,
      sessionId, batchId, lane,
      ts: new Date().toISOString(),
    }, { from: 'trajectory-bridge' });
  }

  // auto-fail 开关（默认关）：仅 loop_deadlock 且 confidence ≥ 阈值（可配）→ member_settle failed 终态结算
  // 红线：不自动重试、不自动开新批次、不调插件 fork/auto-stop（决策包 §5.2 ③）；settle 判定权仍在 Manager/门禁
  function maybeAutoFail(hit, alert) {
    const { sessionId, batchId, lane } = hit;
    const { anomalyId, type, confidence, message } = alert;
    if (trajCfg.autoFail !== true) return false;
    if (type !== 'loop_deadlock') return false;
    if (confidence < failConfidence) return false;
    try {
      store.setMember(sessionId, batchId, lane, 'failed',
        `anomalyId=${anomalyId}, 证据摘要(type=${type}, confidence=${confidence}${message ? ', ' + message : ''})`);
      return true;
    } catch (e) {
      // 状态机不合法（lane 非 running/review）→ 跳过自动结算，notify 证据已留
      ctx.logger?.warn?.('[trajectory] auto-fail skipped: ' + String(e?.message ?? e));
      return false;
    }
  }

  // 告警载荷归一化（AnomalyAlert 契约：anomalyId/sessionId/type/confidence/severity/message）
  function normalizeAlert(raw) {
    const confidence = Number(raw?.confidence);
    return {
      anomalyId: raw?.anomalyId ?? ('anomaly-' + Date.now()),
      sessionId: raw?.sessionId ?? null,
      type: raw?.type ?? 'unknown',
      confidence: Number.isFinite(confidence) ? confidence : 0,
      severity: raw?.severity ?? 'warning',
      message: raw?.message ?? '',
    };
  }

  // 异常入口：反查 lane → notify（+ 可选 auto-fail）；未映射/无 sessionId → 静默降级（不报错不轮询）
  function handleAnomaly(rawAlert) {
    const alert = normalizeAlert(rawAlert);
    if (!alert.sessionId) {
      ctx.logger?.warn?.('[trajectory] anomaly without sessionId, dropped');
      return { routed: false, reason: 'no-session' };
    }
    const hit = laneBySession.get(alert.sessionId);
    if (!hit) {
      ctx.logger?.warn?.('[trajectory] unmapped session: ' + alert.sessionId);
      return { routed: false, reason: 'unmapped' };
    }
    notify(hit, alert);
    const autoFailed = maybeAutoFail(hit, alert);
    return { routed: true, batchId: hit.batchId, lane: hit.lane, autoFailed };
  }

  // fallback：HTTP 轮询 /api/alerts?since=（可配，默认关；插件未装/无事件时静默降级）
  async function pollAlerts() {
    const baseUrl = trajCfg.poll?.baseUrl;
    if (!baseUrl) return;
    try {
      const res = await fetch(baseUrl + '/api/alerts?since=' + lastPollSince);
      if (!res.ok) return;
      const alerts = await res.json();
      if (Array.isArray(alerts)) {
        for (const a of alerts) handleAnomaly(a);
        lastPollSince = Date.now();
      }
    } catch (e) {
      ctx.logger?.warn?.('[trajectory] poll failed (silent degrade): ' + String(e?.message ?? e));
    }
  }

  function start() {
    rebuildFromEvents(); // 幂等：重启后从批次事件重建映射（R1）
    if (typeof ctx?.on === 'function') {
      const handler = (a) => {
        try { handleAnomaly(a); } catch (e) { ctx.logger?.warn?.('[trajectory] handler error: ' + String(e?.message ?? e)); }
      };
      detach = ctx.on(ANOMALY_EVENT, handler);
      subscribed = true;
    }
    if (trajCfg.poll?.enabled === true) {
      const intervalMs = trajCfg.poll?.intervalMs ?? TRAJECTORY_DEFAULTS.poll.intervalMs;
      pollTimer = setInterval(() => { pollAlerts().catch(() => {}); }, intervalMs);
    }
    return { subscribed, poll: trajCfg.poll?.enabled === true };
  }

  function stop() {
    if (subscribed && detach) {
      try { detach(); } catch {}
    }
    if (subscribed && typeof ctx?.off === 'function') {
      // 兼容 ctx.on 未返回退订函数、仅提供 off 的宿主
      try { ctx.off(ANOMALY_EVENT); } catch {}
    }
    subscribed = false;
    detach = null;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    return { stopped: true };
  }

  return { start, stop, mapping, recordDispatch, handleAnomaly, rebuildFromEvents };
}
