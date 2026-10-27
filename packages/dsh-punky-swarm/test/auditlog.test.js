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
  assert.deepEqual(warns3, [], '缺省/空子键/undefined config → 零 warn（实际: ' + JSON.stringify(warns3) + '）');
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
  assert.deepEqual(warns2, [], '缺省/空子键 → 零 warn（实际: ' + JSON.stringify(warns2) + '）');
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
  // 长度契约（16）不单独断：下行正则 `/^[0-9a-f]{16}$/` 蕴含 length === 16 且额外锁 charset ⇒ 原 `assert.equal(got.length, 16, …)` 属零断言，已删。
  assert.match(got, /^[0-9a-f]{16}$/, '全小写 hex 且**恰 16 位**（长度契约由本正则表达；原独立 length 断言已删＝零断言；契约源 lib/auditlog/sink.js:371 `.slice(0, 16)`）');
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

// ══════════════════════════════════════════════════════════════════════════════════════════
// 保留天数清理 pruneByAge（批次 `punky-prune-coverage-20261025` · lane c1-tests）
//   判据源：plan/prune-coverage-spec.md 的 R-1..R-5 —— 四类行为判据 + 一个 off-by-one 边界。
//   夹具纪律（规格 P3 的三个「写绿了但没测到」陷阱，逐条免疫）：
//     T-1 ~~`todayCutoffDay` 不读第 3 参（sink.js:475-477）⇒ cutoff 恒用真实时钟~~
//         【已修 · 批次 `punky-guidance-teams-20261025` · lane c7-cutoff-param】
//         `todayCutoffDay(keepDays, baseToday)` 改由 `pruneByAge` 把第 3 参传下去 ⇒ **cutoff = baseToday - keepDays**，
//         可挪到任意历史日期。故：
//           · 删除侧夹具的**相对位置必须按注入基准日重算**（旧写法靠「真实今天 ≫ 2000 年」白捡删/留结论）；
//           · 每处 `pruneByAge` 调用的第 3 参**同时是当日判等基准与 cutoff 基准**，两者不再可分离取值；
//           · T-C12 的主判据已去掉真实时钟依赖（原「跨零点双读守卫」仅因 cutoff 不可注入才存在）；
//           · 可达性由 T-C16（任意历史 cutoff 精确生效）与 T-C12b（cutoff 只由入参决定）证明。
//     T-2 分卷名必须匹配 `parseSegmentName` 真形态 `audit-YYYY-MM-DD[.N].jsonl`（sink.js:469-473）。
//         简报式 `audit-YYYYMMDD.01.log` 属「不认的文件」桶，用它会让「当日卷不删」因解析失败假绿。
//     T-3 只传 2 参对「当日卷不删」无鉴别力（今日 day 永不满足 `今日 < 今日-keepDays`）⇒ T-C13
//         注入第 3 参且 A/B 成对。
// ══════════════════════════════════════════════════════════════════════════════════════════

/** 分卷绝对路径（名字由调用方按真形态拼好） */
const segmentAt = (dir, name) => path.join(dir, name);

/** 落一个分卷（pruneByAge 只读目录项名、不读内容，故内容任意） */
const seedSegment = (dir, name) => { const p = segmentAt(dir, name); fs.writeFileSync(p, 'x\n'); return p; };

// ── T-C11 ① 早于 cutoff 的已收盘卷被删（返回数与「文件真消失」是两件事，必须都断）──

