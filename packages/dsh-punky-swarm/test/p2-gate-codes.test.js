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

// punky-fix-p2-20261023 · c3 `A1-P2-13` 四码可证伪用例（tester 落）。
//
// ── 三档分治（禁「补一条假覆盖」）──────────────────────────────────────────────────────
//   ① `GATE_ROLE_MANAGER_AS_LANE` —— **production-path**：走真实建批入口 `buildWavePlan`，
//      批次照建（warnings 非阻断），同形阳性对照把 `role` 换成 `coder` 即不命中。
//   ② `GATE_ARTIFACT_MISSING` —— **sentinel-rewrite**：它是出口门的**内部哨兵**，外显形态是
//      `GATE_EXIT_MISSING_<LAYER>`。断言对象 = 外显形态（断言哨兵本体 = 断言一个非契约名）。
//   ③ `GATE_NO_DECLARATION` —— **internal-only**：`presenceJudge` 的内部 code，生产路径被出口门的
//      `GATE_EXIT_NO_DECLARATION` 前置早退完全拦截 ⇒ 必须「直调内部契约 + 生产不可达证伪」成对。
//   ④ `GATE_EXIT_MISSING_PLAN` —— **规格要求的独立成例**，但实测**结构性不可达**（见该用例内的
//      长注释与 `progress/03` 的读数）：plan 层在出口门里**先被委派给 `checkPlanContract`**，
//      走不到那条「按层族重写」的语句 ⇒ 本文件把它落成**「不可达证明 + 同族近邻可达对照」**，
//      **不伪造**一个 `layer:'PLAN'` 的非法 fixture 去凑绿（那是假覆盖）。
//
// ── 四个坑（照抄即可避）──────────────────────────────────────────────────────────────
//   1. `smoke:true` 的批会跳过 exit 产物门 ⇒ 拿不到任何 `*_MISSING_*` 码（本文件专列一例把它锁住）。
//   2. `standalone` 是「零声明的唯一放行路径」⇒ 生产不可达对照的 fixture **不得**声明 standalone。
//   3. `GATE_ARTIFACT_MISSING` 在拒因优先级里**最低**（根外 > 形态不符 > 空无原因 > 在场缺失）⇒
//      只要混进更高优先级拒因，拿到的就不是 `*_MISSING_<LAYER>`。本文件专列一例锁定该优先级。
//   4. 难度族（`GATE_DIFFICULTY_*` / `GATE_BATCH_REQUIRES_C`）是**另一族**码，不混进本文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildWavePlan } from '../lib/wave-plan.js';
import { createGates, presenceJudge } from '../lib/state/gates.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(PKG_ROOT, rel), 'utf8');

const SESS = 'sess-p2-codes';
const BID = 'b-p2-codes';

/** 合规三层 C 类批（exec→audit 齐备、audit 锚 plan 判据来源）。 */
const THREE_TIER = (execRole) => [
  { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 'spec', role: 'designer' },
  { id: 'e1', layer: 'exec', produce: ['exec/e1.md'], cmd: 'run', role: execRole, deps: ['p1'] },
  { id: 'a1', layer: 'audit', produce: ['audit/a1.md'], cmd: 'review', role: 'supervisor', consume: ['plan/spec.md', 'exec/e1.md'], deps: ['e1'] },
];

/** 建根（`createGates` 的 root 形态 = 状态根，产物在 `<root>/sessions/<sid>/artifacts/<bid>`）。 */
function mkState() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'p2-codes-'));
  mkdirSync(path.join(root, 'sessions', SESS, 'artifacts', BID), { recursive: true });
  mkdirSync(path.join(root, 'presets'), { recursive: true });
  return root;
}

const seed = (root, rel, body = 'out') => {
  const abs = path.join(root, 'sessions', SESS, 'artifacts', BID, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, 'utf8');
  return abs;
};

/** 单 lane 批（复用真实建批产物的外壳，只替换 wavePlan 以便逐层构造）。 */
function batchWith(basePlan, tasks, extra = {}) {
  return { ...basePlan, ...extra, lanes: {}, wavePlan: [{ wave: 1, tasks }] };
}

