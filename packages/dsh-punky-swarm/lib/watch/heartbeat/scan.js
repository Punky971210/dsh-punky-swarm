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

import fs from 'node:fs';

const PHASE_PROBE_BYTES = 512;
const PHASE_RE = /"phase"\s*:\s*"(planning|running|paused|complete|aborted)"/;
// 预筛跳过集 = **沿用既有跳过判据**（不新增）：longrun 档对三态整批跳过；stalled 档对三态只推进条目不扫成员。
//   两档都不需要 batch 对象的成员面 ⇒ 免 parse 后才成立（条目的推进由前缀式实现承担，见 activity.js）。
const PRE_FILTERED_PHASES = new Set(['planning', 'complete', 'aborted']);

// 单趟全库扫描：返回行数组，元素 { sessionId, batchId, phase, batch }
//   · batch 非空 = 已完整解析的批次对象（消费面与 `store.readBatch` 的返回值同形，零形变）；
//   · batch 为 null ∧ phase 非空 = phase 预筛命中（planning/complete/aborted）⇒ **未 parse**；
//   · batch 为 null ∧ phase 为 null = 读取/解析失败（含损坏批/不存在）⇒ 与既有 `!batch` 分支同义。
export function scanBatchesOnce(cx) {
  const rows = [];
  for (const sessionId of cx.store.listSessions()) {
    for (const batchId of cx.store.listBatches(sessionId)) {
      rows.push(probeBatch(cx, sessionId, batchId));
    }
  }
  return rows;
}

function probeBatch(cx, sessionId, batchId) {
  const head = readHead(cx, sessionId, batchId);
  if (head !== null) {
    const phase = topLevelPhaseOf(head);
    if (phase !== null) {
      if (PRE_FILTERED_PHASES.has(phase)) return { sessionId, batchId, phase, batch: null };
      const text = readText(cx, sessionId, batchId);
      if (text !== null) {
        try { return { sessionId, batchId, phase, batch: JSON.parse(text) }; }
        catch { /* 解析失败 ⇒ 回退 readBatch：损坏登记 + 告警仍走既定单点 */ }
      }
    }
  }
  const batch = cx.store.readBatch(sessionId, batchId);
  return { sessionId, batchId, phase: batch ? batch.phase : null, batch: batch ?? null };
}

function readHead(cx, sessionId, batchId) {
  let fd = null;
  try {
    fd = fs.openSync(cx.store.batchFile(sessionId, batchId), 'r');
    const buf = Buffer.allocUnsafe(PHASE_PROBE_BYTES);
    const n = fs.readSync(fd, buf, 0, PHASE_PROBE_BYTES, 0);
    return buf.toString('utf8', 0, n);
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 关闭失败不掩盖读取结果 */ } }
  }
}
function readText(cx, sessionId, batchId) {
  try { return fs.readFileSync(cx.store.batchFile(sessionId, batchId), 'utf8'); } catch { return null; }
}

function topLevelPhaseOf(head) {
  const m = PHASE_RE.exec(head);
  if (!m) return null;
  return depthAt(head, m.index) === 1 ? m[1] : null;
}
// 前缀内的 JSON 结构深度（跳过字符串字面量与转义；只判「层」，不判语法合法性——语法由 JSON.parse 兜底）。
function depthAt(text, end) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (c === 0x5c) escaped = true; // 反斜杠
      else if (c === 0x22) inString = false; // 双引号
      continue;
    }
    if (c === 0x22) inString = true; // 双引号
    else if (c === 0x7b || c === 0x5b) depth++; // { [
    else if (c === 0x7d || c === 0x5d) depth--; // } ]
  }
  return depth;
}
