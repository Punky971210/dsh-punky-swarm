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

// P3a 自动结算（规格 §2 触发面 / §3 判定器 / §4 停轮语义）测试。
// 覆盖：
//   A 主路 `subagent/end` 回调（`{global:true}` 装配面 + payload 三态：completed / 非 completed / 未知 id）；
//   B 兼底路 `settle-request`（身份反查 `laneBindingOf` → 同一判定函数）；
//   C 判定器**复用**既有 Tier3 校验链（running→review→merged 顺序不可省；产物缺失即停轮）；
//   D 幂等去重（同 (batchId, lane, 子会话 id) 重复触发 ⇒ 单次结算、不重复写事件）；
//   E 停轮（缺省 onFail=pause：写事件带 reason + 批 running→paused，**不写 failed、不改成员状态**）；
//   F 未命中静默（进程级广播会夹带非本套件子会话 ⇒ 零事件零状态变化）；
//   G 反例不谎报（stopReason 非 completed ⇒ 不结算）；插件入口真加载（工具面不回归）。
// 事实源纪律：断言一律读 `store.readBatch` 的批次 JSON（唯一事实源），不读模块内部状态。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import { createGates } from '../lib/state/gates.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { threeTierTasks, seedArtifacts } from './helpers/gate-fixture.mjs';
import {
  EVT_AUTO_SETTLE_TRIGGERED, EVT_AUTO_SETTLE_PAUSED, EVT_AUTO_SETTLE_SKIPPED,
  EVT_MEMBER_SETTLED, EVT_BATCH_PHASE, EVT_MEMBER_DISPATCH,
} from '../lib/state/event-types.js';
import {
  AUTO_SETTLE_SUBAGENT_END, AUTO_SETTLE_TRIGGERS, DEFAULT_ON_FAIL, AUDIT_SETTLE_DEFERRAL_REASON,
  installAutoSettle, autoSettleLane, requestAutoSettle, settleIdOf, hasAutoSettleRecord, isAuditLayerLane,
} from '../lib/engine/auto-settle.js';
import { createTools } from '../lib/tools/register.js';
import { createCoreTools } from '../lib/tools/core.js';

// ── helpers（对齐 dispatch-register.test.js 的 assemblyCtx / freshRoot 形态）──
function assemblyCtx() {
  const listeners = new Map();
  const calls = { info: [], warn: [], error: [] };
  const logger = {
    info: (...a) => calls.info.push(a.join(' ')),
    warn: (...a) => calls.warn.push(a.join(' ')),
    error: (...a) => calls.error.push(a.join(' ')),
  };
  return {
    listeners, calls, logger,
    tools: { register() {} },
    emit() {},
    on(event, fn, opts) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add({ fn, opts });
      return () => { for (const e of listeners.get(event) ?? []) if (e.fn === fn) listeners.get(event).delete(e); };
    },
  };
}
function freshRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
// 合规三层批（plan/exec/audit）——判据链复用 gate-fixture（与既有套件同一份契约形态）
function seedBatch(root, sessionId, batchId, { lane = 'e1', phase = 'running', memberState = 'running' } = {}) {
  const store = createStore(root);
  const plan = buildWavePlan({ batchId, tasks: threeTierTasks([lane]) });
  store.createBatch(sessionId, { batchId, wavePlan: plan, phase });
  seedArtifacts(root, sessionId, batchId, [lane]);
  if (memberState) store.setMember(sessionId, batchId, lane, memberState);
  return store;
}
const eventsOf = (store, sessionId, batchId, type) =>
  store.readBatch(sessionId, batchId).events.filter((e) => e.type === type);
const phaseOf = (store, sessionId, batchId) => store.readBatch(sessionId, batchId).phase;
const settleEventsOf = (store, sessionId, batchId) =>
  store.readBatch(sessionId, batchId).events.filter((e) => e.type === EVT_AUTO_SETTLE_TRIGGERED || e.type === EVT_AUTO_SETTLE_PAUSED);
// 主路回调的调用面（探针契约卡 §30-33：`ctx.on('subagent/end', h, { global: true })`，回调签名 `(info) => void`）
async function emitSubagentEnd(ctx, info) {
  for (const { fn } of [...(ctx.listeners.get(AUTO_SETTLE_SUBAGENT_END) ?? [])]) await fn(info);
}
const endInfo = (id, stopReason = 'completed') => ({ runId: 'run-' + id, provider: 'spawn', id, local: false, stopReason });

// ── A：装配面契约（事件名 + {global:true} 必填 + payload 常量）──
test('A1: installAutoSettle 以 ctx.on("subagent/end", h, { global: true }) 注册（scope 化插件 ctx 默认漏收，global 为硬性要求）', () => {
  const root = freshRoot('punky-as-a1-');
  const ctx = assemblyCtx();
  const reg = installAutoSettle(ctx, { store: createStore(root), dispatchIndex: new Map(), logger: ctx.logger });
  try {
    assert.equal(reg.installed, true);
    assert.equal(AUTO_SETTLE_SUBAGENT_END, 'subagent/end');
    const hooks = [...(ctx.listeners.get('subagent/end') ?? [])];
    assert.equal(hooks.length, 1, '恰一条 subagent/end 订阅');
    assert.deepEqual(hooks[0].opts, { global: true }, '必须带 {global:true}（缺省监听在被 scope 化的插件 ctx 上漏收）');
  } finally {
    reg.dispose();
    assert.equal((ctx.listeners.get('subagent/end') ?? []).size, 0, 'dispose 退订（幂等）');
  }
});

