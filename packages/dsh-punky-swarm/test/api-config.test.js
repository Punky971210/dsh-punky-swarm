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

// webui-config-build-20260903 / 设计 §3 测试表：api-config——/config 端点契约（trusted 403 / 400 校验 /
//   405 / GET 取数 / POST 落盘 / 条件注册路由计数零回归）。直调 handler 形态（req={url,method,headers,body}
//   + res mock），harness 对齐 discovery.test.js:273-287（apiWithDiscovery/invoke）。
//   临时根一律落 D 盘（D:\dsh\_tmp\webui-config-build\，用户落盘纪律）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApi } from '../lib/api.js';
import { createStore } from '../lib/state/store.js';
import { createRuntimeConfigService } from '../lib/webui/runtime-config.js';

const TMP_BASE = 'D:\\dsh\\_tmp\\webui-config-build';
fs.mkdirSync(TMP_BASE, { recursive: true });
const freshRoot = () => fs.mkdtempSync(path.join(TMP_BASE, 'api-cfg-'));

const CONFIG_PATH = '/api/dsh-punky-swarm/config';
// trusted 判定用宿主形态头（loopback Host + 同源浏览器标记）
const TRUSTED_HEADERS = { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:3080' };

function apiWithConfigEndpoints(configEndpoints, extra = {}) {
  const routes = [];
  const ctx = { webServer: { register: (r) => { routes.push(r); return () => {}; } } };
  const api = createApi(ctx, { store: createStore(freshRoot()), root: freshRoot(), ...extra, configEndpoints });
  return { routes, api };
}

// 注入面装配（index.js configEndpoints 同形）：真实 runtimeConfig 服务 + applied/presets 假 getter
// watch 生效快照（longrun-panel-config-20260905）：appliedWatch = watchInstalledCfg 形状
//   { enabled, longrun:{enabled}, scanIntervalMinutes }（build-report §6 契约 3——applied.watch 生效面快照）
const APPLIED_WATCH = { enabled: true, longrun: { enabled: true }, scanIntervalMinutes: 1 };
function makeConfigEndpoints(root) {
  return {
    runtimeConfig: createRuntimeConfigService({ root }),
    trustedHosts: [],
    applied: () => ({ enabled: true, rules: [], defaults: { deny: 'DENY' }, flags: { pause: false, narrow: false, defer: false }, escalation: { enabled: false, threshold: 3, windowMs: 600000, primitives: ['DENY', 'NARROW'] } }),
    appliedWatch: () => APPLIED_WATCH,
    presets: () => [{ id: 'l1-sensitive', count: 12 }, { id: 'l2-resource', count: 6 }, { id: 'compose', count: 18 }],
  };
}

function invoke(route, url, { method = 'GET', headers = TRUSTED_HEADERS, body } = {}) {
  let status = 0, resBody = null;
  const res = { writeHead(s) { status = s; }, end(b) { resBody = JSON.parse(b); } };
  const req = { url, method, headers };
  if (body !== undefined) req.body = body;
  const ret = route.handler(req, res);
  if (ret && typeof ret.then === 'function') return ret.then(() => ({ status, body: resBody }));
  return { status, body: resBody };
}

test('端点：runtimeConfig 注入时注册 /config；未注入不注册（既有 7 路由契约保持）', () => {
  const root = freshRoot();
  const { routes } = apiWithConfigEndpoints(makeConfigEndpoints(root));
  assert.ok(routes.some((r) => r.path === CONFIG_PATH), '/config 已注册');
  assert.equal(routes.length, 8, '7 既有（R3 exec-panel-b：+1 /stream）+ 1 新增 /config');
  // 未注入 configEndpoints（既有 createApi 缺省形态）→ 不注册，7 路由契约零回归
  const { routes: r0 } = apiWithConfigEndpoints(undefined);
  assert.equal(r0.some((r) => r.path === CONFIG_PATH), false);
  assert.equal(r0.length, 7);
  // 空 configEndpoints（无 runtimeConfig）→ 同样不注册
  const { routes: rE } = apiWithConfigEndpoints({});
  assert.equal(rE.length, 7);
});

test('端点：GET /config 页载取数 → 200 overlay（磁盘 governance 原样，无 = null）+ applied + presets', () => {
  const root = freshRoot();
  const dir = path.join(root, 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ governance: { hook: { preset: 'l1-sensitive' } } }, null, 2));
  const { routes } = apiWithConfigEndpoints(makeConfigEndpoints(root));
  const r = invoke(routes.find((x) => x.path === CONFIG_PATH), CONFIG_PATH);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.overlay, { hook: { preset: 'l1-sensitive' } });
  assert.equal(r.body.applied.hook.enabled, true, 'applied = 装配侧解析快照');
  assert.deepEqual(r.body.presets.map((p) => p.count), [12, 6, 18]);
});

