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

// 审计日志 sink：常量契约 + 基础工具 + L8 行长上限 + 行构造。
// 本文件的常量数值即**契约口径**（README/测试与之逐字一致），改数值等于改契约。

import { Logger } from '@deepseek-ai/cordis';
import { state } from './sink-state.js';

// ── 常量（数值为本模块契约口径，README/测试与之逐字一致）──

export const V = 1;                                 // 行版本
const KIND_LOG = 'log';
export const KIND_LOG_AGGREGATE = 'log-aggregate';
const KIND_SINK_ERROR = 'sink-error';
const DEFAULT_NAME = 'root';
export const ENGINE_NAME = 'dsh-punky-swarm';

/** L8 单行硬上限（字节） */
export const MAX_LINE_BYTES = 32768;
/** L8 ① args 段单值裁剪阈值（字符） */
export const MAX_LONG_ARG_CHARS = 512;
/** 连续失败 N 次 → 断路 */
export const BREAKER_THRESHOLD = 3;
/** 断路后每 N 次尝试放行 1 次探活 */
export const BREAKER_PROBE_INTERVAL = 1000;
/** `kind:"sink-error"` 记录上限 */
export const MAX_SINK_ERROR_RECORDS = 3;
/** 诊断面 lastError 截断长度 */
export const MAX_ERROR_CHARS = 500;
export const MAX_STDERR_NOTICES = 2;
/** 同上：stderr 告警行内 error 截断长度（不引 MAX_ERROR_CHARS=500，避免单行过长刷屏） */
export const MAX_STDERR_ERROR_CHARS = 200;

/** 聚合窗口默认长度（滑动；模块内常量，非配置键——README 只声明语义与开关，不暴露可配性） */
export const AGGREGATE_WINDOW_MS = 60000;
/** 聚合窗口硬上限（同一窗口最多延续多久；防长跑场景下 count 退化为无界累计计数） */
export const AGGREGATE_MAX_WINDOW_MS = 600000;
/** 闭环行相对首行的**最大**额外字节（kind 值后缀 + count/aggKey 两字段）；余量不足的窗口不聚合 */
export const AGGREGATE_ROW_HEADROOM = 64;
/** 诊断面 aggregate.keys 条数上限（按 count 降序取前 N） */
export const MAX_DIAGNOSTIC_KEYS = 50;

/** 【D-16-①】首失败不可变快照文件名（与主快照**同目录、不同文件**：主快照被后续 flush 覆盖，首失败永不覆盖） */
export const FIRST_FAILURE_SNAPSHOT_NAME = 'sink-diagnostics.first-failure.json';
/** 【D-16-②】诊断面 `strays.names` 条数上限（诊断面自身有界，count/bytes 仍为全量口径） */
export const MAX_STRAY_NAMES = 10;
/** 【D-16-②】opt-in 删除 stray 时**唯一**认的前缀（其余文件永不自动删 —— 不删用户备份） */
export const STRAY_PRUNE_PREFIX = 'audit-';

/** 清理（readdirSync + statSync）频率：每 N 行写成功一次（清理时机③） */
export const PRUNE_EVERY_WRITES = 1000;
/** 总量超限时删到低于上限的比例（清理总账口径） */
export const TOTAL_TARGET_RATIO = 0.9;
/** 单次清理扫描的卷数上界（防御式上限，正常量级 ≪ 该值） */
export const MAX_PRUNE_SCAN = 5000;
/** 分卷接管时最多尝试的分卷序号（防御超大单行的死循环） */
export const MAX_ROTATE_ATTEMPTS = 10000;

/**
 * 审计档位映射（本模块私有表）：以消息**类型名** `error/warn/info/debug` 为键 → 档位 0/1/2/3。
 *
 * 与内核 `LoggerLevel` 的真实关系（回源核对所得，勿凭印象改）：内核那份枚举是**方法序数域**
 * —— cordis `src/logger.ts` 声明 `ERROR=0 / INFO=1 / WARN=2 / DEBUG=3`，`Logger` 构造器把该序数
 * 逐方法内联（`this.error = this._method('error', LoggerLevel.ERROR)` 一段），`_method` 再把该序数
 * 写进消息的 `level` 字段；而同一消息的 `type` 字段存的是**方法名字符串**。两个字段是两条互不相干的
 * 数值/字符串域。本表与内核序数域**数值集合相同**（同为 0..3），但**同名键并不同值**：
 * 本表 `warn=1 / info=2`，内核序数域 `warn=2 / info=1`，两键互换。
 *
 * 因此本表不是内核枚举的副本或镜像，而是本模块自持的「类型名 → 档位」映射：审计阈值判定只按
 * `message.type` 查本表（见 levelNumberOf），全程不读 `message.level`，两域不一致因而对本模块
 * 行为零影响；反之若改读 `message.level`，默认阈值 1 会连 warn 一起吞掉。
 *
 * 本模块 import 了 cordis 的 `Logger`（供 Logger.format 渲染），但未也无需 import `LoggerLevel`。
 */
export const LEVEL_BY_TYPE = { error: 0, warn: 1, info: 2, debug: 3 };

export const DAY_MS = 86400000;

/** 本地日键形态（`YYYY-MM-DD`）：`pruneByAge` 注入基准日的**唯一**可接受形态（见 sanitizeBaseDay） */
export const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// ── 基础工具 ──

/** 本地日期 YYYY-MM-DD（面向用户排障，与 Windows 文件时间同口径；非 UTC 日历日） */
export function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

export function toMessageString(v) {
  if (v === null || v === undefined) return String(v);
  return typeof v === 'string' ? v : String(v);
}

export function truncateText(s, max) {
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

export function recordError(error) {
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
 * 截断标记在重新序列化**之前**落到对象上（否则正文里仍是 false——截断标记被后续序列化覆盖的教训）。
 * @returns {{line: string, truncated: boolean}}
 */
export function capRecord(rec) {
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
  //    因为内核 Logger.format 的 `maxLength` 只裁单个行（实测已证），不含转义的纯长行
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
export function buildSinkErrorRow(textValue) {
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