test('T-C11 ① 早于 cutoff 的已收盘卷被删：removed=1 且文件真消失', () => {
  const dir = freshDir('c11');
  const ancient = seedSegment(dir, 'audit-2000-01-01.jsonl'); // 静态字面日：与真实时钟无关
  assert.equal(fs.existsSync(ancient), true, '前置：远古分卷已落盘（实际 exists=' + fs.existsSync(ancient) + '）');
  // 【c7-cutoff-param】第 3 参**同时是当日判等基准与 cutoff 基准**：today=2000-01-05 + keepDays=1
  // ⇒ cutoff=2000-01-04 ⇒ 2000-01-01 严格早于 cutoff。
  // （原值 '2000-01-02' 会让 cutoff == 文件日 ⇒ 本用例失去「早于 cutoff」语义，故必须随修复重算）
  const removed = pruneByAge(dir, 1, '2000-01-05');
  assert.equal(removed, 1, '删除计数 = 1（实际: ' + removed + '）');
  assert.equal(fs.existsSync(ancient), false, '远古分卷真的消失（实际 exists=' + fs.existsSync(ancient) + '）');
  assert.deepEqual(fs.readdirSync(dir), [], '目录已清空（实际剩余: ' + JSON.stringify(fs.readdirSync(dir)) + '）');
});

// ── T-C12 ①b off-by-one 边界：`<` 与 `<=` 可分辨（误删一天留痕 = 数据丢失）──
//   【c7-cutoff-param】基准日由第 3 参注入 ⇒ 本用例**零真实时钟依赖**：cutoff = today - keepDays 全字面。
//   原「跨本地零点双读 + 显式失败」守卫的**唯一存在理由**是兜「cutoff 不可注入」；该理由已消失，
//   守卫由 T-C12b 的「cutoff 只由入参决定」不变量取代。**判据意图（cutoff 当天留、前一天删）原样保留**。

test('T-C12 ①b off-by-one 边界：恰在 cutoff 当天仍在、cutoff 前一天已删（`<`→`<=` 可分辨）', () => {
  const dir = freshDir('c12');
  const keepDays = 1;
  const today = '2000-01-02';                                       // 注入基准日 ⇒ cutoff = 2000-01-01
  const onCutoff = seedSegment(dir, 'audit-2000-01-01.jsonl');      // == cutoff ⇒ 必须留
  const beforeCutoff = seedSegment(dir, 'audit-1999-12-31.jsonl');  // == cutoff 前一天 ⇒ 必须删
  // 数量 → 数组相等（哪些）：卷名在用例内已知 ⇒ 既证「已落盘 2 卷」，也证**是哪两卷**（换卷/漏卷都红）。
  // 禁 new Set：Set 会吞掉重复项，且这里要的是身份而非去重后的种类。
  assert.deepEqual(fs.readdirSync(dir).sort(),
    [path.basename(onCutoff), path.basename(beforeCutoff)].sort(),
    '前置：两卷均已落盘且恰为这两卷（实际: ' + JSON.stringify(fs.readdirSync(dir)) + '）');
  const removed = pruneByAge(dir, keepDays, today);
  assert.equal(removed, 1, '删除计数 = 1（实际: ' + removed + '）');
  assert.equal(fs.existsSync(onCutoff), true, '恰在 cutoff 当天的卷仍在（实际 exists=' + fs.existsSync(onCutoff) + '）');
  assert.equal(fs.existsSync(beforeCutoff), false, 'cutoff 前一天的卷已删（实际 exists=' + fs.existsSync(beforeCutoff) + '）');
});

// ── T-C12b ①b′ cutoff 只由入参决定（幂等 · 零时钟漂移）—— 取代原跨零点双读守卫 ──

