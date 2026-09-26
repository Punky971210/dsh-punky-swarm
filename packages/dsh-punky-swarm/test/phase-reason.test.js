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

// test/phase-reason.test.js —— **M0′-②：`batch.phase` 事件补 `reason`** 用例面
//   （批 `handoff-consolidation-m0m1-20260917`；规格 `plan/spec.md` §2 S2 / AC-4 / AC-5 / AC-6）
// ─────────────────────────────────────────────────────────────────────────────
// 判据：
//   · **四个生产写点全覆盖**（AC-4）：链停轮（`chain:`）/ 自动结算停轮（`auto-settle:`）/
//     `batch_phase` 显式迁移（`manual:batch_phase:`）/ `batch_control` 干预（`manual:batch_control.`）；
//   · **只在非空时写键**：`{from,to}` 形态零污染（既有读端与深比较不受影响）——`reason` 为空/空白 ⇒ 无该键；
//   · **不静默锁**（AC-5，`PR-2`）：三个生产文件内**不存在** `setPhase(…)` 裸调用（实参串必含 `{ reason`）——
//     锁的作用 = 替代「通用入口抛错」的静默防护（不扩大 `setPhase` 的调用面）；
//   · **读端可见**（AC-6）：`log_export` markdown 时间线渲染 `<from> -> <to> | <reason>`。
// 事实源纪律：断言一律读 `store.readBatch` 的批次 JSON，不读模块内部状态。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { createTools } from '../lib/tools/register.js';
import { clearRoleCache } from '../lib/assembly/flows.js';
import { EVT_BATCH_PHASE } from '../lib/state/event-types.js';
import { AUTO_SETTLE_TRIGGERS, autoSettleLane } from '../lib/engine/auto-settle.js';
import { threeTierTasks, seedArtifacts, assessC } from './helpers/gate-fixture.mjs';
import { writeSyntheticTeam } from './helpers/team-fixture.mjs';
import { seedArtifactFile } from './helpers/gate-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSION = 'sess-pr';
const SESS = { agent: { session: { id: SESSION } } };
const TEAM = 'pr-team';
const SPEC = '# spec\n## 验收标准\n- x\n## 约束\n- y\n';
const LAYERS = {
  plan: { roles: ['designer'], skills: { designer: ['spec-writing'] } },
  exec: { roles: ['coder'], skills: { coder: ['dev-coder'] } },
  audit: { roles: ['reviewer'], skills: { reviewer: ['acceptance-gate'] } },
};
const ROLES = { plan_leads: ['designer'], audit_leads: ['reviewer'] };
const FLOWS = {
  plan: { produce_field: 'produce', entry_requires: [], contract: { artifact_globs: ['plan/*.md'], required_sections: ['## 验收标准', '## 约束'] } },
  exec: { produce_field: 'outputs', consume_field: 'consume', entry_requires: ['consume'] },
  audit: {
    produce_field: 'produce', consume_field: 'consume', entry_requires: ['consume'],
    audit_contract: { criteria_from: 'plan/spec.md', consumes_required: ['plan/', 'exec/'], verdict: ['approve', 'reject'] },
  },
};
/** 两段链（`plan→exec`）：`plan` 结算 `failed` ⇒ 失败面落批次级 `onFail`（缺省 `pause`）⇒ 链停轮。 */
function chainPause() {
  return {
    version: 1,
    steps: [
      { id: 'plan', layer: 'plan', role: 'designer', next: 'exec' },
      { id: 'exec', layer: 'exec', role: 'coder', terminal: true },
    ],
    join: { anyFailure: 'pause' },
    onFail: 'pause',
  };
}
/** 合规三层 tasks（plan + exec + audit；audit 在链外 ⇒ 只做收口面，不参与本套件的推判据）。 */
const TASKS = () => ([
  { id: 'plan', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
  { id: 'exec', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/exec.md'], cmd: 'build' },
  { id: 'audit', layer: 'audit', role: 'reviewer', consume: ['plan/spec.md', 'exec/exec.md'], produce: ['audit/audit.md'], cmd: 'accept' },
]);
/** 含 audit 层的三层批必带装配声明；用**缺省 `raise`** 形态（`leader-direct` 在 M0′-① 后链推进全程
 *  no-op ⇒ 本套件的「链停轮写 reason」判据必须在非 leader-direct 批上取）。 */
const ASSEMBLY = { managerPlan: 'raise', auditLane: 'audit' };

/** 建批夹具：临时 `teamsRoot` + 真工具注册面（`logs` 打开 ⇒ `log_export` 在册）。
 *  ⚠ **刻意不声明 assembly**：`managerPlan:'leader-direct'` 的批在 M0′-① 后链推进**全程 no-op**
 *  ⇒ 本套件要验的「链停轮写 reason」必须落在**非 leader-direct** 形态（无 assembly = 非 leader-direct）。 */
function makeHarness({ chain = chainPause(), logs = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-pr-'));
  const store = createStore(root);
  const ctx = {
    tools: { register: () => {} },
    logger: { info() {}, warn() {}, error() {} },
    subagents: { start: async () => ({ id: 'w-pr', result: Promise.resolve({ output: [], stopReason: 'completed' }) }) },
  };
  const teamsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-pr-teams-'));
  const asset = { team: TEAM, layers: LAYERS, roles: ROLES, flows: FLOWS, chain };
  // F2：合成资产 ⇒ 单点写入（helpers/team-fixture.mjs）。
  writeSyntheticTeam(teamsRoot, TEAM, asset);
  clearRoleCache();
  const cfg = { dispatch: { provider: 'spawn-in-process' } };
  if (logs) cfg.capabilities = { logs: { enabled: true } };
  const { tools } = createTools(ctx, { store, root, config: cfg });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assessC(store, SESSION, { rationale: 'fixture：相位 reason 用例的建批前置评估（三层 + 多步链 ⇒ C 档）' });
  return { root, store, byName, teamsRoot };
}
async function mkBatch(h, batchId) {
  await h.byName.wave_plan.execute({ batchId, team: TEAM, teamsRoot: h.teamsRoot, tasks: TASKS(), assembly: ASSEMBLY }, SESS);
  await h.byName.batch_phase.execute({ batchId, phase: 'running' }, SESS);
}
// F3：收敛为单点（夹具审计 §3.3 必合档：5 份函数体逐字相同）⇒ 本文件只留 `SESSION` 绑定适配。
const seed = (h, batchId, rel, body = 'out') => seedArtifactFile(h.root, SESSION, batchId, rel, body);
/** 走完一条 lane 的合法结算链（`running → review → failed`；非 merged 终态须带非空 note）。 */
async function settleFailed(h, batchId, lane) {
  await h.byName.member_status.execute({ batchId, lane, status: 'running' }, SESS);
  await h.byName.member_status.execute({ batchId, lane, status: 'review' }, SESS);
  return h.byName.member_settle.execute({ batchId, lane, status: 'failed', note: 'PAUSE-REASON 夹具：' + lane + ' 失败留痕' }, SESS);
}
const phaseEventsOf = (h, batchId) => (h.store.readBatch(SESSION, batchId)?.events ?? []).filter((e) => e.type === EVT_BATCH_PHASE);
const stoppedPhaseEvent = (h, batchId) => phaseEventsOf(h, batchId).find((e) => e.to === 'paused') ?? null;
const phaseOf = (h, batchId) => h.store.readBatch(SESSION, batchId)?.phase;

/** reason 词表（`plan/spec.md` §2 S2.2）：`<source>` 或 `<source>:<detail>`。 */
const REASON_PREFIXES = ['chain:', 'auto-settle:', 'manual:batch_phase', 'manual:batch_control', 'failed-escalate', 'governance-escalate'];
const inWordTable = (r) => REASON_PREFIXES.some((p) => String(r).startsWith(p));

// ── PR-1：链停轮写 `chain:` 前缀 reason（写点①）──────────────────────────────

test('PR-1【退役锁 · Q-A=C】链停轮写点①已删：`plan` 结算 failed ⇒ 相位保持 running、零 running->paused 事件、零 chain.step', async () => {
  const h = makeHarness();
  const B = 'pr-chain-pause';
  await mkBatch(h, B);
  seed(h, B, 'plan/spec.md', SPEC);
  await settleFailed(h, B, 'plan');
  // 【退役锁 · Q-A=C 2026-09-18（批 engine-retire-chain-20260918）】链停轮写点①（`pauseBatch`，写 `chain:` 前缀
  //  reason）已随链运行期推进**整体删除** ⇒ 自证「不再停轮」后返回；旧断言保留在下方作历史口径留档（不执行）。
  assert.equal(phaseOf(h, B), 'running', '[退役锁] 链停轮写点已删 ⇒ 批相位保持 running（不再 paused）');
  assert.equal(stoppedPhaseEvent(h, B), null, '[退役锁] 零 running->paused 相位事件');
  assert.equal((h.store.readBatch(SESSION, B)?.events ?? []).filter((e) => e.type === 'chain.step').length, 0,
    '[退役锁] 零 chain.step（停轮留痕写点已删）');
  return;

  assert.equal(phaseOf(h, B), 'paused', '失败面落批次级 onFail=pause ⇒ 批停轮');
  const ev = stoppedPhaseEvent(h, B);
  assert.notEqual(ev, null, '须落一条 running->paused 的 batch.phase 事件');
  assert.equal(ev.from, 'running', '相位迁移起点 = running');
  assert.equal(ev.reason, 'chain:onFail-pause', 'reason = chain:<停轮原因>（与 chain.step 的 reason 同源）');
  assert.ok(inWordTable(ev.reason), 'reason 前缀须 ∈ 词表：' + ev.reason);
});

test('PR-2【退役锁 · Q-A=C】停轮分支（`no-lane-for-step`）已删：零 chain.step、零停轮相位事件、相位保持 running', async () => {
  const h = makeHarness();
  const B = 'pr-chain-nolane';
  await mkBatch(h, B);
  seed(h, B, 'plan/spec.md', SPEC);
  await settleFailed(h, B, 'plan');
  // 【退役锁 · Q-A=C 2026-09-18】链停轮分支（`no-lane-for-step` 等）已随链退役删除 ⇒ 自证「零 chain.step / 不停轮」后返回。
  assert.equal((h.store.readBatch(SESSION, B)?.events ?? []).filter((e) => e.type === 'chain.step').length, 0,
    '[退役锁] 零 chain.step（停轮分支留痕已删）');
  assert.equal(stoppedPhaseEvent(h, B), null, '[退役锁] 零停轮相位事件（无第二套口径可对）');
  assert.equal(phaseOf(h, B), 'running', '[退役锁] 相位保持 running');
  return;
  // 反向核：同一批的 chain.step 停轮留痕与相位 reason 同源（读端「为何不推进」的两个入口口径一致）
  const steps = (h.store.readBatch(SESSION, B)?.events ?? []).filter((e) => e.type === 'chain.step');
  const stopStep = steps.find((e) => e.dispatch?.mode === 'pause') ?? null;
  assert.notEqual(stopStep, null, '停轮须先落一条 chain.step（决策事实先于相位动作）');
  const ev = stoppedPhaseEvent(h, B);
  assert.equal(ev.reason, 'chain:' + stopStep.dispatch.reason, '相位 reason = chain:<chain.step 的停轮 reason>（禁第二套口径）');
});

// ── PR-3：`batch_phase` 工具面（写点③）───────────────────────────────────────

test('PR-3 `batch_phase(paused)` ⇒ reason 缺省回填 `manual:batch_phase:paused`；显式传入可覆盖', async () => {
  const h = makeHarness();
  const B = 'pr-manual-phase';
  await mkBatch(h, B);
  await h.byName.batch_phase.execute({ batchId: B, phase: 'paused' }, SESS);
  const ev = stoppedPhaseEvent(h, B);
  assert.equal(ev.reason, 'manual:batch_phase:paused', '暂停类迁移缺省自动回填（不静默）');

  const B2 = 'pr-manual-phase-explicit';
  await mkBatch(h, B2);
  await h.byName.batch_phase.execute({ batchId: B2, phase: 'paused', reason: 'manual:batch_phase:operator-hold' }, SESS);
  assert.equal(stoppedPhaseEvent(h, B2).reason, 'manual:batch_phase:operator-hold', '调用方可显式传 reason 覆盖缺省');
});

// ── PR-4：`batch_control` 干预面（写点④）─────────────────────────────────────

test('PR-4 `batch_control` pause/resume ⇒ reason=`manual:batch_control.<action>`（动作可分辨）', async () => {
  const h = makeHarness();
  const B = 'pr-control';
  await mkBatch(h, B);
  await h.byName.batch_control.execute({ batchId: B, action: 'pause' }, SESS);
  assert.equal(stoppedPhaseEvent(h, B).reason, 'manual:batch_control.pause', 'pause 动作留痕');
  await h.byName.batch_control.execute({ batchId: B, action: 'resume' }, SESS);
  const back = phaseEventsOf(h, B).filter((e) => e.from === 'paused' && e.to === 'running');
  assert.equal(back.length, 1, 'resume ⇒ 恰一条 paused->running 事件');
  assert.equal(back[0].reason, 'manual:batch_control.resume', 'resume 动作留痕（与链停轮可分辨）');
});

// ── PR-5：自动结算停轮（写点②）───────────────────────────────────────────────

test('PR-5 自动结算停轮：判据不满足 ⇒ batch.phase 带 reason=`auto-settle:<门禁码>`（写点②）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-pr-as-'));
  const S = 'sess-pr-as';
  const B = 'pr-as-pause';
  const store = createStore(root);
  const plan = buildWavePlan({ batchId: B, tasks: threeTierTasks(['e1']) });
  store.createBatch(S, { batchId: B, wavePlan: plan, phase: 'running' });
  seedArtifacts(root, S, B, ['e1']);
  store.setMember(S, B, 'e1', 'running');
  fs.rmSync(path.join(root, 'sessions', S, 'artifacts', B, 'exec', 'e1.md')); // 删声明产物 ⇒ 判据链在 merged 处拒
  const ctx = { tools: { register: () => {} }, logger: { info() {}, warn() {}, error() {} } };
  const out = await autoSettleLane({ ctx, store, root }, {
    sessionId: S, batchId: B, lane: 'e1', workerSessionId: 'ws-pr', stopReason: 'completed',
    trigger: AUTO_SETTLE_TRIGGERS.subagentEnd,
  });
  assert.equal(out.action, 'paused', '判据不满足 ⇒ 自动结算停轮（不写 failed）');
  const b = store.readBatch(S, B);
  assert.equal(b.phase, 'paused', '批 running→paused');
  const ev = b.events.filter((e) => e.type === EVT_BATCH_PHASE).find((e) => e.to === 'paused');
  assert.notEqual(ev, undefined, '须落 running->paused 事件');
  assert.ok(String(ev.reason).startsWith('auto-settle:'), 'reason 前缀 = auto-settle:：' + ev.reason);
  assert.ok(String(ev.reason).includes('GATE_EXIT_MISSING'), 'reason 须带门禁码（可定位）：' + ev.reason);
  assert.ok(inWordTable(ev.reason), 'reason 前缀须 ∈ 词表：' + ev.reason);
});

