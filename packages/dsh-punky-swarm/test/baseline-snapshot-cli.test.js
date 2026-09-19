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

// 批次 `engine-hygiene-20260917` · lane hygiene：`scripts/baseline-snapshot.mjs`
// **参数面 fail-closed** 的回归锁。
//
// 为什么需要它（本 lane 的问题陈述）：该脚本首版**无未知参数校验** ⇒ `--help` 被当成无参处理、
// **静默进入重写分支**——既有基线被覆盖、`reason` 落成 `null`，事由留痕被无声洗掉。
// 本用例把三条口径锁成回归线：
//   ① 未知参数 / 非法组合 ⇒ **非零退出 + 用法到 stderr + 绝不重写**；
//   ② `--help` / `-h` ⇒ **零副作用**（不写基线、不改任何文件、exit 0）；
//   ③ **正向对照**——无参 + `--reason "<事由>"` 确实会写盘（证明夹具能观测到重写，
//      否则「文件没变」的断言是空转通过）。
//
// 夹具纪律（硬约束）：夹具一律建在 `os.tmpdir()` 的临时目录内，**运行时拷贝**脚本与共享内核
// （`scripts/baseline-snapshot.mjs` + `scripts/baseline-snapshot-core.mjs`）——**绝不运行仓库真脚本**
// （其扫描根由 `findRepoRoot(脚本所在目录)` 推导，跑真脚本会写到 `<repo>/baselines/test-baseline.json`）。
// 末尾另加一条**仓库真基线护栏**（sha256 未变）作为兜底 tripwire。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SCRIPT_REL = 'scripts/baseline-snapshot.mjs';
const CORE_REL = 'scripts/baseline-snapshot-core.mjs';
const BASELINE_REL = path.join('baselines', 'test-baseline.json');

const sha16 = (buf) => createHash('sha256').update(buf).digest('hex').toUpperCase().slice(0, 16);
const readBaselineText = (tmp) => fs.readFileSync(path.join(tmp, BASELINE_REL), 'utf8');

/** 仓库真基线的启动快照（护栏基线；本文件全程不得改写它）。 */
const REAL_BASELINE_SHA = fs.existsSync(path.join(ROOT, BASELINE_REL))
  ? sha16(fs.readFileSync(path.join(ROOT, BASELINE_REL)))
  : null;

/**
 * 建夹具：`<tmp>/{package.json, scripts/, test/, baselines/}`。
 * `package.json` 是 `findRepoRoot` 的停止锚——**缺它扫描根会向上漂到 `os.tmpdir()`**，
 * 夹具就不再自足（可能扫到宿主机其它目录）。
 */
function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-cli-'));
  fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'test'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'baselines'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'baseline-cli-fixture', version: '0.0.0', type: 'module' }, null, 2) + '\n',
    'utf8',
  );
  fs.copyFileSync(path.join(ROOT, SCRIPT_REL), path.join(tmp, 'scripts', 'baseline-snapshot.mjs'));
  fs.copyFileSync(path.join(ROOT, CORE_REL), path.join(tmp, 'scripts', 'baseline-snapshot-core.mjs'));
  // 夹具测试树：只需能被词法扫描，内容不参与断言
  fs.writeFileSync(
    path.join(tmp, 'test', 'fixture.test.js'),
    ["import test from 'node:test';", "import assert from 'node:assert/strict';", '', "test('fixture', () => {", '  assert.equal(1, 1);', '});', ''].join('\n'),
    'utf8',
  );
  return tmp;
}

/** 跑夹具 CLI（cwd = 夹具根；`node` 取 `process.execPath`，不依赖 PATH）。 */
function runCli(tmp, args) {
  return spawnSync(process.execPath, [path.join(tmp, 'scripts', 'baseline-snapshot.mjs'), ...args], {
    cwd: tmp,
    encoding: 'utf8',
  });
}

/** 夹具自足性/写盘能力的正向铺路：先落一份**带事由**的基线，供后续「未被改写」比对。 */
function seedBaseline(tmp) {
  const seeded = runCli(tmp, ['--reason', 'seed：夹具初版基线']);
  assert.equal(seeded.status, 0, `夹具播种必须成功；stderr=${seeded.stderr}`);
  assert.ok(fs.existsSync(path.join(tmp, BASELINE_REL)), '播种后基线文件在场');
  assert.equal(JSON.parse(readBaselineText(tmp)).reason, 'seed：夹具初版基线', '播种事由已入基线');
}

/** 快照夹具基线的「内容 + mtime」，用于断言**零改写**。 */
function snapshot(tmp) {
  const abs = path.join(tmp, BASELINE_REL);
  return { sha: sha16(fs.readFileSync(abs)), mtimeMs: fs.statSync(abs).mtimeMs, text: fs.readFileSync(abs, 'utf8') };
}

