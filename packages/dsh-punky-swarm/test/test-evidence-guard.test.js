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

// `scripts/test-evidence-guard.mjs` 的用例面。
//
// 口径说明（三条）：
//   ① **夹具全部运行期生成**（系统临时目录），不入库任何夹具文件 —— 写域只含本件与 guard 两件；
//      夹具落 `<tmp>/target/*.test.js`（CommonJS，故 `require('node:test')` 可用），通道落 `<tmp>/channel/`。
//   ② **本件绝不对产出过的真实目标目录取全量读数**：本批多 lane 共改一仓，全量运行器读数归 audit 单点。
//      本件只跑自造夹具（1~3 个文件），读数小而确定。
//   ③ 「签名只读事件通道」在**两个层级**各自断言一次：物理级（spawn stdio 全 ignore）+ 源码级（无子进程 stdout 读取）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FORBIDDEN_SWITCHES,
  TAP_CHANNEL,
  buildRunnerSpawnOptions,
  classifyOutcome,
  decideSelfCheck,
  decideVerdict,
  exitCodeOf,
  findForbiddenSwitches,
  findForbiddenSwitchesInNodeOptions,
  parseTapChannel,
  runGuard,
  stripPairedDoubleQuotes,
} from '../scripts/test-evidence-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const GUARD_REL = 'scripts/test-evidence-guard.mjs';
const GUARD_SOURCE = fs.readFileSync(path.join(ROOT, GUARD_REL), 'utf8');

// ── 夹具（运行期写入系统临时目录） ───────────────────────────────────────

const FIXTURE_PASS = 'const { test } = require("node:test");\ntest("ok", () => {});\n';
const FIXTURE_FAIL =
  'const { test } = require("node:test");\ntest("boom", () => { throw new Error("expected-failure-fixture"); });\n';
// 未跑完即退出：注册零用例、进程顶层直接退出。
const FIXTURE_EARLY_EXIT = 'process.exit(0);\n';
// 掏空文件：合法模块、**零 `test()` 调用**（t2 族 10 / t3 A3 的护栏形态）。
const FIXTURE_EMPTY_FILE = 'const noop = 1;\n';
// stdout 伪造签名：打印形似 TAP 的完成行（RED-1 的伪造面）。
const FIXTURE_FORGED_STDOUT = [
  'const { test } = require("node:test");',
  'test("real", () => {',
  '  console.log("ok 99 - FORGED.test.js");',
  '  console.log("# Subtest: FORGED.test.js");',
  '  console.log("1..1");',
  '  console.log("# pass 99");',
  '});',
  '',
].join('\n');

/** 建沙箱：`<root>/target`（目标文件集）+ `<root>/channel`（独立通道目录）。 */
function makeSandbox(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l3-guard-fixture-'));
  const targetDir = path.join(root, 'target');
  const destDir = path.join(root, 'channel');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.mkdirSync(destDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(targetDir, name), body, 'utf8');
  }
  return { root, targetDir, destDir };
}

function dropSandbox(box) {
  fs.rmSync(box.root, { recursive: true, force: true });
}

/** 运行期应有的 |A|：直接数目标目录里的 `*.test.js`（**不作期望值写死**）。 */
function runtimeTargetCount(targetDir) {
  return fs.readdirSync(targetDir).filter((name) => name.endsWith('.test.js')).length;
}

// ── ① 双向集合 + 非空 ──────────────────────────────────────────────────

test('L3-AC-2 变①：A ≡ B（双向）且 |A| > 0；计数运行期得出', async (t) => {
  const box = makeSandbox({
    'alpha.test.js': FIXTURE_PASS,
    'beta.test.js': FIXTURE_PASS,
    'notes.txt': '非测试文件不入选',
    'helper.mjs': 'export default 1;\n',
  });
  t.after(() => dropSandbox(box));

  const verdict = await runGuard({ root: ROOT, dir: box.targetDir, destDir: box.destDir, argv: [] });

  assert.equal(verdict.channel, TAP_CHANNEL, '判定来源 = 事件通道（独立 destination）');
  assert.equal(verdict.aSize, runtimeTargetCount(box.targetDir), 'A = 运行期枚举所得，非写死的期望值');
  assert.equal(verdict.aSize > 0, true, '|A| > 0');
  assert.equal(verdict.bSize, verdict.aSize, 'B 与 A 等势');
  assert.deepEqual(verdict.missingInB, [], '无「有文件无完成事件」');
  assert.deepEqual(verdict.extraInB, [], '无「有完成事件无文件」');
  assert.equal(verdict.spawnCount, verdict.aSize, '逐文件一次 spawn');
  assert.equal(verdict.ok, true);
});

