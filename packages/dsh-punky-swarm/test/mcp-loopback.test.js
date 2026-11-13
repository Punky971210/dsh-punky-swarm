/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/mcp-loopback.test.js —— MCP 面**入口 B**（自建 loopback 监听）验收层。
//
// 判据源：`plan/mcp-loopback-wiring.md` AC-1/2/3/4/5/6/9/10/11/12 ∪ `plan/leader-adjudication.md`
//   AC-5（覆盖：固定端口 + 显式失败，禁扫描/禁回落/禁发现文件）+ AC-13（新增：`unref` 生效）。
//
// 证据面纪律（照 `test/mcp-data-plane.test.js` 的口径）：
//   · 全部用**真监听 + 真 fetch / 真裸 socket**（禁止只用假 req/res 冒充传输面证据）；
//   · `tools` 面是**注册表桩**（只提供 `get` 三态 + `execute` 批式回包）：本 lane 的验收主体是**监听/生命周期**，
//     协议语义由 `test/mcp-data-plane.test.js`（真 ToolRuntime）承担；两边不互相冒充；
//   · 测试侧**手写冻结基准**（AC-2 原文的 7 名）是既有惯例（`mcp-data-plane.test.js:43-59` 同法），
//     并与生产派生面 `RESIDENT_TOOL_NAMES` 双向对齐 ⇒ 任一侧漂移即红。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createMcpHandler, installMcpDataPlane, mcpInternalErrorFrame, MCP_PATH, MCP_SERVER_INFO,
} from '../lib/mcp/data-plane-server.js';
import { installMcpLoopback, MCP_LOOPBACK_HOST } from '../lib/mcp/loopback-listener.js';
import { MCP_LOOPBACK_DEFAULTS, resolveMcpLoopbackConfig } from '../lib/schema.js';
import { RESIDENT_TOOL_NAMES } from '../lib/engine/suite.js';
import { createStore } from '../lib/state/store.js';
import { createTools } from '../lib/tools/register.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');

/** AC-2 原文冻结基准（测试侧唯一手写名单；与生产派生面双向对齐，见文件头纪律）。 */
const AC2_RESIDENT_7 = Object.freeze([
  'batch_status', 'handoff_view', 'task_pool', 'taskpack_for', 'role_guide',
  'handoff_submit', 'handoff_accept',
]);

// ── 夹具 ────────────────────────────────────────────────────────────────────────────────
function makeLogger() {
  const logs = [];
  const record = (level) => (msg) => logs.push({ level, msg: String(msg) });
  return {
    logs,
    info: record('info'), warn: record('warn'), debug: record('debug'), error: record('error'),
    warns: () => logs.filter((l) => l.level === 'warn').map((l) => l.msg),
    infos: () => logs.filter((l) => l.level === 'info').map((l) => l.msg),
    all: () => logs.map((l) => l.msg).join('\n'),
  };
}

/** 注册表桩：`get` 三态对齐 `createToolsPort(ctx).probeTool`；`execute` 走宿主批式回包形状。 */
function makeToolsStub(names = RESIDENT_TOOL_NAMES) {
  const present = new Set(names);
  const executed = [];
  return {
    executed,
    get: (name) => (present.has(name)
      ? { description: 'stub:' + name, parameters: { type: 'object', properties: {} } }
      : null),
    execute: async (batch) => {
      const calls = Array.isArray(batch?.calls) ? batch.calls : [];
      for (const c of calls) executed.push(c.name);
      return {
        results: calls.map((c) => ({
          callId: c.id,
          result: { content: [{ type: 'text', text: 'ok:' + c.name }], isError: false },
        })),
      };
    },
  };
}

/**
 * 自由端口（先 bind 0 取号再释放；仅测试取号，**不是**生产端口策略）。
 *
 * ⚠ 为什么**不**改成「高位随机区间试 bind」（F-04 子项 B 曾这么改又回退，留证据防复发）：
 *   探针实测 `listen(0)` 由 OS 的 ephemeral 分配器**顺序递增**发号 —— 连续 20 次得
 *   40997 / 40998 / … / 41006，重复数 0 ⇒ OS 分配器**保证**不重复；
 *   改成随机区间反而是靠运气避撞（每次约 1/区间宽度，40 次尝试内仍有碰撞可能），
 *   把「冲突概率 0」换成「很小但非 0」。
 *   ⇒ F-04 子项 B 的真因**不是**端口号复用，修复只在 `postJsonOf` 的连接级退避重试。
 */
