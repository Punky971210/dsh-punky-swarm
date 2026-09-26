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

// P2-A 结算出口收紧 —— 批次 `p2-settle-narrowing-20260917` · 用例面。
// ─────────────────────────────────────────────────────────────────────────────
// 契约来源：`docs/p2-settle-narrowing-changeplan-20260917.md` §7（用户裁决回填：D1 都硬 / D2 保留 exit 门 /
//   D3 本轮做）+ 本任务书 §三项改动。
// 被检面（`gates.ts#checkSettleHandoffGate`，落点在 `store.js` 结算链**末尾**、既有门序不变）：
//   `merged` 时若本 lane 在 DAG 中**有下游**（他人 `deps` 引用 / 本 lane `next` 指向存在的步）
//   ⇒ 须**至少一条已成立交接**，否则拒 `GATE_HANDOFF_MISSING` + 落 `lane.handoff.gap`；
//   Leader 例外（note 含 `human:<裁决人>:<时间>:<结论>`）⇒ 放行 + 留痕；无下游 ⇒ 本门零感知；`smoke:true` ⇒ 豁免。
//
// 开关纪律（Leader 裁决 ①）：本门与 P1 **同源**挂在 `PSWARM_HANDOFF_GATE`（缺省关）⇒ 本套件**显式择入开启态**
//   （每例 `try/finally` 还原 env，避免污染同进程其它用例）；**策略态**由 `batch_status.handoffGate` 回显
//   （「缺省关是策略，不是隐形」）。
// 判据单点纪律（Leader 裁决 ②）：本门**复用** `gates.ts#handoffRecordVerdict`（entry 门同一实现），
//   本套件不断言实现细节，只断言**行为面**（拒/放行/缺口回显）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { assessC } from './helpers/gate-fixture.mjs';
import { writeSyntheticTeam, threeTierSyntheticTeam } from './helpers/team-fixture.mjs';
import { clearRoleCache } from '../lib/assembly/flows.js';
import { schemaViolations } from './helpers/schema-conformance.mjs'; // task-26：schema 一致性校验共享单点
import * as EVT from '../lib/state/event-types.js';

const SESSION = 'sess-p2-settle';
const SESS = { agent: { session: { id: SESSION } } };
const TEAM = 'p2-settle-team';


/** DAG：p1 → e1 → e2（e1 有下游 e2；e2 的下游是 a1）。 */
function tasksChain() {
  return [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'plan-it' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1.md'], deps: ['p1'], cmd: 'build-it' },
    { id: 'e2', layer: 'exec', role: 'coder', consume: ['exec/e1.md'], outputs: ['exec/e2.md'], deps: ['e1'], cmd: 'build-more' },
    { id: 'a1', layer: 'audit', role: 'reviewer', consume: ['plan/spec.md', 'exec/e1.md', 'exec/e2.md'], produce: ['audit/a1.md'], deps: ['e2'], cmd: 'verify-it' },
  ];
}

/** **无下游**夹具：e1 不被任何 lane 以 `deps` 引用（a1 的 deps 为空）⇒ e1 结算不受出口交接门约束。
 *  注：① `consume` 仍须非空并真实在场——那是既有 B1「零依赖拒派」门（与本门无关）；
 *      ② `plan/spec.md` 须由 plan lane 声明产出——那是既有 `GATE_PLAN_PRESENCE_MISSING` 建批门。 */
function tasksNoDownstream() {
  return [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'plan-it' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1.md'], cmd: 'build-it' },
    { id: 'a1', layer: 'audit', role: 'reviewer', consume: ['plan/spec.md'], produce: ['audit/a1.md'], cmd: 'verify-it' },
  ];
}

function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-p2settle-'));
  const teamsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-p2settle-teams-'));
  // F2：合成资产（最小三层）⇒ 走单点写入（'helpers/team-fixture.mjs'）。
  writeSyntheticTeam(teamsRoot, TEAM, threeTierSyntheticTeam(TEAM));
  // 【task-27 纪律】测试**不得依赖 ambient env**：本套件用 env 择入开启态，而宿主/父进程可能已带
  //   `PSWARM_HANDOFF_GATE=1`（实测本机即如此）⇒ 不中和会让「以为门关」的派发步骤被 entry 门拦下。
  //   故此处保存并清除，`cleanup` 还原（进程级 env 归零，语义完全由本套件控制）。
  const savedEnv = process.env.PSWARM_HANDOFF_GATE;
  delete process.env.PSWARM_HANDOFF_GATE;
  const store = createStore(root);
  const ctx = { tools: { register: () => {} }, logger: { info() {}, warn() {}, error() {} } };
  const { tools } = createTools(ctx, { store, root });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assessC(store, SESSION, { rationale: 'fixture：P2 结算出口用例的建批前置评估（三层 DAG 多依赖 ⇒ C 档）' });
  clearRoleCache();
  return { root, store, byName, teamsRoot, savedEnv };
}

