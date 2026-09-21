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
import { threeTierTasks, seedArtifacts, assessC } from './helpers/gate-fixture.mjs';
import { seedTeamAssetSkills, withDefaultTeam } from './helpers/host-skills.mjs';

// 【P1 同步】① `team` 现为必填且必须解析到资产 ⇒ 本套件（建批只是手段、被检面是其它工具门）统一补包内软件团队；
//   ② 该团队的 skills 必须可解析 ⇒ 隔离 HOME 下先显式注入宿主技能根（见 helpers/host-skills.mjs 口径）。
seedTeamAssetSkills('software-team');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-tools-'));
const store = createStore(root);
const registered = [];
const ctx = { tools: { register: (t) => registered.push(t) }, logger: console };
const { tools } = createTools(ctx, { store, root });
const byName = withDefaultTeam(Object.fromEntries(tools.map((t) => [t.name, t])));

const EXEC_SESS = { agent: { session: { id: 'sess-leader' } } };

// G1 前置（新门禁）：`wave_plan` / `member_status` / `member_settle` 属 C 档动作 ⇒ 本套件建批前先把
//   执行会话评估为 C（与 `assign_check({difficulty:'C'})` 同一落盘函数；旧 fixture 无此状态会被新门拦下）。
assessC(store, 'sess-leader', { rationale: 'fixture：tools 套件建批前置评估（三层批全流程 ⇒ C 档）' });

// 缺省默认开：core 12 + mailbox 3 + lane_heartbeat + lane_longrun + worktree 四件 + lane_dispatch + swarm_report + swarm_cc + handoff_submit + handoff_view = 26（logs 缺省关，log_export 不在内）
// 【2026-09-15 契约修订】+`lane_dispatch`（派发套件入口：发放一次性 lane 句柄；用户裁决「不写 token 即禁止派发」）。
// 【2026-09-16 P3a control lane 修订】+`batch_control`（最小干预面 pause/resume/abort）⇒ 23 → 24。
// 【2026-09-17 P1 修订】+`handoff_submit` / `handoff_view`（交接两件**常驻注册**）⇒ 25 → 26。
const DEFAULT_TOOL_COUNT = 28;

test('all 26 tools registered（P1-01 缺省默认开 + lane_dispatch + batch_control + P1 handoff 两件）', () => {
  assert.equal(tools.length, DEFAULT_TOOL_COUNT);
  for (const n of ['wave_plan', 'batch_phase', 'batch_control', 'batch_status', 'assign_check', 'asset_claim', 'gate_status', 'artifact_types', 'lane_claim', 'lane_release', 'lane_dispatch', 'swarm_report', 'swarm_cc', 'member_status', 'member_settle', 'mailbox_send', 'mailbox_read', 'mailbox_ack', 'lane_heartbeat', 'lane_longrun', 'lane_worktree_create', 'lane_worktree_merge', 'lane_checkpoint', 'lane_checkpoint_status']) {
    assert.ok(byName[n], 'missing tool ' + n);
  }
});

