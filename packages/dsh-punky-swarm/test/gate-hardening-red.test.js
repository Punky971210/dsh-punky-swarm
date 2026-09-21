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

// ─────────────────────────────────────────────────────────────────────────────
// RED 反例网（lane e3-red-tests ｜ 批次 gate-hardening-impl）
//
// 语义主题（用户裁决口径，2026-09-14）：
//   · 拒绝免检（no-exemption）——不得存在「缺声明 / 字段为空 ⇒ 直接 ok:true」的免检分支；
//   · presence 硬约束——声明的产物必须真实存在且为普通非空文件；
//   · 空内容须附原因——plan 内容「可写空并注明原因，但不能没有」；
//   · plan 产物指导下游执行 + 各层不得无依赖空转（A1 / B1 / B2 / B3 / B4）。
//
// 纪律（本文件是 RED 证据的唯一来源，故自身必须可核）：
//   ① 直连真实校验函数：import 运行期真实加载的 `lib/state/gates.js` 的 createGates
//      （宿主执行的就是 .js）+ `lib/assembly/flows.js` 的 resolveTeamFlows；不重写/不模拟判定逻辑。
//   ② 零落盘污染：批次根 = 自建 %TEMP% 目录（createGates(ROOT)），绝不触达 ~/.dsh/punky-preset/sessions/**。
//   ③ 每条断言的是**目标语义**：未实现前必须失败（RED），实现后应全部通过（GREEN）。
//   ④ **【r2 改写】** r1 的「严格语义 / 旧批语义由 `createdAt` 分居 STRICT_SEMANTICS_EPOCH 两侧」
//      **已作废**（用户裁决：旧批一律废弃，新代码不得设计任何 legacy 分支）。
//      本文件取 2099 / 2000 两极的**唯一目的**是**证伪 legacy 分支残留**：
//      同一构造在两极下**结论必须逐字相同**；任何差异 ⇒ 判失败（T27 / T28）。
//   ⑤ 每条用例用 t.diagnostic 输出**观测到的真实返回值**，使日志含原始证据而非仅结论。
//   ⑥ 「先观测全部子例、再断言」：多子例用例须把全部子例跑完并 diagnostic 后再断言，
//      避免首例失败吞掉其余子例的真实返回值（r1 已用此法）。
//
// 行号口径（p1 实测，非审计批过期行号）：
//   (a) exit 空过   → lib/state/gates.js:283-284
//   (b) entry 空过  → lib/state/gates.js:178-179
//   (c) plan 免检   → lib/state/gates.js:230-231
//   目录视同存在    → lib/state/gates.js:154-161（fileExistsNonEmpty）
//   无后缀路径原样返回 → lib/state/gates.js:151-153（resolveArtifact）
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGates } from '../lib/state/gates.js';
import { resolveTeamFlows } from '../lib/assembly/flows.js';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { assessC } from './helpers/gate-fixture.mjs';
import { writeTempTeam } from './helpers/team-fixture.mjs';
import { seedTeamAssetSkills } from './helpers/host-skills.mjs';

// 【P1 同步 · 宿主技能根】工具面建批用例走 `team:'software-team'` ⇒ 其声明技能必须**可解析**
//   （P1 §3：不可解析 / 技能根缺失 ⇒ `TEAM_ASSET_SKILLS_MISMATCH` 拒建批）⇒ 隔离 HOME 下先注入技能根。
seedTeamAssetSkills('software-team');

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ── 【r2 改写】createdAt 两极：**只用于证伪 legacy 分支残留**（非「旧批保护」） ──
// 用户裁决：旧批一律废弃、新代码不得有 legacy 分支 ⇒ 两极结论必须逐字相同。
const POLE_NEW = '2099-01-01T00:00:00.000Z';
const POLE_OLD = '2000-01-01T00:00:00.000Z';
const STRICT_CREATED_AT = POLE_NEW; // 兼容既有构造器默认值

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-gate-red-'));
const gates = createGates(ROOT);
const SID = 's-red';

const SPEC_OK = '# Spec\n## 验收标准\n- done\n## 约束\n- none\n';

// ── 基础构造器 ──
function artDir(bid) { return path.join(ROOT, 'sessions', SID, 'artifacts', bid); }
function writeArt(bid, rel, content) {
  const abs = path.join(artDir(bid), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}
function mkdirArt(bid, rel) {
  const abs = path.join(artDir(bid), rel);
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}
function mkBatch(bid, tasks, lanes = {}, extra = {}) {
  return {
    schema: 3, sessionId: SID, batchId: bid, phase: 'running',
    team: extra.team ?? null, teamsRoot: extra.teamsRoot ?? null,
    wavePlan: [{ wave: 1, tasks }], lanes, events: [],
    createdAt: extra.createdAt ?? STRICT_CREATED_AT, updatedAt: STRICT_CREATED_AT,
  };
}
// gateStatus 走磁盘读批次（readBatch），故需落一份批次 JSON 到自建根内
function writeBatchFile(batch) {
  const abs = path.join(ROOT, 'sessions', SID, 'batches', batch.batchId + '.json');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(batch), 'utf8');
  return abs;
}
// 前置自检：临时团队资产必须真的被加载（否则「豁免」会伪装成「资产加载失败 ⇒ 回落 legacy」）
function assertTeamLoads(teamRoot, team, check) {
  const r = resolveTeamFlows(team, { root: teamRoot });
  assert.equal(r.ok, true, '前置：临时团队资产须可加载 —— ' + JSON.stringify(r.problems));
  check(r.flows);
}

// ── 断言器 ──
function obs(t, label, r) { t.diagnostic(label + ' → ' + JSON.stringify(r)); }
function assertRejected(r, codes, why) {
  assert.equal(r.ok, false, why + ' ｜ 目标语义=拒（拒绝免检），实测=' + JSON.stringify(r));
  if (codes) {
    assert.ok(codes.includes(r.code),
      why + ' ｜ 期望拒因码 ∈ ' + JSON.stringify(codes) + '，实测=' + JSON.stringify(r.code));
  }
}
function assertAccepted(r, why) {
  assert.equal(r.ok, true, why + ' ｜ 目标语义=放行，实测=' + JSON.stringify(r));
}
// 【r2 新增】捕获 throw 形态的拒因（建批期拒建批是 throw，不是返回值）
async function rejectsWith(fn, re) {
  try {
    const v = await fn();
    return { threw: false, value: v };
  } catch (e) {
    return { threw: true, message: String(e && e.message), matched: re.test(String(e && e.message)) };
  }
}

// 【r2 新增】建批期落点用的最小 harness（与 test/audit-contract-gate.test.js 同构，零落盘污染）
const SESS = { agent: { session: { id: 'sess-e3-r2' } } };
function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-e3-r2-'));
  const store = createStore(root);
  const ctx = { tools: { register: () => {}, guard: () => {} }, logger: console };
  const tools = createTools(ctx, { store, root });
  const byName = Object.fromEntries(tools.tools.map((t) => [t.name, t]));
  // G1 前置（新门禁）：`wave_plan` 属 C 档动作 ⇒ 工具面用例先把本会话评估为 C（同 assign_check 落盘函数）
  assessC(store, SESS.agent.session.id, { rationale: 'fixture：gate-hardening 工具面建批前置评估（多线门禁治理 ⇒ C 档）' });
  return { root, store, byName };
}

const EXEC = (o = {}) => ({ id: 'e1', layer: 'exec', role: 'coder', cmd: 'code', ...o });
const PLAN = (o = {}) => ({ id: 'p1', layer: 'plan', role: 'designer', cmd: 'spec', ...o });
const AUDIT = (o = {}) => ({ id: 'a1', layer: 'audit', role: 'supervisor', cmd: 'accept', ...o });

// ═══════════════════════════════════════════════════════════════════════════
// 组 A · plan 门禁：拒绝免检 + presence 硬约束 + 空内容须附原因
// ═══════════════════════════════════════════════════════════════════════════

test('T01 plan lane 不声明 produce 也不声明 outputs ⇒ 必须拒（(c) 免检分支必须消失）', (t) => {
  const b = mkBatch('t01', [PLAN({})], { p1: 'review' }, { team: 'software-team' });
  const rContract = gates.checkPlanContract(SID, b.batchId, b, 'p1');
  obs(t, 'checkPlanContract(无 produce 无 outputs)', rContract);
  assertRejected(rContract, ['GATE_PLAN_NO_DECLARATION'],
    'gates.js:230-231 的 `!Array.isArray(t.produce) ⇒ {ok:true}` 是免检分支，目标语义下必须拒');
  const rExit = gates.checkExitGate(SID, b.batchId, b, 'p1');
  obs(t, 'checkExitGate(plan 层同构造)', rExit);
  assertRejected(rExit, ['GATE_PLAN_NO_DECLARATION'], 'exit 入口对 plan 层委派 checkPlanContract，同判据必须一致');
});

test('T02 plan 声明的产物不存在 ⇒ 拒（presence 硬约束 (i)）【回归保护】', (t) => {
  const b = mkBatch('t02', [PLAN({ produce: ['plan/spec.md'] })], { p1: 'review' }, { team: 'software-team' });
  const r = gates.checkPlanContract(SID, b.batchId, b, 'p1');
  obs(t, 'checkPlanContract(产物缺失)', r);
  assertRejected(r, ['GATE_PLAN_CONTRACT'], '声明了就必须存在');
  assert.ok(Array.isArray(r.problems) && r.problems.some((p) => /missing/.test(p)),
    'problems 须指名缺失产物：' + JSON.stringify(r.problems));
});

test('T03 plan 产物存在非空 + 裸标题齐备 ⇒ 放行（(ii) 正例对照）【回归保护】', (t) => {
  const b = mkBatch('t03', [PLAN({ produce: ['plan/spec.md'] })], { p1: 'review' }, { team: 'software-team' });
  writeArt(b.batchId, 'plan/spec.md', SPEC_OK);
  const r = gates.checkPlanContract(SID, b.batchId, b, 'p1');
  obs(t, 'checkPlanContract(齐备)', r);
  assertAccepted(r, '齐备产物不得被新判据误伤');
});

test('T04 plan spec 缺裸标题 ⇒ 拒（含 `## 5. 验收标准` 编号变体负例）【回归保护】', (t) => {
  const b1 = mkBatch('t04a', [PLAN({ produce: ['plan/design-spec.md'] })], { p1: 'review' }, { team: 'software-team' });
  writeArt(b1.batchId, 'plan/design-spec.md', '# S\n## 约束\n- y\n'); // 缺 ## 验收标准
  const r1 = gates.checkPlanContract(SID, b1.batchId, b1, 'p1');
  obs(t, '缺 ## 验收标准', r1);
  assertRejected(r1, ['GATE_PLAN_CONTRACT'], '缺裸标题即拒');

  const b2 = mkBatch('t04b', [PLAN({ produce: ['plan/design-spec.md'] })], { p1: 'review' }, { team: 'software-team' });
  writeArt(b2.batchId, 'plan/design-spec.md', '# S\n## 5. 验收标准\n- x\n## 约束\n- y\n'); // 编号变体
  const r2 = gates.checkPlanContract(SID, b2.batchId, b2, 'p1');
  obs(t, '编号变体 `## 5. 验收标准`', r2);
  assertRejected(r2, ['GATE_PLAN_CONTRACT'], '引擎按**字面裸标题**匹配，编号变体不得因「看起来有标题」而放行');
});

