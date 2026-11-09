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

// R-1（批 `punky-gate-fix` / lane `e2-plan-tighten`）· 六裸标题反例集（13 例）
// ─────────────────────────────────────────────────────────────────────────────
// 判据源：`artifacts/punky-gate-fix/plan/fix-plan.md` §修复 3 + AC-9 / AC-10 / AC-13。
//
// 被钉死的两处 fail-open（修前实测读数见 `exec/plan-tighten.md`）：
//   ① `lib/state/gates/plan-contract.js:83` 用 `requiredSections.some(...)`
//      ⇒ 非 `*spec.md` 件**六缺五也放行**（`plan/plan.md` 只含 1/6 ⇒ 过）。
//   ② `lib/state/gates/plan-contract.js:97-102` 的 `*spec.md` 特权分支用 `content.includes(s)`
//      ⇒ `### 概述` / ` ## 概述` / `##概述` / `## 概述s` / `**## 概述**` / `> ## 概述` 六种变形**全算命中**。
//
// 修后两处统一走 `presence.js:37-42` 的 `sectionLineHit`（行首锚 + 整行 + 尾随空白容忍，本体不改）。
//
// 纪律：全部断言走 `store` + `buildWavePlan` **真实调用**（生产门禁路径），不白盒直调 `createGates`
//   ——与 `gate-criteria-parity-r33.test.js` 同纪律。
//
// 本案 13 例 = 六缺一 ×6（`plan/plan.md`，钉 ①）+ 变形 ×6（`plan/spec.md`，钉 ②）+ 仅 `### 验收标准` ×1（钉 entry 门）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';

// 交接门开关与本判读无关 ⇒ 中立化（与 r33 / p2-settle-handoff 同一纪律）。
delete process.env.PSWARM_HANDOFF_GATE;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-six-'));
const store = createStore(root);
const SID = 's-six';

// 六裸标题真源（与 `ENGINE_BASELINE_PLAN_SECTIONS` 同序，避免手抄漂移由 plan-criteria-config C1 守护）。
const SIX = ['## 概述', '## 问题', '## 方案', '## 需求', '## 验收标准', '## 约束'];

/** 三层夹具：plan 产出 `plan/spec.md`，audit 锚到它（唯一闸口 = 各自的门）。 */
function tasksOf(planRel) {
  return [
    { id: 'p1', layer: 'plan', role: 'designer', produce: [planRel], cmd: 'spec' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: [planRel], outputs: ['exec/e1/main.py'], cmd: 'code', deps: ['p1'] },
    { id: 'a1', layer: 'audit', role: 'supervisor', consume: [planRel], produce: ['audit/accept.md'], cmd: 'accept', deps: ['e1'] },
  ];
}

function makeBatch(batchId, planRel) {
  const plan = buildWavePlan({ batchId, tasks: tasksOf(planRel), team: 'punky-preset' });
  store.createBatch(SID, { batchId, wavePlan: plan, concurrency: plan.concurrency });
  return plan;
}

