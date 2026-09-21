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

// test/replay-integration.test.js —— W1-①【重放/恢复】**集成面**回归锁
// ─────────────────────────────────────────────────────────────────────────────
// 场景（模拟崩溃现场）：批处于 `running`、`exec_1` 已 `merged`，但**没有任何 `chain.step`**
//   ——即进程死在「已结算」与「已推进」之间。断言：
//     ① `replayBatch` 补上决策（落 `chain.step`，`dispatch.mode = 'manual-pending'`，
//        **不真派**：装配期无挂载点，与 S12 裁决一致）；
//     ② **再次重放零新增**（幂等：该步已在其结算之后推进过）⇒ 防重复推进/重复派发；
//     ③ 非 `running` 相位（`paused`）**不重放**（`resume` 是唯一恢复入口）。
//
// 夹具：临时 `root`（store）+ 临时 `teamsRoot`（仅 v1 链声明），**不经工具面**（本模块本就是
//   工具流水线之外的恢复面）。三处踩点（WIP 留档的更正，2026-09-17 实测）：
//     ① `store.appendEvent` **自带 `ts`**（`lib/state/store.js:238-240` `newEvent()`）⇒ `settleTsOf` 的
//        时间判据成立，**不需要**夹具手工补 ts；
//     ② 但**裸 `appendEvent` 改不了 `batch.lanes`**（`batch.lanes[lane] = to` 只在 `store.setMember`
//        内，`store.js:693`）⇒ 必须走 `setMember` 的合法迁移链（`running → review → merged`，
//        `store.js:564-568` 拒直跨），否则 `pendingAdvancesOf` 的终态判据不成立（WIP `actual: []` 的真因）；
//     ③ `createBatch(sessionId, arg)` 要求 `arg.wavePlan.wavePlan` 是 wave 数组（`store.js:298`），
//        且 **`arg.wavePlan.teamsRoot` 必须带上**——`batch.teamsRoot` 由它落键（`store.js:320`），
//        缺则 `chainOfBatch` 回退包根 ⇒ `no-chain`（我实测复现过这个失败态）。
//   另：`exec_1` 结算到 `merged` 前须先落其 `outputs` 产物，否则 exit 门拒 `GATE_EXIT_MISSING_EXEC`。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../lib/state/store.js';
import * as replayMod from '../lib/engine/replay.js';
import { replayBatch } from '../lib/engine/replay.js';
import { chainOfBatch } from '../lib/assembly/chain.js';
import { clearRoleCache } from '../lib/assembly/flows.js';
import { EVT_MEMBER_SETTLED, EVT_CHAIN_STEP } from '../lib/state/event-types.js';
import { seedArtifacts, runLane } from './helpers/gate-fixture.mjs';
import { writeSyntheticTeam } from './helpers/team-fixture.mjs';
import * as mailbox from '../lib/comms/mailbox.js';
import { createLaneHeartbeat } from '../lib/watch/lane-heartbeat.js';

const SESSION = 'sess-replay';
const TEAM = 'replay-team';
const asset = {
  team: TEAM,
  layers: {
    plan: { roles: ['designer'], skills: { designer: ['spec-writing'] } },
    exec: { roles: ['coder'], skills: { coder: ['dev-coder'] } },
    audit: { roles: ['reviewer'], skills: { reviewer: ['review-execution'] } },
  },
  roles: { plan_leads: ['designer'], audit_leads: ['reviewer'] },
  flows: {
    plan: { produce_field: 'produce', entry_requires: [] },
    exec: { produce_field: 'outputs', consume_field: 'consume', entry_requires: [] },
    audit: { produce_field: 'produce', consume_field: 'consume', entry_requires: [] },
  },
  chain: {
    version: 1,
    steps: [
      { id: 'exec', layer: 'exec', role: 'coder', join: 'all', next: 'audit' },
      { id: 'audit', layer: 'audit', role: 'reviewer', terminal: true },
    ],
    join: { anyFailure: 'pause' },
    onFail: 'pause',
  },
};

