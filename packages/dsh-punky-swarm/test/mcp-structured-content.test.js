/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/mcp-structured-content.test.js —— **MCP 结构化输出提升**验收层。
//
// 问题（实测）：`tools/call` 返回体顶层键是 `{isError, content, value}` —— 真实数据在**自定义**
//   `value` 上，而 MCP 2025-06-18 的标准字段是 `structuredContent`。标准客户端只认后者
//   ⇒ 修复前它们只能看到 `content` 里那一行 render 摘要，数据面实际不可用。
//
// 判据（含两条**反向锁**，锁住刻意不做的事）：
//   SC-1 object 的 `value` ⇒ 提升为 `structuredContent`，且 `value` / `content` 原样保留（旧消费方零破坏）
//   SC-2 非 object（数组 / 标量 / null / 缺失）⇒ **不提**（规范要求 structuredContent 是 JSON object）
//   SC-3 反向锁：`content` **不得**被追加序列化 JSON（规范只是 SHOULD；`content` 整段进模型上下文，
//        511 批场景追加 JSON 等于把全量数据灌进 prompt）
//   SC-4 反向锁：`tools/list` 条目**不得**出现 `outputSchema`（声明即触发客户端「必填且必须匹配」强校验，
//        那是另一件事，不与该修复捆绑上风险）
//   SC-5 工具业务错（`isError:true`）⇒ 不给 structuredContent，但错误原因仍可读
//
// 跑法（必须带 preload）：
//   node --import ./test/helpers/isolated-home.preload.mjs --test test/mcp-structured-content.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createMcpHandler } from '../lib/mcp/data-plane-server.js';

/** 最小 HTTP 桩：走 handler 的**真实** readBody / isLoopback / sendJson 路径（经内网回环地址）。 */
function driveCall(handler, body) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]);
    req.method = 'POST';
    req.socket = { remoteAddress: '127.0.0.1' };
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

/** 注册表桩：只让 `batch_status` present（`callableToolNamesOf` 会滤掉其余常驻件）。 */
function makeCtx(resultOf) {
  const executed = [];
  return {
    executed,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: {
      get: (name) => (name === 'batch_status'
        ? { description: 'stub:batch_status', parameters: { type: 'object', properties: {} } }
        : null),
      execute: async (batch) => {
        const calls = Array.isArray(batch?.calls) ? batch.calls : [];
        for (const c of calls) executed.push(c.name);
        return { results: calls.map((c) => ({ callId: c.id, result: resultOf(c) })) };
      },
    },
  };
}

/** 驱动一次 tools/call，返回解析后的 JSON-RPC 帧。 */
async function callOnce(resultOf) {
  const ctx = makeCtx(resultOf);
  // `createMcpHandler` 返回 `{ handler }`（不是 handler 本身）——见 data-plane-server.js 末尾的返回形状
  const { handler } = createMcpHandler(ctx);
  const out = await driveCall(handler, {
    jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'batch_status', arguments: {} },
  });
  return { status: out.status, frame: JSON.parse(out.body), ctx };
}

test('SC-1 object 的 `value` ⇒ 提升为 structuredContent，`value` 与 `content` 均原样保留', async () => {
  const value = { sessionScope: 'all', total: 511, batches: [{ batchId: 'b-1' }] };
  const { frame } = await callOnce(() => ({
    content: [{ type: 'text', text: 'batches: 50/511 (最近活跃, limit=50)' }],
    isError: false,
    value,
  }));
  const result = frame.result;
  assert.deepEqual(result.structuredContent, value, 'structuredContent 必须是 value 的同一份数据（不加工、不改名）');
  assert.deepEqual(result.value, value, '`value` 必须原样保留（旧消费方零破坏）');
  assert.equal(result.content.length, 1, 'content 仍只有一项');
  assert.equal(result.content[0].text, 'batches: 50/511 (最近活跃, limit=50)', 'content 的 render 文本不得被改写');
  assert.equal(result.isError, false);
});

test('SC-2 非 object 的 `value` ⇒ 不提升（数组 / 标量 / null / 缺失四态）', async () => {
  const cases = [
    ['数组', [1, 2, 3]],
    ['字符串', 'raw-text'],
    ['数字', 42],
    ['null', null],
    ['缺失', undefined],
  ];
  for (const [label, value] of cases) {
    const { frame } = await callOnce(() => ({
      content: [{ type: 'text', text: 'ok' }], isError: false, ...(value === undefined ? {} : { value }),
    }));
    assert.equal(
      'structuredContent' in frame.result, false,
      label + ' 的 value 不得提升为 structuredContent（规范要求该字段是 JSON object）；实际=' + JSON.stringify(frame.result),
    );
  }
});

test('SC-3 反向锁：`content` 不得被追加序列化 JSON（避免全量数据灌进模型上下文）', async () => {
  const value = { batches: Array.from({ length: 50 }, (_, i) => ({ batchId: 'b-' + i })) };
  const { frame } = await callOnce(() => ({ content: [{ type: 'text', text: 'batches: 50' }], isError: false, value }));
  const texts = (frame.result.content ?? []).map((c) => c.text ?? '');
  assert.equal(texts.length, 1, 'content 只应有 1 个文本块（不得因结构化输出而追加 JSON 块）');
  assert.equal(texts.some((t) => t.includes('b-0') || t.includes('"batches"')), false, 'content 里不得出现序列化后的数据体');
  assert.deepEqual(frame.result.structuredContent, value, '数据必须走 structuredContent 这条标准通路');
});

test('SC-4 反向锁：`tools/list` 条目不得声明 outputSchema（声明即触发客户端强校验）', async () => {
  const ctx = makeCtx(() => ({ content: [{ type: 'text', text: 'ok' }], isError: false }));
  const { handler } = createMcpHandler(ctx);
  const out = await driveCall(handler, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const frame = JSON.parse(out.body);
  const items = frame.result.tools ?? [];
  assert.ok(items.length > 0, '至少宣告 1 件（batch_status）');
  for (const item of items) {
    assert.equal(
      'outputSchema' in item, false,
      item.name + '：本批刻意不声明 outputSchema —— 声明后 structuredContent 变为必填且必须匹配，'
      + '客户端会校验并在不匹配时报错（7 个工具的 schema 与真实返回体是否一致是另一件事）',
    );
    assert.equal(item.inputSchema?.type, 'object', item.name + '：inputSchema 仍须照常给出');
  }
});

test('SC-5 工具业务错 ⇒ isError:true 且不给 structuredContent，但原因仍可读', async () => {
  const ctx = makeCtx(() => { throw new Error('batch not found: b-x'); });
  const { handler } = createMcpHandler(ctx);
  const out = await driveCall(handler, {
    jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'batch_status', arguments: { batchId: 'b-x' } },
  });
  const frame = JSON.parse(out.body);
  assert.equal(frame.result.isError, true, '业务错走成功的 JSON-RPC 结果 + isError（模型能读到原因）');
  assert.equal('structuredContent' in frame.result, false, '错误结果不带结构化数据');
  assert.match(frame.result.content[0].text, /batch not found: b-x/, '错误原因必须可读');
});
