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

// 损坏批次隔离（v2-node-robustness ②，P0）+ 崩溃重派（①）—— T-TEST-1 / T-TEST-2
// 覆盖：INV-1a/1b/1c、INV-2a、INV-8a/8b、INV-3a/3b、INV-4a/4b/4c、降级路径
// 只读验证：不修改业务源码，仅构造临时 fixture 驱动 store 公共 API。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import * as mailbox from '../lib/comms/mailbox.js';
import { createLaneHeartbeat } from '../lib/watch/lane-heartbeat.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { corruptFileOf } from '../lib/state/corrupt-registry.js';
import * as schema from '../lib/schema.js';

// 静默 logger（不刷测试输出；只关心行为不关心日志正文）
const SILENT = { warn() {}, info() {}, error() {} };

// 通用 fixture：root + store + session
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-corr-'));
  const store = createStore(root, { logger: SILENT });
  return { root, store, S: 'sess-corrupt' };
}

// 造一个 running 批次（两个 lane：l1 running / l2 review），返回 batchId
function makeRunningBatch(store, S, batchId) {
  const plan = buildWavePlan({ batchId, tasks: [{ id: 'l1' }, { id: 'l2' }] });
  store.createBatch(S, { batchId, wavePlan: plan, phase: 'running' });
  store.setMember(S, batchId, 'l1', 'running');
  store.setMember(S, batchId, 'l2', 'running');
  store.setMember(S, batchId, 'l2', 'review');
  return batchId;
}

// 写损坏批次文件（非法 JSON）
function corruptBatchFile(store, S, batchId) {
  const file = store.batchFile(S, batchId);
  fs.writeFileSync(file, '{ not valid json !!');
  return file;
}

// ---- T-TEST-1：损坏批次隔离（②，P0）----

test('INV-1a：1 损坏 + 2 正常批次 → recoverBatches 不 throw、正常批次全 idle、r.corrupt 含损坏批次', () => {
  const { store, S } = setup();
  makeRunningBatch(store, S, 'b-ok1');
  makeRunningBatch(store, S, 'b-ok2');
  store.createBatch(S, { batchId: 'b-bad', wavePlan: buildWavePlan({ batchId: 'b-bad', tasks: [{ id: 'x' }] }), phase: 'running' });
  corruptBatchFile(store, S, 'b-bad');

  let r;
  assert.doesNotThrow(() => { r = store.recoverBatches(); });
  assert.ok(Array.isArray(r), 'recoverBatches 返回数组（向后兼容形态）');
  assert.ok(r.includes(S + '/b-ok1') && r.includes(S + '/b-ok2'), '正常批次全部恢复');
  assert.ok(!r.includes(S + '/b-bad'), '损坏批次不进 recovered 数组');
  assert.deepEqual(r.corrupt, [S + '/b-bad'], 'r.corrupt 含损坏批次（{ recovered, corrupt } 语义经 r.corrupt）');
  // 正常批次恢复为 idle
  assert.equal(store.readBatch(S, 'b-ok1').lanes.l1, 'idle');
  assert.equal(store.readBatch(S, 'b-ok2').lanes.l2, 'idle');
});

test('INV-1b：损坏批次下 listBatches 不 throw；readBatch 返回 null 而非 throw', () => {
  const { store, S } = setup();
  makeRunningBatch(store, S, 'b-ok');
  store.createBatch(S, { batchId: 'b-bad', wavePlan: buildWavePlan({ batchId: 'b-bad', tasks: [{ id: 'x' }] }), phase: 'running' });
  corruptBatchFile(store, S, 'b-bad');

  let list;
  assert.doesNotThrow(() => { list = store.listBatches(S); });
  assert.ok(list.includes('b-bad') && list.includes('b-ok'), 'listBatches 仍列出损坏批次（读路径不 throw）');
  assert.equal(store.readBatch(S, 'b-bad'), null, 'readBatch 损坏 → null');
  assert.equal(store.readBatch(S, 'b-no-such'), undefined, 'readBatch 不存在 → undefined（区分于损坏）');
});

