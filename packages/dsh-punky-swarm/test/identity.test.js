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

// P2/P3 身份体系（aip-gb-fix exec-identity）：AIC 编码/校验 + CAI 证书 + 签名 + 信任链验证
// 向量基准：ACPs-spec-AIC-v02.01 §4（0x1234 盐 → 0JU4）+ 参考实现 registry-server test_aic.py
//（无盐 → 0H9T）。装配开关：identity 默认关、aip.identity.enabled=true 可读、不注册新工具。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  AIC_PREFIX, BASE36_ALPHABET,
  base36Encode, base36Decode,
  crc16CcittFalse, parseSalt, calculateAicChecksum,
  validateAic, normalizeAic, splitAic, isOntologyAic, isEntityAic,
  generateAic, createMemoryStore,
  registerIdentity, issueCredential, sign, verifySignature, verifyTrustChain,
  SIGN_ALGORITHMS, DEFAULT_SIGN_ALGORITHM, CAI_DEFAULT_VALIDITY_DAYS, CAI_MAX_VALIDITY_DAYS,
} from '../lib/aip/identity.js';
import { CAPABILITY_REGISTRY, readCapability } from '../lib/assembly/schema.js';

// ---- AIC 编码基础 ----
test('AIC：Base36 编解码往返', () => {
  for (const n of [0, 1, 9, 10, 35, 36, 46655, 46656, 123456789]) {
    const enc = base36Encode(n);
    assert.equal(base36Decode(enc), n);
  }
  assert.equal(base36Encode(0, 4), '0000');
  assert.equal(base36Encode(10, 4), '000A');
  assert.equal(base36Encode(35, 4), '000Z');
  assert.equal(BASE36_ALPHABET.length, 36);
  assert.throws(() => base36Encode(-1));
  assert.throws(() => base36Decode('@'));
});

test('AIC：CRC-16/CCITT-FALSE 向量对照参考实现（无盐 0H9T / 0x1234 盐 0JU4）', () => {
  // 参考实现 registry-server/tests/unit/test_aic.py：AIC_CRC_SALT='' → 0H9T
  assert.equal(calculateAicChecksum('1.2.156.1234.1.1.34C2.478BDF.3GF546', ''), '0H9T');
  assert.equal(crc16CcittFalse('1.2.156.1234.1.1.34C2.478BDF.3GF546', parseSalt('')), 0x5771);
  // ACPs-spec-AIC-v02.01 §4.1 示例：SALT=0x1234 → 校验码原值 0x646C → Base36 0JU4
  assert.equal(crc16CcittFalse('1.2.156.3088.1.1.34C2.478BDF.3GF546', parseSalt('0x1234')), 0x646C);
  assert.equal(calculateAicChecksum('1.2.156.3088.1.1.34C2.478BDF.3GF546', '0x1234'), '0JU4');
});

test('AIC：validateAic 接受 spec 示例（大小写/空白容忍），拒绝非法输入', () => {
  const full = '1.2.156.3088.1.1.34C2.478BDF.3GF546.0JU4';
  assert.equal(validateAic(full, { salt: '0x1234' }), true);
  assert.equal(validateAic('  ' + full.toLowerCase() + '\n', { salt: '0x1234' }), true, '大小写/空白容忍');
  // 前缀不匹配
  assert.equal(validateAic(full, { salt: '0x1234', expectedPrefix: '1.2.156.1234' }), false);
  // 段数/CRC 错误
  assert.equal(validateAic('1.2.156.3088', { salt: '0x1234' }), false);
  assert.equal(validateAic('1.2.156.3088.1.1.34C2.478BDF.3GF546.0000', { salt: '0x1234' }), false, '错误校验码');
  assert.equal(validateAic('', { salt: '0x1234' }), false);
});

