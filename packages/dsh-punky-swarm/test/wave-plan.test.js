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

import test from 'node:test';
import assert from 'node:assert/strict';
import { topoWaves, buildWavePlan, validateWavePlan, normalizeResumeContract, resumeClauseFor, RESUME_CLAUSE, normalizeRole, defaultRoleForLayer, VALID_ROLES, isCClassBatch, collectRoleCompletenessWarnings, normalizeTargetsContract } from '../lib/wave-plan.js';

test('topoWaves layers independent tasks into same wave', () => {
  const { waves } = topoWaves([
    { id: 'a' }, { id: 'b' }, { id: 'c', deps: ['a'] }, { id: 'd', deps: ['a', 'b'] },
  ]);
  assert.deepEqual(new Set(waves[0]), new Set(['a', 'b']));
  assert.deepEqual(new Set(waves[1]), new Set(['c', 'd']));
  assert.equal(waves.length, 2);
});

test('topoWaves rejects cycles', () => {
  assert.throws(() => topoWaves([{ id: 'a', deps: ['b'] }, { id: 'b', deps: ['a'] }]));
  assert.throws(() => topoWaves([{ id: 'a', deps: ['missing'] }]));
  assert.throws(() => topoWaves([{ id: 'a' }, { id: 'a' }]));
});

test('buildWavePlan fixes the plan at creation', () => {
  const plan = buildWavePlan({
    batchId: 'b-1',
    tasks: [
      { id: 't1', cmd: 'x' },
      { id: 't2', deps: ['t1'], model: 'deepseek-v4-pro' },
    ],
    concurrency: 3,
  });
  assert.equal(plan.schema, 1);
  assert.equal(plan.wavePlan.length, 2);
  assert.equal(plan.wavePlan[1].tasks[0].model, 'deepseek-v4-pro');
  assert.equal(plan.concurrency, 3);
});

test('validateWavePlan accepts a fixed plan and rejects mutations', () => {
  const plan = buildWavePlan({ batchId: 'b-2', tasks: [{ id: 'x' }] });
  assert.equal(validateWavePlan(plan), true);
  const bad = JSON.parse(JSON.stringify(plan));
  bad.wavePlan = [];
  assert.throws(() => validateWavePlan(bad));
  const cyc = { schema: 1, batchId: 'b-3', wavePlan: [{ wave: 1, tasks: [{ id: 'a', deps: ['b'] }, { id: 'b', deps: ['a'] }] }] };
  assert.throws(() => validateWavePlan(cyc));
});

test('task tools metadata carried in plan and validated', () => {
  const plan = buildWavePlan({ batchId: 'b-tools', tasks: [{ id: 'x', tools: ['fs', 'bash'] }, { id: 'y' }] });
  assert.deepEqual(plan.wavePlan[0].tasks[0].tools, ['fs', 'bash']);
  assert.equal(plan.wavePlan[0].tasks[1].tools, null);
  const bad = buildWavePlan({ batchId: 'b-bad', tasks: [{ id: 'x', tools: 'fs' }] });
  assert.equal(bad.wavePlan[0].tasks[0].tools, null); // 非数组归一化为 null
  const forged = JSON.parse(JSON.stringify(bad));
  forged.wavePlan[0].tasks[0].tools = 'fs'; // 手工构造非法值
  assert.throws(() => validateWavePlan(forged));
});

test('default concurrency falls back to 5', () => {
  const plan = buildWavePlan({ batchId: 'b-4', tasks: [{ id: 'x' }], concurrency: -1 });
  assert.equal(plan.concurrency, 5);
});

test('B2 resume 契约字段：checkpoint{steps}/resume 校验放行 + 透传（缺省形态归一）', () => {
  const plan = buildWavePlan({ batchId: 'b-b2', tasks: [
    { id: 'a', resume: true, checkpoint: { steps: 4 } },
    { id: 'b' },
    { id: 'c', resume: false },
  ] });
  const flat = Object.fromEntries(plan.wavePlan.flatMap((w) => w.tasks).map((t) => [t.id, t]));
  assert.deepEqual(flat.a.checkpoint, { steps: 4 });
  assert.equal(flat.a.resume, true);
  assert.equal(flat.b.checkpoint, null, '缺省 checkpoint → null');
  assert.equal(flat.b.resume, false, '缺省 resume → false（现状，行为不变）');
  assert.equal(flat.c.resume, false);
  assert.equal(validateWavePlan(plan), true);
});

