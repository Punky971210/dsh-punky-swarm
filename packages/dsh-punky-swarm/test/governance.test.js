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

// 任务难度值门禁（design task-difficulty-gate）：governance.json v2 + assign_check 增强 + guard 三重门禁
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';

function freshRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------- 1. governance store 层（batch-store.js） ----------
const store = createStore(freshRoot('punky-gov-store-'));
const S = 'sess-gov';

test('readGovernance returns defaults when no file / corrupted file', () => {
  assert.deepEqual(store.readGovernance(S), { schema: 2, execToolCount: 0, pendingBatch: false, pendingSince: null, lastAssign: null, history: [] });
  fs.mkdirSync(path.join(store.sessionsDir, 'sess-broken'), { recursive: true });
  fs.writeFileSync(path.join(store.sessionsDir, 'sess-broken', 'governance.json'), '{oops');
  assert.equal(store.readGovernance('sess-broken').schema, 2);
});

test('writeGovernance merges patch atomically; bumpExecCount counts calls + lastAssign window', () => {
  const g = store.writeGovernance(S, { execToolCount: 3, lastAssign: { form: 'A', scope: 'full', at: new Date().toISOString(), reasons: [], execCallsSince: 0 } });
  assert.equal(g.schema, 2);
  assert.equal(g.execToolCount, 3);
  // bump：execToolCount 累计 + lastAssign.execCallsSince 递增
  const g2 = store.bumpExecCount(S);
  assert.equal(g2.execToolCount, 4);
  assert.equal(g2.lastAssign.execCallsSince, 1);
  const g3 = store.bumpExecCount(S);
  assert.equal(g3.execToolCount, 5);
  assert.equal(g3.lastAssign.execCallsSince, 2);
  // 无 lastAssign 时 bump 只计 execToolCount
  const g4 = store.bumpExecCount('sess-nolast');
  assert.equal(g4.execToolCount, 1);
  assert.equal(g4.lastAssign, null);
  // 原子写：磁盘 JSON 可解析
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(store.sessionsDir, S, 'governance.json'), 'utf8')));
});

test('stale: 从未评估 / execCallsSince>=20 / 距 lastAssign.at>=30min / 非法时间戳', () => {
  assert.equal(store.stale('sess-never'), true); // 从未评估
  const now = new Date().toISOString();
  store.writeGovernance('sess-stale', { lastAssign: { form: 'A', at: now, reasons: [], execCallsSince: 19 } });
  assert.equal(store.stale('sess-stale'), false); // 阈值内
  store.writeGovernance('sess-stale', { lastAssign: { form: 'A', at: now, reasons: [], execCallsSince: 20 } });
  assert.equal(store.stale('sess-stale'), true); // 恰达阈值
  store.writeGovernance('sess-old', { lastAssign: { form: 'A', at: new Date(Date.now() - 31 * 60 * 1000).toISOString(), reasons: [], execCallsSince: 0 } });
  assert.equal(store.stale('sess-old'), true); // 超过 30 分钟
  assert.equal(store.stale('sess-old', { maxCalls: 50, maxAgeMs: 60 * 60 * 1000 }), false); // 自定义参数
  store.writeGovernance('sess-badts', { lastAssign: { form: 'A', at: 'not-a-date', reasons: [], execCallsSince: 0 } });
  assert.equal(store.stale('sess-badts'), true); // 非法时间戳按过期处理
});

test('hasActiveBatch: 活跃（非终态）批次判定', () => {
  const s = 'sess-act';
  assert.equal(store.hasActiveBatch(s), false);
  store.createBatch(s, { batchId: 'b-act', wavePlan: buildWavePlan({ batchId: 'b-act', tasks: [{ id: 'x' }] }) });
  assert.equal(store.hasActiveBatch(s), true); // planning 也算活跃
  store.setPhase(s, 'b-act', 'running');
  assert.equal(store.hasActiveBatch(s), true);
  store.setPhase(s, 'b-act', 'complete'); // generic 批次可直达 complete
  assert.equal(store.hasActiveBatch(s), false);
  assert.equal(store.hasActiveBatch('sess-other'), false); // 会话隔离
});

// ---------- 2. assign_check 增强（tools.js） ----------
const toolsRoot = freshRoot('punky-gov-tools-');
const toolsStore = createStore(toolsRoot);
const { tools } = createTools({ tools: { register: () => {} }, logger: console }, { store: toolsStore, root: toolsRoot });
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
const AC_SESS = { agent: { session: { id: 'sess-ac' } } };

