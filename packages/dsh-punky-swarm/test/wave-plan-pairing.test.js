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

// wave-plan-pairing.test.js —— U-7/G-08「配对基数软校验」替代判据的**可达性锁**（lane exec-pairing-panel / B 工位）
//
// 为什么需要本套件（上一批的教训）：旧判据「上游 exec lane 的 `deps` 覆盖本 audit lane 的 `deps` 且严格更大」在
// **任何合法拓扑下不可满足**——本 audit lane 的 `deps` 含该 exec lane 自身，而任何 lane 的 `deps` 都不含自身
// ⇒ 要满足覆盖即须自指环，而该构造在建批期先被 `topoWaves` 以 `cycle detected in task deps` 拒绝
// ⇒ 旧判据恒 false、告警码**恒零产出**（「有校验之名、无校验之实」）。本批按规格 §2.1 方案 R 换为可达判据：
// audit lane **认领**一条 exec lane（`deps` 含它）即须在 `consume` 中声明消费其交付产物（`produce ∪ outputs`），
// 否则产同码告警。⇒ 本套件的核心义务 = **证明新判据真的会命中**（六格构造 + **逐格**断言，禁只断总数），
// 并用**内联的退役判据分项**（`lenGt` / `covers`）留痕其不可达性（该实现已从库里删除，只能内联复算）。
//
// 构造口径：ND-1/ND-2/ND-3 的「不可达」性质**只由 `deps` 拓扑决定**（退役判据只看 `deps` 集合，与 `consume` 无关）
// ⇒ 这三格让 audit lane 显式消费被认领 exec 的交付产物，使其在新判据下同样**不命中**（R-3 期望 0）。
// 规格 §2.1(c) 的**逐字原文**（consume 不覆盖）另立一格（U7-8），把「退役判据不命中 / 新判据命中」的口径差显式留痕。
//
// 原始读数（探针 `exec-pairing-panel/probe/u7-reachability.json`，与断言逐格对应）：
//   真实门链（smoke=false）：ND-1 ok/0 ｜ ND-2 ok/0 ｜ ND-3 REJECT(cycle) ｜ P1-hit ok/1(a1) ｜ P1-miss ok/0 ｜ P2 ok/1(a1)
//   冒烟门（smoke=true）：六格同读数（§2.1(c) ND-1 逐字原文在真实门链另被 `GATE_ORPHAN_PRODUCT` 先拒，见 U7-8）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildWavePlan, topoWaves } from '../lib/wave-plan.js';

const CODE = 'GATE_PAIRING_CARDINALITY_DRIFT';
const TEAM = 'engine-team';

const P = (id, extra = {}) => ({ id, layer: 'plan', role: 'designer', produce: [`plan/${id}.md`], ...extra });
const E = (id, deps, extra = {}) => ({ id, layer: 'exec', role: 'coder', deps, outputs: [`exec/${id}.md`], ...extra });
const A = (id, deps, consume, extra = {}) => ({
  id, layer: 'audit', role: 'supervisor', deps, consume, outputs: [`audit/${id}.md`], ...extra,
});

const pairingOf = (plan) => (plan.warnings ?? []).filter((w) => w.code === CODE);
const build = (key, tasks, smoke = false) => buildWavePlan({ batchId: 'u7-' + key, tasks, team: TEAM, smoke });

/** 退役判据的内联复算（库内实现已删）：**只作不可达性留痕**，不参与实现行为。 */
function retiredPredicateTrace(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const strsOf = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length > 0) : []);
  const out = [];
  for (const t of tasks) {
    if (t.layer !== 'audit') continue;
    const own = strsOf(t.deps);
    for (const d of own) {
      const up = byId.get(d);
      if (!up || up.layer !== 'exec') continue;
      const upDeps = strsOf(up.deps);
      const lenGt = upDeps.length > own.length;
      const covers = own.every((x) => upDeps.includes(x));
      out.push({ edge: t.id + '<-' + d, own: own.join('|'), upDeps: upDeps.join('|'), lenGt, covers, superset: lenGt && covers });
    }
  }
  return out;
}

// ── 不可达格（ND-1/ND-2/ND-3）：证明退役判据在合法拓扑下恒不命中 ────────────────────────────────