/** 满足 plan 契约门（六个裸标题）的 spec 正文。 */
const SPEC_OK = '# spec\n## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准\n- x\n## 约束\n- y\n';

// ── ① 生产可达档 ─────────────────────────────────────────────────────────────────────
test('A1-P2-13 / production-path · GATE_ROLE_MANAGER_AS_LANE：C 类批 + role=manager ⇒ warnings 含该码**且批次照建**', () => {
  const plan = buildWavePlan({ batchId: 'b-role-manager', tasks: THREE_TIER('manager') });
  const codes = plan.warnings.map((w) => w.code);
  assert.ok(codes.includes('GATE_ROLE_MANAGER_AS_LANE'), 'C 类批 + manager 角色必须产出该告警码；实得 ' + JSON.stringify(codes));
  // 「照建」= 非阻断：产物齐全（含 wavePlan 拓扑）
  assert.ok(Array.isArray(plan.wavePlan) && plan.wavePlan.length === 3, '批次必须照建（warnings 不阻断）：三 wave');
  assert.equal(plan.batchId, 'b-role-manager');
  // 告警载荷可核（供审计定位）
  const hit = plan.warnings.find((w) => w.code === 'GATE_ROLE_MANAGER_AS_LANE');
  assert.equal(hit.task, 'e1', '必须定位到具体 lane');
  assert.equal(hit.role, 'manager');
  assert.equal(hit.layer, 'exec');
});

test('A1-P2-13 / production-path · 同输入阳性对照：role=coder ⇒ 不含该码（其余完全相同）', () => {
  const plan = buildWavePlan({ batchId: 'b-role-coder', tasks: THREE_TIER('coder') });
  const codes = plan.warnings.map((w) => w.code);
  assert.equal(codes.includes('GATE_ROLE_MANAGER_AS_LANE'), false, '换成 coder 后不得命中；实得 ' + JSON.stringify(codes));
  assert.equal(plan.wavePlan.length, 3, '对照批同样照建（排除「批压根没建成」这种假阴性解释）');
});

test('A1-P2-13 / production-path · C 类前置真的在起作用：单 lane 批 + role=manager ⇒ 不产该码', () => {
  // `collectRoleCompletenessWarnings` 在 `isCClassBatch` 为 false 时整体早退
  const plan = buildWavePlan({ batchId: 'b-role-single', tasks: [{ id: 'l1', role: 'manager', cmd: 'x' }] });
  const codes = plan.warnings.map((w) => w.code);
  assert.equal(codes.includes('GATE_ROLE_MANAGER_AS_LANE'), false,
    '单 lane 批不是 C 类形态 ⇒ 该码不该无条件 push；实得 ' + JSON.stringify(codes));
});

// ── ② 哨兵重写档（EXEC / AUDIT）──────────────────────────────────────────────────────
function exitFixture() {
  const root = mkState();
  const base = buildWavePlan({ batchId: BID, tasks: THREE_TIER('coder') });
  const gates = createGates(root, {});
  return { root, gates, base };
}

test('A1-P2-13 / sentinel-rewrite · EXEC：声明一件不存在的产物 ⇒ 外显 GATE_EXIT_MISSING_EXEC（哨兵被改写）', () => {
  const { gates, base } = exitFixture();
  const r = gates.checkExitGate(SESS, BID, batchWith(base, [{ id: 'l', layer: 'exec', produce: ['missing-exec.md'] }]), 'l');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'GATE_EXIT_MISSING_EXEC', '内层哨兵 GATE_ARTIFACT_MISSING 必须被重写为层族码；实得 ' + r.code);
  assert.deepEqual(r.missing, ['missing-exec.md'], '缺失清单逐字可读');
});

