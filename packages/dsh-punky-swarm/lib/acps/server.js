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

//   - 独立 HTTPS 监听器（node:https + node:tls，零新依赖），默认端口 9443、绑定 127.0.0.1（config 可配）；

import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateAic } from '../aip/identity.js';
import { buildAgentDescriptor } from '../aip/agent-descriptor.js';
import { DEFAULT_ASSEMBLY } from '../assembly.js';
import { engineVersion } from '../aip/tool-descriptor.js';
import { ensureAcpsCerts } from './certs.js';
import { AIP_COMMAND_TYPES as TASK_COMMAND_TYPES, TASK_STATES } from '../comms/aip-format.js';
import { sendJson } from '../json-response.js';

export const JSONRPC_VERSION = '2.0';
const RPC_METHOD = 'rpc';
export { TASK_COMMAND_TYPES, TASK_STATES };

const RPC_ERRORS = Object.freeze({
  PARSE: { code: -32700, message: 'Parse error' },
  INVALID_REQUEST: { code: -32600, message: 'Invalid Request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INVALID_PARAMS: { code: -32602, message: 'Invalid params' },
  INTERNAL: { code: -32603, message: 'Internal error' },
});

export function parseRpcRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: { ...RPC_ERRORS.INVALID_REQUEST, data: 'body must be a JSON object' } };
  }
  if (body.jsonrpc !== JSONRPC_VERSION) {
    return { ok: false, error: { ...RPC_ERRORS.INVALID_REQUEST, data: 'jsonrpc must be "2.0"' } };
  }
  if (body.method !== RPC_METHOD) {
    return { ok: false, error: { ...RPC_ERRORS.METHOD_NOT_FOUND, data: 'method must be "rpc"' } };
  }
  const command = body?.params?.command;
  if (command === null || typeof command !== 'object' || Array.isArray(command)) {
    return { ok: false, error: { ...RPC_ERRORS.INVALID_PARAMS, data: 'params.command (TaskCommand) is required' } };
  }
  if (command.type !== 'task-command') {
    return { ok: false, error: { ...RPC_ERRORS.INVALID_PARAMS, data: 'command.type must be "task-command"' } };
  }
  if (typeof command.command !== 'string' || !TASK_COMMAND_TYPES.includes(command.command)) {
    return { ok: false, error: { ...RPC_ERRORS.INVALID_PARAMS, data: 'command.command must be one of: ' + TASK_COMMAND_TYPES.join(', ') } };
  }
  return { ok: true, request: body, command };
}

export function rpcResponse(id, result, error) {
  const out = { jsonrpc: JSONRPC_VERSION, id: id ?? null };
  if (error) out.error = error;
  else out.result = result;
  return out;
}

export function defaultRpcHandler(command, ctx = {}) {
  const now = new Date().toISOString();
  const taskId = typeof command?.taskId === 'string' && command.taskId.length > 0
    ? command.taskId
    : (typeof command?.id === 'string' ? command.id : 'task-' + Date.now().toString(36));
  const result = {
    type: 'task-result',
    id: typeof command?.id === 'string' ? command.id : taskId,
    sentAt: now,
    senderRole: 'partner',
    senderId: ctx?.peerAic ?? 'dsh-punky-swarm',
    taskId,
    status: { state: 'accepted', stateChangedAt: now },
    commandHistory: [command],
  };
  return result;
}

export function buildAcs(config = {}, opts = {}) {
  const endpoint = config?.endpoint ?? {};
  const host = endpoint.host ?? '127.0.0.1';
  const port = endpoint.port ?? 9443;
  const assembly = opts.assembly ?? DEFAULT_ASSEMBLY;
  const engineInfo = opts.engineInfo ?? {};
  return buildAgentDescriptor(assembly, 'plan', 'coordinator', {
    ...engineInfo,
    version: engineInfo.version ?? engineVersion(),
    aic: endpoint.aic ?? engineInfo.aic ?? `${assembly.team}.plan.coordinator`, // 派生占位；V3 注册后经 config 覆盖
    securitySchemes: {
      mtls: { type: 'mutualTLS', description: '智能体间mTLS双向认证' },
    },
    endPoints: [{
      url: `https://${host}:${port}/acps/rpc`,
      transport: 'JSONRPC',
      security: [{ mtls: [] }],
    }],
    certificate: { altNames: { dns: ['localhost'] } },
    capabilities: { streaming: false, notification: false, messageQueue: [] },
  });
}