test('AIC：generateAic 产出 10 级合法码（本体/实体）', () => {
  const onto = generateAic({ salt: '0x1234' });
  assert.equal(validateAic(onto, { salt: '0x1234' }), true);
  assert.equal(isOntologyAic(onto), true, '默认本体（第 9 级全 0）');
  assert.equal(isEntityAic(onto), false);

  const ent = generateAic({ salt: '0x1234', entity: true });
  assert.equal(validateAic(ent, { salt: '0x1234' }), true);
  assert.equal(isEntityAic(ent), true, '实体（第 9 级非全 0）');
  assert.equal(isOntologyAic(ent), false);

  // 前缀/分段
  assert.ok(ent.startsWith(AIC_PREFIX + '.'));
  const parts = splitAic(ent);
  assert.equal(parts.length, 10);
  assert.ok(/^[0-9]+$/.test(parts[0]) && /^[0-9]+$/.test(parts[1]) && /^[0-9]+$/.test(parts[2]) && /^[0-9]+$/.test(parts[3]));
  assert.equal(parts[4].length, 1); // 版本
  assert.ok(parts[5].length >= 1 && parts[5].length <= 6); // ARSP
  assert.ok(parts[6].length >= 1 && parts[6].length <= 6); // 供应商
  assert.ok(parts[7].length >= 1 && parts[7].length <= 9); // 本体
  assert.ok(parts[8].length >= 1 && parts[8].length <= 9); // 实体
  assert.equal(parts[9].length, 4); // 校验码

  // 非法自定义段
  assert.throws(() => generateAic({ version: '12' }));
  assert.throws(() => generateAic({ arsp: '00*1' }));
  assert.throws(() => generateAic({ vendor: '' }));
  assert.throws(() => generateAic({ ontologySerial: '@@@' }));
});

test('AIC：确定性注入（ontologySerial/instanceSerial 固定）', () => {
  const a = generateAic({ salt: '0x1234', ontologySerial: 'ABCDEF', instanceSerial: '123456' });
  const b = generateAic({ salt: '0x1234', ontologySerial: 'ABCDEF', instanceSerial: '123456' });
  assert.equal(a, b, '同参数确定性');
  assert.equal(validateAic(a, { salt: '0x1234' }), true);
  assert.ok(a.includes('ABCDEF'));
});

// ---- 四函数：registerIdentity / issueCredential / sign / verifyTrustChain ----
test('registerIdentity：分配 AIC + 持久化 + 查重（幂等）', async () => {
  const store = createMemoryStore();
  const r1 = await registerIdentity({ kind: 'agent', name: 'demo-agent', provider: { org: 'Punky' } }, { store, salt: '0x1234' });
  assert.equal(r1.reused, false);
  assert.equal(validateAic(r1.aic, { salt: '0x1234' }), true);
  assert.ok(r1.oid === r1.aic);
  assert.equal(r1.record.name, 'demo-agent');
  assert.equal(r1.record.isOntology, true);

  // 查重：同名返回既有
  const r2 = await registerIdentity({ kind: 'agent', name: 'demo-agent' }, { store, salt: '0x1234' });
  assert.equal(r2.reused, true);
  assert.equal(r2.aic, r1.aic);

  // 不同 kind 不冲突
  const r3 = await registerIdentity({ kind: 'tool', name: 'demo-agent' }, { store, salt: '0x1234' });
  assert.equal(r3.reused, false);
  assert.notEqual(r3.aic, r1.aic);

  await assert.rejects(() => registerIdentity({ kind: 'agent', name: '' }), /identity.name is required/);
});

test('issueCredential：CAI 结构（CN/SAN/EKU/有效期）+ EAB + 存证', async () => {
  const store = createMemoryStore();
  const { aic } = await registerIdentity({ kind: 'agent', name: 'cert-agent' }, { store, salt: '0x1234' });
  const { credential, eab, keyRef } = await issueCredential(
    { aic },
    { role: 'coder', layer: 'exec', org: 'Punky', usage: 'clientAuth', requestedValidityDays: 365 },
    { store, salt: '0x1234' },
  );

  assert.equal(credential.type, 'CAI');
  assert.equal(credential.aic, aic);
  assert.equal(credential.cn, aic, 'CN=AIC');
  assert.ok(credential.san.includes('URI:acps://' + aic), 'SAN 含 URI:acps://{AIC}');
  assert.deepEqual(credential.extendedKeyUsage, ['clientAuth'], 'EKU 分用途');
  assert.equal(credential.validityDays, 365);
  assert.ok(credential.publicKey.includes('BEGIN PUBLIC KEY'));
  assert.ok(credential.signature && credential.signature.signature, '证书已签名');
  assert.equal(credential.algorithm, DEFAULT_SIGN_ALGORITHM);

  // EAB：keyId + macKey + 绑定 AIC + 有效期
  assert.ok(eab.keyId && eab.macKey && eab.aic === aic);
  assert.ok(Date.parse(eab.expiresAt) > Date.now());

  // 存证
  assert.ok(store.get('credential:' + aic));
  assert.ok(store.get('eab:' + eab.keyId));
  assert.ok(store.get('key:' + aic));
  assert.ok(keyRef.privateKey.includes('BEGIN PRIVATE KEY'));

  // 无 AIC / 非法 AIC 拒绝
  await assert.rejects(() => issueCredential({ aic: 'not-an-aic' }, {}, { store }));
  await assert.rejects(() => issueCredential({}, {}, { store }));
});