async function freePortOf() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, MCP_LOOPBACK_HOST, resolve));
  const assigned = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return assigned;
}

/**
 * 某端口是否**无人监听**（true = 可以 bind 上去）。
 *
 * ⚠ 为什么不用 `net.connect` 探「端口是否被占」：本机 Windows 实测存在 **TCP 自连接** ——
 *   已占用端口 P 会让 `connect(P+1)` 也「连上」，且读数 `localPort === remotePort`（自己连自己），
 *   纯属误导性假阳性（证据见 notice 的「坑」段）。bind 才是「有没有人监听」的可靠判据。
 */
async function portFreeOf(port) {
  return new Promise((resolve) => {
    const s = net.createServer(() => {});
    s.once('error', () => resolve(false)); // EADDRINUSE 等 ⇒ 已被占
    s.listen(port, MCP_LOOPBACK_HOST, () => s.close(() => resolve(true)));
  });
}

/**
 * POST/GET 一个 JSON-RPC 帧（R1 · 连接级退避重试）。
 *
 * ⚠ 重试**只**覆盖「连接建立失败」（`fetch` throw，如 ECONNREFUSED / ECONNRESET）：
 *   一旦拿到 `res`，任何 HTTP 层结果（含 4xx/5xx 与畸形 JSON）都原样返回给断言 ——
 *   不重试、不改判据 ⇒ 不会把真实行为缺陷洗成绿。
 * ⚠ 每次重试都打 warning：重试本身必须可见，否则等同于静默掩盖。
 * ⚠ 重试耗尽后仍 `throw` 最后一次错误 ⇒ 该用例照旧变红，不存在「假绿」通道。
 */
const POST_RETRY_DELAYS_MS = [20, 50];

