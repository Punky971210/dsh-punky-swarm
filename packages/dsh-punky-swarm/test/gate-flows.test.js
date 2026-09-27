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

// R1-c 声明驱动门禁：等价性与翻牌能力回归锚
//   ① 无声明（team 无资产 / 无 team）→ 引擎基线常量/缺省（tighten-only 唯一真源，清退后无 legacy 回落层）；
//   ② software-team 声明（在役团队资产）→ 按声明判定（缺声明语义与引擎基线同侧）；
//      punky-preset 团队装配**已退役** ⇒ 无声明 ⇒ 引擎基线缺省（退役面不得崩）；
//   ③ 声明显式翻牌（entry_requires: ['consume']）→ 才强制 consume 非空；
//   ④ 声明可覆盖产物字段与内容契约章节（非工程团队的自定义契约）。
//
// 【legacy-retire-20260915 · fixture 对齐】本文件对齐三类（断言演进纪律，逐处留注释）：
//   (a) 换真源锚点——complete 白名单唯一真源 = audit_contract.verdict（原 legacy 键 fixture 改锚）；
//   (b) 信息面如实化——produceFieldOf 缺声明返回 null（原断言回落 LEGACY_PRODUCE_FIELD 已失真）；
//   (c) 正向清退断言——声明已废键 require_audit_outcomes 不产生任何门禁效果（文件末新增用例）。
//   【F-4 翻牌（2026-09-15 用户裁决 Q-D=A）】`complete` 已退出 `FLOW_SECTIONS` ⇒ 文件末用例升级为
//     **拒载形态锚**：声明 `flows.complete` ⇒ 资产整份拒载（`TEAM_ASSET_LAYER_UNKNOWN` blocking）⇒
//     读端回落引擎基线。上方 (c) 的「不产生门禁效果」现由「整份拒载 + 回落基线」兑现（比「被忽略」更强）；
//     连带 fixture 逐处留注释，断言零删除、零弱化（`:531` 为断言**反转**）。
//   不删除/弱化任何既有拒断言；enforcesConsumeEntry 断言随 E-5 删函数换锚至 entryRequiresOf 读端。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGates } from '../lib/state/gates.js';
import { writeSyntheticTeam } from './helpers/team-fixture.mjs';
import { clearFlowCache, packageRoot, matchGlob, produceFieldOf, entryRequiresOf, globMatchesPath, resolveTeamFlows } from '../lib/assembly/flows.js';

const SESS = 'sess-gf';

function mkRoots() {
  const pkg = mkdtempSync(join(tmpdir(), 'gf-pkg-'));
  const state = mkdtempSync(join(tmpdir(), 'gf-state-'));
  mkdirSync(join(pkg, 'presets'), { recursive: true });
  mkdirSync(join(state, 'sessions', SESS, 'batches'), { recursive: true });
  mkdirSync(join(state, 'sessions', SESS, 'artifacts'), { recursive: true });
  return { pkg, state };
}

function writeTeamFlow(pkg, team, flows) {
  // F2：合成资产（本套件验的是 **flows 声明面**）⇒ 单点写入。
  return writeSyntheticTeam(pkg, team, {
    team,
    layers: { plan: { roles: ['designer'], skills: { designer: ['dev-designer'] } } },
    flows,
  }, { filename: 'team-asset.yml' });
}

