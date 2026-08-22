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

// P5 发现服务（ADP 语义）单测：schema 校验 / filter 引擎 / discover 查询 / active 语义 / well-known / API 端点
// 基准：ACPs-community v2.1.0（acps_sdk/adp + discovery-server + 06-ACPs-spec-ADP）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApi } from '../lib/api.js';
import { createStore } from '../lib/state/store.js';
import { createDiscoveryService } from '../lib/discovery/service.js';
import {
  QUERY_TYPES, FILTER_OPERATORS, ADP_ERROR,
  validateDiscoveryRequest, validateFilterShape, normalizeLimit, successResponse, failureResponse,
} from '../lib/discovery/schema.js';
import { resolveField, matchOp, matchCondition, evaluateFilter } from '../lib/discovery/filter.js';
import { buildToolCatalog } from '../lib/aip/tool-descriptor.js';

// ── fixture：工具目录（3 工具）+ 智能体目录（2 描述）──
const TOOLS = [
  { name: 'wave_plan', description: '建批：任务按 DAG 分层为 waves', parameters: { batchId: { type: 'string', required: true } }, output: { schema: { type: 'object' } } },
  { name: 'batch_status', description: '查询批次状态（唯一事实源）', parameters: {}, output: { schema: { type: 'object' } } },
  { name: 'member_settle', description: '成员结算：按状态机迁移', parameters: {}, output: { schema: { type: 'object' } } },
];
const AGENT_DESCRIPTORS = [
  {
    agentId: 'jiufeng.exec.coder', name: 'coder', description: 'spec 驱动编码+自检',
    version: '1.0.0', skills: [{ skillId: 'dsh.skill.dev-coder', name: 'dev-coder', description: '编码', version: '1.0.0', triggerConditions: [] }],
  },
  {
    agentId: 'jiufeng.audit.reviewer', name: 'reviewer', description: '评审验收',
    version: '1.0.0', skills: [{ skillId: 'dsh.skill.code-review', name: 'code-review-guideline', description: '代码审查', version: '1.0.0', triggerConditions: [] }],
  },
];

function makeService(config = {}, extra = {}) {
  const catalog = buildToolCatalog(TOOLS, { version: '9.9.9' });
  return createDiscoveryService({ catalog, agentDescriptors: extra.agentDescriptors ?? AGENT_DESCRIPTORS, config });
}

// ── schema 校验 ──
test('QUERY_TYPES / FILTER_OPERATORS 与参考实现对齐（4 类型 / 34 运算符）', () => {
  assert.deepEqual(QUERY_TYPES, ['explicit', 'exploratory', 'trending', 'filtered']);
  assert.equal(FILTER_OPERATORS.length, 34);
  for (const op of ['eq', 'ne', 'exists', 'contains', 'in', 'anyOf', 'hasKey', 'size', 'startsWithCs']) {
    assert.ok(FILTER_OPERATORS.includes(op), '缺运算符 ' + op);
  }
});

test('validateDiscoveryRequest：explicit 缺 query → MissingQuery(40001)', () => {
  const r = validateDiscoveryRequest({ type: 'explicit' });
  assert.equal(r.error.code, ADP_ERROR.MISSING_QUERY.code);
  assert.equal(r.error.message, 'MissingQuery');
  assert.equal(validateDiscoveryRequest({ type: 'explicit', query: '  ' }).error.code, 40001);
  assert.equal(validateDiscoveryRequest({ type: 'explicit', query: '北京美食' }), null);
});

test('validateDiscoveryRequest：非法 type / filtered 缺 filter / 转发限制', () => {
  assert.equal(validateDiscoveryRequest({ type: 'bogus', query: 'x' }).error.message, 'BadRequest');
  assert.equal(validateDiscoveryRequest({ type: 'filtered' }).error.message, 'BadRequest');
  assert.equal(validateDiscoveryRequest({ type: 'filtered', filter: { conditions: [] } }), null);
  assert.equal(validateDiscoveryRequest({ forwardDepthLimit: 9, query: 'x' }).error.code, 40002);
  assert.equal(validateDiscoveryRequest({ forwardFanoutLimit: 0, query: 'x' }).error.code, 40005);
  assert.equal(validateDiscoveryRequest({ forwardChain: ['ok', ''], query: 'x' }).error.code, 40003);
  assert.equal(validateDiscoveryRequest({ query: 'x', filter: { conditions: [{ field: 'active', op: 'bogus', value: true }] } }).error.code, 40004);
});

