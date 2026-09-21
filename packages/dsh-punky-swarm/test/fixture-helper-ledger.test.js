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

// 【F4 台账】夹具审计第 3 类（③ 重复）× 「同名不同物」的**结构性保证**（台账 `docs/fixture-audit-2026-09-21.md` §3.3）。
//
// 本文件锁两条不变量 —— 都是「一经漂移立刻红」，不靠人记得：
//   ① **本地定义名 ∩ 共享 helper 导出名 = ∅**：本地同名会与共享导出构成**互相冲突的契约**
//      （grep 一个名字得到两种语义）。F4 前实存 13 处（`runLane`×4 / `threeTierTasks`×5 /
//      `seedArtifacts`×3 / `tempRoot`×1），已消歧清零 ⇒ 本断言防回潮。
//      ⚠ 反向豁免：**import 显式改名**（`import { runLane as sharedRunLane }`）是允许的形态
//      （名字不撞），故判据只看 **`function` 声明**，不看 import specifier。
//   ② **`assemblyCtx` 四形状可分辨**：四个 builder 的存在意义就是「形状不同」⇒ 逐条锁住差异轴，
//      防止日后有人「顺手合一」把 `{fn,opts}` 压平（`auto-settle` 断言 `opts` 会立刻失据）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assemblyCtx, assemblyCtxPre, assemblyCtxWeb, assemblyCtxOpts,
} from './helpers/gate-fixture.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const HELPER_FILES = ['gate-fixture.mjs', 'watch-fixture.mjs', 'team-fixture.mjs'];

/** 共享 helper 的导出名（`export [async] function` / `export const`）。 */
function sharedExportNames() {
  const names = new Set();
  for (const h of HELPER_FILES) {
    const src = fs.readFileSync(path.join(TEST_DIR, 'helpers', h), 'utf8');
    for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) names.add(m[1]);
    for (const m of src.matchAll(/^export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) names.add(m[1]);
  }
  return names;
}

/** `test/**` 下所有**顶层 `function` 声明**名 → 出处（不含 helpers 自身）。 */
function localFunctionDecls() {
  const out = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (!/\.(js|mjs)$/.test(e.name)) continue;
      const rel = path.relative(TEST_DIR, abs).split(path.sep).join('/');
      if (HELPER_FILES.some((h) => rel === 'helpers/' + h)) continue;
      const src = fs.readFileSync(abs, 'utf8');
      for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
        if (!out.has(m[1])) out.set(m[1], []);
        out.get(m[1]).push(rel);
      }
    }
  };
  walk(TEST_DIR);
  return out;
}

test('F4-1 本地 `function` 声明名 与 共享 helper 导出名 不相交（防「同名不同物」回潮）', () => {
  const shared = sharedExportNames();
  const locals = localFunctionDecls();
  const collisions = [...locals.entries()]
    .filter(([name]) => shared.has(name))
    .map(([name, files]) => name + ' @ ' + [...new Set(files)].join(', '));
  assert.deepEqual(collisions, [],
    '本地同名会与共享导出构成两种语义（grep 一名两义）。F4 已消歧清零 ⇒ 新撞名须改名或改用共享版本。实际：'
    + JSON.stringify(collisions));
});

test('F4-2 `assemblyCtxPre`：基线 + `preCount()` 且计数随订阅/退订变化', () => {
  const ctx = assemblyCtxPre();
  assert.equal(typeof ctx.preCount, 'function', 'preCount 探针须存在');
  assert.equal(ctx.preCount(), 0, '未订阅 ⇒ 0');
  const off = ctx.on('tools/pre-execute', () => {});
  assert.equal(ctx.preCount(), 1, '订阅后 ⇒ 1');
  off();
  assert.equal(ctx.preCount(), 0, '退订后 ⇒ 0（disposer 生效）');
  assert.equal(ctx.webServer, undefined, 'pre 变体不挂 webServer');
});

test('F4-3 `assemblyCtxWeb`：返回 `{ ctx, routes }`，`webServer.register` 的路由进 routes', () => {
  const out = assemblyCtxWeb();
  assert.ok(out && out.ctx && Array.isArray(out.routes), '须返回 { ctx, routes }（两个 watch 套件按此解构）');
  out.ctx.on('tools/pre-execute', () => {});
  assert.equal(out.routes.length, 0, '未注册路由 ⇒ routes 空');
  const off = out.ctx.webServer.register({ path: '/x' });
  assert.equal(out.routes.length, 1, 'register 的路由被收集');
  assert.equal(typeof off, 'function', 'register 须返回 disposer');
});

test('F4-4 `assemblyCtxOpts`：`on` 项存 `{ fn, opts }`（供断言三参形态，如 {global:true}）', () => {
  const ctx = assemblyCtxOpts();
  const fn = () => {};
  ctx.on('subagent/end', fn, { global: true });
  const items = [...ctx.listeners.get('subagent/end')];
  assert.equal(items.length, 1);
  assert.equal(items[0].fn, fn, '项须保留 fn 本身');
  assert.deepEqual(items[0].opts, { global: true }, '项须保留 opts —— 压平即丢断言能力');
});

test('F4-5 `assemblyCtx`：基线项是**平坦 fn**（与 Opts 变体形状不同）', () => {
  const ctx = assemblyCtx();
  const fn = () => {};
  ctx.on('tools/pre-execute', fn);
  const first = [...ctx.listeners.get('tools/pre-execute')][0];
  assert.equal(first, fn, '基线存平坦 fn（消费方写 `const h = [...][0]`）');
  assert.equal(ctx.preCount, undefined, '基线不带 preCount');
});
