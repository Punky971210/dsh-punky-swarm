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

// ACS 描述生成器：字段集与参考实现 ACPs v2.1.0 acsSchema.json 逐字一致 +
// register 接线 + /agents 端点（闭环用例，只增不碰既有测试）。旧 14+8 兼容映射层已移除。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { createApi } from '../lib/api.js';
import { DEFAULT_ASSEMBLY } from '../lib/assembly.js';
import { buildSkillDescriptor, buildAgentDescriptor, buildAgentDescriptors, buildAgentCatalog, ACS_OPTIONAL_FIELDS, ACS_SKILL_OPTIONAL_FIELDS, ACS_PROTOCOL_VERSION } from '../lib/aip/agent-descriptor.js';

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

;

;

test('ACS：buildAgentDescriptors 每 role 一份（7），aic 派生唯一', () => {
  const ds = buildAgentDescriptors(DEFAULT_ASSEMBLY, fixedEngine);
  assert.equal(ds.length, ROLE_COUNT);
  const aics = ds.map((d) => d.aic);
  assert.equal(new Set(aics).size, ROLE_COUNT, 'aic 全局唯一');
  // aic 派生占位 = `<team>.<layer>.<role>`；punky-preset 团队装配退役后 DEFAULT_ASSEMBLY.team = software-team
  assert.deepEqual(aics, [
    'software-team.plan.coordinator', 'software-team.plan.designer',
    'software-team.exec.coder', 'software-team.exec.tester', 'software-team.exec.reviewer',
    'software-team.audit.supervisor', 'software-team.audit.doc-manager',
  ], 'aic 前缀取装配 team（software-team），逐 role 一份且层归属正确');
  assert.equal(aics.some((a) => a.startsWith('punky-preset.')), false, 'punky-preset 团队装配已退役：不得再产出 punky-preset 前缀 aic');
  const coder = ds.find((d) => d.name === 'coder');
  assert.equal(coder.aic, 'software-team.exec.coder');
  assert.deepEqual(coder.skills.map((s) => s.name), ['test-driven-development', 'codebase-design', 'receiving-code-review', 'requesting-code-review'], 'coder 技能集 = software-team 装配声明（逐字）');
});

;

test('目录：buildAgentCatalog 只读快照（list 拷贝 / descriptors 冻结 / generatedAt 固定）', () => {
  const cat = buildAgentCatalog(DEFAULT_ASSEMBLY, fixedEngine);
  assert.equal(cat.generatedAt, '2026-08-22T00:00:00.000Z');
  assert.equal(cat.list().length, ROLE_COUNT);
  cat.list().push('junk');
  assert.equal(cat.list().length, ROLE_COUNT, 'list() 返回拷贝');
  assert.ok(Object.isFrozen(cat.descriptors));
});

// —— 接线层（register.js）——
;

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

// —— 端点层（只读 GET /api/dsh-punky-swarm/agents）——
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

;

test('端点：enabled=false（agentCatalog null/缺省）时不注册 /agents（既有 7 路由契约保持）', () => {
  const { routes } = apiWithAgentCatalog(null);
  assert.ok(!routes.some((r) => r.path === '/api/dsh-punky-swarm/agents'), 'agentCatalog null 时不得注册 /agents');
  assert.equal(routes.length, 7, '既有 7 路由契约保持（R3 exec-panel-b：+1 /stream）');
  const { routes: r2 } = apiWithAgentCatalog(undefined);
  assert.equal(r2.length, 7);
});
