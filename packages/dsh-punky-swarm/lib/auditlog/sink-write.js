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

// 审计日志 sink：落盘写入路径（stdout 开关 + 分卷接管 + 断路 + 失败标注）。
// 不含 export()：export() 需要聚合入口，聚合又需要 writeLine，
// 二者同处一个文件会形成 sink-aggregate ⇄ sink-write 环（核实阶段实测到的环）。

import fs from 'node:fs';
import { state } from './sink-state.js';
import { BREAKER_THRESHOLD, BREAKER_PROBE_INTERVAL, MAX_SINK_ERROR_RECORDS, MAX_STDERR_NOTICES, MAX_STDERR_ERROR_CHARS, PRUNE_EVERY_WRITES, MAX_ROTATE_ATTEMPTS, localDateKey, truncateText, recordError, capRecord, buildSinkErrorRow } from './sink-format.js';
import { segmentPath, currentSegmentPath, fileBytesOrNull, pruneByAge, pruneByTotal } from './sink-retention.js';
import { noteFirstFailure } from './sink-diag.js';

// ── 写入路径──

export function stdoutWrite(rec) {
  if (!state.cfg?.stdout) return;                 // 默认关 → 零调用
  try {
    process.stdout.write(JSON.stringify(rec) + '\n');
    state.stdoutWrites += 1;
  } catch (error) {
    recordError(error);
  }
}

function noticeStderr(key, body) {
  if (state.stderrNotices >= MAX_STDERR_NOTICES) return;
  if (state.stderrNoticedKeys.includes(key)) return;
  state.stderrNoticedKeys.push(key);
  state.stderrNotices += 1;          // 先记账（含随后 write 失败的情形），保证「上限」在异常下仍收敛
  try {
    if (process.stderr && typeof process.stderr.write === 'function') {
      const oneLine = String(body).replace(/[\r\n]+\s*/g, ' ');   // 单行契约：无换行、无栈缩进
      process.stderr.write('[punky-auditlog] ' + oneLine + '\n');
    }
  } catch { /* 不自噬：stderr 自身失败不再记，也不外抛 */ }
}

export function writeSinkError(textValue) {
  // 降级记账有界——前 MAX_SINK_ERROR_RECORDS 条 + 此后每 BREAKER_PROBE_INTERVAL 次尝试最多 1 条
  if (state.sinkErrorRecords >= MAX_SINK_ERROR_RECORDS
      && state.attempts % BREAKER_PROBE_INTERVAL !== 0) return;
  const rec = buildSinkErrorRow(textValue);
  stdoutWrite(rec);
  try {
    const { line } = capRecord(rec);
    fs.appendFileSync(currentSegmentPath(), line + '\n', { encoding: 'utf8' });
    state.sinkErrorRecords += 1;
  } catch (error) {
    state.sinkErrorRecordsFailed += 1;            // 失败面不自噬：只计数
    // 【Q-19b】降级路径的最后一跳必须可见：首条 append 失败写一次 stderr（另一条见 annotateFailure 的跳闸行）
    noticeStderr('sink-append-failed',
      'sink append failed: path=' + currentSegmentPath()
      + ' attempts=' + state.attempts
      + ' failures=' + state.failures
      + ' error=' + truncateText(String(error?.message ?? error), MAX_STDERR_ERROR_CHARS));
  }
}

function annotateFailure(error, phase) {
  state.failures += 1;
  state.consecutiveFailures += 1;
  recordError(error);
  writeSinkError(phase + ': ' + state.lastError);
  noteFirstFailure();
  // 【Q-19b】断路器跳闸（首次达到阈值）同样必须可见；`===` 与「首次达到」逐字等价（consecutiveFailures 成功即归零）。
  // 放在 writeSinkError 之后 ⇒ stderr 顺序恒为「首失败行 → 跳闸行」；键幂等保证只出一次（1000 次探活点不再刷屏）。
  if (state.consecutiveFailures === BREAKER_THRESHOLD) {
    noticeStderr('sink-breaker-tripped',
      'sink breaker tripped: consecutiveFailures=' + state.consecutiveFailures + '/' + BREAKER_THRESHOLD
      + ' ⇒ 后续写盘仅计数，每 ' + BREAKER_PROBE_INTERVAL + ' 次尝试探活一次'
      + ' sinkPath=' + currentSegmentPath()
      + ' lastError=' + truncateText(String(state.lastError ?? ''), MAX_STDERR_ERROR_CHARS));
  }
}

