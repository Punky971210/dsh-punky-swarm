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

// F1 修复批次 `punky-fix-f1-20261022` · lane `e3-tester` · 缺陷 **A1-P1-05**（派发意图单槽互覆 + 未命中零留痕）。
//
// 判据源 `plan/fix-spec.md` §方案 3 / §验收 T-3：
//   ① 每 caller **多槽 FIFO**：两个**无 `agent.session.id`** 的调用方（共享 `'cli'` 键）并发登记 ⇒ 不互相覆盖，
//      按**声明序**消费；
//   ② 消费即 shift（一次 running ⇔ 一次派发），队列空才删键；
//   ③ 未命中 ⇒ **零静默**：三档可辨成因 `logger.warn`（字面量契约：前缀 `dispatch register unbound`，
//      关键词 `该调用方无待消费派发意图` / `resolveBatchContext 反查无果` / `批上下文不完整`，每档一条用例）；
//      且观察者纪律不变（仍 `next()`、零事件、零拒绝码）。
//
// 纪律：三档各配阳性对照（同输入 + 有效意图 ⇒ 正常登记、零 unbound warn），防「warn 恒有 / 恒无」类恒真断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { EVT_MEMBER_DISPATCH } from '../lib/state/event-types.js';
import { installDispatchRegistration, DEFAULT_DISPATCH_TOOLS } from '../lib/bridge/dispatch-register.js';
import { assemblyCtx, tempRoot } from './helpers/gate-fixture.mjs';

// 批量 running 批预置（与 `dispatch-register.test.js` seedRunning 同源）
function seedRunning(root, sessionId, batchId, lanes = ['l1']) {
  const aux = createStore(root);
  aux.createBatch(sessionId, { batchId, wavePlan: buildWavePlan({ batchId, tasks: lanes.map((id) => ({ id })) }), phase: 'running' });
  return aux;
}

// `appendEvent` 计数包装（「未命中零事件」的可证伪读数；方法以原 store 为 `this`，不改被测实现）
function countingStore(store) {
  const counters = { appendEvent: 0 };
  const wrapper = {};
  for (const key of Object.keys(store)) {
    const v = store[key];
    if (typeof v !== 'function') { wrapper[key] = v; continue; }
    wrapper[key] = (...args) => {
      if (key === 'appendEvent') counters.appendEvent += 1;
      return v.apply(store, args);
    };
  }
  wrapper.counters = counters;
  return wrapper;
}

// `agent` 省略 ⇒ caller 兜底 `'cli'`（缺陷现场：宿主不保证派发调用方有 agent 会话 id）
function execOf(name, args, sessionId) {
  return {
    name,
    arguments: args,
    callId: 'call-' + name + '-' + Math.random().toString(36).slice(2, 8),
    ...(sessionId ? { agent: { session: { id: sessionId } } } : {}),
  };
}
const subagentResult = (workerSessionId) => ({ isError: false, value: { kind: 'continuable', subagentId: workerSessionId } });

// 逐个跑 post-execute 监听器，并回传 `next()` 调用次数（观察者纪律的读数面）
async function postOnce(ctx, exec, result) {
  const posts = [...(ctx.listeners.get('tools/post-execute') ?? [])];
  let nextCalls = 0;
  let ret;
  for (const p of posts) ret = await p(exec, result, () => { nextCalls += 1; return 'NEXT'; });
  return { nextCalls, ret };
}

function harness(root, index = new Map(), extra = {}) {
  const real = createStore(root);
  const store = countingStore(real);
  const ctx = assemblyCtx();
  const reg = installDispatchRegistration(ctx, { store, dispatchIndex: index, config: {}, logger: ctx.logger, ...extra });
  assert.equal(reg.installed, true);
  return { ctx, store, real, index, reg };
}

const unboundWarns = (ctx) => ctx.calls.warn.filter((w) => w.includes('dispatch register unbound'));

