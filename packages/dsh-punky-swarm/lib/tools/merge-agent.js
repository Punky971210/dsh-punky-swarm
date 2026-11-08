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

// LLM merge agent 冲突化解辅助模块（借鉴 taskswarm merger 三态判定）
import fs from 'node:fs';
import path from 'node:path';
import { runGit } from './git-utils.js';
import * as EVT from '../state/event-types.js';

const VERDICT_RESOLVED = 'CONFLICT_RESOLVED';
const VERDICT_SUCCESS = 'SUCCESS';
const VERDICT_UNRESOLVED = 'CONFLICT_UNRESOLVED';
const RESOLVED = new Set([VERDICT_RESOLVED, VERDICT_SUCCESS]);
const NO_SPAWNER_HINT = 'mergeAgent configured but no spawner injected';
const DEFAULT_TIMEOUT_MS = 600_000;
const UNMERGED_RE = /^(UU|AA|DD|AU|UA|DU|UD)\s/;

const HARD_INSTRUCTIONS = [
  'You are the merge agent for an in-flight git merge conflict in the orch worktree.',
  'HARD RULES:',
  '1. Do NOT re-run merge; the merge is already in progress in the orch worktree.',
  '2. Do NOT run `git merge --abort`; the in-flight merge must be completed, never abandoned.',
  '3. Do NOT delete worker implementations unless provably wrong (syntax error / logically impossible); prefer combining both sides.',
  '4. Edit conflict files in the orch worktree, then `git add` them and run `git commit --no-edit` to finish the merge.',
  '5. If you cannot resolve confidently, return CONFLICT_UNRESOLVED — never fabricate.',
].join('\n');

function buildMergeAgentRequest({ batchId, laneId, orchDir, conflictFiles, branch }) {
  return { batchId, laneId, orchDir, conflictFiles, branch, instructions: HARD_INSTRUCTIONS };
}

// 三态判定（超时/异常/未知 verdict → UNRESOLVED，fail-closed）
function normalizeVerdict(v) {
  if (RESOLVED.has(v) || v === VERDICT_UNRESOLVED) return v;
  return VERDICT_UNRESOLVED;
}

// git 不可查 → { ok:false, conflicted:true } fail-closed（无法证明化解 → 视同未化解）
function checkInFlightMerge(orchDir) {
  const st = runGit(orchDir, ['status', '--porcelain']);
  if (!st.ok) return { ok: false, conflicted: true, error: st.stderr };
  const unmerged = st.stdout.split('\n').filter((l) => UNMERGED_RE.test(l));
  const inFlight = runGit(orchDir, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).ok;
  return { ok: true, conflicted: unmerged.length > 0 || inFlight, unmerged, inFlight };
}

function withTimeout(p, ms) {
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('merge agent timed out after ' + ms + 'ms')), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

function statusQuo(opts, hint) {
  const { store, sessionId, batchId, laneId, conflict, conflictFiles } = opts;
  store.appendEvent(sessionId, batchId, EVT.EVT_WORKTREE_MERGE_CONFLICT, { lane: laneId, files: conflictFiles });
  return hint ? { ...conflict, note: hint } : conflict;
}

export async function resolveMergeConflict(deps, opts) {
  const config = deps?.config ?? {};
  const ma = config?.capabilities?.worktree?.mergeAgent;
  if (ma?.enabled !== true) return statusQuo(opts, null);
  const spawner = deps?.mergeAgentSpawner ?? config?.host?.spawnMergeAgent ?? null;
  if (typeof spawner !== 'function') return statusQuo(opts, NO_SPAWNER_HINT);
  const { store, sessionId, batchId, laneId, orchDir, branch, conflictFiles } = opts;
  const base = path.dirname(orchDir);
  const repo = path.join(base, '_repo');
  const lane = path.join(base, laneId);
  const request = buildMergeAgentRequest({ batchId, laneId, orchDir, conflictFiles, branch });
  const timeoutMs = Number.isFinite(ma?.timeoutMs) && ma.timeoutMs > 0 ? ma.timeoutMs : DEFAULT_TIMEOUT_MS;
  let resp;
  try {
    resp = await withTimeout(Promise.resolve().then(() => spawner(request)), timeoutMs);
  } catch {
    return statusQuo(opts, null);
  }
  const verdict = normalizeVerdict(resp?.verdict);
  if (verdict === VERDICT_UNRESOLVED) return statusQuo(opts, null);
  const check = checkInFlightMerge(orchDir);
  if (!check.ok || check.conflicted) return statusQuo(opts, null); // 校验不过 → 视同 UNRESOLVED（fail-closed）
  if (fs.existsSync(path.join(lane, '.git'))) runGit(repo, ['worktree', 'remove', '--force', lane]);
  runGit(repo, ['worktree', 'prune']);
  const del = runGit(orchDir, ['branch', '-d', branch]);
  const detail = typeof resp?.detail === 'string' && resp.detail ? resp.detail : '';
  store.appendEvent(sessionId, batchId, EVT.EVT_WORKTREE_MERGE_RESOLVED, { lane: laneId, files: conflictFiles, verdict, agent: detail || null });
  const note = del.ok
    ? 'resolved by merge agent' + (detail ? ': ' + detail : '')
    : 'branch -d: ' + del.stderr + '; resolved by merge agent';
  return { ok: true, worktreeCleaned: true, branchDeleted: del.ok, note };
}