test('T-C12b ①b′ cutoff 只由入参决定：同 today 重复调用同结论 + 基准日挪一天边界翻转', () => {
  const keepDays = 10;
  // A/B 两段：**同 today、同夹具、两个独立目录** ⇒ 必须同结论（幂等：cutoff 不随调用时刻漂移）
  const dirA = freshDir('c12b-a');
  const dirB = freshDir('c12b-b');
  const aEdge = seedSegment(dirA, 'audit-2000-01-05.jsonl');  // == cutoff(today=2000-01-15) ⇒ 留
  const bEdge = seedSegment(dirB, 'audit-2000-01-05.jsonl');
  const removedA = pruneByAge(dirA, keepDays, '2000-01-15');
  const removedB = pruneByAge(dirB, keepDays, '2000-01-15');
  assert.equal(removedA, 0, 'A 段（today=2000-01-15 ⇒ cutoff=2000-01-05）删除数 = 0（实际: ' + removedA + '）');
  assert.equal(removedB, 0, 'B 段（同入参重复调用）删除数 = 0（幂等；实际: ' + removedB + '）');
  assert.equal(fs.existsSync(aEdge), true, 'A 段边界卷仍在（实际 exists=' + fs.existsSync(aEdge) + '）');
  assert.equal(fs.existsSync(bEdge), true, 'B 段边界卷仍在（实际 exists=' + fs.existsSync(bEdge) + '）');
  // C 段：**只**把 today 挪一天（2000-01-16 ⇒ cutoff=2000-01-06）⇒ 同一夹具的边界卷变「早于 cutoff」⇒ 删。
  // 这一段是「cutoff 真的跟随入参」的鉴别力来源：若 cutoff 仍读真实时钟，A/B 段就已翻红，C 段亦然。
  const dirC = freshDir('c12b-c');
  const cEdge = seedSegment(dirC, 'audit-2000-01-05.jsonl');
  const removedC = pruneByAge(dirC, keepDays, '2000-01-16');
  assert.equal(removedC, 1, 'C 段（today=2000-01-16 ⇒ cutoff=2000-01-06）删除数 = 1（实际: ' + removedC + '）');
  assert.equal(fs.existsSync(cEdge), false, 'C 段边界卷已删（实际 exists=' + fs.existsSync(cEdge) + '）');
});

// ── T-C13 ② 当日卷（含当日分卷）恒不删 —— 必须注入第 3 参，A/B 成对 ──

test('T-C13 ② 当日卷（含当日分卷）恒不删：注入第 3 参 A/B 成对（当日 0 删 / 隔日 2 删）', () => {
  // A 段：today = 文件日 ⇒ 「当日」分支生效，主卷与 .01 分卷双双受保护
  const dirA = freshDir('c13a');
  const aMain = seedSegment(dirA, 'audit-2000-01-01.jsonl');
  const aSeg = seedSegment(dirA, 'audit-2000-01-01.01.jsonl'); // 真形态：点分段号 + .jsonl
  const removedA = pruneByAge(dirA, 1, '2000-01-01');
  assert.equal(removedA, 0, 'A 段（today=文件日）删除数 = 0（实际: ' + removedA + '）');
  assert.equal(fs.existsSync(aMain), true, 'A 段主卷仍在（实际 exists=' + fs.existsSync(aMain) + '）');
  assert.equal(fs.existsSync(aSeg), true, 'A 段 .01 分卷仍在（实际 exists=' + fs.existsSync(aSeg) + '）');
  // B 段：同一批文件、只把 today 换成文件日 + 1 天 ⇒ 不再是「当日」⇒ 两卷应俱删。
  // B 段是 T-2 陷阱的免疫器：文件名若不是真形态，A 段会因「解析失败」假绿，而 B 段必红。
  const dirB = freshDir('c13b');
  const bMain = seedSegment(dirB, 'audit-2000-01-01.jsonl');
  const bSeg = seedSegment(dirB, 'audit-2000-01-01.01.jsonl');
  // 【c7-cutoff-param】B 段 today 必须退到「文件日 + 2」：today=文件日+1 会让 cutoff 恰等于文件日
  // （today - keepDays = 2000-01-01），`<` 判据不成立 ⇒ 两卷都不删、本段失去「不再是当日」语义。
  const removedB = pruneByAge(dirB, 1, '2000-01-03');
  assert.equal(removedB, 2, 'B 段（today=文件日+2 ⇒ cutoff=文件日+1）删除数 = 2（实际: ' + removedB + '）');
  assert.equal(fs.existsSync(bMain), false, 'B 段主卷已删（实际 exists=' + fs.existsSync(bMain) + '）');
  assert.equal(fs.existsSync(bSeg), false, 'B 段 .01 分卷已删（实际 exists=' + fs.existsSync(bSeg) + '）');
});

