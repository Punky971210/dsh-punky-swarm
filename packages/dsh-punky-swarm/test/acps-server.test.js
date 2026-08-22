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

// P1 mTLS 服务端点测试（aip-acps-comm-build exec-acps-server）
// 分层（施工契约 §六 V5）：TLS 层（握手失败类——断言连接失败/握手异常，不断言 HTTP 状态码）
//   + 应用层（TLS 通过后——可断言 4xx/2xx）。参考实现出处见 exec/acps-server.md 映射表。
// 信任锚一致性：服务端经 certDir 自动生成 CA+服务端证书（ensureAcpsCerts），测试客户端
//   用同一 certDir 的 CA 签发客户端证书（CN=客户端 AIC）——双向同一信任锚（main_mtls.py:27-29 语义）。
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAcpsServer, parseRpcRequest, rpcResponse, defaultRpcHandler, buildAcs, JSONRPC_VERSION } from '../lib/acps/server.js';
import { generateCaCert, issueCert, ensureAcpsCerts } from '../lib/acps/certs.js';
import { resolveAcpsConfig } from '../lib/schema.js';
import { generateAic, validateAic } from '../lib/aip/identity.js';
import { ACS_REQUIRED_FIELDS } from '../lib/aip/agent-descriptor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── fixture：合法 AIC（CRC 校验通过）──
const SERVER_AIC = generateAic({ ontologySerial: '000000' }); // 本体 AIC（占位，V3 注册后经 config 覆盖）
const CLIENT_AIC = generateAic({ ontologySerial: 'ABCDEF' }); // 客户端（外部节点）AIC
const OTHER_CA = generateCaCert({ cn: 'other-ca' });          // 未知 CA（拒绝场景）
const UNKNOWN_CLIENT = issueCert({ caCertPem: OTHER_CA.certPem, caKeyPem: OTHER_CA.keyPem, cn: CLIENT_AIC, aic: CLIENT_AIC, usages: ['clientAuth'] });

// mTLS 请求 helper（对齐 AipRpcClient ssl_context 语义：客户端持 CA 签发证书）
function request({ port, path: p, method = 'GET', ca, cert, key, body, rejectUnauthorized = true }) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: 'localhost',
      port,
      path: p,
      method,
      ca,
      cert,
      key,
      minVersion: 'TLSv1.3',
      rejectUnauthorized,
      servername: 'localhost',
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
        catch (e) { resolve({ status: res.statusCode, body: data, parseError: e }); }
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

// 起服务（临时端口 0）：certDir 自动生成 CA+服务端证书，并用该 CA 签发客户端证书
async function startServer(overrides = {}) {
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-acps-'));
  const files = ensureAcpsCerts({ dir: certDir, aic: SERVER_AIC });
  const caCertPem = fs.readFileSync(path.join(certDir, 'ca.pem'), 'utf8');
  const caKeyPem = fs.readFileSync(path.join(certDir, 'ca.key'), 'utf8');
  const client = issueCert({ caCertPem, caKeyPem, cn: CLIENT_AIC, aic: CLIENT_AIC, usages: ['clientAuth'] });
  const config = resolveAcpsConfig({
    acps: { enabled: true, endpoint: { enabled: true, port: 0, aic: SERVER_AIC, ...overrides } },
  });
  const acps = createAcpsServer({ config, certDir, logger: { info() {}, warn() {} } });
  assert.ok(!acps.error, 'server must start: ' + (acps.error ?? ''));
  const addr = await acps.listen(0); // 显式临时端口（resolveAcpsConfig 将配置 port:0 钳制回 9443）
  return {
    acps, port: addr.port, certDir, caPem: caCertPem, client,
    req: (o) => request({ ...o, port: addr.port, ca: caCertPem, cert: client.certPem, key: client.keyPem }),
    close: () => acps.close(),
  };
}

// ── 证书材料（certs.js）──