test('B2 resume 契约字段：非法声明 fail-closed 拒建批', () => {
  assert.throws(() => buildWavePlan({ batchId: 'b-x', tasks: [{ id: 'x', checkpoint: { steps: 0 } }] }), /checkpoint\.steps must be a positive integer/);
  assert.throws(() => buildWavePlan({ batchId: 'b-x', tasks: [{ id: 'x', checkpoint: { steps: 1.5 } }] }), /checkpoint\.steps must be a positive integer/);
  assert.throws(() => buildWavePlan({ batchId: 'b-x', tasks: [{ id: 'x', checkpoint: 'plan/a.md' }] }), /checkpoint must be an object/);
  assert.throws(() => buildWavePlan({ batchId: 'b-x', tasks: [{ id: 'x', resume: 'yes' }] }), /resume must be a boolean/);
  assert.throws(() => buildWavePlan({ batchId: 'b-x', tasks: [{ id: 'x', checkpoint: { steps: 3 }, resume: 1 }] }), /resume must be a boolean/);
});

test('B2 validateWavePlan：伪造 checkpoint/resume 形态拒绝', () => {
  const plan = buildWavePlan({ batchId: 'b-b2v', tasks: [{ id: 'a', resume: true, checkpoint: { steps: 2 } }] });
  assert.equal(validateWavePlan(plan), true);
  const forged1 = JSON.parse(JSON.stringify(plan));
  forged1.wavePlan[0].tasks[0].checkpoint = { steps: -1 };
  assert.throws(() => validateWavePlan(forged1), /checkpoint must be/);
  const forged2 = JSON.parse(JSON.stringify(plan));
  forged2.wavePlan[0].tasks[0].resume = 'yes';
  assert.throws(() => validateWavePlan(forged2), /resume must be boolean/);
});

test('B3 resume 任务包契约条款：resumeClauseFor 注入/不注入 + RESUME_CLAUSE 文本断言', () => {
  assert.equal(resumeClauseFor({ id: 'a', resume: true }), RESUME_CLAUSE);
  assert.equal(resumeClauseFor({ id: 'b', resume: false }), null, 'resume=false → 不注入（现状）');
  assert.equal(resumeClauseFor({ id: 'c' }), null, '缺省 → 不注入');
  // 契约文本断言（resume:true 时注入固定条款）
  assert.ok(RESUME_CLAUSE.includes('lane_checkpoint_status'), '条款引用 lane_checkpoint_status');
  assert.ok(RESUME_CLAUSE.includes('禁止重做已完成步骤'), '禁止重做');
  assert.ok(RESUME_CLAUSE.includes('禁止攒批'), '禁止攒批');
  assert.ok(RESUME_CLAUSE.includes('lane_checkpoint'), '条款引用 lane_checkpoint');
});

test('B2 normalizeResumeContract：独立规范化入口', () => {
  assert.deepEqual(normalizeResumeContract({ id: 'x', checkpoint: { steps: 7 }, resume: true }), { checkpoint: { steps: 7 }, resume: true });
  assert.deepEqual(normalizeResumeContract({ id: 'x' }), { checkpoint: null, resume: false });
});

// ── 已删（2026-09-26 · Q-8-C 全链删除）：原 test「role 合法性：8 角色集合 + 大小写归一化（Designer→designer）', …」
//   该 test 依托 `plan_leads`/`audit_leads` 或 `GATE_ROLE_MISSING`/`PLAN_LEAD_ROLES` —— 已随
//   用户裁决全链移除（引擎并集逻辑 + 资产级 LEAD_NOT_IN_LAYERS 校验 + 三队资产子键）。

