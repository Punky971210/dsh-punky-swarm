/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// C4 mailbox 环防护单测（exec-budget lane）：B1-B6 验收标准
// 纯函数（budget.js / schema-v3.js）+ 状态入批次（store.js）+ 接线（mailbox-tools.js 集成）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkBudget, recordChain, chainFor, chainKey, CHAIN_MEMORY } from '../lib/comms/budget.js';
import { BATCH_SCHEMA_V3, migrateV2toV3 } from '../lib/state/schema-v3.js';
import { createStore } from '../lib/state/store.js';
import { createTools } from '../lib/tools/register.js';
import { readUnacked } from '../lib/comms/mailbox.js';

// ---------- B1/B2/B3：纯函数三拒绝码 ----------

test('B1: hop 超 maxChainHops → CHAIN_EXHAUSTED（code + 可行动文案）', () => {
  const r = checkBudget({ chain: { id: 'c1', hop: 5 } }, { chains: {} }, { maxChainHops: 4 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CHAIN_EXHAUSTED');
  assert.match(r.detail, /report to the leader/);
  // 边界：hop 恰好等于上限 → 放行
  const ok = checkBudget({ chain: { id: 'c1', hop: 4 } }, { chains: {} }, { maxChainHops: 4 });
  assert.equal(ok.ok, true);
  assert.equal(ok.chain.hop, 4);
});

test('B2: 同链同有序对往返 ≥ maxChainRoundTrips → PING_PONG', () => {
  let state = { chains: {}, order: [] };
  // 每次往返换文本（同文本会先触发 REPEATED_MESSAGE，往返测试用不同文本隔离两个判定维度）
  for (let i = 0; i < 2; i++) {
    const meta = { chain: { id: 'c1', hop: 1 }, from: 'worker-a', to: 'supervisor', text: 'm' + i };
    const c = checkBudget(meta, state, { maxChainRoundTrips: 2 });
    assert.equal(c.ok, true, 'round ' + (i + 1) + ' should pass');
    state = recordChain(state, { meta });
  }
  // 第 3 次同有序对（不同文本）→ 拒 PING_PONG
  const r = checkBudget({ chain: { id: 'c1', hop: 1 }, from: 'worker-a', to: 'supervisor', text: 'm2' }, state, { maxChainRoundTrips: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PING_PONG');
  assert.ok(state.chains.c1.edges[chainKey('worker-a', 'supervisor')] === 2);
});

test('B3: 同链同向同文本 → REPEATED_MESSAGE；跨链/新链同文本放行', () => {
  const meta = { chain: { id: 'c1', hop: 1 }, from: 'a', to: 'b', text: 'hello' };
  let state = recordChain({ chains: {}, order: [] }, { meta });
  // 同链同向同文本 → 拒
  const r = checkBudget(meta, state);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'REPEATED_MESSAGE');
  // 跨链（不同 chainId）同文本 → 放行
  const cross = checkBudget({ ...meta, chain: { id: 'c2', hop: 1 } }, state);
  assert.equal(cross.ok, true);
  // 新链（无 meta.chain）同文本 → 放行（向后兼容）
  const fresh = checkBudget({ from: 'a', to: 'b', text: 'hello' }, state);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.chain.hop, 0);
  // 同链不同文本 → 放行
  const diff = checkBudget({ ...meta, text: 'hello2' }, state);
  assert.equal(diff.ok, true);
});

test('chainFor：显式 meta.chain 继承 hop+1；无声明开新链 hop=0', () => {
  const c = chainFor({ chains: {} }, { meta: { chain: { id: 'x', hop: 2 } } });
  assert.deepEqual(c, { id: 'x', hop: 3 });
  const fresh = chainFor({ chains: {} }, { meta: {} });
  assert.equal(fresh.hop, 0);
  assert.ok(typeof fresh.id === 'string' && fresh.id.length > 0);
  const none = chainFor({ chains: {} }, {});
  assert.equal(none.hop, 0);
});

test('B6: CHAIN_MEMORY=64 裁剪（插入序，最旧链删除，batch JSON 不膨胀）', () => {
  let state = { chains: {}, order: [] };
  for (let i = 0; i < CHAIN_MEMORY + 6; i++) {
    state = recordChain(state, { meta: { chain: { id: 'c' + i, hop: 1 }, from: 'a', to: 'b', text: 'm' + i } });
  }
  assert.equal(state.order.length, CHAIN_MEMORY);
  assert.equal(Object.keys(state.chains).length, CHAIN_MEMORY);
  assert.ok(!state.chains.c0, '最旧链应被裁剪');
  assert.ok(state.chains['c' + (CHAIN_MEMORY + 5)], '最新链保留');
});

test('recordChain：edges 累计 + said 更新；幂等（同链重复记账叠加）', () => {
  let state = recordChain({ chains: {}, order: [] }, { meta: { chain: { id: 'c1', hop: 1 }, from: 'a', to: 'b', text: 't1' } });
  state = recordChain(state, { meta: { chain: { id: 'c1', hop: 2 }, from: 'a', to: 'b', text: 't2' } });
  assert.equal(state.chains.c1.edges[chainKey('a', 'b')], 2);
  assert.equal(state.chains.c1.said[chainKey('a', 'b')], 't2');
});

// ---------- B6：schema-v3 迁移幂等 ----------

test('B6: migrateV2toV3 补 chains 默认 + schema 升 3；幂等（v3 原样返回）', () => {
  const v2 = { schema: 2, batchId: 'b', lanes: { a: 'pending' } };
  const v3 = migrateV2toV3(v2);
  assert.equal(v3.schema, BATCH_SCHEMA_V3);
  assert.deepEqual(v3.chains, { chains: {}, order: [] });
  assert.equal(v3.batchId, 'b');
  assert.deepEqual(v3.lanes, { a: 'pending' }); // 其余字段保留
  // 幂等：已 v3 直接返回同一对象；已带 chains 保留
  assert.equal(migrateV2toV3(v3), v3);
  const withChains = { schema: 3, chains: { chains: { c: {} }, order: ['c'] } };
  assert.equal(migrateV2toV3(withChains), withChains);
  assert.throws(() => migrateV2toV3(null));
  assert.throws(() => migrateV2toV3([]));
});

// ---------- B6：chains 入批次状态（store.js） ----------

test('B6: createBatch 落 v3 批次（chains 默认初始化）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-budget-'));
  const store = createStore(root);
  const plan = { wavePlan: [{ tasks: [{ id: 'a' }] }] };
  const b = store.createBatch('s1', { batchId: 'b1', wavePlan: plan });
  assert.equal(b.schema, BATCH_SCHEMA_V3);
  assert.deepEqual(b.chains, { chains: {}, order: [] });
  assert.deepEqual(store.readChains('s1', 'b1'), { chains: {}, order: [] });
});

