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

// 批次 `onto-p4-authz-r2-20260925` · lane `exec-tests`（角色 tester）——**测试锁**：
//   R-1 交接写权（§2.1 判据链 ①owner/②Manager/③dispatch/④roster/⑤fail-closed）+ R-2 覆盖保护（§2.2）。
// 判据源（逐条对照，勿另起口径）：`plan/fix-spec.md` §2.1 / §2.2 / §5 / §6.1 / §6.2；
//   实现自证 = `exec/authz-change.md`；类型面与建批面 = `exec/contract-change.md`。
// ─────────────────────────────────────────────────────────────────────────────
// 纪律（本套件自持）：
//   · **每新增拒态分支**都给成对的「正例（放行）」与「反例（命中该码）」——反例断言**码本体**，
//     不断言「未成功/未报错」（§5「反例须断言命中该码」）。
//   · **拒时零写入**（R1-b）：拒态前后比对**批 JSON 该记录**与**事件流三类计数**（前后差 = 0）。
//   · 非 owner 会话调用 `handoff_submit` 必须**显式给 `args.session`**（批归属会话）——
//     否则 `sessionOf` 回落 `'cli'` ⇒ 在身份门**之前**报 `batch not found`（既有寻址语义，
//     见 `exec/authz-change.md` §7 G-2）。本套件所有非 owner 用例都显式传 `session`。
//   · 身份采集端（工具面）= `exec.agent.session.id` + `ctx.get('agentTeams').listMembers(agent)` 的具名成员；
//     本套件用**受控假 ctx** 提供 roster 名（与真实服务同形：`{ listMembers: () => [{name}, …] }`）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// P1 交接门开关**必须在加载门禁/工具模块之前**置位（门读 env；缺省关闭 ⇒ 关闭态行为与 P1 之前逐字不变）。
process.env.PSWARM_HANDOFF_GATE = '1';

import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { assessC } from './helpers/gate-fixture.mjs';
import * as EVT from '../lib/state/event-types.js';

const SESSION = 'sess-authz';
const SESS = { agent: { session: { id: SESSION } } };
const TEAM = 'authz-team';
const ROLE = { coder: 'coder', designer: 'designer', reviewer: 'reviewer' };

// 三层 DAG：p1(plan) → e1(exec) → e2(exec) → a1(audit)。
//   `rosterOf` 允许给指定 lane 挂 R-3 的 `roster` 承载字段（④ team 席位分支的被检面）。
function tasks({ rosterOf = {} } = {}) {
  const withRoster = (id, t) => (rosterOf[id] ? { ...t, roster: rosterOf[id] } : t);
  return [
    withRoster('p1', { id: 'p1', layer: 'plan', role: ROLE.designer, produce: ['plan/spec.md'], cmd: 'plan-it' }),
    withRoster('e1', { id: 'e1', layer: 'exec', role: ROLE.coder, consume: ['plan/spec.md'], outputs: ['exec/e1.md'], deps: ['p1'], cmd: 'build-it' }),
    withRoster('e2', { id: 'e2', layer: 'exec', role: ROLE.coder, consume: ['exec/e1.md'], outputs: ['exec/e2.md'], deps: ['e1'], cmd: 'build-more' }),
    withRoster('a1', { id: 'a1', layer: 'audit', role: ROLE.reviewer, consume: ['plan/spec.md', 'exec/e1.md', 'exec/e2.md'], produce: ['audit/a1.md'], deps: ['e2'], cmd: 'verify-it' }),
  ];
}

function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-authz-'));
  const teamsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-authz-teams-'));
  const store = createStore(root);
  // 受控 roster 服务（**与官方服务同形**：`listMembers(agent)` ⇒ `TeamMemberView[]`）。
  const rosterMembers = [];
  const ctx = {
    tools: { register: () => {} },
    logger: { info() {}, warn() {}, error() {} },
    get: (svc) => (svc === 'agentTeams'
      ? { listMembers: () => rosterMembers.map((name) => ({ name })) }
      : undefined),
  };
  const { tools } = createTools(ctx, { store, root, config: {} });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assessC(store, SESSION, { rationale: 'fixture：R-1/R-2 交接写权用例的建批前置评估（三层 DAG 多依赖 ⇒ C 档）' });
  return { root, store, byName, teamsRoot, rosterMembers };
}

