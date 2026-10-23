#!/usr/bin/env node
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

// 读数一致性（readings consistency）：把「默认运行器口径」与「guard 口径」的差额
// 从「噪声」改写成**可复算的机检恒等式**。
//
// 存在理由（缺陷 D-3③）：`node --test`（默认 runner）的用例总数与 `test-evidence-guard` 的
//   用例总数长期差一个常数，台账把它当噪声解释。实测证明它**精确可归因**：差额 = 被默认 runner
//   发现、但不在 guard 目标集里的文件，各自被 runner 计了 1 点。写成恒等式后，**任一侧漂移都转红**：
//     · 新增一个带真用例的非 `*.test.js` 文件 ⇒ guard 漏收 ⇒ 差额变大 ⇒ C1 红（本件最有价值的一侧）
//     · guard 目标集被缩小 / runner 发现规则变化 ⇒ 同样转红，而不是静默偏移
//
// 唯一判据（S4 / C1）：
//   Σrunner === Σguard + Σ_{f ∈ D\A} count(f)
//
//   三个词先定死（避免各写一套）：
//   A = guard 的目标集 = `<repo>/test` 下 `*.test.js`（非递归）。**运行期枚举**，
//       复用 guard 的 `listTargetFiles`（同一实现，不另写一份镜像）。
//   D = 默认 runner 的发现集里**可物理观测**的那部分：聚合 TAP 里以**仓内真实代码文件路径**为名的
//       顶层 subtest。**不靠镜像 glob 推导** —— 镜像会与 Node 实现漂移，而漂移恰是本缺陷的成因。
//       物理判据：名字含路径分隔符 + 代码扩展名 + `path.resolve` 后**盘上真有这个文件**。
//   N = |D\A|，**运行期算**。本件源码刻意**不含任何数量常量**（连期望差额也不写）：
//       写死必致「加/删 helper ⇒ 假绿或假红」。
//
// 通道纪律（与 guard 同源）：两个口径都只读**结构化的 TAP destination 文件**，子进程 stdout 一律
//   `stdio: 'ignore'`（不采集，而不是「采集了但不看」）。退出码**直取** `child.on('close', code)`，
//   **不经 shell、不经管道**（管道会把左段的非零码吞成末段的码 ⇒ `exit 1` 被读成 0）。
//
// 退出码：0 = 全通过；1 = 有红（C1–C4 任一不成立）；2 = 用法错 / 前置失败（未做任何测量）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildRunnerArgs,
  buildRunnerSpawnOptions,
  classifyOutcome,
  listTargetFiles,
  parseTapChannel,
  runGuard,
} from './test-evidence-guard.mjs';

const RC_TAG = '[readings-consistency]';
const PRELOAD_REL = 'test/helpers/isolated-home.preload.mjs';
const TARGET_DIR_REL = 'test';
const TEST_FILE_SUFFIX = '.test.js';
const TAP_SUFFIX = '.tap';
/** 默认 runner 会当成「代码文件」的扩展名（`.js` / `.mjs` / `.cjs`）。 */
const CODE_EXT_RE = /\.(?:js|mjs|cjs)$/i;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 聚合通道解析 ─────────────────────────────────────────────────────────

/**
 * TAP 会把名字里的反斜杠转义成两个反斜杠（Windows 路径名 subtest ⇒ `test\\helpers\\x.mjs`）。
 * 本函数只还原反斜杠：本件判据只吃路径名，TAP 对 `#` 等字符的转义不进入该判据。
 * @param {string} name
 */
export function unescapeTapName(name) {
  return String(name ?? '').replace(/\\\\/g, '\\');
}

/**
 * 解析一次**聚合**运行的 TAP（复用 guard 的 `parseTapChannel`：同一实现、同一词法）。
 * @param {string} text
 */
export function parseAggregate(text) {
  const parsed = parseTapChannel(text);
  return {
    summary: parsed.summary,
    tests: parsed.summary.tests,
    topSubtests: parsed.topSubtests,
    pathNames: parsed.topSubtests.map(unescapeTapName),
  };
}

