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

// lib/assembly/snapshot.js —— §8③「解析结果落快照」的**写单点**（批次 `a3-snapshot-b1-20260915` · lane e1）。
//
// 【2026-09-27 · team-asset 全量退役】资产面退役 ⇒ **无资产可解析、无档可冻结**：
//   · 原「建批时刻解析团队声明 → 落会话级正档（`<sessionDir>/team-assets/<team>.<assetHash>.json`）」
//     整条写盘路径（内容指纹 `assetHashOf` / 幂等写档 `writeSnapshotFile` / `SNAPSHOT_*` 常量 /
//     键级摘要 `summaryKeysOf` / `flagsResolvedOf`）随资产面**整体删除**（判据源 T-7）；
//   · 本模块现为**保形空实现**：恒返回「本批无团队资产解析记录」这一事实（`field: null`）、
//     不落事件、不写盘、不读盘、零 I/O、零副作用。
//   · 保形理由（**【2026-09-28 · 批 `cleanup-tail-20260927` E-2 订正】**）：原写「调用方
//     `lib/state/store.js#createBatch` 经 `teamAssetRefFor` 消费本函数（该文件不在写域）⇒ 删导出会断链」
//     —— **该接线已随批 3 整体删除**（`lib/state/store.js:292`/`:294` 自陈），且本文件在 `lib/**`+`test/**`
//     的 **`import` 语句命中 = 0**（实测）⇒ 原「删导出会断链」理由**已失效**，本文件是**零 importer 的标废件**。
//   · **标废而非删文件的理由**（E-2 采「标废」分支）：`docs/engine-intro.md:45`（**冻结面，本批禁改**）与
//     `lib/state/store.js:30` 的注释仍指向本文件 ⇒ 删文件会在**禁改文档留悬空指针**。
//   · 口径不变：改为「诚实的空实现」，而非保留一条「读已删除资产」的死路径（判据源 A-13：禁「写了不生效」的静默面）。
//
// 冻结面归属（**勿回加写盘点**）：
//   · `batch.teamAsset` **已停写**（`store.createBatch` 的该接线随批 3 删除；`field` 现恒 `null` = 无解析记录）；
//     历史批磁盘 JSON 上**仍可能带该键** ⇒ 存量读端按「历史兼容读」处置（`lib/api.js:134` /
//     `lib/panel/batch-detail.js:227`，零迁移、不解析、不回显）；
//   · `gate_status` / `batch_status` 的 `teamAsset` 回显、`gateAssetViewOf` 的档读端已随本批**删净**。
//
// 历史（保留可读）：原语义 = 「解析结果派生观察档，**不参与任何门禁判定**」；落点 = 会话级正档；
//   档名含内容指纹 ⇒ 同内容幂等；边界 = 无资产只写 `ok:false` 字段（不写档、不落事件）。

/**
 * 建批时刻的解析结果引用（【2026-09-27】资产面退役 ⇒ 恒「无记录」）。
 * @param {{sessionDirAbs?: string, team?: string|null, teamsRoot?: string|null, now?: Date}} _input
 *   形参**保形保留**（调用方 `store.createBatch` 签名零变化）；现已全部不被读。
 * @returns {{ field: null, event: null, snapshotPath: null, warning: null }}
 *   `field` = `batch.teamAsset` 的取值（恒 `null`）；`event` = 建批期解析事件载荷（恒 `null` ⇒ 不落事件）；
 *   `snapshotPath` 恒 `null`；`warning` 恒 `null`（无写盘动作 ⇒ 无写盘失败面）。
 */
export function teamAssetRefOf(_input) {
  return { field: null, event: null, snapshotPath: null, warning: null };
}
