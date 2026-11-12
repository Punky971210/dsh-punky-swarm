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

// test/dialect-lane-single-point.test.js —— 批 `punky-ckpt-followup-20261112` · lane `e1-impl` · subtask `s1`
//
// 判据源：`plan/ckpt-followup-spec.md`
//   · V-2 四形态语义（lane 自身有键 / 批内另有有键 / 全无键 / orphan 回落）
//   · V-3 等价不变量 `dialectOfLane(batch,lane) === dialectOf(batch)`（八形态全须相等）
//
// 这两条是**防 G-04 复发的锁**（G-04 = 渲染按 lane 级判、门按批级判 ⇒ 混合方言批出现
// 「建议档文案 + 门按强制档拒派」的自相矛盾指令）：
//   · 谁把「lane 无 `subtasks` 键 ⇒ 'legacy'」写成 lane 级硬编码 ⇒ V-2 第 2 例 + V-3 混合形态**立刻红**；
//   · 谁把回落分支删掉改成常量 ⇒ 同上；
//   · 谁在别处另写一份方言判据（第二份实现）⇒ V-1 的静态锁（`lib/` 内 `function dialectOfLane(` 恰 1 行）红。
//
// 纯函数用例：`dialectOf` / `dialectOfLane` 只读入参 batch 对象，零 store、零写盘、零 git。
import test from 'node:test';
import assert from 'node:assert/strict';

import { dialectOf, dialectOfLane } from '../lib/state/resume.js';

/** `wavePlan` 存的是 **wave 数组**（`[{wave, tasks:[…]}]`），不是 task 数组。 */
function batchOf(tasks) {
  return { wavePlan: [{ wave: 1, tasks }] };
}

const EXEC_LAYER = { layer: 'exec' };

// ── V-2｜四形态语义 ──────────────────────────────────────────────────────────
test('V-2 dialectOfLane 四形态语义：lane 有键 / 批内另有有键 / 全无键 / orphan', () => {
  // ① lane 自身含 `subtasks`（批内至少它有）⇒ 'subtasks'
  const ownKey = batchOf([{ id: 'e1', ...EXEC_LAYER, subtasks: [{ id: 's1', target: 'exec/a.md' }] }]);
  assert.equal(dialectOfLane(ownKey, 'e1'), 'subtasks', '① lane 自身含 subtasks 键 ⇒ subtasks');

  // ② lane **不含** `subtasks`、批内**另有** lane 含 ⇒ 'subtasks'（回落批级）
  //    ⚠ 这是 G-04 分叉的原始形状：若此处返回 'legacy'，渲染出建议档、门按强制档拒派 ⇒ 指令自相矛盾。
  const mixed = batchOf([
    { id: 'e1', ...EXEC_LAYER, subtasks: [{ id: 's1', target: 'exec/a.md' }] },
    { id: 'e3', ...EXEC_LAYER, checkpoints: [{ id: 'c1', target: 'exec/c1.md' }] },
  ]);
  assert.equal(dialectOfLane(mixed, 'e3'), 'subtasks', '② lane 无键但批内另有有键 ⇒ 回落批级 subtasks');

  // ③ 批内无任何 `subtasks` ⇒ 'legacy'
  const allLegacy = batchOf([
    { id: 'e1', ...EXEC_LAYER, checkpoints: [{ id: 'c1', target: 'exec/c1.md' }] },
    { id: 'e2', ...EXEC_LAYER },
  ]);
  assert.equal(dialectOfLane(allLegacy, 'e1'), 'legacy', '③ 全 legacy 批 ⇒ legacy');

  // ④ lane **不在** `wavePlan`（orphan）⇒ 等于 `dialectOf(batch)`
  assert.equal(dialectOfLane(mixed, 'ghost'), dialectOf(mixed),
    '④ orphan lane @subtasks 批 ⇒ 等于批级判决');
  assert.equal(dialectOfLane(mixed, 'ghost'), 'subtasks', '④ orphan lane @subtasks 批 ⇒ subtasks');
  assert.equal(dialectOfLane(allLegacy, 'ghost'), dialectOf(allLegacy),
    '④ orphan lane @legacy 批 ⇒ 等于批级判决');
  assert.equal(dialectOfLane(allLegacy, 'ghost'), 'legacy', '④ orphan lane @legacy 批 ⇒ legacy');
});