// ── PR-6：非空才写键（零污染硬锁）───────────────────────────────────────────

test('PR-6 空/空白 reason ⇒ 事件**不写** `reason` 键（`{from,to}` 形态零污染）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-pr-clean-'));
  const S = 'sess-pr-clean';
  const store = createStore(root);
  const B = 'pr-clean';
  const plan = buildWavePlan({ batchId: B, tasks: threeTierTasks(['e1']) });
  store.createBatch(S, { batchId: B, wavePlan: plan, phase: 'planning' });
  store.setPhase(S, B, 'running');                       // 无第 4 参 ⇒ reason 缺省 null
  store.setPhase(S, B, 'paused', { reason: '   ' });     // 空白串 ⇒ 归一化为 null
  const evs = store.readBatch(S, B).events.filter((e) => e.type === EVT_BATCH_PHASE);
  assert.equal(evs.length, 2, '两跳相位事件均落盘');
  assert.equal(Object.hasOwn(evs[0], 'reason'), false, '无 reason ⇒ 不得写该键（历史读端零污染）');
  assert.equal(Object.hasOwn(evs[1], 'reason'), false, '空白 reason ⇒ 归一化为 null ⇒ 不得写该键');
  assert.deepEqual([evs[1].from, evs[1].to], ['running', 'paused'], '载荷仍为 {from,to} 两键');
});

