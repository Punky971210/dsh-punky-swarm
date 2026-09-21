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

// gate-lite Q-G1（2026-09-17 用户裁决「开显式豁免键」）：`wave_plan({ smoke: true })` 冒烟/探针批豁免键。
//
// 覆盖（逐条对应验收判据）：
//   T1 RED/GREEN 枢纽：**单 lane 冒烟批**（plan lane、不声明 produce/outputs）⇒ 建批成功；
//      同一输入**不传 smoke** ⇒ 仍拒 `GATE_PLAN_PRESENCE_MISSING`（既有行为逐字不变）。
//      —— 本用例即 Leader 本轮实测被拒的形态（`GATE_PLAN_PRESENCE_MISSING` / `GATE_ORPHAN_PRODUCT`）。
//   T2 建批期 ORPHAN 面：声明产物但无人 consume ⇒ smoke 批放行；反例仍拒 `GATE_ORPHAN_PRODUCT`。
//   T3 留痕：建批当刻落恰好 1 条 `batch.smoke` 事件；无该事件的批次判 false（既有批零影响）。
//   T4 读端可见：`batch_status.smoke === true`；非 smoke 批**不写键**（批形状零变化）。
//   T5 运行期豁免：smoke 批的 plan lane（声明产物但未落盘）在 `checkExitGate` 放行且载荷带 `smoke:true`；
//      **对照**：非 smoke 批同形态仍拒 `GATE_PLAN_CONTRACT`（证明豁免是 smoke 专属，不是全局放宽）。
//   T6 行为安全门**仍在**：smoke 批派发未声明 lane ⇒ 仍拒 `GATE_LANE_NOT_IN_PLAN`（豁免不外溢到派发准入）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { createGates, smokeOf } from '../lib/state/gates.js';
import * as EVT from '../lib/state/event-types.js';
import { assessC } from './helpers/gate-fixture.mjs';
import { writeTempTeam } from './helpers/team-fixture.mjs';
import { seedTeamAssetSkills } from './helpers/host-skills.mjs';

// 临时团队资产以包内 `software-team` 为骨架 ⇒ 其 skills 必须可在宿主技能根解析（P1 起不可解析即拒建批）。
seedTeamAssetSkills('software-team');

const SESS = { agent: { session: { id: 'sess-smoke' } } };
const SID = SESS.agent.session.id;
const PLAIN_TEAM = 'probe-team';


function makeHarness(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const store = createStore(root);
  const ctx = { tools: { register: () => {}, guard: () => {} }, logger: console };
  const tools = createTools(ctx, { store, root });
  const byName = Object.fromEntries(tools.tools.map((t) => [t.name, t]));
  // G1 前置：`wave_plan` 属 C 档动作 ⇒ 建批前先写 C 档评估（与 assign_check 同落盘口径）
  assessC(store, SID, { rationale: 'fixture：gate-lite smoke 豁免套件建批前置评估（探针批 ⇒ C 档）' });
  return { root, store, byName };
}

// **非 smoke 对照批**：直接经 store.createBatch 落一条最小批次（只带 batch.created），
//   用于「豁免是 smoke 专属」的对照面（正常建批路径下这些形态会被建批门拒，构造不出）。
function seedPlainBatch(store, batchId, tasks) {
  return store.createBatch(SID, {
    batchId,
    wavePlan: { schema: 1, team: PLAIN_TEAM, concurrency: 1, wavePlan: [{ wave: 1, tasks }] },
  });
}

// 单 lane 冒烟形态：一条 plan lane、**不声明任何产物**（本轮被 GATE_PLAN_PRESENCE_MISSING 拒的形态）
const bareProbeTasks = () => [{ id: 'probe', layer: 'plan', role: 'designer', cmd: 'echo probe' }];
// 声明了产物但无消费者形态（GATE_ORPHAN_PRODUCT 面）
const orphanTasks = () => [{ id: 'probe', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'echo probe' }];

test('T1 RED/GREEN：单 lane 冒烟批 smoke:true ⇒ 建批成功；同输入不传 smoke ⇒ 仍拒 GATE_PLAN_PRESENCE_MISSING', async () => {
  const { byName } = makeHarness('punky-smoke-t1-');
  const teamsRoot = writeTempTeam('punky-smoke-t1-team-', PLAIN_TEAM);

  // 反例（既有语义）：不传 smoke ⇒ 建批被拒，码面逐字不变
  await assert.rejects(
    () => byName.wave_plan.execute({ batchId: 'smk-red', team: PLAIN_TEAM, teamsRoot, tasks: bareProbeTasks() }, SESS),
    /GATE_PLAN_PRESENCE_MISSING/,
    '不传 smoke 的同一输入仍必须拒（既有行为零变化）',
  );

  // 正例（Q-G1）：smoke:true ⇒ 建批成功
  const out = await byName.wave_plan.execute({ batchId: 'smk-green', team: PLAIN_TEAM, teamsRoot, tasks: bareProbeTasks(), smoke: true }, SESS);
  assert.equal(out.batchId, 'smk-green');
  assert.equal(out.smoke, true, 'wave_plan 返回值回显 smoke:true');
});

