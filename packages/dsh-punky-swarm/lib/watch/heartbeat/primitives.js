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

// watch 心跳域**纯函数与常量单点**（【2026-10-02 · 内务批 波 2】随 `createLaneHeartbeat` 巨型函数拆分下沉）：
//   原 `lib/watch/lane-heartbeat.js` 顶层的私有常量与私有纯函数集中本文件，`lane-heartbeat.js` 主体与
//   `heartbeat/*` 各探针档**共用同一份**（禁第二份）。本文件**不持有任何实例状态**（无闭包、无模块级单例）
//   ⇒ 不构成新真源；常量字面值/判据**逐字搬移**（行为零变更）。
// 环依赖说明（A1-P2-01 补丁② 改写，**旧口径已作废**）：
//   本文件位于 `watch/heartbeat/` 的**残余 8 模块 SCC1**（见下「残余环登记」）；它对聚合器的依赖已收窄到
//   **只剩 `stintRunningSinceOf` 一个函数声明**（ESM 实例化期即初始化，本文件顶层不调用它 ⇒ 无 TDZ）。
//   两个状态谓词（`laneStateOf` / `isScannedLaneState`）**直连真源** `../../state/lane-state.js`
//   （`lane-heartbeat.js` 只是它们的再导出点 ⇒ 原来那条「经聚合器取谓词」的边是多余的中转，
//   `watch -> state` 已在 arch 白名单）。
import { findTask } from '../../state/task-utils.js'; // 单点（原本地定义删除）
import * as EVT from '../../state/event-types.js';
import { laneStateOf, isScannedLaneState } from '../../state/lane-state.js'; // 谓词真源（不走聚合器中转）
import { stintRunningSinceOf } from '../lane-heartbeat.js'; // 函数声明：实例化期即初始化 ⇒ 无 TDZ
// A1-P2-01 补丁①：`reason` 常量与 `STATE_WINDOW_KEY` 已下沉到**零依赖叶子** `./reasons.js`
//   （TDZ 根因：`heartbeat/notice.js` 在模块顶层读这些 `const`，而本文件位于 9 模块环内）。
//   此处**保形再导出**（导出面冻结：`lane-heartbeat.js` / `state-surface.js` 等既有消费点逐字不动）。
import {
  REASON_DANGLING_MEMBER, REASON_NOT_SCANNED_PLANNING, REASON_PAUSED_DWELL,
  REASON_PENDING_UNDISPATCHED, REASON_REVIEW_AWAITING_SETTLE, REASON_IDLE_AWAITING_RESUME,
  REASON_BLIND_RUN_NO_DEPS, REASON_BLIND_RUN_UPSTREAM_MISSING, REASON_BLIND_RUN_UPSTREAM_NEVER_READY,
  STATE_WINDOW_KEY,
} from './reasons.js';

// 纯事件流读取（零依赖批次对象）：runningSince（stint 起点）＝最近 member.dispatch 或 member.settled{to:'running'}
function parseEvTs(e) {
  const n = Date.parse(e?.ts ?? '');
  return Number.isFinite(n) ? n : null;
}

// ---- 状态锚点（§2 实现要点 1）：纯事件流反向扫描，返回**与 state 匹配**的最近迁移 ts ----
// 锚点与状态同源（state 现读 batch.lanes[lane]，不缓存）；缺锚点 → null（state 照常透出）。
function stateAnchorOf(batch, lane) {
  const st = laneStateOf(batch, lane);
  if (st === null) return null;
  const evs = batch?.events ?? [];
  if (st === 'running') return stintRunningSinceOf(batch, lane); // = 最近 member.dispatch ∨ member.settled{to:'running'}
  if (st === 'pending') {
    // pending 计时锚点 = 最近 batch.phase→running 事件 ts（**不是** member.dispatch——pending lane 无 dispatch）
    for (let i = evs.length - 1; i >= 0; i--) {
      const e = evs[i];
      if (e?.type !== EVT.EVT_BATCH_PHASE || e?.to !== 'running') continue;
      const ts = parseEvTs(e);
      if (ts !== null) return ts;
    }
    return null;
  }
  if (st === 'review' || st === 'idle') {
    // 最近一次 →review / →idle 迁移事件 ts（member.settled{to} 为主；兼容 member_status 直写镜像的 to 字段）
    for (let i = evs.length - 1; i >= 0; i--) {
      const e = evs[i];
      if (e?.lane !== lane) continue;
      if (e?.type !== EVT.EVT_MEMBER_SETTLED && e?.type !== EVT.EVT_MEMBER_DISPATCH) continue;
      if (e?.to !== st) continue;
      const ts = parseEvTs(e);
      if (ts !== null) return ts;
    }
    return null;
  }
  return null; // 其余态（终态/未知）无时间判据 ⇒ 无锚点
}
// 批次档锚点：最近 batch.phase→paused（paused 档的先判锚点）
function batchPausedAnchorOf(batch) {
  const evs = batch?.events ?? [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e?.type !== EVT.EVT_BATCH_PHASE || e?.to !== 'paused') continue;
    const ts = parseEvTs(e);
    if (ts !== null) return ts;
  }
  return null;
}

function laneConsumePathsOf(batch, lane) {
  const t = findTask(batch, lane);
  if (!t) return []; // wavePlan 缺该项 ⇒ 零观测面（BR-1/BR-3 反例；不存在即「不可判」而非「可判为真」）
  return Array.isArray(t.consume) ? t.consume.filter((p) => typeof p === 'string' && p) : [];
}

export {
  REASON_DANGLING_MEMBER, REASON_NOT_SCANNED_PLANNING, REASON_PAUSED_DWELL,
  REASON_PENDING_UNDISPATCHED, REASON_REVIEW_AWAITING_SETTLE, REASON_IDLE_AWAITING_RESUME,
  REASON_BLIND_RUN_NO_DEPS, REASON_BLIND_RUN_UPSTREAM_MISSING, REASON_BLIND_RUN_UPSTREAM_NEVER_READY,
  STATE_WINDOW_KEY,
  parseEvTs, isScannedLaneState, stateAnchorOf, batchPausedAnchorOf, laneConsumePathsOf,
};