test('assign_check: scope 缺省 full，写 lastAssign + history，A/B 不置 pendingBatch', async () => {
  const a = await byName.assign_check.execute({}, AC_SESS);
  assert.equal(a.form, 'A');
  assert.equal(a.allowed, true);
  assert.deepEqual(a.next, []);
  assert.equal(typeof a.execToolCount, 'number');
  assert.equal(a.escalationHint, '');
  assert.equal(a.history.length, 1);
  assert.equal(a.history[0].form, 'A');
  assert.equal(a.history[0].turn, 1);
  const g = toolsStore.readGovernance('sess-ac');
  assert.equal(g.lastAssign.form, 'A');
  assert.equal(g.lastAssign.scope, 'full'); // 缺省 full（纪律强制）
  assert.equal(g.lastAssign.execCallsSince, 0);
  assert.equal(g.pendingBatch, false);
  // scope 显式 current 记录
  await byName.assign_check.execute({ scope: 'current' }, AC_SESS);
  assert.equal(toolsStore.readGovernance('sess-ac').lastAssign.scope, 'current');
  // history 追加审计
  const h = toolsStore.readGovernance('sess-ac').history;
  assert.equal(h.length, 2);
  assert.equal(h[1].turn, 2);
});

test('assign_check: C 类 next=wave_plan + pendingBatch 置位（无活跃批次时）', async () => {
  const c = await byName.assign_check.execute({ parallel: true }, AC_SESS);
  assert.equal(c.form, 'C');
  assert.equal(c.allowed, false);
  assert.deepEqual(c.next, ['wave_plan']);
  const g = toolsStore.readGovernance('sess-ac');
  assert.equal(g.pendingBatch, true);
  assert.ok(g.pendingSince);
  assert.equal(g.lastAssign.form, 'C');
});

test('assign_check: escalationHint 当 execToolCount>=5 且无活跃批次', async () => {
  // 先建批并 complete，清掉活跃批次，避免 hasActive 干扰
  await byName.wave_plan.execute({ batchId: 'b-hint', tasks: [{ id: 'a' }] }, AC_SESS);
  await byName.batch_phase.execute({ batchId: 'b-hint', phase: 'running' }, AC_SESS);
  await byName.batch_phase.execute({ batchId: 'b-hint', phase: 'complete' }, AC_SESS);
  for (let i = 0; i < 5; i++) toolsStore.bumpExecCount('sess-ac');
  const r = await byName.assign_check.execute({ gate: true }, AC_SESS);
  assert.ok(r.escalationHint.includes('execToolCount=' + (r.execToolCount))); // 至少 ≥5
  assert.ok(r.escalationHint.includes('必须 wave_plan 建批'));
});

test('assign_check render: C 类强提示 + escalationHint 追加', () => {
  const render = (v) => byName.assign_check.output.render({}, v);
  const cText = render({ form: 'C', escalationHint: '' })[0].text;
  assert.ok(cText.includes('assign form: C (must use batch) → next: wave_plan'));
  const aText = render({ form: 'A', escalationHint: '' })[0].text;
  assert.ok(aText.includes('assign form: A (allowed)'));
  const hText = render({ form: 'C', escalationHint: 'execToolCount=5 ≥5 且无批次：任务已升级为复杂形态，必须 wave_plan 建批' })[0].text;
  assert.ok(hText.includes('⚠ execToolCount=5 ≥5 且无批次'));
});

// ---------- 3. guard 三重门禁（tools.js createTools 内注册） ----------
function makeGuarded(deps) {
  let guardFn = null;
  const ctx = { tools: { register: () => {}, guard: (fn) => { guardFn = fn; } }, logger: console };
  const t = createTools(ctx, deps);
  return { guardFn: () => guardFn, tools: t.tools, store: deps.store };
}

test('guard: 未评估 → 执行型被拒（门禁 1），非执行型放行，计数与拦截分离', () => {
  const root = freshRoot('punky-gov-guard1-');
  const st = createStore(root);
  const { guardFn } = makeGuarded({ store: st, root });
  assert.equal(typeof guardFn(), 'function');
  const call = (name, sess) => guardFn()({ name, agent: { session: { id: sess ?? 'sess-g1' } } });
  const r1 = call('pwsh');
  assert.ok(r1 && r1.includes('[task-difficulty-gate]') && r1.includes('尚未进行任务难度评估'));
  assert.ok(r1.includes('再执行 pwsh'));
  assert.equal(st.readGovernance('sess-g1').execToolCount, 1); // 被拒也计数
  // 非执行型放行且不计数（治理/查询，防死锁）
  assert.equal(call('read'), undefined);
  assert.equal(call('wave_plan'), undefined);
  assert.equal(call('batch_status'), undefined);
  assert.equal(st.readGovernance('sess-g1').execToolCount, 1);
});

