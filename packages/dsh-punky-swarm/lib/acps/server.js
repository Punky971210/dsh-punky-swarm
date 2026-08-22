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

// 文件 server：ACPs 对外 mTLS 服务端点（lib/acps 域，P1 lane exec-acps-server）
// 契约：
//   - 独立 HTTPS 监听器（node:https + node:tls，零新依赖），默认端口 9443、绑定 127.0.0.1（config 可配）；
//   - TLS：minVersion TLSv1.3 + requestCert + rejectUnauthorized（=CERT_REQUIRED + TLSv1_3 语义，
//     对齐 registry-server/app/main_mtls.py:14-30）；devInsecure 仅显式开发开关（默认 false）；
//   - 客户端证书 CN 提取 → req.peerAic（对齐 registry-server/app/core/peer_cert.py:18-38）；
//     受保护端点 AIC 格式校验（复用 lib/aip/identity.js validateAic，对齐 api_atr.py:82-88）；
//   - 端点：POST /acps/rpc（AIP JSON-RPC，对齐 acps-sdk aip_rpc_model.py:15-57 +
//     aip_base_model.py TaskCommand/TaskResult 形态）、GET /.well-known/acs.json（ACS 直取，
//     复用 lib/aip/agent-descriptor.js，对齐 beijing_food/acs.json:15-40）、GET /health
//     （对齐 demo-partner/partners/main.py:110-121）；
//   - 路径前缀 /acps/*——与既有 /api/dsh-punky-swarm/*、/.well-known/aip 不冲突；
//   - 默认关：装配层 enabled=false 时不实例化本模块（零运行时路径）。
// 纯工厂 + 纯函数，模块顶层零副作用。

import https from 'node:https';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateAic } from '../aip/identity.js';
import { buildAgentDescriptor } from '../aip/agent-descriptor.js';
import { DEFAULT_ASSEMBLY } from '../assembly.js';
import { engineVersion } from '../aip/tool-descriptor.js';
import { ensureAcpsCerts } from './certs.js';

// ── AIP RPC 常量（对齐参考实现 aip_base_model.py:23-49 / aip_rpc_model.py:15-57）──
export const JSONRPC_VERSION = '2.0';
export const RPC_METHOD = 'rpc';
// TaskCommandType 枚举（aip_base_model.py:44-49）
export const TASK_COMMAND_TYPES = ['get', 'start', 'continue', 'cancel', 'complete', 're-stream'];
// TaskState 状态链（aip_base_model.py:23-33）
export const TASK_STATES = ['accepted', 'working', 'awaiting-input', 'awaiting-completion', 'completed', 'canceled', 'failed', 'rejected'];