test('aip.enabled 缺省默认开启：无 config 时 register() 后 catalog 非空（26 描述，readCapability 默认合并）', () => {
  const reg = [];
  const ctxA = { tools: { register: (t) => reg.push(t) }, logger: console };
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-aip-'));
  const storeA = createStore(rootA);
  const t = createTools(ctxA, { store: storeA, root: rootA }); // 缺省 config（无 aip 键）
  assert.equal(t.catalog, null); // register() 前恒 null（懒生成）
  t.register();
  assert.ok(t.catalog, '缺省配置必须实际默认开启（catalog 非空）');
  assert.equal(t.catalog.list().length, DEFAULT_TOOL_COUNT); // 26 工具 6 属性描述齐备
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
  // 【r2 同步 · B2/B3/A1/B1】旧 fixture 的 lane 无 layer（结算被 exit 门拒 `GATE_LANE_LAYER_MISSING`）
  //   且批次无 plan/audit 层 ⇒ 改**合规三层批**（p1 plan / t1 exec / t2 audit）+ 声明产物在场；
  //   `settled` 要求**全部** lane 终态 ⇒ p1 亦须结算。
  const w = await byName.wave_plan.execute({
    batchId: 'b-demo',
    tasks: threeTierTasks(['t1'], { auditId: 't2' }),
    // r2 扩面：含 audit 层的三层批经**工具面**建批必须携带批次级装配声明（auditLane 必填），
    //   否则 `assemblyGate` 拒建批 `GATE_ROLE_ASSEMBLY_MISSING`（buildWavePlan 直调不走本门）。
    assembly: { auditLane: 't2' },
    concurrency: 3,
  }, EXEC_SESS);
  assert.equal(w.wavePlan.length, 3); // r2 同步：p1 → t1 → t2 三层依赖链 = 3 波
  assert.equal(w.sessionId, 'sess-leader');
  assert.deepEqual(w.lanes, { p1: 'pending', t1: 'pending', t2: 'pending' }); // r2 同步：合规三层批

  assert.deepEqual((await byName.batch_phase.execute({ batchId: 'b-demo', phase: 'running' }, EXEC_SESS)).phase, 'running');
  // G2 前置（2026-09-14 新门禁）：`assembly: { auditLane: 't2' }` 缺省归一化 managerPlan='raise' ⇒ exec 层
  //   派发前须先登记 Manager（`batch_phase({manager})` 唯一入口）。【gate-lite 第二批 · A】该登记**不再是派发前提**
//   （原 `GATE_MANAGER_NOT_RAISED` 拒态已删；在册判定改由官方 roster 承抽，回显 `managerRoster`）。
  await byName.batch_phase.execute({ batchId: 'b-demo', manager: { agentId: 'mgr-demo' } }, EXEC_SESS);

  const claim = await byName.lane_claim.execute({ batchId: 'b-demo', lane: 't1' }, EXEC_SESS);
  assert.equal(claim.ok, true);
  const conflict = await byName.lane_claim.execute({ batchId: 'b-demo', lane: 't1' }, EXEC_SESS);
  assert.equal(conflict.ok, false);
  assert.equal((await byName.lane_release.execute({ batchId: 'b-demo', lane: 't1', token: claim.token }, EXEC_SESS)).ok, true);

  // r2 同步：声明的产物必须在场（entry/exit 门 presence 硬约束）
  seedArtifacts(root, 'sess-leader', 'b-demo', ['t1'], { auditId: 't2' });
  await byName.member_status.execute({ batchId: 'b-demo', lane: 'p1', status: 'running' }, EXEC_SESS);
  await byName.member_status.execute({ batchId: 'b-demo', lane: 'p1', status: 'review' }, EXEC_SESS);
  await byName.member_settle.execute({ batchId: 'b-demo', lane: 'p1', status: 'merged' }, EXEC_SESS);

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
  // G1 前置（新门禁）：无 agent 上下文 ⇒ 评估/建批落点都是 `cli` 会话，故先在该会话评估为 C
  assessC(store, 'cli', { rationale: 'fixture：cli 兜底用例建批前置评估（多环节治理 ⇒ C 档）' });
  const w = await byName.wave_plan.execute({ batchId: 'b-cli', tasks: [{ id: 'a' }] });
  assert.equal(w.sessionId, 'cli');
});

