/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/worktree-merge-fail-escapes.test.js —— **B5 / I-28 验收**：worktree 操作失败的**冒泡三要素** ＋ 正常路径零变化。
//
// 文件名按**计划 T-cmd 原文**：`node --test test/worktree-merge-fail-escapes.test.js`。
//
// 判据源：`plan/p1-pack.md` AC-6/AC-7/AC-8。
// 纪律：**必败构造**用真 git（分支已被检出 ⇒ `worktree add` exit 128），构造与清理都在本例内闭环；
//   ⚠ 不改 `lib/tools/lane-tools.js`（它当前 457 行、`merge-agent` T2.6 行数护栏余量 0）。
//
// 每条判据的**可红形态**（实现若写错 ⇒ 本文件哪条红）：
//   B1 若冒泡改回「裸 throw e」/静默吞错 ⇒ message 缺 op/path、`err.worktreeOp` 缺失 ⇒ 红；
//   B2 若吞掉 gitExit（不取 `e.code`）⇒ `worktreeOp.gitExit === 128` 红；
//   B3 若把成功路径也抛错 ⇒ 「正常 laneId 返回 ok:true + 目录存在」红；
//   B4 若把「残留证据」挪到清理之后（`:175` 不再早于 `:176`）⇒ 行序断言红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { createTools } from '../lib/tools/register.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const git = (args, cwd = PKG) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tryGit = (args, cwd = PKG) => { try { return { ok: true, out: git(args, cwd) }; } catch { return { ok: false }; } };

/** 临时床：真 store + 真 createTools。批次含两条 lane（`e1`/`a1`）——工具要求 lane 存在于批中。 */
function bedOf(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-b5-' + tag + '-'));
  const store = createStore(root);
  store.createBatch('sess-b5', {
    batchId: 'b-b5',
    wavePlan: buildWavePlan({ batchId: 'b-b5', tasks: [{ id: 'e1', layer: 'exec' }, { id: 'a1', layer: 'audit', deps: ['e1'] }] }),
    phase: 'running',
  });
  const ctx = { tools: { register() {}, guard() {} }, logger: { info() {}, warn() {}, error() {}, debug() {} } };
  const { tools } = createTools(ctx, { store, root, config: {} });
  return { root, store, byName: Object.fromEntries(tools.map((t) => [t.name, t])) };
}
const EXEC = { agent: { session: { id: 'sess-b5' } } };

// ── 必败现场：**在工具自己用的 git repo 里**把 lane `a1` 的分支 `punky/a1` 检出到额外 worktree
//   `ensureOrch` 用 `mainRepoDir(root, sessionId, batchId)` = `<batchWtRoot>/_repo`（见 lib/tools/lane-tools.js:75）
//   ⇒ 冲突必须造在那里面；探测候选覆盖「_repo 明确路径」与「找得到 toplevel 的祖先」
const COLLIDE_LANE = 'a1';
function findToolRepo(bedRoot, sessionId = 'sess-b5', batchId = 'b-b5') {
  const candidates = [
    path.join(bedRoot, 'sessions', sessionId, 'worktrees', batchId, '_repo'),
    path.join(bedRoot, 'sessions', sessionId, 'worktrees', batchId),
    path.join(bedRoot, 'sessions', sessionId),
    path.join(bedRoot, 'sessions'),
    bedRoot,
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && tryGit(['rev-parse', '--show-toplevel'], c).ok) return c;
  }
  throw new Error('探测不到工具的 git repo（候选：' + JSON.stringify(candidates) + '）');
}
function prepareCollision(repoRoot) {
  if (!tryGit(['rev-parse', '--verify', 'punky/orch'], repoRoot).ok) git(['branch', 'punky/orch', 'HEAD'], repoRoot);
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-b5-collide-'));
  tryGit(['worktree', 'remove', '--force', otherDir], repoRoot);
  tryGit(['worktree', 'prune'], repoRoot);
  tryGit(['branch', '-D', 'punky/' + COLLIDE_LANE], repoRoot);
  git(['branch', 'punky/' + COLLIDE_LANE, 'punky/orch'], repoRoot);
  git(['worktree', 'add', otherDir, 'punky/' + COLLIDE_LANE], repoRoot); // ← 占用该分支（再 add 必失败）
  return { otherDir };
}
function cleanupCollision(repoRoot, collision) {
  if (!collision) return;
  tryGit(['worktree', 'remove', '--force', collision.otherDir], repoRoot);
  tryGit(['worktree', 'prune'], repoRoot);
  tryGit(['branch', '-D', 'punky/' + COLLIDE_LANE], repoRoot);
  fs.rmSync(collision.otherDir, { recursive: true, force: true });
}

