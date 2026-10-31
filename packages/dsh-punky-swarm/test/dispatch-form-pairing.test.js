/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/dispatch-form-pairing.test.js —— **S-3 回归的另一半**：`start` ／ `activation` 两支**成对**覆盖。
//
// 背景（`e1` 主动登记的未覆盖）：入口选择曾写成 `if (agentPort.form === 'activation') spawn : rt.start`。
// 【P0-3 门禁解冻 · 批 `punky-adapter-p0-20261031`】入口选择按 J6-e 归 **provider**（端口内部分派），
//   引擎只读**功能面读数** ⇒ 本文件的断言对象不再含 `agentPort.form`，也不点名宿主入口。
//   `test/engine-dispatch.test.js` 里 `activation` 出现 0 次 ⇒ 该二分只有 `start` 支被行为覆盖，
//   故本文件保留「成对覆盖」的职责。
//
// 本文件钉三件事（成对）：
//   ① activation 宿主：统一派发入口成功后，宿主侧 activation 入口被调用**恰 1 次**，
//      且 `spec.request` 只带 `agentPreset`（宿主 schema 无 `toolFilter`/`persona` 字段）；
//   ② **收窄通道必须被消费**：`toolFace`（经 `denyTools` 通道）与 preset 覆盖声明的关系**必须改变判定结果**
//      —— 交集为空 ⇒ 放行；有交集 ⇒ 拒派。原「传与不传同形」断言的**方向已反转**（见 S-3b），
//      因为「不消费 toolFace」正是 p0-6 F-3 的缺陷，不是预期行为；
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

test('S-3a activation 宿主：统一派发入口成功（宿主 activation 入口恰 1 次），且 `spec.request` 只带 agentPreset', async () => {
  // 【P0-3 解冻】原断言把「配了个 `agentPreset` 字符串」当成放行充分条件。真读数口径（p0-6 D-1/D-2）
  //   要求**收窄见证**：`presetCoverage[presetId].tools` 声明该 preset 实际拿到的工具面。
  //   ⇒ 夹具补 `presetCoverage` 使「见证齐备才放行」成立（今日实现忽略该键 ⇒ 仍绿；修复后见证齐备 ⇒ 仍绿）。
  const { captured, result, error } = await dispatchWith('activation', {
    agentPreset: PRESET,
    presetCoverage: { [PRESET]: { tools: [] } }, // 覆盖为空集 ⇒ 与任何 deny 列表交集为空 ⇒ 收窄成立
  });
  assert.equal(error, null, 'activation + 见证齐备 ⇒ 不得拒派；错误=' + String(error?.message ?? ''));
  assert.equal(result?.spawned, true, '必须真的派发（spawned:true）');
  assert.equal(captured.length, 1, '必须恰好调用一次宿主入口；实际=' + captured.length);
  const spec = captured[0].spec;
  assert.ok(spec, '宿主侧 activation 入口必须收到 spec（该夹具宿主只有 activation 入口）');
  const req = spec.request;
  assert.equal(req?.agentPreset, PRESET, 'agentPreset 必须来自 config.dispatch.agentPreset；实际=' + JSON.stringify(req?.agentPreset));
  assert.equal('toolFilter' in (req ?? {}), false, 'activation 分支**不得**合成 toolFilter（宿主 schema 无此字段）');
  assert.equal('persona' in (req ?? {}), false, 'activation 分支**不得**合成 persona');
});

// ── S-3a-R（P0-3 前向登记 · **当前预期红**）裸 preset 字符串无见证 ⇒ 必须拒派 ─────────────────
//   真读数（p0-6 D-2 W-2）：「配了 preset id」≠「该 preset 收窄了本次工具面」——id 不含工具面内容，
//   必须有独立覆盖声明（`presetCoverage`）才可判。⇒ 只配 id 不配覆盖 = **无见证** ⇒ 拒派（不以弱换强）。
//   今日实现只看 id 是否存在 ⇒ 放行 ⇒ 本用例红；故挂 `{ todo }`：修好后删掉 todo 转正式用例。
test('S-3a-R（TODO · 预期红）activation + 裸 agentPreset（无 presetCoverage 见证）⇒ 必须拒派',
  { todo: 'P0-3 登记：真读数要求收窄见证（p0-6 D-2 W-2）；当前实现只看 preset id 存在 ⇒ 预期红' },
  async () => {
    const { result, error } = await dispatchWith('activation', { agentPreset: PRESET });
    assert.ok(error, '无见证必须拒派（不得放行）；实际 spawned=' + String(result?.spawned));
    assert.match(String(error?.message), /GATE_DISPATCH_CAPABILITY_/, '拒派须属能力位不可用族；实际=' + String(error?.message));
  });

