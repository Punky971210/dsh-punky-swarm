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
// W7F-FU-U1：治理落盘的**显式冲刷入口**（与 `lib/index.js` disposer 同一单点）
import { flushDirtyGovernance } from '../lib/state/store/governance.js';
import { threeTierTasks, seedArtifacts, runLane, tempRoot } from './helpers/gate-fixture.mjs';
import { withDefaultTeam } from './helpers/skill-paths.mjs';

// 【P1 同步 · 前置】本套件建批统一补 `software-team`（见各 harness 的 withDefaultTeam）。


// ---------- 1. governance store 层（batch-store.js） ----------
const store = createStore(tempRoot('punky-gov-store-'));
const S = 'sess-gov';

test('readGovernance returns defaults when no file / corrupted file', () => {
  assert.deepEqual(store.readGovernance(S), { schema: 2, execToolCount: 0, pendingBatch: false, pendingSince: null, lastAssign: null, history: [] });
  fs.mkdirSync(path.join(store.sessionsDir, 'sess-broken'), { recursive: true });
  fs.writeFileSync(path.join(store.sessionsDir, 'sess-broken', 'governance.json'), '{oops');
  assert.equal(store.readGovernance('sess-broken').schema, 2);
});

test('writeGovernance merges patch atomically; bumpExecCount counts calls + lastAssign window', () => {
  const INIT_EXEC_COUNT = 3; // 单一真源：写入值与断言共用这一个常量，避免两处各写一遍字面量
  const g = store.writeGovernance(S, { execToolCount: INIT_EXEC_COUNT, lastAssign: { form: 'A', scope: 'full', at: new Date().toISOString(), reasons: [], execCallsSince: 0 } });
  assert.equal(g.schema, 2);
  assert.equal(g.execToolCount, INIT_EXEC_COUNT, 'execToolCount 须等于写入值（单一真源）');
  // bump：execToolCount 累计 + lastAssign.execCallsSince 递增
  const g2 = store.bumpExecCount(S);
  assert.equal(g2.execToolCount, g.execToolCount + 1, 'bump 一次 ⇒ 相对前值 +1（G6 同源构造差值）');
  assert.equal(g2.lastAssign.execCallsSince, 1);
  const g3 = store.bumpExecCount(S);
  assert.equal(g3.execToolCount, g2.execToolCount + 1, '再 bump ⇒ 再 +1（G6）');
  assert.equal(g3.lastAssign.execCallsSince, 2);
  // 无 lastAssign 时 bump 只计 execToolCount
  const g4 = store.bumpExecCount('sess-nolast');
  assert.equal(g4.execToolCount, 0 + 1, '全新 session 首次 bump ⇒ 从 0 起 +1（G6；0 = 无历史）');
  assert.equal(g4.lastAssign, null);
  // 原子写：磁盘 JSON 可解析
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(store.sessionsDir, S, 'governance.json'), 'utf8')));
});

test('stale: 从未评估 / 距 lastAssign.at>=30min / 非法时间戳；execCallsSince **不再是**过期依据（2026-09-16 裁决）', () => {
  assert.equal(store.stale('sess-never'), true); // 从未评估
  const now = new Date().toISOString();
  store.writeGovernance('sess-stale', { lastAssign: { form: 'A', at: now, reasons: [], execCallsSince: 19 } });
  assert.equal(store.stale('sess-stale'), false); // 阈值内
  // 【2026-09-16 用户裁决】execToolCount/execCallsSince 降为纯观察提示：调用数再大也不触发过期/重评
  store.writeGovernance('sess-stale', { lastAssign: { form: 'A', at: now, reasons: [], execCallsSince: 20 } });
  assert.equal(store.stale('sess-stale'), false); // 旧 maxCalls(20) 阈值已移除
  store.writeGovernance('sess-stale', { lastAssign: { form: 'A', at: now, reasons: [], execCallsSince: 10_000 } });
  assert.equal(store.stale('sess-stale'), false); // 极大调用数亦不过期
  store.writeGovernance('sess-old', { lastAssign: { form: 'A', at: new Date(Date.now() - 31 * 60 * 1000).toISOString(), reasons: [], execCallsSince: 0 } });
  assert.equal(store.stale('sess-old'), true); // 超过 30 分钟
  assert.equal(store.stale('sess-old', { maxCalls: 50, maxAgeMs: 60 * 60 * 1000 }), false); // 自定义时间窗（maxCalls 已忽略）
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
  // 【r2 同步 · B3】旧口径「generic 批次可直达 complete」已废除：零执行零验收不得收口
  //   ⇒ complete 被 `GATE_COMPLETE_NO_TIER` 拒、批次仍活跃；改经 `aborted`（D-8 终态可退出）收口。
  assert.throws(() => store.setPhase(s, 'b-act', 'complete'), /GATE_COMPLETE_NO_TIER/);
  assert.equal(store.hasActiveBatch(s), true);
  store.setPhase(s, 'b-act', 'aborted');
  assert.equal(store.hasActiveBatch(s), false);
  assert.equal(store.hasActiveBatch('sess-other'), false); // 会话隔离
});

// ---------- 2. assign_check 增强（tools.js） ----------
const toolsRoot = tempRoot('punky-gov-tools-');
const toolsStore = createStore(toolsRoot);
const { tools } = createTools({ tools: { register: () => {} }, logger: console }, { store: toolsStore, root: toolsRoot });
// 【P1 同步】`team` 现为必填且必须解析到资产（无资产 ⇒ 构造期拒）⇒ 本套件（建批只是手段、被检面是治理门）统一补
//   包内软件团队。
const byName = withDefaultTeam(Object.fromEntries(tools.map((t) => [t.name, t])));
const AC_SESS = { agent: { session: { id: 'sess-ac' } } };

test('assign_check: scope 缺省 full，写 lastAssign + history，A/B 不置 pendingBatch', async () => {
  const a = await byName.assign_check.execute({ difficulty: 'A', rationale: '测试：单线程直做（无并行/无依赖链）' }, AC_SESS);
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
  await byName.assign_check.execute({ difficulty: 'A', rationale: '测试：单线程直做，仅评估当前动作', scope: 'current' }, AC_SESS);
  assert.equal(toolsStore.readGovernance('sess-ac').lastAssign.scope, 'current');
  // history 追加审计
  const h = toolsStore.readGovernance('sess-ac').history;
  assert.equal(h.length, 2);
  assert.equal(h[1].turn, 2);
});

test('assign_check: C 类 next=wave_plan + pendingBatch 置位（无活跃批次时）', async () => {
  const c = await byName.assign_check.execute({ difficulty: 'C', rationale: '测试：命中多线并行判据，需 wave_plan 建批', parallel: true }, AC_SESS);
  assert.equal(c.form, 'C');
  assert.equal(c.allowed, false);
  assert.deepEqual(c.next, ['wave_plan']);
  const g = toolsStore.readGovernance('sess-ac');
  assert.equal(g.pendingBatch, true);
  assert.ok(g.pendingSince);
  assert.equal(g.lastAssign.form, 'C');
});

