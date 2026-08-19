import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/batch-store.js';
import { buildWavePlan } from '../lib/wave-plan.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-bs-'));
const store = createStore(root);
const S = 'sess-a';

const plan = buildWavePlan({
  batchId: 'b-test',
  tasks: [{ id: 't1' }, { id: 't2', deps: ['t1'] }],
});

test('createBatch persists with all lanes pending (session-scoped)', () => {
  const b = store.createBatch(S, { batchId: 'b-test', wavePlan: plan });
  assert.equal(b.phase, 'planning');
  assert.equal(b.sessionId, S);
  assert.deepEqual(b.lanes, { t1: 'pending', t2: 'pending' });
  assert.equal(store.listBatches(S).includes('b-test'), true);
  assert.throws(() => store.createBatch(S, { batchId: 'b-test', wavePlan: plan }));
});

test('setMember follows transitions and logs events', () => {
  store.setPhase(S, 'b-test', 'running');
  store.setMember(S, 'b-test', 't1', 'running');
  store.setMember(S, 'b-test', 't1', 'review');
  store.setMember(S, 'b-test', 't1', 'merged');
  const b = store.readBatch(S, 'b-test');
  assert.equal(b.lanes.t1, 'merged');
  const settled = b.events.filter((e) => e.type === 'member.settled');
  assert.equal(settled.length, 3);
  assert.deepEqual(settled[0], { ts: settled[0].ts, type: 'member.settled', lane: 't1', from: 'pending', to: 'running', note: null });
  assert.throws(() => store.setMember(S, 'b-test', 't1', 'running')); // 终态不可回退
});

test('batchSettled only when all lanes terminal', () => {
  store.setMember(S, 'b-test', 't2', 'running');
  assert.equal(store.batchSettled(store.readBatch(S, 'b-test')), false);
  store.setMember(S, 'b-test', 't2', 'review');
  store.setMember(S, 'b-test', 't2', 'merged');
  assert.equal(store.batchSettled(store.readBatch(S, 'b-test')), true);
  store.setPhase(S, 'b-test', 'complete');
});

test('terminal batch rejects further writes', () => {
  const p = buildWavePlan({ batchId: 'b-term', tasks: [{ id: 'a' }] });
  store.createBatch(S, { batchId: 'b-term', wavePlan: p, phase: 'running' });
  store.setMember(S, 'b-term', 'a', 'running');
  store.setMember(S, 'b-term', 'a', 'review');
  store.setMember(S, 'b-term', 'a', 'merged');
  store.setPhase(S, 'b-term', 'complete');
  assert.throws(() => store.setMember(S, 'b-term', 'a', 'running'));
  assert.throws(() => store.setPhase(S, 'b-term', 'paused'));
});

test('recoverBatches resets in-flight lanes to idle with system.recovered', () => {
  const p2 = buildWavePlan({ batchId: 'b-crash', tasks: [{ id: 'a' }, { id: 'b' }] });
  store.createBatch(S, { batchId: 'b-crash', wavePlan: p2, phase: 'running' });
  store.setMember(S, 'b-crash', 'a', 'running');
  store.setMember(S, 'b-crash', 'b', 'running');
  store.setMember(S, 'b-crash', 'b', 'review');
  const recovered = store.recoverBatches();
  assert.ok(recovered.includes(S + '/b-crash'));
  const b = store.readBatch(S, 'b-crash');
  assert.equal(b.lanes.a, 'idle');
  assert.equal(b.lanes.b, 'idle');
  assert.ok(b.events.some((e) => e.type === 'system.recovered'));
});

test('state file is valid JSON on disk (atomic write)', () => {
  const raw = fs.readFileSync(store.batchFile(S, 'b-test'), 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw));
});

test('claimAsset copies source into batch artifacts and logs asset.claimed', () => {
  const p = buildWavePlan({ batchId: 'b-asset', tasks: [{ id: 'x' }] });
  store.createBatch(S, { batchId: 'b-asset', wavePlan: p, phase: 'running' });
  const src = path.join(root, 'claimed-src.txt');
  fs.writeFileSync(src, 'content-123');
  const r = store.claimAsset(S, 'b-asset', { source: src, target: 'explore/findings.txt' });
  assert.equal(r.ok, true);
  assert.equal(r.claimedPath, 'explore/findings.txt');
  assert.equal(r.batchId, 'b-asset');
  const dest = path.join(root, 'sessions', S, 'artifacts', 'b-asset', 'explore', 'findings.txt');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'content-123'); // 复制正确
  assert.equal(fs.readFileSync(src, 'utf8'), 'content-123'); // 源保留（不移动）
  const b = store.readBatch(S, 'b-asset');
  const ev = b.events.find((e) => e.type === 'asset.claimed');
  assert.ok(ev, 'asset.claimed event missing');
  assert.equal(ev.source, src);
  assert.equal(ev.target, 'explore/findings.txt');
});

