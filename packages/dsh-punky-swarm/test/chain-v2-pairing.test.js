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

// test/chain-v2-pairing.test.js —— **Batch I Step 3：v2 分支配对的运行时判据锁**
// ─────────────────────────────────────────────────────────────────────────────
// 验收对象（`docs/chain-model-upgrade-spec-20260916.md §6-1/§6-2/§6-3`）：
//   ① **去屏障（核心）**：`perLane` 生效后，`exec_1` merged ⇒ **立即**推进并派 `audit_1`，
//      **不等**同层 `exec_2`（对照：v1 同拓扑下该跳是 `wait`，不落 `chain.step`、不派任何 lane）；
//   ② **一对一**：本跳只派**配对**的那一条 audit（`deps` 恰为 `[exec_1]`），不派 `audit_2`；
//   ③ **聚合等待**：perLane 步的各实例全 merged 后，才推进到聚合步（`accept`）；
//   ④ **落痕**：`chain.step.instance` = 被展开的上游 lane（v1 无该键 ⇒ 载荷逐字不变）。
//
// 夹具拓扑（层内并行链 + 层间汇合）：
//   plan ─next→ exec(join:all) ─next→ audit(**perLane:exec**) ─next→ accept(terminal)
//   lane：plan / exec_1 / exec_2（(exec,coder) 同一步）/ audit_1(deps:[exec_1]) / audit_2(deps:[exec_2])
//         / accept_lane((audit,supervisor) ⇒ 映射到聚合步)
//   ⚠ 聚合步与 perLane 步**必须不同 role**（reviewer vs supervisor）：`chainStepForLane` 的
//     `(layer,role)` 映射在「两个不同步共享同一 (layer,role)」时会判 `ambiguous-mapping` 停轮
//     （`chain.js:337-341`，既有边界，非本批改动范围）。
//
// 事实源纪律：断言一律读 `store.readBatch` 的批次 JSON（唯一事实源），不读模块内部状态。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../lib/state/store.js';
import { createTools } from '../lib/tools/register.js';
import { clearRoleCache } from '../lib/assembly/flows.js';
import { EVT_MEMBER_DISPATCH } from '../lib/state/event-types.js';
import { assessC } from './helpers/gate-fixture.mjs';
import { writeSyntheticTeam } from './helpers/team-fixture.mjs';
import { seedArtifactFile } from './helpers/gate-fixture.mjs';

const SESSION = 'sess-chain-v2';
const SESS = { agent: { session: { id: SESSION } } };
const SPEC = '# spec\n## 验收标准\n- x\n## 约束\n- y\n';
const LAYERS = {
  plan: { roles: ['designer'], skills: { designer: ['spec-writing'] } },
  exec: { roles: ['coder'], skills: { coder: ['dev-coder'] } },
  audit: { roles: ['reviewer', 'supervisor'], skills: { reviewer: ['review-execution'], supervisor: ['acceptance-gate'] } },
};
const ROLES = { plan_leads: ['designer'], audit_leads: ['supervisor'] };
const FLOWS = {
  plan: { produce_field: 'produce', entry_requires: [], contract: { artifact_globs: ['plan/*.md'], required_sections: ['## 验收标准', '## 约束'] } },
  exec: { produce_field: 'outputs', consume_field: 'consume', entry_requires: ['consume'] },
  audit: {
    produce_field: 'produce', consume_field: 'consume', entry_requires: ['consume'],
    audit_contract: { criteria_from: 'plan/spec.md', consumes_required: ['plan/', 'exec/'], verdict: ['pass', 'fail', 'skip'] },
  },
};

/** v2 链：层内并行链（exec 两条）+ 分支配对（audit perLane:exec）+ 聚合（accept）。 */
const chainV2 = () => ({
  version: 2,
  steps: [
    { id: 'plan', layer: 'plan', role: 'designer', next: 'exec' },
    { id: 'exec', layer: 'exec', role: 'coder', join: 'all', next: 'audit' },
    { id: 'audit', layer: 'audit', role: 'reviewer', perLane: 'exec', next: 'accept' },
    { id: 'accept', layer: 'audit', role: 'supervisor', join: 'all', terminal: true },
  ],
  join: { anyFailure: 'pause' },
  onFail: 'pause',
});
/** v1 对照链：**同一拓扑但无 `perLane`**（差异只在「有无配对展开」）——用于证明屏障的存在。 */
const chainV1 = () => ({
  version: 1,
  steps: [
    { id: 'plan', layer: 'plan', role: 'designer', next: 'exec' },
    { id: 'exec', layer: 'exec', role: 'coder', join: 'all', next: 'audit' },
    { id: 'audit', layer: 'audit', role: 'reviewer', join: 'all', next: 'accept' },
    { id: 'accept', layer: 'audit', role: 'supervisor', terminal: true },
  ],
  join: { anyFailure: 'pause' },
  onFail: 'pause',
});

