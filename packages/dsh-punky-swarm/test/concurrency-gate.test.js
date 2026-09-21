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

// 并发闸（concurrency gate）单测 —— 批 `concurrency-gate-20260917` · lane `exec-concurrency-gate`。
// ─────────────────────────────────────────────────────────────────────────────
// 【2026-09-18 · Q-B 取消并发闸 —— 本文件**语义反转**为「退役锁」（批 `engine-retire-chain-20260918`）】
// 上游裁决：`docs/engine-design-adjudication-20260918.md:182`（Q-B）——`concurrency` 不再作运行期准入判定，
//   高并发不得被限流；`batch.concurrency` 保留为**纯声明 + 回显、零判定**。
// 本文件原判据来源 = `plan/gate-spec.md`（§3 判据 / §4 留痕 / §9 用例表 T1-T14 / §验收标准 A1-A12）；
//   实现面（`lib/engine/dispatch.js` 的判据纯函数 + 拒码 + 执行点 + 三条派发面接入）**已整体删除**。
// **改写口径（规格 `plan/retire-spec.md` §4.1 C-17，取舍**显式登记**）**：
//   · 用例名**逐个保留**（便于与旧用例表对账，避免「删了没人知」）；
//   · 每个用例由「闸成立 ⇒ 拒」反转为「**闸已退役 ⇒ 不拒、不落拒态事件、不写拒码**」；
//   · C-17 原写「纯判据类（T1/T3/T10a/T10b/T10c/T12/T14b）**删**、放行类重写、T6 系列删」——本批**改为
//     全量反转为退役锁**（不删）：判据①「`not ok` = 0 且既有通过数不下降」与「禁把 `fail 0` 当唯一判据」
//     要求**行为面**仍有锁；删除只会让「闸是否真的取消」失去可核证据。取舍理由与新旧映射逐条见
//     exec 产物 `exec/engine-retire.md`（§1 变更清单表 / §6 未决项 · gap 段）。
//   · **T13 语义反转（Leader 明列）**：原「直派面超限 ⇒ 抛 `GATE_CONCURRENCY_EXCEEDED`」改为
//     「超限**照常迁移成功**，且零 `gate.concurrency_blocked` 事件」——**属有意反转，非静默削弱**。
// 跑法（**禁** build 前置）：`node --import ./test/helpers/isolated-home.preload.mjs --test test/concurrency-gate.test.js`
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import { writeSyntheticTeam } from './helpers/team-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { createCoreTools } from '../lib/tools/core.js';
import {
  EVT_MEMBER_DISPATCH, EVT_MEMBER_SETTLED, EVT_LANE_STALLED, EVT_CHAIN_STEP, EVT_BATCH_SMOKE,
} from '../lib/state/event-types.js';
import * as EVENT_TYPES from '../lib/state/event-types.js';
import * as dispatchMod from '../lib/engine/dispatch.js';
import { __resetLaneHandles } from '../lib/bridge/lane-handle.js';
import { advanceChainAfterSettle } from '../lib/engine/chain-runner.js';

/** 并发闸拒态事件名：常量**冻结保留**（历史批磁盘事件面读端不变），但**写点已随闸删除**。 */
const EVT_CONCURRENCY_BLOCKED = EVENT_TYPES.EVT_GATE_CONCURRENCY_BLOCKED;
/** 并发闸拒码：`lib/engine/dispatch.js` 的导出**已删除** ⇒ 退役后本变量恒 `undefined`（T10c 显式断言）。 */
const CONCURRENCY_CODE = dispatchMod.CONCURRENCY_EXCEEDED_CODE;

const SPEC_OK = '# 规格夹具\n## 验收标准\n- x\n## 约束\n- y\n';