test('A2: ctx.on 缺失 → inert 静默降级（宿主能力缺失不炸，零副作用）', () => {
  const root = freshRoot('punky-as-a2-');
  const reg = installAutoSettle({ logger: console }, { store: createStore(root), dispatchIndex: new Map() });
  assert.equal(reg.installed, false);
  assert.equal(typeof reg.reason, 'string');
  assert.doesNotThrow(() => reg.dispose());
});

// ── B：主路真触发（`subagent/end` → 引擎自动结算到 merged，全程无人工 member_settle）──
test('B1: 主路——running lane + completed 事件 ⇒ 自动 running→review→merged（经 review 中转，不跳门禁）+ 事件留痕', async () => {
  const root = freshRoot('punky-as-b1-');
  const S = 'sess-b1';
  const store = seedBatch(root, S, 'b1');
  const ctx = assemblyCtx();
  const index = new Map([['ws-b1', { sessionId: S, batchId: 'b1', lane: 'e1' }]]);
  const reg = installAutoSettle(ctx, { store, dispatchIndex: index, root, logger: ctx.logger });
  try {
    await emitSubagentEnd(ctx, endInfo('ws-b1'));
    const b = store.readBatch(S, 'b1');
    assert.equal(b.lanes.e1, 'merged', 'lane 自动结算到 merged');
    // 复用既有判定链：状态迁移必须经 review 中转（running→merged 不在迁移表内）
    const settled = b.events.filter((e) => e.type === EVT_MEMBER_SETTLED && e.lane === 'e1' && e.from !== 'pending');
    assert.deepEqual(settled.map((e) => e.from + '->' + e.to), ['running->review', 'review->merged']);
    // 自动路径事件留痕（可 log_export 复原）
    const trig = eventsOf(store, S, 'b1', EVT_AUTO_SETTLE_TRIGGERED);
    assert.equal(trig.length, 1, '恰一条 auto.settle.triggered');
    assert.equal(trig[0].lane, 'e1');
    assert.equal(trig[0].trigger, AUTO_SETTLE_TRIGGERS.subagentEnd);
    assert.equal(trig[0].workerSessionId, 'ws-b1');
    assert.equal(trig[0].stopReason, 'completed');
    assert.equal(eventsOf(store, S, 'b1', EVT_AUTO_SETTLE_PAUSED).length, 0, '全绿不落停轮事件');
    assert.equal(phaseOf(store, S, 'b1'), 'running', '全绿不停轮（批次相位不变）');
  } finally {
    reg.dispose();
  }
});

test('B2: 未命中 dispatchIndex（进程级广播夹带非本套件子会话）⇒ 静默丢弃：零事件、零状态变化、零 warn', async () => {
  const root = freshRoot('punky-as-b2-');
  const S = 'sess-b2';
  const store = seedBatch(root, S, 'b2');
  const ctx = assemblyCtx();
  const reg = installAutoSettle(ctx, { store, dispatchIndex: new Map(), root, logger: ctx.logger });
  try {
    const beforeLen = store.readBatch(S, 'b2').events.length;
    await emitSubagentEnd(ctx, endInfo('ws-alien'));
    const b = store.readBatch(S, 'b2');
    assert.equal(b.lanes.e1, 'running', 'lane 状态不变');
    assert.equal(b.phase, 'running', '批次相位不变');
    assert.equal(settleEventsOf(store, S, 'b2').length, 0, '零自动结算事件');
    assert.equal(
      b.events.filter((e) => e.type !== EVT_AUTO_SETTLE_TRIGGERED && e.type !== EVT_AUTO_SETTLE_SKIPPED).length,
      beforeLen,
      '除自动结算自身留痕外事件流零新增',
    );
  } finally {
    reg.dispose();
  }
});

// ── C：反例不谎报（stopReason 非 completed ⇒ 不结算）──
test('C1: stopReason=aborted/error/max-tokens/refusal ⇒ 不走成功结算（lane 停在 running，落触发留痕带原因）', async () => {
  const root = freshRoot('punky-as-c1-');
  const S = 'sess-c1';
  const store = seedBatch(root, S, 'c1');
  const ctx = assemblyCtx();
  const index = new Map([['ws-c1', { sessionId: S, batchId: 'c1', lane: 'e1' }]]);
  const reg = installAutoSettle(ctx, { store, dispatchIndex: index, root, logger: ctx.logger });
  try {
    await emitSubagentEnd(ctx, { runId: 'r1', provider: 'spawn', id: 'ws-c1', local: false, stopReason: 'aborted' });
    const b = store.readBatch(S, 'c1');
    assert.equal(b.lanes.e1, 'running', '非 completed 不结算（禁一律判成功）');
    assert.equal(b.events.filter((e) => e.type === EVT_MEMBER_SETTLED && e.from !== 'pending').length, 0, '零结算迁移（seed 的 pending->running 不计）');
    const trig = eventsOf(store, S, 'c1', EVT_AUTO_SETTLE_TRIGGERED);
    assert.equal(trig.length, 1);
    assert.equal(trig[0].settleable, false, '显式标记不可结算（不静默丢）');
    assert.equal(trig[0].stopReason, 'aborted');
  } finally {
    reg.dispose();
  }
});

