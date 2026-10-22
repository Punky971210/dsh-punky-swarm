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

// F1 修复批次 `punky-fix-f1-20261022` · lane `e3-tester` · 缺陷 **A1-P1-01**（探针三态 + 前置 fail-closed 拒派）。
//
// 判据源：`plan/fix-spec.md`（含文末「后期订正 1」——订正优先）：
//   ① 探针单点 `subagentRuntimeProbeOf(ctx)` → `{ rt, form, reason }`，三态 + `runtime-unavailable`；
//   ② `{ startActivation }` 形态 ⇒ **不实现调用**，改为**前置 fail-closed 拒派**
//      （复用既有 `GATE_DISPATCH_CAPABILITY_MISSING`，打在 `setMember(running)` 与句柄发放**之前**）
//      ⇒ 三零：lane 仍 pending / 零句柄 / 零 `member.dispatch` 事件；
//   ③ `{ start }` 旧形态逐字保留（`rt.start(provider, request)` 两参）；
//   ④ 两形态皆无 ⇒ 降级「仅发句柄」，文案按真实成因分档（**不得**再出现「宿主未提供」反向归因）。
//
// 纪律：每条阴性断言都配**同输入阳性对照**（同一夹具换 runtime 形态），防恒真断言。
// RED 证据（原实现的可复现缺陷）见 `exec/test-report.md` §T-1——用 `git show HEAD:…dispatch.js` 的旧模块对照，
// 不改仓库文件做对照。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { createCoreTools } from '../lib/tools/core.js';
import { EVT_MEMBER_DISPATCH } from '../lib/state/event-types.js';
import { __resetLaneHandles, pendingHandles } from '../lib/bridge/lane-handle.js';
import { subagentRuntimeOf, subagentRuntimeProbeOf, buildStartRequest } from '../lib/engine/dispatch.js';
import { tempRoot } from './helpers/gate-fixture.mjs';

function mkCtx(runtime) {
  const calls = { info: [], warn: [], error: [] };
  const ctx = {
    on() { return () => {}; },
    tools: { register() {} },
    logger: {
      info: (...a) => calls.info.push(a.join(' ')),
      warn: (...a) => calls.warn.push(a.join(' ')),
      error: (...a) => calls.error.push(a.join(' ')),
    },
    calls,
  };
  if (runtime) ctx.subagents = runtime;
  return ctx;
}

// 注入守卫形态（cordis 对未声明服务取属性**直接抛**）——`get` 抛错的 subagents。
function throwingSubagentsCtx() {
  const ctx = mkCtx(null);
  Object.defineProperty(ctx, 'subagents', {
    configurable: true,
    get() { throw new Error('cannot get property "subagents" without inject'); },
  });
  return ctx;
}