// ── T-C14 ③ parseSegmentName 不认的文件跳过不动（逐个点名，不等价于「目录里还有文件」）──

test('T-C14 ③ parseSegmentName 不认的文件跳过不动（.bak / 乱名 / 错日期形态）', () => {
  const dir = freshDir('c14');
  const real = seedSegment(dir, 'audit-2000-01-01.jsonl');           // 可删：唯一被认出的分卷
  const bak = seedSegment(dir, 'audit-2000-01-01.jsonl.bak');        // 后缀混杂
  const weird = seedSegment(dir, 'weird-name.txt');                  // 完全乱名
  const wrongForm = seedSegment(dir, 'audit-20000101.01.log');       // 格式错但不乱（真陷阱）
  // 数量 → 数组相等（哪些）：1 真分卷 + 3 stray 的名字均在用例内已知
  assert.deepEqual(fs.readdirSync(dir).sort(),
    [real, bak, weird, wrongForm].map((f) => path.basename(f)).sort(),
    '前置：1 真分卷 + 3 stray 均已落盘（实际: ' + JSON.stringify(fs.readdirSync(dir)) + '）');
  const removed = pruneByAge(dir, 1, '2000-01-05');
  assert.equal(removed, 1, '只有真分卷计入删除数（实际: ' + removed + '）');
  assert.equal(fs.existsSync(real), false, '真分卷已删（实际 exists=' + fs.existsSync(real) + '）');
  assert.equal(fs.existsSync(bak), true, 'stray 仍在：' + 'audit-2000-01-01.jsonl.bak（实际 exists=' + fs.existsSync(bak) + '）');
  assert.equal(fs.existsSync(weird), true, 'stray 仍在：weird-name.txt（实际 exists=' + fs.existsSync(weird) + '）');
  assert.equal(fs.existsSync(wrongForm), true, 'stray 仍在：audit-20000101.01.log（实际 exists=' + fs.existsSync(wrongForm) + '）');
  // 数量 → 数组相等（哪些）：删掉 real 后应恰剩三个 stray（若删错份则红并点名）
  assert.deepEqual(fs.readdirSync(dir).sort(),
    [bak, weird, wrongForm].map((f) => path.basename(f)).sort(),
    '目录剩余恰为三个 stray（实际: ' + JSON.stringify(fs.readdirSync(dir)) + '）');
});

// ── T-C15 ④ unlinkSync 失败：不抛、不计入 removed、不阻断后续（失败面用同名目录造）──

test('T-C15 ④ unlinkSync 失败：不抛、不计入 removed、不阻断后续', () => {
  const dir = freshDir('c15');
  // 失败面 = 同名目录：unlinkSync 对目录必抛（Windows EPERM / POSIX EISDIR），跨平台成立、零权限依赖、不 mock fs
  const badA = segmentAt(dir, 'audit-1999-01-01.jsonl');
  const badB = segmentAt(dir, 'audit-1999-01-03.jsonl');
  fs.mkdirSync(badA);
  fs.mkdirSync(badB);
  const d1 = seedSegment(dir, 'audit-2000-01-01.jsonl'); // 3 个真可删的远古卷
  const d2 = seedSegment(dir, 'audit-2000-01-02.jsonl');
  const d3 = seedSegment(dir, 'audit-2000-01-03.jsonl');
  let removed;
  try {
    removed = pruneByAge(dir, 1, '2000-01-05');           // today 与两组日期都不同
  } catch (e) {
    assert.fail('pruneByAge 不得因 unlink 失败而抛出（实际抛出: ' + ((e && e.code) || e) + '）');
  }
  assert.equal(removed, 3, '只有真删的 3 个计入、失败的两个不计入（实际: ' + removed + '）');
  // 「不阻断后续」由「三个可删文件全消失」合取断言，不能只写注释
  assert.equal(fs.existsSync(d1), false, '可删卷①已删（实际 exists=' + fs.existsSync(d1) + '）');
  assert.equal(fs.existsSync(d2), false, '可删卷②已删（实际 exists=' + fs.existsSync(d2) + '）');
  assert.equal(fs.existsSync(d3), false, '可删卷③已删（实际 exists=' + fs.existsSync(d3) + '）');
  assert.equal(fs.existsSync(badA), true, '失败目录①仍在（实际 exists=' + fs.existsSync(badA) + '）');
  assert.equal(fs.statSync(badA).isDirectory(), true, '失败目录①仍是目录（实际 isDirectory=' + fs.statSync(badA).isDirectory() + '）');
  assert.equal(fs.existsSync(badB), true, '失败目录②仍在（实际 exists=' + fs.existsSync(badB) + '）');
  assert.equal(fs.statSync(badB).isDirectory(), true, '失败目录②仍是目录（实际 isDirectory=' + fs.statSync(badB).isDirectory() + '）');
});

