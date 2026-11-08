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

// @ts-check

// lib/state/event-types.js —— 批次事件 type 常量单点：newEvent 调用与事件推导一律引用本模块常量，禁止裸字面量。
// 零依赖纯常量模块：不 import 任何本包模块（避免循环依赖）。
// 纪律：新增事件类型须在本文件登记常量后于调用点引用，禁止散布裸字面量。

export const EVT_BATCH_CREATED = 'batch.created';
export const EVT_BATCH_PHASE = 'batch.phase';
export const EVT_BATCH_FAILED_ESCALATE = 'batch.failed-escalate';
//   载荷：`{ danglingLanes: [laneId...], count }`（载荷键纪律：`type` 键承载**事件名**，载荷**不得**占用它）。
export const EVT_BATCH_ABORT_DANGLING = 'batch.abort_dangling';
export const EVT_BATCH_MANAGER_RAISED = 'batch.manager.raised';
//   载荷：`{ batchId }`（载荷键纪律：`type` 键承载事件名，载荷不得占用）。
export const EVT_BATCH_SMOKE = 'batch.smoke';
export const EVT_ARCHIVE_FAILED = 'archive.failed';
export const EVT_ARCHIVE_DONE = 'archive.done';
export const EVT_SYSTEM_RECOVERED = 'system.recovered';
export const EVT_SYSTEM_RESTORED = 'system.restored';

export const EVT_MEMBER_SETTLED = 'member.settled';
export const EVT_MEMBER_DISPATCH = 'member.dispatch';
export const EVT_LANE_SKIPPED = 'lane.skipped';
export const EVT_LANE_NEEDHUMAN = 'lane.needhuman';
export const EVT_LANE_RECYCLED = 'lane.recycled';
export const EVT_HUMAN_DECISION = 'human.decision';
export const EVT_ASSET_CLAIMED = 'asset.claimed';

export const EVT_LANE_STALLED = 'lane.stalled';
export const EVT_LANE_LONGRUN_CANDIDATE = 'lane.longrun.candidate';
// **不得**用 readUnacked——ack 默认删原消息文件，会把「已消费」读成「不存在」→ 永久误报）→ 产本事件。
export const EVT_LANE_LONGRUN_UNCONSUMED = 'lane.longrun.unconsumed';
export const EVT_GATE_MANAGER_ROSTER_GAP = 'gate.manager_roster_gap';
// 载荷键纪律：`newEvent(type, fields)` 的 `type` 键承载**事件名**（本文件常量），载荷字段**不得**占用它——
export const EVT_LANE_EXEMPT_GRANTED = 'lane.exempt.granted';
//  `exemptClearedAtOf` 按同一字面量反查 ⇒ 改值即静默断链，属红线）。
export const EVT_LANE_EXEMPT_INHERITED = 'lane.exempt.inherited';
export const EVT_LANE_EXEMPT_CLEARED = 'lane.exempt.cleared';
export const EVT_LANE_OVER_BUDGET = 'lane.over-budget';
export const EVT_LANE_CHECKPOINT_TOTAL_MISMATCH = 'lane.checkpoint.total.mismatch';
export const EVT_BUDGET_REJECTED = 'budget.rejected';
// inject.omitted 与上方两枚**语义正交、不得混用**：上方两枚分别属「步数预算」与「mailbox 链环防护」
export const EVT_INJECT_OMITTED = 'inject.omitted';
export const EVT_MEMORY_STALE_RECOMMENDED = 'memory.stale.recommended';
export const EVT_WORKTREE_CREATED = 'worktree.created';
export const EVT_WORKTREE_CHECKPOINT = 'worktree.checkpoint';
export const EVT_WORKTREE_MERGED = 'worktree.merged';
export const EVT_WORKTREE_MERGE_CONFLICT = 'worktree.merge.conflict';
export const EVT_WORKTREE_MERGE_RESOLVED = 'worktree.merge.resolved';

export const EVT_GATE_ENTRY_MISSING = 'gate.entry.missing';
export const EVT_GATE_EXIT_MISSING = 'gate.exit.missing';
export const EVT_GATE_PASSED = 'gate.passed';
export const EVT_GATE_TARGET_BLOCKED = 'gate.target_blocked';
export const EVT_GATE_TARGET_PASSED = 'gate.target.passed';

//   （唯一写路径内，与 `batch.handoffs` 同一次 atomicWrite ⇒ 「交了」与「记了」不可分叉）。
//   故批 id 写 `handoffBatch`（不得占用 `type`；引擎多处按 `e.type` 读事件名，占用即失名）。
export const EVT_LANE_HANDOFF = 'lane.handoff';
export const EVT_LANE_HANDOFF_GAP = 'lane.handoff.gap';

export const EVT_SWARM_REPORT = 'swarm.report';
export const EVT_SWARM_CC = 'swarm.cc';
export const EVT_LANE_BINDING_GAP = 'lane.binding_gap';
export const EVT_GATE_EXIT_BLOCKED = 'gate.exit_blocked';
export const EVT_GATE_EXIT = 'gate.exit';
export const EVT_GATE_NEEDHUMAN_BLOCKED = 'gate.needhuman_blocked';
export const EVT_GATE_COMPLETE_BLOCKED = 'gate.complete_blocked';
//   高并发不得被限流）。
export const EVT_GATE_CONCURRENCY_BLOCKED = 'gate.concurrency_blocked';
export const EVT_GATE_ROLE_INVALID = 'gate.role_invalid';
export const EVT_GATE_COMPLETE_OUTCOMES_EMPTY = 'gate.complete_outcomes_empty';

//     `checkPlanContract` 调用，故该边界必须由「只产载荷」结构性保证，而非调用点自觉）；
export const EVT_GATE_CONTRACT_MISSING = 'gate.contract_missing';

export const EVT_GOVERNANCE_REFUSAL = 'governance.refusal';
export const EVT_BATCH_GOVERNANCE_ESCALATE = 'batch.governance-escalate';

export const EVT_GATE_ESCAPE = 'gate.escape';
export const EVT_GATE_DEGRADE = 'gate.degrade';

export const EVT_AUTO_SETTLE_TRIGGERED = 'auto.settle.triggered';
export const EVT_AUTO_SETTLE_PAUSED = 'auto.settle.paused';
export const EVT_AUTO_SETTLE_SKIPPED = 'auto.settle.skipped';

export const EVT_TASK_OWNER_ASSIGNED = 'task.owner.assigned';

export const EVT_PLAN_MUTATED = 'plan.mutated';


//   `type` 键承载事件名，载荷字段**不得**占用它（同既有约定）。
export const EVT_GATE_CONSUME_DEPS_ASYMMETRY = 'gate.consume_deps_asymmetry';

export const EVT_PREFLIGHT_REPORT_MISSING = 'gate.preflight.report.missing';
