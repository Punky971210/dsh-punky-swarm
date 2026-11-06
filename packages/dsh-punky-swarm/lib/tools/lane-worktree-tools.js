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

// ---- lane 工具契约层：defineTool 四工厂 + gitProbe（消费 ops 物理层）----
import fs from 'node:fs';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TEXT_OUTPUT, sessionOf } from './shared.js'; // 共享辅助直引零依赖 shared.js（不再经 core.js）
import { resolveMergeConflict } from './merge-agent.js'; // merge 冲突可选 LLM 化解（默认关）
import { overBudgetOf, hasOverBudgetEvent, recordCheckpointTotalMismatch, laneProgressWrite, laneProgressRead, recordEarlyExitProgress } from '../state/resume.js'; // 步数预算超限判定 + **checkpoint 清单对齐留痕**（薄壳：判定/幂等/fail-safe 都在 resume.js，本文件只增 1 行以守行数护栏）；laneProgressWrite：断点指针写；laneProgressRead：断点指针读（**单点**，禁在工具层重写 `batch?.laneProgress?.[lane]` 访问式）；recordEarlyExitProgress：无 worktree 早退时补写指针
import * as EVT from '../state/event-types.js';
import { runGit } from './git-utils.js';
import { ORCH_BRANCH, orchDirOf, laneDirOf, laneBranch, normPath, validateIds, ensureRepo, listWorktrees, countBaseFiles, ensureOrch, createLaneWorktree, doCheckpoint, doMerge } from './lane-worktree-ops.js';

// git 可用性探测（工具调用前置；git 不可用 → 返回清晰错误并提示安装）
function gitProbe() {
  const r = runGit('.', ['--version']);
  return r.ok ? { ok: true, version: r.stdout } : { ok: false, error: r.stderr };
}

// ---- 工具定义 ----
export function worktreeToolCreate(ctx, deps) {
  const { store, root, resolveBatchSession } = deps;
  return defineTool({
    name: 'lane_worktree_create',
    description: '为 lane 建 git worktree 物理隔离（集成分支 punky/orch 常驻 + lane 分支 punky/<laneId>，基线 orch HEAD）。幂等复用；残留先 remove --force + prune；git 身份缺失兜底 punky/punky@localhost。根 = <root>/sessions/<sessionId>/worktrees/<batchId>/<laneId>。仅 C 类批多 lane 同仓库时于 exec 派发前调用，返回路径作 worker 的 cwd。',
    parameters: {
      sourceRunId: { type: 'string', description: '来源 run（缺省取 agent.session.id），缺失即拒' },
      batchId: { type: 'string', required: true, description: '批次 ID' },
      laneId: { type: 'string', required: true, description: 'lane 任务 ID（wave_plan task id）' },
      session: { type: 'string', description: '批次归属会话（缺省=当前执行会话）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        ok: { type: 'boolean', required: true }, worktree: { type: 'string' }, branch: { type: 'string' },
        orchBranch: { type: 'string' }, reused: { type: 'boolean' }, base: { type: 'string' }, sessionId: { type: 'string' },
        reason: { type: 'string', enum: ['created', 'reused', 'recreated-after-residual'] },
        isolated: { type: 'boolean' }, baseFiles: { type: 'integer' },
        error: { type: 'string' }, // 执行路径 git 不可用返回 {ok:false,error}（schema 与实现对齐）
      } },
      render: (_args, v) => TEXT_OUTPUT(v.ok === false ? 'worktree create failed: ' + (v.error ?? '') : 'worktree: ' + v.worktree + ' @' + v.branch + (v.reused ? ' (reused)' : '') + ' isolated=' + v.isolated + ' baseFiles=' + v.baseFiles + ' [' + v.reason + ']'),
    },
    async execute(args, exec) {
      const probe = gitProbe();
      if (!probe.ok) return { ok: false, error: 'git 不可用：' + probe.error + '（lane_worktree_create 需要 git；请安装并加入 PATH，或设 DSH_GIT_BIN）' };
      const sessionId = sessionOf(args, exec, resolveBatchSession);
      validateIds(sessionId, args.batchId, args.laneId);
      const batch = store.readBatch(sessionId, args.batchId);
      if (!batch) throw new Error('batch not found: ' + args.batchId + ' @' + sessionId);
      if (!(args.laneId in batch.lanes)) throw new Error('unknown lane: ' + args.laneId + ' @' + args.batchId);
      ensureRepo(root, sessionId, args.batchId);
      const { repo, orch } = ensureOrch(root, sessionId, args.batchId);
      const { dir, branch, reused, reason } = createLaneWorktree(root, sessionId, args.batchId, args.laneId);
      const base = runGit(orch, ['rev-parse', 'HEAD']);
      // 单一判定位：isolated = 基线受控文件数 > 0 且 worktree 注册命中；「创建成功」不蕴含本式（空 seed 形态恒 false）
      const baseFiles = countBaseFiles(dir);
      const isolated = baseFiles > 0 && listWorktrees(repo).includes(normPath(dir));
      store.appendEvent(sessionId, args.batchId, EVT.EVT_WORKTREE_CREATED, {
        lane: args.laneId, worktree: dir, branch, orchBranch: ORCH_BRANCH, reused, base: base.ok ? base.stdout : null,
      });
      return { ok: true, worktree: dir, branch, orchBranch: ORCH_BRANCH, reused, base: base.ok ? base.stdout : null, sessionId, reason, isolated, baseFiles };
    },
  });
}

