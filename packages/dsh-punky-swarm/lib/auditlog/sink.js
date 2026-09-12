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

// 审计日志 sink（进程级 cordis logger exporter）——`dsh-punky-swarm` 包内正式模块
//
// 契约来源：plan/spec.md（批次 punky-auditlog-impl-m1）。锁定口径落地对照：
//   L1 exporter.levels **固定** {default:3}（不得由配置下调）→ 审计阈值由 sink 侧自过滤（§七 7.1）
//   L2 文件 sink 为主；stdout 仅开关（PUNKY_LOGGER_STDOUT，默认关）、不 fallback（§五 5.2 / D-3）
//   L3 落点 <DSH_HOME>/logs/punky-swarm/audit-<本地日期>.jsonl，不在会话工作区、不在交付白名单根内（§三）
//   L4 挂载只能代码内 → 唯一入口 mountAuditLog(ctx, { root, config })，由 lib/index.js apply 调用
//   L5 自持开关，**绝不调用 exporter 的 disposer**（内核缺陷：销毁 e1 会连带杀掉 e2）
//   L6 export() 整体 try/catch，**绝不 rethrow**（内核 logger 的派发循环无保护）
//   L7 同步写（fs.appendFileSync）——不依赖内核退出 flush（createWriteStream + process.exit 会丢全部内容）
//   L8 单行 ≤ 32 KiB，两段截断（① args 段 ② msg 段），截断留可见标记
//   L9 降级有界（含短路断路器 + 诊断面上限 + 非自噬）
//   L10 零远程上报（本文件仅 node:fs / node:path / node:os / node:@deepseek-ai/cordis 的 Logger.format）
//
// 写域边界：本模块**只**写 sink 根与其 diagnostics 子目录（§三 3.3），不写会话工作区、不写引擎产物根。

import fs from 'node:fs';
import path from 'node:path';
import { Logger } from '@deepseek-ai/cordis';
import { resolveAuditLogConfig } from './config.js';

// ── 常量（数值为 spec §四 明确口径，README/测试与之逐字一致）──

const V = 1;                                 // 行版本
const KIND_LOG = 'log';
const KIND_SINK_ERROR = 'sink-error';
const DEFAULT_NAME = 'root';
const ENGINE_NAME = 'dsh-punky-swarm';

/** L8 单行硬上限（字节） */
export const MAX_LINE_BYTES = 32768;
/** L8 ① args 段单值裁剪阈值（字符） */
export const MAX_LONG_ARG_CHARS = 512;
/** D-5 连续失败 N 次 → 断路 */
export const BREAKER_THRESHOLD = 3;
/** D-5 断路后每 N 次尝试放行 1 次探活 */
export const BREAKER_PROBE_INTERVAL = 1000;
/** D-5 `kind:"sink-error"` 记录上限 */
export const MAX_SINK_ERROR_RECORDS = 3;
/** D-4/D-5 诊断面 lastError 截断长度 */
export const MAX_ERROR_CHARS = 500;
/** 清理（readdirSync + statSync）频率：每 N 行写成功一次（§四 清理时机③） */
const PRUNE_EVERY_WRITES = 1000;
/** 总量超限时删到低于上限的比例（§四） */
const TOTAL_TARGET_RATIO = 0.9;
/** 单次清理扫描的卷数上界（防御式上限，正常量级 ≪ 该值） */
const MAX_PRUNE_SCAN = 5000;
/** 分卷接管时最多尝试的分卷序号（防御超大单行的死循环） */
const MAX_ROTATE_ATTEMPTS = 10000;

/** 级别数值映射（自建表，与内核枚举同值但**不 import 内核枚举**——§七 7.1） */
const LEVEL_BY_TYPE = { error: 0, warn: 1, info: 2, debug: 3 };

const DAY_MS = 86400000;

// ── 模块级单实例状态（F9 幂等守卫 + 运行期计数面）──