test('assign_check：C 判定（任一强制条件）与 A/B 判定', async () => {
  const c = await byName.assign_check.execute({ difficulty: 'C', rationale: '测试：命中多线并行判据，需建批', parallel: true });
  assert.equal(c.form, 'C'); assert.equal(c.allowed, false);
  assert.ok(c.reasons.length > 0);
  const c2 = await byName.assign_check.execute({ difficulty: 'C', rationale: '测试：命中门禁/审计判据，需建批', gate: true });
  assert.equal(c2.form, 'C');
  const a = await byName.assign_check.execute({ difficulty: 'A', rationale: '测试：单线程直做（无并行/无依赖链）' });
  assert.equal(a.form, 'A'); assert.equal(a.allowed, true);
  const b = await byName.assign_check.execute({ difficulty: 'B', rationale: '测试：需独立上下文，评 B 派单个 subagent', needIsolation: true });
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

test('gate_status：三层批次缺失清单 + 团队资产门禁读数（P1 同步：team 必填，原 punky-preset 无资产）', async () => {
  // 【P1 同步】原 fixture 传 `team:'punky-preset'`（旧口径「无资产 ⇒ 零感知」）——P1 起无资产即拒建批 ⇒
  //   改用有资产的 `software-team`；该团队 `flows.audit.audit_contract.consumes_required=['plan/','exec/']`
  //   ⇒ audit lane 需补 consume（形态收紧，断言面未删）。
  const w = await byName.wave_plan.execute({
    batchId: 'b-gate',
    tasks: [
      { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 's' },
      { id: 'e1', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e1/a.py'], cmd: 'c', deps: ['p1'] },
      { id: 'a1', layer: 'audit', consume: ['plan/spec.md', 'exec/e1/a.py'], produce: ['audit/review.md'], cmd: 'r', deps: ['e1'] },
    ],
    assembly: { auditLane: 'a1' },
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
  storeG.writeGovernance('sess-g', { lastAssign: { difficulty: 'A', form: 'A', at: new Date().toISOString(), execCallsSince: 0 } });
  assert.equal(g(exec('pwsh')), undefined);
  assert.ok(g(exec('subagent')));
  // 判 C 未建批（pendingBatch）→ 名单内执行型被拒（门禁 2 常开）
  storeG.writeGovernance('sess-g', { lastAssign: { difficulty: 'C', form: 'C', at: new Date().toISOString(), execCallsSince: 0 }, pendingBatch: true });
  assert.ok(g(exec('pwsh')));
  assert.equal(g(exec('wave_plan')), undefined); // 建批工具仍放行
  // 建批后 pendingBatch=false → 放行
  storeG.writeGovernance('sess-g', { pendingBatch: false });
  assert.equal(g(exec('pwsh')), undefined);
  // 【2026-09-16 用户裁决】execCallsSince 降为纯观察：极大调用数**不再**触发重评（门禁 1 只认「未评估 / 无档位 / 超时」）
  storeG.writeGovernance('sess-g', { lastAssign: { difficulty: 'A', form: 'A', at: new Date().toISOString(), execCallsSince: 10_000 } });
  assert.equal(g(exec('pwsh')), undefined);
  // 时间戳过期（30min 前）→ 重评要求（门禁 1）
  storeG.writeGovernance('sess-g', { lastAssign: { difficulty: 'A', form: 'A', at: new Date(Date.now() - 31 * 60 * 1000).toISOString(), execCallsSince: 0 } });
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
  storeG.writeGovernance('sess-root', { lastAssign: { difficulty: 'C', form: 'C', at: new Date().toISOString(), execCallsSince: 0 }, pendingBatch: true });
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
  storeG.writeGovernance('sess-x', { lastAssign: { difficulty: 'B', form: 'B', at: new Date().toISOString(), execCallsSince: 0 } });
  const execX = (name) => ({ name, arguments: { session: 'sess-x' }, agent: { session: { id: 'sess-worker' } } });
  assert.equal(g(execX('write')), undefined);
  assert.equal(g(execX('pwsh')), undefined);
  // 显式 session 过期（时间窗 31min）→ 仍拒（对称的另一面：不因 agent.session 有评估而放行）
  // 【2026-09-16 用户裁决】原判据用 execCallsSince=20 触发过期；调用数已降为纯观察 ⇒ 改用时间窗判据。
  storeG.writeGovernance('sess-x', { lastAssign: { difficulty: 'B', form: 'B', at: new Date(Date.now() - 31 * 60 * 1000).toISOString(), execCallsSince: 0 } });
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
  storeG.writeGovernance('sess-stale', { lastAssign: { difficulty: 'A', form: 'A', at: new Date().toISOString(), execCallsSince: 0 } });
  assert.equal(g(root('pwsh')), undefined);
  // 【2026-09-16 用户裁决】execCallsSince 达旧上限（20）**不再**过期 → 放行（调用数仅作观察提示）
  storeG.writeGovernance('sess-stale', { lastAssign: { difficulty: 'A', form: 'A', at: new Date().toISOString(), execCallsSince: 20 } });
  assert.equal(g(root('pwsh')), undefined);
  // 时间戳过期（30min 前）→ 拒
  storeG.writeGovernance('sess-stale', { lastAssign: { difficulty: 'A', form: 'A', at: new Date(Date.now() - 31 * 60 * 1000).toISOString(), execCallsSince: 0 } });
  assert.ok(g(root('pwsh')));
});

// ═══════════════════════════════════════════════════════════════════════════
// G1（2026-09-14 用户裁决 B；**2026-09-15 用户裁决 Q2=B 收窄**）：成员面动作只允许出现在 **C 档**会话（严格档：未评估也拒）
//   被检实现：`lib/tools/core.js` 的 `assertMemberActionTierC`（:59；调用点 :213 建批、:565/:580 成员面）
//   · `wave_plan` → GATE_BATCH_REQUIRES_C；`member_status` / `member_settle` → GATE_MEMBER_REQUIRES_C；
//   · A / B / **未评估**一律拒（无默认档、无静默放行）；
//   · **收窄口径**：**取消父档继承** —— 建批只认**本会话自己的 C 档**（worker/Manager 子会话一律建不了批）；
//     成员状态仅 **调用方自己 C 档（Leader）** 或 **该批已登记的 Manager 会话**（`batch.manager.agentId`）可写，
//     其余子会话（含 C 档父会话下的 exec worker）一律拒 ⇒「成员仅作为会话存在，不可写成员状态」。
// ═══════════════════════════════════════════════════════════════════════════

test('G1 负向：未评估会话调 wave_plan → 拒 GATE_BATCH_REQUIRES_C（零批次落盘）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-g1-a-'));
  const st = createStore(root);
  const { tools: tls } = createTools({ tools: { register: () => {} }, logger: console }, { store: st, root });
  const by = withDefaultTeam(Object.fromEntries(tls.map((t) => [t.name, t])));
  const sess = { agent: { session: { id: 'sess-g1-unevaluated' } } };
  await assert.rejects(
    () => by.wave_plan.execute({ batchId: 'g1-none', tasks: [{ id: 'a' }] }, sess),
    /GATE_BATCH_REQUIRES_C: 建批（wave_plan） 只允许出现在 \*\*C 档\*\*会话（本会话档位 = 未评估）/,
  );
  assert.equal(fs.existsSync(path.join(root, 'sessions', 'sess-g1-unevaluated', 'batches', 'g1-none.json')), false, '拒建批 ⇒ 零批次 JSON 落盘');
});

test('G1 负向：A 档会话调 wave_plan → 拒 GATE_BATCH_REQUIRES_C；重评 C 后放行（同会话对照）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-g1-b-'));
  const st = createStore(root);
  const { tools: tls } = createTools({ tools: { register: () => {} }, logger: console }, { store: st, root });
  const by = withDefaultTeam(Object.fromEntries(tls.map((t) => [t.name, t])));
  const sess = { agent: { session: { id: 'sess-g1-a' } } };
  await by.assign_check.execute({ difficulty: 'A', rationale: '测试：单线程直做（无并行/无依赖链）' }, sess);
  await assert.rejects(
    () => by.wave_plan.execute({ batchId: 'g1-a', tasks: [{ id: 'a' }] }, sess),
    /GATE_BATCH_REQUIRES_C/,
    'A 档不得建批（成员协作只有一条轨道：先评 C）',
  );
  // 正例对照：重评 C（有解释的偏离说明：本条声明与机械推导一致，无需 override）后同一调用放行
  await by.assign_check.execute({ difficulty: 'C', rationale: '测试：命中多线并行判据，需 wave_plan 建批', parallel: true }, sess);
  const w = await by.wave_plan.execute({ batchId: 'g1-a', tasks: [{ id: 'a' }] }, sess);
  assert.equal(w.batchId, 'g1-a', 'C 档放行');
});

