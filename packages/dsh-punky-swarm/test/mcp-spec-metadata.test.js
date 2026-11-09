/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/mcp-spec-metadata.test.js —— **MCP 规范元数据**验收层（O-1/O-2/O-3/O-4/O-5）。
//
// 背景：`tools/list` 条目此前恒为 `["name","description","inputSchema"]`，`initialize` 恒无
//   `instructions`。规范面缺口（均已对照 2025-06-18）：
//   · `annotations`（ToolAnnotations）：主流客户端据此判断能否自动批准 —— 缺它则「读黑板」
//     与「写黑板」在客户端眼里是同一类动作。
//   · `instructions`（InitializeResult）：面向模型的用法指导，客户端放进 system prompt。
//   · `title`：显示名优先级 `title → annotations.title → name`。
//
// 判据（编号对应方案 docs 之外的本地口径，见 punky 工作区 mcp-spec-audit/plan/optimize-plan.md）：
//   M-1 7 件全覆盖：`MCP_TOOL_TITLES` / `MCP_TOOL_ANNOTATIONS` 的键集与常驻名单**双向相等**
//       （加工具没配元数据 ⇒ 红；配了不存在的工具 ⇒ 红）
//   M-2 readonly 语义：5 件只读 ⇒ `readOnlyHint:true`；2 件写 ⇒ `false` 且 `openWorldHint:false`
//   M-3 端到端：`tools/list` 每件都**实际带出** title + annotations（不只是表里有）
//   M-4 `initialize` 带非空 `instructions`，且含「session 必填」「limit:0 取全量」两条关键用法
//       （后者是 G-1 会话缺口与多批裁剪的文档级补偿，缺了这测试就失去意义）
//   M-5 `batch_status` description 已瘦身（用户裁决「大幅缩短」，目标 200 字符量级）
//       且**仍保留** session-fallback 的两条既有断言（见 test/session-fallback.test.js:214-215）
//
// 跑法（必须带 preload）：
//   node --import ./test/helpers/isolated-home.preload.mjs --test test/mcp-spec-metadata.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  createMcpHandler, MCP_INSTRUCTIONS, MCP_TOOL_TITLES, MCP_TOOL_ANNOTATIONS,
} from '../lib/mcp/data-plane-server.js';
import { RESIDENT_TOOL_NAMES } from '../lib/engine/suite.js';
import { buildBatchStatusTools } from '../lib/tools/query-tools.js';

const READ_ONLY_EXPECTED = Object.freeze([
  'batch_status', 'handoff_view', 'task_pool', 'taskpack_for', 'role_guide',
]);
const WRITE_EXPECTED = Object.freeze(['handoff_submit', 'handoff_accept']);

