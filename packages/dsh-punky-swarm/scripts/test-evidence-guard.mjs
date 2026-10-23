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

// 测试证据自证闸门（test evidence guard）。
//
// 存在理由：「测试通过」现判据是整条命令链的**退出码**，而运行器只报「**执行到的**测试」有无失败
//   ⇒ 缩小执行集（选集 / 分片开关）仍然得到 0 退出码 = **假绿**。本闸门把「测试是否真跑全」变成可机检不变式。
//
// 本件实现的三条不变式：
//   ① 目标文件集合 A ≡ 逐文件完成事件集合 B（**双向**），且 |A| > 0（防空跑假绿）；
//   ⑤ spawn **之前**拒绝四个选集 / 分片开关（拒绝语义 = **不启动**，不是运行时报错）；
//   ⑥ 负向裁决与正向裁决**同口径**（同一 verdict 函数、同一事件通道）。
//
// 反伪造的物理基础（**不是约定，是实测的通道物理**，见本 lane progress 01 §4）：
//   spawn 测试运行器时给 `--test-reporter=tap --test-reporter-destination=<私有目录>/<文件>.tap`：
//     a) 运行器 stdout **恰好为空** —— TAP 内容根本不在 stdout 通道上；
//     b) 用例自身的 console.log **逐行被加 `# ` 前缀**，行内首个 `#` 再被转义为 `\#`
//        ⇒ 子进程 stdout **无法**产出列首的 `# Subtest: ` 或 `ok N - ` 行；
//     c) 因此判定侧只接受**列首**结构性行，stdout 一律不采集（stdio 全 ignore）。
//   ⇒ 「签名只匹配事件通道」落成了**手段**：判定侧连 stdout 的字节都拿不到。
//
// 逐文件「完成事件」的口径（实测支撑，见 progress 01 §4 F-2/F-4）：
//   TAP 流是**扁平**的（顶层 subtest = 用例名，文件边界不进流）⇒ 单次聚合跑无法给出逐文件事件；
//   故本闸门**逐文件一次 spawn、每文件一个独立 destination**：该文件是否产出完成事件，
//   等价于「它自己的独立通道上有没有 TAP 计划行 `1..N`」。
//   另：文件**未跑完即退出**时，运行器会把**文件本身**当作一条用例上报（subtest 名 = 文件路径）
//   ⇒ 「路径名 subtest」= 用例未被逐条上报 ⇒ **不计入完成事件集**（堵住「早退被读成 pass」的假绿）。
//
// 计数纪律：A / B 两侧**一律运行期计算**，本件**不写任何期望文件数**。实测数会随批次合法增减，
//   写死期望值必致「幻影缺口 ⇒ 假红」（本批上游摸底计数即已证明有误，见 impl-spec §4 D-1）。
//
// 退出码：0 = GREEN；1 = 有缺口 / 有用例失败；2 = 命中四开关被拒（usage 级，未 spawn）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const GUARD_TAG = '[test-evidence-guard]';
const PRELOAD_REL = 'test/helpers/isolated-home.preload.mjs';
const DEFAULT_TARGET_DIR = 'test';
const DEFAULT_CONCURRENCY = 8;
const TEST_FILE_SUFFIX = '.test.js';
const TAP_DEST_SUFFIX = '.tap';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 判定来源通道的唯一取值（读数用；证明结论来自事件通道而非 stdout）。 */
export const TAP_CHANNEL = 'tap-destination';

/** ⑤ 四个选集 / 分片开关（spawn 前拒绝）。 */
export const FORBIDDEN_SWITCHES = Object.freeze([
  '--test-only',
  '--test-name-pattern',
  '--test-skip-pattern',
  '--test-shard',
]);

// ── ⑤ spawn 前的**承载通道**扫描（argv + NODE_OPTIONS）────────────────────

/**
 * 扫描候选 argv，返回命中的禁区开关。
 * 两种承载形态都算命中：`--test-only`（独立 token）与 `--test-name-pattern=<值>`（等号形态）——
 * 只做等值匹配会漏掉等号形态，那是可被绕过的假拒绝。
 * @param {string[]} argv
 * @returns {{arg: string, switch: string}[]}
 */
