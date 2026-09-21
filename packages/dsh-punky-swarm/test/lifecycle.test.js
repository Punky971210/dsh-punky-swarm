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

// P1-4 lane 条件 + P1-7 棘轮 —— store / wave-plan 集成测试（含存量兼容与 assert→machine 切换回归）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan, validateWavePlan } from '../lib/wave-plan.js';
import { loadRules } from '../lib/state/machine-rules.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-lc-'));
const S = 'sess-lc';

// ---- P1-4 ① 建批静态声明（wave-plan.js）----
test('buildWavePlan carries condition: object array form (normalized)', () => {
  const plan = buildWavePlan({
    batchId: 'b-cond',
    tasks: [
      { id: 'x', condition: [{ path: 'plan/spec.md', exists: true }, { path: 'plan/tree.json', exists: true }] },
    ],
  });
  const t = plan.wavePlan[0].tasks[0];
  assert.deepEqual(t.condition, [{ path: 'plan/spec.md', exists: true }, { path: 'plan/tree.json', exists: true }]);
  assert.equal(validateWavePlan(plan), true);
});

test('buildWavePlan carries condition: string shorthand form (normalized to object array)', () => {
  const plan = buildWavePlan({
    batchId: 'b-cond2',
    tasks: [{ id: 'x', condition: ['plan/spec.md'] }],
  });
  assert.deepEqual(plan.wavePlan[0].tasks[0].condition, [{ path: 'plan/spec.md', exists: true }]);
});

test('buildWavePlan: no condition defaults to null; empty array -> null', () => {
  const plan = buildWavePlan({ batchId: 'b-cond3', tasks: [{ id: 'x' }] });
  assert.equal(plan.wavePlan[0].tasks[0].condition, null);
  const plan2 = buildWavePlan({ batchId: 'b-cond4', tasks: [{ id: 'x', condition: [] }] });
  assert.equal(plan2.wavePlan[0].tasks[0].condition, null);
});