/** 一个夹具内跑一组断言，结束后清理临时目录。 */
function withFixture(fn) {
  const tmp = makeFixture();
  try {
    seedBaseline(tmp);
    fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── 1. 正向对照：写盘分支真的可被观测（防本文件其余断空空转） ────────────
test('cli-1 正向对照：无参 + --reason "<事由>" 写盘成功且事由入库', () => {
  withFixture((tmp) => {
    const before = snapshot(tmp);
    const r = runCli(tmp, ['--reason', '重写事由：本批新增用例']);
    assert.equal(r.status, 0, `写盘模式必须 exit 0；stderr=${r.stderr}`);
    assert.ok(r.stdout.includes('[baseline] 已写入'), '打印写入留痕');
    const after = snapshot(tmp);
    assert.notEqual(after.sha, before.sha, '基线内容确实被重写（本用例是后续「未变」断言的对照）');
    assert.equal(after.mtimeMs >= before.mtimeMs, true, 'mtime 单调前进（重写事实的物理旁证）');
    assert.equal(JSON.parse(after.text).reason, '重写事由：本批新增用例', '事由写入 reason 字段');
  });
});

// ── 2. --help / -h：零副作用 ─────────────────────────────────────────────
for (const flag of ['--help', '-h']) {
  test(`cli-2 零副作用：\`${flag}\` 打印用法、exit 0、基线内容与 mtime 均不变`, () => {
    withFixture((tmp) => {
      const before = snapshot(tmp);
      const r = runCli(tmp, [flag]);
      assert.equal(r.status, 0, `\`${flag}\` 必须 exit 0；stderr=${r.stderr}`);
      assert.equal(r.stderr, '', 'help 不写 stderr');
      assert.ok(r.stdout.includes('用法'), '打印用法到 stdout');
      assert.ok(r.stdout.includes('--check'), '用法含 --check');
      assert.ok(r.stdout.includes('--reason'), '用法含 --reason');
      const after = snapshot(tmp);
      assert.equal(after.sha, before.sha, '**零副作用**：基线内容逐字节不变');
      assert.equal(after.mtimeMs, before.mtimeMs, '**零副作用**：基线 mtime 不变（未发生任何写入）');
      assert.equal(JSON.parse(after.text).reason, 'seed：夹具初版基线', '既有事由留痕未被洗成 null');
    });
  });
}

// ── 3. 未知参数：fail-closed（非零退出 + 用法到 stderr + 绝不重写） ───────
test('cli-3 fail-closed：未知 flag ⇒ 非零退出 + 用法到 stderr + 基线零改写', () => {
  withFixture((tmp) => {
    const before = snapshot(tmp);
    const r = runCli(tmp, ['--no-such-flag']);
    assert.notEqual(r.status, 0, '未知参数必须非零退出');
    assert.equal(r.status, 2, '参数错误取 exit 2（与既有 --check 缺基线同档）');
    assert.equal(r.stdout, '', '拒绝路径不往 stdout 写');
    assert.ok(r.stderr.includes('未知参数'), `stderr 点名未知参数；实际=${r.stderr}`);
    assert.ok(r.stderr.includes('用法'), 'stderr 打印用法（拒绝 + 用法提示，不静默降级）');
    const after = snapshot(tmp);
    assert.equal(after.sha, before.sha, '**绝不进入重写分支**：内容不变');
    assert.equal(after.mtimeMs, before.mtimeMs, '**绝不进入重写分支**：mtime 不变');
    assert.equal(JSON.parse(after.text).reason, 'seed：夹具初版基线', '事由留痕未被静默洗掉');
  });
});

test('cli-4 fail-closed：位置参数（非 flag 形态的杂参）同样拒绝', () => {
  withFixture((tmp) => {
    const before = snapshot(tmp);
    const r = runCli(tmp, ['update']);
    assert.equal(r.status, 2, '位置参数不在白名单 ⇒ 拒');
    assert.ok(r.stderr.includes('未知参数'), 'stderr 说明是未知参数');
    assert.equal(snapshot(tmp).sha, before.sha, '基线不变');
  });
});

// ── 4. 非法参数组合 ─────────────────────────────────────────────────────
test('cli-5 fail-closed：`--check --reason "…"` 组合非法（无覆盖动作可记事由）', () => {
  withFixture((tmp) => {
    const before = snapshot(tmp);
    const r = runCli(tmp, ['--check', '--reason', '不该被接受']);
    assert.equal(r.status, 2, '组合非法 ⇒ exit 2');
    assert.ok(r.stderr.includes('--check'), 'stderr 点名冲突参数');
    assert.equal(snapshot(tmp).sha, before.sha, '--check 不写盘，拒绝时更不写盘');
  });
});

test('cli-6 fail-closed：`--reason` 缺值 ⇒ 拒绝（不得把下一个 flag 吃成事由）', () => {
  withFixture((tmp) => {
    const before = snapshot(tmp);
    const r = runCli(tmp, ['--reason', '--check']);
    assert.equal(r.status, 2, '缺事由 ⇒ exit 2');
    assert.ok(r.stderr.includes('--reason'), 'stderr 点名 --reason');
    assert.equal(snapshot(tmp).sha, before.sha, '基线不变');
  });
});

test('cli-7 fail-closed：`--reason ""` 空事由 ⇒ 拒绝（空事由等于静默更新）', () => {
  withFixture((tmp) => {
    const before = snapshot(tmp);
    const r = runCli(tmp, ['--reason', '   ']);
    assert.equal(r.status, 2, '空事由 ⇒ exit 2');
    assert.ok(r.stderr.includes('事由'), 'stderr 说明事由面问题');
    assert.equal(snapshot(tmp).sha, before.sha, '基线不变');
    assert.equal(JSON.parse(snapshot(tmp).text).reason, 'seed：夹具初版基线', '既有事由未被空值覆盖');
  });
});

// ── 5. 仓库真基线护栏（tripwire）：本文件全程不得触碰真基线 ──────────────
test('cli-8 护栏：仓库 `baselines/test-baseline.json` 全程未被本用例改写', () => {
  assert.notEqual(REAL_BASELINE_SHA, null, '仓库基线必须已入库（缺则本护栏失去对象）');
  const now = sha16(fs.readFileSync(path.join(ROOT, BASELINE_REL)));
  assert.equal(now, REAL_BASELINE_SHA, '真基线 sha256 与本用例启动时一致（夹具隔离生效）');
});
