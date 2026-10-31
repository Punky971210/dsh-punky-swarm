/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/dispatch-form-pairing.test.js —— **S-3 回归的另一半**：`start` ／ `activation` 两支**成对**覆盖。
//
// 背景（`e1` 主动登记的未覆盖）：乙把入口选择改成 `if (agentPort.form === 'activation') spawn : rt.start`。
//   `test/engine-dispatch.test.js` 里 **`activation` 出现 0 次** ⇒ 该二分只有 `start` 支被行为覆盖；
//   若 `spawn` 分支被改坏（例如它对 `toolFace` 产生副作用），**没有任何用例会发现**。
//
// 本文件钉三件事（成对）：
//   ① `activation` 形态**走 `spawn`**（⇒ 调 `startActivation(spec)`），**不走 `rt.start`**；
//   ② `toolFace` 在 activation 分支**未被消费**：`spec.request` **不含** `toolFilter`/`persona`，只带 `agentPreset`；
//      且「传了 `toolFace` 也不改变合成结果」「未传也不报错」两态都成立；
//   ③ 与 `start` 形态**成对**：同一引擎在 start 宿主上 ⇒ 捕获的 `request` **含** `toolFilter.deny`（这才是 S-3 修的 B2）。
//
// 跑法（必须带 preload）：node --import ./test/helpers/isolated-home.preload.mjs --test test/dispatch-form-pairing.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { createCoreTools } from '../lib/tools/core.js';
import { tempRoot } from './helpers/gate-fixture.mjs';

const PRESET = 'punkynarrow';