test('G1 负向：A 档会话调 member_settle → 拒 GATE_MEMBER_REQUIRES_C（零状态写入）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-g1-c-'));
  const st = createStore(root);
  const sessId = 'sess-g1-member';
  const { tools: tls } = createTools({ tools: { register: () => {} }, logger: console }, { store: st, root });
  const by = withDefaultTeam(Object.fromEntries(tls.map((t) => [t.name, t])));
  const sess = { agent: { session: { id: sessId } } };
  // 直造一个批次（本用例只判 G1 成员面门禁，不判建批面）：store 层建批后把 lane 置 running
  const plan = { wavePlan: [{ tasks: [{ id: 'a' }] }] };
  st.createBatch(sessId, { batchId: 'g1-member', wavePlan: plan, phase: 'running' });
  st.setMember(sessId, 'g1-member', 'a', 'running');
  await by.assign_check.execute({ difficulty: 'A', rationale: '测试：单线程直做（无并行/无依赖链）' }, sess);
  await assert.rejects(
    () => by.member_settle.execute({ batchId: 'g1-member', lane: 'a', status: 'merged' }, sess),
    /GATE_MEMBER_REQUIRES_C: 写成员状态（member_status \/ member_settle） 只允许出现在 \*\*C 档\*\*会话/,
  );
  assert.equal(st.readBatch(sessId, 'g1-member').lanes.a, 'running', '拒结算 ⇒ 成员态未被改写');
});

