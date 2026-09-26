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

// 灵活装配 × 角色词法白名单：同源修复回归（2026-09-14 实测缺口）
// 缺口事实（探针 scripts/probes/flex-assembly-audit.mjs，leader 直做）：
//   ① 资产把自有角色写进 `layers[*].roles`（技能映射的键 = 最自然的写法），但没抄一份到 `roles.extra` ⇒
//      建批时每个自定义 lane 角色被判 `GATE_ROLE_INVALID`、计划/验收位报 `GATE_ROLE_MISSING`
//      ——「指引说放开层/角色/技能的组装」与「白名单只认 8 基础角色∪盲审三角色 + roles.extra」对不上。
//   ② 缓存键只含 `root::team`、无失效判据 ⇒ 同进程内改资产**不重载**：Leader 的灵活装配循环
//      （写资产 → 建批 → 见告警 → 补声明 → 重建批）第二步仍读旧值，修正隔空失效（长驻进程 = 直到重启）。
// 修复语义：
//   ① 角色词法集 = 资产各层声明角色 ∪ `roles.extra`（`unionRoleVocabulary`）——白名单与**声明面同源**；
//   ② `roles.extra` 降级为**可选补充**（字段语义不变：仍是「显式声明的扩展角色」）；
//   ③ 缓存以「资产路径 + mtime + size」签名判新旧，改了即重读；
//   ④ 额外牵头角色（`plan_leads` / `audit_leads`）**仍须显式声明**（本次未改：`GATE_ROLE_MISSING` 语义保留）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { assessC } from './helpers/gate-fixture.mjs';
import { resolveTeamRoles, resolveTeamFlows, unionRoleVocabulary, clearRoleCache, clearFlowCache, packageRoot } from '../lib/assembly/flows.js';
import { teamAssetSignature } from '../lib/assembly/team-asset.js';

const SESS = { agent: { session: { id: 'sess-flexroles' } } };
const TEAM = 'flex-team';

// 资产：自定义角色**只**写在 layers 里（技能映射的键）+ 显式声明牵头（指引要求的另一项）
function assetOnlyInLayers({ extra = null, skills = true } = {}) {
  const a = {
    team: TEAM,
    layers: {
      plan: { roles: ['brief-owner'], skills: { 'brief-owner': skills ? ['SPEC-SKILL'] : [] } },
      exec: { roles: ['asset-maker'], skills: { 'asset-maker': ['EXEC-SKILL'] } },
      audit: { roles: ['gate-keeper'], skills: { 'gate-keeper': ['AUDIT-SKILL'] } },
    },
    roles: { plan_leads: ['brief-owner'], audit_leads: ['gate-keeper'] },
    flows: {
      plan: { produce_field: 'produce' },
      exec: { produce_field: 'outputs' },
      audit: {
        produce_field: 'produce',
        // P2（audit 职责声明化）：含 audit lane + 解析到团队资产 ⇒ 必须声明 audit_contract；
        // 本 fixture 断言 warnings 零告警，故给**实内容**（空 {} / exempt 会落 GATE_AUDIT_CONTRACT_EXEMPT 告警）
        audit_contract: {
          criteria_from: 'plan/**',
          verdict: ['pass', 'fail', 'skip'],
        },
      },
    },
  };
  if (extra) a.roles.extra = extra;
  return a;
}

// 三条 lane（plan/exec/audit），角色全部取自资产 layers 声明
function tasks(roles = {}) {
  const r = { plan: 'brief-owner', exec: 'asset-maker', audit: 'gate-keeper', ...roles };
  return [
    { id: 'p1', layer: 'plan', role: r.plan, produce: ['plan/spec.md'], cmd: 'plan-it' },
    { id: 'e1', layer: 'exec', role: r.exec, consume: ['plan/spec.md'], outputs: ['exec/out.md'], deps: ['p1'], cmd: 'build-it' },
    { id: 'a1', layer: 'audit', role: r.audit, consume: ['plan/spec.md', 'exec/out.md'], produce: ['audit/report.md'], deps: ['e1'], cmd: 'check-it' },
  ];
}

function mkTeamsRoot(team, asset) {
  const teamsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-flexroles-'));
  fs.mkdirSync(path.join(teamsRoot, 'presets', team), { recursive: true });
  writeAsset(teamsRoot, team, asset);
  return teamsRoot;
}
const assetPath = (root, team) => path.join(root, 'presets', team, 'team-asset.json');
const writeAsset = (root, team, asset) => fs.writeFileSync(assetPath(root, team), JSON.stringify(asset, null, 2), 'utf8');

