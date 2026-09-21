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

// test/gates-vocabulary-contract.test.js —— R1「契约三小件」·门禁面（exec-2 lane）
// ─────────────────────────────────────────────────────────────────────────────
// 被检面 = `lib/state/gates.ts`（唯一手写源）的**六个校验点**（`docs/r1-blueprint-spec.md` §2.4）
//   + `lib/types/contracts.ts` 的 `GateErrorCode` 新增 2 条（§2.1(f)）+ 生成物同批（§5.2）。
//
// 覆盖口径（逐条可机检；夹具一律落 `os.tmpdir()`，零写项目盘）：
//   #1 `detectPendingMarker` 纯函数：逐字 `includes`（非正则）+ `index`
//   #2 命令门 C3「词表」：产物内独立行 `reason: <token>` 未登记 ⇒ 拒 `GATE_TOKEN_UNKNOWN`；
//      已登记 ⇒ 放行（零感知）；停用条目（`enabled:false`）⇒ 放行 + `restated` 告警位；词表不可用 ⇒ fail-open
//   #3 plan 契约门 P3「元素/小节」：`contract.elements` / `contract.subsections` 声明了才逐条核（缺省零感知）
//   #4 plan 契约门 P4「待确认」：命中 `pending_marker.literal` 且 `t.layer === 'plan'` ⇒ 拒**既有码**
//      `GATE_NEEDHUMAN_PENDING`；未声明 ⇒ 放行；**audit 层 ⇒ 不拒**（U-1：判定面仅 plan）
//   #5 entry 门 E1「词表早期拒」：与 #2 **同一 tokenOf 单点**；位置晚于 lane 存在性 / plan 豁免、早于 smoke 豁免
//   #6 `gateStatusOfLane` 只增 `vocabulary` 展示位（`{loaded,version,source}`），**不参与任何判定**
//   U-2 严格生效（源码级回归锁）：无 env 关阀 / 无按批龄分流分支
//   P11 生成物同批：`gates.js` / `gates.d.ts` / `contracts.d.ts` 含本批新增，`.tsbuild` 已清
//
// 判据纪律（防「用坏夹具测出假绿」）：每个词表夹具先断言 `loadVocabulary({root}).ok === true`
//   —— `sources[].path` 校验锚在**真包根**（`vocabulary.js` 模块级 `PACKAGE_ROOT`），故夹具只需给
//   `lib/state/gates.ts` 这条既有真锚即可自洽。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGates, detectPendingMarker } from '../lib/state/gates.js';
import { writeSyntheticTeam } from './helpers/team-fixture.mjs';
import { loadVocabulary, VOCABULARY_REL } from '../lib/state/vocabulary.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESS = 'sess-r1g';
const TEAM = 'r1g-team';

const TMP = [];
function mkTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP.push(d);
  return d;
}
test.after(() => {
  for (const d of TMP) fs.rmSync(d, { recursive: true, force: true });
});

// ── 夹具：临时包根（**同时**承载 flows 声明根与词表根 = `createGates` 的两个 DI 缝）──────────────
function mkPkg() {
  const p = mkTmp('r1g-pkg-');
  fs.mkdirSync(path.join(p, 'presets'), { recursive: true });
  return p;
}

/** 团队资产（形态与 `test/gate-flows.test.js#writeTeamFlow` 同构 ⇒ 保证资产校验通过；F2 起二者共用单点）。 */
function writeTeam(pkg, team, flows) {
  return writeSyntheticTeam(pkg, team, {
    team,
    layers: { plan: { roles: ['designer'], skills: { designer: ['dev-designer'] } } },
    flows,
  }, { filename: 'team-asset.yml' });
}

/** 词表夹具（落**临时包根**，绝不写包内交付物）。`entries` 为本用例私有。 */
function seedVocab(pkg, entries) {
  const abs = path.join(pkg, ...VOCABULARY_REL.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify({
    $schema: 'dsh-punky-swarm/vocabulary@1',
    meta: { version: 1, updated: '2026-09-19', counts: { gateCodes: 86, reasonTokens: 45 } },
    sources: [{ id: 'gate-entry', path: 'lib/state/gates.ts', line: 598, note: 'GATE_* 拒码面（Entry 门）' }],
    entries,
  }, null, 2), 'utf8');
  return abs;
}

/** 词表坏档（JSON 不可解析）——fail-open 用例专用。 */
function seedBrokenVocab(pkg) {
  const abs = path.join(pkg, ...VOCABULARY_REL.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '{ "entries": [ , not json', 'utf8');
}

