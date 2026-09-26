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

// R3-1 门禁断言补测：两枚**收口主门**的生产路径 E2E 断言。
//   上游 = `docs/frozen-register-2026-09-21.md` §3（写本波时 11 枚无断言门禁；R3-1 补测后余 9 枚，裁定 ② 后"冻结不删"）
//         + §6.5 纪律「缺断言 ⇒ 先补测，补完再判要不要删」
//         + `docs/gate-assertion-blueprint-2026-09-21.md`（本波蓝图，先落盘后施工）
//
// 为什么是这两枚：§3 的「P0 三枚」经复核为 **两枚**——第三枚 `GATE_ARTIFACT_MISSING` 是出口门
//   **内部哨兵**，按设计被重写为 `GATE_EXIT_MISSING_<LAYER>` 才外显，而该外显形态已有 **12 处断言 / 3 套件**
//   （v3 台账去注释口径：`gate-flows.test.js` ×2 · `gate-hardening-red.test.js` ×9 · `gates.test.js` ×1；
//    原始文本含注释另计 3 处 ⇒ 共 15 处 / 5 文件）
//   ⇒ 属**假缺口**，本文件**刻意不写**它的裸码断言（那等于把内部实现焊进测试）。
//
// 驱动纪律（蓝图 §1.2）：**走生产写路径**——`wave_plan` 工具建批 + `store.setMember` / `store.setPhase`
//   （`lib/state/store.js` 是唯一写者），**不**用 `createGates(...).checkCompleteGate(batch)` 直调。
//   白盒直调「绿」正是本波要治的病：白盒绿 ≠ 生产路径走过。
//
// 威胁模型来源（A1 用例的正当性）：`lib/wave-plan.ts:465` 逐字「§11.A（A1 双点：主防线 = 建批期，
//   二级防线 = 运行期 `checkCompleteGate`）」⇒ 收口门存在的意义就是拦「建批后被改图 / 存量漂移」形态的批，
//   A1 用例**只改持久化 `wavePlan`**（`layersOf` 只读 `wavePlan`）正是该形态的最小复现。
//
// 夹具纪律：不修改仓库内任何 `presets/**` 真实资产（直接用包内 `software-team`，`team` 不传 `teamsRoot`
//   即解析包内资产）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from '../lib/state/store.js';
import { createTools } from '../lib/tools/register.js';
import * as EVT from '../lib/state/event-types.js';
import { compareBaseline, findRepoRoot, readBaseline, scanTree } from '../scripts/baseline-snapshot-core.mjs';
import { assessC } from './helpers/gate-fixture.mjs';

const SESS_ID = 'sess-r3';
const SESS = { agent: { session: { id: SESS_ID } } };
const TEAM = 'software-team';
const CODE_NO_AUDIT = 'GATE_COMPLETE_NO_AUDIT';
const CODE_EXEC_PENDING = 'GATE_COMPLETE_EXEC_PENDING';
const EVT_COMPLETE_BLOCKED = EVT.EVT_GATE_COMPLETE_BLOCKED ?? 'gate.complete_blocked';

// ── 夹具 ─────────────────────────────────────────────────────────────────────
// `software-team` 的 `flows.audit.audit_contract.consumes_required` = ['plan/','exec/']
// ⇒ audit lane 必须**同时**消费 plan 与 exec 产物（引擎既有 `GATE_AUDIT_INPUT_MISSING` 通用纪律）。
function tasks3() {
  return [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1.md'], deps: ['p1'], cmd: 'code' },
    { id: 'a1', layer: 'audit', role: 'supervisor', consume: ['plan/spec.md', 'exec/e1.md'], produce: ['audit/a1.md'], deps: ['e1'], cmd: 'accept' },
  ];
}

function makeHarness(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-' + tag + '-'));
  const store = createStore(root);
  const ctx = { tools: { register: () => {}, guard: () => {} }, logger: console };
  const { tools } = createTools(ctx, { store, root });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  // `wave_plan` 属 C 档动作（G1 门）⇒ 先按 `assign_check` 的同一落盘函数写「已评估为 C」
  assessC(store, SESS_ID, { rationale: 'R3-1 补测前置：wave_plan 属 C 档动作（三层治理面）' });
  return { root, store, byName };
}

const batchFileOf = (root, batchId) => path.join(root, 'sessions', SESS_ID, 'batches', batchId + '.json');

