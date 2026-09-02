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

// D-1 方案 B 写侧登记点测试（m5a-d1-20260902 批次，独立文件——不触碰 governance-escalate.test.js 17 用例）。
// 覆盖：R1 提取纯函数（结构化 result 各形态）；R2 真实登记路径（member_status running 意图 → subagent
// post-execute → member.dispatch 事件落批 + dispatchIndex 可查）；R3 非 Manager 派发不登记（T16 语义保持）；
// R4 send_message 重复唤醒幂等（不重复登记）；R5 装配层端到端（apply 真实装配：登记 → 归属命中 → escalation
// 计数 → paused——读侧骨架零改动生效）；R6 装配注入 resolveBatchContext 显式路径（不经 member_status）。
// 标注（如实）：T20a/T21（governance-escalate.test.js）原用 member.dispatch 直写模拟「映射命中」前置——
// 语义 = escalation 关态零路径 / 记录抛错隔离，与登记点机制解耦；保持原样不改（直写 = 读侧 fixture 合法形态），
// 真实登记路径由本文件 R2/R5 覆盖。段边界：本文件零触碰 governance-escalate.test.js。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { EVT_MEMBER_DISPATCH, EVT_GOVERNANCE_REFUSAL, EVT_BATCH_GOVERNANCE_ESCALATE } from '../lib/state/event-types.js';
import { apply } from '../lib/index.js';
import { installDispatchRegistration, extractWorkerSessionId, DEFAULT_DISPATCH_TOOLS } from '../lib/bridge/dispatch-register.js';

// ── helpers（对齐 governance-escalate.test.js assemblyCtx / seedBatch 形态）──
function assemblyCtx() {
  const listeners = new Map();
  const calls = { info: [], warn: [], error: [] };
  const logger = {
    info: (...a) => calls.info.push(a.join(' ')),
    warn: (...a) => calls.warn.push(a.join(' ')),
    error: (...a) => calls.error.push(a.join(' ')),
  };
  const ctx = {
    listeners, calls, logger,
    tools: { register() {} },
    emit() {},
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => { listeners.get(event)?.delete(fn); };
    },
  };
  return ctx;
}
function freshRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function execOf(name, args, sessionId, extra = {}) {
  return {
    name,
    arguments: args,
    callId: 'call-' + name + '-' + Math.random().toString(36).slice(2, 8),
    agent: { session: { id: sessionId } },
    ...extra,
  };
}
// 批量 running 批预置（lane l1）——与 governance-escalate seedBatch 同源
function seedRunning(root, sessionId, batchId, lanes = ['l1']) {
  const aux = createStore(root);
  aux.createBatch(sessionId, { batchId, wavePlan: buildWavePlan({ batchId, tasks: lanes.map((id) => ({ id })) }), phase: 'running' });
  return aux;
}
// 派发工具 post-execute 结构化 result 形态（host ToolExecutionResult：value 内嵌工具返回值）
const subagentResult = (subagentId) => ({ isError: false, value: { kind: 'continuable', subagentId } });

// 依次派发全部 post listener（waterfall 语义：每个 listener pass-through 返回 next() 结果）
async function dispatchPostAll(ctx, exec, result) {
  const posts = [...(ctx.listeners.get('tools/post-execute') ?? [])];
  for (const p of posts) await p(exec, result, () => 'NEXT');
}

// ── R1：extractWorkerSessionId 纯函数（结构化 result 各形态）──
test('R1: extractWorkerSessionId——subagent continuable 取 subagentId；background/foreground 非会话 id 取 null；send_message 取 args；失败/未知形态 null', () => {
  // subagent continuable（host 结构化 value）
  assert.equal(extractWorkerSessionId(execOf('subagent', {}, 'm'), subagentResult('ws-1')), 'ws-1');
  // subagent_fork 同形态
  assert.equal(extractWorkerSessionId(execOf('subagent_fork', {}, 'm'), subagentResult('ws-f1')), 'ws-f1');
  // send_message：目标在 args.subagent_id（唤醒既有 worker）
  assert.equal(extractWorkerSessionId(execOf('send_message', { subagent_id: 'ws-2' }, 'm'), { isError: false, value: { messageId: 'm1' } }), 'ws-2');
  // 失败派发（isError）→ null（不登记）
  assert.equal(extractWorkerSessionId(execOf('subagent', {}, 'm'), { isError: true, error: { message: 'x' } }), null);
  // background jobId / foreground runId 非会话 id → null（无持久 worker 会话可归属，T16 静默）
  assert.equal(extractWorkerSessionId(execOf('subagent', {}, 'm'), { isError: false, value: { kind: 'background', jobId: 'job-1' } }), null);
  assert.equal(extractWorkerSessionId(execOf('subagent', {}, 'm'), { isError: false, value: { kind: 'foreground', runId: 'run-1', output: [] } }), null);
  // 无 result / 未知工具 → null
  assert.equal(extractWorkerSessionId(execOf('subagent', {}, 'm'), null), null);
  assert.equal(extractWorkerSessionId(execOf('bash', {}, 'm'), subagentResult('ws-x')), null);
  // 文本形态兜底（部分宿主 result 仅 content 文本）
  assert.equal(extractWorkerSessionId(execOf('subagent', {}, 'm'), { isError: false, content: 'started subagent ws-t1' }), 'ws-t1');
});