async function postJsonOf(port, body, { routePath = MCP_PATH, method = 'POST' } = {}) {
  const url = `http://${MCP_LOOPBACK_HOST}:${port}${routePath}`;
  const init = {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  };
  let lastErr = null;
  for (let attempt = 0; attempt <= POST_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url, init);
      const text = await res.text();
      let json = null;
      try { json = text.length > 0 ? JSON.parse(text) : null; } catch { json = null; }
      return { status: res.status, text, json };
    } catch (e) {
      lastErr = e;
      const delay = POST_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      process.emitWarning('[mcp-loopback.test] postJsonOf 连接失败，' + delay + 'ms 后重试 #' + (attempt + 1)
        + '（' + String(e?.code ?? '') + ' / ' + String(e?.message ?? e) + '）');
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

const rpcFrame = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const callFrameOf = (name, args, id = 2) => rpcFrame('tools/call', { name, arguments: args }, id);

/** 起一个入口 B（真监听）；返回 { dispose, port, logger, settled }。 */
async function startLoopback({ config, logger, handler } = {}) {
  const log = logger ?? makeLogger();
  const port = config?.port ?? await freePortOf();
  const ctx = { logger: log, tools: makeToolsStub() };
  const h = handler ?? createMcpHandler(ctx, { logger: log }).handler;
  const dispose = installMcpLoopback({
    handler: h,
    path: MCP_PATH,
    config: { enabled: true, host: MCP_LOOPBACK_HOST, ...config, port },
    logger: log,
  });
  const settled = await dispose.ready;
  return { dispose, port, logger: log, settled, ctx, handler: h };
}

// ══ L1 生效面（AC-2 + AC-12）════════════════════════════════════════════════════════════
test('L1 自建端口生效：initialize / tools/list（常驻 7 件）/ tools/call 全绿；路径面收窄三点同成立', async () => {
  const bed = await startLoopback();
  try {
    assert.equal(bed.settled.installed, true, '监听器必须装上；settled=' + JSON.stringify(bed.settled));
    assert.equal(bed.settled.port, bed.port, '实际端口必须等于配置端口（A-1：恒等，不迁移）');

    // ① initialize
    const init = await postJsonOf(bed.port, rpcFrame('initialize', {}));
    assert.equal(init.status, 200, 'initialize 必须 HTTP 200；body=' + init.text);
    assert.equal(init.json.result.serverInfo.name, MCP_SERVER_INFO.name, 'serverInfo.name 必须是 dsh-punky-swarm-data-plane');
    assert.equal(init.json.result.serverInfo.name, 'dsh-punky-swarm-data-plane');

    // ② tools/list：集合**恰等于**常驻 7 件（多一件/少一件即 fail）
    const listed = await postJsonOf(bed.port, rpcFrame('tools/list', {}, 2));
    const names = listed.json.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...AC2_RESIDENT_7].sort(), 'AC-2 原文 7 名（测试侧冻结基准）');
    assert.deepEqual(names, [...RESIDENT_TOOL_NAMES].sort(), '且必须与生产派生面 RESIDENT_TOOL_NAMES 逐名一致');
    assert.equal(names.length, 7, '7 件，不多不少');

    // ③ tools/call(batch_status) 非错误
    const called = await postJsonOf(bed.port, callFrameOf('batch_status', { batchId: 'b-x' }, 3));
    assert.equal(called.json.error, undefined, 'tools/call 不得回协议错误帧；body=' + called.text);
    assert.equal(called.json.result.isError, false, 'isError 必须 false');
    assert.equal(called.json.result.content[0].type, 'text');

    // ④ AC-12 三点同成立（证明 R-4 路径判定真的在位）
    const other = await postJsonOf(bed.port, rpcFrame('tools/list', {}, 4), { routePath: '/not-mcp' });
    assert.equal(other.status, 404, 'POST /任意非 /mcp 路径 ⇒ 404；实际=' + other.status);
    assert.equal(other.json.error, 'not-found', '404 体须为 JSON not-found');
    assert.equal(other.json.path, '/not-mcp');
    const badPathNoRpc = !/jsonrpc/.test(other.text);
    assert.equal(badPathNoRpc, true, '非 /mcp 路径不得返回任何 JSON-RPC 帧（面不许比契约宽）');

    const okPath = await postJsonOf(bed.port, rpcFrame('tools/list', {}, 5));
    assert.equal(okPath.json.result.tools.length, 7, 'POST /mcp ⇒ 正常 JSON-RPC');

    const got = await postJsonOf(bed.port, null, { method: 'GET' });
    assert.equal(got.json.error?.message, 'invalid request: POST only', 'GET /mcp ⇒ 既有 POST only 帧；实际=' + got.text);
  } finally {
    bed.dispose();
    await bed.dispose.closed;
  }
});

// ══ 安全面（AC-3）════════════════════════════════════════════════════════════════════════
test('AC-3 非 loopback 源拒绝：handler 首行 isLoopback 判定（伪造 remoteAddress=10.0.0.1 ⇒ loopback only）', async () => {
  const ctx = { logger: makeLogger(), tools: makeToolsStub() };
  const { handler } = createMcpHandler(ctx);
  const res = {
    statusCode: 0, body: undefined,
    setHeader() {}, writeHead(status) { this.statusCode = status; return this; },
    end(s) { if (s !== undefined) this.body = String(s); },
  };
  const req = {
    method: 'POST',
    url: MCP_PATH,
    socket: { remoteAddress: '10.0.0.1' },
    on() {}, // 本路径在 readDataPlaneRequestBody 之前就返回 ⇒ 不需要真流
  };
  await handler(req, res);
  const json = JSON.parse(res.body);
  assert.equal(json.error.message, 'invalid request: loopback only', '非 loopback 源必须拒；实际=' + res.body);
  assert.equal(json.error.code, -32600);
});

