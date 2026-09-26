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

// test/m1-on-removed.test.js —— **M1：删 `on` 声明面**用例面（批 `handoff-consolidation-m0m1-20260917`）
// ─────────────────────────────────────────────────────────────────────────────
// 判据（规格 `plan/spec.md` §2 S4 / AC-8 / AC-9 / AC-10）：
//   · **声明即拒**（fail-closed）：`chain.steps[].on` 从「白名单键」变「未知键」⇒ 显式声明一律拒
//     `TEAM_ASSET_FIELD_NOT_ALLOWED` @ `chain.steps.<id>.on`（**不是**静默忽略——R3 的反面）；
//     版本 1/2/3 同拒，拒后**零批次 JSON 落盘**；
//   · **删除面归零**：`CHAIN_ON_TOKENS` 不再存在；`edgesOfStep` 只产 `next`；`chainNextOf` 不再消费 `on`；
//   · **写侧收窄**：`CHAIN_STEP_VIA` 三值 `['next','onFail','anyFailure']` ⇒ 新写不可能产出 `on.*`；
//   · **读侧历史兼容（零改动，硬锁）**：`chainEchoOf` 不校验 `via` ⇒ 磁盘上既有的 `via:'on.merged'` 照常回显；
//     `countReworkAttempts` 仍匹配历史 `via`（K2，服务历史批的跨重启幂等 —— 该处是本文件唯一豁免的字面命中）。
// 事实源纪律：断言一律读 `store.readBatch` 的批次 JSON / 模块导出面，不读模块内部状态。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as chainMod from '../lib/assembly/chain.js';
import { validateChain, edgesOfStep, chainNextOf, chainEchoOf, CHAIN_STEP_VIA } from '../lib/assembly/chain.js';
import * as chainRunnerMod from '../lib/engine/chain-runner.js';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { createTools } from '../lib/tools/register.js';
import { clearRoleCache } from '../lib/assembly/flows.js';
import { threeTierTasks } from './helpers/gate-fixture.mjs';
import { writeSyntheticTeam } from './helpers/team-fixture.mjs';
import { assessC } from './helpers/gate-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSION = 'sess-m1';
const SESS = { agent: { session: { id: SESSION } } };
const TEAM = 'm1-team';
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

/** 声明 `on` 的链（`version` 参数化 ⇒ 三版本同拒判据）。`on` 的值形态与键域无关（声明即拒）。 */
function chainWithOn(version, on = { merged: 'exec' }) {
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

/** lib/** 源码文本（跳过注释？不——删除面判据要求含注释面零残留，故**原样读全文**）。 */
function libSources() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push({ rel: path.relative(ROOT, p).replace(/\\/g, '/'), text: fs.readFileSync(p, 'utf8') });
    }
  };
  walk(path.join(ROOT, 'lib'));
  return out;
}

// ── 1. 声明即拒（三版本）──────────────────────────────────────────────────────

test('M1-1 声明即拒（version 1|2|3 同拒）：`on` ⇒ TEAM_ASSET_FIELD_NOT_ALLOWED @ chain.steps.plan.on', () => {
  for (const version of [1, 2, 3]) {
    const r = validateChain(chainWithOn(version), LAYERS);
    assert.equal(r.ok, false, 'version=' + version + '：声明 `on` 必须拒（不得静默忽略）');
    const hit = r.problems.find((p) => p.code === 'TEAM_ASSET_FIELD_NOT_ALLOWED' && p.path === 'chain.steps.plan.on');
    assert.ok(hit, 'version=' + version + '：须报 FIELD_NOT_ALLOWED @ chain.steps.plan.on：' + JSON.stringify(r.problems));
    assert.match(String(hit.message), /已下线/, 'version=' + version + '：报码文案须点名「已下线」（可自救）：' + hit.message);
    assert.match(String(hit.message), /next/, 'version=' + version + '：文案须给正路替代（`next`）：' + hit.message);
  }
});

test('M1-2 拒绝面是「声明即拒」而非「按旧键域逐键拒」：键与值形态均不改变拒态路径（路径恒为父键 `on`）', () => {
  for (const on of [{ merged: 'exec' }, { done: 'exec' }, { merged: 42 }, { skipped: 'audit', conflict: 'audit' }]) {
    const r = validateChain(chainWithOn(1, on), LAYERS);
    assert.equal(r.ok, false, '声明 `on`=' + JSON.stringify(on) + ' 必须拒');
    assert.ok(
      r.problems.some((p) => p.code === 'TEAM_ASSET_FIELD_NOT_ALLOWED' && p.path === 'chain.steps.plan.on'),
      '拒态路径 = 父键 `on`（不按旧键域逐键报）：' + JSON.stringify(r.problems.map((p) => p.path)),
    );
    assert.equal(
      r.problems.some((p) => String(p.path).startsWith('chain.steps.plan.on.')), false,
      '不得残留「on.<token> 值域」子键报码（那属已下线面）：' + JSON.stringify(r.problems.map((p) => p.path)),
    );
  }
});

