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

// 文件 certs：ACPs mTLS 证书材料（lib/acps 域，P1 lane exec-acps-server）
// 契约：CAI 自签（node:crypto 自签 X.509，零新依赖）；文件三路径（cert/key/ca 三路径
//       config 可配，默认 acps 数据目录）；TLS 语义对齐参考实现
//       registry-server/app/main_mtls.py:14-30（cert/key/ca 三件套 + CERT_REQUIRED + TLSv1_3）。
// 说明：lib/aip/identity.js 的 issueCredential 产出 JSON CAI（cn/san/签名载荷），非 X.509 DER/PEM，
//   不能直接喂 node:https TLS 上下文——本模块用 node:crypto（generateKeyPairSync + createSign）
//   直接编码 X.509 证书（ASN.1 DER 手工编码，纯内建能力），签名算法 ECDSA P-256
//   （对齐 identity.js DEFAULT_SIGN_ALGORITHM = 'ecdsa-p256'）。CAI 语义对齐（identity.js:24-27）：
//   CN=AIC、SAN=URI:acps://{AIC}、extendedKeyUsage 分用途（serverAuth/clientAuth）。
// 私钥文件权限注意：写文件 mode 0o600；数据目录默认 <root>/acps/certs（引擎根内，不落工作区根）。

import crypto from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ── ASN.1 DER 最小编码器（X.509 证书构造用，纯内建）──

function derLen(n) {
  if (n < 0x80) return [n];
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v >>= 8; }
  return [0x80 | bytes.length, ...bytes];
}

function derWrap(tag, body) {
  return Buffer.from([tag, ...derLen(body.length), ...body]);
}

function derSeq(...parts) {
  return derWrap(0x30, Buffer.concat(parts));
}

function derSet(...parts) {
  return derWrap(0x31, Buffer.concat(parts));
}

function derInt(n) {
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let bytes = Buffer.from(hex, 'hex');
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return derWrap(0x02, bytes);
}

function derOid(oid) {
  const parts = oid.split('.').map(Number);
  const body = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    let v = p;
    const chunk = [v & 0x7f];
    v >>= 7;
    while (v > 0) { chunk.unshift((v & 0x7f) | 0x80); v >>= 7; }
    body.push(...chunk);
  }
  return derWrap(0x06, Buffer.from(body));
}

function derOctets(buf) {
  return derWrap(0x04, Buffer.from(buf));
}

function derPrintable(s) {
  return derWrap(0x13, Buffer.from(s, 'ascii'));
}

function derNull() {
  return Buffer.from([0x05, 0x00]);
}

function derBool(v) {
  return Buffer.from([0x01, 0x01, v ? 0xff : 0x00]);
}

function derBitString(bytes) {
  return derWrap(0x03, Buffer.concat([Buffer.from([0]), bytes]));
}

function derTime(date) {
  if (date.getUTCFullYear() >= 2050) {
    const s = date.getUTCFullYear().toString().padStart(4, '0')
      + String(date.getUTCMonth() + 1).padStart(2, '0')
      + String(date.getUTCDate()).padStart(2, '0')
      + String(date.getUTCHours()).padStart(2, '0')
      + String(date.getUTCMinutes()).padStart(2, '0')
      + String(date.getUTCSeconds()).padStart(2, '0') + 'Z';
    return derWrap(0x18, Buffer.from(s, 'ascii'));
  }
  const s = String(date.getUTCFullYear() % 100).padStart(2, '0')
    + String(date.getUTCMonth() + 1).padStart(2, '0')
    + String(date.getUTCDate()).padStart(2, '0')
    + String(date.getUTCHours()).padStart(2, '0')
    + String(date.getUTCMinutes()).padStart(2, '0')
    + String(date.getUTCSeconds()).padStart(2, '0') + 'Z';
  return derWrap(0x17, Buffer.from(s, 'ascii'));
}

// Name（RDNSequence）：CN 单 RDN（X.509 客户端/服务端识别用；CN=AIC 对齐 CAI 语义）
function derName(cn) {
  const rdn = derSet(derSeq(derOid('2.5.4.3'), derPrintable(cn)));
  return derSeq(rdn);
}

// AlgorithmIdentifier：ecdsa-with-SHA256（1.2.840.10045.4.3.2）
function derEcdsaSha256() {
  return derSeq(derOid('1.2.840.10045.4.3.2'));
}