test('T05 plan 产物不命中 artifact_globs 且正文无任何判据 ⇒ 拒（内容面不得因 glob 未命中而归零）', (t) => {
  const b = mkBatch('t05', [PLAN({ produce: ['plan/design.md'] })], { p1: 'review' }, { team: 'software-team' });
  writeArt(b.batchId, 'plan/design.md', '# Design\n本文件既无 `## 验收标准` 也无 `## 约束`\n');
  const r = gates.checkPlanContract(SID, b.batchId, b, 'p1');
  obs(t, 'checkPlanContract(glob 未命中 + 无判据)', r);
  assertRejected(r, ['GATE_PLAN_CONTRACT'],
    'software-team 的 artifact_globs=["plan/*spec.md"] ⇒ plan/design.md 零内容校验（gates.js:243-246 经 sectionProblemsOf 早退）；'
    + '目标语义要求 lane 全部产物至少一份携带 `## 验收标准` 判据');
});

test('T06 plan task-tree.json 为非法 JSON（声明在 produce 内）⇒ 拒【回归保护】', (t) => {
  const b = mkBatch('t06', [PLAN({ produce: ['plan/task-tree.json'] })], { p1: 'review' }, { team: 'software-team' });
  writeArt(b.batchId, 'plan/task-tree.json', '{ 这不是合法 JSON');
  const r = gates.checkPlanContract(SID, b.batchId, b, 'p1');
  obs(t, 'checkPlanContract(produce 内非法 JSON)', r);
  assertRejected(r, ['GATE_PLAN_CONTRACT'], '.json 可解析性已被检查（gates.js:247-254）');
});

test('T07 plan 非法 JSON 仅声明在 outputs ⇒ 拒（被检面 = produce ∪ outputs）', (t) => {
  const b = mkBatch('t07', [PLAN({ produce: ['plan/spec.md'], outputs: ['plan/task-tree.json'] })],
    { p1: 'review' }, { team: 'software-team' });
  writeArt(b.batchId, 'plan/spec.md', SPEC_OK);
  writeArt(b.batchId, 'plan/task-tree.json', '{ 这不是合法 JSON');
  const r = gates.checkPlanContract(SID, b.batchId, b, 'p1');
  obs(t, 'checkPlanContract(非法 JSON 只在 outputs)', r);
  assertRejected(r, ['GATE_PLAN_CONTRACT'],
    'gates.js:228-231 只遍历 t.produce ⇒ 只声明在 outputs 的产物零校验；'
    + '设计 §2.3① 要求被检面恒为 produce ∪ outputs');
});

test('T08 plan 产物存在但内容为空（未附原因）⇒ 拒（presence 硬约束 (iii)）【回归保护】', (t) => {
  const b1 = mkBatch('t08a', [PLAN({ produce: ['plan/design-spec.md'] })], { p1: 'review' }, { team: 'software-team' });
  writeArt(b1.batchId, 'plan/design-spec.md', ''); // 0 字节
  const r1 = gates.checkPlanContract(SID, b1.batchId, b1, 'p1');
  obs(t, '空内容（0 字节，无原因）', r1);
  assertRejected(r1, ['GATE_PLAN_CONTRACT'], '0 字节被 fileExistsNonEmpty 判缺失从而拒');

  const b2 = mkBatch('t08b', [PLAN({ produce: ['plan/design-spec.md'] })], { p1: 'review' }, { team: 'software-team' });
  writeArt(b2.batchId, 'plan/design-spec.md', '   \n\t\n'); // 仅空白
  const r2 = gates.checkPlanContract(SID, b2.batchId, b2, 'p1');
  obs(t, '空内容（仅空白，无原因）', r2);
  assertRejected(r2, ['GATE_PLAN_CONTRACT'], '「仅空白」= 语义空内容，无原因即拒');
});

test('T09 plan 产物内容为空但附独立行注明原因 ⇒ 必须放行（「可空但不可无」确证用例）', (t) => {
  // 取 glob 命中路径（plan/*spec.md）：这是当前唯一必拒的形态 ⇒ 构成真正可区分的 RED。
  // 注：`empty-reason:` 标记名由 Leader 建议、design 尚未定稿；若 design 改名，本用例须同步。
  const probe = (bid, producePath, content) => {
    const b = mkBatch(bid, [PLAN({ produce: [producePath] })], { p1: 'review' }, { team: 'software-team' });
    writeArt(b.batchId, producePath, content);
    return gates.checkPlanContract(SID, b.batchId, b, 'p1');
  };
  const rHit = probe('t09', 'plan/design-spec.md', 'empty-reason: 本轮无新增判据，正文由 plan/spec.md 承载\n');
  const rMiss = probe('t09b', 'plan/design.md', 'empty-reason: 本轮无新增判据\n');
  const rEmpty = probe('t09c', 'plan/design-spec.md', 'empty-reason:\n');
  obs(t, '(iv-a) 空内容 + 原因行（glob 命中路径）', rHit);
  obs(t, '(iv-b) 空内容 + 原因行（glob 未命中路径）', rMiss);
  obs(t, '(iv-c) 空内容 + 原因行为空', rEmpty);

  assertAccepted(rHit,
    '用户口径：「plan 内容可写空并注明原因，但不能没有」⇒ 空内容 + 原因行必须放行（当前必拒 GATE_PLAN_CONTRACT）');
  assertAccepted(rMiss, '原因行语义须与产物名是否命中 glob 无关');
  assertRejected(rEmpty, ['GATE_PLAN_CONTRACT'], '原因行必须携带非空文本，否则「注明原因」形同虚设');
});

test('T10 parity：plan 侧对「缺判据来源」的处置强度不得弱于已完工的 audit 侧', (t) => {
  // audit 侧（已完工、全局生效、无豁免）作为强度基准
  const bAudit = mkBatch('t10-audit', [
    EXEC({ consume: ['plan/spec.md'], outputs: ['exec/e1/o.md'], deps: ['p1'] }),
    AUDIT({ consume: ['exec/e1/o.md'], produce: ['audit/a.md'], deps: ['e1'] }),
  ], { e1: 'merged', a1: 'running' }, { team: 'software-team' });
  writeArt(bAudit.batchId, 'exec/e1/o.md', 'out');
  const rAudit = gates.checkEntryGate(SID, bAudit.batchId, bAudit, 'a1');
  obs(t, 'parity 基准：audit 缺 plan 判据锚点', rAudit);
  assertRejected(rAudit, ['GATE_AUDIT_INPUT_MISSING'], '前置基准：audit 侧确实「缺判据来源即拒」');

  // plan 侧同一情形（无产物声明 ⇒ 无判据来源）必须同强度
  const bPlan = mkBatch('t10-plan', [PLAN({})], { p1: 'review' }, { team: 'software-team' });
  const rPlan = gates.checkPlanContract(SID, bPlan.batchId, bPlan, 'p1');
  obs(t, 'parity 对照：plan 缺产物声明', rPlan);
  assertRejected(rPlan, null,
    'parity 违规：audit 侧 ok=' + rAudit.ok + '（码 ' + rAudit.code + '）而 plan 侧 ok=' + rPlan.ok
    + ' ⇒ plan 侧强度弱于 audit 侧（用户要求「可参考已完工的 audit 门禁设计」）');
});

test('T11 免检路径不可达：空/缺声明全排列扫描（任何一条 ok:true 即违规）', (t) => {
  const exempt = [];
  // (1) plan/exec/audit × {produce, outputs} × {undefined, null, []}
  for (const layer of ['plan', 'exec', 'audit']) {
    for (const field of ['produce', 'outputs']) {
      for (const val of [undefined, null, []]) {
        const bid = 't11-' + layer + '-' + field + '-' + String(val);
        const task = { id: 'L1', layer, role: 'coder', cmd: 'c' };
        if (val !== undefined) task[field] = val;
        const b = mkBatch(bid, [task], { L1: 'review' }, { team: 'software-team' });
        const r = layer === 'plan'
          ? gates.checkPlanContract(SID, bid, b, 'L1')
          : gates.checkExitGate(SID, bid, b, 'L1');
        if (r.ok === true) {
          exempt.push('(' + layer + ' 层, ' + field + '=' + (val === undefined ? '未声明' : JSON.stringify(val)) + ')');
        }
      }
    }
  }
  // (2) exec consume 空/缺 × 团队声明形态（含未声明 entry_requires 的团队）
  const noEntryRoot = writeTempTeam('punky-gate-red-team-', 't11-no-entry', (a) => {
    a.team = 't11-no-entry';
    delete a.flows.exec.entry_requires;
  });
  assertTeamLoads(noEntryRoot, 't11-no-entry', (f) => {
    assert.equal(f.exec.entry_requires, undefined, '前置：临时团队确实未声明 entry_requires');
  });
  for (const [tname, troot] of [['software-team', null], ['generic', null], ['t11-no-entry', noEntryRoot]]) {
    for (const cval of [undefined, null, []]) {
      const bid = 't11c-' + tname + '-' + String(cval);
      const task = { id: 'E1', layer: 'exec', role: 'coder', outputs: ['exec/o.md'], cmd: 'c' };
      if (cval !== undefined) task.consume = cval;
      const b = mkBatch(bid, [task], { E1: 'pending' }, { team: tname, teamsRoot: troot });
      const r = gates.checkEntryGate(SID, bid, b, 'E1');
      if (r.ok === true) {
        exempt.push('(entry, 团队=' + tname + ', consume=' + (cval === undefined ? '未声明' : JSON.stringify(cval)) + ')');
      }
    }
  }
  t.diagnostic('免检排列命中数 = ' + exempt.length);
  for (const e of exempt) t.diagnostic('  免检: ' + e);
  assert.deepEqual(exempt, [],
    '「拒绝免检」违规：以下「空/缺声明」排列仍直接返回 ok:true（免检路径可达，count=' + exempt.length + '）:\n  '
    + exempt.join('\n  '));
});

// ═══════════════════════════════════════════════════════════════════════════
// 组 B · (a) exit 门禁
// ═══════════════════════════════════════════════════════════════════════════

test('T12 exec lane 只声明 produce、不声明 outputs ⇒ 拒（(a) 空过点）', (t) => {
  const b = mkBatch('t12', [EXEC({ produce: ['exec/only.md'] })], { e1: 'review' }, { team: 'software-team' });
  const r = gates.checkExitGate(SID, b.batchId, b, 'e1');
  obs(t, 'checkExitGate(produce-only)', r);
  // 设计 R-01 记目标码为 GATE_EXIT_NO_DECLARATION，但 produce 实为已声明且产物缺失 ⇒
  // 语义上亦可为 GATE_EXIT_MISSING_EXEC。二者均属「拒」，故接受两者（码歧义已记入产物待 e1 定稿）。
  assertRejected(r, ['GATE_EXIT_NO_DECLARATION', 'GATE_EXIT_MISSING_EXEC'],
    'software-team 的 exec.produce_field="outputs" ⇒ gates.js:282-284 取 t.outputs 非数组即 {ok:true}；'
    + '目标语义：被检面恒为 produce ∪ outputs');
});

test('T13 exec lane 产物字段为空数组（produce 与 outputs 皆空）⇒ 拒（(a) 空过点）', (t) => {
  const probe = (bid, task) => {
    const b = mkBatch(bid, [EXEC(task)], { e1: 'review' }, { team: 'software-team' });
    return gates.checkExitGate(SID, b.batchId, b, 'e1');
  };
  const r1 = probe('t13a', { produce: [], outputs: [] });
  const r2 = probe('t13b', { produce: null, outputs: [] });
  obs(t, 'produce=[] && outputs=[]', r1);
  obs(t, 'produce=null && outputs=[]', r2);
  assertRejected(r1, ['GATE_EXIT_NO_DECLARATION'], '两者皆空 ⇒ 拒（设计 §2.1②）');
  assertRejected(r2, ['GATE_EXIT_NO_DECLARATION'], '空数组即「零声明」，不得免检');
});