test('T2 smoke 批跳过建批期 ORPHAN 面（声明产物但无人 consume）；反例仍拒 GATE_ORPHAN_PRODUCT', async () => {
  const { byName } = makeHarness('punky-smoke-t2-');
  const teamsRoot = writeTempTeam('punky-smoke-t2-team-', PLAIN_TEAM);
  await assert.rejects(
    () => byName.wave_plan.execute({ batchId: 'smk-orphan-red', team: PLAIN_TEAM, teamsRoot, tasks: orphanTasks() }, SESS),
    /GATE_ORPHAN_PRODUCT/,
    '非 smoke 批：plan 产物无消费者仍必须拒建批',
  );
  const out = await byName.wave_plan.execute({ batchId: 'smk-orphan-green', team: PLAIN_TEAM, teamsRoot, tasks: orphanTasks(), smoke: true }, SESS);
  assert.equal(out.batchId, 'smk-orphan-green');
});

test('T3 留痕：建批落恰好 1 条 batch.smoke 事件；无该事件的批次判 false', async () => {
  const { store, byName } = makeHarness('punky-smoke-t3-');
  const teamsRoot = writeTempTeam('punky-smoke-t3-team-', PLAIN_TEAM);
  await byName.wave_plan.execute({ batchId: 'smk-evt', team: PLAIN_TEAM, teamsRoot, tasks: bareProbeTasks(), smoke: true }, SESS);
  const b = store.readBatch(SID, 'smk-evt');
  const hits = b.events.filter((e) => e.type === EVT.EVT_BATCH_SMOKE);
  assert.equal(hits.length, 1, 'batch.smoke 事件恰好 1 条');
  assert.equal(EVT.EVT_BATCH_SMOKE, 'batch.smoke', '事件字面量（单点常量）');
  assert.equal(smokeOf(b), true, '门禁读端与留痕同源（smokeOf 命中）');
  // 零差异对照：未声明 smoke 的批次记录 ⇒ 判 false（既有批行为不受影响）
  const plain = seedPlainBatch(store, 'smk-plain-3', orphanTasks());
  assert.equal(smokeOf(plain), false, '无 batch.smoke 事件 ⇒ smokeOf 为 false');
  assert.equal(plain.events.some((e) => e.type === EVT.EVT_BATCH_SMOKE), false, '非 smoke 批不落该事件');
});

test('T4 读端可见：batch_status.smoke === true；非 smoke 批不写该键', async () => {
  const { store, byName } = makeHarness('punky-smoke-t4-');
  const teamsRoot = writeTempTeam('punky-smoke-t4-team-', PLAIN_TEAM);
  await byName.wave_plan.execute({ batchId: 'smk-view', team: PLAIN_TEAM, teamsRoot, tasks: bareProbeTasks(), smoke: true }, SESS);
  const smokeView = await byName.batch_status.execute({ batchId: 'smk-view' }, SESS);
  assert.equal(smokeView.smoke, true, 'batch_status 回显 smoke:true（读端可见，不是隐性放行）');
  seedPlainBatch(store, 'smk-plain-4', orphanTasks());
  const plainView = await byName.batch_status.execute({ batchId: 'smk-plain-4' }, SESS);
  assert.equal('smoke' in plainView, false, '非 smoke 批不写 smoke 键（批形状零变化）');
});

test('T5 运行期豁免：smoke 批 plan lane 在 checkExitGate 放行（载荷带 smoke/smokeSkipped）；对照批仍拒 GATE_PLAN_CONTRACT', async () => {
  const { root, store, byName } = makeHarness('punky-smoke-t5-');
  const teamsRoot = writeTempTeam('punky-smoke-t5-team-', PLAIN_TEAM);
  await byName.wave_plan.execute({ batchId: 'smk-exit', team: PLAIN_TEAM, teamsRoot, tasks: orphanTasks(), smoke: true }, SESS);
  const gates = createGates(root);
  const smokeBatch = store.readBatch(SID, 'smk-exit');
  const g = gates.checkExitGate(SID, 'smk-exit', smokeBatch, 'probe');
  assert.equal(g.ok, true, 'smoke 批跳过 plan 契约门（产物未落盘也放行）');
  assert.equal(g.smoke, true, '放行载荷回显 smoke:true（零静默：跳了什么可读）');
  assert.equal(g.smokeSkipped, 'plan-contract', '回显被跳过的门');

  // 对照（豁免是 smoke 专属）：同一形态的非 smoke 批 ⇒ 仍拒
  const plainBatch = seedPlainBatch(store, 'smk-plain-5', orphanTasks());
  const gPlain = gates.checkExitGate(SID, 'smk-plain-5', plainBatch, 'probe');
  assert.equal(gPlain.ok, false, '非 smoke 批同形态仍被拒（豁免不外溢）');
  assert.equal(gPlain.code, 'GATE_PLAN_CONTRACT', '码面逐字不变');
});

test('T6 行为安全门仍在：smoke 批派发未声明 lane ⇒ 仍拒 GATE_LANE_NOT_IN_PLAN', async () => {
  const { root, store, byName } = makeHarness('punky-smoke-t6-');
  const teamsRoot = writeTempTeam('punky-smoke-t6-team-', PLAIN_TEAM);
  await byName.wave_plan.execute({ batchId: 'smk-safety', team: PLAIN_TEAM, teamsRoot, tasks: bareProbeTasks(), smoke: true }, SESS);
  const gates = createGates(root);
  const b = store.readBatch(SID, 'smk-safety');
  const g = gates.checkEntryGate(SID, 'smk-safety', b, 'no-such-lane');
  assert.equal(g.ok, false, '豁免不外溢到派发准入（lane 存在性属行为安全门）');
  assert.equal(g.code, 'GATE_LANE_NOT_IN_PLAN');
});
