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

// 批 `punky-guard-split-20261114` · lane `e1-hooks-multictx`：`hooks` 端口**多 ctx** 回归。
// 判据源 = `plan/guard-split-spec.md` §S-4（目标接口 / 六条硬规则 / 注销时机），本文件逐条对应：
//   H1 §S-4.2 `owns` 新语义 + 规则 6（`entries.consumer`）—— 已登记 ctx 走端口分支，listener 仍落装配根
//   H2 规则 4 —— 未登记 ctx 仍走调用方回落 `ctx.on`（既有 21 个无装配夹具的旧语义，破它就是红一批）
//   H3 规则 1 —— 同 ctx 同 id 幂等（同一 disposer、登记表长度不变、dispose 一次即摘净）
//   H4 §S-4.4 —— 注销后再登记不泄漏；**旧世代 disposer 不得摘掉新登记**
//   H5 规则 2 —— 同 id 另 ctx（/ 同 ctx 另 id）⇒ `DUPLICATE_HOOK_CONSUMER`
//   H6 规则 3 —— `owns(null / undefined / {})` ⇒ false 且不抛
//   H7 规则 5 + V-9 —— 三校验点仍在端口内：post 序列 / consumer 三元组 / 三错误码在**已登记消费方 ctx** 下可达
//   H8 §S-4.4 硬规则 —— 登记生命周期 = 行 `apply` → `dispose`，**不是** `mount` → `unmount`
//   H9 —— 「登记晚于声明序」在跨 ctx 场景仍被捕获（漂移留痕 + 条目归属消费方）
//
// 装配面一律走真实 `apply()`（端口只在装配期登记，`createHooksPort` 不是公开面）：
//   根 = `os.tmpdir()` 下自建目录；HOME/DSH_HOME 由 `test/helpers/isolated-home.preload.mjs` 隔离。
//   治理 hook 在需要「腾出 governance 名字」的用例里显式关（`enabled: false` ⇒ 装配期不注册该名），
//   其余用例用真实 `installGovernanceHook` 当「消费方注册器」，验的是**调用方一行未改**也走得通。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';
import { corePort } from '../lib/core-ports.js';
import { installGovernanceHook } from '../lib/guard/wiring.js';
import { assemblyCtxHostFull } from './helpers/gate-fixture.mjs';

const freshRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'punky-hooks-multictx-'));

/** 治理 hook 的生效配置（`rules: []` = 装上了但零拦截，与 §V-6 的 control 段同形）。 */
const GOVERNANCE_ENABLED_NO_RULES = { governance: { hook: { enabled: true, rules: [] } } };

/**
 * 装配一次引擎行并交出 hooks 端口。
 * `governanceOn === false` ⇒ 治理 hook 不注册（把 `pre:governance` / `post:governance` 这两个名字腾给用例），
 * 于是装配期只剩 `verify`(10) / `dispatch`(20) 两条 —— 供多 ctx 用例自己以**消费方身份**补第三条。
 */
function mountEngine(t, { governanceOn = false } = {}) {
  const root = freshRoot();
  const ctx = assemblyCtxHostFull();
  const config = { root };
  if (!governanceOn) config.governance = { hook: { enabled: false } };
  else Object.assign(config, GOVERNANCE_ENABLED_NO_RULES);
  const dispose = apply(ctx, config);
  t.after(() => { try { dispose(); } catch { /* 幂等 */ } });
  return { ctx, root, port: corePort('hooks') };
}

/** 消费方 ctx 桩：**只**提供 `on`（证明端口不再依赖别的宿主能力）。 */
const consumerCtxOf = () => {
  const listeners = new Map();
  return {
    logger: { info() {}, warn() {}, error() {} },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => { listeners.get(event)?.delete(fn); };
    },
    listeners,
  };
};