// ══ 双入口一致（AC-4）════════════════════════════════════════════════════════════════════
test('AC-4 双入口同一装配床：宿主路由 /mcp 与自建端口 /mcp 的 tools/list 集合相等', async () => {
  const logger = makeLogger();
  let route = null;
  const ctx = {
    logger,
    tools: makeToolsStub(),
    webServer: { register: (r) => { route = r; return () => { route = null; }; } },
  };
  // 入口 A：宿主路由（同一 ctx、同一工厂）
  const entryADispose = installMcpDataPlane(ctx, { logger });
  assert.ok(route && typeof route.handler === 'function', '前置：入口 A 必须挂上宿主路由');

  // 入口 B：自建监听（同一 ctx、同一工厂）
  const bed = await startLoopback({ logger, handler: createMcpHandler(ctx, { logger }).handler });
  try {
    const viaSocket = await postJsonOf(bed.port, rpcFrame('tools/list', {}, 11));
    // 入口 A 用同一 handler 的驱动面（假 req/res；传输面证据已由入口 B 真 socket 提供）
    const fromRoute = { statusCode: 0, body: undefined, setHeader() {}, writeHead(s) { this.statusCode = s; return this; }, end(s) { if (s !== undefined) this.body = String(s); } };
    const bodyText = JSON.stringify(rpcFrame('tools/list', {}, 11));
    const reqA = {
      method: 'POST', url: MCP_PATH, socket: { remoteAddress: '127.0.0.1' },
      // 【QA-01 · 桩真实性】真实 `IncomingMessage` 恒带 `headers`，HTTP/1.1 恒带 `Host`（RFC 9110 §7.2），
      //   MCP 面另要求 `application/json`。缺这两项会被 QA-01 信任护栏/content-type 门拒成 -32600/415
      //   —— 那是桩失真（入口 B 走真 socket，天然带头；入口 A 的假 req 必须同形）。补头零行 assert 改动。
      headers: { host: '127.0.0.1:' + bed.port, 'content-type': 'application/json' },
      on(event, cb) {
        if (event === 'data') cb(Buffer.from(bodyText, 'utf8'));
        if (event === 'end') cb();
      },
    };
    await route.handler(reqA, fromRoute);
    const viaRoute = JSON.parse(fromRoute.body);
    const a = viaRoute.result.tools.map((t) => t.name).sort();
    const b = viaSocket.json.result.tools.map((t) => t.name).sort();
    assert.deepEqual(a, b, '两入口 tools/list 必须同一集合（同 ctx / 同工厂 / 每请求惰性求交）');
    assert.deepEqual(b, [...AC2_RESIDENT_7].sort());
  } finally {
    bed.dispose();
    await bed.dispose.closed;
    entryADispose();
  }
});

