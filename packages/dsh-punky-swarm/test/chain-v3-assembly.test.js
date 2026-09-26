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

// test/chain-v3-assembly.test.js —— **声明面 v3（装配图）** · W2（2026-09-16）
// ─────────────────────────────────────────────────────────────────────────────
// 范围：`lib/assembly/chain.js` 的 v3 声明面纯函数——`branches`（层内并行链：分支 id 逐字 = lane id）、
//   `pair_with`（= `perLane` 可读别名）、`template`（`${lane}`/`${branch}` 插值）、装配图展开与反投影。
//   实例化 / 推进语义仍归 `lib/engine/chain-runner.js`（本文件不涉）。
//
// 判据来源：`docs/w2-assembly-spec-20260916.md §2/§5/§7/§8`。
// 三条硬锁：
//   ① **v1/v2 语义逐字不变**：v1 声明 v3 三键 ⇒ 拒；v2 资产走既有路径，`CHAIN_VERSIONS` 只扩不改；
//   ② **零新造码**：V1–V10 逐条复用既有 `TEAM_ASSET_*`（本文件逐码断言）；
//   ③ **禁「写了不生效」**：`branches[].id` 逐字成为 lane id，且展开 lane 必须**反投影回来源步**。
//
// ⚠ 本批授权改动（Leader 裁决 A′）：`test/chain-v2-declaration.test.js` 的 `V2-2` 两行
//   （白名单镜像 `[1,2,3]`、非法集 `3` → `4`）——**下游耦合**，非放宽断言。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAIN_VERSIONS, validateChain, expandChainBranches, chainLanesOfStep, chainStepForLane,
  perLaneTargetOf, chainProblemsOf, CHAIN_V3_STEP_KEYS,
} from '../lib/assembly/chain.js';
import { loadTeamAsset } from '../lib/assembly/team-asset.js';
import { packageRoot } from '../lib/assembly/flows.js';

const LAYERS = {
  plan: { roles: ['coordinator', 'designer'] },
  exec: { roles: ['coder', 'tester', 'reviewer'] },
  audit: { roles: ['supervisor'] },
};

const codesOf = (problems) => problems.map((p) => p.code);

/** v3 参照模型（= `presets/software-team/team-asset.yml` 的 `chain` 同形）。 */
const v3Model = () => ({
  version: 3,
  steps: [
    {
      id: 'plan', layer: 'plan', role: 'coordinator',
      branches: [
        { id: 'plan-coordinator', role: 'coordinator', template: { cmd: '编排出任务树（${branch}）', produce: ['plan/task-tree.json'] } },
        { id: 'plan-designer', role: 'designer', template: { cmd: '产出规格（${branch}）', produce: ['plan/spec.md'] } },
      ],
      next: 'exec',
    },
    {
      id: 'exec', layer: 'exec', role: 'coder',
      branches: [
        { id: 'exec-coder', role: 'coder', template: { cmd: '实现变更（${branch}）', produce: ['exec/coder.md'] } },
        { id: 'exec-tester', role: 'tester', deps: ['exec-coder'], template: { cmd: '验证行为（${branch}）', produce: ['exec/tester.md'] } },
      ],
      next: 'audit-pair',
    },
    {
      id: 'audit-pair', layer: 'audit', role: 'supervisor', pair_with: 'exec',
      template: { id: 'audit-${lane}', cmd: '验收分支 ${lane} 的产物', produce: ['audit/${lane}.md'] },
      next: 'accept',
    },
    { id: 'accept', layer: 'audit', role: 'supervisor', join: 'all', terminal: true, template: { cmd: '逐条判据对照', produce: ['audit/acceptance-report.md'] } },
  ],
  join: { anyFailure: 'pause' },
  onFail: 'pause',
});

test('W2-V3-1 装配图参照模型：一次过 validateChain（可达性 / terminal 唯一 / 角色齐备）', () => {
  const r = validateChain(v3Model(), LAYERS);
  assert.deepEqual(r.problems, [], '参照模型必须零问题：' + JSON.stringify(r.problems));
  assert.equal(r.ok, true);
  assert.deepEqual([...CHAIN_VERSIONS], [1, 2, 3], '版本白名单 = [1,2,3]（规格 §5 修订①）');
  assert.deepEqual([...CHAIN_V3_STEP_KEYS], ['branches', 'pair_with', 'template']);
});

