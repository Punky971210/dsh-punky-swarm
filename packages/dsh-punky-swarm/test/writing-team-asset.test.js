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

// writing-team 装配契约用例（① 加载期校验；② 端到端建批零角色告警 + 技能前缀逐字；
//   ③ 自定义牵头生效；④ publisher lane 的「审核通过才交付」生产门禁成对断言）。
//
// 口径归属（硬约束，与 team-assets-fill.test.js 同源）：
//   期望值只取自「资产文件原文解析」（rawAsset：独立 parse + validate，不经 loadTeamAsset 的缓存、
//   不经 lane 自述、不经 SKILL.md）——防真源被文档劫持、防「期望值随资产一起漂移」的自证循环；
//   技能声明值 = **加载名**（宿主 SKILL.md frontmatter 的 name），非宿主目录名。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { clearRoleCache, clearFlowCache, resolveTeamRoles, packageRoot } from '../lib/assembly/flows.js';
import { loadTeamAsset, parseTeamAsset, validateTeamAsset, TEAM_ASSET_CODES } from '../lib/assembly/team-asset.js';
import { assessC } from './helpers/gate-fixture.mjs';
import { seedTeamAssetSkills } from './helpers/host-skills.mjs';

// 【P1 同步 · 宿主技能根】writing-team 资产的声明技能必须**可解析**（P1 §3：不可解析 ⇒ 拒载拒建批；
//   技能根不存在 ⇒ 同码拒）⇒ 隔离 HOME（preload 重定向）下先显式注入该团队的技能根。
seedTeamAssetSkills('writing-team');

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESS = { agent: { session: { id: 'sess-wta' } } };
const SESSION_ID = SESS.agent.session.id;

// 期望值来源：直接读 `presets/writing-team/team-asset.yml` **原文**并按 JSON 子集独立解析。
function rawAsset(team) {
  const p = path.join(REPO_ROOT, 'presets', team, 'team-asset.yml');
  const text = fs.readFileSync(p, 'utf8');
  const parsed = parseTeamAsset(text, { path: p });
  assert.equal(parsed.ok, true, team + ' 资产必须是 JSON 子集（无注释/尾逗号）：' + JSON.stringify(parsed.problems));
  return parsed.asset;
}

function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wta-'));
  const store = createStore(root);
  const ctx = { tools: { register: () => {} }, logger: console };
  const { tools } = createTools(ctx, { store, root });
  // G1 前置（新门禁）：`wave_plan` / `member_status` 属 C 档动作 ⇒ 先把本会话评估为 C（同 assign_check 落盘函数）
  assessC(store, SESSION_ID, { rationale: 'fixture：writing-team 套件建批前置评估（plan/exec/audit 多线 ⇒ C 档）' });
  return { root, store, byName: Object.fromEntries(tools.map((t) => [t.name, t])) };
}