/** 三要素断言（供 B1 与 B4 的变异对照共用）。 */
function assertBubble(e) {
  const msg = String(e?.message ?? '');
  const op = e?.worktreeOp?.op;
  assert.equal(typeof op, 'string', 'err.worktreeOp.op 必须在场；实际=' + JSON.stringify(e?.worktreeOp));
  assert.equal(['list', 'remove', 'add-branch', 'add-existing-branch', 'show-ref'].includes(op), true,
    'op 必须取自五值枚举（禁 other/unknown 兜底）；实际=' + op);
  assert.ok(msg.includes(op), 'message 必须含 op 名（' + op + '）；实际=' + msg.slice(0, 220));
  const p = e?.worktreeOp?.path;
  assert.equal(typeof p, 'string', 'worktreeOp.path 必须在场');
  assert.ok(msg.includes(p) || msg.includes(path.basename(p)), 'message 必须含目标 path；实际=' + msg.slice(0, 220));
  assert.equal(typeof e?.worktreeOp?.originalMessage, 'string', 'worktreeOp.originalMessage 必须在场（原 git 失败文本）');
  assert.equal(e?.worktreeOp?.gitExit, 128, 'worktreeOp.gitExit 必须保留 git 退出码 128（不吞）；实际=' + e?.worktreeOp?.gitExit);
  assert.ok(/exit 128|Command failed|fatal/i.test(msg), 'message 应含原失败信息或 exit 码；实际=' + msg.slice(0, 240));
}

test('B1 必败 ⇒ 冒泡三要素齐：message 含 op + path + 原 message；err.worktreeOp 四字段齐（gitExit=128）', async () => {
  const bed = bedOf('b1');
  // 先建 e1 ⇒ 工具会在 `bed.root` 内初始化 git repo（orch 常驻分支就绪）
  await bed.byName.lane_worktree_create.execute({ batchId: 'b-b5', laneId: 'e1', session: 'sess-b5' }, EXEC);
  const repo = findToolRepo(bed.root); // ← 探测工具实际使用的 repo（`mainRepoDir` 的下落）
  const collision = prepareCollision(repo);
  try {
    await assert.rejects(
      () => bed.byName.lane_worktree_create.execute({ batchId: 'b-b5', laneId: COLLIDE_LANE, session: 'sess-b5' }, EXEC),
      (e) => { assertBubble(e); return true; },
      '分支已被检出 ⇒ worktree add 必失败 ⇒ 必须以三要素冒泡',
    );
  } finally { cleanupCollision(repo, collision); }
});

test('B2 正常路径零变化：ok:true、reason ∈ 三值、worktree 目录真实存在', async () => {
  const bed = bedOf('b2');
  const r = await bed.byName.lane_worktree_create.execute({ batchId: 'b-b5', laneId: 'e1', session: 'sess-b5' }, EXEC);
  assert.equal(r.ok, true, '正常 laneId ⇒ ok:true（不得一律抛错）');
  assert.equal(['created', 'reused', 'recreated-after-residual'].includes(r.reason), true, 'reason ∈ 三值域；实际=' + r.reason);
  assert.equal(fs.existsSync(r.worktree), true, 'worktree 目录必须真实存在：' + r.worktree);
});

test('B3 残留证据顺序：residualDir 赋值行号 **严格早于** removeWorktreeDir 调用（读源码比对）', () => {
  const src = fs.readFileSync(path.join(PKG, 'lib', 'tools', 'lane-tools.js'), 'utf8').split(/\r?\n/);
  const residualLine = src.findIndex((l) => /residualDir\s*=\s*fs\.existsSync/.test(l)) + 1;
  const removeLine = src.findIndex((l) => /^\s*removeWorktreeDir\(repo, dir\);/.test(l)) + 1;
  assert.ok(residualLine > 0, '必须找到 `residualDir = fs.existsSync` 行');
  assert.ok(removeLine > 0, '必须找到 `removeWorktreeDir(repo, dir);` 行');
  assert.equal(residualLine < removeLine, true,
    '残留证据必须**先取**再清理（residualDir:' + residualLine + ' < removeWorktreeDir:' + removeLine + '）');
});

test('B4 可红形态：把冒泡改回「裸 throw」（静默丢 op/path/gitExit）⇒ B1 的三要素断言必红', () => {
  let red = false;
  try {
    try { throw new Error('Command failed: git worktree add'); } catch (e) { assertBubble(e); }
  } catch { red = true; }
  assert.equal(red, true, '裸 throw 下三要素断言必须变红（证明 B1 有杀伤力）');
});
