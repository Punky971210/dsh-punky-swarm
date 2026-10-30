/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/batch-read-map.test.js —— **QT-2a 验收**：批级批量读面（`store.readBatchMap`）的读盘次数与结果一致性。
//
// 判据源：`plan/p1-pack.md` QT-2a ＋ `e1-batchread` 实测三档。
// ⚠ **计数桩必须在文件层**（patch `fs.readFileSync` / `fs.readdirSync`）：
//   `readBatchMap` 内部调的是 compose 期捕获的**闭包** `readBatch` ⇒ 用 store 方法代理会得到全 0（假读数）。
// ⚠ 真实收益口径（Leader 已裁）：`ids≥2` 时**目录扫 = 0**；N 次批读是返回 N 份内容的必要成本，不算放大。
//
// 跑法（必须带 preload，否则读数作废）：
//   node --import ./test/helpers/isolated-home.preload.mjs --test test/batch-read-map.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { createTools } from '../lib/tools/register.js';
import { tempRoot } from './helpers/gate-fixture.mjs';

const S = 'sess-q2a';

/** 文件层计数桩：只统计「批目录相关」的调用，避免把无关读盘混进来。 */
async function withFsCounters(fn) {
  const orig = { readFileSync: fs.readFileSync, readdirSync: fs.readdirSync };
  const counts = { batchReads: 0, dirScans: 0 };
  fs.readFileSync = function patchedReadFileSync(p, ...rest) {
    if (typeof p === 'string' && /[\\/]batches[\\/][^\\/]+\.json$/.test(p)) counts.batchReads += 1;
    return orig.readFileSync.call(this, p, ...rest);
  };
  fs.readdirSync = function patchedReaddirSync(p, ...rest) {
    if (typeof p === 'string' && /[\\/]batches$/.test(p)) counts.dirScans += 1;
    return orig.readdirSync.call(this, p, ...rest);
  };
  try {
    const out = await fn(counts);
    return { out, counts };
  } finally {
    fs.readFileSync = orig.readFileSync;
    fs.readdirSync = orig.readdirSync;
  }
}

/** 真实写入口造批（照 `test/api-batch-keys.test.js` 的 makeBatch 形态；**禁裸 JSON 造批**）。 */
function makeBed(laneIds = ['e1', 'e2', 'e3']) {
  const root = tempRoot('punky-q2a-');
  const store = createStore(root);
  const tasks = [
    {
      id: 'p1', layer: 'plan', consume: [], produce: ['plan/spec.md'], outputs: ['plan/spec.md'], cmd: 'survey',
    },
    ...laneIds.map((id) => ({
      id, layer: 'exec', consume: ['plan/spec.md'], produce: ['exec/' + id + '.md'], outputs: ['exec/' + id + '.md'], cmd: 'do', deps: [],
    })),
    {
      id: 'a1', layer: 'audit', consume: ['plan/spec.md', ...laneIds.map((i) => 'exec/' + i + '.md')],
      produce: ['audit/a1.md'], outputs: ['audit/a1.md'], cmd: 'review', deps: laneIds,
    },
  ];
  const batches = [];
  for (const batchId of ['b-one', 'b-two', 'b-three']) {
    const plan = buildWavePlan({ batchId, team: 'software-team', tasks });
    store.createBatch(S, { batchId, wavePlan: plan, assembly: { auditLane: 'a1', managerPlan: 'leader-direct' } });
    batches.push(batchId);
  }
  const ctx = { tools: { register() {}, guard() {} }, logger: { info() {}, warn() {}, error() {}, debug() {} } };
  const { tools } = createTools(ctx, { store, root });
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  const EXEC = { agent: { session: { id: S } } };
  return { root, store, by, EXEC, batches };
}

test('Q2A-1 `ids` 缺省 ⇒ 批读 3 / 目录扫 1（列全部必经一次目录扫）', async () => {
  const bed = makeBed();
  const { counts } = await withFsCounters(() => bed.by.batch_status.execute({ session: S }, bed.EXEC));
  assert.deepEqual(counts, { batchReads: 3, dirScans: 1 }, '缺省路径：批读 3 次、目录扫 1 次；实际=' + JSON.stringify(counts));
});