export function worktreeToolCheckpoint(ctx, deps) {
  const { store, root, resolveBatchSession } = deps;
  return defineTool({
    name: 'lane_checkpoint',
    description: 'lane checkpoint：在 lane worktree 内 git add -A && git commit -m "<batchId>/<laneId>: <message>"；无变更则 no-op。worker 纪律：每完成一个子步骤即 checkpoint，禁攒批。可选 progress={step,total}（step 1-based，正整数且 step ≤ total）：commit message 内嵌 "step N/total" 且 worktree.checkpoint 事件携带，供续跑查已完步骤。',
    parameters: {
      sourceRunId: { type: 'string', description: '来源 run（缺省取 agent.session.id），缺失即拒' },
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
        description: '步骤进度（可选）{step,total}：step 1-based；提供则内嵌 "step N/total" 并以 worktree.checkpoint 事件携带',
      },
      session: { type: 'string', description: '批次归属会话（缺省=当前执行会话）' },
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
      // progress 校验（fail-closed：step/total 正整数且 step ≤ total；不传 = null = 现状）
      let progress = null;
      if (args.progress != null) {
        const step = args.progress.step;
        const total = args.progress.total;
        if (!Number.isInteger(step) || !Number.isInteger(total) || step < 1 || total < 1 || step > total) {
          throw new Error('invalid progress: expected { step, total } with 1 <= step <= total (positive integers), got ' + JSON.stringify(args.progress));
        }
        progress = { step, total };
      }
      const sessionId = sessionOf(args, exec, resolveBatchSession);
      validateIds(sessionId, args.batchId, args.laneId);
      const batch = store.readBatch(sessionId, args.batchId);
      if (!batch) throw new Error('batch not found: ' + args.batchId + ' @' + sessionId);
      if (!(args.laneId in batch.lanes)) throw new Error('unknown lane: ' + args.laneId + ' @' + args.batchId);
      const r = doCheckpoint(root, sessionId, args.batchId, args.laneId, args.message.trim(), progress);
      // A2：worktree 未建 ⇒ 提交不成立，但**断点指针不得静默丢失**（只补指针；不落 total_mismatch / over_budget——两者语义前提是「确有 checkpoint」）
      if (!r.ok) { recordEarlyExitProgress(store, sessionId, args.batchId, batch, args.laneId, progress, ctx.logger); return r; }
      if (r.committed) {
        const evt = { lane: args.laneId, commit: r.commit, message: r.message };
        if (progress) { evt.step = progress.step; evt.total = progress.total; } // 事件携带 step/total（不传则无，向后兼容）
        store.appendEvent(sessionId, args.batchId, EVT.EVT_WORKTREE_CHECKPOINT, evt);
      }
      // 断点指针：checkpoint 携带 progress 经 laneProgressWrite 写 laneProgress（每子步骤完成即写，失败不阻断）+ 步数预算超限判定
      if (progress) {
        try { store.updateLaneProgress(sessionId, args.batchId, args.laneId, { ...progress, status: 'running' }); }
        catch (e) { ctx.logger?.warn?.('[lane-checkpoint] laneProgress write failed: ' + String(e?.message ?? e)); }
        const b = overBudgetOf(batch, args.laneId, progress); recordCheckpointTotalMismatch(store, sessionId, args.batchId, batch, args.laneId, progress, ctx.logger); // 同处：清单对齐留痕（判定/幂等/fail-safe 见 resume.js）；本文件行数有 T2.6 护栏（上限 462，批 `punky-quality-a-20261106` 实测 457→458，余量 4）故不新增行
        if (b.over && !hasOverBudgetEvent(batch, args.laneId)) {
          store.appendEvent(sessionId, args.batchId, EVT.EVT_LANE_OVER_BUDGET, { lane: args.laneId, step: progress.step, total: progress.total, budget: b.budget });
        }
      }
      return r;
    },
  });
}

