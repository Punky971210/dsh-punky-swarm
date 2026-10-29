/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/stop-reason-semantics.test.js —— **X0-A 停止语义**（`stopReason` ⇒ 是否可结算）的**两向**判据。
//
// 判据（口径源 AC-2/AC-3，禁改写）：
//   · 单向收紧：**`stopReason === null`（宿主未上报）⇒ 不可结算** —— 未知 ≠ 已停；
//   · 正向放行：`'completed'` ⇒ 可结算（若把 completed 也挡掉，等于功能坏死，同样红）；
//   · 四值拒绝：`'aborted'/'error'/'max-tokens'/'refusal'` 逐个不可结算；
//   · 未枚值：`'mystery'`（宿主新增枚举）保守不结算（fail-safe：宁不结算不谎报）；
//   · 留痕不丢：不可结算分支的事件载荷**必须保留 `stopReason` 原值**（`null` 也要留），`settleable === false`。
//
// 每条判据的**可红形态**（实现若写错 ⇒ 本用例红）：
//   S1 若恢复旧式 `stopReason === null || SETTLEABLE…includes()` 短路 ⇒ `null` 例的 action 变 'merged' ⇒ 红；
//   S2 若把 `'completed'` 从可结算集合删掉 ⇒ 正例 action 变 'recorded' ⇒ 红（挡住「收得过紧」的另一侧）；
//   S3 若四值中任一被放进可结算集合 ⇒ 该值例 action 变 'merged' ⇒ 红；
//   S4 若未枚值走「未知当已停」⇒ 'mystery' 例 action 变 'merged' ⇒ 红；
//   S5 若不可结算分支不再写 `stopReason` 到事件载荷（丢掉留痕）⇒ `stopReason` 断言红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import {
  threeTierTasks, seedArtifacts, assemblyCtxOpts,
} from './helpers/gate-fixture.mjs';
import { EVT_AUTO_SETTLE_TRIGGERED } from '../lib/state/event-types.js';
import { autoSettleLane, AUTO_SETTLE_TRIGGERS, hasAutoSettleRecord } from '../lib/engine/auto-settle.js';

const tempRoot = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** 真 store 的批次床（与 `auto-settle.test.js` 同形：真 wavePlan + 真成员态 + 真产物目录）。 */
function seedBatch(root, sessionId, batchId, { lane = 'e1', phase = 'running', memberState = 'running' } = {}) {
  const store = createStore(root);
  const plan = buildWavePlan({ batchId, tasks: threeTierTasks([lane]) });
  store.createBatch(sessionId, { batchId, wavePlan: plan, phase });
  seedArtifacts(root, sessionId, batchId, [lane]);
  if (memberState) store.setMember(sessionId, batchId, lane, memberState);
  return store;
}

/** 跑一次 `autoSettleLane` 并回读「触发事件 + lane 状态」。 */
async function runWith(root, sessionId, batchId, stopReason, workerSessionId) {
  const store = seedBatch(root, sessionId, batchId);
  const r = await autoSettleLane(
    { ctx: assemblyCtxOpts(), store, root },
    { sessionId, batchId, lane: 'e1', workerSessionId, stopReason, trigger: AUTO_SETTLE_TRIGGERS.subagentEnd },
  );
  const b = store.readBatch(sessionId, batchId);
  const trig = b.events.filter((e) => e.type === EVT_AUTO_SETTLE_TRIGGERED);
  return { r, lane: b.lanes.e1, trig: trig[trig.length - 1] };
}

test('S1 【单向收紧】stopReason === null（宿主未上报）⇒ 不可结算：action==="recorded"、lane 保持 running、载荷保留 stopReason:null 且 settleable===false', async () => {
  const root = tempRoot('punky-srs-s1-');
  const { r, lane, trig } = await runWith(root, 'sess-s1', 'b-s1', null, 'ws-s1');
  assert.equal(r.action, 'recorded', '未知 ≠ 已停（旧式 null 短路会 merged）');
  assert.equal(r.reason, 'stop-reason-not-settleable');
  assert.equal(lane, 'running', 'lane 不得被结算');
  assert.ok(trig, '不可结算也要留痕（EVT_AUTO_SETTLE_TRIGGERED）');
  assert.equal(trig.stopReason, null, '载荷必须保留原值 null（留痕不丢）');
  assert.equal(trig.settleable, false);
});

test('S2 【正向放行】stopReason === "completed" ⇒ 可结算：action==="merged"、lane merged、settleable===true', async () => {
  const root = tempRoot('punky-srs-s2-');
  const { r, lane, trig } = await runWith(root, 'sess-s2', 'b-s2', 'completed', 'ws-s2');
  assert.equal(r.action, 'merged', 'completed 必须可结算（否则功能坏死）');
  assert.equal(lane, 'merged');
  assert.equal(trig.stopReason, 'completed');
  assert.equal(trig.settleable, true);
});

for (const reason of ['aborted', 'error', 'max-tokens', 'refusal']) {
  test(`S3 【四值逐个】stopReason === "${reason}" ⇒ 不可结算（action==="recorded"、lane 保持 running）`, async () => {
    const root = tempRoot('punky-srs-s3-');
    const { r, lane, trig } = await runWith(root, 'sess-s3', 'b-s3', reason, 'ws-s3');
    assert.equal(r.action, 'recorded', reason + ' 不得结算');
    assert.equal(lane, 'running');
    assert.equal(trig.stopReason, reason, '载荷保留原值');
    assert.equal(trig.settleable, false);
  });
}

