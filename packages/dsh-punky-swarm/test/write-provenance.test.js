/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/write-provenance.test.js —— **S3 验收层**：`sourceRunId` 声明层 ＋ 执行层守卫。
//
// 判据源：`plan/p1-pack.md` §2.7（集合式 / 两态逐件 / 豁免面 / 无 L3 / 冻结基准对撞）＋ AC-6/AC-7/AC-9/AC-10。
//
// ⚠ 字段路径坑（e1-schema 实测）：`defineTool` 把 `parameters` **归一化为 JSON Schema** ⇒
//   运行时必须查 `tool.parameters.properties.sourceRunId`；按 `tool.parameters.sourceRunId` 直查会**假红成 0 件**。
//   「非必填」也必须查 `parameters.required` **数组**（不是字段上有无 `required` 键）。
//
// ⚠ 证据面分工：`npm run check` 对 `.js` **无证据力**（`checkJs:false`）⇒ 本文件的行为证据全部来自
//   **真实 dispatch**（宿主 `@deepseek-ai/dsh-tools` 的 `ToolRuntime` + 真 `@deepseek-ai/cordis` Context），
//   不是「守卫纯函数返回值形态」的复述（那是 e2-guard 已证的）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { SUITE_TOOLS } from '../lib/engine/suite.js';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import {
  WRITE_FAMILY, HOST_EXEMPT, SOURCE_RUN_ID_MISSING,
  writeProvenanceDecision, installWriteProvenanceGuard,
} from '../lib/tools/write-provenance-guard.js';

// ── 冻结基准（**测试侧唯一手写清单**；不在生产代码里，仅作对账基准、**不是**第二真源）──────────
//   纪律：派生集由 `suite.js` 现场算出；本清单只用于「派生 ≡ 基准」的对撞。**禁止**把它改成派生
//   （那样就成恒等恒绿）。19 名 = `write===true` 24 件 − 宿主 5 件豁免。
//   ⚠ 本清单经**逐名复核**落定（不是从派生结果回抄）：首版我手写时多写了 `gate_status`/`artifact_types`/
//     `task_pool`（三者 `write:false`）、漏了 `batch_control`/`swarm_report`/`swarm_cc`（三者 `write:true`）
//     ⇒ A2 直接红。**这次红就是基准对撞的价值**（手抄错误被派生面抓出来），保留此注以证「不是回抄」。
const EXPECTED_WRITE_FAMILY = Object.freeze([
  'asset_claim', 'assign_check', 'batch_control', 'batch_phase', 'batch_tasks_add',
  'handoff_accept', 'handoff_submit', 'lane_checkpoint', 'lane_claim', 'lane_dispatch',
  'lane_release', 'lane_worktree_create', 'lane_worktree_merge', 'member_settle', 'member_set_status',
  'swarm_cc', 'swarm_report', 'task_update', 'wave_plan',
]);

// ── 派生面（**禁手抄**：一律从 suite.js 现场算）──────────────────────────────────────────
const WRITE_IN_REPO = Object.freeze(
  SUITE_TOOLS.filter((t) => t.write === true && !HOST_EXEMPT.includes(t.name)).map((t) => t.name).sort(),
);

// ── 真实 dispatch 床（宿主自身 API：真 cordis Context + 真 ToolRuntime）────────────────────
function runtimeWith(guardFn, toolNames) {
  const app = new Context();
  app.systemPrompt = { tools() {}, section() {} };
  const rt = new ToolRuntime(app, { mode: 'native', maxParallelSubCalls: 4 });
  const calls = new Map(toolNames.map((n) => [n, 0]));
  for (const name of toolNames) {
    rt.register({
      name,
      description: 'provenance probe: ' + name,
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [] },
      async execute() { calls.set(name, calls.get(name) + 1); return { ok: true, name }; },
    });
  }
  rt.guard((execution) => guardFn(execution));
  return { rt, calls };
}

let callSeq = 0;
async function dispatch(rt, calls, { name, args = {}, agent, callId }) {
  const before = calls.get(name) ?? 0;
  const out = await rt.execute({
    callId: callId ?? 'call-' + (callSeq += 1),
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  });
  return { executed: (calls.get(name) ?? 0) - before, out };
}

const realGuard = (execution) => writeProvenanceDecision(execution);

