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

// P3 DS1 外部 ADP 发现客户端单测（lib/acps/discovery-client.js）：
// 请求结构（对齐参考实现 DiscoveryRequest）/ 响应解析 / 查询范围选项（local/external/both）/
// 开关双态（acps.discovery 默认关）/ 错误路径（未配置/连接失败/超时/HTTP 错误/协议错误/无效响应）。
// 基准：ACPs-community v2.1.0（demo-leader discovery_client.py + acps_sdk/adp/models.py + discovery-server）。
// 真实互通（插件 Leader ↔ 参考实现 discovery-server / demo-partner）归 exec-demo-test lane（V2），本文件不依赖外部服务。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAcpsDiscoveryClient, createMiniAdsp, DiscoveryClientError,
  buildDiscoveryRequest, parseDiscoveryResponse, flattenAgentSkills,
  DISCOVERY_SCOPES, DISCOVERY_SCOPE_DEFAULT,
} from '../lib/acps/discovery-client.js';
import { resolveAcpsDiscoveryConfig, ACPS_DISCOVERY_DEFAULTS } from '../lib/schema.js';
import { successResponse } from '../lib/discovery/schema.js';

// ── 测试替身 ──
// HTTP stub：捕获请求 + 可编程响应（闭包变量，避免 this 绑定问题）
function makeHttpStub() {
  const calls = [];
  let response = null;
  let error = null;
  return {
    calls,
    stub(r) { response = r; },
    stubError(e) { error = e; },
    async impl(url, options) {
      calls.push({ url, options, body: JSON.parse(options.body) });
      if (error) throw error;
      return response;
    },
  };
}
const okJson = (obj, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => obj,
});
// 本地查询服务替身（对齐 lib/discovery/service.js discover 返回 { result } 形态）
const localServiceStub = (result, error = null) => ({
  discover: async () => (error ? { error } : successResponse(result)),
  calls: 0,
});

const EXTERNAL_ACS = {
  'AIC-EXT-1': { name: 'beijing_food', active: true, endPoints: [{ transport: 'JSONRPC', url: 'https://127.0.0.1:9004/rpc' }] },
};
const EXTERNAL_RESPONSE = {
  result: {
    acsMap: EXTERNAL_ACS,
    agents: [{ group: '北京旅行', agentSkills: [{ aic: 'AIC-EXT-1', skillId: 'food.recommend', ranking: 1, memo: 'keyword score: 5' }] }],
    routes: [{ forwardChain: ['AIC-DS-A'], agentGroups: [{ group: '北京旅行', agentSkills: [{ aic: 'AIC-EXT-1', skillId: 'food.recommend', ranking: 1 }] }], status: 'ok', durationMs: 3 }],
  },
};
const LOCAL_ACS = { 'AIC-LOCAL-1': { name: 'wave_plan', active: true } };
const LOCAL_RESULT = {
  acsMap: LOCAL_ACS,
  agents: [{ group: '本地工具', agentSkills: [{ aic: 'AIC-LOCAL-1', skillId: 'wave_plan', ranking: 1 }] }],
  routes: [{ forwardChain: ['AIC-DS-A'], agentGroups: [{ group: '本地工具', agentSkills: [{ aic: 'AIC-LOCAL-1', skillId: 'wave_plan', ranking: 1 }] }], status: 'ok', durationMs: 1 }],
};

// ── 请求结构（对齐参考实现 DiscoveryRequest，discovery_client.py:72-77 + models.py:245-443）──
test('buildDiscoveryRequest: explicit 默认 type + query + limit（对齐 DiscoveryRequest 字段集）', () => {
  const raw = buildDiscoveryRequest('北京美食推荐', { limit: 8 }, 5);
  assert.equal(raw.type, 'explicit');
  assert.equal(raw.query, '北京美食推荐');
  assert.equal(raw.limit, 8);
  // lowerCamelCase 字段名逐字（对齐 models.py alias）
  assert.deepEqual(Object.keys(raw).sort(), ['limit', 'query', 'type']);
});