test('端点：GET /config overlay 无 governance → overlay null；文件缺失 → 200 空 overlay', () => {
  const root = freshRoot();
  const dir = path.join(root, 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ aip: { enabled: true } }, null, 2));
  const { routes } = apiWithConfigEndpoints(makeConfigEndpoints(root));
  const r = invoke(routes.find((x) => x.path === CONFIG_PATH), CONFIG_PATH);
  assert.equal(r.status, 200);
  assert.equal(r.body.overlay, null);
  // 文件缺失（从未写）→ overlay null（readOverlay {} → governance 无 → null）
  const { routes: r2 } = apiWithConfigEndpoints(makeConfigEndpoints(freshRoot()));
  const r3 = invoke(r2.find((x) => x.path === CONFIG_PATH), CONFIG_PATH);
  assert.equal(r3.status, 200);
  assert.equal(r3.body.overlay, null);
});

test('端点：POST /config 成功落盘 <tmpRoot>/config/runtime.json（governance 段精确）→ 200 {ok,written,ts}', async () => {
  const root = freshRoot();
  const { routes } = apiWithConfigEndpoints(makeConfigEndpoints(root));
  const payload = {
    governance: { hook: { enabled: true, preset: 'l2-resource', escalation: { enabled: true, threshold: 2, windowMs: 300000, primitives: ['DENY', 'NARROW'] }, flags: { narrow: true } } },
  };
  const r = await invoke(routes.find((x) => x.path === CONFIG_PATH), CONFIG_PATH, { method: 'POST', body: payload });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.written.hook, payload.governance.hook);
  assert.ok(typeof r.body.ts === 'string' && !Number.isNaN(Date.parse(r.body.ts)), 'ts = ISO 时间戳');
  const file = path.join(root, 'config', 'runtime.json');
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { governance: payload.governance }, '落盘内容 = 受控字段集');
});

test('端点：POST /config 400 校验拒绝（rules 表单外键）→ 文件不落盘', async () => {
  const root = freshRoot();
  const { routes } = apiWithConfigEndpoints(makeConfigEndpoints(root));
  const r = await invoke(routes.find((x) => x.path === CONFIG_PATH), CONFIG_PATH, {
    method: 'POST',
    body: { governance: { hook: { rules: [{ id: 'X', match: {}, violations: [] }] } } },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.errors[0].code, 'field-not-allowed');
  assert.equal(fs.existsSync(path.join(root, 'config', 'runtime.json')), false, '400 不落盘');
});

test('端点：POST /config 400 含错误码枚举（unknown-preset）；GET 同 trusted 护栏 403 分支', async () => {
  const root = freshRoot();
  const { routes } = apiWithConfigEndpoints(makeConfigEndpoints(root));
  const route = routes.find((x) => x.path === CONFIG_PATH);
  const bad = await invoke(route, CONFIG_PATH, { method: 'POST', body: { governance: { hook: { preset: 'nope' } } } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.errors[0].code, 'unknown-preset');
  // GET 同走 trusted：非 loopback Host → 403
  const g = invoke(route, CONFIG_PATH, { method: 'GET', headers: { host: 'evil.example:3080' } });
  assert.equal(g.status, 403);
  assert.equal(g.body.error, 'forbidden');
});

test('端点：trusted 403——Host 缺失 / 非 loopback / cross-site / Origin 异源（POST 与 GET 同封闭）', async () => {
  const root = freshRoot();
  const { routes } = apiWithConfigEndpoints(makeConfigEndpoints(root));
  const route = routes.find((x) => x.path === CONFIG_PATH);
  const cases = [
    { method: 'POST', headers: {} },
    { method: 'POST', headers: { host: '10.0.0.5:3080' } },
    { method: 'POST', headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } },
    { method: 'POST', headers: { host: '127.0.0.1:3080', origin: 'http://evil.example:3080' } },
    { method: 'GET', headers: { host: '10.0.0.5:3080' } },
  ];
  for (const c of cases) {
    const r = await invoke(route, CONFIG_PATH, c);
    assert.equal(r.status, 403, JSON.stringify(c.headers));
    assert.equal(r.body.error, 'forbidden');
  }
  // trustedHosts 注入（index 传 config.trustedHosts）：非 loopback 但入白名单 → 放行
  const ep = makeConfigEndpoints(freshRoot());
  ep.trustedHosts = ['lan.example.com'];
  const { routes: r2 } = apiWithConfigEndpoints(ep);
  const ok = invoke(r2.find((x) => x.path === CONFIG_PATH), CONFIG_PATH, {
    method: 'GET', headers: { host: 'lan.example.com:3080' },
  });
  assert.equal(ok.status, 200, 'trustedHosts 白名单放行');
});

test('端点：405 非 GET/POST 方法 → { ok:false, error:method-not-allowed }', async () => {
  const root = freshRoot();
  const { routes } = apiWithConfigEndpoints(makeConfigEndpoints(root));
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const r = await invoke(routes.find((x) => x.path === CONFIG_PATH), CONFIG_PATH, { method });
    assert.equal(r.status, 405);
    assert.deepEqual(r.body, { ok: false, error: 'method-not-allowed' });
  }
});

