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

// P1 交接门（handoff gate）—— 批次 `p1-handoff-gate-20260917` · 用例面（RED 先行）。
// ─────────────────────────────────────────────────────────────────────────────
// 契约来源（勿另起口径）：`docs/p1-handoff-gate-changeplan-20260917.md`（§2 数据模型 / §3 单点判定 /
//   §7 验收判据 / §8 顺序）+ 用户四项裁决（①=B 存量批放行+留痕 / ②=A 建批期即拒 / ③=A 写唯一路径 store /
//   ④=A 新造码 `GATE_HANDOFF_MISSING`）。
// 验收核心（用户 M-7 原话口径）：**「保证 DAG 内下游成员可以稳定拿到上游产出的依赖」**
//   ⇒ ① 未交接 ⇒ 拒下游开工 **且回显缺哪条边 / 缺哪件产物**；② `handoff_view` 能让下游**列出上游产物与断言、路径可读**。
//
// 覆盖分组：
//   H1 反例（缺入边 / 产物不存在 / contract 缺失）⇒ 拒 + 回显缺口
//   H2 正例（齐备）⇒ 放行；`smoke:true` ⇒ 同分支豁免
//   H3 建批期拒（裁决 ②=A）⇒ 零批次 JSON 落盘
//   H4 `handoff_view` 取件面（M-7 验收核心）：上游产物 + 断言 + 路径可读
//   H5 写权转移（交接提交 ⇒ from 释放 / to 获取：与 lane_claim 配对）
//   H6 存量批（裁决 ①=B）：无 `handoffs` 字段 ⇒ 放行 + `lane.handoff.gap` 留痕；交接不可登记
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// P1 交接门开关**必须在加载门禁/工具模块之前**置位（门读 env；缺省关闭 ⇒ 关闭态行为与 P1 之前逐字不变，
//   见 `lib/wave-plan.js#handoffGateEnabled` 的「迁移安全缝」注释）。本套件专测**开启态**语义。
process.env.PSWARM_HANDOFF_GATE = '1';

import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { assessC } from './helpers/gate-fixture.mjs';
import { writeSyntheticTeam, threeTierSyntheticTeam } from './helpers/team-fixture.mjs';
import { clearRoleCache } from '../lib/assembly/flows.js';
import { schemaViolations } from './helpers/schema-conformance.mjs'; // task-26：schema 一致性校验共享单点
import * as EVT from '../lib/state/event-types.js';

const SESSION = 'sess-handoff';
const SESS = { agent: { session: { id: SESSION } } };
const TEAM = 'handoff-team';

// ── 夹具：临时团队资产（三层；exec 两条同层 lane 构成 DAG：p1 → e1 → e2）──────────────────────

// 两条 exec lane 的 DAG（e1 依赖 plan lane；e2 依赖 e1 ⇒ e2 的入边 = e1 的交接）
function tasks() {
  return [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'plan-it' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1.md'], deps: ['p1'], cmd: 'build-it' },
    { id: 'e2', layer: 'exec', role: 'coder', consume: ['exec/e1.md'], outputs: ['exec/e2.md'], deps: ['e1'], cmd: 'build-more' },
    { id: 'a1', layer: 'audit', role: 'reviewer', consume: ['plan/spec.md', 'exec/e1.md', 'exec/e2.md'], produce: ['audit/a1.md'], deps: ['e2'], cmd: 'verify-it' },
  ];
}

