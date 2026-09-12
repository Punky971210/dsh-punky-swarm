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

// 审计日志配置解析（纯函数，零副作用、零文件系统访问、零 deps）
//
// 契约来源：plan/spec.md（批次 punky-auditlog-impl-m1）
//   §三 3.1  sink 根解析优先级：PUNKY_AUDITLOG_SINK_DIR > DSH_HOME > homedir()/.dsh，再拼 logs/punky-swarm/
//   §四     轮转/保留/体积上限数值（keepDays 14 / maxFileBytes 64MiB / maxTotalBytes 512MiB）
//   §五 5.1 开关契约：默认开 + env 逐键覆盖 config（capabilities.auditlog.*）
//   §五 5.2 stdout 开关（PUNKY_LOGGER_STDOUT，默认关）
//   §七 7.1 sink 侧审计阈值 levelsDefault（默认 3；内核侧 exporter.levels 固定 {default:3} 不随之变化）
//
// 硬约束（X13）：**不 import `@deepseek-ai/dsh-home-paths`**（该包不在真实 profile 的 node_modules 树内），
//   此处以同义本地解析与内核 resolveDshHome 的优先级逐条对齐（configured ?? $DSH_HOME ?? ~/.dsh）。

import { homedir } from 'node:os';
import { join } from 'node:path';

/** sink 目录相对默认 <DSH_HOME> 的二级路径（§三 3.1 字面口径） */
export const SINK_SUBPATH = join('logs', 'punky-swarm');

/** 配置缺省值（冻结常量；`lib/assembly/schema.js` 注册表 import 本对象作 default —— 单一来源） */
export const AUDITLOG_DEFAULTS = Object.freeze({
  enabled: true,                 // §五 5.1 默认开
  keepDays: 14,                  // §四 保留天数
  maxFileBytes: 67108864,        // §四 单卷上限 64 MiB
  maxTotalBytes: 536870912,      // §四 总量上限 512 MiB
  stdout: false,                 // §五 5.2 默认关
  levelsDefault: 3,              // §七 7.1 sink 侧审计阈值（0=error 1=warn 2=info 3=debug）
});

// ── env 解析原语 ──

const text = (v) => (typeof v === 'string' ? v : '');
const isBlank = (v) => text(v).trim() === '';

const FLAG_TRUE = new Set(['1', 'true', 'on', 'yes']);
const FLAG_FALSE = new Set(['0', 'false', 'off', 'no']);

/**
 * 三态布尔解析：识别到真值 → true；识别到假值 → false；其余（含未设/空）→ null（= 不干预）。
 * @param {unknown} raw
 * @returns {boolean|null}
 */
export function parseFlag(raw) {
  const v = text(raw).trim().toLowerCase();
  if (FLAG_TRUE.has(v)) return true;
  if (FLAG_FALSE.has(v)) return false;
  return null;
}

