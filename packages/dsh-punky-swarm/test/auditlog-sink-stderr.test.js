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

// 审计日志 sink 的 **stderr 可观测面**测试（批 punky-logfix-20261023 / L-1 / 用户裁决 Q-19b）。
//
// 存在理由：既有探针 `test/auditlog-mount.test.js` 用 `execFileSync` 且**不捕获 stderr**（`:342`），
//   「生命周期至多 2 条 stderr 告警」这条判据在既有载体上结构性不可读 ⇒ 本文件用
//   `spawnSync(process.execPath, [...], { encoding: 'utf8' })` 起子进程、**直接读回 r.stderr 字节**。
//
// 判据映射（规格 `plan/fix-spec-logfix.md` AC-1…AC-6）：
//   AC-1 一次性失败 ⇒ stderr 恰 1 行「sink append failed」（且**不含**跳闸行）
//   AC-2 持续失败至 consecutiveFailures=3 ⇒ 第 2 行「sink breaker tripped」
//   AC-3 硬读数：8 次 / 40 次 / 1100 次（跨 1000 探活点）均为**恰 2 行**，两行内容不重复
//   AC-4 正常写盘 ⇒ stderr **字节级为空** + stderrNotices=0（反向：writes>0 证明真写盘）
//   AC-5 零 stdout、stderr 不含 `{"v":` 协议行
//   AC-6 process.stderr.write 抛错 ⇒ 不自噬（进程正常退出、记账照常、计数不受影响）
//
// 隔离机制（与 auditlog-mount 同款）：子进程用隔离 USERPROFILE / HOME / DSH_HOME；只在 os.tmpdir()
//   下建目录；被测模块经绝对 file:// URL 导入（探测体自身落临时目录，不落仓库）。
// 确定性控制：每条消息用**不同 msg**（aggKey 含 msg，见 sink.js:333-334），另置
//   `PUNKY_AUDITLOG_AGGREGATE=off` ⇒ 1 次 exportMessage ≡ 1 次写盘尝试，读数与消息数一一对应。
// R-5@techdebt2：子进程不继承主测试进程的 `--import` ⇒ 解析钩子显式注入 argv（同 auditlog-mount）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hostDepFallbackImportArgs } from './helpers/host-dep-fallback.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const SINK_JS = path.join(PKG, 'lib', 'auditlog', 'sink.js');

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
function freshRootTracked(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-auditlog-stderr-' + tag + '-'));
  pendingRoots.push(d);
  return d;
}

// ── 探测体（写入隔离临时文件；只把一段 JSON 写 stdout，stderr 留给被测模块）──