function makeHarness({ config = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-handoff-'));
  const teamsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-handoff-teams-'));
  // F2：合成资产（最小三层）⇒ 走单点写入（'helpers/team-fixture.mjs'）。
  writeSyntheticTeam(teamsRoot, TEAM, threeTierSyntheticTeam(TEAM));
  const store = createStore(root);
  const ctx = { tools: { register: () => {} }, logger: { info() {}, warn() {}, error() {} } };
  const { tools } = createTools(ctx, { store, root, config });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assessC(store, SESSION, { rationale: 'fixture：P1 交接门用例的建批前置评估（三层 DAG 多依赖 ⇒ C 档）' });
  clearRoleCache();
  return { root, store, byName, teamsRoot };
}

const batchFileOf = (root, batchId) => path.join(root, 'sessions', SESSION, 'batches', batchId + '.json');
const eventsOf = (store, batchId) => (store.readBatch(SESSION, batchId)?.events ?? []);

/** 建批 + 武装（推进链/门禁的武装前提 = 相位 running）。 */
async function mkBatch(h, batchId, { smoke } = {}) {
  const args = { batchId, team: TEAM, teamsRoot: h.teamsRoot, tasks: tasks(), assembly: { managerPlan: 'leader-direct', auditLane: 'a1' } };
  if (smoke === true) args.smoke = true;
  const out = await h.byName.wave_plan.execute(args, SESS);
  await h.byName.batch_phase.execute({ batchId, phase: 'running' }, SESS);
  return out;
}

/** 在批次产物根落一件产物（下游取件面）。 */
function seedArtifact(h, batchId, rel, body = 'out') {
  const abs = path.join(h.root, 'sessions', SESSION, 'artifacts', batchId, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
  return abs;
}

/** 派发（pending→running）：走真实 `member_status`，门禁拒态即抛。 */
const dispatch = (h, batchId, lane) => h.byName.member_status.execute({ batchId, lane, status: 'running' }, SESS);

// ── H1：反例 ⇒ 拒 + 回显缺口（缺哪条边 / 缺哪件产物）────────────────────────────

test('P1-H1a 缺入边：下游 e2 有 deps(e1) 但上游未交接 ⇒ 拒 GATE_HANDOFF_MISSING 且回显缺哪条边', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'h1a');
    // 前提：e1 自己的入边（p1）也未交接 ⇒ 先证「不交接就拒」
    await assert.rejects(() => dispatch(h, 'h1a', 'e1'), (e) => {
      assert.match(String(e.message), /^GATE_HANDOFF_MISSING/, '须拒新码（裁决 ④=A）：' + e.message);
      return true;
    });
    // e2 被拒时须回显**缺哪条边**（from->to）
    await assert.rejects(() => dispatch(h, 'h1a', 'e2'), (e) => {
      assert.match(String(e.message), /^GATE_HANDOFF_MISSING/);
      assert.match(String(e.message), /edge:e1->e2|e1->e2/, '须点名缺哪条边：' + e.message);
      return true;
    });
    // 缺口事件留痕（专用事件 `lane.handoff.gap`，不复用 gate.entry.missing）
    const gap = eventsOf(h.store, 'h1a').filter((e) => e.type === EVT.EVT_LANE_HANDOFF_GAP);
    assert.ok(gap.length >= 1, '拒态须落 lane.handoff.gap 留痕');
    assert.equal(gap.every((e) => e.code === 'GATE_HANDOFF_MISSING'), true, '缺口事件码 = GATE_HANDOFF_MISSING');
    assert.equal(eventsOf(h.store, 'h1a').some((e) => e.type === EVT.EVT_GATE_ENTRY_MISSING), false, '交接拒态**不得**复用 gate.entry.missing');
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); fs.rmSync(h.teamsRoot, { recursive: true, force: true }); }
});

test('P1-H1b 产物不存在：交接已提交但 artifacts 的路径不在场 ⇒ 拒且回显缺哪件产物', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'h1b');
    // 交接「合法提交」需要产物在场 ⇒ 先落盘再提交（证明成功路径），随后删除产物复现「提交后在场地消失」
    seedArtifact(h, 'h1b', 'exec/e1.md');
    const sub = await h.byName.handoff_submit.execute({ batchId: 'h1b', from: 'p1', to: 'e1', artifacts: ['exec/e1.md'], assertions: ['e1 已按 spec 实现'] }, SESS);
    assert.equal(sub.ok, true, '产物在场 + 断言非空 ⇒ 交接提交成功：' + JSON.stringify(sub));
    fs.rmSync(path.join(h.root, 'sessions', SESSION, 'artifacts', 'h1b', 'exec/e1.md'), { force: true });
    await assert.rejects(() => dispatch(h, 'h1b', 'e1'), (e) => {
      assert.match(String(e.message), /^GATE_HANDOFF_MISSING/);
      assert.match(String(e.message), /exec\/e1\.md/, '须回显**缺哪件产物**：' + e.message);
      return true;
    });
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); fs.rmSync(h.teamsRoot, { recursive: true, force: true }); }
});