// SubjectPublicKeyInfo：ecPublicKey（1.2.840.10045.2.1）+ prime256v1（1.2.840.10045.3.1.7）
function derSpki(publicKey) {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  // EC 公钥点（未压缩 0x04||X||Y，65 字节）位于 spki 尾
  const point = spki.subarray(spki.length - 65, spki.length);
  return derSeq(
    derSeq(derOid('1.2.840.10045.2.1'), derOid('1.2.840.10045.3.1.7')),
    derBitString(point),
  );
}

function derExtension(oid, critical, value) {
  // RFC 5280：Extension.critical 为 BOOLEAN DEFAULT FALSE——false 时省略字段（不编码 NULL）
  return derSeq(derOid(oid), ...(critical ? [derBool(true)] : []), derOctets(value));
}

function derBasicConstraints(ca) {
  return derSeq(derBool(ca));
}

function derKeyUsage(ca) {
  // RFC 5280 KeyUsage 位序（BIT STRING 字节：bit0=0x80 … bit5=0x04 keyCertSign, bit6=0x02 cRLSign）：
  // CA: keyCertSign(0x04)|cRLSign(0x02) = 0x06；leaf: digitalSignature(0x80)
  return derBitString(Buffer.from([ca ? 0x06 : 0x80]));
}

function derAltNames(entries) {
  const parts = [];
  for (const e of entries) {
    if (e.type === 'dns') parts.push(derWrap(0x82, Buffer.from(e.value, 'ascii')));
    else if (e.type === 'ip') parts.push(derWrap(0x87, Buffer.from(e.value.split('.').map(Number))));
    else if (e.type === 'uri') parts.push(derWrap(0x86, Buffer.from(e.value, 'utf8')));
  }
  return derSeq(...parts);
}

function derExtendedKeyUsage(usages) {
  const oids = { serverAuth: '1.3.6.1.5.5.7.3.1', clientAuth: '1.3.6.1.5.5.7.3.2' };
  return derSeq(...usages.map((u) => derOid(oids[u])));
}

// ── 密钥对 ──

function generateKeyPair() {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}

// ── X.509 证书生成（node:crypto 原生：手动 ASN.1 DER 编码 + ECDSA P-256 签名）──
// opts: { cn, issuerCn, signerPrivateKey, altNames, days, isCa, usages, serial }
//   issuerCn/signerPrivateKey 缺省 = 自签（issuer=subject，用自身私钥）；
//   提供时 = CA 签发（issuer=CA CN，用 CA 私钥签名）——X.509 标准签发结构。
function createX509({
  cn, issuerCn, signerPrivateKey, altNames = [], days = 365, isCa = false, usages = ['serverAuth'], serial,
} = {}) {
  if (typeof cn !== 'string' || cn.length === 0) throw new Error('createX509: cn is required');
  const { publicKey, privateKey } = generateKeyPair();
  const notBefore = new Date(Date.now() - 60_000); // 1 分钟回拨容忍
  const notAfter = new Date(notBefore.getTime() + days * 24 * 60 * 60 * 1000);
  const serialNum = serial ?? crypto.randomBytes(16).readBigUInt64BE(0);

  const alg = derEcdsaSha256();
  const extensions = [
    derExtension('2.5.29.19', true, derBasicConstraints(isCa)),
    derExtension('2.5.29.15', true, derKeyUsage(isCa)),
  ];
  if (altNames.length > 0) extensions.push(derExtension('2.5.29.17', false, derAltNames(altNames)));
  if (!isCa && usages.length > 0) extensions.push(derExtension('2.5.29.37', false, derExtendedKeyUsage(usages)));

  const tbs = derSeq(
    derWrap(0xa0, derInt(2)),    // version [0] EXPLICIT INTEGER v3（RFC 5280 上下文标签）
    derInt(serialNum),           // serialNumber
    alg,                         // signature algorithm
    derName(issuerCn ?? cn),     // issuer
    derSeq(derTime(notBefore), derTime(notAfter)), // validity
    derName(cn),                 // subject
    derSpki(publicKey),          // subjectPublicKeyInfo
    derWrap(0xa3, derSeq(...extensions)), // extensions [3]
  );

  const signKey = signerPrivateKey ?? privateKey;
  const signer = crypto.createSign('sha256');
  signer.update(tbs);
  const sig = signer.sign(signKey);
  // ECDSA 签名（DER 编码）→ SEQUENCE(INTEGER r, INTEGER s)
  const rLen = sig.readUInt8(3);
  const rStart = 4;
  const r = sig.subarray(rStart, rStart + rLen);
  const sLen = sig.readUInt8(rStart + rLen + 1);
  const s = sig.subarray(rStart + rLen + 2, rStart + rLen + 2 + sLen);
  const sigDer = derSeq(
    derInt(BigInt('0x' + r.toString('hex'))),
    derInt(BigInt('0x' + s.toString('hex'))),
  );

  const certDer = derSeq(tbs, alg, derBitString(sigDer));
  const certPem = '-----BEGIN CERTIFICATE-----\n'
    + certDer.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
    + '\n-----END CERTIFICATE-----\n';
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return { certPem, keyPem, certDer, notBefore, notAfter };
}

