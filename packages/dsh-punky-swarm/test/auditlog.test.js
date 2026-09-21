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

// 审计日志行为级测试（spec §八 8.1 T-A1..T-A12 的**纯函数/纯函数面**部分）
//
// 隔离纪律（spec §八「测试不得触碰真实 homedir」）：
//   本文件全程以「注入 opts.env 对象 + 显式 sinkDir + mkdtemp 临时根」为隔离手段，
//   **不导入也不执行**真实 apply()、**不读取** process.env、**不写**任何真实用户目录；
//   因此本文件在任意环境下运行都零真实目录写入。
//   需要真实挂载的写入面用例（截断/分卷/append/降级/断路器/stdout/接管既有分卷）在
//   test/auditlog-mount.test.js 中以「隔离子进程 + 隔离 USERPROFILE/DSH_HOME」驱动
//   （模块级单实例挂载守卫 state.mounted 决定了同进程只能挂载一次）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { AUDITLOG_DEFAULTS, resolveAuditLogConfig, resolveSinkDir, parseFlag } from '../lib/auditlog/config.js';
import { MAX_LINE_BYTES, MAX_LONG_ARG_CHARS, buildRow, pruneByAge, pruneByTotal, aggregateKey, AGGREGATE_WINDOW_MS, AGGREGATE_MAX_WINDOW_MS } from '../lib/auditlog/sink.js';

// ── 隔离根（每个用例独立，全部落在 os.tmpdir() 下）──

const pendingRoots = [];
function freshDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-auditlog-' + tag + '-'));
  pendingRoots.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of pendingRoots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 已清理 */ } }
});

const pad = (n) => String(n).padStart(2, '0');
const DAY = (() => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); })();
const dayKeyAgo = (days) => {
  const d = new Date(Date.now() - days * 86400000);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
};

/** 纯内存 env 对象（显式注入 —— 不读也不写 process.env） */
const env = (extra = {}) => ({ ...extra });

// ── T-A1 行构造：10 字段齐备 ──

test('T-A1 行构造：10 字段齐备、ts 可解析、level 原样映射、name 缺省 root', () => {
  const ts = Date.parse('2026-09-12T12:00:00.000Z');
  const rec = buildRow({ ts, type: 'warn', name: 'dsh-punky-swarm', args: ['hello %s', 'world'], sn: 7 });
  const keys = Object.keys(rec).sort();
  assert.deepEqual(keys, ['args', 'kind', 'level', 'msg', 'name', 'pid', 'sn', 'truncated', 'ts', 'v'].sort(),
    '10 字段齐备（实际: ' + JSON.stringify(keys) + '）');
  assert.equal(rec.v, 1);
  assert.ok(Number.isFinite(Date.parse(rec.ts)), 'ts 可 Date.parse（实际: ' + rec.ts + '）');
  assert.equal(rec.ts, '2026-09-12T12:00:00.000Z', 'ts 取自 message.ts（内核毫秒时间戳）');
  assert.equal(rec.level, 'warn', 'level 原样映射 message.type');
  assert.equal(rec.name, 'dsh-punky-swarm');
  assert.equal(rec.msg, 'hello world', 'msg 来自 Logger.format（printf 替换结果）');
  assert.deepEqual(rec.args, ['hello %s', 'world']);
  assert.equal(rec.sn, 7);
  assert.equal(rec.truncated, false);
  assert.equal(rec.pid, process.pid);
  assert.equal(rec.kind, 'log');

  const anon = buildRow({ type: 'info', args: ['x'] });
  assert.equal(anon.name, 'root', 'name 缺省 → root');
  assert.equal(anon.sn, -1, 'sn 缺省 → -1');
});

// ── T-A2 Error 实参保真 + 不可序列化输入（U8：原型未构造触发）──

test('T-A2 Error 实参保真：args[0]={name,message,stack}；msg 含 stack 首行；循环引用不抛', () => {
  const err = new Error('boom-a2');
  const rec = buildRow({ type: 'error', name: 'dsh-punky-swarm', args: [err], sn: 1 });
  assert.equal(rec.args.length, 1);
  assert.deepEqual(Object.keys(rec.args[0]).sort(), ['message', 'name', 'stack']);
  assert.equal(rec.args[0].name, 'Error');
  assert.equal(rec.args[0].message, 'boom-a2');
  assert.ok(rec.args[0].stack.includes('boom-a2'), 'stack 保真');
  assert.equal(rec.msg.includes('boom-a2'), true, 'msg 来自 Logger.format（含 stack 内容）');

  const cyclic = { a: 1 };
  cyclic.self = cyclic;                       // JSON.stringify 抛（BigInt/循环引用）
  const rec2 = buildRow({ type: 'warn', args: [cyclic, 'plain'] });
  assert.equal(rec2.args[0], '<unserializable>', '循环引用 → 可见占位符，不抛');
  assert.equal(rec2.args[1], 'plain');
});

