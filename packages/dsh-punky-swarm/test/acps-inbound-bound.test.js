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

// 【批 punky-acps-closeout-20261023 · lane c1-bridge】ACPS inbound 目标收口守卫
//
// 覆盖三条缺陷（规格 §2.1 / §验收标准 A1~A3）：
//   ACPS-01 inbound 的 sessionId/batchId 未经 sanitize 且取自外部报文 ⇒ path.join 归一化后逃出引擎根；
//   ACPS-05 inbound 目标未绑定本实例/本批 ⇒ 报文可向任意批的 supervisor/inbox 写（跨批 prompt 注入面）；
//   ACPS-04 inbound=true 而 bridge.enabled=false ⇒ rpcHandler=undefined → defaultRpcHandler 回 accepted（静默假成功）。
//
// 本文件**不触网**（全部走进程内函数 + 临时目录），与 `test/p2-bridge.test.js` 的 mTLS 集成用例互补：
//   那边证「端到端仍通」，这边证「越界/跨批/未配置三条路都不通」。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deliverInbound, createBridge, createEndpointRpcHandler, selectRpcHandler,
} from '../lib/comms/acps-bridge.js';

// ── 夹具 ──
// root = 引擎根（临时目录下的 engine/）：所有落盘必须落在其内，落在 base/ 同级即「逃出引擎根」。
function freshEngine(tag) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acps-bound-' + tag + '-'));
  const root = path.join(base, 'engine');
  fs.mkdirSync(root, { recursive: true });
  return { base, root };
}

// 目录树全量文件名（相对**给定根**，归一化为 POSIX 分隔符，Windows/Linux 同断言）
function walkFiles(top) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else out.push(path.relative(top, p).split(path.sep).join('/'));
    }
  };
  walk(top);
  return out;
}

function captureLogger() {
  const warns = [];
  return { warns, logger: { warn: (m) => warns.push(String(m)), info() {} } };
}

const pinnedBridgeConfig = (sid, bid) => ({
  acps: { bridge: { enabled: true, inbound: true, inboundSessionId: sid, inboundBatchId: bid } },
});