test('L3-AC-2b 变① 非空守卫：目标集合为空 ⇒ RED（防空跑假绿）', async (t) => {
  const box = makeSandbox({});
  t.after(() => dropSandbox(box));

  const verdict = await runGuard({ root: ROOT, dir: box.targetDir, destDir: box.destDir, argv: [] });

  assert.equal(verdict.aSize, 0);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.spawnCount, 0);
  assert.ok(verdict.reasons.some((r) => r.includes('empty-target-set')), '给出可判读原因');
});

test('L3-AC-3 禁硬编码计数：非注释代码行不得写死期望文件数', () => {
  const codeOnly = GUARD_SOURCE.split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  assert.equal(/\b(?:160|180)\b/.test(codeOnly), false, '写死期望值必致幻影缺口 ⇒ 假红');
});

test('L3-AC-3b 行为级：换一批规模不同的目标集，结论仍由运行期枚举决定', async (t) => {
  const two = makeSandbox({ 'a.test.js': FIXTURE_PASS, 'b.test.js': FIXTURE_PASS });
  const three = makeSandbox({ 'a.test.js': FIXTURE_PASS, 'b.test.js': FIXTURE_PASS, 'c.test.js': FIXTURE_PASS });
  t.after(() => dropSandbox(two));
  t.after(() => dropSandbox(three));

  const v2 = await runGuard({ root: ROOT, dir: two.targetDir, destDir: two.destDir, argv: [] });
  const v3 = await runGuard({ root: ROOT, dir: three.targetDir, destDir: three.destDir, argv: [] });

  assert.equal(v2.aSize, 2);
  assert.equal(v3.aSize, 3);
  const brief = (v) => JSON.stringify({ ok: v.ok, aSize: v.aSize, bSize: v.bSize, missing: v.missingInB.length, reasons: v.reasons, files: v.files });
  assert.equal(v2.ok && v3.ok, true, `两个规模都 GREEN ⇒ 无固定期望值；v2=${brief(v2)} v3=${brief(v3)}`);
});

// ── ⑤ spawn 前拒选集 / 分片开关 ─────────────────────────────────────────

test('L3-AC-4 变⑤：四开关任一 ⇒ 拒且未 spawn（spawnCount === 0）', async (t) => {
  const box = makeSandbox({ 'alpha.test.js': FIXTURE_PASS, 'beta.test.js': FIXTURE_PASS });
  t.after(() => dropSandbox(box));

  const baseline = await runGuard({ root: ROOT, dir: box.targetDir, destDir: box.destDir, argv: [] });
  assert.equal(baseline.spawnCount, baseline.aSize, '对照：同目录未被拒时会 spawn');

  for (const sw of FORBIDDEN_SWITCHES) {
    for (const form of [sw, sw + '=probe-value']) {
      const verdict = await runGuard({ root: ROOT, dir: box.targetDir, destDir: box.destDir, argv: [form] });
      assert.equal(verdict.rejected, true, `${form} 必须被拒`);
      assert.equal(verdict.ok, false, `${form} 被拒 ⇒ 不允许「缩集后 exit 0」`);
      assert.equal(verdict.spawnCount, 0, `${form} 的拒绝先于 spawn`);
      assert.ok(String(verdict.rejectReason).includes(sw), `${form} 给出可判读原因（含开关名）`);
    }
  }
});

test('L3-AC-4b 变⑤ 不误拒：reporter / 目录 / 并发等合法参数照常放行', () => {
  assert.deepEqual(findForbiddenSwitches([]), []);
  assert.deepEqual(findForbiddenSwitches(['--dir=test', '--concurrency=2', '--json']), []);
  assert.deepEqual(
    findForbiddenSwitches(['--test-reporter=tap', '--test-reporter-destination=/tmp/x.tap']),
    [],
    '前缀相近的合法参数不得被误拒',
  );
  assert.equal(findForbiddenSwitches(['--test-name-pattern=foo']).length, 1, '等号形态必须命中');
  assert.equal(findForbiddenSwitches(['--test-only']).length, 1);
});

// ── ⑥ 负向与正向同口径 + 早退可辨 ───────────────────────────────────────