const eventsOf = (store, batchId) => (store.readBatch(SESSION, batchId)?.events ?? []);

/**
 * 建批（**走与 `wave_plan` 工具同一对单点**：`buildWavePlan` → `store.createBatch`）。
 *
 * ⚠ 为何不经 `wave_plan.execute`：本批执行窗口内，另一批（`onto-fixture-purge-20260925`）正在改造
 *   `test/helpers/host-skills.mjs`（其宿主技能播种夹具的三件导出已删）⇒ **宿主技能根播种面不可用**，
 *   `wave_plan` 的团队资产可解析门（`TEAM_ASSET_SKILLS_MISMATCH`，fail-closed）在隔离 HOME 下必然拦下
 *   （同因：`test/handoff-gate.test.js` 等既有套件当前在模块链接期即失败，见 `exec/test-locks.md` G-T1）。
 *   本 lane 的被检面是**交接写权 / 覆盖保护**（R-1/R-2），**不是**团队资产技能门，故建批夹具直落
 *   `buildWavePlan` + `store.createBatch`（引擎自身的两个单点，非第二套判据）——被检面（`handoff_submit`
 *   工具 + `store.recordHandoff`）**逐字未换**。
 */
function mkBatch(h, batchId, { rosterOf } = {}) {
  const plan = buildWavePlan({
    batchId, tasks: tasks({ rosterOf }), team: TEAM,
    assembly: { managerPlan: 'leader-direct', auditLane: 'a1' },
  });
  h.store.createBatch(SESSION, { batchId, wavePlan: plan, teamsRoot: h.teamsRoot });
  return plan;
}

function seedArtifact(h, batchId, rel, body = 'out') {
  const abs = path.join(h.root, 'sessions', SESSION, 'artifacts', batchId, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
  return abs;
}

/** 非 owner 调用方（`args.session` 显式给批归属会话，见文件头 G-2 说明）。 */
const memberExec = (id) => ({ agent: { session: { id } } });

/** 命中码（**断言码本体**，而非「未成功」）。 */
async function caughtCode(fn) {
  try {
    const out = await fn();
    return { thrown: false, code: (out && out.code) ?? null, message: '', out };
  } catch (e) {
    const message = String(e?.message ?? '');
    return { thrown: true, code: message.split(':')[0].trim(), message, out: null };
  }
}

/**
 * R1-b 取证快照：批 JSON 该边记录（逐字序列化）+ 事件流三类计数。
 * 「拒时零写入」= 前后快照 **deepEqual**（记录逐字相同、事件计数差 = 0）。
 */
function snapshotEdge(h, batchId, { to, from }) {
  const b = h.store.readBatch(SESSION, batchId);
  const rec = ((b.handoffs ?? {})[to] ?? []).find((r) => r && r.from === from) ?? null;
  return {
    rec: JSON.stringify(rec ?? null),
    historyLen: Array.isArray(rec?.history) ? rec.history.length : 0,
    events: b.events.length,
    handoff: b.events.filter((e) => e.type === EVT.EVT_LANE_HANDOFF).length,
    gap: b.events.filter((e) => e.type === EVT.EVT_LANE_HANDOFF_GAP).length,
  };
}

// ── R-1 ① owner（正例）───────────────────────────────────────────────────────

test('A-1 R1-a/R1-b ①owner 正例：批归属会话提交任一边 ⇒ 放行（HANDOFF_OK）', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'a1');
    seedArtifact(h, 'a1', 'exec/e1.md');
    const out = await h.byName.handoff_submit.execute(
      { batchId: 'a1', from: 'p1', to: 'e1', artifacts: ['exec/e1.md'], assertions: ['e1 已按 spec 实现'] }, SESS,
    );
    assert.equal(out.ok, true, 'owner ⇒ 全批写权，必放行：' + JSON.stringify(out));
    assert.equal(out.code, 'HANDOFF_OK');
    const rec = h.store.readBatch(SESSION, 'a1').handoffs.e1[0];
    assert.equal(rec.status, 'submitted', 'owner 交接真源已落盘');
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); fs.rmSync(h.teamsRoot, { recursive: true, force: true }); }
});

