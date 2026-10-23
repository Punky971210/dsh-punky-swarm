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

// 内部 ACPs 桥接测试（开关矩阵 + 零破坏边界）：
// ① bridge.enabled=false：mountBridge 短路 → null（零实例化零路径），mailbox 既有行为不变；
// ② enabled=true + inbound=false：外部写 mailbox 被拒（INBOUND_DISABLED），视图只读；
// ③ inbound=true：ACPs TaskCommand → mailbox.inbox 原子写（ackId 有效/幂等）+ 桥出 ACPs Message/TaskResult 回包；
// ④ 双向转换与 aip-format 三映射一致（toOutbound === toAipMessage 同源；command 透传语义对齐 toAipTask）；
// ⑤ 红线：ackId 原子写、三 box（inbox/outbox/broadcast）、outbox lane 隔离、ack 语义逐字保留——桥只经 mailbox 公共接口。

import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { send, readUnacked, ack, isAcked, boxDir } from '../lib/comms/mailbox.js';
import { toAipMessage, toAipTask } from '../lib/comms/aip-format.js';
import { resolveBridgeConfig, BRIDGE_DEFAULTS, resolveAcpsConfig } from '../lib/schema.js';
import {
  createBridge, mountBridge, deliverInbound, taskCommandToInbound, deriveLane,
  toTaskResult, TASK_STATES, selectRpcHandler,
} from '../lib/comms/acps-bridge.js';
import { createAcpsServer } from '../lib/acps/server.js';
import { ensureAcpsCerts, issueCert } from '../lib/acps/certs.js';
import { generateAic } from '../lib/aip/identity.js';

const engineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-bridge-'));
// 会话/批次隔离的 mailbox 根（对齐 mailbox-tools.boxRoot 语义：<root>/sessions/<sid>/mailbox/<bid>）
const mbRoot = (sid, bid) => path.join(engineRoot, 'sessions', sid, 'mailbox', bid);

