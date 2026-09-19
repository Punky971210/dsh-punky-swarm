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

// P1 · 团队资产必填化（构造期拒）——验收标准 1/2/3/4 的用例面
// ─────────────────────────────────────────────────────────────────────────────
// 契约来源：批次 `p1-team-asset-mandatory-20260916` 的 `plan/spec.md`
//   ① 无资产（team 名拼错 / 未建资产 / team 缺失）⇒ 构造期**拒建批且零批次 JSON 落盘**；
//   ② `team:'generic'` ⇒ 构造期拒（`TEAM_ASSET_NOT_FOUND`），零批次落盘；
//   ③ teamsRoot 临时团队资产的 `skills` **不可解析** ⇒ 构造期拒（`TEAM_ASSET_SKILLS_MISMATCH`），零批次落盘；
//   ④ `loadTeamAsset(<pkgRoot>, 'engine-team')` ⇒ `ok:true` / `problems:[]`；以 `team:'engine-team'` 建批
//      零 `GATE_TEAM_ASSET_*` / `GATE_ROLE_MISSING` 事件。
// 设计决定（Leader 补充的三条打点）：
//   D-1 `chain` 台账条目：P1 **登记**（`key:'chain'`，consumer 标 P2）→ **P2 接线后整条删除**（批
//       `p2-chain-autodrive-20260916` §缺省链口径：「`chain` 不再是未接线声明 ⇒ 台账条目**整条删除**」）。
//       本用例已按 P2 **反转**为「**不得登记**」：P1 的「登记且可读」断言在 P2 起即为 RED——
//       保留反转形态是为了**防回退**（若将来又出现 `key:'chain'`，此处立刻红）。
//   D-2 自建团队 skills 不可解析的用例**经显式 env 注入技能根**（`USERPROFILE`/`HOME` + `.agents/skills`，
//       与引擎读端同源，零新 env），不依赖真实 `~/.agents/skills`；
//   D-3 读端不再把缺省团队兜底为 `generic`。
// 技能根纪律（P1 §3）：可解析名 = 技能**目录名** ∪ `SKILL.md` frontmatter `name`；技能根**不存在/不可读 ⇒ 同码拒**。
// 命名空间消歧：`presets/<team>/team-asset.{json,yml}` = **团队资产**；`presets/punky-preset/` = 预设（模式）资产，
//   **不是团队资产** ⇒ 把它当 team 传同样「无资产 ⇒ 拒」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { assessC } from './helpers/gate-fixture.mjs';
import { clearRoleCache } from '../lib/assembly/flows.js';
import { loadTeamAsset, unwiredDeclarationsOf, UNWIRED_DECLARATIONS } from '../lib/assembly/team-asset.js';
import { buildAgentDescriptor } from '../lib/aip/agent-descriptor.js';
import { declaredSkillsOf, listTeamAssetNames, packageRootOf, readTeamAssetSource, seedHostSkills } from './helpers/host-skills.mjs';

const SESS = { agent: { session: { id: 'sess-ta-mandatory' } } };
const SID = SESS.agent.session.id;

// ── 技能根（显式 env 注入面：与核心读端同源 = USERPROFILE||HOME + /.agents/skills）──
// 造根/读资产原文的实现统一走 `test/helpers/host-skills.mjs`（与 P1 同步面共用，避免两处算法漂移）。
const seedSkills = seedHostSkills;

// ── 建批夹具（与 test/teams-root.test.js 同形：C 档前置 + 真工具注册面）──

function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-ta-mand-'));
  const store = createStore(root);
  const ctx = { tools: { register: () => {} }, logger: console };
  const { tools } = createTools(ctx, { store, root });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assessC(store, SID, { rationale: 'fixture：P1 团队资产必填化用例的建批前置评估（三层多依赖 ⇒ C 档）' });
  return { root, store, byName };
}

const batchFileOf = (root, batchId) => path.join(root, 'sessions', SID, 'batches', batchId + '.json');
const batchLanded = (root, batchId) => fs.existsSync(batchFileOf(root, batchId));

