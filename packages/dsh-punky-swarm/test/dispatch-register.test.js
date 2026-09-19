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

// 派发登记点测试（写侧登记：member_status running 意图 → subagent post-execute → member.dispatch 落批）。
// 覆盖：R1 提取纯函数（结构化 result 各形态）；R2 真实登记路径（member_status running 意图 → subagent
// post-execute → member.dispatch 事件落批 + dispatchIndex 可查）；非 Manager 派发不登记（无登记静默降级语义）；
// R4 send_message 重复唤醒幂等（不重复登记）；R4b 提取失败 ⇒ 显式降级告警（T-14/G-10#3）；R5 装配层端到端（apply 真实装配：登记 → 归属命中 → escalation
// 计数 → paused——读侧骨架零改动生效）；R6 装配注入 resolveBatchContext 显式路径（不经 member_status）。
// 标注（如实）：governance-escalate.test.js 原用 member.dispatch 直写模拟「映射命中」前置——
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
import { createCoreTools } from '../lib/tools/core.js';
import {
  issueLaneHandle, parseLaneHandleFromText, verifyLaneHandle, consumeLaneHandle,
  pendingHandles, sweepExpiredHandles, textOfDispatchArgs, LANE_HANDLE_TTL_MS, __resetLaneHandles,
} from '../lib/bridge/lane-handle.js';

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
  // send_message：目标在 args.agent_id（**宿主实签名** `{agent_id, message}`；T-14/G-10#3 键名校正）
  assert.equal(extractWorkerSessionId(execOf('send_message', { agent_id: 'ws-2', message: 'wake' }, 'm'), { isError: false, value: { messageId: 'm1' } }), 'ws-2');
  // send_message 回落防御：旧键名 args.subagent_id 仍可提取（宿主键名再漂移时不静默漏登记）
  assert.equal(extractWorkerSessionId(execOf('send_message', { subagent_id: 'ws-2f', message: 'wake' }, 'm'), { isError: false, value: { messageId: 'm1' } }), 'ws-2f');
  // 键名再漂移（既非 agent_id 亦非 subagent_id）⇒ null + 由登记点侧显式降级告警（R4b 覆盖，本处只断提取面）
  assert.equal(extractWorkerSessionId(execOf('send_message', { worker_id: 'ws-2x', message: 'wake' }, 'm'), { isError: false, value: {} }), null);
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
    assert.equal(ctx.calls.warn.filter((w) => w.includes('dispatch registration failed')).length, 0, '静默：零隔离 warn（异常面未触发）');
    // T-14/G-10#3 反向锁：提取**成功**的路径（continuable 有会话 id）不得产降级告警（告警只在真提取不到时发）
    assert.equal(ctx.calls.warn.filter((w) => w.includes('dispatch register degraded')).length, 0, '提取成功 ⇒ 零降级告警');
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
    // 再次唤醒（send_message 同 worker，宿主键名 agent_id）——意图已消费、且 dispatchIndex.has → 幂等跳过
    await dispatchPostAll(ctx, execOf('member_status', { session: 'sess-b', batchId: 'b-r4', lane: 'l1', status: 'running' }, 'mgr-s'), { isError: false, value: {} });
    await dispatchPostAll(ctx, execOf('send_message', { agent_id: 'ws-r4', message: 'wake' }, 'mgr-s'), { isError: false, value: { messageId: 'm2' } });
    // 回落键名同 worker（subagent_id）→ 亦幂等跳过（提取成功 ⇒ 不产降级告警）
    await dispatchPostAll(ctx, execOf('send_message', { subagent_id: 'ws-r4', message: 'wake' }, 'mgr-s'), { isError: false, value: { messageId: 'm3' } });
    const b = aux.readBatch('sess-b', 'b-r4');
    assert.equal(b.events.filter((e) => e.type === EVT_MEMBER_DISPATCH && e.workerSessionId === 'ws-r4').length, 1, '同一 worker 仅 1 条登记事件');
    assert.equal(reg.count(), 1);
  } finally {
    reg.dispose();
  }
});

