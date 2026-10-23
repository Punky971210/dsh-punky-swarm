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

// 退出码纪律的用例面（D-3 · 验收 B-5 / B-6）。
//
// 存在理由：`scripts/test-evidence-guard.mjs` 的**真实 CLI 退出码**此前**无任何测试** ——
//   既有用例（`test/test-evidence-guard.test.js`）只用进程内的 `exitCodeOf(verdict)`，
//   即「按裁定函数算出应该是几」，而不是「子进程真的退了几」。
//   两者之间的差距恰好是本缺陷的形态：**取码方式**会让 `exit 1` 被读成 `0`。
//
// 本件的两条纪律：
//   ① **直取**：一律 `spawn(process.execPath, args)` + `child.on('close', code)`，不经 shell、不进管道；
//   ② **对照**：把「管道把 1 读成 0」这个形态本身固化成用例（B-6），防后人再踩。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const GUARD_REL = 'scripts/test-evidence-guard.mjs';
const READINGS_REL = 'scripts/readings-consistency.mjs';

const FIXTURE_PASS = 'const { test } = require("node:test");\ntest("ok", () => {});\n';
const FIXTURE_FAIL =
  'const { test } = require("node:test");\ntest("boom", () => { throw new Error("expected-failure-fixture"); });\n';

// ── 取码工具（本件唯一 spawn 点：直取、不经 shell）──────────────────────────

/**
 * 跑一个子进程并**直取退出码**（唯一形态）。
 * `stdio: 'ignore'` 是本仓既有通道纪律的延伸：判定侧不采集 stdout，也就不会被 stdout 上的
 * 「看起来像成功」的文字影响。
 * @returns {Promise<{code: number|null, spawnError: string|null}>}
 */
function runDirect(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('error', (error) => resolve({ code: null, spawnError: String(error?.message ?? error) }));
    child.on('close', (code) => resolve({ code, spawnError: null }));
  });
}

