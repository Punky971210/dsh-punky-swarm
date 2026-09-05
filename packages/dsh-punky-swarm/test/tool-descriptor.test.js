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

// P0-1 工具国标 6 属性描述生成器 + 工具列表同步端点（闭环用例，只增不碰既有测试）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { createApi } from '../lib/api.js';
import { buildToolDescriptor, buildToolCatalog, toToolId, engineVersion } from '../lib/aip/tool-descriptor.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-aip-'));
const store = createStore(root);
const PKG_VERSION = engineVersion(); // 0.2.1（package.json）
// P1-01 缺省默认开：14（core 11 + mailbox 3）+ lane_heartbeat + lane_longrun + worktree 四件 = 20；
// logs 缺省关（log_export 不在缺省清单，patch 全开 +1 = 21）。断言按新契约更新（旧「14 工具」为旧行为）。
const TOOL_NAMES = ['wave_plan', 'batch_phase', 'batch_status', 'assign_check', 'asset_claim', 'gate_status', 'artifact_types', 'lane_claim', 'lane_release', 'member_status', 'member_settle', 'mailbox_send', 'mailbox_read', 'mailbox_ack', 'lane_heartbeat', 'lane_longrun', 'lane_worktree_create', 'lane_worktree_merge', 'lane_checkpoint', 'lane_checkpoint_status'];
const DEFAULT_TOOL_COUNT = TOOL_NAMES.length; // 20

// 注册上下文（enabled 开关两态）
function makeCtx(enabled) {
  const registered = [];
  const ctx = { tools: { register: (t) => registered.push(t) }, logger: console };
  const deps = { store, root, config: enabled ? { aip: { enabled: true } } : {} };
  const made = createTools(ctx, deps);
  made.register();
  return { ctx, made, registered };
}

test('生成：缺省 20 工具逐一产出 6 属性 JSON（字段齐全/类型正确/toolId 唯一）', () => {
  const { made } = makeCtx(true);
  const catalog = made.catalog;
  assert.ok(catalog, 'enabled=true 时 register() 后 catalog 非空');
  assert.equal(catalog.list().length, DEFAULT_TOOL_COUNT);
  assert.equal(catalog.descriptors.length, DEFAULT_TOOL_COUNT);
  const toolIds = catalog.list().map((d) => d.toolId);
  assert.equal(new Set(toolIds).size, DEFAULT_TOOL_COUNT, 'toolId 全局唯一');
  for (const d of catalog.list()) {
    assert.ok(d && typeof d === 'object');
    for (const k of ['toolId', 'name', 'description', 'version', 'inputParam', 'outputParam']) {
      assert.ok(k in d, '缺 6 属性字段 ' + k + ' @' + d.toolId);
    }
    assert.equal(typeof d.toolId, 'string');
    assert.equal(typeof d.name, 'string');
    assert.equal(typeof d.description, 'string');
    assert.equal(typeof d.version, 'string');
    assert.equal(typeof d.inputParam, 'object');
    assert.equal(typeof d.outputParam, 'object');
    assert.equal(d.inputParam.type, 'object');
    assert.ok(Array.isArray(d.inputParam.required));
  }
});

test('生成：toolId 命名规则 dsh.punky-swarm.<name>（双向可逆）', () => {
  const { made } = makeCtx(true);
  for (const d of made.catalog.list()) {
    assert.equal(d.toolId, toToolId(d.name));
    assert.ok(d.toolId.startsWith('dsh.punky-swarm.'));
    assert.equal(d.toolId.slice('dsh.punky-swarm.'.length), d.name);
    assert.ok(TOOL_NAMES.includes(d.name), '未知工具 ' + d.name);
  }
  assert.deepEqual(made.catalog.list().map((d) => d.name).sort(), [...TOOL_NAMES].sort());
});

