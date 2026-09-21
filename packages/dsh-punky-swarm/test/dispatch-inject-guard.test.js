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

// 派发套件活体回归：`ctx.subagents` 的**注入守卫**形态（2026-09-16 本批 suite-live-20260916 首派抓出）
//   现象：`lane_dispatch` 报 `cannot get property "subagents" without inject`（原始 cordis 错，非我们的码面）。
//   根因：插件 `inject` 未声明 `subagents`；cordis 对未声明服务**取属性即抛**（不是返回 undefined）。
//   修复：① `lib/index.js` inject 补 `subagents`（正解）；② `subagentRuntimeOf` 包 try/catch（兜底不崩，
//   走既定的「仅发句柄」降级分支）。本套件锁死②，防将来有人把 try/catch 删回去。
import test from 'node:test';
import assert from 'node:assert/strict';
import { subagentRuntimeOf, buildStartRequest } from '../lib/engine/dispatch.js';
import * as plugin from '../lib/index.js';

// ── 宿主 one-shot `start` 的 signal 契约（2026-09-16 首派抓出；2026-09-22 one-shot 化续用） ─────
//   宿主 `SubagentRuntime.start` → provider driver 对 `request.signal` 直接调 `throwIfAborted()`
//   （`dsh-subagent-in-process-driver` :163）；缺 signal 即抛 `Cannot read properties of undefined
//   (reading 'throwIfAborted')`（被 mapSpawnError 归一为 GATE_DISPATCH_FAILED）。
//   ⚠ one-shot 化纪律：**禁透传 `exec.signal`**（官方 background 分支实证其随工具调用结束 abort）
//   ⇒ 缺省必须自持永不中止 signal；本套件锁死该契约。
test('SP-4 buildStartRequest：必须带可调用的 signal（宿主 throwIfAborted 契约）+ label/toolFilter 在位', () => {
  const request = buildStartRequest({ batchId: 'b-x', lane: 'l1', parent: { id: 'a' }, prompt: 't' });
  assert.ok(request.signal, 'request.signal 必须存在');
  assert.equal(typeof request.signal.throwIfAborted, 'function', 'signal 必须支持 throwIfAborted（宿主直接调用）');
  assert.doesNotThrow(() => request.signal.throwIfAborted(), '未中止的 signal 调用不得抛');
  assert.equal(request.signal.aborted, false);
  assert.equal(request.label, 'punky-swarm:b-x:l1', 'B3 label 必须在顶层（宿主快照进 descriptor）');
  assert.ok(Array.isArray(request.toolFilter.deny) && request.toolFilter.deny.length > 0, 'toolFilter.deny 必须在位（按次收窄唯一通道）');
  assert.equal(request.prompt[0].type, 'text', 'prompt 须为 ContentBlock 形态');
  assert.equal(request.maxDepth, 1, '缺省 maxDepth=1');
});

test('SP-5 buildStartRequest：自有 signal 可注入并原样透传（取消能力面）', () => {
  const ctl = new AbortController();
  const request = buildStartRequest({ batchId: 'b-x', lane: 'l1', parent: { id: 'a' }, prompt: 't', signal: ctl.signal });
  assert.equal(request.signal, ctl.signal, '注入的 signal 必须原样透传（不自造第二个）');
  ctl.abort();
  assert.throws(() => request.signal.throwIfAborted(), /abort/i, '已中止 signal 调 throwIfAborted 应抛（宿主据此短路）');
});

test('SP-6 buildStartRequest：缺省 signal 每次独立（不复用全局单例，避免跨 lane 误取消）', () => {
  const a = buildStartRequest({ batchId: 'b', lane: 'l1', parent: {}, prompt: 'x' });
  const b = buildStartRequest({ batchId: 'b', lane: 'l2', parent: {}, prompt: 'x' });
  assert.notEqual(a.signal, b.signal);
});

test('SP-1 inject 声明：插件必须声明 subagents 依赖（引擎自派前提）', () => {
  assert.ok(Array.isArray(plugin.inject));
  assert.ok(plugin.inject.includes('subagents'), 'inject 必须含 subagents（否则 ctx.subagents 取属性即抛）');
  assert.ok(plugin.inject.includes('tools'));
});

test('SP-2 未注入服务的**抛错式**取属性 ⇒ 返回 null（降级「仅发句柄」，不抛原始 cordis 错）', () => {
  // 模拟 cordis 注入守卫：任何属性读取都抛
  const throwingCtx = new Proxy({}, {
    get(_t, k) { throw new Error('cannot get property "' + String(k) + '" without inject'); },
    has() { return false; },
  });
  assert.equal(subagentRuntimeOf(throwingCtx), null, '抛错式上下文必须被兜住');
});

test('SP-3 常规形态：无服务 / 服务无 start / 服务可用（one-shot 化探测面）', () => {
  assert.equal(subagentRuntimeOf({}), null);
  assert.equal(subagentRuntimeOf(undefined), null);
  assert.equal(subagentRuntimeOf({ subagents: {} }), null, '无 start ⇒ 视为不可用');
  assert.equal(subagentRuntimeOf({ subagents: { startContinuable: async () => ({}) } }), null,
    '仅存 continuable 通道 ⇒ 不可用（2026-09-22 one-shot 化：start 是唯一通道）');
  const rt = { start: async () => ({}) };
  assert.equal(subagentRuntimeOf({ subagents: rt }), rt, '可用服务原样返回');
});
