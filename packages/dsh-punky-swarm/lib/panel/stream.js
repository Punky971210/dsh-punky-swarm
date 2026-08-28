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

// ============================================================
// SSE hub（R3 面板推送，设计 exec/panel-design.md §3.3）
//
// 职责：会话级订阅集合 + 三路触发源（① topic 事件（enabled 时 attachTopic 接线）
//   ② fs.watch <root>/sessions/<sid> 批次/mailbox 目录（防抖 300ms）
//   ③ 10s 心跳帧（event: heartbeat + 注释帧 : ping 保活））
// 推送粒度（ADR-5）：只推轻量摘要 { sessionId, batchId, eventCount, updatedAt }，
//   客户端收到信号后回拉既有只读 API 取全量——正确性由回拉兜底，本模块零快照逻辑。
//
// D6 简化 5 项标注（设计 §3.3.5，逐项落地）：
//   1. 多路复用通道协议 → 不做：单流 + event: batch|mailbox|heartbeat 类型区分
//      （面板只读监控两种事件，单流足够）
//   2. 断线指数退避重连 → 不做：依赖 EventSource 自动重连 + 客户端回退轮询
//   3. 服务端背压/流控队列 → 不做：write 失败即断开该订阅者（客户端重连）
//   4. 事件级增量快照 → 不做：推送信号 + 客户端回拉全量（服务端无快照逻辑）
//   5. 鉴权/会话扩展 → 不做：沿用既有 /api 会话语义（session query 参数）
//
// 零新依赖（D1）：node:fs watch + 宿主注入的 node:http ServerResponse（writeHead/write）
//   + 浏览器内置 EventSource（客户端侧）。无独立配置键（D3/D4）：随 webServer 挂载，
//   降级回轮询即运行时自适配开关（ADR-4）。
// ============================================================

import { watch } from 'node:fs';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { subscribeTopicPrefix } from '../comms/topic.js';

const MAX_CONNS_PER_SESSION = 8; // 每会话连接数上限（防多标签页风暴）
const HEARTBEAT_MS = 10_000;     // 心跳帧周期（10s，对齐设计 §3.3.3 触发源③）
const DEBOUNCE_MS = 300;         // fs.watch 防抖（Windows 目录事件丢失/重复兜底，设计 §5.3-4）
const POLL_MS = 1000;            // stat 轮询兜底周期（8.3 短路径主机无法安全用 fs.watch 目录 watch）
// 以上为生产缺省值；createStreamHub 接受 heartbeatMs/debounceMs/maxConns 覆盖（单测提速用，缺省不变）

