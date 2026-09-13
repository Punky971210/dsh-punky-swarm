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

// 审计日志挂载面测试（spec §八 8.1 T-B1..T-B5 + T-A3/A4/A5/A8/A9/A10/A11/A14 的挂载面）
//
// 隔离机制（**为什么必须用子进程**）：
//   ① 真实 apply() 首调触发 syncAssets() 写**用户主目录** → 必须在隔离 USERPROFILE/HOME 下执行
//      （spec §八 8.2 / §十 10.2 P7）；
//   ② lib/auditlog/sink.js 为**单实例单挂载**（F9 幂等守卫 state.mounted）→ 同进程只能挂载一次，
//      逐场景隔离必须各起新进程。
//   本文件因此**不导入**被测模块本体：把探测体写入 os.tmpdir() 临时文件、以隔离 env 起子进程执行
//   （子进程只把一段 JSON 写 stdout；被测模块经绝对 file:// URL 导入，探测体所在目录不影响解析）。
//   硬约束：只在 os.tmpdir() 下建目录，只写隔离 DSH_HOME / HOME —— **真实用户目录零写入**。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const SINK_JS = path.join(PKG, 'lib', 'auditlog', 'sink.js');
const INDEX_JS = path.join(PKG, 'lib', 'index.js');
const CORDIS_JS = path.join(path.dirname(createRequire(import.meta.url).resolve('@deepseek-ai/cordis')), 'index.js');

const DAY = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
})();

// ── 隔离根清理 ──
const pendingRoots = [];
process.on('exit', () => {
  for (const d of pendingRoots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 已清理 */ } }
});
function freshRoot(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-auditlog-mount-' + tag + '-'));
  pendingRoots.push(d);
  return d;
}

// ── 探测体（写入隔离临时文件；不落仓库，避免超出 spec §九 文件清单）──