test('C2: 未知 stopReason（宿主新增枚举）⇒ 保守不结算（fail-safe：宁不结算不谎报）', async () => {
  const root = freshRoot('punky-as-c2-');
  const S = 'sess-c2';
  const store = seedBatch(root, S, 'c2');
  const ctx = assemblyCtx();
  const index = new Map([['ws-c2', { sessionId: S, batchId: 'c2', lane: 'e1' }]]);
  const reg = installAutoSettle(ctx, { store, dispatchIndex: index, root, logger: ctx.logger });
  try {
    await emitSubagentEnd(ctx, { runId: 'r', provider: 'spawn', id: 'ws-c2', local: false, stopReason: 'unknown-future-value' });
    assert.equal(store.readBatch(S, 'c2').lanes.e1, 'running');
    assert.equal(store.readBatch(S, 'c2').events.filter((e) => e.type === EVT_MEMBER_SETTLED && e.from !== 'pending').length, 0);
  } finally {
    reg.dispose();
  }
});

test('C3: payload 缺 id / 非对象 / lastAssistantMessage 缺失 ⇒ 不抛错、不误结算（可选字段不得触发崩溃）', async () => {
  const root = freshRoot('punky-as-c3-');
  const S = 'sess-c3';
  const store = seedBatch(root, S, 'c3');
  const ctx = assemblyCtx();
  const index = new Map([['ws-c3', { sessionId: S, batchId: 'c3', lane: 'e1' }]]);
  const reg = installAutoSettle(ctx, { store, dispatchIndex: index, root, logger: ctx.logger });
  try {
    await emitSubagentEnd(ctx, undefined);
    await emitSubagentEnd(ctx, { runId: 'r', id: '', stopReason: 'completed' });
    await emitSubagentEnd(ctx, { runId: 'r', id: 42, stopReason: 'completed' });
    assert.equal(store.readBatch(S, 'c3').lanes.e1, 'running', '畸形载荷零结算');
    assert.equal(eventsOf(store, S, 'c3', EVT_AUTO_SETTLE_TRIGGERED).length, 0, '畸形载荷零事件');
    assert.equal(ctx.calls.warn.length, 0, '畸形载荷不产 warn 噪音（静默丢弃）');
    // lastAssistantMessage 缺失的**合法**载荷仍能结算（A4 判据）
    await emitSubagentEnd(ctx, endInfo('ws-c3'));
    assert.equal(store.readBatch(S, 'c3').lanes.e1, 'merged', '可选字段缺失不阻断结算');
  } finally {
    reg.dispose();
  }
});

// ── D：幂等去重（同一 (batchId, lane, 子会话 id) 只结算一次）──
test('D1: 同 id 重复 subagent/end（多 epoch / 重启重放）⇒ 第二次经幂等键跳过：不重复结算、不重复写事件', async () => {
  const root = freshRoot('punky-as-d1-');
  const S = 'sess-d1';
  const store = seedBatch(root, S, 'd1');
  const ctx = assemblyCtx();
  const index = new Map([['ws-d1', { sessionId: S, batchId: 'd1', lane: 'e1' }]]);
  const reg = installAutoSettle(ctx, { store, dispatchIndex: index, root, logger: ctx.logger });
  try {
    await emitSubagentEnd(ctx, endInfo('ws-d1'));
    const after1 = store.readBatch(S, 'd1');
    // 第二次：同 id、新 runId（契约卡 #11：每 epoch 新 runId，幂等键不得取 runId）
    await emitSubagentEnd(ctx, { runId: 'run-2', provider: 'spawn', id: 'ws-d1', local: false, stopReason: 'completed' });
    const after2 = store.readBatch(S, 'd1');
    assert.equal(after2.lanes.e1, 'merged');
    assert.equal(
      after2.events.filter((e) => e.type === EVT_MEMBER_SETTLED && e.lane === 'e1').length,
      after1.events.filter((e) => e.type === EVT_MEMBER_SETTLED && e.lane === 'e1').length,
      'member.settled 条数不变（第二路落终态即 no-op）',
    );
    const trig = after2.events.filter((e) => e.type === EVT_AUTO_SETTLE_TRIGGERED);
    assert.equal(trig.length, 1, 'auto.settle.triggered 不重复写');
    const skipped = after2.events.filter((e) => e.type === EVT_AUTO_SETTLE_SKIPPED);
    assert.equal(skipped.length, 1, '第二路落 auto.settle.skipped（可审计：不是静默丢弃）');
    assert.equal(skipped[0].reason, 'already-settled');
    assert.equal(skipped[0].lane, 'e1');
  } finally {
    reg.dispose();
  }
});

test('D2: 跨重启幂等（同批 JSON 重放）——新监听器实例 + 同一已结算 lane ⇒ 不重复结算', async () => {
  const root = freshRoot('punky-as-d2-');
  const S = 'sess-d2';
  const store = seedBatch(root, S, 'd2');
  const index = new Map([['ws-d2', { sessionId: S, batchId: 'd2', lane: 'e1' }]]);
  const ctx1 = assemblyCtx();
  const reg1 = installAutoSettle(ctx1, { store, dispatchIndex: index, root, logger: ctx1.logger });
  await emitSubagentEnd(ctx1, endInfo('ws-d2'));
  reg1.dispose();
  const before = store.readBatch(S, 'd2');
  // 进程重启 = 新 store 实例 + 新监听器（判据只来自批次 JSON）
  const store2 = createStore(root);
  const ctx2 = assemblyCtx();
  const reg2 = installAutoSettle(ctx2, { store: store2, dispatchIndex: new Map(index), root, logger: ctx2.logger });
  try {
    await emitSubagentEnd(ctx2, endInfo('ws-d2'));
    const after = store2.readBatch(S, 'd2');
    assert.equal(
      after.events.filter((e) => e.type === EVT_MEMBER_SETTLED).length,
      before.events.filter((e) => e.type === EVT_MEMBER_SETTLED).length,
      '重启后重放不重复写 member.settled',
    );
  } finally {
    reg2.dispose();
  }
});

