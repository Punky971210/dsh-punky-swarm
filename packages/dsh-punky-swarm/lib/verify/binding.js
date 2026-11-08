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

// 为什么必须前置而不能事后补：派发时引擎只登记「这条 lane 交给了哪个 worker 会话」
//   （`member.dispatch { lane, workerSessionId }`）。若某个工具调用带着别人的 lane 就写下去，
//   事后**无法**补出「当时是谁被派发的这条 lane」——证据面已经脏了，只能整批作废重跑。
//   所以判据的位置不是"在哪判最方便"，而是"必须在任何写入之前"。

import { expectedWorkerSessionOf, workerLanesOf } from '../state/dispatch-events.js';

export const BINDING_MISMATCH = 'binding-mismatch:';

export function bindingDecision({ expected, actual, where } = {}) {
  const exp = typeof expected === 'string' && expected.length > 0 ? expected : null;
  const act = typeof actual === 'string' && actual.length > 0 ? actual : null;
  if (exp === null) return { ok: true }; // 尚未派发 ⇒ 无绑定可核
  if (act === null) return { ok: true }; // 调用方未知 ⇒ 无法核（不猜）
  if (exp === act) return { ok: true };
  const at = typeof where === 'string' && where.length > 0 ? where : 'dispatch-input';
  return { ok: false, reason: BINDING_MISMATCH + ' ' + at + '（expected ' + exp + ' / actual ' + act + '）' };
}

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