const eventsOf = (store, batchId) => (store.readBatch(SESSION, batchId)?.events ?? []);
const batchFileOf = (root, batchId) => path.join(root, 'sessions', SESSION, 'batches', batchId + '.json');

function seedArtifact(h, batchId, rel, body = 'out') {
  const abs = path.join(h.root, 'sessions', SESSION, 'artifacts', batchId, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
  return abs;
}

async function mkBatch(h, batchId, { smoke = false, tasks = tasksChain() } = {}) {
  const args = { batchId, team: TEAM, teamsRoot: h.teamsRoot, tasks, assembly: { managerPlan: 'leader-direct', auditLane: 'a1' } };
  if (smoke) args.smoke = true;
  const out = await h.byName.wave_plan.execute(args, SESS);
  await h.byName.batch_phase.execute({ batchId, phase: 'running' }, SESS);
  return out;
}

/** 派发+评审（**门关态**，避免 P1 entry 门抢答）→ 仅 `merged` 一步在**门开态**下执行（精确检出口门）。 */
async function toReview(h, batchId, lane) {
  await h.byName.member_status.execute({ batchId, lane, status: 'running' }, SESS);
  await h.byName.member_status.execute({ batchId, lane, status: 'review' }, SESS);
}
async function settleMerged(h, batchId, lane, note) {
  process.env.PSWARM_HANDOFF_GATE = '1';
  try {
    return await h.byName.member_settle.execute({ batchId, lane, status: 'merged', ...(note ? { note } : {}) }, SESS);
  } finally {
    delete process.env.PSWARM_HANDOFF_GATE;
  }
}
const cleanup = (h) => {
  if (h.savedEnv === undefined) delete process.env.PSWARM_HANDOFF_GATE;
  else process.env.PSWARM_HANDOFF_GATE = h.savedEnv; // 还原 ambient 兜底（不污染同进程后续用例）
  fs.rmSync(h.root, { recursive: true, force: true });
  fs.rmSync(h.teamsRoot, { recursive: true, force: true });
};

// ── ① 有下游 + 无交接 ⇒ 拒 + 回显缺口 ───────────────────────────────────────
test('P2-1 有下游却无已成立交接 ⇒ 拒 GATE_HANDOFF_MISSING + 回显缺口 + lane.handoff.gap 留痕', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'p2-a');
    seedArtifact(h, 'p2-a', 'exec/e1.md');   // exit 门（本 lane 自证产出）满足 ⇒ 拒因**只能**是出口交接门
    seedArtifact(h, 'p2-a', 'plan/spec.md');
    await toReview(h, 'p2-a', 'e1');
    await assert.rejects(() => settleMerged(h, 'p2-a', 'e1'), (e) => {
      assert.match(String(e.message), /^GATE_HANDOFF_MISSING/, '须以新码拒（复用 ④=A 的码）：' + e.message);
      assert.match(String(e.message), /handoff:e1->/, '须回显缺哪条边：' + e.message);
      return true;
    });
    // lane 停在 review（拒态不改成员态，与既有门同语义）
    assert.equal(h.store.readBatch(SESSION, 'p2-a').lanes.e1, 'review', '拒态须保持 review（不落 merged）');
    const gap = eventsOf(h.store, 'p2-a').filter((e) => e.type === EVT.EVT_LANE_HANDOFF_GAP && e.code === 'GATE_HANDOFF_MISSING');
    assert.ok(gap.length >= 1, '须落 lane.handoff.gap 缺口事件（不静默）');
    assert.ok((gap[0].missing ?? []).some((m) => String(m).includes('handoff:e1->')), '缺口事件须含缺哪条边：' + JSON.stringify(gap[0].missing));
  } finally { cleanup(h); }
});