test('certs: CA 签发链可被 X509Certificate 解析并验证', () => {
  const ca = generateCaCert();
  const client = issueCert({ caCertPem: ca.certPem, caKeyPem: ca.keyPem, cn: CLIENT_AIC, aic: CLIENT_AIC, usages: ['clientAuth'] });
  const caCert = new crypto.X509Certificate(ca.certPem);
  const clientCert = new crypto.X509Certificate(client.certPem);
  assert.match(caCert.subject, /CN=dsh-punky-swarm CA/);
  assert.match(clientCert.subject, new RegExp('CN=' + CLIENT_AIC));
  assert.match(clientCert.subjectAltName, new RegExp('acps://' + CLIENT_AIC)); // CAI 语义 SAN（identity.js:24-27）
  assert.equal(clientCert.verify(caCert.publicKey), true); // 客户端证书由 CA 签发
});

test('certs: ensureAcpsCerts 幂等落盘三路径（D3=C1 文件）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-acps-files-'));
  const first = ensureAcpsCerts({ dir, aic: SERVER_AIC });
  const second = ensureAcpsCerts({ dir, aic: SERVER_AIC });
  assert.equal(first.certFile, second.certFile);
  assert.ok(fs.existsSync(first.caFile) && fs.existsSync(first.certFile));
  assert.equal(fs.readFileSync(first.certFile, 'utf8'), fs.readFileSync(second.certFile, 'utf8')); // 复用不重生成
  new crypto.X509Certificate(fs.readFileSync(first.certFile, 'utf8')); // 可解析
});

// ── 消息契约（parseRpcRequest / rpcResponse / defaultRpcHandler，对齐 aip_rpc_model.py）──

test('rpc: 合法 TaskCommand 解析通过（method=rpc, params.command.type=task-command）', () => {
  const body = {
    jsonrpc: '2.0', method: 'rpc', id: 'req-1',
    params: { command: { type: 'task-command', id: 't-1', command: 'start', taskId: 't-1', commandParams: { role: 'coder' } } },
  };
  const r = parseRpcRequest(body);
  assert.equal(r.ok, true);
  assert.equal(r.command.command, 'start');
  assert.equal(r.command.taskId, 't-1');
});

test('rpc: 非法信封被拒（jsonrpc/method/command.type/command 枚举——aip_base_model.py:44-49）', () => {
  assert.equal(parseRpcRequest(null).ok, false);
  assert.equal(parseRpcRequest({ jsonrpc: '1.0', method: 'rpc' }).ok, false);
  assert.equal(parseRpcRequest({ jsonrpc: '2.0', method: 'nope' }).ok, false);
  assert.equal(parseRpcRequest({ jsonrpc: '2.0', method: 'rpc', params: {} }).ok, false);
  assert.equal(parseRpcRequest({ jsonrpc: '2.0', method: 'rpc', params: { command: { type: 'message' } } }).ok, false);
  assert.equal(parseRpcRequest({ jsonrpc: '2.0', method: 'rpc', params: { command: { type: 'task-command', command: 'bogus' } } }).ok, false);
});

test('rpc: rpcResponse 信封 result/error 二选一（aip_rpc_model.py:32-38）', () => {
  assert.deepEqual(rpcResponse('id-1', { ok: 1 }), { jsonrpc: '2.0', id: 'id-1', result: { ok: 1 } });
  assert.deepEqual(rpcResponse('id-1', null, { code: -32601, message: 'x' }), { jsonrpc: '2.0', id: 'id-1', error: { code: -32601, message: 'x' } });
});

test('rpc: defaultRpcHandler 返回 accepted TaskResult（TaskState 链首环，aip_base_model.py:167-181）', () => {
  const cmd = { type: 'task-command', id: 't-1', command: 'start', taskId: 't-1' };
  const r = defaultRpcHandler(cmd, { peerAic: CLIENT_AIC });
  assert.equal(r.type, 'task-result');
  assert.equal(r.taskId, 't-1');
  assert.equal(r.senderRole, 'partner');
  assert.equal(r.status.state, 'accepted');
  assert.ok(r.status.stateChangedAt);
  assert.deepEqual(r.commandHistory, [cmd]);
});

