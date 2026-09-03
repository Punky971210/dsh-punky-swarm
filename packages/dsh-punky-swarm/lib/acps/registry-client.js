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

// registry-client：半自动注册客户端（registry-server 对接）
// EAB macKey 本地加密存证（AES-256-GCM）。审计：注册需用户凭据（EAB 要求用户拥有 active AIC），
// 人工审核不得自动化跳过。
// 约束：零新 node_modules 依赖——HTTP 用 node:http/https、加密用 node:crypto。
// 默认关：acps.registry.enabled=false；装配仅建客户端实例，不自动发起注册
// （注册需用户凭据、人工审核不自动化跳过——半自动注册，动作由用户显式触发）。
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { URL } from 'node:url';

// ── 配置键默认值（装配契约：acps.registry，默认关）──
// url：registry public 面 API 基址（默认 http://localhost:9001/api/v1；
//   传 {origin} 或 {origin}/api/v1 均可，本模块自动规整 apiBase/atrBase）
// username/password：registry 用户凭据（config/env 注入，不硬编码、不落仓库）
// eabKey：EAB macKey 本地加密密钥（hex 32B / urlsafe-base64 43-44 字符 / 任意字符串经 sha256 派生 32B；
//   缺省 null = 禁用加密存证能力，requestEab 仅返回明文凭据由调用方自存，不落盘）
// token：可选预置 Bearer token（跳过 login；与 username/password 二选一）
// timeoutMs / rejectUnauthorized：HTTP 层参数（默认 10s / 校验 TLS 证书）
export const REGISTRY_DEFAULTS = Object.freeze({
  enabled: false,
  url: null,
  username: null,
  password: null,
  token: null,
  eabKey: null,
  timeoutMs: 10000,
  rejectUnauthorized: true,
});

export const API_BASE_PATH = '/api/v1';   // 对齐参考实现 settings.api_v1_str 默认（config.py api_v1_str）
export const ATR_BASE_PATH = '/acps-atr-v2'; // 对齐参考实现 settings.atr_base_path 默认（config.py:277-278）

// 注册请求结构（对齐参考实现 AgentCreate schema：registry-server/app/agent/schema.py:14-30）
//   AgentCreate = { name, version, description?, logo_url?, acs?, is_ontology? }
//   用户侧 upsert 载荷构造见 commands.py:382-391（name/version 取自 ACS 必填文本字段，
//   description 可选、is_ontology 布尔、acs 原样嵌入）。
export function buildRegistrationPayload(acs, opts = {}) {
  if (!acs || typeof acs !== 'object') {
    throw new TypeError('buildRegistrationPayload: acs must be an object');
  }
  const name = typeof acs.name === 'string' && acs.name.trim() ? acs.name.trim() : null;
  const version = typeof acs.version === 'string' && acs.version.trim() ? acs.version.trim() : null;
  if (!name || !version) {
    throw new Error('ACS JSON must contain non-empty string fields: name, version');
  }
  const payload = {
    name,
    version,
    acs,
    is_ontology: opts.is_ontology === true,
  };
  if (typeof opts.description === 'string' && opts.description.trim()) {
    payload.description = opts.description.trim();
  } else if (typeof acs.description === 'string' && acs.description.trim()) {
    payload.description = acs.description.trim();
  }
  if (typeof opts.logo_url === 'string' && opts.logo_url.trim()) {
    payload.logo_url = opts.logo_url.trim();
  }
  return payload;
}

// 错误类：对齐参考实现 RegistryClientError 语义（registry/client.py:116-142、170-183）——
//   携带 status_code 与 payload；消息优先取 payload.error.message / detail / title / message。
export class RegistryClientError extends Error {
  constructor(message, { status = null, payload = null, errorName = null } = {}) {
    super(message);
    this.name = 'RegistryClientError';
    this.status = status;
    this.payload = payload;
    this.errorName = errorName;
  }
}