test('buildDiscoveryRequest: limit 钳制 [1,50]（对齐 normalizeLimit/DISCOVERY_LIMIT_MAX）', () => {
  assert.equal(buildDiscoveryRequest('q', { limit: 999 }, 5).limit, 50);
  assert.equal(buildDiscoveryRequest('q', { limit: 0 }, 5).limit, 1);
  assert.equal(buildDiscoveryRequest('q', {}, 5).limit, 5); // 缺省用客户端默认
});

test('buildDiscoveryRequest: filter / context / forward* 透传，非白名单字段不注入', () => {
  const filter = { conditions: [{ field: 'active', op: 'eq', value: true }] };
  const raw = buildDiscoveryRequest('q', {
    filter,
    context: { conversationId: 'c1' },
    forwardDepthLimit: 2,
    forwardFanoutLimit: 3,
    forwardChain: ['AIC-1'],
    evil: 'x',
  }, 5);
  assert.equal(raw.filter, filter);
  assert.deepEqual(raw.context, { conversationId: 'c1' });
  assert.equal(raw.forwardDepthLimit, 2);
  assert.equal(raw.forwardFanoutLimit, 3);
  assert.deepEqual(raw.forwardChain, ['AIC-1']);
  assert.equal(raw.evil, undefined);
});

// ── 响应解析（对齐 DiscoveryResponse models.py:664-757：result/error 互斥）──
test('parseDiscoveryResponse: 成功响应 → { result }（acsMap/agents/agentSkills/routes）', () => {
  const parsed = parseDiscoveryResponse(EXTERNAL_RESPONSE);
  assert.ok(parsed.result);
  assert.deepEqual(parsed.result.acsMap, EXTERNAL_ACS);
  assert.equal(parsed.result.agents[0].agentSkills[0].skillId, 'food.recommend');
  assert.equal(parsed.result.routes[0].status, 'ok');
});

test('flattenAgentSkills: 展平 agents 并关联 acsMap（对齐 iter_agent_skills models.py:609-626）', () => {
  const rows = flattenAgentSkills(EXTERNAL_RESPONSE.result);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].aic, 'AIC-EXT-1');
  assert.deepEqual(rows[0].acs, EXTERNAL_ACS['AIC-EXT-1']);
  assert.equal(rows[0].group, '北京旅行');
  // acs 缺失时兜底空对象
  const rows2 = flattenAgentSkills({ acsMap: {}, agents: [{ group: 'g', agentSkills: [{ aic: 'X', skillId: 's' }] }] });
  assert.deepEqual(rows2[0].acs, {});
});

test('parseDiscoveryResponse: 协议级错误（HTTP 200 + error）→ 抛 DiscoveryClientError + adpError', () => {
  assert.throws(
    () => parseDiscoveryResponse({ error: { code: 40001, message: 'MissingQuery', data: { field: 'query' } } }),
    (e) => e instanceof DiscoveryClientError
      && /协议错误/.test(e.message)
      && e.adpError && e.adpError.code === 40001 && e.adpError.message === 'MissingQuery',
  );
});

test('parseDiscoveryResponse: 无效响应（缺 result / agents 非数组 / acsMap 非对象）', () => {
  assert.throws(() => parseDiscoveryResponse({}), /缺少 result/);
  assert.throws(() => parseDiscoveryResponse({ result: null }), /缺少 result/);
  assert.throws(() => parseDiscoveryResponse({ result: { agents: {} } }), /agents 非数组/);
  assert.throws(() => parseDiscoveryResponse({ result: { acsMap: [] } }), /acsMap 非对象/);
  assert.throws(() => parseDiscoveryResponse({ result: { routes: {} } }), /routes 非数组/);
  assert.throws(() => parseDiscoveryResponse([1, 2]), /非 JSON 对象/);
});

// ── 查询范围选项（local/external/both，装配可配）──
test('scope=local: 走本地查询服务，不发起外部请求', async () => {
  const local = { discover: async () => successResponse(LOCAL_RESULT) };
  const http = makeHttpStub();
  const client = createAcpsDiscoveryClient({ baseUrl: 'http://ds:9020', scope: 'local', localService: local, request: http.impl });
  const resp = await client.discover('北京美食');
  assert.deepEqual(resp.result.acsMap, LOCAL_ACS);
  assert.equal(http.calls.length, 0); // 未触碰外部
});

