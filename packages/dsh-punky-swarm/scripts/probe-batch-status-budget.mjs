/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// scripts/probe-batch-status-budget.mjs —— **A 项收益实测**：多批读面「读全部」vs「按 mtime 取最近 N」。
//
// 为什么要这个探针：`batch_status` 的 fallback 并集读面此前对每批都 `readBatch`（读全文 + JSON.parse），
//   成本随批数线性增长（真实引擎根 511 批实测 ~770ms）。本探针在**真实盘面**上对照两条路径的耗时，
//   给「770ms → ?ms」一个可复现读数，而不是靠估算。
//
// 只读：全程只 `statSync` / `readFileSync`，不建批、不写盘、不改任何批次状态。
//
// 跑法：
//   node scripts/probe-batch-status-budget.mjs                    # 缺省扫真实引擎根
//   node scripts/probe-batch-status-budget.mjs --root=<dir>       # 指定根
//   node scripts/probe-batch-status-budget.mjs --limit=100        # 换预算档位
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import { createTools } from '../lib/tools/register.js';

const argOf = (name, fallback) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const root = argOf('root', path.join(os.homedir(), '.dsh', 'punky-preset'));
const limit = Number(argOf('limit', '50'));

if (!fs.existsSync(root)) {
  console.error('[probe] root not found: ' + root + '（用 --root=<dir> 指定）');
  process.exit(2);
}
if (!Number.isInteger(limit) || limit < 0) {
  console.error('[probe] --limit 必须是非负整数；实得 ' + JSON.stringify(argOf('limit', '')));
  process.exit(2);
}

const store = createStore(root);
const all = store.listAllBatches();
const sessions = store.listSessions();
console.log('[probe] root=' + root);
console.log('[probe] sessions=' + sessions.length + ' batches=' + all.length + ' limit=' + (limit || '不限'));

/** 取中位数：单次读数受 Defender / 页缓存抖动影响，中位数比首次更耐噪。 */
const medianOf = (samples) => samples.slice().sort((a, b) => a - b)[Math.floor(samples.length / 2)];

// ① 旧路径：逐批 readBatch（= 改动前的 fallback 并集读面成本）
const oldSamples = [];
for (let i = 0; i < 3; i++) {
  const t0 = process.hrtime.bigint();
  let read = 0;
  for (const { sessionId, batchId } of all) {
    if (store.readBatch(sessionId, batchId)) read += 1;
  }
  oldSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
const oldMs = medianOf(oldSamples);

// ② 新路径：按 mtime 排序取前 N，只读这 N 批
const newSamples = [];
let newTotal = 0;
let newRead = 0;
const newOrder = [];
for (let i = 0; i < 3; i++) {
  const t0 = process.hrtime.bigint();
  const { total, items } = store.recentBatches({ limit });
  const projected = items.map(({ sessionId, batchId }) => store.readBatch(sessionId, batchId)).filter(Boolean);
  newSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  newTotal = total;
  newRead = projected.length;
  if (i === 0) newOrder.push(...items.slice(0, 5).map((x) => x.batchId));
}
const newMs = medianOf(newSamples);

// ③ 纯 stat 面成本（解释新路径为什么便宜：stat 与 readBatch 的单价差）
const statSamples = [];
for (let i = 0; i < 3; i++) {
  const t0 = process.hrtime.bigint();
  for (const { sessionId, batchId } of all) {
    try { fs.statSync(store.batchFile(sessionId, batchId)); } catch { /* 并发删除 ⇒ 读面宽容跳过 */ }
  }
  statSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
const statMs = medianOf(statSamples);

const perBatchOld = all.length ? oldMs / all.length : 0;
const perBatchStat = all.length ? statMs / all.length : 0;

console.log('[probe] 旧路径（逐批 readBatch） 中位 = ' + oldMs.toFixed(1) + 'ms  ('
  + perBatchOld.toFixed(2) + 'ms/批)');
console.log('[probe] 新路径（mtime + 前 N 批） 中位 = ' + newMs.toFixed(1) + 'ms  (读 ' + newRead
  + ' 批 / total=' + newTotal + ')');
console.log('[probe] 纯 stat 面              中位 = ' + statMs.toFixed(1) + 'ms  ('
  + perBatchStat.toFixed(2) + 'ms/批)');
console.log('[probe] 降幅 = ' + (oldMs > 0 ? (100 * (1 - newMs / oldMs)).toFixed(1) : 'n/a') + '%'
  + (perBatchStat > 0 ? '；stat 比 readBatch 快 ' + (perBatchOld / perBatchStat).toFixed(1) + '×' : ''));
console.log('[probe] 最近活跃前 5 = ' + JSON.stringify(newOrder));

// ④ 完整工具调用对照 —— 用户实际感知的是这一档（含 listProjection：每批 lanesState + smoke 判定）。
//    `limit: 0` 走「读全部 + 投影全部」= 改动前 fallback 并集读面的等价成本（只多付 stat 面）。
const ctx = { tools: { register() {}, guard() {} }, logger: { info() {}, warn() {}, error() {}, debug() {} } };
const { tools } = createTools(ctx, { store, root });
const batchStatus = tools.find((t) => t.name === 'batch_status');
const execSamples = async (args) => {
  const out = [];
  for (let i = 0; i < 3; i++) {
    const t0 = process.hrtime.bigint();
    await batchStatus.execute(args, {});
    out.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return medianOf(out);
};
const fullViewMs = await execSamples({ limit: 0 });
const budgetedMs = await execSamples({});
console.log('[probe] 工具调用 limit=0（全量投影） 中位 = ' + fullViewMs.toFixed(1) + 'ms');
console.log('[probe] 工具调用 缺省必填预算(50) 中位 = ' + budgetedMs.toFixed(1) + 'ms');
console.log('[probe] ⇒ 用户可感知降幅 = ' + (fullViewMs > 0 ? (100 * (1 - budgetedMs / fullViewMs)).toFixed(1) : 'n/a') + '%'
  + '（' + fullViewMs.toFixed(0) + 'ms → ' + budgetedMs.toFixed(0) + 'ms）');
