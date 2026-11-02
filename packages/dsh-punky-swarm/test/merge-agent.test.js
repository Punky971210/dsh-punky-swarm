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

// merge agent 单测：
// T2.1 默认关零破坏：mergeAgent 未配置/disabled → merge 冲突路径与现状逐字一致（现场保留 + files 清单 + conflict 事件）
// T2.2 注入化解成功：spawner 返回 CONFLICT_RESOLVED/SUCCESS + orch 无冲突标记 → merge 成功（ok/worktreeCleaned/branchDeleted）
//      + worktree.merge.resolved 事件留痕（含 conflictFiles 与 agent 摘要）；注入点二选一（deps.mergeAgentSpawner / config.host.spawnMergeAgent）
// T2.3 注入化解失败：UNRESOLVED / 抛错 / 超时 / 声称化解但 orch 仍有在途 merge → 保持 conflict 现状 + conflict 事件；
//      不新增 lane 态、不自动 settle
// T2.4 无注入降级：enabled=true 但 deps 无 spawner → 清晰提示 + 保持 conflict 现状（不挂起不 throw）
// T2.5 create schema 修正：lane_worktree_create output.schema 含 error 字段；git 不可用路径返回 {ok:false,error} 与 schema 一致
// T2.6 回归护栏：lane-tools.js 逻辑行数 ≤462（**绝对上限**，见用例内注释履历）；既有 worktree-tools.test.js 全绿由全量 node --test 承担
// 环境：git 可用（worktree 硬依赖，同 worktree-tools.test.js）
import test from 'node:test';
import assert from 'node:assert/strict';
// 【punky-align-residual-20261102 · lane `t26-baseline`】T2.6 计数**单点**：护栏与它的两个可达构造共用同一函数，
//   否则构造证明的是「另一个函数的边界」而不是「护栏的边界」。
import { logicLinesOf, build } from './helpers/lane-logic-lines.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { assessC } from './helpers/gate-fixture.mjs';
import { withDefaultTeam } from './helpers/skill-paths.mjs';

// 【P1 同步】`team` 现为必填且必须解析到资产 ⇒ 本套件（建批是手段、被检面是 merge 治理）统一补 software-team。

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