const PROBE_SOURCE = `import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const asUrl = (p) => 'file:///' + p.replace(/\\\\/g, '/');
const { LoggerService } = await import(asUrl(process.env.PUNKY_PROBE_CORDIS));
const { Context } = await import(asUrl(process.env.PUNKY_PROBE_CORDIS));
const { apply } = await import(asUrl(process.env.PUNKY_PROBE_INDEX));
const { mountAuditLog, exportMessage, auditlogStats, buildRow, flushDiagnostics } = await import(asUrl(process.env.PUNKY_PROBE_SINK));

const MODE = process.env.PUNKY_PROBE_MODE || 'apply';
const LOG_DIR = process.env.PUNKY_PROBE_LOGDIR || '';
const SINK_DIR = process.env.PUNKY_AUDITLOG_SINK_DIR || '';
const DAY = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); })();
const readJsonl = (p) => {
  try { if (!fs.statSync(p).isFile()) return []; } catch { return []; }
  return fs.readFileSync(p, 'utf8').split('\\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
};

const out = { ok: false, mode: MODE };
try {
  if (MODE === 'takeover') {
    const MAX_FILE = Number(process.env.PUNKY_AUDITLOG_MAX_FILE_BYTES);
    fs.mkdirSync(SINK_DIR, { recursive: true });
    const mainPath = path.join(SINK_DIR, 'audit-' + DAY + '.jsonl');
    const segPath = path.join(SINK_DIR, 'audit-' + DAY + '.1.jsonl');
    fs.writeFileSync(mainPath, 'x'.repeat(200) + '\\n', 'utf8');
    // .1 预置到「再写一行即超上限」：迫使写入先切到 .2（不得回到已满卷）
    const base = '{"v":1,"ts":"2026-09-12T00:00:00.000Z","level":"info","name":"seed","msg":"';
    const tail = '","args":[],"sn":0,"truncated":false,"pid":1,"kind":"log"}\\n';
    fs.writeFileSync(segPath, base + 'a'.repeat(MAX_FILE - Buffer.byteLength(base + tail, 'utf8')) + tail, 'utf8');
    const mainBefore = fs.readFileSync(mainPath);
    const segBefore = fs.readFileSync(segPath);
    const res = mountAuditLog({ logger: { exporter: () => () => {} } }, { config: {} });
    for (let i = 1; i <= 3; i++) {
      exportMessage({ sn: i, ts: Date.now(), type: 'warn', level: 1, name: 'x', args: ['takeover-' + i] });
    }
    out.ok = true;
    out.mounted = res.mounted;
    out.filename = res.filename;
    out.stat = auditlogStats();
    out.files = fs.readdirSync(SINK_DIR).filter((f) => /^audit-.*\\.jsonl$/.test(f)).sort();
    out.mainUnchanged = fs.readFileSync(mainPath).equals(mainBefore);
    out.segUnchanged = fs.readFileSync(segPath).equals(segBefore);
    out.segRows = readJsonl(segPath).map((r) => r.msg);
    out.seg2Rows = readJsonl(path.join(SINK_DIR, 'audit-' + DAY + '.2.jsonl')).map((r) => r.msg);
  } else if (MODE === 'aggregate') {
    // 聚合计数面（Q-NOISE=C）：以**注入 ts** 精确控制窗口推进——窗口右界取到达时间，故 ts 即可当时间轴用。
    const SC = process.env.PUNKY_PROBE_AGG_SCENARIO || 'repeat';
    const BASE = Date.parse('2026-09-12T12:00:00.000Z');
    const SAME = 'agg-probe: repeated noise';
    // 同 msg 不同 args：%s 形参渲染后与本句逐字相同 → 用来证明聚合键不含 args（args 差异行会被折叠）
    const ALT = ['agg-probe: %s', 'repeated noise'];
    const res = mountAuditLog({ logger: { exporter: () => () => {} } }, { config: {}, env: process.env });
    const inj = (sn, ts, args, type) => {
      const t = type || 'warn';
      exportMessage({ sn: sn, ts: ts, type: t, level: t === 'error' ? 0 : t === 'warn' ? 1 : t === 'info' ? 2 : 3, name: 'aggprobe', args: args });
    };
    if (SC === 'repeat') {
      inj(1, BASE, [SAME]);
      inj(2, BASE + 1000, ALT);
      inj(3, BASE + 2000, ALT);
      inj(4, BASE + 3000, ALT);
      inj(5, BASE + 70000, [SAME]);
      inj(6, BASE + 71000, ALT);
      inj(7, BASE + 72000, ALT);
      inj(8, BASE + 200000, [SAME]);
    } else if (SC === 'off') {
      inj(1, BASE, [SAME]);
      inj(2, BASE + 1000, [SAME]);
      inj(3, BASE + 2000, [SAME]);
      inj(4, BASE + 3000, [SAME]);
      inj(5, BASE + 70000, [SAME]);
    } else if (SC === 'level') {
      // 阈值过滤发生在聚合之前 → 被过滤的消息不进窗口（L0 的判别力）
      inj(1, BASE, [SAME], 'info');
      inj(2, BASE + 1000, [SAME], 'info');
      inj(3, BASE + 2000, [SAME], 'info');
      inj(4, BASE, [SAME], 'warn');
      inj(5, BASE + 1000, [SAME], 'warn');
      inj(6, BASE + 2000, [SAME], 'warn');
      inj(7, BASE + 70000, [SAME], 'warn');
    } else if (SC === 'flush') {
      inj(1, BASE, [SAME]);
      inj(2, BASE + 1000, [SAME]);
      inj(3, BASE + 2000, [SAME]);
      out.rowsBeforeFlush = readJsonl(path.join(SINK_DIR, 'audit-' + DAY + '.jsonl')).length;
      out.statBeforeFlush = auditlogStats();
      flushDiagnostics('agg-probe-flush');
    } else if (SC === 'exit') {
      inj(1, BASE, [SAME]);
      inj(2, BASE + 1000, [SAME]);
      inj(3, BASE + 2000, [SAME]);
      out.rowsBeforeExit = readJsonl(path.join(SINK_DIR, 'audit-' + DAY + '.jsonl')).length;
    } else if (SC === 'cap') {
      // 每 59999 ms 一条同键消息（逐条刷新右界），第 11 条把这个窗口顶到硬上限 600000 ms
      const CAP = Date.parse('2026-09-12T20:00:00.000Z');
      inj(1, CAP, [SAME]);
      for (let i = 1; i <= 10; i++) inj(i + 1, CAP + i * 59999, [SAME]);
      inj(12, CAP + 610000, [SAME]);
    } else if (SC === 'diag') {
      inj(1, BASE, [SAME]);
      inj(2, BASE + 1000, [SAME]);
      inj(3, BASE + 2000, [SAME]);
      flushDiagnostics('agg-probe-diag');
    } else if (SC === 'sealed') {
      // 近行长上限（① 未截断 ② 余量 < 闭环行附加字段所需）的行不聚合：
      // 行长随 msg 单调，用 buildRow 实测收敛到「≤32768 且 +64 即越界」的区间
      // （内核 Logger.format 的 maxLength 会先裁 msg 段，故不能直接按 msg 长度反解）。
      const lineLen = (n) => Buffer.byteLength(JSON.stringify(buildRow({ sn: 1, ts: BASE, type: 'warn', name: 'aggprobe', args: ['S'.repeat(n)] })), 'utf8');
      let N = 22000;
      for (let i = 0; i < 24; i++) {
        const len = lineLen(N);
        if (len <= 32768 && len + 64 > 32768) break;
        const next = N + (32736 - len);
        if (next === N) break;
        N = next < 1 ? 1 : next;
      }
      const longMsg = 'S'.repeat(N);
      out.sealedLineBytes = lineLen(N);
      out.sealedArgsChars = longMsg.length;
      out.sealedMsgChars = buildRow({ sn: 1, ts: BASE, type: 'warn', name: 'aggprobe', args: [longMsg] }).msg.length;
      inj(1, BASE, [longMsg]);
      inj(2, BASE + 1000, [longMsg]);
      inj(3, BASE + 2000, [longMsg]);
      inj(4, BASE + 70000, [longMsg]);
    }
    out.ok = true;
    out.mounted = res.mounted;
    out.rows = readJsonl(path.join(SINK_DIR, 'audit-' + DAY + '.jsonl'));
    out.stat = auditlogStats();
    out.diagPath = path.join(SINK_DIR, 'diagnostics', 'sink-diagnostics.json');
    out.diagExists = fs.existsSync(out.diagPath);
    out.diag = out.diagExists ? JSON.parse(fs.readFileSync(out.diagPath, 'utf8')) : null;
  } else {
    // 真实 cordis 面：Context + 内置 LoggerService + 真实 fiber（exporter() 经 ctx.effect 需活跃 fiber）
    const rootCtx = new Context();
    const service = rootCtx.logger;
    const calls = { info: [], warn: [], error: [] };
    service.info = (...a) => { calls.info.push(a.join(' ')); };
    service.warn = (...a) => { calls.warn.push(a.join(' ')); };
    service.error = (...a) => { calls.error.push(a.join(' ')); };
    // webServer 与宿主同形的最小 stub（真实宿主注入 dsh web 服务；此处不监听端口）
    const webServer = { register: () => {}, dispose: () => {} };
    const config = process.env.PUNKY_PROBE_CONFIG_OFF === '1'
      ? { root: path.join(LOG_DIR, 'engine-root'), capabilities: { auditlog: { enabled: false } } }
      : { root: path.join(LOG_DIR, 'engine-root') };
    // 真实插件 fiber：plugin() 返回 thenable fiber（await 后加载完成）
    const fiber = rootCtx.plugin({
      apply(c) {
        c.provide('tools', { register() {} });
        c.provide('webServer', webServer);
        return apply(c, config);
      },
    });
    await fiber;
    const disposer = await fiber.dispose;

    out.statApply = auditlogStats();
    const beforeDispatch = auditlogStats();
    rootCtx.logger('dsh-punky-swarm').warn('probe warn: GATE_ENABLED=false');
    rootCtx.logger('dsh-punky-swarm').info('probe info row');
    const afterDispatch = auditlogStats();

    if (process.env.PUNKY_PROBE_REMOUNT === '1') out.remount = mountAuditLog(rootCtx, { config: {} });
    if (process.env.PUNKY_PROBE_DISPOSE === '1') {
      const sizeBefore = service.exporters.size;
      disposer();
      out.exportersBeforeDispose = sizeBefore;
      out.exportersAfterDispose = service.exporters.size;
    }
    if (process.env.PUNKY_PROBE_TRUNCATE === '1') {
      // ① args 段：40001 字符实参 → 裁 args；
      // ② msg 段：多行超长（换行转义膨胀 → 行长超 32 KiB）→ 裁 msg 尾并留可见标记
      exportMessage({ sn: 9001, ts: Date.now(), type: 'warn', level: 1, name: 'x', args: ['y'.repeat(40001)] });
      exportMessage({ sn: 9003, ts: Date.now(), type: 'warn', level: 1, name: 'x', args: [Array(9000).fill('mmmmm').join('\\n')] });
    }
    if (process.env.PUNKY_PROBE_MULTIROW === '1') {
      for (let i = 1; i <= 16; i++) {
        exportMessage({ sn: 20000 + i, ts: Date.now(), type: 'info', level: 2, name: 'x',
          args: ['row-' + String(i).padStart(3, '0') + ': ' + 'z'.repeat(280)] });
      }
    }
    out.callPointThrows = [];
    if (process.env.PUNKY_PROBE_FAILURE === '1') {
      const origWrite = process.stdout.write.bind(process.stdout);
      let stdoutCalls = 0;
      process.stdout.write = (...a) => { stdoutCalls += 1; return true; };
      for (let i = 1; i <= 12; i++) {
        try { exportMessage({ sn: 10000 + i, ts: Date.now(), type: 'warn', level: 1, name: 'x', args: ['failrow-' + i] }); }
        catch (e) { out.callPointThrows.push(String(e)); }
      }
      process.stdout.write = origWrite;
      out.stdoutCallsDuringFailure = stdoutCalls;
      out.diagnosticsExistsAfter = fs.existsSync(path.join(SINK_DIR, 'diagnostics', 'sink-diagnostics.json'));
      out.diagnosticsAfter = out.diagnosticsExistsAfter
        ? JSON.parse(fs.readFileSync(path.join(SINK_DIR, 'diagnostics', 'sink-diagnostics.json'), 'utf8')) : null;
    }

    const defaultSink = path.join(process.env.DSH_HOME, 'logs', 'punky-swarm');
    out.ok = true;
    out.exportersSize = service.exporters.size;
    out.exporterLevels = [];
    for (const exp of service.exporters.values()) out.exporterLevels.push(exp.levels);
    out.engineWarnCalls = calls.warn;
    out.sinkDirExists = fs.existsSync(SINK_DIR);
    out.defaultSinkDirExists = fs.existsSync(defaultSink);
    out.diagnosticsDirExists = fs.existsSync(path.join(SINK_DIR, 'diagnostics'));
    out.diagnosticsPath = path.join(SINK_DIR, 'diagnostics', 'sink-diagnostics.json');
    out.diagnosticsExists = fs.existsSync(out.diagnosticsPath);
    out.diagnostics = out.diagnosticsExists ? JSON.parse(fs.readFileSync(out.diagnosticsPath, 'utf8')) : null;
    out.statDelta = {
      messagesSeen: afterDispatch.messagesSeen - beforeDispatch.messagesSeen,
      writes: afterDispatch.writes - beforeDispatch.writes,
      filteredByLevel: afterDispatch.filteredByLevel - beforeDispatch.filteredByLevel,
    };
    out.stat = auditlogStats();
    out.rows = readJsonl(path.join(SINK_DIR, 'audit-' + DAY + '.jsonl')).map((r) => ({
      level: r.level, name: r.name, msg: r.msg, truncated: r.truncated, kind: r.kind, args: r.args }));
    out.files = fs.existsSync(SINK_DIR) ? fs.readdirSync(SINK_DIR).filter((f) => /^audit-.*\\.jsonl$/.test(f)) : [];
    // 分卷序：文件名排序会把主卷（无序号）排到最后，故按解析出的序号排序后再生效
    out.files.sort((a, b) => {
      const seq = (f) => { const m = /^audit-\\d{4}-\\d{2}-\\d{2}(?:\\.(\\d+))?\\.jsonl$/.exec(f); return m && m[1] ? Number(m[1]) : 0; };
      return seq(a) - seq(b);
    });
    out.segmentRows = {};
    out.segmentBytes = {};
    for (const f of out.files) {
      out.segmentRows[f] = readJsonl(path.join(SINK_DIR, f)).map((r) => r.msg);
      out.segmentBytes[f] = fs.statSync(path.join(SINK_DIR, f)).size;
    }
    out.defaultSinkRows = process.env.PUNKY_PROBE_DEFAULT_SINK === '1'
      ? readJsonl(path.join(defaultSink, 'audit-' + DAY + '.jsonl')).map((r) => ({ level: r.level, name: r.name, msg: r.msg }))
      : null;
    out.totalRows = Object.values(out.segmentRows).reduce((s, a) => s + a.length, 0);
    out.day = DAY;
  }
} catch (error) {
  out.ok = false;
  out.error = String((error && error.stack) || error);
}
process.stdout.write('\\n__PROBE_JSON__' + JSON.stringify(out) + '\\n');
`;

