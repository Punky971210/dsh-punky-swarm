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

// F1 修复批次 `punky-fix-f1-20261022` · lane `e3-tester` · 缺陷 **A1-P1-04**（兜底回填丢真值 + `has` 压制）。
//
// 判据源 `plan/fix-spec.md` §方案 2 / §验收 T-2：
//   ① `laneBindingOf` 带回 `ownerSessionId`（**非枚举自有属性**：枚举键恒 3 键、顺序亦断言）；
//   ② 兜底回填取**真值**（改前硬传 `null`）⇒ `wakeAddressOf(entry)` 首次即取到 owner；
//   ③ 幂等不退化：已带 owner 的条目不重扫（封盘调用次数 0 增量）；
//   ④ 反向回退（阴性对照）：事件无 owner ⇒ 条目无该属性、`wakeAddressOf` 退化为 `sessionId`（C-3 逐字）。
//
// ⚠ 已裁决降 followup 的形态（**不写失败断言**）：规格 §B T-2.3「既有条目 `sessionId` **合法**但缺 owner ⇒
//   就地升级」与 `lane-session-bind.test.js` 回归-b「冷查 1 次扫盘、二次调用零扫盘」**结构性冲突**
//   （要升级必须再扫盘 / 加负缓存）⇒ Leader 已裁「降 followup」。本文件只覆盖**可达面**：
//   既有条目 `sessionId` **非法/空**（热路径不命中）⇒ 以真值修复。该形态见 T-2.5。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { EVT_MEMBER_DISPATCH } from '../lib/state/event-types.js';
import {
  laneBindingOf, batchSessionIdOfWorkerResolved, batchSessionIdOfWorker,
  dispatchIndexEntryOf, ownerSessionIdOf, wakeAddressOf,
} from '../lib/engine/dispatch.js';
import { tempRoot } from './helpers/gate-fixture.mjs';

function seedBatch(root, sessionId, batchId, laneId = 'l1') {
  const store = createStore(root);
  store.createBatch(sessionId, {
    batchId,
    wavePlan: buildWavePlan({ batchId, tasks: [{ id: 'l1' }, { id: 'l2' }] }),
    phase: 'running',
  });
  return store;
}

// `listAllBatches` 调用计数包装（幂等「不重扫」的可证伪读数：只数真实扫盘次数，不改被测实现）
function countingStore(store) {
  const counters = { listAllBatches: 0, readBatch: 0 };
  const wrapper = {};
  for (const key of Object.keys(store)) {
    const v = store[key];
    if (typeof v !== 'function') { wrapper[key] = v; continue; }
    wrapper[key] = (...args) => {
      if (key === 'listAllBatches' || key === 'readBatch') counters[key] += 1;
      return v.apply(store, args);
    };
  }
  wrapper.counters = counters;
  return wrapper;
}

const execOf = (sessionId) => ({ agent: { session: { id: sessionId } } });

