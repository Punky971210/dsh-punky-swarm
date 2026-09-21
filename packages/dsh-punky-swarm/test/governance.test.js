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
import { threeTierTasks, seedArtifacts, runLane, registerManager } from './helpers/gate-fixture.mjs';
import { seedTeamAssetSkills, withDefaultTeam } from './helpers/host-skills.mjs';

// 【P1 同步 · 前置】团队资产的 skills 必须可解析（不可解析/技能根缺失 ⇒ `TEAM_ASSET_SKILLS_MISMATCH` 拒建批）
//   ⇒ 隔离 HOME 下先注入宿主技能根；本套件建批统一补 `software-team`（见各 harness 的 withDefaultTeam）。
seedTeamAssetSkills('software-team');

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
const toolsRoot = freshRoot('punky-gov-tools-');
const toolsStore = createStore(toolsRoot);
const { tools } = createTools({ tools: { register: () => {} }, logger: console }, { store: toolsStore, root: toolsRoot });
// 【P1 同步】`team` 现为必填且必须解析到资产（无资产 ⇒ 构造期拒）⇒ 本套件（建批只是手段、被检面是治理门）统一补
//   包内软件团队；其声明技能须可解析 ⇒ 隔离 HOME 下显式注入宿主技能根（见 helpers/host-skills.mjs 口径）。
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

