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

import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { URL } from 'node:url';

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

export function deriveAtrBaseUrl(apiBaseUrl) {
  const parsed = parseUrl(apiBaseUrl);
  if (!parsed) return null;
  let path = parsed.pathname.replace(/\/+$/, '');
  if (path.endsWith('/api/v1')) path = path.slice(0, -'/api/v1'.length);
  else if (path.endsWith('/api')) path = path.slice(0, -'/api'.length);
  parsed.pathname = `${path}/acps-atr-v2`;
  return parsed.toString().replace(/\/+$/, '');
}

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


function normalizeEabKey(keyInput) {
  if (typeof keyInput !== 'string' || !keyInput) {
    throw new RegistryClientError('EAB encryption key is required (acps.registry.eabKey)', { errorName: 'EAB_KEY_MISSING' });
  }
  const trimmed = keyInput.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
  if (/^[A-Za-z0-9_-]{43}=?$/.test(trimmed)) {
    try {
      return Buffer.from(trimmed.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    } catch {
    }
  }
  return crypto.createHash('sha256').update(trimmed, 'utf8').digest();
}

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

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

export class RegistryClient {
  constructor(config) {
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

  async listMyAgents({ pageNum = 1, pageSize = 100, statuses = [], name = null, version = null, aic = null, isDeleted = false } = {}) {
    const params = new URLSearchParams({ page_num: String(pageNum), page_size: String(pageSize) });
    if (Array.isArray(statuses) && statuses.length) {
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

  async submitAgent(agentId) {
    const agent = await this._request('POST', `/agent/client/${agentId}/submit`, { auth: true });
    return agent;
  }

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

  encryptEab(credential) {
    if (!this.config.eabKey) {
      throw new RegistryClientError('acps.registry.eabKey is not configured; cannot encrypt EAB credential', {
        errorName: 'EAB_KEY_MISSING',
      });
    }
    return encryptEabCredential(credential, this.config.eabKey);
  }

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

export function createRegistryClient(config) {
  const resolved = resolveRegistryConfig(config);
  if (!resolved.enabled) return null;
  return new RegistryClient(resolved);
}
