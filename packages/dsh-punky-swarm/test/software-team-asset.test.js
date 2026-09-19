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

// software-team 装配冒烟（按团队资产 `presets/software-team/team-asset.yml` 的实际内容核对）
//   事实源：`skills/software-team/SKILL.md` §角色概览（3 层 7 角色）+ §装配表（角色 → 操作手册）
//   本文件同时是「**指引 → 引擎装配**」的一致性锚：指引改了而装配没跟，这里先红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { loadTeamAsset, TEAM_ASSET_CODES } from '../lib/assembly/team-asset.js';
import { resolveTeamFlows, resolveTeamRoles, clearRoleCache, clearFlowCache, packageRoot } from '../lib/assembly/flows.js';
import { resolveAssembly, assemblyFromTeamAsset, DEFAULT_ASSEMBLY } from '../lib/assembly.js';
import { buildWavePlan, normalizeRole, PLAN_LEAD_ROLES, AUDIT_LEAD_ROLES } from '../lib/wave-plan.js';

// v3 装配（2026-09-13 全量换新；决策包 §1 v3 映射）：角色 → 技能集
//   依据：① 角色作用（references/roles/*.md）；② superpowers 技能池；③ 本包 3 个自建手册
//   （review-execution / acceptance-gate / retro-and-memory——原「团队装配资产说明」手册已于
//   2026-09-17 随技能目录整体退役，内容并入 `skills/software-team/SKILL.md` §装配资产（team-asset）说明与用途）；
//   ④ 旧装配表本地手册族（dev-* 族 / efficient-edit / pr-review-team / report-blind-audit /
//      archive / doc-update）全部弃用 → 装配零引用。
const GUIDE_SKILLS = {
  coordinator: ['brainstorming', 'writing-plans'],
  designer: ['brainstorming', 'writing-plans', 'spec-writing'],
  coder: ['test-driven-development', 'codebase-design', 'receiving-code-review', 'requesting-code-review'],
  tester: ['verification-before-completion', 'systematic-debugging'],
  reviewer: ['review-execution'],
  supervisor: ['acceptance-gate', 'verification-before-completion'],
  'doc-manager': ['doc-generator', 'retro-and-memory'],
};
// **已安装但不装配**（与引擎纪律冲突或与引擎职责重复）——必须保持"不可入装配"，
//   否则会把冲突纪律带进 worker 上下文（例：using-git-worktrees 会诱导 worker 开 worktree）。
//   v3 变更：删 brainstorming / test-driven-development（v3 已装配，旧理由随「全量换新」失效）；
//            增 finishing-a-development-branch（合并/集成归引擎，worker 自行收尾分支即越权）。
const INSTALLED_BUT_NOT_WIRED = {
  'using-git-worktrees': '与「宿主 link: 消费 live 工作树 ⇒ 禁 worktree」冲突（会造成假绿灯）',
  'subagent-driven-development': '与纪律 0i D-1「C 类批执行一律经 wavePlan lane，禁用裸 subagent」冲突',
  'dispatching-parallel-agents': '与引擎 lane/DAG 调度重复（派发权在 Leader/Manager）',
  'executing-plans': '与引擎 wave/门禁编排重复',
  'finishing-a-development-branch': '合并/集成归引擎（lane_worktree_merge + Manager/Leader 裁决），worker 自行收尾分支即越权',
};
// 指引 §角色概览（逐字）：层 → 角色
const GUIDE_LAYERS = {
  plan: ['coordinator', 'designer'],
  exec: ['coder', 'tester', 'reviewer'],
  audit: ['supervisor', 'doc-manager'],
};

test('software-team 装配：资产加载通过 + 与指引装配表逐角色一致', () => {
  const r = loadTeamAsset(packageRoot(), 'software-team');
  assert.equal(r.ok, true, '装配资产必须通过加载期校验：' + JSON.stringify(r.problems));
  assert.equal(r.asset.team, 'software-team');
  // 角色 → 技能集（逐角色逐字）
  for (const [role, skills] of Object.entries(GUIDE_SKILLS)) {
    const found = Object.values(r.asset.layers).map((l) => l.skills?.[role]).find((s) => Array.isArray(s));
    assert.deepEqual(found, skills, `角色 ${role} 的技能集必须与指引一致`);
  }
  // 层 → 角色（逐层逐字）
  for (const [layer, roles] of Object.entries(GUIDE_LAYERS)) {
    assert.deepEqual(r.asset.layers[layer].roles, roles, `层 ${layer} 的角色集必须与指引一致`);
  }
  // 7 角色全集 = 指引所列
  const all = new Set(Object.values(r.asset.layers).flatMap((l) => l.roles));
  assert.equal(all.size, 7, '3 层共 7 角色（Manager 不属团队角色集）');
  // 引擎基础集已含全部 7 角色 → 无需声明扩展角色
  assert.deepEqual(r.asset.roles.extra, []);
});