// ── T-3.1 两无 agent 会话调用方共享 'cli' 键 ⇒ 不互相覆盖 + 声明序 FIFO 消费 ──
test('T-3.1 A1-P1-05 同一 caller（两调用方皆无 agent.session.id）两条意图 ⇒ 不互相覆盖，按声明序 FIFO 消费', async () => {
  const root = tempRoot('punky-f1t31-');
  const aux = seedRunning(root, 'sess-q', 'b-A');
  seedRunning(root, 'sess-q', 'b-B');
  const { ctx, index, reg } = harness(root);
  try {
    // 两"不同调用方"都没有 agent.session.id ⇒ caller 同为 'cli'
    await postOnce(ctx, execOf('member_status', { session: 'sess-q', batchId: 'b-A', lane: 'l1', status: 'running' }), { isError: false, value: {} });
    await postOnce(ctx, execOf('member_status', { session: 'sess-q', batchId: 'b-B', lane: 'l1', status: 'running' }), { isError: false, value: {} });

    const pending = reg.pendingIntents();
    assert.equal(pending.length, 2, '改前单槽会让第二条**覆盖**第一条 ⇒ 这里必须是 2 条并存；实际=' + JSON.stringify(pending));
    assert.deepEqual(pending.map((p) => p.batchId).sort(), ['b-A', 'b-B'], '两批各自在场（不丢）');
    assert.deepEqual([...new Set(pending.map((p) => p.caller))], ['cli'], '夹具前提：两调用方共享 cli 键（缺陷现场）');
    assert.deepEqual(pending.map((p) => p.batchId), ['b-A', 'b-B'], '队列序 = 声明序');

    // 第一次派发 ⇒ 消费最早一条（b-A）；并留歧义痕（pending=2）
    const first = await postOnce(ctx, execOf('subagent', {}), subagentResult('ws-A'));
    assert.equal(first.nextCalls, 1);
    assert.equal(aux.readBatch('sess-q', 'b-A').events.filter((e) => e.type === EVT_MEMBER_DISPATCH).length, 1, 'b-A 已登记（先声明先消费）');
    assert.equal(aux.readBatch('sess-q', 'b-A').events.find((e) => e.type === EVT_MEMBER_DISPATCH).workerSessionId, 'ws-A');
    assert.equal(aux.readBatch('sess-q', 'b-B').events.filter((e) => e.type === EVT_MEMBER_DISPATCH).length, 0, 'b-B 不得被抢消费（改前正是串批面）');
    assert.deepEqual(reg.pendingIntents().map((p) => p.batchId), ['b-B'], '队列递减一条（FIFO shift），不整键清空');
    assert.ok(ctx.calls.warn.some((w) => w.includes('pending=2') && w.includes('FIFO')), 'D-3.5 歧义留痕（含 pending=N 与 FIFO）');

    // 第二次派发 ⇒ 消费 b-B
    await postOnce(ctx, execOf('subagent', {}), subagentResult('ws-B'));
    assert.equal(aux.readBatch('sess-q', 'b-B').events.filter((e) => e.type === EVT_MEMBER_DISPATCH).length, 1, 'b-B 随后登记（不丢）');
    assert.deepEqual(reg.pendingIntents(), [], '队列空 ⇒ 键被删除（既有 stale 清理语义）');
    assert.equal(reg.count(), 2);
    assert.equal(index.size, 2, '两次派发各写一条索引');
  } finally {
    reg.dispose();
  }
});