const WAVEPLAN = [{
  tasks: [
    { id: 'plan', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
    // 产物路径与 `seedArtifacts` 的落盘口径对齐（`exec/<laneId>.md`）——exit 门按声明路径核对在场
    { id: 'exec_1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/exec_1.md'], cmd: 'e1' },
    { id: 'audit', layer: 'audit', role: 'reviewer', consume: ['exec/exec_1.md'], produce: ['audit/audit.md'], cmd: 'a' },
  ],
}];

function mkHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-replay-root-'));
  const teamsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-replay-teams-'));
  // F2：合成资产 ⇒ 单点写入（helpers/team-fixture.mjs）。
  writeSyntheticTeam(teamsRoot, TEAM, asset);
  clearRoleCache();
  const store = createStore(root);
  return { root, store, teamsRoot, ctx: { logger: { info() {}, warn() {}, error() {} } } };
}

/** 建一个处于「已结算但未推进」现场的批（= 崩溃现场）。
 *  `plan` 的**四个键都必需**：`wavePlan`（wave 数组）+ `team` + `teamsRoot` 决定链能否加载，缺一即 `no-chain`。 */
function mkCrashScene(h, batchId, { phase = 'running' } = {}) {
  const plan = { batchId, wavePlan: WAVEPLAN, concurrency: 2, team: TEAM, teamsRoot: h.teamsRoot };
  h.store.createBatch(SESSION, { batchId, wavePlan: plan, concurrency: 2, team: TEAM, teamsRoot: h.teamsRoot });
  // 相位迁走合法链（`planning -> paused` 被批次相位机拒，须先 `running` 再 `paused`）
  if (phase !== 'planning') h.store.setPhase(SESSION, batchId, 'running');
  if (phase !== 'planning' && phase !== 'running') h.store.setPhase(SESSION, batchId, phase);
  // entry 门（consume 产物须在场）+ exit 门（outputs 产物须在场）共用同一落盘器
  seedArtifacts(h.root, SESSION, batchId, ['exec_1'], { auditId: 'audit' });
  runLane(h.store, SESSION, batchId, 'exec_1'); // running → review → merged（合法迁移链）
  return h.store.readBatch(SESSION, batchId);
}

const chainStepsOf = (h, b) => (h.store.readBatch(SESSION, b)?.events ?? []).filter((e) => e.type === EVT_CHAIN_STEP);

/** 【退役锁 · Q-A=C 2026-09-18（批 `engine-retire-chain-20260918`）】重放能力已退役自证：
 *  `replayBatch` 恒为空壳（**零读批、零判据、零事件、零派发**）——传入「读批即抛」的假 store 亦不触发读批；
 *  三个纯判据函数（`settleTsOf` / `advancedAfter` / `pendingAdvancesOf`）已从导出面**删除**（断言见
 *  `test/replay-recovery.test.js`）。
 *  ⚠ 本文件 RI-1..RI-7 锁定的行为（补决策 / 幂等 / 相位闸 / 心跳兜底 / 零 churn）随退役**整体消失** ⇒
 *  用例改为「自证入口空壳」后返回；旧断言保留在下方作**历史口径留档**（不再执行），改写为纯退役锁的
 *  followup 见 exec 产物 `exec/engine-retire.md`（§1 变更清单表的测试改写行 / §6 未决项 · gap 段，交 audit 收 gap-list）。 */