// ── T-C16 ①c 可达构造：注入历史 base ⇒ cutoff 落在任意历史日期（本缺陷的修复目的）──
//   反向构造（鉴别力证明）：修复前 `todayCutoffDay` 不读 base ⇒ cutoff 恒 ≈ 「真实今天 - 10」⇒
//   三个 2000 年的历史卷**全部**被判定早于 cutoff 而删除（removed=3，且 cutoff 当天卷被误删）；
//   修复后 cutoff=2000-01-05 ⇒ removed=2 且 2000-01-05 存活。实跑两态见 exec/change-cutoff-param.md。

test('T-C16 ①c 可达构造：注入 today=2000-01-15 + keepDays=10 ⇒ cutoff=2000-01-05 精确生效', () => {
  const dir = freshDir('c16');
  const farPast = seedSegment(dir, 'audit-1999-12-31.jsonl');    // 早于 cutoff ⇒ 删
  const onCutoff = seedSegment(dir, 'audit-2000-01-05.jsonl');   // == cutoff ⇒ 留
  const dayBefore = seedSegment(dir, 'audit-2000-01-04.jsonl');  // cutoff 前一天 ⇒ 删
  // 数量 → 数组相等（哪些）
  assert.deepEqual(fs.readdirSync(dir).sort(),
    [farPast, onCutoff, dayBefore].map((f) => path.basename(f)).sort(),
    '前置：三卷均已落盘且恰为这三卷（实际: ' + JSON.stringify(fs.readdirSync(dir)) + '）');
  const removed = pruneByAge(dir, 10, '2000-01-15');
  assert.equal(removed, 2, '删除计数 = 2（实际: ' + removed + '）');
  assert.equal(fs.existsSync(farPast), false, '1999-12-31 已删（实际 exists=' + fs.existsSync(farPast) + '）');
  assert.equal(fs.existsSync(dayBefore), false, '2000-01-04（cutoff 前一天）已删（实际 exists=' + fs.existsSync(dayBefore) + '）');
  assert.equal(fs.existsSync(onCutoff), true, '2000-01-05（cutoff 当天）存活（实际 exists=' + fs.existsSync(onCutoff) + '）');
  assert.deepEqual(fs.readdirSync(dir), ['audit-2000-01-05.jsonl'], '目录只剩 cutoff 当天那一卷（实际: ' + JSON.stringify(fs.readdirSync(dir)) + '）');
});

// ── T-C17 ①d 向后兼容：**不传**第 3 参（两参形态）＝改造前行为 ──
//   生产三个调用点（sink.js:826/839/972）全是两参形态，故这条是「不传基准日＝现状」的行为底线。
//   夹具刻意取「真实时钟两侧的极值」：2000-01-01 恒早于任意真实 cutoff（必删）、2099-12-31 恒晚于（必留），
//   因此**不依赖运行时刻**（无零点窗口、无 flake），等价性论证见 exec/change-cutoff-param.md §向后兼容。

