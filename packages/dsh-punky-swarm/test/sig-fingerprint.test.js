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

// test/sig-fingerprint.test.js —— sig 任务内容指纹（N3-②）验收套件
//
// 判据来源（规格 = `docs/sig-fingerprint-design-2026-09-22.md` §1/§2 + 用户 D-sig-1..4 四项裁定）：
//   ① 计算确定性（同输入同值 / 可复现）· ② 字段敏感性（id/layer/role/deps/produce/outputs/cmd 任一变化 ⇒ sig 变）
//   ③ deps 顺序敏感（保序语义）· ④ 加边后**受影响任务重算、无关任务 sig 不变**
//   ⑤ 已派发（owner 非空）任务 **sig 冻结** · ⑥ 重复 sig ⇒ **事件留痕且动作不被阻断**
//   ⑦ **不含 assemblyRef**（同任务换装配表/装配元数据仍同 sig）
// 另锁两条口径（防后续改动静默扩权）：
//   · 拒码 union **不因本能力新增**（`GATE_SIG_*` 在 lib 内零定义、`GateErrorCode` 仅 string 面）；
//   · 「落盘 sig == 读回任务重算 sig」**可机检**（sig 建立在**持久字段**上；消费点判等与审计复算都依赖它）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildWavePlan, assembleCmd, stripCmdPrefix } from '../lib/wave-plan.js';
import { computeTaskSig, canonicalTaskForSig, sigOf, canonicalizeForSig, SIG_PATTERN, SIG_HEX_LEN, duplicateSigLanesOf, sigDuplicateVerdict } from '../lib/sig-fingerprint.js';
import { createStore } from '../lib/state/store.js';
import { EVT_SIG_DUPLICATE_DETECTED } from '../lib/state/event-types.js';
import { createTools } from '../lib/tools/register.js';
import { assessC, seedArtifactFile, SPEC_OK } from './helpers/gate-fixture.mjs';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const flatOf = (plan) => plan.wavePlan.flatMap((w) => w.tasks);

/** 合规三层批任务（plan 产物被 exec 与 audit 双重消费；audit 同时消费各 exec 产物）。 */
function threeTierShape(over = {}) {
  return [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
    { id: 'e1', layer: 'exec', role: 'coder', deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/e1.md'], cmd: 'run' },
    { id: 'a1', layer: 'audit', role: 'supervisor', deps: ['e1'], consume: ['plan/spec.md', 'exec/e1.md'], produce: ['audit/a1.md'], cmd: 'review' },
    ...(over.extra ?? []),
  ];
}

/** 建批 + 落盘 + 返回 (store, 批次) 的临时夹具（真 store / 真 buildWavePlan，不手写伪批次 JSON）。 */
function seedBatch({ tasks, batchId = 'b-sig', session = 's-sig', root, withAudit = false } = {}) {
  const dir = root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'punky-sig-'));
  const store = createStore(dir);
  // 三层契约：有 exec 层就须有 audit 层（`validateLayerContract`）；本批多数用例只关心 sig 面，
  //   故缺省由夹具补齐一条最小 audit lane，**不因此放宽任何门禁**（引擎侧照常校验）。
  const ids = tasks.filter((t) => t.layer === 'exec').map((t) => t.id);
  const plan = buildWavePlan({
    batchId,
    team: 'engine-team',
    tasks: withAudit && ids.length > 0
      ? [...tasks, { id: 'a-twin', layer: 'audit', role: 'supervisor', deps: [...ids], consume: ['plan/spec.md', ...ids.map((i) => 'exec/' + i + '.md')], produce: ['audit/a-twin.md'], cmd: 'review' }]
      : tasks,
  });
  store.createBatch(session, { batchId, wavePlan: plan, concurrency: 5 });
  return { store, root: dir, session, batchId, plan };
}