test('端点：POST 坏 JSON 体（req.body 非法 string）→ 400 invalid-json（client 侧错误）', async () => {
  const root = freshRoot();
  const { routes } = apiWithConfigEndpoints(makeConfigEndpoints(root));
  const route = routes.find((x) => x.path === CONFIG_PATH);
  let status = 0, resBody = null;
  const res = { writeHead(s) { status = s; }, end(b) { resBody = JSON.parse(b); } };
  const ret = route.handler({ url: CONFIG_PATH, method: 'POST', headers: TRUSTED_HEADERS, body: '{oops' }, res);
  if (ret && typeof ret.then === 'function') await ret;
  assert.equal(status, 400);
  assert.equal(resBody.ok, false);
  assert.match(resBody.error, /invalid-json/);
});

test('端点：POST /config windowSeconds（秒）→ 200 落盘换算 windowMs（×1000，毫秒契约不变）', async () => {
  const root = freshRoot();
  const { routes } = apiWithConfigEndpoints(makeConfigEndpoints(root));
  const payload = {
    governance: { hook: { enabled: true, preset: 'l2-resource', escalation: { enabled: true, threshold: 2, windowSeconds: 300, primitives: ['DENY', 'NARROW'] }, flags: { narrow: true } } },
  };
  const r = await invoke(routes.find((x) => x.path === CONFIG_PATH), CONFIG_PATH, { method: 'POST', body: payload });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.written.hook.escalation.windowMs, 300000, 'written 回显 ms（×1000）');
  assert.equal('windowSeconds' in r.body.written.hook.escalation, false, 'windowSeconds 为线协议键，不回显');
  const file = JSON.parse(fs.readFileSync(path.join(root, 'config', 'runtime.json'), 'utf8'));
  assert.equal(file.governance.hook.escalation.windowMs, 300000);
  assert.equal('windowSeconds' in file.governance.hook.escalation, false);
});

test('端点：POST /config windowSeconds 越界（<1s）→ 400 invalid-value；新旧字段同送 → 400 互斥（均不落盘）', async () => {
  const root = freshRoot();
  const { routes } = apiWithConfigEndpoints(makeConfigEndpoints(root));
  const route = routes.find((x) => x.path === CONFIG_PATH);
  const badSec = await invoke(route, CONFIG_PATH, { method: 'POST', body: { governance: { hook: { escalation: { windowSeconds: 0.5 } } } } });
  assert.equal(badSec.status, 400);
  assert.equal(badSec.body.errors[0].field, 'governance.hook.escalation.windowSeconds');
  const both = await invoke(route, CONFIG_PATH, { method: 'POST', body: { governance: { hook: { escalation: { windowSeconds: 60, windowMs: 60000 } } } } });
  assert.equal(both.status, 400);
  assert.equal(both.body.errors[0].code, 'invalid-value');
  assert.equal(fs.existsSync(path.join(root, 'config', 'runtime.json')), false, '400 不落盘');
});