test('M1-3 未声明 `on` 的等价链（`next`-only）照常通过八条校验（删除面不等价于「全链更严」）', () => {
  const c = chainWithOn(1);
  delete c.steps[0].on;
  const r = validateChain(c, LAYERS);
  assert.deepEqual(r.problems, [], '`next`-only 等价链须八条全过：' + JSON.stringify(r.problems));
  for (const version of [2, 3]) {
    const cv = chainWithOn(version);
    delete cv.steps[0].on;
    assert.equal(validateChain(cv, LAYERS).ok, true, 'version=' + version + ' 的 next-only 链须通过');
  }
});

// ── 2. 删除面归零（模块导出面 + 源码面）───────────────────────────────────────

test('M1-4 `CHAIN_ON_TOKENS` 已删（导出面不存在），且 lib/** 源码零字面命中', () => {
  assert.equal(Object.hasOwn(chainMod, 'CHAIN_ON_TOKENS'), false, '键域常量必须随声明面一并删除');
  const hits = libSources().filter((f) => f.text.includes('CHAIN_ON_TOKENS')).map((f) => f.rel);
  assert.deepEqual(hits, [], 'lib/** 不得残留 CHAIN_ON_TOKENS 引用：' + JSON.stringify(hits));
});

test('M1-5 `CHAIN_STEP_VIA` 收窄为三值（写侧白名单），历史 `on.*` 不再在册', () => {
  assert.deepEqual([...CHAIN_STEP_VIA], ['next', 'onFail', 'anyFailure'], 'via 白名单 = 写侧可能产生的全集');
  assert.equal(CHAIN_STEP_VIA.some((v) => v.startsWith('on.')), false, '历史值不得回填（写侧不再产生）');
  // 【2026-09-18 · Q-A=C 链运行期推进退役】载荷构造器 `chainStepPayload` 已**删除**（`chain.step` 唯一写点随之
  //   消失）⇒ 原「不在册 via ⇒ 载荷写 null / 在册 via 原样保留」两条断言失去对象，改为**导出面不存在**锁。
  assert.equal(Object.hasOwn(chainRunnerMod, 'chainStepPayload'), false,
    '[退役锁] `chain.step` 载荷构造器已随链推进退役删除（不是「改名保留」）');
  assert.equal(Object.hasOwn(chainRunnerMod, 'countReworkAttempts'), false,
    '[退役锁] K2 回边计数（其唯一调用方在 chain-runner 内）已随推进退役删除');
  assert.equal(typeof chainRunnerMod.advanceChainAfterSettle, 'function',
    '[退役锁] 推进入口保留导出但**首行 no-op**（三处写域外调用点的加载期兼容）');
});

test('M1-6 `edgesOfStep` 只产 `next` 边（`on` 不再进拓扑面）', () => {
  assert.deepEqual(
    edgesOfStep({ id: 'plan', next: 'exec', on: { merged: 'audit', fail: 'audit' } }),
    [{ from: 'plan', to: 'exec', via: 'next' }],
    '残留 `on` 键不得再产出边',
  );
  assert.deepEqual(edgesOfStep({ id: 'x', on: { merged: 'audit' } }), [], '只有 `on` 的步 ⇒ 零边');
});

test('M1-7 lib/** 内 `on.*` 字面残留只允许出现在 K2 历史读端计数（读侧兼容，spec §4 R2 明令保留）', () => {
  const pat = /on\.(merged|fail|skipped|conflict)/g;
  const k2 = /e\.via === 'on\.(fail|conflict)'/g;
  let residual = 0;
  let k2Hits = 0;
  const offenders = [];
  for (const f of libSources()) {
    f.text.split('\n').forEach((line, i) => {
      const hits = line.match(pat) ?? [];
      if (hits.length === 0) return;
      residual += hits.length;
      const inK2 = (line.match(k2) ?? []).length;
      k2Hits += inK2;
      // 本行的每处命中都必须是 K2 的历史 `via` 比较（其余即为删除面残留）
      if (inK2 !== hits.length) offenders.push(f.rel + ':' + (i + 1) + ' ' + line.trim());
    });
  }
  assert.equal(k2Hits, 0, 'K2 历史读端计数已随链运行期推进退役**整体删除**（`countReworkAttempts` 无残留）：' + k2Hits);
  assert.equal(residual, 0, 'lib 内 `on.*` 残留总数须 = 0（声明/校验/路由/计数面全清）：' + residual);
  assert.deepEqual(offenders, [], '声明/校验/路由/注释面不得残留 `on.*`：' + JSON.stringify(offenders));
});