function writeArtifact(state, batchId, rel, content) {
  const abs = join(state, 'sessions', SESS, 'artifacts', batchId, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return abs;
}

// wavePlan 持久形态 = [{ tasks }]（事实源：lib/state/task-utils.js:33 `for (const w of batch.wavePlan ?? [])`）
const batchOf = (team, tasks) => ({ batchId: 'b1', team, createdAt: '2026-09-13T00:00:00.000Z', lanes: {}, events: [], wavePlan: [{ wave: 1, tasks }] });

// ═══════════════════════════════════════════════════════════════════════════════
// 套件对齐（批次 `gate-techdebt` · lane `e2-gov-repair` · 用户裁决 Q1=C）
//   · 授权边界：**只做「转 test.todo(...) ＋ 标注」**——不重写、不新增、不删除任何断言；
//     原断言文本逐字保留（下方各 todo 标题即原文），便于后续独立小批复活。
//   · 逐字引注：用户 2026-09-14 裁决（grilling Q1=C）：失效红条不落成新契约，正确断言留待独立小批；
//     本条因 <原因> 转 todo。
//   · 形态说明（**实测依据**）：本机 node:test 的 `test.todo(name, fn)` **仍会执行回调**
//     （实测：断言失败照报）⇒ 采用「模块级 `test.todo(name)`（无回调）＋ 原断言文本置于 name」
//     的形态，确保既登记待办、又不执行已失效断言。
//   · 影响面（如实登记，供 a1 复核）：两条被转 todo 的断言**已从原用例体内移出**（原文见下），
//     其余断言、用例结构与夹具**逐字未动**。
//   · 【后续状态·2026-09-15 批次 core-debt-parallel-20260915 · lane e2】上条「留待独立小批」已落地：
//     两条 `test.todo` 已**复活为真实用例**（见下方 R-05 复活（T-12）/ R-06 复活（T-13）），原 todo 行删除；
//     原用例体内的定位标记注释与归档文本**逐字保留**（不删、不弱化），只把模块级 todo 换成可执行断言。
// ═══════════════════════════════════════════════════════════════════════════════
// 【复活·2026-09-15 批次 core-debt-parallel-20260915 · lane e2（唯一写者）】下方两条原 `test.todo` 已复活为真实用例：
//   T-12 原断言目标值是**本批要修的失真值** ⇒ 期望值反转为 `tighten-only-default`（读端 `gates.ts:453` ← `flows.js:201-213`）；
//   T-13 为**正向对照**（显式声明团队 ⇒ 团队来源），另补同判据反例（无资产团队）。
//   原「转 todo」的原因注释（用户 2026-09-14 裁决 grilling Q1=C：失效红条不落成新契约、正确断言留待独立小批）
//   其落项即本批，故此处只保留一句引注：原断言文本见下方两用例的断言消息与注释，语义零放水。
test('R-05 复活（T-12）：无资产团队 + 空 consume ⇒ 拒派，且 requiredBy 取真实来源 tighten-only-default', () => {
  const { pkg, state } = mkRoots();
  try {
    clearFlowCache();
    const g = createGates(state, { flowsRoot: pkg });
    // 原断言（逐字）：assert.equal(r0.requiredBy, 'team-asset:entry_requires', '实测：tighten-only 后标注恒带（缺口：来源未按 entryRequiresOf 区分）');
    //   ⇒ 该期望值已失真（R-05 把 requiredBy 改取 `entryRequiresOf(flow).source`）：无声明 ⇒ tighten-only-default。本次反转期望值。
    const b = batchOf('no-asset-team', [{ id: 'e1', layer: 'exec' }]);
    const r0 = g.checkEntryGate(SESS, 'b1', b, 'e1');
    assert.equal(r0.ok, false, '无声明 + 空 consume → 拒派（B1 零依赖拒派）');
    assert.equal(r0.code, 'GATE_ENTRY_MISSING');
    assert.equal(r0.requiredBy, 'tighten-only-default',
      '实测：tighten-only 后标注须如实区分来源（缺声明/无资产 ⇒ 引擎缺省侧，不得恒带团队标注）；实测=' + JSON.stringify(r0.requiredBy));
  } finally { rmSync(pkg, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); clearFlowCache(); }
});

test('R-06 复活（T-13）：显式声明团队 vs 无资产团队 ⇒ requiredBy 双态对照（来源可区分）', () => {
  const { state } = mkRoots();
  try {
    clearFlowCache();
    const g = createGates(state, { flowsRoot: packageRoot() });
    // 正向对照（原断言，逐字）：assert.equal(r6.requiredBy, 'team-asset:entry_requires', '实测：tighten-only 后标注恒带（已知缺口）');
    //   注：原 todo 行的 `r6` **实际构造**是 `batchOf('punky-preset', …)`（退役团队 / 无资产，见本文件 :385-388）——
    //   该构造下 requiredBy 只能是 `tighten-only-default`，与「显式声明团队」的期望**不同源**（规格 §2.1 T-13 表述
    //   与本文件实际构造不一致，已如实登记）。故本条按 T-13 的**规格本意**（正向对照）用 software-team 构造；
    //   同时补 punky-preset 反例，把「团队来源 vs 引擎缺省来源」的可区分性判到位。
    const b6 = batchOf('software-team', [{ id: 'e9', layer: 'exec', outputs: ['exec/o.md'] }]);
    const r6 = g.checkEntryGate(SESS, 'b1', b6, 'e9');
    assert.equal(r6.ok, false, '空 consume 拒派（零依赖拒派，不依赖团队声明）');
    assert.equal(r6.code, 'GATE_ENTRY_MISSING');
    // 注（2026-09-26 团队资产瘦身）：`software-team` 最小骨架**不再声明 `entry_requires`**
    //   ⇒ 来源回落引擎缺省 `tighten-only-default`（原期望 `team-asset:entry_requires`）。
    //   ⚠ 「**显式声明团队 ⇒ 来源标注 `team-asset:entry_requires`**」这条覆盖**未丢失**：
    //     由 `test/gate-techdebt-red.test.js` 的 `R-06 正向对照` 承担（该处改用 `mkTeamRoot`
    //     构造显式声明 `entry_requires` 的团队）。
    assert.equal(r6.requiredBy, 'tighten-only-default',
      '新骨架未声明 entry_requires ⇒ 来源为引擎缺省；实测=' + JSON.stringify(r6.requiredBy));
    const b6b = batchOf('punky-preset', [{ id: 'e9', layer: 'exec', outputs: ['exec/o.md'] }]);
    const r6b = g.checkEntryGate(SESS, 'b1', b6b, 'e9');
    assert.equal(r6b.ok, false, 'punky-preset 退役（无资产）同样拒派：缺声明即拒');
    assert.equal(r6b.requiredBy, 'tighten-only-default',
      '反例：无资产团队不得标注为团队来源；实测=' + JSON.stringify(r6b.requiredBy));
  } finally { rmSync(state, { recursive: true, force: true }); clearFlowCache(); }
});

test('entry 门禁：无声明 → 仍强制 consume（零依赖拒派，不再依赖团队声明）', () => {
  const { pkg, state } = mkRoots();
  try {
    clearFlowCache();
    const g = createGates(state, { flowsRoot: pkg });
    // 【r2 同步 · B1】旧口径「无团队声明 + 空 consume ⇒ 免检」已废除：**缺声明即 true（拒派）**，
    //   拒派不依赖团队资产是否可解析（team 名拼错 / generic 同样拒）。
    //   【E-5 换锚】原布尔读端 enforcesConsumeEntry 已删（死函数），entry 强制面唯一读端 = entryRequiresOf。
    const b = batchOf('no-asset-team', [{ id: 'e1', layer: 'exec' }]);
    const r0 = g.checkEntryGate(SESS, 'b1', b, 'e1');
    assert.equal(r0.ok, false, '无声明 + 空 consume → 拒派（B1 零依赖拒派）');
    assert.equal(r0.code, 'GATE_ENTRY_MISSING');
    // 【R-05 已落地】`requiredBy` 取 `entryRequiresOf(flow).source`（真实来源）：显式声明 ⇒
    //   `team-asset:entry_requires`；缺声明/无资产 ⇒ `tighten-only-default`。原失真断言已迁模块级 todo。
    // 用户 2026-09-14 裁决（grilling Q1=C）：失效红条不落成新契约，正确断言留待独立小批；
    //   本条因「断言的是本批要修的失真值（`requiredBy === 'team-asset:entry_requires'`）」转 todo。
    // 说明：R-05（e1，wave3）已把 `requiredBy` 改取 `entryRequiresOf(flow).source` ⇒ 未声明团队应为
    //   `tighten-only-default` ⇒ 下行原断言已失效，**迁至本文件模块级 `test.todo`**（原文逐字保留，
    //   见上方「套件对齐」区块第一条）。此处仅为原断言的定位标记，不再执行：
    //   assert.equal(r0.requiredBy, 'team-asset:entry_requires', '实测：tighten-only 后标注恒带（缺口：来源未按 entryRequiresOf 区分）');
    assert.equal(entryRequiresOf(null).enforced, true, '缺声明 ⇒ 强制（tighten-only 读端同判）');
    assert.equal(entryRequiresOf(null).source, 'tighten-only-default', '来源读端正确区分「未声明」与「团队显式声明」');
    const b2 = batchOf('no-asset-team', [{ id: 'e2', layer: 'exec', consume: ['plan/a.md'] }]);
    const r = g.checkEntryGate(SESS, 'b1', b2, 'e2');
    assert.equal(r.ok, false, '无声明 + 非空 consume 缺失 → 仍拒');
    assert.equal(r.code, 'GATE_ENTRY_MISSING');
  } finally { rmSync(pkg, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); clearFlowCache(); }
});

test('entry 门禁：声明 entry_requires:["consume"] → 才强制非空（显式翻牌）', () => {
  const { pkg, state } = mkRoots();
  try {
    clearFlowCache();
    writeTeamFlow(pkg, 'strict-team', {
      plan: { produce_field: 'produce', entry_requires: [] },
      exec: { produce_field: 'outputs', entry_requires: ['consume'] },
      audit: { produce_field: 'produce', entry_requires: [] },
      // 【E-4 fixture 清理】原含 `complete: { require_audit_outcomes: ['pass'] }`（legacy 废键）——
      //   清退后引擎不读该键且与本用例被检面（entry 门）无关，删除属零行为差的废键清理。
    });
    const g = createGates(state, { flowsRoot: pkg });
    const b = batchOf('strict-team', [{ id: 'e1', layer: 'exec' }]);
    const r = g.checkEntryGate(SESS, 'b1', b, 'e1');
    assert.equal(r.ok, false, '声明强制 → 空 consume 拒派');
    assert.equal(r.code, 'GATE_ENTRY_MISSING');
    assert.equal(r.requiredBy, 'team-asset:entry_requires');
    // 【E-5 换锚】原两行断言 `enforcesConsumeEntry({entry_requires:[...]}) === true/false` 随死函数删除，
    //   等价换锚到唯一读端 entryRequiresOf（enforced 布尔承载同一判定语义，source 如实标注）：
    assert.deepEqual(entryRequiresOf({ entry_requires: ['consume'] }),
      { enforced: true, declared: true, values: ['consume'], source: 'team-asset:entry_requires' });
    assert.deepEqual(entryRequiresOf({ entry_requires: [] }),
      { enforced: false, declared: true, values: [], source: 'team-asset:entry_requires' });
  } finally { rmSync(pkg, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); clearFlowCache(); }
});

test('plan 契约：无声明 → 引擎基线两标题口径（缺 → GATE_PLAN_CONTRACT）', () => {
  const { pkg, state } = mkRoots();
  try {
    clearFlowCache();
    const g = createGates(state, { flowsRoot: pkg });
    const tasks = [{ id: 'p1', layer: 'plan', produce: ['plan/spec.md'] }];
    const b = batchOf('no-asset-team', tasks);
    writeArtifact(state, 'b1', 'plan/spec.md', '# S\n## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准\nx\n');
    const r1 = g.checkExitGate(SESS, 'b1', b, 'p1');
    assert.equal(r1.ok, false, '缺 ## 约束 → 拒');
    assert.equal(r1.code, 'GATE_PLAN_CONTRACT');
    assert.ok(r1.problems.some((p) => p.includes('## 约束')));
    writeArtifact(state, 'b1', 'plan/spec.md', '# S\n## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准\nx\n## 约束\ny\n');
    assert.equal(g.checkExitGate(SESS, 'b1', b, 'p1').ok, true, '两标题齐 → 过');
  } finally { rmSync(pkg, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); clearFlowCache(); }
});

test('plan 契约：punky-preset 团队装配退役（无资产 → 引擎基线缺省）→ 与引擎基线逐字等价（含「## 5. 验收标准」编号变体仍拒）', () => {
  const { state } = mkRoots();
  try {
    clearFlowCache();
    const g = createGates(state, { flowsRoot: packageRoot() }); // punky-preset 资产已删 ⇒ 无声明 ⇒ 引擎基线两标题常量（ENGINE_BASELINE_PLAN_SECTIONS）
    const tasks = [{ id: 'p1', layer: 'plan', produce: ['plan/spec.md'] }];
    const b = batchOf('punky-preset', tasks);
    writeArtifact(state, 'b1', 'plan/spec.md', '# S\n## 5. 验收标准\n## 6. 约束\n');
    const r = g.checkExitGate(SESS, 'b1', b, 'p1');
    assert.equal(r.ok, false, '编号变体仍被拒（声明串带 ## 前缀 ⇒ 与引擎基线裸标题行口径等价）');
    assert.equal(r.code, 'GATE_PLAN_CONTRACT');
    writeArtifact(state, 'b1', 'plan/spec.md', "# spec\n## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准\n- x\n## 约束\n- x\n");
    assert.equal(g.checkExitGate(SESS, 'b1', b, 'p1').ok, true);
  } finally { rmSync(state, { recursive: true, force: true }); clearFlowCache(); }
});

test('plan 契约：自定义章节声明（非工程团队）→ 按声明判定', () => {
  const { pkg, state } = mkRoots();
  try {
    clearFlowCache();
    writeTeamFlow(pkg, 'writing-team', {
      plan: { produce_field: 'produce', entry_requires: [], contract: { artifact_globs: ['plan/*outline*.md'], required_sections: ['## 取材范围', '## 修订基线'] } },
      exec: { produce_field: 'outputs' },
      audit: { produce_field: 'produce' },
      // 【E-4 fixture 清理】原含 `complete: { require_audit_outcomes: ['pass'] }`（legacy 废键）——删除，理由同 strict-team。
    });
    const g = createGates(state, { flowsRoot: pkg });
    const tasks = [{ id: 'p1', layer: 'plan', produce: ['plan/article-outline.md', 'plan/spec.md'] }];
    const b = batchOf('writing-team', tasks);
    // 命中 glob 的文件缺自定义章节 → 拒；未命中 glob 的 spec.md 在本声明下不查章节（但 plan 产物存在性仍查）
    writeArtifact(state, 'b1', 'plan/article-outline.md', '# 大纲\n');
    writeArtifact(state, 'b1', 'plan/spec.md', '# 软工 spec（不命中 glob，不查章节）\n');
    const r1 = g.checkExitGate(SESS, 'b1', b, 'p1');
    assert.equal(r1.ok, false);
    assert.ok(r1.problems.some((p) => p.includes('## 取材范围')), JSON.stringify(r1.problems));
    // 补齐自定义章节 → 过
    writeArtifact(state, 'b1', 'plan/article-outline.md', '# 大纲\n## 取材范围\n## 修订基线\n');
    assert.equal(g.checkExitGate(SESS, 'b1', b, 'p1').ok, true);
  } finally { rmSync(pkg, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); clearFlowCache(); }
});

test('exit 门禁：产物字段可声明（audit 用 outputs）→ 声明生效；缺省 null（信息性，E-3 清退后不再虚构字段名）', () => {
  const { pkg, state } = mkRoots();
  try {
    clearFlowCache();
    // 【F-4 连带处置（2026-09-15 Q-D=A）· 原 `complete: { require_audit_outcomes: ['pass'] }` 行删除 + 注释标注】
    //   该行原标注「E-4 保留作正向清退对照」。F-4 后 `complete` 退出 `FLOW_SECTIONS` ⇒ 该声明使 `field-team`
    //   **整份拒载** ⇒ `flows===null` ⇒ 下方断言虽仍过，但已改由**引擎基线**（并集被检面 + 内联字面量）决定，
    //   **不再检验任何声明面** = 绿得可疑（约束 4 判据：用例从「校验声明面」退化为「校验引擎基线」）。
    //   处置：删该键，恢复「声明 produce_field 下并集被检」的原始用意；断言文本**逐字未动**（删断言数 0）。
    writeTeamFlow(pkg, 'field-team', {
      plan: { produce_field: 'produce' },
      exec: { produce_field: 'outputs' },
      audit: { produce_field: 'outputs' },
    });
    const g = createGates(state, { flowsRoot: pkg });
    const tasks = [{ id: 'a1', layer: 'audit', produce: ['audit/r.md'] }];
    const b = batchOf('field-team', tasks);
    const r0 = g.checkExitGate(SESS, 'b1', b, 'a1');
    // 【r2 同步 · (a) 收敛 / S8】旧口径「声明用哪个字段，就只查那个字段」＝字段错位即零检；
    //   新语义：被检面恒为 `produce ∪ outputs`（并集只会更严），`produce_field` 降为信息性字段
    //   ⇒ 只写 produce 亦受检，产物缺失即拒（不再有「声明 outputs 时 produce 不被查」的免检面）。
    assert.equal(r0.ok, false, 'r2 同步：并集被检面 ⇒ produce 声明的产物缺失即拒');
    assert.equal(r0.code, 'GATE_EXIT_MISSING_AUDIT');
    const tasks2 = [{ id: 'a2', layer: 'audit', produce: ['audit/r.md'], outputs: ['audit/missing.md'] }];
    const b2 = batchOf('field-team', tasks2);
    const r1 = g.checkExitGate(SESS, 'b1', b2, 'a2');
    assert.equal(r1.ok, false);
    assert.equal(r1.code, 'GATE_EXIT_MISSING_AUDIT', '声明驱动字段参与校验');
    assert.deepEqual(produceFieldOf({ produce_field: 'outputs' }, 'audit'), 'outputs');
    // 【E-3 断言演进（信息面如实化）】原断言：
    //   `produceFieldOf(null,'exec') === 'outputs'` / `produceFieldOf(undefined,'audit') === 'produce'`
    //   （缺声明回落 LEGACY_PRODUCE_FIELD）。清退后 LEGACY_PRODUCE_FIELD 删除，缺声明返回 null（信息性真空，
    //   与 gateStrength.produceFieldDeclared 同源）；原回落值会虚构字段名 ⇒ 无声明团队被误报
    //   produce-field-widened 留痕（失真），null 化后不留痕。被检面（produce∪outputs 并集）不受影响
    //   ——上方 r0/r1 断言即其锚，属「信息面如实化」合法演进，非弱化。
    assert.deepEqual(produceFieldOf(null, 'exec'), null, 'E-3 清退后缺声明 ⇒ null（不再回落 legacy 字段）');
    assert.deepEqual(produceFieldOf(undefined, 'audit'), null, 'E-3 清退后缺声明 ⇒ null（不再回落 legacy 字段）');
  } finally { rmSync(pkg, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); clearFlowCache(); }
});

test('R1 复核修复：绝对路径 plan 产物仍受内容契约约束（末段回退，防"声明化后比引擎基线更松"）', () => {
  const { state } = mkRoots();
  try {
    clearFlowCache();
    const abs = join(state, 'sessions', SESS, 'artifacts', 'b1', 'plan', 'spec.md');
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, '# S\n## 5. 验收标准\n## 6. 约束\n', 'utf8'); // 编号变体：引擎基线与声明口径都应拒
    const g = createGates(state, { flowsRoot: packageRoot() }); // punky-preset 退役 ⇒ 无声明 ⇒ 引擎基线：globs≈plan/*spec.md + 两标题（带 ## 前缀）
    const b = batchOf('punky-preset', [{ id: 'p1', layer: 'plan', produce: [abs] }]);
    const r = g.checkExitGate(SESS, 'b1', b, 'p1');
    assert.equal(r.ok, false, '绝对路径产物不得跳过内容契约校验');
    assert.equal(r.code, 'GATE_PLAN_CONTRACT');
    assert.ok(r.problems.some((p) => p.includes('## 验收标准')), JSON.stringify(r.problems));
    // 补齐裸标题 → 通过
    writeFileSync(abs, '# S\n## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准\n## 约束\n', 'utf8');
    assert.equal(g.checkExitGate(SESS, 'b1', b, 'p1').ok, true);
    // 末段回退的纯函数面
    assert.equal(globMatchesPath('plan/*spec.md', abs), true, '绝对路径末段回退命中');
    assert.equal(globMatchesPath('plan/*spec.md', 'exec/x.md'), false);
  } finally { rmSync(state, { recursive: true, force: true }); clearFlowCache(); }
});

