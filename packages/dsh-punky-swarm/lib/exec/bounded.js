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

// 执行期双时钟（I-07）＋ 停止三阶段阈值（I-08）。**阈值唯一真源在本文件**。
//
// ── I-07 双时钟：判据是「**思考期不计时**」，不是「有 deadline」─────────────────────
//   adoption 原文（`punky-paperclip-adoption-blueprint.md:44` / `:78`）：
//     「`executionControlDeadlineAt`（**never a timeout on thinking**）」
//     「Set only after provider execution settles; **never a timeout on thinking**」
//   ⇒ deadline **只在 `settle()` 之后**才被设置。`begin()` 只记 `startedAt`，**不设任何 deadline**。
//   ⇒ 两个时钟是**串行的**：思考期（`thinking`）无计时；结算后才进入 `hardMs` → `graceMs` 两段。
//   这是 I-07 的**全部意义**：模型在思考**不算执行超时**。若把 `begin` 当 deadline 起点，
//   就退化成「有 deadline」——长思考会被误判超时，本文件即失去存在理由。
//
// ── I-08 停止三阶段（阈值 60s / 600s）────────────────────────────────────────────
//   `thinking`（未结算，**无计时**）
//     → `with_grace`（结算后 ≤ `hardMs`）
//     → `grace_exceeded`（> `hardMs` 且 ≤ `graceMs`）
//     → `timed_out`（> `graceMs`）
//
// ── 核心拒态：**不许把「未知」当「已停」**───────────────────────────────────────
//   状态未知（从未 begin / 已 cancel / runId 不认识）**不得**被判成已停止：
//   一律 `{ phase: 'thinking', timedOut: false }`。
//   值域里**不存在** `stopped` 这类「已停」语义 —— 四档 phase 全部列在上方，无第五档。

/** 阶段一上界（hard，毫秒）。唯一真源。 */
export const HARD_TIMEOUT_MS = 60_000;

/** 阶段二上界（grace 期总上界，毫秒）。唯一真源。 */
export const GRACE_TIMEOUT_MS = 600_000;

/** 四档 phase 值域（**不存在** `stopped` 之类「已停」语义）。 */
export const BOUNDED_PHASES = ['thinking', 'with_grace', 'grace_exceeded', 'timed_out'];

const UNKNOWN_CLASSIFICATION = Object.freeze({ phase: 'thinking', timedOut: false });

/**
 * 建双时钟执行控制器。
 *
 * @param {object} [opts]
 * @param {number} [opts.hardMs]  阶段一上界（缺省 = `HARD_TIMEOUT_MS`）。
 * @param {number} [opts.graceMs] 阶段二上界（缺省 = `GRACE_TIMEOUT_MS`）。
 * @param {() => number} [opts.now] 时钟注入（测试用；生产缺省 `Date.now`）。
 */
export function createBoundedExec({
  hardMs = HARD_TIMEOUT_MS,
  graceMs = GRACE_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, {startedAt:number, settledAt:number|null, deadline:number|null, outcome:unknown}>} */
  const runs = new Map();

  /** 取登记项；不存在 ⇒ null（调用方按「未知状态」处理）。 */
  const entryOf = (runId) => runs.get(String(runId)) ?? null;

  /** 执行开始：**只记 startedAt，不设 deadline**（I-07 的落点就在这一行）。 */
  function begin(runId) {
    runs.set(String(runId), { startedAt: now(), settledAt: null, deadline: null, outcome: null });
    return { runId: String(runId), phase: 'thinking', deadlineAt: null };
  }

  /** 执行结算：**此刻**才设 deadline（`settledAt + hardMs`）。未 begin 的 runId 不得凭空结算。 */
  function settle(runId, outcome = null) {
    const key = String(runId);
    const entry = entryOf(key);
    if (entry === null) {
      // 未知状态不伪造：结算一个从未 begin 的 runId ⇒ 抛错（不得静默造出一条「已结算」记录）
      throw new Error('exec settle rejected: unknown runId: ' + key);
    }
    const settledAt = now();
    entry.settledAt = settledAt;
    entry.deadline = settledAt + hardMs; // ← 双时钟的唯一起点（结算时刻）
    entry.outcome = outcome;
    return { runId: key, settledAt, deadlineAt: entry.deadline };
  }

  /**
   * 读取 deadline。**未结算 ⇒ `null`**（= thinking；不返回任何具体时刻）。
   * 未知 runId 同样 `null` —— 未知不是「已停」，也不是「有 deadline」。
   */
  function deadlineAt(runId) {
    const entry = entryOf(runId);
    return entry === null ? null : entry.deadline;
  }

  /**
   * 判阶段。未知/未结算 ⇒ `{ phase:'thinking', timedOut:false }`。
   * @returns {{phase: 'thinking'|'with_grace'|'grace_exceeded'|'timed_out', timedOut: boolean}}
   */
  function classify(runId) {
    const entry = entryOf(runId);
    // ① 未知状态：不得当「已停」
    if (entry === null) return { ...UNKNOWN_CLASSIFICATION };
    // ② 未结算：思考期不计时 —— 无论 now 前进多少，都不超时
    if (entry.settledAt === null || entry.deadline === null) return { ...UNKNOWN_CLASSIFICATION };

    const elapsed = now() - entry.settledAt; // ← 只从结算时刻起算（不是 startedAt）
    if (elapsed <= hardMs) return { phase: 'with_grace', timedOut: false };
    if (elapsed <= graceMs) return { phase: 'grace_exceeded', timedOut: true };
    return { phase: 'timed_out', timedOut: true };
  }

  /** 取消：清除登记 ⇒ 之后 `classify` 回落「未知 ⇒ thinking / 未超时」（未知不当已停）。 */
  function cancel(runId) {
    const key = String(runId);
    const existed = runs.delete(key);
    return { runId: key, cancelled: existed };
  }

  return { begin, settle, deadlineAt, classify, cancel };
}
