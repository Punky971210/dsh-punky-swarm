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

// 派发面 · 身份与绑定：lane 标签、owner 会话解析、派发索引命中、车道绑定读面。
// 位于 role 之上、preflight 之下。

import { firstDispatchOfSession } from '../state/dispatch-events.js';

const LABEL_PREFIX = 'punky-swarm:';

export const ownerOfExec = (exec) => exec?.agent?.id ?? exec?.agent?.agentId ?? exec?.agent?.session?.id ?? null;
export function labelOf(batchId, lane) {
  return LABEL_PREFIX + String(batchId) + ':' + String(lane);
}

const asSessionId = (v) => (typeof v === 'string' && v.length > 0 ? v : null);
export function ownerSessionIdOfExec(exec) {
  return asSessionId(exec?.agent?.session?.id);
}
export function ownerSessionIdOf(source) {
  return asSessionId(source?.ownerSessionId);
}
export function wakeAddressOf(hit) {
  return ownerSessionIdOf(hit) ?? hit?.sessionId ?? null;
}

//     **禁建第二套 worker→批 索引**，本函数只 `get`。
export function batchSessionIdOfWorker(dispatchIndex, exec) {
  if (!(dispatchIndex instanceof Map)) return null;
  const workerSessionId = ownerSessionIdOfExec(exec);
  if (!workerSessionId) return null;
  const hit = dispatchIndex.get(workerSessionId);
  return asSessionId(hit?.sessionId);
}

function dispatchIndexHitOf(dispatchIndex, workerSessionId) {
  return dispatchIndex.get(workerSessionId);
}

/**
 * @param {{listAllBatches?: Function, readBatch?: Function}|null|undefined} store 事件流数据源（缺 ⇒ 不命中）
 * @param {Map|null|undefined} dispatchIndex 既有**唯一** worker→批 索引（缺 / 非 Map ⇒ 不命中）
 * @param {{agent?: {session?: {id?: string}}}|null|undefined} exec 调用方 Agent（取键口径同写侧单点）
 * @param {object|undefined} logger 可选 cordis logger（**生产必传**，见 `lib/index.js` 调用方）：
 *   仅用于把 `laneBindingOf` 的 `batch-enum-failed:` / `batch-read-failed:` 两态**真可辨**；
 *   不传 = 静默（向后兼容），但生产路径不传 = M-1「能力在、接不到」的重演。
 * @returns {string|null} 批归属会话 id；未命中 / 数据源不可用 / 反查抛错 ⇒ `null`
 */
export function batchSessionIdOfWorkerResolved(store, dispatchIndex, exec, logger) {
  try {
    const hot = batchSessionIdOfWorker(dispatchIndex, exec);
    if (hot) return hot;
    const workerSessionId = ownerSessionIdOfExec(exec);
    if (!workerSessionId) return null;
    if (!(dispatchIndex instanceof Map)) return null;
    const bind = laneBindingOf(store, workerSessionId, logger);
    if (!bind) return null;
    const existing = dispatchIndexHitOf(dispatchIndex, workerSessionId);
    const owner = ownerSessionIdOf(bind);
    if (!existing || (ownerSessionIdOf(existing) === null && owner)) {
      dispatchIndex.set(workerSessionId,
        dispatchIndexEntryOf(bind.sessionId, bind.batchId, bind.lane, owner));
    }
    return batchSessionIdOfWorker(dispatchIndex, exec);
  } catch {
    return null;
  }
}

export function dispatchIndexEntryOf(sessionId, batchId, lane, ownerSessionId) {
  const entry = { sessionId, batchId, lane };
  if (ownerSessionId) {
    Object.defineProperty(entry, 'ownerSessionId', {
      value: ownerSessionId, enumerable: false, writable: true, configurable: true,
    });
  }
  return entry;
}

export function laneBindingOf(store, sessionId, logger) {
  if (!sessionId || !store || typeof store.listAllBatches !== 'function') return null;
  let all = [];
  try {
    all = store.listAllBatches() ?? [];
  } catch (e) {
    logger?.warn?.('[dsh-punky-swarm] batch-enum-failed: ' + String(e?.message ?? e)
      + '（laneBindingOf · session=' + sessionId + '）⇒ 返 null；这是**枚举失败**，不是「无批绑定」');
    return null;
  }
  for (const { sessionId: ownerSession, batchId } of all) {
    let b = null;
    try {
      b = store.readBatch(ownerSession, batchId);
    } catch (e) {
      logger?.warn?.('[dsh-punky-swarm] batch-read-failed: ' + String(ownerSession) + '/' + String(batchId)
        + '（' + String(e?.message ?? e) + '）⇒ 跳过该批继续；这是**读失败**，不是「批不存在」');
      continue;
    }
    // 「首个命中」口径（与派发绑定的「最近一次」不同口径，见 state/dispatch-events.js 说明）
    const hit = firstDispatchOfSession(b, sessionId);
    if (hit) {
      const bind = { sessionId: ownerSession, batchId, lane: hit.lane };
      const owner = ownerSessionIdOf(hit);
      if (owner) {
        Object.defineProperty(bind, 'ownerSessionId', {
          value: owner, enumerable: false, writable: true, configurable: true,
        });
      }
      return bind;
    }
  }
  return null;
}
