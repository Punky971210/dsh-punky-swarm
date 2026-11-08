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
import { withDefaultTeam } from './helpers/skill-paths.mjs';

// 【P1 同步】`team` 现为必填且必须解析到资产 ⇒ 本套件（建批只是手段、被检面是其它工具门）统一补包内软件团队。

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-tools-'));
const store = createStore(root);
const registered = [];
const ctx = { tools: { register: (t) => registered.push(t) }, logger: console };
const { tools } = createTools(ctx, { store, root });
const byName = withDefaultTeam(Object.fromEntries(tools.map((t) => [t.name, t])));

const EXEC_SESS = { agent: { session: { id: 'sess-leader' } } };

// G1 前置（新门禁）：`wave_plan` / `member_set_status` / `member_settle` 属 C 档动作 ⇒ 本套件建批前先把
//   执行会话评估为 C（与 `assign_check({difficulty:'C'})` 同一落盘函数；旧 fixture 无此状态会被新门拦下）。
assessC(store, 'sess-leader', { rationale: 'fixture：tools 套件建批前置评估（三层批全流程 ⇒ C 档）' });

// 缺省默认开面 = 下列 `TOOL_NAMES` **冻结名单**；**计数一律由名单长度派生（禁字面量）**。
// 【R-1/T-10 · 2026-10-09 批 `engine-techdebt-cleanup-r2-20261008`】原 `DEFAULT_TOOL_COUNT` 为**数字字面量**
//   ⇒ 每加一个工具就漂移（上批 +`role_guide` 后实测 **30**，字面量未同步 ⇒ 本文件 2 用例红）。
//   现改为**派生**（先例：`test/tool-descriptor.test.js:37-38`；本项目自有形态）并配**精确集合断言 + 差集诊断**：
//   失败信息直接指出「多了/少了哪个工具」，而非只报一个数字。
//   ⚠ **面不可混用**：本面（缺省注册集，30）**≠** `SUITE_TOOLS`（注册表全集，38）⇒ **不得互相派生**。
// 历史（保留可读）：core 12 + mailbox 3 + lane_heartbeat + lane_longrun + worktree 四件 + lane_dispatch +
//   swarm_report + swarm_cc + handoff_submit + handoff_view；+batch_control（23→24）、+handoff 两件（25→26）、
//   +task_pool / batch_tasks_add / task_update、+`role_guide`（上批 D-1）⇒ 现 30。
// 【2026-09-15 契约修订】+`lane_dispatch`（派发套件入口：发放一次性 lane 句柄；用户裁决「不写 token 即禁止派发」）。
// 【2026-09-16 P3a control lane 修订】+`batch_control`（最小干预面 pause/resume/abort）。
// 【2026-09-17 P1 修订】+`handoff_submit` / `handoff_view`（交接两件**常驻注册**）。
// 【2026-10-13 G-10 修订 · 批 `g10-fix-20261012` · lane `e4-toolface`】+`handoff_accept`
//   （受限反向声明，常驻注册；「缺省默认开面」的**必然增量** ⇒ 冻结名单须同步，否则本用例红）。
// 名单来源：`lib/tools/register.js` 的合成结果**实测枚举**（core + lane + log 族），非手抄。
// 【2026-10-30 G3 B1 删件】删 `mailbox_send`/`mailbox_read`/`mailbox_ack`/`lane_heartbeat`/`lane_longrun`
//   五名（31 → 26，展示位）；冻结名单 ≡ 实测注册集（集合式判据 = 下方 deepEqual）。
//   ⚠ 本文件有**两处**列出工具名：本行冻结名单 ＋ `:66` 的逐名存在性循环 —— 两处同步删，
//     否则 `:66` 会继续断言「已删工具存在」（自相矛盾用例）。
// 【2026-11-07 · 批 `punky-engine-core-deepdive-20261107` · G-2】新增 `taskpack_for`（26 → 27）：
//   D 档任务包取件口（只读，调 `composeWorkerPrompt` 与引擎自派路径同源）。
const TOOL_NAMES = ['wave_plan', 'batch_phase', 'batch_control', 'batch_status', 'artifact_types', 'assign_check', 'asset_claim', 'gate_status', 'role_guide', 'taskpack_for', 'lane_claim', 'lane_release', 'member_settle', 'handoff_submit', 'handoff_accept', 'handoff_view', 'lane_dispatch', 'swarm_report', 'swarm_cc', 'member_set_status', 'task_pool', 'batch_tasks_add', 'task_update', 'lane_worktree_create', 'lane_worktree_merge', 'lane_checkpoint', 'lane_checkpoint_status'];
const DEFAULT_TOOL_COUNT = TOOL_NAMES.length;

