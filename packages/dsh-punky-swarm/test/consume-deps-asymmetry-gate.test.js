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

// 批 `consume-deps-guard-20261004`（lane `e01-engine`）：`consume` × `deps` 不对称护栏的**可达构造**测试面。
// 判据源 = `plan/consume-deps-spec.md`（A-1..A-7 / A-10；A-8 指引同步与 A-9 全量回归为**命令级**读数，
// 落在 `exec/e01-engine.md`）。纪律（§15⑤ 反空转）：每条新增校验都带**必失败构造 ＋ 必通过对照**，
// 缺一即视为空转；读数一律带限定量词（计数 / 集合包含 / 逐字相等）。
//
// 构造分层：
//   · 域 A（audit 面）：A-1 必失败 ＋ A-3 对照必通过
//   · 域 C（同层链）：A-2 必失败 ＋ A-3 对照必通过
//   · 域 B（观察面）：A-4（落事件 + 回显 + 缺边确实存在）
//   · 静默豁免 / 零误伤：A-5（`threeTierTasks` 原样形态，单测 ＋ 真实建批路径）
//   · smoke 键：A-6（同键豁免；行为安全门不减）
//   · 重归一化：A-7（`addPoolTasks` 内部重跑 `buildWavePlan`，拒 / 过两支 + 零部分落盘）
//   · 双面对齐：A-10（`.ts` 源 ↔ `.js` 产物 关键标识符计数相等）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWavePlan, validateWavePlan, consumeDepsAsymmetryOf } from '../lib/wave-plan.js';
import { createStore } from '../lib/state/store.js';
import { createTools } from '../lib/tools/register.js';
import * as EVT from '../lib/state/event-types.js';
import { threeTierTasks, assessC } from './helpers/gate-fixture.mjs';
import { withDefaultTeam } from './helpers/skill-paths.mjs';
import { makeDispatchHarness } from './helpers/dispatch-fixture.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEW_GATE = 'GATE_CONSUME_DEPS_ASYMMETRY';
const NEW_EVT = 'gate.consume_deps_asymmetry';
const SID = 'sess-cdg';

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'punky-cdg-'));

/** 单次调用捕获（**抛错次数**的可观测代理：本函数每次调用至多记一次 ⇒ `threw` 即「该次调用是否抛」）。 */
function catchOnce(fn) {
  try {
    const value = fn();
    return { threw: false, msg: null, value };
  } catch (e) {
    return { threw: true, msg: String((e && e.message) || e), value: null };
  }
}

/** 同上的 async 变体（工具面 `execute` 返回 Promise）。 */
async function catchOnceAsync(fn) {
  try {
    const value = await fn();
    return { threw: false, msg: null, value };
  } catch (e) {
    return { threw: true, msg: String((e && e.message) || e), value: null };
  }
}

const hitsOf = (src, re) => (src.match(re) ?? []).length;
const artifactsDirOf = (root, sessionId, batchId) => path.join(root, 'sessions', sessionId, 'artifacts', batchId);
const filesUnder = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile()) : []);

// ── 构造集（**逐条对应 spec 的可达构造**）──────────────────────────────────────

