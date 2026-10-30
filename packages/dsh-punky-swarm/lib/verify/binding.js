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

// 派发输入绑定校验（I-04 / A4）：**不匹配要在写入发生前拒**。
//
// 为什么必须前置而不能事后补：派发时引擎只登记「这条 lane 交给了哪个 worker 会话」
//   （`member.dispatch { lane, workerSessionId }`）。若某个工具调用带着别人的 lane 就写下去，
//   事后**无法**补出「当时是谁被派发的这条 lane」——证据面已经脏了，只能整批作废重跑。
//   所以判据的位置不是"在哪判最方便"，而是"必须在任何写入之前"。
//
// 本文件是**纯函数**层：不读盘、不访问 store、不取时钟。事实（批事件）由调用方读好后传入。
//   理由与 I-24/I-11 同一套：判定与判定的检验若共用同一个可漂移的真源，谁也证不了谁。

/** 绑定不匹配的拒因前缀（普通字符串：**不新增 `GATE_` 码族**，与包一致）。 */
export const BINDING_MISMATCH = 'binding-mismatch:';

/**
 * 字面契约（包 §2.1）：
 *
 * @param {{expected?: string|null, actual?: string|null, where?: string}} input
 *   `expected` = 该 lane 已登记的 worker 会话；`actual` = 本次调用的调用方会话。
 * @returns {{ok: boolean, reason?: string}}
 *   缺 `expected`（尚未派发）⇒ `{ok:true}` —— **无绑定可核，不误拦**（首次调用必须能过）；
 *   两侧都在且相等 ⇒ `{ok:true}`；
 *   两侧都在且不等 ⇒ `{ok:false, reason:'binding-mismatch: <where>（expected … / actual …）'}`。
 */
export function bindingDecision({ expected, actual, where } = {}) {
  const exp = typeof expected === 'string' && expected.length > 0 ? expected : null;
  const act = typeof actual === 'string' && actual.length > 0 ? actual : null;
  if (exp === null) return { ok: true }; // 尚未派发 ⇒ 无绑定可核
  if (act === null) return { ok: true }; // 调用方未知 ⇒ 无法核（不猜）
  if (exp === act) return { ok: true };
  const at = typeof where === 'string' && where.length > 0 ? where : 'dispatch-input';
  return { ok: false, reason: BINDING_MISMATCH + ' ' + at + '（expected ' + exp + ' / actual ' + act + '）' };
}

/** 批事件里该 lane 最近一次派发的 worker 会话（无 ⇒ `null`）。纯读 `batch.events`。 */
export function expectedWorkerSessionOf(batch, lane) {
  const events = Array.isArray(batch?.events) ? batch.events : [];
  if (typeof lane !== 'string' || lane.length === 0) return null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (ev && ev.type === 'member.dispatch' && ev.lane === lane && typeof ev.workerSessionId === 'string' && ev.workerSessionId.length > 0) {
      return ev.workerSessionId;
    }
  }
  return null;
}

/** 该会话在本批被登记为哪些 lane 的 worker（= 它确实是一个"被派发的执行体"）。 */
export function workerLanesOf(batch, sessionId) {
  const events = Array.isArray(batch?.events) ? batch.events : [];
  if (typeof sessionId !== 'string' || sessionId.length === 0) return [];
  const lanes = new Set();
  for (const ev of events) {
    if (ev && ev.type === 'member.dispatch' && ev.workerSessionId === sessionId && typeof ev.lane === 'string') lanes.add(ev.lane);
  }
  return [...lanes];
}

/**
 * 边界判定（工具层调用的**单点**）：把「谁受绑定约束」这件事也收进来，避免每个调用点各写一遍。
 *
 * 约束范围（刻意的窄口径）：
 *   · 该 lane 尚未派发 ⇒ 放行（无绑定可核）；
 *   · 调用方就是该 lane 的 worker ⇒ 放行；
 *   · 调用方**不是任何 lane 的 worker**（Leader / 批 owner / Manager 等治理面）⇒ 放行
 *     —— 它们做的是治理动作，不是"派发输入"，塞进绑定的语义里会让正常结算被误杀；
 *   · 调用方**是某条 lane 的 worker，但不是这条 lane 的** ⇒ **拒**。这才是「派发输入被顶替」的真身。
 *
 * @returns {{ok: boolean, reason?: string, expected: string|null}}
 */
export function dispatchBindingDecision({ batch, lane, caller, where } = {}) {
  const expected = expectedWorkerSessionOf(batch, lane);
  const base = { expected };
  if (expected === null) return { ok: true, expected: null };
  const act = typeof caller === 'string' && caller.length > 0 ? caller : null;
  if (act === null) return { ok: true, expected };
  if (act === expected) return { ok: true, expected };
  if (workerLanesOf(batch, act).length === 0) return { ok: true, expected }; // 治理面调用，非派发输入
  return { ...bindingDecision({ expected, actual: act, where }), expected };
}
