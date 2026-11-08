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

// watch 域 · 门面与装配：`createLaneHeartbeat`（唯一对外构造入口）+ 对外 re-export。
// 判定逻辑已下沉 `heartbeat/verdict.js` / `heartbeat/judge.js`（⑨-2：拆掉 5 个循环 import）。

import * as schema from '../schema.js';
import { createHeartbeatContext } from './heartbeat/context.js';
import { probeTick } from './heartbeat/stalled.js';
import { longrunStatusOf } from './heartbeat/longrun.js';
import { laneStatusOf, resetLane, disposeEngine, replayInFlightOf } from './heartbeat/state-surface.js';

export function createLaneHeartbeat({ store, mailbox, config, root, now, liveConfig, logger }) {
  // 闭包上下文 `cx`：承载原闭包内共享变量（cfg/lrCfg/schedule/hardStop/clock/engineRoot/ctxOf/state
  //   + disposed/replayInFlight 两个可变位），**每引擎实例一份**——不得提升为模块级单例（纪律：不新增真源）。
  const cx = createHeartbeatContext({ store, mailbox, config, root, now, liveConfig, logger });
  // 各探针档从**同一 `cx`** 取值；返回键序 = 拆分前 `return { ... }` 的键序（行为零变更）。
  //   薄包装保持原签名与形参表（arity 逐字不变）：tick（stalled 档，内嵌 longrun 扫描与重放兜底）/
  //   status / reset / dispose / longrunStatus / replayInFlight。
  function tick() { return probeTick(cx); }
  function status(laneKey, ctx = null) { return laneStatusOf(cx, laneKey, ctx); }
  function reset(laneKey) { return resetLane(cx, laneKey); }
  function dispose() { return disposeEngine(cx); }
  function longrunStatus(sessionId, batchId, lane, nowTs) { return longrunStatusOf(cx, sessionId, batchId, lane, nowTs); }
  function replayInFlight() { return replayInFlightOf(cx); }
  return { tick, status, reset, dispose, longrunStatus, replayInFlight };
}

function laneIdsFor(batch, only) {
  const all = Object.keys(batch.lanes ?? {});
  if (only) return [only];
  if (schema.isBatchTerminal(batch.phase)) return all;
  return all.filter((l) => !schema.isMemberTerminal(batch.lanes[l]));
}

// ── 对外导出面：拆分前即这 20 个，语义/名称零改（消费者零改动的唯一前提）──
//   `laneStateOf` / `isScannedLaneState` / `isDanglingLane` 的真源是 `../state/lane-state.js`（W4 拆环）。
export {
  LONGRUN_DEFAULTS,
  LONGRUN_REASON,
  LONGRUN_REASON_EXEMPT_ACTIVE,
  bindingGapOf,
  buildSchedule,
  exemptClearedAtOf,
  hasLongrunCandidate,
  hasLongrunUnconsumed,
  isStaleBatch,
  lastCheckpointTsOf,
  lastEventTsOf,
  lastProgressTsOf,
  longrunCandidateOf,
  resolveLongrunConfig,
} from './heartbeat/verdict.js';
export { stintRunningSinceOf } from './heartbeat/primitives.js';
export { judgeLongrun } from './heartbeat/judge.js';
export { laneStateOf, isScannedLaneState, isDanglingLane } from '../state/lane-state.js';