// ── capabilities.watch 段端点契约（longrun-panel-config-20260905，e2 新增）──
// GET 新增平级键 overlayWatch/applied.watch（既有 overlay=governance 段语义不动）；POST 含 capabilities 段
//   → writeWatch（单保存合并双段）。契约基准：build-report §6 交接契约 2/3/5。

test('端点：GET /config 新增字段形状——overlayWatch（磁盘 capabilities.watch 原文）+ applied.watch（生效快照）', () => {
  const root = freshRoot();
  const dir = path.join(root, 'config');
  fs.mkdirSync(dir, { recursive: true });
  // 磁盘 watch 段带深层阈值键：overlayWatch 必须原样回显（含阈值等非表单键）；overlay 仍 = governance 段
  const watchRaw = { enabled: false, longrun: { enabled: false, maxDurationMs: 999000, noProgressWindowMs: 123000 } };
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify(
    { governance: { hook: { preset: 'l1-sensitive' } }, capabilities: { watch: watchRaw } }, null, 2));
  const { routes } = apiWithConfigEndpoints(makeConfigEndpoints(root));
  const r = invoke(routes.find((x) => x.path === CONFIG_PATH), CONFIG_PATH);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.overlay, { hook: { preset: 'l1-sensitive' } }, 'overlay 仍 = governance 段（既有语义不动）');
  assert.deepEqual(r.body.overlayWatch, watchRaw, 'overlayWatch = 磁盘 capabilities.watch 原样（含阈值）');
  assert.deepEqual(r.body.applied.watch, APPLIED_WATCH, 'applied.watch = 装配侧生效快照（watchInstalledCfg 形状）');
  assert.equal(r.body.applied.hook.enabled, true, 'applied.hook 既有键不破');
});

test('端点：GET /config overlayWatch 无 = null（capabilities 缺 watch 段 / 文件缺失）', () => {
  // capabilities 存在但无 watch 段 → overlayWatch null
  const root = freshRoot();
  const dir = path.join(root, 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify(
    { capabilities: { discovery: { enabled: true } }, governance: { hook: {} } }, null, 2));
  const { routes } = apiWithConfigEndpoints(makeConfigEndpoints(root));
  const r = invoke(routes.find((x) => x.path === CONFIG_PATH), CONFIG_PATH);
  assert.equal(r.status, 200);
  assert.equal(r.body.overlayWatch, null, 'capabilities 无 watch → null');
  // 文件缺失 → overlayWatch null
  const { routes: r2 } = apiWithConfigEndpoints(makeConfigEndpoints(freshRoot()));
  const r3 = invoke(r2.find((x) => x.path === CONFIG_PATH), CONFIG_PATH);
  assert.equal(r3.status, 200);
  assert.equal(r3.body.overlayWatch, null);
  assert.equal(r3.body.overlay, null);
});

test('端点：GET /config appliedWatch 未注入 → applied.watch 键省略（旧 harness 零感知）', () => {
  const root = freshRoot();
  const ep = makeConfigEndpoints(root);
  delete ep.appliedWatch; // 旧注入面（无 appliedWatch getter）→ 键省略
  const { routes } = apiWithConfigEndpoints(ep);
  const r = invoke(routes.find((x) => x.path === CONFIG_PATH), CONFIG_PATH);
  assert.equal(r.status, 200);
  assert.equal('watch' in r.body.applied, false, '未注入 appliedWatch → applied 无 watch 键（旧客户端零感知）');
  assert.ok(r.body.applied.hook, 'applied.hook 仍在');
});

test('端点：POST /config capabilities.watch 分支（writeWatch）成功落盘 → 200 {ok,written{capabilities}}', async () => {
  const root = freshRoot();
  const { routes } = apiWithConfigEndpoints(makeConfigEndpoints(root));
  const payload = { capabilities: { watch: { enabled: false, longrun: { enabled: false } } } };
  const r = await invoke(routes.find((x) => x.path === CONFIG_PATH), CONFIG_PATH, { method: 'POST', body: payload });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.written.capabilities.watch, payload.capabilities.watch);
  assert.ok(typeof r.body.ts === 'string', 'ts = ISO 时间戳');
  const file = JSON.parse(fs.readFileSync(path.join(root, 'config', 'runtime.json'), 'utf8'));
  assert.deepEqual(file, payload, '落盘 = capabilities.watch 受控段');
});

