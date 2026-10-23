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

// 审计日志 sink 的**现场保真**测试（批 punky-viability-20261023 / lane c3-sinkfid / 规格 §D-16）。
//
// 判据映射（规格 `plan/fix-spec-viability.md` §D-16 + §C 组）：
//   C-1（①）首失败后连续 3 次 flush ⇒ 主快照与首失败快照**共存**、后者 sha256 逐字不变、主快照 note 为最后一次
//   C-2（①）跨进程：父跑先造首失败并退出，子跑再造 ⇒ `first-failure` 仍是**最早**那次（pid/ts 未变）
//   C-3（②）默认档：4KiB 分卷 + 40KiB stray×2、maxTotalBytes=20000 ⇒ `total=86016`（**含 stray**）、
//            stray 一个都不删、挂载期 warn **恰 1 条**、诊断面含 `strays{count,bytes,names,pruneOptIn}`
//   C-4（②）opt-in：`PUNKY_AUDITLOG_PRUNE_STRAY=1` ⇒ 只删 `audit-` 前缀的 stray，**非 audit- 前缀文件留存**，
//            总量降到 ≤ maxTotalBytes
//   C-5（②）等价边界：无 stray ⇒ warn 0 条、`strays.count=0`
//   C-6/C-7（③）精确四数 + 守恒式在 `test/auditlog-sink-stderr.test.js`（AC-2/AC-3 已收紧，反向构造 = 注释 `sink.js` 探活放行行）
//   schema 一致性（Q-1）：新键 `pruneStray` 可被 `resolveAuditLogConfig` 读出（config 键 + env 双通道），
//            且 `lib/schema.ts`/`.js`/`.d.ts` 三件成对（build 产物与源不漂移）
//
// 隔离机制（与 auditlog-sink-stderr 同款）：sink 是**进程级单实例**（`state.mounted` 幂等守卫）⇒ 每个场景
//   一个子进程；子进程用隔离 USERPROFILE / HOME / DSH_HOME；只在 `os.tmpdir()` 下建目录；
//   被测模块经绝对 `file://` URL 导入（探测体自身落临时目录，不落仓库）。
// 确定性控制：`PUNKY_AUDITLOG_AGGREGATE=off`（1 条消息 = 1 次写盘尝试）；配置数值一律**字符串**传入
//   （`resolveNumber` 只对字符串走 `parsePositive`，数字会被判非法并回落默认 —— 既有口径，见 03 进度文件）。
// R-5@techdebt2：子进程不继承主测试进程的 `--import` ⇒ 解析钩子显式注入 argv（同 auditlog-mount）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hostDepFallbackImportArgs } from './helpers/host-dep-fallback.mjs';
import { AUDITLOG_DEFAULTS, resolveAuditLogConfig } from '../lib/auditlog/config.js';
import { AUDITLOG_CONFIG_KEYS } from '../lib/schema.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const SINK_JS = path.join(PKG, 'lib', 'auditlog', 'sink.js');

const DAY = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
})();

// ── 场景夹具常量（读数与断言同源；改夹具须同步改断言，禁「随手调大」）──
const SEG_BYTES = 4096;                 // 4 KiB 分卷
const STRAY_BYTES = 40960;              // 40 KiB / stray（×2 ⇒ 81920）
const TOTAL_WITH_STRAY = SEG_BYTES + 2 * STRAY_BYTES;   // 86016（= 84 KiB，规格 C-3 的「84KB」）
const STRAY_TOTAL = 2 * STRAY_BYTES;    // 81920
const DEFAULT_MAX_TOTAL = '20000';      // 默认档上限（远小于 86016 ⇒ 必触发清理判定）
const OPTIN_MAX_TOTAL = '50000';        // opt-in 档上限（删掉分卷 + 1 个 stray 后可降到 ≤ 上限）
const STRAY_AUDIT = 'audit-' + DAY + '.jsonl.bak';   // audit- 前缀 stray ⇒ opt-in 时**可删**
const STRAY_OTHER = 'user-backup.dat';               // 非 audit- 前缀 ⇒ **永不删**

// ── 隔离根清理 ──
const pendingRoots = [];
process.on('exit', () => {
  for (const d of pendingRoots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 已清理 */ } }
});
function freshRootTracked(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-auditlog-sinkfid-' + tag + '-'));
  pendingRoots.push(d);
  return d;
}

