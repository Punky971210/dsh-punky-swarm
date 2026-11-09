/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/batch-status-limit.test.js —— **A 项验收**：多批读面的「最近活跃排序 + limit 预算」。
//
// 判据源：`batch_status` 的 `limit` / `total` / `limitApplied` 三字段契约（见 query-tools.js 参数说明）。
// 关键纪律：
//   · **裁剪必须可见** —— `total` 恒为裁剪前总数、`limitApplied` 回显生效上限（0=未裁剪）；
//     否则「盘上 511 批」与「只返回 50 批」会被读成同一件事（与单批 `viewApplied` 同一纪律）。
//   · **显式点名不受限** —— `ids` / `batchId` 是用户点名，裁剪会把「我要的这几件」静默变成其中一部分。
//   · 排序用批文件 mtime（读面成本：stat ~0.1ms/批 vs readBatch ~1.73ms/批），
//     本测试用 `fs.utimesSync` **显式钉死 mtime**，不依赖真实时钟（同毫秒创建也能判序）。
//
// 跑法（必须带 preload）：
//   node --import ./test/helpers/isolated-home.preload.mjs --test test/batch-status-limit.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { createTools } from '../lib/tools/register.js';
import { tempRoot } from './helpers/gate-fixture.mjs';

const S = 'sess-limit';
const LEADER_SESSION = 'session-leader-limit';

const TASKS = [
  { id: 'p1', layer: 'plan', consume: [], produce: ['plan/spec.md'], outputs: ['plan/spec.md'], cmd: 'survey' },
  { id: 'e1', layer: 'exec', consume: ['plan/spec.md'], produce: ['exec/e1.md'], outputs: ['exec/e1.md'], cmd: 'do', deps: [] },
  { id: 'a1', layer: 'audit', consume: ['plan/spec.md', 'exec/e1.md'], produce: ['audit/a1.md'], outputs: ['audit/a1.md'], cmd: 'review', deps: ['e1'] },
];

/** 真实写入口造批（照 `test/batch-read-map.test.js` 的 makeBed 形态；**禁裸 JSON 造批**）。 */
function makeBed(count) {
  const root = tempRoot('punky-limit-');
  const store = createStore(root);
  const ids = [];
  for (let i = 1; i <= count; i++) {
    const batchId = 'b-' + String(i).padStart(2, '0');
    const plan = buildWavePlan({ batchId, team: 'software-team', tasks: TASKS });
    store.createBatch(S, { batchId, wavePlan: plan, assembly: { auditLane: 'a1' } });
    ids.push(batchId);
  }
  const ctx = { tools: { register() {}, guard() {} }, logger: { info() {}, warn() {}, error() {}, debug() {} } };
  const { tools } = createTools(ctx, { store, root });
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  // `source==='agent'` 路径（宿主内调用）⇒ 单会话读面；`source==='fallback'` 路径（无调用方会话）⇒ 全会话并集。
  const agentExec = { agent: { session: { id: S } } };
  const fallbackExec = {};
  return { root, store, by, ids, agentExec, fallbackExec };
}

/** 把某批的批文件 mtime 钉到「N 分钟前」——排序判据可复算，不依赖创建顺序与时钟精度。 */
function pinMtimeMinutesAgo(store, sessionId, batchId, minutesAgo) {
  const t = new Date(Date.now() - minutesAgo * 60_000);
  fs.utimesSync(store.batchFile(sessionId, batchId), t, t);
}

test('L-1 `recentBatches` 按 mtime 降序 + `total` 恒为裁剪前总数（store 层）', () => {
  const bed = makeBed(4);
  // 越老的批 mtime 越早 ⇒ 期望顺序由新到老，与创建顺序**刻意相反**
  pinMtimeMinutesAgo(bed.store, S, 'b-01', 40);
  pinMtimeMinutesAgo(bed.store, S, 'b-02', 30);
  pinMtimeMinutesAgo(bed.store, S, 'b-03', 20);
  pinMtimeMinutesAgo(bed.store, S, 'b-04', 10);
  const all = bed.store.recentBatches({ sessionId: S });
  assert.deepEqual(all.items.map((x) => x.batchId), ['b-04', 'b-03', 'b-02', 'b-01'], '必须按 mtime 降序（最近活跃在前）');
  assert.equal(all.total, 4, 'limit 未给 ⇒ total 仍为盘上批数、items 不截断');

  // 往回钉一批 ⇒ 顺序随盘面变（证明不是按 id / 创建序排的假排序）
  pinMtimeMinutesAgo(bed.store, S, 'b-01', 0);
  const reordered = bed.store.recentBatches({ sessionId: S });
  assert.deepEqual(reordered.items.map((x) => x.batchId), ['b-01', 'b-04', 'b-03', 'b-02'], '刚落盘过的批必须排最前（mtime 就是活跃度）');
});

test('L-2 `limit` 截断 items、但 `total` 不截断（裁剪可见）', () => {
  const bed = makeBed(6);
  const cut = bed.store.recentBatches({ sessionId: S, limit: 2 });
  assert.equal(cut.items.length, 2, 'limit=2 ⇒ items 只给 2 件');
  assert.equal(cut.total, 6, 'total 必须是裁剪前总数（否则「6 件」会被读成「2 件」）');

  const zero = bed.store.recentBatches({ sessionId: S, limit: 0 });
  assert.equal(zero.items.length, 6, 'limit=0 ⇒ 不限（显式的「我全要」）');
  assert.equal(zero.total, 6);

  const bogus = bed.store.recentBatches({ sessionId: S, limit: -3 });
  assert.equal(bogus.items.length, 6, '负数 limit 不得当成「截断成 0 件」⇒ 按不限处理');
});

