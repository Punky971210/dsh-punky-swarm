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

//   **结算失败不得阻塞状态推进。**

export const SETTLE_FAILED = 'settle-failed:';

/**
 * @param {object} params
 * @param {object} params.store store 实例（需 `setMember`；可选 `readBatch` 用于幂等判定）
 * @param {string} params.sessionId 批归属会话
 * @param {string} params.batchId 批 id
 * @param {string} params.lane lane id
 * @param {string} params.status 目标成员态
 * @param {string|null} [params.note] 备注（只留元数据）
 * @param {(batch: object) => boolean} [params.settle] 结算旁挂动作（缺省 ⇒ 视为未结算）
 * @returns {{batch: object, stateAdvanced: boolean, settled: boolean, settleError?: string, repeated?: boolean}}
 * @throws {Error} **仅当状态推进本身失败**（结算失败绝不抛出）
 */
export function settleDecoupled({ store, sessionId, batchId, lane, status, note = null, settle = null }) {
  const before = typeof store?.readBatch === 'function' ? store.readBatch(sessionId, batchId) : null;
  if (before && before.lanes && before.lanes[lane] === status) {
    return { batch: before, stateAdvanced: false, settled: true, repeated: true };
  }

  const batch = store.setMember(sessionId, batchId, lane, status, note);

  let settled = false;
  let settleError;
  try {
    const outcome = typeof settle === 'function' ? settle(batch) : false;
    settled = outcome !== false;
  } catch (e) {
    settleError = SETTLE_FAILED + ' ' + String(e?.message ?? e);
  }

  return settleError === undefined
    ? { batch, stateAdvanced: true, settled }
    : { batch, stateAdvanced: true, settled: false, settleError };
}
