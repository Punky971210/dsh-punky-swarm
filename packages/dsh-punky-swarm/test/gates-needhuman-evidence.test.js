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

// needHuman 人工裁决**证据契约**用例（DT-GAP-1 · T5 = WD1-1..WD1-6）
//   batch `punky-debt-fix-20261020` · lane `e2-test`
//
// 判据源：`plan/scope.md` §2 T5（三处消费点 + 21 条存量放行 + 3 类弱证据拒）
//         + 契约单点 `lib/state/constants.js#HUMAN_EVIDENCE_RE` / `humanEvidenceOf`。
//
// 为什么单独立件（既有 `test/gates.test.js` 的 N1-N4 已覆盖 member 路径的端到端）：
//   既有覆盖**不含**证据契约本身（21 条兼容式放行 / 3 类弱证据拒），也不含 exit 与 handoff 两处
//   消费点的**直调**判据。本件补的正是「契约面」与「另两处消费点」，不改动任何既有用例。
//
// 三处消费点（同一单点函数的三个调用位置，**结构自证**见 WD1-5）：
//   · `lib/state/gates/exit.js:126`      `checkNeedHumanGate`（audit merged 前人工闸；member 结算路径经它）
//   · `lib/state/gates/handoff.js:110`   `checkSettleHandoffGate` 的 `humanException`（有下游但缺交接时的 Leader 例外）
//   · `lib/state/store/member-gates.js:164` 命令门失败 + 声明 needHuman ⇒ 转人工闸
//
// 断言纪律（AC-4）：每条「拒 / 未声明 ⇒ 放行」断言都在同测试内配**同输入阳性对照**
//   （同一批次、同一产物、只换 note），证明拒的是「证据不足」而不是「本就不该放行」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HUMAN_EVIDENCE_RE, humanEvidenceOf } from '../lib/state/constants.js';
import { detectNeedHuman, createGates } from '../lib/state/gates.js';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';

const SID = 'sess-needhuman';

// ── 存量 21 条（兼容式裁决样本集）：人/时间分隔符 `@` 与 `:` 两形态、多裁决人、多结论 ────────────
// 契约：`human:<裁决人>:<时间>:<结论>`，其中「裁决人 + 时间」之间的分隔符兼容 `@` / `:`。
const STOCK_PASS_21 = [
  'human:user:2026-08-21:accept',
  'human:user@2026-08-21:accept',
  'human:alice:2026-09-01:approve',
  'human:alice@2026-09-01:approve',
  'human:bob:2026-12-31:reject',
  'human:bob@2026-12-31:reject',
  'human:zhang.san:2026-01-05:ok',
  'human:zhang.san@2026-01-05:ok',
  'human:li-si:2026-02-28:accept（附理由：已复核）',
  'human:li-si@2026-02-28:accept（附理由：已复核）',
  'human:manager-1:2026-03-15:accept',
  'human:manager-1@2026-03-15:accept',
  'human:owner:2026-04-01:pass',
  'human:owner@2026-04-01:pass',
  'human:reviewer:2026-05-20:conditional-accept',
  'human:reviewer@2026-05-20:conditional-accept',
  'human:u_9:2026-06-30:accept:with-colon-in-conclusion',
  'human:u_9@2026-06-30:accept:with-colon-in-conclusion',
  // 多行 note：证据行只需**某一行**行首匹配（正则带 `m`）
  '备注：前置说明\nhuman:user:2026-08-21:accept',
  '见下：\nhuman:user@2026-08-21:accept\n尾注',
  'human:审计员:2026-07-07:通过',
];

// 3 类弱证据（必须全拒）
const WEAK_3 = [
  ['缺时间与结论（`human:x`）', 'human:x'],
  ['裁决人为空（`human::2026-08-21:accept`）', 'human::2026-08-21:accept'],
  ['两位年份（`human:user:26-8-21:ok`）', 'human:user:26-8-21:ok'],
];

