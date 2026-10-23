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
import { threeTierTasks, seedArtifacts, assemblyCtxOpts, tempRoot, writeRuntime, assemblyCtxWeb } from './helpers/gate-fixture.mjs';
import {
  EVT_AUTO_SETTLE_TRIGGERED, EVT_AUTO_SETTLE_PAUSED, EVT_AUTO_SETTLE_SKIPPED,
  EVT_MEMBER_SETTLED, EVT_BATCH_PHASE, EVT_MEMBER_DISPATCH, EVT_SWARM_REPORT,
} from '../lib/state/event-types.js';
import {
  AUTO_SETTLE_SUBAGENT_END, AUTO_SETTLE_TRIGGERS, DEFAULT_ON_FAIL, AUDIT_SETTLE_DEFERRAL_REASON,
  installAutoSettle, autoSettleLane, requestAutoSettle, settleIdOf, hasAutoSettleRecord, isAuditLayerLane,
} from '../lib/engine/auto-settle.js';
import { createTools } from '../lib/tools/register.js';
import { createCoreTools } from '../lib/tools/core.js';
// J 组（停用开关）追加的只读依赖：配置键白名单校验（L-AC-12）+ Leader broadcast 取件（L-AC-6）
import { validateOverlay, ALLOWED_TOP_KEYS } from '../lib/hot/config-watch.js';
import { mailboxRootOf, REPORT_CHANNEL } from '../lib/engine/dispatch.js';
import { readUnacked } from '../lib/comms/mailbox.js';
// J8/J9（R-5 热更 + boot 对账）需要**装配级**驱动：`apply` + runtime.json 热写
//   （写法镜像 `test/watch-hotconfig.test.js` / `test/watch-bootoverlay.test.js`）
import { apply } from '../lib/index.js';

// ── 装配级 fake ctx：`assemblyCtxOpts()` `on` 项存 `{ fn, opts }`（取自 'helpers/gate-fixture.mjs'；F4 收敛，原 11 份同名副本）
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
  const root = tempRoot('punky-as-a1-');
  const ctx = assemblyCtxOpts();
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
  const root = tempRoot('punky-as-a2-');
  const reg = installAutoSettle({ logger: console }, { store: createStore(root), dispatchIndex: new Map() });
  assert.equal(reg.installed, false);
  assert.equal(typeof reg.reason, 'string');
  assert.doesNotThrow(() => reg.dispose());
});

// ── B：主路真触发（`subagent/end` → 引擎自动结算到 merged，全程无人工 member_settle）──
test('B1: 主路——running lane + completed 事件 ⇒ 自动 running→review→merged（经 review 中转，不跳门禁）+ 事件留痕', async () => {
  const root = tempRoot('punky-as-b1-');
  const S = 'sess-b1';
  const store = seedBatch(root, S, 'b1');
  const ctx = assemblyCtxOpts();
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
  const root = tempRoot('punky-as-b2-');
  const S = 'sess-b2';
  const store = seedBatch(root, S, 'b2');
  const ctx = assemblyCtxOpts();
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
  const root = tempRoot('punky-as-c1-');
  const S = 'sess-c1';
  const store = seedBatch(root, S, 'c1');
  const ctx = assemblyCtxOpts();
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
  const root = tempRoot('punky-as-c2-');
  const S = 'sess-c2';
  const store = seedBatch(root, S, 'c2');
  const ctx = assemblyCtxOpts();
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
  const root = tempRoot('punky-as-c3-');
  const S = 'sess-c3';
  const store = seedBatch(root, S, 'c3');
  const ctx = assemblyCtxOpts();
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
  const root = tempRoot('punky-as-d1-');
  const S = 'sess-d1';
  const store = seedBatch(root, S, 'd1');
  const ctx = assemblyCtxOpts();
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
    // 【2026-09-24 用户裁决：关闭幂等闸 skipped】第二路仍 no-op，但**不再落** skipped 留痕（纯噪音）
    assert.equal(skipped.length, 0, '第二路 no-op：幂等闸不落 skipped 留痕（噪音已关闭）');
  } finally {
    reg.dispose();
  }
});

