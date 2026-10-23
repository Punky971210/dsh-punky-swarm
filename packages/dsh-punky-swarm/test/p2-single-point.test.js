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

// punky-fix-p2-20261023 · c2 单点面（tester 落）：`A1-P2-09`（`stripStreamMerges` 双实现收敛）
//   + `A1-P2-10`（`mailboxRootOf` 四份派生收敛）。
//
// ── 两条判据取向（先读，避免把本文件读成「拿被测实现自算期望」）──────────────────────────
//   · `stripStreamMerges`：**旧实现**不是手抄 —— 从 `git show 294b4f9:./lib/governance/tool-ban.js`
//     抽**原文**（括号扫描），以 24 组等价对拍单点实现。同时配一条「旧实现的逐字冻结副本」作为
//     无条件可用的对照（git 不可用时仍可跑），并断言两者逐字相同 ⇒ 对照物本身可核。
//   · 判据面 30 命令的**期望表取自 BEFORE（改前）读数**（`exec` 层记录的 `progress/strip-before.json`
//     的 `judgeRows`，与 `strip-after.json` 逐字相同 ⇒ decisionDiff=0，本 tester 独立复核过）。
//     它不是「运行当前实现再拿结果当期望」，而是**冻结的改前基线**：实现漂移即红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { stripStreamMerges } from '../lib/shell-text.js';
import { judgeFileWriteCommand, judgeWaitSleepCommand } from '../lib/governance/tool-ban.js';
import * as commsMailbox from '../lib/comms/mailbox-paths.js';
import * as dispatchMailbox from '../lib/engine/dispatch.js';
import * as heartbeatContext from '../lib/watch/heartbeat/context.js';
import { mailboxRootOf as singlePointMailboxRootOf } from '../lib/mailbox-paths.js';
import { createStore } from '../lib/state/store.js';
import * as mailbox from '../lib/comms/mailbox.js';
import { createTrajectoryBridge } from '../lib/bridge/trajectory.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(PKG_ROOT, rel), 'utf8');