test('生成：4 项透传 2 项派生（inputParam 与 defineTool 归一化结果一致）', () => {
  const { made } = makeCtx(true);
  const byName = Object.fromEntries(made.catalog.list().map((d) => [d.name, d]));
  // 派生 1：version 缺省取引擎版本
  for (const d of made.catalog.list()) assert.equal(d.version, PKG_VERSION);
  // 派生 2：toolId（上一用例已验）
  // 透传：name/description 与工具定义一致；inputParam 与 defineTool 归一化后的 parameters 一致
  const source = makeCtx(false); // enabled=false 时 tools 数组不受影响，可作对照源
  const srcByName = Object.fromEntries(source.made.tools.map((t) => [t.name, t]));
  for (const d of made.catalog.list()) {
    const t = srcByName[d.name];
    assert.equal(d.name, t.name);
    assert.equal(d.description, t.description);
    // inputParam：国标要求 required 恒存在——defineTool 已归一化则全等透传；
    // 全可选参数时 defineTool 无 required 键，生成器补空数组（仅此一处差异）
    if ('required' in t.parameters) {
      assert.deepEqual(d.inputParam, t.parameters, 'inputParam 不一致 @' + d.name);
    } else {
      assert.deepEqual(d.inputParam, { ...structuredClone(t.parameters), required: [] }, 'inputParam 不一致（缺 required 补空数组）@' + d.name);
    }
    // 透传约束抽查：enum 保留（mailbox 三件套 box enum）
    if (t.parameters?.properties?.box) {
      assert.deepEqual(d.inputParam.properties.box.enum, ['inbox', 'outbox', 'broadcast']);
    }
  }
  // 抽样：wave_plan required=['batchId','tasks']；mailbox_read required=['batchId','box']（源码实标 req，决策包映射表一致）
  assert.deepEqual(byName.wave_plan.inputParam.required, ['batchId', 'tasks']);
  assert.deepEqual(byName.mailbox_read.inputParam.required, ['batchId', 'box']);
  assert.equal(byName.wave_plan.inputParam.type, 'object');
  // outputParam 与 output.schema 同构（深比较，键序无关）
  assert.deepEqual(byName.wave_plan.outputParam, srcByName.wave_plan.output.schema);
});

test('生成：toolVersion 可覆盖缺省版本', () => {
  const ctx = { tools: { register: () => {} }, logger: console };
  const made = createTools(ctx, { store, root, config: { aip: { enabled: true, toolVersion: '9.9.9' } } });
  made.register();
  for (const d of made.catalog.list()) assert.equal(d.version, '9.9.9');
});

test('开关口径：缺省配置默认开启（catalog 非空）；显式 aip.enabled=false 关闭（catalog null）', () => {
  // 缺省配置（config 无 aip 键）→ readCapability 默认合并 {enabled:true} → 实际默认开启
  const { made } = makeCtx(false);
  assert.ok(made.catalog, '缺省配置必须实际默认开启（catalog 非空）');
  assert.equal(made.catalog.list().length, DEFAULT_TOOL_COUNT);
  // 显式 aip.enabled=false → 关闭，catalog 为 null
  const ctx2 = { tools: { register: () => {} }, logger: console };
  const made2 = createTools(ctx2, { store, root, config: { aip: { enabled: false } } });
  made2.register();
  assert.equal(made2.catalog, null);
});

test('行为不变抽查：register() 注册的正是 tools 数组原对象（生成器不替换/不包装）', () => {
  const off = makeCtx(false);
  const on = makeCtx(true);
  // 同一实例内：register 注册的每个工具就是 tools 数组里的对象（enabled 两态一致）
  assert.equal(off.registered.length, DEFAULT_TOOL_COUNT);
  assert.equal(on.registered.length, DEFAULT_TOOL_COUNT);
  assert.equal(off.registered.length, off.made.tools.length);
  assert.equal(on.registered.length, on.made.tools.length);
  for (let i = 0; i < DEFAULT_TOOL_COUNT; i++) {
    assert.equal(off.registered[i], off.made.tools[i], '工具对象引用必须一致（未被替换/包装）@' + off.made.tools[i].name);
    assert.equal(on.registered[i], on.made.tools[i], '工具对象引用必须一致（未被替换/包装）@' + on.made.tools[i].name);
  }
  // 两态工具名集合不变
  assert.deepEqual(on.registered.map((t) => t.name).sort(), off.registered.map((t) => t.name).sort());
});

