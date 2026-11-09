/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/session-fallback.test.js —— **MCP 面 batch_status 会话可见性**（判据源 `plan/coldstart-and-sessionfix.md` 组 B）
//
// 覆盖验收项：
//   · AC-9  回落来源单点化（`sessionOfResolved` 四态）+ 与 `sessionOf` 逐例相等 + `lib/tools/shared.js` 仍零 import
//   · AC-10 fallback ⇒ 全会话并集视图（每元素带**自身** `sessionId`、顶层 `sessionScope:'all'`、与单会话视图同一投影）
//   · AC-11 fallback 的分支边界（`batchId` 不走全会话、`ids` = 并集、`ids: []` ≡ 缺省、`view` 不参与列表读面）
//   · AC-12 显式会话零回归（`sessionScope:'session'`、只含该会话的批）
//   · AC-14 读盘成本登记（目录扫 = 1 + N_sessions、批读 = 命中批数）
//
// ⚠ 计数桩必须在**文件层**（patch `fs.readFileSync` / `fs.readdirSync`）：`readBatchMap` / `readBatch` 走 compose 期
//   捕获的闭包 ⇒ 用 store 方法代理会得到全 0（假读数）。本条与 `test/batch-read-map.test.js` 同一口径。
//
// 跑法（必须带 preload，否则读数作废）：
//   node --import ./test/helpers/isolated-home.preload.mjs --test test/session-fallback.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { createTools } from '../lib/tools/register.js';
import { sessionOf, sessionOfResolved } from '../lib/tools/shared.js';
import { tempRoot } from './helpers/gate-fixture.mjs';

const S1 = 'sess-fb-a';
const S2 = 'sess-fb-b';

/** 无调用方会话的 exec（MCP 直连形态：`invokeTool` 交宿主的 `{calls,signal}` ⇒ 工具侧 `exec.agent` 恒空）。 */
const EXEC_NO_AGENT = {};
/** 宿主内 agent 调用形态。 */
const execOfAgent = (sessionId) => ({ agent: { session: { id: sessionId } } });