// ── T-2.1 `laneBindingOf` 带回 owner（非枚举附加）+ 3 键形状零变化 ──
test('T-2.1 A1-P1-04 laneBindingOf：事件带 owner ⇒ 非枚举附加 ownerSessionId，枚举键仍恰 3 键（顺序不变）', () => {
  const root = tempRoot('punky-f1t2a-');
  const store = seedBatch(root, 'sess-o', 'b-t2a');
  store.appendEvent('sess-o', 'b-t2a', EVT_MEMBER_DISPATCH, { lane: 'l1', workerSessionId: 'ws-owner', ownerSessionId: 'leader-9' });

  const bind = laneBindingOf(store, 'ws-owner');
  assert.deepEqual(Object.keys(bind), ['sessionId', 'batchId', 'lane'], '枚举键仍恰 3 键且顺序不变（既有 deepEqual 形状锁）');
  assert.deepEqual(bind, { sessionId: 'sess-o', batchId: 'b-t2a', lane: 'l1' }, 'deepStrictEqual 面逐字不变');
  assert.equal(JSON.stringify(bind), '{"sessionId":"sess-o","batchId":"b-t2a","lane":"l1"}', 'JSON 序列化面不新增键');
  assert.ok(Object.getOwnPropertyNames(bind).includes('ownerSessionId'), '非枚举自有属性必须在场（唤醒寻址取真值）');
  assert.equal(ownerSessionIdOf(bind), 'leader-9', '解析单点取到真值');
  assert.equal(wakeAddressOf(bind), 'leader-9', '唤醒地址 = owner（不再退化）');

  // 阳性对照（同 store 同批，只换「事件是否带 owner」）：无 owner ⇒ 属性键**缺席**（不是 null）
  store.appendEvent('sess-o', 'b-t2a', EVT_MEMBER_DISPATCH, { lane: 'l2', workerSessionId: 'ws-plain' });
  const plain = laneBindingOf(store, 'ws-plain');
  assert.equal(Object.getOwnPropertyNames(plain).includes('ownerSessionId'), false, '无 owner ⇒ 不附加该属性（键缺席）');
  assert.equal(ownerSessionIdOf(plain), null);
  assert.equal(wakeAddressOf(plain), 'sess-o', 'C-3 回退逐字：无 owner ⇒ 取批归属键');
});

// ── T-2.2 兜底回填取真值（改前为 null） ──
test('T-2.2 A1-P1-04 兜底回填：空索引 + 事件带 owner ⇒ 索引条目带 owner，wakeAddressOf 取到 owner（改前为 null）', () => {
  const root = tempRoot('punky-f1t2b-');
  const store = seedBatch(root, 'sess-b2', 'b-t2b');
  store.appendEvent('sess-b2', 'b-t2b', EVT_MEMBER_DISPATCH, { lane: 'l1', workerSessionId: 'ws-back', ownerSessionId: 'leader-9' });

  const index = new Map();
  const got = batchSessionIdOfWorkerResolved(store, index, execOf('ws-back'));
  assert.equal(got, 'sess-b2', '解析仍返回批归属会话（返回面零变化）');

  const entry = index.get('ws-back');
  assert.ok(entry, '索引已回填');
  assert.equal(ownerSessionIdOf(entry), 'leader-9', '**回填取真值**（改前此处恒 null）');
  assert.equal(wakeAddressOf(entry), 'leader-9', '唤醒寻址不再退化为批归属键');
  assert.deepEqual(Object.keys(entry), ['sessionId', 'batchId', 'lane'], '索引值枚举键仍恰 3 键（形状冻结）');

  // 阳性对照（同输入换「事件是否带 owner」）：无 owner 事件 ⇒ 条目无 owner、寻址回退 sessionId
  store.appendEvent('sess-b2', 'b-t2b', EVT_MEMBER_DISPATCH, { lane: 'l2', workerSessionId: 'ws-back-plain' });
  const index2 = new Map();
  assert.equal(batchSessionIdOfWorkerResolved(store, index2, execOf('ws-back-plain')), 'sess-b2');
  const entry2 = index2.get('ws-back-plain');
  assert.equal(ownerSessionIdOf(entry2), null, '无 owner 事件 ⇒ 不猜 owner');
  assert.equal(wakeAddressOf(entry2), 'sess-b2', '回退批归属键（C-3 逐字）');
});