const state = {
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
  truncatedLines: 0,
  stdoutWrites: 0,
  messagesSeen: 0,
  formatFallbacks: 0,          // 内核 Logger.format 抛出、由本地同源渲染兜底的次数
  filteredByLevel: 0,          // sink 侧阈值过滤掉的行数（层级分离的可观测面）
  lastError: null,
  diagnosticsWritten: false,
};

/**
 * 供测试与排障读取的运行期计数快照（只读投影，不改变状态）。
 */
export function auditlogStats() {
  return {
    mounted: state.mounted,
    sinkDir: state.sinkDir,
    diagnosticsDir: state.diagnosticsDir,
    filename: state.filename,
    segment: state.segment,
    attempts: state.attempts,
    writes: state.writes,
    failures: state.failures,
    consecutiveFailures: state.consecutiveFailures,
    skippedByBreaker: state.skippedByBreaker,
    sinkErrorRecords: state.sinkErrorRecords,
    sinkErrorRecordsFailed: state.sinkErrorRecordsFailed,
    truncatedLines: state.truncatedLines,
    stdoutWrites: state.stdoutWrites,
    messagesSeen: state.messagesSeen,
    formatFallbacks: state.formatFallbacks,
    filteredByLevel: state.filteredByLevel,
    lastError: state.lastError ? state.lastError.slice(0, MAX_ERROR_CHARS) : null,
  };
}

// ── 基础工具 ──

/** 本地日期 YYYY-MM-DD（§三 3.3：面向用户排障，与 Windows 文件时间同口径；非原型 UTC） */
function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function toMessageString(v) {
  if (v === null || v === undefined) return String(v);
  return typeof v === 'string' ? v : String(v);
}

function truncateText(s, max) {
  const str = toMessageString(s);
  return str.length > max ? str.slice(0, max) : str;
}

/** 按 UTF-8 字节预算截断字符串（不切断代理对之外的语义：按 Buffer 切再回转） */
function truncateUtf8(s, budgetBytes) {
  const str = toMessageString(s);
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= budgetBytes) return str;
  return buf.subarray(0, Math.max(0, budgetBytes)).toString('utf8');
}

function recordError(error) {
  const raw = (error && error.stack) ? error.stack : error;
  state.lastError = truncateText(raw, MAX_ERROR_CHARS);
}

// ── L8 行上限：两段截断 ──

function serializeArg(a) {
  if (a instanceof Error) return { name: a.name, message: a.message, stack: a.stack };
  if (a === null || typeof a !== 'object') return a;
  try {
    const clone = JSON.parse(JSON.stringify(a));
    return clone === undefined ? String(a) : clone;
  } catch {
    return '<unserializable>';
  }
}

/** 行长上限（L8）：① 先裁 args 段；② 仍超限则裁 msg 段尾部。
 * 截断标记在重新序列化**之前**落到对象上（否则正文里仍是 false——原型 §5-S4 教训）。
 * @returns {{line: string, truncated: boolean}}
 */
function capRecord(rec) {
  let line = JSON.stringify(rec);
  if (Buffer.byteLength(line, 'utf8') <= MAX_LINE_BYTES) return { line, truncated: false };

  rec.truncated = true;

  // ① args 段：超长字符串与超长 Error.stack 走可见占位符
  if (Array.isArray(rec.args)) {
    rec.args = rec.args.map((a) => {
      if (typeof a === 'string') {
        return Buffer.byteLength(a, 'utf8') > MAX_LONG_ARG_CHARS ? '<truncated>' : a;
      }
      if (a && typeof a === 'object' && typeof a.stack === 'string') {
        return { name: a.name, message: a.message, stack: '<truncated>' };
      }
      let json = '';
      try { json = JSON.stringify(a) ?? ''; } catch { return '<unserializable>'; }
      return json.length > MAX_LONG_ARG_CHARS ? '<truncated>' : a;
    });
  }
  line = JSON.stringify(rec);
  if (Buffer.byteLength(line, 'utf8') <= MAX_LINE_BYTES) return { line, truncated: true };

  // ② msg 段：尾部截断 + 可见标记（标记必须留在正文里）。
  //    本阶段的可达条件（实测口径）：单行的**转义膨胀**（\n → \\n 等）使行长超 32 KiB——
  //    因为内核 Logger.format 的 `maxLength` 只裁单个行（L8 原型已实证），不含转义的纯长行
  //    会在 ① 阶段就被整体替换为 <truncated>。此处按 overshoot 二分收敛，保证标记留在尾部且行 ≤ 上限。
  const marker = '...[truncated]';
  let probe = line;                                   // 复用 ① 之后的序列化结果
  for (let i = 0; i < 32; i++) {
    const bytes = Buffer.byteLength(probe, 'utf8');
    if (bytes <= MAX_LINE_BYTES) break;
    const current = Buffer.byteLength(rec.msg ?? '', 'utf8');
    // 保守换算：msg 少 1 字节至少让行长少 1 字节（转义只会让膨胀比 ≥ 1）→ 按 overshoot 线性回收
    const next = truncateUtf8(rec.msg ?? '', Math.max(1, current - (bytes - MAX_LINE_BYTES)));
    if (next === rec.msg) break;                      // 已到极限（不能再裁）
    rec.msg = next + marker;
    probe = JSON.stringify(rec);
  }
  return { line: probe, truncated: true };
}

