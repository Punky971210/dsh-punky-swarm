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

// P2 推进链（`chain` 自动递进）+ P0 句柄修复 —— 用例面（批 `p2-chain-autodrive-20260916` · lane `e-tests`）。
// ─────────────────────────────────────────────────────────────────────────────
// 契约来源：本批 `plan/spec.md`（§chain 声明格式 / §推进规则 / §P0 句柄修复 / §事件面 / §验收标准）。
// 覆盖（逐条对齐 spec §验收标准 1–5 + Leader 补充的 G-3）：
//   ① 自动递进正向：声明五段链（`plan→exec→tester→review→audit`），`plan` merged ⇒ 引擎**逐环自动派发**至链尾，
//      主 Agent 零派发 / 零结算；每步落一条 `chain.step`，`batch_status` 回显可复原全链；
//   ② 三反例（构造期拒 + **零批次 JSON 落盘**）：环未被 `rework` 承认 / `join:any` 缺 `anyFailure` / 链尾不唯一；
//   ③ 句柄零残留：成功自派 ⇒ `pendingHandles()` 无该 `(batchId,lane)`；降级「仅发句柄」路径句柄仍 `verifyLaneHandle` 通过；
//   ④ `>30min` 活跃 lane 零假 gap：有 `member.dispatch` 且 `workerSessionId` 非空 ⇒ 不报 `token-ttl-expired`；
//   ⑤ 无 `chain` ⇒ 现行 3 层行为不变（向后兼容锁：不写 `chain.step` / 不改相位 / 不自动派发 / 读端无 `chain` 键）；
//   ⑥ G-3：**有资产但无 `flows.audit`** + 含 audit lane ⇒ 零感知跳过（不拒、不落 `GATE_AUDIT_CONTRACT_*`）；
//   ⑦ **M0′-① 追加面**（2026-09-17 批 `handoff-consolidation-m0m1-20260917`）：`managerPlan:'leader-direct'`
//      批链推进**全程 no-op** + `raise` 对照（旧行为保留）+ **无 `assembly` 历史批**不命中 M0′ 分支。
// 独立性：本套件自带夹具与断言，**不依赖** e-chain 的定向探针（`exec/probe/chain-probe.mjs`，仅作行为参照），
//   即令探针不跑也能独立判定 P2 的验收面。
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { createTools } from '../lib/tools/register.js';
import { clearRoleCache } from '../lib/assembly/flows.js';
import { validateChain, resolveChainOf, chainStepForLane, chainNextOf, loadChainOf, RETIRED_CHAIN_KEYS } from '../lib/assembly/chain.js';
import { advanceChainAfterSettle } from '../lib/engine/chain-runner.js';
import { EVT_BATCH_PHASE } from '../lib/state/event-types.js';
import { bindingGapOf } from '../lib/watch/lane-heartbeat.js';
import {
  __resetLaneHandles, pendingHandles, verifyLaneHandle, issueLaneHandle, LANE_HANDLE_TTL_MS,
} from '../lib/bridge/lane-handle.js';
import { assessC, threeTierTasks } from './helpers/gate-fixture.mjs';
import { writeSyntheticTeam } from './helpers/team-fixture.mjs';
import { seedArtifactFile } from './helpers/gate-fixture.mjs';

const SESSION = 'sess-p2-chain';
const SESS = { agent: { session: { id: SESSION } } };
const TEAM = 'p2-chain-team';
const SPEC = '# spec\n## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准\n- x\n## 约束\n- y\n';

// ── 夹具：三层 × 五段链（含 `tester`/`review`：spec §缺省链口径明示「由团队资产各自声明，非引擎缺省」）──
const LAYERS = {
  plan: { roles: ['designer'], skills: { designer: ['spec-writing'] } },
  exec: { roles: ['coder', 'tester', 'reviewer'], skills: { coder: ['dev-coder'], tester: ['dev-tester'], reviewer: ['review-execution'] } },
  audit: { roles: ['reviewer'], skills: { reviewer: ['acceptance-gate'] } },
};
const ROLES = { plan_leads: ['designer'], audit_leads: ['reviewer'] };

/** flows 面：`audit:false` 用于 G-3（有资产但**无** `flows.audit`）。 */
function flowsOf({ audit = true } = {}) {
  const flows = {
    plan: { produce_field: 'produce', entry_requires: [], contract: { artifact_globs: ['plan/*.md'], required_sections: ['## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准', '## 约束'] } },
    exec: { produce_field: 'outputs', consume_field: 'consume', entry_requires: ['consume'] },
  };
  if (audit) {
    flows.audit = {
      produce_field: 'produce', consume_field: 'consume', entry_requires: ['consume'],
      audit_contract: { criteria_from: 'plan/spec.md', consumes_required: ['plan/', 'exec/'], verdict: ['approve', 'reject'] },
    };
  }
  return flows;
}