const ENTRY_ACTIVE = {
  id: 'reason-no-such-token', code: 'no_such_token', label: '新增用例码', kind: 'reason',
  enabled: true, since: '0.4.4', deprecatedIn: null, replacedBy: null,
};
const ENTRY_RETIRED = {
  id: 'reason-legacy-token', code: 'legacy_token', label: '已停用码', kind: 'reason',
  enabled: false, since: '0.3.0', deprecatedIn: '0.4.4', replacedBy: 'reason-no-such-token',
  note: '停用而非删除：既有产物仍解析通过',
};

const SPEC_OK = '# Spec\n## 验收标准\n- done\n## 约束\n- none\n';

/** 门禁返回值上的**全部** escape 种类（写端 `store.js#gateEscapeEvents` 同时消费 `escape` 与 `escapes[]`）。 */
const escapeKinds = (r) => [
  ...(r && r.escape && typeof r.escape.kind === 'string' ? [r.escape.kind] : []),
  ...((r && Array.isArray(r.escapes) ? r.escapes : []).map((e) => e && e.kind)),
];

function flowFixtures(planContract = {}) {
  return {
    plan: {
      produce_field: 'produce',
      entry_requires: [],
      contract: {
        artifact_globs: ['plan/*spec.md'],
        required_sections: ['## 验收标准', '## 约束'],
        ...planContract,
      },
    },
    exec: { produce_field: 'outputs', entry_requires: ['consume'] },
    audit: {
      produce_field: 'produce',
      entry_requires: ['consume'],
      audit_contract: { criteria_from: 'plan/**', consumes_required: ['plan/', 'exec/'], verdict: ['pass', 'skip'] },
    },
  };
}

