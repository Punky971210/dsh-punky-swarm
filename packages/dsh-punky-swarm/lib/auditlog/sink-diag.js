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

// 审计日志 sink：诊断面（快照 + 首失败不可变快照）。
// 位于 retention 之上、write 之下：诊断面要用分卷路径，写入路径要记首失败。

import fs from 'node:fs';
import path from 'node:path';
import { state, aggregateWindows } from './sink-state.js';
import { V, ENGINE_NAME, MAX_ERROR_CHARS, MAX_DIAGNOSTIC_KEYS, FIRST_FAILURE_SNAPSHOT_NAME, MAX_STRAY_NAMES } from './sink-format.js';
import { currentSegmentPath } from './sink-retention.js';

// ── 诊断面 ──

/**
 * 诊断快照**纯构造**（零 IO）：主快照与首失败快照共用同一形态（两文件内容仅 ts/note 可能不同）。
 * @param {string} note 快照事由（`first-failure` / `manual` / `process-exit` / …）
 */
function buildDiagnosticsSnapshot(note) {
  return {
    v: V,
    ts: new Date().toISOString(),
    note,
    pid: process.pid,
    engine: ENGINE_NAME,
    sinkDir: state.sinkDir,
    sinkPath: currentSegmentPath(),
    attempts: state.attempts,
    writes: state.writes,
    failures: state.failures,
    consecutiveFailures: state.consecutiveFailures,
    skippedByBreaker: state.skippedByBreaker,
    sinkErrorRecords: state.sinkErrorRecords,
    sinkErrorRecordsFailed: state.sinkErrorRecordsFailed,
    filteredByLevel: state.filteredByLevel,
    // 聚合面：windowOpen = 此刻仍未闭环的窗口数（>0 即表示这些窗口的 count 只在内存里，见 README B5）；
    // keys 按 count 降序取前 MAX_DIAGNOSTIC_KEYS 条（诊断面自身有界，不随窗口数膨胀）。
    aggregate: {
      windowOpen: aggregateWindows.size,
      collapsedTotal: state.collapsedMessages,
      keys: Array.from(aggregateWindows.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, MAX_DIAGNOSTIC_KEYS)
        .map((w) => ({ aggKey: w.aggKey, count: w.count, windowEnd: new Date(w.windowEnd).toISOString() })),
    },
    // 【D-16-②】stray（分卷名不认的常规文件）读数：已计入总量上限，默认识别但不删。
    strays: {
      count: state.strays.count,
      bytes: state.strays.bytes,
      names: state.strays.names.slice(0, MAX_STRAY_NAMES),
      pruneOptIn: state.strays.pruneOptIn === true,
    },
    lastError: state.lastError ? state.lastError.slice(0, MAX_ERROR_CHARS) : null,
  };
}

/**
 * 首失败**不可变**快照（【D-16-①】）：主快照 `sink-diagnostics.json` 每次 flush 都改写成最新事由，
 * 进程退出钩子（`note='process-exit'`）会覆盖掉首失败现场 ⇒ 首失败必须独立留档。
 *
 * 语义（与「first」逐字对齐）：
 * - 以 `wx`（O_EXCL）打开 ⇒ 只有**第一次**写入能成功；
 * - 已存在（EEXIST）⇒ **静默保留旧文件**（跨进程也取最早那次），不覆盖、不报错；
 * - 其他错误一并吞掉（诊断面自身失败不放大，与主快照同纪律）。
 */
function writeFirstFailureSnapshot(snapshot) {
  try {
    fs.mkdirSync(state.diagnosticsDir, { recursive: true });
    fs.writeFileSync(path.join(state.diagnosticsDir, FIRST_FAILURE_SNAPSHOT_NAME),
      JSON.stringify(snapshot, null, 2), { encoding: 'utf8', flag: 'wx' });
  } catch { /* EEXIST = 已有更早的首失败现场 ⇒ 保留最早；其他错误同吞 */ }
}

export function writeDiagnostics(note) {
  if (!state.diagnosticsPath) return;
  if (state.failures === 0 && state.sinkErrorRecordsFailed === 0) return;
  const snapshot = buildDiagnosticsSnapshot(note || 'unknown');   // 纯构造，零 IO
  try {
    fs.mkdirSync(state.diagnosticsDir, { recursive: true });
    fs.writeFileSync(state.diagnosticsPath, JSON.stringify(snapshot, null, 2), { encoding: 'utf8' });
  } catch { /* 诊断面自身失败静默——降级路径不放大 */ }
  // 【D-16-①】首失败现场独立留档：与主快照的「最新事由」语义**互补**（主快照语义一字未改）
  if (snapshot.note === 'first-failure') writeFirstFailureSnapshot(snapshot);
}

export function noteFirstFailure() {
  if (state.failures > 0 && !state.diagnosticsWritten) {
    state.diagnosticsWritten = true;
    writeDiagnostics('first-failure');
  }
}