/**
 * 把一个顶层 subtest 名解析成**仓内真实代码文件**；不是则 `null`。
 *
 * 判据是物理的（三条全中才算）：
 *   ① 名里含路径分隔符（排除普通用例名）；
 *   ② 扩展名是默认 runner 认的代码扩展名；
 *   ③ `path.resolve(repoRoot, name)` 落在仓根之下、且**盘上真是常规文件**。
 * 第 ③ 条是「不靠镜像 glob」的落点：只认**实测存在**的文件，不认名字长得像。
 * @param {string} repoRoot
 * @param {string} name 已还原转义的 subtest 名
 * @returns {string|null} 绝对路径
 */
export function resolveRepoCodeFile(repoRoot, name) {
  const raw = String(name ?? '');
  if (!/[\\/]/.test(raw)) return null;
  if (!CODE_EXT_RE.test(raw)) return null;
  const abs = path.resolve(repoRoot, raw);
  const normalRoot = path.resolve(repoRoot).toLowerCase() + path.sep;
  if (!abs.toLowerCase().startsWith(normalRoot)) return null;
  try {
    if (!fs.statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  return abs;
}

/**
 * 由聚合 TAP 的路径名 subtest 得出**可观测发现集** `D`。
 * 只读通道产物，不扫目录、不跑 glob。
 * @param {object} input
 * @param {string[]} input.pathNames
 * @param {string} input.repoRoot
 */
export function deriveDiscovered({ pathNames = [], repoRoot }) {
  const files = [];
  const seen = new Set();
  const unnoted = [];
  for (const name of pathNames) {
    const abs = resolveRepoCodeFile(repoRoot, name);
    if (!abs) {
      // 名里带分隔符却不是仓内代码文件（如中文用例名内的 `/`）⇒ 不是发现面证据，但留痕可见。
      if (/[\\/]/.test(name)) unnoted.push(name);
      continue;
    }
    const key = abs.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(abs);
  }
  return { files, unnoted };
}

// ── 恒等式裁定（C1–C5）──────────────────────────────────────────────────

/**
 * 唯一裁定函数：`--cross-check` 与 `--calibrate` 的**正控与反控**全部经此（单一实现）。
 *
 * @param {object} input
 * @param {number|null} input.runnerTests  Σrunner（聚合 TAP 的 `# tests`）
 * @param {number} input.guardTests        Σguard（guard 的 `totals.tests`）
 * @param {string[]} input.targetFiles     集合 A（绝对路径）
 * @param {object[]} input.extras          D\A，每项 `{file, count, outcome?, exitCode?}`
 * @param {string[]} [input.unnoted]       带分隔符但非仓内文件的 subtest 名（仅留痕）
 */
export function evaluateIdentity(input) {
  const {
    runnerTests = null,
    guardTests = 0,
    targetFiles = [],
    extras = [],
    unnoted = [],
  } = input ?? {};

  const sumExtras = extras.reduce((acc, item) => acc + (item.count ?? 0), 0);
  const expected = guardTests + sumExtras;
  const checks = [];

  // C1 算术：两侧必须相等；`runnerTests === null` 是「聚合通道没读到汇总行」⇒ 不可判 ⇒ 红。
  const c1Reasons = [];
  if (runnerTests === null || runnerTests === undefined) c1Reasons.push('聚合通道未读到 # tests 汇总行（不可判）');
  else if (runnerTests !== expected) {
    c1Reasons.push('Σrunner=' + runnerTests + ' ≠ Σguard+Σextras=' + guardTests + '+' + sumExtras + '=' + expected);
  }
  checks.push({
    id: 'C1',
    title: '算术：Σrunner === Σguard + Σ_{f∈D\\A} count(f)',
    ok: c1Reasons.length === 0,
    detail: c1Reasons.length === 0 ? 'Σrunner=' + runnerTests + ' === ' + expected : c1Reasons.join('；'),
  });

  // C2 成员性：D\A 里不得出现 `*.test.js` —— 出现即「guard 漏收了真测试文件」（本件最有价值的一侧）。
  const leaked = extras.filter((item) => path.basename(item.file).endsWith(TEST_FILE_SUFFIX));
  checks.push({
    id: 'C2',
    title: '成员性：∀ f∈D\\A，basename 不以 ' + TEST_FILE_SUFFIX + ' 结尾',
    ok: leaked.length === 0,
    detail:
      leaked.length === 0
        ? 'D\\A 无一以 ' + TEST_FILE_SUFFIX + ' 结尾'
        : 'guard 漏收真测试文件：' + leaked.map((item) => path.basename(item.file)).join(', '),
  });

  // C3 非空：三侧都非空，防「空跑假绿」；D\A 为空说明发现规则变了，必须重新校准而非自动放行。
  const c3Reasons = [];
  const dSize = targetFiles.length + extras.length;
  if (targetFiles.length === 0) c3Reasons.push('|A| = 0');
  if (dSize === 0) c3Reasons.push('|D| = 0');
  if (extras.length === 0) c3Reasons.push('|D\\A| = 0（发现规则可能已变：须重新校准，不得自动放行）');
  checks.push({
    id: 'C3',
    title: '非空：|A| > 0 且 |D| > 0 且 |D\\A| > 0',
    ok: c3Reasons.length === 0,
    detail: c3Reasons.length === 0 ? '|A|=' + targetFiles.length + ' |D|=' + dSize + ' |D\\A|=' + extras.length : c3Reasons.join('；'),
  });

  // C4 每个 extra 有完成事件：count >= 1（0 点的被发现文件本身就是信号）。
  const zeroCount = extras.filter((item) => (item.count ?? 0) < 1);
  checks.push({
    id: 'C4',
    title: '完成事件：每个 extra 有点数（count ≥ 1）',
    ok: zeroCount.length === 0,
    detail:
      zeroCount.length === 0
        ? '全部 extra count ≥ 1'
        : '零点数：' + zeroCount.map((item) => path.basename(item.file)).join(', '),
  });

  // C5 统一性：**仅观察、不判红**（Node 未来改变发现语义时不该假红）。
  const distinct = [...new Set(extras.map((item) => item.count ?? 0))].sort((a, b) => a - b);
  const observation = {
    id: 'C5',
    title: '统一性（仅观察）',
    ok: null,
    detail:
      distinct.length <= 1
        ? '所有 extra 的 count 恒为 ' + (distinct[0] ?? '（无 extra）') + '（≠ 1 也不判红）'
        : 'count 取值集合 = [' + distinct.join(', ') + ']（不判红：发现语义变化属观察面）',
  };

  const ok = checks.every((check) => check.ok !== false);
  return {
    ok,
    checks,
    observation,
    readings: {
      runnerTests,
      guardTests,
      sumExtras,
      expected,
      delta: runnerTests === null || runnerTests === undefined ? null : runnerTests - guardTests,
      aSize: targetFiles.length,
      dSize,
      n: extras.length,
      extras: extras.map((item) => ({
        file: item.file,
        count: item.count ?? 0,
        outcome: item.outcome ?? null,
        exitCode: item.exitCode ?? null,
      })),
      unnoted,
    },
  };
}

// ── 子进程（退出码直取、stdout 不采集）──────────────────────────────────

/**
 * 跑一个子进程并**直取退出码**。
 * 三条纪律写在这里（唯一 spawn 点）：① 不经 shell（无管道、无 `$?`）；② stdio 全 ignore
 * （判定侧连 stdout 字节都拿不到）；③ 退出码只来自 `close` 事件的 `code`。
 */
function spawnExitCode(command, args, cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, buildRunnerSpawnOptions(cwd, env));
    child.on('error', (error) => resolve({ code: null, spawnError: String(error?.message ?? error) }));
    child.on('close', (code) => resolve({ code, spawnError: null }));
  });
}