/** 五段链（`plan→exec→tester→review→audit`，**`next`-only**）。
 *  【M1 改写（2026-09-17 批 `handoff-consolidation-m0m1-20260917`）】原 `review` 步用步级条件边
 *  `on:{merged:'audit', fail:'exec'}`（合并 = 正路 + 回边 = 失败面）。M1 把该声明面整体下线
 *  （声明即拒）⇒ 链改为 `next:'audit'`；**回边语义**改由 v2 的 `deps` 拓扑面表达（见下方 `chainCyclic()`，
 *  专供「环须由 `rework` 承认」用例）。`rework` 声明保留（对无环链是**声明位**，不产生问题）。
 *  【2026-09-18 清债轮】原夹带的 `needHuman: ['audit']` 已删——该键退役后**声明即拒**（见 P2-1b）。 */
function chain5() {
  return {
    version: 1,
    steps: [
      { id: 'plan', layer: 'plan', role: 'designer', next: 'exec' },
      { id: 'exec', layer: 'exec', role: 'coder', join: 'all', next: 'tester' },
      { id: 'tester', layer: 'exec', role: 'tester', join: 'all', next: 'review' },
      { id: 'review', layer: 'exec', role: 'reviewer', next: 'audit' },
      { id: 'audit', layer: 'audit', role: 'reviewer', terminal: true },
    ],
    join: { anyFailure: 'pause' },
    onFail: 'pause',
    rework: { allowed: true, max_attempts: 2, escalate: 'human' },
  };
}
/** 环夹具（v2）：M1 后**唯一可声明回边的面 = `deps`**（拓扑面边，`audit → review` 回边）
 *  ⇒ 「环须由 `rework` 承认」的判据保持可测（P2-2a）。运行时推进语义不受影响（`deps` 不参与 `via`）。 */
function chainCyclic() {
  return {
    version: 2,
    steps: [
      { id: 'plan', layer: 'plan', role: 'designer', next: 'exec' },
      { id: 'exec', layer: 'exec', role: 'coder', join: 'all', next: 'review' },
      { id: 'review', layer: 'exec', role: 'reviewer', deps: ['audit'], next: 'audit' },
      { id: 'audit', layer: 'audit', role: 'reviewer', terminal: true },
    ],
    join: { anyFailure: 'pause' },
    onFail: 'pause',
    rework: { allowed: true, max_attempts: 2, escalate: 'human' },
  };
}
const mutateChain = (fn) => { const c = chain5(); fn(c); return c; };