test('P1-H1c 产物不在场时提交被拒：handoff_submit 缺产物 ⇒ GATE_HANDOFF_MISSING + 缺口留痕', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'h1c');
    await assert.rejects(
      () => h.byName.handoff_submit.execute({ batchId: 'h1c', from: 'p1', to: 'e1', artifacts: ['exec/ghost.md'], assertions: ['x'] }, SESS),
      (e) => {
        assert.match(String(e.message), /^GATE_HANDOFF_MISSING/);
        assert.match(String(e.message), /exec\/ghost\.md/, '须回显缺哪件产物：' + e.message);
        return true;
      },
    );
    const gap = eventsOf(h.store, 'h1c').filter((e) => e.type === EVT.EVT_LANE_HANDOFF_GAP);
    assert.ok(gap.length >= 1, '提交被拒同样留痕 lane.handoff.gap（不静默）');
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); fs.rmSync(h.teamsRoot, { recursive: true, force: true }); }
});

test('P1-H1d contract 缺失：提交时空 assertions ⇒ 拒（下游无可核断言可依）', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'h1d');
    seedArtifact(h, 'h1d', 'exec/e1.md');
    await assert.rejects(
      () => h.byName.handoff_submit.execute({ batchId: 'h1d', from: 'p1', to: 'e1', artifacts: ['exec/e1.md'], assertions: [] }, SESS),
      (e) => {
        assert.match(String(e.message), /^GATE_HANDOFF_MISSING/, '空 assertions ⇒ 拒：' + e.message);
        assert.match(String(e.message), /contract\.assertions/, '缺口须点名 contract.assertions：' + e.message);
        return true;
      },
    );
    // 未提交 ⇒ 下游仍被 entry 门拒（交接面不成立）
    await assert.rejects(() => dispatch(h, 'h1d', 'e1'), /GATE_HANDOFF_MISSING/);
    assert.equal((h.store.readBatch(SESSION, 'h1d').handoffs.e1[0] || {}).status, 'pending', '拒态不得改交接状态');
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); fs.rmSync(h.teamsRoot, { recursive: true, force: true }); }
});

// ── H2：正例 + smoke 豁免 ─────────────────────────────────────────────────────

test('P1-H2a 正例：入边齐 + 产物在场 + contract 合规 ⇒ 放行（下游可开工）', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'h2a');
    // 交接门与 consume 在场门是**两道**（前者判上游是否交付、后者判下游声明输入是否在场）⇒ 两者都要齐备才放行
    seedArtifact(h, 'h2a', 'exec/e1.md');   // 交付产物（交接门被检面）
    seedArtifact(h, 'h2a', 'plan/spec.md'); // e1 声明的 consume（entry consume 门被检面）
    const sub = await h.byName.handoff_submit.execute({ batchId: 'h2a', from: 'p1', to: 'e1', artifacts: ['exec/e1.md'], assertions: ['产物 exec/e1.md 覆盖全部需求'] }, SESS);
    assert.equal(sub.ok, true, JSON.stringify(sub));
    const d = await dispatch(h, 'h2a', 'e1');
    assert.equal(d.lanes?.e1 ?? h.store.readBatch(SESSION, 'h2a').lanes.e1, 'running', '交接齐备 ⇒ e1 可开工');
    // 审计事件（每次提交一条）
    const hs = eventsOf(h.store, 'h2a').filter((e) => e.type === EVT.EVT_LANE_HANDOFF);
    assert.equal(hs.length, 1, '每次交接提交落一条 lane.handoff');
    assert.equal(hs[0].handoffBatch, 'h2a', '载荷键 `type` 不得被占用 ⇒ 批 id 写 handoffBatch');
    assert.deepEqual(hs[0].artifacts, ['exec/e1.md']);
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); fs.rmSync(h.teamsRoot, { recursive: true, force: true }); }
});

test('P1-H2b smoke 豁免：smoke:true 批 ⇒ 未交接门走**既有**豁免分支，不新增分支', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'h2b', { smoke: true });
    // 完全未交接 + 无产物 ⇒ 仍放行（与既有 entry-consume 豁免同分支）
    const d = await dispatch(h, 'h2b', 'e1');
    assert.equal(d.lanes?.e1 ?? h.store.readBatch(SESSION, 'h2b').lanes.e1, 'running', 'smoke 批豁免未交接门');
    assert.equal(eventsOf(h.store, 'h2b').some((e) => e.type === EVT.EVT_LANE_HANDOFF_GAP), false, 'smoke 豁免不落缺口告警（同分支跳过）');
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); fs.rmSync(h.teamsRoot, { recursive: true, force: true }); }
});

// ── H3：建批期拒（裁决 ②=A）⇒ 零批次 JSON 落盘 ────────────────────────────────

