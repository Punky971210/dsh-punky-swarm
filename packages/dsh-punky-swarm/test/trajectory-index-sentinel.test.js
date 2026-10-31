/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/trajectory-index-sentinel.test.js —— **U-a 哨兵取证**：轨迹桥**真的收到并取用**装配期的 `dispatchIndex`。
//
// 为什么需要这一条：`installTrajectoryBridge` 是 `lib/index.js:396` 的 **const（未导出）**，所以「时序上移后
//   传入的索引非空」原先只能靠读码保证。路径：它内部用**已导出**的 `createTrajectoryBridge`
//   （`lib/bridge/trajectory.js:41 export function`），并把 `dispatchIndex` 传进去 ⇒ 测试可**直走导出入口**
//   注入哨兵，断言「桥收到的就是同一个 Map 引用」＋「能从哨兵解出 lane」。
//
// ★ 为什么不能只断「映射非空」（判据 #34）：`lib/index.js:267` 有**兜底回填**路径 —— 映射非空可能是兜底
//   满足的，看不出装配期索引是否真的被用上。故本文件用**哨兵值**（只有注入才会出现）＋ **(b) 反证**
//   （让兜底依赖的 `listAllBatches`/`readBatch` **全部抛错**，仍能解析到 ⇒ 只能来自索引）。
//
// 跑法（必须带 preload）：node --import ./test/helpers/isolated-home.preload.mjs --test test/trajectory-index-sentinel.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrajectoryBridge } from '../lib/bridge/trajectory.js';

const SENTINEL_WORKER = 'sess-worker-sentinel';
const SENTINEL_LANE = 'l-sentinel';
const SENTINEL_ENTRY = Object.freeze({ sessionId: 's1', batchId: 'b1', lane: SENTINEL_LANE });

const TRAJ_CFG = Object.freeze({ capabilities: { trajectory: { enabled: true } } });
const ctxStub = () => ({ logger: { warn() {}, info() {}, error() {}, debug() {} }, on: () => () => {} });

/** 空桩 store：**任何**批读都抛（用于 (b) 反证：逼兜底自扫失效）。 */
const explodingStore = () => ({
  listAllBatches() { throw new Error('listAllBatches exploded（反证：兜底不可用）'); },
  readBatch() { throw new Error('readBatch exploded（反证：兜底不可用）'); },
});

/** 空桩 store：正常但无批（不干扰哨兵解析）。 */
const emptyStore = () => ({ listAllBatches: () => [], readBatch: () => null });

/** 取桥的映射（对外只暴露 `mapping()`；兼容 Map 与普通对象两种返回）。 */
function mappingOf(bridge) {
  assert.equal(typeof bridge?.mapping, 'function', '前置：桥必须暴露 mapping()');
  const m = bridge.mapping();
  if (m instanceof Map) return m;
  assert.ok(m && typeof m === 'object', 'mapping() 必须返回 Map 或对象；实际=' + typeof m);
  return new Map(Object.entries(m));
}

test('U-a 哨兵：桥收到的就是**同一个 Map 引用**（仍含哨兵），且能从哨兵解出 lane', async () => {
  const sentinel = new Map([[SENTINEL_WORKER, SENTINEL_ENTRY]]);
  const bridge = createTrajectoryBridge(ctxStub(), {
    store: emptyStore(), config: TRAJ_CFG, mailbox: null, dispatchIndex: sentinel,
  });

  if (typeof bridge.start === 'function') await bridge.start(); // 映射在 start() 内由 rebuildFromEvents 建立

  // ① 同一 Map 引用仍含哨兵（**引用未被替换/清空**）
  assert.equal(sentinel.size, 1, '传入的 dispatchIndex 引用必须仍含哨兵（未被 clear/替换）；实际 size=' + sentinel.size);
  assert.deepEqual(sentinel.get(SENTINEL_WORKER), SENTINEL_ENTRY, '哨兵条目必须原样留在传入的 Map 里');

  // ② 桥能把哨兵解析成 lane（映射取自传入索引，而不是重建出来的东西）
  const map = mappingOf(bridge);
  const hit = map.get(SENTINEL_WORKER);
  assert.ok(hit, '桥的映射必须包含哨兵 worker（否则说明索引没被取用）；实际 keys=' + JSON.stringify([...map.keys()]));
  assert.equal(hit.lane, SENTINEL_LANE, '哨兵必须能解出 lane；实际=' + JSON.stringify(hit));

  bridge.stop?.();
});

test('U-a(b) 反证：兜底的 listAllBatches/readBatch **全抛**仍能解出哨兵 ⇒ 解析只能来自索引', async () => {
  const sentinel = new Map([[SENTINEL_WORKER, SENTINEL_ENTRY]]);
  let threw = null;
  let bridge = null;
  try {
    bridge = createTrajectoryBridge(ctxStub(), {
      store: explodingStore(), config: TRAJ_CFG, mailbox: null, dispatchIndex: sentinel,
    });
  } catch (e) { threw = e; }

  if (bridge && typeof bridge.start === 'function') { try { await bridge.start(); } catch { /* 兜底全抛时 start 可能抛，属预期 */ } }
  assert.equal(threw, null, '兜底不可用不得导致建桥失败（索引路径必须自足）；错误=' + String(threw?.message ?? ''));
  const map = mappingOf(bridge);
  assert.equal(map.size > 0, true, '兜底全抛时映射仍须非空（来自索引）');
  assert.deepEqual(map.get(SENTINEL_WORKER), SENTINEL_ENTRY,
    '兜底失效后仍解出哨兵 ⇒ **只能来自传入索引**（排除了「兜底自扫满足」这一解释）');
  bridge.stop?.();
});

test('U-a(c) 阳性对拍：**不给** dispatchIndex 且兜底可用但为空 ⇒ 无哨兵可解（证明上文判据不是恒真）', async () => {
  // 【判据 #34/#35 · 恒真断言清除 · 2026-10-31】原版用 explodingStore，并在 `bridge === null` 时
  //   `assert.ok(true, …)` 静默放行 ⇒ 该分支**零鉴别力**：「建桥直接失败」既可能是预期也可能是缺陷，
  //   两者无法区分，而用例照样绿（且被基线 tautology 扫描点名）。本用例的真正目的是证明
  //   「**不注入索引 ⇒ 哨兵不会凭空出现**」，前提是**能观测到映射**。
  //   ⇒ 改用 emptyStore（兜底可用但无批）：桥必可建 ⇒ 断言的否定面可被真实观测；
  //   若建桥在本输入下反而抛错，则测试自然变红（这本身就是要暴露的信号，不得再被 try/catch 吞掉）。
  const bridge = createTrajectoryBridge(ctxStub(), {
    store: emptyStore(), config: TRAJ_CFG, mailbox: null, dispatchIndex: null,
  });
  if (typeof bridge.start === 'function') await bridge.start();
  const map = mappingOf(bridge);
  assert.equal(map.has(SENTINEL_WORKER), false, '**没有注入索引 ⇒ 不得凭空出现哨兵**（否则上文各条判据无鉴别力）');
  bridge.stop?.();
});