const PROBE_SOURCE = `import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const asUrl = (p) => pathToFileURL(p).href;
const { mountAuditLog, exportMessage, auditlogStats } = await import(asUrl(process.env.PUNKY_PROBE_SINK));

const MODE = process.env.PUNKY_STDERR_MODE || 'normal';
const SINK_DIR = process.env.PUNKY_STDERR_SINK_DIR || '';
const COUNT = Number(process.env.PUNKY_STDERR_COUNT || '8');
const DAY = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); })();
const LEVEL_OF = { error: 0, warn: 1, info: 2, debug: 3 };
const TYPES = ['error', 'warn', 'info', 'debug'];
const ctxStub = { logger: { exporter: () => () => {} } };
// ⚠ 真配置形状（实读 lib/auditlog/config.js:131-136）：能力键在 capabilities.auditlog 之下，
//   **不是** config 顶层（顶层 {sinkDir} 会被静默忽略 → sink 落回 DSH_HOME，本文件全部判据都失去意义）。
//   故此处按真形状注入，并由父进程断言 res.sinkDir === SINK_DIR 作反「静默忽略」控制。
const config = { capabilities: { auditlog: { sinkDir: SINK_DIR, enabled: true } } };
function emit(seq, prefix) {
  const type = TYPES[seq % TYPES.length];
  exportMessage({ sn: seq, ts: Date.now(), type: type, level: LEVEL_OF[type], name: 'stderr-probe',
    args: [prefix + ' #' + seq] });
}

const out = { ok: false, mode: MODE };
try {
  if (MODE === 'normal') {
    fs.mkdirSync(SINK_DIR, { recursive: true });
    const res = mountAuditLog(ctxStub, { config: config });
    out.mounted = res.mounted;
    out.mountedSinkDir = res.sinkDir;
    for (let i = 1; i <= COUNT; i++) emit(i, 'normal path row');
    try {
      out.rows = fs.readFileSync(path.join(SINK_DIR, 'audit-' + DAY + '.jsonl'), 'utf8')
        .split('\\n').filter((l) => l.length > 0).length;
    } catch { out.rows = -1; }
  } else if (MODE === 'single-shot-failure') {
    // 一次性注入：主卷路径预置为**目录** ⇒ 首次 append EISDIR；随后 rmdir 恢复可写
    // （手法同 test/auditlog-mount.test.js 的 seedUnappendableSink，不 mock 任何 fs 函数）
    fs.mkdirSync(SINK_DIR, { recursive: true });
    const mainPath = path.join(SINK_DIR, 'audit-' + DAY + '.jsonl');
    fs.mkdirSync(mainPath, { recursive: true });
    const res = mountAuditLog(ctxStub, { config: config });
    out.mounted = res.mounted;
    out.mountedSinkDir = res.sinkDir;
    emit(1, 'single shot row');
    out.statAfterFailure = auditlogStats();
    fs.rmdirSync(mainPath);
    for (let i = 2; i <= 4; i++) emit(i, 'single shot row');
  } else if (MODE === 'persistent-failure' || MODE === 'stderr-throws') {
    // 持续失败：sink 根落在**普通文件**之下 ⇒ mkdir/append 双失败（父进程建好该普通文件）
    if (MODE === 'stderr-throws') process.stderr.write = () => { throw new Error('EPIPE'); };
    const res = mountAuditLog(ctxStub, { config: config });
    out.mounted = res.mounted;
    out.mountedSinkDir = res.sinkDir;
    for (let i = 1; i <= COUNT; i++) emit(i, 'persistent failure row');
  } else {
    throw new Error('unknown mode: ' + MODE);
  }
  out.ok = true;
  out.stat = auditlogStats();
} catch (error) {
  out.ok = false;
  out.error = String((error && error.stack) || error);
}
process.stdout.write('\\n__PROBE_JSON__' + JSON.stringify(out) + '\\n');
`;

let probePath = null;
function probeFile() {
  if (!probePath) {
    const dir = freshRootTracked('probe');
    probePath = path.join(dir, 'probe.mjs');
    fs.writeFileSync(probePath, PROBE_SOURCE, 'utf8');
  }
  return probePath;
}

const MARKER = '__PROBE_JSON__';

/**
 * 起子进程跑一个场景。
 * @param {{mode: string, sinkDir: string, count?: number, tag: string}} spec
 * @returns {{status: number, stdout: string, stderr: string, result: object}}
 */
