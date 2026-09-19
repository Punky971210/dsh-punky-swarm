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

// test/w1-conditional-edges.test.js —— **W1-② 条件边已由 M1 反转**（下线拒绝面）
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ 头注登记（严格按规格 `plan/spec.md` §2 S4.3-T1）：本文件原本是 **W1-② 条件边**用例面
//   （2026-09-16：把 `on` 键域从 `{merged,fail}` 扩为成员终态全体，锁定「显式路由优先 / 未声明即旧语义」）。
//   **M1（2026-09-17 用户裁决，批 `handoff-consolidation-m0m1-20260917`）把该能力整体撤销**：
//   步级条件边 `on` **声明即拒**（`TEAM_ASSET_FIELD_NOT_ALLOWED` @ `chain.steps.<id>.on`，三版本同拒）。
//   ⇒ 本文件**同题反转**：原「条件路由」用例失去对象（能力已下线），改为锁「**拒绝面**」+
//   「**删除面**」+「**未声明时的旧语义逐字不变**」三件事（**不删文件、不删断言**，逐条改写）。
//   M1 的删除面/写侧白名单锁另见 `test/m1-on-removed.test.js`（T4）。
// 判据面（本文件的「本批判据」）：
//   ① 声明即拒：`on`（任意键/值形态，v1/v2/v3）⇒ FIELD_NOT_ALLOWED @ 父键 `on`，拒后**零批次 JSON 落盘**；
//   ② `skipped` **恒不推进**（`{action:'none', reason:'skipped-no-advance'}`）——逐字沿用「未声明」的旧语义；
//   ③ `failed` / `conflict` **逐字同路**：落批次级失败面（`join:any` 的 `anyFailure` → 链级 `onFail`），
//      不再有步级「最具体分支优先」这一层；
//   ④ `via` 写侧白名单收窄（`CHAIN_STEP_VIA` 三值）⇒ 端到端 `chain.step.via` 只可能出现 `next`/`onFail`/`anyFailure`。
// 事实源纪律：断言一律读 `store.readBatch` 的批次 JSON（唯一事实源），不读模块内部状态。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as chainMod from '../lib/assembly/chain.js';
import { validateChain, chainNextOf, CHAIN_STEP_VIA } from '../lib/assembly/chain.js';
import { createStore } from '../lib/state/store.js';
import { createTools } from '../lib/tools/register.js';
import { clearRoleCache } from '../lib/assembly/flows.js';
import { assessC } from './helpers/gate-fixture.mjs';
import { seedHostSkills, declaredSkillsOf } from './helpers/host-skills.mjs';

const SESSION = 'sess-w1c';
const SESS = { agent: { session: { id: SESSION } } };
const TEAM = 'w1c-team';
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
    audit_contract: { criteria_from: 'plan/spec.md', consumes_required: ['plan/'], verdict: ['approve', 'reject'] },
  },
};

// ── 夹具链（两条；差异只在「是否声明已下线的 `on`」）──────────────────────────
/** 链①：**声明 `on`**（M1 后 = 拒绝面夹具；键域已不存在，故任意键/值形态同拒）。
 *  其余部分（`next` 拓扑 / 层 / 角色 / 终态）保持**合规** ⇒ 变量被隔离到 `on` 一项（拒态码可判）。 */
function chainWithOn({ version = 1, on = { merged: 'exec', skipped: 'audit' } } = {}) {
  return {
    version,
    steps: [
      { id: 'plan', layer: 'plan', role: 'designer', next: 'exec', on },
      { id: 'exec', layer: 'exec', role: 'coder', join: 'all', next: 'audit' },
      { id: 'audit', layer: 'audit', role: 'reviewer', terminal: true },
    ],
    join: { anyFailure: 'pause' },
    onFail: 'pause',
  };
}
/** 链②：**未声明 `on` 的等价链**（`next`-only）= M1 后的规范形态（正向对照 + 端到端基线）。 */
function chainNextOnly({ onFail = 'pause' } = {}) {
  return {
    version: 1,
    steps: [
      { id: 'plan', layer: 'plan', role: 'designer', next: 'exec' },
      { id: 'exec', layer: 'exec', role: 'coder', join: 'all', next: 'audit' },
      { id: 'audit', layer: 'audit', role: 'reviewer', terminal: true },
    ],
    join: { anyFailure: 'pause' },
    onFail,
  };
}