test('matchGlob：* 不跨 /，** 跨目录', () => {
  assert.equal(matchGlob('plan/*spec.md', 'plan/a-spec.md'), true);
  assert.equal(matchGlob('plan/*spec.md', 'plan/sub/spec.md'), false, '* 不跨目录');
  assert.equal(matchGlob('**/spec.md', 'plan/sub/spec.md'), true, '** 跨目录');
  assert.equal(matchGlob('audit/*.md', 'audit\\r.md'), true, '反斜杠归一');
  assert.equal(matchGlob('plan/spec.md', 'plan/spec.md.bak'), false);
});

test('命令 gate：声明 gate_command:false → 跳过（失败命令也不拒）；缺声明 → 引擎基线执行并拒', () => {
  const { pkg, state } = mkRoots();
  try {
    clearFlowCache();
    const flows = {
      plan: { produce_field: 'produce' },
      exec: { produce_field: 'outputs', gate_command: false },
      audit: { produce_field: 'produce' },
      // 【E-4 fixture 清理】原含 `complete: { require_audit_outcomes: ['pass','skip'] }`（legacy 废键）——删除（零行为差）。
    };
    writeTeamFlow(pkg, 'nocmd-team', flows);
    const tasks = [{ id: 'e1', layer: 'exec', outputs: ['exec/o.md'] }];
    const b = batchOf('nocmd-team', tasks);
    writeArtifact(state, 'b1', 'exec/o.md', 'body\ngate: node -e "process.exit(3)"\n');
    const g = createGates(state, { flowsRoot: pkg });
    const r = g.checkCommandGate(SESS, 'b1', b, 'e1', { runCommand: () => ({ ok: false, exitCode: 3, durationMs: 1 }) });
    assert.equal(r.ok, true, '声明关闭 → 不执行命令 gate');
    assert.equal(r.declared, false);
    assert.equal(r.disabledBy, 'team-asset:gate_command');
    // 对照：引擎基线（无声明团队）同输入 → 命中失败命令 → 拒
    const b2 = batchOf('no-asset-team', tasks);
    const r2 = createGates(state, { flowsRoot: pkg }).checkCommandGate(SESS, 'b1', b2, 'e1', { runCommand: () => ({ ok: false, exitCode: 3, durationMs: 1 }) });
    assert.equal(r2.ok, false);
    assert.equal(r2.code, 'GATE_EXIT_NONZERO');
  } finally { rmSync(pkg, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); clearFlowCache(); }
});

