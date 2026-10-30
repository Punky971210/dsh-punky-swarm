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

// 投递标记与执行解耦（I-11）：**同一事件重放不得重跑**。
//
// 为什么这件事需要单独的模块：在此之前「事件到达」与「执行一次」是同一个动作 ——
//   重投一次事件就重跑一遍副作用。而重投是**常态**（补偿、重试、证据面重放都可能再送一次），
//   所以幂等不能寄望于上游「不会重复送」，只能由接收侧按**投递标记**自己认。
//
// 三态（钉死，见 `replayDecision`）：
//   · `delivered` ⇒ 不重跑（已执行过）；
//   · `pending`   ⇒ 重跑（明确标记了"尚未投递完成"，这是可重跑的正当理由）；
//   · **无标记**   ⇒ **不重跑 + 留痕**（fail-closed）。
//
// 为什么"无标记"要 fail-closed 而不是"当未投递就重跑"：
//   后者是**最危险**的一种设计 —— 老事件、坏事件、被裁掉字段的事件都会静默变成"再执行一次"，
//   而且现场不会留下任何痕迹（没人知道它跑过第二次）。宁可少跑一次并记明原因：少跑可以补，
//   多跑（尤其是有副作用的写）往往补不回来。
//
// 纯度：本文件不读盘、不访问 store、不取当前时间（时间由 `markDelivered(event, at)` 的 `at` 传入）。
//   理由同 I-24：判定与判定的检验若共用同一个可漂移的真源，谁也证不了谁。
import { createHash } from 'node:crypto';

/** 标记缺失的拒因前缀（普通字符串：不新增 GATE_ 码族）。 */
export const DELIVERY_MARKER_MISSING = 'delivery-marker-missing:';

/** 未投递完成的标记值（**唯一**可重跑态）。 */
export const DELIVERY_PENDING = 'pending';

/** 已投递完成的标记值（不重跑）。 */
export const DELIVERY_DELIVERED = 'delivered';

/** 标记值超出三态（防御：不静默当成任一态）。 */
export const DELIVERY_MARKER_UNRECOGNIZED = 'delivery-marker-unrecognized:';

/** 取事件的投递身份：优先显式投递 id，其次事件 id，最后用规范化摘要兜底（同事件必同值）。 */
export function deliveryIdOf(event) {
  if (!event || typeof event !== 'object') return '(none)';
  for (const key of ['deliveryId', 'id', 'eventId']) {
    const v = event[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  // 无 id：用「类型 + 载荷」的规范化摘要做身份。刻意**不**用引用地址或时间戳
  //   —— 那样同一事件每次重放都会得到不同身份，解耦就失效了。
  const material = JSON.stringify(['__anon__', event.type ?? null, sortValueOf(event.payload ?? null)]);
  return 'anon:' + createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 16);
}

/** 规范化（键排序）以便匿名身份稳定。 */
function sortValueOf(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortValueOf);
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortValueOf(value[key]);
  return out;
}

/** 是否已投递完成（**仅** `delivered` 为真；其余一律 false，含缺标记与未知值）。 */
export function isDelivered(event) {
  return Boolean(event && typeof event === 'object' && event.delivery === DELIVERY_DELIVERED);
}

/**
 * 打上「已投递」标记：**返回新对象**，不修改入参。
 *
 * 为什么强制不可变：投递标记是**幂等判据**本身。若允许原地改，调用方手里那份旧引用会同时
 * 变成"已投递"，于是"同一事件的两个视图"给出两个不同的重放结论 —— 判据就不再是判据。
 *
 * @param {object} event 事件
 * @param {string|number} at 投递时刻（由调用方提供；本模块不取时钟）
 * @returns {object} 新事件（含 `delivery:'delivered'` 与 `deliveredAt`）
 */
export function markDelivered(event, at) {
  if (!event || typeof event !== 'object') throw new TypeError('markDelivered requires an event object');
  return { ...event, delivery: DELIVERY_DELIVERED, deliveredAt: at };
}

/** 打上「未投递完成」标记（显式可重跑态）：同样返回新对象。 */
export function markPending(event) {
  if (!event || typeof event !== 'object') throw new TypeError('markPending requires an event object');
  const next = { ...event, delivery: DELIVERY_PENDING };
  delete next.deliveredAt;
  return next;
}

/**
 * 重放判定（**纯函数**）。
 *
 * @param {object} event 事件
 * @returns {{rerun: boolean, reason?: string}}
 *   `{rerun:true}` ⇒ 允许执行一次；
 *   `{rerun:false, reason}` ⇒ 不执行，理由三选一：
 *     · `'already-delivered'`（已执行过）
 *     · `'delivery-marker-missing: <id>'`（**标记缺失 ⇒ fail-closed + 留痕**）
 *     · `'delivery-marker-unrecognized: <值>'`（超出三态 ⇒ 同样不执行，不猜）
 */
export function replayDecision(event) {
  if (!event || typeof event !== 'object') {
    return { rerun: false, reason: DELIVERY_MARKER_MISSING + ' (none)' };
  }
  if (!Object.prototype.hasOwnProperty.call(event, 'delivery')) {
    // 关键分支：**没有标记 ≠ 未投递**。这里刻意不返回 rerun:true。
    return { rerun: false, reason: DELIVERY_MARKER_MISSING + ' ' + deliveryIdOf(event) };
  }
  const marker = event.delivery;
  if (marker === DELIVERY_DELIVERED) return { rerun: false, reason: 'already-delivered' };
  if (marker === DELIVERY_PENDING) return { rerun: true };
  return { rerun: false, reason: DELIVERY_MARKER_UNRECOGNIZED + ' ' + String(marker) };
}
