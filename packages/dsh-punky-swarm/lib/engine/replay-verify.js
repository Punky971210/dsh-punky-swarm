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

// engine/replay-verify.js —— **事件重放校验腿**（只读校验面；纯函数、零 I/O、零副作用）
// ─────────────────────────────────────────────────────────────────────────────
// 【是什么】从批次 JSON **内嵌的 `events[]`** 反向推导两份视图，再与状态文件申报值逐项比对：
//   · `laneStatesViewOf(events)` —— lane 末态视图（折叠 `member.settled`，同 lane 取**最后一次 `to`**）
//   · `phaseViewOf(events)`      —— 批次相位视图（基线 `planning`，折叠 `batch.phase` 取最后 `to`）
//   比对结论由 `replayVerifyVerdict(batch)` 给出（**仅差异项**；差异只作观察，不构成任何门禁判定）。
// 【为什么另起一模块】`lib/engine/replay.js` 是**链推进重放**的退役空壳（`reason:'retired'`），
//   被 `test/replay-recovery.test.js`（R-1..R-5）逐字段钉住，且有两处写域外调用点 ⇒ **零触碰**；
//   本模块与它**无任何代码/导入关系**（不复用、不导出同符号、不改其导出面）。
// 【只读性第一性】本模块**不读盘、不写盘、不发射事件、不改任何状态**，也**不改入参**（可纯单测）。
//   事件流真源始终是状态文件自身；本模块只产「投影视图 + 差异清单」，供诊断产物承载。
// 【单点复用】成员态合法值集合与终态判定**一律引** `lib/schema.js`（`MEMBER_STATES` /
//   `isMemberTerminal` / `BATCH_TRANSITIONS`），本模块**不另立字面量表**（禁第二套真源）。
// 【禁 throw（fail-safe）】`events` 缺失 / 非数组 / 空 ⇒ 不抛，返回 `eventsScanned:0` + 空差异
//   + `degraded:'no-events'`（退化可判读，不静默、不拒态）。

import { MEMBER_STATES, BATCH_TRANSITIONS, isMemberTerminal } from '../schema.js';

// ── 事件类型字面量（**只读匹配用**，非发射面）─────────────────────────────────
// 取值依据（直读锚点）：
//   · `member.settled` 写端 = `lib/state/store/member.js:220`（载荷 `{lane, from, to, note}`；条件自动跳过同形状 = `:115`）
//   · `batch.phase`    写端 = `lib/state/store/member-gates.js:155`（载荷 `{from, to, reason?}`）
// 本模块**不新增事件常量**（`lib/state/event-types.js` 不由本 lane 写）、**不发射任何事件**；
// 下方两枚仅是「读事件流时按 type 匹配」的本地匹配串。
const EVT_MEMBER_SETTLED = 'member.settled';
const EVT_BATCH_PHASE = 'batch.phase';

// 视图缺省值 —— 均**派生自单点**，禁在比较处另立字面量：
//   · 无该 lane 任何 `member.settled` ⇒ 建批播种态（`createBatch` 按 wavePlan 种 `MEMBER_STATES[0]`）
//   · 无任何 `batch.phase` 事件 ⇒ 批次起点（`BATCH_TRANSITIONS` 的键序首项，建批缺省 phase）
const INITIAL_LANE_STATE = MEMBER_STATES[0];
const INITIAL_BATCH_PHASE = Object.keys(BATCH_TRANSITIONS)[0];

/** 事件流是否为可折叠数组（缺失 / 非数组 / 空 一律视为「无可折叠事件」）。 */
function foldableEvents(events) {
  return Array.isArray(events) ? events : [];
}

/**
 * lane 末态视图：按 `events[]` **顺序**折叠 `member.settled`，同 lane 取**最后一次 `to`**。
 * 无该 lane 任何 `member.settled` ⇒ 视图值 = 建批播种态（`MEMBER_STATES[0]`）。
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
    view[lane] = ev.to; // 顺序折叠 ⇒ 后写覆盖前写 = 取最后一次
  }
  return view;
}

/**
 * 批次相位视图：基线 = `BATCH_TRANSITIONS` 键序首项（`planning`），按顺序折叠 `batch.phase` 取最后 `to`。
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
 * 重放校验裁决：比对「状态文件申报值」与「事件流推导值」，**只列差异**。
 *
 * 返回形状：
 * ```
 * { ok, laneDiffs[], phaseDiff, eventsScanned, lanesView, phaseView, degraded? }
 *   laneDiffs[] 项 = { lane, stateFile, fromEvents }   // 仅差异项；零差异 ⇒ []
 *   phaseDiff      = { stateFile, fromEvents } | null
 *   degraded       = 'no-events'（`events` 缺失 / 非数组 / 空时出现）
 * ```
 * 比对面 = **状态文件 lane 名单 ∪ 事件流推导 lane 名单**：仅事件流里出现的 lane（孤儿）也列入比对
 * （其 `stateFile` 取 `null`，即「事件流申报存在、状态文件无此 lane」的差异可判读）。
 * **禁 throw**：任何退化输入都返回可判读对象，不抛。
 * @param {unknown} batch 批次对象（`{ events, lanes, phase }`）
 * @returns {{ok: boolean, laneDiffs: Array<object>, phaseDiff: object|null, eventsScanned: number, lanesView: Record<string,string>, phaseView: string, degraded?: string}}
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

  // 相位比对：**仅当状态文件确实申报了相位**（字符串）才比对；未申报（畸形 / 退化输入）⇒ 无差异可报
  //   （禁把「缺申报」误报成「申报错」，否则退化路径不再满足「空差异」不变量）。
  const phaseDiff = statePhase !== null && statePhase !== phaseView ? { stateFile: statePhase, fromEvents: phaseView } : null;
  const verdict = {
    ok: laneDiffs.length === 0 && phaseDiff === null,
    laneDiffs,
    phaseDiff,
    eventsScanned: scanned.length,
    lanesView,
    phaseView,
  };
  if (events === null || events.length === 0) verdict.degraded = 'no-events';
  return verdict;
}

// ── 只读辅助（供诊断产物登记；不参与判定）────────────────────────────────────
/**
 * 终态判定透传（单点 = `lib/schema.js#isMemberTerminal`）——供消费方在同一真源上判读末态，
 * 避免各处自行拼字面量表。
 * @param {unknown} state 成员态
 * @returns {boolean}
 */
export function isTerminalLaneState(state) {
  return typeof state === 'string' && isMemberTerminal(state);
}