test('T14 exec lane 声明 outputs 但文件缺失 / 为空文件 ⇒ 拒【回归保护】', (t) => {
  const b1 = mkBatch('t14a', [EXEC({ outputs: ['exec/missing.md'] })], { e1: 'review' }, { team: 'software-team' });
  const r1 = gates.checkExitGate(SID, b1.batchId, b1, 'e1');
  obs(t, 'outputs 文件缺失', r1);
  assertRejected(r1, ['GATE_EXIT_MISSING_EXEC'], '存在性已检查');

  const b2 = mkBatch('t14b', [EXEC({ outputs: ['exec/empty.md'] })], { e1: 'review' }, { team: 'software-team' });
  writeArt(b2.batchId, 'exec/empty.md', '');
  const r2 = gates.checkExitGate(SID, b2.batchId, b2, 'e1');
  obs(t, 'outputs 空文件', r2);
  assertRejected(r2, ['GATE_EXIT_MISSING_EXEC'], '空文件必须仍判缺失（size 0 不得视同存在）');
});

test('T15 【r2 改写】目录/文件声明形态二分：声明以 `/` 结尾 ⇒ 目录语义（须存在且非空）；不以 `/` 结尾 ⇒ 文件语义（须非空文件，给目录 ⇒ 拒）', (t) => {
  // Leader 裁定采纳**候选 B**（原 R-08「目录一律拒」被替换）：
  //   声明路径以 `/` 结尾 ⇒ **目录语义**：目录必须存在且**非空** ⇒ 放行；
  //   声明路径不以 `/` 结尾 ⇒ **文件语义**：必须是**非空文件**；给目录 ⇒ 拒。
  //   理由（E-1）：目录语义只能靠声明**显式表达**（`/` 结尾），不得再把目录**隐式**当文件放行
  //   ——这才是 r1 的 T15 真正要钉死的东西（现实现 gates.js:154-161 `st.isDirectory() → true` 对两种声明无条件放行）。
  const probe = (bid, decl, shape) => {
    const b = mkBatch(bid, [EXEC({ outputs: [decl] })], { e1: 'review' }, { team: 'software-team' });
    if (shape === 'dir-nonempty') {
      mkdirArt(b.batchId, decl.replace(/\/$/, ''));
      fs.writeFileSync(path.join(artDir(b.batchId), decl.replace(/\/$/, ''), 'child.txt'), 'x', 'utf8');
    }
    else if (shape === 'dir-empty') mkdirArt(b.batchId, decl.replace(/\/$/, ''));
    else if (shape === 'file-nonempty') writeArt(b.batchId, decl, 'print(1)\n');
    else if (shape === 'file-empty') writeArt(b.batchId, decl, '');
    else if (shape === 'none') { /* 不落盘 */ }
    return gates.checkExitGate(SID, b.batchId, b, 'e1');
  };

  // 先观测全部子例，再断言（避免首例失败吞掉其余证据）
  const R = {
    a: probe('t15a', 'exec/e1/data/', 'dir-nonempty'),   // 目录语义 · 非空目录 ⇒ 放行
    b: probe('t15b', 'exec/e1/data/', 'dir-empty'),      // 目录语义 · 空目录   ⇒ 拒
    c: probe('t15c', 'exec/e1/data', 'dir-nonempty'),    // 文件语义 · 给目录   ⇒ 拒
    d: probe('t15d', 'exec/e1/main.py', 'file-nonempty'),// 文件语义 · 非空文件 ⇒ 放行
    e: probe('t15e', 'exec/e1/main.py', 'file-empty'),   // 文件语义 · 0 字节   ⇒ 拒
    f: probe('t15f', 'exec/e1/weird/', 'file-nonempty'), // 目录语义 · 给文件   ⇒ 拒
    g: probe('t15g', 'exec/e1/absent/', 'none'),         // 目录语义 · 不存在   ⇒ 拒
  };
  obs(t, '(a) 声明 "exec/e1/data/" + 非空目录（目录语义正例）', R.a);
  obs(t, '(b) 声明 "exec/e1/data/" + 空目录（目录语义负例）', R.b);
  obs(t, '(c) 声明 "exec/e1/data"（无 "/" ⇒ 文件语义）+ 给目录', R.c);
  obs(t, '(d) 声明 "exec/e1/main.py"（文件语义）+ 非空文件', R.d);
  obs(t, '(e) 声明 "exec/e1/main.py"（文件语义）+ 0 字节文件', R.e);
  obs(t, '(f) 声明 "exec/e1/weird/"（目录语义）+ 实际是非空文件', R.f);
  obs(t, '(g) 声明 "exec/e1/absent/"（目录语义）+ 不存在', R.g);

  assertAccepted(R.a, '二分语义 · 正例：`/` 结尾声明 ⇒ 目录存在且非空 ⇒ 必须放行');
  assertRejected(R.b, ['GATE_ARTIFACT_EMPTY_NO_REASON', 'GATE_ARTIFACT_NOT_A_FILE'],
    '二分语义 · 负例：`/` 结尾但目录为空 ⇒ 「目录非空」不满足 ⇒ 拒（现实现无条件放行）');
  assertRejected(R.c, ['GATE_ARTIFACT_NOT_A_FILE'],
    '二分语义 · 负例：**不带** `/` 结尾即文件语义，给目录 ⇒ 拒'
    + '（这正是现实现 gates.js:154-161 `st.isDirectory() → true` 的漏洞：目录隐式冒充文件）');
  assertAccepted(R.d, '二分语义 · 正例：文件语义 + 非空文件 ⇒ 放行（防新判据误伤）');
  assertRejected(R.e, ['GATE_ARTIFACT_EMPTY_NO_REASON', 'GATE_EXIT_MISSING_EXEC'],
    '二分语义 · 负例：文件语义 + 0 字节 ⇒ 拒（与 R-31 的 0 字节规则同向）');
  assertRejected(R.f, ['GATE_ARTIFACT_NOT_A_FILE'],
    '二分语义 · 负例：`/` 结尾声明目录语义，实际是非空文件 ⇒ 形态不符 ⇒ 拒');
  assertRejected(R.g, ['GATE_ARTIFACT_NOT_A_FILE', 'GATE_EXIT_MISSING_EXEC'],
    '二分语义 · 负例：`/` 结尾但目录不存在 ⇒ 拒');
  t.diagnostic('【分歧留痕】本用例把「无 "/" 结尾的目录声明」判为拒；'
    + '既有 test/gates.test.js:122-133 / :148-160 断言「目录型产物应通过」（其声明 `exec/repos/` 带 `/`、'
    + '`exec/e1/data/` 带 `/`，按二分语义应改为「非空目录放行」，与该两条的通过意图同向）。'
    + 'R-34 已按裁定 ② 同步改写该两条并保留 Bug1 意图注释。');
});

test('T16 批次产物根外的绝对路径被视同存在 ⇒ 拒（运行期复核产物归属）', (t) => {
  const outside = path.join(ROOT, 'outside-artifact.md'); // 在 artifacts/<bid>/ 之外
  fs.writeFileSync(outside, 'x', 'utf8');
  const b = mkBatch('t16', [EXEC({ outputs: [outside] })], { e1: 'review' }, { team: 'software-team' });
  const r = gates.checkExitGate(SID, b.batchId, b, 'e1');
  obs(t, 'checkExitGate(根外绝对路径产物)', r);
  assertRejected(r, ['GATE_ARTIFACT_OUTSIDE_ROOT'],
    'gates.js:151-153 resolveArtifact 对绝对路径原样返回 ⇒ 任意主机文件都可充作本批产物')
});

// ═══════════════════════════════════════════════════════════════════════════
// 组 C · (b) entry 门禁
// ═══════════════════════════════════════════════════════════════════════════

test('T17 团队声明 entry_requires:[consume] + lane consume 为空 ⇒ 拒派【回归保护】', (t) => {
  const b = mkBatch('t17', [EXEC({ consume: [], outputs: ['exec/o.md'] })], { e1: 'pending' }, { team: 'software-team' });
  const r = gates.checkEntryGate(SID, b.batchId, b, 'e1');
  obs(t, 'checkEntryGate(software-team, consume=[])', r);
  assertRejected(r, ['GATE_ENTRY_MISSING'], '显式声明的强制项已生效');
});

test('T18 团队未声明 entry_requires（或 flows:null）+ lane consume 为空 ⇒ 仍必须拒（consume 强制不依赖团队声明）', (t) => {
  const noEntryRoot = writeTempTeam('punky-gate-red-team-', 't18-no-entry', (a) => {
    a.team = 't18-no-entry';
    delete a.flows.exec.entry_requires;
  });
  assertTeamLoads(noEntryRoot, 't18-no-entry', (f) => {
    assert.equal(f.exec.entry_requires, undefined, '前置：临时团队确实未声明 entry_requires');
    assert.equal(f.exec.produce_field, 'outputs', '前置：其余声明保持与 software-team 同源');
  });
  const b1 = mkBatch('t18a', [EXEC({ consume: [], outputs: ['exec/o.md'] })],
    { e1: 'pending' }, { team: 't18-no-entry', teamsRoot: noEntryRoot });
  const r1 = gates.checkEntryGate(SID, b1.batchId, b1, 'e1');
  const b2 = mkBatch('t18b', [EXEC({ outputs: ['exec/o.md'] })], { e1: 'pending' }, { team: 'generic' });
  const r2 = gates.checkEntryGate(SID, b2.batchId, b2, 'e1');
  const b3 = mkBatch('t18c', [EXEC({ consume: null, outputs: ['exec/o.md'] })],
    { e1: 'pending' }, { team: 't18-no-entry', teamsRoot: noEntryRoot });
  const r3 = gates.checkEntryGate(SID, b3.batchId, b3, 'e1');
  obs(t, '未声明 entry_requires, consume=[]', r1);
  obs(t, 'generic 无资产, consume 未声明', r2);
  obs(t, '未声明 entry_requires, consume=null', r3);

  assertRejected(r1, ['GATE_ENTRY_MISSING'], 'flows.js:112-114 仅在显式声明时才强制 ⇒ 缺声明走的是最宽档');
  assertRejected(r2, ['GATE_ENTRY_MISSING'], 'generic 批次（无 team-asset ⇒ flows:null）不得零依赖空转');
  assertRejected(r3, ['GATE_ENTRY_MISSING'], 'consume=null 与 [] 同判');
});

// ═══════════════════════════════════════════════════════════════════════════
// 组 D · B2：无 layer / 脱轨 lane 不得整 lane 免检
// ═══════════════════════════════════════════════════════════════════════════

test('T19 lane 无 layer 且批次内含层声明 ⇒ 拒（不得整 lane 免检）', (t) => {
  const b = mkBatch('t19', [
    EXEC({ outputs: ['exec/x.md'] }),
    { id: 'x1', role: 'coder', cmd: 'code', outputs: ['exec/none.md'] }, // 无 layer
  ], { e1: 'review', x1: 'review' }, { team: 'software-team' });
  const r = gates.checkExitGate(SID, b.batchId, b, 'x1');
  obs(t, 'checkExitGate(无 layer lane, 批次含层声明)', r);
  assertRejected(r, ['GATE_LANE_LAYER_MISSING'],
    'gates.js:276-277 `if (!t || !t.layer) return {ok:true}` = 整 lane 免检（用户定性为「最彻底的空转」）');
});