test('P1-H3 建批期拒：deps 入边的上游未声明交付产物（无交接声明来源）⇒ 拒 + 零批次落盘', async () => {
  const h = makeHarness();
  try {
    // 上游 p1 未声明 produce/outputs ⇒ 无件可交（handoff_submit 的 artifacts 必填）⇒ 建批期即拒
    const bad = [
      { id: 'p1', layer: 'plan', role: 'designer', cmd: 'plan-it' },
      { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1.md'], deps: ['p1'], cmd: 'build-it' },
      { id: 'a1', layer: 'audit', role: 'reviewer', consume: ['exec/e1.md'], produce: ['audit/a1.md'], deps: ['e1'], cmd: 'verify-it' },
    ];
    await assert.rejects(
      () => h.byName.wave_plan.execute({ batchId: 'h3', team: TEAM, teamsRoot: h.teamsRoot, tasks: bad }, SESS),
      (e) => {
        assert.match(String(e.message), /^GATE_HANDOFF_MISSING/, '须以新码拒建批：' + e.message);
        assert.match(String(e.message), /edge:p1->e1/, '须回显缺哪条边：' + e.message);
        return true;
      },
    );
    assert.equal(fs.existsSync(batchFileOf(h.root, 'h3')), false, '拒后**零批次 JSON 落盘**');
    // 对照：同形 tasks 但上游声明交付产物 ⇒ 建批成功（证 H3 拒的是缺口本身，不是环境）
    const okOut = await h.byName.wave_plan.execute({ batchId: 'h3-ok', team: TEAM, teamsRoot: h.teamsRoot, tasks: tasks(), assembly: { managerPlan: 'leader-direct', auditLane: 'a1' } }, SESS);
    assert.ok(okOut.lanes.p1 === 'pending');
    // 建批期意图声明已种：e1 的入边一条（pending），e2 的入边一条
    const b = h.store.readBatch(SESSION, 'h3-ok');
    assert.equal(Array.isArray(b.handoffs.e1), true, 'e1 入边在建批期已种条（裁决 ②=A 的判据来源）');
    assert.equal(b.handoffs.e1[0].from, 'p1');
    assert.equal(b.handoffs.e1[0].status, 'pending', '种条初态 = pending（未交接）');
    assert.equal(b.handoffs.e2[0].from, 'e1');
    // 悬空 id（不存在的上游）仍由 topoWaves 原样报（本门不抢答其语义）
    await assert.rejects(
      () => h.byName.wave_plan.execute({
        batchId: 'h3-dangling', team: TEAM, teamsRoot: h.teamsRoot,
        tasks: [{ id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'p' },
          { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1.md'], deps: ['ghost-upstream'], cmd: 'e' }],
      }, SESS),
      /unknown id: ghost-upstream/,
    );
    assert.equal(fs.existsSync(batchFileOf(h.root, 'h3-dangling')), false, '悬空 id 同样零批次落盘');
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); fs.rmSync(h.teamsRoot, { recursive: true, force: true }); }
});

// ── H4：handoff_view（M-7 验收核心：下游能稳定取件）─────────────────────────────

test('P1-H4 handoff_view：列出上游产物与断言，**路径可读**；未交接时给出可照单补齐的缺口', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'h4');
    seedArtifact(h, 'h4', 'exec/e1.md', 'e1 payload');
    // 未交接 ⇒ blocked + 缺口清单
    const before = await h.byName.handoff_view.execute({ batchId: 'h4', lane: 'e2' }, SESS);
    assert.equal(before.ready, false, '未交接 ⇒ 不可开工');
    assert.equal(before.blocking.length > 0, true, '须给出缺口清单：' + JSON.stringify(before.blocking));
    assert.equal(before.pending.includes('e1->e2'), true, 'pending 入边须点名：' + JSON.stringify(before.pending));
    assert.equal(before.edges[0].upstreamDeclared.includes('exec/e1.md'), true, '须回显上游 produce∪outputs 声明清单');

    // 交接后 ⇒ ready + 产物路径可读 + 断言可读（M-7 核心）
    const sub = await h.byName.handoff_submit.execute({ batchId: 'h4', from: 'e1', to: 'e2', artifacts: ['exec/e1.md'], assertions: ['e1 产物可被 e2 直接消费'] }, SESS);
    assert.equal(sub.ok, true, JSON.stringify(sub));
    const after = await h.byName.handoff_view.execute({ batchId: 'h4', lane: 'e2' }, SESS);
    assert.equal(after.ready, true, '交接齐备 ⇒ ready：' + JSON.stringify(after.blocking));
    assert.deepEqual(after.blocking, []);
    const edge = after.edges.find((x) => x.from === 'e1');
    assert.equal(edge.status, 'submitted');
    assert.equal(edge.artifacts.length, 1, '须列交付产物');
    assert.equal(edge.artifacts[0].path, 'exec/e1.md');
    assert.match(edge.artifacts[0].abs, /exec[\\/]e1\.md$/, '须给出解析后的绝对路径（下游可直接取件）');
    assert.equal(edge.artifacts[0].readable, true, '**路径须可读**（M-7 验收核心）');
    assert.deepEqual(edge.assertions, ['e1 产物可被 e2 直接消费'], '须回显上游断言');
    assert.equal(edge.consumedFrom, 'e1', '消费证据 = contract.consumedFrom');
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); fs.rmSync(h.teamsRoot, { recursive: true, force: true }); }
});