test('U7-1【不可达·退役判据】ND-1 最强反例形态（audit 复述 exec 全部上游 deps + exec 自身）⇒ 建批 ok、配对告警逐格为 0', () => {
  const tasks = [
    P('p1'), P('p2'),
    E('e1', ['p1', 'p2']),
    A('a1', ['p1', 'p2', 'e1'], ['plan/p1.md', 'plan/p2.md', 'exec/e1.md']),
  ];
  assert.deepEqual(topoWaves(tasks).waves.map((w) => w.join('+')), ['p1+p2', 'e1', 'a1'], 'ND-1 拓扑分层读数');
  const trace = retiredPredicateTrace(tasks);
  assert.equal(trace.length, 1, '恰好 1 条 audit←exec 入边（a1←e1）');
  assert.equal(trace[0].covers, false, '退役判据 covers 分项（内联复算）= false：own 含 e1 而 deps(e1) 不含 e1');
  assert.equal(trace[0].superset, false, '退役判据 superset 分项 = false ⇒ 该形态永不命中');
  const plan = build('nd1', tasks);
  assert.equal(plan.warnings.length, 0, 'warning 总数 0（本格逐格断言，不只看总数）');
  assert.equal(pairingOf(plan).length, 0, '配对告警 0');
});

test('U7-2【不可达·退役判据】ND-2 共享祖先形态（a1←[p1,e1]，deps(e1)=[p1]）⇒ 建批 ok、配对告警 0', () => {
  const tasks = [
    P('p1'),
    E('e1', ['p1']),
    A('a1', ['p1', 'e1'], ['plan/p1.md', 'exec/e1.md']),
  ];
  assert.deepEqual(topoWaves(tasks).waves.map((w) => w.join('+')), ['p1', 'e1', 'a1'], 'ND-2 拓扑分层读数');
  const trace = retiredPredicateTrace(tasks);
  assert.equal(trace.length, 1);
  assert.equal(trace[0].lenGt, false, '退役判据 lenGt 分项 = false（|deps(e1)|=1 不大于 |deps(a1)|=2）');
  assert.equal(trace[0].superset, false);
  const plan = build('nd2', tasks);
  assert.equal(plan.warnings.length, 0, 'warning 总数 0');
  assert.equal(pairingOf(plan).length, 0, '配对告警 0');
});

test('U7-3【不可达·建批先拒】ND-3 自指环（退役判据的唯一命中构造）⇒ 建批在 topoWaves 处即拒，判据从不执行', () => {
  const tasks = [
    P('p1'),
    E('e1', ['p1']),
    A('a1', ['e1', 'a1'], ['plan/p1.md', 'exec/e1.md']),
  ];
  assert.throws(() => topoWaves(tasks), /cycle detected in task deps/, '自指环先被拓扑层拒');
  assert.throws(() => build('nd3', tasks), /cycle detected in task deps/, '真实建批入口同拒（判据无从执行）');
});

// ── 可达格（P1/P2）：证明替代判据**真命中**（G-08 的核心验收） ────────────────────────────────

test('U7-4【可达·替代判据】P1 命中：审计认领 exec lane 却未消费其交付产物 ⇒ 产 1 条 GATE_PAIRING_CARDINALITY_DRIFT（task=a1）', () => {
  const tasks = [
    P('p1'),
    E('e1', ['p1']),
    A('a1', ['p1', 'e1'], ['plan/p1.md']),   // 认领 e1，但 consume 未含 exec/e1.md
  ];
  const plan = build('p1-hit', tasks);
  const w = pairingOf(plan);
  assert.equal(w.length, 1, '恰好 1 条配对告警（可达性：真命中）');
  assert.equal(w[0].code, CODE, '告警码逐字');
  assert.equal(w[0].task, 'a1', '告警归属 = 认领方 audit lane');
  assert.match(w[0].message, /未覆盖/, '文案须点明判据（未覆盖交付产物）');
  assert.match(w[0].message, /exec\/e1\.md/, '文案须列出未覆盖的交付产物');
  assert.equal(/真包含/.test(w[0].message), false, '文案不得再含退役判据的措辞');
});

test('U7-5【不可达·替代判据】P1 不命中：审计显式消费该 exec 的交付产物 ⇒ 零告警（防假阳性）', () => {
  const tasks = [
    P('p1'),
    E('e1', ['p1']),
    A('a1', ['p1', 'e1'], ['plan/p1.md', 'exec/e1.md']),
  ];
  const plan = build('p1-miss', tasks);
  assert.equal(plan.warnings.length, 0, 'warning 总数 0');
  assert.equal(pairingOf(plan).length, 0, '配对告警 0');
});

