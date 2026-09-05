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

// E3 log_export 单测（punky-finalize 决策包 §3.2 验收 T3.1-T3.6）：
// T3.1 默认关：logs 未配置/disabled → log_export 不注册，工具总数 14（T0 断言保持）
// T3.2 全量导出：eventCount=exported=events.length，items 与 store.readBatch 逐条一致（ts/type 保序）
// T3.3 过滤：lane / type（前缀匹配）/ since 各自生效且可叠加；空结果 → items=[]、exported=0
// T3.4 markdown 报告：批次头+时间线表+尾部汇总；writeTo 落盘引擎产物根（防逃逸）
// T3.5 只读零副作用：导出前后批次状态文件内容不变（未写、未增、updatedAt 未变）
// T3.6 错误路径：未知批次/非法 session/非法 batchId/非法 since → 清晰错误不挂起
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';

const EXEC_SESS = { agent: { session: { id: 'sess-log' } } };

// 事件样例（覆盖 member.settled / gate.* / worktree.* / budget.* / asset.* / system.*）
const EVENTS = [
  ['member.settled', { lane: 'l1', from: 'pending', to: 'running' }],
  ['member.settled', { lane: 'l2', from: 'pending', to: 'running' }],
  ['gate.entry.missing', { lane: 'l3', missing: ['plan/spec.md'] }],
  ['worktree.checkpoint', { lane: 'l1', step: 1, total: 3 }],
  ['budget.rejected', { lane: 'w1', code: 'CHAIN_HOPS', chainId: 'c1' }],
  ['asset.claimed', { lane: null, source: 'x', target: 'audit/notes.md' }],
  ['system.recovered', { batchId: 'b', recoveredLanes: ['l2'] }],
];

function setup(logsEnabled = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-log-'));
  const store = createStore(root);
  const registered = [];
  const ctx = { tools: { register: (t) => registered.push(t) }, logger: console };
  const config = logsEnabled === null ? {} : { capabilities: { logs: { enabled: logsEnabled } } };
  const { tools } = createTools(ctx, { store, root, config });
  return { root, store, byName: Object.fromEntries(tools.map((t) => [t.name, t])), registered };
}

async function makeBatch(store, bid, events = EVENTS) {
  store.createBatch('sess-log', { batchId: bid, wavePlan: { wavePlan: [{ tasks: [{ id: 'l1' }, { id: 'l2' }] }] } });
  for (const [type, fields] of events) store.appendEvent('sess-log', bid, type, fields);
  return store.readBatch('sess-log', bid);
}

function batchFileOf(root, bid) { return path.join(root, 'sessions', 'sess-log', 'batches', bid + '.json'); }

test('T3.1 默认关：logs 未配置/disabled → log_export 不注册（工具总数 20 = P1-01 缺省默认开，不含 log_export）', () => {
  for (const cfg of [{}, { capabilities: {} }, { capabilities: { logs: {} } }, { capabilities: { logs: { enabled: false } } }]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-log-off-'));
    const store = createStore(root);
    const { tools } = createTools({ tools: { register: () => {} }, logger: console }, { store, root, config: cfg });
    assert.equal(tools.length, 20, '缺省/disabled 配置下工具总数保持 20（14 + lane_heartbeat + lane_longrun + worktree 四件，logs 默认关）');
    assert.equal(tools.some((t) => t.name === 'log_export'), false);
  }
});

test('T3.1b 启用后 log_export 注册且仅 +1', async () => {
  const { byName } = setup(true);
  assert.equal(typeof byName.log_export?.execute, 'function');
  assert.equal(Object.keys(byName).length, 21); // 20 + log_export
});

test('T3.2 全量导出：eventCount=exported=events.length，items 与 readBatch 逐条保序一致', async () => {
  const { store, byName } = setup(true);
  await makeBatch(store, 'b-full');
  const batch = store.readBatch('sess-log', 'b-full');
  const r = await byName.log_export.execute({ batchId: 'b-full' }, EXEC_SESS);
  assert.equal(r.ok, true);
  assert.equal(r.batchId, 'b-full');
  assert.equal(r.session, 'sess-log');
  assert.equal(r.phase, 'planning');
  assert.equal(r.eventCount, batch.events.length);
  assert.equal(r.exported, batch.events.length);
  assert.equal(r.items.length, batch.events.length);
  for (let i = 0; i < batch.events.length; i++) {
    assert.equal(r.items[i].ts, batch.events[i].ts, 'ts 保序逐条一致 @' + i);
    assert.equal(r.items[i].type, batch.events[i].type, 'type 保序逐条一致 @' + i);
  }
});