function extractErrorMessage(payload, defaultMessage) {
  if (payload && typeof payload === 'object') {
    const error = payload.error;
    if (error && typeof error === 'object' && typeof error.message === 'string' && error.message.trim()) {
      return error.message.trim();
    }
    for (const field of ['detail', 'title', 'message']) {
      const v = payload[field];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return defaultMessage;
}

function parseUrl(base) {
  if (typeof base !== 'string' || !base.trim()) return null;
  try {
    return new URL(base);
  } catch {
    return null;
  }
}

// atrBase 推导（对齐 acps-cli config.py:29-35 _infer_default_atr_base_url）：
//   apiBase 形如 {origin}/api/v1 或 {origin} → 统一 {origin}/acps-atr-v2
export function deriveAtrBaseUrl(apiBaseUrl) {
  const parsed = parseUrl(apiBaseUrl);
  if (!parsed) return null;
  let path = parsed.pathname.replace(/\/+$/, '');
  if (path.endsWith('/api/v1')) path = path.slice(0, -'/api/v1'.length);
  else if (path.endsWith('/api')) path = path.slice(0, -'/api'.length);
  parsed.pathname = `${path}/acps-atr-v2`;
  return parsed.toString().replace(/\/+$/, '');
}

// 配置解析：acps.registry 键（默认关）
//   enabled=true 且 url 可解析 → 返回启用配置；否则 enabled=false（装配短路，零路径）。
//   enabled=true 但缺 url → 返回 enabled=false 并携带 reason（供日志告警，不抛错不炸宿主）。
export function resolveRegistryConfig(config) {
  const c = config?.acps?.registry ?? {};
  const resolved = {
    ...REGISTRY_DEFAULTS,
    ...(c && typeof c === 'object' ? c : {}),
  };
  const url = typeof resolved.url === 'string' && resolved.url.trim() ? resolved.url.trim() : null;
  resolved.url = url;
  resolved.username = typeof resolved.username === 'string' && resolved.username ? resolved.username : null;
  resolved.password = typeof resolved.password === 'string' && resolved.password ? resolved.password : null;
  resolved.token = typeof resolved.token === 'string' && resolved.token ? resolved.token : null;
  resolved.eabKey = typeof resolved.eabKey === 'string' && resolved.eabKey ? resolved.eabKey : null;
  resolved.timeoutMs = Number.isFinite(Number(resolved.timeoutMs)) && Number(resolved.timeoutMs) > 0
    ? Math.floor(Number(resolved.timeoutMs))
    : REGISTRY_DEFAULTS.timeoutMs;

  if (resolved.enabled !== true) {
    return { ...resolved, enabled: false, apiBaseUrl: null, atrBaseUrl: null };
  }
  if (!url) {
    return { ...resolved, enabled: false, apiBaseUrl: null, atrBaseUrl: null, reason: 'acps.registry.enabled=true but registry.url is missing' };
  }
  const apiBaseUrl = url.endsWith('/') ? url.slice(0, -1) : url;
  return {
    ...resolved,
    enabled: true,
    apiBaseUrl,
    atrBaseUrl: deriveAtrBaseUrl(apiBaseUrl) ?? apiBaseUrl,
  };
}

// ── EAB macKey 本地加密存证（Node 侧 AES-256-GCM）──
// 参考实现服务端用 SM4-CBC 加密 mac_key 后入库（registry-server/app/core/crypto.py:46-53 sm4_encrypt、
//   app/eab/service.py:63 sm4_encrypt(mac_key, settings.sm4_encryption_key)）；node:crypto 无 SM4 原语，
//   AES-256-GCM（node:crypto 内建，零新依赖）。差异标注：
//   - 算法不同：SM4-CBC（对称分组 128bit，PKCS#7）↔ AES-256-GCM（AEAD，密文+认证标签）；
//   - 存储形态不同：参考实现 iv+密文 urlsafe-base64 拼接（crypto.py:53），本实现 iv+tag+密文 base64
//     信封对象；
//   - 不跨节点互操作：SM4 仅 registry 服务端内部存储（消费端 acme.py 收的是明文 macKey），
//     本加密仅插件本地存证用途，不参与任何跨节点协议（README 标注见 exec/registry.md）。
// 安全语义：AES-256-GCM 随机 12B IV + 16B auth tag；keyId/macKey 均不落明文（整体加密进 ct）。

function normalizeEabKey(keyInput) {
  if (typeof keyInput !== 'string' || !keyInput) {
    throw new RegistryClientError('EAB encryption key is required (acps.registry.eabKey)', { errorName: 'EAB_KEY_MISSING' });
  }
  const trimmed = keyInput.trim();
  // hex 32B（64 hex chars）
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
  // urlsafe-base64 32B（43-44 chars，无 padding 或带 padding）
  if (/^[A-Za-z0-9_-]{43}=?$/.test(trimmed)) {
    try {
      return Buffer.from(trimmed.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    } catch {
      // fallthrough 到 sha256 派生
    }
  }
  // 其余字符串：sha256 派生 32B（确定性，非密码学 KDF——密钥本身来自 config/env，非用户口令）
  return crypto.createHash('sha256').update(trimmed, 'utf8').digest();
}

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// 加密 EAB 凭据（keyId/macKey 不落明文）→ 信封对象 { v, alg, aic, expiresAt, iv, tag, ct }
export function encryptEabCredential(credential, keyInput) {
  if (!credential || typeof credential !== 'object') {
    throw new RegistryClientError('encryptEabCredential: credential must be an object', { errorName: 'EAB_CREDENTIAL_INVALID' });
  }
  const key = normalizeEabKey(keyInput);
  const keyId = credential.keyId ?? credential.key_id ?? null;
  const macKey = credential.macKey ?? credential.mac_key ?? null;
  if (!keyId || !macKey) {
    throw new RegistryClientError('EAB credential must contain keyId and macKey', { errorName: 'EAB_CREDENTIAL_INVALID' });
  }
  const secret = JSON.stringify({ keyId, macKey });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: 'AES-256-GCM',
    aic: typeof credential.aic === 'string' ? credential.aic : null,
    expiresAt: typeof credential.expiresAt === 'string' ? credential.expiresAt : null,
    iv: b64url(iv),
    tag: b64url(tag),
    ct: b64url(ct),
  };
}

// 解密 EAB 凭据信封 → { keyId, macKey, aic, expiresAt }
export function decryptEabCredential(envelope, keyInput) {
  if (!envelope || typeof envelope !== 'object' || envelope.alg !== 'AES-256-GCM') {
    throw new RegistryClientError('Invalid EAB credential envelope', { errorName: 'EAB_ENVELOPE_INVALID' });
  }
  const key = normalizeEabKey(keyInput);
  const iv = unb64url(envelope.iv);
  const tag = unb64url(envelope.tag);
  const ct = unb64url(envelope.ct);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (err) {
    throw new RegistryClientError('EAB credential decryption failed (wrong key or corrupted envelope)', {
      errorName: 'EAB_DECRYPT_FAILED',
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new RegistryClientError('EAB credential payload is corrupted', { errorName: 'EAB_DECRYPT_FAILED' });
  }
  return {
    keyId: parsed.keyId ?? null,
    macKey: parsed.macKey ?? null,
    aic: typeof envelope.aic === 'string' ? envelope.aic : null,
    expiresAt: typeof envelope.expiresAt === 'string' ? envelope.expiresAt : null,
  };
}

// ── HTTP 层（node:http/https 内建，零新依赖）──
// 对齐参考实现 RegistryApiClient._request 语义（client.py:63-142）：
//   - 非 2xx → RegistryClientError（status + payload）
//   - 204/空响应 → {}
//   - JSON 解析失败 → RegistryClientError
function httpRequest(method, url, { headers = {}, body = null, timeoutMs = 10000, rejectUnauthorized = true } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new RegistryClientError(`Invalid URL: ${url}`));
      return;
    }
    const isHttps = parsed.protocol === 'https:';
    if (!isHttps && parsed.protocol !== 'http:') {
      reject(new RegistryClientError(`Unsupported protocol: ${parsed.protocol}`));
      return;
    }
    const mod = isHttps ? https : http;
    const reqOptions = {
      method,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      headers: { Accept: 'application/json', ...headers },
      timeout: timeoutMs,
    };
    if (isHttps) {
      reqOptions.rejectUnauthorized = rejectUnauthorized;
    }
    const req = mod.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let payload = null;
        if (raw.length > 0) {
          try {
            payload = JSON.parse(raw);
          } catch {
            payload = raw;
          }
        }
        const status = res.statusCode ?? 0;
        if (status >= 400) {
          const message = extractErrorMessage(payload, `API request failed: ${method} ${parsed.pathname}`);
          reject(new RegistryClientError(message, { status, payload, errorName: (payload?.error?.code) ?? null }));
          return;
        }
        if (status === 204 || raw.length === 0) {
          resolve({ status, data: {} });
          return;
        }
        if (typeof payload === 'string') {
          reject(new RegistryClientError('Invalid JSON response from server', { status, payload }));
          return;
        }
        resolve({ status, data: payload });
      });
    });
    req.on('timeout', () => {
      req.destroy(new RegistryClientError(`Request timeout after ${timeoutMs}ms: ${method} ${parsed.pathname}`, { errorName: 'REQUEST_TIMEOUT' }));
    });
    req.on('error', (err) => {
      if (err instanceof RegistryClientError) reject(err);
      else reject(new RegistryClientError(`Request failed: ${err.message}`, { errorName: 'REQUEST_FAILED' }));
    });
    if (body !== null) {
      req.write(body);
    }
    req.end();
  });
}