// ── ACS 生成（buildAcs，对齐 beijing_food/acs.json:15-40）──

test('acs: ACS 内容含必填 14 键 + mutualTLS + JSONRPC 端点', () => {
  const acs = buildAcs({ endpoint: { aic: SERVER_AIC, host: '127.0.0.1', port: 9443 } });
  for (const k of ACS_REQUIRED_FIELDS) assert.ok(k in acs, 'missing required ACS field: ' + k);
  assert.equal(acs.aic, SERVER_AIC);
  assert.equal(acs.securitySchemes.mtls.type, 'mutualTLS'); // beijing_food/acs.json:15-20
  assert.equal(acs.endPoints[0].transport, 'JSONRPC');       // beijing_food/acs.json:21-30
  assert.match(acs.endPoints[0].url, /\/acps\/rpc$/);
  assert.deepEqual(acs.endPoints[0].security, [{ mtls: [] }]);
  assert.deepEqual(acs.certificate.altNames.dns, ['localhost']); // beijing_food/acs.json:41-45
});

// ── TLS 层（V5：握手失败类只断言连接/握手异常，不断言 HTTP 状态码）──

test('mTLS 握手成功：客户端持 CA 签发证书可访问', async () => {
  const { req, close } = await startServer();
  try {
    const r = await req({ path: '/health' });
    assert.equal(r.status, 200);
  } finally { await close(); }
});

test('TLS 层：无客户端证书被拒（requestCert CERT_REQUIRED 语义，main_mtls.py:28）', async () => {
  const { port, caPem, close } = await startServer();
  try {
    await assert.rejects(
      () => request({ port, path: '/health', ca: caPem, cert: undefined, key: undefined }),
      (e) => /ECONNRESET|EPIPE|certificate|handshake|unable|CERT/i.test(String(e.message ?? e.code ?? e)),
      '无客户端证书必须握手失败（TLS 层，无 HTTP 状态码可断言）',
    );
  } finally { await close(); }
});

test('TLS 层：未知 CA 签发的客户端证书被拒（rejectUnauthorized）', async () => {
  const { port, caPem, close } = await startServer();
  try {
    await assert.rejects(
      () => request({ port, path: '/health', ca: caPem, cert: UNKNOWN_CLIENT.certPem, key: UNKNOWN_CLIENT.keyPem }),
      (e) => /certificate|handshake|unable|ECONNRESET|CERT|hang up/i.test(String(e.message ?? e.code ?? e)),
      '未知 CA 客户端必须握手失败（TLS 层）',
    );
  } finally { await close(); }
});

// ── 应用层（TLS 通过后，可断言状态码）──

