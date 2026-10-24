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

// L4 规则变更传播：版本化（`machine-rules`）+ 传播判定内核（`rule-propagation`）。
//
// ⚠ **本件判据锚在「回拷产物」上**（`../lib/state/*.js`，非 `.ts` 源）—— 这是 TS 类 lane 的口径：
//   只改 `.ts` 不改产物 ⇒ 运行期仍是旧的（症状 = 「自检全绿、合并后消失」）⇒ 故**必须先 `npm run build`**
//   再跑本件；本件导入的 `lib/state/rule-propagation.js` 若不在回拷清单内，会直接 `ERR_MODULE_NOT_FOUND`
//   （该 RED 读数已在 lane 产物中留痕 = 「.tsbuild 里有、lib 下没有」）。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_BATCH_RULES,
  DEFAULT_MEMBER_RULES,
  DEFAULT_RULES_VERSION,
  loadRules,
  rulesFingerprint,
} from '../lib/state/machine-rules.js';
import { evaluateRulePropagation } from '../lib/state/rule-propagation.js';

// ── ① 版本化（AC-6） ────────────────────────────────────────────────────

test('L4-AC6-1 默认来源：version = 默认表指纹、changedAt 为 ISO、source 保留', () => {
  const rules = loadRules(null);
  assert.equal(rules.source, 'default', 'source 二元标记必须保留');
  assert.equal(rules.version, DEFAULT_RULES_VERSION, '默认来源的 version 即默认表内容指纹');
  assert.match(rules.version, /^[0-9a-f]{16}$/, 'version = sha256 前 16 hex');
  assert.equal(typeof rules.changedAt, 'string');
  assert.equal(Number.isNaN(Date.parse(rules.changedAt)), false, 'changedAt 必须是可解析的 ISO 时刻');
  assert.equal(new Date(rules.changedAt).toISOString(), rules.changedAt, 'changedAt 规范形态');
  // 规则表本体零改动（与 schema 常量同引用语义不变）
  assert.deepEqual(rules.memberRules, DEFAULT_MEMBER_RULES);
  assert.deepEqual(rules.batchRules, DEFAULT_BATCH_RULES);
});

test('L4-AC6-2 配置来源：version 随内容变化，且确定性稳定', () => {
  const a = loadRules({ ratchet: { memberRules: { pending: ['running'] } } }); // 删 pending→failed/skipped（收紧）
  assert.equal(a.source, 'config');
  assert.notEqual(a.version, DEFAULT_RULES_VERSION, '内容变了 ⇒ 指纹必须变');
  assert.deepEqual(a.memberRules.pending, ['running'], '棘轮校验后的生效表');

  const b = loadRules({ ratchet: { memberRules: { pending: ['running'] } } });
  assert.equal(b.version, a.version, '同一内容 ⇒ 同一指纹（确定性、跨调用稳定）');
  // 【本批替换】原 `assert.equal(a.version, a.version)` 是**自比恒真**（同一 const 绑定、字符串字段、无 getter
  //   副作用 ⇒ 对任何实现恒真，零保护力；e2 K3 实测：把 `version` 改成随机值，红的是 `:55`，本行仍绿）。
  //   替换为**指纹覆盖面扫描**：**逐面**收紧一个 `from` 键 ⇒ 生效表必变 ⇒ 指纹必变。
  //   可达构造：让 `rulesFingerprint` 只哈希部分面/部分键（如仅 `memberRules.pending`）⇒ 未被哈希的键
  //   在此遍历中给出「指纹未变」⇒ 本行红。
  const faces = [];
  for (const [kind, table] of [['memberRules', DEFAULT_MEMBER_RULES], ['batchRules', DEFAULT_BATCH_RULES]]) {
    for (const [from, tos] of Object.entries(table)) {
      if (!Array.isArray(tos) || tos.length === 0) continue; // 该 from 无迁移可收紧 ⇒ 无构造
      faces.push({ kind, from, tighter: tos.length > 1 ? tos.slice(0, 1) : [] }); // 严格子集（棘轮允许）
    }
  }
  assert.ok(faces.length > 0, '遍历面为空（默认规则表无任何可收紧迁移）⇒ 本判据无对象');
  const uncovered = faces
    .filter(({ kind, from, tighter }) => loadRules({ ratchet: { [kind]: { [from]: tighter } } }).version
      === DEFAULT_RULES_VERSION)
    .map(({ kind, from }) => kind + '.' + from);
  assert.deepEqual(uncovered, [], '以下面被收紧后指纹未变 ⇒ rulesFingerprint 未覆盖该面：' + JSON.stringify(uncovered));

  const c = loadRules({ ratchet: { batchRules: { running: ['paused'] } } });
  assert.notEqual(c.version, a.version, '不同变更 ⇒ 不同指纹');
});