// ── RegistryClient：半自动注册客户端 ──
// 方法与参考实现 acps-cli RegistryApiClient / commands 编排对齐（见文件头映射）。
// 半自动语义（V3）：login/upsert/submit/requestEab 均为显式动作；本体注册需人工审核
// （submit 后由 registry staff 审批，服务端在审批通过时分配权威 AIC——service_command.py:368-369），
// 本客户端不模拟、不绕过、不自动重试审核；checkAgent 供轮询审批状态。
export class RegistryClient {
  constructor(config) {
    // 支持两种输入形态：原始插件 config（{ acps: { registry: {...} } }）或
    // resolveRegistryConfig 已解析配置（含 enabled/apiBaseUrl/atrBaseUrl 平铺键）
    const resolved = (config && config.acps && config.acps.registry) ? resolveRegistryConfig(config) : config;
    if (!resolved || resolved.enabled !== true) {
      throw new RegistryClientError('acps.registry is disabled (acps.registry.enabled=true and registry.url required)', {
        errorName: 'REGISTRY_DISABLED',
      });
    }
    this.config = resolved;
    this.apiBaseUrl = resolved.apiBaseUrl;
    this.atrBaseUrl = resolved.atrBaseUrl;
    this._token = resolved.token ?? null;
    this.timeoutMs = resolved.timeoutMs;
    this.rejectUnauthorized = resolved.rejectUnauthorized !== false;
  }