function seed(lane = 'l1') {
  const root = tempRoot('punky-t1-form-');
  const store = createStore(root);
  const sess = 'sess-f';
  const batchId = 'b-f';
  store.createBatch(sess, {
    batchId,
    wavePlan: buildWavePlan({
      batchId,
      tasks: [
        { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], outputs: ['plan/spec.md'] },
        { id: lane, layer: 'exec', role: 'coder', consume: ['plan/spec.md'], produce: ['exec/x.md'], outputs: ['exec/x.md'], deps: ['p1'] },
        { id: 'a1', layer: 'audit', consume: ['plan/spec.md', 'exec/x.md'], produce: ['audit/a1.md'], outputs: ['audit/a1.md'], deps: [lane] },
      ],
    }),
    assembly: { auditLane: 'a1', managerPlan: 'leader-direct' },
  });
  // 成员写面档位判据落在**调用方会话** ⇒ 必须先写 C 档治理记录（否则先撞 GATE_MEMBER_REQUIRES_C）
  store.writeGovernance(sess, { lastAssign: { form: 'C', difficulty: 'C', rationale: 'S-3 形态成对覆盖夹具（C 档派发）', at: new Date().toISOString() } });
  const dir = path.join(root, 'sessions', sess, 'artifacts', batchId);
  fs.mkdirSync(path.join(dir, 'plan'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plan', 'spec.md'), '# 规格夹具\n', 'utf8');
  return { root, store, sess, batchId, lane };
}

/** start 形态宿主：`rt.start(provider, request)`，其余能力缺省。 */
function startHost(capturedRef) {
  return {
    start: async (provider, request) => {
      capturedRef.push({ provider, request });
      return { id: 'ws-start', result: Promise.resolve({ output: [], stopReason: 'completed' }) };
    },
  };
}

/** activation 形态宿主：只有 `startActivation(spec)`；**故意不提供 `start`** ⇒ 走错入口就会失败。 */
function activationHost(capturedRef) {
  return {
    startActivation: async (spec) => {
      capturedRef.push({ spec });
      return { id: 'ws-act', result: Promise.resolve({ output: [], stopReason: 'completed' }) };
    },
  };
}

async function dispatchWith(kind, cfg = {}) {
  const { root, store, sess, batchId, lane } = seed();
  const captured = [];
  const host = kind === 'activation' ? activationHost(captured) : startHost(captured);
  const ctx = { on: () => () => {}, tools: { register() {} }, logger: { info() {}, warn() {}, error() {}, debug() {} }, subagents: host };
  const tools = createCoreTools(ctx, { store, root, config: { dispatch: { provider: 'spawn-in-process', ...cfg } } });
  const ld = tools.find((t) => t.name === 'lane_dispatch');
  let result = null;
  let error = null;
  try {
    result = await ld.execute({ batchId, lane, prompt: '要点：先读规格' }, { agent: { session: { id: sess } } });
  } catch (e) { error = e; }
  return { captured, result, error, store, sess, batchId, lane };
}

test('S-3a activation 形态：**走 spawn → startActivation(spec)**，且 `spec.request` 不含 toolFilter/persona、只带 agentPreset', async () => {
  const { captured, result, error } = await dispatchWith('activation', { agentPreset: PRESET });
  assert.equal(error, null, 'activation + 已配置 agentPreset ⇒ 不得拒派；错误=' + String(error?.message ?? ''));
  assert.equal(result?.spawned, true, '必须真的派发（spawned:true）');
  assert.equal(captured.length, 1, '必须恰好调用一次宿主入口；实际=' + captured.length);
  const spec = captured[0].spec;
  assert.ok(spec, '必须走 **startActivation(spec)**（而不是 rt.start）—— 该宿主根本没有 start');
  const req = spec.request;
  assert.equal(req?.agentPreset, PRESET, 'agentPreset 必须来自 config.dispatch.agentPreset；实际=' + JSON.stringify(req?.agentPreset));
  assert.equal('toolFilter' in (req ?? {}), false, 'activation 分支**不得**合成 toolFilter（宿主 schema 无此字段）');
  assert.equal('persona' in (req ?? {}), false, 'activation 分支**不得**合成 persona');
});

test('S-3b `toolFace` 在 activation 分支**未被消费**：传与不传 ⇒ 合成结果同形（且都不报错）', async () => {
  const a = await dispatchWith('activation', { agentPreset: PRESET });
  const b = await dispatchWith('activation', { agentPreset: PRESET, roleToolFace: { deny: ['x'] } });
  const reqOf = (r) => JSON.stringify(Object.keys(r.captured[0].spec.request).sort());
  assert.equal(a.error, null, '未传 toolFace ⇒ 不得报错');
  assert.equal(b.error, null, '传 toolFace ⇒ 也不得报错（activation 分支不读它）');
  assert.equal(reqOf(a), reqOf(b), '传与不传 `toolFace` 的 `spec.request` **键集必须相同**（该分支不消费它）');
  for (const r of [a, b]) {
    assert.equal('toolFilter' in r.captured[0].spec.request, false, '两种情况都不得出现 toolFilter');
  }
});

test('S-3c **成对证明**：同一引擎在 start 宿主上 ⇒ 捕获的 `request` **含** `toolFilter.deny`（B2 按次收窄）', async () => {
  const ref = [];
  const { captured, result, error } = await dispatchWith('start', {});
  assert.equal(error, null, 'start 宿主 + 无 agentPreset ⇒ 走 rt.start，不得拒派；错误=' + String(error?.message ?? ''));
  assert.equal(result?.spawned, true, '必须真的派发');
  assert.equal(captured.length, 1, 'start 形态必须恰调一次 rt.start');
  const req = captured[0].request;
  assert.ok(req?.toolFilter?.deny, 'start 形态的 request 必须带 `toolFilter.deny`（B2：按次收窄）');
  assert.equal(Array.isArray(req.toolFilter.deny), true, 'toolFilter.deny 必须是数组');
  assert.equal(req.toolFilter.deny.includes('wave_plan'), true,
    '冻结集成员 `wave_plan` 必须在 deny 内；实际=' + JSON.stringify(req.toolFilter.deny));
  // 与 activation 成对：这支有 toolFilter，activation 那支没有 —— 二分语义因此可辨
  assert.equal('agentPreset' in (req ?? {}), false, 'start 形态**不得**出现 agentPreset（那是 activation 的收窄通道）');
});

test('S-3d 能力位门仍在：activation 宿主 **未配置** agentPreset ⇒ 拒派（GATE_DISPATCH_CAPABILITY_MISSING，打在状态变更之前）', async () => {
  const { captured, result, error } = await dispatchWith('activation', {});
  assert.ok(error, '未配置 agentPreset ⇒ 必须拒派（否则 worker 拿到未收窄工具面）');
  assert.match(String(error.message), /GATE_DISPATCH_CAPABILITY_MISSING/, '拒因须为该码；实际=' + String(error.message).slice(0, 160));
  assert.equal(captured.length, 0, '拒派必须打在宿主调用之前（零宿主调用）');
  assert.equal(result, null, '拒派不返回成功结果');
});
