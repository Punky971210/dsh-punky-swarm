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

import { TRAJECTORY_DEFAULTS } from '../schema.js';
import { mailboxRootOf } from '../mailbox-paths.js'; // mailbox 落盘根单点（A1-P2-10）
import { engineRootOf } from '../state/batch-paths.js'; // 引擎根推导单点（A2-G08；本处不再自推导）
import { readCapability } from '../assembly/schema.js'; // 装配开关经注册表 default 缺省合并
import { EVT_MEMBER_DISPATCH } from '../state/event-types.js'; // 派发事件常量收敛（与 event-types.js 同值）

const ANOMALY_EVENT = 'trajectory/anomaly'; // 首选通道：同运行时实时订阅（Cordis 总线事件）
const ANOMALY_RECORD = 'lane.anomaly';      // 异常留痕事件（batch.events，面板可见）
const MAILBOX_KIND = 'anomaly';             // broadcast 消息 kind
const DISPATCH_EVENT = EVT_MEMBER_DISPATCH;

export function isTrajectoryEnabled(config) {
  return readCapability(config, 'trajectory')?.enabled === true;
}

export function createTrajectoryBridge(ctx, deps) {
  const { store, config = {}, mailbox, dispatchIndex = null } = deps;
  const trajCfg = config?.capabilities?.trajectory ?? {};
  const failConfidence = typeof trajCfg.failConfidence === 'number'
    ? trajCfg.failConfidence
    : TRAJECTORY_DEFAULTS.failConfidence;

  const laneBySession = new Map();
  let pollTimer = null;
  let lastPollSince = 0;
  let subscribed = false;
  let detach = null; // ctx.on 返回的退订函数（若存在）


  function rebuildFromEvents() {
    let n = 0;
    if (dispatchIndex instanceof Map) {
      laneBySession.clear(); // 【U-2】重建前清空：原实现无 clear ⇒ 旧 workerSessionId 条目不清除、缓慢增长
      for (const [key, value] of dispatchIndex) laneBySession.set(key, value);
      return dispatchIndex.size;
    }
    laneBySession.clear(); // 【U-2】自扫路径同样先清空（幂等语义从「只覆盖」升为「先清后填」）
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

  function recordDispatch({ sessionId, batchId, lane, workerSessionId }) {
    if (!sessionId || !batchId || !lane || !workerSessionId) {
      throw new Error('recordDispatch: sessionId/batchId/lane/workerSessionId 均必填');
    }
    store.appendEvent(sessionId, batchId, DISPATCH_EVENT, { lane, workerSessionId });
    laneBySession.set(workerSessionId, { sessionId, batchId, lane });
    return { ok: true, workerSessionId, batchId, lane };
  }

  function mapping() {
    const out = {};
    for (const [k, v] of laneBySession) out[k] = { ...v };
    return out;
  }

  function notify(hit, alert) {
    const { sessionId, batchId, lane } = hit;
    const { anomalyId, type, confidence, severity, message } = alert;
    store.appendEvent(sessionId, batchId, ANOMALY_RECORD, { lane, alert: { anomalyId, type, confidence, severity, message } });
    mailbox.send(mailboxRootOf(engineRootOf(store.sessionsDir), sessionId, batchId), { type: 'broadcast' }, {
      kind: MAILBOX_KIND,
      anomalyId, type, confidence, severity, message,
      sessionId, batchId, lane,
      ts: new Date().toISOString(),
    }, { from: 'trajectory-bridge' });
  }

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
      ctx.logger?.warn?.('[trajectory] auto-fail skipped: ' + String(e?.message ?? e));
      return false;
    }
  }

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
    rebuildFromEvents(); // 幂等：重启后从批次事件重建映射
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
    if (subscribed) {
      // cordis 4.1 起 Context 经 Proxy 拦截属性读取：未 inject 的键取值即抛
      // `cannot get property "off" without inject`，`typeof` 无法免疫 ——
      // 故探测本身必须包在 try 内，否则 stop() 会抛穿宿主。
      try {
        if (typeof ctx?.off === 'function') ctx.off(ANOMALY_EVENT);
      } catch {}
    }
    subscribed = false;
    detach = null;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    return { stopped: true };
  }

  return { start, stop, mapping, recordDispatch, handleAnomaly, rebuildFromEvents };
}
