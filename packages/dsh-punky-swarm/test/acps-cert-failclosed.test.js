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

// ACPs 证书 fail-closed 测试（ACPS-02 / ACPS-03）
//   分层：装配期（证书有效期 ⇒ {error} 不 listen）＋ 应用层（devInsecure 下信任锚 403）。
//   RED 基线（修前）：过期证书 createError:null/listenOk:true/客户端 CERT_HAS_EXPIRED/serverWarns:[]
//                    devInsecure 下攻击者 CA 证书 ⇒ GET /health 200、serverWarns:[]。
//   GREEN（修后）：过期 ⇒ {error}（含「已过期」+「validTo=」）不 listen；伪造 ⇒ 三端点 403。
//   反向断言：有效证书照旧 200；devInsecure=false 的攻击者 CA 仍在 TLS 层握手失败（不得改成 fail-open）。
// 注：Node 24 的 X509Certificate 无「一次性有效期校验」方法（实测 TypeError）⇒ 有效期用 validFromDate/validToDate。
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAcpsServer } from '../lib/acps/server.js';
import { generateCaCert, issueCert, ensureAcpsCerts } from '../lib/acps/certs.js';
import { generateAic } from '../lib/aip/identity.js';

const SERVER_AIC = generateAic({ ontologySerial: '000000' });
const CLIENT_AIC = generateAic({ ontologySerial: 'ABCDEF' });

// ── fixture helper ──

function mkWarns() {
  const warns = [];
  return { warns, logger: { warn: (m) => warns.push(String(m)), info() {} } };
}

// 建一套 certDir（CA + 服务端证书），并返回路径与 PEM
function mkCertDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-acps-failclosed-'));
  const files = ensureAcpsCerts({ dir, aic: SERVER_AIC });
  return {
    dir,
    files,
    caPem: fs.readFileSync(path.join(dir, 'ca.pem'), 'utf8'),
    caKeyPem: fs.readFileSync(path.join(dir, 'ca.key'), 'utf8'),
  };
}

function endpointOf(files, devInsecure) {
  return {
    port: 0, host: '127.0.0.1', cert: files.certFile, key: files.keyFile, ca: files.caFile,
    devInsecure, aic: SERVER_AIC, agentName: 'dsh-punky-swarm', minVersion: 'TLSv1.3',
  };
}

// 覆盖已落盘的服务端证书（造过期/未生效态）
function overwriteServerCert(files, leaf) {
  fs.writeFileSync(files.certFile, leaf.certPem);
  fs.writeFileSync(files.keyFile, leaf.keyPem);
}

const RPC_BODY = {
  jsonrpc: '2.0', method: 'rpc', id: 'req-1',
  params: { command: { type: 'task-command', id: 't-1', command: 'start', taskId: 't-1' } },
};

function request({ port, path: p = '/health', method = 'GET', ca, cert, key, body }) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      host: 'localhost', port, path: p, method,
      ca, cert, key, minVersion: 'TLSv1.3', rejectUnauthorized: true, servername: 'localhost',
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

// ── ACPS-03：证书有效期 fail-closed（装配期，不 listen）──

test('ACPS-03: 过期服务端证书 ⇒ createAcpsServer 返回 error（含「已过期」+「validTo=」），不 listen', () => {
  const { files, caPem, caKeyPem } = mkCertDir();
  overwriteServerCert(files, issueCert({ caCertPem: caPem, caKeyPem, cn: SERVER_AIC, aic: SERVER_AIC, days: -1, usages: ['serverAuth'] }));
  const { logger } = mkWarns();
  const acps = createAcpsServer({ config: { endpoint: endpointOf(files, false) }, logger });
  assert.equal(typeof acps.error, 'string', 'RED 时此处为 null（静默起服）');
  assert.match(acps.error, /已过期/);
  assert.match(acps.error, /validTo=/);
  assert.match(acps.error, /保持禁用/);
  assert.equal(acps.server, undefined, '不得返回可 listen 的 server 实例');
  assert.equal(acps.listen, undefined);
});

test('ACPS-03: 过期 CA 证书（叶证书有效）⇒ 同样 fail-closed（症状与叶证书过期相同：全握手失败）', () => {
  const { files, caKeyPem } = mkCertDir();
  const expiredCa = generateCaCert({ cn: 'expired-ca', days: -1 });
  fs.writeFileSync(files.caFile, expiredCa.certPem);
  overwriteServerCert(files, issueCert({ caCertPem: expiredCa.certPem, caKeyPem, cn: SERVER_AIC, aic: SERVER_AIC, usages: ['serverAuth'] }));
  const { logger } = mkWarns();
  const acps = createAcpsServer({ config: { endpoint: endpointOf(files, false) }, logger });
  assert.equal(typeof acps.error, 'string');
  assert.match(acps.error, /CA 证书已过期/);
  assert.match(acps.error, /validTo=/);
  assert.equal(acps.server, undefined);
});