// 三层任务（plan 产物被 exec 与 audit 双消费；exec 仅 1 条 ⇒ 不触发 C+ 装配面噪音）
// 角色取名以 software-team 声明为准（无资产用例里角色不参与判定；但**不可传 undefined**——工具面入参 schema
// 要求 tasks 元素是 lossless JSON，`undefined` 会在进 execute 之前就被参数校验拦下，污染被检面）。
const roleOfSw = (layer) => ({ plan: 'designer', exec: 'coder', audit: 'supervisor' })[layer];

function threeTierTasks(roleOf) {
  return [
    { id: 'p1', layer: 'plan', role: roleOf('plan'), produce: ['plan/spec.md'], cmd: 'plan-it' },
    { id: 'e1', layer: 'exec', role: roleOf('exec'), consume: ['plan/spec.md'], outputs: ['exec/e1.md'], deps: ['p1'], cmd: 'run-it' },
    { id: 'a1', layer: 'audit', role: roleOf('audit'), consume: ['plan/spec.md', 'exec/e1.md'], produce: ['audit/a1.md'], deps: ['e1'], cmd: 'verify-it' },
  ];
}

// ── ① 无资产 ⇒ 拒且零批次落盘 ─────────────────────────────────────────────

test('P1-1a 无资产（team 名拼错 / 未建资产）⇒ 构造期拒 TEAM_ASSET_NOT_FOUND，且零批次 JSON 落盘', async () => {
  const { root, byName } = makeHarness();
  clearRoleCache();
  const batchId = 'ta-mand-noasset';
  let msg = null;
  try {
    await byName.wave_plan.execute({
      batchId, team: 'no-such-team-xyz', tasks: threeTierTasks(roleOfSw),
      assembly: { managerPlan: 'leader-direct', auditLane: 'a1' },
    }, SESS);
  } catch (e) {
    msg = String(e?.message ?? e);
  }
  assert.notEqual(msg, null, '解析不到资产必须构造期拒（不得再出现「告警 + 照常建批」）');
  assert.match(msg, /TEAM_ASSET_NOT_FOUND/, '拒态须原样透出资产码');
  // 拒态文案「可读可自救」：须点名「该团队无资产 ⇒ 改用有资产的团队」并给出可引用团队名
  assert.match(msg, /engine-team|software-team|design-team|research-team|writing-team/,
    '拒态文案须给出可自救的出路（点名一个有资产的团队）：' + msg);
  assert.equal(batchLanded(root, batchId), false, '拒后零批次 JSON 落盘');
});

test('P1-1b 预设（模式）名误用：`team:punky-preset`（无 team-asset）⇒ 同码拒 + 零批次落盘', async () => {
  const { root, byName } = makeHarness();
  clearRoleCache();
  assert.equal(listTeamAssetNames().includes('punky-preset'), false,
    '命名空间消歧前提：presets/punky-preset 不是团队资产（无 team-asset.{json,yml}）');
  const batchId = 'ta-mand-presetname';
  await assert.rejects(
    () => byName.wave_plan.execute({
      batchId, team: 'punky-preset', tasks: threeTierTasks(roleOfSw),
      assembly: { managerPlan: 'leader-direct', auditLane: 'a1' },
    }, SESS),
    /TEAM_ASSET_NOT_FOUND/,
    '预设名不是团队名 ⇒ 同属「无资产 ⇒ 拒」',
  );
  assert.equal(batchLanded(root, batchId), false, '拒后零批次 JSON 落盘');
});

test('P1-1c `team` 缺失 / 空串 ⇒ 构造期拒 TEAM_ASSET_MISSING_FIELD，且零批次 JSON 落盘', async () => {
  const { root, byName } = makeHarness();
  clearRoleCache();
  const tasks = threeTierTasks(() => undefined);
  const assembly = { managerPlan: 'leader-direct', auditLane: 'a1' };
  // 缺失：落在参数 schema 的 required 面（"missing required property \"team\"" / `"team" is required`）
  //   或构造期码面 —— 两处都不许放行（P1 §5：`team` 声明为 required）。
  await assert.rejects(
    () => byName.wave_plan.execute({ batchId: 'ta-mand-noteam', tasks, assembly }, SESS),
    /TEAM_ASSET_MISSING_FIELD|"team" is required|missing required property "team"/,
    'team 缺失必须拒（fail-closed，不回落 generic）',
  );
  assert.equal(batchLanded(root, 'ta-mand-noteam'), false, '拒后零批次 JSON 落盘');
  await assert.rejects(
    () => byName.wave_plan.execute({ batchId: 'ta-mand-emptyteam', team: '', tasks, assembly }, SESS),
    /TEAM_ASSET_MISSING_FIELD|invalid arguments/,
    'team 空串必须拒（码表：缺失 / 空串 ⇒ TEAM_ASSET_MISSING_FIELD）',
  );
  assert.equal(batchLanded(root, 'ta-mand-emptyteam'), false, '拒后零批次 JSON 落盘');
});