test('claimAsset rejects path escape and bad inputs', () => {
  const src = path.join(root, 'ok-src.txt');
  fs.writeFileSync(src, 'x');
  // 防逃逸：.. / 绝对路径
  assert.throws(() => store.claimAsset(S, 'b-asset', { source: src, target: '../evil.txt' }));
  assert.throws(() => store.claimAsset(S, 'b-asset', { source: src, target: 'a/../../evil.txt' }));
  assert.throws(() => store.claimAsset(S, 'b-asset', { source: src, target: 'C:\\abs.txt' }));
  assert.throws(() => store.claimAsset(S, 'b-asset', { source: src, target: '/abs.txt' }));
  assert.throws(() => store.claimAsset(S, 'b-asset', { source: src, target: 'C:x.txt' })); // 盘符前缀
  assert.throws(() => store.claimAsset(S, 'b-asset', { source: src, target: 'a/./b.txt' })); // . 段
  assert.throws(() => store.claimAsset(S, 'b-asset', { source: src, target: 'a\\..\\b.txt' })); // 反斜杠 ..
  // 源缺失 / 源是目录 / 批次不存在
  assert.throws(() => store.claimAsset(S, 'b-asset', { source: path.join(root, 'missing.txt'), target: 'a.txt' }));
  assert.throws(() => store.claimAsset(S, 'b-asset', { source: path.join(root), target: 'a.txt' }));
  assert.throws(() => store.claimAsset(S, 'b-nope', { source: src, target: 'a.txt' }));
  // 逃逸未写入
  assert.equal(fs.existsSync(path.join(root, 'sessions', S, 'artifacts', 'b-asset', '..', 'evil.txt')), false);
});

test('sessions are isolated: same batchId in different sessions coexist', () => {
  const pA = buildWavePlan({ batchId: 'b-iso', tasks: [{ id: 'x' }] });
  const pB = buildWavePlan({ batchId: 'b-iso', tasks: [{ id: 'x' }] });
  const a = store.createBatch('sess-a', { batchId: 'b-iso', wavePlan: pA, phase: 'running' });
  const b = store.createBatch('sess-b', { batchId: 'b-iso', wavePlan: pB, phase: 'running' });
  assert.equal(a.sessionId, 'sess-a');
  assert.equal(b.sessionId, 'sess-b');
  store.setMember('sess-a', 'b-iso', 'x', 'running');
  store.setMember('sess-a', 'b-iso', 'x', 'review');
  store.setMember('sess-a', 'b-iso', 'x', 'merged');
  // sess-b 不受影响
  assert.equal(store.readBatch('sess-b', 'b-iso').lanes.x, 'pending');
  assert.deepEqual(store.listSessions().filter((s) => s === 'sess-a' || s === 'sess-b').sort(), ['sess-a', 'sess-b']);
  // 不存在于其他 session
  assert.equal(store.listBatches('sess-zzz').includes('b-iso'), false);
});

test('migrateLegacy moves root/batches to sessions/legacy', () => {
  const r2 = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-legacy-'));
  fs.mkdirSync(path.join(r2, 'batches'), { recursive: true });
  fs.writeFileSync(path.join(r2, 'batches', 'b-old.json'), JSON.stringify({ batchId: 'b-old' }));
  const s2 = createStore(r2);
  assert.equal(s2.migrateLegacy(), 1);
  assert.equal(fs.existsSync(path.join(r2, 'batches')), false);
  assert.ok(s2.listBatches('legacy').includes('b-old'));
  assert.equal(s2.migrateLegacy(), 0); // 幂等
});

test('invalid sessionId rejected', () => {
  assert.throws(() => store.createBatch('../evil', { batchId: 'x', wavePlan: buildWavePlan({ batchId: 'x', tasks: [{ id: 'a' }] }) }));
});