test('ACPS-03 反向断言：有效证书照旧起服并可访问（防「一律拒启」式过修）', async () => {
  const { files, caPem, caKeyPem } = mkCertDir();
  const { warns, logger } = mkWarns();
  const acps = createAcpsServer({ config: { endpoint: endpointOf(files, false) }, logger });
  assert.equal(acps.error, undefined, '有效证书不得被误杀：' + String(acps.error ?? ''));
  const addr = await acps.listen(0);
  try {
    const client = issueCert({ caCertPem: caPem, caKeyPem, cn: CLIENT_AIC, aic: CLIENT_AIC, usages: ['clientAuth'] });
    const r = await request({ port: addr.port, ca: caPem, cert: client.certPem, key: client.keyPem });
    assert.equal(r.status, 200);
    assert.equal(warns.length, 0, '默认档（devInsecure=false）不得新增起服 warn');
  } finally { await acps.close(); }
});

// ── ACPS-02：devInsecure 不放宽信任锚（应用层 403）──

// 起 devInsecure 服务 + 返回请求 helper（伪造/合法两套客户端证书）
async function startDevInsecure() {
  const { files, caPem, caKeyPem } = mkCertDir();
  const legit = issueCert({ caCertPem: caPem, caKeyPem, cn: CLIENT_AIC, aic: CLIENT_AIC, usages: ['clientAuth'] });
  const atkCa = generateCaCert({ cn: 'attacker-ca' });
  const forged = issueCert({ caCertPem: atkCa.certPem, caKeyPem: atkCa.keyPem, cn: CLIENT_AIC, aic: CLIENT_AIC, usages: ['clientAuth'] });
  const { warns, logger } = mkWarns();
  const acps = createAcpsServer({ config: { endpoint: endpointOf(files, true) }, logger });
  assert.equal(acps.error, undefined, 'devInsecure 服务须可起：' + String(acps.error ?? ''));
  const addr = await acps.listen(0);
  return {
    caPem, legit, forged, warns,
    req: (o) => request({ port: addr.port, ca: caPem, ...o }),
    close: () => acps.close(),
  };
}

test('ACPS-02: devInsecure=true + 攻击者 CA 签发的合法格式证书 ⇒ 三端点一律 403（RED 时 200）', async () => {
  const s = await startDevInsecure();
  try {
    const cred = { cert: s.forged.certPem, key: s.forged.keyPem };
    for (const [p, method, body] of [['/health', 'GET', undefined], ['/.well-known/acs.json', 'GET', undefined], ['/acps/rpc', 'POST', RPC_BODY]]) {
      const r = await s.req({ path: p, method, body, ...cred });
      assert.equal(r.status, 403, p + ' 必须 403（修前为 200，fail-open）');
      assert.equal(r.body.error, 'peer-cert-not-anchored');
      assert.match(r.body.hint, /不放宽信任锚/);
    }
    assert.ok(s.warns.some((w) => w.includes('devInsecure peer rejected')), '拒绝路径必须可观测（不得静默）');
  } finally { await s.close(); }
});

test('ACPS-02 反向断言：devInsecure=true + 同 CA 签发的客户端证书 ⇒ 三端点照旧 200（不误杀）', async () => {
  const s = await startDevInsecure();
  try {
    const cred = { cert: s.legit.certPem, key: s.legit.keyPem };
    const health = await s.req({ path: '/health', ...cred });
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'online');
    const acs = await s.req({ path: '/.well-known/acs.json', ...cred });
    assert.equal(acs.status, 200);
    const rpc = await s.req({ path: '/acps/rpc', method: 'POST', body: RPC_BODY, ...cred });
    assert.equal(rpc.status, 200);
    assert.equal(rpc.body.result.status.state, 'accepted');
    assert.equal(rpc.body.result.senderId, CLIENT_AIC); // peer CN 语义不变
  } finally { await s.close(); }
});

test('ACPS-02: devInsecure=true 且客户端不带证书 ⇒ 403 no-peer-certificate（TLS 层放宽后不得变成通过）', async () => {
  const s = await startDevInsecure();
  try {
    const r = await s.req({ path: '/health' }); // 不带 cert/key
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'no-peer-certificate');
  } finally { await s.close(); }
});