test('T20 lane 在 batch.lanes 但不在 wavePlan.tasks ⇒ 拒 + gateStatus 报 orphan（不得退化为 generic）', (t) => {
  const b = mkBatch('t20', [EXEC({ outputs: ['exec/x.md'] })],
    { e1: 'review', zz: 'review' }, { team: 'software-team' });
  const r = gates.checkExitGate(SID, b.batchId, b, 'zz');
  obs(t, 'checkExitGate(脱轨 lane zz)', r);
  assertRejected(r, ['GATE_LANE_NOT_IN_PLAN'], 'taskOf→null 当前直接 {ok:true}');

  writeBatchFile(b);
  const gs = gates.gateStatus(SID, b.batchId, 'zz');
  obs(t, 'gateStatus(zz)', gs);
  assert.equal(gs.gates, 'orphan', '状态损坏须显式标 orphan（当前退化为 "generic"，面板会误导为「正常无层批」）');
});

// ═══════════════════════════════════════════════════════════════════════════
// 组 E · B3：complete 门不得走 generic 捷径
// ═══════════════════════════════════════════════════════════════════════════

test('T21 批次既无 exec 也无 audit ⇒ 不得直接 ok 收口（零执行零验收）', (t) => {
  const b = mkBatch('t21', [{ id: 't1', cmd: 'x' }, { id: 't2', cmd: 'y' }],
    { t1: 'merged', t2: 'merged' }, { team: 'generic' });
  const r = gates.checkCompleteGate(b);
  obs(t, 'checkCompleteGate(无 exec 无 audit)', r);
  assertRejected(r, ['GATE_COMPLETE_NO_TIER'],
    'gates.js:463-464 `if (layers.exec.length===0 && layers.audit.length===0) return {ok:true}` = generic 捷径');
});

test('T34 【r2 新增 / R-35 Q-6】B2 + B3 定稿：无 layer 的 lane **不得整 lane 免检**；无 exec 且无 audit 的批次 **不得 complete**', (t) => {
  // 用户裁决 Q-6 = ①：**废除 generic 豁免**（成因「兼容非软件任务」已被团队资产化取代 —— 内置四团队 +
  // 临时团队 `wave_plan({team, teamsRoot})` 走同一校验器、同一门禁语义）。
  // B2/B3 按定稿判拒，无 ⏳ 待裁决项。
  //
  // B2 ① 无 layer（批次含层声明）—— 与 T19 同构造，此处作为 Q-6 的**显式裁决落点**并列断言；
  const bNoLayer = mkBatch('t34-b2-nolayer', [
    EXEC({ outputs: ['exec/x.md'] }),
    { id: 'x1', role: 'coder', cmd: 'code', outputs: ['exec/none.md'] },
  ], { e1: 'review', x1: 'review' }, { team: 'software-team' });
  const rNoLayer = gates.checkExitGate(SID, bNoLayer.batchId, bNoLayer, 'x1');

  // B2 ② lane 在 batch.lanes 但不在 wavePlan.tasks（脱轨）
  const bOrphan = mkBatch('t34-b2-orphan', [EXEC({ outputs: ['exec/x.md'] })],
    { e1: 'review', zz: 'review' }, { team: 'software-team' });
  const rOrphan = gates.checkExitGate(SID, bOrphan.batchId, bOrphan, 'zz');

  // B3 ① 无 exec 且无 audit（generic 批）
  const bNoTier = mkBatch('t34-b3', [{ id: 't1', cmd: 'x' }, { id: 't2', cmd: 'y' }],
    { t1: 'merged', t2: 'merged' }, { team: 'generic' });
  const rNoTier = gates.checkCompleteGate(bNoTier);

  // B3 ② 完整批但 wavePlan 全无 layer（等价构造）
  const bNoLayerTier = mkBatch('t34-b3-nolayer', [{ id: 't1', cmd: 'x' }, { id: 't2', cmd: 'y' }],
    { t1: 'merged', t2: 'merged' }, { team: 'software-team' });
  const rNoLayerTier = gates.checkCompleteGate(bNoLayerTier);

  obs(t, '(B2①) 无 layer lane（批次含层声明）⇒ exit', rNoLayer);
  obs(t, '(B2②) 脱轨 lane zz（不在 wavePlan.tasks）⇒ exit', rOrphan);
  obs(t, '(B3①) generic 批：无 exec 无 audit ⇒ complete', rNoTier);
  obs(t, '(B3②) software-team 批但 wavePlan 全无 layer ⇒ complete', rNoLayerTier);

  assertRejected(rNoLayer, ['GATE_LANE_LAYER_MISSING'],
    'B2 定稿：无 `layer` 的 lane 不得整 lane 免检（gates.js:276-277 `if (!t || !t.layer) return {ok:true}` 须删）');
  assertRejected(rOrphan, ['GATE_LANE_NOT_IN_PLAN'],
    'B2 定稿：lane 在 batch.lanes 却不在 wavePlan.tasks ⇒ 拒（不得退化为 generic 免检）');
  assertRejected(rNoTier, ['GATE_COMPLETE_NO_TIER'],
    'B3 定稿：无 exec 且无 audit 的批次不得 complete（generic 豁免已废除）');
  assertRejected(rNoLayerTier, ['GATE_COMPLETE_NO_TIER'],
    'B3 定稿：wavePlan 全无 layer 与「无 exec 无 audit」同判（层声明缺失不得成为收口通道）');
  t.diagnostic('Q-6 定性：generic 豁免的**成因（兼容非软件任务）已消失**（四内置团队 + 临时团队同一校验器）'
    + '⇒ 属「成因已消失的兼容条款」而非「被推翻的有意设计」（convergence-design.md §12 D-2）。');
});

test('T35 【r2 新增 / R-32 判据同源】presence / `empty-reason` 判据必须**同一实现**（同一 presenceJudge、两 mode），禁两套逻辑', (t) => {
  // 设计 §3（spec.md）+ 原则③（convergence-design.md）：`presenceJudge({mode,layer,declared,declaredKind,abs,content})`
  //   是**唯一实现**；`mode:'declare'` = 建批期静态面（P1–P5），`mode:'runtime'` = 运行期含文件面（P1–P9）。
  //   两个调用点：建批期 `lib/wave-plan.ts`（e2 导入）+ 运行期 `lib/state/gates.ts`（e1 自用）。
  //
  // 本用例的 RED 判据分三层（层层可核）：
  //   L1 入口唯一：`createGates(root)` 必须导出 `presenceJudge`（否则「同一函数两 mode」无从成立）；
  //   L2 可区分性：必须存在**同一输入在两 mode 下结论不同**的构造 —— 这正是「两套逻辑」与
  //      「同一实现的两种 mode」的可分辨证据（静态面天然拿不到文件内容 ⇒ 文件面判据只能在 runtime 生效）；
  //   L3 源码唯一性：`lib/state/gates.js` 是 `presenceJudge` 的**唯一实现处**，且 `lib/wave-plan.js`
  //      建批期入口**引用**它（而非自带一套判定）。
  const typeofJudge = typeof gates.presenceJudge;
  t.diagnostic('typeof gates.presenceJudge = ' + typeofJudge);

  // L2：两 mode 的分辨构造（不依赖闸门是否已落地 —— 先取回调用结果，再断言）
  let declareVerdict = { notImplemented: true };
  let runtimeVerdict = { notImplemented: true };
  if (typeofJudge === 'function') {
    // 声明**以数组形态**给出（`['plan/x.md']`）+ 文件面不存在 ⇒ runtime ⇒ 拒
    declareVerdict = gates.presenceJudge({
      mode: 'declare', layer: 'plan', declared: ['plan/x.md'], declaredKind: 'array', abs: null, content: null,
    });
    runtimeVerdict = gates.presenceJudge({
      mode: 'runtime', layer: 'plan', declared: ['plan/x.md'], declaredKind: 'array', abs: null, content: null,
    });
  }
  obs(t, '(L2) presenceJudge(mode=declare)', declareVerdict);
  obs(t, '(L2) presenceJudge(mode=runtime)', runtimeVerdict);

  // L1
  assert.equal(typeofJudge, 'function',
    '判据同源缺失：`createGates(root)` 未导出 `presenceJudge` —— 设计 §3 明定它是 presence 判据的**唯一实现**'
    + '（两 mode + 两调用点）；未导出即无法证明「建批期与运行期同一实现」，只能各自为政（禁两套逻辑）');

  // L2
  assert.ok(declareVerdict && runtimeVerdict
    && JSON.stringify(declareVerdict) !== JSON.stringify(runtimeVerdict),
    '两 mode 必须**可区分**（否则无法证明 mode 真的分流）：declare=' + JSON.stringify(declareVerdict)
    + ' / runtime=' + JSON.stringify(runtimeVerdict)
    + '；静态面拿不到文件内容 ⇒ 文件面判据只能在 runtime 模式生效');

  // L3
  const gatesSrc = fs.readFileSync(path.join(PKG, 'lib/state/gates.js'), 'utf8');
  const waveSrc = fs.readFileSync(path.join(PKG, 'lib/wave-plan.js'), 'utf8');
  const gatesDefs = (gatesSrc.match(/function\s+presenceJudge\b/g) ?? []).length;
  const waveDefs = (waveSrc.match(/function\s+presenceJudge\b/g) ?? []).length;
  const waveRefs = waveSrc.includes('presenceJudge');
  const gatesHasMarker = gatesSrc.includes('empty-reason');
  t.diagnostic('L3 计数：gates.js presenceJudge 定义处 = ' + gatesDefs
    + '；wave-plan.js 定义处 = ' + waveDefs + '；wave-plan.js 引用 = ' + waveRefs);
  t.diagnostic('L3 gates.js 含 `empty-reason` marker = ' + gatesHasMarker);

  assert.equal(gatesDefs, 1,
    '`presenceJudge` 在 `lib/state/gates.js` 内必须**恰好 1 处**实现（全库唯一判定实现），实测=' + gatesDefs);
  assert.equal(waveDefs, 0,
    '`lib/wave-plan.js` 不得**自带**一套 presence 判定（禁两套逻辑）——必须 import `presenceJudge`，实测定义处=' + waveDefs);
  assert.ok(waveRefs,
    '「双点强制」要求建批期（`lib/wave-plan.ts`）**调用**同一 `presenceJudge`；'
    + '`lib/wave-plan.js` 内未出现该标识符 ⇒ 建批期无判据（或另起一套）');
  assert.ok(gatesHasMarker,
    '`empty-reason` marker 判据须与 presence 判据同源（同一文件、同一函数族）：'
    + '`lib/state/gates.js` 内未出现 `empty-reason` ⇒ 空内容通道未落地');
});

// ═══════════════════════════════════════════════════════════════════════════
// 组 F · A1：悬空产物（plan 产物须指导下游执行）
// ═══════════════════════════════════════════════════════════════════════════

