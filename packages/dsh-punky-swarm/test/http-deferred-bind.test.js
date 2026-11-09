/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/http-deferred-bind.test.js —— **S-执行层**：HTTP 面延迟绑定（方案 A）的行为判据。
//
// 判据源：`plan/http-deferred-bind.md`（AC-1..AC-8）。本件覆盖可在**单进程替身床**上判定的全部条目：
//   · AC-1 装配发生（`/mcp` 注册恰 1 次 + `[mcp] data plane mounted` 锚点恰 1 次）——**宿主 restart 侧**由
//     verdict 的 needHuman 行承担（约束 4：禁重启当前桌面端宿主）；
//   · AC-2 可达性（非网关假阳性）：路由表里有 `/mcp`，并**直接驱动**该路由的 handler 走
//     `initialize` → `tools/list` → `tools/call`，判据是**协议回包**（不是 HTTP 状态码）；
//   · AC-3 headless 不 pending、不报错、三面零挂载；
//   · AC-4 服务消失→再出现一个来回：`/mcp` 注册 2 次、无 `duplicate exact route`、第二次装配前第一次的
//     disposer 已被调用（事件序断言）；
//   · AC-6 连续两次 `value !== undefined` 只装配一次；
//   · AC-7 延迟装配后 topic 接线不静默丢线（面板流真收到一次 `swarm.` 前缀事件 + attach 只发生一次）；
//   · AC-8 能力读数不误导（纯函数单测 + 装配/释放两次刷新的留痕）。
//
// 床的形状（为什么不复用 `test/mcp-data-plane.test.js` 的真 ToolRuntime 床）：
//   该条测的是**协议面**本身（已由 S4 验收层覆盖）；本件测的是**装配时序与持有权**，
//   故工具面用「常驻 7 件的 get 替身 + 批式 execute 替身」，`webServer` 用带
//   **同实例重复注册即抛**（复刻宿主 `webserver: duplicate exact route`）的计数替身。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { apply } from '../lib/index.js';
import { MCP_PATH } from '../lib/mcp/data-plane-server.js';
import { emitTopic } from '../lib/comms/topic.js';
import { refreshFaceReading } from '../lib/host-face-reading.js';
import { assemblyCtx, tempRoot } from './helpers/gate-fixture.mjs';

// ── 冻结基准（不派生：本件是判据主体，禁从 `RESIDENT_TOOL_NAMES` 反推期望）────────────────
const EXPECTED_RESIDENT = Object.freeze([
  'batch_status', 'handoff_view', 'task_pool', 'taskpack_for', 'role_guide',
  'handoff_submit', 'handoff_accept',
]);

// ── 床：webServer 替身（**同实例**重复注册即抛，复刻宿主 `duplicate exact route`）────────────
function webServerRecord() {
  const events = []; // {type:'register'|'dispose', path} —— 保序，供「先 dispose 再重挂」判据
  const make = () => {
    const seen = new Set();
    const routes = [];
    const server = {
      routes,
      register(route) {
        const key = String(route?.method ?? 'GET') + '|' + String(route?.kind ?? 'exact') + '|' + String(route?.path);
        if (seen.has(key)) throw new Error('webserver: duplicate exact route "' + String(route?.path) + '"');
        seen.add(key);
        routes.push(route);
        events.push({ type: 'register', path: route.path });
        return () => { seen.delete(key); events.push({ type: 'dispose', path: route.path }); };
      },
    };
    return server;
  };
  const count = (type, routePath) => events.filter((e) => e.type === type && (routePath === undefined || e.path === routePath)).length;
  const indexOfNth = (type, routePath, n) => {
    let seen = 0;
    for (let i = 0; i < events.length; i += 1) {
      if (events[i].type !== type || events[i].path !== routePath) continue;
      seen += 1;
      if (seen === n) return i;
    }
    return -1;
  };
  return { events, make, count, indexOfNth };
}

/** 工具面替身：`get` 只认常驻 7 件（`tools/list` 的求交基准）；`execute` 走**批式**契约并记名。 */
function toolsStub(invocations = []) {
  return {
    register: () => () => {},
    get: (name) => (EXPECTED_RESIDENT.includes(name)
      ? { name, description: 'stub:' + name, parameters: { type: 'object', properties: {} } }
      : null),
    execute: async (batch) => {
      const call = batch?.calls?.[0] ?? {};
      invocations.push(call.name);
      return { results: [{ callId: call.id, result: { content: [{ type: 'text', text: 'ok:' + call.name }], isError: false } }] };
    },
  };
}