function buildAggregateArgs(destination, preload) {
  return [
    ...(preload ? ['--import', preload] : []),
    '--test',
    '--test-reporter=tap',
    '--test-reporter-destination=' + destination,
  ];
}

function preloadSpecifier(repoRoot) {
  const abs = path.join(repoRoot, PRELOAD_REL);
  // `--import` 收 ESM 说明符：Windows 盘符绝对路径不是合法说明符 ⇒ 一律转 file:// URL。
  return fs.existsSync(abs) ? pathToFileURL(abs).href : null;
}

/**
 * 一次**聚合**运行（默认 runner + 默认发现规则）：只读它落下的 destination 文件。
 * `cwd` 决定发现根（真实仓 = 仓根；校准夹具 = 夹具根）。
 */
async function runAggregate({ cwd, tapDir, preload, env }) {
  fs.mkdirSync(tapDir, { recursive: true });
  const destination = path.join(tapDir, 'aggregate' + TAP_SUFFIX);
  const started = Date.now();
  const result = await spawnExitCode(process.execPath, buildAggregateArgs(destination, preload), cwd, env);
  const text = fs.existsSync(destination) ? fs.readFileSync(destination, 'utf8') : '';
  return {
    exitCode: result.code,
    spawnError: result.spawnError,
    tapPath: destination,
    text,
    durationMs: Date.now() - started,
  };
}