// Manager 拉起留痕：把「C+ 批是否真拉起 Manager」从自述旁证升级为治理层可核事实
test('batch_phase: manager 拉起登记（批字段 + 事件 + 三重门禁）', async () => {
  await byName.wave_plan.execute({ batchId: 'b-mgr', tasks: [{ id: 'a' }] }, AC_SESS);
  const call = (args) => byName.batch_phase.execute(args, AC_SESS);
  // 门禁①：**本断言由本批新语义替代（旧口径：planning 期登记被拒 「Manager 相位非法」码(已删)）**。
  //   C-1 决议：准入从 `phase === 'running'` 改为「批次非终态」（planning/running/paused 可登记），
  //   对齐用户口径「建批即拉起，不绑定 running」。落点 lib/state/store.js:573-575（writer = e2）。
  //   断言面：登记成功、**不改批次阶段**、写批字段 + 恰一条 batch.manager.raised 事件。
  const r0 = await call({ batchId: 'b-mgr', manager: { agentId: 'mgr-1' } });
  assert.equal(r0.phase, 'planning', 'C-1：planning 期可登记，且仅登记不改阶段');
  assert.equal(r0.manager.agentId, 'mgr-1');
  const b0 = toolsStore.readBatch('sess-ac', 'b-mgr');
  assert.equal(b0.phase, 'planning', 'C-1：登记不得顺带迁移批次阶段');
  assert.equal(b0.manager.agentId, 'mgr-1');
  assert.equal(b0.events.filter((e) => e.type === 'batch.manager.raised').length, 1);
  await call({ batchId: 'b-mgr', phase: 'running' });
  // 门禁②：【gate-lite 第二批 · A（2026-09-17 用户裁决「全删」）】**翻转** —— 原断言
  //   `assert.rejects(/「Manager agentId 必填」码(已删)/)` 对应码已删 ⇒ 空/空白 agentId **不再报门禁错**：
  //   语义 = 「不写垃圾记录 + 单独调用时走既有显式报错分支（`requires "phase" or "manager"`）」，即**不静默 no-op**。
  await assert.rejects(() => call({ batchId: 'b-mgr', manager: {} }), /requires "phase" or "manager"/,
    '空 agentId ⇒ 不写记录；无 phase 的单独调用如实报错（不静默）');
  await assert.rejects(() => call({ batchId: 'b-mgr', manager: { agentId: '   ' } }), /requires "phase" or "manager"/,
    '空白 agentId（trim 后为空）同判');
  const bEmpty = toolsStore.readBatch('sess-ac', 'b-mgr');
  assert.equal(bEmpty.manager.agentId, 'mgr-1', '结构断言保留：空登记**不覆盖**既有 manager 字段（不写垃圾）');
  assert.equal(bEmpty.events.filter((e) => e.type === 'batch.manager.raised').length, 1, '空登记不新增 manager.raised 事件');
  // 正常登记：单独调用（不传 phase）→ 不改阶段，写批字段 + 事件
  const r = await call({ batchId: 'b-mgr', manager: { agentId: 'mgr-1', note: 'C+' } });
  assert.equal(r.phase, 'running');
  assert.equal(r.manager.agentId, 'mgr-1');
  const b = toolsStore.readBatch('sess-ac', 'b-mgr');
  assert.equal(b.phase, 'running');
  assert.equal(b.manager.agentId, 'mgr-1');
  assert.ok(b.manager.raisedAt);
  assert.equal(b.events.filter((e) => e.type === 'batch.manager.raised').length, 1);
  assert.equal(b.events.find((e) => e.type === 'batch.manager.raised').agentId, 'mgr-1');
  // 阶段迁移与登记同一次调用；**同 agentId 幂等** ⇒ 不重复写事件（仍为 1 条）
  await call({ batchId: 'b-mgr', phase: 'paused', manager: { agentId: 'mgr-1' } });
  const b2 = toolsStore.readBatch('sess-ac', 'b-mgr');
  assert.equal(b2.phase, 'paused');
  assert.equal(b2.events.filter((e) => e.type === 'batch.manager.raised').length, 1, '同 agentId 重复登记幂等：不产重复事件');
  // 门禁③：【gate-lite 第二批 · A（2026-09-17 用户裁决「全删」）】**翻转为放行** —— 原断言
  //   `assert.rejects(… /「Manager 终态」码(已删)/ 且非 PHASE_INVALID…)` 两码已删 ⇒ 终态批**亦可登记事实**
  //   （在册判定的新真源 = 官方 roster；legacy 字段仅作观察面）。
  //   保留原结构断言：登记**不改批次阶段**、幂等（不重复写事件）。
  await call({ batchId: 'b-mgr', phase: 'aborted' });
  assert.equal(toolsStore.readBatch('sess-ac', 'b-mgr').phase, 'aborted', '前置：批已终态');
  const rTerm = await call({ batchId: 'b-mgr', manager: { agentId: 'mgr-2' } });
  assert.equal(rTerm.manager.agentId, 'mgr-2', '终态批登记不再拒（码已删），返回登记事实');
  const bTerm = toolsStore.readBatch('sess-ac', 'b-mgr');
  assert.equal(bTerm.phase, 'aborted', '结构断言保留：登记不改批次阶段（终态仍终态）');
  assert.equal(bTerm.events.filter((e) => e.type === 'batch.manager.raised').length, 2,
    '换 agentId ⇒ 恰一条新事件（mgr-1 + mgr-2 = 2；同 agentId 幂等已在上一条断言）');
  assert.equal(bTerm.manager.agentId, 'mgr-2', 'legacy 字段改写为最新登记值（终态批亦允许）');
  // 显式补「码面/留痕」断言：新真源读端在位（roster 回显 + 声明值），旧三码在源码面已不存在
  const mgrSrc = fs.readFileSync(new URL('../lib/state/store.js', import.meta.url), 'utf8');
  assert.ok(!/GATE_MANAGER_TERMINAL|GATE_MANAGER_PHASE_INVALID|GATE_MANAGER_AGENT_ID_REQUIRED/.test(
    mgrSrc.replace(/^[ \t]*\/\/.*$/gm, '')), '三码不得在 store.js 生产面回生（注释史迹除外）');
  // 既无 phase 又无 manager → 明确报错（不静默 no-op）
  await assert.rejects(() => call({ batchId: 'b-mgr' }), /requires "phase" or "manager"/);
});