test('validateFilterShape：嵌套超 3 层 / 空 field / 非法 logic', () => {
  assert.ok(validateFilterShape({ groups: [{ groups: [{ groups: [{ groups: [{}] }] }] }] }));
  assert.equal(validateFilterShape({ conditions: [{ field: '', op: 'eq' }] }), 'condition.field 必须是非空字符串');
  assert.equal(validateFilterShape({ logic: 'xor' }), "logic 必须是 'and' | 'or' | 'not'");
  assert.equal(validateFilterShape({ conditions: [{ field: 'a', op: 'eq', value: 1 }] }), null);
});

test('normalizeLimit：缺省 5 / 钳制 [1,50]', () => {
  assert.equal(normalizeLimit(), 5);
  assert.equal(normalizeLimit(3), 3);
  assert.equal(normalizeLimit(0), 1);
  assert.equal(normalizeLimit(999), 50);
  assert.equal(normalizeLimit('7'), 7);
});

// ── filter 引擎 ──
const REC = {
  aic: 'jf.1', active: true, name: 'coder', description: 'spec 驱动编码',
  version: '2.0.0', skills: [{ id: 's1', name: 'dev-coder', tags: ['编码', 'code'] }],
  capabilities: { streaming: true, notification: false },
};

test('resolveField：点号路径 / 数组字段逐元素', () => {
  assert.deepEqual(resolveField(REC, 'name'), ['coder']);
  assert.deepEqual(resolveField(REC, 'skills.name'), ['dev-coder']);
  assert.deepEqual(resolveField(REC, 'skills.tags'), ['编码', 'code']);
  assert.deepEqual(resolveField(REC, 'nope'), []);
});

test('matchOp：eq/ne/in/contains 大小写不敏感 + Cs 变体敏感', () => {
  assert.equal(matchOp('eq', ['Coder'], 'coder'), true);
  assert.equal(matchOp('eqCs', ['Coder'], 'coder'), false);
  assert.equal(matchOp('in', ['a', 'B'], ['b']), true);
  assert.equal(matchOp('inCs', ['a', 'B'], ['b']), false);
  assert.equal(matchOp('contains', ['abc'], 'B'), true);
  assert.equal(matchOp('notContains', ['abc'], 'z'), true);
  assert.equal(matchOp('startsWith', ['abc'], 'a'), true);
  assert.equal(matchOp('endsWith', ['abc'], 'c'), true);
});

test('matchOp：gt/gte/between/anyOf/allOf/noneOf/size/hasKey', () => {
  assert.equal(matchOp('gte', ['2.0.0'], '2.0.0'), true);
  assert.equal(matchOp('gt', ['2.0.0'], '1.9.0'), true);
  assert.equal(matchOp('between', ['2025-06-01'], ['2025-01-01', '2025-12-31']), true);
  assert.equal(matchOp('anyOf', [['a', 'b']], ['b', 'z']), true);
  assert.equal(matchOp('allOf', [['a', 'b']], ['a', 'b']), true);
  assert.equal(matchOp('noneOf', [['a', 'b']], ['z']), true);
  assert.equal(matchOp('size', [['a', 'b']], 2), true);
  assert.equal(matchOp('hasKey', [{ streaming: true }], 'streaming'), true);
  assert.equal(matchOp('hasAllKeys', [{ streaming: true, notification: false }], ['streaming', 'notification']), true);
  assert.equal(matchOp('exists', [], true), false);
  assert.equal(matchOp('exists', ['x'], true), true);
});

test('evaluateFilter：conditions + logic and/or/not + groups', () => {
  assert.equal(evaluateFilter(REC, { conditions: [{ field: 'active', op: 'eq', value: true }] }), true);
  assert.equal(evaluateFilter(REC, { conditions: [{ field: 'name', op: 'eq', value: 'nope' }] }), false);
  assert.equal(evaluateFilter(REC, { logic: 'or', conditions: [{ field: 'name', op: 'eq', value: 'nope' }, { field: 'active', op: 'eq', value: true }] }), true);
  assert.equal(evaluateFilter(REC, { logic: 'not', conditions: [{ field: 'name', op: 'eq', value: 'nope' }] }), true);
  assert.equal(evaluateFilter(REC, {
    logic: 'or',
    groups: [
      { conditions: [{ field: 'capabilities.streaming', op: 'eq', value: true }] },
      { conditions: [{ field: 'name', op: 'eq', value: 'nope' }] },
    ],
  }), true);
  assert.equal(evaluateFilter(REC, { conditions: [{ field: 'skills.tags', op: 'anyOf', value: ['编码'] }] }), true);
  assert.equal(evaluateFilter(REC, null), true);
});