test('assign_check: escalationHint 当 execToolCount>=5 且无活跃批次', async () => {
  // 先建批并收口，清掉活跃批次，避免 hasActive 干扰
  // 【r2 同步 · B3】旧口径用 `phase:'complete'` 收口 generic 单 lane 批；新语义零执行零验收不得 complete
  //   （`GATE_COMPLETE_NO_TIER`）⇒ 改用 `aborted`（D-8 终态可退出；同属批次终态、同样清 pendingBatch）。
  await byName.wave_plan.execute({ batchId: 'b-hint', tasks: [{ id: 'a' }] }, AC_SESS);
  await byName.batch_phase.execute({ batchId: 'b-hint', phase: 'running' }, AC_SESS);
  await byName.batch_phase.execute({ batchId: 'b-hint', phase: 'aborted' }, AC_SESS);
  for (let i = 0; i < 5; i++) toolsStore.bumpExecCount('sess-ac');
  const r = await byName.assign_check.execute({ difficulty: 'C', rationale: '测试：命中门禁/审计判据，需 wave_plan 建批', gate: true }, AC_SESS);
  assert.ok(r.escalationHint.includes('execToolCount=' + (r.execToolCount))); // 至少 ≥5
  // 2026-09-13 用户裁决（最高优先级判据）：升 C 只看「多线并行 / 多依赖」；计数只是弱旁证，
  // 提示**不得**读作「必须建批」——单线程任务可直接执行
  assert.ok(r.escalationHint.includes('单线程'));
  assert.ok(r.escalationHint.includes('多线并行'));
  assert.ok(r.escalationHint.includes('多依赖'));
  assert.equal(r.escalationHint.includes('必须 wave_plan 建批'), false);
});

// A1：终态批次冻结——complete / aborted 之后任何成员迁移一律拒（防「已收口批次被改写成 running」）
test('A1: 终态批次拒绝成员迁移（GATE_BATCH_TERMINAL）', async () => {
  await byName.wave_plan.execute({ batchId: 'b-term', tasks: [{ id: 'a' }] }, AC_SESS);
  await byName.batch_phase.execute({ batchId: 'b-term', phase: 'running' }, AC_SESS);
  await byName.batch_phase.execute({ batchId: 'b-term', phase: 'aborted' }, AC_SESS);
  await assert.rejects(
    () => byName.member_set_status.execute({ batchId: 'b-term', lane: 'a', status: 'running' }, AC_SESS),
    /GATE_BATCH_TERMINAL/,
  );
  assert.equal(toolsStore.readBatch('sess-ac', 'b-term').lanes.a, 'pending', '被拒迁移不得改动成员状态');
});

// A3：**本断言由本批新语义替代（旧口径：重派未带 exempt ⇒ 旧豁免被 laneExemptClear 静默清退，
//   `laneExempt` 整键删除且零事件留痕——store.js:461 + laneExemptClear:318）**。
//   D7 决议（§6.2，两级方案二选一，须留痕）：重派未带 exempt 时旧豁免**不得静默消失**——
//     ① 首选 继承：保留 batch.laneExempt[lane]（可配 `lane.exempt.inherited` 事件留痕，grantedFrom 语义扩展）；
//     ② 次选 清退 + 显式提示：写 `lane.exempt.cleared` 事件并进入探针输出（exemptClearedAt / reason='exempt-cleared'）。
//   本断言面 = 「可观测留痕存在」（继承或 cleared 任一），故对两种落法都成立、对「静默清退」必失败。
// K3（2026-09-21）改判：**重派路径本身已不存在**（`review→running` 返工边去除）⇒ 原「重派未带 exempt ⇒ 豁免不得静默清退」
//   的观测点从「重派后豁免仍在」改为「重派被拒 ⇒ 零写入 ⇒ 豁免仍在」。D7/§6.2 的目标（不得静默清退）由**零写入**天然保证：
//   结算到 failed/skipped/conflict 才可能触发清退路径，而它们受 `GATE_SETTLE_NOTE_MISSING` 约束且须显式留痕。
test('A3（K3 改判）：重派路径已去除 ⇒ review→running 被拒，旧 longrun 豁免零写入不清退', async () => {
  await byName.wave_plan.execute({ batchId: 'b-ex', tasks: [{ id: 'x' }] }, AC_SESS);
  await byName.batch_phase.execute({ batchId: 'b-ex', phase: 'running' }, AC_SESS);
  await byName.member_set_status.execute({ batchId: 'b-ex', lane: 'x', status: 'running', exempt: { type: 'ai-render' } }, AC_SESS);
  assert.ok(toolsStore.readBatch('sess-ac', 'b-ex').laneExempt.x, '派发面授予后应有豁免条目');
  await byName.member_set_status.execute({ batchId: 'b-ex', lane: 'x', status: 'review' }, AC_SESS);
  // 重派不带 exempt：K3 后被拒（非「放行但清退豁免」）
  let re = null;
  try {
    re = await byName.member_set_status.execute({ batchId: 'b-ex', lane: 'x', status: 'running' }, AC_SESS);
  } catch (e) {
    re = e;
  }
  const msg = re instanceof Error ? re.message : JSON.stringify(re);
  assert.match(msg, /invalid member transition: review -> running/, 'K3：重派路径应已被去除，实际=' + msg);
  const b = toolsStore.readBatch('sess-ac', 'b-ex');
  assert.equal(b.lanes.x, 'review', '拒 = 零写入 ⇒ 状态不变');
  assert.ok(b.laneExempt?.x != null, 'D7/§6.2「不得静默清退」：豁免条目须仍在（实际=' + JSON.stringify(b.laneExempt ?? null) + '）');
});


test('assign_check render: C 类强提示 + escalationHint 追加', () => {
  const render = (v) => byName.assign_check.output.render({}, v);
  const cText = render({ form: 'C', escalationHint: '' })[0].text;
  assert.ok(cText.includes('assign difficulty: C (must use batch) → next: wave_plan'));
  const aText = render({ form: 'A', escalationHint: '' })[0].text;
  assert.ok(aText.includes('assign difficulty: A (allowed)'));
  const hText = render({ form: 'C', escalationHint: 'execToolCount=5 ≥5 且无批次：任务已升级为复杂形态，必须 wave_plan 建批' })[0].text;
  assert.ok(hText.includes('⚠ execToolCount=5 ≥5 且无批次'));
});

// ---------- 3. guard 三重门禁（tools.js createTools 内注册） ----------
function makeGuarded(deps) {
  // 【2026-10-31 S3 复修 · 夹具不真实（A 类）】原 `guard: (fn) => { guardFn = fn }` 是**覆盖式捕获** ⇒ 只留
  //   **最后注册**的守卫。生产 `register.js` 先装难度门禁、后装溯源守卫 ⇒ 捕获到的是溯源守卫，它对
  //   `{name:'pwsh'}`（非写族）返回 `undefined` ⇒ 难度断言「期望拒」得到 undefined ⇒ 红。
  //   生产真实语义 = **跑全部 guard 取首个拒绝串**（宿主 dsh-tools `guardReason`：
  //   `for (const guard of this.guards.values()) { const reason = guard(exec); if (reason !== undefined) return reason }`）
  //   ⇒ 改为**累积捕获 + 与生产同构的合成调用**。**断言一字未改**（仍走原有 `guardFn()(…)` 调用面）。
  const guards = [];
  const ctx = { tools: { register: () => {}, guard: (fn) => { guards.push(fn); return () => {}; } }, logger: console };
  const t = createTools(ctx, deps);
  const composed = (execution) => {
    for (const g of guards) {
      const reason = g(execution);
      if (reason !== undefined) return reason;
    }
    return undefined;
  };
  return { guardFn: () => composed, tools: t.tools, store: deps.store, guardCount: guards.length };
}

