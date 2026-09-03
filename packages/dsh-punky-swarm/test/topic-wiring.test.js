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

// R2 topic 接线单测（设计 §3.2 + 契约 §3.2 exec-panel-a 验收②⑤ + P2-1 处置回注）
//   T1 topic 默认关：readCapability 缺省 {enabled:false}；未装配 onStateChange 的 store 零行为变化（无发布无落盘）
//   T2 发布接线：topic 运行时 start → publishStateChange → 订阅方收到 swarm.<type>.<sid>.<bid> + mailbox broadcast 落盘
//   T3 readTopic 精确过滤（命名规范点分倒置可过滤）
//   T4 未 start 零发布（不落盘不抛错）
//   T5 配置变更镜像：swarm.config.changed 仅进程内分发（无 session 归属不落 mailbox）
//   T6 store 集成：onStateChange 接线 publishStateChange → setMember/setPhase 发布（member.settled/batch.phase）
//   T7 failed-escalate：连续 3 次 failed → batch.phase 事件一并发布
//   T8 启停幂等（重复 start/stop 无异常）——契约验收⑤
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import { readCapability } from '../lib/assembly/schema.js';
import { createTopicRuntime } from '../lib/comms/topic-runtime.js';
import { subscribeTopic, emitTopic } from '../lib/comms/topic.js';
import { readUnacked } from '../lib/comms/mailbox.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-topicw-'));
const S = 'sess-t';
const B = 'b1';

function makeBatch(store, batchId, laneIds) {
  const wavePlan = { team: 'generic', wavePlan: [{ wave: 1, tasks: laneIds.map((id) => ({ id, cmd: 'x' })) }] };
  store.createBatch(S, { batchId, wavePlan, phase: 'running' });
  return batchId;
}

function mailboxRootOf(sessionId, batchId) {
  return path.join(root, 'sessions', sessionId, 'mailbox', batchId);
}

test('T1 topic 默认关：readCapability 缺省 {enabled:false}；无 onStateChange 装配 → 零行为变化', () => {
  assert.equal(readCapability({}, 'topic').enabled, false);
  assert.equal(readCapability({ capabilities: { topic: {} } }, 'topic').enabled, false);
  assert.equal(readCapability({ capabilities: { topic: { enabled: true } } }, 'topic').enabled, true);
  // 未装配钩子的 store：迁移照常、无发布异常
  const store = createStore(root);
  const bid = makeBatch(store, 't1', ['x']);
  assert.doesNotThrow(() => {
    store.setMember(S, bid, 'x', 'running');
    store.setMember(S, bid, 'x', 'review');
    store.setMember(S, bid, 'x', 'merged');
    store.setPhase(S, bid, 'complete');
  });
  const b = store.readBatch(S, bid);
  assert.equal(b.lanes.x, 'merged');
  assert.equal(b.phase, 'complete');
});

test('T2 发布接线：start 后 publishStateChange → 订阅方收到命名 topic + mailbox broadcast 落盘', () => {
  const rt = createTopicRuntime({}, { root });
  rt.start();
  const seen = [];
  const unsub = subscribeTopic('swarm.member.settled.' + S + '.' + B, (p) => seen.push(p));
  const res = rt.publishStateChange({ type: 'member.settled', sessionId: S, batchId: B, lane: 'x', from: 'pending', to: 'running', note: null });
  assert.equal(res.delivered, 1, '进程内分发');
  assert.equal(res.sent, 1, 'root+session+batch 齐备 → mailbox 落盘');
  assert.ok(res.ackId);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'member.settled');
  assert.equal(seen[0].lane, 'x');
  assert.equal(seen[0].to, 'running');
  assert.ok(seen[0].ts, '载荷含 ts');
  // mailbox broadcast 落盘 + readUnacked 可读
  const items = readUnacked(mailboxRootOf(S, B), { type: 'broadcast' });
  assert.equal(items.length, 1);
  assert.equal(items[0].message.topic, 'swarm.member.settled.' + S + '.' + B);
  assert.deepEqual(items[0].message.payload.lane, 'x');
  unsub();
  rt.stop();
});

test('T3 readTopic 精确过滤：命名点分倒置（前缀固定）可精确过滤', () => {
  const rt = createTopicRuntime({}, { root });
  rt.start();
  // 独立批次（避免与 T2 同 box 消息累积干扰断言）
  const B3 = 'b3';
  const topicA = 'swarm.batch.phase.' + S + '.' + B3;
  const topicB = 'swarm.member.settled.' + S + '.' + B3;
  rt.publishStateChange({ type: 'batch.phase', sessionId: S, batchId: B3, from: 'planning', to: 'running' });
  rt.publishStateChange({ type: 'member.settled', sessionId: S, batchId: B3, lane: 'y', from: 'running', to: 'failed' });
  const as = rt.readTopic(root, { sessionId: S, batchId: B3, topic: topicA });
  const bs = rt.readTopic(root, { sessionId: S, batchId: B3, topic: topicB });
  assert.equal(as.length, 1);
  assert.equal(as[0].payload.type, 'batch.phase');
  assert.equal(bs.length, 1);
  assert.equal(bs[0].payload.type, 'member.settled');
  // 不同批次 topic 不匹配（session/batch 冗余内嵌可辨识）
  assert.equal(rt.readTopic(root, { sessionId: S, batchId: 'b-other', topic: topicA }).length, 0);
  rt.stop();
});

