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

// C2 worktree 四工具单测（决策包 §2.3 验收 T1-T5 + B2 checkpoint 保全引用 T6/T7）：
// T1 创建：worktree 目录存在 / punky/<laneId> 分支存在 / 基线=orch HEAD / 重复创建幂等 / 身份兜底
// T2 checkpoint：提交出现（git log 可查）/ 无变更 no-op（不产生空提交）
// T3 合并：成功 → 产物入 orch + worktree/分支清理；冲突 → 保留现场 + 冲突文件清单（不自动解决）
// T4 串行化：merge 队列锁等待（同批次 merge 串行）+ 与 lane_claim 并存（worktree 场景 lane_claim 仍锁批次状态写）
// T5 git 依赖：git 不可用 → 工具返回清晰错误不挂起；enabled=false → 不注册（工具总数 14 不变）
// T6 B2 progress checkpoint：事件含 step/total + commit message 内嵌 "step N/total"（git log 可查）；向后兼容
// T7 B2 lane_checkpoint_status：只读查询 checkpoint 历史 + latest；不依赖 git（git 不可用也可查）
// 备注：本文件在 git 可用环境运行（git 是本能力硬依赖，决策包 T5 要求环境 git 可用）；
//       引擎状态根内布局 <root>/sessions/<sessionId>/worktrees/<batchId>/{_repo,orch,<laneId>}
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import * as lock from '../lib/lock.js';

const EXEC_SESS = { agent: { session: { id: 'sess-wt' } } };