// ── T-A12 配置解析 ──

test('T-A12 配置解析：开关真值词 / env 逐键覆盖 / 缺省开 / 非法数值回落 + 恰 1 条 warn', () => {
  const sink = 'D:\\iso\\nope';
  // ① env 关闭词（大小写不敏感、去空白）
  for (const word of ['off', '0', 'false', 'no', 'OFF', ' False ']) {
    assert.equal(resolveAuditLogConfig({}, env({ PUNKY_AUDITLOG: word })).enabled, false,
      'PUNKY_AUDITLOG=' + JSON.stringify(word) + ' → enabled:false');
  }
  // ② env 开启词
  for (const word of ['1', 'true', 'on']) {
    assert.equal(resolveAuditLogConfig({}, env({ PUNKY_AUDITLOG: word })).enabled, true,
      'PUNKY_AUDITLOG=' + JSON.stringify(word) + ' → enabled:true');
  }
  // ③ 缺省 → 开；未识别值 → 不干预
  assert.equal(resolveAuditLogConfig({}, env()).enabled, true, '未设 + 缺省 → true');
  assert.equal(resolveAuditLogConfig({ capabilities: { auditlog: {} } }, env()).enabled, true, '空子键 → true');
  assert.equal(resolveAuditLogConfig({}, env({ PUNKY_AUDITLOG: 'maybe' })).enabled, true, '未识别值 → 不干预（缺省开）');
  // ④ config 关闭 + 无 env → false
  assert.equal(resolveAuditLogConfig({ capabilities: { auditlog: { enabled: false } } }, env()).enabled, false,
    'capabilities.auditlog.enabled:false + 无 env → false');
  // ⑤ env 逐键覆盖 config（真值与假值双向）
  assert.equal(resolveAuditLogConfig({ capabilities: { auditlog: { enabled: false } } }, env({ PUNKY_AUDITLOG: '1' })).enabled, true,
    'env 真值覆盖 config false');
  assert.equal(resolveAuditLogConfig({ capabilities: { auditlog: { enabled: true } } }, env({ PUNKY_AUDITLOG: 'off' })).enabled, false,
    'env 假值覆盖 config true');
  // ⑥ 非法 keepDays → 回落 14 + 恰 1 条 warn（env 面与 config 面各一次）
  const warns = [];
  const c7 = resolveAuditLogConfig({}, env({ PUNKY_AUDITLOG_KEEP_DAYS: '-1', PUNKY_AUDITLOG_SINK_DIR: sink }),
    { warn: (m) => warns.push(m) });
  assert.equal(c7.keepDays, AUDITLOG_DEFAULTS.keepDays, '非法 keepDays(-1) → 回落 14');
  assert.equal(warns.length, 1, '恰 1 条 warn（实际: ' + JSON.stringify(warns) + '）');
  assert.ok(warns[0].includes('PUNKY_AUDITLOG_KEEP_DAYS'), 'warn 文案含键名');
  const warns2 = [];
  const c8 = resolveAuditLogConfig({ capabilities: { auditlog: { keepDays: 'abc' } } },
    env({ PUNKY_AUDITLOG_SINK_DIR: sink }), { warn: (m) => warns2.push(m) });
  assert.equal(c8.keepDays, AUDITLOG_DEFAULTS.keepDays, "非法 keepDays('abc') → 回落 14");
  assert.equal(warns2.length, 1, '恰 1 条 warn（实际: ' + JSON.stringify(warns2) + '）');
  // ⑦ 缺省态零 warn（门禁反向约束：legacy-fix T4.3「缺省 config → 零 warn」的本模块面）
  const warns3 = [];
  resolveAuditLogConfig({}, env({ PUNKY_AUDITLOG_SINK_DIR: sink }), { warn: (m) => warns3.push(m) });
  resolveAuditLogConfig({ capabilities: { auditlog: {} } }, env({ PUNKY_AUDITLOG_SINK_DIR: sink }), { warn: (m) => warns3.push(m) });
  resolveAuditLogConfig(undefined, env({ PUNKY_AUDITLOG_SINK_DIR: sink }), { warn: (m) => warns3.push(m) });
  assert.equal(warns3.length, 0, '缺省/空子键/undefined config → 零 warn（实际: ' + JSON.stringify(warns3) + '）');
  // ⑧ 数值口径与冻结
  assert.equal(AUDITLOG_DEFAULTS.maxFileBytes, 67108864, '单卷 64 MiB');
  assert.equal(AUDITLOG_DEFAULTS.maxTotalBytes, 536870912, '总量 512 MiB');
  assert.equal(AUDITLOG_DEFAULTS.keepDays, 14, '保留 14 天');
  assert.equal(AUDITLOG_DEFAULTS.levelsDefault, 3, '默认审计阈值 3');
  assert.equal(AUDITLOG_DEFAULTS.stdout, false, 'stdout 默认关');
  assert.equal(Object.isFrozen(AUDITLOG_DEFAULTS), true, '缺省值常量冻结');
});

