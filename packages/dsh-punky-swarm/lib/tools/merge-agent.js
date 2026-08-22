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
// -----------------------------------------------------------------------------
// 契约（finalize-decision.md §2.1）：
//   - lane_worktree_merge 冲突时（doMerge 返回 {ok:false, conflict:true, files}）可选派 LLM merge agent
//     语义化解；默认关（config.capabilities.worktree.mergeAgent.enabled !== true → 现状路径逐字一致，零感知零开销）。
//   - spawner 由宿主注入（引擎不直接 spawn subagent）：deps.mergeAgentSpawner 或 deps.config.host?.spawnMergeAgent，
//     签名 async (request) => ({ verdict, detail })；verdict ∈ CONFLICT_RESOLVED | SUCCESS | CONFLICT_UNRESOLVED。
//   - 三态只映射既有 merged/conflict 路径；失败/超时/校验不过 → lane 保持 conflict 终态
//     （merge agent 是冲突化解手段，非 lane 恢复；不新增成员态、不自动 settle）。
//   - fail-closed：spawner 抛错/超时/返回未知 verdict/化解后 orch 仍有在途 merge（U 标记或 MERGE_HEAD 残留）
//     → 一律视同 UNRESOLVED，保留现场走现状 conflict 路径（不挂起不 throw）。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const VERDICT_RESOLVED = 'CONFLICT_RESOLVED';
export const VERDICT_SUCCESS = 'SUCCESS';
export const VERDICT_UNRESOLVED = 'CONFLICT_UNRESOLVED';
const RESOLVED = new Set([VERDICT_RESOLVED, VERDICT_SUCCESS]);
export const NO_SPAWNER_HINT = 'mergeAgent configured but no spawner injected';
const DEFAULT_TIMEOUT_MS = 600_000;
const UNMERGED_RE = /^(UU|AA|DD|AU|UA|DU|UD)\s/; // git status --porcelain 的冲突 XY 标记全集

const gitBin = () => process.env.DSH_GIT_BIN ?? 'git';

// git 调用统一契约（与 lane-tools.runGit 同款；本模块独立持有，避免 lane-tools 行数膨胀）
export function runGit(repo, args) {
  try {
    const out = execFileSync(gitBin(), args, {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    return { ok: true, stdout: String(out ?? '').trim(), stderr: '' };
  } catch (e) {
    const stderr = e?.stderr ? String(e.stderr).trim() : (e?.message ? String(e.message) : String(e));
    return { ok: false, stdout: '', stderr };
  }
}

// HARD 规则（写入 request.instructions，约束 agent 防误合并）
export const HARD_INSTRUCTIONS = [
  'You are the merge agent for an in-flight git merge conflict in the orch worktree.',
  'HARD RULES:',
  '1. Do NOT re-run merge; the merge is already in progress in the orch worktree.',
  '2. Do NOT run `git merge --abort`; the in-flight merge must be completed, never abandoned.',
  '3. Do NOT delete worker implementations unless provably wrong (syntax error / logically impossible); prefer combining both sides.',
  '4. Edit conflict files in the orch worktree, then `git add` them and run `git commit --no-edit` to finish the merge.',
  '5. If you cannot resolve confidently, return CONFLICT_UNRESOLVED — never fabricate.',
].join('\n');

export function buildMergeAgentRequest({ batchId, laneId, orchDir, conflictFiles, branch }) {
  return { batchId, laneId, orchDir, conflictFiles, branch, instructions: HARD_INSTRUCTIONS };
}

// 三态判定（超时/异常/未知 verdict → UNRESOLVED，fail-closed）
export function normalizeVerdict(v) {
  if (RESOLVED.has(v) || v === VERDICT_UNRESOLVED) return v;
  return VERDICT_UNRESOLVED;
}

// 在途 merge 校验辅助：orch git status 无 U 冲突标记 且 无 MERGE_HEAD 残留（化解已 git commit 完成）；
// git 不可查 → { ok:false, conflicted:true } fail-closed（无法证明化解 → 视同未化解）
export function checkInFlightMerge(orchDir) {
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

// 现状 conflict 路径（默认关 / 无 spawner / UNRESOLVED）：保留现场 + files 清单 + conflict 事件；
// hint 非空（无注入降级）时附加清晰提示 note，其余字段逐字保持 doMerge 冲突结果
function statusQuo(opts, hint) {
  const { store, sessionId, batchId, laneId, conflict, conflictFiles } = opts;
  store.appendEvent(sessionId, batchId, 'worktree.merge.conflict', { lane: laneId, files: conflictFiles });
  return hint ? { ...conflict, note: hint } : conflict;
}

// 冲突化解主流程（lane-tools.js 接线点）：默认关 → 现状；启用 + spawner → 化解；
// RESOLVED/SUCCESS 且 orch 在途 merge 校验通过 → 既有成功清理路径（worktree remove + branch -d）+ resolved 事件；
// 其余（UNRESOLVED/抛错/超时/校验不过/无 spawner）→ 现状 conflict 路径（不挂起不 throw，保持终态）
export async function resolveMergeConflict(deps, opts) {
  const config = deps?.config ?? {};
  const ma = config?.capabilities?.worktree?.mergeAgent;
  if (ma?.enabled !== true) return statusQuo(opts, null); // 默认关：零感知，逐字现状
  const spawner = deps?.mergeAgentSpawner ?? config?.host?.spawnMergeAgent ?? null;
  if (typeof spawner !== 'function') return statusQuo(opts, NO_SPAWNER_HINT); // 无注入降级（fail-safe）
  const { store, sessionId, batchId, laneId, orchDir, branch, conflictFiles } = opts;
  const base = path.dirname(orchDir); // <root>/sessions/<sid>/worktrees/<bid> 下平铺 _repo/orch/<laneId>
  const repo = path.join(base, '_repo');
  const lane = path.join(base, laneId);
  const request = buildMergeAgentRequest({ batchId, laneId, orchDir, conflictFiles, branch });
  const timeoutMs = Number.isFinite(ma?.timeoutMs) && ma.timeoutMs > 0 ? ma.timeoutMs : DEFAULT_TIMEOUT_MS;
  let resp;
  try {
    resp = await withTimeout(Promise.resolve().then(() => spawner(request)), timeoutMs);
  } catch {
    return statusQuo(opts, null); // 抛错/超时 → UNRESOLVED → 现状（保留现场）
  }
  const verdict = normalizeVerdict(resp?.verdict);
  if (verdict === VERDICT_UNRESOLVED) return statusQuo(opts, null);
  const check = checkInFlightMerge(orchDir);
  if (!check.ok || check.conflicted) return statusQuo(opts, null); // 校验不过 → 视同 UNRESOLVED（fail-closed）
  // 化解成功：既有成功清理路径（镜像 doMerge 成功分支：worktree remove + prune + branch -d）
  if (fs.existsSync(path.join(lane, '.git'))) runGit(repo, ['worktree', 'remove', '--force', lane]);
  runGit(repo, ['worktree', 'prune']);
  const del = runGit(orchDir, ['branch', '-d', branch]);
  const detail = typeof resp?.detail === 'string' && resp.detail ? resp.detail : '';
  store.appendEvent(sessionId, batchId, 'worktree.merge.resolved', { lane: laneId, files: conflictFiles, verdict, agent: detail || null });
  const note = del.ok
    ? 'resolved by merge agent' + (detail ? ': ' + detail : '')
    : 'branch -d: ' + del.stderr + '; resolved by merge agent';
  return { ok: true, worktreeCleaned: true, branchDeleted: del.ok, note };
}