test('B6: updateChains 原子写 + v2 存量批次迁移落盘（schema 升 3 + chains 补全）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-budget2-'));
  const store = createStore(root);
  // 手工落一个 v2 批次（存量场景）
  const dir = path.join(root, 'sessions', 's1', 'batches');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({ schema: 2, batchId: 'old', phase: 'running', lanes: { a: 'pending' } }));
  // readChains 只读不落盘：v2 → 默认 chains
  assert.deepEqual(store.readChains('s1', 'old'), { chains: {}, order: [] });
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'old.json'), 'utf8'));
  assert.equal(onDisk.schema, 2, 'readChains 不应落盘迁移');
  // updateChains 落盘迁移：schema 升 3 + chains 写入
  const patch = { chains: { c1: { edges: { 'a→b': 1 }, said: {} } }, order: ['c1'] };
  store.updateChains('s1', 'old', patch);
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'old.json'), 'utf8'));
  assert.equal(after.schema, BATCH_SCHEMA_V3);
  assert.deepEqual(after.chains, patch);
  assert.equal(after.lanes.a, 'pending'); // 既有字段保留
  assert.deepEqual(store.readChains('s1', 'old'), patch);
  assert.throws(() => store.updateChains('s1', 'nope', patch));
});

test('B6: 恢复后链计数保留（recoverBatches 不丢 chains）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-budget3-'));
  const store = createStore(root);
  const plan = { wavePlan: [{ tasks: [{ id: 'a' }] }] };
  store.createBatch('s1', { batchId: 'b2', wavePlan: plan, phase: 'running' });
  store.setMember('s1', 'b2', 'a', 'running');
  const patch = { chains: { c1: { edges: { 'a→b': 1 }, said: { 'a→b': 't' } } }, order: ['c1'] };
  store.updateChains('s1', 'b2', patch);
  store.recoverBatches(); // 模拟进程重启：running→idle
  assert.equal(store.readBatch('s1', 'b2').lanes.a, 'idle');
  assert.deepEqual(store.readChains('s1', 'b2'), patch, 'recover 不应丢 chains');
});

// ---------- B4/B5：接线集成（mailbox-tools.js） ----------

const EXEC_SESS = { agent: { session: { id: 'sess-budget' } } };

function makeTools(config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-budget-tools-'));
  const store = createStore(root);
  const ctx = { tools: { register: () => {} }, logger: console };
  const { tools } = createTools(ctx, { store, root, config });
  return { root, store, byName: Object.fromEntries(tools.map((t) => [t.name, t])) };
}

async function makeBatch(store, byName, batchId) {
  await byName.wave_plan.execute({ batchId, tasks: [{ id: 'a' }] }, EXEC_SESS);
  await byName.batch_phase.execute({ batchId, phase: 'running' }, EXEC_SESS);
}

