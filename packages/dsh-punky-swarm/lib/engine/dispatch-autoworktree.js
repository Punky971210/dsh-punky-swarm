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

// lane worktree 自动创建（批 `punky-checkpoint-enforce-20261112` · lane `e2-gate`；spec §R-5 表 A1）
//
// 为什么在**派发前**尝试建：声明了 `subtasks` 的 exec lane 每完成一项都要 `lane_checkpoint`；
//   有 worktree 才有真 commit 可审计（`git log` 内嵌 `step N/total`）。没有 worktree 时 B1 的降级路径
//   仍能留痕（`commit=null`），但那只是**兜底**，不是**默认**。
//
// 两条口径（用户裁决 / spec §R-5 X-6 反证）：
//   ① 失败**告警不拒派**：拒态会让「非 git 工作区 / 沙箱 / 无 git 宿主」的 exec 批完全不可派；
//      强制对象是**留痕**，不是 **git** ⇒ 失败落 `worktree.autocreate.failed`（带 `code` + `reason`）后继续派发。
//   ② 失败点必须在 `store.setMember(running)` **之前**（调用点 = `lane_dispatch.execute` 内 `dispatchLaneCore` 之前）
//      ⇒ lane 仍 `pending`、无句柄、无 `member.dispatch`、批相位不变 ⇒ **无状态可回滚**；
//      worktree 侧残留由 `createLaneWorktree` 自带幂等（已注册复用 / 残留先清理重建）承担。
//
// 单点纪律（spec §X-8）：git 操作**只许**复用 `lib/tools/lane-worktree-ops.js` 的
//   `ensureRepo` / `ensureOrch` / `createLaneWorktree`（禁第二套 git 实现）；事件名取 `state/event-types.js` 常量。
import * as EVT from '../state/event-types.js';
import { dialectOf, declaredSubtasksOf } from '../state/resume.js';
import { runGit } from '../tools/git-utils.js';
import { ensureRepo, ensureOrch, createLaneWorktree } from '../tools/lane-worktree-ops.js';

const SUBTASKS_DIALECT = 'subtasks';

/**
 * 自动建 worktree（**仅** exec + subtasks 方言 + 声明非空三条同时成立才触发）。
 * @param {object} input
 * @param {string} input.root         引擎根（`<root>/sessions/<sessionId>/worktrees/<batchId>/<laneId>`）
 * @param {string} input.sessionId
 * @param {string} input.batchId
 * @param {string} input.lane
 * @param {object|null} input.laneTask 该 lane 的 wavePlan task（取 `layer`）
 * @param {object} input.batch        已读批次（取方言与声明；本函数不改它）
 * @param {object} input.store        store（只用于 `appendEvent`）
 * @param {object} [input.logger]
 * @returns {{attempted:boolean, ok:boolean, skipped?:string, code?:string, reason?:string, worktree?:string, branch?:string, reused?:boolean}}
 *   **恒不抛**：任何异常都被折算成 `{attempted:true, ok:false, code:'GATE_WORKTREE_AUTOCREATE_FAILED'}` + 事件 + 告警。
 */
export function maybeAutoCreateWorktree({ root, sessionId, batchId, lane, laneTask = null, batch = null, store, logger = null } = {}) {
  // 触发面（spec §R-5 A1 判据 ①②③）：任何一条不成立 ⇒ 零动作、零事件（V-25「不误触」的判据面）。
  if ((laneTask?.layer ?? null) !== 'exec') return { attempted: false, ok: true, skipped: 'layer-not-exec' };
  if (dialectOf(batch) !== SUBTASKS_DIALECT) return { attempted: false, ok: true, skipped: 'legacy-dialect' };
  if (declaredSubtasksOf(batch, lane).length === 0) return { attempted: false, ok: true, skipped: 'no-subtasks' };
  try {
    ensureRepo(root, sessionId, batchId);
    const { orch } = ensureOrch(root, sessionId, batchId);
    const { dir, branch, reused, reason } = createLaneWorktree(root, sessionId, batchId, lane);
    const base = runGit(orch, ['rev-parse', 'HEAD']);
    store.appendEvent(sessionId, batchId, EVT.EVT_WORKTREE_CREATED, {
      lane, worktree: dir, branch, auto: true, reused,
      base: base.ok ? base.stdout : null,
    });
    return { attempted: true, ok: true, worktree: dir, branch, reused, reason: reason ?? (reused ? 'reused' : 'created') };
  } catch (e) {
    const reason = String(e?.message ?? e);
    try {
      store.appendEvent(sessionId, batchId, EVT.EVT_WORKTREE_AUTOCREATE_FAILED, {
        lane, code: 'GATE_WORKTREE_AUTOCREATE_FAILED', reason,
      });
    } catch (appendErr) {
      // 事件落不下也不得改变派发准入（本模块恒不拒派）；至少留一条告警。
      logger?.warn?.('[lane_dispatch] worktree.autocreate.failed 事件落盘失败（不阻断派发）: ' + String(appendErr?.message ?? appendErr));
    }
    logger?.warn?.('[lane_dispatch] 自动建 lane worktree 失败（告警不拒派；checkpoint 将走 commit=null 的降级留痕路径）: lane='
      + lane + ' · ' + reason);
    return { attempted: true, ok: false, code: 'GATE_WORKTREE_AUTOCREATE_FAILED', reason };
  }
}
