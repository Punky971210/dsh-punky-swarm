import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../lib/tools.js';
import { createStore } from '../lib/batch-store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-tools-'));
const store = createStore(root);
const registered = [];
const ctx = { tools: { register: (t) => registered.push(t) }, logger: console };
const { tools } = createTools(ctx, { store, root });
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

const EXEC_SESS = { agent: { session: { id: 'sess-leader' } } };

test('all 13 tools registered', () => {
  assert.equal(tools.length, 13);
  for (const n of ['wave_plan', 'batch_phase', 'batch_status', 'assign_check', 'gate_status', 'artifact_types', 'lane_claim', 'lane_release', 'member_status', 'member_settle', 'mailbox_send', 'mailbox_read', 'mailbox_ack']) {
    assert.ok(byName[n], 'missing tool ' + n);
  }
});

test('full flow binds to exec session; args.session overrides', async () => {
  const w = await byName.wave_plan.execute({
    batchId: 'b-demo',
    tasks: [
      { id: 't1', cmd: 'analyze' },
      { id: 't2', cmd: 'build', deps: ['t1'] },
    ],
    concurrency: 3,
  }, EXEC_SESS);
  assert.equal(w.wavePlan.length, 2);
  assert.equal(w.sessionId, 'sess-leader');
  assert.deepEqual(w.lanes, { t1: 'pending', t2: 'pending' });

  assert.deepEqual((await byName.batch_phase.execute({ batchId: 'b-demo', phase: 'running' }, EXEC_SESS)).phase, 'running');

  const claim = await byName.lane_claim.execute({ batchId: 'b-demo', lane: 't1' }, EXEC_SESS);
  assert.equal(claim.ok, true);
  const conflict = await byName.lane_claim.execute({ batchId: 'b-demo', lane: 't1' }, EXEC_SESS);
  assert.equal(conflict.ok, false);
  assert.equal((await byName.lane_release.execute({ batchId: 'b-demo', lane: 't1', token: claim.token }, EXEC_SESS)).ok, true);

  await byName.member_status.execute({ batchId: 'b-demo', lane: 't1', status: 'running' }, EXEC_SESS);
  await byName.member_status.execute({ batchId: 'b-demo', lane: 't1', status: 'review' }, EXEC_SESS);
  await byName.member_settle.execute({ batchId: 'b-demo', lane: 't1', status: 'merged', note: 'ok' }, EXEC_SESS);
  await byName.member_settle.execute({ batchId: 'b-demo', lane: 't2', status: 'skipped' }, EXEC_SESS);

  const s = await byName.batch_status.execute({ batchId: 'b-demo' }, EXEC_SESS);
  assert.equal(s.lanes.t1, 'merged');
  assert.equal(s.settled, true);
  assert.ok(s.recentEvents.some((e) => e.type === 'member.settled'));

  const sent = await byName.mailbox_send.execute({ batchId: 'b-demo', box: 'inbox', message: { task: 't2' } }, EXEC_SESS);
  const read = await byName.mailbox_read.execute({ batchId: 'b-demo', box: 'inbox' }, EXEC_SESS);
  assert.equal(read.items.length, 1);
  await byName.mailbox_ack.execute({ batchId: 'b-demo', box: 'inbox', ackId: sent.ackId }, EXEC_SESS);
  assert.equal((await byName.mailbox_read.execute({ batchId: 'b-demo', box: 'inbox' }, EXEC_SESS)).items.length, 0);

  // 跨 session 不可见：同 batchId 在别的 session 不存在（batch_status 抛错）
  await assert.rejects(() => byName.batch_status.execute({ batchId: 'b-demo', session: 'sess-worker' }, EXEC_SESS));
  // args.session 显式覆盖 exec 会话：查 Leader session 仍可见
  const viaArg = await byName.batch_status.execute({ batchId: 'b-demo', session: 'sess-leader' }, { agent: { session: { id: 'sess-worker' } } });
  assert.equal(viaArg.lanes.t1, 'merged');
});

test('wave_plan rejects duplicate batch and bad deps', async () => {
  await assert.rejects(() => byName.wave_plan.execute({ batchId: 'b-demo', tasks: [{ id: 'x' }] }, EXEC_SESS));
  await assert.rejects(() => byName.wave_plan.execute({ batchId: 'b-x', tasks: [{ id: 'a', deps: ['nope'] }] }, EXEC_SESS));
});

test('member_settle enforces state machine', async () => {
  const w = await byName.wave_plan.execute({ batchId: 'b-sm', tasks: [{ id: 'a' }] }, EXEC_SESS);
  await byName.batch_phase.execute({ batchId: 'b-sm', phase: 'running' }, EXEC_SESS);
  await assert.rejects(() => byName.member_settle.execute({ batchId: 'b-sm', lane: 'a', status: 'merged' }, EXEC_SESS));
});

test('batch_status lists all batches without batchId (per session)', async () => {
  const r = await byName.batch_status.execute({}, EXEC_SESS);
  assert.ok(r.batches.length >= 2);
  assert.equal(r.sessionId, 'sess-leader');
});

test('cli fallback when exec has no agent', async () => {
  const w = await byName.wave_plan.execute({ batchId: 'b-cli', tasks: [{ id: 'a' }] });
  assert.equal(w.sessionId, 'cli');
});

test('assign_check：C 判定（任一强制条件）与 A/B 判定', async () => {
  const c = await byName.assign_check.execute({ parallel: true });
  assert.equal(c.form, 'C'); assert.equal(c.allowed, false);
  assert.ok(c.reasons.length > 0);
  const c2 = await byName.assign_check.execute({ gate: true });
  assert.equal(c2.form, 'C');
  const a = await byName.assign_check.execute({});
  assert.equal(a.form, 'A'); assert.equal(a.allowed, true);
  const b = await byName.assign_check.execute({ needIsolation: true });
  assert.equal(b.form, 'B'); assert.equal(b.allowed, true);
});

test('artifact_types：注册表只读，含三层目录约定', async () => {
  const r = await byName.artifact_types.execute({});
  const types = r.types.map((t) => t.type);
  for (const need of ['plan', 'spec', 'taskTree', 'code', 'testReport', 'review', 'gapList', 'acceptance', 'retrospective']) {
    assert.ok(types.includes(need), 'missing type ' + need);
  }
  const retro = r.types.find((t) => t.type === 'retrospective');
  assert.equal(retro.dir, 'audit/');
});

test('gate_status：三层批次缺失清单 + generic 无门禁', async () => {
  const w = await byName.wave_plan.execute({
    batchId: 'b-gate', team: 'jiufeng',
    tasks: [
      { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 's' },
      { id: 'e1', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e1/a.py'], cmd: 'c', deps: ['p1'] },
      { id: 'a1', layer: 'audit', produce: ['audit/review.md'], cmd: 'r', deps: ['e1'] },
    ],
  }, EXEC_SESS);
  assert.ok(w.lanes.p1 === 'pending');
  const g = await byName.gate_status.execute({ batchId: 'b-gate' }, EXEC_SESS);
  const byId = Object.fromEntries(g.lanes.map((x) => [x.lane, x]));
  assert.equal(byId.e1.consumeMissing.length, 1); // plan/spec.md 缺失
  assert.equal(byId.e1.outputsMissing.length, 1);
  assert.equal(byId.a1.produceMissing.length, 1);
  assert.equal(byId.p1.layer, 'plan');
});