// ── ① 计算确定性 ────────────────────────────────────────────────────────────
test('SIG-1① 计算确定性：同输入恒同值、键序无关、可复现（含规范化单点行为）', () => {
  const task = { id: 'e1', layer: 'exec', role: 'coder', deps: ['p1'], produce: ['x.md'], outputs: ['o.md'], cmd: 'run' };
  const a = computeTaskSig(task);
  const b = computeTaskSig({ ...task });
  const shuffled = computeTaskSig({ cmd: 'run', outputs: ['o.md'], produce: ['x.md'], deps: ['p1'], role: 'coder', layer: 'exec', id: 'e1' });
  assert.equal(a, b, '同输入两次计算须同值');
  assert.equal(a, shuffled, '对象键序不得影响 sig（canonicalJSON 键排序）');
  assert.equal(SIG_PATTERN.test(a), true, 'sig 恒为 16 位小写 hex：' + a);
  assert.equal(a.length, SIG_HEX_LEN);
  // 缺省与显式空的三态归一（防「同一任务两种写法两个 sig」）
  assert.equal(computeTaskSig({ ...task, layer: null }), computeTaskSig({ ...task, layer: undefined }),
    'layer:null 与 layer:undefined 同值');
  assert.equal(
    computeTaskSig({ id: 'e1', role: 'coder', deps: ['p1'], produce: ['x.md'], outputs: ['o.md'], cmd: 'run' }),
    computeTaskSig({ id: 'e1', layer: null, role: 'coder', deps: ['p1'], produce: ['x.md'], outputs: ['o.md'], cmd: 'run' }),
    '未写 layer 字段与 layer:null 同值',
  );
  assert.notEqual(computeTaskSig({ ...task, layer: null }), a, 'layer 有值 ⇒ 与无 layer 必须不同（字段敏感）');
  // 规范化助手本身：undefined 键剔除、数组保序、标量原样
  assert.deepEqual(canonicalizeForSig({ b: 1, a: undefined, c: [2, 1] }), { b: 1, c: [2, 1] });
  assert.deepEqual(canonicalTaskForSig(task), {
    id: 'e1', layer: 'exec', role: 'coder', deps: ['p1'], produce: ['x.md'], outputs: ['o.md'], cmd: 'run',
  });
  // 非规范化形态的防御归一（脏输入不产 NaN/异常）
  assert.deepEqual(canonicalTaskForSig({ id: 'x', deps: 'not-array', produce: null, outputs: undefined, cmd: 42, layer: 7 }),
    { id: 'x', layer: null, role: null, deps: [], produce: [], outputs: [], cmd: '' });
});

// ── ② 字段敏感性 ────────────────────────────────────────────────────────────
test('SIG-2② 字段敏感性：id/layer/role/deps/produce/outputs/cmd 任一变化 ⇒ sig 必变', () => {
  const base = { id: 'e1', layer: 'exec', role: 'coder', deps: ['p1'], produce: ['x.md'], outputs: ['o.md'], cmd: 'run' };
  const s = computeTaskSig(base);
  const cases = [
    ['id', { ...base, id: 'e2' }],
    ['layer', { ...base, layer: 'audit' }],
    ['role', { ...base, role: 'reviewer' }],
    ['deps', { ...base, deps: ['p1', 'p0'] }],
    ['produce', { ...base, produce: ['x.md', 'y.md'] }],
    ['outputs', { ...base, outputs: ['o2.md'] }],
    ['cmd', { ...base, cmd: 'run ' }],
  ];
  for (const [field, mutated] of cases) {
    assert.notEqual(computeTaskSig(mutated), s, field + ' 变化后 sig 必须变（实测=' + computeTaskSig(mutated) + '）');
  }
  // 值域等价（层相同语义的两种写法）不得被误判为不同
  assert.equal(computeTaskSig({ ...base, produce: [] }), computeTaskSig({ ...base, produce: [] }), '同空数组恒同值');
});