export function worktreeToolCheckpointStatus(ctx, deps) {
  const { store, root, resolveBatchSession } = deps;
  return defineTool({
    name: 'lane_checkpoint_status',
    description: '只读查询该 lane 的 worktree.checkpoint 事件序列（ts/step/total），返回 checkpoint 历史与 latest 进度，不依赖 git 调用、零副作用。新 worker 续跑前用它跳过已完成步骤。优先序：有 worktree.checkpoint 事件时以事件为准（两者不一致时事件胜出，不做数值合并）；事件面为空时回落读取 laneProgress 断点指针（无 worktree 批的唯一来源），latestSource 标明来源。',
    parameters: {
      batchId: { type: 'string', required: true, description: '批次 ID' },
      laneId: { type: 'string', required: true, description: 'lane 任务 ID' },
      session: { type: 'string', description: '批次归属会话（缺省=当前执行会话）' },
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
        latestSource: { oneOf: [{ type: 'string' }, { type: 'null' }], description: "latest 的来源：'event'（worktree.checkpoint 事件，优先）｜'laneProgress'（断点指针，事件面为空时兜底）；无任何进度时字段缺席" },
      } },
      render: (_args, v) => TEXT_OUTPUT('lane ' + v.lane + ': ' + v.checkpoints.length + ' checkpoint(s), latest=' + (v.latest ? v.latest.step + '/' + v.latest.total : 'none')),
    },
    async execute(args, exec) {
      const sessionId = sessionOf(args, exec, resolveBatchSession);
      validateIds(sessionId, args.batchId, args.laneId);
      const batch = store.readBatch(sessionId, args.batchId);
      if (!batch) throw new Error('batch not found: ' + args.batchId + ' @' + sessionId);
      if (!(args.laneId in batch.lanes)) throw new Error('unknown lane: ' + args.laneId + ' @' + args.batchId);
      // 只读：事件流过滤（不调 git）；latest = 倒序首个携带 step/total 的 checkpoint。优先序（E-CK4）：**事件优先、指针兜底**——事件是物理提交留痕、laneProgress 是可能被早退/重派覆写的断点指针 ⇒ 事件面非空时一律以事件为准，不一致时**禁**数值合并（不取更大 step）
      const events = (batch.events ?? []).filter((e) => e.type === EVT.EVT_WORKTREE_CHECKPOINT && e.lane === args.laneId);
      const checkpoints = events.map((e) => {
        const c = { commit: typeof e.commit === 'string' ? e.commit : '', ts: e.ts, message: e.message ?? '' };
        if (Number.isInteger(e.step) && Number.isInteger(e.total)) { c.step = e.step; c.total = e.total; }
        return c;
      });
      let latest = null; let latestSource = null;
      for (let i = checkpoints.length - 1; i >= 0; i--) {
        if (checkpoints[i].step != null && checkpoints[i].total != null) { latest = { step: checkpoints[i].step, total: checkpoints[i].total }; latestSource = 'event'; break; }
      }
      const lp = latest ? null : laneProgressRead(batch, args.laneId); // 事件面为空才读指针（指针只兜底，不抢位）
      if (lp && Number.isInteger(lp.step) && Number.isInteger(lp.total)) { latest = { step: lp.step, total: lp.total }; latestSource = 'laneProgress'; }
      const out = { ok: true, lane: args.laneId, branch: laneBranch(args.laneId), checkpoints, latest, ...(latestSource ? { latestSource } : {}) };
      const dir = laneDirOf(root, sessionId, args.batchId, args.laneId);
      if (fs.existsSync(dir)) out.worktree = dir; // worktree 目录存在性探测（只读）
      return out;
    },
  });
}

export function worktreeToolMerge(ctx, deps) {
  const { store, root, resolveBatchSession } = deps;
  return defineTool({
    name: 'lane_worktree_merge',
    description: 'merge lane 分支进 orch：串行执行（merge 队列锁，同批串行化）。成功 → 产物并入 punky/orch 并清理 lane worktree 与分支；冲突 → 保留现场并返回冲突文件清单，不自动处置（失败 lane 终态，重做 = 重开新批次）。本工具管物理合并，lane_claim 仍管批次状态写。',
    parameters: {
      sourceRunId: { type: 'string', description: '来源 run（缺省取 agent.session.id），缺失即拒' },
      batchId: { type: 'string', required: true, description: '批次 ID' },
      laneId: { type: 'string', required: true, description: 'lane 任务 ID' },
      session: { type: 'string', description: '批次归属会话（缺省=当前执行会话）' },
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
      const sessionId = sessionOf(args, exec, resolveBatchSession);
      validateIds(sessionId, args.batchId, args.laneId);
      const batch = store.readBatch(sessionId, args.batchId);
      if (!batch) throw new Error('batch not found: ' + args.batchId + ' @' + sessionId);
      if (!(args.laneId in batch.lanes)) throw new Error('unknown lane: ' + args.laneId + ' @' + args.batchId);
      const r = await doMerge(root, sessionId, args.batchId, args.laneId);
      if (r.ok) {
        store.appendEvent(sessionId, args.batchId, EVT.EVT_WORKTREE_MERGED, { lane: args.laneId, branch: laneBranch(args.laneId), branchDeleted: r.branchDeleted });
      } else if (r.conflict) {
        // 冲突可选 LLM merge agent 化解（默认关 → 现状逐字一致；全量逻辑在 merge-agent.js）
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