test('G1 收窄（2026-09-15 Q2=B）：worker 子会话**不继承**父档 C —— 建批被拒；仅「该批已登记的 Manager 会话」可写成员状态', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-g1-d-'));
  const st = createStore(root);
  const { tools: tls } = createTools({ tools: { register: () => {} }, logger: console }, { store: st, root });
  const by = withDefaultTeam(Object.fromEntries(tls.map((t) => [t.name, t])));
  const leader = { agent: { session: { id: 'sess-g1-leader' } } };
  assessC(st, 'sess-g1-leader', { rationale: 'fixture：Leader C 档（G1 收窄用例）' });
  // ① worker 子会话（父 = C 档 Leader，自身未评估）：**取消父档继承** ⇒ 建批被拒（成员仅作为会话存在）
  const worker = { agent: { session: { id: 'sess-g1-worker', header: { parentSession: 'sess-g1-leader', delegationDepth: 1 } } } };
  await assert.rejects(
    () => by.wave_plan.execute({ batchId: 'g1-inherit', tasks: [{ id: 'a' }] }, worker),
    /GATE_BATCH_REQUIRES_C/,
    'worker 子会话不得建批（父档继承已按 Q2=B 取消）',
  );
  // ② Leader（自身 C 档）建批 + 登记 Manager：`manager.agentId` = Manager 会话 id（宿主 continuable：subagentId = childId = 会话 id）
  await by.wave_plan.execute({ batchId: 'g1-narrow', tasks: [{ id: 'a' }] }, leader);
  await by.batch_phase.execute({ batchId: 'g1-narrow', manager: { agentId: 'sess-g1-manager' } }, leader);
  // ③ 非 Manager 的子会话（即便父会话是 C 档）写成员状态 ⇒ 仍拒（判据落**调用方**，不落批归属会话）
  await assert.rejects(
    () => by.member_status.execute({ batchId: 'g1-narrow', lane: 'a', status: 'running', session: 'sess-g1-leader' }, worker),
    /GATE_MEMBER_REQUIRES_C/,
    '批归属会话是 C 档 ≠ 调用方有权：worker 借 C 档批会话绕过必须被拒',
  );
  // ④ 该批已登记的 Manager 会话 ⇒ 放行
  const mgr = { agent: { session: { id: 'sess-g1-manager' } } };
  const r = await by.member_status.execute({ batchId: 'g1-narrow', lane: 'a', status: 'running', session: 'sess-g1-leader' }, mgr);
  assert.equal(r.status, 'running', '该批已登记 Manager 的会话可写成员状态');
});

test('Q4=B 镜像**只升不降**：执行会话自身 C 档不被「他会话 B 档夹具」覆盖', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-q4-mirror-'));
  const st = createStore(root);
  const { tools: tls } = createTools({ tools: { register: () => {} }, logger: console }, { store: st, root });
  const by = withDefaultTeam(Object.fromEntries(tls.map((t) => [t.name, t])));
  const leader = { agent: { session: { id: 'sess-mirror-leader' } } };
  await by.assign_check.execute({ difficulty: 'C', rationale: 'fixture：Leader 自身 C 档（镜像降级保护用例）', parallel: true }, leader);
  const out = await by.assign_check.execute({ difficulty: 'B', rationale: 'fixture：为他会话写 B 档夹具（单步独立任务）', needIsolation: true, session: 'sess-mirror-fixture' }, leader);
  assert.equal(out.sessionId, 'sess-mirror-fixture', '评估本身落在被指定会话');
  assert.match(String(out.notice ?? ''), /镜像跳过/, '降级镜像须在 notice 中如实回显（可审计）');
  assert.equal(out.mirroredTo, undefined, '跳过镜像 ⇒ 不回显 mirroredTo');
  assert.equal(st.readGovernance('sess-mirror-fixture').lastAssign.difficulty, 'B', '被指定会话自身记录照写');
  assert.equal(st.readGovernance('sess-mirror-leader').lastAssign.difficulty, 'C', '执行会话自身 C 档被保留（不降级）');
  // 反向对照：等档/升档照常镜像（不是「一律不镜像」）
  const out2 = await by.assign_check.execute({ difficulty: 'C', rationale: 'fixture：等档镜像照常（对照面）', parallel: true, session: 'sess-mirror-fixture2' }, leader);
  assert.equal(out2.mirroredTo, 'sess-mirror-leader', '等档不构成降级 ⇒ 镜像照常发生');
  assert.equal(st.readGovernance('sess-mirror-leader').lastAssign.difficulty, 'C', '镜像写 C');
});

