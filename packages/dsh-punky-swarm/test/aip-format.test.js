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

// aip-format 测试：三映射字段按 ACPs AIP v2.1.0 结构对齐（spec.md §3.6，参考实现 07-ACPs-spec-AIP 原文）
// 断言点：
// 1) toAipMessage → ACPs Message 字段集（type/id/sentAt/senderRole/senderId/mentions?/dataItems?/sessionId?），
//    自推导字段（messageId/timestamp/sender/receiver/channel/contentType/content/meta）必须剔除；
// 2) toAipTask → ACPs TaskCommand 字段集（type="task-command"/id/sentAt/senderRole/senderId/command/commandParams/taskId），
//    自推导字段（dependencies/inputContract/outputContract/executor/executionModel）剔除、引擎键入 commandParams；
// 3) toAipSession → ACPs Session 字段集（id/taskResults/taskCommands/createdAt/updatedAt），
//    自推导字段（agentIds/state/taskIds/concurrency）剔除；
// 4) 接线：createApi 注入 aipFormat 后 /mailbox 与 /batch 响应附 ACPs 投影；不注入则响应不变（红线）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toAipMessage, toAipTask, toAipSession, toAipDataItems, AIP_COMMAND_TYPES } from '../lib/comms/aip-format.js';
import { createApi } from '../lib/api.js';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import * as mailbox from '../lib/comms/mailbox.js';
import * as aipFormat from '../lib/comms/aip-format.js';

// ---------- toAipMessage：ACPs Message 结构 ----------
test('toAipMessage maps mailbox inbox payload to ACPs Message (leader→worker)', () => {
  const msg = {
    ackId: 'abc-1',
    ts: '2026-08-21T10:00:00.000Z',
    box: { type: 'inbox' },
    message: { task: 't1', text: 'go' },
    meta: { sender: 'leader', sessionId: 's1' },
  };
  const out = toAipMessage(msg);
  // ACPs Message 字段集（必填：type/id/sentAt/senderRole/senderId）
  assert.equal(out.type, 'message');
  assert.equal(out.id, 'abc-1');
  assert.equal(out.sentAt, '2026-08-21T10:00:00.000Z');
  assert.equal(out.senderRole, 'leader');
  assert.equal(out.senderId, 'leader');
  assert.equal(out.sessionId, 's1');
  // 内容 → ACPs dataItems（结构化兜底）
  assert.deepEqual(out.dataItems, [{ type: 'data', data: { task: 't1', text: 'go' } }]);
  // 自推导字段剔除
  for (const k of ['messageId', 'timestamp', 'sender', 'receiver', 'channel', 'contentType', 'content', 'meta']) {
    assert.ok(!(k in out), 'ACPs Message 不得含自推导字段 ' + k);
  }
});

test('toAipMessage maps outbox payload (worker→leader, senderRole=partner)', () => {
  const out = toAipMessage({
    ackId: 'o-1',
    ts: '2026-08-21T11:00:00.000Z',
    box: { type: 'outbox', lane: 'lane-x' },
    message: 'done',
    meta: { sender: 'lane-x' },
  });
  assert.equal(out.senderRole, 'partner');
  assert.equal(out.senderId, 'lane-x');
  assert.deepEqual(out.dataItems, [{ type: 'text', text: 'done' }]);
  // outbox lane 隔离：senderId 保留 lane 标识（引擎无 AIC，占位）
  assert.equal(out.senderId, 'lane-x');
});

test('toAipMessage maps broadcast payload (mentions=all)', () => {
  const out = toAipMessage({
    ackId: 'b-1',
    ts: '2026-08-21T12:00:00.000Z',
    box: { type: 'broadcast' },
    message: { type: 'text', text: 'hi all' },
  });
  assert.equal(out.senderRole, 'leader');
  assert.equal(out.senderId, 'broadcaster');
  assert.equal(out.mentions, 'all');
  assert.deepEqual(out.dataItems, [{ type: 'text', text: 'hi all' }]);
});

test('toAipDataItems: string/text/file/data union', () => {
  assert.deepEqual(toAipDataItems('plain'), [{ type: 'text', text: 'plain' }]);
  assert.deepEqual(toAipDataItems({ type: 'text', text: 't' }), [{ type: 'text', text: 't' }]);
  assert.deepEqual(toAipDataItems({ type: 'file', name: 'a.pdf', uri: 'u' }), [{ type: 'file', name: 'a.pdf', uri: 'u' }]);
  assert.deepEqual(toAipDataItems({ type: 'data', data: { x: 1 } }), [{ type: 'data', data: { x: 1 } }]);
  assert.equal(toAipDataItems(null), undefined);
  assert.equal(toAipDataItems(undefined), undefined);
});

// ---------- toAipTask：ACPs TaskCommand 结构 ----------
test('toAipTask maps wavePlan task to ACPs TaskCommand', () => {
  const task = {
    id: 't1',
    cmd: '编写计划文档',
    deps: [],
    model: 'deepseek-v4',
    tools: ['read', 'write'],
    layer: 'plan',
    role: 'Designer',
    skills: ['dev-designer'],
    consume: ['spec.md'],
    produce: ['plan/spec.md'],
  };
  const out = toAipTask(task);
  // ACPs TaskCommand 字段集
  assert.equal(out.type, 'task-command');
  assert.equal(out.id, 't1');
  assert.equal(out.command, 'start'); // cmd 非命令枚举 → 默认 start（推导注明）
  assert.equal(out.taskId, 't1');
  assert.equal(out.senderRole, 'leader');
  // 引擎键移入 commandParams（值域开放）
  assert.equal(out.commandParams.layer, 'plan');
  assert.equal(out.commandParams.role, 'Designer');
  assert.equal(out.commandParams.cmd, '编写计划文档');
  assert.deepEqual(out.commandParams.produce, ['plan/spec.md']);
  // 自推导顶层字段剔除
  for (const k of ['dependencies', 'inputContract', 'outputContract', 'executor', 'executionModel']) {
    assert.ok(!(k in out), 'ACPs TaskCommand 不得含自推导字段 ' + k);
  }
});

