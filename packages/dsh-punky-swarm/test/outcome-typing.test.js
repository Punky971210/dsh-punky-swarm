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

// C5 outcome 分型（impl-c4c5 e1）最小自检 —— 契约 spec「## 实施范围/C5」语义契约 1-7
// 覆盖：恢复记 crashed / 中断(回收)记 interrupted / attempt 派生零变 / 既有语义零变化断言 / 旧批回退
// 写入点契约注记见 exec/outcome-impl.md（e1 产物），本文件为对应用例。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as schema from '../lib/schema.js';
import { createStore, countConsecutiveFailedSettles } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';

const SILENT = { warn() {}, info() {}, error() {} };

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-outcome-'));
  const store = createStore(root, { logger: SILENT });
  return { root, store, S: 'sess-outcome' };
}

// 造 running 批次 + running/review lane（恢复前 in-flight 中间态）；lanes = [[id, state], ...]
function makeInflightBatch(store, S, batchId, lanes) {
  const plan = buildWavePlan({ batchId, tasks: lanes.map(([id]) => ({ id })) });
  store.createBatch(S, { batchId, wavePlan: plan, phase: 'running' });
  for (const [id, st] of lanes) {
    store.setMember(S, batchId, id, 'running');
    if (st === 'review') store.setMember(S, batchId, id, 'review');
  }
}

// 造 stalled 证据的 running lane（模拟 heartbeat 标记，回收前置）
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

test('C5-1 恢复记 crashed：recoverBatches 后 system.recovered.detail[].outcome=crashed（running/review→idle）', () => {
  const { store, S } = setup();
  makeInflightBatch(store, S, 'b-crash', [['r1', 'running'], ['r2', 'review']]);
  const recovered = store.recoverBatches();
  assert.ok(recovered.includes(S + '/b-crash'));
  const b = store.readBatch(S, 'b-crash');
  assert.equal(b.lanes.r1, 'idle');
  assert.equal(b.lanes.r2, 'idle');
  const ev = b.events.filter((e) => e.type === 'system.recovered').at(-1);
  assert.ok(ev, 'system.recovered event missing');
  const byLane = Object.fromEntries(ev.detail.map((d) => [d.lane, d]));
  assert.equal(byLane.r1.outcome, 'crashed');
  assert.equal(byLane.r2.outcome, 'crashed');
  assert.equal(byLane.r1.from, 'running');
  assert.equal(byLane.r2.from, 'review');
  assert.deepEqual([...ev.recoveredLanes].sort(), ['r1', 'r2']); // 既有字段保留
});

test('C5-2 中断/超时记 interrupted：recycleStalledLane 后 lane.recycled.outcome=interrupted', () => {
  const { store, S } = setup();
  const bid = makeStalledBatch(store, S, 'b-recyc');
  const r = store.recycleStalledLane(S, bid, 'l1');
  assert.deepEqual(r, { ok: true, lane: 'l1', from: 'running', to: 'idle' }); // 返回形态零变
  const b = store.readBatch(S, bid);
  assert.equal(b.lanes.l1, 'idle');
  const ev = b.events.find((e) => e.type === 'lane.recycled');
  assert.ok(ev, 'lane.recycled event missing');
  assert.equal(ev.lane, 'l1');
  assert.equal(ev.from, 'running');
  assert.equal(ev.reason, 'stalled');
  assert.equal(ev.outcome, 'interrupted');
});

test('C5-3 crashed/interrupted 不写成员态：schema 枚举/迁移/终端判定零变 + lanes 值域不变', () => {
  const { store, S } = setup();
  // schema 面零变（A13）
  assert.equal(schema.MEMBER_STATES.includes('crashed'), false);
  assert.equal(schema.MEMBER_STATES.includes('interrupted'), false);
  assert.equal(schema.isMemberState('crashed'), false);
  assert.equal(schema.isMemberState('interrupted'), false);
  assert.equal(schema.SETTLE_STATES.includes('crashed'), false);
  assert.equal(schema.SETTLE_STATES.includes('interrupted'), false);
  assert.deepEqual(schema.SETTLE_STATES, ['merged', 'failed', 'skipped']);
  assert.equal(schema.isMemberTerminal('crashed'), false);
  assert.equal(schema.canTransitionMember('running', 'idle'), false); // 迁移表未放宽
  assert.deepEqual(schema.MEMBER_STATES, ['pending', 'running', 'review', 'merged', 'failed', 'skipped', 'conflict', 'idle']);

  // 运行时：恢复/回收后 lanes 落 idle（既有成员态），绝不写 crashed/interrupted
  makeInflightBatch(store, S, 'b-a', [['x', 'running']]);
  store.recoverBatches();
  assert.equal(store.readBatch(S, 'b-a').lanes.x, 'idle');
  const bid2 = makeStalledBatch(store, S, 'b-b');
  store.recycleStalledLane(S, bid2, 'l1');
  assert.equal(store.readBatch(S, bid2).lanes.l1, 'idle');
  const allLaneStates = ['b-a', 'b-b'].flatMap((id) => Object.values(store.readBatch(S, id).lanes));
  assert.ok(allLaneStates.every((s) => schema.isMemberState(s)), 'lanes 值域必须全为成员态');
});