const TASKS = () => [
  { id: 'plan', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
  { id: 'exec', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/exec.md'], cmd: 'build' },
  { id: 'audit', layer: 'audit', role: 'reviewer', consume: ['plan/spec.md', 'exec/exec.md'], produce: ['audit/audit.md'], cmd: 'accept' },
];

/** 建批夹具：临时 `teamsRoot`（资产 + 宿主技能根按显式 env 注入）+ 真工具注册面 + `subagents` 桩。 */
function makeHarness({ chain }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-w1c-'));
  const store = createStore(root);
  const spawned = [];
  const ctx = {
    tools: { register: () => {} },
    logger: { info() {}, warn() {}, error() {} },
    subagents: { startContinuable: async (spec) => { spawned.push(spec.label); return { id: 'w-w1c-' + spawned.length }; } },
  };
  const teamsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-w1c-teams-'));
  const asset = { team: TEAM, layers: LAYERS, roles: ROLES, flows: FLOWS, chain };
  const dir = path.join(teamsRoot, 'presets', TEAM);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'team-asset.json'), JSON.stringify(asset, null, 2), 'utf8');
  seedHostSkills(declaredSkillsOf(asset));
  clearRoleCache();
  const { tools } = createTools(ctx, { store, root, config: { dispatch: { provider: 'spawn-in-process' } } });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assessC(store, SESSION, { rationale: 'fixture：W1-② 反转（M1 下线拒绝面）用例的建批前置评估（三层 ⇒ C 档）' });
  return { root, store, byName, ctx, teamsRoot, spawned };
}

