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
const specOk = '# Spec\n## 验收标准\n- done\n## 约束\n- none\n';

function makePlan(batchId, tasks, opts = {}) {
  const plan = buildWavePlan({ batchId, tasks, team: 'jiufeng', ...opts });
  store.createBatch(SID, { batchId, wavePlan: plan, concurrency: plan.concurrency });
  return plan;
}
function art(batchId, rel, content) {
  const abs = path.join(root, 'sessions', SID, 'artifacts', batchId, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content ?? (rel.endsWith('spec.md') ? specOk : (rel.endsWith('.json') ? '{"tasks":[]}' : 'code')));
  return abs;
}
function tasks3() {
  return [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md', 'plan/task-tree.json'], cmd: 'spec' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md', 'plan/task-tree.json'], outputs: ['exec/e1/main.py'], cmd: 'code', deps: ['p1'] },
    { id: 'a1', layer: 'audit', role: 'reviewer', produce: ['audit/review.md', 'audit/gap-list.json'], cmd: 'review', deps: ['e1'] },
  ];
}
// 状态机流转：running → review → merged；捕获 Error 返回
function set(session, batchId, lane, to, note) {
  try { return store.setMember(session, batchId, lane, to, note); }
  catch (e) { return e; }
}
function runLane(batchId, lane) {
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

test('Entry Gate：consume 齐备 → 派发通过', () => {
  makePlan('b-entry2', tasks3());
  art('b-entry2', 'plan/spec.md');
  art('b-entry2', 'plan/task-tree.json');
  const r = set(SID, 'b-entry2', 'e1', 'running');
  assert.ok(!(r instanceof Error), String(r.message));
  assert.equal(r.lanes.e1, 'running');
});

test('Entry Gate：目录型 consume 通过（Bug1：Windows 目录 size 恒 0 不再误判缺失）', () => {
  makePlan('b-dir-entry', [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md', 'exec/repos/'], outputs: ['exec/e1/main.py'], cmd: 'code', deps: ['p1'] },
    { id: 'a1', layer: 'audit', role: 'reviewer', produce: ['audit/review.md'], cmd: 'review', deps: ['e1'] },
  ]);
  art('b-dir-entry', 'plan/spec.md');
  fs.mkdirSync(path.join(root, 'sessions', SID, 'artifacts', 'b-dir-entry', 'exec', 'repos'), { recursive: true });
  const r = set(SID, 'b-dir-entry', 'e1', 'running');
  assert.ok(!(r instanceof Error), String(r.message));
  assert.equal(r.lanes.e1, 'running');
});

test('Entry Gate：空文件（size 0 真实文件）consume 仍拒（回归既有语义）', () => {
  makePlan('b-empty-entry', [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md', 'plan/empty.json'], cmd: 'spec' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md', 'plan/empty.json'], outputs: ['exec/e1/main.py'], cmd: 'code', deps: ['p1'] },
    { id: 'a1', layer: 'audit', role: 'reviewer', produce: ['audit/review.md'], cmd: 'review', deps: ['e1'] },
  ]);
  art('b-empty-entry', 'plan/spec.md');
  art('b-empty-entry', 'plan/empty.json', ''); // 真实 size 0 文件
  const r = set(SID, 'b-empty-entry', 'e1', 'running');
  assert.ok(r instanceof Error && /GATE_ENTRY_MISSING/.test(r.message), String(r.message));
  assert.equal(store.readBatch(SID, 'b-empty-entry').lanes.e1, 'pending');
});