/** 断路判定：连续失败 ≥ 3 后，只累计 skippedByBreaker；每 1000 次尝试放行一次探活 */
function shouldSkipByBreaker() {
  if (state.consecutiveFailures < BREAKER_THRESHOLD) return false;
  if (state.attempts % BREAKER_PROBE_INTERVAL === 0) return false;   // 探活放行
  state.skippedByBreaker += 1;
  return true;
}

export function takeoverExistingSegment(day) {
  const mainBytes = fileBytesOrNull(segmentPath(day, 0));
  if (mainBytes === null) {
    state.segment = 0;
    state.segmentBytes = 0;
  } else {
    state.segment = 0;
    state.segmentBytes = mainBytes;
  }
  state.maxSegmentSeen = 1;
  for (let i = 1; i <= MAX_ROTATE_ATTEMPTS; i++) {
    const bytes = fileBytesOrNull(segmentPath(day, i));
    if (bytes === null) break;
    state.segment = i;
    state.segmentBytes = bytes;
    state.maxSegmentSeen = i + 1;
  }
}

/**
 * 写一行进 sink（同步写 L7）。
 * - 单卷上限：写满前一刻切到下一分卷，不删不截不断行；
 * - 行本身大于单卷上限时不切分卷（写了也没用）→ 交由失败面/断路有界处理；
 * - 每 PRUNE_EVERY_WRITES 行成功写触发一次清理（清理时机③）。
 */
export function writeLine(line) {
  state.attempts += 1;

  if (shouldSkipByBreaker()) return;              // 断路：不再触碰文件系统

  if (Buffer.byteLength(line, 'utf8') > state.cfg.maxFileBytes) {
    annotateFailure(new Error('line exceeds maxFileBytes (' + state.cfg.maxFileBytes + ')'), 'oversize line');
    return;
  }

  const lineBytes = Buffer.byteLength(line, 'utf8');

  try {
    if (state.segmentBytes + lineBytes > state.cfg.maxFileBytes) {
      // 分卷探测上界：需同时满足
      //   ① 不越过「下一个尚未创建的分卷」（maxSegmentSeen）——未创建分卷即 0 字节，必能容纳；
      //   ② 上界不得低于 segment+1（否则「该轮换却不轮换」→ 误判「无处可写」，实测缺陷见 changes.md）；
      //   ③ 「一个卷至少装得下 lineBytes」的数学上界只用于**限制探测次数**，不参与下界裁剪。
      const perFileLimit = Math.floor(state.cfg.maxFileBytes / lineBytes);
      const upper = Math.max(state.segment + 1, Math.min(state.maxSegmentSeen, perFileLimit));
      const day = localDateKey(new Date());
      let rotated = false;
      for (let i = state.segment + 1; i <= upper; i++) {
        const bytes = fileBytesOrNull(segmentPath(day, i)) ?? 0;
        if (bytes + lineBytes <= state.cfg.maxFileBytes) {
          state.segment = i;
          state.segmentBytes = bytes;
          if (i >= state.maxSegmentSeen) state.maxSegmentSeen = i + 1;
          rotated = true;
          break;
        }
      }
      if (!rotated) {
        annotateFailure(new Error('no segment with room below maxFileBytes (' + state.cfg.maxFileBytes + ')'), 'rotate');
        return;
      }
      pruneByAge(state.sinkDir, state.cfg.keepDays);   // 清理时机②：分卷切换时一次
    }
    const target = currentSegmentPath();
    fs.appendFileSync(target, line + '\n', { encoding: 'utf8' });   // L7 同步写
    state.segmentBytes += lineBytes + 1;                            // +1 = LF
    state.writes += 1;
    state.consecutiveFailures = 0;                                  // 成功即解除断路器
  } catch (error) {
    annotateFailure(error, 'append failed');
    return;
  }

  if (state.writes % PRUNE_EVERY_WRITES === 0) {                    // 清理时机③
    pruneByAge(state.sinkDir, state.cfg.keepDays);
    // 【sink 三态 · 显式登记**未接**】本处作用域（写路径）**取不到 logger**（该函数只持 `state`，
    //   logger 在挂载函数作用域内（见 sink.js 的 mountAuditLog），且包定 `pruneByTotal` 签名不改 ⇒ **本调用点不传 logger**，
    //   故写路径触发的「不可读」本轮**仍静默**（挂载期可辨）。禁假装接了。
    const pruned = pruneByTotal(state.sinkDir, state.cfg.maxTotalBytes, { pruneStray: state.cfg.pruneStray });
    state.strays = pruned.strays;                                   // 诊断面读数随清理刷新
  }
}