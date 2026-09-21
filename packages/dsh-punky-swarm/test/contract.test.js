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
import { topoWaves, buildWavePlan, validateWavePlan, assembleCmd, LAYERS } from '../lib/wave-plan.js';

const punkyPresetAssembly = {
  team: 'punky-preset',
  layers: {
    plan: { roles: ['coordinator', 'designer'], skills: { coordinator: ['dev-planner'], designer: ['dev-designer', 'spec-writing'] } },
    exec: { roles: ['coder', 'tester'], skills: { coder: ['dev-coder', 'efficient-edit'], tester: ['dev-tester'] } },
    audit: { roles: ['reviewer', 'supervisor'], skills: { reviewer: ['code-review-guideline'], supervisor: ['report-blind-audit', 'archive'] } },
  },
};

function threeTierWithTaskTree() {
  // 【r2 同步 · A1】旧 fixture 的 plan 声明了 `plan/task-tree.json` 但**无任何 lane consume**：
  //   新语义下该悬空产物在建批期即拒建批（`GATE_ORPHAN_PRODUCT`，A1 主防线）。
  //   修法是**补下游 consume**（不是删声明、也不是放宽门禁）⇒ 由 audit lane 消费 task-tree（验收需核对任务树）。
  return [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md', 'plan/task-tree.json'], cmd: '产出 spec' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1/main.py'], cmd: '实现', deps: ['p1'] },
    { id: 'a1', layer: 'audit', role: 'reviewer', consume: ['plan/spec.md', 'plan/task-tree.json', 'exec/e1/main.py'], produce: ['audit/review.md', 'audit/gap-list.json'], cmd: '审查', deps: ['e1'] },
  ];
}

test('无 team 直调（无 layer）不再回落 generic：plan.team = undefined，无前缀注入（P1 同步）', () => {
  // 【P1 同步 · 读端口径】`lib/wave-plan.js` 的 `team = 'generic'` 缺省已删除（读端不再有第二个默认值真源）⇒
  //   直调不传 `team` 时 `plan.team` 为 `undefined`；工具面则**必填**（缺 ⇒ 参数面即拒，见 wave_plan schema）。
  //   本用例判据（无前缀注入 + plan 合法）逐字不变，只把"缺省值"的期望从 `'generic'` 改为 `undefined`。
  const plan = buildWavePlan({ batchId: 'b-g', tasks: [{ id: 't1', cmd: 'hi' }, { id: 't2', cmd: 'x', deps: ['t1'] }] });
  assert.equal(plan.team, undefined, '直调缺省不再回落 generic（P1：读端兜底已清）');
  assert.equal(plan.wavePlan[0].tasks[0].cmd, 'hi');
  assert.equal(validateWavePlan(plan), true);
});

test('三层正常：跨层引用/路径/有 exec 必有 audit 通过，cmd 注入 role+skill 前缀', () => {
  const plan = buildWavePlan({ batchId: 'b-3', tasks: threeTierWithTaskTree(), team: 'punky-preset', assembly: punkyPresetAssembly });
  const flat = plan.wavePlan.flatMap((w) => w.tasks);
  const e1 = flat.find((t) => t.id === 'e1');
  const a1 = flat.find((t) => t.id === 'a1');
  assert.equal(e1.cmd.startsWith('[role=coder] [skills=dev-coder,efficient-edit]'), true);
  assert.equal(a1.cmd.startsWith('[role=reviewer] [skills=code-review-guideline]'), true);
  assert.deepEqual(e1.consume, ['plan/spec.md']);
  assert.deepEqual(a1.produce, ['audit/review.md', 'audit/gap-list.json']);
  assert.equal(validateWavePlan(plan), true);
});

test('拒建批：exec.consume 引用 plan 层未 produce 的路径', () => {
  const tasks = threeTierWithTaskTree();
  tasks[0].produce = ['plan/spec.md']; // 去掉 task-tree.json
  tasks[1].consume = ['plan/spec.md', 'plan/task-tree.json'];
  assert.throws(() => buildWavePlan({ batchId: 'b-x', tasks }), /not produced by any plan lane/);
});

test('拒建批：有 exec 无 audit', () => {
  const tasks = threeTierWithTaskTree().filter((t) => t.id !== 'a1');
  assert.throws(() => buildWavePlan({ batchId: 'b-x', tasks }), /require at least one audit lane/);
});

test('拒建批：路径必须在本批次产物根内（plan/|exec/|audit/ 或绝对路径）', () => {
  const tasks = threeTierWithTaskTree();
  tasks[1].outputs = ['foo/out.txt'];
  assert.throws(() => buildWavePlan({ batchId: 'b-x', tasks }), /must be under plan\/\|exec\/\|audit\//);
});

test('拒建批：跨批次引用 MVP 先禁（N6）', () => {
  const tasks = threeTierWithTaskTree();
  tasks[1].consume = ['artifacts/other-batch/plan/spec.md'];
  assert.throws(() => buildWavePlan({ batchId: 'b-x', tasks }), /cross-batch reference is disabled/);
});

test('拒建批：skills 声明非法（空数组 / 非字符串）', () => {
  const t1 = threeTierWithTaskTree(); t1[1].skills = [];
  assert.throws(() => buildWavePlan({ batchId: 'b-x', tasks: t1 }), /skills must be a non-empty string array/);
  const t2 = threeTierWithTaskTree(); t2[1].skills = ['dev-coder', 42];
  assert.throws(() => buildWavePlan({ batchId: 'b-x', tasks: t2 }), /skills must be a non-empty string array/);
});

test('assembleCmd：前缀组合与空输入', () => {
  assert.equal(assembleCmd('coder', ['dev-coder'], '实现'), '[role=coder] [skills=dev-coder] 实现');
  assert.equal(assembleCmd(null, null, 'plain'), 'plain');
  assert.equal(assembleCmd('audit', [], ''), '[role=audit] ');
});

test('validateWavePlan：篡改 layer / 跨层不一致拒绝', () => {
  const plan = buildWavePlan({ batchId: 'b-3', tasks: threeTierWithTaskTree(), team: 'punky-preset', assembly: punkyPresetAssembly });
  const forged1 = JSON.parse(JSON.stringify(plan));
  forged1.wavePlan[0].tasks[0].layer = 'bogus';
  assert.throws(() => validateWavePlan(forged1), /layer invalid/);
  const forged2 = JSON.parse(JSON.stringify(plan));
  forged2.wavePlan[0].tasks[0].produce = ['plan/only.md'];
  assert.throws(() => validateWavePlan(forged2), /not produced by any plan lane/);
});

test('LAYERS 常量', () => {
  assert.deepEqual(LAYERS, ['plan', 'exec', 'audit']);
});