// ── ② team:'generic' ⇒ 拒且零批次落盘 ────────────────────────────────────

test("P1-2 `team:'generic'`（已废除）⇒ 构造期拒 TEAM_ASSET_NOT_FOUND，且零批次 JSON 落盘", async () => {
  const { root, byName } = makeHarness();
  clearRoleCache();
  const batchId = 'ta-mand-generic';
  await assert.rejects(
    () => byName.wave_plan.execute({
      batchId, team: 'generic', tasks: threeTierTasks(roleOfSw),
      assembly: { managerPlan: 'leader-direct', auditLane: 'a1' },
    }, SESS),
    /TEAM_ASSET_NOT_FOUND/,
    'generic 已废除：解析不到资产 ⇒ 同码拒',
  );
  assert.equal(batchLanded(root, batchId), false, '拒后零批次 JSON 落盘');
});

// ── ③ teamsRoot 临时团队 skills 不可解析 ⇒ 拒且零批次落盘（D-2：显式 env 注入技能根）──

const UNSOLVABLE = 'ta-mand-unresolvable-skill-zzz';
const SEEDED = 'ta-mand-seeded-skill';

function tmpAssetWithSkills(skills) {
  return {
    team: 'ta-mand-team',
    layers: {
      plan: { roles: ['outline-designer'], skills: { 'outline-designer': [skills.plan] } },
      exec: { roles: ['scribe'], skills: { scribe: [skills.exec] } },
      audit: { roles: ['fact-checker'], skills: { 'fact-checker': [skills.audit] } },
    },
    roles: { extra: ['outline-designer', 'scribe', 'fact-checker'], plan_leads: ['outline-designer'], audit_leads: ['fact-checker'] },
    flows: {
      plan: { produce_field: 'produce' },
      exec: { produce_field: 'outputs', entry_requires: ['consume'] },
      audit: {
        produce_field: 'produce',
        audit_contract: { criteria_from: 'plan/**', verdict: ['pass', 'fail', 'skip'] },
      },
    },
  };
}

function mkTeamsRoot(asset) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-ta-mand-teams-'));
  fs.mkdirSync(path.join(root, 'presets', 'ta-mand-team'), { recursive: true });
  fs.writeFileSync(path.join(root, 'presets', 'ta-mand-team', 'team-asset.json'), JSON.stringify(asset), 'utf8');
  return root;
}

const roleOfTmp = (layer) => ({ plan: 'outline-designer', exec: 'scribe', audit: 'fact-checker' })[layer];