  get hasToken() {
    return Boolean(this._token);
  }

  _authHeaders() {
    if (!this._token) {
      throw new RegistryClientError('No access token found, run login() first', { errorName: 'NO_TOKEN' });
    }
    return { Authorization: `Bearer ${this._token}` };
  }

  async _request(method, path, { auth = false, body = null, json = null, form = null, baseUrl = null } = {}) {
    const targetBase = baseUrl ?? this.apiBaseUrl;
    const url = `${targetBase}${path}`;
    const headers = {};
    if (auth) {
      if (!this._token) {
        throw new RegistryClientError('No access token found, run login() first', { errorName: 'NO_TOKEN' });
      }
      headers.Authorization = `Bearer ${this._token}`;
    }
    let payload = null;
    if (json !== null) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(json);
    } else if (form !== null) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(form).toString();
    } else if (body !== null) {
      payload = body;
    }
    const { data } = await httpRequest(method, url, {
      headers,
      body: payload,
      timeoutMs: this.timeoutMs,
      rejectUnauthorized: this.rejectUnauthorized,
    });
    return data;
  }

  // 登录（对齐 client.py:185-195：POST /auth/login，form username/password → {access_token,...}）
  async login() {
    const { username, password } = this.config;
    if (!username || !password) {
      throw new RegistryClientError('login requires acps.registry.username/password (config/env injection)', {
        errorName: 'CREDENTIALS_MISSING',
      });
    }
    const result = await this._request('POST', '/auth/login', { form: { username, password } });
    if (!result || typeof result !== 'object' || typeof result.access_token !== 'string') {
      throw new RegistryClientError('Login response missing access_token', { payload: result });
    }
    this._token = result.access_token;
    return result;
  }

  // 当前用户 Agent 列表（对齐 client.py:275-300 list_my_agents：GET /agent/client + 查询参数）
  async listMyAgents({ pageNum = 1, pageSize = 100, statuses = [], name = null, version = null, aic = null, isDeleted = false } = {}) {
    const params = new URLSearchParams({ page_num: String(pageNum), page_size: String(pageSize) });
    if (Array.isArray(statuses) && statuses.length) {
      // 对齐参考实现 list_my_agents（client.py:286-288）：statuses 列表 → 重复 query 键（FastAPI list 参数）
      for (const s of statuses) params.append('statuses', String(s));
    }
    if (name) params.append('name', name);
    if (version) params.append('version', version);
    if (aic) params.append('aic', aic);
    if (isDeleted !== null) params.append('is_deleted', String(isDeleted).toLowerCase());
    const result = await this._request('GET', `/agent/client?${params.toString()}`, { auth: true });
    if (!result || typeof result !== 'object' || !Array.isArray(result.items)) {
      throw new RegistryClientError('Invalid response for list_my_agents', { payload: result });
    }
    return result;
  }

  // 按 AIC / name+version 定位本人 Agent（对齐 commands.py:133-142 _resolve_agent_from_acs）
  async findMyAgent({ aic = null, name = null, version = null } = {}) {
    if (aic) {
      const byAic = await this.listMyAgents({ aic: aic.trim().toUpperCase() });
      if (byAic.items.length) return byAic.items[0];
    }
    if (name && version) {
      const byNv = await this.listMyAgents({ name, version });
      for (const item of byNv.items) {
        if (item.name === name && item.version === version) return item;
      }
    }
    return null;
  }

  // 创建/更新 Agent（对齐 commands.py upsert_agent 361-414 + schema.py AgentCreate 14-30）：
  //   按 name+version 查已有 → 有则 PUT 更新，无则 POST 创建；返回 { action:'created'|'updated', agent }
  async upsertAgent(acs, opts = {}) {
    const payload = buildRegistrationPayload(acs, opts);
    const existing = await this.findMyAgent({ name: payload.name, version: payload.version });
    if (existing && existing.id) {
      const agent = await this._request('PUT', `/agent/client/${existing.id}`, { auth: true, json: payload });
      return { action: 'updated', agent };
    }
    const agent = await this._request('POST', '/agent/client', { auth: true, json: payload });
    return { action: 'created', agent };
  }

  // 提交人工审核（对齐 client.py:314-318 + commands.py submit 417-438；V3：审核不自动化跳过）
  async submitAgent(agentId) {
    const agent = await this._request('POST', `/agent/client/${agentId}/submit`, { auth: true });
    return agent;
  }

  // 注册状态查询（对齐 commands.py check 507-541 _derive_agent_status 157-165）：
  //   返回 { status, agent? }，status ∈ draft/pending/approved/rejected/unknown/missing
  async checkAgent(acs) {
    const payload = buildRegistrationPayload(acs, {});
    const agent = await this.findMyAgent({ aic: typeof acs.aic === 'string' ? acs.aic : null, name: payload.name, version: payload.version });
    if (!agent) return { status: 'missing', agent: null };
    const approvalStatus = String(agent.approval_status ?? '').toUpperCase();
    let status;
    if (approvalStatus === 'APPROVED' && agent.aic) status = 'approved';
    else if (approvalStatus === 'PENDING') status = 'pending';
    else if (approvalStatus === 'DRAFT') status = 'draft';
    else if (approvalStatus === 'REJECTED') status = 'rejected';
    else status = approvalStatus.toLowerCase() || 'unknown';
    return { status, agent };
  }

  // 获取 EAB 凭据（对齐 eab/api.py:43-59 + client.py:438-447：POST {atrBase}/eab/{aic}，JWT）
  //   返回 { keyId, macKey, aic, expiresAt }；V3 语义：仅限本人 active AIC（service.py:51-55），
  //   403 = 非本人/非 active。
  async requestEab(aic) {
    if (!aic || typeof aic !== 'string' || !aic.trim()) {
      throw new RegistryClientError('requestEab requires aic', { errorName: 'AIC_REQUIRED' });
    }
    const result = await this._request('POST', `/eab/${encodeURIComponent(aic.trim().toUpperCase())}`, {
      auth: true,
      baseUrl: this.atrBaseUrl,
    });
    if (!result || typeof result !== 'object' || typeof result.keyId !== 'string' || typeof result.macKey !== 'string') {
      throw new RegistryClientError('Registry server returned an invalid EAB payload', { payload: result });
    }
    return result;
  }

  // EAB 凭据 → AES-GCM 加密信封（keyId/macKey 不落明文）
  encryptEab(credential) {
    if (!this.config.eabKey) {
      throw new RegistryClientError('acps.registry.eabKey is not configured; cannot encrypt EAB credential', {
        errorName: 'EAB_KEY_MISSING',
      });
    }
    return encryptEabCredential(credential, this.config.eabKey);
  }

  // 公开 ACS 查询（对齐 api_atr.py:118-188 get_agent_acs_by_aic：GET {atrBase}/acs/{aic}，
  //   非 active → 403；用于 V3 存证验证）
  async queryAcs(aic) {
    if (!aic || typeof aic !== 'string' || !aic.trim()) {
      throw new RegistryClientError('queryAcs requires aic', { errorName: 'AIC_REQUIRED' });
    }
    const result = await this._request('GET', `/acs/${encodeURIComponent(aic.trim().toUpperCase())}`, {
      baseUrl: this.atrBaseUrl,
    });
    return result;
  }
}

// 工厂：配置 → RegistryClient（装配用；enabled=false 返回 null——短路零路径）
export function createRegistryClient(config) {
  const resolved = resolveRegistryConfig(config);
  if (!resolved.enabled) return null;
  return new RegistryClient(resolved);
}