/** 经 shell 跑一条**完整命令行**（只用于 B-6 的管道对照，绝不用于取被测命令的退出码）。 */
function runThroughShell(commandLine) {
  return new Promise((resolve) => {
    const child = spawn(commandLine, { shell: true, stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('error', (error) => resolve({ code: null, spawnError: String(error?.message ?? error) }));
    child.on('close', (code) => resolve({ code, spawnError: null }));
  });
}

/** 建沙箱：`<root>/target`（目标文件集）+ `<root>/channel`（独立 TAP 通道目录）。 */
function makeSandbox(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-exitcode-fixture-'));
  const targetDir = path.join(root, 'target');
  const destDir = path.join(root, 'channel');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.mkdirSync(destDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(targetDir, name), body, 'utf8');
  }
  return { root, targetDir, destDir };
}

// ── B-5：guard CLI 的真实退出码（子进程实取）──────────────────────────────

test('B-5-① guard CLI：GREEN 夹具 ⇒ 退出码 0（子进程实取，非 in-process 推算）', async (t) => {
  const box = makeSandbox({ 'alpha.test.js': FIXTURE_PASS });
  t.after(() => fs.rmSync(box.root, { recursive: true, force: true }));

  const result = await runDirect(process.execPath, [
    path.join(ROOT, GUARD_REL),
    '--dir=' + box.targetDir,
    '--dest-dir=' + box.destDir,
  ]);

  assert.equal(result.spawnError, null, '子进程必须能起');
  assert.equal(result.code, 0, 'GREEN ⇒ 0（这是「已通过」唯一可信的读数形态）');
});

test('B-5-② guard CLI：RED 夹具 ⇒ 退出码 1（`exit 1` 必须能被读到 1）', async (t) => {
  const box = makeSandbox({ 'alpha.test.js': FIXTURE_FAIL });
  t.after(() => fs.rmSync(box.root, { recursive: true, force: true }));

  const result = await runDirect(process.execPath, [
    path.join(ROOT, GUARD_REL),
    '--dir=' + box.targetDir,
    '--dest-dir=' + box.destDir,
  ]);

  assert.equal(result.code, 1, 'RED ⇒ 1（若读成 0，则「exit=0 判据」结构性不可达）');
});

test('B-5-③ guard CLI：禁区开关 ⇒ 退出码 2（拒绝 = 未 spawn，与 RED 可区分）', async (t) => {
  const box = makeSandbox({ 'alpha.test.js': FIXTURE_PASS });
  t.after(() => fs.rmSync(box.root, { recursive: true, force: true }));

  const result = await runDirect(process.execPath, [
    path.join(ROOT, GUARD_REL),
    '--dir=' + box.targetDir,
    '--dest-dir=' + box.destDir,
    '--test-shard=2/2',
  ]);

  assert.equal(result.code, 2, '拒绝（usage 级）⇒ 2：与「跑完判红」的 1 分档，不是新造语义');
});

// ── B-6：退出码纪律自证（管道形态把 1 读成 0）──────────────────────────────

test('B-6 管道形态把 `exit 1` 读成 0，直取形态读到 1（两种形态对照，防后人再踩）', async () => {
  const exe = JSON.stringify(process.execPath);

  // 形态 A（**错误示范**）：左段 `exit 1` 经管道交给右段 —— 拿到的码是**末段**的码。
  //   等价的终端写法：`cmd | tee`、`cmd | tail`、`out=$(cmd) | …`，以及 `2>&1 | …` 里取 `$?`。
  //   本件用「右段是 `process.exit(0)`」的构造，避免依赖 `cat`/`tee` 这类平台外部命令，
  //   机制与 `bash -c 'node -e "process.exit(1)" | cat'` 逐字相同：**取到的都是末段码**。
  const piped = await runThroughShell(exe + ' -e "process.exit(1)" | ' + exe + ' -e "process.exit(0)"');
  assert.equal(piped.code, 0, '管道把左段的 1 吞掉 ⇒ 这正是「门禁红被读成绿」的物理成因');

  // 形态 A'：末段也是 1 ⇒ 读到的才是 1（证明确实是「末段码」，不是「碰巧恒为 0」）。
  const pipedSame = await runThroughShell(exe + ' -e "process.exit(1)" | ' + exe + ' -e "process.exit(1)"');
  assert.equal(pipedSame.code, 1, '末段码为 1 时管道才「看起来正常」⇒ 更隐蔽');

  // 形态 B（**正确姿势**）：直取，无 shell、无管道。
  const direct = await runDirect(process.execPath, ['-e', 'process.exit(1)']);
  assert.equal(direct.code, 1, '直取形态读到 1');
});

/**
 * 剥离注释后的「代码区」（只看代码字面量，不看注释里的反例说明）。
 *
 * 为什么必须剥：本仓纪律要求在**注释里写清反例形态**（否则后来者会踩），
 *   若断言不剥注释，则「把坑写进注释」反而会判红 —— 那会逼人删掉最有价值的那段说明。
 *   本仓既有同类做法：`test/test-evidence-guard.test.js` 的 L3-AC-3 也是先剥注释再断言。
 */
function codeOnly(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

test('B-6b 源码级：被测两个脚本都不含「经管道 / shell 取码」的形态', () => {
  for (const rel of [READINGS_REL, GUARD_REL]) {
    const code = codeOnly(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    // 取码形态只允许 `child.on('close', code)` 一族（由下面的否定断言兜住）。
    assert.equal(/shell\s*:\s*true/.test(code), false, rel + ' 不得经 shell 取码（shell 会引入管道语义）');
    assert.equal(/\bexecSync\b/.test(code), false, rel + ' 不得用 execSync（stdout 采集 + 取码耦合）');
    assert.equal(/\$\?/.test(code), false, rel + ' 代码区不得以 `$?` 形态取码');
  }
});

// ── B-5（读数脚本侧）+ B-2：readings-consistency 的退出码与校准读数 ──────────

test('B-5-④ readings CLI：用法错 ⇒ 退出码 2（fail-closed，未做任何测量）', async () => {
  const noFlag = await runDirect(process.execPath, [path.join(ROOT, READINGS_REL)]);
  assert.equal(noFlag.code, 2, '既无 --calibrate 也无 --cross-check ⇒ 用法错');

  const both = await runDirect(process.execPath, [
    path.join(ROOT, READINGS_REL),
    '--calibrate',
    '--cross-check',
  ]);
  assert.equal(both.code, 2, '两个模式并用 ⇒ 用法错（不静默挑一个）');

  const unknown = await runDirect(process.execPath, [path.join(ROOT, READINGS_REL), '--nope']);
  assert.equal(unknown.code, 2, '未知参数 ⇒ 用法错（不静默降级为无参）');
});

test('B-2 readings --calibrate：退出码 0（校准不过就不许出 --cross-check 结论）', async () => {
  const result = await runDirect(process.execPath, [path.join(ROOT, READINGS_REL), '--calibrate']);
  assert.equal(result.code, 0, '校准必须通过（否则 C1 公式本身可疑，--cross-check 的红绿不可归因）');
});

test('B-2b 校准读数：夹具三文件的期望点数（3 / 1 / 1）与聚合语义结论逐条对上', async (t) => {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-calib-'));
  t.after(() => fs.rmSync(workRoot, { recursive: true, force: true }));

  // 进程内调用：`--calibrate` 与用例共用**同一实现**（CLI 只是薄壳）。
  const mod = await import('../scripts/readings-consistency.mjs');
  const result = await mod.calibrate({ repoRoot: ROOT, workRoot, env: process.env });

  assert.equal(result.ok, true, '校准结论 GREEN：' + JSON.stringify(result.controls.filter((c) => !c.ok)));
  // 夹具成分：2 个测试文件（3 点 / 1 点）+ 1 个 `test-` 前缀零用例文件（被 runner 计 1 点）。
  assert.equal(result.readings.guardLikeTests, 4, '夹具侧 guard 口径 = 3 + 1（只认 *.test.js）');
  assert.equal(result.readings.aggregateTests, 5, '聚合口径 = 叶子 4 点 + 零用例发现文件 1 点 ⇒ 5 ≠ 文件数 3');
  assert.equal(result.readings.discovered.length, 1, '发现面恰 1 个：`test-` 前缀零用例探针');
  assert.ok(
    result.readings.discovered[0].endsWith('test-gamma.mjs'),
    '发现面点名到夹具探针：' + JSON.stringify(result.readings.discovered),
  );

  // 三条反控必须都红过（判据有可达构造，不是只写在文档里）。
  const byId = new Map(result.controls.map((control) => [control.id, control]));
  for (const id of ['K1', 'K2', 'K3', 'R1', 'R2', 'R3']) {
    assert.ok(byId.has(id), '校准项 ' + id + ' 必须在读数内');
    assert.equal(byId.get(id).ok, true, id + ' 必须通过：' + byId.get(id).detail);
  }
  assert.equal(result.positive.ok, true, '校准侧 C1–C4 全绿：' + JSON.stringify(result.positive.checks));
});

test('B-2c `--json` 与人工输出同源：CLI 参数面 fail-closed', async () => {
  const mod = await import('../scripts/readings-consistency.mjs');
  const parsed = mod.parseCliArgs(['--calibrate', '--json']);
  assert.equal(parsed.calibrate, true);
  assert.equal(parsed.json, true);
  assert.equal(parsed.error, null);
  assert.equal(mod.parseCliArgs([]).error !== null, true, '无参 ⇒ error（CLI 据此 exit 2）');
  assert.equal(mod.parseCliArgs(['--calibrate', '--cross-check']).error !== null, true, '两模式并用 ⇒ error');
});

// ── N4：`--cross-check` 不进 `npm test` 默认链（分钟级）─────────────────────

test('N4 `npm test` 默认链不含 --cross-check（分钟级只得按需跑）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(
    String(pkg.scripts?.test ?? '').includes('cross-check'),
    false,
    '`--cross-check` 跑两遍全量口径，不得进默认链（否则每次 npm test 都分钟级）',
  );
});