test('W2-V3-2 包内资产：software-team 【无 chain】（最小骨架）⇒ chain=null 且 ok，且 chain 校验面在夹具上仍通过', () => {
  const asset = loadTeamAsset(packageRoot(), 'software-team');
  assert.equal(asset.ok, true, '资产加载期零问题：' + JSON.stringify(asset.problems));
  // 注（2026-09-26 团队资产瘦身，用户裁决「团队内容改为模版、不再作为组件」）：
  //   `software-team` 现为 **859 B 最小骨架**，**不含 `chain`** ⇒ `chainProblemsOf` 应回
  //   `{ chain: null, problems: [], ok: true }`（`chain.js`：「资产无 chain ⇒ chain:null」= 无推进，向后兼容锁）。
  //   ⇒ 断言由「必须有 chain.version=3」改为「**无 chain 亦为合法态**」；
  //     「chain v3 能一次过 validateChain」的覆盖由本文件其余夹具用例承担（不丢面）。
  assert.equal(asset.asset.chain, undefined, 'software-team 最小骨架不得声明 chain');
  const c = chainProblemsOf(asset.asset);
  assert.deepEqual(c.problems, [], '无 chain ⇒ 零问题：' + JSON.stringify(c.problems));
  assert.equal(c.ok, true);
  assert.equal(c.chain, null, '无 chain ⇒ chain=null（引擎既约定）');
});

test('W2-V3-3 展开 ⇒ 分支 id 逐字成为 lane id + 配对 1:1（`${lane}` 插值）+ 反投影全中', () => {
  const chain = v3Model();
  const e = expandChainBranches(chain);
  assert.deepEqual(e.problems, [], JSON.stringify(e.problems));
  assert.deepEqual(e.lanes.map((l) => l.id), [
    'plan-coordinator', 'plan-designer', 'exec-coder', 'exec-tester',
    'audit-exec-coder', 'audit-exec-tester', 'accept',
  ], '分支 id 逐字 = lane id；配对 lane id = `${lane}` 插值结果');
  // 配对 1:1：deps 恰为 [上游 lane]（pairedLaneOf 判据的唯一真源）
  const pairLane = e.lanes.find((l) => l.id === 'audit-exec-tester');
  assert.deepEqual(pairLane.deps, ['exec-tester'], '配对 lane 的 deps 恰为一条 = 上游 lane');
  assert.equal(pairLane.cmd.includes('exec-tester'), true, '${lane} 已插值为上游 lane id');
  assert.deepEqual(pairLane.produce, ['audit/exec-tester.md'], 'produce 同步插值（禁同名撞车）');
  assert.equal(e.lanes.find((l) => l.id === 'exec-tester').deps.includes('exec-coder'), true, '同层有向（branches[].deps）保留');
  // 反投影：每条 lane 映射回其来源步（禁「写了不生效」）
  const tasks = e.lanes.map((l) => ({ id: l.id, layer: l.layer, role: l.role, deps: l.deps }));
  for (const l of e.lanes) {
    const m = chainStepForLane(chain, l.id, { layer: l.layer, role: l.role });
    assert.equal(m.ok, true, `${l.id} 映射不得歧义`);
    assert.equal(m.step?.id, l.stepId, `${l.id} 必须反投影到来源步 ${l.stepId}（实际 ${m.step?.id ?? '链外'}）`);
  }
  assert.deepEqual(chainLanesOfStep(chain, 'exec', tasks).lanes, ['exec-coder', 'exec-tester']);
  assert.deepEqual(chainLanesOfStep(chain, 'audit-pair', tasks).lanes, ['audit-exec-coder', 'audit-exec-tester']);
  assert.deepEqual(chainLanesOfStep(chain, 'accept', tasks).lanes, ['accept']);
});

test('W2-V3-4 硬锁①：v1 声明 v3 三键 ⇒ 逐键 FIELD_NOT_ALLOWED（不静默忽略）', () => {
  for (const key of ['branches', 'pair_with', 'template']) {
    const c = v3Model();
    c.version = 1;
    const r = validateChain(c, LAYERS);
    assert.equal(r.ok, false, `v1 + ${key} 必须拒`);
    assert.equal(codesOf(r.problems).includes('TEAM_ASSET_FIELD_NOT_ALLOWED'), true, `${key} ⇒ FIELD_NOT_ALLOWED`);
  }
});

test('W2-V3-5 V2：branches 空数组 / 分支 id 重复 / 与 steps[].id 撞名 ⇒ MISSING_FIELD', () => {
  const empty = v3Model();
  empty.steps[0].branches = [];
  assert.equal(codesOf(validateChain(empty, LAYERS).problems).includes('TEAM_ASSET_MISSING_FIELD'), true, '空数组');

  const dup = v3Model();
  dup.steps[0].branches[1].id = 'plan-coordinator';
  assert.equal(codesOf(validateChain(dup, LAYERS).problems).includes('TEAM_ASSET_MISSING_FIELD'), true, '分支 id 重复');

  const clash = v3Model();
  clash.steps[0].branches[1].id = 'accept';
  const r3 = validateChain(clash, LAYERS);
  assert.equal(codesOf(r3.problems).includes('TEAM_ASSET_MISSING_FIELD'), true, '与 steps[].id 撞名');
  assert.equal(r3.problems.some((p) => String(p.message).includes('撞名')), true, '文案须点明撞名');
});