test('software-team 装配：Manager 不入团队角色集（引擎层角色）', () => {
  const r = loadTeamAsset(packageRoot(), 'software-team');
  const all = Object.values(r.asset.layers).flatMap((l) => l.roles);
  assert.equal(all.includes('manager'), false, 'Manager 是引擎层角色，不占团队 lane');
  // 引擎侧一致：缺省装配同样不含 manager
  assert.equal(Object.values(DEFAULT_ASSEMBLY.layers).flatMap((l) => l.roles).includes('manager'), false);
});

test('software-team 装配：声明内**不含未接线项**（无假契约）', () => {
  const r = loadTeamAsset(packageRoot(), 'software-team');
  assert.equal(r.asset.flows?.exec?.progress_contract, undefined, 'progress_contract 未接线 → 声明不得出现');
  assert.equal(r.asset.rework, undefined, 'rework 未接线 → 声明不得出现');
  assert.equal(r.asset.flows?.audit?.contract, undefined, 'audit.contract 未接线 → 声明不得出现');
});

test('software-team：装配解析/角色集/flows 三个读端均派生自该资产', () => {
  clearRoleCache(); clearFlowCache();
  const asm = resolveAssembly('software-team', null, { root: packageRoot() });
  assert.deepEqual(asm, assemblyFromTeamAsset('software-team'), 'resolveAssembly 走包内资产');
  assert.deepEqual(asm.layers.exec.roles, ['coder', 'tester', 'reviewer']);
  const roles = resolveTeamRoles('software-team', { root: packageRoot() });
  assert.equal(roles.ok, true);
  assert.deepEqual([...roles.extra], [], '无扩展角色');
  assert.deepEqual([...roles.planLeads], [], '未改牵头集 → 走引擎基础集');
  assert.deepEqual([...roles.auditLeads], []);
  const flows = resolveTeamFlows('software-team', { root: packageRoot() });
  assert.equal(flows.ok, true);
  assert.deepEqual(flows.flows.exec.entry_requires, ['consume'], '缺口修复（consume 强制化）随团队资产生效');
  // 【legacy-retire-20260915 · 断言演进（E-4/A-1 换真源锚点）】原断言：
  //   `assert.deepEqual(flows.flows.complete.require_audit_outcomes, ['pass','skip'])` ——A-1 删资产
  //   `flows.complete` 段后 undefined ≠ ['pass','skip'] 必红。清退后合法演进：complete 白名单**唯一真源**
  //   = `audit_contract.verdict`（下行补 verdict 断言），废键段声明应为 undefined（正向清退断言）。
  assert.equal(flows.flows.complete, undefined, 'legacy complete 段已清退（verdict 唯一真源）');
  assert.deepEqual(flows.flows.audit.audit_contract.verdict, ['pass', 'fail', 'skip'], 'verdict 声明保留 = complete 白名单唯一真源');
  assert.deepEqual(flows.flows.plan.contract.required_sections, ['## 验收标准', '## 约束']);
});

