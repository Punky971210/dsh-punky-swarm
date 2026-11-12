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
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TEXT_OUTPUT, sessionOf } from './shared.js'; // 共享辅助直引零依赖 shared.js（不再经 core.js）
import { resolveMergeConflict } from './merge-agent.js';
import { overBudgetOf, hasOverBudgetEvent, recordCheckpointTotalMismatch, laneProgressWrite, laneProgressRead, recordEarlyExitProgress } from '../state/resume.js';
import * as EVT from '../state/event-types.js';
import { runGit } from './git-utils.js';
import { ORCH_BRANCH, orchDirOf, laneDirOf, laneBranch, normPath, validateIds, ensureRepo, listWorktrees, countBaseFiles, ensureOrch, createLaneWorktree, doCheckpoint, doMerge } from './lane-worktree-ops.js';

// git 可用性探测（工具调用前置；git 不可用 → 返回清晰错误并提示安装）
function gitProbe() {
  const r = runGit('.', ['--version']);
  return r.ok ? { ok: true, version: r.stdout } : { ok: false, error: r.stderr };
}

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
      subtaskId: { type: 'string', description: 'subtask 标识（可选；批 punky-checkpoint-enforce-20261112）：声明了 subtasks 的 exec lane 应逐项带上 —— 结算门（GATE_CHECKPOINTS_INCOMPLETE）按事件面显式 `subtask` 字段核覆盖；无 worktree / 无 git 的降级路径同样落此字段' },
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
        ok: { type: 'boolean', required: true }, committed: { type: 'boolean' },
        // 【B1】无 worktree / 无 git 的降级留痕路径 `commit = null`（前提③：强制对象是留痕，不是 git）
        commit: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        mode: { type: 'string', enum: ['no-worktree', 'no-git'], description: '降级留痕成因（仅 ok:true 且 committed:false 时给）：no-worktree = lane worktree 不在场｜no-git = git 不可用' },
        reason: { type: 'string' }, worktree: { type: 'string' }, message: { type: 'string' },
        error: { type: 'string' },
      } },
      // 【B1】渲染不再把「无 worktree 降级留痕」说成 `no-op`（spec V-22「渲染不撒谎」）
      render: (_args, v) => TEXT_OUTPUT(v.committed
        ? 'checkpoint: ' + v.commit
        : (v.mode
          ? 'checkpoint: recorded (no worktree · ' + v.mode + ') — commit=null，事件已留痕，照算完成'
          : 'checkpoint: no-op (' + (v.reason ?? '') + ')')),
    },
    async execute(args, exec) {
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
      const subtaskId = typeof args.subtaskId === 'string' && args.subtaskId.trim() ? args.subtaskId.trim() : null;
      // ── B1 · 无 worktree / git 不可用 ⇒ **降级留痕**，不再 fake no-op ────────────────────────────
      //   用户裁决 Q3=A + spec §R-5 B1：强制对象是**留痕**，不是 **git**（只读/审核 lane 与无 git 宿主都必须能留痕）。
      //   命中面（两条，缺一不降级）：
      //     · git 探针失败 ⇒ `mode:'no-git'`（原来是顶部直接 `return {ok:false,error}`，连 lane 都不读）；
      //     · `doCheckpoint` 返回 `ok:false` 且 reason 以 `lane worktree not found` 开头 ⇒ `mode:'no-worktree'`。
      //   两条都落 `worktree.checkpoint`（`commit:null` + `mode` + 可选 `step/total/subtask`），返回 `ok:true, committed:false`。
      //   其它 `ok:false`（如 `git status` 真失败）仍按既有失败路径走 `recordEarlyExitProgress`，行为零变化。
      const probe = gitProbe();
      let checkpointResult = null;
      let degradeMode = null;
      if (!probe.ok) {
        degradeMode = 'no-git';
      } else {
        checkpointResult = doCheckpoint(root, sessionId, args.batchId, args.laneId, args.message.trim(), progress);
        if (checkpointResult.ok === false && /^lane worktree not found/.test(String(checkpointResult.reason ?? ''))) {
          degradeMode = 'no-worktree';
        }
      }
      if (degradeMode !== null) {
        const evt = { lane: args.laneId, commit: null, message: args.message.trim(), mode: degradeMode };
        if (progress) { evt.step = progress.step; evt.total = progress.total; }
        if (subtaskId) evt.subtask = subtaskId;
        store.appendEvent(sessionId, args.batchId, EVT.EVT_WORKTREE_CHECKPOINT, evt);
        if (degradeMode === 'no-git') {
          ctx.logger?.warn?.('[lane-checkpoint] git 不可用（' + String(probe.error ?? '') + '）⇒ 记 worktree.checkpoint（commit=null, mode=no-git），不阻断');
        }
        // 断点指针仍走**既有单点** `recordEarlyExitProgress`（内含终态守卫：lane 已终态不补写 ——
        //   与批 `punky-quality-a-20261106` T9 ④ 的判据同源，B1 不放开这道守卫）。
        // 降级路径**不落** `total_mismatch` / `over-budget`：二者语义绑「确有提交」，本路径无 commit
        //   ⇒ 照旧不落（T9 ② 的误报纪律，本批零改动）。
        recordEarlyExitProgress(store, sessionId, args.batchId, batch, args.laneId, progress, ctx.logger);
        const dir = laneDirOf(root, sessionId, args.batchId, args.laneId);
        return {
          ok: true, committed: false, commit: null, mode: degradeMode,
          message: args.message.trim(),
          reason: degradeMode === 'no-git' ? 'git unavailable' : 'lane worktree not found',
          ...(fs.existsSync(dir) ? { worktree: dir } : {}),
        };
      }
      if (!checkpointResult.ok) {
        recordEarlyExitProgress(store, sessionId, args.batchId, batch, args.laneId, progress, ctx.logger);
        return checkpointResult;
      }
      if (checkpointResult.committed) {
        const evt = { lane: args.laneId, commit: checkpointResult.commit, message: checkpointResult.message };
        if (progress) { evt.step = progress.step; evt.total = progress.total; }
        if (subtaskId) evt.subtask = subtaskId;
        store.appendEvent(sessionId, args.batchId, EVT.EVT_WORKTREE_CHECKPOINT, evt);
      } else {
        // ── B-2 修复（批 `punky-ckpt-followup-20261112` · blocking B-2）────────────────────────────
        //   「worktree **在场**但零变更」原先在这里直接落到 `:181`，**既不落事件也不带 `subtask`**
        //   ⇒ 逐项留痕（显式覆盖面 `coveredSubtasksOf().ids`）在「lane 直接改真实工作副本」的现状下不可达，
        //      G2 只剩序贯覆盖可用。
        //   现在与 `no-worktree` / `no-git` 两条降级同形：同样落 `worktree.checkpoint`（`commit:null`），
        //   但用 `mode:'no-change'` 区分成因（worktree 在、只是没有 diff），并带 `step/total/subtask`。
        const evt = { lane: args.laneId, commit: null, message: args.message.trim(), mode: 'no-change' };
        if (progress) { evt.step = progress.step; evt.total = progress.total; }
        if (subtaskId) evt.subtask = subtaskId;
        store.appendEvent(sessionId, args.batchId, EVT.EVT_WORKTREE_CHECKPOINT, evt);
        // 返回值同步补 `commit:null` + `mode`：与两条降级路径同形，调用方（含渲染面）才分得清成因。
        //   ⚠ 保留 `reason`（`no changes (no-op)`）不动 —— 渲染面对「真零变更」仍渲染 no-op（V-22 对照组）。
        checkpointResult = { ...checkpointResult, commit: null, mode: 'no-change' };
      }
      if (progress) {
        try { store.updateLaneProgress(sessionId, args.batchId, args.laneId, { ...progress, status: 'running' }); }
        catch (e) { ctx.logger?.warn?.('[lane-checkpoint] laneProgress write failed: ' + String(e?.message ?? e)); }
        const b = overBudgetOf(batch, args.laneId, progress); recordCheckpointTotalMismatch(store, sessionId, args.batchId, batch, args.laneId, progress, ctx.logger);
        if (b.over && !hasOverBudgetEvent(batch, args.laneId)) {
          store.appendEvent(sessionId, args.batchId, EVT.EVT_LANE_OVER_BUDGET, { lane: args.laneId, step: progress.step, total: progress.total, budget: b.budget });
        }
      }
      return checkpointResult;
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
      const lp = latest ? null : laneProgressRead(batch, args.laneId);
      if (lp && Number.isInteger(lp.step) && Number.isInteger(lp.total)) { latest = { step: lp.step, total: lp.total }; latestSource = 'laneProgress'; }
      const out = { ok: true, lane: args.laneId, branch: laneBranch(args.laneId), checkpoints, latest, ...(latestSource ? { latestSource } : {}) };
      const dir = laneDirOf(root, sessionId, args.batchId, args.laneId);
      if (fs.existsSync(dir)) out.worktree = dir;
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
