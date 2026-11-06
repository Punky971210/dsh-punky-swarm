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

// test/lane-checkpoint-status-fallback.test.js
//
// 【批 `punky-checkpoint-wire-20261106` · lane `e2-status`】**读取端 fallback** 的判别力用例
// （判据源 `plan/ckpt-spec.md` §验收项 E-CK3 / E-CK4，编号照抄不重排）。
//
// ## 为什么必须正反两造
//   只测 fallback（E-CK3）会**假绿**：把优先序写成「指针一律覆盖事件」时 F-1 仍绿。
//   故 E-CK4 构造「事件 {2,5} + 指针 {4,5}（更大且不一致）」——取更大值 / 被指针抢位都会红。
//
// ## 为什么用事件注入而不是真跑 `lane_checkpoint`
//   `lane_checkpoint` 依赖 worktree/git，且**无 worktree 时早退**（`recordEarlyExitProgress` 只写指针、
//   不落事件）⇒ 想造「事件 + 指针并存」就必须建 git worktree，成本高且引入环境依赖。
//   本 lane 的被检面是**读端**（`lane_checkpoint_status` 只读 `batch.events` + `batch.laneProgress`）⇒
//   用 `store.appendEvent` / `store.updateLaneProgress` 直接构造读面状态，**零 git**、确定性。
//
// ## 前提校验不可省
//   F-1 先断言「`worktree.checkpoint` 事件确为空」——否则测到的是事件路径，fallback 分支未被覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import * as EVT from '../lib/state/event-types.js';
import { assessC } from './helpers/gate-fixture.mjs';
import { withDefaultTeam } from './helpers/skill-paths.mjs';
import { assertOutputConforms } from './helpers/schema-conformance.mjs';

const SID = 'sess-e2-fallback';
const EXEC_SESS = { agent: { session: { id: SID } } };

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-e2fb-'));
  const store = createStore(root);
  const { tools } = createTools(
    { tools: { register() {} }, logger: console },
    { store, root, config: { capabilities: { worktree: { enabled: true } } } },
  );
  // G1 前置：`wave_plan` 属 C 档动作 ⇒ 建批前先把会话评估为 C（走 assign_check 的同一落盘函数）
  assessC(store, SID, { rationale: 'fixture：e2-status 读取端 fallback 用例（建批前置评估）' });
  return { root, store, byName: withDefaultTeam(Object.fromEntries(tools.map((t) => [t.name, t]))), tools };
}

/** 事件注入（读面 = 事件流；不经 git） */
const injectCheckpointEvent = (store, batchId, payload) =>
  store.appendEvent(SID, batchId, EVT.EVT_WORKTREE_CHECKPOINT, { lane: 'l1', ...payload });

// ── E-CK3 阳性：只有 laneProgress、无 worktree.checkpoint 事件 ⇒ latest 非 null 且等于指针 ────────────
test('F-1 E-CK3 阳性：事件面为空时 latest 回落 laneProgress（改前恒 null）', async () => {
  const { store, byName } = setup();
  await byName.wave_plan.execute({ batchId: 'b-f1', tasks: [{ id: 'l1' }] }, EXEC_SESS);

  // 前提校验（不可省）：该 lane 无任何 worktree.checkpoint 事件 ⇒ 走的必是 fallback 分支
  const before = store.readBatch(SID, 'b-f1');
  assert.deepEqual(
    (before.events ?? []).filter((e) => e.type === EVT.EVT_WORKTREE_CHECKPOINT && e.lane === 'l1'),
    [],
    '前提：事件面确为空（否则本用例测到的是事件路径，fallback 未被覆盖）',
  );

  store.updateLaneProgress(SID, 'b-f1', 'l1', { step: 2, total: 5, status: 'running' });
  const st = await byName.lane_checkpoint_status.execute({ batchId: 'b-f1', laneId: 'l1' }, EXEC_SESS);

  assert.deepEqual(st.checkpoints, [], '无事件 ⇒ checkpoints 为空数组（子对象形状未变）');
  assert.deepEqual(st.latest, { step: 2, total: 5 }, '无事件时必须回落断点指针（改前此断言必红：latest=null）');
  assert.equal(st.latestSource, 'laneProgress', '来源留痕：latest 来自断点指针');
  assertOutputConforms(byName.lane_checkpoint_status, st, 'F-1 返回值');
});