// ── R4b：**提取失败 ⇒ 显式降级告警（不静默漏登记）**——T-14/G-10#3 的核心修复锁 ──
// 回归缺陷：官方 profile 下 `subagent*` 不在宿主工具面（其告警分支恒不进），而 `send_message` 原读错键名
// （`args.subagent_id`）⇒ 提取恒 null ⇒ `return next()` **零告警漏登记**，下游 laneBindingOf/自动结算静默失效。
test('R4b: send_message 键名漂移（既非 agent_id 亦非 subagent_id）⇒ 显式降级告警 + 零登记（不静默）', async () => {
  const root = freshRoot('punky-dr4b-');
  const aux = seedRunning(root, 'sess-b', 'b-r4b');
  const ctx = assemblyCtx();
  const index = new Map();
  const reg = installDispatchRegistration(ctx, { store: createStore(root), dispatchIndex: index, config: {}, logger: ctx.logger });
  try {
    // 前置意图在场（否则「不登记」会被 T16 意图缺失掩盖，测不到提取失败这一因）
    await dispatchPostAll(ctx, execOf('member_status', { session: 'sess-b', batchId: 'b-r4b', lane: 'l1', status: 'running' }, 'mgr-s'), { isError: false, value: {} });
    // 宿主键名再漂移：worker 会话 id 落在未知键上 ⇒ 提取不到
    await dispatchPostAll(ctx, execOf('send_message', { worker_id: 'ws-r4b', message: 'wake' }, 'mgr-s'), { isError: false, value: { messageId: 'm9' } });
    const b = aux.readBatch('sess-b', 'b-r4b');
    assert.equal(b.events.filter((e) => e.type === EVT_MEMBER_DISPATCH).length, 0, '提取不到 ⇒ 零伪登记');
    assert.equal(index.has('ws-r4b'), false, 'dispatchIndex 无映射');
    assert.ok(ctx.calls.warn.some((w) => w.includes('dispatch register degraded')), '提取失败留痕 warn（不静默漏登记）');
    // 观察者纪律不变：告警不阻断（listener 恒 next()，异常面仍零 isolate warn）
    assert.equal(ctx.calls.warn.filter((w) => w.includes('dispatch registration failed')).length, 0);
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
  // 注入解析器：任何 subagent 派发显式归属 sess-b/b-r6/l1（模拟宿主/编排层提供归属——装配注入面）
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

// ── R9：派发句柄纯函数（发放 / 解析 / 校验 / 一次性消费 / TTL / 悬挂视图）──
// 依据：2026-09-15 用户裁决「不写 token 即禁止派发」——token（句柄）是 C 档派发的唯一凭证。
test('R9: lane-handle——issue→parse→consume 一次性；未知/过期/批道不匹配一律拒；TTL 30min', () => {
  __resetLaneHandles();
  const t0 = 1_700_000_000_000;
  const h = issueLaneHandle({ batchId: 'b', lane: 'l1', sessionId: 's', now: t0 });
  assert.match(h.token, /^[0-9a-f]{16}$/, '句柄 = 16 hex');
  assert.equal(h.firstLine, '[swarm-lane:b/l1#' + h.token + ']');
  assert.equal(h.ttlMs, LANE_HANDLE_TTL_MS);
  // 解析：首行、或夹在长文本中都成立；无句柄/非字符串 ⇒ null
  assert.deepEqual(parseLaneHandleFromText('前言\n' + h.firstLine + '\n正文'), { batchId: 'b', lane: 'l1', token: h.token });
  assert.equal(parseLaneHandleFromText('无句柄文本'), null);
  assert.equal(parseLaneHandleFromText(undefined), null);
  // 文本收集（宿主参数形态）：prompt / description（含数组）都能被扫到
  assert.ok(textOfDispatchArgs({ prompt: h.firstLine }).includes(h.token));
  assert.ok(textOfDispatchArgs({ description: [h.firstLine] }).includes(h.token));
  assert.equal(textOfDispatchArgs(null), '');
  // 校验：未过期 + 批/道匹配
  assert.equal(verifyLaneHandle(h.token, { batchId: 'b', lane: 'l1', now: t0 + 1000 }).ok, true);
  assert.equal(verifyLaneHandle(h.token, { batchId: 'other', now: t0 }).reason, 'batch-mismatch');
  assert.equal(verifyLaneHandle(h.token, { lane: 'other', now: t0 }).reason, 'lane-mismatch');
  assert.equal(verifyLaneHandle('0'.repeat(16), { now: t0 }).reason, 'unknown-handle');
  // 一次性消费：二次消费拒
  assert.equal(consumeLaneHandle(h.token, { now: t0 + 1000 }).ok, true);
  assert.equal(consumeLaneHandle(h.token, { now: t0 + 1000 }).reason, 'handle-consumed');
  // 过期：另一枚句柄在 TTL 之后消费 ⇒ 拒
  const h2 = issueLaneHandle({ batchId: 'b', lane: 'l2', sessionId: 's', now: t0 });
  assert.equal(consumeLaneHandle(h2.token, { now: t0 + LANE_HANDLE_TTL_MS + 1 }).reason, 'handle-expired');
  // 悬挂视图 + 过期清理：sweep **按 TTL 清理、不区分是否已消费** ⇒ 两枚（已消费的 h + 过期的 h2）都被清
  assert.equal(pendingHandles(t0).length, 1, '仅 h2 未消费（h 已消费）');
  assert.equal(sweepExpiredHandles(t0 + LANE_HANDLE_TTL_MS + 1), 2, 'sweep 按 TTL 清理全部过期项（含已消费者）');
  assert.equal(pendingHandles(t0).length, 0);
  __resetLaneHandles();
});

// ── R11：工具面接线自证 —— `createCoreTools` 必须暴露套件派发入口 `lane_dispatch` ──
// 依据：2026-09-15 用户裁决「token 走新工具 lane_dispatch 取句柄」；本用例防「模块在、工具没接」的假绿。
test('R11: createCoreTools 暴露 lane_dispatch（参数含 batchId/lane；与 member_status 同批门禁语义）', async () => {
  const root = freshRoot('punky-dr11-');
  const ctx = assemblyCtx();
  const tools = createCoreTools(ctx, { store: createStore(root), root, config: {} });
  const ld = tools.find((t) => t.name === 'lane_dispatch');
  assert.ok(ld, 'lane_dispatch 已注册（否则 C 档派发无句柄可取）');
  const pj = JSON.stringify(ld.parameters ?? {});
  assert.ok(pj.includes('batchId') && pj.includes('lane'), '参数面含 batchId/lane（defineTool 归一化形态，按序列化判定）');
  assert.equal(typeof ld.execute, 'function', '有 execute（不是纯占位）');
  const ms = tools.find((t) => t.name === 'member_status');
  assert.ok(ms, 'member_status 仍在（既有轨道零回归）');
});

// ── R10：句柄优先精确登记 —— **并行两条 lane 同波派发 ⇒ 两条 member.dispatch 全登记** ──
// 回归缺陷：旧「单槽意图」（每会话只留最后一次 member_status(running)）在并行派发时只登记最后一条。
test('R10: 任务包含句柄 ⇒ 依句柄 (batchId, lane) 精确登记；并行两条 lane 全登记；句柄重放不登记', async () => {
  __resetLaneHandles();
  const root = freshRoot('punky-dr10-');
  const aux = seedRunning(root, 'mgr-s', 'b-r10', ['l1', 'l2']);
  const ctx = assemblyCtx();
  const index = new Map();
  const reg = installDispatchRegistration(ctx, { store: createStore(root), dispatchIndex: index, config: {}, logger: ctx.logger });
  try {
    const h1 = issueLaneHandle({ batchId: 'b-r10', lane: 'l1', sessionId: 'mgr-s' });
    const h2 = issueLaneHandle({ batchId: 'b-r10', lane: 'l2', sessionId: 'mgr-s' });
    // 派发 A：prompt 首行带 l1 句柄；派发 B：description 带 l2 句柄（同一会话、同一波）
    await dispatchPostAll(ctx, execOf('subagent', { prompt: '任务包\n' + h1.firstLine }, 'mgr-s'), subagentResult('ws-l1'));
    await dispatchPostAll(ctx, execOf('subagent', { description: h2.firstLine }, 'mgr-s'), subagentResult('ws-l2'));
    const b = aux.readBatch('mgr-s', 'b-r10');
    const dis = b.events.filter((e) => e.type === EVT_MEMBER_DISPATCH);
    assert.equal(dis.length, 2, '两条 lane 均登记（旧单槽意图只会登记最后一条）');
    assert.deepEqual(index.get('ws-l1'), { sessionId: 'mgr-s', batchId: 'b-r10', lane: 'l1' });
    assert.deepEqual(index.get('ws-l2'), { sessionId: 'mgr-s', batchId: 'b-r10', lane: 'l2' });
    // 句柄一次性 ⇒ 重放同一句柄不新增登记（且不回退意图路径）
    await dispatchPostAll(ctx, execOf('subagent', { prompt: h1.firstLine }, 'mgr-s'), subagentResult('ws-replay'));
    assert.equal(aux.readBatch('mgr-s', 'b-r10').events.filter((e) => e.type === EVT_MEMBER_DISPATCH).length, 2, '重放不新增');
    assert.ok(ctx.calls.warn.some((w) => w.includes('lane handle rejected')), '被拒句柄留痕 warn（handle-consumed）');
  } finally {
    reg.dispose();
    __resetLaneHandles();
  }
});
