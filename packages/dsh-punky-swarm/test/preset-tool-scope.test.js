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

// 丙 · 装配隔离的**宿主语义回归**（用真实宿主包，不用伪 ctx）
//
// 隔离的全部依据 = 宿主 `@deepseek-ai/dsh-tools` 的注册表分层 ＋ `@deepseek-ai/dsh-scope` 的 scope 链：
//   `tools.register()` 落入**调用方 ctx** 所属的 scope 层，该层是**祖先贡献** ⇒
//   只有落在该 scope 链上的 agent（preset 选出的 agent 及其派生 worker）看得见。
//
// 为什么必须机检：若宿主哪天改回「一律全局注册」，本仓的隔离会**静默失效** ——
//   我们自己的测试仍全绿（那些用例用伪 ctx 的 `register` 桩，感知不到分层），而运行时工具泄漏。
//   本件直接拿真实注册表判读数，是这条语义的**唯一**活体锚点。
//
// 判据（行为面，每条都有反向对照，禁恒真）：
//   ① 引擎行只建工具集、不注册 ⇒ 真实注册表的**全局视图**零本仓工具；
//   ② 预设行（provider）以自己的 scope ctx 注册后，**该 scope 看得见全部**工具；
//   ③ 它的**子 scope**（= 派生 worker 的继承路径）同样看得见；
//   ④ 兄弟 scope 与全局视图**看不见**（隔离成立）；
//   ⑤ 反向对照：全局注册的合成工具对所有 scope 可见 ⇒ 证明 ④ 不是「注册表坏了」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope';

import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { apply as mountToolFace } from '../lib/provider-dsh/index.js';

/** 最小宿主：真实 `tools` 注册表（`ToolRuntime`）+ 它要求的 `systemPrompt` 面。 */
function bootHost() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-tool-scope-'));
  const ctx = new Context();
  ctx.provide('systemPrompt', {
    tools() {},
    section() {},
    getSectionOrder() { return 0; },
    getContextOrder() { return 0; },
  });
  const registry = new ToolRuntime(ctx, { mode: 'native' });
  return { ctx, registry, root };
}

/** 合成工具（只服务反向对照：全局注册的对照物）。 */
const syntheticTool = (name) => ({
  name,
  description: 'scope probe',
  parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object', properties: {} }, render: () => ({}) },
  execute: async () => ({ ok: true }),
});

test('丙 · 治理工具只在 punky-preset 的 scope 链上可见（真实注册表）', () => {
  const { ctx, registry, root } = bootHost();
  try {
    const store = createStore(root);
    const toolkit = createTools(ctx, { store, root });
    const names = toolkit.tools.map((t) => t.name);
    assert.ok(names.length > 0, '工具集必须非空（否则本件是空转）');

    // 等价引擎行（`lib/index.js`）：只 provide 工具集，不注册任何工具。
    ctx.provide('punkySwarmTools', {
      registerTools: (targetCtx) => toolkit.register(targetCtx),
      toolNames: names,
    });

    // ① 引擎行之后：全局视图零本仓工具
    assert.deepEqual(names.filter((n) => registry.get(n) !== undefined), [],
      '引擎行不得把治理工具注册到全局层（丙的起点）');

    // 等价预设组合里的 `punky-provider` 行：以自己的 scope ctx 注册
    const presetScope = createScope(ctx, {});
    const presetKey = scopeOf(presetScope.ctx);
    assert.notEqual(presetKey, undefined, '预设 scope ctx 必须带 scope 标签（否则注册会落到全局）');
    mountToolFace(presetScope.ctx);

    // ② 该 scope 看得见全部
    assert.deepEqual(names.filter((n) => registry.get(n, presetKey) === undefined), [],
      '预设 scope 必须看得见全部治理工具');

    // ③ 子 scope（派生 worker 的继承路径）同样看得见
    const workerScope = createScope(ctx, {}, { parent: presetKey });
    const workerKey = scopeOf(workerScope.ctx);
    assert.deepEqual(names.filter((n) => registry.get(n, workerKey) === undefined), [],
      '子 scope 必须继承预设层的工具（worker 靠 composeFrom 走这条链）');

    // ④ 兄弟 scope 与全局视图看不见（隔离成立）
    const siblingScope = createScope(ctx, {});
    const siblingKey = scopeOf(siblingScope.ctx);
    assert.deepEqual(names.filter((n) => registry.get(n, siblingKey) !== undefined), [],
      '兄弟 scope 不得看见治理工具（其它模式零污染）');
    assert.deepEqual(names.filter((n) => registry.get(n) !== undefined), [],
      '全局视图不得看见治理工具');

    // ⑤ 反向对照：全局注册的合成工具对所有 scope 可见 ⇒ ④ 不是「注册表坏了」
    ctx.tools.register(syntheticTool('scope_probe_global'));
    assert.ok(registry.get('scope_probe_global'), '全局注册的工具全局可见');
    assert.ok(registry.get('scope_probe_global', siblingKey), '全局注册的工具对兄弟 scope 可见');
    assert.ok(registry.get('scope_probe_global', presetKey), '全局注册的工具对预设 scope 同样可见');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('丙 · 反向：不给 scope 的注册桩仍是全局语义（证明上面④来自分层，不是桩的假象）', () => {
  const { ctx, registry, root } = bootHost();
  try {
    // 用「没有 scope 标签」的 ctx 注册（= 旧引擎行的行为）⇒ 所有 scope 都看得见。
    ctx.tools.register(syntheticTool('scope_probe_old_engine'));
    const scopes = [createScope(ctx, {}), createScope(ctx, {})];
    for (const s of scopes) {
      assert.ok(registry.get('scope_probe_old_engine', scopeOf(s.ctx)),
        '全局注册必然对所有 scope 可见（这是隔离要治的病，不是判据失效）');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