function freshRoot(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

function mkCtx(runtime) {
  const calls = { info: [], warn: [], error: [] };
  const ctx = {
    on() { return () => {}; },
    tools: { register() {} },
    logger: {
      info: (...a) => calls.info.push(a.join(' ')),
      warn: (...a) => calls.warn.push(a.join(' ')),
      error: (...a) => calls.error.push(a.join(' ')),
    },
    calls,
  };
  if (runtime) ctx.subagents = runtime;
  return ctx;
}

/** 假宿主：登记每次 spawn 的 spec（供放行路径断言「发了 worker」）。 */
function fakeRuntime(sink) {
  return {
    startContinuable: async (spec) => {
      const id = 'ws-' + (sink.length + 1);
      sink.push({ id, spec });
      return { id, messageId: 'm-' + id };
    },
  };
}

/**
 * 建批夹具（复用 `test/engine-dispatch.test.js:52-74` 形态：真实写路径，不自造裸 JSON）。
 * `concurrency` 只作**声明**（退役后零判定）：本文件用它构造「旧闸本应拒绝」的高危形态，
 * 以自证「超限不再被拒」。
 */
function seedBatch(root, sessionId, batchId, laneIds, opts = {}) {
  const store = opts.store ?? createStore(root);
  const artRoot = path.join(root, 'sessions', sessionId, 'artifacts', batchId);
  fs.mkdirSync(path.join(artRoot, 'plan'), { recursive: true });
  fs.writeFileSync(path.join(artRoot, 'plan', 'spec.md'), SPEC_OK, 'utf8');
  // exec 层 `outputs` 声明件在场（`running→review→merged` 的 exit 门 = produce∪outputs 须在场；T7 需要）
  if (opts.seedOutputs !== false) {
    for (const id of laneIds) {
      const rel = path.join(artRoot, 'exec', id, 'outputs');
      fs.mkdirSync(rel, { recursive: true });
      fs.writeFileSync(path.join(rel, 'x.md'), 'out', 'utf8');
    }
  }
  const wp = buildWavePlan({
    batchId,
    team: opts.team,
    tasks: [
      { id: 'p1', cmd: 'plan 规格（夹具）', layer: 'plan', role: 'coordinator', produce: ['plan/spec.md'], outputs: ['plan/spec.md'] },
      ...laneIds.map((id) => ({
        id, cmd: '实现 X', layer: 'exec', role: 'coder', deps: ['p1'],
        consume: ['plan/spec.md'], outputs: ['exec/' + id + '/outputs/x.md'],
      })),
      // 三层合同（`wave-plan.js` 的 `validateLayerContract`）：exec 层须配至少一条 audit lane
      { id: 'a1', cmd: '按验收标准逐条核对', layer: 'audit', role: 'supervisor', deps: laneIds, consume: ['plan/spec.md'] },
    ],
  });
  const args = { batchId, wavePlan: wp, phase: 'running' };
  if (opts.concurrency !== undefined) args.concurrency = opts.concurrency;
  if (opts.assembly !== undefined) args.assembly = opts.assembly;
  if (opts.teamsRoot !== undefined) args.teamsRoot = opts.teamsRoot;
  store.createBatch(sessionId, args);
  store.writeGovernance(sessionId, {
    lastAssign: {
      difficulty: 'C', form: 'C', scope: 'full', derived: 'C', override: false,
      rationale: 'fixture：并发闸用例前置评估（多线并行 ⇒ C 档）', reasons: [], at: new Date().toISOString(), execCallsSince: 0,
    },
  });
  return store;
}

function toolsFor(store, root, ctx, config) {
  const tools = createCoreTools(ctx, { store, root, config: config ?? { dispatch: { provider: 'spawn-in-process' } } });
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

const eventsOf = (store, sessionId, batchId, type) =>
  (store.readBatch(sessionId, batchId)?.events ?? []).filter((e) => e.type === type);

/** 退役锁公共断言：某批**零**拒态事件（写点已删 ⇒ 新批不可能产生）。 */
function assertNoBlockedEvent(store, sid, batchId, note) {
  assert.equal(eventsOf(store, sid, batchId, EVT_CONCURRENCY_BLOCKED).length, 0,
    '[退役锁] 零 gate.concurrency_blocked（写点已随 Q-B 删除）：' + note);
}

// ── T1：旧「拒绝路径」⇒ 退役锁：超限不再被拒 ─────────────────────────────────
test('T1【退役锁 · Q-B】occupied >= limit ⇒ **不再拒**：零抛错 + 零 gate.concurrency_blocked + lane 照常 running', async () => {
  __resetLaneHandles();
  const SID = 'sess-cg-t1';
  const root = freshRoot('punky-cg-t1-');
  const store = seedBatch(root, SID, 'b-t1', ['l1', 'l2'], { concurrency: 1 });
  const spawned = [];
  const ctx = mkCtx(fakeRuntime(spawned));
  const by = toolsFor(store, root, ctx);
  const exec = { agent: { session: { id: SID } } };

  const r1 = await by.lane_dispatch.execute({ batchId: 'b-t1', lane: 'l1' }, exec);
  assert.equal(r1.spawned, true, '前置：l1 派出');
  assert.equal(store.readBatch(SID, 'b-t1').lanes.l1, 'running');

  // 旧闸：occupied(1) >= limit(1) ⇒ 抛 GATE_CONCURRENCY_EXCEEDED。退役后：**照常派出**（不排队、不限流）。
  const r2 = await by.lane_dispatch.execute({ batchId: 'b-t1', lane: 'l2' }, exec);
  assert.equal(r2.spawned, true, '[退役锁] 超限 lane 必须照常派出（Q-B：高并发不得被限流）');
  assert.equal(store.readBatch(SID, 'b-t1').lanes.l2, 'running', '[退役锁] l2 迁移成功（不再零写入）');
  assert.equal(spawned.length, 2, '两次派发 ⇒ 两次真实 spawn');
  assert.equal(eventsOf(store, SID, 'b-t1', EVT_MEMBER_DISPATCH).filter((e) => e.lane === 'l2').length, 1, 'l2 的 member.dispatch 照常登记');
  assertNoBlockedEvent(store, SID, 'b-t1', 'T1');
  assert.equal(eventsOf(store, SID, 'b-t1', 'gate.escape').length, 0, '零 gate.escape（未发生任何放行侧留痕）');
  __resetLaneHandles();
});

// ── T2：放行路径（原通过用例，逐字保留 + 追加零拒态断言） ──────────────────────
test('T2 放行路径：occupied < limit ⇒ spawned:true + 恰 N 条 member.dispatch + 零拒态事件', async () => {
  __resetLaneHandles();
  const SID = 'sess-cg-t2';
  const root = freshRoot('punky-cg-t2-');
  const store = seedBatch(root, SID, 'b-t2', ['l1', 'l2', 'l3', 'l4', 'l5'], { concurrency: 4 });
  const spawned = [];
  const by = toolsFor(store, root, mkCtx(fakeRuntime(spawned)));
  const exec = { agent: { session: { id: SID } } };
  for (const id of ['l1', 'l2', 'l3', 'l4']) {
    const r = await by.lane_dispatch.execute({ batchId: 'b-t2', lane: id }, exec);
    assert.equal(r.spawned, true, id + ' 必须放行（spawned:true）');
  }
  assert.equal(spawned.length, 4, '4 次放行 ⇒ 4 次真实 spawn');
  assert.equal(eventsOf(store, SID, 'b-t2', EVT_MEMBER_DISPATCH).length, 4, '放行路径每 lane 恰 1 条 member.dispatch');
  assertNoBlockedEvent(store, SID, 'b-t2', 'T2');
  assert.equal(store.readBatch(SID, 'b-t2').lanes.l5, 'pending', '第 5 条未派 ⇒ 保持 pending');
  __resetLaneHandles();
});

// ── T3：旧「恰好等于上限即拒」⇒ 退役锁：照常放行 ─────────────────────────────
test('T3【退役锁 · Q-B】occupied === limit ⇒ **照常放行**（容量判定已删除：既不是 `>=` 也不是 `>`）', async () => {
  __resetLaneHandles();
  const SID = 'sess-cg-t3';
  const root = freshRoot('punky-cg-t3-');
  const store = seedBatch(root, SID, 'b-t3', ['l1', 'l2', 'l3', 'l4'], { concurrency: 3 });
  const spawned = [];
  const by = toolsFor(store, root, mkCtx(fakeRuntime(spawned)));
  const exec = { agent: { session: { id: SID } } };
  for (const id of ['l1', 'l2', 'l3', 'l4']) {
    const r = await by.lane_dispatch.execute({ batchId: 'b-t3', lane: id }, exec);
    assert.equal(r.spawned, true, '[退役锁] ' + id + ' 必须放行（第 4 条曾为「恰好超限」，现零判定）');
  }
  assert.equal(store.readBatch(SID, 'b-t3').lanes.l4, 'running', '[退役锁] l4 迁移成功');
  assertNoBlockedEvent(store, SID, 'b-t3', 'T3');
  __resetLaneHandles();
});

// ── T4：跨批互不影响（退役后面统一：两批皆不限流） ────────────────────────────
test('T4【退役锁 · Q-B】跨批：两批并发派发全部放行（无批级容量判定 ⇒ 无「批级计数」面）', async () => {
  __resetLaneHandles();
  const SID = 'sess-cg-t4';
  const root = freshRoot('punky-cg-t4-');
  const store = seedBatch(root, SID, 'b-p1', ['l1', 'l2'], { concurrency: 1 });
  seedBatch(root, SID, 'b-p2', ['l1', 'l2'], { concurrency: 1, store });
  const spawned = [];
  const by = toolsFor(store, root, mkCtx(fakeRuntime(spawned)));
  const exec = { agent: { session: { id: SID } } };
  assert.equal((await by.lane_dispatch.execute({ batchId: 'b-p1', lane: 'l1' }, exec)).spawned, true);
  assert.equal((await by.lane_dispatch.execute({ batchId: 'b-p1', lane: 'l2' }, exec)).spawned, true, '[退役锁] P1 第二条照常放行');
  assert.equal((await by.lane_dispatch.execute({ batchId: 'b-p2', lane: 'l1' }, exec)).spawned, true, 'P2 照常放行');
  assert.equal(store.readBatch(SID, 'b-p2').lanes.l1, 'running');
  assertNoBlockedEvent(store, SID, 'b-p1', 'T4/p1');
  assertNoBlockedEvent(store, SID, 'b-p2', 'T4/p2');
  __resetLaneHandles();
});

// ── T5：leader-direct 批（退役后与 managerPlan 取值无关：面已不存在） ──────────
test('T5【退役锁 · Q-B】leader-direct 批零限流（与 assembly.managerPlan 取值无关：闸位已删）', async () => {
  __resetLaneHandles();
  const SID = 'sess-cg-t5';
  const root = freshRoot('punky-cg-t5-');
  const store = seedBatch(root, SID, 'b-t5', ['l1', 'l2'], {
    concurrency: 1,
    assembly: { managerPlan: 'leader-direct', auditLane: 'a1' },
  });
  assert.equal(store.readBatch(SID, 'b-t5').assembly.managerPlan, 'leader-direct', '前置：本批确为 leader-direct');
  const spawned = [];
  const by = toolsFor(store, root, mkCtx(fakeRuntime(spawned)));
  const exec = { agent: { session: { id: SID } } };
  assert.equal((await by.lane_dispatch.execute({ batchId: 'b-t5', lane: 'l1' }, exec)).spawned, true);
  assert.equal((await by.lane_dispatch.execute({ batchId: 'b-t5', lane: 'l2' }, exec)).spawned, true, '[退役锁] l2 照常放行');
  assertNoBlockedEvent(store, SID, 'b-t5', 'T5');
  __resetLaneHandles();
});

// ── T6 系列：自动派发路径（chain-runner）——链运行期推进已退役 ⇒ 三个用例改为退役锁 ──
/** 单批 chain 夹具（team 资产 + `chain` 声明走真实读端：`chainOfBatch` → `loadChainOf`）。
 *  ⚠ 退役后 `chain` 段**不参与任何运行期决策**，本夹具保留它以自证「带 `chain` 段的批照常建批、照常零推进」。 */
function seedChainBatch(root, sid, batchId, opts = {}) {
  const teamsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-cg-teams-'));
  // F2：合成资产 ⇒ 单点写入（helpers/team-fixture.mjs）。
  writeSyntheticTeam(teamsRoot, TEAM_CG, TEAM_ASSET_CG);
  const store = createStore(root);
  const artRoot = path.join(root, 'sessions', sid, 'artifacts', batchId);
  fs.mkdirSync(path.join(artRoot, 'plan'), { recursive: true });
  fs.writeFileSync(path.join(artRoot, 'plan', 'spec.md'), SPEC_OK, 'utf8');
  for (const id of ['e1', 'e2', 'x1']) {
    const rel = path.join(artRoot, 'exec', id, 'outputs');
    fs.mkdirSync(rel, { recursive: true });
    fs.writeFileSync(path.join(rel, 'x.md'), 'out', 'utf8');
  }
  const wp = buildWavePlan({
    batchId, team: TEAM_CG, teamsRoot,
    tasks: [
      { id: 'p1', cmd: 'plan', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], outputs: ['plan/spec.md'] },
      { id: 'e1', cmd: 'build', layer: 'exec', role: 'coder', deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/e1/outputs/x.md'] },
      { id: 'e2', cmd: 'build', layer: 'exec', role: 'coder', deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/e2/outputs/x.md'] },
      // 链外 lane（layer exec / role tester 不命中任何链步）：仅作「占满旧容量」的填充位
      { id: 'x1', cmd: 'filler', layer: 'exec', role: 'tester', deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/x1/outputs/x.md'] },
      { id: 'a1', cmd: 'accept', layer: 'audit', role: 'supervisor', deps: ['e1', 'e2'], consume: ['plan/spec.md'] },
    ],
  });
  store.createBatch(sid, {
    batchId, wavePlan: wp, phase: 'running', concurrency: opts.concurrency ?? 1,
    assembly: { managerPlan: 'raise', auditLane: 'a1' },
    teamsRoot, // ★ 必须随批持久化：`chainOfBatch` 按 `batch.teamsRoot` 解析资产（否则回落包根 ⇒ 无链）
  });
  return store;
}

const TEAM_CG = 'cg-concurrency-team';
const TEAM_ASSET_CG = {
  team: TEAM_CG,
  layers: {
    plan: { roles: ['designer'], skills: { designer: ['spec-writing'] } },
    exec: { roles: ['coder', 'tester'], skills: { coder: ['dev-coder'], tester: ['dev-tester'] } },
    audit: { roles: ['supervisor'], skills: { supervisor: ['acceptance-gate'] } },
  },
  roles: { plan_leads: ['designer'], audit_leads: ['supervisor'] },
  flows: {
    plan: { produce_field: 'produce', contract: { artifact_globs: ['plan/*.md'], required_sections: ['## 验收标准', '## 约束'] } },
    exec: { produce_field: 'outputs', consume_field: 'consume', entry_requires: ['consume'] },
    audit: { produce_field: 'produce', consume_field: 'consume', entry_requires: ['consume'] },
  },
  chain: {
    version: 1,
    steps: [
      { id: 'p1', layer: 'plan', role: 'designer', next: 'exec' },
      { id: 'exec', layer: 'exec', role: 'coder', join: 'all', next: 'a1' },
      { id: 'a1', layer: 'audit', role: 'supervisor', terminal: true },
    ],
    join: { anyFailure: 'pause' },
    onFail: 'pause',
  },
};

/** 触发一次链推进入口（**已退役 no-op**）：`p1` merged ⇒ 旧闸本应算下一环并逐 lane 派发。 */
function advanceFromP1(store, root, sid, batchId, ctx) {
  return advanceChainAfterSettle(
    { store, root, liveConfig: { dispatch: { provider: 'spawn-in-process' } } },
    ctx,
    { agent: { session: { id: sid } } },
    { sessionId: sid, batchId, lane: 'p1', status: 'merged' },
  );
}

/** 退役锁公共前置：把 `p1` 走完合法结算链（终态）。 */
function settleP1(store, sid, batchId) {
  store.setMember(sid, batchId, 'p1', 'running');
  store.setMember(sid, batchId, 'p1', 'review');
  store.setMember(sid, batchId, 'p1', 'merged');
}

test('T6【退役锁 · Q-A=C】chain-runner 入口 = no-op：零 chain.step / 零派发 / 零拒态 / 零容量判定', async () => {
  __resetLaneHandles();
  const SID = 'sess-cg-t6';
  const root = freshRoot('punky-cg-t6-');
  const store = seedChainBatch(root, SID, 'b-t6', { concurrency: 1 });
  const spawned = [];
  const ctx = mkCtx(fakeRuntime(spawned));
  settleP1(store, SID, 'b-t6');
  store.setMember(SID, 'b-t6', 'x1', 'running');
  assert.equal(store.readBatch(SID, 'b-t6').phase, 'running', '前置：批相位 running');

  const out = await advanceFromP1(store, root, SID, 'b-t6', ctx);
  assert.equal(out.ok, true, '[退役锁] 入口恒不抛错：' + JSON.stringify(out.reason));
  assert.equal(out.action, 'none', '[退役锁] action 恒 none');
  assert.equal(out.reason, 'retired', '[退役锁] reason 恒 retired（链运行期推进已退役）');
  assert.equal(spawned.length, 0, '[退役锁] 零真实 spawn（链不再派发）');
  const b = store.readBatch(SID, 'b-t6');
  assert.equal(b.phase, 'running', '[退役锁] 相位不变（no-op 不写相位）');
  assert.equal(b.lanes.e1, 'pending', '[退役锁] e1 保持 pending（无自动派）');
  assert.equal(b.lanes.e2, 'pending', '[退役锁] e2 保持 pending（无自动派）');
  assert.equal(eventsOf(store, SID, 'b-t6', EVT_CHAIN_STEP).length, 0, '[退役锁] 零 chain.step（写点已删）');
  assertNoBlockedEvent(store, SID, 'b-t6', 'T6');
  __resetLaneHandles();
});

test('T6b【退役锁 · Q-A=C】混合场景无意义：入口 no-op ⇒ 既无 spawned 也无 deferred，零 chain.step', async () => {
  __resetLaneHandles();
  const SID = 'sess-cg-t6b';
  const root = freshRoot('punky-cg-t6b-');
  const store = seedChainBatch(root, SID, 'b-t6b', { concurrency: 1 });
  const spawned = [];
  const ctx = mkCtx(fakeRuntime(spawned));
  settleP1(store, SID, 'b-t6b');
  const out = await advanceFromP1(store, root, SID, 'b-t6b', ctx);
  assert.equal(out.action, 'none');
  assert.deepEqual(out.dispatched, [], '[退役锁] 零派发明细（既无 spawned 也无 deferred）');
  assert.equal(eventsOf(store, SID, 'b-t6b', EVT_CHAIN_STEP).length, 0, '[退役锁] 零 chain.step');
  assert.equal(store.readBatch(SID, 'b-t6b').phase, 'running');
  assert.equal(store.readBatch(SID, 'b-t6b').lanes.e1, 'pending');
  assert.equal(store.readBatch(SID, 'b-t6b').lanes.e2, 'pending');
  assertNoBlockedEvent(store, SID, 'b-t6b', 'T6b');
  __resetLaneHandles();
});

test('T6c【退役锁 · Q-A=C】容量充足亦不派：链推进退役与容量无关（零 chain.step 与 concurrency 取值无关）', async () => {
  __resetLaneHandles();
  const SID = 'sess-cg-t6c';
  const root = freshRoot('punky-cg-t6c-');
  const store = seedChainBatch(root, SID, 'b-t6c', { concurrency: 4 });
  const spawned = [];
  const ctx = mkCtx(fakeRuntime(spawned));
  settleP1(store, SID, 'b-t6c');
  const out = await advanceFromP1(store, root, SID, 'b-t6c', ctx);
  assert.equal(out.action, 'none', '[退役锁] 容量充足也不推进（退役与容量无关）');
  assert.equal(spawned.length, 0, '[退役锁] 零 spawn');
  assert.equal(eventsOf(store, SID, 'b-t6c', EVT_CHAIN_STEP).length, 0, '[退役锁] 零 chain.step');
  assertNoBlockedEvent(store, SID, 'b-t6c', 'T6c');
  __resetLaneHandles();
});

// ── T7：终态 lane 面（原通过用例，逐字保留 + 零拒态） ──────────────────────────
test('T7 终态不计入：4 条 running 全部走 running→review→merged ⇒ occupied=0，可继续派', async () => {
  __resetLaneHandles();
  const SID = 'sess-cg-t7';
  const root = freshRoot('punky-cg-t7-');
  const store = seedBatch(root, SID, 'b-t7', ['l1', 'l2', 'l3', 'l4', 'l5'], { concurrency: 4 });
  const spawned = [];
  const by = toolsFor(store, root, mkCtx(fakeRuntime(spawned)));
  const exec = { agent: { session: { id: SID } } };
  for (const id of ['l1', 'l2', 'l3', 'l4']) {
    assert.equal((await by.lane_dispatch.execute({ batchId: 'b-t7', lane: id }, exec)).spawned, true);
  }
  for (const id of ['l1', 'l2', 'l3', 'l4']) {
    store.setMember(SID, 'b-t7', id, 'review');
    store.setMember(SID, 'b-t7', id, 'merged');
  }
  assert.equal(store.readBatch(SID, 'b-t7').lanes.l4, 'merged');
  const r = await by.lane_dispatch.execute({ batchId: 'b-t7', lane: 'l5' }, exec);
  assert.equal(r.spawned, true, '终态 lane 下 l5 必须放行');
  assertNoBlockedEvent(store, SID, 'b-t7', 'T7');
  __resetLaneHandles();
});

// ── T8：review / idle 面 ⇒ 退役锁：全放行 ────────────────────────────────────
test('T8【退役锁 · Q-B】review / idle 面不再有「槽位」语义：连续派发全部放行、零拒态', async () => {
  __resetLaneHandles();
  const SID = 'sess-cg-t8';
  const root = freshRoot('punky-cg-t8-');
  const store = seedBatch(root, SID, 'b-t8', ['l1', 'l2', 'l3'], { concurrency: 1 });
  const spawned = [];
  const by = toolsFor(store, root, mkCtx(fakeRuntime(spawned)));
  const exec = { agent: { session: { id: SID } } };
  assert.equal((await by.lane_dispatch.execute({ batchId: 'b-t8', lane: 'l1' }, exec)).spawned, true);
  assert.equal((await by.lane_dispatch.execute({ batchId: 'b-t8', lane: 'l2' }, exec)).spawned, true, '[退役锁] l2 照常放行');
  // review = 已交件、本轮计算已停（旧闸面：释放槽位）——退役后与容量无关，仅走既有状态机
  store.setMember(SID, 'b-t8', 'l1', 'review');
  await assert.rejects(
    () => by.lane_dispatch.execute({ batchId: 'b-t8', lane: 'l2' }, exec),
    (e) => {
      const m = String(e?.message ?? e);
      assert.match(m, /invalid member transition/, '[退役锁] 重复派发的拒绝来自**状态机**（既有语义），不是容量闸');
      assert.equal(m.includes('GATE_CONCURRENCY_EXCEEDED'), false, '[退役锁] 不得出现已退役的闸码');
      return true;
    },
  );
  // idle = 字面意义的空闲态（进程重启恢复 / 显式回收的落点）
  store.appendEvent(SID, 'b-t8', EVT_LANE_STALLED, { lane: 'l2' });
  const rec = store.recycleStalledLane(SID, 'b-t8', 'l2');
  assert.deepEqual(rec, { ok: true, lane: 'l2', from: 'running', to: 'idle' }, '前置：走真实回收路径落 idle');
  assert.equal((await by.lane_dispatch.execute({ batchId: 'b-t8', lane: 'l3' }, exec)).spawned, true, 'idle 面照常放行 l3');
  assertNoBlockedEvent(store, SID, 'b-t8', 'T8');
  __resetLaneHandles();
});

// ── T9：旧「pending 不计入」⇒ 退役锁：全量可派 ────────────────────────────────
test('T9【退役锁 · Q-B】7 条 pending、concurrency=4 ⇒ 全部可派（零判定 ⇒ 不存在「首批全拒」面）', async () => {
  __resetLaneHandles();
  const SID = 'sess-cg-t9';
  const root = freshRoot('punky-cg-t9-');
  const store = seedBatch(root, SID, 'b-t9', ['l1', 'l2', 'l3', 'l4', 'l5'], { concurrency: 4 });
  assert.equal(Object.values(store.readBatch(SID, 'b-t9').lanes).filter((s) => s === 'pending').length, 7, '前置：7 条 pending（5 exec + plan p1 + audit a1）');
  const spawned = [];
  const by = toolsFor(store, root, mkCtx(fakeRuntime(spawned)));
  const exec = { agent: { session: { id: SID } } };
  for (const id of ['l1', 'l2', 'l3', 'l4', 'l5']) {
    assert.equal((await by.lane_dispatch.execute({ batchId: 'b-t9', lane: id }, exec)).spawned, true, '[退役锁] ' + id + ' 必须放行');
  }
  assert.equal(spawned.length, 5, '5 条全部真实 spawn');
  assertNoBlockedEvent(store, SID, 'b-t9', 'T9');
  __resetLaneHandles();
});

// ── T10：缺省 / 非法 concurrency ⇒ 退役锁：字段不参与任何判定 ─────────────────
test('T10a【退役锁 · Q-B】批 JSON 缺 concurrency（存量/手改批）⇒ 与判定无关：6 条全部放行、零拒态', async () => {
  __resetLaneHandles();
  const SID = 'sess-cg-t10a';
  const root = freshRoot('punky-cg-t10a-');
  const store = seedBatch(root, SID, 'b-t10a', ['l1', 'l2', 'l3', 'l4', 'l5', 'l6']); // 真实建批（建批面恒写正整数）
  // 「本闸落地前建的老批」形态：唯一一个字段被删，不绕过任何既有校验。
  const file = path.join(root, 'sessions', SID, 'batches', 'b-t10a.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete doc.concurrency;
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');
  assert.equal('concurrency' in store.readBatch(SID, 'b-t10a'), false, '前置：批 JSON 确无 concurrency 键');

  const spawned = [];
  const by = toolsFor(store, root, mkCtx(fakeRuntime(spawned)));
  const exec = { agent: { session: { id: SID } } };
  for (const id of ['l1', 'l2', 'l3', 'l4', 'l5', 'l6']) {
    assert.equal((await by.lane_dispatch.execute({ batchId: 'b-t10a', lane: id }, exec)).spawned, true, '[退役锁] ' + id + ' 放行（缺字段不再回落 5 做准入）');
  }
  assert.equal(spawned.length, 6, '6 条全部 spawn');
  assertNoBlockedEvent(store, SID, 'b-t10a', 'T10a');
  __resetLaneHandles();
});

test('T10b【退役锁 · Q-B】非法 concurrency=0 ⇒ 与判定无关（既非「无上限」fail-open 也非「恒拒」）', async () => {
  __resetLaneHandles();
  const SID = 'sess-cg-t10b';
  const root = freshRoot('punky-cg-t10b-');
  const store = seedBatch(root, SID, 'b-t10b', ['l1', 'l2'], { concurrency: 0 });
  assert.equal(store.readBatch(SID, 'b-t10b').concurrency, 0, '前置：批 JSON 确为 0（非法值原样落盘 = 纯声明）');
  const spawned = [];
  const by = toolsFor(store, root, mkCtx(fakeRuntime(spawned)));
  const exec = { agent: { session: { id: SID } } };
  assert.equal((await by.lane_dispatch.execute({ batchId: 'b-t10b', lane: 'l1' }, exec)).spawned, true, 'l1 放行');
  assert.equal((await by.lane_dispatch.execute({ batchId: 'b-t10b', lane: 'l2' }, exec)).spawned, true, '[退役锁] l2 放行（0 不再归一为 5 做准入）');
  assert.equal(store.readBatch(SID, 'b-t10b').concurrency, 0, '字段值零改动（纯声明 + 回显）');
  assertNoBlockedEvent(store, SID, 'b-t10b', 'T10b');
  __resetLaneHandles();
});

test('T10c【退役锁 · Q-B】判据纯函数与拒码常量**不再导出**（实现已删，非「改名保留」）', () => {
  assert.equal(dispatchMod.concurrencyLimitOf, undefined, '[退役锁] `limit` 归一纯函数已删除');
  assert.equal(dispatchMod.concurrencyVerdictOf, undefined, '[退役锁] 闸判据纯函数已删除');
  assert.equal(dispatchMod.concurrencyRejectMessage, undefined, '[退役锁] 拒态文案构造器已删除');
  assert.equal(dispatchMod.CONCURRENCY_EXCEEDED_CODE, undefined, '[退役锁] 拒码常量已删除（`GateErrorCode` 亦已收窄）');
  assert.equal(dispatchMod.CONCURRENCY_DEFAULT_LIMIT, undefined, '[退役锁] 兜底 limit 常量已删除');
  assert.equal(CONCURRENCY_CODE, undefined, '[退役锁] 模块级取值为 undefined（无隐藏导出面）');
  assert.equal(dispatchMod.assertConcurrencyAdmit, undefined,
    '[退役锁] 执行点导出面**零残渣**（无占位、无别名）：B lane 已同批删净 `lib/tools/core.js` 的两处引用');
});

// ── T11：smoke 批 ⇒ 退役锁：零限流 ───────────────────────────────────────────
test('T11【退役锁 · Q-B】smoke:true 批零限流（豁免清单已无对象）', async () => {
  __resetLaneHandles();
  const SID = 'sess-cg-t11';
  const root = freshRoot('punky-cg-t11-');
  const store = seedBatch(root, SID, 'b-t11', ['l1', 'l2'], { concurrency: 1 });
  store.appendEvent(SID, 'b-t11', EVT_BATCH_SMOKE, { batchId: 'b-t11' });
  const spawned = [];
  const by = toolsFor(store, root, mkCtx(fakeRuntime(spawned)));
  const exec = { agent: { session: { id: SID } } };
  assert.equal((await by.lane_dispatch.execute({ batchId: 'b-t11', lane: 'l1' }, exec)).spawned, true);
  assert.equal((await by.lane_dispatch.execute({ batchId: 'b-t11', lane: 'l2' }, exec)).spawned, true, '[退役锁] l2 照常放行');
  assertNoBlockedEvent(store, SID, 'b-t11', 'T11');
  __resetLaneHandles();
});

// ── T12：旧「零写入」⇒ 退役锁：连派正常推进 lanes，且无拒态事件 ────────────────
test('T12【退役锁 · Q-B】连派不再「零写入」：lanes 正常推进 + 零 gate.concurrency_blocked', async () => {
  __resetLaneHandles();
  const SID = 'sess-cg-t12';
  const root = freshRoot('punky-cg-t12-');
  const store = seedBatch(root, SID, 'b-t12', ['l1', 'l2'], { concurrency: 1 });
  const file = path.join(root, 'sessions', SID, 'batches', 'b-t12.json');
  const spawned = [];
  const by = toolsFor(store, root, mkCtx(fakeRuntime(spawned)));
  const exec = { agent: { session: { id: SID } } };
  assert.equal((await by.lane_dispatch.execute({ batchId: 'b-t12', lane: 'l1' }, exec)).spawned, true);

  const before = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal((await by.lane_dispatch.execute({ batchId: 'b-t12', lane: 'l2' }, exec)).spawned, true, '[退役锁] l2 照常派出');
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));

  assert.notEqual(JSON.stringify(after.lanes), JSON.stringify(before.lanes), '[退役锁] lanes 正常推进（不再是「零写入」）');
  assert.equal(after.lanes.l2, 'running', '[退役锁] l2 = running');
  const added = after.events.slice(before.events.length);
  assert.equal(added.some((e) => e.type === EVT_CONCURRENCY_BLOCKED), false, '[退役锁] 新增事件中零拒态事件');
  assert.equal(added.some((e) => e.type === 'member.dispatch' && e.lane === 'l2'), true, 'l2 的 member.dispatch 照常落盘');
  assert.equal(after.phase, before.phase, '相位不变（不限流不 pause）');
  __resetLaneHandles();
});

// ── T13：`member_status(status=running)` 直派面 —— **语义反转（Leader 明列，属有意）** ──
// 【口径变更，显式登记（禁默认沉默）】原口径（批 `concurrency-gate-20260917` U3 扩面）：该面**接到同一闸**，
//   超限抛 `GATE_CONCURRENCY_EXCEEDED`。**Q-B 取消并发闸（2026-09-18）**：闸已整体删除 ⇒ 本面回到「只走既有
//   状态机与 entry 门」的语义 ⇒ 超限**照常迁移成功**，且**零** `gate.concurrency_blocked`。
//   ⚠ 这是**有意反转**（非静默削弱）：旧断言「抛闸码」被替换为「迁移成功 + 零拒态事件」，两向读数都留痕于
//   exec 产物 `exec/engine-retire.md`（§T13 语义反转）。
test('T13【语义反转 · Q-B】直派面：member_status(status=running) 超限**照常迁移成功**（零 GATE_CONCURRENCY_EXCEEDED）', async () => {
  __resetLaneHandles();
  const SID = 'sess-cg-t13';
  const root = freshRoot('punky-cg-t13-');
  const store = seedBatch(root, SID, 'b-t13', ['l1', 'l2'], { concurrency: 1 });
  const spawned = [];
  const by = toolsFor(store, root, mkCtx(fakeRuntime(spawned)));
  const exec = { agent: { session: { id: SID } } };
  assert.equal((await by.lane_dispatch.execute({ batchId: 'b-t13', lane: 'l1' }, exec)).spawned, true);

  const r2 = await by.member_status.execute({ batchId: 'b-t13', lane: 'l2', status: 'running' }, exec);
  assert.equal(r2.status, 'running', '[语义反转] 超限 lane 的直派迁移**照常成功**（不再抛闸码）');
  assert.equal(store.readBatch(SID, 'b-t13').lanes.l2, 'running', '[语义反转] l2 = running（不再「拒后零写入」）');
  assertNoBlockedEvent(store, SID, 'b-t13', 'T13');
  // 反向边界（口径未变）：非派发面的成员迁移本就不受容量闸影响（旧口径如此，退役后亦如此）
  const r = await by.member_status.execute({ batchId: 'b-t13', lane: 'l1', status: 'review' }, exec);
  assert.equal(r.status, 'review', '`running→review` 照常（状态机语义逐字不变）');
  assertNoBlockedEvent(store, SID, 'b-t13', 'T13/反向边界');
  __resetLaneHandles();
});

// ── T14：让位面（既有错误面逐字不变；本用例退役前后均须通过） ──────────────────
test('T14 让位面：批终态 / 未知 lane ⇒ 仍抛既有拒码（不是闸码），且零拒态事件', async () => {
  __resetLaneHandles();
  const SID = 'sess-cg-t14';
  const root = freshRoot('punky-cg-t14-');
  const store = seedBatch(root, SID, 'b-t14', ['l1', 'l2'], { concurrency: 1 });
  const spawned = [];
  const by = toolsFor(store, root, mkCtx(fakeRuntime(spawned)));
  const exec = { agent: { session: { id: SID } } };

  // ① 未知 lane ⇒ 既有 `unknown lane`
  await assert.rejects(
    () => by.lane_dispatch.execute({ batchId: 'b-t14', lane: 'nope' }, exec),
    (e) => {
      const m = String(e?.message ?? e);
      assert.match(m, /unknown lane/, '必须仍是既有 unknown lane');
      assert.equal(m.includes('GATE_CONCURRENCY_EXCEEDED'), false, '不得出现已退役的闸码');
      return true;
    },
  );
  // ② 批终态 ⇒ 既有 `GATE_BATCH_TERMINAL`
  store.setPhase(SID, 'b-t14', 'aborted');
  await assert.rejects(
    () => by.lane_dispatch.execute({ batchId: 'b-t14', lane: 'l1' }, exec),
    (e) => {
      const m = String(e?.message ?? e);
      assert.match(m, /GATE_BATCH_TERMINAL/, '必须仍是既有 GATE_BATCH_TERMINAL');
      assert.equal(m.includes('GATE_CONCURRENCY_EXCEEDED'), false, '不得出现已退役的闸码');
      return true;
    },
  );
  assertNoBlockedEvent(store, SID, 'b-t14', 'T14');
  assert.equal(spawned.length, 0);
  __resetLaneHandles();
});

test('T14b【退役锁 · Q-B】让位纯函数面已随闸删除（无 `pass-through` 判据残留）', () => {
  assert.equal(dispatchMod.concurrencyVerdictOf, undefined, '[退役锁] 让位判据随闸一并删除（不是「改成放行」）');
  assert.equal(dispatchMod.CONCURRENCY_CANDIDATE_CAP, undefined, '[退役锁] 候选截断常量已删除');
  // 既有拒码面仍由各自路径承担（本用例以纯函数面自证「无第二套批终态判据」：
  //   `dispatch.js` 已不再 import `isBatchTerminal`）
  const src = fs.readFileSync(path.join(process.cwd(), 'lib', 'engine', 'dispatch.js'), 'utf8');
  assert.equal(/import\s*\{[^}]*isBatchTerminal/.test(src), false, '[退役锁] dispatch.js 不再 import isBatchTerminal（闸让位面已消失）');
});