test('INV-1c：heartbeat tick 遇损坏批次不 throw、其余 running lane 正常扫描', () => {
  const { root, store, S } = setup();
  makeRunningBatch(store, S, 'b-ok');
  store.createBatch(S, { batchId: 'b-bad', wavePlan: buildWavePlan({ batchId: 'b-bad', tasks: [{ id: 'x' }] }), phase: 'running' });
  corruptBatchFile(store, S, 'b-bad');
  const cfg = { capabilities: { watch: { enabled: true, intervalsMinutes: [0, 0, 0], maxMissed: 1 } } };
  const engine = createLaneHeartbeat({ store, mailbox, config: cfg, root });
  assert.doesNotThrow(() => { engine.tick(); });
  // 正常批次收到追问（扫描未被打断）
  const inbox = mailbox.readUnacked(path.join(root, 'sessions', S, 'mailbox', 'b-ok'), { type: 'inbox' });
  assert.ok(inbox.length >= 1, '正常批次收到 heartbeat 追问（tick 未中断）');
});

test('INV-2a：同一损坏文件重复 readBatch/recoverBatches → corrupt 清单仅一条（幂等）', () => {
  const { store, S } = setup();
  store.createBatch(S, { batchId: 'b-bad', wavePlan: buildWavePlan({ batchId: 'b-bad', tasks: [{ id: 'x' }] }), phase: 'running' });
  corruptBatchFile(store, S, 'b-bad');

  assert.equal(store.readBatch(S, 'b-bad'), null); // 第一次登记
  assert.equal(store.readBatch(S, 'b-bad'), null); // 重复
  store.recoverBatches();
  store.recoverBatches();
  const list = store.corruptRegistry.listCorruptBatches(S);
  assert.equal(list.length, 1, '清单仅一条（登记幂等，INV-2）');
  assert.equal(list[0].batchId, 'b-bad');
  // 重复恢复不重复 system.recovered（损坏批次本就无恢复事件）
  const b = store.readBatch(S, 'b-bad'); // 仍为 null
  assert.equal(b, null);
});

test('INV-8a：损坏批次上 setMember → throw "batch not found"（不崩，if(!batch) 调用点差分）', () => {
  const { root, store, S } = setup();
  store.createBatch(S, { batchId: 'b-bad', wavePlan: buildWavePlan({ batchId: 'b-bad', tasks: [{ id: 'x' }] }), phase: 'running' });
  corruptBatchFile(store, S, 'b-bad');
  assert.throws(() => store.setMember(S, 'b-bad', 'x', 'running'), /batch not found/);
  assert.throws(() => store.setPhase(S, 'b-bad', 'paused'), /batch not found/);
  const src = path.join(root, 'src.txt');
  fs.writeFileSync(src, 'x');
  assert.throws(() => store.claimAsset(S, 'b-bad', { source: src, target: 'a/b.txt' }), /batch not found/);
});

test('INV-8b：isCorrupt 区分损坏（true）与不存在（false）', () => {
  const { store, S } = setup();
  store.createBatch(S, { batchId: 'b-bad', wavePlan: buildWavePlan({ batchId: 'b-bad', tasks: [{ id: 'x' }] }), phase: 'running' });
  corruptBatchFile(store, S, 'b-bad');
  store.readBatch(S, 'b-bad'); // 触发损坏登记（readBatch 幂等登记旁路清单）
  assert.equal(store.isCorrupt(S, 'b-bad'), true);
  assert.equal(store.isCorrupt(S, 'b-missing'), false);
  assert.equal(store.isCorrupt(S, 'b-ok'), false);
});