test('guard: C 类未建批 → 执行型被拒（门禁 2）；wave_plan 建批 → pendingBatch=false 放行', async () => {
  const root = freshRoot('punky-gov-guard2-');
  const st = createStore(root);
  const { guardFn, tools: tls } = makeGuarded({ store: st, root });
  const by = Object.fromEntries(tls.map((t) => [t.name, t]));
  const call = (name) => guardFn()({ name, agent: { session: { id: 'sess-g2' } } });
  await by.assign_check.execute({ parallel: true }, { agent: { session: { id: 'sess-g2' } } }); // C
  assert.equal(st.readGovernance('sess-g2').pendingBatch, true);
  const r2 = call('write');
  assert.ok(r2 && r2.includes('任务难度=C') && r2.includes('必须先 wave_plan 建批'));
  // subagent 在 C+pendingBatch 时同样被门禁 2 拒
  const r2b = call('subagent');
  assert.ok(r2b && r2b.includes('任务难度=C'));
  // 建批 → pendingBatch=false → 放行
  await by.wave_plan.execute({ batchId: 'b-g2', tasks: [{ id: 't' }] }, { agent: { session: { id: 'sess-g2' } } });
  assert.equal(st.readGovernance('sess-g2').pendingBatch, false);
  assert.equal(call('write'), undefined);
});

test('guard: A 类派 subagent/subagent_fork → 拒（门禁 3 一致性），A 类 pwsh 放行', async () => {
  const root = freshRoot('punky-gov-guard3-');
  const st = createStore(root);
  const { guardFn, tools: tls } = makeGuarded({ store: st, root });
  const by = Object.fromEntries(tls.map((t) => [t.name, t]));
  const call = (name) => guardFn()({ name, agent: { session: { id: 'sess-g3' } } });
  await by.assign_check.execute({}, { agent: { session: { id: 'sess-g3' } } }); // A
  const r3 = call('subagent');
  assert.ok(r3 && r3.includes('A 类任务不派发 subagent') && r3.includes('请重评 B'));
  const r3b = call('subagent_fork');
  assert.ok(r3b && r3b.includes('A 类任务不派发 subagent'));
  assert.equal(call('pwsh'), undefined); // A 类执行型放行
});

test('guard: 过期重评——20 次执行调用后再次拦截（门禁 1）', async () => {
  const root = freshRoot('punky-gov-guard4-');
  const st = createStore(root);
  const { guardFn, tools: tls } = makeGuarded({ store: st, root });
  const by = Object.fromEntries(tls.map((t) => [t.name, t]));
  const call = (name) => guardFn()({ name, agent: { session: { id: 'sess-g4' } } });
  await by.assign_check.execute({}, { agent: { session: { id: 'sess-g4' } } }); // A
  assert.equal(call('pwsh'), undefined);
  // 补足到 20 次窗口调用
  for (let i = 0; i < 19; i++) st.bumpExecCount('sess-g4');
  const r4 = call('pwsh');
  assert.ok(r4 && r4.includes('尚未进行任务难度评估')); // execCallsSince 达阈值 → 要求重评
});

test('guard: 不同 session 隔离——B 会话不受 A 会话 pendingBatch 影响', async () => {
  const root = freshRoot('punky-gov-guard5-');
  const st = createStore(root);
  const { guardFn, tools: tls } = makeGuarded({ store: st, root });
  const by = Object.fromEntries(tls.map((t) => [t.name, t]));
  const call = (name, sess) => guardFn()({ name, agent: { session: { id: sess } } });
  await by.assign_check.execute({ parallel: true }, { agent: { session: { id: 'sess-a' } } }); // A 会话判 C → pendingBatch
  assert.equal(st.readGovernance('sess-a').pendingBatch, true);
  // B 会话无评估 → 门禁 1（与 A 的 pendingBatch 无关）
  const rB = call('pwsh', 'sess-b');
  assert.ok(rB && rB.includes('尚未进行任务难度评估'));
  await by.assign_check.execute({}, { agent: { session: { id: 'sess-b' } } }); // B 判 A
  assert.equal(call('pwsh', 'sess-b'), undefined); // B 放行
  // A 会话 C+pendingBatch：执行型仍拒（不受 B 影响）
  const rA = call('write', 'sess-a');
  assert.ok(rA && rA.includes('任务难度=C'));
});