test('Exit Gate：目录型 outputs 通过 merged（Bug1 修复覆盖 exit gate 同函数）', () => {
  makePlan('b-dir-exit', [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1/data/'], cmd: 'code', deps: ['p1'] },
    { id: 'a1', layer: 'audit', role: 'reviewer', produce: ['audit/review.md'], cmd: 'review', deps: ['e1'] },
  ]);
  art('b-dir-exit', 'plan/spec.md');
  runLane('b-dir-exit', 'p1');
  fs.mkdirSync(path.join(root, 'sessions', SID, 'artifacts', 'b-dir-exit', 'exec', 'e1', 'data'), { recursive: true });
  const r = runLane('b-dir-exit', 'e1');
  assert.ok(!(r instanceof Error), String(r.message));
  assert.equal(r.lanes.e1, 'merged');
});

test('L0：plan merged 前 spec 缺必填章节 → 拒绝', () => {
  makePlan('b-l0', tasks3());
  art('b-l0', 'plan/spec.md', '# spec without sections');
  art('b-l0', 'plan/task-tree.json');
  const r = runLane('b-l0', 'p1');
  assert.ok(r instanceof Error && /GATE_PLAN_CONTRACT/.test(r.message), String(r.message));
});

test('L0：spec 齐备 + task-tree 合法 JSON → plan merged 通过', () => {
  makePlan('b-l0b', tasks3());
  art('b-l0b', 'plan/spec.md');
  art('b-l0b', 'plan/task-tree.json');
  const r = runLane('b-l0b', 'p1');
  assert.ok(!(r instanceof Error), String(r.message));
  assert.equal(r.lanes.p1, 'merged');
});

test('Exit Gate exec：merged 前 outputs 缺失 → 拒绝', () => {
  makePlan('b-ex', tasks3());
  art('b-ex', 'plan/spec.md'); art('b-ex', 'plan/task-tree.json');
  runLane('b-ex', 'p1');
  runLane('b-ex', 'e1'); // e1 未写 outputs → merged 被拒
  assert.equal(store.readBatch(SID, 'b-ex').lanes.e1, 'review');
});

test('Exit Gate audit：merged 前 produce 缺失 → 拒绝；写产物后通过（gate.passed 事件）', () => {
  makePlan('b-au', tasks3());
  art('b-au', 'plan/spec.md'); art('b-au', 'plan/task-tree.json');
  runLane('b-au', 'p1');
  art('b-au', 'exec/e1/main.py');
  runLane('b-au', 'e1');
  const r = runLane('b-au', 'a1'); // audit produce 未写
  assert.ok(r instanceof Error && /GATE_EXIT_MISSING_AUDIT/.test(r.message), String(r.message));
  art('b-au', 'audit/review.md');
  art('b-au', 'audit/gap-list.json');
  const ok = runLane('b-au', 'a1');
  assert.ok(!(ok instanceof Error), String(ok.message));
  assert.ok(ok.events.some((e) => e.type === 'gate.passed' && e.lane === 'a1'));
});

test('Complete Gate：audit 未完成 → 拒绝；audit 完成后通过', () => {
  makePlan('b-c', tasks3());
  art('b-c', 'plan/spec.md'); art('b-c', 'plan/task-tree.json');
  runLane('b-c', 'p1');
  art('b-c', 'exec/e1/main.py');
  runLane('b-c', 'e1');
  store.setPhase(SID, 'b-c', 'running');
  let r1;
  try { store.setPhase(SID, 'b-c', 'complete'); r1 = null; } catch (e) { r1 = e; }
  assert.ok(r1 instanceof Error && /GATE_EXIT_PENDING_AUDIT/.test(r1.message), String(r1.message));
  art('b-c', 'audit/review.md'); art('b-c', 'audit/gap-list.json');
  runLane('b-c', 'a1');
  const r2 = store.setPhase(SID, 'b-c', 'complete');
  assert.ok(!(r2 instanceof Error), String(r2.message));
  assert.equal(r2.phase, 'complete');
});