test('ACPS-02 反向断言：devInsecure=false + 攻击者 CA ⇒ 仍在 TLS 层握手失败（不得把生产档改成 fail-open）', async () => {
  const { dir, files, caPem, caKeyPem } = mkCertDir();
  const atkCa = generateCaCert({ cn: 'attacker-ca-2' });
  const forged = issueCert({ caCertPem: atkCa.certPem, caKeyPem: atkCa.keyPem, cn: CLIENT_AIC, aic: CLIENT_AIC, usages: ['clientAuth'] });
  void dir;
  const { logger } = mkWarns();
  const acps = createAcpsServer({ config: { endpoint: endpointOf(files, false) }, logger });
  const addr = await acps.listen(0);
  try {
    await assert.rejects(
      () => request({ port: addr.port, ca: caPem, cert: forged.certPem, key: forged.keyPem }),
      (e) => /ECONNRESET|EPIPE|certificate|handshake|unable|CERT|hang up/i.test(String(e.message ?? e.code ?? e)),
      '生产档必须仍由 TLS 层拒绝（无 HTTP 状态码可断言）',
    );
    // 同 CA 合法证书仍可访问（信任锚一致性未被破坏）
    const legit = issueCert({ caCertPem: caPem, caKeyPem, cn: CLIENT_AIC, aic: CLIENT_AIC, usages: ['clientAuth'] });
    const ok = await request({ port: addr.port, ca: caPem, cert: legit.certPem, key: legit.keyPem });
    assert.equal(ok.status, 200);
  } finally { await acps.close(); }
});

test('devInsecure 降级 warn：每次起服一条，明确「放宽了什么 / 没放宽什么」', () => {
  const { files } = mkCertDir();
  const { warns, logger } = mkWarns();
  const acps = createAcpsServer({ config: { endpoint: endpointOf(files, true) }, logger });
  assert.equal(acps.error, undefined);
  const dev = warns.filter((w) => w.includes('devInsecure=true'));
  assert.equal(dev.length, 1, '起服须恰好一条降级 warn');
  assert.match(dev[0], /降级范围/);
  assert.match(dev[0], /TLS 层验签关闭/);
  assert.match(dev[0], /仍强制信任锚/);
  assert.match(dev[0], /生产禁止开启/);
});

// ── L2（本批新引入的回归面）：endpoint.ca 为**多 CA bundle** 时按 issuer 逐张匹配 ──
//   旧实现 `new X509Certificate(tls.ca)` 对多张 PEM **不抛错、静默取首张** ⇒ bundle 首张不是签发者时
//   **合法对端被 403**（peer-cert-not-anchored，误杀）。修法：逐张解析 + 逐张匹配，命中任一即通过，
//   全不命中才 403。本节只**追加**用例，不改文件头 import（X509Certificate 用动态 import 取，保持零侵入）。

// bundle fixture：首张 = 非签发者（otherCa），第二张 = 真签发者（ownCa，服务端证书由它签）
async function mkMultiCaFixture() {
  const { dir, files, caPem, caKeyPem } = mkCertDir();
  const otherCa = generateCaCert({ cn: 'other-ca-not-issuer' });
  const bundlePath = path.join(dir, 'ca-bundle.pem');
  fs.writeFileSync(bundlePath, otherCa.certPem + caPem);
  const { X509Certificate } = await import('node:crypto');
  const firstInBundle = new X509Certificate(otherCa.certPem);
  const issuerCa = new X509Certificate(caPem);
  // 断言「首张不是签发者」这一前提本身（否则用例会在未被触发回归的情况下假绿）
  assert.notEqual(firstInBundle.subject, issuerCa.subject, '前提：bundle 首张与真签发者必须是不同 CA');
  return { files, caPem, caKeyPem, bundlePath, otherCa, firstInBundle };
}

async function startMultiCaBundle() {
  const fx = await mkMultiCaFixture();
  const legit = issueCert({ caCertPem: fx.caPem, caKeyPem: fx.caKeyPem, cn: CLIENT_AIC, aic: CLIENT_AIC, usages: ['clientAuth'] });
  // 更强前提：合法对端的 issuer = 第二张，**不等于**首张（旧实现只看首张 ⇒ 必 403）
  const { X509Certificate } = await import('node:crypto');
  assert.notEqual(fx.firstInBundle.subject, new X509Certificate(legit.certPem).issuer, '前提：首张不是合法对端的签发者');
  const atkCa = generateCaCert({ cn: 'attacker-ca-multica' });
  const forged = issueCert({ caCertPem: atkCa.certPem, caKeyPem: atkCa.keyPem, cn: CLIENT_AIC, aic: CLIENT_AIC, usages: ['clientAuth'] });
  const { warns, logger } = mkWarns();
  const acps = createAcpsServer({
    config: { endpoint: { ...endpointOf(fx.files, true), ca: fx.bundlePath } },
    logger,
  });
  assert.equal(acps.error, undefined, '多 CA bundle 须可起服：' + String(acps.error ?? ''));
  const addr = await acps.listen(0);
  return {
    warns, legit, forged, fx,
    req: (o) => request({ port: addr.port, ca: fx.caPem, ...o }),
    close: () => acps.close(),
  };
}