test('toAipTask: cmd 命中 TaskCommandType 枚举时透传', () => {
  for (const c of AIP_COMMAND_TYPES) {
    assert.equal(toAipTask({ id: 'x', cmd: c }).command, c);
  }
  assert.equal(toAipTask({ id: 'x', cmd: 'start' }).command, 'start');
});

// ---------- toAipSession：ACPs Session 结构 ----------
test('toAipSession maps batch state to ACPs Session', () => {
  const plan = buildWavePlan({ batchId: 'b-s', tasks: [{ id: 't1', cmd: 'a' }, { id: 't2', cmd: 'b', deps: ['t1'] }] });
  const batch = {
    sessionId: 's1',
    batchId: 'b-s',
    phase: 'running',
    concurrency: 5,
    wavePlan: plan.wavePlan,
    lanes: { t1: 'running', t2: 'pending' },
    createdAt: '2026-08-21T09:00:00.000Z',
    updatedAt: '2026-08-21T09:10:00.000Z',
  };
  const out = toAipSession(batch);
  // ACPs Session 字段集（id/taskResults/taskCommands/createdAt/updatedAt）
  assert.equal(out.id, 's1');
  assert.deepEqual(out.taskResults, []); // 引擎无 TaskResult 数据 → 空数组（如实）
  assert.equal(out.taskCommands.length, 2);
  assert.equal(out.taskCommands[0].type, 'task-command');
  assert.equal(out.taskCommands[0].id, 't1');
  assert.equal(out.taskCommands[0].taskId, 't1');
  assert.equal(out.taskCommands[1].commandParams.deps[0], 't1');
  assert.equal(out.createdAt, '2026-08-21T09:00:00.000Z');
  assert.equal(out.updatedAt, '2026-08-21T09:10:00.000Z');
  // 自推导字段剔除（agentIds/state/taskIds/concurrency 非 ACPs Session 契约）
  for (const k of ['agentIds', 'state', 'taskIds', 'concurrency']) {
    assert.ok(!(k in out), 'ACPs Session 不得含自推导字段 ' + k);
  }
});

// ---------- 接线：createApi 注入 aipFormat → 只读端点附投影；不注入 → 响应不变（红线） ----------
test('api wiring: aipFormat injected → /mailbox items carry aip projection; absent → unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-api-aip-'));
  const store = createStore(root);
  const S = 'sess-wire';
  const plan = buildWavePlan({ batchId: 'b-w', tasks: [{ id: 't1', cmd: 'x' }] });
  store.createBatch(S, { batchId: 'b-w', wavePlan: plan, phase: 'running' });
  const mbRoot = path.join(root, 'sessions', S, 'mailbox', 'b-w');
  mailbox.send(mbRoot, { type: 'inbox' }, { task: 't1' });

  const mk = (deps) => {
    const routes = [];
    const ctx = { webServer: { register: (r) => { routes.push(r); return () => {}; } } };
    const api = createApi(ctx, { store, root, ...deps });
    const invoke = (route, url) => {
      let status = 0, body = null;
      const res = { writeHead(s) { status = s; }, end(b) { body = JSON.parse(b); } };
      route.handler({ url }, res);
      return { status, body };
    };
    const mailboxRoute = routes.find((x) => x.path === '/api/dsh-punky-swarm/mailbox');
    const batchRoute = routes.find((x) => x.path === '/api/dsh-punky-swarm/batch');
    return { invoke, mailboxRoute, batchRoute };
  };

  // 注入 aipFormat（真实装配路径：register.js 导出 → index.js 传入）
  const wired = mk({ aipFormat });
  const m1 = wired.invoke(wired.mailboxRoute, '/api/dsh-punky-swarm/mailbox?batchId=b-w&box=inbox&session=' + S);
  assert.equal(m1.status, 200);
  assert.equal(m1.body.items.length, 1);
  assert.ok(m1.body.items[0].aip, '注入 aipFormat 时 items 应附 aip 投影');
  assert.equal(m1.body.items[0].aip.type, 'message');
  assert.equal(m1.body.items[0].aip.senderRole, 'leader');
  assert.equal(m1.body.items[0].aip.id, m1.body.items[0].ackId);
  const b1 = wired.invoke(wired.batchRoute, '/api/dsh-punky-swarm/batch?batchId=b-w&session=' + S);
  assert.ok(b1.body.aipSession, '注入 aipFormat 时 /batch 应附 aipSession 投影');
  assert.equal(b1.body.aipSession.id, S); // ACPs Session.id ← 引擎 sessionId
  assert.equal(b1.body.aipSession.taskCommands[0].taskId, 't1');

  // 不注入（既有行为）：响应结构不变，无投影字段
  const plain = mk({});
  const m2 = plain.invoke(plain.mailboxRoute, '/api/dsh-punky-swarm/mailbox?batchId=b-w&box=inbox&session=' + S);
  assert.equal(m2.body.items.length, 1);
  assert.ok(!('aip' in m2.body.items[0]), '未注入 aipFormat 时 items 不得附 aip 投影（红线：既有响应不变）');
  const b2 = plain.invoke(plain.batchRoute, '/api/dsh-punky-swarm/batch?batchId=b-w&session=' + S);
  assert.ok(!('aipSession' in b2.body), '未注入 aipFormat 时 /batch 不得附 aipSession（红线）');
});