// 落盘批次产物（相对当前批次产物根；与门禁 resolveArtifact 同根）
function writeArtifact(root, batchId, rel, content = 'x\n') {
  const abs = path.join(root, 'sessions', SESSION_ID, 'artifacts', batchId, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

const readBatch = (root, batchId) =>
  JSON.parse(fs.readFileSync(path.join(root, 'sessions', SESSION_ID, 'batches', batchId + '.json'), 'utf8'));
const cmdsOf = (out) => out.wavePlan.flatMap((w) => w.tasks).map((t) => t.id + ' | ' + t.cmd);
const codesOf = (out) => (out.warnings ?? []).map((w) => w.code);
// writing-team 的 exec 层有 3 条 lane（drafter/polisher/publisher）⇒ C+ 档，建批必须携带批次级装配声明
const ASSEMBLY = { managerPlan: 'leader-direct', auditLane: 'a1', coordinatorLane: 'p1' };

// ── 写作链路任务夹具（角色取自资产；skills **不显式声明** ⇒ 由团队装配注入，判据面即「注入前缀」）──
//   plan → drafter → polisher → audit → publisher（新批角色，同一批内验证 consume 强制面）
//   【2026-09-18 同步 · exec 双消费】执行侧每条 lane 一律 **`plan/` ＋ 上游产物** 双消费（与 audit 消费
//   `plan/` ＋ `exec/` 同构；由资产 `flows.exec.consumes_required_per_lane: ["plan/"]` 在建批期强制）⇒
//   `e2`/`prod1` 的 consume 各补上 plan 规格件（此前只消费上游件 = 无 plan 依据的 exec lane，新门禁下禁）。
function writingTasks() {
  return [
    { id: 'p1', layer: 'plan', role: 'writing-planner', produce: ['plan/writing-spec.md'], cmd: 'plan-writing' },
    { id: 'e1', layer: 'exec', role: 'drafter', consume: ['plan/writing-spec.md'], outputs: ['exec/draft.md'], deps: ['p1'], cmd: 'draft' },
    { id: 'e2', layer: 'exec', role: 'polisher', consume: ['plan/writing-spec.md', 'exec/draft.md'], outputs: ['exec/polish-report.md'], deps: ['e1'], cmd: 'polish' },
    { id: 'a1', layer: 'audit', role: 'writing-auditor', consume: ['plan/writing-spec.md', 'exec/polish-report.md'], produce: ['audit/editorial-review.md'], deps: ['e2'], cmd: 'audit-writing' },
    { id: 'prod1', layer: 'exec', role: 'publisher', consume: ['plan/writing-spec.md', 'audit/editorial-review.md', 'audit/gap-list.json'], outputs: ['exec/publish/wechat.html'], deps: ['a1'], cmd: 'publish' },
  ];
}

// ── ① 资产加载期校验（loadTeamAsset ok:true 且 problems:[]）──

test('writing-team A1 资产通过加载期校验：loadTeamAsset ok:true 且 problems:[]（零 TEAM_ASSET_* 码）', () => {
  const r = loadTeamAsset(packageRoot(), 'writing-team');
  assert.equal(r.ok, true, '必须 ok:true：' + JSON.stringify(r.problems));
  assert.deepEqual(r.problems, [], '必须 problems:[]（零 TEAM_ASSET_* 码）');
  assert.equal(r.asset.team, 'writing-team');
  assert.match(r.path, /presets[\\/]writing-team[\\/]team-asset\.yml$/);
  // 分步判据：parse（JSON 子集）+ validate（零问题码）
  const text = fs.readFileSync(path.join(REPO_ROOT, 'presets', 'writing-team', 'team-asset.yml'), 'utf8');
  assert.equal(text.charCodeAt(0) === 0xfeff, false, '资产落盘须 UTF-8 无 BOM');
  const parsed = parseTeamAsset(text, { path: r.path });
  assert.equal(parsed.ok, true, '资产须可按 JSON 子集解析：' + JSON.stringify(parsed.problems));
  const validated = validateTeamAsset(parsed.asset);
  assert.equal(validated.ok, true, '校验须零问题：' + JSON.stringify(validated.problems));
  assert.deepEqual(validated.problems.map((p) => p.code).filter((c) => c.startsWith('TEAM_ASSET_')), [], '不得产生任何 TEAM_ASSET_* 码');
  // 扩展角色集 / 牵头角色集读端同源（三个读端均派生自该资产）
  clearRoleCache(); clearFlowCache();
  const roles = resolveTeamRoles('writing-team', { root: packageRoot() });
  assert.equal(roles.ok, true, '角色读端须命中该资产：' + JSON.stringify(roles.problems));
  assert.deepEqual([...roles.extra], ['writing-planner', 'drafter', 'polisher', 'publisher', 'writing-auditor']);
  assert.deepEqual([...roles.planLeads], ['writing-planner']);
  assert.deepEqual([...roles.auditLeads], ['writing-auditor']);
  assert.equal(TEAM_ASSET_CODES.LEAD_NOT_IN_LAYERS.length > 0, true);
});

// ── ② 端到端建批冒烟（零 GATE_ROLE_INVALID / 零 GATE_ROLE_MISSING + 前缀逐字）──

test('writing-team A2 建批：零 GATE_ROLE_INVALID / 零 GATE_ROLE_MISSING / 零 GATE_ROLE_MANAGER_AS_LANE，cmd 前缀逐字 = 资产声明（加载名）', async () => {
  const { root, byName } = makeHarness();
  try {
    clearRoleCache();
    clearFlowCache();
    const asset = rawAsset('writing-team'); // 期望值 = 资产原文独立解析（非 lane 自述）
    const out = await byName.wave_plan.execute({ batchId: 'wta-a2', tasks: writingTasks(), team: 'writing-team', assembly: ASSEMBLY }, SESS);
    assert.equal(out.batchId, 'wta-a2');
    assert.deepEqual(out.assembly, { managerPlan: 'leader-direct', auditLane: 'a1', coordinatorLane: 'p1' }, 'C+ 批次级装配声明随批持久化');
    // ① 应用层零角色告警（三个码面逐一断言）
    const codes = codesOf(out);
    for (const code of ['GATE_ROLE_INVALID', 'GATE_ROLE_MISSING', 'GATE_ROLE_MANAGER_AS_LANE']) {
      assert.equal(codes.includes(code), false, '不得出现 ' + code + '：' + JSON.stringify(out.warnings));
    }
    assert.equal(codes.includes('GATE_TEAM_ASSET_MISSING'), false, '团队资产须被解析到（装配前缀来源）：' + JSON.stringify(out.warnings));
    // ② 事件流面同为 0（告警留痕归因通道；事件与返回值的双面判据）
    const roleEvt = readBatch(root, 'wta-a2').events.filter((e) => (e.code ?? '').startsWith('GATE_ROLE_'));
    assert.deepEqual(roleEvt, [], '事件流不得留痕任何 GATE_ROLE_*：' + JSON.stringify(roleEvt));
    // ③ 前缀逐字 = 资产声明的 role + skills（加载名口径）
    assert.deepEqual(cmdsOf(out), [
      'p1 | [role=writing-planner] [skills=' + asset.layers.plan.skills['writing-planner'].join(',') + '] plan-writing',
      'e1 | [role=drafter] [skills=' + asset.layers.exec.skills.drafter.join(',') + '] draft',
      'e2 | [role=polisher] [skills=' + asset.layers.exec.skills.polisher.join(',') + '] polish',
      'a1 | [role=writing-auditor] [skills=' + asset.layers.audit.skills['writing-auditor'].join(',') + '] audit-writing',
      'prod1 | [role=publisher] [skills=' + asset.layers.exec.skills.publisher.join(',') + '] publish',
    ]);
    // ④ 硬编码期望值锚（防「期望值随资产一起漂移」的自证循环）
    assert.deepEqual(asset.layers.plan.skills['writing-planner'], ['spec-writing', 'writing-trio', 'wechat-writing-style']);
    assert.deepEqual(asset.layers.exec.skills.drafter, ['writing-trio', 'wechat-writing-style']);
    assert.deepEqual(asset.layers.exec.skills.polisher, ['humanizer', 'lieflat-less-ai-tone', 'revision-patterns', 'writing-trio']);
    assert.deepEqual(asset.layers.exec.skills.publisher, ['baoyu-markdown-to-html']);
    assert.deepEqual(asset.layers.audit.skills['writing-auditor'], ['acceptance-gate', 'review-execution', 'humanizer']);
    // ⑤ 五角色全部为团队自定义角色（不占引擎基础集），且层归属逐字
    assert.deepEqual(asset.roles.extra, ['writing-planner', 'drafter', 'polisher', 'publisher', 'writing-auditor']);
    assert.deepEqual(asset.layers.plan.roles, ['writing-planner']);
    assert.deepEqual(asset.layers.exec.roles, ['drafter', 'polisher', 'publisher']);
    assert.deepEqual(asset.layers.audit.roles, ['writing-auditor']);
    // ⑥ flows 口径与 software-team 同形（逐字段）
    assert.deepEqual(asset.flows.plan.entry_requires, []);
    assert.deepEqual(asset.flows.exec.entry_requires, ['consume']);
    assert.deepEqual(asset.flows.audit.entry_requires, ['consume']);
    assert.equal(asset.flows.exec.produce_field, 'outputs');
    assert.equal(asset.flows.exec.targets, true);
    assert.equal(asset.flows.exec.gate_command, true);
    assert.equal(asset.flows.audit.needhuman, true);
    // 断言演进（legacy-retire-20260915 / lane e2 / 资产侧 A-4）：
    //   原断言 `assert.deepEqual(asset.flows.complete.require_audit_outcomes, ['pass', 'skip'])`
    //   —— complete 白名单唯一真源换锚为 `flows.audit.audit_contract.verdict`（∩ 引擎基线 {pass,skip}），
    //   资产侧 legacy 键 `flows.complete.require_audit_outcomes` 已整段清退 ⇒ `flows.complete` 恒 undefined。
    //   演进为「已清退」正向断言（complete 段不再存在）+「真源仍在」断言（verdict 声明保留，白名单不变）。
    assert.equal(asset.flows.complete, undefined, 'legacy complete 段已清退（verdict 唯一真源）');
    assert.deepEqual(asset.flows.audit.audit_contract.verdict, ['pass', 'fail', 'skip'], 'complete 白名单真源 = audit_contract.verdict（声明保留）');
    assert.deepEqual(asset.flows.plan.contract.required_sections, ['## 验收标准', '## 约束']);
    assert.equal(asset.state_machine, undefined, '2026-09-18 清债：顶层 state_machine 已退役（声明即拒，不得声明）');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    clearRoleCache();
    clearFlowCache();
  }
});

// ── ③ 自定义牵头生效（静态 + 运行）──

test('writing-team A3 自定义牵头静态判据：plan_leads / audit_leads 与 layers 角色集一致，roles.extra = 各层角色并集', () => {
  const a = rawAsset('writing-team');
  assert.deepEqual(a.roles.plan_leads, ['writing-planner'], 'plan 牵头 = writing-planner');
  assert.deepEqual(a.roles.audit_leads, ['writing-auditor'], 'audit 牵头 = writing-auditor');
  assert.ok(a.layers.plan.roles.includes('writing-planner'), 'writing-planner 必须 ∈ layers.plan.roles');
  assert.ok(a.layers.audit.roles.includes('writing-auditor'), 'writing-auditor 必须 ∈ layers.audit.roles');
  // 自定义角色声明义务：全部角色 ∈ roles.extra（不在引擎基础集内）
  const layerRoles = Object.values(a.layers).flatMap((l) => l.roles);
  assert.deepEqual([...a.roles.extra].sort(), [...layerRoles].sort(), 'roles.extra 必须等于各层角色并集');
});

test('writing-team A3 牵头运行面：writing-planner 承担 plan 牵头、writing-auditor 承担 audit 牵头（建批零 GATE_ROLE_MISSING）', async () => {
  const { root, byName } = makeHarness();
  try {
    clearRoleCache();
    clearFlowCache();
    // C 类形态（5 lane / 跨层依赖）⇒ collectRoleCompletenessWarnings 生效：牵头不成立即出 GATE_ROLE_MISSING
    const out = await byName.wave_plan.execute({ batchId: 'wta-a3', tasks: writingTasks(), team: 'writing-team', assembly: ASSEMBLY }, SESS);
    assert.equal(codesOf(out).includes('GATE_ROLE_MISSING'), false, '自定义牵头须被引擎认可：' + JSON.stringify(out.warnings));
    // 对照反例：牵头角色悬空（不在该层/任一层）→ 拒载 TEAM_ASSET_LEAD_NOT_IN_LAYERS（证明校验真在跑）
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wta-lead-'));
    try {
      const broken = rawAsset('writing-team');
      broken.roles = { ...broken.roles, plan_leads: ['dangling-planner'] };
      fs.mkdirSync(path.join(tmpRoot, 'presets', 'writing-team'), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, 'presets', 'writing-team', 'team-asset.yml'), JSON.stringify(broken), 'utf8');
      const bad = loadTeamAsset(tmpRoot, 'writing-team');
      // 【R2-3 一致性（2026-09-17 裁决）改语义】原断言 `assert.equal(bad.ok, false, '悬空牵头必须被拒载')`
      //   改为「不再拒载 + 警告必须留痕」：`ok = 无 blocking`，而 `LEAD_NOT_IN_LAYERS` **不在**
      //   `BLOCKING_CODES`（`lib/assembly/team-asset.js:96-106` 九条内无此码）⇒ 它是 warning 级
      //   ⇒ 悬空牵头不再否决整份资产（旧语义下此处 false）。本用例意图（证明校验真在跑）**未削弱**：
      //   ① 断言翻转（拒载 → 不拒但留痕）+ ② 显式补 problems 非空（旧断言由 ok 隐含）
      //   + ③ 码面断言与对照断言**逐字保留**。
      assert.equal(bad.ok, true, 'R2-3 后：warning 级不得否决（悬空牵头不再拒载）');
      assert.ok(bad.problems.length > 0, '必须留痕（不得静默）');
      assert.ok(bad.problems.some((p) => p.code === TEAM_ASSET_CODES.LEAD_NOT_IN_LAYERS), '须报 TEAM_ASSET_LEAD_NOT_IN_LAYERS：' + JSON.stringify(bad.problems));
      // 对照：真实资产无该码（证明上面的红不是环境噪音）
      const good = loadTeamAsset(packageRoot(), 'writing-team');
      assert.equal(good.problems.some((p) => p.code === TEAM_ASSET_CODES.LEAD_NOT_IN_LAYERS), false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    clearRoleCache();
    clearFlowCache();
  }
});

// ── ④ publisher 的「审核通过才交付」生产门禁（正/负例成对）──

test('writing-team A4 生产门禁成对断言：publisher lane 缺 audit 两产物 → GATE_ENTRY_MISSING 且不进入 running；补齐后可派', async () => {
  const { root, byName } = makeHarness();
  try {
    clearRoleCache();
    clearFlowCache();
    // entry_requires 翻牌前提（否则 legacy 口径下「无 consume 才校验」会产生假绿）
    assert.deepEqual(rawAsset('writing-team').flows.exec.entry_requires, ['consume']);
    const out = await byName.wave_plan.execute({ batchId: 'wta-a4', tasks: writingTasks(), team: 'writing-team', assembly: ASSEMBLY }, SESS);
    assert.equal(codesOf(out).includes('GATE_ROLE_INVALID'), false, 'publisher 角色须合法（∈ roles.extra）：' + JSON.stringify(out.warnings));
    const lane = out.wavePlan.flatMap((w) => w.tasks).find((t) => t.id === 'prod1');
    assert.deepEqual(lane.consume, ['plan/writing-spec.md', 'audit/editorial-review.md', 'audit/gap-list.json'], 'publisher lane 必须 consume plan 规格 ＋ audit 两产物（双消费，与 audit 同构）');
    assert.deepEqual(lane.outputs, ['exec/publish/wechat.html']);
    // ① 负例：audit 两产物不在产物根 → 拒派（plan 规格先落盘，使被检面收敛到「缺 audit 两产物」）
    writeArtifact(root, 'wta-a4', 'plan/writing-spec.md', '# spec\n');
    await assert.rejects(
      () => byName.member_status.execute({ batchId: 'wta-a4', lane: 'prod1', status: 'running' }, SESS),
      /GATE_ENTRY_MISSING: audit\/editorial-review\.md, audit\/gap-list\.json/,
      '缺 consume 产物必须拒派（「审核通过才交付」是门禁行为）',
    );
    // ② 成员态不进入 running（唯一事实源 = 批次状态文件）
    assert.equal(readBatch(root, 'wta-a4').lanes.prod1, 'pending', '拒派后成员态不得进入 running');
    assert.ok(readBatch(root, 'wta-a4').events.map((e) => e.type).includes('gate.entry.missing'), 'gate.entry.missing 事件留痕');
    // ③ 对照负例：只补一个产物仍拒（判据是「逐条存在性」而非「任一存在」）
    writeArtifact(root, 'wta-a4', 'audit/editorial-review.md', '# editorial review\n');
    await assert.rejects(
      () => byName.member_status.execute({ batchId: 'wta-a4', lane: 'prod1', status: 'running' }, SESS),
      /GATE_ENTRY_MISSING: audit\/gap-list\.json/,
    );
    assert.equal(readBatch(root, 'wta-a4').lanes.prod1, 'pending');
    // ④ 正例：补齐 audit 两产物 → 同 lane 可派（拒绝来自缺产物，非角色/技能非法）
    writeArtifact(root, 'wta-a4', 'audit/gap-list.json', '{}\n');
    await byName.member_status.execute({ batchId: 'wta-a4', lane: 'prod1', status: 'running' }, SESS);
    assert.equal(readBatch(root, 'wta-a4').lanes.prod1, 'running', '补齐 consume 产物后同 lane 可派');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    clearRoleCache();
    clearFlowCache();
  }
});