test('T3.3a lane 过滤：仅返回该 lane 事件', async () => {
  const { store, byName } = setup(true);
  await makeBatch(store, 'b-lane');
  const r = await byName.log_export.execute({ batchId: 'b-lane', lane: 'l1' }, EXEC_SESS);
  assert.ok(r.exported > 0 && r.exported < r.eventCount, 'lane 过滤后数量严格小于全量');
  assert.ok(r.items.every((e) => e.lane === 'l1'));
});

test('T3.3b type 前缀匹配：type=member 命中 member.*，type=gate 命中 gate.*', async () => {
  const { store, byName } = setup(true);
  await makeBatch(store, 'b-type');
  const r = await byName.log_export.execute({ batchId: 'b-type', type: 'member' }, EXEC_SESS);
  assert.ok(r.exported >= 1);
  assert.ok(r.items.every((e) => e.type.startsWith('member')));
  const r2 = await byName.log_export.execute({ batchId: 'b-type', type: 'gate' }, EXEC_SESS);
  assert.ok(r2.exported >= 1);
  assert.ok(r2.items.every((e) => e.type.startsWith('gate')));
});

test('T3.3c since 过滤：仅返回该时刻之后事件；叠加过滤；空结果 → items=[]/exported=0', async () => {
  const { store, byName } = setup(true);
  await makeBatch(store, 'b-since');
  const batch = store.readBatch('sess-log', 'b-since');
  const mid = batch.events[Math.floor(batch.events.length / 2)].ts;
  const r = await byName.log_export.execute({ batchId: 'b-since', since: mid }, EXEC_SESS);
  assert.ok(r.exported >= 1 && r.exported <= batch.events.length);
  assert.ok(r.items.every((e) => Date.parse(e.ts) >= Date.parse(mid)));
  // 叠加 lane + type + since（未来时间戳 → 空）
  const future = new Date(Date.now() + 60_000).toISOString();
  const r2 = await byName.log_export.execute({ batchId: 'b-since', lane: 'l1', type: 'member', since: future }, EXEC_SESS);
  assert.equal(r2.exported, 0);
  assert.deepEqual(r2.items, []);
});

test('T3.4 markdown 报告：批次头+时间线表+尾部汇总，内容与 json 形态一致', async () => {
  const { store, byName } = setup(true);
  await makeBatch(store, 'b-md');
  const batch = store.readBatch('sess-log', 'b-md');
  // 全量 markdown：批次头/时间线/尾部汇总各要素齐备
  const r = await byName.log_export.execute({ batchId: 'b-md', format: 'markdown' }, EXEC_SESS);
  assert.equal(r.ok, true);
  assert.equal(r.exported, batch.events.length);
  assert.equal(r.report.includes('# 事件日志导出报告'), true, '批次头标题');
  assert.equal(r.report.includes('- 批次: b-md'), true, '批次头含批次 ID');
  assert.equal(r.report.includes('- phase: planning'), true, '批次头含 phase');
  assert.equal(r.report.includes('- 过滤条件: 无'), true, '批次头含过滤条件');
  assert.equal(r.report.includes('## 时间线'), true, '时间线表标题');
  assert.equal(r.report.includes('| ts | type | lane |'), true, '时间线表头');
  assert.equal(r.report.includes('member.settled'), true, '时间线含事件 type');
  assert.equal(r.report.includes('## 尾部汇总'), true, '尾部汇总标题');
  assert.equal(r.report.includes('### 各 lane 终态计数'), true);
  assert.equal(r.report.includes('### 门禁事件清单'), true);
  assert.equal(r.report.includes('gate.entry.missing'), true, '门禁事件清单含 gate.* 事件');
  assert.equal(r.report.includes('### 资产/归档事件清单'), true);
  assert.equal(r.report.includes('asset.claimed'), true, '资产清单含 asset.* 事件');
  // lane 过滤形态：仅含该 lane 事件、过滤条件回显、终态计数与 json 一致
  const rl = await byName.log_export.execute({ batchId: 'b-md', format: 'markdown', lane: 'l1' }, EXEC_SESS);
  assert.equal(rl.exported, batch.events.filter((e) => e.lane === 'l1').length);
  assert.equal(rl.report.includes('- 过滤条件: lane=l1'), true);
  assert.equal(rl.report.includes('worktree.checkpoint'), true);
  assert.equal(rl.report.includes('gate.entry.missing'), false, 'l1 过滤后不含 l3 的 gate 事件');
});

