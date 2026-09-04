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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-tools-'));
const store = createStore(root);
const registered = [];
const ctx = { tools: { register: (t) => registered.push(t) }, logger: console };
const { tools } = createTools(ctx, { store, root });
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

const EXEC_SESS = { agent: { session: { id: 'sess-leader' } } };

// P1-01 缺省默认开：core 11 + mailbox 3 + lane_heartbeat + lane_longrun + worktree 四件 = 20（logs 缺省关，log_export 不在内）
const DEFAULT_TOOL_COUNT = 20;

test('all 20 tools registered（P1-01 缺省默认开）', () => {
  assert.equal(tools.length, DEFAULT_TOOL_COUNT);
  for (const n of ['wave_plan', 'batch_phase', 'batch_status', 'assign_check', 'asset_claim', 'gate_status', 'artifact_types', 'lane_claim', 'lane_release', 'member_status', 'member_settle', 'mailbox_send', 'mailbox_read', 'mailbox_ack', 'lane_heartbeat', 'lane_longrun', 'lane_worktree_create', 'lane_worktree_merge', 'lane_checkpoint', 'lane_checkpoint_status']) {
    assert.ok(byName[n], 'missing tool ' + n);
  }
});

test('aip.enabled 缺省默认开启：无 config 时 register() 后 catalog 非空（20 描述，readCapability 默认合并）', () => {
  const reg = [];
  const ctxA = { tools: { register: (t) => reg.push(t) }, logger: console };
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-aip-'));
  const storeA = createStore(rootA);
  const t = createTools(ctxA, { store: storeA, root: rootA }); // 缺省 config（无 aip 键）
  assert.equal(t.catalog, null); // register() 前恒 null（懒生成）
  t.register();
  assert.ok(t.catalog, '缺省配置必须实际默认开启（catalog 非空）');
  assert.equal(t.catalog.list().length, DEFAULT_TOOL_COUNT); // 20 工具 6 属性描述齐备
  assert.equal(reg.length, DEFAULT_TOOL_COUNT); // 工具注册数与 catalog 一致（P1-01 缺省默认开）
});

test('aip.enabled=false 显式关闭：register() 后 catalog 恒 null（/tools 不注册）', () => {
  const reg = [];
  const ctxB = { tools: { register: (t) => reg.push(t) }, logger: console };
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-aip2-'));
  const storeB = createStore(rootB);
  const t = createTools(ctxB, { store: storeB, root: rootB, config: { aip: { enabled: false } } });
  t.register();
  assert.equal(t.catalog, null);
});

test('full flow binds to exec session; args.session overrides', async () => {
  const w = await byName.wave_plan.execute({
    batchId: 'b-demo',
    tasks: [
      { id: 't1', cmd: 'analyze' },
      { id: 't2', cmd: 'build', deps: ['t1'] },
    ],
    concurrency: 3,
  }, EXEC_SESS);
  assert.equal(w.wavePlan.length, 2);
  assert.equal(w.sessionId, 'sess-leader');
  assert.deepEqual(w.lanes, { t1: 'pending', t2: 'pending' });

  assert.deepEqual((await byName.batch_phase.execute({ batchId: 'b-demo', phase: 'running' }, EXEC_SESS)).phase, 'running');

  const claim = await byName.lane_claim.execute({ batchId: 'b-demo', lane: 't1' }, EXEC_SESS);
  assert.equal(claim.ok, true);
  const conflict = await byName.lane_claim.execute({ batchId: 'b-demo', lane: 't1' }, EXEC_SESS);
  assert.equal(conflict.ok, false);
  assert.equal((await byName.lane_release.execute({ batchId: 'b-demo', lane: 't1', token: claim.token }, EXEC_SESS)).ok, true);

  await byName.member_status.execute({ batchId: 'b-demo', lane: 't1', status: 'running' }, EXEC_SESS);
  await byName.member_status.execute({ batchId: 'b-demo', lane: 't1', status: 'review' }, EXEC_SESS);
  await byName.member_settle.execute({ batchId: 'b-demo', lane: 't1', status: 'merged', note: 'ok' }, EXEC_SESS);
  await byName.member_settle.execute({ batchId: 'b-demo', lane: 't2', status: 'skipped' }, EXEC_SESS);

  const s = await byName.batch_status.execute({ batchId: 'b-demo' }, EXEC_SESS);
  assert.equal(s.lanes.t1, 'merged');
  assert.equal(s.settled, true);
  assert.ok(s.recentEvents.some((e) => e.type === 'member.settled'));

  const sent = await byName.mailbox_send.execute({ batchId: 'b-demo', box: 'inbox', message: { task: 't2' } }, EXEC_SESS);
  const read = await byName.mailbox_read.execute({ batchId: 'b-demo', box: 'inbox' }, EXEC_SESS);
  assert.equal(read.items.length, 1);
  await byName.mailbox_ack.execute({ batchId: 'b-demo', box: 'inbox', ackId: sent.ackId }, EXEC_SESS);
  assert.equal((await byName.mailbox_read.execute({ batchId: 'b-demo', box: 'inbox' }, EXEC_SESS)).items.length, 0);

  // 跨 session 不可见：同 batchId 在别的 session 不存在（batch_status 抛错）
  await assert.rejects(() => byName.batch_status.execute({ batchId: 'b-demo', session: 'sess-worker' }, EXEC_SESS));
  // args.session 显式覆盖 exec 会话：查 Leader session 仍可见
  const viaArg = await byName.batch_status.execute({ batchId: 'b-demo', session: 'sess-leader' }, { agent: { session: { id: 'sess-worker' } } });
  assert.equal(viaArg.lanes.t1, 'merged');
});