// 【r2 同步 · A1】`plan/task-tree.json`（coordinator 的拆解产物）必须被至少一条 lane consume
//   ⇒ 由 exec lane 消费（「plan 产物指导下游执行」的正面表达）；旧 fixture 无人消费 ⇒ 建批期
//   会拒 `GATE_ORPHAN_PRODUCT`。
test('software-team 端到端建批（冒烟）：零角色告警 + 技能前缀按指引注入', () => {
  clearRoleCache(); clearFlowCache();
  const tasks = [
    { id: 'p1', layer: 'plan', role: 'coordinator', produce: ['plan/task-tree.json'] },
    { id: 'p2', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], deps: ['p1'] },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md', 'plan/task-tree.json'], outputs: ['exec/main.py'], deps: ['p2'] },
    { id: 'e2', layer: 'exec', role: 'tester', consume: ['plan/spec.md'], outputs: ['exec/test.log'], deps: ['e1'] },
    { id: 'e3', layer: 'exec', role: 'reviewer', consume: ['exec/main.py'], produce: ['exec/review.md'], deps: ['e1'] },
    { id: 'a1', layer: 'audit', role: 'supervisor', consume: ['plan/spec.md', 'exec/review.md'], produce: ['audit/acceptance.md'], deps: ['e3'] },
    { id: 'a2', layer: 'audit', role: 'doc-manager', consume: ['audit/acceptance.md'], produce: ['audit/retrospective.md'], deps: ['a1'] },
    { id: 'a3', layer: 'audit', role: 'reviewer', consume: ['exec/main.py'], produce: ['audit/vendor-review.md'], deps: ['e3'] },
  ];
  // 生产路径镜像：装配由调用方解析并传入（core.js:120-121 `resolveAssembly(args.team, config.assembly)` → buildWavePlan）
  const assembly = resolveAssembly('software-team', null, { root: packageRoot() });
  const plan = buildWavePlan({ batchId: 'b-software-team', tasks, team: 'software-team', assembly, teamsRoot: packageRoot() });
  const codes = plan.warnings.map((w) => w.code);
  assert.equal(codes.includes('GATE_ROLE_INVALID'), false, '零非法角色告警：' + JSON.stringify(plan.warnings));
  assert.equal(codes.includes('GATE_ROLE_MISSING'), false, 'plan/audit 牵头齐备：' + JSON.stringify(plan.warnings));
  const byId = new Map(plan.wavePlan.flatMap((w) => w.tasks).map((t) => [t.id, t]));
  // 技能前缀逐角色核对（= 指引装配表）
  for (const [id, role] of [['p1', 'coordinator'], ['p2', 'designer'], ['e1', 'coder'], ['e2', 'tester'], ['e3', 'reviewer'], ['a1', 'supervisor'], ['a2', 'doc-manager']]) {
    const t = byId.get(id);
    assert.ok(t.cmd.includes('[role=' + role + ']'), `${id} 注入角色前缀`);
    assert.ok(t.cmd.includes('[skills=' + GUIDE_SKILLS[role].join(',') + ']'), `${id}（${role}）技能前缀须等于指引：${t.cmd}`);
  }
  // 【G-2 · 断言演进（方向反转但等价）】原「兼容别名冒烟」断言：audit 层 role=reviewer lane 经
  //   `layers.audit.skills.reviewer` 别名注入 `[skills=review-execution]`（历史批次把 reviewer 放审计层的形态）。
  //   D-3 删该悬空键后别名不再存在 ⇒ 断言方向反转：**audit 层不再注入**该技能前缀，而 reviewer 的技能注入面
  //   **唯一保留在 exec 层**（上面 e3 已核）。实测（exec-swopt-docs/progress/probe-b1-d3-alias-sim.mjs）：
  //   删前 `[role=reviewer] [skills=review-execution] ` → 删后 `[role=reviewer] `（技能前缀消失、角色前缀保留）。
  const a3 = byId.get('a3');
  assert.ok(a3.cmd.includes('[role=reviewer]'), 'audit 层 reviewer 仍是合法角色（只是不再有技能位）：' + a3.cmd);
  assert.equal(a3.cmd.includes('[skills='), false, 'D-3 后 audit 层 reviewer lane 不再注入技能前缀（兼容别名已删）：' + a3.cmd);
  assert.ok(byId.get('e3').cmd.includes('[skills=review-execution]'), 'reviewer 技能注入面唯一保留在 exec 层：' + byId.get('e3').cmd);
  // 牵头集不变（引擎基础集）
  assert.deepEqual([...PLAN_LEAD_ROLES], ['designer', 'coordinator']);
  assert.deepEqual([...AUDIT_LEAD_ROLES], ['supervisor', 'doc-manager']);
  assert.equal(normalizeRole('manager', []), 'manager', 'manager 仍是合法角色（只是不占团队 lane）');
});