// ── R2：真实登记路径（member_status running 意图 → subagent post-execute → member.dispatch 事件落批 + dispatchIndex 可查）──
test('R2: installDispatchRegistration——member_status(running) 意图 → subagent post-execute → member.dispatch 事件落批、dispatchIndex 映射可查', async () => {
  const root = freshRoot('punky-dr2-');
  // 拓扑对齐：Manager 会话 = 批会话（member_status 未显式 session 时 sessionOf 回退 exec.agent.session.id，
  // 与 member_status 工具自身 setMember 定位同源——批文件须在 Manager 会话下）
  const aux = seedRunning(root, 'mgr-s', 'b-r2');
  const ctx = assemblyCtx();
  const index = new Map();
  const reg = installDispatchRegistration(ctx, { store: createStore(root), dispatchIndex: index, config: {}, logger: ctx.logger });
  assert.equal(reg.installed, true);
  assert.ok(ctx.listeners.has('tools/post-execute'), 'post listener 已挂载');
  try {
    // ① Manager 会话先 member_status(running)（0g 时序：先置 running 再派发 worker）
    const mgrExec = execOf('member_status', { batchId: 'b-r2', lane: 'l1', status: 'running' }, 'mgr-s');
    await dispatchPostAll(ctx, mgrExec, { isError: false, value: { batchId: 'b-r2', lane: 'l1', status: 'running' } });
    // ② Manager 会话 subagent 派发 worker → post-execute 返回 childId
    await dispatchPostAll(ctx, execOf('subagent', {}, 'mgr-s'), subagentResult('ws-r2a'));
    const b = aux.readBatch('mgr-s', 'b-r2');
    const dis = b.events.filter((e) => e.type === EVT_MEMBER_DISPATCH);
    assert.equal(dis.length, 1, 'member.dispatch 恰 1 条');
    assert.equal(dis[0].workerSessionId, 'ws-r2a');
    assert.equal(dis[0].lane, 'l1');
    // dispatchIndex 可查（与读侧骨架同一 Map，登记后立即命中）
    assert.deepEqual(index.get('ws-r2a'), { sessionId: 'mgr-s', batchId: 'b-r2', lane: 'l1' });
    assert.equal(reg.count(), 1);
    assert.equal(reg.pendingIntents().length, 0, '意图已消费（一次 running → 一次派发登记）');
  } finally {
    reg.dispose();
  }
});

// R2-b：意图 sessionId 显式指向批所在会话（Manager 会话 ≠ 批会话时，member_status 带 args.session）
test('R2b: member_status 显式 session 指向批会话 → 事件落对批、映射正确', async () => {
  const root = freshRoot('punky-dr2b-');
  const aux = seedRunning(root, 'sess-b', 'b-r2b');
  const ctx = assemblyCtx();
  const index = new Map();
  const reg = installDispatchRegistration(ctx, { store: createStore(root), dispatchIndex: index, config: {}, logger: ctx.logger });
  try {
    await dispatchPostAll(ctx, execOf('member_status', { session: 'sess-b', batchId: 'b-r2b', lane: 'l1', status: 'running' }, 'mgr-s'), { isError: false, value: {} });
    await dispatchPostAll(ctx, execOf('subagent', {}, 'mgr-s'), subagentResult('ws-r2b'));
    const b = aux.readBatch('sess-b', 'b-r2b');
    assert.equal(b.events.filter((e) => e.type === EVT_MEMBER_DISPATCH).length, 1);
    assert.deepEqual(index.get('ws-r2b'), { sessionId: 'sess-b', batchId: 'b-r2b', lane: 'l1' });
  } finally {
    reg.dispose();
  }
});