test('T22 【r2 改写】A1 悬空产物**双点强制**（O-1）：建批期主防线拒建批 GATE_ORPHAN_PRODUCT + 运行期 complete 兜底', async (t) => {
  const tasks = () => [
    PLAN({ produce: ['plan/spec.md', 'plan/nobody-reads-me.md'] }),
    EXEC({ consume: ['plan/spec.md'], outputs: ['exec/e1/o.md'], deps: ['p1'] }),
    AUDIT({ consume: ['plan/spec.md', 'exec/e1/o.md'], produce: ['audit/a.md'], deps: ['e1'] }),
  ];

  // ── ① 建批期（主防线，lib/wave-plan.ts）：consume 面全量已知 ⇒ 可完全静态判定 ⇒ 拒建批 ──
  const { byName } = makeHarness();
  const rBuild = await rejectsWith(
    () => byName.wave_plan.execute({
      batchId: 't22-build', team: 'software-team', tasks: tasks(), assembly: { auditLane: 'a1' },
    }, SESS),
    /GATE_ORPHAN_PRODUCT/);

  // ── ② 运行期（二级防线，checkCompleteGate 兜底）：防「建批后被改状态 / 注入 lane」的漂移 ──
  const b = mkBatch('t22', tasks(), { p1: 'merged', e1: 'merged', a1: 'merged' }, { team: 'software-team' });
  const rComplete = gates.checkCompleteGate(b);

  obs(t, '建批期 wave_plan.execute（plan/nobody-reads-me.md 无任何 consume）', rBuild);
  obs(t, '运行期 checkCompleteGate(悬空 plan 产物)', rComplete);

  assert.ok(rBuild.threw && rBuild.matched,
    'A1 主防线缺失：建批期必须**拒建批** GATE_ORPHAN_PRODUCT（现实现 wave-plan.js 只做单向 exec→plan 校验，'
    + '无「produce 必须被 consume」的反向检查）——实测=' + JSON.stringify(rBuild));

  assertRejected(rComplete, ['GATE_ORPHAN_PRODUCT'],
    'A1 二级防线缺失：complete 期必须兜底拒（不得以建批期为主防线即免除运行期复核）');
  assert.ok(Array.isArray(rComplete.orphans) && rComplete.orphans.includes('plan/nobody-reads-me.md'),
    '拒因须指名悬空产物：' + JSON.stringify(rComplete.orphans));
  t.diagnostic('双点证据：建批期 threw=' + rBuild.threw + ' / matched=' + rBuild.matched
    + '；运行期 ok=' + rComplete.ok + ' code=' + rComplete.code + '（两点可分别观测，不得一处代另一处）');
});

test('T33 【r2 新增 / R-33】A1 建批期主防线**无法覆盖的漂移面** ⇒ 运行期 complete 兜底必须拒', (t) => {
  // 构造：批次声明与 t22 同构，但新增一条 lane `x1` 带入一个**无人消费**的 plan 产物
  //（= 「建批后被注入 lane」的漂移场景）。主防线在**建批时刻**看不到它 ⇒ 只能靠运行期兜底。
  const b = mkBatch('t33', [
    PLAN({ produce: ['plan/spec.md', 'plan/injected-after-build.md'] }),
    EXEC({ consume: ['plan/spec.md'], outputs: ['exec/e1/o.md'], deps: ['p1'] }),
    AUDIT({ consume: ['plan/spec.md', 'exec/e1/o.md'], produce: ['audit/a.md'], deps: ['e1'] }),
  ], { p1: 'merged', e1: 'merged', a1: 'merged' }, { team: 'software-team' });
  const r = gates.checkCompleteGate(b);
  obs(t, 'checkCompleteGate(建批后注入的悬空 plan 产物)', r);
  assertRejected(r, ['GATE_ORPHAN_PRODUCT'],
    'A1 主防线在**建批时刻**看不到建批后注入的 lane ⇒ 运行期 complete 兜底是**唯一**屏障（O-1 二级防线不可省）');
  assert.ok(Array.isArray(r.orphans) && r.orphans.includes('plan/injected-after-build.md'),
    '拒因须指名悬空产物：' + JSON.stringify(r.orphans));
  t.diagnostic('不对称口径（有意）：exec / audit 层悬空 ⇒ 仅强告警 + gateStrength.orphanProducts 可见，**不拒**。');
});

// ═══════════════════════════════════════════════════════════════════════════
// 组 G · B4：standalone 逃生阀收紧为「显式授权 + 留痕」
// ═══════════════════════════════════════════════════════════════════════════

test('T23 standalone 不得自声明即放行（布尔/理由/上游事实核验/留痕四判据）', (t) => {
  // (a) 字符串 'true' 不认（在「未声明 entry_requires」团队上构造，使该分支真正可达）
  const noEntryRoot = writeTempTeam('punky-gate-red-team-', 't23-no-entry', (a) => {
    a.team = 't23-no-entry';
    delete a.flows.exec.entry_requires;
  });
  const bA = mkBatch('t23a', [EXEC({ standalone: 'true', consume: null, outputs: ['exec/o.md'] })],
    { e1: 'pending' }, { team: 't23-no-entry', teamsRoot: noEntryRoot });
  const rA = gates.checkEntryGate(SID, bA.batchId, bA, 'e1');

  // (b) 布尔 true 但缺 standaloneReason
  const bB = mkBatch('t23b', [EXEC({ standalone: true, consume: [], outputs: ['exec/o.md'] })],
    { e1: 'pending' }, { team: 'software-team' });
  const rB = gates.checkEntryGate(SID, bB.batchId, bB, 'e1');

  // (c) 批次内存在可消费的 plan 产物，却声明「无上游」⇒ 事实核验应拒
  const bC = mkBatch('t23c', [
    PLAN({ produce: ['plan/spec.md'] }),
    EXEC({ standalone: true, standaloneReason: '我认为没有上游', consume: null, outputs: ['exec/o.md'], deps: ['p1'] }),
  ], { p1: 'merged', e1: 'pending' }, { team: 'software-team' });
  const rC = gates.checkEntryGate(SID, bC.batchId, bC, 'e1');

  // (d) 确实无上游 + 有理由 ⇒ 放行**且**留痕（escape 必须可观测）
  const bD = mkBatch('t23d', [EXEC({ standalone: true, standaloneReason: '本批确实无 plan 上游', consume: null, outputs: ['exec/o.md'] })],
    { e1: 'pending' }, { team: 'software-team' });
  const rD = gates.checkEntryGate(SID, bD.batchId, bD, 'e1');

  obs(t, '(a) standalone 字符串 "true"', rA);
  obs(t, '(b) standalone:true 无 standaloneReason', rB);
  obs(t, '(c) 有上游却声明 standalone', rC);
  obs(t, '(d) 合法 standalone（真无上游 + 理由）', rD);

  assertRejected(rA, ['GATE_ENTRY_MISSING', 'GATE_STANDALONE_UNJUSTIFIED'], 'standalone 必须是布尔 true');
  assertRejected(rB, ['GATE_STANDALONE_UNJUSTIFIED', 'GATE_ENTRY_MISSING'],
    '当前 {ok:true, standalone:true} 即放行、零痕迹');
  assertRejected(rC, ['GATE_STANDALONE_UNJUSTIFIED', 'GATE_ENTRY_MISSING'],
    '「你有上游可用却声明无上游」必须被事实核验拦下');
  assertAccepted(rD, '唯一合法的「确实无上游」声明应保留放行');
  assert.ok(rD.escape && rD.escape.kind === 'standalone',
    '留痕缺失：合法逃生阀必须产 escape{kind:"standalone", reason}（当前返回值无 escape 字段）——实测=' + JSON.stringify(rD));
  assert.ok(typeof rD.escape.reason === 'string' && rD.escape.reason.length > 0,
    'escape 须携带 reason 供审计：' + JSON.stringify(rD.escape));
});

// ═══════════════════════════════════════════════════════════════════════════
// 组 H · FG-01：produce_field 取非常规值（声明驱动真被消费）
// ═══════════════════════════════════════════════════════════════════════════

test('T24 produce_field 取非 legacy 值（exec: outputs→produce）正负双向用例', (t) => {
  const teamRoot = writeTempTeam('punky-gate-red-team-', 't24-pf', (a) => {
    a.team = 't24-pf';
    a.flows.exec.produce_field = 'produce'; // legacy for exec = 'outputs' ⇒ 非 legacy 值
  });
  assertTeamLoads(teamRoot, 't24-pf', (f) => {
    assert.equal(f.exec.produce_field, 'produce', '前置：produce_field 确实被拉到非 legacy 值');
  });
  const mk = (bid, task) => mkBatch(bid, [EXEC({ ...task })], { e1: 'review' }, { team: 't24-pf', teamsRoot: teamRoot });

  // 负例 1：只声明 outputs 且产物缺失（produce 未声明）⇒ 必拒
  const b1 = mk('t24-n1', { outputs: ['exec/missing.md'] });
  const r1 = gates.checkExitGate(SID, b1.batchId, b1, 'e1');
  // 负例 2：produce 已声明且有效，但 outputs 内产物缺失 ⇒ 必拒（证明 produce_field 不得缩窄被检面）
  const b2 = mk('t24-n2', { produce: ['exec/present.md'], outputs: ['exec/missing.md'] });
  writeArt(b2.batchId, 'exec/present.md', 'present');
  const r2 = gates.checkExitGate(SID, b2.batchId, b2, 'e1');
  // 正例：两个字段都真实存在非空 ⇒ 放行（防新判据误伤）
  const b3 = mk('t24-p1', { produce: ['exec/present.md'], outputs: ['exec/present.md'] });
  writeArt(b3.batchId, 'exec/present.md', 'present');
  const r3 = gates.checkExitGate(SID, b3.batchId, b3, 'e1');
  obs(t, 'FG-01 负例1: produce_field=produce, 仅 outputs 且缺失', r1);
  obs(t, 'FG-01 负例2: produce 有效但 outputs 缺失', r2);
  obs(t, 'FG-01 正例: 两字段均真实存在非空', r3);

  assertRejected(r1, ['GATE_EXIT_MISSING_EXEC', 'GATE_EXIT_NO_DECLARATION'],
    'produce_field 翻成 produce 后 outputs 成「未声明字段」⇒ 现状整门零检（设计 §3-S8）');
  assertRejected(r2, ['GATE_EXIT_MISSING_EXEC'],
    '声明驱动把被检面缩到 produce ⇒ outputs 内缺失产物零检；目标语义：被检面 = produce ∪ outputs');
  assertAccepted(r3, '非 legacy 声明值下，齐备产物不得被误拒');
});

// ═══════════════════════════════════════════════════════════════════════════
// 组 I · G-1：恢复路径不可堵（idle 出边唯一）
// ═══════════════════════════════════════════════════════════════════════════

test('T25 (G-1) idle lane 不满足严进条件 ⇒ 放行 + escape 留痕；首次派发（pending）仍拒', (t) => {
  const mkIdle = (bid, state) => {
    const b = mkBatch(bid, [
      PLAN({ produce: ['plan/spec.md'] }),
      EXEC({ consume: ['plan/spec.md'], outputs: ['exec/e1/o.md'], deps: ['p1'] }),
      AUDIT({ consume: ['exec/e1/o.md'], produce: ['audit/a.md'], deps: ['e1'] }), // 无 plan 层锚点
    ], { p1: 'merged', e1: 'merged', a1: state }, { team: 'software-team' });
    writeArt(bid, 'exec/e1/o.md', 'out'); // 产物存在 ⇒ 触发 audit 判据来源门（而非缺失门）
    return b;
  };
  const bIdle = mkIdle('t25-idle', 'idle');
  const rIdle = gates.checkEntryGate(SID, bIdle.batchId, bIdle, 'a1');
  const bPending = mkIdle('t25-pending', 'pending');
  const rPending = gates.checkEntryGate(SID, bPending.batchId, bPending, 'a1');
  obs(t, 'idle lane 严进不满足（audit 无 plan 锚点）', rIdle);
  obs(t, '对照：pending（首次派发）同构造', rPending);

  assertAccepted(rIdle,
    'schema.ts:42 的 idle→running 是唯一出边、idle 又非终态（schema.ts:67-69）⇒ entry 一拒即四条出边全堵（僵尸批次）；'
    + 'G-1 方案 A：恢复重派须放行，当前硬拒 = ' + JSON.stringify(rIdle));
  assert.ok(rIdle.escape && rIdle.escape.kind === 'idle-recovery-passthrough',
    '恢复放行必须留痕 escape{kind:"idle-recovery-passthrough"}——实测=' + JSON.stringify(rIdle.escape));
  assertRejected(rPending, ['GATE_AUDIT_INPUT_MISSING', 'GATE_ENTRY_MISSING'],
    '首次派发必须仍严格（G-1 只对恢复路径降级为告警放行）');
});