test('guard: 未评估 → 执行型被拒（门禁 1），非执行型放行，计数与拦截分离', () => {
  const root = tempRoot('punky-gov-guard1-');
  const st = createStore(root);
  const { guardFn } = makeGuarded({ store: st, root });
  assert.equal(typeof guardFn(), 'function');
  const call = (name, sess) => guardFn()({ name, agent: { session: { id: sess ?? 'sess-g1' } } });
  const execBefore = st.readGovernance('sess-g1').execToolCount ?? 0; // 前值快照（G6 差值基线）
  const r1 = call('pwsh');
  assert.ok(r1 && r1.includes('[task-difficulty-gate]') && r1.includes('尚未进行任务难度评估'));
  assert.ok(r1.includes('才能执行 pwsh'));
  // 【G4-A · I-26 语义变更对齐（与 mode-gate G2/G2b 同改法，2026-11-01）】
  //   `bumpExecCount` 由「无论拦不拦都计」改为「**仅放行计**」—— 拒态零写是硬不变量
  //   （计数器与批状态同写一份 state 文件，计数会破坏「拒态 sha256 逐位不变」）。
  //   ⇒ 被拒路径断言**精确 0**（禁写成「0 或 1」/`>=0`：那等于取消判据）。
  assert.equal(st.readGovernance('sess-g1').execToolCount ?? 0, execBefore, '被拒绝不计数（精确前值，拒态零写）');
  // 非执行型放行且不计数（治理/查询，防死锁）
  assert.equal(call('read'), undefined);
  assert.equal(call('wave_plan'), undefined);
  assert.equal(call('batch_status'), undefined);
  assert.equal(st.readGovernance('sess-g1').execToolCount ?? 0, execBefore, '非执行型放行亦不计数（精确前值）');
  // 【对照组·必写】「被拒不计数」≠「不再计数」：必须有**放行路径精确 +1**，
  //   否则「一律不计数」也能让上面两条绿（假绿）。
  st.writeGovernance('sess-g1', {
    lastAssign: { form: 'A', difficulty: 'A', rationale: 'G6 放行路径对照', at: new Date().toISOString() },
  });
  assert.equal(call('pwsh'), undefined, '已评估 ⇒ 执行型放行');
  assert.equal(st.readGovernance('sess-g1').execToolCount ?? 0, execBefore + 1, '放行路径照常计数（精确前值 +1，与上面的 0 成对）');
});

test('guard: C 类未建批 → 执行型被拒（门禁 2）；wave_plan 建批 → pendingBatch=false 放行', async () => {
  const root = tempRoot('punky-gov-guard2-');
  const st = createStore(root);
  const { guardFn, tools: tls } = makeGuarded({ store: st, root });
  const by = withDefaultTeam(Object.fromEntries(tls.map((t) => [t.name, t])));
  const call = (name) => guardFn()({ name, agent: { session: { id: 'sess-g2' } } });
  await by.assign_check.execute({ difficulty: 'C', rationale: '测试：命中多线并行判据，需 wave_plan 建批', parallel: true }, { agent: { session: { id: 'sess-g2' } } }); // C
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
  const root = tempRoot('punky-gov-guard3-');
  const st = createStore(root);
  const { guardFn, tools: tls } = makeGuarded({ store: st, root });
  const by = withDefaultTeam(Object.fromEntries(tls.map((t) => [t.name, t])));
  const call = (name) => guardFn()({ name, agent: { session: { id: 'sess-g3' } } });
  await by.assign_check.execute({ difficulty: 'A', rationale: '测试：单线程直做（无并行/无依赖链）' }, { agent: { session: { id: 'sess-g3' } } }); // A
  const r3 = call('subagent');
  assert.ok(r3 && r3.includes('A 类任务不派发 subagent') && r3.includes('请重评 B'));
  const r3b = call('subagent_fork');
  assert.ok(r3b && r3b.includes('A 类任务不派发 subagent'));
  assert.equal(call('pwsh'), undefined); // A 类执行型放行
});

test('guard: execToolCount 仅观察——补足 20+ 次执行调用**不再**触发重评（2026-09-16 裁决）', async () => {
  const root = tempRoot('punky-gov-guard4-');
  const st = createStore(root);
  const { guardFn, tools: tls } = makeGuarded({ store: st, root });
  const by = withDefaultTeam(Object.fromEntries(tls.map((t) => [t.name, t])));
  const call = (name) => guardFn()({ name, agent: { session: { id: 'sess-g4' } } });
  await by.assign_check.execute({ difficulty: 'A', rationale: '测试：单线程直做（无并行/无依赖链）' }, { agent: { session: { id: 'sess-g4' } } }); // A
  assert.equal(call('pwsh'), undefined);
  // 补足到 20 次窗口调用（旧判据会在此过期）
  for (let i = 0; i < 19; i++) st.bumpExecCount('sess-g4');
  assert.ok(st.readGovernance('sess-g4').execToolCount >= 20, '计数仍在累计（纯观察面，≥20）');
  assert.equal(call('pwsh'), undefined, '【裁决】调用数不再驱动重评 ⇒ 放行');
  assert.equal(st.stale('sess-g4'), false, 'stale 不再看调用数');
  // 反向锚：只有「时间窗过期」才触发重评
  st.writeGovernance('sess-g4', { lastAssign: { difficulty: 'A', form: 'A', at: new Date(Date.now() - 31 * 60 * 1000).toISOString(), execCallsSince: 0 } });
  const r4 = call('pwsh');
  assert.ok(r4 && r4.includes('尚未进行任务难度评估'), '时间窗过期 → 要求重评');
});

test('guard: 不同 session 隔离——B 会话不受 A 会话 pendingBatch 影响', async () => {
  const root = tempRoot('punky-gov-guard5-');
  const st = createStore(root);
  const { guardFn, tools: tls } = makeGuarded({ store: st, root });
  const by = withDefaultTeam(Object.fromEntries(tls.map((t) => [t.name, t])));
  const call = (name, sess) => guardFn()({ name, agent: { session: { id: sess } } });
  await by.assign_check.execute({ difficulty: 'C', rationale: '测试：命中多线并行判据，需 wave_plan 建批', parallel: true }, { agent: { session: { id: 'sess-a' } } }); // A 会话判 C → pendingBatch
  assert.equal(st.readGovernance('sess-a').pendingBatch, true);
  // B 会话无评估 → 门禁 1（与 A 的 pendingBatch 无关）
  const rB = call('pwsh', 'sess-b');
  assert.ok(rB && rB.includes('尚未进行任务难度评估'));
  await by.assign_check.execute({ difficulty: 'A', rationale: '测试：单线程直做（无并行/无依赖链）' }, { agent: { session: { id: 'sess-b' } } }); // B 判 A
  assert.equal(call('pwsh', 'sess-b'), undefined); // B 放行
  // A 会话 C+pendingBatch：执行型仍拒（不受 B 影响）
  const rA = call('write', 'sess-a');
  assert.ok(rA && rA.includes('任务难度=C'));
});