/** 逐文件一次 spawn 实测点数（复用 guard 的 `buildRunnerArgs` + `parseTapChannel`：同一实现）。 */
async function measureOneFile(file, { cwd, destDir, preload, env }) {
  const destination = path.join(destDir, path.basename(file) + TAP_SUFFIX);
  const args = buildRunnerArgs(file, destination, preload);
  const result = await spawnExitCode(process.execPath, args, cwd, env);
  const text = fs.existsSync(destination) ? fs.readFileSync(destination, 'utf8') : '';
  const parsed = parseTapChannel(text);
  return {
    file,
    exitCode: result.code,
    spawnError: result.spawnError,
    count: parsed.summary.tests ?? 0,
    outcome: classifyOutcome(parsed),
  };
}

/** 有界并发池（只用于 extra 的逐文件测量；不引入新的串行化语义）。 */
async function measurePool(files, limit, measure) {
  const results = new Array(files.length);
  let cursor = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, files.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= files.length) return;
      results[index] = await measure(files[index]);
    }
  });
  await Promise.all(lanes);
  return results;
}

// ── --calibrate：先校公式本身（夹具 + 三条反控）──────────────────────────

/** 校准夹具的已知成分（**夹具的**期望值，非真实仓的数量）。 */
const CALIBRATION_FIXTURE = Object.freeze({
  dir: 'test',
  leafPoints: [
    ['alpha.test.js', 3],
    ['beta.test.js', 1],
  ],
  // 零用例、但命中默认发现规则（`test-*` 前缀）⇒ 被 runner 当作 1 条路径名用例。
  zeroTestProbe: 'test-gamma.mjs',
});

function writeCalibrationFixture(root) {
  const target = path.join(root, CALIBRATION_FIXTURE.dir);
  fs.mkdirSync(target, { recursive: true });
  for (const [name, points] of CALIBRATION_FIXTURE.leafPoints) {
    const body =
      'const { test } = require("node:test");\n' +
      Array.from({ length: points }, (_, i) => `test("${name}-case-${i + 1}", () => {});\n`).join('');
    fs.writeFileSync(path.join(target, name), body, 'utf8');
  }
  fs.writeFileSync(path.join(target, CALIBRATION_FIXTURE.zeroTestProbe), 'export default 1;\n', 'utf8');
  return { root, target };
}

/**
 * 校准：用**已知成分**的夹具先验「聚合 `# tests` 的语义」与「逐文件 count 的语义」的关系，
 * 再用同一裁定函数跑三条**反控**（把刚测到的读数人为改坏，必须转红）。
 *
 * 为什么必须校准：公式写错时的错误形态与「真实仓读数变了」完全相同 —— 不先钉住语义，
 *   `--cross-check` 的红绿就无法归因。
 */