// ── H5：写权转移（交接提交 ⇒ from 释放 / to 获取；与 lane_claim 配对）──────────

test('P1-H5 写权转移：交接提交后 to lane 可被本会话认领（from 的持有面回显在 lockTransfer）', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'h5');
    seedArtifact(h, 'h5', 'exec/e1.md');
    const sub = await h.byName.handoff_submit.execute({ batchId: 'h5', from: 'p1', to: 'e1', artifacts: ['exec/e1.md'], assertions: ['ok'] }, SESS);
    assert.equal(sub.ok, true, JSON.stringify(sub));
    assert.equal(typeof sub.lockTransfer, 'object', '须回显写权转移面（与既有 lane_claim 配对耦合，不另造锁）');
    assert.equal(sub.lockTransfer.toAcquire, 'acquired', '交接成立 ⇒ 下游 lane 写权可取：' + JSON.stringify(sub.lockTransfer));
    // 与既有 lane_claim 配对：下游此时确已被本会话持有（再认领即冲突，证明「已获取」为事实）
    const again = await h.byName.lane_claim.execute({ batchId: 'h5', lane: 'e1' }, SESS);
    assert.equal(again.ok, false, '下游写权已由交接取得 ⇒ 再次认领冲突（证 not 空转）');
    assert.equal(again.conflict, true);
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); fs.rmSync(h.teamsRoot, { recursive: true, force: true }); }
});

// ── H6：存量批（裁决 ①=B）⇒ 放行 + 留痕；交接不可登记 ────────────────────────

test('P1-H6 存量批：无 batch.handoffs 字段 ⇒ 未交接门放行 + lane.handoff.gap{legacy:true} 留痕', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'h6');
    // 造存量形态：删字段（模拟本门上线**之前**建的批）
    const file = batchFileOf(h.root, 'h6');
    const b = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete b.handoffs;
    fs.writeFileSync(file, JSON.stringify(b), 'utf8');
    seedArtifact(h, 'h6', 'plan/spec.md'); // 满足**既有** consume 门（本用例只验证未交接门的存量批语义）
    const d = await dispatch(h, 'h6', 'e1');
    assert.equal(d.lanes?.e1 ?? h.store.readBatch(SESSION, 'h6').lanes.e1, 'running', '存量批不因新门被全拒（不砸存量）');
    const legacyGap = eventsOf(h.store, 'h6').filter((e) => e.type === EVT.EVT_LANE_HANDOFF_GAP && e.legacy === true);
    assert.ok(legacyGap.length >= 1, '须留痕告警（不静默）');
    // 【R3-2 收紧】原断言只用 `legacy === true` 作判别符 —— 它是**入口/出口两侧共有**的标记，
    //   锁不住「本条是入口侧」。补断言载荷 `code`（`GateErrorCode` 成员，机器可读契约）
    //   ⇒ 出口侧同族码 `GATE_HANDOFF_SETTLE_LEGACY_PASSTHROUGH` 另由
    //   `test/gate-assertion-r32.test.js` 的专用用例覆盖。
    assert.equal(legacyGap[0].code, 'GATE_HANDOFF_LEGACY_PASSTHROUGH',
      '须点名**入口侧**存量批放行码（可审计归因）：' + JSON.stringify(legacyGap[0]));
    // 交接载体不存在 ⇒ 登记明确拒（不静默、不凭空给存量批开新门）。
    //   注：产物**先落盘**——否则会先命中「产物不在场」判据（那是对新建批的正当拒态，但盖住本用例的被检面）。
    seedArtifact(h, 'h6', 'exec/e1.md');
    await assert.rejects(
      () => h.byName.handoff_submit.execute({ batchId: 'h6', from: 'p1', to: 'e1', artifacts: ['exec/e1.md'], assertions: ['x'] }, SESS),
      (e) => {
        assert.match(String(e.message), /^GATE_HANDOFF_MISSING/, '存量批不可登记交接（载体不存在）：' + e.message);
        assert.match(String(e.message), /batch\.handoffs/, '须点名缺失的载体：' + e.message);
        return true;
      },
    );
    // handoff_view 对存量批如实标 legacy 且不误判阻塞
    const v = await h.byName.handoff_view.execute({ batchId: 'h6', lane: 'e2' }, SESS);
    assert.equal(v.legacy, true, '须回显 legacy（门整体放行语义）');
    assert.equal(v.ready, true);
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); fs.rmSync(h.teamsRoot, { recursive: true, force: true }); }
});