// ── 3. 判定单点：`on` 不再被消费（即便对象上残留该键）─────────────────────────

test('M1-8 `chainNextOf` 不再消费 `on`：merged/skipped 走新口径，failed 走批次级策略', () => {
  // 刻意构造「**对象上残留 `on` 键** + **无 `next`**」的步（未过校验的输入形态）⇒ 判定面必须无视 `on`
  const step = { id: 'plan', layer: 'plan', role: 'designer', on: { merged: 'audit', fail: 'audit', skipped: 'audit', conflict: 'audit' } };
  const c = {
    version: 1,
    steps: [step, { id: 'audit', layer: 'audit', role: 'reviewer', terminal: true }],
    join: { anyFailure: 'pause' },
    onFail: 'pause',
  };
  const merged = chainNextOf(c, step, 'merged', { stepLanes: ['plan'], laneStates: { plan: 'merged' } });
  assert.deepEqual([merged.action, merged.to, merged.via], ['none', null, null], 'merged：`next` 缺省时不再兜条件边');
  assert.equal(merged.reason, 'chain-end', 'reason 逐字 = chain-end（链尾/无后继）');

  const skipped = chainNextOf(c, step, 'skipped', { stepLanes: ['plan'], laneStates: { plan: 'skipped' } });
  assert.deepEqual([skipped.action, skipped.to, skipped.via], ['none', null, null], 'skipped：恒不推进');
  assert.equal(skipped.reason, 'skipped-no-advance', 'reason 逐字不变');

  const failed = chainNextOf(c, step, 'failed', { stepLanes: ['plan'], laneStates: { plan: 'running' } });
  assert.deepEqual([failed.action, failed.via], ['pause', 'onFail'], 'failed：不再命中步级失败边 ⇒ 落批次级 onFail（缺省 pause）');
  assert.equal(failed.reason, 'onFail-pause', 'reason 逐字不变');

  const conflict = chainNextOf(c, step, 'conflict', { stepLanes: ['plan'], laneStates: { plan: 'running' } });
  assert.deepEqual([conflict.action, conflict.via, conflict.to], ['pause', 'onFail', null], 'conflict：与 failed **逐字同路**（无「最具体分支优先」层）');
});

// ── 4. 读侧历史兼容（零改动硬锁，AC-10）───────────────────────────────────────

test('M1-9 `chainEchoOf` 回显磁盘历史 `via:"on.merged"`（读端不校验 via ⇒ 天然兼容）', () => {
  const batch = {
    events: [
      { ts: '2026-09-16T00:00:00Z', type: 'chain.step', from: 'review', to: 'audit', via: 'on.merged', lane: 'review' },
    ],
  };
  const echo = chainEchoOf(batch, { version: 1, steps: [] });
  assert.deepEqual(echo.edges, [{ from: 'review', to: 'audit', via: 'on.merged' }], '历史 via 原样回显（不得写 null）');
  assert.deepEqual(echo.lastStep, { from: 'review', to: 'audit', via: 'on.merged', lane: 'review' }, 'lastStep 同步回显');
});

test('M1-10 log_export 对历史 `on.*` via 无报错、原样渲染（读端第二消费面）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-m1-hist-'));
  const store = createStore(root);
  const batchId = 'm1-hist';
  const plan = buildWavePlan({ batchId, tasks: threeTierTasks(['e1']) });
  store.createBatch(SESSION, { batchId, wavePlan: plan, phase: 'running' });
  store.appendEvent(SESSION, batchId, 'chain.step', { from: 'review', to: 'audit', via: 'on.merged', lane: 'review' });
  const ctx = { tools: { register: () => {} }, logger: { info() {}, warn() {}, error() {} } };
  const { tools } = createTools(ctx, { store, root, config: { capabilities: { logs: { enabled: true } } } });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const rep = await byName.log_export.execute({ batchId, format: 'markdown' }, SESS);
  assert.equal(rep.ok, true, 'log_export 对历史 via 不得报错');
  assert.ok(String(rep.report).includes('on.merged'), 'markdown 时间线须原样渲染历史 via：' + String(rep.report).slice(0, 200));
});

// ── 5. 构造期拒 + 零批次 JSON 落盘（真工具路，AC-9 后半）──────────────────────