/** 建批夹具：临时 `teamsRoot`（资产 + 技能根按显式 env 注入，与引擎读端同源）+ 真工具注册面。 */
function makeHarness({ chain = chain5(), auditFlow = true, subagents = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-p2chain-'));
  const store = createStore(root);
  const ctx = { tools: { register: () => {} }, logger: { info() {}, warn() {}, error() {} } };
  if (subagents) ctx.subagents = subagents;
  const teamsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-p2chain-teams-'));
  const asset = { team: TEAM, layers: LAYERS, roles: ROLES, flows: flowsOf({ audit: auditFlow }) };
  // `chain: null` = **无 `chain` 声明**（⑤ 向后兼容锁）；缺省 = 五段链。
  //   注：不可用 `chain: undefined` 表达「无链」——解构缺省值会把 `undefined` 还原成缺省链（本文件实测踩过）。
  if (chain !== null) asset.chain = chain;
  // F2：合成资产 ⇒ 单点写入（helpers/team-fixture.mjs）。
  writeSyntheticTeam(teamsRoot, TEAM, asset);
  clearRoleCache();
  const { tools } = createTools(ctx, { store, root, config: { dispatch: { provider: 'spawn-in-process' } } });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assessC(store, SESSION, { rationale: 'fixture：P2 推进链用例的建批前置评估（三层多依赖 ⇒ C 档）' });
  return { root, store, byName, ctx, teamsRoot };
}

function tasks5() {
  return [
    { id: 'plan', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
    { id: 'exec', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/exec.md'], deps: ['plan'], cmd: 'build' },
    { id: 'tester', layer: 'exec', role: 'tester', consume: ['exec/exec.md'], outputs: ['exec/tester.md'], deps: ['exec'], cmd: 'test' },
    { id: 'review', layer: 'exec', role: 'reviewer', consume: ['exec/tester.md'], outputs: ['exec/review.md'], deps: ['tester'], cmd: 'review' },
    {
      id: 'audit', layer: 'audit', role: 'reviewer', deps: ['review'],
      consume: ['plan/spec.md', 'exec/exec.md', 'exec/tester.md', 'exec/review.md'], produce: ['audit/audit.md'], cmd: 'accept',
    },
  ];
}

/** 装配声明：**`raise`** + audit 归属 lane。**M0′-① 之后 `leader-direct` 批的链推进全程 no-op**
 *  ⇒ 本套件（断言「引擎自动递进」）必须取非 leader-direct 形态；`raise` 亦是引擎缺省（显式写出以便阅读）。 */
const ASSEMBLY = { managerPlan: 'raise', auditLane: 'audit' };
const batchFileOf = (root, batchId) => path.join(root, 'sessions', SESSION, 'batches', batchId + '.json');
const wavePlan = (h, batchId) => h.byName.wave_plan.execute({
  batchId, team: TEAM, teamsRoot: h.teamsRoot, tasks: tasks5(), assembly: ASSEMBLY,
}, SESS);
/** 建批 + 武装（推进链的武装前提 = 相位 `running`；`wave_plan` 落 `planning`）。 */
async function mkBatch(h, batchId) {
  await wavePlan(h, batchId);
  await h.byName.batch_phase.execute({ batchId, phase: 'running' }, SESS);
}
// F3：收敛为单点（夹具审计 §3.3 必合档：5 份函数体逐字相同）⇒ 本文件只留 `SESSION` 绑定适配。
const seed = (h, batchId, rel, body = 'out') => seedArtifactFile(h.root, SESSION, batchId, rel, body);
/** 走完一条 lane 的合法结算链（非 running ⇒ 先置 running，再 review ⇒ 结算目标态）。 */
async function settleLane(h, batchId, lane, status) {
  const cur = () => h.store.readBatch(SESSION, batchId)?.lanes?.[lane];
  if (cur() !== 'running') await h.byName.member_status.execute({ batchId, lane, status: 'running' }, SESS);
  if (cur() === 'running') await h.byName.member_status.execute({ batchId, lane, status: 'review' }, SESS);
  return h.byName.member_settle.execute({ batchId, lane, status }, SESS);
}
const stepsOf = (h, batchId) => (h.store.readBatch(SESSION, batchId)?.events ?? []).filter((e) => e.type === 'chain.step');
const dispatchOf = (h, batchId) => (h.store.readBatch(SESSION, batchId)?.events ?? []).filter((e) => e.type === 'member.dispatch');
const pendingFor = (batchId, lane) => pendingHandles().filter((x) => x.batchId === batchId && x.lane === lane);
const specChain = (c) => c.steps.map((s) => s.id).join('→');

/** 【退役锁 · Q-A=C 2026-09-18（批 `engine-retire-chain-20260918`）】链运行期推进入口**全批统一 no-op** 自证：
 *  不管批次形态（`managerPlan` 取值 / 相位 / 有无 `chain` 声明 / 有无 `assembly`），`advanceChainAfterSettle` 恒回
 *  `{ok:true, action:'none', reason:'retired', note:'chain-advance-retired-20260918'}`，且**零 chain.step、零成员态
 *  变化、零派发、零相位事件**（删面见 `lib/engine/chain-runner.js` 头注）。
 *  ⚠ 本文件 P2-3 / P2-8 / P2-9 / P2-10 锁定的行为（自动递进 / leader-direct 专属 no-op / raise 对照 / 相位闸对照）
 *  随退役**整体消失** ⇒ 用例改为「自证入口 no-op」后返回；旧断言保留在下方作**历史口径留档**（不再执行），
 *  改写为纯退役锁的 followup 见 exec 产物 `exec/engine-retire.md`（§1 变更清单表的测试改写行 / §6 未决项 · gap 段，交 audit 收 gap-list）。 */
async function assertAdvanceRetiredP2(h, batchId, { lane = 'plan' } = {}) {
  const b0 = h.store.readBatch(SESSION, batchId);
  const before = {
    steps: stepsOf(h, batchId).length,
    disp: dispatchOf(h, batchId).length,
    phase: b0?.phase,
    lanes: JSON.stringify(b0?.lanes ?? {}),
  };
  const out = await advanceChainAfterSettle(
    { store: h.store, root: h.root, liveConfig: { dispatch: { provider: 'spawn-in-process' } } },
    h.ctx, SESS,
    { sessionId: SESSION, batchId, lane, status: 'merged' },
  );
  assert.equal(out.ok, true, '[退役锁] 入口恒不抛错');
  assert.equal(out.action, 'none', '[退役锁] action=none');
  assert.equal(out.reason, 'retired', '[退役锁] reason=retired（全批统一 no-op）');
  assert.equal(out.note, 'chain-advance-retired-20260918', '[退役锁] note 可判读');
  assert.deepEqual(out.dispatched, [], '[退役锁] 零派发');
  assert.equal(stepsOf(h, batchId).length, before.steps, '[退役锁] 零新增 chain.step');
  assert.equal(dispatchOf(h, batchId).length, before.disp, '[退役锁] 零新增 member.dispatch（链不再派发）');
  assert.equal(h.store.readBatch(SESSION, batchId)?.phase, before.phase, '[退役锁] 相位不变');
  assert.equal(JSON.stringify(h.store.readBatch(SESSION, batchId)?.lanes ?? {}), before.lanes, '[退役锁] 成员态逐字不变');
}

// ── ① 链声明正向 + 纯函数面 ───────────────────────────────────────────────

test('P2-1 链声明正向：五段链八条静态校验 problems=[]；真资产 engine-team 的 chain 亦通过；`flows.chain` 位置拒', () => {
  assert.deepEqual(validateChain(chain5(), LAYERS).problems, [], '五段链（' + specChain(chain5()) + '）必须八条全过');
  // 注（2026-09-26 团队资产瘦身）：`engine-team` 现为 **757 B 最小骨架**、**不含 `chain`**
  //   ⇒ `loadChainOf` 应回 `{ ok: true, chain: null }`（无链 = 合法态，不是失败）。
  //   ⇒ 原「engine-team 必须声明链步」改为「**无链亦为合法**」；链步语义由本文件 `chain5()` 夹具覆盖。
  const real = loadChainOf({ team: 'engine-team' });
  assert.equal(real.ok, true, 'engine-team 无 chain ⇒ ok:true（无链不是失败）：' + JSON.stringify(real.problems));
  assert.equal(real.chain, null, 'engine-team 最小骨架未声明 chain ⇒ chain=null');
  const pos = resolveChainOf({ flows: { chain: chain5() }, chain: chain5() });
  assert.ok(pos.problems.some((p) => p.code === 'TEAM_ASSET_FIELD_NOT_ALLOWED'),
    '`flows.chain` 不是规范位（唯一规范位 = 顶层 `chain`，禁双真源）');
  // 推进规则锁定：`skipped` 不推进（同层 join=all 视为未完成）
  const c = chain5();
  const skipped = chainNextOf(c, c.steps[1], 'skipped', { stepLanes: ['exec'], laneStates: { exec: 'skipped' } });
  assert.equal(skipped.action, 'none', '`skipped` ⇒ 不推进');
  const byRole = chainStepForLane(c, 'e-other', { layer: 'exec', role: 'coder' });
  assert.equal(byRole.step?.id, 'exec', '(layer,role) 命中同一步 = 同层多 lane 共享该步');
});

test('P2-1b 退役链级子键：`chain.needHuman` 声明即拒（FIELD_NOT_ALLOWED / blocking，零新造码）', () => {
  // 2026-09-18 清债轮（用户裁决「清理冗余设计与死代码」）：`chain.needHuman` 原为「只声明不消费」的
  //   未接线子键（零运行期读点；人工闸真实承载面 = `flows.audit.needhuman` + Tier3 `checkNeedHumanGate`）
  //   ⇒ 从声明位摘除，与 `state_machine` / 顶层 `rework` / `flows.*.progress_contract` 退役口径同一。
  // 断言两点：① **拒绝**而非静默忽略（「写了不生效」比拒更糟，同 M1 步级 `on` 裁决）；
  //   ② 码面/严重级**复用既有档**（blocking ⇒ `ok=false`），不新造码、不降级为 warning。
  const c = chain5();
  c.needHuman = ['audit'];
  const r = validateChain(c, LAYERS);
  assert.equal(r.ok, false, '退役键声明后 `ok` 必须为 false（blocking 档）');
  const hit = r.problems.find((p) => p.path === 'chain.needHuman');
  assert.ok(hit, '须报到路径 chain.needHuman：' + JSON.stringify(r.problems));
  assert.equal(hit.code, 'TEAM_ASSET_FIELD_NOT_ALLOWED', '复用既有码（零新造）');
  assert.equal(hit.severity, 'blocking', '退役键是硬拒，不得降为 warning');
  // 反向面：未声明 ⇒ 零影响（不误伤正常链）；台账单一来源可读。
  assert.deepEqual(validateChain(chain5(), LAYERS).problems, [], '链本体不得因此新增问题');
  assert.deepEqual([...RETIRED_CHAIN_KEYS], ['needHuman'], '退役清单须可读（派生自事由表）');
});

// ── ② 三反例【2026-09-27 反转】：`chain` 声明非法 ⇒ **不再拒建批**（原 `assertChainReady` 构造期拒已退出工具面接线） ──

/** 断言「建批成功 + 原码留痕 + 批次 JSON 落盘」三件套（等价反转原 `expectConstructReject` 的「拒 + 原码 + 零落盘」）。 */
async function expectWarnAccept(h, batchId, code, label) {
  const out = await wavePlan(h, batchId); // 不得抛（2026-09-27：chain 问题降级为留痕）
  assert.equal(out.batchId, batchId, label + '：建批成功（返回批 id）');
  const w = out.warnings.find((x) => x.code === code);
  assert.ok(w, label + '：原码须留痕 ' + code + '（实得：' + JSON.stringify(out.warnings.map((x) => x.code)) + '）');
  assert.equal(fs.existsSync(batchFileOf(h.root, batchId)), true, label + '：批次 JSON 必须落盘（原「拒后零批次 JSON 落盘」已反转）');
  return out;
}

test('P2-2a 反例①环未被 `rework` 承认 ⇒ **R2-3 后不再构造期拒**：建批成功 + warning 留痕（口径变更）', async () => {
  // 口径变更（R2-3 裁决 B，2026-09-17）：`ok = 无 blocking` ⇒ 环未承认只产 **warning**，
  //   构造期**不再拒**（旧断言「构造期拒 + 零批次落盘」已被新口径取代，用户已裁「门禁可均降」）。
  // M1 改写（2026-09-17）：环由 **v2 `deps` 拓扑面**表达（步级条件边已下线，见 `chainCyclic()`）。
  const ch = chainCyclic();
  ch.rework.allowed = false;
  const res = validateChain(ch, LAYERS);
  assert.equal(res.ok, true, '仅 warning ⇒ `ok` 必须为 true（R2-3 语义）');
  const codes = res.problems.map((p) => p.code);
  assert.ok(codes.includes('TEAM_ASSET_REWORK_INVALID'),
    '环未承认仍必须**留痕** TEAM_ASSET_REWORK_INVALID（实得：' + JSON.stringify(codes) + '）');
  assert.ok(res.problems.every((p) => p.severity === 'warning'),
    '该族必须全为 warning 级（不得静默升为 blocking）');
  const h = makeHarness({ chain: ch });
  await wavePlan(h, 'p2-warn-rework'); // 不得抛
  assert.equal(fs.existsSync(batchFileOf(h.root, 'p2-warn-rework')), true,
    '新口径下必须建批成功（批次 JSON 落盘）');
});

test('P2-2b 反例②`join:any` 缺 `anyFailure`【2026-09-27 反转】⇒ 建批成功 + TEAM_ASSET_MISSING_FIELD 留痕 + 批次 JSON 落盘', async () => {
  await expectWarnAccept(
    makeHarness({ chain: mutateChain((c) => { c.steps[1].join = 'any'; delete c.join.anyFailure; }) }),
    'p2-rej-anyfail', 'TEAM_ASSET_MISSING_FIELD', 'join:any 缺 anyFailure',
  );
});

test('P2-2c 反例③链尾不唯一（terminal 两处）【2026-09-27 反转】⇒ 建批成功 + TEAM_ASSET_MISSING_FIELD 留痕 + 批次 JSON 落盘', async () => {
  await expectWarnAccept(
    makeHarness({ chain: mutateChain((c) => { c.steps[3].terminal = true; }) }), 'p2-rej-terminal', 'TEAM_ASSET_MISSING_FIELD', '链尾不唯一',
  );
});

// ── ③ 自动递进正向：逐环自动派发至链尾 ────────────────────────────────────

test('P2-3【退役锁 · Q-A=C】自动递进正向已无对象：plan merged ⇒ 零 chain.step、零 member.dispatch、零成员态变化（不再逐环自派）', async () => {
  __resetLaneHandles();
  const spawned = [];
  const h = makeHarness({ subagents: { start: async (provider, request) => { spawned.push(request.label); return { id: 'w-' + spawned.length, result: Promise.resolve({ output: [], stopReason: 'completed' }) }; } } });
  const B = 'p2-auto';
  await mkBatch(h, B);
  // 【退役锁 · Q-A=C 2026-09-18】逐环自动递进已退役 ⇒ 自证入口 no-op 后返回（旧断言留档，不执行）。
  await assertAdvanceRetiredP2(h, B);
  return;

  // 环 1：plan（手工结算触发链；此后每环由引擎自动派发）
  seed(h, B, 'plan/spec.md', SPEC);
  await settleLane(h, B, 'plan', 'merged');
  const s1 = stepsOf(h, B);
  assert.equal(s1.length, 1, 'plan merged ⇒ 恰 1 条 chain.step');
  assert.deepEqual([s1[0].from, s1[0].to, s1[0].via, s1[0].lane], ['plan', 'exec', 'next', 'plan'], '链步 1 = plan→exec via next');
  assert.equal(h.store.readBatch(SESSION, B).lanes.exec, 'running', 'exec lane 由引擎自动置 running');
  assert.ok(dispatchOf(h, B).some((e) => e.lane === 'exec' && e.workerSessionId === 'w-1'), '引擎直写 member.dispatch（exec ⇄ w-1）');
  assert.equal(pendingFor(B, 'exec').length, 0, '成功自派 ⇒ 句柄零残留（P0）');

  // 环 2：exec → tester
  seed(h, B, 'exec/exec.md');
  await settleLane(h, B, 'exec', 'merged');
  const s2 = stepsOf(h, B);
  assert.equal(h.store.readBatch(SESSION, B).lanes.tester, 'running', 'tester lane 自动 running');
  assert.deepEqual([s2[1].from, s2[1].to, s2[1].via], ['exec', 'tester', 'next'], '链步 2 = exec→tester via next');

  // 环 3：tester → review
  seed(h, B, 'exec/tester.md');
  await settleLane(h, B, 'tester', 'merged');
  const s3 = stepsOf(h, B);
  assert.equal(h.store.readBatch(SESSION, B).lanes.review, 'running', 'review lane 自动 running');
  assert.deepEqual([s3[2].from, s3[2].to, s3[2].via], ['tester', 'review', 'next'], '链步 3 = tester→review via next');

  // 环 4：review → audit（`next` 分支）
  seed(h, B, 'exec/review.md');
  await settleLane(h, B, 'review', 'merged');
  const s4 = stepsOf(h, B);
  assert.equal(h.store.readBatch(SESSION, B).lanes.audit, 'running', 'audit lane 自动 running');
  assert.deepEqual([s4[3].from, s4[3].to, s4[3].via], ['review', 'audit', 'next'], '链步 4 = review→audit via next');

  // 链尾：audit merged ⇒ 不伪造边（无第 5 条 chain.step）
  seed(h, B, 'audit/audit.md', 'review');
  await settleLane(h, B, 'audit', 'merged');
  assert.equal(stepsOf(h, B).length, 4, '链尾（terminal）不伪造后继边');
  assert.deepEqual(spawned, [
    'punky-swarm:' + B + ':exec', 'punky-swarm:' + B + ':tester',
    'punky-swarm:' + B + ':review', 'punky-swarm:' + B + ':audit',
  ], '四环全部由引擎自派（label = 第二绑定键）');

  // 读端回显（RK1）：batch_status.chain 可复原全链
  const view = (await h.byName.batch_status.execute({ batchId: B }, SESS)).chain;
  assert.equal(view?.steps?.length, 5, 'chain 回显须含全部 5 个链步');
  assert.equal(view?.lastStep?.to, 'audit', 'lastStep = 最后一跳的目标步');
  assert.equal(view?.edges?.length, 4, 'edges 去重后 4 条（命中边显式可见）');
  assert.ok(view.edges.some((e) => e.from === 'review' && e.to === 'audit' && e.via === 'next'), 'edges 须含 review→audit(via next)');
});

// ── ④ 句柄零残留（P0 两分支） ────────────────────────────────────────────

test('P2-4 句柄零残留：成功自派 ⇒ pendingHandles 无该 (batch,lane)；降级「仅发句柄」⇒ 句柄仍有效', async () => {
  __resetLaneHandles();
  const h = makeHarness({ subagents: { start: async () => ({ id: 'w-ok', result: Promise.resolve({ output: [], stopReason: 'completed' }) }) } });
  await mkBatch(h, 'p2-p0-ok');
  seed(h, 'p2-p0-ok', 'plan/spec.md', SPEC);
  const d1 = await h.byName.lane_dispatch.execute({ batchId: 'p2-p0-ok', lane: 'exec' }, SESS);
  assert.equal(d1.spawned, true, '有 ctx.subagents ⇒ 引擎自派成功');
  const v1 = verifyLaneHandle(d1.token, { batchId: 'p2-p0-ok', lane: 'exec' });
  assert.equal(v1.ok, false, '成功自派后句柄即作废（自派即发放即作废）');
  assert.equal(v1.reason, 'handle-consumed', '作废形态 = handle-consumed');
  assert.equal(pendingFor('p2-p0-ok', 'exec').length, 0, 'pendingHandles 不得残留该 (batch,lane)');

  __resetLaneHandles();
  const h2 = makeHarness({ subagents: null }); // 无 ctx.subagents ⇒ 降级「仅发句柄」
  await mkBatch(h2, 'p2-p0-degrade');
  seed(h2, 'p2-p0-degrade', 'plan/spec.md', SPEC);
  const d2 = await h2.byName.lane_dispatch.execute({ batchId: 'p2-p0-degrade', lane: 'exec' }, SESS);
  assert.equal(d2.spawned, false, '无 ctx.subagents ⇒ 降级（不静默：附 spawnNote）');
  assert.match(String(d2.spawnNote ?? ''), /ctx\.subagents/, '降级原因须显式回传');
  const v2 = verifyLaneHandle(d2.token, { batchId: 'p2-p0-degrade', lane: 'exec' });
  assert.equal(v2.ok, true, '降级路径句柄**不得消费**（供人工直派形态，该形态门禁属 C 阶段）');
  const left = pendingFor('p2-p0-degrade', 'exec');
  assert.equal(left.length, 1, '降级路径句柄须留在 pendingHandles');
  assert.equal(left[0].expired, false, '刚发放的句柄未过期');
  __resetLaneHandles();
});

// ── ⑤ `>30min` 活跃 lane 零假 gap ───────────────────────────────────────

test('P2-5 >30min 活跃 lane 零假 gap：有绑定 dispatch ⇒ 不报 token-ttl-expired；无绑定仍照报', async () => {
  __resetLaneHandles();
  // 真实批次：引擎自派的 lane 已绑定（member.dispatch + workerSessionId 非空）
  const h = makeHarness({ subagents: { start: async () => ({ id: 'w-live', result: Promise.resolve({ output: [], stopReason: 'completed' }) }) } });
  await mkBatch(h, 'p2-gap-live');
  seed(h, 'p2-gap-live', 'plan/spec.md', SPEC);
  await h.byName.lane_dispatch.execute({ batchId: 'p2-gap-live', lane: 'exec' }, SESS);
  const batch = h.store.readBatch(SESSION, 'p2-gap-live');
  const later = Date.now() + LANE_HANDLE_TTL_MS + 60_000; // 派发后 >30min（TTL 已过）
  assert.deepEqual(bindingGapOf(batch, 'exec', later, null), { hit: false, reason: null },
    '已绑定的活跃 lane 在 >30min 后仍不得报 gap（否则就是幽灵缺口）');

  // 反证①：同形态但**未绑定**（无 workerSessionId）+ 超 TTL 未消费句柄 ⇒ 原样照报 token-ttl-expired
  const unbound = { batchId: 'p2-gap-unbound', events: [{ type: 'member.dispatch', lane: 'l1', ts: new Date(later - 31 * 60_000).toISOString(), workerSessionId: '' }] };
  issueLaneHandle({ batchId: 'p2-gap-unbound', lane: 'l1', sessionId: SESSION, now: later - LANE_HANDLE_TTL_MS - 60_000 });
  const g = bindingGapOf(unbound, 'l1', later, null);
  assert.equal(g.hit, true, '未绑定 + 超 TTL 未消费句柄仍须报缺口');
  assert.equal(g.reason, 'token-ttl-expired', '缺口原因 = token-ttl-expired（既有语义逐字保留）');
  // 反证②：无任何 dispatch 事件 ⇒ `no-dispatch`（既有语义不变）
  assert.deepEqual(bindingGapOf({ batchId: 'p2-gap-none', events: [] }, 'l1', later, null), { hit: true, reason: 'no-dispatch' });
  __resetLaneHandles();
});

// ── ⑥ 无 chain ⇒ 现行 3 层行为不变（向后兼容锁） ──────────────────────────

test('P2-6 向后兼容锁：无 `chain` 声明 ⇒ 不写 chain.step / 不改相位 / 不自动派发 / 读端无 chain 键', async () => {
  __resetLaneHandles();
  const h = makeHarness({ chain: null, subagents: { start: async () => ({ id: 'w-never', result: Promise.resolve({ output: [], stopReason: 'completed' }) }) } });
  const B = 'p2-nochain';
  await mkBatch(h, B);
  seed(h, B, 'plan/spec.md', SPEC);
  await settleLane(h, B, 'plan', 'merged');
  const b = h.store.readBatch(SESSION, B);
  assert.equal(stepsOf(h, B).length, 0, '无链 ⇒ 不写任何 chain.step');
  assert.equal(b.phase, 'running', '无链 ⇒ 相位不被推进改写');
  assert.equal(b.lanes.exec, 'pending', '无链 ⇒ 不自动派发（手工派发语义不变）');
  assert.equal(dispatchOf(h, B).length, 0, '无链 ⇒ 零 member.dispatch');
  const view = await h.byName.batch_status.execute({ batchId: B }, SESS);
  assert.equal(Object.hasOwn(view, 'chain'), false, '无链 ⇒ 读端不出现 chain 回显字段（零差异）');
});

// ── ⑦ M0′-①：`leader-direct` 批链推进 no-op（AC-1/AC-2/AC-3）────────────────
/** 用**指定装配声明**建批 + 武装（`assembly` 传 `null` ⇒ 不传该参数 = 无装配声明的历史批形态）。 */
async function mkBatchWithAssembly(h, batchId, assembly) {
  const args = { batchId, team: TEAM, teamsRoot: h.teamsRoot, tasks: tasks5() };
  if (assembly) args.assembly = assembly;
  await h.byName.wave_plan.execute(args, SESS);
  await h.byName.batch_phase.execute({ batchId, phase: 'running' }, SESS);
}
const phaseEventsOf = (h, batchId) => (h.store.readBatch(SESSION, batchId)?.events ?? []).filter((e) => e.type === EVT_BATCH_PHASE);

test('P2-8【退役锁 · Q-A=C】M0′-①：`managerPlan:"leader-direct"` 批 ⇒ 链推进 no-op（该专属分支已升级为全批统一 no-op：零 chain.step / 零相位事件 / 零派发）', async () => {
  __resetLaneHandles();
  const spawned = [];
  const h = makeHarness({ subagents: { start: async (provider, request) => { spawned.push(request.label); return { id: 'w-ld', result: Promise.resolve({ output: [], stopReason: 'completed' }) }; } } });
  const B = 'p2-leader-direct';
  await mkBatchWithAssembly(h, B, { managerPlan: 'leader-direct', auditLane: 'audit' });
  seed(h, B, 'plan/spec.md', SPEC);
  const before = h.store.readBatch(SESSION, B);
  const phaseBefore = phaseEventsOf(h, B).length;
  // 【退役锁 · Q-A=C 2026-09-18】M0′ 的 leader-direct 专属 no-op 已升级为**全批统一 no-op** ⇒ 自证后返回。
  await assertAdvanceRetiredP2(h, B);
  assert.equal(phaseEventsOf(h, B).length, phaseBefore, '[退役锁] 零新增 batch.phase 事件');
  return;

  // 刻意传**带挂载点**的 exec（`SESS`）⇒ 证「即便引擎能自派，leader-direct 形态也不推进」
  const r = await advanceChainAfterSettle(
    { store: h.store, root: h.root }, h.ctx, SESS,
    { sessionId: SESSION, batchId: B, lane: 'plan', status: 'merged' },
  );
  assert.deepEqual(
    [r.ok, r.action, r.from, r.to, r.via, r.reason, r.note],
    [true, 'none', null, null, null, 'manager-plan-leader-direct', 'leader-direct-noop'],
    '返回值契约逐字：{ok:true, action:none, reason:manager-plan-leader-direct, note:leader-direct-noop}',
  );
  assert.deepEqual(r.dispatched, [], 'leader-direct ⇒ 不派发');
  assert.deepEqual(r.skipped, [], 'leader-direct ⇒ 无 skipped 明细（本分支先于一切判定）');
  assert.equal(h.store.readBatch(SESSION, B).phase, 'running', '批相位保持 running（不停轮）');
  assert.equal(stepsOf(h, B).length, 0, '零新增 chain.step（不伪造推进留痕）');
  assert.equal(phaseEventsOf(h, B).length, phaseBefore, '零新增 batch.phase 事件');
  assert.equal(h.store.readBatch(SESSION, B).lanes.exec, before.lanes.exec, '成员态零变化（不自动置 running）');
  assert.deepEqual(spawned, [], '零自派（即便 ctx.subagents 可用）');
});

test('P2-9【退役锁 · Q-A=C】对照（AC-2）：同夹具把 `managerPlan` 换 `raise` ⇒ 旧行为**不再**保留（全批统一 no-op：零 chain.step / 零派发）', async () => {
  __resetLaneHandles();
  const spawned = [];
  const h = makeHarness({ subagents: { start: async (provider, request) => { spawned.push(request.label); return { id: 'w-ra', result: Promise.resolve({ output: [], stopReason: 'completed' }) }; } } });
  const B = 'p2-raise-advance';
  await mkBatchWithAssembly(h, B, { managerPlan: 'raise', auditLane: 'audit' });
  // 【退役锁 · Q-A=C 2026-09-18】raise 批的「旧行为保留」对照已不成立（全批 no-op）⇒ 自证后返回（旧断言留档）。
  await assertAdvanceRetiredP2(h, B);
  return;
  seed(h, B, 'plan/spec.md', SPEC);
  // 先按真实路把 `plan` 结算到 merged（本用例直调推进单点 ⇒ 成员态须自行到位，否则 join:all 会判 wait）
  h.store.setMember(SESSION, B, 'plan', 'running');
  h.store.setMember(SESSION, B, 'plan', 'review');
  h.store.setMember(SESSION, B, 'plan', 'merged');
  const r = await advanceChainAfterSettle(
    { store: h.store, root: h.root, liveConfig: { dispatch: { provider: 'spawn-in-process' } } }, h.ctx, SESS,
    { sessionId: SESSION, batchId: B, lane: 'plan', status: 'merged' },
  );
  assert.equal(r.action, 'advance', 'raise 批照常推进（M0′ 分支未命中）');
  assert.notEqual(r.reason, 'manager-plan-leader-direct', 'reason 不得是 M0′ 新增 token');
  assert.deepEqual([r.to, r.via], ['exec', 'next'], '推进目标/分支与旧口径逐字一致');
  assert.deepEqual(spawned, ['punky-swarm:' + B + ':exec'], 'raise 批仍由引擎自派目标 lane');
});

test('P2-10【退役锁 · Q-A=C】对照（AC-3）：**无 `assembly` 字段的历史批** ⇒ `phase-*` / `no-chain` 两分支亦被统一 no-op 取代（零 chain.step）', async () => {
  const h = makeHarness();
  // ① 无 assembly + `planning` 相位 ⇒ 走既有相位闸（`phase-planning`），不是 M0′ token
  //   （直建批 = 历史批形态：批次 JSON 里**没有** `assembly` 键）
  const B1 = 'p2-legacy-planning';
  const plan1 = buildWavePlan({ batchId: B1, tasks: threeTierTasks(['e1']) });
  h.store.createBatch(SESSION, { batchId: B1, wavePlan: plan1, phase: 'planning' });
  assert.equal(Object.hasOwn(h.store.readBatch(SESSION, B1), 'assembly'), false, '前置：本批确无 `assembly` 键（历史批形态）');
  // 【退役锁 · Q-A=C 2026-09-18】相位闸（`phase-*`）/ `no-chain` 两条历史分支已统一为「全批 no-op」⇒ 自证后返回。
  await assertAdvanceRetiredP2(h, B1, { lane: 'e1' });
  return;
  const r1 = await advanceChainAfterSettle(
    { store: h.store, root: h.root }, h.ctx, SESS,
    { sessionId: SESSION, batchId: B1, lane: 'e1', status: 'merged' },
  );
  assert.equal(r1.reason, 'phase-planning', '无 assembly 的批照走既有相位闸（逐字不变）');
  assert.equal(r1.note, undefined, 'M0′ 分支不命中 ⇒ 无 leader-direct-noop 注记');

  // ② 无 `team` 字段的批（legacy 形态）+ running ⇒ 走既有 `no-chain` 路径
  const B2 = 'p2-legacy-nochain';
  const plan2 = buildWavePlan({ batchId: B2, tasks: threeTierTasks(['e1']) });
  h.store.createBatch(SESSION, { batchId: B2, wavePlan: plan2, phase: 'running' });
  const r2 = await advanceChainAfterSettle(
    { store: h.store, root: h.root }, h.ctx, SESS,
    { sessionId: SESSION, batchId: B2, lane: 'e1', status: 'merged' },
  );
  assert.equal(r2.reason, 'no-chain', '无链的 legacy 批照走 `no-chain`（R5 向后兼容锁）');
  assert.equal(r2.note, undefined, 'M0′ 分支不命中');
});

// ── ⑥ G-3：有资产但无 `flows.audit` + 含 audit lane ⇒ 零感知跳过 ─────────────
test('P2-7 G-3：有资产但无 `flows.audit` + 含 audit lane ⇒ 零感知跳过（不拒、不落 GATE_AUDIT_CONTRACT_*）', async () => {
  const h = makeHarness({ auditFlow: false }); // 资产在、`flows` 在、`flows.audit` 缺
  const out = await wavePlan(h, 'p2-no-audit-flow');
  assert.equal(out.batchId, 'p2-no-audit-flow', '缺 flows.audit 不得拒建批（该门只在有 audit 流程声明时生效）');
  const codes = (out.warnings ?? []).map((w) => w.code);
  assert.deepEqual(codes.filter((c) => String(c).startsWith('GATE_AUDIT_CONTRACT_')), [],
    '零感知跳过：不得落 GATE_AUDIT_CONTRACT_MISSING / _EXEMPT：' + JSON.stringify(codes));
  assert.equal(fs.existsSync(batchFileOf(h.root, 'p2-no-audit-flow')), true, '批次正常落盘（跳过 ≠ 拒）');
});