// ── 行构造 ──

/** 永不抛的 JSON 序列化（循环引用/BigInt → 可见标记） */
function safeJson(value) {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? String(value) : s;
  } catch {
    return '<unserializable>';
  }
}

/** 本地同源渲染（仅在内核渲染抛出时使用；%s/%d/%i/%f/%o 语义与内核 defaultFormatters 一致） */
function fallbackFormat(args) {
  const list = Array.isArray(args) ? args.slice() : [];
  if (list.length === 0) return '';
  let format;
  if (list[0] instanceof Error) {
    format = String(list[0].stack || list[0].message);
    list.unshift('%s');
  } else if (typeof list[0] !== 'string') {
    list.unshift('%o');
  }
  format = toMessageString(list.shift());
  format = format.replace(/%([a-zA-Z%])/g, (match, char) => {
    if (match === '%%') return '%';
    const value = list.shift();
    if (char === 's') return String(value);
    if (char === 'd' || char === 'i') return String(Math.trunc(Number(value)));
    if (char === 'f') return String(Number(value));
    if (char === 'o' || char === 'O') return safeJson(value);
    if (char === 'c') return '';
    return match;
  });
  for (let value of list) {
    if (typeof value === 'object' && value !== null) value = safeJson(value);
    format += ' ' + String(value);
  }
  return format;
}

/**
 * 内核 `Logger.format` 的安全包装。
 *
 * **实测缺陷（本批新发现，spec §十四 U8 的延伸）**：内核 `Logger.format` 的 `%o/%O` 格式化器直接
 * `JSON.stringify(value)` 且**无 try 保护**（cordis `lib/index.js:405/441`）——传入循环引用 / BigInt 实参时
 * 从 `Logger.format` 抛出，异常会穿到 `ctx.logger.*` 调用点，与 L6「绝不 rethrow」的口径锚点冲突。
 * 故此处把渲染**整体**包进 try：成功用内核渲染结果（与宿主日志逐字一致）；失败降级为本地同源渲染，
 * 行本身照常落盘（可观测），异常不外抛。
 */
function safeFormat(message, rawArgs) {
  try {
    return Logger.format({ colors: false, maxLength: 10240 }, { ...message, args: rawArgs });
  } catch (error) {
    recordError(error);
    state.formatFallbacks += 1;
    return fallbackFormat(rawArgs);
  }
}

/**
 * 构造一条审计记录（10 字段契约：v/ts/level/name/msg/args/sn/truncated/pid/kind）。
 * `msg` 经内核 `Logger.format` 渲染（printf 占位符替换结果与宿主日志逐字一致）。
 * @param {object} message cordis logger 消息 { sn, ts, type, level, name, args }
 */
