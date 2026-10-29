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

// state/wake-queue.js —— **I-09 唤醒队列**（G3 / B2；**纯内存状态模块，零 IO、零接线**）。
//
// 存在价值判据（口径源原文逐字保留，禁改写）：**「空转仍产新 run ⇒ 停 G4」**。
//   它说的不是性能，而是**本模块有没有存在价值**：若空转（没有新事件）仍能产出新 run，
//   整条唤醒队列等于没做，而表面上看不出问题。⇒ 上界必须**真的挡住第 3 次**，而不是只做去重。
//
// 三条语义（本批 AC-9 / AC-10，各配「可红形态」见 §判据）：
//   ① **coalescing**：同一 lane 未 drain 前的多次 enqueue 合并成**恰 1 条** run（不是「≤ N」——0 条也 ≤ N，那种写法恒绿）；
//   ② **续跑上界 2**：同一 lane 的 run 产出次数封顶 `maxResumes`（缺省 2）⇒ 第 3 轮 drain 不产 run；
//   ③ **自 block 抑制**：`suppressSelf(lane)` 后该 lane 的 enqueue **不产 run**（自产唤醒不得唤醒自己）。
//   另：**跨 lane 不得误合并** —— 合并键 = lane，`L1`/`L2` 各得 1 条；误合成 1 条即语义丢失。
//
// 归属（本批 X-3 裁决，禁越界）：**接线归 `e1-stop`**（`lib/index.js`）。本文件只供 `createWakeQueue`
//   被 import，不自带任何 `index.js`/`engine` 依赖，也不读配置 —— 参数全部由调用方注入。
//
// 内存有界（§2.7 回线③）：`drain()` 后 `pending` **回零**（无残留账本）；按 lane 记的进度表
//   (`produced` / `suppressed`) 设显式上限 `MAX_TRACKED_LANES`，满时按 FIFO 淘汰**已耗尽且无 pending** 的最老条目；
//   若无此类候选，淘汰最老条目并在语义上**重置该 lane 的预算**。
//   ⚠ 说明（不隐藏代价）：续跑上界是「同一 lane 的**生命周期**预算」，用于挡住**空转自唤醒**，
//   不是防滥用的账本 —— 调用方若能让 4096 个不同 lane 轮流唤醒，最老 lane 的预算会被淘汰重置。
//   这是有界内存与「永久记账」之间的显式取舍，写在这里供 audit 判；要更强语义须由接线方（`index.js`）落持久账本。

/** 按 lane 记账的上限（显式，非魔法数）：超出即淘汰最老条目，保证内存不随 lane 数无界增长。 */
const MAX_TRACKED_LANES = 4096;

/**
 * 建一个唤醒队列。
 *
 * @param {object} [opts]
 * @param {number} [opts.maxResumes=2] 同一 lane 的 run 产出上界（口径源钉死 2；改成其它值须显式报口径）
 * @param {() => number} [opts.now] 时钟注入（缺省 `Date.now`；供测试注入固定时钟，模块自身不碰全局时间语义）
 * @returns {{
 *   enqueue: (evt: { lane: string, reason?: string, runId?: string }) => { coalesced: boolean, runId: string|null },
 *   drain: () => Array<{ lane: string, runId: string, reason: string|null }>,
 *   isSuppressed: (lane: string) => boolean,
 *   suppressSelf: (lane: string, why?: string) => boolean,
 * }}
 */