// 8.3 短路径段判定（XXXXXX~N）：libuv 在 Windows 上对含短路径段的目录做 fs.watch 时，
// 事件回调带回长路径触发原生断言崩溃（Node v24 本机实测 fs-event.c line 72）——预判规避，改 stat 轮询。
// 仅命中短路径形态才规避；正常长路径（生产 root=~/.dsh/jiufeng 经 homedir，长路径）走 fs.watch 事件通道。
export function hasShortNameSegment(p) {
  if (process.platform !== 'win32') return false;
  const segs = String(p).split(/[\\/]/).filter(Boolean);
  return segs.some((s) => /^[A-Za-z0-9]{1,8}~\d{1,3}$/.test(s));
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

function frame(event, data) {
  return 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
}
function comment(text) {
  return ': ' + text + '\n\n';
}

// topic 名 `swarm.<type>.<sid>.<bid>`：type 可含点（member.settled），从尾部取 sid/bid
function parseTopicIds(topic, prefix) {
  if (typeof topic !== 'string' || !topic.startsWith(prefix)) return null;
  const rest = topic.slice(prefix.length);
  const parts = rest.split('.');
  if (parts.length < 2) return null;
  const bid = parts[parts.length - 1];
  const sid = parts[parts.length - 2];
  if (!sid || !bid) return null;
  return { sessionId: sid, batchId: bid };
}

export function createStreamHub({ root, logger, heartbeatMs = HEARTBEAT_MS, debounceMs = DEBOUNCE_MS, maxConns = MAX_CONNS_PER_SESSION } = {}) {
  // sid -> { subs: Set<{res,batchId}>, watchers: Set<FSWatcher>, debounce: timer|null,
  //          pendingBid: string|null, pendingKind: 'batch'|'mailbox'|null, polling: bool, sig: string|null }
  const sessions = new Map();
  const topicUnsubs = [];
  let heartbeatTimer = null;
  let pollTimer = null;
  let disposed = false;

  const log = (msg) => { try { logger?.info?.('[dsh-punky-swarm/stream] ' + msg); } catch {} };

  // eventCount 只读最小读取（物理事实源 = 批次 JSON，store.js:109 语义）——非快照逻辑，仅计数
  function readEventCount(sessionId, batchId) {
    if (!root || !batchId) return null;
    try {
      const f = join(root, 'sessions', sessionId, 'batches', batchId + '.json');
      if (!existsSync(f)) return null;
      const b = JSON.parse(readFileSync(f, 'utf8'));
      return Array.isArray(b.events) ? b.events.length : null;
    } catch { return null; }
  }

  function sessionOf(sessionId) {
    let s = sessions.get(sessionId);
    if (!s) {
      s = { subs: new Set(), watchers: new Set(), debounce: null, pendingBid: null, pendingKind: null, polling: false, sig: null };
      sessions.set(sessionId, s);
    }
    return s;
  }

  function writeRes(res, chunk) {
    if (!res || res.destroyed || res.writableEnded) return false;
    try { res.write(chunk); return true; } catch { return false; }
  }

  // 推送单帧；write 失败（D6 简化③）→ 断开该订阅者（客户端自动重连/回退轮询）
  function push(s, res, event, data) {
    if (!writeRes(res, frame(event, data))) {
      detach(res);
      return false;
    }
    return true;
  }

  function detach(res) {
    for (const [sid, s] of sessions) {
      for (const sub of s.subs) {
        if (sub.res !== res) continue;
        s.subs.delete(sub);
        try { res.end(); } catch {}
        if (s.subs.size === 0) teardownSession(sid);
        return;
      }
    }
  }

  // fs.watch：批量目录（含文件名→bid 解析）+ mailbox 目录（帧协议 event: mailbox）+ 目录缺失时兜底 watch 会话根。
  // 8.3 短路径预判（hasShortNameSegment）：命中 → 本会话转 stat 轮询兜底（fs.watch 在此路径形态原生崩溃风险）。
  function ensureWatchers(sessionId) {
    const s = sessions.get(sessionId);
    if (!s || s.watchers.size || s.polling || disposed) return;
    const base = join(root, 'sessions', sessionId);
    if (hasShortNameSegment(base)) { s.polling = true; startPoller(); scanChanged(sessionId); return; }
    const targets = [
      { dir: join(base, 'batches'), withBid: true, kind: 'batch' },
      { dir: join(base, 'mailbox'), withBid: false, kind: 'mailbox' },
    ];
    for (const t of targets) {
      try {
        const w = watch(t.dir, { persistent: false }, (evt, fname) => {
          const bid = t.withBid && fname && /^[\w.-]+\.json$/i.test(fname) ? fname.replace(/\.json$/i, '') : null;
          scheduleNotify(sessionId, bid, t.kind);
        });
        w.on('error', () => {});
        s.watchers.add(w);
      } catch { /* 目录尚未创建 → 兜底 watch 会话根 */ }
    }
    if (!s.watchers.size) {
      try {
        const w = watch(base, { persistent: false }, () => scheduleNotify(sessionId, null, 'batch'));
        w.on('error', () => {});
        s.watchers.add(w);
      } catch { /* 会话根也不存在：静默（订阅仍在，心跳保活） */ }
    }
  }

  // stat 轮询兜底：readdir mtime 签名比对（8.3 短路径主机；功能等价——正确性仍由客户端回拉兜底）
  function scanChanged(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return false;
    const dirs = [join(root, 'sessions', sessionId, 'batches'), join(root, 'sessions', sessionId, 'mailbox')];
    const parts = [];
    for (const d of dirs) {
      try {
        for (const f of readdirSync(d)) {
          const st = statSync(join(d, f));
          parts.push(f + ':' + st.mtimeMs + ':' + st.size);
        }
      } catch { /* 目录缺失跳过 */ }
    }
    const sig = parts.sort().join('|');
    const changed = s.sig !== null && s.sig !== sig; // 首扫仅建基线（s.sig=null），不触发推送
    s.sig = sig;
    return changed;
  }
  function startPoller() {
    if (pollTimer || disposed) return;
    pollTimer = setInterval(() => {
      for (const [sid, s] of sessions) {
        if (!s.subs.size || !s.polling) continue;
        if (scanChanged(sid)) scheduleNotify(sid, null);
      }
    }, POLL_MS);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
  }
  function stopPollerIfIdle() {
    let active = false;
    for (const s of sessions.values()) { if (s.subs.size && s.polling) { active = true; break; } }
    if (!active && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function teardownSession(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return;
    for (const w of s.watchers) closeWatcher(w);
    s.watchers.clear();
    if (s.debounce) { clearTimeout(s.debounce); s.debounce = null; }
    s.pendingBid = null;
    s.pendingKind = null;
    s.polling = false;
    sessions.delete(sessionId);
    stopHeartbeatIfIdle();
    stopPollerIfIdle();
  }

  // Windows libuv 目录 watch 在事件在途时同步 close 会触发原生断言（fs-event.c）——
  // 延迟一拍关闭，让在途事件排空（幂等：closed 标记防重复 close）
  function closeWatcher(w) {
    if (!w || w.__pswClosed) return;
    w.__pswClosed = true;
    setImmediate(() => { try { w.close(); } catch {} });
  }

  function scheduleNotify(sessionId, bid, kind = 'batch') {
    const s = sessions.get(sessionId);
    if (!s || !s.subs.size) return;
    if (bid && !s.pendingBid) s.pendingBid = bid; // 防抖窗口内取首个明确 bid（其余变化归并）
    if (!s.pendingKind) s.pendingKind = kind;
    if (s.debounce) clearTimeout(s.debounce);
    s.debounce = setTimeout(() => {
      s.debounce = null;
      const b = s.pendingBid;
      const k = s.pendingKind || 'batch';
      s.pendingBid = null;
      s.pendingKind = null;
      if (disposed) return;
      notifyAll(sessionId, k, b);
    }, debounceMs);
  }

  // 推送摘要（信号 + 计数，全量交给客户端回拉）；batchId 过滤详情流订阅者
  function notifyAll(sessionId, event, batchId, extra = {}) {
    const s = sessions.get(sessionId);
    if (!s || !s.subs.size) return;
    for (const sub of [...s.subs]) {
      if (sub.batchId && batchId && sub.batchId !== batchId) continue;
      const targetBid = sub.batchId || batchId || null;
      const summary = {
        sessionId,
        batchId: targetBid,
        eventCount: extra.eventCount != null ? extra.eventCount : (targetBid ? readEventCount(sessionId, targetBid) : null),
        updatedAt: extra.updatedAt || new Date().toISOString(),
      };
      push(s, sub.res, event, summary);
    }
  }

  // 心跳：event: heartbeat（客户端 15s 无心跳降级判据）+ 注释帧 : ping（穿透代理保活）
  function startHeartbeat() {
    if (heartbeatTimer || disposed) return;
    heartbeatTimer = setInterval(() => {
      let total = 0;
      for (const [sid, s] of sessions) {
        // 订阅时目录尚不存在 → 心跳对齐时补挂 watcher（目录后创建兜底）
        if (s.subs.size && !s.watchers.size) ensureWatchers(sid);
        for (const sub of [...s.subs]) {
          total++;
          if (!writeRes(sub.res, comment('ping'))) { detach(sub.res); continue; }
          push(s, sub.res, 'heartbeat', { ts: new Date().toISOString() });
        }
      }
      if (total === 0) stopHeartbeatIfIdle();
    }, heartbeatMs);
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  }
  function stopHeartbeatIfIdle() {
    let total = 0;
    for (const s of sessions.values()) total += s.subs.size;
    if (total === 0 && heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  // 订阅：会话级上限 → SSE 握手 → 注册 + close 清理 → 挂 watcher/心跳
  function subscribe(sessionId, batchId, res) {
    if (disposed) return { ok: false, reason: 'disposed' };
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, reason: 'session required' };
    const s = sessionOf(sessionId);
    if (s.subs.size >= maxConns) return { ok: false, reason: 'limit' };
    try {
      if (typeof res.writeHead === 'function') res.writeHead(200, SSE_HEADERS);
      if (typeof res.flushHeaders === 'function') { try { res.flushHeaders(); } catch {} }
    } catch { return { ok: false, reason: 'handshake' }; }
    const sub = { res, batchId: batchId || null };
    s.subs.add(sub);
    writeRes(res, comment('connected'));
    push(s, res, 'heartbeat', { ts: new Date().toISOString() });
    const onClose = () => detach(res);
    if (typeof res.on === 'function') { res.on('close', onClose); res.on('error', onClose); }
    ensureWatchers(sessionId);
    startHeartbeat();
    log('subscribed session=' + sessionId + (batchId ? ' batch=' + batchId : '') + ' conns=' + s.subs.size);
    return { ok: true };
  }

  // topic 触发源接线（设计 §3.3.3 ①）：exec-a merged 后由装配点（index.js 层）调用——
  // 订阅 `swarm.` 前缀（swarm.<type>.<sid>.<bid>），按 payload/主题名提取会话与批次路由推送
  function attachTopic(prefix = 'swarm.', handler) {
    if (disposed) return () => {};
    const un = subscribeTopicPrefix(prefix, (topic, payload) => {
      try {
        if (handler) { handler(topic, payload); return; }
        const ids = parseTopicIds(topic, prefix);
        const sessionId = payload?.sessionId || payload?.session || ids?.sessionId;
        const batchId = payload?.batchId || ids?.batchId;
        if (!sessionId) return;
        notifyAll(sessionId, 'batch', batchId || null, {
          eventCount: payload?.eventCount,
          updatedAt: payload?.updatedAt,
        });
      } catch { /* 隔离 */ }
    });
    topicUnsubs.push(un);
    return un;
  }

  function stats() {
    let conns = 0;
    for (const s of sessions.values()) conns += s.subs.size;
    return { sessions: sessions.size, conns };
  }

  function dispose() {
    disposed = true;
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    for (const un of topicUnsubs) { try { un(); } catch {} }
    topicUnsubs.length = 0;
    for (const sid of [...sessions.keys()]) teardownSession(sid);
    sessions.clear();
  }

  return { subscribe, detach, notify: notifyAll, attachTopic, stats, dispose };
}
