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

// exec-registry lane 测试（P3 R1 半自动注册客户端）：
//   1) 注册请求结构对齐参考实现 AgentCreate schema（registry-server/app/agent/schema.py:14-30）
//   2) EAB 凭据 AES-256-GCM 加解密（D13：替代参考实现 SM4-CBC，crypto.py:46-53；keyId/macKey 不落明文）
//   3) 装配开关双态（acps.registry 默认关；enabled=true 且 url 配置时可用；缺 url 短路）
//   4) 错误路径（无 token / 非本人 AIC 403 / 缺 eabKey / 解密失败）
//   5) mock registry 服务验证客户端行为（login→upsert→submit→check→requestEab→queryAcs 全链路，
//      对齐 acps-cli RegistryApiClient 调用语义）——真实 registry 互通归 exec-demo-test lane。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import {
  REGISTRY_DEFAULTS, API_BASE_PATH, ATR_BASE_PATH,
  buildRegistrationPayload, deriveAtrBaseUrl, resolveRegistryConfig,
  encryptEabCredential, decryptEabCredential, RegistryClientError,
  RegistryClient, createRegistryClient,
} from '../lib/acps/registry-client.js';

// ── mock registry server（对齐参考实现端点与响应形态）──
function startMockRegistry() {
  const agents = new Map(); // id -> agent（GET /agent/client 列表返回）
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, path: url.pathname, query: url.searchParams.toString(), headers: req.headers, body: rawBody });
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const auth = req.headers.authorization ?? '';
      const isAuthed = auth === 'Bearer mock-token';

      // 登录（参考实现 api_auth.py OAuth2PasswordRequestForm → {access_token,...}）
      if (req.method === 'POST' && url.pathname === `${API_BASE_PATH}/auth/login`) {
        if (rawBody.includes('username=user') && rawBody.includes('password=pass')) {
          send(200, { access_token: 'mock-token', token_type: 'bearer', refresh_token: 'mock-refresh' });
        } else {
          send(401, { detail: 'Incorrect username or password' });
        }
        return;
      }
      // 创建 Agent 草稿（api.py:337-357 client_create_new_agent → AgentResponse）
      if (req.method === 'POST' && url.pathname === `${API_BASE_PATH}/agent/client`) {
        if (!isAuthed) return send(401, { detail: 'Authentication required' });
        const body = JSON.parse(rawBody || '{}');
        const id = 'ag-' + (agents.size + 1);
        const agent = {
          id, name: body.name, version: body.version, aic: null,
          acs: body.acs, is_ontology: body.is_ontology === true,
          approval_status: 'DRAFT', is_active: false, is_deleted: false, is_disabled: false,
        };
        agents.set(id, agent);
        send(200, agent);
        return;
      }
      // 更新 Agent 草稿（api.py:396-419 client_update_agent_info）
      if (req.method === 'PUT' && /^\/api\/v1\/agent\/client\/[^/]+$/.test(url.pathname)) {
        if (!isAuthed) return send(401, { detail: 'Authentication required' });
        const id = url.pathname.split('/').pop();
        const existing = agents.get(id);
        if (!existing) return send(404, { detail: 'Agent not found' });
        const body = JSON.parse(rawBody || '{}');
        Object.assign(existing, body);
        send(200, existing);
        return;
      }
      // Agent 列表（api.py:360-393 client_read_agents → AgentListResponse {items,total}）
      if (req.method === 'GET' && url.pathname === `${API_BASE_PATH}/agent/client`) {
        if (!isAuthed) return send(401, { detail: 'Authentication required' });
        let items = [...agents.values()];
        const name = url.searchParams.get('name');
        const version = url.searchParams.get('version');
        const aic = url.searchParams.get('aic');
        if (name) items = items.filter((a) => a.name === name);
        if (version) items = items.filter((a) => a.version === version);
        if (aic) items = items.filter((a) => a.aic === aic);
        send(200, { items, total: items.length, page_num: 1, page_size: 100 });
        return;
      }
      // 提交人工审核（client.py:314-318 submit_agent → PENDING）
      if (req.method === 'POST' && /^\/api\/v1\/agent\/client\/[^/]+\/submit$/.test(url.pathname)) {
        if (!isAuthed) return send(401, { detail: 'Authentication required' });
        const parts = url.pathname.split('/');
        const id = parts[parts.length - 2];
        const agent = agents.get(id);
        if (!agent) return send(404, { detail: 'Agent not found' });
        agent.approval_status = 'PENDING';
        send(200, agent);
        return;
      }
      // EAB 申请（eab/api.py:43-59 → EabCredentialResponse {keyId,macKey,aic,expiresAt}）
      if (req.method === 'POST' && /^\/acps-atr-v2\/eab\/[^/]+$/.test(url.pathname)) {
        if (!isAuthed) return send(401, { detail: 'Authentication required' });
        const aic = decodeURIComponent(url.pathname.split('/').pop());
        if (aic.includes('NOTMINE')) return send(403, { detail: 'Agent AIC not owned by user' });
        if (aic.includes('INACTIVE')) return send(403, { detail: 'Agent AIC is inactive' });
        send(201, {
          keyId: 'mock-key-id-' + aic.slice(-4),
          macKey: 'mockMacKeyBase64abcdefghijklmnopqrstuvwxyz0123456789',
          aic,
          expiresAt: '2026-08-23T12:00:00+08:00',
        });
        return;
      }
      // 公开 ACS 查询（api_atr.py:118-188 get_agent_acs_by_aic：active:true 才 200）
      if (req.method === 'GET' && /^\/acps-atr-v2\/acs\/[^/]+$/.test(url.pathname)) {
        const aic = decodeURIComponent(url.pathname.split('/').pop());
        if (aic.includes('INACTIVE')) return send(403, { detail: 'Agent status is not active', error: { code: 'AGENT_INACTIVE', message: 'Agent status is not active' } });
        send(200, { aic, active: true, name: 'mock-agent', version: '1.0.0', protocolVersion: '02.01' });
        return;
      }
      send(404, { detail: 'Not found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}${API_BASE_PATH}`,
        requests,
        close: async () => { server.close(); await once(server, 'close').catch(() => {}); },
      });
    });
  });
}

