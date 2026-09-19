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

// engine/replay.js —— **链推进重放 · 已退役**（2026-09-18 · Q-A=C 弃用链声明）。
// ─────────────────────────────────────────────────────────────────────────────
// 【为什么退役】本模块的全部对象是「**已结算但链未推进**」的 lane：判据 `advancedAfter` 按 `chain.step` 事件
//   判定某步是否已据此推进，命中则对每条 lane 调 `advanceChainAfterSettle(noDispatch:true)` 补一条推进决策。
//   链运行期推进本身已退役（`lib/engine/chain-runner.js` 的入口改首行 no-op）⇒ **重放无对象**：
//   保留「先判后放」的实现会变成对空对象的第二套决策路径（双推进源风险）。
// 【本模块现状】`replayBatch` 保留导出但为**空壳**（`reason:'retired'`，零读批、零事件、零派发）——
//   两处既有调用点（`lib/index.js:603` 启动期有界扫描、`lib/watch/lane-heartbeat.js:1304` 重放档）**不在本
//   lane 写域**，删导出会让它们 ESM 缺符号（加载期报错）⇒ 保留空壳是写域内的唯一安全形态（零行为差异）。
// 【删除面（逐条）】`settleTsOf` / `advancedAfter` / `pendingAdvancesOf` 三个纯函数：判据对象（`chain.step`
//   驱动的推进）已不存在 ⇒ 连注释一并移除（服役面已归零）。
// 【保留面】返回形状（`{ok, scanned, replayed, results, reason}`）逐字不变 —— 读端按字段判读，不按语义分支。

/**
 * 对单批重放一次（**已退役空壳**）：不读批、不判据、不落事件、不派发。
 * 保留导出的理由 = 两处写域外调用点的加载期兼容；调用方据此字段可判「重放能力已停用」。
 * @returns {Promise<{ok: boolean, scanned: number, replayed: number, results: Array<object>, reason: string}>}
 */
export async function replayBatch() {
  return {
    ok: true,
    scanned: 0,
    replayed: 0,
    results: [],
    reason: 'retired',
    note: 'chain-replay-retired-20260918',
  };
}