test('generic（无 layer）：不触发门禁（向后兼容）', () => {
  const plan = buildWavePlan({ batchId: 'b-gen', tasks: [{ id: 't1', cmd: 'x' }] });
  store.createBatch(SID, { batchId: 'b-gen', wavePlan: plan });
  const r1 = set(SID, 'b-gen', 't1', 'running');
  assert.ok(!(r1 instanceof Error));
  const r2 = set(SID, 'b-gen', 't1', 'review');
  assert.ok(!(r2 instanceof Error));
  const r3 = set(SID, 'b-gen', 't1', 'merged');
  assert.ok(!(r3 instanceof Error));
  store.setPhase(SID, 'b-gen', 'running');
  assert.equal(store.setPhase(SID, 'b-gen', 'complete').phase, 'complete');
});

// ---- P1-6 needHuman（D14 复用 review 态挂起；不新增成员态）----
const NEEDHUMAN_TASKS = [
  { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
  { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1/main.py'], cmd: 'code', deps: ['p1'] },
  { id: 'a1', layer: 'audit', role: 'reviewer', produce: ['audit/acceptance.md'], cmd: 'review', deps: ['e1'] },
];
// 三层批次跑完 plan/exec，audit 产物按需写入并派发 a1→running 后返回 batchId
function setupNeedHuman(batchId, acceptance = '# 验收\nneedHuman: true\n') {
  makePlan(batchId, NEEDHUMAN_TASKS);
  art(batchId, 'plan/spec.md');
  runLane(batchId, 'p1');
  art(batchId, 'exec/e1/main.py');
  runLane(batchId, 'e1');
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
  const r = set(SID, id, 'a1', 'conflict');
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
  runLane('b-nh6', 'p1');
  art('b-nh6', 'exec/e1/main.py');
  runLane('b-nh6', 'e1');
  art('b-nh6', 'audit/review.md'); art('b-nh6', 'audit/gap-list.json');
  const r = runLane('b-nh6', 'a1'); // merged 无 note
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
const CMD_TASKS = [
  { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
  { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/test-report.md'], cmd: 'code', deps: ['p1'] },
  { id: 'a1', layer: 'audit', role: 'reviewer', produce: ['audit/acceptance.md'], cmd: 'review', deps: ['e1'] },
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
  runLane('b-cg-ok', 'p1');
  art('b-cg-ok', 'exec/test-report.md', '# 验证\n- ok\ngate: node -e "process.exit(0)"\n');
  const r = runLane('b-cg-ok', 'e1');
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
  runLane('b-cg-nz', 'p1');
  art('b-cg-nz', 'exec/test-report.md', '# 验证\ngate: node -e "process.exit(3)"\n');
  const r = runLane('b-cg-nz', 'e1');
  assert.ok(r instanceof Error && /GATE_EXIT_NONZERO/.test(r.message), String(r && r.message));
  const b = store.readBatch(SID, 'b-cg-nz');
  assert.equal(b.lanes.e1, 'review'); // 失败 lane 留 review（非终态，C4）
  const ev = b.events.find((e) => e.type === 'gate.exit_blocked');
  assert.ok(ev && ev.code === 'GATE_EXIT_NONZERO' && ev.exitCode === 3, JSON.stringify(ev));
});

test('命令 gate G7：黑名单命令 → GATE_EXIT_FORBIDDEN（拒绝执行，gate.exit_blocked 留痕）', () => {
  makePlan('b-cg-fb', CMD_TASKS);
  art('b-cg-fb', 'plan/spec.md');
  runLane('b-cg-fb', 'p1');
  art('b-cg-fb', 'exec/test-report.md', '# 验证\ngate: rm -rf /tmp/xxx\n');
  const r = runLane('b-cg-fb', 'e1');
  assert.ok(r instanceof Error && /GATE_EXIT_FORBIDDEN/.test(r.message), String(r && r.message));
  const ev = store.readBatch(SID, 'b-cg-fb').events.find((e) => e.type === 'gate.exit_blocked');
  assert.ok(ev && ev.code === 'GATE_EXIT_FORBIDDEN', JSON.stringify(ev));
});

test('命令 gate G9：失败 + needHuman 声明 → 转人工闸：无 human 证据拒 GATE_NEEDHUMAN_PENDING；有证据 merged', () => {
  makePlan('b-cg-nh', CMD_TASKS);
  art('b-cg-nh', 'plan/spec.md');
  runLane('b-cg-nh', 'p1');
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
  runLane('b-cg-z', 'p1');
  art('b-cg-z', 'exec/test-report.md', '# 验证\n- 无 gate 声明\n');
  const r = runLane('b-cg-z', 'e1');
  assert.ok(!(r instanceof Error), String(r && r.message));
  assert.equal(r.lanes.e1, 'merged');
  assert.ok(!r.events.some((e) => e.type === 'gate.exit' || e.type === 'gate.exit_blocked'), 'expect zero gate events');
});

// ---- Tester 全量补充：V3 多行集成 / V5 集成超时 / V9 非 exec 零感知 / V10 事件零泄漏 / V11 cwd 契约 / C5 逃生阀 ----

test('命令 gate V3：多行 gate 全部 exit 0 → merged + gate.exit 事件含全部 commands/results（保序）', () => {
  makePlan('b-cg-v3-ok', CMD_TASKS);
  art('b-cg-v3-ok', 'plan/spec.md');
  runLane('b-cg-v3-ok', 'p1');
  art('b-cg-v3-ok', 'exec/test-report.md', '# 验证\n- ok\ngate: node -e "process.exit(0)"\ngate: node -e "process.exit(0)"\n');
  const r = runLane('b-cg-v3-ok', 'e1');
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
  runLane('b-cg-v3-short', 'p1');
  // 第 2 条命令写标记文件：若被短路执行会留痕
  const marker = path.join(root, 'sessions', SID, 'artifacts', 'b-cg-v3-short', 'marker.txt');
  const cmd2 = 'node -e "require(\'fs\').writeFileSync(\'' + marker.replace(/\\/g, '/') + '\',\'x\')"';
  art('b-cg-v3-short', 'exec/test-report.md', '# 验证\ngate: node -e "process.exit(1)"\ngate: ' + cmd2 + '\n');
  const r = runLane('b-cg-v3-short', 'e1');
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
    runLane('b-cg-v5-t', 'p1');
    // node 长 sleep（默认 GATE_RETRY=1 → 最多 2 次执行，每次 400ms 超时）
    art('b-cg-v5-t', 'exec/test-report.md', '# 验证\ngate: node -e "setTimeout(()=>{}, 10000)"\n');
    const t0 = Date.now();
    const r = runLane('b-cg-v5-t', 'e1');
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

test('命令 gate V9：非 exec 层（plan/audit）产物含 gate 行 → 零感知不执行（D-005）', () => {
  makePlan('b-cg-v9-plan', CMD_TASKS);
  art('b-cg-v9-plan', 'plan/spec.md', '# Spec\n## 验收标准\n- x\ngate: node -e "process.exit(1)"\n## 约束\n- y\n');
  const r1 = runLane('b-cg-v9-plan', 'p1'); // plan lane 产物含 gate 行但为 plan 层
  assert.ok(!(r1 instanceof Error), String(r1 && r1.message));
  assert.equal(r1.lanes.p1, 'merged');
  assert.ok(!r1.events.some((e) => e.type === 'gate.exit' || e.type === 'gate.exit_blocked'), 'plan 层零感知');
  // audit lane：produce 含 gate 行
  makePlan('b-cg-v9-audit', CMD_TASKS);
  art('b-cg-v9-audit', 'plan/spec.md');
  runLane('b-cg-v9-audit', 'p1');
  art('b-cg-v9-audit', 'exec/test-report.md', '# 验证\n- ok\n');
  runLane('b-cg-v9-audit', 'e1');
  art('b-cg-v9-audit', 'audit/acceptance.md', '# 验收\ngate: node -e "process.exit(1)"\n- ok\n');
  const r2 = runLane('b-cg-v9-audit', 'a1');
  assert.ok(!(r2 instanceof Error), String(r2 && r2.message));
  assert.equal(r2.lanes.a1, 'merged');
  assert.ok(!r2.events.some((e) => e.type === 'gate.exit' || e.type === 'gate.exit_blocked'), 'audit 层零感知');
});

test('命令 gate V10：env 注入可用 + 事件零凭据泄漏（gate.exit 事件不含 env 值）', () => {
  const secret = 'PUNKY_TEST_SECRET_9f8e7d';
  makePlan('b-cg-v10-env', CMD_TASKS);
  art('b-cg-v10-env', 'plan/spec.md');
  runLane('b-cg-v10-env', 'p1');
  // 命令从 env 读凭据并输出（命令成功执行 = env 注入可用；事件载荷不含 output/凭据值）
  art('b-cg-v10-env', 'exec/test-report.md', '# 验证\ngate: node -e "console.log(process.env.A || \'none\')"\n');
  const prev = process.env.A;
  process.env.A = secret;
  try {
    const r = runLane('b-cg-v10-env', 'e1');
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
  runLane('b-cg-v11-cwd', 'p1');
  const marker1 = path.join(root, 'sessions', SID, 'artifacts', 'b-cg-v11-cwd', 'cwd1.txt');
  art('b-cg-v11-cwd', 'exec/test-report.md', '# 验证\ngate: node -e "require(\'fs\').writeFileSync(\'' + marker1.replace(/\\/g, '/') + '\', process.cwd())"\n');
  const r1 = runLane('b-cg-v11-cwd', 'e1');
  assert.ok(!(r1 instanceof Error), String(r1 && r1.message));
  const want1 = path.join(root, 'sessions', SID, 'artifacts', 'b-cg-v11-cwd');
  assert.equal(fs.readFileSync(marker1, 'utf8').trim().replace(/\\/g, '/'), want1.replace(/\\/g, '/'), '默认 cwd = artifacts 兜底');
  // 子用例 2：GATE_REPO_ROOT env 生效（无 worktree 时优先 repo 根配置）
  makePlan('b-cg-v11-repo', CMD_TASKS);
  art('b-cg-v11-repo', 'plan/spec.md');
  runLane('b-cg-v11-repo', 'p1');
  const marker2 = path.join(root, 'sessions', SID, 'artifacts', 'b-cg-v11-repo', 'cwd2.txt');
  const prevRoot = process.env.GATE_REPO_ROOT;
  process.env.GATE_REPO_ROOT = root + '-repo-root';
  fs.mkdirSync(process.env.GATE_REPO_ROOT, { recursive: true }); // 目录须真实存在（commandCwd 校验后生效）
  try {
    art('b-cg-v11-repo', 'exec/test-report.md', '# 验证\ngate: node -e "require(\'fs\').writeFileSync(\'' + marker2.replace(/\\/g, '/') + '\', process.cwd())"\n');
    const r2 = runLane('b-cg-v11-repo', 'e1');
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
    runLane('b-cg-v9-off', 'p1');
    art('b-cg-v9-off', 'exec/test-report.md', '# 验证\ngate: node -e "process.exit(1)"\n');
    const r = runLane('b-cg-v9-off', 'e1');
    assert.ok(!(r instanceof Error), String(r && r.message));
    assert.equal(r.lanes.e1, 'merged', '逃生阀关闭时 gate 失败命令也不拦截');
    assert.ok(!r.events.some((e) => e.type === 'gate.exit' || e.type === 'gate.exit_blocked'), '无 gate 事件');
  } finally {
    if (prev === undefined) delete process.env.GATE_ENABLED; else process.env.GATE_ENABLED = prev;
  }
});

// ---- O2 targets 门禁（C2/C3/C4，冒烟口径 T1-T11，全量回归归 Tester）----
// 三层批次 + e1 声明 targets（绝对路径）；target 文件写于引擎产物根之外（批次外临时文件，模拟既有源码/配置）
function makeTargetBatch(batchId, targets, opts = {}) {
  makePlan(batchId, [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1/main.py'], cmd: 'code', deps: ['p1'], targets, targetsMarker: opts.targetsMarker ?? null },
    { id: 'a1', layer: 'audit', role: 'reviewer', produce: ['audit/review.md'], cmd: 'review', deps: ['e1'] },
  ]);
  art(batchId, 'plan/spec.md');
  runLane(batchId, 'p1');
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
  runLane(id, 'p1');
  art(id, 'exec/e1/main.py');
  const r = runLane(id, 'e1');
  assert.ok(!(r instanceof Error), String(r && r.message));
  assert.equal(r.lanes.e1, 'merged');
  assert.ok(!r.events.some((e) => e.type === 'gate.target.passed' || e.type === 'gate.target_blocked'), '无 targets 事件（零感知）');
});

test('O2 T5：非 exec 层（plan/audit）声明 targets → 零感知', () => {
  const id = 'b-tg-t5';
  makePlan(id, [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec', targets: ['D:\\fake\\plan-target.js'] },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1/main.py'], cmd: 'code', deps: ['p1'] },
    { id: 'a1', layer: 'audit', role: 'reviewer', produce: ['audit/review.md'], cmd: 'review', deps: ['e1'], targets: ['D:\\fake\\audit-target.js'] },
  ]);
  art(id, 'plan/spec.md');
  const r1 = runLane(id, 'p1'); // plan 层声明 targets（不存在的假路径也不拦）
  assert.ok(!(r1 instanceof Error), String(r1 && r1.message));
  assert.equal(r1.lanes.p1, 'merged');
  assert.ok(!r1.events.some((e) => e.type === 'gate.target.passed' || e.type === 'gate.target_blocked'), 'plan 层零感知');
  art(id, 'exec/e1/main.py');
  runLane(id, 'e1');
  art(id, 'audit/review.md');
  const r3 = runLane(id, 'a1'); // audit 层声明 targets → 零感知
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

test('O2 T8：返工（review→running）重置基准——新 mtime 基准生效', () => {
  const id = 'b-tg-t8';
  const target = mkTarget('t8');
  makeTargetBatch(id, [target]);
  // 首次 running（t0）→ target mtime 设于 t0 之后
  const r1 = set(SID, id, 'e1', 'running');
  assert.ok(!(r1 instanceof Error), String(r1 && r1.message));
  setTargetMtime(target, Date.now() + 1000);
  set(SID, id, 'e1', 'review');
  // 打回返工：review→running（push 新的 running 结算事件，基准重置为更晚时刻 t1）
  const reworkAt = Date.now();
  const rw = set(SID, id, 'e1', 'running');
  assert.ok(!(rw instanceof Error), String(rw && rw.message));
  const t1 = rw.events.filter((e) => e.type === 'member.settled' && e.lane === 'e1' && e.to === 'running').pop().ts;
  // target mtime 设于首次 running 之后、返工 running 之前 → 返工后新基准下应拒（GATE_TARGET_UNCHANGED）
  setTargetMtime(target, reworkAt - 500);
  assert.ok(new Date(target ? fs.statSync(target).mtime : 0).getTime() < Date.parse(t1), '前置：mtime 早于返工 running');
  set(SID, id, 'e1', 'review');
  const r4 = set(SID, id, 'e1', 'merged');
  assert.ok(r4 instanceof Error && /GATE_TARGET_UNCHANGED/.test(r4.message), '返工后旧 mtime 不再满足新基准: ' + String(r4 && r4.message));
  // 更新 target（mtime 晚于返工 running）→ merged 通过
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
    { id: 'a1', layer: 'audit', role: 'reviewer', produce: ['audit/r.md'], cmd: 'r', deps: ['e1'] },
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