export async function calibrate({ repoRoot, workRoot, env }) {
  const fixture = writeCalibrationFixture(path.join(workRoot, 'repo'));
  const tapDir = path.join(workRoot, 'tap');
  const destDir = path.join(workRoot, 'channel');
  fs.mkdirSync(destDir, { recursive: true });

  const aggregate = await runAggregate({ cwd: fixture.root, tapDir, preload: null, env });
  const parsed = parseAggregate(aggregate.text);
  const discovered = deriveDiscovered({ pathNames: parsed.pathNames, repoRoot: fixture.root });

  // 夹具侧 A：复用 guard 的枚举（同一实现）；Σ_a 用真实 guard 跑一次（同一实现）。
  const targetFiles = listTargetFiles(fixture.target);
  const guardLike = await runGuard({ root: repoRoot, dir: fixture.target, destDir, argv: [] });

  const aKeys = new Set(targetFiles.map((file) => file.toLowerCase()));
  const extraFiles = discovered.files.filter((file) => !aKeys.has(file.toLowerCase()));
  const extras = [];
  for (const file of extraFiles) {
    extras.push(await measureOneFile(file, { cwd: fixture.root, destDir, preload: null, env }));
  }

  const leafExpected = CALIBRATION_FIXTURE.leafPoints.reduce((acc, [, points]) => acc + points, 0);
  const controls = [];

  // 语义正控 ①：聚合 `# tests` = 叶子点数之和 + 零用例发现文件各 1 点（**不是**文件数）。
  const expectAggregate = leafExpected + extras.length;
  controls.push({
    id: 'K1',
    title: '聚合 # tests 的语义 = 叶子点数 + 零用例发现文件各 1 点',
    ok: parsed.tests === expectAggregate,
    detail: '实测 # tests=' + parsed.tests + '，夹具期望=' + expectAggregate + '（叶子 ' + leafExpected + ' + 发现文件 ' + extras.length + '）',
  });
  controls.push({
    id: 'K2',
    title: '逐文件 count 语义：零用例的被发现文件 count=1（不是 0）',
    ok: extras.length > 0 && extras.every((item) => item.count === 1),
    detail: 'extras=' + JSON.stringify(extras.map((item) => ({ name: path.basename(item.file), count: item.count, outcome: item.outcome }))),
  });
  controls.push({
    id: 'K3',
    title: '夹具侧 guard 口径只认 *.test.js（零用例探针不在 A 内）',
    ok: guardLike.aSize === targetFiles.length && guardLike.ok === true,
    detail: '|A|=' + guardLike.aSize + '，Σa=' + guardLike.totals.tests + '，ok=' + guardLike.ok,
  });

  const positive = evaluateIdentity({
    runnerTests: parsed.tests,
    guardTests: guardLike.totals.tests,
    targetFiles,
    extras,
    unnoted: discovered.unnoted,
  });

  // 反控 ①：Σrunner 人为 +1 ⇒ C1 必须红（验收 B-4-C1 的可达构造）。
  const reverseC1 = evaluateIdentity({
    runnerTests: (parsed.tests ?? 0) + 1,
    guardTests: guardLike.totals.tests,
    targetFiles,
    extras,
  });
  controls.push({
    id: 'R1',
    title: '反控 C1：Σrunner +1 ⇒ 必须红（且只红在 C1）',
    ok: reverseC1.ok === false && reverseC1.checks.find((c) => c.id === 'C1').ok === false,
    detail: reverseC1.checks.find((c) => c.id === 'C1').detail,
  });

  // 反控 ②：把一个 extra 改成 *.test.js 形态 ⇒ C2 必须红（「guard 漏收真测试文件」）。
  const reverseC2 = evaluateIdentity({
    runnerTests: parsed.tests,
    guardTests: guardLike.totals.tests,
    targetFiles,
    extras: extras.map((item, index) =>
      index === 0 ? { ...item, file: item.file + TEST_FILE_SUFFIX } : item,
    ),
  });
  controls.push({
    id: 'R2',
    title: '反控 C2：extra 名以 ' + TEST_FILE_SUFFIX + ' 结尾 ⇒ 必须红（点出 guard 漏收）',
    ok: reverseC2.ok === false && reverseC2.checks.find((c) => c.id === 'C2').ok === false,
    detail: reverseC2.checks.find((c) => c.id === 'C2').detail,
  });

  // 反控 ③：目标集清空 ⇒ C3 必须红（防空跑假绿）。
  const reverseC3 = evaluateIdentity({ runnerTests: 0, guardTests: 0, targetFiles: [], extras: [] });
  controls.push({
    id: 'R3',
    title: '反控 C3：目标集清空 ⇒ 必须红（empty-target-set）',
    ok: reverseC3.ok === false && reverseC3.checks.find((c) => c.id === 'C3').ok === false,
    detail: reverseC3.checks.find((c) => c.id === 'C3').detail,
  });

  const ok = controls.every((control) => control.ok) && positive.ok;
  return {
    mode: 'calibrate',
    ok,
    controls,
    positive,
    readings: {
      fixtureRoot: fixture.root,
      aggregateExitCode: aggregate.exitCode,
      aggregateTests: parsed.tests,
      guardLikeTests: guardLike.totals.tests,
      discovered: discovered.files.map((file) => path.relative(fixture.root, file)),
      durationMs: aggregate.durationMs,
    },
  };
}

// ── --cross-check：真实仓的两口径恒等式 ──────────────────────────────────