test('W2-V3-6 V3：配对步 template 缺 `${lane}`（id / cmd / produce 任一）⇒ MISSING_FIELD', () => {
  for (const mutate of [
    (t) => { delete t.id; },
    (t) => { t.cmd = '验收该分支的产物'; },
    (t) => { t.produce = ['audit/report.md']; },
  ]) {
    const c = v3Model();
    mutate(c.steps[2].template);
    const r = validateChain(c, LAYERS);
    assert.equal(r.ok, false, '缺 `${lane}` 必须拒：' + JSON.stringify(c.steps[2].template));
    assert.equal(codesOf(r.problems).includes('TEAM_ASSET_MISSING_FIELD'), true, '码 = MISSING_FIELD');
  }
});

test('W2-V3-7 V4：非配对步用 `${lane}` / 未知插值 / 裸表达式 ⇒ FIELD_NOT_ALLOWED', () => {
  const nonPair = v3Model();
  nonPair.steps[3].template.cmd = '核对 ${lane} 的产物';
  assert.equal(codesOf(validateChain(nonPair, LAYERS).problems).includes('TEAM_ASSET_FIELD_NOT_ALLOWED'), true, '非配对步禁 ${lane}');

  const unknownVar = v3Model();
  unknownVar.steps[0].branches[0].template.cmd = '编排 ${step} 的任务树';
  assert.equal(codesOf(validateChain(unknownVar, LAYERS).problems).includes('TEAM_ASSET_FIELD_NOT_ALLOWED'), true, '未知插值变量');

  const expr = v3Model();
  expr.steps[0].branches[0].template.cmd = '编排 ${branch} + 1 == 2 的任务树';
  assert.equal(codesOf(validateChain(expr, LAYERS).problems).includes('TEAM_ASSET_FIELD_NOT_ALLOWED'), true, '禁表达式');
});

test('W2-V3-8 V5：pair_with + perLane 同声明 / 悬空 / 自指 ⇒ MISSING_FIELD', () => {
  const both = v3Model();
  both.steps[2].perLane = 'exec';
  assert.equal(codesOf(validateChain(both, LAYERS).problems).includes('TEAM_ASSET_MISSING_FIELD'), true, '禁双真源');

  const dangling = v3Model();
  dangling.steps[2].pair_with = 'ghost';
  assert.equal(codesOf(validateChain(dangling, LAYERS).problems).includes('TEAM_ASSET_MISSING_FIELD'), true, '悬空目标');

  const self = v3Model();
  self.steps[2].pair_with = 'audit-pair';
  assert.equal(codesOf(validateChain(self, LAYERS).problems).includes('TEAM_ASSET_MISSING_FIELD'), true, '自指');
});

test('W2-V3-9 V7：分支角色悬空 ⇒ LEAD_NOT_IN_LAYERS；层未知 ⇒ LAYER_UNKNOWN（层先于角色）', () => {
  const badRole = v3Model();
  badRole.steps[0].branches[1].role = 'supervisor';
  const r1 = validateChain(badRole, LAYERS);
  assert.equal(codesOf(r1.problems).includes('TEAM_ASSET_LEAD_NOT_IN_LAYERS'), true, '分支角色须在本层 roles');

  const badLayer = v3Model();
  badLayer.steps[0].layer = 'review';
  const r2 = validateChain(badLayer, LAYERS);
  assert.equal(codesOf(r2.problems).includes('TEAM_ASSET_LAYER_UNKNOWN'), true, '层白名单先判');
});

test('W2-V3-10 V10：分支不是步 ⇒ 不占 terminal 位；缺 terminal ⇒ 照旧唯一性判据报错', () => {
  const ok = v3Model();
  assert.equal(validateChain(ok, LAYERS).ok, true, '分支存在不影响 terminal 唯一性');
  const twoTerminals = v3Model();
  twoTerminals.steps[0].terminal = true;
  assert.equal(codesOf(validateChain(twoTerminals, LAYERS).problems).includes('TEAM_ASSET_MISSING_FIELD'), true, '两个 terminal ⇒ MISSING_FIELD');
  const none = v3Model();
  none.steps[3].terminal = false;
  assert.equal(codesOf(validateChain(none, LAYERS).problems).includes('TEAM_ASSET_MISSING_FIELD'), true, '零 terminal ⇒ MISSING_FIELD');
});