test('all tools registered（缺省默认开面 ≡ 冻结名单 TOOL_NAMES，计数由派生常量核定）', () => {
  // 【R-1/T-10】原 `assert.equal(tools.length, DEFAULT_TOOL_COUNT)` 仅比**数字** ⇒ 失败信息不指名工具。
  //   现改为**精确集合断言 + 差集诊断**：失败时直接给出「多了哪个 / 少了哪个」。
  assert.deepEqual(tools.map((t) => t.name).slice().sort(), TOOL_NAMES.slice().sort(),
    '注册名集必须**精确等于**冻结名单 `TOOL_NAMES`（差集即多/少的具体工具名）');
  for (const n of ['wave_plan', 'batch_phase', 'batch_control', 'batch_status', 'assign_check', 'asset_claim', 'gate_status', 'artifact_types', 'lane_claim', 'lane_release', 'lane_dispatch', 'swarm_report', 'swarm_cc', 'member_set_status', 'member_settle', 'lane_worktree_create', 'lane_worktree_merge', 'lane_checkpoint', 'lane_checkpoint_status']) {
    assert.ok(byName[n], 'missing tool ' + n);
  }
});

test('aip.enabled 缺省默认开启：无 config 时 register() 后 catalog 非空（描述数 = 派生常量，readCapability 默认合并）', () => {
  const reg = [];
  const ctxA = { tools: { register: (t) => reg.push(t) }, logger: console };
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-aip-'));
  const storeA = createStore(rootA);
  const t = createTools(ctxA, { store: storeA, root: rootA }); // 缺省 config（无 aip 键）
  assert.equal(t.catalog, null); // register() 前恒 null（懒生成）
  t.register();
  assert.ok(t.catalog, '缺省配置必须实际默认开启（catalog 非空）');
  assert.equal(t.catalog.list().length, DEFAULT_TOOL_COUNT); // 描述数 = 派生常量 DEFAULT_TOOL_COUNT（禁字面量）
  assert.equal(reg.length, DEFAULT_TOOL_COUNT); // 工具注册数与 catalog 一致（P1-01 缺省默认开）
});