function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-flexroles-state-'));
  const store = createStore(root);
  const ctx = { tools: { register: () => {} }, logger: console };
  const { tools } = createTools(ctx, { store, root });
  // G1 前置（新门禁）：`wave_plan` 属 C 档动作 ⇒ 建批前先把本会话评估为 C（同 assign_check 落盘函数）
  assessC(store, SESS.agent.session.id, { rationale: 'fixture：灵活装配套件建批前置评估（plan/exec/audit 多线 ⇒ C 档）' });
  return { root, store, byName: Object.fromEntries(tools.map((t) => [t.name, t])) };
}
const codesOf = (out) => (out.warnings ?? []).map((w) => w.code);

// ── ① 缺口①回归：角色只写在 layers 里 ⇒ 不再被判非法、牵头齐备、技能前缀照资产注入 ──
test('F1 灵活装配：自定义角色只声明在资产 layers[*].roles ⇒ 零 GATE_ROLE_INVALID（修复前 5 条告警）', async () => {
  const teamsRoot = mkTeamsRoot(TEAM, assetOnlyInLayers()); // 刻意**不带** roles.extra
  try {
    clearRoleCache();
    clearFlowCache();
    const { byName } = makeHarness();
    const out = await byName.wave_plan.execute({ batchId: 'flex-f1', tasks: tasks(), team: TEAM, teamsRoot, assembly: { auditLane: 'a1' } }, SESS);
    const codes = codesOf(out);
    assert.equal(codes.includes('GATE_ROLE_INVALID'), false, '角色已声明于资产 layers ⇒ 不得判非法：' + JSON.stringify(out.warnings));
    assert.equal(codes.includes('GATE_ROLE_MISSING'), false, '牵头角色已声明（plan_leads/audit_leads）⇒ 齐备：' + JSON.stringify(out.warnings));
    // 技能前缀仍按同一资产的 layers.skills 注入（角色可拔插 = 词法合法 + 能力前缀两件事都对）
    const cmds = out.wavePlan.flatMap((w) => w.tasks).map((t) => t.cmd);
    assert.ok(cmds.some((c) => c.includes('[role=brief-owner] [skills=SPEC-SKILL]')), JSON.stringify(cmds));
    assert.ok(cmds.some((c) => c.includes('[role=asset-maker] [skills=EXEC-SKILL]')), JSON.stringify(cmds));
    assert.ok(cmds.some((c) => c.includes('[role=gate-keeper] [skills=AUDIT-SKILL]')), JSON.stringify(cmds));
  } finally { fs.rmSync(teamsRoot, { recursive: true, force: true }); clearRoleCache(); clearFlowCache(); }
});

// ── ② 缺口①回归（装配声明面）：assembly.roles 里的自定义角色同样不再误判 ──
test('F2 装配声明面同源：assembly.roles 写资产声明角色 ⇒ 零 GATE_ROLE_INVALID 且词条保留', async () => {
  const teamsRoot = mkTeamsRoot(TEAM, assetOnlyInLayers());
  try {
    clearRoleCache();
    clearFlowCache();
    const { byName } = makeHarness();
    const cluster = [
      { id: 'p1', layer: 'plan', role: 'brief-owner', produce: ['plan/spec.md'], cmd: 'plan-it' },
      { id: 'e1', layer: 'exec', role: 'asset-maker', consume: ['plan/spec.md'], outputs: ['exec/a.md'], deps: ['p1'], cmd: 'a' },
      { id: 'e2', layer: 'exec', role: 'asset-maker', consume: ['plan/spec.md'], outputs: ['exec/b.md'], deps: ['p1'], cmd: 'b' },
      { id: 'e3', layer: 'exec', role: 'asset-maker', consume: ['plan/spec.md'], outputs: ['exec/c.md'], deps: ['p1'], cmd: 'c' },
      { id: 'a1', layer: 'audit', role: 'gate-keeper', consume: ['plan/spec.md', 'exec/a.md'], produce: ['audit/r.md'], deps: ['e1', 'e2', 'e3'], cmd: 'chk' },
    ];
    const assembly = { managerPlan: 'raise', auditLane: 'a1', coordinatorLane: 'p1', roles: ['brief-owner', 'asset-maker', 'gate-keeper'] };
    const out = await byName.wave_plan.execute({ batchId: 'flex-f2', tasks: cluster, team: TEAM, teamsRoot, assembly }, SESS);
    assert.equal(codesOf(out).includes('GATE_ROLE_INVALID'), false, 'assembly.roles 团队声明角色须合法：' + JSON.stringify(out.warnings));
    assert.deepEqual(out.assembly.roles, ['brief-owner', 'asset-maker', 'gate-keeper'], '合法词条保留');
    // 负向对照：真·未声明角色仍判非法（同源不等于放开）
    const bad = await byName.wave_plan.execute({ batchId: 'flex-f2b', tasks: tasks({ exec: 'ghost-role' }), team: TEAM, teamsRoot, assembly: { auditLane: 'a1' } }, SESS);
    assert.ok(codesOf(bad).includes('GATE_ROLE_INVALID'), '未在任何层/roles.extra 出现的角色仍须告警');
  } finally { fs.rmSync(teamsRoot, { recursive: true, force: true }); clearRoleCache(); clearFlowCache(); }
});