test('D2: 跨重启幂等（同批 JSON 重放）——新监听器实例 + 同一已结算 lane ⇒ 不重复结算', async () => {
  const root = tempRoot('punky-as-d2-');
  const S = 'sess-d2';
  const store = seedBatch(root, S, 'd2');
  const index = new Map([['ws-d2', { sessionId: S, batchId: 'd2', lane: 'e1' }]]);
  const ctx1 = assemblyCtxOpts();
  const reg1 = installAutoSettle(ctx1, { store, dispatchIndex: index, root, logger: ctx1.logger });
  await emitSubagentEnd(ctx1, endInfo('ws-d2'));
  reg1.dispose();
  const before = store.readBatch(S, 'd2');
  // 进程重启 = 新 store 实例 + 新监听器（判据只来自批次 JSON）
  const store2 = createStore(root);
  const ctx2 = assemblyCtxOpts();
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
  const root = tempRoot('punky-as-d3-');
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
  const root = tempRoot('punky-as-e1-');
  const S = 'sess-e1';
  const store = seedBatch(root, S, 'e1', { lane: 'e1' });
  const ctx = assemblyCtxOpts();
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
  const root = tempRoot('punky-as-e2-');
  const S = 'sess-e2';
  const store = seedBatch(root, S, 'e2', { lane: 'e1' });
  fs.rmSync(path.join(root, 'sessions', S, 'artifacts', 'e2', 'exec', 'e1.md'));
  const ctx = assemblyCtxOpts();
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
  const root = tempRoot('punky-as-f1-');
  const S = 'sess-f1';
  const store = seedBatch(root, S, 'f1');
  store.appendEvent(S, 'f1', EVT_MEMBER_DISPATCH, { lane: 'e1', workerSessionId: 'ws-f1' });
  const r = await requestAutoSettle({ ctx: assemblyCtxOpts(), store, root }, { workerSessionId: 'ws-f1', reason: 'worker settle-request' });
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
  const root = tempRoot('punky-as-f2-');
  const S = 'sess-f2';
  const store = seedBatch(root, S, 'f2');
  const r = await requestAutoSettle({ ctx: assemblyCtxOpts(), store, root }, { workerSessionId: 'ws-unbound' });
  assert.equal(r.ok, false);
  assert.equal(r.action, 'unbound');
  assert.equal(store.readBatch(S, 'f2').lanes.e1, 'running', '未绑定零状态变化');
  assert.equal(settleEventsOf(store, S, 'f2').length, 0, '未绑定零事件');
});

test('F3: 双路同时到达同一 lane ⇒ 单次结算（第二条经幂等键 no-op，无冲突事件、无非法迁移）', async () => {
  const root = tempRoot('punky-as-f3-');
  const S = 'sess-f3';
  const store = seedBatch(root, S, 'f3');
  store.appendEvent(S, 'f3', EVT_MEMBER_DISPATCH, { lane: 'e1', workerSessionId: 'ws-f3' });
  const ctx = assemblyCtxOpts();
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
    assert.equal(b.events.filter((e) => e.type === EVT_AUTO_SETTLE_SKIPPED).length, 0, '第二路 no-op：幂等闸不落 skipped 留痕');
    assert.equal(b.phase, 'running', '无非法相位迁移');
  } finally {
    reg.dispose();
  }
});

test('F4: swarm_report(settle-request) 工具面接线自证——core 工具存在且触发兼底判定（防「模块在、工具没接」）', async () => {
  const root = tempRoot('punky-as-f4-');
  const S = 'sess-f4';
  const store = seedBatch(root, S, 'f4');
  store.appendEvent(S, 'f4', EVT_MEMBER_DISPATCH, { lane: 'e1', workerSessionId: 'ws-f4' });
  const ctx = assemblyCtxOpts();
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
  const root = tempRoot('punky-as-g1-');
  const S = 'sess-g1';
  const store = seedBatch(root, S, 'g1');
  const ctx = assemblyCtxOpts();
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
  const root = tempRoot('punky-as-g2-');
  const S = 'sess-g2';
  const store = seedBatch(root, S, 'g2');
  assert.equal(DEFAULT_ON_FAIL, 'pause');
  const r = await autoSettleLane(
    { ctx: assemblyCtxOpts(), store, root },
    { sessionId: S, batchId: 'g2', lane: 'e1', workerSessionId: 'ws-g2', trigger: AUTO_SETTLE_TRIGGERS.subagentEnd },
  );
  assert.equal(r.ok, true);
  assert.equal(r.action, 'merged');
  assert.equal(store.readBatch(S, 'g2').lanes.e1, 'merged');
});

