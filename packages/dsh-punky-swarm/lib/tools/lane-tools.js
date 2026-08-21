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

// 蟛蜞模式 lane 工具（C2：worktree 物理隔离 + checkpoint 提交）
// -----------------------------------------------------------------------------
// 填充自骨架（punky-capability 批次 exec-worktree lane；原骨架仅导出签名，本文件补齐
// 3 个 worktree 治理工具，决策包 §2 为唯一权威）。实现契约要点：
//   - lane_worktree_create  : git worktree 建 lane 隔离工作树（幂等；集成分支 punky/orch 常驻，
//                             lane 分支 punky/<laneId> 从 orch HEAD 基线；残留先清理）
//   - lane_worktree_merge   : 串行 merge lane 分支进 orch（merge 队列锁 = serializedMerge 纪律；
//                             成功清理 worktree+分支；失败保留现场 + 冲突文件清单，不自动处置）
//   - lane_checkpoint       : lane 内 git add -A + commit（无变更 no-op）；这是续跑 B 增强恢复
//                             （批次 7 阶段 1）的物理保全地基——崩溃后 checkpoint 保住产物、
//                             人工可抢救（git log 可查），不触发任何自动恢复（守「不做续跑」红线）
//   - lane_checkpoint_status: 只读查询该 lane checkpoint 历史与 latest 进度（B2 增强，读事件流不调 git；
//                             resume 契约唯一查询入口——新 worker 查 checkpoint 跳过已完成步骤）
// lane_heartbeat 工具由 lane-1（lib/watch/lane-heartbeat.js）注入组装（enabled 门控由该模块自持；
// 守卫式加载：lane-1 未合入时静默降级，本模块照常注册 worktree 四工具，互不阻塞，决策包 §7.1-3）。
//
// 装配开关：config.capabilities?.worktree?.enabled === true 时注册（默认关 → 工具总数 14 不变，
// 回归零破坏，对齐 aip.enabled 先例）。B2 增强（punky-resume 批次 7 阶段 1）：lane_checkpoint 可选
// progress={step,total}（commit message 内嵌 step N/total + 事件 step/total）+ 只读 lane_checkpoint_status。
//
// 与 lane_claim 逻辑锁的互补关系（决策包 §2.2 实现契约内说明）：
//   - lane_claim（既有）：同一 lane 的【逻辑写】锁——批次/成员状态文件、产物落盘路径并发防写；
//     管「写谁的」（治理状态层），维持现状是正确性底线。
//   - 本组工具（新增）：不同 lane 在【同一 git 仓库】的【物理写】——工作目录/分支/文件树；
//     管「写到哪」（工作区层），仅当 C 类批次多 lane 作用于同一 git 仓库时启用（Manager 在 exec
//     派发前先 lane_worktree_create 并把路径注入 worker 任务包作 cwd 契约）。
//   两者不能互相替代（worktree 不管状态文件并发；lane_claim 不管文件系统冲突），叠加才完整。
// -----------------------------------------------------------------------------
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TEXT_OUTPUT, sessionOf } from './core.js';
import * as lock from '../lock.js';
import { resolveMergeConflict } from './merge-agent.js'; // punky-finalize E2：merge 冲突可选 LLM 化解（默认关）

// ---- lane-1 依赖（守卫式加载）----
let createHeartbeatTools = null;
try {
  const m = await import('../watch/lane-heartbeat.js');
  createHeartbeatTools = (typeof m?.createHeartbeatTools === 'function') ? m.createHeartbeatTools : null;
} catch {
  createHeartbeatTools = null; // lane-1 未合入 / 模块异常 → lane_heartbeat 留待集成
}

// ---- 常量 ----
const SAFE_ID = /^[a-zA-Z0-9._-]+$/;
const RESERVED_LANE = new Set(['_repo', 'orch']); // 与引擎目录布局冲突的 laneId 保留字
const ORCH_BRANCH = 'punky/orch';
const MERGE_WAIT_MS = 60_000; // 同批次 merge 串行化等待上限（serializedMerge 纪律）

const gitBin = () => process.env.DSH_GIT_BIN ?? 'git';

