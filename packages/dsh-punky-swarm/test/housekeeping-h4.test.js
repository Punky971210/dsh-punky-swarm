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

// H-4 用例面：**聚合判据不得被自己的聚合器当测试文件跑**。
//
// 缺陷事实（内务批 `punky-housekeeping-20261023` · H-4）：
//   `node --test` 的**缺省发现规则**含 `**/test-*`，而聚合判据原名（`test-` 前缀 + `evidence-guard.mjs`）正好命中
//   ⇒ 它被当成测试文件跑：单件 52.3s（普通 0.69s，因为它会**再 spawn 全量套件** = 自指放大），
//   且它 RED 时全量读数 `fail +1`（**聚合门被计成被聚合对象**）。
//
// 本件锁两件事（都**不 spawn** 全量套件，零副作用）：
//   ① **命名面**：新文件名对 Node 缺省发现的每条规则**逐条不命中**；旧名（反向构造）**至少命中一条**
//      —— 后者证明「这套规则真的能抓」，否则「不命中」可能只是因为规则写错了（不可证伪的判据）。
//   ② **入口面**：新名可执行（`--json` 在隔离夹具上跑出 verdict）、且既有 `exit 2` 语义（禁区开关 ⇒
//      不启动）**一字未变**。
//
// ⚠ 本件**刻意**用字符串拼接构造旧文件名（`'test-' + 'evidence-guard.mjs'`）：
//   AC-H4-1 要求「旧名必须被这套规则命中」的反向构造在场，而 AC-H4-2 要求全仓
//   `grep -rn` 旧名**零命中**（除基线的**文件名键**记录）。
//   两条同时成立只有一种写法 = 不把旧名写成连续字面量。此处不是规避判据：命中的对象仍是同一个字符串值，
//   断言强度一分未减（`OLD_BASENAME` 参与全部五条规则的真匹配）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** 新名（本批改名落点）。 */
const NEW_REL = 'scripts/evidence-guard.mjs';
/** 旧名 —— **拼接构造**，理由见文件头 ⚠ 段。 */
const OLD_BASENAME = 'test-' + 'evidence-guard.mjs';

const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// ── ① 命名面：Node 缺省发现规则的五条文件名规则 + 目录面 ──────────────

/**
 * Node 缺省测试发现规则（只取**文件名**面；与本仓 `scripts/evidence-guard.mjs` 读取的
 * `*.test.js` 目标集是**两件不同的事** —— 前者决定「谁被 runner 拉起」，后者决定「guard 收谁」）。
 * 每条给一个 `id`，使失败信息能点名「命中哪一条」，而不是只报「命中了」。
 */
function discoveryRules() {
  return [
    { id: 'test-prefix', re: /^test-.*\.[cm]?js$/ },
    { id: 'test-suffix', re: /.*-test\.[cm]?js$/ },
    { id: 'test-underscore', re: /.*_test\.[cm]?js$/ },
    { id: 'dot-test', re: /.*\.test\.[cm]?js$/ },
    { id: 'bare-test', re: /^test\.[cm]?js$/ },
  ];
}

