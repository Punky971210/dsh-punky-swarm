// dsh-punky-swarm 只读治理 API：batches / batch / mailbox / locks（全部按 session 隔离）
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as mailbox from './mailbox.js';

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function q(url) {
  return Object.fromEntries(new URL(url, 'http://localhost').searchParams.entries());
}

export function createApi(ctx, deps) {
  const { store, root } = deps;
  const disposers = [];
  const register = (route) => disposers.push(ctx.webServer.register(route));

  register({
    kind: 'prefix',
    path: '/api/dsh-punky-swarm',
    handler(req, res) { sendJson(res, 404, { error: 'not-found' }); },
  });

  register({
    kind: 'exact',
    path: '/api/dsh-punky-swarm/batches',
    handler(req, res) {
      try {
        const { session } = q(req.url);
        if (!session) return sendJson(res, 400, { error: 'session required' });
        const batches = store.listBatches(session).map((id) => {
          const b = store.readBatch(session, id);
          return { batchId: id, session, phase: b.phase, lanes: b.lanes, settled: store.batchSettled(b), eventCount: b.events.length };
        });
        sendJson(res, 200, { session, batches });
      } catch (e) { sendJson(res, 500, { error: String(e.message) }); }
    },
  });

  register({
    kind: 'exact',
    path: '/api/dsh-punky-swarm/sessions',
    handler(req, res) {
      try {
        // 全部有批次的 session 概览（含每 session 批次计数）
        const sessions = store.listSessions().map((s) => ({ sessionId: s, batchCount: store.listBatches(s).length }));
        sendJson(res, 200, { sessions });
      } catch (e) { sendJson(res, 500, { error: String(e.message) }); }
    },
  });

  register({
    kind: 'exact',
    path: '/api/dsh-punky-swarm/batch',
    handler(req, res) {
      try {
        const { batchId, session } = q(req.url);
        if (!batchId) return sendJson(res, 400, { error: 'batchId required' });
        if (!session) return sendJson(res, 400, { error: 'session required' });
        const b = store.readBatch(session, batchId);
        if (!b) return sendJson(res, 404, { error: 'batch-not-found' });
        // 每 lane attempt（review->running 返工计数）与升级标记（>=3）由事件推导
        const laneAttempts = {};
        const upgrades = {};
        for (const e of b.events) {
          if (e.type === 'member.settled' && e.from === 'review' && e.to === 'running') {
            laneAttempts[e.lane] = (laneAttempts[e.lane] ?? 0) + 1;
          }
        }
        for (const lane of Object.keys(b.lanes)) {
          upgrades[lane] = (laneAttempts[lane] ?? 0) >= 3 && (b.lanes[lane] === 'review' || b.lanes[lane] === 'failed');
        }
        sendJson(res, 200, {
          batchId: b.batchId, session, phase: b.phase, concurrency: b.concurrency,
          lanes: b.lanes, wavePlan: b.wavePlan,
          eventCount: b.events.length, recentEvents: b.events.slice(-20),
          settled: store.batchSettled(b),
          autoReleaseable: store.batchAutoReleaseable(b),
          viewSettled: (b.phase === 'complete' || b.phase === 'aborted') ? true : store.batchSettled(b),
          laneAttempts,
          upgrades,
          lanesGate: Object.fromEntries(Object.keys(b.lanes).map((l) => [l, store.gateStatus(session, batchId, l)])),
        });
      } catch (e) { sendJson(res, 500, { error: String(e.message) }); }
    },
  });

  register({
    kind: 'exact',
    path: '/api/dsh-punky-swarm/mailbox',
    handler(req, res) {
      try {
        const { batchId, box, lane, session } = q(req.url);
        if (!batchId || !box) return sendJson(res, 400, { error: 'batchId+box required' });
        if (!session) return sendJson(res, 400, { error: 'session required' });
        const b = box === 'outbox' ? { type: 'outbox', lane } : { type: box };
        const items = mailbox.readUnacked(join(root, 'sessions', session, 'mailbox', batchId), b);
        sendJson(res, 200, { items });
      } catch (e) { sendJson(res, 500, { error: String(e.message) }); }
    },
  });

  register({
    kind: 'exact',
    path: '/api/dsh-punky-swarm/locks',
    handler(req, res) {
      try {
        const { session } = q(req.url);
        if (!session) return sendJson(res, 400, { error: 'session required' });
        const locksDir = join(root, 'sessions', session, '.locks');
        const locks = existsSync(locksDir) ? readdirSync(locksDir).map((f) => {
          try { return { lock: f, ...JSON.parse(readFileSync(join(locksDir, f), 'utf8')) }; }
          catch { return { lock: f }; }
        }) : [];
        sendJson(res, 200, { session, locks });
      } catch (e) { sendJson(res, 500, { error: String(e.message) }); }
    },
  });

  return { dispose() { for (const d of disposers) { try { d?.(); } catch {} } } };
}