async function assertReplayRetired(h, batchId) {
  assert.equal(Object.hasOwn(replayMod, 'pendingAdvancesOf'), false, '[退役锁] 「待重放 lane」纯函数已删除');
  const b0 = h.store.readBatch(SESSION, batchId);
  const before = { events: b0?.events?.length ?? 0, steps: chainStepsOf(h, batchId).length, phase: b0?.phase };
  const out = await replayBatch(
    { store: { readBatch() { throw new Error('不得读批'); } }, root: h.root },
    h.ctx,
    { sessionId: SESSION, batchId },
  );
  assert.equal(out.ok, true, '[退役锁] 入口恒不报错：' + JSON.stringify(out));
  assert.equal(out.scanned, 0, '[退役锁] scanned=0（不再判「已结算未推进」）');
  assert.equal(out.replayed, 0, '[退役锁] replayed=0（零重放）');
  assert.equal(out.reason, 'retired', '[退役锁] reason=retired');
  const b1 = h.store.readBatch(SESSION, batchId);
  assert.equal(b1?.events?.length ?? 0, before.events, '[退役锁] 零新增事件');
  assert.equal(chainStepsOf(h, batchId).length, before.steps, '[退役锁] 零 chain.step（推进留痕写点已删）');
  assert.equal(b1?.phase, before.phase, '[退役锁] 相位不变');
}

/** 心跳引擎夹具（W1-① 周期兜底面）：真 store + 真 mailbox + 真引擎，`now` 固定在同一时刻
 *  （全部事件都在「刚发生」⇒ 既不会判 stalled 也不会产 longrun 候选，probe 相位不干扰被检面）。 */
function mkHeartbeat(h) {
  const nowTs = Date.now();
  return createLaneHeartbeat({
    store: h.store,
    mailbox,
    config: {},
    root: h.root,
    now: () => nowTs,
    logger: h.ctx.logger,
  });
}

test('RI-1【退役锁 · Q-A=C】崩溃现场：`merged` 但无 `chain.step` ⇒ 重放入口恒空壳（不再补决策、不再落待派清单）', async () => {
  const h = mkHarness();
  const B = 'ri-1';
  const batch = mkCrashScene(h, B);
  // 【退役锁 · Q-A=C 2026-09-18】重放（补链推进决策）已退役 ⇒ 自证入口空壳后返回（旧断言留档，不执行）。
  await assertReplayRetired(h, B);
  return;

  const chain = chainOfBatch(h.store.readBatch(SESSION, B));
  assert.equal(chain.ok && !!chain.chain, true, '夹具链声明必须可加载');
  const pend = pendingAdvancesOf(h.store.readBatch(SESSION, B), chain.chain);
  assert.deepEqual(pend.map((p) => p.lane), ['exec_1'], '命中崩溃现场（已结算未推进）');

  const r = await replayBatch({ store: h.store, root: h.root }, h.ctx, { sessionId: SESSION, batchId: B });
  assert.equal(r.ok, true, '重放不报错：' + JSON.stringify(r));
  assert.equal(r.scanned, 1, '扫描到 1 条待重放');

  const steps = chainStepsOf(h, B);
  assert.equal(steps.length, 1, '恰补 1 条 chain.step');
  assert.deepEqual([steps[0].from, steps[0].to], ['exec', 'audit'], '决策 = exec → audit');
  assert.equal(steps[0].dispatch?.mode, 'manual-pending', '装配期无挂载点 ⇒ 只落待派清单（不真派）');
  assert.equal(steps[0].dispatch?.reason, 'no-mount-point');
  assert.deepEqual((steps[0].dispatch?.lanes ?? []).map((x) => x.lane), ['audit'], '待派清单 = audit lane');
  assert.equal(h.store.readBatch(SESSION, B).phase, 'running', '相位保持 running（补决策不是停轮）');
  assert.equal(batch.lanes.audit, 'pending', '未派发 ⇒ 目标 lane 状态不变');
});

test('RI-2【退役锁 · Q-A=C】幂等面已无对象：同一现场重复重放 ⇒ 恒零新增 chain.step（入口空壳无幂等判据）', async () => {
  const h = mkHarness();
  const B = 'ri-2';
  mkCrashScene(h, B);
  // 【退役锁 · Q-A=C 2026-09-18】重放幂等面已退役 ⇒ 自证入口空壳后返回（旧断言留档，不执行）。
  await assertReplayRetired(h, B);
  return;
  const first = await replayBatch({ store: h.store, root: h.root }, h.ctx, { sessionId: SESSION, batchId: B });
  assert.equal(first.replayed, 1, '首次补 1 处');
  const second = await replayBatch({ store: h.store, root: h.root }, h.ctx, { sessionId: SESSION, batchId: B });
  assert.equal(second.scanned, 0, '第二次扫描：该步已在其结算之后推进过 ⇒ 零对象');
  assert.equal(second.replayed, 0, '零重放');
  assert.equal(chainStepsOf(h, B).length, 1, '事件面零重复');
});