// ── R-1 ③ dispatch worker（正例 + 反例 + 零写入）──────────────────────────────

test('A-2 R1-b/R1-c/R1-d ③dispatch：本人 lane 出边放行；他人 lane 出边 ⇒ GATE_HANDOFF_UNAUTHORIZED 且零写入', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'a2');
    // 本批 `member.dispatch` 绑定：worker-x1 ⇒ lane e1（与引擎唯一写路径同字段名，见 store.js:1274）
    h.store.appendEvent(SESSION, 'a2', 'member.dispatch', { lane: 'e1', workerSessionId: 'worker-x1' });
    seedArtifact(h, 'a2', 'plan/spec.md');
    seedArtifact(h, 'a2', 'exec/e1.md');
    const worker = memberExec('worker-x1');

    // 正例：本人 lane（e1）的出边 ⇒ 放行
    const pass = await caughtCode(() => h.byName.handoff_submit.execute(
      { batchId: 'a2', from: 'e1', to: 'e2', artifacts: ['exec/e1.md'], assertions: ['e1 产物可被 e2 直接消费'], session: SESSION }, worker,
    ));
    assert.equal(pass.thrown, false, 'dispatch worker 对**本人 lane** 出边必须放行：' + pass.message);
    assert.equal(pass.out.code, 'HANDOFF_OK');

    // 反例：同会话提交**他人 lane**（p1）的出边 ⇒ 越权拒
    const before = snapshotEdge(h, 'a2', { to: 'e1', from: 'p1' });
    const deny = await caughtCode(() => h.byName.handoff_submit.execute(
      { batchId: 'a2', from: 'p1', to: 'e1', artifacts: ['plan/spec.md'], assertions: ['越权尝试'], session: SESSION }, worker,
    ));
    assert.equal(deny.thrown, true, '越权写入必须抛错（不静默）');
    assert.equal(deny.code, 'GATE_HANDOFF_UNAUTHORIZED', '反例须**命中该码**（非「未成功」）：' + deny.message);
    assert.match(deny.message, /调用方（dispatch）/, 'R1-d：拒态可辨身份角色名 dispatch：' + deny.message);
    assert.match(deny.message, /from:p1/, '须回显缺哪条写权（from:<lane>）');

    // 零写入（R1-b）：批 JSON 该记录逐字不变 + 事件流三类计数差 = 0
    assert.deepEqual(snapshotEdge(h, 'a2', { to: 'e1', from: 'p1' }), before,
      '拒态零写入：handoffs.e1 的 p1 记录（status/ts/contract.assertions）与事件计数均不得新增');
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); fs.rmSync(h.teamsRoot, { recursive: true, force: true }); }
});

// ── R-1 ④ team 席位 roster（正例 + 反例）─────────────────────────────────────