/** 从任意源码文本里抽出指定函数声明的**原文**（括号扫描；不剥注释，只按大括号配平）。 */
function extractFunction(src, signature) {
  const start = src.indexOf(signature);
  if (start === -1) return null;
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

// ── T-2a · stripStreamMerges：旧实现（git 原文） vs 单点，24 组等价对拍 ──────────────────
const SAMPLES = Object.freeze([
  '', ' ', '2>&1', '2>$null', '2>$NULL', '2>$Null',
  'npm test 2>&1', 'npm test 2>$null', 'git status 2>&1 | grep foo 2>$null',
  'Write-Output "a 2>&1 b"', "Write-Output '2>$null'",
  'echo "unclosed 2>&1', "echo 'unclosed 2>$null",
  'line1 2>&1\nline2 2>$null\nline3',
  'Set-Content -Path x.txt -Value y 2>&1', 'Out-File x.txt 2>$null',
  'node -e "console.log(1)" 2>&1 2>$null', 'a 2>&1 b 2>&1 c',
  '2>&1 2>&1 2>&1', 'echo ">>file" 2>$null', 'cmd > out.txt 2>&1',
  'cmd 2> $null', 'cmd 2>&1>out', '\t2>&1\t',
]);

/** 旧实现（改前 `tool-ban.js` 的私有函数）原文：优先 git 抽取，其次逐字冻结副本。 */
function legacyStripSource() {
  let gitText = null;
  try {
    gitText = execFileSync('git', ['show', '294b4f9:./lib/governance/tool-ban.js'],
      { cwd: PKG_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { gitText = null; }
  const extracted = gitText === null ? null : extractFunction(gitText, 'function stripStreamMerges(text)');
  // 逐字冻结副本（与 294b4f9 原文一致；git 不可用时作为对照物）
  const frozen = 'function stripStreamMerges(text) {\n    return text.replace(/2>&1/g, \' \').replace(/2>\\$null/gi, \' \');\n}';
  return { extracted, frozen, provenance: extracted === null ? 'frozen-copy' : 'git-294b4f9' };
}

function evalStrip(source) {
  // eslint-disable-next-line no-new-func -- 求值的是仓库历史源码原文
  return new Function(source + '\nreturn stripStreamMerges;')();
}

test('A1-P2-09 / R-3 · 旧实现（294b4f9 原文）与单点实现 24 组样本逐字相等', () => {
  const { extracted, frozen, provenance } = legacyStripSource();
  const legacySource = extracted ?? frozen;
  assert.ok(legacySource, '旧实现必须可取得（git 原文或逐字冻结副本）');
  if (extracted !== null) {
    assert.equal(extracted.replace(/\s+/g, ' '), frozen.replace(/\s+/g, ' '),
      'git 抽出的旧实现必须与冻结副本逐字相同（否则对照物本身失真）');
  }
  const legacy = evalStrip(legacySource);
  const mismatches = [];
  for (const input of SAMPLES) {
    const a = legacy(input);
    const b = stripStreamMerges(input);
    if (a !== b) mismatches.push(JSON.stringify(input) + '：旧=' + JSON.stringify(a) + ' 单点=' + JSON.stringify(b));
  }
  assert.deepEqual(mismatches, [],
    '搬家必须零语义变化（样本数 ' + SAMPLES.length + '，来源 ' + provenance + '）');
  assert.equal(SAMPLES.length, 24, '样本集冻结为 24 组（不得为凑绿而缩样本）');
});

test('A1-P2-09 / REVERSE · 样本集判别力：把单点实现换成恒等函数必红 ⇒ 24 组对拍不是恒真', () => {
  const identity = (text) => text;
  const surviving = SAMPLES.filter((s) => identity(s) === stripStreamMerges(s));
  // 只有不含合并标记的 3 组能过恒等函数；其余 21 组必红 ⇒ 对拍确有判别力
  assert.deepEqual(surviving, ['', ' ', 'cmd 2> $null'],
    '恒等函数下应仅剩 3 组「无标记」样本；多出即说明有命中样本被漏掉，少一个即说明样本集变了');
  assert.equal(SAMPLES.length - surviving.length, 21, '21 组命中样本必须能被判别');
});

test('A1-P2-09 · 静态单点：`function stripStreamMerges` 全仓恰 1 处，护栏侧只有 import + 2 调用', () => {
  const defs = [];
  for (const rel of ['lib/shell-text.js', 'lib/governance/tool-ban.js', 'lib/governance/tool-ban.ts']) {
    const n = (read(rel).match(/function stripStreamMerges\s*\(/g) ?? []).length;
    if (n > 0) defs.push(rel + ':' + n);
  }
  assert.deepEqual(defs, ['lib/shell-text.js:1'], '定义必须唯一落在 shell-text.js（护栏侧第二份已删净）');
  const toolBan = read('lib/governance/tool-ban.js');
  assert.equal(/function stripStreamMerges/.test(toolBan), false, 'tool-ban.js 不得再有函数体');
  assert.equal((toolBan.match(/stripStreamMerges\(/g) ?? []).length, 2, '护栏侧恰 2 处调用（判定语义零改）');
  assert.ok(/import \{[^}]*segmentCommands, stripStreamMerges[^}]*\} from '\.\.\/shell-text\.js'/.test(toolBan),
    '护栏侧必须从既有中立件 import 单点（零新增跨域边）');
});

// ── T-2b · 判据面 30 命令：decisionDiff 相对 BEFORE 基线 = 0 ──────────────────────────
// 期望表 = 改前读数（BEFORE）。`reason` 全串太长，改用 sha256 摘要锁（任一文案漂移即红）。
const JUDGE_GOLDEN = Object.freeze([
  ['npm test 2>&1', false, false],
  ['npm test 2>$null', false, false],
  ['npm test 2>$NULL', false, false],
  ['Get-ChildItem 2>&1', false, false],
  ['echo hi > out.txt 2>&1', true, false],
  ['Set-Content -Path a.txt -Value b 2>&1', true, false],
  ['Out-File a.txt 2>$null', true, false],
  ['rm -rf x 2>&1', true, false],
  ['mkdir d 2>$null', true, false],
  ['sleep 5 2>&1', false, true],
  ['Start-Sleep -Seconds 5 2>$null', false, true],
  ['Wait-Process -Name foo 2>&1', false, true],
  ['timeout 10 cmd 2>&1', false, true],
  ['echo "unclosed 2>&1', true, true],
  ["echo 'unclosed 2>$null", true, true],
  ['git status', false, false],
  ['npm run build', false, false],
  ['Get-ChildItem', false, false],
  ['Write-Output "a 2>&1"', false, false],
  ['Write-Output ">>x" 2>$null', false, false],
  ['a 2>&1 ; Set-Content b.txt c 2>$null', true, false],
  ['', false, false],
  ['   ', false, false],
  ['cmd > f.txt', true, false],
  ['tee f.txt', true, false],
  ['Copy-Item a b 2>&1', true, false],
  ['node -e "fs.writeFileSync(1)" 2>&1', false, false],
  ['x = write-host; rm y 2>$null', true, false],
  ['Add-Content p v 2>&1', true, false],
  ['New-Item -ItemType File x 2>$null', true, false],
]);

/** BEFORE 基线的 reason 全串摘要（30 条 × 两个判定面，以 `||` 与 `\n` 串联后 sha256）。 */
const BEFORE_REASON_DIGEST = '5d0e4c4494583344a3565b58e504d789b68bb467c5e028cd20686a8625fcff2b';

test('A1-P2-09 / R-3 判据面 · 30 条命令的 hit 与 reason 相对改前基线 decisionDiff = 0', () => {
  assert.equal(JUDGE_GOLDEN.length, 30, '判据面样本集冻结为 30 条');
  const diffs = [];
  const reasons = [];
  for (const [cmd, fwHit, wsHit] of JUDGE_GOLDEN) {
    const fw = judgeFileWriteCommand(cmd);
    const ws = judgeWaitSleepCommand(cmd);
    if (fw.hit !== fwHit) diffs.push(JSON.stringify(cmd) + ' fileWrite.hit 期望 ' + fwHit + ' 实得 ' + fw.hit);
    if (ws.hit !== wsHit) diffs.push(JSON.stringify(cmd) + ' waitSleep.hit 期望 ' + wsHit + ' 实得 ' + ws.hit);
    reasons.push(fw.reason + '||' + ws.reason);
  }
  assert.deepEqual(diffs, [], '判定面 hit 相对改前基线必须零差');
  const digest = createHash('sha256').update(reasons.join('\n')).digest('hex');
  assert.equal(digest, BEFORE_REASON_DIGEST,
    'reason 文案相对改前基线必须零差（摘要不符 = 判定语义漂移，须逐条比对）');
});

// ── T-2c · mailboxRootOf：四路同路径 + 边界收严 ──────────────────────────────────────
const MB_ROOT = path.join(os.tmpdir(), 'p2-mb-engine-root');
const MB_SID = 'sess-x';
const MB_BID = 'batch-y';

test('A1-P2-10 · 四路同路径：①②④ 直调 + ③ 端到端落盘，`path.resolve` 全等', () => {
  const expected = path.resolve(MB_ROOT, 'sessions', MB_SID, 'mailbox', MB_BID);
  // ① comms 域（保形再导出）
  assert.equal(path.resolve(commsMailbox.mailboxRootOf(MB_ROOT, MB_SID, MB_BID)), expected, '① comms/mailbox-paths');
  // ② engine 域（保形再导出；导出名/参数个数不变）
  assert.equal(path.resolve(dispatchMailbox.mailboxRootOf(MB_ROOT, MB_SID, MB_BID)), expected, '② engine/dispatch');
  // ④ watch 域（cx 形态签名保形，内部守卫 + 委托）
  assert.equal(path.resolve(heartbeatContext.mailboxRootOf({ engineRoot: MB_ROOT }, MB_SID, MB_BID)), expected, '④ watch/heartbeat/context');
  assert.equal(path.resolve(singlePointMailboxRootOf(MB_ROOT, MB_SID, MB_BID)), expected, '单点本体');

  // ③ bridge/trajectory：无外部可见面（局部闭包已删）⇒ 走**端到端落盘**证据
  const root = mkdtempSync(path.join(os.tmpdir(), 'p2-mb-traj-'));
  const store = createStore(root);
  const SESS = 'sess-traj';
  const BID = 'b-traj';
  store.createBatch(SESS, { batchId: BID, wavePlan: { team: 'generic', wavePlan: [{ wave: 1, tasks: [{ id: 'l1', cmd: 'x' }] }] } });
  store.setPhase(SESS, BID, 'running');
  store.setMember(SESS, BID, 'l1', 'running');
  const bridge = createTrajectoryBridge({ logger: { info() {}, warn() {} } }, { store, config: {}, mailbox });
  bridge.start();
  bridge.recordDispatch({ sessionId: SESS, batchId: BID, lane: 'l1', workerSessionId: 'w-1' });
  const routed = bridge.handleAnomaly({
    anomalyId: 'a-1', sessionId: 'w-1', type: 'loop_deadlock',
    confidence: 0.95, severity: 'critical', message: 'm',
  });
  assert.equal(routed.routed, true, '异常必须被路由（否则 ③ 路径根本没执行）');
  const expectedTraj = path.resolve(root, 'sessions', SESS, 'mailbox', BID);
  assert.equal(expectedTraj, path.resolve(singlePointMailboxRootOf(root, SESS, BID)),
    '③ 的落盘根必须与单点同源（root = 引擎根，非 sessionsDir）');
  const broadcastDir = path.join(expectedTraj, 'broadcast');
  assert.equal(existsSync(broadcastDir), true, '③ 必须真的落到 broadcast 子目录（端到端证据）');
  assert.ok(readdirSync(broadcastDir).length >= 1, 'broadcast 目录内必须有消息文件');
});

test('A1-P2-10 / R-4 · ③ 必须传引擎根（`engineRootOf(store.sessionsDir)`）：直接把 sessionsDir 喂单点会多一层 `sessions/sessions`', () => {
  const sessionsDir = path.join(MB_ROOT, 'sessions');
  const correct = path.resolve(singlePointMailboxRootOf(MB_ROOT, MB_SID, MB_BID));
  const literalSpec = path.resolve(singlePointMailboxRootOf(sessionsDir, MB_SID, MB_BID));
  assert.notEqual(literalSpec, correct, '规格字面（直接传 sessionsDir）必然产出多一层 —— 这条不等是 ③ 的构造纪律依据');
  assert.ok(literalSpec.includes(path.join('sessions', 'sessions')),
    '错误构造的形态 = `<root>/sessions/sessions/…`（静默落错目录，正是 gap-1 记录的陷阱）');
  // 并证明 trajectory.js 的实装取的确实是**引擎根**，且该推导已单点（批 `punky-closeout-20261023` C4 / A2-G08）。
  // 【判据更新 · 留痕】原断言逐字钉住改前的**内联字面量** `mailboxRootOf(dirname(store.sessionsDir), …)`，
  //   它编码的实现形状是「trajectory.js 自持 `dirname(store.sessionsDir)` 推导」；该形状已被**本批 C4 覆盖**
  //   （引擎根推导单点 = `lib/state/batch-paths.js::engineRootOf`）⇒ 任何符合 C4 的实现都必然打红本断言
  //   （红因 = 实现前进，不是退化）。新判据**双面**：
  //     ① 正向：仍委托单点，且传的是 `engineRootOf(store.sessionsDir)`（引擎根语义不变）；
  //     ② 反向：本文件不再自持 `dirname(store…)` 推导（自持即第二份同知识实现）。
  const src = read('lib/bridge/trajectory.js');
  assert.ok(/mailboxRootOf\(engineRootOf\(store\.sessionsDir\), sessionId, batchId\)/.test(src),
    '③ 必须以 `engineRootOf(store.sessionsDir)` 委托单点（回退成 sessionsDir 即静默落错目录）');
  assert.equal(/dirname\(\s*store/.test(src), false,
    'trajectory.js 不得再自持 `dirname(store…)` 推导（C4：收成 `engineRootOf` 单点）');
});

test('A1-P2-10 · 边界收严：root 为 null/undefined/空串 ⇒ throw（fail-closed），正例返回字符串', () => {
  for (const bad of [null, undefined, '']) {
    assert.throws(() => singlePointMailboxRootOf(bad, MB_SID, MB_BID), /root required/,
      'root=' + JSON.stringify(bad) + ' 必须 throw（原 dispatch 实装会静默产出无根路径）');
  }
  // 四路的包装层各自的守卫文案（只有 ④ 自持守卫，其余两路委托单点）
  assert.throws(() => heartbeatContext.mailboxRootOf({}, MB_SID, MB_BID), /lane-heartbeat: no root/);
  assert.equal(typeof dispatchMailbox.mailboxRootOf(MB_ROOT, MB_SID, MB_BID), 'string', '正例必须是字符串');
});

test('A1-P2-10 · 静态单点：`function mailboxRootOf` 全仓恰 1 处；三处导出面保形（名字/参数个数不变）', () => {
  const defs = [];
  for (const rel of ['lib/mailbox-paths.js', 'lib/comms/mailbox-paths.js', 'lib/engine/dispatch.js',
    'lib/bridge/trajectory.js', 'lib/watch/heartbeat/context.js']) {
    const n = (read(rel).match(/function mailboxRootOf\s*\(/g) ?? []).length;
    if (n > 0) defs.push(rel + ':' + n);
  }
  assert.deepEqual(defs, ['lib/mailbox-paths.js:1'], '四份派生必须收成一份（其余为再导出或包装）');
  assert.equal(singlePointMailboxRootOf.length, 3, '单点参数个数 = 3（root, sessionId, batchId）');
  assert.equal(commsMailbox.mailboxRootOf.length, 3, '① 导出面保形：参数个数不变');
  assert.equal(dispatchMailbox.mailboxRootOf.length, 3, '② 导出面保形：参数个数不变');
  assert.equal(heartbeatContext.mailboxRootOf.length, 3, '④ 导出面保形：参数个数不变');
  // ④ 用 const 箭头（使「函数声明形态」定义数恰 1），且体内只做守卫 + 委托
  const ctxSrc = read('lib/watch/heartbeat/context.js');
  assert.ok(/export const mailboxRootOf = \(cx, sessionId, batchId\) =>/.test(ctxSrc),
    '④ 必须是 const 箭头包装（否则 function 形态定义数 = 2，AC-4 #1 不可机检）');
  assert.equal(/path\.join\(|'sessions'/.test(ctxSrc.split('export const mailboxRootOf')[1]?.split(';')[0] ?? ''),
    false, '④ 包装体内不得持有第二份路径拼接知识（只读 cx.engineRoot + 守卫 + 委托）');
});