/** A-1 违例形态（域 A）：audit lane 消费 exec lane 的产物、而 `deps` 不含该 exec lane。 */
const a1Violating = () => ([
  { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 'spec' },
  { id: 'eX', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/eX.md'], deps: ['p1'], cmd: 'run' },
  { id: 'aL', layer: 'audit', consume: ['plan/spec.md', 'exec/eX.md'], produce: ['audit/aL.md'], deps: [], cmd: 'review' },
]);
/** A-1 聚合对照（**两条强制域缺口**：一 lane 同时消费两个 exec lane 的产物且皆无边）。 */
const a1TwoGaps = () => ([
  { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 'spec' },
  { id: 'eX', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/eX.md'], deps: ['p1'], cmd: 'run' },
  { id: 'eZ', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/eZ.md'], deps: ['p1'], cmd: 'run' },
  { id: 'aL', layer: 'audit', consume: ['plan/spec.md', 'exec/eX.md', 'exec/eZ.md'], produce: ['audit/aL.md'], deps: [], cmd: 'review' },
]);
/** A-3 对照（与 A-1 同形，**只补边** `aL.deps += ['eX']`）。 */
const a1Compliant = () => a1Violating().map((t) => (t.id === 'aL' ? { ...t, deps: ['eX'] } : t));
/** A-2 违例形态（域 C 同层链）：exec lane `eB` 消费同层 `eA` 的产物、`deps` 不含 `eA`（audit 侧边齐备）。 */
const a2Violating = () => ([
  { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 'spec' },
  { id: 'eA', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/eA.md'], deps: ['p1'], cmd: 'run' },
  { id: 'eB', layer: 'exec', consume: ['exec/eA.md'], outputs: ['exec/eB.md'], deps: ['p1'], cmd: 'run' },
  { id: 'a1', layer: 'audit', consume: ['plan/spec.md', 'exec/eA.md', 'exec/eB.md'], produce: ['audit/a1.md'], deps: ['eA', 'eB'], cmd: 'review' },
]);
/** A-3 对照（与 A-2 同形，**只补边** `eB.deps += ['eA']`）。 */
const a2Compliant = () => a2Violating().map((t) => (t.id === 'eB' ? { ...t, deps: ['p1', 'eA'] } : t));
/** A-4 观察形态（域 B）：exec lane `eY` 消费 plan lane `pZ` 的产物、`deps` 不含 `pZ`。 */
const bObserved = () => ([
  { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 'spec' },
  { id: 'pZ', layer: 'plan', produce: ['plan/yyy.md'], cmd: 'spec' },
  { id: 'eY', layer: 'exec', consume: ['plan/yyy.md'], outputs: ['exec/eY.md'], deps: [], cmd: 'run' },
  { id: 'a1', layer: 'audit', consume: ['plan/spec.md', 'exec/eY.md'], produce: ['audit/a1.md'], deps: ['eY'], cmd: 'review' },
]);

/** 建批工具面 harness（tmp 根 + store + 真实 `wave_plan` + C 档评估）。 */
function toolHarness(root, sessionId) {
  const store = createStore(root);
  const ctx = {
    tools: { register: () => {}, guard: () => () => {} },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    subagents: { start: async () => ({ id: 'worker-stub', result: Promise.resolve({ output: [], stopReason: 'completed' }) }) },
  };
  const { tools } = createTools(ctx, { store, root, config: {} });
  const by = withDefaultTeam(Object.fromEntries(tools.map((t) => [t.name, t])));
  const exec = { agent: { session: { id: sessionId } } };
  assessC(store, sessionId, { rationale: 'fixture：consume × deps 护栏用例（三层批建批前置评估 ⇒ C 档）' });
  return { store, by, exec };
}

const ASSEMBLY = { auditLane: 'a1', managerPlan: 'leader-direct' };
const eventsOf = (store, sessionId, batchId, type) => (store.readBatch(sessionId, batchId)?.events ?? []).filter((e) => e && e.type === type);

// ── A-1 域 A 拒态（audit 面：上游非 plan 被审计 lane 消费而缺边）────────────────────
test('A-1 域 A 拒态：audit lane 消费 exec 产物而 `deps` 缺边 ⇒ 拒建批 + 消息含码含缺口', () => {
  const r = catchOnce(() => buildWavePlan({ batchId: 'b-cdg-a1', tasks: a1Violating(), team: null }));
  assert.equal(r.threw, true, '必失败构造须被拒（建批不成立）');
  assert.ok(r.msg.includes(NEW_GATE), '错误消息须含新拒码：' + r.msg);
  assert.ok(r.msg.includes('eX'), '消息须含缺口来源 lane id（eX）：' + r.msg);
  assert.equal(r.msg.includes('GATE_ORPHAN_PRODUCT'), false, '拒因须是本门（不是既有 plan 悬空门抢答）：' + r.msg);
});

// ── A-2 域 C 拒态（同层链：非 audit、上游非 plan 的同层消费）────────────────────────
test('A-2 域 C 拒态：exec lane 消费同层 exec 产物而 `deps` 缺边 ⇒ 同一抛出点拒', () => {
  const r = catchOnce(() => buildWavePlan({ batchId: 'b-cdg-a2', tasks: a2Violating(), team: null }));
  assert.equal(r.threw, true, '必失败构造须被拒（同层链一并纳入强制域）');
  assert.ok(r.msg.includes(NEW_GATE), '错误消息须含新拒码：' + r.msg);
  assert.ok(r.msg.includes('eA'), '消息须含缺口来源 lane id（eA）：' + r.msg);
});

test('A-1/A-2 聚合口径：两条强制域缺口 ⇒ 单条消息逐条回显（码在消息内恰出现 1 次）', () => {
  const r = catchOnce(() => buildWavePlan({ batchId: 'b-cdg-agg', tasks: a1TwoGaps(), team: null }));
  assert.equal(r.threw, true, '必失败构造须被拒');
  assert.equal(hitsOf(r.msg, new RegExp(NEW_GATE, 'g')), 1, '同一批一次聚合抛（非逐缺口 N 次）：码在单条消息内恰 1 次');
  assert.ok(r.msg.includes('eX') && r.msg.includes('eZ'), '两条缺口须**同时**在消息内逐条回显：' + r.msg);
});

test('A-1 零批次落盘（工具面可达路径）：拒建批后无批次 JSON、产物根零文件', async () => {
  const root = tempRoot();
  const { store, by, exec } = toolHarness(root, SID);
  const r = await catchOnceAsync(() => by.wave_plan.execute({ batchId: 'b-cdg-a1-tool', tasks: a1Violating(), assembly: ASSEMBLY }, exec));
  assert.equal(r.threw, true, '工具面必失败构造须被拒');
  assert.ok(r.msg.includes(NEW_GATE), '错误消息须含新拒码：' + r.msg);
  assert.ok(!store.readBatch(SID, 'b-cdg-a1-tool'), '批次 JSON 未落盘（读端回 undefined/null）');
  assert.equal(filesUnder(artifactsDirOf(root, SID, 'b-cdg-a1-tool')).length, 0, '产物根下文件数 = 0');
});

// ── A-3 对照放行（必通过构造：同形只补边）──────────────────────────────────────
test('A-3 对照放行：两例同形补边后建批成功、wave 数 = 3、观察事件计数 = 0', async () => {
  // ① 单测面：直接 `buildWavePlan` + `validateWavePlan`
  //   wave 数逐例断言（补边会改变拓扑深度，**不是**统一 3）：A-1 形态补 `aL.deps += [eX]` ⇒ 3 波；
  //   A-2 形态补 `eB.deps += [eA]` ⇒ 4 波（p1 | eA | eB | a1，同层链一旦成形即多一层）。
  for (const [tag, bid, tasks, waves] of [
    ['A-1 补 aL.deps += eX', 'b-cdg-ok-1', a1Compliant(), 3],
    ['A-2 补 eB.deps += eA', 'b-cdg-ok-2', a2Compliant(), 4],
  ]) {
    const r = catchOnce(() => {
      const plan = buildWavePlan({ batchId: bid, tasks, team: null });
      validateWavePlan(plan);
      return plan;
    });
    assert.equal(r.threw, false, tag + ' 须放行：' + r.msg);
    assert.equal(r.value.wavePlan.length, waves, tag + '：wave 数 = ' + waves);
    assert.deepEqual(consumeDepsAsymmetryOf(r.value.wavePlan.flatMap((w) => w.tasks)), [], tag + '：零缺边行');
  }
  // ② 工具面：批次落盘 + 相位 ∈ {planning, running} + 观察事件计数 = 0
  const root = tempRoot();
  const { store, by, exec } = toolHarness(root, SID);
  for (const [bid, tasks, auditLane] of [['b-cdg-ok1', a1Compliant(), 'aL'], ['b-cdg-ok2', a2Compliant(), 'a1']]) {
    await by.wave_plan.execute({ batchId: bid, tasks, assembly: { auditLane, managerPlan: 'leader-direct' } }, exec);
    const b = store.readBatch(SID, bid);
    assert.ok(b, bid + '：批次 JSON 已落盘');
    assert.ok(['planning', 'running'].includes(b.phase), bid + '：phase ∈ {planning, running}，实为 ' + b.phase);
    assert.equal(eventsOf(store, SID, bid, NEW_EVT).length, 0, bid + '：观察事件计数 = 0');
  }
});

// ── A-4 域 B 观察面（非强制域：不拒但可见）────────────────────────────────────
test('A-4 域 B 观察面：exec 消费 plan 产物而缺边 ⇒ 不拒 + 恰 1 条事件 + 回显数组长度 1', async () => {
  const root = tempRoot();
  const { store, by, exec } = toolHarness(root, SID);
  const out = await by.wave_plan.execute({ batchId: 'b-cdg-obs', tasks: bObserved(), assembly: ASSEMBLY }, exec);
  // ① 不拒 + 正常落盘
  const b = store.readBatch(SID, 'b-cdg-obs');
  assert.ok(b, '观察面须建批成功（非拒）');
  // ② 事件恰 1 条 + 载荷三键
  const evs = eventsOf(store, SID, 'b-cdg-obs', NEW_EVT);
  assert.equal(evs.length, 1, '观察事件计数 = 1（不是 ≥1、不是 0）');
  assert.equal(evs[0].lane, 'eY', '载荷 lane');
  assert.equal(evs[0].from, 'pZ', '载荷 from');
  assert.equal(evs[0].artifact, 'plan/yyy.md', '载荷 artifact');
  // ③ 回显数组（闭集 schema 须登记 properties，否则被剥掉）
  assert.ok(Array.isArray(out.consumeDepsAsymmetry), '返回值须回显 consumeDepsAsymmetry');
  assert.equal(out.consumeDepsAsymmetry.length, 1, '回显数组长度 = 1');
  assert.deepEqual(Object.keys(out.consumeDepsAsymmetry[0]).sort(), ['artifact', 'from', 'lane'], '回显元素 = {lane, from, artifact}');
  // ④ 缺口确实存在（证明观察面在**缺口态**下发射）+ 相位未被本门改写
  const eY = b.wavePlan.flatMap((w) => w.tasks).find((t) => t.id === 'eY');
  assert.equal(eY.deps.includes('pZ'), false, 'pZ ∉ eY.deps（缺口态）');
  assert.equal(b.phase, 'planning', '本门不改相位（观察零相位事件）');
  await by.batch_phase.execute({ batchId: 'b-cdg-obs', phase: 'running' }, exec);
  assert.equal(store.readBatch(SID, 'b-cdg-obs').phase, 'running', '批次相位正常推进（观察不停轮）');
  assert.equal(eventsOf(store, SID, 'b-cdg-obs', NEW_EVT).length, 1, '推进相位不再新增观察事件（建批期一次性）');
});

test('A-4 对照：pZ 写进 eY.deps 后 ⇒ 零事件、零回显键（必通过对照）', async () => {
  const root = tempRoot();
  const { store, by, exec } = toolHarness(root, SID);
  const tasks = bObserved().map((t) => (t.id === 'eY' ? { ...t, deps: ['pZ'] } : t));
  const out = await by.wave_plan.execute({ batchId: 'b-cdg-obs2', tasks, assembly: ASSEMBLY }, exec);
  assert.equal(eventsOf(store, SID, 'b-cdg-obs2', NEW_EVT).length, 0, '补边后观察事件计数 = 0');
  assert.equal('consumeDepsAsymmetry' in out, false, '无缺边 ⇒ 不写回显键（条件键先例：smoke/assembly）');
});

// ── A-5 非强制域零误伤（`threeTierTasks` 原样形态）──────────────────────────────
test('A-5 零误伤 · 单测面：`threeTierTasks` 原样形态不拒且零缺边行（(audit, plan) 静默豁免）', () => {
  const tasks = threeTierTasks(['e1'], { auditId: 'a1' });
  const r = catchOnce(() => validateWavePlan(buildWavePlan({ batchId: 'b-cdg-a5', tasks, team: null })));
  assert.equal(r.threw, false, '合规范例不得被拒：' + r.msg);
  assert.deepEqual(consumeDepsAsymmetryOf(tasks), [], '零缺边行（a1 的 plan 判据源属静默豁免面）');
});

test('A-5 零误伤 · 端到端真实建批路径：`makeDispatchHarness` 通过且观察事件 = 0', async () => {
  const h = await makeDispatchHarness({ SID: 'sess-cdg-dfx', batchId: 'b-cdg-dfx' });
  const b = h.store.readBatch('sess-cdg-dfx', 'b-cdg-dfx');
  assert.ok(b, '真实建批路径须落盘（未被本门拦下）');
  assert.equal(eventsOf(h.store, 'sess-cdg-dfx', 'b-cdg-dfx', NEW_EVT).length, 0, '观察事件计数 = 0');
});

// ── A-6 smoke 豁免 ──────────────────────────────────────────────────────────
test('A-6 smoke 豁免：A-2 违例形态 + smoke:true ⇒ 不拒、不落观察事件；行为安全门一字不减', async () => {
  const root = tempRoot();
  const { store, by, exec } = toolHarness(root, SID);
  const r = await catchOnceAsync(() => by.wave_plan.execute({ batchId: 'b-cdg-smoke', smoke: true, tasks: a2Violating(), assembly: ASSEMBLY }, exec));
  assert.equal(r.threw, false, 'smoke 批须豁免本门（产物契约类）：' + r.msg);
  assert.equal(eventsOf(store, SID, 'b-cdg-smoke', EVT.EVT_BATCH_SMOKE).length, 1, '既有 batch.smoke 留痕 1 条（行为不变）');
  assert.equal(eventsOf(store, SID, 'b-cdg-smoke', NEW_EVT).length, 0, 'smoke 批不落观察事件');
  // 行为安全门不减：同一 smoke 键下，id 重复仍被拒（validateWavePlan 结构门不受 smoke 影响）
  const dup = await catchOnceAsync(() => by.wave_plan.execute({ batchId: 'b-cdg-smoke-dup', smoke: true, tasks: [{ id: 'x', cmd: 'a' }, { id: 'x', cmd: 'b' }] }, exec));
  assert.equal(dup.threw, true, 'smoke 键不得豁免结构门（id 重复仍拒）');
  assert.ok(/duplicate/.test(dup.msg), '拒因须是重复 id：' + dup.msg);
});

// ── A-7 重归一化路径同判据（`addPoolTasks` 内部重跑 `buildWavePlan`）──────────────
test('A-7 重归一化：追加违例 lane ⇒ 拒 + 批文件字节级不变；追加合规 lane ⇒ 过 + planRevision +1', async () => {
  const root = tempRoot();
  const { store, by, exec } = toolHarness(root, SID);
  await by.wave_plan.execute({ batchId: 'b-cdg-r7', tasks: a2Compliant(), assembly: ASSEMBLY }, exec);
  const file = store.batchFile(SID, 'b-cdg-r7');
  const bytesBefore = fs.readFileSync(file);
  const before = store.readBatch(SID, 'b-cdg-r7');
  // ① 违例追加（exec lane 消费既有 exec lane 产物、deps 留空）⇒ 同一判据拒
  const bad = catchOnce(() => store.addPoolTasks(SID, 'b-cdg-r7', [
    { id: 'eC', layer: 'exec', consume: ['exec/eA.md'], outputs: ['exec/eC.md'], cmd: 'run' },
  ]));
  assert.equal(bad.threw, true, '追加违例 lane 须被拒（重归一化共用同一判据）');
  assert.ok(bad.msg.includes(NEW_GATE), '错误消息须含新拒码：' + bad.msg);
  // ② 零部分落盘：批文件字节级不变 + 结构读数相等
  assert.ok(bytesBefore.equals(fs.readFileSync(file)), '拒后批文件字节级不变');
  const after = store.readBatch(SID, 'b-cdg-r7');
  assert.deepEqual(after.wavePlan, before.wavePlan, 'wavePlan 深度相等（零部分落盘）');
  assert.equal(after.planRevision ?? 0, before.planRevision ?? 0, 'planRevision 未推进');
  // ③ 合规追加 ⇒ 通过 + revision +1
  const revBefore = after.planRevision ?? 0;
  store.addPoolTasks(SID, 'b-cdg-r7', [
    { id: 'eC2', layer: 'exec', consume: ['exec/eA.md'], deps: ['eA'], outputs: ['exec/eC2.md'], cmd: 'run' },
  ]);
  assert.equal(store.readBatch(SID, 'b-cdg-r7').planRevision ?? 0, revBefore + 1, '合规追加 ⇒ planRevision +1');
});

// ── A-10 `ts ↔ js` 双面对齐 ─────────────────────────────────────────────────
test('A-10 双面对齐：`.ts` 源与 `.js` 产物 的 throw / 标识符计数相等，`.d.ts` 同批', () => {
  const read = (rel) => fs.readFileSync(path.join(PKG_ROOT, rel), 'utf8');
  const ts = read('lib/wave-plan.ts');
  const js = read('lib/wave-plan.js');
  const THROW_RE = new RegExp("throw new Error\\('" + NEW_GATE, 'g');
  assert.equal(hitsOf(ts, THROW_RE), 1, '`.ts` 内新门 throw 命中数 = 1（单点判定）');
  assert.equal(hitsOf(js, THROW_RE), 1, '`.js` 产物同判据命中数 = 1（两侧相等）');
  assert.equal(hitsOf(ts, /consumeDepsAsymmetry/g) >= 1, true, '`.ts` 内 consumeDepsAsymmetry 标识符 ≥ 1');
  assert.equal(hitsOf(js, /consumeDepsAsymmetry/g) >= 1, true, '`.js` 内 consumeDepsAsymmetry 标识符 ≥ 1');
  // 事件常量单点（`lib/state/event-types.js` 为手写源，无 .ts 对侧）+ 工具面引用 + 字面量
  const evtTypes = read('lib/state/event-types.js');
  const tools = read('lib/tools/wave-plan-tools.js');
  assert.equal(hitsOf(evtTypes, /export const EVT_GATE_CONSUME_DEPS_ASYMMETRY = 'gate\.consume_deps_asymmetry';/g), 1, '事件常量定义恰 1 处');
  assert.equal(hitsOf(evtTypes, new RegExp("'" + NEW_EVT + "'", 'g')), 1, '事件字面量恰 1 处');
  assert.equal(hitsOf(tools, /EVT\.EVT_GATE_CONSUME_DEPS_ASYMMETRY/g), 1, '工具面写端引用恰 1 处');
  assert.equal(hitsOf(tools, /consumeDepsAsymmetry/g) >= 1, true, '工具面回显键 ≥ 1 处');
  // 拒码登记：源 + 构建产物同批
  assert.equal(hitsOf(read('lib/types/contracts.ts'), new RegExp("'" + NEW_GATE + "'", 'g')), 1, 'contracts.ts 登记恰 1 处');
  assert.equal(hitsOf(read('lib/types/contracts.d.ts'), new RegExp("'" + NEW_GATE + "'", 'g')), 1, 'contracts.d.ts（构建产物）同批登记恰 1 处');
  // lib/** 其余文件零 throw 命中（无第二实现）；WORD_RE 为**非全局**（逐文件 fresh 匹配，无 lastIndex 状态）
  const WORD_RE = new RegExp("throw new Error\\('" + NEW_GATE);
  const others = fs.readdirSync(path.join(PKG_ROOT, 'lib'), { recursive: true })
    .map(String).filter((f) => /\.(js|ts)$/.test(f) && !/^wave-plan\.(ts|js)$/.test(f))
    .filter((f) => WORD_RE.test(fs.readFileSync(path.join(PKG_ROOT, 'lib', f), 'utf8')));
  assert.deepEqual(others, [], 'lib/** 其余文件零新门 throw（无第二实现）');
});