// ── V-3｜等价不变量（八形态） ────────────────────────────────────────────────
//   八形态全覆盖；每形态对「批内每条 lane + 一个 orphan」逐条比对两条函数取值。
//   限定量词：不相等例 **0**。
test('V-3 不变量 dialectOfLane(batch,lane) === dialectOf(batch)（八形态，不相等例 0）', () => {
  const shapes = [
    // ① `wavePlan` 缺省 / 非数组（两种输入同属「无 wave 面」一形态）
    { name: '① wavePlan 缺省', batch: {}, lanes: ['e1', 'ghost'] },
    { name: '① wavePlan 非数组', batch: { wavePlan: 'not-an-array' }, lanes: ['e1', 'ghost'] },
    // ② `wavePlan[].tasks` 缺省
    { name: '② tasks 缺省', batch: { wavePlan: [{ wave: 1 }] }, lanes: ['e1', 'ghost'] },
    // ③ 全 legacy
    {
      name: '③ 全 legacy',
      batch: batchOf([
        { id: 'e1', ...EXEC_LAYER, checkpoints: [{ id: 'c1', target: 'exec/c1.md' }] },
        { id: 'e2', ...EXEC_LAYER, checkpoints: [{ id: 'c2', target: 'exec/c2.md' }] },
      ]),
      lanes: ['e1', 'e2', 'ghost'],
    },
    // ④ 全 subtasks
    {
      name: '④ 全 subtasks',
      batch: batchOf([
        { id: 'e1', ...EXEC_LAYER, subtasks: [{ id: 's1', target: 'exec/a.md' }] },
        { id: 'e2', ...EXEC_LAYER, subtasks: [{ id: 's2', target: 'exec/b.md' }] },
      ]),
      lanes: ['e1', 'e2', 'ghost'],
    },
    // ⑤ 混合（一 lane 有、一 lane 无）—— G-04 的原始形状
    {
      name: '⑤ 混合',
      batch: batchOf([
        { id: 'e1', ...EXEC_LAYER, subtasks: [{ id: 's1', target: 'exec/a.md' }] },
        { id: 'e2', ...EXEC_LAYER },
        { id: 'e3', ...EXEC_LAYER, checkpoints: [{ id: 'c1', target: 'exec/c1.md' }] },
      ]),
      lanes: ['e1', 'e2', 'e3', 'ghost'],
    },
    // ⑥ `subtasks: null`（**键在场**、值为 null）⇒ 仍算新方言（判据是键在场，不是值非空）
    {
      name: '⑥ subtasks=null（键在场）',
      batch: batchOf([
        { id: 'e1', ...EXEC_LAYER, subtasks: null },
        { id: 'e2', ...EXEC_LAYER },
      ]),
      lanes: ['e1', 'e2', 'ghost'],
    },
    // ⑦ `subtasks: []`（键在场、空数组）⇒ 仍是新方言 —— 正是 G1 要拒的形状，必须能判成 subtasks
    {
      name: '⑦ subtasks=[]（键在场空数组）',
      batch: batchOf([
        { id: 'e1', ...EXEC_LAYER, subtasks: [] },
        { id: 'e2', ...EXEC_LAYER },
      ]),
      lanes: ['e1', 'e2', 'ghost'],
    },
  ];

  let compared = 0;
  const mismatches = [];
  for (const shape of shapes) {
    const batchDialect = dialectOf(shape.batch);
    for (const lane of shape.lanes) {
      const laneDialect = dialectOfLane(shape.batch, lane);
      compared += 1;
      if (laneDialect !== batchDialect) {
        mismatches.push(shape.name + ' / lane=' + lane + ' ⇒ ' + laneDialect + ' !== batch ' + batchDialect);
      }
    }
  }
  assert.deepEqual(mismatches, [], '不相等例必须为 0；实测不相等：' + mismatches.join(' | '));
  // 八形态全部参与比对（每形态至少 2 条 lane，故 compared ≥ 16）；此处只锁「八形态无遗漏」。
  assert.ok(shapes.length === 8, '八形态须全数覆盖，实测 ' + shapes.length);
  assert.ok(compared >= 16, '逐形态逐 lane 均已比对，实测 ' + compared);
});

// ── V-3 附｜混合批两条 lane 取值同源（门与渲染共用的直接证据） ────────────────
test('V-3 附 混合方言批：同一批内两条 lane 的方言取值恒等（门与渲染同源的直接读数）', () => {
  const mixed = batchOf([
    { id: 'e1', ...EXEC_LAYER, subtasks: [{ id: 's1', target: 'exec/a.md' }] },
    { id: 'e3', ...EXEC_LAYER, checkpoints: [{ id: 'c1', target: 'exec/c1.md' }] },
  ]);
  assert.equal(dialectOfLane(mixed, 'e1'), dialectOfLane(mixed, 'e3'),
    '混合批内两条 lane 方言必须恒等（若不等即是 G-04 分叉复活）');
  assert.equal(dialectOfLane(mixed, 'e1'), 'subtasks');
  assert.equal(dialectOfLane(mixed, 'e3'), 'subtasks');
});

// ── 零副作用：判据函数不得改动入参 ───────────────────────────────────────────
test('V-3 附 dialectOf/dialectOfLane 纯读：调用前后 batch 逐字相等', () => {
  const batch = batchOf([
    { id: 'e1', ...EXEC_LAYER, subtasks: [{ id: 's1', target: 'exec/a.md' }] },
    { id: 'e2', ...EXEC_LAYER, checkpoints: [{ id: 'c1', target: 'exec/c1.md' }] },
  ]);
  const before = JSON.stringify(batch);
  dialectOf(batch);
  dialectOfLane(batch, 'e1');
  dialectOfLane(batch, 'e2');
  dialectOfLane(batch, 'ghost');
  assert.equal(JSON.stringify(batch), before, '判据函数必须纯读、零副作用（不得 normalize 入参或写回）');
});