let probePath = null;
function probeFile() {
  if (!probePath) {
    const dir = freshRoot('probe');
    probePath = path.join(dir, 'probe.mjs');
    fs.writeFileSync(probePath, PROBE_SOURCE, 'utf8');
  }
  return probePath;
}

/** 子进程返回体解析 */
function runProbeRaw(tag, env, mode = 'apply', overrides = {}) {
  const root = overrides.root ?? freshRoot(tag);
  const home = path.join(root, 'user');
  const dshHome = path.join(root, 'dsh-home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dshHome, { recursive: true });
  const childEnv = {
    ...process.env,
    USERPROFILE: home,                        // 隔离①②：apply()→syncAssets() 只写隔离 HOME
    HOME: home,
    DSH_HOME: dshHome,                        // 隔离③：默认 sink 根落隔离 DSH_HOME 下
    PUNKY_AUDITLOG_SINK_DIR: path.join(root, 'sink'),
    PUNKY_PROBE_MODE: mode,
    PUNKY_PROBE_LOGDIR: root,
    PUNKY_PROBE_INDEX: INDEX_JS,
    PUNKY_PROBE_SINK: SINK_JS,
    PUNKY_PROBE_CORDIS: CORDIS_JS,
    ...env,
  };
  const stdout = execFileSync(process.execPath, [probeFile()], { env: childEnv, encoding: 'utf8', timeout: 180000 });
  const marker = '__PROBE_JSON__';
  const idx = stdout.lastIndexOf(marker);
  assert.ok(idx >= 0, '探测体必须输出结果标记（实际 stdout 尾部: ' + stdout.slice(-500) + '）');
  const result = JSON.parse(stdout.slice(idx + marker.length).split('\n')[0]);
  result.__stdout = stdout;
  result.__root = root;
  result.__home = home;
  result.__dshHome = dshHome;
  result.__sinkDir = childEnv.PUNKY_AUDITLOG_SINK_DIR;
  return result;
}

const runProbe = (tag, env, mode) => runProbeRaw(tag, env, mode);

/** 预置「主卷路径是目录」的不可 append sink（写失败但 sink 根可建 → 诊断面可落盘） */
function seedUnappendableSink(root) {
  const sinkDir = path.join(root, 'sink');
  fs.mkdirSync(path.join(sinkDir, 'audit-' + DAY + '.jsonl'), { recursive: true });
  return sinkDir;
}

// ── T-B1 默认开：真实 apply() 后 sink 被挂载、真实 punky warn 落盘 ──

/** 本模块的 exporter 是唯一带 levels 声明且 default=3 的那个（内置 buffer exporter 无 levels） */
const ourExporters = (r) => (r.exporterLevels ?? []).filter((lv) => lv && lv.default === 3);

test('T-B1 默认开：apply() 后 sink 挂载、目录存在、warn/info 落盘（name/level/msg 三对齐）', () => {
  const r = runProbe('tb1', {});
  assert.equal(r.ok, true, '探测体未报错（error: ' + JSON.stringify(r.error) + '）');
  assert.equal(r.sinkDirExists, true, 'sink 目录已创建');
  assert.equal(r.diagnosticsDirExists, true, '诊断面目录已创建');
  assert.deepEqual(ourExporters(r), [{ default: 3 }], 'L1：exporter.levels 固定 {default:3}（实际: ' + JSON.stringify(r.exporterLevels) + '）');
  assert.equal(r.exportersSize, 2, 'exporter 数 = 内置 buffer + 本模块（实际: ' + r.exportersSize + '）');
  assert.deepEqual(r.engineWarnCalls, [], '缺省 config → apply() 零 warn（门禁反向约束；实际: ' + JSON.stringify(r.engineWarnCalls) + '）');
  const warn = r.rows.find((x) => x.level === 'warn' && x.msg.includes('GATE_ENABLED=false'));
  assert.ok(warn, 'sink 落盘含 level:"warn" 且 msg 含 GATE_ENABLED=false（实际: ' + JSON.stringify(r.rows) + '）');
  assert.equal(warn.name, 'dsh-punky-swarm', 'name = dsh-punky-swarm');
  assert.ok(r.rows.some((x) => x.level === 'info' && x.msg.includes('probe info row')), 'info 亦落盘（levels.default=3 四级全通）');
  assert.equal(r.stat.writes, r.rows.length, 'writes 计数 == 落盘行数');
  assert.equal(r.stat.failures, 0, '零失败');
});

// ── T-B1b 默认落点：<DSH_HOME>/logs/punky-swarm（§三 3.1 优先级②）──

test('T-B1b 默认落点：不设 SINK_DIR → 落 <DSH_HOME>/logs/punky-swarm 并收到真实 warn', () => {
  const r = runProbe('tb1b', { PUNKY_AUDITLOG_SINK_DIR: '', PUNKY_PROBE_DEFAULT_SINK: '1' });
  assert.equal(r.ok, true, '探测体未报错（error: ' + JSON.stringify(r.error) + '）');
  assert.equal(r.defaultSinkDirExists, true, '<DSH_HOME>/logs/punky-swarm 已创建');
  assert.ok(Array.isArray(r.defaultSinkRows) && r.defaultSinkRows.some((x) => x.msg.includes('GATE_ENABLED=false')),
    '该落点收到真实 punky warn（实际: ' + JSON.stringify(r.defaultSinkRows) + '）');
});

// ── T-B2 关闭态：零目录、零 exporter、零字节 ──

test('T-B2 关闭态（env PUNKY_AUDITLOG=off）：sink 目录不存在、exporter 数 0、零行落盘', () => {
  const r = runProbe('tb2', { PUNKY_AUDITLOG: 'off' });
  assert.equal(r.ok, true, '探测体未报错（error: ' + JSON.stringify(r.error) + '）');
  assert.deepEqual(ourExporters(r), [], '关闭态不注册本模块 exporter（实际: ' + JSON.stringify(r.exporterLevels) + '）');
  assert.equal(r.sinkDirExists, false, '关闭态零目录（实际 exists: ' + r.sinkDirExists + '）');
  assert.deepEqual(r.rows, [], '关闭态零字节落盘');
  assert.equal(r.files.length, 0, '关闭态零文件');
  assert.equal(r.stat.mounted, false, '关闭态 state.mounted=false');
  assert.equal(r.stat.writes, 0, '关闭态 writes=0');
});

test('T-B2b 关闭态（config capabilities.auditlog.enabled=false，无 env）：同为零开销', () => {
  const r = runProbe('tb2b', { PUNKY_AUDITLOG: '', PUNKY_PROBE_CONFIG_OFF: '1' });
  assert.equal(r.ok, true, '探测体未报错（error: ' + JSON.stringify(r.error) + '）');
  assert.deepEqual(ourExporters(r), [], 'config 关闭 → 不注册本模块 exporter（实际: ' + JSON.stringify(r.exporterLevels) + '）');
  assert.equal(r.sinkDirExists, false, 'config 关闭 → 零目录');
  assert.deepEqual(r.engineWarnCalls, [], 'config 关闭 → 零 warn（禁用能力零校验零 warn）');
});

// ── T-B3 幂等 ──

test('T-B3 幂等：连续两次 mountAuditLog → 第二次 {mounted:false, reason:"duplicate"}、exporter 数不变', () => {
  const r = runProbe('tb3', { PUNKY_PROBE_REMOUNT: '1' });
  assert.equal(r.ok, true, '探测体未报错（error: ' + JSON.stringify(r.error) + '）');
  assert.equal(r.remount.mounted, false, '第二次挂载被拒（实际: ' + JSON.stringify(r.remount) + '）');
  assert.equal(r.remount.reason, 'duplicate', '拒绝理由 = duplicate');
  assert.equal(ourExporters(r).length, 1, '本模块 exporter 注册数仍为 1（实际: ' + JSON.stringify(r.exporterLevels) + '）');
});

// ── T-B4 自持开关：不调用 exporter disposer ──

test('T-B4 不用 disposer：apply() 返回的 disposer 执行后 exporter 仍存活（自持开关语义）', () => {
  const r = runProbe('tb4', { PUNKY_PROBE_DISPOSE: '1' });
  assert.equal(r.ok, true, '探测体未报错（error: ' + JSON.stringify(r.error) + '）');
  assert.equal(r.exportersBeforeDispose, 2, 'dispose 前 exporter 数 2（内置 buffer + 本模块）');
  assert.equal(r.exportersAfterDispose, 2, 'dispose 后 exporter 数仍 2（未调用内核 disposer；L5）');
});

// ── T-B5 阈值对照（内核侧恒 3；sink 侧两态）──

test('T-B5 阈值对照：levelsDefault=3 收 warn+info；=1 收 warn、info 0 命中（内核侧恒 {default:3}）', () => {
  const on = runProbe('tb5-on', { PUNKY_AUDITLOG_LEVELS_DEFAULT: '3' });
  const off = runProbe('tb5-off', { PUNKY_AUDITLOG_LEVELS_DEFAULT: '1' });
  assert.equal(on.ok, true, 'on 探测体未报错（error: ' + JSON.stringify(on.error) + '）');
  assert.equal(off.ok, true, 'off 探测体未报错（error: ' + JSON.stringify(off.error) + '）');
  assert.deepEqual(ourExporters(on), [{ default: 3 }], 'levelsDefault=3：内核侧 levels 固定 {default:3}');
  assert.deepEqual(ourExporters(off), [{ default: 3 }], 'levelsDefault=1：内核侧 levels **仍**固定 {default:3}（不下调）');
  const onWarn = on.rows.filter((x) => x.level === 'warn' && x.msg.includes('GATE_ENABLED=false')).length;
  const onInfo = on.rows.filter((x) => x.level === 'info').length;
  const offWarn = off.rows.filter((x) => x.level === 'warn' && x.msg.includes('GATE_ENABLED=false')).length;
  const offInfo = off.rows.filter((x) => x.level === 'info').length;
  assert.ok(onWarn >= 1, 'levelsDefault=3：同一 warn 落盘 ≥1（实际: ' + onWarn + '）');
  assert.ok(onInfo >= 1, 'levelsDefault=3：info 亦落盘（实际: ' + onInfo + '）');
  assert.equal(offWarn, 1, 'levelsDefault=1：warn 仍落盘（阈值 1 = error+warn；实际: ' + offWarn + '）');
  assert.equal(offInfo, 0, 'levelsDefault=1：同一 info 0 命中（实际: ' + offInfo + '）');
  assert.ok(off.stat.filteredByLevel >= 1, 'off 侧 filteredByLevel>0（sink 侧自过滤生效；实际: ' + off.stat.filteredByLevel + '）');
});

// ── T-A3/A4 挂载面：单行上限两段截断（真实写入路径）──

test('T-A3/A4 挂载面单行上限：args 段与 msg 段各自截断，每行 ≤ 32768、truncated 留痕', () => {
  const r = runProbe('ta34', { PUNKY_PROBE_TRUNCATE: '1' });
  assert.equal(r.ok, true, '探测体未报错（error: ' + JSON.stringify(r.error) + '）');
  const y = r.rows.find((x) => Array.isArray(x.args) && x.args.includes('<truncated>'));
  assert.ok(y, '① args 段留可见标记 <truncated>（实际 args: ' + JSON.stringify(r.rows.map((x) => x.args)) + '）');
  assert.equal(y.truncated, true, '① 行 truncated:true');
  const z = r.rows.find((x) => typeof x.msg === 'string' && x.msg.endsWith('...[truncated]'));
  assert.ok(z, '② msg 段尾部留可见标记 ...[truncated]（实际尾部: '
    + JSON.stringify(r.rows.map((x) => (x.msg || '').slice(-18))) + '）');
  assert.equal(z.truncated, true, '② 行 truncated:true');
  assert.equal(r.stat.truncatedLines, 2, 'truncatedLines 计数 = 2（① 与 ② 各一行；实际: ' + r.stat.truncatedLines + '）');
  const rawPath = path.join(r.__sinkDir, 'audit-' + DAY + '.jsonl');
  const buf = fs.readFileSync(rawPath);
  for (const line of buf.toString('utf8').split('\n').filter((l) => l)) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 32768, '每行 ≤ 32768 字节（实际: ' + Buffer.byteLength(line, 'utf8') + '）');
  }
  assert.equal(buf[buf.length - 1], 0x0a, '末字节 = LF');
  assert.equal(buf[0], 0x7b, '首字节 = {');
  assert.notEqual(buf[0], 0xef, '无 UTF-8 BOM');
});