// ══ A. 集合式判据（用 properties.sourceRunId，禁数量断言）══════════════════════════════
test('A1 集合式：{t | t.write ∧ 本仓定义} ⊆ {t | parameters.properties 含 sourceRunId}（双向空集差）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-wp-a1-'));
  const store = createStore(root);
  const ctx = { tools: { register: () => {} }, logger: console };
  const made = createTools(ctx, { store, root, config: {} }).tools ?? [];
  assert.ok(made.length > 0, '前置：本仓工具注册面不得为空');

  const declared = new Set(
    made.filter((t) => t?.parameters?.properties && Object.prototype.hasOwnProperty.call(t.parameters.properties, 'sourceRunId')).map((t) => t.name),
  );

  const notDeclared = WRITE_IN_REPO.filter((n) => !declared.has(n));
  assert.deepEqual(notDeclared, [], '写族中缺 `parameters.properties.sourceRunId` 的工具（空集 = 声明层齐备）');
  const extra = [...declared].filter((n) => !WRITE_IN_REPO.includes(n)).sort();
  assert.deepEqual(extra, [], '声明了 sourceRunId 但不在写族（避免顺手声明到读工具上）');

  // 非必填：查 required **数组**（不是字段上的 required 键）
  const wronglyRequired = made
    .filter((t) => (t?.parameters?.required ?? []).includes('sourceRunId'))
    .map((t) => t.name);
  assert.deepEqual(wronglyRequired, [], 'sourceRunId 必须**非必填**（拒由执行层负责，不靠 schema 强制）');
});

test('A2 冻结基准对撞：派生集 ≡ EXPECTED_WRITE_FAMILY（19 名，集合式）', () => {
  assert.deepEqual([...WRITE_IN_REPO].sort(), [...EXPECTED_WRITE_FAMILY].sort(),
    '派生（suite.js 现场算）必须与测试侧手写基准逐名一致');
  // 派生 ≡ 生产侧 WRITE_FAMILY（同一口径的另一半：守卫实际判据域）
  assert.deepEqual([...WRITE_FAMILY].sort(), [...EXPECTED_WRITE_FAMILY].sort(),
    '守卫 WRITE_FAMILY 必须与基准逐名一致');
});

test('A3 基准注入可红：把已删名 `mailbox_send` 塞进基准 ⇒ 与派生集**不再相等**（对撞有杀伤力）', () => {
  const injected = [...EXPECTED_WRITE_FAMILY, 'mailbox_send'].sort();
  const diff = { 基准多出: injected.filter((n) => !WRITE_IN_REPO.includes(n)), 派生多出: WRITE_IN_REPO.filter((n) => !injected.includes(n)) };
  // 正向：注入后两侧差集**必非空**（= A2 会红）
  assert.notDeepEqual(injected, [...WRITE_IN_REPO].sort(), '注入已删名后必须与派生集不等（否则对撞形同虚设）');
  assert.deepEqual(diff.基准多出, ['mailbox_send'], '注入项必须出现在「基准多出」侧');
  assert.deepEqual(diff.派生多出, [], '派生侧不应有差（注入只加不减）');
  // 还原 ⇒ 再次相等（两态可复现）
  assert.deepEqual([...EXPECTED_WRITE_FAMILY].sort(), [...WRITE_IN_REPO].sort(), '还原基准后必须重新相等');
});

// ══ B. 行为面：19 件**逐件**两态（真实 dispatch，非抽样）══════════════════════════════════
test('B1 逐件两态：19 件「两源皆缺 ⇒ 拒（execute 未执行）」＋「L1 ⇒ 放行（execute 执行）」', async () => {
  const { rt, calls } = runtimeWith(realGuard, WRITE_IN_REPO);
  const rows = [];
  for (const name of WRITE_IN_REPO) {
    const denied = await dispatch(rt, calls, { name, args: {} });
    assert.equal(denied.executed, 0, name + '：缺两源 ⇒ execute **不得**执行');
    assert.equal(denied.out?.isError, true, name + '：结果必须 isError');
    assert.equal(denied.out?.error?.message, SOURCE_RUN_ID_MISSING + ' ' + name, name + '：拒因须指名');

    const allowed = await dispatch(rt, calls, { name, args: { sourceRunId: 'run-' + name } });
    assert.equal(allowed.executed, 1, name + '：给 L1 ⇒ execute 必须执行');
    assert.notEqual(allowed.out?.isError, true, name + '：给 L1 ⇒ 不得 isError');
    rows.push(name + ': denied>0/1 allowed>1/1');
  }
  assert.equal(rows.length, EXPECTED_WRITE_FAMILY.length, '逐件覆盖必须等于判据域（禁抽样）');
});