// ── ③ 兼容：`roles.extra` 字段语义不变（仍是「显式声明的扩展角色」），union 是**额外**读端 ──
test('F3 兼容：software-team roles.extra 仍为空；unionRoleVocabulary = 各层声明角色 ∪ roles.extra', () => {
  clearRoleCache();
  const sw = resolveTeamRoles('software-team', { root: packageRoot() });
  assert.equal(sw.ok, true);
  assert.deepEqual([...sw.extra], [], 'software-team 无扩展角色声明（字段语义未变）');
  assert.deepEqual([...sw.layerRoles].sort(), ['coder', 'coordinator', 'designer', 'doc-manager', 'reviewer', 'supervisor', 'tester'], '各层声明角色并集');
  assert.deepEqual(unionRoleVocabulary(sw).sort(), [...sw.layerRoles].sort(), 'union = 各层 ∪ extra（extra 空 ⇒ 等于各层）');
  assert.deepEqual(unionRoleVocabulary(null), [], '缺声明 → 空集（回落基础集）');
  assert.deepEqual(unionRoleVocabulary({ layerRoles: ['A-Role'], extra: ['b-role'] }), ['a-role', 'b-role'], '小写归一 + 去重');
  clearRoleCache();
});

// ── ④ 缺口②回归：同进程内改资产 ⇒ 立即可见（不再需要重启/清缓存）──
test('F4 缓存陈旧修复：同 root+team 改资产后（extra / flows）读端立即反映新值', async () => {
  const teamsRoot = mkTeamsRoot(TEAM, assetOnlyInLayers());
  try {
    clearRoleCache();
    clearFlowCache();
    const v1Sig = teamAssetSignature(teamsRoot, TEAM);
    assert.ok(v1Sig && v1Sig.includes(assetPath(teamsRoot, TEAM)), '签名含资产路径：' + v1Sig);
    const r1 = resolveTeamRoles(TEAM, { root: teamsRoot });
    assert.deepEqual([...r1.extra], []);
    const f1 = resolveTeamFlows(TEAM, { root: teamsRoot });
    assert.equal(f1.ok, true);
    assert.equal(f1.flows.exec.entry_requires, undefined, 'v1：exec 未强制 consume');

    // 就地改资产（同 team 同 root，不清缓存）：补 roles.extra + exec entry_requires
    const v2 = assetOnlyInLayers({ extra: ['late-role'] });
    v2.flows.exec.entry_requires = ['consume'];
    writeAsset(teamsRoot, TEAM, v2);
    const v2Sig = teamAssetSignature(teamsRoot, TEAM);
    assert.notEqual(v2Sig, v1Sig, '签名须随文件变化（mtime/size）');

    const r2 = resolveTeamRoles(TEAM, { root: teamsRoot });
    assert.deepEqual([...r2.extra], ['late-role'], '改资产后 extra 立即反映（修复前：仍为空）');
    assert.deepEqual(unionRoleVocabulary(r2).includes('late-role'), true, 'union 立即可见新角色');
    const f2 = resolveTeamFlows(TEAM, { root: teamsRoot });
    assert.deepEqual(f2.flows.exec.entry_requires, ['consume'], 'flows 改资产后立即生效（修复前：仍读旧值）');
  } finally { fs.rmSync(teamsRoot, { recursive: true, force: true }); clearRoleCache(); clearFlowCache(); }
});

// ── ⑤ 缺口②端到端：按告警补声明后「重建批」须真的消警（Leader 灵活装配的实际循环）──
test('F5 灵活装配循环端到端：建批 → 补 roles.extra → 同进程重建批 ⇒ GATE_ROLE_INVALID 消失', async () => {
  const teamsRoot = mkTeamsRoot(TEAM, assetOnlyInLayers());
  try {
    clearRoleCache();
    clearFlowCache();
    const { byName } = makeHarness();
    const before = await byName.wave_plan.execute({ batchId: 'flex-f5a', tasks: tasks({ exec: 'late-role' }), team: TEAM, teamsRoot, assembly: { auditLane: 'a1' } }, SESS);
    assert.ok(codesOf(before).includes('GATE_ROLE_INVALID'), '未声明角色先告警（负向基线）');
    writeAsset(teamsRoot, TEAM, assetOnlyInLayers({ extra: ['late-role'] }));
    const after = await byName.wave_plan.execute({ batchId: 'flex-f5b', tasks: tasks({ exec: 'late-role' }), team: TEAM, teamsRoot, assembly: { auditLane: 'a1' } }, SESS);
    assert.equal(codesOf(after).includes('GATE_ROLE_INVALID'), false, '补声明后重建批须消警（修复前：缓存陈旧 ⇒ 仍告警）');
  } finally { fs.rmSync(teamsRoot, { recursive: true, force: true }); clearRoleCache(); clearFlowCache(); }
});
