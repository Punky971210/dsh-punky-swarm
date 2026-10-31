/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/degrade-warns.test.js —— **S-4 可辨**：失败被降级时必须**留痕且可辨**，「真没有」必须**静默**。
//
// 判据源：`plan/p1-pack.md`（S-4a / S-4b）＋ `exec/e1-degrade.md`。
// 背景：这两处原先把「枚举失败」「单批读坏」压成「无批绑定」⇒ 静默失败（R3 的 MUST-FIX 同类）。
//   e1 的落地形态：`laneBindingOf(store, sessionId, logger)` 在两种失败上各给一条 warn，**正常空集零 warn**。
//
// ★ 判据 #34（否定判据必须配阳性对拍）：本文件每条「warn 应出现」都配一条「同构造但正常 ⇒ warn 0」，
//   否则「一律 warn」也能满足前者。
//
// 跑法（必须带 preload）：node --import ./test/helpers/isolated-home.preload.mjs --test test/degrade-warns.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { laneBindingOf } from '../lib/engine/dispatch.js';

/** 记录 warn 的假 logger。 */
function loggerOf() {
  const warns = [];
  return { warns, logger: { warn: (m) => warns.push(String(m)), info() {}, error() {}, debug() {} } };
}
const MAX_I = 'sess-worker';

/** 造一个 store：`listAllBatches` / `readBatch` 的行为可控。 */
function storeOf({ batches, readBatch }) {
  return {
    listAllBatches() {
      if (batches instanceof Error) throw batches;
      return batches;
    },
    readBatch: readBatch ?? (() => null),
  };
}
const dispatchEventOf = (lane, workerSessionId) => ({ type: 'member.dispatch', lane, workerSessionId });

test('S-4a 枚举失败 ⇒ warn 含 `batch-enum-failed:`（且返 null）＋ **正常空集 ⇒ 零 warn**（阳性对拍）', () => {
  // ① 失败态：listAllBatches 抛
  const h1 = loggerOf();
  const broken = storeOf({ batches: new Error('enumerate exploded') });
  assert.equal(laneBindingOf(broken, MAX_I, h1.logger), null, '枚举失败必须返 null（调用方仍按"无绑定"降级）');
  assert.equal(h1.warns.length > 0, true, '枚举失败**必须留痕**（原来是静默）');
  assert.equal(h1.warns.some((w) => w.includes('batch-enum-failed:')), true,
    'warn 必须带可辨前缀 batch-enum-failed:；实际=' + JSON.stringify(h1.warns));
  assert.equal(h1.warns.some((w) => w.includes('enumerate exploded')), true, 'warn 必须带宿主原错误（可诊断）');

  // ② 阳性对拍：枚举**成功但空集** ⇒ 同样返 null，但**零 warn**（否则无法区分「没有」与「坏了」）
  const h2 = loggerOf();
  assert.equal(laneBindingOf(storeOf({ batches: [] }), MAX_I, h2.logger), null, '空集也返 null');
  assert.deepEqual(h2.warns, [], '**正常空集不得 warn**（这是区分"没有"与"坏了"的另一半）');
});

test('S-4b 单批读坏 ⇒ warn 含 `batch-read-failed: <session>/<batch>` 且**继续**扫后续批（能绑到后面那批）', () => {
  const h = loggerOf();
  const batches = [{ sessionId: 's1', batchId: 'b1' }, { sessionId: 's2', batchId: 'b2' }];
  const readBatch = (sessionId, batchId) => {
    if (batchId === 'b1') throw new Error('corrupt json');
    if (batchId === 'b2') return { events: [dispatchEventOf('l2', MAX_I)] };
    return null;
  };
  const bind = laneBindingOf(storeOf({ batches, readBatch }), MAX_I, h.logger);
  assert.equal(bind?.batchId, 'b2', '单批读坏不得中断扫描（须绑到后面的批）');
  assert.equal(h.warns.some((w) => w.includes('batch-read-failed:') && w.includes('s1/b1')), true,
    'warn 必须点名坏掉的那一批（session/batch）；实际=' + JSON.stringify(h.warns));
  // 阳性对拍：同构造但坏批**不存在**（readBatch 返 null）⇒ 零 warn
  const h2 = loggerOf();
  const readBatch2 = (sessionId, batchId) => (batchId === 'b2' ? { events: [dispatchEventOf('l2', MAX_I)] } : null);
  const bind2 = laneBindingOf(storeOf({ batches, readBatch: readBatch2 }), MAX_I, h2.logger);
  assert.equal(bind2?.batchId, 'b2');
  assert.deepEqual(h2.warns, [], '**批不存在（返 null）不得 warn**（与"读坏"必须可辨）');
});

test('S-4c 未传 logger ⇒ 不抛（降级路径不得因缺少 logger 而炸）', () => {
  assert.doesNotThrow(() => laneBindingOf(storeOf({ batches: new Error('x') }), MAX_I), '无 logger 时枚举失败也只返 null');
  assert.equal(laneBindingOf(storeOf({ batches: new Error('x') }), MAX_I), null);
  // 正常路径无 logger 亦应正常绑定
  const ok = storeOf({ batches: [{ sessionId: 's', batchId: 'b' }], readBatch: () => ({ events: [dispatchEventOf('l1', MAX_I)] }) });
  assert.equal(laneBindingOf(ok, MAX_I)?.batchId, 'b', '无 logger 不影响正常绑定');
});

test('S-4d 命中判据不变（防"加 warn 顺带改了匹配语义"）：非本 session / 无 lane / 类型不符都不得绑定', () => {
  const h = loggerOf();
  const batches = [{ sessionId: 's', batchId: 'b' }];
  const readBatch = () => ({
    events: [
      { type: 'member.dispatch', lane: '', workerSessionId: MAX_I },        // 空 lane
      { type: 'member.dispatch', lane: 'l1', workerSessionId: 'other' },    // 别人
      { type: 'handoff_submitted', lane: 'l1', workerSessionId: MAX_I },    // 类型不对
    ],
  });
  assert.equal(laneBindingOf(storeOf({ batches, readBatch }), MAX_I, h.logger), null, '不匹配 ⇒ 返 null');
  assert.deepEqual(h.warns, [], '不匹配不是失败 ⇒ 零 warn');
});
