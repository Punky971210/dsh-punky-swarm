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

// 审计日志 sink：模块级单实例状态（计数面 + 聚合窗口表）。
// 单独成文件的唯一理由：state / aggregateWindows 是**跨节共享的可变单例**，
// 若与任一消费节同处一个文件，拆分必然产生「两份 state」。本文件零依赖、零 import。

// ── 模块级单实例状态（F9 幂等守卫 + 运行期计数面）──

export const state = {
  mounted: false,              // F9：单实例单挂载
  cfg: null,                   // resolveAuditLogConfig 结果快照（挂载期一次性解析）
  sinkDir: '',
  diagnosticsDir: '',
  diagnosticsPath: '',
  filename: '',
  segment: 0,                  // 0 = 当日主卷；1.. = 分卷
  segmentBytes: 0,
  maxSegmentSeen: 0,           // 接管既有分卷用（进程内单调，不回退）
  attempts: 0,
  writes: 0,
  failures: 0,
  consecutiveFailures: 0,
  skippedByBreaker: 0,
  sinkErrorRecords: 0,
  sinkErrorRecordsFailed: 0,
  stderrNotices: 0,            // 【Q-19b】已**发起**的 stderr 告警条数（含 write 自身失败；硬上限 MAX_STDERR_NOTICES）
  stderrNoticedKeys: [],       // 【Q-19b】已发起的告警键（幂等去重，防同一站点重复）
  truncatedLines: 0,
  stdoutWrites: 0,
  messagesSeen: 0,
  formatFallbacks: 0,          // 内核 Logger.format 抛出、由本地同源渲染兜底的次数
  filteredByLevel: 0,          // sink 侧阈值过滤掉的行数（层级分离的可观测面）
  collapsedMessages: 0,        // 被聚合折叠（未逐行落盘）的**消息**数
  aggregateRows: 0,            // 产出的 log-aggregate 闭环行数（含写失败的那次，见 closeAggregateWindow）
  lastError: null,
  diagnosticsWritten: false,
  // 【D-16-②】最近一次目录扫描的 stray 读数（不含分卷名的常规文件）：挂载期实测，
  //   计入总量上限、进诊断面、并支撑「默认识别但不删」的裁决面。零 IO，只是读数快照。
  strays: { count: 0, bytes: 0, names: [], pruneOptIn: false },
  // 【c7-cutoff-param】挂载期注入的 warn 通道（mountAuditLog 的 opts.warn）：供 `pruneByAge`
  //   在畸形基准日时外显一条告警。未挂载时保持 no-op ⇒ 清理的旁路告警不制造噪声。
  warn: () => {},
};

/**
 * 聚合窗口表：aggKey → {aggKey, first, startAt, lastTs, windowEnd, count, sealed}。
 * 模块级单实例（与 state 同生命周期），**零定时器**：窗口只在下一次同键到达 / exit / flushDiagnostics 时闭合。
 */
export const aggregateWindows = new Map();