// ── T-A5/A8 挂载面：分卷命名单调 + 每卷 ≤ 上限 + 行不丢 + 只 append ──

test('T-A5/A8 挂载面分卷：小 maxFileBytes → 主卷/.1/.2 单调、每卷 ≤ 上限、行不丢、前段字节不变', () => {
  const r = runProbe('ta5', { PUNKY_AUDITLOG_MAX_FILE_BYTES: '2048', PUNKY_PROBE_MULTIROW: '1' });
  assert.equal(r.ok, true, '探测体未报错（error: ' + JSON.stringify(r.error) + '）');
  assert.equal(r.stat.failures, 0, '零失败（实际 stat: ' + JSON.stringify(r.stat) + '）');
  assert.ok(r.files.includes('audit-' + DAY + '.jsonl'), '主卷存在（实际: ' + JSON.stringify(r.files) + '）');
  assert.ok(r.files.includes('audit-' + DAY + '.1.jsonl'), '.1 分卷存在（实际: ' + JSON.stringify(r.files) + '）');
  assert.ok(r.files.includes('audit-' + DAY + '.2.jsonl'), '.2 分卷存在（实际: ' + JSON.stringify(r.files) + '）');
  const seqs = r.files.map((f) => {
    const m = /^audit-\d{4}-\d{2}-\d{2}(?:\.(\d+))?\.jsonl$/.exec(f);
    return m[1] ? Number(m[1]) : 0;
  });
  assert.deepEqual(seqs, seqs.map((_, i) => i), '分卷序号单调且无空洞（实际: ' + JSON.stringify(seqs) + '）');
  for (const f of r.files) {
    assert.ok(r.segmentBytes[f] <= 2048, f + ' 体积 ≤ maxFileBytes（实际: ' + r.segmentBytes[f] + '）');
  }
  // 16 行 + 2 行（warn/info 派发）全部守恒
  assert.equal(r.totalRows, 18, '行不丢：总行数守恒（实际: ' + r.totalRows + '）');
  const msgs = Object.values(r.segmentRows).flat();
  assert.equal(new Set(msgs).size, msgs.length, '无重复行（实际去重前 ' + msgs.length + ' / 去重后 ' + new Set(msgs).size + '）');
  assert.ok(msgs.filter((m) => m.startsWith('row-')).length === 16, '16 条 multirow 全落盘（实际: ' + msgs.filter((m) => m.startsWith('row-')).length + '）');
  assert.equal(r.stat.writes, r.totalRows, 'writes 计数 == 总行数');
});