test('L-3 缺省 limit=50：55 批只回 50 件且 total=55（工具读面 + 单会话）', async () => {
  const bed = makeBed(55);
  const out = await bed.by.batch_status.execute({ session: S }, bed.agentExec);
  assert.equal(out.batches.length, 50, '缺省预算 = 50 件（MCP 直连不传 limit 时的默认值）');
  assert.equal(out.total, 55, 'total 必须是盘上真实批数（裁剪不得掩盖全量）');
  assert.equal(out.limitApplied, 50, 'limitApplied 回显生效上限（裁剪可见的唯一判别位）');
  assert.equal(out.sessionScope, 'session', '单会话读面语义不变');
});

test('L-4 `limit: 0` ⇒ 全量回显、`limitApplied: 0`（未裁剪）', async () => {
  const bed = makeBed(55);
  const out = await bed.by.batch_status.execute({ session: S, limit: 0 }, bed.agentExec);
  assert.equal(out.batches.length, 55, 'limit=0 ⇒ 不截断');
  assert.equal(out.total, 55);
  assert.equal(out.limitApplied, 0, '0 表示未裁剪（与「截断成 0 件」可判别）');
});

test('L-5 非法 limit 的两道口：负整数回落缺省 50、非整数由宿主拒 `INVALID_ARGS`（都不静默变「不限」）', async () => {
  const bed = makeBed(55);
  // ① 负整数（宿主参数校验放行 ⇒ 到引擎）⇒ 回落缺省预算，不得当成「截断成 0 件」或「不限」
  const neg = await bed.by.batch_status.execute({ session: S, limit: -1 }, bed.agentExec);
  assert.equal(neg.limitApplied, 50, '负整数 limit 必须回落缺省 50（不得静默按不限处理）');
  assert.equal(neg.total, 55, '回落不影响 total');

  // ② 非整数在宿主参数校验层就被拒（到不了引擎）——这是既有契约，本项只锁「它确实发生」，
  //    防止将来把 `limit` 改成 `json` 类型时静默丢掉了这道口（那样非法值会被当成不限，冒充全量）。
  for (const bad of [1.5, '20', null, {}, []]) {
    await assert.rejects(
      () => bed.by.batch_status.execute({ session: S, limit: bad }, bed.agentExec),
      (e) => e?.code === 'INVALID_ARGS',
      '非整数 limit（' + JSON.stringify(bad) + '）必须由宿主参数校验拒绝（INVALID_ARGS）',
    );
  }
});

test('L-6 显式 `ids` 点名**不受 limit 约束**（点名即全给，不得静默丢结果）', async () => {
  const bed = makeBed(55);
  const ids = bed.ids.slice(0, 55);
  const out = await bed.by.batch_status.execute({ ids, session: S, limit: 3 }, bed.agentExec);
  assert.equal(out.batches.length, 55, 'ids 给了 55 件 ⇒ 必须回 55 件（limit 只约束「列全部」）');
  assert.equal(out.limitApplied, 0, 'ids 路径未裁剪 ⇒ limitApplied 必须是 0');
  assert.deepEqual(out.batches.map((b) => b.batchId).sort(), ids, '返回的 id 集合必须与点名集合逐元素一致');
});

test('L-7 全会话并集（fallback）同样受 limit 约束，且 `limitApplied` 参与回显', async () => {
  // 第二个会话：证明并集读面也走同一条 limit/total 通路（不是只有单会话加了预算）
  const root = tempRoot('punky-limit-all-');
  const store = createStore(root);
  const plan = buildWavePlan({ batchId: 'b-other', team: 'software-team', tasks: TASKS });
  store.createBatch(S, { batchId: 'b-other', wavePlan: plan, assembly: { auditLane: 'a1' } });
  const ctx = { tools: { register() {}, guard() {} }, logger: { info() {}, warn() {}, error() {}, debug() {} } };
  const { tools } = createTools(ctx, { store, root });
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));

  const out = await by.batch_status.execute({ limit: 1 }, {});
  assert.equal(out.sessionScope, 'all', '无调用方会话 ⇒ 并集读面');
  assert.equal(out.batches.length, 1, 'limit=1 ⇒ 并集只回 1 件（最近活跃的那件）');
  assert.equal(out.total, 1, 'total = 并集候选总数（本例盘上 1 批）');
  assert.equal(out.limitApplied, 1);

  const all = await by.batch_status.execute({ limit: 0 }, {});
  assert.equal(all.batches.length, 1, 'limit=0 ⇒ 并集全量');
  assert.equal(all.limitApplied, 0);
});

test('L-8 多批读面 render 与 schema：裁剪时显示 `N/总 (最近活跃, limit=K)`，未裁剪时只显示 N', async () => {
  const bed = makeBed(55);
  const schema = bed.by.batch_status.output?.schema ?? bed.by.batch_status.output;
  const props = schema?.properties ?? {};
  assert.ok('total' in props, '`total` 必须进 output.schema.properties（additionalProperties:false，不加即被丢）');
  assert.ok('limitApplied' in props, '`limitApplied` 必须进 output.schema.properties');

  const clipped = await bed.by.batch_status.execute({ session: S }, bed.agentExec);
  const clippedText = bed.by.batch_status.output.render({}, clipped)[0].text;
  assert.match(clippedText, /^batches: 50\/55 \(最近活跃, limit=50\)/, '裁剪态 render 必须同时给出「回了几件 / 盘上几件 / 生效上限」；实际=' + clippedText);

  const full = await bed.by.batch_status.execute({ session: S, limit: 0 }, bed.agentExec);
  const fullText = bed.by.batch_status.output.render({}, full)[0].text;
  assert.match(fullText, /^batches: 55(\s|$)/, '未裁剪时不得画蛇添足（只报 N，不写 /总数）；实际=' + fullText);
});