export function buildRow(message) {
  const m = message ?? {};
  const rawArgs = Array.isArray(m.args) ? m.args : [];
  const rec = {
    v: V,
    ts: new Date(typeof m.ts === 'number' ? m.ts : Date.now()).toISOString(),
    level: typeof m.type === 'string' ? m.type : String(m.type),
    name: (typeof m.name === 'string' && m.name) ? m.name : DEFAULT_NAME,
    msg: safeFormat(m, rawArgs),
    args: rawArgs.map(serializeArg),
    sn: typeof m.sn === 'number' ? m.sn : -1,
    truncated: false,
    pid: process.pid,
    kind: KIND_LOG,
  };
  return rec;
}

/** sink 自产诊断行（kind=sink-error），同样走行长上限与 stdout 开关 */
function buildSinkErrorRow(textValue) {
  const rec = {
    v: V,
    ts: new Date().toISOString(),
    level: KIND_SINK_ERROR,
    name: ENGINE_NAME,
    msg: truncateText(textValue, MAX_ERROR_CHARS),
    args: [],
    sn: 0,
    truncated: false,
    pid: process.pid,
    kind: KIND_SINK_ERROR,
  };
  return rec;
}

// ── 分卷路径 ──

function segmentPath(day, segment) {
  return segment === 0
    ? path.join(state.sinkDir, 'audit-' + day + '.jsonl')
    : path.join(state.sinkDir, 'audit-' + day + '.' + segment + '.jsonl');
}

function mainSegmentPath() {
  return segmentPath(localDateKey(new Date()), 0);
}

function currentSegmentPath() {
  return segmentPath(localDateKey(new Date()), state.segment);
}

function fileBytesOrNull(p) {
  try { return fs.statSync(p).size; } catch { return null; }
}

// ── 清理（保留天数 + 总量上限）──

function parseSegmentName(name) {
  const m = /^audit-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/.exec(name);
  if (!m) return null;
  return { day: m[1], segment: m[2] ? Number(m[2]) : 0 };
}

function todayCutoffDay(keepDays) {
  return localDateKey(new Date(Date.now() - keepDays * DAY_MS));
}

/**
 * 保留天数清理（§四）：按**分卷名内日期**判定，早于「今天 - keepDays」的已收盘卷删除。
 * 当日的分卷（当日任意卷）恒不删。
 * @returns {number} 删除的文件数
 */
export function pruneByAge(sinkDir, keepDays, today = localDateKey(new Date())) {
  const cutoff = todayCutoffDay(keepDays);
  let removed = 0;
  let names;
  try { names = fs.readdirSync(sinkDir); } catch { return 0; }
  for (const name of names) {
    const meta = parseSegmentName(name);
    if (!meta) continue;
    if (meta.day === today) continue;        // 当日卷（含当日分卷）不按天龄清理
    if (meta.day < cutoff) {
      try { fs.unlinkSync(path.join(sinkDir, name)); removed++; } catch { /* 删除失败不阻断写路径 */ }
    }
  }
  return removed;
}

/**
 * 总量上限清理（§四）：超 maxTotalBytes 时按 **mtime 从旧到新** 删到低于上限的 90%。
 * @returns {number} 删除的文件数
 */
export function pruneByTotal(sinkDir, maxTotalBytes) {
  let names;
  try { names = fs.readdirSync(sinkDir); } catch { return 0; }
  const files = [];
  let total = 0;
  for (const name of names.slice(0, MAX_PRUNE_SCAN)) {
    if (!parseSegmentName(name)) continue;
    const p = path.join(sinkDir, name);
    try {
      const st = fs.statSync(p);
      files.push({ p, size: st.size, mtimeMs: st.mtimeMs });
      total += st.size;
    } catch { /* 读不到就不计入 */ }
  }
  if (total <= maxTotalBytes) return 0;
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const target = Math.floor(maxTotalBytes * TOTAL_TARGET_RATIO);
  let removed = 0;
  for (const f of files) {
    if (total <= target) break;
    try { fs.unlinkSync(f.p); total -= f.size; removed++; } catch { /* 单个失败继续 */ }
  }
  return removed;
}

// ── D-4 诊断面 ──

