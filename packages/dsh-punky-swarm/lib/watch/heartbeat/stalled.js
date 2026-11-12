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

import * as schema from '../../schema.js';
import * as EVT from '../../state/event-types.js';
import { bindingGapOf } from './verdict.js'; // ⑨-2：判定原语真源
import { stintRunningSinceOf } from './primitives.js'; // 纯事件流读取原语（⑨-2 下沉）
import { laneStateOf } from '../../state/lane-state.js'; // 谓词真源（不经门面中转）
import { laneExemptOf, laneKeyOf, mailboxRootForContext } from './context.js';
import {
  baselineTs, batchEntryIndex, freshEntry, hasActivity, markStalled, pendingProbe, probeText, resetEntry,
  touchBatchEntries, touchBatchEntriesByPrefix,
} from './activity.js';
import { recordConsumeObservation } from './evidence.js';
import { longrunScan } from './longrun.js';
import { replayTick } from './replay.js';
import { scanBatchesOnce } from './scan.js';

export function probeTick(cx) {
  if (cx.disposed) return;
  const nowTs = cx.clock();
  // ★ P1：**单趟全库扫描**（longrun / stalled / replay 三档共享一次遍历 + phase 预筛）。
  //   原三趟各自 `readBatch` 全库（longrun 一遍、stalled 又一遍、replay 再一遍）⇒ 实测 210–250 ms/拍
  //   全同步阻塞宿主主线程；现每批**只读一次**。扫描行序与原三趟遍历顺序逐字一致（session 序 → batch 序）。
  //   ⚠ 只改「读几次」：三档判定条件 / 阈值 / 事件 / 播报一字未改，各档候选与语义各自保持。
  const rows = scanBatchesOnce(cx);
  // longrun 档（并列，同 tick 同引擎）：置于心跳扫描之前执行——此时内存 entry 为本 tick 前状态
  // （freshEntry 宽限不污染 lastActivityAt 判定；重启后 entry 缺失 → baselineTs 兜底）。
  if (cx.lrCfg.enabled) longrunScan(cx, nowTs, rows);
  // W1-① 重放/恢复周期兜底（独立于 longrun 档开关：重放不是候选档，watch.longrun.enabled=false 也应兜底）。
  //   不 await（tick 同步语义与既有 watchdog 调用点不变）；异常在 replayTick 内已全程隔离。
  //   目标集合改由**同一趟扫描行**给出（不再单独读盘）——选取规则（前 5 会话 / 仅 running / 至多 20）一字未改。
  cx.replayInFlight = replayTick(cx, rows);
  stalledScan(cx, nowTs, rows);
}