function art(batchId, rel, content) {
  const abs = path.join(root, 'sessions', SID, 'artifacts', batchId, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

function set(batchId, lane, to) {
  try { return store.setMember(SID, batchId, lane, to); } catch (e) { return e; }
}

/** 驱动计划契约门：plan lane 结算（running → review → merged）。返回 Error 或 null。 */
function settlePlan(batchId, planRel, body) {
  makeBatch(batchId, planRel);
  art(batchId, planRel, body);
  for (const to of ['running', 'review', 'merged']) {
    const r = set(batchId, 'p1', to);
    if (r instanceof Error) return r;
  }
  return null;
}

/** 驱动 entry 判据来源门：audit lane 派发。返回 Error 或 null。 */
function dispatchAudit(batchId, planRel, body) {
  makeBatch(batchId, planRel);
  art(batchId, planRel, body);
  const r = set(batchId, 'a1', 'running');
  return r instanceof Error ? r : null;
}

/** 六标题取子集拼正文（保持真源顺序，行首精确，内容可空）。 */
function bodyWithSections(sections) {
  return '# 判据源\n' + sections.join('\n\n') + '\n';
}

// ── A. 六缺一 ×6：`some` → `every`（非 `*spec.md` 件，钉缺陷 ①）────────────────
// 修前：六缺一 ×6 **全部放行**（`some` 命中 5 个即置 criteriaHit）。
// 修后：逐例 **拒 `GATE_PLAN_CONTRACT`** 且拒因点名缺的那一章。
for (const missing of SIX) {
  test(`S-1 六缺一：缺 \`${missing}\` ⇒ 拒 GATE_PLAN_CONTRACT（非 spec.md 件）`, () => {
    const body = bodyWithSections(SIX.filter((s) => s !== missing));
    const err = settlePlan(`b-six-miss-${SIX.indexOf(missing)}`, 'plan/plan.md', body);
    assert.ok(err, `六缺一必拒：缺 \`${missing}\` 时门仍放行（应为 GATE_PLAN_CONTRACT）`);
    assert.match(String(err.message), /GATE_PLAN_CONTRACT/, '实际：' + String(err.message));
    assert.match(String(err.message), new RegExp('lacks "' + missing + '"'),
      '拒因须点名缺的那一章（诊断质量：不能只给「缺验收标准」的笼统拒因）。实际：' + String(err.message));
  });
}

// ── B. 变形 ×6：删 `*spec.md` 特权 + 统一 `sectionLineHit`（钉缺陷 ②）──────────
// 每例：六标题中**恰一个**写成变形形态，其余五个为裸标题。
// 修前：`includes` 子串匹配 ⇒ 变形**全算命中** ⇒ 六齐 ⇒ 放行（这是 `*spec.md` 特权）。
// 修后：变形**不算命中** ⇒ 该章视为缺失 ⇒ 拒 `GATE_PLAN_CONTRACT` 且点名该章。
const DEFORMS = [
  { slug: 'h3', target: '## 概述', form: '### 概述', label: '三级标题 ###' },
  { slug: 'indent1', target: '## 概述', form: ' ## 概述', label: '行首一个空格' },
  { slug: 'nospace', target: '## 概述', form: '##概述', label: '缺分隔空格' },
  { slug: 'trailword', target: '## 概述', form: '## 概述s', label: '尾随字母' },
  { slug: 'bold', target: '## 概述', form: '**## 概述**', label: '加粗包裹' },
  { slug: 'quote', target: '## 概述', form: '> ## 概述', label: '引用前缀 >' },
];

for (const d of DEFORMS) {
  test(`S-2 变形标题：\`${d.form}\`（${d.label}）不算命中 ⇒ 拒 GATE_PLAN_CONTRACT（spec.md 无特权）`, () => {
    const body = '# Spec\n\n' + d.form + '\n\n' + SIX.filter((s) => s !== d.target).join('\n\n') + '\n';
    const err = settlePlan('b-six-def-' + d.slug, 'plan/spec.md', body);
    assert.ok(err, `变形 \`${d.form}\` 不得顶用：门仍放行（应为 GATE_PLAN_CONTRACT）`);
    assert.match(String(err.message), /GATE_PLAN_CONTRACT/, '实际：' + String(err.message));
    assert.match(String(err.message), new RegExp('lacks "' + d.target + '"'),
      '拒因须点名被变形的章。实际：' + String(err.message));
  });
}

// ── C. 仅 `### 验收标准` 的判据源 ×1：entry 门换匹配器（钉 AC-10 三形态）───────────
// 修前：`entry.js:147` 用 `.includes('## 验收标准')` ⇒ `### 验收标准` / 行首空格 皆是子串 ⇒ **命中** ⇒ 放行。
// 修后：`sectionLineHit` 行首锚 ⇒ 后两者不命中 ⇒ 拒 `GATE_AUDIT_CRITERIA_MISSING`。
// 本用例一个用例内覆盖 AC-10 的三形态（`###` / 行首两空格 / 裸标题对照），不另计例数（反例集仍为 13 例）。
test('S-3 判据源只含 `### 验收标准` ⇒ 拒 GATE_AUDIT_CRITERIA_MISSING（entry 门与 :163 文案同判据）', () => {
  // AC-10 形态①：三级标题
  const h3 = '# Spec\n### 概述\n- x\n### 问题\n- x\n### 方案\n- x\n### 需求\n- x\n### 验收标准\n- x\n### 约束\n- x\n';
  const errH3 = dispatchAudit('b-six-h3-criteria', 'plan/spec.md', h3);
  assert.ok(errH3, '`### 验收标准` 不得顶用：entry 判据来源门仍放行（应为 GATE_AUDIT_CRITERIA_MISSING）');
  assert.match(String(errH3.message), /GATE_AUDIT_CRITERIA_MISSING/, '实际：' + String(errH3.message));

  // AC-10 形态②：行首两空格
  const indented = '# Spec\n## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n  ## 验收标准\n- x\n## 约束\n- x\n';
  const errIndent = dispatchAudit('b-six-indent-criteria', 'plan/spec.md', indented);
  assert.ok(errIndent, '行首两空格的 `## 验收标准` 不得顶用（应为 GATE_AUDIT_CRITERIA_MISSING）');
  assert.match(String(errIndent.message), /GATE_AUDIT_CRITERIA_MISSING/, '实际：' + String(errIndent.message));

  // AC-10 形态③：裸标题 ⇒ 过（防收紧过度）
  assert.equal(dispatchAudit('b-six-bare-criteria', 'plan/spec.md', bodyWithSections(SIX)), null,
    '裸标题 `## 验收标准` 必须放行（AC-10 形态③对照）');
});

// ── D. 正例对照（防「收紧 = 误杀」）：六裸标题齐 + 围栏内标题 ────────────────────
// N-3 裁决（甲）：代码围栏内的 `## 验收标准` **算命中**（`sectionLineHit` 只判行首形态，不判代码块上下文）。
test('S-4 正例对照：六裸标题齐 ⇒ plan 契约门放行（收紧未误杀）', () => {
  assert.equal(settlePlan('b-six-pass', 'plan/spec.md', bodyWithSections(SIX)), null,
    '六裸标题齐备件必须放行，否则是收紧过度');
});

test('S-5 N-3 裁决：围栏内 `## 验收标准` 算命中 ⇒ entry 判据来源门放行（期望行为，非缺口）', () => {
  const fenced = '# Spec\n```\n## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准\n```\n## 约束\n- none\n';
  assert.equal(dispatchAudit('b-six-fence', 'plan/spec.md', fenced), null,
    'N-3=甲：围栏内标题算命中 ⇒ 必须放行（若改为拒，需先改 N-3 裁决）');
});
