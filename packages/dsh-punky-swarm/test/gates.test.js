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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { detectNeedHuman, detectGate, createGates, TARGETS_CLAIMED_RE } from '../lib/state/gates.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-gates-'));
const store = createStore(root);
const SID = 's-gate';
const specOk = '# Spec\n## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准\n- done\n## 约束\n- none\n';

// 套件对齐归档（批次 gate-techdebt · lane e2-gov-repair · 用户裁决 Q1=C）：
//   失效红条的**原用例体逐字**保存在本对象中（活字符串数据，零执行）；
//   对应的 test.todo 仅登记待办，正确断言留待独立小批复活（复用时取出文本重组即可）。
const ARCHIVED_CASES = {};


function makePlan(batchId, tasks, opts = {}) {
  const plan = buildWavePlan({ batchId, tasks, team: 'punky-preset', ...opts });
  store.createBatch(SID, { batchId, wavePlan: plan, concurrency: plan.concurrency });
  return plan;
}
function art(batchId, rel, content) {
  const abs = path.join(root, 'sessions', SID, 'artifacts', batchId, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content ?? (rel.endsWith('spec.md') ? specOk : (rel.endsWith('.json') ? '{"tasks":[]}' : 'code')));
  return abs;
}
// 【r2 同步 · B4】audit lane 的 `standalone: true` 逃生阀在本批收紧为「显式授权 + 事实核验 + 留痕」：
//   自声明不再足以放行——须布尔 true **且** `standaloneReason` 非空 **且** 批次内确实无可用上游。
//   旧口径「audit lane 无上游 ⇒ standalone 自声明即放行」⇒ 新语义直接拒 `GATE_STANDALONE_UNJUSTIFIED`。
//   本 fixture 按 **B5 设计本意**（audit 必须锚到 plan 判据来源）改为真 `consume`：audit 消费
//   `plan/spec.md`，由 entry 门的「判据来源门」校验该产物正文含裸标题 `## 验收标准`。
function tasks3() {
  return [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md', 'plan/task-tree.json'], cmd: 'spec' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md', 'plan/task-tree.json'], outputs: ['exec/e1/main.py'], cmd: 'code', deps: ['p1'] },
    { id: 'a1', layer: 'audit', role: 'reviewer', consume: ['plan/spec.md'], produce: ['audit/review.md', 'audit/gap-list.json'], cmd: 'review', deps: ['e1'] },
  ];
}
// 状态机流转：running → review → merged；捕获 Error 返回
function set(session, batchId, lane, to, note) {
  try { return store.setMember(session, batchId, lane, to, note); }
  catch (e) { return e; }
}
function runLaneOrError(batchId, lane) {
  const r1 = set(SID, batchId, lane, 'running');
  if (r1 instanceof Error) return r1;
  const r2 = set(SID, batchId, lane, 'review');
  if (r2 instanceof Error) return r2;
  return set(SID, batchId, lane, 'merged');
}

test('Entry Gate：exec 派发前 consume 缺失 → 拒绝并记录事件', () => {
  makePlan('b-entry', tasks3());
  art('b-entry', 'plan/spec.md'); // 只写 spec，task-tree.json 缺失
  const r = set(SID, 'b-entry', 'e1', 'running');
  assert.ok(r instanceof Error && /GATE_ENTRY_MISSING/.test(r.message), String(r.message));
  const b = store.readBatch(SID, 'b-entry');
  assert.ok(b.events.some((e) => e.type === 'gate.entry.missing' && e.lane === 'e1'));
  assert.equal(b.lanes.e1, 'pending');
});

// ── P1（2026-09-14 用户裁决，**全局严格**）：audit 判据来源锚定 ──
// P1-a 建批期：三层批中只要有 audit lane 声明 consume，则至少一条必须消费到 plan 层产物
// P1-b entry 期：audit lane 派发前，其消费的 plan 产物正文须含裸标题行 `## 验收标准`
function tasksAuditCriteria() {
  return [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1/main.py'], cmd: 'code', deps: ['p1'] },
    { id: 'a1', layer: 'audit', role: 'supervisor', consume: ['plan/spec.md'], produce: ['audit/accept.md'], cmd: 'accept', deps: ['e1'] },
  ];
}

test('P1-a：audit lane 只消费 exec 产物 → 拒建批 GATE_AUDIT_INPUT_MISSING（含两条边界放行）', () => {
  const t = tasksAuditCriteria();
  const bad = [t[0], t[1], { ...t[2], consume: ['exec/e1/main.py'] }];
  assert.throws(
    () => buildWavePlan({ batchId: 'b-p1a', tasks: bad, team: 'punky-preset' }),
    /GATE_AUDIT_INPUT_MISSING: no audit lane consumes a plan-layer product/,
  );
  // 边界①：audit lane 不声明 consume → 不入本检查（空 consume 由 entry_requires 在派发面拦）
  assert.ok(buildWavePlan({ batchId: 'b-p1a-ok', tasks: [t[0], t[1], { ...t[2], consume: undefined }], team: 'punky-preset' }));
  // 边界②：锚定 plan 产物后放行（exec 产物可同时保留）
  assert.ok(buildWavePlan({ batchId: 'b-p1a-ok2', tasks: [t[0], t[1], { ...t[2], consume: ['plan/spec.md', 'exec/e1/main.py'] }], team: 'punky-preset' }));
});

test('P1-b：audit 派发前 plan 产物缺 `## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准` → 拒派 GATE_AUDIT_CRITERIA_MISSING；补齐正文后放行', () => {
  makePlan('b-audit-crit', tasksAuditCriteria());
  art('b-audit-crit', 'plan/spec.md', '# Spec\n（本文件故意不含验收标准标题）\n');
  const r = set(SID, 'b-audit-crit', 'a1', 'running');
  assert.ok(r instanceof Error && /GATE_AUDIT_CRITERIA_MISSING/.test(r.message), String(r && r.message));
  const b = store.readBatch(SID, 'b-audit-crit');
  const ev = b.events.find((e) => e.type === 'gate.entry.missing' && e.lane === 'a1');
  assert.ok(ev, '拒派须留 gate.entry.missing 事件');
  assert.ok(Array.isArray(ev.problems) && ev.problems.some((p) => /lacks "## 验收标准"/.test(p)), JSON.stringify(ev.problems));
  assert.equal(b.lanes.a1, 'pending', '拒派后 lane 仍为 pending');
  // 补齐裸标题行 → 同一 lane 可派发（非终态否决）
  art('b-audit-crit', 'plan/spec.md', specOk);
  const r2 = set(SID, 'b-audit-crit', 'a1', 'running');
  assert.ok(!(r2 instanceof Error), '补齐正文后应放行：' + String(r2 && r2.message));
});

test('Entry Gate：consume 齐备 → 派发通过', () => {
  makePlan('b-entry2', tasks3());
  art('b-entry2', 'plan/spec.md');
  art('b-entry2', 'plan/task-tree.json');
  const r = set(SID, 'b-entry2', 'e1', 'running');
  assert.ok(!(r instanceof Error), String(r.message));
  assert.equal(r.lanes.e1, 'running');
});

// 【r2 同步 · 裁定 ②】R-34：本用例与 `:148-160` 原断言「**目录型产物一律通过**」，
//   因与本批新语义（拒绝免检：**声明形态二分**）冲突而**同步改写**：
//     · 声明路径以 `/` 结尾 ⇒ **目录语义**：目录必须**存在且非空** ⇒ 放行；
//     · 声明路径不以 `/` 结尾 ⇒ **文件语义**：必须是**非空文件**；给目录 ⇒ 拒。
//   **Bug1 意图（保留）**：Windows 下目录 `size` 恒 0，早期实现据此把「已存在的目录」误判为「缺失」；
//     用例名显式声明该成因 ⇒ **目录存在性这一意图有依据、必须保留**。
//     本批只**收窄**「隐式把目录当文件放行」：目录语义须由声明**显式表达**（`/` 结尾），且目录须**非空**。
test('Entry Gate：目录型 consume 通过（Bug1：Windows 目录 size 恒 0 不再误判缺失）· r2 同步：声明形态二分（`/` 结尾=目录语义）', () => {
  makePlan('b-dir-entry', [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md', 'exec/repos/'], outputs: ['exec/e1/main.py'], cmd: 'code', deps: ['p1'] },
    { id: 'a1', layer: 'audit', role: 'reviewer', produce: ['audit/review.md'], cmd: 'review', deps: ['e1'], standalone: true },
  ]);
  art('b-dir-entry', 'plan/spec.md');
  fs.mkdirSync(path.join(root, 'sessions', SID, 'artifacts', 'b-dir-entry', 'exec', 'repos'), { recursive: true });
  // r2 新增：目录语义要求**非空**（空目录不得冒充产物）⇒ 目录内放一个真实文件
  art('b-dir-entry', 'exec/repos/README.md');
  const r = set(SID, 'b-dir-entry', 'e1', 'running');
  assert.ok(!(r instanceof Error), String(r.message));
  assert.equal(r.lanes.e1, 'running');
});