test('guard: config.escalation.execTools 覆盖执行型名单', async () => {
  const root = tempRoot('punky-gov-guard6-');
  const st = createStore(root);
  const { guardFn, tools: tls } = makeGuarded({ store: st, root, config: { escalation: { execTools: ['pwsh'] } } });
  const by = withDefaultTeam(Object.fromEntries(tls.map((t) => [t.name, t])));
  const call = (name) => guardFn()({ name, agent: { session: { id: 'sess-g6' } } });
  await by.assign_check.execute({ difficulty: 'C', rationale: '测试：命中多线并行判据，需 wave_plan 建批', parallel: true }, { agent: { session: { id: 'sess-g6' } } }); // C + pendingBatch
  assert.ok(call('pwsh') && call('pwsh').includes('任务难度=C')); // 名单内 → 拦截
  assert.equal(call('write'), undefined); // 名单外 → 放行
  assert.equal(call('subagent'), undefined); // 名单外 → 放行
});

// ---------- 4. 写入点：wave_plan 建批 / batch complete|aborted 清 pendingBatch ----------
test('wave_plan 建批清 pendingBatch；batch_phase complete/aborted 兜底清理', async () => {
  const root = tempRoot('punky-gov-wp-');
  const st = createStore(root);
  const { tools: tls } = createTools({ tools: { register: () => {} }, logger: console }, { store: st, root });
  const by = withDefaultTeam(Object.fromEntries(tls.map((t) => [t.name, t])));
  const EXEC = { agent: { session: { id: 'sess-wp' } } };
  await by.assign_check.execute({ difficulty: 'C', rationale: '测试：命中多线并行判据，需 wave_plan 建批', parallel: true }, EXEC); // C → pendingBatch=true
  assert.equal(st.readGovernance('sess-wp').pendingBatch, true);
  // 【r2 同步 · B2/B3/A1/B1】旧 fixture 的 generic 单 lane 批已无法收口（`GATE_COMPLETE_NO_TIER`）
  //   ⇒ 改**合规三层批**（工具面须带批次级 assembly 声明）+ 声明产物在场 + 全 lane 结算后方可 complete。
  await by.wave_plan.execute({ batchId: 'b-wp', tasks: threeTierTasks(['t1']), assembly: { auditLane: 'a1' } }, EXEC);
  assert.equal(st.readGovernance('sess-wp').pendingBatch, false); // 建批解锁
  seedArtifacts(root, 'sess-wp', 'b-wp', ['t1']);
  await by.batch_phase.execute({ batchId: 'b-wp', phase: 'running' }, EXEC);
  for (const lane of ['p1', 't1', 'a1']) runLane(st, 'sess-wp', 'b-wp', lane);
  // 残留 pendingBatch 场景：complete 兜底清理
  st.writeGovernance('sess-wp', { pendingBatch: true, pendingSince: 'x' });
  await by.batch_phase.execute({ batchId: 'b-wp', phase: 'complete' }, EXEC);
  assert.equal(st.readGovernance('sess-wp').pendingBatch, false);
  assert.equal(st.readGovernance('sess-wp').pendingSince, null);
});

test('assign_check: C 判定后重评为 A/B → pendingBatch 残留清除（Gap D 修复）', async () => {
  const root = tempRoot('punky-gov-pbc-');
  const st = createStore(root);
  const { tools: tls } = makeGuarded({ store: st, root });
  const by = withDefaultTeam(Object.fromEntries(tls.map((t) => [t.name, t])));
  const EXEC = { agent: { session: { id: 'sess-pbc' } } };
  await by.assign_check.execute({ difficulty: 'C', rationale: '测试：命中门禁/审计判据，需 wave_plan 建批', gate: true }, EXEC); // C → pendingBatch=true
  assert.equal(st.readGovernance('sess-pbc').pendingBatch, true);
  await by.assign_check.execute({ difficulty: 'B', rationale: '测试：需独立上下文，评 B 派单个 subagent', needIsolation: true }, EXEC); // 重评 B → 清残留
  assert.equal(st.readGovernance('sess-pbc').pendingBatch, false);
  assert.equal(st.readGovernance('sess-pbc').pendingSince, null);
  // 回归：C+无批仍挂锁；C+活跃批次清锁
  await by.assign_check.execute({ difficulty: 'C', rationale: '测试：命中门禁/审计判据，需 wave_plan 建批', gate: true }, EXEC);
  assert.equal(st.readGovernance('sess-pbc').pendingBatch, true);
  await by.wave_plan.execute({ batchId: 'b-pbc', tasks: [{ id: 'a' }] }, EXEC);
  await by.assign_check.execute({ difficulty: 'C', rationale: '测试：命中门禁/审计判据，需 wave_plan 建批', gate: true }, EXEC); // C 但已有活跃批次 → 不挂锁
  assert.equal(st.readGovernance('sess-pbc').pendingBatch, false);
});

// ---------- 5. session 显式化兼容（session-compat：显式 sessionID + 兼容不填） ----------
test('assign_check: 显式 session 回显 + 镜像到执行会话，guard 不误拦，建批后双向解锁', async () => {
  const root = tempRoot('punky-gov-compat1-');
  const st = createStore(root);
  const { guardFn, tools: tls } = makeGuarded({ store: st, root });
  const by = withDefaultTeam(Object.fromEntries(tls.map((t) => [t.name, t])));
  const execCtx = { agent: { session: { id: 'sess-real' } } };
  const r = await by.assign_check.execute({ difficulty: 'C', rationale: '测试：命中门禁判据且显式 session，需建批', gate: true, session: 'deploy-x' }, execCtx); // C
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
  const root = tempRoot('punky-gov-compat2-');
  const st = createStore(root);
  const { guardFn, tools: tls } = makeGuarded({ store: st, root });
  const by = withDefaultTeam(Object.fromEntries(tls.map((t) => [t.name, t])));
  const execCtx = { agent: { session: { id: 'sess-real' } } };
  // 镜像前：执行会话未评估 → 门禁 1 误拦（对比基准）
  const before = guardFn()({ name: 'pwsh', agent: { session: { id: 'sess-real' } } });
  assert.ok(before && before.includes('尚未进行任务难度评估'));
  await by.assign_check.execute({ difficulty: 'A', rationale: '测试：单线程直做，仅评估当前动作', session: 'probe-x' }, execCtx); // A
  assert.equal(st.readGovernance('sess-real').lastAssign.form, 'A');
  assert.equal(st.readGovernance('sess-real').lastAssign.mirroredFrom, 'probe-x');
  assert.equal(guardFn()({ name: 'pwsh', agent: { session: { id: 'sess-real' } } }), undefined);
});