test('D3: 幂等键 = (batchId, lane, 子会话 id) 判据函数（settleIdOf / hasAutoSettleRecord 单点）', () => {
  const root = freshRoot('punky-as-d3-');
  const S = 'sess-d3';
  const store = seedBatch(root, S, 'd3');
  const b = store.readBatch(S, 'd3');
  assert.equal(settleIdOf('ws-1'), 'ws-1');
  assert.equal(settleIdOf(null), null);
  // 触发前无记录
  assert.equal(hasAutoSettleRecord(b, 'e1', 'ws-1'), false);
  // 假造一条触发留痕（键相同）⇒ 命中
  b.events.push({ ts: new Date().toISOString(), type: EVT_AUTO_SETTLE_TRIGGERED, lane: 'e1', settleId: 'ws-1' });
  assert.equal(hasAutoSettleRecord(b, 'e1', 'ws-1'), true, '按 settleId 命中');
  assert.equal(hasAutoSettleRecord(b, 'e1', 'ws-2'), false, '不同 id 不命中');
  assert.equal(hasAutoSettleRecord(b, 'other', 'ws-1'), false, '不同 lane 不命中');
});

// ── E：停轮（缺省 onFail=pause；不写 failed、不改成员状态）──
test('E1: 判据不满足（exec 产物缺失）⇒ 停轮：auto.settle.paused 带 reason + 批 running→paused；成员保持 review、不写 failed', async () => {
  const root = freshRoot('punky-as-e1-');
  const S = 'sess-e1';
  const store = seedBatch(root, S, 'e1', { lane: 'e1' });
  const ctx = assemblyCtx();
  const index = new Map([['ws-e1', { sessionId: S, batchId: 'e1', lane: 'e1' }]]);
  const reg = installAutoSettle(ctx, { store, dispatchIndex: index, root, logger: ctx.logger });
  try {
    // 删掉 exec 声明产物 ⇒ 判据链在 review→merged 处拒（GATE_EXIT_MISSING_EXEC）
    fs.rmSync(path.join(root, 'sessions', S, 'artifacts', 'e1', 'exec', 'e1.md'));
    await emitSubagentEnd(ctx, endInfo('ws-e1'));
    const b = store.readBatch(S, 'e1');
    assert.equal(b.phase, 'paused', '缺省 onFail=pause（停轮上报，不静默判死）');
    assert.equal(b.lanes.e1, 'review', '停轮不改成员状态（lane 停在 review 等人工处置）');
    const paused = b.events.filter((e) => e.type === EVT_AUTO_SETTLE_PAUSED);
    assert.equal(paused.length, 1, '恰一条 auto.settle.paused');
    assert.equal(paused[0].action, DEFAULT_ON_FAIL);
    assert.ok(String(paused[0].reason).includes('GATE_EXIT_MISSING'), 'reason 含门禁码（可定位）：' + paused[0].reason);
    assert.equal(b.events.filter((e) => e.type === EVT_MEMBER_SETTLED && e.to === 'failed').length, 0, '不写 failed（停轮非判死）');
    assert.equal(b.events.at(-1).type, EVT_BATCH_PHASE, '相位迁移事件最后落（成员态确定后才停轮）');
  } finally {
    reg.dispose();
  }
});

test('E2: 停轮幂等——第二次失败触发不重复写 paused 事件、不重复推进相位', async () => {
  const root = freshRoot('punky-as-e2-');
  const S = 'sess-e2';
  const store = seedBatch(root, S, 'e2', { lane: 'e1' });
  fs.rmSync(path.join(root, 'sessions', S, 'artifacts', 'e2', 'exec', 'e1.md'));
  const ctx = assemblyCtx();
  const index = new Map([['ws-e2', { sessionId: S, batchId: 'e2', lane: 'e1' }]]);
  const reg = installAutoSettle(ctx, { store, dispatchIndex: index, root, logger: ctx.logger });
  try {
    await emitSubagentEnd(ctx, endInfo('ws-e2'));
    const phaseAfter1 = eventsOf(store, S, 'e2', EVT_BATCH_PHASE).length;
    await emitSubagentEnd(ctx, { runId: 'r2', id: 'ws-e2', stopReason: 'completed' });
    assert.equal(eventsOf(store, S, 'e2', EVT_AUTO_SETTLE_PAUSED).length, 1, 'paused 事件只落一次');
    assert.equal(eventsOf(store, S, 'e2', EVT_BATCH_PHASE).length, phaseAfter1, '相位不重复迁移');
    assert.equal(store.readBatch(S, 'e2').phase, 'paused');
  } finally {
    reg.dispose();
  }
});

