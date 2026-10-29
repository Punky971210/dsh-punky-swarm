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

// 批 `punky-g2-tail-2026-10-30` · lane `t1-test`（tester）—— **T-1 / T-2 测试侧验收**：
//   · T-1：`harden` 从对外签名移除（传了即抛）＋ 生产态四条加固全开 ＋ 环境闩双条件；
//   · T-2：`--break=fN` 逐探针隔离（**失败集合相等**，不看退出码）＋ 归属不串。
//
// 判据源 = `plan/p1-pack.md` §2.1（T-1 H-1…H-5）／§2.2（T-2 可判形态）／§2.6（耦合）＋
//   `## 验收标准`：AC-2（拒态）/ AC-3（生产态全开）/ AC-4（闩两态 + 未知 flag）/ AC-5（隔离四态）/ AC-6（归属不串）。
//
// 写法纪律（C-12）：**禁数量断言** —— 隔离性用**失败集合相等**（`{F-N}` 集合式），T-4 的「1」是**定义位存在性**。
//   退出码**不作**隔离判据（`--break` 两分支都 exit 1，无法区分「复现」与「污染」，见包 §2.2 表注）。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBus } from '../lib/bus/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');

/** 跑 selftest 并返回 { status, stdout, failures:Set, isolationLine } —— **只解析输出，不据退出码判隔离**。 */
function runSelftest(args = []) {
  const r = spawnSync(process.execPath, ['lib/bus/selftest.mjs', ...args], { cwd: PKG_ROOT, encoding: 'utf8' });
  const out = r.stdout ?? '';
  const failures = new Set();
  for (const line of out.split(/\r?\n/)) {
    const m = /^FAIL\s+(F-\d+)/.exec(line.trim());
    if (m) failures.add(m[1]);
  }
  const isolationLine = out.split(/\r?\n/).find((l) => l.includes('ISOLATION:')) ?? '';
  return { status: r.status, out, failures, isolationLine };
}

/** 在临时 env 闩下求值（**调用前后还原**，不污染其它用例）。 */
function withHardenEnv(env, fn) {
  const keys = ['PUNKY_TEST_HARDEN', 'PUNKY_TEST_HARDEN_FLAGS'];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) {
    if (k in env && env[k] !== undefined) process.env[k] = env[k];
    else delete process.env[k];
  }
  try { return fn(); } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
}

// ── T-1 / AC-2：对外签名不承载 `harden`；**传了即抛**（不得静默忽略、不得静默生效）──────────────
test('T1-a AC-2 拒态：createBus({ harden }) ⇒ 抛普通 Error（非 GATE_ / 无 code / 消息点名 harden 与测试缝）', () => {
  let err = null;
  try { createBus({ harden: { f2: false } }); } catch (e) { err = e; }

  assert.ok(err, '对外传 `harden` 必须抛错（静默忽略 = 换位置重开的静默降级，正是 T-1 要消除的）');
  assert.ok(err instanceof Error, '必须是 Error 实例');
  assert.equal(err.code, undefined, '不得设置 err.code');
  const msg = String(err.message ?? '');
  assert.equal(msg.startsWith('GATE_'), false, '禁 GATE_ 前缀');
  assert.equal(/GATE_/.test(msg), false, '消息任意位置不得出现 GATE_');
  assert.ok(msg.includes('harden'), '消息须点名该参数 `harden`；实际=' + msg);
  assert.ok(msg.includes('PUNKY_TEST_HARDEN'), '消息须指出**测试缝**名（PUNKY_TEST_HARDEN）；实际=' + msg);
});

// ── T-1 / AC-3：生产态（无任何 env）四条加固**全开** —— 逐条以「缺陷不复现」取证 ─────────────────
test('T1-b AC-3 生产态全开：无 env ⇒ of() 非 null、missing 非空、空证据不判 advanced、出口为归一对象', async () => {
  const prevLatch = process.env.PUNKY_TEST_HARDEN;
  const prevFlags = process.env.PUNKY_TEST_HARDEN_FLAGS;
  // 前置：本用例运行期**不得**残留闩（否则测的是被关断态）
  delete process.env.PUNKY_TEST_HARDEN;
  delete process.env.PUNKY_TEST_HARDEN_FLAGS;
  try {
    const bus = createBus({
      ports: { runtime: { start: () => ({ writes: [], evidence: [] }) }, audit: { emit: () => null } },
    });
    // F-1 面：可选端口缺失时取件仍返回可调用实现（不是裸 null）
    assert.equal(bus.of('tools') != null, true, 'AC-3：生产态 F-1 加固须生效（可选端口不得给裸 null）');
    // F-2 面：降级可见
    assert.ok(bus.report().missing.length >= 1, 'AC-3：生产态 F-2 加固须生效（missing 不得为空）');
    // F-4 面：空证据不谎报
    assert.equal(bus.classifyProgress({ writes: [], evidence: [] }), 'empty_response', 'AC-3：生产态 F-4 加固须生效');
    // F-3 面：出口为归一对象（三集合键在场、非裸数组）
    const routed = await bus.route('coder');
    assert.equal(Array.isArray(routed), false, 'AC-3：生产态 route() 出口须为归一对象（不得退化裸数组）');
    for (const key of ['matched', 'builtinOnly', 'hostOnly']) {
      assert.ok(Array.isArray(routed.view[key]), 'AC-3：归一出口须含三集合键 ' + key);
    }
  } finally {
    if (prevLatch !== undefined) process.env.PUNKY_TEST_HARDEN = prevLatch;
    if (prevFlags !== undefined) process.env.PUNKY_TEST_HARDEN_FLAGS = prevFlags;
  }
});

