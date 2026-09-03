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

// P4 ACS 描述生成器（exec-agent-desc lane）：字段集与参考实现 ACPs v2.1.0 acsSchema.json 逐字一致 +
// register 接线 + /agents 端点（闭环用例，只增不碰既有测试）。旧 14+8 兼容映射层已移除（P2-06）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { createApi } from '../lib/api.js';
import { DEFAULT_ASSEMBLY } from '../lib/assembly.js';
import {
  buildSkillDescriptor, buildAgentDescriptor, buildAgentDescriptors, buildAgentCatalog,
  ACS_REQUIRED_FIELDS, ACS_SKILL_REQUIRED_FIELDS,
  ACS_OPTIONAL_FIELDS, ACS_SKILL_OPTIONAL_FIELDS, ACS_PROTOCOL_VERSION,
} from '../lib/aip/agent-descriptor.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-acs-'));
const store = createStore(root);
const fixedEngine = { version: '9.9.9', generatedAt: '2026-08-22T00:00:00.000Z' };
const ROLE_COUNT = DEFAULT_ASSEMBLY.layers.plan.roles.length + DEFAULT_ASSEMBLY.layers.exec.roles.length + DEFAULT_ASSEMBLY.layers.audit.roles.length; // 7

// 注册上下文（enabled 开关两态；aipExtra 并入 aip 配置，assembly 可选注入 config.assembly）
function makeCtx(enabled, aipExtra = {}, assembly = null) {
  const registered = [];
  const ctx = { tools: { register: (t) => registered.push(t) }, logger: console };
  const config = { aip: { enabled, ...aipExtra }, ...(assembly ? { assembly } : {}) };
  const deps = { store, root, config };
  const made = createTools(ctx, deps);
  made.register();
  return { ctx, made, registered };
}

test('ACS：buildAgentDescriptor 必填 14 键逐字恒在（acsSchema.json required 原文），无旧 14+8 键', () => {
  const d = buildAgentDescriptor(DEFAULT_ASSEMBLY, 'exec', 'coder', fixedEngine);
  for (const k of ACS_REQUIRED_FIELDS) assert.ok(k in d, '缺 ACS 必填键 ' + k);
  assert.equal(Object.keys(d).length, ACS_REQUIRED_FIELDS.length, '无覆盖时仅 14 必填键（可选键不臆造）');
  // 旧 14+8 字段名不得出现在 ACS 输出（对外契约 = ACS 字段集）
  for (const legacy of ['agentId', 'accessAddress', 'accessMethod', 'interactionModes', 'communicationProtocols', 'securityLevel', 'trustLevel', 'region', 'serviceLevel', 'owner']) {
    assert.ok(!(legacy in d), 'ACS 输出不得含旧字段 ' + legacy);
  }
  // 类型抽查
  assert.equal(typeof d.aic, 'string');
  assert.equal(typeof d.active, 'boolean');
  assert.equal(typeof d.lastModifiedTime, 'string');
  assert.equal(d.protocolVersion, ACS_PROTOCOL_VERSION);
  assert.equal(d.name, 'coder');
  assert.equal(typeof d.description, 'string');
  assert.equal(d.version, '9.9.9');
  assert.equal(d.provider.countryCode, 'CN');
  assert.equal(typeof d.provider.organization, 'string');
  assert.deepEqual(d.securitySchemes, {});
  assert.deepEqual(d.endPoints, []);
  assert.deepEqual(d.capabilities, { streaming: false, notification: false, messageQueue: [] });
  assert.deepEqual(d.defaultInputModes, ['text/plain', 'application/json']);
  assert.deepEqual(d.defaultOutputModes, ['text/plain', 'application/json']);
  assert.ok(Array.isArray(d.skills) && d.skills.length > 0);
});