// ── ② 有已成立交接 ⇒ 放行 ──────────────────────────────────────────────────
test('P2-2 至少一条已成立交接 ⇒ 放行（merged 成功）', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'p2-b');
    seedArtifact(h, 'p2-b', 'exec/e1.md');
    seedArtifact(h, 'p2-b', 'plan/spec.md');
    // 交接：e1 → e2（产物在场 + contract 合规）
    const sub = await h.byName.handoff_submit.execute({
      batchId: 'p2-b', from: 'e1', to: 'e2', artifacts: ['exec/e1.md'], assertions: ['e1 产物可被 e2 直接消费'],
    }, SESS);
    assert.equal(sub.ok, true, '前置：交接须提交成功：' + JSON.stringify(sub));
    await toReview(h, 'p2-b', 'e1');
    const r = await settleMerged(h, 'p2-b', 'e1');
    assert.equal(r.status, 'merged', '有已成立交接 ⇒ 放行：' + JSON.stringify(r));
    assert.equal(eventsOf(h.store, 'p2-b').some((e) => e.type === EVT.EVT_LANE_HANDOFF_GAP && e.code === 'GATE_HANDOFF_MISSING'), false,
      '放行 ⇒ 不得落缺口事件');
    // 反证：交接产物被删 ⇒ 同一条 lane 复查会判「不在场」（判据单点复用 entry 门实现）
    fs.rmSync(path.join(h.root, 'sessions', SESSION, 'artifacts', 'p2-b', 'exec/e1.md'), { force: true });
    await h.byName.member_status.execute({ batchId: 'p2-b', lane: 'e2', status: 'running' }, SESS).catch(() => {});
    const v = await h.byName.handoff_view.execute({ batchId: 'p2-b', lane: 'e2' }, SESS);
    const e1edge = v.edges.find((x) => x.from === 'e1');
    assert.equal(e1edge.artifacts[0].readable, false, '产物删除后取件面须如实报不可读（不静默）');
  } finally { cleanup(h); }
});

// ── ③ Leader 例外（human: 证据）⇒ 放行 + 留痕 ────────────────────────────────
test('P2-3 Leader 例外：note 含 human:<裁决人>:<时间>:<结论> ⇒ 放行 + human.decision 留痕', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'p2-c');
    seedArtifact(h, 'p2-c', 'exec/e1.md');
    seedArtifact(h, 'p2-c', 'plan/spec.md');
    await toReview(h, 'p2-c', 'e1');
    const r = await settleMerged(h, 'p2-c', 'e1', 'human:user@2026-09-17:accept');
    assert.equal(r.status, 'merged', 'Leader 例外 ⇒ 放行：' + JSON.stringify(r));
    const hd = eventsOf(h.store, 'p2-c').filter((e) => e.type === EVT.EVT_HUMAN_DECISION);
    assert.equal(hd.length >= 1, true, '例外放行须留痕 human.decision');
    assert.match(String(hd[hd.length - 1].note ?? ''), /handoff-exception:/, '留痕须标明是**交接门例外**（可回溯）：' + JSON.stringify(hd.map((e) => e.note)));
    // 反证：无 human: 证据的 note ⇒ 仍拒
    await mkBatch(h, 'p2-c2');
    seedArtifact(h, 'p2-c2', 'exec/e1.md');
    seedArtifact(h, 'p2-c2', 'plan/spec.md');
    await toReview(h, 'p2-c2', 'e1');
    await assert.rejects(() => settleMerged(h, 'p2-c2', 'e1', '普通备注（无 human 证据）'), /GATE_HANDOFF_MISSING/);
  } finally { cleanup(h); }
});

// ── ④ 无下游 ⇒ 不受本门约束 ─────────────────────────────────────────────────
test('P2-4 无下游的 lane ⇒ 本门零感知（无交接也放行）', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'p2-d', { tasks: tasksNoDownstream() });
    seedArtifact(h, 'p2-d', 'exec/e1.md');
    seedArtifact(h, 'p2-d', 'plan/spec.md');
    await toReview(h, 'p2-d', 'e1');
    const r = await settleMerged(h, 'p2-d', 'e1');
    assert.equal(r.status, 'merged', '无下游 ⇒ 不受出口交接门约束：' + JSON.stringify(r));
    assert.equal(eventsOf(h.store, 'p2-d').some((e) => e.type === EVT.EVT_LANE_HANDOFF_GAP), false, '无下游 ⇒ 零缺口事件（零噪音）');
  } finally { cleanup(h); }
});

// ── ⑤ smoke 批豁免 ──────────────────────────────────────────────────────────
test('P2-5 smoke:true 批 ⇒ 出口交接门豁免（与 P1 同键口径）', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'p2-e', { smoke: true });
    await toReview(h, 'p2-e', 'e1');
    const r = await settleMerged(h, 'p2-e', 'e1');
    assert.equal(r.status, 'merged', 'smoke 批 ⇒ 出口门豁免：' + JSON.stringify(r));
    assert.equal(eventsOf(h.store, 'p2-e').some((e) => e.type === EVT.EVT_LANE_HANDOFF_GAP && e.code === 'GATE_HANDOFF_MISSING'), false,
      'smoke 豁免 ⇒ 不得落缺口事件');
  } finally { cleanup(h); }
});

