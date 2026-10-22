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

// 心跳探针 `reason` 常量与状态阈值键映射的**无环叶子**（A1-P2-01 补丁①）：
//   本文件**零 import**（唯一一条「谁都依赖、谁都不被依赖」的叶子）⇒ 任何模块在**模块顶层**读它都安全。
//   为什么必须单独成文件：原实装住在 `heartbeat/primitives.js`，而 `primitives` 反向依赖聚合器
//   `../lane-heartbeat.js` ⇒ `primitives` 落在一个 9 模块环内；`heartbeat/notice.js` 在**模块顶层**
//   用这些 `const` 构造 `Set`，一旦首求值入口是 `primitives` 就会读到尚未初始化的绑定
//   ⇒ `ReferenceError: Cannot access 'REASON_BLIND_RUN_UPSTREAM_NEVER_READY' before initialization`
//   （TDZ，栈顶 `notice.js`）。把这些常量搬到零依赖叶子上，环内模块的顶层读就不再跨环。
//   字面值**逐字搬移**（行为零变更）；`heartbeat/primitives.js` 保留保形再导出（导出面冻结）。
//   消费方纪律：顶层读 `reason` 常量的模块（如 `notice.js`）**一律直连本文件**，不要再经 `primitives`。

const REASON_DANGLING_MEMBER = 'dangling-member';
const REASON_NOT_SCANNED_PLANNING = 'not-scanned-planning';
const REASON_PAUSED_DWELL = 'paused-awaiting-decision';
const REASON_PENDING_UNDISPATCHED = 'pending-undispatched';
const REASON_REVIEW_AWAITING_SETTLE = 'review-awaiting-settle';
const REASON_IDLE_AWAITING_RESUME = 'idle-awaiting-resume';
const REASON_BLIND_RUN_NO_DEPS = 'blind-run-no-deps';
const REASON_BLIND_RUN_UPSTREAM_MISSING = 'blind-run-upstream-missing';
const REASON_BLIND_RUN_UPSTREAM_NEVER_READY = 'blind-run-upstream-never-ready';
// 状态 → 专属阈值键（§2 判据分派表单点；查询面复算与探针判定共用同一映射，禁两套表）
const STATE_WINDOW_KEY = { pending: 'pendingWindowMs', review: 'reviewWindowMs', idle: 'idleWindowMs', paused: 'pausedWindowMs' };

export {
  REASON_DANGLING_MEMBER, REASON_NOT_SCANNED_PLANNING, REASON_PAUSED_DWELL,
  REASON_PENDING_UNDISPATCHED, REASON_REVIEW_AWAITING_SETTLE, REASON_IDLE_AWAITING_RESUME,
  REASON_BLIND_RUN_NO_DEPS, REASON_BLIND_RUN_UPSTREAM_MISSING, REASON_BLIND_RUN_UPSTREAM_NEVER_READY,
  STATE_WINDOW_KEY,
};