test('software-team 装配：引用的技能必须真实存在（退役技能零引用）', () => {
  const r = loadTeamAsset(packageRoot(), 'software-team');
  const refs = new Set();
  for (const l of Object.values(r.asset.layers)) {
    for (const list of Object.values(l.skills ?? {})) for (const s of list) refs.add(s);
  }
  // 退役技能黑名单（实证：宿主 ~/.agents/skills/_retired/code-review-guideline；v3 替换位改为自建 review-execution）
  assert.equal(refs.has('code-review-guideline'), false, '退役技能不得出现在装配里（否则 worker 静默少一份手册）');
  assert.ok(refs.has('review-execution'), '退役项的替换技能已在装配中');
  // 宿主技能根存在时逐一核存在性（无该根的环境——如 CI——跳过并保持其它断言有效）
  const home = process.env.USERPROFILE ?? process.env.HOME;
  const skillsRoot = home ? join(home, '.agents', 'skills') : null;
  if (skillsRoot && existsSync(skillsRoot)) {
    const missing = [...refs].filter((s) => !existsSync(join(skillsRoot, s, 'SKILL.md')));
    assert.deepEqual(missing, [], '装配引用的技能必须在宿主技能目录可解析：' + JSON.stringify(missing));
  }
});

test('software-team 装配：**冲突技能不得入装配**（已安装 ≠ 装配）', () => {
  const r = loadTeamAsset(packageRoot(), 'software-team');
  const refs = new Set();
  for (const l of Object.values(r.asset.layers)) {
    for (const list of Object.values(l.skills ?? {})) for (const s of list) refs.add(s);
  }
  for (const [skill, why] of Object.entries(INSTALLED_BUT_NOT_WIRED)) {
    assert.equal(refs.has(skill), false, `技能 ${skill} 不得入装配（${why}）`);
  }
});

test('software-team 资产自洽；punky-preset 团队装配退役且不污染软件工程装配', () => {
  clearRoleCache(); clearFlowCache();
  const st = loadTeamAsset(packageRoot(), 'software-team');
  assert.equal(st.ok, true);
  // 退役语义：punky-preset 团队装配已弃用（presets/punky-preset/team-asset.yml 已删）⇒ 拒载（NOT_FOUND），
  //   不再构成第二套团队资产（persona/纪律资产 agent.cordis.yml / preset.yml / references/ 不参与装配解析）
  const jf = loadTeamAsset(packageRoot(), 'punky-preset');
  assert.equal(jf.ok, false, 'punky-preset 团队装配已退役：无资产 ⇒ 拒载');
  assert.equal(jf.asset, null);
  assert.deepEqual(jf.problems.map((p) => p.code), [TEAM_ASSET_CODES.NOT_FOUND]);
  assert.equal(resolveAssembly('punky-preset'), null, '退役团队不产出装配（无内置常量兜底）');
  // 不互相污染：software-team 装配读端与声明逐字一致（退役不影响在役团队）
  // 【G-2 · 断言演进（显式差异对照）】原断言 `deepEqual(resolveAssembly('software-team'), DEFAULT_ASSEMBLY)`
  //   表达「资产 ≡ 缺省层（逐字）」；D-3 删 `layers.audit.skills.reviewer` 悬空键后，两者在该键上**允许分叉**
  //   ⇒ 改为**显式差异对照**：`资产层 ≡ 缺省层 − layers.audit.skills.reviewer`（方向反转但等价——
  //   等价关系由「两处都有该别名」变为「exec 层保留技能位 + audit 层不再注入」）。
  const stripAuditReviewerAlias = (asm) => {
    const layers = { ...asm.layers, audit: { ...asm.layers.audit, skills: { ...asm.layers.audit.skills } } };
    delete layers.audit.skills.reviewer;
    return { ...asm, layers };
  };
  const assetAsm = resolveAssembly('software-team');
  assert.deepEqual(assetAsm, stripAuditReviewerAlias(DEFAULT_ASSEMBLY), '资产层 ≡ 缺省层 − layers.audit.skills.reviewer（显式差异对照）');
  assert.equal(assetAsm.layers.audit.skills.reviewer, undefined, 'D-3：资产侧 audit 层不再有 reviewer 悬空键（写了不生效的键已删）');
  assert.deepEqual(assetAsm.layers.exec.skills.reviewer, ['review-execution'], '方向反转：reviewer 技能位唯一保留在 exec 层');
  assert.deepEqual(Object.keys(st.asset.layers), ['plan', 'exec', 'audit']);
  assert.deepEqual(st.asset.layers.audit.roles, ['supervisor', 'doc-manager'], '审计层角色 = supervisor/doc-manager（reviewer 属 exec 层，不在 audit 层 roles，亦不再有别名技能位）');
  assert.equal(TEAM_ASSET_CODES.LEAD_NOT_IN_LAYERS.length > 0, true);
});