test('buildRegistrationPayload：对齐参考实现 AgentCreate schema（name/version/acs/is_ontology/description）', () => {
  const acs = {
    aic: 'dsh.plan.coder',
    name: 'coder',
    description: '执行层 Coder 角色',
    version: '0.3.2',
    active: true,
    protocolVersion: '02.01',
    skills: [{ id: 'dsh.skill.dev-coder', name: 'dev-coder', description: 'x', version: '1', tags: [] }],
  };
  const payload = buildRegistrationPayload(acs, { is_ontology: true });
  // 键对齐 AgentCreate（schema.py:14-30）：name/version 必填，acs 嵌入，is_ontology 布尔，description 可选
  assert.deepEqual(Object.keys(payload).sort(), ['acs', 'description', 'is_ontology', 'name', 'version']);
  assert.equal(payload.name, 'coder');
  assert.equal(payload.version, '0.3.2');
  assert.equal(payload.is_ontology, true);
  assert.equal(payload.acs, acs); // acs 原样嵌入
  assert.equal(payload.description, '执行层 Coder 角色');
});

test('buildRegistrationPayload：name/version 缺失抛错；logo_url 可选；is_ontology 默认 false', () => {
  assert.throws(() => buildRegistrationPayload({ name: 'x' }), /non-empty string fields/);
  assert.throws(() => buildRegistrationPayload({ version: '1' }), /non-empty string fields/);
  assert.throws(() => buildRegistrationPayload(null), TypeError);
  const p = buildRegistrationPayload({ name: 'n', version: '1' });
  assert.equal(p.is_ontology, false);
  assert.equal(p.description, undefined);
  assert.equal(p.logo_url, undefined);
  const withLogo = buildRegistrationPayload({ name: 'n', version: '1' }, { logo_url: 'https://x/a.png' });
  assert.equal(withLogo.logo_url, 'https://x/a.png');
});