export function createWakeQueue({ maxResumes = 2, now = () => Date.now() } = {}) {
  if (!Number.isInteger(maxResumes) || maxResumes < 0) {
    throw new TypeError('wake-queue: maxResumes 必须是非负整数（口径源 = 2）');
  }
  if (typeof now !== 'function') throw new TypeError('wake-queue: now 必须是函数');

  /** lane -> { runId, reason, ts }（未 drain 的待起 run；drain 后**必须**回零） */
  const pending = new Map();
  /** lane -> 已产出的 run 次数（生命周期预算） */
  const produced = new Map();
  /** lane -> 抑制理由（自 block） */
  const suppressed = new Map();
  let seq = 0;

  /** 该 lane 的预算是否已用尽（== 再产出会越过上界）。 */
  const isExhausted = (lane) => (produced.get(lane) ?? 0) >= maxResumes;

  /** 记账前腾位置：满则淘汰「已耗尽且无 pending」的最老条目；再不行淘汰最老条目。 */
  function reserve(lane) {
    if (produced.has(lane) || suppressed.has(lane)) return;
    const tracked = new Set([...produced.keys(), ...suppressed.keys()]);
    if (tracked.size < MAX_TRACKED_LANES) return;
    const ordered = [...tracked];
    const victim = ordered.find((l) => !pending.has(l) && isExhausted(l)) ?? ordered[0];
    produced.delete(victim);
    suppressed.delete(victim);
    // 注：淘汰会重置该 lane 的预算（见文件头「不隐藏代价」段）。
  }

  /**
   * 入队一次唤醒事件。
   * 返回 `{ coalesced, runId }`：
   *   - `coalesced:true` ⇒ 与已在队条目合并（**不会**新增第 2 条 run），`runId` = 合并目标；
   *   - `runId:null` ⇒ 本次**不会**产出 run（被抑制，或该 lane 预算已用尽）。
   */
  function enqueue(evt) {
    const lane = evt?.lane;
    if (typeof lane !== 'string' || lane === '') {
      throw new TypeError('wake-queue: enqueue 需要非空 evt.lane');
    }
    // ① 自 block 抑制 ② 预算用尽 —— 两者都**不产 run**（这是「空转不产新 run」的落点）
    if (suppressed.has(lane) || isExhausted(lane)) return { coalesced: false, runId: null };

    const queued = pending.get(lane);
    if (queued) {
      // coalescing：同 lane 未 drain 前的再次入队**并入**既有一条（reason 以最新为准，runId 保持稳定）
      queued.reason = evt.reason ?? queued.reason;
      return { coalesced: true, runId: queued.runId };
    }

    reserve(lane);
    const runId = typeof evt.runId === 'string' && evt.runId !== '' ? evt.runId : `wake-${(seq += 1)}`;
    pending.set(lane, { runId, reason: evt.reason ?? null, ts: now() });
    return { coalesced: false, runId };
  }

  /**
   * 取走并清空：返回**本轮真正要起的 run 列表**。
   * 每个 lane 至多一条（coalescing 的必然结果）；已抑制 / 预算用尽的 lane **不出现**。
   */
  function drain() {
    if (pending.size === 0) return [];
    const runs = [];
    for (const [lane, item] of pending) {
      pending.delete(lane); // 先删：任何分支都不留残留，保证「drain 后回零」
      if (suppressed.has(lane) || isExhausted(lane)) continue; // 入队后被抑制/耗尽 ⇒ 本轮不起
      reserve(lane);
      produced.set(lane, (produced.get(lane) ?? 0) + 1);
      runs.push({ lane, runId: item.runId, reason: item.reason });
    }
    return runs;
  }

  /** 该 lane 是否处于自 block 抑制态。 */
  function isSuppressed(lane) {
    return suppressed.has(lane);
  }

  /**
   * 显式抑制某 lane 的**自产**唤醒（接线方在「事件由该 lane 自己产生」时调用）。
   * 已排队的自产唤醒**一并撤掉**（不得先唤醒自己再抑制）。幂等。
   */
  function suppressSelf(lane, why = 'self-block') {
    if (typeof lane !== 'string' || lane === '') {
      throw new TypeError('wake-queue: suppressSelf 需要非空 lane');
    }
    reserve(lane);
    suppressed.set(lane, String(why));
    pending.delete(lane);
    return true;
  }

  return { enqueue, drain, isSuppressed, suppressSelf };
}
