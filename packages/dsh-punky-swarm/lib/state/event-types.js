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

// lib/state/event-types.js —— 批次事件 type 常量单点：newEvent 调用与事件推导一律引用本模块常量，禁止裸字面量。
// 零依赖纯常量模块：不 import 任何本包模块（避免循环依赖）。
// 事实源 = store.js newEvent 工厂调用点（原裸字面量）——
//   resume/archive/lane-heartbeat/lane-tools/mailbox-tools/merge-agent/core 的写事件
//   （system.restored/archive.done/lane.stalled/lane.over-budget/worktree.*/budget.rejected/gate.role_*）
//   全部改引常量；读端（gates/store/resume/log-tools/lane-tools 的 e.type 比较）同步收敛。
// 纪律：新增事件类型须在本文件登记常量后于调用点引用，禁止散布裸字面量。

// 批次生命周期
export const EVT_BATCH_CREATED = 'batch.created';
export const EVT_BATCH_PHASE = 'batch.phase';
export const EVT_BATCH_FAILED_ESCALATE = 'batch.failed-escalate';
export const EVT_ARCHIVE_FAILED = 'archive.failed';
export const EVT_ARCHIVE_DONE = 'archive.done';
export const EVT_SYSTEM_RECOVERED = 'system.recovered';
export const EVT_SYSTEM_RESTORED = 'system.restored';

// 成员迁移
export const EVT_MEMBER_SETTLED = 'member.settled';
// 派发登记事件：装配层 post-execute 观察 Manager 派发工具 → 写侧登记（member.dispatch，
// 见 bridge/dispatch-register.js）；读侧（trajectory.js 原本地字面量）同步收敛为本常量。
export const EVT_MEMBER_DISPATCH = 'member.dispatch';
export const EVT_LANE_SKIPPED = 'lane.skipped';
export const EVT_LANE_NEEDHUMAN = 'lane.needhuman';
export const EVT_LANE_RECYCLED = 'lane.recycled';
export const EVT_HUMAN_DECISION = 'human.decision';
export const EVT_ASSET_CLAIMED = 'asset.claimed';

// 监控/预算/进度事件
export const EVT_LANE_STALLED = 'lane.stalled';
// longrun 档：lane 超时重派探针候选事件——running 持续超 maxDurationMs 且
// 近 noProgressWindowMs 无新 checkpoint 且无活动（严格 AND）→ 探针产候选（事件 + mailbox broadcast 通知 Manager 裁决）。
// 与 lane.stalled 语义区分：stalled=连续 N 拍无活动（失联/假死档）；longrun=时长超阈值+无进展（任务过重/停滞档）。
// 纪律同 stalled：只写事件流不改 lane 状态（schema.js MEMBER_STATES/TRANSITIONS 零改动）。
export const EVT_LANE_LONGRUN_CANDIDATE = 'lane.longrun.candidate';
export const EVT_LANE_OVER_BUDGET = 'lane.over-budget';
export const EVT_BUDGET_REJECTED = 'budget.rejected';
export const EVT_WORKTREE_CREATED = 'worktree.created';
export const EVT_WORKTREE_CHECKPOINT = 'worktree.checkpoint';
export const EVT_WORKTREE_MERGED = 'worktree.merged';
export const EVT_WORKTREE_MERGE_CONFLICT = 'worktree.merge.conflict';
export const EVT_WORKTREE_MERGE_RESOLVED = 'worktree.merge.resolved';

// 门禁事件（Tier3）
export const EVT_GATE_ENTRY_MISSING = 'gate.entry.missing';
export const EVT_GATE_EXIT_MISSING = 'gate.exit.missing';
export const EVT_GATE_PASSED = 'gate.passed';
export const EVT_GATE_TARGET_BLOCKED = 'gate.target_blocked';
export const EVT_GATE_TARGET_PASSED = 'gate.target.passed';
export const EVT_GATE_EXIT_BLOCKED = 'gate.exit_blocked';
export const EVT_GATE_EXIT = 'gate.exit';
export const EVT_GATE_NEEDHUMAN_BLOCKED = 'gate.needhuman_blocked';
export const EVT_GATE_COMPLETE_BLOCKED = 'gate.complete_blocked';
export const EVT_GATE_ROLE_MISSING = 'gate.role_missing';
export const EVT_GATE_ROLE_INVALID = 'gate.role_invalid';

// 治理违规计数：EVT_GOVERNANCE_REFUSAL 为可计入事件（recordGovernanceRefusal 追加、
// countGovernanceRefusals 纯函数读端）；EVT_BATCH_GOVERNANCE_ESCALATE 为升级事件
// （计数达阈值经棘轮后批 paused）。
// 登记纪律：先登记常量后于调用点引用（见本文件头注释）。
export const EVT_GOVERNANCE_REFUSAL = 'governance.refusal';
export const EVT_BATCH_GOVERNANCE_ESCALATE = 'batch.governance-escalate';