test('issueCredential：serverAuth 分用途 + 有效期上限钳制', async () => {
  const store = createMemoryStore();
  const { aic } = await registerIdentity({ kind: 'agent', name: 'srv-agent' }, { store, salt: '0x1234' });
  const { credential } = await issueCredential({ aic }, { usage: 'serverAuth', requestedValidityDays: 999999 }, { store, salt: '0x1234' });
  assert.deepEqual(credential.extendedKeyUsage, ['serverAuth']);
  assert.equal(credential.validityDays, CAI_MAX_VALIDITY_DAYS, '超过上限按上限签发（3650）');
  const { credential: c2 } = await issueCredential({ aic }, { requestedValidityDays: 0 }, { store, salt: '0x1234' });
  assert.equal(c2.validityDays, 1, '低于下限钳制到 1');
  const { credential: c3 } = await issueCredential({ aic }, {}, { store, salt: '0x1234' });
  assert.equal(c3.validityDays, CAI_DEFAULT_VALIDITY_DAYS, '缺省 49 天');
});

test('sign：ECDSA P-256 默认可验签；RSA-2048 可配置；SM2 显式拒绝（待正式文本校准）', async () => {
  // ECDSA P-256（默认）
  const store = createMemoryStore();
  const { aic } = await registerIdentity({ kind: 'agent', name: 'sign-agent' }, { store, salt: '0x1234' });
  const { credential, keyRef } = await issueCredential({ aic }, {}, { store, salt: '0x1234' });
  const payload = JSON.stringify({ op: 'ping', ts: 1234567890 });
  const sig = await sign(payload, keyRef);
  assert.equal(sig.algorithm, 'ecdsa-p256');
  assert.ok(sig.signature.length > 0);
  const ok = await verifySignature(payload, sig.signature, { algorithm: sig.algorithm, publicKey: credential.publicKey });
  assert.equal(ok, true, 'ECDSA 验签通过');
  const bad = await verifySignature(payload + 'x', sig.signature, { algorithm: sig.algorithm, publicKey: credential.publicKey });
  assert.equal(bad, false, '篡改载荷验签失败');

  // RSA-2048 可配置（独立 RSA 密钥对：私钥签 + 公钥验）
  const rsaPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rsaPriv = rsaPair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const rsaPub = rsaPair.publicKey.export({ type: 'spki', format: 'pem' });
  const sigRsa = await sign(payload, { algorithm: 'rsa-2048', privateKey: rsaPriv });
  assert.equal(sigRsa.algorithm, 'rsa-2048');
  assert.ok(sigRsa.signature.length > 0);
  const rsaOk = await verifySignature(payload, sigRsa.signature, { algorithm: 'rsa-2048', publicKey: rsaPub });
  assert.equal(rsaOk, true, 'RSA 验签通过');
  const rsaBad = await verifySignature(payload + 'x', sigRsa.signature, { algorithm: 'rsa-2048', publicKey: rsaPub });
  assert.equal(rsaBad, false, 'RSA 篡改验签失败');

  // SM2 占位：显式拒绝并提示
  await assert.rejects(
    () => sign(payload, { algorithm: 'sm2', privateKey: keyRef.privateKey }),
    /SM2 待正式文本校准/,
  );
  assert.equal(SIGN_ALGORITHMS.sm2, null, 'sm2 仅占位');
});

