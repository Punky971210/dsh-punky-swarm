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

// `scripts/readings-consistency.mjs` 的用例面（D-3 · 验收 B-1 / B-3 / B-4）。
//
// 口径（三条）：
//   ① 本件**不跑** `--cross-check`（分钟级、且要跑两遍全量口径 ⇒ 那是验收与发版前的按需回路）；
//      这里只钉**纯函数**与**反控**：公式的每一条 RED 条件都必须有可达构造（验收 B-4）。
//   ② 反控一律经**同一裁定函数** `evaluateIdentity`（不另写一份判据），故这些用例同时是
//      「单一实现」的回归锁。
//   ③ `19` 这个数**永不入源码、不入用例断言**：它是运行期读数。本件只断言「源码里没有该常量」。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  deriveDiscovered,
  evaluateIdentity,
  parseAggregate,
  resolveRepoCodeFile,
  unescapeTapName,
} from '../scripts/readings-consistency.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const READINGS_SOURCE = fs.readFileSync(path.join(ROOT, 'scripts/readings-consistency.mjs'), 'utf8');

/** 真实存在、且**不是** `*.test.js` 的仓内文件（即默认 runner 的「extra」形态）。 */
const REAL_EXTRA_REL = 'test/helpers/gate-fixture.mjs';

// ── 通道解析：路径名 subtest 是 D 的唯一物理来源 ──────────────────────────

test('S4-① TAP 路径名还原：转义的双反斜杠还原成单反斜杠', () => {
  assert.equal(unescapeTapName('test\\\\helpers\\\\gate-fixture.mjs'), 'test\\helpers\\gate-fixture.mjs');
  assert.equal(unescapeTapName('普通用例名'), '普通用例名');
  assert.equal(unescapeTapName('L2 顺序无关: 签发者在 bundle 首张 / 第二张'), 'L2 顺序无关: 签发者在 bundle 首张 / 第二张');
});

test('S4-② 聚合解析：`# tests` 与顶层 subtest 名同源（同一词法，复用 guard 的 parseTapChannel）', () => {
  const tap = [
    'TAP version 13',
    '# Subtest: 用例甲',
    'ok 1 - 用例甲',
    '# Subtest: test\\\\helpers\\\\gate-fixture.mjs',
    'ok 2 - test\\\\helpers\\\\gate-fixture.mjs',
    '1..2',
    '# tests 2',
    '# pass 2',
    '# fail 0',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
    '',
  ].join('\n');
  const parsed = parseAggregate(tap);
  assert.equal(parsed.tests, 2, '汇总数取自结构化的 `# tests` 行');
  assert.deepEqual(parsed.pathNames, ['用例甲', 'test\\helpers\\gate-fixture.mjs']);
});

test('S4-③ 发现判据是物理的：盘上真有该文件才算 D（不靠名字长得像）', () => {
  const real = resolveRepoCodeFile(ROOT, REAL_EXTRA_REL);
  assert.equal(real, path.join(ROOT, REAL_EXTRA_REL), '仓内真文件 ⇒ 解析成绝对路径');

  assert.equal(resolveRepoCodeFile(ROOT, 'test/helpers/does-not-exist.mjs'), null, '盘上没有 ⇒ null');
  assert.equal(resolveRepoCodeFile(ROOT, 'test/helpers/gate-fixture.mjs.bak'), null, '非代码扩展名 ⇒ null');
  assert.equal(resolveRepoCodeFile(ROOT, 'a/b/c.mjs'), null, '不在仓内的相对路径 ⇒ null');
  assert.equal(
    resolveRepoCodeFile(ROOT, '../outside.mjs'),
    null,
    '越出仓根 ⇒ null（防把仓外路径当成发现面证据）',
  );
  assert.equal(resolveRepoCodeFile(ROOT, 'L2 顺序无关: 首张 / 第二张'), null, '带 `/` 的用例名 ⇒ null');
  assert.equal(resolveRepoCodeFile(ROOT, 'package.json'), null, '无分隔符 ⇒ null（不是路径名 subtest）');
});

test('S4-④ 发现集去重 + 非仓内名只留痕（不静默丢弃）', () => {
  const derived = deriveDiscovered({
    repoRoot: ROOT,
    pathNames: [
      REAL_EXTRA_REL,
      REAL_EXTRA_REL,
      'L5 用例名里带 / 的分隔符',
      'g10/不存在的.mjs',
    ],
  });
  assert.equal(derived.files.length, 1, '同一文件出现两次 ⇒ 只算一次');
  assert.equal(derived.unnoted.length, 2, '带分隔符但不是仓内文件的名字进 unnoted（可见，不计入 D）');
});

// ── C1–C5：正控 + 三条反控（验收 B-4）──────────────────────────────────────

const CONSISTENT = Object.freeze({
  runnerTests: 12,
  guardTests: 10,
  targetFiles: ['/repo/test/a.test.js', '/repo/test/b.test.js'],
  extras: [
    { file: '/repo/test/helpers/one.mjs', count: 1 },
    { file: '/repo/scripts/test-tool.mjs', count: 1 },
  ],
});