/** 装配 ctx：`assemblyCtx()`（tools / subagents / on / logger 收集器，**无 webServer** = headless 起点）。 */
function mkCtx({ tools, rtWriteLog } = {}) {
  const ctx = assemblyCtx();
  if (tools) ctx.tools = tools;
  else ctx.tools = toolsStub();
  if (rtWriteLog) ctx.rtWriteLog = rtWriteLog;
  return ctx;
}

/** 驱动宿主 `internal/service`（监听器实收 `(name, value)`——宿主 `dispatch` 先 shift 掉 self 与事件名）。 */
function serviceEvent(ctx, value) {
  for (const fn of [...(ctx.listeners.get('internal/service') ?? [])]) fn('webServer', value);
}

/** 服务出现：装配替身 server 并投一条 `internal/service` 事件。 */
function serviceAppear(ctx, record) {
  const server = record.make();
  ctx.webServer = server;
  serviceEvent(ctx, server);
  return server;
}

/** 服务消失：摘掉 `webServer` 后投一条 `value === undefined` 的事件（注销路径先 delete 再 notify）。 */
function serviceGone(ctx) {
  delete ctx.webServer;
  serviceEvent(ctx, undefined);
}

// ── MCP 协议面驱动（真实 handler，假 req/res 走同一 readBody/sendJson 路径）──────────────────
function reqOf(body) {
  const stream = Readable.from([Buffer.from(body, 'utf8')]);
  stream.method = 'POST';
  stream.socket = { remoteAddress: '127.0.0.1' };
  // 【Leader L-2 · 2026-11-10】补真实请求头：HTTP/1.1 的 `Host` 是强制头（RFC 9110 §7.2），
  //   `content-type: application/json` 是 MCP over HTTP 的媒体类型要求。缺头的假 req 属**桩失真**：
  //   QA-01 在 `createMcpHandler` 首段加了来源可信判据（`isTrustedConfigRequest` 要求 Host 可解析），
  //   缺头会被正确拒为 `-32600 untrusted origin`，从而误伤本文件的 `initialize` 断言。
  //   补头**不是放宽断言**：本文件零行 assert 改动；补头后的请求仍受 `sec-fetch-site`/`Origin` 判据约束。
  stream.headers = { host: '127.0.0.1:3918', 'content-type': 'application/json' };
  return stream;
}
function resOf() {
  return {
    statusCode: 0, headers: {}, chunks: [], body: undefined,
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(status, headers) { this.statusCode = status; if (headers) Object.assign(this.headers, headers); return this; },
    end(s) { if (s !== undefined) { this.chunks.push(String(s)); this.body = this.chunks.join(''); } },
  };
}
async function rpc(handler, frame) {
  const res = resOf();
  await handler(reqOf(JSON.stringify(frame)), res);
  return { statusCode: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

/** 假 SSE res（hub.subscribe 需要 writeHead/flushHeaders/write/end/on）。 */
function fakeSseRes() {
  const frames = [];
  return {
    frames,
    destroyed: false,
    writableEnded: false,
    writeHead() {},
    flushHeaders() {},
    write(chunk) { frames.push(String(chunk)); return true; },
    end() { this.writableEnded = true; },
    on() {},
  };
}

const infoText = (ctx) => ctx.calls.info.join('\n');
const countMatches = (text, re) => (text.match(re) ?? []).length;

// ══ AC-3 headless（无 webServer）════════════════════════════════════════════════════════════
test('AC-3 headless 不 pending：apply 正常返回、三面零挂载、留一条 deferred info、无 error 级日志', () => {
  const ctx = mkCtx();
  const record = webServerRecord();
  let disposer = null;
  assert.doesNotThrow(() => { disposer = apply(ctx, { root: tempRoot('punky-http-t3-') }); },
    'AC-3 约束：`internal/service` 永不触发时插件必须正常就绪（不得 pending / 不得抛）');
  try {
    assert.equal(typeof disposer, 'function', 'apply 返回 disposer');
    const infos = infoText(ctx);
    assert.equal(countMatches(infos, /http surface deferred: webServer unavailable in this host/g), 1,
      'AC-3 线索：headless 须恰留一条 `http surface deferred`；实际 info=' + JSON.stringify(ctx.calls.info.slice(-4)));
    assert.equal(infos.includes('[mcp] data plane mounted'), false,
      'AC-3：headless 不得出现 `[mcp] data plane mounted`');
    assert.deepEqual(ctx.calls.error, [], 'AC-3：headless 不得有 error 级日志（实测 ' + JSON.stringify(ctx.calls.error) + '）');
    assert.equal(record.events.length, 0, 'AC-3：无 webServer ⇒ 三面（/api、/discover、/mcp）零挂载');
  } finally {
    assert.doesNotThrow(() => disposer(), 'AC-3：卸载不得抛');
  }
});

// ══ AC-1 / AC-2（webServer 后到 ⇒ 装配 + /mcp 协议面可达）═════════════════════════════════
test('AC-2 webServer 后到 ⇒ 装配发生且 /mcp 协议面可达：initialize → tools/list(7 件) → tools/call 非错误', async () => {
  const invocations = [];
  const ctx = mkCtx({ tools: toolsStub(invocations) });
  const record = webServerRecord();
  const disposer = apply(ctx, { root: tempRoot('punky-http-t2-') });
  try {
    // 前置（防假绿）：装配前确实零挂载 —— 否则下面的「后到才装配」不成立
    assert.equal(record.events.length, 0, '前置：apply 同步段 webServer 未就绪 ⇒ 零挂载');
    assert.equal(infoText(ctx).includes('[mcp] data plane mounted'), false, '前置：此刻 /mcp 未挂载');

    const server = serviceAppear(ctx, record);

    // ── AC-1（装配发生；宿主 restart 侧读数在 verdict 的 needHuman 行）──
    assert.equal(record.count('register', MCP_PATH), 1, 'AC-1：/mcp 注册恰 1 次');
    assert.equal(countMatches(infoText(ctx), /\[mcp\] data plane mounted/g), 1, 'AC-1 锚点日志恰 1 次');
    assert.ok(record.count('register') > 1, 'AC-2 阳性前提：同一次装配还挂了 /api 族路由（实测 ' + record.count('register') + '）');
    assert.ok(server.routes.some((r) => r.path === '/.well-known/aip'), 'AC-2：discovery 面（/.well-known/aip）随装配在场');
    assert.ok(server.routes.some((r) => r.path === '/api/dsh-punky-swarm/discover'), 'AC-2：POST /discover 随装配在场');

    // ── AC-2（协议回包判据，**不用** HTTP 状态码）──
    const route = server.routes.find((r) => r.path === MCP_PATH);
    assert.ok(route && typeof route.handler === 'function', 'AC-2：路由表里必须有 /mcp 且带 handler');

    const initialized = await rpc(route.handler, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'deferred-bind-test', version: '1.0.0' } },
    });
    assert.equal(initialized.json?.result?.serverInfo?.name, 'dsh-punky-swarm-data-plane', 'AC-2：initialize 必须回服务器自述');

    const listed = await rpc(route.handler, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = (listed.json?.result?.tools ?? []).map((t) => t.name).sort();
    assert.deepEqual(names, [...EXPECTED_RESIDENT].sort(), 'AC-2：tools/list 名集必须恰为常驻 7 件（实测 ' + JSON.stringify(names) + '）');

    const called = await rpc(route.handler, {
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'batch_status', arguments: {} },
    });
    assert.equal(called.json?.error, undefined, 'AC-2：tools/call 不得回 JSON-RPC error 帧');
    assert.equal(called.json?.result?.isError, false, 'AC-2：tools/call(batch_status) 必须是非错误结果');
    assert.deepEqual(invocations, ['batch_status'], 'AC-2：调用必须真的落到工具执行面（不是空壳回包）');
  } finally {
    disposer();
  }
});