// ── F：兼底路（settle-request）与双路合并 ──
test('F1: 兼底路——requestAutoSettle 身份反查 laneBindingOf（member.dispatch 事件）⇒ 与主路同一判定函数', async () => {
  const root = freshRoot('punky-as-f1-');
  const S = 'sess-f1';
  const store = seedBatch(root, S, 'f1');
  store.appendEvent(S, 'f1', EVT_MEMBER_DISPATCH, { lane: 'e1', workerSessionId: 'ws-f1' });
  const r = await requestAutoSettle({ ctx: assemblyCtx(), store, root }, { workerSessionId: 'ws-f1', reason: 'worker settle-request' });
  try {
    assert.equal(r.ok, true);
    assert.equal(r.action, 'merged');
    const b = store.readBatch(S, 'f1');
    assert.equal(b.lanes.e1, 'merged');
    const trig = b.events.filter((e) => e.type === EVT_AUTO_SETTLE_TRIGGERED);
    assert.equal(trig.length, 1);
    assert.equal(trig[0].trigger, AUTO_SETTLE_TRIGGERS.settleRequest, '触发来源可辨（主路/兼底路分开留痕）');
  } finally { /* 无挂载面需清理（无 ctx.on） */ }
});

test('F2: 兼底路未绑定（身份反查 miss）⇒ 明确拒（不猜、不静默）', async () => {
  const root = freshRoot('punky-as-f2-');
  const S = 'sess-f2';
  const store = seedBatch(root, S, 'f2');
  const r = await requestAutoSettle({ ctx: assemblyCtx(), store, root }, { workerSessionId: 'ws-unbound' });
  assert.equal(r.ok, false);
  assert.equal(r.action, 'unbound');
  assert.equal(store.readBatch(S, 'f2').lanes.e1, 'running', '未绑定零状态变化');
  assert.equal(settleEventsOf(store, S, 'f2').length, 0, '未绑定零事件');
});

test('F3: 双路同时到达同一 lane ⇒ 单次结算（第二条经幂等键 no-op，无冲突事件、无非法迁移）', async () => {
  const root = freshRoot('punky-as-f3-');
  const S = 'sess-f3';
  const store = seedBatch(root, S, 'f3');
  store.appendEvent(S, 'f3', EVT_MEMBER_DISPATCH, { lane: 'e1', workerSessionId: 'ws-f3' });
  const ctx = assemblyCtx();
  const index = new Map([['ws-f3', { sessionId: S, batchId: 'f3', lane: 'e1' }]]);
  const reg = installAutoSettle(ctx, { store, dispatchIndex: index, root, logger: ctx.logger });
  try {
    // 两路并发触发（同一 lane、同一子会话）
    const [main, fallback] = await Promise.all([
      emitSubagentEnd(ctx, endInfo('ws-f3')),
      requestAutoSettle({ ctx, store, root }, { workerSessionId: 'ws-f3' }),
    ]);
    void main; void fallback;
    const b = store.readBatch(S, 'f3');
    assert.equal(b.lanes.e1, 'merged');
    assert.equal(b.events.filter((e) => e.type === EVT_MEMBER_SETTLED && e.lane === 'e1' && e.from !== 'pending').length, 2, '恰一次结算（running->review + review->merged）');
    assert.equal(b.events.filter((e) => e.type === EVT_AUTO_SETTLE_TRIGGERED).length, 1, '触发留痕单条（第二路 no-op）');
    assert.equal(b.events.filter((e) => e.type === EVT_AUTO_SETTLE_SKIPPED).length, 1, '第二路落 skipped 留痕');
    assert.equal(b.phase, 'running', '无非法相位迁移');
  } finally {
    reg.dispose();
  }
});

test('F4: swarm_report(settle-request) 工具面接线自证——core 工具存在且触发兼底判定（防「模块在、工具没接」）', async () => {
  const root = freshRoot('punky-as-f4-');
  const S = 'sess-f4';
  const store = seedBatch(root, S, 'f4');
  store.appendEvent(S, 'f4', EVT_MEMBER_DISPATCH, { lane: 'e1', workerSessionId: 'ws-f4' });
  const ctx = assemblyCtx();
  const tools = createCoreTools(ctx, { store, root, config: {}, readConfig: () => ({}) });
  const rep = tools.find((t) => t.name === 'swarm_report');
  assert.ok(rep, 'swarm_report 仍注册（既有轨道零回归）');
  const exec = { name: 'swarm_report', arguments: {}, agent: { session: { id: 'ws-f4' } } };
  const out = await rep.execute({ type: 'settle-request', summary: 'lane 交付完成，请求结算' }, exec);
  assert.equal(out.delivered, true, '回报仍投递（既有语义不变）');
  assert.equal(store.readBatch(S, 'f4').lanes.e1, 'merged', 'settle-request ⇒ 兼底路判据生效（同一判定函数）');
});