// ── 对外 API ──

// CA 自签证书（信任锚）：CN=caCn，basicConstraints CA:true + keyUsage keyCertSign|cRLSign
export function generateCaCert({ cn = 'dsh-punky-swarm CA', days = 3650 } = {}) {
  return createX509({ cn, days, isCa: true });
}

// 用 CA 签发实体证书（mTLS 服务端/客户端）：CN=cn，SAN 含 URI:acps://{aic}（CAI 语义对齐）
// usages: ['serverAuth'] / ['clientAuth'] / 两者
export function issueCert({ caCertPem, caKeyPem, cn, aic, altNames = [], days = 365, usages = ['clientAuth'] }) {
  if (typeof caCertPem !== 'string' || typeof caKeyPem !== 'string') {
    throw new Error('issueCert: caCertPem and caKeyPem are required');
  }
  // 从 CA 证书解析 issuer CN（X509Certificate.subject → "CN=xxx"）
  let issuerCn;
  try {
    const caCert = new crypto.X509Certificate(caCertPem);
    issuerCn = (caCert.subject.match(/CN=([^,]+)/) ?? [])[1] ?? 'dsh-punky-swarm CA';
  } catch {
    issuerCn = 'dsh-punky-swarm CA';
  }
  const caKey = crypto.createPrivateKey(caKeyPem);
  return createX509({
    cn,
    issuerCn,
    signerPrivateKey: caKey,
    altNames: [
      ...(aic ? [{ type: 'uri', value: 'acps://' + aic }] : []),
      ...altNames,
    ],
    days,
    isCa: false,
    usages,
  });
}

// ── 文件管理（cert/key/ca 三路径 config 可配，默认 acps 数据目录）──
// ensureAcpsCerts({ dir, aic })：幂等——目录已有 ca.pem/ca.key/server.pem/server.key 则复用；
//   缺则生成落盘。返回 { certFile, keyFile, caFile, caCertPem, certPem }（TLS 上下文 + 联测用）。
// 目录结构：<dir>/ca.pem + ca.key（自签 CA）、<dir>/server.pem + server.key（CA 签发服务端证书）。
export function ensureAcpsCerts({ dir, aic = '1.2.156.3088.1.0001.00001.000000.000000.ROOT' } = {}) {
  mkdirSync(dir, { recursive: true });
  const caFile = join(dir, 'ca.pem');
  const caKeyFile = join(dir, 'ca.key');
  const certFile = join(dir, 'server.pem');
  const keyFile = join(dir, 'server.key');

  let caCertPem;
  let caKeyPem;
  if (existsSync(caFile) && existsSync(caKeyFile)) {
    caCertPem = readFileSync(caFile, 'utf8');
    caKeyPem = readFileSync(caKeyFile, 'utf8');
  } else {
    const ca = generateCaCert();
    caCertPem = ca.certPem;
    caKeyPem = ca.keyPem;
    writeFileSync(caFile, caCertPem, { mode: 0o600 });
    writeFileSync(caKeyFile, caKeyPem, { mode: 0o600 });
  }

  let certPem;
  let keyPem;
  if (existsSync(certFile) && existsSync(keyFile)) {
    certPem = readFileSync(certFile, 'utf8');
    keyPem = readFileSync(keyFile, 'utf8');
  } else {
    const leaf = issueCert({
      caCertPem,
      caKeyPem,
      cn: aic,
      aic,
      altNames: [{ type: 'dns', value: 'localhost' }, { type: 'ip', value: '127.0.0.1' }],
      days: 365,
      usages: ['serverAuth', 'clientAuth'],
    });
    certPem = leaf.certPem;
    keyPem = leaf.keyPem;
    writeFileSync(certFile, certPem, { mode: 0o600 });
    writeFileSync(keyFile, keyPem, { mode: 0o600 });
  }

  return { certFile, keyFile, caFile, caCertPem, certPem };
}
