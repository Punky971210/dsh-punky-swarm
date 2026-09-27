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

// R3-3：`GATE_AUDIT_CRITERIA_MISSING` 「判据两处」**勘误**与判据形态**钉死**
// ─────────────────────────────────────────────────────────────────────────────
// 上游 = `docs/gate-assertion-blueprint-2026-09-21.md` §6.2（R3-3 条目）
//         + `docs/rebuild-blueprint-2026-09-21.md` §3.4 冻结表 W6 行
//
// 现场核查结论（**推翻了上游条目的两处前提**）：
//
//   ① 上游称「判据两处 / 同为 `includes('## 验收标准')`「⇒ 存在重复实现、可抽取」。**不成立**：
//      `gates.ts:903`（entry 判据来源门，拒 `GATE_AUDIT_CRITERIA_MISSING`）判的是
//        「锚点产物**任一**含验收标准」；
//      `gates.ts:994`（plan 契约门引擎基线 spec.md 分支，拒 `GATE_PLAN_CONTRACT`）判的是
//        「每份 `*spec.md` **两章都要**（验收标准 + 约束）」。
//      二者**共用同一字符串字面量，但不是同一判据** ⇒ 无抽取对象。用例 1 把这条差异钉成可执行证据。
//
//   ② 两处**确实共享一个真缺陷**：判据形态用 `content.includes(...)`（**子串**匹配），
//      而代码注释（`gates.ts:876-877` / `:993`）与外部纪律文档（`presets/punky-preset/references/
//      discipline.md:228`）**逐字宣称**的是「**裸标题行** `## 验收标准`（与 `GATE_PLAN_CONTRACT` 同判据）」。
//      同文件内的 `sectionLineHit`（`gates.ts:399`）/ `elementLineHit`（`:411`）用的正是行首锚定 + 整行匹配，
//      且其注释明写「不用 `content.includes(id)` … `includes` 会把任意词命中 ⇒ 判据不可靠（假绿风险）」。
//      ⇒ 本处**实现落后于契约**，方向 **fail-open**（比宣称更宽），且违反同文件已确立的判据同源纪律。
//
//      实证（Node 22.22.2，两门各自真实调用）：
//        · 行内提及   `本文件不设该章，详见 ## 验收标准 一节` ⇒ entry 门**放行**、plan 契约门**放行**
//        · 代码围栏内 `` ```\n## 验收标准\n``` ``                ⇒ entry 门**放行**
//        · 编号变体   `## 5. 验收标准`                            ⇒ entry 门**拒**（子串不匹配的副作用，非判据使然）
//
//      ⇒ 用例 2/3/5 是**绊线**：断言的是**当前**（宽松）行为，并在断言消息里标注「已登记缺口」。
//         **解冻后改判据**（`includes` → `sectionLineHit`）时这些断言**必然转红** ⇒ 提示改判，不会静默漂移。
//
// 纪律（本波）：**纯增量**——零生产代码改动（`lib/**` 零 diff）、零解冻、零门禁行为变更。
//   全部断言走 **store / buildWavePlan 真实调用**（即生产门禁路径），不白盒直调 `createGates`。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';

// 交接门开关与本判读无关 ⇒ 中立化（与 p2-settle-handoff / gate-assertion-r32 同一纪律）。
delete process.env.PSWARM_HANDOFF_GATE;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-r33-'));
const store = createStore(root);
const SID = 's-r33';

