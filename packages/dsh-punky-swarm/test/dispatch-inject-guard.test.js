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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 【P0-3 门禁解冻】原还 import `subagentRuntimeOf`（引擎侧形态探针，宿主形态值出口）。
//   provider 拆分中探针簇删除 ⇒ 本文件改由**端口功能面读数**作答（`createAgentPort`）。
import { buildStartRequest } from '../lib/engine/dispatch.js';
import { createAgentPort } from '../lib/provider-dsh/agent.js';
import * as plugin from '../lib/index.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readRel = (rel) => fs.readFileSync(path.join(PKG_ROOT, ...rel.split('/')), 'utf8');

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

// ── SP-1 【P0-3 解冻】inject 声明面：结构合法 + 单一来源驱动（原：inject 三键逐字含 tools/subagents） ──
//   原断言要求引擎插件行的 inject **必须含 `subagents` / `tools`** —— 那是**宿主服务名**。
//   provider 拆分后引擎行 inject 内宿主服务名必须为 0（J4'-a），两键迁到 **provider 行** ⇒ 原断言先红。
//   语义等价改写（本用例真命题是「声明面合法且由单点驱动，不是手写枚举」）：
//     ① 结构合法（数组 / 每键非空字符串 / 无重复）② inject 由**单一来源标识符**驱动。
//   「subagents 是引擎自派前提」这一要求**不消失**，它随宿主差异一起迁入 provider 行的 inject
//   （见 exec/gate-thaw.md §未改项与理由 · 承接面）。
test('SP-1 inject 声明面：结构合法（数组 / 非空字符串 / 无重复）且由单一来源标识符驱动', () => {
  assert.equal(Array.isArray(plugin.inject), true, 'inject 必须是数组（宿主归一化为 name→config 映射）');
  assert.equal(plugin.inject.every((k) => typeof k === 'string' && k.length > 0), true,
    'inject 每个键必须是非空字符串；实际=' + JSON.stringify(plugin.inject));
  assert.equal(new Set(plugin.inject).size, plugin.inject.length, 'inject 不得含重复键；实际=' + JSON.stringify(plugin.inject));
  const declLine = (readRel('lib/index.js').match(/^export const inject = .*$/m) ?? [''])[0];
  assert.match(declLine, /^export const inject = [A-Za-z_$][\w$]*;$/,
    'inject 必须由**单一来源标识符**驱动（禁手写数组字面量逐键枚举）；实际=' + JSON.stringify(declLine));
});

// ── SP-2 【P0-3 解冻】注入守卫抛错的取值面：端口降级不崩（原：subagentRuntimeOf 返回 null） ──
test('SP-2 未注入服务的**抛错式**取属性 ⇒ 端口降级为功能面不可用，且不抛原始 cordis 错', async () => {
  // 模拟 cordis 注入守卫：任何属性读取都抛
  const throwingCtx = new Proxy({}, {
    get(_t, k) { throw new Error('cannot get property "' + String(k) + '" without inject'); },
    has() { return false; },
  });
  const port = createAgentPort(throwingCtx);
  assert.equal(port.available, false, '抛错式上下文必须被兜住 ⇒ 功能面不可用（不崩）');
  assert.equal(port.narrowVia, 'none', '不可用时收窄通道必须是 none');
  // 不可用时派发入口必须**显式拒**（禁静默成功）
  await assert.rejects(() => (port.execute ?? port.spawn).call(port, { provider: 'p', label: 'l', prompt: 'x' }),
    (e) => {
      assert.equal(/^GATE_/.test(String(e?.message)), false, '端口层拒因不得用 GATE_ 码族；实际=' + e?.message);
      return true;
    });
});

// ── SP-3 【P0-3 解冻】五种宿主面的功能面读数（原：subagentRuntimeOf 的 rt 真值判定） ──
test('SP-3 端口对五种宿主面给出功能面读数（缺服务 / 无入口 / 历史桩 / 旧入口），且不抛', () => {
  for (const [label, ctx] of [
    ['缺键', {}],
    ['undefined', undefined],
    ['无入口', { subagents: {} }],
    ['历史桩 continuable', { subagents: { startContinuable: async () => ({}) } }],
  ]) {
    const port = createAgentPort(ctx);
    assert.equal(port.available, false, label + '：功能面不可用');
    assert.equal(port.narrowVia, 'none', label + '：收窄通道 none');
  }
  const startPort = createAgentPort({ subagents: { start: async () => ({}) } });
  assert.equal(startPort.available, true, '可用服务 ⇒ 功能面可用');
  assert.equal(startPort.narrowVia, 'request', '旧入口形态 ⇒ 收窄经 request');
});
