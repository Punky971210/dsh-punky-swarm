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

// test/preflight-report.test.js —— P0-2「回报三字段」软检查的**运行时判据锁**
// ─────────────────────────────────────────────────────────────────────────────
// 判据源：`artifacts/punky-guidance-preflight-20261025/plan/guidance-preflight-spec.md` §B + AC-R1…R11。
// 被测面（唯一写路径）：`lib/state/store/member-gates.js#runMergedGateChain` 的 merged 门链**末尾**。
//   ⇒ 本文件**不**经 `member_settle` 工具、**不**建 tools：直接用 `store.setMember`（= auto-settle 主路的
//      同一写路径，`lib/engine/auto-settle.js` 就这么调）⇒ 覆盖双路（AC-R9）由构造本身保证。
// 纪律：断言一律读批次 JSON（唯一事实源）；每条判据都**能红**（删掉检测调用 ⇒ 全红）。
// 全软（D1/D2）：本套件的每条 lane 级用例都同时断言 `lanes.<lane> === 'merged'` —— 缺口**绝不**改状态。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { autoSettleLane } from '../lib/engine/auto-settle.js'; // 生产主路入口（AC-R9+ 实证用）
import { EVT_PREFLIGHT_REPORT_MISSING } from '../lib/state/event-types.js';
import { detectPreflightReport, PREFLIGHT_REPORT_FIELDS } from '../lib/state/store/member-gates.js';
import { runLane } from './helpers/gate-fixture.mjs';

const S = 'sess-preflight-report';
const SPEC_OK = '# spec\n## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准\n- x\n## 约束\n- y\n';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-preflight-report-'));
const warns = [];
const store = createStore(root, {
  logger: {
    warn: (m) => warns.push(String(m)),
    info: () => {}, error: () => {}, debug: () => {}, log: () => {},
  },
});