test('S4 【未枚值 fail-safe】stopReason === "mystery"（宿主新增枚举）⇒ 保守不结算', async () => {
  const root = tempRoot('punky-srs-s4-');
  const { r, lane } = await runWith(root, 'sess-s4', 'b-s4', 'mystery', 'ws-s4');
  assert.equal(r.action, 'recorded', '未知枚举不得当已停');
  assert.equal(lane, 'running');
});

test('S5 【两向对照】同一批床只改 stopReason：null 与 completed 的行动必须不同（唯一变量隔离）', async () => {
  const rootA = tempRoot('punky-srs-s5a-');
  const rootB = tempRoot('punky-srs-s5b-');
  const a = await runWith(rootA, 'sess-s5', 'b-s5', null, 'ws-s5');
  const b = await runWith(rootB, 'sess-s5', 'b-s5', 'completed', 'ws-s5');
  assert.notEqual(a.r.action, b.r.action, 'null 与 completed 必须可区分（否则判据无区分力）');
  assert.deepEqual([a.r.action, b.r.action], ['recorded', 'merged']);
});

// ══ F4 (C) 追加：幂等键不退让 ＋ 反 A 型退化（Leader 裁定后补的两条判据）══════════════════

/** 同一批床上跑一次 autoSettleLane（可指定 trigger 与 stopReason）。 */
async function settleOn(store, root, sessionId, batchId, { workerSessionId, stopReason, trigger }) {
  return autoSettleLane(
    { ctx: assemblyCtxOpts(), store, root },
    { sessionId, batchId, lane: 'e1', workerSessionId, stopReason, trigger },
  );
}

test('F1 【F4(C)·幂等键不退让】工具路 recorded 不占键 ⇒ 宿主随后 completed 仍 merged；且已结算后同键再来 ⇒ skipped（幂等仍在）', async () => {
  // 可红形态：删掉 `hasAutoSettleRecord` 里
  //   `if (e.type === EVT_AUTO_SETTLE_TRIGGERED && e.settleable === false) continue;` 这一行
  //   ⇒ `recorded` 占键 ⇒ 第 2 步被判 skipped/already-settled ⇒ 本用例红（lane 永停 running）。
  const root = tempRoot('punky-srs-f1-');
  const store = seedBatch(root, 'sess-f1', 'b-f1');
  // ① 工具路先到（swarm_report(settle-request)，无 stopReason ⇒ null）
  const r1 = await settleOn(store, root, 'sess-f1', 'b-f1', { workerSessionId: 'ws-f1', stopReason: null, trigger: AUTO_SETTLE_TRIGGERS.settleRequest });
  assert.equal(r1.action, 'recorded', '工具路无可观测 stopReason ⇒ 只能 recorded');
  assert.equal(store.readBatch('sess-f1', 'b-f1').lanes.e1, 'running', '此刻 lane 必须仍 running（未结算）');
  assert.notEqual(r1.action, 'merged', '反 A 型退化：第一步不得 merged（若硬塞 completed 就变 merged ⇒ 本行立即红）');
  assert.equal(hasAutoSettleRecord(store.readBatch('sess-f1', 'b-f1'), 'e1', 'ws-f1'), false, 'recorded（settleable:false）不得占幂等键');
  // ② 宿主随后上报 completed（主路 subagent/end）
  const r2 = await settleOn(store, root, 'sess-f1', 'b-f1', { workerSessionId: 'ws-f1', stopReason: 'completed', trigger: AUTO_SETTLE_TRIGGERS.subagentEnd });
  assert.equal(r2.action, 'merged', '功能不死：宿主上报后必须能结算（旧实现会 skipped/already-settled）');
  assert.equal(store.readBatch('sess-f1', 'b-f1').lanes.e1, 'merged', 'lane 必须转 merged');
  // ③ 幂等仍在：已真正结算后，同 (lane, settleId) 再触发 ⇒ skipped
  const r3 = await settleOn(store, root, 'sess-f1', 'b-f1', { workerSessionId: 'ws-f1', stopReason: 'completed', trigger: AUTO_SETTLE_TRIGGERS.subagentEnd });
  assert.equal(r3.action, 'skipped', '已结算 ⇒ 幂等键有效（不是把键校验整体删掉）');
  assert.equal(hasAutoSettleRecord(store.readBatch('sess-f1', 'b-f1'), 'e1', 'ws-f1'), true, '可结算触发必须占键');
});

test('F2 【反 A 型退化·可红形态实测】若把 stopReason="completed" 硬塞进工具路 ⇒ 第一步即 merged（F1 的 notEqual 立刻红）', async () => {
  // 这条是「下次有人顺手修」的**报警器**：A 型退化（执行体自报语义）不是错在结果，而是错在**声明语义**；
  //   它以 merged 提前占位 ⇒ 宿主真上报前的 untrusted 推断变成既成事实 ⇒ F1 的第 1/3 步立刻红。
  const root = tempRoot('punky-srs-f2-');
  const store = seedBatch(root, 'sess-f2', 'b-f2');
  const degenerate = await settleOn(store, root, 'sess-f2', 'b-f2', { workerSessionId: 'ws-f2', stopReason: 'completed', trigger: AUTO_SETTLE_TRIGGERS.settleRequest });
  assert.equal(degenerate.action, 'merged', '退化构造确实 merged ⇒ 证明 F1 的 notEqual(第一步 !== merged) 有杀伤力');
  assert.equal(hasAutoSettleRecord(store.readBatch('sess-f2', 'b-f2'), 'e1', 'ws-f2'), true, '退化后键被占 ⇒ 后续真实上报会被挡（这正是 F1 要防的）');
});