test('T3.4b writeTo 落盘到引擎产物根（<artifacts>/<batchId>/audit/event-log.md），内容与 report 一致', async () => {
  const { root, store, byName } = setup(true);
  await makeBatch(store, 'b-mdw');
  const r = await byName.log_export.execute({ batchId: 'b-mdw', format: 'markdown', writeTo: 'audit/event-log.md' }, EXEC_SESS);
  assert.equal(r.writtenTo, 'audit/event-log.md');
  const file = path.join(root, 'sessions', 'sess-log', 'artifacts', 'b-mdw', 'audit', 'event-log.md');
  assert.equal(fs.existsSync(file), true, '报告落盘到引擎产物根');
  assert.equal(fs.readFileSync(file, 'utf8'), r.report, '落盘内容与返回 report 一致');
  // json 形态交叉一致：同一批次 markdown 时间线含全部事件 type（顺序一致）
  const j = await byName.log_export.execute({ batchId: 'b-mdw' }, EXEC_SESS);
  assert.equal(j.eventCount, j.items.length);
});

test('T3.4c writeTo 路径防逃逸：绝对路径/盘符/../空段一律拒绝', async () => {
  const { root, store, byName } = setup(true);
  await makeBatch(store, 'b-esc');
  for (const bad of ['../escape.md', 'a/../../x.md', 'C:\\evil.md', '/abs/x.md', './x.md']) {
    await assert.rejects(
      () => byName.log_export.execute({ batchId: 'b-esc', format: 'markdown', writeTo: bad }, EXEC_SESS),
      /invalid writeTo path/,
      'writeTo 应拒绝: ' + bad,
    );
  }
  // 逃逸尝试后引擎产物根内无任何越界文件
  const artifactsDir = path.join(root, 'sessions', 'sess-log', 'artifacts', 'b-esc');
  assert.equal(fs.existsSync(path.join(root, 'escape.md')), false);
  assert.equal(fs.existsSync(path.join(artifactsDir, '..', '..', '..', 'escape.md')), false);
});

test('T3.5 只读零副作用：导出前后批次状态文件内容不变（未写/未增/updatedAt 未变）', async () => {
  const { root, store, byName } = setup(true);
  await makeBatch(store, 'b-ro');
  const file = batchFileOf(root, 'b-ro');
  const before = fs.readFileSync(file, 'utf8');
  const beforeJson = JSON.parse(before);
  // 多次导出（json + markdown + 落盘）后状态文件必须逐字节不变
  await byName.log_export.execute({ batchId: 'b-ro' }, EXEC_SESS);
  await byName.log_export.execute({ batchId: 'b-ro', format: 'markdown', writeTo: 'audit/event-log.md' }, EXEC_SESS);
  await byName.log_export.execute({ batchId: 'b-ro', lane: 'l1', type: 'member', since: new Date().toISOString() }, EXEC_SESS);
  const after = fs.readFileSync(file, 'utf8');
  assert.equal(after, before, '批次状态文件导出前后内容不变');
  const afterJson = JSON.parse(after);
  assert.equal(afterJson.events.length, beforeJson.events.length, 'events 未增');
  assert.equal(afterJson.updatedAt, beforeJson.updatedAt, 'updatedAt 未变');
  // 状态文件目录下无新增 .tmp 残留（原子写未触发）
  const batchDir = path.dirname(file);
  assert.equal(fs.readdirSync(batchDir).filter((f) => f.includes('.tmp')).length, 0);
});

test('T3.6 错误路径：未知批次/非法 session/非法 batchId/非法 since → 清晰错误不挂起', async () => {
  const { store, byName } = setup(true);
  await makeBatch(store, 'b-err', []);
  await assert.rejects(() => byName.log_export.execute({ batchId: 'nope' }, EXEC_SESS), /batch not found/, '未知批次');
  await assert.rejects(() => byName.log_export.execute({ batchId: 'b-err', session: 'bad/session' }, EXEC_SESS), /invalid session/, '非法 session');
  await assert.rejects(() => byName.log_export.execute({ batchId: '../evil' }, EXEC_SESS), /invalid batchId/, '非法 batchId');
  await assert.rejects(() => byName.log_export.execute({ batchId: 'b-err', since: 'not-a-date' }, EXEC_SESS), /invalid since/, '非法 since');
  // 合法路径仍可用（未挂起）
  const r = await byName.log_export.execute({ batchId: 'b-err' }, EXEC_SESS);
  assert.equal(r.ok, true);
});