test('T4 未 start 零发布：publishStateChange 返回 not-started，不落盘不抛错', () => {
  const rt = createTopicRuntime({}, { root }); // 未 start
  const res = rt.publishStateChange({ type: 'member.settled', sessionId: S, batchId: B, lane: 'z', from: 'a', to: 'b' });
  assert.deepEqual(res, { published: false, reason: 'not-started' });
  // 缺字段 → invalid-event
  rt.start();
  const res2 = rt.publishStateChange({ type: 'member.settled' });
  assert.equal(res2.reason, 'invalid-event');
  rt.stop();
});

test('T5 配置变更镜像：swarm.config.changed 仅进程内分发（无 session 归属不落 mailbox）', () => {
  const rt = createTopicRuntime({}, { root });
  rt.start();
  const seen = [];
  const unsub = subscribeTopic('swarm.config.changed', (p) => seen.push(p));
  const before = fs.existsSync(mailboxRootOf(S, B)) ? fs.readdirSync(path.join(mailboxRootOf(S, B), 'broadcast')).filter((f) => !f.startsWith('.')).length : 0;
  const res = rt.publishConfigChanged({ key: 'capabilities', value: { topic: { enabled: true } }, config: {} });
  assert.equal(res.delivered, 1);
  assert.equal(res.sent, 0, '无 sessionId/batchId → 不落 mailbox');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].key, 'capabilities');
  const after = fs.existsSync(mailboxRootOf(S, B)) ? fs.readdirSync(path.join(mailboxRootOf(S, B), 'broadcast')).filter((f) => !f.startsWith('.')).length : 0;
  assert.equal(after, before, '镜像不落盘');
  unsub();
  rt.stop();
});

test('T6 store 集成：onStateChange 接线 publishStateChange → setMember/setPhase 发布', () => {
  const rt = createTopicRuntime({}, { root });
  rt.start();
  const store = createStore(root, { onStateChange: (ev) => rt.publishStateChange(ev) });
  const bid = 't6';
  const wavePlan = { team: 'generic', wavePlan: [{ wave: 1, tasks: [{ id: 'x', cmd: 'x' }] }] };
  store.createBatch(S, { batchId: bid, wavePlan }); // phase 缺省 planning
  const settled = [];
  const phases = [];
  const us = subscribeTopic('swarm.member.settled.' + S + '.' + bid, (p) => settled.push(p));
  const up = subscribeTopic('swarm.batch.phase.' + S + '.' + bid, (p) => phases.push(p));
  // setPhase running（planning→running）
  store.setPhase(S, bid, 'running');
  assert.equal(phases.length, 1, 'batch.phase 发布');
  assert.equal(phases[0].from, 'planning');
  assert.equal(phases[0].to, 'running');
  // setMember 迁移（pending→running→review→merged）：每次结算发布 member.settled
  store.setMember(S, bid, 'x', 'running');
  store.setMember(S, bid, 'x', 'review');
  store.setMember(S, bid, 'x', 'merged');
  assert.equal(settled.length, 3, '三次迁移发布三次');
  assert.equal(settled[0].to, 'running');
  assert.equal(settled[2].to, 'merged');
  assert.equal(settled[2].lane, 'x');
  us(); up();
  rt.stop();
});

test('T7 failed-escalate：连续 3 次 failed → batch.phase（running→paused）一并发布', () => {
  const rt = createTopicRuntime({}, { root });
  rt.start();
  const store = createStore(root, { onStateChange: (ev) => rt.publishStateChange(ev) });
  const bid = makeBatch(store, 't7', ['a', 'b', 'c']);
  const phases = [];
  const up = subscribeTopic('swarm.batch.phase.' + S + '.' + bid, (p) => phases.push(p));
  // 三个 lane 依次 failed → 第 3 次触发 failed-escalate（running→paused）
  for (const l of ['a', 'b', 'c']) store.setMember(S, bid, l, 'failed');
  const b = store.readBatch(S, bid);
  assert.equal(b.phase, 'paused', 'failed-escalate 生效');
  const esc = phases.filter((p) => p.to === 'paused');
  assert.equal(esc.length, 1, 'batch.phase running→paused 发布');
  assert.equal(esc[0].reason, 'failed-escalate');
  up();
  rt.stop();
});

test('T8 启停幂等：重复 start/stop 无异常（契约验收⑤）', () => {
  const rt = createTopicRuntime({}, { root });
  assert.doesNotThrow(() => { rt.start(); rt.start(); });
  assert.doesNotThrow(() => { rt.stop(); rt.stop(); });
  // 停后再起可继续发布
  rt.start();
  const res = rt.publishStateChange({ type: 'member.settled', sessionId: S, batchId: B, lane: 'w', from: 'a', to: 'b' });
  assert.equal(res.published !== false, true);
  rt.stop();
});

test('T9 topicOf 命名规范：swarm.<type>.<sid>.<bid>（点分倒置，前缀固定）', () => {
  const rt = createTopicRuntime({}, { root });
  assert.equal(rt.topicOf('member.settled', 's1', 'b1'), 'swarm.member.settled.s1.b1');
  assert.equal(rt.topicOf('batch.phase', 's2', 'b2'), 'swarm.batch.phase.s2.b2');
  // 与底层 emitTopic 互通：runtime 复用的即 topic.js 的订阅面
  const seen = [];
  const unsub = subscribeTopic('swarm.batch.phase.s2.b2', (p) => seen.push(p));
  emitTopic('swarm.batch.phase.s2.b2', { x: 1 });
  assert.deepEqual(seen, [{ x: 1 }]);
  unsub();
});