export async function crossCheck({ repoRoot, workRoot, env, concurrency = 4 }) {
  const preload = preloadSpecifier(repoRoot);
  if (!preload) return { mode: 'cross-check', fatal: '缺隔离 preload：' + path.join(repoRoot, PRELOAD_REL) };

  const tapDir = path.join(workRoot, 'tap');
  const destDir = path.join(workRoot, 'channel');
  fs.mkdirSync(destDir, { recursive: true });

  // ① Σrunner ← 一次聚合运行（实测；不假设它数叶子还是数文件 —— 语义由 --calibrate 钉住）。
  const aggregate = await runAggregate({ cwd: repoRoot, tapDir, preload, env });
  const parsed = parseAggregate(aggregate.text);

  // ② D ← 同一聚合 TAP 的路径名 subtest（物理判据：盘上真有该文件）。
  const discovered = deriveDiscovered({ pathNames: parsed.pathNames, repoRoot });

  // ③ Σguard ← 直接 runGuard（import，不经 CLI；与 CLI 同一实现）。
  const guard = await runGuard({ root: repoRoot, argv: [], env });
  const targetFiles = listTargetFiles(path.join(repoRoot, TARGET_DIR_REL));

  // ④ count(f) ← 对每个 extra 逐文件一次 spawn 实测。
  const aKeys = new Set(targetFiles.map((file) => file.toLowerCase()));
  const extraFiles = discovered.files.filter((file) => !aKeys.has(file.toLowerCase()));
  const extras = await measurePool(extraFiles, concurrency, (file) =>
    measureOneFile(file, { cwd: repoRoot, destDir, preload, env }),
  );

  const verdict = evaluateIdentity({
    runnerTests: parsed.tests,
    guardTests: guard.totals.tests,
    targetFiles,
    extras,
    unnoted: discovered.unnoted,
  });

  return {
    mode: 'cross-check',
    ok: verdict.ok,
    checks: verdict.checks,
    observation: verdict.observation,
    readings: {
      repoRoot,
      aggregateExitCode: aggregate.exitCode,
      aggregateDurationMs: aggregate.durationMs,
      guardOk: guard.ok,
      guardCancelled: guard.totals.cancelled,
      ...verdict.readings,
    },
  };
}

// ── CLI ────────────────────────────────────────────────────────────────

const USAGE = `用法：
  node scripts/readings-consistency.mjs --calibrate      用临时夹具先校公式本身（含三条反控；秒级）
  node scripts/readings-consistency.mjs --cross-check    真实仓两口径恒等式 C1–C5（分钟级；不进 npm test）
  可选： --json            机读输出（与人工输出同构）
         --repo <路径>     目标仓根（缺省 = 本脚本所在仓）
         --keep-work      保留临时工作目录并打印路径（取证用）

恒等式：Σrunner === Σguard + Σ_{f∈D\\A} count(f)
  A = <repo>/test 下 *.test.js（运行期枚举，复用 guard 的 listTargetFiles）
  D = 聚合 TAP 里以仓内真实代码文件路径为名的顶层 subtest（实测，不靠镜像 glob）
  N = |D\\A| 运行期算，源码无数量常量

退出码：0 = 全通过；1 = 有红（C1–C4 任一不成立）；2 = 用法错 / 前置失败（未做任何测量）
`;

export function parseCliArgs(argv) {
  const options = { calibrate: false, crossCheck: false, json: false, keepWork: false, repoRoot: null, error: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    if (arg === '--calibrate') options.calibrate = true;
    else if (arg === '--cross-check') options.crossCheck = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--keep-work') options.keepWork = true;
    else if (arg === '--repo') {
      const value = argv[i + 1];
      if (value === undefined || String(value).startsWith('-')) {
        options.error = '--repo 缺少路径';
        return options;
      }
      options.repoRoot = value;
      i += 1;
    } else if (arg.startsWith('--repo=')) options.repoRoot = arg.slice('--repo='.length);
    else {
      options.error = '未知参数：' + arg;
      return options;
    }
  }
  if (!options.error && options.calibrate === options.crossCheck) {
    options.error = options.calibrate ? '--calibrate 与 --cross-check 只能选一个' : '必须给出 --calibrate 或 --cross-check';
  }
  return options;
}