function writeArt(state, batchId, rel, content) {
  const abs = path.join(state, 'sessions', SESS, 'artifacts', batchId, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

// wavePlan 持久形态 = [{ tasks }]；`lanes` 显式给出（缺 ⇒ 空对象 = 非 idle ⇒ 严格侧）
const batchOf = (team, tasks, lanes = {}) => ({
  batchId: 'b1', team, createdAt: '2026-09-19T00:00:00.000Z', lanes, events: [], wavePlan: [{ wave: 1, tasks }],
});

/** 一次性建「词表根 + 声明根 + 严格门禁实例」（各用例自持，零串味）。 */
function gatesWith(entries, planContract = {}, opts = {}) {
  const pkg = mkPkg();
  writeTeam(pkg, TEAM, flowFixtures(planContract));
  if (opts.brokenVocab === true) seedBrokenVocab(pkg); else seedVocab(pkg, entries);
  const state = mkTmp('r1g-state-');
  const g = createGates(state, { flowsRoot: pkg, vocabularyRoot: pkg });
  return { pkg, state, g };
}

// ═══════════════════════════════════════════════════════════════════════════════
// #1 `detectPendingMarker`（纯函数：逐字 `includes`，非正则）
// ═══════════════════════════════════════════════════════════════════════════════

test('#1 detectPendingMarker：逐字 includes + index（零 IO 纯函数）', () => {
  assert.deepEqual(detectPendingMarker('a\n[待确认]\nb', '[待确认]'), { declared: true, index: 2 });
  assert.deepEqual(detectPendingMarker('no marker here', '[待确认]'), { declared: false, index: -1 });
  assert.deepEqual(detectPendingMarker('[待确认]', ''), { declared: false, index: -1 }, '空 literal ⇒ 不声明（防空串恒命中）');
  assert.deepEqual(detectPendingMarker('[待确认]', null), { declared: false, index: -1 });
  assert.deepEqual(detectPendingMarker(null, '[待确认]'), { declared: false, index: -1 });
  // 逐字匹配（**非正则**）：正则元字符不得通配
  assert.equal(detectPendingMarker('axb', 'a.b').declared, false, '`a.b` 不得命中 `axb`（禁正则）');
  assert.equal(detectPendingMarker('a.b', 'a.b').declared, true);
  assert.equal(detectPendingMarker('见 [待确认] 段', '[待确认]').declared, true, '不限行首（与 reason: 行族不同：literal 是字面量扫描）');
});

// ═══════════════════════════════════════════════════════════════════════════════
// #2 命令门 C3「词表」
// ═══════════════════════════════════════════════════════════════════════════════

test('#2 命令门 C3：未登记 reason token ⇒ 拒 GATE_TOKEN_UNKNOWN（空词表 = 零 token 命中）', () => {
  const { state, g } = gatesWith([]);
  writeArt(state, 'b1', 'exec/e1.md', 'out\nreason: no_such_token\n');
  const b = batchOf(TEAM, [{ id: 'e1', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e1.md'] }]);
  const r = g.checkCommandGate(SESS, 'b1', b, 'e1');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'GATE_TOKEN_UNKNOWN', '拒码须恒为该字面量：' + JSON.stringify(r));
  assert.equal(r.token, 'no_such_token');
  assert.equal(r.source, 'reason');
  assert.match(String(r.detail), /no_such_token/, 'detail 须可读（写端抛错文案取自 detail）');
});

test('#2 反例：**已登记**（enabled:true）token ⇒ 放行（零感知）', () => {
  const { state, g } = gatesWith([ENTRY_ACTIVE]);
  writeArt(state, 'b1', 'exec/e1.md', 'out\nreason: no_such_token\n');
  const b = batchOf(TEAM, [{ id: 'e1', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e1.md'] }]);
  const r = g.checkCommandGate(SESS, 'b1', b, 'e1');
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('#2 停用条目（enabled:false）⇒ 放行 + restated 告警位（禁用≠删除）', () => {
  const { state, g } = gatesWith([ENTRY_ACTIVE, ENTRY_RETIRED]);
  writeArt(state, 'b1', 'exec/e1.md', 'out\nreason: legacy_token\n');
  const b = batchOf(TEAM, [{ id: 'e1', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e1.md'] }]);
  const r = g.checkCommandGate(SESS, 'b1', b, 'e1');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(escapeKinds(r).includes('vocabulary-restated'), '停用条目须留痕（告警而非拒绝）：' + JSON.stringify(r));
});

test('#2 词表不可用（坏 JSON）⇒ fail-open 降级留痕 GATE_VOCAB_INVALID，**不拒批**', () => {
  const { state, g } = gatesWith([], {}, { brokenVocab: true });
  writeArt(state, 'b1', 'exec/e1.md', 'out\nreason: whatever_unregistered\n');
  const b = batchOf(TEAM, [{ id: 'e1', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e1.md'] }]);
  const r = g.checkCommandGate(SESS, 'b1', b, 'e1');
  assert.equal(r.ok, true, '词表损坏不得砸生产（fail-open）：' + JSON.stringify(r));
  assert.equal(r.vocabCode, 'GATE_VOCAB_INVALID');
  assert.ok(escapeKinds(r).includes('vocabulary-unavailable'));
});

test('#2 行首锚定：`empty-reason:` 行不得被当作 reason 声明（既有载原因行族零误伤）', () => {
  const { state, g } = gatesWith([]);
  writeArt(state, 'b1', 'exec/e1.md', 'empty-reason: 上游未就绪（本行不是 reason 声明）\n');
  const b = batchOf(TEAM, [{ id: 'e1', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e1.md'] }]);
  const r = g.checkCommandGate(SESS, 'b1', b, 'e1');
  assert.equal(r.ok, true, JSON.stringify(r));
});

// ═══════════════════════════════════════════════════════════════════════════════
// #5 entry 门 E1「词表早期拒」（与 #2 同一 tokenOf 单点）
// ═══════════════════════════════════════════════════════════════════════════════

test('#5 entry 门 E1：未登记 token ⇒ 早期拒 GATE_TOKEN_UNKNOWN（与 #2 同码同 token）', () => {
  const { state, g } = gatesWith([]);
  // consume 已就绪（若 E1 未生效，本 fixture 会**放行**）⇒ 拒因必来自词表门
  writeArt(state, 'b1', 'plan/spec.md', SPEC_OK);
  writeArt(state, 'b1', 'exec/e1.md', 'out\nreason: no_such_token\n');
  const b = batchOf(TEAM, [{ id: 'e1', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e1.md'] }], { e1: 'pending' });
  const r = g.checkEntryGate(SESS, 'b1', b, 'e1');
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'GATE_TOKEN_UNKNOWN');
  assert.equal(r.token, 'no_such_token');
});

test('#5 位置纪律：E1 **早于** smoke 豁免（冒烟批同样被拦）', () => {
  const { state, g } = gatesWith([]);
  writeArt(state, 'b1', 'exec/e1.md', 'out\nreason: no_such_token\n');
  const b = batchOf(TEAM, [{ id: 'e1', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e1.md'] }], { e1: 'pending' });
  b.events = [{ ts: '2026-09-19T00:00:00.000Z', type: 'batch.smoke' }];
  assert.equal(g.checkEntryGate(SESS, 'b1', b, 'e1').code, 'GATE_TOKEN_UNKNOWN');
});

test('#5 位置纪律：E1 **晚于** lane 存在性 与 plan 豁免（plan lane 不入本门）', () => {
  const { state, g } = gatesWith([]);
  writeArt(state, 'b1', 'plan/spec.md', SPEC_OK + 'reason: no_such_token\n');
  const b = batchOf(TEAM, [{ id: 'p1', layer: 'plan', produce: ['plan/spec.md'] }], { p1: 'pending' });
  assert.equal(g.checkEntryGate(SESS, 'b1', b, 'p1').ok, true, 'plan 层结构性无上游 ⇒ entry 豁免一字不改');
  assert.equal(g.checkEntryGate(SESS, 'b1', b, 'ghost').code, 'GATE_LANE_NOT_IN_PLAN', 'lane 存在性门仍在其前');
});

test('#5 反例：已登记 token ⇒ entry 放行', () => {
  const { state, g } = gatesWith([ENTRY_ACTIVE]);
  writeArt(state, 'b1', 'plan/spec.md', SPEC_OK);
  writeArt(state, 'b1', 'exec/e1.md', 'out\nreason: no_such_token\n');
  const b = batchOf(TEAM, [{ id: 'e1', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e1.md'] }], { e1: 'pending' });
  const r = g.checkEntryGate(SESS, 'b1', b, 'e1');
  assert.equal(r.ok, true, JSON.stringify(r));
});

// ═══════════════════════════════════════════════════════════════════════════════
// #3 plan 契约门 P3「元素 / 小节」
// ═══════════════════════════════════════════════════════════════════════════════

test('#3 plan 契约门 P3：声明 elements / subsections ⇒ 逐条核（缺 ⇒ GATE_PLAN_CONTRACT）', () => {
  const { state, g } = gatesWith([], { elements: ['goal'], subsections: { '## 风险': 2 } });
  writeArt(state, 'b1', 'plan/spec.md', SPEC_OK);
  const b = batchOf(TEAM, [{ id: 'p1', layer: 'plan', produce: ['plan/spec.md'] }]);
  const r = g.checkPlanContract(SESS, 'b1', b, 'p1');
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'GATE_PLAN_CONTRACT', '复用既有码，不新增拒码');
  assert.ok(r.problems.some((p) => /lacks element "goal"/.test(p)), JSON.stringify(r.problems));
  assert.ok(r.problems.some((p) => /lacks subsection "## 风险"/.test(p)), JSON.stringify(r.problems));
});

test('#3 反例：产物携带 `element: <id>` 独立行 + 裸小节标题 ⇒ 放行', () => {
  const { state, g } = gatesWith([], { elements: ['goal'], subsections: ['## 风险'] });
  writeArt(state, 'b1', 'plan/spec.md', 'element: goal\n' + SPEC_OK + '## 风险\n- x\n');
  const b = batchOf(TEAM, [{ id: 'p1', layer: 'plan', produce: ['plan/spec.md'] }]);
  const r = g.checkPlanContract(SESS, 'b1', b, 'p1');
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('#3 零感知：未声明 elements / subsections ⇒ 行为逐字不变（同产物同判）', () => {
  const { state, g } = gatesWith([], {});
  writeArt(state, 'b1', 'plan/spec.md', SPEC_OK);
  const b = batchOf(TEAM, [{ id: 'p1', layer: 'plan', produce: ['plan/spec.md'] }]);
  assert.equal(g.checkPlanContract(SESS, 'b1', b, 'p1').ok, true);
});

test('#3 行首锚定：`element:` 行须独立整行（内嵌提及不命中）', () => {
  const { state, g } = gatesWith([], { elements: ['goal'] });
  writeArt(state, 'b1', 'plan/spec.md', SPEC_OK + '本节描述 element: goal 的写法（内嵌，不命中）\n');
  const b = batchOf(TEAM, [{ id: 'p1', layer: 'plan', produce: ['plan/spec.md'] }]);
  const r = g.checkPlanContract(SESS, 'b1', b, 'p1');
  assert.equal(r.ok, false, '内嵌行不得充当元素声明：' + JSON.stringify(r));
});

// ═══════════════════════════════════════════════════════════════════════════════
// #4 plan 契约门 P4「待确认」（U-1：判定面仅 plan 层；复用既有码）
// ═══════════════════════════════════════════════════════════════════════════════

test('#4 命中 pending_marker.literal（plan 层）⇒ 拒**既有码** GATE_NEEDHUMAN_PENDING + pendingMarker 载荷', () => {
  const { state, g } = gatesWith([], { pending_marker: { literal: '[待确认]' } });
  writeArt(state, 'b1', 'plan/spec.md', SPEC_OK + '\n[待确认] 本节口径待人工裁决\n');
  const b = batchOf(TEAM, [{ id: 'p1', layer: 'plan', produce: ['plan/spec.md'] }]);
  const r = g.checkPlanContract(SESS, 'b1', b, 'p1');
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'GATE_NEEDHUMAN_PENDING', '码字面量恒为既有码（不造新码）');
  assert.equal(r.pendingMarker && r.pendingMarker.path, 'plan/spec.md');
  assert.equal(typeof r.pendingMarker.index, 'number');
});

test('#4 反例 A：**未声明** pending_marker ⇒ 同产物零感知放行', () => {
  const { state, g } = gatesWith([], {});
  writeArt(state, 'b1', 'plan/spec.md', SPEC_OK + '\n[待确认] 字样在场但资产未声明该位\n');
  const b = batchOf(TEAM, [{ id: 'p1', layer: 'plan', produce: ['plan/spec.md'] }]);
  assert.equal(g.checkPlanContract(SESS, 'b1', b, 'p1').ok, true);
});

test('#4 反例 B（U-1）：声明了该位但产物在 **audit 层** ⇒ #4 不拒', () => {
  const { state, g } = gatesWith([], { pending_marker: { literal: '[待确认]' } });
  writeArt(state, 'b1', 'audit/a1.md', '验收记录\n[待确认] 本项存疑\n');
  const b = batchOf(TEAM, [{ id: 'a1', layer: 'audit', consume: ['plan/spec.md'], produce: ['audit/a1.md'] }]);
  assert.equal(g.checkExitGate(SESS, 'b1', b, 'a1').ok, true, 'audit 层不得被 #4 拦');
  const nh = g.checkNeedHumanGate(SESS, 'b1', b, 'a1', null);
  assert.equal(nh.declared, false, 'audit 侧仍只认既有独立行 `needHuman: true`（本批一字不动）');
});

test('#4 优先级：契约缺陷（缺判据章节）先行 ⇒ 报 GATE_PLAN_CONTRACT（拒因不互相掩盖）', () => {
  const { state, g } = gatesWith([], { pending_marker: { literal: '[待确认]' } });
  writeArt(state, 'b1', 'plan/spec.md', '# Spec（两章节全缺）\n[待确认]\n');
  const b = batchOf(TEAM, [{ id: 'p1', layer: 'plan', produce: ['plan/spec.md'] }]);
  const r = g.checkPlanContract(SESS, 'b1', b, 'p1');
  assert.equal(r.code, 'GATE_PLAN_CONTRACT');
});

// ═══════════════════════════════════════════════════════════════════════════════
// #6 `gateStatusOfLane` 只增 `vocabulary` 展示位
// ═══════════════════════════════════════════════════════════════════════════════

function writeBatchFile(state, batchId, batch) {
  const dir = path.join(state, 'sessions', SESS, 'batches');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, batchId + '.json'), JSON.stringify({ ...batch, batchId }), 'utf8');
  return batchId;
}

test('#6 gateStatusOfLane：新增 `vocabulary:{loaded,version,source}`（恰好三键，纯展示位）', () => {
  const { state, g } = gatesWith([]);
  const b = batchOf(TEAM, [{ id: 'e1', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e1.md'] }], { e1: 'pending' });
  writeBatchFile(state, 'b1', b);
  const view = g.gateStatus(SESS, 'b1', 'e1');
  assert.deepEqual(view.vocabulary, { loaded: true, version: 1, source: VOCABULARY_REL });
  assert.deepEqual(Object.keys(view.vocabulary), ['loaded', 'version', 'source']);
});

test('#6 词表不可用 ⇒ `loaded:false`（version/source 为 null），**其余字段逐字不变**', () => {
  const okSide = gatesWith([]);
  const badSide = gatesWith([], {}, { brokenVocab: true });
  const b = batchOf(TEAM, [{ id: 'e1', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e1.md'] }], { e1: 'pending' });
  writeBatchFile(okSide.state, 'b1', b);
  writeBatchFile(badSide.state, 'b1', b);
  const a = okSide.g.gateStatus(SESS, 'b1', 'e1');
  const c = badSide.g.gateStatus(SESS, 'b1', 'e1');
  assert.deepEqual(c.vocabulary, { loaded: false, version: null, source: null });
  // 纯展示位：去掉新键后两侧**全等**（不参与任何判定）
  const strip = (v) => { const { vocabulary, ...rest } = v; return rest; };
  assert.deepEqual(strip(c), strip(a));
});

// ═══════════════════════════════════════════════════════════════════════════════
// U-2 严格生效（源码级回归锁）+ 契约码面 + 生成物同批
// ═══════════════════════════════════════════════════════════════════════════════

test('U-2 严格生效：无 env 关阀 / 无按批龄分流分支（源码级）', () => {
  const src = fs.readFileSync(path.join(PKG_ROOT, 'lib', 'state', 'gates.ts'), 'utf8');
  assert.equal(/PUNKY_R1_VOCAB|VOCAB_ENABLED/.test(src), false, '不得引入 env 默认关阀');
  assert.equal(/createdAt\s*[<>]/.test(src), false, '不得引入按批次创建时间的分流分支');
  // 说明：`batch.createdAt` 在 R1 **之前**即有一处既有用途（`laneStartedAt` 的防御性回落：
  //   「无可用事件 → 回退 batch.createdAt」），它不是分流门、本批不改；本用例只锁「新增分流」两种签名。
  //   P5 的完整机检原始读数（含该既有命中）见 `exec/gate-layer.md`。
  const hits = src.split('\n').filter((l) => l.includes('batch.createdAt'));
  assert.ok(hits.length >= 1, '既有防御性回落须仍在场（防误删既有码）');
  assert.equal(hits.length, 2, '既有命中数须恒为 2（1 注释 + 1 return）——任一新增即拒：' + JSON.stringify(hits));
});

test('契约码面：`GateErrorCode` 新增 2 条，源与生成物同批', () => {
  const ts = fs.readFileSync(path.join(PKG_ROOT, 'lib', 'types', 'contracts.ts'), 'utf8');
  const union = ts.match(/export type GateErrorCode =([\s\S]*?);/);
  assert.ok(union, '须找到 GateErrorCode 联合类型');
  assert.ok(union[1].includes("'GATE_TOKEN_UNKNOWN'"), 'TS 源须登记 GATE_TOKEN_UNKNOWN');
  assert.ok(union[1].includes("'GATE_VOCAB_INVALID'"), 'TS 源须登记 GATE_VOCAB_INVALID');
  const dts = fs.readFileSync(path.join(PKG_ROOT, 'lib', 'types', 'contracts.d.ts'), 'utf8');
  assert.ok(dts.includes("'GATE_TOKEN_UNKNOWN'") && dts.includes("'GATE_VOCAB_INVALID'"), '生成物 contracts.d.ts 须同批（禁只改源）');
});

test('P11 生成物同批：gates.js / gates.d.ts 含本批新增符号；`.tsbuild` 不得留盘', () => {
  assert.equal(fs.existsSync(path.join(PKG_ROOT, '.tsbuild')), false, '.tsbuild 不得留盘（受控编译后须清）');
  const js = fs.readFileSync(path.join(PKG_ROOT, 'lib', 'state', 'gates.js'), 'utf8');
  assert.ok(js.includes('detectPendingMarker'), 'gates.js 须含新纯函数');
  assert.ok(js.includes('GATE_TOKEN_UNKNOWN'), 'gates.js 须含新拒码字面量');
  assert.ok(js.includes(VOCABULARY_REL), 'gates.js 须经词表读端（import 同源）');
  const dts = fs.readFileSync(path.join(PKG_ROOT, 'lib', 'state', 'gates.d.ts'), 'utf8');
  assert.ok(dts.includes('detectPendingMarker'), 'gates.d.ts 须同步（禁手改，须经 tsc）');
});

test('词表读端契约自证：夹具词表本身须 schema 自洽（防「用坏夹具测出假绿」）', () => {
  const pkg = mkPkg();
  seedVocab(pkg, [ENTRY_ACTIVE, ENTRY_RETIRED]);
  assert.equal(loadVocabulary({ root: pkg }).ok, true, '夹具词表须通过 validateVocabulary');
});