test('ACS：buildSkillDescriptor 必填 5 键逐字恒在，可选 3 键仅提供时输出', () => {
  const s = buildSkillDescriptor('dev-coder', {}, fixedEngine);
  for (const k of ACS_SKILL_REQUIRED_FIELDS) assert.ok(k in s, '缺技能必填键 ' + k);
  assert.equal(s.id, 'dsh.skill.dev-coder');
  assert.equal(s.name, 'dev-coder');
  assert.equal(s.version, '9.9.9');
  assert.deepEqual(s.tags, []);
  for (const k of ACS_SKILL_OPTIONAL_FIELDS) assert.ok(!(k in s), '未提供时不得输出可选键 ' + k);
  // 提供时透传
  const s2 = buildSkillDescriptor('x', { id: 'ns.x', description: 'desc', version: '1.2.3', tags: ['t1'], examples: ['e1'], inputModes: ['text/plain'], outputModes: ['text/markdown'] }, fixedEngine);
  assert.equal(s2.id, 'ns.x');
  assert.equal(s2.description, 'desc');
  assert.equal(s2.version, '1.2.3');
  assert.deepEqual(s2.tags, ['t1']);
  assert.deepEqual(s2.examples, ['e1']);
  assert.deepEqual(s2.inputModes, ['text/plain']);
  assert.deepEqual(s2.outputModes, ['text/markdown']);
});

test('ACS：buildAgentDescriptors 每 role 一份（7），aic 派生唯一', () => {
  const ds = buildAgentDescriptors(DEFAULT_ASSEMBLY, fixedEngine);
  assert.equal(ds.length, ROLE_COUNT);
  const aics = ds.map((d) => d.aic);
  assert.equal(new Set(aics).size, ROLE_COUNT, 'aic 全局唯一');
  const coder = ds.find((d) => d.name === 'coder');
  assert.equal(coder.aic, 'jiufeng.exec.coder');
  assert.deepEqual(coder.skills.map((s) => s.name), ['dev-coder', 'efficient-edit', 'codebase-design']);
});

test('ACS：engineInfo 覆盖可选/派生字段（endPoints/securitySchemes/capabilities/iconUrl/active/aic）', () => {
  const d = buildAgentDescriptor(DEFAULT_ASSEMBLY, 'exec', 'coder', {
    ...fixedEngine,
    aic: '1.2.156.3088.1.1.D55UOU.NEBZUA.1.0QLD',
    active: false,
    endPoints: [{ url: 'https://api.example.com/rpc', transport: 'JSONRPC', security: [{ mtls: [] }] }],
    securitySchemes: { mtls: { type: 'mutualTLS' } },
    capabilities: { streaming: true, notification: false, messageQueue: ['rabbitmq:>=4.2'] },
    iconUrl: 'https://example.com/icon.png',
    entityUserId: 'u-1',
    certificate: { altNames: { dns: ['localhost'] } },
  });
  assert.equal(d.aic, '1.2.156.3088.1.1.D55UOU.NEBZUA.1.0QLD');
  assert.equal(d.active, false);
  assert.equal(d.endPoints[0].transport, 'JSONRPC');
  assert.equal(d.securitySchemes.mtls.type, 'mutualTLS');
  assert.equal(d.capabilities.streaming, true);
  assert.equal(d.iconUrl, 'https://example.com/icon.png');
  assert.equal(d.entityUserId, 'u-1');
  assert.deepEqual(d.certificate.altNames.dns, ['localhost']);
  // 覆盖后仍只含合法键（可选键 + 必填键，无越界）
  const extra = new Set([...ACS_REQUIRED_FIELDS, ...ACS_OPTIONAL_FIELDS]);
  for (const k of Object.keys(d)) assert.ok(extra.has(k), '越界键 ' + k);
});

test('目录：buildAgentCatalog 只读快照（list 拷贝 / descriptors 冻结 / generatedAt 固定）', () => {
  const cat = buildAgentCatalog(DEFAULT_ASSEMBLY, fixedEngine);
  assert.equal(cat.generatedAt, '2026-08-22T00:00:00.000Z');
  assert.equal(cat.list().length, ROLE_COUNT);
  cat.list().push('junk');
  assert.equal(cat.list().length, ROLE_COUNT, 'list() 返回拷贝');
  assert.ok(Object.isFrozen(cat.descriptors));
});