test('L3-AC-5 / RED-3 变⑥：正负同口径；「早退」与「真失败」判定可分辨', async (t) => {
  const positive = makeSandbox({ 'alpha.test.js': FIXTURE_PASS });
  const negative = makeSandbox({ 'alpha.test.js': FIXTURE_FAIL });
  const early = makeSandbox({ 'alpha.test.js': FIXTURE_EARLY_EXIT });
  t.after(() => dropSandbox(positive));
  t.after(() => dropSandbox(negative));
  t.after(() => dropSandbox(early));

  const vPos = await runGuard({ root: ROOT, dir: positive.targetDir, destDir: positive.destDir, argv: [] });
  const vNeg = await runGuard({ root: ROOT, dir: negative.targetDir, destDir: negative.destDir, argv: [] });
  const vEarly = await runGuard({ root: ROOT, dir: early.targetDir, destDir: early.destDir, argv: [] });

  // 同口径：三路径同一通道、同一 verdict 形态（键集一致 ⇒ 同一函数产出）。
  assert.deepEqual(Object.keys(vPos).sort(), Object.keys(vNeg).sort());
  assert.equal(vPos.channel, TAP_CHANNEL);
  assert.equal(vNeg.channel, vPos.channel);
  assert.equal(vEarly.channel, vPos.channel);

  // 正向：通过。
  assert.equal(vPos.ok, true);
  assert.equal(vPos.files[0].outcome, 'passed');

  // 负向：判失败（预期失败夹具）。
  assert.equal(vNeg.ok, false);
  assert.equal(vNeg.files[0].outcome, 'failed');
  assert.equal(vNeg.files[0].fail, 1);

  // 早退：**不得**与「真失败」同归；也不得被读成通过。
  assert.equal(vEarly.ok, false);
  assert.equal(vEarly.files[0].outcome, 'incomplete');
  assert.equal(vEarly.files[0].fileRootSubtest, true, '文件被当作单条用例上报 = 用例未被逐条上报');
  assert.notEqual(vEarly.files[0].outcome, vNeg.files[0].outcome, '两夹具判定可分辨');
  assert.ok(vEarly.reasons.some((r) => r.includes('incomplete-completion-events')));
  assert.ok(vNeg.reasons.some((r) => r.includes('tests-failed')));

  // 唯一 verdict 函数：直接调用同一函数即可复现两个方向。
  assert.equal(decideVerdict({ targetFiles: ['F'], records: [{ file: 'F', outcome: 'passed' }] }).ok, true);
  assert.equal(decideVerdict({ targetFiles: ['F'], records: [{ file: 'F', outcome: 'failed' }] }).ok, false);
  assert.equal(decideVerdict({ targetFiles: ['F'], records: [{ file: 'F', outcome: 'incomplete' }] }).ok, false);
});

// ── RED：反伪造 ────────────────────────────────────────────────────────

test('L3-RED-1 stdout 伪造签名不被采信（判定与 A/B 集合均不变）', async (t) => {
  const forge = makeSandbox({ 'forge.test.js': FIXTURE_FORGED_STDOUT });
  const clean = makeSandbox({ 'forge.test.js': FIXTURE_PASS });
  t.after(() => dropSandbox(forge));
  t.after(() => dropSandbox(clean));

  const vForge = await runGuard({ root: ROOT, dir: forge.targetDir, destDir: forge.destDir, argv: [] });
  const vClean = await runGuard({ root: ROOT, dir: clean.targetDir, destDir: clean.destDir, argv: [] });

  assert.equal(vForge.ok, true, 'stdout 伪造不得改变结论');
  assert.equal(vForge.bSize, vClean.bSize, 'B 集合大小与未伪造时一致');
  assert.deepEqual(vForge.extraInB, [], '伪造出的 FORGED.test.js 未进入 B');
  assert.equal(vForge.files[0].outcome, 'passed');
  assert.equal(vForge.files[0].fileRootSubtest, false, 'stdout 伪造的路径名 subtest 未经采信');
  assert.equal(vForge.files[0].pass, vClean.files[0].pass, '计数仍是真实用例数（非伪造的 99）');

  // 词法层：被转义的 stdout 行不是结构性行。
  const escaped = parseTapChannel('# \\# Subtest: FORGED.test.js\n# ok 99 - FORGED.test.js\n# 1..1\n');
  assert.deepEqual(escaped.topSubtests, [], '转义后的 stdout 行不构成 subtest');
  assert.equal(escaped.hasPlan, false, '转义后的 stdout 行不构成计划行');
});

test('L3-RED-4 双向报缺口：缺完成事件 / 越界完成事件各自点名', async (t) => {
  const missing = makeSandbox({ 'alpha.test.js': FIXTURE_PASS, 'early-exit.test.js': FIXTURE_EARLY_EXIT });
  const stray = makeSandbox({ 'alpha.test.js': FIXTURE_PASS });
  t.after(() => dropSandbox(missing));
  t.after(() => dropSandbox(stray));

  // 方向一：A\B —— 目标文件没有完成事件。
  const vMissing = await runGuard({
    root: ROOT,
    dir: missing.targetDir,
    destDir: missing.destDir,
    argv: [],
  });
  assert.equal(vMissing.ok, false);
  assert.deepEqual(
    vMissing.missingInB.map((f) => path.basename(f)),
    ['early-exit.test.js'],
    '缺口清单点名到具体文件',
  );
  assert.equal(vMissing.aSize, runtimeTargetCount(missing.targetDir), 'A 不变（非「少跑就少报」）');
  assert.ok(vMissing.reasons.some((r) => r.includes('missing-completion-events')));

  // 方向二：B\A —— 通道里有一条没有对应目标文件的完成事件。
  fs.writeFileSync(path.join(stray.destDir, 'ghost.test.js.tap'), 'TAP version 13\n1..1\n# pass 1\n', 'utf8');
  const vStray = await runGuard({ root: ROOT, dir: stray.targetDir, destDir: stray.destDir, argv: [] });
  assert.equal(vStray.ok, false);
  assert.deepEqual(vStray.extraInB, ['ghost.test.js'], '越界完成事件被点名');
  assert.ok(vStray.reasons.some((r) => r.includes('stray-completion-events')));
});