test('targets 门禁：声明 targets:false → 跳过；缺声明 → 引擎基线判未变更拒 merged', () => {
  const { pkg, state } = mkRoots();
  try {
    clearFlowCache();
    const target = writeArtifact(state, 'b1', 'exec/target.txt', 'x'); // mtime = 现在，但 lane 启动基准晚于它
    writeTeamFlow(pkg, 'notarget-team', {
      plan: { produce_field: 'produce' },
      exec: { produce_field: 'outputs', targets: false },
      audit: { produce_field: 'produce' },
      // 【E-4 fixture 清理】原含 `complete: { require_audit_outcomes: ['pass','skip'] }`（legacy 废键）——删除（零行为差）。
    });
    const tasks = [{ id: 'e1', layer: 'exec', outputs: ['exec/o.md'], targets: [target] }];
    const b = batchOf('notarget-team', tasks);
    // lane 启动时间设为未来 → 文件 mtime 必然早于基准 → 引擎基线判 unchanged
    b.events.push({ ts: new Date(Date.now() + 3600_000).toISOString(), type: 'member.settled', lane: 'e1', to: 'running' });
    const g = createGates(state, { flowsRoot: pkg });
    const r = g.checkTargetsGate(SESS, 'b1', b, 'e1');
    assert.equal(r.ok, true, '声明关闭 → 不做变更性判定');
    assert.equal(r.disabledBy, 'team-asset:targets');
    const b2 = batchOf('no-asset-team', tasks);
    b2.events.push({ ts: new Date(Date.now() + 3600_000).toISOString(), type: 'member.settled', lane: 'e1', to: 'running' });
    const r2 = createGates(state, { flowsRoot: pkg }).checkTargetsGate(SESS, 'b1', b2, 'e1');
    assert.equal(r2.ok, false);
    assert.equal(r2.code, 'GATE_TARGET_UNCHANGED');
  } finally { rmSync(pkg, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); clearFlowCache(); }
});

