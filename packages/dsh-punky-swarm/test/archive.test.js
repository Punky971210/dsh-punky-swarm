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

// Archive（P1-5 done→archive）验收测试：决策包 §2.3 A1-A6
// A1 自动归档 / A2 单向 / A3 幂等 / A4 失败不阻断 / A5 行为不变 / A6 v2 存量迁移
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import { createArchive } from '../lib/state/archive.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { migrateV2toV3, chainsDefaults } from '../lib/state/schema-v3.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-arc-'));
const store = createStore(root);
const SID = 's-arc';
const specOk = '# Spec\n## 验收标准\n- done\n## 约束\n- none\n';

function makePlan(batchId, tasks, opts = {}) {
  const plan = buildWavePlan({ batchId, tasks, team: 'jiufeng', ...opts });
  store.createBatch(SID, { batchId, wavePlan: plan });
  return plan;
}
function art(batchId, rel, content = 'x') {
  const abs = path.join(root, 'sessions', SID, 'artifacts', batchId, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}
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
function tasks3() {
  return [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1/main.py'], cmd: 'code', deps: ['p1'] },
    { id: 'a1', layer: 'audit', role: 'reviewer', produce: ['audit/review.md'], cmd: 'review', deps: ['e1'] },
  ];
}
// 三层批次完整流转 → complete（plan/exec/audit 各 lane merged，产物齐备）
function completeThreeLayer(batchId) {
  makePlan(batchId, tasks3());
  store.setPhase(SID, batchId, 'running');
  art(batchId, 'plan/spec.md', specOk);
  runLane(batchId, 'p1');
  art(batchId, 'exec/e1/main.py', 'print(1)');
  runLane(batchId, 'e1');
  art(batchId, 'audit/review.md', 'ok');
  runLane(batchId, 'a1');
  return store.setPhase(SID, batchId, 'complete');
}

test('A1：complete 后自动归档——快照逐文件一致 + manifest 可查', () => {
  const b = completeThreeLayer('b-a1');
  assert.equal(b.phase, 'complete');
  const arcDir = path.join(root, 'sessions', SID, 'archive', 'b-a1');
  assert.equal(fs.existsSync(path.join(arcDir, 'manifest.json')), true);
  // 快照 = artifacts/<bid>/ 逐文件一致；原产物保留（只复制不移动）
  for (const rel of ['plan/spec.md', 'exec/e1/main.py', 'audit/review.md']) {
    const src = path.join(root, 'sessions', SID, 'artifacts', 'b-a1', rel);
    const dst = path.join(arcDir, rel);
    assert.equal(fs.existsSync(src), true, 'source removed: ' + rel);
    assert.equal(fs.readFileSync(dst, 'utf8'), fs.readFileSync(src, 'utf8'), 'snapshot mismatch: ' + rel);
  }
  const m = store.archive.readManifest(SID, 'b-a1');
  assert.ok(m, 'manifest missing');
  assert.equal(m.batchId, 'b-a1');
  assert.equal(m.sessionId, SID);
  assert.ok(m.archivedAt);
  assert.equal(m.schema, 3);
  assert.equal(m.phase, 'complete');
  assert.equal(m.wavePlan.waves, store.readBatch(SID, 'b-a1').wavePlan.length); // wave 摘要 = 建批 wavePlan 波数
  assert.equal(m.wavePlan.lanes, 3);
  assert.deepEqual(m.lanes, { p1: 'merged', e1: 'merged', a1: 'merged' }); // lanes 终态快照
  assert.equal(m.eventCount, b.events.length); // 归档前事件数快照
  const paths = m.artifacts.map((a) => a.path).sort();
  assert.deepEqual(paths, ['audit/review.md', 'exec/e1/main.py', 'plan/spec.md'].sort());
  for (const a of m.artifacts) {
    assert.equal(typeof a.size, 'number');
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
  }
});

test('A2：单向——archived:true + archive.done + 无 unarchive 入口 + complete 终态拒写', () => {
  const bb = store.readBatch(SID, 'b-a1');
  assert.equal(bb.archived, true);
  assert.ok(bb.events.some((e) => e.type === 'archive.done' && e.archivedAt));
  // 无反向 API/工具：导出面仅 archiveBatch/readManifest/listArchived（grep 级验证见修改说明）
  assert.equal('unarchiveBatch' in store.archive, false);
  assert.deepEqual(Object.keys(store.archive).sort(), ['archiveBatch', 'listArchived', 'readManifest']);
  const standalone = createArchive(root);
  assert.deepEqual(Object.keys(standalone).sort(), ['archiveBatch', 'listArchived', 'readManifest']);
  // complete 终态拒写（batch_phase/setMember 既有语义，三重锁定之一）
  assert.throws(() => store.setPhase(SID, 'b-a1', 'paused'));
  assert.throws(() => store.setPhase(SID, 'b-a1', 'complete'));
  assert.throws(() => store.setMember(SID, 'b-a1', 'p1', 'running'));
});

test('A3：幂等——重复归档 no-op（不重复复制、不覆盖 manifest、无第二 archive.done）', () => {
  const m1 = store.archive.readManifest(SID, 'b-a1');
  const evCount = store.readBatch(SID, 'b-a1').events.length;
  const r = store.archive.archiveBatch(SID, 'b-a1');
  assert.deepEqual(r, m1); // no-op 返回既有记录
  const b2 = store.readBatch(SID, 'b-a1');
  assert.equal(b2.events.filter((e) => e.type === 'archive.done').length, 1);
  assert.equal(b2.events.length, evCount);
  assert.deepEqual(store.archive.readManifest(SID, 'b-a1'), m1); // manifest 未被覆盖
});

test('A4：归档失败不阻断 complete——archive.failed + complete 已置位；补齐产物后重试成功', () => {
  // 无产物目录的 generic 批次 complete → 归档失败但 complete 正常返回（phase=complete 已置位）
  const p = buildWavePlan({ batchId: 'b-fail', tasks: [{ id: 't1', cmd: 'x' }] });
  store.createBatch(SID, { batchId: 'b-fail', wavePlan: p });
  store.setPhase(SID, 'b-fail', 'running');
  runLane('b-fail', 't1');
  const r = store.setPhase(SID, 'b-fail', 'complete');
  assert.equal(r.phase, 'complete'); // 不被阻断
  const bf = store.readBatch(SID, 'b-fail');
  assert.ok(bf.events.some((e) => e.type === 'archive.failed' && /artifacts dir missing/.test(e.reason)));
  assert.equal(store.archive.readManifest(SID, 'b-fail'), null);
  // 补齐产物后重试归档成功（恢复流程语义）
  art('b-fail', 'explore/findings.txt', 'found');
  const ret = store.archive.archiveBatch(SID, 'b-fail');
  assert.ok(ret === null || !(ret.ok === false), 'retry archive failed: ' + JSON.stringify(ret));
  const m = store.archive.readManifest(SID, 'b-fail');
  assert.ok(m, 'retry manifest missing');
  assert.deepEqual(m.artifacts.map((a) => a.path), ['explore/findings.txt']);
  const bf2 = store.readBatch(SID, 'b-fail');
  assert.equal(bf2.archived, true);
  assert.ok(bf2.events.some((e) => e.type === 'archive.done'));
});

test('A5：行为不变——非 complete 不归档；新建批次 archived 缺省 false；迁移兜底', () => {
  const p = buildWavePlan({ batchId: 'b-nc', tasks: [{ id: 'x', cmd: 'x' }] });
  store.createBatch(SID, { batchId: 'b-nc', wavePlan: p });
  assert.equal(store.readBatch(SID, 'b-nc').archived, false); // v3 新建批次缺省 false
  store.setPhase(SID, 'b-nc', 'running');
  runLane('b-nc', 'x');
  // phase 仍 running → 不触发归档
  assert.equal(fs.existsSync(path.join(root, 'sessions', SID, 'archive', 'b-nc')), false);
  const bn = store.readBatch(SID, 'b-nc');
  assert.equal(bn.events.some((e) => e.type === 'archive.done' || e.type === 'archive.failed'), false);
  // 迁移兜底：无 archived 字段 → false；chains 兜底逻辑不动
  const migrated = migrateV2toV3({ schema: 2 });
  assert.equal(migrated.archived, false);
  assert.deepEqual(migrated.chains, chainsDefaults());
  assert.equal(store.archive.readManifest(SID, 'b-nc'), null); // 未归档批次 manifest 为 null
});

test('A6：v2 存量批次 complete → 迁移兜底（schema 升 3 + chains + archived:false）→ 正常归档', () => {
  const v2 = {
    schema: 2,
    sessionId: SID,
    batchId: 'b-v2',
    phase: 'running',
    concurrency: 5,
    team: 'generic',
    wavePlan: [{ wave: 1, tasks: [{ id: 'a1', layer: 'audit', produce: ['audit/review.md'], cmd: 'r' }] }],
    lanes: { a1: 'merged' },
    events: [{ ts: '2026-01-01T00:00:00.000Z', type: 'batch.created', batchId: 'b-v2', sessionId: SID }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  fs.writeFileSync(path.join(root, 'sessions', SID, 'batches', 'b-v2.json'), JSON.stringify(v2, null, 2));
  art('b-v2', 'audit/review.md', 'legacy-review');
  const r = store.setPhase(SID, 'b-v2', 'complete');
  assert.equal(r.phase, 'complete');
  const b2 = store.readBatch(SID, 'b-v2');
  assert.equal(b2.schema, 3); // 迁移落盘：schema 升 3
  assert.deepEqual(b2.chains, chainsDefaults()); // chains 兜底
  assert.equal(b2.archived, true); // archived 标记
  const m = store.archive.readManifest(SID, 'b-v2');
  assert.ok(m, 'v2 manifest missing');
  assert.equal(m.schema, 3);
  assert.deepEqual(m.artifacts.map((a) => a.path), ['audit/review.md']);
  assert.equal(fs.readFileSync(path.join(root, 'sessions', SID, 'archive', 'b-v2', 'audit', 'review.md'), 'utf8'), 'legacy-review');
});

test('listArchived：只列已归档批次（manifest 存在），稳定排序', () => {
  const ids = store.archive.listArchived(SID);
  assert.deepEqual(ids, ['b-a1', 'b-fail', 'b-v2']);
  assert.ok(!ids.includes('b-nc')); // 未归档批次不出现
});