// ── discover 服务 ──
test('discover explicit：按名称/能力查询命中 + ranking + acsMap', () => {
  const svc = makeService();
  const r = svc.discover({ type: 'explicit', query: 'wave_plan', limit: 5 });
  assert.ok(r.result, '成功响应应含 result');
  assert.equal(r.error, undefined);
  assert.ok(r.result.agents.length >= 1);
  const group = r.result.agents[0];
  assert.equal(typeof group.group, 'string');
  assert.ok(group.agentSkills.length >= 1);
  const first = group.agentSkills[0];
  assert.equal(first.aic, 'dsh.punky-swarm.wave_plan');
  assert.equal(first.skillId, 'dsh.punky-swarm.wave_plan');
  assert.equal(first.ranking, 1);
  assert.ok(first.memo.includes('keyword score'));
  // acsMap 含命中 AIC 的完整描述
  assert.ok(r.result.acsMap['dsh.punky-swarm.wave_plan']);
  assert.equal(r.result.acsMap['dsh.punky-swarm.wave_plan'].toolId, 'dsh.punky-swarm.wave_plan');
  // routes 结构（参考实现 _build_response 形态）
  assert.ok(Array.isArray(r.result.routes));
  const route = r.result.routes[0];
  assert.deepEqual(route.forwardChain, ['AIC-DS-A']);
  assert.equal(route.status, 'ok');
  assert.ok(Array.isArray(route.agentGroups) && route.agentGroups[0].agentSkills.length >= 1);
});

test('discover explicit：按智能体查询（agent-descriptor 目录）', () => {
  const svc = makeService();
  const r = svc.discover({ query: 'coder' });
  assert.ok(r.result.acsMap['jiufeng.exec.coder'], 'agent 描述应入 acsMap');
  const hits = r.result.agents[0].agentSkills;
  assert.ok(hits.some((h) => h.aic === 'jiufeng.exec.coder'));
});

test('discover explicit：无命中 → 空 agents + 空 acsMap（不臆造）', () => {
  const svc = makeService();
  const r = svc.discover({ query: 'zzz-not-exist' });
  assert.ok(r.result);
  assert.deepEqual(r.result.agents[0].agentSkills, []);
  assert.deepEqual(r.result.acsMap, {});
});

test('discover filtered：只按 filter 过滤，query 被忽略', () => {
  const svc = makeService();
  const r = svc.discover({ type: 'filtered', query: 'ignored', filter: { conditions: [{ field: 'name', op: 'eq', value: 'coder' }] } });
  const hits = r.result.agents[0].agentSkills;
  assert.ok(hits.length >= 1);
  assert.ok(hits.every((h) => h.aic === 'jiufeng.exec.coder'));
});

test('discover trending：随机打散返回 ≤ limit', () => {
  const svc = makeService();
  const r = svc.discover({ type: 'trending', limit: 2 });
  const total = r.result.agents[0].agentSkills.length;
  assert.ok(total >= 1 && total <= 2, 'trending 应 ≤ limit，实际 ' + total);
  assert.ok(r.result.agents[0].agentSkills.every((h) => h.memo === 'trending'));
});

test('discover exploratory：本地模式（无 LLM 拆解，诚实标注）', () => {
  const svc = makeService();
  const r = svc.discover({ type: 'exploratory', query: 'c' });
  const memos = r.result.agents[0].agentSkills.map((h) => h.memo);
  assert.ok(memos.every((m) => m === 'exploratory-local (no LLM decomposition)'));
});

test('discover 校验错误 → error 响应（result 与 error 互斥）', () => {
  const svc = makeService();
  const r = svc.discover({ type: 'explicit' });
  assert.equal(r.error.code, 40001);
  assert.equal(r.result, undefined);
});

// ── active 语义 ──
test('active 语义：config.nodes active=false 节点不出现在查询结果', () => {
  const svc = makeService({ nodes: { 'dsh.punky-swarm.wave_plan': { active: false } } });
  const r = svc.discover({ query: 'wave_plan' });
  assert.deepEqual(r.result.agents[0].agentSkills, [], 'active=false 工具应隐藏');
  assert.deepEqual(r.result.acsMap, {}, '隐藏节点不入 acsMap');
  // 其余节点仍可查
  const r2 = svc.discover({ query: 'batch_status' });
  assert.ok(r2.result.agents[0].agentSkills.length >= 1);
});

test('active 语义：缺省 active=true 全量可见；按 name 覆写同样生效', () => {
  const svc = makeService();
  assert.equal(svc.stats().active, svc.stats().entries);
  const svc2 = makeService({ nodes: { coder: { active: false } } });
  const r = svc2.discover({ query: 'coder' });
  assert.deepEqual(r.result.agents[0].agentSkills, [], '按 name 覆写 active=false 应隐藏');
});

