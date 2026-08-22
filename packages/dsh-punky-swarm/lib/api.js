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

// dsh-punky-swarm 只读治理 API：batches / batch / mailbox / locks（全部按 session 隔离）
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as mailbox from './comms/mailbox.js';

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function q(url) {
  return Object.fromEntries(new URL(url, 'http://localhost').searchParams.entries());
}

export function createApi(ctx, deps) {
  const { store, root, catalog, agentCatalog, aipFormat, discovery } = deps;
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
          // P6 接线（exec-format-wire）：装配注入 aipFormat 时附 ACPs Session 投影（纯函数，不改存储；缺省不附 → 既有响应不变）
          ...(aipFormat ? { aipSession: aipFormat.toAipSession(b) } : {}),
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
        // P6 接线（exec-format-wire）：装配注入 aipFormat 时逐条附 ACPs Message 投影（纯函数投影，不改 mailbox 存储与 ack 语义）
        sendJson(res, 200, aipFormat ? { items: items.map((it) => ({ ...it, aip: aipFormat.toAipMessage(it) })) } : { items });
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

  // 国标 AIP P0-1 工具列表同步（方案 A：只读 API 端点）：catalog 非空（缺省默认开启）时注册 /tools；
  // 仅显式 aip.enabled=false 时 catalog 为 null，不注册该路由（保持既有 6 路由契约）。
  // catalog 由 register.js 经 readCapability 默认合并口径提供——本条件与 enabled 联动，此处零逻辑改动。
  if (catalog) {
    register({
      kind: 'exact',
      path: '/api/dsh-punky-swarm/tools',
      handler(req, res) {
        try {
          const { name } = q(req.url);
          const tools = name ? catalog.list().filter((d) => d.name === name) : catalog.list();
          sendJson(res, 200, { count: tools.length, tools, generatedAt: catalog.generatedAt });
        } catch (e) { sendJson(res, 500, { error: String(e.message) }); }
      },
    });
  }

  // P4 ACS 智能体描述目录：enabled=true 时 agentCatalog 非空，注册 /agents；
  // 端点输出 ACS 字段集（AgentCapabilitySpec，逐字字段见 lib/aip/agent-descriptor.js）；只读、无参。
  // enabled=false（默认）时 agentCatalog 为 null，不注册该路由（既有路由契约不变）。
  if (agentCatalog) {
    register({
      kind: 'exact',
      path: '/api/dsh-punky-swarm/agents',
      handler(req, res) {
        try {
          const agents = agentCatalog.list();
          sendJson(res, 200, { count: agents.length, agents, generatedAt: agentCatalog.generatedAt });
        } catch (e) { sendJson(res, 500, { error: String(e.message) }); }
      },
    });
  }
  // 国标 P5 发现服务（ADP 语义）：discovery 服务实例注入时注册
  //   POST /api/dsh-punky-swarm/discover — 统一发现查询（DiscoveryRequest → DiscoveryResponse）
  //   GET  /.well-known/aip          — 发现服务预置信息（地址/协议版本/能力概要）
  if (discovery) {
    register({
      kind: 'exact',
      path: '/api/dsh-punky-swarm/discover',
      handler(req, res) {
        return readJsonBody(req).then((body) => {
          const resp = discovery.discover(body);
          // 响应码映射：ADP 错误（result 缺省、error 存在）→ 400（客户端 4xxxx）/ 500（服务端 5xxxx）；成功 → 200
          const status = resp.error
            ? (String(resp.error.code).startsWith('5') ? 500 : 400)
            : 200;
          sendJson(res, status, resp);
        }).catch((e) => sendJson(res, 500, { error: { code: 50001, message: 'InternalError', data: String(e.message) } }));
      },
    });
    register({
      kind: 'exact',
      path: '/.well-known/aip',
      handler(req, res) {
        try {
          sendJson(res, 200, discovery.wellKnown());
        } catch (e) { sendJson(res, 500, { error: { code: 50001, message: 'InternalError', data: String(e.message) } }); }
      },
    });
  }

  return { dispose() { for (const d of disposers) { try { d?.(); } catch {} } } };
}

// 读取请求体（POST JSON）：兼容 webServer 注入的 node req（流式）与测试直调形态（req.body 预置）
function readJsonBody(req) {
  if (req && typeof req.body === 'string') {
    return Promise.resolve(req.body ? JSON.parse(req.body) : {});
  }
  if (req && req.body && typeof req.body === 'object') {
    return Promise.resolve(req.body);
  }
  if (req && typeof req.on === 'function') {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => { data += chunk; });
      req.on('end', () => {
        try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
      });
      req.on('error', reject);
    });
  }
  return Promise.resolve({});
}
