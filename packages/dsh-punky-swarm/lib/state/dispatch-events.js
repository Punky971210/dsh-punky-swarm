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

// `member.dispatch` 事件的**唯一读取点**。
//
// 为什么单点：此前五个消费面（派发绑定 / 交接授权 / lane 反查 / 自动结算 / 索引重建）各写一遍
//   扫描循环，而「取最近一次」与「取首个命中」两种口径在代码里长得一模一样 —— 读代码看不出差别，
//   改一处就会静默改掉派发归属。⇒ 口径升为**显式参数**（`order` / 专门的 `firstDispatchOfSession`），
//   调用点必须自己声明要哪一种。

const DISPATCH_TYPE = 'member.dispatch';

/** 全量事件 → 派发记录（保持事件序；缺 lane 或 workerSessionId 的一律丢弃）。 */
export function dispatchRecordsOf(events) {
  const out = [];
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || ev.type !== DISPATCH_TYPE) continue;
    if (typeof ev.lane !== 'string' || ev.lane.length === 0) continue;
    if (typeof ev.workerSessionId !== 'string' || ev.workerSessionId.length === 0) continue;
    out.push(ev);
  }
  return out;
}

/** lane 的期望 worker 会话。
 *  @param {'latest'|'first'} [order] `latest`（缺省）= 重派以最后一条为准；`first` = 首派归属。 */
export function expectedWorkerSessionOf(batch, lane, order = 'latest') {
  if (typeof lane !== 'string' || lane.length === 0) return null;
  const hits = dispatchRecordsOf(batch?.events).filter((ev) => ev.lane === lane);
  if (hits.length === 0) return null;
  return (order === 'first' ? hits[0] : hits[hits.length - 1]).workerSessionId;
}

/** 某 worker 会话被派发过的 lane（首次出现序，已去重）。 */
export function workerLanesOf(batch, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return [];
  const lanes = dispatchRecordsOf(batch?.events)
    .filter((ev) => ev.workerSessionId === sessionId)
    .map((ev) => ev.lane);
  return [...new Set(lanes)];
}

/** 某 worker 会话的**首个**派发记录（「首个命中」口径的专用入口；跨批由调用方自行遍历）。
 *  与 `expectedWorkerSessionOf(..., 'latest')` 是两种口径 —— 需要「最近」的调用点不得用本函数。 */
export function firstDispatchOfSession(batch, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  return dispatchRecordsOf(batch?.events).find((ev) => ev.workerSessionId === sessionId) ?? null;
}
