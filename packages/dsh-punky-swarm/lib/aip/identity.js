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

// 文件 identity：国标 P2/P3 身份体系（AIC 身份码 + CAI 身份证书）
// -----------------------------------------------------------------------------
// 校准基准（plan/spec.md §3.4/§3.5，[参考] = ACPs-community v2.1.0 原文）：
//   P2 身份码 AIC：10 级编码（前缀 1.2.156.3088 + 版本/ARSP/供应商/本体/实体 + 校验码），
//     CRC-16/CCITT-FALSE（poly=0x1021, init=0xFFFF, refin/refout=false, xorout=0x0000）+
//     ARSP 盐值（>=2 字节）+ Base36 固定 4 位校验码（ACPs-spec-AIC-v02.01 §4）。
//   P3 身份管理：CAI（Certificate of Agent Identity）证书——CN=AIC、SAN=URI:acps://{AIC}、
//     extendedKeyUsage 分用途（clientAuth/serverAuth）、有效期 requestedValidity（默认 49 天、
//     建议 365~1825、上限 3650）；EAB（External Account Binding）凭证绑定 ACME 账户与 AIC；
//     认证走 TLS1.3 mTLS（ACPs-spec-ATR-v02.01 §3.2/§3.3，ACPs-spec-AIA-v02.01）。
//   SM2 校准：参考实现 v2.1.0 证书体系为 X.509/ACME（ECDSA/RSA），无 SM2 证据——
//     本模块 sign 实现为可插拔接口：默认 ECDSA/RSA（node:crypto 原生，可跑可验签），
//     算法可配置；SM2 留接口位（algorithm='sm2' 显式拒绝并提示），标注『SM2 待正式文本校准』。
// 装配开关：identity 默认关（config.aip.identity.enabled === true 时调用方才激活本模块 API，
//   由 lib/assembly/schema.js CAPABILITY_REGISTRY 声明）；不注册新治理工具（20 工具契约不变），
//   身份能力经本模块 API 暴露。零运行时副作用（纯函数 + 可选 store 注入）。
// -----------------------------------------------------------------------------
import crypto from 'node:crypto';

// ---- AIC 常量（ACPs-spec-AIC-v02.01）----
export const AIC_PREFIX = '1.2.156.3088'; // 国家 OID 注册中心分配的前缀
export const BASE36_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const BASE36_INDEX = Object.fromEntries([...BASE36_ALPHABET].map((ch, i) => [ch, i]));

// 默认分段（对齐参考实现 registry-server/app/utils/aic.py 常量）
export const DEFAULT_VERSION = '1';          // 第 5 级：身份码版本号（1~Z）
export const DEFAULT_ARSP = '0001';          // 第 6 级：智能体注册服务商序号（1~ZZZZZZ）
export const DEFAULT_VENDOR = '00001';       // 第 7 级：智能体供应商序号（1~ZZZZZZ）
export const DEFAULT_ONTOLOGY_SERIAL_LEN = 6; // 第 8 级：本体序列号长度（1~9）
export const DEFAULT_INSTANCE_SERIAL_LEN = 6; // 第 9 级：实体序列号长度（1~9）

// 校验码（第 10 级）固定 4 位 Base36
export const CHECKSUM_LEN = 4;

// 签名算法注册表（可插拔接口；sm2 仅占位，待正式文本校准）
export const SIGN_ALGORITHMS = {
  'ecdsa-p256': { curve: 'prime256v1', hash: 'sha256', nodeName: 'ecdsa' },
  'rsa-2048': { modulusLength: 2048, hash: 'sha256', nodeName: 'rsa' },
  sm2: null, // SM2 待正式文本校准（参考实现 v2.1.0 无证据，不硬实现）
};
export const DEFAULT_SIGN_ALGORITHM = 'ecdsa-p256';

// CAI 证书默认参数（ACPs-spec-ATR-v02.01 §3.2(12)）
export const CAI_DEFAULT_VALIDITY_DAYS = 49;   // 默认 49 天
export const CAI_MAX_VALIDITY_DAYS = 3650;     // 上限 3650 天
export const CAI_EAB_EXPIRE_HOURS = 24;        // EAB 凭证有效期（对齐参考实现 settings 语义）