test('WD1-1 单点证据契约：21 条存量兼容式**全放行**（参数化）', () => {
  assert.equal(STOCK_PASS_21.length, 21, '样本集须恰 21 条（判据源口径）');
  for (const note of STOCK_PASS_21) {
    const ev = humanEvidenceOf(note);
    assert.ok(typeof ev === 'string' && ev.startsWith('human:'), '存量证据须放行: ' + JSON.stringify(note) + ' ← ' + String(ev));
    assert.equal(HUMAN_EVIDENCE_RE.test(note), true, '正则同源须命中: ' + JSON.stringify(note));
  }
});

test('WD1-2 单点证据契约：3 类弱证据**全拒**（且与 WD1-1 用同一函数/同一正则）', () => {
  // 阳性先行（同测试内）：同一函数对一条合法证据必须放行 —— 否则「弱证据被拒」可能只是函数恒 null
  assert.equal(humanEvidenceOf('human:user:2026-08-21:accept'), 'human:user:2026-08-21:accept',
    '阳性对照：合法证据必须被提取（证明下面的 null 是「判拒」而非「函数恒 null」）');
  for (const [name, note] of WEAK_3) {
    assert.equal(humanEvidenceOf(note), null, '[' + name + '] 弱证据须拒: ' + JSON.stringify(note));
    HUMAN_EVIDENCE_RE.lastIndex = 0;
    assert.equal(HUMAN_EVIDENCE_RE.test(note), false, '[' + name + '] 正则须不命中: ' + JSON.stringify(note));
  }
  // 非字符串 / 空 ⇒ 零证据（不 throw）
  for (const v of [undefined, null, 123, '', '   ']) {
    assert.equal(humanEvidenceOf(v), null, '非字符串/空 note 须为零证据: ' + JSON.stringify(v));
  }
});