// ── H1 已登记 ctx 走端口分支（§S-4.2 新语义 + 规则 6） ──────────────────────────────
test('H1 已登记 ctx：registerConsumer 后 owns(ctx)===true ⇒ 走端口分支，listener 仍落装配根 ctx', (t) => {
  const { ctx, port } = mountEngine(t);
  const guardCtx = consumerCtxOf();
  const entriesBefore = port.registered().length;
  const preBefore = ctx.preCount();

  assert.equal(port.owns(guardCtx), false, '登记前：未登记 ctx 不归端口（旧语义先立住）');
  const disposer = port.registerConsumer(guardCtx, { id: 'governance' });
  assert.equal(port.owns(guardCtx), true, '登记后 owns 为 true（§S-4.2：装配 ctx ∪ 已登记消费方）');
  assert.deepEqual(port.consumers().map((c) => c.id), ['governance'], 'consumers() 按登记序带出 id');
  assert.equal(typeof port.consumers()[0].registeredAt, 'string', 'registeredAt 可机读（诊断面）');

  // 真实调用方形态：`owns` 为 true 的那一侧走端口（与 wiring.js / evidence.js / dispatch-register.js 同形）
  const entryDispose = port.preExecute('probe-consumer-pre', () => {}, { order: 40 });
  assert.equal(port.registered().length, entriesBefore + 1, '条目进端口');
  assert.equal(ctx.preCount(), preBefore + 1, 'listener 仍挂在**装配根 ctx**（回调序守恒的实现前提）');
  assert.equal(guardCtx.listeners.size, 0, '消费方自己的 ctx 上零 listener（端口不把订阅散到子 ctx）');
  const added = port.registered().find((e) => e.name === 'probe-consumer-pre');
  assert.equal(added.consumer, 'governance', '规则 6：消费方登记的条目归属其 id（不是 assembly）');

  entryDispose();
  assert.equal(disposer(), true, '注销成功');
  assert.equal(port.owns(guardCtx), false, '注销后 owns 回到 false（回落到调用方分支）');
  assert.deepEqual(port.consumers(), [], '登记表摘净');
});

// ── H2 未登记 ctx 仍回落（规则 4：旧语义兼容，破它就是红一批） ────────────────────────
test('H2 未登记 ctx：端口在位也不接管，真实 installGovernanceHook 落在调用方自己的 ctx.on 上', (t) => {
  const { root, port } = mountEngine(t);
  const plainCtx = assemblyCtxHostFull(); // 未登记的伪 ctx（既有 21 个无装配夹具同形）
  const entriesBefore = port.registered().length;

  const handle = installGovernanceHook(plainCtx, { config: GOVERNANCE_ENABLED_NO_RULES, root, store: null });
  assert.equal(handle.installed, true, '治理 hook 装上了（走的是回落分支）');
  assert.equal(plainCtx.preCount(), 1, 'fallback：pre 直挂到调用方 ctx.on');
  assert.equal(plainCtx.listeners.get('tools/post-execute')?.size ?? 0, 1, 'fallback：post 同样直挂');
  assert.equal(port.registered().length, entriesBefore, '端口条目零增长（未被接管）');
  assert.equal(port.owns(plainCtx), false, 'owns 仍为 false');
  assert.deepEqual(port.consumers(), [], '未登记 ⇒ 登记表仍空');
  handle.dispose();
  assert.equal(plainCtx.preCount(), 0, '回落分支的 disposer 照常摘监听');
});

// ── H3 同 ctx 同 id 幂等（规则 1） ──────────────────────────────────────────────
test('H3 幂等：同 ctx 同 id 重复登记 ⇒ 同一 disposer、登记表长度不变、dispose 一次即摘净', (t) => {
  const { port } = mountEngine(t);
  const guardCtx = consumerCtxOf();

  const d1 = port.registerConsumer(guardCtx, { id: 'governance' });
  const d2 = port.registerConsumer(guardCtx, { id: 'governance' });
  assert.equal(port.consumers().length, 1, '重复登记不累积（热重载 / 多夹具重挂不得长表）');
  assert.equal(d2, d1, '返回**同一个** disposer（幂等不是「再登记一次」）');

  assert.equal(d1(), true, '第一次注销生效');
  assert.equal(port.consumers().length, 0, 'dispose 一次即摘净');
  assert.equal(d1(), false, 'disposer 自身幂等（第二次 false，不再产生副作用）');
  assert.equal(port.owns(guardCtx), false);
});

// ── H4 注销后再注册不泄漏（§S-4.4 泄漏面） ────────────────────────────────────────
test('H4 泄漏：注销 → 再注册后登记表恰 1 条，且**旧世代 disposer 不误摘新登记**', (t) => {
  const { port } = mountEngine(t);
  const guardCtx = consumerCtxOf();

  const stale = port.registerConsumer(guardCtx, { id: 'governance' });
  assert.equal(stale(), true, '第一代注销');
  const fresh = port.registerConsumer(guardCtx, { id: 'governance' });
  assert.equal(port.consumers().length, 1, '再注册后登记表恰 1 条（无旧条目残留）');
  assert.notEqual(fresh, stale, '新世代 ⇒ 新 disposer（旧的不复用）');

  assert.equal(stale(), false, '旧世代 disposer 重复调用 no-op');
  assert.equal(port.owns(guardCtx), true, '旧 disposer 不得摘掉新登记（否则行卸载晚到 = 静默回落）');
  assert.equal(port.consumers().length, 1, '登记表仍 1 条');
  assert.deepEqual(port.consumers(), [{ id: 'governance', registeredAt: port.consumers()[0].registeredAt }], '只剩新世代那一条');
  assert.equal(port.releaseConsumer(guardCtx), true, '命令式注销生效');
  assert.equal(port.releaseConsumer(guardCtx), false, '未登记 ⇒ false（幂等，不抛）');
  assert.deepEqual(port.consumers(), []);
});

