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

// R1-a 团队资产（team-asset）加载与加载期不变量校验：回归锚
//   ① 包内真实声明（presets/software-team/team-asset.yml）必须加载通过且与装配语义等价；
//   ② punky-preset 团队装配**已退役**（presets/punky-preset/team-asset.yml 已删）⇒ 拒载 + 不静默回落
//      （presets/punky-preset/agent.cordis.yml 等 persona/纪律资产不参与团队装配解析）；
//   ③ 每条不变量都有对应问题码（fail 时归因明确）；
//   ④ 读端容忍 BOM（2026-09-13 runtime.json 实测缺陷的同族防御）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TEAM_ASSET_CODES, PRODUCE_LAYERS, FLOW_SECTIONS, PRODUCE_FIELDS, ENTRY_REQUIREMENTS,
  parseTeamAsset, validateTeamAsset, readTeamAsset, loadTeamAsset, teamAssetCandidates, stripBom,
  severityOfProblem, hasBlockingProblems,
} from '../lib/assembly/team-asset.js';
import { MEMBER_TRANSITIONS } from '../lib/schema.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const CODES = (r) => r.problems.map((p) => p.code);
const baseAsset = () => ({
  team: 'demo',
  layers: {
    plan: { roles: ['designer'], skills: { designer: ['dev-designer'] } },
    exec: { roles: ['coder'], skills: { coder: ['dev-coder'] } },
    audit: { roles: ['reviewer'], skills: { reviewer: ['report-blind-audit'] } },
  },
  flows: {
    plan: { produce_field: 'produce', entry_requires: [] },
    exec: { produce_field: 'outputs', consume_field: 'consume', entry_requires: [] },
    audit: { produce_field: 'produce', entry_requires: [] },
    // 断言演进（legacy-retire-20260915 / lane e2）：原 fixture 行
    //   `complete: { require_audit_outcomes: ['pass'] },` 删除——legacy 键已清退，
    //   complete 白名单唯一真源 = `flows.audit.audit_contract.verdict`。
    // F-4（2026-09-15 用户裁决 Q-D=A）再演进：`FLOW_SECTIONS` 收敛为 `plan/exec/audit`（`complete` 已移除）
    //   ⇒ 本 fixture **不得**再声明 `complete`（声明即整份资产拒载，见下方未知层 + 拒载反例用例）。
    //   注：`FLOW_SECTIONS` 是**允许集非必填集**这条性质不变，但允许集内容已由四段收敛为三段。
  },
  // 【2026-09-18 清债】原 fixture 含 `rework` / `state_machine` 两个**顶层退役键**——两者已退役
  //   （零运行期消费者 ⇒ **声明即拒** `FIELD_NOT_ALLOWED`）⇒ 本 fixture 必须**不含**它们，
  //   否则每条用例都会先吃两道 blocking（这正是「退役键不得静默留存」的自证）；退役守门由下方专门用例覆盖。
});

function tmpRoot() {
  const root = mkdtempSync(join(tmpdir(), 'team-asset-'));
  mkdirSync(join(root, 'presets', 'demo'), { recursive: true });
  return root;
}

// ── 已删（2026-09-26，用户裁决「删这两条」）────────────────────────────────────
// 原 `包内 software-team 声明：加载通过且与装配语义等价（层/字段/契约/流程开关/收紧）` 测试**整条锚定旧资产形状**
//   （`flows.plan.contract.required_sections` / `layers.audit.roles` = [supervisor, doc-manager] /
//    `entry_requires` 三态 / `state_machine` 退役面 等），而**这些正是「团队内容改为模版、不再作为组件」
//   要去掉的**（见 `presets/software-team/team-asset.yml` 现为 859 B 最小骨架）⇒ 该断言在新骨架下**永不成立**。
// ⇒ 团队资产的**加载期合法性**仍由以下两处覆盖，未留缺口：
//   ① 本文件其余用例（`loadTeamAsset` / `validateTeamAsset` 的通用分支与码面）
//   ② **宿主级冒烟**（以 `team:'software-team'` 真实 `wave_plan` 建批，验 `teamAsset.ok=true` 且读的是新骨架）
// ⚠ 若日后需要「包内资产声明面」的对照，请**对当前骨架重写**（只断言 `team` 非空 + `layers[*].roles/skills` 结构），
//   不要恢复对 `contract` / `DEFAULT_ASSEMBLY` 的逐键对照。


test('读端容忍 BOM（U+FEFF 前缀不导致 BAD_JSON）', () => {
  const text = '\uFEFF' + JSON.stringify(baseAsset());
  assert.equal(stripBom(text).startsWith('{'), true);
  const r = parseTeamAsset(text, { path: 'x' });
  assert.equal(r.ok, true, '剥 BOM 后应解析成功');
});

