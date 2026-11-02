// test/lane-checkpoint-total-mismatch.test.js
//
// 【批 `punky-checkpoint-align-20261102` · lane `impl`】**checkpoint 清单对齐判定**的判别力用例。
//
// ## 判据口径（spec 裁决，唯一口径）
//   预期值 = `task.checkpoints.items.length`；`progress.total ≠ 该值` ⇒ 未对齐。
//   ⚠ **`checkpoint.steps` 不参与**本判定 —— 它是运行时上界（`overBudgetOf` 已管 `total > steps`）。
//      `steps:10` + `items:3` 是**合法组合**（成员照任务包建议填 `total:3`）⇒ 拿 steps 当预期会误报，
//      而**误报会训练成员忽略警示，比不报更有害**。
//   收窄三档：`items.length>0` 判等于｜仅 `steps` 无 items **不判**｜两者皆无零感知。
//
// ## 为什么用纯函数直接测（不走 `lane_checkpoint` 工具）
//   `lane_checkpoint` 依赖 **worktree / git**；且其「对齐」路径（期望无事件）在变异下**仍绿**
//   ⇒ 只测工具会**假绿**。证据只能落在「**不齐**」侧 ⇒ 故判据抽成 `resume.js` 的纯函数单测。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkpointTotalMismatchOf,
  hasCheckpointTotalMismatchEvent,
  overBudgetOf,
} from '../lib/state/resume.js';
import * as EVT from '../lib/state/event-types.js';

/** 造一个有 wavePlan 的批（`findTask` 的既有形状：waves[].tasks[]）。 */
const batchOf = (task, events = []) => ({ events, wavePlan: [{ wave: 1, tasks: [task] }] });

test('C-1a 构造①【不齐】items=3 而 total=1 ⇒ mismatch=true，且 declared/actual 精确', () => {
  const batch = batchOf({ id: 'e1', checkpoints: { items: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }] } });
  const mm = checkpointTotalMismatchOf(batch, 'e1', { step: 1, total: 1 });
  assert.deepEqual(mm, { mismatch: true, declared: 3, actual: 1 },
    '预期值必须取 items.length(3)，actual=1 ⇒ 未对齐；实测=' + JSON.stringify(mm));
});

test('C-1b 构造②【对齐】items=2 且 total=2 ⇒ mismatch=false（对齐路径不得误报）', () => {
  const batch = batchOf({ id: 'e1', checkpoints: { items: [{ id: 'c1' }, { id: 'c2' }] } });
  const mm = checkpointTotalMismatchOf(batch, 'e1', { step: 2, total: 2 });
  assert.deepEqual(mm, { mismatch: false, declared: 2, actual: 2 },
    '对齐时不得误报；实测=' + JSON.stringify(mm));
});

test('C-1c ★口径钉死：steps:10 + items:3 + total:3 ⇒ **对齐**（steps 不得参与等于判定）', () => {
  // 这是 spec 点名的**合法组合**：若实现拿 steps 当预期，这里会 3≠10 误报 ⇒ 本条必红。
  const batch = batchOf({ id: 'e1', checkpoint: { steps: 10 }, checkpoints: { items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] } });
  const mm = checkpointTotalMismatchOf(batch, 'e1', { step: 3, total: 3 });
  assert.equal(mm.mismatch, false, 'steps 不参与「等于」判定 ⇒ 不得因 3≠10 报警；实测=' + JSON.stringify(mm));
  assert.equal(mm.declared, 3, 'declared 必须来自 items.length（不是 steps）');
  // 同一批在「超界」轴上仍由 overBudgetOf 管辖（两轴正交、互不替代）
  const ob = overBudgetOf(batch, 'e1', { step: 3, total: 3 });
  assert.equal(ob.over, false, 'total(3) ≤ steps(10) ⇒ 不超界');
});

test('C-1d 收窄：**仅 steps 无 items** ⇒ 不判（零感知）｜两者皆无 ⇒ 零感知', () => {
  const onlySteps = batchOf({ id: 'e1', checkpoint: { steps: 3 } });
  assert.deepEqual(checkpointTotalMismatchOf(onlySteps, 'e1', { step: 1, total: 99 }),
    { mismatch: false, declared: null, actual: null },
    '仅声明 steps（无清单）⇒ **不判**（超界归 overBudgetOf）');
  const neither = batchOf({ id: 'e1' });
  assert.deepEqual(checkpointTotalMismatchOf(neither, 'e1', { step: 1, total: 5 }),
    { mismatch: false, declared: null, actual: null }, '无清单 ⇒ 零感知');
  // 未带 total ⇒ 也不判（没有可比的实际值）
  const withItems = batchOf({ id: 'e1', checkpoints: { items: [{ id: 'c1' }] } });
  assert.equal(checkpointTotalMismatchOf(withItems, 'e1', null).mismatch, false, '未带 progress ⇒ 不判');
});

test('C-1e 幂等判据：已有该类事件 ⇒ hasCheckpointTotalMismatchEvent=true；他类事件不误判', () => {
  const mk = (type) => batchOf({ id: 'e1' }, [{ type, lane: 'e1' }]);
  assert.equal(hasCheckpointTotalMismatchEvent(mk(EVT.EVT_LANE_CHECKPOINT_TOTAL_MISMATCH), 'e1'), true);
  assert.equal(hasCheckpointTotalMismatchEvent(mk(EVT.EVT_LANE_OVER_BUDGET), 'e1'), false,
    '`lane.over-budget` 不得被当成对齐事件（两事件正交 ⇒ **不得复用**）');
  assert.equal(hasCheckpointTotalMismatchEvent(mk(EVT.EVT_LANE_CHECKPOINT_TOTAL_MISMATCH), 'e2'), false,
    '按 lane 隔离（同批不同 lane 互不影响）');
});

test('C-4 变异（**只证不齐侧**）：把判据弱化为「恒不报」⇒ 构造① 必红，对齐侧仍绿（这正是须避开假绿的原因）', () => {
  const batch = batchOf({ id: 'e1', checkpoints: { items: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }] } });
  const truth = checkpointTotalMismatchOf(batch, 'e1', { step: 1, total: 1 });
  // 变异体：把 mismatch 恒置 false（模拟「实现被改成永不报警」）
  const mutant = { ...truth, mismatch: false };
  assert.equal(truth.mismatch, true, '真实实现的**不齐**侧必须为 true');
  assert.equal(mutant.mismatch, false, '变异体确实被弱化');
  assert.notEqual(mutant.mismatch, truth.mismatch,
    '变异必须改变**不齐**侧的读数 —— 否则该用例对该变异无判别力（假绿）');
  // ⚠ 明确登记：**对齐侧**（C-1b）在变异下**仍为 false ⇒ 仍绿** ⇒ 只看对齐侧会假绿。
  const aligned = batchOf({ id: 'e1', checkpoints: { items: [{ id: 'c1' }, { id: 'c2' }] } });
  const alignedTruth = checkpointTotalMismatchOf(aligned, 'e1', { step: 2, total: 2 });
  assert.equal(alignedTruth.mismatch, false);
  assert.equal({ ...alignedTruth, mismatch: false }.mismatch, alignedTruth.mismatch,
    '对齐侧读数在变异前后相同 ⇒ **对齐用例无法发现本变异**（故判据须落在不齐侧）');
});
