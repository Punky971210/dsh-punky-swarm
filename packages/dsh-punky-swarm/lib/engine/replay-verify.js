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

// 【单点复用】成员态合法值集合与终态判定**一律引** `lib/schema.js`（`MEMBER_STATES` /
//   `isMemberTerminal` / `BATCH_TRANSITIONS`），本模块**不另立字面量表**（禁第二套真源）。

import { MEMBER_STATES, BATCH_TRANSITIONS } from '../schema.js';

const EVT_MEMBER_SETTLED = 'member.settled';
const EVT_BATCH_PHASE = 'batch.phase';

const INITIAL_LANE_STATE = MEMBER_STATES[0];
const INITIAL_BATCH_PHASE = Object.keys(BATCH_TRANSITIONS)[0];

function foldableEvents(events) {
  return Array.isArray(events) ? events : [];
}

/**
 * @param {unknown} events 批次内嵌事件流
 * @returns {Record<string, string>} laneId → 推导末态
 */
export function laneStatesViewOf(events) {
  const view = {};
  for (const ev of foldableEvents(events)) {
    if (ev === null || typeof ev !== 'object') continue;
    if (ev.type !== EVT_MEMBER_SETTLED) continue;
    const lane = ev.lane;
    if (typeof lane !== 'string' || lane.length === 0) continue;
    if (typeof ev.to !== 'string' || ev.to.length === 0) continue;
    view[lane] = ev.to;
  }
  return view;
}

/**
 * @param {unknown} events 批次内嵌事件流
 * @returns {string} 推导相位
 */
export function phaseViewOf(events) {
  let phase = INITIAL_BATCH_PHASE;
  for (const ev of foldableEvents(events)) {
    if (ev === null || typeof ev !== 'object') continue;
    if (ev.type !== EVT_BATCH_PHASE) continue;
    if (typeof ev.to !== 'string' || ev.to.length === 0) continue;
    phase = ev.to;
  }
  return phase;
}

/**
 * **`ok` 语义（fail-closed）**：`degraded` 出现时 `ok` **恒 `false`**——`ok` 同时吃「有无可比信息」与
 * 「有无差异」两个谓词；退化谓词**单点定义**（下方 `degraded` 变量），`ok` 与 `degraded` 标注共用同一值，
 * 禁在比较处另写一遍（禁第二套真源）。
 */
export function replayVerifyVerdict(batch) {
  const events = batch !== null && typeof batch === 'object' && Array.isArray(batch.events) ? batch.events : null;
  const scanned = events === null ? [] : events;

  const lanesView = laneStatesViewOf(events);
  const phaseView = phaseViewOf(events);

  const stateLanes = batch !== null && typeof batch === 'object' && batch.lanes !== null && typeof batch.lanes === 'object'
    ? batch.lanes
    : {};
  const statePhase = batch !== null && typeof batch === 'object' && typeof batch.phase === 'string' ? batch.phase : null;

  const laneNames = [...new Set([...Object.keys(stateLanes), ...Object.keys(lanesView)])].sort();
  const laneDiffs = [];
  for (const lane of laneNames) {
    const stateFile = Object.hasOwn(stateLanes, lane) ? stateLanes[lane] : null;
    const fromEvents = Object.hasOwn(lanesView, lane) ? lanesView[lane] : INITIAL_LANE_STATE;
    if (stateFile !== fromEvents) laneDiffs.push({ lane, stateFile, fromEvents });
  }

  const phaseDiff = statePhase !== null && statePhase !== phaseView ? { stateFile: statePhase, fromEvents: phaseView } : null;
  const degraded = events === null || events.length === 0;
  const verdict = {
    ok: !degraded && laneDiffs.length === 0 && phaseDiff === null,
    laneDiffs,
    phaseDiff,
    eventsScanned: scanned.length,
    lanesView,
    phaseView,
  };
  if (degraded) verdict.degraded = 'no-events';
  return verdict;
}
