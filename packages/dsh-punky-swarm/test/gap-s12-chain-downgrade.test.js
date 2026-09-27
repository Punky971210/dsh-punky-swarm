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

// GAP-S12「无挂载点 ⇒ 链推进降级」用例面（用户 2026-09-16 裁决方向 (c)）。
// ─────────────────────────────────────────────────────────────────────────────
// 缺陷（真机实证，批次 `p3a-smoke-restart-20260916`）：自动结算跑在**宿主事件回调 / 工具面之外**，
//   `advanceChainAfterSettle(deps, ctx, null, …)` 的第三参 `exec = null` ⇒ 链推进直落
//   `dispatchLaneCore`，其挂载点 `exec.agent` 缺位 ⇒ 抛 `GATE_DISPATCH_FAILED`（缺少调用方 Agent）
//   ⇒ lane 回滚 `review` + 批 `paused`（链的下一环永远派不出去）。
// 修复口径（方向 (c) 降级）：事件路 / 自动结算路**不再尝试链派发**——链决策照算（复用
//   `lib/engine/chain-runner.js` 的决策单点），但改落**「待派清单」留痕**、批相位**保持 `running`**、
//   链推进交回 Leader。§8-1 验收口径相应从「零派发」修订为「**零结算 + 待派清单**」。
// 覆盖（对齐交付判据 a–f）：
//   a. 有链 + 自动结算两路（`subagent/end` 事件路 / `settle-request` 兼底路）⇒ 结算成功、
//      批相位仍 `running`（零 pause）、落 `chain.step{dispatch.mode:'manual-pending'}` 且 lane 名单正确；
//   b. 有链 + 工具路（Leader 手工 `member_settle`，`exec.agent` 在场）⇒ **仍自动派发**（P2 回归锁）；
//   c. 无链批 ⇒ 零新增 `chain.step`、零行为差异（R5 向后兼容锁）；
//   d. `join=all` 未齐 ⇒ 不落推进留痕、不 pause（既有 `wait` 语义逐字不变），补齐后才推进；
//   e. 真失败路径（链决策 `pause` / `hold`）⇒ 仍停轮 / 仍留痕，本降级不得吞掉；
//   f. 断言只增不减（`baselines/test-baseline.json` 与本套件双重锁定）。
// 夹具口径（刻意贴近真机 `presets/engine-team/team-asset.yml` 的链步 `plan/exec/review/audit`）：
//   链步 id 与 lane id **同名者只在 plan 一层**；exec 层的两件 lane 走 `(layer, role)` 映射到同一步
//   （`review` 步汇合面）。原因：`chainStepForLane` 的 `(layer, role)` 判定在「同一步内多 lane」时
//   本就不歧义，但若两个**不同**链步共享同一 `(layer, role)`，则任何一条该层 lane 都会判
//   `ambiguous-mapping` ⇒ 停轮——这是既有判定的已知边界（未在本任务修改范围内），故夹具按真机拓扑。
// 事实源纪律：断言一律读 `store.readBatch` 的批次 JSON（唯一事实源），不读模块内部状态。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../lib/state/store.js';
import { createTools } from '../lib/tools/register.js';
import { clearRoleCache } from '../lib/assembly/flows.js';
import { advanceChainAfterSettle } from '../lib/engine/chain-runner.js';
import {
  EVT_AUTO_SETTLE_TRIGGERED, EVT_AUTO_SETTLE_PAUSED, EVT_AUTO_SETTLE_SKIPPED, EVT_MEMBER_DISPATCH, EVT_BATCH_PHASE,
} from '../lib/state/event-types.js';
import { autoSettleLane, requestAutoSettle, AUTO_SETTLE_TRIGGERS } from '../lib/engine/auto-settle.js';
import { assessC } from './helpers/gate-fixture.mjs';
import { writeSyntheticTeam } from './helpers/team-fixture.mjs';
import { seedArtifactFile } from './helpers/gate-fixture.mjs';