// ── 探测体（写入隔离临时文件；只把一段 JSON 写 stdout，stderr 留给被测模块）──

const PROBE_SOURCE = `import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const asUrl = (p) => pathToFileURL(p).href;
const { mountAuditLog, exportMessage, auditlogStats, flushDiagnostics, pruneByTotal } =
  await import(asUrl(process.env.PUNKY_SF_SINK));

const MODE = process.env.PUNKY_SF_MODE || 'first-failure';
const SINK_DIR = process.env.PUNKY_SF_SINK_DIR || '';
const SEED = process.env.PUNKY_SF_SEED === '1';
const CFG = process.env.PUNKY_SF_CONFIGJSON ? JSON.parse(process.env.PUNKY_SF_CONFIGJSON) : {};
const ENV = process.env.PUNKY_SF_ENVJSON ? JSON.parse(process.env.PUNKY_SF_ENVJSON) : {};
const MAXTOTAL = Number(process.env.PUNKY_SF_MAXTOTAL || '0');
const DAY = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); })();

fs.mkdirSync(SINK_DIR, { recursive: true });
const mainPath = path.join(SINK_DIR, 'audit-' + DAY + '.jsonl');
const diagDir = path.join(SINK_DIR, 'diagnostics');
const firstPath = path.join(diagDir, 'sink-diagnostics.first-failure.json');
const mainDiag = path.join(diagDir, 'sink-diagnostics.json');
const sha = (p) => (fs.existsSync(p) ? createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const read = (p) => { try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; } catch { return null; } };
const snap = (p) => { const j = read(p); return j ? { note: j.note, pid: j.pid, ts: j.ts } : null; };
const ctx = { logger: { exporter: () => () => {} } };

// ② 的夹具：4KiB 分卷 + 40KiB stray×2（mtime 单调：分卷 < audit-前缀 stray < 用户备份）
function seedStrays(withSegment) {
  if (withSegment) fs.writeFileSync(mainPath, 'S'.repeat(4096));
  fs.writeFileSync(path.join(SINK_DIR, 'audit-' + DAY + '.jsonl.bak'), 'A'.repeat(40960));
  fs.writeFileSync(path.join(SINK_DIR, 'user-backup.dat'), 'B'.repeat(40960));
  const t0 = Date.now() / 1000 - 300;
  if (withSegment) fs.utimesSync(mainPath, t0, t0);
  fs.utimesSync(path.join(SINK_DIR, 'audit-' + DAY + '.jsonl.bak'), t0 + 100, t0 + 100);
  fs.utimesSync(path.join(SINK_DIR, 'user-backup.dat'), t0 + 200, t0 + 200);
}

const out = { ok: false, mode: MODE, day: DAY };
try {
  const warns = [];
  if (MODE === 'first-failure') {
    // 首失败构造：当日主卷名先建成**目录** ⇒ appendFileSync 抛 EISDIR（同 auditlog-sink-stderr 的 unappendableSinkDir 手法）
    if (SEED) { fs.mkdirSync(mainPath, { recursive: true }); seedStrays(false); }
    const res = mountAuditLog(ctx, {
      config: { capabilities: { auditlog: { sinkDir: SINK_DIR, keepDays: '14', ...CFG } } },
      env: ENV, home: process.env.HOME, warn: (m) => warns.push(m),
    });
    out.mounted = res.mounted;
    out.reason = res.reason;
    out.warns = warns;
    out.pid = process.pid;
    exportMessage({ sn: 1, ts: Date.now(), type: 'warn', level: 1, name: 'sinkfid', args: ['boom'] });
    out.firstAtFail = { exists: fs.existsSync(firstPath), sha: sha(firstPath), ...snap(firstPath) };
    out.mainAtFail = { note: read(mainDiag)?.note, strays: read(mainDiag)?.strays };
    out.steps = [];
    for (const label of ['manual', 'process-exit', 'manual']) {
      flushDiagnostics(label);
      out.steps.push({ label: label, firstSha: sha(firstPath), firstNote: read(firstPath)?.note,
        mainNote: read(mainDiag)?.note });
    }
    out.firstAfter = { exists: fs.existsSync(firstPath), sha: sha(firstPath), ...snap(firstPath) };
    out.stat = auditlogStats();
    out.files = fs.readdirSync(diagDir).sort();
  } else if (MODE === 'clean') {
    // 等价边界：无 stray（先可写、后置为目录造一次失败，使诊断面真落盘）
    fs.writeFileSync(mainPath, 'x\\n');
    const res = mountAuditLog(ctx, {
      config: { capabilities: { auditlog: { sinkDir: SINK_DIR, keepDays: '14', ...CFG } } },
      env: ENV, home: process.env.HOME, warn: (m) => warns.push(m),
    });
    out.mounted = res.mounted;
    fs.rmSync(mainPath);
    fs.mkdirSync(mainPath, { recursive: true });
    exportMessage({ sn: 1, ts: Date.now(), type: 'warn', level: 1, name: 'sinkfid', args: ['boom'] });
    out.warns = warns;
    out.stat = auditlogStats();
    out.diagStrays = read(mainDiag)?.strays;
  } else if (MODE === 'stray-prune' || MODE === 'stray-prune-optin') {
    seedStrays(true);
    out.prune = pruneByTotal(SINK_DIR, MAXTOTAL, { pruneStray: MODE === 'stray-prune-optin' });
    out.files = fs.readdirSync(SINK_DIR).sort();
    out.exists = {
      segment: fs.existsSync(mainPath),
      auditStray: fs.existsSync(path.join(SINK_DIR, 'audit-' + DAY + '.jsonl.bak')),
      otherStray: fs.existsSync(path.join(SINK_DIR, 'user-backup.dat')),
    };
  } else if (MODE === 'stray-mount' || MODE === 'stray-mount-optin') {
    seedStrays(true);
    const res = mountAuditLog(ctx, {
      config: { capabilities: { auditlog: { sinkDir: SINK_DIR, keepDays: '14', maxTotalBytes: String(MAXTOTAL) } } },
      env: ENV, home: process.env.HOME, warn: (m) => warns.push(m),
    });
    out.mounted = res.mounted;
    out.warns = warns;
    out.stat = auditlogStats();
    out.files = fs.readdirSync(SINK_DIR).sort();
    out.exists = {
      segment: fs.existsSync(mainPath),
      auditStray: fs.existsSync(path.join(SINK_DIR, 'audit-' + DAY + '.jsonl.bak')),
      otherStray: fs.existsSync(path.join(SINK_DIR, 'user-backup.dat')),
    };
  } else if (MODE === 'oversize') {
    // ③ 第二面（Q-4 optional）：sink **可写**、但行超 maxFileBytes ⇒ 失败面从 append 换到 oversize line，
    //   此时 sinkErrorRecords 应在探活点变成 MAX_SINK_ERROR_RECORDS + 1（钉 sink.js 的 attempts%1000 守卫）。
    const res = mountAuditLog(ctx, {
      config: { capabilities: { auditlog: { sinkDir: SINK_DIR, keepDays: '14', maxFileBytes: '1024' } } },
      env: ENV, home: process.env.HOME, warn: (m) => warns.push(m),
    });
    out.mounted = res.mounted;
    for (let i = 1; i <= 1100; i += 1) {
      exportMessage({ sn: i, ts: Date.now(), type: 'info', level: 2, name: 'sinkfid',
        args: ['row-' + i + ':' + 'Y'.repeat(2000)] });
    }
    out.stat = auditlogStats();
  } else {
    throw new Error('unknown mode: ' + MODE);
  }
  out.ok = true;
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
 * 起子进程跑一个场景（sbink 单实例 ⇒ 每场景一进程）。
 * @param {{mode: string, sinkDir: string, tag: string, seed?: boolean, cfg?: object,
 *          env?: object, maxTotal?: number}} spec
 * @returns {{status: number, stdout: string, stderr: string, result: object}}
 */
function runProbe({ mode, sinkDir, tag, seed = false, cfg = {}, env = {}, maxTotal = 0 }) {
  const root = freshRootTracked(tag);
  const home = path.join(root, 'user');
  const dshHome = path.join(root, 'dsh-home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dshHome, { recursive: true });
  const childEnv = {
    ...process.env,
    USERPROFILE: home,                        // 隔离①②：不触达真实用户目录
    HOME: home,
    DSH_HOME: dshHome,
    PUNKY_SF_SINK: SINK_JS,
    PUNKY_SF_MODE: mode,
    PUNKY_SF_SINK_DIR: sinkDir,
    PUNKY_SF_SEED: seed ? '1' : '0',
    PUNKY_SF_CONFIGJSON: JSON.stringify(cfg),
    PUNKY_SF_ENVJSON: JSON.stringify(env),
    PUNKY_SF_MAXTOTAL: String(maxTotal),
  };
  // 防主进程环境污染：这三个 env 会覆盖探测体显式传入的 sinkDir / 开关语义
  for (const k of Object.keys(childEnv)) {
    if (/^PUNKY_AUDITLOG/.test(k) || k === 'PUNKY_LOGGER_STDOUT') delete childEnv[k];
  }
  const r = spawnSync(process.execPath, [...hostDepFallbackImportArgs(), probeFile()], {
    env: childEnv,
    encoding: 'utf8',
    timeout: 180000,
  });
  assert.equal(r.error, undefined, '子进程未抛启动错误（' + String(r.error && r.error.message) + '）');
  const stdout = r.stdout ?? '';
  const idx = stdout.lastIndexOf(MARKER);
  assert.ok(idx >= 0, '探测体必须输出结果标记（status=' + r.status + '；stdout 尾部: '
    + stdout.slice(-500) + '；stderr: ' + String(r.stderr).slice(-500) + '）');
  const result = JSON.parse(stdout.slice(idx + MARKER.length).split('\n')[0]);
  assert.equal(r.status, 0, '子进程正常退出（mode=' + mode + '；stderr: ' + String(r.stderr).slice(-400) + '）');
  assert.equal(result.ok, true, '探测体未报错（mode=' + mode + '；error: ' + JSON.stringify(result.error) + '）');
  return { status: r.status, stdout, stderr: r.stderr ?? '', result };
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// C-1（D-16-①）首失败快照与主快照**共存**，且首失败不可变
// ══════════════════════════════════════════════════════════════════════════════════════════

test('C-1 首失败后连续 3 次 flush ⇒ 两份快照共存、first-failure 的 sha256 逐字不变、主快照取最后一次 note', () => {
  const sinkDir = path.join(freshRootTracked('c1'), 'sink');
  const r = runProbe({ mode: 'first-failure', sinkDir, tag: 'c1', seed: true });
  // 反向断言（修前会红）：修前诊断目录只有 sink-diagnostics.json（首失败现场被覆盖）
  assert.deepEqual(r.result.files, ['sink-diagnostics.first-failure.json', 'sink-diagnostics.json'],
    '① 首失败快照与主快照**共存**（实际目录: ' + JSON.stringify(r.result.files) + '）');
  assert.equal(r.result.firstAtFail.exists, true, '② 首失败即落 first-failure 快照');
  assert.equal(r.result.firstAtFail.note, 'first-failure', '② 首失败快照的 note 语义不变（实际: '
    + JSON.stringify(r.result.firstAtFail) + '）');
  // 主快照语义**未被改动**：首失败时刻主快照的 note 仍是 first-failure（既有断言口径）
  assert.equal(r.result.mainAtFail.note, 'first-failure', '主快照语义不动：首失败时刻 note=first-failure（实际: '
    + JSON.stringify(r.result.mainAtFail) + '）');

  // 三次 flush（含 process-exit 语义）后：首失败快照 sha 恒等、主快照 note 跟最后一次
  const steps = r.result.steps;
  assert.deepEqual(steps.map((s) => s.label), ['manual', 'process-exit', 'manual'], '三次 flush 标签');
  assert.deepEqual(steps.map((s) => s.mainNote), ['manual', 'process-exit', 'manual'],
    '③ 主快照 note 逐次跟随 flush（实际: ' + JSON.stringify(steps.map((s) => s.mainNote)) + '）');
  const shas = new Set(steps.map((s) => s.firstSha));
  assert.equal(shas.size, 1, '④ 首失败快照 sha256 三次 flush 后**逐字不变**（实际: ' + JSON.stringify([...shas]) + '）');
  assert.equal(steps[0].firstSha, r.result.firstAtFail.sha, '④ 与首失败时刻同一份');
  assert.equal(r.result.firstAfter.note, 'first-failure', '④ note 仍为 first-failure（实际: '
    + JSON.stringify(r.result.firstAfter) + '）');
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// C-2（D-16-①）跨进程：首失败快照取**最早**那次
// ══════════════════════════════════════════════════════════════════════════════════════════

test('C-2 跨进程：子进程再造一次首失败 ⇒ first-failure 仍是父进程那次（pid/ts 未变、子进程不报错）', () => {
  const sinkDir = path.join(freshRootTracked('c2'), 'sink');
  const first = runProbe({ mode: 'first-failure', sinkDir, tag: 'c2a', seed: true });
  const firstSnap = first.result.firstAfter;
  assert.equal(firstSnap.note, 'first-failure', '父进程已留档首失败（实际: ' + JSON.stringify(firstSnap) + '）');

  // 第二进程：同一 sinkDir，不再 seed（主卷已是目录），再造一次首失败
  const second = runProbe({ mode: 'first-failure', sinkDir, tag: 'c2b', seed: false });
  const secondSeen = second.result.firstAtFail;
  assert.equal(secondSeen.exists, true, '② 子进程读到既有 first-failure 快照（不报错 = EEXIST 被吞）');
  assert.equal(secondSeen.note, 'first-failure', '② note 仍为 first-failure');
  assert.notEqual(second.result.pid, first.result.pid, '前置：两次确为不同进程（' + first.result.pid + ' vs '
    + second.result.pid + '）');
  assert.equal(secondSeen.sha, firstSnap.sha, '② 子进程未见写入：sha256 与父进程那次逐字相同');
  assert.equal(secondSeen.pid, firstSnap.pid, '② pid 仍是**最早**那次（实际: ' + secondSeen.pid
    + '，本条进程: ' + second.result.pid + '）');
  assert.equal(secondSeen.ts, firstSnap.ts, '② ts 仍是**最早**那次（实际: ' + secondSeen.ts + '）');
  // 子进程自己的首失败仍写入主快照（主快照语义 = 最新）——证明「保留最早」不是靠不写
  assert.equal(second.result.mainAtFail.note, 'first-failure', '子进程主快照照常写（note=first-failure）');
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// C-3（D-16-②）默认档：stray **计入总量**、默认**不删**、挂载期 warn 恰 1 条、诊断面有 strays
// ══════════════════════════════════════════════════════════════════════════════════════════

test('C-3 默认档：total 含 stray（86016）、stray 一个不删、挂载期 warn 恰 1 条、诊断面含 strays', () => {
  // ① 直接读 pruneByTotal（判定所依据的计入口径）
  const sinkDir = path.join(freshRootTracked('c3'), 'sink');
  const r = runProbe({ mode: 'stray-prune', sinkDir, tag: 'c3', maxTotal: Number(DEFAULT_MAX_TOTAL) });
  const prune = r.result.prune;
  // 反向断言（修前会红）：修前 total 只算分卷 = 4096，且返回体没有 strays 字段
  assert.equal(prune.total, TOTAL_WITH_STRAY, '① total = 分卷 + stray = 86016（修前只有 4096；实际: '
    + prune.total + '）');
  assert.deepEqual(prune.strays, {
    count: 2, bytes: STRAY_TOTAL, names: [STRAY_AUDIT, STRAY_OTHER], pruneOptIn: false,
  }, '① strays 读数（count/bytes/names/pruneOptIn）');
  // 默认档只删分卷、stray 一个不删 —— 这是「不自动删用户备份」的可执行判据
  assert.equal(prune.removed, 1, '只删 1 个（4KiB 分卷；stray 不在可删集）（实际: ' + prune.removed + '）');
  assert.equal(prune.remaining, STRAY_TOTAL, 'remaining = 只剩 stray 的 81920（实际: ' + prune.remaining + '）');
  assert.deepEqual(r.result.exists, { segment: false, auditStray: true, otherStray: true },
    '① 分卷被删、两个 stray 均在（实际: ' + JSON.stringify(r.result.exists) + '）');
  assert.deepEqual(r.result.files, [STRAY_AUDIT, STRAY_OTHER], '① 目录里只剩 stray（实际: '
    + JSON.stringify(r.result.files) + '）');

  // ② 挂载面：warn 恰 1 条（含 stray 数 / 字节 / opt-in 提示）+ 诊断面字段
  const sinkDir2 = path.join(freshRootTracked('c3m'), 'sink');
  const m = runProbe({ mode: 'stray-mount', sinkDir: sinkDir2, tag: 'c3m', maxTotal: Number(DEFAULT_MAX_TOTAL) });
  assert.equal(m.result.mounted, true, '挂载成功');
  assert.equal(m.result.warns.length, 1, '② 挂载期 warn **恰 1 条**（实际 ' + m.result.warns.length + ' 条: '
    + JSON.stringify(m.result.warns) + '）');
  const w = m.result.warns[0];
  assert.ok(w.includes('2 个') && w.includes(String(STRAY_TOTAL)), '② warn 文案含 stray 数与字节（实际: ' + w + '）');
  assert.ok(w.includes('默认不删除'), '② warn 文案含「默认不删」+ opt-in 提示（实际: ' + w + '）');
  assert.deepEqual(m.result.stat.strays, {
    count: 2, bytes: STRAY_TOTAL, names: [STRAY_AUDIT, STRAY_OTHER], pruneOptIn: false,
  }, '② 诊断面 strays 字段（auditlogStats 投影）');
  // ② 不走 stderr：MAX_STDERR_NOTICES=2 是硬契约（AC-3 断言「恰 2 行」），stray 告警不得占额度
  assert.equal(m.stderr, '', '② stray 告警**不走 stderr**（实际 stderr: ' + JSON.stringify(m.stderr) + '）');
  assert.equal(m.result.stat.stderrNotices, 0, '② stderrNotices 未被占用（实际: ' + m.result.stat.stderrNotices + '）');
  // ② 诊断面（快照文件）同样带 strays —— 见 C-1 的挂载面（stray 数在快照里的形态）
  assert.deepEqual(r.result.prune.strays.pruneOptIn, false, '② 默认档 pruneOptIn=false');
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// C-4（D-16-②）opt-in：只删 `audit-` 前缀 stray，非前缀文件留存，总量降到 ≤ 上限
// ══════════════════════════════════════════════════════════════════════════════════════════

test('C-4 opt-in(PUNKY_AUDITLOG_PRUNE_STRAY=1)：删 audit- 前缀 stray、留用户备份、总量 ≤ 上限', () => {
  // ① 直接调 pruneByTotal（opt-in 通道）
  const sinkDir = path.join(freshRootTracked('c4'), 'sink');
  const r = runProbe({ mode: 'stray-prune-optin', sinkDir, tag: 'c4', maxTotal: Number(OPTIN_MAX_TOTAL) });
  const prune = r.result.prune;
  assert.equal(prune.strays.pruneOptIn, true, '① 读数标记 pruneOptIn=true');
  assert.equal(prune.removed, 2, '① 删 2 个（分卷 + audit- 前缀 stray）（实际: ' + prune.removed + '）');
  assert.equal(r.result.exists.auditStray, false, '① audit- 前缀 stray 被删');
  assert.equal(r.result.exists.otherStray, true, '① **非** audit- 前缀的用户备份仍在（不得自动删）');
  assert.ok(prune.remaining <= Number(OPTIN_MAX_TOTAL), '① 总量降到 ≤ maxTotalBytes（实际: '
    + prune.remaining + ' ≤ ' + OPTIN_MAX_TOTAL + '）');

  // ② env 通道（双通道的另一面）：挂载面即按 opt-in 清理，且 warn 文案改为「可被清理」
  const sinkDir2 = path.join(freshRootTracked('c4m'), 'sink');
  const m = runProbe({
    mode: 'stray-mount-optin', sinkDir: sinkDir2, tag: 'c4m', maxTotal: Number(OPTIN_MAX_TOTAL),
    env: { PUNKY_AUDITLOG_PRUNE_STRAY: '1' },
  });
  assert.equal(m.result.mounted, true, '② 挂载成功');
  // 挂载面会建 diagnostics 子目录（诊断面在 sink 根之下），比对时排除它
  assert.deepEqual(m.result.files.filter((f) => f !== 'diagnostics'), [STRAY_OTHER],
    '② 挂载后 sink 根只剩用户备份（实际: ' + JSON.stringify(m.result.files) + '）');
  assert.equal(m.result.stat.strays.pruneOptIn, true, '② 正常流里 pruneOptIn 已按 env 生效（实际: '
    + JSON.stringify(m.result.stat.strays) + '）');
  assert.equal(m.result.warns.length, 1, '② 挂载期仍恰 1 条 warn（实际: ' + m.result.warns.length + '）');
  assert.ok(m.result.warns[0].includes('pruneStray=on'), '② warn 文案标注 opt-in 生效（实际: ' + m.result.warns[0] + '）');
  assert.equal(m.stderr, '', '② opt-in 面同样零 stderr（实际: ' + JSON.stringify(m.stderr) + '）');
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// C-5（D-16-②）等价边界：无 stray ⇒ 零新增输出、strays 全零
// ══════════════════════════════════════════════════════════════════════════════════════════

test('C-5 无 stray ⇒ 挂载期 warn 0 条、strays 读数全零（既有行为等价）', () => {
  const sinkDir = path.join(freshRootTracked('c5'), 'sink');
  const r = runProbe({ mode: 'clean', sinkDir, tag: 'c5' });
  assert.equal(r.result.mounted, true, '挂载成功');
  assert.deepEqual(r.result.warns, [], '② 无 stray ⇒ warn 0 条（实际: ' + JSON.stringify(r.result.warns) + '）');
  assert.deepEqual(r.result.stat.strays, { count: 0, bytes: 0, names: [], pruneOptIn: false },
    '② strays 读数全零（实际: ' + JSON.stringify(r.result.stat.strays) + '）');
  assert.deepEqual(r.result.diagStrays, { count: 0, bytes: 0, names: [], pruneOptIn: false },
    '② 诊断面快照同样全零（实际: ' + JSON.stringify(r.result.diagStrays) + '）');
  assert.equal(r.stderr === '' || r.stderr.includes('[punky-auditlog] sink append failed'), true,
    '② stray 面未新增任何 stderr 行（只允许既有首失败行；实际: ' + JSON.stringify(r.stderr) + '）');
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// C-6 第二面（Q-4 · optional）：oversize line 失败面钉住探活点的第 4 条 sink-error
//
// 说明：本面是 D-16-③ 的**强化面**（primary 面 = stderr AC-2/AC-3 的精确四数 + 守恒式）。
//   期望值 `sinkErrorRecords=4` 由**本 lane 实测**得到（`exec/c3-sinkfid/probe/probe-measure.mjs`
//   的 `oversize` 场景），不是从规格抄写；它钉的是「`sinkErrorRecords >= MAX_SINK_ERROR_RECORDS` 时
//   仍留 `attempts % BREAKER_PROBE_INTERVAL === 0` 例外」这条守卫。若 sink 侧上限/探活常量语义有意变更，
//   本断言随之更新（属 followup，不是行为回归）。
// ══════════════════════════════════════════════════════════════════════════════════════════

test('C-6（optional 第二面）oversize line + 探活点 ⇒ sinkErrorRecords=4、四数守恒', () => {
  const sinkDir = path.join(freshRootTracked('c6'), 'sink');
  const r = runProbe({ mode: 'oversize', sinkDir, tag: 'c6' });
  const s = r.result.stat;
  assert.equal(s.attempts, 1100, 'attempts === 1100（实际: ' + s.attempts + '）');
  assert.equal(s.failures, 4, 'failures === 4（3 次首失败 + 探活点 1 次；实际: ' + s.failures + '）');
  assert.equal(s.skippedByBreaker, 1096, 'skippedByBreaker === 1096（实际: ' + s.skippedByBreaker + '）');
  assert.equal(s.writes, 0, 'writes === 0（全部落在 oversize 失败面；实际: ' + s.writes + '）');
  assert.equal(s.sinkErrorRecords, 4, 'sinkErrorRecords === 4（= MAX_SINK_ERROR_RECORDS 3 + 探活点 1 条；'
    + '本 lane 实测值；实际: ' + s.sinkErrorRecords + '）');
  assert.equal(s.attempts, s.failures + s.skippedByBreaker + s.writes, '守恒式 S3：'
    + 'attempts === failures + skippedByBreaker + writes（实际: ' + s.attempts + ' vs '
    + (s.failures + s.skippedByBreaker + s.writes) + '）');
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// schema 一致性（Q-1）：新键 `pruneStray` 走 config 键 + env 双通道，默认值单点 = AUDITLOG_DEFAULTS
// ══════════════════════════════════════════════════════════════════════════════════════════

test('Q-1 新键 pruneStray：默认值单点在 AUDITLOG_DEFAULTS、config/env 双通道可读、schema 面三件成对', () => {
  // ① 默认值单点（config.js 是唯一来源；schema.ts 只登记键名，不复制数值）
  assert.equal(AUDITLOG_DEFAULTS.pruneStray, false, '默认关（opt-in 语义：不自动删用户备份）');
  // ② schema 面的可配键清单与 config.js 逐一相等（新增键漏登记即红）
  assert.deepEqual([...AUDITLOG_CONFIG_KEYS].sort(), Object.keys(AUDITLOG_DEFAULTS).sort(),
    'lib/schema.ts 的 AUDITLOG_CONFIG_KEYS 必须与 Object.keys(AUDITLOG_DEFAULTS) 逐条相等（实际 schema: '
    + JSON.stringify(AUDITLOG_CONFIG_KEYS) + ' / config: ' + JSON.stringify(Object.keys(AUDITLOG_DEFAULTS)) + '）');
  assert.ok(AUDITLOG_CONFIG_KEYS.includes('pruneStray'), '新键已登记进 schema 面');

  // ③ config 键通道
  const viaConfig = resolveAuditLogConfig({ capabilities: { auditlog: { pruneStray: true } } }, {});
  assert.equal(viaConfig.pruneStray, true, 'config 键 capabilities.auditlog.pruneStray=true 可被读出');
  const viaConfigFalse = resolveAuditLogConfig({ capabilities: { auditlog: { pruneStray: false } } }, {});
  assert.equal(viaConfigFalse.pruneStray, false, 'config 键 false 可被读出');
  // ④ env 通道（三态：真值词开 / 假值词关 / 未识别不干预）+ env 覆盖 config
  for (const truthy of ['1', 'true', 'on', 'yes', 'TRUE']) {
    assert.equal(resolveAuditLogConfig({}, { PUNKY_AUDITLOG_PRUNE_STRAY: truthy }).pruneStray, true,
      'env PUNKY_AUDITLOG_PRUNE_STRAY=' + truthy + ' ⇒ true');
  }
  for (const falsy of ['0', 'false', 'off', 'no']) {
    assert.equal(resolveAuditLogConfig({ capabilities: { auditlog: { pruneStray: true } } },
      { PUNKY_AUDITLOG_PRUNE_STRAY: falsy }).pruneStray, false,
      'env=' + falsy + ' 覆盖 config=true ⇒ false');
  }
  assert.equal(resolveAuditLogConfig({ capabilities: { auditlog: { pruneStray: true } } },
    { PUNKY_AUDITLOG_PRUNE_STRAY: 'maybe' }).pruneStray, true, '未识别值不干预 ⇒ config 生效');
  // ⑤ 缺省（不传）⇒ 默认值单点
  assert.equal(resolveAuditLogConfig({}, {}).pruneStray, AUDITLOG_DEFAULTS.pruneStray, '缺省 ⇒ AUDITLOG_DEFAULTS');
  // ⑥ 非法 config 值 ⇒ 恰 1 条 warn + 回落默认
  const warns = [];
  const bad = resolveAuditLogConfig({ capabilities: { auditlog: { pruneStray: 'abc' } } }, {},
    { warn: (m) => warns.push(m) });
  assert.equal(bad.pruneStray, AUDITLOG_DEFAULTS.pruneStray, '非法值回落默认');
  assert.equal(warns.length, 1, '恰 1 条 warn（实际: ' + JSON.stringify(warns) + '）');
  assert.ok(warns[0].includes('pruneStray'), 'warn 指向新键（实际: ' + warns[0] + '）');

  // ⑦ build 三件成对：`.ts` 源与 `.js`/`.d.ts` 产物都含新键（漏 build 即红）
  for (const f of ['schema.ts', 'schema.js', 'schema.d.ts']) {
    const src = fs.readFileSync(path.join(PKG, 'lib', f), 'utf8');
    assert.ok(src.includes('pruneStray'), 'lib/' + f + ' 含 pruneStray（三件成对）');
  }
});