export function findForbiddenSwitches(argv) {
  const hits = [];
  for (const raw of argv ?? []) {
    const arg = String(raw);
    for (const sw of FORBIDDEN_SWITCHES) {
      if (arg === sw || arg.startsWith(sw + '=')) hits.push({ arg, switch: sw });
    }
  }
  return hits;
}

/**
 * 剥**成对**的双引号（只剥首尾**恰好成对**的那一对）。
 *
 * 存在理由（镜像 Node 对 `NODE_OPTIONS` 的解析，实测边界）：
 *   - **双引号**：Node **会剥** ⇒ `NODE_OPTIONS='"--test-shard=2/2"'` **照样缩集**（实测 `# tests 0`）。
 *     若不剥，该 token 不以 `--` 开头 ⇒ ⑤ 不命中 ⇒ **「拒 = 不启动」被绕过**（缺陷 T3GV-D-01）。
 *   - **单引号**：Node **不剥** ⇒ `NODE_OPTIONS="'--test-shard=2/2'"` **不缩集**（实测 `# tests 1`）
 *     ⇒ 本函数**不得**剥单引号：那会把 Node 根本不认的内容判成禁区 ⇒ **误拒合法内容**。
 *   - **引号内含空格**：Node **直接拒收**（实测 `exit=9`）⇒ 无需处理该形态。
 *   - **tab / newline**：Node 拒收（不当分隔符），而本文件的 `\s+` 更宽 ⇒ **只会多拒、不会漏拒**。
 * @param {string} token
 */
export function stripPairedDoubleQuotes(token) {
  return token.length >= 2 && token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token;
}

/**
 * 把 `NODE_OPTIONS` 按**词边界**切成 token，并把每个 token 归一到 Node 实际会看到的值
 * （剥成对双引号，见 `stripPairedDoubleQuotes`）。
 * 用途单一：让命中判定落在**整词**上，而不是子串上 —— 且落在**Node 真会解析的那个词**上。
 */
