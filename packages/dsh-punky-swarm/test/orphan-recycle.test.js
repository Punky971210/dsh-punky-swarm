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

// 孤儿 worker 清理（v2-node-robustness ③，P1）—— T-TEST-3
// 覆盖：INV-5a/5b/5c/5d/5e、INV-4 回归（stalled 非成员态 + 棘轮未放宽）、watch 开启全链路集成
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import * as mailbox from '../lib/comms/mailbox.js';
import { createLaneHeartbeat } from '../lib/watch/lane-heartbeat.js';
import { buildWavePlan } from '../lib/wave-plan.js';

const SILENT = { warn() {}, info() {}, error() {} };

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-recy-'));
  const store = createStore(root, { logger: SILENT });
  return { root, store, S: 'sess-recycle' };
}

// 造 running 批次 + running lane + 伪造 lane.stalled 事件（模拟 heartbeat 标记）
function makeStalledBatch(store, S, batchId, lane = 'l1') {
  const plan = buildWavePlan({ batchId, tasks: [{ id: lane }] });
  store.createBatch(S, { batchId, wavePlan: plan, phase: 'running' });
  store.setMember(S, batchId, lane, 'running');
  const b = store.readBatch(S, batchId);
  b.events.push({ ts: new Date().toISOString(), type: 'lane.stalled', lane, missed: 3 });
  b.updatedAt = new Date().toISOString();
  fs.writeFileSync(store.batchFile(S, batchId), JSON.stringify(b, null, 2));
  return batchId;
}

test('INV-5a：有 lane.stalled 事件的 running lane → recycleStalledLane 落 idle + lane.recycled 事件', () => {
  const { store, S } = setup();
  const bid = makeStalledBatch(store, S, 'b-stall');
  const r = store.recycleStalledLane(S, bid, 'l1');
  assert.deepEqual(r, { ok: true, lane: 'l1', from: 'running', to: 'idle' });
  const b = store.readBatch(S, bid);
  assert.equal(b.lanes.l1, 'idle');
  const ev = b.events.find((e) => e.type === 'lane.recycled');
  assert.ok(ev, 'lane.recycled 事件存在');
  assert.equal(ev.lane, 'l1');
  assert.equal(ev.from, 'running');
  assert.equal(ev.reason, 'stalled');
});

test('INV-5b：非 running lane（idle/终态）→ recycleStalledLane 拒绝 throw', () => {
  const { store, S } = setup();
  // idle：恢复后
  const bid1 = makeStalledBatch(store, S, 'b-idle');
  store.recoverBatches();
  assert.throws(() => store.recycleStalledLane(S, bid1, 'l1'), /lane not running/);
  // merged 终态
  const bid2 = 'b-merged';
  const plan = buildWavePlan({ batchId: bid2, tasks: [{ id: 'a' }] });
  store.createBatch(S, { batchId: bid2, wavePlan: plan, phase: 'running' });
  store.setMember(S, bid2, 'a', 'running');
  store.setMember(S, bid2, 'a', 'review');
  store.setMember(S, bid2, 'a', 'merged');
  assert.throws(() => store.recycleStalledLane(S, bid2, 'a'), /lane not running/);
});

test('INV-5c：无 lane.stalled 事件的 running lane → 拒绝 throw（防误回收）', () => {
  const { store, S } = setup();
  const plan = buildWavePlan({ batchId: 'b-nostall', tasks: [{ id: 'a' }] });
  store.createBatch(S, { batchId: 'b-nostall', wavePlan: plan, phase: 'running' });
  store.setMember(S, 'b-nostall', 'a', 'running');
  assert.throws(() => store.recycleStalledLane(S, 'b-nostall', 'a'), /no lane.stalled event/);
});

test('INV-5d：批次损坏/不存在 → 拒绝 throw', () => {
  const { store, S } = setup();
  // 不存在
  assert.throws(() => store.recycleStalledLane(S, 'b-missing', 'a'), /batch not found/);
  // 损坏
  store.createBatch(S, { batchId: 'b-bad', wavePlan: buildWavePlan({ batchId: 'b-bad', tasks: [{ id: 'a' }] }), phase: 'running' });
  fs.writeFileSync(store.batchFile(S, 'b-bad'), '{ broken !!');
  assert.throws(() => store.recycleStalledLane(S, 'b-bad', 'a'), /batch not found/);
});

test('INV-5e：回收后经 member_status idle→running 可重派（与 ① 路径联动）', () => {
  const { store, S } = setup();
  const bid = makeStalledBatch(store, S, 'b-re');
  store.recycleStalledLane(S, bid, 'l1');
  assert.doesNotThrow(() => store.setMember(S, bid, 'l1', 'running'));
  assert.equal(store.readBatch(S, bid).lanes.l1, 'running');
});

test('集成（watch 开启）：tick 连续 N 拍无活动 → lane.stalled → 回收 → 重派全链路', () => {
  const { root, store, S } = setup();
  const batchId = 'b-watch';
  const plan = buildWavePlan({ batchId, tasks: [{ id: 'l1', outputs: ['exec/out.txt'] }] });
  store.createBatch(S, { batchId, wavePlan: plan, phase: 'running' });
  store.setMember(S, batchId, 'l1', 'running');
  const cfg = { capabilities: { watch: { enabled: true, intervalsMinutes: [0, 0, 0], maxMissed: 2 } } };
  const engine = createLaneHeartbeat({ store, mailbox, config: cfg, root });
  // 3 拍 → lane.stalled
  for (let i = 0; i < 3; i++) engine.tick();
  const b = store.readBatch(S, batchId);
  const stalledEv = b.events.find((e) => e.type === 'lane.stalled');
  assert.ok(stalledEv, 'lane.stalled 事件产生');
  assert.equal(b.lanes.l1, 'running', 'stalled 仍非成员状态（事件表达，不改 lanes 值）');
  // 显式回收 → idle
  store.recycleStalledLane(S, batchId, 'l1');
  assert.equal(store.readBatch(S, batchId).lanes.l1, 'idle');
  // 重派 → running
  store.setMember(S, batchId, 'l1', 'running');
  assert.equal(store.readBatch(S, batchId).lanes.l1, 'running');
});

test('默认无自动处置：无 stalled→idle 自动迁移断言（回收须显式调用）', () => {
  const { store, S } = setup();
  const bid = makeStalledBatch(store, S, 'b-auto');
  // 仅跑恢复不触发回收（recoverBatches 只处理 running/review→idle，且不产生 lane.recycled）
  store.recoverBatches();
  const b = store.readBatch(S, bid);
  // 注意：recoverBatches 会把 running→idle（恢复语义），但绝不产生 lane.recycled
  assert.equal(b.events.some((e) => e.type === 'lane.recycled'), false, '恢复不产生回收事件（无自动处置）');
});