test('needHuman 门禁：声明 needhuman:false → 跳过；缺声明 → 引擎基线拒（缺 human 证据）', () => {
  const { pkg, state } = mkRoots();
  try {
    clearFlowCache();
    writeTeamFlow(pkg, 'nohuman-team', {
      plan: { produce_field: 'produce' },
      exec: { produce_field: 'outputs' },
      audit: { produce_field: 'produce', needhuman: false },
      // 【E-4 fixture 清理】原含 `complete: { require_audit_outcomes: ['pass','skip'] }`（legacy 废键）——删除（零行为差）。
    });
    const tasks = [{ id: 'a1', layer: 'audit', produce: ['audit/r.md'] }];
    writeArtifact(state, 'b1', 'audit/r.md', 'needHuman: true\n');
    const g = createGates(state, { flowsRoot: pkg });
    const r = g.checkNeedHumanGate(SESS, 'b1', batchOf('nohuman-team', tasks), 'a1', null);
    assert.equal(r.ok, true, '声明关闭 → 不需要 human 证据');
    assert.equal(r.disabledBy, 'team-asset:needhuman');
    const r2 = createGates(state, { flowsRoot: pkg }).checkNeedHumanGate(SESS, 'b1', batchOf('no-asset-team', tasks), 'a1', null);
    assert.equal(r2.ok, false);
    assert.equal(r2.code, 'GATE_NEEDHUMAN_PENDING');
  } finally { rmSync(pkg, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); clearFlowCache(); }
});

