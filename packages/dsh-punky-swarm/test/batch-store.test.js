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
import { SPEC_OK, threeTierTasks, seedArtifacts, runLane } from './helpers/gate-fixture.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-bs-'));
const store = createStore(root);
const S = 'sess-a';

// 【r2 同步 · B2/B3/A1/B1】旧 fixture 为「lane 无 layer 的双 lane 批」：新语义下无 `layer` 的 lane 不得
//   整 lane 免检（结算被 exit 门拒 `GATE_LANE_LAYER_MISSING`）、批次须含 exec/audit 层方得 complete（B3）、
//   plan 产物必须被下游 consume（A1）、exec/audit 派发前 consume 须已声明且在场（B1 + presence）。
//   修法：**保留 2 lane 形态与 id**（避免无谓改动既有断言），改按「t1 = plan / t2 = audit」的合规三层形态，
//   其中 t2 消费 t1 的产物（同时满足 A1 与 B5 的 audit 判据锚定）。
const plan = buildWavePlan({
  batchId: 'b-test',
  tasks: [
    { id: 't1', layer: 'plan', produce: ['plan/spec.md'], cmd: 'spec' },
    { id: 't2', layer: 'audit', consume: ['plan/spec.md'], produce: ['audit/t2.md'], cmd: 'review', deps: ['t1'] },
  ],
});
// 声明产物须**在派发前**在场（entry/exit 门 presence 硬约束）——plan/spec.md 供 t1 契约门 + t2 判据来源
const bTestArt = (rel, content) => {
  const abs = path.join(root, 'sessions', S, 'artifacts', 'b-test', rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};
bTestArt('plan/spec.md', SPEC_OK);
bTestArt('audit/t2.md', 'ok');

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
  // 【r2 同步 · B2/B3/A1/B1】无 layer 的单 lane 批既不能结算（exit 门拒 `GATE_LANE_LAYER_MISSING`）
  //   也不能收口（`GATE_COMPLETE_NO_TIER`）⇒ 改合规三层批 + 声明产物在场 + 全 lane 结算。
  const p = buildWavePlan({ batchId: 'b-term', tasks: threeTierTasks(['a']) });
  store.createBatch(S, { batchId: 'b-term', wavePlan: p, phase: 'running' });
  seedArtifacts(root, S, 'b-term', ['a']);
  for (const lane of ['p1', 'a', 'a1']) runLane(store, S, 'b-term', lane);
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

test('recoverBatches 清退 stale lane 锁（崩溃后重派不再被死锁挡住）', () => {
  const p3 = buildWavePlan({ batchId: 'b-lock', tasks: [{ id: 'a' }] });
  store.createBatch(S, { batchId: 'b-lock', wavePlan: p3, phase: 'running' });
  store.setMember(S, 'b-lock', 'a', 'running');
  const lock = path.join(store.sessionsDir, S, '.locks', 'b-lock.a.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ token: 'crashed-holder', ts: Date.now(), pid: 999999 }), 'utf8');
  assert.ok(fs.existsSync(lock), '前置：锁文件已存在');
  store.recoverBatches(); // 模拟进程重启：in-flight → idle
  assert.equal(fs.existsSync(lock), false, '恢复后不得残留持有者进程已不存在的锁');
  assert.equal(store.readBatch(S, 'b-lock').lanes.a, 'idle');
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
  // 【r2 同步 · B2/B3/A1/B1】无 layer 的单 lane 批已不可结算 ⇒ 改合规三层批（仅 sess-a 侧需落盘产物）
  const pA = buildWavePlan({ batchId: 'b-iso', tasks: threeTierTasks(['x']) });
  const pB = buildWavePlan({ batchId: 'b-iso', tasks: threeTierTasks(['x']) });
  const a = store.createBatch('sess-a', { batchId: 'b-iso', wavePlan: pA, phase: 'running' });
  const b = store.createBatch('sess-b', { batchId: 'b-iso', wavePlan: pB, phase: 'running' });
  assert.equal(a.sessionId, 'sess-a');
  assert.equal(b.sessionId, 'sess-b');
  seedArtifacts(root, 'sess-a', 'b-iso', ['x']);
  for (const lane of ['p1', 'x', 'a1']) runLane(store, 'sess-a', 'b-iso', lane);
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

// ---- B1 恢复审计：system.recovered.detail 详情 + 幂等 ----

test('recoverBatches detail: lastActiveAt/produced 审计详情（running→idle + review→idle）', () => {
  // 【r2 同步 · B1/B2/A1】旧 fixture 的 exec/audit lane 无 `consume`（零依赖拒派）且 plan 产物无人消费
  //   ⇒ 补 plan 层消费者与各 lane 的 consume；plan 层只声明**在场**产物（「缺失产物不列入 produced」
  //   这条判据由 exec 侧的 `exec/missing.md` 承载，`:218` 原有断言不变）。
  const p = buildWavePlan({
    batchId: 'b-rec-detail',
    tasks: [
      { id: 'z', layer: 'plan', produce: ['plan/z.md'] },
      { id: 'x', layer: 'exec', consume: ['plan/z.md'], outputs: ['exec/x.md', 'exec/missing.md'] },
      { id: 'y', layer: 'audit', consume: ['plan/z.md'], produce: ['audit/y.md'] },
    ],
  });
  store.createBatch(S, { batchId: 'b-rec-detail', wavePlan: p, phase: 'running' });
  // 已产出产物：只写契约中一部分 → produced 只列已存在且非空者
  //   （须在**派发前**落盘：entry 门 presence 硬约束要求 consume 声明项全部在场）
  const aDir = path.join(root, 'sessions', S, 'artifacts', 'b-rec-detail');
  for (const sub of ['exec', 'audit', 'plan']) fs.mkdirSync(path.join(aDir, sub), { recursive: true });
  fs.writeFileSync(path.join(aDir, 'exec', 'x.md'), 'x-out');
  fs.writeFileSync(path.join(aDir, 'audit', 'y.md'), 'y-out');
  fs.writeFileSync(path.join(aDir, 'plan', 'z.md'), SPEC_OK); // audit 判据来源须含裸标题
  store.setMember(S, 'b-rec-detail', 'x', 'running');
  store.setMember(S, 'b-rec-detail', 'y', 'running');
  store.setMember(S, 'b-rec-detail', 'y', 'review');
  store.setMember(S, 'b-rec-detail', 'z', 'running');
  store.setMember(S, 'b-rec-detail', 'z', 'review');

  const recovered = store.recoverBatches();
  assert.ok(recovered.includes(S + '/b-rec-detail'));
  const b = store.readBatch(S, 'b-rec-detail');
  assert.equal(b.lanes.x, 'idle');
  assert.equal(b.lanes.y, 'idle');
  assert.equal(b.lanes.z, 'idle');
  const ev = b.events.filter((e) => e.type === 'system.recovered').at(-1);
  assert.ok(ev, 'system.recovered event missing');
  assert.deepEqual([...ev.recoveredLanes].sort(), ['x', 'y', 'z']); // 只含本次恢复的 lane
  assert.equal(ev.detail.length, 3);
  const byLane = Object.fromEntries(ev.detail.map((d) => [d.lane, d]));
  assert.equal(byLane.x.from, 'running');
  assert.equal(byLane.y.from, 'review');
  assert.equal(byLane.z.from, 'review');
  // produced：契约中已存在且非空者（缺失产物不列入）
  assert.deepEqual(byLane.x.produced, ['exec/x.md']);
  assert.deepEqual(byLane.y.produced, ['audit/y.md']);
  assert.deepEqual(byLane.z.produced, ['plan/z.md']);
  // lastActiveAt：ISO 可解析；x 最后一次 lane 事件 = member.settled(running) 的 ts
  for (const d of ev.detail) {
    assert.equal(typeof d.lastActiveAt, 'string');
    assert.ok(Number.isFinite(Date.parse(d.lastActiveAt)), 'lastActiveAt not ISO: ' + d.lastActiveAt);
  }
  const xSettled = b.events.filter((e) => e.type === 'member.settled' && e.lane === 'x').at(-1);
  assert.equal(byLane.x.lastActiveAt, xSettled.ts);
});

test('recoverBatches detail: 无产物 lane produced=[]；无 lane 事件 lastActiveAt 回退 updatedAt', () => {
  const p = buildWavePlan({
    batchId: 'b-rec-empty',
    tasks: [{ id: 'g', layer: 'exec', outputs: ['exec/none.md'] }, { id: 'h', layer: 'audit' }],
  });
  store.createBatch(S, { batchId: 'b-rec-empty', wavePlan: p, phase: 'running' });
  // 白盒构造 crash 中间态：lane=g 已 running 但无 lane 事件（绕过 setMember，模拟恢复前状态）
  const file = store.batchFile(S, 'b-rec-empty');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.lanes.g = 'running';
  raw.events = raw.events.filter((e) => e.type === 'batch.created');
  raw.updatedAt = '2026-08-21T00:00:00.000Z';
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));

  const recovered = store.recoverBatches();
  assert.ok(recovered.includes(S + '/b-rec-empty'));
  const b = store.readBatch(S, 'b-rec-empty');
  const ev = b.events.filter((e) => e.type === 'system.recovered').at(-1);
  assert.equal(ev.detail.length, 1);
  assert.equal(ev.detail[0].lane, 'g');
  assert.equal(ev.detail[0].from, 'running');
  assert.deepEqual(ev.detail[0].produced, []); // 契约产物不存在 → 空清单
  assert.equal(ev.detail[0].lastActiveAt, '2026-08-21T00:00:00.000Z'); // 无 lane 事件 → 回退 updatedAt
});

test('recoverBatches 幂等：二次调用不重复记录 system.recovered', () => {
  const before = store.readBatch(S, 'b-rec-detail').events.filter((e) => e.type === 'system.recovered').length;
  const second = store.recoverBatches();
  assert.equal(second.includes(S + '/b-rec-detail'), false); // 已 idle，不再恢复
  assert.equal(second.includes(S + '/b-rec-empty'), false);
  const after = store.readBatch(S, 'b-rec-detail').events.filter((e) => e.type === 'system.recovered').length;
  assert.equal(after, before); // 未新增事件（幂等）
});

// ---- targets 门禁 store 接线：member_settle merged 前置（exit 后 command 前）----
function makeTargetPlan(batchId, targets) {
  const p = buildWavePlan({
    batchId,
    tasks: [
      { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
      { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1/main.py'], cmd: 'code', deps: ['p1'], targets },
      { id: 'a1', layer: 'audit', role: 'reviewer', produce: ['audit/review.md'], cmd: 'review', deps: ['e1'] },
    ],
  });
  store.createBatch(S, { batchId, wavePlan: p });
  const art = (rel, content) => {
    const abs = path.join(root, 'sessions', S, 'artifacts', batchId, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content ?? (rel.endsWith('spec.md') ? '# Spec\n## 验收标准\n- x\n## 约束\n- y\n' : 'code'));
  };
  art('plan/spec.md');
  store.setMember(S, batchId, 'p1', 'running');
  store.setMember(S, batchId, 'p1', 'review');
  store.setMember(S, batchId, 'p1', 'merged');
  art('exec/e1/main.py');
}

test('O2 C3 接线：声明 targets 缺失 → merged 前置拒 GATE_TARGET_MISSING（gate.target_blocked 事件 + lane 留 review）', () => {
  const id = 'b-tg-wire-missing';
  const gone = path.join(root, 'sessions', S, 'artifacts', id, 'target-gone.js'); // 不存在
  makeTargetPlan(id, [gone]);
  store.setMember(S, id, 'e1', 'running');
  store.setMember(S, id, 'e1', 'review');
  assert.throws(() => store.setMember(S, id, 'e1', 'merged'), /GATE_TARGET_MISSING/);
  const b = store.readBatch(S, id);
  assert.equal(b.lanes.e1, 'review'); // 成员态不变（拒 merged 不改状态）
  const ev = b.events.find((e) => e.type === 'gate.target_blocked');
  assert.ok(ev && ev.code === 'GATE_TARGET_MISSING' && ev.lane === 'e1', JSON.stringify(ev));
  assert.ok(!b.events.some((e) => e.type === 'gate.target.passed'), '未通过不留 passed');
});

test('O2 C3 接线：声明 targets 通过 → merged 放行 + gate.target.passed（mode=mtime）', () => {
  const id = 'b-tg-wire-ok';
  const target = path.join(root, 'sessions', S, 'artifacts', id, 'target-ok.js');
  makeTargetPlan(id, [target]);
  fs.writeFileSync(target, 'code');
  const future = new Date(Date.now() + 60000);
  fs.utimesSync(target, future, future); // mtime 晚于 lane 启动
  store.setMember(S, id, 'e1', 'running');
  store.setMember(S, id, 'e1', 'review');
  const r = store.setMember(S, id, 'e1', 'merged');
  assert.equal(r.lanes.e1, 'merged');
  const ev = r.events.find((e) => e.type === 'gate.target.passed');
  assert.ok(ev && ev.mode === 'mtime' && ev.lane === 'e1', JSON.stringify(ev));
  assert.deepEqual(ev.targets, [target]);
});

test('O2 C3 接线：未声明 targets 的 merged 行为与接线前一致（零感知回归，无 targets 事件）', () => {
  const id = 'b-tg-wire-none';
  makeTargetPlan(id, null); // 未声明 targets
  store.setMember(S, id, 'e1', 'running');
  store.setMember(S, id, 'e1', 'review');
  const r = store.setMember(S, id, 'e1', 'merged');
  assert.equal(r.lanes.e1, 'merged');
  assert.ok(!r.events.some((e) => e.type === 'gate.target.passed' || e.type === 'gate.target_blocked'), '零感知无事件');
  // 既有 gate.passed(exit) 事件顺序不破坏（exit 仍最先）
  const evs = r.events.filter((e) => e.type === 'gate.passed' && e.lane === 'e1');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].gate, 'exit');
});