// ── H5 同 id 另 ctx / 同 ctx 另 id ⇒ DUPLICATE_HOOK_CONSUMER（规则 2） ──────────────
test('H5 双挂守卫：同 id 登记到另一个 ctx ⇒ DUPLICATE_HOOK_CONSUMER（err.id 回显，拒后零污染）', (t) => {
  const { port } = mountEngine(t);
  const first = consumerCtxOf();
  const second = consumerCtxOf();
  port.registerConsumer(first, { id: 'governance' });

  assert.throws(() => port.registerConsumer(second, { id: 'governance' }), (err) => {
    assert.equal(err.code, 'DUPLICATE_HOOK_CONSUMER', '跨 ctx 同 id 必须响亮拒绝');
    assert.equal(err.id, 'governance', 'err.id 回显冲突的 id');
    return true;
  });
  assert.equal(port.consumers().length, 1, '拒绝后登记表零污染');
  assert.equal(port.owns(second), false, '第二个 ctx 仍未登记');

  // 同 ctx 换 id 同属「双身份」：同一码拒（契约未单列，按规则 2 的理由统一拦）
  assert.throws(() => port.registerConsumer(first, { id: 'verify' }), (err) => err.code === 'DUPLICATE_HOOK_CONSUMER');
  // id 必填非空（规则 1 的前半句）
  assert.throws(() => port.registerConsumer(consumerCtxOf(), {}), TypeError);
  assert.throws(() => port.registerConsumer(consumerCtxOf(), { id: '   ' }), TypeError);
});

// ── H6 owns 的伪输入（规则 3：不抛） ────────────────────────────────────────────
test('H6 owns 伪输入：null / undefined / {} ⇒ false 且不抛（既有直调夹具不得因改造而红）', (t) => {
  const { port } = mountEngine(t);
  for (const fake of [null, undefined, {}, 'ctx', 0, false]) {
    assert.equal(port.owns(fake), false, '伪 ctx 一律 false: ' + String(fake));
  }
  assert.equal(port.owns(corePort('hooks')), false, '端口对象自身不是 ctx ⇒ false（同一个对象也不能自认）');
});

// ── H7 三校验点仍在端口内 + V-9 读数（规则 5） ──────────────────────────────────────
test('H7 序表校验跨 ctx 生效：post 序列 verify→dispatch→governance，consumer=[assembly,assembly,governance]', (t) => {
  const { ctx, root, port } = mountEngine(t);
  const guardCtx = consumerCtxOf();
  const rowDispose = port.registerConsumer(guardCtx, { id: 'governance' });

  // 真实调用方形态（`installGovernanceHook` 内部就是 `owns(ctx) → port.pre/postExecute`）
  const handle = installGovernanceHook(guardCtx, { config: GOVERNANCE_ENABLED_NO_RULES, root, store: null });
  t.after(() => { try { handle.dispose(); } catch { /* 幂等 */ } });
  assert.equal(handle.installed, true, '已登记 ⇒ 装上了');

  const reg = port.registered();
  const post = reg.filter((e) => e.phase === 'post');
  assert.deepEqual(post.map((e) => e.name), ['verify', 'dispatch', 'governance'], 'V-9：post 序列恰为三角');
  assert.deepEqual(post.map((e) => e.consumer), ['assembly', 'assembly', 'governance'], 'V-9：consumer 三元组');
  assert.deepEqual(post.map((e) => e.order), [10, 20, 30], 'V-9 同源：冻结序 10 / 20 / 30');
  const governance = reg.filter((e) => e.name === 'governance');
  assert.equal(governance.length, 2, 'governance 恰 pre + post 两条');
  const verifySeq = reg.find((e) => e.name === 'verify').seq;
  const dispatchSeq = reg.find((e) => e.name === 'dispatch').seq;
  assert.ok(governance.every((e) => e.seq > verifySeq && e.seq > dispatchSeq), 'V-9：governance 两条 seq 均晚于 verify / dispatch（无 drift）');
  assert.equal(ctx.preCount(), 1, '跨 ctx 订阅后 pre 监听仍只有 1 条（挂装配根、不重复挂）');

  // ① 错 order ⇒ HOOK_ORDER_MISMATCH：**已登记消费方**走端口分支时校验照旧
  assert.throws(() => port.postExecute('governance', () => {}, { order: 50 }), (err) => {
    assert.equal(err.code, 'HOOK_ORDER_MISMATCH');
    assert.equal(err.expected, 30);
    assert.equal(err.received, 50);
    return true;
  });
  // ② 同相位同名 ⇒ DUPLICATE_HOOK_SUBSCRIBER（只挡同相位同名，跨相位不算重名）
  assert.throws(() => port.postExecute('governance', () => {}, { order: 30 }), (err) => {
    assert.equal(err.code, 'DUPLICATE_HOOK_SUBSCRIBER');
    assert.equal(err.subscriber, 'post:governance');
    return true;
  });
  // 显式归属通道（不经 owns 预判的新订阅方）：必须在册，否则拒
  assert.throws(() => port.postExecute('probe-explicit', () => {}, { order: 40, consumer: 'nobody' }), TypeError);
  const d = port.postExecute('probe-explicit', () => {}, { order: 40, consumer: 'governance' });
  assert.equal(port.registered().find((e) => e.name === 'probe-explicit').consumer, 'governance', '显式 consumer 生效');
  d();

  rowDispose();
});

