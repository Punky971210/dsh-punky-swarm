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
import { topoWaves, buildWavePlan, validateWavePlan, normalizeResumeContract, resumeClauseFor, RESUME_CLAUSE } from '../lib/wave-plan.js';

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
  // 契约文本断言（决策包 §三 B2 原文：resume:true 时注入固定条款）
  assert.ok(RESUME_CLAUSE.includes('lane_checkpoint_status'), '条款引用 lane_checkpoint_status');
  assert.ok(RESUME_CLAUSE.includes('禁止重做已完成步骤'), '禁止重做');
  assert.ok(RESUME_CLAUSE.includes('禁止攒批'), '禁止攒批');
  assert.ok(RESUME_CLAUSE.includes('lane_checkpoint'), '条款引用 lane_checkpoint');
});

test('B2 normalizeResumeContract：独立规范化入口', () => {
  assert.deepEqual(normalizeResumeContract({ id: 'x', checkpoint: { steps: 7 }, resume: true }), { checkpoint: { steps: 7 }, resume: true });
  assert.deepEqual(normalizeResumeContract({ id: 'x' }), { checkpoint: null, resume: false });
});