// ── 夹具：一个 audit lane 批次 + 产物根 ────────────────────────────────────────
function makeHarness({ acceptance = '# 验收\nneedHuman: true\n', layer = 'audit', outputsOnly = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-needhuman-'));
  const bid = 'b-nh' + Math.random().toString(36).slice(2, 8);
  const dir = path.join(root, 'sessions', SID, 'artifacts', bid);
  fs.mkdirSync(path.join(dir, 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'plan'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plan', 'spec.md'), '# spec\n## 验收标准\n- x\n');
  fs.writeFileSync(path.join(dir, 'audit', 'acceptance.md'), acceptance);
  if (outputsOnly) fs.writeFileSync(path.join(dir, outputsOnly), acceptance);
  const auditTask = outputsOnly
    ? { id: 'a1', layer, role: 'reviewer', consume: ['plan/spec.md'], outputs: [outputsOnly], deps: ['e1'] }
    : { id: 'a1', layer, role: 'reviewer', consume: ['plan/spec.md'], produce: ['audit/acceptance.md'], deps: ['e1'] };
  const batch = {
    batchId: bid,
    phase: 'running',
    wavePlan: [{ tasks: [
      { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'] },
      { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1.md'], deps: ['p1'] },
      auditTask,
    ] }],
    lanes: { p1: 'merged', e1: 'merged', a1: 'review' },
    // **新式批次**（有 `handoffs` 字段，哪怕是空表）：否则结算出口门走 legacy 放行分支，
    //   humanException 路径**结构性不可达** —— 本件要测的正是该分支，故显式声明空表。
    handoffs: {},
    events: [],
  };
  const gates = createGates(root);
  return { root, bid, dir, batch, gates };
}

test('WD1-3 exit 消费点（`checkNeedHumanGate`）：未声明⇒放行 / 声明无证据⇒拒 / 强证据⇒放行 / 弱证据⇒拒', () => {
  // ① 未声明（产物无 needHuman 行）⇒ 零感知放行（阳性基线）
  const h1 = makeHarness({ acceptance: '# 验收\n无人工声明\n' });
  const r1 = h1.gates.checkNeedHumanGate(SID, h1.bid, h1.batch, 'a1', null);
  assert.equal(r1.ok, true, '未声明 ⇒ 须放行');
  assert.equal(r1.declared, false, '未声明 ⇒ declared:false');

  // ② 已声明 + 无证据 ⇒ 拒 GATE_NEEDHUMAN_PENDING 且点名产物路径
  const h2 = makeHarness();
  const r2 = h2.gates.checkNeedHumanGate(SID, h2.bid, h2.batch, 'a1', null);
  assert.equal(r2.ok, false, '声明+无证据 ⇒ 须拒');
  assert.equal(r2.code, 'GATE_NEEDHUMAN_PENDING', '拒码须为 GATE_NEEDHUMAN_PENDING');
  assert.equal(r2.path, 'audit/acceptance.md', '拒态须点名声明产物');
  assert.equal(r2.declared, true, '拒态须 declared:true');

  // ③ 同一批次 + 强证据 ⇒ 放行（**同输入阳性对照**：只换 note）
  //   证据契约是**行首锚定**（`^human:` + `m`）⇒ 证据须独占一行；`同意：human:…` 同前缀不算证据（另有用例覆盖）
  const r3 = h2.gates.checkNeedHumanGate(SID, h2.bid, h2.batch, 'a1', '同意：\nhuman:user:2026-08-21:accept');
  assert.equal(r3.ok, true, '声明+强证据 ⇒ 须放行');
  assert.equal(r3.declared, true, '放行态仍须 reported declared:true');
  assert.match(String(r3.evidence), /^human:/, '放行须回显证据原文');
  // ③′ 行首锚定的反例（与 ③ 同批次，差异只在证据是否独占一行）⇒ 仍拒
  const r3b = h2.gates.checkNeedHumanGate(SID, h2.bid, h2.batch, 'a1', '同意：human:user:2026-08-21:accept');
  assert.equal(r3b.ok, false, '证据非行首 ⇒ 不构成证据（行首锚定语义）');
  assert.equal(r3b.code, 'GATE_NEEDHUMAN_PENDING', '拒码同码');

  // ④ 弱证据 3 类 ⇒ 仍拒（逐条，与 ③ 同批次同产物 ⇒ 差异只在 note 形态）
  for (const [name, note] of WEAK_3) {
    const rw = h2.gates.checkNeedHumanGate(SID, h2.bid, h2.batch, 'a1', note);
    assert.equal(rw.ok, false, '[' + name + '] 弱证据须仍拒');
    assert.equal(rw.code, 'GATE_NEEDHUMAN_PENDING', '[' + name + '] 拒码同码');
  }

  // ⑤ 非 audit lane ⇒ 零感知（人工闸只服务 audit 层）
  const rp = h2.gates.checkNeedHumanGate(SID, h2.bid, h2.batch, 'e1', null);
  assert.equal(rp.ok, true, '非 audit lane ⇒ 须放行');
  assert.equal(rp.declared, false, '非 audit lane ⇒ declared:false');
});

test('WD1-4 S14 扫描面：`needHuman: true` 只写在 audit 的 **outputs** 所指产物时同样被判声明', () => {
  // 阳性：声明落在 outputs ⇒ 须判声明并拒（改前只扫 produce ⇒ 零感知 = 假完成通道）
  const h = makeHarness({ outputsOnly: 'audit/out-only.md' });
  const r = h.gates.checkNeedHumanGate(SID, h.bid, h.batch, 'a1', null);
  assert.equal(r.declared, true, 'outputs 面的 needHuman 声明须被识别（S14）');
  assert.equal(r.ok, false, 'outputs 面声明+无证据 ⇒ 须拒');
  assert.equal(r.path, 'audit/out-only.md', '须点名 outputs 所指产物');
  // 阳性对照：同批次给证据 ⇒ 放行（证明上面的拒不是「本 lane 恒拒」）
  const r2 = h.gates.checkNeedHumanGate(SID, h.bid, h.batch, 'a1', 'human:user:2026-08-21:accept');
  assert.equal(r2.ok, true, '阳性对照：给证据须放行');
  // detectNeedHuman 直接核（同一单点检测器）
  assert.equal(detectNeedHuman(h.dir, ['audit/out-only.md']).declared, true, 'detectNeedHuman 须在 outputs 面命中');
});

test('WD1-5 handoff 消费点（`checkSettleHandoffGate` 的 humanException）：无证据⇒缺口 / 有证据⇒放行留痕', () => {
  const h = makeHarness();
  // 开启结算出口门：**必须走 DI 读端**（`createGates(root, {readConfig})`）——
  //   裸 `createGates(root)` 的配置真源是「热配置模块级生效快照」，本件未启动 watcher ⇒ 读到缺省（门关）
  //   ⇒ 会让本用例退化为「门关恒放行」的空转（这正是 AC-4 要堵的形态）。
  const cfg = { gates: { handoff: { entry: true, settle: true } } };
  const gates = createGates(h.root, { readConfig: () => cfg });
  // 门确实开了（阳性前置：否则下面的「拒」不可能成立）
  const disabledProbe = gates.checkSettleHandoffGate(SID, h.bid, h.batch, 'no-such-lane', null);
  assert.equal(disabledProbe.disabled, undefined, '前置：结算出口门须处于开启态（disabled 位不得出现）');
  // 本 lane（e1）有下游（a1 deps 含 e1）但**无已成立交接** ⇒ 门命中；差异只在 note
  const r1 = gates.checkSettleHandoffGate(SID, h.bid, h.batch, 'e1', null);
  assert.equal(r1.ok, false, '无证据 + 缺交接 ⇒ 须拒（缺口不是「无下游」）');
  assert.equal(r1.code, 'GATE_HANDOFF_MISSING', '拒码须为 GATE_HANDOFF_MISSING');
  assert.equal((r1.downstream ?? []).includes('a1'), true, '拒态须回显下游（证明拒因 = 有下游但缺交接）');
  // **同输入阳性对照**：只加 human 证据 ⇒ Leader 例外放行并留痕
  const r2 = gates.checkSettleHandoffGate(SID, h.bid, h.batch, 'e1', 'Leader 代裁：\nhuman:leader:2026-08-21:accept');
  assert.equal(r2.ok, true, '有 human 证据 ⇒ Leader 例外须放行');
  assert.equal(Boolean(r2.humanException), true, '放行须带 humanException 留痕');
  // 弱证据 ⇒ 仍按缺口拒（证明例外走的是**同一证据契约**，不是「note 非空即可」）
  for (const [name, note] of WEAK_3) {
    const rw = gates.checkSettleHandoffGate(SID, h.bid, h.batch, 'e1', note);
    assert.equal(rw.ok, false, '[' + name + '] 弱证据不得触发 Leader 例外');
  }
});

test('WD1-6 三处消费点结构自证：`humanEvidenceOf` 的调用点恰落在 exit / handoff / member-gates', () => {
  const PKG = path.join(import.meta.dirname, '..');
  const read = (rel) => fs.readFileSync(path.join(PKG, rel), 'utf8');
  const sites = [
    ['lib/state/gates/exit.js', 'exit 消费点'],
    ['lib/state/gates/handoff.js', 'handoff 消费点'],
    ['lib/state/store/member-gates.js', 'member-gates 消费点'],
  ];
  for (const [rel, label] of sites) {
    assert.equal(read(rel).includes('humanEvidenceOf('), true,
      label + ' 须经契约单点 humanEvidenceOf（禁各判一套）: ' + rel);
  }
  // 阳性对照：单点定义处存在，且**不是**在本件覆盖的三处之一（证明上面的包含断言有分辨力）
  assert.equal(read('lib/state/constants.js').includes('export function humanEvidenceOf'), true,
    '阳性对照：契约单点定义在 constants.js');
  // 反向锚：三处消费点之外不得再出现证据正则的私有副本（防第二套口径）
  const dup = ['lib/state/gates/exit.js', 'lib/state/gates/handoff.js', 'lib/state/store/member-gates.js']
    .filter((rel) => /HUMAN_EVIDENCE_RE\s*=/.test(read(rel)));
  assert.deepEqual(dup, [], '消费点不得私建证据正则（须复用 constants.js 单点）: ' + JSON.stringify(dup));
});

// ══════════════════════════════════════════════════════════════════════════════════════
// S-1 · 命令 gate 失败 + needHuman：**弱证据**被拒且 lane 留 review（DEBT-4 三项之一）
//   batch `punky-debt-sweep-20261020` · lane `e3-tests`｜判据源 `plan/scope.md` §5.1（A1-A4）
//
// 为什么必须带阳性对照（Lead 强调 / AC-18）：这条链路的拒绝是**两个条件**的合取
//   （命令 gate 失败 ∧ 证据不足）。若门恒拒（或命令恒失败导致永不放行），
//   「弱证据被拒」这条断言**在没有证据契约实现时也会绿** ⇒ 不可证伪。
//   故 A1/A2/A3 **每条同块内**先证明「合法证据在同一夹具形态上 → merged」，再证明本形态被拒。
//
// 路径 = `lib/state/store/member-gates.js` 的命令 gate 段（与 `gate-spawn-fail.test.js` GAP-05e 同一写路径）：
//   产物独立行 `gate: <必失败命令>` + `needHuman: true` ⇒ `cg.needHumanEscalation === true`
//   ⇒ merged 前置 `humanEvidenceOf(note)`：无证据 / 弱证据 ⇒ 抛 `GATE_NEEDHUMAN_PENDING`，lane 留 review。
// ══════════════════════════════════════════════════════════════════════════════════════

const SILENT = { warn() {}, info() {}, error() {} };
// 与既有 GAP-05a/05e 同一必失败命令（平台分支 GATE_EXIT_NONZERO / SPAWN_FAIL 均可，不影响本判据）
const FAILING_CMD = 'nonexistent_cmd_xyz';
const VALID_EVIDENCE = 'human:user@2026-10-20:accept';

/** 三层批次夹具：exec 产物声明「必失败命令 + needHuman:true」（与 gate-spawn-fail GAP-05e 同形）。 */
function setupCmdGateNeedHuman(batchId) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-s1-'));
  const store = createStore(root, { logger: SILENT });
  const S = 'sess-s1-cmdgate';
  const plan = buildWavePlan({
    batchId,
    team: 'generic',
    tasks: [
      { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
      { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/test-report.md'], cmd: 'code', deps: ['p1'] },
      // 三层契约要求：有 exec 层必须有 audit 层（`wave-plan.js#validateLayerContract`）——
      //   本用例不推进 a1，仅为让夹具通过建批期校验（与 `gate-spawn-fail.test.js` 的 TASKS 同形：
      //   a1 **不声明 consume**——一旦声明 consume，就必须锚到 plan 层判据源 `GATE_AUDIT_INPUT_MISSING`）。
      { id: 'a1', layer: 'audit', role: 'reviewer', produce: ['audit/acceptance.md'], cmd: 'review', deps: ['e1'] },
    ],
  });
  store.createBatch(S, { batchId, wavePlan: plan });
  const artDir = path.join(root, 'sessions', S, 'artifacts', batchId);
  fs.mkdirSync(path.join(artDir, 'plan'), { recursive: true });
  fs.mkdirSync(path.join(artDir, 'exec'), { recursive: true });
  fs.writeFileSync(path.join(artDir, 'plan', 'spec.md'),
    '# Spec\n## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准\n- x\n## 约束\n- y\n');
  fs.writeFileSync(path.join(artDir, 'exec', 'test-report.md'),
    '# 验证\n- ok\ngate: ' + FAILING_CMD + '\nneedHuman: true\n');
  return { root, store, S, batchId };
}

/** 把 exec lane 推到 review（plan lane 先 merged）。设置失败即抛（夹具不自洽要立刻暴露）。 */
function advanceToExecReview(store, S, batchId) {
  const set = (lane, to) => {
    const r = store.setMember(S, batchId, lane, to);
    if (r instanceof Error) throw r;
    return r;
  };
  set('p1', 'running'); set('p1', 'review'); set('p1', 'merged');
  set('e1', 'running'); set('e1', 'review');
}

/** 尝试把 exec lane 结算为 merged（返回批次或 Error）。 */
function tryMerged(store, S, batchId, note) {
  try { return store.setMember(S, batchId, 'e1', 'merged', note); } catch (e) { return e; }
}

test('S-1 命令 gate 失败 + needHuman：3 类弱证据全拒且 lane 留 review（每类先证合法证据 ⇒ merged）', () => {
  for (const [name, weakNote] of WEAK_3) {
    // ── 阳性对照（同块内先跑）：**合法证据**在同一夹具形态上必须 merged ────────────────
    const okFix = setupCmdGateNeedHuman('b-s1-ok-' + Math.random().toString(36).slice(2, 7));
    advanceToExecReview(okFix.store, okFix.S, okFix.batchId);
    const okRes = tryMerged(okFix.store, okFix.S, okFix.batchId, VALID_EVIDENCE);
    assert.equal(okRes instanceof Error, false,
      '[' + name + '] 阳性对照：合法证据 ' + VALID_EVIDENCE + ' 必须 merged（否则下面的拒绝可能是「门恒拒」）: '
      + String(okRes && okRes.message));
    assert.equal(okRes.lanes.e1, 'merged', '[' + name + '] 阳性对照：lane 须落 merged');

    // ── 被测：弱证据 ⇒ 抛 GATE_NEEDHUMAN_PENDING + lane 留 review ─────────────────
    const fix = setupCmdGateNeedHuman('b-s1-weak-' + Math.random().toString(36).slice(2, 7));
    advanceToExecReview(fix.store, fix.S, fix.batchId);
    const r = tryMerged(fix.store, fix.S, fix.batchId, weakNote);
    assert.equal(r instanceof Error, true, '[' + name + '] 弱证据必须拒 merged: ' + JSON.stringify(weakNote));
    assert.match(String(r.message), /GATE_NEEDHUMAN_PENDING/,
      '[' + name + '] 拒码须为 GATE_NEEDHUMAN_PENDING（实测: ' + String(r.message) + '）');
    const b = fix.store.readBatch(fix.S, fix.batchId);
    assert.equal(b.lanes.e1, 'review', '[' + name + '] 被拒后 lane 须仍为 review（不得被推进终态）');
    // 事件面留痕：escalation 转人工闸必须可核（零静默）
    assert.equal(b.events.some((e) => e.type === 'gate.exit_blocked' && e.escalation === true), true,
      '[' + name + '] 须落 gate.exit_blocked{escalation:true} 事件');
  }
});

test('S-1 A4 合法证据 → merged（与弱证据用例同夹具，差异只在 note）', () => {
  const fix = setupCmdGateNeedHuman('b-s1-a4');
  advanceToExecReview(fix.store, fix.S, fix.batchId);
  // 前置：无证据先拒（证明本夹具确实处在「需人工裁决」态，而非无需裁决的常态）
  const r0 = tryMerged(fix.store, fix.S, fix.batchId, undefined);
  assert.match(String(r0 && r0.message), /GATE_NEEDHUMAN_PENDING/, '前置：无证据须先被拒: ' + String(r0 && r0.message));
  // A4：合法证据（`@` 分隔形态）⇒ merged + human.decision 留痕
  const r = tryMerged(fix.store, fix.S, fix.batchId, VALID_EVIDENCE);
  assert.equal(r instanceof Error, false, 'A4 合法证据必须 merged: ' + String(r && r.message));
  assert.equal(r.lanes.e1, 'merged', 'A4 lane 须 merged');
  assert.equal(r.events.some((e) => e.type === 'human.decision' && e.lane === 'e1'), true,
    'A4 merged 须落 human.decision 留痕（note 可回溯）');
});