function writeDiagnostics(note) {
  if (!state.diagnosticsPath) return;
  if (state.failures === 0 && state.sinkErrorRecordsFailed === 0) return;
  try {
    const snapshot = {
      v: V,
      ts: new Date().toISOString(),
      note: note || 'unknown',
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
      lastError: state.lastError ? state.lastError.slice(0, MAX_ERROR_CHARS) : null,
    };
    fs.mkdirSync(state.diagnosticsDir, { recursive: true });
    fs.writeFileSync(state.diagnosticsPath, JSON.stringify(snapshot, null, 2), { encoding: 'utf8' });
  } catch { /* 诊断面自身失败静默——D-5③ 降级路径不放大 */ }
}

function noteFirstFailure() {
  if (state.failures > 0 && !state.diagnosticsWritten) {
    state.diagnosticsWritten = true;
    writeDiagnostics('first-failure');
  }
}

// ── 写入路径（D-2 / D-3 / D-5）──

function stdoutWrite(rec) {
  if (!state.cfg?.stdout) return;                 // 默认关 → 零调用
  try {
    process.stdout.write(JSON.stringify(rec) + '\n');
    state.stdoutWrites += 1;
  } catch (error) {
    recordError(error);
  }
}

function writeSinkError(textValue) {
  // D-5：降级记账有界——前 MAX_SINK_ERROR_RECORDS 条 + 此后每 BREAKER_PROBE_INTERVAL 次尝试最多 1 条
  if (state.sinkErrorRecords >= MAX_SINK_ERROR_RECORDS
      && state.attempts % BREAKER_PROBE_INTERVAL !== 0) return;
  const rec = buildSinkErrorRow(textValue);
  stdoutWrite(rec);
  try {
    const { line } = capRecord(rec);
    fs.appendFileSync(currentSegmentPath(), line + '\n', { encoding: 'utf8' });
    state.sinkErrorRecords += 1;
  } catch {
    state.sinkErrorRecordsFailed += 1;            // 失败面不自噬：只计数（D-5③）
  }
}

function annotateFailure(error, phase) {
  state.failures += 1;
  state.consecutiveFailures += 1;
  recordError(error);
  writeSinkError(phase + ': ' + state.lastError);
  noteFirstFailure();
}

/** D-5 断路判定：连续失败 ≥ 3 后，只累计 skippedByBreaker；每 1000 次尝试放行一次探活 */
function shouldSkipByBreaker() {
  if (state.consecutiveFailures < BREAKER_THRESHOLD) return false;
  if (state.attempts % BREAKER_PROBE_INTERVAL === 0) return false;   // 探活放行
  state.skippedByBreaker += 1;
  return true;
}

/**
 * 接管既有分卷（§四「只 append、永不改写」，单调不回退）：
 * 启动时若当日主卷+分卷已存在，从最大序号续写；进程内 segment 只增不减。
 */
function takeoverExistingSegment(day) {
  const mainBytes = fileBytesOrNull(segmentPath(day, 0));
  if (mainBytes === null) {
    state.segment = 0;
    state.segmentBytes = 0;
  } else {
    state.segment = 0;
    state.segmentBytes = mainBytes;
  }
  // 探测既有分卷上界（接管语义：从已存在的分卷续写、不回退；无既有分卷时 maxSegmentSeen = 1）
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
 * - 单卷上限（§四）：写满前一刻切到下一分卷，不删不截不断行；
 * - 行本身大于单卷上限时不切分卷（写了也没用）→ 交由失败面/断路有界处理（D-2/D-5）；
 * - 每 PRUNE_EVERY_WRITES 行成功写触发一次清理（§四 清理时机③）。
 */
function writeLine(line) {
  state.attempts += 1;

  if (shouldSkipByBreaker()) return;              // D-5 断路：不再触碰文件系统

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
      pruneByAge(state.sinkDir, state.cfg.keepDays);   // §四 清理时机②：分卷切换时一次
    }
    const target = currentSegmentPath();
    fs.appendFileSync(target, line + '\n', { encoding: 'utf8' });   // L7 同步写
    state.segmentBytes += lineBytes + 1;                            // +1 = LF
    state.writes += 1;
    state.consecutiveFailures = 0;                                  // 成功即解除断路器（D-5①）
  } catch (error) {
    annotateFailure(error, 'append failed');
    return;
  }

  if (state.writes % PRUNE_EVERY_WRITES === 0) {                    // §四 清理时机③
    pruneByAge(state.sinkDir, state.cfg.keepDays);
    pruneByTotal(state.sinkDir, state.cfg.maxTotalBytes);
  }
}