// ── T-A9/A10/A11 挂载面：真 OS 失败 → 不外抛、有界、零 stdout fallback、诊断面落盘 ──

test('T-A9/A10/A11 挂载面降级：sinkDir 落在普通文件下 → 不外抛/有界/零 stdout/诊断面已落', () => {
  const root = freshRoot('ta9');
  fs.writeFileSync(path.join(root, 'not-a-dir'), 'regular file, not a directory', 'utf8');
  const badSink = path.join(root, 'not-a-dir', 'logs');
  const r = runProbeRaw('ta9', {
    PUNKY_AUDITLOG_SINK_DIR: badSink,
    PUNKY_AUDITLOG_MAX_FILE_BYTES: '2048',
    PUNKY_PROBE_FAILURE: '1',
  }, 'apply', { root });
  assert.equal(r.ok, true, '探测体未报错（D-1/D-6：真 OS 失败不得炸宿主；error: ' + JSON.stringify(r.error) + '）');
  assert.equal(r.sinkDirExists, false, '真 OS 失败：sink 目录未创建（实际 exists: ' + r.sinkDirExists + '）');
  assert.deepEqual(r.callPointThrows, [], 'D-6：callPointThrows 恒为空数组（实际: ' + JSON.stringify(r.callPointThrows) + '）');
  assert.ok(r.stat.failures > 0, 'failures > 0（实际: ' + r.stat.failures + '）');
  assert.ok(String(r.stat.lastError).length > 0 && String(r.stat.lastError).length <= 500,
    'lastError 已记账且 ≤ 500 字符（实际长度: ' + String(r.stat.lastError).length + '）');
  assert.ok(r.stat.sinkErrorRecords <= 3, 'D-5②：sink-error 记录上限 3（实际: ' + r.stat.sinkErrorRecords + '）');
  assert.ok(r.stat.skippedByBreaker > 0, 'D-5①：断路后 skippedByBreaker > 0（实际: ' + r.stat.skippedByBreaker + '）');
  assert.equal(r.stdoutCallsDuringFailure, 0, 'D-3/T-A11：写失败不 fallback stdout（实际: ' + r.stdoutCallsDuringFailure + '）');
  assert.equal(r.stat.stdoutWrites, 0, 'stdoutWrites=0');
  assert.equal(r.diagnosticsExists, false, 'D-4 诚实面：sink 根不可建时诊断面**同样写不进去**（诊断面在 sink 根之下，非独立可写面）');
  // D-4 的可达面（诊断面真能落盘）由「可写 sink 根 + 注入写失败」组合场景覆盖（下方 T-A16）。
  assert.ok(r.stat.sinkErrorRecordsFailed >= 0, 'sinkErrorRecordsFailed 只累计不抛（实际: ' + r.stat.sinkErrorRecordsFailed + '）');
});

// ── T-A16 挂载面：D-4 诊断面真能落盘（sink 根可写、写失败可注入）──

test('T-A16 D-4 诊断面：写失败（主卷路径是目录）→ 诊断面独立落盘、含失败计数、不外抛', () => {
  const root = freshRoot('ta16');
  const sinkDir = seedUnappendableSink(root);
  const r = runProbeRaw('ta16', {
    PUNKY_AUDITLOG_SINK_DIR: sinkDir,
    PUNKY_AUDITLOG_MAX_FILE_BYTES: '65536',
    PUNKY_PROBE_FAILURE: '1',
  }, 'apply', { root });
  assert.equal(r.ok, true, '探测体未报错（error: ' + JSON.stringify(r.error) + '）');
  assert.equal(r.sinkDirExists, true, 'sink 根存在（与 T-A9 的「根不可建」形成对照）');
  assert.deepEqual(r.callPointThrows, [], 'D-6：callPointThrows 恒空');
  assert.ok(r.stat.failures > 0, 'failures > 0（实际: ' + r.stat.failures + '）');
  assert.equal(r.diagnosticsExistsAfter, true, 'D-4：诊断面已落盘（' + r.diagnosticsPath + '）');
  assert.ok(r.diagnosticsAfter && r.diagnosticsAfter.failures > 0, '诊断面含失败计数（实际: ' + JSON.stringify(r.diagnosticsAfter) + '）');
  assert.equal(r.diagnosticsAfter.sinkDir, sinkDir, '诊断面记录实际 sink 根');
  assert.equal(r.diagnosticsAfter.note, 'first-failure', '首次失败即落盘（原型同口径）');
  assert.ok(JSON.stringify(r.diagnosticsAfter).length > 0 && r.diagnosticsAfter.lastError.length <= 500,
    '诊断面 lastError 截断 ≤ 500（实际: ' + r.diagnosticsAfter.lastError.length + '）');
  assert.ok(r.stat.sinkErrorRecords <= 3, 'D-5②：sink-error 记录 ≤ 3（实际: ' + r.stat.sinkErrorRecords + '）');
  assert.equal(r.stdoutCallsDuringFailure, 0, '不 fallback stdout（实际: ' + r.stdoutCallsDuringFailure + '）');
});