test('端点：POST /config 双段合并单保存（governance + capabilities.watch 同 body）→ 200 双 written', async () => {
  const root = freshRoot();
  const { routes } = apiWithConfigEndpoints(makeConfigEndpoints(root));
  const payload = {
    governance: { hook: { enabled: true, preset: 'l1-sensitive', flags: { narrow: true } } },
    capabilities: { watch: { enabled: true, longrun: { enabled: false } } },
  };
  const r = await invoke(routes.find((x) => x.path === CONFIG_PATH), CONFIG_PATH, { method: 'POST', body: payload });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.written.governance.hook.preset, 'l1-sensitive');
  assert.deepEqual(r.body.written.capabilities.watch, payload.capabilities.watch);
  const file = JSON.parse(fs.readFileSync(path.join(root, 'config', 'runtime.json'), 'utf8'));
  assert.equal(file.governance.hook.enabled, true);
  assert.deepEqual(file.capabilities.watch, payload.capabilities.watch, '双段各自落盘');
});

test('端点：POST /config capabilities.watch 400（enabled 非布尔）→ {ok:false,errors} field 锚 capabilities.watch.enabled，不落盘', async () => {
  const root = freshRoot();
  const { routes } = apiWithConfigEndpoints(makeConfigEndpoints(root));
  const r = await invoke(routes.find((x) => x.path === CONFIG_PATH), CONFIG_PATH, {
    method: 'POST', body: { capabilities: { watch: { enabled: 'yes' } } },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
  assert.deepEqual({ field: r.body.errors[0].field, code: r.body.errors[0].code },
    { field: 'capabilities.watch.enabled', code: 'invalid-value' });
  assert.equal(fs.existsSync(path.join(root, 'config', 'runtime.json')), false, '400 不落盘');
});

test('端点：POST /config 双段任一 400 整写拒绝（governance 合法 + capabilities 非法 → 无部分写）', async () => {
  const root = freshRoot();
  const { routes } = apiWithConfigEndpoints(makeConfigEndpoints(root));
  const r = await invoke(routes.find((x) => x.path === CONFIG_PATH), CONFIG_PATH, {
    method: 'POST',
    body: {
      governance: { hook: { enabled: true, preset: 'l1-sensitive' } },
      capabilities: { watch: { scanIntervalMinutes: 5 } }, // 表单外 watch 级键 → field-not-allowed
    },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.errors[0].code, 'field-not-allowed');
  assert.equal(r.body.errors[0].field, 'capabilities.watch.scanIntervalMinutes');
  assert.equal(fs.existsSync(path.join(root, 'config', 'runtime.json')), false, '整写拒绝无部分写');
});

test('端点：POST /config capabilities + 未知顶层键 → 400 unknown-top-level；capabilities-only 写不触碰既有 governance 落盘', async () => {
  const root = freshRoot();
  const dir = path.join(root, 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify(
    { aip: { enabled: true }, governance: { hook: { preset: 'l1-sensitive' } } }, null, 2));
  const { routes } = apiWithConfigEndpoints(makeConfigEndpoints(root));
  const route = routes.find((x) => x.path === CONFIG_PATH);
  // ① capabilities + 未知顶层键 → 400 unknown-top-level
  const bad = await invoke(route, CONFIG_PATH, { method: 'POST', body: { capabilities: { watch: { enabled: false } }, ghost: 1 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.errors[0].code, 'unknown-top-level');
  const afterBad = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
  assert.equal('capabilities' in afterBad, false, '400 不落盘（文件保持原样）');
  // ② capabilities-only 成功写 → 既有顶层键与 governance 键不受影响（读-改-写保留）
  const ok = await invoke(route, CONFIG_PATH, { method: 'POST', body: { capabilities: { watch: { enabled: false } } } });
  assert.equal(ok.status, 200);
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
  assert.equal(file.aip.enabled, true, '其它顶层键保留');
  assert.deepEqual(file.governance, { hook: { preset: 'l1-sensitive' } }, 'governance 键不受影响');
  assert.deepEqual(file.capabilities.watch, { enabled: false }, 'capabilities.watch 已写');
});