function writeArt(batchId, rel, body) {
  const abs = path.join(root, 'sessions', S, 'artifacts', batchId, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
  return abs;
}

/** 合规三层批（plan + exec + audit）；`execLane` 覆盖 exec 任务的 produce/outputs 等声明面。 */
function mkBatch(batchId, execLane = {}, { plan = true } = {}) {
  const tasks = [
    ...(plan ? [{ id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 'spec' }] : []),
    {
      id: 'e1', layer: 'exec', cmd: 'run', deps: plan ? ['p1'] : [],
      consume: plan ? ['plan/spec.md'] : [],
      ...execLane,
    },
    // 三层契约要求：有 exec 层 ⇒ 必须有 audit 层（`three-tier: exec layers require at least one audit lane`）
    { id: 'a1', layer: 'audit', cmd: 'review', deps: ['e1'], consume: [], produce: ['audit/r.md'] },
  ];
  store.createBatch(S, { batchId, wavePlan: buildWavePlan({ batchId, tasks }), phase: 'running' });
  if (plan) writeArt(batchId, 'plan/spec.md', SPEC_OK); // entry 门 presence 硬约束
  writeArt(batchId, 'audit/r.md', 'review');
  return batchId;
}

const eventsOf = (batchId) => store.readBatch(S, batchId).events
  .filter((e) => e.type === EVT_PREFLIGHT_REPORT_MISSING);
// warn 过滤单点：建批/归档另有既有 warn（如 gate.contract_missing），不属本判据 ⇒ 只数本软检查的那一条
const preflightWarnsOf = () => warns.filter((m) => m.includes('回报三字段不全'));
const lanesOf = (batchId) => store.readBatch(S, batchId).lanes;

const FULL = 'knowledge_hits: 13号文档 第十条：不得在写者未静止时采样\n'
  + 'skills_used: none: 本任务纯文档改动，无可用技能\n'
  + 'mcp_used: []\n';

// ── AC-R1：三字段齐备 ⇒ 零事件、零 warn（反向断言，防「无条件落事件」）────────────────
test('AC-R1 三字段齐备 ⇒ 零事件零 warn，merged 成立', () => {
  mkBatch('b-r1', { outputs: ['exec/e1.md'] });
  writeArt('b-r1', 'exec/e1.md', FULL);
  const w = preflightWarnsOf().length;
  runLane(store, S, 'b-r1', 'e1');
  assert.equal(lanesOf('b-r1').e1, 'merged');
  assert.equal(eventsOf('b-r1').length, 0, '三字段全 ok ⇒ 不落事件');
  assert.equal(preflightWarnsOf().length, w, '三字段全 ok ⇒ 不落 warn');
});

// ── AC-R2：缺一字段 ⇒ 恰一条事件 + missing 点名 + merged 仍成立（**不抛**）─────────────
test('AC-R2 缺 knowledge_hits ⇒ 恰 1 条事件、missing 点名、merged 照旧', () => {
  mkBatch('b-r2', { outputs: ['exec/e1.md'] });
  writeArt('b-r2', 'exec/e1.md', 'skills_used: none: 无需技能\nmcp_used: []\n');
  const w = preflightWarnsOf().length;
  runLane(store, S, 'b-r2', 'e1'); // 不抛 = 全软
  assert.equal(lanesOf('b-r2').e1, 'merged', '软检查绝不改成员态');
  const evs = eventsOf('b-r2');
  assert.equal(evs.length, 1, '恰一条（禁重复落事件）');
  assert.deepEqual(evs[0].missing, ['knowledge_hits']);
  assert.equal(evs[0].reason, 'fields-missing');
  assert.equal(evs[0].soft, true);
  assert.deepEqual(evs[0].artifacts, ['exec/e1.md']);
  assert.equal(preflightWarnsOf().length, w + 1, '恰一条 warn');
  assert.match(preflightWarnsOf().at(-1), /knowledge_hits:missing/);
});

// ── AC-R3：`none` 无理由 ⇒ none-no-reason（两种形态）──────────────────────────────
test('AC-R3 mcp_used: none / none:（空白）⇒ none-no-reason，不计通过', () => {
  for (const [batchId, body] of [
    ['b-r3a', 'knowledge_hits: ok\nskills_used: []\nmcp_used: none\n'],
    ['b-r3b', 'knowledge_hits: ok\nskills_used: []\nmcp_used: none:   \n'],
  ]) {
    mkBatch(batchId, { outputs: ['exec/e1.md'] });
    writeArt(batchId, 'exec/e1.md', body);
    runLane(store, S, batchId, 'e1');
    const evs = eventsOf(batchId);
    assert.equal(lanesOf(batchId).e1, 'merged');
    assert.equal(evs.length, 1);
    assert.equal(evs[0].states.mcp_used, 'none-no-reason');
    assert.deepEqual(evs[0].missing, ['mcp_used']);
  }
});

// ── AC-R4：`none: <理由>` ⇒ 放过（反向断言，防「none 一律判缺」）─────────────────────
test('AC-R4 none: <非空理由> ⇒ ok、零事件', () => {
  mkBatch('b-r4', { outputs: ['exec/e1.md'] });
  writeArt('b-r4', 'exec/e1.md',
    'knowledge_hits: none: 本任务无历史同类经验\nskills_used: none: 纯文档改动\nmcp_used: none: 无外部工具需求\n');
  runLane(store, S, 'b-r4', 'e1');
  assert.equal(lanesOf('b-r4').e1, 'merged');
  assert.equal(eventsOf('b-r4').length, 0);
});

// ── AC-R5：空值 ⇒ empty（不是「行在就算填了」）──────────────────────────────────────
test('AC-R5 knowledge_hits:（冒号后仅空白、无续行）⇒ empty', () => {
  mkBatch('b-r5', { outputs: ['exec/e1.md'] });
  writeArt('b-r5', 'exec/e1.md', 'knowledge_hits:   \nskills_used: []\nmcp_used: []\n');
  runLane(store, S, 'b-r5', 'e1');
  const evs = eventsOf('b-r5');
  assert.equal(lanesOf('b-r5').e1, 'merged');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].states.knowledge_hits, 'empty');
  assert.deepEqual(evs[0].missing, ['knowledge_hits']);
});

// ── AC-R6：续行读法（值在缩进列表里）⇒ 视为已填（能红：只看首行会误判 empty）────────────
test('AC-R6 缩进续行 = 值的一部分 ⇒ ok、零事件', () => {
  mkBatch('b-r6', { outputs: ['exec/e1.md'] });
  writeArt('b-r6', 'exec/e1.md',
    'knowledge_hits:\n  - 13号文档：写者未静止时不得采样\n  - 16号：判据必须能红\n'
    + 'skills_used:\n\t- speclang\n'
    + 'mcp_used:\n  - codegraph_explore\n');
  runLane(store, S, 'b-r6', 'e1');
  assert.equal(lanesOf('b-r6').e1, 'merged');
  assert.equal(eventsOf('b-r6').length, 0, '续行已填 ⇒ 不得判 empty');
});