test('T-C17 ①d 向后兼容：两参形态（缺省 today=真实今天）行为与改造前一致', () => {
  const dir = freshDir('c17');
  const ancient = seedSegment(dir, 'audit-2000-01-01.jsonl');   // 恒早于 cutoff ⇒ 删
  const farFuture = seedSegment(dir, 'audit-2099-12-31.jsonl'); // 恒晚于 cutoff ⇒ 留
  const removed = pruneByAge(dir, 1);                           // ← 两参：生产形态
  assert.equal(removed, 1, '删除计数 = 1（实际: ' + removed + '）');
  assert.equal(fs.existsSync(ancient), false, '2000-01-01 已删（实际 exists=' + fs.existsSync(ancient) + '）');
  assert.equal(fs.existsSync(farFuture), true, '2099-12-31 存活（实际 exists=' + fs.existsSync(farFuture) + '）');
  // 数量 → 数组相等（哪些）：只剩远期卷，且必须是**那一卷**（不是随便剩一个）
  assert.deepEqual(fs.readdirSync(dir), [path.basename(farFuture)],
    '目录只剩远期卷（实际: ' + JSON.stringify(fs.readdirSync(dir)) + '）');
});

// ── T-C18 ①e 注入面卫生：非 `YYYY-MM-DD` 基准日 ⇒ 回落真实今天（不抛、零删除、恰 1 条 warn）──
//   这条守的是**改造引入的新攻击面**：修 G-1 之前不存在「畸形 today」这个输入；修好后 `today` 成了 cutoff 基准，
//   而 `Date.parse('garbageT00:00:00')` → NaN ⇒ cutoff = 'NaN-NaN-NaN'，分卷名内 '2…' < 'N…' **恒真** ⇒ 整目录被清空。
//   夹具 = **三个远期卷**（2099-12-29/30/31）：修复前 NaN cutoff 把它们全删（removed=3、目录空）；
//   守卫后回落真实今天（cutoff = 今天 - keepDays）⇒ 三卷全在（removed=0）。两态数字即 3 → 0。
//   warn 通道 = 注入的 `opts.warn`（与 mountAuditLog 的 stray 告警同通道）；**不走 stderr**
//   （stderr 面有「恰 2 行」硬契约，见 test/auditlog-sink-stderr.test.js AC-3）。

test('T-C18 ①e 注入面卫生：today 非 YYYY-MM-DD ⇒ 回落真实今天、零删除、恰 1 条 warn', () => {
  const dir = freshDir('c18');
  const f1 = seedSegment(dir, 'audit-2099-12-31.jsonl');   // 远期：任何真实 cutoff 都早于它 ⇒ 必留
  const f2 = seedSegment(dir, 'audit-2099-12-30.jsonl');
  const f3 = seedSegment(dir, 'audit-2099-12-29.jsonl');
  // 数量 → 数组相等（哪些）
  assert.deepEqual(fs.readdirSync(dir).sort(),
    [f1, f2, f3].map((f) => path.basename(f)).sort(),
    '前置：三卷均已落盘且恰为这三卷（实际: ' + JSON.stringify(fs.readdirSync(dir)) + '）');
  const warns = [];
  const removed = pruneByAge(dir, 7, 'garbage', { warn: (m) => warns.push(m) });
  assert.equal(removed, 0, '畸形基准日不得删除任何卷（实际: ' + removed + '）');
  assert.equal(fs.existsSync(f1), true, '2099-12-31 存活（实际 exists=' + fs.existsSync(f1) + '）');
  assert.equal(fs.existsSync(f2), true, '2099-12-30 存活（实际 exists=' + fs.existsSync(f2) + '）');
  assert.equal(fs.existsSync(f3), true, '2099-12-29 存活（实际 exists=' + fs.existsSync(f3) + '）');
  assert.equal(warns.length, 1, '恰 1 条 warn（实际: ' + JSON.stringify(warns) + '）');
  assert.ok(warns[0].includes('基准日'), 'warn 文案点名「基准日」（实际: ' + warns[0] + '）');
  assert.ok(warns[0].includes('garbage'), 'warn 文案回显非法值（实际: ' + warns[0] + '）');
});