const tasksOf = () => [
  { id: 'plan', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
  { id: 'exec_1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/exec_1.md'], cmd: 'e1' },
  { id: 'exec_2', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/exec_2.md'], cmd: 'e2' },
  { id: 'audit_1', layer: 'audit', role: 'reviewer', consume: ['plan/spec.md', 'exec/exec_1.md'], produce: ['audit/audit_1.md'], deps: ['exec_1'], cmd: 'a1' },
  { id: 'audit_2', layer: 'audit', role: 'reviewer', consume: ['plan/spec.md', 'exec/exec_2.md'], produce: ['audit/audit_2.md'], deps: ['exec_2'], cmd: 'a2' },
  { id: 'accept_lane', layer: 'audit', role: 'supervisor', consume: ['plan/spec.md', 'audit/audit_1.md', 'audit/audit_2.md'], produce: ['audit/accept.md'], deps: ['audit_1', 'audit_2'], cmd: 'accept' },
];

function makeHarness(chain) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-v2-'));
  const store = createStore(root);
  const ctx = { tools: { register: () => {} }, logger: { info() {}, warn() {}, error() {} } };
  const teamsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-v2-teams-'));
  const team = 'v2-team';
  const asset = { team, layers: LAYERS, roles: ROLES, flows: FLOWS, chain };
  // F2：合成资产 ⇒ 单点写入（helpers/team-fixture.mjs）。
  writeSyntheticTeam(teamsRoot, team, asset);
  clearRoleCache();
  const { tools } = createTools(ctx, { store, root, config: { dispatch: { provider: 'spawn-in-process' } } });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assessC(store, SESSION, { rationale: 'fixture：v2 分支配对 e2e 用例的建批前置评估（三层多依赖 ⇒ C 档）' });
  return { root, store, byName, teamsRoot, team };
}

async function mkBatch(h, batchId) {
  await h.byName.wave_plan.execute({
    batchId, team: h.team, teamsRoot: h.teamsRoot, tasks: tasksOf(),
    // 【M0′-① 联动（2026-09-17 批 `handoff-consolidation-m0m1-20260917`）】原为 `leader-direct`；
    //   该形态自 M0′-① 起链推进**全程 no-op**（引擎无自派能力的形态由 Leader 直驱）⇒ 本套件断言
    //   「运行期 DAG 真源 = `lanes[].deps`（分支配对/去屏障）」必须取非 leader-direct 形态（`raise` = 缺省）。
    assembly: { managerPlan: 'raise', auditLane: 'accept_lane' },
  }, SESS);
  await h.byName.batch_phase.execute({ batchId, phase: 'running' }, SESS);
}
// F3：收敛为单点（夹具审计 §3.3 必合档：5 份函数体逐字相同）⇒ 本文件只留 `SESSION` 绑定适配。
const seed = (h, batchId, rel, body = 'out') => seedArtifactFile(h.root, SESSION, batchId, rel, body);
async function settleLane(h, batchId, lane, status = 'merged') {
  const cur = () => h.store.readBatch(SESSION, batchId)?.lanes?.[lane];
  if (cur() !== 'running') await h.byName.member_status.execute({ batchId, lane, status: 'running' }, SESS);
  if (cur() === 'running') await h.byName.member_status.execute({ batchId, lane, status: 'review' }, SESS);
  return h.byName.member_settle.execute({ batchId, lane, status }, SESS);
}
const eventsOf = (h, b) => h.store.readBatch(SESSION, b)?.events ?? [];
const chainStepsOf = (h, b) => eventsOf(h, b).filter((e) => e.type === 'chain.step');
const dispatchedLanes = (h, b) => eventsOf(h, b).filter((e) => e.type === EVT_MEMBER_DISPATCH).map((e) => e.lane);
const lanesOf = (h, b) => h.store.readBatch(SESSION, b)?.lanes ?? {};