// ── T-1 / AC-4：环境闩**双条件** —— 非 '1' 时 FLAGS 完全忽略；'1' 时只关列出的那条；未知 flag 抛 ──
test('T1-c AC-4 闩双条件：PUNKY_TEST_HARDEN≠1 ⇒ FLAGS 被完全忽略（不半生效）；=1 ⇒ 只关列出的；未知 flag 抛错', () => {
  const missingUnder = (env) => withHardenEnv(env, () => createBus({ ports: {} }).report().missing);

  // ① 闩关闭（不存在）⇒ 即使 FLAGS 写了 f2，也**完全忽略** ⇒ missing 仍非空（F-2 加固未被关断）
  assert.ok(missingUnder({ PUNKY_TEST_HARDEN_FLAGS: 'f2' }).length >= 1,
    'AC-4：PUNKY_TEST_HARDEN 不存在时 FLAGS 必须被完全忽略（半生效 = 违规）');
  // ② 闩为非 '1' 的其它值 ⇒ 同样忽略（不是「非空即生效」）
  assert.ok(missingUnder({ PUNKY_TEST_HARDEN: '0', PUNKY_TEST_HARDEN_FLAGS: 'f2' }).length >= 1,
    'AC-4：PUNKY_TEST_HARDEN 非恰 "1"（此处 "0"）时 FLAGS 必须被完全忽略');
  // ③ 闩开启且 FLAGS=f2 ⇒ 只关 f2 ⇒ missing 变空（且其它三条仍生效由 T1-b 覆盖）
  assert.deepEqual(missingUnder({ PUNKY_TEST_HARDEN: '1', PUNKY_TEST_HARDEN_FLAGS: 'f2' }), [],
    'AC-4：闩开启且只列 f2 ⇒ 仅 F-2 被关断（missing 投影为空）');
  // ④ 未知 flag ⇒ 抛错（不得静默忽略）
  let err = null;
  try { missingUnder({ PUNKY_TEST_HARDEN: '1', PUNKY_TEST_HARDEN_FLAGS: 'f9' }); } catch (e) { err = e; }
  assert.ok(err, 'AC-4：未知 flag 必须抛错');
  assert.ok(/unknown flag/.test(String(err.message)), 'AC-4：消息须指出 unknown flag；实际=' + String(err.message));
  assert.equal(String(err.message).startsWith('GATE_'), false, 'AC-4：禁 GATE_ 前缀');
});

// ── T-2 / AC-5：`--break=fN` 四态隔离 —— **失败集合恰 = {F-N}**，且输出含 `ISOLATION: ok` ────────
test('T2-a AC-5 隔离四态：--break=f1..f4 各自失败集合恰为单元素 {F-N} 且 ISOLATION: ok（不看退出码）', () => {
  for (const n of [1, 2, 3, 4]) {
    const run = runSelftest(['--break=f' + n]);
    assert.deepEqual(
      [...run.failures].sort(),
      ['F-' + n],
      'AC-5：--break=f' + n + ' 的失败集合必须**恰**为 {F-' + n + '}（集合相等，非计数）；实际=' + JSON.stringify([...run.failures]),
    );
    assert.ok(run.isolationLine.includes('ISOLATION: ok'),
      'AC-5：--break=f' + n + ' 输出须含 `ISOLATION: ok`；实际行=' + JSON.stringify(run.isolationLine));
  }
});

// ── T-2 / AC-6：归属不串 —— `--break=f1` 时 F-3 的结论与无 break 时**相同** ────────────────────────
test('T2-b AC-6 归属不串：--break=f1 时 F-3 不得被连带判红（结论与无 break 一致），且无「探针异常」串记', () => {
  const baseline = runSelftest([]);              // 无 break：全绿
  const broken = runSelftest(['--break=f1']);    // 只关 f1

  assert.equal(baseline.failures.size, 0, '基线（无 break）应全绿；实际失败集合=' + JSON.stringify([...baseline.failures]));
  assert.equal(broken.failures.has('F-3'), false,
    'AC-6：--break=f1 时 F-3 **不得**被连带判红（归属不串）；实际失败集合=' + JSON.stringify([...broken.failures]));
  assert.equal(broken.failures.has('F-1'), true, 'AC-6：--break=f1 时 F-1 必须红（缺陷已复现）');
  // 「探针异常」若出现，必须归触发它的那条 —— 本批实测不应出现串记
  const anomalyLines = broken.out.split(/\r?\n/).filter((l) => /探针异常/.test(l));
  assert.deepEqual(anomalyLines, [], 'AC-6：--break=f1 时不应出现任何「探针异常」（原缺陷会把它串记到 F-3）\n实际：\n' + anomalyLines.join('\n'));
});