// ── T-3.2 阳性对照：不同 caller（各有 agent 会话）各留各的槽，互不串批 ──
test('T-3.2 A1-P1-05 阳性对照：不同 caller（各有 agent 会话）意图彼此隔离，派发只消费自己那条', async () => {
  const root = tempRoot('punky-f1t32-');
  const aux = seedRunning(root, 'sess-q', 'b-C');
  seedRunning(root, 'sess-q', 'b-D');
  const { ctx, reg } = harness(root);
  try {
    await postOnce(ctx, execOf('member_status', { session: 'sess-q', batchId: 'b-C', lane: 'l1', status: 'running' }, 'mgr-1'), { isError: false, value: {} });
    await postOnce(ctx, execOf('member_status', { session: 'sess-q', batchId: 'b-D', lane: 'l1', status: 'running' }, 'mgr-2'), { isError: false, value: {} });
    assert.equal(reg.pendingIntents().length, 2, '两 caller 各一条');

    await postOnce(ctx, execOf('subagent', {}, 'mgr-2'), subagentResult('ws-D'));
    assert.equal(aux.readBatch('sess-q', 'b-D').events.filter((e) => e.type === EVT_MEMBER_DISPATCH).length, 1, 'mgr-2 消费自己的 b-D');
    assert.equal(aux.readBatch('sess-q', 'b-C').events.filter((e) => e.type === EVT_MEMBER_DISPATCH).length, 0, 'mgr-1 的意图不得被 mgr-2 的派发吃掉');
    assert.deepEqual(reg.pendingIntents().map((p) => p.caller), ['mgr-1'], '仅 mgr-2 的槽被消费');

    await postOnce(ctx, execOf('subagent', {}, 'mgr-1'), subagentResult('ws-C'));
    assert.equal(aux.readBatch('sess-q', 'b-C').events.filter((e) => e.type === EVT_MEMBER_DISPATCH).length, 1);
    assert.deepEqual(reg.pendingIntents(), []);
  } finally {
    reg.dispose();
  }
});

// ── T-3.3 未命中档 1：未注入 resolver + 无待消费意图 ──
test('T-3.3 A1-P1-05 未命中档①：无 resolver、无意图 ⇒ warn「该调用方无待消费派发意图」（恰 1 条）+ 零事件 + next() 1 次 + 不抛', async () => {
  const root = tempRoot('punky-f1t33-');
  seedRunning(root, 'sess-q', 'b-E');
  const { ctx, store, index, reg } = harness(root);
  try {
    const r = await postOnce(ctx, execOf('subagent', {}), subagentResult('ws-unbound-1'));
    assert.equal(r.nextCalls, 1, '观察者纪律：仍 next()（不阻断）');
    const unbound = unboundWarns(ctx);
    assert.equal(unbound.length, 1, '未命中**必须**留痕且恰 1 条（改前此处零留痕）；实际=' + JSON.stringify(ctx.calls.warn));
    assert.ok(unbound[0].includes('该调用方无待消费派发意图'), '档①关键词；实际=' + unbound[0]);
    assert.ok(unbound[0].includes('tool=subagent') && unbound[0].includes('caller=cli'), '留痕须带 tool/caller');
    assert.equal(store.counters.appendEvent, 0, '未命中 ⇒ 零事件（不得伪造归属）');
    assert.equal(index.size, 0, '未命中 ⇒ 索引零映射');
    assert.equal(reg.count(), 0);
    assert.equal(ctx.calls.warn.filter((w) => w.includes('dispatch registration failed')).length, 0, '不得走异常隔离面（正常未命中，不是错误）');
  } finally {
    reg.dispose();
  }
});

// ── T-3.4 未命中档 2：注入了 resolver 但反查无果 ──
test('T-3.4 A1-P1-05 未命中档②：resolver 反查无果 ⇒ warn「resolveBatchContext 反查无果」+ 零事件 + next() 1 次', async () => {
  const root = tempRoot('punky-f1t34-');
  seedRunning(root, 'sess-q', 'b-F');
  const { ctx, store, reg } = harness(root, new Map(), { resolveBatchContext: () => null });
  try {
    const r = await postOnce(ctx, execOf('subagent', {}), subagentResult('ws-unbound-2'));
    assert.equal(r.nextCalls, 1);
    const unbound = unboundWarns(ctx);
    assert.equal(unbound.length, 1);
    assert.ok(unbound[0].includes('resolveBatchContext 反查无果'), '档②关键词；实际=' + unbound[0]);
    assert.equal(store.counters.appendEvent, 0);
    assert.equal(reg.count(), 0);
  } finally {
    reg.dispose();
  }
});