test('W2-V3-11 可达性：pair_with 隐式入边计入（上游不写 next 也不得报孤儿步）', () => {
  const c = v3Model();
  delete c.steps[1].next; // exec 不写 next，只靠 audit-pair 的 pair_with 挂回来
  c.steps[2].next = 'accept';
  c.steps[3].terminal = true;
  const r = validateChain(c, LAYERS);
  assert.equal(r.ok, true, 'pair_with 隐式入边须计入可达性：' + JSON.stringify(r.problems));
});

test('W2-V3-12 pair_with 别名读端：perLaneTargetOf 同时命中 perLane 与 pair_with（漏加 = 运行期静默失效）', () => {
  const c = v3Model();
  assert.equal(perLaneTargetOf(c, 'exec')?.id, 'audit-pair', 'pair_with 必须命中');
  assert.equal(perLaneTargetOf(c, 'plan'), null, '无配对后继 ⇒ null');
  const v2 = { version: 2, steps: [{ id: 'exec' }, { id: 'audit', perLane: 'exec' }] };
  assert.equal(perLaneTargetOf(v2, 'exec')?.id, 'audit', 'perLane 语义逐字不变');
});

test('W2-V3-13 反例 R3：pair_with 指同层下游步 ⇒ 成环 ⇒ REWORK_INVALID（无 rework 承认即拒）', () => {
  const c = v3Model();
  delete c.rework;
  c.steps[2].pair_with = 'accept'; // 下游步 ⇒ 与 accept 的入边成环
  const r = validateChain(c, LAYERS);
  // 【R2-3 裁决 B（2026-09-17）改语义】原断言 `assert.equal(r.ok, false, '成环必须拒')` 已随新语义反转：
  //   `ok = 无 blocking`，`TEAM_ASSET_REWORK_INVALID` ∈ warning 侧 ⇒ 成环报 `ok:true` + problems 非空。
  //   按纪律「不得削弱既有断言」：① 断言翻转 + ② 显式补 problems 非空（旧断言由 ok 隐含）
  //   + ③ 码面断言（REWORK_INVALID）逐字保留。
  assert.equal(r.ok, true, '新语义：仅 warning（REWORK_INVALID）⇒ ok:true（旧语义此处 false）');
  assert.ok(r.problems.length > 0, 'warning 必须**完整保留**在 problems（不得丢弃、不得降级为日志）');
  assert.equal(codesOf(r.problems).includes('TEAM_ASSET_REWORK_INVALID'), true, '须报 REWORK_INVALID：' + JSON.stringify(r.problems));
});

// ── R2-3（裁决 B）ok 语义：`ok = 无 blocking` ──────────────────────────────────
// 背景：旧语义 `ok = problems.length === 0` 与 `team-asset.js` 的 BLOCKING_CODES 分档不自洽——
//   本组八条校验里 `LEAD_NOT_IN_LAYERS` / `REWORK_INVALID` 是 **warning** 级（chain.js:70-73 已登记），
//   却被旧 `ok` 判成「链不可用」。新语义 = 只有 blocking 否决，warning 只提示（problems 逐条保留）。
test('R2-3-1 仅 warning ⇒ ok=true 且 problems **非空**（warning 不丢弃、不降级为日志）', () => {
  // warning 来源①：步角色悬空（TEAM_ASSET_LEAD_NOT_IN_LAYERS ∈ warning 侧）
  const badRole = v3Model();
  badRole.steps[0].branches[1].role = 'supervisor';
  const r1 = validateChain(badRole, LAYERS);
  assert.equal(r1.ok, true, '仅 warning ⇒ ok:true：' + JSON.stringify(r1.problems));
  assert.ok(r1.problems.length > 0, 'problems 必须非空');
  assert.equal(r1.problems.every((p) => p.severity === 'warning'), true, '逐条须带 severity=warning');
  assert.equal(codesOf(r1.problems).includes('TEAM_ASSET_LEAD_NOT_IN_LAYERS'), true, '码面原样保留');
  // warning 来源②：无 rework 承认的回边（TEAM_ASSET_REWORK_INVALID ∈ warning 侧）
  const cyc = v3Model();
  delete cyc.rework;
  cyc.steps[2].pair_with = 'accept';
  const r2 = validateChain(cyc, LAYERS);
  assert.equal(r2.ok, true, '仅 warning（成环）⇒ ok:true：' + JSON.stringify(r2.problems));
  assert.ok(r2.problems.length > 0, 'problems 必须非空');
  assert.equal(codesOf(r2.problems).includes('TEAM_ASSET_REWORK_INVALID'), true, '码面原样保留');
});

