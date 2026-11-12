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

// 宿主功能面读数的**就地刷新**（批 `punky-boot-httpfix-20261109b` · lane E1 · 判据 AC-8）。
//
// 背景：`capabilityReport()` 的 `host[]` 是**快照** —— `ports.httpSurface.available` 只在装配末尾
//   求值一次（`lib/index.js` 的 `probePorts`）。方案 A（HTTP 面延迟绑定）下，HTTP 面可能在
//   `rt.capabilities` 建好**之后**才装配 ⇒ 不刷新就会出现「`/mcp` 已可达、报告却仍 `available:false`」
//   的自相矛盾读数（AC-8 禁止的形态）。
//
// 为什么是「就地刷新」而不是重建整份报告：`rt` 的字段面被 `test/w7f-rt-write-surface.test.js` 冻结
//   （base 20 项 / 装配写集 21 项 / 全文赋值计数）⇒ 重建要多一处持有者赋值，属无收益的写面漂移；
//   报告的持有者保持单点（`apply` 末尾那一次），本函数只改内容。
//
// 为什么单独成模块：本函数是纯函数（无 I/O、无副作用外溢），独立成文件后可被单测直接驱动
//   （AC-8 的**行为**证据），而 `lib/capabilities.js` 的导出面已被既有 C7 用例逐字冻结为六项（禁增删）。

/** 面的缺省不可用成因词（与 `lib/capabilities.js#faceProbeOf` 的回落词同形）。 */
// 【④ 同名不同物改名】本函数与 `lib/capabilities.js` 的**同名空表**曾共用一名却两义：
//   本处是「按面键生成缺省成因串（函数）」，那边是「成因词覆盖表（查表）」。本处带 `…Of(` 生成口径
//   （`faceUnavailableReasonOf`），表侧带 **BY_KEY** 查表口径。两处**禁合并**（旧名与依据见 map.json G4-2）。
const faceUnavailableReasonOf = (faceKey) => 'face-unavailable: ' + faceKey;

/**
 * 就地刷新能力报告中某个宿主面的可用性读数（并把派生的 `unavailable` 集合重算一致）。
 *
 * 契约（与 `capabilities.js` 的裁决纪律逐条对齐）：
 *   · `available:true` ⇒ `reason` **强制 `null`**（否则出现「可用但带不可用成因」的自相矛盾读数）；
 *   · `available:false` ⇒ 保留端口自报的成因，缺失时回落 `'face-unavailable: <面名>'`；
 *   · `unavailable` 派生集合**必须**随之重算（它是报告的主回显通道之一）。
 *
 * @param {object} report `capabilityReport()` 的返回（就地修改）
 * @param {string} faceKey 面键（`toolSurface` / `httpSurface` / `agentRuntime` …）
 * @param {boolean} available 刷新后的可用性（**只接受 boolean**；三态里的 `null` 不在此刷新——未探明不是「变化」）
 * @returns {boolean} 是否真的发生了变化（`false` = 未变 / 入参不合规 ⇒ 调用方据此决定要不要留痕）
 */
export function refreshFaceReading(report, faceKey, available) {
  if (!report || typeof report !== 'object') return false;
  if (!Array.isArray(report.host)) return false;
  if (typeof faceKey !== 'string' || faceKey.length === 0) return false;
  if (available !== true && available !== false) return false;
  const face = report.host.find((h) => h && h.key === faceKey);
  if (!face || face.available === available) return false;
  face.available = available;
  face.reason = available === true
    ? null
    : (typeof face.reason === 'string' && face.reason.length > 0 ? face.reason : faceUnavailableReasonOf(faceKey));
  report.unavailable = report.host.filter((h) => h && h.available === false).map((h) => h.key);
  return true;
}
