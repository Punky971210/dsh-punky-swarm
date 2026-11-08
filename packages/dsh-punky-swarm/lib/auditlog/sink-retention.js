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

// 审计日志 sink：分卷路径 + 清理（保留天数 / 总量上限 / stray 识别）。
// 只做「sink 目录内文件的命名与删除」，不写审计行本身。

import fs from 'node:fs';
import path from 'node:path';
import { state } from './sink-state.js';
import { MAX_STRAY_NAMES, STRAY_PRUNE_PREFIX, TOTAL_TARGET_RATIO, MAX_PRUNE_SCAN, DAY_MS, DATE_KEY_PATTERN, localDateKey } from './sink-format.js';

// ── 分卷路径 ──

export function segmentPath(day, segment) {
  return segment === 0
    ? path.join(state.sinkDir, 'audit-' + day + '.jsonl')
    : path.join(state.sinkDir, 'audit-' + day + '.' + segment + '.jsonl');
}

export function currentSegmentPath() {
  return segmentPath(localDateKey(new Date()), state.segment);
}

export function fileBytesOrNull(p) {
  try { return fs.statSync(p).size; } catch { return null; }
}

// ── 清理（保留天数 + 总量上限）──

function parseSegmentName(name) {
  const m = /^audit-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/.exec(name);
  if (!m) return null;
  return { day: m[1], segment: m[2] ? Number(m[2]) : 0 };
}

function todayCutoffDay(keepDays, baseToday) {
  return localDateKey(new Date(Date.parse(baseToday + 'T00:00:00') - keepDays * DAY_MS));
}

/**
 * 基准日**入参卫生**（注入面 = `pruneByAge` 第 3 参，本模块唯一的可污染输入）。
 *
 * 为什么必须有：`Date.parse('garbageT00:00:00')` → `NaN` ⇒ cutoff = `'NaN-NaN-NaN'`，
 * 而分卷名内的日期 `'2…' < 'N…'` **恒真** ⇒ **整个目录被判为「早于 cutoff」而清空**
 * （实测：三卷 `removed=3`、目录空）。这是「cutoff 参数化」引入的**新攻击面**。
 *
 * 处置：非 `YYYY-MM-DD` ⇒ 回落真实本地今天 + 一条 warn，**不抛**（清理是写路径的旁路，
 * 不得因旁路入参而中断或抛错）。warn 走**注入的 `opts.warn`**（与 mountAuditLog 的 stray
 * 告警同通道）；**不走 `noticeStderr`** —— stderr 面有「恰 2 行」硬契约
 * （`test/auditlog-sink-stderr.test.js` AC-3），不得新增第三处外显。
 *
 * @param {*} baseToday 候选基准日
 * @param {(msg: string) => void} warn 告警通道（无则静默回落）
 * @returns {string} 合法基准日
 */
function sanitizeBaseDay(baseToday, warn) {
  if (typeof baseToday === 'string' && DATE_KEY_PATTERN.test(baseToday)) return baseToday;
  warn('capabilities.auditlog: pruneByAge 基准日非法（' + String(baseToday) + '）⇒ 回落真实本地今天');
  return localDateKey(new Date());
}

/**
 * 保留天数清理：按**分卷名内日期**判定，早于「基准日 - keepDays」的已收盘卷删除。
 * 当日的分卷（当日任意卷）恒不删。
 * @param {string} [today] 基准日 `YYYY-MM-DD`，**同时**用于「当日」判等与 cutoff 推算
 *   （缺省 = 真实本地今天 ⇒ 与改造前行为一致；两参默认路径由 T-C17 覆盖）
 * @param {{warn?: (msg: string) => void}} [opts] 告警通道（仅畸形基准日会用到；由 T-C18 覆盖）
 * @returns {number} 删除的文件数
 */
export function pruneByAge(sinkDir, keepDays, today = localDateKey(new Date()), opts = {}) {
  // 告警通道优先级：显式注入（测试/调用方）> 挂载期登记的 state.warn > no-op
  const warn = typeof opts.warn === 'function' ? opts.warn : state.warn;
  const baseDay = sanitizeBaseDay(today, warn);      // 注入面卫生：畸形基准日回落真实今天
  const cutoff = todayCutoffDay(keepDays, baseDay);
  let removed = 0;
  let names;
  try { names = fs.readdirSync(sinkDir); } catch { return 0; }
  for (const name of names) {
    const meta = parseSegmentName(name);
    if (!meta) continue;
    if (meta.day === baseDay) continue;        // 当日卷（含当日分卷）不按天龄清理
    if (meta.day < cutoff) {
      try { fs.unlinkSync(path.join(sinkDir, name)); removed++; } catch { /* 删除失败不阻断写路径 */ }
    }
  }
  return removed;
}