// —— 端点层（方案 A：GET /api/dsh-punky-swarm/tools）——
function apiWithCatalog(catalog) {
  const routes = [];
  const ctx = { webServer: { register: (r) => { routes.push(r); return () => {}; } } };
  const api = createApi(ctx, { store, root, catalog });
  return { routes, api };
}

function invoke(route, url) {
  let status = 0, body = null;
  const res = { writeHead(s) { status = s; }, end(b) { body = JSON.parse(b); } };
  route.handler({ url }, res);
  return { status, body };
}

test('端点：enabled=true 时 /tools 已注册并返回 {count:19, tools} HTTP 200', () => {
  const { made } = makeCtx(true);
  const { routes } = apiWithCatalog(made.catalog);
  const route = routes.find((r) => r.path === '/api/dsh-punky-swarm/tools');
  assert.ok(route, 'enabled=true 时 /tools 路由已注册');
  const r = invoke(route, '/api/dsh-punky-swarm/tools');
  assert.equal(r.status, 200);
  assert.equal(r.body.count, DEFAULT_TOOL_COUNT);
  assert.equal(r.body.tools.length, DEFAULT_TOOL_COUNT);
  assert.ok(typeof r.body.generatedAt === 'string');
  assert.ok(r.body.tools.every((d) => d.toolId && d.inputParam && d.outputParam));
});

test('端点：?name= 过滤返回单工具；未知 name 返回空', () => {
  const { made } = makeCtx(true);
  const { routes } = apiWithCatalog(made.catalog);
  const route = routes.find((r) => r.path === '/api/dsh-punky-swarm/tools');
  const r = invoke(route, '/api/dsh-punky-swarm/tools?name=wave_plan');
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 1);
  assert.equal(r.body.tools[0].toolId, 'dsh.punky-swarm.wave_plan');
  const r2 = invoke(route, '/api/dsh-punky-swarm/tools?name=nope');
  assert.equal(r2.body.count, 0);
  assert.deepEqual(r2.body.tools, []);
});

test('端点：enabled=false（catalog null）时不注册 /tools（路由数不变）', () => {
  const { routes } = apiWithCatalog(null);
  assert.ok(!routes.some((r) => r.path === '/api/dsh-punky-swarm/tools'), 'catalog null 时不得注册 /tools');
  assert.equal(routes.length, 7, '既有 7 路由契约保持（R3 exec-panel-b：+1 = /stream SSE 路由）');
  // 无 catalog 参数（createApi 缺省调用形态）同样不注册
  const { routes: r2 } = apiWithCatalog(undefined);
  assert.equal(r2.length, 7);
});

test('目录快照：buildToolCatalog 只读（list 拷贝 / descriptors 冻结 / get 精确命中）', () => {
  const { made } = makeCtx(true);
  const cat = made.catalog;
  const l1 = cat.list();
  l1.push('junk');
  assert.equal(cat.list().length, DEFAULT_TOOL_COUNT, 'list() 返回拷贝，外部修改不影响快照');
  assert.equal(cat.get('wave_plan').toolId, 'dsh.punky-swarm.wave_plan');
  assert.equal(cat.get('nope'), null);
  // 单工具生成器独立可用
  const d = buildToolDescriptor({ name: 'x', description: 'd', parameters: { a: { type: 'string', required: true } }, output: { schema: { type: 'object' } } }, { version: '1.0.0' });
  assert.deepEqual(d.inputParam, { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] });
  assert.equal(d.version, '1.0.0');
  assert.equal(d.toolId, 'dsh.punky-swarm.x');
});