// ── H8 登记生命周期 = 行 apply → dispose（§S-4.4 硬规则） ────────────────────────────
test('H8 remount 硬规则：handle.dispose() 不动行级登记 ⇒ 重挂后 owns 仍 true（否则静默回落）', (t) => {
  const { root, port } = mountEngine(t);
  const guardCtx = consumerCtxOf();
  const rowDispose = port.registerConsumer(guardCtx, { id: 'governance' });
  const countOf = () => port.registered().filter((e) => e.name === 'governance').length;

  const first = installGovernanceHook(guardCtx, { config: GOVERNANCE_ENABLED_NO_RULES, root, store: null });
  assert.equal(countOf(), 2, '首挂：pre + post 两条');
  assert.deepEqual(port.registered().filter((e) => e.name === 'governance').map((e) => e.consumer), ['governance', 'governance'], '两条都归属消费方');

  first.dispose(); // = 配置热切前的 handle.dispose()
  assert.equal(port.owns(guardCtx), true, '★ handle.dispose 不注销行级登记（注销塞这里 ⇒ remount 后静默回落）');
  assert.equal(countOf(), 0, 'handle.dispose 摘掉自己那两条条目');

  const second = installGovernanceHook(guardCtx, { config: GOVERNANCE_ENABLED_NO_RULES, root, store: null }); // remount（同 ctx）
  assert.equal(port.owns(guardCtx), true, 'remount 后 owns 仍 true');
  assert.equal(countOf(), 2, 'remount 后仍走端口分支（2 条，不是回落 0 条）');

  // 双挂由端口立即暴露（V-23）：不 dispose 直接再 mount 一次 ⇒ DUPLICATE_HOOK_SUBSCRIBER 抛出
  assert.throws(() => installGovernanceHook(guardCtx, { config: GOVERNANCE_ENABLED_NO_RULES, root, store: null }), (err) => err.code === 'DUPLICATE_HOOK_SUBSCRIBER');

  second.dispose();
  rowDispose();
  assert.equal(port.owns(guardCtx), false, '行卸载后登记摘净');
  assert.equal(countOf(), 0, '条目全部摘净（无泄漏）');
});

// ── H9 漂移捕获跨 ctx（登记晚于声明序） ────────────────────────────────────────────
test('H9 漂移捕获：已登记消费方后登记 order 更小的条目 ⇒ 留痕点名「登记晚于」，且条目归属消费方', (t) => {
  const { ctx, port } = mountEngine(t);
  const guardCtx = consumerCtxOf();
  port.registerConsumer(guardCtx, { id: 'governance' });

  // 声明序 40 先登记（装配根路径），随后消费方以 30 登记 ⇒ 实际回调序与声明序偏离
  const dLate = port.postExecute('probe-late', () => {}, { order: 40 });
  assert.equal(port.owns(guardCtx), true, '消费方仍持有身份');
  const dGov = port.postExecute('governance', () => {}, { order: 30 });

  const drift = ctx.calls.info.filter((line) => line.includes('hooks order drift'));
  assert.equal(drift.length, 1, '漂移留痕恰 1 条（不静默）');
  assert.ok(drift[0].includes('post:governance(order=30'), '点名本次登记');
  assert.ok(drift[0].includes('probe-late(40)'), '点名「晚于谁」');
  const entry = port.registered().find((e) => e.name === 'governance');
  assert.equal(entry.consumer, 'governance', '漂移条目归属消费方（跨 ctx 场景可定位来源）');
  assert.equal(entry.seq > port.registered().find((e) => e.name === 'probe-late').seq, true, 'seq 暴露真实注册序');
  dGov();
  dLate();
});