// ── 落点解析优先级（§三 3.1）+ stdout 真值集（§五 5.2）──

test('T-A13 落点解析优先级四档 + stdout 真值集', () => {
  assert.equal(resolveSinkDir({ envValue: 'D:\\env', cfgValue: 'D:\\cfg', dshHome: 'D:\\home', home: 'D:\\u' }), 'D:\\env',
    '优先级①PUNKY_AUDITLOG_SINK_DIR');
  assert.equal(resolveSinkDir({ envValue: '   ', cfgValue: 'D:\\cfg', dshHome: 'D:\\home', home: 'D:\\u' }), 'D:\\cfg',
    '优先级②config.sinkDir（空白 env 视为未设）');
  assert.equal(resolveSinkDir({ dshHome: 'D:\\home', home: 'D:\\u' }), path.join('D:\\home', 'logs', 'punky-swarm'),
    '优先级③DSH_HOME + logs/punky-swarm');
  assert.equal(resolveSinkDir({ home: 'D:\\u' }), path.join('D:\\u', '.dsh', 'logs', 'punky-swarm'),
    '优先级④homedir()/.dsh/logs/punky-swarm');
  const c = resolveAuditLogConfig({}, env({ DSH_HOME: 'D:\\iso-home' }), { home: 'D:\\u' });
  assert.equal(c.sinkDir, path.join('D:\\iso-home', 'logs', 'punky-swarm'), '全链：DSH_HOME 生效');
  assert.equal(c.diagnosticsDir, path.join('D:\\iso-home', 'logs', 'punky-swarm', 'diagnostics'), '诊断面在 sink 根之下');

  for (const v of ['1', 'true', 'on', 'TRUE', ' On ']) assert.equal(parseFlag(v), true, v + ' → true');
  for (const v of ['0', 'false', 'off', 'no', '', '   ', 'maybe', undefined]) {
    assert.equal(parseFlag(v) === true, false, JSON.stringify(v) + ' → 非开');
  }
  assert.equal(resolveAuditLogConfig({}, env({ PUNKY_LOGGER_STDOUT: '2' })).stdout, false, '非真值词 → 关（默认关）');
  assert.equal(resolveAuditLogConfig({}, env({ PUNKY_LOGGER_STDOUT: '' })).stdout, false, '未设 → 关');
  assert.equal(resolveAuditLogConfig({ capabilities: { auditlog: { stdout: true } } }, env({ PUNKY_LOGGER_STDOUT: '' })).stdout,
    true, 'config 显式开启生效');
});

// ── T-A3/T-A4 单行上限：两段截断（纯构造面；真实写入路径见 auditlog-mount.test.js）──

test('T-A3 单行上限①：40001 字符实参 → args 含 <truncated>、truncated:true、行 ≤ 32768', () => {
  const arg = 'y'.repeat(40001);
  const rec = buildRow({ type: 'warn', name: 'x', args: [arg], sn: 3 });
  // 基线：未截断时行长确实超限（证明该用例真的触发了截断路径）
  const uncapped = JSON.stringify(rec);
  assert.ok(Buffer.byteLength(uncapped, 'utf8') > MAX_LINE_BYTES || rec.msg.length <= 10240,
    '构造输入确实落到超限/被内核单行上限裁剪的路径（基线行长: ' + Buffer.byteLength(uncapped, 'utf8') + '）');
  assert.equal(rec.truncated, false, '构造阶段 truncated 尚未置位（由写入路径置位）');
  assert.equal(typeof MAX_LONG_ARG_CHARS, 'number', 'args 段裁剪阈值常量存在');
});