// ── ③ deps 顺序敏感（保序语义） ──────────────────────────────────────────────
test('SIG-3③ deps 顺序敏感：["p1","p2"] 与 ["p2","p1"] 是不同内容（保序，禁排序归一）', () => {
  const a = computeTaskSig({ id: 'e1', layer: 'exec', deps: ['p1', 'p2'], cmd: 'run' });
  const b = computeTaskSig({ id: 'e1', layer: 'exec', deps: ['p2', 'p1'], cmd: 'run' });
  assert.notEqual(a, b, '数组保序 ⇒ 依赖声明顺序进入指纹');
  assert.equal(computeTaskSig({ id: 'e1', layer: 'exec', deps: ['p1', 'p2'], cmd: 'run' }), a, '同顺序恒同值');
});

// ── ④ 建批落盘 + 加边重算（受影响变、无关不变） ───────────────────────────────
test('SIG-4④ 建批全量落盘；addPoolTasks 新任务补算且既有任务不变；addTaskEdges 只重算受影响任务', () => {
  const { store, session, batchId } = seedBatch({
    tasks: [
      { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
      { id: 'e1', layer: 'exec', role: 'coder', deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/e1.md'], cmd: 'run' },
      { id: 'e2', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e2.md'], cmd: 'run' },
      { id: 'a1', layer: 'audit', role: 'supervisor', deps: ['e1', 'e2'], consume: ['plan/spec.md', 'exec/e1.md', 'exec/e2.md'], produce: ['audit/a1.md'], cmd: 'review' },
    ],
  });
  const r0 = store.readBatch(session, batchId);
  const flat0 = flatOf(r0);
  assert.equal(flat0.length, 4, '建批 4 条任务');
  assert.equal(flat0.every((t) => SIG_PATTERN.test(t.sig ?? '')), true, '建批即全量落 sig（16 hex）：' + JSON.stringify(flat0.map((t) => t.sig)));
  // 「落盘 sig == 读回重算」= 可机检不变量（sig 建立在持久字段上）
  assert.equal(flat0.every((t) => computeTaskSig(t) === t.sig), true, '读回落盘任务重算须逐条等于落盘 sig');

  // addPoolTasks：新任务补算 + 既有任务 sig 逐字不变（无关任务不因一次追加而漂移）
  const before = Object.fromEntries(flat0.map((t) => [t.id, t.sig]));
  const r1 = store.addPoolTasks(session, batchId, [
    { id: 'e3', layer: 'exec', role: 'coder', deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/e3.md'], cmd: 'run' },
  ]);
  const flat1 = flatOf(r1);
  assert.equal(SIG_PATTERN.test(flat1.find((t) => t.id === 'e3')?.sig ?? ''), true, '追加任务须补算 sig');
  for (const id of ['p1', 'e1', 'e2', 'a1']) {
    assert.equal(flat1.find((t) => t.id === id).sig, before[id], '追加不得改动既有任务 ' + id + ' 的 sig');
  }

  // addTaskEdges：受影响任务重算（deps 变 ⇒ sig 变）、无关任务不变
  const before2 = Object.fromEntries(flat1.map((t) => [t.id, t.sig]));
  const r2 = store.addTaskEdges(session, batchId, [{ id: 'e2', add: ['p1'] }]);
  const flat2 = flatOf(r2);
  const e2 = flat2.find((t) => t.id === 'e2');
  assert.deepEqual(e2.deps, ['p1'], '加边后 deps 已含新入边');
  assert.notEqual(e2.sig, before2.e2, '受影响任务（deps 变）sig 必须变');
  assert.equal(computeTaskSig(e2), e2.sig, '重算值须与落盘值一致（自证非「随手写」）');
  for (const id of ['p1', 'e1', 'e3', 'a1']) {
    assert.equal(flat2.find((t) => t.id === id).sig, before2[id], '加边不得改动无关任务 ' + id + ' 的 sig');
  }
});

// ── ⑤ 已派发冻结 ────────────────────────────────────────────────────────────
test('SIG-5⑤ 已派发（owner 非空）⇒ sig 冻结：派发后与再归一化后均不得重算', () => {
  const { store, root, session, batchId } = seedBatch({
    withAudit: true,
    tasks: [
      { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
      { id: 'e1', layer: 'exec', role: 'coder', deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/e1.md'], cmd: 'run' },
    ],
  });
  seedArtifactFile(root, session, batchId, 'plan/spec.md', SPEC_OK); // 过 entry 门（consume 在场）
  const frozen = flatOf(store.readBatch(session, batchId)).find((t) => t.id === 'e1').sig;
  assert.equal(SIG_PATTERN.test(frozen), true, '前置：派发前已有指纹');
  store.setMember(session, batchId, 'e1', 'running', null, undefined, 'owner-1');
  const afterDispatch = flatOf(store.readBatch(session, batchId)).find((t) => t.id === 'e1');
  assert.equal(afterDispatch.owner, 'owner-1', '派发写入 owner（出池）');
  assert.equal(afterDispatch.sig, frozen, '派发后 sig 不得变');
  // 再经一次池内归一化（append 新任务）⇒ 冻结面保持
  const r = store.addPoolTasks(session, batchId, [
    { id: 'e9', layer: 'exec', role: 'coder', deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/e9.md'], cmd: 'other' },
  ]);
  const afterRenorm = flatOf(r).find((t) => t.id === 'e1');
  assert.equal(afterRenorm.sig, frozen, '重归一化不得改已派发任务的 sig');
  assert.equal(afterRenorm.owner, 'owner-1', '重归一化不得丢弃 owner');
  // 加边面：已派出池 ⇒ 结构上不可达（既有冻结判据先于 sig 生效）
  assert.throws(() => store.addTaskEdges(session, batchId, [{ id: 'e1', add: ['p1'] }]), /已出池/,
    '已派发任务不得加边（K1 冻结面先于 sig）');
});

// ── ⑥ 重复 sig ⇒ 事件留痕且不阻断（负向对照） ─────────────────────────────────
test('SIG-6⑥ 同 sig 双 lane：派发**不被阻断**且落 sig.duplicate_detected（留痕只此一处，不加拒码）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-sig-dup-'));
  const store = createStore(root);
  const ctx = {
    tools: { register: () => {}, guard: () => () => {} },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    subagents: { start: async () => ({ id: 'w-stub', result: Promise.resolve({ output: [], stopReason: 'completed' }) }) },
  };
  const { tools } = createTools(ctx, { store, root, config: { dispatch: { provider: 'spawn' } } });
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  const session = 's-sig-dup';
  const exec = { agent: { session: { id: session } } };
  assessC(store, session, { rationale: 'sig 套件：同 sig 双 lane 派发（C 档前置，多线并行建批）' });

  const built = buildWavePlan({
    batchId: 'b-sig-dup',
    team: 'engine-team',
    tasks: [
      { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
      { id: 'e1', layer: 'exec', role: 'coder', deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/e1.md'], cmd: 'run' },
      { id: 'e2', layer: 'exec', role: 'coder', deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/e2.md'], cmd: 'run' },
      { id: 'a1', layer: 'audit', role: 'supervisor', deps: ['e1', 'e2'], consume: ['plan/spec.md', 'exec/e1.md', 'exec/e2.md'], produce: ['audit/a1.md'], cmd: 'review' },
    ],
  });
  const flash = flatOf(built);
  const e1 = flash.find((t) => t.id === 'e1');
  assert.notEqual(e1.sig, flash.find((t) => t.id === 'e2').sig,
    '前置：id 入指纹 ⇒ 引擎自身建批**不会**产同 sig 的两条 lane（同 sig 是「同一内容被重复登记」的人工事实）');
  // 唯一可达构造：把 e2 的**落盘 sig** 定成与 e1 相同（消费点判等的被检面，不经伪造哈希路径）
  const crafted = built.wavePlan.map((w) => ({ ...w, tasks: w.tasks.map((t) => (t.id === 'e2' ? { ...t, sig: e1.sig } : t)) }));
  store.createBatch(session, { batchId: 'b-sig-dup', wavePlan: { ...built, wavePlan: crafted }, concurrency: 5 });
  store.setPhase(session, 'b-sig-dup', 'running');
  seedArtifactFile(root, session, 'b-sig-dup', 'plan/spec.md', SPEC_OK);

  const r1 = await by.lane_dispatch.execute({ batchId: 'b-sig-dup', lane: 'e1', session }, exec);
  const r2 = await by.lane_dispatch.execute({ batchId: 'b-sig-dup', lane: 'e2', session }, exec);
  assert.equal(r1.status, 'running', '首条 lane 正常派发');
  assert.equal(r2.status, 'running', '**重复 sig 不阻断派发**（D-sig-2：留痕不拒、不加拒码）');
  const batch = store.readBatch(session, 'b-sig-dup');
  const evs = batch.events.filter((e) => e.type === EVT_SIG_DUPLICATE_DETECTED);
  assert.equal(evs.length, 1, '同 (lane, 对端集合) 只落一条留痕事件（去重），且无其他留痕面');
  assert.equal(evs[0].lane, 'e2', '留痕归属 = 后来者 lane');
  assert.equal(evs[0].sig, e1.sig, '载荷带 sig（可回溯到具体指纹）');
  assert.deepEqual(evs[0].matches, [{ lane: 'e1', state: 'running' }], '对端 lane 与其**迁移前**状态');
  assert.equal(EVT_SIG_DUPLICATE_DETECTED, 'sig.duplicate_detected', '事件名为小写点分常量');
  assert.deepEqual(Object.keys(batch.sigDuplicateLogged ?? {}), ['e2|e1:running'], '去重记账键 = <lane>|<对端:态>');
  // 负向对照：仅一条 lane 时零留痕（sig 平凡/零命中 ⇒ 不落事件、不写记账键）
  const solo = seedBatch({
    withAudit: true,
    tasks: [
      { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
      { id: 'e1', layer: 'exec', role: 'coder', deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/e1.md'], cmd: 'run' },
    ],
  });
  seedArtifactFile(solo.root, solo.session, solo.batchId, 'plan/spec.md', SPEC_OK);
  solo.store.setMember(solo.session, solo.batchId, 'e1', 'running', null, undefined, 'owner-1');
  const soloBatch = solo.store.readBatch(solo.session, solo.batchId);
  assert.equal(soloBatch.events.filter((e) => e.type === EVT_SIG_DUPLICATE_DETECTED).length, 0, '无重复 ⇒ 零留痕');
  assert.equal(soloBatch.sigDuplicateLogged, undefined, '无重复 ⇒ 不写记账键（零噪音）');
});

test('SIG-6b 判等粒度：同层命中计 blocking、跨层只作 notice；终态/pending 对端不入判等', () => {
  const sig = 'a'.repeat(16);
  const other = 'b'.repeat(16);
  const batch = {
    lanes: { e1: 'running', e2: 'pending', e3: 'failed', p1: 'merged' },
    wavePlan: [{ wave: 1, tasks: [
      { id: 'e1', layer: 'exec', sig },
      { id: 'e2', layer: 'exec', sig },
      { id: 'e3', layer: 'exec', sig },
      { id: 'p1', layer: 'plan', sig },
      { id: 'e9', layer: 'exec', sig: other },
    ] }],
  };
  const sameLayer = duplicateSigLanesOf(batch, 'e1');
  assert.equal(sameLayer.sig, sig, '本 lane 指纹读出');
  assert.deepEqual(sameLayer.blocking, [], 'e2(pending)/e3(failed) 不在 {running,review,merged} ⇒ 不入判等');
  assert.deepEqual(sameLayer.notice, [{ lane: 'p1', state: 'merged', layer: 'plan' }], '跨层同 sig ⇒ 只作 notice');
  const cross = duplicateSigLanesOf(batch, 'p1');
  assert.deepEqual(cross.blocking, [], 'cross lane 视角：无同层命中');
  assert.deepEqual(cross.notice.map((n) => n.lane), ['e1'], '仅 running 的 e1 入 notice');
  assert.deepEqual(duplicateSigLanesOf(batch, 'e9'), { sig: other, blocking: [], notice: [] }, '不同 sig ⇒ 零命中');
  // verdict：命中且未记账 ⇒ log；已记账 / 无 sig / 零命中 ⇒ 不 log
  assert.equal(sigDuplicateVerdict(batch, 'e1', sameLayer).log, false, '仅 notice（跨层）不得触发留痕');
  const hit = { sig, blocking: [{ lane: 'e1', state: 'running' }], notice: [] };
  const v = sigDuplicateVerdict({ lanes: {} }, 'e2', hit);
  assert.equal(v.log, true, '同层命中且未记账 ⇒ 落留痕');
  assert.equal(v.key, 'e2|e1:running', '去重键 = <lane>|<对端:态>（带本 lane，防两条 lane 命中同一对端时互相顶掉）');
  assert.deepEqual(v.fields.matches, [{ lane: 'e1', state: 'running' }], '载荷带可核匹配对');
  assert.equal(v.fields.type, undefined, '载荷键不得占用 `type`（事件名槽位）');
  assert.equal(sigDuplicateVerdict({ sigDuplicateLogged: { 'e2|e1:running': true } }, 'e2', hit).reason, 'already-logged', '已记账 ⇒ 不重复');
  assert.equal(sigDuplicateVerdict({ sigDuplicateLogged: { 'e2|e1:running': true } }, 'e3', hit).log, true,
    '另一条 lane 命中同一对端 ⇒ 仍是新事实（键带本 lane）');
  assert.equal(sigDuplicateVerdict(batch, 'e9', { sig: null, blocking: [{ lane: 'e1', state: 'running' }], notice: [] }).reason, 'no-sig',
    'sig 平凡（非 16 hex）⇒ 不落留痕');
});

// ── ⑦ 不含 assemblyRef ──────────────────────────────────────────────────────
test('SIG-7⑦ 哈希不含 assemblyRef：同任务换装配表/装配元数据 ⇒ sig 同值（D-sig-1 裁定）', () => {
  const task = { id: 'e1', layer: 'exec', role: 'coder', deps: ['p1'], produce: ['x.md'], outputs: ['o.md'], cmd: 'run' };
  const base = computeTaskSig(task);
  for (const extra of [
    { assemblyRef: 'sha256:aaaa' },
    { assemblyRef: 'sha256:bbbb' },
    { assemblyRef: null },
    { updatedAt: '2026-09-22T00:00:00Z' },
    { planRevision: 7 },
    { skills: ['dev-coder'] },
    { owner: 'owner-1' },
    { consume: ['plan/spec.md'] },
    { sig: 'ffffffffffffffff' },
  ]) {
    assert.equal(computeTaskSig({ ...task, ...extra }), base,
      '字段 ' + Object.keys(extra)[0] + ' 不得进入指纹（易变 / 派生 / 装配类元数据）');
  }
  // 端到端：同一批任务在两种装配表下建批 ⇒ 同任务同 sig（装配补全的 skills 前缀进 cmd，属任务内容而非 assemblyRef）
  const tasks = [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
    { id: 'e1', layer: 'exec', role: 'coder', deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/e1.md'], cmd: 'run' },
    { id: 'a1', layer: 'audit', role: 'supervisor', deps: ['e1'], consume: ['plan/spec.md', 'exec/e1.md'], produce: ['audit/a1.md'], cmd: 'review' },
  ];
  const a = buildWavePlan({ batchId: 'b-a', tasks, team: 'engine-team' });
  const b = buildWavePlan({ batchId: 'b-b', tasks, team: 'engine-team', assembly: { layers: { exec: { skills: { coder: ['SENTINEL'] } } } } });
  assert.equal(flatOf(b).find((t) => t.id === 'p1').sig, flatOf(a).find((t) => t.id === 'p1').sig,
    'plan lane 不消费 assembly 装配 ⇒ 两种装配表下 sig 必须相同');
  // cmd（装配前缀已解析进任务内容）不在此列：它是任务包正文 ⇒ 变即 sig 变（另立断言防误读）
  assert.notEqual(flatOf(b).find((t) => t.id === 'e1').sig, flatOf(a).find((t) => t.id === 'e1').sig,
    'skills 注入改变命令正文（cmd）⇒ 该任务 sig 变（内容变即指纹变，与 assemblyRef 无关）');
});

// ── 边界口径锁（拒码 union 不变 + 读端口径单点） ──────────────────────────────
test('SIG-8 边界：本能力不新增拒码（lib 内 GATE_SIG_* 零定义）；sigOf 读端口径单点（非 16 hex ⇒ null）', () => {
  const sigCodeHits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (!/\.(js|ts)$/.test(e.name)) continue;
      if (/GATE_SIG_[A-Z_]*/.test(fs.readFileSync(abs, 'utf8'))) sigCodeHits.push(path.relative(REPO_ROOT, abs));
    }
  };
  walk(path.join(REPO_ROOT, 'lib'));
  assert.deepEqual(sigCodeHits, [], 'lib/** 内零 GATE_SIG_* 拒码定义/引用（D-sig-2：拒码 union 恒 29 不变）');
  assert.equal(sigOf({ sig: 'abcdefabcdefabcd' }), 'abcdefabcdefabcd', '合法 16 hex 原样读出');
  assert.equal(sigOf({}), null, '缺字段 ⇒ null');
  assert.equal(sigOf({ sig: null }), null, 'null ⇒ null');
  assert.equal(sigOf({ sig: 'ABCDEFABCDEFABCD' }), null, '大写 / 非小写 hex ⇒ null（不静默当真值）');
  assert.equal(sigOf({ sig: 'abc' }), null, '长度不足 ⇒ null');
  assert.equal(sigOf({ sig: 'zzzzzzzzzzzzzzzz' }), null, '非 hex 字符 ⇒ null');
});

// ── A-1 加固（2026-09-22 修复轮）：前缀剥离限定为「与本次装配值逐字一致」 ──────────────
// 施工轮缺陷：`stripCmdPrefix` **无条件**剥行首 `[role=…]`/`[skills=…]` 段 ⇒ 用户 cmd 原文恰好以该
//   形态开头时**内容丢失**（`'[role=other] 做某事'` → `'[role=coder] 做某事'`：整段被吞）。
// 修法判据（本组用例即判据面）：只剥与**本次装配值**逐字相等的前缀段（允许多次 ⇒ 覆盖历史重复注入）；
//   遇到**不等于**本次装配值的同形段即**停止剥离**，该段及其后原文逐字保留。
//   「逐段停止」而非「整体放弃」的理由：整体放弃会让 `'[role=coder] [role=other] run'` 在每次重归一化时
//   再累一段（前缀膨胀复发）；逐段停止既清掉引擎注入面、又逐字保住用户自己的同形文本。
test('A1-① 用户原文以 [role=other] 开头（本次 role=coder）⇒ 不被剥、段与内容逐字保留', () => {
  assert.equal(assembleCmd('coder', null, '[role=other] 做某事'), '[role=coder] [role=other] 做某事',
    '非本次装配值的 role 段不得被剥（旧实现误剥为 "[role=coder] 做某事" = 用户内容丢失）');
  assert.equal(stripCmdPrefix('[role=other] 做某事', 'coder', null), '[role=other] 做某事',
    'stripCmdPrefix 直调：不匹配即原样返回');
  // 端到端（真实 buildWavePlan 归一化）：落盘 cmd 必须仍含用户原文全段
  const plan = buildWavePlan({
    batchId: 'b-a1a',
    team: 'engine-team',
    tasks: [
      { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: '[role=other] spec' },
      { id: 'e1', layer: 'exec', role: 'coder', deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/e1.md'], cmd: 'run' },
      { id: 'a1', layer: 'audit', role: 'supervisor', deps: ['e1'], consume: ['plan/spec.md', 'exec/e1.md'], produce: ['audit/a1.md'], cmd: 'review' },
    ],
  });
  assert.equal(flatOf(plan).find((t) => t.id === 'p1').cmd, '[role=designer] [role=other] spec',
    '建批落盘 cmd 逐字保留用户原文（内容丢失修复的端到端证据）');
});

test('A1-② skills 段同理：用户原文 [skills=x] ≠ 本次装配值 ⇒ 不剥', () => {
  assert.equal(assembleCmd(null, ['dev-coder'], '[skills=user-skill] y'), '[skills=dev-coder] [skills=user-skill] y',
    'skills 值不匹配 ⇒ 该段原样保留（旧实现会吞掉 "[skills=user-skill] " 整段）');
  assert.equal(assembleCmd(null, ['dev-coder'], '[role=other] y'), '[skills=dev-coder] [role=other] y',
    '本次无 role 段 ⇒ role 段不在可剥集内');
});

test('A1-③ 历史重复注入（同值连续多次）⇒ 全剥后重拼一段（不累积）', () => {
  const twice = '[role=coder] [role=coder] run';
  assert.equal(stripCmdPrefix(twice, 'coder', null), 'run', '连续两段同值 ⇒ 全剥');
  assert.equal(assembleCmd('coder', null, twice), '[role=coder] run', '重归一化后前缀不累积');
  const thriceMixed = '[role=coder] [skills=dev-coder] [role=coder] [skills=dev-coder] 实现';
  assert.equal(assembleCmd('coder', ['dev-coder'], thriceMixed), '[role=coder] [skills=dev-coder] 实现',
    'role+skills 交替重复注入（真实历史形态）⇒ 全剥后逐字回到首装配形态');
});

test('A1-④ 幂等 + 既有首装配行为逐字不变', () => {
  for (const [cmd, role, skills] of [
    ['[role=coder] run', 'coder', null],
    ['[role=coder] [role=other] run', 'coder', null],
    ['[skills=a,b] [skills=a,b] run', null, ['a', 'b']],
    ['run', 'coder', ['dev-coder']],
    ['', 'coder', null],
  ]) {
    const once = stripCmdPrefix(cmd, role, skills);
    assert.equal(stripCmdPrefix(once, role, skills), once, '幂等：对已剥结果再剥不变（' + JSON.stringify(cmd) + '）');
  }
  // 既有行为逐字不变（`contract.test.js:95-98` 同款断言，此处防本次加固破面）
  assert.equal(assembleCmd('coder', ['dev-coder'], '实现'), '[role=coder] [skills=dev-coder] 实现');
  assert.equal(assembleCmd(null, null, 'plain'), 'plain');
  assert.equal(assembleCmd('audit', [], ''), '[role=audit] ');
  assert.equal(assembleCmd('coder', ['dev-coder'], '[role=coder] [skills=dev-coder] 实现'),
    '[role=coder] [skills=dev-coder] 实现', '落盘 cmd 重入 ⇒ 逐字不变（幂等端到端）');
  // 非行首同形文本不受影响（旧有边界，本次加固不得破坏）
  assert.equal(stripCmdPrefix('见 [role=x] 说明', 'coder', null), '见 [role=x] 说明', '非行首同形文本零影响');
});

test('A1-⑤ 逐段停止语义：首段命中被剥、遇不匹配段即停（其后原文不动）', () => {
  assert.equal(stripCmdPrefix('[role=coder] [skills=other] run', 'coder', ['dev-coder']), '[skills=other] run',
    '次段不等于本次装配值 ⇒ 停止剥离（该段起全文保留；不"整体放弃"以免前缀累积复发）');
  assert.equal(stripCmdPrefix('[skills=dev-coder] [role=coder] run', 'coder', ['dev-coder']), 'run',
    '剥序无关：两段各自等于本次装配值（互换顺序同样全剥）');
});
