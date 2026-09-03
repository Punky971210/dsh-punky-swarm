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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { subscribeTopic, emitTopic, readTopic, subscribeTopicPrefix } from '../lib/comms/topic.js';
import { readUnacked, ack } from '../lib/comms/mailbox.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-topic-'));
const ctx = { root, sessionId: 's1', batchId: 'b1' };

test('T1.1 订阅/分发：handler 收到 payload；未订阅 topic 不收到', () => {
  const seen = [];
  const unsub = subscribeTopic('lane.stalled', (p) => seen.push(p));
  emitTopic('lane.stalled', { lane: 'l1' });
  emitTopic('other.topic', { lane: 'l2' });
  assert.deepEqual(seen, [{ lane: 'l1' }]);
  unsub();
});

test('T1.2 退订/幂等：退订后不再收到；重复退订 no-op；同 handler 重复订阅不重复触发', () => {
  const seen = [];
  const handler = (p) => seen.push(p);
  const unsub1 = subscribeTopic('t12.a', handler);
  const unsub2 = subscribeTopic('t12.a', handler); // 幂等注册
  emitTopic('t12.a', 1);
  assert.deepEqual(seen, [1], '同 handler 只触发一次');
  unsub1();
  unsub2(); // 重复退订 no-op
  unsub1(); // 再退 no-op
  emitTopic('t12.a', 2);
  assert.deepEqual(seen, [1], '退订后不再收到');
});

test('T1.3 异常隔离：handler 抛错不向上传播，其余 handler 照常收到', () => {
  const seen = [];
  const unsub = subscribeTopic('t13.a', () => { throw new Error('boom'); });
  const unsub2 = subscribeTopic('t13.a', (p) => seen.push(p));
  assert.doesNotThrow(() => emitTopic('t13.a', 'ok'));
  assert.deepEqual(seen, ['ok']);
  unsub();
  unsub2();
});

test('T1.4 广播落盘：broadcast box 消息文件字段齐备 + ackId 返回 + ack 后不再返回', () => {
  const res = emitTopic('t14.a', { n: 1 }, ctx);
  assert.equal(res.sent, 1);
  assert.ok(res.ackId, 'ackId 返回');
  const bdir = path.join(root, 'sessions', 's1', 'mailbox', 'b1', 'broadcast');
  const files = fs.readdirSync(bdir).filter((f) => !f.startsWith('.'));
  assert.equal(files.length, 1);
  const data = JSON.parse(fs.readFileSync(path.join(bdir, files[0]), 'utf8'));
  assert.equal(data.message.topic, 't14.a');
  assert.deepEqual(data.message.payload, { n: 1 });
  assert.ok(data.message.ts, 'ts 字段齐备');
  assert.equal(data.ackId, res.ackId);
  // 原子写语义：ack 后 readUnacked 不再返回
  assert.equal(readUnacked(boxRootOf(), { type: 'broadcast' }).length, 1);
  ack(boxRootOf(), { type: 'broadcast' }, res.ackId);
  assert.equal(readUnacked(boxRootOf(), { type: 'broadcast' }).length, 0);

  function boxRootOf() { return path.join(root, 'sessions', 's1', 'mailbox', 'b1'); }
});

test('T1.5 topic 过滤读：readTopic 仅匹配 topic；sinceTs 过滤；无消息 → []', async () => {
  emitTopic('alpha', { n: 1 }, ctx);
  await new Promise((r) => setTimeout(r, 20));
  emitTopic('beta', { n: 2 }, ctx);
  const as = readTopic(root, { sessionId: 's1', batchId: 'b1', topic: 'alpha' });
  assert.equal(as.length, 1);
  assert.equal(as[0].payload.n, 1);
  const bs = readTopic(root, { sessionId: 's1', batchId: 'b1', topic: 'beta' });
  assert.equal(bs.length, 1);
  // sinceTs 过滤：以 beta 的 ts 为界，alpha（更早）被滤掉
  const since = Date.parse(bs[0].ts);
  const filtered = readTopic(root, { sessionId: 's1', batchId: 'b1', topic: 'alpha', sinceTs: since });
  assert.deepEqual(filtered, []);
  // 无匹配 topic → []
  assert.deepEqual(readTopic(root, { sessionId: 's1', batchId: 'b1', topic: 'nope' }), []);
});

test('T1.6 零破坏：缺省无 ctx 仅进程内分发、不落盘、不抛错；非法 topic fail-closed', () => {
  const seen = [];
  const unsub = subscribeTopic('t16.a', (p) => seen.push(p));
  const bdir = path.join(root, 'sessions', 's1', 'mailbox', 'b1', 'broadcast');
  const before = fs.existsSync(bdir) ? fs.readdirSync(bdir).filter((f) => !f.startsWith('.')).length : 0;
  let res;
  assert.doesNotThrow(() => { res = emitTopic('t16.a', 'inline'); });
  assert.deepEqual(seen, ['inline']);
  assert.equal(res.sent, 0, '无 ctx 不落盘');
  assert.equal(res.ackId, null);
  assert.equal(res.delivered, 1);
  const after = fs.existsSync(bdir) ? fs.readdirSync(bdir).filter((f) => !f.startsWith('.')).length : 0;
  assert.equal(after, before, '缺省 emit 未新增消息文件');
  unsub();
  // fail-closed
  assert.throws(() => subscribeTopic('', () => {}));
  assert.throws(() => subscribeTopic(42, () => {}));
  assert.throws(() => emitTopic('', 'x'));
});

test('T1.7 前缀订阅（R3 SSE hub 机制）：emitTopic 按 startsWith 分发、(topic,payload) 签名、精确/前缀并存、退订幂等', () => {
  const seen = [];
  const un = subscribeTopicPrefix('swarm.', (topic, p) => seen.push([topic, p]));
  emitTopic('swarm.member.settled.s1.b1', { n: 1 });
  emitTopic('other.event.s1.b1', { n: 2 });
  assert.equal(seen.length, 1, '非前缀 topic 不触发');
  assert.equal(seen[0][0], 'swarm.member.settled.s1.b1');
  assert.deepEqual(seen[0][1], { n: 1 });
  un();
  un(); // 重复退订 no-op
  emitTopic('swarm.batch.phase.s1.b1', {});
  assert.equal(seen.length, 1, '退订后不再收到');
  // 精确订阅并存不受影响（前缀分发不改既有语义）
  const exact = [];
  const un2 = subscribeTopic('swarm.member.settled.s1.b1', (p) => exact.push(p));
  emitTopic('swarm.member.settled.s1.b1', { n: 3 });
  assert.deepEqual(exact, [{ n: 3 }]);
  un2();
  // delivered 计数含前缀分发
  const un3 = subscribeTopicPrefix('swarm.', () => {});
  const r = emitTopic('swarm.config.changed.s1.b1', {});
  assert.equal(r.delivered, 1, '前缀 handler 计入 delivered');
  un3();
  // 空前缀 fail-closed
  assert.throws(() => subscribeTopicPrefix('', () => {}));
  assert.throws(() => subscribeTopicPrefix(42, () => {}));
});