test('buildWavePlan rejects invalid condition declarations (fail-closed)', () => {
  assert.throws(() => buildWavePlan({ batchId: 'b', tasks: [{ id: 'x', condition: 'plan/a.md' }] }), /condition must be an array/);
  assert.throws(() => buildWavePlan({ batchId: 'b', tasks: [{ id: 'x', condition: [42] }] }), /condition entries must be/);
  assert.throws(() => buildWavePlan({ batchId: 'b', tasks: [{ id: 'x', condition: [{ path: '' }] }] }), /non-empty string/);
  assert.throws(() => buildWavePlan({ batchId: 'b', tasks: [{ id: 'x', condition: [{ path: 'plan/a.md', exists: false }] }] }), /exists must be true/);
  assert.throws(() => buildWavePlan({ batchId: 'b', tasks: [{ id: 'x', condition: ['other/a.md'] }] }), /must be under plan\/\|exec\/\|audit\//);
  assert.throws(() => buildWavePlan({ batchId: 'b', tasks: [{ id: 'x', condition: ['artifacts/other-batch/plan/a.md'] }] }), /cross-batch reference is disabled/);
});

test('validateWavePlan rejects forged condition (non-normalized form)', () => {
  const plan = buildWavePlan({ batchId: 'b-forge', tasks: [{ id: 'x', condition: ['plan/a.md'] }] });
  const forged = JSON.parse(JSON.stringify(plan));
  forged.wavePlan[0].tasks[0].condition = 'plan/a.md'; // 字符串形态不是规范化后的对象数组
  assert.throws(() => validateWavePlan(forged), /condition must be/);
  const forged2 = JSON.parse(JSON.stringify(plan));
  forged2.wavePlan[0].tasks[0].condition = [{ path: 'plan/a.md', exists: false }];
  assert.throws(() => validateWavePlan(forged2), /exists/);
});

// ---- P1-4 ②③ 派发前校验：满足派发 / 不满足自动 skipped（store.js 接线）----
// 【r2 同步 · B2/B3/A1】旧 fixture 用「单 lane 批（且被测 lane 无 layer）」跑条件语义，与 r2 新语义冲突：
//   · B2 拒绝免检：无 `layer` 的 lane 不得整 lane 免检（exit 门拒 `GATE_LANE_LAYER_MISSING`）；
//   · B3 零执行零验收不得 complete / A1 plan 产物必须被下游 consume ⇒ **不得建 plan-only 批**。
//   ⇒ 条件测试的被测 lane 归 **exec 层**，并纳入合规三层批（plan 产物被 exec/audit consume）。
const SPEC_OK = '# spec\n## 验收标准\n- x\n## 约束\n- y\n';
function writeArtifact(batchId, rel, content) {
  const abs = path.join(root, 'sessions', S, 'artifacts', batchId, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}
function threeTierWithProbe(probe) {
  return [
    { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 'spec' },
    { ...probe, consume: ['plan/spec.md'] },
    { id: 'a1', layer: 'audit', consume: ['plan/spec.md'], produce: ['audit/r.md'], cmd: 'review', deps: [probe.id] },
  ];
}
function makeStoreWithBatch(batchId, task, opts = {}) {
  const store = opts.store ?? createStore(root);
  const plan = buildWavePlan({ batchId, tasks: threeTierWithProbe(task) });
  store.createBatch(S, { batchId, wavePlan: plan, phase: 'running' });
  // 上游在场（entry 门 presence 硬约束）；`seed:false` 保留「上游全缺」的原始构造（条件未满足用例）
  if (opts.seed !== false) writeArtifact(batchId, 'plan/spec.md', SPEC_OK);
  return store;
}

test('L2: condition satisfied -> pending->running dispatches normally', () => {
  const batchId = 'b-l2';
  // r2 同步：被测 lane 补 exec 层并纳入合规三层批（见上方说明）
  const store = makeStoreWithBatch(batchId, { id: 'x', layer: 'exec', outputs: ['exec/x.md'], condition: [{ path: 'plan/spec.md', exists: true }] });
  store.setMember(S, batchId, 'x', 'running');
  assert.equal(store.readBatch(S, batchId).lanes.x, 'running');
});

test('L3: condition unmet -> auto skipped + lane.skipped event + wavePlan untouched', () => {
  const batchId = 'b-l3';
  const store = makeStoreWithBatch(batchId, { id: 'x', layer: 'exec', outputs: ['exec/x.md'], condition: [{ path: 'plan/missing.md', exists: true }] });
  const before = JSON.stringify(store.readBatch(S, batchId).wavePlan);
  store.setMember(S, batchId, 'x', 'running'); // 不 throw——自动落 skipped
  const b = store.readBatch(S, batchId);
  assert.equal(b.lanes.x, 'skipped');
  const skipEv = b.events.find((e) => e.type === 'lane.skipped');
  assert.ok(skipEv, 'lane.skipped event missing');
  assert.equal(skipEv.note, 'condition unmet: plan/missing.md');
  assert.ok(b.events.some((e) => e.type === 'member.settled' && e.to === 'skipped' && e.from === 'pending'));
  // wavePlan 固定语义：与建批时逐字节一致（不重算）
  assert.equal(JSON.stringify(b.wavePlan), before);
});

test('L3b: string shorthand condition unmet -> auto skipped with missing list', () => {
  const batchId = 'b-l3b';
  const store = makeStoreWithBatch(batchId, { id: 'x', layer: 'exec', outputs: ['exec/x.md'], condition: ['plan/dep.md', 'plan/spec.md'] }, { seed: false });
  store.setMember(S, batchId, 'x', 'running');
  const b = store.readBatch(S, batchId);
  assert.equal(b.lanes.x, 'skipped');
  assert.ok(b.events.find((e) => e.type === 'lane.skipped' && e.note === 'condition unmet: plan/dep.md, plan/spec.md'));
});

test('L4: upstream skipped -> downstream consume missing -> GATE_ENTRY_MISSING (no transitive auto-skip)', () => {
  const batchId = 'b-l4';
  const store = createStore(root);
  const plan = buildWavePlan({
    batchId,
    tasks: [
      { id: 'up', layer: 'exec', condition: [{ path: 'plan/gone.md', exists: true }] }, // 条件缺失 → 自动 skipped
      { id: 'down', layer: 'exec', deps: ['up'], consume: ['exec/up.out'] },            // 无 condition，只 consume
      { id: 'aud', layer: 'audit' },                                                     // 三层契约：有 exec 必有 audit
    ],
  });
  store.createBatch(S, { batchId, wavePlan: plan, phase: 'running' });
  store.setMember(S, batchId, 'up', 'running'); // up 落 skipped
  assert.equal(store.readBatch(S, batchId).lanes.up, 'skipped');
  // 下游：引擎不自动跳——entry gate 既有语义 GATE_ENTRY_MISSING 拒派
  assert.throws(() => store.setMember(S, batchId, 'down', 'running'), /GATE_ENTRY_MISSING/);
  assert.equal(store.readBatch(S, batchId).lanes.down, 'pending'); // 下游状态未被引擎改动
});

test('L5: legacy batch without condition is always satisfied (read-compatible)', () => {
  const batchId = 'b-l5';
  const store = createStore(root);
  const plan = buildWavePlan({ batchId, tasks: [{ id: 'x' }] }); // 无 layer 无 condition
  store.createBatch(S, { batchId, wavePlan: plan, phase: 'running' });
  assert.doesNotThrow(() => store.setMember(S, batchId, 'x', 'running'));
  assert.equal(store.readBatch(S, batchId).lanes.x, 'running');
});

// ---- P1-7 store 接线：assert→machine 切换 + rules 注入 ----
test('R1b: store assert switch keeps behavior identical (invalid transitions still rejected)', () => {
  const batchId = 'b-r1';
  // r2 同步：被测 lane 补 exec 层（B2 拒绝免检）+ 纳入合规三层批（B3/A1）；exit 门要求声明产物在场 ⇒ 落盘
  const store = createStore(root);
  const plan = buildWavePlan({ batchId, tasks: threeTierWithProbe({ id: 'x', layer: 'exec', outputs: ['exec/x.md'], cmd: 'run' }) });
  store.createBatch(S, { batchId, wavePlan: plan }); // phase 缺省 planning
  writeArtifact(batchId, 'plan/spec.md', SPEC_OK);
  writeArtifact(batchId, 'exec/x.md', 'out');
  assert.throws(() => store.setMember(S, batchId, 'x', 'merged'), /invalid member transition/); // pending→merged 非法
  assert.throws(() => store.setPhase(S, batchId, 'complete'), /invalid batch phase transition/); // planning→complete 非法
  store.setPhase(S, batchId, 'running');
  store.setMember(S, batchId, 'x', 'running');
  store.setMember(S, batchId, 'x', 'review');
  store.setMember(S, batchId, 'x', 'merged');
  assert.equal(store.readBatch(S, batchId).lanes.x, 'merged');
});

test('R2b: injected rules (tightened) are enforced by store', () => {
  const batchId = 'b-r2';
  const rules = loadRules({ ratchet: { memberRules: { pending: ['running'] } } }); // 删 pending→skipped
  const store = createStore(root, { rules });
  const plan = buildWavePlan({ batchId, tasks: [{ id: 'x', condition: ['plan/nope.md'] }] });
  store.createBatch(S, { batchId, wavePlan: plan, phase: 'running' });
  // 条件缺失本来会落 skipped（pending→skipped）——但棘轮收紧后该迁移被拒 → 迁移判定先行 throw（fail-closed 优先）
  assert.throws(() => store.setMember(S, batchId, 'x', 'running'), /invalid member transition/);
  assert.equal(store.readBatch(S, batchId).lanes.x, 'pending');
});

test('R3b: batch transition tightening via injected rules', () => {
  const batchId = 'b-r3';
  const rules = loadRules({ ratchet: { batchRules: { running: ['paused'] } } }); // 删 running→complete
  const store = createStore(root, { rules });
  // r2 同步：同 R1b（补 exec 层 + 合规三层批 + 声明产物在场）
  const plan = buildWavePlan({
    batchId,
    tasks: threeTierWithProbe({ id: 'x', layer: 'exec', outputs: ['exec/x.md'], cmd: 'run' }),
  });
  store.createBatch(S, { batchId, wavePlan: plan, phase: 'running' });
  writeArtifact(batchId, 'plan/spec.md', SPEC_OK);
  writeArtifact(batchId, 'exec/x.md', 'out');
  store.setMember(S, batchId, 'x', 'running');
  store.setMember(S, batchId, 'x', 'review');
  store.setMember(S, batchId, 'x', 'merged');
  assert.throws(() => store.setPhase(S, batchId, 'complete'), /invalid batch phase transition/); // 收紧后 running→complete 被拒
  assert.equal(store.readBatch(S, batchId).phase, 'running');
});