// ══ AC-4 服务消失→再出现（duplicate route 不复发 + 单一持有）════════════════════════════════
test('AC-4 一个来回：/mcp 注册 2 次、无 duplicate route、第二次装配前第一次 disposer 已调用', () => {
  const ctx = mkCtx();
  const record = webServerRecord();
  const disposer = apply(ctx, { root: tempRoot('punky-http-t4-') });
  try {
    const first = serviceAppear(ctx, record);
    assert.equal(record.count('register', MCP_PATH), 1, '第一轮装配：/mcp 注册 1 次');
    const apiRoutesFirstRound = record.count('register') - 1;
    assert.ok(apiRoutesFirstRound > 0, '阳性前提：第一轮同时挂了 /api 族路由');

    // 服务消失 ⇒ 必须释放（补上此前缺失的「服务下线」回收路径）
    serviceGone(ctx);
    assert.equal(record.count('dispose', MCP_PATH), 1, 'AC-4：第一次的 /mcp disposer 必须已被调用');
    assert.equal(record.count('dispose'), record.count('register'), 'AC-4：/api 族路由也必须同步释放（实测 dispose=' + record.count('dispose') + ' register=' + record.count('register') + '）');
    assert.equal(infoText(ctx).includes('http surface released: webServer gone'), true, '释放须留痕');

    // 服务再出现 ⇒ 第二次装配（替身 server 是新实例，`register` 替身对**同实例**重复注册即抛，
    //   ⇒「没抛」= 第一轮确实已摘干净；这也是宿主 `duplicate exact route` 的同形复刻）
    const second = serviceAppear(ctx, record);
    assert.notEqual(second, first, '前提：第二个 webServer 实例是另一对象');
    assert.equal(record.count('register', MCP_PATH), 2, 'AC-4：/mcp 注册必须发生 2 次（实测 ' + record.count('register', MCP_PATH) + '）');
    assert.equal(countMatches(infoText(ctx), /\[mcp\] data plane mounted/g), 2, 'AC-1 同源：每次真实挂载恰一条锚点日志');

    const firstDisposeAt = record.indexOfNth('dispose', MCP_PATH, 1);
    const secondRegisterAt = record.indexOfNth('register', MCP_PATH, 2);
    assert.ok(firstDisposeAt >= 0 && secondRegisterAt >= 0 && firstDisposeAt < secondRegisterAt,
      'AC-4：第二次装配**之前**第一次的 disposer 必须已被调用（实测 dispose@' + firstDisposeAt + ' / register@' + secondRegisterAt + '）');
  } finally {
    disposer();
  }
});

