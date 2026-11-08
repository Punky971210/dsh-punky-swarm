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

import fs from 'node:fs';
import path from 'node:path';
import * as lock from '../lock.js';
import { SAFE_ID } from '../state/constants.js';
import { runGit } from './git-utils.js';
const RESERVED_LANE = new Set(['_repo', 'orch']);
export const ORCH_BRANCH = 'punky/orch';
const MERGE_WAIT_MS = 60_000;

function batchWtRoot(root, sessionId, batchId) { return path.join(root, 'sessions', sessionId, 'worktrees', batchId); }
function mainRepoDir(root, sessionId, batchId) { return path.join(batchWtRoot(root, sessionId, batchId), '_repo'); }
export function orchDirOf(root, sessionId, batchId) { return path.join(batchWtRoot(root, sessionId, batchId), 'orch'); }
export function laneDirOf(root, sessionId, batchId, laneId) { return path.join(batchWtRoot(root, sessionId, batchId), laneId); }
function mergeLockFile(root, sessionId, batchId) { return path.join(batchWtRoot(root, sessionId, batchId), '.merge.lock'); }
export const laneBranch = (laneId) => 'punky/' + laneId;

export function normPath(p) {
  let abs = path.resolve(p);
  try { abs = fs.realpathSync.native(abs); } catch {  }
  return abs.replace(/\\/g, '/').replace(/\/+$/, '');
}

export function validateIds(sessionId, batchId, laneId) {
  if (!SAFE_ID.test(String(sessionId))) throw new Error('invalid sessionId: ' + sessionId);
  if (!SAFE_ID.test(String(batchId))) throw new Error('invalid batchId: ' + batchId);
  if (!SAFE_ID.test(String(laneId))) throw new Error('invalid laneId: ' + laneId);
  if (RESERVED_LANE.has(laneId)) throw new Error('laneId conflicts with engine layout: ' + laneId);
}

function ensureGitIdentity(repo) {
  const name = runGit(repo, ['config', 'user.name']);
  const email = runGit(repo, ['config', 'user.email']);
  if (!name.ok || !name.stdout) runGit(repo, ['config', 'user.name', 'punky']);
  if (!email.ok || !email.stdout) runGit(repo, ['config', 'user.email', 'punky@localhost']);
}

export function ensureRepo(root, sessionId, batchId) {
  const repo = mainRepoDir(root, sessionId, batchId);
  if (!fs.existsSync(path.join(repo, 'HEAD'))) {
    fs.mkdirSync(repo, { recursive: true });
    const init = runGit(repo, ['init', '-b', 'punky/main']);
    if (!init.ok) throw new Error('git init failed: ' + init.stderr);
  }
  ensureGitIdentity(repo);
  if (!runGit(repo, ['rev-parse', '--verify', 'HEAD']).ok) {
    const seed = runGit(repo, ['commit', '--allow-empty', '-m', 'punky orch seed']);
    if (!seed.ok) throw new Error('seed commit failed: ' + seed.stderr);
  }
  return repo;
}

export function listWorktrees(repo) {
  const r = runGit(repo, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return [];
  const paths = [];
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) paths.push(normPath(line.slice('worktree '.length)));
  }
  return paths;
}

export const countBaseFiles = (dir) => { const r = runGit(dir, ['ls-files']); return r.ok ? r.stdout.split('\n').filter(Boolean).length : 0; };

function removeWorktreeDir(repo, dir) {
  if (listWorktrees(repo).includes(normPath(dir))) {
    runGit(repo, ['worktree', 'remove', '--force', dir]);
  }
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  runGit(repo, ['worktree', 'prune']);
}

const WORKTREE_OPS = Object.freeze(['list', 'remove', 'add-branch', 'add-existing-branch', 'show-ref']);
const gitFailureOf = (r) => ({ message: String(r?.stderr ?? '').trim() || ('git exit ' + String(r?.code)), code: r?.code });
function worktreeOpError(op, dir, e) {
  if (!WORKTREE_OPS.includes(op)) throw new Error('unknown worktree op: ' + op + '（合法值：' + WORKTREE_OPS.join('/') + '）');
  const base = String(e?.message ?? e);
  const err = new Error(`${op} failed: ${dir} — ${base}` + (e && 'code' in e ? ` (exit ${e.code})` : ''));
  err.worktreeOp = { op, path: dir, originalMessage: base, gitExit: e && 'code' in e ? e.code : undefined };
  return err;
}

// 集成分支 worktree（幂等）：已注册 → 复用（保留已合并产物）；残留 → 清理重建
// 分支已存在（崩溃残留）→ 挂载既有分支（保全已合并历史），不存在 → -B 新建
export function ensureOrch(root, sessionId, batchId) {
  const repo = mainRepoDir(root, sessionId, batchId);
  const orch = orchDirOf(root, sessionId, batchId);
  if (listWorktrees(repo).includes(normPath(orch))) return { repo, orch };
  removeWorktreeDir(repo, orch);
  const hasBranch = runGit(repo, ['show-ref', '--verify', '--quiet', 'refs/heads/' + ORCH_BRANCH]).ok;
  const args = hasBranch ? ['worktree', 'add', orch, ORCH_BRANCH] : ['worktree', 'add', '-B', ORCH_BRANCH, orch];
  const add = runGit(repo, args);
  if (!add.ok) throw worktreeOpError(hasBranch ? 'add-existing-branch' : 'add-branch', orch, gitFailureOf(add));
  return { repo, orch };
}

