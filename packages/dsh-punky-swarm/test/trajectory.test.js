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

// C5 诊断桥接单测（决策包 §5.3 验收 R1-R5）：
// R1 映射正确（member.dispatch 事件 + mapping 反查 + 重启重建）
// R2 notify 事件（lane.anomaly + broadcast）
// R3 auto-fail 默认关（缺省配置只 notify，不自动结算）
// R4 auto-fail 开启（loop_deadlock + confidence≥阈值 → failed；其他类型/低置信不触发）
// R5 生命周期与豁免（start/stop 无泄漏；无 ctx.on 静默降级；enabled 默认关）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import * as mailbox from '../lib/comms/mailbox.js';
import { createTrajectoryBridge, isTrajectoryEnabled } from '../lib/bridge/trajectory.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-tra-'));
const store = createStore(root);
const silentCtx = { logger: console }; // 无 .on/.off → 静默降级路径

function makeRunningBatch(sessionId, batchId, laneIds) {
  const wavePlan = { team: 'generic', wavePlan: [{ wave: 1, tasks: laneIds.map((id) => ({ id, cmd: 'x' })) }] };
  store.createBatch(sessionId, { batchId, wavePlan });
  store.setPhase(sessionId, batchId, 'running');
  for (const id of laneIds) store.setMember(sessionId, batchId, id, 'running');
  return store.readBatch(sessionId, batchId);
}

function mailboxRootOf(sessionId, batchId) {
  return path.join(root, 'sessions', sessionId, 'mailbox', batchId);
}

function eventsOf(sessionId, batchId) {
  return store.readBatch(sessionId, batchId).events;
}

test('R1 映射：recordDispatch 落 member.dispatch 事件 + mapping 反查正确', () => {
  makeRunningBatch('sess-b', 'b-r1', ['lane-a', 'lane-b']);
  const bridge = createTrajectoryBridge(silentCtx, { store, config: {} });
  bridge.recordDispatch({ sessionId: 'sess-b', batchId: 'b-r1', lane: 'lane-a', workerSessionId: 'worker-s1' });
  bridge.recordDispatch({ sessionId: 'sess-b', batchId: 'b-r1', lane: 'lane-b', workerSessionId: 'worker-s2' });

  const evs = eventsOf('sess-b', 'b-r1');
  assert.ok(evs.some((e) => e.type === 'member.dispatch' && e.lane === 'lane-a' && e.workerSessionId === 'worker-s1'), 'member.dispatch 事件记录 workerSessionId');
  assert.deepEqual(bridge.mapping()['worker-s1'], { sessionId: 'sess-b', batchId: 'b-r1', lane: 'lane-a' });
  assert.deepEqual(bridge.mapping()['worker-s2'], { sessionId: 'sess-b', batchId: 'b-r1', lane: 'lane-b' });
  assert.equal(bridge.mapping()['ghost'], undefined);

  assert.throws(() => bridge.recordDispatch({ sessionId: 'sess-b', batchId: 'b-r1', lane: 'lane-a' }), /均必填/);
});

test('R1 重启重建：新桥接实例从批次事件恢复映射（幂等）', () => {
  const bridge2 = createTrajectoryBridge(silentCtx, { store, config: {} });
  const n = bridge2.start(); // 无 ctx.on → subscribed=false，静默降级
  assert.equal(n.subscribed, false);
  assert.deepEqual(bridge2.mapping()['worker-s1'], { sessionId: 'sess-b', batchId: 'b-r1', lane: 'lane-a' });
  assert.deepEqual(bridge2.mapping()['worker-s2'], { sessionId: 'sess-b', batchId: 'b-r1', lane: 'lane-b' });
});

test('R2+R3 notify：异常 → lane.anomaly 事件 + broadcast 消息；缺省配置不自动结算', () => {
  const bridge = createTrajectoryBridge(silentCtx, { store, config: {}, mailbox });
  bridge.start(); // 从 R1 已持久化的 member.dispatch 事件重建映射（幂等）
  const r = bridge.handleAnomaly({
    anomalyId: 'a-1', sessionId: 'worker-s1', type: 'loop_deadlock',
    confidence: 0.95, severity: 'critical', message: 'loop detected on lane-a',
  });
  assert.equal(r.routed, true);
  assert.equal(r.batchId, 'b-r1');
  assert.equal(r.lane, 'lane-a');
  assert.equal(r.autoFailed, false); // R3：缺省配置只 notify

  const evs = eventsOf('sess-b', 'b-r1');
  const anom = evs.filter((e) => e.type === 'lane.anomaly');
  assert.equal(anom.length, 1);
  assert.equal(anom[0].lane, 'lane-a');
  assert.equal(anom[0].alert.anomalyId, 'a-1');
  assert.equal(anom[0].alert.type, 'loop_deadlock');
  assert.equal(anom[0].alert.confidence, 0.95);

  const bcast = mailbox.readUnacked(mailboxRootOf('sess-b', 'b-r1'), { type: 'broadcast' });
  assert.equal(bcast.length, 1);
  assert.equal(bcast[0].message.kind, 'anomaly');
  assert.equal(bcast[0].message.anomalyId, 'a-1');
  assert.equal(bcast[0].message.batchId, 'b-r1');
  assert.equal(bcast[0].message.lane, 'lane-a');

  // R3：成员状态不变（member_settle 未被自动调用）
  assert.equal(store.readBatch('sess-b', 'b-r1').lanes['lane-a'], 'running');
});