// JSON-RPC 2.0 标准错误码（JSON-RPC 2.0 规范；参考实现 JSONRPCError 形态 aip_rpc_model.py:24-29）
export const RPC_ERRORS = Object.freeze({
  PARSE: { code: -32700, message: 'Parse error' },
  INVALID_REQUEST: { code: -32600, message: 'Invalid Request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INVALID_PARAMS: { code: -32602, message: 'Invalid params' },
  INTERNAL: { code: -32603, message: 'Internal error' },
});

/**
 * 解析并校验 AIP JSON-RPC 请求信封（aip_rpc_model.py:15-21,41-51 语义）
 * @param {any} body 已解析的请求体
 * @returns {{ ok: true, request: object, command: object } | { ok: false, error: { code, message, data? } }}
 * 校验链：jsonrpc==="2.0" → method==="rpc" → params.command（TaskCommand）存在且
 * type==="task-command" → command.command ∈ TaskCommandType 枚举（aip_base_model.py:154-164）。
 */
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

/**
 * JSON-RPC 响应信封（aip_rpc_model.py:32-38,54-57：result 或 error 二选一）
 */
export function rpcResponse(id, result, error) {
  const out = { jsonrpc: JSONRPC_VERSION, id: id ?? null };
  if (error) out.error = error;
  else out.result = result;
  return out;
}

/**
 * 默认 RPC handler：TaskCommand → TaskResult（state=accepted，TaskState 链首环）
 * 对齐 aip_base_model.py:167-181（TaskResult: type/taskId/status{state,stateChangedAt}）。
 * 端点载体与消息形态校验；桥接注入自实现把 command 转 mailbox。
 * @param {object} command TaskCommand
 * @param {object} [ctx] { peerAic? }
 * @returns {object} TaskResult
 */
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

/**
 * ACS 直取内容生成（/.well-known/acs.json）——复用 lib/aip/agent-descriptor.js（ACS 14 必填键），
 * 对齐 beijing_food/acs.json:15-40（securitySchemes.mutualTLS + endPoints JSONRPC + certificate.altNames.dns）。
 * @param {object} config resolveAcpsConfig 输出（endpoint: { aic, host, port }）
 * @param {object} [opts] { assembly?, engineInfo? }（测试可注入）
 */
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
    // 对齐参考实现 demo acs.json（beijing_food/acs.json:15-40）：
    // securitySchemes.mutualTLS + endPoints[{url, transport:'JSONRPC', security:[{mtls:[]}]}] + certificate.altNames.dns
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

// 请求体读取（与 lib/api.js readJsonBody 同形态：兼容流式 req 与预置 body）
function readBody(req) {
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

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

/**
 * 创建 ACPs 对外 mTLS 服务端点（纯工厂，不自动 listen）
 * @param {object} opts { config, logger?, acsProvider?, rpcHandler?, healthProvider?, certDir? }
 *   config = resolveAcpsConfig 输出（endpoint: { port, host, cert, key, ca, certDir, minVersion, devInsecure, aic }）
 *   acsProvider 缺省 = buildAcs(config)；rpcHandler 缺省 = defaultRpcHandler；
 *   healthProvider 缺省 = { agent, status:'online', tasks:{active:0}, groups:{active:0} }（partners/main.py:110-121 形态）
 * @returns {{ server: import('node:https').Server, listen(port?), close(), address(), getPeerAic(req) }}
 *   证书缺失/不可用时返回 { error }（装配层告警并保持禁用，不阻塞主进程）
 */
export function createAcpsServer({ config = {}, logger, acsProvider, rpcHandler, healthProvider, certDir } = {}) {
  const endpoint = config?.endpoint ?? {};
  const agentName = endpoint.agentName ?? 'dsh-punky-swarm';

  // ── 证书加载（cert/key/ca 三路径；缺省从 certDir 自动生成——幂等）──
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
  } catch (e) {
    return { error: 'acps endpoint: 证书加载失败——' + e.message };
  }

  const devInsecure = endpoint.devInsecure === true;
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

  // 客户端证书 CN 提取（peer_cert.py:18-38：握手证书 subject.CN = 对端 AIC）
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
      // 应用层身份校验（TLS 通过后）：peer CN 须为合法 AIC 格式（api_atr.py:82-88 validate_aic 400 语义）
      if (!peerAic || !validateAic(peerAic)) {
        return sendJson(res, 400, rpcResponse(null, null, { code: 40001, message: 'Invalid client certificate identity: peer CN must be a valid AIC', data: { peerAic: peerAic ?? null } }));
      }
      let body;
      try {
        body = await readBody(req);
      } catch {
        return sendJson(res, 400, rpcResponse(null, null, { ...RPC_ERRORS.PARSE, data: 'invalid JSON body' }));
      }
      const parsed = parseRpcRequest(body);
      if (!parsed.ok) {
        // JSON-RPC 消息结构非法 → 应用层 400 + JSON-RPC error body（参考实现 pydantic 校验 422 语义映射，允许 4xx）
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
    // listen：port 覆盖 config（测试用 0=临时端口）；返回 promise（error 事件拒绝）
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
        // 长连接兜底
        server.closeAllConnections?.();
      });
    },
    address() {
      return server.address();
    },
  };
}