test('active 语义：描述自带 active=false 同样隐藏（ACS active 语义）', () => {
  const svc = makeService({}, { agentDescriptors: [{ ...AGENT_DESCRIPTORS[0], active: false }] });
  const r = svc.discover({ query: 'coder' });
  assert.deepEqual(r.result.agents[0].agentSkills, []);
});

test('discovery.enabled=false 语义：服务仍可实例化但装配层不挂载（stats.enabled）', () => {
  const svc = makeService({ enabled: false });
  assert.equal(svc.stats().enabled, false);
  // discover 行为不因 enabled=false 改变（开关由装配层 index.js 门控）
  const r = svc.discover({ query: 'coder' });
  assert.ok(r.result);
});

// ── well-known ──
test('well-known：声明发现服务地址/协议版本/能力概要', () => {
  const svc = makeService();
  const w = svc.wellKnown();
  assert.equal(w.protocol, 'ACPs');
  assert.equal(w.protocolVersion, '02.01');
  assert.equal(w.service, 'dsh-punky-swarm');
  assert.equal(w.discovery.endpoint, '/api/dsh-punky-swarm/discover');
  assert.deepEqual(w.capabilities.queryTypes, QUERY_TYPES);
  assert.equal(w.capabilities.filterOperators.length, 34);
  assert.ok(typeof w.updatedAt === 'string');
});

// ── API 端点 ──
function apiWithDiscovery(discovery) {
  const routes = [];
  const ctx = { webServer: { register: (r) => { routes.push(r); return () => {}; } } };
  const api = createApi(ctx, { store: createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'punky-disc-'))), root: fs.mkdtempSync(path.join(os.tmpdir(), 'punky-disc-root-')), discovery });
  return { routes, api };
}

function invoke(route, url, body) {
  let status = 0, body2 = null;
  const res = { writeHead(s) { status = s; }, end(b) { body2 = JSON.parse(b); } };
  const req = body !== undefined ? { url, body } : { url };
  const ret = route.handler(req, res);
  if (ret && typeof ret.then === 'function') return ret.then(() => ({ status, body: body2 }));
  return { status, body: body2 };
}

test('端点：discovery 注入时注册 /discover + /.well-known/aip（既有 6 路由不破坏）', () => {
  const svc = makeService();
  const { routes } = apiWithDiscovery(svc);
  assert.ok(routes.some((r) => r.path === '/api/dsh-punky-swarm/discover'), '/discover 已注册');
  assert.ok(routes.some((r) => r.path === '/.well-known/aip'), '/.well-known/aip 已注册');
  assert.equal(routes.length, 8, '6 既有 + 2 新增');
  // 未注入 discovery → 不注册（既有契约保持）
  const { routes: r2 } = apiWithDiscovery(null);
  assert.equal(r2.length, 6);
});

test('端点：POST /discover 成功返回 DiscoveryResponse（200）', async () => {
  const svc = makeService();
  const { routes } = apiWithDiscovery(svc);
  const route = routes.find((r) => r.path === '/api/dsh-punky-swarm/discover');
  const out = await invoke(route, '/api/dsh-punky-swarm/discover', { query: 'wave_plan' });
  assert.equal(out.status, 200);
  assert.ok(out.body.result);
  assert.equal(out.body.result.agents[0].agentSkills[0].aic, 'dsh.punky-swarm.wave_plan');
});

test('端点：POST /discover 校验错误 → 400 + error 体', async () => {
  const svc = makeService();
  const { routes } = apiWithDiscovery(svc);
  const route = routes.find((r) => r.path === '/api/dsh-punky-swarm/discover');
  const out = await invoke(route, '/api/dsh-punky-swarm/discover', { type: 'explicit' });
  assert.equal(out.status, 400);
  assert.equal(out.body.error.code, 40001);
  assert.equal(out.body.result, undefined);
});

test('端点：GET /.well-known/aip 返回预置信息（200）', async () => {
  const svc = makeService();
  const { routes } = apiWithDiscovery(svc);
  const route = routes.find((r) => r.path === '/.well-known/aip');
  const out = await invoke(route, '/.well-known/aip');
  assert.equal(out.status, 200);
  assert.equal(out.body.discovery.endpoint, '/api/dsh-punky-swarm/discover');
});

// ── 响应构造助手 ──
test('successResponse / failureResponse：result 与 error 互斥形态', () => {
  assert.deepEqual(successResponse({ a: 1 }), { result: { a: 1 } });
  assert.deepEqual(failureResponse(50001, 'InternalError', 'x'), { error: { code: 50001, message: 'InternalError', data: 'x' } });
});