// ── T-3.5 未命中档 3：hit 不完整（缺 lane） ──
test('T-3.5 A1-P1-05 未命中档③：hit 不完整（缺 lane）⇒ warn「批上下文不完整」+ 零事件 + next() 1 次', async () => {
  const root = tempRoot('punky-f1t35-');
  seedRunning(root, 'sess-q', 'b-G');
  const { ctx, store, reg } = harness(root, new Map(), {
    resolveBatchContext: () => ({ sessionId: 'sess-q', batchId: 'b-G' }), // 缺 lane
  });
  try {
    const r = await postOnce(ctx, execOf('subagent', {}), subagentResult('ws-unbound-3'));
    assert.equal(r.nextCalls, 1);
    const unbound = unboundWarns(ctx);
    assert.equal(unbound.length, 1);
    assert.ok(unbound[0].includes('批上下文不完整'), '档③关键词；实际=' + unbound[0]);
    assert.equal(store.counters.appendEvent, 0);
    assert.equal(reg.count(), 0);
  } finally {
    reg.dispose();
  }
});

// ── T-3.6 未命中的阳性对照：同输入 + 有效意图 ⇒ 正常登记，且**零** unbound warn ──
test('T-3.6 A1-P1-05 阳性对照：同输入 + 有效意图 ⇒ 正常登记 1 条，零 unbound warn（证明 T-3.3 的 warn 不是恒有）', async () => {
  const root = tempRoot('punky-f1t36-');
  const aux = seedRunning(root, 'sess-q', 'b-H');
  const { ctx, store, reg } = harness(root);
  try {
    await postOnce(ctx, execOf('member_status', { session: 'sess-q', batchId: 'b-H', lane: 'l1', status: 'running' }), { isError: false, value: {} });
    const r = await postOnce(ctx, execOf('subagent', {}), subagentResult('ws-bound'));
    assert.equal(r.nextCalls, 1);
    assert.equal(unboundWarns(ctx).length, 0, '命中路不得产 unbound 留痕（否证「warn 恒有」）');
    assert.equal(store.counters.appendEvent, 1, '恰 1 条 member.dispatch');
    assert.equal(aux.readBatch('sess-q', 'b-H').events.filter((e) => e.type === EVT_MEMBER_DISPATCH).length, 1);
    assert.deepEqual(reg.pendingIntents(), [], '意图已消费');
  } finally {
    reg.dispose();
  }
});

// ── T-3.7 非 running 的 member_status ⇒ 该 caller 队列清空（既有 stale 清理语义逐字保留） ──
test('T-3.7 A1-P1-05 非 running 的 member_status ⇒ 该 caller 队列清空（多槽不改变 stale 清理语义）', async () => {
  const root = tempRoot('punky-f1t37-');
  seedRunning(root, 'sess-q', 'b-I');
  seedRunning(root, 'sess-q', 'b-J');
  const { ctx, reg } = harness(root);
  try {
    await postOnce(ctx, execOf('member_status', { session: 'sess-q', batchId: 'b-I', lane: 'l1', status: 'running' }, 'mgr-z'), { isError: false, value: {} });
    await postOnce(ctx, execOf('member_status', { session: 'sess-q', batchId: 'b-J', lane: 'l1', status: 'running' }, 'mgr-z'), { isError: false, value: {} });
    assert.equal(reg.pendingIntents().length, 2, '前置：两条排队');

    await postOnce(ctx, execOf('member_status', { session: 'sess-q', batchId: 'b-I', lane: 'l1', status: 'merged' }, 'mgr-z'), { isError: false, value: {} });
    assert.deepEqual(reg.pendingIntents(), [], '非 running ⇒ 该 caller 队列清空（stale 意图不得留给后续无关 subagent）');
  } finally {
    reg.dispose();
  }
});

// ── T-3.8 观察名单未变（本批零新增观察工具；防顺带扩面） ──
test('T-3.8 A1-P1-05 观察名单未被本批扩面：仍恰 subagent / subagent_fork', () => {
  assert.deepEqual([...DEFAULT_DISPATCH_TOOLS].sort(), ['subagent', 'subagent_fork']);
});