// ══ AC-6 幂等（连续事件只装配一次）══════════════════════════════════════════════════════════
test('AC-6 幂等：连续三次 `value !== undefined` 事件只触发一次装配', () => {
  const ctx = mkCtx();
  const record = webServerRecord();
  const disposer = apply(ctx, { root: tempRoot('punky-http-t6-') });
  try {
    const server = serviceAppear(ctx, record);
    const registerAfterFirst = record.count('register');
    assert.ok(registerAfterFirst > 0, '阳性前提：首次事件必须装配（否则「不重复」在零装配时也成立）');
    serviceEvent(ctx, server);
    serviceEvent(ctx, server);
    assert.equal(record.count('register'), registerAfterFirst, 'AC-6：重复事件不得重复注册（实测多出 ' + (record.count('register') - registerAfterFirst) + ' 条）');
    assert.equal(record.count('register', MCP_PATH), 1, 'AC-6：/mcp 仍恰 1 次');
  } finally {
    disposer();
  }
});

// ══ AC-7 topic 接线（延迟装配后不静默丢线；attach 幂等）════════════════════════════════════
test('AC-7 延迟装配后 topic 接线：面板流真收到一次 swarm. 前缀事件，且 attach 只发生一次', () => {
  const ctx = mkCtx();
  const record = webServerRecord();
  const disposer = apply(ctx, { root: tempRoot('punky-http-t7-'), capabilities: { topic: { enabled: true } } });
  try {
    // 前置（防假绿）：topic 已启用但 webServer 未就绪 ⇒ 此刻 hub 还不存在，attach 必然为 0
    const attachLogs = () => ctx.calls.info.filter((l) => l.includes('topic wiring attached')).length;
    assert.equal(attachLogs(), 0, '前置：延迟态下不得出现 attach 留痕（否则测不到「延迟后补接」）');

    const server = serviceAppear(ctx, record);
    assert.equal(attachLogs(), 1, 'AC-7：延迟装配完成后必须补一次 `attachTopic(\'swarm.\')`');
    serviceEvent(ctx, server);
    serviceEvent(ctx, server);
    assert.equal(attachLogs(), 1, 'AC-7：attach 必须幂等（重复事件不得重复订阅）');

    // 行为证据（比日志更强）：订阅 SSE 后发一条 `swarm.` 前缀 topic ⇒ 面板流收到帧
    const streamRoute = server.routes.find((r) => r.path === '/api/dsh-punky-swarm/stream');
    assert.ok(streamRoute && typeof streamRoute.handler === 'function', '阳性前提：SSE 路由随装配在场');
    const res = fakeSseRes();
    streamRoute.handler({ url: '/api/dsh-punky-swarm/stream?session=sess-defer-t7', method: 'GET', headers: {} }, res);
    assert.ok(res.frames.some((f) => f.includes('connected')), '阳性前提：SSE 订阅已建立');
    const before = res.frames.length;
    emitTopic('swarm.member.settled.sess-defer-t7.b-defer-t7', {
      sessionId: 'sess-defer-t7', batchId: 'b-defer-t7', updatedAt: new Date().toISOString(),
    });
    const pushed = res.frames.slice(before);
    assert.ok(pushed.some((f) => f.startsWith('event: batch')), 'AC-7：面板流必须收到 `swarm.` 前缀事件（帧=' + JSON.stringify(pushed) + '）');
    assert.ok(pushed.some((f) => f.includes('b-defer-t7')), 'AC-7：帧内容须带该批次号（topic → SSE 路由生效）');
  } finally {
    disposer();
  }
});

