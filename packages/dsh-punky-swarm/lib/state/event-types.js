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

// lib/state/event-types.js —— 批次事件 type 常量单点（P2-07 收敛）
// 零依赖纯常量模块：不 import 任何本包模块（避免循环依赖）。
// 事实源 = store.js newEvent 工厂调用点（原裸字面量，2026-08-28 P2-07 收敛）：
//   新增事件类型须在本文件登记常量后于 store.js 引用，禁止散布裸字面量。
// 本批只收敛 store.js 域（newEvent 调用 type 全常量）；其他文件事件字面量
//   （lane-heartbeat 'lane.stalled' 等，经 appendEvent 发事件）分布已记录，未扩面。

// 批次生命周期
export const EVT_BATCH_CREATED = 'batch.created';
export const EVT_BATCH_PHASE = 'batch.phase';
export const EVT_BATCH_FAILED_ESCALATE = 'batch.failed-escalate';
export const EVT_ARCHIVE_FAILED = 'archive.failed';
export const EVT_SYSTEM_RECOVERED = 'system.recovered';

// 成员迁移
export const EVT_MEMBER_SETTLED = 'member.settled';
export const EVT_LANE_SKIPPED = 'lane.skipped';
export const EVT_LANE_NEEDHUMAN = 'lane.needhuman';
export const EVT_LANE_RECYCLED = 'lane.recycled';
export const EVT_HUMAN_DECISION = 'human.decision';
export const EVT_ASSET_CLAIMED = 'asset.claimed';

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
