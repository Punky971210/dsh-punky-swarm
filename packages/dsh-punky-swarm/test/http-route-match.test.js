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

// test/http-route-match.test.js —— **IL-7 的钉死用例**（批 `punky-adapter-split-20261031` · lane `provider-face-fix`）
//
// 缺陷（`e1-G02` / `AG-28`，`bf091db` 引入，P1-1「契约说谎」）：
//   `plan/contract-v2.md` / `lib/ports.ts` 早已把 `HttpRoute.match?: 'exact'|'prefix'` 入契约，
//   **但两侧都没接上**：① `lib/api.js` 的 `register` 只转 `method/path/handler`（丢掉 match）
//   ② `lib/provider-dsh/tools-http.js` 的 `mountRoute` 硬编码 `kind:'exact'`。
//   ⇒ 全仓**唯一** `match:'prefix'` 的那条 **404 回退路由**（`/api/dsh-punky-swarm`）静默退化为 exact。
//
// **为什么比「本来就没这个维度」更危险**：读契约的人会以为已支持 ⇒ 依赖它的读端写出「看起来能覆盖子路径、
//   实际只匹配精确路径」的行为，而且**没有任何测试会红**。本文件即为那个缺失的红。
//
// 判据面 = **宿主可见字段**（`route.kind`）。为什么选它而不是「api.js 源码里有没有 match 字样」：
//   源码断言只能证明「写了」，证明不了「贯通」；而 `kind` 是 `mountRoute` 真正交给宿主的那个值，
//   两侧任一环丢字段/硬编码，本判据**必然红**（见 AC-2 的变异自证）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApi } from '../lib/api.js';
import { createStore } from '../lib/state/store.js';
import { createHttpPort } from '../lib/provider-dsh/tools-http.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-route-match-'));
test.after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响判据 */ } });

/** 捕获面：假 webServer 把 `mountRoute` 最终交给宿主的 route 对象原样收集起来。 */
function captureRoutes() {
  const routes = [];
  const ctx = { webServer: { register: (r) => { routes.push(r); return () => {}; } } };
  return { ctx, routes };
}

/** 判据：route 是否被宿主按 prefix 语义注册（= IL-7 的两侧是否都贯通）。 */
const registeredAsPrefix = (route) => route?.kind === 'prefix';

// ── AC-1：**404 回退路由必须以 `prefix` 到达宿主**（IL-7 的核心）────────────────────────────
test('AC-1 404 回退路由（/api/dsh-punky-swarm）以 kind=prefix 注册到宿主 —— match 贯通两侧', () => {
  const { ctx, routes } = captureRoutes();
  createApi(ctx, { store: createStore(ROOT, { logger: { warn() {}, info() {}, error() {}, debug() {} } }), root: ROOT });

  const fallback = routes.find((r) => r.path === '/api/dsh-punky-swarm');
  assert.ok(fallback, '缺 404 回退路由 /api/dsh-punky-swarm（api.js 的路由表变了？）');
  assert.equal(registeredAsPrefix(fallback), true,
    '404 回退路由必须按 prefix 注册（否则子路径不会落到本插件的 404 JSON 上）；'
    + '实际 kind=' + JSON.stringify(fallback.kind));

  // 语义面复核：该 handler 确实是 404 JSON 产出者（不是被别的路由顶替）
  let status = 0;
  let body = null;
  const res = { writeHead(s) { status = s; }, end(b) { try { body = JSON.parse(b); } catch { body = b; } } };
  fallback.handler({ url: '/api/dsh-punky-swarm/definitely-not-a-route' }, res);
  assert.equal(status, 404, '回退 handler 须产出 404；实际=' + status);
  assert.deepEqual(body, { error: 'not-found' }, '回退 handler 须产出 {error:not-found}；实际=' + JSON.stringify(body));
});

// ── AC-2：**判别力自证**（变异必红）────────────────────────────────────────────────────────
//   把两侧的**旧缺陷形态**各造一次，喂给同一判据 ⇒ 必须判否。
//   ① 旧 api.js 形态：丢 match ⇒ 宿主永远拿到 exact
//   ② 旧 mountRoute 形态：硬编码 exact ⇒ 即使上游传了 match 也被吃掉
//   两条都不得「碰巧为真」，否则 AC-1 的绿是假的。
test('AC-2 变异自证：旧缺陷的两侧形态都必须被判否（AC-1 的判据有牙，不是恒真）', () => {
  const oldApiShape = { method: 'GET', path: '/api/dsh-punky-swarm', kind: 'exact', handler() {} };
  const oldMountShape = { method: 'GET', path: '/api/dsh-punky-swarm', kind: 'exact', handler() {} };
  assert.equal(registeredAsPrefix(oldApiShape), false, '① 丢 match（旧 api.js）必须判否');
  assert.equal(registeredAsPrefix(oldMountShape), false, '② 硬编码 exact（旧 mountRoute）必须判否');
  assert.equal(registeredAsPrefix(undefined), false, '空值不得被当成 prefix');
  assert.equal(registeredAsPrefix({ kind: 'prefix' }), true, '真 prefix 必须判真（证明判据非恒假）');
});

// ── AC-3：**只有回退路由是 prefix**（防「全改成 prefix」的过度修复）─────────────────────────
test('AC-3 除 404 回退外，其余路由必须仍是 exact（禁把全部路由改成 prefix）', () => {
  const { ctx, routes } = captureRoutes();
  createApi(ctx, { store: createStore(ROOT, { logger: { warn() {}, info() {}, error() {}, debug() {} } }), root: ROOT });

  const prefixRoutes = routes.filter((r) => registeredAsPrefix(r)).map((r) => r.path);
  assert.deepEqual(prefixRoutes, ['/api/dsh-punky-swarm'],
    '恰好一条 prefix 路由（404 回退）；实际=' + JSON.stringify(prefixRoutes));

  const nonPrefix = routes.filter((r) => !registeredAsPrefix(r));
  assert.ok(nonPrefix.length >= 1, '夹具前提：必须存在非 prefix 路由（否则本用例无对照面）');
  assert.deepEqual([...new Set(nonPrefix.map((r) => r.kind))], ['exact'],
    '其余路由的宿主 kind 必须全是 exact；实际=' + JSON.stringify([...new Set(nonPrefix.map((r) => r.kind))]));
});

// ── AC-4：`mountRoute` 的契约语义（缺省 exact / 显式 prefix / 显式 exact）────────────────────
test('AC-4 mountRoute：match 缺省 ⇒ exact；显式 prefix ⇒ prefix；显式 exact ⇒ exact', () => {
  const { ctx, routes } = captureRoutes();
  const port = createHttpPort(ctx);
  assert.equal(port.available, true, '夹具前提：假 webServer 有 register ⇒ 端口可用');

  port.mountRoute({ method: 'GET', path: '/a', handler() {} });
  port.mountRoute({ method: 'GET', path: '/b', match: 'prefix', handler() {} });
  port.mountRoute({ method: 'GET', path: '/c', match: 'exact', handler() {} });

  assert.deepEqual(routes.map((r) => [r.path, r.kind]), [
    ['/a', 'exact'],   // 契约：match 缺省 = exact
    ['/b', 'prefix'],  // 显式 prefix 必须原样到宿主
    ['/c', 'exact'],
  ], 'mountRoute 必须按 match 原文转发（缺省 exact，不硬编码）；实际=' + JSON.stringify(routes.map((r) => [r.path, r.kind])));
});