test('R3 未映射/无 sessionId → 静默降级不路由', () => {
  const bridge = createTrajectoryBridge(silentCtx, { store, config: {}, mailbox });
  const before = eventsOf('sess-b', 'b-r1').length;
  assert.deepEqual(bridge.handleAnomaly({ anomalyId: 'a-x', sessionId: 'ghost', type: 'loop_deadlock', confidence: 0.9 }), { routed: false, reason: 'unmapped' });
  assert.deepEqual(bridge.handleAnomaly({ anomalyId: 'a-y', type: 'loop_deadlock', confidence: 0.9 }), { routed: false, reason: 'no-session' });
  assert.equal(eventsOf('sess-b', 'b-r1').length, before, '未映射异常不写事件');
});

test('R4 auto-fail 开启：loop_deadlock + confidence≥阈值 → failed；其他类型/低置信不触发', () => {
  makeRunningBatch('sess-b', 'b-r4', ['lane-c', 'lane-d', 'lane-e']);
  const cfg = { capabilities: { trajectory: { enabled: true, autoFail: true, failConfidence: 0.85 } } };
  const bridge = createTrajectoryBridge(silentCtx, { store, config: cfg, mailbox });
  bridge.recordDispatch({ sessionId: 'sess-b', batchId: 'b-r4', lane: 'lane-c', workerSessionId: 'w-c' });
  bridge.recordDispatch({ sessionId: 'sess-b', batchId: 'b-r4', lane: 'lane-d', workerSessionId: 'w-d' });
  bridge.recordDispatch({ sessionId: 'sess-b', batchId: 'b-r4', lane: 'lane-e', workerSessionId: 'w-e' });

  // loop_deadlock + 高置信 → failed（note 含 anomalyId）
  const r1 = bridge.handleAnomaly({ anomalyId: 'a-2', sessionId: 'w-c', type: 'loop_deadlock', confidence: 0.9, message: 'stuck' });
  assert.equal(r1.autoFailed, true);
  const b4 = store.readBatch('sess-b', 'b-r4');
  assert.equal(b4.lanes['lane-c'], 'failed');
  const settle = b4.events.filter((e) => e.type === 'member.settled' && e.to === 'failed');
  assert.ok(settle.some((e) => e.note && e.note.includes('a-2')), 'failed note 含 anomalyId');

  // 低置信 → 不触发（仍 notify）
  const r2 = bridge.handleAnomaly({ anomalyId: 'a-3', sessionId: 'w-d', type: 'loop_deadlock', confidence: 0.5 });
  assert.equal(r2.autoFailed, false);
  assert.equal(store.readBatch('sess-b', 'b-r4').lanes['lane-d'], 'running');

  // 非 loop_deadlock 类型 → 不触发（即使高置信）
  const r3 = bridge.handleAnomaly({ anomalyId: 'a-4', sessionId: 'w-e', type: 'goal_drift', confidence: 0.99 });
  assert.equal(r3.autoFailed, false);
  assert.equal(store.readBatch('sess-b', 'b-r4').lanes['lane-e'], 'running');

  // 已终态 lane（lane-c 已 failed）再收异常 → 不抛错，notify 证据照常留
  const r4 = bridge.handleAnomaly({ anomalyId: 'a-5', sessionId: 'w-c', type: 'invalid_retry', confidence: 0.9 });
  assert.equal(r4.routed, true);
  assert.equal(r4.autoFailed, false);
});

test('R5 生命周期：ctx.on 订阅 → handler 生效；stop() 退订无泄漏', () => {
  const registered = {};
  const ctxBus = {
    logger: console,
    on: (ev, fn) => { registered[ev] = fn; return () => { delete registered[ev]; }; },
    off: (ev) => { delete registered[ev]; },
  };
  const bridge = createTrajectoryBridge(ctxBus, { store, config: {}, mailbox });
  bridge.recordDispatch({ sessionId: 'sess-b', batchId: 'b-r1', lane: 'lane-a', workerSessionId: 'w-bus' });
  const st = bridge.start();
  assert.equal(st.subscribed, true);
  assert.equal(typeof registered['trajectory/anomaly'], 'function', '事件订阅已挂');

  // 经事件总线投递异常 → notify 生效（R2 订阅路径）
  const before = eventsOf('sess-b', 'b-r1').filter((e) => e.type === 'lane.anomaly').length;
  registered['trajectory/anomaly']({ anomalyId: 'a-bus', sessionId: 'w-bus', type: 'loop_deadlock', confidence: 0.8 });
  const after = eventsOf('sess-b', 'b-r1').filter((e) => e.type === 'lane.anomaly').length;
  assert.equal(after, before + 1);

  bridge.stop();
  assert.equal(registered['trajectory/anomaly'], undefined, '退订后无残留监听');
  bridge.stop(); // 幂等
});

test('R5 装配开关：isTrajectoryEnabled 缺省默认开（P1-01；显式 enabled:false 不挂载）', () => {
  // P1-01 行为变更：缺省 = readCapability 合并 TRAJECTORY_DEFAULTS {enabled:true}（旧「默认关」为旧行为断言）
  assert.equal(isTrajectoryEnabled({}), true);
  assert.equal(isTrajectoryEnabled({ capabilities: {} }), true);
  assert.equal(isTrajectoryEnabled({ capabilities: { trajectory: {} } }), true);
  assert.equal(isTrajectoryEnabled({ capabilities: { trajectory: { enabled: false } } }), false);
  assert.equal(isTrajectoryEnabled({ capabilities: { trajectory: { enabled: true } } }), true);
});
