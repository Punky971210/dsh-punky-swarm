/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/binding-mismatch.test.js —— **I-04 验收**：派发输入绑定（字面契约 ＋ 边界口径）。
//
// 文件名按计划 T-cmd 原文（`node --test test/binding-mismatch.test.js`）。
// 判据源：`plan/p1-pack.md` I-04 ＋ `e1-binding` handoff 断言基线（甲方案：判定抽到 `lib/verify/binding.js`）。
//
// 两层判据（`e1-binding` 的设计，两态都要测）：
//   · `bindingDecision`  = **字面契约**：严格比两个 id（`expected`/`actual`）；
//   · `dispatchBindingDecision` = **边界口径**：只有「**本批另一条 lane 的 worker 冒名**」才拒；
//     未派发（无绑定可核）与治理面（不是任何 lane 的 worker：Leader/owner/Manager）一律放行。
//
// 可红形态：
//   B1 若 `bindingDecision` 对 `expected:null` 返拒 ⇒ 首次调用被误杀 ⇒ B1 红；
//   B2 若 `dispatchBindingDecision` 把「治理面」也拒 ⇒ B2 红（正常结算会被误判为冒名）；
//   B3 若「另一 lane 的 worker 冒名」被放行 ⇒ B3 红（这是要拦的真身）；
//   B4 若拒因不含 expected/actual ⇒ 无法审计「谁被谁顶替」⇒ B4 红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bindingDecision, dispatchBindingDecision, expectedWorkerSessionOf, workerLanesOf, BINDING_MISMATCH,
} from '../lib/verify/binding.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');

/** 造一个「已派发两条 lane」的批视图（纯数据：`batch.events` 是唯一真源，见 `expectedWorkerSessionOf`）。 */
const batchOf = () => ({
  batchId: 'b-bind',
  lanes: { e1: 'running', a1: 'pending', e2: 'running' },
  events: [
    { type: 'member.dispatch', lane: 'e1', workerSessionId: 'sess-worker-e1' },
    { type: 'member.dispatch', lane: 'e2', workerSessionId: 'sess-worker-e2' },
  ],
});

test('B1 字面契约三态：expected:null ⇒ ok ／ 两侧相等 ⇒ ok ／ 不等 ⇒ 拒', () => {
  assert.deepEqual(bindingDecision({ expected: null, actual: 'sess-x' }), { ok: true },
    '**尚未派发（无绑定可核）必须放行** —— 否则首次调用被误杀');
  assert.deepEqual(bindingDecision({ expected: 'w1', actual: 'w1' }), { ok: true }, '两侧相等 ⇒ 放行');
  const bad = bindingDecision({ expected: 'w1', actual: 'w2' });
  assert.equal(bad.ok, false, '两侧不等 ⇒ 必须拒');
  assert.equal(String(bad.reason).startsWith(BINDING_MISMATCH), true,
    '拒因前缀必须为 ' + BINDING_MISMATCH + '；实际=' + bad.reason);
});

test('B2 边界：治理面调用（不是任何 lane 的 worker）⇒ **放行**（防把正常结算误判为冒名）', () => {
  const batch = batchOf();
  const r = dispatchBindingDecision({ batch, lane: 'e1', caller: 'sess-leader-or-owner', where: 'member_settle' });
  assert.equal(r.ok, true, 'Leader/owner/Manager 做的是治理动作，塞进绑定语义会让正常结算被误杀');
  assert.equal(r.expected, 'sess-worker-e1', '仍须回显期望 worker（可审计）');
  // 未派发的 lane ⇒ 无绑定可核 ⇒ 放行
  const notDispatched = dispatchBindingDecision({ batch, lane: 'a1', caller: 'sess-someone', where: 'x' });
  assert.deepEqual(notDispatched, { ok: true, expected: null }, '未派发 lane ⇒ 放行（不误拦）');
  // 本 lane 的 worker 本人 ⇒ 放行
  assert.equal(dispatchBindingDecision({ batch, lane: 'e1', caller: 'sess-worker-e1' }).ok, true, '本 lane worker ⇒ 放行');
});

test('B3 边界：**本批另一条 lane 的 worker 冒名** ⇒ 拒（唯一的真身）', () => {
  const batch = batchOf();
  const r = dispatchBindingDecision({ batch, lane: 'e1', caller: 'sess-worker-e2', where: 'member_settle' });
  assert.equal(r.ok, false, '另一 lane 的已登记 worker 顶替本条 lane ⇒ 必须拒');
  assert.equal(String(r.reason).startsWith(BINDING_MISMATCH), true, '拒因前缀；实际=' + r.reason);
  assert.equal(r.expected, 'sess-worker-e1', '必须回显期望 worker');
});

test('B4 拒因可审计：同时写明 expected 与 actual（两摘要，缺一不可定位顶替）', () => {
  const batch = batchOf();
  const r = dispatchBindingDecision({ batch, lane: 'e1', caller: 'sess-worker-e2', where: 'member_settle' });
  const reason = String(r.reason);
  assert.equal(reason.includes('sess-worker-e1'), true, '拒因必须含 expected；实际=' + reason);
  assert.equal(reason.includes('sess-worker-e2'), true, '拒因必须含 actual；实际=' + reason);
  assert.equal(reason.includes('member_settle'), true, '拒因必须含调用点（where）；实际=' + reason);
});

test('B5 真源是 `batch.events`：只读视图推导 expected/workerLanes，且只看**最近一次**派发', () => {
  const batch = {
    events: [
      { type: 'member.dispatch', lane: 'e1', workerSessionId: 'old-worker' },
      { type: 'member.status', lane: 'e1' },
      { type: 'member.dispatch', lane: 'e1', workerSessionId: 'new-worker' },
    ],
  };
  assert.equal(expectedWorkerSessionOf(batch, 'e1'), 'new-worker', '必须取**最近一次**派发（旧的不得再生效）');
  assert.deepEqual(workerLanesOf(batch, 'new-worker'), ['e1'], '该会话是 e1 的 worker');
  assert.deepEqual(workerLanesOf(batch, 'stranger'), [], '非 worker ⇒ 空集（⇒ 判为治理面放行）');
  assert.equal(expectedWorkerSessionOf(batch, 'nope'), null, '未派发 lane ⇒ null');
});

test('B6 单点落点：判定定义只在 `lib/verify/binding.js`，`member-tools`/`handoff-tools` 只接线', () => {
  const src = fs.readFileSync(path.join(PKG, 'lib', 'verify', 'binding.js'), 'utf8');
  assert.equal(/export function dispatchBindingDecision/.test(src), true, '边界判定必须导出（单点）');
  // 判定函数体内不得出现 store/写（判定是纯函数：拒绝才能发生在任何写之前）
  const body = src.slice(src.indexOf('export function dispatchBindingDecision'));
  assert.equal(/store\.|setMember|atomicWrite/.test(body.slice(0, 1200)), false,
    '判定体内不得触达 store/写盘（保证「拒在写之前」由构造成立，而非事后回滚）');
});