// ── G：登记面/装配面自证 ──
test('G1: 主路监听实际被调（非死代码）——回调计数 = 监听调用次数（未命中仍零写入）', async () => {
  const root = freshRoot('punky-as-g1-');
  const S = 'sess-g1';
  const store = seedBatch(root, S, 'g1');
  const ctx = assemblyCtx();
  const index = new Map([['ws-g1', { sessionId: S, batchId: 'g1', lane: 'e1' }]]);
  const reg = installAutoSettle(ctx, { store, dispatchIndex: index, root, logger: ctx.logger });
  try {
    assert.equal(reg.count(), 0);
    const before = store.readBatch(S, 'g1').events.length;
    await emitSubagentEnd(ctx, endInfo('ws-alien'));
    assert.equal(reg.count(), 1, '每次事件都进监听（计数 = 调用次数，非命中次数）');
    assert.equal(store.readBatch(S, 'g1').events.length, before, '未命中零写入（静默丢弃）');
    await emitSubagentEnd(ctx, endInfo('ws-g1'));
    assert.equal(reg.count(), 2);
    assert.equal(store.readBatch(S, 'g1').lanes.e1, 'merged', '命中触达判定器（监听非死代码）');
  } finally {
    reg.dispose();
  }
});

test('G2: autoSettleLane 直调面 = 单点判定（两路共用）；onFail 缺省常量 = pause', async () => {
  const root = freshRoot('punky-as-g2-');
  const S = 'sess-g2';
  const store = seedBatch(root, S, 'g2');
  assert.equal(DEFAULT_ON_FAIL, 'pause');
  const r = await autoSettleLane(
    { ctx: assemblyCtx(), store, root },
    { sessionId: S, batchId: 'g2', lane: 'e1', workerSessionId: 'ws-g2', trigger: AUTO_SETTLE_TRIGGERS.subagentEnd },
  );
  assert.equal(r.ok, true);
  assert.equal(r.action, 'merged');
  assert.equal(store.readBatch(S, 'g2').lanes.e1, 'merged');
});

test('G3: 终态 lane 再触发 ⇒ skipped（触发资格：命中 lane 须非终态），幂等键按 (lane, id) 判定', async () => {
  const root = freshRoot('punky-as-g3-');
  const S = 'sess-g3';
  const store = seedBatch(root, S, 'g3');
  const batchId = 'g3';
  const r1 = await autoSettleLane(
    { ctx: assemblyCtx(), store, root },
    { sessionId: S, batchId, lane: 'e1', workerSessionId: 'ws-g3a', trigger: AUTO_SETTLE_TRIGGERS.settleRequest },
  );
  assert.equal(r1.action, 'merged');
  // 同 lane **不同** id（另一 stint/另一 worker）→ 触发资格不满足（lane 已终态）
  const r2 = await autoSettleLane(
    { ctx: assemblyCtx(), store, root },
    { sessionId: S, batchId, lane: 'e1', workerSessionId: 'ws-g3b', trigger: AUTO_SETTLE_TRIGGERS.settleRequest },
  );
  assert.equal(r2.action, 'skipped');
  assert.equal(r2.reason, 'lane-terminal');
  assert.equal(
    store.readBatch(S, batchId).events.filter((e) => e.type === EVT_MEMBER_SETTLED && e.lane === 'e1' && e.from !== 'pending').length,
    2,
    '终态后零新增迁移',
  );
});

// ── H：工具面真加载（插件入口不炸 + 工具数不回归）──
test('H1: 插件入口真加载冒烟——createTools 工具数 26（本模块不新增对外工具；+1 来自 P3a control lane 的 batch_control；【2026-09-17 P1】+handoff_submit/handoff_view 常驻注册 ⇒ 24 → 26）且新增模块可被入口装配路径解析', async () => {
  const root = freshRoot('punky-as-h1-');
  const ctx = assemblyCtx();
  const bundle = createTools(ctx, { store: createStore(root), root, config: {}, readConfig: () => ({}) });
  assert.equal(bundle.tools.length, 27, '工具面数量 = 26（自动结算不新增/不删除对外工具；P3a control lane 另加 batch_control 一件；【2026-09-17 P1】+handoff_submit/handoff_view ⇒ 24 → 26）');
  const names = bundle.tools.map((t) => t.name);
  assert.ok(names.includes('swarm_report') && names.includes('member_settle'), '既有成员面工具零回归');
  // 入口模块可解析（装配期 will import installAutoSettle —— 这里自证模块面无循环依赖/无语法错）
  const mod = await import('../lib/engine/auto-settle.js');
  assert.equal(typeof mod.installAutoSettle, 'function');
  assert.equal(typeof mod.autoSettleLane, 'function');
});

// ── I：定案「audit 层 lane 不自动 merged」（分叉修复；本组**新增**，既有断言体逐字未改）────────────
//   分叉：审计产物写 `verdict: fail` 而本路把 lane 自动推到 `merged`，完成门的 `outcomeOf`
//   （`lib/state/gates.js:1220`）**纯由终态推导** ⇒ 完成门把 fail 读成 pass。
//   定案：保持「lane 终态 = 唯一真源」——audit 层 lane 的结算职责归 Leader（失败必须显式落 `failed`）；
//   本路只留一条 `auto.settle.skipped{reason:'audit-explicit-settle-required'}`，**不落 paused、不读产物正文**。
//   非 audit 层**零行为变化**（早退分支只命中 `layer === 'audit'`）。

/** 三层批（plan p1 / exec e1 / audit a1）+ 审计产物正文含**行首独立行** `verdict: <值>`
 *  （形态与债清 2 的 `audit/acceptance-report.md` 同）；p1/e1 走既有写路径到 merged，
 *  a1 置 running ⇒ 本组只检 audit 层的**结算职责**。 */