test('非 JSON 子集内容（YAML 语法）→ TEAM_ASSET_BAD_JSON 且提示书写要求', () => {
  const r = parseTeamAsset('team: demo\nflows:\n  plan: {}\n', { path: 'presets/demo/team-asset.yml' });
  assert.equal(r.ok, false);
  assert.deepEqual(CODES(r), [TEAM_ASSET_CODES.BAD_JSON]);
  assert.match(r.problems[0].message, /JSON 子集/);
});

test('缺 team / 缺 flows / 缺 produce_field → MISSING_FIELD', () => {
  const a1 = baseAsset(); delete a1.team;
  assert.ok(CODES(validateTeamAsset(a1)).includes(TEAM_ASSET_CODES.MISSING_FIELD));
  const a2 = baseAsset(); delete a2.flows;
  assert.ok(CODES(validateTeamAsset(a2)).includes(TEAM_ASSET_CODES.MISSING_FIELD));
  const a3 = baseAsset(); delete a3.flows.exec.produce_field;
  const p3 = validateTeamAsset(a3).problems.find((p) => p.path === 'flows.exec.produce_field');
  assert.equal(p3.code, TEAM_ASSET_CODES.MISSING_FIELD);
});

test('produce_field 越界 → FIELD_NOT_ALLOWED（白名单 produce|outputs）', () => {
  const a = baseAsset(); a.flows.exec.produce_field = 'artifacts';
  const p = validateTeamAsset(a).problems.find((x) => x.path === 'flows.exec.produce_field');
  assert.equal(p.code, TEAM_ASSET_CODES.FIELD_NOT_ALLOWED);
  assert.deepEqual(PRODUCE_FIELDS, ['produce', 'outputs']);
});

test('entry_requires 越界 → ENTRY_REQUIRE_UNKNOWN（白名单仅 consume）', () => {
  const a = baseAsset(); a.flows.exec.entry_requires = ['consume', 'plan-spec'];
  const p = validateTeamAsset(a).problems.find((x) => x.path === 'flows.exec.entry_requires');
  assert.equal(p.code, TEAM_ASSET_CODES.ENTRY_REQUIRE_UNKNOWN);
  assert.deepEqual(ENTRY_REQUIREMENTS, ['consume']);
});

test('contract 空章节/空 glob → CONTRACT_EMPTY', () => {
  const a = baseAsset(); a.flows.plan.contract = { artifact_globs: ['plan/*spec.md'], required_sections: [] };
  assert.ok(CODES(validateTeamAsset(a)).includes(TEAM_ASSET_CODES.CONTRACT_EMPTY));
  const b = baseAsset(); b.flows.plan.contract = { artifact_globs: [], required_sections: ['验收标准'] };
  assert.ok(CODES(validateTeamAsset(b)).includes(TEAM_ASSET_CODES.CONTRACT_EMPTY));
});

// ---- D5（2026-09-19）：plan 契约两个**可选**声明位的类型校验（`elements` / `pending_marker`）----
// 缺口：R1 §2.4 #3/#4 定下这两个声明位（元素级小节校验 / `[待确认]` 字面量），但**类型校验未落地**
//   （`lib/assembly/team-asset.js` 不在 R1 实施 lane 写域）；读端对坏形状**静默回落**
//   （`lib/state/gates.js:976-978` 非数组 ⇒ 零迭代；`:1066-1072` 非对象 / literal 非字符串 ⇒ 视同未声明）
//   ⇒ 声明方看不出「声明从未生效」=「写了不生效」的静默面。
// 口径：**缺省不声明 ⇒ 零行为变化**；坏形状 ⇒ 复用既有 `BAD_TYPE`（∈ BLOCKING_CODES）显式拒载，不新造码。
test('D5 红测①：`contract.elements` 非字符串数组 ⇒ BAD_TYPE（blocking，不静默回落）', () => {
  const cases = [
    'goal',          // 裸字符串（最常见误写：单元素未包成数组）
    ['goal', 3],     // 元素含非字符串
    ['goal', ''],    // 元素含空串（读端会静默丢弃该元素 ⇒ 该条声明不生效）
    ['goal', '  '],  // 空白串同上
    { goal: true },  // 对象形（误把 elements 当映射）
  ];
  for (const bad of cases) {
    const a = baseAsset();
    a.flows.plan.contract = { artifact_globs: ['plan/*spec.md'], required_sections: ['## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准'], elements: bad };
    const v = validateTeamAsset(a);
    assert.ok(CODES(v).includes(TEAM_ASSET_CODES.BAD_TYPE),
      `elements=${JSON.stringify(bad)} 必须产 BAD_TYPE；实测=` + JSON.stringify(v.problems));
    assert.equal(v.ok, false, 'BAD_TYPE ∈ BLOCKING_CODES ⇒ 拒载（不能静默当未声明）');
  }
});