// ── T-A14 挂载面：接管既有分卷（只 append、不回退）──
test('T-A14 接管既有分卷：已满的 .1 之后切到 .2，主卷与旧分卷字节不变', () => {
  const r = runProbe('ta14', {
    PUNKY_AUDITLOG_MAX_FILE_BYTES: '2048',
    PUNKY_AUDITLOG_MAX_TOTAL_BYTES: '1000000',
  }, 'takeover');
  assert.equal(r.ok, true, '探测体未报错（error: ' + JSON.stringify(r.error) + '）');
  assert.equal(r.mounted, true, '挂载成功');
  assert.equal(r.filename, 'audit-' + DAY + '.jsonl', '进程启动时定名（主卷名，进程内不变）');
  assert.deepEqual(r.files, ['audit-' + DAY + '.1.jsonl', 'audit-' + DAY + '.2.jsonl', 'audit-' + DAY + '.jsonl'],
    '分卷命名与单调（实际: ' + JSON.stringify(r.files) + '）');
  assert.equal(r.mainUnchanged, true, '既有主卷逐字节未改写（只 append 语义）');
  assert.equal(r.segUnchanged, true, '既有 .1 分卷逐字节未改写（不回退到已满卷）');
  assert.equal(r.segRows.length, 1, '.1 分卷仍只有 1 行种子（实际: ' + r.segRows.length + '）');
  assert.deepEqual(r.seg2Rows.slice(-3), ['takeover-1', 'takeover-2', 'takeover-3'],
    '3 行全部落在 .2（实际: ' + JSON.stringify(r.seg2Rows) + '）');
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// 聚合计数面（同一 (level,name,msg) 的窗口折叠）——两态对照四级适配 + 守恒式 + 开关 + 诊断面
//
// 口径（与 README 一致）：闭环行也是一次成功写盘 → 计入 state.writes（writes = 成功写盘行数）；
// 但闭环行不由任何消息产生，故在**消息面**守恒式里必须整体扣除 aggregateRows：
//   messagesSeen === (writes - aggregateRows) + filteredByLevel + collapsedMessages + failures
// （修正式恒成立；aggregateRows === 0 时退化为原字面式，见 T-C1/T-C2。）
// ══════════════════════════════════════════════════════════════════════════════════════════

const SAME_MSG = 'agg-probe: repeated noise';
const TEN_FIELDS = ['v', 'ts', 'level', 'name', 'msg', 'args', 'sn', 'truncated', 'pid', 'kind'];
const AGG_FIELDS = [...TEN_FIELDS, 'count', 'aggKey'];
const ISO = (ms) => new Date(ms).toISOString();
const BASE = Date.parse('2026-09-12T12:00:00.000Z');
const HEX16 = /^[0-9a-f]{16}$/;

/** 守恒式（修正式 + aggregateRows===0 时的字面式）逐次校验 */
function assertConservation(stat, label) {
  const literal = stat.writes + stat.filteredByLevel + stat.collapsedMessages + stat.failures;
  const r = { writes: stat.writes, filteredByLevel: stat.filteredByLevel, collapsedMessages: stat.collapsedMessages, aggregateRows: stat.aggregateRows, failures: stat.failures, messagesSeen: stat.messagesSeen };
  assert.equal(
    stat.messagesSeen,
    (stat.writes - stat.aggregateRows) + stat.filteredByLevel + stat.collapsedMessages + stat.failures,
    label + '：消息面守恒式（writes 扣除 aggregateRows）必须恒成立（实际: ' + JSON.stringify(r) + '）');
  assert.equal(literal - stat.messagesSeen, stat.aggregateRows,
    label + '：字面式与修正式之差恒为 aggregateRows（闭环行是行面产出、不是消息，实际: ' + JSON.stringify(r) + '）');
  if (stat.aggregateRows === 0) {
    assert.equal(stat.messagesSeen, literal,
      label + '：aggregateRows===0 时字面式亦成立（与旧行为连续，实际: ' + JSON.stringify(r) + '）');
  }
}

// ── T-C1 L2 重复态：折叠 + 闭环行字段级正确 + aggKey 跨窗口稳定 ──

test('T-C1 聚合重复态：首行 10 字段不变；闭环行 count=1+折叠数、ts=末条被抑制、sn/args=首行；aggKey 跨窗口稳定', () => {
  const r = runProbe('tc1', { PUNKY_PROBE_AGG_SCENARIO: 'repeat' }, 'aggregate');
  assert.equal(r.ok, true, '探测体未报错（error: ' + JSON.stringify(r.error) + '）');
  assert.equal(r.rows.length, 5, '2 个窗口 × （首行 + 闭环行）+ 最后一条首行 = 5 行（实际: ' + r.rows.length + ' 行）');

  // ① 首行：10 字段逐字不变、kind:"log"、无 count
  assert.deepEqual(Object.keys(r.rows[0]), TEN_FIELDS, '首行恰 10 字段且顺序不变（实际: ' + JSON.stringify(Object.keys(r.rows[0])) + '）');
  assert.equal(r.rows[0].kind, 'log', '首行 kind="log"');
  assert.equal('count' in r.rows[0], false, '首行不写 count（既有行字节形态零变化）');
  assert.equal(r.rows[0].ts, ISO(BASE), '首行 ts = 该消息真实时间');
  assert.equal(r.rows[0].sn, 1, '首行 sn = 该消息序列号');

  // ② 闭环行：12 字段（10 + count + aggKey），count = 1 + 折叠数
  assert.deepEqual(Object.keys(r.rows[1]), AGG_FIELDS, '闭环行 = 10 字段 + 附加 count/aggKey（实际: ' + JSON.stringify(Object.keys(r.rows[1])) + '）');
  assert.equal(r.rows[1].kind, 'log-aggregate', '闭环行 kind="log-aggregate"');
  assert.equal(r.rows[1].count, 4, '窗口 1 含首行共 4 条 ⇒ count=4（实际: ' + r.rows[1].count + '）');
  assert.equal(r.rows[1].ts, ISO(BASE + 3000), '闭环行 ts = 窗口内**末条被抑制**消息时间，不取当前时间（实际: ' + r.rows[1].ts + '）');
  assert.equal(r.rows[1].sn, 1, '闭环行 sn = 首行 sn（实际: ' + r.rows[1].sn + '）');
  assert.deepEqual(r.rows[1].args, [SAME_MSG], '闭环行 args = 首行值（实际: ' + JSON.stringify(r.rows[1].args) + '）');
  assert.equal(r.rows[1].msg, r.rows[0].msg, '闭环行 msg 与首行逐字相同');
  assert.equal(r.rows[1].pid, r.rows[0].pid, '闭环行 pid = 首行 pid（同进程）');
  assert.equal(r.rows[1].truncated, false, '闭环行 truncated 继承首行（false）');
  assert.ok(HEX16.test(r.rows[1].aggKey), 'aggKey 为 16 位 hex（实际: ' + r.rows[1].aggKey + '）');

  // ③ B3 证据：被折叠行的 args 形状（%s 形参）在落盘中完全不可见
  assert.equal(r.rows.filter((x) => JSON.stringify(x.args).includes('%s')).length, 0,
    '被折叠消息的 args 形状不出现在任何落盘行（保真边界 B3；实际: ' + JSON.stringify(r.rows.map((x) => x.args)) + '）');

  // ④ 闭环行先于触发它的新首行落盘；新窗口独立开窗
  assert.equal(r.rows[2].kind, 'log', '第 3 行是触发闭环的那条新首行（kind="log"）');
  assert.equal(r.rows[2].sn, 5, '新首行 sn=5（实际: ' + r.rows[2].sn + '）');
  assert.equal(r.rows[2].ts, ISO(BASE + 70000), '新首行 ts = 该消息真实时间');

  // ⑤ 第二个窗口同样闭环；aggKey 与窗口 1 相同（同 (level,name,msg) ⇒ 同键），ts/sn 不同不影响键
  assert.equal(r.rows[3].kind, 'log-aggregate', '第 4 行是窗口 2 的闭环行');
  assert.equal(r.rows[3].count, 3, '窗口 2 ⇒ count=3（实际: ' + r.rows[3].count + '）');
  assert.equal(r.rows[3].aggKey, r.rows[1].aggKey, 'aggKey 只由 (level,name,msg) 决定：跨窗口相同（前:' + r.rows[1].aggKey + ' 后:' + r.rows[3].aggKey + '）');
  assert.equal(r.rows[3].sn, 5, '窗口 2 闭环行 sn = 窗口 2 首行 sn');
  assert.equal(r.rows[3].ts, ISO(BASE + 72000), '窗口 2 闭环行 ts = 其末条被抑制消息时间');

  // ⑥ 计数器与守恒式
  assert.equal(r.stat.messagesSeen, 8, 'messagesSeen=8（实际: ' + r.stat.messagesSeen + '）');
  assert.equal(r.stat.collapsedMessages, 5, 'collapsedMessages = 3 + 2 = 5（实际: ' + r.stat.collapsedMessages + '）');
  assert.equal(r.stat.aggregateRows, 2, 'aggregateRows=2（实际: ' + r.stat.aggregateRows + '）');
  assert.equal(r.stat.writes, 5, 'writes = 物理行数 5（闭环行也计入——成功写盘行数语义未变）');
  assert.equal(r.stat.writes, r.rows.length, 'writes 与物理行数逐行对应');
  assertConservation(r.stat, 'T-C1');
});

// ── T-C2 L3 开关 off 态：逐行落盘、零闭环行、字面式成立（回归对照面）──

test('T-C2 聚合 off 态（PUNKY_AUDITLOG_AGGREGATE=off）：5 条同键消息逐行落盘、零 log-aggregate、collapsedMessages 恒 0', () => {
  const r = runProbe('tc2', { PUNKY_PROBE_AGG_SCENARIO: 'off', PUNKY_AUDITLOG_AGGREGATE: 'off' }, 'aggregate');
  assert.equal(r.ok, true, '探测体未报错（error: ' + JSON.stringify(r.error) + '）');
  assert.equal(r.rows.length, 5, '5 条消息逐行落盘（实际: ' + r.rows.length + '）');
  assert.equal(r.rows.filter((x) => x.kind === 'log-aggregate').length, 0, '关闭态零 log-aggregate 行');
  assert.deepEqual([...new Set(r.rows.map((x) => x.kind))], ['log'], '全部为 kind="log"（实际: ' + JSON.stringify(r.rows.map((x) => x.kind)) + '）');
  assert.ok(r.rows.every((x) => !('count' in x)), '关闭态每行仍恰 10 字段（无 count）');
  assert.equal(r.stat.collapsedMessages, 0, 'collapsedMessages 恒 0（实际: ' + r.stat.collapsedMessages + '）');
  assert.equal(r.stat.aggregateRows, 0, 'aggregateRows 恒 0（实际: ' + r.stat.aggregateRows + '）');
  assert.equal(r.stat.writes, 5, 'writes=5');
  assert.equal(r.stat.messagesSeen, 5, 'messagesSeen=5');
  assert.equal(r.stat.messagesSeen, r.stat.writes + r.stat.filteredByLevel + r.stat.collapsedMessages + r.stat.failures,
    'off 态：字面式（= 旧行为）逐字成立');
});

// ── T-C3 L0 阈值层 + L2④：过滤先于聚合；被聚合时 warn 仍可见 ──

test('T-C3 阈值先于聚合（levelsDefault=1）：info 3 条全被过滤且不进窗口；warn 折叠后仍可见（首行 + 闭环行）', () => {
  const r = runProbe('tc3', { PUNKY_PROBE_AGG_SCENARIO: 'level', PUNKY_AUDITLOG_LEVELS_DEFAULT: '1' }, 'aggregate');
  assert.equal(r.ok, true, '探测体未报错（error: ' + JSON.stringify(r.error) + '）');
  assert.equal(r.stat.filteredByLevel, 3, '阈值 1：3 条 info 被 sink 侧过滤（实际: ' + r.stat.filteredByLevel + '）');
  assert.equal(r.rows.filter((x) => x.level === 'info').length, 0, 'info 0 命中（L1 语义不受聚合影响）');
  assert.equal(r.rows.filter((x) => x.level === 'warn').length, 3,
    '阈值 1 仍收到真实 warn：首行 + 闭环行 + 新首行 = 3 行（实际: ' + r.rows.filter((x) => x.level === 'warn').length + '）');
  assert.equal(r.rows[0].kind, 'log', '第 1 行 = warn 首行');
  assert.equal(r.rows[1].kind, 'log-aggregate', '第 2 行 = warn 闭环行');
  assert.equal(r.rows[1].count, 3, '闭环行 count=3（实际: ' + r.rows[1].count + '）');
  assert.equal(r.stat.collapsedMessages, 2, '被过滤的 info 绝不进窗口：collapsedMessages 只算 warn 的 2 条（实际: ' + r.stat.collapsedMessages + '）');
  assert.equal(r.stat.messagesSeen, 7, 'messagesSeen = 3 info + 4 warn（实际: ' + r.stat.messagesSeen + '）');
  assertConservation(r.stat, 'T-C3');
});

// ── T-C4 闭环落点③：flushDiagnostics() 全键 flush ──

test('T-C4 闭环落点③ flushDiagnostics()：未越窗的同键消息在手动 flush 时闭环成 1 行 count=3', () => {
  const r = runProbe('tc4', { PUNKY_PROBE_AGG_SCENARIO: 'flush' }, 'aggregate');
  assert.equal(r.ok, true, '探测体未报错（error: ' + JSON.stringify(r.error) + '）');
  assert.equal(r.rowsBeforeFlush, 1, 'flush 前只有首行（窗口内不为被抑制消息写任何行；实际: ' + r.rowsBeforeFlush + '）');
  assert.equal(r.statBeforeFlush.collapsedMessages, 2, 'flush 前已折叠 2 条');
  assert.equal(r.statBeforeFlush.aggregateRows, 0, 'flush 前零闭环行');
  assert.equal(r.rows.length, 2, 'flush 后补写 1 行闭环行（实际: ' + r.rows.length + '）');
  assert.equal(r.rows[1].kind, 'log-aggregate', 'flush 补写的是 log-aggregate 行');
  assert.equal(r.rows[1].count, 3, 'count=3（实际: ' + r.rows[1].count + '）');
  assert.equal(r.rows[1].ts, ISO(BASE + 2000), '闭环行 ts = 末条被抑制消息时间（实际: ' + r.rows[1].ts + '）');
  assert.equal(r.stat.aggregateRows, 1, 'aggregateRows=1');
  assertConservation(r.stat, 'T-C4');
});

// ── T-C5 闭环落点②：进程 exit 钩子（父进程在子进程退出后读盘取证）──

test('T-C5 闭环落点② exit 钩子：子进程退出即全键 flush，父进程读回闭环行 count=3', () => {
  const r = runProbe('tc5', { PUNKY_PROBE_AGG_SCENARIO: 'exit' }, 'aggregate');
  assert.equal(r.ok, true, '探测体未报错（error: ' + JSON.stringify(r.error) + '）');
  assert.equal(r.rowsBeforeExit, 1, '进程内读到的仍是 1 行（窗口未闭环；实际: ' + r.rowsBeforeExit + '）');
  const after = fs.readFileSync(path.join(r.__sinkDir, 'audit-' + DAY + '.jsonl'), 'utf8')
    .split('\n').filter((l) => l).map((l) => JSON.parse(l));
  assert.equal(after.length, 2, '子进程退出后（父进程重新读盘）共 2 行（实际: ' + after.length + '）');
  assert.equal(after[1].kind, 'log-aggregate', '第 2 行由 exit 钩子写出');
  assert.equal(after[1].count, 3, 'count=3（实际: ' + after[1].count + '）');
  assert.equal(after[1].ts, ISO(BASE + 2000), '闭环行 ts = 末条被抑制消息时间');
});

// ── T-C6 窗口硬上限 600000 ms ──

test('T-C6 硬上限 600000 ms：逐条刷新右界的窗口被顶到 startAt+600000 后闭环（否则该条会被继续折叠）', () => {
  const r = runProbe('tc6', { PUNKY_PROBE_AGG_SCENARIO: 'cap' }, 'aggregate');
  assert.equal(r.ok, true, '探测体未报错（error: ' + JSON.stringify(r.error) + '）');
  assert.equal(r.rows.length, 3, '首行 + 闭环行 + 新首行（实际: ' + r.rows.length + '）');
  assert.equal(r.rows[1].kind, 'log-aggregate', '第 2 行 = 闭环行');
  assert.equal(r.rows[1].count, 11,
    '12 条中前 11 条同窗（滑动刷新把右界顶到硬上限 startAt+600000）⇒ count=11；'
    + '若窗口无硬上限（右界会被刷到 659990），第 12 条会被继续折叠 ⇒ 不会出现闭环行（实际: ' + r.rows[1].count + '）');
  assert.equal(r.rows[1].ts, ISO(Date.parse('2026-09-12T20:00:00.000Z') + 599990), '闭环行 ts = 末条被抑制消息时间');
  assert.equal(r.stat.aggregateRows, 1, '恰 1 行闭环行');
  assert.equal(r.stat.collapsedMessages, 10, 'collapsedMessages=10（实际: ' + r.stat.collapsedMessages + '）');
  assertConservation(r.stat, 'T-C6');
});

// ── T-C7 诊断面 aggregate 段（AC-12）＋ 闭环落点③ 的快照顺序 ──

test('T-C7 诊断面 aggregate 段：windowOpen/collapsedTotal/keys[≤50] 落盘，既有字段不变', () => {
  const root = freshRoot('tc7');
  const sinkDir = seedUnappendableSink(root);                    // 写失败可注入、sink 根可建
  const r = runProbeRaw('tc7', { PUNKY_PROBE_AGG_SCENARIO: 'diag' }, 'aggregate', { root });
  assert.equal(r.ok, true, '探测体未报错（error: ' + JSON.stringify(r.error) + '）');
  assert.equal(r.diagExists, true, '诊断面已落盘（' + r.diagPath + '）');
  const d = r.diag;
  assert.equal(d.note, 'agg-probe-diag', 'note 取调用方给定值（实际: ' + d.note + '）');
  assert.ok(d.aggregate, '诊断面含 aggregate 段（实际: ' + JSON.stringify(Object.keys(d)) + '）');
  assert.equal(d.aggregate.windowOpen, 1, '快照时刻 1 个窗口未闭环（快照先于 flush——B5 的唯一补救面；实际: ' + d.aggregate.windowOpen + '）');
  assert.equal(d.aggregate.collapsedTotal, 2, 'collapsedTotal=2（实际: ' + d.aggregate.collapsedTotal + '）');
  assert.equal(d.aggregate.keys.length, 1, 'keys 含 1 条（实际: ' + d.aggregate.keys.length + '）');
  assert.equal(d.aggregate.keys[0].count, 3, 'keys[0].count=3（实际: ' + JSON.stringify(d.aggregate.keys[0]) + '）');
  assert.ok(HEX16.test(d.aggregate.keys[0].aggKey), 'keys[0].aggKey 为 16 位 hex');
  assert.equal(d.aggregate.keys[0].windowEnd, ISO(BASE + 62000), 'keys[0].windowEnd = 刷新后的窗口右界（实际: ' + d.aggregate.keys[0].windowEnd + '）');
  assert.ok(!Number.isNaN(Date.parse(d.aggregate.keys[0].windowEnd)), 'windowEnd 可 Date.parse');
  assert.ok(d.aggregate.keys.length <= 50, 'keys 有界（≤50）');
  for (const k of ['v', 'ts', 'pid', 'engine', 'sinkDir', 'sinkPath', 'attempts', 'writes', 'failures', 'consecutiveFailures',
    'skippedByBreaker', 'sinkErrorRecords', 'sinkErrorRecordsFailed', 'filteredByLevel', 'lastError']) {
    assert.ok(k in d, '既有诊断面字段不丢：' + k);
  }
  assert.equal(d.sinkDir, sinkDir, '诊断面记录实际 sink 根');
  assert.ok(r.stat.failures > 0, '该场景确有写失败（failures>0；实际: ' + r.stat.failures + '）');
  assert.equal(r.stat.aggregateRows, 1, 'flush 仍写出闭环行（写失败也计入产出面）');
  assert.equal(r.stat.collapsedMessages, 2, 'collapsedMessages=2');
  assertConservation(r.stat, 'T-C7');
});

// ── T-C8 近行长上限的行不聚合（闭环行 msg/args 必须与首行逐字相同）──

test('T-C8 近行长上限（余量 < 闭环行附加字段）的行不聚合：逐行落盘、msg 未被截断、零折叠', () => {
  const r = runProbe('tc8', { PUNKY_PROBE_AGG_SCENARIO: 'sealed' }, 'aggregate');
  assert.equal(r.ok, true, '探测体未报错（error: ' + JSON.stringify(r.error) + '）');
  assert.ok(r.sealedLineBytes <= 32768 && r.sealedLineBytes + 64 > 32768,
    '构造出的行长处于「未截断但余量 < 64 字节」区间（实际: ' + r.sealedLineBytes + '）');
  assert.equal(r.rows.length, 4, '4 条同键消息逐行落盘（不聚合；实际: ' + r.rows.length + '）');
  assert.deepEqual([...new Set(r.rows.map((x) => x.kind))], ['log'], '零 log-aggregate 行');
  assert.ok(r.rows.every((x) => x.truncated === false), '首行未被截断（msg 逐字保留）');
  assert.equal(r.rows[0].msg.length, r.sealedMsgChars, 'msg 未被截断改写（实际: ' + r.rows[0].msg.length + ' vs ' + r.sealedMsgChars + '）');
  assert.equal(r.rows[0].msg.endsWith('...[truncated]'), false, 'msg 尾部无截断标记（该行确未走截断路径）');
  assert.equal(r.rows[0].args[0].length, r.sealedArgsChars, 'args 逐字保留');
  assert.ok(r.rows.every((x) => Buffer.byteLength(JSON.stringify(x), 'utf8') <= 32768), '每行仍 ≤ 32768 字节');
  assert.equal(r.stat.collapsedMessages, 0, '近上限行不进折叠面（实际: ' + r.stat.collapsedMessages + '）');
  assert.equal(r.stat.aggregateRows, 0, '零闭环行');
  assert.equal(r.stat.messagesSeen, r.stat.writes, '4 条消息 = 4 行（字面式亦成立）');
  assertConservation(r.stat, 'T-C8');
});