test('P1-3 自建团队（teamsRoot）skills 不可解析 ⇒ 构造期拒 TEAM_ASSET_SKILLS_MISMATCH，且零批次 JSON 落盘', async () => {
  const { root, byName } = makeHarness();
  clearRoleCache();
  // 显式 env 注入技能根：技能根**存在**且含一条可解析名 ⇒ 反例的成因只能是「名字不可解析」，而非「根不存在」
  seedSkills([SEEDED]);
  const teamsRoot = mkTeamsRoot(tmpAssetWithSkills({ plan: SEEDED, exec: UNSOLVABLE, audit: SEEDED }));
  const batchId = 'ta-mand-badskills';
  await assert.rejects(
    () => byName.wave_plan.execute({
      batchId, team: 'ta-mand-team', teamsRoot, tasks: threeTierTasks(roleOfTmp),
      assembly: { managerPlan: 'leader-direct', auditLane: 'a1' },
    }, SESS),
    /TEAM_ASSET_SKILLS_MISMATCH/,
    '某 role 的 skills 非空但不可解析 ⇒ 同码拒（语义由「非空」扩为「非空且可解析」）',
  );
  assert.equal(batchLanded(root, batchId), false, '拒后零批次 JSON 落盘');

  // 正向对照：同一资产把不可解析名换成已注入名 ⇒ 建批成功（证明拒因是名字、不是「一律拒」）
  const okRoot = mkTeamsRoot(tmpAssetWithSkills({ plan: SEEDED, exec: SEEDED, audit: SEEDED }));
  clearRoleCache();
  const ok = await byName.wave_plan.execute({
    batchId: 'ta-mand-goodskills', team: 'ta-mand-team', teamsRoot: okRoot, tasks: threeTierTasks(roleOfTmp),
    assembly: { managerPlan: 'leader-direct', auditLane: 'a1' },
  }, SESS);
  assert.equal(ok.batchId, 'ta-mand-goodskills');
  assert.equal(batchLanded(root, 'ta-mand-goodskills'), true, '可解析 ⇒ 照常建批');
});