export function splitNodeOptions(raw) {
  return String(raw ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map(stripPairedDoubleQuotes);
}

/**
 * ⑤ 的**第二承载通道**扫描：`NODE_OPTIONS`。
 * 实测（`exec/t2-guard-verify.md` 族 11 + 本 lane 独立复现）：四个禁区开关**全部**能被 Node
 * 经该变量接受 ⇒ 只扫 argv 会被绕过：`NODE_OPTIONS=--test-shard=2/2` 下子运行器被分片跳过，
 * 通道只剩 `1..0` / `# tests 0` / 0 条 subtest，而退出码仍为 0 ⇒ 零用例判绿、**真失败被隐藏**。
 *
 * ⚠ **可用性限界（本通道的取舍，须与实现同处可见）**：**只**拒四个禁区开关，
 * 其余 `NODE_OPTIONS` 内容（如 `--max-old-space-size=4096`）**一律放行并原样传给子进程** ——
 * 否则宿主正常使用 `NODE_OPTIONS` 会被本闸门恒拒。判定用整词匹配（见 `splitNodeOptions`），
 * 不作子串匹配，故与禁区开关**前缀相近的合法项**不会被误拒。
 *
 * 何以「拒绝」而非「静默剔除该变量」：静默剔除会让 env 承载的开关**无声失效**，
 * 使用者无从得知自己的 env 被剥离 —— 那恰是本批立意（消除静默）要消除的形态；
 * 拒绝则响亮、可观测，且贴合 ⑤「拒 = 不启动」的语义。
 */
export function findForbiddenSwitchesInNodeOptions(raw) {
  return findForbiddenSwitches(splitNodeOptions(raw));
}

/**
 * 拒绝原因渲染（**单一渲染点**）：argv 面与 `NODE_OPTIONS` 面**同形**，
 * 只在命中项上标注承载通道，便于判读「是哪条通道进来的」。
 */
export function renderForbiddenReason(hits) {
  return (
    '禁区开关被拒（spawn 前）：' +
    hits.map((h) => h.switch + '  ← ' + h.arg + '（来自 ' + h.channel + '）').join('；') +
    '　—— 选集 / 分片会缩小执行集而让退出码仍为 0（假绿），故不启动。'
  );
}

// ── 目标文件集合 A（运行期枚举） ────────────────────────────────────────

/**
 * 运行期枚举目标文件集合 A：`<dir>` 下的 `*.test.js`（**非递归**，与「目标文件」口径一致）。
 * 不写任何期望数量：返回什么就是什么。
 * @param {string} dir 绝对路径
 * @returns {string[]} 文件绝对路径（已排序，稳定读数）
 */
export function listTargetFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(TEST_FILE_SUFFIX))
    .map((entry) => path.join(dir, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

// ── 事件通道解析（只读列首结构性行） ─────────────────────────────────────

const RE_TOP_SUBTEST = /^# Subtest: (.+)$/;
const RE_RESULT = /^(?:ok|not ok) \d+ - /;
const RE_PLAN = /^1\.\.(\d+)$/;
const RE_SUMMARY = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/;

/** 顶层 subtest 名是否形如「文件路径」（= 运行器把文件本身当作一条用例上报）。 */
function looksLikePath(name) {
  return /[\\/]/.test(name) && name.endsWith(TEST_FILE_SUFFIX);
}

/**
 * 解析**独立 destination** 上的 TAP 文本。
 * 只接受列首结构性行：`# Subtest: `（`# ` 后不得为转义符 `\`）、`ok/not ok N - `、`1..N`、`# <摘要> N`。
 * 被转义过的用例 stdout（`# \# Subtest: …` / `# ok N - …`）在词法上就匹配不上——这是物理保证。
 * @param {string} text
 */
export function parseTapChannel(text) {
  const parsed = {
    hasPlan: false,
    plan: null,
    topSubtests: [],
    fileRootSubtests: [],
    resultLines: 0,
    summary: { tests: null, pass: null, fail: null, cancelled: null, skipped: null, todo: null },
  };
  for (const line of String(text ?? '').split('\n')) {
    const sub = RE_TOP_SUBTEST.exec(line);
    if (sub) {
      const name = sub[1];
      parsed.topSubtests.push(name);
      if (looksLikePath(name)) parsed.fileRootSubtests.push(name);
      continue;
    }
    if (RE_RESULT.test(line)) {
      parsed.resultLines += 1;
      continue;
    }
    const plan = RE_PLAN.exec(line);
    if (plan) {
      parsed.hasPlan = true;
      parsed.plan = Number(plan[1]);
      continue;
    }
    const sum = RE_SUMMARY.exec(line);
    if (sum) parsed.summary[sum[1]] = Number(sum[2]);
  }
  return parsed;
}

/**
 * 逐文件裁定 outcome（**唯一分类点**：正向与负向路径共用）。
 *   passed     —— 有完成事件、无失败、用例被逐条上报；
 *   failed     —— 有完成事件、有失败（真失败）；
 *   incomplete —— **无完成事件**：缺计划行，或文件被当作单条用例上报（早退 / 挂起后退出），
 *                 或**计划行为 `1..0`（零用例被上报）**。
 *                 ⚠ 这一态正是「进程早退冒充预期失败 / 冒充通过」的判别位。
 *
 * ⚠ `plan === 0` 那一条是本批加固（缺陷 T2GV-D-01 的「因 B」）：分片跳过 / 掏空到零用例时，
 *   通道形态恰为 `1..0` + `# tests 0` + `# pass 0` + 0 条 subtest —— 若无此条会落进 `passed`，
 *   「零用例完成事件」便静默计入集合 B 而判绿。**加固只新增条件，既有两个分支的次序与语义未动**
 *   （「路径名 subtest ⇒ incomplete」是已被独立验证正确的护栏，不得借机重构）。
 * @returns {'passed'|'failed'|'incomplete'}
 */
export function classifyOutcome(parsed) {
  if (!parsed.hasPlan) return 'incomplete';
  if (parsed.fileRootSubtests.length > 0) return (parsed.summary.fail ?? 0) > 0 ? 'failed' : 'incomplete';
  return (parsed.summary.fail ?? 0) > 0 ? 'failed' : parsed.plan === 0 ? 'incomplete' : 'passed';
}

// ── 求和自检（S1 / S2：机读字段，**不参与 ok**）──────────────────────────────

/**
 * 求和自检：把「汇总数 ⇔ 明细数」互相可复算这件事从**打印出来的一句话**升级为**机读字段**。
 *
 * 两条恒等式：
 *   S1 `Σ files[].tests === totals.tests`                     —— 明细 ⇔ 汇总（双向可复算）
 *   S2 `tests === pass + fail + skipped + cancelled + todo`   —— 汇总内部算术自洽
 *
 * ⚠ **不参与 `ok`、不改退出码**：承既有裁决（把算术自洽做成硬门 = 新增判据，须单独裁决）。
 *   本函数只负责「让它可被机读断言」，不负责「用它判红绿」。
 * @param {object[]} files   `files[]` 投影
 * @param {object} totals    汇总列
 */
export function decideSelfCheck(files, totals) {
  const sumFilesTests = (files ?? []).reduce((acc, item) => acc + (item.tests ?? 0), 0);
  const sumParts =
    (totals?.pass ?? 0) +
    (totals?.fail ?? 0) +
    (totals?.skipped ?? 0) +
    (totals?.cancelled ?? 0) +
    (totals?.todo ?? 0);
  const totalsTests = totals?.tests ?? 0;

  const s1 = {
    ok: sumFilesTests === totalsTests,
    formula: 'Σ files[].tests === totals.tests',
    sumFilesTests,
    totalsTests,
  };
  const s2 = {
    ok: totalsTests === sumParts,
    formula: 'tests === pass + fail + skipped + cancelled + todo',
    sum: sumParts,
    totalsTests,
  };

  const reasons = [];
  if (!s1.ok) {
    reasons.push(
      'S1 不成立：Σ files[].tests=' + sumFilesTests + ' ≠ totals.tests=' + totalsTests + '（明细与汇总互相矛盾）',
    );
  }
  if (!s2.ok) {
    reasons.push('S2 不成立：tests=' + totalsTests + ' ≠ 五分量之和=' + sumParts + '（汇总内部算术不自洽）');
  }

  return {
    ok: s1.ok && s2.ok,
    detail: reasons.length > 0
      ? reasons.join('；')
      : 'S1/S2 均成立（Σfiles.tests=' + sumFilesTests + '，tests=' + totalsTests + '，五分量之和=' + sumParts + '）',
    s1,
    s2,
    reasons,
  };
}

// ── 唯一 verdict 函数 ───────────────────────────────────────────────────

/**
 * 由「目标文件集合 + 逐文件通道读数 + 越界通道」裁定结论。
 * **正向路径与负向路径经此同一函数** —— 变⑥「同口径」的实现点。
 * @param {object} input
 * @param {boolean} [input.rejected]          ⑤ 是否在 spawn 前被拒
 * @param {string|null} [input.rejectReason]
 * @param {string[]} [input.targetFiles]      集合 A（绝对路径）
 * @param {object[]} [input.records]          逐文件通道读数
 * @param {string[]} [input.strayDestinations] 越界完成事件（destination 在册但无对应目标文件）
 * @param {number} [input.spawnCount]
 */
export function decideVerdict(input) {
  const {
    rejected = false,
    rejectReason = null,
    targetFiles = [],
    records = [],
    strayDestinations = [],
    spawnCount = 0,
  } = input ?? {};

  const reasons = [];
  const aSize = targetFiles.length;

  // 集合 B = 有完成事件的**文件**（passed / failed 都算「跑到了」；incomplete 不算）。
  const bFiles = new Set();
  for (const record of records) {
    if (record.outcome === 'passed' || record.outcome === 'failed') bFiles.add(record.file);
  }
  for (const stray of strayDestinations) bFiles.add(stray);

  const aFiles = new Set(targetFiles);
  const missingInB = targetFiles.filter((file) => !bFiles.has(file));
  const extraInB = [...bFiles].filter((file) => !aFiles.has(file)).sort((a, b) => a.localeCompare(b));

  const failedFiles = records.filter((r) => r.outcome === 'failed').map((r) => r.file);
  const incompleteFiles = records
    .filter((r) => r.outcome !== 'passed' && r.outcome !== 'failed')
    .map((r) => r.file);

  if (rejected) reasons.push('rejected-before-spawn: ' + String(rejectReason ?? '未给原因'));
  if (aSize === 0) reasons.push('empty-target-set: 目标文件集合为空（|A| > 0 不成立）');
  if (missingInB.length > 0) reasons.push('missing-completion-events: ' + missingInB.length);
  if (extraInB.length > 0) reasons.push('stray-completion-events: ' + extraInB.length);
  if (failedFiles.length > 0) reasons.push('tests-failed: ' + failedFiles.length);
  if (incompleteFiles.length > 0) reasons.push('incomplete-completion-events: ' + incompleteFiles.length);

  const ok =
    !rejected &&
    aSize > 0 &&
    missingInB.length === 0 &&
    extraInB.length === 0 &&
    failedFiles.length === 0 &&
    incompleteFiles.length === 0;

  // 汇总列：`skipped` 与 TAP 摘要同名（`RE_SUMMARY` 已解析），`cancelled` 只为让
  //   `tests = pass + fail + skipped + cancelled + todo` 这条恒等式**可判**（不参与 ok）。
  const totals = records.reduce(
    (acc, r) => ({
      tests: acc.tests + (r.tests ?? 0),
      pass: acc.pass + (r.pass ?? 0),
      fail: acc.fail + (r.fail ?? 0),
      skipped: acc.skipped + (r.skipped ?? 0),
      cancelled: acc.cancelled + (r.cancelled ?? 0),
      todo: acc.todo + (r.todo ?? 0),
    }),
    { tests: 0, pass: 0, fail: 0, skipped: 0, cancelled: 0, todo: 0 },
  );

  // 逐文件投影：`todo` 与 `cancelled` 都进 `files[]`（与 `totals` **对称**）。
  //   此前只有汇总有 `todo`、`cancelled` 更只在汇总侧 ⇒ 恒等式只能从 `totals` 内部自证，
  //   **无法用「逐文件求和」复核**。`?? 0` 与 per-file record 的归一
  //   （`parsed.summary.<key> ?? 0`）同口径 ⇒ `Σ files[].tests === totals.tests`（S1）成立，
  //   且**双向可复算**：由明细求和算得汇总，与实测汇总相等。
  const files = records.map((r) => ({
    file: r.file,
    outcome: r.outcome,
    exitCode: r.exitCode,
    tapPath: r.tapPath,
    plan: r.plan,
    tests: r.tests,
    pass: r.pass,
    fail: r.fail,
    skipped: r.skipped,
    cancelled: r.cancelled ?? 0,
    todo: r.todo ?? 0,
    fileRootSubtest: r.fileRootSubtest,
  }));

  // S1/S2 机读自检：**只出字段与打印面，不参与 ok、不改退出码**
  //   （承既有裁决：做成硬门 = 新增判据，须单独裁决 —— 见规格 §待裁决 Q-2）。
  const selfCheck = decideSelfCheck(files, totals);

  return {
    ok,
    rejected,
    rejectReason,
    aSize,
    bSize: bFiles.size,
    missingInB,
    extraInB,
    spawnCount,
    channel: TAP_CHANNEL,
    failedFiles,
    incompleteFiles,
    totals,
    selfCheck,
    reasons,
    files,
  };
}

// ── spawn（物理分离的实现点）─────────────────────────────────────────────

/**
 * 运行器命令行：与 `npm test` 原命令**同形**（同一 preload、同一运行器），
 * 只额外把 reporter 输出重定向到该文件**自己的**独立 destination。
 */
export function buildRunnerArgs(file, destination, preload) {
  return [
    ...(preload ? ['--import', preload] : []),
    '--test',
    '--test-reporter=tap',
    '--test-reporter-destination=' + destination,
    file,
  ];
}

/**
 * 子进程环境（**环境侧的两处反退化**）。
 *
 * ① `NODE_TEST_CONTEXT`：Node 运行器给「测试子进程」打的标记，会随环境继承下来，
 *    使我们拉起的运行器**静默退化**：不写 destination、不产 TAP，而退出码仍为 0（实测，见 progress 02）。
 *    那种形态下「零完成事件」会被误读，且正是本闸门要堵的「假绿」类缺陷。
 *
 * ② 隔离根的**父子交接变量**：本闸门是**逐文件一次 spawn**，其语义单位 = 「一次运行」，
 *    故每个运行器都应拿到**自己的**隔离根。若沿用父进程传下来的同一个根，多个子进程会并发
 *    写读同一份隔离标记文件，落败者会被隔离前置判定中断（`process.exit(1)`）⇒ 子进程死亡 ⇒ **假红**
 *    （实测：共享根下并发 4 文件即有 1 个死亡；各建其根连跑 3 轮全绿）。
 *    ⇒ 剔除交接变量，由 preload 自行派生**逐运行器**的根（其默认行为，含退出清理）。
 *
 * ⚠ **`NODE_OPTIONS` 刻意不在此处剔除**：承载在 env 上的禁区开关走 ⑤ 的**响亮拒绝**路径
 *   （`findForbiddenSwitchesInNodeOptions`），而不是在这里静默剥离 —— 静默剥离会让使用者
 *   无从得知自己的 env 被改写，正是本批立意（消除静默）要消除的形态。其余内容一律原样传递。
 *
 * @param {NodeJS.ProcessEnv} [baseEnv]
 */
export function buildRunnerEnv(baseEnv) {
  const env = { ...(baseEnv ?? process.env) };
  delete env.NODE_TEST_CONTEXT;
  delete env.PUNKY_TEST_ISOLATED_HOME;
  delete env.PUNKY_TEST_ISOLATED_DSH_HOME;
  return env;
}

/**
 * spawn 选项（**物理分离的第二半**）：三个标准流全部 `ignore` ——
 * 判定侧连 stdout 的字节都拿不到，而不是「拿到了但约定不看」。
 */
export function buildRunnerSpawnOptions(cwd, env) {
  return { cwd, env: buildRunnerEnv(env), stdio: ['ignore', 'ignore', 'ignore'] };
}

function runOneFile(file, options) {
  const destination = path.join(options.destDir, path.basename(file) + TAP_DEST_SUFFIX);
  const args = buildRunnerArgs(file, destination, options.preload);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, buildRunnerSpawnOptions(options.cwd, options.env));
    child.on('error', (error) => {
      resolve({ file, tapPath: destination, exitCode: null, spawnError: String(error?.message ?? error) });
    });
    child.on('close', (code) => {
      resolve({ file, tapPath: destination, exitCode: code });
    });
  });
}