// ── AC-R7：扫描面 = produce ∪ outputs（去重保序）⇒ 字段只写在 outputs 件里也认 ──────────
test('AC-R7 三字段只写在 outputs 件 ⇒ 零事件（只扫 produce 会误报）', () => {
  mkBatch('b-r7', { produce: ['exec/a.md'], outputs: ['exec/e1.md'] });
  writeArt('b-r7', 'exec/a.md', '本件只有正文，无回报字段\n');
  writeArt('b-r7', 'exec/e1.md', FULL);
  runLane(store, S, 'b-r7', 'e1');
  assert.equal(lanesOf('b-r7').e1, 'merged');
  assert.equal(eventsOf('b-r7').length, 0);
});

// ── AC-R8：无声明产物（targets 型）⇒ 不判 missing，只落 no-declared-artifacts ──────────
test('AC-R8 无 produce/outputs ⇒ reason=no-declared-artifacts、missing=[]、merged 成立', () => {
  // targets 型 lane 的合法入口 = standalone 逃生阀（批次内无可用 plan 上游 ⇒ 单 lane 批）
  mkBatch('b-r8', { outputs: [], standalone: true, standaloneReason: 'targets 型 lane：只改代码不产产物' }, { plan: false });
  runLane(store, S, 'b-r8', 'e1');
  const evs = eventsOf('b-r8');
  assert.equal(lanesOf('b-r8').e1, 'merged');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].reason, 'no-declared-artifacts');
  assert.deepEqual(evs[0].missing, [], '无产物 ≠ 缺字段 ⇒ missing 必须为空（防误伤）');
  assert.deepEqual(evs[0].artifacts, []);
});

// ── AC-R9：**auto-settle 主路覆盖**（不经 member_settle 工具）⇒ 事件在场 ─────────────────
test('AC-R9 直调 store.setMember（auto-settle 写路径）⇒ 检测确实执行', () => {
  mkBatch('b-r9', { outputs: ['exec/e1.md'] });
  writeArt('b-r9', 'exec/e1.md', '只写了一行正文\n');
  // 逐字复刻 auto-settle 的写路径：store.setMember(review) → store.setMember(merged)，不经工具面
  store.setMember(S, 'b-r9', 'e1', 'running');
  store.setMember(S, 'b-r9', 'e1', 'review');
  store.setMember(S, 'b-r9', 'e1', 'merged');
  assert.equal(lanesOf('b-r9').e1, 'merged');
  assert.equal(eventsOf('b-r9').length, 1, '若只挂工具层 ⇒ 此处零事件（本判据即红）');
  assert.deepEqual(eventsOf('b-r9')[0].missing, ['knowledge_hits', 'skills_used', 'mcp_used']);
});

// ── AC-R9（强化）：**真实 auto-settle 模块**（`lib/engine/auto-settle.js`）跑一次 ⇒ 检测确实执行 ──
// 与上一条的区别：上一条是「同一写路径」的等价构造；本条**真的调用生产入口** `autoSettleLane`，
//   证明本软检查在生产主路上**不是死码**（它不经 `member_settle` 工具，只经 `store.setMember`）。
test('AC-R9+ 真实 auto-settle 结算 ⇒ 事件在场、lane merged（生产主路实证）', async () => {
  mkBatch('b-r9-real', { outputs: ['exec/e1.md'] });
  writeArt('b-r9-real', 'exec/e1.md', '正文只有一行，没有三字段\n');
  store.setMember(S, 'b-r9-real', 'e1', 'running'); // 派发（auto-settle 要求 lane 非终态）
  const r = await autoSettleLane({ store }, {
    sessionId: S, batchId: 'b-r9-real', lane: 'e1', trigger: 'subagent/end', stopReason: 'completed',
  });
  assert.equal(r.action, 'merged', 'auto-settle 判定链跑通（实际: ' + r.action + '/' + r.reason + '）');
  assert.equal(lanesOf('b-r9-real').e1, 'merged');
  const evs = eventsOf('b-r9-real');
  assert.equal(evs.length, 1, '未经 member_settle 工具仍落事件 ⇒ 不是死码');
  assert.deepEqual(evs[0].missing, ['knowledge_hits', 'skills_used', 'mcp_used']);
  assert.equal(evs[0].soft, true);
});