test('Q2A-2 ★`ids≥2`（3 件）⇒ **目录扫 0**（真实收益就在这里）', async () => {
  const bed = makeBed();
  const ids = bed.batches;
  const { out, counts } = await withFsCounters(() => bed.by.batch_status.execute({ ids, session: S }, bed.EXEC));
  assert.equal(counts.dirScans, 0, '**目录扫必须为 0**（省掉 listBatches 的目录扫 = 本项收益）；实际=' + JSON.stringify(counts));
  assert.equal(counts.batchReads, 3, '3 件 id ⇒ 3 次批读（返回 3 份内容的必要成本，不算放大）');
  assert.equal(Array.isArray(out.batches), true, '多批分支返回 batches 数组');
});

test('Q2A-3 `ids=1` ⇒ 透传单批（批读 1 / 目录扫 0）', async () => {
  const bed = makeBed();
  const { counts } = await withFsCounters(() => bed.by.batch_status.execute({ ids: [bed.batches[0]], session: S }, bed.EXEC));
  assert.deepEqual(counts, { batchReads: 1, dirScans: 0 }, '1 件 id ⇒ 批读 1、目录扫 0；实际=' + JSON.stringify(counts));
});

test('Q2A-4 口径 A：`ids: []` ⇒ **等同缺省（列全部）**，不是空结果', async () => {
  const bed = makeBed();
  const empty = await bed.by.batch_status.execute({ ids: [], session: S }, bed.EXEC);
  const bare = await bed.by.batch_status.execute({ session: S }, bed.EXEC);
  assert.deepEqual(empty, bare, '空数组必须与不传 ids **逐字相同**（列全部，而非空结果）');
  assert.equal(Array.isArray(empty.batches) && empty.batches.length > 0, true, '空数组仍须列出全部批（非空结果）');
});

test('Q2A-5 口径 B：`ids` 与 `batchId` 同给 ⇒ **batchId 优先**（单批语义）', async () => {
  const bed = makeBed();
  const { out, counts } = await withFsCounters(() => bed.by.batch_status.execute(
    { batchId: bed.batches[1], ids: bed.batches, session: S }, bed.EXEC,
  ));
  assert.equal(counts.batchReads, 1, 'batchId 优先 ⇒ 只读该批（不会把 ids 也读一遍）');
  assert.equal(counts.dirScans, 0, '单批路径不扫目录');
  assert.equal(out.batchId, bed.batches[1], '返回的是 batchId 指定那批');
  assert.equal(out.batches, undefined, '单批语义下不得同时返回 batches 数组（形状互斥）');
});

test('Q2A-6 单批 `batchId` 仍走单批原生路径（批读 1 / 目录扫 0）', async () => {
  const bed = makeBed();
  const { counts } = await withFsCounters(() => bed.by.batch_status.execute({ batchId: bed.batches[2], session: S }, bed.EXEC));
  assert.deepEqual(counts, { batchReads: 1, dirScans: 0 }, '单批不得退化为「列全部再挑一个」；实际=' + JSON.stringify(counts));
});

test('Q2A-7 批量结果与逐批结果**逐字段相等**（批量元素是「投影」，非"另一份数据"）', async () => {
  const bed = makeBed();
  const viaMap = await bed.by.batch_status.execute({ ids: bed.batches, session: S }, bed.EXEC);
  const perBatch = await Promise.all(bed.batches.map((id) => bed.by.batch_status.execute({ batchId: id, session: S }, bed.EXEC)));
  const indexed = Object.fromEntries(viaMap.batches.map((b) => [b.batchId, b]));
  for (const one of perBatch) {
    const projected = indexed[one.batchId];
    assert.ok(projected, '批量结果缺 ' + one.batchId);
    // ⚠ 实测契约：批量元素是单批结果的**精简投影**（不带 wavePlan/事件等重面），不是单批结果的全集。
    //   ⇒ 判据不是「整对象 deepEqual」（那会红且属误判），而是：
    //   ① 键集**逐键⊆**单批键集（不得凭空造字段）；② 每个在场键的值**逐字段深等**（不得两套真源）。
    for (const k of Object.keys(projected)) {
      assert.ok(k in one, one.batchId + '：批量元素出现单批里不存在的键 ' + k + '（形状漂移）');
      assert.deepEqual(projected[k], one[k], one.batchId + '.' + k + '：批量与单批必须逐字段相等（同一真源）');
    }
    // ③ 投影确实省掉了重面（这是批量读便宜的原因，也是它不能替代单批的依据）
    assert.equal('wavePlan' in projected, false, one.batchId + '：批量投影不得携带 wavePlan（重面）');
    assert.equal('recentEvents' in projected, false, one.batchId + '：批量投影不得携带 recentEvents（重面）');
  }
});