// ── L6 export()：整体 try/catch，绝不 rethrow ──

/**
 * 审计级别数值：按**消息类型名**映射（口径与 spec §七 7.1 的 `error=0,warn=1,info=2,debug=3` 逐字一致，
 * 与内核方法序数同值）。**故意不使用 `message.level`**——见下方规范注释。
 */
function levelNumberOf(message) {
  const type = message?.type;
  if (typeof type === 'string' && Object.prototype.hasOwnProperty.call(LEVEL_BY_TYPE, type)) {
    return LEVEL_BY_TYPE[type];
  }
  return LEVEL_BY_TYPE.info;
}

/**
 * sink 侧审计阈值判定（阈值语义：0=只收 error，1=收 error+warn，2=+info，3=+debug）。
 *
 * **实测口径（本批关键）**：内核 `logger.warn()` 构造消息时 `level` 取的是**内核方法序数**
 * （cordis `logger.ts`: error=0,info=1,warn=2,debug=3 —— 源码注解的 "WARN=2" 即 `LoggerLevel` 枚举值，
 * 属 `exporter.levels` 过滤用的另一套语义），而 `message.type` 才是方法名。
 * 两个数值域**不一致**（warn 在类型域为 1、在内核序数域为 2）。本模块的审计阈值只认类型域，
 * 因此**只按 `message.type` 映射**，不读 `message.level` —— 否则 `levelsDefault=1` 会连 warn 一起吞掉。
 * （本批 T-B5 两态对照即该口径的判据：L1 需能收到真实 punky warn。）
 */
function passesAuditLevel(message) {
  return levelNumberOf(message) <= state.cfg.levelsDefault;
}

/**
 * exporter 的 export 回调（单条消息）。
 * 任何异常都在此吞掉并记账——调用点（ctx.logger.*）语义零变化（D-6）。
 */
export function exportMessage(message) {
  try {
    if (!state.mounted) return;
    state.messagesSeen += 1;

    // 层级分离（§七 7.1）：内核侧 levels 固定 {default:3} → 全量派发；审计阈值在此过滤
    if (!passesAuditLevel(message)) {
      state.filteredByLevel += 1;
      return;
    }

    let rec;
    let line;
    try {
      rec = buildRow(message);
      const capped = capRecord(rec);
      line = capped.line;
      if (capped.truncated) {
        rec.truncated = true;
        state.truncatedLines += 1;
      }
    } catch (error) {                       // D-2：序列化失败 → 记 sink-error 后返回，不尝试写盘
      recordError(error);
      writeSinkError('serialize failed: ' + state.lastError);
      return;
    }

    stdoutWrite(rec);                       // stdout 只是开关，不是降级面（D-3）
    writeLine(line);
  } catch (error) {                         // L6：绝不 rethrow
    recordError(error);
  }
}

// ── 挂载（L4：唯一入口）──

/**
 * 挂载审计日志 sink（唯一挂载入口；lib/index.js apply() 内调用）。
 *
 * @param {object} ctx cordis 上下文（取 ctx.root.logger ?? ctx.logger）
 * @param {{root?: string, config?: object, env?: Record<string,string|undefined>, home?: string,
 *          warn?: (msg: string) => void}} [opts]
 * @returns {{mounted: boolean, reason?: string, sinkDir?: string, filename?: string}}
 */