// 【r2 同步 · 裁定 ②】文件语义负例对照（**不在本文件**：属本批 RED 网，见
//   `test/gate-hardening-red.test.js` T15 的 (c)/(e)/(g) 子例）：
//   声明**不带** `/` 结尾 ⇒ 文件语义 ⇒ 给目录必须**拒**。
//   **r2 前为 RED**（当时 `gates.js:154-161` 的 `st.isDirectory() → true` 使目录隐式冒充文件）；
//   r2 实现「声明形态二分」（`gates.ts:134-136` dir/file 判定 + `:222-232`）后该负例**已 GREEN**，
//   由 `test/gate-hardening-red.test.js` T15 承载（e3 于 gate-techdebt 批实测：T15 (c) 子例
//   `declared as file` 已判拒、用例整体 pass）。
//   本文件只承载「与本批新语义**兼容**」的同步断言，保持既有套件负载中性（改前改后皆通过）。

test('Entry Gate：空文件（size 0 真实文件）consume 仍拒（回归既有语义）', () => {
  makePlan('b-empty-entry', [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md', 'plan/empty.json'], cmd: 'spec' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md', 'plan/empty.json'], outputs: ['exec/e1/main.py'], cmd: 'code', deps: ['p1'] },
    { id: 'a1', layer: 'audit', role: 'reviewer', produce: ['audit/review.md'], cmd: 'review', deps: ['e1'], standalone: true },
  ]);
  art('b-empty-entry', 'plan/spec.md');
  art('b-empty-entry', 'plan/empty.json', ''); // 真实 size 0 文件
  const r = set(SID, 'b-empty-entry', 'e1', 'running');
  assert.ok(r instanceof Error && /GATE_ENTRY_MISSING/.test(r.message), String(r.message));
  assert.equal(store.readBatch(SID, 'b-empty-entry').lanes.e1, 'pending');
});

// 【r2 同步 · 裁定 ②】R-34：本用例与 `:122-133` 同源（Bug1 修复覆盖 exit gate 同函数），
//   按「声明形态二分」改写：`exec/e1/data/`（**带 `/` 结尾**）⇒ 目录语义 ⇒ 目录须**存在且非空** ⇒ 放行。
//   **Bug1 意图（保留）**：Windows 下目录 `size` 恒 0 ⇒ 不得把「已存在的目录」误判为「缺失」。
test('Exit Gate：目录型 outputs 通过 merged（Bug1 修复覆盖 exit gate 同函数）· r2 同步：声明形态二分（`/` 结尾=目录语义）', () => {
  makePlan('b-dir-exit', [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1/data/'], cmd: 'code', deps: ['p1'] },
    { id: 'a1', layer: 'audit', role: 'reviewer', produce: ['audit/review.md'], cmd: 'review', deps: ['e1'], standalone: true },
  ]);
  art('b-dir-exit', 'plan/spec.md');
  runLaneOrError('b-dir-exit', 'p1');
  fs.mkdirSync(path.join(root, 'sessions', SID, 'artifacts', 'b-dir-exit', 'exec', 'e1', 'data'), { recursive: true });
  // r2 新增：目录语义要求**非空**（空目录不得冒充产物）⇒ 目录内放一个真实文件
  art('b-dir-exit', 'exec/e1/data/out.txt');
  const r = runLaneOrError('b-dir-exit', 'e1');
  assert.ok(!(r instanceof Error), String(r.message));
  assert.equal(r.lanes.e1, 'merged');
});

// 【r2 同步 · 裁定 ②】文件语义负例对照（**不在本文件**：属本批 RED 网，见
//   `test/gate-hardening-red.test.js` T15 的 (c) 子例）：
//   声明**不带** `/` 结尾 ⇒ 文件语义 ⇒ outputs 给目录必须**拒 merged**。
//   **r2 前为 RED**（同上 `st.isDirectory() → true` 的隐式放行）；r2 实现「声明形态二分」后
//   该负例**已 GREEN**，由 `test/gate-hardening-red.test.js` T15 承载（e3 于 gate-techdebt 批
//   实测 T15 整体 pass，见 `exec/q-h-t15-run.txt` 原始输出）。
//   本文件只承载「与本批新语义**兼容**」的同步断言，保持既有套件负载中性（改前改后皆通过）。

test('L0：plan merged 前 spec 缺必填章节 → 拒绝', () => {
  makePlan('b-l0', tasks3());
  art('b-l0', 'plan/spec.md', '# spec without sections');
  art('b-l0', 'plan/task-tree.json');
  const r = runLaneOrError('b-l0', 'p1');
  assert.ok(r instanceof Error && /GATE_PLAN_CONTRACT/.test(r.message), String(r.message));
});

test('L0：spec 齐备 + task-tree 合法 JSON → plan merged 通过', () => {
  makePlan('b-l0b', tasks3());
  art('b-l0b', 'plan/spec.md');
  art('b-l0b', 'plan/task-tree.json');
  const r = runLaneOrError('b-l0b', 'p1');
  assert.ok(!(r instanceof Error), String(r.message));
  assert.equal(r.lanes.p1, 'merged');
});

test('Exit Gate exec：merged 前 outputs 缺失 → 拒绝', () => {
  makePlan('b-ex', tasks3());
  art('b-ex', 'plan/spec.md'); art('b-ex', 'plan/task-tree.json');
  runLaneOrError('b-ex', 'p1');
  runLaneOrError('b-ex', 'e1'); // e1 未写 outputs → merged 被拒
  assert.equal(store.readBatch(SID, 'b-ex').lanes.e1, 'review');
});

// K3（2026-09-21）改判：返工边 `review→running` 已去除 ⇒ 门禁拒后**不可原地重来**（旧口径：补写产物后重跑同一 lane）。
//   拒 = 零写入 ⇒ lane 停在 `review`；恢复路径按 K3 = **gap-list + 新任务批次**（此处用同规格新批验证可结算）。
test('Exit Gate audit：merged 前 produce 缺失 → 拒绝；拒后不可原地重来（恢复 = gap-list + 新批次）', () => {
  makePlan('b-au', tasks3());
  art('b-au', 'plan/spec.md'); art('b-au', 'plan/task-tree.json');
  runLaneOrError('b-au', 'p1');
  art('b-au', 'exec/e1/main.py');
  runLaneOrError('b-au', 'e1');
  const r = runLaneOrError('b-au', 'a1'); // audit produce 未写
  assert.ok(r instanceof Error && /GATE_EXIT_MISSING_AUDIT/.test(r.message), String(r.message));
  // 拒 = 零写入 ⇒ 状态不变（仍 review，非终态）
  assert.equal(store.readBatch(SID, 'b-au').lanes.a1, 'review');
  // 原地重派已被去边否决
  const retry = set(SID, 'b-au', 'a1', 'running');
  assert.ok(retry instanceof Error && /invalid member transition: review -> running/.test(retry.message), String(retry && retry.message));
  // 恢复路径 = 新任务批次：同规格另开一批，产物齐备 ⇒ 正常结算并留 gate.passed
  makePlan('b-au2', tasks3());
  art('b-au2', 'plan/spec.md'); art('b-au2', 'plan/task-tree.json');
  runLaneOrError('b-au2', 'p1');
  art('b-au2', 'exec/e1/main.py');
  runLaneOrError('b-au2', 'e1');
  art('b-au2', 'audit/review.md');
  art('b-au2', 'audit/gap-list.json');
  const ok = runLaneOrError('b-au2', 'a1');
  assert.ok(!(ok instanceof Error), String(ok && ok.message));
  assert.ok(ok.events.some((e) => e.type === 'gate.passed' && e.lane === 'a1'));
});

test('Complete Gate：audit 未完成 → 拒绝；audit 完成后通过', () => {
  makePlan('b-c', tasks3());
  art('b-c', 'plan/spec.md'); art('b-c', 'plan/task-tree.json');
  runLaneOrError('b-c', 'p1');
  art('b-c', 'exec/e1/main.py');
  runLaneOrError('b-c', 'e1');
  store.setPhase(SID, 'b-c', 'running');
  let r1;
  try { store.setPhase(SID, 'b-c', 'complete'); r1 = null; } catch (e) { r1 = e; }
  assert.ok(r1 instanceof Error && /GATE_EXIT_PENDING_AUDIT/.test(r1.message), String(r1.message));
  art('b-c', 'audit/review.md'); art('b-c', 'audit/gap-list.json');
  runLaneOrError('b-c', 'a1');
  const r2 = store.setPhase(SID, 'b-c', 'complete');
  assert.ok(!(r2 instanceof Error), String(r2.message));
  assert.equal(r2.phase, 'complete');
});

test('generic（无 layer）：拒绝免检——无 layer 拒结算 + 批次不得 complete（r2 同步）', () => {
  // 【r2 同步 · Q-6①/B2+B3】旧口径「generic（无 layer）整 lane 免检、零执行零验收亦可 complete」已废除。
  //   新语义：① 无 `layer` 的 lane 不得整 lane 免检 ⇒ exit 门拒 `GATE_LANE_LAYER_MISSING`；
  //          ② 批次既无 exec 也无 audit ⇒ complete 拒 `GATE_COMPLETE_NO_TIER`。
  const plan = buildWavePlan({ batchId: 'b-gen', tasks: [{ id: 't1', cmd: 'x' }] });
  store.createBatch(SID, { batchId: 'b-gen', wavePlan: plan });
  const r1 = set(SID, 'b-gen', 't1', 'running'); // entry 门只约束 exec/audit 层 ⇒ 无 layer 的 lane 在此零感知
  assert.ok(!(r1 instanceof Error), String(r1 && r1.message));
  const r2 = set(SID, 'b-gen', 't1', 'review');
  assert.ok(!(r2 instanceof Error), String(r2 && r2.message));
  const r3 = set(SID, 'b-gen', 't1', 'merged');
  assert.ok(r3 instanceof Error && /GATE_LANE_LAYER_MISSING/.test(r3.message), String(r3 && r3.message));
  store.setPhase(SID, 'b-gen', 'running');
  let r4;
  try { store.setPhase(SID, 'b-gen', 'complete'); r4 = null; } catch (e) { r4 = e; }
  assert.ok(r4 instanceof Error && /GATE_COMPLETE_NO_TIER/.test(r4.message), String(r4 && r4.message));
});