test('A-3 R1-b/R1-d ④roster：名下 lane 出边放行；他人 lane 出边 ⇒ GATE_HANDOFF_UNAUTHORIZED 且零写入', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'a3', { rosterOf: { e1: 'coder-1' } });
    h.rosterMembers.push('coder-1'); // 官方 roster 具名成员（身份采集端唯一来源）
    seedArtifact(h, 'a3', 'plan/spec.md');
    seedArtifact(h, 'a3', 'exec/e1.md');
    const seat = memberExec('sess-seat-coder-1');

    // 正例：名 = lanes[].roster 的席位提交该 lane 出边 ⇒ 放行
    const pass = await caughtCode(() => h.byName.handoff_submit.execute(
      { batchId: 'a3', from: 'e1', to: 'e2', artifacts: ['exec/e1.md'], assertions: ['席位 coder-1 交付 e1'], session: SESSION }, seat,
    ));
    assert.equal(pass.thrown, false, 'roster 席位对**本人名下 lane** 出边必须放行：' + pass.message);
    assert.equal(pass.out.code, 'HANDOFF_OK');

    // 反例：席位不可写他人 lane（p1）
    const before = snapshotEdge(h, 'a3', { to: 'e1', from: 'p1' });
    const deny = await caughtCode(() => h.byName.handoff_submit.execute(
      { batchId: 'a3', from: 'p1', to: 'e1', artifacts: ['plan/spec.md'], assertions: ['越权尝试'], session: SESSION }, seat,
    ));
    assert.equal(deny.code, 'GATE_HANDOFF_UNAUTHORIZED', '反例须命中该码：' + deny.message);
    assert.match(deny.message, /调用方（roster）/, 'R1-d：拒态可辨身份角色名 roster：' + deny.message);
    assert.deepEqual(snapshotEdge(h, 'a3', { to: 'e1', from: 'p1' }), before, '拒态零写入');
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); fs.rmSync(h.teamsRoot, { recursive: true, force: true }); }
});

// ── R-1 ⑤ 无法解析身份（fail-closed 反例 + 零写入）────────────────────────────

test('A-4 R1-b/R1-d ⑤unresolved：陌生会话 ⇒ GATE_HANDOFF_IDENTITY_UNKNOWN 且零写入', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'a4'); // 无 roster 名、无 member.dispatch 绑定
    seedArtifact(h, 'a4', 'plan/spec.md');
    const stranger = memberExec('sess-stranger');

    const before = snapshotEdge(h, 'a4', { to: 'e1', from: 'p1' });
    const deny = await caughtCode(() => h.byName.handoff_submit.execute(
      { batchId: 'a4', from: 'p1', to: 'e1', artifacts: ['plan/spec.md'], assertions: ['陌生会话尝试'], session: SESSION }, stranger,
    ));
    assert.equal(deny.code, 'GATE_HANDOFF_IDENTITY_UNKNOWN', '无法解析身份 ⇒ fail-closed 拒：' + deny.message);
    assert.match(deny.message, /fail-closed/, 'R1-d：拒因须点名 fail-closed（可辨 unresolved 态）：' + deny.message);
    assert.deepEqual(snapshotEdge(h, 'a4', { to: 'e1', from: 'p1' }), before,
      '拒态零写入：批 JSON 该记录与事件流三类计数均无新增');
    // 对照组（本用例的**分辨力**证据）：同批 owner 调用同一 args ⇒ 放行（证拒的是身份，不是参数或环境）
    const ownerPass = await caughtCode(() => h.byName.handoff_submit.execute(
      { batchId: 'a4', from: 'p1', to: 'e1', artifacts: ['plan/spec.md'], assertions: ['owner 提交'], session: SESSION }, SESS,
    ));
    assert.equal(ownerPass.thrown, false, '对照组：owner 同参数必须放行（否则本用例无区分力）：' + ownerPass.message);
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); fs.rmSync(h.teamsRoot, { recursive: true, force: true }); }
});

// ── R-2 首交（正例）─────────────────────────────────────────────────────────

test('B-1 R2-a 正例：首次提交（pending ⇒ submitted）不带 overwrite ⇒ 放行', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'b1');
    seedArtifact(h, 'b1', 'exec/e1.md');
    const out = await h.byName.handoff_submit.execute(
      { batchId: 'b1', from: 'p1', to: 'e1', artifacts: ['exec/e1.md'], assertions: ['首交断言 A1'] }, SESS,
    );
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.overwrite, false, '首交 overwrite 恒 false（旧调用零破坏）');
    assert.deepEqual(out.previousAssertions, [], '首交 previousAssertions 恒空数组');
    const rec = h.store.readBatch(SESSION, 'b1').handoffs.e1[0];
    assert.equal(rec.status, 'submitted');
    assert.equal(rec.history, undefined, '首交不 push history（首次语义逐字不变）');
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); fs.rmSync(h.teamsRoot, { recursive: true, force: true }); }
});

