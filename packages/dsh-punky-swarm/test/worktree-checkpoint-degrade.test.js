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

// test/worktree-checkpoint-degrade.test.js —— 批 `punky-checkpoint-enforce-20261112` · lane `e2-gate`
//
// 判据源：`plan/checkpoint-enforce-spec.md` §E 无 worktree 留痕（e2）
//   · V-21 只读/审核 lane：无 worktree 调 `lane_checkpoint` ⇒ `ok:true` / `commit:null` / `mode:'no-worktree'`，
//          事件流新增**恰 1 条** `worktree.checkpoint` 且其 `commit === null`（`no-worktree-event`）
//   · V-22 渲染不撒谎：降级路径的渲染文本含 `recorded (no worktree`、**不含** `no-op`（`render-noop-gone`）
//   · V-23 git 不可用降级：`DSH_GIT_BIN` 指向不存在路径 ⇒ 仍 `ok:true` / `mode:'no-git'` + 落事件，
//          且**不阻断后续结算门**（`no-git-degrade`）
//
// 反例如何能红：
//   · 把降级路径写回旧的 `{ok:false, reason:'lane worktree not found…'}`（e1 实测的改动前回执）⇒ V-21 的
//     `ok===true` 与「事件恰 1 条」双双必红；
//   · 只改返回不改渲染 ⇒ V-22 的 `recorded (no worktree` 必红；
//   · 降级路径不写 `subtask` 字段 ⇒ V-23 末段的结算门（按显式覆盖判）必拒 ⇒ 本用例必红；
//   · 降级路径不写 `step/total` ⇒ 序贯覆盖判据失效（本套件 V-23 用显式覆盖，仍然可判）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../lib/state/store.js';
import { createTools } from '../lib/tools/register.js';
import { threeTierTasks, seedArtifacts, assessC } from './helpers/gate-fixture.mjs';

const SID = 'sess-ckpt-degrade';
const EXEC = { agent: { session: { id: SID } } };

async function mkHarness({ batchId, subtasks = undefined } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-ckptdegrade-'));
  const store = createStore(root);
  const ctx = {
    tools: { register: () => {}, guard: () => () => {} },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    subagents: { start: async () => ({ id: 'worker-stub-1', result: Promise.resolve({ output: [], stopReason: 'completed' }) }) },
  };
  const { tools } = createTools(ctx, { store, root, config: { dispatch: { provider: 'spawn' } } });
  // `team` 显式传（不注入默认标签 ⇒ 不用 `withDefaultTeam`，避免 `test/fixture-team-ledger.test.js` F2-6 账本漂移）
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  assessC(store, SID, { rationale: 'fixture：checkpoint 降级留痕用例的建批前置评估（三层 DAG ⇒ C 档）' });
  const tasks = threeTierTasks(['e1']).map((t) => (t.id === 'e1' && subtasks !== undefined ? { ...t, subtasks } : t));
  await by.wave_plan.execute({ batchId, team: 'software-team', tasks, assembly: { auditLane: 'a1' } }, EXEC);
  await by.batch_phase.execute({ batchId, phase: 'running' }, EXEC);
  seedArtifacts(root, SID, batchId, ['e1']);
  return { root, store, by, batchId };
}

const eventsOf = (store, batchId) => (store.readBatch(SID, batchId)?.events ?? []);
const checkpointsOf = (store, batchId, lane) => eventsOf(store, batchId)
  .filter((e) => e.type === 'worktree.checkpoint' && e.lane === lane);
/** 工具渲染文本（`output.render` 的返回是内容块数组）。 */
const renderOf = (tool, args, value) => (tool.output.render(args, value) ?? []).map((b) => b.text ?? '').join('\n');