test('wave_plan rejects duplicate batch and bad deps', async () => {
  await assert.rejects(() => byName.wave_plan.execute({ batchId: 'b-demo', tasks: [{ id: 'x' }] }, EXEC_SESS));
  await assert.rejects(() => byName.wave_plan.execute({ batchId: 'b-x', tasks: [{ id: 'a', deps: ['nope'] }] }, EXEC_SESS));
});

test('member_settle enforces state machine', async () => {
  const w = await byName.wave_plan.execute({ batchId: 'b-sm', tasks: [{ id: 'a' }] }, EXEC_SESS);
  await byName.batch_phase.execute({ batchId: 'b-sm', phase: 'running' }, EXEC_SESS);
  await assert.rejects(() => byName.member_settle.execute({ batchId: 'b-sm', lane: 'a', status: 'merged' }, EXEC_SESS));
});

test('batch_status lists all batches without batchId (per session)', async () => {
  const r = await byName.batch_status.execute({}, EXEC_SESS);
  assert.ok(r.batches.length >= 2);
  assert.equal(r.sessionId, 'sess-leader');
});

test('cli fallback when exec has no agent', async () => {
  const w = await byName.wave_plan.execute({ batchId: 'b-cli', tasks: [{ id: 'a' }] });
  assert.equal(w.sessionId, 'cli');
});

test('assign_check：C 判定（任一强制条件）与 A/B 判定', async () => {
  const c = await byName.assign_check.execute({ parallel: true });
  assert.equal(c.form, 'C'); assert.equal(c.allowed, false);
  assert.ok(c.reasons.length > 0);
  const c2 = await byName.assign_check.execute({ gate: true });
  assert.equal(c2.form, 'C');
  const a = await byName.assign_check.execute({});
  assert.equal(a.form, 'A'); assert.equal(a.allowed, true);
  const b = await byName.assign_check.execute({ needIsolation: true });
  assert.equal(b.form, 'B'); assert.equal(b.allowed, true);
});

test('artifact_types：注册表只读，含三层目录约定', async () => {
  const r = await byName.artifact_types.execute({});
  const types = r.types.map((t) => t.type);
  for (const need of ['plan', 'spec', 'taskTree', 'code', 'testReport', 'review', 'gapList', 'acceptance', 'retrospective']) {
    assert.ok(types.includes(need), 'missing type ' + need);
  }
  const retro = r.types.find((t) => t.type === 'retrospective');
  assert.equal(retro.dir, 'audit/');
});