test('C1 正控：Σrunner === Σguard + Σextras ⇒ 全绿（C5 只观察不判红）', () => {
  const verdict = evaluateIdentity(CONSISTENT);
  assert.equal(verdict.ok, true, '12 === 10 + 1 + 1');
  assert.deepEqual(verdict.checks.map((c) => [c.id, c.ok]), [
    ['C1', true],
    ['C2', true],
    ['C3', true],
    ['C4', true],
  ]);
  assert.equal(verdict.observation.ok, null, 'C5 是观察项（ok === null），不参与裁定');
  assert.equal(verdict.readings.n, 2, 'N = |D\\A| 运行期算');
  assert.equal(verdict.readings.dSize, 4, '|D| = |A| + |D\\A|');
});

test('B-4-C1 反控：Σrunner 人为 +1 ⇒ 红，且只红在 C1', () => {
  const verdict = evaluateIdentity({ ...CONSISTENT, runnerTests: CONSISTENT.runnerTests + 1 });
  assert.equal(verdict.ok, false);
  const failing = verdict.checks.filter((c) => c.ok === false).map((c) => c.id);
  assert.deepEqual(failing, ['C1'], '只红在 C1：其余判据不受牵连');
  assert.match(verdict.checks[0].detail, /Σrunner=13 ≠ Σguard\+Σextras=10\+2=12/);
});

test('B-4-C2 反控：D\\A 里出现 `*.test.js` ⇒ 红，并点出「guard 漏收」', () => {
  const verdict = evaluateIdentity({
    ...CONSISTENT,
    extras: [{ file: '/repo/scripts/leaked.test.js', count: 2 }],
    runnerTests: 12,
  });
  assert.equal(verdict.ok, false);
  const c2 = verdict.checks.find((c) => c.id === 'C2');
  assert.equal(c2.ok, false, '这是本判据最有价值的一侧：guard 漏收真测试文件');
  assert.match(c2.detail, /leaked\.test\.js/);
});

test('B-4-C3 反控：目标集清空 ⇒ 红（empty-target-set，防空跑假绿）', () => {
  const verdict = evaluateIdentity({ runnerTests: 0, guardTests: 0, targetFiles: [], extras: [] });
  assert.equal(verdict.ok, false);
  const c3 = verdict.checks.find((c) => c.id === 'C3');
  assert.equal(c3.ok, false);
  assert.match(c3.detail, /\|A\| = 0/);
  assert.match(c3.detail, /\|D\\A\| = 0/, 'D\\A 为空不得自动放行：发现规则变了必须重新校准');
});

test('C4 反控：某 extra 零点数 ⇒ 红（被 runner 发现却 0 点本身就是信号）', () => {
  const verdict = evaluateIdentity({
    ...CONSISTENT,
    extras: [{ file: '/repo/test/helpers/one.mjs', count: 0 }],
    runnerTests: 11,
    guardTests: 10,
  });
  assert.equal(verdict.ok, false);
  const c4 = verdict.checks.find((c) => c.id === 'C4');
  assert.equal(c4.ok, false);
  assert.match(c4.detail, /one\.mjs/);
});

test('C1 不可判：聚合通道没读到 `# tests` ⇒ 红（不把「没读到」当 0）', () => {
  const verdict = evaluateIdentity({ ...CONSISTENT, runnerTests: null });
  assert.equal(verdict.ok, false);
  assert.match(verdict.checks[0].detail, /未读到 # tests/);
});

test('C5 观察面：extra 点数不为 1 时只打印、不判红（Node 发现语义变化不该假红）', () => {
  const verdict = evaluateIdentity({
    ...CONSISTENT,
    extras: [
      { file: '/repo/test/helpers/one.mjs', count: 1 },
      { file: '/repo/test/helpers/two.mjs', count: 3 },
    ],
    runnerTests: 14,
    guardTests: 10,
  });
  assert.equal(verdict.ok, true, 'C1 仍成立（10 + 1 + 3 = 14）⇒ 不得因「不统一」判红');
  assert.equal(verdict.observation.ok, null);
  assert.match(verdict.observation.detail, /\[1, 3\]/);
});

// ── B-3：`N` 运行期算 —— 源码不得含该数量常量 ─────────────────────────────

test('B-3 源码无数量常量（`N` 必须运行期算，写死必致加/删 helper 后假绿或假红）', () => {
  assert.equal(READINGS_SOURCE.includes('19'), false, '源码不得出现该数量常量（含注释与字符串）');
  assert.equal(/=\s*19\b/.test(READINGS_SOURCE), false, '不得把 N 赋成字面量');
});

test('B-6b 源码纪律：新脚本不经 shell / 不采集 stdout / 以 close 事件取码', () => {
  assert.equal(/shell\s*:\s*true/.test(READINGS_SOURCE), false);
  assert.equal(/\bexecSync\b/.test(READINGS_SOURCE), false);
  assert.equal(/child\.stdout/.test(READINGS_SOURCE), false, '子进程 stdout 不采集（通道纪律与 guard 同源）');
  assert.equal(/child\.on\('close'/.test(READINGS_SOURCE), true, '退出码来自 close 事件');
});