// ── T-2.3 幂等不退化：已带 owner 的条目**不重扫**、不重写 ──
test('T-2.3 A1-P1-04 幂等：条目已带 owner ⇒ 热路径命中、零扫盘、条目引用不变（不重扫不重写）', () => {
  const root = tempRoot('punky-f1t2c-');
  const real = seedBatch(root, 'sess-c2', 'b-t2c');
  real.appendEvent('sess-c2', 'b-t2c', EVT_MEMBER_DISPATCH, { lane: 'l1', workerSessionId: 'ws-idem', ownerSessionId: 'leader-9' });
  const store = countingStore(real);

  const index = new Map();
  assert.equal(batchSessionIdOfWorkerResolved(store, index, execOf('ws-idem')), 'sess-c2', '首写回填');
  const first = index.get('ws-idem');
  const scansAfterFirst = store.counters.listAllBatches;
  assert.equal(scansAfterFirst, 1, '首写恰扫盘 1 次（实证「确实扫过」，防计数夹具恒 0）');

  assert.equal(batchSessionIdOfWorkerResolved(store, index, execOf('ws-idem')), 'sess-c2', '二次调用仍命中');
  assert.equal(store.counters.listAllBatches, scansAfterFirst, '已带 owner ⇒ **零重扫**（幂等未退化）');
  assert.equal(index.get('ws-idem'), first, '条目引用未被重写（同键不重复 set）');
  assert.equal(ownerSessionIdOf(first), 'leader-9');

  // 阳性对照（同输入，条目先被清空）：清空后确实会重扫 ⇒ 证明上面的「零扫盘」不是夹具不计数
  index.delete('ws-idem');
  assert.equal(batchSessionIdOfWorkerResolved(store, index, execOf('ws-idem')), 'sess-c2');
  assert.equal(store.counters.listAllBatches, scansAfterFirst + 1, '清空后重扫计数 +1（计数面有牙）');
});

// ── T-2.4 反向：回填值形状 / 读点单点不破（枚举键 3 + 热路径同源） ──
test('T-2.4 A1-P1-04 回填值与热路径读数同源：batchSessionIdOfWorker 命中同一值；3 键冻结', () => {
  const root = tempRoot('punky-f1t2d-');
  const store = seedBatch(root, 'sess-d2', 'b-t2d');
  store.appendEvent('sess-d2', 'b-t2d', EVT_MEMBER_DISPATCH, { lane: 'l1', workerSessionId: 'ws-src', ownerSessionId: 'owner-d' });
  const index = new Map();
  batchSessionIdOfWorkerResolved(store, index, execOf('ws-src'));
  assert.equal(batchSessionIdOfWorker(index, execOf('ws-src')), batchSessionIdOfWorkerResolved(store, index, execOf('ws-src')), '冷/热读数同源');
  assert.deepEqual({ ...index.get('ws-src') }, { sessionId: 'sess-d2', batchId: 'b-t2d', lane: 'l1' }, '展开（可枚举面）仍 3 键');
});

// ── T-2.5 可达的「就地升级」形态（既有条目 sessionId 非法 ⇒ 以真值修复；规格 T-2.3 的不可达面见文件头） ──
test('T-2.5 A1-P1-04 既有条目 sessionId 非法/空（热路径不命中）⇒ 就地以真值修复（含 owner）', () => {
  const root = tempRoot('punky-f1t2e-');
  const store = seedBatch(root, 'sess-e2', 'b-t2e');
  store.appendEvent('sess-e2', 'b-t2e', EVT_MEMBER_DISPATCH, { lane: 'l1', workerSessionId: 'ws-repair', ownerSessionId: 'leader-9' });

  const index = new Map();
  index.set('ws-repair', dispatchIndexEntryOf('', 'b-stale', 'lx', null)); // 非法 sessionId ⇒ 热路径 miss
  assert.equal(batchSessionIdOfWorker(index, execOf('ws-repair')), null, '前置：非法条目确实不命中（否则本用例测不到）');

  assert.equal(batchSessionIdOfWorkerResolved(store, index, execOf('ws-repair')), 'sess-e2');
  const entry = index.get('ws-repair');
  assert.deepEqual(Object.keys(entry), ['sessionId', 'batchId', 'lane'], '修复后仍 3 枚举键');
  assert.equal(entry.batchId, 'b-t2e', '批归属键以事件真值修复');
  assert.equal(ownerSessionIdOf(entry), 'leader-9', '同时带回 owner 真值');
});