// ── ⑥（附加）策略态与 legacy 标注可读（Leader 裁决 ①「缺省关不得隐形」+ P2-B）────
test('P2-6 策略态回显 + P2-B 标注：batch_status 给出 handoffGate 实况与 legacy 标注（缺省关不隐形）', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'p2-f');
    const st = await h.byName.batch_status.execute({ batchId: 'p2-f' }, SESS);
    assert.equal(typeof st.handoffGate?.enabled, 'boolean', '须回显交接门开关实况（不得隐形）');
    // 【task-27】`source` 现为三值（`runtime|env|default`）：runtime.json `gates.handoff.*` 优先、env 兜底
    assert.equal(['runtime', 'env', 'default'].includes(String(st.handoffGate?.source)), true,
      '须给出取值来源（runtime|env|default）：' + JSON.stringify(st.handoffGate));
    assert.equal(st.handoffGate.source, 'default', '前置：本进程已中和 env 且未写 runtime.json ⇒ default');
    assert.equal(st.handoffGate.settle === 'enforced' || st.handoffGate.settle === 'observation', true,
      '出口门策略态须二值可辨：' + JSON.stringify(st.handoffGate));
    assert.equal(st.stateSource, 'engine', 'P2-B：引擎侧成员态投影须标 source=engine');
    assert.equal(st.memberStatesLegacy, true, 'P2-B：八态须标 legacy（真源 = 官方 roster 5 态）');
    assert.equal(st.managerRoster?.source, 'roster', 'P2-B：roster 面须标 source=roster');
    // 未开启时 `settle` 必须是 observation（缺省关 = 策略，非隐形）
    assert.equal(st.handoffGate.enabled, false, '前置：本进程未择入 ⇒ enabled=false');
    assert.equal(st.handoffGate.settle, 'observation', '未开启 ⇒ 出口门为观察态（不拦）');
  } finally { cleanup(h); }
});

// ── ⑦（task-25 同批）：`batch_status` 的 P2-B 新增回显字段也要过**自身 output.schema** ──────────
// 背景（真实批次缺陷，2026-09-17）：`handoff_submit` 成功路径 `code: null` 违反自身 schema ⇒ 宿主抛
//   `invalid output`，而写入已落盘 ⇒ **假失败**。同批核查发现 P2-B 给 `batch_status` 新增的
//   `stateSource` / `memberStatesLegacy` / `handoffGate`（及 `managerRoster.source`）也属「新增回显字段」，
//   必须同受该维度回归锁覆盖（禁「加了字段没测 schema」的静默面）。
// 校验器 = **共享单点** `test/helpers/schema-conformance.mjs#schemaViolations`（task-26 清面：两处旧例
//   曾各手写一份）。本组断言语义逐字未变，仅改引用来源。

test('P2-7 新增回显字段的 schema 一致性：batch_status 单批形态与列表形态均满足自身 output.schema', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'p2-g');
    const schema = h.byName.batch_status.output?.schema;
    assert.ok(schema, '前置：工具须暴露 output.schema');
    const single = await h.byName.batch_status.execute({ batchId: 'p2-g' }, SESS);
    assert.deepEqual(schemaViolations(single, schema), [], '单批形态返回值必须满足自身 output.schema（含 P2-B 新增三键）');
    const list = await h.byName.batch_status.execute({}, SESS);
    assert.deepEqual(schemaViolations(list, schema), [], '列表形态返回值必须满足自身 output.schema');
    // P2-B 三键的**类型面**显式锚（不依赖 schema 是否声明）
    assert.equal(typeof single.stateSource, 'string', 'stateSource 须为 string');
    assert.equal(typeof single.memberStatesLegacy, 'boolean', 'memberStatesLegacy 须为 boolean');
    assert.equal(typeof single.handoffGate, 'object', 'handoffGate 须为 object');
    assert.equal(typeof single.handoffGate.enabled, 'boolean', 'handoffGate.enabled 须为 boolean');
    assert.equal(typeof single.handoffGate.source, 'string', 'handoffGate.source 须为 string');
    assert.equal(typeof single.managerRoster?.source, 'string', 'managerRoster.source 须为 string（roster 面标注）');
  } finally { cleanup(h); }
});
