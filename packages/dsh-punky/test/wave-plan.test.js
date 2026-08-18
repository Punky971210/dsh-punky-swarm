import test from 'node:test';
import assert from 'node:assert/strict';
import { topoWaves, buildWavePlan, validateWavePlan } from '../lib/wave-plan.js';

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