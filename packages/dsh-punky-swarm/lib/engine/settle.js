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

// 结算与状态推进**解耦**（I-12 / B6）。
//
// ── 核心语义（**最容易做反的一条**）──────────────────────────────────────────────
//   **结算失败不得阻塞状态推进。**
//     ❌ 错：结算抛错 ⇒ 状态不变（那是把两件事**耦合**在一起，且失败方向最坏——
//        结算出错本该只是"账没记全"，却让"这条 lane 该进终态"这个事实也丢了）
//     ✅ 对：结算抛错 ⇒ **状态照样推进**，结算侧留下 `settleError` 记录
//
//   所以本函数的两个动作**顺序固定且地位不同**：
//     ① 状态推进（`store.setMember`）= **独立动作**，它自己失败就**照旧抛**
//        （那是真错误，不属于"结算失败"——别把它也吞掉）
//     ② 结算（`settle`）= **旁挂动作**，`try/catch` 包裹，**不回滚、不向上传播**
//
// ── 幂等 ──────────────────────────────────────────────────────────────────────
//   同一 (sessionId, batchId, lane, status) 重复调用 ⇒ **不重复推进、不重复结算**
//   ⇒ 结算计数不会被重复累加（`repeated: true` 显式标出「这是重复调用」）。
//   判据来源 = 调用前的批状态本身（`batch.lanes[lane] === status` ⇒ 已是目标态），
//   不另建一份"我已结算过"的旁账 —— 两份账迟早会不一致。
//
// ── 边界 ──────────────────────────────────────────────────────────────────────
//   本文件**不判**绑定/权限/档位（那些是写入前拒，在调用方已完成）；
//   它只负责「推进与结算的相对地位」。少判一层，就少一处会漂的第二真源。

/** 结算失败前缀（普通字符串；**不向上抛**，仅进返回值）。 */
export const SETTLE_FAILED = 'settle-failed:';

/**
 * 先推进状态，再**独立**尝试结算；结算失败不回滚、不阻塞、不抛出。
 *
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
  // 幂等：已是目标态 ⇒ 不重复推进、不重复结算（计数不增）
  const before = typeof store?.readBatch === 'function' ? store.readBatch(sessionId, batchId) : null;
  if (before && before.lanes && before.lanes[lane] === status) {
    return { batch: before, stateAdvanced: false, settled: true, repeated: true };
  }

  // ① 状态推进 = 独立动作；**其异常照旧向上抛**（不属于"结算失败"）
  const batch = store.setMember(sessionId, batchId, lane, status, note);

  // ② 结算 = 旁挂动作；异常被捕获，**不回滚、不向上传播**
  let settled = false;
  let settleError;
  try {
    const outcome = typeof settle === 'function' ? settle(batch) : false;
    settled = outcome !== false; // 明确返回 false ⇒ 视为未结算；其余（含 undefined/true）以 true 记
  } catch (e) {
    settleError = SETTLE_FAILED + ' ' + String(e?.message ?? e);
  }

  // 状态已推进是**事实**：即使结算失败，`stateAdvanced` 仍为 true
  return settleError === undefined
    ? { batch, stateAdvanced: true, settled }
    : { batch, stateAdvanced: true, settled: false, settleError };
}