// ══ 端口冲突（AC-5 · 裁决覆盖版：固定端口 + 显式失败）══════════════════════════════════
test('AC-5 预占配置端口 ⇒ installed=false + warn 含 "port <p> in use" 与改配置提示；断言未发生端口迁移', async () => {
  const logger = makeLogger();
  const port = await freePortOf();
  // 预占：模拟「别的程序长期占着这个口」
  const squatter = net.createServer(() => {});
  await new Promise((resolve) => squatter.listen(port, MCP_LOOPBACK_HOST, resolve));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-mcp-lb-conflict-'));
  try {
    const bed = await startLoopback({ config: { port }, logger });
    try {
      // ① installed === false
      assert.equal(bed.settled.installed, false, '冲突必须显式失败；settled=' + JSON.stringify(bed.settled));
      assert.equal(bed.dispose.installed, false, 'installed 活读数必须 false');
      assert.equal(bed.dispose.server.listening, false, '冲突后不得留下任何活监听');
      // ② warn 文案（裁决 A-1 定稿口径）
      const warns = logger.warns().join('\n');
      assert.match(warns, new RegExp('port ' + port + ' in use'), 'warn 必须含 "port <p> in use"；实际=' + warns);
      assert.match(warns, /config\.mcp\.loopback\.port/, 'warn 必须给出改配置的可执行提示；实际=' + warns);
      // ③ 未发生端口迁移：不试 port+1..+9、不写发现文件、不回落 0
      //    判法 = 相邻端口**全部可 bind**（有人监听就 bind 不上）⇒ 实现没有偷偷搬过去。
      const adjacentOccupied = [];
      for (let i = 1; i <= 9; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        if (!(await portFreeOf(port + i))) adjacentOccupied.push(port + i);
      }
      assert.deepEqual(adjacentOccupied, [], '不得尝试 port+1..port+9（A-1 否决顺序扫描）；实际被监听的相邻口=' + JSON.stringify(adjacentOccupied));
      assert.equal(fs.existsSync(path.join(rootDir, 'mcp-port.json')), false, '不得生成 mcp-port.json（A-1 否决发现面）');
      assert.equal(bed.settled.port, port, 'settled 报的仍是配置端口（没有迁移读数）');
      assert.equal(bed.dispose.address(), null, '无监听地址');
    } finally {
      bed.dispose();
      await bed.dispose.closed;
    }
  } finally {
    await new Promise((resolve) => squatter.close(resolve));
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

// ══ 释放（AC-6）════════════════════════════════════════════════════════════════════════
test('AC-6 dispose 后同端口可再次 listen（无孤儿）；二次 dispose 幂等零副作用', async () => {
  const bed = await startLoopback();
  const port = bed.port;
  assert.equal(bed.dispose.installed, true);
  bed.dispose();
  await bed.dispose.closed;
  assert.equal(bed.dispose.server.listening, false, 'dispose 后 listening 必须 false（R-7）');

  // 证明没有孤儿：**裸 net server** 直接抢回同端口
  const again = net.createServer(() => {});
  await new Promise((resolve, reject) => {
    again.once('error', (e) => reject(new Error('第二次 listen 抛了 ' + e.code + '（说明有孤儿监听）')));
    again.listen(port, MCP_LOOPBACK_HOST, resolve);
  });
  assert.equal(again.address().port, port, '同端口可再次 listen 成功');
  await new Promise((resolve) => again.close(resolve));

  // 幂等：二次调用不抛、不改变状态
  assert.doesNotThrow(() => { bed.dispose(); bed.dispose(); }, 'dispose 必须幂等');
});

// ══ 单实例 / 无孤儿（AC-9）══════════════════════════════════════════════════════════════
test('AC-9 ①先 dispose 再装配 ⇒ 恒单实例；②不 dispose 直接第二次装配 ⇒ 明确失败（禁静默双活）', async () => {
  const port = await freePortOf();
  const logger = makeLogger();

  // ① 模拟热重载：先装、dispose、再装 ⇒ 只允许 1 个 listener，第二次不抛 EADDRINUSE
  const first = await startLoopback({ config: { port }, logger });
  assert.equal(first.settled.installed, true);
  first.dispose();
  await first.dispose.closed;
  const second = await startLoopback({ config: { port }, logger });
  try {
    assert.equal(second.settled.installed, true, '热重载后必须能重新监听同端口；settled=' + JSON.stringify(second.settled));
    const listed = await postJsonOf(port, rpcFrame('tools/list', {}, 21));
    assert.equal(listed.json.result.tools.length, 7, '重装后服务可用');
  } finally {
    // ② 不给 dispose 就再装一次 ⇒ 必须**明确**失败（不允许静默双活）
    const dup = await startLoopback({ config: { port }, logger: makeLogger() });
    try {
      assert.equal(dup.settled.installed, false, '同一端口第二次装配必须失败（禁静默双活）');
      assert.equal(dup.settled.error?.code, 'EADDRINUSE');
    } finally {
      dup.dispose();
      await dup.dispose.closed;
    }
    second.dispose();
    await second.dispose.closed;
  }
});

test('AC-9 ③ 入口 A 缺席（route 注册失败路径）时入口 B 的 disposer 仍能关掉已开监听', async () => {
  const logger = makeLogger();
  const port = await freePortOf();
  // 无 webServer 的 ctx ⇒ 入口 A 走「not mounted」早退分支
  const ctx = { logger, tools: makeToolsStub() };
  const entryADispose = installMcpDataPlane(ctx, { logger });
  assert.equal(entryADispose.installed, false, '前置：入口 A 在 webServer 缺席时必须 installed=false');

  const bed = await startLoopback({ config: { port }, logger });
  assert.equal(bed.settled.installed, true, '入口 B 与入口 A 的成败解耦（R-9）');
  bed.dispose();
  await bed.dispose.closed;
  assert.equal(await portFreeOf(port), true, 'dispose 后端口必须真的空出来（无孤儿）');
  entryADispose();
});

// ══ L1 本质判据（AC-10 · 未过则本批不算达成 L1）══════════════════════════════════════════
test('AC-10 webServer 缺席：入口 A 不装（installed=false），入口 B 仍监听并可完成 initialize + tools/list', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-mcp-lb-l1-'));
  const store = createStore(root);
  const logger = makeLogger();
  const port = await freePortOf();
  const effects = [];
  const ctx = {
    logger,
    // ⚠ 刻意**不提供** webServer：这正是 L1 的价值场景
    tools: { ...makeToolsStub(), register: () => () => {}, guard: () => {} },
    effect(fn, label) { effects.push({ fn, label }); },
  };
  const config = { mcp: { loopback: { port } } };
  try {
    const toolkit = createTools(ctx, { store, root, config });
    assert.ok(toolkit.mcpLoopback, 'createTools 必须产出入口 B 的 disposer（唯一创建点 = register.js#createTools）');
    const settled = await toolkit.mcpLoopback.ready;
    assert.equal(settled.installed, true, 'webServer 缺席时入口 B 必须仍然装得上；settled=' + JSON.stringify(settled));

    // 入口 A 的语义不变：webServer 缺席 ⇒ installed=false（既有行为零回归）
    assert.equal(toolkit.mcpPlaneDispose.installed, false, '入口 A 仍按既有语义早退');

    const init = await postJsonOf(port, rpcFrame('initialize', {}));
    assert.equal(init.json.result.serverInfo.name, 'dsh-punky-swarm-data-plane', 'L1：webServer 缺席仍可 initialize');
    const listed = await postJsonOf(port, rpcFrame('tools/list', {}, 31));
    assert.deepEqual(listed.json.result.tools.map((t) => t.name).sort(), [...AC2_RESIDENT_7].sort(),
      'L1：webServer 缺席仍可 tools/list 出常驻 7 件');

    // 释放：模拟插件卸载（反向执行 ctx.effect 收集的工厂）
    for (const { fn } of [...effects].reverse()) {
      const d = fn();
      if (typeof d === 'function') d();
    }
    await toolkit.mcpLoopback.closed;
    assert.equal(await portFreeOf(port), true, '插件卸载后监听必须关闭（无孤儿）');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC-10 补：无 ctx.effect ⇒ 不建监听器（无释放保证 ⇒ 宁可不装，防孤儿）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-mcp-lb-noeffect-'));
  try {
    const logger = makeLogger();
    const ctx = { logger, tools: { ...makeToolsStub(), register: () => () => {}, guard: () => {} } };
    const toolkit = createTools(ctx, { store: createStore(root), root, config: { mcp: { loopback: { port: 3918 } } } });
    assert.equal(toolkit.mcpLoopback, null, '无 ctx.effect ⇒ mcpLoopback 必须为 null');
    assert.match(logger.all(), /loopback skipped/, '必须留 debug 痕迹（禁静默不装）');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ══ 异常不炸宿主（AC-11）════════════════════════════════════════════════════════════════
test('AC-11 ① handler reject ⇒ 进程无 unhandledRejection（外层兜底生效 + warn 留痕）；② 畸形 HTTP 不断进程', async () => {
  const logger = makeLogger();
  const rejections = [];
  const onRejection = (e) => rejections.push(e);
  process.on('unhandledRejection', onRejection);
  // ① handler 直接 reject
  const bed = await startLoopback({
    logger,
    handler: async () => { throw new Error('fixture handler rejection'); },
  });
  try {
    const r = await postJsonOf(bed.port, rpcFrame('tools/list', {}, 41));
    assert.equal(r.status, 500, 'handler reject ⇒ 500 兜底帧；实际=' + r.status + ' body=' + r.text);
    assert.match(logger.warns().join('\n'), /loopback handler failed/, '必须 warn 留痕；实际=' + logger.warns().join(' | '));
    // 等两个 tick 让任何 unhandledRejection 都有机会冒出来
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(rejections, [], '不得产生进程级 unhandledRejection');
  } finally {
    bed.dispose();
    await bed.dispose.closed;
  }

  // ② 畸形 HTTP（非法请求行）⇒ clientError 兜住，进程仍在、服务仍可用
  const good = await startLoopback({ logger });
  try {
    const raw = await new Promise((resolve) => {
      const sock = net.connect(good.port, MCP_LOOPBACK_HOST, () => sock.write('BAD REQUEST LINE\r\n\r\n'));
      let data = '';
      sock.on('data', (d) => { data += d; });
      sock.on('close', () => resolve(data));
      sock.on('error', () => resolve(data));
      setTimeout(() => { try { sock.destroy(); } catch { /* noop */ } resolve(data); }, 600);
    });
    assert.equal(typeof raw, 'string', '畸形请求只是被断开，不得抛出进程级错误');
    const after = await postJsonOf(good.port, rpcFrame('tools/list', {}, 42));
    assert.equal(after.json.result.tools.length, 7, '畸形 HTTP 之后服务必须仍然可用（进程未死）');
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(rejections, [], '两段都不得产生 unhandledRejection');
  } finally {
    process.off('unhandledRejection', onRejection);
    good.dispose();
    await good.dispose.closed;
  }
});

// ══ unref（AC-13 · 裁决 A-2 新增）═════════════════════════════════════════════════════════
test('AC-13 unref 生效：listening 期间句柄不持引用，且进程能自行退出（子进程实测）', async () => {
  const bed = await startLoopback();
  try {
    assert.equal(bed.dispose.server.listening, true, '前置：监听中');
    // ⚠ `server.hasRef` **不是** Node 公开 API（实测 typeof === 'undefined'）⇒ 只能读内部 handle；
    //   本断言是**旁证**，主判据是下面的行为面（进程自行退出）。
    const hasRef = bed.dispose.server._handle?.hasRef?.();
    assert.equal(hasRef, false, 'unref 后 handle 不得持引用；实际 _handle.hasRef()=' + String(hasRef));

    // 行为面：子进程装上真监听后脚本结束 ⇒ 必须自行退出（不因该句柄滞留）
    const moduleUrl = pathToFileURL(path.join(PKG, 'lib/mcp/loopback-listener.js')).href;
    const childCode = [
      `const net = await import('node:net');`,
      `const { installMcpLoopback } = await import(${JSON.stringify(moduleUrl)});`,
      `const probe = net.createServer();`,
      `await new Promise((r) => probe.listen(0, '127.0.0.1', r));`,
      `const port = probe.address().port;`,
      `await new Promise((r) => probe.close(r));`,
      `const d = installMcpLoopback({ handler: async (req, res) => { res.writeHead(200); res.end('{}'); }, path: '/mcp', config: { enabled: true, port } });`,
      `const st = await d.ready;`,
      `console.log('CHILD_INSTALLED=' + st.installed + ' LISTENING=' + d.server.listening + ' HASREF=' + String(d.server._handle?.hasRef?.()));`,
    ].join('\n');
    const out = await new Promise((resolve) => {
      const t0 = Date.now();
      const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      const timer = setTimeout(() => { child.kill(); resolve({ exited: false, ms: Date.now() - t0, stdout, stderr }); }, 5000);
      child.on('exit', (code) => { clearTimeout(timer); resolve({ exited: true, code, ms: Date.now() - t0, stdout, stderr }); });
    });
    assert.equal(out.exited, true, 'listening 期间进程必须能自行退出（unref 生效）；stdout=' + out.stdout + ' stderr=' + out.stderr.slice(0, 300));
    assert.equal(out.code, 0, '子进程退出码须为 0；stderr=' + out.stderr.slice(0, 300));
    assert.match(out.stdout, /LISTENING=true/, '子进程里监听必须真的开着（否则「能退出」不算证据）');
    assert.match(out.stdout, /HASREF=false/, 'unref 后 handle.hasRef() 必须 false；实际=' + out.stdout);
  } finally {
    bed.dispose();
    await bed.dispose.closed;
  }
});

// ══ 配置面（R-10 / A-1 / C-3）════════════════════════════════════════════════════════════
test('配置归一化：默认开 + 端口 3918；显式 false 才关；host 不可配（强制 127.0.0.1 且登记被拒原值）', () => {
  assert.deepEqual(resolveMcpLoopbackConfig({}), {
    enabled: true, port: 3918, host: MCP_LOOPBACK_HOST, rejectedHost: null,
  }, '缺省：enabled=true / port=3918 / host 硬钉');
  assert.deepEqual(MCP_LOOPBACK_DEFAULTS, { enabled: true, port: 3918, host: '127.0.0.1' });
  assert.equal(resolveMcpLoopbackConfig({ mcp: { loopback: { enabled: false } } }).enabled, false, '显式 false 才关');
  assert.equal(resolveMcpLoopbackConfig({ mcp: { loopback: { port: 4001 } } }).port, 4001, '端口可配');
  assert.equal(resolveMcpLoopbackConfig({ mcp: { loopback: { port: 'x' } } }).port, 3918, '非法端口回落默认值');

  const wild = resolveMcpLoopbackConfig({ mcp: { loopback: { host: '0.0.0.0' } } });
  assert.equal(wild.host, '127.0.0.1', 'host 不得被配成通配地址（C-3）');
  assert.equal(wild.rejectedHost, '0.0.0.0', '被拒原值必须登记（供装配侧 warn，不静默丢弃）');

  // 装配侧确实 warn 了（不是登记了却不用）
  const logger = makeLogger();
  installMcpLoopback({ handler: async () => {}, path: MCP_PATH, config: { enabled: false, ...wild }, logger });
  assert.match(logger.warns().join('\n'), /host 不可配/, '装配侧必须显式 warn');
});

test('配置关闭面：enabled=false ⇒ 不起监听（notInstalled 同形，调用方三处取件都不抛）', async () => {
  const logger = makeLogger();
  const d = installMcpLoopback({ handler: async () => {}, path: MCP_PATH, config: { enabled: false, port: 3918 }, logger });
  assert.equal(d.installed, false);
  assert.equal(d.server, null);
  assert.deepEqual(await d.ready, { installed: false, port: null, error: null });
  await d.closed;
  d(); // 幂等
});

// ══ 静态判据（C-1 零新依赖 / C-2 禁第二套实现 / R-8 单创建点）═══════════════════════════
test('C-1/C-2 静态面：监听器只依赖 node:http；零协议逻辑 token；禁 node:fs；协议帧单点构造', () => {
  const src = fs.readFileSync(path.join(PKG, 'lib/mcp/loopback-listener.js'), 'utf8');
  const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['./data-plane-server.js', '../json-response.js', 'node:http'].sort(),
    'C-1：只允许 node:http + 两个仓内窄件（不新增依赖、不引 node:fs）');
  assert.equal(imports.includes('node:fs'), false, 'A-1：端口发现文件已否决 ⇒ 不得引 node:fs');
  assert.equal(imports.includes('node:https'), false, '不得引 https（本入口是明文 loopback）');

  // 从协议面只借「帧构造」单点，禁借 handler/dispatch 逻辑（C-2）
  const fromProtocol = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/data-plane-server\.js'/g)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean));
  assert.deepEqual(fromProtocol, ['mcpInternalErrorFrame'], 'C-2：监听器只许复用降级帧构造，禁第二套协议实现');

  // 零协议逻辑 token
  const forbidden = ['tools/list', 'tools/call', 'MCP_PROTOCOL_VERSION', 'frameResultOf', 'jsonrpc', 'initialize'];
  const hits = forbidden.filter((t) => src.includes(t));
  assert.deepEqual(hits, [], 'C-2：监听器内不得出现协议逻辑 token；命中=' + JSON.stringify(hits));

  // 帧单点：降级帧只能由 data-plane-server 构造
  const proto = fs.readFileSync(path.join(PKG, 'lib/mcp/data-plane-server.js'), 'utf8');
  assert.match(proto, /export function mcpInternalErrorFrame/, '降级帧构造点必须在协议面');
  assert.equal(mcpInternalErrorFrame('x').error.code, -32603);
  assert.equal(mcpInternalErrorFrame('x').jsonrpc, '2.0');
});

test('R-8 单创建点：installMcpLoopback 全仓仅 1 处调用（register.js），且 lib/index.js 不涉及', () => {
  const libFiles = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (e.name.endsWith('.js')) libFiles.push(abs);
    }
  };
  walk(path.join(PKG, 'lib'));
  const callSites = libFiles
    .map((f) => ({ rel: path.relative(PKG, f).split(path.sep).join('/'), src: fs.readFileSync(f, 'utf8') }))
    .filter(({ rel }) => rel !== 'lib/mcp/loopback-listener.js' && rel !== 'lib/tools/register.js')
    .filter(({ src }) => /\binstallMcpLoopback\s*\(/.test(src))
    .map(({ rel }) => rel);
  assert.deepEqual(callSites, [], '入口 B 的调用点只许在 lib/tools/register.js；越界点=' + JSON.stringify(callSites));

  const indexSrc = fs.readFileSync(path.join(PKG, 'lib/index.js'), 'utf8');
  assert.equal(/installMcpLoopback|loopback-listener/.test(indexSrc), false,
    'R-8：不得放进 lib/index.js（http surface mount() 以 webServer.available 早退 ⇒ 会把入口 B 拖回宿主依赖）');
});