function runProbe({ mode, sinkDir, count = 8, tag }) {
  const root = freshRootTracked(tag);
  const home = path.join(root, 'user');
  const dshHome = path.join(root, 'dsh-home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dshHome, { recursive: true });
  const env = {
    ...process.env,
    USERPROFILE: home,                        // 隔离①②：不触达真实用户目录
    HOME: home,
    DSH_HOME: dshHome,
    PUNKY_PROBE_SINK: SINK_JS,
    PUNKY_STDERR_MODE: mode,
    PUNKY_STDERR_SINK_DIR: sinkDir,
    PUNKY_STDERR_COUNT: String(count),
    PUNKY_AUDITLOG_AGGREGATE: 'off',          // 1 消息 = 1 次写盘尝试（确定性）
  };
  // 防主进程环境污染：这两项会覆盖探测体显式传入的 sinkDir / stdout 语义
  delete env.PUNKY_AUDITLOG_SINK_DIR;
  delete env.PUNKY_LOGGER_STDOUT;
  const r = spawnSync(process.execPath, [...hostDepFallbackImportArgs(), probeFile()], {
    env,
    encoding: 'utf8',
    timeout: 180000,
  });
  assert.equal(r.error, undefined, '子进程未抛启动错误（' + String(r.error && r.error.message) + '）');
  const stdout = r.stdout ?? '';
  const idx = stdout.lastIndexOf(MARKER);
  assert.ok(idx >= 0, '探测体必须输出结果标记（status=' + r.status + '；stdout 尾部: '
    + stdout.slice(-500) + '；stderr: ' + String(r.stderr).slice(-500) + '）');
  const result = JSON.parse(stdout.slice(idx + MARKER.length).split('\n')[0]);
  // 反「静默忽略」控制：注入的 sinkDir 必须真被采用，否则场景根本没落在不可写路径上（判据会假绿/假红）
  assert.equal(result.mounted, true, 'sink 已挂载（mode=' + mode + '）');
  assert.equal(path.resolve(String(result.mountedSinkDir ?? '')), path.resolve(sinkDir),
    '注入的 sinkDir 必须被采用（mode=' + mode + '；实际: ' + String(result.mountedSinkDir) + '）');
  return { status: r.status, stdout, stderr: r.stderr ?? '', result };
}

/** stderr 的非空行（判据一律按行计数，不按字节数猜） */
const stderrLines = (r) => r.stderr.split('\n').filter((l) => l.trim() !== '');
const countOf = (haystack, needle) => haystack.split(needle).length - 1;

// ── D-16-③ 主判据：**精确四数 + 守恒式**（规格 §D-16-③ / §C-6、C-7、C-8）──
//
// 为什么不能停在 `failures >= 4` 这类**下界式**：把 `lib/auditlog/sink.js` 的探活放行行
// （`if (state.attempts % BREAKER_PROBE_INTERVAL === 0) return false;`）注释掉后，
// 读数为 `failures=3 / skippedByBreaker=1097` —— 旧断言 `failures >= 4` 本会红，但**更早**的
// `>= 3` 式（以及任何「只需要非零/不低于阈值」的写法）会照样通过：下界式判的是「至少发生了一次」，
// 而我们要判的是「**探活点被走到且只被放行一次**」。精确四数同时成立才是这条分支的可执行证据；
// 守恒式 `attempts === failures + skippedByBreaker + writes` 让「任一计数被悄悄改语义」也立刻红。
//
// 读数口径：`PUNKY_AUDITLOG_AGGREGATE=off` ⇒ 1 条消息 = 1 次 writeLine；持续失败 + 断路后
// 每 1000 次尝试放行一次探活，故 failures = 3（首三次）+ 探活点 1 次，其余全进 skippedByBreaker。
const BREAKER_EXPECT = {
  8: { attempts: 8, failures: 3, skippedByBreaker: 5, writes: 0 },
  40: { attempts: 40, failures: 3, skippedByBreaker: 37, writes: 0 },
  1100: { attempts: 1100, failures: 4, skippedByBreaker: 1096, writes: 0 },
};

/** 精确四数 + 守恒式（任一不成立即红；count 为注入的消息数 = attempts 的期望） */
function assertBreakerExact(stat, count) {
  const e = BREAKER_EXPECT[count];
  const detail = '(实际 stat: ' + JSON.stringify({
    attempts: stat.attempts, failures: stat.failures,
    skippedByBreaker: stat.skippedByBreaker, writes: stat.writes,
  }) + ')';
  assert.equal(stat.attempts, e.attempts, 'count=' + count + ' ⇒ attempts === ' + e.attempts + ' ' + detail);
  assert.equal(stat.failures, e.failures, 'count=' + count + ' ⇒ failures === ' + e.failures
    + '（3 次首失败 + 探活点放行）' + detail);
  assert.equal(stat.skippedByBreaker, e.skippedByBreaker, 'count=' + count
    + ' ⇒ skippedByBreaker === ' + e.skippedByBreaker + '（精确值，非 > 0 下界式）' + detail);
  assert.equal(stat.writes, e.writes, 'count=' + count + ' ⇒ writes === ' + e.writes + ' ' + detail);
  assert.equal(stat.attempts, stat.failures + stat.skippedByBreaker + stat.writes,
    'count=' + count + ' ⇒ 守恒式 S3：attempts === failures + skippedByBreaker + writes' + detail);
}

/** 「sink 根落在普通文件下」的不可写构造：返回 <root>/not-a-dir/logs */
function unappendableSinkDir(root) {
  fs.writeFileSync(path.join(root, 'not-a-dir'), 'regular file, not a directory', 'utf8');
  return path.join(root, 'not-a-dir', 'logs');
}

// ── AC-1 首失败一条（限定：注入 1 次 append 失败后立即恢复）──

test('AC-1 一次性写失败 ⇒ stderr 恰 1 行「sink append failed」，且不含跳闸行', () => {
  const root = freshRootTracked('ac1');
  const sinkDir = path.join(root, 'sink');
  const r = runProbe({ mode: 'single-shot-failure', sinkDir, tag: 'ac1' });
  assert.equal(r.status, 0, '子进程正常退出（stderr: ' + r.stderr + '）');
  assert.equal(r.result.ok, true, '探测体未报错（error: ' + JSON.stringify(r.result.error) + '）');
  assert.equal(r.result.statAfterFailure.failures, 1, '注入面上**只**失败 1 次（实际: '
    + JSON.stringify(r.result.statAfterFailure) + '）');

  const lines = stderrLines(r);
  assert.equal(lines.length, 1, 'stderr 行数 === 1（实际 ' + lines.length + ' 行: ' + JSON.stringify(r.stderr) + '）');
  const line = lines[0];
  assert.ok(line.includes('[punky-auditlog]'), '行前缀 [punky-auditlog]（实际: ' + line + '）');
  assert.ok(line.includes('sink append failed'), '行含 sink append failed（实际: ' + line + '）');
  assert.ok(line.includes('path='), '行含 path=（实际: ' + line + '）');
  assert.ok(line.includes('attempts='), '行含 attempts=（实际: ' + line + '）');

  // 恢复面：随后的 3 条真落盘（证明失败是一次性的、断路器未被触发）
  const stat = r.result.stat;
  assert.equal(stat.failures, 1, '恢复后总失败数仍为 1（实际: ' + stat.failures + '）');
  assert.equal(stat.writes, 3, '恢复后 3 条成功落盘（实际: ' + stat.writes + '）');
  assert.equal(stat.consecutiveFailures, 0, '成功即解除断路器（实际: ' + stat.consecutiveFailures + '）');
  assert.equal(stat.stderrNotices, 1, 'stderrNotices === 1（实际: ' + stat.stderrNotices + '）');

  // 反向断言：只失败 1 次 ⇒ 未达阈值 ⇒ 跳闸行**必须不出现**
  assert.equal(countOf(r.stderr, 'breaker tripped'), 0, 'stderr 不含 breaker tripped（实际: ' + r.stderr + '）');
});

// ── AC-2 跳闸一条（持续失败至 consecutiveFailures === 3）──

test('AC-2 持续失败至阈值 ⇒ 第 2 行「sink breaker tripped」，计数器语义零改', () => {
  const root = freshRootTracked('ac2');
  const r = runProbe({ mode: 'persistent-failure', sinkDir: unappendableSinkDir(root), count: 8, tag: 'ac2' });
  assert.equal(r.status, 0, '子进程正常退出（stderr: ' + r.stderr + '）');
  assert.equal(r.result.ok, true, '探测体未报错（error: ' + JSON.stringify(r.result.error) + '）');
  const stat = r.result.stat;
  assert.equal(stat.consecutiveFailures, 3, 'consecutiveFailures === 3（实际: ' + stat.consecutiveFailures + '）');
  // 【D-16-③ / C-8】skippedByBreaker 不再以 `> 0` 作为判据：精确 5 + 守恒式（count=8）
  assertBreakerExact(stat, 8);
  // EQ-6 反向：既有计数器语义一字未改（旁路观测不参与记账）
  assert.equal(stat.failures, 3, 'failures === 3（实际: ' + stat.failures + '）');
  assert.equal(stat.sinkErrorRecords, 0, 'sinkErrorRecords === 0（实际: ' + stat.sinkErrorRecords + '）');
  assert.equal(stat.sinkErrorRecordsFailed, 3, 'sinkErrorRecordsFailed === 3（实际: ' + stat.sinkErrorRecordsFailed + '）');

  const lines = stderrLines(r);
  assert.equal(lines.length, 2, 'stderr 行数 === 2（实际 ' + lines.length + ' 行: ' + JSON.stringify(r.stderr) + '）');
  assert.ok(lines[0].includes('sink append failed'), '第 1 行 = 首失败行（实际: ' + lines[0] + '）');
  const trip = lines[1];
  assert.ok(trip.includes('sink breaker tripped'), '第 2 行含 sink breaker tripped（实际: ' + trip + '）');
  assert.ok(trip.includes('consecutiveFailures=3/3'), '第 2 行含 consecutiveFailures=3/3（实际: ' + trip + '）');
  assert.ok(trip.includes('sinkPath='), '第 2 行含 sinkPath=（实际: ' + trip + '）');

  // AC-5：零 stdout、未走 {"v": 协议行通道
  assert.equal(stat.stdoutWrites, 0, 'stdoutWrites === 0（实际: ' + stat.stdoutWrites + '）');
  assert.equal(countOf(r.stderr, '{"v":'), 0, 'stderr 不含 {"v": 形态的 JSON 行');
});

// ── AC-3 三条上限 = 硬读数（本项最关键）──

test('AC-3 上限硬读数：8 / 40 / 1100 次（跨 1000 探活点）stderr 恒为恰 2 行、两行不重复', () => {
  for (const count of [8, 40, 1100]) {
    const root = freshRootTracked('ac3-' + count);
    const r = runProbe({ mode: 'persistent-failure', sinkDir: unappendableSinkDir(root), count, tag: 'ac3-' + count });
    assert.equal(r.status, 0, 'count=' + count + ' 子进程正常退出（stderr 尾部: ' + r.stderr.slice(-500) + '）');
    assert.equal(r.result.ok, true, 'count=' + count + ' 探测体未报错（error: '
      + JSON.stringify(r.result.error) + '）');
    const lines = stderrLines(r);
    // 正向：**恰等于 2**（不是 ≤2、不是 ≥2）
    assert.equal(lines.length, 2, 'count=' + count + ' ⇒ stderr 行数恰 2（实际 ' + lines.length
      + ': ' + JSON.stringify(r.stderr) + '）');
    assert.equal(r.result.stat.stderrNotices, 2, 'count=' + count + ' ⇒ stderrNotices === 2（实际: '
      + r.result.stat.stderrNotices + '）');
    // 反向 ②：两行内容不重复（各出现恰 1 次）
    assert.equal(countOf(r.stderr, 'append failed'), 1, 'count=' + count + ' ⇒ append failed 出现 1 次');
    assert.equal(countOf(r.stderr, 'breaker tripped'), 1, 'count=' + count + ' ⇒ breaker tripped 出现 1 次');
    // 反向 ③：1000 探活点不刷屏 —— count=1100 时 attempts 已跨过 1000（放行一次探活），仍恒 2 行
    // 【D-16-③】主判据（三段读数一律**精确四数 + 守恒式**，替换原来的
    //   `attempts >= 1100` / `failures >= 4` 下界式）：
    //   注掉 sink.js 的探活放行行 ⇒ failures=3 / skippedByBreaker=1097 ⇒ 这里**转红**；
    //   恢复后绿。反向构造与读数见 `exec/change-sink-fidelity.md` §反向验证。
    assertBreakerExact(r.result.stat, count);
    if (count === 1100) {
      assert.equal(r.result.stat.failures, 4, '探活放行确有一次真尝试并被记账（failures 精确 4，实际: '
        + r.result.stat.failures + '）');
      assert.equal(r.result.stat.skippedByBreaker, 1096, '断路跳过精确 1096（实际: '
        + r.result.stat.skippedByBreaker + '）');
    }
  }
});

// ── AC-4 正常路径零输出（行为等价关键判据）──

test('AC-4 正常写盘 ⇒ stderr 字节级为空、stderrNotices=0（反向：真写了盘）', () => {
  const root = freshRootTracked('ac4');
  const r = runProbe({ mode: 'normal', sinkDir: path.join(root, 'sink'), count: 20, tag: 'ac4' });
  assert.equal(r.status, 0, '子进程正常退出（stderr: ' + r.stderr + '）');
  assert.equal(r.result.ok, true, '探测体未报错（error: ' + JSON.stringify(r.result.error) + '）');
  const stat = r.result.stat;
  assert.equal(r.stderr, '', 'stderr 字节级为空（实际: ' + JSON.stringify(r.stderr) + '）');
  assert.equal(stat.stderrNotices, 0, 'stderrNotices === 0（实际: ' + stat.stderrNotices + '）');
  // 反向：空的 stderr 不是空跑
  assert.ok(stat.writes > 0, 'writes > 0（实际: ' + stat.writes + '）');
  assert.equal(stat.failures, 0, 'failures === 0（实际: ' + stat.failures + '）');
  assert.equal(r.result.rows, 20, '20 条消息全部落盘（实际: ' + r.result.rows + '）');
  assert.equal(stat.stdoutWrites, 0, 'stdoutWrites === 0（stdout 开关零介入）');
});

// ── AC-5 零 stdout / 不污染协议面 ──

test('AC-5 失败场景零 stdout：stdoutWrites=0 且 stderr 无 {"v": 协议行', () => {
  const root = freshRootTracked('ac5');
  const r = runProbe({ mode: 'persistent-failure', sinkDir: unappendableSinkDir(root), count: 8, tag: 'ac5' });
  assert.equal(r.status, 0, '子进程正常退出（stderr: ' + r.stderr + '）');
  assert.equal(r.result.ok, true, '探测体未报错（error: ' + JSON.stringify(r.result.error) + '）');
  const stat = r.result.stat;
  assert.equal(stat.stdoutWrites, 0, 'stdoutWrites === 0（实际: ' + stat.stdoutWrites + '）');
  assert.equal(countOf(r.stderr, '{"v":'), 0, 'stderr 不含 {"v": 形态的 JSON 行（未走 buildRow/stdoutWrite 通道）');
  assert.equal(countOf(r.stderr, '[punky-auditlog]'), 2, '唯一外显面 = 2 条带前缀的告警行（实际: ' + r.stderr + '）');
  // 反向：告警只走 stderr —— 子进程 stdout 只有结果标记，不含落盘协议行
  assert.equal(countOf(r.stdout, '{"v":'), 0, '子进程 stdout 不含 {"v": 协议行');
});

// ── AC-6 不得自噬（process.stderr.write 抛错）──

test('AC-6 stderr 自身写失败 ⇒ 不自噬：进程正常退出、记账照常、不新增记录', () => {
  const root = freshRootTracked('ac6');
  const r = runProbe({ mode: 'stderr-throws', sinkDir: unappendableSinkDir(root), count: 8, tag: 'ac6' });
  assert.equal(r.status, 0, '进程正常退出（status 应为 0；stderr: ' + r.stderr + '）');
  assert.equal(r.result.ok, true, '探测体未报错、未冒泡（error: ' + JSON.stringify(r.result.error) + '）');
  const stat = r.result.stat;
  assert.equal(stat.stderrNotices, 2, '记账照常（write 失败被吞）：stderrNotices === 2（实际: '
    + stat.stderrNotices + '）');
  assert.ok(stat.sinkErrorRecordsFailed > 0, '原计数不受影响（实际: ' + stat.sinkErrorRecordsFailed + '）');
  assert.equal(stat.sinkErrorRecordsFailed, 3, '不自噬：告警未额外触发 writeSinkError（记录失败数仍为 3，实际: '
    + stat.sinkErrorRecordsFailed + '）');
  assert.equal(stat.failures, 3, 'failures 仍为 3（实际: ' + stat.failures + '）');
  assert.equal(stat.stdoutWrites, 0, 'stdoutWrites === 0（实际: ' + stat.stdoutWrites + '）');
  assert.equal(countOf(r.stderr, 'Uncaught'), 0, '无未捕获异常输出（实际: ' + r.stderr + '）');
});