// ── AC-6 事件通道的物理分离（物理级 + 源码级） ───────────────────────────

test('L3-AC-6 判定只读独立 destination：stdout 既不被采集、也不被解析', () => {
  const spawnOptions = buildRunnerSpawnOptions(ROOT);
  assert.equal(spawnOptions.stdio[0], 'ignore');
  assert.equal(spawnOptions.stdio[1], 'ignore', '子进程 stdout 不被采集');
  assert.equal(spawnOptions.stdio[2], 'ignore');

  const withoutOwnOutput = GUARD_SOURCE.split('process.stdout').join('');
  assert.equal(
    /\.stdout\b/.test(withoutOwnOutput),
    false,
    '除本件自身输出（process.stdout.write）外，无任何 stdout 读取',
  );
});

test('L3-AC-1b 环境反退化：运行器子进程不得继承退化 / 竞态源变量', () => {
  const spawnOptions = buildRunnerSpawnOptions(ROOT, {
    NODE_TEST_CONTEXT: 'child-v8',
    PUNKY_TEST_ISOLATED_HOME: 'C:/tmp/shared-root',
    PUNKY_TEST_ISOLATED_DSH_HOME: 'C:/tmp/shared-root/.dsh',
    KEEP_ME: '1',
  });
  assert.equal(
    spawnOptions.env.NODE_TEST_CONTEXT,
    undefined,
    '继承该标记会让运行器静默不产 destination、退出码仍为 0（实测退化）',
  );
  assert.equal(
    spawnOptions.env.PUNKY_TEST_ISOLATED_HOME,
    undefined,
    '共享隔离根会让并发子进程抢写同一标记文件 ⇒ 落败者被隔离前置中断 ⇒ 假红（实测）',
  );
  assert.equal(spawnOptions.env.PUNKY_TEST_ISOLATED_DSH_HOME, undefined);
  assert.equal(spawnOptions.env.KEEP_ME, '1', '只剔除退化 / 竞态源变量，不整体清空环境');
});

test('L3-AC-7 不新增 GATE_ 拒码（本件内零出现）', () => {
  assert.equal(GUARD_SOURCE.includes('GATE_'), false);
});

// ── T2GV-D-01 修复的回归锁（② NODE_OPTIONS 承载通道 + ③ 零用例不得判 passed） ──
//
// 缺陷事实（独立验证方 t2 打出、本 lane 独立复现）：⑤ 只扫 argv 且 env 未处理 `NODE_OPTIONS`
// ⇒ `NODE_OPTIONS=--test-shard=2/2` 时子运行器被分片跳过、通道只剩 `1..0`（零用例），
// 同目录含真失败用例时结论从 `RED/fail=1` 被翻成 `GREEN/exit 0/fail=0`（真失败被隐藏）。

test('L3-FIX-D01-② NODE_OPTIONS 承载禁区开关 ⇒ 拒且未 spawn（与 argv 面同形）', async (t) => {
  const box = makeSandbox({ 'alpha.test.js': FIXTURE_PASS, 'boom.test.js': FIXTURE_FAIL });
  t.after(() => dropSandbox(box));

  for (const sw of FORBIDDEN_SWITCHES) {
    const verdict = await runGuard({
      root: ROOT,
      dir: box.targetDir,
      destDir: box.destDir,
      argv: [],
      env: { ...process.env, NODE_OPTIONS: sw + '=probe-value' },
    });
    assert.equal(verdict.rejected, true, sw + ' 经 NODE_OPTIONS 必须被拒');
    assert.equal(verdict.spawnCount, 0, sw + ' 的拒绝先于 spawn');
    assert.equal(verdict.ok, false, sw + ' 被拒 ⇒ 不允许「缩集后 exit 0」');
    assert.ok(String(verdict.rejectReason).includes(sw), sw + ' 拒因须含开关名');
    assert.ok(String(verdict.rejectReason).includes('NODE_OPTIONS'), sw + ' 拒因须点出承载通道');
    assert.equal(exitCodeOf(verdict), 2, sw + ' ⇒ 非零退出码（npm 判失败）');
  }

  // 独立 token 形态（不过等号）
  const spaced = await runGuard({
    root: ROOT,
    dir: box.targetDir,
    destDir: box.destDir,
    argv: [],
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=512 --test-shard 2/2' },
  });
  assert.equal(spaced.rejected, true);
  assert.equal(spaced.spawnCount, 0);
  assert.ok(String(spaced.rejectReason).includes('--test-shard'));
});