// ---- needHuman 人工闸（复用 review 态挂起；不新增成员态）----
// 【r2 同步 · B4】a1 的 `standalone: true`（旧口径：audit 无上游 ⇒ 自声明放行）改为真 `consume`
//   （B5：audit 必须锚到 plan 判据来源）——否则 entry 门以 `GATE_STANDALONE_UNJUSTIFIED` 拒派。
const NEEDHUMAN_TASKS = [
  { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
  { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1/main.py'], cmd: 'code', deps: ['p1'] },
    { id: 'a1', layer: 'audit', role: 'reviewer', consume: ['plan/spec.md'], produce: ['audit/acceptance.md'], cmd: 'review', deps: ['e1'] },
];
// 三层批次跑完 plan/exec，audit 产物按需写入并派发 a1→running 后返回 batchId
function setupNeedHuman(batchId, acceptance = '# 验收\nneedHuman: true\n') {
  makePlan(batchId, NEEDHUMAN_TASKS);
  art(batchId, 'plan/spec.md');
  runLaneOrError(batchId, 'p1');
  art(batchId, 'exec/e1/main.py');
  runLaneOrError(batchId, 'e1');
  art(batchId, 'audit/acceptance.md', acceptance);
  const r = set(SID, batchId, 'a1', 'running'); // 派发 audit lane（产物已备）
  if (r instanceof Error) throw r;
  return batchId;
}

test('needHuman N1：audit 产物含 needHuman: true → running→review 留 lane.needhuman 事件（lane+产物路径）', () => {
  const id = setupNeedHuman('b-nh1');
  const r = set(SID, id, 'a1', 'review');
  assert.ok(!(r instanceof Error), String(r.message));
  const b = store.readBatch(SID, id);
  const ev = b.events.find((e) => e.type === 'lane.needhuman');
  assert.ok(ev, 'expect lane.needhuman event');
  assert.equal(ev.lane, 'a1');
  assert.equal(ev.path, 'audit/acceptance.md');
});

test('needHuman N2：review→merged 无 human 证据 → 拒 GATE_NEEDHUMAN_PENDING + gate.needhuman_blocked 留痕', () => {
  const id = setupNeedHuman('b-nh2');
  set(SID, id, 'a1', 'review');
  const r = set(SID, id, 'a1', 'merged', 'looks fine');
  assert.ok(r instanceof Error && /GATE_NEEDHUMAN_PENDING/.test(r.message), String(r.message));
  const b = store.readBatch(SID, id);
  assert.equal(b.lanes.a1, 'review'); // 仍挂 review，不落终态
  assert.ok(b.events.some((e) => e.type === 'gate.needhuman_blocked' && e.lane === 'a1'));
});

test('needHuman N3：note 含 human: 证据 → merged 放行 + human.decision 事件（note 可回溯）', () => {
  const id = setupNeedHuman('b-nh3');
  set(SID, id, 'a1', 'review');
  const r = set(SID, id, 'a1', 'merged', 'human:user@2026-08-21:accept');
  assert.ok(!(r instanceof Error), String(r.message));
  assert.equal(r.lanes.a1, 'merged');
  const ev = r.events.find((e) => e.type === 'human.decision');
  assert.ok(ev, 'expect human.decision event');
  assert.equal(ev.note, 'human:user@2026-08-21:accept');
});

test('needHuman：conflict 驳回不强制 human 证据（评审驳回语义，不追加 human.decision）', () => {
  const id = setupNeedHuman('b-nh4');
  set(SID, id, 'a1', 'review');
  const r = set(SID, id, 'a1', 'conflict', '评审驳回（needHuman 未裁决即驳回）：用户 2026-09-14 裁决（grilling Q10=A）：新语义下 note 为必填，补参数不涉断言改写');
  assert.ok(!(r instanceof Error), String(r.message));
  assert.equal(r.lanes.a1, 'conflict');
  assert.ok(!r.events.some((e) => e.type === 'human.decision'));
});

test('needHuman N4：挂 review 未裁决 → complete 拒（GATE_EXIT_PENDING_AUDIT 既有语义）；裁决后通过', () => {
  const id = setupNeedHuman('b-nh5');
  set(SID, id, 'a1', 'review');
  store.setPhase(SID, id, 'running');
  let r1;
  try { store.setPhase(SID, id, 'complete'); r1 = null; } catch (e) { r1 = e; }
  assert.ok(r1 instanceof Error && /GATE_EXIT_PENDING_AUDIT/.test(r1.message), String(r1.message));
  set(SID, id, 'a1', 'merged', 'human:user@2026-08-21:accept');
  const r2 = store.setPhase(SID, id, 'complete');
  assert.ok(!(r2 instanceof Error), String(r2.message));
  assert.equal(r2.phase, 'complete');
});

test('needHuman N5：无 needHuman 声明的 audit lane merged 不要求证据（零侵入）', () => {
  makePlan('b-nh6', tasks3()); // tasks3 的 a1 produce 无 needHuman 声明
  art('b-nh6', 'plan/spec.md'); art('b-nh6', 'plan/task-tree.json');
  runLaneOrError('b-nh6', 'p1');
  art('b-nh6', 'exec/e1/main.py');
  runLaneOrError('b-nh6', 'e1');
  art('b-nh6', 'audit/review.md'); art('b-nh6', 'audit/gap-list.json');
  const r = runLaneOrError('b-nh6', 'a1'); // merged 无 note
  assert.ok(!(r instanceof Error), String(r.message));
  assert.equal(r.lanes.a1, 'merged');
  assert.ok(!r.events.some((e) => e.type === 'lane.needhuman'));
});

test('needHuman：detectNeedHuman 独立行语义——行首 needHuman: true 命中；内嵌/非行首不误判；缺失/空/目录产物跳过', () => {
  const dir = path.join(root, 'sessions', SID, 'artifacts', 'b-nh7');
  fs.mkdirSync(path.join(dir, 'audit'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'audit', 'hit.md'), '# 验收\nneedHuman: true\n- 其余内容\n');
  fs.writeFileSync(path.join(dir, 'audit', 'miss.md'), '# 验收\n<!-- needHuman: true -->\nneedHuman: false\n');
  fs.mkdirSync(path.join(dir, 'audit', 'adir'), { recursive: true });
  const d1 = detectNeedHuman(dir, ['audit/hit.md']);
  assert.equal(d1.declared, true); assert.equal(d1.path, 'audit/hit.md');
  // 未命中产物跳过，命中首个声明产物即返回
  const d2 = detectNeedHuman(dir, ['audit/miss.md', 'audit/hit.md']);
  assert.equal(d2.declared, true); assert.equal(d2.path, 'audit/hit.md');
  assert.equal(detectNeedHuman(dir, ['audit/miss.md']).declared, false); // 内嵌注释/非行首不命中
  assert.equal(detectNeedHuman(dir, ['audit/missing.md']).declared, false); // 缺失文件跳过
  assert.equal(detectNeedHuman(dir, ['audit/adir']).declared, false); // 目录跳过
  assert.equal(detectNeedHuman(dir, []).declared, false); // 空 produce 零感知
});

// ---- V1 命令 gate（spec G1-G13 冒烟口径，全量断言/回归归 Tester）----
// 【r2 同步 · B4】a1 同上：`standalone: true` 改为真 `consume`（B5 判据来源锚定）。
const CMD_TASKS = [
  { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
  { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/test-report.md'], cmd: 'code', deps: ['p1'] },
    { id: 'a1', layer: 'audit', role: 'reviewer', consume: ['plan/spec.md'], produce: ['audit/acceptance.md'], cmd: 'review', deps: ['e1'] },
];

test('命令 gate G1：detectGate 独立行语义——行首命中/多行保序；内嵌/注释/非行首/gate:false/空命令不误判；缺失/空/目录跳过', () => {
  const dir = path.join(root, 'sessions', SID, 'artifacts', 'b-cg-detect');
  fs.mkdirSync(path.join(dir, 'exec'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'exec', 'hit.md'), [
    '# 验证结果',
    '- pytest 全量通过',
    'gate: python -m pytest tests/a.py -q',
    'gate: python -m py_compile lib/state/gates.js',
    'needHuman: true',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'exec', 'miss.md'), [
    '# 无声明',
    '<!-- gate: python x.py -->',
    'inline gate: python y.py',
    'gate: false',
    'gate:',
    '',
  ].join('\n'));
  fs.mkdirSync(path.join(dir, 'exec', 'adir'), { recursive: true });
  const d1 = detectGate(dir, ['exec/hit.md']);
  assert.equal(d1.declared, true);
  assert.deepEqual(d1.commands, ['python -m pytest tests/a.py -q', 'python -m py_compile lib/state/gates.js']); // 保序收集
  assert.equal(d1.path, 'exec/hit.md');
  // 内嵌注释/非行首/gate:false/空命令全部不产生命令 → declared=false（零感知）
  assert.equal(detectGate(dir, ['exec/miss.md']).declared, false);
  assert.equal(detectGate(dir, ['exec/missing.md']).declared, false); // 缺失文件跳过
  assert.equal(detectGate(dir, ['exec/adir']).declared, false); // 目录跳过
  assert.equal(detectGate(dir, []).declared, false); // 空 paths 零感知
});

test('命令 gate G4：exit 0 → merged 放行 + gate.exit 事件（命令/exitCode/耗时）', () => {
  makePlan('b-cg-ok', CMD_TASKS);
  art('b-cg-ok', 'plan/spec.md');
  runLaneOrError('b-cg-ok', 'p1');
  art('b-cg-ok', 'exec/test-report.md', '# 验证\n- ok\ngate: node -e "process.exit(0)"\n');
  const r = runLaneOrError('b-cg-ok', 'e1');
  assert.ok(!(r instanceof Error), String(r && r.message));
  assert.equal(r.lanes.e1, 'merged');
  const ev = r.events.find((e) => e.type === 'gate.exit');
  assert.ok(ev, 'expect gate.exit');
  assert.equal(ev.commands.length, 1);
  assert.equal(ev.results[0].exitCode, 0);
  assert.ok(typeof ev.results[0].durationMs === 'number');
});

test('命令 gate G4：exit 非 0 → 拒 merged 抛 GATE_EXIT_NONZERO + gate.exit_blocked 留痕，lane 留 review', () => {
  makePlan('b-cg-nz', CMD_TASKS);
  art('b-cg-nz', 'plan/spec.md');
  runLaneOrError('b-cg-nz', 'p1');
  art('b-cg-nz', 'exec/test-report.md', '# 验证\ngate: node -e "process.exit(3)"\n');
  const r = runLaneOrError('b-cg-nz', 'e1');
  assert.ok(r instanceof Error && /GATE_EXIT_NONZERO/.test(r.message), String(r && r.message));
  const b = store.readBatch(SID, 'b-cg-nz');
  assert.equal(b.lanes.e1, 'review'); // 失败 lane 留 review（非终态，C4）
  const ev = b.events.find((e) => e.type === 'gate.exit_blocked');
  assert.ok(ev && ev.code === 'GATE_EXIT_NONZERO' && ev.exitCode === 3, JSON.stringify(ev));
});

test('命令 gate G7：黑名单命令 → GATE_EXIT_FORBIDDEN（拒绝执行，gate.exit_blocked 留痕）', () => {
  makePlan('b-cg-fb', CMD_TASKS);
  art('b-cg-fb', 'plan/spec.md');
  runLaneOrError('b-cg-fb', 'p1');
  art('b-cg-fb', 'exec/test-report.md', '# 验证\ngate: rm -rf /tmp/xxx\n');
  const r = runLaneOrError('b-cg-fb', 'e1');
  assert.ok(r instanceof Error && /GATE_EXIT_FORBIDDEN/.test(r.message), String(r && r.message));
  const ev = store.readBatch(SID, 'b-cg-fb').events.find((e) => e.type === 'gate.exit_blocked');
  assert.ok(ev && ev.code === 'GATE_EXIT_FORBIDDEN', JSON.stringify(ev));
});

test('命令 gate G9：失败 + needHuman 声明 → 转人工闸：无 human 证据拒 GATE_NEEDHUMAN_PENDING；有证据 merged', () => {
  makePlan('b-cg-nh', CMD_TASKS);
  art('b-cg-nh', 'plan/spec.md');
  runLaneOrError('b-cg-nh', 'p1');
  art('b-cg-nh', 'exec/test-report.md', '# 验证\ngate: node -e "process.exit(1)"\nneedHuman: true\n');
  const r1 = set(SID, 'b-cg-nh', 'e1', 'running');
  assert.ok(!(r1 instanceof Error), String(r1 && r1.message));
  const r2 = set(SID, 'b-cg-nh', 'e1', 'review');
  assert.ok(!(r2 instanceof Error), String(r2 && r2.message));
  const r3 = set(SID, 'b-cg-nh', 'e1', 'merged', 'no evidence');
  assert.ok(r3 instanceof Error && /GATE_NEEDHUMAN_PENDING/.test(r3.message), String(r3 && r3.message));
  const b1 = store.readBatch(SID, 'b-cg-nh');
  assert.equal(b1.lanes.e1, 'review'); // 仍挂 review
  assert.ok(b1.events.some((e) => e.type === 'gate.exit_blocked' && e.escalation === true), 'expect escalation event');
  // 人工裁决证据 → merged
  const r4 = set(SID, 'b-cg-nh', 'e1', 'merged', 'human:user@2026-08-25:accept');
  assert.ok(!(r4 instanceof Error), String(r4 && r4.message));
  assert.equal(r4.lanes.e1, 'merged');
  assert.ok(r4.events.some((e) => e.type === 'human.decision'), 'expect human.decision');
});

test('命令 gate G10：未声明 gate → merged 零感知（无 gate.* 事件）', () => {
  makePlan('b-cg-z', CMD_TASKS);
  art('b-cg-z', 'plan/spec.md');
  runLaneOrError('b-cg-z', 'p1');
  art('b-cg-z', 'exec/test-report.md', '# 验证\n- 无 gate 声明\n');
  const r = runLaneOrError('b-cg-z', 'e1');
  assert.ok(!(r instanceof Error), String(r && r.message));
  assert.equal(r.lanes.e1, 'merged');
  assert.ok(!r.events.some((e) => e.type === 'gate.exit' || e.type === 'gate.exit_blocked'), 'expect zero gate events');
});

// ---- F-7（批次 f7-empty-gate-20260915 · 用户裁决「严控勿松」）双向护栏 ----
// 护栏 A（G11）：**空声明 ⇒ 拒**（防将来被改回静默放行）；
// 护栏 B（G12）：**未声明 ⇒ 零感知**（防误伤，与 A 成对）。
// 两例的「改坏 → 转红 → 回退 → 复绿」真跑留档见 lane 产物 `exec/e1/outputs/f7-impl.md`。

test('命令 gate G11：空 `gate:` 行 ⇒ 拒 GATE_EXIT_NO_COMMAND（端到端：抛错 + lane 留 review + 恰 1 条 gate.exit_blocked）', () => {
  makePlan('b-cg-empty', CMD_TASKS);
  art('b-cg-empty', 'plan/spec.md');
  runLaneOrError('b-cg-empty', 'p1');
  art('b-cg-empty', 'exec/test-report.md', '# 验证\ngate:\n'); // 独立行 `gate:`：**已声明**但命令解析为空
  const r = runLaneOrError('b-cg-empty', 'e1');
  assert.ok(r instanceof Error && /GATE_EXIT_NO_COMMAND/.test(r.message),
    'F-7/A1：空声明须拒 GATE_EXIT_NO_COMMAND；实测=' + String(r && r.message));
  const b = store.readBatch(SID, 'b-cg-empty');
  assert.equal(b.lanes.e1, 'review', 'F-7/A1：被拒 lane 须留 review（失败 lane 非终态）');
  const blk = b.events.filter((e) => e.type === 'gate.exit_blocked');
  assert.equal(blk.length, 1, 'F-7/A1：须恰 1 条 gate.exit_blocked；实测=' + JSON.stringify(blk));
  assert.equal(blk[0].code, 'GATE_EXIT_NO_COMMAND', 'F-7/A1：拒码须为 GATE_EXIT_NO_COMMAND；实测=' + JSON.stringify(blk[0]));
  // 声明面位自证：`declared` 语义一字未改（空声明仍不计入 commands），新位 `emptyCommand` 独立承载
  const dir = path.join(root, 'sessions', SID, 'artifacts', 'b-cg-empty');
  const d = detectGate(dir, ['exec/test-report.md']);
  assert.equal(d.declared, false, 'F-7/A4：`declared` 仍恒等 commands.length > 0（向后兼容锚点未动）');
  assert.equal(d.emptyCommand, 'exec/test-report.md', 'F-7：空声明须被「声明面」位捕获（否则与未声明同态）');
  // 位分离（规格 §双向护栏 第三条）：`gate: false`（显式禁用）与空声明**不是同一态**
  art('b-cg-empty', 'exec/off.md', 'out\ngate: false\n');
  const dOff = detectGate(dir, ['exec/off.md']);
  assert.equal(dOff.declared, false, 'F-7/A3：`gate: false` 仍不计入 commands（放行语义不变）');
  assert.equal(dOff.emptyCommand, null, 'F-7/A3：`gate: false` 非空命令 ⇒ 不命中空声明位（与空声明非同一态）');
  art('b-cg-empty', 'exec/both.md', 'out\ngate: false\ngate:\n');
  const dBoth = detectGate(dir, ['exec/both.md']);
  assert.equal(dBoth.declared, false, 'F-7：同一产物含 `gate: false` + `gate:` ⇒ declared 仍 false');
  assert.equal(dBoth.emptyCommand, 'exec/both.md', 'F-7：同一产物内空声明仍被位捕获（两义不互相吞并）');
});

test('命令 gate G12：未声明 `gate:` 行 ⇒ merged 零感知（命令门族零事件；gate.* 仅剩非命令门留痕）', () => {
  makePlan('b-cg-nodecl', CMD_TASKS);
  art('b-cg-nodecl', 'plan/spec.md');
  runLaneOrError('b-cg-nodecl', 'p1');
  art('b-cg-nodecl', 'exec/test-report.md', '# 验证\n- 无 gate 声明\n');
  const r = runLaneOrError('b-cg-nodecl', 'e1');
  assert.ok(!(r instanceof Error), String(r && r.message));
  assert.equal(r.lanes.e1, 'merged', 'F-7/A2：完全未声明 ⇒ 仍放行（不得误伤）');
  const g = r.events.filter((e) => /^gate\./.test(String(e.type)));
  // 命令门族（本批新增/既有的判定面）必须零事件
  const cmdFamily = g.filter((e) => e.type === 'gate.exit' || e.type === 'gate.exit_blocked' || e.type === 'gate.escape');
  assert.equal(cmdFamily.length, 0, 'F-7/A2：未声明 ⇒ 命令门族零事件；实测=' + JSON.stringify(g.map((e) => e.type)));
  // 余下的 `gate.*` 只允许两类**非命令门**留痕，其余一律判红（防「未声明路径」被悄悄加事件）：
  //   ① `gate.passed`——exit 门放行留痕，任何 merged 恒有（与命令门无关）；
  //   ② `gate.contract_missing`——B2 契约缺声明首触留痕（本套件 team=punky-preset 未声明 `flows.exec.gate_command`
  //      ⇒ 引擎基线启用留痕，属**契约面观察**，不改判定；**这是规格「/^gate\./ 全族零事件」在代码上不成立的
  //      唯一原因**（另因 ① 本就存在），故此处以显式白名单等价收紧）。
  const offFamily = g.filter((e) => e.type !== 'gate.passed' && e.type !== 'gate.contract_missing');
  assert.equal(offFamily.length, 0, 'F-7/A2：未声明路径不得出现任何其它 gate.* 事件；实测=' + JSON.stringify(g.map((e) => e.type)));
  // C-8（techdebt-close-20260915 / lane e1）**正向基线断言**（净增，不改上文任何既有语义）：
  //   上面这条白名单是「排除式」断言——它只说明「除（gate.passed|gate.contract_missing）外无其它事件」。
  //   若 `gate.passed` 这个事件**整体消失**（如 `lib/state/store.js:623` 的 EVT_GATE_PASSED 发射点被删），
  //   白名单的**排除集退化为空集**，该断言会**空过**（仍是 0 条 ⇒ 绿），静默失效无人发现。
  //   故此处补一条正向基线：`gate.passed` 必须**实际存在**——与上面的排除式成对，白名单不可退化为空集。
  //   实测：本批两条 lane 走到 merged（上游 p1 + 被测 e1）⇒ 期望条数由 merged lane 数推导，不写死字面量
  //   （既防 `gate.passed` 整体消失 [0 条]，也防白名单将来被并入其它事件类型 [>merged 条]）。
  const mergedLanes = Object.values(r.lanes ?? {}).filter((s) => s === 'merged');
  const passed = g.filter((e) => e.type === 'gate.passed');
  assert.equal(passed.length, mergedLanes.length, 'C-8：`gate.passed` 必须实际存在（每个 merged lane 各 1 条；排除式白名单不得退化为空集）；merged=' + JSON.stringify(mergedLanes) + '；实测事件族=' + JSON.stringify(g.map((e) => e.type)));
  assert.ok(passed.some((e) => e.lane === 'e1'), 'C-8：被测 lane e1 的 exit 门放行留痕必须在场；实测=' + JSON.stringify(passed));
  assert.ok(passed.every((e) => e.gate === 'exit'), 'C-8：该留痕须为 exit 门放行语义（`gate: "exit"`，见 store.js:623）；实测=' + JSON.stringify(passed));
});

// ---- 补充用例：多行集成 / 集成超时 / 非 exec 零感知 / 事件零泄漏 / cwd 契约 / 逃生阀 ----

test('命令 gate V3：多行 gate 全部 exit 0 → merged + gate.exit 事件含全部 commands/results（保序）', () => {
  makePlan('b-cg-v3-ok', CMD_TASKS);
  art('b-cg-v3-ok', 'plan/spec.md');
  runLaneOrError('b-cg-v3-ok', 'p1');
  art('b-cg-v3-ok', 'exec/test-report.md', '# 验证\n- ok\ngate: node -e "process.exit(0)"\ngate: node -e "process.exit(0)"\n');
  const r = runLaneOrError('b-cg-v3-ok', 'e1');
  assert.ok(!(r instanceof Error), String(r && r.message));
  assert.equal(r.lanes.e1, 'merged');
  const ev = r.events.find((e) => e.type === 'gate.exit');
  assert.ok(ev, 'expect gate.exit');
  assert.equal(ev.commands.length, 2, 'expect 2 commands');
  assert.deepEqual(ev.results.map((x) => x.exitCode), [0, 0], 'expect both exit 0 in order');
});

test('命令 gate V3：多行 gate 任一失败 → 短路拒绝（后续命令不执行）+ gate.exit_blocked', () => {
  makePlan('b-cg-v3-short', CMD_TASKS);
  art('b-cg-v3-short', 'plan/spec.md');
  runLaneOrError('b-cg-v3-short', 'p1');
  // 第 2 条命令写标记文件：若被短路执行会留痕
  const marker = path.join(root, 'sessions', SID, 'artifacts', 'b-cg-v3-short', 'marker.txt');
  const cmd2 = 'node -e "require(\'fs\').writeFileSync(\'' + marker.replace(/\\/g, '/') + '\',\'x\')"';
  art('b-cg-v3-short', 'exec/test-report.md', '# 验证\ngate: node -e "process.exit(1)"\ngate: ' + cmd2 + '\n');
  const r = runLaneOrError('b-cg-v3-short', 'e1');
  assert.ok(r instanceof Error && /GATE_EXIT_NONZERO/.test(r.message), String(r && r.message));
  assert.ok(!fs.existsSync(marker), 'expect second command NOT executed (short-circuit)');
  const ev = store.readBatch(SID, 'b-cg-v3-short').events.find((e) => e.type === 'gate.exit_blocked');
  assert.ok(ev && ev.code === 'GATE_EXIT_NONZERO' && ev.exitCode === 1, JSON.stringify(ev));
});

test('命令 gate V5：集成层超时 → 拒 merged 抛 GATE_EXIT_TIMEOUT（真实短 timeout，不挂起）', () => {
  const prev = process.env.GATE_TIMEOUT_MS;
  process.env.GATE_TIMEOUT_MS = '400';
  try {
    makePlan('b-cg-v5-t', CMD_TASKS);
    art('b-cg-v5-t', 'plan/spec.md');
    runLaneOrError('b-cg-v5-t', 'p1');
    // node 长 sleep（默认 GATE_RETRY=1 → 最多 2 次执行，每次 400ms 超时）
    art('b-cg-v5-t', 'exec/test-report.md', '# 验证\ngate: node -e "setTimeout(()=>{}, 10000)"\n');
    const t0 = Date.now();
    const r = runLaneOrError('b-cg-v5-t', 'e1');
    const dur = Date.now() - t0;
    assert.ok(r instanceof Error && /GATE_EXIT_TIMEOUT/.test(r.message), String(r && r.message));
    assert.ok(dur < 5000, 'expect bounded duration (no hang), got ' + dur + 'ms');
    const b = store.readBatch(SID, 'b-cg-v5-t');
    assert.equal(b.lanes.e1, 'review'); // 失败 lane 留 review
    const ev = b.events.find((e) => e.type === 'gate.exit_blocked');
    assert.ok(ev && ev.code === 'GATE_EXIT_TIMEOUT', JSON.stringify(ev));
  } finally {
    if (prev === undefined) delete process.env.GATE_TIMEOUT_MS; else process.env.GATE_TIMEOUT_MS = prev;
  }
});

test('命令 gate V9【复活·T-14·裁剪】：非 exec/audit 层（plan）产物含 gate 行 → 零感知不执行（D-005）', () => {
  // 【复活要点·2026-09-15 批次 core-debt-parallel-20260915 / lane e2】为何原 todo 被裁剪而非整条解壳：
  //   原体下半段（audit lane）断言「audit 层 `gate:` 行零感知」＝ 固化一条假完成通道，与 S16 正面冲突
  //   （S16 已把命令门作用层由 `exec` 放宽到 **`exec ∪ audit`** ⇒ audit 层命令声明必须真执行，非 0 退出码拒
  //   `GATE_EXIT_NONZERO`）。该段**已由 R-22 覆盖**（`test/gate-techdebt-red.test.js` 用例「R-22 audit 层产物含
  //   命令声明行（exit 7）⇒ 必须真执行并拒 GATE_EXIT_NONZERO」），此处不重复建例，只保留与 S16 作用域不矛盾的
  //   **plan 层零感知**段（判据同源：命令门只对 exec/audit 层生效）。
  makePlan('b-cg-v9-plan', CMD_TASKS);
  art('b-cg-v9-plan', 'plan/spec.md', '# Spec\n## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准\n- x\ngate: node -e "process.exit(1)"\n## 约束\n- y\n');
  const r1 = runLaneOrError('b-cg-v9-plan', 'p1'); // plan lane 产物含 gate 行但为 plan 层
  assert.ok(!(r1 instanceof Error), String(r1 && r1.message));
  assert.equal(r1.lanes.p1, 'merged');
  assert.ok(!r1.events.some((e) => e.type === 'gate.exit' || e.type === 'gate.exit_blocked'), 'plan 层零感知');
});
ARCHIVED_CASES['命令 gate V9：非 exec 层（plan/audit）产物含 gate 行 → 零感知不执行（D-005）'] = [
  '【已复活（裁剪）⇒ 见用例「命令 gate V9【复活·T-14·裁剪】…」（批次 core-debt-parallel-20260915 · lane e2）】',
  '【audit 段不入本用例 ⇒ 由 R-22 覆盖：audit 层命令声明真执行，非 0 退出码 ⇒ 拒 GATE_EXIT_NONZERO】',
  '用户 2026-09-14 裁决（grilling Q1=C）：失效红条不落成新契约，正确断言留待独立小批；',
  '  本条因「它断言 audit 层 `gate:` 行『零感知不执行』= 在固化一条假完成通道，与 S16 正面冲突」转 todo。',
  '说明：S16（e1，wave3）已把命令门作用层由 `exec` 放宽到 **`exec ∪ audit`** ⇒ audit 层产物里的 `gate:` 行',
  '  **必须真执行**（非 0 退出码 ⇒ 拒 `GATE_EXIT_NONZERO`）。本用例下半段（audit lane）的正确期望与 R-22 相同、',
  '  与 R-22 重复，故此**整条用例**转 `test.todo`：用例名 ＋ 原断言文本**逐字保留**（下方缩进注释即原文，',
  '  便于后续独立小批复活；也可直接删掉 `test.todo(...)` 的外壳恢复执行）。',
  '  原断言（逐字，2 条）：',
  '    assert.equal(r2.lanes.a1, \'merged\');',
  '    assert.ok(!r2.events.some((e) => e.type === \'gate.exit\' || e.type === \'gate.exit_blocked\'), \'audit 层零感知\');',
  '  makePlan(\'b-cg-v9-plan\', CMD_TASKS);',
  '  art(\'b-cg-v9-plan\', \'plan/spec.md\', \'# Spec\\n## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准\\n- x\\ngate: node -e "process.exit(1)"\\n## 约束\\n- y\\n\');',
  '  const r1 = runLaneOrError(\'b-cg-v9-plan\', \'p1\'); // plan lane 产物含 gate 行但为 plan 层',
  '  assert.ok(!(r1 instanceof Error), String(r1 && r1.message));',
  '  assert.equal(r1.lanes.p1, \'merged\');',
  '  assert.ok(!r1.events.some((e) => e.type === \'gate.exit\' || e.type === \'gate.exit_blocked\'), \'plan 层零感知\');',
  '  // audit lane：produce 含 gate 行',
  '  makePlan(\'b-cg-v9-audit\', CMD_TASKS);',
  '  art(\'b-cg-v9-audit\', \'plan/spec.md\');',
  '  runLaneOrError(\'b-cg-v9-audit\', \'p1\');',
  '  art(\'b-cg-v9-audit\', \'exec/test-report.md\', \'# 验证\\n- ok\\n\');',
  '  runLaneOrError(\'b-cg-v9-audit\', \'e1\');',
  '  art(\'b-cg-v9-audit\', \'audit/acceptance.md\', \'# 验收\\ngate: node -e "process.exit(1)"\\n- ok\\n\');',
  '  const r2 = runLaneOrError(\'b-cg-v9-audit\', \'a1\');',
  '  assert.ok(!(r2 instanceof Error), String(r2 && r2.message));',
  '  assert.equal(r2.lanes.a1, \'merged\');',
  '  assert.ok(!r2.events.some((e) => e.type === \'gate.exit\' || e.type === \'gate.exit_blocked\'), \'audit 层零感知\');',
];

test('命令 gate V10：env 注入可用 + 事件零凭据泄漏（gate.exit 事件不含 env 值）', () => {
  const secret = 'PUNKY_TEST_SECRET_9f8e7d';
  makePlan('b-cg-v10-env', CMD_TASKS);
  art('b-cg-v10-env', 'plan/spec.md');
  runLaneOrError('b-cg-v10-env', 'p1');
  // 命令从 env 读凭据并输出（命令成功执行 = env 注入可用；事件载荷不含 output/凭据值）
  art('b-cg-v10-env', 'exec/test-report.md', '# 验证\ngate: node -e "console.log(process.env.A || \'none\')"\n');
  const prev = process.env.A;
  process.env.A = secret;
  try {
    const r = runLaneOrError('b-cg-v10-env', 'e1');
    assert.ok(!(r instanceof Error), String(r && r.message));
    assert.equal(r.lanes.e1, 'merged');
    const ev = r.events.find((e) => e.type === 'gate.exit');
    assert.ok(ev, 'expect gate.exit');
    const json = JSON.stringify(r.events);
    assert.ok(!json.includes(secret), '事件零凭据值泄漏（env 注入不入事件）');
  } finally {
    if (prev === undefined) delete process.env.A; else process.env.A = prev;
  }
});

test('命令 gate V11：cwd 契约——默认 artifacts 兜底；GATE_REPO_ROOT env 生效；cd 自控', () => {
  // 子用例 1：默认（无 worktree、无 GATE_REPO_ROOT）→ artifacts 根兜底
  makePlan('b-cg-v11-cwd', CMD_TASKS);
  art('b-cg-v11-cwd', 'plan/spec.md');
  runLaneOrError('b-cg-v11-cwd', 'p1');
  const marker1 = path.join(root, 'sessions', SID, 'artifacts', 'b-cg-v11-cwd', 'cwd1.txt');
  art('b-cg-v11-cwd', 'exec/test-report.md', '# 验证\ngate: node -e "require(\'fs\').writeFileSync(\'' + marker1.replace(/\\/g, '/') + '\', process.cwd())"\n');
  const r1 = runLaneOrError('b-cg-v11-cwd', 'e1');
  assert.ok(!(r1 instanceof Error), String(r1 && r1.message));
  const want1 = path.join(root, 'sessions', SID, 'artifacts', 'b-cg-v11-cwd');
  assert.equal(fs.readFileSync(marker1, 'utf8').trim().replace(/\\/g, '/'), want1.replace(/\\/g, '/'), '默认 cwd = artifacts 兜底');
  // 子用例 2：GATE_REPO_ROOT env 生效（无 worktree 时优先 repo 根配置）
  makePlan('b-cg-v11-repo', CMD_TASKS);
  art('b-cg-v11-repo', 'plan/spec.md');
  runLaneOrError('b-cg-v11-repo', 'p1');
  const marker2 = path.join(root, 'sessions', SID, 'artifacts', 'b-cg-v11-repo', 'cwd2.txt');
  const prevRoot = process.env.GATE_REPO_ROOT;
  process.env.GATE_REPO_ROOT = root + '-repo-root';
  fs.mkdirSync(process.env.GATE_REPO_ROOT, { recursive: true }); // 目录须真实存在（commandCwd 校验后生效）
  try {
    art('b-cg-v11-repo', 'exec/test-report.md', '# 验证\ngate: node -e "require(\'fs\').writeFileSync(\'' + marker2.replace(/\\/g, '/') + '\', process.cwd())"\n');
    const r2 = runLaneOrError('b-cg-v11-repo', 'e1');
    assert.ok(!(r2 instanceof Error), String(r2 && r2.message));
    assert.equal(fs.readFileSync(marker2, 'utf8').trim().replace(/\\/g, '/'), process.env.GATE_REPO_ROOT.replace(/\\/g, '/'), 'GATE_REPO_ROOT 生效');
  } finally {
    if (prevRoot === undefined) delete process.env.GATE_REPO_ROOT; else process.env.GATE_REPO_ROOT = prevRoot;
  }
  // 子用例 3：worktree 根优先（若已建）——直接调 commandCwd 语义（checkCommandGate 内），建 worktree 目录验证
  const gates = createGates(root);
  const wtDir = path.join(root, 'sessions', SID, 'worktrees', 'b-cg-v11-cwd', 'e1');
  fs.mkdirSync(wtDir, { recursive: true });
  // 复用 b-cg-v11-cwd 批次（e1 已 merged，仅验证 cwd 解析：直接构造 gate 声明场景不可行，故以 commandCwd 单测口径）
  // 说明：commandCwd 为 createGates 内部函数，通过 checkCommandGate DI mock 捕获 cwd 验证 worktree 优先
  let capturedCwd = null;
  const mockRun = (opts) => { capturedCwd = opts.cwd; return { ok: true, exitCode: 0, output: '', durationMs: 1, truncated: false, forbidden: false, timedOut: false, error: null }; };
  const batch = store.readBatch(SID, 'b-cg-v11-cwd');
  const cg = gates.checkCommandGate(SID, 'b-cg-v11-cwd', batch, 'e1', { runCommand: mockRun });
  assert.ok(cg.ok, JSON.stringify(cg));
  assert.equal(capturedCwd.replace(/\\/g, '/'), wtDir.replace(/\\/g, '/'), 'worktree 根优先');
});

test('命令 gate C5：GATE_ENABLED=false → 全部零感知（应急逃生阀，不执行声明命令）', () => {
  const prev = process.env.GATE_ENABLED;
  process.env.GATE_ENABLED = 'false';
  try {
    makePlan('b-cg-v9-off', CMD_TASKS);
    art('b-cg-v9-off', 'plan/spec.md');
    runLaneOrError('b-cg-v9-off', 'p1');
    art('b-cg-v9-off', 'exec/test-report.md', '# 验证\ngate: node -e "process.exit(1)"\n');
    const r = runLaneOrError('b-cg-v9-off', 'e1');
    assert.ok(!(r instanceof Error), String(r && r.message));
    assert.equal(r.lanes.e1, 'merged', '逃生阀关闭时 gate 失败命令也不拦截');
    assert.ok(!r.events.some((e) => e.type === 'gate.exit' || e.type === 'gate.exit_blocked'), '无 gate 事件');
  } finally {
    if (prev === undefined) delete process.env.GATE_ENABLED; else process.env.GATE_ENABLED = prev;
  }
});

// ---- targets 门禁（冒烟口径）----
// 三层批次 + e1 声明 targets（绝对路径）；target 文件写于引擎产物根之外（批次外临时文件，模拟既有源码/配置）
function makeTargetBatch(batchId, targets, opts = {}) {
  makePlan(batchId, [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1/main.py'], cmd: 'code', deps: ['p1'], targets, targetsMarker: opts.targetsMarker ?? null },
    { id: 'a1', layer: 'audit', role: 'reviewer', produce: ['audit/review.md'], cmd: 'review', deps: ['e1'], standalone: true },
  ]);
  art(batchId, 'plan/spec.md');
  runLaneOrError(batchId, 'p1');
  art(batchId, 'exec/e1/main.py');
  return batchId;
}
// e1 分步流转（running 后写 target，保证 mtime 晚于 lane 启动）
function setTargetMtime(abs, ms) {
  const d = new Date(ms);
  fs.utimesSync(abs, d, d);
}
// 引擎产物根外临时 target 文件（模拟既有源码/配置；绝对路径）
function mkTarget(prefix, content = 'code') {
  const abs = path.join(root, 'targets-' + prefix + '-' + Math.random().toString(36).slice(2) + '.js');
  fs.writeFileSync(abs, content);
  return abs;
}

test('O2 T1：targets 存在 + mtime 晚于 lane 启动 → merged 放行 + gate.target.passed 事件', () => {
  const id = 'b-tg-t1';
  const target = mkTarget('t1');
  makeTargetBatch(id, [target]);
  const r1 = set(SID, id, 'e1', 'running');
  assert.ok(!(r1 instanceof Error), String(r1 && r1.message));
  setTargetMtime(target, Date.now() + 60000); // mtime 设未来（晚于 running 启动，防精度抖动）
  const r2 = set(SID, id, 'e1', 'review');
  assert.ok(!(r2 instanceof Error), String(r2 && r2.message));
  const r3 = set(SID, id, 'e1', 'merged');
  assert.ok(!(r3 instanceof Error), String(r3 && r3.message));
  assert.equal(r3.lanes.e1, 'merged');
  const ev = r3.events.find((e) => e.type === 'gate.target.passed');
  assert.ok(ev, 'expect gate.target.passed');
  assert.equal(ev.mode, 'mtime');
  assert.deepEqual(ev.targets, [target]);
});

test('O2 T2：targets 存在但 mtime 早于/等于 lane 启动 → 拒 merged 抛 GATE_TARGET_UNCHANGED + gate.target_blocked，lane 留 review', () => {
  const id = 'b-tg-t2';
  const target = mkTarget('t2');
  makeTargetBatch(id, [target]);
  setTargetMtime(target, Date.now() - 60000); // mtime 设过去（早于 lane 启动 = 未变更）
  const r1 = set(SID, id, 'e1', 'running');
  assert.ok(!(r1 instanceof Error), String(r1 && r1.message));
  const r2 = set(SID, id, 'e1', 'review');
  assert.ok(!(r2 instanceof Error), String(r2 && r2.message));
  const r3 = set(SID, id, 'e1', 'merged');
  assert.ok(r3 instanceof Error && /GATE_TARGET_UNCHANGED/.test(r3.message), String(r3 && r3.message));
  const b = store.readBatch(SID, id);
  assert.equal(b.lanes.e1, 'review'); // 失败 lane 留 review（成员态不变）
  const ev = b.events.find((e) => e.type === 'gate.target_blocked');
  assert.ok(ev && ev.code === 'GATE_TARGET_UNCHANGED', JSON.stringify(ev));
  assert.deepEqual(ev.unchanged, [target]);
});

test('O2 T3：targets 路径不存在 → 拒 merged 抛 GATE_TARGET_MISSING + gate.target_blocked，lane 留 review', () => {
  const id = 'b-tg-t3';
  const target = path.join(root, 'targets-missing-' + Math.random().toString(36).slice(2) + '.js'); // 不存在
  makeTargetBatch(id, [target]);
  const r1 = set(SID, id, 'e1', 'running');
  assert.ok(!(r1 instanceof Error), String(r1 && r1.message));
  const r2 = set(SID, id, 'e1', 'review');
  assert.ok(!(r2 instanceof Error), String(r2 && r2.message));
  const r3 = set(SID, id, 'e1', 'merged');
  assert.ok(r3 instanceof Error && /GATE_TARGET_MISSING/.test(r3.message), String(r3 && r3.message));
  const b = store.readBatch(SID, id);
  assert.equal(b.lanes.e1, 'review');
  const ev = b.events.find((e) => e.type === 'gate.target_blocked');
  assert.ok(ev && ev.code === 'GATE_TARGET_MISSING', JSON.stringify(ev));
  assert.deepEqual(ev.missing, [target]);
});

test('O2 T3b：targets 为目录（非文件）→ 视同缺失 GATE_TARGET_MISSING', () => {
  const id = 'b-tg-t3d';
  const dir = path.join(root, 'targets-dir-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(dir, { recursive: true });
  makeTargetBatch(id, [dir]);
  set(SID, id, 'e1', 'running');
  set(SID, id, 'e1', 'review');
  const r3 = set(SID, id, 'e1', 'merged');
  assert.ok(r3 instanceof Error && /GATE_TARGET_MISSING/.test(r3.message), String(r3 && r3.message));
});

test('O2 T4：未声明 targets → merged 零感知（无 gate.target.* 事件，既有行为不变）', () => {
  const id = 'b-tg-t4';
  makePlan(id, tasks3());
  art(id, 'plan/spec.md'); art(id, 'plan/task-tree.json');
  runLaneOrError(id, 'p1');
  art(id, 'exec/e1/main.py');
  const r = runLaneOrError(id, 'e1');
  assert.ok(!(r instanceof Error), String(r && r.message));
  assert.equal(r.lanes.e1, 'merged');
  assert.ok(!r.events.some((e) => e.type === 'gate.target.passed' || e.type === 'gate.target_blocked'), '无 targets 事件（零感知）');
});

test('O2 T5：非 exec 层（plan/audit）声明 targets → 零感知', () => {
  const id = 'b-tg-t5';
  makePlan(id, [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec', targets: ['D:\\fake\\plan-target.js'] },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1/main.py'], cmd: 'code', deps: ['p1'] },
    { id: 'a1', layer: 'audit', role: 'reviewer', consume: ['plan/spec.md'], produce: ['audit/review.md'], cmd: 'review', deps: ['e1'], targets: ['D:\\fake\\audit-target.js'] },
  ]);
  art(id, 'plan/spec.md');
  const r1 = runLaneOrError(id, 'p1'); // plan 层声明 targets（不存在的假路径也不拦）
  assert.ok(!(r1 instanceof Error), String(r1 && r1.message));
  assert.equal(r1.lanes.p1, 'merged');
  assert.ok(!r1.events.some((e) => e.type === 'gate.target.passed' || e.type === 'gate.target_blocked'), 'plan 层零感知');
  art(id, 'exec/e1/main.py');
  runLaneOrError(id, 'e1');
  art(id, 'audit/review.md');
  const r3 = runLaneOrError(id, 'a1'); // audit 层声明 targets → 零感知
  assert.ok(!(r3 instanceof Error), String(r3 && r3.message));
  assert.equal(r3.lanes.a1, 'merged');
  assert.ok(!r3.events.some((e) => e.type === 'gate.target.passed' || e.type === 'gate.target_blocked'), 'audit 层零感知');
});

test('O2 T6：marker 逃生——GATE_TARGETS_MODE=marker + 内容含声明标记 → merged 放行（跳过 mtime）', () => {
  const prev = process.env.GATE_TARGETS_MODE;
  process.env.GATE_TARGETS_MODE = 'marker';
  try {
    const id = 'b-tg-t6';
    const target = mkTarget('t6', '# 变更\ncode here\ntargets-claimed: true\n');
    makeTargetBatch(id, [target]);
    setTargetMtime(target, Date.now() - 60000); // mtime 早于 lane 启动（CI 复制保留旧 mtime 场景）
    const r1 = set(SID, id, 'e1', 'running');
    assert.ok(!(r1 instanceof Error), String(r1 && r1.message));
    const r2 = set(SID, id, 'e1', 'review');
    assert.ok(!(r2 instanceof Error), String(r2 && r2.message));
    const r3 = set(SID, id, 'e1', 'merged');
    assert.ok(!(r3 instanceof Error), String(r3 && r3.message));
    assert.equal(r3.lanes.e1, 'merged');
    const ev = r3.events.find((e) => e.type === 'gate.target.passed');
    assert.ok(ev && ev.mode === 'marker', JSON.stringify(ev));
  } finally {
    if (prev === undefined) delete process.env.GATE_TARGETS_MODE; else process.env.GATE_TARGETS_MODE = prev;
  }
});

test('O2 T6b：marker 模式开启但内容无声明标记 → 未命中拒 GATE_TARGET_UNCHANGED（fail-closed）', () => {
  const prev = process.env.GATE_TARGETS_MODE;
  process.env.GATE_TARGETS_MODE = 'marker';
  try {
    const id = 'b-tg-t6b';
    const target = mkTarget('t6b', '# 无标记\n');
    makeTargetBatch(id, [target]);
    setTargetMtime(target, Date.now() - 60000);
    set(SID, id, 'e1', 'running');
    set(SID, id, 'e1', 'review');
    const r3 = set(SID, id, 'e1', 'merged');
    assert.ok(r3 instanceof Error && /GATE_TARGET_UNCHANGED/.test(r3.message), String(r3 && r3.message));
  } finally {
    if (prev === undefined) delete process.env.GATE_TARGETS_MODE; else process.env.GATE_TARGETS_MODE = prev;
  }
});

test('O2 T6c：任务级 targetsMarker 非空 → marker 逃生路径生效（无需 env）', () => {
  const id = 'b-tg-t6c';
  const target = mkTarget('t6c', 'targets-claimed: true\n');
  makeTargetBatch(id, [target], { targetsMarker: 'claimed' });
  setTargetMtime(target, Date.now() - 60000); // mtime 早于 lane 启动
  const r1 = set(SID, id, 'e1', 'running');
  assert.ok(!(r1 instanceof Error), String(r1 && r1.message));
  set(SID, id, 'e1', 'review');
  const r3 = set(SID, id, 'e1', 'merged');
  assert.ok(!(r3 instanceof Error), String(r3 && r3.message));
  assert.equal(r3.lanes.e1, 'merged');
  const ev = r3.events.find((e) => e.type === 'gate.target.passed');
  assert.ok(ev && ev.mode === 'marker', JSON.stringify(ev));
});

test('O2 TARGETS_CLAIMED_RE：独立行行首锚定——`targets-claimed: true` 命中；内嵌/注释/非行首/false 不误判', () => {
  assert.equal(TARGETS_CLAIMED_RE.test('targets-claimed: true\n'), true);
  assert.equal(TARGETS_CLAIMED_RE.test('# 变更\ntargets-claimed: true\n- 其余\n'), true);
  assert.equal(TARGETS_CLAIMED_RE.test('<!-- targets-claimed: true -->\n'), false, '注释内嵌不命中');
  assert.equal(TARGETS_CLAIMED_RE.test('inline targets-claimed: true\n'), false, '非行首不命中');
  assert.equal(TARGETS_CLAIMED_RE.test('targets-claimed: false\n'), false, 'false 不命中');
  assert.equal(TARGETS_CLAIMED_RE.test(''), false);
});

// K3（2026-09-21）改判：原用例靠「打回返工（review→running）」重置 targets mtime 基准；去边后该路径已不存在
//   ⇒ 基准**不再被重置**（永远是首次派发 running 的时刻）。基准判据本身不变，仍须拒旧 mtime、放过新 mtime。
test('O2 T8（K3 改判）：返工边去除 ⇒ review→running 被拒，targets 基准不重置（仍以首次 running 为准）', () => {
  const id = 'b-tg-t8';
  const target = mkTarget('t8');
  makeTargetBatch(id, [target]);
  // 首次 running（t0）→ target mtime 设于 t0 之后
  const r1 = set(SID, id, 'e1', 'running');
  assert.ok(!(r1 instanceof Error), String(r1 && r1.message));
  const t0 = r1.events.filter((e) => e.type === 'member.settled' && e.lane === 'e1' && e.to === 'running').pop().ts;
  setTargetMtime(target, Date.now() + 1000);
  set(SID, id, 'e1', 'review');
  // 打回重跑：K3 后非法（返工 = gap-list + 新任务批次，不可原地重派）
  const rw = set(SID, id, 'e1', 'running');
  assert.ok(rw instanceof Error && /invalid member transition: review -> running/.test(rw.message), String(rw && rw.message));
  assert.equal(store.readBatch(SID, id).lanes.e1, 'review', '拒 = 零写入 ⇒ 状态不变');
  // 基准仍是 t0 ⇒ 早于 t0 的 mtime 应拒（GATE_TARGET_UNCHANGED）
  setTargetMtime(target, Date.parse(t0) - 500);
  assert.ok(fs.statSync(target).mtime.getTime() < Date.parse(t0), '前置：mtime 早于首次 running 基准');
  const r4 = set(SID, id, 'e1', 'merged');
  assert.ok(r4 instanceof Error && /GATE_TARGET_UNCHANGED/.test(r4.message), '基准未被重置：旧 mtime 仍不满足: ' + String(r4 && r4.message));
  // 更新 target（mtime 晚于基准）→ merged 通过
  setTargetMtime(target, Date.now() + 60000);
  const r5 = set(SID, id, 'e1', 'merged');
  assert.ok(!(r5 instanceof Error), String(r5 && r5.message));
  assert.equal(r5.lanes.e1, 'merged');
});

test('O2 T10：gate_status 返回 targets/targetsMissing/targetsUnchanged（仅 stat，不读正文）', () => {
  const id = 'b-tg-t10';
  const good = mkTarget('t10-good');
  const stale = mkTarget('t10-stale');
  const gone = path.join(root, 'targets-gone-' + Math.random().toString(36).slice(2) + '.js'); // 不存在
  makeTargetBatch(id, [good, stale, gone]);
  set(SID, id, 'e1', 'running');
  setTargetMtime(good, Date.now() + 60000); // 已变更
  setTargetMtime(stale, Date.now() - 60000); // 未变更
  const gs = store.gateStatus(SID, id, 'e1');
  assert.deepEqual(gs.targets, [good, stale, gone]);
  assert.deepEqual(gs.targetsMissing, [gone]);
  assert.deepEqual(gs.targetsUnchanged, [stale]);
  // 未声明 targets 的 lane → 空数组
  const gs2 = store.gateStatus(SID, 'b-tg-t10', 'p1');
  assert.deepEqual(gs2.targets, []);
  assert.deepEqual(gs2.targetsMissing, []);
  assert.deepEqual(gs2.targetsUnchanged, []);
});

test('O2 T11：GATE_ENABLED=false → targets 门禁零感知（缺失也 merged，无事件）', () => {
  const prev = process.env.GATE_ENABLED;
  process.env.GATE_ENABLED = 'false';
  try {
    const id = 'b-tg-t11';
    const gone = path.join(root, 'targets-gone-' + Math.random().toString(36).slice(2) + '.js'); // 不存在
    makeTargetBatch(id, [gone]);
    const r1 = set(SID, id, 'e1', 'running');
    assert.ok(!(r1 instanceof Error), String(r1 && r1.message));
    set(SID, id, 'e1', 'review');
    const r3 = set(SID, id, 'e1', 'merged');
    assert.ok(!(r3 instanceof Error), String(r3 && r3.message));
    assert.equal(r3.lanes.e1, 'merged', '逃生阀关闭时 targets 缺失也不拦截');
    assert.ok(!r3.events.some((e) => e.type === 'gate.target.passed' || e.type === 'gate.target_blocked'), '无 targets 事件');
  } finally {
    if (prev === undefined) delete process.env.GATE_ENABLED; else process.env.GATE_ENABLED = prev;
  }
});

test('O2 checkTargetsGate：无 running 事件 → laneStartedAt 回退 batch.createdAt（防御语义）', () => {
  const gates = createGates(root);
  const id = 'b-tg-fallback';
  const target = mkTarget('fb');
  setTargetMtime(target, Date.parse('2019-01-01T00:00:00.000Z')); // mtime 早于 createdAt（回退基准）→ 未变更
  // 手工构造 batch：无 member.settled running 事件 → 回退 createdAt
  const plan = buildWavePlan({ batchId: id, tasks: [
    { id: 'e1', layer: 'exec', role: 'coder', outputs: ['exec/e1/o'], cmd: 'x', targets: [target] },
    { id: 'a1', layer: 'audit', role: 'reviewer', produce: ['audit/r.md'], cmd: 'r', deps: ['e1'], standalone: true },
  ] });
  const batch = {
    schema: 3, sessionId: SID, batchId: id, phase: 'running', wavePlan: plan.wavePlan,
    lanes: { e1: 'review' }, events: [{ ts: '2020-01-01T00:00:00.000Z', type: 'batch.created' }],
    createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z',
  };
  const r = gates.checkTargetsGate(SID, id, batch, 'e1');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'GATE_TARGET_UNCHANGED'); // mtime(2019) 早于 createdAt(2020) → 回退基准生效，未变更拒
});