// audit lane 真 `consume` 锚到 `plan/spec.md`（B5 设计本意）⇒ 唯一闸口 = entry 判据来源门。
function tasksAuditCriteria() {
  return [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1/main.py'], cmd: 'code', deps: ['p1'] },
    { id: 'a1', layer: 'audit', role: 'supervisor', consume: ['plan/spec.md'], produce: ['audit/accept.md'], cmd: 'accept', deps: ['e1'] },
  ];
}
function makePlan(batchId) {
  const plan = buildWavePlan({ batchId, tasks: tasksAuditCriteria(), team: 'punky-preset' });
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
/** 驱动 entry 判据来源门：audit lane 派发。返回 Error 或 null。 */
function dispatchAudit(batchId, specBody) {
  makePlan(batchId);
  art(batchId, 'plan/spec.md', specBody);
  const r = set(batchId, 'a1', 'running');
  return r instanceof Error ? r : null;
}
/** 驱动 plan 契约门：plan lane 结算（running → review → merged）。返回 Error 或 null。 */
function settlePlan(batchId, specBody) {
  makePlan(batchId);
  art(batchId, 'plan/spec.md', specBody);
  const r1 = set(batchId, 'p1', 'running');
  if (r1 instanceof Error) return r1;
  const r2 = set(batchId, 'p1', 'review');
  if (r2 instanceof Error) return r2;
  const r3 = set(batchId, 'p1', 'merged');
  return r3 instanceof Error ? r3 : null;
}

// 判据正例：裸标题行。
const BARE = '# Spec\n## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准\n- done\n## 约束\n- none\n';

// ── 1. 勘误锁：「两处」不是同一判据 ────────────────────────────────────────────
test('R3-3 · 勘误锁：同一内容下 entry 判据来源门与 plan 契约门判定**不同** ⇒ 「判据两处」不成立（无可抽取对象）', () => {
  // 逐字相同的内容：只有裸标题 `## 验收标准`，缺 `## 约束`。
  const singleSection = '# Spec\n## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准\n- x\n';

  const entryErr = dispatchAudit('b-r33-parity-entry', singleSection);
  assert.equal(entryErr, null,
    '前置：entry 判据来源门判的是「锚点任一含验收标准」⇒ 本章在即放行（实际：' + String(entryErr && entryErr.message) + '）');

  const contractErr = settlePlan('b-r33-parity-contract', singleSection);
  assert.ok(contractErr, '前置：plan 契约门判的是「两章都要」⇒ 缺 `## 约束` 必拒');
  assert.match(String(contractErr.message), /GATE_PLAN_CONTRACT/);
  assert.match(String(contractErr.message), /lacks "## 约束"/,
    '拒因须点名缺的那一章（实证：两处判的是不同集合，非同一判据的两份实现）');
});

// ── 2. entry 门：判据用子串匹配，行内提及亦命中（绊线）─────────────────────────
test('R3-3 · 绊线：entry 判据来源门用 `includes` ⇒ 行内提及 `## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准` 即算命中（当前放行；登记缺口，非期望行为）', () => {
  const inline = '# Spec\n本文件不设该章，详见 ## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准 一节\n## 约束\n- none\n';
  const err = dispatchAudit('b-r33-inline', inline);
  assert.equal(err, null,
    '【绊线 · 已登记缺口】`gates.ts:903` 按**子串**判据 ⇒ 正文提及即命中。'
    + '注释/`discipline.md:228` 宣称的是**裸标题行**（`sectionLineHit`）；一旦解冻收紧，本断言须改为「拒 GATE_AUDIT_CRITERIA_MISSING」。'
    + '实际：' + String(err && err.message));
});

// ── 3. entry 门：代码围栏内的标题行同样命中（绊线）────────────────────────────
test('R3-3 · 绊线：entry 判据来源门对**代码围栏内**的标题行同样命中（当前放行；登记缺口）', () => {
  const fenced = '# Spec\n```\n## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准\n```\n## 约束\n- none\n';
  const err = dispatchAudit('b-r33-fence', fenced);
  assert.equal(err, null,
    '【绊线 · 已登记缺口】子串匹配不区分上下文 ⇒ 围栏内示例文本即顶用。'
    + '`sectionLineHit` 同样拦不住本形态（它只锚行首/整行）⇒ 解冻时须一并决定「围栏内是否算命中」。'
    + '实际：' + String(err && err.message));
});

// ── 4. entry 门：编号变体仍拒（正向锁；被拒是子串不匹配的副作用，非判据使然）──
test('R3-3 · 正锁：entry 判据来源门拒编号变体 `## 5. 验收标准`（与 `GATE_PLAN_CONTRACT` 同向）', () => {
  const numbered = '# Spec\n## 5. 验收标准\n## 约束\n- none\n';
  const err = dispatchAudit('b-r33-numbered', numbered);
  assert.ok(err, '编号变体不得顶用');
  assert.match(String(err.message), /GATE_AUDIT_CRITERIA_MISSING/);
  assert.match(String(err.message), /lacks "## 验收标准"/, '实际：' + String(err.message));
});

// ── 5. plan 契约门：同一缺陷形态 + 两章都要（绊线 + 正锁）──────────────────────
test('R3-3 · 绊线 + 正锁：plan 契约门同用 `includes`（行内提及放行 / 缺章必拒）', () => {
  const inline = '# Spec\n见 ## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准 说明\n## 约束\n- none\n';
  const passed = settlePlan('b-r33-plan-inline', inline);
  assert.equal(passed, null,
    '【绊线 · 已登记缺口】`gates.ts:994` 与 `:903` 共享同一缺陷形态（子串匹配）。'
    + '一旦解冻收紧，本断言须改为「拒 GATE_PLAN_CONTRACT」。实际：' + String(passed && passed.message));

  const missing = settlePlan('b-r33-plan-missing', '# Spec\n## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准\n- x\n');
  assert.ok(missing, '两章判据：缺 `## 约束` 必拒');
  assert.match(String(missing.message), /GATE_PLAN_CONTRACT/);
  assert.match(String(missing.message), /lacks "## 约束"/, '实际：' + String(missing.message));

  // 对照：裸标题行两章齐备 ⇒ 两门均放行（证明上述拒/放行不是夹具副作用）。
  assert.equal(settlePlan('b-r33-plan-bare', BARE), null, '裸标题 + 两章齐备 ⇒ plan 契约门放行');
  assert.equal(dispatchAudit('b-r33-entry-bare', BARE), null, '裸标题 + 两章齐备 ⇒ entry 判据来源门放行');
});