// ═══════════════════════════════════════════════════════════════════════════
// G2（2026-09-14 用户裁决 A）：**建批即拉起** —— 声明 `managerPlan: 'raise'`（`normalizeAssemblyDecl`
//   使其成为**缺省值**）的批，**首个 exec 层派发前**须已登记 Manager。
//   【gate-lite 第二批 · A（2026-09-17 用户裁决「全删 + 改造为官方 roster 承抽」）】**本门的拒态已删**：
//   原码 `GATE_MANAGER_NOT_RAISED` 不再存在 —— Manager 在册判定改由**官方 roster** 承抽
//   （`ctx.get('agentTeams')` → `listMembers(agent)`；读端 `lib/tools/core.js#managerRosterOf`，
//   回显 `wave_plan.managerRoster` / `batch_status.managerRoster`，声明 raise 而无 Manager 落
//   `gate.manager_roster_gap` 事件）。⇒ 下列用例按「**翻转拒态期望 + 保留原结构断言 + 显式补
//   roster 回显/留痕断言**」改写，**未删任何用例**。
//   边界（保留判定）：plan 层不受派发准入约束；lane 处于 `idle`（G-1 恢复路径）时 entry 严进条件
//   不满足 ⇒ 仍降级为告警放行 + `gate.escape` 留痕。
//   被检实现：`lib/state/gates.ts#checkEntryGate`（Manager 段已删）／`lib/tools/core.js#managerRosterOf`。
// ═══════════════════════════════════════════════════════════════════════════

/** G2 夹具：建一个 exec 层批。**缺省 assembly 显式写 `managerPlan: 'raise'`**——语义上等价于
 *  引擎缺省（`normalizeAssemblyDecl` 的 `?? 'raise'`），但三层批经工具面建批本就必须携带 assembly 声明；
 *  本夹具把它显式化，便于用例断言「声明值 × roster 事实」双面可核（A 项新口径）。 */