export function mountAuditLog(ctx, opts = {}) {
  const warn = typeof opts.warn === 'function' ? opts.warn : () => {};
  const c = resolveAuditLogConfig(opts.config, opts.env ?? process.env, { home: opts.home, warn });

  // §五 5.1 关闭态语义：首行 return——不取 logger、不建目录、不注册 exporter、零字节写入、零定时器
  if (!c.enabled) return { mounted: false, reason: 'disabled' };

  // F9 幂等守卫：单实例单挂载（防多 session 级 apply 重复挂）
  if (state.mounted) return { mounted: false, reason: 'duplicate' };

  const logger = ctx?.root?.logger ?? ctx?.logger;
  // 防御式身份判定：不用 instanceof（探针 P1 实测 ctx.logger instanceof LoggerService === false）
  if (!logger || typeof logger.exporter !== 'function') return { mounted: false, reason: 'no-logger' };

  state.cfg = c;
  state.sinkDir = c.sinkDir;
  state.diagnosticsDir = c.diagnosticsDir;
  state.diagnosticsPath = path.join(c.diagnosticsDir, 'sink-diagnostics.json');
  state.filename = 'audit-' + localDateKey(new Date()) + '.jsonl';
  state.diagnosticsWritten = false;
  state.lastError = null;
  takeoverExistingSegment(localDateKey(new Date()));

  const exporter = {
    colors: false,                       // 不装上色（样例行无 ANSI 转义）
    maxLength: 10240,                    // 仅约束 Logger.format 的单行；行硬上限由 sink 自建（L8）
    levels: { default: 3 },              // L1 硬要求：**固定 3**，不得由配置下调（§七 7.1）
    formatters: undefined,               // 不覆盖内核默认 formatter（%s/%o/%d/%C…）
    export: (message) => exportMessage(message),   // L6 内部整体 try/catch
  };

  let disposer = null;
  try {
    // L5：返回值仅记录，**绝不调用**（内核 disposer 缺陷：销毁 e1 会连带杀掉 e2）
    disposer = logger.exporter(exporter);
  } catch (error) {
    recordError(error);
    state.cfg = null;
    return { mounted: false, reason: 'exporter-register-failed' };
  }
  void disposer;

  try { fs.mkdirSync(state.sinkDir, { recursive: true }); } catch (error) { recordError(error); }
  try { fs.mkdirSync(state.diagnosticsDir, { recursive: true }); } catch (error) { recordError(error); }

  state.mounted = true;

  // §四 清理时机①：挂载时一次
  try {
    pruneByAge(state.sinkDir, c.keepDays);
    pruneByTotal(state.sinkDir, c.maxTotalBytes);
    // 挂载后重新核对当前卷（清理可能删掉了正在接管的分卷）
    const mainBytes = fileBytesOrNull(segmentPath(localDateKey(new Date()), state.segment));
    state.segmentBytes = mainBytes === null ? 0 : mainBytes;
  } catch (error) { recordError(error); }

  // D-4：优雅退出路径落一次诊断面（Stop-Process -Force 不触发 exit，由首失败与每 1000 行兜底）
  try {
    process.on('exit', () => writeDiagnostics('process-exit'));
  } catch (error) { recordError(error); }

  return { mounted: true, sinkDir: state.sinkDir, filename: state.filename };
}

/** 供测试读取当前卷路径（不触发任何写入） */
export function currentSinkPath() {
  return currentSegmentPath();
}

/** 供测试触发一次清理（等价于「每 1000 行」与「分卷切换」两个落盘点） */
export function runPrune() {
  const removedAge = pruneByAge(state.sinkDir, state.cfg?.keepDays ?? 14);
  const removedTotal = pruneByTotal(state.sinkDir, state.cfg?.maxTotalBytes ?? 536870912);
  return { removedAge, removedTotal };
}

/** 供测试触发一次诊断面落盘 */
export function flushDiagnostics(note) {
  writeDiagnostics(note ?? 'manual');
}

/** 主卷（当日 segment 0）路径：给定 sinkDir 与日期键 */
export function sinkFilePath(sinkDir, dateKey = localDateKey(new Date())) {
  return path.join(sinkDir, 'audit-' + dateKey + '.jsonl');
}