/**
 * 目录扫描（清理/诊断面共用的唯一读入口，零写）：把该目录下的**常规文件**分成
 * 「分卷名（`parseSegmentName` 认得）」与「stray（认不得，如 `.bak`）」两桶，并给出全量字节和。
 *
 * 【D-16-② 口径】stray **计入 total**（否则「总量上限」形同虚设：用户备份可以无界堆积），
 * 但**默认不进可删集**（删除须 env opt-in 且限 `audit-` 前缀，见 pruneByTotal）。
 * 目录/链接不算常规文件，不计入 total（避免把诊断子目录也算成日志体积）。
 *
 * @returns {{segments: Array<{p: string, name: string, size: number, mtimeMs: number}>,
 *            strays: Array<{p: string, name: string, size: number, mtimeMs: number}>,
 *            total: number} | null} 读不到目录 ⇒ null（清理不阻断写路径）
 */
function scanSinkDir(sinkDir, logger) {
  let names;
  if (!fs.existsSync(sinkDir)) return null; // 不存在：正常态，零 warn
  try { names = fs.readdirSync(sinkDir); } catch (e) {
    (typeof logger !== 'undefined' ? logger : undefined)?.warn?.('[dsh-punky-swarm] sink-dir-unreadable: '
      + String(sinkDir) + '（' + String(e?.message ?? e) + '）⇒ 清理本轮失效（日志可能无界增长）；'
      + '这是**读不了**，不是「目录不存在」');
    return null;
  }
  const segments = [];
  const strays = [];
  let total = 0;
  for (const name of names.slice(0, MAX_PRUNE_SCAN)) {
    const p = path.join(sinkDir, name);
    let st;
    try { st = fs.statSync(p); } catch { continue; }   // 读不到就不计入
    if (!st.isFile()) continue;                        // 只认常规文件
    const entry = { p, name, size: st.size, mtimeMs: st.mtimeMs };
    total += st.size;
    if (parseSegmentName(name)) segments.push(entry);
    else strays.push(entry);
  }
  return { segments, strays, total };
}

/** stray 读数视图（诊断面字段；names 有界，count/bytes 为全量口径） */
function strayView(strays, pruneOptIn) {
  return {
    count: strays.length,
    bytes: strays.reduce((sum, f) => sum + f.size, 0),
    names: strays.slice(0, MAX_STRAY_NAMES).map((f) => f.name),
    pruneOptIn: pruneOptIn === true,
  };
}

/**
 * 总量上限清理：`total` = 该目录**全部常规文件**字节和（分卷 + stray 一视同仁），
 * 超 `maxTotalBytes` 时按 **mtime 从旧到新** 删到低于上限的 90%。
 *
 * 可删集（**默认只删分卷名**）：
 * - 默认：仅 `parseSegmentName` 认得的已收盘分卷 ⇒ stray（`.bak` 等用户备份）只计数不删；
 * - `opts.pruneStray === true`（来自 config `capabilities.auditlog.pruneStray` / env
 *   `PUNKY_AUDITLOG_PRUNE_STRAY`，缺省关）：把**名字以 `audit-` 开头且分卷名不认**的 stray 一并纳入；
 * - 其余任何文件**永不删**（防误删用户自己放在该目录的东西）。
 *
 * @param {string} sinkDir
 * @param {number} maxTotalBytes
 * @param {{pruneStray?: boolean}} [opts]
 * @returns {{total: number, remaining: number, removed: number,
 *            strays: {count: number, bytes: number, names: string[], pruneOptIn: boolean}}}
 *   `total` = **判定所依据的计入口径**（清理前全部常规文件字节和，分卷 + stray）；
 *   `remaining` = 清理后剩余字节和；`removed` = 实际删除文件数
 */
export function pruneByTotal(sinkDir, maxTotalBytes, opts = {}) {
  const scan = scanSinkDir(sinkDir, opts.logger); // 直接调用点唯一（本文件 pruneByTotal 内）：logger 走 opts
  if (!scan) return { total: 0, remaining: 0, removed: 0, strays: strayView([], opts.pruneStray) };
  const pruneOptIn = opts.pruneStray === true;
  const view = strayView(scan.strays, pruneOptIn);
  const total = scan.total;                 // 计入口径（含 stray）——先读、后删，读数不受删除影响
  if (total <= maxTotalBytes) return { total, remaining: total, removed: 0, strays: view };

  const deletable = scan.segments.slice();
  if (pruneOptIn) {
    for (const f of scan.strays) {
      if (f.name.startsWith(STRAY_PRUNE_PREFIX)) deletable.push(f);
    }
  }
  deletable.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const target = Math.floor(maxTotalBytes * TOTAL_TARGET_RATIO);
  let remaining = total;
  let removed = 0;
  for (const f of deletable) {
    if (remaining <= target) break;
    try { fs.unlinkSync(f.p); remaining -= f.size; removed++; } catch { /* 单个失败继续 */ }
  }
  return { total, remaining, removed, strays: view };
}