// ══ C. 豁免面：宿主 5 件不拦 ＋ 读工具不受影响 ═══════════════════════════════════════════
test('C1 宿主 5 件豁免：本仓 schema 命中 0 ＋ 真实 dispatch 两源皆缺仍放行', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-wp-c1-'));
  const store = createStore(root);
  const made = createTools({ tools: { register: () => {} }, logger: console }, { store, root, config: {} }).tools ?? [];
  const inRepo = made.filter((t) => HOST_EXEMPT.includes(t.name)).map((t) => t.name);
  assert.deepEqual(inRepo, [], '宿主 5 件不在本仓注册面（本仓 schema 命中 0）');

  const { rt, calls } = runtimeWith(realGuard, HOST_EXEMPT);
  for (const name of HOST_EXEMPT) {
    const r = await dispatch(rt, calls, { name, args: {} });
    assert.equal(r.executed, 1, name + '：宿主件不在判据域 ⇒ 不得拦（豁免 ≠ 放行语义，是不判）');
    assert.notEqual(r.out?.isError, true, name + '：不得 isError');
  }
});

test('C2 读工具不受影响：batch_status 两源皆缺仍放行（守卫只判写族）', async () => {
  const { rt, calls } = runtimeWith(realGuard, ['batch_status']);
  const r = await dispatch(rt, calls, { name: 'batch_status', args: { batchId: 'b-1' } });
  assert.equal(r.executed, 1, '读工具必须执行');
  assert.notEqual(r.out?.isError, true, '读工具不得被溯源守卫拦');
});

// ══ D. 无 L3（禁猜）：C-1/C-2/C-3 ＋ 唯一反例 C-4 ═══════════════════════════════════════
test('D1 无 L3：batchId/laneId 在场但两源皆缺 ⇒ 仍拒（禁从执行位置推导来源）', async () => {
  const { rt, calls } = runtimeWith(realGuard, ['wave_plan']);
  const r = await dispatch(rt, calls, { name: 'wave_plan', args: { batchId: 'b-1', laneId: 'l-1' } });
  assert.equal(r.executed, 0, 'C-4：batchId/laneId 不是来源证据 ⇒ execute 不得执行');
  assert.equal(r.out?.isError, true);
  assert.equal(r.out?.error?.message, SOURCE_RUN_ID_MISSING + ' wave_plan');
});

test('D2 L1 优先 与 L2 兜底：两者各自可放行（且 L1 存在时不依赖 agent）', async () => {
  const { rt, calls } = runtimeWith(realGuard, ['wave_plan']);
  const l1 = await dispatch(rt, calls, { name: 'wave_plan', args: { sourceRunId: 'run-1' } });
  assert.equal(l1.executed, 1, 'C-2：L1 ⇒ 放行');
  const l2 = await dispatch(rt, calls, { name: 'wave_plan', args: {}, agent: { session: { id: 'sess-1' } } });
  assert.equal(l2.executed, 1, 'C-3：L2（agent.session.id）⇒ 放行');
  const neither = await dispatch(rt, calls, { name: 'wave_plan', args: {}, agent: { session: {} } });
  assert.equal(neither.executed, 0, 'C-1：两源皆缺（agent.session.id 为空）⇒ 拒');
});

// ══ E. 运行期拒态形态（宿主消费侧，真 dispatch 取证 —— e2-guard 自报未验证的那条）══════════
test('E1 拒态形态：execute 未执行 ＋ isError ＋ error.message 含前缀 ＋ content[0].text 以 "Error: " 开头 ＋ **无 code**', async () => {
  const { rt, calls } = runtimeWith(realGuard, ['wave_plan']);
  const r = await dispatch(rt, calls, { name: 'wave_plan', args: {} });
  assert.equal(r.executed, 0, 'execute 必须**未被调用**（计数器证，不是推断）');
  assert.equal(r.out.isError, true, '宿主 post-result 必须 isError:true');
  assert.equal(r.out.error.message, SOURCE_RUN_ID_MISSING + ' wave_plan', 'error.message = 守卫返回串');
  assert.ok(r.out.error.message.startsWith('source-run-id-missing:'), '前缀必须逐字为 source-run-id-missing:');
  assert.equal(Array.isArray(r.out.content), true);
  assert.equal(r.out.content[0].text, 'Error: ' + SOURCE_RUN_ID_MISSING + ' wave_plan', 'content[0].text = "Error: " + 串');
  assert.equal(Object.prototype.hasOwnProperty.call(r.out.error, 'code'), false, 'error 上**不得有 code**（非 GATE_ 族）');
});