test('scope=external: POST {baseUrl}/discover（对齐 discovery_client.py:86-93）', async () => {
  const http = makeHttpStub();
  http.stub(okJson(EXTERNAL_RESPONSE));
  const client = createAcpsDiscoveryClient({ baseUrl: 'http://ds:9020/', scope: 'external', request: http.impl });
  const resp = await client.discover('北京美食推荐', { limit: 3 });
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].url, 'http://ds:9020/discover'); // 尾斜杠去除 + /discover
  assert.equal(http.calls[0].options.method, 'POST');
  assert.equal(http.calls[0].options.headers['content-type'], 'application/json');
  const body = http.calls[0].body;
  assert.equal(body.type, 'explicit');
  assert.equal(body.query, '北京美食推荐');
  assert.equal(body.limit, 3);
  assert.deepEqual(resp.result.acsMap, EXTERNAL_ACS);
  assert.equal(resp.result.agents[0].group, '北京旅行');
});

test('scope=both: 本地+外部合并（acsMap 合并 / agents 拼接 / routes 拼接）', async () => {
  const local = { discover: async () => successResponse(LOCAL_RESULT) };
  const http = makeHttpStub();
  http.stub(okJson(EXTERNAL_RESPONSE));
  const client = createAcpsDiscoveryClient({ baseUrl: 'http://ds:9020', scope: 'both', localService: local, request: http.impl });
  const resp = await client.discover('美食');
  assert.equal(http.calls.length, 1);
  assert.deepEqual(resp.result.acsMap, { ...LOCAL_ACS, ...EXTERNAL_ACS });
  assert.equal(resp.result.agents.length, 2);
  assert.equal(resp.result.routes.length, 2);
});

test('scope=both: 外部通道失败时如实降级返回本地结果', async () => {
  const local = { discover: async () => successResponse(LOCAL_RESULT) };
  const http = makeHttpStub();
  http.stubError(new TypeError('fetch failed'));
  const client = createAcpsDiscoveryClient({ baseUrl: 'http://ds:9020', scope: 'both', localService: local, request: http.impl });
  const resp = await client.discover('美食');
  assert.deepEqual(resp.result.acsMap, LOCAL_ACS);
});

test('scope=both: 无本地服务且外部未配置 → 明确报错', async () => {
  const client = createAcpsDiscoveryClient({ scope: 'both', localService: null });
  await assert.rejects(client.discover('q'), /无可用通道/);
});

test('客户端工厂: 非法 scope → TypeError；DISCOVERY_SCOPES 导出', () => {
  assert.deepEqual(DISCOVERY_SCOPES, ['local', 'external', 'both']);
  assert.equal(DISCOVERY_SCOPE_DEFAULT, 'local');
  assert.throws(() => createAcpsDiscoveryClient({ scope: 'all' }), TypeError);
});