test('降级：corrupt-batches.json 自身损坏 → 读降级空清单不 throw；readBatch 后清单被重建（governance 同款模式）', () => {
  const { root, store, S } = setup();
  store.createBatch(S, { batchId: 'b-bad', wavePlan: buildWavePlan({ batchId: 'b-bad', tasks: [{ id: 'x' }] }), phase: 'running' });
  corruptBatchFile(store, S, 'b-bad');
  // 破坏清单文件本体（此时清单已含 b-bad 登记，破坏后 readList 降级空清单）
  const cf = corruptFileOf(root, S);
  fs.writeFileSync(cf, '{ broken !!');
  assert.doesNotThrow(() => store.readBatch(S, 'b-bad')); // 登记走降级空清单，不 throw
  // readBatch 登记路径：降级空清单 → 重新写入合法清单（重建）
  const rebuilt = JSON.parse(fs.readFileSync(cf, 'utf8'));
  assert.equal(rebuilt.schema, 1);
  assert.equal(rebuilt.corrupt.some((c) => c.batchId === 'b-bad'), true, '重建清单含 b-bad');
  assert.equal(store.isCorrupt(S, 'b-bad'), true, '重建后登记恢复');
  assert.doesNotThrow(() => store.recoverBatches());
});

// ---- T-TEST-2：崩溃重派（①）----

test('INV-3a：二次 recoverBatches → system.recovered 不重复（幂等，既有断言保持）', () => {
  const { store, S } = setup();
  makeRunningBatch(store, S, 'b-crash');
  store.recoverBatches();
  const b1 = store.readBatch(S, 'b-crash');
  const n1 = b1.events.filter((e) => e.type === 'system.recovered').length;
  assert.equal(n1, 1);
  const r2 = store.recoverBatches();
  const b2 = store.readBatch(S, 'b-crash');
  const n2 = b2.events.filter((e) => e.type === 'system.recovered').length;
  assert.equal(n2, 1, '二次恢复不重复 system.recovered');
  assert.ok(!r2.includes(S + '/b-crash'), '二次恢复无恢复批次（幂等）');
});

test('INV-3b：恢复后 running/review→idle；detail 含 lane/from/lastActiveAt/produced', () => {
  const { root, store, S } = setup();
  const plan = buildWavePlan({
    batchId: 'b-det',
    tasks: [{ id: 'l1', layer: 'exec', outputs: ['exec/out.txt'] }, { id: 'l2', layer: 'audit', produce: ['audit/accept.md'] }],
  });
  store.createBatch(S, { batchId: 'b-det', wavePlan: plan, phase: 'running' });
  store.setMember(S, 'b-det', 'l1', 'running');
  store.setMember(S, 'b-det', 'l2', 'running');
  store.setMember(S, 'b-det', 'l2', 'review');
  // 造产物（produced 探测用）
  const art = path.join(root, 'sessions', S, 'artifacts', 'b-det', 'exec');
  fs.mkdirSync(art, { recursive: true });
  fs.writeFileSync(path.join(art, 'out.txt'), 'x');
  store.recoverBatches();
  const b = store.readBatch(S, 'b-det');
  assert.equal(b.lanes.l1, 'idle');
  assert.equal(b.lanes.l2, 'idle');
  const ev = b.events.find((e) => e.type === 'system.recovered');
  assert.ok(ev && Array.isArray(ev.detail), 'detail 数组存在');
  const d1 = ev.detail.find((d) => d.lane === 'l1');
  assert.equal(d1.from, 'running');
  assert.ok(d1.lastActiveAt, 'lastActiveAt 存在');
  assert.deepEqual(d1.produced, ['exec/out.txt'], 'produced 探测产出（gate 语义）');
});

test('INV-4a：idle→running 重派合法（machine 迁移）；重复重派 running→running 被拒', () => {
  const { store, S } = setup();
  makeRunningBatch(store, S, 'b-re');
  store.recoverBatches();
  assert.equal(store.readBatch(S, 'b-re').lanes.l1, 'idle');
  assert.doesNotThrow(() => store.setMember(S, 'b-re', 'l1', 'running')); // 重派合法
  assert.throws(() => store.setMember(S, 'b-re', 'l1', 'running'), /invalid member transition/); // 重复 running→running 被拒
});