// ══ V-21 只读/审核 lane 的无 worktree 留痕（`no-worktree-event`）═══════════════════════════════
test('no-worktree-event [V-21] 无 worktree 的 plan / audit lane ⇒ ok:true + commit:null + mode:no-worktree + 恰 1 条事件（commit:null）', async () => {
  const h = await mkHarness({ batchId: 'b-v21' });
  for (const lane of ['p1', 'a1']) {
    const before = checkpointsOf(h.store, 'b-v21', lane).length;
    const r = await h.by.lane_checkpoint.execute({ batchId: 'b-v21', laneId: lane, message: '只读 lane 留痕' }, EXEC);
    assert.equal(r.ok, true, lane + '：无 worktree 必须 ok:true（不再 fake no-op），实测 ' + JSON.stringify(r));
    assert.equal(r.committed, false, lane + '：无 worktree 不可有 commit');
    assert.equal(r.commit, null, lane + '：commit 必须为 null');
    assert.equal(r.mode, 'no-worktree', lane + '：成因须为 no-worktree，实测 ' + JSON.stringify(r.mode));
    const evts = checkpointsOf(h.store, 'b-v21', lane);
    assert.equal(evts.length - before, 1, lane + '：须新增**恰 1 条** worktree.checkpoint 事件');
    const evt = evts[evts.length - 1];
    assert.equal(evt.commit, null, lane + '：事件 commit 必须为 null');
    assert.equal(evt.mode, 'no-worktree', lane + '：事件须带 mode');
  }
});

// ══ V-22 渲染不撒谎（`render-noop-gone`）════════════════════════════════════════════════════════
test('render-noop-gone [V-22] 降级路径渲染含 `recorded (no worktree`、不含 `no-op`', async () => {
  const h = await mkHarness({ batchId: 'b-v22' });
  const r = await h.by.lane_checkpoint.execute({ batchId: 'b-v22', laneId: 'p1', message: '渲染面' }, EXEC);
  const text = renderOf(h.by.lane_checkpoint, { batchId: 'b-v22', laneId: 'p1', message: '渲染面' }, r);
  assert.ok(text.includes('recorded (no worktree'), '渲染须明说「已留痕（无 worktree）」，实测：' + JSON.stringify(text));
  assert.equal(text.includes('no-op'), false, '降级留痕不得再渲染成 no-op（e1 实测的改动前回执正是 no-op）');
  // 对照组：真正的「有 worktree 且无变更」路径仍应渲染 no-op（证明上一条不是把 no-op 一律删掉）
  const noChange = { ok: true, committed: false, reason: 'no changes (no-op)', worktree: 'x' };
  const noChangeText = renderOf(h.by.lane_checkpoint, {}, noChange);
  assert.ok(noChangeText.includes('no-op'), '真 no-change 路径须仍渲染 no-op（否则渲染面失去分辨力）：' + JSON.stringify(noChangeText));
});

// ══ V-23 git 不可用降级（`no-git-degrade`）══════════════════════════════════════════════════════
test('no-git-degrade [V-23] DSH_GIT_BIN 无效 ⇒ ok:true + mode:no-git + 事件（commit:null）；且不阻断后续结算门', async () => {
  const h = await mkHarness({ batchId: 'b-v23', subtasks: [{ id: 'a', target: 'exec/a.md' }, { id: 'b', target: 'exec/b.md' }] });
  await h.by.member_set_status.execute({ batchId: 'b-v23', lane: 'e1', status: 'running' }, EXEC);
  const prev = process.env.DSH_GIT_BIN;
  process.env.DSH_GIT_BIN = 'git-definitely-not-installed-xyz';
  try {
    const before = checkpointsOf(h.store, 'b-v23', 'e1').length;
    const c1 = await h.by.lane_checkpoint.execute({ batchId: 'b-v23', laneId: 'e1', message: 'a', progress: { step: 1, total: 2 }, subtaskId: 'a' }, EXEC);
    assert.equal(c1.ok, true, 'git 不可用必须仍 ok:true，实测 ' + JSON.stringify(c1));
    assert.equal(c1.commit, null, 'git 不可用 ⇒ commit 为 null');
    assert.equal(c1.mode, 'no-git', '成因须为 no-git');
    const after = checkpointsOf(h.store, 'b-v23', 'e1');
    assert.equal(after.length - before, 1, '须新增恰 1 条 worktree.checkpoint 事件');
    assert.equal(after[after.length - 1].commit, null);
    assert.equal(after[after.length - 1].mode, 'no-git');
    assert.equal(after[after.length - 1].step, 1, '降级路径仍须携带 progress.step');
    assert.equal(after[after.length - 1].subtask, 'a', '降级路径仍须携带 subtask 字段（结算门按它判覆盖）');
    const c2 = await h.by.lane_checkpoint.execute({ batchId: 'b-v23', laneId: 'e1', message: 'b', progress: { step: 2, total: 2 }, subtaskId: 'b' }, EXEC);
    assert.equal(c2.mode, 'no-git');
  } finally {
    if (prev === undefined) delete process.env.DSH_GIT_BIN; else process.env.DSH_GIT_BIN = prev;
  }
  // 「不阻断后续结算门」：显式覆盖齐备 ⇒ merged 必须放行（git 不可用不是结算阻断项）
  await h.by.member_set_status.execute({ batchId: 'b-v23', lane: 'e1', status: 'review' }, EXEC);
  const m = await h.by.member_settle.execute({ batchId: 'b-v23', lane: 'e1', status: 'merged' }, EXEC);
  assert.equal(m.status, 'merged', 'no-git 降级留痕照算完成 ⇒ 结算门必须放行（前提③）');
});