test('L4-AC6-3 内容级判定：恰好等于默认表的覆盖配置 ⇒ version 与默认相同（非「写没写」判定）', () => {
  const same = loadRules({ ratchet: { memberRules: { ...DEFAULT_MEMBER_RULES } } });
  assert.equal(same.source, 'config', '来源标记仍是 config（它描述「有没有配置」）');
  assert.equal(same.version, DEFAULT_RULES_VERSION, '但内容指纹与默认相同（它描述「内容变了没」）');
  // ⇒ 传播侧的 changed 用的是**内容指纹**而非 source 标记（见 L4-RED3-3）
});

test('L4-AC6-4 指纹口径：键序不敏感、数组顺序敏感（保守取「顺序变了也算变」）', () => {
  assert.equal(rulesFingerprint({ a: 1, b: 2 }), rulesFingerprint({ b: 2, a: 1 }), '键序不参与指纹');
  assert.equal(rulesFingerprint({ x: undefined, a: 1 }), rulesFingerprint({ a: 1 }), 'undefined 面不参与');
  assert.notEqual(
    rulesFingerprint({ a: ['x', 'y'] }),
    rulesFingerprint({ a: ['y', 'x'] }),
    '数组顺序参与指纹（无法在不引入语义假设的前提下判定某数组是否无序 ⇒ 宁可多报不可漏报）',
  );
});

// ── ② 棘轮语义零改动（AC-7 的用例侧抽样；全量读数见既有两个测试文件） ──

test('L4-AC7-1 棘轮 fail-closed 与逃生门语义一字不动', () => {
  assert.throws(() => loadRules({ ratchet: { memberRules: { nope: ['running'] } } }), /unknown state "nope"/);
  assert.throws(
    () => loadRules({ ratchet: { memberRules: { conflict: ['merged'] } } }),
    /relaxing transition "conflict -> merged"/,
    '放宽默认表 ⇒ fail-closed（未开逃生门）',
  );
  assert.throws(() => loadRules({ ratchet: { memberRules: { pending: ['running', 'running'] } } }), /duplicate targets/);
  assert.throws(() => loadRules({ ratchet: { memberRules: 'pending' } }), /must be an object/);
  // 显式逃生门：语义不变（仍须显式 true）
  const relaxed = loadRules({ ratchet: { memberRules: { review: ['merged', 'rework'] }, allowRelax: true } });
  assert.deepEqual(relaxed.memberRules.review, ['merged', 'rework']);
});

// ── ③ 传播判定：受影响集口径 + RED-3 ────────────────────────────────────

const BATCH_MIXED = Object.freeze({
  phase: 'running',
  lanes: { t1: 'merged', t2: 'review', t3: 'failed', t4: 'idle', t5: 'conflict', t6: 'skipped' },
});

test('L4-RED3-1 受影响集仅含非终态 lane（终态面：merged/failed/skipped/conflict）', () => {
  const r = evaluateRulePropagation({ batch: BATCH_MIXED, rules: loadRules(null) });
  assert.deepEqual(r.affected, ['t2', 't4'], 'review/idle 非终态 ⇒ 打标；merged/failed/skipped/conflict 终态 ⇒ 不打标');
  assert.equal(r.detail.some((d) => d.includes('t1') && d.includes('已终态')), true, '终态 lane 必须在 detail 里被点名说明');
  assert.equal(r.detail.some((d) => d.includes('t2') && d.includes('非终态')), true);
});

test('L4-RED3-2 批已终态 ⇒ 受影响集取空（批级条件先于 lane 级）', () => {
  for (const phase of ['complete', 'aborted']) {
    const r = evaluateRulePropagation({ batch: { phase, lanes: { a: 'running', b: 'pending' } }, rules: loadRules(null) });
    assert.deepEqual(r.affected, [], 'phase=' + phase + ' 终态 ⇒ 无在途 lane');
    assert.equal(r.detail.some((d) => d.includes('批已终态')), true);
  }
  // 非终态相位则照常逐 lane 判
  for (const phase of ['planning', 'running', 'paused']) {
    const r = evaluateRulePropagation({ batch: { phase, lanes: { a: 'running', b: 'merged' } }, rules: loadRules(null) });
    assert.deepEqual(r.affected, ['a'], 'phase=' + phase + ' 未终态 ⇒ 仅 a');
  }
});