// mergeAgent 装配 + spawner 注入点二选一：mergeAgentSpawner（deps）/ hostSpawner（config.host.spawnMergeAgent）
function setup({ mergeAgent = null, spawner = null, hostSpawner = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-ma-'));
  const store = createStore(root);
  const registered = [];
  const ctx = { tools: { register: (t) => registered.push(t) }, logger: console };
  const wt = { enabled: true };
  if (mergeAgent) wt.mergeAgent = mergeAgent;
  const config = { capabilities: { worktree: wt } };
  if (hostSpawner) config.host = { spawnMergeAgent: hostSpawner };
  const { tools } = createTools(ctx, { store, root, config, mergeAgentSpawner: spawner ?? undefined });
  // G1 前置（新门禁）：建批属 C 档动作 ⇒ 本套件建批前先把会话评估为 C（同 assign_check 落盘函数）
  assessC(store, 'sess-wt', { rationale: 'fixture：merge-agent 套件建批前置评估（双 lane 冲突治理 ⇒ C 档）' });
  return { root, store, byName: withDefaultTeam(Object.fromEntries(tools.map((t) => [t.name, t]))), registered };
}

function wtRoot(root, batchId) { return path.join(root, 'sessions', 'sess-wt', 'worktrees', batchId); }
function lanePath(root, batchId, laneId) { return path.join(wtRoot(root, batchId), laneId); }
function orchPath(root, batchId) { return path.join(wtRoot(root, batchId), 'orch'); }
const repoPath = (root, batchId) => path.join(wtRoot(root, batchId), '_repo');
const refExists = (root, batchId, ref) => git(['-C', repoPath(root, batchId), 'show-ref', '--verify', '--quiet', ref]).ok;

// 双 lane 并行写同一文件制造物理冲突（镜像 worktree-tools.test.js T3 冲突场景），la 已合入、lb 处于冲突
async function makeConflict(ctx, batchId) {
  const { root, byName } = ctx;
  await byName.wave_plan.execute({ batchId, tasks: [{ id: 'la' }, { id: 'lb' }] }, EXEC_SESS);
  await byName.lane_worktree_create.execute({ batchId, laneId: 'la' }, EXEC_SESS);
  await byName.lane_worktree_create.execute({ batchId, laneId: 'lb' }, EXEC_SESS);
  fs.writeFileSync(path.join(lanePath(root, batchId, 'la'), 'shared.txt'), 'from A');
  await byName.lane_checkpoint.execute({ batchId, laneId: 'la', message: 'a' }, EXEC_SESS);
  fs.writeFileSync(path.join(lanePath(root, batchId, 'lb'), 'shared.txt'), 'from B');
  await byName.lane_checkpoint.execute({ batchId, laneId: 'lb', message: 'b' }, EXEC_SESS);
  const ma = await byName.lane_worktree_merge.execute({ batchId, laneId: 'la' }, EXEC_SESS);
  assert.equal(ma.ok, true, 'la 首合必须成功: ' + JSON.stringify(ma));
}

// 真实化解型 spawner：按 HARD 规则在 orch 编辑冲突文件 → git add → git commit --no-edit 完成在途 merge
const resolvingSpawner = (verdict = 'CONFLICT_RESOLVED') => async (request) => {
  for (const f of request.conflictFiles) fs.writeFileSync(path.join(request.orchDir, f), 'resolved by merge agent');
  assert.equal(git(['-C', request.orchDir, 'add', ...request.conflictFiles]).ok, true, 'agent git add');
  assert.equal(git(['-C', request.orchDir, 'commit', '--no-edit']).ok, true, 'agent git commit');
  return { verdict, detail: 'merged both sides' };
};
const unresolvedSpawner = async () => ({ verdict: 'CONFLICT_UNRESOLVED', detail: 'cannot resolve' });
const throwingSpawner = async () => { throw new Error('spawner boom'); };
const hangingSpawner = () => new Promise(() => {}); // 永不返回 → 触发超时
const lyingSpawner = async () => ({ verdict: 'CONFLICT_RESOLVED', detail: 'claims resolved but does nothing' }); // 校验 fail-closed

function assertConflictStatusQuo(mb, root, store, batchId, laneId) {
  assert.equal(mb.ok, false);
  assert.equal(mb.conflict, true);
  assert.ok((mb.files ?? []).includes('shared.txt'), 'files 清单含 shared.txt: ' + JSON.stringify(mb.files));
  // 现场保留：worktree / 分支 / 在途 merge
  assert.equal(fs.existsSync(path.join(lanePath(root, batchId, laneId), '.git')), true, 'lane worktree 保留');
  assert.equal(refExists(root, batchId, 'refs/heads/punky/' + laneId), true, 'lane 分支保留');
  const st = git(['-C', orchPath(root, batchId), 'status', '--porcelain']);
  assert.ok(st.stdout.split('\n').some((l) => /\b(UU|AA|AU|UA)\b/.test(l)), 'orch 在途 merge 保留: ' + st.stdout);
  // 事件：conflict 留痕、无 resolved
  const batch = store.readBatch('sess-wt', batchId);
  assert.equal(batch.events.some((e) => e.type === 'worktree.merge.conflict' && e.lane === laneId), true, 'conflict 事件');
  assert.equal(batch.events.some((e) => e.type === 'worktree.merge.resolved' && e.lane === laneId), false, '无 resolved 事件');
  // 不新增 lane 态、不自动 settle
  assert.equal(batch.events.some((e) => e.type === 'member.settled' && e.lane === laneId), false, '不自动 settle');
  assert.equal(batch.lanes[laneId], 'pending', 'lane 态不变（wave_plan 初始 pending）');
}

test('T2.1 默认关零破坏：mergeAgent 未配置 → 冲突路径与现状逐字一致', async () => {
  const ctx = setup(); // worktree enabled，无 mergeAgent 键
  const { byName, root, store } = ctx;
  await makeConflict(ctx, 'b-t21');
  const mb = await byName.lane_worktree_merge.execute({ batchId: 'b-t21', laneId: 'lb' }, EXEC_SESS);
  assert.equal(mb.ok, false);
  assert.equal(mb.conflict, true);
  assert.ok((mb.files ?? []).includes('shared.txt'));
  assert.equal(mb.note, undefined, '默认关 → 无附加 note，返回对象逐字保持 doMerge 冲突结果');
  assert.equal(mb.error, undefined);
  assertConflictStatusQuo(mb, root, store, 'b-t21', 'lb');
});

test('T2.1b 默认关零破坏：mergeAgent 显式 disabled → 现状路径', async () => {
  const ctx = setup({ mergeAgent: { enabled: false } });
  const { byName, root, store } = ctx;
  await makeConflict(ctx, 'b-t21b');
  const mb = await byName.lane_worktree_merge.execute({ batchId: 'b-t21b', laneId: 'lb' }, EXEC_SESS);
  assert.equal(mb.ok, false);
  assert.equal(mb.note, undefined);
  assertConflictStatusQuo(mb, root, store, 'b-t21b', 'lb');
});

test('T2.2 注入化解成功：CONFLICT_RESOLVED（deps.mergeAgentSpawner）→ merge 成功 + resolved 事件', async () => {
  const ctx = setup({ mergeAgent: { enabled: true, timeoutMs: 5000 }, spawner: resolvingSpawner() });
  const { byName, root, store } = ctx;
  await makeConflict(ctx, 'b-t22');
  const mb = await byName.lane_worktree_merge.execute({ batchId: 'b-t22', laneId: 'lb' }, EXEC_SESS);
  assert.equal(mb.ok, true);
  assert.equal(mb.worktreeCleaned, true);
  assert.equal(mb.branchDeleted, true);
  // 现场清理：worktree 移除 + 分支删除 + 化解产物入 orch
  assert.equal(fs.existsSync(path.join(lanePath(root, 'b-t22', 'lb'), '.git')), false, 'lane worktree 已清理');
  assert.equal(refExists(root, 'b-t22', 'refs/heads/punky/lb'), false, 'lane 分支已删除');
  assert.equal(fs.readFileSync(path.join(orchPath(root, 'b-t22'), 'shared.txt'), 'utf8'), 'resolved by merge agent', '化解产物入 orch');
  // resolved 事件留痕（含 conflictFiles + agent 摘要）；无 conflict 事件
  const batch = store.readBatch('sess-wt', 'b-t22');
  const ev = batch.events.find((e) => e.type === 'worktree.merge.resolved' && e.lane === 'lb');
  assert.ok(ev, 'worktree.merge.resolved 事件存在');
  assert.ok(ev.files.includes('shared.txt'), '事件含 conflictFiles');
  assert.equal(ev.agent, 'merged both sides', '事件含 agent 摘要');
  assert.equal(ev.verdict, 'CONFLICT_RESOLVED');
  assert.equal(batch.events.some((e) => e.type === 'worktree.merge.conflict' && e.lane === 'lb'), false, '成功路径无 conflict 事件');
});

test('T2.2b 注入化解成功：SUCCESS 判定 + config.host.spawnMergeAgent 注入点 → merge 成功', async () => {
  const ctx = setup({ mergeAgent: { enabled: true }, hostSpawner: resolvingSpawner('SUCCESS') });
  const { byName, root, store } = ctx;
  await makeConflict(ctx, 'b-t22b');
  const mb = await byName.lane_worktree_merge.execute({ batchId: 'b-t22b', laneId: 'lb' }, EXEC_SESS);
  assert.equal(mb.ok, true);
  assert.equal(mb.worktreeCleaned, true);
  assert.equal(mb.branchDeleted, true);
  const batch = store.readBatch('sess-wt', 'b-t22b');
  const ev = batch.events.find((e) => e.type === 'worktree.merge.resolved' && e.lane === 'lb');
  assert.ok(ev, 'resolved 事件');
  assert.equal(ev.verdict, 'SUCCESS');
});

test('T2.3 注入化解失败：UNRESOLVED → 保持 conflict 现状 + conflict 事件；不新增 lane 态、不自动 settle', async () => {
  const ctx = setup({ mergeAgent: { enabled: true }, spawner: unresolvedSpawner });
  const { byName, root, store } = ctx;
  await makeConflict(ctx, 'b-t23');
  const mb = await byName.lane_worktree_merge.execute({ batchId: 'b-t23', laneId: 'lb' }, EXEC_SESS);
  assert.equal(mb.note, undefined, 'UNRESOLVED → 返回对象逐字现状');
  assertConflictStatusQuo(mb, root, store, 'b-t23', 'lb');
});

test('T2.3b 注入化解失败：spawner 抛错 → 保持 conflict 现状', async () => {
  const ctx = setup({ mergeAgent: { enabled: true }, spawner: throwingSpawner });
  const { byName, root, store } = ctx;
  await makeConflict(ctx, 'b-t23b');
  const mb = await byName.lane_worktree_merge.execute({ batchId: 'b-t23b', laneId: 'lb' }, EXEC_SESS);
  assertConflictStatusQuo(mb, root, store, 'b-t23b', 'lb');
});

test('T2.3c 注入化解失败：spawner 超时 → 保持 conflict 现状（不挂起）', async () => {
  const ctx = setup({ mergeAgent: { enabled: true, timeoutMs: 100 }, spawner: hangingSpawner });
  const { byName, root, store } = ctx;
  await makeConflict(ctx, 'b-t23c');
  const mb = await byName.lane_worktree_merge.execute({ batchId: 'b-t23c', laneId: 'lb' }, EXEC_SESS);
  assertConflictStatusQuo(mb, root, store, 'b-t23c', 'lb');
});

test('T2.3d 注入化解失败：声称 CONFLICT_RESOLVED 但 orch 仍有在途 merge → fail-closed 视同 UNRESOLVED', async () => {
  const ctx = setup({ mergeAgent: { enabled: true }, spawner: lyingSpawner });
  const { byName, root, store } = ctx;
  await makeConflict(ctx, 'b-t23d');
  const mb = await byName.lane_worktree_merge.execute({ batchId: 'b-t23d', laneId: 'lb' }, EXEC_SESS);
  assertConflictStatusQuo(mb, root, store, 'b-t23d', 'lb');
});

test('T2.4 无注入降级：enabled=true 但 deps 无 spawner → 清晰提示 + 保持 conflict 现状（不挂起不 throw）', async () => {
  const ctx = setup({ mergeAgent: { enabled: true } }); // 无 mergeAgentSpawner、无 config.host.spawnMergeAgent
  const { byName, root, store } = ctx;
  await makeConflict(ctx, 'b-t24');
  const mb = await byName.lane_worktree_merge.execute({ batchId: 'b-t24', laneId: 'lb' }, EXEC_SESS);
  assert.equal(mb.ok, false);
  assert.equal(mb.conflict, true);
  assert.ok((mb.files ?? []).includes('shared.txt'));
  assert.ok(mb.note && mb.note.includes('no spawner injected'), '清晰提示: ' + mb.note);
  assertConflictStatusQuo(mb, root, store, 'b-t24', 'lb');
});

test('T2.5 create schema 修正：output.schema 含 error 字段；git 不可用路径返回 {ok:false,error} 与 schema 一致', async () => {
  const ctx = setup();
  const { byName } = ctx;
  const schema = byName.lane_worktree_create.output.schema;
  assert.equal(schema.properties.error.type, 'string', 'lane_worktree_create output.schema 含 error: {type:string}');
  await byName.wave_plan.execute({ batchId: 'b-t25', tasks: [{ id: 'l1' }] }, EXEC_SESS);
  const prev = process.env.DSH_GIT_BIN;
  process.env.DSH_GIT_BIN = 'git-definitely-not-installed-xyz';
  try {
    const r = await byName.lane_worktree_create.execute({ batchId: 'b-t25', laneId: 'l1' }, EXEC_SESS);
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string', 'git 不可用返回 {ok:false,error}');
    assert.ok(r.error.includes('git'), '清晰错误含 git 提示');
  } finally {
    if (prev === undefined) delete process.env.DSH_GIT_BIN; else process.env.DSH_GIT_BIN = prev;
  }
});

test('T2.6 回归护栏：lane-tools.js 逻辑行数 ≤462（绝对上限，AGPL 头行豁免）', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../lib/tools/lane-tools.js', import.meta.url)), 'utf8');
  // ── 口径 ────────────────────────────────────────────────────────────────────
  // AGPL 头为发布合规强制（+17 行），护栏意图是防逻辑膨胀 ⇒ 剔除头部 /* */ 注释块后计逻辑行数。
  // 计数实现已抽到 test/helpers/lane-logic-lines.mjs（**单点**：护栏与下方两个可达构造共用它）。
  //
  // ── 为什么上限是「绝对 462」而不是「基线 + ≤10」 ─────────────────────────────
  // 【理由一 · 余量用尽史】**457 不是设计容量，是历史 lane 逐次用尽余量的累积**：
  //   447（初版基线）→（B 步数预算接线 +8）455 → 457（前批 `impl` 把 checkpoint 对齐调用
  //   **挤进既有语句行**过关后的实测值）。每一步都在"刚好不超"的边缘，从未真正留出设计余量。
  // 【理由二 · 前批 `impl` 挤行的可读性代价】该批为守 457，把 `recordCheckpointTotalMismatch(...)`
  //   并入既有 `const b = overBudgetOf(...)` 同一物理行 ⇒ 单行过长、可读性下降。
  //   若不抬阈值，下一条要动该文件的 lane 会被迫复现同样做法 ⇒ 拿可读性换假节俭。
  // 【理由三 · 只给 5 行】该文件已 457 行，**再涨应当拆文件而不是抬阈值**：
  //   因此本次只给 +5（457 → 462），且声明为**绝对上限**（不再用「基线 + ≤10」这种伪算术）。
  // 【理由四 · 订正一处旧口径矛盾】原注释写「基线 447 → 455；按『基线 + ≤10』同步为 ≤457」——
  //   455 + 10 = 465 ≠ 457 ⇒ **该"公式"从未成立**，457 实际等于 447 + 10。
  //   本批起统一为单一数字（绝对上限），不再让两套口径并存（并存正是 §「修一处不修另一处必然复发」）。
  //
  // ── 防漂移规则（此后每次抬升都必须照此留痕）─────────────────────────────────
  //   留痕格式：`批次/日期/理由/新上限/余量`；**单次抬升 > 5 行必须先给出拆文件方案**，
  //   不得以"再给几条"的方式继续累积 —— 累积正是 447→455→457 的老路。
  const LIMIT = 462;
  assert.ok(logicLinesOf(src) <= LIMIT,
    'lane-tools.js 逻辑行数=' + logicLinesOf(src) + '（绝对上限 ' + LIMIT + '，AGPL 头豁免）');

  // ── 两个**可达**构造（真跑断言，不是只算数）：证明边界是 462 / 463，而不是"随手指的数" ──
  assert.ok(logicLinesOf(build(462)) <= LIMIT, '构造：恰 462 行必须绿（边界内侧）');
  assert.throws(
    () => assert.ok(logicLinesOf(build(463)) <= LIMIT),
    /AssertionError/,
    '构造：463 行必须红（边界外侧）—— 若此处不抛，说明 LIMIT 或计数口径被改坏');
});