test('INV-4b：终态 lane（failed/merged/skipped/conflict）→ running 非法迁移被拒（不自动重试纪律）', () => {
  const { store, S } = setup();
  // failed：running → failed（合法链）
  const bidF = 'b-f';
  const planF = buildWavePlan({ batchId: bidF, tasks: [{ id: 'a' }] });
  store.createBatch(S, { batchId: bidF, wavePlan: planF, phase: 'running' });
  store.setMember(S, bidF, 'a', 'running');
  store.setMember(S, bidF, 'a', 'failed');
  assert.throws(() => store.setMember(S, bidF, 'a', 'running'), /invalid member transition/, 'failed 终态不可重派');
  // merged：running → review → merged（合法链）
  const bidM = 'b-m';
  const planM = buildWavePlan({ batchId: bidM, tasks: [{ id: 'a' }] });
  store.createBatch(S, { batchId: bidM, wavePlan: planM, phase: 'running' });
  store.setMember(S, bidM, 'a', 'running');
  store.setMember(S, bidM, 'a', 'review');
  store.setMember(S, bidM, 'a', 'merged');
  assert.throws(() => store.setMember(S, bidM, 'a', 'running'), /invalid member transition/, 'merged 终态不可重派');
  // conflict：running → review → conflict（合法链）
  const bidC = 'b-c';
  const planC = buildWavePlan({ batchId: bidC, tasks: [{ id: 'a' }] });
  store.createBatch(S, { batchId: bidC, wavePlan: planC, phase: 'running' });
  store.setMember(S, bidC, 'a', 'running');
  store.setMember(S, bidC, 'a', 'review');
  store.setMember(S, bidC, 'a', 'conflict');
  assert.throws(() => store.setMember(S, bidC, 'a', 'running'), /invalid member transition/, 'conflict 终态不可重派');
  // skipped：直接构造终态批次文件（pending→skipped 自动落路径既有）
  const bidS = 'b-s';
  const planS = buildWavePlan({ batchId: bidS, tasks: [{ id: 'a' }] });
  store.createBatch(S, { batchId: bidS, wavePlan: planS, phase: 'running' });
  const b = store.readBatch(S, bidS);
  b.lanes.a = 'skipped';
  b.events.push({ ts: new Date().toISOString(), type: 'member.settled', lane: 'a', from: 'pending', to: 'skipped' });
  b.updatedAt = new Date().toISOString();
  fs.writeFileSync(store.batchFile(S, bidS), JSON.stringify(b, null, 2));
  assert.throws(() => store.setMember(S, bidS, 'a', 'running'), /invalid member transition/, 'skipped 终态不可重派');
});

test('INV-4c：混合场景（含损坏批次）→ 恢复完成 + 可重派清单完整（与 T-TEST-1 联动）', () => {
  const { store, S } = setup();
  makeRunningBatch(store, S, 'b-ok');
  store.createBatch(S, { batchId: 'b-bad', wavePlan: buildWavePlan({ batchId: 'b-bad', tasks: [{ id: 'x' }] }), phase: 'running' });
  corruptBatchFile(store, S, 'b-bad');
  const r = store.recoverBatches();
  assert.ok(r.includes(S + '/b-ok'));
  assert.deepEqual(r.corrupt, [S + '/b-bad']);
  // 正常批次可重派
  assert.doesNotThrow(() => store.setMember(S, 'b-ok', 'l1', 'running'));
  // 损坏批次仍隔离（isCorrupt true，readBatch null）
  assert.equal(store.isCorrupt(S, 'b-bad'), true);
  assert.equal(store.readBatch(S, 'b-bad'), null);
});

test('INV-3 边界：stalled 仍非成员状态；MEMBER_TRANSITIONS 未放宽（棘轮 fail-closed 断言）', () => {
  assert.equal(schema.MEMBER_STATES.includes('stalled'), false);
  assert.equal(schema.MEMBER_TRANSITIONS.running.includes('stalled'), false);
  assert.equal(schema.MEMBER_TRANSITIONS.review.includes('stalled'), false);
});