// lane worktree 创建（幂等）：已注册 → 复用；残留 → 清理重建
// 分支已存在（上次崩溃/未合并残留）→ 挂载既有分支（checkpoint 保全优先）；
// 全新 → 从 orch HEAD 基线建分支（基线 = orch HEAD）
export function createLaneWorktree(root, sessionId, batchId, laneId) {
  const repo = mainRepoDir(root, sessionId, batchId);
  const dir = laneDirOf(root, sessionId, batchId, laneId);
  const branch = laneBranch(laneId);
  // reason 枚举穷尽本函数三条实际分支（不得留 other/unknown 兜底）：'reused' ← 已注册命中（幂等复用）；
  //   'recreated-after-residual' ← 残留在场（未注册目录 / 既有 lane 分支）后清理重建；'created' ← 全新创建
  if (listWorktrees(repo).includes(normPath(dir))) return { repo, dir, branch, reused: true, reason: 'reused' };
  const residualDir = fs.existsSync(dir); // 残留证据须在清理前取（removeWorktreeDir 会把目录抹掉）
  removeWorktreeDir(repo, dir);
  const hasBranch = runGit(repo, ['show-ref', '--verify', '--quiet', 'refs/heads/' + branch]).ok;
  const args = hasBranch
    ? ['worktree', 'add', dir, branch]
    : ['worktree', 'add', '-b', branch, dir, ORCH_BRANCH];
  const add = runGit(repo, args);
  if (!add.ok) throw worktreeOpError(hasBranch ? 'add-existing-branch' : 'add-branch', dir, gitFailureOf(add));
  return { repo, dir, branch, reused: false, reason: (residualDir || hasBranch) ? 'recreated-after-residual' : 'created' };
}

// checkpoint：git add -A && git commit -m "<batchId>/<laneId>: <message>"；无变更 no-op
// （checkpoint 保全引用）：可选 progress={step,total}——提供时 commit message 内嵌
//   "step <step>/<total> — <message>"（git log 可直接审计进度，对齐 taskswarm STATUS 语义）；
//   不传 progress 保持现状格式（向后兼容，参数语义不变）。
export function doCheckpoint(root, sessionId, batchId, laneId, message, progress) {
  const dir = laneDirOf(root, sessionId, batchId, laneId);
  if (!fs.existsSync(dir) || !fs.existsSync(path.join(dir, '.git'))) {
    return { ok: false, reason: 'lane worktree not found — run lane_worktree_create first', worktree: dir };
  }
  const status = runGit(dir, ['status', '--porcelain']);
  if (!status.ok) throw new Error('git status failed: ' + status.stderr);
  if (!status.stdout) return { ok: true, committed: false, reason: 'no changes (no-op)', worktree: dir };
  const msg = progress
    ? batchId + '/' + laneId + ': step ' + progress.step + '/' + progress.total + ' — ' + message
    : batchId + '/' + laneId + ': ' + message;
  const add = runGit(dir, ['add', '-A']);
  if (!add.ok) throw new Error('git add failed: ' + add.stderr);
  const commit = runGit(dir, ['commit', '-m', msg]);
  if (!commit.ok) throw new Error('git commit failed: ' + commit.stderr);
  const head = runGit(dir, ['rev-parse', 'HEAD']);
  return { ok: true, committed: true, commit: head.ok ? head.stdout : null, worktree: dir, message: msg };
}

// merge lane 分支进 orch：串行（merge 队列锁）；成功 → 清理；冲突 → 保留现场 + 文件清单
export async function doMerge(root, sessionId, batchId, laneId) {
  const { repo, orch } = ensureOrch(root, sessionId, batchId);
  const branch = laneBranch(laneId);
  if (!runGit(repo, ['show-ref', '--verify', '--quiet', 'refs/heads/' + branch]).ok) {
    throw new Error('lane branch not found: ' + branch + '（请先 lane_worktree_create）');
  }
  const lane = laneDirOf(root, sessionId, batchId, laneId);
  const lockPath = mergeLockFile(root, sessionId, batchId);
  const acquired = await lock.acquire(lockPath, { waitMs: MERGE_WAIT_MS });
  if (!acquired.ok) return { ok: false, error: 'merge queue busy（同批次 merge 串行化，等待超时）' };
  try {
    // 物理单写者：git merge 在 orch worktree 内执行（git 锁即物理单写者，serializedMerge 纪律）
    const m = runGit(orch, ['merge', '--no-edit', branch]);
    if (!m.ok) {
      // 失败保留现场：worktree/分支/在途 merge 状态全保留（不自动处置），返回冲突文件清单
      const unmerged = runGit(orch, ['diff', '--name-only', '--diff-filter=U']);
      return {
        ok: false, conflict: true,
        files: unmerged.ok ? unmerged.stdout.split('\n').filter(Boolean) : [],
        stderr: m.stderr,
      };
    }
    // 成功：清理 worktree + 分支（branch -d 在 orch HEAD 上下文判断已合并）
    if (fs.existsSync(path.join(lane, '.git'))) runGit(repo, ['worktree', 'remove', '--force', lane]);
    runGit(repo, ['worktree', 'prune']);
    const del = runGit(orch, ['branch', '-d', branch]);
    return { ok: true, worktreeCleaned: true, branchDeleted: del.ok, note: del.ok ? '' : 'branch -d: ' + del.stderr };
  } finally {
    lock.release(lockPath, acquired.token);
  }
}