/** 装配声明：**`raise`**（链推进在 `leader-direct` 批上已于 M0′-① 起全程 no-op ⇒ 本套件取非 leader-direct 形态）。 */
const ASSEMBLY = { managerPlan: 'raise', auditLane: 'audit' };
const batchFileOf = (root, batchId) => path.join(root, 'sessions', SESSION, 'batches', batchId + '.json');
/** 建批 + 武装（链推进的武装前提 = 相位 `running`）。 */
async function mkBatch(h, batchId) {
  await h.byName.wave_plan.execute({ batchId, team: TEAM, teamsRoot: h.teamsRoot, tasks: TASKS(), assembly: ASSEMBLY }, SESS);
  await h.byName.batch_phase.execute({ batchId, phase: 'running' }, SESS);
}
function seed(h, batchId, rel, body = 'out') {
  const abs = path.join(h.root, 'sessions', SESSION, 'artifacts', batchId, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
}
/** 走完一条 lane 的合法结算链（工具路：`exec.agent` 在场 ⇒ 链推进走真派发）。
 *  两条状态机约束（`lib/schema.js`）：① `review → skipped` **非法**，跳过须 `running → skipped` 直达；
 *  ② 非 `merged` 终态须带非空 note（Tier3 `GATE_SETTLE_NOTE_MISSING`）。 */
async function settleLane(h, batchId, lane, status) {
  const cur = () => h.store.readBatch(SESSION, batchId)?.lanes?.[lane];
  if (cur() !== 'running') await h.byName.member_status.execute({ batchId, lane, status: 'running' }, SESS);
  if (status !== 'skipped' && cur() === 'running') await h.byName.member_status.execute({ batchId, lane, status: 'review' }, SESS);
  // 非 merged 终态须带非空 note（Tier3 `GATE_SETTLE_NOTE_MISSING`）；merged 须**不写该键**
  // （工具参数面要求 lossless JSON ⇒ `note: undefined` 会被拒）
  const args = { batchId, lane, status };
  if (status !== 'merged') args.note = 'W1-② 反转夹具：' + lane + ' → ' + status + '（下线拒绝面用例的理由留痕）';
  return h.byName.member_settle.execute(args, SESS);
}
const eventsOf = (h, batchId) => h.store.readBatch(SESSION, batchId)?.events ?? [];
const chainStepsOf = (h, batchId) => eventsOf(h, batchId).filter((e) => e.type === 'chain.step');
const phaseOf = (h, batchId) => h.store.readBatch(SESSION, batchId)?.phase;
const lanesOf = (h, batchId) => h.store.readBatch(SESSION, batchId)?.lanes ?? {};

// ── 1. 声明面：`on` 声明即拒（原「键域扩展」用例整体反转）─────────────────────

test('W1C-1 反转 · 声明即拒：`on`（任意键域）⇒ FIELD_NOT_ALLOWED @ chain.steps.plan.on，三版本同拒', () => {
  for (const version of [1, 2, 3]) {
    const r = validateChain(chainWithOn({ version }), LAYERS);
    assert.equal(r.ok, false, 'version=' + version + '：声明 `on` 必须拒（W1-② 的能力已由 M1 撤销）');
    assert.ok(
      r.problems.some((p) => p.code === 'TEAM_ASSET_FIELD_NOT_ALLOWED' && p.path === 'chain.steps.plan.on'),
      'version=' + version + '：拒态 = FIELD_NOT_ALLOWED @ 父键 `on`：' + JSON.stringify(r.problems),
    );
  }
});

test('W1C-2 反转 · 旧「悬空目标」判据随之消失：`on.skipped=\'ghost\'` 拒在**父键**而非子键（不双报）', () => {
  // 原 W1C-2 断言「新键同样受校验③约束 ⇒ MISSING_FIELD @ chain.steps.plan.on.skipped」。
  // M1 后 `on` 整体是未知键 ⇒ 只报一行 FIELD_NOT_ALLOWED @ `on`；**不得**再产子键路径报码（避免误导读者去修子键）。
  const r = validateChain(chainWithOn({ on: { skipped: 'ghost' } }), LAYERS);
  assert.equal(r.ok, false, '含悬空值的 `on` 仍必须拒');
  assert.equal(
    r.problems.some((p) => String(p.path).startsWith('chain.steps.plan.on.')), false,
    '不得残留子键路径报码：' + JSON.stringify(r.problems.map((p) => p.path)),
  );
  assert.ok(r.problems.some((p) => p.path === 'chain.steps.plan.on'), '只报父键 `on`');
});

test('W1C-3 反转 · 「键域白名单」判据消失：旧合法键与非法键**同拒同路**（`done` 不再单独报 on.done）', () => {
  for (const on of [{ merged: 'exec' }, { fail: 'exec' }, { skipped: 'exec' }, { conflict: 'exec' }, { done: 'exec' }]) {
    const r = validateChain(chainWithOn({ on }), LAYERS);
    assert.equal(r.ok, false, '键 ' + JSON.stringify(Object.keys(on)) + '：一律拒');
    assert.ok(
      r.problems.some((p) => p.code === 'TEAM_ASSET_FIELD_NOT_ALLOWED' && p.path === 'chain.steps.plan.on'),
      '拒态路径恒为父键 `on`（键域概念已不存在）：' + JSON.stringify(r.problems.map((p) => p.path)),
    );
  }
});

test('W1C-4 反转 · 「禁表达式」判据移出 `on` 面：表达式键/值仍拒，但拒态归父键（不再有 on.<k> 面）', () => {
  for (const on of [{ '${x}': 'exec' }, { merged: '${x}' }]) {
    const r = validateChain(chainWithOn({ on }), LAYERS);
    assert.equal(r.ok, false, '表达式形态 ' + JSON.stringify(on) + ' 必须拒');
    assert.ok(
      r.problems.some((p) => p.code === 'TEAM_ASSET_FIELD_NOT_ALLOWED' && p.path === 'chain.steps.plan.on'),
      '拒态须为父键 `on`：' + JSON.stringify(r.problems.map((p) => p.path)),
    );
  }
  // 「禁表达式」判据本身仍活着——只是改挂在**仍在下线的键**上：`onFail` 传模板串 ⇒ FIELD_NOT_ALLOWED
  const c = chainNextOnly();
  c.onFail = '${x}';
  const r2 = validateChain(c, LAYERS);
  assert.equal(r2.ok, false, '`onFail` 表达式必须仍拒（判据未删，只是不再服务 `on`）');
  assert.ok(r2.problems.some((p) => p.path === 'chain.onFail'), '报码路径 = chain.onFail：' + JSON.stringify(r2.problems.map((p) => p.path)));
});

test('W1C-5 反转 · 写侧白名单收窄：`CHAIN_STEP_VIA` 三值，历史 `on` 族取值不再在册（禁回填）', () => {
  assert.deepEqual([...CHAIN_STEP_VIA], ['next', 'onFail', 'anyFailure'], 'via 白名单 = 新写侧可能产生的全集');
  assert.equal(CHAIN_STEP_VIA.some((v) => v.startsWith('on.')), false, '历史条件边取值不得加回（加回 = 声明面已下线却仍能写入）');
  assert.equal(Object.hasOwn(chainMod, 'CHAIN_ON_TOKENS'), false, '键域常量已随声明面删除');
});

// ── 2. 判定单点：未声明 ⇒ 旧语义逐字不变（原「显式路由优先」用例反转）──────────

test('W1C-6 反转 · `skipped` 恒不推进（原「显式声明 `on.skipped` ⇒ advance」失去对象后的唯一形态）', () => {
  const c = chainNextOnly();
  for (const step of [c.steps[0], c.steps[1]]) {
    const r = chainNextOf(c, step, 'skipped', { stepLanes: [step.id], laneStates: { [step.id]: 'skipped' } });
    assert.deepEqual([r.action, r.to, r.via], ['none', null, null], '步 ' + step.id + '：skipped ⇒ 不推进');
    assert.equal(r.reason, 'skipped-no-advance', 'reason 逐字 = skipped-no-advance（旧语义硬锁）');
  }
  // 佐证：即便对象上残留已下线的 `on` 键，判定面也不消费它（未过校验的输入形态）
  const residual = { id: 'exec', layer: 'exec', role: 'coder', on: { skipped: 'audit' } };
  const r2 = chainNextOf(c, residual, 'skipped', { stepLanes: ['exec'], laneStates: { exec: 'skipped' } });
  assert.deepEqual([r2.action, r2.to, r2.via], ['none', null, null], '残留 `on` 键不得改变判定');
  assert.equal(r2.reason, 'skipped-no-advance', 'reason 仍为旧语义');
});

test('W1C-7 汇合面未变：join:all 下兄弟 lane `skipped` 视为未完成 ⇒ merged 触发仍 wait', () => {
  const c = chainNextOnly();
  const step = c.steps[1]; // exec：join 缺省 all
  const r = chainNextOf(c, step, 'merged', { stepLanes: ['exec', 'exec2'], laneStates: { exec: 'merged', exec2: 'skipped' } });
  assert.equal(r.action, 'wait', '兄弟 skipped 仍算未完成 ⇒ 汇合未齐');
  assert.deepEqual(r.pending, ['exec2'], 'pending 含 skipped 的兄弟 lane（口径逐字不变）');
});

test('W1C-8 反转 · `conflict` 与 `failed` **逐字同路**：只余批次级失败面（enum token ⇒ pause/hold）', () => {
  const c = chainNextOnly();
  for (const outcome of ['failed', 'conflict']) {
    const r = chainNextOf(c, c.steps[1], outcome, { stepLanes: ['exec'], laneStates: { exec: 'running' } });
    assert.deepEqual([r.action, r.via, r.to], ['pause', 'onFail', null], outcome + '：落链级 onFail（缺省 pause），无步级层');
    assert.equal(r.reason, 'onFail-pause', outcome + '：reason 逐字不变');
  }
  // `join:any` + `anyFailure` 仍是失败面的**上级**（顺序未变：anyFailure → onFail）
  const c2 = chainNextOnly();
  c2.steps[1].join = 'any';
  c2.join = { anyFailure: 'audit' };
  for (const outcome of ['failed', 'conflict']) {
    const r = chainNextOf(c2, c2.steps[1], outcome, { stepLanes: ['exec'], laneStates: { exec: 'running' } });
    assert.deepEqual([r.action, r.to, r.via], ['advance', 'audit', 'anyFailure'], outcome + '：join:any ⇒ 走 anyFailure');
  }
});

test('W1C-9 反转 · `onFail` 的 review/failed 两 token 仍为 hold（只留痕停轮、不改相位）', () => {
  const c = chainNextOnly({ onFail: 'review' });
  const r = chainNextOf(c, c.steps[1], 'failed', { stepLanes: ['exec'], laneStates: { exec: 'running' } });
  assert.deepEqual([r.action, r.via, r.to], ['hold', 'onFail', null], 'review token ⇒ hold（交还 Leader 裁决）');
  assert.equal(r.reason, 'onFail-review', 'reason = onFail-<token>');
});

// ── 3. 端到端（真工具路）：拒绝面 + 零落盘 + 新 via 取值 ───────────────────────

test('W1C-10 端到端 · 声明 `on` 的资产 ⇒ 建批拒 FIELD_NOT_ALLOWED 且**零批次 JSON 落盘**', async () => {
  const h = makeHarness({ chain: chainWithOn() });
  const B = 'w1c-reject';
  let msg = null;
  try {
    await h.byName.wave_plan.execute({ batchId: B, team: TEAM, teamsRoot: h.teamsRoot, tasks: TASKS(), assembly: ASSEMBLY }, SESS);
  } catch (e) {
    msg = String(e?.message ?? e);
  }
  assert.notEqual(msg, null, '构造期必须拒（`createBatch` 之前）');
  assert.ok(String(msg).startsWith('TEAM_ASSET_FIELD_NOT_ALLOWED'), '拒态码原样透出：' + String(msg).slice(0, 140));
  assert.equal(fs.existsSync(batchFileOf(h.root, B)), false, '拒后零批次 JSON 落盘');
});

test('W1C-11【退役锁 · Q-A=C】端到端 · `next`-only 链 plan merged ⇒ 不再推进 exec（零 chain.step、exec 保持 pending、相位不变）', async () => {
  const h = makeHarness({ chain: chainNextOnly() });
  const B = 'w1c-next';
  await mkBatch(h, B);
  seed(h, B, 'plan/spec.md', SPEC);
  await settleLane(h, B, 'plan', 'merged');
  // 【退役锁 · Q-A=C 2026-09-18（批 engine-retire-chain-20260918）】链运行期推进已退役 ⇒ 自证
  //  「零 chain.step / 不再自动置 running」后返回；旧断言保留在下方作历史口径留档（不再执行）。
  assert.equal(chainStepsOf(h, B).length, 0, '[退役锁] 零 chain.step（推进留痕写点已删）');
  assert.equal(lanesOf(h, B).exec, 'pending', '[退役锁] exec lane 不再被引擎自动置 running');
  assert.equal(phaseOf(h, B), 'running', '[退役锁] 相位不变');
  return;

  const steps = chainStepsOf(h, B);
  assert.equal(steps.length, 1, '恰一条 chain.step（`next` 命中 ⇒ 推进留痕）');
  assert.deepEqual([steps[0].from, steps[0].to, steps[0].via, steps[0].lane], ['plan', 'exec', 'next', 'plan'],
    '链判定单点：plan→exec via next（`via` 不在册时会被写 null ⇒ 本断言兜住白名单漏配）');
  assert.equal(lanesOf(h, B).exec, 'running', 'exec lane 由引擎自动置 running');
  assert.equal(phaseOf(h, B), 'running', '正常推进 ⇒ 不停轮');
});

test('W1C-12 端到端 · `skipped` ⇒ 零 chain.step、相位不变（旧语义逐字不变，端到端口径）', async () => {
  const h = makeHarness({ chain: chainNextOnly() });
  const B = 'w1c-skip';
  await mkBatch(h, B);
  seed(h, B, 'plan/spec.md', SPEC);
  await settleLane(h, B, 'plan', 'skipped');

  assert.equal(lanesOf(h, B).plan, 'skipped', 'plan lane 结算到 skipped');
  assert.equal(chainStepsOf(h, B).length, 0, 'skipped ⇒ 不推进（零 chain.step）');
  assert.equal(phaseOf(h, B), 'running', '相位不变（不停轮、不判死）');
});

test('W1C-13【退役锁 · Q-A=C】端到端 · `conflict` ⇒ 不再走批次级失败面（零 chain.step、批不停轮）', async () => {
  const h = makeHarness({ chain: chainNextOnly() });
  const B = 'w1c-conflict';
  await mkBatch(h, B);
  seed(h, B, 'plan/spec.md', SPEC);
  await settleLane(h, B, 'exec', 'conflict');
  // 【退役锁 · Q-A=C 2026-09-18】失败面推进/停轮已随链退役消失 ⇒ 自证「零 chain.step / 不停轮」后返回（旧断言留档）。
  assert.equal(chainStepsOf(h, B).length, 0, '[退役锁] 零 chain.step（失败面留痕写点已删）');
  assert.equal(phaseOf(h, B), 'running', '[退役锁] 链级 onFail=pause 停轮写点已删 ⇒ 批相位保持 running');
  return;

  const steps = chainStepsOf(h, B);
  assert.equal(steps.length, 1, '恰一条 chain.step（失败面留痕）');
  assert.deepEqual([steps[0].from, steps[0].to, steps[0].via], ['exec', null, 'onFail'],
    'M1 后 conflict 与 failed 同路：via=onFail、to=null（enum token 非步 id）');
  assert.equal(steps[0].dispatch?.mode, 'pause', '停轮留痕（真失败处置，不静默）');
  assert.equal(phaseOf(h, B), 'paused', '链级 onFail=pause ⇒ 批停轮');
});

test('W1C-14【退役锁 · Q-A=C】端到端 · `join:any` 的 `anyFailure` 失败面已删（零 chain.step、相位保持 running）', async () => {
  const c = chainNextOnly();
  c.steps[1].join = 'any';
  c.join = { anyFailure: 'review' }; // 合法 token（pause/review/failed）⇒ review = hold（只留痕、不改相位）
  const h = makeHarness({ chain: c });
  const B = 'w1c-anyfail';
  await mkBatch(h, B);
  seed(h, B, 'plan/spec.md', SPEC);
  await settleLane(h, B, 'exec', 'conflict');
  // 【退役锁 · Q-A=C 2026-09-18】`join:any` / `anyFailure` 失败面已随链退役消失 ⇒ 自证「零 chain.step」后返回（旧断言留档）。
  assert.equal(chainStepsOf(h, B).length, 0, '[退役锁] 零 chain.step（anyFailure 面已删）');
  assert.equal(phaseOf(h, B), 'running', '[退役锁] 相位不变');
  return;

  const steps = chainStepsOf(h, B);
  assert.equal(steps.length, 1, '恰一条 chain.step');
  assert.deepEqual([steps[0].from, steps[0].to, steps[0].via], ['exec', null, 'anyFailure'],
    'join:any ⇒ 命中 anyFailure（优先于链级 onFail，顺序未变）');
  assert.equal(steps[0].dispatch?.mode, 'hold', 'review token ⇒ hold（决策留痕、不改相位）');
  assert.equal(phaseOf(h, B), 'running', 'hold 不停轮（处置交还 Leader/Manager）');
});