function makeHarness({ chain }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-m1-'));
  const store = createStore(root);
  const ctx = {
    tools: { register: () => {} },
    logger: { info() {}, warn() {}, error() {} },
    subagents: { start: async () => ({ id: 'w-m1', result: Promise.resolve({ output: [], stopReason: 'completed' }) }) },
  };
  const teamsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-m1-teams-'));
  const asset = { team: TEAM, layers: LAYERS, roles: ROLES, flows: FLOWS, chain };
  // F2：合成资产 ⇒ 单点写入（helpers/team-fixture.mjs）。
  writeSyntheticTeam(teamsRoot, TEAM, asset);
  clearRoleCache();
  const { tools } = createTools(ctx, { store, root, config: { dispatch: { provider: 'spawn-in-process' } } });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assessC(store, SESSION, { rationale: 'fixture：M1 删除面用例的建批前置评估（三层 + 多步链 ⇒ C 档）' });
  return { root, store, byName, teamsRoot };
}

const TASKS = () => ([
  { id: 'plan', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
  { id: 'exec', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/exec.md'], cmd: 'build' },
  { id: 'audit', layer: 'audit', role: 'reviewer', consume: ['plan/spec.md', 'exec/exec.md'], produce: ['audit/audit.md'], cmd: 'accept' },
]);
/** 含 audit 层的三层批必带装配声明（`GATE_ROLE_ASSEMBLY_MISSING`）；用**缺省 `raise`** 形态
 *  （`leader-direct` 在 M0′-① 后链推进全程 no-op，与本套件的判据面无关，故刻意不选）。 */
const ASSEMBLY = { managerPlan: 'raise', auditLane: 'audit' };

test('M1-11 真工具路：声明 `on` 的资产 ⇒ 建批拒 TEAM_ASSET_FIELD_NOT_ALLOWED 且零批次 JSON 落盘', async () => {
  const h = makeHarness({ chain: chainWithOn(1) });
  const batchId = 'm1-reject';
  let msg = null;
  try {
    await h.byName.wave_plan.execute({ batchId, team: TEAM, teamsRoot: h.teamsRoot, tasks: TASKS(), assembly: ASSEMBLY }, SESS);
  } catch (e) {
    msg = String(e?.message ?? e);
  }
  assert.notEqual(msg, null, '声明 `on` 必须在 `createBatch` 之前拒（不得建批）');
  assert.ok(String(msg).startsWith('TEAM_ASSET_FIELD_NOT_ALLOWED'), '拒态码须原样透出：' + String(msg).slice(0, 160));
  assert.equal(
    fs.existsSync(path.join(h.root, 'sessions', SESSION, 'batches', batchId + '.json')), false,
    '拒后零批次 JSON 落盘',
  );
});

test('M1-12 正向对照：同一资产去掉 `on` ⇒ 建批成功（拒绝面不误伤 `next`-only 资产）', async () => {
  const c = chainWithOn(1);
  delete c.steps[0].on;
  const h = makeHarness({ chain: c });
  const batchId = 'm1-accept';
  const out = await h.byName.wave_plan.execute({ batchId, team: TEAM, teamsRoot: h.teamsRoot, tasks: TASKS(), assembly: ASSEMBLY }, SESS);
  assert.equal(out.batchId, batchId, '`next`-only 资产须正常建批');
  assert.equal(
    fs.existsSync(path.join(h.root, 'sessions', SESSION, 'batches', batchId + '.json')), true,
    '正向对照：批次 JSON 须落盘',
  );
});

// ── 6. 5 资产零改动对照面（硬判据 K5 的可核形式）─────────────────────────────

test('M1-13 5 个内置团队资产的 `chain` 块零 `on` 使用（K5：删除面对内置资产无行为影响）', () => {
  const teams = ['design-team', 'engine-team', 'research-team', 'software-team', 'writing-team'];
  const withOn = [];
  const checked = [];
  for (const team of teams) {
    for (const ext of ['yml', 'yaml', 'json']) {
      const p = path.join(ROOT, 'presets', team, 'team-asset.' + ext);
      if (!fs.existsSync(p)) continue;
      const text = fs.readFileSync(p, 'utf8');
      checked.push(team + '/' + ext);
      // 行首键形态（声明位）：`on:` / `on :` 在 `chain` 段内出现即为使用
      if (/^\s*on\s*:/m.test(text)) withOn.push(team + '/' + ext);
      break;
    }
  }
  assert.equal(checked.length, 5, '5 个内置团队资产须逐一检到：' + JSON.stringify(checked));
  assert.deepEqual(withOn, [], 'K5 硬判据：5 资产 chain 块不得使用 `on`（删 on 后行为不变的前提）：' + JSON.stringify(withOn));
});
