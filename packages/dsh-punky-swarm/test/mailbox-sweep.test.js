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

// mailbox 滞留清理（v2-node-robustness ④，P1）—— T-TEST-4
// 覆盖：INV-6a/6b、INV-7a/7b/7c/7d/7e/7f、sweep 幂等可重入、多 box 遍历集成
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { send, readUnacked, ack, isAcked, boxDir, sweep, quarantineDir } from '../lib/comms/mailbox.js';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-sweep-'));
  return root;
}

const TTL = 1000; // 注入短 TTL（ms）
const QTTL = 2000; // quarantine TTL 注入
const NOW = Date.now();

test('INV-6a：ack 后原消息文件被删除（默认）；pruneOnAck:false 时保留', () => {
  const root = setup();
  const box = { type: 'inbox' };
  const s1 = send(root, box, { m: 1 });
  ack(root, box, s1.ackId);
  const msgFile = path.join(boxDir(root, box), s1.ackId);
  assert.equal(fs.existsSync(msgFile), false, 'ack 默认即删原消息文件');
  // pruneOnAck:false 保留
  const s2 = send(root, box, { m: 2 });
  ack(root, box, s2.ackId, { pruneOnAck: false });
  assert.equal(fs.existsSync(path.join(boxDir(root, box), s2.ackId)), true, 'pruneOnAck:false 保留消息');
});

test('INV-6b：ack 后 readUnacked 仍不返回该消息（.acked 标记语义保持）；isAcked 返回 true', () => {
  const root = setup();
  const box = { type: 'inbox' };
  const s = send(root, box, { m: 'x' });
  assert.equal(readUnacked(root, box).length, 1);
  ack(root, box, s.ackId);
  assert.equal(readUnacked(root, box).length, 0, 'ack 后 readUnacked 跳过');
  assert.equal(isAcked(root, box, s.ackId), true);
});

test('INV-7a：sweep 清理 acked 超 TTL 的消息+标记', () => {
  const root = setup();
  const box = { type: 'inbox' };
  // 用 pruneOnAck:false 保留消息，专测 sweep 分支
  const s2 = send(root, box, { m: 'old2' });
  ack(root, box, s2.ackId, { pruneOnAck: false });
  const msgFile = path.join(boxDir(root, box), s2.ackId);
  const ackFile = path.join(boxDir(root, box), '.acks', s2.ackId + '.acked');
  assert.equal(fs.existsSync(msgFile), true, 'pruneOnAck:false 消息保留（sweep 前置）');
  const stats = sweep(root, { ttlMs: 0, now: NOW + 5000 }); // ttlMs=0 → 全部超期
  assert.ok(stats.removed >= 1, 'removed 计数含消息：' + JSON.stringify(stats));
  assert.equal(fs.existsSync(msgFile), false, '超 TTL 消息被删');
  assert.equal(fs.existsSync(ackFile), false, '超 TTL .acked 标记被删');
});

test('INV-7b：未 ack 未超期消息保留（sweep 后仍在）', () => {
  const root = setup();
  const box = { type: 'inbox' };
  const s = send(root, box, { m: 'fresh' });
  const stats = sweep(root, { ttlMs: 3600_000, now: NOW });
  assert.equal(stats.removed, 0);
  assert.equal(readUnacked(root, box).length, 1, '未 ack 未超期保留');
  assert.equal(fs.existsSync(path.join(boxDir(root, box), s.ackId)), true);
});

test('INV-7c：损坏消息（写非法 JSON）→ 移 .quarantine/，原目录不再读它', () => {
  const root = setup();
  const box = { type: 'inbox' };
  const dir = boxDir(root, box);
  fs.mkdirSync(dir, { recursive: true });
  const badId = 'bad-msg.json';
  fs.writeFileSync(path.join(dir, badId), '{ broken !!');
  const stats = sweep(root, { ttlMs: 3600_000, now: NOW });
  assert.equal(stats.quarantined, 1, '损坏消息入 quarantine');
  assert.equal(fs.existsSync(path.join(dir, badId)), false, '原目录不再读');
  assert.equal(fs.existsSync(path.join(quarantineDir(dir), badId)), true, 'quarantine 保留现场');
  assert.equal(readUnacked(root, box).length, 0, '损坏消息不被读出');
});

test('INV-7d：孤儿 .acked（无对应消息）按 TTL 清理', () => {
  const root = setup();
  const box = { type: 'inbox' };
  const dir = boxDir(root, box);
  const acks = path.join(dir, '.acks');
  fs.mkdirSync(acks, { recursive: true });
  fs.writeFileSync(path.join(acks, 'orphan.json.acked'), JSON.stringify({ ackedAt: new Date(NOW - 10_000).toISOString() }));
  const s = sweep(root, { ttlMs: 0, now: NOW });
  assert.ok(s.removed >= 1, '孤儿 .acked 按 TTL 删：' + JSON.stringify(s));
  assert.equal(fs.existsSync(path.join(acks, 'orphan.json.acked')), false);
});