test('guard: config.escalation.execTools 覆盖执行型名单', async () => {
  const root = freshRoot('punky-gov-guard6-');
  const st = createStore(root);
  const { guardFn, tools: tls } = makeGuarded({ store: st, root, config: { escalation: { execTools: ['pwsh'] } } });
  const by = Object.fromEntries(tls.map((t) => [t.name, t]));
  const call = (name) => guardFn()({ name, agent: { session: { id: 'sess-g6' } } });
  await by.assign_check.execute({ parallel: true }, { agent: { session: { id: 'sess-g6' } } }); // C + pendingBatch
  assert.ok(call('pwsh') && call('pwsh').includes('任务难度=C')); // 名单内 → 拦截
  assert.equal(call('write'), undefined); // 名单外 → 放行
  assert.equal(call('subagent'), undefined); // 名单外 → 放行
});

// ---------- 4. 写入点：wave_plan 建批 / batch complete|aborted 清 pendingBatch ----------
test('wave_plan 建批清 pendingBatch；batch_phase complete/aborted 兜底清理', async () => {
  const root = freshRoot('punky-gov-wp-');
  const st = createStore(root);
  const { tools: tls } = createTools({ tools: { register: () => {} }, logger: console }, { store: st, root });
  const by = Object.fromEntries(tls.map((t) => [t.name, t]));
  const EXEC = { agent: { session: { id: 'sess-wp' } } };
  await by.assign_check.execute({ parallel: true }, EXEC); // C → pendingBatch=true
  assert.equal(st.readGovernance('sess-wp').pendingBatch, true);
  await by.wave_plan.execute({ batchId: 'b-wp', tasks: [{ id: 'a' }] }, EXEC);
  assert.equal(st.readGovernance('sess-wp').pendingBatch, false); // 建批解锁
  // 残留 pendingBatch 场景：complete 兜底清理
  st.writeGovernance('sess-wp', { pendingBatch: true, pendingSince: 'x' });
  await by.batch_phase.execute({ batchId: 'b-wp', phase: 'running' }, EXEC);
  await by.batch_phase.execute({ batchId: 'b-wp', phase: 'complete' }, EXEC);
  assert.equal(st.readGovernance('sess-wp').pendingBatch, false);
  assert.equal(st.readGovernance('sess-wp').pendingSince, null);
});

test('assign_check: C 判定后重评为 A/B → pendingBatch 残留清除（Gap D 修复）', async () => {
  const root = freshRoot('punky-gov-pbc-');
  const st = createStore(root);
  const { tools: tls } = makeGuarded({ store: st, root });
  const by = Object.fromEntries(tls.map((t) => [t.name, t]));
  const EXEC = { agent: { session: { id: 'sess-pbc' } } };
  await by.assign_check.execute({ gate: true }, EXEC); // C → pendingBatch=true
  assert.equal(st.readGovernance('sess-pbc').pendingBatch, true);
  await by.assign_check.execute({ needIsolation: true }, EXEC); // 重评 B → 清残留
  assert.equal(st.readGovernance('sess-pbc').pendingBatch, false);
  assert.equal(st.readGovernance('sess-pbc').pendingSince, null);
  // 回归：C+无批仍挂锁；C+活跃批次清锁
  await by.assign_check.execute({ gate: true }, EXEC);
  assert.equal(st.readGovernance('sess-pbc').pendingBatch, true);
  await by.wave_plan.execute({ batchId: 'b-pbc', tasks: [{ id: 'a' }] }, EXEC);
  await by.assign_check.execute({ gate: true }, EXEC); // C 但已有活跃批次 → 不挂锁
  assert.equal(st.readGovernance('sess-pbc').pendingBatch, false);
});