// ── R3：非 Manager 派发不登记（T16 语义：无 member_status 意图 → 零 member.dispatch、零副作用）──
test('R3: 未取到批上下文（无 member_status 意图，非 Manager 派发）→ 不登记（T16 静默降级）', async () => {
  const root = freshRoot('punky-dr3-');
  const aux = seedRunning(root, 'sess-b', 'b-r3');
  const ctx = assemblyCtx();
  const index = new Map();
  const reg = installDispatchRegistration(ctx, { store: createStore(root), dispatchIndex: index, config: {}, logger: ctx.logger });
  try {
    // 无前置 member_status(running)：Leader 直接 subagent（研究派发等非 Manager 场景）
    await dispatchPostAll(ctx, execOf('subagent', {}, 'leader-s'), subagentResult('ws-r3'));
    const b = aux.readBatch('sess-b', 'b-r3');
    assert.equal(b.events.filter((e) => e.type === EVT_MEMBER_DISPATCH).length, 0, '零 member.dispatch（T16）');
    assert.equal(index.has('ws-r3'), false, 'dispatchIndex 无映射');
    assert.equal(reg.count(), 0);
    assert.equal(ctx.calls.warn.filter((w) => w.includes('dispatch registration failed')).length, 0, '静默：零隔离 warn');
  } finally {
    reg.dispose();
  }
});

// ── R4：send_message 重复唤醒幂等（同一 worker 已登记 → 不重复 member.dispatch）──
test('R4: 已登记 worker 再次 send_message 唤醒 → 幂等跳过（不重复事件）', async () => {
  const root = freshRoot('punky-dr4-');
  const aux = seedRunning(root, 'sess-b', 'b-r4');
  const ctx = assemblyCtx();
  const index = new Map();
  const reg = installDispatchRegistration(ctx, { store: createStore(root), dispatchIndex: index, config: {}, logger: ctx.logger });
  try {
    // spawn 登记 ws-r4
    await dispatchPostAll(ctx, execOf('member_status', { session: 'sess-b', batchId: 'b-r4', lane: 'l1', status: 'running' }, 'mgr-s'), { isError: false, value: {} });
    await dispatchPostAll(ctx, execOf('subagent', {}, 'mgr-s'), subagentResult('ws-r4'));
    // 再次唤醒（send_message 同 worker）——意图已消费、且 dispatchIndex.has → 幂等跳过
    await dispatchPostAll(ctx, execOf('member_status', { session: 'sess-b', batchId: 'b-r4', lane: 'l1', status: 'running' }, 'mgr-s'), { isError: false, value: {} });
    await dispatchPostAll(ctx, execOf('send_message', { subagent_id: 'ws-r4', message: 'wake' }, 'mgr-s'), { isError: false, value: { messageId: 'm2' } });
    const b = aux.readBatch('sess-b', 'b-r4');
    assert.equal(b.events.filter((e) => e.type === EVT_MEMBER_DISPATCH && e.workerSessionId === 'ws-r4').length, 1, '同一 worker 仅 1 条登记事件');
    assert.equal(reg.count(), 1);
  } finally {
    reg.dispose();
  }
});