test('app: POST /acps/rpc 消息往返（TaskCommand → accepted TaskResult）', async () => {
  const { req, close } = await startServer();
  try {
    const r = await req({
      path: '/acps/rpc', method: 'POST',
      body: {
        jsonrpc: '2.0', method: 'rpc', id: 'req-42',
        params: { command: { type: 'task-command', id: 't-42', command: 'start', taskId: 't-42', commandParams: { role: 'coder' } } },
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.jsonrpc, JSONRPC_VERSION);
    assert.equal(r.body.id, 'req-42');
    assert.equal(r.body.result.type, 'task-result');
    assert.equal(r.body.result.status.state, 'accepted');
    assert.equal(r.body.result.senderId, CLIENT_AIC); // 对端 CN 注入回执（peerAic）
  } finally { await close(); }
});

test('app: POST /acps/rpc 非法 method → 400 + JSON-RPC error（应用层）', async () => {
  const { req, close } = await startServer();
  try {
    const r = await req({
      path: '/acps/rpc', method: 'POST',
      body: { jsonrpc: '2.0', method: 'group/rpc', id: 'x' },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, -32601);
  } finally { await close(); }
});

test('app: POST /acps/rpc 非法 params.command → 400（应用层）', async () => {
  const { req, close } = await startServer();
  try {
    const r = await req({
      path: '/acps/rpc', method: 'POST',
      body: { jsonrpc: '2.0', method: 'rpc', id: 'x', params: { command: { type: 'message', command: 'start' } } },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, -32602);
  } finally { await close(); }
});

test('app: GET /.well-known/acs.json 返回 ACS（14 必填键 + mTLS 端点）', async () => {
  const { req, close } = await startServer();
  try {
    const r = await req({ path: '/.well-known/acs.json' });
    assert.equal(r.status, 200);
    for (const k of ACS_REQUIRED_FIELDS) assert.ok(k in r.body, 'missing ' + k);
    assert.equal(r.body.securitySchemes.mtls.type, 'mutualTLS');
    assert.match(r.body.endPoints[0].url, /\/acps\/rpc$/);
  } finally { await close(); }
});

test('app: GET /health 返回存活（对齐 partners/main.py:110-121 形态）', async () => {
  const { req, close } = await startServer();
  try {
    const r = await req({ path: '/health' });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'online');
    assert.equal(r.body.agent, 'dsh-punky-swarm');
    assert.ok('tasks' in r.body);
  } finally { await close(); }
});

test('app: 未知路径 → 404', async () => {
  const { req, close } = await startServer();
  try {
    const r = await req({ path: '/nope' });
    assert.equal(r.status, 404);
  } finally { await close(); }
});

// ── 装配开关双态（U-D2：默认关零路径 / 显式开可监听）──

test('装配：resolveAcpsConfig 默认双关（enabled:false + endpoint.enabled:false——零运行时路径）', () => {
  const d = resolveAcpsConfig({});
  assert.equal(d.enabled, false);
  assert.equal(d.endpoint.enabled, false);
  assert.equal(d.endpoint.port, 9443); // D1 默认值
  assert.equal(d.endpoint.minVersion, 'TLSv1.3'); // D12
  assert.equal(d.endpoint.devInsecure, false);    // D4 E2 默认关
  // 部分配置不破坏默认（短路钳制）
  const partial = resolveAcpsConfig({ acps: { endpoint: { port: 'abc' } } });
  assert.equal(partial.enabled, false);
  assert.equal(partial.endpoint.port, 9443);
});

test('装配：显式双开可监听（临时端口）+ 请求可达', async () => {
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-acps-on-'));
  const files = ensureAcpsCerts({ dir: certDir, aic: SERVER_AIC });
  const config = resolveAcpsConfig({ acps: { enabled: true, endpoint: { enabled: true, port: 0, aic: SERVER_AIC } } });
  assert.equal(config.enabled, true);
  assert.equal(config.endpoint.enabled, true);
  const acps = createAcpsServer({ config, certDir, logger: { info() {}, warn() {} } });
  assert.ok(!acps.error);
  const addr = await acps.listen(0);
  assert.ok(addr.port > 0);
  const caPem = fs.readFileSync(path.join(certDir, 'ca.pem'), 'utf8');
  const caKeyPem = fs.readFileSync(path.join(certDir, 'ca.key'), 'utf8');
  const client = issueCert({ caCertPem: caPem, caKeyPem, cn: CLIENT_AIC, aic: CLIENT_AIC, usages: ['clientAuth'] });
  const r = await request({ port: addr.port, path: '/health', ca: caPem, cert: client.certPem, key: client.keyPem });
  assert.equal(r.status, 200);
  await acps.close();
});

test('装配：证书缺失且无 certDir → 返回 error（装配层告警禁用，不阻塞主进程）', () => {
  const config = resolveAcpsConfig({ acps: { enabled: true, endpoint: { enabled: true } } });
  const acps = createAcpsServer({ config, logger: { info() {}, warn() {} } }); // 无 certDir、无 cert/key/ca
  assert.ok(acps.error);
  assert.match(acps.error, /cert|路径|生成/);
});

test('装配：buildAcs 派生 aic 可注入（V3 注册后经 config 覆盖）', () => {
  const acs = buildAcs({ endpoint: { aic: SERVER_AIC, host: '127.0.0.1', port: 9443 } });
  assert.equal(acs.aic, SERVER_AIC);
  assert.equal(validateAic(SERVER_AIC), true);
});
