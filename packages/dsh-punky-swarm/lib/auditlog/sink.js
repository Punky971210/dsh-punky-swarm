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
// 本模块实现契约（锁定口径落地对照）：
//   L1 exporter.levels **固定** {default:3}（不得由配置下调）→ 审计阈值由 sink 侧自过滤
//   L2 文件 sink 为主；stdout 仅开关（PUNKY_LOGGER_STDOUT，默认关）、不 fallback
//   L3 落点 <DSH_HOME>/logs/punky-swarm/audit-<本地日期>.jsonl，不在会话工作区、不在交付白名单根内
//   L4 挂载只能代码内 → 唯一入口 mountAuditLog(ctx, { root, config })，由 lib/index.js apply 调用
//   L5 自持开关，**绝不调用 exporter 的 disposer**（内核缺陷：销毁 e1 会连带杀掉 e2）
//   L6 export() 整体 try/catch，**绝不 rethrow**（内核 logger 的派发循环无保护）
//   L7 同步写（fs.appendFileSync）——不依赖内核退出 flush（createWriteStream + process.exit 会丢全部内容）
//   L8 单行 ≤ 32 KiB，两段截断（① args 段 ② msg 段），截断留可见标记
//   L9 降级有界（含短路断路器 + 诊断面上限 + 非自噬）
//   L10 零远程上报（sink 模块组仅 node:fs / node:path / node:crypto / node:@deepseek-ai/cordis 的 Logger.format）
//
// 写域边界：本模块**只**写 sink 根与其 diagnostics 子目录，不写会话工作区、不写引擎产物根。

import fs from 'node:fs';
import path from 'node:path';
import { resolveAuditLogConfig } from './config.js';
import { state } from './sink-state.js';
import { MAX_ERROR_CHARS, MAX_STRAY_NAMES, LEVEL_BY_TYPE, localDateKey, recordError, capRecord, buildRow, MAX_LINE_BYTES, MAX_LONG_ARG_CHARS, AGGREGATE_WINDOW_MS, AGGREGATE_MAX_WINDOW_MS } from './sink-format.js';
import { segmentPath, fileBytesOrNull, pruneByAge, pruneByTotal } from './sink-retention.js';
import { writeDiagnostics } from './sink-diag.js';
import { stdoutWrite, writeSinkError, takeoverExistingSegment } from './sink-write.js';
import { flushAggregateWindows, ingestAggregate, aggregateKey } from './sink-aggregate.js';

// ── L6 export()：整体 try/catch，绝不 rethrow ──