test('T36 【r2 新增 / R-36 G-1】`idle` 且 consume 严进条件不满足 ⇒ 恢复重派**不得硬拒**（放行 + `gate.escape` 告警留痕）；对照 `pending` 仍严拒', (t) => {
  // 文档依据：`docs/governance-technical.md:96`「**恢复机制**：…崩溃后 idle 归位重派…」
  //   ⇒ 恢复路径**永不可堵**（G-1）。收紧 entry 门时若误伤 `idle`，该 lane 四条出边全堵（僵尸批次）。
  // 与 T25 的分工：T25 用 `GATE_AUDIT_INPUT_MISSING`（无 plan 锚点）面；本用例用**consume 缺件**面，
  //   并**同时**给出「放行 + 告警留痕」两半判据（T25 只覆盖前半）。
  const mkRecover = (bid, state) => mkBatch(bid, [
    PLAN({ produce: ['plan/spec.md'] }),
    EXEC({ consume: ['plan/spec.md', 'exec/not-yet/'], outputs: ['exec/e1/o.md'], deps: ['p1'] }),
  ], { p1: 'merged', e1: state }, { team: 'software-team' });
  // 前置：只让 `exec/not-yet/` 缺件（`plan/spec.md` 必须在场），使拒因唯一、可读
  writeArt('t36-idle', 'plan/spec.md', SPEC_OK);
  writeArt('t36-pending', 'plan/spec.md', SPEC_OK);

  const bIdle = mkRecover('t36-idle', 'idle');
  const rIdle = gates.checkEntryGate(SID, bIdle.batchId, bIdle, 'e1');
  const bPend = mkRecover('t36-pending', 'pending');
  const rPend = gates.checkEntryGate(SID, bPend.batchId, bPend, 'e1');

  obs(t, '(a) idle（恢复重派）+ consume 缺件 ["exec/not-yet/"]', rIdle);
  obs(t, '(b) 对照 pending（首次派发）+ 同构造', rPend);

  // 前置自检：两构造只差 lane 状态 ⇒ 拒因必须同源可读
  assert.deepEqual(rIdle.missing ?? null, ['exec/not-yet/'],
    '前置：只让 `exec/not-yet/` 缺件（plan/spec.md 在场）——实测=' + JSON.stringify(rIdle));

  assertAccepted(rIdle,
    'G-1 违规：`idle` 是恢复路径（docs/governance-technical.md:96「崩溃后 idle 归位重派」），'
    + '严进不满足时**不得硬拒** —— 硬拒使 idle 无出边（schema.ts:42 的 idle→running 是唯一出边）⇒ 僵尸批次；实测='
    + JSON.stringify(rIdle));
  assert.ok(rIdle.escape && rIdle.escape.kind === 'idle-recovery-passthrough',
    '恢复放行**必须留痕**（不得静默放宽）：escape{kind:"idle-recovery-passthrough"}——实测='
    + JSON.stringify(rIdle.escape));
  assert.ok(typeof rIdle.escape.reason === 'string' && rIdle.escape.reason.length > 0,
    'escape 须携带 reason 供审计：' + JSON.stringify(rIdle.escape));

  assertRejected(rPend, ['GATE_ENTRY_MISSING'],
    '对照：首次派发（pending）**必须仍严拒** —— 若此子例放行，则 G-1 的降级面被过度放宽、B1 被架空');
  assert.equal(rPend.escape, undefined,
    '首次派发不得带 escape 留痕（降级只属恢复路径）：' + JSON.stringify(rPend));
});

// ═══════════════════════════════════════════════════════════════════════════
// 组 J · D-8：终态可收口性（conflict 不得永久卡死）
// ═══════════════════════════════════════════════════════════════════════════

test('T26 【r2 改写】Q-7：complete **仅** pass/skip 可过；fail 与 conflict **均**不得 complete，且**必须有出路**（aborted 收口），不得僵局', (t) => {
  // r1 的 T26 建立在**已废弃**的语义上（「conflict 固化卡死」+「failed 能过属反直觉事实」）。
  // 本批按用户 Q-7 与 O-2 裁定重写：**不是**放行 conflict 去 complete，而是
  //   ① 仅 `pass` / `skip` 可 complete；② `fail` / `conflict` **均**拒（复用码 `GATE_COMPLETE_AUDIT_FAILED`，不新增）；
  //   ③ **不得僵局**：拒绝载荷须携带 `escapeRoute{phase:'aborted', reason}`（或转人工闸）⇒ 批次可收口。
  const mk = (bid, auditState) => mkBatch(bid, [
    PLAN({ produce: ['plan/spec.md'] }),
    EXEC({ consume: ['plan/spec.md'], outputs: ['exec/e1/o.md'], deps: ['p1'] }),
    AUDIT({ consume: ['plan/spec.md', 'exec/e1/o.md'], produce: ['audit/a.md'], deps: ['e1'] }),
  ], { p1: 'merged', e1: 'merged', a1: auditState }, { team: 'software-team' });

  // 先观测全部子例，再断言
  const R = {
    merged: gates.checkCompleteGate(mk('t26-merged', 'merged')),
    skipped: gates.checkCompleteGate(mk('t26-skipped', 'skipped')),
    failed: gates.checkCompleteGate(mk('t26-failed', 'failed')),
    conflict: gates.checkCompleteGate(mk('t26-conflict', 'conflict')),
  };
  obs(t, '(a) audit=merged  ⇒ outcome pass', R.merged);
  obs(t, '(b) audit=skipped ⇒ outcome skip', R.skipped);
  obs(t, '(c) audit=failed  ⇒ outcome fail', R.failed);
  obs(t, '(d) audit=conflict⇒ outcome conflict', R.conflict);

  // ① 仅 pass / skip 可过
  assertAccepted(R.merged, 'Q-7 正例：audit 落 merged（pass）⇒ 可 complete');
  assertAccepted(R.skipped, 'Q-7 正例：audit 落 skipped（skip）⇒ 可 complete');

  // ② fail / conflict **均**不得 complete（r1 的「failed 能过」必须消失）
  assertRejected(R.failed, ['GATE_COMPLETE_AUDIT_FAILED'],
    'Q-7：`fail`（验收未通过）不得 complete —— r1 实测此处曾返回 {ok:true}（`fail` 在 verdict 白名单内），'
    + '该白名单判定被判为**错误**须改');
  assertRejected(R.conflict, ['GATE_COMPLETE_AUDIT_FAILED'],
    'Q-7：`conflict`（冲突驳回）不得 complete');

  // ③ 必须有出路（不得僵局）——这是 r1「固化卡死」与本批「终态可退出」的**唯一区别点**
  for (const [label, r] of [['fail（failed）', R.failed], ['conflict', R.conflict]]) {
    assert.ok(r.escapeRoute && typeof r.escapeRoute === 'object',
      'D-8 僵局守卫：audit 落 ' + label + ' 时拒因须携带 `escapeRoute`（批次必须有明确出路，'
      + 'schema.ts:46 conflict 无出边 ⇒ 无出路即永久锁死）——实测=' + JSON.stringify(r));
    assert.equal(r.escapeRoute.phase, 'aborted',
      label + ' 的出路须为批次终态 `aborted`（可审计）：' + JSON.stringify(r.escapeRoute));
    assert.ok(typeof r.escapeRoute.reason === 'string' && r.escapeRoute.reason.length > 0,
      label + ' 的 escapeRoute 须携带非空 reason：' + JSON.stringify(r.escapeRoute));
  }

  // gateStrength 须暴露完整结局面（白名单外含 fail/conflict + 出口），供诊断
  writeBatchFile(mk('t26-vis', 'conflict'));
  const gs = gates.gateStatus(SID, 't26-vis', 'a1');
  obs(t, 'gateStatus(a1).gateStrength', gs.gateStrength);
  assert.ok(gs.gateStrength, 'gateStatus 必须暴露 gateStrength 摘要');
  assert.ok(gs.gateStrength.completeOutcomes, 'completeOutcomes 不可见 ⇒ 「fail/conflict 恒拒 + 出口」无法诊断');
  const vals = gs.gateStrength.completeOutcomes.values;
  assert.ok(Array.isArray(vals) && !vals.includes('fail') && !vals.includes('conflict'),
    'completeOutcomes.values 必须暴露「有效白名单 = verdict ∩ {pass,skip}」——不得含 fail / conflict，实测='
    + JSON.stringify(vals));
  assert.ok(gs.gateStrength.completeOutcomes.escapeRoute || gs.gateStrength.completeOutcomes.escape,
    'completeOutcomes 须暴露 fail/conflict 的**出口**（消解 r1 的「既不能 complete 也无法收口」僵局）：'
    + JSON.stringify(gs.gateStrength.completeOutcomes));
  t.diagnostic('【r1 对照】r1 实测：conflict→GATE_COMPLETE_AUDIT_FAILED（卡死）、failed→{ok:true}（能过）。'
    + '本批两者**均为拒**，且拒绝载荷须带 escapeRoute ⇒ 「有出路」是本用例与 r1 的分水岭，不是「放行 conflict」。');
});

test('T27 【r2 改写】legacy 分支残留证伪：同一构造在 createdAt 两极（2099 / 2000）**结论必须逐字一致**（均为拒）', (t) => {
  // r1 的 T27 断言「旧批（createdAt < EPOCH）仍放行 + fallback」——**建立在已作废的双轨语义上**。
  // 用户裁决：旧批一律废弃、新代码**不得设计任何 legacy 分支**（无 semanticsOf / 无 STRICT_SEMANTICS_EPOCH /
  // 无 gateSemantics / 无按 createdAt 分流的判据）。⇒ 本题不再断言「旧批放行」，而是**证伪两极分歧**。
  const mk = (pole) => ({
    e1: mkBatch('t27-e1-' + pole, [EXEC({ produce: ['exec/only.md'] })],
      { e1: 'review' }, { team: 'software-team', createdAt: pole }),
    x1: mkBatch('t27-x1-' + pole, [{ id: 'x1', role: 'coder', cmd: 'code', outputs: ['exec/none.md'] }],
      { x1: 'review' }, { team: 'software-team', createdAt: pole }),
    tier: mkBatch('t27-tier-' + pole, [{ id: 't1', cmd: 'x' }, { id: 't2', cmd: 'y' }],
      { t1: 'merged', t2: 'merged' }, { team: 'generic', createdAt: pole }),
    plan: mkBatch('t27-plan-' + pole, [PLAN({})], { p1: 'review' },
      { team: 'software-team', createdAt: pole }),
  });

  const run = (set) => ({
    e1: gates.checkExitGate(SID, set.e1.batchId, set.e1, 'e1'),
    x1: gates.checkExitGate(SID, set.x1.batchId, set.x1, 'x1'),
    tier: gates.checkCompleteGate(set.tier),
    plan: gates.checkPlanContract(SID, set.plan.batchId, set.plan, 'p1'),
  });
  const A = run(mk(POLE_NEW));
  const B = run(mk(POLE_OLD));

  for (const k of ['e1', 'x1', 'tier', 'plan']) {
    obs(t, '(新极 2099) ' + k, A[k]);
    obs(t, '(旧极 2000) ' + k, B[k]);
  }

  for (const k of ['e1', 'x1', 'tier', 'plan']) {
    assert.deepEqual(A[k], B[k],
      'legacy 分流判据残留：构造 `' + k + '` 在两极下结论不同 —— 新极=' + JSON.stringify(A[k])
      + ' / 旧极=' + JSON.stringify(B[k]) + '；本批**无 legacy 分支**，两极必须逐字一致');
  }
  // 同构断言：两极结论**均为拒**（新语义对所有新批一视同仁）
  assertRejected(A.e1, ['GATE_EXIT_NO_DECLARATION', 'GATE_EXIT_MISSING_EXEC'], '新语义：(a) produce-only ⇒ 拒');
  assertRejected(A.x1, ['GATE_LANE_LAYER_MISSING'], '新语义：B2 无 layer ⇒ 拒（含旧 createdAt 的批）');
  assertRejected(A.tier, ['GATE_COMPLETE_NO_TIER'], '新语义：B3 无 exec 无 audit ⇒ 拒（含旧 createdAt 的批）');
  assertRejected(A.plan, ['GATE_PLAN_NO_DECLARATION'], '新语义：(c) plan 无产物声明 ⇒ 拒（含旧 createdAt 的批）');
  t.diagnostic('两极一致性检查通过 ⇒ 可证伪 `semanticsOf` / `STRICT_SEMANTICS_EPOCH` / `gateSemantics` / '
    + '按 createdAt 分流的判据**均未出现**（两极只用于证伪，不再有「旧批放行」语义）。');
});