test('D5 红测②：`contract.pending_marker` 非 `{ literal: string }` ⇒ BAD_TYPE（blocking）', () => {
  const cases = [
    '[待确认]',        // 裸字符串（最常见误写）
    ['[待确认]'],      // 数组
    {},                // 对象但缺 literal
    { literal: 1 },    // literal 非字符串
    { literal: '' },   // literal 空串（读端 `lit.length > 0` ⇒ 视同未声明）
    { literal: '  ' }, // literal 纯空白
  ];
  for (const bad of cases) {
    const a = baseAsset();
    a.flows.plan.contract = { artifact_globs: ['plan/*spec.md'], required_sections: ['## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准'], pending_marker: bad };
    const v = validateTeamAsset(a);
    assert.ok(CODES(v).includes(TEAM_ASSET_CODES.BAD_TYPE),
      `pending_marker=${JSON.stringify(bad)} 必须产 BAD_TYPE；实测=` + JSON.stringify(v.problems));
    assert.equal(v.ok, false, 'BAD_TYPE ∈ BLOCKING_CODES ⇒ 拒载');
  }
});

test('D5 正例（缺省不启用）：合法形态 / 空数组 / 未声明 / 显式 null 四态均零行为变化（ok=true）', () => {
  const shape = (mut) => {
    const a = baseAsset();
    a.flows.plan.contract = { artifact_globs: ['plan/*spec.md'], required_sections: ['## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准'] };
    mut(a.flows.plan.contract);
    return a;
  };
  const base = shape(() => {});
  const legal = shape((c) => { c.elements = ['goal', 'constraints']; c.pending_marker = { literal: '[待确认]' }; });
  const emptyArr = shape((c) => { c.elements = []; });                    // 空数组 = 读端零迭代 = 与缺省等价
  const nullish = shape((c) => { c.elements = null; c.pending_marker = null; }); // 沿既有 `!= null` 可选键风格
  for (const [name, a] of [['未声明', base], ['合法形态', legal], ['空数组', emptyArr], ['显式 null', nullish]]) {
    const v = validateTeamAsset(a);
    assert.equal(v.ok, true, `${name}：必须保持 ok=true；实测=` + JSON.stringify(v.problems));
    assert.deepEqual(CODES(v), [], `${name}：不得产任何 problem（缺省不启用）`);
  }
  // 合法形态必须**逐字保留**（校验只读不写、不改写声明）
  assert.deepEqual(legal.flows.plan.contract.elements, ['goal', 'constraints']);
  assert.deepEqual(legal.flows.plan.contract.pending_marker, { literal: '[待确认]' });
});