/** 有界并发池（保持与原 `--test` 多文件并行的同序语义，但不引入新的串行化）。 */
async function runBoundedPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}

// ── 门面：同一入口供 CLI 与单测使用 ──────────────────────────────────────

/**
 * 跑一轮闸门并给出 verdict。
 * ⑤ 的拒绝**先于枚举与 spawn**：命中四开关时 `spawnCount === 0`。
 * @param {object} [options]
 * @param {string} [options.root]        仓根（缺省 = 本文件所在仓）
 * @param {string} [options.dir]         目标文件目录（相对仓根或绝对）
 * @param {string} [options.destDir]     独立通道目录（缺省 = 私有临时目录）
 * @param {number} [options.concurrency]
 * @param {string[]} [options.argv]      候选 argv（缺省 = 真实 argv；单测注入用）
 * @param {NodeJS.ProcessEnv} [options.env] 环境真源（缺省 = 真实 env；单测注入用）
 * @param {boolean} [options.rejectOnly] 仅做 ⑤ 判定（不枚举、不 spawn）
 */
export async function runGuard(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;

  // ⑤ 两条承载通道一并扫描、**同形拒绝**：argv（命令直传）与 NODE_OPTIONS（env 继承）。
  const forbidden = [
    ...findForbiddenSwitches(argv).map((hit) => ({ ...hit, channel: 'argv' })),
    ...findForbiddenSwitchesInNodeOptions(env.NODE_OPTIONS).map((hit) => ({ ...hit, channel: 'NODE_OPTIONS' })),
  ];

  if (forbidden.length > 0) {
    return decideVerdict({
      rejected: true,
      rejectReason: renderForbiddenReason(forbidden),
      targetFiles: [],
      records: [],
      strayDestinations: [],
      spawnCount: 0,
    });
  }
  if (options.rejectOnly) {
    return decideVerdict({ targetFiles: [], records: [], spawnCount: 0 });
  }

  const targetDir = path.isAbsolute(options.dir ?? '')
    ? options.dir
    : path.resolve(root, options.dir ?? DEFAULT_TARGET_DIR);
  const targetFiles = listTargetFiles(targetDir);

  const preloadAbs = path.join(root, PRELOAD_REL);
  // `--import` 收的是 **ESM 说明符**：Windows 盘符绝对路径不是合法说明符
  // （实测 `ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'd:'`），故一律转 `file://` URL。
  const preload = fs.existsSync(preloadAbs) ? pathToFileURL(preloadAbs).href : null;
  const destDir = options.destDir
    ? path.resolve(options.destDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'punky-test-evidence-'));
  fs.mkdirSync(destDir, { recursive: true });

  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const raw = await runBoundedPool(targetFiles, concurrency, (file, index) =>
    runOneFile(file, { destDir, preload, cwd: root, index, env }),
  );

  const records = raw.map((entry) => {
    let text = '';
    let channelState = 'read';
    try {
      if (!fs.existsSync(entry.tapPath)) channelState = 'destination-missing';
      else text = fs.readFileSync(entry.tapPath, 'utf8');
    } catch (error) {
      channelState = 'destination-unreadable: ' + String(error?.message ?? error);
    }
    const parsed = parseTapChannel(text);
    const outcome = channelState === 'read' ? classifyOutcome(parsed) : 'incomplete';
    return {
      file: entry.file,
      tapPath: entry.tapPath,
      exitCode: entry.exitCode,
      spawnError: entry.spawnError ?? null,
      channelState,
      outcome,
      plan: parsed.plan,
      hasPlan: parsed.hasPlan,
      tests: parsed.summary.tests ?? 0,
      pass: parsed.summary.pass ?? 0,
      fail: parsed.summary.fail ?? 0,
      // `skipped` / `cancelled` 都进 per-file record：两者都有同一个消费方 ——
      //   `decideVerdict` 的 `selfCheck`（S1 双向可复算）需要**逐文件**能重算出汇总，
      //   而此前 `cancelled` 只存在于汇总侧 ⇒ `Σfiles.tests ≠ totals.tests`，恒等式只能
      //   写成 `Σfiles.tests === totals.tests - totals.cancelled`（**没有一处断言在验它**）。
      //   口径与汇总侧逐字一致（同一 `parsed.summary.<key> ?? 0` 归一）。
      skipped: parsed.summary.skipped ?? 0,
      cancelled: parsed.summary.cancelled ?? 0,
      todo: parsed.summary.todo ?? 0,
      fileRootSubtest: parsed.fileRootSubtests.length > 0,
      topSubtests: parsed.topSubtests.length,
    };
  });

  // 越界完成事件：destination 在册但目标集合里没有对应文件（陈旧 / 伪造的通道都靠这条抓）。
  const expectedDestNames = new Set(targetFiles.map((file) => path.basename(file) + TAP_DEST_SUFFIX));
  const strayDestinations = fs
    .readdirSync(destDir)
    .filter((name) => name.endsWith(TAP_DEST_SUFFIX) && !expectedDestNames.has(name))
    .map((name) => name.slice(0, -TAP_DEST_SUFFIX.length))
    .sort((a, b) => a.localeCompare(b));

  return decideVerdict({ targetFiles, records, strayDestinations, spawnCount: raw.length });
}