test('A1-P2-13 / sentinel-rewrite · AUDIT：同上（阳性对照 = 声明一件存在且非空产物 ⇒ ok:true）', () => {
  const { root, gates, base } = exitFixture();
  const bad = gates.checkExitGate(SESS, BID, batchWith(base, [{ id: 'l', layer: 'audit', produce: ['missing-audit.md'] }]), 'l');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'GATE_EXIT_MISSING_AUDIT', '实得 ' + bad.code);
  // 同输入阳性对照：同一批、同一 lane，只把声明换成在场且非空产物
  seed(root, 'present-audit.md', 'review');
  const good = gates.checkExitGate(SESS, BID, batchWith(base, [{ id: 'l', layer: 'audit', produce: ['present-audit.md'] }]), 'l');
  assert.equal(good.ok, true, '在场且非空 ⇒ 放行（证明上一条不是「门恒拒」）');
});

test('A1-P2-13 / sentinel-rewrite · 坑 3：拒因优先级最低 ⇒ 混入更高优先级拒因时不拿 `*_MISSING_*`', () => {
  const { root, gates, base } = exitFixture();
  // 根外绝对路径（产物根之外）——比「在场缺失」优先级更高
  const outside = path.join(root, 'outside-artifact.md');
  writeFileSync(outside, 'x', 'utf8');
  const r = gates.checkExitGate(SESS, BID, batchWith(base, [{ id: 'l', layer: 'exec', produce: [outside] }]), 'l');
  assert.equal(r.ok, false);
  assert.notEqual(r.code, 'GATE_EXIT_MISSING_EXEC', '更高优先级拒因必须优先（否则断言会「碰巧通过」）；实得 ' + r.code);
  assert.equal(r.code, 'GATE_ARTIFACT_OUTSIDE_ROOT', '本约定的高优先级码');
});

test('A1-P2-13 / sentinel-rewrite · 坑 1：smoke 批跳过出口产物门 ⇒ 任何 `*_MISSING_*` 都拿不到', () => {
  const { gates, base } = exitFixture();
  // `smokeOf(batch)` 读**批次事件流**（`EVT_BATCH_SMOKE = 'batch.smoke'`），不是 `batch.smoke` 布尔位
  const r = gates.checkExitGate(SESS, BID, batchWith(base,
    [{ id: 'l', layer: 'exec', produce: ['missing-exec.md'] }], { events: [{ type: 'batch.smoke' }] }), 'l');
  assert.equal(r.ok, true, 'smoke 批整门跳过（这就是 fixture 不得带 smoke 的原因）');
  assert.equal(r.smokeSkipped, 'exit-produce', '跳过面可读（留痕不静默）');
  // 对照：同一 fixture **不带** smoke 事件 ⇒ 立刻拿到层族码（证明上一条的放行确实来自 smoke）
  const strict = gates.checkExitGate(SESS, BID, batchWith(base, [{ id: 'l', layer: 'exec', produce: ['missing-exec.md'] }]), 'l');
  assert.equal(strict.code, 'GATE_EXIT_MISSING_EXEC', '去掉 smoke 事件后判据恢复（实得 ' + strict.code + '）');
});