// ---------- 5. session 显式化兼容（session-compat：显式 sessionID + 兼容不填） ----------
test('assign_check: 显式 session 回显 + 镜像到执行会话，guard 不误拦，建批后双向解锁', async () => {
  const root = freshRoot('punky-gov-compat1-');
  const st = createStore(root);
  const { guardFn, tools: tls } = makeGuarded({ store: st, root });
  const by = Object.fromEntries(tls.map((t) => [t.name, t]));
  const execCtx = { agent: { session: { id: 'sess-real' } } };
  const r = await by.assign_check.execute({ gate: true, session: 'deploy-x' }, execCtx); // C
  // 回显：落点 sessionId + 镜像去向 mirroredTo
  assert.equal(r.sessionId, 'deploy-x');
  assert.equal(r.mirroredTo, 'sess-real');
  // 命名会话：C + pendingBatch + mirroredTo 指针
  const gx = st.readGovernance('deploy-x');
  assert.equal(gx.lastAssign.form, 'C');
  assert.equal(gx.pendingBatch, true);
  assert.equal(gx.mirroredTo, 'sess-real');
  // 执行会话：镜像生效（lastAssign + pendingBatch + mirror 指针；history 不镜像）
  const gy = st.readGovernance('sess-real');
  assert.equal(gy.lastAssign.form, 'C');
  assert.equal(gy.lastAssign.mirroredFrom, 'deploy-x');
  assert.equal(gy.pendingBatch, true);
  assert.equal(gy.mirror.from, 'deploy-x');
  assert.equal(gy.history.length, 0);
  // guard：C+pendingBatch → 门禁 2（先建批）而非门禁 1（未评估）——镜像前同调用会被门禁 1 误拦
  const blocked = guardFn()({ name: 'write', agent: { session: { id: 'sess-real' } } });
  assert.ok(blocked && blocked.includes('任务难度=C'));
  // wave_plan 建批到命名会话 → 双向解锁（含镜像传播）
  await by.wave_plan.execute({ batchId: 'b-x', tasks: [{ id: 't' }], session: 'deploy-x' }, execCtx);
  assert.equal(st.readGovernance('deploy-x').pendingBatch, false);
  assert.equal(st.readGovernance('deploy-x').mirroredTo, null);
  assert.equal(st.readGovernance('sess-real').pendingBatch, false);
  assert.equal(st.readGovernance('sess-real').mirror, null);
  assert.equal(guardFn()({ name: 'write', agent: { session: { id: 'sess-real' } } }), undefined);
});

test('assign_check: A 类显式 session → 镜像后执行会话 guard 放行（镜像前误拦对比）', async () => {
  const root = freshRoot('punky-gov-compat2-');
  const st = createStore(root);
  const { guardFn, tools: tls } = makeGuarded({ store: st, root });
  const by = Object.fromEntries(tls.map((t) => [t.name, t]));
  const execCtx = { agent: { session: { id: 'sess-real' } } };
  // 镜像前：执行会话未评估 → 门禁 1 误拦（对比基准）
  const before = guardFn()({ name: 'pwsh', agent: { session: { id: 'sess-real' } } });
  assert.ok(before && before.includes('尚未进行任务难度评估'));
  await by.assign_check.execute({ session: 'probe-x' }, execCtx); // A
  assert.equal(st.readGovernance('sess-real').lastAssign.form, 'A');
  assert.equal(st.readGovernance('sess-real').lastAssign.mirroredFrom, 'probe-x');
  assert.equal(guardFn()({ name: 'pwsh', agent: { session: { id: 'sess-real' } } }), undefined);
});

test('assign_check: 缺省 session → 落当前执行会话不镜像；无会话上下文 → cli 兜底 + notice', async () => {
  const root = freshRoot('punky-gov-compat3-');
  const st = createStore(root);
  const { tools: tls } = makeGuarded({ store: st, root });
  const by = Object.fromEntries(tls.map((t) => [t.name, t]));
  // 缺省：落 agent.session.id，无镜像
  const r1 = await by.assign_check.execute({ needIsolation: true }, { agent: { session: { id: 'sess-real' } } }); // B
  assert.equal(r1.sessionId, 'sess-real');
  assert.equal(r1.mirroredTo, undefined);
  assert.equal(st.readGovernance('sess-real').lastAssign.form, 'B');
  // 无会话上下文：cli 兜底 + notice 警示
  const r2 = await by.assign_check.execute({}, {});
  assert.equal(r2.sessionId, 'cli');
  assert.ok(r2.notice && r2.notice.includes('cli'));
  const gcli = st.readGovernance('cli');
  assert.equal(gcli.lastAssign.form, 'A');
  // 显式传执行会话自身 ID：不触发镜像，mirroredTo 字段完全缺席（undefined/null 均会触发 harness lossless JSON 校验拒绝）
  const r3 = await by.assign_check.execute({ session: 'sess-real' }, { agent: { session: { id: 'sess-real' } } });
  assert.equal(r3.sessionId, 'sess-real');
  assert.equal(r3.mirroredTo, undefined);
  assert.equal(st.readGovernance('sess-real').mirroredTo, undefined); // 未镜像：命名会话无 mirroredTo 指针
  // lossless round-trip 回归：输出对象必须可无损 JSON 序列化（harness 校验层硬性要求；undefined 值会触发 not lossless 拒绝）
  assert.deepEqual(JSON.parse(JSON.stringify(r1)), r1);
  assert.deepEqual(JSON.parse(JSON.stringify(r3)), r3);
});