// ── E-CK4 阴性：事件与指针不一致 ⇒ 一律以事件为准（禁数值合并 / 禁取更大 step）──────────────────────
test('F-2 E-CK4 阴性：事件 {2,5} vs 指针 {4,5} ⇒ latest 取事件值，latestSource=event', async () => {
  const { store, byName } = setup();
  await byName.wave_plan.execute({ batchId: 'b-f2', tasks: [{ id: 'l1' }] }, EXEC_SESS);
  injectCheckpointEvent(store, 'b-f2', { commit: 'deadbee', message: 'ev', step: 2, total: 5 });
  // 故意与事件不一致，且 step **更大**：取更大值 / 被指针抢位的实现都会红
  store.updateLaneProgress(SID, 'b-f2', 'l1', { step: 4, total: 5, status: 'running' });

  const st = await byName.lane_checkpoint_status.execute({ batchId: 'b-f2', laneId: 'l1' }, EXEC_SESS);

  assert.equal(st.checkpoints[0].step, 2, '事件本身被正确投影（前提）');
  assert.deepEqual(st.latest, { step: 2, total: 5 }, '事件优先：禁取更大 step(4)、禁被指针抢位、禁数值合并');
  assert.equal(st.latestSource, 'event', '来源留痕：latest 来自事件');
  assertOutputConforms(byName.lane_checkpoint_status, st, 'F-2 返回值');
});

// ── 阴性补充（零回归）：事件面与指针都为空 ⇒ latest 仍 null，且 latestSource 字段缺席 ────────────────
test('F-3 零回归：无事件且无指针 ⇒ latest 仍为 null（字段形状与改前一致）', async () => {
  const { byName } = setup();
  await byName.wave_plan.execute({ batchId: 'b-f3', tasks: [{ id: 'l1' }] }, EXEC_SESS);

  const st = await byName.lane_checkpoint_status.execute({ batchId: 'b-f3', laneId: 'l1' }, EXEC_SESS);

  assert.equal(st.latest, null, '两源皆空 ⇒ latest 必须保持 null（既有 worktree-tools T7 口径）');
  assert.equal('latestSource' in st, false, '无进度 ⇒ latestSource 字段缺席（不写 null，保持旧返回值形状）');
  assertOutputConforms(byName.lane_checkpoint_status, st, 'F-3 返回值');
});

// ── 边界：事件存在但**不带 progress** ⇒ 仍回落指针（"无携带 progress 的事件"同属兜底面）──────────────
test('F-4 边界：事件不带 step/total + 指针有值 ⇒ 回落指针（latestSource=laneProgress）', async () => {
  const { store, byName } = setup();
  await byName.wave_plan.execute({ batchId: 'b-f4', tasks: [{ id: 'l1' }] }, EXEC_SESS);
  injectCheckpointEvent(store, 'b-f4', { commit: 'c-plain', message: 'plain' }); // 无 step/total（向后兼容形态）
  store.updateLaneProgress(SID, 'b-f4', 'l1', { step: 3, total: 3, status: 'running' });

  const st = await byName.lane_checkpoint_status.execute({ batchId: 'b-f4', laneId: 'l1' }, EXEC_SESS);

  assert.equal(st.checkpoints[0].step, undefined, '无 progress 的事件投影不出 step（前提）');
  assert.deepEqual(st.latest, { step: 3, total: 3 }, '事件面无任何携带 step/total 的 checkpoint ⇒ 必须回落指针');
  assert.equal(st.latestSource, 'laneProgress');
});