test('deriveAtrBaseUrl：对齐 _infer_default_atr_base_url（{origin}/api/v1 → {origin}/acps-atr-v2）', () => {
  assert.equal(deriveAtrBaseUrl('http://localhost:9001/api/v1'), 'http://localhost:9001/acps-atr-v2');
  assert.equal(deriveAtrBaseUrl('http://localhost:9001'), 'http://localhost:9001/acps-atr-v2');
  assert.equal(deriveAtrBaseUrl('http://localhost:9001/api'), 'http://localhost:9001/acps-atr-v2');
  assert.equal(deriveAtrBaseUrl('https://reg.example.com/api/v1'), 'https://reg.example.com/acps-atr-v2');
  assert.equal(deriveAtrBaseUrl('not a url'), null);
});

test('resolveRegistryConfig：默认关（enabled=false 零路径）', () => {
  const off = resolveRegistryConfig({});
  assert.equal(off.enabled, false);
  assert.equal(off.apiBaseUrl, null);
  assert.equal(off.atrBaseUrl, null);
  const explicitOff = resolveRegistryConfig({ acps: { registry: { enabled: false, url: 'http://x' } } });
  assert.equal(explicitOff.enabled, false);
});

test('resolveRegistryConfig：enabled=true 且 url 配置 → 启用；enabled=true 缺 url → 短路禁用+reason', () => {
  const on = resolveRegistryConfig({ acps: { registry: { enabled: true, url: 'http://localhost:9001/api/v1', username: 'u', password: 'p' } } });
  assert.equal(on.enabled, true);
  assert.equal(on.apiBaseUrl, 'http://localhost:9001/api/v1');
  assert.equal(on.atrBaseUrl, 'http://localhost:9001/acps-atr-v2');
  assert.equal(on.username, 'u');
  const missing = resolveRegistryConfig({ acps: { registry: { enabled: true } } });
  assert.equal(missing.enabled, false);
  assert.match(missing.reason, /registry.url is missing/);
});

test('EAB 凭据 AES-256-GCM：加解密往返，keyId/macKey 不落明文', () => {
  const credential = {
    keyId: 'abc123def456',
    macKey: 'k7xY9zQ2mN4vB6wE8rT0uI1oP3aS5dF7',
    aic: '1.2.156.3088.1.0001.00001.ABC123.000000.ABC123',
    expiresAt: '2026-08-23T12:00:00+08:00',
  };
  const envelope = encryptEabCredential(credential, '0'.repeat(64));
  const serialized = JSON.stringify(envelope);
  // keyId/macKey 明文不出现（D13：不落明文）
  assert.equal(serialized.includes(credential.keyId), false);
  assert.equal(serialized.includes(credential.macKey), false);
  // aic/expiresAt 元数据可明文旁路（非密钥材料）
  assert.equal(envelope.aic, credential.aic);
  assert.equal(envelope.expiresAt, credential.expiresAt);
  const back = decryptEabCredential(envelope, '0'.repeat(64));
  assert.equal(back.keyId, credential.keyId);
  assert.equal(back.macKey, credential.macKey);
  assert.equal(back.aic, credential.aic);
});

test('EAB 加密：密钥形态（hex / urlsafe-b64 / 字符串派生）与错误路径', () => {
  const credential = { keyId: 'k1', macKey: 'm1' };
  const hexKey = 'a'.repeat(64);
  const e1 = encryptEabCredential(credential, hexKey);
  assert.deepEqual(decryptEabCredential(e1, hexKey), { keyId: 'k1', macKey: 'm1', aic: null, expiresAt: null });
  // 错 key 解密失败（GCM auth tag 校验）
  assert.throws(() => decryptEabCredential(e1, 'b'.repeat(64)), /decryption failed/);
  // 篡改密文 → 解密失败
  const tampered = { ...e1, ct: e1.ct.slice(0, -2) + (e1.ct.endsWith('AA') ? 'BB' : 'AA') };
  assert.throws(() => decryptEabCredential(tampered, hexKey), /decryption failed/);
  // 缺 key → 抛 EAB_KEY_MISSING
  assert.throws(() => encryptEabCredential(credential, ''), /key is required/);
  // keyId/macKey 缺失 → EAB_CREDENTIAL_INVALID
  assert.throws(() => encryptEabCredential({ aic: 'x' }, hexKey), /must contain keyId and macKey/);
  // 非法信封
  assert.throws(() => decryptEabCredential({ alg: 'SM4' }, hexKey), /Invalid EAB credential envelope/);
});