test('assign_check: 缺省 session → 落当前执行会话不镜像；无会话上下文 → cli 兜底 + notice', async () => {
  const root = tempRoot('punky-gov-compat3-');
  const st = createStore(root);
  const { tools: tls } = makeGuarded({ store: st, root });
  const by = withDefaultTeam(Object.fromEntries(tls.map((t) => [t.name, t])));
  // 缺省：落 agent.session.id，无镜像
  const r1 = await by.assign_check.execute({ difficulty: 'B', rationale: '测试：需独立上下文，评 B 派单个 subagent', needIsolation: true }, { agent: { session: { id: 'sess-real' } } }); // B
  assert.equal(r1.sessionId, 'sess-real');
  assert.equal(r1.mirroredTo, undefined);
  assert.equal(st.readGovernance('sess-real').lastAssign.form, 'B');
  // 无会话上下文：cli 兜底 + notice 警示
  const r2 = await by.assign_check.execute({ difficulty: 'A', rationale: '测试：单线程直做（无并行/无依赖链）' }, {});
  assert.equal(r2.sessionId, 'cli');
  assert.ok(r2.notice && r2.notice.includes('cli'));
  const gcli = st.readGovernance('cli');
  assert.equal(gcli.lastAssign.form, 'A');
  // 显式传执行会话自身 ID：不触发镜像，mirroredTo 字段完全缺席（undefined/null 均会触发 harness lossless JSON 校验拒绝）
  const r3 = await by.assign_check.execute({ difficulty: 'A', rationale: '测试：单线程直做（无并行/无依赖链）', session: 'sess-real' }, { agent: { session: { id: 'sess-real' } } });
  assert.equal(r3.sessionId, 'sess-real');
  assert.equal(r3.mirroredTo, undefined);
  assert.equal(st.readGovernance('sess-real').mirroredTo, undefined); // 未镜像：命名会话无 mirroredTo 指针
  // lossless round-trip 回归：输出对象必须可无损 JSON 序列化（harness 校验层硬性要求；undefined 值会触发 not lossless 拒绝）
  assert.deepEqual(JSON.parse(JSON.stringify(r1)), r1);
  assert.deepEqual(JSON.parse(JSON.stringify(r3)), r3);
});

// ---------- 5. 难度门禁 v3：只读侦察面 + 主动写入难度/判据（无默认档） ----------
test('guard: 未评估态只读 shell 放行且不计数；写命令仍拦（只读侦察面）', () => {
  const root = tempRoot('punky-gov-ro-');
  const st = createStore(root);
  const { guardFn } = makeGuarded({ store: st, root });
  const call = (name, args, sess) => guardFn()({ name, arguments: args, agent: { session: { id: sess ?? 'sess-ro' } } });
  // 只读命令：任何评估状态下放行（未评估态实测）
  assert.equal(call('pwsh', { command: 'Get-ChildItem -Force' }), undefined);
  assert.equal(call('bash', { command: 'git status --porcelain' }), undefined);
  assert.equal(call('pwsh', { command: 'Get-ChildItem | Select-String -Pattern guard' }), undefined);
  assert.equal(call('pwsh', { command: 'Get-Content -Encoding UTF8 docs\\engine-open-items.md' }), undefined);
  const execRoBefore = st.readGovernance('sess-ro').execToolCount ?? 0; // 前值快照（G6 基线）
  assert.equal(execRoBefore, 0, '读命令不计数：不占 stale 评估窗口');
  // 写命令：仍被门禁 1 拦（只读面不是免检通道）
  const w = call('pwsh', { command: 'Set-Content out.txt -Value x' });
  assert.ok(w && w.includes('[task-difficulty-gate]') && w.includes('才能执行 pwsh'));
  // 【G4-A · I-26 语义变更对齐】被拒**精确不计数**（拒态零写；与 mode-gate G2 同改法）
  assert.equal(st.readGovernance('sess-ro').execToolCount ?? 0, execRoBefore, '执行型被拒亦不计数（精确前值，拒态零写）');
  // shell 工具但缺 command / 含写入重定向 → fail-closed（按执行型处理）
  assert.ok(call('pwsh', {}));
  assert.ok(call('pwsh', { command: 'Get-Content a.md > b.txt' }));
  // 【对照组·必写，置于末位】「被拒不计数」≠「不再计数」：放行路径必须**精确 +1**。
  //   ⚠ 必须放在上面几条「未评估 ⇒ 拒」之后：一旦种下 `lastAssign`（已评估），后续调用都会放行，
  //   把它们排在这里之前会让那几条 fail-closed 断言失去拒因（本用例首版即踩此坑）。
  st.writeGovernance('sess-ro', {
    lastAssign: { form: 'A', difficulty: 'A', rationale: '只读侦察面放行对照', at: new Date().toISOString() },
  });
  assert.equal(call('pwsh', { command: 'Set-Content out2.txt -Value y' }), undefined, '已评估 ⇒ 写命令放行');
  assert.equal(st.readGovernance('sess-ro').execToolCount ?? 0, execRoBefore + 1, '放行路径照常计数（精确前值 +1，与上面的 0 成对）');
});

test('guard: 旧记录（有 form 无 difficulty）按未评估处理（升级后一次性重评）', () => {
  const root = tempRoot('punky-gov-legacy-');
  const st = createStore(root);
  const { guardFn } = makeGuarded({ store: st, root });
  const call = (name) => guardFn()({ name, agent: { session: { id: 'sess-legacy' } } });
  st.writeGovernance('sess-legacy', { lastAssign: { form: 'A', scope: 'full', at: new Date().toISOString(), reasons: [], execCallsSince: 0 } });
  const r = call('write');
  assert.ok(r && r.includes('尚未进行任务难度评估'));
  // 补上 v3 字段（difficulty）后放行
  st.writeGovernance('sess-legacy', { lastAssign: { difficulty: 'A', form: 'A', scope: 'full', rationale: '测试：v3 记录', at: new Date().toISOString(), reasons: [], execCallsSince: 0 } });
  assert.equal(call('write'), undefined);
});

test('assign_check: 无默认档——缺 difficulty / 缺判据 / 判据过短一律拒且零写入', async () => {
  const root = tempRoot('punky-gov-req-');
  const st = createStore(root);
  const { tools: tls } = makeGuarded({ store: st, root });
  const by = withDefaultTeam(Object.fromEntries(tls.map((t) => [t.name, t])));
  // 【R3-2 实测 · 判据分层】本用例原断言为 `/difficulty/` · `/rationale/`（只锁**分支词**，不锁**码**）。
  //   收紧时实测发现更强的结论——**拒态来自哪一层**：
  //     · 缺 `difficulty` / `difficulty:'C+'` / 缺 `rationale`  ⇒ 由**声明面**（DSH 工具参数校验）拦下，
  //       `ToolArgsError: missing required property "difficulty"` / `must be one of ["A","B","C","D"]`
  //       —— 因为 `assign_check` 的 `parameters` 已声明 `difficulty:{required:true,enum:['A','B','C','D']}`
  //       与 `rationale:{required:true}`（`lib/tools/core.js:862`）；
  //     · `rationale:'太短'` ⇒ schema 只声明 `type:string`（无 `minLength`）⇒ 放行到**引擎门**，
  //       抛 `GATE_DIFFICULTY_RATIONALE_MISSING`（`lib/tools/core.js:887`）。
  //   ⇒ 结论：**`GATE_DIFFICULTY_INVALID`（`core.js:881`）在工具面不可达**（两条分支均被声明面遮蔽，
  //     覆盖其全部调用形态）；`GATE_DIFFICULTY_RATIONALE_MISSING` **部分可达**（仅"值过短"分支）。
  //     判读与建议已登记 `docs/gate-assertion-blueprint-2026-09-21.md` §6（本波零 lib 改动：只登记不修）。
  //   下面按**实际拒态层**如实断言；对遮蔽分支加**绊线**——遮蔽一旦解除（schema 放松），断言即转红，
  //   提示把判据改回引擎码并同步 §6 判读。
  const shadowed = (code) => (e) => {
    const msg = String(e?.message ?? e);
    assert.equal(new RegExp(code).test(msg), false,
      '绊线：' + code + ' 本应在声明面被遮蔽（若转红 ⇒ 遮蔽已解除，须改判并同步蓝图 §6）：' + msg);
    assert.match(msg, /invalid arguments/, '声明面拒态须仍是参数校验错误：' + msg);
    return true;
  };
  await assert.rejects(() => by.assign_check.execute({ rationale: '测试：仅给判据不给难度值' }, {}), shadowed('GATE_DIFFICULTY_INVALID'));
  await assert.rejects(() => by.assign_check.execute({ difficulty: 'A' }, {}), shadowed('GATE_DIFFICULTY_RATIONALE_MISSING'));
  await assert.rejects(() => by.assign_check.execute({ difficulty: 'C+', rationale: '测试：C+ 档已撤销，不应被接受' }, {}), shadowed('GATE_DIFFICULTY_INVALID'));
  // 唯一可达分支：值过短（schema 无 minLength）⇒ 必达引擎门，锁**全码**（机器可读契约）
  await assert.rejects(() => by.assign_check.execute({ difficulty: 'A', rationale: '太短' }, {}), /GATE_DIFFICULTY_RATIONALE_MISSING/);
  assert.equal(st.readGovernance('cli').lastAssign, null); // 拒收路径零写入
});