/** 文件层计数桩：分别统计「批文件读 / 批目录扫 / 会话目录扫」。 */
async function withFsCounters(fn) {
  const orig = { readFileSync: fs.readFileSync, readdirSync: fs.readdirSync };
  const counts = { batchReads: 0, batchesDirScans: 0, sessionsDirScans: 0 };
  fs.readFileSync = function patchedReadFileSync(p, ...rest) {
    if (typeof p === 'string' && /[\\/]batches[\\/][^\\/]+\.json$/.test(p)) counts.batchReads += 1;
    return orig.readFileSync.call(this, p, ...rest);
  };
  fs.readdirSync = function patchedReaddirSync(p, ...rest) {
    if (typeof p === 'string' && /[\\/]batches$/.test(p)) counts.batchesDirScans += 1;
    if (typeof p === 'string' && /[\\/]sessions$/.test(p)) counts.sessionsDirScans += 1;
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

/** 两层床：两个会话各 1 批（AC-10 的「≥2 个会话各有批」构造）。真实写入口造批，禁裸 JSON。 */
function makeBed() {
  const root = tempRoot('punky-fb-');
  const store = createStore(root);
  const tasks = [
    { id: 'p1', layer: 'plan', consume: [], produce: ['plan/spec.md'], outputs: ['plan/spec.md'], cmd: 'survey' },
    { id: 'e1', layer: 'exec', consume: ['plan/spec.md'], produce: ['exec/e1.md'], outputs: ['exec/e1.md'], cmd: 'do', deps: [] },
    { id: 'a1', layer: 'audit', consume: ['plan/spec.md', 'exec/e1.md'], produce: ['audit/a1.md'], outputs: ['audit/a1.md'], cmd: 'review', deps: ['e1'] },
  ];
  const made = [];
  for (const [session, batchId] of [[S1, 'b-a1'], [S2, 'b-b1']]) {
    const plan = buildWavePlan({ batchId, team: 'software-team', tasks });
    store.createBatch(session, { batchId, wavePlan: plan, assembly: { auditLane: 'a1' } });
    made.push({ session, batchId });
  }
  const ctx = { tools: { register() {}, guard() {} }, logger: { info() {}, warn() {}, error() {}, debug() {} } };
  const { tools } = createTools(ctx, { store, root });
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { root, store, by, made };
}

// ══ AC-9 ═══════════════════════════════════════════════════════════════════════════════

test('AC-9 回落来源四态：arg / bound / agent / fallback，且与 sessionOf 逐例相等', () => {
  // `bound` 桩：只认 exec.__bound（真实实现是 dispatch 绑定查表，这里只验**判定序**）
  const boundOf = (exec) => exec?.__bound ?? null;
  const cases = [
    { name: 'arg（args.session 非空 ⇒ 首行短路）', args: { session: 'arg-s' }, exec: { __bound: 'bound-s', agent: { session: { id: 'agent-s' } } }, want: { sessionId: 'arg-s', source: 'arg' } },
    { name: 'bound（无 arg ⇒ resolveBatchSession 命中）', args: {}, exec: { __bound: 'bound-s', agent: { session: { id: 'agent-s' } } }, want: { sessionId: 'bound-s', source: 'bound' } },
    { name: 'agent（无 arg/绑定 ⇒ exec.agent.session.id）', args: {}, exec: { agent: { session: { id: 'agent-s' } } }, want: { sessionId: 'agent-s', source: 'agent' } },
    { name: 'fallback（三者皆无 ⇒ 哨兵 cli）', args: {}, exec: {}, want: { sessionId: 'cli', source: 'fallback' } },
  ];
  for (const c of cases) {
    const got = sessionOfResolved(c.args, c.exec, boundOf);
    assert.deepEqual(got, c.want, c.name + '：来源/会话判定不符（实际 ' + JSON.stringify(got) + '）');
    assert.equal(sessionOf(c.args, c.exec, boundOf), c.want.sessionId,
      c.name + '：`sessionOf` 必须与 `sessionOfResolved(...).sessionId` 逐例相等');
  }
  // 边界：agent.session.id 是空串 ⇒ 既有 `?? 'cli'` 语义**不回落**（零行为变化），两函数仍相等。
  const emptyId = { agent: { session: { id: '' } } };
  assert.equal(sessionOf({}, emptyId, boundOf), '', '空串 id 不触发 cli 回落（?? 语义逐字保留）');
  assert.equal(sessionOf({}, emptyId, boundOf), sessionOfResolved({}, emptyId, boundOf).sessionId, '两函数在边界输入上仍相等');
});

test('AC-9 红线：lib/tools/shared.js 仍零 import（防循环依赖）', () => {
  const src = fs.readFileSync(new URL('../lib/tools/shared.js', import.meta.url), 'utf8');
  assert.equal(/^\s*import\s/m.test(src), false, '零依赖红线：本文件不得出现 import 语句');
  assert.equal(/\brequire\s*\(/.test(src), false, '零依赖红线：本文件不得出现 require()');
});

// ══ AC-10 ═════════════════════════════════════════════════════════════════════════════

test('AC-10 fallback ⇒ 全会话并集视图（sessionScope:all / 每元素带自身 sessionId / 与单会话视图同一投影）', async () => {
  const bed = makeBed();
  const view = await bed.by.batch_status.execute({}, EXEC_NO_AGENT);
  assert.equal(view.sessionScope, 'all', '无调用方会话 ⇒ 顶层 sessionScope 必须是 all（唯一判别位）');
  assert.equal(Array.isArray(view.batches), true);
  assert.equal(view.batches.length, bed.made.length, '两个会话各 1 批 ⇒ 两条都必须在结果里（并集，不是替换）');
  const byId = Object.fromEntries(view.batches.map((b) => [b.batchId, b]));
  for (const { session, batchId } of bed.made) {
    assert.ok(byId[batchId], '并集缺批 ' + batchId);
    assert.equal(byId[batchId].sessionId, session, batchId + '：元素必须带**自身所属会话**（不是 cli 哨兵）');
  }
  // 同一投影：并集元素与该批在**单会话视图**里的元素逐字段深等（禁止第二套投影）
  const single = await bed.by.batch_status.execute({ session: S1 }, execOfAgent(S1));
  assert.equal(single.sessionScope, 'session');
  const fromSingle = single.batches.find((b) => b.batchId === 'b-a1');
  assert.deepEqual(byId['b-a1'], fromSingle, '并集元素与单会话视图元素必须逐字段相等（同一投影）');
});

// ══ AC-11 ═════════════════════════════════════════════════════════════════════════════

test('AC-11 ① fallback + batchId ⇒ **不走全会话**（单批语义，错误文案逐字 `batch not found: <id> @cli`）', async () => {
  const bed = makeBed();
  // (a) 完全不存在的 id：错误文案逐字保持
  const ghost = await withFsCounters(async () => {
    await assert.rejects(
      () => bed.by.batch_status.execute({ batchId: 'ghost-batch' }, EXEC_NO_AGENT),
      (e) => {
        assert.equal(e.message, 'batch not found: ghost-batch @cli', '错误文案必须逐字保持（含 @cli 哨兵）');
        return true;
      },
      '找不到的单批必须抛错（不得回落成全会话探测）',
    );
  });
  assert.equal(ghost.counts.sessionsDirScans, 0, 'batchId 分支不得扫会话目录（否则把 typing 错误放大成跨会话存在性探测）');
  assert.equal(ghost.counts.batchesDirScans, 0, 'batchId 分支不得扫批目录（单批原生路径）');

  // (b) ★ 最锋利的形态：id **真实存在于另一个会话**（b-b1@S2）时仍必须 `@cli` 找不到
  //     —— 这正是「不得按 batchId 反查会话」的反向锁（方案 C 本批不做）。
  await assert.rejects(
    () => bed.by.batch_status.execute({ batchId: 'b-b1' }, EXEC_NO_AGENT),
    (e) => {
      assert.equal(e.message, 'batch not found: b-b1 @cli', '存在于别的会话的 id 也必须报 @cli 找不到（禁按 id 反查会话）');
      return true;
    },
  );
});

test('AC-11 ② fallback 下 `ids` = 全会话并集；`ids: []` ≡ 缺省（列全部）', async () => {
  const bed = makeBed();
  const one = await bed.by.batch_status.execute({ ids: ['b-b1'] }, EXEC_NO_AGENT);
  assert.equal(one.sessionScope, 'all');
  assert.deepEqual(one.batches.map((b) => b.batchId), ['b-b1'], 'ids 必须在**全部会话**里筛（b-b1 属于另一会话）');
  assert.equal(one.batches[0].sessionId, S2, '并集筛出后仍带该批自身会话');

  const both = await bed.by.batch_status.execute({ ids: ['b-a1', 'b-b1'] }, EXEC_NO_AGENT);
  assert.deepEqual(both.batches.map((b) => b.batchId).sort(), ['b-a1', 'b-b1'], '两会话的 id 必须都能被筛到');

  const empty = await bed.by.batch_status.execute({ ids: [] }, EXEC_NO_AGENT);
  const bare = await bed.by.batch_status.execute({}, EXEC_NO_AGENT);
  assert.deepEqual(empty, bare, '`ids: []` 必须与不传 ids 逐字相同（列全部，而非空结果）');
});

test('AC-11 ③ fallback 列表模式下 `view` 不生效（多批列表读面不含 wavePlan，与既有口径一致）', async () => {
  const bed = makeBed();
  const full = await bed.by.batch_status.execute({}, EXEC_NO_AGENT);
  const active = await bed.by.batch_status.execute({ view: 'active' }, EXEC_NO_AGENT);
  assert.deepEqual(active, full, '列表读面的 view 裁剪必须零差异（返回体逐字一致）');
  for (const b of active.batches) {
    assert.equal('wavePlan' in b, false, b.batchId + '：多批列表投影不得携带 wavePlan');
    assert.equal('viewApplied' in b, false, b.batchId + '：列表投影不回显 viewApplied');
  }
});

// ══ AC-12 ═════════════════════════════════════════════════════════════════════════════

test('AC-12 显式/绑定会话零回归：`sessionScope:session` 且只含该会话的批', async () => {
  const bed = makeBed();
  const explicit = await bed.by.batch_status.execute({ session: S2 }, EXEC_NO_AGENT);
  assert.equal(explicit.sessionScope, 'session', '显式 session ⇒ sessionScope 必须是 session（两态都在，可判别）');
  assert.equal(explicit.sessionId, S2, '显式 session 仍是**首行短路**的最高优先级');
  assert.deepEqual(explicit.batches.map((b) => b.batchId), ['b-b1'], '显式会话只列该会话的批（不是并集）');

  const viaAgent = await bed.by.batch_status.execute({}, execOfAgent(S1));
  assert.equal(viaAgent.sessionScope, 'session', 'agent 会话路径同样回落为 session 语义');
  assert.deepEqual(viaAgent.batches.map((b) => b.batchId), ['b-a1'], 'agent 路径只列该会话的批');

  const single = await bed.by.batch_status.execute({ batchId: 'b-a1' }, execOfAgent(S1));
  assert.equal(single.sessionScope, 'session', '单批形态同样回显 sessionScope:session');
  assert.equal(single.batchId, 'b-a1');
});

// ══ AC-15 ═════════════════════════════════════════════════════════════════════════════

test('AC-15 契约面：`sessionScope` 已进 output.schema（additionalProperties:false），fallback/单批视图逐键合法', async () => {
  const bed = makeBed();
  const tool = bed.by.batch_status;
  const schema = tool.output?.schema ?? tool.output;
  assert.equal(schema.additionalProperties, false, 'batch_status 输出 schema 是 additionalProperties:false ⇒ 新键不进 schema 即真机被拒');
  assert.ok('sessionScope' in (schema.properties ?? {}), '`sessionScope` 必须进 output.schema.properties（不加即拒）');
  assert.match(String(tool.description ?? ''), /未解析到调用方会话/, 'description 必须写明「未解析到调用方会话（如 MCP 直连）⇒ 列全部会话」');
  assert.match(String(tool.description ?? ''), /显式 session 仍优先/, 'description 必须声明显式 session 的优先级不变');
  const untouched = (val) => Object.keys(val).filter((k) => !(k in (schema.properties ?? {})));
  const all = await bed.by.batch_status.execute({}, EXEC_NO_AGENT);
  assert.deepEqual(untouched(all), [], 'fallback 并集视图不得出现 schema 未声明的键（实际多余键：' + untouched(all).join(',') + '）');
  const single = await bed.by.batch_status.execute({ batchId: 'b-a1' }, execOfAgent(S1));
  assert.deepEqual(untouched(single), [], '单批视图不得出现 schema 未声明的键（实际多余键：' + untouched(single).join(',') + '）');
  const list = await bed.by.batch_status.execute({}, execOfAgent(S1));
  assert.deepEqual(untouched(list), [], '单会话列表视图不得出现 schema 未声明的键');
});

// ══ AC-14 ═════════════════════════════════════════════════════════════════════════════

test('AC-14 fallback 全会话视图读盘成本：目录扫 = 1 + 2×N_sessions，批读 = 命中批数', async () => {
  const bed = makeBed();
  const { counts } = await withFsCounters(() => bed.by.batch_status.execute({}, EXEC_NO_AGENT));
  const nSessions = 2;
  // ⚠ 实测口径（**与 plan 预估的 `1 + N` 差 N**，已登记进产物 notice 的「口径变化登记」）：
  //   · `listSessions()` 内部对**每个** session 调一次 `readdirSync(batchesDirOf(s))`（存在性 + 有 ≥1 json 的判据）；
  //   · `listAllBatches()` 随后又调 `listBatches(s)` ⇒ **同一个批目录被扫第二次**。
  //   ⇒ sessions 目录 1 次 + 批目录 2×N 次。量级仍是 O(N)，无批文件读放大。
  assert.equal(counts.sessionsDirScans, 1, 'sessions/ 目录只扫一次（实测 ' + JSON.stringify(counts) + '）');
  assert.equal(counts.batchesDirScans, 2 * nSessions, '每个命中会话的 batches/ 被扫 2 次（listSessions 判据 + listBatches）');
  assert.equal(counts.sessionsDirScans + counts.batchesDirScans, 1 + 2 * nSessions, '目录扫合计 = 1 + 2×N_sessions');
  assert.equal(counts.batchReads, bed.made.length, '批读 = 命中批数（并集视图的必要成本，不是放大）');
});
