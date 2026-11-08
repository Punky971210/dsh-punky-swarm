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

// 审计日志 sink：聚合计数（同一 (level,name,msg) 在窗口内折叠）。
// 依赖 sink-write 的 writeLine / stdoutWrite；反向不成立，故本模块位于 write 之上。

import { createHash } from 'node:crypto';
import { state, aggregateWindows } from './sink-state.js';
import { V, KIND_LOG_AGGREGATE, MAX_LINE_BYTES, AGGREGATE_WINDOW_MS, AGGREGATE_MAX_WINDOW_MS, AGGREGATE_ROW_HEADROOM, toMessageString, capRecord } from './sink-format.js';
import { stdoutWrite, writeLine } from './sink-write.js';

// ── 聚合计数（同一 (level,name,msg) 的窗口内折叠）──
//
// 目标：同一噪声源（同 level + name + msg）在窗口内反复出现时，**只写首行 + 窗口闭环时补写一行计数行**，
// 使落盘行数不再等于消息数。契约要点（README 与本节逐字一致）：
//   · 聚合键 aggKey = sha256(level ⊕ name ⊕ msg) 的前 16 位十六进制——只认落盘行的这三个字段，
//     不含 ts/sn/pid/args（时间戳与序列号每次都不同；args 经序列化后不稳定）；
//   · 窗口默认 AGGREGATE_WINDOW_MS **滑动**（右界随每次被抑制的到达刷新），硬上限 AGGREGATE_MAX_WINDOW_MS；
//   · 首行形态与字节布局不变（10 字段、kind:"log"、不写 count）；
//   · 闭环行为 kind:"log-aggregate"，在 10 字段之上**附加** count（= 1 + 被折叠条数）与 aggKey：
//     ts 取窗口内**末条被抑制**消息的时间，sn/args 取**首行**值；
//   · 三处闭环落点：同键新到达且已越过窗口右界 / 进程 exit 钩子 / flushDiagnostics()；
//   · **零新增定时器**：三处都是惰性结算——进程被强杀时不走 exit 钩子，末窗口的 count 随内存一起丢失
//     （README 保真边界 B5；诊断面的 aggregate 段是它的唯一补救线索）；
//   · 阈值过滤（passesAuditLevel）与聚合**完全正交**：过滤发生在聚合之前，被过滤的消息不进窗口。

/** 聚合键：sha256(level ⊕ name ⊕ msg) 的前 16 位十六进制（\u0000 为域分隔符） */
export function aggregateKey(level, name, msg) {
  return createHash('sha256')
    .update(toMessageString(level) + '\u0000' + toMessageString(name) + '\u0000' + toMessageString(msg), 'utf8')
    .digest('hex')
    .slice(0, 16);
}

/** 到达时间：优先取内核消息时间戳（测试注入即以它控制窗口推进），缺省取当前时钟 */
function arrivalTs(message) {
  return (message && typeof message.ts === 'number') ? message.ts : Date.now();
}

/** 落盘一行（stdout 开关 + 写路径）——首行与闭环行走同一条通路，故二者在 stdout 面上也一致 */
function emitRow(rec, line) {
  stdoutWrite(rec);
  writeLine(line);
}

/** 开启新窗口并落首行（首行形态与「不开聚合」时逐字节相同） */
function openAggregateWindow(key, rec, line, at) {
  aggregateWindows.set(key, {
    aggKey: key,
    first: rec,
    startAt: at,
    lastTs: at,
    windowEnd: at + AGGREGATE_WINDOW_MS,
    count: 1,
    // 闭环行比首行多出 kind 值后缀（-aggregate）与 count/aggKey 两字段（≤ AGGREGATE_ROW_HEADROOM 字节）。
    // 余量不足的行**不聚合**：L8 行长上限会把超限行改写成截断形态，那会破坏「闭环行的 msg/args 与首行
    // 逐字相同」这条契约，故此处宁可退化为逐行落盘（对应行仍照常写入，只是不进折叠面）。
    sealed: Buffer.byteLength(line, 'utf8') + AGGREGATE_ROW_HEADROOM > MAX_LINE_BYTES,
  });
  emitRow(rec, line);
}

/** 关闭窗口：仅在确有折叠（count > 1）时补写一行闭环行 */
function closeAggregateWindow(win) {
  aggregateWindows.delete(win.aggKey);
  if (win.count <= 1) return;                 // 无折叠 → 不产闭环行（首行已是全部证据）
  // 计数口径：**产出的**闭环行数（含写失败的那次）。闭环行不对应任何消息，故它在守恒式里必须整体
  // 从「消息面」扣除；按「产出」而非「写成功」计数才能让写失败面也保持等式成立。
  state.aggregateRows += 1;
  const rec = {
    v: V,
    ts: new Date(win.lastTs).toISOString(),   // 末条被抑制消息的时间（= 窗口右界证据），不取当前时间
    level: win.first.level,
    name: win.first.name,
    msg: win.first.msg,                       // 与首行逐字相同
    args: Array.isArray(win.first.args) ? win.first.args.slice() : win.first.args,
    sn: win.first.sn,                         // 首行内核序列号（保留「首次出现」的可回溯锚点）
    truncated: win.first.truncated,
    pid: win.first.pid,
    kind: KIND_LOG_AGGREGATE,
    count: win.count,
    aggKey: win.aggKey,
  };
  const { line } = capRecord(rec);
  emitRow(rec, line);
}

/** 关闭全部窗口（exit 钩子与 flushDiagnostics 两处落点共用） */
export function flushAggregateWindows() {
  for (const win of Array.from(aggregateWindows.values())) closeAggregateWindow(win);
}

/**
 * 消息进聚合面：同键命中窗口内 → 抑制并计数；越过窗口右界/硬上限 → 先补写闭环行，再按本条开新窗口。
 * @param {object} message 原始内核消息（取其 ts 判窗口）
 * @param {object} rec     已构造且已完成截断标记的记录对象 = 首行内容的唯一来源
 * @param {string} line    rec 的序列化结果（首行原样落盘用）
 */
export function ingestAggregate(message, rec, line) {
  if (!state.cfg || state.cfg.aggregate !== true) { emitRow(rec, line); return; }   // 关闭态：旁路聚合，等价旧行为
  const key = aggregateKey(rec.level, rec.name, rec.msg);
  const at = arrivalTs(message);
  const win = aggregateWindows.get(key);
  if (!win) { openAggregateWindow(key, rec, line, at); return; }
  // 闭环落点①：越过窗口右界（含触及硬上限的情形——右界本身即为 startAt + 硬上限所封顶）
  if (at >= win.windowEnd || at >= win.startAt + AGGREGATE_MAX_WINDOW_MS) {
    closeAggregateWindow(win);                        // 闭环行先落盘……
    openAggregateWindow(key, rec, line, at);          // ……再落触发它的新首行（文件内时间序不倒退）
    return;
  }
  if (win.sealed) { emitRow(rec, line); return; }     // 近行长上限的行不聚合（见 openAggregateWindow 注释）
  win.count += 1;
  win.lastTs = at;
  win.windowEnd = Math.min(at + AGGREGATE_WINDOW_MS, win.startAt + AGGREGATE_MAX_WINDOW_MS);
  state.collapsedMessages += 1;
}