test('G3: 终态 lane 再触发 ⇒ skipped（触发资格：命中 lane 须非终态），幂等键按 (lane, id) 判定', async () => {
  const root = tempRoot('punky-as-g3-');
  const S = 'sess-g3';
  const store = seedBatch(root, S, 'g3');
  const batchId = 'g3';
  const r1 = await autoSettleLane(
    { ctx: assemblyCtxOpts(), store, root },
    { sessionId: S, batchId, lane: 'e1', workerSessionId: 'ws-g3a', trigger: AUTO_SETTLE_TRIGGERS.settleRequest },
  );
  assert.equal(r1.action, 'merged');
  // 同 lane **不同** id（另一 stint/另一 worker）→ 触发资格不满足（lane 已终态）
  const r2 = await autoSettleLane(
    { ctx: assemblyCtxOpts(), store, root },
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

// ── H：工具面真加载（插件入口不炸 + 成员面工具零回归；总数面权威见 test/tools.test.js 冻结名单）──
test('H1: 插件入口真加载冒烟——createTools 可装配且新增模块可被入口装配路径解析', async () => {
  const root = tempRoot('punky-as-h1-');
  const ctx = assemblyCtxOpts();
  const bundle = createTools(ctx, { store: createStore(root), root, config: {}, readConfig: () => ({}) });
  // 【R-1/T-10 · 2026-10-09 批 `engine-techdebt-cleanup-r2-20261008`】原字面量总数断言
  //   原「工具面数量断言（length 字面量 + 旧计数叙事）」已删：
  //   ① `bundle.tools` 是 `createTools` 在给定 ctx/config 下**实际放行**的工具面（受 modeGate / config /
  //      宿主能力位影响），与 `SUITE_TOOLS`（注册表全集 38）**不是同一集合**；
  //   ② 该总数面的**唯一权威** = `test/tools.test.js` 的冻结名单 `TOOL_NAMES`（精确集合断言 + 差集诊断）；
  //   ③ 本用例**被检面** = 插件入口真加载 + 成员面工具零回归（下一行），与总数无关（防双权威漂移）。
  const names = bundle.tools.map((t) => t.name);
  assert.ok(names.includes('swarm_report') && names.includes('member_settle'), '既有成员面工具零回归');
  // 入口模块可解析（装配期 will import installAutoSettle —— 这里自证模块面无循环依赖/无语法错）
  const mod = await import('../lib/engine/auto-settle.js');
  assert.equal(typeof mod.installAutoSettle, 'function');
  assert.equal(typeof mod.autoSettleLane, 'function');
});

// ── I：定案「audit 层 lane 不自动 merged」（分叉修复；本组**新增**，既有断言体逐字未改）────────────
//   分叉：审计产物写 `verdict: fail` 而本路把 lane 自动推到 `merged`，完成门的 `outcomeOf`
//   （`lib/state/gates/complete.js` 完成门内局部 `outcomeOf`；【2026-10-23 · 批 punky-closeout-20261023 C5 同步】
//   原注释引 `lib/state/gates.js:1220` —— 该文件不存在、`gates.ts` 实为 303 行且无此符号 ⇒ 属死锚点，
//   与 lib 侧同批改指符号）**纯由终态推导** ⇒ 完成门把 fail 读成 pass。
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
  const root = tempRoot('punky-as-i1-');
  const S = 'sess-i1';
  const store = seedVerdictFork(root, S, 'i1', 'verdict: fail');
  const ctx = assemblyCtxOpts();
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
  const root = tempRoot('punky-as-i2-');
  const S = 'sess-i2';
  const store = seedBatch(root, S, 'i2');
  const r = await autoSettleLane({ ctx: assemblyCtxOpts(), store, root }, {
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
  const root = tempRoot('punky-as-i3-');
  const S = 'sess-i3';
  const store = seedVerdictFork(root, S, 'i3', 'verdict: fail');
  const outer = [];
  for (const id of ['ws-i3-1', 'ws-i3-2', 'ws-i3-3']) {
    outer.push(await autoSettleLane({ ctx: assemblyCtxOpts(), store, root }, {
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
  const root = tempRoot('punky-as-i5-');
  const S = 'sess-i5';
  const store = seedVerdictFork(root, S, 'i5', 'verdict: fail');
  const r = await autoSettleLane({ ctx: assemblyCtxOpts(), store, root }, {
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
  const root = tempRoot('punky-as-i6-');
  const S = 'sess-i6';
  const store = seedVerdictFork(root, S, 'i6', 'verdict: pass');
  const r = await autoSettleLane({ ctx: assemblyCtxOpts(), store, root }, {
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

// ── J：auto-settle **停用开关**（2026-10-09 批 `auto-settle-disable-switch-20261009`）──────────────
//   开关形态 = `config.autoSettle.enabled`（顶层键）；判据源 = `plan/autosettle-switch-spec.md` §6
//   （L-AC-1..L-AC-14）。本组覆盖 L-AC-1..L-AC-12（L-AC-13 热更端到端 / L-AC-14 导出表 diff 属验收矩阵，
//   登记为交接项交 Tester 承接）。
//   事实源纪律同 A/B/G/I 组：断言一律读 `store.readBatch` 的批次 JSON（**不读模块内部状态**）。
//   ⚠ 本组的存在理由（判据源 RK-1「**半停用**」= 本形态头号坑）：只证「主路不装」是不够的——必须**同时**
//     证明「兼底路回报照发」且「兼底路不再结算」；只落其一 ⇒ 开关形同虚设（J4+J5 分别压两侧）。
/** 停用留痕的 `reason` 字面量：与 `lib/engine/auto-settle.js` 内 `AUTO_SETTLE_DISABLED_REASON` 同值。
 *  该常量**刻意不导出**（判据源 L-AC-14 要求导出符号净增 0）⇒ 测试侧按同字面量断言。 */
const DISABLED_REASON = 'auto-settle-disabled';

test('J1: 【R-1 缺省兼容 · L-AC-1】未声明开关键 ⇒ 主路照装（installed:true / 恰 1 条 subagent/end / opts={global:true} / count()=0）', () => {
  const root = tempRoot('punky-as-j1-');
  const ctx = assemblyCtxOpts();
  // 现状调用形态逐字同（`lib/index.js` 装配点去掉新键后的原样：deps **不含**任何开关键）
  const reg = installAutoSettle(ctx, { store: createStore(root), dispatchIndex: new Map(), root, logger: ctx.logger });
  try {
    assert.equal(reg.installed, true, '缺省（undefined）⇒ 等价 true（R-1 向后兼容）');
    const hooks = [...(ctx.listeners.get(AUTO_SETTLE_SUBAGENT_END) ?? [])];
    assert.equal(hooks.length, 1, '恰一条 subagent/end 订阅');
    assert.deepEqual(hooks[0].opts, { global: true }, 'global 硬要求不变（C-4：缺则被 scope 化的 ctx 漏收）');
    assert.equal(reg.count(), 0, 'count() 初始为 0');
  } finally {
    reg.dispose();
    assert.equal((ctx.listeners.get(AUTO_SETTLE_SUBAGENT_END) ?? []).size, 0, 'dispose 退订（幂等）');
  }
});

test('J2: 【R-1 · L-AC-2/L-AC-3】缺省 ≡ 显式 true；7 取值采样只有 false 命中停用（非布尔/假值不得越权关停）', () => {
  const mountOf = (enabled) => {
    const ctx = assemblyCtxOpts();
    const deps = { store: createStore(tempRoot('punky-as-j2-')), dispatchIndex: new Map(), root: '/x', logger: ctx.logger };
    if (enabled !== undefined) deps.enabled = enabled; // `undefined` 走「键不出现」形态
    const reg = installAutoSettle(ctx, deps);
    const shape = {
      installed: reg.installed,
      // 停用 ⇒ 该事件从未注册过 ⇒ `get()` 返回 undefined（用 `?.size ?? 0`，不能对 `?? []` 取 `.size`）
      listeners: ctx.listeners.get(AUTO_SETTLE_SUBAGENT_END)?.size ?? 0,
      count: reg.count(),
    };
    reg.dispose();
    return shape;
  };
  const absent = mountOf(undefined);
  const explicitTrue = mountOf(true);
  assert.deepEqual(explicitTrue, absent, 'L-AC-2：显式 true 与缺省的挂载形态差异为 0');
  assert.deepEqual(absent, { installed: true, listeners: 1, count: 0 }, '缺省 = 启用 + 恰 1 条订阅');
  // L-AC-3：7 取值采样（只有显式 false 停用），停用命中恰 1
  const samples = [false, undefined, null, 0, '', 'false', 'no'];
  let disabledHits = 0;
  for (const v of samples) {
    const s = mountOf(v);
    if (v === false) {
      assert.equal(s.installed, false, '显式 false ⇒ 停用');
      assert.equal(s.listeners, 0, '停用 ⇒ 零订阅');
      disabledHits += 1;
    } else {
      assert.equal(s.installed, true, '取值 ' + JSON.stringify(v) + ' **不得**越权关停（RK-3：禁真值判断）');
      assert.equal(s.listeners, 1);
    }
  }
  assert.equal(disabledHits, 1, '采样点 7、停用命中 1（=== false 严格判定）');
});

test('J3: 【R-2 ① · L-AC-4/L-AC-5/L-AC-10】enabled:false ⇒ 零订阅 + reason 自证可辨 + count()=0 + dispose() 不抛 + 停用日志不谎报 mounted', async () => {
  const root = tempRoot('punky-as-j3-');
  const S = 'sess-j3';
  const store = seedBatch(root, S, 'j3');
  const ctx = assemblyCtxOpts();
  const reg = installAutoSettle(ctx, {
    enabled: false, store, root,
    dispatchIndex: new Map([['ws-j3', { sessionId: S, batchId: 'j3', lane: 'e1' }]]),
    logger: ctx.logger,
  });
  assert.equal(reg.installed, false, '停用 ⇒ installed:false（真实挂载态，非降级伪装）');
  assert.equal(typeof reg.reason, 'string');
  assert.ok(reg.reason.length > 0, 'R-2 ①：reason 非空字符串');
  assert.equal(reg.reason, DISABLED_REASON, 'reason 自证为停用（约束 8：禁笼统 skipped）');
  assert.notEqual(reg.reason, 'ctx.on unavailable or store missing', 'C-6：与宿主能力缺失成因**可辨**');
  assert.equal(ctx.listeners.get(AUTO_SETTLE_SUBAGENT_END)?.size ?? 0, 0, 'L-AC-4：主路零订阅');
  assert.equal(reg.count(), 0, 'L-AC-4：count() === 0');
  assert.doesNotThrow(() => reg.dispose(), 'L-AC-4：dispose() 不抛（返回形态同形，C-5）');
  // R-3 / L-AC-10 非静默：≥1 条 info 含配置键名或停用字样；**0** 条含旧谎报行
  const infos = ctx.calls.info;
  assert.ok(infos.some((l) => /autoSettle|disabled|停用/.test(l)), '停用必留痕（≥1 条 info）');
  assert.equal(infos.filter((l) => l.includes('auto-settle mounted')).length, 0, '不得谎报 mounted（RK-4）');
  assert.equal(ctx.calls.warn.length, 0, '停用不是异常路径 ⇒ 零 warn 噪音');
  // L-AC-5：停用态即使人工投递 subagent/end 也零动作（订阅集合应为空；构造等价于「总线上仍有他人监听」时本插件不回）
  const before = store.readBatch(S, 'j3').events.length;
  await emitSubagentEnd(ctx, endInfo('ws-j3'));
  const b = store.readBatch(S, 'j3');
  assert.equal(b.lanes.e1, 'running', 'L-AC-5：lane 零状态变化');
  assert.equal(b.phase, 'running', 'L-AC-5：批次相位保持 running（R-3：不得静默改相位）');
  assert.equal(settleEventsOf(store, S, 'j3').length, 0, 'L-AC-5：auto.settle.* 事件计数 0');
  assert.equal(b.events.length, before, 'L-AC-5：事件流零新增');
});

test('J4: 【R-2 ② 回报全留 · L-AC-6】停用时 swarm_report(settle-request) 投递面一字不少：delivered + swarm.report 事件 + Leader broadcast 各恰 1', async () => {
  const root = tempRoot('punky-as-j4-');
  const S = 'sess-j4';
  const cfg = { autoSettle: { enabled: false } };
  const store = seedBatch(root, S, 'j4');
  store.appendEvent(S, 'j4', EVT_MEMBER_DISPATCH, { lane: 'e1', workerSessionId: 'ws-j4' });
  const ctx = assemblyCtxOpts();
  const tools = createCoreTools(ctx, { store, root, config: cfg, readConfig: () => cfg });
  const rep = tools.find((t) => t.name === 'swarm_report');
  assert.ok(rep, 'swarm_report 仍注册（既有轨道零回归）');
  const exec = { name: 'swarm_report', arguments: {}, agent: { session: { id: 'ws-j4' } } };
  const out = await rep.execute({ type: 'settle-request', summary: 'lane 交付完成，请求结算', artifactPath: 'exec/e1.md' }, exec);
  assert.equal(out.delivered, true, '★回报仍投递（R-2 ②：用户原话「成员只能使用 swarm_report **回报**」⇒ 回报通道必须活）');
  assert.equal(out.eventWritten, true, '批事件照写');
  assert.equal(out.batchId, 'j4', '目标批次可核（绑定 lane e1 的批次）');
  assert.equal(out.lane, 'e1');
  assert.equal(out.settle, undefined, 'L-AC-7：返回值不含 settle 键（或为 null）—— 不新增输出键（C-12）');
  const b = store.readBatch(S, 'j4');
  assert.equal(b.events.filter((e) => e.type === EVT_SWARM_REPORT).length, 1, 'L-AC-6：批事件 swarm.report 恰 1 条');
  // L-AC-6：Leader 通道（broadcast，`REPORT_CHANNEL.leader`）收到恰 1 条
  const inbox = readUnacked(mailboxRootOf(root, S, 'j4'), { type: REPORT_CHANNEL.leader });
  assert.equal(inbox.length, 1, 'L-AC-6：Leader broadcast 恰 1 条');
  // `mailbox.send(root, box, message, meta)` ⇒ channel 在 `box`、载荷在 `message`（meta 为 null）
  assert.equal(inbox[0].box.type, REPORT_CHANNEL.leader, 'Leader 通道 = broadcast（取件箱可核）');
  assert.equal(inbox[0].message.kind, 'settle-request', '报文 kind 可核（回报类型不变）');
  assert.equal(inbox[0].message.lane, 'e1', '报文带 lane（成员回报口径不变）');
});

test('J5: 【R-2 ② 不结算 + R-3 留痕 · L-AC-7/L-AC-8/L-AC-9】停用 ⇒ lane 仍 running、判定器零调用；跳过留痕连触 3 次各留一次（不进幂等链）', async () => {
  const root = tempRoot('punky-as-j5-');
  const S = 'sess-j5';
  const cfg = { autoSettle: { enabled: false } };
  const store = seedBatch(root, S, 'j5');
  store.appendEvent(S, 'j5', EVT_MEMBER_DISPATCH, { lane: 'e1', workerSessionId: 'ws-j5' });
  const ctx = assemblyCtxOpts();
  const tools = createCoreTools(ctx, { store, root, config: cfg, readConfig: () => cfg });
  const rep = tools.find((t) => t.name === 'swarm_report');
  const exec = { name: 'swarm_report', arguments: {}, agent: { session: { id: 'ws-j5' } } };
  for (let i = 1; i <= 3; i += 1) {
    await rep.execute({ type: 'settle-request', summary: '第 ' + i + ' 次请求结算' }, exec);
  }
  const b = store.readBatch(S, 'j5');
  assert.equal(b.lanes.e1, 'running', '★L-AC-7：**不得** merged（半停用 = 判据源 RK-1 头号坑）');
  assert.equal(b.phase, 'running', 'R-3：停用不改相位（批保持 running）');
  assert.equal(b.events.filter((e) => e.type === EVT_AUTO_SETTLE_TRIGGERED).length, 0, 'L-AC-7：判定器零调用 ⇒ 零 auto.settle.triggered');
  assert.equal(b.events.filter((e) => e.type === EVT_AUTO_SETTLE_PAUSED).length, 0, 'L-AC-10 尾：零 auto.settle.paused');
  assert.equal(b.events.filter((e) => e.type === EVT_MEMBER_SETTLED && e.from !== 'pending').length, 0, 'L-AC-7：零结算迁移');
  // L-AC-8 / L-AC-9：跳过留痕每次各留一次（**不进幂等链**）
  const skips = b.events.filter((e) => e.type === EVT_AUTO_SETTLE_SKIPPED);
  assert.equal(skips.length, 3, 'L-AC-9：连触 3 次 ⇒ 留痕计数 === 3（**不得**为 1；该族不进幂等链）');
  for (const s of skips) {
    assert.equal(s.reason, DISABLED_REASON, 'L-AC-8：reason === auto-settle-disabled（自证）');
    assert.equal(s.trigger, AUTO_SETTLE_TRIGGERS.settleRequest, 'L-AC-8：trigger === settle-request（自证为兼底路）');
    assert.equal(s.lane, 'e1', 'L-AC-8：lane 可核');
  }
  assert.equal(b.events.filter((e) => e.type === EVT_AUTO_SETTLE_SKIPPED && e.reason === 'already-settled').length, 0, 'L-AC-9：already-settled 计数 0');
});

test('J6: 【R-5 白名单 · L-AC-12】autoSettle 过 validateOverlay（新顶层键不静默失效）；未登记顶层键仍被拒', () => {
  assert.equal(ALLOWED_TOP_KEYS.has('autoSettle'), true, 'autoSettle 已入 ALLOWED_TOP_KEYS（漏加 ⇒ 配置写了不生效且不报错，RK-2）');
  const ok = validateOverlay({ autoSettle: { enabled: false } });
  assert.equal(ok.ok, true, '正向：新键过校验');
  assert.deepEqual(ok.errors, [], '零 errors');
  const bad = validateOverlay({ autoSettleX: {} });
  assert.equal(bad.ok, false, '反向：未登记顶层键仍被拒（校验器未被放宽）');
  assert.ok(bad.errors[0].includes('unknown top-level key'), '拒因文案含 unknown top-level key');
});

test('J7: 【R-4 结算归位 · L-AC-11】停用后 Leader 两步经既有写路径收口；review→failed 空 note 仍被拒（既有强制零改动）', () => {
  const root = tempRoot('punky-as-j7-');
  const S = 'sess-j7';
  const store = seedBatch(root, S, 'j7');
  // 停用态下 lane 停在 running（J5 已证）；Leader 显式两步 = `member_status`/`member_settle` 的**同一写路径**
  //   （工具面 `lib/tools/member-tools.js` 亦经 `store.setMember`，无第二套判定）
  store.setMember(S, 'j7', 'e1', 'review');
  store.setMember(S, 'j7', 'e1', 'merged');
  const b = store.readBatch(S, 'j7');
  assert.deepEqual(
    b.events.filter((e) => e.type === EVT_MEMBER_SETTLED && e.lane === 'e1' && e.from !== 'pending').map((e) => e.from + '->' + e.to),
    ['running->review', 'review->merged'],
    'L-AC-11：两步序列 running->review->merged',
  );
  assert.equal(b.lanes.e1, 'merged', 'L-AC-11：lane 收口到 merged');
  // 既有强制逐字不变（C-13）：review→failed 必须带非空 note
  const store2 = seedBatch(root, 'sess-j7b', 'j7b');
  store2.setMember('sess-j7b', 'j7b', 'e1', 'review');
  assert.throws(
    () => store2.setMember('sess-j7b', 'j7b', 'e1', 'failed'),
    /GATE_SETTLE_NOTE_MISSING/,
    'review→failed 缺 note 仍被既有写路径拒（本次开关零新参数）',
  );
});

// ── J8/J9：R-5 生效方式（**热更** vs **boot 对账**）────────────────────────────────────────────
//   两例均为**装配级**（`apply` + `<root>/config/runtime.json` 真实落盘 + fs.watch 通道），
//   观察面 = 假 ctx 的 `listeners.get('subagent/end')`（= 主路订阅条数，2 ↔ 0 是**引擎主路面装没装**的直接读数）
//   + `ctx.calls.info` 热切留痕。等待窗口对齐 watch-hotconfig 先例（fs.watch → 防抖 300ms → reload → onChange）。
//   ⚠ 【2026-10-09 批 `swarm-report-wake-autodispatch-20261009` · 用户裁定 D-2 = 甲（准）】**计数口径等值反转**
//     （非删判据）：主路 `subagent/end` 自本批起**并行两路**订阅 —— ① 结算路（`installAutoSettle`）
//     + ② 唤醒路（`lib/index.js` 独立装配的 lane-wake）。两路均受同一 `autoSettle.enabled` 生效值同生共死
//     ⇒ 「1 ↔ 0」变为「2 ↔ 0」，**开关的读写语义与 L-AC-13 判据本身逐字不变**（只是主路订阅数由 1 变 2）。
//     判据源：`plan/survey-and-options.md` §待裁点回填 D-2（附三条件：仅取 Leader 句柄 / 不改结算逻辑 /
//     新增订阅独立且 dispose 可热切）。单路面（`installAutoSettle` 自身恰 1 条）由 A1/J1/J2/J3 逐字保留。
const hotSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOT_SETTLE = 300;   // 装配后余量
const HOT_SLEEP = 1000;   // 防抖 300ms + 事件 + 解析余量（先例 `watch-hotconfig.test.js:46`）
const subagentEndCount = (ctx) => ctx.listeners.get(AUTO_SETTLE_SUBAGENT_END)?.size ?? 0;

test('J8: 【R-5 热更生效 · L-AC-13】runtime.json 写 autoSettle.enabled:false ⇒ 主路订阅 1→0（无需重启）；写回 true ⇒ 0→1', async () => {
  const root = tempRoot('punky-as-j8-');
  writeRuntime(root, {}); // 预建 runtime.json（文件级 watch 需文件存在；初始 overlay {} 零变化）
  const { ctx } = assemblyCtxWeb();
  const disposer = apply(ctx, { root }); // 静态 config **不含** autoSettle ⇒ 缺省启用
  try {
    await hotSleep(HOT_SETTLE);
    assert.equal(subagentEndCount(ctx), 2, '装配后引擎主路面已挂（结算路 + 唤醒路两订阅；缺省 = 启用，R-1）');
    // true → false：热写即退订（**无需重启**）
    writeRuntime(root, { autoSettle: { enabled: false } });
    await hotSleep(HOT_SLEEP);
    assert.equal(subagentEndCount(ctx), 0, 'L-AC-13：热写 false ⇒ 订阅 1 → 0');
    assert.ok(
      ctx.calls.info.some((l) => l.includes('auto-settle disabled') && l.includes('autoSettle.enabled')),
      '热切停用留痕（含配置键名与停用字样）：' + ctx.calls.info.filter((l) => l.includes('auto-settle')).join(' || '),
    );
    assert.equal(ctx.calls.warn.length, 0, '停用热切不是异常路径 ⇒ 零 warn');
    // 等效重写（无生效变化）⇒ 零操作（幂等，RK-8：不抖动）
    ctx.calls.info.length = 0;
    writeRuntime(root, { autoSettle: { enabled: false } });
    await hotSleep(HOT_SLEEP);
    assert.equal(subagentEndCount(ctx), 0, '仍 0（不重复处置）');
    assert.equal(
      ctx.calls.info.filter((l) => l.includes('auto-settle')).length, 0,
      '等效重写 ⇒ 零 auto-settle 日志（无生效变化零操作）',
    );
    // false → true：重新订阅（恢复）
    writeRuntime(root, { autoSettle: { enabled: true } });
    await hotSleep(HOT_SLEEP);
    assert.equal(subagentEndCount(ctx), 2, 'L-AC-13：热写 true ⇒ 订阅 0 → 2（结算路 + 唤醒路一并恢复）');
    assert.ok(ctx.calls.info.some((l) => l.includes('auto-settle re-mounted')), '恢复热切留痕');
  } finally {
    disposer();
  }
});

test('J9: 【R-5 boot 对账】runtime.json **预置** autoSettle.enabled:false ⇒ 静态 config 缺省也不得漏停（防「重启后开关失效」）', async () => {
  const root = tempRoot('punky-as-j9-');
  // 持久策略：模拟「用户写好 runtime.json 后重启宿主」——静态 config 依然不含 autoSettle
  writeRuntime(root, { autoSettle: { enabled: false } });
  const { ctx } = assemblyCtxWeb();
  const disposer = apply(ctx, { root });
  try {
    await hotSleep(HOT_SETTLE);
    assert.equal(
      subagentEndCount(ctx), 0,
      'boot 对账生效：主路 0 订阅（缺此对账则「写了 false、重启后又挂上」= 本开关最危险的静默形态）',
    );
    assert.ok(
      ctx.calls.info.some((l) => l.includes('[boot-overlay]') && l.includes('auto-settle')),
      'boot 对账留痕带 [boot-overlay] tag（与热更路径可区分）：'
        + ctx.calls.info.filter((l) => l.includes('auto-settle')).join(' || '),
    );
    assert.equal(ctx.calls.info.filter((l) => l.includes('hot config: auto-settle disabled')).length, 1, '恰一次停用对账');
    assert.equal(ctx.calls.warn.length, 0, 'boot 对账零 warn（runtime.json 合法）');
    assert.equal(ctx.calls.error.length, 0, 'boot 对账零 error');
  } finally {
    disposer();
  }
});