// ---- B-3（批次 core-techdebt-close-20260915 · lane e1）：`flows.audit.contract` 旧泛键标废 ----
// 缺口：`flows.audit.contract` 是**旧泛键**（现役真源 = 同层 `audit_contract`，读端 `flows.js` `auditContract`）。
//   旧泛键在 `validateTeamAsset` 原只走通用 `contract` 段（结构合法即静默通过），而**无任何运行期读点**
//   （`contractOf` 只取 plan 层）⇒ 「写了不生效」+ 双真源隐患。
// 口径：标废**不留兼容**——声明即在载入期产 `CONTRACT_LEGACY`（∈ BLOCKING_CODES）⇒ 拒载。
test('B-3 旧泛键标废：`flows.audit.contract` 声明 ⇒ 拒载 CONTRACT_LEGACY（blocking，且不静默忽略）', () => {
  const a = baseAsset();
  a.flows.audit.contract = { artifact_globs: ['audit/*report.md'], required_sections: ['## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准'] };
  const v = validateTeamAsset(a);
  assert.equal(v.ok, false, 'B-3：声明旧泛键 ⇒ 整份资产拒载（不得静默忽略）');
  const p = v.problems.find((x) => x.path === 'flows.audit.contract');
  assert.ok(p, 'B-3：须产一条 path=flows.audit.contract 的 problem；实测=' + JSON.stringify(v.problems));
  assert.equal(p.code, TEAM_ASSET_CODES.CONTRACT_LEGACY, 'B-3：码须为 TEAM_ASSET_CONTRACT_LEGACY');
  assert.equal(p.severity, 'blocking', 'B-3：须为 blocking 级（登记进 BLOCKING_CODES，非 warning 降级）');
  assert.equal(severityOfProblem({ code: TEAM_ASSET_CODES.CONTRACT_LEGACY }), 'blocking', 'B-3：严重级判定的单一来源自证');
  assert.equal(hasBlockingProblems(v.problems), true, 'B-3：blocking 判定读端（flows.js 强警示）须可识别');
  // 与结构段**并行**而非替代：结构非法时 CONTRACT_EMPTY 照旧产出（两条问题共存，互不吞并）
  const b = baseAsset();
  b.flows.audit.contract = { artifact_globs: [], required_sections: [] };
  const bc = CODES(validateTeamAsset(b));
  assert.ok(bc.includes(TEAM_ASSET_CODES.CONTRACT_EMPTY) && bc.includes(TEAM_ASSET_CODES.CONTRACT_LEGACY),
    'B-3：标废问题与既有结构问题并行产出；实测=' + JSON.stringify(bc));
  // 拒载传导（读盘面）：同一份声明落成磁盘资产 ⇒ `loadTeamAsset().ok === false` + 其他问题码原样透出
  const root = tmpRoot();
  try {
// 【F2 白名单】本文件**故意**直接写 team-asset（loader/边界自测需要造「坏资产 / 缺文件 / 字符串原文」形态，
//   而 `writeSyntheticTeam` 的形状下限校验会挡住它们）⇒ 登记在 test/fixture-team-ledger.test.js 的白名单内。
    writeFileSync(join(root, 'presets', 'demo', 'team-asset.yml'), JSON.stringify(a), 'utf8');
    const r = loadTeamAsset(root, 'demo');
    assert.equal(r.ok, false, 'B-3：loadTeamAsset 声明旧泛键 ⇒ 拒载');
    assert.ok(CODES(r).includes(TEAM_ASSET_CODES.CONTRACT_LEGACY), 'B-3：问题码原样透出；实测=' + JSON.stringify(CODES(r)));
    assert.notEqual(r.asset, null, '拒载仍回传已解析对象供诊断（既有口径）');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('B-3 负例：未声明 `flows.audit.contract` ⇒ 零影响（plan 现役契约 / audit_contract / 内置四资产零回归）', () => {
  // ① 未声明 ⇒ 无 CONTRACT_LEGACY、不引入 blocking（引擎 tighten-only 缺省侧照旧）
  const a = baseAsset();
  const v = validateTeamAsset(a);
  assert.equal(CODES(v).includes(TEAM_ASSET_CODES.CONTRACT_LEGACY), false, 'B-3：未声明 ⇒ 零新码');
  assert.equal(v.ok, true, 'B-3：未声明 ⇒ 仍可载；实测=' + JSON.stringify(v.problems));
  assert.equal(hasBlockingProblems(v.problems), false, 'B-3：未声明 ⇒ 不得借新码升 blocking');
  // ② 闸门只认 audit 层：plan / exec 的 `contract` 是**现役**声明面（`flows.js` `contractOf(plan)`）⇒ 不得误标废
  const b = baseAsset();
  b.flows.plan.contract = { artifact_globs: ['plan/*spec.md'], required_sections: ['## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准', '## 约束'] };
  b.flows.exec.contract = { artifact_globs: ['exec/*.md'], required_sections: ['## 结果'] };
  const bv = validateTeamAsset(b);
  assert.equal(CODES(bv).includes(TEAM_ASSET_CODES.CONTRACT_LEGACY), false, 'B-3：plan/exec 契约不得被误标旧泛键');
  assert.equal(bv.ok, true, 'B-3：plan/exec 契约结构合法 ⇒ 照旧通过；实测=' + JSON.stringify(bv.problems));
  // ③ 与真源共存：audit_contract（现役）照旧通过，且与「无 contract」两态互不影响
  const c = baseAsset();
  c.flows.audit.audit_contract = { criteria_from: 'plan/*spec.md', consumes_required: ['plan-spec'], verdict: ['approve', 'reject'] };
  const cv = validateTeamAsset(c);
  assert.equal(cv.ok, true, 'B-3：现役 audit_contract 零影响；实测=' + JSON.stringify(cv.problems));
  assert.equal(CODES(cv).includes(TEAM_ASSET_CODES.CONTRACT_LEGACY), false);
  // ④ 内置四资产零回归：四份 presets 资产均不含旧泛键 ⇒ 无新码 + 无问题（A2 负例的「零影响」面）
  for (const team of ['software-team', 'design-team', 'research-team', 'writing-team']) {
    const r = loadTeamAsset(REPO_ROOT, team);
    const codes = CODES(r);
    assert.equal(codes.includes(TEAM_ASSET_CODES.CONTRACT_LEGACY), false, `${team}：内置资产不得命中 CONTRACT_LEGACY`);
    assert.deepEqual(codes, [], `${team}：内置资产零问题（A2 负例）；实测=` + JSON.stringify(r.problems));
    assert.equal(r.asset.flows.audit.contract, undefined, `${team}：audit 层不得持有旧泛键`);
  }
});

test('未知层 → LAYER_UNKNOWN；层集合固定 plan|exec|audit（complete 已按 F-4 退出白名单）', () => {
  const a = baseAsset(); a.flows.review = { produce_field: 'produce' };
  assert.ok(CODES(validateTeamAsset(a)).includes(TEAM_ASSET_CODES.LAYER_UNKNOWN));
  assert.deepEqual(FLOW_SECTIONS, ['plan', 'exec', 'audit']);
  assert.deepEqual(PRODUCE_LAYERS, ['plan', 'exec', 'audit']);

  // 【F-4 拒载反例 → **K-2 翻牌（2026-09-18 用户裁决）**】原断言为「声明即整份拒载（blocking）」；
  //   K-2 后 `LAYER_UNKNOWN` **退出 BLOCKING_CODES** ⇒ 不拒载、改 **warning 留痕**（本机无外部自建 team，
  //   未知层判定暂时用不到 ⇒ 先清理，日后有需求再补）。与上方 `deepEqual(FLOW_SECTIONS, …)` 仍构成
  //   **双向护栏**（把 `'complete'` 加回白名单 ⇒ 深等值断言转红）；**码面 / 文案 / 严重级三重锚逐字保留**。
  const c = baseAsset();
  c.flows.complete = { require_audit_outcomes: ['pass'] };
  const pc = validateTeamAsset(c);
  assert.equal(pc.ok, true, 'K-2：未知层为 warning ⇒ 不拒载（不再是「声明即拒」）');
  const cp = pc.problems.find((p) => p.path === 'flows.complete');
  assert.equal(cp.code, TEAM_ASSET_CODES.LAYER_UNKNOWN);
  assert.equal(cp.severity, 'warning', 'K-2：warning 级（非 blocking）');
  assert.ok(cp.message.includes('未知层：complete'), cp.message);
  assert.ok(cp.message.includes('允许：plan/exec/audit'), cp.message); // 允许集**不含** complete（文案锚）
  assert.equal(pc.problems.some((p) => String(p.path).startsWith('flows.complete.')), false, '未知层被跳过 ⇒ 不做该层字段级联校验');

  // 传导（读盘面）：同一份声明落成磁盘资产 ⇒ `ok === true`（**可用**）+ 码面仍可读（留痕）
  const root = tmpRoot();
  try {
    writeFileSync(join(root, 'presets', 'demo', 'team-asset.yml'), JSON.stringify(c), 'utf8');
    const r = loadTeamAsset(root, 'demo');
    assert.equal(r.ok, true, 'loadTeamAsset：K-2 后未知层不拒载');
    assert.ok(CODES(r).includes(TEAM_ASSET_CODES.LAYER_UNKNOWN), 'K-2：码面保留（留痕可读）');
    assert.notEqual(r.asset, null, '仍回传已解析对象供诊断（既有口径）');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('扩展角色词法非法/重复 → ROLE_LEXICAL', () => {
  const a = baseAsset(); a.roles = { extra: ['Bad Role'] };
  assert.ok(CODES(validateTeamAsset(a)).includes(TEAM_ASSET_CODES.ROLE_LEXICAL));
  const b = baseAsset(); b.roles = { extra: ['writer', 'writer'] };
  assert.ok(CODES(validateTeamAsset(b)).includes(TEAM_ASSET_CODES.ROLE_LEXICAL));
  const c = baseAsset(); c.roles = { extra: ['narrative-designer'] };
  assert.equal(validateTeamAsset(c).ok, true, 'kebab-case 扩展角色应通过');
});

test('layers.roles 与 skills 不匹配 → SKILLS_MISMATCH', () => {
  const a = baseAsset(); a.layers.plan.roles = ['designer', 'coordinator'];
  const p = validateTeamAsset(a).problems.find((x) => x.path === 'layers.plan.skills.coordinator');
  assert.equal(p.code, TEAM_ASSET_CODES.SKILLS_MISMATCH);
});

// 【2026-09-18 清债】原四例覆盖团队级 `state_machine`（kind / overrides 契约）。该键**零运行期消费者**
//   ⇒ 已随清债**退役**（声明即拒）。四例 + 原 `rework` 一例合并替换为**退役守门**用例：
//   断言强度不减（由「若干非法值各报一码」改为「**三键声明即拒** + 码面/严重级/文案三重锚 + 反向零影响」）。
test('退役键守门：顶层 state_machine / rework 与 flows.<layer>.progress_contract ⇒ 声明即拒（FIELD_NOT_ALLOWED, blocking）', () => {
  const cases = [
    ['state_machine', (x) => { x.state_machine = { kind: 'tighten-only', overrides: {} }; }, 'state_machine'],
    ['rework', (x) => { x.rework = { allowed: true, max_attempts: 3, escalate: 'human' }; }, 'rework'],
    ['progress_contract', (x) => { x.flows.exec.progress_contract = { dir: 'progress', naming: 'NN-x.md' }; }, 'flows.exec.progress_contract'],
  ];
  for (const [label, mutate, path] of cases) {
    const a = baseAsset();
    mutate(a);
    const r = validateTeamAsset(a);
    const p = r.problems.find((x2) => x2.path === path);
    assert.ok(p, label + '：声明即须留痕（不得静默忽略）：' + JSON.stringify(r.problems));
    assert.equal(p.code, TEAM_ASSET_CODES.FIELD_NOT_ALLOWED, label + '：码面 = FIELD_NOT_ALLOWED');
    assert.equal(p.severity, 'blocking', label + '：blocking 级（退休声明面不留静默失效）');
    assert.ok(p.message.includes('2026-09-18 退役'), label + '：文案须指明退役：' + p.message);
    assert.equal(r.ok, false, label + '：整份资产拒载（与其余 blocking 码同口径）');
  }
  // 反向：三键**均不声明** ⇒ 零影响（现役资产形态不受牵连）
  const clean = validateTeamAsset(baseAsset());
  assert.equal(clean.ok, true, '不含退役键 ⇒ 照旧通过：' + JSON.stringify(clean.problems));
  assert.deepEqual(CODES(clean), [], '不含退役键 ⇒ 零问题');
});

test('读盘：未找到声明 → NOT_FOUND（含候选路径）', () => {
  const root = tmpRoot();
  try {
    const r = loadTeamAsset(root, 'no-such-team');
    assert.equal(r.ok, false);
    assert.deepEqual(CODES(r), [TEAM_ASSET_CODES.NOT_FOUND]);
    assert.equal(r.path, null);
    assert.equal(teamAssetCandidates(root, 'no-such-team').length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('读盘优先级：team-asset.json 优先于 team-asset.yml', () => {
  const root = tmpRoot();
  try {
    const j = baseAsset(); j.team = 'from-json';
    const y = baseAsset(); y.team = 'from-yml';
    writeFileSync(join(root, 'presets', 'demo', 'team-asset.json'), JSON.stringify(j), 'utf8');
    writeFileSync(join(root, 'presets', 'demo', 'team-asset.yml'), '\uFEFF' + JSON.stringify(y), 'utf8');
    const r = loadTeamAsset(root, 'demo');
    assert.equal(r.ok, true, JSON.stringify(r.problems));
    assert.equal(r.asset.team, 'from-json', '.json 优先');
    assert.match(r.path, /team-asset\.json$/);
    // 仅留 .yml（含 BOM）时回退读取成功
    rmSync(join(root, 'presets', 'demo', 'team-asset.json'));
    const r2 = loadTeamAsset(root, 'demo');
    assert.equal(r2.ok, true, JSON.stringify(r2.problems));
    assert.equal(r2.asset.team, 'from-yml');
    assert.match(r2.path, /team-asset\.yml$/);
    // 坏声明（非 JSON）→ BAD_JSON 而非抛错
    writeFileSync(join(root, 'presets', 'demo', 'team-asset.yml'), 'team: demo', 'utf8');
    const r3 = loadTeamAsset(root, 'demo');
    assert.deepEqual(CODES(r3), [TEAM_ASSET_CODES.BAD_JSON]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loadTeamAsset 组装：读盘 + 校验（坏声明 → ok:false 且不抛错）', () => {
  const root = tmpRoot();
  try {
    const bad = baseAsset(); bad.flows.plan.produce_field = 'nope';
    writeFileSync(join(root, 'presets', 'demo', 'team-asset.yml'), JSON.stringify(bad), 'utf8');
    const r = loadTeamAsset(root, 'demo');
    assert.equal(r.ok, false);
    assert.ok(CODES(r).includes(TEAM_ASSET_CODES.FIELD_NOT_ALLOWED));
    assert.ok(r.asset !== null, '解析成功的对象仍返回（供调用方诊断）');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('readTeamAsset 与 loadTeamAsset 对不存在团队均返回结构化结果（不抛错）', () => {
  const root = tmpRoot();
  try {
    assert.equal(readTeamAsset(root, 'x').ok, false);
    assert.equal(loadTeamAsset(root, 'x').ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── R2-3 一致性（2026-09-17 裁决）：`validateTeamAsset` 的 `ok = 无 blocking` ──────────────
// 背景：`chain.js` 已在 R2-3 对齐该口径；资产级同族函数此前仍为「零问题」⇒
//   `assertTeamAssetReady`（`lib/tools/core.js:447`）把**仅 warning** 的资产也当「不可用」拒载。
// 口径：`ok = !hasBlockingProblems(problems)`；warning 只提示不否决，且**逐条完整保留**在 `problems`。
// 资产级 warning 码：`ROLE_LEXICAL` / `CONSUME_FIELD_NOT_ALLOWED`
//   （原第三条 `LEAD_NOT_IN_LAYERS` 的**资产级产出点**已随 2026-09-26 裁决删除 —— `roles.plan_leads` /
//    `roles.audit_leads` 两个子键全链移除；该常量仍保留并被 `chain.js` 用于**链声明侧**的角色悬空校验。）
test('R2-3-a 仅 warning ⇒ ok=true 且 problems **非空**（warning 不丢弃、不降级为日志）', () => {
  // ① 扩展角色词法非法（ROLE_LEXICAL ∈ warning 侧）
  const b = baseAsset();
  b.roles = { extra: ['Not_Kebab'] };
  const r2 = validateTeamAsset(b);
  assert.equal(r2.ok, true, '仅 warning（词法）⇒ ok:true：' + JSON.stringify(r2.problems));
  assert.ok(r2.problems.length > 0, 'problems 必须非空');
  assert.equal(CODES(r2).includes(TEAM_ASSET_CODES.ROLE_LEXICAL), true, '码面原样保留');
  assert.equal(r2.problems.every((p) => p.severity === 'warning'), true, '逐条须带 severity=warning');

  // ② consume_field 非白名单（CONSUME_FIELD_NOT_ALLOWED ∈ warning 侧；读端回落 'consume'）
  const c = baseAsset();
  c.flows.exec.consume_field = 'nope';
  const r3 = validateTeamAsset(c);
  assert.equal(r3.ok, true, '仅 warning（consume_field 白名单外）⇒ ok:true：' + JSON.stringify(r3.problems));
  assert.ok(r3.problems.length > 0, 'problems 必须非空');
  assert.equal(CODES(r3).includes(TEAM_ASSET_CODES.CONSUME_FIELD_NOT_ALLOWED), true, '码面原样保留');

  // warning 码均**不是** blocking 级（与 team-asset.js 的 BLOCKING_CODES 分档一致）
  for (const code of [TEAM_ASSET_CODES.ROLE_LEXICAL, TEAM_ASSET_CODES.CONSUME_FIELD_NOT_ALLOWED]) {
    assert.equal(severityOfProblem({ code }), 'warning', code + ' 须为 warning 级');
  }
});

test('R2-3-b 存在 blocking ⇒ ok=false（warning 与 blocking 并存时以 blocking 为准，且 warning 不被吞）', () => {
  // 纯 blocking：produce_field 不在白名单（FIELD_NOT_ALLOWED）
  const a = baseAsset();
  a.flows.plan.produce_field = 'nope';
  const r1 = validateTeamAsset(a);
  assert.equal(r1.ok, false, 'blocking ⇒ ok:false：' + JSON.stringify(r1.problems));
  assert.equal(hasBlockingProblems(r1.problems), true, '须确有 blocking 条目');
  assert.equal(severityOfProblem({ code: TEAM_ASSET_CODES.FIELD_NOT_ALLOWED }), 'blocking');

  // blocking + warning 并存：仍拒，且 warning 条目**在场**（不得被吞）
  const b = baseAsset();
  b.roles = { extra: ['Not_Kebab'] };         // warning（ROLE_LEXICAL）
  b.flows.plan.produce_field = 'nope';        // blocking
  const r2 = validateTeamAsset(b);
  assert.equal(r2.ok, false, 'blocking 与 warning 并存 ⇒ 仍拒：' + JSON.stringify(r2.problems));
  assert.equal(CODES(r2).includes(TEAM_ASSET_CODES.ROLE_LEXICAL), true, '共存 warning 不得被吞');
  assert.equal(CODES(r2).includes(TEAM_ASSET_CODES.FIELD_NOT_ALLOWED), true, 'blocking 条目在场');
});

test('R2-3-c 既有「非法资产必须拒」反例逐条不变（blocking 码面与 ok:false 均不因新语义松动）', () => {
  const cases = [
    ['层定义非对象', (x) => { x.layers.plan = 'nope'; }, TEAM_ASSET_CODES.BAD_TYPE],
    ['flows 未知层', (x) => { x.flows.nope = { produce_field: 'produce' }; }, TEAM_ASSET_CODES.LAYER_UNKNOWN],
    ['rework 已退役', (x) => { x.rework = { allowed: true, max_attempts: 0 }; }, TEAM_ASSET_CODES.FIELD_NOT_ALLOWED],
    ['state_machine 已退役', (x) => { x.state_machine = { kind: 'widen' }; }, TEAM_ASSET_CODES.FIELD_NOT_ALLOWED],
  ];
  for (const [label, mutate, code] of cases) {
    const a = baseAsset();
    mutate(a);
    const r = validateTeamAsset(a);
    assert.equal(CODES(r).includes(code), true, label + ' 须报 ' + code + '：' + JSON.stringify(r.problems));
  }
  // 上列 `ROLE_LEXICAL` 为 warning 级：若该资产**另有** blocking ⇒ 仍拒（防「warning 混入即放行」）
  const mixed = baseAsset();
  mixed.roles = { extra: ['Bad Role'] };               // warning（ROLE_LEXICAL）
  mixed.team = '';                                     // blocking（MISSING_FIELD：team 必填）
  const rm = validateTeamAsset(mixed);
  assert.equal(rm.ok, false, '含 blocking（team 缺失）⇒ 仍拒：' + JSON.stringify(rm.problems));
  assert.equal(CODES(rm).includes(TEAM_ASSET_CODES.MISSING_FIELD), true);
  assert.equal(CODES(rm).includes(TEAM_ASSET_CODES.ROLE_LEXICAL), true, 'warning 条目同时在册');

  // 非对象 / team 缺失 / 坏 JSON 三类既有拒载面**逐条不变**
  assert.equal(validateTeamAsset(null).ok, false);
  assert.equal(hasBlockingProblems(validateTeamAsset(null).problems), true);
  assert.deepEqual(CODES(validateTeamAsset(null)), [TEAM_ASSET_CODES.BAD_TYPE]);
  const noTeam = baseAsset();
  delete noTeam.team;
  assert.equal(validateTeamAsset(noTeam).ok, false);
  assert.equal(CODES(validateTeamAsset(noTeam)).includes(TEAM_ASSET_CODES.MISSING_FIELD), true);
  const badJson = parseTeamAsset('{{ not json');
  assert.equal(badJson.ok, false, '坏 JSON ⇒ 拒');
  assert.equal(badJson.problems.length, 1, '坏 JSON 只报一条');
  assert.equal(badJson.problems[0].code, TEAM_ASSET_CODES.BAD_JSON, '码面 = BAD_JSON');
  assert.equal(badJson.problems[0].severity, 'blocking', '严重级 = blocking（新语义下仍拒）');
  const root = tmpRoot();
  try {
    writeFileSync(join(root, 'presets', 'demo', 'team-asset.yml'), '{{ not json', 'utf8');
    const r = loadTeamAsset(root, 'demo');
    assert.equal(r.ok, false, '坏 JSON 资产仍拒载（ok:false）');
    assert.equal(CODES(r).includes(TEAM_ASSET_CODES.BAD_JSON), true);
    assert.equal(r.asset, null, '解析失败 ⇒ 不返回半成品资产');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── R1-e：resolveAssembly 权威源上移（包内资产）+ 等价性锚 + 退役语义 ──
test('R1-e：resolveAssembly 解析顺序 —— config 覆盖层优先 → 包内资产 → 无资产即 null（不再兜底）', async () => {
  const { resolveAssembly, assemblyFromTeamAsset, DEFAULT_ASSEMBLY } = await import('../lib/assembly.js');
  // ① 覆盖层优先（与重构前逐字一致）
  const custom = { team: 'custom', layers: { plan: { roles: ['designer'], skills: { designer: ['x'] } } } };
  assert.equal(resolveAssembly('punky-preset', custom), custom, 'config.assembly 整份优先');
  // ② ⚠ 原「包内 software-team 声明 ≡ DEFAULT_ASSEMBLY − layers.audit.skills.reviewer」的**显式差异对照已删**
  //    （2026-09-26，用户裁决「删这两条」）：该断言锚定**旧资产形状**（逐键对照 DEFAULT_ASSEMBLY），
  //    而新骨架（859 B 最小骨架）已不承载装配内容 ⇒ 对照永不成立。
  //    ⇒ 「包内资产能派生装配」仍由下方 ⑤（临时包根下的自定义团队）覆盖；
  //      「包内资产能加载」由宿主级冒烟覆盖。
  assert.equal(DEFAULT_ASSEMBLY.team, 'software-team', 'DEFAULT_ASSEMBLY 已转为 software-team 装配的兼容导出（不再是 punky-preset 内置常量）');
  // ③ **退役语义**：punky-preset 团队装配已弃用（资产文件已删）⇒ 无内置常量兜底，无资产即 null
  assert.equal(resolveAssembly('punky-preset'), null, 'punky-preset 退役：不再回落到任何内置装配常量');
  assert.equal(assemblyFromTeamAsset('punky-preset'), null);
  // ④ 无资产团队 → null（保持"不补 skills"旧语义）
  assert.equal(resolveAssembly('no-asset-team'), null);
  assert.equal(assemblyFromTeamAsset('no-asset-team'), null);
  // ⑤ 临时包根下的自定义团队 → 由声明派生
  const pkg = mkdtempSync(join(tmpdir(), 'gf-pkg-as-'));
  try {
    mkdirSync(join(pkg, 'presets', 'writing-team'), { recursive: true });
    writeFileSync(join(pkg, 'presets', 'writing-team', 'team-asset.yml'), JSON.stringify({
      team: 'writing-team',
      layers: { plan: { roles: ['outline-designer'], skills: { 'outline-designer': ['writing-trio'] } } },
      flows: { plan: { produce_field: 'produce' } },
    }), 'utf8');
    const a = resolveAssembly('writing-team', null, { root: pkg });
    assert.deepEqual(a, { team: 'writing-team', layers: { plan: { roles: ['outline-designer'], skills: { 'outline-designer': ['writing-trio'] } } } });
  } finally { rmSync(pkg, { recursive: true, force: true }); }
});