// ── AC-R10（局部）：既有硬门逐字不变 —— 缺产物仍**硬拒**，软检查不越位 ──────────────────
test('AC-R10 产物缺失仍拒 GATE_EXIT_MISSING_EXEC（软检查不改变硬门）', () => {
  mkBatch('b-r10', { outputs: ['exec/missing.md'] }); // 不播种 ⇒ exit 门拒
  store.setMember(S, 'b-r10', 'e1', 'running');
  store.setMember(S, 'b-r10', 'e1', 'review');
  assert.throws(() => store.setMember(S, 'b-r10', 'e1', 'merged'), /GATE_EXIT_MISSING_EXEC/);
  assert.notEqual(lanesOf('b-r10').e1, 'merged');
  assert.equal(eventsOf('b-r10').length, 0, '硬门拒态 ⇒ 软检查根本不执行（顺序纪律）');
});

// ── AC-R11：0 字节 / 目录形态产物跳过（沿用 detectNeedHuman 的读法）──────────────────
// 面的选择（诚实交代）：**lane 级不可达** —— exit 门（`presenceJudge`）把「0 字节」判 missing、
//   把「声明为文件的目录」判 `GATE_ARTIFACT_NOT_A_FILE` ⇒ 真实批次里这类路径**到不了** merged 门链末尾。
//   故本判据落在**检测器级**（读法所在的唯一实现）：同一声明面里混入 0 字节件 + 目录件，
//   必须**跳过而非误判** ⇒ 良好件照常供给三字段、零事件。
//   同时保留 lane 级反向锁：把 0 字节/目录声明进 exec 产物 ⇒ **exit 门硬拒**（软检查不越位、不遮蔽硬门）。
test('AC-R11 0 字节与目录形态跳过（检测器级）＋ lane 级仍被 exit 门硬拒', () => {
  const detDir = path.join(root, 'sessions', S, 'artifacts', 'b-r11-detector');
  fs.mkdirSync(path.join(detDir, 'exec', 'dirp'), { recursive: true });
  fs.writeFileSync(path.join(detDir, 'exec', 'empty.md'), '', 'utf8'); // 0 字节
  fs.writeFileSync(path.join(detDir, 'exec', 'e1.md'), FULL, 'utf8');
  const r = detectPreflightReport(detDir, ['exec/empty.md', 'exec/dirp', 'exec/e1.md']);
  assert.equal(r.reason, null, '0 字节 / 目录不可能自带回报行 ⇒ 不得因此判缺');
  assert.deepEqual(r.artifacts, ['exec/e1.md'], '跳过件不计入「实际扫到的在场件」');

  // lane 级：声明面含 0 字节 / 目录 ⇒ exit 门硬拒（本软检查对它零感知，因为根本走不到）
  mkBatch('b-r11', { outputs: ['exec/empty.md', 'exec/dir', 'exec/e1.md'] });
  writeArt('b-r11', 'exec/empty.md', '');
  fs.mkdirSync(path.join(root, 'sessions', S, 'artifacts', 'b-r11', 'exec', 'dir'), { recursive: true });
  writeArt('b-r11', 'exec/e1.md', FULL);
  store.setMember(S, 'b-r11', 'e1', 'running');
  store.setMember(S, 'b-r11', 'e1', 'review');
  assert.throws(() => store.setMember(S, 'b-r11', 'e1', 'merged'), /GATE_ARTIFACT_(MISSING|NOT_A_FILE)/);
  assert.equal(eventsOf('b-r11').length, 0);
});