function seedVerdictFork(root, S, B, verdictLine) {
  const store = createStore(root);
  const plan = buildWavePlan({ batchId: B, tasks: threeTierTasks(['e1']) });
  store.createBatch(S, { batchId: B, wavePlan: plan, phase: 'running' });
  seedArtifacts(root, S, B, ['e1']);
  fs.writeFileSync(
    path.join(root, 'sessions', S, 'artifacts', B, 'audit', 'a1.md'),
    '# acceptance-report\n\n- 抽查 3 条引用\n\n' + verdictLine + '\n',
    'utf8',
  );
  for (const lane of ['p1', 'e1']) {
    store.setMember(S, B, lane, 'running');
    store.setMember(S, B, lane, 'review');
    store.setMember(S, B, lane, 'merged');
  }
  store.setMember(S, B, 'a1', 'running');
  return store;
}
/** 完成门读数（纯读 wavePlan + 成员态；**不读任何产物正文**）。 */
const completeGateOf = (root, store, S, B) => createGates(root).checkCompleteGate(store.readBatch(S, B));

test('I1: audit 层 lane 的结算职责移出本路——action=skipped/reason=audit-explicit-settle-required，lane 与相位均不变，未进判定段', async () => {
  const root = freshRoot('punky-as-i1-');
  const S = 'sess-i1';
  const store = seedVerdictFork(root, S, 'i1', 'verdict: fail');
  const ctx = assemblyCtx();
  const index = new Map([['ws-i1', { sessionId: S, batchId: 'i1', lane: 'a1' }]]);
  const reg = installAutoSettle(ctx, { store, dispatchIndex: index, root, logger: ctx.logger });
  try {
    await emitSubagentEnd(ctx, endInfo('ws-i1'));
    const b = store.readBatch(S, 'i1');
    assert.equal(b.lanes.a1, 'running', 'audit lane 不被自动结算（终态由 Leader 显式写）');
    assert.equal(b.phase, 'running', '职责转移不是失败 ⇒ 不落 paused、不推相位');
    const skipped = b.events.filter((e) => e.type === EVT_AUTO_SETTLE_SKIPPED);
    assert.equal(skipped.length, 1, '恰一条 auto.settle.skipped 留痕（可审计，不是静默丢弃）');
    assert.equal(skipped[0].lane, 'a1');
    assert.equal(skipped[0].reason, AUDIT_SETTLE_DEFERRAL_REASON, 'reason 自证职责转移（不写笼统 skipped）');
    assert.equal(b.events.filter((e) => e.type === EVT_AUTO_SETTLE_TRIGGERED).length, 0, '未进判定段（无 auto.settle.triggered）');
    assert.equal(b.events.filter((e) => e.type === EVT_AUTO_SETTLE_PAUSED).length, 0, '零停轮事件');
    assert.equal(
      b.events.filter((e) => e.type === EVT_MEMBER_SETTLED && e.lane === 'a1' && e.from !== 'pending').length,
      0,
      'audit lane 零结算迁移（seed 的 pending→running 不计）',
    );
  } finally {
    reg.dispose();
  }
});

test('I2: 非 audit 层零行为变化——同夹具的 exec 层 lane ⇒ action=merged（与 A/B/G 组逐字同路）', async () => {
  const root = freshRoot('punky-as-i2-');
  const S = 'sess-i2';
  const store = seedBatch(root, S, 'i2');
  const r = await autoSettleLane({ ctx: assemblyCtx(), store, root }, {
    sessionId: S, batchId: 'i2', lane: 'e1', workerSessionId: 'ws-i2',
    stopReason: 'completed', trigger: AUTO_SETTLE_TRIGGERS.subagentEnd,
  });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'merged', '早退分支只命中 audit 层 ⇒ exec 层逐字不变');
  const b = store.readBatch(S, 'i2');
  assert.equal(b.lanes.e1, 'merged');
  assert.equal(b.events.filter((e) => e.type === EVT_AUTO_SETTLE_SKIPPED).length, 0, 'exec 层零职责转移留痕');
  const settled = b.events.filter((e) => e.type === EVT_MEMBER_SETTLED && e.lane === 'e1' && e.from !== 'pending');
  assert.deepEqual(settled.map((e) => e.from + '->' + e.to), ['running->review', 'review->merged'], '经 review 中转（状态机强制，未跳门禁）');
});

test('I3: 职责转移留痕**不进幂等链**——连触 3 次 ⇒ skipped 累计 3、永不判 already-settled', async () => {
  const root = freshRoot('punky-as-i3-');
  const S = 'sess-i3';
  const store = seedVerdictFork(root, S, 'i3', 'verdict: fail');
  const outer = [];
  for (const id of ['ws-i3-1', 'ws-i3-2', 'ws-i3-3']) {
    outer.push(await autoSettleLane({ ctx: assemblyCtx(), store, root }, {
      sessionId: S, batchId: 'i3', lane: 'a1', workerSessionId: id,
      stopReason: 'completed', trigger: AUTO_SETTLE_TRIGGERS.settleRequest,
    }));
  }
  assert.deepEqual(outer.map((r) => r.action), ['skipped', 'skipped', 'skipped'], '三次均为职责转移（不是错误）');
  assert.deepEqual(outer.map((r) => r.reason), [AUDIT_SETTLE_DEFERRAL_REASON, AUDIT_SETTLE_DEFERRAL_REASON, AUDIT_SETTLE_DEFERRAL_REASON]);
  const b = store.readBatch(S, 'i3');
  const skipped = b.events.filter((e) => e.type === EVT_AUTO_SETTLE_SKIPPED);
  assert.equal(skipped.length, 3, '每次触发各留一次痕（不进幂等链 ⇒ 恰 3 条，且不为 0）');
  assert.equal(
    skipped.filter((e) => e.reason === 'already-settled').length, 0,
    '**永不**判 already-settled（否则 Leader 结算前的可见性被幂等键吞掉）',
  );
  assert.equal(b.lanes.a1, 'running', '三次触发零成员态变化');
  assert.equal(hasAutoSettleRecord(b, 'a1', 'ws-i3-1'), false, '幂等判据单点亦不计该族留痕');
});

