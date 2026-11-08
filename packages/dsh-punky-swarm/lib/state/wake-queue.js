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

//   整条唤醒队列等于没做，而表面上看不出问题。⇒ 上界必须**真的挡住第 3 次**，而不是只做去重。

/** 按 lane 记账的上限（显式，非魔法数）：超出即淘汰最老条目，保证内存不随 lane 数无界增长。 */
const MAX_TRACKED_LANES = 4096;

/**
 * 建一个唤醒队列。
 * @param {object} [opts]
 * @param {number} [opts.maxResumes=2] 同一 lane 的 run 产出上界（口径源钉死 2；改成其它值须显式报口径）
 * @param {() => number} [opts.now] 时钟注入（缺省 `Date.now`；供测试注入固定时钟，模块自身不碰全局时间语义）
 * @returns {{
 */
export function createWakeQueue({ maxResumes = 2, now = () => Date.now() } = {}) {
  if (!Number.isInteger(maxResumes) || maxResumes < 0) {
    throw new TypeError('wake-queue: maxResumes 必须是非负整数（口径源 = 2）');
  }
  if (typeof now !== 'function') throw new TypeError('wake-queue: now 必须是函数');

  /** lane -> { runId, reason, ts }（未 drain 的待起 run；drain 后**必须**回零） */
  const pending = new Map();
  const produced = new Map();
  const suppressed = new Map();
  let seq = 0;

  const isExhausted = (lane) => (produced.get(lane) ?? 0) >= maxResumes;

  function reserve(lane) {
    if (produced.has(lane) || suppressed.has(lane)) return;
    const tracked = new Set([...produced.keys(), ...suppressed.keys()]);
    if (tracked.size < MAX_TRACKED_LANES) return;
    const ordered = [...tracked];
    const victim = ordered.find((l) => !pending.has(l) && isExhausted(l)) ?? ordered[0];
    produced.delete(victim);
    suppressed.delete(victim);
  }

        /**
   * 入队一次唤醒事件。
   */
  function enqueue(evt) {
    const lane = evt?.lane;
    if (typeof lane !== 'string' || lane === '') {
      throw new TypeError('wake-queue: enqueue 需要非空 evt.lane');
    }
    if (suppressed.has(lane) || isExhausted(lane)) return { coalesced: false, runId: null };

    const queued = pending.get(lane);
    if (queued) {
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