// ── 五态读数（三齐 / 缺一 / 空值 / none 无理由 / none 带理由）⇒ **全部 merged 通过**，只事件不同 ──
test('五态矩阵：merged 恒通过，只有事件与状态读数不同', () => {
  // [batchId, 产物正文, 期望事件条数, 期望被判缺口字段, 该字段期望态]
  // [batchId, 产物正文, 期望事件条数, 期望被判缺口字段, 该字段期望态]
  const cases = [
    ['b-m-ok', `knowledge_hits: a
skills_used: b
mcp_used: c
`, 0, null, null],
    ['b-m-one-missing', `skills_used: b
mcp_used: c
`, 1, 'knowledge_hits', 'missing'],
    ['b-m-empty', `knowledge_hits:
skills_used: b
mcp_used: c
`, 1, 'knowledge_hits', 'empty'],
    ['b-m-none-bare', `knowledge_hits: a
skills_used: none
mcp_used: c
`, 1, 'skills_used', 'none-no-reason'],
    ['b-m-none-reason', `knowledge_hits: a
skills_used: none: 本任务无需技能
mcp_used: c
`, 0, null, null],
  ];
  for (const [batchId, body, expectedEvents, expectedField, expectedState] of cases) {
    mkBatch(batchId, { outputs: ['exec/e1.md'] });
    writeArt(batchId, 'exec/e1.md', body);
    runLane(store, S, batchId, 'e1');
    assert.equal(lanesOf(batchId).e1, 'merged', batchId + '：五态**全部** merged 通过（全软）');
    const evs = eventsOf(batchId);
    assert.equal(evs.length, expectedEvents, batchId + '：事件条数');
    if (expectedField) {
      assert.equal(evs[0].states[expectedField], expectedState, batchId + '：状态读数');
      assert.deepEqual(evs[0].missing, [expectedField], batchId + '：missing 点名');
    }
  }
});

// ── REQ-10 / AC-X1 局部：事件常量命名纪律（**禁 `GATE_` 子串**）──────────────────────
test('REQ-10 事件常量值与常量名均不含 GATE_ 子串（否则「零新造 GATE_」判据恒假）', () => {
  assert.equal(EVT_PREFLIGHT_REPORT_MISSING, 'gate.preflight.report.missing');
  assert.doesNotMatch(EVT_PREFLIGHT_REPORT_MISSING, /GATE_[A-Z0-9_]+/);
  assert.doesNotMatch('EVT_PREFLIGHT_REPORT_MISSING', /GATE_[A-Z0-9_]+/);
  // 常量单点登记：event-types.js 内**只定义一次**（禁在调用点写裸字面量）
  const evtSrc = fs.readFileSync(new URL('../lib/state/event-types.js', import.meta.url), 'utf8');
  // P4-b 不可改造（Leader 裁定）：期望值来自**源码形态**（"唯一实现/单点定义"契约），匹配结果只有次数、无身份面；无处可取 identity ⇒ 归 P4-b。
  // map 出身份即原文 = 第二真源，matchAll 位置仍是运行时。保留计数。
  // P4-b 不可改造（Leader 裁定）：期望值来自**源码形态**（"唯一实现/单点定义"契约），匹配结果只有次数、无身份面；无处可取 identity ⇒ 归 P4-b。
  // map 出身份即原文 = 第二真源，matchAll 位置仍是运行时。保留计数。
  assert.equal((evtSrc.match(/export const EVT_PREFLIGHT_REPORT_MISSING\s*=/g) ?? []).length, 1, '常量单点定义');
  const gateSrc = fs.readFileSync(new URL('../lib/state/store/member-gates.js', import.meta.url), 'utf8');
  assert.ok(!gateSrc.includes("'gate.preflight.report.missing'"), '调用点引用常量、不写裸字面量');
});

// ── 纯函数判据（detectPreflightReport 单点）：零 IO 抛错 + 无产物契约 ─────────────────
test('detectPreflightReport：空声明面 ⇒ no-declared-artifacts（ok:true、missing:[]）', () => {
  const dir = path.join(root, 'sessions', S, 'artifacts', 'b-r8');
  const r = detectPreflightReport(dir, []);
  assert.equal(r.reason, 'no-declared-artifacts');
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.artifacts, []);
});

test('detectPreflightReport：声明面非法/缺件一律跳过，不抛错（fail-safe）', () => {
  const dir = path.join(root, 'sessions', S, 'artifacts', 'b-r8');
  const r = detectPreflightReport(dir, ['../escape.md', 'nope/none.md']);
  assert.equal(r.reason, 'fields-missing');
  assert.deepEqual(r.artifacts, [], '逃逸/缺件均不计为「在场件」');
  assert.deepEqual(PREFLIGHT_REPORT_FIELDS, ['knowledge_hits', 'skills_used', 'mcp_used']);
});