// git 调用统一契约（仿 study-taskswarm git.ts runGit）：同步、{ ok, stdout, stderr, code }；
// git 缺失/不可执行 → ok:false + 清晰错误（不挂起、不静默失败，验收 T5）
export function runGit(repo, args, { cwd } = {}) {
  try {
    const out = execFileSync(gitBin(), args, {
      cwd: cwd ?? repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return { ok: true, stdout: String(out ?? '').trim(), stderr: '', code: 0 };
  } catch (e) {
    const stderr = e?.stderr ? String(e.stderr).trim() : (e?.message ? String(e.message) : String(e));
    return { ok: false, stdout: '', stderr, code: typeof e?.status === 'number' ? e.status : -1 };
  }
}

// git 可用性探测（工具调用前置；git 不可用 → 返回清晰错误并提示安装，验收 T5）
function gitProbe() {
  const r = runGit('.', ['--version']);
  return r.ok ? { ok: true, version: r.stdout } : { ok: false, error: r.stderr };
}

// ---- 引擎状态根内布局（决策包 §2.2：worktree 根 = <root>/sessions/<sessionId>/worktrees/<batchId>/<laneId>）----
function batchWtRoot(root, sessionId, batchId) { return path.join(root, 'sessions', sessionId, 'worktrees', batchId); }
function mainRepoDir(root, sessionId, batchId) { return path.join(batchWtRoot(root, sessionId, batchId), '_repo'); }
function orchDirOf(root, sessionId, batchId) { return path.join(batchWtRoot(root, sessionId, batchId), 'orch'); }
function laneDirOf(root, sessionId, batchId, laneId) { return path.join(batchWtRoot(root, sessionId, batchId), laneId); }
function mergeLockFile(root, sessionId, batchId) { return path.join(batchWtRoot(root, sessionId, batchId), '.merge.lock'); }
const laneBranch = (laneId) => 'punky/' + laneId;
// 路径归一化（Windows）：git worktree porcelain 输出长路径名，而 os.tmpdir()/TEMP 可能是 8.3 短名
// （如 ADMINI~1）——realpathSync.native 展开短名到规范长路径，保证注册 worktree 匹配可靠
function normPath(p) {
  let abs = path.resolve(p);
  try { abs = fs.realpathSync.native(abs); } catch { /* 路径不存在等 → 保持原样 */ }
  return abs.replace(/\\/g, '/').replace(/\/+$/, '');
}

function validateIds(sessionId, batchId, laneId) {
  if (!SAFE_ID.test(String(sessionId))) throw new Error('invalid sessionId: ' + sessionId);
  if (!SAFE_ID.test(String(batchId))) throw new Error('invalid batchId: ' + batchId);
  if (!SAFE_ID.test(String(laneId))) throw new Error('invalid laneId: ' + laneId);
  if (RESERVED_LANE.has(laneId)) throw new Error('laneId conflicts with engine layout: ' + laneId);
}

// git 身份兜底：全局/本地均无身份时回退 punky/punky@localhost（决策包 §2.2 ensureGitIdentity）
function ensureGitIdentity(repo) {
  const name = runGit(repo, ['config', 'user.name']);
  const email = runGit(repo, ['config', 'user.email']);
  if (!name.ok || !name.stdout) runGit(repo, ['config', 'user.name', 'punky']);
  if (!email.ok || !email.stdout) runGit(repo, ['config', 'user.email', 'punky@localhost']);
}

// 主仓库初始化（幂等）：git init + 种子提交（worktree add 需要已存在的 HEAD 提交）
function ensureRepo(root, sessionId, batchId) {
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

function listWorktrees(repo) {
  const r = runGit(repo, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return [];
  const paths = [];
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) paths.push(normPath(line.slice('worktree '.length)));
  }
  return paths;
}

// 清理残留 worktree 目录：已注册 → worktree remove --force；孤儿目录 → rm -rf；再 prune
function removeWorktreeDir(repo, dir) {
  if (listWorktrees(repo).includes(normPath(dir))) {
    runGit(repo, ['worktree', 'remove', '--force', dir]); // 失败（锁定等）不抛，下面 rm 兜底
  }
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  runGit(repo, ['worktree', 'prune']);
}

// 集成分支 worktree（幂等）：已注册 → 复用（保留已合并产物）；残留 → 清理重建
// 分支已存在（崩溃残留）→ 挂载既有分支（保全已合并历史），不存在 → -B 新建
function ensureOrch(root, sessionId, batchId) {
  const repo = mainRepoDir(root, sessionId, batchId);
  const orch = orchDirOf(root, sessionId, batchId);
  if (listWorktrees(repo).includes(normPath(orch))) return { repo, orch };
  removeWorktreeDir(repo, orch);
  const hasBranch = runGit(repo, ['show-ref', '--verify', '--quiet', 'refs/heads/' + ORCH_BRANCH]).ok;
  const args = hasBranch ? ['worktree', 'add', orch, ORCH_BRANCH] : ['worktree', 'add', '-B', ORCH_BRANCH, orch];
  const add = runGit(repo, args);
  if (!add.ok) throw new Error('worktree add (orch) failed: ' + add.stderr);
  return { repo, orch };
}

// lane worktree 创建（幂等）：已注册 → 复用；残留 → 清理重建
// 分支已存在（上次崩溃/未合并残留）→ 挂载既有分支（checkpoint 保全优先，验收 T6）；
// 全新 → 从 orch HEAD 基线建分支（验收 T1：基线 = orch HEAD）
function createLaneWorktree(root, sessionId, batchId, laneId) {
  const repo = mainRepoDir(root, sessionId, batchId);
  const dir = laneDirOf(root, sessionId, batchId, laneId);
  const branch = laneBranch(laneId);
  if (listWorktrees(repo).includes(normPath(dir))) return { repo, dir, branch, reused: true };
  removeWorktreeDir(repo, dir);
  const hasBranch = runGit(repo, ['show-ref', '--verify', '--quiet', 'refs/heads/' + branch]).ok;
  const args = hasBranch
    ? ['worktree', 'add', dir, branch]
    : ['worktree', 'add', '-b', branch, dir, ORCH_BRANCH];
  const add = runGit(repo, args);
  if (!add.ok) throw new Error('worktree add (lane ' + laneId + ') failed: ' + add.stderr);
  return { repo, dir, branch, reused: false };
}

// checkpoint：git add -A && git commit -m "<batchId>/<laneId>: <message>"；无变更 no-op
// B2 增强（checkpoint 保全引用，决策包 §三 B2）：可选 progress={step,total}——提供时 commit message 内嵌
//   "step <step>/<total> — <message>"（git log 可直接审计进度，对齐 taskswarm STATUS 语义）；
//   不传 progress 保持现状格式（向后兼容，参数语义不变）。
function doCheckpoint(root, sessionId, batchId, laneId, message, progress) {
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
async function doMerge(root, sessionId, batchId, laneId) {
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

// ---- 工具定义 ----
function worktreeToolCreate(ctx, deps) {
  const { store, root } = deps;
  return defineTool({
    name: 'lane_worktree_create',
    description: 'git worktree 物理隔离（C2）：为 lane 建独立工作树——集成分支 punky/orch 常驻（主工作树从不 checkout 它）+ lane 分支 punky/<laneId>（从 orch HEAD 基线）。幂等：已注册 worktree 复用；残留目录先 worktree remove --force + prune；git 身份缺失时本地兜底 punky/punky@localhost。worktree 根 = <root>/sessions/<sessionId>/worktrees/<batchId>/<laneId>（引擎状态根内，不落工作区）。与 lane_claim 互补：lane_claim 管逻辑写（批次状态/产物并发），本工具管物理写（git 文件树/分支）；仅当 C 类批次多 lane 作用于同一 git 仓库时由 Manager 在 exec 派发前调用，返回路径注入 worker 任务包作 cwd 契约。',
    parameters: {
      batchId: { type: 'string', required: true, description: '批次 ID' },
      laneId: { type: 'string', required: true, description: 'lane 任务 ID（wave_plan task id）' },
      session: { type: 'string', description: '批次归属会话（缺省=当前执行会话，cli 兜底）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        ok: { type: 'boolean', required: true }, worktree: { type: 'string' }, branch: { type: 'string' },
        orchBranch: { type: 'string' }, reused: { type: 'boolean' }, base: { type: 'string' }, sessionId: { type: 'string' },
        error: { type: 'string' }, // 执行路径 git 不可用返回 {ok:false,error}（punky-resume 登记项：schema 与实现对齐）
      } },
      render: (_args, v) => TEXT_OUTPUT('worktree: ' + v.worktree + ' @' + v.branch + (v.reused ? ' (reused)' : '')),
    },
    async execute(args, exec) {
      const probe = gitProbe();
      if (!probe.ok) return { ok: false, error: 'git 不可用：' + probe.error + '（lane_worktree_create 需要 git；请安装并加入 PATH，或设 DSH_GIT_BIN）' };
      const sessionId = sessionOf(args, exec);
      validateIds(sessionId, args.batchId, args.laneId);
      const batch = store.readBatch(sessionId, args.batchId);
      if (!batch) throw new Error('batch not found: ' + args.batchId + ' @' + sessionId);
      if (!(args.laneId in batch.lanes)) throw new Error('unknown lane: ' + args.laneId + ' @' + args.batchId);
      ensureRepo(root, sessionId, args.batchId);
      const { orch } = ensureOrch(root, sessionId, args.batchId);
      const { dir, branch, reused } = createLaneWorktree(root, sessionId, args.batchId, args.laneId);
      const base = runGit(orch, ['rev-parse', 'HEAD']);
      store.appendEvent(sessionId, args.batchId, 'worktree.created', {
        lane: args.laneId, worktree: dir, branch, orchBranch: ORCH_BRANCH, reused, base: base.ok ? base.stdout : null,
      });
      return { ok: true, worktree: dir, branch, orchBranch: ORCH_BRANCH, reused, base: base.ok ? base.stdout : null, sessionId };
    },
  });
}

function worktreeToolCheckpoint(ctx, deps) {
  const { store, root } = deps;
  return defineTool({
    name: 'lane_checkpoint',
    description: 'lane checkpoint 提交（C2）：在 lane worktree 内 git add -A && git commit -m "<batchId>/<laneId>: <message>"；无变更（status --porcelain 空）no-op（不产生空提交）。这是续跑 B 增强恢复（批次 7 阶段 1）的物理保全地基：崩溃后 checkpoint 提交保住产物、人工可抢救（git log 可查），不触发任何自动恢复（守「不做续跑」红线）。worker 纪律：每完成一个子步骤即 checkpoint，禁止攒批。B2 增强：可选 progress={step,total}（步骤进度 STATUS，step 1-based）——提供时 commit message 内嵌 "step N/total" 且 worktree.checkpoint 事件携带 step/total（git log 可直接审计进度）；不传 progress 保持现状（向后兼容）。',
    parameters: {
      batchId: { type: 'string', required: true, description: '批次 ID' },
      laneId: { type: 'string', required: true, description: 'lane 任务 ID' },
      message: { type: 'string', required: true, description: 'checkpoint 提交说明' },
      progress: {
        type: 'object',
        additionalProperties: false,
        properties: {
          step: { type: 'integer', description: '当前步骤（1-based）' },
          total: { type: 'integer', description: '总步数' },
        },
        description: '步骤进度 STATUS（可选，B2）：{ step, total }——step 1-based，total=总步数；提供时 commit message 内嵌 "step N/total" 且事件携带 step/total。校验：step/total 正整数且 step ≤ total。',
      },
      session: { type: 'string', description: '批次归属会话（缺省=当前执行会话，cli 兜底）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        ok: { type: 'boolean', required: true }, committed: { type: 'boolean' }, commit: { type: 'string' },
        reason: { type: 'string' }, worktree: { type: 'string' }, message: { type: 'string' },
        error: { type: 'string' },
      } },
      render: (_args, v) => TEXT_OUTPUT(v.committed ? 'checkpoint: ' + v.commit : 'checkpoint: no-op (' + (v.reason ?? '') + ')'),
    },
    async execute(args, exec) {
      const probe = gitProbe();
      if (!probe.ok) return { ok: false, error: 'git 不可用：' + probe.error + '（lane_checkpoint 需要 git；请安装并加入 PATH，或设 DSH_GIT_BIN）' };
      if (typeof args.message !== 'string' || !args.message.trim()) throw new Error('message required');
      // B2：progress 校验（fail-closed：step/total 正整数且 step ≤ total；不传 = null = 现状）
      let progress = null;
      if (args.progress != null) {
        const step = args.progress.step;
        const total = args.progress.total;
        if (!Number.isInteger(step) || !Number.isInteger(total) || step < 1 || total < 1 || step > total) {
          throw new Error('invalid progress: expected { step, total } with 1 <= step <= total (positive integers), got ' + JSON.stringify(args.progress));
        }
        progress = { step, total };
      }
      const sessionId = sessionOf(args, exec);
      validateIds(sessionId, args.batchId, args.laneId);
      const batch = store.readBatch(sessionId, args.batchId);
      if (!batch) throw new Error('batch not found: ' + args.batchId + ' @' + sessionId);
      if (!(args.laneId in batch.lanes)) throw new Error('unknown lane: ' + args.laneId + ' @' + args.batchId);
      const r = doCheckpoint(root, sessionId, args.batchId, args.laneId, args.message.trim(), progress);
      if (!r.ok) return r; // worktree 未建 → 提示先 create
      if (r.committed) {
        const evt = { lane: args.laneId, commit: r.commit, message: r.message };
        if (progress) { evt.step = progress.step; evt.total = progress.total; } // B2：事件携带 step/total（不传则无，向后兼容）
        store.appendEvent(sessionId, args.batchId, 'worktree.checkpoint', evt);
      }
      return r;
    },
  });
}

function worktreeToolCheckpointStatus(ctx, deps) {
  const { store, root } = deps;
  return defineTool({
    name: 'lane_checkpoint_status',
    description: 'lane checkpoint 状态查询（只读，B2 增强）：读取批次事件流中该 lane 的 worktree.checkpoint 事件序列（ts/step/total 已在事件内），返回 checkpoint 历史与 latest 进度——不依赖 git 调用（零副作用、只读），供新 worker 续跑前查询 checkpoint 以跳过已完成步骤（resume 契约唯一查询入口）。',
    parameters: {
      batchId: { type: 'string', required: true, description: '批次 ID' },
      laneId: { type: 'string', required: true, description: 'lane 任务 ID' },
      session: { type: 'string', description: '批次归属会话（缺省=当前执行会话，cli 兜底）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        ok: { type: 'boolean', required: true },
        lane: { type: 'string', required: true },
        branch: { type: 'string', required: true },
        worktree: { type: 'string' },
        checkpoints: {
          type: 'array', required: true,
          items: { type: 'object', additionalProperties: false, properties: {
            commit: { type: 'string' }, ts: { type: 'string' }, message: { type: 'string' },
            step: { type: 'integer' }, total: { type: 'integer' },
          } },
        },
        latest: {
          oneOf: [
            { type: 'object', additionalProperties: false, properties: { step: { type: 'integer' }, total: { type: 'integer' } } },
            { type: 'null' },
          ],
        },
      } },
      render: (_args, v) => TEXT_OUTPUT('lane ' + v.lane + ': ' + v.checkpoints.length + ' checkpoint(s), latest=' + (v.latest ? v.latest.step + '/' + v.latest.total : 'none')),
    },
    async execute(args, exec) {
      const sessionId = sessionOf(args, exec);
      validateIds(sessionId, args.batchId, args.laneId);
      const batch = store.readBatch(sessionId, args.batchId);
      if (!batch) throw new Error('batch not found: ' + args.batchId + ' @' + sessionId);
      if (!(args.laneId in batch.lanes)) throw new Error('unknown lane: ' + args.laneId + ' @' + args.batchId);
      // 只读：事件流过滤（不调 git）；latest = 最近一次携带 progress 的 checkpoint（倒序取首个有 step/total 的）
      const events = (batch.events ?? []).filter((e) => e.type === 'worktree.checkpoint' && e.lane === args.laneId);
      const checkpoints = events.map((e) => {
        const c = { commit: typeof e.commit === 'string' ? e.commit : '', ts: e.ts, message: e.message ?? '' };
        if (Number.isInteger(e.step) && Number.isInteger(e.total)) { c.step = e.step; c.total = e.total; }
        return c;
      });
      let latest = null;
      for (let i = checkpoints.length - 1; i >= 0; i--) {
        if (checkpoints[i].step != null && checkpoints[i].total != null) { latest = { step: checkpoints[i].step, total: checkpoints[i].total }; break; }
      }
      const out = { ok: true, lane: args.laneId, branch: laneBranch(args.laneId), checkpoints, latest };
      const dir = laneDirOf(root, sessionId, args.batchId, args.laneId);
      if (fs.existsSync(dir)) out.worktree = dir; // worktree 目录存在性探测（只读）
      return out;
    },
  });
}

function worktreeToolMerge(ctx, deps) {
  const { store, root } = deps;
  return defineTool({
    name: 'lane_worktree_merge',
    description: 'merge lane 分支进 orch（C2）：串行执行（merge 队列锁，同批次 merge 串行化——git 锁即物理单写者，借鉴 taskswarm serializedMerge）。成功 → lane 产物并入 punky/orch，清理 lane worktree + 删除分支；失败（冲突）→ 保留现场（worktree/分支/在途 merge 状态全保留）并返回冲突文件清单，不自动处置（conflict 语义由 Manager/Leader 裁决，失败 lane 终态、重做=重开新批次）。与 lane_claim 互补并存：本工具管物理合并，lane_claim 仍管批次状态写。',
    parameters: {
      batchId: { type: 'string', required: true, description: '批次 ID' },
      laneId: { type: 'string', required: true, description: 'lane 任务 ID' },
      session: { type: 'string', description: '批次归属会话（缺省=当前执行会话，cli 兜底）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        ok: { type: 'boolean', required: true }, conflict: { type: 'boolean' }, files: { type: 'array', items: { type: 'string' } },
        stderr: { type: 'string' }, worktreeCleaned: { type: 'boolean' }, branchDeleted: { type: 'boolean' },
        note: { type: 'string' }, error: { type: 'string' },
      } },
      render: (_args, v) => v.ok
        ? TEXT_OUTPUT('merged: worktree cleaned=' + v.worktreeCleaned + ' branch deleted=' + v.branchDeleted)
        : TEXT_OUTPUT(v.conflict ? 'merge conflict (' + (v.files ?? []).length + ' file(s))' : 'merge failed: ' + (v.error ?? v.stderr ?? '')),
    },
    async execute(args, exec) {
      const probe = gitProbe();
      if (!probe.ok) return { ok: false, error: 'git 不可用：' + probe.error + '（lane_worktree_merge 需要 git；请安装并加入 PATH，或设 DSH_GIT_BIN）' };
      const sessionId = sessionOf(args, exec);
      validateIds(sessionId, args.batchId, args.laneId);
      const batch = store.readBatch(sessionId, args.batchId);
      if (!batch) throw new Error('batch not found: ' + args.batchId + ' @' + sessionId);
      if (!(args.laneId in batch.lanes)) throw new Error('unknown lane: ' + args.laneId + ' @' + args.batchId);
      const r = await doMerge(root, sessionId, args.batchId, args.laneId);
      if (r.ok) {
        store.appendEvent(sessionId, args.batchId, 'worktree.merged', { lane: args.laneId, branch: laneBranch(args.laneId), branchDeleted: r.branchDeleted });
      } else if (r.conflict) {
        // punky-finalize E2：冲突可选 LLM merge agent 化解（默认关 → 现状逐字一致；全量逻辑在 merge-agent.js）
        return await resolveMergeConflict(deps, {
          root, store, sessionId, batchId: args.batchId, laneId: args.laneId,
          orchDir: orchDirOf(root, sessionId, args.batchId), branch: laneBranch(args.laneId),
          conflictFiles: r.files ?? [], conflict: r,
        });
      }
      return r;
    },
  });
}

// ---- 组装（决策包 §2.2）：lane_heartbeat（lane-1 注入，enabled 门控由该模块自持）+ worktree 四工具 ----
export function createLaneTools(ctx, deps) {
  const config = deps?.config ?? {};
  const tools = [];
  // lane-1 注入的 lane_heartbeat；守卫式加载，lane-1 未合入时留待集成（功能独立，互不阻塞）
  if (createHeartbeatTools) tools.push(...createHeartbeatTools(ctx, deps));
  // C2 worktree 四工具（create/merge/checkpoint/checkpoint_status）：默认关（对齐 aip.enabled 先例，回归零破坏）
  if (config?.capabilities?.worktree?.enabled === true) {
    tools.push(
      worktreeToolCreate(ctx, deps),
      worktreeToolMerge(ctx, deps),
      worktreeToolCheckpoint(ctx, deps),
      worktreeToolCheckpointStatus(ctx, deps),
    );
  }
  return tools;
}