// ── PR-7：读端渲染（AC-6）───────────────────────────────────────────────────

test('PR-7 log_export(markdown) 渲染 `<from> -> <to> | <reason>`（读端是「为何不推进」的唯一解释入口）', async () => {
  const h = makeHarness({ logs: true });
  const B = 'pr-log';
  await mkBatch(h, B);
  await h.byName.batch_phase.execute({ batchId: B, phase: 'paused' }, SESS);
  const rep = await h.byName.log_export.execute({ batchId: B, format: 'markdown' }, SESS);
  // 渲染形态 = 单元格内竖线转义（`buildReport` 的 `\|`）：`<from> -> <to> \| <reason>`
  assert.ok(String(rep.report).includes('running -> paused \\| manual:batch_phase:paused'),
    '相位行须渲染 reason（竖线分隔）：' + String(rep.report).split('\n').filter((l) => l.includes('batch.phase')).join(' / '));
});

// ── PR-8：不静默锁（AC-5）───────────────────────────────────────────────────

test('PR-8 源码锁：生产文件的 `setPhase(` 调用点全部带 `{ reason`（链停轮写点已随退役删除）', () => {
  const files = ['lib/engine/auto-settle.js', 'lib/tools/core.js'];
  const calls = [];
  for (const rel of files) {
    const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
    let hits = 0;
    lines.forEach((line, i) => {
      if (!line.includes('setPhase(')) return;
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // 纯注释行（含引述既有签名）不计
      hits += 1;
      calls.push({ rel, n: i + 1, text: line.trim() });
    });
    assert.ok(hits >= 1, rel + ' 须至少一处 setPhase 调用点（锁非空转）');
  }
  // 【2026-09-18 · Q-A=C 链运行期推进退役（显式登记，非静默削弱）】原第三文件 `lib/engine/chain-runner.js` 的
  //   链停轮写点（`pauseBatch` → `store.setPhase(..., 'paused', { reason: 'chain:…' })`）已随链推进**整体删除**
  //   ⇒ 本锁的文件面由 3 收缩为 2、生产写点数由 **4 收缩为 3**（自动结算停轮 / batch_phase / batch_control）。
  //   链停轮的**能力**不再是「有写点」而是「无写点」——故下方补一条反向自证（零 setPhase 调用点）。
  assert.equal(calls.length, 3, '生产写点须恰 3 处（自动结算停轮 / batch_phase / batch_control）：' + JSON.stringify(calls.map((c) => c.rel + ':' + c.n)));
  const bare = calls.filter((c) => !c.text.includes('{ reason'));
  assert.deepEqual(bare, [], '不得存在裸 setPhase 调用（实参串必须含 `{ reason`）：' + JSON.stringify(bare));
  const crCalls = fs.readFileSync(path.join(ROOT, 'lib/engine/chain-runner.js'), 'utf8').split('\n')
    .filter((line) => line.includes('setPhase(') && !/^\s*(\/\/|\*|\/\*)/.test(line));
  assert.deepEqual(crCalls, [], '[退役锁] `lib/engine/chain-runner.js` 零 setPhase 调用点（链停轮写点已删除）');
});