test('assign_check: 声明与特征矛盾 → 拒 GATE_DIFFICULTY_MISMATCH（零写入）', async () => {
  const root = tempRoot('punky-gov-mm-');
  const st = createStore(root);
  const { tools: tls } = makeGuarded({ store: st, root });
  const by = withDefaultTeam(Object.fromEntries(tls.map((t) => [t.name, t])));
  // 声明 C 但四项 C 判据全 false（单线程不许建批）
  await assert.rejects(() => by.assign_check.execute({ difficulty: 'C', rationale: '测试：声明 C 但无并行/无依赖判据' }, {}), /GATE_DIFFICULTY_MISMATCH/);
  // 声明 A 但命中并行判据
  await assert.rejects(() => by.assign_check.execute({ difficulty: 'A', rationale: '测试：声明 A 却填了并行判据', parallel: true }, {}), /GATE_DIFFICULTY_MISMATCH/);
  // 声明 B 但命中门禁判据
  await assert.rejects(() => by.assign_check.execute({ difficulty: 'B', rationale: '测试：声明 B 却填了门禁判据', gate: true }, {}), /GATE_DIFFICULTY_MISMATCH/);
  // 声明 A 但需要独立上下文（A 类不派 subagent）
  await assert.rejects(() => by.assign_check.execute({ difficulty: 'A', rationale: '测试：声明 A 却需要独立上下文', needIsolation: true }, {}), /GATE_DIFFICULTY_MISMATCH/);
  assert.equal(st.readGovernance('cli').lastAssign, null);
});

test('assign_check: 难度与判据落 governance.json（审计面：lastAssign + history 双留痕）', async () => {
  const root = tempRoot('punky-gov-audit-');
  const st = createStore(root);
  const { tools: tls } = makeGuarded({ store: st, root });
  const by = withDefaultTeam(Object.fromEntries(tls.map((t) => [t.name, t])));
  const rationale = '只读侦察：core.js 门禁 1 无 difficulty 分支、assign_check 由布尔推导；单线程串行改造，无并行任务线 ⇒ 不建批';
  const r = await by.assign_check.execute({ difficulty: 'A', rationale }, { agent: { session: { id: 'sess-audit' } } });
  const g = st.readGovernance('sess-audit');
  assert.equal(r.difficulty, 'A');
  assert.equal(r.rationale, rationale);
  assert.equal(r.form, 'A'); // legacy 字段与难度同值（guard 门禁 2/3 读端兼容）
  assert.equal(g.lastAssign.difficulty, 'A');
  assert.equal(g.lastAssign.rationale, rationale);
  const last = g.history[g.history.length - 1];
  assert.equal(last.difficulty, 'A');
  assert.equal(last.rationale, rationale);
  // 磁盘 JSON 可解析（原子写 + 审计可读）
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(st.sessionsDir, 'sess-audit', 'governance.json'), 'utf8')));
});

test('assign_check: 有解释的偏离 → 放行 + derived/override 落盘（Q-B1=B，2026-09-14）', async () => {
  const root = tempRoot('punky-gov-ovr-');
  const st = createStore(root);
  const { tools: tls } = makeGuarded({ store: st, root });
  const by = withDefaultTeam(Object.fromEntries(tls.map((t) => [t.name, t])));
  // ① 有解释：**结构化 deviation** 承载三要素（特征面引用 / 例外 / 方向与上限）→ 放行
  //   【G5-L 乙改 · 规格波前】三要素不再从 rationale 自由文本提取 ⇒ 必须补 deviation；
  //   断言**未放宽**（仍要求 override:true / derived:'A' 落盘），只是把「解释」的载体换成结构化字段。
  const rationale = '偏离：四项 C 判据（parallel/multiRole/gate/recoverable）全为 false，本例的例外是三条修正线虽串行但耗时长，仍升档建批，上限不超过 C';
  const deviation = {
    feature: '依据面：parallel/multiRole/gate/recoverable 四项 C 判据全为 false（机械推导为 A）',
    counterpoint: '例外：三条修正线虽可串行，但每条跨多文件且需独立验收 ⇒ 单线程直做风险过高',
    direction: '偏离方向：升档至 C 建批；上限：不超过 C，不泛化为全批',
  };
  const r = await by.assign_check.execute({ difficulty: 'C', rationale, deviation }, { agent: { session: { id: 'sess-ovr' } } });
  assert.equal(r.difficulty, 'C');
  assert.equal(r.derived, 'A', 'derived 由引擎机械推导（不靠自述 ⇒ 可核事实）');
  assert.equal(r.override, true);
  assert.equal(r.form, 'C');
  const g = st.readGovernance('sess-ovr');
  assert.equal(g.lastAssign.derived, 'A');
  assert.equal(g.lastAssign.override, true);
  assert.equal(g.lastAssign.rationale, rationale);
  assert.equal(g.history[g.history.length - 1].override, true);
  assert.equal(g.pendingBatch, true, 'C 类（含偏离）仍置 pendingBatch');
  // ② 常规路径：difficulty === derived → override=false
  const r2 = await by.assign_check.execute({ difficulty: 'A', rationale: '只读侦察：单线程串行，无并行任务线、无依赖链' }, { agent: { session: { id: 'sess-ovr2' } } });
  assert.equal(r2.derived, 'A');
  assert.equal(r2.override, false);
  assert.equal(st.readGovernance('sess-ovr2').lastAssign.override, false);
  // ③ 偏离但解释只命中一要素 → 仍拒（三要素缺一不可）
  await assert.rejects(
    () => by.assign_check.execute({ difficulty: 'B', rationale: '偏离说明：本任务需按 multiRole 判定' }, {}),
    /偏离须解释/,
  );
});