// ══ B-2 worktree 在场但零变更 ⇒ 仍留痕（`no-change-event`）══════════════════════════════════════
// 反例如何能红：把 `lane-worktree-tools.js` 的 `if (committed) {…}` 还原成单分支（B-2 修复前形态）
//   ⇒ 本用例「事件新增恰 1 条」与 `mode==='no-change'`、`subtask` 三处同时必红。
test('no-change-event [B-2] worktree 在场、零变更 ⇒ ok:true + commit:null + mode:no-change + 事件带 subtask', async (t) => {
  const h = await mkHarness({ batchId: 'b-b2', subtasks: [{ id: 'a', target: 'exec/a.md' }, { id: 'b', target: 'exec/b.md' }] });
  await h.by.member_set_status.execute({ batchId: 'b-b2', lane: 'e1', status: 'running' }, EXEC);
  let wt = null;
  try {
    wt = await h.by.lane_worktree_create.execute({ batchId: 'b-b2', laneId: 'e1' }, EXEC);
  } catch (e) {
    t.skip('本机 git 不可用，跳过（该面由 V-23 的 no-git 降级覆盖）：' + String(e?.message ?? e));
    return;
  }
  assert.equal(wt?.ok, true, '前置：worktree 须建成，实测 ' + JSON.stringify(wt));
  // 不做任何改动 ⇒ `git status --porcelain` 为空 ⇒ doCheckpoint 返回 committed:false（零变更分支）
  const before = checkpointsOf(h.store, 'b-b2', 'e1').length;
  const c = await h.by.lane_checkpoint.execute({ batchId: 'b-b2', laneId: 'e1', message: '零变更留痕', progress: { step: 1, total: 2 }, subtaskId: 'a' }, EXEC);
  assert.equal(c.ok, true, '零变更必须 ok:true，实测 ' + JSON.stringify(c));
  assert.equal(c.committed, false, '零变更不得有 commit');
  assert.equal(c.mode, 'no-change', '成因须为 no-change（与 no-worktree / no-git 区分），实测 ' + JSON.stringify(c.mode));
  const after = checkpointsOf(h.store, 'b-b2', 'e1');
  assert.equal(after.length - before, 1, 'B-2 修复后零变更也须新增**恰 1 条** worktree.checkpoint 事件（修复前为 0）');
  const evt = after[after.length - 1];
  assert.equal(evt.commit, null, '零变更事件 commit 必须为 null');
  assert.equal(evt.mode, 'no-change', '零变更事件须带 mode=no-change');
  assert.equal(evt.step, 1, '零变更事件须带 progress.step');
  assert.equal(evt.subtask, 'a', '零变更事件须带 subtask（G2 显式覆盖按它判）');
});