// ---------- ① 开关双态：默认关（D6）+ config 短路零实例化（D7） ----------
test('resolveBridgeConfig: 默认关 (enabled=false, mode=inprocess, inbound=false)', () => {
  const cfg = resolveBridgeConfig({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.mode, 'inprocess');
  assert.equal(cfg.inbound, false);
  // 【改判留痕 · C1-12:53】原断言编码旧行为（`deepEqual(BRIDGE_DEFAULTS,{enabled,mode,inbound})` 三键快照），
  //   已被用户裁决 2026-10-23 + 本批 B 档收口覆盖：ACPS-05 收口后缺省表**新增**两键（投递目标=装配期声明）。
  assert.deepEqual(BRIDGE_DEFAULTS, {
    enabled: false, mode: 'inprocess', inbound: false,
    inboundSessionId: null, inboundBatchId: null,
  });
  // 目标键缺省必须是 null（fail-closed 的前提：未配置 ⇒ 无目标 ⇒ inbound 一律拒收）
  assert.equal(cfg.inboundSessionId, null);
  assert.equal(cfg.inboundBatchId, null);
});

test('resolveBridgeConfig: 投递目标两键透传（只做类型收敛，不做路径安全判定）', () => {
  // 【新增断言 · C1-12:59】ACPS-05：显式值必须原样透传（合法性由 acps-bridge.js#isSafePathSegment 唯一判定）
  const on = resolveBridgeConfig({ acps: { bridge: { enabled: true, inbound: true, inboundSessionId: 'main-sess', inboundBatchId: 'main-batch' } } });
  assert.equal(on.inboundSessionId, 'main-sess');
  assert.equal(on.inboundBatchId, 'main-batch');
  // 空串 / 非字符串 ⇒ 收敛为 null（fail-closed 侧统一按「未配置」处理）
  const bad = resolveBridgeConfig({ acps: { bridge: { inbound: true, inboundSessionId: '', inboundBatchId: 42 } } });
  assert.equal(bad.inboundSessionId, null);
  assert.equal(bad.inboundBatchId, null);
});

test('resolveBridgeConfig: 显式开启 enabled=true 时 inbound 仍默认关', () => {
  assert.equal(resolveBridgeConfig({ acps: { bridge: { enabled: true } } }).enabled, true);
  assert.equal(resolveBridgeConfig({ acps: { bridge: { enabled: true } } }).inbound, false);
  const on = resolveBridgeConfig({ acps: { bridge: { enabled: true, inbound: true } } });
  assert.equal(on.enabled, true);
  assert.equal(on.inbound, true);
});

test('mountBridge: enabled=false（缺省/显式）→ null，不实例化零路径（D7）', () => {
  assert.equal(mountBridge({}, { root: engineRoot }), null);
  assert.equal(mountBridge({ acps: { bridge: { enabled: false } } }, { root: engineRoot }), null);
});

test('mountBridge: enabled=true → 实例（inbound 默认关）', () => {
  const b = mountBridge({ acps: { bridge: { enabled: true } } }, { root: engineRoot });
  assert.ok(b, 'enabled=true 应实例化');
  assert.equal(b.enabled, true);
  assert.equal(b.inboundEnabled, false);
  assert.equal(b.mode, 'inprocess');
  b.dispose();
});

test('createBridge: enabled=false 实例 handleInbound 拒绝且不写 mailbox（零副作用）', () => {
  const b = createBridge({ root: engineRoot, config: {} });
  assert.equal(b.enabled, false);
  // 【改判留痕 · C1-12:81】原断言编码旧行为（外部报文指定目标：`handleInbound(cmd,{sessionId,batchId})`），
  //   已被用户裁决 2026-10-23 + 本批 B 档收口覆盖：上下文第二参数已**移除**（结构性保证调用方无传目标入口）。
  //   本用例门控先命中 enabled 门，期望码 BRIDGE_DISABLED 不变。
  const r = b.handleInbound({ command: 'start' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BRIDGE_DISABLED');
  assert.ok(!fs.existsSync(mbRoot('s', 'b')), '禁用时不得创建 mailbox 目录（零路径）');
  b.dispose();
});

// ---------- ② inbound 默认关：外部不可写 mailbox ----------
test('inbound=false（enabled=true）：外部写被拒 INBOUND_DISABLED，视图只读', () => {
  const b = createBridge({ root: engineRoot, config: { acps: { bridge: { enabled: true } } } });
  assert.equal(b.inboundEnabled, false);
  // 【改判留痕 · C1-12:92】原断言编码旧行为（外部报文指定目标：`handleInbound(cmd,{sessionId,batchId})`），
  //   已被用户裁决 2026-10-23 + 本批 B 档收口覆盖。inbound=false 时 inbound 门先于目标门 ⇒ 期望码不变。
  const r = b.handleInbound({ command: 'start', taskId: 't1' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INBOUND_DISABLED');
  assert.ok(!fs.existsSync(mbRoot('s1', 'b1')), 'inbound 关时不得落盘');
  // 视图（outbound 投影）仍可用——只读不写
  const view = b.toOutbound({ ackId: 'x', ts: '2026-08-22T00:00:00.000Z', box: { type: 'inbox' }, message: 'hi' });
  assert.equal(view.type, 'message');
  assert.equal(view.senderRole, 'leader');
  b.dispose();
});

test('deliverInbound: inboundEnabled=false 直接拒绝（缺省）', () => {
  const r = deliverInbound(engineRoot, 's1', 'b1', { command: 'start' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INBOUND_DISABLED');
});

test('fail-closed: inbound=true 但未配置投递目标 ⇒ INBOUND_UNAVAILABLE（零落盘 + 装配期 warn 点名缺键）', () => {
  // 【改判留痕 · C1-12:109-112】原用例名 `缺 sessionId/batchId 拒绝` 与期望码 `MISSING_CONTEXT` 编码旧行为
  //   （外部报文指定目标），已被用户裁决 2026-10-23 + 本批 B 档收口覆盖：目标改由装配期配置钉死，
  //   缺失语义从「调用方没传上下文」变为「装配期没配目标」⇒ `INBOUND_UNAVAILABLE`（fail-closed）。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-bridge-nogoal-'));
  const warns = [];
  const log = { warn: (m) => warns.push(String(m)), info() {} };
  const b = createBridge({ root, config: { acps: { bridge: { enabled: true, inbound: true } } }, logger: log });
  assert.equal(b.inboundTarget, null);
  // 报文带 id 也不再影响寻址（丢弃）；无论带不带，一律拒收
  const r1 = b.handleInbound({ command: 'start' });
  const r2 = b.handleInbound({ command: 'start', sessionId: 's9', commandParams: { batchId: 'b9' } });
  for (const r of [r1, r2]) {
    assert.equal(r.ok, false);
    assert.equal(r.code, 'INBOUND_UNAVAILABLE');
  }
  assert.ok(!fs.existsSync(path.join(root, 'sessions')), '目标未配置时不得落盘（fail-closed，绝不投默认目标）');
  assert.equal(warns.length, 1, '装配期恰好一条 warn');
  assert.match(warns[0], /inboundSessionId/);
  assert.match(warns[0], /inboundBatchId/);
  b.dispose();

  // ── 阳性对照：配置完整时**才**投递（防「一律拒绝」式过修）──
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-bridge-goal-'));
  const b2 = createBridge({
    root: root2,
    config: { acps: { bridge: { enabled: true, inbound: true, inboundSessionId: 's-main', inboundBatchId: 'b-main' } } },
  });
  assert.deepEqual(b2.inboundTarget, { sessionId: 's-main', batchId: 'b-main' });
  const ok = b2.handleInbound({ command: 'start', taskId: 't-ok' });
  assert.equal(ok.ok, true);
  // 用 readUnacked（而非裸 readdir——inbox 内另有 .acks 标记子目录）核落点
  const landed = readUnacked(path.join(root2, 'sessions', 's-main', 'mailbox', 'b-main'), { type: 'inbox' });
  assert.equal(landed.length, 1, '配置完整 ⇒ 落到唯一目标');
  assert.equal(landed[0].ackId, ok.ackId);
  b2.dispose();
});

// ---------- ③ inbound=true：原子写 + 往返 ----------
test('inbound=true：TaskCommand START → mailbox.inbox 原子写（ackId 有效/幂等）', () => {
  // 【改判留痕 · C1-12:119/126】原断言编码旧行为（外部报文指定目标：目标取自 tg 的 `{sessionId,batchId}`），
  //   已被用户裁决 2026-10-23 + 本批 B 档收口覆盖：目标改由装配期配置 inboundSessionId/inboundBatchId 钉死；
  //   报文 `sessionId` 仍作为 **meta.sessionId 元数据**回显（非寻址面），故 :137 断言不变。
  const b = createBridge({
    root: engineRoot,
    config: { acps: { bridge: { enabled: true, inbound: true, inboundSessionId: 's2', inboundBatchId: 'b2' } } },
  });
  const tc = {
    type: 'task-command', id: 'c1', sentAt: '2026-08-22T01:00:00.000Z',
    senderRole: 'leader', senderId: 'ext-leader',
    command: 'start', commandParams: { timeout: 60 }, taskId: 't-ext-1',
    sessionId: 's2', mentions: ['lane-a'],
  };
  const r = b.handleInbound(tc);
  assert.equal(r.ok, true);
  assert.ok(r.ackId, 'ackId 由 mailbox 生成');
  assert.equal(r.lane, 'lane-a');

  // 落盘消息：ackId 有效、负载=command/commandParams/taskId、元数据=sessionId/taskId/lane
  const boxItems = readUnacked(mbRoot('s2', 'b2'), { type: 'inbox' });
  assert.equal(boxItems.length, 1);
  const m = boxItems[0];
  assert.equal(m.ackId, r.ackId);
  assert.deepEqual(m.message, { command: 'start', commandParams: { timeout: 60 }, taskId: 't-ext-1' });
  assert.equal(m.meta.sessionId, 's2');
  assert.equal(m.meta.taskId, 't-ext-1');
  assert.equal(m.meta.lane, 'lane-a');

  // ack 语义保留（红线）
  ack(mbRoot('s2', 'b2'), { type: 'inbox' }, r.ackId);
  assert.equal(isAcked(mbRoot('s2', 'b2'), { type: 'inbox' }, r.ackId), true);
  assert.equal(readUnacked(mbRoot('s2', 'b2'), { type: 'inbox' }).length, 0);
  b.dispose();
});

// ---------- ④ 双向转换与 aip-format 一致 ----------
test('outbound toOutbound 与 aip-format.toAipMessage 同源一致（三 box 方向）', () => {
  const b = createBridge({ root: engineRoot, config: {} });
  const samples = [
    { ackId: 'a1', ts: '2026-08-22T00:00:00.000Z', box: { type: 'inbox' }, message: { task: 't' }, meta: { sender: 'leader', sessionId: 's' } },
    { ackId: 'a2', ts: '2026-08-22T00:00:00.000Z', box: { type: 'outbox', lane: 'lane-x' }, message: 'done', meta: { sender: 'lane-x' } },
    { ackId: 'a3', ts: '2026-08-22T00:00:00.000Z', box: { type: 'broadcast' }, message: { type: 'text', text: 'hi' } },
  ];
  for (const s of samples) {
    assert.deepEqual(b.toOutbound(s), toAipMessage(s), 'bridge.toOutbound 必须与 aip-format 同源');
  }
  b.dispose();
});

test('inbound taskCommandToInbound：command 枚举透传否则 start（对齐 toAipTask 语义）', () => {
  for (const cmd of ['start', 'continue', 'cancel', 'complete', 'get', 're-stream']) {
    const { message } = taskCommandToInbound({ command: cmd });
    assert.equal(message.command, cmd);
  }
  assert.equal(taskCommandToInbound({ command: 'weird' }).message.command, 'start');
  assert.equal(taskCommandToInbound({}).message.command, 'start');
  // 与 toAipTask 的 command 推导一致
  assert.equal(taskCommandToInbound({ command: 'weird' }).message.command, toAipTask({ id: 'x', cmd: 'weird' }).command);
});

test('deriveLane：mentions 单元素/字符串 → lane；groupId 兜底；all/非法 → null', () => {
  assert.equal(deriveLane({ mentions: ['lane-a'] }), 'lane-a');
  assert.equal(deriveLane({ mentions: 'lane-b' }), 'lane-b');
  assert.equal(deriveLane({ groupId: 'grp-1' }), 'grp-1');
  assert.equal(deriveLane({ mentions: 'all' }), null);          // 广播语义外部不可投递
  assert.equal(deriveLane({ mentions: ['a', 'b'] }), null);     // 多元素无单一 lane
  assert.equal(deriveLane({ mentions: ['../evil'] }), null);    // 非法 lane fail-soft
  assert.equal(deriveLane({}), null);
});

// ---------- outbound：TaskResult 投影（P1 endpoint 回包衔接） ----------
test('toTaskResult：outbox 消息 → ACPs TaskResult（TaskState 枚举/任务状态链）', () => {
  const msg = {
    ackId: 'o1', ts: '2026-08-22T02:00:00.000Z',
    box: { type: 'outbox', lane: 'lane-x' },
    message: { taskId: 't-1', text: 'done' },
    meta: { sender: 'lane-x', sessionId: 's3' },
  };
  const r = toTaskResult(msg, { state: 'completed' });
  assert.equal(r.type, 'task-result');
  assert.equal(r.taskId, 't-1');
  assert.equal(r.status.state, 'completed');
  assert.equal(r.status.stateChangedAt, '2026-08-22T02:00:00.000Z');
  // 对象负载 → toAipDataItems 结构化兜底（与 aip-format 同源，非 ACPs 判别器推导）
  assert.deepEqual(r.status.dataItems, [{ type: 'data', data: { taskId: 't-1', text: 'done' } }]);
  assert.equal(r.senderRole, 'partner');
  assert.equal(r.senderId, 'lane-x');
  assert.equal(r.sessionId, 's3');
  assert.ok(TASK_STATES.includes(r.status.state));
});

test('toTaskResult：taskId 兜底链 message→meta→ackId；非枚举 state fail-soft 回 completed', () => {
  const r1 = toTaskResult({ ackId: 'o2', ts: '2026-08-22T03:00:00.000Z', box: { type: 'outbox', lane: 'l' }, message: { done: true }, meta: { taskId: 't-9' } });
  assert.equal(r1.taskId, 't-9');
  const r2 = toTaskResult({ ackId: 'o3', ts: '2026-08-22T03:00:00.000Z', box: { type: 'outbox', lane: 'l' }, message: { done: true } });
  assert.equal(r2.taskId, 'o3');
  const r3 = toTaskResult({ ackId: 'o4', ts: '2026-08-22T03:00:00.000Z', box: { type: 'outbox', lane: 'l' }, message: {} }, { state: 'bogus' });
  assert.equal(r3.status.state, 'completed');
});

// ---------- ⑤ 红线：mailbox 既有语义零改动 ----------
test('红线：inbound 只写 inbox，outbox/broadcast 不受外部影响（三 box 隔离）', () => {
  // 【改判留痕 · C1-12:215/216】原断言编码旧行为（外部报文指定目标），已被用户裁决 2026-10-23 +
  //   本批 B 档收口覆盖：目标由装配期配置钉死，上下文第二参数已移除。
  const b = createBridge({
    root: engineRoot,
    config: { acps: { bridge: { enabled: true, inbound: true, inboundSessionId: 's4', inboundBatchId: 'b4' } } },
  });
  b.handleInbound({ command: 'start', taskId: 't-iso' });
  const r4 = mbRoot('s4', 'b4');
  // inbox 有 1 条（来自桥）；outbox/broadcast 无新增——桥绝不写 inbox 之外
  assert.equal(readUnacked(r4, { type: 'inbox' }).length, 1);
  assert.equal(readUnacked(r4, { type: 'broadcast' }).length, 0);
  assert.equal(readUnacked(r4, { type: 'outbox', lane: 'lane-x' }).length, 0);
  // 既有 mailbox 行为（send/read/ack 往返 + outbox lane 隔离）仍完好
  const s = send(r4, { type: 'outbox', lane: 'lane-x' }, { done: true });
  assert.equal(readUnacked(r4, { type: 'outbox', lane: 'lane-x' }).length, 1);
  assert.equal(readUnacked(r4, { type: 'outbox', lane: 'lane-y' }).length, 0);
  ack(r4, { type: 'outbox', lane: 'lane-x' }, s.ackId);
  assert.equal(readUnacked(r4, { type: 'outbox', lane: 'lane-x' }).length, 0);
  b.dispose();
});

test('红线：生命周期幂等——start/stop/dispose 重复调用不抛错', () => {
  const b = createBridge({ root: engineRoot, config: { acps: { bridge: { enabled: true } } } });
  b.start(); b.start();
  assert.equal(b.mounted, true);
  b.stop(); b.stop(); b.dispose(); b.dispose();
  assert.equal(b.mounted, false);
});

// ---------- ⑥ endpoint /rpc → bridge inbound 接线（demo 互通实测缺口） ----------
// 断言「/rpc START → mailbox.inbox unacked=1（bridge enabled+inbound=true 时）」与
// 「inbound=false 时 /rpc 不落 mailbox（INBOUND_DISABLED）」——mTLS 端点 + bridge 集成。

const SERVER_AIC = generateAic({ ontologySerial: '000000' });
const CLIENT_AIC = generateAic({ ontologySerial: 'ABCDEF' });

// 起 mTLS endpoint + bridge 集成（临时端口；信任锚=certDir 内 CA，客户端证书由同一 CA 签发）
async function startEndpointBridge({ bridgeCfg, root, withBridge = true }) {
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-v6-'));
  ensureAcpsCerts({ dir: certDir, aic: SERVER_AIC });
  const caPem = fs.readFileSync(path.join(certDir, 'ca.pem'), 'utf8');
  const caKeyPem = fs.readFileSync(path.join(certDir, 'ca.key'), 'utf8');
  const client = issueCert({ caCertPem: caPem, caKeyPem, cn: CLIENT_AIC, aic: CLIENT_AIC, usages: ['clientAuth'] });
  const warns = [];
  const logger = { info() {}, warn: (m) => warns.push(String(m)) };
  const bridge = withBridge ? createBridge({ root, config: { acps: { bridge: bridgeCfg } }, logger }) : null;
  const endpointCfg = resolveAcpsConfig({ acps: { enabled: true, endpoint: { enabled: true, port: 0, aic: SERVER_AIC } } });
  const acps = createAcpsServer({
    config: endpointCfg,
    certDir,
    // 【改判留痕 · C1-12:253-258】原断言编码旧行为（`bridge ? createEndpointRpcHandler(bridge) : undefined`
    //   即「bridge 不在位一律 undefined ⇒ 静默 accepted」），已被用户裁决 2026-10-23 + 本批 B 档收口覆盖：
    //   选择逻辑单点化 = selectRpcHandler（ACPS-04：声明 inbound 而无桥 ⇒ rejected INBOUND_UNAVAILABLE）。
    rpcHandler: selectRpcHandler({ bridge, inboundRequested: bridgeCfg?.inbound === true, logger }),
    logger,
  });
  assert.ok(!acps.error, acps.error ?? '');
  const addr = await acps.listen(0);
  return { port: addr.port, caPem, client, acps, bridge, warns, close: () => acps.close() };
}

function rpcPost(port, caPem, client, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: 'localhost', port, path: '/acps/rpc', method: 'POST',
      ca: caPem, cert: client.certPem, key: client.keyPem,
      minVersion: 'TLSv1.3', rejectUnauthorized: true, servername: 'localhost',
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

test('/rpc START（bridge enabled+inbound=true）→ 200 accepted + mailbox.inbox unacked=1（落唯一配置目标）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-v6root-'));
  const v6Root = (sid, bid) => path.join(root, 'sessions', sid, 'mailbox', bid);
  // 【改判留痕 · C1-12:286】原断言编码旧行为（bridgeCfg 只给 enabled/inbound，目标取自报文），
  //   已被用户裁决 2026-10-23 + 本批 B 档收口覆盖：目标必须由装配期配置钉死，故补两键。
  //   ⚠ 报文仍带 `sessionId:'sess-v6'` / `batchId:'b-v6'`（与外配同值）——同值时落点无法区分「取自报文」与
  //   「取自配置」；**区分力由 `test/acps-inbound-bound.test.js` 的受审用例承担**（报文 victim-* vs 配置 main-*）。
  const s = await startEndpointBridge({
    bridgeCfg: { enabled: true, inbound: true, inboundSessionId: 'sess-v6', inboundBatchId: 'b-v6' },
    root,
  });
  try {
    const r = await rpcPost(s.port, s.caPem, s.client, {
      jsonrpc: '2.0', method: 'rpc', id: 'v6-1',
      params: { command: {
        type: 'task-command', id: 'c-v6', command: 'start', taskId: 't-v6',
        sessionId: 'sess-v6', mentions: ['lane-a'],
        commandParams: { batchId: 'b-v6', role: 'coder' },
      } },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.result.status.state, 'accepted'); // 协议级 accepted（任务已入 inbox）
    assert.equal(r.body.result.senderId, CLIENT_AIC);
    // 核心断言：/rpc START → mailbox.inbox unacked=1（inbound 实测缺口修复）
    const items = readUnacked(v6Root('sess-v6', 'b-v6'), { type: 'inbox' });
    assert.equal(items.length, 1);
    assert.equal(items[0].message.command, 'start');
    assert.equal(items[0].message.taskId, 't-v6');
    assert.equal(items[0].meta.sessionId, 'sess-v6');
    assert.equal(items[0].meta.lane, 'lane-a');
  } finally { await s.close(); }
});

test('/rpc（bridge enabled + inbound=false）→ 200 rejected + 不落 mailbox（INBOUND_DISABLED）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-v6root-'));
  const v6Root = (sid, bid) => path.join(root, 'sessions', sid, 'mailbox', bid);
  // 【改判留痕 · C1-12:312】行为不变（INBOUND_DISABLED），但补齐 ACPS-05 收口后的**无噪声**断言：
  //   inboundEnabled=false ⇒ 「报文 id 被忽略」warn 不得触发（默认档零新日志，规格约束 8）。
  const s = await startEndpointBridge({ bridgeCfg: { enabled: true, inbound: false }, root });
  try {
    const r = await rpcPost(s.port, s.caPem, s.client, {
      jsonrpc: '2.0', method: 'rpc', id: 'v6-2',
      params: { command: {
        type: 'task-command', id: 'c-v6b', command: 'start', taskId: 't-v6b',
        sessionId: 'sess-v6b', commandParams: { batchId: 'b-v6b' },
      } },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.result.status.state, 'rejected'); // 协议级拒绝（inbound 门控）
    assert.equal(r.body.result.status.dataItems[0].data.code, 'INBOUND_DISABLED');
    assert.ok(!fs.existsSync(v6Root('sess-v6b', 'b-v6b')), 'inbound=false 时 /rpc 不得落 mailbox');
    assert.deepEqual(s.warns.filter((w) => /report-supplied/.test(w)), [], 'inbound=false 时不得出现「报文 id 被忽略」噪声');
  } finally { await s.close(); }
});

test('/rpc（bridge enabled+inbound=true 但目标两键未配置）→ 200 rejected INBOUND_UNAVAILABLE + 装配期 warn 点名缺键', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-v6root-'));
  // 【改判留痕 · C1-12:330/345】原用例断言 `MISSING_CONTEXT`（旧行为：缺上下文 = 缺报文 id），
  //   已被用户裁决 2026-10-23 + 本批 B 档收口覆盖：目标由装配期配置钉死 ⇒ 缺目标即 INBOUND_UNAVAILABLE（fail-closed）。
  const s = await startEndpointBridge({ bridgeCfg: { enabled: true, inbound: true }, root });
  try {
    const r = await rpcPost(s.port, s.caPem, s.client, {
      jsonrpc: '2.0', method: 'rpc', id: 'v6-3',
      params: { command: { type: 'task-command', id: 'c-v6c', command: 'start', taskId: 't-v6c' } },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.result.status.state, 'rejected');
    assert.equal(r.body.result.status.dataItems[0].data.code, 'INBOUND_UNAVAILABLE');
    assert.ok(!fs.existsSync(path.join(root, 'sessions')), '目标未配置 ⇒ 零落盘');
    assert.ok(s.warns.some((w) => /inboundSessionId/.test(w) && /inboundBatchId/.test(w)), '装配期 warn 须点名缺哪两个键');
  } finally { await s.close(); }
});

test('/rpc（bridge 未装配=null 且未声明 inbound）→ 200 accepted 但不落 mailbox（P1 独立行为向后兼容）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-v6root-'));
  const v6Root = (sid, bid) => path.join(root, 'sessions', sid, 'mailbox', bid);
  // 【改判留痕 · C1-12:345】原断言编码旧行为（bridge 未装配一律 accepted），已被用户裁决 2026-10-23 +
  //   本批 B 档收口覆盖：**仅「未声明 inbound」**保留 accepted；声明了 inbound 的新用例见下一条。
  const s = await startEndpointBridge({ bridgeCfg: {}, root, withBridge: false });
  try {
    const r = await rpcPost(s.port, s.caPem, s.client, {
      jsonrpc: '2.0', method: 'rpc', id: 'v6-4',
      params: { command: {
        type: 'task-command', id: 'c-v6d', command: 'start', taskId: 't-v6d',
        sessionId: 'sess-v6d', commandParams: { batchId: 'b-v6d' },
      } },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.result.status.state, 'accepted'); // bridge 未装配 + 未声明 inbound：P1 独立回执
    assert.ok(!fs.existsSync(v6Root('sess-v6d', 'b-v6d')), 'bridge 未装配时 /rpc 不得落 mailbox');
  } finally { await s.close(); }
});

test('/rpc（bridge 未装配=null 但声明 inbound=true）→ 200 rejected INBOUND_UNAVAILABLE + 启动 warn（ACPS-04）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-v6root-'));
  // 【新增用例 · C1-12:345 后半】ACPS-04 缺陷本体：inbound=true + bridge.enabled=false 曾静默回 accepted；
  //   修后必须协议级 rejected + 启动期 warn，且零落盘。
  const s = await startEndpointBridge({ bridgeCfg: { enabled: false, inbound: true }, root, withBridge: false });
  try {
    const r = await rpcPost(s.port, s.caPem, s.client, {
      jsonrpc: '2.0', method: 'rpc', id: 'v6-5',
      params: { command: {
        type: 'task-command', id: 'c-v6e', command: 'start', taskId: 't-v6e',
        sessionId: 'sess-v6e', commandParams: { batchId: 'b-v6e' },
      } },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.result.status.state, 'rejected');
    assert.equal(r.body.result.status.dataItems[0].data.code, 'INBOUND_UNAVAILABLE');
    assert.ok(!fs.existsSync(path.join(root, 'sessions')), '零落盘');
    assert.ok(s.warns.some((w) => /INBOUND_UNAVAILABLE/.test(w) && /bridge\.enabled=false/.test(w)), '启动期须 warn 一次');
  } finally { await s.close(); }
});