// ── R-2 未声明覆盖（反例 + 零写入）──────────────────────────────────────────

test('B-2 R2-a 反例：同边二交缺 overwrite ⇒ GATE_HANDOFF_OVERWRITE_UNDECLARED 且零写入', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'b2');
    seedArtifact(h, 'b2', 'exec/e1.md');
    await h.byName.handoff_submit.execute(
      { batchId: 'b2', from: 'p1', to: 'e1', artifacts: ['exec/e1.md'], assertions: ['首交断言 A1'] }, SESS,
    );
    const before = snapshotEdge(h, 'b2', { to: 'e1', from: 'p1' });
    const deny = await caughtCode(() => h.byName.handoff_submit.execute(
      { batchId: 'b2', from: 'p1', to: 'e1', artifacts: ['exec/e1.md'], assertions: ['未声明覆盖 A2'] }, SESS,
    ));
    assert.equal(deny.code, 'GATE_HANDOFF_OVERWRITE_UNDECLARED', '未声明覆盖 ⇒ 命中该码：' + deny.message);
    assert.match(deny.message, /overwrite/, '须回显缺口 overwrite（可自救）：' + deny.message);
    assert.deepEqual(snapshotEdge(h, 'b2', { to: 'e1', from: 'p1' }), before,
      '拒态零写入：既有 submitted 记录逐字不变 + 事件流零新增');
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); fs.rmSync(h.teamsRoot, { recursive: true, force: true }); }
});

// ── R-2 显式覆盖放行 + 回显（正例）───────────────────────────────────────────

test('B-3 R2-b 正例：overwrite:true 二交放行；回显 overwrite/previousAssertions；handoff_view 回显新断言 5 条', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'b3');
    seedArtifact(h, 'b3', 'exec/e1.md');
    await h.byName.handoff_submit.execute(
      { batchId: 'b3', from: 'p1', to: 'e1', artifacts: ['exec/e1.md'], assertions: ['首交断言 A1'] }, SESS,
    );
    const next5 = ['A2-1', 'A2-2', 'A2-3', 'A2-4', 'A2-5'];
    const out = await h.byName.handoff_submit.execute(
      { batchId: 'b3', from: 'p1', to: 'e1', artifacts: ['exec/e1.md'], assertions: next5, overwrite: true }, SESS,
    );
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.code, 'HANDOFF_OK');
    assert.equal(out.overwrite, true, '声明覆盖 ⇒ 回显 overwrite=true');
    assert.deepEqual(out.previousAssertions, ['首交断言 A1'], '回显旧值（新交不得吞掉旧值）');
    const rec = h.store.readBatch(SESSION, 'b3').handoffs.e1[0];
    assert.deepEqual(rec.contract.assertions, next5, '真源 = 新值');
    const view = await h.byName.handoff_view.execute({ batchId: 'b3', lane: 'e1' }, SESS);
    const edge = view.edges.find((x) => x.from === 'p1');
    assert.equal(edge.assertions.length, 5, 'handoff_view 须回显二交的 5 条断言：' + JSON.stringify(edge.assertions));
    assert.deepEqual(edge.assertions, next5);
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); fs.rmSync(h.teamsRoot, { recursive: true, force: true }); }
});

// ── R-2 旧值留痕（记录侧 history + 事件侧 previousAssertions/overwrite/replaced）──