test('R2-3-2 存在 blocking ⇒ ok=false（且 warning 与 blocking 并存时以 blocking 为准）', () => {
  // 悬空 next = TEAM_ASSET_MISSING_FIELD ∈ BLOCKING_CODES
  const dangling = v3Model();
  dangling.steps[0].next = 'ghost';
  const d = validateChain(dangling, LAYERS);
  assert.equal(d.ok, false, 'blocking ⇒ ok:false：' + JSON.stringify(d.problems));
  assert.equal(d.problems.some((p) => p.severity === 'blocking'), true, '须确有 blocking 条目');
  // 层未知（LAYER_UNKNOWN）：**【2026-09-18 K-2 用户裁决】已退出 BLOCKING_CODES ⇒ warning 级**
  //   ⇒ **不否决**（ok:true），但**码面与严重级留痕保留**（不得以「删断言」了事：本组三条断言取代原单条 ok:false）
  const badLayer = v3Model();
  badLayer.steps[0].layer = 'review';
  const bl = validateChain(badLayer, LAYERS);
  assert.equal(bl.ok, true, 'K-2：未知层不再拒载（warning 级）');
  assert.equal(codesOf(bl.problems).includes('TEAM_ASSET_LAYER_UNKNOWN'), true, 'K-2：码面保留（留痕可读）');
  assert.equal(bl.problems.every((p) => p.severity !== 'blocking'), true, 'K-2：该例不得含 blocking 条目');
  // blocking + warning 并存：仍以 blocking 否决，且 warning **不被吞掉**
  const mixed = v3Model();
  mixed.steps[0].next = 'ghost';            // blocking
  mixed.steps[0].branches[1].role = 'supervisor'; // warning
  const m = validateChain(mixed, LAYERS);
  assert.equal(m.ok, false, 'blocking 与 warning 并存 ⇒ 仍拒：' + JSON.stringify(m.problems));
  assert.equal(codesOf(m.problems).includes('TEAM_ASSET_MISSING_FIELD'), true, 'blocking 条目在场');
  assert.equal(codesOf(m.problems).includes('TEAM_ASSET_LEAD_NOT_IN_LAYERS'), true, '共存 warning 不得被吞');
});

test('R2-3-3 `chainProblemsOf` 同口径：resolved 面与 validate 面问题并集后按 blocking 判 ok', () => {
  // 仅 warning 面：`flows.chain` 位非法 = FIELD_NOT_ALLOWED ∈ blocking ⇒ 拒（回归锁：非规范位仍拒）
  const r = chainProblemsOf({ chain: v3Model(), flows: { chain: v3Model() }, layers: LAYERS });
  assert.equal(r.ok, false, '`flows.chain` 非规范位（FIELD_NOT_ALLOWED=blocking）⇒ 仍拒');
  assert.equal(codesOf(r.problems).includes('TEAM_ASSET_FIELD_NOT_ALLOWED'), true, '码面不变');
  // 仅 warning（成环）：ok:true 且问题逐条保留
  const cyc = v3Model();
  delete cyc.rework;
  cyc.steps[2].pair_with = 'accept';
  const w = chainProblemsOf({ chain: cyc, layers: LAYERS });
  assert.equal(w.ok, true, '仅 warning ⇒ ok:true：' + JSON.stringify(w.problems));
  assert.ok(w.problems.length > 0, 'problems 必须非空');
  assert.equal(codesOf(w.problems).includes('TEAM_ASSET_REWORK_INVALID'), true, '码面原样保留');
  assert.equal(w.chain != null, true, 'ok:true ⇒ chain 照常返回（读端不因 warning 退化为无链）');
});

test('W2-V3-14 归属面隔离：v3 步不靠 (layer,role) 兜底 —— 普通手工 lane 不得被「顺手捕获」', () => {
  const chain = v3Model();
  for (const [id, layer, role] of [['e1', 'exec', 'coder'], ['a1', 'audit', 'supervisor'], ['p1', 'plan', 'designer']]) {
    const m = chainStepForLane(chain, id, { layer, role });
    assert.equal(m.step, null, `${id}（${layer}/${role}）必须判链外（v3 只认展开规则）`);
    assert.equal(m.ok, true, '链外不是歧义（不得停轮）');
  }
  assert.equal(chainStepForLane(chain, 'exec-coder', { layer: 'exec', role: 'coder' })?.step?.id, 'exec', '分支 id 命中来源步');
});