test('B4: inbox 永不受限（enabled=true 时重发同文本也不拒）', async () => {
  const { store, byName } = makeTools({ capabilities: { budget: { enabled: true } } });
  await makeBatch(store, byName, 'b-inbox');
  for (let i = 0; i < 5; i++) {
    const r = await byName.mailbox_send.execute(
      { batchId: 'b-inbox', box: 'inbox', message: { text: '同文本' }, meta: { chain: { id: 'c1', hop: i }, from: 'leader', to: 'worker-a' } },
      EXEC_SESS,
    );
    assert.equal(r.ok, true, 'inbox 第 ' + (i + 1) + ' 次不应被 budget 拒');
  }
  const b = store.readBatch('sess-budget', 'b-inbox');
  assert.ok(!b.events.some((e) => e.type === 'budget.rejected'), 'inbox 不应产生 budget.rejected');
});

test('B3 集成: outbox 同链同向同文本 → REPEATED_MESSAGE 拒 + budget.rejected 留痕；跨链放行', async () => {
  const { root, store, byName } = makeTools({ capabilities: { budget: { enabled: true } } });
  await makeBatch(store, byName, 'b-rpt');
  const base = { batchId: 'b-rpt', box: 'outbox', lane: 'a', message: { text: 'hello' } };
  const m1 = { ...base, meta: { chain: { id: 'c1', hop: 0 }, from: 'worker-a', to: 'supervisor' } };
  const r1 = await byName.mailbox_send.execute(m1, EXEC_SESS);
  assert.equal(r1.ok, true);
  // meta.chain 透传：已读消息的 meta.chain.hop=1（hop+1 继承）
  const unacked = readUnacked(path.join(root, 'sessions', 'sess-budget', 'mailbox', 'b-rpt'), { type: 'outbox', lane: 'a' });
  assert.equal(unacked[0].meta.chain.id, 'c1');
  assert.equal(unacked[0].meta.chain.hop, 1);
  // 同链同向同文本 → 拒
  const r2 = await byName.mailbox_send.execute(m1, EXEC_SESS);
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'REPEATED_MESSAGE');
  const b = store.readBatch('sess-budget', 'b-rpt');
  const ev = b.events.find((e) => e.type === 'budget.rejected');
  assert.ok(ev, 'budget.rejected 事件缺失');
  assert.equal(ev.code, 'REPEATED_MESSAGE');
  assert.equal(ev.lane, 'a');
  assert.equal(ev.chainId, 'c1');
  // 跨链（新 chainId）同文本 → 放行
  const r3 = await byName.mailbox_send.execute({ ...base, meta: { chain: { id: 'c2', hop: 0 }, from: 'worker-a', to: 'supervisor' } }, EXEC_SESS);
  assert.equal(r3.ok, true);
});

test('B2 集成: outbox 同链同有序对往返超限 → PING_PONG', async () => {
  const { store, byName } = makeTools({ capabilities: { budget: { enabled: true, maxChainRoundTrips: 2 } } });
  await makeBatch(store, byName, 'b-pp');
  const base = { batchId: 'b-pp', box: 'outbox', lane: 'a', meta: { chain: { id: 'c1', hop: 0 }, from: 'worker-a', to: 'supervisor' } };
  for (let i = 0; i < 2; i++) {
    const r = await byName.mailbox_send.execute({ ...base, message: { text: 'm' + i } }, EXEC_SESS);
    assert.equal(r.ok, true, '第 ' + (i + 1) + ' 次往返应放行');
  }
  const r3 = await byName.mailbox_send.execute({ ...base, message: { text: 'm2' } }, EXEC_SESS);
  assert.equal(r3.ok, false);
  assert.equal(r3.code, 'PING_PONG');
});

test('B5: enabled=false（显式关）→ 现有 mailbox 调用零感知（重发不被拒、无预算事件、meta 原样透传）', async () => {
  // P1-01 行为变更：budget 缺省默认开；零感知语义由显式 capabilities.budget.enabled=false 承担（旧「缺省关」为旧行为断言）
  const { root, store, byName } = makeTools({ capabilities: { budget: { enabled: false } } });
  await makeBatch(store, byName, 'b-off');
  const base = { batchId: 'b-off', box: 'outbox', lane: 'a', message: { text: 'hello' }, meta: { chain: { id: 'c1', hop: 0 } } };
  for (let i = 0; i < 3; i++) {
    const r = await byName.mailbox_send.execute(base, EXEC_SESS);
    assert.equal(r.ok, true, 'enabled=false 第 ' + (i + 1) + ' 次应放行（零感知）');
  }
  const b = store.readBatch('sess-budget', 'b-off');
  assert.ok(!b.events.some((e) => e.type === 'budget.rejected'), 'enabled=false 不应产生 budget.rejected');
  // meta 原样透传（不注入 chain）
  const unacked = readUnacked(path.join(root, 'sessions', 'sess-budget', 'mailbox', 'b-off'), { type: 'outbox', lane: 'a' });
  assert.deepEqual(unacked[0].meta, { chain: { id: 'c1', hop: 0 } });
  assert.equal(unacked.length, 3);
});
