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

// 心跳**单趟全库扫描**（P1 性能优化：longrun / stalled / replay 三档共享一次遍历 + phase 预筛）
//   改造前：三档各自 `listSessions → listBatches → readBatch` 走一遍全库 —— longrun 一遍、stalled **又**
//   一遍（纯冗余重复读盘）、replay 再一遍（有界：5 session / 20 批）。实测（真实库 28 会话 / 176 批 /
//   8.31 MB）三趟 readBatch 全库 = 210–250 ms/拍，每 60 s 一次、100% 同步阻塞宿主主线程。
//   本模块把「读几次」收敛为**一次**：判定条件 / 阈值 / 事件 / 播报**一字不改**，三档仍各自产出不同候选。
//
// ★ 只改读取与调度（硬约束）：
//   · 本模块**纯读**（fs 读 + 零写面）：不写事件、不写 mailbox、不改成员状态、不改批次相位；
//   · 行序 = `listSessions()` 序 → `listBatches()` 序，与原三趟各自的遍历顺序逐字一致。
//
// ★ phase 预筛（安全约束：**不得造成漏判**）：
//   · 先读文件**前缀**（PHASE_PROBE_BYTES 字节）→ 廉价正则取顶层 `phase` → planning/complete/aborted
//     三态批**不 JSON.parse**（终态批占真实库 90.9%：160/176）；
//   · 未命中 / 命中不在 JSON 顶层 / 前缀读失败 / 完整解析失败 ⇒ **一律回退** `store.readBatch()` 完整读
//     （宁可多 parse 一个，不可漏判一个；损坏批的登记与告警仍走 store 的既有单点，本模块不自建第二套）；
//   · 顶层判据：批 JSON 的顶层 `phase` 由 `createBatch` 写为**第 4 键**（早于 wavePlan / events 等嵌套面），
//     实测真实库 176/176 命中且最大命中下标 140 < 512 ⇒ 前缀读取不改变任何一批的判定结果；
//     嵌套面的同名键（事件载荷里的 phase）由 depth 判据挡下 ⇒ 落回完整解析。
import fs from 'node:fs';

const PHASE_PROBE_BYTES = 512;
// 廉价正则：只认五个合法相位字面量（与 lib/schema.js 的相位集合同源；不匹配 ⇒ 回退）
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

// 单批探测（只读）：前缀读 → 顶层 phase → 命中终态/planning 即免 parse；其余情形一律回退完整读。
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

// 前缀读：只读 PHASE_PROBE_BYTES 字节（不整文件读、不 decode 全文）。
//   读不到（不存在 / 权限 / 路径非法 / 目录占位）⇒ null ⇒ 调用方回退 `store.readBatch`（其既有 missing/损坏语义逐字保留）。
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

// 顶层判定：命中必须落在 JSON **根对象**（depth === 1）上 —— 嵌套面的同名键一律不采信（回退完整解析）。
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