// ── H7（task-22）：交接面两件「成员面 + 常驻注册」──
// 依据 `task-22` 裁决：① `handoff_submit` 归 `comms` 族（成员面，**不落模式门**）；② 两件**恒注册**。
// 本用例给出**行为面**证据（非仅注册表读数）：
//   · 对照组 `member_status`（governance/modeGate:true）在非生效模式 + 成员上下文下**必被** `GATE_MODE_INACTIVE` 拒；
//   · `handoff_submit` 同条件下**不得**抛模式门（走到业务判定）⇒ 证明成员可调、不被 deny 摘除。
test('P1-H7 成员面 + 常驻注册：handoff_submit 不落模式门（成员可调），且两件不入 deny 集', async () => {
  // 非生效模式：白名单只含别的 preset，调用方 header 为 'standard'
  const h = makeHarness({ config: { modes: { gate: ['punky-preset'] } } });
  const memberExec = { agent: { session: { id: SESSION, header: { agentPreset: 'standard' } } } };
  try {
    // 常驻注册（不需要 PSWARM_HANDOFF_GATE）
    assert.ok(h.byName.handoff_submit, 'handoff_submit 须常驻注册（工具是机制、门是策略）');
    assert.ok(h.byName.handoff_view, 'handoff_view 须常驻注册');
    // 对照组：治理写面在非生效模式下被模式门拒（证明本环境**门是活的**，不是空转）
    await assert.rejects(
      () => h.byName.member_status.execute({ batchId: 'x', lane: 'l1', status: 'review' }, memberExec),
      /GATE_MODE_INACTIVE/,
      '对照组：member_status 必须在非生效模式被模式门拒（否则本用例无区分力）',
    );
    // 被检面：handoff_submit 不落模式门 ⇒ 走到业务判定（批不存在）
    await assert.rejects(
      () => h.byName.handoff_submit.execute({ batchId: 'ghost', from: 'a', to: 'b', artifacts: ['x.md'], assertions: ['ok'] }, memberExec),
      (e) => {
        assert.ok(!/GATE_MODE_INACTIVE/.test(String(e.message)), 'handoff_submit 为成员面 ⇒ 不得落模式门：' + e.message);
        assert.match(String(e.message), /batch not found/, '应走到业务判定（批不存在）而非门禁拒：' + e.message);
        return true;
      },
    );
    // 注册表面（与行为面同源）：两件均不入 deny / 模式门集
    const { SUITE_DENY_TOOLS, MODE_GATED_TOOLS } = await import('../lib/engine/dispatch.js');
    assert.equal(SUITE_DENY_TOOLS.includes('handoff_submit'), false, 'handoff_submit 成员面 ⇒ 不入 deny 集');
    assert.equal(MODE_GATED_TOOLS.includes('handoff_submit'), false, 'handoff_submit comms 族 ⇒ 不入模式门集');
    assert.equal(SUITE_DENY_TOOLS.includes('handoff_view'), false, 'handoff_view 只读面 ⇒ 不入 deny 集');
    assert.equal(MODE_GATED_TOOLS.includes('handoff_view'), false, 'handoff_view 只读面 ⇒ 不入模式门集');
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
    fs.rmSync(h.teamsRoot, { recursive: true, force: true });
  }
});