test('gate_status：三层批次缺失清单 + generic 无门禁', async () => {
  const w = await byName.wave_plan.execute({
    batchId: 'b-gate', team: 'jiufeng',
    tasks: [
      { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 's' },
      { id: 'e1', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e1/a.py'], cmd: 'c', deps: ['p1'] },
      { id: 'a1', layer: 'audit', produce: ['audit/review.md'], cmd: 'r', deps: ['e1'] },
    ],
  }, EXEC_SESS);
  assert.ok(w.lanes.p1 === 'pending');
  const g = await byName.gate_status.execute({ batchId: 'b-gate' }, EXEC_SESS);
  const byId = Object.fromEntries(g.lanes.map((x) => [x.lane, x]));
  assert.equal(byId.e1.consumeMissing.length, 1); // plan/spec.md 缺失
  assert.equal(byId.e1.outputsMissing.length, 1);
  assert.equal(byId.a1.produceMissing.length, 1);
  assert.equal(byId.p1.layer, 'plan');
});

test('asset_claim：归位复制 + 事件留痕 + 路径防逃逸', async () => {
  const w = await byName.wave_plan.execute({ batchId: 'b-ac', tasks: [{ id: 'a' }] }, EXEC_SESS);
  const src = path.join(root, 'src-probe.txt');
  fs.writeFileSync(src, 'probe-data-1');
  const r = await byName.asset_claim.execute({ batchId: 'b-ac', source: src, target: 'probe/result.txt' }, EXEC_SESS);
  assert.equal(r.ok, true);
  assert.equal(r.claimedPath, 'probe/result.txt');
  assert.equal(r.batchId, 'b-ac');
  const dest = path.join(root, 'sessions', 'sess-leader', 'artifacts', 'b-ac', 'probe', 'result.txt');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'probe-data-1'); // 复制正确
  assert.equal(fs.readFileSync(src, 'utf8'), 'probe-data-1'); // 源保留（不移动）
  const s = await byName.batch_status.execute({ batchId: 'b-ac' }, EXEC_SESS);
  assert.ok(s.recentEvents.some((e) => e.type === 'asset.claimed' && e.source === src && e.target === 'probe/result.txt')); // 事件留痕
  // 路径逃逸被拒
  await assert.rejects(() => byName.asset_claim.execute({ batchId: 'b-ac', source: src, target: '../evil.txt' }, EXEC_SESS));
  await assert.rejects(() => byName.asset_claim.execute({ batchId: 'b-ac', source: src, target: 'a/../../evil.txt' }, EXEC_SESS));
  await assert.rejects(() => byName.asset_claim.execute({ batchId: 'b-ac', source: src, target: 'C:\\abs.txt' }, EXEC_SESS));
  await assert.rejects(() => byName.asset_claim.execute({ batchId: 'b-ac', source: src, target: '/abs.txt' }, EXEC_SESS));
  // 源缺失 / 批次不存在
  await assert.rejects(() => byName.asset_claim.execute({ batchId: 'b-ac', source: path.join(root, 'nope.txt'), target: 'x.txt' }, EXEC_SESS));
  await assert.rejects(() => byName.asset_claim.execute({ batchId: 'b-nope', source: src, target: 'x.txt' }, EXEC_SESS));
});

test('guard：config.escalation.execTools 覆盖执行型名单（config 贯通生效）', () => {
  const captured = [];
  const ctxG = { tools: { register: () => {}, guard: (fn) => { captured.push(fn); return () => {}; } }, logger: console };
  const rootG = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-gov-'));
  const storeG = createStore(rootG);
  createTools(ctxG, { store: storeG, root: rootG, config: { escalation: { execTools: ['pwsh', 'edit', 'subagent'] } } });
  assert.equal(captured.length, 1);
  const g = captured[0];
  const exec = (name) => ({ name, agent: { session: { id: 'sess-g' } } });
  // 未评估 → 名单内执行型被拒（门禁 1）
  assert.ok(g(exec('pwsh')));
  assert.ok(g(exec('edit')));
  // execTools 覆盖：write 不在名单 → 放行（缺省名单包含 write，证明覆盖生效）
  assert.equal(g(exec('write')), undefined);
  // 非执行型 / 建批治理工具 → 放行（防死锁）
  assert.equal(g(exec('read')), undefined);
  assert.equal(g(exec('wave_plan')), undefined);
  assert.equal(g(exec('asset_claim')), undefined);
  // 评估 A 后：名单内执行型放行；subagent 一致性拒绝（A 不派 subagent）
  storeG.writeGovernance('sess-g', { lastAssign: { form: 'A', at: new Date().toISOString(), execCallsSince: 0 } });
  assert.equal(g(exec('pwsh')), undefined);
  assert.ok(g(exec('subagent')));
  // 判 C 未建批（pendingBatch）→ 名单内执行型被拒（门禁 2 常开）
  storeG.writeGovernance('sess-g', { lastAssign: { form: 'C', at: new Date().toISOString(), execCallsSince: 0 }, pendingBatch: true });
  assert.ok(g(exec('pwsh')));
  assert.equal(g(exec('wave_plan')), undefined); // 建批工具仍放行
  // 建批后 pendingBatch=false → 放行
  storeG.writeGovernance('sess-g', { pendingBatch: false });
  assert.equal(g(exec('pwsh')), undefined);
  // 过期（execCallsSince≥20）→ 重评要求（门禁 1）
  storeG.writeGovernance('sess-g', { lastAssign: { form: 'A', at: new Date().toISOString(), execCallsSince: 20 } });
  assert.ok(g(exec('pwsh')));
});

test('guard：无 config.escalation 时用缺省 EXEC_TOOLS（向后兼容）', () => {
  const captured = [];
  const ctxG = { tools: { register: () => {}, guard: (fn) => { captured.push(fn); return () => {}; } }, logger: console };
  const rootG = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-gov2-'));
  const storeG = createStore(rootG);
  createTools(ctxG, { store: storeG, root: rootG, config: {} });
  const g = captured[0];
  const exec = (name) => ({ name, agent: { session: { id: 'sess-g2' } } });
  // 缺省名单：write 是执行型 → 未评估时被拒
  assert.ok(g(exec('write')));
  assert.equal(g(exec('read')), undefined);
});

