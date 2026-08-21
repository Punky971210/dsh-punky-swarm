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
import { detectNeedHuman } from '../lib/state/gates.js';

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