// ══ F. 每条判据的**可红形态**（变异守卫，同一真实 dispatch 床）════════════════════════════
//   纪律：不给 pass 之外的反向证据 = 判据没杀伤力。这里用「变异守卫 + 同一断言」证明会红。
const MUTANTS = {
  'M1 删 L1 检查（只认 agent.session.id）': (e) => (
    WRITE_FAMILY.includes(e?.name) && !(typeof e?.agent?.session?.id === 'string' && e.agent.session.id.length > 0)
      ? SOURCE_RUN_ID_MISSING + ' ' + e.name : undefined
  ),
  'M2 加 L3（从 batchId 猜来源）': (e) => (
    WRITE_FAMILY.includes(e?.name)
      && !(typeof e?.arguments?.sourceRunId === 'string' && e.arguments.sourceRunId.length > 0)
      && !(typeof e?.agent?.session?.id === 'string' && e.agent.session.id.length > 0)
      && !(typeof e?.arguments?.batchId === 'string' && e.arguments.batchId.length > 0)
      ? SOURCE_RUN_ID_MISSING + ' ' + e.name : undefined
  ),
  'M3 判据域过宽（连读工具/宿主件一起拦）': (e) => (
    typeof e?.name === 'string' && !(typeof e?.arguments?.sourceRunId === 'string' && e.arguments.sourceRunId.length > 0)
      ? SOURCE_RUN_ID_MISSING + ' ' + e.name : undefined
  ),
  'M4 静默放行（永远 undefined）': () => undefined,
};

/** 把一个「应当红」的断言包成可判读结果。 */
async function expectRed(fn) {
  try { await fn(); return false; } catch { return true; }
}

test('F1 可红形态 M1（删 L1 检查）⇒ B 组「L1 放行」与 D2 变红', async () => {
  const red = await expectRed(async () => {
    const { rt, calls } = runtimeWith(MUTANTS['M1 删 L1 检查（只认 agent.session.id）'], ['wave_plan']);
    const r = await dispatch(rt, calls, { name: 'wave_plan', args: { sourceRunId: 'run-1' } });
    assert.equal(r.executed, 1, 'L1 应放行');
  });
  assert.equal(red, true, 'M1 下「L1 放行」必须捕获为红');
});

test('F2 可红形态 M2（加 L3 猜来源）⇒ D1「无 L3」变红', async () => {
  const red = await expectRed(async () => {
    const { rt, calls } = runtimeWith(MUTANTS['M2 加 L3（从 batchId 猜来源）'], ['wave_plan']);
    const r = await dispatch(rt, calls, { name: 'wave_plan', args: { batchId: 'b-1', laneId: 'l-1' } });
    assert.equal(r.executed, 0, 'C-4 仍须拒');
  });
  assert.equal(red, true, 'M2 下「无 L3」必须捕获为红');
});

test('F3 可红形态 M3（判据域过宽）⇒ C1/C2「豁免面」变红', async () => {
  const red = await expectRed(async () => {
    const { rt, calls } = runtimeWith(MUTANTS['M3 判据域过宽（连读工具/宿主件一起拦）'], [...HOST_EXEMPT, 'batch_status']);
    const r = await dispatch(rt, calls, { name: 'batch_status', args: {} });
    assert.equal(r.executed, 1, '读工具不得被拦');
  });
  assert.equal(red, true, 'M3 下「读工具不受影响」必须捕获为红');
});

test('F4 可红形态 M4（静默放行）⇒ A/B/D/E 全组变红（至少 E1 形态必须红）', async () => {
  const red = await expectRed(async () => {
    const { rt, calls } = runtimeWith(MUTANTS['M4 静默放行（永远 undefined）'], ['wave_plan']);
    const r = await dispatch(rt, calls, { name: 'wave_plan', args: {} });
    assert.equal(r.out?.isError, true, '缺两源必须 isError');
  });
  assert.equal(red, true, 'M4 下「缺即拒」必须捕获为红');
});

// ══ G. 安装面（幂等 + 无 tools.guard 静默不注册）══════════════════════════════════════════
test('G1 installWriteProvenanceGuard：首次 true、二次 false（幂等）；ctx 无 tools.guard ⇒ false', () => {
  const registered = [];
  const ctx = { tools: { guard: (fn) => { registered.push(fn); } } };
  assert.equal(installWriteProvenanceGuard(ctx), true, '首次注册应成功');
  assert.equal(installWriteProvenanceGuard(ctx), false, '二次调用应幂等返回 false');
  assert.equal(registered.length, 1, '只注册一次');
  assert.equal(installWriteProvenanceGuard({ tools: {} }), false, '无 tools.guard ⇒ 静默不注册');
});