// ── H8（task-25 缺陷修复）：**output.schema 一致性**维度（夹具层此前完全缺失）──
// 真实批次实测（2026-09-17）：`handoff_submit` 写入成功、但返回值 `code: null` 违反自身
//   `output.schema` 的 `"code":{"type":"string"}` ⇒ 宿主抛
//   `tool "handoff_submit" returned invalid output: "value.code" must be a string`
//   ⇒ **假失败**（数据已落盘、调用方却以为失败，可能重试 ⇒ 重复交接）。
// 本组断言即该维度的回归锁：**取工具描述里的 `output.schema`，校验其真实返回值**（成功与拒态各一）。
// 校验器 = **共享单点** `test/helpers/schema-conformance.mjs#schemaViolations`（task-26 清面：两处旧例
//   曾各手写一份）。本组断言语义逐字未变，仅改引用来源。

test('P1-H8a output.schema 一致性：handoff_submit **成功路径**返回值满足自身 schema', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'h8a');
    seedArtifact(h, 'h8a', 'exec/e1.md');
    const out = await h.byName.handoff_submit.execute({
      batchId: 'h8a', from: 'p1', to: 'e1', artifacts: ['exec/e1.md'], assertions: ['e1 可消费 p1 产物'],
    }, SESS);
    assert.equal(out.ok, true, '前置：须为成功路径：' + JSON.stringify(out));
    // schema 由**工具描述**取出（与宿主校验同一来源），不是测试自造的期望
    const schema = h.byName.handoff_submit.output?.schema;
    assert.ok(schema, '前置：工具须暴露 output.schema');
    assert.deepEqual(schemaViolations(out, schema), [], '成功返回值必须满足自身 output.schema（本缺陷 = code 非字符串 ⇒ 宿主 invalid output）');
    assert.equal(typeof out.code, 'string', '成功路径的 `code` 须为稳定字符串（不得为 null）：' + JSON.stringify(out.code));
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); fs.rmSync(h.teamsRoot, { recursive: true, force: true }); }
});

test('P1-H8b output.schema 一致性：handoff_submit **拒态**抛业务码（不得是 schema 校验错）', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'h8b');
    let msg = '';
    try {
      await h.byName.handoff_submit.execute({ batchId: 'h8b', from: 'p1', to: 'e1', artifacts: ['exec/ghost.md'], assertions: ['x'] }, SESS);
    } catch (e) { msg = String(e.message); }
    assert.match(msg, /^GATE_HANDOFF_MISSING/, '拒态须以业务码抛出：' + msg);
    assert.ok(!/invalid output/.test(msg), '拒态**不得**表现为「返回值不满足 schema」的宿主校验错：' + msg);
    assert.ok(!/must be a string|must be a boolean|must be an integer|must be an array/.test(msg), '拒态不得夹带 schema 型校验错：' + msg);
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); fs.rmSync(h.teamsRoot, { recursive: true, force: true }); }
});

test('P1-H8c output.schema 一致性：handoff_view **未交接态**返回值满足自身 schema', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'h8c');
    const out = await h.byName.handoff_view.execute({ batchId: 'h8c', lane: 'e2' }, SESS);
    const schema = h.byName.handoff_view.output?.schema;
    assert.ok(schema, '前置：工具须暴露 output.schema');
    assert.deepEqual(schemaViolations(out, schema), [], 'blocked 态返回值必须满足自身 output.schema');
    assert.equal(out.ready, false, '前置：本态应为未交接（blocked）');
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); fs.rmSync(h.teamsRoot, { recursive: true, force: true }); }
});

test('P1-H8d output.schema 一致性：handoff_view **ready 态**返回值满足自身 schema', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'h8d');
    seedArtifact(h, 'h8d', 'exec/e1.md');
    const sub = await h.byName.handoff_submit.execute({ batchId: 'h8d', from: 'e1', to: 'e2', artifacts: ['exec/e1.md'], assertions: ['ok'] }, SESS);
    assert.equal(sub.ok, true, JSON.stringify(sub));
    const out = await h.byName.handoff_view.execute({ batchId: 'h8d', lane: 'e2' }, SESS);
    const schema = h.byName.handoff_view.output?.schema;
    assert.deepEqual(schemaViolations(out, schema), [], 'ready 态返回值必须满足自身 output.schema');
    assert.equal(out.ready, true, '前置：本态应为 ready');
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); fs.rmSync(h.teamsRoot, { recursive: true, force: true }); }
});
