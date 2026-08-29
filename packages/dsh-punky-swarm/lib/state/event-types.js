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

// lib/state/event-types.js —— 批次事件 type 常量单点（P2-07 收敛 + P1 批 R-01 全量扩面）
// 零依赖纯常量模块：不 import 任何本包模块（避免循环依赖）。
// 事实源 = store.js newEvent 工厂调用点（原裸字面量，2026-08-28 P2-07 收敛）+ R-01 扩面：
//   R-01（2026-08-29，p1list 批）把 appendEvent/events.push 发端字面量全量收拢进本文件——
//   resume/archive/lane-heartbeat/lane-tools/mailbox-tools/merge-agent/core 的写事件
//   （system.restored/archive.done/lane.stalled/lane.over-budget/worktree.*/budget.rejected/gate.role_*）
//   全部改引常量；读端（gates/store/resume/log-tools/lane-tools 的 e.type 比较）同步收敛（R-07）。
// 纪律：新增事件类型须在本文件登记常量后于调用点引用，禁止散布裸字面量。

// 批次生命周期
export const EVT_BATCH_CREATED = 'batch.created';
export const EVT_BATCH_PHASE = 'batch.phase';
export const EVT_BATCH_FAILED_ESCALATE = 'batch.failed-escalate';
export const EVT_ARCHIVE_FAILED = 'archive.failed';
export const EVT_ARCHIVE_DONE = 'archive.done'; // R-01 扩面（archive.js:161 发端）
export const EVT_SYSTEM_RECOVERED = 'system.recovered';
export const EVT_SYSTEM_RESTORED = 'system.restored'; // R-01 扩面（resume.js:105 eventType 缺省）

// 成员迁移
export const EVT_MEMBER_SETTLED = 'member.settled';
export const EVT_LANE_SKIPPED = 'lane.skipped';
export const EVT_LANE_NEEDHUMAN = 'lane.needhuman';
export const EVT_LANE_RECYCLED = 'lane.recycled';
export const EVT_HUMAN_DECISION = 'human.decision';
export const EVT_ASSET_CLAIMED = 'asset.claimed';

// 监控/预算/进度事件（R-01 扩面）
export const EVT_LANE_STALLED = 'lane.stalled'; // R-01 扩面（lane-heartbeat.js:188 发端 + store.js:530 读端）
export const EVT_LANE_OVER_BUDGET = 'lane.over-budget'; // R-01 扩面（lane-tools.js:346 发端 + resume.js:179 读端）
export const EVT_BUDGET_REJECTED = 'budget.rejected'; // R-01 扩面（mailbox-tools.js:79 发端 + log-tools.js:53 读端）
export const EVT_WORKTREE_CREATED = 'worktree.created'; // R-01 扩面（lane-tools.js:278 发端）
export const EVT_WORKTREE_CHECKPOINT = 'worktree.checkpoint'; // R-01 扩面（lane-tools.js:338 发端 + :393 读端）
export const EVT_WORKTREE_MERGED = 'worktree.merged'; // R-01 扩面（lane-tools.js:441 发端）
export const EVT_WORKTREE_MERGE_CONFLICT = 'worktree.merge.conflict'; // R-01 扩面（merge-agent.js:87 发端）
export const EVT_WORKTREE_MERGE_RESOLVED = 'worktree.merge.resolved'; // R-01 扩面（merge-agent.js:121 发端）

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
export const EVT_GATE_ROLE_MISSING = 'gate.role_missing'; // R-01 扩面（core.js:123 发端）
export const EVT_GATE_ROLE_INVALID = 'gate.role_invalid'; // R-01 扩面（core.js:123 发端）