function renderReport(result) {
  const lines = [];
  if (result.fatal) {
    lines.push(RC_TAG + ' 前置失败：' + result.fatal);
    return lines.join('\n');
  }
  lines.push(RC_TAG + ' 模式 = ' + result.mode);
  if (result.mode === 'calibrate') {
    const r = result.readings;
    lines.push(RC_TAG + ' 夹具根 = ' + r.fixtureRoot);
    lines.push(RC_TAG + ' 聚合 # tests = ' + r.aggregateTests + '（聚合跑 exit=' + r.aggregateExitCode + '，' + r.durationMs + 'ms）');
    lines.push(RC_TAG + ' 夹具侧 Σguard = ' + r.guardLikeTests);
    lines.push(RC_TAG + ' 路径名 subtest（=发现面）= ' + JSON.stringify(r.discovered));
    for (const control of result.controls) {
      lines.push(RC_TAG + '   ' + (control.ok ? 'PASS' : 'FAIL') + ' ' + control.id + ' ' + control.title + ' ⇒ ' + control.detail);
    }
  }
  const readings = result.readings ?? {};
  if (result.mode === 'cross-check') {
    lines.push(RC_TAG + ' Σrunner = ' + readings.runnerTests + '（聚合跑 exit=' + readings.aggregateExitCode + '，' + readings.aggregateDurationMs + 'ms）');
    lines.push(RC_TAG + ' Σguard  = ' + readings.guardTests + '（guard ok=' + readings.guardOk + '，cancelled=' + readings.guardCancelled + '）');
    lines.push(RC_TAG + ' Σextras = ' + readings.sumExtras + '（|A|=' + readings.aSize + '，|D|=' + readings.dSize + '，N=|D\\A|=' + readings.n + '）');
    lines.push(RC_TAG + ' 差额 Σrunner−Σguard = ' + readings.delta + '（运行期读数，源内无数值常量）');
    lines.push(RC_TAG + ' extras = ' + JSON.stringify(readings.extras.map((e) => ({ name: path.basename(e.file), count: e.count, outcome: e.outcome, exit: e.exitCode }))));
    if (readings.unnoted && readings.unnoted.length > 0) {
      lines.push(RC_TAG + ' 非仓内文件的分隔符名（不计入 D，仅留痕）：' + JSON.stringify(readings.unnoted.slice(0, 5)) + (readings.unnoted.length > 5 ? ' …共 ' + readings.unnoted.length + ' 条' : ''));
    }
  }
  const checks = result.mode === 'calibrate' ? result.positive.checks : result.checks;
  for (const check of checks) lines.push(RC_TAG + '   ' + (check.ok ? 'PASS' : 'FAIL') + ' ' + check.id + ' ' + check.title + ' ⇒ ' + check.detail);
  if (result.observation) lines.push(RC_TAG + '   OBS  ' + result.observation.id + ' ' + result.observation.title + ' ⇒ ' + result.observation.detail);
  lines.push(RC_TAG + ' 结论：' + (result.ok ? 'GREEN' : 'RED') + '（exit=' + (result.ok ? 0 : 1) + '）');
  return lines.join('\n');
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.error) {
    process.stderr.write(RC_TAG + ' ' + options.error + '\n');
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  const repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : REPO_ROOT;
  if (!fs.existsSync(path.join(repoRoot, TARGET_DIR_REL))) {
    process.stderr.write(RC_TAG + ' 前置失败：' + path.join(repoRoot, TARGET_DIR_REL) + ' 不存在\n');
    process.exitCode = 2;
    return;
  }

  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-readings-'));
  const env = process.env;
  let result;
  try {
    result = options.calibrate
      ? await calibrate({ repoRoot, workRoot, env })
      : await crossCheck({ repoRoot, workRoot, env });
  } finally {
    if (options.keepWork) process.stderr.write(RC_TAG + ' 保留工作目录：' + workRoot + '\n');
    else {
      try {
        fs.rmSync(workRoot, { recursive: true, force: true });
      } catch {
        /* 清理失败不影响判据 */
      }
    }
  }

  if (result.fatal) {
    process.stderr.write(RC_TAG + ' ' + result.fatal + '\n');
    process.exitCode = 2;
    return;
  }
  if (options.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else process.stdout.write(renderReport(result) + '\n');
  process.exitCode = result.ok ? 0 : 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : '';
const selfPath = path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (invokedPath && invokedPath === selfPath) {
  main().catch((error) => {
    process.stderr.write(RC_TAG + ' 自身异常：' + String(error?.stack ?? error) + '\n');
    process.exitCode = 1;
  });
}