test('RegistryClient：禁用时构造抛 REGISTRY_DISABLED；createRegistryClient 短路返回 null', () => {
  assert.throws(() => new RegistryClient({ acps: { registry: {} } }), /disabled/);
  assert.equal(createRegistryClient({ acps: { registry: {} } }), null);
  assert.equal(createRegistryClient({ acps: { registry: { enabled: true } } }), null);
  const client = createRegistryClient({ acps: { registry: { enabled: true, url: 'http://x/api/v1' } } });
  assert.ok(client instanceof RegistryClient);
});

test('RegistryClient：无 token 调需认证方法抛 NO_TOKEN', async () => {
  const client = new RegistryClient({ acps: { registry: { enabled: true, url: 'http://x/api/v1' } } });
  await assert.rejects(() => client.listMyAgents({}), /No access token found/);
  await assert.rejects(() => client.requestEab('AIC'), /No access token found/);
});

test('mock registry：login → upsert(created) → submit → check → requestEab → queryAcs 全链路', async (t) => {
  const mock = await startMockRegistry();
  t.after(() => mock.close());
  const cfg = {
    acps: { registry: { enabled: true, url: mock.baseUrl, username: 'user', password: 'pass', eabKey: 'c'.repeat(64) } },
  };
  const client = new RegistryClient(cfg);

  // login
  await client.login();
  assert.equal(client.hasToken, true);

  // upsert（无已有 → created，POST /agent/client 载荷对齐 AgentCreate）
  const acs = { aic: 'dsh.plan.coder', name: 'coder', description: 'd', version: '0.3.2', active: true, protocolVersion: '02.01', skills: [] };
  const created = await client.upsertAgent(acs, { is_ontology: true });
  assert.equal(created.action, 'created');
  assert.equal(created.agent.approval_status, 'DRAFT');
  assert.equal(created.agent.is_ontology, true);

  // upsert 幂等（同 name+version → updated，PUT /agent/client/{id}）
  const updated = await client.upsertAgent({ ...acs, description: 'd2' }, { is_ontology: true });
  assert.equal(updated.action, 'updated');
  assert.equal(updated.agent.id, created.agent.id);

  // submit 人工审核
  const submitted = await client.submitAgent(created.agent.id);
  assert.equal(submitted.approval_status, 'PENDING');

  // check（DRAFT 时返回 draft；模拟审批通过后 approved）
  const draftCheck = await client.checkAgent(acs);
  assert.equal(draftCheck.status, 'pending');
  // 模拟 staff 审批通过 + 服务端分配 AIC（service_command.py:368-369 语义）
  const agent = mock.requests.length && created.agent;
  const listRes = await client.listMyAgents({ name: 'coder', version: '0.3.2' });
  assert.equal(listRes.total, 1);
  assert.equal(listRes.items[0].id, agent.id);

  // requestEab（POST /acps-atr-v2/eab/{aic}，JWT；mock 未要求 AIC 存在，直接按路径返回）
  const eab = await client.requestEab('1.2.156.3088.1.0001.00001.ABC123.000000.ABC123');
  assert.ok(typeof eab.keyId === 'string' && typeof eab.macKey === 'string');
  assert.ok(eab.expiresAt);

  // EAB 加密存证（keyId/macKey 不落明文）
  const envelope = client.encryptEab(eab);
  const serialized = JSON.stringify(envelope);
  assert.equal(serialized.includes(eab.macKey), false);
  const decrypted = decryptEabCredential(envelope, 'c'.repeat(64));
  assert.equal(decrypted.keyId, eab.keyId);
  assert.equal(decrypted.macKey, eab.macKey);

  // queryAcs（公开端点，无需 token；active:true → 200 ACS）
  const acsInfo = await client.queryAcs('1.2.156.3088.1.0001.00001.ABC123.000000.ABC123');
  assert.equal(acsInfo.active, true);
  assert.equal(acsInfo.name, 'mock-agent');

  // 请求记录抽查：eab 走 atrBase（/acps-atr-v2/eab/...），带 Bearer；agent 走 apiBase（/agent/client）
  const eabReq = mock.requests.find((r) => r.path.startsWith('/acps-atr-v2/eab/'));
  assert.ok(eabReq, 'eab request recorded');
  assert.equal(eabReq.headers.authorization, 'Bearer mock-token');
  const createReq = mock.requests.find((r) => r.method === 'POST' && r.path === '/api/v1/agent/client');
  assert.ok(createReq, 'create request recorded');
  const createBody = JSON.parse(createReq.body);
  assert.equal(createBody.name, 'coder');
  assert.equal(createBody.is_ontology, true);
  assert.ok(createBody.acs && createBody.acs.name === 'coder');
  await mock.close();
});