// ── 已删（2026-09-26 · Q-8-C 全链删除）：原 test「role 非法（planner/auditor）→ GATE_ROLE_INVALID 告警…」
//   该 test 依托 `plan_leads`/`audit_leads` 或 `GATE_ROLE_MISSING`/`PLAN_LEAD_ROLES` —— 已随
//   用户裁决全链移除（引擎并集逻辑 + 资产级 LEAD_NOT_IN_LAYERS 校验 + 三队资产子键）。

test('role 默认值修正：plan→designer / audit→supervisor / exec→coder；generic 无 layer 保持 null', () => {
  assert.equal(defaultRoleForLayer('plan'), 'designer');
  assert.equal(defaultRoleForLayer('audit'), 'supervisor');
  assert.equal(defaultRoleForLayer('exec'), 'coder');
  assert.equal(defaultRoleForLayer(null), null);
  const plan = buildWavePlan({ batchId: 'b-role', tasks: [
    { id: 'p1', layer: 'plan', produce: ['plan/s.md'] },
    { id: 'e1', layer: 'exec', consume: ['plan/s.md'], outputs: ['exec/e1/o'], deps: ['p1'] },
    // a1 显式消费被认领 exec lane 的交付产物 `exec/e1/o`：U-7/G-08 替代判据的「认领即须消费」口径
    //   （旧判据恒不命中 ⇒ 该夹具此前无需声明；新判据可达后，缺该声明会产 GATE_PAIRING_CARDINALITY_DRIFT）。
    { id: 'a1', layer: 'audit', consume: ['plan/s.md', 'exec/e1/o'], produce: ['audit/r.md'], deps: ['e1'] },
    { id: 'g1', cmd: 'generic' },
  ] });
  const flat = Object.fromEntries(plan.wavePlan.flatMap((w) => w.tasks).map((t) => [t.id, t]));
  assert.equal(flat.p1.role, 'designer', 'plan 未声明 → designer（替代 planner 默认）');
  assert.equal(flat.e1.role, 'coder', 'exec 未声明 → coder');
  assert.equal(flat.a1.role, 'supervisor', 'audit 未声明 → supervisor（替代 auditor 默认）');
  assert.equal(flat.g1.role, null, 'generic 无 layer → 不注入默认 role（现状不变）');
  assert.deepEqual(plan.warnings, [], '未声明 role 走默认值不告警');
  assert.equal(validateWavePlan(plan), true);
});

// ── 已删（2026-09-26 · Q-8-C 全链删除）：原 test「role 盲审扩展角色（audit-panelist 等）为合法角色：不触发 GATE_RO…」
//   该 test 依托 `plan_leads`/`audit_leads` 或 `GATE_ROLE_MISSING`/`PLAN_LEAD_ROLES` —— 已随
//   用户裁决全链移除（引擎并集逻辑 + 资产级 LEAD_NOT_IN_LAYERS 校验 + 三队资产子键）。

test('C 类形态判定：多 wave / 多 lane / 跨 layer 依赖任一命中即 C 类；单 lane 单 wave 无跨层依赖非 C 类', () => {
  assert.equal(isCClassBatch([{ id: 'a' }], [['a']]), false, '单 lane 单 wave 无跨层依赖 → 非 C 类');
  assert.equal(isCClassBatch([{ id: 'a' }, { id: 'b' }], [['a', 'b']]), true, 'lane 数 >1 → C 类');
  assert.equal(isCClassBatch([{ id: 'a' }, { id: 'b', deps: ['a'] }], [['a'], ['b']]), true, 'wave 数 >1 → C 类');
  assert.equal(isCClassBatch([{ id: 'p', layer: 'plan' }, { id: 'e', layer: 'exec', deps: ['p'] }], [['p'], ['e']]), true, '跨 layer 依赖 → C 类');
  assert.deepEqual(collectRoleCompletenessWarnings([{ id: 'a' }], [['a']]), [], '非 C 类形态零告警');
});