test('P1-3b 技能根**不存在**（显式 env 切到无技能的 HOME）⇒ 同码拒（不放行、不静默跳过）', async () => {
  const { root, byName } = makeHarness();
  clearRoleCache();
  const teamHome = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-ta-mand-nohome-')); // 该根下刻意不造 .agents/skills
  const prevUser = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  const teamsRoot = mkTeamsRoot(tmpAssetWithSkills({ plan: SEEDED, exec: SEEDED, audit: SEEDED }));
  try {
    process.env.USERPROFILE = teamHome;
    process.env.HOME = teamHome;
    clearRoleCache();
    await assert.rejects(
      () => byName.wave_plan.execute({
        batchId: 'ta-mand-noroot', team: 'ta-mand-team', teamsRoot, tasks: threeTierTasks(roleOfTmp),
        assembly: { managerPlan: 'leader-direct', auditLane: 'a1' },
      }, SESS),
      /TEAM_ASSET_SKILLS_MISMATCH/,
      '技能根不存在 ⇒ 不得静默跳过 skills 校验',
    );
    assert.equal(batchLanded(root, 'ta-mand-noroot'), false, '拒后零批次 JSON 落盘');
  } finally {
    if (prevUser === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUser;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    clearRoleCache();
  }
});

// ── ④ engine-team 资产正向 ───────────────────────────────────────────────

test('P1-4a engine-team 资产：loadTeamAsset ok:true / problems:[]，牵头角色不悬空（D-1 `chain` 已接线 ⇒ 台账条目已删）', () => {
  const src = readTeamAssetSource('engine-team');
  assert.ok(src, 'presets/engine-team/team-asset.{json,yml} 必须存在（P1 §4）');
  // 隔离夹具：把该资产声明的技能名注入隔离技能根（显式 env 面 = 已重定向的 HOME），再按宿主读端校验
  seedSkills(declaredSkillsOf(src.asset));
  clearRoleCache();
  const r = loadTeamAsset(packageRootOf(), 'engine-team');
  assert.equal(r.ok, true, 'engine-team 资产必须加载期通过：' + JSON.stringify(r.problems));
  assert.deepEqual(r.problems, [], 'problems 必须为空数组');
  assert.equal(r.asset.team, 'engine-team');

  // 牵头角色不悬空（加载期不变量 LEAD_NOT_IN_LAYERS 的反证：逐名核对存在性）
  const layerRoles = new Set();
  for (const def of Object.values(r.asset.layers ?? {})) for (const role of def?.roles ?? []) layerRoles.add(role);
  for (const key of ['plan_leads', 'audit_leads']) {
    for (const role of r.asset.roles?.[key] ?? []) {
      assert.ok(layerRoles.has(role), `roles.${key} 的 ${role} 必须在某层 layers[*].roles 里真实存在（禁悬空声明）`);
    }
  }

  // D-1 **反转**（P2 接线后，批 `p2-chain-autodrive-20260916`）：`chain` 已有构造期校验 + 读端回显 ⇒
  //   沿革：P1 登记（`status:'unwired'`、consumer 标 P2）→ P2 接线 ⇒ 台账条目**整条删除**
  //   （spec §缺省链口径：「只改 status 不清误报」）。判据由「必须登记且可读」反转为「**不得登记**」，
  //   断言强度未减（仍逐条核对同一台账 + 同一读端），只把方向对准现行真相，并锁死回退。
  assert.equal(UNWIRED_DECLARATIONS.some((d) => d.key === 'chain'), false,
    'D-1（P2 反转）：`chain` 已接线 ⇒ UNWIRED_DECLARATIONS 不得再登记 chain（P1 登记、P2 接线后删除该条）');
  const readable = unwiredDeclarationsOf({ flows: {}, chain: { layers: ['plan', 'exec', 'audit'] } });
  assert.deepEqual(readable.map((d) => d.key), [],
    'P2：`chain` 已有读端（构造期校验 + `batch_status` 回显）⇒ 未接线读出端不得再把它读成「未接线」');
});

test("P1-4b 以 team:'engine-team' 建批：零 GATE_TEAM_ASSET_* / GATE_ROLE_MISSING 事件", async () => {
  const { root, store, byName } = makeHarness();
  const src = readTeamAssetSource('engine-team');
  assert.ok(src, 'engine-team 资产必须存在');
  seedSkills(declaredSkillsOf(src.asset));
  clearRoleCache();
  const roleOf = (layer) => (src.asset.layers?.[layer]?.roles ?? [])[0];
  const out = await byName.wave_plan.execute({
    batchId: 'ta-mand-engine', team: 'engine-team', tasks: threeTierTasks(roleOf),
    assembly: { managerPlan: 'leader-direct', auditLane: 'a1' },
  }, SESS);
  assert.equal(out.batchId, 'ta-mand-engine');
  const codes = (out.warnings ?? []).map((w) => w.code);
  assert.deepEqual(codes.filter((c) => String(c).startsWith('GATE_TEAM_ASSET_')), [], '零 GATE_TEAM_ASSET_* 告警：' + JSON.stringify(out.warnings));
  assert.deepEqual(codes.filter((c) => c === 'GATE_ROLE_MISSING'), [], '零 GATE_ROLE_MISSING 告警：' + JSON.stringify(out.warnings));
  const evs = store.readBatch(SID, 'ta-mand-engine').events ?? [];
  const evCodes = evs.map((e) => e.code).filter(Boolean);
  assert.deepEqual(evCodes.filter((c) => String(c).startsWith('GATE_TEAM_ASSET_') || c === 'GATE_ROLE_MISSING'), [], '批事件流同样零资产/角色缺口：' + JSON.stringify(evCodes));
  assert.equal(batchLanded(root, 'ta-mand-engine'), true);
});

// ── D-3 读端不再把缺省团队兜底为 generic ────────────────────────────────

test('P1-D3 读端兜底清理：缺省团队不得再被读成 generic', () => {
  // ① AIP 描述符读端（`lib/aip/agent-descriptor.js`）：assembly 无 team ⇒ aic 不得以 generic. 打头
  const desc = buildAgentDescriptor({ layers: { exec: { roles: ['coder'], skills: { coder: [] } } } }, 'exec', 'coder');
  assert.ok(!String(desc.aic).startsWith('generic.'), 'D-3：读端不得再把缺省团队兜底为 generic（实测 aic=' + desc.aic + '）');

  // ② 状态库读端（`lib/state/store.js` createBatch）：直调（不走工具门）亦不得把缺省写死成 generic
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-ta-mand-d3-'));
  const store = createStore(root);
  let landedTeam = null;
  let refusal = null;
  try {
    store.createBatch(SID, { batchId: 'ta-mand-d3', wavePlan: { wavePlan: [] } });
    landedTeam = store.readBatch(SID, 'ta-mand-d3')?.team ?? null;
  } catch (e) {
    refusal = String(e?.message ?? e);
  }
  if (refusal !== null) assert.doesNotMatch(refusal, /generic/, '拒也要拒得明确（不得回落 generic）：' + refusal);
  else assert.notEqual(landedTeam, 'generic', 'D-3：缺省团队不得落成 generic（实测 team=' + String(landedTeam) + '）');
});
