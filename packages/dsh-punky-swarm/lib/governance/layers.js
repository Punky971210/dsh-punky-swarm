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

/**
 * `lib/governance/layers.js` —— I-25 **四层否决面**（进程级 / run 级 / 环境级 / 事务级）。
 *
 * ## 为什么是「四层」而不是一个函数
 * 否决点分属**四个不同生命周期**：进程内全局、单次 run、环境（工作区/路径）、事务（写前阶段）。
 * 合成一个函数后，调用方只能拿到「拒了」，**拿不到是哪一层拒的** —— 而这一条恰恰决定修复动作
 * （进程级要排空占用者、run 级要等配额、环境级要换路径、事务级要开事务）。
 * ⇒ 本文件把四层**各自导出、各自可调**；每层**只读自己那一个 fact**，互不越界。
 *
 * ## 判据（任务包 §2.3）：职责不重叠 ⇒ 五场景各只让**目标层**拒
 * S1 ⇒ `{'process'}` ／ S2 ⇒ `{'run'}` ／ S3 ⇒ `{'environment'}` ／ S4 ⇒ `{'transaction'}` ／ S5 ⇒ `∅`。
 * **反例**：若四层实为**同一函数的四个别名**，S1 会让四层**同时拒** ⇒ 拒层集合 = 四层 ⇒ **必红**。
 * ⚠ `grep` 数四个词对「别名」**完全无效**：它只能证明名字在，不能证明职责分开 ——
 *   所以本 lane 的完成判据是**五场景的拒层集合**（行为面），grep 只作必要不充分条件。
 *
 * ## 契约
 * 每层返回 `{ allowed: boolean, layer: '<层名>', reason?: string }`：
 * · `allowed: true` ⇒ 该层不否决（不返回 `reason`）；
 * · `allowed: false` ⇒ 该层否决，`reason` 给**可操作**的一句话（含层名与关键事实值）。
 *
 * 入参 `facts` 缺省 / 非对象 ⇒ 视为「**全部正常**」（四层均 `allowed: true`），**不抛错**：
 * 本文件是**判据**不是**形态校验器** —— 「缺事实」的语义 = 「没有已知的不稳定因素」，
 * 是否要求调用方先校验 facts 形态，归调用方决定（本文件不越权）。
 *
 * `facts` 的四个键（缺省 = 正常）：
 * · `processOccupied: boolean` —— 进程级槽位/单例/全局注册面**是否已被占用**（`true` ⇒ 拒）；
 * · `runQuotaExhausted: boolean` —— 本 run 的配额/尝试次数**是否已耗尽**（`true` ⇒ 拒）；
 * · `pathInsideWorkspace: boolean` —— 目标路径**是否在当前 environment 的工作区内**（**`false` ⇒ 拒**）；
 * · `inTransaction: boolean` —— 当前**是否在事务内 / 写前阶段**（**`false` ⇒ 拒**）。
 *
 * 三个 compare 语义刻意**不对称**（不是笔误，是事实语义不同）：
 * 前两个是「**出现坏事实才拒**」（`=== true`），后两个是「**必须成立才放行**」（`=== false` 即拒）
 * —— 占用与耗尽属异常事件，而在工作区内、在事务内属**前提条件**。
 */

/** facts 归一：缺省/非对象 ⇒ 空对象（= 全部正常）。本函数不校验形态，只防御解构崩溃。 */
function factsOf(facts) {
  return (facts && typeof facts === 'object') ? facts : {};
}

/** 不否决（不返回 `reason`：`allowed:true` 时没有"原因"可言）。 */
function allowOf(layer) {
  return { allowed: true, layer };
}

/** 否决：`reason` 必须可操作（含层名 + 关键事实值），便于调用方直接定位修复动作。 */
function denyOf(layer, reason) {
  return { allowed: false, layer, reason };
}

// ── 层 1／4 · 进程级 ────────────────────────────────────────────────────────────
// 管：进程内全局不变量（进程级槽位 / 单例 / 全局注册面是否已被占用）。
// 不管：run 配额、路径、事务 —— 那三项归另外三层，本层**不读它们的键**。
export function processLayer(facts) {
  const f = factsOf(facts);
  if (f.processOccupied === true) {
    return denyOf('process', '进程级拒绝：进程内槽位/单例/全局注册面已被占用（processOccupied=true）'
      + ' ⇒ 须先排空该进程内的占用者，再重试');
  }
  return allowOf('process');
}

// ── 层 2／4 · run 级 ───────────────────────────────────────────────────────────
// 管：单次 run 内的不变量（run 级配额 / 尝试次数是否耗尽）。
// 不管：进程槽位、路径、事务。配额耗尽属**终态事实**，只能等下一 run，不可原地重试。
export function runLayer(facts) {
  const f = factsOf(facts);
  if (f.runQuotaExhausted === true) {
    return denyOf('run', 'run 级拒绝：本 run 的配额/尝试次数已耗尽（runQuotaExhausted=true）'
      + ' ⇒ 本 run 内不可重试，须等下一 run 重新计量');
  }
  return allowOf('run');
}

// ── 层 3／4 · 环境级 ───────────────────────────────────────────────────────────
// 管：环境级不变量（目标路径/工作区是否属当前 environment）。
// 不管：配额、进程槽位、事务。**前提型**判据：`pathInsideWorkspace === false` ⇒ 拒（缺省视为正常）。
export function environmentLayer(facts) {
  const f = factsOf(facts);
  if (f.pathInsideWorkspace === false) {
    return denyOf('environment', '环境级拒绝：目标路径不在当前 environment 的工作区内'
      + '（pathInsideWorkspace=false）⇒ 须把目标改到工作区内，或先把该路径纳入 environment');
  }
  return allowOf('environment');
}

// ── 层 4／4 · 事务级 ───────────────────────────────────────────────────────────
// 管：事务级不变量（是否在事务内、是否处于写前阶段）。
// 不管：前三层的任何键。**前提型**判据：`inTransaction === false` ⇒ 拒（缺省视为正常）。
export function transactionLayer(facts) {
  const f = factsOf(facts);
  if (f.inTransaction === false) {
    return denyOf('transaction', '事务级拒绝：当前不在事务内/非写前阶段（inTransaction=false）'
      + ' ⇒ 须先开启事务并进入写前阶段，再提交该动作');
  }
  return allowOf('transaction');
}