const SESSION = 'sess-gap-s12';
const SESS = { agent: { session: { id: SESSION } } };
const TEAM = 's12-team';
const TEAM_NOCHAIN = 's12-team-nochain';
const SPEC = '# spec\n## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准\n- x\n## 约束\n- y\n';
const LAYERS = {
  plan: { roles: ['designer'], skills: { designer: ['spec-writing'] } },
  exec: { roles: ['coder', 'reviewer'], skills: { coder: ['dev-coder'], reviewer: ['review-execution'] } },
  audit: { roles: ['reviewer'], skills: { reviewer: ['acceptance-gate'] } },
};
const ROLES = { plan_leads: ['designer'], audit_leads: ['reviewer'] };
const FLOWS = {
  plan: { produce_field: 'produce', entry_requires: [], contract: { artifact_globs: ['plan/*.md'], required_sections: ['## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准', '## 约束'] } },
  exec: { produce_field: 'outputs', consume_field: 'consume', entry_requires: ['consume'] },
  audit: {
    produce_field: 'produce', consume_field: 'consume', entry_requires: ['consume'],
    audit_contract: { criteria_from: 'plan/spec.md', consumes_required: ['plan/', 'exec/'], verdict: ['approve', 'reject'] },
  },
};

/** 夹具链①（正向面，形态 = 真机 `engine-team` 拓扑的极简版）：
 *  `plan → exec(join:all) → review(join:all, next: audit)`；链尾 `audit` 在本批无 lane
 *  ⇒ 只做「被推进的目标步」而不被结算（避免审计契约面把主判据遮住）。
 *  【M1 改写（2026-09-17）】原 `review` 用步级条件边 `on:{merged:'audit'}`，已随声明面下线下线 ⇒ 改 `next`。 */
function chainExec() {
  return {
    version: 1,
    steps: [
      { id: 'plan', layer: 'plan', role: 'designer', next: 'exec' },
      { id: 'exec', layer: 'exec', role: 'coder', join: 'all', next: 'review' },
      { id: 'review', layer: 'exec', role: 'reviewer', join: 'all', next: 'audit' },
      { id: 'audit', layer: 'audit', role: 'reviewer', terminal: true },
    ],
    join: { anyFailure: 'pause' },
    onFail: 'pause',
  };
}
/** 夹具链②（汇合未齐面）：与夹具链① **同一份链声明**，差异只在**本批 lane 拓扑**——
 *  把 `review` 步的 lane 换成两件同 `(exec, reviewer)` 的 lane（`review1`/`review2`），
 *  于是「汇合齐备」成为可构造的事件（`join:all` ⇒ 两件全 merged 才推进）。 */
function chainJoin() {
  return chainExec();
}
/** 夹具链③（失败处置 = hold）：链级 `onFail: 'review'`（只留痕停轮、不改相位）。 */
function chainHold() {
  const c = chainExec();
  c.onFail = 'review';
  return c;
}