test('R1-g：software-team 声明翻牌后 consume 强制化 + standalone 显式逃生（缺口修复锚）', () => {
  const { state } = mkRoots();
  try {
    clearFlowCache();
    const g = createGates(state, { flowsRoot: packageRoot() });
    // ① 无 consume 的 exec lane → 拒派（缺口修复：此前"不声明即免检"）
    const b1 = batchOf('software-team', [{ id: 'e1', layer: 'exec', outputs: ['exec/o.md'] }]);
    const r1 = g.checkEntryGate(SESS, 'b1', b1, 'e1');
    assert.equal(r1.ok, false, '空 consume 拒派（零依赖拒派，不依赖团队声明）');
    assert.equal(r1.code, 'GATE_ENTRY_MISSING');
    // 注（2026-09-26 团队资产瘦身）：`software-team` 最小骨架不再声明 `entry_requires`
    //   ⇒ 来源回落 `tighten-only-default`；「声明团队 ⇒ 来源标注 `team-asset:entry_requires`」
    //     的覆盖改由 `test/gate-techdebt-red.test.js` 的 `R-06 正向对照` 承担（改用 mkTeamRoot）。
    assert.equal(r1.requiredBy, 'tighten-only-default');
    // ② audit lane 同理
    const b2 = batchOf('software-team', [{ id: 'a1', layer: 'audit', produce: ['audit/r.md'] }]);
    assert.equal(g.checkEntryGate(SESS, 'b1', b2, 'a1').ok, false);
    // ③ standalone 显式逃生（【r2 同步 · B4】自声明不再足以放行：须布尔 true + **非空 standaloneReason**
    //    + 批次内确实无可用上游；放行必留痕）
    const b3 = batchOf('software-team', [{ id: 'e2', layer: 'exec', outputs: ['exec/o.md'], standalone: true, standaloneReason: '本 lane 确实无上游（用例构造）' }]);
    const r3 = g.checkEntryGate(SESS, 'b1', b3, 'e2');
    assert.equal(r3.ok, true);
    assert.equal(r3.standalone, true);
    // 注（2026-09-26 团队资产瘦身）：software-team 最小骨架无 entry_requires ⇒ 来源为引擎缺省；
    //   「声明团队 ⇒ 标注 team-asset:entry_requires」由 gate-techdebt-red 的 R-06 返例覆盖。
    assert.equal(r3.requiredBy, 'tighten-only-default', '逃生放行仍标注来源（留痕）');
    // ③b 缺 standaloneReason 的自声明 ⇒ 拒（B4 事实核验）
    const b3b = batchOf('software-team', [{ id: 'e2', layer: 'exec', outputs: ['exec/o.md'], standalone: true }]);
    const r3b = g.checkEntryGate(SESS, 'b1', b3b, 'e2');
    assert.equal(r3b.ok, false, 'r2 同步：standalone 无 reason ⇒ 拒');
    assert.equal(r3b.code, 'GATE_STANDALONE_UNJUSTIFIED');
    // ④ 声明了 consume 且产物齐备 → 放行
    writeArtifact(state, 'b1', 'plan/spec.md', 'x');
    const b4 = batchOf('software-team', [{ id: 'e3', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/o.md'] }]);
    assert.equal(g.checkEntryGate(SESS, 'b1', b4, 'e3').ok, true);
    // ⑤ plan 层不受影响（entry_requires 为空）
    const b5 = batchOf('software-team', [{ id: 'p1', layer: 'plan', produce: ['plan/spec.md'] }]);
    assert.equal(g.checkEntryGate(SESS, 'b1', b5, 'p1').ok, true);
    // ⑥ 退役语义（【r2 同步 · B1】）：punky-preset 团队装配弃用（无资产）→ flows 读端**如实 ok:false**
    //    （无声明，非「加载出声明」）；但**门禁读端不再回落「未声明即免检」**——缺声明即拒，与声明团队
    //    **同一判据**（拒派不依赖团队资产是否可解析）。本项由「退役不崩」升级为「退役不放宽」。
    const flows = resolveTeamFlows('punky-preset', { root: packageRoot() });
    assert.equal(flows.ok, false, 'punky-preset 无资产 ⇒ 读端如实 ok:false（无声明，非加载出声明）');
    assert.equal(flows.flows, null);
    assert.ok(flows.problems.some((p) => p.startsWith('TEAM_ASSET_NOT_FOUND')), '拒载原因可归因：' + JSON.stringify(flows.problems));
    const b6 = batchOf('punky-preset', [{ id: 'e9', layer: 'exec', outputs: ['exec/o.md'] }]);
    const r6 = g.checkEntryGate(SESS, 'b1', b6, 'e9');
    assert.equal(r6.ok, false, '退役团队同样拒派：缺声明即拒（引擎基线收紧侧，非 legacy 免检）');
    assert.equal(r6.code, 'GATE_ENTRY_MISSING');
    // 见本用例 ① 处的缺口说明：`requiredBy` 由布尔驱动 ⇒ 未声明团队亦带该标注（正确来源读端
    // `entryRequiresOf(flow).source === 'tighten-only-default'`）。
    // 用户 2026-09-14 裁决（grilling Q1=C）：失效红条不落成新契约，正确断言留待独立小批；
    //   本条因「断言的是本批要修的失真值（`requiredBy === 'team-asset:entry_requires'`）」转 todo。
    // 说明：R-05（e1，wave3）已改取 `entryRequiresOf(flow).source`（punky-preset 无资产 ⇒ `tighten-only-default`）
    //   ⇒ 下行原断言已失效，**迁至本文件模块级 `test.todo`**（原文逐字保留，见上方「套件对齐」区块第二条）。
    //   assert.equal(r6.requiredBy, 'team-asset:entry_requires', '实测：tighten-only 后标注恒带（已知缺口）');
  } finally { rmSync(state, { recursive: true, force: true }); clearFlowCache(); }
});

test('R1-g：targets 零改动声明位 —— noChange 跳过变更性判定但仍核存在性，且留痕 mode=no-change', () => {
  const { pkg, state } = mkRoots();
  try {
    clearFlowCache();
    const target = writeArtifact(state, 'b1', 'exec/target.txt', 'x');
    const tasks = [{ id: 'e1', layer: 'exec', outputs: ['exec/o.md'], targets: [target], targetsNoChange: true }];
    const b = batchOf('no-asset-team', tasks);
    b.events.push({ ts: new Date(Date.now() + 3600_000).toISOString(), type: 'member.settled', lane: 'e1', to: 'running' });
    const g = createGates(state, { flowsRoot: pkg });
    const r = g.checkTargetsGate(SESS, 'b1', b, 'e1');
    assert.equal(r.ok, true, '零改动声明 → 不再逼出假改动（缺口修复）');
    assert.equal(r.mode, 'no-change');
    assert.equal(r.skippedChange, true);
    // 存在性仍核：目标缺失 → 仍拒
    const tasks2 = [{ id: 'e2', layer: 'exec', outputs: ['exec/o.md'], targets: [join(state, 'nope.txt')], targetsNoChange: true }];
    const b2 = batchOf('no-asset-team', tasks2);
    const r2 = g.checkTargetsGate(SESS, 'b1', b2, 'e2');
    assert.equal(r2.ok, false);
    assert.equal(r2.code, 'GATE_TARGET_MISSING');
    // 未声明零改动时行为不变（回归锚）：同输入 → GATE_TARGET_UNCHANGED
    const tasks3 = [{ id: 'e3', layer: 'exec', outputs: ['exec/o.md'], targets: [target] }];
    const b3 = batchOf('no-asset-team', tasks3);
    b3.events.push({ ts: new Date(Date.now() + 3600_000).toISOString(), type: 'member.settled', lane: 'e3', to: 'running' });
    const r3 = g.checkTargetsGate(SESS, 'b1', b3, 'e3');
    assert.equal(r3.ok, false);
    assert.equal(r3.code, 'GATE_TARGET_UNCHANGED');
  } finally { rmSync(pkg, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); clearFlowCache(); }
});

test('complete 判据唯一真源：verdict 声明收窄可拒 skipped；缺声明 ⇒ 引擎基线白名单（skipped 放行）', () => {
  const { pkg, state } = mkRoots();
  try {
    clearFlowCache();
    const tasks = [
      { id: 'e1', layer: 'exec', outputs: ['exec/o.md'] },
      { id: 'a1', layer: 'audit', produce: ['audit/r.md'] },
    ];
    const mk = (team) => {
      const b = batchOf(team, tasks);
      b.lanes = { e1: 'merged', a1: 'skipped' };
      return b;
    };
    // 缺声明（no-asset-team）→ 引擎基线白名单 {pass,skip}：skipped 属终态且非 failed/conflict → 通过
    const legacy = createGates(state, { flowsRoot: pkg }).checkCompleteGate(mk('no-asset-team'));
    assert.equal(legacy.ok, true, '引擎基线白名单：skipped 审计 lane 放行');
    // 【E-4 换真源锚点】原 fixture 声明 `complete: { require_audit_outcomes: ['pass'] }`（legacy 键）——
    //   清退后引擎不再读该键 ⇒ 改锚唯一真源 `audit.audit_contract.verdict: ['pass']`；下方拒断言
    //   （GATE_COMPLETE_AUDIT_FAILED / requiredOutcomes ['pass'] / offenders）**原样保留** = 断言语义零放水。
    writeTeamFlow(pkg, 'strict-complete', {
      plan: { produce_field: 'produce' },
      exec: { produce_field: 'outputs' },
      audit: { produce_field: 'produce', audit_contract: { verdict: ['pass'] } },
    });
    const strict = createGates(state, { flowsRoot: pkg }).checkCompleteGate(mk('strict-complete'));
    assert.equal(strict.ok, false);
    assert.equal(strict.code, 'GATE_COMPLETE_AUDIT_FAILED');
    assert.deepEqual(strict.requiredOutcomes, ['pass']);
    assert.deepEqual(strict.offenders, [{ lane: 'a1', state: 'skipped' }]);
    // source 两态（E-4 后 legacy 第三态消失）：声明 verdict ⇒ verdict 真源串
    assert.equal(strict.completeOutcomes.source, 'flows.audit.audit_contract.verdict ∩ {pass,skip}',
      'E-4：source 只剩 verdict / engine:Q-7-baseline 两态');
    // 包内 punky-preset 团队装配退役（无声明）→ complete 读端走引擎基线白名单（skipped 放行），退役面不崩
    const jf = createGates(state, { flowsRoot: packageRoot() }).checkCompleteGate(mk('punky-preset'));
    assert.equal(jf.ok, true, 'punky-preset 退役 ⇒ 无声明 ⇒ 引擎基线白名单 {pass,skip} ⇒ skipped 放行');
  } finally { rmSync(pkg, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); clearFlowCache(); }
});

// 【legacy-retire-20260915 · 正向清退断言（E-4）＋ F-4 拒载翻牌（2026-09-15 用户裁决 Q-D=A）】
//   E-4 口径：声明已废键 `flows.complete.require_audit_outcomes` 不再产生任何门禁效果（引擎不读该键）。
//   F-4 口径（**本用例现锚**）：该键所属的 `complete` 层已退出 `FLOW_SECTIONS` ⇒ 声明它 ⇒ 资产**整份拒载**
//     （`TEAM_ASSET_LAYER_UNKNOWN`，blocking；无豁免、无降级、不降告警）⇒ 读端 `flows===null` ⇒ complete
//     白名单回落**引擎基线** `{pass,skip}` ⇒ skipped 放行。
//   **语义变更如实标注**：下方 `r.ok===true` 数值不变，但语义已从「引擎忽略废键」变为「资产拒载 ⇒ 回落引擎基线」
//     —— 不得把它当作「废键被忽略」的假证据；历史面（E-4 正向清退）已由 `:531` 的**断言反转**升级为更严的拒载形态。
//   断言纪律：既有断言零删除、零弱化（规格约束 3 允许的形态 (b) 断言增强 + (c) 断言反转）。
//   原断言文本（E-4 形态，逐字留档，便于审计对账「哪些是反转、哪些是换 message、有无删除」）：
//     · `assert.equal(r.ok, true, '已废键不产生门禁效果：白名单仍 {pass,skip} ⇒ skipped 放行（AC-3）');`
//       ⇒ **表达式保留**（`r.ok === true` 仍为事实），仅 message 按新语义改写（旧 message 在新语义下是假话）。
//     · `assert.equal(lr.ok, true, 'complete 段保持合法声明位（方案 B），废键不拒载');`
//       ⇒ **断言反转**为 `assert.equal(lr.ok, false, …)` + 新增码/严重级/文案三重锚（见下方行内注释）。
//     · 删除的**非断言**行仅 1 条：`complete: { require_audit_outcomes: ['pass'] }, // 已废键：显式声明以证明引擎不读`
//       ⇒ 该键**保留**（本用例已升级为拒载锚的夹具），只改其尾注；与 `:531` 反转配套。
test('F-4 + K-2 锚：声明 flows.complete ⇒ LAYER_UNKNOWN **warning 级**（不拒载）⇒ 读端回落引擎基线 ⇒ skipped 放行', async () => {
  const { pkg, state } = mkRoots();
  try {
    clearFlowCache();
    const tasks = [
      { id: 'e1', layer: 'exec', outputs: ['exec/o.md'] },
      { id: 'a1', layer: 'audit', produce: ['audit/r.md'] },
    ];
    const b = batchOf('legacy-key-team', tasks);
    b.lanes = { e1: 'merged', a1: 'skipped' };
    writeTeamFlow(pkg, 'legacy-key-team', {
      plan: { produce_field: 'produce' },
      exec: { produce_field: 'outputs' },
      audit: { produce_field: 'produce' },
      complete: { require_audit_outcomes: ['pass'] }, // F-4：该层已退出 FLOW_SECTIONS ⇒ 命中未知层（K-2 后 warning）
    });
    const r = createGates(state, { flowsRoot: pkg }).checkCompleteGate(b);
    assert.equal(r.ok, true, 'K-2 语义：未知层为 warning ⇒ 资产**可用**、读端回落引擎基线 {pass,skip} ⇒ skipped 放行');
    // 【K-2 翻牌（2026-09-18 用户裁决）】原断言为「声明 flows.complete ⇒ 拒载（blocking）」；
    //   K-2 后 `LAYER_UNKNOWN` 退出 BLOCKING_CODES ⇒ 不拒载、改 **warning 留痕**。断言强度不减：
    //   由单条 `ok:false` 改为「**码面 + 严重级 + 文案 + 层被跳过**」四重锚（不得以删除断言了事）。
    const { loadTeamAsset } = await import('../lib/assembly/team-asset.js');
    const lr = loadTeamAsset(pkg, 'legacy-key-team');
    assert.equal(lr.ok, true, 'K-2：未知层 warning ⇒ 不拒载（资产可用）');
    assert.ok(lr.problems.map((p) => p.code).includes('TEAM_ASSET_LAYER_UNKNOWN'), 'K-2：码面保留（留痕可读）');
    const lp = lr.problems.find((p) => p.path === 'flows.complete');
    assert.equal(lp.code, 'TEAM_ASSET_LAYER_UNKNOWN');
    assert.equal(lp.severity, 'warning', 'K-2：warning 级（非 blocking）');
    assert.ok(lp.message.includes('允许：plan/exec/audit'), lp.message);
  } finally { rmSync(pkg, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); clearFlowCache(); }
});