// ── 已删（2026-09-26 · Q-8-C 全链删除）：原 test「C 类三层批次缺 plan 层 designer/coordinator → GATE_RO…」
//   该 test 依托 `plan_leads`/`audit_leads` 或 `GATE_ROLE_MISSING`/`PLAN_LEAD_ROLES` —— 已随
//   用户裁决全链移除（引擎并集逻辑 + 资产级 LEAD_NOT_IN_LAYERS 校验 + 三队资产子键）。

// ── 已删（2026-09-26 · Q-8-C 全链删除）：原 test「C 类三层批次缺 audit 层 supervisor/doc-manager → GATE…」
//   该 test 依托 `plan_leads`/`audit_leads` 或 `GATE_ROLE_MISSING`/`PLAN_LEAD_ROLES` —— 已随
//   用户裁决全链移除（引擎并集逻辑 + 资产级 LEAD_NOT_IN_LAYERS 校验 + 三队资产子键）。

// ── 已删（2026-09-26 · Q-8-C 全链删除）：原 test「C 类三层批次角色齐备（designer + coder + supervisor）→ 无 …」
//   该 test 依托 `plan_leads`/`audit_leads` 或 `GATE_ROLE_MISSING`/`PLAN_LEAD_ROLES` —— 已随
//   用户裁决全链移除（引擎并集逻辑 + 资产级 LEAD_NOT_IN_LAYERS 校验 + 三队资产子键）。

// ── 已删（2026-09-26 · Q-8-C 全链删除）：原 test「C 类三层批次未声明 role：默认值补全（plan→designer / audit→su…」
//   该 test 依托 `plan_leads`/`audit_leads` 或 `GATE_ROLE_MISSING`/`PLAN_LEAD_ROLES` —— 已随
//   用户裁决全链移除（引擎并集逻辑 + 资产级 LEAD_NOT_IN_LAYERS 校验 + 三队资产子键）。

// ── 已删（2026-09-26 · Q-8-C 全链删除）：原 test「C 类三层批次 manager 作 plan 牵头 → 不再满足 plan 牵头（Manag…」
//   该 test 依托 `plan_leads`/`audit_leads` 或 `GATE_ROLE_MISSING`/`PLAN_LEAD_ROLES` —— 已随
//   用户裁决全链移除（引擎并集逻辑 + 资产级 LEAD_NOT_IN_LAYERS 校验 + 三队资产子键）。

// ── 已删（2026-09-26 · Q-8-C 全链删除）：原 test「单 lane 批次（非 C 类形态）不触发 GATE_ROLE_MISSING', () =…」
//   该 test 依托 `plan_leads`/`audit_leads` 或 `GATE_ROLE_MISSING`/`PLAN_LEAD_ROLES` —— 已随
//   用户裁决全链移除（引擎并集逻辑 + 资产级 LEAD_NOT_IN_LAYERS 校验 + 三队资产子键）。

// ── 已删（2026-09-26 · Q-8-C 全链删除）：原 test「plan 层非法角色（planner）：GATE_ROLE_INVALID 与 GATE_R…」
//   该 test 依托 `plan_leads`/`audit_leads` 或 `GATE_ROLE_MISSING`/`PLAN_LEAD_ROLES` —— 已随
//   用户裁决全链移除（引擎并集逻辑 + 资产级 LEAD_NOT_IN_LAYERS 校验 + 三队资产子键）。

// ── 已删（2026-09-26 · Q-8-C 全链删除）：原 test「C 类批次无 plan 层 lane：仅按存在的层检查（audit 缺 supervisor…」
//   该 test 依托 `plan_leads`/`audit_leads` 或 `GATE_ROLE_MISSING`/`PLAN_LEAD_ROLES` —— 已随
//   用户裁决全链移除（引擎并集逻辑 + 资产级 LEAD_NOT_IN_LAYERS 校验 + 三队资产子键）。

