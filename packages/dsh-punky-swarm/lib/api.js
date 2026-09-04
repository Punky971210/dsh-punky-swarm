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

// dsh-punky-swarm 只读治理 API：batches / batch / mailbox / locks / stream（全部按 session 隔离）
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as mailbox from './comms/mailbox.js';
import { createStreamHub } from './panel/stream.js';
// P1 批 R-07 排除项（承接归 panel 批）：事件读端字面量收敛——EVT 常量源 lib/state/event-types.js（P2-07 单点）
import * as EVT from './state/event-types.js';
// WebUI 治理配置写通道（webui-config-build-20260903）：/config 端点 trusted 判定（自复刻宿主 /api
//   护栏语义，conn:184-198 未导出故复刻——插件 exact 路由不经宿主护栏，写端点须自理，见 config-trust.js）
import { isTrustedConfigRequest } from './webui/config-trust.js';

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

  // R3 SSE hub（设计 §3.3.3）：随 webServer 挂载（ADR-4：无独立配置键；降级回轮询即运行时自适配开关）。
  // 装配点（index.js 层，exec-a 批②）预留时经 deps.panelStream 注入复用（含 topic 触发源 attachTopic 接线）；
  // 缺省自建（fs.watch 单通道先行交付——契约移交点语义），自建者负责 dispose。
  const panelStream = deps.panelStream || createStreamHub({ root, logger: ctx.logger });
  if (!deps.panelStream) disposers.push(() => { try { panelStream.dispose(); } catch {} });

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
          if (e.type === EVT.EVT_MEMBER_SETTLED && e.from === 'review' && e.to === 'running') {
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
        // P2-08：box 枚举校验——非法 box 返回 400（含枚举提示）而非透传进 mailbox.readUnacked 抛错兜成 500
        const BOXES = ['inbox', 'outbox', 'broadcast'];
        if (!BOXES.includes(box)) {
          return sendJson(res, 400, { error: 'invalid box: ' + box + ' (allowed: ' + BOXES.join(' | ') + ')' });
        }
        // 可选加固：outbox 分支 lane 必填（readUnacked 按 lane 读 outbox，缺 lane 属调用错误）
        if (box === 'outbox' && !lane) return sendJson(res, 400, { error: 'lane required for outbox' });
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

  // 国标 AIP 工具列表同步（方案 A：只读 API 端点）：catalog 非空（缺省默认开启）时注册 /tools；
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

  // WebUI 治理配置写通道（webui-config-build-20260903，设计 §1.1/§1.2，落点 = discover 段与 stream 段之间）：
  //   GET + POST /api/dsh-punky-swarm/config —— 配置页页载取数 / 受控字段集保存（写 <root>/config/runtime.json）。
  //   条件注册仿 discovery/agentCatalog（上方 :162-190 注入形态）：deps.configEndpoints.runtimeConfig
  //   注入时注册；未注入不注册 → 既有 7 路由/9 路由计数测试零回归（不改既有注册面，disposer 统一回收）。
  //   trusted 判定（GET/POST 共用，§1.3）：Host loopback/trustedHosts + sec-fetch-site≠cross-site + Origin 同源
  //   （isTrustedConfigRequest，lib/webui/config-trust.js；trustedHosts 出厂 [] → loopback-only）。
  //   写逻辑全在 service（lib/webui/runtime-config.js）：白名单预检 400 → 读-改-写 → validateOverlay
  //   兜底 500 → tmp+rename 原子写；GET 取数 overlay（磁盘原样）/applied（装配侧解析快照）/presets（注册目录）。
  if (deps.configEndpoints?.runtimeConfig) {
    const cfgEp = deps.configEndpoints;
    const trustedHosts = Array.isArray(cfgEp.trustedHosts) ? cfgEp.trustedHosts : [];
    register({
      kind: 'exact',
      path: '/api/dsh-punky-swarm/config',
      handler(req, res) {
        // trusted 护栏前置（GET/POST 共用；护栏语义非鉴权层、防 DNS-rebinding/跨站——§1.2）
        if (!isTrustedConfigRequest(req, trustedHosts)) {
          const body = req.method === 'POST' ? { ok: false, error: 'forbidden' } : { error: 'forbidden' };
          return sendJson(res, 403, body);
        }
        if (req.method === 'GET') {
          try {
            const overlay = cfgEp.runtimeConfig.readOverlay();
            const gov = overlay && typeof overlay === 'object' && !Array.isArray(overlay)
              && overlay.governance && typeof overlay.governance === 'object' && !Array.isArray(overlay.governance)
              ? overlay.governance : null;
            const applied = typeof cfgEp.applied === 'function' ? cfgEp.applied() : null;
            const presets = typeof cfgEp.presets === 'function' ? (cfgEp.presets() ?? []) : [];
            // overlay = 磁盘 runtime.json governance 段原样（表单未保存改动基准；无 = null）；
            // applied = 装配侧已解析快照（默认补齐 + preset 展开 rules）；presets = 注册目录元数据 [{id,count}]
            sendJson(res, 200, { overlay: gov, applied: { hook: applied }, presets });
          } catch (e) { sendJson(res, 500, { error: String(e?.message ?? e) }); }
          return;
        }
        if (req.method === 'POST') {
          let bodyPromise;
          try {
            bodyPromise = readJsonBody(req); // req.body 为 string 时 JSON.parse 同步抛 → 先包住归 400
          } catch (e) {
            return sendJson(res, 400, { ok: false, error: 'invalid-json: ' + String(e?.message ?? e) });
          }
          return bodyPromise.then((payload) => {
            try {
              const out = cfgEp.runtimeConfig.writeGovernance(payload);
              if (!out.ok) {
                if (out.status === 500 || !Array.isArray(out.errors)) {
                  return sendJson(res, out.status || 500, { ok: false, error: out.error ?? 'write-rejected' });
                }
                return sendJson(res, 400, { ok: false, errors: out.errors });
              }
              return sendJson(res, 200, { ok: true, written: out.written, ts: new Date().toISOString() });
            } catch (e) {
              // 读-改-写 IO 异常（坏 base JSON / rename 失败等）→ 500 不回写（设计 §1.5「不应发生」面）
              return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
            }
          }).catch((e) => sendJson(res, 400, { ok: false, error: 'invalid-json: ' + String(e?.message ?? e) }));
        }
        return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
      },
    });
  }

  // R3 SSE 端点（设计 §3.3.3，纯新增路由——既有 /api 路由一字不动）：
  //   GET /api/dsh-punky-swarm/stream?session=<sid>[&batchId=<bid>]
  //   SSE 帧协议：event: batch|mailbox|heartbeat + data:<JSON>；注释心跳帧每 10s（hub 内维护）。
  //   推送只发轻量摘要 {sessionId,batchId,eventCount,updatedAt}，客户端回拉既有只读 API 取全量（ADR-5）。
  register({
    kind: 'exact',
    path: '/api/dsh-punky-swarm/stream',
    handler(req, res) {
      try {
        const { session, batchId } = q(req.url);
        if (!session) return sendJson(res, 400, { error: 'session required' });
        const st = panelStream.subscribe(session, batchId || null, res);
        if (!st.ok) {
          // 会话级连接数上限（≤8）→ 503；其余（缺 session/handshake 失败）→ 400
          const status = st.reason === 'limit' ? 503 : 400;
          try { sendJson(res, status, { error: st.reason === 'limit' ? 'too many stream connections for session' : st.reason }); } catch {}
          return;
        }
      } catch (e) {
        try { res.end(); } catch {}
      }
    },
  });

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