test('U7-6【可达·替代判据】P2 命中：单条聚合 audit 认领 2 条 exec 只消费其中 1 条 ⇒ 仅对未覆盖那条告警（逐边粒度）', () => {
  const tasks = [
    P('p1'),
    E('e1', ['p1']),
    E('e2', ['p1']),
    A('a1', ['p1', 'e1', 'e2'], ['plan/p1.md', 'exec/e1.md']),
  ];
  assert.deepEqual(topoWaves(tasks).waves.map((w) => w.join('+')), ['p1', 'e1+e2', 'a1'], 'P2 拓扑分层读数');
  const plan = build('p2-hit', tasks);
  const w = pairingOf(plan);
  assert.equal(w.length, 1, '恰 1 条（e1 已覆盖 ⇒ 不告警；e2 未覆盖 ⇒ 告警）');
  assert.equal(w[0].task, 'a1');
  assert.match(w[0].message, /未覆盖 e2 的任何交付产物/, '告警须指向未覆盖的 e2');
  assert.match(w[0].message, /e2 交付：exec\/e2\.md/, '须列出 e2 的交付产物（取证可核）');
  assert.equal(/未覆盖 e1 的任何交付产物/.test(w[0].message), false, '已覆盖的 e1 不得被判未覆盖（逐边粒度）');
});

// ── 口径差留痕 + 判据原文锁 + 真实批零假阳性 ────────────────────────────────────────────────

test('U7-8【口径差留痕】规格 §2.1(c) ND-1 逐字原文：真实门链先拒 GATE_ORPHAN_PRODUCT；冒烟门下替代判据命中 1 条（退役判据仍不命中）', () => {
  const tasks = [
    P('p1'), P('p2'),
    E('e1', ['p1', 'p2']),
    A('a1', ['p1', 'p2', 'e1'], ['plan/p1.md']),   // 规格原文：consume 不含 exec/e1.md，且 plan/p2.md 无人消费
  ];
  assert.equal(retiredPredicateTrace(tasks)[0].superset, false, '口径差的一半：退役判据在该形态不命中');
  assert.throws(() => build('verbatim-nd1-real', tasks, false), /GATE_ORPHAN_PRODUCT/,
    '真实门链下 plan/p2.md 无消费方 ⇒ 建批先拒（规格表格的「建批 ok」只在 smoke 口径成立）');
  const w = pairingOf(build('verbatim-nd1-smoke', tasks, true));
  assert.equal(w.length, 1, '口径差的另一半：冒烟建批下替代判据命中 1 条');
  assert.equal(w[0].task, 'a1');
});

test('U7-9【判据原文锁】两文件 docstring 不再陈述退役判据（不含其实现在场），且写明可达语义（认领集 / consume 覆盖）', () => {
  for (const rel of ['lib/wave-plan.js', 'lib/wave-plan.ts']) {
    const src = readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
    assert.equal(/upDeps\.length > own\.length/.test(src), false, rel + ' 不得再出现退役判据表达式');
    assert.equal(/const superset/.test(src), false, rel + ' 不得再出现退役判据实现');
    assert.ok(src.includes('认领集'), rel + ' 须写明替代判据语义（认领集 = deps ∩ exec）');
    assert.ok(src.includes('未覆盖'), rel + ' 须写明替代判据语义（consume 覆盖判据）');
  }
});

test('U7-10【零假阳性】本批真实形态（audit 认领 3 条 exec lane 并逐条消费其产物）⇒ 配对告警 0', () => {
  const tasks = [
    { id: 'plan-debt-spec', layer: 'plan', role: 'designer', produce: ['plan/debt-spec.md'] },
    { id: 'exec-deadcall-adapter', layer: 'exec', role: 'coder', deps: ['plan-debt-spec'], outputs: ['exec/deadcall-adapter.md'] },
    { id: 'exec-pairing-panel', layer: 'exec', role: 'coder', deps: ['plan-debt-spec'], outputs: ['exec/pairing-panel.md'] },
    { id: 'exec-test-honesty', layer: 'exec', role: 'coder', deps: ['plan-debt-spec'], outputs: ['exec/test-honesty.md'] },
    {
      id: 'audit-debt-acceptance', layer: 'audit', role: 'supervisor',
      deps: ['exec-deadcall-adapter', 'exec-pairing-panel', 'exec-test-honesty'],
      consume: ['plan/debt-spec.md', 'exec/deadcall-adapter.md', 'exec/pairing-panel.md', 'exec/test-honesty.md'],
      outputs: ['audit/acceptance-report.md'],
    },
  ];
  const plan = build('real-batch-shape', tasks);
  assert.equal(pairingOf(plan).length, 0, '真实合法声明不得产配对告警（认领即消费 ⇒ 逐条覆盖）');
});