// A1：终态批次冻结——complete / aborted 之后任何成员迁移一律拒（防「已收口批次被改写成 running」）
test('A1: 终态批次拒绝成员迁移（GATE_BATCH_TERMINAL）', async () => {
  await byName.wave_plan.execute({ batchId: 'b-term', tasks: [{ id: 'a' }] }, AC_SESS);
  await byName.batch_phase.execute({ batchId: 'b-term', phase: 'running' }, AC_SESS);
  await byName.batch_phase.execute({ batchId: 'b-term', phase: 'aborted' }, AC_SESS);
  await assert.rejects(
    () => byName.member_status.execute({ batchId: 'b-term', lane: 'a', status: 'running' }, AC_SESS),
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
  await byName.member_status.execute({ batchId: 'b-ex', lane: 'x', status: 'running', exempt: { type: 'ai-render' } }, AC_SESS);
  assert.ok(toolsStore.readBatch('sess-ac', 'b-ex').laneExempt.x, '派发面授予后应有豁免条目');
  await byName.member_status.execute({ batchId: 'b-ex', lane: 'x', status: 'review' }, AC_SESS);
  // 重派不带 exempt：K3 后被拒（非「放行但清退豁免」）
  let re = null;
  try {
    re = await byName.member_status.execute({ batchId: 'b-ex', lane: 'x', status: 'running' }, AC_SESS);
  } catch (e) {
    re = e;
  }
  const msg = re instanceof Error ? re.message : JSON.stringify(re);
  assert.match(msg, /invalid member transition: review -> running/, 'K3：重派路径应已被去除，实际=' + msg);
  const b = toolsStore.readBatch('sess-ac', 'b-ex');
  assert.equal(b.lanes.x, 'review', '拒 = 零写入 ⇒ 状态不变');
  assert.ok(b.laneExempt?.x != null, 'D7/§6.2「不得静默清退」：豁免条目须仍在（实际=' + JSON.stringify(b.laneExempt ?? null) + '）');
});

// A2：声明 raise（引擎缺省口径）的批未登记 manager → complete 成功但留 gate.manager_missing 告警（非阻断）。
// 2026-09-14 起触发口径 = **按声明**（不再是「按 exec lane 数 ≥3」）——见 A2b 的 leader-direct 反例。
test('A2: 声明 raise 且未登记 manager → complete 成功 + gate.manager_missing 告警', () => {
  const tasks = [
    { id: 'e1', layer: 'exec', role: 'coder' }, { id: 'e2', layer: 'exec', role: 'tester' },
    { id: 'e3', layer: 'exec', role: 'reviewer' }, { id: 'a1', layer: 'audit', role: 'supervisor' },
  ];
  fs.writeFileSync(toolsStore.batchFile('sess-ac', 'b-cplus'), JSON.stringify({
    batchId: 'b-cplus', sessionId: 'sess-ac', phase: 'running', concurrency: 2, wavePlan: [{ tasks }],
    assembly: { managerPlan: 'raise', auditLane: 'a1' },
    lanes: { e1: 'merged', e2: 'merged', e3: 'merged', a1: 'merged' }, events: [], updatedAt: new Date().toISOString(),
  }), 'utf8');
  toolsStore.setPhase('sess-ac', 'b-cplus', 'complete');
  const b = toolsStore.readBatch('sess-ac', 'b-cplus');
  assert.equal(b.phase, 'complete');
  const ev = b.events.find((e) => e.type === 'gate.manager_missing');
  assert.ok(ev, '声明 raise 且未登记 manager 应留告警事件');
  assert.equal(ev.execLanes, 3);
  assert.equal(ev.managerPlan, 'raise', '告警携带声明口径（读端可核）');
});

test('A2b: 声明 leader-direct 且未登记 manager → 不落 manager_missing（修 F7 误报）', () => {
  const tasks = [
    { id: 'e1', layer: 'exec', role: 'coder' }, { id: 'a1', layer: 'audit', role: 'supervisor' },
  ];
  fs.writeFileSync(toolsStore.batchFile('sess-ac', 'b-ld'), JSON.stringify({
    batchId: 'b-ld', sessionId: 'sess-ac', phase: 'running', concurrency: 2, wavePlan: [{ tasks }],
    assembly: { managerPlan: 'leader-direct', auditLane: 'a1' },
    lanes: { e1: 'merged', a1: 'merged' }, events: [], updatedAt: new Date().toISOString(),
  }), 'utf8');
  toolsStore.setPhase('sess-ac', 'b-ld', 'complete');
  const b = toolsStore.readBatch('sess-ac', 'b-ld');
  assert.equal(b.phase, 'complete');
  assert.equal(b.events.some((e) => e.type === 'gate.manager_missing'), false, 'leader-direct 声明不应触发 Manager 缺失告警（声明与告警一政）');
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
  assert.ok(r1.includes('才能执行 pwsh'));
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
  const root = freshRoot('punky-gov-guard3-');
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
  const root = freshRoot('punky-gov-guard4-');
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
  const root = freshRoot('punky-gov-guard5-');
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
  const root = freshRoot('punky-gov-guard6-');
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
  const root = freshRoot('punky-gov-wp-');
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
  // G2 前置（2026-09-14 新门禁）：含 exec 层且声明（缺省归一化）`managerPlan: 'raise'` 的批，**收口/派发前**
  //   须先登记 Manager（否则 entry 门先返 「未拉起 Manager」码(已删)）。本用例被检面是 complete 兜底清锁，
  //   故先按引擎规定路径登记 Manager，保持被检面不变。
  registerManager(st, 'sess-wp', 'b-wp', 'mgr-wp');
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
  const root = freshRoot('punky-gov-pbc-');
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
  const root = freshRoot('punky-gov-compat1-');
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
  const root = freshRoot('punky-gov-compat2-');
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
  const root = freshRoot('punky-gov-compat3-');
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
  const root = freshRoot('punky-gov-ro-');
  const st = createStore(root);
  const { guardFn } = makeGuarded({ store: st, root });
  const call = (name, args, sess) => guardFn()({ name, arguments: args, agent: { session: { id: sess ?? 'sess-ro' } } });
  // 只读命令：任何评估状态下放行（未评估态实测）
  assert.equal(call('pwsh', { command: 'Get-ChildItem -Force' }), undefined);
  assert.equal(call('bash', { command: 'git status --porcelain' }), undefined);
  assert.equal(call('pwsh', { command: 'Get-ChildItem | Select-String -Pattern guard' }), undefined);
  assert.equal(call('pwsh', { command: 'Get-Content -Encoding UTF8 docs\\engine-open-items.md' }), undefined);
  assert.equal(st.readGovernance('sess-ro').execToolCount, 0); // 读命令不计数：不占 stale 评估窗口
  // 写命令：仍被门禁 1 拦（只读面不是免检通道）
  const w = call('pwsh', { command: 'Set-Content out.txt -Value x' });
  assert.ok(w && w.includes('[task-difficulty-gate]') && w.includes('才能执行 pwsh'));
  assert.equal(st.readGovernance('sess-ro').execToolCount, 1); // 执行型被拒也计数
  // shell 工具但缺 command / 含写入重定向 → fail-closed（按执行型处理）
  assert.ok(call('pwsh', {}));
  assert.ok(call('pwsh', { command: 'Get-Content a.md > b.txt' }));
});

test('guard: 旧记录（有 form 无 difficulty）按未评估处理（升级后一次性重评）', () => {
  const root = freshRoot('punky-gov-legacy-');
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
  const root = freshRoot('punky-gov-req-');
  const st = createStore(root);
  const { tools: tls } = makeGuarded({ store: st, root });
  const by = withDefaultTeam(Object.fromEntries(tls.map((t) => [t.name, t])));
  // 【R3-2 实测 · 判据分层】本用例原断言为 `/difficulty/` · `/rationale/`（只锁**分支词**，不锁**码**）。
  //   收紧时实测发现更强的结论——**拒态来自哪一层**：
  //     · 缺 `difficulty` / `difficulty:'C+'` / 缺 `rationale`  ⇒ 由**声明面**（DSH 工具参数校验）拦下，
  //       `ToolArgsError: missing required property "difficulty"` / `must be one of ["A","B","C"]`
  //       —— 因为 `assign_check` 的 `parameters` 已声明 `difficulty:{required:true,enum:['A','B','C']}`
  //       与 `rationale:{required:true}`（`lib/tools/core.js:1002`）；
  //     · `rationale:'太短'` ⇒ schema 只声明 `type:string`（无 `minLength`）⇒ 放行到**引擎门**，
  //       抛 `GATE_DIFFICULTY_RATIONALE_MISSING`（`lib/tools/core.js:1027`）。
  //   ⇒ 结论：**`GATE_DIFFICULTY_INVALID`（`core.js:1021`）在工具面不可达**（两条分支均被声明面遮蔽，
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
  const root = freshRoot('punky-gov-mm-');
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
  const root = freshRoot('punky-gov-audit-');
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
  const root = freshRoot('punky-gov-ovr-');
  const st = createStore(root);
  const { tools: tls } = makeGuarded({ store: st, root });
  const by = withDefaultTeam(Object.fromEntries(tls.map((t) => [t.name, t])));
  // ① 有解释：rationale 命中三要素（特征面引用 / 例外 / 方向与上限）→ 放行
  const rationale = '偏离：四项 C 判据（parallel/multiRole/gate/recoverable）全为 false，本例的例外是三条修正线虽串行但耗时长，仍升档建批，上限不超过 C';
  const r = await by.assign_check.execute({ difficulty: 'C', rationale }, { agent: { session: { id: 'sess-ovr' } } });
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
  const root = freshRoot('punky-gov-2phase-');
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
