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

// M1 闭合装配级单测（panel-verify §3 修复指引 5）：topic 触发源接线——
//   hub.attachTopic('swarm.') 装配调用点语义验证（index.js 装配序列等价复刻）：
//   A1 装配级链路：topic.enabled=true 装配模式（hub 创建 + attachTopic + topicRuntime + store onStateChange）
//      → store.setMember 状态事件 → hub 收到 SSE 推送帧（触发源①低延迟通道激活）
//   A2 enabled=false 零接线：hub 装配但未 attachTopic → 状态事件零推送（fs.watch 单通道形态不变）
//   A3 退订对称：attachTopic 返回 un，un() 后状态事件不再推送（topicUnsubs 清理）
//   A4 handler 透传：attachTopic(prefix, handler) 自定义 handler 收 (topic, payload)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import { createStreamHub } from '../lib/panel/stream.js';
import { createTopicRuntime } from '../lib/comms/topic-runtime.js';
import { emitTopic } from '../lib/comms/topic.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-attach-'));
const S = 'sess-a';
const B = 'b1';

// 伪 SSE res：捕获 write 帧（writeRes 需要 write 返回 true）
function fakeRes() {
  const frames = [];
  const res = {
    frames,
    destroyed: false,
    writableEnded: false,
    writeHead() {},
    flushHeaders() {},
    write(chunk) { frames.push(String(chunk)); return true; },
    end() {},
    on() {},
  };
  return res;
}

// 模拟 index.js M1 装配序列（topic.enabled=true 形态）：
//   hub = createStreamHub(...)（装配层创建，index.js 注入 deps.panelStream）
//   rt = createTopicRuntime(...); rt.start(); topicSink.emit = rt.publishStateChange
//   store = createStore(root, { onStateChange: topicSink.emit })
//   attach=true → hub.attachTopic('swarm.')（index.js 守卫：!topicAttachUn 才接线）
function assemble({ attach = true } = {}) {
  const hub = createStreamHub({ root, logger: null });
  const rt = createTopicRuntime({}, { root });
  const sink = { emit: null };
  const store = createStore(root, {
    onStateChange: (ev) => { try { sink.emit?.(ev); } catch { /* 隔离（index.js 同构） */ } },
  });
  rt.start();
  sink.emit = (ev) => { try { rt.publishStateChange(ev); } catch { /* 隔离 */ } };
  let topicAttachUn = null;
  if (attach && !topicAttachUn) topicAttachUn = hub.attachTopic('swarm.');
  return { hub, rt, store, un: topicAttachUn };
}

function makeBatch(store, batchId) {
  const wavePlan = { team: 'generic', wavePlan: [{ wave: 1, tasks: [{ id: 'x', cmd: 'x' }] }] };
  store.createBatch(S, { batchId, wavePlan });
  return batchId;
}

function batchFramesOf(res) {
  return res.frames.filter((f) => f.includes('event: batch'));
}

test('M1-A1 装配级链路：topic.enabled=true 装配模式 → store.setMember → hub 收到 SSE 推送帧', () => {
  const { hub, store, un } = assemble();
  const res = fakeRes();
  const st = hub.subscribe(S, null, res);
  assert.equal(st.ok, true, 'hub 订阅握手成功');
  const bid = makeBatch(store, B);
  store.setMember(S, bid, 'x', 'running');
  const frames = batchFramesOf(res);
  assert.equal(frames.length, 1, 'member.settled 状态事件经 attachTopic 路由推送 1 帧（batch 摘要）');
  const data = JSON.parse(frames[0].split('\n').find((l) => l.startsWith('data: ')).slice(6));
  assert.equal(data.sessionId, S, '帧携带 sessionId');
  assert.equal(data.batchId, B, '帧携带 batchId');
  assert.ok(typeof data.eventCount === 'number' || data.eventCount === null, '帧携带 eventCount（读批次文件或 null）');
  assert.ok(data.updatedAt, '帧携带 updatedAt');
  un();
  hub.dispose();
});

test('M1-A2 enabled=false 零接线：hub 装配但未 attachTopic → 状态事件零推送（fs.watch 单通道形态）', () => {
  const { hub, store } = assemble({ attach: false });
  const res = fakeRes();
  hub.subscribe(S, 'b2', res);
  const bid = makeBatch(store, 'b2');
  store.setMember(S, bid, 'x', 'running');
  assert.equal(batchFramesOf(res).length, 0, '未 attachTopic → emitTopic 无 hub 订阅者 → 零 batch 推送');
  // 心跳/握手帧仍在（SSE 连接本身不受 topic 开关影响）
  assert.ok(res.frames.some((f) => f.includes('event: heartbeat')), '心跳帧照常（hub 随 webServer 挂载）');
  hub.dispose();
});

test('M1-A3 退订对称：un() 后状态事件不再推送（topicUnsubs 清理）', () => {
  const { hub, store, un } = assemble();
  const res = fakeRes();
  hub.subscribe(S, 'b3', res);
  const bid = makeBatch(store, 'b3');
  store.setMember(S, bid, 'x', 'running');
  assert.equal(batchFramesOf(res).length, 1, '接线态：状态事件推送');
  un();
  // 退订后新订阅者零推送（新事件不再路由）
  const res2 = fakeRes();
  hub.subscribe(S, 'b3', res2);
  store.setMember(S, bid, 'x', 'review');
  assert.equal(batchFramesOf(res2).length, 0, 'un() 后零推送');
  hub.dispose();
});

test('M1-A4 handler 透传：attachTopic(prefix, handler) 自定义 handler 收 (topic, payload)', () => {
  const hub = createStreamHub({ root, logger: null });
  const got = [];
  const un = hub.attachTopic('swarm.', (topic, payload) => got.push({ topic, payload }));
  emitTopic('swarm.member.settled.' + S + '.b4', { sessionId: S, batchId: 'b4', lane: 'x', to: 'running' });
  assert.equal(got.length, 1, '前缀订阅命中');
  assert.equal(got[0].topic, 'swarm.member.settled.' + S + '.b4');
  assert.equal(got[0].payload.sessionId, S);
  assert.equal(got[0].payload.batchId, 'b4');
  un();
  hub.dispose();
});
