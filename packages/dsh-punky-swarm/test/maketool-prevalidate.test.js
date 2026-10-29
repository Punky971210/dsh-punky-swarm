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

// `makeTool` 前置校验的杀伤力用例（S2）。
//
// 每条拒态用例都同时断三件事（缺一即不构成「拒态可杀」）：
//   ① `handler` **未被调用**（计数器为 0）—— 参数不合法就不进业务；
//   ② 抛**普通 `Error`**：前缀 `tool-input-invalid:`、**非 `GATE_` 前缀**、**`err.code === undefined`**；
//   ③ 消息点名**工具名**与**首个不合格字段**（可定位）。
// 合法路径另给**阴性对照**：`handler` 被调用、收到**同一份入参**、返回值**原样透传**。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTool, assertToolInput, TOOL_INPUT_INVALID_PREFIX } from '../lib/tools/make-tool.js';

/** 造一个带计数器的探针工具：handler 是否被调用、收到什么、返回什么，全部留痕。 */
function probeTool(overrides = {}) {
  const calls = [];
  const tool = makeTool({
    name: 'probe_tool',
    description: '探针',
    rules: {
      id: { type: 'string', required: true, nonEmpty: true },
      count: { type: 'number' },
      tags: { type: 'array' },
    },
    handler: (args) => {
      calls.push(args);
      return { ok: true, echo: args }; // 返回值用于「原样透传」对照
    },
    ...overrides,
  });
  return { tool, calls };
}

/** 统一的拒态断言（三项齐）：普通 Error / 前缀 / 无 code / 非 GATE_ / 点名工具与字段。 */
function expectRejected(err, { toolName = 'probe_tool', field }) {
  assert.ok(err instanceof Error, '拒态必须是 Error 实例');
  assert.equal(err.code, undefined, '拒态不得设置 err.code（不扩拒码集合）');
  const msg = String(err.message);
  assert.equal(/^GATE_/.test(msg), false, '拒态不得以 GATE_ 开头（它只是入参错误，不是治理门禁错误）');
  assert.equal(msg.startsWith(TOOL_INPUT_INVALID_PREFIX), true, '拒态前缀须为 ' + TOOL_INPUT_INVALID_PREFIX);
  assert.equal(msg.includes(toolName), true, '拒态须点名工具名：' + toolName);
  assert.equal(msg.includes(field), true, '拒态须点名首个不合格字段：' + field);
}

// ── ① 必填缺失 ⇒ handler 未被调用 ───────────────────────────────────────────────
test('mkt-1 必填缺失 ⇒ 抛 tool-input-invalid 且 handler 未被调用', async () => {
  const { tool, calls } = probeTool();
  let caught = null;
  try {
    await tool.execute({}); // 缺 id
  } catch (err) {
    caught = err;
  }
  assert.notEqual(caught, null, '缺必填项必须抛错（不得静默放行）');
  expectRejected(caught, { field: 'id' });
  assert.equal(calls.length, 0, 'handler 不得被调用（参数不合法不进业务）');
});

// ── ② 类型错 ⇒ handler 未被调用 ─────────────────────────────────────────────────
test('mkt-2 类型不符 ⇒ 抛 tool-input-invalid 且 handler 未被调用', async () => {
  const { tool, calls } = probeTool();
  let caught = null;
  try {
    await tool.execute({ id: 'a', count: '不是数字' });
  } catch (err) {
    caught = err;
  }
  assert.notEqual(caught, null, '类型不符必须抛错');
  expectRejected(caught, { field: 'count' });
  assert.equal(calls.length, 0, 'handler 不得被调用');
});

// ── ③ nonEmpty 空串 ⇒ handler 未被调用 ──────────────────────────────────────────
test('mkt-3 nonEmpty 空串 ⇒ 抛 tool-input-invalid 且 handler 未被调用', async () => {
  const { tool, calls } = probeTool();
  let caught = null;
  try {
    await tool.execute({ id: '' });
  } catch (err) {
    caught = err;
  }
  assert.notEqual(caught, null, '空串（nonEmpty 字段）必须抛错');
  expectRejected(caught, { field: 'id' });
  assert.equal(calls.length, 0, 'handler 不得被调用');
});

// ── ④ 合法入参 ⇒ 透传（阴性对照：证明校验不是「一律拒」）─────────────────────────
test('mkt-4 合法入参 ⇒ handler 被调用、收到同一份入参、返回值原样透传', async () => {
  const { tool, calls } = probeTool();
  const input = { id: 'abc', count: 3, tags: ['x', 'y'] };
  const out = await tool.execute(input);
  assert.equal(calls.length, 1, '合法入参必须抵达 handler（阴性对照）');
  assert.equal(calls[0], input, 'handler 收到的必须是**同一份**入参对象（不拷贝、不改写）');
  assert.deepEqual(out, { ok: true, echo: input }, '返回值必须原样透传（不包装、不裁剪）');
});

// ── ⑤ 校验器本身：多字段逐个验（pattern / enum / array）────────────────────────
test('mkt-5 pattern 与 enum 拒态（形状级，无策略判定）', () => {
  const rules = { runId: { type: 'string', pattern: /^run-[0-9]+$/ }, mode: { type: 'string', enum: ['a', 'b'] } };
  assert.equal(assertToolInput('t', rules, { runId: 'run-12', mode: 'a' }), true, '合法值须通过');

  let e1 = null;
  try { assertToolInput('t', rules, { runId: 'bad' }); } catch (e) { e1 = e; }
  assert.notEqual(e1, null, 'pattern 不匹配必须抛错');
  expectRejected(e1, { toolName: 't', field: 'runId' });

  let e2 = null;
  try { assertToolInput('t', rules, { mode: 'c' }); } catch (e) { e2 = e; }
  assert.notEqual(e2, null, 'enum 越界必须抛错');
  expectRejected(e2, { toolName: 't', field: 'mode' });
});

// ── ⑥ 构造期守卫：没有 name / handler 就不该造出工具 ────────────────────────────
test('mkt-6 makeTool 构造期守卫（缺 name / handler ⇒ 抛）', () => {
  assert.throws(() => makeTool({ name: '', handler: () => {} }), /makeTool rejected/);
  assert.throws(() => makeTool({ name: 'x' }), /makeTool rejected/);
});