test('B-4 R2-c/R2-d 旧值留痕：history 追加式（长度随覆盖次数严格递增、内容 = 前值）；事件带 previousAssertions/overwrite/replaced', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'b4');
    seedArtifact(h, 'b4', 'exec/e1.md');
    const first = ['首次断言 X1'];
    const second = ['二交断言 Y1', '二交断言 Y2'];
    const third = ['三交断言 Z1'];
    await h.byName.handoff_submit.execute(
      { batchId: 'b4', from: 'p1', to: 'e1', artifacts: ['exec/e1.md'], assertions: first }, SESS,
    );
    await h.byName.handoff_submit.execute(
      { batchId: 'b4', from: 'p1', to: 'e1', artifacts: ['exec/e1.md'], assertions: second, overwrite: true }, SESS,
    );
    await h.byName.handoff_submit.execute(
      { batchId: 'b4', from: 'p1', to: 'e1', artifacts: ['exec/e1.md'], assertions: third, overwrite: true }, SESS,
    );

    // 记录侧：追加式，长度 = 覆盖次数（2），内容逐条 = 被覆盖掉的前值
    const rec = h.store.readBatch(SESSION, 'b4').handoffs.e1[0];
    assert.equal(Array.isArray(rec.history), true, '覆盖两次 ⇒ history 必在场');
    assert.equal(rec.history.length, 2, 'history 长度 = 覆盖次数（严格递增，非替换/清空）');
    assert.deepEqual(rec.history[0].assertions, first, 'history[0] = 首交值');
    assert.deepEqual(rec.history[1].assertions, second, 'history[1] = 二交值');
    assert.deepEqual(rec.contract.assertions, third, '真源仍是新值');

    // 事件侧：每条该 edge 的 lane.handoff 都带 previousAssertions（首次 []）+ overwrite（布尔）+ replaced
    const evs = eventsOf(h.store, 'b4').filter((e) => e.type === EVT.EVT_LANE_HANDOFF && e.from === 'p1' && e.to === 'e1');
    assert.equal(evs.length, 3, '三次提交 ⇒ 三条 lane.handoff');
    assert.equal(evs.every((e) => Array.isArray(e.previousAssertions)), true,
      'previousAssertions 在场率 100% 且恒为数组：' + JSON.stringify(evs.map((e) => e.previousAssertions)));
    assert.equal(evs.every((e) => typeof e.overwrite === 'boolean'), true, 'overwrite 恒布尔');
    assert.deepEqual(evs[0].previousAssertions, [], '首次交接 previousAssertions = []');
    assert.equal(evs[0].overwrite, false, '首次 overwrite = false');
    assert.equal(evs[0].replaced, null, '首次 replaced = null');
    assert.deepEqual(evs[1].previousAssertions, first, '二交事件带首交旧值');
    assert.equal(evs[1].overwrite, true);
    assert.deepEqual(evs[1].replaced, { artifacts: ['exec/e1.md'], assertions: first }, 'replaced = 旧值快照（覆盖前）');
    assert.deepEqual(evs[2].previousAssertions, second, '三交事件带二交旧值');
    assert.deepEqual(evs[2].replaced, { artifacts: ['exec/e1.md'], assertions: second });
    // 事件 assertions 仍 = 新值（语义只增不改）
    assert.deepEqual(evs[2].assertions, third, '事件 assertions 恒 = 本次新值');
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); fs.rmSync(h.teamsRoot, { recursive: true, force: true }); }
});

// ── 既有行为零回归（非 owner 面之外的结构性拒态保持不变）──────────────────────

test('A-5 结构性拒态未漂移：缺产物仍以 GATE_HANDOFF_MISSING 拒（R-1 未抢占该码）', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'a5');
    const deny = await caughtCode(() => h.byName.handoff_submit.execute(
      { batchId: 'a5', from: 'p1', to: 'e1', artifacts: ['exec/ghost.md'], assertions: ['x'] }, SESS,
    ));
    assert.equal(deny.code, 'GATE_HANDOFF_MISSING', '缺产物拒态沿用既有码：' + deny.message);
    assert.match(deny.message, /exec\/ghost\.md/, '仍须回显缺哪件产物');
    assert.equal(
      eventsOf(h.store, 'a5').some((e) => e.type === EVT.EVT_LANE_HANDOFF_GAP && e.code === 'GATE_HANDOFF_MISSING'),
      true, '结构性拒态仍照落 lane.handoff.gap（R-1 之前行为逐字不变）',
    );
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); fs.rmSync(h.teamsRoot, { recursive: true, force: true }); }
});