test('mock registry：错误路径——登录失败 401、EAB 403 非本人/非 active、ACS 403 非 active、404', async (t) => {
  const mock = await startMockRegistry();
  t.after(() => mock.close());
  const client = new RegistryClient({
    acps: { registry: { enabled: true, url: mock.baseUrl, username: 'user', password: 'wrong' } },
  });
  await assert.rejects(() => client.login(), (err) => {
    assert.ok(err instanceof RegistryClientError);
    assert.equal(err.status, 401);
    assert.match(err.message, /Incorrect username or password/);
    return true;
  });

  const ok = new RegistryClient({
    acps: { registry: { enabled: true, url: mock.baseUrl, username: 'user', password: 'pass' } },
  });
  await ok.login();

  // EAB 403（非本人 AIC：service.py:51-55 AgentAicNotOwnedError）
  await assert.rejects(() => ok.requestEab('1.2.156.3088.1.0001.00001.NOTMINE.000000.ABCD'), (err) => {
    assert.equal(err.status, 403);
    assert.match(err.message, /not owned/);
    return true;
  });
  // EAB 403（非 active：service.py:54-55 AgentAicInactiveError）
  await assert.rejects(() => ok.requestEab('1.2.156.3088.1.0001.00001.INACTIVE.000000.ABCD'), (err) => {
    assert.equal(err.status, 403);
    return true;
  });
  // ACS 403（非 active：api_atr.py:177-186）
  await assert.rejects(() => ok.queryAcs('1.2.156.3088.1.0001.00001.INACTIVE.000000.ABCD'), (err) => {
    assert.equal(err.status, 403);
    assert.equal(err.errorName, 'AGENT_INACTIVE');
    return true;
  });
  // 未知端点 404
  await assert.rejects(() => ok._request('GET', '/nope'), (err) => {
    assert.equal(err.status, 404);
    return true;
  });
  await mock.close();
});

test('mock registry：缺 eabKey 时 encryptEab 抛 EAB_KEY_MISSING（不静默落明文）', async (t) => {
  const mock = await startMockRegistry();
  t.after(() => mock.close());
  const client = new RegistryClient({
    acps: { registry: { enabled: true, url: mock.baseUrl, username: 'user', password: 'pass' } },
  });
  // encryptEab 为同步方法（本地加密），用 assert.throws 断言
  assert.throws(
    () => client.encryptEab({ keyId: 'k', macKey: 'm' }),
    (err) => err instanceof RegistryClientError && err.errorName === 'EAB_KEY_MISSING',
  );
  await mock.close();
});

test('REGISTRY_DEFAULTS：装配默认值（enabled=false）', () => {
  assert.equal(REGISTRY_DEFAULTS.enabled, false);
  assert.equal(REGISTRY_DEFAULTS.timeoutMs, 10000);
  assert.equal(API_BASE_PATH, '/api/v1');
  assert.equal(ATR_BASE_PATH, '/acps-atr-v2');
});