test('两阶段锚定：只读侦察 → 写入判据 → 全工具面开放（C 类判定后只读命令仍放行）', async () => {
  const root = tempRoot('punky-gov-2phase-');
  const st = createStore(root);
  const { guardFn, tools: tls } = makeGuarded({ store: st, root });
  const by = withDefaultTeam(Object.fromEntries(tls.map((t) => [t.name, t])));
  const ctx = { agent: { session: { id: 'sess-2p' } } };
  const call = (name, args) => guardFn()({ name, arguments: args, agent: { session: { id: 'sess-2p' } } });
  // 阶段 1：只读侦察（放行）+ 执行型（拦）
  assert.equal(call('pwsh', { command: 'rg -n "difficulty" lib' }), undefined);
  assert.ok(call('write', {}));
  // 阶段 2：写入难度 + 判据
  await by.assign_check.execute({ difficulty: 'C', rationale: '只读侦察：任务含两条可并行任务线（guard 与契约各自独立），需 wave_plan 建批', parallel: true }, ctx);
  assert.equal(st.readGovernance('sess-2p').pendingBatch, true);
  // 阶段 3：C 未建批 → 执行型仍拦；只读命令**不受** pendingBatch 影响（读不是执行）
  assert.ok(call('write', {}).includes('必须先 wave_plan 建批'));
  assert.equal(call('pwsh', { command: 'git log -n 3 --oneline' }), undefined);
});

// ══════════════════════════════════════════════════════════════════════════════
// 双轴判据（难度轴 `derived` + 通道轴 `derivedChannel`）· D 场景三例
// 判据源：`plan/scope.md` AC-3（关键格①）/ AC-4 / AC-7（关键格②）/ AC-8（Q-5）
// 归属批次：`d-override-fix-20261011`（lane `e3-tests`；被检实现归 `e1-engine`）
// 口径：D ≡ **建批档 + team 通道**；**D 不入难度轴**（难度轴仍为 A/B/C）
// ══════════════════════════════════════════════════════════════════════════════

/** D 场景夹具：真 store + 真工具面（与既有 `makeGuarded` 同源形态，写点全落隔离临时根）。 */
function makeDAxisHarness(prefix, sessionId) {
  const root = tempRoot(prefix);
  const st = createStore(root);
  const { tools: tls } = makeGuarded({ store: st, root });
  const by = withDefaultTeam(Object.fromEntries(tls.map((t) => [t.name, t])));
  return { st, by, ctx: { agent: { session: { id: sessionId } } } };
}

test('AC-3（关键格①）双轴判据：声明 D + durableSeats:true ⇒ derived=C / derivedChannel=team / override=false / overrideKind=null', async () => {
  const h = makeDAxisHarness('punky-gov-daxis-', 'sess-d-axis');
  // 关键点：**不填任何 C 判据布尔**（parallel/multiRole/gate/recoverable 全缺省），且 rationale 不含
  //   A/B/C 特征词 —— 这正是「原实现 D 恒 override=true ⇒ 合规 D 被误拒、只能塞话术」的修复面。
  const rationale = '只读侦察：本任务需 durable 席位与 team 通道的事件队列交接（而非 subagent 的一次性派发）；'
    + '通道方向与上限：不泛化为全批，团队面缺失时显式降级为 C';
  const r = await h.by.assign_check.execute(
    { difficulty: 'D', durableSeats: true, needIsolation: true, rationale, scope: 'full' }, h.ctx);

  assert.equal(r.derived, 'C', '难度轴：durableSeats=true ⇒ 机械推导 C（D 不入难度轴）');
  assert.equal(r.derivedChannel, 'team', '通道轴：durableSeats=true ⇒ team（独立推导，与难度轴无耦合）');
  assert.equal(r.override, false, 'AC-3 关键格①：D 正当形态 ⇒ 回归常规路径（不得记偏离）');
  assert.equal(r.overrideKind, null, 'AC-3：overrideKind 恒 null（闭集 schema 已登记该键）');
  assert.equal(r.allowed, false, 'D 与 C 同属建批档 ⇒ 不得直做');
  assert.deepEqual(r.next, ['wave_plan'], 'D 档下一步仍要求建批');
  assert.equal(r.notice, '', '常规路径不得夹带任何提示/告警');

  const g = h.st.readGovernance('sess-d-axis');
  assert.equal(g.lastAssign.difficulty, 'D', '档位面照写 D');
  assert.equal(g.lastAssign.derived, 'C');
  assert.equal(g.lastAssign.derivedChannel, 'team', 'AC-6：lastAssign 逐键落 derivedChannel');
  assert.equal(g.lastAssign.overrideKind, null, 'AC-6：lastAssign 逐键落 overrideKind');
  assert.equal(g.pendingBatch, true, 'D 档未建批 ⇒ 照旧挂 pendingBatch（门禁 2 生效面）');
  const tail = g.history[g.history.length - 1];
  assert.equal(tail.derivedChannel, 'team', 'AC-6：history 末条含 derivedChannel');
  assert.equal(tail.override, false);
});

test('AC-7（关键格②）+AC-4：声明 D 而通道轴=dispatch ⇒ 拒（逐项列缺 + 两条正范式 + 零写入）；补全通道三要素 ⇒ 放行 override=true / overrideKind=channel', async () => {
  const h = makeDAxisHarness('punky-gov-dchan-', 'sess-d-chan');
  // ① 无通道依据（只写「按团队方案推进」这类空话 ⇒ 要素②③ 缺）⇒ 拒
  const emptyTalkRationale = '测试：本次直接评 D 档建批，按团队方案推进';
  await assert.rejects(
    () => h.by.assign_check.execute({ difficulty: 'D', rationale: emptyTalkRationale, parallel: true }, h.ctx),
    (e) => {
      const m = String(e?.message ?? e);
      assert.match(m, /GATE_DIFFICULTY_MISMATCH/, '缺通道依据须拒（复用既有码）');
      assert.match(m, /通道偏离须解释/, '文案须分叉说「通道偏离」（存量 tier 支文案不得混用）');
      assert.match(m, /② 为何 durable 而非 subagent/, '缺项须逐项列出（② 缺）');
      assert.match(m, /③ 通道方向与上限/, '缺项须逐项列出（③ 缺）');
      assert.match(m, /durableSeats:true/, '正范式①：给出可照做的重评调用');
      assert.match(m, /显式降级为 C/, '正范式②：给出显式降级出口（禁静默降级）');
      return true;
    });
  assert.equal(h.st.readGovernance('sess-d-chan').lastAssign, null, 'AC-7：拒态零治理写入（lastAssign 不落盘）');

  // ② 补齐通道三要素 ⇒ 放行，且为「唯一保留的偏离」：override=true / overrideKind='channel'
  //   【G5-L 乙改 · 规格波前】三要素改由结构化 `deviation` 承载（rationale 只是判据正文）。
  const rationale = '测试：本任务引用 team 通道与 durable 席位面；为何 durable 而非 subagent（需事件队列交接，'
    + '而非一次性派发）；通道方向与上限：不泛化为全批，team 面缺失须显式降级为 C';
  const channelDeviation = {
    feature: '通道依据：需 team 事件队列交接与 durable 席位面（通道轴机械推导为 dispatch）',
    counterpoint: '为何 durable 而非 subagent：一次性派发无法承载跨轮席位与事件交接',
    direction: '通道方向与上限：不泛化为全批；team 面缺失须显式降级为 C（禁静默降级）',
  };
  const r = await h.by.assign_check.execute({ difficulty: 'D', rationale, parallel: true, deviation: channelDeviation }, h.ctx);
  assert.equal(r.derivedChannel, 'dispatch', 'durableSeats 缺省 ⇒ 通道轴 dispatch（偏离根因）');
  assert.equal(r.derived, 'C', 'parallel=true ⇒ 难度轴 C（与通道轴独立）');
  assert.equal(r.override, true, 'D 通道变体 = 唯一保留的偏离');
  assert.equal(r.overrideKind, 'channel', 'overrideKind 分叉到 channel（不得误记为 tier）');
  const g = h.st.readGovernance('sess-d-chan');
  assert.equal(g.lastAssign.overrideKind, 'channel', '落盘逐键一致');
  assert.equal(g.lastAssign.derivedChannel, 'dispatch');
});

