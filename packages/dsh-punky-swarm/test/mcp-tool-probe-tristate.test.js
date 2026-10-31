/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/mcp-tool-probe-tristate.test.js —— **M2 三态验收**：存在 / 不存在 / **查询失败**三者观感必须不同。
//
// ★★ 本文件的存在理由（判据 #34）：原来的「唯一真判据」是「查询失败时响应**不含** `-32601`」——
//   而「**全坏了**」（所有调用一律 -32603）也是它的一个满足解。⇒ **只断「某串不出现」必须配阳性对拍**。
//
// ⇒ 三态必须**成对**断，且三态读数**互不相同**（读数相同 ⇒ 构造坏了，不是实现对了）：
//   · `present`  ⇒ **返回正常工具结果**（阳性对拍：证明系统没全坏）
//   · `absent`   ⇒ `-32601 unknown tool`（维持不变）
//   · `errored`  ⇒ **不含** `-32601` / `unknown tool`，且含可区分前缀 `host-port-query-failed:`
//
// 构造坑（e2 踩过，已按修）：
//   ① 伪 `req` **必须**带 `socket.remoteAddress='127.0.0.1'`，否则被 loopback-only 守卫拦成
//      `-32600 invalid request: loopback only` ⇒ 三态读数全相同，**不是证据**；
//   ② `data-plane-server.js` 是 **CRLF** 行尾 ⇒ 任何拼接锚点必须容忍 `\r`（本文件只走运行期、不拼源码，天然规避）。
//
// 跑法（必须带 preload）：node --import ./test/helpers/isolated-home.preload.mjs --test test/mcp-tool-probe-tristate.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { installMcpDataPlane } from '../lib/mcp/data-plane-server.js';
import { HOST_PORT_QUERY_FAILED } from '../lib/host-ports/index.js';

const TOOL = 'batch_status'; // 暴露族内的只读工具（blackboard/read 面）

/** 三态床：`ctx.tools.get` 的行为由 `state` 决定；`execute` 恒定返回"正常工具结果"。 */
function bedFor(state) {
  const exposed = [{ name: TOOL, description: 't', parameters: { type: 'object', properties: {} } }];
  let mounted = null;
  const executed = [];
  const tools = {
    get(name) {
      if (state === 'errored') throw new Error('registry exploded');
      if (state === 'absent') return null;
      // present：只让 TOOL 存在（其余名字一律 absent ⇒ 可调面求交仍只留 TOOL）
      return name === TOOL ? exposed[0] : null;
    },
    execute: async (exec) => { executed.push(exec); return { content: [{ type: 'text', text: 'NORMAL-TOOL-RESULT' }], isError: false }; },
    register: () => {},
    guard: () => {},
  };
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    webServer: { register: (route) => { mounted = route; return () => {}; } },
    tools,
  };
  installMcpDataPlane(ctx, {});
  assert.ok(mounted && typeof mounted.handler === 'function', '前置：MCP 面必须挂上 handler');
  return { handler: mounted.handler, executed };
}

function reqOf(body) {
  const stream = Readable.from([Buffer.from(body, 'utf8')]);
  stream.method = 'POST';
  stream.socket = { remoteAddress: '127.0.0.1' }; // 坑①：缺它会被 loopback 守卫拦成 -32600
  return stream;
}
function resOf() {
  return {
    statusCode: 0, headers: {}, body: '',
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(s, h) { this.statusCode = s; Object.assign(this.headers, h ?? {}); return this; },
    end(s) { if (s !== undefined) this.body += String(s); },
  };
}
async function call(handler, name) {
  const res = resOf();
  await handler(reqOf(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } })), res);
  return { statusCode: res.statusCode, raw: res.body, json: res.body ? JSON.parse(res.body) : null };
}