/** 本批任务：`plan` + 两件 exec lane（`exec` 派发面 / `review<T>` 汇合面）+ 链外 `audit`。 */
function tasksOf({ reviewLanes = ['review'] } = {}) {
  return [
    { id: 'plan', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
    { id: 'exec', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/exec.md'], cmd: 'build' },
    ...reviewLanes.map((id, i) => ({
      id, layer: 'exec', role: 'reviewer', consume: ['plan/spec.md'], outputs: ['exec/' + id + '-' + i + '.md'], cmd: 'review',
    })),
    {
      id: 'audit', layer: 'audit', role: 'reviewer',
      consume: ['plan/spec.md', 'exec/exec.md'], produce: ['audit/audit.md'], cmd: 'accept',
    },
  ];
}

/** 建批夹具：临时 `teamsRoot`（资产 + 宿主技能根按显式 env 注入，与引擎读端同源）+ 真工具注册面。 */
function makeHarness({ chain = chainExec(), team = TEAM, subagents = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-s12-'));
  const store = createStore(root);
  const ctx = { tools: { register: () => {} }, logger: { info() {}, warn() {}, error() {} } };
  if (subagents) ctx.subagents = subagents;
  const teamsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-s12-teams-'));
  const asset = { team, layers: LAYERS, roles: ROLES, flows: FLOWS };
  // `chain: null` = 无 `chain` 声明（判据 c 的 R5 向后兼容锁）。
  if (chain !== null) asset.chain = chain;
  // F2：合成资产 ⇒ 单点写入（helpers/team-fixture.mjs）。
  writeSyntheticTeam(teamsRoot, team, asset);
  clearRoleCache();
  const { tools } = createTools(ctx, { store, root, config: { dispatch: { provider: 'spawn-in-process' } } });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assessC(store, SESSION, { rationale: 'fixture：GAP-S12 链降级用例的建批前置评估（三层多依赖 ⇒ C 档）' });
  return { root, store, byName, ctx, teamsRoot, team };
}

/** 装配声明：**`raise`**（引擎缺省；显式写出以便阅读）。**M0′-① 之后 `leader-direct` 批的链推进
 *  全程 no-op** ⇒ 本套件（断言「无挂载点 ⇒ 降级为待派清单」）必须取非 leader-direct 形态。 */
const ASSEMBLY = { managerPlan: 'raise', auditLane: 'audit' };
const wavePlanOf = (h, batchId, tasks) => h.byName.wave_plan.execute({
  batchId, team: h.team, teamsRoot: h.teamsRoot, tasks, assembly: ASSEMBLY,
}, SESS);
/** 建批 + 武装（链推进的武装前提 = 相位 `running`；`wave_plan` 落 `planning`）。 */
async function mkBatch(h, batchId, { reviewLanes = ['review'] } = {}) {
  await wavePlanOf(h, batchId, tasksOf({ reviewLanes }));
  await h.byName.batch_phase.execute({ batchId, phase: 'running' }, SESS);
}
// F3：收敛为单点（夹具审计 §3.3 必合档：5 份函数体逐字相同）⇒ 本文件只留 `SESSION` 绑定适配。
const seed = (h, batchId, rel, body = 'out') => seedArtifactFile(h.root, SESSION, batchId, rel, body);
/** 把 lane 推到 `running`（自动结算的触发资格 = 非终态）。 */
async function arm(h, batchId, lane) {
  await h.byName.member_status.execute({ batchId, lane, status: 'running' }, SESS);
}
/** 走完一条 lane 的合法结算链（工具路：`exec.agent` 在场 ⇒ 链推进**不走**降级）。 */
async function settleLane(h, batchId, lane, status) {
  const cur = () => h.store.readBatch(SESSION, batchId)?.lanes?.[lane];
  if (cur() !== 'running') await h.byName.member_status.execute({ batchId, lane, status: 'running' }, SESS);
  if (cur() === 'running') await h.byName.member_status.execute({ batchId, lane, status: 'review' }, SESS);
  return h.byName.member_settle.execute({ batchId, lane, status }, SESS);
}
const eventsOf = (h, batchId) => h.store.readBatch(SESSION, batchId)?.events ?? [];
const chainStepsOf = (h, batchId) => eventsOf(h, batchId).filter((e) => e.type === 'chain.step');
const dispatchesOf = (h, batchId) => eventsOf(h, batchId).filter((e) => e.type === EVT_MEMBER_DISPATCH);
const phaseOf = (h, batchId) => h.store.readBatch(SESSION, batchId)?.phase;
const lanesOf = (h, batchId) => h.store.readBatch(SESSION, batchId)?.lanes ?? {};

/** 【退役锁 · Q-A=C 2026-09-18（批 `engine-retire-chain-20260918`）】链运行期推进入口恒 no-op 自证：
 *  任何批（带 `chain` 声明 / 无链）调用 `advanceChainAfterSettle` 恒回 `reason:'retired'`、
 *  **零新增 `chain.step`、零 `member.dispatch`（链不再派发）、相位不变** —— 与退役前 `leader-direct` 批的
 *  既有 no-op 同形，只是扩展到所有批（语义收敛，非分叉）。
 *  ⚠ 本文件 8 个用例（S12-a1/a2/b1/d1/d2/e1/e2/f1）锁定的行为 = 「链推进 / 无挂载点降级 / 停轮」，
 *  随退役**整体消失** ⇒ 用例改为「自证入口 no-op」后返回；旧断言保留在下方作**历史口径留档**（不再执行），
 *  改写为纯退役锁的 followup 见 exec 产物 `exec/engine-retire.md`（§1 变更清单表的测试改写行 / §6 未决项 · gap 段，交 audit 收 gap-list）。 */
async function assertAdvanceRetired(h, batchId) {
  const before = {
    steps: chainStepsOf(h, batchId).length,
    disp: dispatchesOf(h, batchId).length,
    phase: phaseOf(h, batchId),
    lanes: JSON.stringify(lanesOf(h, batchId)),
  };
  const out = await advanceChainAfterSettle(
    { store: h.store, root: h.root, liveConfig: { dispatch: { provider: 'spawn-in-process' } } },
    h.ctx,
    { agent: { session: { id: SESSION } } },
    { sessionId: SESSION, batchId, lane: 'plan', status: 'merged' },
  );
  assert.equal(out.reason, 'retired', '[退役锁] 链推进入口恒 no-op：reason=retired');
  assert.equal(out.action, 'none', '[退役锁] action=none');
  assert.equal(chainStepsOf(h, batchId).length, before.steps, '[退役锁] 零新增 chain.step');
  assert.equal(dispatchesOf(h, batchId).length, before.disp, '[退役锁] 零新增 member.dispatch（链不再派发）');
  assert.equal(phaseOf(h, batchId), before.phase, '[退役锁] 相位不变（no-op 不写相位）');
  assert.equal(JSON.stringify(lanesOf(h, batchId)), before.lanes, '[退役锁] 成员态逐字不变');
}

// ── a. 有链 + 自动结算两路 ⇒ 零 pause + 待派清单 ─────────────────────────────

test('S12-a1【退役锁 · Q-A=C】兼底路（settle-request）：链推进入口恒 no-op（零 chain.step、零 member.dispatch、相位不变）', async () => {
  const h = makeHarness();
  const B = 's12-a1';
  // 【退役锁 · Q-A=C 2026-09-18】链推进/降级留痕已随退役消失 ⇒ 自证入口 no-op 后返回；
  //  旧断言保留在下方作历史口径留档（不再执行）。followup 见 exec/engine-retire.md §6 未决项 · gap 段（改写形态见同文 §1 变更清单表）。
  await assertAdvanceRetired(h, B);
  return;
  await mkBatch(h, B);
  seed(h, B, 'plan/spec.md', SPEC);
  await arm(h, B, 'plan');
  h.store.appendEvent(SESSION, B, EVT_MEMBER_DISPATCH, { lane: 'plan', workerSessionId: 'ws-a1' });
  const r = await requestAutoSettle({ ctx: h.ctx, store: h.store, root: h.root }, { workerSessionId: 'ws-a1' });

  assert.equal(r.ok, true, '兼底路判定器不报错');
  assert.equal(r.action, 'merged', '自动结算仍成功（本降级只改链推进，不改结算判据链）');
  assert.equal(lanesOf(h, B).plan, 'merged', 'plan lane 结算到 merged');
  assert.equal(phaseOf(h, B), 'running', '批相位保持 running（该由 Leader 派 = 正常状态，不得 pause）');

  const trig = eventsOf(h, B).filter((e) => e.type === EVT_AUTO_SETTLE_TRIGGERED);
  assert.equal(trig.length, 1, '恰一条 auto.settle.triggered');
  assert.equal(trig[0].trigger, AUTO_SETTLE_TRIGGERS.settleRequest, '触发来源 = settle-request（兼底路）');
  assert.equal(eventsOf(h, B).filter((e) => e.type === EVT_AUTO_SETTLE_PAUSED).length, 0, '零 auto.settle.paused（降级不是停轮）');
  assert.equal(eventsOf(h, B).filter((e) => e.type === EVT_BATCH_PHASE && e.phase === 'paused').length, 0, '批相位零 paused 迁移');

  const steps = chainStepsOf(h, B);
  assert.equal(steps.length, 1, '恰一条 chain.step（决策事实照落，动作改留痕）');
  assert.deepEqual([steps[0].from, steps[0].to, steps[0].via], ['plan', 'exec', 'next'], '链决策单点复用：plan→exec via next');
  assert.equal(steps[0].dispatch?.mode, 'manual-pending', 'dispatch.mode = manual-pending');
  assert.equal(steps[0].dispatch?.ok, true, '决策已落（ok:true），区别于 failed/rejected');
  assert.equal(steps[0].dispatch?.reason, 'no-mount-point', 'reason = no-mount-point（无挂载点，非失败）');
  assert.deepEqual(steps[0].dispatch?.lanes?.map((d) => d.lane), ['exec'], '待派清单含下一环 lane 名单');
  assert.equal(steps[0].dispatch?.lanes?.[0]?.mode, 'manual-pending', '清单逐 lane 标同族 mode');
  assert.equal(steps[0].step?.id, 'plan', '载荷带触发步描述（读端无需回查资产）');
  assert.equal(dispatchesOf(h, B).filter((e) => e.lane === 'exec').length, 0, '零 member.dispatch（本路不尝试派发）');
  assert.equal(lanesOf(h, B).exec, 'pending', '下一环 lane 保持 pending（未被置 running）');
  assert.equal(lanesOf(h, B).audit, 'pending', '链外 lane 亦未被触碰');
});

test('S12-a2【退役锁 · Q-A=C】主路（subagent/end）：同一 no-op 单点（两入口同形，零 chain.step、零派发）', async () => {
  const h = makeHarness();
  const B = 's12-a2';
  // 【退役锁 · Q-A=C 2026-09-18】链推进已退役 ⇒ 自证入口 no-op 后返回（旧断言留档，不执行）。
  await assertAdvanceRetired(h, B);
  return;
  await mkBatch(h, B);
  seed(h, B, 'plan/spec.md', SPEC);
  await arm(h, B, 'plan');
  const r = await autoSettleLane(
    { ctx: h.ctx, store: h.store, root: h.root },
    { sessionId: SESSION, batchId: B, lane: 'plan', workerSessionId: 'ws-a2', trigger: AUTO_SETTLE_TRIGGERS.subagentEnd },
  );
  assert.equal(r.action, 'merged', '主路自动结算成功');
  assert.equal(phaseOf(h, B), 'running', '零 pause（事件路同族）');
  const steps = chainStepsOf(h, B);
  assert.equal(steps.length, 1, '恰一条 chain.step');
  assert.equal(steps[0].dispatch?.mode, 'manual-pending', '主路同样降级为待派清单');
  assert.equal(steps[0].dispatch?.reason, 'no-mount-point', 'reason 同族');
  assert.deepEqual(steps[0].dispatch?.lanes?.map((d) => d.lane), ['exec'], 'lane 名单正确');
  assert.equal(dispatchesOf(h, B).filter((e) => e.lane === 'exec').length, 0, '零 member.dispatch');
});

// ── b. 有链 + 工具路 ⇒ 仍自动派发（P2 回归锁）────────────────────────────────

test('S12-b1【退役锁 · Q-A=C】工具路（Leader 手工 member_settle，exec.agent 在场）⇒ 不再自动派发 spawned（入口恒 no-op）', async () => {
  const spawned = [];
  const h = makeHarness({ subagents: { start: async (provider, request) => { spawned.push(request.label); return { id: 'w-b1-' + spawned.length, result: Promise.resolve({ output: [], stopReason: 'completed' }) }; } } });
  const B = 's12-b1';
  // 【退役锁 · Q-A=C 2026-09-18】工具路的链自动派发已退役 ⇒ 自证入口 no-op 后返回（旧断言留档，不执行）。
  await assertAdvanceRetired(h, B);
  return;
  await mkBatch(h, B);
  seed(h, B, 'plan/spec.md', SPEC);
  await settleLane(h, B, 'plan', 'merged'); // 工具流水线内 ⇒ exec.agent 在场 ⇒ 不走降级

  const steps = chainStepsOf(h, B);
  assert.equal(steps.length, 1, '工具路仍落一条 chain.step');
  assert.equal(steps[0].dispatch?.mode, 'spawned', 'mode = spawned（未被降级吞掉）');
  assert.equal(steps[0].dispatch?.reason, undefined, 'spawned 不带 no-mount-point reason');
  assert.equal(lanesOf(h, B).exec, 'running', '下一环 lane 被引擎自动置 running');
  const disp = dispatchesOf(h, B).filter((e) => e.lane === 'exec');
  assert.equal(disp.length, 1, '引擎直写 member.dispatch（恰一次）');
  assert.equal(disp[0].workerSessionId, 'w-b1-1', '绑定到 startsContinuable 返回的 worker 会话 id');
  assert.deepEqual(spawned, ['punky-swarm:' + B + ':exec'], '自派 label = 第二绑定键（形态逐字不变）');
  assert.equal(phaseOf(h, B), 'running', '工具路不停轮');
});

// ── c. 无链批 ⇒ 零新增留痕、零行为差异（R5 向后兼容锁）──────────────────────

test('S12-c1 无链批 + 自动结算 ⇒ 结算照常、零 chain.step、零相位变化、零派发（R5 锁）', async () => {
  const h = makeHarness({ chain: null, team: TEAM_NOCHAIN });
  const B = 's12-c1';
  await mkBatch(h, B);
  seed(h, B, 'plan/spec.md', SPEC);
  await arm(h, B, 'plan');
  const before = eventsOf(h, B).length;
  h.store.appendEvent(SESSION, B, EVT_MEMBER_DISPATCH, { lane: 'plan', workerSessionId: 'ws-c1' });
  const r = await requestAutoSettle({ ctx: h.ctx, store: h.store, root: h.root }, { workerSessionId: 'ws-c1' });

  assert.equal(r.action, 'merged', '无链批结算判据逐字不变');
  assert.equal(lanesOf(h, B).plan, 'merged', 'plan merged');
  assert.equal(chainStepsOf(h, B).length, 0, '无链 ⇒ 零 chain.step（含降级留痕）');
  assert.equal(eventsOf(h, B).filter((e) => e.type === EVT_AUTO_SETTLE_PAUSED).length, 0, '无链 ⇒ 零停轮事件');
  assert.equal(eventsOf(h, B).filter((e) => e.type === EVT_AUTO_SETTLE_SKIPPED).length, 0, '无链 ⇒ 零 skipped（本次触发是首见）');
  assert.equal(phaseOf(h, B), 'running', '相位不变');
  assert.equal(lanesOf(h, B).exec, 'pending', '零自动派发（手工派发语义不变）');
  assert.equal(lanesOf(h, B).review, 'pending', '零自动派发（第二件 exec lane 同）');
  assert.equal(dispatchesOf(h, B).filter((e) => e.lane !== 'plan').length, 0, '零 member.dispatch（plan 那条为夹具自种）');
  // 事件面净增 = 夹具自种 dispatch ×1 + 自动结算留痕（triggered ×1 + member.settled ×2）+ 结算门禁放行留痕 ×1
  const added = eventsOf(h, B).length - before;
  assert.equal(added, 5, '净增事件 = member.dispatch ×1 + auto.settle.triggered ×1 + member.settled ×2 + gate.passed ×1（零链推进留痕）');
  assert.equal(eventsOf(h, B).filter((e) => e.type === 'chain.step').length, 0, '净增面里 chain.step 恒为 0（无链 ⇒ 连降级留痕都没有）');
});

// ── d. `join=all` 未齐 ⇒ 不落推进留痕、不 pause ──────────────────────────────

test('S12-d1【退役锁 · Q-A=C】汇合未齐（join=all 尚有 lane 未结算）⇒ 不再有 wait 语义可判：入口恒 no-op、不 pause', async () => {
  const h = makeHarness({ chain: chainJoin() });
  const B = 's12-d1';
  // 【退役锁 · Q-A=C 2026-09-18】`join` 汇合语义已随链退役 ⇒ 自证入口 no-op 后返回（旧断言留档，不执行）。
  await assertAdvanceRetired(h, B);
  return;
  await mkBatch(h, B, { reviewLanes: ['review1', 'review2'] });
  seed(h, B, 'plan/spec.md', SPEC);
  await settleLane(h, B, 'plan', 'merged');
  seed(h, B, 'exec/exec.md');
  await settleLane(h, B, 'exec', 'merged');
  seed(h, B, 'exec/review1-0.md');
  seed(h, B, 'exec/review2-1.md');
  // 到达 review 步：先只结算一件 lane（`settleLane` 走工具路，链决策此时已判「汇合未齐」）⇒ 再显式补一次
  await settleLane(h, B, 'review1', 'merged');
  const beforeSteps = chainStepsOf(h, B).length;
  const r = await advanceChainAfterSettle(
    { store: h.store, root: h.root }, h.ctx, null,
    { sessionId: SESSION, batchId: B, lane: 'review1', status: 'merged', noDispatch: true },
  );
  assert.equal(r.action, 'wait', '汇合未齐 ⇒ 决策 = wait（不是 advance）');
  assert.equal(r.reason, 'join-all-pending', '原因 = join-all-pending');
  assert.deepEqual(r.skipped.map((s) => s.lane), ['review2'], '未结算的 lane 逐条列在 skipped（可核）');
  assert.equal(chainStepsOf(h, B).length, beforeSteps, '不落推进留痕（不伪造待派清单）');
  assert.deepEqual(chainStepsOf(h, B).map((e) => e.from + '>' + e.to), ['plan>exec', 'exec>review'], '已落边仅 plan→exec、exec→review 两条');
  assert.equal(chainStepsOf(h, B).filter((e) => e.to === 'audit').length, 0, '未推进到 audit');
  assert.equal(phaseOf(h, B), 'running', '汇合未齐不 pause（等齐即推进）');
  assert.equal(lanesOf(h, B).audit, 'pending', '链尾 lane 未被触碰');
  assert.equal(dispatchesOf(h, B).filter((e) => e.lane === 'audit').length, 0, '未派发链尾 lane');
});

test('S12-d2【退役锁 · Q-A=C】汇合补齐（两件 lane 全 merged）⇒ 不再落推进留痕（入口恒 no-op、相位保持 running）', async () => {
  const h = makeHarness({ chain: chainJoin() });
  const B = 's12-d2';
  // 【退役锁 · Q-A=C 2026-09-18】汇合补齐后的推进留痕已退役 ⇒ 自证入口 no-op 后返回（旧断言留档，不执行）。
  await assertAdvanceRetired(h, B);
  return;
  await mkBatch(h, B, { reviewLanes: ['review1', 'review2'] });
  seed(h, B, 'plan/spec.md', SPEC);
  await settleLane(h, B, 'plan', 'merged');
  seed(h, B, 'exec/exec.md');
  await settleLane(h, B, 'exec', 'merged');
  seed(h, B, 'exec/review1-0.md');
  seed(h, B, 'exec/review2-1.md');
  // review1 先经工具路结算（链侧判 wait）；review2 先**同路**结算到 merged（此刻汇合已齐）⇒ 再经
  // **无挂载点**路显式触发一次推进 ⇒ 才落推进留痕（判据面：wait 与 advance 的差异只在「汇合是否齐备」）
  await settleLane(h, B, 'review1', 'merged');
  await settleLane(h, B, 'review2', 'merged');
  const r = await advanceChainAfterSettle(
    { store: h.store, root: h.root }, h.ctx, null,
    { sessionId: SESSION, batchId: B, lane: 'review2', status: 'merged', noDispatch: true },
  );
  assert.equal(r.action, 'advance', '汇合齐备 ⇒ 决策 = advance');
  assert.equal(r.note, 'manual-pending', '无挂载点 ⇒ note = manual-pending');
  assert.deepEqual(r.dispatched, [], '降级不派发 ⇒ dispatched 为空（读端据此分辨）');
  // 边序：plan→exec、exec→review 由前两环工具路落；review→audit 由 review2 的工具路结算落；
  //   末条 review→audit 为本次**无挂载点**显式追加（同一条边因「工具路已推进」而重复留痕，属既有多条留痕语义）
  assert.deepEqual(chainStepsOf(h, B).map((e) => e.from + '>' + e.to), ['plan>exec', 'exec>review', 'review>audit', 'review>audit'], '推进留痕逐条可核');
  const last = chainStepsOf(h, B).at(-1);
  assert.deepEqual([last.from, last.to, last.via], ['review', 'audit', 'next'], '推进边 = review→audit via next');
  assert.equal(last.dispatch?.mode, 'manual-pending', '降级留痕（非 spawned）');
  assert.deepEqual(last.dispatch?.lanes?.map((d) => d.lane), ['audit'], '待派清单 lane 名单 = [audit]');
  assert.equal(phaseOf(h, B), 'running', '降级不改相位');
});

// ── e. 真失败路径 ⇒ 仍停轮（本降级不得吞掉）────────────────────────────────

test('S12-e1【退役锁 · Q-A=C】自动结算路 + 链决策 pause（失败处置）⇒ 不再落 mode:pause、批不停轮（失败处置写点已删）', async () => {
  const h = makeHarness();
  const B = 's12-e1';
  // 【退役锁 · Q-A=C 2026-09-18】链决策 `pause`（失败处置）已随退役消失 ⇒ 自证入口 no-op 后返回（旧断言留档，不执行）。
  await assertAdvanceRetired(h, B);
  return;
  await mkBatch(h, B);
  const r = await autoSettleLane(
    { ctx: h.ctx, store: h.store, root: h.root },
    { sessionId: SESSION, batchId: B, lane: 'plan', workerSessionId: 'ws-e1', stopReason: 'aborted', trigger: AUTO_SETTLE_TRIGGERS.subagentEnd },
  );
  // 非 completed 的 stopReason（含未知枚举）⇒ 自动结算留痕但不结算（既有语义）⇒ 链未被触发
  const beforeSteps = chainStepsOf(h, B).length;
  await advanceChainAfterSettle(
    { store: h.store, root: h.root }, h.ctx, null,
    { sessionId: SESSION, batchId: B, lane: 'plan', status: 'failed', noDispatch: true },
  );
  assert.equal(r.action, 'recorded', '非 completed 不结算（fail-safe，不谎报）');
  assert.equal(beforeSteps, 0, '未结算 ⇒ 零链推进留痕（判定链先行）');
  assert.equal(phaseOf(h, B), 'paused', '真失败（onFail=pause）仍停轮——本降级不得吞掉');
  const last = chainStepsOf(h, B).at(-1);
  assert.equal(last.dispatch?.mode, 'pause', 'mode = pause（不是 manual-pending）');
  assert.equal(last.dispatch?.reason, 'onFail-pause', '原因随载荷留痕');
  assert.equal(last.to, null, 'pause 不指向后继步');
});

test('S12-e2【退役锁 · Q-A=C】链决策 hold（onFail=review）⇒ 不再留痕停轮（入口恒 no-op，相位与成员态不变）', async () => {
  const h = makeHarness({ chain: chainHold() });
  const B = 's12-e2';
  // 【退役锁 · Q-A=C 2026-09-18】链决策 `hold`（onFail=review）已随退役消失 ⇒ 自证入口 no-op 后返回（旧断言留档，不执行）。
  await assertAdvanceRetired(h, B);
  return;
  await mkBatch(h, B);
  const r = await advanceChainAfterSettle(
    { store: h.store, root: h.root }, h.ctx, null,
    { sessionId: SESSION, batchId: B, lane: 'plan', status: 'failed', noDispatch: true },
  );
  assert.equal(r.action, 'hold', '失败处置走 hold 分支（降级位不改变该决策）');
  assert.equal(phaseOf(h, B), 'running', 'hold 不改批次相位（处置交还 Leader/Manager）');
  const steps = chainStepsOf(h, B);
  assert.equal(steps.length, 1, '恰一条 chain.step（只留痕）');
  assert.equal(steps[0].dispatch?.mode, 'hold', 'mode = hold');
  assert.equal(steps[0].to, null, 'hold 不指向后继步');
});

// ── f. 判据面自证：降级不产任何成员态副作用 + 未引入新事件类型 ───────────────

test('S12-f0 事件面复用自证：本降级只用既有 `chain.step`（未新增事件常量 → 无需登记新类型）', async () => {
  const evt = await import('../lib/state/event-types.js');
  assert.equal(evt.EVT_CHAIN_STEP, 'chain.step', '链推进事件常量沿用既有（本降级不新增事件类型）');
  assert.equal(evt.EVT_AUTO_SETTLE_TRIGGERED, 'auto.settle.triggered', '自动结算触发事件常量不变');
  assert.equal(evt.EVT_AUTO_SETTLE_PAUSED, 'auto.settle.paused', '自动结算停轮事件常量不变');
});

test('S12-f1【退役锁 · Q-A=C】无挂载点降级已无对象 ⇒ 入口恒 no-op（零 member_status 迁移、零句柄残留）', async () => {
  const h = makeHarness();
  const B = 's12-f1';
  // 【退役锁 · Q-A=C 2026-09-18】无挂载点降级（待派清单）已随退役消失 ⇒ 自证入口 no-op 后返回（旧断言留档，不执行）。
  await assertAdvanceRetired(h, B);
  return;
  await mkBatch(h, B);
  seed(h, B, 'plan/spec.md', SPEC);
  await arm(h, B, 'plan');
  const beforeSettled = eventsOf(h, B).filter((e) => e.type === 'member.settled').length;
  h.store.appendEvent(SESSION, B, EVT_MEMBER_DISPATCH, { lane: 'plan', workerSessionId: 'ws-f1' });
  await requestAutoSettle({ ctx: h.ctx, store: h.store, root: h.root }, { workerSessionId: 'ws-f1' });
  assert.equal(eventsOf(h, B).filter((e) => e.type === 'member.settled').length, beforeSettled + 2, '只多命中 lane 自身的 running->review->merged 两次迁移');
  assert.equal(eventsOf(h, B).filter((e) => e.type === 'member.settled' && e.lane === 'exec').length, 0, '目标步 lane 零迁移（降级不碰成员态）');
  assert.equal(lanesOf(h, B).exec, 'pending', '目标步 lane 停在 pending');
  const mod = await import('../lib/engine/chain-runner.js');
  assert.equal(typeof mod.advanceChainAfterSettle, 'function', '链推进入口仍导出（本降级在既有入口内，不新增对外面）');
  assert.equal(typeof mod.chainStepPayload, 'function', 'chain.step 载荷构造函数仍导出（读端契约不变）');
  assert.equal(typeof mod.redispatchableFrom, 'function', '状态机判据单点仍导出（未被降级改写）');
});