function g2Harness(prefix, { assembly = { managerPlan: 'raise', auditLane: 'a1' } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const st = createStore(root);
  const { tools: tls } = createTools({ tools: { register: () => {} }, logger: console }, { store: st, root });
  const by = withDefaultTeam(Object.fromEntries(tls.map((t) => [t.name, t])));
  return {
    root, st, by,
    /** 建批（C 档前置，避免 G1 先拦而掩盖 G2 被检面）。 */
    async build(sessId, batchId, tasks) {
      const sess = { agent: { session: { id: sessId } } };
      assessC(st, sessId, { rationale: 'fixture：G2 用例建批前置评估（exec 层派发治理 ⇒ C 档）' });
      const args = { batchId, tasks };
      if (assembly) args.assembly = assembly;
      await by.wave_plan.execute(args, sess);
      return sess;
    },
    /** 落盘 plan 产物（使 exec 的 consume 在场 ⇒ 被检面落在 G2 而非 presence 缺件）。 */
    seedPlan(sessId, batchId, rel = 'plan/spec.md') {
      const abs = path.join(root, 'sessions', sessId, 'artifacts', batchId, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, '# spec\n## 验收标准\n- x\n## 约束\n- y\n');
    },
    /** 直写批次 JSON 把 lane 置指定态（镜像既有套件的 laneState 直写法；本用例只判门禁降级面）。 */
    setLane(sessId, batchId, lane, state) {
      const bf = path.join(root, 'sessions', sessId, 'batches', batchId + '.json');
      const b = JSON.parse(fs.readFileSync(bf, 'utf8'));
      b.lanes[lane] = state;
      fs.writeFileSync(bf, JSON.stringify(b, null, 2), 'utf8');
      return b;
    },
  };
}

// 【P1 同步】audit lane 补 `exec/e1.md` consume：本套件建批统一走 `software-team`（team 现为必填且必须解析到资产），
//   该团队 `audit_contract.consumes_required=['plan/','exec/']` 属引擎既有纪律 ⇒ 夹具补成合规形态（未删任何断言）。
const G2_TASKS = [
  { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 'spec' },
  { id: 'e1', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e1.md'], deps: ['p1'], cmd: 'run' },
  { id: 'a1', layer: 'audit', consume: ['plan/spec.md', 'exec/e1.md'], produce: ['audit/a1.md'], deps: ['e1'], cmd: 'review' },
];

test('G2 语义变迁（A 项）：声明（缺省）managerPlan=raise 且未登记 Manager ⇒ **不再拒**；在册判据改由 roster 回显', async () => {
  const h = g2Harness('punky-g2-a-');
  const sess = await h.build('sess-g2-miss', 'g2-miss', G2_TASKS);
  h.seedPlan('sess-g2-miss', 'g2-miss');
  // 【翻转】原断言：`assert.rejects(..., /^Error: GATE_MANAGER_NOT_RAISED: .*batch_phase.*登记再派 exec/)`。
  //   现语义：该门整体删除 ⇒ 未登记不再构成派发拒因（本用例保留为**新语义回归锁**）。
  const r = await h.by.member_status.execute({ batchId: 'g2-miss', lane: 'e1', status: 'running' }, sess);
  assert.equal(r.status, 'running', '未登记 Manager 不再是派发拒因（A 项：Manager 承抽官方 roster）');
  const b = h.st.readBatch('sess-g2-miss', 'g2-miss');
  // 保留原结构断言：批字段不被隐式写入 / 拒留痕为零
  assert.equal(b.manager, undefined, '未登记 ⇒ 批次**仍无** manager 字段（legacy 字段不被隐式写入）');
  assert.equal(b.events.filter((e) => e.type === 'gate.entry.missing').length, 0, '放行路径不得残留 entry 拒留痕');
  // 【显式补：留痕/码面断言】新真源 = 官方 roster 读端（本夹具 ctx 无 agentTeams ⇒ 如实回显基线态，不静默）
  const v = await h.by.batch_status.execute({ batchId: 'g2-miss' }, sess);
  assert.ok(v.managerRoster, 'roster 读端回显在位（新真源可核，非隐性判定）');
  assert.equal(v.managerRoster.roster.ok, false);
  assert.equal(v.managerRoster.roster.reason, 'service-unavailable', '非官方宿主基线态如实回显');
  assert.equal(v.managerRoster.managerPlan, 'raise', '声明值回显 ⇒「声明 × roster 事实」双面可核（A2 不再假契约）');
  assert.equal(v.managerRoster.legacy, null, 'legacy 面未被隐式写');
});

test('G2 语义变迁（显式 raise 同一口径）：显式 assembly.managerPlan=raise 未登记 Manager ⇒ 同样不再拒', async () => {
  const h = g2Harness('punky-g2-b-', { assembly: { managerPlan: 'raise', auditLane: 'a1' } });
  const sess = await h.build('sess-g2-explicit', 'g2-explicit', G2_TASKS);
  h.seedPlan('sess-g2-explicit', 'g2-explicit');
  // 【翻转】原断言：`assert.rejects(..., /^Error: GATE_MANAGER_NOT_RAISED/)` ⇒ 现为放行 + 结构断言保留
  const r = await h.by.member_status.execute({ batchId: 'g2-explicit', lane: 'e1', status: 'running' }, sess);
  assert.equal(r.status, 'running');
  const b = h.st.readBatch('sess-g2-explicit', 'g2-explicit');
  assert.equal(b.manager, undefined, '结构断言保留：显式 raise 亦不隐式写 legacy 字段');
  assert.equal(b.events.some((e) => e.type === 'gate.manager_roster_gap'), false,
    '显式 raise + roster 不可读（非官方宿主基线态）⇒ **不落** roster_gap 事件（环境事实不写成本批事实）');
});

test('G2 正例：manager 已登记 ⇒ 同一 exec lane 可派（本门不再拦）', async () => {
  const h = g2Harness('punky-g2-c-');
  const sess = await h.build('sess-g2-ok', 'g2-ok', G2_TASKS);
  h.seedPlan('sess-g2-ok', 'g2-ok');
  // 登记 Manager（`batch_phase({manager})` 的唯一写入口）
  const r = await h.by.batch_phase.execute({ batchId: 'g2-ok', manager: { agentId: 'mgr-g2-ok' } }, sess);
  assert.equal(r.manager.agentId, 'mgr-g2-ok');
  assert.equal(h.st.readBatch('sess-g2-ok', 'g2-ok').manager.agentId, 'mgr-g2-ok', '批字段 manager 落盘');
  // 同构造在「已登记」下放行（A 项后**登记不再是放行前提**——放行来自该门整体删除；本用例保留为
  //   「legacy 登记面仍可写、且不产生误拒」的结构锁）
  const ok = await h.by.member_status.execute({ batchId: 'g2-ok', lane: 'e1', status: 'running' }, sess);
  assert.equal(ok.status, 'running', 'Manager 已登记 ⇒ exec 层可派');
  assert.equal(h.st.readBatch('sess-g2-ok', 'g2-ok').lanes.e1, 'running', '成员态进入 running');
  assert.equal(
    h.st.readBatch('sess-g2-ok', 'g2-ok').events.some((e) => e.type === 'gate.entry.missing'),
    false,
    '放行路径不得残留 entry 拒留痕',
  );
});

test('G2 正例（leader-direct 退出默认）：未登记 Manager 亦不触发本门（拒因回到 entry 缺件判据）', async () => {
  const h = g2Harness('punky-g2-d-', { assembly: { managerPlan: 'leader-direct', auditLane: 'a1' } });
  const sess = await h.build('sess-g2-ld', 'g2-ld', G2_TASKS);
  // 刻意**不**落盘 plan 产物：本门若不介入，拒因必为 entry 的 consume 缺件（可区分）
  await assert.rejects(
    () => h.by.member_status.execute({ batchId: 'g2-ld', lane: 'e1', status: 'running' }, sess),
    /GATE_ENTRY_MISSING: plan\/spec\.md/,
    'leader-direct 批不适用 G2 ⇒ 拒因应为 entry 缺件',
  );
  // 单通道正例：补齐产物后放行（全程未登记 Manager）
  h.seedPlan('sess-g2-ld', 'g2-ld');
  const ok = await h.by.member_status.execute({ batchId: 'g2-ld', lane: 'e1', status: 'running' }, sess);
  assert.equal(ok.status, 'running', 'leader-direct 批不要求 Manager 登记');
});

test('G2 恢复路径：lane 处于 idle → 本门降级为告警放行 + 留痕（G-1 永不可堵）', async () => {
  const h = g2Harness('punky-g2-e-');
  const sess = await h.build('sess-g2-idle', 'g2-idle', G2_TASKS);
  // 刻意**不**落盘任何产物：使本门成为唯一拒因 ⇒ 放行只可能来自恢复路径降级
  h.setLane('sess-g2-idle', 'g2-idle', 'e1', 'idle'); // 模拟崩溃恢复：in-flight lane 归 idle 后重派
  assert.equal(h.st.readBatch('sess-g2-idle', 'g2-idle').lanes.e1, 'idle', '前置：lane 已归 idle');
  assert.equal(h.st.readBatch('sess-g2-idle', 'g2-idle').manager, undefined, '前置：Manager 未登记（本门若不降级必拒）');
  const r = await h.by.member_status.execute({ batchId: 'g2-idle', lane: 'e1', status: 'running' }, sess);
  assert.equal(r.status, 'running', 'idle 恢复路径必须放行（不得因未登记 Manager 堵死崩溃恢复）');
  // 降级必须留痕：gate.escape 事件（idle-recovery-passthrough）
  const evs = h.st.readBatch('sess-g2-idle', 'g2-idle').events;
  const esc = evs.filter((e) => e.type === 'gate.escape');
  assert.ok(esc.length >= 1, '降级放行须留痕 gate.escape：' + JSON.stringify(evs.map((e) => e.type)));
  assert.ok(esc.some((e) => e.kind === 'idle-recovery-passthrough'),
    'escape 载荷须标 kind=idle-recovery-passthrough：' + JSON.stringify(esc));
  // 对照：同构造在 pending（首次派发）下**仍严格** —— 但严进拒因已不是 Manager 门（该门已删），
  //   而是 entry 的产物在场判据（本对照刻意不落盘产物）⇒ 保留「首次派发仍有硬约束」这一结构断言。
  const h2 = g2Harness('punky-g2-e2-');
  const sess2 = await h2.build('sess-g2-pending', 'g2-pending', G2_TASKS);
  await assert.rejects(
    () => h2.by.member_status.execute({ batchId: 'g2-pending', lane: 'e1', status: 'running' }, sess2),
    /^Error: GATE_ENTRY_MISSING: plan\/spec\.md/,
    '首次派发（pending）仍严格：拒因为 entry 缺件（原 Manager 门已随 A 项删除）',
  );
});