// ---- Base36 编解码 ----
export function base36Encode(num, length = 0) {
  if (!Number.isInteger(num) || num < 0) throw new Error('base36Encode: num must be a non-negative integer');
  if (num === 0) return '0'.padStart(length, '0');
  let s = '';
  let n = num;
  while (n > 0) {
    s = BASE36_ALPHABET[n % 36] + s;
    n = Math.floor(n / 36);
  }
  return length > 0 ? s.padStart(length, '0') : s;
}

export function base36Decode(str) {
  const s = String(str ?? '').trim().toUpperCase();
  if (s === '') return 0;
  let val = 0;
  for (const ch of s) {
    if (!(ch in BASE36_INDEX)) throw new Error('base36Decode: invalid base36 char ' + JSON.stringify(ch));
    val = val * 36 + BASE36_INDEX[ch];
  }
  return val;
}

// ---- CRC-16/CCITT-FALSE（ACPs-spec-AIC-v02.01 §4.1；向量已对照参考实现）----
export function crc16CcittFalse(data, salt = Buffer.alloc(0)) {
  const buf = Buffer.concat([Buffer.from(data, 'ascii'), Buffer.from(salt)]);
  let crc = 0xFFFF;
  for (const b of buf) {
    crc ^= (b << 8) & 0xFFFF;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  return crc & 0xFFFF;
}

// 盐值解析：'' | '0x1234' | '1234' → Buffer；hex 非偶数字符左补 0（对齐参考实现）
export function parseSalt(salt) {
  if (salt === undefined || salt === null || salt === '') return Buffer.alloc(0);
  if (Buffer.isBuffer(salt)) return salt;
  let hex = String(salt).trim();
  if (hex.toLowerCase().startsWith('0x')) hex = hex.slice(2);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  return Buffer.from(hex, 'hex');
}

// 计算第 10 级校验码（固定 4 位 Base36）
export function calculateAicChecksum(body1to9, salt = '') {
  const normalized = String(body1to9).replace(/\s+/g, '').toUpperCase();
  const crc = crc16CcittFalse(normalized, parseSalt(salt));
  return base36Encode(crc, CHECKSUM_LEN);
}

// AIC 规范化（大写、去空白，保留 '.' 分隔符）
export function normalizeAic(aic) {
  return String(aic ?? '').replace(/\s+/g, '').toUpperCase();
}

export function splitAic(aic) {
  const n = normalizeAic(aic);
  if (n === '') return [];
  const parts = n.split('.');
  return parts.some((p) => p === '') ? [] : parts;
}

// 格式 + CRC 校验（对齐参考实现 validate_aic；expectedPrefix 默认 1.2.156.3088）
export function validateAic(aic, { salt = '', expectedPrefix = AIC_PREFIX } = {}) {
  const parts = splitAic(aic);
  if (parts.length !== 10) return false;
  const prefixParts = expectedPrefix ? expectedPrefix.split('.') : [];
  if (prefixParts.length && JSON.stringify(parts.slice(0, prefixParts.length)) !== JSON.stringify(prefixParts)) return false;
  // 1~4 级纯数字（OID 前缀）
  if (!parts.slice(0, 4).every((p) => /^[0-9]+$/.test(p))) return false;
  // 第 5 级：Base36 单字符
  if (!/^[0-9A-Z]{1}$/.test(parts[4])) return false;
  // 第 6/7 级：Base36 1~6 位
  if (!/^[0-9A-Z]{1,6}$/.test(parts[5])) return false;
  if (!/^[0-9A-Z]{1,6}$/.test(parts[6])) return false;
  // 第 8/9 级：Base36 1~9 位
  if (!/^[0-9A-Z]{1,9}$/.test(parts[7])) return false;
  if (!/^[0-9A-Z]{1,9}$/.test(parts[8])) return false;
  // 第 10 级：固定 4 位 Base36
  if (!/^[0-9A-Z]{4}$/.test(parts[9])) return false;
  const body = parts.slice(0, 9).join('.');
  return calculateAicChecksum(body, salt) === parts[9];
}

export function isOntologyAic(aic) {
  const parts = splitAic(aic);
  if (parts.length !== 10) return false;
  return /^0+$/.test(parts[8]) && parts[8].length > 0;
}

export function isEntityAic(aic) {
  return !isOntologyAic(aic);
}

// 随机 Base36 序列号（非全 0；len 1~9；确定性测试可注入）
function randomBase36Serial(len, avoidZero = true) {
  let serial;
  do {
    const bytes = crypto.randomBytes(Math.ceil((len * 5) / 4) + 1); // 冗余熵，避免截断偏置
    const num = parseInt(bytes.toString('hex').slice(0, 12), 16);
    serial = base36Encode(num % Math.pow(36, len), len);
  } while (avoidZero && /^0+$/.test(serial));
  return serial;
}

// 生成 AIC（10 级）；opts：{ version, arsp, vendor, ontologySerial, instanceSerial, salt }
// 本体 AIC：instanceSerial 全 0；实体 AIC：instanceSerial 非全 0（entity=true）
export function generateAic(opts = {}) {
  const version = opts.version ?? DEFAULT_VERSION;
  const arsp = opts.arsp ?? DEFAULT_ARSP;
  const vendor = opts.vendor ?? DEFAULT_VENDOR;
  if (!/^[0-9A-Z]{1}$/.test(String(version))) throw new Error('generateAic: version must be 1~Z (1 char)');
  if (!/^[0-9A-Z]{1,6}$/.test(String(arsp))) throw new Error('generateAic: arsp must be base36 1~6 chars');
  if (!/^[0-9A-Z]{1,6}$/.test(String(vendor))) throw new Error('generateAic: vendor must be base36 1~6 chars');

  const ontologySerial = opts.ontologySerial ?? randomBase36Serial(DEFAULT_ONTOLOGY_SERIAL_LEN);
  const isEntity = opts.entity === true || opts.instanceSerial !== undefined;
  const instanceSerial = opts.instanceSerial
    ?? (isEntity ? randomBase36Serial(DEFAULT_INSTANCE_SERIAL_LEN) : '0'.repeat(DEFAULT_INSTANCE_SERIAL_LEN));
  if (!/^[0-9A-Z]{1,9}$/.test(ontologySerial)) throw new Error('generateAic: ontologySerial must be base36 1~9 chars');
  if (!/^[0-9A-Z]{1,9}$/.test(instanceSerial)) throw new Error('generateAic: instanceSerial must be base36 1~9 chars');

  const body = `${AIC_PREFIX}.${version}.${arsp}.${vendor}.${ontologySerial}.${instanceSerial}`;
  const checksum = calculateAicChecksum(body, opts.salt ?? '');
  return `${body}.${checksum}`;
}

// ---- 存储（最小侵入：内存 store；调用方可注入持久化实现）----
export function createMemoryStore() {
  const map = new Map();
  return {
    get: (k) => map.get(k),
    set: (k, v) => { map.set(k, v); return v; },
    has: (k) => map.has(k),
    delete: (k) => map.delete(k),
    list: () => [...map.keys()],
  };
}

// ---- 密钥对生成（node:crypto 原生）----
function generateKeyPair(algorithm) {
  if (algorithm === 'ecdsa-p256') {
    return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  }
  if (algorithm === 'rsa-2048') {
    return crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  }
  throw new Error('generateKeyPair: unsupported algorithm ' + JSON.stringify(algorithm));
}

// ---- P2/P3 四函数 ----

/**
 * AIC 身份码注册：分配 10 级身份码（前缀 1.2.156.3088 + 版本/ARSP/供应商/本体/实体 + CRC 校验码），
 * 持久化并查重（同 name 已注册 → 幂等返回既有记录）。
 * @param {object} identity 待注册身份 { kind: 'agent'|'tool', name: string, provider? }
 * @param {object} [opts] { store?, salt?, arsp?, vendor?, entity?, version? }
 *   store：{ get, set }（缺省内存 store，跨进程不持久；生产传状态根 identity/ 目录实现）
 * @returns {Promise<{ oid: string, aic: string, record: object, reused: boolean }>}
 */
export async function registerIdentity(identity, opts = {}) {
  const kind = identity?.kind ?? 'agent';
  const name = identity?.name;
  if (typeof name !== 'string' || name.trim() === '') throw new Error('registerIdentity: identity.name is required');
  const store = opts.store ?? (registerIdentity._defaultStore ??= createMemoryStore());

  const key = 'identity:' + kind + ':' + name.trim();
  const existing = store.get(key);
  if (existing) return { oid: existing.aic, aic: existing.aic, record: existing, reused: true };

  const aic = generateAic({
    version: opts.version,
    arsp: opts.arsp,
    vendor: opts.vendor,
    entity: opts.entity,
    salt: opts.salt,
  });
  const record = {
    aic,
    kind,
    name: name.trim(),
    provider: identity.provider ?? null,
    createdAt: new Date().toISOString(),
    isOntology: isOntologyAic(aic),
  };
  store.set(key, record);
  store.set('aic:' + aic, record); // 反查索引
  return { oid: aic, aic, record, reused: false };
}

/**
 * CAI 身份证书发行：按 ACPs-ATR 语义构造证书（CN=AIC、SAN=URI:acps://{AIC}、extendedKeyUsage 分用途、
 * 有效期 requestedValidity）+ EAB 凭证（绑定 ACME 账户与 AIC）+ 证书存证。
 * @param {object} identity 已注册身份 { aic: string }
 * @param {object} [claims] 附加声明 { role?, layer?, org?, usage?: 'clientAuth'|'serverAuth',
 *   requestedValidityDays?, altNames? }
 * @param {object} [opts] { store?, algorithm?, salt?, issuer?, signingKey? }
 *   issuer：证书签发者描述 { aic, name }（缺省默认 CASP 根）
 *   signingKey：issuer 的签发密钥 { algorithm, privateKey }（信任链语义：证书由 issuer 私钥签发，
 *     验签用 issuer 公钥）；缺省回退：store 中有 issuer AIC 的 key 则用之，否则用证书自身私钥（自签场景）
 * @returns {Promise<{ credential: object, eab: object, keyRef: object }>}
 */
export async function issueCredential(identity, claims = {}, opts = {}) {
  const aic = identity?.aic ?? identity?.oid;
  if (typeof aic !== 'string' || !validateAic(aic, { salt: opts.salt })) {
    throw new Error('issueCredential: valid identity.aic (AIC) is required');
  }
  const store = opts.store ?? (issueCredential._defaultStore ??= createMemoryStore());

  const algorithm = opts.algorithm ?? DEFAULT_SIGN_ALGORITHM;
  if (!SIGN_ALGORITHMS[algorithm]) throw new Error('issueCredential: unsupported algorithm ' + JSON.stringify(algorithm));
  const { publicKey, privateKey } = generateKeyPair(algorithm);

  const usage = claims.usage === 'serverAuth' ? 'serverAuth' : 'clientAuth'; // 分用途签发
  const validityDays = Math.min(
    Math.max(Number.isInteger(claims.requestedValidityDays) ? claims.requestedValidityDays : CAI_DEFAULT_VALIDITY_DAYS, 1),
    CAI_MAX_VALIDITY_DAYS,
  );
  const now = new Date();
  const notAfter = new Date(now.getTime() + validityDays * 24 * 60 * 60 * 1000);

  const credential = {
    version: '02.01',
    type: 'CAI',
    aic,
    cn: aic, // CN=AIC（不附加域名后缀）
    san: ['URI:acps://' + aic, ...(claims.altNames ?? [])],
    extendedKeyUsage: [usage],
    notBefore: now.toISOString(),
    notAfter: notAfter.toISOString(),
    validityDays,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    algorithm,
    subject: {
      aic,
      role: claims.role ?? null,
      layer: claims.layer ?? null,
      org: claims.org ?? null,
    },
    issuer: opts.issuer ?? { aic: '1.2.156.3088.1.0001.00001.000000.000000.ROOT', name: 'CASP' },
  };

  // EAB 凭证（ACPs-ATR §3.2(4)：keyId + macKey 一次性绑定 AIC 与 ACME 账户）
  const eab = {
    keyId: crypto.randomUUID().replace(/-/g, ''),
    macKey: crypto.randomBytes(32).toString('base64url'),
    aic,
    expiresAt: new Date(now.getTime() + CAI_EAB_EXPIRE_HOURS * 60 * 60 * 1000).toISOString(),
  };

  // 证书签名（证书核心载荷 → sign；验签走 verifySignature）
  // 信任链语义：证书由 issuer 的私钥签发，验签用 issuer 的公钥（见 verifyTrustChain）
  const core = JSON.stringify({ ...credential, signature: undefined });
  let signingKey = opts.signingKey;
  if (!signingKey) {
    const issuerKey = store.get('key:' + (opts.issuer?.aic ?? aic));
    if (issuerKey) signingKey = issuerKey; // issuer 已在本 store 持有密钥 → 用之签发
  }
  const signature = signingKey
    ? await sign(core, signingKey)
    : await sign(core, { algorithm, privateKey }); // 无 issuer 密钥 → 自签（根锚/单凭证场景）
  credential.signature = signature;

  const keyRef = { keyId: 'key:' + aic, algorithm, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  store.set('credential:' + aic, credential);
  store.set('eab:' + eab.keyId, eab);
  store.set('key:' + aic, keyRef);
  return { credential, eab, keyRef };
}

/**
 * 数字签名：可插拔算法接口。默认 ECDSA P-256（node:crypto 原生，可跑可验签），
 * 可选 RSA-2048；SM2 仅占位（参考实现 v2.1.0 无 SM2 证据）——algorithm='sm2' 显式拒绝。
 * @param {string|Buffer} payload 待签内容
 * @param {object} keyRef { algorithm, privateKey } 或 { keyId }（经 store 解析）
 * @param {object} [opts] { store? }
 * @returns {Promise<{ signature: string, algorithm: string }>} base64url 签名
 */
export async function sign(payload, keyRef, opts = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  let algorithm = keyRef?.algorithm;
  let privateKey = keyRef?.privateKey;
  if (!privateKey && keyRef?.keyId) {
    const stored = (opts.store ?? (sign._defaultStore ??= createMemoryStore())).get(keyRef.keyId);
    if (!stored?.privateKey) throw new Error('sign: key not found for keyRef ' + keyRef.keyId);
    algorithm = stored.algorithm;
    privateKey = stored.privateKey;
  }
  if (!privateKey) throw new Error('sign: keyRef.privateKey (or keyId with store) is required');
  if (algorithm === 'sm2') {
    // SM2 待正式文本校准：参考实现 v2.1.0 无 SM2 证据，不硬实现
    throw new Error('sign: SM2 待正式文本校准（ACPs v2.1.0 无 SM2 证据，暂不实现；请用 ecdsa-p256 / rsa-2048）');
  }
  if (!algorithm || !SIGN_ALGORITHMS[algorithm]) {
    throw new Error('sign: unsupported algorithm ' + JSON.stringify(algorithm));
  }
  const spec = SIGN_ALGORITHMS[algorithm];
  const key = typeof privateKey === 'string'
    ? crypto.createPrivateKey(privateKey)
    : privateKey;
  const signature = crypto.sign(spec.hash, data, { key });
  return { signature: signature.toString('base64url'), algorithm };
}

/**
 * 验签（与 sign 配对；供信任链验证与外部调用方使用）
 * @param {string|Buffer} payload 原始内容
 * @param {string} signature base64url 签名
 * @param {object} keyRef { algorithm, publicKey }
 * @returns {Promise<boolean>}
 */
export async function verifySignature(payload, signature, keyRef) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const algorithm = keyRef?.algorithm;
  if (!algorithm || !SIGN_ALGORITHMS[algorithm]) return false;
  const spec = SIGN_ALGORITHMS[algorithm];
  const key = typeof keyRef.publicKey === 'string'
    ? crypto.createPublicKey(keyRef.publicKey)
    : keyRef.publicKey;
  try {
    return crypto.verify(spec.hash, data, key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

/**
 * 信任链验证：沿凭证链自近而远验证至根信任锚。
 * 规则：结构校验（CAI 类型 + AIC 格式）→ 有效期 → 吊销检查 → 逐级验签（证书签名由上级公钥验证）
 * → 路径深度限制 → 根锚确认。
 * @param {object} credential 待验凭证（issueCredential 产出）
 * @param {Array<object>} chain 上级凭证链（自近而远；末级为根，其 issuer.aic 须命中 trustAnchors 或自签）
 * @param {object} [opts] { trustAnchors?: string[], revokedAics?: string[], maxDepth?: number, salt? }
 * @returns {Promise<{ ok: boolean, reason?: string, depth: number }>}
 */
export async function verifyTrustChain(credential, chain = [], opts = {}) {
  const trustAnchors = opts.trustAnchors ?? [];
  const revoked = new Set(opts.revokedAics ?? []);
  const maxDepth = opts.maxDepth ?? 5;
  const salt = opts.salt ?? '';

  const fail = (reason) => ({ ok: false, reason, depth: 0 });

  if (!credential || typeof credential !== 'object') return fail('credential must be an object');
  if (credential.type !== 'CAI') return fail('credential.type must be CAI');
  if (!validateAic(credential.aic, { salt })) return fail('credential.aic is not a valid AIC');

  // 吊销检查（本级 + 链上全部 AIC）
  const aicChain = [credential.aic, ...chain.map((c) => c?.aic).filter(Boolean)];
  if (aicChain.some((a) => revoked.has(a))) return fail('revoked AIC in chain: ' + aicChain.filter((a) => revoked.has(a)).join(','));

  // 有效期
  const now = Date.now();
  if (Date.parse(credential.notAfter) < now) return fail('credential expired (notAfter=' + credential.notAfter + ')');
  if (Date.parse(credential.notBefore) > now) return fail('credential not yet valid (notBefore=' + credential.notBefore + ')');

  // 路径深度限制
  const depth = chain.length + 1;
  if (depth > maxDepth) return fail('chain depth ' + depth + ' exceeds maxDepth ' + maxDepth);

  // 逐级验签：本级 signature 用 issuer 公钥（chain[0] 的 publicKey）验证
  const verifyOne = async (cert, issuerCert) => {
    if (!issuerCert?.publicKey) return false;
    const core = JSON.stringify({ ...cert, signature: undefined });
    return verifySignature(core, cert?.signature?.signature, {
      algorithm: cert?.signature?.algorithm ?? issuerCert.algorithm,
      publicKey: issuerCert.publicKey,
    });
  };

  if (chain.length === 0) {
    // 单凭证：须为自签且命中根锚（或显式信任该 AIC）
    const selfSigned = credential.issuer?.aic === credential.aic;
    const anchored = trustAnchors.includes(credential.aic) || trustAnchors.includes(credential.issuer?.aic);
    if (!selfSigned || !anchored) {
      return fail('single credential must be self-signed and match a trust anchor (issuer.aic=' + credential.issuer?.aic + ')');
    }
    return { ok: true, depth };
  }

  // 链式验证：credential ← chain[0] ← chain[1] ← ... ← 根
  let prev = credential;
  for (let i = 0; i < chain.length; i++) {
    const issuerCert = chain[i];
    if (!issuerCert || typeof issuerCert !== 'object') return fail('chain[' + i + '] is not a certificate');
    if (issuerCert.type !== 'CAI') return fail('chain[' + i + '].type must be CAI');
    if (Date.parse(issuerCert.notAfter) < now) return fail('chain[' + i + '] expired');
    const sigOk = await verifyOne(prev, issuerCert);
    if (!sigOk) return fail('signature verification failed at chain[' + i + '] (issuer=' + issuerCert.aic + ')');
    prev = issuerCert;
  }

  // 根锚：末级 issuer 须命中 trustAnchors（或末级自签且命中）
  const root = chain[chain.length - 1];
  const rootSelfSigned = root.issuer?.aic === root.aic;
  const anchored = trustAnchors.includes(root.aic)
    || (rootSelfSigned && trustAnchors.includes(root.issuer?.aic));
  if (!anchored) return fail('root not in trust anchors (root.aic=' + root.aic + ', issuer=' + root.issuer?.aic + ')');

  return { ok: true, depth };
}