test('O2 targets 契约：合法绝对路径 targets/targetsMarker 建批透传成功 + validateWavePlan 通过', () => {
  const plan = buildWavePlan({ batchId: 'b-tg-ok', tasks: [
    { id: 'e1', layer: 'exec', role: 'coder', outputs: ['exec/e1/o'], targets: ['D:\\repo\\x\\src\\a.js', 'D:/repo/x/docs/api.md'], targetsMarker: 'targets-claimed: true', cmd: 'x' },
    { id: 'a1', layer: 'audit', role: 'reviewer', produce: ['audit/r.md'], cmd: 'r', deps: ['e1'] },
  ] });
  const t = plan.wavePlan[0].tasks[0];
  assert.deepEqual(t.targets, ['D:\\repo\\x\\src\\a.js', 'D:/repo/x/docs/api.md']);
  assert.equal(t.targetsMarker, 'targets-claimed: true');
  assert.equal(validateWavePlan(plan), true);
});

test('O2 targets 契约：未声明字段透传 null（批次 JSON 读兼容，零感知）', () => {
  const plan = buildWavePlan({ batchId: 'b-tg-null', tasks: [{ id: 'x', cmd: 'a' }, { id: 'y', cmd: 'b' }] });
  const flat = Object.fromEntries(plan.wavePlan.flatMap((w) => w.tasks).map((t) => [t.id, t]));
  assert.equal(flat.x.targets, null);
  assert.equal(flat.x.targetsMarker, null);
  assert.equal(validateWavePlan(plan), true);
});

test('O2 targets 契约：相对路径 → 建批拒绝（fail-closed）', () => {
  assert.throws(() => buildWavePlan({ batchId: 'b-x', tasks: [{ id: 'x', targets: ['exec/e1/main.py'] }] }), /targets must be absolute paths/);
  assert.throws(() => buildWavePlan({ batchId: 'b-x', tasks: [{ id: 'x', targets: ['plan/spec.md'] }] }), /targets must be absolute paths/);
});

test('O2 targets 契约：非法形态 fail-closed（空数组 / 非字符串 / targetsMarker 非法）', () => {
  assert.throws(() => buildWavePlan({ batchId: 'b-x', tasks: [{ id: 'x', targets: [] }] }), /non-empty string array/);
  assert.throws(() => buildWavePlan({ batchId: 'b-x', tasks: [{ id: 'x', targets: [42] }] }), /non-empty strings/);
  assert.throws(() => buildWavePlan({ batchId: 'b-x', tasks: [{ id: 'x', targetsMarker: 42 }] }), /targetsMarker must be a string or null/);
});

test('O2 targets 契约：validateWavePlan 伪造/篡改 targets 形态拒绝', () => {
  const plan = buildWavePlan({ batchId: 'b-tg-forge', tasks: [{ id: 'x', targets: ['D:\\repo\\a.js'], targetsMarker: null }] });
  assert.equal(validateWavePlan(plan), true);
  const forged1 = JSON.parse(JSON.stringify(plan));
  forged1.wavePlan[0].tasks[0].targets = ['relative/a.js']; // 相对路径伪造
  assert.throws(() => validateWavePlan(forged1), /targets must be a non-empty string array of absolute paths/);
  const forged2 = JSON.parse(JSON.stringify(plan));
  forged2.wavePlan[0].tasks[0].targetsMarker = 123;
  assert.throws(() => validateWavePlan(forged2), /targetsMarker must be string or null/);
});

test('O2 normalizeTargetsContract：独立规范化入口', () => {
  assert.deepEqual(normalizeTargetsContract({ id: 'x', targets: ['D:\\a.js'], targetsMarker: 'm' }), { targets: ['D:\\a.js'], targetsMarker: 'm', targetsNoChange: false });
  assert.deepEqual(normalizeTargetsContract({ id: 'x' }), { targets: null, targetsMarker: null, targetsNoChange: false });
  // R1-g：零改动声明位透传（缺口修复：不再逼出假改动）
  assert.deepEqual(normalizeTargetsContract({ id: 'x', targets: ['D:\\a.js'], targetsNoChange: true }), { targets: ['D:\\a.js'], targetsMarker: null, targetsNoChange: true });
});