// 【④ 同名不同物改名】本函数与 `lib/mcp/data-plane-server.js` 的同名实现曾撞名（两个独立 HTTP
//   服务各一份，未见同源）⇒ 本处改 `readAcpsRequestBody`（ACPS 面）；数据面侧改 `readDataPlaneRequestBody`。
//   两侧独立、**禁合并**（返回形态不同：本处吃 `req.body` 预解析 + JSON.parse，那边只拼 Buffer）。
function readAcpsRequestBody(req) {
  if (req && typeof req.body === 'string') return Promise.resolve(req.body ? JSON.parse(req.body) : {});
  if (req && req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (req && typeof req.on === 'function') {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (c) => { data += c; });
      req.on('end', () => {
        try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
      });
      req.on('error', reject);
    });
  }
  return Promise.resolve({});
}

export function createAcpsServer({ config = {}, logger, acsProvider, rpcHandler, healthProvider, certDir } = {}) {
  const endpoint = config?.endpoint ?? {};
  const agentName = endpoint.agentName ?? 'dsh-punky-swarm';

  let tls;
  try {
    const dir = certDir ?? endpoint.certDir;
    const ca = endpoint.ca ?? (dir ? join(dir, 'ca.pem') : null);
    if (!endpoint.cert || !endpoint.key || !ca) {
      if (!dir) return { error: 'acps endpoint: cert/key/ca 三路径均需配置，或提供 certDir 自动生成' };
      const generated = ensureAcpsCerts({ dir, aic: endpoint.aic });
      tls = {
        cert: endpoint.cert ? readFileSync(endpoint.cert) : readFileSync(generated.certFile),
        key: endpoint.key ? readFileSync(endpoint.key) : readFileSync(generated.keyFile),
        ca: readFileSync(generated.caFile),
      };
    } else {
      tls = { cert: readFileSync(endpoint.cert), key: readFileSync(endpoint.key), ca: readFileSync(ca) };
    }
    const now = Date.now();
    const requireValid = (pemBuf, what) => {
      const x = new X509Certificate(pemBuf);
      if (x.validToDate.getTime() <= now) throw new Error(what + '已过期（validTo=' + x.validTo + '）');
      if (x.validFromDate.getTime() > now) throw new Error(what + '尚未生效（validFrom=' + x.validFrom + '）');
    };
    try {
      requireValid(tls.cert, '服务端证书');
      requireValid(tls.ca, 'CA 证书'); // CA 过期症状与叶证书完全相同（全握手失败），一并 fail-closed
    } catch (e) {
      return { error: 'acps endpoint: ' + e.message + '——更新 cert/key 或删除 certDir 让 ensureAcpsCerts 重签（acps endpoint 保持禁用）' };
    }
  } catch (e) {
    return { error: 'acps endpoint: 证书加载失败——' + e.message };
  }

  const devInsecure = endpoint.devInsecure === true;
  if (devInsecure) {
    logger?.warn?.('[dsh-punky-swarm] acps endpoint: devInsecure=true（仅开发档）——降级范围明确为：'
      + '① TLS 层验签关闭（rejectUnauthorized=false ⇒ 握手不再校验对端证书链/属性/EKU/有效期，证书错误不再断连）；'
      + '② 应用层仍强制信任锚：对端证书必须由 acps.endpoint.ca 签发且签名可验，否则三端点一律 403'
      + '（no-peer-certificate / peer-cert-not-anchored）；'
      + '③ 未放宽项：peer CN 仍须为合法 AIC（/acps/rpc 400 语义不变）、证书有效期与信任锚不放宽。生产禁止开启');
  }
  //   必须自行把对端证书链锚定到配置 ca，否则攻击者 CA 签发的合法格式证书即 fail-open。
  function parseTrustAnchors(pemOrBuf) {
    const pem = Buffer.isBuffer(pemOrBuf) ? pemOrBuf.toString('utf8') : String(pemOrBuf ?? '');
    const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
    return (blocks.length ? blocks : [pemOrBuf]).map((b) => new X509Certificate(b));
  }
  const caAnchor = devInsecure ? parseTrustAnchors(tls.ca) : null;
  function peerAnchorFail(req) {
    if (!caAnchor) return null; // 生产档：TLS 层已强制验签链，此处零开销、零行为变更
    let peer = null;
    try { peer = req.socket?.getPeerX509Certificate?.() ?? null; } catch { peer = null; }
    if (!peer) return { reason: 'no-peer-certificate' };
    const anchored = caAnchor.some((ca) => {
      try { return peer.checkIssued(ca) && peer.verify(ca.publicKey); } catch { return false; }
    });
    return anchored ? null : { reason: 'peer-cert-not-anchored' };
  }
  const server = https.createServer({
    key: tls.key,
    cert: tls.cert,
    ca: tls.ca,
    minVersion: endpoint.minVersion ?? 'TLSv1.3', // TLS 最低版本
    requestCert: true,                            // CERT_REQUIRED 语义（main_mtls.py:28）
    rejectUnauthorized: devInsecure ? false : true, // 生产不允许降级；开发模式仅显式开启
    handshakeTimeout: 10_000,
  }, (req, res) => {
    handleRequest(req, res).catch((e) => {
      logger?.warn?.('[dsh-punky-swarm] acps endpoint error: ' + String(e));
      sendJson(res, 500, rpcResponse(null, null, { ...RPC_ERRORS.INTERNAL, data: String(e.message) }));
    });
  });

  function getPeerAic(req) {
    try {
      const peer = req.socket?.getPeerCertificate?.();
      return peer?.subject?.CN ?? null;
    } catch {
      return null;
    }
  }

  async function handleRequest(req, res) {
    const peerAic = getPeerAic(req);
    req.peerAic = peerAic; // 注入请求级身份
    const anchorFail = peerAnchorFail(req);
    if (anchorFail) {
      logger?.warn?.('[dsh-punky-swarm] acps endpoint: devInsecure peer rejected (' + anchorFail.reason + ')');
      return sendJson(res, 403, { error: anchorFail.reason, hint: 'devInsecure 不放宽信任锚：对端证书须由 acps.endpoint.ca 签发' });
    }
    const url = (req.url ?? '').split('?')[0];

    if (req.method === 'GET' && url === '/.well-known/acs.json') {
      const acs = (acsProvider ? acsProvider() : buildAcs(config)) ?? buildAcs(config);
      return sendJson(res, 200, acs);
    }
    if (req.method === 'GET' && url === '/health') {
      const health = healthProvider
        ? healthProvider({ peerAic })
        : { agent: agentName, status: 'online', tasks: { active: 0 }, groups: { active: 0 } };
      return sendJson(res, 200, health);
    }
    if (req.method === 'POST' && url === '/acps/rpc') {
      if (!peerAic || !validateAic(peerAic)) {
        return sendJson(res, 400, rpcResponse(null, null, { code: 40001, message: 'Invalid client certificate identity: peer CN must be a valid AIC', data: { peerAic: peerAic ?? null } }));
      }
      let body;
      try {
        body = await readAcpsRequestBody(req);
      } catch {
        return sendJson(res, 400, rpcResponse(null, null, { ...RPC_ERRORS.PARSE, data: 'invalid JSON body' }));
      }
      const parsed = parseRpcRequest(body);
      if (!parsed.ok) {
        return sendJson(res, 400, rpcResponse(body?.id ?? null, null, parsed.error));
      }
      const handler = rpcHandler ?? defaultRpcHandler;
      const result = await handler(parsed.command, { peerAic, request: parsed.request });
      return sendJson(res, 200, rpcResponse(parsed.request.id ?? null, result, null));
    }

    return sendJson(res, 404, { error: 'not-found', path: url });
  }

  return {
    server,
    getPeerAic,
    listen(port) {
      const p = port ?? endpoint.port ?? 9443;
      return new Promise((resolve, reject) => {
        const onError = (e) => { server.off('listening', onListening); reject(e); };
        const onListening = () => { server.off('error', onError); resolve(server.address()); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(p, endpoint.host ?? '127.0.0.1');
      });
    },
    close() {
      return new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
    address() {
      return server.address();
    },
  };
}
