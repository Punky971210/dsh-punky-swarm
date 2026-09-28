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

// GAP-S2 回归锁（批次 `smoke-chain-20260916` 实测缺陷）。
//
// 症状：audit lane 已 `merged`，`batch_phase({phase:'complete'})` 仍被拒
//   `GATE_COMPLETE_AUDIT_FAILED`（事件 `gate.complete_blocked` @2026-09-16T12:14:48.201Z）。
// 根因：`checkCompleteGate` 的有效白名单 = `flows.audit.audit_contract.verdict ∩ {pass,skip}`；
//   资产把 verdict 写成**产物层裁决词**（如 ["approve","reject"]）时交集为空 ⇒ `offenders` 覆盖全部
//   audit lane ⇒ complete **恒拒**；而建批 / 资产加载期**零告警**，真因只藏在载荷 `narrowed` 里
//   ⇒ 不读 `gates.ts` 无法定位（静默性即本任务修复对象）。
//
// 修复面（三件，逐条对应用例分组）：
//   (A) 运行期：交集为空 ⇒ **专用码** `GATE_COMPLETE_OUTCOMES_EMPTY` + 回显 declared / narrowed / values
//       （写端 `lib/state/gates.ts` 的 `checkCompleteGate`；判定**零放宽**：ok:false 不变、fail/conflict 恒拒不变）；
//   (B) 建批期：同型资产 ⇒ `wave_plan` 的 `warnings` 产一条同码告警（**批次照建、不拒建批**；
//       通道 = 既有 `plan.warnings`，**不走** `lib/assembly/team-asset.js` 的 `problems` —— 那条会把
//       `ok` 打成 false（`ok = problems.length === 0`）⇒ 读端 `!r.ok` 判死 ⇒ 误拒建批）；
//   (C) 反例锁：正常词表 / 缺声明两态**不得**误报；基线对账断言删除数为 0。
//
// 夹具纪律：**不修改仓库内任何 `presets/**` 真实资产** —— 「坏 verdict 资产」由临时 `teamsRoot`
//   复制 `software-team` 资产骨架后**改一处**构造。
// verdict 取值域（成员终态词）见 `presets/punky-preset/references/discipline.md` 的 verdict 行。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGates } from '../lib/state/gates.js';
import { createStore } from '../lib/state/store.js';
import { createTools } from '../lib/tools/register.js';
import { clearFlowCache } from '../lib/assembly/flows.js';
import * as EVT from '../lib/state/event-types.js';
import { compareBaseline, findRepoRoot, readBaseline, scanTree } from '../scripts/baseline-snapshot-core.mjs';
import { SPEC_OK, assessC } from './helpers/gate-fixture.mjs';
// 【2026-09-27 批 3 · T-15/D-6 归因】原 `writeTempTeam` 具名导入已删除项（真实骨架已删，T-4/A-9）；
//   `writeSyntheticTeam` 仍由 `writeTeamFlow` 使用 ⇒ 保留。
import { writeSyntheticTeam } from './helpers/team-fixture.mjs';

const SESS_ID = 'sess-s2';
const SESS = { agent: { session: { id: SESS_ID } } };
const CODE = 'GATE_COMPLETE_OUTCOMES_EMPTY';
const EVT_COMPLETE_BLOCKED = EVT.EVT_GATE_COMPLETE_BLOCKED ?? 'gate.complete_blocked';

// ═══════════════════════════════════════════════════════════════════════════════
// (1)(2)(3) 纯门禁夹具：`createGates(state,{flowsRoot})` 直读临时资产（不经工具面 ⇒ 无技能面校验）
// ═══════════════════════════════════════════════════════════════════════════════
function mkRoots() {
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 's2-pkg-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 's2-state-'));
  fs.mkdirSync(path.join(pkg, 'presets'), { recursive: true });
  fs.mkdirSync(path.join(state, 'sessions', SESS_ID, 'batches'), { recursive: true });
  fs.mkdirSync(path.join(state, 'sessions', SESS_ID, 'artifacts'), { recursive: true });
  return { pkg, state };
}

function writeTeamFlow(pkg, team, flows) {
  // F2：合成资产 ⇒ 走单点（显式标注为自造；本文件测的是 `createGates` 直读临时资产的门禁面）。
  return writeSyntheticTeam(pkg, team, { team, layers: { plan: { roles: ['designer'], skills: { designer: ['spec-writing'] } } }, flows }, { filename: 'team-asset.yml' });
}