// ── S-3b（P0-3 方向反转 + 前向登记 · **当前预期红**）`toolFace` 必须被消费 ────────────────────
//   【原断言方向已反转】原文断言「传与不传 `toolFace` ⇒ 合成结果**同形**」= 把 p0-6 **F-3**
//   （activation 分支 `spawn(...)` 实参无 `toolFace` ⇒ 收窄通道整键丢失）**冻结成了预期行为**。
//   且原实现用 `config.dispatch.roleToolFace` 造差分 —— 该键在 `lib/**` **零消费**（grep 实测 = 0），
//   所以「同形」是**恒真**、无判别力（弱证明）。⇒ 本条按 p0-6 处方重写：
//   ① 删除 `roleToolFace`；② 改用**真实通道**（`denyTools` × `presetCoverage`）；
//   ③ 断言「`toolFace` 与覆盖声明的关系**改变判定结果**」（交集为空 ⇒ 放行；有交集 ⇒ 拒派）。
//   今日实现无视 `presetCoverage` ⇒ 两态都放行 ⇒ 本条红；修好后转绿（删掉 todo 即成正式用例）。
test('S-3b（TODO · 预期红）`toolFace` 必须被消费：覆盖与 deny 交集为空 ⇒ 放行；有交集 ⇒ 拒派',
  { todo: 'P0-3/P0-6 登记：真读数要求 activation 分支消费 toolFace 并按 presetCoverage 核对见证；当前实现整键丢失 ⇒ 预期红' },
  async () => {
    // 交集为空：preset 覆盖不含任何工具面 ⇒ 本次 deny 集必不被其覆盖 ⇒ 收窄成立 ⇒ 放行
    const disjoint = await dispatchWith('activation', {
      agentPreset: PRESET,
      presetCoverage: { [PRESET]: { tools: [] } },
    });
    assert.equal(disjoint.error, null, '交集为空 ⇒ 不得拒派；错误=' + String(disjoint.error?.message ?? ''));
    assert.equal(disjoint.result?.spawned, true, '交集为空 ⇒ 必须真的派发');

    // 有交集：`wave_plan` 在本次 deny 集内（见 S-3c 的冻结集断言），且被声明为 preset 覆盖 ⇒ 收窄不成立 ⇒ 拒派
    const overlapping = await dispatchWith('activation', {
      agentPreset: PRESET,
      presetCoverage: { [PRESET]: { tools: ['wave_plan'] } },
    });
    assert.ok(overlapping.error, '交集非空 ⇒ 必须拒派（该 preset 实际拿到了本次要禁的工具）；实际 spawned='
      + String(overlapping.result?.spawned));
    assert.match(String(overlapping.error?.message), /GATE_DISPATCH_CAPABILITY_/,
      '拒派须属能力位不可用族；实际=' + String(overlapping.error?.message));
    assert.equal(overlapping.store.readBatch(overlapping.sess, overlapping.batchId).lanes.l1, 'pending',
      '拒派须打在状态变更之前（lane 仍 pending，零状态变更）');
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

test('S-3d 能力位门仍在：activation 宿主 **未配置** agentPreset ⇒ 拒派（能力位不可用族，打在状态变更之前）', async () => {
  const { captured, result, error } = await dispatchWith('activation', {});
  assert.ok(error, '未配置 agentPreset ⇒ 必须拒派（否则 worker 拿到未收窄工具面）');
  // 【P0-3 解冻】原断言钉死码名 `..._MISSING`；码名批会改成 `..._UNAVAILABLE`（criteria-v4 M-5）
  //   ⇒ 改为**码族**匹配，跨改名窗口保持有效（单码名收紧留给码名批落地后的清理）。
  assert.match(String(error.message), /GATE_DISPATCH_CAPABILITY_(MISSING|UNAVAILABLE)/,
    '拒因须属「能力位不可用」族；实际=' + String(error.message).slice(0, 160));
  assert.equal(captured.length, 0, '拒派必须打在宿主调用之前（零宿主调用）');
  assert.equal(result, null, '拒派不返回成功结果');
});