test('L3-FIX-D01-②(b) 真失败不得被 env 通道藏起来（同目录对照读数一致）', async (t) => {
  const box = makeSandbox({ 'pass.test.js': FIXTURE_PASS, 'boom.test.js': FIXTURE_FAIL });
  t.after(() => dropSandbox(box));

  const plain = await runGuard({
    root: ROOT,
    dir: box.targetDir,
    destDir: box.destDir,
    argv: [],
    env: { ...process.env },
  });
  assert.equal(plain.ok, false, '对照：无 env 时结论为 RED');
  assert.equal(plain.totals.fail, 1, '对照：真失败被如实计入');
  assert.deepEqual(plain.failedFiles.map((f) => path.basename(f)), ['boom.test.js']);

  const masked = await runGuard({
    root: ROOT,
    dir: box.targetDir,
    destDir: box.destDir,
    argv: [],
    env: { ...process.env, NODE_OPTIONS: '--test-shard=2/2' },
  });
  assert.equal(masked.ok, false, '带该 env 不得翻成 GREEN（修复前此处为 GREEN/fail=0）');
  assert.equal(masked.rejected, true, '拒绝语义 = 不启动，而非缩集后通过');
  assert.equal(masked.spawnCount, 0);
});

test('L3-FIX-D01-②(d) 限界：非禁区 NODE_OPTIONS 必须放行并原样传递', async (t) => {
  const box = makeSandbox({ 'alpha.test.js': FIXTURE_PASS, 'beta.test.js': FIXTURE_PASS });
  t.after(() => dropSandbox(box));

  const verdict = await runGuard({
    root: ROOT,
    dir: box.targetDir,
    destDir: box.destDir,
    argv: [],
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' },
  });
  assert.equal(verdict.rejected, false, '非禁区内容不得触发拒绝（否则宿主正常用法被恒拒）');
  assert.equal(verdict.ok, true);
  assert.equal(verdict.spawnCount, verdict.aSize, '照常逐文件 spawn');

  const options = buildRunnerSpawnOptions(ROOT, { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' });
  assert.equal(
    options.env.NODE_OPTIONS,
    '--max-old-space-size=4096',
    'NODE_OPTIONS 不被静默剔除（正因如此，命中禁区时必须响亮拒绝）',
  );
});

test('L3-FIX-D01-②(e) 词边界：只拒禁区整词，不误拒前缀相近的合法项', () => {
  assert.deepEqual(findForbiddenSwitchesInNodeOptions('--max-old-space-size=4096'), []);
  assert.deepEqual(findForbiddenSwitchesInNodeOptions(''), []);
  assert.deepEqual(findForbiddenSwitchesInNodeOptions(undefined), []);
  assert.deepEqual(
    findForbiddenSwitchesInNodeOptions('--test-reporter=tap --test-reporter-destination=/tmp/x.tap'),
    [],
    'reporter 类合法项不得被误拒',
  );
  assert.equal(findForbiddenSwitchesInNodeOptions('--test-shard=2/2').length, 1);
  assert.equal(findForbiddenSwitchesInNodeOptions('--test-only').length, 1);
  assert.equal(
    findForbiddenSwitchesInNodeOptions('  --test-name-pattern=foo   --max-old-space-size=512 ').length,
    1,
    '混排时只点名禁区项',
  );
});

test('L3-FIX-D01-③ 零用例完成事件（plan === 0）⇒ 不得判 passed；既有护栏次序未动', () => {
  const zero = parseTapChannel(
    'TAP version 13\n1..0\n# tests 0\n# suites 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n',
  );
  assert.equal(zero.hasPlan, true);
  assert.equal(zero.plan, 0);
  assert.equal(zero.topSubtests.length, 0);
  assert.equal(classifyOutcome(zero), 'incomplete', 'plan=0 是「零用例被上报」，不是通过');

  // 既有三个分支的次序与语义未动（其中「路径名 subtest」是独立验证过的护栏）
  assert.equal(
    classifyOutcome(parseTapChannel('TAP version 13\n')),
    'incomplete',
    '缺计划行 ⇒ incomplete（既有护栏）',
  );
  assert.equal(
    classifyOutcome(
      parseTapChannel(
        'TAP version 13\n# Subtest: C:\\x\\a.test.js\nok 1 - C:\\x\\a.test.js\n1..1\n# tests 1\n# pass 1\n# fail 0\n',
      ),
    ),
    'incomplete',
    '路径名 subtest ⇒ incomplete（既有护栏，t2 的 A3 / F-3 读数依赖它）',
  );
  assert.equal(
    classifyOutcome(parseTapChannel('TAP version 13\n# Subtest: ok\nok 1 - ok\n1..1\n# tests 1\n# pass 1\n# fail 0\n')),
    'passed',
    '既有通过分支未被误伤',
  );

  // 零用例不静默计入集合 B
  const verdict = decideVerdict({
    targetFiles: ['/x/a.test.js'],
    records: [{ file: '/x/a.test.js', outcome: 'incomplete' }],
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.bSize, 0, '零用例文件不入 B');
  assert.deepEqual(verdict.missingInB, ['/x/a.test.js']);
});

// ── T3GV-D-01 修复的回归锁（引号差分：剥**成对双引号**、**不剥**单引号） ──
//
// 缺陷事实（独立复核方 t3 打出、本 lane 独立复现）：`splitNodeOptions` 只按 `/\s+/` 切、
// 不剥引号 ⇒ 双引号包裹的 `"--test-shard=2/2"` 不以 `--` 开头 ⇒ ⑤ 不命中；而 **Node 会剥双引号
// 并照常缩集** ⇒ 「拒 = 不启动」被绕过（实测 `spawnCount=2`、本应 0；tt 因 ③ 兜住才未成假绿）。
// 边界实测：单引号 Node **不剥**（不缩集）⇒ 不得剥；引号内含空格 Node **exit=9** ⇒ 无需处理。

test('L3-FIX-D01quote-②(a) 双引号包裹的禁区开关 ⇒ 拒且未 spawn（与 argv 面同形）', async (t) => {
  const box = makeSandbox({ 'alpha.test.js': FIXTURE_PASS, 'boom.test.js': FIXTURE_FAIL });
  t.after(() => dropSandbox(box));

  // 对照：不带引号的既有面（已在 e4 立 4/4 拒）
  const plain = await runGuard({
    root: ROOT,
    dir: box.targetDir,
    destDir: box.destDir,
    argv: [],
    env: { ...process.env, NODE_OPTIONS: '--test-shard=2/2' },
  });
  assert.equal(plain.rejected, true);
  assert.equal(plain.spawnCount, 0);

  for (const sw of FORBIDDEN_SWITCHES) {
    const verdict = await runGuard({
      root: ROOT,
      dir: box.targetDir,
      destDir: box.destDir,
      argv: [],
      env: { ...process.env, NODE_OPTIONS: '"' + sw + '=probe-value"' },
    });
    assert.equal(verdict.rejected, true, sw + ' 经双引号包裹必须被拒（修复前 spawnCount=2、exit=1）');
    assert.equal(verdict.spawnCount, 0, '⑤「拒 = 不启动」不得被引号差分绕过');
    assert.equal(verdict.ok, false);
    assert.ok(String(verdict.rejectReason).includes(sw), sw + ' 拒因须含开关名');
    assert.ok(String(verdict.rejectReason).includes('NODE_OPTIONS'), sw + ' 拒因须点名承载通道（同形）');
    assert.equal(exitCodeOf(verdict), 2, sw + ' ⇒ 非零退出码（npm 判失败）');
  }

  // 混排：非禁区项在前，双引号禁区项在后
  const mixed = await runGuard({
    root: ROOT,
    dir: box.targetDir,
    destDir: box.destDir,
    argv: [],
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=512 "--test-shard=2/2"' },
  });
  assert.equal(mixed.rejected, true);
  assert.equal(mixed.spawnCount, 0);
  assert.ok(String(mixed.rejectReason).includes('--test-shard'));
});

test('L3-FIX-D01quote-②(b) 双引号包裹的**非禁区**项 ⇒ 仍必须放行且原样传递', async (t) => {
  const box = makeSandbox({ 'alpha.test.js': FIXTURE_PASS, 'beta.test.js': FIXTURE_PASS });
  t.after(() => dropSandbox(box));

  const verdict = await runGuard({
    root: ROOT,
    dir: box.targetDir,
    destDir: box.destDir,
    argv: [],
    env: { ...process.env, NODE_OPTIONS: '"--max-old-space-size=4096"' },
  });
  assert.equal(verdict.rejected, false, '双引号包裹不得把非禁区内容判成禁区（否则是把一个洞换成另一个洞）');
  assert.equal(verdict.ok, true);
  assert.equal(verdict.spawnCount, verdict.aSize, '照常逐文件 spawn');

  const options = buildRunnerSpawnOptions(ROOT, { ...process.env, NODE_OPTIONS: '"--max-old-space-size=4096"' });
  assert.equal(
    options.env.NODE_OPTIONS,
    '"--max-old-space-size=4096"',
    'env 原样传递给子进程（未被静默改写）',
  );
});

test('L3-FIX-D01quote-②(c) 单引号形态：Node 不剥、不缩集 ⇒ ⑤ 不应因此拒；既有无引号面不回归', async () => {
  // 单引号：不得剥（Node 不剥 ⇒ 剥了会误拒）
  assert.equal(
    findForbiddenSwitchesInNodeOptions("'--test-shard=2/2'").length,
    0,
    '单引号形态不命中（Node 不剥单引号 ⇒ 该形态根本不缩集）',
  );
  assert.equal(stripPairedDoubleQuotes("'--test-shard=2/2'"), "'--test-shard=2/2'", '本函数只剥双引号');
  assert.equal(stripPairedDoubleQuotes('"--test-shard=2/2"'), '--test-shard=2/2', '成对双引号被剥');
  assert.equal(stripPairedDoubleQuotes('--test-shard=2/2"'), '--test-shard=2/2"', '非成对不得剥');
  assert.equal(stripPairedDoubleQuotes('--test-shard=2/2'), '--test-shard=2/2', '无引号原样');

  // 既有（无引号）四开关判别不回归
  for (const sw of FORBIDDEN_SWITCHES) {
    assert.equal(findForbiddenSwitchesInNodeOptions(sw + '=x').length, 1, sw + ' 的既有判别不回归');
  }
  // 前缀相近的合法项仍不被误拒
  assert.deepEqual(
    findForbiddenSwitchesInNodeOptions('--test-reporter=tap --test-reporter-destination=/tmp/x.tap'),
    [],
  );
});

test('L3-FIX-D01quote-(d) 既有 ③ 两条护栏经**端到端 guard 实跑**仍为 incomplete + fileRootSubtest', async (t) => {
  const box = makeSandbox({
    't-empty.test.js': FIXTURE_EMPTY_FILE,
    't-early-top.test.js': FIXTURE_EARLY_EXIT,
  });
  t.after(() => dropSandbox(box));

  const verdict = await runGuard({
    root: ROOT,
    dir: box.targetDir,
    destDir: box.destDir,
    argv: [],
    env: { ...process.env },
  });
  assert.equal(verdict.ok, false, '两条护栏都必须在结论上转红');

  const byName = new Map(verdict.files.map((f) => [path.basename(f.file), f]));
  for (const name of ['t-empty.test.js', 't-early-top.test.js']) {
    const record = byName.get(name);
    assert.ok(record, name + ' 必须在读数内（A ≡ 枚举，不得漏项）');
    assert.equal(record.outcome, 'incomplete', name + '：A3 掏空 / F-3 顶层早退 ⇒ incomplete');
    assert.equal(record.fileRootSubtest, true, name + '：必须以**文件路径名 subtest** 现身');
  }
});

// ── D-3（读数口径）：`files[]` 增 `cancelled` + `selfCheck` 机读字段 ─────────
//
// 缺陷事实（D-3②）：`files[]` 缺 `cancelled` 字段 ⇒ 恒等式只能写成
//   `Σfiles.tests === totals.tests − totals.cancelled`，而**没有一处断言在验它**；
//   汇总数与明细数因此可以互相矛盾而无人发现。
// 修复口径：`files[]` 与 `totals` **对称**（双向可复算）；`selfCheck` 只出字段、
//   **不参与 `ok`**（承既有裁决：做成硬门 = 新增判据，须单独裁决）。

const FIXTURE_SKIP = 'const { test } = require("node:test");\ntest("x", { skip: true }, () => {});\n';

test('D3-1 S1 双向可复算：Σfiles[].tests === totals.tests（真实运行器读数）', async (t) => {
  const box = makeSandbox({ 'alpha.test.js': FIXTURE_PASS, 'beta.test.js': FIXTURE_SKIP });
  t.after(() => dropSandbox(box));

  const verdict = await runGuard({ root: ROOT, dir: box.targetDir, destDir: box.destDir, argv: [] });
  const sumFiles = verdict.files.reduce((acc, item) => acc + item.tests, 0);

  assert.equal(sumFiles, verdict.totals.tests, '由**明细**求和算得的汇总 === 实测汇总');
  assert.equal(
    verdict.files.reduce((acc, item) => acc + item.skipped, 0),
    verdict.totals.skipped,
    '逐文件 skipped 亦与汇总等高（明细 ⇔ 汇总双向）',
  );
  assert.equal('cancelled' in verdict.files[0], true, 'files[] 含 cancelled 字段（与 totals 对称）');
  assert.equal(verdict.totals.skipped, 1, '夹具含 1 条 skip ⇒ 该列真的非零（不是恒零假绿）');
  assert.equal(verdict.selfCheck.ok, true, 'selfCheck.ok === true（S1/S2 全成立）');
});

test('D3-2 S2：汇总内五分量之和 === tests（机读字段，与打印面同一实现）', async (t) => {
  const box = makeSandbox({ 'alpha.test.js': FIXTURE_PASS, 'beta.test.js': FIXTURE_SKIP });
  t.after(() => dropSandbox(box));

  const verdict = await runGuard({ root: ROOT, dir: box.targetDir, destDir: box.destDir, argv: [] });
  const sumParts =
    verdict.totals.pass + verdict.totals.fail + verdict.totals.skipped
    + verdict.totals.cancelled + verdict.totals.todo;

  assert.equal(sumParts, verdict.totals.tests);
  assert.equal(verdict.selfCheck.s2.sum, sumParts, 'selfCheck.s2.sum 与人工重算同值（不另算一套口径）');
  assert.equal(verdict.selfCheck.s2.ok, true);
});

test('D3-2b `cancelled` 通路：per-file record 的 cancelled 进 files[] 与 totals（同一归一）', () => {
  const verdict = decideVerdict({
    targetFiles: ['/x/a.test.js', '/x/b.test.js'],
    records: [
      { file: '/x/a.test.js', outcome: 'passed', tests: 3, pass: 3, cancelled: 0 },
      // 一条被取消的用例：pass/fail/skipped/todo 都不计它，只有 cancelled 计。
      { file: '/x/b.test.js', outcome: 'passed', tests: 2, pass: 1, cancelled: 1 },
    ],
  });

  assert.equal(verdict.files[1].cancelled, 1, '逐文件 cancelled 如实透出');
  assert.equal(verdict.totals.cancelled, 1);
  assert.equal(verdict.files.reduce((acc, item) => acc + item.tests, 0), verdict.totals.tests, 'S1 成立');
  assert.equal(verdict.selfCheck.ok, true, 'S2：5 === 4 + 0 + 0 + 1 + 0');
  assert.equal(verdict.ok, true, 'selfCheck 与 ok 是两条轨：本处 ok 仍由集合/失败面决定');
});

test('D3-2c 反控（可达构造）：汇总被做坏 ⇒ selfCheck 红；且 `ok` 语义不因此改变', () => {
  const verdict = decideVerdict({
    targetFiles: ['/x/a.test.js'],
    records: [{ file: '/x/a.test.js', outcome: 'passed', tests: 2, pass: 2 }],
  });
  assert.equal(verdict.selfCheck.ok, true, '先确认正控成立');

  // S1 反控：明细求和与汇总对不上。
  const s1Broken = decideSelfCheck(verdict.files, { ...verdict.totals, tests: verdict.totals.tests + 1 });
  assert.equal(s1Broken.ok, false, 'Σfiles.tests ≠ totals.tests ⇒ 必须红');
  assert.equal(s1Broken.s1.ok, false);
  assert.match(s1Broken.detail, /S1 不成立/);

  // S2 反控：五分量之和与 tests 对不上。
  const s2Broken = decideSelfCheck(verdict.files, { ...verdict.totals, pass: verdict.totals.pass - 1 });
  assert.equal(s2Broken.ok, false);
  assert.equal(s2Broken.s2.ok, false);
  assert.match(s2Broken.detail, /S2 不成立/);

  assert.equal(verdict.ok, true, '原 verdict 的 ok 未被 selfCheck 牵连（两轨独立）');
});

test('D3-2d 回归锁：`selfCheck` 不得不参与 `ok`（源码级，防静默升门）', () => {
  const okAssign = /const ok =\s*([\s\S]*?);/.exec(GUARD_SOURCE);
  assert.ok(okAssign, '必须能找到 `const ok = …;` 赋值');
  assert.equal(
    /selfCheck/.test(okAssign[1]),
    false,
    '`ok` 的构成不得引用 selfCheck（升为门禁须单独裁决；本条防静默升级）',
  );
});

test('D3-2e 键集对称：`files[]` 与 `totals` 的计数键互相对应（无「只在一边」的计数）', () => {
  const verdict = decideVerdict({
    targetFiles: ['/x/a.test.js'],
    records: [{ file: '/x/a.test.js', outcome: 'passed', tests: 1, pass: 1 }],
  });
  const counterKeys = ['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo'];
  for (const key of counterKeys) {
    assert.equal(key in verdict.totals, true, `totals 缺 ${key}`);
    assert.equal(key in verdict.files[0], true, `files[] 缺 ${key}（残缺即不可复算）`);
  }
});