test('L2 阳性对照: 多 CA bundle 且首张不是签发者 + 合法对端 ⇒ 三端点照旧 200（修前 403 误杀）', async () => {
  const s = await startMultiCaBundle();
  try {
    const cred = { cert: s.legit.certPem, key: s.legit.keyPem };
    const health = await s.req({ path: '/health', ...cred });
    assert.equal(health.status, 200, '合法对端不得被误杀（修前实测 403 peer-cert-not-anchored）');
    assert.equal(health.body.status, 'online');
    const acs = await s.req({ path: '/.well-known/acs.json', ...cred });
    assert.equal(acs.status, 200);
    const rpc = await s.req({ path: '/acps/rpc', method: 'POST', body: RPC_BODY, ...cred });
    assert.equal(rpc.status, 200);
    assert.equal(rpc.body.result.status.state, 'accepted');
    assert.equal(rpc.body.result.senderId, CLIENT_AIC, 'peer CN 语义不变');
    // 可观测性：通过路径不得留下「peer rejected」噪声
    assert.deepEqual(s.warns.filter((w) => w.includes('peer rejected')), []);
  } finally { await s.close(); }
});

test('L2 阴性对照: 多 CA bundle 下攻击者 CA 签发的证书 ⇒ 仍 403 peer-cert-not-anchored（安全不得退）', async () => {
  const s = await startMultiCaBundle();
  try {
    const cred = { cert: s.forged.certPem, key: s.forged.keyPem };
    for (const [p, method, body] of [['/health', 'GET', undefined], ['/.well-known/acs.json', 'GET', undefined], ['/acps/rpc', 'POST', RPC_BODY]]) {
      const r = await s.req({ path: p, method, body, ...cred });
      assert.equal(r.status, 403, p + ' 必须 403（修多 CA 不得把锚定放宽成「任一证书都过」）');
      assert.equal(r.body.error, 'peer-cert-not-anchored');
    }
    assert.ok(s.warns.some((w) => w.includes('devInsecure peer rejected (peer-cert-not-anchored)')), '拒绝路径必须可观测');
  } finally { await s.close(); }
});

test('L2 顺序无关: 签发者在 bundle 首张 / 第二张两种顺序都通过（按 issuer 逐张匹配，非按位置）', async () => {
  const { dir, files } = mkCertDir();
  // 复用 same fixture 的两张 CA：先建 otherCa，再重签一套 server 证书（由它签）→ 首张即签发者
  const otherCa = generateCaCert({ cn: 'other-ca-first-issuer' });
  const serverLeaf = issueCert({
    caCertPem: otherCa.certPem, caKeyPem: otherCa.keyPem, cn: SERVER_AIC, aic: SERVER_AIC,
    altNames: [{ type: 'dns', value: 'localhost' }], usages: ['serverAuth', 'clientAuth'],
  });
  fs.writeFileSync(files.certFile, serverLeaf.certPem);
  fs.writeFileSync(files.keyFile, serverLeaf.keyPem);
  const ownCaPem = fs.readFileSync(path.join(dir, 'ca.pem'), 'utf8');
  const bundlePath = path.join(dir, 'ca-bundle-second.pem');
  fs.writeFileSync(bundlePath, otherCa.certPem + ownCaPem); // 首张 = 本次签发者
  const client = issueCert({ caCertPem: otherCa.certPem, caKeyPem: otherCa.keyPem, cn: CLIENT_AIC, aic: CLIENT_AIC, usages: ['clientAuth'] });

  const { logger } = mkWarns();
  const acps = createAcpsServer({ config: { endpoint: { ...endpointOf(files, true), ca: bundlePath } }, logger });
  assert.equal(acps.error, undefined, String(acps.error ?? ''));
  const addr = await acps.listen(0);
  try {
    const r = await request({ port: addr.port, path: '/health', ca: otherCa.certPem, cert: client.certPem, key: client.keyPem });
    assert.equal(r.status, 200);
  } finally { await acps.close(); }
});