test('INV-7e：quarantine 内文件按 quarantineTtlMs 清理', () => {
  const root = setup();
  const box = { type: 'inbox' };
  const dir = boxDir(root, box);
  const q = quarantineDir(dir);
  fs.mkdirSync(q, { recursive: true });
  const oldQ = path.join(q, 'old.json');
  fs.writeFileSync(oldQ, 'x');
  // 把 mtime 改旧
  const old = new Date(NOW - 100_000);
  fs.utimesSync(oldQ, old, old);
  const freshQ = path.join(q, 'fresh.json');
  fs.writeFileSync(freshQ, 'y');
  const stats = sweep(root, { ttlMs: 3600_000, quarantineTtlMs: 10_000, now: NOW });
  assert.ok(stats.removed >= 1, 'quarantine 超 TTL 清理：' + JSON.stringify(stats));
  assert.equal(fs.existsSync(oldQ), false, '超期 quarantine 文件被删');
  assert.equal(fs.existsSync(freshQ), true, '未超期 quarantine 保留');
});

test('INV-7f：sweep 幂等可重入（连跑两次结果一致）', () => {
  const root = setup();
  const box = { type: 'inbox' };
  send(root, box, { m: 1 });
  send(root, box, { m: 2 });
  const r1 = sweep(root, { ttlMs: 3600_000, now: NOW });
  const r2 = sweep(root, { ttlMs: 3600_000, now: NOW });
  assert.deepEqual(r2, r1, '两次 sweep 结果一致（幂等）');
});

test('INV-7f-2：单文件删除失败（注入失败）→ failed 计数、不中断其余清理', () => {
  const root = setup();
  const box = { type: 'inbox' };
  const dir = boxDir(root, box);
  fs.mkdirSync(dir, { recursive: true });
  // 注入：一个无法删除的"孤儿 .acked"（非空目录冒充 .acked 标记 → unlink 必失败）
  const acks = path.join(dir, '.acks');
  fs.mkdirSync(acks, { recursive: true });
  const stuckDir = path.join(acks, 'stuck.json.acked');
  fs.mkdirSync(stuckDir);
  fs.writeFileSync(path.join(stuckDir, 'payload'), 'x'); // 非空目录 → unlinkSync 抛 ENOTEMPTY/EPERM
  // 一个正常可清理的孤儿 .acked
  fs.writeFileSync(path.join(acks, 'normal.json.acked'), JSON.stringify({ ackedAt: new Date(NOW - 10_000).toISOString() }));
  // 一个未 ack 消息（保留）
  send(root, box, { m: 'keep' });
  const stats = sweep(root, { ttlMs: 0, now: NOW + 5000 });
  assert.ok(stats.failed >= 1, '失败计数（非空目录冒充 .acked 注入）：' + JSON.stringify(stats));
  assert.equal(fs.existsSync(path.join(acks, 'normal.json.acked')), false, '正常孤儿 .acked 仍被清理（不中断）');
  assert.equal(readUnacked(root, box).length, 1, '未 ack 消息保留');
});

test('集成：sweep 遍历全部 box 目录（inbox/broadcast/outbox）', () => {
  const root = setup();
  send(root, { type: 'inbox' }, { i: 1 });
  send(root, { type: 'broadcast' }, { b: 1 });
  send(root, { type: 'outbox', lane: 'lane-x' }, { o: 1 });
  const stats = sweep(root, { ttlMs: 3600_000, now: NOW });
  assert.equal(stats.scanned, 3, 'scanned=3（三个 box 各一消息）：' + JSON.stringify(stats));
  assert.equal(stats.failed, 0);
  // 全保留（未 ack 未超期）
  assert.equal(readUnacked(root, { type: 'inbox' }).length, 1);
  assert.equal(readUnacked(root, { type: 'broadcast' }).length, 1);
  assert.equal(readUnacked(root, { type: 'outbox', lane: 'lane-x' }).length, 1);
});

test('集成：sweep 空 root / 无 box 目录 → 零计数不 throw', () => {
  const root = setup();
  const stats = sweep(root, { ttlMs: 1000, now: NOW });
  assert.deepEqual(stats, { scanned: 0, removed: 0, quarantined: 0, failed: 0 });
  const root2 = path.join(root, 'nonexistent');
  const stats2 = sweep(root2, { ttlMs: 1000, now: NOW });
  assert.deepEqual(stats2, { scanned: 0, removed: 0, quarantined: 0, failed: 0 });
});