test('M2-1 ★三态读数**互不相同**，且各自符合契约（present 阳性对拍 / absent -32601 / errored 可辨前缀）', async () => {
  const results = { present: await call(bedFor('present').handler, TOOL), absent: await call(bedFor('absent').handler, TOOL), errored: await call(bedFor('errored').handler, TOOL) };

  // ── 阳性对拍（最关键的一条：证明系统没全坏）──
  const p = results.present;
  assert.equal(p.json.error, undefined, 'present 态**不得**是协议错误帧（否则"全坏"也能满足下面的否定判据）');
  assert.equal(p.json.result?.isError, false, 'present 态必须是**正常工具结果**（isError:false）');
  assert.equal(String(p.json.result?.content?.[0]?.text ?? '').includes('NORMAL-TOOL-RESULT'), true,
    'present 态必须把**工具的返回值**透出来（阳性对拍：真跑通了，不是"没报错"）');

  // ── 不存在：维持 -32601 ──
  const a = results.absent;
  assert.equal(a.json.error?.code, -32601, 'absent 态必须维持 -32601；实际=' + JSON.stringify(a.json.error));
  assert.match(String(a.json.error?.message ?? ''), /unknown tool/i, 'absent 态文案须为 unknown tool；实际=' + a.json.error?.message);

  // ── 查询失败：不含 -32601、且前缀可辨 ──
  const e = results.errored;
  const errText = JSON.stringify(e.json ?? null);
  assert.equal(errText.includes('-32601'), false, 'errored 态**不得**出现 -32601（否则"查询失败"被伪装成"不存在"）');
  assert.equal(/unknown tool/i.test(errText), false, 'errored 态**不得**出现 unknown tool');
  assert.equal(String(e.json.error?.message ?? '').startsWith(HOST_PORT_QUERY_FAILED), true,
    'errored 态文案必须以 ' + HOST_PORT_QUERY_FAILED + ' 开头（可区分前缀）；实际=' + e.json.error?.message);
  assert.equal(String(e.json.error?.message ?? '').includes('registry exploded'), true,
    'errored 态必须带宿主原错误（可诊断），不得只给一个裸码');

  // ── 三态读数**互不相同**（相同 ⇒ 构造坏了，不是实现对了）──
  const raws = [results.present.raw, results.absent.raw, results.errored.raw];
  assert.equal(new Set(raws).size, 3, '三态响应必须两两不同；实际=' + JSON.stringify(raws.map((r) => r.slice(0, 80))));
  assert.notEqual(results.present.statusCode === 0, true, '前置：三次调用都必须拿到响应（statusCode 已写）');
});

test('M2-2 变异必红：若把 errored 也映射成 -32601（回归到"吞错伪装不存在"）⇒ 上面的判据必红', async () => {
  // 变异装置**不碰 lib**：直接构造一个"退化版"响应断言——用 true 表示「该实现会给出 -32601」
  const degenerate = { error: { code: -32601, message: 'unknown tool: ' + TOOL } };
  const errText = JSON.stringify(degenerate);
  let red = false;
  try {
    assert.equal(errText.includes('-32601'), false, 'errored 态不得出现 -32601');
  } catch { red = true; }
  assert.equal(red, true, '退化成 -32601 时该断言必须红（证明它不是恒真判据）');

  // 同时验证「阳性对拍」能挡住"全坏"：模拟全坏（所有调用都 -32603）时，present 断言必红
  const allBroken = { error: { code: -32603, message: 'host-port-query-failed: registry exploded' } };
  let red2 = false;
  try {
    assert.equal(allBroken.error, undefined, 'present 态不得是协议错误帧');
  } catch { red2 = true; }
  assert.equal(red2, true, '**「全坏」必须被 present 阳性对拍照出来**（否则"不含 -32601"是假判据）');
});

test('M2-3 `tools/list` 在 errored 态的真实行为（实测取证，不作合格判定）', async () => {
  const handler = bedFor('errored').handler;
  const res = resOf();
  await handler(reqOf(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })), res);
  const json = res.body ? JSON.parse(res.body) : null;
  // 记录事实：是否崩、是否有 failures 字段、tools 是否为空
  const facts = {
    statusCode: res.statusCode,
    isErrorFrame: json?.error !== undefined,
    errorCode: json?.error?.code ?? null,
    toolCount: Array.isArray(json?.result?.tools) ? json.result.tools.length : null,
    hasFailuresKey: Object.prototype.hasOwnProperty.call(json?.result ?? {}, 'failures'),
    rawExcerpt: String(res.body ?? '').slice(0, 200),
  };
  console.log('[M2-3] tools/list@errored 实测 = ' + JSON.stringify(facts));
  // 只断言「不崩」（这是本批已实现的部分）：必须给出 200 + 合法 JSON-RPC 帧
  assert.equal(res.statusCode, 200, 'tools/list 在 errored 态不得崩（HTTP 200）');
  assert.ok(json !== null, 'tools/list 必须返回可解析的 JSON-RPC 帧');
  // ⚠ **不**断言 failures 存在 —— AC-7 的 failures 字段本轮**未实现**（e2 写域只在 tools/call），
  //   实测 facts.hasFailuresKey 即为此缺口的证据；该 gap 须在报告里如实登记，不得当已实现。
});