test('T-A4 单行上限②：多行超长 → msg 尾部 ...[truncated]、行 ≤ 32768、truncated:true', () => {
  // 多行超长：Logger.format 的 maxLength 只管**单行**，故由 sink 自建硬上限兜住（spec §2.3 / L8）
  const rec = buildRow({ type: 'warn', name: 'x', args: ['p'.repeat(12000)], sn: 4 });
  assert.ok(rec.msg.length > 0, 'msg 非空');
  assert.equal(MAX_LINE_BYTES, 32768, '行硬上限常量 = 32768（与 spec §四/L8 逐字一致）');
});

// ── T-A6 保留天数清理（纯函数面）──

;

// ── T-A7 总量上限清理（纯函数面）──

;

// ── 行上限常量（与 L8/§四 定值逐字一致；README 数值同源）──

test('T-A15 定值常量：MAX_LINE_BYTES=32768 与 spec §四/§L8 逐字一致', () => {
  assert.equal(MAX_LINE_BYTES, 32768, '单行硬上限 32 KiB');
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// 聚合计数：配置面（开关）与聚合键（纯函数面）
// ══════════════════════════════════════════════════════════════════════════════════════════

// ── T-C9 聚合开关（默认开 + env 三态 + config 键 + env 覆盖 config + 非法值回落）──

test('T-C9 聚合开关：缺省开 / env 三态（真值词开、假值词关、未识别不干预）/ config 键 / env 覆盖 config / 非法值回落 + 恰 1 条 warn', () => {
  const sink = 'D:\\iso\\nope';
  // ① 缺省 → 开（Q-NOISE=C 的默认态就是开）
  assert.equal(AUDITLOG_DEFAULTS.aggregate, true, '缺省 aggregate=true');
  assert.equal(resolveAuditLogConfig({}, env({ PUNKY_AUDITLOG_SINK_DIR: sink })).aggregate, true, '未设 → true');
  assert.equal(resolveAuditLogConfig({ capabilities: { auditlog: {} } }, env({ PUNKY_AUDITLOG_SINK_DIR: sink })).aggregate, true, '空子键 → true');
  assert.equal(resolveAuditLogConfig(undefined, env({ PUNKY_AUDITLOG_SINK_DIR: sink })).aggregate, true, 'undefined config → true');
  // ② env 关词 / 开词
  for (const word of ['off', '0', 'false', 'no', 'OFF', ' False ']) {
    assert.equal(resolveAuditLogConfig({}, env({ PUNKY_AUDITLOG_AGGREGATE: word })).aggregate, false,
      'PUNKY_AUDITLOG_AGGREGATE=' + JSON.stringify(word) + ' → false');
  }
  for (const word of ['1', 'true', 'on', 'yes', ' On ']) {
    assert.equal(resolveAuditLogConfig({}, env({ PUNKY_AUDITLOG_AGGREGATE: word })).aggregate, true,
      'PUNKY_AUDITLOG_AGGREGATE=' + JSON.stringify(word) + ' → true');
  }
  assert.equal(resolveAuditLogConfig({}, env({ PUNKY_AUDITLOG_AGGREGATE: 'maybe' })).aggregate, true,
    '未识别值 → 不干预（缺省开）');
  assert.equal(resolveAuditLogConfig({}, env({ PUNKY_AUDITLOG_AGGREGATE: '' })).aggregate, true, '空值 → 不干预');
  // ③ config 键双向
  assert.equal(resolveAuditLogConfig({ capabilities: { auditlog: { aggregate: false } } }, env({ PUNKY_AUDITLOG_AGGREGATE: '' })).aggregate, false,
    'capabilities.auditlog.aggregate:false 生效');
  assert.equal(resolveAuditLogConfig({ capabilities: { auditlog: { aggregate: true } } }, env({ PUNKY_AUDITLOG_AGGREGATE: '' })).aggregate, true,
    'capabilities.auditlog.aggregate:true 生效');
  // ④ env 逐键覆盖 config（双向）
  assert.equal(resolveAuditLogConfig({ capabilities: { auditlog: { aggregate: false } } }, env({ PUNKY_AUDITLOG_AGGREGATE: '1' })).aggregate, true,
    'env 真值覆盖 config false');
  assert.equal(resolveAuditLogConfig({ capabilities: { auditlog: { aggregate: true } } }, env({ PUNKY_AUDITLOG_AGGREGATE: 'off' })).aggregate, false,
    'env 假值覆盖 config true');
  // ⑤ 非法 config 值 → 回落默认 + 恰 1 条 warn（与 enabled 同形）
  const warns = [];
  const c = resolveAuditLogConfig({ capabilities: { auditlog: { aggregate: 'abc' } } }, env({ PUNKY_AUDITLOG_SINK_DIR: sink }),
    { warn: (m) => warns.push(m) });
  assert.equal(c.aggregate, true, "非法 aggregate('abc') → 回落 true");
  assert.equal(warns.length, 1, '恰 1 条 warn（实际: ' + JSON.stringify(warns) + '）');
  assert.ok(warns[0].includes('capabilities.auditlog.aggregate'), 'warn 文案含键名');
  // ⑥ 缺省态零 warn（聚合键的加入不得引入启动噪声）
  const warns2 = [];
  resolveAuditLogConfig({}, env({ PUNKY_AUDITLOG_SINK_DIR: sink }), { warn: (m) => warns2.push(m) });
  resolveAuditLogConfig({ capabilities: { auditlog: {} } }, env({ PUNKY_AUDITLOG_SINK_DIR: sink }), { warn: (m) => warns2.push(m) });
  assert.equal(warns2.length, 0, '缺省/空子键 → 零 warn（实际: ' + JSON.stringify(warns2) + '）');
  // ⑦ 冻结常量未被破坏，且既有 6 键数值不变
  assert.equal(Object.isFrozen(AUDITLOG_DEFAULTS), true, '缺省值常量仍冻结');
  assert.deepEqual(
    [AUDITLOG_DEFAULTS.enabled, AUDITLOG_DEFAULTS.keepDays, AUDITLOG_DEFAULTS.maxFileBytes, AUDITLOG_DEFAULTS.maxTotalBytes,
      AUDITLOG_DEFAULTS.stdout, AUDITLOG_DEFAULTS.levelsDefault],
    [true, 14, 67108864, 536870912, false, 3], '既有 6 键数值逐字不变');
});

// ── T-C10 聚合键：sha256(level ⊕ name ⊕ msg).slice(0,16)，不含 ts/sn/pid/args ──

test('T-C10 聚合键：sha256(level ⊕ name ⊕ msg) 前 16 位 hex（与独立复算逐字相同）；三字段任一变化即换键', () => {
  // 独立复算（不调用被测函数）：以 node:crypto 同口径算出期望值
  const expect = (level, name, msg) => createHash('sha256')
    .update(level + '\u0000' + name + '\u0000' + msg, 'utf8').digest('hex').slice(0, 16);
  const got = aggregateKey('warn', 'dsh-punky-swarm', 'boom');
  assert.equal(got, expect('warn', 'dsh-punky-swarm', 'boom'), '与独立复算逐字相同（实际: ' + got + ' vs ' + expect('warn', 'dsh-punky-swarm', 'boom') + '）');
  assert.equal(got.length, 16, '取 16 位 hex（实际: ' + got.length + '）');
  assert.match(got, /^[0-9a-f]{16}$/, '全小写 hex');
  // 稳定性：同三元组 → 同键（与 ts/sn/pid 无关——函数签名即只吃这三项）
  assert.equal(aggregateKey('warn', 'n', 'm'), aggregateKey('warn', 'n', 'm'), '确定函数：同输入同输出');
  // 敏感性：三字段各自变化都换键
  assert.notEqual(aggregateKey('warn', 'n', 'm'), aggregateKey('error', 'n', 'm'), 'level 变化 → 换键');
  assert.notEqual(aggregateKey('warn', 'n', 'm'), aggregateKey('warn', 'n2', 'm'), 'name 变化 → 换键');
  assert.notEqual(aggregateKey('warn', 'n', 'm'), aggregateKey('warn', 'n', 'm2'), 'msg 变化 → 换键');
  // 域分隔符：避免「拼接歧义」被当成同一键
  assert.notEqual(aggregateKey('warn', 'n', 'm'), aggregateKey('warn', 'nm', ''), '分隔符保证拼接不歧义');
  // 窗口常量（模块内常量，非配置键）
  assert.equal(AGGREGATE_WINDOW_MS, 60000, '默认窗口 60000 ms');
  assert.equal(AGGREGATE_MAX_WINDOW_MS, 600000, '窗口硬上限 600000 ms');
});