function seedBatch(root, sessionId, batchId, laneId = 'l1') {
  const store = createStore(root);
  const artRoot = path.join(root, 'sessions', sessionId, 'artifacts', batchId);
  fs.mkdirSync(path.join(artRoot, 'plan'), { recursive: true });
  fs.writeFileSync(path.join(artRoot, 'plan', 'spec.md'), '# 规格夹具\n', 'utf8');
  store.createBatch(sessionId, {
    batchId,
    wavePlan: buildWavePlan({
      batchId,
      tasks: [
        { id: 'p1', cmd: 'plan 规格（夹具）', layer: 'plan', role: 'coordinator', produce: ['plan/spec.md'], outputs: ['plan/spec.md'] },
        { id: laneId, cmd: '实现 X', layer: 'exec', role: 'coder', deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/' + laneId + '/outputs/x.md'] },
        { id: 'a-' + laneId, cmd: '按验收标准逐条核对', layer: 'audit', role: 'supervisor', deps: [laneId], consume: ['plan/spec.md'] },
      ],
    }),
    phase: 'running',
  });
  store.writeGovernance(sessionId, {
    lastAssign: { difficulty: 'C', form: 'C', scope: 'full', rationale: 'fixture：引擎自派前置评估（三层批 ⇒ C）', reasons: [], at: new Date().toISOString(), execCallsSince: 0 },
  });
  return store;
}

function laneToolOf(ctx, store, root, config) {
  const tools = createCoreTools(ctx, { store, root, config });
  const ld = tools.find((t) => t.name === 'lane_dispatch');
  assert.ok(ld, 'lane_dispatch 已注册');
  return ld;
}

const execOf = (sessionId) => ({ agent: { session: { id: sessionId } } });
const eventsOf = (store, sessionId, batchId) => store.readBatch(sessionId, batchId).events;
const dispatchesOf = (store, sessionId, batchId) =>
  eventsOf(store, sessionId, batchId).filter((e) => e.type === EVT_MEMBER_DISPATCH);
const handlesOf = (batchId, lane) => pendingHandles().filter((h) => h.batchId === batchId && h.lane === lane);

// ── T-1.1 `{ startActivation }` ⇒ 前置 fail-closed 拒派 + 三零（RED→GREEN 的 GREEN 面） ──
test('T-1.1 A1-P1-01 新形态 {startActivation} ⇒ 拒派 GATE_DISPATCH_CAPABILITY_MISSING，且三零（lane 未变/零句柄/零事件）', async () => {
  __resetLaneHandles();
  const root = tempRoot('punky-f1t1a-');
  const store = seedBatch(root, 'sess-f1a', 'b-f1a');
  let activationCalls = 0;
  const ctx = mkCtx({
    startActivation: async () => { activationCalls += 1; return { childId: 'child-A', result: Promise.resolve({}) }; },
  });
  const ld = laneToolOf(ctx, store, root, { dispatch: { provider: 'spawn' } });
  await assert.rejects(
    () => ld.execute({ batchId: 'b-f1a', lane: 'l1' }, execOf('sess-f1a')),
    (err) => {
      assert.match(String(err?.message), /GATE_DISPATCH_CAPABILITY_MISSING/, '拒派码复用既有码（零新造）');
      // 订正 1 要求三段可读：① 新形态不承载 toolFilter/persona ② 不以弱换强 ③ Agent Preset 迁移（F4）
      assert.match(String(err?.message), /startActivation/, '① 点明新形态入口名');
      assert.match(String(err?.message), /toolFilter/, '① 点明不被承载的收窄面 toolFilter');
      assert.match(String(err?.message), /不以弱换强/, '② 点明拒派判据');
      assert.match(String(err?.message), /Agent Preset/, '③ 点明迁移承载方（单开批 F4）');
      return true;
    },
  );
  assert.equal(activationCalls, 0, '订正 1：**不得实现** startActivation 调用（死代码防护）');
  // 三零（拒派必须打在状态变更之前）
  assert.equal(store.readBatch('sess-f1a', 'b-f1a').lanes.l1, 'pending', '① lane 状态未变（仍 pending）');
  assert.deepEqual(handlesOf('b-f1a', 'l1'), [], '② 未发放句柄（pendingHandles 无该 lane）');
  assert.equal(dispatchesOf(store, 'sess-f1a', 'b-f1a').length, 0, '③ 事件流无 member.dispatch');
  assert.equal(store.readBatch('sess-f1a', 'b-f1a').phase, 'running', '批相位不变');
  __resetLaneHandles();
});

// 阳性对照（同输入换 runtime 形态）：`{ start }` ⇒ 同一批同一 lane 自派成功 ⇒ 证明上面的「拒派」不是夹具恒拒。
test('T-1.2 A1-P1-01 阳性对照 {start} 旧形态 ⇒ 自派成功（spawned:true）+ 旧签名两参逐字保留', async () => {
  __resetLaneHandles();
  const root = tempRoot('punky-f1t1b-');
  const store = seedBatch(root, 'sess-f1b', 'b-f1b');
  let captured = null;
  const ctx = mkCtx({
    start: async (provider, request) => {
      captured = { provider, request };
      return { id: 'child-B', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose() {} };
    },
  });
  const ld = laneToolOf(ctx, store, root, { dispatch: { provider: 'spawn' } });
  const exec = execOf('sess-f1b');
  const r = await ld.execute({ batchId: 'b-f1b', lane: 'l1' }, exec);
  assert.equal(r.spawned, true, '旧形态必须仍自派成功（行为等价，不替换）');
  assert.equal(r.workerSessionId, 'child-B');
  assert.equal(r.spawnNote, undefined, '成功路径无降级文案');
  assert.ok(captured, '桩被调用');
  assert.equal(captured.provider, 'spawn', '第 1 参 = provider 字符串');
  assert.equal(typeof captured.request, 'object');
  assert.equal(captured.request.label, 'punky-swarm:b-f1b:l1', '第 2 参含 label');
  assert.ok(captured.request.signal && typeof captured.request.signal.throwIfAborted === 'function', '第 2 参含可用 signal');
  assert.ok(Array.isArray(captured.request.toolFilter?.deny) && captured.request.toolFilter.deny.length > 0, '第 2 参含 toolFilter.deny（按次收窄）');
  assert.equal(captured.request.parent, exec.agent, 'parent = 活体父 agent');
  assert.equal(dispatchesOf(store, 'sess-f1b', 'b-f1b').length, 1, '成功后写 1 条 member.dispatch（唯一写路径）');
  assert.equal(ctx.calls.warn.filter((w) => w.includes('回落')).length, 0, '归一化缺口告警零条（id 主字段在位）');
  assert.equal(handlesOf('b-f1b', 'l1').length, 0, '成功后句柄被消费');
  __resetLaneHandles();
});

// ── T-1.3 两形态皆无（{} / {startContinuable}）⇒ 降级「仅发句柄」+ 文案分档 ──
test('T-1.3 A1-P1-01 form=null（{} 与 {startContinuable}）⇒ spawned:false + 文案含「不含可用启动入口」/startActivation/start，不含「宿主未提供」；句柄未消费、lane 仍 running', async () => {
  for (const [label, runtime] of [['空服务 {}', {}], ['历史桩 {startContinuable}', { startContinuable: async () => ({}) }]]) {
    __resetLaneHandles();
    const root = tempRoot('punky-f1t1c-');
    const batchId = label === '空服务 {}' ? 'b-f1c1' : 'b-f1c2';
    const store = seedBatch(root, 'sess-f1c', batchId);
    const ctx = mkCtx(runtime);
    const ld = laneToolOf(ctx, store, root, { dispatch: { provider: 'spawn' } });
    const r = await ld.execute({ batchId, lane: 'l1' }, execOf('sess-f1c'));
    assert.equal(r.spawned, false, label + '：无可用启动入口 ⇒ 仅发句柄');
    const note = String(r.spawnNote ?? '');
    assert.ok(note.includes('不含可用启动入口'), label + '：文案须含「不含可用启动入口」；实际=' + note);
    assert.ok(note.includes('startActivation'), label + '：文案须含 startActivation');
    assert.ok(note.includes('start'), label + '：文案须含 start');
    assert.equal(note.includes('宿主未提供'), false, label + '：**禁**反向归因「宿主未提供」');
    assert.ok(r.firstLine && r.firstLine.startsWith('[swarm-lane:' + batchId + '/l1#'), label + '：句柄照常发放');
    assert.equal(handlesOf(batchId, 'l1').length, 1, label + '：句柄**未消费**（仍可直派）');
    assert.equal(store.readBatch('sess-f1c', batchId).lanes.l1, 'running', label + '：lane 已置 running（既有降级语义逐字保留）');
    assert.equal(dispatchesOf(store, 'sess-f1c', batchId).length, 0, label + '：未自派 ⇒ 零登记');
    __resetLaneHandles();
  }
});

// ── T-1.4 C′ `ctx.subagents` 取值抛错 ⇒ runtime-unavailable 档（不崩、文案可辨） ──
test('T-1.4 A1-P1-01 C′ subagents 取值抛错 ⇒ spawned:false + 文案含「ctx.subagents 不可取」/「未注入」，不含「宿主未提供」，且不抛错', async () => {
  __resetLaneHandles();
  const root = tempRoot('punky-f1t1d-');
  const store = seedBatch(root, 'sess-f1d', 'b-f1d');
  const ctx = throwingSubagentsCtx();
  const ld = laneToolOf(ctx, store, root, { dispatch: { provider: 'spawn' } });
  const r = await ld.execute({ batchId: 'b-f1d', lane: 'l1' }, execOf('sess-f1d'));
  assert.equal(r.spawned, false, '未注入 ⇒ 降级（不抛原始 cordis 错）');
  const note = String(r.spawnNote ?? '');
  assert.ok(note.includes('ctx.subagents 不可取'), '文案须含「ctx.subagents 不可取」；实际=' + note);
  assert.ok(note.includes('未注入'), '文案须含「未注入」');
  assert.equal(note.includes('宿主未提供'), false, '**禁**反向归因');
  assert.equal(handlesOf('b-f1d', 'l1').length, 1, '句柄未消费');
  __resetLaneHandles();
});

// ── T-1.5 三档文案互不相同（同输入阳性对照：只换 runtime 形态，文案必须变） ──
test('T-1.5 A1-P1-01 三档降级文案互不相同（runtime-unavailable / no-start-entry / provider 未配逐字既有）', async () => {
  async function noteOf(runtime, config) {
    __resetLaneHandles();
    const root = tempRoot('punky-f1t1e-');
    const store = seedBatch(root, 'sess-f1e', 'b-f1e');
    const ctx = mkCtx(runtime);
    const ld = laneToolOf(ctx, store, root, config);
    const r = await ld.execute({ batchId: 'b-f1e', lane: 'l1' }, execOf('sess-f1e'));
    __resetLaneHandles();
    return String(r.spawnNote ?? '');
  }
  const runtimeUnavailable = await noteOf(undefined, { dispatch: { provider: 'spawn' } });
  const noStartEntry = await noteOf({}, { dispatch: { provider: 'spawn' } });
  const providerMissing = await noteOf({ start: async () => ({ id: 'x', result: Promise.resolve({}) }) }, {});
  assert.notEqual(runtimeUnavailable, noStartEntry, '两档成因文案必须可辨（不得合并为一句）');
  // 第三档「provider 未配」既有文案**逐字不改**（规格 §方案 降级文案对照表末行）
  assert.equal(providerMissing,
    '未配置 config.dispatch.provider ⇒ 仅发句柄（补配置后重派，或用 firstLine 直派）',
    'provider 未配档逐字既有（本批零改写）');
  assert.equal(runtimeUnavailable.includes('宿主未提供'), false);
  assert.equal(noStartEntry.includes('宿主未提供'), false);
});

// ── T-1.6 探针单测：三态 + runtime-unavailable（判定序只在一处） ──
test('T-1.6 A1-P1-01 subagentRuntimeProbeOf 三态 + runtime-unavailable；subagentRuntimeOf 为同源薄壳', () => {
  const activationRt = { startActivation() {} };
  const startRt = { start() {} };
  const continuableRt = { startContinuable() {} };

  const pa = subagentRuntimeProbeOf({ subagents: activationRt });
  assert.equal(pa.form, 'activation', '{startActivation} ⇒ activation 形态');
  assert.equal(pa.reason, null);
  assert.equal(pa.rt, null, 'activation 形态不给出可调用句柄（防按 rt 真值误判「可派」）');

  const ps = subagentRuntimeProbeOf({ subagents: startRt });
  assert.equal(ps.form, 'start');
  assert.equal(ps.reason, null);
  assert.equal(ps.rt, startRt, 'start 形态原样返回服务对象');

  const pn = subagentRuntimeProbeOf({ subagents: {} });
  assert.equal(pn.form, null);
  assert.equal(pn.reason, 'no-start-entry');
  assert.equal(pn.rt, null);

  const pc = subagentRuntimeProbeOf({ subagents: continuableRt });
  assert.equal(pc.form, null, '{startContinuable} 历史桩**不得**被误判为 activation');
  assert.equal(pc.reason, 'no-start-entry');

  // runtime-unavailable：三种取值形态（缺键 / null / 取值抛错）
  assert.deepEqual(subagentRuntimeProbeOf({}), { rt: null, form: null, reason: 'runtime-unavailable' });
  assert.deepEqual(subagentRuntimeProbeOf({ subagents: null }), { rt: null, form: null, reason: 'runtime-unavailable' });
  assert.deepEqual(subagentRuntimeProbeOf(throwingSubagentsCtx()), { rt: null, form: null, reason: 'runtime-unavailable' });

  // 薄壳同源：对每种形态，subagentRuntimeOf === probe.rt（不得出现第二套判据）
  for (const ctx of [{ subagents: activationRt }, { subagents: startRt }, { subagents: {} }, { subagents: continuableRt }, {}, throwingSubagentsCtx()]) {
    assert.equal(subagentRuntimeOf(ctx), subagentRuntimeProbeOf(ctx).rt);
  }
});

// ── T-1.7 载荷契约（探针不改变 buildStartRequest 的按次收窄面）：阳性对照锚 ──
test('T-1.7 A1-P1-01 buildStartRequest 契约未被本批削弱（signal 可 throwIfAborted + toolFilter.deny 非空 + label）', () => {
  const request = buildStartRequest({ batchId: 'b-x', lane: 'l1', parent: { id: 'a' }, prompt: 't' });
  assert.equal(request.label, 'punky-swarm:b-x:l1');
  assert.ok(Array.isArray(request.toolFilter.deny) && request.toolFilter.deny.length > 0);
  assert.equal(typeof request.signal.throwIfAborted, 'function');
  assert.equal(request.maxDepth, 1);
});
