import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/batch-store.js';
import { buildWavePlan } from '../lib/wave-plan.js';

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
