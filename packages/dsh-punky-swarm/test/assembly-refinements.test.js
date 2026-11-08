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

// 装配隔离（丙）落地后，**活体实测撞出的两处回归**的回归锁。
//
// 两处都不是隔离逻辑本身错，而是「隔离改变了工具面的可见性」之后暴露出来的连带面：
//
//   ① **门禁死锁**：执行时难度门按**会话 header 的 preset id**（`modes.gate`）判定，
//      而治理工具面已改为按**scope 层**可见。两者不一致时（会话在工具面注册前创建 /
//      preset 重挂换代 ⇒ 老会话链到旧 generation），会话被门拦住却看不到 `assign_check`，
//      无法解套。实测：宿主 `pwsh` / `edit` 全部被拒，只能靠停插件脱身。
//      ⇒ 判据改为「调用方视角看不看得到 assign_check」，三态里只有 `absent` 才放宽；
//      `unknown`（夹具 / 无真注册表）保留旧行为。
//
//   ② **MCP 数据面路由未随 fiber 回收**：`webServer.register()` 的路由不自动摘除，
//      插件关→开即炸 `webserver: duplicate exact route "/mcp"`（实测插件管理器开关一次即复现）。
//      ⇒ 路由 disposer 必须登记为 `ctx.effect`，随插件卸载执行。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';

const MODE = 'punky-preset';

/** 难度门夹具：`visible` 决定调用方视角能否看到治理工具面（真实注册表的 scope 视图替身）。 */
function guardHarness({ visible }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-guard-vis-'));
  const store = createStore(root);
  const guards = [];
  const ctx = {
    logger: { warn() {}, info() {} },
    tools: {
      register() {},
      guard(fn) { guards.push(fn); return () => {}; },
      // `tools.get(name, agent)`：agent 视角。visible=false ⇒ 该 agent 看不到（老 generation）
      get(name) { return visible && name === 'assign_check' ? { name } : undefined; },
    },
  };
  const config = { modes: { gate: [MODE] } };
  createTools(ctx, { store, root, config, readConfig: () => config });
  return { guards, store, root };
}

const execOf = () => ({
  name: 'pwsh',
  arguments: {},
  agent: { session: { id: 's-guard-vis', header: { agentPreset: MODE } } },
});
const reasonOf = (h) => {
  for (const g of h.guards) { const r = g(execOf()); if (r) return r; }
  return null;
};

test('回归①：调用方看不到 assign_check ⇒ 不做难度判定（否则被拦且无工具可解套 = 死锁）', () => {
  const h = guardHarness({ visible: false });
  try {
    assert.equal(reasonOf(h), null, '看不到治理工具面的会话不得被难度门拦（实测会死锁）');
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test('回归① 反向对照：看得到 assign_check ⇒ 未评估照旧拒（放宽只对「看不到工具面」生效）', () => {
  const h = guardHarness({ visible: true });
  try {
    assert.match(String(reasonOf(h)), /task-difficulty-gate/,
      '能看见治理工具面的会话必须照旧被拦——否则本修复就成了把门禁关掉');
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test('回归②：MCP 数据面路由 disposer 必须登记为 ctx.effect（否则插件重载报 duplicate route）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-mcp-dispose-'));
  const store = createStore(root);
  const routes = [];
  const effects = [];
  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    tools: { register() {}, guard() { return () => {}; } },
    webServer: {
      register(route) {
        routes.push(route);
        return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1); };
      },
    },
    effect(callback) {
      const dispose = callback();
      if (typeof dispose === 'function') effects.push(dispose);
      return () => {};
    },
  };
  try {
    createTools(ctx, { store, root });
    assert.equal(routes.length, 1, 'MCP 数据面路由应已挂载（/mcp）');
    assert.equal(effects.length > 0, true, '路由 disposer 必须登记为 ctx.effect（随 fiber 卸载执行）');
    for (const dispose of effects) dispose();
    assert.equal(routes.length, 0, '卸载后路由必须被摘除——否则重载时宿主报 duplicate exact route "/mcp"');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
