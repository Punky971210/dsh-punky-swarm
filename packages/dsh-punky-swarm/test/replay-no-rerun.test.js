/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/replay-no-rerun.test.js —— **I-11 验收**：同一投递事件**不得重跑**（三态 ＋ 重放计数 ＋ 不可变）。
//
// 文件名按计划 T-cmd 原文（`node --test test/replay-no-rerun.test.js`）。
// 判据源：`plan/p1-pack.md` I-11 ＋ `e1-replay` handoff 断言基线。
//
// 可红形态：
//   R1 若「投递标记缺失」被当成「未投递 ⇒ 可重跑」⇒ 第三条（fail-closed）红；
//   R2 若重放不判 delivered ⇒ 计数变 2 ⇒ 重放计数「精确 1」红；
//   R3 若实现「一律不执行」⇒ 阳性对照（两个不同事件计数 2）红；
//   R4 若 markDelivered/markPending 原地改入参 ⇒ 不可变断言红。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  markDelivered, markPending, isDelivered, replayDecision, deliveryIdOf,
  DELIVERY_MARKER_MISSING, DELIVERY_PENDING, DELIVERY_DELIVERED, DELIVERY_MARKER_UNRECOGNIZED,
} from '../lib/engine/events.js';

const AT = 1_700_000_000_000;
const evt = (id, extra = {}) => ({ id, type: 'lane.wake', payload: { k: 1 }, ...extra });

test('I11-1 三态基线：delivered ⇒ 不重跑 / pending ⇒ 重跑 / 缺标记 ⇒ fail-closed 留痕 / 未知值 ⇒ 不猜测', () => {
  assert.deepEqual(replayDecision({ id: 'e-a', delivery: DELIVERY_DELIVERED }),
    { rerun: false, reason: 'already-delivered' }, '已投递 ⇒ {rerun:false, already-delivered}');
  assert.deepEqual(replayDecision({ id: 'e-b', delivery: DELIVERY_PENDING }), { rerun: true }, '待投递 ⇒ {rerun:true}');

  const missing = replayDecision({ id: 'e-c' });
  assert.equal(missing.rerun, false, '**缺 delivery 键不得重跑**（fail-closed：多跑一次有副作用的写补不回来）');
  assert.equal(String(missing.reason).startsWith(DELIVERY_MARKER_MISSING), true,
    '缺标记必须留痕（前缀 ' + DELIVERY_MARKER_MISSING + '）；实际=' + missing.reason);
  assert.equal(String(missing.reason).includes('e-c'), true, '留痕必须写明事件 id；实际=' + missing.reason);

  const unknown = replayDecision({ id: 'e-d', delivery: 'half-way' });
  assert.equal(unknown.rerun, false, '未知标记值不得重跑（不猜测）');
  assert.equal(String(unknown.reason).startsWith(DELIVERY_MARKER_UNRECOGNIZED), true,
    '未知值前缀必须为 ' + DELIVERY_MARKER_UNRECOGNIZED + '；实际=' + unknown.reason);
});

test('I11-2 重放计数**精确 1**：markPending ⇒ 首次 rerun ⇒ markDelivered ⇒ 重放两次均不 rerun', () => {
  let execCount = 0;
  const apply = (decision) => { if (decision.rerun) execCount += 1; return decision; };

  let e1 = markPending(evt('evt-1'));
  const first = apply(replayDecision(e1));
  assert.deepEqual(first, { rerun: true }, '首次（pending）必须重跑');
  assert.equal(execCount, 1, '首次执行计数 = 1');

  const e1Done = markDelivered(e1, AT);
  const second = apply(replayDecision(e1Done));
  const third = apply(replayDecision(e1Done));
  assert.deepEqual(second, { rerun: false, reason: 'already-delivered' }, '重放第一次必须不重跑');
  assert.deepEqual(third, { rerun: false, reason: 'already-delivered' }, '重放第二次必须不重跑');
  assert.equal(execCount, 1, '执行计数必须**精确 1**（不是 <=1）；实际=' + execCount);
});

test('I11-3 阳性对照（必写）：两个**不同**事件各 rerun ⇒ 计数 2（否则「一律不执行」也过）', () => {
  let execCount = 0;
  const apply = (d) => { if (d.rerun) execCount += 1; return d; };
  const a = markPending(evt('evt-A'));
  const b = markPending(evt('evt-B'));
  assert.deepEqual(apply(replayDecision(a)), { rerun: true });
  assert.deepEqual(apply(replayDecision(b)), { rerun: true });
  assert.equal(execCount, 2, '不同事件必须各自执行 ⇒ 计数 2；若实现「一律不执行」此处为 1 或 0 ⇒ 红');
});

test('I11-4 不可变：markDelivered/markPending 返回**新对象**，入参 JSON 前后逐字相同', () => {
  const src = evt('evt-imm');
  const before = JSON.stringify(src);
  const pending = markPending(src);
  assert.notEqual(pending, src, 'markPending 必须返回新对象（原地改会让同一事件两个视图给出两个结论）');
  assert.equal(JSON.stringify(src), before, 'markPending 不得改入参');
  const delivered = markDelivered(pending, AT);
  assert.notEqual(delivered, pending, 'markDelivered 必须返回新对象');
  assert.equal(JSON.stringify(src), before, 'markDelivered 不得改入参');
  assert.equal(isDelivered(delivered), true, '标记后 isDelivered 必须为 true');
  assert.equal(isDelivered(pending), false, '标记前 isDelivered 必须为 false');
});

test('I11-5 身份稳定：键序不同的同载荷 ⇒ 同一 delivery 身份；载荷变则异身份', () => {
  const a = { type: 'lane.wake', payload: { x: 1, y: 2 } };
  const b = { payload: { y: 2, x: 1 }, type: 'lane.wake' };
  assert.equal(deliveryIdOf(a), deliveryIdOf(b), '键序不同但载荷相同 ⇒ 同一身份（身份不得依赖键序）');
  const c = { type: 'lane.wake', payload: { x: 1, y: 3 } };
  assert.notEqual(deliveryIdOf(a), deliveryIdOf(c), '载荷变 ⇒ 身份必须变');
  assert.equal(typeof deliveryIdOf(a), 'string', '身份必须是字符串（禁引用地址/时间戳相关）');
});