/** 播种三层批的声明产物（plan 判据正文含裸标题 `## 验收标准`）。 */
function seedTierFiles(root, batchId) {
  const entries = [
    ['plan/spec.md', '# spec\n## 验收标准\n- x\n## 约束\n- y\n'],
    ['exec/e1.md', 'out'],
    ['audit/a1.md', 'review'],
  ];
  for (const [rel, content] of entries) {
    const abs = path.join(root, 'sessions', SESS_ID, 'artifacts', batchId, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}

async function buildRunningBatch(byName, root, batchId, tasks) {
  const out = await byName.wave_plan.execute({
    batchId, team: TEAM, tasks,
    assembly: { auditLane: 'a1', managerPlan: 'leader-direct' },
  }, SESS);
  assert.equal(out.batchId, batchId, '建批成功（夹具前提；失败则本用例的拒因不可归因）');
  await byName.batch_phase.execute({ batchId, phase: 'running' }, SESS);
  seedTierFiles(root, batchId);
}

const runLane = (store, batchId, lane, stopAt) => {
  for (const s of ['running', 'review', 'merged']) {
    store.setMember(SESS_ID, batchId, lane, s);
    if (s === stopAt) return;
  }
};

// 批不存在（建批被拒）时读端返回 `undefined` ⇒ 归一化为空列表，使「零事件」在两种形态下等效
const blockedEvents = (store, batchId) =>
  ((store.readBatch(SESS_ID, batchId) ?? {}).events ?? []).filter((e) => e && e.type === EVT_COMPLETE_BLOCKED);

// ═══════════════════════════════════════════════════════════════════════════════
// (A) `GATE_COMPLETE_NO_AUDIT` —— 收口门作为**二级防线**
// ═══════════════════════════════════════════════════════════════════════════════
test('R3-1-A1：批内无 audit 层 ⇒ complete 拒 GATE_COMPLETE_NO_AUDIT（真机路径 + 落痕 + 不推进）', async () => {
  const { root, store, byName } = makeHarness('noaudit');
  const batchId = 'r3-noaudit';
  await buildRunningBatch(byName, root, batchId, tasks3());
  runLane(store, batchId, 'p1');
  runLane(store, batchId, 'e1');
  runLane(store, batchId, 'a1');
  assert.equal(store.readBatch(SESS_ID, batchId).phase, 'running', '前置：批仍处 running');

  // 只改**持久化 `wavePlan`**：剔除全部 audit task（模拟「建批后被改图 / 存量漂移」形态）。
  // `gates.layersOf` 逐字只读 `batch.wavePlan`（`lib/state/gates.ts:611-615`）⇒ 这是该形态的最小复现。
  // 主防线（建批期）在 A2 已证会先拦 ⇒ 此处只能经漂移到达，正是二级防线的被检面。
  const bf = batchFileOf(root, batchId);
  const raw = JSON.parse(fs.readFileSync(bf, 'utf8'));
  raw.wavePlan = raw.wavePlan.map((w) => ({
    ...w, tasks: (w.tasks ?? []).filter((t) => t && t.layer !== 'audit'),
  }));
  fs.writeFileSync(bf, JSON.stringify(raw, null, 2), 'utf8');

  assert.throws(
    () => store.setPhase(SESS_ID, batchId, 'complete'),
    new RegExp(CODE_NO_AUDIT),
    'audit 层为空 ⇒ 拒收口（本码此前零断言）',
  );
  assert.equal(store.readBatch(SESS_ID, batchId).phase, 'running', '被拒 ⇒ 相位不得推进（拒即可见、不可静默前进）');
  const blocked = blockedEvents(store, batchId);
  assert.equal(blocked.length, 1, 'gate.complete_blocked 落痕一次（可审计）');
  assert.equal(blocked[0].code, CODE_NO_AUDIT, '落痕码与抛出码同源');
});

test('R3-1-A2：对偶——有 exec 必有 audit 在**建批期**先拦（主防线在位、且不落盘）', async () => {
  const { root, store, byName } = makeHarness('dualfirst');
  const batchId = 'r3-dualfirst';
  const tasksNoAudit = tasks3().filter((t) => t.layer !== 'audit');
  await assert.rejects(
    () => byName.wave_plan.execute({
      batchId, team: TEAM, tasks: tasksNoAudit,
      assembly: { auditLane: 'a1', managerPlan: 'leader-direct' },
    }, SESS),
    /three-tier: exec layers require at least one audit lane/,
    '建批期即拒（`lib/wave-plan.ts` validateLayerContract）⇒ A1 的形态不可能由正常建批产生',
  );
  assert.equal(fs.existsSync(batchFileOf(root, batchId)), false, 'fail-closed：被拒批不得留下半成品批次文件');
  // `readBatch` 对不存在的批返回 `undefined`（不是 `null`）⇒ 归一化后断言，避免把读端形态差异当门禁行为
  assert.equal(store.readBatch(SESS_ID, batchId) ?? null, null, '读端同证：批次不存在');
  assert.deepEqual(blockedEvents(store, batchId), [], '建批期拒不留 complete_blocked 痕（那是收口面的事件）');
});

// ═══════════════════════════════════════════════════════════════════════════════
// (B) `GATE_COMPLETE_EXEC_PENDING` —— exec 未全终态即拒收口（+ 反向锁）
// ═══════════════════════════════════════════════════════════════════════════════
test('R3-1-B1：exec 层未全终态 ⇒ complete 拒 GATE_COMPLETE_EXEC_PENDING（含 pending 回显）', async () => {
  const { root, store, byName } = makeHarness('pending');
  const batchId = 'r3-pending';
  await buildRunningBatch(byName, root, batchId, tasks3());
  runLane(store, batchId, 'p1');
  runLane(store, batchId, 'a1');            // audit 已终态 ⇒ 判据门先过，才轮到 exec 面
  runLane(store, batchId, 'e1', 'running'); // exec 停在 running（本用例的被检面）

  // `assert.throws` **不返回**捕获到的错误（Node 语义）⇒ 手捕以核 message 载荷
  let err = null;
  try {
    store.setPhase(SESS_ID, batchId, 'complete');
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'audit 全终态但 exec 未终态 ⇒ 拒收口（本码此前零断言）');
  assert.match(String(err.message), new RegExp(CODE_EXEC_PENDING), '抛出码正确');
  assert.match(String(err.message), /: e1\b/, 'pending 回显待收 lane（写端 `store.js` 拼进 message）');
  assert.equal(store.readBatch(SESS_ID, batchId).phase, 'running', '被拒 ⇒ 相位不得推进');
  const blocked = blockedEvents(store, batchId);
  assert.equal(blocked.length, 1, 'gate.complete_blocked 落痕一次');
  assert.equal(blocked[0].code, CODE_EXEC_PENDING, '落痕码与抛出码同源');
  assert.deepEqual(blocked[0].pending, ['e1'], '落痕载荷逐字带 pending 名单（可定位到 lane）');
});

test('R3-1-B2 反向锁：同夹具只把 exec 结算到 merged ⇒ complete 放行（证 B1 拒因是 pending 本身）', async () => {
  const { root, store, byName } = makeHarness('green');
  const batchId = 'r3-green';
  await buildRunningBatch(byName, root, batchId, tasks3());
  runLane(store, batchId, 'p1');
  runLane(store, batchId, 'a1');
  runLane(store, batchId, 'e1'); // 与 B1 **唯一差异**：exec 走完终态

  const b = store.setPhase(SESS_ID, batchId, 'complete');
  assert.equal(b.phase, 'complete', '全部 lane 终态 ⇒ 收口放行（夹具形态本身合规，B1 的拒归因于 pending）');
  assert.deepEqual(blockedEvents(store, batchId), [], '放行路径不得留 complete_blocked 痕');
});

// ═══════════════════════════════════════════════════════════════════════════════
// (C) 基线对账（生成物同批纪律：本文件须已登记进 `baselines/test-baseline.json`）
// ═══════════════════════════════════════════════════════════════════════════════
test('R3-1-C：基线对账零漂移，且本文件已登记（防「加测试忘更新基线」）', () => {
  const ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
  const baseline = readBaseline(ROOT);
  const cmp = compareBaseline(baseline, scanTree(ROOT));
  assert.equal(cmp.ok, true, '基线对账须 0 漂移；逐文件变化=' + JSON.stringify(cmp.filesChanged));
  assert.ok(cmp.asserts.delta >= 0, '断言调用数不得低于基线（禁静默删断言）；delta=' + String(cmp.asserts.delta));
  assert.ok(cmp.tautologies.delta <= 0, '恒真形态命中数不得上升（禁等价替换）；delta=' + String(cmp.tautologies.delta));
  const mine = baseline.files?.['test/complete-tier-gate-e2e.test.js'];
  assert.ok(mine, '本文件须在 baselines/test-baseline.json 中登记（node scripts/baseline-snapshot.mjs --reason "…"）');
  assert.ok(mine.asserts > 0, '本文件新增断言数 > 0；实测 asserts=' + String(mine.asserts));
  assert.ok(mine.tests > 0, '本文件新增用例数 > 0；实测 tests=' + String(mine.tests));
});