function git(args, { cwd } = {}) {
  try {
    const out = execFileSync('git', args, {
      cwd: cwd ?? process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return { ok: true, stdout: String(out ?? '').trim() };
  } catch (e) {
    return { ok: false, stderr: e?.stderr ? String(e.stderr).trim() : String(e?.message ?? e) };
  }
}

function setup(extraConfig = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-wt-'));
  const store = createStore(root);
  const registered = [];
  const ctx = { tools: { register: (t) => registered.push(t) }, logger: console };
  const { tools } = createTools(ctx, {
    store, root,
    config: { capabilities: { worktree: { enabled: true } }, ...extraConfig },
  });
  return { root, store, byName: Object.fromEntries(tools.map((t) => [t.name, t])), registered };
}

function wtRoot(root, batchId) { return path.join(root, 'sessions', 'sess-wt', 'worktrees', batchId); }
function lanePath(root, batchId, laneId) { return path.join(wtRoot(root, batchId), laneId); }
function orchPath(root, batchId) { return path.join(wtRoot(root, batchId), 'orch'); }
const repoPath = (root, batchId) => path.join(wtRoot(root, batchId), '_repo');
const refExists = (root, batchId, ref) => git(['-C', repoPath(root, batchId), 'show-ref', '--verify', '--quiet', ref]).ok;

test('T0 P1-01 缺省默认开：无配置时 worktree 四工具注册（19 工具）；显式 enabled=false 不注册', () => {
  // 缺省（config 无 capabilities 键）：worktree 默认开 → 四工具注册，工具总数 19（14 + lane_heartbeat + worktree 四件）
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-wt-off-'));
  const store = createStore(root);
  const { tools } = createTools({ tools: { register: () => {} }, logger: console }, { store, root });
  assert.equal(tools.length, 19);
  const names = tools.map((t) => t.name);
  for (const n of ['lane_worktree_create', 'lane_worktree_merge', 'lane_checkpoint', 'lane_checkpoint_status']) {
    assert.ok(names.includes(n), '缺省默认开：' + n + ' 应注册');
  }
  // 显式关（P1-01 验收显式关态）：capabilities.worktree.enabled=false → 四工具不注册（14 + lane_heartbeat = 15）
  const { tools: t2 } = createTools({ tools: { register: () => {} }, logger: console }, { store, root, config: { capabilities: { worktree: { enabled: false } } } });
  assert.equal(t2.length, 15);
  assert.equal(t2.some((t) => t.name === 'lane_worktree_create' || t.name === 'lane_worktree_merge' || t.name === 'lane_checkpoint' || t.name === 'lane_checkpoint_status'), false);
});

test('T1 创建：worktree 目录/分支存在、基线=orch HEAD、幂等复用', async () => {
  const { root, byName } = setup();
  await byName.wave_plan.execute({ batchId: 'b-wt1', tasks: [{ id: 'l1' }, { id: 'l2' }] }, EXEC_SESS);
  const r = await byName.lane_worktree_create.execute({ batchId: 'b-wt1', laneId: 'l1' }, EXEC_SESS);
  assert.equal(r.ok, true);
  const lane = lanePath(root, 'b-wt1', 'l1');
  const orch = orchPath(root, 'b-wt1');
  assert.equal(fs.existsSync(path.join(lane, '.git')), true, 'lane worktree 目录存在');
  assert.equal(fs.existsSync(path.join(orch, '.git')), true, 'orch worktree 目录存在');
  assert.equal(refExists(root, 'b-wt1', 'refs/heads/punky/l1'), true, 'punky/l1 分支存在');
  assert.equal(refExists(root, 'b-wt1', 'refs/heads/punky/orch'), true, 'punky/orch 分支存在');
  // 基线 = orch HEAD（git rev-parse 一致）
  const laneHead = git(['-C', lane, 'rev-parse', 'HEAD']);
  const orchHead = git(['-C', orch, 'rev-parse', 'HEAD']);
  assert.equal(laneHead.ok, true);
  assert.equal(laneHead.stdout, orchHead.stdout);
  assert.equal(r.base, orchHead.stdout);
  // 幂等：重复创建复用同一 worktree
  const r2 = await byName.lane_worktree_create.execute({ batchId: 'b-wt1', laneId: 'l1' }, EXEC_SESS);
  assert.equal(r2.ok, true);
  assert.equal(r2.reused, true);
  assert.equal(r2.worktree, r.worktree);
});

test('T2 checkpoint：无变更 no-op；写文件后提交出现且 git log 可查', async () => {
  const { root, byName } = setup();
  await byName.wave_plan.execute({ batchId: 'b-wt2', tasks: [{ id: 'l1' }] }, EXEC_SESS);
  await byName.lane_worktree_create.execute({ batchId: 'b-wt2', laneId: 'l1' }, EXEC_SESS);
  const lane = lanePath(root, 'b-wt2', 'l1');
  // 无变更 → no-op（不产生空提交）
  const nop = await byName.lane_checkpoint.execute({ batchId: 'b-wt2', laneId: 'l1', message: 'nothing' }, EXEC_SESS);
  assert.equal(nop.ok, true);
  assert.equal(nop.committed, false);
  // 写文件 → checkpoint 提交
  fs.writeFileSync(path.join(lane, 'a.txt'), 'hello checkpoint');
  const c = await byName.lane_checkpoint.execute({ batchId: 'b-wt2', laneId: 'l1', message: 'step 1' }, EXEC_SESS);
  assert.equal(c.ok, true);
  assert.equal(c.committed, true);
  assert.ok(c.commit, 'commit hash 返回');
  const log = git(['-C', lane, 'log', '--oneline', '-5']);
  assert.ok(log.stdout.includes('b-wt2/l1: step 1'), 'checkpoint 提交消息含 batchId/laneId，git log: ' + log.stdout);
  // 内容保全：提交内容可抢救（git show 可读）
  const show = git(['-C', lane, 'show', c.commit + ':a.txt']);
  assert.equal(show.stdout, 'hello checkpoint');
});

test('T3 合并成功：产物入 orch + worktree/分支清理', async () => {
  const { root, byName } = setup();
  await byName.wave_plan.execute({ batchId: 'b-wt3', tasks: [{ id: 'l1' }] }, EXEC_SESS);
  await byName.lane_worktree_create.execute({ batchId: 'b-wt3', laneId: 'l1' }, EXEC_SESS);
  const lane = lanePath(root, 'b-wt3', 'l1');
  fs.writeFileSync(path.join(lane, 'impl.js'), 'export const x = 1;');
  await byName.lane_checkpoint.execute({ batchId: 'b-wt3', laneId: 'l1', message: 'impl' }, EXEC_SESS);
  const m = await byName.lane_worktree_merge.execute({ batchId: 'b-wt3', laneId: 'l1' }, EXEC_SESS);
  assert.equal(m.ok, true);
  assert.equal(m.worktreeCleaned, true);
  // 产物出现在 orch
  assert.equal(fs.existsSync(path.join(orchPath(root, 'b-wt3'), 'impl.js')), true, 'lane 产物并入 orch');
  assert.equal(fs.readFileSync(path.join(orchPath(root, 'b-wt3'), 'impl.js'), 'utf8'), 'export const x = 1;');
  // worktree 清理 + 分支删除
  assert.equal(fs.existsSync(path.join(lane, '.git')), false, 'lane worktree 已清理');
  assert.equal(refExists(root, 'b-wt3', 'refs/heads/punky/l1'), false, 'lane 分支已删除');
  assert.equal(m.branchDeleted, true);
});

test('T3 冲突：保留现场 + 返回冲突文件清单（不自动解决）', async () => {
  const { root, byName } = setup();
  await byName.wave_plan.execute({ batchId: 'b-wt3c', tasks: [{ id: 'la' }, { id: 'lb' }] }, EXEC_SESS);
  await byName.lane_worktree_create.execute({ batchId: 'b-wt3c', laneId: 'la' }, EXEC_SESS);
  await byName.lane_worktree_create.execute({ batchId: 'b-wt3c', laneId: 'lb' }, EXEC_SESS);
  // 两 lane 各自修改同一文件（并行写同一仓库 → 物理冲突）
  fs.writeFileSync(path.join(lanePath(root, 'b-wt3c', 'la'), 'shared.txt'), 'from A');
  await byName.lane_checkpoint.execute({ batchId: 'b-wt3c', laneId: 'la', message: 'a' }, EXEC_SESS);
  fs.writeFileSync(path.join(lanePath(root, 'b-wt3c', 'lb'), 'shared.txt'), 'from B');
  await byName.lane_checkpoint.execute({ batchId: 'b-wt3c', laneId: 'lb', message: 'b' }, EXEC_SESS);
  const ma = await byName.lane_worktree_merge.execute({ batchId: 'b-wt3c', laneId: 'la' }, EXEC_SESS);
  assert.equal(ma.ok, true);
  const mb = await byName.lane_worktree_merge.execute({ batchId: 'b-wt3c', laneId: 'lb' }, EXEC_SESS);
  assert.equal(mb.ok, false);
  assert.equal(mb.conflict, true);
  assert.ok((mb.files ?? []).includes('shared.txt'), '冲突文件清单含 shared.txt: ' + JSON.stringify(mb.files));
  // 现场保留：worktree / 分支 / 在途 merge 状态
  assert.equal(fs.existsSync(path.join(lanePath(root, 'b-wt3c', 'lb'), '.git')), true, 'lane worktree 保留');
  assert.equal(refExists(root, 'b-wt3c', 'refs/heads/punky/lb'), true, 'lane 分支保留');
  const st = git(['-C', orchPath(root, 'b-wt3c'), 'status', '--porcelain']);
  assert.ok(st.stdout.split('\n').some((l) => /\b(UU|AA|AU|UA)\b/.test(l)), 'orch 在途 merge 状态保留: ' + st.stdout);
});

test('T4 串行化：merge 队列锁等待 + 与 lane_claim 并存', async () => {
  const { root, byName } = setup();
  await byName.wave_plan.execute({ batchId: 'b-wt4', tasks: [{ id: 'l1' }] }, EXEC_SESS);
  await byName.lane_worktree_create.execute({ batchId: 'b-wt4', laneId: 'l1' }, EXEC_SESS);
  // 与 lane_claim 并存：worktree 场景下 lane_claim 仍锁批次状态写
  const claim = await byName.lane_claim.execute({ batchId: 'b-wt4', lane: 'l1' }, EXEC_SESS);
  assert.equal(claim.ok, true);
  assert.equal((await byName.lane_claim.execute({ batchId: 'b-wt4', lane: 'l1' }, EXEC_SESS)).ok, false, 'lane_claim 冲突仍生效');
  assert.equal((await byName.lane_release.execute({ batchId: 'b-wt4', lane: 'l1', token: claim.token }, EXEC_SESS)).ok, true);
  // 串行化：先持有 merge 队列锁 → merge 等待 → 释放后串行完成（无 git 锁错误）
  const lockPath = path.join(wtRoot(root, 'b-wt4'), '.merge.lock');
  const held = await lock.acquire(lockPath, { waitMs: 0 });
  assert.equal(held.ok, true);
  fs.writeFileSync(path.join(lanePath(root, 'b-wt4', 'l1'), 'f.txt'), 'x');
  await byName.lane_checkpoint.execute({ batchId: 'b-wt4', laneId: 'l1', message: 'x' }, EXEC_SESS);
  const pending = byName.lane_worktree_merge.execute({ batchId: 'b-wt4', laneId: 'l1' }, EXEC_SESS);
  setTimeout(() => lock.release(lockPath, held.token), 150);
  const m = await pending;
  assert.equal(m.ok, true, 'merge 等待队列锁后串行完成: ' + JSON.stringify(m));
  assert.equal(fs.existsSync(path.join(orchPath(root, 'b-wt4'), 'f.txt')), true);
});

test('T5 git 依赖：git 不可用 → 工具返回清晰错误不挂起', async () => {
  const { root, byName } = setup();
  await byName.wave_plan.execute({ batchId: 'b-wt5', tasks: [{ id: 'l1' }] }, EXEC_SESS);
  const prev = process.env.DSH_GIT_BIN;
  process.env.DSH_GIT_BIN = 'git-definitely-not-installed-xyz';
  try {
    const r = await byName.lane_worktree_create.execute({ batchId: 'b-wt5', laneId: 'l1' }, EXEC_SESS);
    assert.equal(r.ok, false);
    assert.ok(r.error && r.error.includes('git'), '清晰错误含 git 提示: ' + (r.error ?? ''));
    const c = await byName.lane_checkpoint.execute({ batchId: 'b-wt5', laneId: 'l1', message: 'x' }, EXEC_SESS);
    assert.equal(c.ok, false);
    assert.ok(c.error && c.error.includes('git'));
  } finally {
    if (prev === undefined) delete process.env.DSH_GIT_BIN; else process.env.DSH_GIT_BIN = prev;
  }
});

test('T6 B2 progress checkpoint：事件含 step/total + commit message 内嵌 "step N/total"；向后兼容', async () => {
  const { root, store, byName } = setup();
  await byName.wave_plan.execute({ batchId: 'b-wt6', tasks: [{ id: 'l1' }] }, EXEC_SESS);
  await byName.lane_worktree_create.execute({ batchId: 'b-wt6', laneId: 'l1' }, EXEC_SESS);
  const lane = lanePath(root, 'b-wt6', 'l1');
  // 带 progress：事件含 step/total + commit message 内嵌 "step 1/3"（git log 可查）
  fs.writeFileSync(path.join(lane, 'a.txt'), 'step one');
  const c = await byName.lane_checkpoint.execute({ batchId: 'b-wt6', laneId: 'l1', message: 'done a', progress: { step: 1, total: 3 } }, EXEC_SESS);
  assert.equal(c.ok, true);
  assert.equal(c.committed, true);
  assert.ok(c.commit, 'commit hash 返回');
  const log = git(['-C', lane, 'log', '--oneline', '-5']);
  assert.ok(log.stdout.includes('step 1/3'), 'commit message 内嵌 step 1/3，git log: ' + log.stdout);
  let batch = store.readBatch('sess-wt', 'b-wt6');
  let ev = batch.events.find((e) => e.type === 'worktree.checkpoint' && e.lane === 'l1');
  assert.equal(ev.step, 1, '事件 step');
  assert.equal(ev.total, 3, '事件 total');
  // 向后兼容：不传 progress → 事件无 step/total、commit message 保持现状格式
  fs.writeFileSync(path.join(lane, 'b.txt'), 'plain');
  const c2 = await byName.lane_checkpoint.execute({ batchId: 'b-wt6', laneId: 'l1', message: 'plain' }, EXEC_SESS);
  assert.equal(c2.committed, true);
  batch = store.readBatch('sess-wt', 'b-wt6');
  const evs = batch.events.filter((e) => e.type === 'worktree.checkpoint' && e.lane === 'l1');
  assert.equal(evs.length, 2);
  const ev2 = evs[1];
  assert.equal(ev2.step, undefined, '无 progress → 事件无 step');
  assert.equal(ev2.total, undefined, '无 progress → 事件无 total');
  assert.equal(ev2.message.includes('step'), false, '无 progress → commit message 无 step 段: ' + ev2.message);
  // 非法 progress fail-closed（双层：参数 schema 拒非整数 / 执行层校验拒越界）
  await assert.rejects(() => byName.lane_checkpoint.execute({ batchId: 'b-wt6', laneId: 'l1', message: 'x', progress: { step: 0, total: 3 } }, EXEC_SESS), /invalid progress/);
  await assert.rejects(() => byName.lane_checkpoint.execute({ batchId: 'b-wt6', laneId: 'l1', message: 'x', progress: { step: 4, total: 3 } }, EXEC_SESS), /invalid progress/);
  await assert.rejects(() => byName.lane_checkpoint.execute({ batchId: 'b-wt6', laneId: 'l1', message: 'x', progress: { step: 1.5, total: 3 } }, EXEC_SESS), /must be an integer/);
});

test('T7 B2 lane_checkpoint_status：只读查询 checkpoint 历史 + latest；不依赖 git', async () => {
  const { root, store, byName } = setup();
  await byName.wave_plan.execute({ batchId: 'b-wt7', tasks: [{ id: 'l1' }] }, EXEC_SESS);
  // 未建 worktree 也可查（事件流驱动，零 git 依赖）：空历史 + latest=null + worktree 字段缺席
  let st = await byName.lane_checkpoint_status.execute({ batchId: 'b-wt7', laneId: 'l1' }, EXEC_SESS);
  assert.equal(st.ok, true);
  assert.deepEqual(st.checkpoints, []);
  assert.equal(st.latest, null);
  assert.equal(st.branch, 'punky/l1');
  assert.equal(st.worktree, undefined, 'worktree 未建 → 字段缺席');
  // 建 worktree + 两次 checkpoint（一次带 progress、一次不带）→ 历史与 latest 正确
  await byName.lane_worktree_create.execute({ batchId: 'b-wt7', laneId: 'l1' }, EXEC_SESS);
  const lane = lanePath(root, 'b-wt7', 'l1');
  fs.writeFileSync(path.join(lane, 'a.txt'), 'v1');
  await byName.lane_checkpoint.execute({ batchId: 'b-wt7', laneId: 'l1', message: 'plain first' }, EXEC_SESS);
  fs.writeFileSync(path.join(lane, 'b.txt'), 'v2');
  await byName.lane_checkpoint.execute({ batchId: 'b-wt7', laneId: 'l1', message: 'progressed', progress: { step: 2, total: 5 } }, EXEC_SESS);
  st = await byName.lane_checkpoint_status.execute({ batchId: 'b-wt7', laneId: 'l1' }, EXEC_SESS);
  assert.equal(st.ok, true);
  assert.equal(st.checkpoints.length, 2);
  assert.equal(st.checkpoints[0].message, 'b-wt7/l1: plain first');
  assert.equal(st.checkpoints[0].step, undefined, '无 progress 的 checkpoint 无 step');
  assert.equal(st.checkpoints[1].message, 'b-wt7/l1: step 2/5 — progressed');
  assert.equal(st.checkpoints[1].step, 2);
  assert.equal(st.checkpoints[1].total, 5);
  assert.ok(st.checkpoints[0].commit && st.checkpoints[0].ts, 'commit/ts 在事件内');
  assert.deepEqual(st.latest, { step: 2, total: 5 }, 'latest = 最近一次携带 progress 的 checkpoint');
  assert.ok(st.worktree && st.worktree.replace(/\\/g, '/').includes('b-wt7/l1'), 'worktree 已建 → 目录存在性探测返回: ' + st.worktree);
  // git 不可用仍可查（只读，零 git 调用）
  const prev = process.env.DSH_GIT_BIN;
  process.env.DSH_GIT_BIN = 'git-definitely-not-installed-xyz';
  try {
    const s2 = await byName.lane_checkpoint_status.execute({ batchId: 'b-wt7', laneId: 'l1' }, EXEC_SESS);
    assert.equal(s2.ok, true);
    assert.equal(s2.checkpoints.length, 2);
    assert.deepEqual(s2.latest, { step: 2, total: 5 });
  } finally {
    if (prev === undefined) delete process.env.DSH_GIT_BIN; else process.env.DSH_GIT_BIN = prev;
  }
  // 未知 lane / 未知批次 → 清晰错误
  await assert.rejects(() => byName.lane_checkpoint_status.execute({ batchId: 'b-wt7', laneId: 'nope' }, EXEC_SESS), /unknown lane/);
  await assert.rejects(() => byName.lane_checkpoint_status.execute({ batchId: 'b-wt7-nope', laneId: 'l1' }, EXEC_SESS), /batch not found/);
});