// ── ACPS-01：路径穿越报文不得逃出引擎根（deliverInbound = 唯一落盘闸口）──
test('ACPS-01: 穿越 id（../../ESCAPED / ../ALSO-ESCAPED）⇒ INVALID_CONTEXT 且零越界文件', () => {
  const { base, root } = freshEngine('escape');
  const r = deliverInbound(root, '../../ESCAPED', '../ALSO-ESCAPED',
    { type: 'task-command', command: 'start' }, { inboundEnabled: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_CONTEXT');
  // 反向断言：不仅回执拒绝，磁盘上**一个越界目录都没有**（修前实测 `escapesRoot:true`）
  assert.equal(fs.existsSync(path.join(base, 'ESCAPED')), false);
  assert.equal(fs.existsSync(path.join(base, 'ALSO-ESCAPED')), false);
  assert.deepEqual(walkFiles(base), [], 'engine/ 内亦零落盘（拒绝发生在 mailbox.send 之前）');
});

test('ACPS-01: 非法路径段变体一律 INVALID_CONTEXT（. / .. / 分隔符 / 盘符 / 空 / 空白）', () => {
  const { root } = freshEngine('variants');
  const bad = ['.', '..', 'a/b', 'a\\b', 'C:/x', 'C:\\x', '', ' ', 'x/..', '../x', 'a b', 'a\u0000b'];
  for (const v of bad) {
    const rs = deliverInbound(root, v, 'b1', { command: 'start' }, { inboundEnabled: true });
    assert.equal(rs.ok, false, 'sessionId=' + JSON.stringify(v));
    assert.equal(rs.code, 'INVALID_CONTEXT', 'sessionId=' + JSON.stringify(v));
    const rb = deliverInbound(root, 's1', v, { command: 'start' }, { inboundEnabled: true });
    assert.equal(rb.code, 'INVALID_CONTEXT', 'batchId=' + JSON.stringify(v));
  }
});

test('ACPS-01 反向断言: 合法 id（a.b / a-b / a_b / s1）仍然落盘——防「一律拒绝」式过修', () => {
  const { root } = freshEngine('legit');
  let n = 0;
  for (const v of ['a.b', 'a-b', 'a_b', 's1']) {
    const r = deliverInbound(root, v, 'b1', { command: 'start', taskId: 't-' + v }, { inboundEnabled: true });
    assert.equal(r.ok, true, 'sessionId=' + v);
    assert.ok(r.ackId, 'ackId 由 mailbox 生成');
    assert.ok(fs.existsSync(path.join(root, 'sessions', v, 'mailbox', 'b1', 'supervisor', 'inbox')), v);
    n += 1;
  }
  assert.equal(n, 4);
});

// ── ACPS-05：目标恒为装配期配置值，报文自带 id 一律丢弃并留痕 ──
test('ACPS-05: 报文指定 victim-* ⇒ 只落 main-* 目标，victim-* 目录不存在，且 warn 留痕', () => {
  const { root } = freshEngine('pinned');
  const { warns, logger } = captureLogger();
  const b = createBridge({ root, config: pinnedBridgeConfig('main-session', 'main-batch'), logger });
  assert.deepEqual(b.inboundTarget, { sessionId: 'main-session', batchId: 'main-batch' });
  const h = createEndpointRpcHandler(b, { logger });
  // 报文自选目标（修前实测 `crossBatchWrite:true`）
  const res = h({
    type: 'task-command', command: 'start', taskId: 't-cross', id: 'c-cross',
    sessionId: 'victim-s', commandParams: { batchId: 'victim-b' },
  }, {});
  assert.equal(res.status.state, 'accepted');

  const files = walkFiles(root);
  assert.equal(files.length, 1, '恰好一个文件：' + JSON.stringify(files));
  assert.match(files[0], /^sessions\/main-session\/mailbox\/main-batch\/supervisor\/inbox\/.+\.json$/);
  assert.equal(fs.existsSync(path.join(root, 'sessions', 'victim-s')), false, 'victim 会话目录必须不存在');
  assert.equal(fs.existsSync(path.join(root, 'sessions', 'main-session', 'mailbox', 'victim-b')), false);
  // 留痕：报文 id 被丢弃必须 warn（不得静默丢弃）
  assert.ok(warns.some((w) => /report-supplied/.test(w)), 'warn 缺：report-supplied id ignored；实得 ' + JSON.stringify(warns));
  b.dispose();
});

test('ACPS-05: 报文**不带** id 时同样落 main 目标（不因缺字段而拒），且无忽略噪声', () => {
  const { root } = freshEngine('pinned2');
  const { warns, logger } = captureLogger();
  const b = createBridge({ root, config: pinnedBridgeConfig('main-session', 'main-batch'), logger });
  const h = createEndpointRpcHandler(b, { logger });
  const res = h({ type: 'task-command', command: 'start', taskId: 't-plain' }, {});
  assert.equal(res.status.state, 'accepted');
  assert.match(walkFiles(root)[0], /^sessions\/main-session\//);
  assert.deepEqual(warns.filter((w) => /report-supplied/.test(w)), []);
  b.dispose();
});

// ── fail-closed：两键未配置 / 任一为空 ⇒ 直接拒收（绝无默认目标）──
test('fail-closed: 两键都未配置 ⇒ INBOUND_UNAVAILABLE + 零落盘 + 装配期 warn 点名两键', () => {
  const { root } = freshEngine('nogoal');
  const { warns, logger } = captureLogger();
  const b = createBridge({ root, config: { acps: { bridge: { enabled: true, inbound: true } } }, logger });
  assert.equal(b.inboundTarget, null);
  const h = createEndpointRpcHandler(b, { logger });
  const res = h({ type: 'task-command', command: 'start', sessionId: 's9', commandParams: { batchId: 'b9' } }, {});
  assert.equal(res.status.state, 'rejected');
  assert.equal(res.status.dataItems[0].data.code, 'INBOUND_UNAVAILABLE');
  assert.deepEqual(walkFiles(root), [], 'fail-closed：绝不投递到空目标 / 默认会话 / 第一条批');
  const assemblyWarn = warns.find((w) => /投递目标不可用/.test(w));
  assert.ok(assemblyWarn, '装配期须 warn；实得 ' + JSON.stringify(warns));
  assert.match(assemblyWarn, /acps\.bridge\.inboundSessionId/);
  assert.match(assemblyWarn, /acps\.bridge\.inboundBatchId/);
  assert.match(assemblyWarn, /如何|配置方式/, 'warn 须说明怎么配');
  b.dispose();
});

test('fail-closed: 只配其中一个 ⇒ 仍拒收，warn 只点名缺的那个（positive control 见下条）', () => {
  for (const [cfg, missing, present] of [
    [{ inboundSessionId: 's-main' }, 'acps.bridge.inboundBatchId', 'acps.bridge.inboundSessionId'],
    [{ inboundBatchId: 'b-main' }, 'acps.bridge.inboundSessionId', 'acps.bridge.inboundBatchId'],
  ]) {
    const { root } = freshEngine('half');
    const { warns, logger } = captureLogger();
    const b = createBridge({ root, config: { acps: { bridge: { enabled: true, inbound: true, ...cfg } } }, logger });
    assert.equal(b.inboundTarget, null);
    assert.equal(b.handleInbound({ command: 'start' }).code, 'INBOUND_UNAVAILABLE');
    assert.deepEqual(walkFiles(root), []);
    const w = warns.find((x) => /投递目标不可用/.test(x));
    assert.ok(w, '须 warn');
    assert.match(w, new RegExp(missing.replace(/\./g, '\\.')));
    assert.ok(!new RegExp(present.replace(/\./g, '\\.') + ' 未配置').test(w), 'warn 不得把已配的键也说成缺');
    b.dispose();
  }
});

test('fail-closed: 配置值非法（../）视同未配置 ⇒ 目标 null ⇒ 拒收（双层防预第一层）', () => {
  const { root } = freshEngine('badcfg');
  const { logger } = captureLogger();
  const b = createBridge({ root, config: pinnedBridgeConfig('../../ESCAPED', 'main-batch'), logger });
  assert.equal(b.inboundTarget, null);
  assert.equal(b.handleInbound({ command: 'start' }).code, 'INBOUND_UNAVAILABLE');
  assert.deepEqual(walkFiles(path.dirname(root)), [], '越界目录零创建（base 下除空的 engine/ 外无任何文件）');
  b.dispose();
});

test('阳性对照: 两键齐全且合法 ⇒ 投递成功（fail-closed 不得退化为「一律拒绝」）', () => {
  const { root } = freshEngine('ok');
  const { warns, logger } = captureLogger();
  const b = createBridge({ root, config: pinnedBridgeConfig('s-main', 'b-main'), logger });
  const r = b.handleInbound({ command: 'start', taskId: 't-ok' });
  assert.equal(r.ok, true);
  assert.ok(r.ackId);
  assert.deepEqual(walkFiles(root), ['sessions/s-main/mailbox/b-main/supervisor/inbox/' + r.ackId], 'ackId 即文件名');
  assert.deepEqual(warns.filter((w) => /投递目标不可用/.test(w)), [], '配置完整时不得出现缺键 warn');
  b.dispose();
});

// ── ACPS-04：selectRpcHandler 三态（装配面唯一决策点）──
test('ACPS-04: selectRpcHandler 三态——无桥+声明 inbound ⇒ rejected；无桥+未声明 ⇒ undefined；有桥 ⇒ 适配器', () => {
  const { warns, logger } = captureLogger();
  const { root } = freshEngine('selector');

  // ① 无桥 + 声明 inbound ⇒ 显式拒绝适配器（ACPS-04 缺陷本体：曾静默 accepted）
  const h1 = selectRpcHandler({ bridge: null, inboundRequested: true, logger });
  assert.equal(typeof h1, 'function');
  assert.ok(warns.some((w) => /INBOUND_UNAVAILABLE/.test(w)), '装配期须 warn 一次');
  const r1 = h1({ type: 'task-command', command: 'start', taskId: 't1', sessionId: 's', commandParams: { batchId: 'b' } }, {});
  assert.equal(r1.status.state, 'rejected');
  assert.equal(r1.status.dataItems[0].data.code, 'INBOUND_UNAVAILABLE');

  // ② 无桥 + 未声明 inbound ⇒ undefined（必须保留回落 server.js defaultRpcHandler 的旧路径）
  assert.equal(selectRpcHandler({ bridge: null, inboundRequested: false, logger }), undefined);

  // ③ 有桥 ⇒ 返回桥适配器（且非 ① 那个实例）
  const b = createBridge({ root, config: { acps: { bridge: { enabled: true } } }, logger });
  const h3 = selectRpcHandler({ bridge: b, inboundRequested: false, logger });
  assert.equal(typeof h3, 'function');
  assert.notEqual(h3, h1);
  // 桥在位但 inbound=false ⇒ 门控先命中（期望码不变）
  const r3 = h3({ command: 'start' }, {});
  assert.equal(r3.status.state, 'rejected');
  assert.equal(r3.status.dataItems[0].data.code, 'INBOUND_DISABLED');
  assert.deepEqual(walkFiles(root), [], '三态全部零落盘');
  b.dispose();
});

// ── ACPS-04 可观测性（lane c4-acps04 追加）：四条拒收路径可区分 + selectRpcHandler 三态 ──
//   背景：四条路的拒绝码并不同形但**文本**曾同形（「只配一个」与「值非法」逐字相同）⇒ 运维无法定位成因；
//   规格约束 9 要求「每个新增拒绝路径必须有 warn 或显式协议码，禁静默失败」。
//   四条路 = ① 缺键（两键均缺） ② 只配一个 ③ 值非法 ④ bridge 未启用（ACPS-04 缺陷本体）。

// 取某条路径的 warn 文本（各路径独立建 fixture，避免交叉污染）
function warnOfPath(cfg) {
  const { root } = freshEngine('w4');
  const { warns, logger } = captureLogger();
  const b = createBridge({ root, config: cfg, logger });
  const w = warns.find((x) => /投递目标不可用/.test(x)) ?? null;
  b.dispose();
  return { b, w };
}

test('ACPS-04 可观测性: 三条目标侧拒收路径（缺键 / 只配一个 / 值非法）warn 文本可区分', () => {
  const mk = (bridge) => ({ acps: { bridge: { enabled: true, inbound: true, ...bridge } } });
  const w1 = warnOfPath(mk({})).w;                                                            // ① 缺键
  const w2 = warnOfPath(mk({ inboundSessionId: 's-main' })).w;                                 // ② 只配一个
  const w3 = warnOfPath(mk({ inboundSessionId: 's-main', inboundBatchId: '../ESCAPED' })).w;   // ③ 值非法

  // ① 缺键：点名两键 + 定性「两键均未配置」
  assert.match(w1, /两键均未配置/);
  assert.match(w1, /acps\.bridge\.inboundSessionId/);
  assert.match(w1, /acps\.bridge\.inboundBatchId/);
  // ② 只配一个：定性「只配置了一个」+ 只点名缺的那个（不得把已配的说成缺）
  assert.match(w2, /只配置了一个/);
  assert.match(w2, /acps\.bridge\.inboundBatchId 未配置/);
  assert.ok(!/acps\.bridge\.inboundSessionId 未配置/.test(w2), '已配置的键不得被说成缺：' + w2);
  // ③ 值非法：定性「配置值非法」+ 回显非法值（与「未配置」严格区分——旧文本此处与 ② 逐字相同）
  assert.match(w3, /配置值非法/);
  assert.match(w3, /acps\.bridge\.inboundBatchId="\.\.\/ESCAPED" 值非法/);
  assert.ok(!/未配置/.test(w3), '值非法不得被写成「未配置」：' + w3);

  // 两两不同（可区分性的硬断言；旧文本 ②③ 相同）
  assert.equal(new Set([w1, w2, w3]).size, 3, '三条路径的 warn 必须互不相同');
});

test('ACPS-04 第 4 条路径（bridge 未启用）: 声明 inbound 却无桥 ⇒ rejected INBOUND_UNAVAILABLE + 可区分 warn', () => {
  const { root } = freshEngine('nobridge');
  const { warns, logger } = captureLogger();
  const h = selectRpcHandler({ bridge: null, inboundRequested: true, logger });
  assert.equal(typeof h, 'function', 'ACPS-04 缺陷本体：此处曾为 undefined ⇒ defaultRpcHandler 回 accepted');
  const res = h({ type: 'task-command', command: 'start', taskId: 't-nb', sessionId: 's', commandParams: { batchId: 'b' } }, {});
  assert.equal(res.status.state, 'rejected');
  assert.equal(res.status.dataItems[0].data.code, 'INBOUND_UNAVAILABLE');
  // warn 可区分：这条点名 enabled=false（与三条目标侧 warn 的定性词互不重叠）
  const w = warns.find((x) => /acps\.bridge\.inbound=true/.test(x));
  assert.ok(w, '须 warn；实得 ' + JSON.stringify(warns));
  assert.match(w, /acps\.bridge\.enabled=false/);
  assert.ok(!/投递目标不可用/.test(w), '本路径的成因是 enabled=false，不得混淆成目标缺失：' + w);
  // 零落盘：无桥 ⇒ 不存在任何 mailbox 写入（root 下必为空）
  assert.deepEqual(walkFiles(root), []);
});

test('ACPS-04 反向断言: 未声明 inbound 时 accepted 向后兼容不被打断（c2 明确警告的坑）', async () => {
  const { defaultRpcHandler } = await import('../lib/acps/server.js');
  const { logger } = captureLogger();
  // 装配面：未声明 ⇒ 不接管（undefined ⇒ index.js 回落 server.js defaultRpcHandler）
  assert.equal(selectRpcHandler({ bridge: null, inboundRequested: false, logger }), undefined);
  // 行为面：回落后的 defaultRpcHandler 仍回 accepted（不得因本批改动变成 rejected）
  const r = await defaultRpcHandler({ type: 'task-command', command: 'start', taskId: 't-compat' }, {});
  assert.equal(r.status.state, 'accepted');
  assert.equal(r.status.dataItems, undefined, '向后兼容路径不得带拒绝码');
});

test('ACPS-04 三态断言: 未声明 inbound / 声明且可用 / 声明但不可用', () => {
  const { root } = freshEngine('three');
  const { warns, logger } = captureLogger();

  // 态 1：未声明 ⇒ 不接管（undefined），零 warn（默认档零新日志）
  const t1 = warningsOf((log) => selectRpcHandler({ bridge: null, inboundRequested: false, logger: log }));
  assert.equal(t1.handler, undefined);
  assert.deepEqual(t1.warns, [], '默认档不得新增 warn');

  // 态 2：声明且可用（桥在位 + inbound=true + 两键齐全）⇒ accepted + 恰好 1 个落盘文件
  const b = createBridge({ root, config: pinnedBridgeConfig('s-main', 'b-main'), logger });
  const h2 = selectRpcHandler({ bridge: b, inboundRequested: true, logger });
  const r2 = h2({ type: 'task-command', command: 'start', taskId: 't-ok' }, {});
  assert.equal(r2.status.state, 'accepted');
  const files = walkFiles(root);
  assert.equal(files.length, 1, '声明且可用必须真落盘：' + JSON.stringify(files));
  assert.match(files[0], /^sessions\/s-main\/mailbox\/b-main\/supervisor\/inbox\//);

  // 态 3a：声明但不可用（无桥）⇒ rejected
  const h3 = selectRpcHandler({ bridge: null, inboundRequested: true, logger });
  assert.equal(h3({ command: 'start' }, {}).status.dataItems[0].data.code, 'INBOUND_UNAVAILABLE');
  // 态 3b：声明但不可用（桥在位而目标缺失）⇒ rejected（不得静默 accepted）
  const b2 = createBridge({ root: freshEngine('three2').root, config: { acps: { bridge: { enabled: true, inbound: true } } }, logger });
  const h3b = selectRpcHandler({ bridge: b2, inboundRequested: true, logger });
  assert.equal(h3b({ command: 'start' }, {}).status.dataItems[0].data.code, 'INBOUND_UNAVAILABLE');
  // 态 3c：声明但不可用（桥在位而 inbound=false，子门控先命中）⇒ INBOUND_DISABLED
  const b3 = createBridge({ root, config: { acps: { bridge: { enabled: true } } }, logger });
  const h3c = selectRpcHandler({ bridge: b3, inboundRequested: false, logger });
  assert.equal(h3c({ command: 'start' }, {}).status.dataItems[0].data.code, 'INBOUND_DISABLED');

  assert.ok(warns.length >= 1, '不可用态必须可观测');
  b.dispose();
  b2.dispose();
  b3.dispose();
});

// 小工具：跑一次装配并回收 handler + 该次产生的 warn（用于「默认档零 warn」断言）
function warningsOf(fn) {
  const { warns, logger } = captureLogger();
  const handler = fn(logger);
  return { handler, warns };
}