test('RI-3【退役锁 · Q-A=C】相位闸已无对象：`paused` 批同样零重放（入口不再读批 ⇒ 无相位可判）', async () => {
  const h = mkHarness();
  const B = 'ri-3';
  mkCrashScene(h, B, { phase: 'paused' });
  // 【退役锁 · Q-A=C 2026-09-18】相位闸面已退役（入口不再读批 ⇒ 无相位可判）⇒ 自证后返回（旧断言留档）。
  await assertReplayRetired(h, B);
  return;
  assert.equal(h.store.readBatch(SESSION, B).phase, 'paused', '夹具相位 = paused');
  const r = await replayBatch({ store: h.store, root: h.root }, h.ctx, { sessionId: SESSION, batchId: B });
  assert.equal(r.replayed, 0, 'paused ⇒ 不补决策');
  assert.equal(r.scanned, 0, 'paused ⇒ 连通读都不进（相位闸先于判定）');
  assert.equal(r.reason, 'phase-paused', '理由可自证');
  assert.equal(chainStepsOf(h, B).length, 0, '零事件');
  // 副判据（同族边界，零新增事件面）：现场本身是「已结算未推进」，被拦的是**相位**而不是判定为空
  const chain = chainOfBatch(h.store.readBatch(SESSION, B));
  assert.deepEqual(pendingAdvancesOf(h.store.readBatch(SESSION, B), chain.chain).map((p) => p.lane), ['exec_1'],
    '相位闸生效前，现场确实命中重放对象（证明 RI-3 拦的是相位而非空集）');
});

// ── W1-①【周期兜底】：心跳 tick 也调 `replayBatch`（任务 B） ──────────────────────
// 边界（与既有「只标记不自动处置」纪律并读）：重放**补决策**（`chain.step{manual-pending}`），
//   不派发、不改相位、不改成员状态；stalled/longrun/binding-gap 三档行为不得因此改变（回归锁见 RI-5/RI-6）。

test('RI-4【退役锁 · Q-A=C】心跳兜底已无对象：tick 后零 chain.step（不再补链推进决策）', async () => {
  const h = mkHarness();
  const B = 'ri-4';
  mkCrashScene(h, B);
  // 【退役锁 · Q-A=C 2026-09-18】心跳周期兜底面已退役 ⇒ 自证入口空壳后返回（旧断言留档，不执行）。
  await assertReplayRetired(h, B);
  return;
  const hb = mkHeartbeat(h);
  assert.equal(chainStepsOf(h, B).length, 0, 'tick 前：崩溃现场（零 chain.step）');

  hb.tick();
  await hb.replayInFlight(); // 不 sleep：句柄即「本拍补决策已落盘」的可等待证据

  const steps = chainStepsOf(h, B);
  assert.equal(steps.length, 1, '心跳补 1 条 chain.step');
  assert.deepEqual([steps[0].from, steps[0].to], ['exec', 'audit'], '决策 = exec → audit');
  assert.equal(steps[0].dispatch?.mode, 'manual-pending', '心跳在工具流水线之外 ⇒ 只落待派清单（不真派）');
  assert.equal(steps[0].dispatch?.reason, 'no-mount-point');
  assert.deepEqual((steps[0].dispatch?.lanes ?? []).map((x) => x.lane), ['audit'], '待派清单 = audit lane');
  assert.equal(h.store.readBatch(SESSION, B).phase, 'running', '补决策不是自动处置：相位保持 running');
  assert.equal(h.store.readBatch(SESSION, B).lanes.audit, 'pending', '目标 lane 状态不变（零派发）');
  hb.dispose();
});