test('L4-RED3-3 changed 是内容级判定：默认规则 false、收紧规则 true、等于默认的覆盖仍 false', () => {
  const base = { batch: { phase: 'running', lanes: { a: 'running' } } };
  assert.equal(evaluateRulePropagation({ ...base, rules: loadRules(null) }).changed, false, '默认规则 ⇒ 无变更');
  assert.equal(
    evaluateRulePropagation({ ...base, rules: loadRules({ ratchet: { memberRules: { pending: ['running'] } } }) }).changed,
    true,
    '收紧规则 ⇒ 有变更',
  );
  const sameAsDefault = loadRules({ ratchet: { memberRules: { ...DEFAULT_MEMBER_RULES } } });
  assert.equal(sameAsDefault.source, 'config', '来源是 config…');
  assert.equal(evaluateRulePropagation({ ...base, rules: sameAsDefault }).changed, false, '…但内容未变 ⇒ 不报变更');
});

test('L4-AC9-1 版本缺失 ⇒ 就地补算同一指纹（不静默回落成「无变更」）', () => {
  const bare = { memberRules: DEFAULT_MEMBER_RULES, batchRules: DEFAULT_BATCH_RULES };
  const r = evaluateRulePropagation({ batch: { phase: 'running', lanes: { a: 'running' } }, rules: bare });
  assert.equal(r.version, DEFAULT_RULES_VERSION, '按规则表就地补算，与单一计算点同值');
  assert.equal(r.changed, false);

  const bareChanged = { memberRules: { ...DEFAULT_MEMBER_RULES, pending: ['running'] }, batchRules: DEFAULT_BATCH_RULES };
  const r2 = evaluateRulePropagation({ batch: { phase: 'running', lanes: { a: 'running' } }, rules: bareChanged });
  assert.notEqual(r2.version, DEFAULT_RULES_VERSION);
  assert.equal(r2.changed, true, '缺 version 也必须能判出「变了」');
});

test('L4-AC9-2 指纹完全不可得 ⇒ 回落 source 标记并在 detail 里点名（不静默）', () => {
  const r = evaluateRulePropagation({ batch: { phase: 'running', lanes: { a: 'running' } }, rules: { source: 'config' } });
  assert.equal(r.version, null);
  assert.equal(r.changed, true, '回落 = source === config');
  assert.equal(r.detail.some((d) => d.includes('回落')), true, '回落必须留痕');

  const rDefault = evaluateRulePropagation({ batch: { phase: 'running', lanes: { a: 'running' } }, rules: { source: 'default' } });
  assert.equal(rDefault.changed, false);
  assert.equal(rDefault.version, null);
});

test('L4-AC9-3 变更面点名：可达面在册、不可达面如实标注（不假装覆盖）', () => {
  const r = evaluateRulePropagation({ batch: { phase: 'running', lanes: { a: 'running' } }, rules: loadRules(null) });
  const faceLine = r.detail.find((d) => d.includes('变更面'));
  assert.equal(typeof faceLine, 'string', 'detail 必须点名变更面');
  assert.equal(faceLine.includes('ratchet.memberRules'), true);
  assert.equal(faceLine.includes('ratchet.batchRules'), true);
  assert.equal(faceLine.includes('capabilities.*'), true, '不可达面也要如实点名');
  assert.equal(faceLine.includes('governance.hook.rules'), true);
});

test('L4-AC9-4 形状不可判 ⇒ 空集 + 响亮点名（不抛：附加面异常不得阻断主流程）', () => {
  const cases = [
    { label: '缺 batch', input: { rules: loadRules(null) } },
    { label: 'batch 非对象', input: { batch: 42, rules: loadRules(null) } },
    { label: '缺 lanes', input: { batch: { phase: 'running' }, rules: loadRules(null) } },
    { label: 'lanes 是数组', input: { batch: { phase: 'running', lanes: ['running'] }, rules: loadRules(null) } },
  ];
  for (const c of cases) {
    const r = evaluateRulePropagation(c.input);
    assert.deepEqual(r.affected, [], c.label + '：不冒险打标');
    assert.equal(r.detail.some((d) => d.includes('⚠')), true, c.label + '：必须响亮点名');
  }
  // 空 lane 映射：批未终态但无 lane
  const empty = evaluateRulePropagation({ batch: { phase: 'running', lanes: {} }, rules: loadRules(null) });
  assert.deepEqual(empty.affected, []);
  assert.equal(empty.detail.some((d) => d.includes('0 / 总 lane 0')), true);
});

test('L4-AC9-5 输出确定性：affected 字典序稳定（同一输入两次同值）', () => {
  const z = { phase: 'running', lanes: { zz: 'running', aa: 'pending', mm: 'review' } };
  const r1 = evaluateRulePropagation({ batch: z, rules: loadRules(null) });
  const r2 = evaluateRulePropagation({ batch: z, rules: loadRules(null) });
  assert.deepEqual(r1.affected, ['aa', 'mm', 'zz'], '字典序');
  assert.deepEqual(r1.affected, r2.affected);
  assert.deepEqual(r1.detail, r2.detail, 'detail 亦确定');
});