// ── R-1/T-10 可达反例（**AC-R1-2 硬门**）────────────────────────────────────────
// 构造：**测试内注入** 1 条合成工具到派生源（**不改仓库、不改冻结名单本体**）。
//   读数①「改前」旧形态 = 只比**数字** ⇒ 须 ≥2 站点变红，且失败信息**不指名**该工具；
//   读数②「改后」新形态 = **精确集合断言** ⇒ 失败信息**指名**该工具（差集诊断）。
// 注：注入只作用于本用例的**局部副本**，`TOOL_NAMES` 本体零改动。
test('R-1 可达反例：注入 1 条合成工具 ⇒ 旧「计数」形态 ≥2 站点变红且不指名；新「集合」形态指名该工具', () => {
  const SYNTH = '__r1_synthetic_probe__';
  const injected = [...TOOL_NAMES, SYNTH];

  // 读数①：旧形态（数字比较）逐站点判定 + 收集其诊断文本
  const oldDiag = [];
  const OLD = [
    ['注册面 length 计数', () => assert.equal(injected.length, DEFAULT_TOOL_COUNT)],
    ['catalog 面 length 计数', () => assert.equal(new Set(injected).size, DEFAULT_TOOL_COUNT)],
  ];
  let oldRed = 0;
  for (const [label, probe] of OLD) {
    try { probe(); } catch (e) { oldRed += 1; oldDiag.push(label + ': ' + String(e.message)); }
  }
  const oldNamesTool = oldDiag.some((m) => m.includes(SYNTH));
  assert.ok(oldRed >= 2, '读数①：旧计数形态须 ≥2 站点变红（实测 ' + oldRed + '）');
  assert.equal(oldNamesTool, false, '读数①：旧形态诊断**不得**指名工具（实测 ' + oldNamesTool + '）');

  // 读数②：新形态（精确集合断言）⇒ 诊断须指名该工具
  let newDiag = '';
  try { assert.deepEqual(injected.slice().sort(), TOOL_NAMES.slice().sort()); }
  catch (e) { newDiag = String(e.message); }
  assert.ok(newDiag.length > 0, '读数②：新集合形态须变红');
  assert.ok(newDiag.includes(SYNTH), '读数②：新集合形态须**指名**该工具（差集诊断）');

  console.log('[R-1 可达反例] 读数①旧形态变红站点 = ' + oldRed + '（指名工具=' + oldNamesTool + '）／读数②新形态变红且指名 = true');
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
  assert.deepEqual(w.wavePlan.map((x) => x.wave), [1, 2, 3], 'wave 序号数组 = 输入声明的 1/2/3（实测 ' + JSON.stringify(w.wavePlan.map((x) => x.wave)) + '）'); // r2 同步：p1 → t1 → t2 三层依赖链 = 3 波
  assert.equal(w.sessionId, 'sess-leader');
  assert.deepEqual(w.lanes, { p1: 'pending', t1: 'pending', t2: 'pending' }); // r2 同步：合规三层批

  assert.deepEqual((await byName.batch_phase.execute({ batchId: 'b-demo', phase: 'running' }, EXEC_SESS)).phase, 'running');

  const claim = await byName.lane_claim.execute({ batchId: 'b-demo', lane: 't1' }, EXEC_SESS);
  assert.equal(claim.ok, true);
  const conflict = await byName.lane_claim.execute({ batchId: 'b-demo', lane: 't1' }, EXEC_SESS);
  assert.equal(conflict.ok, false);
  assert.equal((await byName.lane_release.execute({ batchId: 'b-demo', lane: 't1', token: claim.token }, EXEC_SESS)).ok, true);

  // r2 同步：声明的产物必须在场（entry/exit 门 presence 硬约束）
  seedArtifacts(root, 'sess-leader', 'b-demo', ['t1'], { auditId: 't2' });
  await byName.member_set_status.execute({ batchId: 'b-demo', lane: 'p1', status: 'running' }, EXEC_SESS);
  await byName.member_set_status.execute({ batchId: 'b-demo', lane: 'p1', status: 'review' }, EXEC_SESS);
  await byName.member_settle.execute({ batchId: 'b-demo', lane: 'p1', status: 'merged' }, EXEC_SESS);

  await byName.member_set_status.execute({ batchId: 'b-demo', lane: 't1', status: 'running' }, EXEC_SESS);
  await byName.member_set_status.execute({ batchId: 'b-demo', lane: 't1', status: 'review' }, EXEC_SESS);
  await byName.member_settle.execute({ batchId: 'b-demo', lane: 't1', status: 'merged', note: 'ok' }, EXEC_SESS);
  await byName.member_settle.execute({ batchId: 'b-demo', lane: 't2', status: 'skipped' }, EXEC_SESS);

  const s = await byName.batch_status.execute({ batchId: 'b-demo' }, EXEC_SESS);
  assert.equal(s.lanes.t1, 'merged');
  assert.equal(s.settled, true);
  assert.ok(s.recentEvents.some((e) => e.type === 'member.settled'));

  // 【2026-10-30 G3 B1】原内联「mailbox_send → mailbox_read → mailbox_ack → 空集」三段已移除：
  //   三个 mailbox 工具随 B1 删除（`lib/tools/mailbox-tools.js` 整件删）⇒ 此处 `byName.mailbox_*` 为 undefined
  //   会 TypeError。**存储面**（send/readUnacked/ack）仍在 `lib/comms/mailbox.js` 且未变，
  //   其覆盖由 `test/lane-session-bind` / `budget` 等存储侧用例承担；本用例其余断言（含下方跨 session 两条）**全保留**。

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
  assert.equal(byId.e1.consumeMissing.length, 1, 'consumeMissing 恰 1 项');
  assert.equal(new Set(byId.e1.consumeMissing).size, byId.e1.consumeMissing.length, '缺项不得重复计入（实测 ' + JSON.stringify(byId.e1.consumeMissing) + '）'); // plan/spec.md 缺失
  assert.equal(byId.e1.outputsMissing.length, 1, 'outputsMissing 恰 1 项');
  assert.equal(new Set(byId.e1.outputsMissing).size, byId.e1.outputsMissing.length, '缺项不得重复计入（实测 ' + JSON.stringify(byId.e1.outputsMissing) + '）');
  assert.equal(byId.a1.produceMissing.length, 1, 'produceMissing 恰 1 项');
  assert.equal(new Set(byId.a1.produceMissing).size, byId.a1.produceMissing.length, '缺项不得重复计入（实测 ' + JSON.stringify(byId.a1.produceMissing) + '）');
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
  // 【2026-10-31 S3 · 声明层带来**第二个 guard**】`register.js` 现按生产序注册 **两个** guard：
  //   ① `installDifficultyGuard`（难度门禁，本用例被检面）② `installWriteProvenanceGuard`（S3 写族溯源，与本用例无关）。
  //   ⇒ 精确数从 1 改为 **2**（仍是精确值：多注册第三个 guard 会立刻红），并显式取 `captured[0]` = 难度门禁
  //   （注册序：难度门禁在溯源守卫之前）。**未放宽**为 `>=` / 只判存在。
  assert.equal(captured.length, 2, '生产注册序 = [难度门禁, 写族溯源守卫]');
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
//   · `wave_plan` → GATE_BATCH_REQUIRES_C；`member_set_status` / `member_settle` → GATE_MEMBER_REQUIRES_C；
//   · A / B / **未评估**一律拒（无默认档、无静默放行）；
//   · **收窄口径**：**取消父档继承** —— 建批只认**本会话自己的 C 档**（worker 子会话一律建不了批）；
//     成员状态只认 **调用方自己 C 档**（判据落调用方，不落批归属会话），
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
    /GATE_MEMBER_REQUIRES_C: 写成员状态（member_set_status \/ member_settle） 只允许出现在 \*\*C 档\*\*会话/,
  );
  assert.equal(st.readBatch(sessId, 'g1-member').lanes.a, 'running', '拒结算 ⇒ 成员态未被改写');
});

test('G1 收窄（2026-09-15 Q2=B）：worker 子会话**不继承**父档 C —— 建批被拒；父档不继承', async () => {
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
  // ② Leader（自身 C 档）建批：③ 需该批存在（判据落调用方档位，与批归属会话无关）
  await by.wave_plan.execute({ batchId: 'g1-narrow', tasks: [{ id: 'a' }] }, leader);
  // ③ 非 C 档子会话（即便父会话是 C 档）写成员状态 ⇒ 仍拒（判据落**调用方**，不落批归属会话）
  await assert.rejects(
    () => by.member_set_status.execute({ batchId: 'g1-narrow', lane: 'a', status: 'running', session: 'sess-g1-leader' }, worker),
    /GATE_MEMBER_REQUIRES_C/,
    '批归属会话是 C 档 ≠ 调用方有权：worker 借 C 档批会话绕过必须被拒',
  );
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