test('V2R-1【退役锁 · Q-A=C】去屏障（核心）已无对象：exec_1 merged ⇒ 不再推进派 audit_1（零 chain.step、零新增派发）', async () => {
  const h = makeHarness(chainV2());
  const B = 'v2r-1';
  await mkBatch(h, B);
  seed(h, B, 'plan/spec.md', SPEC);
  await settleLane(h, B, 'plan');
  seed(h, B, 'exec/exec_1.md');
  await settleLane(h, B, 'exec_1');
  // 【退役锁 · Q-A=C 2026-09-18（批 engine-retire-chain-20260918）】链运行期推进（v2 分支配对 `perLane`）已退役
  //  ⇒ 自证「零 chain.step / 零新增派发」后返回；旧断言保留在下方作历史口径留档（不再执行）。
  assert.equal(chainStepsOf(h, B).length, 0, '[退役锁] 零 chain.step（推进留痕写点已删）');
  assert.equal(dispatchedLanes(h, B).length, 0, '[退役锁] 零新增派发（链不再派发）');
  assert.ok(lanesOf(h, B).audit_1 !== 'running', '[退役锁] 配对下游 lane 不再被引擎自动置 running');
  return;

  const l = lanesOf(h, B);
  assert.equal(l.exec_1, 'merged', 'exec_1 已 merged');
  assert.ok(l.exec_2 === 'running' || l.exec_2 === 'pending', 'exec_2 尚未 merged（对照组存在）：' + l.exec_2);

  const fromExec = chainStepsOf(h, B).filter((e) => e.from === 'exec');
  assert.equal(fromExec.length, 1, '恰一条 exec 触发的 chain.step（不等汇合 —— 这正是去屏障）');
  assert.equal(fromExec[0].to, 'audit', '推进目标 = 配对步 audit');
  assert.equal(fromExec[0].lane, 'exec_1', 'lane = 触发分支（上游 lane）');
  assert.equal(fromExec[0].instance, 'audit_1', 'instance = 本次推进建立/推进的**目标实例**（配对的下游 lane）——'
    + '与 `lane` 各司其职：前者答「为哪条分支建了哪个实例」，后者答「谁触发的」');

  // 派发面读 `chain.step.dispatch`（引擎「决定派谁」的权威记录）。夹具未提供 `ctx.subagents`
  //   ⇒ `dispatchLaneCore` 按设计**降级为「仅发句柄」**（不写 `member.dispatch`）——故此处不读事件面。
  const d = fromExec[0].dispatch ?? {};
  const dispatched = (d.lanes ?? []).map((x) => x.lane);
  assert.deepEqual(dispatched, ['audit_1'], '只派配对的那一条 audit（不派 audit_2）：' + JSON.stringify(dispatched));
  assert.equal(d.mode, 'handle-only', '夹具无 subagents ⇒ 降级「仅发句柄」（既有降级语义，非本批改动）');
});

test('V2R-2 正向反例：同一拓扑的 v1 链 ⇒ exec_1 merged 后是 wait（屏障存在，不落 chain.step、不派 lane）', async () => {
  const h = makeHarness(chainV1());
  const B = 'v2r-2';
  await mkBatch(h, B);
  seed(h, B, 'plan/spec.md', SPEC);
  await settleLane(h, B, 'plan');
  const before = chainStepsOf(h, B).length;
  const dispBefore = dispatchedLanes(h, B).length;
  seed(h, B, 'exec/exec_1.md');
  await settleLane(h, B, 'exec_1');

  assert.equal(chainStepsOf(h, B).length, before, 'v1 下 exec_1 单独 merged **不推进**（join:all 未齐 ⇒ wait）');
  assert.equal(dispatchedLanes(h, B).length, dispBefore, 'v1 下零新增派发（对照：v2 会派 audit_1）');
  assert.ok(!chainStepsOf(h, B).some((e) => e.from === 'exec'), 'v1 不得出现 exec 触发的 chain.step');
});

test('V2R-3【退役锁 · Q-A=C】聚合等待已无对象：perLane 各实例全 merged ⇒ 不再推进到 accept（零 chain.step、零新增派发）', async () => {
  const h = makeHarness(chainV2());
  const B = 'v2r-3';
  await mkBatch(h, B);
  seed(h, B, 'plan/spec.md', SPEC);
  await settleLane(h, B, 'plan');
  seed(h, B, 'exec/exec_1.md');
  seed(h, B, 'exec/exec_2.md');
  await settleLane(h, B, 'exec_1');
  await settleLane(h, B, 'exec_2');
  // 此刻 audit_1/audit_2 已被配对派出（或被置 running）；逐条结算
  seed(h, B, 'audit/audit_1.md');
  await settleLane(h, B, 'audit_1');
  assert.ok(!chainStepsOf(h, B).some((e) => e.from === 'audit'), 'audit_1 单独 merged ⇒ 未齐，不推进到 accept');
  seed(h, B, 'audit/audit_2.md');
  await settleLane(h, B, 'audit_2');
  // 【退役锁 · Q-A=C 2026-09-18】聚合步推进（`join` 汇合）已随链退役消失 ⇒ 自证「零 chain.step」后返回（旧断言留档）。
  assert.equal(chainStepsOf(h, B).length, 0, '[退役锁] 零 chain.step（聚合推进写点已删）');
  assert.equal(dispatchedLanes(h, B).length, 0, '[退役锁] 零新增派发');
  return;
  const fromAudit = chainStepsOf(h, B).filter((e) => e.from === 'audit');
  assert.equal(fromAudit.length, 1, 'audit 两实例全 merged ⇒ 恰一次推进');
  assert.equal(fromAudit[0].to, 'accept', '推进到聚合步 accept');
  assert.ok(!('instance' in fromAudit[0]) || fromAudit[0].instance === null || fromAudit[0].instance === undefined,
    '聚合步的触发不是 perLane 展开 ⇒ 不带 instance（判据 = 触发步自身有无 perLane 后继）');
});
