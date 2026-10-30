/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/settle-decoupled.test.js —— **I-12 验收**：结算与状态推进**解耦**（结算失败不阻塞推进）。
//
// 文件名按计划 T-cmd 原文（`node --test test/settle-decoupled.test.js`）。
// 判据源：`plan/p1-pack.md` I-12 ＋ `e2-settle` handoff 断言基线。
//
// ⚠ **本文件最容易做反的一条**：正确语义是「**结算失败 ⇒ 状态仍推进**」；
//   「结算失败 ⇒ 状态不变」是**要消除的反语义**。另：把**推进**错误也吞掉属「过度解耦」，比耦合更危险
//   （状态没推进，调用方却收到成功）⇒ 必须照旧向上抛。
//
// 可红形态：
//   S1 若结算抛错也向上抛 ⇒ S1 红；
//   S2 若结算抛错时 `stateAdvanced` 仍 false / 状态回滚 ⇒ S2 红；
//   S3 若把 `setMember` 的错误也吞掉（过度解耦）⇒ S3 红；
//   S4 若不幂等 ⇒ S4 红（回调被调用 2 次）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { settleDecoupled, SETTLE_FAILED } from '../lib/engine/settle.js';

/** 内存 store（真语义：写后读回；可注入 setMember 异常）。 */
function memStore({ lanes = { e1: 'review' }, throwOnSetMember = null } = {}) {
  const state = { batchId: 'b-set', lanes: { ...lanes } };
  const calls = [];
  return {
    calls,
    state,
    readBatch: (sessionId, batchId) => (batchId === state.batchId ? { ...state, lanes: { ...state.lanes } } : null),
    setMember(sessionId, batchId, lane, status, note) {
      calls.push({ lane, status, note });
      if (throwOnSetMember) throw throwOnSetMember;
      state.lanes[lane] = status;
      return { ...state, lanes: { ...state.lanes } };
    },
  };
}

test('S1 结算成功（阳性对照）：stateAdvanced:true、settled:true、状态已推进', () => {
  const store = memStore();
  const r = settleDecoupled({ store, sessionId: 's', batchId: 'b-set', lane: 'e1', status: 'merged', settle: () => true });
  assert.equal(r.stateAdvanced, true);
  assert.equal(r.settled, true);
  assert.equal(r.settleError, undefined, '成功路径不得有 settleError');
  assert.equal(r.batch.lanes.e1, 'merged', '返回视图已推进');
  assert.equal(store.state.lanes.e1, 'merged', 'store 内部持久态也已推进（硬证据）');
});

test('S2【最关键】结算回调 throw ⇒ ①不抛 ②stateAdvanced:true ③视图 merged ④持久态 merged ⑤settleError 前缀 ⑥settled:false', () => {
  const store = memStore();
  let thrown = null;
  let r = null;
  try {
    r = settleDecoupled({
      store, sessionId: 's', batchId: 'b-set', lane: 'e1', status: 'merged',
      settle: () => { throw new Error('sink down'); },
    });
  } catch (e) { thrown = e; }
  assert.equal(thrown, null, '① 结算失败**绝不向上抛**（否则调用方看到一个已推进却被报错的状态）');
  assert.equal(r.stateAdvanced, true, '② 状态推进是事实：stateAdvanced 仍为 true');
  assert.equal(r.batch.lanes.e1, 'merged', '③ 返回视图里的 lane 态已是目标态');
  assert.equal(store.state.lanes.e1, 'merged', '④ **store 内部持久态也是 merged**（硬证据，不是只在返回值里）');
  assert.equal(String(r.settleError).startsWith(SETTLE_FAILED), true,
    '⑤ settleError 必须以 ' + SETTLE_FAILED + ' 开头；实际=' + r.settleError);
  assert.equal(String(r.settleError).includes('sink down'), true, '失败原因须可读（含原 message）');
  assert.equal(r.settled, false, '⑥ 结算确实没成功 ⇒ settled:false');
});

test('S3【防过度解耦】`setMember` 抛 GATE_MEMBER_REQUIRES_C ⇒ **照旧向上抛**', () => {
  const store = memStore({ throwOnSetMember: new Error('GATE_MEMBER_REQUIRES_C: e1') });
  assert.throws(
    () => settleDecoupled({ store, sessionId: 's', batchId: 'b-set', lane: 'e1', status: 'merged', settle: () => true }),
    /GATE_MEMBER_REQUIRES_C/,
    '**推进**失败必须冒泡（吞掉它 = 状态没推进却收到成功，比耦合更危险）',
  );
});

test('S4 幂等：同 tuple 两次 ⇒ 第二次 repeated:true 且结算回调**精确调用 1 次**', () => {
  const store = memStore();
  let settleCalls = 0;
  const settle = () => { settleCalls += 1; return true; };
  const first = settleDecoupled({ store, sessionId: 's', batchId: 'b-set', lane: 'e1', status: 'merged', settle });
  const second = settleDecoupled({ store, sessionId: 's', batchId: 'b-set', lane: 'e1', status: 'merged', settle });
  assert.equal(first.repeated, undefined, '首次不得标 repeated');
  assert.equal(second.repeated, true, '第二次必须标 repeated:true（已是目标态）');
  assert.equal(second.stateAdvanced, false, '重复路径不得再推进');
  assert.equal(settleCalls, 1, '结算回调必须**精确调用 1 次**（不是 <=1）；实际=' + settleCalls);
});

test('S5 未提供 settle（缺省）⇒ 视为未结算但状态推进（不因缺结算而停步）', () => {
  const store = memStore();
  const r = settleDecoupled({ store, sessionId: 's', batchId: 'b-set', lane: 'e1', status: 'merged' });
  assert.equal(r.stateAdvanced, true, '缺省 settle 也必须推进状态');
  assert.equal(r.settled, false, '未提供结算 ⇒ settled:false');
  assert.equal(store.state.lanes.e1, 'merged', '持久态已推进');
});