test('C5-4 attempt 派生零变：crashed/interrupted 不入 member.settled，事件计数推导口径不变', () => {
  const { store, S } = setup();
  // 带返工（review→running）→ 崩溃恢复 → 停滞回收 的复合事件流
  const bid = 'b-mix';
  const plan = buildWavePlan({ batchId: bid, tasks: [{ id: 'l1' }, { id: 'l2' }] });
  store.createBatch(S, { batchId: bid, wavePlan: plan, phase: 'running' });
  // l1：running→review→running（attempt+1 的既有派生源）→review→conflict 终态
  store.setMember(S, bid, 'l1', 'running');
  store.setMember(S, bid, 'l1', 'review');
  store.setMember(S, bid, 'l1', 'running');
  store.setMember(S, bid, 'l1', 'review');
  store.setMember(S, bid, 'l1', 'conflict');
  // l2：running 中 crash（recoverBatches 记 crashed）
  store.setMember(S, bid, 'l2', 'running');
  store.recoverBatches();
  const b = store.readBatch(S, bid);
  // attempt 派生（对齐 api.js laneAttempts 口径：member.settled from=review && to=running）
  const laneAttempts = {};
  for (const e of b.events) {
    if (e.type === 'member.settled' && e.from === 'review' && e.to === 'running') {
      laneAttempts[e.lane] = (laneAttempts[e.lane] ?? 0) + 1;
    }
  }
  assert.equal(laneAttempts.l1, 1); // 数值语义与接线前一致
  assert.equal(laneAttempts.l2, undefined); // crash 不产生 attempt 计数
  // crashed/interrupted 只出现在 outcome 分型字段，绝不作为 member.settled.to
  const settled = b.events.filter((e) => e.type === 'member.settled');
  assert.ok(settled.every((e) => ['pending', 'running', 'review', 'merged', 'failed', 'skipped', 'conflict'].includes(e.to)));
  assert.ok(!settled.some((e) => e.to === 'crashed' || e.to === 'interrupted'));
  // 恢复/回收事件本身不是 member.settled（不打断连续失败计数；见 C5-5）
});

test('C5-5 failed-escalate 计数零变：crashed/interrupted 记账事件不打断 countConsecutiveFailedSettles', () => {
  // 纯函数级验证：恢复（system.recovered）与回收（lane.recycled）记账事件均为非 member.settled，
  // 计数纯函数扫描时 continue 跳过 → 既不计数也不打断连续 failed 链（语义零变）
  const mk = (type, to, lane = 'a') => ({ ts: new Date().toISOString(), type, lane, ...(to ? { to } : {}) });
  const events = [
    mk('member.settled', 'failed'),
    mk('member.settled', 'failed'),
    { ts: new Date().toISOString(), type: 'system.recovered', batchId: 'x', detail: [{ lane: 'b', outcome: 'crashed' }] },
    { ts: new Date().toISOString(), type: 'lane.recycled', lane: 'b', outcome: 'interrupted' },
    mk('member.settled', 'failed'),
  ];
  assert.equal(countConsecutiveFailedSettles(events), 3); // 记账事件插入不打断
  // 对照：尾部为非 failed 结算（running 派发）→ 归零（既有语义）
  assert.equal(countConsecutiveFailedSettles([...events, mk('member.settled', 'running')]), 0);
  // crashed/interrupted 只作为 outcome 分型字段存在，绝不作为 member.settled.to
  assert.ok(!events.some((e) => e.type === 'member.settled' && (e.to === 'crashed' || e.to === 'interrupted')));
  assert.ok(events.some((e) => e.type === 'system.recovered' && e.detail[0].outcome === 'crashed'));
  assert.ok(events.some((e) => e.type === 'lane.recycled' && e.outcome === 'interrupted'));
});

test('C5-6 旧批次/旧读端回退：无 outcome 字段的既有事件读端零破坏 + 恢复幂等保留', () => {
  const { store, S } = setup();
  makeInflightBatch(store, S, 'b-legacy', [['a', 'running']]);
  const bid = 'b-legacy';
  store.recoverBatches();
  const b1 = store.readBatch(S, bid);
  const ev1 = b1.events.find((e) => e.type === 'system.recovered');
  assert.equal(ev1.detail[0].outcome, 'crashed'); // 新批次写入 outcome

  // 模拟旧批次（detail 无 outcome 字段）：读端按既有行为处理（outcome 缺省 undefined，不抛错不迁移）
  const file = store.batchFile(S, bid);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rawEv = raw.events.find((e) => e.type === 'system.recovered');
  rawEv.detail = rawEv.detail.map((d) => ({ lane: d.lane, from: d.from, lastActiveAt: d.lastActiveAt, produced: d.produced }));
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  const b2 = store.readBatch(S, bid);
  const ev2 = b2.events.find((e) => e.type === 'system.recovered');
  assert.equal(ev2.detail[0].outcome, undefined); // 旧读端缺字段回退既有行为
  assert.equal(ev2.detail[0].lane, 'a'); // 其余字段不受影响
  // 幂等：已 idle → 二次 recover 不重复记录
  const second = store.recoverBatches();
  assert.equal(second.includes(S + '/' + bid), false);
});

test('C5-7 既有四档结算零变：merged/failed/skipped/conflict 事件载荷不含 outcome 字段、行为不变', () => {
  const { store, S } = setup();
  const bid = 'b-settle';
  const plan = buildWavePlan({ batchId: bid, tasks: [{ id: 'a' }] });
  store.createBatch(S, { batchId: bid, wavePlan: plan, phase: 'running' });
  store.setMember(S, bid, 'a', 'running');
  store.setMember(S, bid, 'a', 'review');
  store.setMember(S, bid, 'a', 'failed');
  const b = store.readBatch(S, bid);
  assert.equal(b.lanes.a, 'failed');
  const s = b.events.find((e) => e.type === 'member.settled' && e.to === 'failed');
  assert.equal(s.outcome, undefined); // 结算事件载荷形态零变（无 outcome 字段）
  assert.equal(s.lane, 'a');
  assert.equal(s.from, 'review');
});