// ── CLI ────────────────────────────────────────────────────────────────

function parseCliArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    if (arg === '--dir') options.dir = argv[i + 1];
    else if (arg === '--dest-dir') options.destDir = argv[i + 1];
    else if (arg === '--concurrency') options.concurrency = Number(argv[i + 1]);
    else if (arg.startsWith('--dir=')) options.dir = arg.slice('--dir='.length);
    else if (arg.startsWith('--dest-dir=')) options.destDir = arg.slice('--dest-dir='.length);
    else if (arg.startsWith('--concurrency=')) options.concurrency = Number(arg.slice('--concurrency='.length));
    else if (arg === '--json') options.json = true;
  }
  return options;
}

function renderVerdict(verdict, options) {
  if (options.json) return JSON.stringify(verdict, null, 2);
  const lines = [];
  lines.push(GUARD_TAG + ' 通道 = ' + verdict.channel + '（仅此通道参与判定；进程 stdout 未采集）');
  lines.push(GUARD_TAG + ' 目标文件集 A = ' + verdict.aSize + '（运行期枚举，未写死期望值）');
  lines.push(GUARD_TAG + ' 完成事件集 B = ' + verdict.bSize);
  lines.push(GUARD_TAG + ' spawn 次数 = ' + verdict.spawnCount);
  lines.push(GUARD_TAG + ' 缺口 A\\B = ' + JSON.stringify(verdict.missingInB.map((f) => path.basename(f))));
  lines.push(GUARD_TAG + ' 越界 B\\A = ' + JSON.stringify(verdict.extraInB));
  lines.push(
    GUARD_TAG +
      ' 汇总 tests=' +
      verdict.totals.tests +
      ' pass=' +
      verdict.totals.pass +
      ' fail=' +
      verdict.totals.fail +
      ' skipped=' +
      verdict.totals.skipped +
      ' todo=' +
      verdict.totals.todo,
  );
  // 算术自洽读数：**只展示、不参与 ok、不改退出码**（把它做成硬门 = 新增判据，须单独裁决）。
  //   数值来源 = `verdict.selfCheck` 的机读字段（**单一实现**：不再在此处另算一遍）。
  const selfCheck = verdict.selfCheck;
  lines.push(
    GUARD_TAG +
      ' sum-check tests=' +
      verdict.totals.tests +
      ' pass+fail+skipped+cancelled+todo=' +
      selfCheck.s2.sum +
      '（cancelled=' +
      verdict.totals.cancelled +
      '）⇒ ' +
      (selfCheck.s2.ok ? '齐' : '不齐'),
  );
  lines.push(
    GUARD_TAG +
      ' self-check（机读字段，不参与 ok）S1 Σfiles.tests=' +
      selfCheck.s1.sumFilesTests +
      ' vs totals.tests=' +
      selfCheck.s1.totalsTests +
      ' ⇒ ' +
      (selfCheck.s1.ok ? '可复算' : '⚠ 不可复算') +
      '；S2 ⇒ ' +
      (selfCheck.s2.ok ? '自洽' : '⚠ 不自洽'),
  );
  for (const reason of selfCheck.reasons) lines.push(GUARD_TAG + '   ⚠ ' + reason);
  for (const record of verdict.files) {
    if (record.outcome === 'passed') continue;
    lines.push(
      GUARD_TAG +
        '   ✖ ' +
        path.basename(record.file) +
        ' → ' +
        record.outcome +
        '（exit=' +
        record.exitCode +
        ' plan=' +
        record.plan +
        ' fail=' +
        record.fail +
        ' 路径名subtest=' +
        record.fileRootSubtest +
        '）',
    );
  }
  for (const reason of verdict.reasons) lines.push(GUARD_TAG + '   原因：' + reason);
  lines.push(GUARD_TAG + ' 结论：' + (verdict.ok ? 'GREEN' : 'RED') + '（exit=' + exitCodeOf(verdict) + '）');
  return lines.join('\n');
}

export function exitCodeOf(verdict) {
  if (verdict.rejected) return 2;
  return verdict.ok ? 0 : 1;
}

async function main() {
  const argv = process.argv.slice(2);
  const options = parseCliArgs(argv);
  const verdict = await runGuard({ ...options, argv });
  process.stdout.write(renderVerdict(verdict, options) + '\n');
  process.exitCode = exitCodeOf(verdict);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : '';
const selfPath = path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (invokedPath && invokedPath === selfPath) {
  main().catch((error) => {
    process.stderr.write(GUARD_TAG + ' 闸门自身异常：' + String(error?.stack ?? error) + '\n');
    process.exitCode = 1;
  });
}