// ── 开关双态（acps.discovery 默认关，U-D2 显式开启）──
test('resolveAcpsDiscoveryConfig: 缺省/空配置 → enabled:false + 默认值（零路径）', () => {
  const cfg = resolveAcpsDiscoveryConfig({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.baseUrl, '');
  assert.equal(cfg.timeout, ACPS_DISCOVERY_DEFAULTS.timeout);
  assert.equal(cfg.limit, ACPS_DISCOVERY_DEFAULTS.limit);
  assert.equal(cfg.scope, 'local');
  assert.equal(resolveAcpsDiscoveryConfig({ acps: { endpoint: { enabled: false } } }).enabled, false); // 其他 acps 键不误开
});

test('resolveAcpsDiscoveryConfig: 显式 enabled:true + 覆盖值生效；非法值回退默认', () => {
  const cfg = resolveAcpsDiscoveryConfig({
    acps: { discovery: { enabled: true, baseUrl: 'http://ds:9020/', timeout: 3000, limit: 9, scope: 'external' } },
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.baseUrl, 'http://ds:9020/');
  assert.equal(cfg.timeout, 3000);
  assert.equal(cfg.limit, 9);
  assert.equal(cfg.scope, 'external');
  const bad = resolveAcpsDiscoveryConfig({ acps: { discovery: { enabled: true, scope: 'nope', timeout: -1, limit: 'x' } } });
  assert.equal(bad.scope, 'local');
  assert.equal(bad.timeout, ACPS_DISCOVERY_DEFAULTS.timeout);
  assert.equal(bad.limit, ACPS_DISCOVERY_DEFAULTS.limit);
});

test('开关双态: 未配置 baseUrl 时 external discover 抛错（mirror is_configured discovery_client.py:44-47,69-70）', async () => {
  const client = createAcpsDiscoveryClient({ scope: 'external' });
  assert.equal(client.isConfigured, false);
  await assert.rejects(client.discover('q'), /未配置 server_base_url/);
});

// ── 错误路径（连接失败 / 超时 / HTTP / 协议 / 无效响应）──
test('请求参数校验失败: explicit 空 query → 提前报错且不发起请求（对齐 discovery_client.py:80-83）', async () => {
  const http = makeHttpStub();
  const client = createAcpsDiscoveryClient({ baseUrl: 'http://ds:9020', scope: 'external', request: http.impl });
  await assert.rejects(
    client.discover('   '),
    (e) => e instanceof DiscoveryClientError && /请求参数校验失败/.test(e.message) && e.adpError && e.adpError.code === 40001,
  );
  assert.equal(http.calls.length, 0);
});

test('filtered 缺 filter → 校验失败', async () => {
  const client = createAcpsDiscoveryClient({ baseUrl: 'http://ds:9020', scope: 'external', request: makeHttpStub().impl });
  await assert.rejects(client.discover(null, { type: 'filtered' }), /请求参数校验失败/);
});

test('连接失败（fetch failed）→ DiscoveryClientError 调用失败', async () => {
  const http = makeHttpStub();
  http.stubError(new TypeError('fetch failed'));
  const client = createAcpsDiscoveryClient({ baseUrl: 'http://ds:9020', scope: 'external', request: http.impl });
  await assert.rejects(client.discover('q'), (e) => e instanceof DiscoveryClientError && /调用失败/.test(e.message));
});

test('请求超时 → DiscoveryClientError 超时', async () => {
  const http = makeHttpStub();
  http.stubError(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }));
  const client = createAcpsDiscoveryClient({ baseUrl: 'http://ds:9020', scope: 'external', request: http.impl });
  await assert.rejects(client.discover('q'), (e) => e instanceof DiscoveryClientError && /超时/.test(e.message));
});

test('HTTP 状态错误 → DiscoveryClientError（对齐 raise_for_status discovery_client.py:110-112）', async () => {
  const http = makeHttpStub();
  http.stub(okJson({ detail: 'bad' }, 500));
  const client = createAcpsDiscoveryClient({ baseUrl: 'http://ds:9020', scope: 'external', request: http.impl });
  await assert.rejects(client.discover('q'), (e) => e instanceof DiscoveryClientError && /返回错误 500/.test(e.message));
});

test('无效 JSON 响应 → DiscoveryClientError', async () => {
  const http = makeHttpStub();
  http.stub({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } });
  const client = createAcpsDiscoveryClient({ baseUrl: 'http://ds:9020', scope: 'external', request: http.impl });
  await assert.rejects(client.discover('q'), (e) => e instanceof DiscoveryClientError && /不是有效 JSON/.test(e.message));
});

test('协议级错误（HTTP 200 + error 字段）→ 抛 DiscoveryClientError + adpError（对齐 discovery_client.py:101-107）', async () => {
  const http = makeHttpStub();
  http.stub(okJson({ error: { code: 40004, message: 'FilterInvalid', data: null } }));
  const client = createAcpsDiscoveryClient({ baseUrl: 'http://ds:9020', scope: 'external', request: http.impl });
  await assert.rejects(
    client.discover('q'),
    (e) => e instanceof DiscoveryClientError
      && /协议错误: FilterInvalid/.test(e.message)
      && e.adpError && e.adpError.code === 40004,
  );
});

// ── DS3 mini-ADSP（可选）预留签名 ──
test('DS3 mini-ADSP: 预留签名调用抛 NotImplemented（P1 endpoint lane 就绪前不实现）', () => {
  assert.throws(() => createMiniAdsp(), /mini-ADSP 预留接口（未实现）/);
});