test('guard：subagent 降级豁免（delegationDepth>0 / parentSession 免难度门禁）', () => {
  const captured = [];
  const ctxG = { tools: { register: () => {}, guard: (fn) => { captured.push(fn); return () => {}; } }, logger: console };
  const rootG = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-gov3-'));
  const storeG = createStore(rootG);
  createTools(ctxG, { store: storeG, root: rootG, config: {} });
  const g = captured[0];
  // subagent 会话（delegationDepth=1）：无任何评估 → 执行型工具放行（修复前门禁 1 拒绝）
  const sub = (name) => ({ name, agent: { session: { id: 'sess-sub', header: { delegationDepth: 1, parentSession: 'sess-leader' } } } });
  assert.equal(g(sub('pwsh')), undefined);
  assert.equal(g(sub('write')), undefined);
  assert.equal(g(sub('edit')), undefined);
  // parentSession 存在即豁免（delegationDepth 可为 0）
  const sub2 = (name) => ({ name, agent: { session: { id: 'sess-sub2', header: { delegationDepth: 0, parentSession: 'sess-leader' } } } });
  assert.equal(g(sub2('pwsh')), undefined);
  // 豁免不作用于根代理：无 header 且未评估 → 仍被门禁 1 拒绝
  const root = (name) => ({ name, agent: { session: { id: 'sess-root' } } });
  assert.ok(g(root('pwsh')));
  assert.ok(g(root('write')));
  // 豁免不放松 C 未建批门禁与 A 不派 subagent 门禁：根代理判 C+pendingBatch 仍拒
  storeG.writeGovernance('sess-root', { lastAssign: { form: 'C', at: new Date().toISOString(), execCallsSince: 0 }, pendingBatch: true });
  assert.ok(g(root('pwsh')));
  assert.ok(g(root('write')));
});

test('guard：显式 session 对称（arguments.session 与 sessionOf 同序解析）', () => {
  const captured = [];
  const ctxG = { tools: { register: () => {}, guard: (fn) => { captured.push(fn); return () => {}; } }, logger: console };
  const rootG = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-gov4-'));
  const storeG = createStore(rootG);
  createTools(ctxG, { store: storeG, root: rootG, config: {} });
  const g = captured[0];
  // 显式 session='sess-x' 有评估；agent.session 是无评估的 worker 会话 → 修复前只认 agent.session 被拦
  storeG.writeGovernance('sess-x', { lastAssign: { form: 'B', at: new Date().toISOString(), execCallsSince: 0 } });
  const execX = (name) => ({ name, arguments: { session: 'sess-x' }, agent: { session: { id: 'sess-worker' } } });
  assert.equal(g(execX('write')), undefined);
  assert.equal(g(execX('pwsh')), undefined);
  // 显式 session 无评估 → 仍拒（对称的另一面：不因 agent.session 有评估而放行）
  storeG.writeGovernance('sess-x', { lastAssign: { form: 'B', at: new Date().toISOString(), execCallsSince: 20 } });
  assert.ok(g(execX('pwsh')));
  // 无显式 session → 回落 agent.session 语义不变
  const execAgent = (name) => ({ name, agent: { session: { id: 'sess-worker' } } });
  assert.ok(g(execAgent('pwsh')));
});

test('guard：评估过期仍拒（stale 语义不因 subagent 豁免而放松于根代理）', () => {
  const captured = [];
  const ctxG = { tools: { register: () => {}, guard: (fn) => { captured.push(fn); return () => {}; } }, logger: console };
  const rootG = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-gov5-'));
  const storeG = createStore(rootG);
  createTools(ctxG, { store: storeG, root: rootG, config: {} });
  const g = captured[0];
  const root = (name) => ({ name, agent: { session: { id: 'sess-stale' } } });
  // 评估未过期：放行
  storeG.writeGovernance('sess-stale', { lastAssign: { form: 'A', at: new Date().toISOString(), execCallsSince: 0 } });
  assert.equal(g(root('pwsh')), undefined);
  // execCallsSince 达上限（20）→ 过期 → 拒（门禁 1 重评要求）
  storeG.writeGovernance('sess-stale', { lastAssign: { form: 'A', at: new Date().toISOString(), execCallsSince: 20 } });
  assert.ok(g(root('pwsh')));
  // 时间戳过期（30min 前）→ 拒
  storeG.writeGovernance('sess-stale', { lastAssign: { form: 'A', at: new Date(Date.now() - 31 * 60 * 1000).toISOString(), execCallsSince: 0 } });
  assert.ok(g(root('pwsh')));
});