// wavePlan 持久形态 = [{ tasks }]（事实源：lib/state/task-utils.js 的 `for (const w of batch.wavePlan ?? [])`）
const batchOf = (team, tasks) => ({
  batchId: 'b1', team, createdAt: '2026-09-16T00:00:00.000Z', lanes: {}, events: [], wavePlan: [{ wave: 1, tasks }],
});

const auditTasks = () => [
  { id: 'e1', layer: 'exec', outputs: ['exec/o.md'] },
  { id: 'a1', layer: 'audit', produce: ['audit/r.md'] },
];

/** audit lane 已到指定终态（complete 门只在这些终态判定后才做白名单核对）。 */
function batchWithAuditState(team, auditState) {
  const b = batchOf(team, auditTasks());
  b.lanes = { e1: 'merged', a1: auditState };
  return b;
}

function flowsWithVerdict(verdict) {
  const audit = { produce_field: 'produce' };
  if (verdict !== null) audit.audit_contract = { verdict };
  return { plan: { produce_field: 'produce' }, exec: { produce_field: 'outputs' }, audit };
}

// ── 已删（2026-09-27 批 3 · T-15/D-6 归因）：原 test「GAP-S2-A1：verdict 与 {pass,skip} 交集为空 ⇒ 专用码
//    + declared/narrowed/values 载荷（audit merged 仍拒）」──
//   面已消失 = **团队资产 `flows.audit.audit_contract.verdict` 声明面**（T-6 读端删除 ⇒ 恒返「无声明」；
//   T-1 `lib/assembly/team-asset.js` 本体删除）⇒「空白名单 + 专用码 `GATE_COMPLETE_OUTCOMES_EMPTY`」**无发射源**
//   （`lib/**` 零命中）。**不可等值反转**：反转成「引擎基线 ⇒ merged 放行」与下方 A3 用例**同构造重复**
//   ⇒ 恒真空转（纪律 15⑤）。A2 / A3 两例（引擎基线口径的放行/拒面）**原样在册** ⇒ complete 门禁覆盖不丢。

test('GAP-S2-A2：verdict 含 pass ⇒ 判定逐字不变（merged/skipped 放行；fail/conflict 恒拒且仍用原码）', () => {
  const { pkg, state } = mkRoots();
  try {
    clearFlowCache();
    writeTeamFlow(pkg, 'good-verdict', flowsWithVerdict(['pass', 'fail', 'skip']));
    const g = createGates(state, { flowsRoot: pkg });
    assert.equal(g.checkCompleteGate(batchWithAuditState('good-verdict', 'merged')).ok, true, 'merged 放行（行为与本改动前一致）');
    assert.equal(g.checkCompleteGate(batchWithAuditState('good-verdict', 'skipped')).ok, true, 'skip 在声明内 ⇒ 放行');
    const failed = g.checkCompleteGate(batchWithAuditState('good-verdict', 'failed'));
    assert.equal(failed.ok, false, 'fail 恒拒（语义不变）');
    assert.equal(failed.code, 'GATE_COMPLETE_AUDIT_FAILED', '白名单非空 ⇒ **不得**换成本次新增码（换码面收窄）');
    const conflict = g.checkCompleteGate(batchWithAuditState('good-verdict', 'conflict'));
    assert.equal(conflict.ok, false, 'conflict 恒拒（语义不变）');
    assert.equal(conflict.code, 'GATE_COMPLETE_AUDIT_FAILED', 'conflict 亦不得换码');
  } finally {
    fs.rmSync(pkg, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
    clearFlowCache();
  }
});

test('GAP-S2-A3：无 verdict 声明 ⇒ 回落引擎基线 [pass,skip]（放行面不变、拒面仍用原码）', () => {
  const { pkg, state } = mkRoots();
  try {
    clearFlowCache();
    writeTeamFlow(pkg, 'no-verdict', flowsWithVerdict(null));
    const g = createGates(state, { flowsRoot: pkg });
    assert.equal(g.checkCompleteGate(batchWithAuditState('no-verdict', 'merged')).ok, true, '基线含 pass ⇒ merged 放行');
    assert.equal(g.checkCompleteGate(batchWithAuditState('no-verdict', 'skipped')).ok, true, '基线含 skip ⇒ skipped 放行');
    const failed = g.checkCompleteGate(batchWithAuditState('no-verdict', 'failed'));
    assert.equal(failed.ok, false, '基线白名单下 fail 恒拒');
    assert.equal(failed.code, 'GATE_COMPLETE_AUDIT_FAILED', '缺声明 ⇒ values 非空 ⇒ 走原分支、原码');
    assert.deepEqual(failed.requiredOutcomes, ['pass', 'skip'], '引擎基线白名单可核（非空集）');
    assert.deepEqual(failed.narrowedOutcomes, [], '缺声明 ⇒ narrowed 为空');
  } finally {
    fs.rmSync(pkg, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
    clearFlowCache();
  }
});


function makeHarness(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's2-tool-' + tag + '-'));
  const store = createStore(root);
  const ctx = { tools: { register: () => {}, guard: () => {} }, logger: console };
  const { tools } = createTools(ctx, { store, root });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  // G1 前置：`wave_plan` 属 C 档动作 ⇒ 先按 `assign_check` 的同一落盘函数写「已评估为 C」
  assessC(store, SESS_ID, { rationale: 'GAP-S2 建批面回归前置：wave_plan 属 C 档动作（单批三层治理面）' });
  return { root, store, byName };
}