test('T28 【r2 改写】零静默（r2 术语）：降级/逃生须产 `gate.degrade` / `gate.escape` 留痕，**不含任何 legacy fallback**', (t) => {
  // r1 的 T28 断言「legacy 批亦须产 fallback」——`gate.fallback` 已被本批**取代**为 `gate.degrade`，
  // 且「legacy 批」概念本身已作废。改写为：同一构造在两极都必须可观测到留痕，且**不得**出现 fallback。
  const mk = (pole) => mkBatch('t28-' + pole, [EXEC({ produce: ['exec/only.md'] })],
    { e1: 'review' }, { team: 'software-team', createdAt: pole });
  const A = gates.checkExitGate(SID, 't28-new', mk(POLE_NEW), 'e1');
  const B = gates.checkExitGate(SID, 't28-old', mk(POLE_OLD), 'e1');
  obs(t, '(新极 2099) produce-only', A);
  obs(t, '(旧极 2000) produce-only', B);

  assert.deepEqual(A, B, '零静默面亦不得按 createdAt 分流（两极结论须逐字一致）');

  // r2 留痕：逃生阀（含 empty-reason 载原因）⇒ gate.escape；降级 ⇒ gate.degrade。
  const traces = A.degrades ?? null;
  const escapes = A.escapes ?? (A.escape ? [A.escape] : null);
  assert.ok((Array.isArray(traces) && traces.length > 0) || (Array.isArray(escapes) && escapes.length > 0),
    '原则②零静默：本路径的降级/逃生动作必须在返回值可观测（当前返回值无任何痕迹，'
    + '既无 `degrades` 也无 `escapes`）——实测=' + JSON.stringify(A));
  if (Array.isArray(traces)) {
    assert.ok(traces.some((x) => x && typeof x.kind === 'string'),
      '`gate.degrade` 须带 kind 供 gateStrength 汇总：' + JSON.stringify(traces));
  }
  if (Array.isArray(escapes)) {
    assert.ok(escapes.some((x) => x && typeof x.kind === 'string'),
      '`gate.escape` 须带 kind 供 gateStrength 汇总：' + JSON.stringify(escapes));
  }

  // legacy 回落语义**不成立**：不得出现 `fallback` / `fallbacks` 字段
  assert.equal(Object.prototype.hasOwnProperty.call(A, 'fallback'), false,
    '`gate.fallback`（旧批回落语义）已被 `gate.degrade` 取代 ⇒ 返回值不得再出现 `fallback` 字段');
  assert.equal(Object.prototype.hasOwnProperty.call(A, 'fallbacks'), false,
    '不得出现 `fallbacks` 汇总字段（r1 形态已作废）');
  t.diagnostic('术语对照：r1 = `gate.fallback`（旧批回落）；r2 = `gate.degrade`（降级）+ `gate.escape`（逃生阀）。'
    + '本用例只认 r2 术语；出现 `fallback` 即判失败。');
});

// ═══════════════════════════════════════════════════════════════════════════
// 组 K · 零迁移 / 零静默 / 强度可见
// ═══════════════════════════════════════════════════════════════════════════

test('T29 gateStatus 必须暴露 gateStrength 门禁强度摘要', (t) => {
  const b = mkBatch('t29', [
    PLAN({ produce: ['plan/spec.md'] }),
    EXEC({ consume: ['plan/spec.md'], outputs: ['exec/e1/o.md'], deps: ['p1'] }),
    AUDIT({ consume: ['plan/spec.md'], produce: ['audit/a.md'], deps: ['e1'] }),
  ], { p1: 'merged', e1: 'merged', a1: 'merged' }, { team: 'software-team' });
  writeArt(b.batchId, 'plan/spec.md', SPEC_OK);
  writeBatchFile(b);
  const gs = gates.gateStatus(SID, b.batchId, 'a1');
  obs(t, 'gateStatus keys', Object.keys(gs));
  assert.ok(gs.gateStrength, 'gate_status 必须暴露 gateStrength（当前无此字段 ⇒「本批门禁强度」不可见）');
  assert.ok(gs.gateStrength.unwired, '须显式标注未接线声明面（progress_contract/state_machine/config.ratchet）');
  assert.ok(Array.isArray(gs.gateStrength.evaluatedAt),
    '须标注门禁只在 running/merged 两点评估（D12 最大未闭合逃逸须可见）');
});

// ═══════════════════════════════════════════════════════════════════════════
// 组 L · 【r2 新增】O-4.2 0 字节规则 / 既有测试同步 / 真跑守卫测试（R-31 / R-34 / R-35）
// ═══════════════════════════════════════════════════════════════════════════

test('T31 【r2 新增 / R-31】0 字节规则（O-4.2）：**真实 0 字节 ⇒ 一律判 missing（拒）**，不得走 `empty-reason` 通道；对照「空白 + 非空 empty-reason 行 ⇒ 放行」', (t) => {
  // 用户裁决 O-4.2：**真实 0 字节文件一律判 missing ⇒ 拒**，不得走 empty-reason 通道。
  // 语义依据（spec.md §3 marker 行）：「0 字节**不可能自带原因行**」⇒ 不满足用户
  //   「内容可写空**并注明原因**」中的「注明」；「可空」的定义 = **扣除原因行后无任何实质内容**。
  const probe = (bid, decl, content) => {
    const b = mkBatch(bid, [PLAN({ produce: [decl] })], { p1: 'review' }, { team: 'software-team' });
    writeArt(b.batchId, decl, content);
    return gates.checkPlanContract(SID, b.batchId, b, 'p1');
  };
  const CONTENT_ZERO = '';                        // 真实 0 字节
  const CONTENT_NOTED = '   \nempty-reason: 本轮无新增判据，判据由 plan/spec.md 承载\n\n';
  const CONTENT_PLAIN = '   \n\t\n';              // 仅空白、无原因行
  const CONTENT_EMPTY_REASON = 'empty-reason:\n'; // 原因行**未携带非空文本**

  const R = {
    // plan 层：用 `plan/design-spec.md`（命中 software-team 的 artifact_globs `plan/*spec.md`）
    zero: probe('t31-zero', 'plan/design-spec.md', CONTENT_ZERO),
    noted: probe('t31-noted', 'plan/design-spec.md', CONTENT_NOTED),
    plain: probe('t31-plain', 'plan/design-spec.md', CONTENT_PLAIN),
    emptyReason: probe('t31-empty-reason', 'plan/design-spec.md', CONTENT_EMPTY_REASON),
  };
  obs(t, '(a) 真实 0 字节（plan/design-spec.md）', R.zero);
  obs(t, '(b) 对照组：空白 + 非空 `empty-reason` 行', R.noted);
  obs(t, '(c) 对照：仅空白、无原因行', R.plain);
  obs(t, '(d) 对照：`empty-reason:` 未携带非空文本', R.emptyReason);

  // 0 字节 ⇒ 判 **missing**（拒）——且必须走「在场性缺失」判据，不得先做内容扫描
  assertRejected(R.zero, ['GATE_ARTIFACT_EMPTY_NO_REASON', 'GATE_PLAN_CONTRACT', 'GATE_ARTIFACT_NOT_A_FILE'],
    'O-4.2：真实 0 字节文件一律判 missing ⇒ 拒（0 字节不可能自带原因行）');
  assert.ok(Array.isArray(R.zero.problems) && R.zero.problems.some((p) => /missing/.test(p)),
    '0 字节的拒因须走**在场性缺失**判据（`<path> missing` 形态），不得退化为内容判据'
    + '（内容判据意味着引擎「读到了内容」，与 0 字节 = 不可注明原因相悖）——实测=' + JSON.stringify(R.zero.problems));

  // 对照组：载有原因 ⇒ 放行
  assertAccepted(R.noted,
    'O-4.1/§3：**唯一空内容通道** = 独立行 `empty-reason: <非空文本>`；'
    + '「可空」= 扣除原因行后无实质内容 ⇒ 必须放行（现实现无该通道，实测被内容判据拒）');
  assert.ok(R.noted.escape && R.noted.escape.kind === 'empty-artifact-noted',
    '载原因的放行必须留痕 `gate.escape{kind:empty-artifact-noted}` 并进 `gateStrength.emptyNoted`'
    + '（原则②零静默）——实测=' + JSON.stringify(R.noted.escape ?? null));

  // 对照：无原因行的语义空内容 ⇒ 拒（不得与「载原因」混淆）
  assertRejected(R.plain, ['GATE_ARTIFACT_EMPTY_NO_REASON', 'GATE_PLAN_CONTRACT'],
    '仅空白、未载原因行 ⇒ 不得放行（空内容通道是「有原因」而非「可以空」）');
  assertRejected(R.emptyReason, ['GATE_ARTIFACT_EMPTY_NO_REASON', 'GATE_PLAN_CONTRACT'],
    '`empty-reason:` 后无非空文本 ⇒ 「注明」形同虚设 ⇒ 拒（marker 须携带非空文本）');

  // exec 层对照：0 字节在 exit 面同样判 missing
  const bExec = mkBatch('t31-exec', [EXEC({ outputs: ['exec/z.md'] })], { e1: 'review' }, { team: 'software-team' });
  writeArt(bExec.batchId, 'exec/z.md', CONTENT_ZERO);
  const rExec = gates.checkExitGate(SID, bExec.batchId, bExec, 'e1');
  obs(t, '(e) exec 层 0 字节（对照，当前已拒——因 size>0 判据不为目录开洞）', rExec);
  assertRejected(rExec, ['GATE_EXIT_MISSING_EXEC', 'GATE_ARTIFACT_EMPTY_NO_REASON'],
    '0 字节规则须**两 mode 同源**（R-32）：exit 面同样判 missing');

  // marker 可测性三形态（§验收标准 16）：命中 / 未命中 / **仅出现在行中（不得命中）**
  const midLine = probe('t31-midline', 'plan/design-spec.md',
    '# 说明\n本行是正文，其中提到 empty-reason: 这不是独立行，不应命中\n');
  obs(t, '(f) `empty-reason:` **仅出现在行中（非行首）**', midLine);
  assert.equal(midLine.ok, false,
    'marker 唯一形态 = **行首锚定 + 非空文本**：行中出现不得命中（否则正文提及该词即可放行）；实测='
    + JSON.stringify(midLine));
  t.diagnostic('既有对照证据（与本规则同向，须保留）：`test/gates.test.js:135-146`'
    + '「空文件（size 0 真实文件）consume 仍拒」。');
});