test('RI-5【退役锁 · Q-A=C】心跳兜底幂等已无对象：连拍恒零新增 chain.step（入口空壳无可重复推进）', async () => {
  const h = mkHarness();
  const B = 'ri-5';
  mkCrashScene(h, B);
  // 【退役锁 · Q-A=C 2026-09-18】心跳兜底幂等面已退役 ⇒ 自证入口空壳后返回（旧断言留档，不执行）。
  await assertReplayRetired(h, B);
  return;
  const hb = mkHeartbeat(h);
  hb.tick(); await hb.replayInFlight();
  assert.equal(chainStepsOf(h, B).length, 1, '第一拍补 1 条');
  hb.tick(); await hb.replayInFlight();
  assert.equal(chainStepsOf(h, B).length, 1, '第二拍零新增（`advancedAfter` 幂等判据生效）');
  assert.equal(chainStepsOf(h, B).filter((e) => e.type === EVT_CHAIN_STEP).length, 1, '事件面零重复');
  hb.dispose();
});

test('RI-6【退役锁 · Q-A=C】相位闸回归锁已无对象：paused / planning 批在 tick 里同样零 chain.step + 相位不变', async () => {
  const h = mkHarness();
  const hb = mkHeartbeat(h);
  mkCrashScene(h, 'ri-6a', { phase: 'paused' });
  mkCrashScene(h, 'ri-6b', { phase: 'planning' });
  // 【退役锁 · Q-A=C 2026-09-18】非 running 批的相位闸面已退役（入口不再读批）⇒ 自证后返回（旧断言留档）。
  await assertReplayRetired(h, 'ri-6a');
  await assertReplayRetired(h, 'ri-6b');
  hb.dispose();
  return;
  hb.tick(); await hb.replayInFlight();
  assert.equal(chainStepsOf(h, 'ri-6a').length, 0, 'paused ⇒ 心跳不补决策（resume 是唯一恢复入口）');
  assert.equal(chainStepsOf(h, 'ri-6b').length, 0, 'planning ⇒ 未武装，心跳不补决策');
  assert.equal(h.store.readBatch(SESSION, 'ri-6a').phase, 'paused', '相位未被改动');
  assert.equal(h.store.readBatch(SESSION, 'ri-6b').phase, 'planning', '相位未被改动');
  hb.dispose();
});

test('RI-7【退役锁 · Q-A=C】churn 面已无对象：running 批连跑多拍恒零事件、零 chain.step（入口空壳无补决策日志）', async () => {
  const h = mkHarness();
  const B = 'ri-7';
  mkCrashScene(h, B);
  // 【退役锁 · Q-A=C 2026-09-18】「零 churn」面随重放退役 ⇒ 自证入口空壳后返回（旧断言留档，不执行）。
  await assertReplayRetired(h, B);
  return;
  const logs = [];
  h.ctx.logger.info = (m) => logs.push(m);
  const hb = mkHeartbeat(h);
  hb.tick(); await hb.replayInFlight(); // 第一拍把现场补平
  assert.equal(chainStepsOf(h, B).length, 1, '第一拍补上决策');
  logs.length = 0;
  const eventsBefore = h.store.readBatch(SESSION, B).events.length;
  for (let i = 0; i < 4; i++) { hb.tick(); await hb.replayInFlight(); } // 连续 4 拍
  assert.equal(h.store.readBatch(SESSION, B).events.length, eventsBefore, '后续 4 拍零新增事件（幂等 + 无 churn）');
  assert.equal(chainStepsOf(h, B).length, 1, 'chain.step 恒为 1');
  assert.deepEqual(logs.filter((m) => String(m).includes('replay(心跳)')), [], '零命中零日志（补决策已落盘 ⇒ 无重复日志）');
  hb.dispose();
});
