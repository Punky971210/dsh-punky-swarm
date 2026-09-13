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

// team-assets-fill 批次验收用例（独立验证，e-verify lane 产出）：
//   A1 两资产通过加载期校验（ok:true / problems:[]）+ §5.5 JSON.parse 独立对照；
//   A2 端到端建批冒烟：两团队各建一批（plan/exec/audit 三层），零 GATE_ROLE_INVALID / 零 GATE_ROLE_MISSING，
//      lane cmd 的 role/skills 前缀逐字 = 团队资产声明（加载名）
//      —— 期望值取 team-asset.yml 的**原始 JSON 文本独立解析**（非 lane 自述、非 SKILL.md 反推）；
//   A3 自定义牵头生效（静态 + 运行 + 悬空牵头反例 TEAM_ASSET_LEAD_NOT_IN_LAYERS）；
//   A4 生产口径可强制：producer lane 声明 consume=audit 两产物 → 缺产物 GATE_ENTRY_MISSING 且成员态不进入 running；
//      补齐后同 lane 可派（正例）；并断言「entry_requires:['consume'] 已翻牌」以防 legacy 口径下的假绿；
//   兼容：team='jiufeng'（团队装配已退役）→ 无 [skills=…] 前缀 + GATE_TEAM_ASSET_MISSING（防回归）。
//
// 口径归属（硬约束，见批次产物根 plan/team-assets-spec.md）：
//   期望值只取自「资产文件原文解析」；SKILL.md 文本不参与 A2 期望值（防真源被文档劫持）。
//   四条「目录名 ≠ 加载名」（research-compiler→ara-compiler / research-manager→ara-research-manager /
//   rigor-reviewer→ara-rigor-reviewer；Comfyui-use→comfyui-use）按**加载名**断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { clearRoleCache, clearFlowCache, packageRoot } from '../lib/assembly/flows.js';
import { loadTeamAsset, parseTeamAsset, validateTeamAsset, TEAM_ASSET_CODES } from '../lib/assembly/team-asset.js';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESS = { agent: { session: { id: 'sess-taf' } } };
const SESSION_ID = SESS.agent.session.id;

// 期望值来源：直接读 `presets/<team>/team-asset.yml` **原文**并按 JSON 子集独立解析
// （不经 loadTeamAsset、不经 lane 自述、不经 SKILL.md）——A1 的 JSON 子集判据与 A2/A3 期望值单一来源。
function rawAsset(team) {
  const p = path.join(REPO_ROOT, 'presets', team, 'team-asset.yml');
  const text = fs.readFileSync(p, 'utf8');
  const parsed = parseTeamAsset(text, { path: p });
  assert.equal(parsed.ok, true, team + ' 资产必须是 JSON 子集（无注释/尾逗号）：' + JSON.stringify(parsed.problems));
  return parsed.asset;
}

function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taf-'));
  const store = createStore(root);
  const ctx = { tools: { register: () => {} }, logger: console };
  const { tools } = createTools(ctx, { store, root });
  return { root, store, byName: Object.fromEntries(tools.map((t) => [t.name, t])) };
}