test('verifyTrustChain：三级链验证通过；吊销/深度/根锚/篡改拒绝', async () => {
  const store = createMemoryStore();
  const salt = '0x1234';

  // 根（自签）→ 中间 CA → 叶子
  const rootAic = generateAic({ salt, ontologySerial: 'ROOT00', instanceSerial: '000000' });
  const rootRes = await issueCredential(
    { aic: rootAic },
    { role: 'root', usage: 'clientAuth' },
    { store, salt, issuer: { aic: rootAic, name: 'Root CA' } }, // 自签：issuer.aic === aic
  );
  const rootCert = { ...rootRes.credential, issuer: { aic: rootAic, name: 'Root CA' } };

  const midAic = generateAic({ salt, ontologySerial: 'MID001', instanceSerial: '000000' });
  const midRes = await issueCredential(
    { aic: midAic },
    { role: 'ca', usage: 'clientAuth' },
    { store, salt, issuer: { aic: rootAic, name: 'Root CA' } },
  );
  const midCert = midRes.credential;

  const leafAic = generateAic({ salt, ontologySerial: 'LEAF01', instanceSerial: '000000' });
  const leafRes = await issueCredential(
    { aic: leafAic },
    { role: 'agent', usage: 'clientAuth' },
    { store, salt, issuer: { aic: midAic, name: 'Mid CA' } },
  );
  const leafCert = leafRes.credential;

  // 正常：credential ← mid ← root（根锚 = rootAic）
  const okRes = await verifyTrustChain(leafCert, [midCert, rootCert], {
    trustAnchors: [rootAic], salt,
  });
  assert.equal(okRes.ok, true, '三级链验证通过：' + JSON.stringify(okRes));
  assert.equal(okRes.depth, 3);

  // 根锚缺失 → 拒绝
  const noAnchor = await verifyTrustChain(leafCert, [midCert, rootCert], { trustAnchors: ['1.2.156.3088.1.1.XXXXXX.UNKNOWN.000000.0000'], salt });
  assert.equal(noAnchor.ok, false);
  assert.match(noAnchor.reason, /root not in trust anchors/);

  // 吊销（叶子 AIC）→ 拒绝
  const revoked = await verifyTrustChain(leafCert, [midCert, rootCert], { trustAnchors: [rootAic], revokedAics: [leafAic], salt });
  assert.equal(revoked.ok, false);
  assert.match(revoked.reason, /revoked/);

  // 深度超限（maxDepth=2，链深 3）→ 拒绝
  const tooDeep = await verifyTrustChain(leafCert, [midCert, rootCert], { trustAnchors: [rootAic], maxDepth: 2, salt });
  assert.equal(tooDeep.ok, false);
  assert.match(tooDeep.reason, /maxDepth/);

  // 篡改叶子（aic 换掉但签名不变）→ 验签失败
  const tampered = { ...leafCert, aic: generateAic({ salt, ontologySerial: 'LEAF99', instanceSerial: '000000' }) };
  const tamperRes = await verifyTrustChain(tampered, [midCert, rootCert], { trustAnchors: [rootAic], salt });
  assert.equal(tamperRes.ok, false);
  assert.match(tamperRes.reason, /signature verification failed/);

  // 单自签凭证命中根锚 → 通过
  const single = await verifyTrustChain(rootCert, [], { trustAnchors: [rootAic], salt });
  assert.equal(single.ok, true);
  assert.equal(single.depth, 1);

  // 非 CAI 类型 → 拒绝
  const badType = await verifyTrustChain({ type: 'JWT', aic: leafAic }, [], { trustAnchors: [rootAic], salt });
  assert.equal(badType.ok, false);
});

// ---- 装配开关：identity 默认关、可读、不注册新工具 ----
test('装配：CAPABILITY_REGISTRY 含 identity 键（默认关），readCapability 可读', () => {
  const entry = CAPABILITY_REGISTRY.find((e) => e.key === 'identity');
  assert.ok(entry, 'registry 含 identity 键');
  assert.deepEqual(entry.path, ['aip', 'identity']);
  assert.equal(entry.default.enabled, false, '默认关（零开销）');

  // 缺省配置 → disabled
  assert.equal(readCapability({}, 'identity')?.enabled, false);
  assert.equal(readCapability({ aip: { enabled: true } }, 'identity')?.enabled, false, 'aip.enabled 不连带激活 identity');
  // 显式 enabled=true → 激活
  assert.equal(readCapability({ aip: { identity: { enabled: true } } }, 'identity')?.enabled, true);
  // 显式 enabled=false
  assert.equal(readCapability({ aip: { identity: { enabled: false } } }, 'identity')?.enabled, false);
});