// 与 software-team 的 consumes_required ['plan/','exec/'] 对齐 ⇒ audit 同时消费 plan 与 exec 产物
function tasks3() {
  return [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1.md'], deps: ['p1'], cmd: 'code' },
    { id: 'a1', layer: 'audit', role: 'supervisor', consume: ['plan/spec.md', 'exec/e1.md'], produce: ['audit/a1.md'], deps: ['e1'], cmd: 'accept' },
  ];
}

const warnCodes = (out) => (out.warnings ?? []).map((w) => w.code);

// ── 已删（2026-09-27 批 3 · T-15/D-6 归因，三例同因）：原 test「GAP-S2-B1：坏 verdict 资产建批 ⇒ 批次照建
//    + warnings 含同码告警」/「GAP-S2-B2 反向锁：verdict 含 pass ⇒ 零告警」/「GAP-S2-B3 反向锁：verdict 缺声明
//    ⇒ 零告警」──
//   面已消失 = ① **`verdict` 声明面 + 其 `warnings` 留痕通道**（T-6/T-1；`exec/consumers.md` §二.6 明载：
//               「来源②资产缺口 / ③链非法随删，已无发射点」⇒ 建批返回值今日不含任何资产相关 `warnings`）；
//              ② 夹具 `writeTempTeam` 读已删的 5 件真实骨架（T-4/A-9）⇒ 调用即抛，三例整条不可达。
//   **不可等值反转**：反转成「零告警」是**恒真空转**（无发射源 ⇒ 恒真），违纪律 15⑤。
//   A2 / A3 两例（引擎基线口径）原样在册。

// ── 已删（2026-09-27 批 3 · T-15/D-6 归因）：原 test「GAP-S2-A4 真机路径复现（smoke-chain-20260916）：
//    坏 verdict 批 audit merged 后 complete 拒专用码」──
//   面已消失 = 同上（`verdict` 声明面 + 其专用码 `GATE_COMPLETE_OUTCOMES_EMPTY` 无发射源）+ 夹具 `writeTempTeam`
//   读已删的真实骨架（T-4/A-9）⇒ 用例不可达。**不可等值反转**：引擎基线口径下 audit merged ⇒ `complete` **放行**，
//   反转即与 A2 用例（merged 放行）重复、且原「专用码归因」面不存在 ⇒ 恒真空转。
//   A2 / A3（引擎基线放行面 + 拒面 + `requiredOutcomes`/`narrowedOutcomes` 载荷）原样在册。


// ═══════════════════════════════════════════════════════════════════════════════
// (5) 断言删除数为 0（与 `scripts/baseline-snapshot.mjs --check` 同源对账）
// ═══════════════════════════════════════════════════════════════════════════════
test('GAP-S2-C5：基线对账——断言零下降 / 恒真零新增，且本文件已登记（新增断言数 > 0）', () => {
  const ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
  const baseline = readBaseline(ROOT);
  const scan = scanTree(ROOT);
  const cmp = compareBaseline(baseline, scan);
  assert.ok(cmp.asserts.delta >= 0, '断言调用数不得低于基线（禁静默删断言）；delta=' + String(cmp.asserts.delta));
  assert.ok(cmp.tautologies.delta <= 0, '恒真形态命中数不得上升（禁等价替换）；delta=' + String(cmp.tautologies.delta));
  assert.equal(cmp.ok, true, '基线对账须 0 漂移；逐文件变化=' + JSON.stringify(cmp.filesChanged));
  const mine = baseline.files?.['test/complete-outcomes-empty.test.js'];
  assert.ok(mine, '本文件须在 baselines/test-baseline.json 中登记（由 scripts/baseline-snapshot.mjs 重生成）');
  assert.ok(mine.asserts > 0, '本文件新增断言数 > 0；实测 asserts=' + String(mine.asserts));
  assert.ok(mine.tests > 0, '本文件新增用例数 > 0；实测 tests=' + String(mine.tests));
});