// ── R5：装配层端到端（apply 真实装配：登记 → 归属命中 → escalation 计数 → paused——读侧骨架零改动生效）──
test('R5: apply 装配端到端——真实登记路径（member_status running + subagent post-execute）→ worker refusal 归属批计数 → escalation paused', async () => {
  const root = freshRoot('punky-dr5-');
  const aux = seedRunning(root, 'sess-b', 'b-r5'); // running 批
  const ctx = assemblyCtx();
  const RULE_RM_RF = {
    id: 'R001',
    tools: ['bash'],
    match: { path: '/cmd', op: 'regex', pattern: 'rm -rf' },
    violations: [{ code: 'V001', category: 'hard', message: '强制删除命令被护栏禁止' }],
  };
  const disposer = apply(ctx, {
    root,
    governance: { hook: { enabled: true, rules: [RULE_RM_RF], escalation: { enabled: true, threshold: 3 } } },
  });
  try {
    // ① Manager ctx：member_status(running)（意图指向 sess-b/b-r5/l1）
    await dispatchPostAll(ctx, execOf('member_status', { session: 'sess-b', batchId: 'b-r5', lane: 'l1', status: 'running' }, 'mgr-s'), { isError: false, value: {} });
    // ② Manager ctx：subagent 派发 worker → 登记 ws-r5
    await dispatchPostAll(ctx, execOf('subagent', {}, 'mgr-s'), subagentResult('ws-r5'));
    const b0 = aux.readBatch('sess-b', 'b-r5');
    assert.equal(b0.events.filter((e) => e.type === EVT_MEMBER_DISPATCH).length, 1, '真实登记路径落批');
    // ③ worker 会话 3 次越界 → 归属命中（登记后立即命中同一 Map）→ 升级 paused
    const pre = [...(ctx.listeners.get('tools/pre-execute') ?? [])][0];
    for (let i = 0; i < 3; i++) {
      const out = await pre(execOf('bash', { cmd: 'rm -rf /data' }, 'ws-r5'), () => {});
      assert.equal(out.kind, 'deny');
    }
    const b1 = aux.readBatch('sess-b', 'b-r5');
    assert.equal(b1.phase, 'paused', '归属命中 + 计数达阈值 → escalation paused（读侧骨架零改动生效）');
    assert.equal(b1.events.filter((e) => e.type === EVT_BATCH_GOVERNANCE_ESCALATE).length, 1);
    assert.equal(b1.events.filter((e) => e.type === EVT_GOVERNANCE_REFUSAL).length, 3);
    // ④ 无登记的 worker（leader 直派研究 subagent）→ refusal 零归属（T16：批事件流零新增）
    await dispatchPostAll(ctx, execOf('subagent', {}, 'leader-s'), subagentResult('ws-r5-other'));
    const b2 = aux.readBatch('sess-b', 'b-r5');
    assert.equal(b2.events.filter((e) => e.type === EVT_MEMBER_DISPATCH && e.workerSessionId === 'ws-r5-other').length, 0);
  } finally {
    disposer();
  }
});

// ── R6：装配注入 resolveBatchContext 显式路径（不经 member_status 意图）──
test('R6: 装配注入 resolveBatchContext(exec) 显式返回批上下文 → 无 member_status 也登记', async () => {
  const root = freshRoot('punky-dr6-');
  const aux = seedRunning(root, 'sess-b', 'b-r6');
  const ctx = assemblyCtx();
  const index = new Map();
  // 注入解析器：任何 subagent 派发显式归属 sess-b/b-r6/l1（模拟宿主/编排层提供归属——方案 B 装配注入面）
  const injected = (exec, { workerSessionId }) => (exec.name === 'subagent' ? { sessionId: 'sess-b', batchId: 'b-r6', lane: 'l1', workerSessionId } : null);
  const reg = installDispatchRegistration(ctx, { store: createStore(root), dispatchIndex: index, config: {}, logger: ctx.logger, resolveBatchContext: injected });
  try {
    await dispatchPostAll(ctx, execOf('subagent', {}, 'leader-s'), subagentResult('ws-r6'));
    const b = aux.readBatch('sess-b', 'b-r6');
    assert.equal(b.events.filter((e) => e.type === EVT_MEMBER_DISPATCH).length, 1, '显式注入归属 → 登记');
    assert.deepEqual(index.get('ws-r6'), { sessionId: 'sess-b', batchId: 'b-r6', lane: 'l1' });
  } finally {
    reg.dispose();
  }
});

// R7：ctx.on 缺失 → inert 静默降级（宿主能力缺失不炸）
test('R7: ctx.on 缺失 → installDispatchRegistration inert（installed:false、零副作用）', () => {
  const root = freshRoot('punky-dr7-');
  const reg = installDispatchRegistration({ logger: console }, { store: createStore(root), dispatchIndex: new Map(), config: {} });
  assert.equal(reg.installed, false);
  assert.equal(reg.count(), 0);
  assert.doesNotThrow(() => reg.dispose());
});

// R8：DEFAULT_DISPATCH_TOOLS 契约（登记点观察名单 = 派发类工具）
test('R8: DEFAULT_DISPATCH_TOOLS 含 subagent/subagent_fork/send_message', () => {
  assert.deepEqual([...DEFAULT_DISPATCH_TOOLS].sort(), ['send_message', 'subagent', 'subagent_fork'].sort());
});