// 落盘批次产物（相对当前批次产物根；与门禁 resolveArtifact 同根）
function writeArtifact(root, batchId, rel, content = 'x\n') {
  const abs = path.join(root, 'sessions', SESSION_ID, 'artifacts', batchId, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

const batchFileOf = (root, batchId) => path.join(root, 'sessions', SESSION_ID, 'batches', batchId + '.json');
const readBatch = (root, batchId) => JSON.parse(fs.readFileSync(batchFileOf(root, batchId), 'utf8'));
const cmdsOf = (out) => out.wavePlan.flatMap((w) => w.tasks).map((t) => t.id + ' | ' + t.cmd);
const codesOf = (out) => (out.warnings ?? []).map((w) => w.code);
const eventTypes = (root, batchId) => readBatch(root, batchId).events.map((e) => e.type);

// ── 两团队任务夹具（角色取自各自资产；skills **不显式声明** ⇒ 由团队装配注入，A2 判据面即「注入前缀」）──

function designTasks() {
  return [
    { id: 'p1', layer: 'plan', role: 'design-planner', produce: ['plan/design-spec.md'], cmd: 'plan-design' },
    { id: 'e1', layer: 'exec', role: 'workflow-builder', consume: ['plan/design-spec.md'], outputs: ['exec/workflow.json'], deps: ['p1'], cmd: 'build-workflow' },
    { id: 'a1', layer: 'audit', role: 'workflow-auditor', consume: ['exec/workflow.json'], produce: ['audit/workflow-review.md'], deps: ['e1'], cmd: 'audit-workflow' },
  ];
}

function researchTasks() {
  return [
    { id: 'p1', layer: 'plan', role: 'research-planner', produce: ['plan/research-spec.md'], cmd: 'plan-research' },
    { id: 'e1', layer: 'exec', role: 'researcher', consume: ['plan/research-spec.md'], outputs: ['exec/research-report.md'], deps: ['p1'], cmd: 'do-research' },
    { id: 'a1', layer: 'audit', role: 'research-auditor', consume: ['exec/research-report.md'], produce: ['audit/source-verification.md'], deps: ['e1'], cmd: 'verify-sources' },
  ];
}

// ── A1：两资产通过加载期校验（loadTeamAsset 实调 + 分步校验 + JSON 子集）──

test('A1 两资产通过加载期校验：loadTeamAsset ok:true 且 problems:[]（零 TEAM_ASSET_* 码）', () => {
  for (const team of ['design-team', 'research-team']) {
    const r = loadTeamAsset(packageRoot(), team);
    assert.equal(r.ok, true, team + ' 必须 ok:true：' + JSON.stringify(r.problems));
    assert.deepEqual(r.problems, [], team + ' 必须 problems:[]（零 TEAM_ASSET_* 码）');
    assert.equal(r.asset.team, team);
    assert.match(r.path, new RegExp('presets[\\\\/]' + team + '[\\\\/]team-asset\\.yml$'));
    // 分步判据：parse（JSON 子集）+ validate（零问题码）——与 spec A1 补充判据同源
    const text = fs.readFileSync(path.join(REPO_ROOT, 'presets', team, 'team-asset.yml'), 'utf8');
    assert.equal(text.charCodeAt(0) === 0xfeff, false, team + ' 资产落盘须 UTF-8 无 BOM');
    const parsed = parseTeamAsset(text, { path: r.path });
    assert.equal(parsed.ok, true, team + ' 资产须可按 JSON 子集解析：' + JSON.stringify(parsed.problems));
    const validated = validateTeamAsset(parsed.asset);
    assert.equal(validated.ok, true, team + ' 校验须零问题：' + JSON.stringify(validated.problems));
    assert.deepEqual(validated.problems.map((p) => p.code).filter((c) => c.startsWith('TEAM_ASSET_')), [],
      team + ' 不得产生任何 TEAM_ASSET_* 码');
  }
});

// ── A2：端到端建批冒烟（零 GATE_ROLE_INVALID / 零 GATE_ROLE_MISSING + 前缀逐字）──

test('A2 design-team 建批：零 GATE_ROLE_INVALID / 零 GATE_ROLE_MISSING，cmd 前缀逐字 = 资产声明（加载名）', async () => {
  const { root, byName } = makeHarness();
  try {
    clearRoleCache();
    clearFlowCache();
    const asset = rawAsset('design-team'); // 期望值 = 资产原文独立解析（非 lane 自述）
    const out = await byName.wave_plan.execute({ batchId: 'taf-a2-design', tasks: designTasks(), team: 'design-team' }, SESS);
    assert.equal(out.batchId, 'taf-a2-design');
    // ① 零角色告警（含 assembly.roles 词法告警通道）
    assert.equal(codesOf(out).includes('GATE_ROLE_INVALID'), false, '不得出现 GATE_ROLE_INVALID：' + JSON.stringify(out.warnings));
    assert.equal(codesOf(out).includes('GATE_ROLE_MISSING'), false, '不得出现 GATE_ROLE_MISSING：' + JSON.stringify(out.warnings));
    // ② 事件流面同为 0（告警留痕归因通道；事件与返回值的双面判据）
    const evs = eventTypes(root, 'taf-a2-design');
    const roleEvt = readBatch(root, 'taf-a2-design').events.filter((e) => (e.code ?? '').startsWith('GATE_ROLE_'));
    assert.deepEqual(roleEvt, [], '事件流不得留痕任何 GATE_ROLE_*：' + JSON.stringify(roleEvt));
    assert.equal(evs.includes('gate.role.missing'), false);
    // ③ 前缀逐字 = 资产声明的 role + skills（含 comfyui-use 加载名，非宿主目录名 Comfyui-use）
    assert.deepEqual(cmdsOf(out), [
      'p1 | [role=design-planner] [skills=' + asset.layers.plan.skills['design-planner'].join(',') + '] plan-design',
      'e1 | [role=workflow-builder] [skills=' + asset.layers.exec.skills['workflow-builder'].join(',') + '] build-workflow',
      'a1 | [role=workflow-auditor] [skills=' + asset.layers.audit.skills['workflow-auditor'].join(',') + '] audit-workflow',
    ]);
    // ④ 硬编码期望值锚（防「期望值随资产一起漂移」的自证循环）：spec §2.1 裁决后口径逐字
    assert.deepEqual(asset.layers.plan.skills['design-planner'], ['spec-writing', 'interaction-design-principles', 'comfyui-use']);
    assert.deepEqual(asset.layers.exec.skills['workflow-builder'], ['comfyui-use']);
    assert.deepEqual(asset.layers.exec.skills['producer'], ['comfyui-use']);
    assert.deepEqual(asset.layers.audit.skills['workflow-auditor'], ['acceptance-gate', 'review-execution', 'comfyui-use']);
    assert.equal(cmdsOf(out).some((c) => /Comfyui-use/.test(c)), false, '宿主目录名不得出现在注入前缀（加载名口径）');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    clearRoleCache();
  }
});

test('A2 research-team 建批：零 GATE_ROLE_INVALID / 零 GATE_ROLE_MISSING，cmd 前缀逐字 = 资产声明（加载名）', async () => {
  const { root, byName } = makeHarness();
  try {
    clearRoleCache();
    clearFlowCache();
    const asset = rawAsset('research-team');
    const out = await byName.wave_plan.execute({ batchId: 'taf-a2-research', tasks: researchTasks(), team: 'research-team' }, SESS);
    assert.equal(out.batchId, 'taf-a2-research');
    assert.equal(codesOf(out).includes('GATE_ROLE_INVALID'), false, '不得出现 GATE_ROLE_INVALID：' + JSON.stringify(out.warnings));
    assert.equal(codesOf(out).includes('GATE_ROLE_MISSING'), false, '不得出现 GATE_ROLE_MISSING：' + JSON.stringify(out.warnings));
    const roleEvt = readBatch(root, 'taf-a2-research').events.filter((e) => (e.code ?? '').startsWith('GATE_ROLE_'));
    assert.deepEqual(roleEvt, [], '事件流不得留痕任何 GATE_ROLE_*：' + JSON.stringify(roleEvt));
    assert.deepEqual(cmdsOf(out), [
      'p1 | [role=research-planner] [skills=' + asset.layers.plan.skills['research-planner'].join(',') + '] plan-research',
      'e1 | [role=researcher] [skills=' + asset.layers.exec.skills.researcher.join(',') + '] do-research',
      'a1 | [role=research-auditor] [skills=' + asset.layers.audit.skills['research-auditor'].join(',') + '] verify-sources',
    ]);
    // 硬编码期望值锚：四条「目录名≠加载名」按加载名书写（research-compiler→ara-compiler 等）
    assert.deepEqual(asset.layers.plan.skills['research-planner'], ['spec-writing', 'decision-mapping', 'tech-benchmark-planning', 'ara-compiler']);
    assert.deepEqual(asset.layers.exec.skills.researcher, ['ara-compiler', 'ara-research-manager', 'citation-evaluator', 'arxiv-translator']);
    assert.deepEqual(asset.layers.audit.skills['research-auditor'], ['acceptance-gate', 'ara-rigor-reviewer', 'citation-evaluator']);
    const joined = cmdsOf(out).join(' ');
    for (const legacyDirName of ['research-compiler', 'research-manager', 'rigor-reviewer']) {
      // 全等 token 判定（非子串）：`ara-research-manager` 含子串 `research-manager`，子串判定会误红
      assert.equal(joined.split(/[\[\]=,\s]+/).includes(legacyDirName), false, '不得回写宿主目录名 ' + legacyDirName + '（须为加载名）');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    clearRoleCache();
  }
});

test('A2 交叉验证：注入前缀 ≠ 内联 skills 时以装配为准（同一批内显式声明 skills 优先，证明前缀来源为资产读端）', async () => {
  const { root, byName } = makeHarness();
  try {
    clearRoleCache();
    const tasks = designTasks();
    tasks[1] = { ...tasks[1], skills: ['SENTINEL-SKILL'] }; // 显式声明 ≠ 资产声明
    const out = await byName.wave_plan.execute({ batchId: 'taf-a2-cross', tasks, team: 'design-team' }, SESS);
    assert.equal(out.wavePlan.flatMap((w) => w.tasks).find((t) => t.id === 'e1').cmd, '[role=workflow-builder] [skills=SENTINEL-SKILL] build-workflow',
      '显式 skills 优先（既有语义）⇒ 未显式声明的 p1/a1 前缀确来自资产读端');
    assert.match(out.wavePlan.flatMap((w) => w.tasks).find((t) => t.id === 'p1').cmd, /\[skills=spec-writing,interaction-design-principles,comfyui-use\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    clearRoleCache();
  }
});

// ── A3：自定义牵头生效（静态 + 运行 + 悬空反例）──

test('A3 自定义牵头静态判据：plan_leads / audit_leads 与 layers 角色集一致（两团队）', () => {
  for (const [team, planLead, auditLead] of [['design-team', 'design-planner', 'workflow-auditor'], ['research-team', 'research-planner', 'research-auditor']]) {
    const a = rawAsset(team);
    assert.deepEqual(a.roles.plan_leads, [planLead], team + ' plan_leads');
    assert.deepEqual(a.roles.audit_leads, [auditLead], team + ' audit_leads');
    assert.ok(a.layers.plan.roles.includes(planLead), planLead + ' 必须 ∈ layers.plan.roles');
    assert.ok(a.layers.audit.roles.includes(auditLead), auditLead + ' 必须 ∈ layers.audit.roles');
    // 自定义角色声明义务：全部角色 ∈ roles.extra（不在引擎基础集内）
    const layerRoles = Object.values(a.layers).flatMap((l) => l.roles);
    assert.deepEqual([...a.roles.extra].sort(), [...layerRoles].sort(), team + ' roles.extra 必须等于各层角色并集');
  }
});

test('A3 牵头运行面：plan 牵头 lane + audit 牵头 lane 建批（含 C+ 装配声明）→ 无 GATE_ROLE_MISSING / 无 GATE_ROLE_MANAGER_AS_LANE', async () => {
  const { root, byName } = makeHarness();
  try {
    clearRoleCache();
    // design-team 的 C+ 形态（exec lane 3 条：workflow-builder + producer + 额外 builder）——验证牵头角色在 C+ 门禁下也被认可
    const tasks = [
      { id: 'p1', layer: 'plan', role: 'design-planner', produce: ['plan/design-spec.md'], cmd: 'plan' },
      { id: 'e1', layer: 'exec', role: 'workflow-builder', consume: ['plan/design-spec.md'], outputs: ['exec/workflow.json'], deps: ['p1'], cmd: 'b1' },
      { id: 'e2', layer: 'exec', role: 'workflow-builder', consume: ['plan/design-spec.md'], outputs: ['exec/workflow2.json'], deps: ['p1'], cmd: 'b2' },
      { id: 'e3', layer: 'exec', role: 'producer', consume: ['plan/design-spec.md'], outputs: ['exec/production/p.json'], deps: ['p1'], cmd: 'p' },
      { id: 'a1', layer: 'audit', role: 'workflow-auditor', consume: ['exec/workflow.json'], produce: ['audit/workflow-review.md'], deps: ['e1'], cmd: 'audit' },
    ];
    const out = await byName.wave_plan.execute({
      batchId: 'taf-a3', tasks, team: 'design-team',
      assembly: { managerPlan: 'leader-direct', auditLane: 'a1', coordinatorLane: 'p1' },
    }, SESS);
    const codes = codesOf(out);
    assert.equal(codes.includes('GATE_ROLE_MISSING'), false, 'C+ 形态下牵头角色须被认可：' + JSON.stringify(out.warnings));
    assert.equal(codes.includes('GATE_ROLE_MANAGER_AS_LANE'), false, '不得把 manager 当 lane 角色：' + JSON.stringify(out.warnings));
    assert.equal(codes.includes('GATE_ROLE_INVALID'), false);
    // 事件流硬判据：GATE_ROLE_MISSING / GATE_ROLE_MANAGER_AS_LANE 零留痕
    const roleEvt = readBatch(root, 'taf-a3').events.filter((e) => (e.code ?? '').startsWith('GATE_ROLE_'));
    assert.deepEqual(roleEvt.map((e) => e.code), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    clearRoleCache();
  }
});

test('A3 反例：牵头角色悬空（不在该层/任一层）→ TEAM_ASSET_LEAD_NOT_IN_LAYERS（证明校验真在跑）', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taf-lead-'));
  try {
    // 以真实资产为底，把 plan_leads 指向一个从未进层的角色（悬空声明）
    const broken = rawAsset('design-team');
    broken.roles = { ...broken.roles, plan_leads: ['dangling-planner'] };
    fs.mkdirSync(path.join(tmpRoot, 'presets', 'design-team'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'presets', 'design-team', 'team-asset.yml'), JSON.stringify(broken), 'utf8');
    const r = loadTeamAsset(tmpRoot, 'design-team');
    assert.equal(r.ok, false, '悬空牵头必须被拒载');
    assert.ok(r.problems.some((p) => p.code === TEAM_ASSET_CODES.LEAD_NOT_IN_LAYERS),
      '须报 TEAM_ASSET_LEAD_NOT_IN_LAYERS：' + JSON.stringify(r.problems));
    assert.equal(TEAM_ASSET_CODES.LEAD_NOT_IN_LAYERS, 'TEAM_ASSET_LEAD_NOT_IN_LAYERS');
    // 对照：真实资产无该码（证明上面的红不是环境噪音）
    const good = loadTeamAsset(packageRoot(), 'design-team');
    assert.equal(good.problems.some((p) => p.code === TEAM_ASSET_CODES.LEAD_NOT_IN_LAYERS), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── A4：生产口径可强制（同批产物根正/负例成对）──

test('A4 生产门禁成对断言：producer lane 缺 audit 两产物 → GATE_ENTRY_MISSING 且不进入 running；补齐后可派', async () => {
  const { root, byName } = makeHarness();
  try {
    clearRoleCache();
    clearFlowCache();
    // entry_requires 翻牌前提（否则 legacy 口径下「无 consume 才校验」会产生假绿）
    assert.deepEqual(rawAsset('design-team').flows.exec.entry_requires, ['consume']);
    const tasks = [
      { id: 'p1', layer: 'plan', role: 'design-planner', produce: ['plan/design-spec.md'], cmd: 'plan' },
      { id: 'e1', layer: 'exec', role: 'workflow-builder', consume: ['plan/design-spec.md'], outputs: ['exec/workflow.json'], deps: ['p1'], cmd: 'build' },
      { id: 'a1', layer: 'audit', role: 'workflow-auditor', consume: ['exec/workflow.json'], produce: ['audit/workflow-review.md'], deps: ['e1'], cmd: 'audit' },
      // producer：**新批次**语义下的同一 lane（本批内验证 consume 强制面；跨批语义只记 followup）
      { id: 'prod1', layer: 'exec', role: 'producer', consume: ['audit/workflow-review.md', 'audit/gap-list.json'], outputs: ['exec/production/out.png'], deps: ['a1'], cmd: 'produce' },
    ];
    const out = await byName.wave_plan.execute({ batchId: 'taf-a4', tasks, team: 'design-team' }, SESS);
    assert.equal(codesOf(out).includes('GATE_ROLE_INVALID'), false, 'producer 角色须合法（∈ roles.extra）：' + JSON.stringify(out.warnings));
    // ① 负例：audit 两产物不在产物根 → 拒派
    await assert.rejects(
      () => byName.member_status.execute({ batchId: 'taf-a4', lane: 'prod1', status: 'running' }, SESS),
      /GATE_ENTRY_MISSING: audit\/workflow-review\.md, audit\/gap-list\.json/,
      '缺 consume 产物必须拒派（「审核通过才开产」是门禁行为）',
    );
    // ② 成员态不进入 running（唯一事实源 = 批次状态文件）
    assert.equal(readBatch(root, 'taf-a4').lanes.prod1, 'pending', '拒派后成员态不得进入 running');
    assert.ok(eventTypes(root, 'taf-a4').includes('gate.entry.missing'), 'gate.entry.missing 事件留痕');
    // ③ 正例：补齐 audit 两产物（同批产物根）→ 同 lane 可派
    writeArtifact(root, 'taf-a4', 'audit/workflow-review.md', '# review\n');
    writeArtifact(root, 'taf-a4', 'audit/gap-list.json', '{}\n');
    await byName.member_status.execute({ batchId: 'taf-a4', lane: 'prod1', status: 'running' }, SESS);
    assert.equal(readBatch(root, 'taf-a4').lanes.prod1, 'running', '补齐 consume 产物后同 lane 可派（拒绝来自缺产物，非角色/技能非法）');
    // ④ 对照负例：只补一个产物仍拒（证明判据是「逐条存在性」而非「任一存在」）
    const out2 = await byName.wave_plan.execute({ batchId: 'taf-a4b', tasks, team: 'design-team' }, SESS);
    assert.equal(codesOf(out2).includes('GATE_ROLE_INVALID'), false);
    writeArtifact(root, 'taf-a4b', 'audit/workflow-review.md', '# review\n'); // 仅缺 gap-list.json
    await assert.rejects(
      () => byName.member_status.execute({ batchId: 'taf-a4b', lane: 'prod1', status: 'running' }, SESS),
      /GATE_ENTRY_MISSING: audit\/gap-list\.json/,
    );
    assert.equal(readBatch(root, 'taf-a4b').lanes.prod1, 'pending');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    clearRoleCache();
  }
});

// ── 兼容锚：jiufeng 团队装配已退役（防回归）──

test('兼容：team=jiufeng（装配已退役）→ 无 [skills=…] 前缀 + GATE_TEAM_ASSET_MISSING 告警（不阻断建批）', async () => {
  const { root, byName } = makeHarness();
  try {
    clearRoleCache();
    // 单 task ⇒ 非 C 类形态，避免 GATE_ROLE_MISSING 噪音混淆判据
    const out = await byName.wave_plan.execute({ batchId: 'taf-jf', team: 'jiufeng', tasks: [{ id: 'p1', layer: 'plan', role: 'designer', cmd: 'plan-it' }] }, SESS);
    assert.deepEqual(cmdsOf(out), ['p1 | [role=designer] plan-it'], '退役后不得注入任何技能前缀');
    assert.equal(codesOf(out).includes('GATE_TEAM_ASSET_MISSING'), true, '须留痕 GATE_TEAM_ASSET_MISSING：' + JSON.stringify(out.warnings));
    assert.equal(fs.existsSync(path.join(REPO_ROOT, 'presets', 'jiufeng', 'team-asset.yml')), false, 'jiufeng 资产文件须为删除态（退役语义）');
    assert.equal(fs.existsSync(batchFileOf(root, 'taf-jf')), true, '告警不阻断建批');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    clearRoleCache();
  }
});
