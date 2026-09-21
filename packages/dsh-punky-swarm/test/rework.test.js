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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import * as schema from '../lib/schema.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-rework-'));
const store = createStore(root);
const S = 'sess-rw';

// 【2026-09-21 K3 去返工边】改判：本用例原为「允许 review→running」的正向锁；返工边去除后**反转**为反向锁，
//   目的从「保护返工能力」变为「**锁死返工边不得复活**」（失败即终态，返工 = gap-list + 新任务批次）。
test('schema rejects review -> running (返工边已去，K3)', () => {
  assert.equal(schema.canTransitionMember('review', 'running'), false);
  assert.equal(schema.canTransitionMember('running', 'review'), true); // 提交评审路径不受影响
  assert.deepEqual([...schema.MEMBER_TRANSITIONS.review], ['merged', 'conflict', 'failed']);
});

// 【r2 同步 · B2/B3/A1】旧 fixture 用「lane 无 layer 的小批」驱动返工/结算语义，与 r2「拒绝免检」冲突：
//   · B2：无 `layer` 的 lane 不得整 lane 免检 ⇒ 结算时拒 `GATE_LANE_LAYER_MISSING`；
//   · B3/A1：批次须有 exec 或 audit 层、且 plan 产物必须被下游 consume（不得建 plan-only 批）。
//   ⇒ 统一改**合规三层批**：laneIds 归 exec 层，附 plan 层（产物被消费）与 audit 层。
const SPEC_OK = '# spec\n## 验收标准\n- x\n## 约束\n- y\n';
function threeTierTasks(laneIds) {
  return [
    { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 'spec' },
    ...laneIds.map((id) => ({ id, layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/' + id + '.md'], cmd: 'run', deps: ['p1'] })),
    { id: 'a1', layer: 'audit', consume: ['plan/spec.md'], produce: ['audit/r.md'], cmd: 'review', deps: laneIds },
  ];
}
function writeArt(batchId, rel, content) {
  const abs = path.join(root, 'sessions', S, 'artifacts', batchId, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
function seedArtifacts(batchId, laneIds) {
  writeArt(batchId, 'plan/spec.md', SPEC_OK);       // entry 门 presence 硬约束
  for (const id of laneIds) writeArt(batchId, 'exec/' + id + '.md', 'out'); // exit 门：声明产物须在场
  writeArt(batchId, 'audit/r.md', 'review');
}
function runLane(batchId, lane) {
  store.setMember(S, batchId, lane, 'running');
  store.setMember(S, batchId, lane, 'review');
  store.setMember(S, batchId, lane, 'merged');
}

// 【2026-09-21 K3 去返工边】改判：原「review→running 打回可反复」的循环已不可达 ⇒ 用例改为**反向锁**：
//   派发→提交评审→**重派被拒**（状态机拒）→ 直接 merged；并断言事件流中**零** review→running 记录。
test('rework cycle 已废止：review 后重派被拒，只可 merged/conflict/failed（K3）', () => {
  const plan = buildWavePlan({ batchId: 'b-rework', tasks: threeTierTasks(['t1']) });
  store.createBatch(S, { batchId: 'b-rework', wavePlan: plan, phase: 'running' });
  seedArtifacts('b-rework', ['t1']);
  runLane('b-rework', 'p1');
  store.setMember(S, 'b-rework', 't1', 'running');   // 派发
  store.setMember(S, 'b-rework', 't1', 'review');    // 提交评审
  assert.throws(() => store.setMember(S, 'b-rework', 't1', 'running'), /invalid member transition/); // 打回返工 ⇒ 拒
  store.setMember(S, 'b-rework', 't1', 'merged');    // 通过（review→merged 仍合法）
  runLane('b-rework', 'a1'); // r2 同步：autoReleaseable 要求**全部** lane merged ⇒ audit 层亦须结算
  const b = store.readBatch(S, 'b-rework');
  assert.equal(b.lanes.t1, 'merged');
  const reworks = b.events.filter((e) => e.type === 'member.settled' && e.lane === 't1' && e.from === 'review' && e.to === 'running').length;
  assert.equal(reworks, 0, '返工边已去 ⇒ 事件流不得再有 review→running 记录');
  assert.equal(store.batchAutoReleaseable(b), true);
});

test('autoReleaseable false when conflict/failed present', () => {
  const plan = buildWavePlan({ batchId: 'b-cf', tasks: threeTierTasks(['a', 'b']) });
  store.createBatch(S, { batchId: 'b-cf', wavePlan: plan, phase: 'running' });
  seedArtifacts('b-cf', ['a', 'b']);
  runLane('b-cf', 'a');
  store.setMember(S, 'b-cf', 'b', 'running');
  store.setMember(S, 'b-cf', 'b', 'review');
  store.setMember(S, 'b-cf', 'b', 'failed', '构造失败终态：用户 2026-09-14 裁决（grilling Q10=A）：新语义下 note 为必填，补参数不涉断言改写');
  assert.equal(store.batchAutoReleaseable(store.readBatch(S, 'b-cf')), false);
});

// 【2026-09-21 K3 去返工边】改判：attempt「≥3 次打回升级」标记原本**派生自** review→running 事件计数。
//   返工边去除后该派生源消失 ⇒ 用例改为**反向锁**：第二轮派发即被拒，事件流中 attempt 计数恒为 0。
//   ⚠ 连带结论：**attempt 升级标记在现行语义下已无派生源** ⇒ 如需保留该能力，须另立派生口径（登记为待裁，见蓝图 §8）。
test('3-retreat escalation 不再可由 review→running 派生（K3：该派生源已消失）', () => {
  const plan = buildWavePlan({ batchId: 'b-esc', tasks: [{ id: 'x' }] });
  store.createBatch(S, { batchId: 'b-esc', wavePlan: plan, phase: 'running' });
  store.setMember(S, 'b-esc', 'x', 'running');
  store.setMember(S, 'b-esc', 'x', 'review');
  assert.throws(() => store.setMember(S, 'b-esc', 'x', 'running'), /invalid member transition/);
  const b = store.readBatch(S, 'b-esc');
  const reworks = b.events.filter((e) => e.type === 'member.settled' && e.lane === 'x' && e.from === 'review' && e.to === 'running').length;
  assert.equal(reworks, 0, '返工边已去 ⇒ attempt 不得再由 review→running 累加');
});