test('T37 【r2 新增 / R-34 源修改】既有 `test/gates.test.js` 两条「目录型产物应通过」断言已按裁定 ② 改写为**声明形态二分语义**，并保留 Bug1 意图注释', (t) => {
  // 裁定 ②（Leader）：按「声明形态二分」同步既有断言（e3 写域内的事，由 e3 改）：
  //   声明以 `/` 结尾 ⇒ 目录语义（要求目录**存在且非空**）；
  //   声明不以 `/` 结尾 ⇒ 文件语义（必须是**非空文件**；给目录 ⇒ 拒）。
  // 本用例是**源修改的自证守卫**：防止他人回退到「目录无条件通过」的旧断言，并确保
  //   **Bug1 的意图注释仍在**（Windows 下目录 `size` 恒 0 的历史成因不得丢失）。
  const src = fs.readFileSync(path.join(PKG, 'test', 'gates.test.js'), 'utf8');

  // ① 两条用例名仍在（可定位），且② 用例名已改写为「显式目录声明」口径
  const hasEntryTest = src.includes('Entry Gate：目录型 consume');
  const hasExitTest = src.includes('Exit Gate：目录型 outputs');
  t.diagnostic('① 用例可定位：Entry=' + hasEntryTest + ' / Exit=' + hasExitTest);

  // ③ Bug1 意图注释必须保留（历史成因：Windows 目录 size 恒 0 不再误判缺失）
  assert.ok(src.includes('Bug1'),
    'Bug1 意图注释丢失：两条用例的**意图来源**（用例名显式声明成因）必须保留 —— 不得以「同步断言」为名抹掉历史判据');
  assert.ok(/Windows[^\n]*目录[^\n]*(size|大小)[^\n]*0/.test(src),
    'Bug1 的成因说明（Windows 下目录 size 恒 0 不再误判缺失）必须逐字保留（裁定 ② 明确要求）');

  // ④ 断言面已从「目录无条件通过」改为「**显式目录声明 + 目录非空**」
  assert.ok(src.includes('mkdirSync') && src.includes("'repos'"),
    'Entry 用例须显式构造目录（非空），且声明保留 `/` 结尾（`exec/repos/`）⇒ 目录语义');
  assert.ok(/exec['"`,\s]*[^\n]*repos\/['"`]/.test(src) || src.includes("'exec', 'repos'"),
    'Entry 用例的 `consume` 声明须保留 `/` 结尾（`exec/repos/`）——目录语义只能由声明显式表达');
  assert.ok(src.includes("'data'") || src.includes('data/'),
    'Exit 用例须保留目录型 outputs 声明（`exec/e1/data/`）');

  // ⑤ 两条用例必须**显式断言「目录非空」这一新判据**（否则未真正同步）
  t.diagnostic('⑤ 同步标记自检：非空目录断言注释 = ' + (/目录语义/.test(src) ? 'present' : 'MISSING'));
  assert.ok(src.includes('目录语义'),
    '同步未落地：改写后的用例须显式写明「目录语义」判据（声明 `/` 结尾 ⇒ 目录存在且非空 ⇒ 放行），'
    + '否则「目录无条件通过」的旧语义可能被静默恢复');

  // ⑥ 负例守卫：既有文件里**不得**再出现「目录一律通过」的等价断言（无 `/` 结尾的目录声明被放行）
  assert.equal(/声明\s*[`'"]?[^\n]*目录[^\n]*一律通过/.test(src), false,
    '不得保留「目录一律通过」的等价断言');
});

test('T38 【r2 新增 / R-35 真跑守卫测试】`test/audit-contract-gate.test.js` 全量**真跑**（含 `globMatchesPath` 末段回退回归）——该面此前从未被覆盖', async (t) => {
  // spec.md §验收标准 H-37：【硬门】`test/audit-contract-gate.test.js`（10041 B / sha AE2668C0E625…）
  //   **必须被 e3 与 v1 各自真跑**，原始输出落 `exec/red-test-log.txt` / `exec/test-run.log`；
  //   **不得**只声明「已存在该测试」。
  // 本用例是**用例内可核探针**：断言该守卫测试的关键回归面**当前通过**，
  //   原始真跑命令与完整输出另见 `exec/red-test-log.txt`（R-35 段）。
  const { globMatchesPath } = await import('../lib/assembly/flows.js');

  // §验收标准 H-38：末段回退回归（`:141-148`）是**本批 plan 契约 glob 设计的前置约束**
  const R = {
    planStarsExecPath: globMatchesPath('plan/**', 'exec/e1/o.md'),
    planStarsPlanPath: globMatchesPath('plan/**', 'plan/spec.md'),
    planStarsAbs: globMatchesPath('plan/**', 'D:/x/sess/artifacts/b1/exec/e1/o.md'),
    specAbsHit: globMatchesPath('plan/spec.md', 'D:/x/sess/artifacts/b1/plan/spec.md'),
    specAbsStarHit: globMatchesPath('plan/*spec.md', 'D:/x/sess/artifacts/b1/plan/design-spec.md'),
    specAbsStarCross: globMatchesPath('plan/*spec.md', 'D:/x/sess/artifacts/b1/exec/design-spec.md'),
  };
  for (const [k, v] of Object.entries(R)) obs(t, 'globMatchesPath · ' + k, v);

  assert.equal(R.planStarsExecPath, false,
    '末段回退回归：`plan/**` 不得命中 exec 路径（`**` 末段不得退化成匹配任意路径）——'
    + '否则 audit 的 `criteria_from` 锚点与 plan 契约 `artifact_globs` **静默放宽**');
  assert.equal(R.planStarsPlanPath, true, '正常目录前缀匹配不受影响');
  assert.equal(R.planStarsAbs, false, '绝对路径亦不得越过目录前缀');
  assert.equal(R.specAbsHit, true, '绝对路径末段回退（原始动机）保留');
  assert.equal(R.specAbsStarHit, true, '带目录前缀的 glob 对绝对路径产物不失配');
  assert.equal(R.specAbsStarCross, false,
    '末段回退只在末段命中时生效，**不跨目录放宽**（本批 plan 契约 §验收标准 I-40 的前置约束）');

  // 守卫测试本体存在性 + 关键回归点在场（真跑命令见 red-test-log.txt）
  const guard = fs.readFileSync(path.join(PKG, 'test', 'audit-contract-gate.test.js'), 'utf8');
  assert.ok(guard.includes("globMatchesPath('plan/**', 'exec/e1/o.md')"),
    '守卫测试本体须在场（含 `plan/**` vs exec 路径的回归断言）');
  assert.ok(guard.includes('GATE_AUDIT_CONTRACT_MISSING') && guard.includes('GATE_AUDIT_INPUT_MISSING'),
    '守卫测试须仍在覆盖建批期 audit_contract 两面（缺键拒建批 / consumes_required 未满足拒建批）');
  t.diagnostic('§验收标准 H-39 冲突须知：该守卫测试 `:150-164` 断言「verdict:["pass"] 时 audit 落 skipped ⇒ 拒 complete」'
    + '——与 Q-7 口径**同向**，e1 重写 complete 判据时**不应**破坏该断言。');
});


// ═══════════════════════════════════════════════════════════════════════════
// 组 L · FG-14：检查通道假绿（诊断型 —— 断言的是「当前缺陷事实」，非 GREEN 目标）
// ═══════════════════════════════════════════════════════════════════════════

test('T30 FG-14 tsconfig checkJs:false ⇒ 门禁运行时 .js 模块零类型覆盖（诊断型，只出可执行验证）', async (t) => {
  const cfgPath = path.join(PKG, 'tsconfig.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  obs(t, 'tsconfig.json compilerOptions', cfg.compilerOptions);
  assert.equal(cfg.compilerOptions.allowJs, true, '前置：allowJs=true（.js 会被纳入 program）');
  assert.equal(cfg.compilerOptions.checkJs, false, '确诊：checkJs=false ⇒ .js 不产类型诊断');

  // ① 真实 program 的文件构成：.js 在 program 内，但不受检查
  const ts = (await import('typescript')).default;
  const parsed = ts.parseJsonConfigFileContent(cfg, ts.sys, PKG);
  const rootNames = parsed.fileNames;
  const jsFiles = rootNames.filter((f) => f.endsWith('.js'));
  const tsFiles = rootNames.filter((f) => f.endsWith('.ts'));
  t.diagnostic('npm run check 覆盖面：.ts=' + tsFiles.length + ' 个（真检），.js=' + jsFiles.length + ' 个（纳入 program 但 checkJs:false ⇒ 零类型覆盖）');

  // ② 门禁运行时关键模块（.js 在跑、无 .ts 源）逐个列出
  const GATE_RUNTIME_JS = [
    'lib/state/store.js', 'lib/assembly/flows.js', 'lib/assembly/team-asset.js',
    'lib/state/command-exec.js', 'lib/state/constants.js', 'lib/state/task-utils.js',
    'lib/state/event-types.js', 'lib/state/machine.js',
  ];
  const uncovered = GATE_RUNTIME_JS.filter((rel) => {
    const js = path.join(PKG, rel);
    const tsSibling = js.replace(/\.js$/, '.ts');
    assert.ok(fs.existsSync(js), '前置：' + rel + ' 存在（门禁运行时真实加载的 .js）');
    return !fs.existsSync(tsSibling);
  });
  t.diagnostic('门禁运行时零类型覆盖模块（' + uncovered.length + '/' + GATE_RUNTIME_JS.length + '）: ' + uncovered.join(', '));
  for (const u of uncovered) t.diagnostic('  未覆盖: ' + u);
  assert.equal(uncovered.length, GATE_RUNTIME_JS.length,
    '确诊：8 个门禁运行时模块全部无 .ts 源 ⇒ 零类型覆盖（本批 e1/e2 的改动正落在此集合内）');

  // ③ 受控实验：同一组编译开关下，.ts 错误可见而 .js 错误被静默
  const fix = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-ts-checkjs-'));
  fs.writeFileSync(path.join(fix, 'a.ts'), 'export const a: number = "not-a-number";\n', 'utf8');
  fs.writeFileSync(path.join(fix, 'b.js'), '/** @type {number} */\nexport const b = "not-a-number";\n', 'utf8');
  const baseOpts = {
    strict: true, allowJs: true, noEmit: true, skipLibCheck: true,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022, types: [],
  };
  const diagOf = (opts) => {
    const program = ts.createProgram([path.join(fix, 'a.ts'), path.join(fix, 'b.js')], opts);
    return ts.getPreEmitDiagnostics(program).map((d) => (d.file ? path.basename(d.file.fileName) : '<global>'));
  };
  const off = diagOf({ ...baseOpts, checkJs: false });
  const on = diagOf({ ...baseOpts, checkJs: true });
  obs(t, 'checkJs:false 诊断命中文件', off);
  obs(t, 'checkJs:true  诊断命中文件', on);
  assert.ok(off.includes('a.ts'), '.ts 错误必须可见（证明探针本身有效）');
  assert.ok(!off.includes('b.js'), 'checkJs:false ⇒ .js 错误被静默（假绿通道确诊）');
  assert.ok(on.includes('b.js'), '同一 .js 在 checkJs:true 下报错 ⇒ 证明「静默」源于开关而非探针无效');
  t.diagnostic('结论：`npm run check`（tsc -p tsconfig.json）对本批门禁运行时 .js 零拦截力；'
    + '修复建议（不在本 lane 写域）：① tsconfig 增 checkJs:true（分阶段：先 lib/state + lib/assembly）；'
    + '② 或为 8 个模块补 .ts 源；③ 或加 `tsc --checkJs` 的独立 CI 通道，不改 noEmit 主通道。');
});