// ══ AC-8 能力读数不误导 ═════════════════════════════════════════════════════════════════════
test('AC-8a 刷新语义（纯函数）：true ⇒ reason=null 且退出 unavailable；false ⇒ 回落到不可用成因并重回集合；同值幂等', () => {
  const report = {
    host: [
      { key: 'toolSurface', available: true, reason: null, channels: null },
      { key: 'httpSurface', available: false, reason: 'face-unavailable: httpSurface', channels: null },
    ],
    unavailable: ['httpSurface'],
  };
  assert.equal(refreshFaceReading(report, 'httpSurface', true), true, '真实变化必须报 true（调用方据此留痕）');
  const face = report.host.find((h) => h.key === 'httpSurface');
  assert.equal(face.available, true, 'http 面读数必须刷成可用');
  assert.equal(face.reason, null, 'available:true 时 reason 必须为 null（禁「可用但带不可用成因」）');
  assert.deepEqual(report.unavailable, [], '派生 unavailable 必须随之重算');
  assert.equal(refreshFaceReading(report, 'httpSurface', true), false, '同值刷新 = 幂等 no-op（报 false）');
  assert.equal(refreshFaceReading(report, 'httpSurface', false), true, '反向刷新（服务消失）必须同样生效');
  assert.equal(face.available, false, '释放后读数回落 false');
  assert.equal(face.reason, 'face-unavailable: httpSurface', '回落时必须有成因词（不得留 null）');
  assert.deepEqual(report.unavailable, ['httpSurface'], '派生集合必须重新包含该面');
  // 非法入参不写：三态里的 `null`（未探明）不属「变化」
  assert.equal(refreshFaceReading(report, 'httpSurface', null), false, '`null`（未探明）不得被当作可用性刷新');
  assert.equal(refreshFaceReading(null, 'httpSurface', true), false, '缺报告 ⇒ no-op（不抛）');
});

test('AC-8b 装配接线：延迟装配后 httpSurface 读数由 false 刷成 true，释放后回落 false（各留痕一次）', () => {
  const ctx = mkCtx();
  const record = webServerRecord();
  const disposer = apply(ctx, { root: tempRoot('punky-http-t8-') });
  try {
    const refreshLogs = () => ctx.calls.info.filter((l) => l.includes('capability reading refreshed'));
    assert.deepEqual(refreshLogs(), [], '前置：apply 时刻 webServer 未就绪 ⇒ 尚无刷新留痕');
    serviceAppear(ctx, record);
    const afterMount = refreshLogs();
    assert.equal(afterMount.length, 1, 'AC-8：装配后必须刷新一次（实测 ' + JSON.stringify(afterMount) + '）');
    assert.ok(afterMount[0].includes('httpSurface.available=true'), 'AC-8：刷新方向必须是「变为可用」；实际=' + afterMount[0]);
    serviceGone(ctx);
    const afterRelease = refreshLogs();
    assert.equal(afterRelease.length, 2, 'AC-8：服务消失后必须再刷新回不可用（实测 ' + JSON.stringify(afterRelease) + '）');
    assert.ok(afterRelease[1].includes('httpSurface.available=false'), 'AC-8：回落方向必须是「变为不可用」；实际=' + afterRelease[1]);
  } finally {
    disposer();
  }
});

// ══ R-3 / 单一持有：卸载时 disposer 全部回收，且不重复释放 ═══════════════════════════════════
test('R-3 卸载：插件卸载释放全部路由 disposer（各恰 1 次），且二次调用幂等', () => {
  const ctx = mkCtx();
  const record = webServerRecord();
  const disposer = apply(ctx, { root: tempRoot('punky-http-tr3-') });
  serviceAppear(ctx, record);
  const registered = record.count('register');
  assert.ok(registered > 1, '阳性前提：装配确实注册了路由');
  disposer();
  assert.equal(record.count('dispose'), registered, 'D1 单一持有：注册的每条路由 disposer 必须恰被回收一次（实测 dispose=' + record.count('dispose') + ' register=' + registered + '）');
  assert.doesNotThrow(() => disposer(), '二次卸载必须幂等');
  assert.equal(record.count('dispose'), registered, '二次卸载不得重复释放');
});