// stalled 档扫描主体（P1：改由扫描行驱动，逐字搬移原 `probeTick` 内层循环；判定与顺序零变更）。
function stalledScan(cx, nowTs, rows) {
  // 预筛跳过批的条目前缀索引（惰性建立：无预筛批时零成本）
  let entryIndex = null;
  for (const row of rows) {
    const { sessionId, batchId, batch } = row;
    if (!batch) {
      if (row.phase !== null) {
        if (entryIndex === null) entryIndex = batchEntryIndex(cx);
        touchBatchEntriesByPrefix(entryIndex, nowTs, sessionId, batchId);
      }
      continue;
    }
    if (schema.isBatchTerminal(batch.phase) || batch.phase === 'planning') {
      // 终态批：**保留悬挂视图**（不再 dropBatchEntries 整批丢态）；planning：不扫成员。
      //   entry 若存在则推进 lastSeenTs（避免解冻后以陈旧基线瞬时判 stalled），但不追问。
      touchBatchEntries(cx, sessionId, batchId, batch, nowTs);
      continue;
    }
    for (const [lane] of Object.entries(batch.lanes ?? {})) {
      const laneKey = laneKeyOf(sessionId, batchId, lane);
      const st = laneStateOf(batch, lane);
      let entry = cx.state.get(laneKey);
      if (entry == null) {
        entry = freshEntry(nowTs);
        entry.lastSeenTs = baselineTs(cx, sessionId, batchId, batch, lane, entry.lastSeenTs);
        cx.state.set(laneKey, entry);
      }
      // U-4：派发后可解析性观测（**观测先于判定**：本 tick 的观测即本 tick 判定的证据）
      recordConsumeObservation(cx, entry, sessionId, batchId, batch, lane, nowTs);
      if (st !== 'running') {
        // 非 running：只保留视图，**不追问**（§2：review/idle/pending 的判据是时长而非无活动）。
        // lastSeenTs 续到「本 lane 已知信号最新时刻」（不是裸 nowTs）——否则下一次 tick 会把**已经
        // 计入基线的那条事件**再判一次「有新活动」（laneEventActivity 用严格 `ts > sinceTs`），
        // 在时钟几乎不前进的场景（同一毫秒内 tick）造成重派后 missed 恒 0（W5 回归）。
        entry.lastSeenTs = Math.max(nowTs, baselineTs(cx, sessionId, batchId, batch, lane, nowTs));
        continue;
      }
      const stintNow = stintRunningSinceOf(batch, lane);
      if (entry.stintRunningSinceTs !== stintNow) {
        resetEntry(entry, nowTs);
        entry.stintRunningSinceTs = stintNow;
        entry.gapReported = null; // D2：新 stint ⇒ 缺口留痕重置（同一缺口每 stint 只报一次）
      }
      // D2 绑定缺口探测（只标记不处置；与 stalled/longrun 同档族、同 tick）
      {
        const gap = bindingGapOf(batch, lane, nowTs, entry.stintRunningSinceTs);
        if (gap.hit && entry.gapReported !== gap.reason) {
          entry.gapReported = gap.reason;
          cx.store.appendEvent(sessionId, batchId, EVT.EVT_LANE_BINDING_GAP, { lane, reason: gap.reason, missed: entry.missedCount });
          void 0;
        }
      }
      // 活动 → 重置回 tier0（W3）
      // 注：hasActivity 现含第 ④ 信号「磁盘进度快照 mtime」，故「worker 直写快照、
      //     不调 lane_checkpoint」的 lane 不再被误报 stalled 追问（两次实测误报的同类修复）。
      if (hasActivity(cx, sessionId, batchId, batch, lane, entry.lastSeenTs, nowTs, st)) { resetEntry(entry, nowTs); continue; }
      // R-4 长程豁免：lane 声明 laneExempt[lane].stalled === true → 本拍不发 inbox probe、
      //   不累计 missedCount、不写 lane.stalled（与 longrun 档的倍率豁免并列的另一半）。
      //   语义边界：仍留在心跳 state 表内（tracked: true，心跳查询照常可见）；
      //   **仍写 checkpoint/心跳**——lane_checkpoint 写面零特判（豁免只关「追问 + stalled 标记」，
      //   不许把 lane 变成不可观测）；豁免撤销后下一拍即回到原追问语义（无粘滞状态）。
      if (laneExemptOf(batch, lane)?.stalled === true) continue;
      // 已 stalled：只标记，停止追问（W2）
      if (entry.stalled) continue;
      // 退避档位：tier = min(missedCount, len-1)，档位单调（W4）
      const tier = Math.min(entry.missedCount, cx.schedule.length - 1);
      if (entry.lastProbeAt !== null && nowTs - entry.lastProbeAt < cx.schedule[tier]) continue;
      // 一拍 = 一次追问轮次；同 lane 至多 1 条 pending（W1），pending 存在则这一拍=已发未答
      const pending = pendingProbe(cx, sessionId, batchId, lane, entry.lastActivityAt);
      if (!pending) {
        const r = cx.mailbox.send(mailboxRootForContext(cx, sessionId, batchId), { type: 'inbox' }, {
          kind: 'probe',
          lane,
          batchId,
          missed: entry.missedCount + 1,
          text: probeText(cx, lane, batchId, entry.missedCount + 1),
        });
        entry.pendingProbeId = r.ackId;
      }
      entry.missedCount += 1;
      entry.lastProbeAt = nowTs;
      // 硬停：连续 N 拍无活动 → lane.stalled（只标记不自动处置，不新增成员状态）
      if (entry.missedCount >= cx.hardStop) markStalled(cx, sessionId, batchId, lane, entry, nowTs);
    }
  }
}