// —— 接线层（register.js）——
test('接线：aip.enabled=true 时 agentCatalog 非空（7 份 ACS 描述）；catalog 为缺省 19 工具（P1-01 默认开）', () => {
  const { made } = makeCtx(true);
  assert.ok(made.agentCatalog, 'enabled=true 时 register() 后 agentCatalog 非空');
  assert.equal(made.agentCatalog.list().length, ROLE_COUNT);
  assert.ok(made.catalog, '既有 catalog 不受影响');
  assert.equal(made.catalog.list().length, 19); // P1-01 缺省默认开：14 + lane_heartbeat + worktree 四件（logs 缺省关）
  for (const d of made.agentCatalog.list()) {
    for (const k of ACS_REQUIRED_FIELDS) assert.ok(k in d, '接线输出缺 ACS 键 ' + k);
  }
});

test('接线：装配可注入（config.assembly 覆盖默认装配；aip.team 选装配团队）', () => {
  const custom = { team: 'custom', layers: { exec: { roles: ['coder'], skills: { coder: ['dev-coder'] } } } };
  const { made } = makeCtx(true, { team: 'custom' }, custom);
  const list = made.agentCatalog.list();
  assert.equal(list.length, 1, '自定义装配仅 1 角色');
  assert.equal(list[0].aic, 'custom.exec.coder');
  assert.equal(list[0].name, 'coder');
  // 未注入 assembly 时回退 DEFAULT_ASSEMBLY（team 键仅影响 resolveAssembly 分支）
  const { made: made2 } = makeCtx(true);
  assert.equal(made2.agentCatalog.list().length, ROLE_COUNT);
});

test('接线：aip.enabled=false 时 agentCatalog 为 null、零生成', () => {
  const { made } = makeCtx(false);
  assert.equal(made.agentCatalog, null);
  const ctx2 = { tools: { register: () => {} }, logger: console };
  const made2 = createTools(ctx2, { store, root, config: { aip: { enabled: false } } });
  made2.register();
  assert.equal(made2.agentCatalog, null);
});

// —— 端点层（方案 A：GET /api/dsh-punky-swarm/agents）——
function apiWithAgentCatalog(agentCatalog) {
  const routes = [];
  const ctx = { webServer: { register: (r) => { routes.push(r); return () => {}; } } };
  const api = createApi(ctx, { store, root, agentCatalog });
  return { routes, api };
}

function invoke(route, url) {
  let status = 0, body = null;
  const res = { writeHead(s) { status = s; }, end(b) { body = JSON.parse(b); } };
  route.handler({ url }, res);
  return { status, body };
}

test('端点：enabled=true 时 /agents 已注册并返回 {count:7, agents(ACS 字段), generatedAt} HTTP 200', () => {
  const { made } = makeCtx(true);
  const { routes } = apiWithAgentCatalog(made.agentCatalog);
  const route = routes.find((r) => r.path === '/api/dsh-punky-swarm/agents');
  assert.ok(route, 'enabled=true 时 /agents 路由已注册');
  const r = invoke(route, '/api/dsh-punky-swarm/agents');
  assert.equal(r.status, 200);
  assert.equal(r.body.count, ROLE_COUNT);
  assert.equal(r.body.agents.length, ROLE_COUNT);
  assert.ok(typeof r.body.generatedAt === 'string');
  for (const a of r.body.agents) {
    for (const k of ACS_REQUIRED_FIELDS) assert.ok(k in a, '端点输出缺 ACS 键 ' + k);
  }
});

test('端点：enabled=false（agentCatalog null/缺省）时不注册 /agents（既有 7 路由契约保持）', () => {
  const { routes } = apiWithAgentCatalog(null);
  assert.ok(!routes.some((r) => r.path === '/api/dsh-punky-swarm/agents'), 'agentCatalog null 时不得注册 /agents');
  assert.equal(routes.length, 7, '既有 7 路由契约保持（R3 exec-panel-b：+1 /stream）');
  const { routes: r2 } = apiWithAgentCatalog(undefined);
  assert.equal(r2.length, 7);
});