/**
 * 审计级别档位：按**消息类型名**查本模块自持表（error=0 / warn=1 / info=2 / debug=3）。
 *
 * **故意不使用 `message.level`**：该字段属内核方法序数域（同名键 warn=2、info=1，与本表互换），
 * 两域不同值；本模块阈值语义只认类型域，理由见上方 LEVEL_BY_TYPE 定义与下方 passesAuditLevel 说明。
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
 * **实测口径（关键）**：内核 `logger.warn()` 构造消息时 `level` 取的是**内核方法序数**
 * （cordis `logger.ts`: error=0,info=1,warn=2,debug=3 —— 源码注解的 "WARN=2" 即 `LoggerLevel` 枚举值，
 * 属 `exporter.levels` 过滤用的另一套语义），而 `message.type` 才是方法名。
 * 两个数值域**不一致**（warn 在类型域为 1、在内核序数域为 2）。本模块的审计阈值只认类型域，
 * 因此**只按 `message.type` 映射**，不读 `message.level` —— 否则 `levelsDefault=1` 会连 warn 一起吞掉。
 * （阈值两态对照即该口径的判据：阈值 1 需能收到真实 punky warn；聚合开启时首行照常落盘，故该结论不变。）
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

    // 层级分离：内核侧 levels 固定 {default:3} → 全量派发；审计阈值在此过滤
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
    } catch (error) {                       // 序列化失败 → 记 sink-error 后返回，不尝试写盘
      recordError(error);
      writeSinkError('serialize failed: ' + state.lastError);
      return;
    }

    stdoutWrite(rec);                       // stdout 只是开关，不是降级面
    ingestAggregate(message, rec, line);    // 聚合开：窗口内同键折叠；聚合关：等价直接写盘
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

  // 关闭态语义：首行 return——不取 logger、不建目录、不注册 exporter、零字节写入、零定时器
  if (!c.enabled) return { mounted: false, reason: 'disabled' };

  // F9 幂等守卫：单实例单挂载（防多 session 级 apply 重复挂）
  if (state.mounted) return { mounted: false, reason: 'duplicate' };

  const logger = ctx?.root?.logger ?? ctx?.logger;
  // 防御式身份判定：不用 instanceof（实测 ctx.logger instanceof LoggerService === false）
  if (!logger || typeof logger.exporter !== 'function') return { mounted: false, reason: 'no-logger' };

  state.cfg = c;
  state.warn = warn;                  // 【c7-cutoff-param】清理旁路（pruneByAge）的告警通道
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
    levels: { default: 3 },              // L1 硬要求：**固定 3**，不得由配置下调
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

  // 清理时机①：挂载时一次
  try {
    pruneByAge(state.sinkDir, c.keepDays);
    // 【sink 三态】挂载期本次调用作用域内 logger 可得（见本函数上方 `const logger = ctx?.root?.logger ?? ctx?.logger`）⇒ 真传
    const pruned = pruneByTotal(state.sinkDir, c.maxTotalBytes, { pruneStray: c.pruneStray, logger });
    state.strays = pruned.strays;                 // 【D-16-②】诊断面读数（挂载期实测；含是否 opt-in）
    if (pruned.strays.count > 0) {
      warn('capabilities.auditlog: sink 目录含 ' + pruned.strays.count + ' 个非分卷名文件（stray，'
        + pruned.strays.bytes + ' 字节，已计入总量上限）：' + pruned.strays.names.join(', ')
        + (pruned.strays.count > pruned.strays.names.length ? ' …' : '')
        + (c.pruneStray ? '；pruneStray=on ⇒ audit- 前缀的 stray 可被清理' : '；默认不删除（opt-in: capabilities.auditlog.pruneStray 或 PUNKY_AUDITLOG_PRUNE_STRAY=1）'));
    }
    // 挂载后重新核对当前卷（清理可能删掉了正在接管的分卷）
    const mainBytes = fileBytesOrNull(segmentPath(localDateKey(new Date()), state.segment));
    state.segmentBytes = mainBytes === null ? 0 : mainBytes;
  } catch (error) { recordError(error); }

  // 优雅退出路径落一次诊断快照（Stop-Process -Force 不触发 exit，由首失败与每 1000 行兜底）。
  // 聚合闭环落点②：全键 flush——与 flushDiagnostics 同序（先落快照：快照里看得出此刻哪些窗口未闭环，
  // 再逐窗闭环落盘；强杀不走本钩子，故末窗口的 count 仍会丢，见 README 保真边界 B5）。
  try {
    process.on('exit', () => {
      writeDiagnostics('process-exit');
      flushAggregateWindows();
    });
  } catch (error) { recordError(error); }

  return { mounted: true, sinkDir: state.sinkDir, filename: state.filename };
}

/** 供测试触发一次诊断面落盘 + 全键 flush 聚合窗口（聚合闭环落点③） */
export function flushDiagnostics(note) {
  writeDiagnostics(note ?? 'manual');
  flushAggregateWindows();
}

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
    stderrNotices: state.stderrNotices,          // 【Q-19b】stderr 告警已发起条数（新增键，既有键语义/顺序零改）
    truncatedLines: state.truncatedLines,
    stdoutWrites: state.stdoutWrites,
    messagesSeen: state.messagesSeen,
    formatFallbacks: state.formatFallbacks,
    filteredByLevel: state.filteredByLevel,
    collapsedMessages: state.collapsedMessages,
    aggregateRows: state.aggregateRows,
    // 【D-16-②】stray 读数（新增键，既有键语义/顺序零改）：已计入总量上限、默认识别但不删
    strays: {
      count: state.strays.count,
      bytes: state.strays.bytes,
      names: state.strays.names.slice(0, MAX_STRAY_NAMES),
      pruneOptIn: state.strays.pruneOptIn === true,
    },
    lastError: state.lastError ? state.lastError.slice(0, MAX_ERROR_CHARS) : null,
  };
}

// ── 对外导出面：拆分前即这 12 个，语义/名称零改（消费者零改动的唯一前提）──
// 其中 4 个（exportMessage / mountAuditLog / flushDiagnostics / auditlogStats）在本文件原生定义，
// 其余 8 个由下方 re-export 自下游模块透出 —— 本文件是 sink 的唯一对外门面。
export {
  MAX_LINE_BYTES,
  MAX_LONG_ARG_CHARS,
  AGGREGATE_WINDOW_MS,
  AGGREGATE_MAX_WINDOW_MS,
  buildRow,
  pruneByAge,
  pruneByTotal,
  aggregateKey,
};