/** 数值解析：有限数且 > 0 → 数值；其余 → null（不干预） */
function parsePositive(raw) {
  if (isBlank(raw)) return null;
  const n = Number(text(raw).trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 数值键解析：env 覆盖 config → 非法值钳制回落默认 + **恰好 1 条 warn**（§五 5.4 第 2 条）。
 * @param {unknown} envRaw env 原始值（未设/空白 = 不干预）
 * @param {unknown} cfgRaw config 显式值（undefined = 缺省）
 * @param {number} fallback 默认值
 * @param {string} key 报告用的键名
 * @param {(msg: string) => void} warn 告警通道
 */
function resolveNumber(envRaw, cfgRaw, fallback, key, warn) {
  if (!isBlank(envRaw)) {
    const n = parsePositive(envRaw);
    if (n !== null) return n;
    warn(key + ': 环境变量值非法（' + JSON.stringify(text(envRaw)) + '），回落默认 ' + fallback);
    return fallback;
  }
  if (cfgRaw === undefined || cfgRaw === null) return fallback;
  const n = parsePositive(cfgRaw);
  if (n !== null) return n;
  warn(key + ': 配置值非法（' + JSON.stringify(cfgRaw) + '），回落默认 ' + fallback);
  return fallback;
}

/**
 * sink 根解析（§三 3.1，逐条对齐内核 resolveDshHome 优先级；**不**使用引擎治理 root）。
 * @param {object} opts
 * @param {unknown} [opts.envValue]  PUNKY_AUDITLOG_SINK_DIR 原始值
 * @param {unknown} [opts.dshHome]   DSH_HOME 原始值
 * @param {unknown} [opts.cfgValue]  config 显式子键 sinkDir
 * @param {string}  [opts.home]      兜底用户主目录（测试可注入；缺省 os.homedir()）
 * @returns {string} 绝对/相对路径原样返回（不规范化，避免改变用户给定路径语义）
 */
export function resolveSinkDir(opts = {}) {
  if (!isBlank(opts.envValue)) return text(opts.envValue).trim();
  if (!isBlank(opts.cfgValue)) return text(opts.cfgValue).trim();
  if (!isBlank(opts.dshHome)) return join(text(opts.dshHome).trim(), SINK_SUBPATH);
  return join(opts.home ?? homedir(), '.dsh', SINK_SUBPATH);
}

// ── 主解析入口 ──

/**
 * 解析审计日志运行配置。
 *
 * @param {object} [config] 插件 config（cordis.patch.yml / runtime.json 注入）
 * @param {Record<string, string|undefined>} [env] 环境变量源（缺省 process.env；显式传入 = 测试注入隔离面）
 * @param {object} [opts]
 * @param {string} [opts.home] 兜底用户主目录（缺省 os.homedir()）
 * @param {((msg: string) => void)} [opts.warn] 非法值告警通道（缺省 no-op —— 保证缺省态零输出）
 * @returns {{enabled: boolean, sinkDir: string, keepDays: number, maxFileBytes: number,
 *            maxTotalBytes: number, stdout: boolean, levelsDefault: number, diagnosticsDir: string}}
 */
export function resolveAuditLogConfig(config, env = process.env, opts = {}) {
  const warn = typeof opts.warn === 'function' ? opts.warn : () => {};
  const e = env ?? {};
  const cap = (config && typeof config === 'object' && config.capabilities && typeof config.capabilities === 'object')
    ? (config.capabilities.auditlog ?? {})
    : {};
  const child = (cap && typeof cap === 'object') ? cap : {};

  // enabled：与既有「readCapability 缺省合并 + env 覆盖」惯例同形（§五 5.1）
  const envEnabled = parseFlag(e.PUNKY_AUDITLOG);
  let enabled;
  if (envEnabled !== null) enabled = envEnabled;
  else if (child.enabled === undefined || child.enabled === null) enabled = AUDITLOG_DEFAULTS.enabled;
  else if (typeof child.enabled === 'boolean') enabled = child.enabled;
  else {
    warn('capabilities.auditlog.enabled: 值非法（' + JSON.stringify(child.enabled) + '），回落默认 ' + AUDITLOG_DEFAULTS.enabled);
    enabled = AUDITLOG_DEFAULTS.enabled;
  }

  // stdout：仅 `1`/`true`/`on`（+`yes`）为开，其余一律关（§五 5.2 字面口径）
  const envStdout = parseFlag(e.PUNKY_LOGGER_STDOUT);
  let stdout = false;
  if (envStdout !== null) stdout = envStdout === true;
  else if (typeof child.stdout === 'boolean') stdout = child.stdout;
  else if (child.stdout !== undefined && child.stdout !== null) stdout = parseFlag(child.stdout) === true;

  const sinkDir = resolveSinkDir({
    envValue: e.PUNKY_AUDITLOG_SINK_DIR,
    cfgValue: child.sinkDir,
    dshHome: e.DSH_HOME,
    home: opts.home,
  });

  return {
    enabled,
    sinkDir,
    keepDays: resolveNumber(e.PUNKY_AUDITLOG_KEEP_DAYS, child.keepDays, AUDITLOG_DEFAULTS.keepDays,
      'PUNKY_AUDITLOG_KEEP_DAYS/capabilities.auditlog.keepDays', warn),
    maxFileBytes: resolveNumber(e.PUNKY_AUDITLOG_MAX_FILE_BYTES, child.maxFileBytes, AUDITLOG_DEFAULTS.maxFileBytes,
      'PUNKY_AUDITLOG_MAX_FILE_BYTES/capabilities.auditlog.maxFileBytes', warn),
    maxTotalBytes: resolveNumber(e.PUNKY_AUDITLOG_MAX_TOTAL_BYTES, child.maxTotalBytes, AUDITLOG_DEFAULTS.maxTotalBytes,
      'PUNKY_AUDITLOG_MAX_TOTAL_BYTES/capabilities.auditlog.maxTotalBytes', warn),
    stdout,
    levelsDefault: resolveNumber(e.PUNKY_AUDITLOG_LEVELS_DEFAULT, child.levelsDefault, AUDITLOG_DEFAULTS.levelsDefault,
      'PUNKY_AUDITLOG_LEVELS_DEFAULT/capabilities.auditlog.levelsDefault', warn),
    // 诊断面固定落在 sink 根之下（§三 3.3）——同样不在会话工作区、不在交付白名单根内
    diagnosticsDir: join(sinkDir, 'diagnostics'),
  };
}