// ── ④ GATE_EXIT_MISSING_PLAN：规格要求的独立成例（实测结构性不可达）──────────────────
test('A1-P2-13 / PLAN-layer-gap · `GATE_EXIT_MISSING_PLAN` 结构性不可达：真 plan lane 缺产物得的是 GATE_PLAN_CONTRACT', () => {
  // BEFORE 读数（`gen-register` 口径）：EXEC 9 处 / AUDIT 3 处 / PLAN **0 处**断言。
  // 本用例原计划按 ② 的构造补上 PLAN 层，实测否证了该构造的可能性 —— 根因（可在下方逐条核）：
  //   `lib/state/gates/exit.js::checkExitGate` 在 `if (t.layer === 'plan') return checkPlanContract(...)`
  //   处**先返回**，根本走不到「按层族重写 `GATE_EXIT_MISSING_<LAYER>`」那条语句；
  //   `checkPlanContract` 的拒码面是 `GATE_PLAN_CONTRACT` / `GATE_PLAN_NO_DECLARATION` /
  //   `GATE_NEEDHUMAN_PENDING`，**不含** `GATE_EXIT_MISSING_PLAN`。
  //   ⇒ 「三层各一次」这个验收要求对 PLAN 层**不成立**（规格缺陷，非实现缺陷）。
  const { root, gates, base } = exitFixture();
  const bad = gates.checkExitGate(SESS, BID, batchWith(base, [{ id: 'l', layer: 'plan', produce: ['missing-plan.md'] }]), 'l');
  assert.equal(bad.ok, false, 'plan lane 缺产物必须被拒（不是放行）');
  assert.equal(bad.code, 'GATE_PLAN_CONTRACT', '实得码 = plan 契约门（实得 ' + bad.code + '）');
  assert.notEqual(bad.code, 'GATE_EXIT_MISSING_PLAN', 'plan 层不会拿到层族重写码');

  // 结构性证据 1：`exit.js` 中 plan 委派语句**先于**层族重写语句
  const exitSrc = read('lib/state/gates/exit.js');
  const deleg = exitSrc.indexOf("if (t.layer === 'plan')");
  const rewrite = exitSrc.indexOf("'GATE_EXIT_MISSING_' + t.layer.toUpperCase()");
  assert.ok(deleg > 0 && rewrite > 0, '两条语句都必须在场（否则本用例的前提已变，须重评）');
  assert.ok(deleg < rewrite, 'plan 委派必须先于层族重写（前置早退 = 该层不可达的根本原因）');

  // 结构性证据 2：`GATE_EXIT_MISSING_PLAN` 在 lib 内**没有字面量发射点**（只能由拼接产生）
  const literalProducers = [];
  for (const rel of ['lib/state/gates/exit.js', 'lib/state/gates/plan-contract.js', 'lib/state/gates.js']) {
    if (read(rel).includes('GATE_EXIT_MISSING_PLAN')) literalProducers.push(rel);
  }
  assert.deepEqual(literalProducers, [], '若出现字面量发射点，说明该码变得可达 ⇒ 必须回来补真正的三层用例');

  // 同族近邻可达对照：PLAN 层**确有**自己的拒码面（不是「plan 层根本不设门」）
  const noDecl = gates.checkExitGate(SESS, BID, batchWith(base, [{ id: 'l', layer: 'plan' }]), 'l');
  assert.equal(noDecl.code, 'GATE_PLAN_NO_DECLARATION', 'plan 层零声明走自己的码（实得 ' + noDecl.code + '）');
  // 阳性对照：plan 产物在场且含六个裸标题 ⇒ 放行
  seed(root, 'plan/spec.md', SPEC_OK);
  const good = gates.checkExitGate(SESS, BID, batchWith(base, [{ id: 'l', layer: 'plan', produce: ['plan/spec.md'] }]), 'l');
  assert.equal(good.ok, true, '在场且合契约 ⇒ 放行（证明上一条不是「plan 门恒拒」）');
});

// ── ③ internal-only 档 ───────────────────────────────────────────────────────────────
test('A1-P2-13 / internal-only · GATE_NO_DECLARATION：直调 presenceJudge 空声明 ⇒ 该码（内部契约）', () => {
  const empty = presenceJudge({ declared: [] });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'GATE_NO_DECLARATION', '内部不可达分支的契约锚（internal-only）');
  assert.equal(empty.path, null);
  // 空白项被过滤后同样为空 ⇒ 同一分支
  const blank = presenceJudge({ declared: ['  '] });
  assert.equal(blank.code, 'GATE_NO_DECLARATION', '空白声明被过滤后走同一分支');
});

test('A1-P2-13 / internal-only · 生产不可达证伪：零声明 lane 走出口门拿到的是 GATE_EXIT_NO_DECLARATION', () => {
  const { gates, base } = exitFixture();
  // 坑 2：**不得**声明 standalone（那是零声明的唯一放行路径，会得到 ok:true 而非拒码）
  const r = gates.checkExitGate(SESS, BID, batchWith(base, [{ id: 'l', layer: 'exec' }]), 'l');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'GATE_EXIT_NO_DECLARATION', '生产路径由前置早退拦截（实得 ' + r.code + '）');
  assert.notEqual(r.code, 'GATE_NO_DECLARATION', '生产不可达 ⇒ 内部码不得从生产路径外显（否则就是可达，本档判定要重评）');
});