test('I4: 层判定单点 isAuditLayerLane——仅 `layer === "audit"` 命中；缺失/非法层**不作为 audit**（保守零行为变化）', () => {
  const at = (tasks, lane = 'x') => isAuditLayerLane({ wavePlan: [{ wave: 1, tasks }] }, lane);
  assert.equal(at([{ id: 'x', layer: 'audit' }]), true, 'audit 层命中');
  assert.equal(at([{ id: 'x', layer: 'exec' }]), false, 'exec 层不命中');
  assert.equal(at([{ id: 'x', layer: 'plan' }]), false, 'plan 层不命中');
  assert.equal(at([{ id: 'x' }]), false, '层**缺失** ⇒ 不作为 audit（仍走既有全自动路）');
  assert.equal(at([{ id: 'x', layer: 'OTHERS' }]), false, '层**非法** ⇒ 不作为 audit（保守口径）');
  assert.equal(at([{ id: 'y', layer: 'audit' }]), false, 'lane 名不匹配 ⇒ 不命中');
  assert.equal(isAuditLayerLane({ wavePlan: [] }, 'x'), false, '无 wavePlan 任务 ⇒ 不命中');
  assert.equal(isAuditLayerLane(null, 'x'), false, '空批 ⇒ 不命中（不抛错）');
});

test('I5: 【专门用例·分叉关闭】audit 产物含行首 `verdict: fail` ⇒ 批**不得**被判为可完成（改前此处 ok:true）', async () => {
  const root = freshRoot('punky-as-i5-');
  const S = 'sess-i5';
  const store = seedVerdictFork(root, S, 'i5', 'verdict: fail');
  const r = await autoSettleLane({ ctx: assemblyCtx(), store, root }, {
    sessionId: S, batchId: 'i5', lane: 'a1', workerSessionId: 'ws-i5',
    stopReason: 'completed', trigger: AUTO_SETTLE_TRIGGERS.subagentEnd,
  });
  assert.equal(r.action, 'skipped', 'audit lane 不被自动 merged ⇒ 分叉的**写点**被堵');
  const g1 = completeGateOf(root, store, S, 'i5');
  assert.equal(g1.ok, false, 'audit lane 未终态 ⇒ 完成门不得判可完成（改前此处 ok:true —— 分叉活证据）');
  assert.equal(g1.code, 'GATE_EXIT_PENDING_AUDIT', '未终态走既有码（零新增拒绝码）');
  assert.deepEqual(g1.pending, ['a1']);
  // Leader 显式结算（失败必须带非空 note —— 既有写路径强制，本改动零新参数）
  store.setMember(S, 'i5', 'a1', 'review');
  assert.throws(
    () => store.setMember(S, 'i5', 'a1', 'failed'),
    /GATE_SETTLE_NOTE_MISSING/,
    'review→failed 缺 note 被既有写路径拒（(b) 契约零新参数即已满足）',
  );
  store.setMember(S, 'i5', 'a1', 'failed', 'artifact-verdict: fail（Leader 显式结算）');
  const g2 = completeGateOf(root, store, S, 'i5');
  assert.equal(g2.ok, false, '显式 failed ⇒ 完成门判拒');
  assert.equal(g2.code, 'GATE_COMPLETE_AUDIT_FAILED', '拒码为既有码（未新增 GATE_*）');
  assert.deepEqual(g2.offenders, [{ lane: 'a1', state: 'failed' }], 'offenders 由**成员态**推出（不解析产物正文）');
});

test('I6: 【专门用例·同判据回归】`verdict: pass` ⇒ 完成门判定与改前逐字一致（显式 merged 放行、exec 自动路照旧）', async () => {
  const root = freshRoot('punky-as-i6-');
  const S = 'sess-i6';
  const store = seedVerdictFork(root, S, 'i6', 'verdict: pass');
  const r = await autoSettleLane({ ctx: assemblyCtx(), store, root }, {
    sessionId: S, batchId: 'i6', lane: 'a1', workerSessionId: 'ws-i6',
    stopReason: 'completed', trigger: AUTO_SETTLE_TRIGGERS.subagentEnd,
  });
  assert.equal(r.action, 'skipped', '职责转移与产物裁决无关（引擎**不读** `verdict:` 行 ⇒ pass 也不自动 merged）');
  assert.equal(completeGateOf(root, store, S, 'i6').code, 'GATE_EXIT_PENDING_AUDIT', 'Leader 未结算前不得判可完成');
  store.setMember(S, 'i6', 'a1', 'review');
  store.setMember(S, 'i6', 'a1', 'merged', 'artifact-verdict: pass');
  const g = completeGateOf(root, store, S, 'i6');
  assert.equal(g.ok, true, '白名单 ∩{pass,skip} 的既有判定逐字不变（merged 放行 —— 与改前同判据）');
});

