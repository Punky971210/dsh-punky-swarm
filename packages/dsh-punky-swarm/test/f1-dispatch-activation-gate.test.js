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
//      （W4 `codename` 改名后的 `GATE_DISPATCH_CAPABILITY_UNAVAILABLE`，打在 `setMember(running)` 与句柄发放**之前**）
//      ⇒ 三零：lane 仍 pending / 零句柄 / 零 `member.dispatch` 事件；
//   ③ `{ start }` 旧形态逐字保留（`rt.start(provider, request)` 两参）；
//   ④ 两形态皆无 ⇒ 降级「仅发句柄」，文案按真实成因分档（**不得**再出现「宿主未提供」反向归因）。
//
// 纪律：每条阴性断言都配**同输入阳性对照**（同一夹具换 runtime 形态），防恒真断言。
// RED 证据（原实现的可复现缺陷）见 `exec/test-report.md` §T-1——用 `git show HEAD:…dispatch.js` 的旧模块对照，
// 不改仓库文件做对照。
import test from 'node:test';
import assert from 'node:assert/strict';
// 【D-1】拒派四要素单点（批 `punky-d1d2-impl-20261103`）
import { assertRejected } from './helpers/dispatch-result.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { createCoreTools } from '../lib/tools/core.js';
import { EVT_MEMBER_DISPATCH } from '../lib/state/event-types.js';
import { __resetLaneHandles, pendingHandles } from '../lib/bridge/lane-handle.js';
// 【P0-3 门禁解冻】原还 import `subagentRuntimeOf` / `subagentRuntimeProbeOf`（引擎侧形态探针）。
//   两者是**宿主形态值**的出口（J6-e / AC-5″ 要清除的对象），provider 拆分中整簇删除 ⇒
//   本文件不再 import 它们，T-1.6 改由**端口功能面读数**（`createAgentPort`）作答。
import { buildStartRequest } from '../lib/engine/dispatch.js';
import { createAgentPort } from '../lib/provider-dsh/agent.js';
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
test('T-1.1 A1-P1-01 宿主仅提供 activation 形态 ⇒ 前置 fail-closed 拒派（能力位不可用族），且三零（lane 未变/零句柄/零事件）', async () => {
  __resetLaneHandles();
  const root = tempRoot('punky-f1t1a-');
  const store = seedBatch(root, 'sess-f1a', 'b-f1a');
  let activationCalls = 0;
  const ctx = mkCtx({
    startActivation: async () => { activationCalls += 1; return { childId: 'child-A', result: Promise.resolve({}) }; },
  });
  const ld = laneToolOf(ctx, store, root, { dispatch: { provider: 'spawn' } });
  // 【D-1 · lane `impl-d2` 迁移】本闸在 `lib/engine/dispatch.js:1148`（canNarrow）⇒ **返回** `mode:'rejected'`（不抛）。
  //   ⚠ 纠一处易错点：**码族在字段 `code` 上**，`spawnNote` 文案（`:1171`/`:1177`）里**不含** `GATE_DISPATCH_…` 字面
  //   ⇒ 若把码族写成 `assert.match(spawnNote, /GATE_DISPATCH_…/)` 会**假红**。四条语义钉（收窄/不以弱换强/agentPreset/成因）才读 `spawnNote`。
  const r = await ld.execute({ batchId: 'b-f1a', lane: 'l1' }, execOf('sess-f1a'));
  assertRejected(r, 'T-1.1 activation-only');
  {
    const note = String(r?.spawnNote ?? '');
    // 【P0-3 门禁解冻】码**族**（跨改名窗口；码名批 MISSING→UNAVAILABLE 后本断言仍有效）—— 读 `r.code`
    assert.match(String(r?.code), /GATE_DISPATCH_CAPABILITY_(MISSING|UNAVAILABLE)/,
      '拒派码须属「能力位不可用」族（码名批 MISSING→UNAVAILABLE ⇒ 本断言跨改名窗口保持有效）');
    assert.match(note, /收窄/, '① 点明拿不到的是**按次收窄**能力（功能面语言，不点名宿主入口）');
    assert.match(note, /不以弱换强/, '② 点明拒派判据（功能面语言）');
    // 【host-ports 批语义订正】新文案用字段名 `agentPreset`（camelCase），且已订正 maxDepth 表述。
    assert.match(note, /agentPreset/, '③ 点明承载方字段名 agentPreset');
    // 【P0-3 解冻 · 二次防冻结】成因词族（当前「未配置」/ 未来「无见证 / 无法核对」）—— 只钉 `未配置` 等于把当前成因冻结成契约。
    assert.match(note, /(未配置|无见证|无法核对|不能核对)/,
      '③′ 点明拒派前置成因（跨成因改写窗口：未配置 → 无收窄见证）；实际=' + note);
  }
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
test('T-1.3 A1-P1-01 无可用启动功能（{} 与 {startContinuable}）⇒ spawned:false + 文案给功能面成因、不含「宿主未提供」；句柄未消费、lane 仍 running', async () => {
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
    // 【P0-3 解冻】原 `note.includes('startActivation')` / `note.includes('start')` 要求引擎降级文案
    //   **点名宿主入口名** —— 宿主入口是 provider 知识，J6.0 禁止引擎文案承载（且 `'start'` 是
    //   `'startActivation'` 的子串，第二条本就近恒真）。语义等价改写：只要求降级**动作**可读
    //   （「仅发句柄」是本层语义）；宿名禁令由文末 T-1.8（todo 登记）承载。
    assert.ok(note.includes('仅发句柄'), label + '：文案须声明降级动作「仅发句柄」；实际=' + note);
    assert.equal(note.includes('宿主未提供'), false, label + '：**禁**反向归因「宿主未提供」');
    assert.ok(r.firstLine && r.firstLine.startsWith('[swarm-lane:' + batchId + '/l1#'), label + '：句柄照常发放');
    assert.equal(handlesOf(batchId, 'l1').length, 1, label + '：句柄**未消费**（仍可直派）');
    assert.equal(store.readBatch('sess-f1c', batchId).lanes.l1, 'running', label + '：lane 已置 running（既有降级语义逐字保留）');
    assert.equal(dispatchesOf(store, 'sess-f1c', batchId).length, 0, label + '：未自派 ⇒ 零登记');
    __resetLaneHandles();
  }
});

// ── T-1.4 C′ `ctx.subagents` 取值抛错 ⇒ runtime-unavailable 档（不崩、文案可辨） ──
test('T-1.4 A1-P1-01 取值被注入守卫拒绝 ⇒ spawned:false + 文案给功能面成因「未注入」，不含「宿主未提供」，且不抛错', async () => {
  __resetLaneHandles();
  const root = tempRoot('punky-f1t1d-');
  const store = seedBatch(root, 'sess-f1d', 'b-f1d');
  const ctx = throwingSubagentsCtx();
  const ld = laneToolOf(ctx, store, root, { dispatch: { provider: 'spawn' } });
  const r = await ld.execute({ batchId: 'b-f1d', lane: 'l1' }, execOf('sess-f1d'));
  assert.equal(r.spawned, false, '未注入 ⇒ 降级（不抛原始 cordis 错）');
  const note = String(r.spawnNote ?? '');
  // 【P0-3 解冻】原断言要求文案含**宿名串** `ctx.subagents 不可取` —— 宿名属 provider 知识。
  //   功能面等价：必须给出「未注入」这一成因档（下一行），并声明降级动作（「仅发句柄」）。
  assert.ok(note.includes('仅发句柄'), '文案须声明降级动作「仅发句柄」；实际=' + note);
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

// ── T-1.6 端口功能面读数（原「引擎探针三态」；探针簇随 provider 拆分删除，读数面不变） ──
//   【P0-3 门禁解冻 · 批 `punky-adapter-p0-20261031`】原用例断言 `subagentRuntimeProbeOf` 的
//   `{rt, form, reason}` 三态 —— `form` 是**宿主形态值**、`rt` 是**宿主服务句柄**，两者正是
//   J6-e / AC-5″ 要清除的对象（provider 拆分中探针簇 `dispatch.js:948-960` 整簇删除）。
//   语义等价改写：同一批输入改由**端口**作答，且只读**功能面读数**（available / narrowVia / depthVia）；
//   三档语义一一对应：无服务 / 无可用入口 ⇒ 功能面不可用；有入口 ⇒ 可用（入口差异由通道读数表达）。
test('T-1.6 A1-P1-01 端口对五种宿主面给出功能面读数（available / narrowVia / depthVia），且不抛', () => {
  const noneOf = (ctx, label) => {
    const port = createAgentPort(ctx);
    assert.equal(port.available, false, label + '：功能面不可用');
    assert.equal(port.narrowVia, 'none', label + '：收窄通道必须是 none（禁假装可收窄）');
    assert.equal(port.depthVia, 'none', label + '：深度通道 none');
    return port;
  };
  noneOf({}, '缺服务（缺键）');
  noneOf({ subagents: null }, '缺服务（null）');
  noneOf(throwingSubagentsCtx(), '取值被注入守卫拒绝');
  noneOf({ subagents: {} }, '服务在位但无可用启动入口');
  noneOf({ subagents: { startContinuable() {} } }, '历史桩 startContinuable 不得被当作可用入口');

  const startPort = createAgentPort({ subagents: { start() {} } });
  assert.equal(startPort.available, true, '有可用入口 ⇒ 功能面可用');
  assert.equal(startPort.narrowVia, 'request', '旧入口形态 ⇒ 收窄经 request（能力位读数，非形态派生）');

  // activation 入口：**可用**（能力差异由通道读数表达，不是「不可用」）；
  //   通道具体取值不在本用例钉死 —— 真读数口径（p0-6）落地后由 canNarrow(ask) 的实测结果决定。
  const activationPort = createAgentPort({ subagents: { startActivation() {} } });
  assert.equal(activationPort.available, true, 'activation 入口也算可用');
  assert.equal(['request', 'preset', 'none'].includes(activationPort.narrowVia), true,
    '收窄通道取值域合法（request|preset|none）；实际=' + activationPort.narrowVia);
});

// ── T-1.8（P0-3 前向登记 · **当前预期红**）文案不得承载宿主知识 ─────────────────────────
//   本用例把「引擎拒派/降级文案不得出现宿主服务名或宿主入口名」写成**可执行要求**
//   （J6.0「引擎不得知道宿主形态」/ AC-5″ 同源）。
//   实现面已由 W4-1 `w4-codename` 落地：`dispatch.js` 的拒派/降级文案已改功能面语言
//   （非注释行内 `ctx.subagents` / `startActivation` / `startContinuable` 实测 = 0）⇒ 本用例已由
//   「内联预期红（`{ todo }`）」**转正为正式用例**（2026-11-01，Leader 清 `forward-todo-registry` 的 T-1.8）。
test('T-1.8 拒派/降级文案不得出现宿主服务名或宿主入口名',
  async () => {
    const HOST_WORDS = /ctx\.\s*subagents|startActivation|startContinuable/;

    // ① 拒派文案（activation 形态 + 未配 agentPreset）
    __resetLaneHandles();
    const root1 = tempRoot('punky-f1t8a-');
    const store1 = seedBatch(root1, 'sess-f1h', 'b-f1h1');
    const ld1 = laneToolOf(mkCtx({ startActivation: async () => ({}) }), store1, root1, { dispatch: { provider: 'spawn' } });
    // 【D-1 · 批 `punky-d1d2-impl-20261103`】**只改前提**：拒派从 throw 改为返回值
    //   ⇒ 文本来源从「捕获的 `err.message`」换成「返回体的 `spawnNote`」。
    //   ⚠ **断言体（`HOST_WORDS` 检查）语义与强度一字未动** —— 它防「文案泄漏宿主入口名」，必须保留。
    const r1 = await ld1.execute({ batchId: 'b-f1h1', lane: 'l1' }, execOf('sess-f1h'));
    assertRejected(r1, 'T-1.8① 前提');
    const msg1 = String(r1.spawnNote ?? '');
    assert.equal(HOST_WORDS.test(msg1), false, '拒派文案不得承载宿主入口名；实际=' + msg1);

    // ② 降级文案（服务在位但无可用入口）
    __resetLaneHandles();
    const root2 = tempRoot('punky-f1t8b-');
    const store2 = seedBatch(root2, 'sess-f1h', 'b-f1h2');
    const ld2 = laneToolOf(mkCtx({}), store2, root2, { dispatch: { provider: 'spawn' } });
    const r2 = await ld2.execute({ batchId: 'b-f1h2', lane: 'l1' }, execOf('sess-f1h'));
    assert.equal(HOST_WORDS.test(String(r2.spawnNote ?? '')), false,
      '降级文案不得承载宿主入口名；实际=' + String(r2.spawnNote ?? ''));

    // ③ 取值被注入守卫拒绝档
    __resetLaneHandles();
    const root3 = tempRoot('punky-f1t8c-');
    const store3 = seedBatch(root3, 'sess-f1h', 'b-f1h3');
    const ld3 = laneToolOf(throwingSubagentsCtx(), store3, root3, { dispatch: { provider: 'spawn' } });
    const r3 = await ld3.execute({ batchId: 'b-f1h3', lane: 'l1' }, execOf('sess-f1h'));
    assert.equal(HOST_WORDS.test(String(r3.spawnNote ?? '')), false,
      '取值抛错档文案不得承载宿主服务名；实际=' + String(r3.spawnNote ?? ''));
    __resetLaneHandles();
  });

// ── T-1.7 载荷契约（探针不改变 buildStartRequest 的按次收窄面）：阳性对照锚 ──
test('T-1.7 A1-P1-01 buildStartRequest 契约未被本批削弱（signal 可 throwIfAborted + toolFilter.deny 非空 + label）', () => {
  const request = buildStartRequest({ batchId: 'b-x', lane: 'l1', parent: { id: 'a' }, prompt: 't' });
  assert.equal(request.label, 'punky-swarm:b-x:l1');
  assert.ok(Array.isArray(request.toolFilter.deny) && request.toolFilter.deny.length > 0);
  assert.equal(typeof request.signal.throwIfAborted, 'function');
  assert.equal(request.maxDepth, 1);
});