test('AC-8（Q-5 留痕提示）：fixedRole=true 而判 B ⇒ 不硬拒 + notice 含 WARN_DTIER_FIXED_ROLE_AS_LOWER + 档位照写', async () => {
  const h = makeDAxisHarness('punky-gov-dfixed-', 'sess-d-fixed');
  // 偏离支（声明 B 而机械推导 C）仍按存量语义过三要素，但**载体改为结构化 deviation**
  //   【G5-L 乙改 · 规格波前】① needIsolation（特征面）② 本例的例外 ③ 上限 —— 三条搬进 deviation 子键。
  const rationale = '测试：本任务角色与流程固定（三层席位形态）但本次仅单步 needIsolation 调研，'
    + '本例的例外是固定形态尚未落到席位面；判据偏保守不升档，上限不超过 B';
  const tierDeviation = {
    feature: '依据面：needIsolation=true（机械推导为 C）',
    counterpoint: '例外：固定形态尚未落到席位面，本次仅单步调研 ⇒ 机械升档不成立',
    direction: '偏离方向：不升档，维持 B；上限：不超过 B',
  };
  const r = await h.by.assign_check.execute(
    { difficulty: 'B', fixedRole: true, needIsolation: true, rationale, scope: 'full', deviation: tierDeviation }, h.ctx);

  assert.match(String(r.notice ?? ''), /WARN_DTIER_FIXED_ROLE_AS_LOWER/, 'Q-5：固定形态判低档须留痕提示码');
  assert.match(String(r.notice ?? ''), /固定任务形态/, '提示须点明成因（固定任务形态）');
  assert.match(String(r.notice ?? ''), /D（team 席位/, '提示须给正解：固定任务宜评 D（team 席位）');
  assert.match(String(r.notice ?? ''), /不硬拒/, '须显式声明「首期仅留痕提示，不硬拒」');
  assert.equal(r.difficulty, 'B', '不硬拒：声明档位照写（未被改写）');
  const text = h.by.assign_check.output.render({}, r)[0].text;
  assert.match(text, /⚠ WARN_DTIER_FIXED_ROLE_AS_LOWER/, 'render 须以 `⚠ ` 前缀外显（工具行可见）');
  const g = h.st.readGovernance('sess-d-fixed');
  assert.equal(g.lastAssign.difficulty, 'B', 'AC-8：lastAssign.difficulty 保持 B');
  assert.equal(g.pendingBatch, false, 'B 档不挂批锁');
});

// ══════════════════════════════════════════════════════════════════════════════════════
// W7F-FU-U1 · `bumpExecCount` 节流 + `flushDirtyGovernance()` 落盘增量与幂等
//   batch `punky-debt-sweep-20261020` · lane `e3-tests`｜判据源 `plan/scope.md` §5.2（B1-B4）
//
// 判据形态（Lead 特别强调，勿退化为「不抛异常」）：
//   ❌「二次 flush 不抛异常」—— 什么都不做也不抛；
//   ✅「二次 flush **无新增写**」= 磁盘字节前后**逐字节相同**，且对照「第一次 flush **确有** +1」。
// 观测面 = **磁盘文件** `<root>/sessions/<S>/governance.json` 的字节与 JSON 字段（不是返回值）。
// 节流常量：`EXEC_FLUSH_EVERY = 10`、`EXEC_FLUSH_INTERVAL_MS = 30s` ⇒ 1 次 bump 必留在内存。
// ══════════════════════════════════════════════════════════════════════════════════════
test('W7F-FU-U1 bumpExecCount 节流：1 次未落盘（磁盘差 0）→ flush 后 +1 → 二次 flush 幂等（字节不变）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-u1-flush-'));
  const st = createStore(root, { logger: { warn() {}, info() {}, error() {} } });
  const SU = 'sess-u1-flush'; // 独立会话键：不与其他用例的 pending 互扰

  // 前置（阳性基线）：先把 governance.json 落盘一次 ⇒ 文件存在、`execToolCount` 可读
  st.writeGovernance(SU, {});
  const file = st.governanceFile(SU);
  assert.equal(fs.existsSync(file), true, '前置：governance.json 须已落盘（否则「字节不变」没有对象）');
  const before = fs.readFileSync(file);
  const beforeCount = st.readGovernance(SU).execToolCount;
  assert.equal(beforeCount, 0, '前置：初始 execToolCount 须为 0（实测 ' + beforeCount + '）');

  // ── B1：bump 1 次（< 10 阈值）⇒ **磁盘字节差 0**（未落盘） ──────────────────────────
  // 阳性对照（同块内）：**返回值**必须已 +1 —— 证明计数确实发生在内存，
  //   否则「磁盘不变」可以由「bump 根本没做事」造成（不可证伪）。
  const merged = st.bumpExecCount(SU);
  assert.equal(merged.execToolCount, beforeCount + 1,
    'B1 阳性对照：bump 的合并返回值须 +1（实测 ' + merged.execToolCount + '）');
  const afterBump = fs.readFileSync(file);
  assert.equal(Buffer.compare(before, afterBump), 0, 'B1：1 次 bump（<阈值）后磁盘字节须**逐字节相同**（未落盘）');
  // 观测面纪律：**必须直读磁盘**。`readGovernance()` 是「磁盘 + 内存 pending」的**合并读**（设计如此：
  //   让调用方不必等落盘即可看到真值）⇒ 拿它当「磁盘真值」会读到 +1 的假值（本件首轮即踩中，
  //   由本行下方断言抓住）。判据要的是「落盘了没有」⇒ 只能看文件字节。
  assert.equal(JSON.parse(afterBump.toString('utf8')).execToolCount, beforeCount,
    'B1：磁盘内的 execToolCount 须仍为旧值（未经 flush 不得落盘）');

  // ── B2：`flushDirtyGovernance()` 后 ⇒ 磁盘 `execToolCount` **+1**（B1 的 0 差是它的前置）──
  flushDirtyGovernance();
  const afterFlush = fs.readFileSync(file);
  assert.equal(Buffer.compare(before, afterFlush) === 0, false, 'B2：flush 后磁盘字节须**已变化**（阳性：确有落盘）');
  assert.equal(JSON.parse(afterFlush.toString('utf8')).execToolCount, beforeCount + 1,
    'B2：flush 后磁盘 execToolCount 须恰 +1（实测 ' + JSON.parse(afterFlush.toString('utf8')).execToolCount + '）');

  // ── B3：再次 flush ⇒ 磁盘字节**逐字不变**（幂等，无重复累加 +2） ─────────────────────
  flushDirtyGovernance();
  const afterSecond = fs.readFileSync(file);
  assert.equal(Buffer.compare(afterFlush, afterSecond), 0,
    'B3：二次 flush 须**无新增写**（字节逐字相同）；增量 = ' + (afterSecond.length - afterFlush.length));
  assert.equal(JSON.parse(afterSecond.toString('utf8')).execToolCount, beforeCount + 1,
    'B3：二次 flush 不得累加成 +2（实测 ' + JSON.parse(afterSecond.toString('utf8')).execToolCount + '）');
});
