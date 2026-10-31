/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/apply-dispatch-index-timing.test.js —— **S-1 时序**：轨迹桥必须**取用传入索引**、**不自扫**。
//
// 背景（`e2` 的诚实登记）：`rebuildDispatchIndex()` 上移到轨迹挂载之前，但「时序对」原先**只由代码阅读保证**。
// 时序类改动靠读码不够 —— 顺序写对了也可能被「回落自扫」掩盖。
//
// ⚠ 判据 #34（否定判据必须配阳性对拍）：本文件用**两条互补断言**钉住，缺一条都不够：
//   ② **结果**：装配后 `trajectory.mapping()` 非空（真实批事件驱动）—— 证明索引被用上了；
//   ③ **未自扫**：轨迹挂载期间对批文件的 `readBatch` **增量 = 0**，全流程本批 `readBatch` **精确 1 次**
//      （= 重建器 1 次 + 轨迹 0 次；若轨迹自扫则为 2）—— **确定性计数，不是计时**。
//
// ⚠ **未覆盖（如实登记）**：lead 要的第三条「`installTrajectoryBridge` **收到的那个** `dispatchIndex` 非空」
//   本轮**做不到**：`createDispatchIndexRebuilder` 是 `lib/index.js:565` 的**模块私有常量**（未导出），
//   真 `apply()` 装配需要完整宿主桩（tools/webServer/subagents/agentTeams/systemPrompt…），本轮时间窗内未完成。
//   ⇒ 该条**留作 gap**，不得据本条结论声称「时序端到端已验」。
//
// 跑法（必须带 preload）：node --import ./test/helpers/isolated-home.preload.mjs --test test/apply-dispatch-index-timing.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { createTrajectoryBridge } from '../lib/bridge/trajectory.js';
import { tempRoot } from './helpers/gate-fixture.mjs';

const SESS = 'sess-t1-timing';
const BATCH = 'b-t1-timing';

/** 真批 + 一条 `member.dispatch`（轨迹映射的唯一输入）+ 产物种子（entry 门无碍）。 */
function seed() {
  const root = tempRoot('punky-t1-timing-');
  const store = createStore(root);
  store.createBatch(SESS, {
    batchId: BATCH,
    wavePlan: buildWavePlan({
      batchId: BATCH,
      tasks: [
        { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], outputs: ['plan/spec.md'] },
        { id: 'e1', layer: 'exec', consume: ['plan/spec.md'], produce: ['exec/e1.md'], outputs: ['exec/e1.md'], deps: ['p1'] },
        { id: 'a1', layer: 'audit', consume: ['plan/spec.md', 'exec/e1.md'], produce: ['audit/a1.md'], outputs: ['audit/a1.md'], deps: ['e1'] },
      ],
    }),
    assembly: { auditLane: 'a1', managerPlan: 'leader-direct' },
  });
  store.appendEvent(SESS, BATCH, 'member.dispatch', { lane: 'e1', workerSessionId: 'sess-worker-t1' });
  const dir = path.join(root, 'sessions', SESS, 'artifacts', BATCH);
  fs.mkdirSync(path.join(dir, 'plan'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plan', 'spec.md'), '# 规格夹具\n', 'utf8');
  return { root, store };
}

/** 读侧索引重建（与 `lib/index.js:570-588` 同构；此处**只为构造前置态**，不作为被测对象）。 */
function seedIndexFrom(store, dispatchIndex) {
  for (const { sessionId, batchId } of store.listAllBatches()) {
    const batch = store.readBatch(sessionId, batchId);
    for (const ev of batch?.events ?? []) {
      if (ev.type === 'member.dispatch' && ev.workerSessionId && ev.lane) {
        dispatchIndex.set(ev.workerSessionId, { sessionId, batchId, lane: ev.lane });
      }
    }
  }
  return dispatchIndex.size;
}

test('S-1a 轨迹桥取用传入索引：映射非空（真实事件驱动）', async () => {
  const { root, store } = seed();
  const dispatchIndex = new Map();
  const size = seedIndexFrom(store, dispatchIndex);
  assert.equal(size > 0, true, '前置：索引已按事件建好（size=' + size + '）');

  const ctx = { logger: { warn() {}, info() {}, error() {}, debug() {} }, on: () => () => {}, tools: { register() {} } };
  const bridge = createTrajectoryBridge(ctx, { ctx, config: { capabilities: { trajectory: { enabled: true } } }, store, dispatchIndex });
  if (typeof bridge?.start === 'function') await bridge.start();
  const mapping = bridge?.mapping?.();
  const mapSize = mapping instanceof Map ? mapping.size : (mapping && typeof mapping === 'object' ? Object.keys(mapping).length : -1);
  assert.equal(mapSize > 0, true,
    '装配后轨迹映射必须非空（空 = 索引没被用上 ⇒ 行为降级）；实际=' + mapSize);
  bridge?.stop?.();
  void root;
});

test('S-1b 轨迹桥**不自扫**：挂载期间批文件 `readBatch` 增量 = 0；全流程本批精确 1 次（确定性计数）', () => {
  const { root, store } = seed();
  const dispatchIndex = new Map();
  const reads = [];
  const realReadBatch = store.readBatch.bind(store);
  store.readBatch = (sessionId, batchId) => {
    if (sessionId === SESS && batchId === BATCH) reads.push(1);
    return realReadBatch(sessionId, batchId);
  };

  seedIndexFrom(store, dispatchIndex);          // 重建阶段：本批读 1 次
  const beforeMount = reads.length;
  assert.equal(beforeMount, 1, '前置：索引重建对本批读 1 次；实际=' + beforeMount);

  const ctx = { logger: { warn() {}, info() {}, error() {}, debug() {} }, on: () => () => {}, tools: { register() {} } };
  const bridge = createTrajectoryBridge(ctx, { ctx, config: { capabilities: { trajectory: { enabled: true } } }, store, dispatchIndex });
  const afterMount = reads.length;

  // ③ 挂载期间**零读批**（若轨迹自扫，此处必然 > 0）
  assert.equal(afterMount - beforeMount, 0,
    '轨迹桥挂载**不得自扫批文件**（应取用传入索引）；实际新增读批=' + (afterMount - beforeMount));
  // 全流程：重建 1 + 轨迹 0 = 精确 1（变 2 即自扫）
  assert.equal(reads.length, 1, '本批 readBatch 全流程精确 1 次（= 重建 1 + 轨迹 0）；实际=' + reads.length);
  // 阳性对拍：同一 store 再重建一次 ⇒ 计数变 2（证明计数桩**真的在数**，不是恒 1）
  seedIndexFrom(store, dispatchIndex);
  assert.equal(reads.length, 2, '再次重建 ⇒ 计数必须 +1（证明上面的"1"是真读数，不是桩失效）');
  bridge?.stop?.();
  void root;
});
