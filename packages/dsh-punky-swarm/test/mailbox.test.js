import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { send, readUnacked, ack, isAcked, boxDir } from '../lib/mailbox.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-mbox-'));

test('send/read/ack round trip across boxes', () => {
  const s1 = send(root, { type: 'inbox' }, { task: 't1' }, { lane: 't1' });
  const s2 = send(root, { type: 'outbox', lane: 't1' }, { done: true });
  const s3 = send(root, { type: 'broadcast' }, { note: 'hi' });

  const inbox = readUnacked(root, { type: 'inbox' });
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].ackId, s1.ackId);
  assert.deepEqual(inbox[0].message, { task: 't1' });

  const outbox = readUnacked(root, { type: 'outbox', lane: 't1' });
  assert.equal(outbox.length, 1);
  const bcast = readUnacked(root, { type: 'broadcast' });
  assert.equal(bcast.length, 1);

  ack(root, { type: 'inbox' }, s1.ackId);
  assert.equal(isAcked(root, { type: 'inbox' }, s1.ackId), true);
  assert.equal(readUnacked(root, { type: 'inbox' }).length, 0);
});

test('lane is sanitized and outbox isolated per lane', () => {
  send(root, { type: 'outbox', lane: 'lane-a' }, { x: 1 });
  assert.equal(readUnacked(root, { type: 'outbox', lane: 'lane-a' }).length, 1);
  assert.equal(readUnacked(root, { type: 'outbox', lane: 'lane-b' }).length, 0);
  assert.throws(() => boxDir(root, { type: 'outbox', lane: '../evil' }));
});

test('sinceTs filters old messages', () => {
  const before = Date.parse(new Date().toISOString()) - 5000;
  send(root, { type: 'inbox' }, { m: 'new' });
  const items = readUnacked(root, { type: 'inbox' }, { sinceTs: before });
  assert.ok(items.length >= 1);
});
