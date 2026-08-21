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
import { createApi } from '../lib/api.js';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import * as mailbox from '../lib/comms/mailbox.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-api-'));
const store = createStore(root);
const S = 'sess-api';
const plan = buildWavePlan({ batchId: 'b-api', tasks: [{ id: 't1', cmd: '编写计划文档' }] });
store.createBatch(S, { batchId: 'b-api', wavePlan: plan, phase: 'running' });
store.setMember(S, 'b-api', 't1', 'running');
store.setMember(S, 'b-api', 't1', 'review');
store.setMember(S, 'b-api', 't1', 'merged');
mailbox.send(path.join(root, 'sessions', S, 'mailbox', 'b-api'), { type: 'inbox' }, { task: 't1' });
// 另一 session 的同名批次（隔离验证）
const p2 = buildWavePlan({ batchId: 'b-api', tasks: [{ id: 't1' }] });
store.createBatch('sess-other', { batchId: 'b-api', wavePlan: p2, phase: 'running' });

const routes = [];
const ctx = { webServer: { register: (r) => { routes.push(r); return () => {}; } } };
const api = createApi(ctx, { store, root });

function invoke(route, url) {
  let status = 0, body = null;
  const res = { writeHead(s, h) { status = s; }, end(b) { body = JSON.parse(b); } };
  route.handler({ url }, res);
  return { status, body };
}

test('registers 6 routes (prefix + 5 exact)', () => {
  assert.equal(routes.length, 6);
});

test('GET /batches requires session', () => {
  const r = invoke(routes.find((x) => x.path === '/api/dsh-punky-swarm/batches'), '/api/dsh-punky-swarm/batches');
  assert.equal(r.status, 400);
});

test('GET /batches?session= lists only that session', () => {
  const r = invoke(routes.find((x) => x.path === '/api/dsh-punky-swarm/batches'), '/api/dsh-punky-swarm/batches?session=' + S);
  assert.equal(r.status, 200);
  assert.equal(r.body.batches.length, 1);
  assert.equal(r.body.batches[0].phase, 'running');
  // 另一 session 看不到
  const r2 = invoke(routes.find((x) => x.path === '/api/dsh-punky-swarm/batches'), '/api/dsh-punky-swarm/batches?session=sess-other');
  assert.equal(r2.body.batches[0].phase, 'running');
  const r3 = invoke(routes.find((x) => x.path === '/api/dsh-punky-swarm/batches'), '/api/dsh-punky-swarm/batches?session=sess-empty');
  assert.equal(r3.body.batches.length, 0);
});

test('GET /sessions lists sessions with counts', () => {
  const r = invoke(routes.find((x) => x.path === '/api/dsh-punky-swarm/sessions'), '/api/dsh-punky-swarm/sessions');
  assert.equal(r.status, 200);
  const found = r.body.sessions.find((s) => s.sessionId === S);
  assert.ok(found && found.batchCount === 1);
});

test('GET /batch?batchId= returns detail (session-scoped)', () => {
  const r = invoke(routes.find((x) => x.path === '/api/dsh-punky-swarm/batch'), '/api/dsh-punky-swarm/batch?batchId=b-api&session=' + S);
  assert.equal(r.status, 200);
  assert.equal(r.body.lanes.t1, 'merged');
  assert.equal(r.body.autoReleaseable, true);
  // 任务简述（cmd）随 wavePlan 暴露——面板据此展示任务内容
  assert.equal(r.body.wavePlan[0].tasks[0].id, 't1');
  assert.equal(r.body.wavePlan[0].tasks[0].cmd, '编写计划文档');
  assert.deepEqual(r.body.laneAttempts, {});
  const nf = invoke(routes.find((x) => x.path === '/api/dsh-punky-swarm/batch'), '/api/dsh-punky-swarm/batch?batchId=nope&session=' + S);
  assert.equal(nf.status, 404);
  // 跨 session 不可见
  const cross = invoke(routes.find((x) => x.path === '/api/dsh-punky-swarm/batch'), '/api/dsh-punky-swarm/batch?batchId=b-api&session=sess-other');
  assert.equal(cross.status, 200);
  assert.equal(cross.body.lanes.t1, 'pending');
});

test('GET /mailbox returns unacked (session-scoped)', () => {
  const r = invoke(routes.find((x) => x.path === '/api/dsh-punky-swarm/mailbox'), '/api/dsh-punky-swarm/mailbox?batchId=b-api&box=inbox&session=' + S);
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 1);
  const r2 = invoke(routes.find((x) => x.path === '/api/dsh-punky-swarm/mailbox'), '/api/dsh-punky-swarm/mailbox?batchId=b-api&box=inbox&session=sess-other');
  assert.equal(r2.body.items.length, 0);
});

test('GET /locks requires session and returns lock list', () => {
  const r = invoke(routes.find((x) => x.path === '/api/dsh-punky-swarm/locks'), '/api/dsh-punky-swarm/locks?session=' + S);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.locks));
  const no = invoke(routes.find((x) => x.path === '/api/dsh-punky-swarm/locks'), '/api/dsh-punky-swarm/locks');
  assert.equal(no.status, 400);
});

test('prefix fallback returns 404 json', () => {
  const r = invoke(routes[0], '/api/dsh-punky-swarm/unknown');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'not-found');
});

api.dispose();


test('GET /batch returns lanesGate（generic 无 layer；三层列出缺失）', () => {
  // generic 批次
  const r1 = invoke(routes.find((x) => x.path === '/api/dsh-punky-swarm/batch'), '/api/dsh-punky-swarm/batch?batchId=b-api&session=' + S);
  assert.equal(r1.status, 200);
  assert.ok(r1.body.lanesGate && r1.body.lanesGate.t1);
  assert.equal(r1.body.lanesGate.t1.layer, null);
  // 三层批次：consume 缺失可见
  const p3 = buildWavePlan({
    batchId: 'b-g3', team: 'jiufeng',
    tasks: [
      { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 's' },
      { id: 'e1', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e1/a.py'], cmd: 'c', deps: ['p1'] },
      { id: 'a1', layer: 'audit', produce: ['audit/review.md'], cmd: 'r', deps: ['e1'] },
    ],
  });
  store.createBatch(S, { batchId: 'b-g3', wavePlan: p3 });
  const r2 = invoke(routes.find((x) => x.path === '/api/dsh-punky-swarm/batch'), '/api/dsh-punky-swarm/batch?batchId=b-g3&session=' + S);
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.body.lanesGate.e1.consumeMissing, ['plan/spec.md']);
  assert.deepEqual(r2.body.lanesGate.e1.outputsMissing, ['exec/e1/a.py']);
  assert.deepEqual(r2.body.lanesGate.a1.produceMissing, ['audit/review.md']);
  assert.equal(r2.body.lanesGate.p1.contractProblems.length, 1); // spec.md 缺失 → plan 契约问题
});