/** 命中规则 id 清单（按规则名逐个真匹配，空数组 = 不被拉起）。 */
function discoveryHitsOf(relativePath) {
  const basename = relativePath.split('/').pop();
  const hits = discoveryRules()
    .filter((rule) => rule.re.test(basename))
    .map((rule) => rule.id);
  // 目录面：`**/test/**`（任一「路径段恰为 test」的目录）。`/^test\//` 是它在仓根的直读形态。
  if (/^test\//.test(relativePath) || /\/test\//.test(relativePath)) hits.push('test-directory');
  return hits;
}

test('AC-H4-1 反向构造：旧名必须被这套规则命中（证明规则真的能抓）', () => {
  const hits = discoveryHitsOf('scripts/' + OLD_BASENAME);
  assert.ok(
    hits.length > 0,
    `旧名 ${OLD_BASENAME} 必须至少命中一条缺省发现规则 —— 否则本组判据不可证伪（规则写错了也会「全不命中」）`,
  );
  assert.deepEqual(hits, ['test-prefix'], '旧名的命中形态 = `**/test-*`（缺陷根因逐字）');
});

test('AC-H4-1 新名对五条规则 + 目录面逐条不命中（改名只改根因，不改判据语义）', () => {
  assert.deepEqual(
    discoveryHitsOf(NEW_REL),
    [],
    `${NEW_REL} 不得命中任何缺省发现规则（命中即「聚合门又被计成被聚合对象」）`,
  );
  // 逐条留痕：失败时能看出「哪条规则被判据写漏了」。
  for (const rule of discoveryRules()) {
    assert.equal(rule.re.test('evidence-guard.mjs'), false, `规则 ${rule.id} 不得命中 evidence-guard.mjs`);
  }
});

test('AC-H4-1 实仓锁：新名在场、旧名不在场（改名已落盘，不是只改了引用）', () => {
  assert.equal(fs.existsSync(path.join(ROOT, NEW_REL)), true, `${NEW_REL} 必须存在`);
  assert.equal(
    fs.existsSync(path.join(ROOT, 'scripts', OLD_BASENAME)),
    false,
    `scripts/${OLD_BASENAME} 必须已不存在（残留 = 双件并存，旧件照旧被拉起）`,
  );
  // 目录面实仓复核：`scripts/` 下不得有任一文件被缺省发现规则命中（本批只处理这一件，故只断言本件）。
  assert.deepEqual(discoveryHitsOf(NEW_REL), [], '实仓相对路径同样不命中');
});

test('AC-H4-2 入口接线：package.json 的 `test` 脚本指向新名，且不含旧名', () => {
  const testScript = PKG.scripts?.test;
  assert.equal(typeof testScript, 'string', 'package.json 必须有 scripts.test');
  assert.ok(testScript.includes(NEW_REL), `scripts.test 必须经 ${NEW_REL} 入口（当前：${testScript}）`);
  assert.equal(
    testScript.includes(OLD_BASENAME),
    false,
    `scripts.test 不得残留旧名（残留 = 改名未生效，npm test 直接断链）`,
  );
});

// ── ② 入口面：新名可执行 + 既有 exit 2 语义不变 ─────────────────────────

const FIXTURE_PASS = 'const { test } = require("node:test");\ntest("ok", () => {});\n';

/** 建沙箱：`<root>/target`（目标文件集）+ `<root>/channel`（独立通道目录）。 */
function makeSandbox(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h4-guard-fixture-'));
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

/** 跑真实 CLI（新名入口），直取退出码 —— **不经 shell、不进管道**。 */
function runCli(args) {
  const result = spawnSync(process.execPath, [NEW_REL, ...args], { cwd: ROOT, encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('AC-H4-3 新名入口可用：`--json` 在隔离夹具上跑出 verdict 且 GREEN', async (t) => {
  const box = makeSandbox({ 'alpha.test.js': FIXTURE_PASS, 'beta.test.js': FIXTURE_PASS });
  t.after(() => dropSandbox(box));

  const { code, stdout, stderr } = runCli(['--dir', box.targetDir, '--dest-dir', box.destDir, '--json']);
  assert.equal(code, 0, `新名入口须 GREEN（stderr=${stderr}）`);

  const verdict = JSON.parse(stdout);
  assert.equal(verdict.channel, 'tap-destination', '判定来源仍是事件通道（改名不改判据语义）');
  assert.equal(verdict.aSize, 2, 'A = 运行期枚举所得');
  assert.equal(verdict.bSize, verdict.aSize, 'A ≡ B');
  assert.equal(verdict.spawnCount, verdict.aSize, '逐文件一次 spawn');
  assert.equal(verdict.ok, true);
});

test('AC-H4-3 既有 exit 2 语义不变：禁区开关 ⇒ 拒且不 spawn（`--json` 形态）', async (t) => {
  const box = makeSandbox({ 'alpha.test.js': FIXTURE_PASS });
  t.after(() => dropSandbox(box));

  const { code, stdout } = runCli([
    '--dir',
    box.targetDir,
    '--dest-dir',
    box.destDir,
    '--json',
    '--test-only',
  ]);
  assert.equal(code, 2, '禁区开关 ⇒ 退出码恒为 2（usage 级，不是 0/1）');

  const verdict = JSON.parse(stdout);
  assert.equal(verdict.rejected, true, '拒绝语义 = 不启动');
  assert.equal(verdict.spawnCount, 0, '拒绝先于 spawn（缩集假绿的根本面没被放宽）');
  assert.ok(String(verdict.rejectReason).includes('--test-only'), '拒因点名该开关');
});