/** 最小 HTTP 桩：走 handler 的真实 readBody / isLoopback / sendJson 路径。 */
// 【QA-01 · 桩真实性】真实 `IncomingMessage` 恒带 `headers`，HTTP/1.1 恒带 `Host`（RFC 9110 §7.2），
//    MCP 面另要求 `application/json`。缺这两项会被 QA-01 护栏/content-type 门拒成 -32600/415
//    —— 那是桩失真，不是合法请求形态。补头零行 assert 改动。
function driveCall(handler, body) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]);
    req.method = 'POST';
    req.socket = { remoteAddress: '127.0.0.1' };
    req.headers = { host: '127.0.0.1:3918', 'content-type': 'application/json' };
    const chunks = [];
    let status = 0;
    const res = {
      get statusCode() { return status; },
      set statusCode(v) { status = v; },
      setHeader() {},
      writeHead(code) { status = code; return this; },
      end(s) {
        if (s !== undefined && s !== null) chunks.push(Buffer.from(s));
        resolve({ status, body: Buffer.concat(chunks).toString('utf8') });
        return this;
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

/** 注册表桩：全部常驻件 present（tools/list 才会给出 7 件）。 */
function makeCtx() {
  const present = new Set(RESIDENT_TOOL_NAMES);
  return {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: {
      get: (name) => (present.has(name) ? { description: 'stub:' + name, parameters: { type: 'object', properties: {} } } : null),
      execute: async (batch) => ({
        results: (batch?.calls ?? []).map((c) => ({ callId: c.id, result: { content: [{ type: 'text', text: 'ok' }], isError: false } })),
      }),
    },
  };
}

async function rpc(method, params) {
  const ctx = makeCtx();
  const out = await driveCall(createMcpHandler(ctx).handler, { jsonrpc: '2.0', id: 1, method, params: params ?? {} });
  const frame = JSON.parse(out.body);
  assert.equal(frame.error, undefined, method + ' 不得回协议错误帧：' + out.body.slice(0, 300));
  return frame.result;
}

test('M-1 元数据表与常驻名单**双向**覆盖（加工具漏配元数据即红，配了不存在的工具也红）', () => {
  const resident = [...RESIDENT_TOOL_NAMES].sort();
  assert.deepEqual(Object.keys(MCP_TOOL_TITLES).sort(), resident, 'MCP_TOOL_TITLES 键集必须与 RESIDENT_TOOL_NAMES 逐名相等');
  assert.deepEqual(Object.keys(MCP_TOOL_ANNOTATIONS).sort(), resident, 'MCP_TOOL_ANNOTATIONS 键集必须与 RESIDENT_TOOL_NAMES 逐名相等');
});

test('M-2 readonly 语义：读件 readOnlyHint:true，写件 false 且 openWorldHint:false', () => {
  for (const name of READ_ONLY_EXPECTED) {
    const a = MCP_TOOL_ANNOTATIONS[name];
    assert.equal(a.readOnlyHint, true, name + ' 是只读件 ⇒ readOnlyHint 必须 true（客户端据此可自动批准）');
    assert.equal('destructiveHint' in a, false, name + ' 是只读件 ⇒ 不设 destructiveHint（规范：只读时该字段无意义）');
    assert.equal(a.openWorldHint, false, name + ' 领域封闭（任务黑板）⇒ openWorldHint 必须 false');
  }
  for (const name of WRITE_EXPECTED) {
    const a = MCP_TOOL_ANNOTATIONS[name];
    assert.equal(a.readOnlyHint, false, name + ' 是写件 ⇒ readOnlyHint 必须 false（否则客户端会误自动批准写操作）');
    assert.equal(a.destructiveHint, false, name + ' 只追加、不删改已有数据 ⇒ destructiveHint false');
    assert.equal(a.openWorldHint, false, name + ' 领域封闭');
  }
  // 幂等性：accept 二次提交幂等；submit 的 overwrite:true 可替换既有入边 ⇒ 非幂等
  assert.equal(MCP_TOOL_ANNOTATIONS.handoff_accept.idempotentHint, true, 'handoff_accept 幂等（响应体带 idempotent）');
  assert.equal(MCP_TOOL_ANNOTATIONS.handoff_submit.idempotentHint, false, 'handoff_submit 非幂等（overwrite 会改入边）');
});

test('M-3 端到端：`tools/list` 每件都实际带出 title + annotations', async () => {
  const result = await rpc('tools/list');
  const items = result.tools ?? [];
  assert.equal(items.length, RESIDENT_TOOL_NAMES.length, 'tools/list 必须宣告全部常驻件');
  for (const item of items) {
    assert.equal(typeof item.title, 'string', item.name + '：必须带 title（客户端显示名靠它）');
    assert.ok(item.title.length > 0, item.name + '：title 不得为空');
    assert.equal(typeof item.annotations, 'object', item.name + '：必须带 annotations');
    assert.equal(typeof item.annotations.readOnlyHint, 'boolean', item.name + '：annotations.readOnlyHint 必须是布尔');
    assert.equal(item.annotations.readOnlyHint, READ_ONLY_EXPECTED.includes(item.name), item.name + '：readOnlyHint 与「读/写」归类一致');
    assert.equal(item.inputSchema?.type, 'object', item.name + '：inputSchema 仍须是标准 object schema（本项未动它）');
  }
});

test('M-4 `initialize` 带非空 instructions，且含「session 必填」与「limit:0 取全量」两条关键用法', async () => {
  const result = await rpc('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'metadata-probe', version: '1' },
  });
  assert.equal(result.instructions, MCP_INSTRUCTIONS, 'initialize.instructions 必须等于导出常量（单一真源）');
  assert.equal(typeof MCP_INSTRUCTIONS, 'string');
  assert.ok(MCP_INSTRUCTIONS.length > 0, 'instructions 不得为空');
  assert.match(MCP_INSTRUCTIONS, /除 batch_status 外[^。]*session/, '必须说明「除 batch_status 外均需显式 session」（G-1 会话缺口的文档级补偿）');
  assert.match(MCP_INSTRUCTIONS, /limit:0/, '必须说明「要全量传 limit:0」（多批读面裁剪的补偿）');
  assert.equal(result.protocolVersion, '2025-06-18', 'instructions 的加入不得改变协议版本回显');
  assert.equal(result.serverInfo?.name, 'dsh-punky-swarm-data-plane', 'serverInfo 不变');
});

test('M-5 batch_status description 已瘦身，且保留 session-fallback 的两条既有断言文本', () => {
  // `SUITE_TOOLS` 是元数据表（name/kind/…），**不含 description** ⇒ 从工具构造面取真实定义。
  // 构造期不触碰 store（只在 execute 里用），故传空 store 安全。
  const tools = buildBatchStatusTools({ ctx: {}, deps: { resolveBatchSession: () => 'cli' }, store: {} });
  const def = tools.find((t) => t.name === 'batch_status');
  assert.ok(def, '必须能构造出 batch_status');
  // ⚠ 长度上限是**决策断言**（用户裁决「压到 200 字符以内，细节移交 instructions」），不是风格洁癖：
  //   上限 220 = 200 目标 + 20 余量，避免措辞微调就红，同时防止回弹到 900+ 或半途的 299。
  assert.ok(String(def.description).length <= 220,
    'batch_status.description 必须压到 200 字符量级（实测 ' + String(def.description).length + ' 字符，上限 220）');
  // 这两条是 test/session-fallback.test.js:214-215 的既有关键契约，瘦身不得吞掉
  assert.match(String(def.description), /未解析到调用方会话/, '必须保留「未解析到调用方会话」');
  assert.match(String(def.description), /显式 session 仍优先/, '必须保留「显式 session 仍优先」');
});
