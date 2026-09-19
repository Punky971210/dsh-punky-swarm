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

// Step2 preset 装载单测（T-3）：preset-loader（registry/装载/形状/坏目录容错）+
//   resolveGovernanceConfig preset 装载语义（展开/拼接/拒绝/回退/warn 被调断言/EXPECT_DEFAULTS 回归）。
// 纪律：直引 ../lib/governance/*.js 编译产物（npm run build 回拷 .js）；fixture 按实现行为断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveGovernanceConfig, validateRuleTable, validatePresetRules, validateToolBanEntries, validateToolBanTable } from '../lib/governance/config.js';
import { loadPresetFile, loadPresetTable, PRESET_IDS, PRESETS_DIR } from '../lib/governance/preset-loader.js';

// ── 真实 preset 表（包内 presets/hook-rules/ 四文件，随 npm test 构建后目录恒定）──
// 双表：TABLE = 参数级规则面（l1/l2）；BAN_TABLE = 第三类工具黑名单面（l3-tool-ban）；compose 组合项已废除
const REAL = loadPresetTable();
const TABLE = REAL.table;
const BAN_TABLE = REAL.banTable;

// 最小合法规则（过 validatePresetRules 的形状基线；violations.code 与规则 id 不强绑定——引擎按 category 消费）
function rule(id, over = {}) {
  return { id, tools: ['bash'], match: { path: '/cmd', op: 'regex', pattern: 'rm -rf' }, violations: [{ code: id, category: 'hard', message: 'm' }], ...over };
}
function wrapper(rules, metaOver = {}) {
  return JSON.stringify({ _meta: { presetId: 'x', schemaVersion: 1, ...metaOver }, rules });
}
// 第三类判定面 wrapper（toolBan 面；l3-tool-ban.json 的文件形态）
function banWrapper(toolBan, metaOver = {}) {
  return JSON.stringify({ _meta: { presetId: 'x', schemaVersion: 1, ...metaOver }, toolBan });
}
// 最小合法黑名单条目（过 validateToolBanEntries 形状基线）
function banEntry(id, over = {}) {
  return { id, tool: 'pwsh', behavior: 'file-write', code: id, category: 'hard', message: 'm', ...over };
}

function freshTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'punky-preset-loader-'));
}

test('L-1 注册枚举：PRESET_IDS = 3 注册 id（l1/l2 + 第三类 l3-tool-ban；compose 组合项已废除）；PRESETS_DIR 指向随包 presets/hook-rules', () => {
  assert.deepEqual([...PRESET_IDS], ['l1-sensitive', 'l2-resource', 'l3-tool-ban']);
  assert.equal(path.basename(PRESETS_DIR), 'hook-rules');
  assert.equal(path.basename(path.dirname(PRESETS_DIR)), 'presets');
  for (const id of PRESET_IDS) {
    assert.equal(fs.existsSync(path.join(PRESETS_DIR, id + '.json')), true, `${id}.json 存在`);
  }
});

test('L-2 loadPresetTable()：双表分派（rules 面 3 id + toolBan 面 l3-tool-ban）、_meta 剥离、errors 空', () => {
  // rules 面：l1/l2 —— l3-tool-ban 无 rules ⇒ 不入 table（catalog 计数由两表并计）
  assert.deepEqual(Object.keys(REAL.table), ['l1-sensitive', 'l2-resource']);
  // toolBan 面（第三类判定面）：仅 l3-tool-ban 有黑名单条目
  assert.deepEqual(Object.keys(REAL.banTable), ['l3-tool-ban']);
  assert.deepEqual(REAL.errors, []);
  assert.equal(REAL.table['l1-sensitive'].length, 12);
  assert.equal(REAL.table['l2-resource'].length, 6);
  assert.equal(REAL.banTable['l3-tool-ban'].length, 1);
  for (const id of Object.keys(REAL.table)) {
    for (const r of REAL.table[id]) {
      assert.equal('_meta' in r, false, `${id} 规则 ${r.id} 不应含 _meta（剥离语义：loader 只剥 _meta 不洗规则）`);
      assert.ok(r && typeof r.id === 'string');
    }
  }
  for (const e of REAL.banTable['l3-tool-ban']) {
    assert.equal('_meta' in e, false, `黑名单条目 ${e.id} 不应含 _meta（剥离语义）`);
    assert.ok(e && typeof e.id === 'string' && e.tool === 'pwsh' && e.behavior === 'file-write');
  }
});

test('L-3 loadPresetFile：注册 id 单文件装载成功；未知 id 拒绝（ok:false + 注册枚举提示）', () => {
  const ok = loadPresetFile('l1-sensitive');
  assert.equal(ok.ok, true);
  assert.equal(ok.rules.length, 12);
  const bad = loadPresetFile('no-such');
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /未知 preset id 'no-such'/);
  assert.match(bad.errors[0], /l1-sensitive/);
});

test('L-4 坏目录容错：单文件失败 → 该 id 不入表 + errors 收集，其余照常（不 throw）', () => {
  // (a) 全坏：坏 JSON / 顶层非 wrapper / 黑名单形状坏 → 3 id 全失败、errors 逐文件收集、双表皆空
  const dirAll = freshTmp();
  fs.writeFileSync(path.join(dirAll, 'l1-sensitive.json'), '{ not json');
  fs.writeFileSync(path.join(dirAll, 'l2-resource.json'), JSON.stringify({ rules: 'nope' }));
  fs.writeFileSync(path.join(dirAll, 'l3-tool-ban.json'), banWrapper([banEntry('L3-W01', { behavior: 'bogus' })]));
  const rAll = loadPresetTable(dirAll);
  assert.deepEqual(Object.keys(rAll.table), [], '全坏目录 → 零 id 入 rules 表');
  assert.deepEqual(Object.keys(rAll.banTable), [], '全坏目录 → 零 id 入 toolBan 表');
  assert.equal(rAll.errors.length, 3, '每文件一条错误（实际: ' + rAll.errors.join(' | ') + '）');
  assert.ok(rAll.errors.some((e) => e.includes('JSON.parse 失败')));
  assert.ok(rAll.errors.some((e) => e.includes('顶层结构非法')));
  assert.ok(rAll.errors.some((e) => e.includes('behavior 非法')), '黑名单形状错误定位到 behavior（实际: ' + rAll.errors.join(' | ') + '）');
  // (b) 单坏：l2 坏、l1/l3 好 → rules 表 1 id、toolBan 表 1 id、errors 仅指向坏 id
  const dirOne = freshTmp();
  fs.writeFileSync(path.join(dirOne, 'l1-sensitive.json'), wrapper([rule('R1')]));
  fs.writeFileSync(path.join(dirOne, 'l2-resource.json'), wrapper([{ id: 'R2' }])); // violations 缺失 → 形状坏
  fs.writeFileSync(path.join(dirOne, 'l3-tool-ban.json'), banWrapper([banEntry('L3-W01')]));
  const rOne = loadPresetTable(dirOne);
  assert.deepEqual(Object.keys(rOne.table), ['l1-sensitive'], '坏文件单 id 不入表、其余照常');
  assert.deepEqual(Object.keys(rOne.banTable), ['l3-tool-ban'], 'toolBan 面照常装载（与 rules 面互不影响）');
  assert.ok(rOne.errors.length >= 1, '坏文件错误按条收集（该文件形状错误逐条入 errors）');
  assert.ok(rOne.errors.every((e) => e.includes('l2-resource')), '错误全部定位到坏 preset id（实际: ' + rOne.errors.join(' | ') + '）');
});

test('L-5 validatePresetRules：合法规则通过；坏形状逐条报（id/violations/category/match.op/regex/narrow）', () => {
  assert.equal(validatePresetRules([rule('R1')]).ok, true);
  assert.equal(validatePresetRules([]).ok, true, '空数组 = 空表合法（无规则）');
  assert.equal(validatePresetRules('nope').ok, false, '顶层非数组拒绝');
  const cases = [
    [[{ ...rule('R1'), id: '' }], /id 缺失/],
    [[{ ...rule('R1'), match: { path: '/a', op: 'bogus' } }], /match\.op 非法/],
    [[{ ...rule('R1'), violations: [] }], /violations 缺失\/为空/],
    [[{ ...rule('R1'), violations: [{ code: 'R1', category: 'notacat', message: 'm' }] }], /category 非法/],
    [[{ ...rule('R1'), match: { path: '/cmd', op: 'regex', pattern: '(' } }], /pattern 不可编译/],
    [[{ ...rule('R1'), narrow: [{ max: 5 }] }], /narrow\[\]\.path/],
    [[rule('R1'), rule('R1')], /duplicate rule id 'R1' \(2x\)/], // 文件内重复 id
  ];
  for (const [rules, re] of cases) {
    const v = validatePresetRules(rules);
    assert.equal(v.ok, false, '应拒绝: ' + JSON.stringify(rules).slice(0, 60));
    assert.ok(v.errors.some((e) => re.test(e)), `错误应匹配 ${re}: ${v.errors.join(' | ')}`);
  }
});

test('L-6 validateRuleTable：全表 id 唯一性——重复 id 报次数、空 id/非 string id/非对象拒绝；空表 ok', () => {
  assert.equal(validateRuleTable([]).ok, true);
  assert.equal(validateRuleTable([rule('R1')]).ok, true);
  const dup = validateRuleTable([rule('R1'), rule('R1'), rule('R1')]);
  assert.equal(dup.ok, false);
  assert.ok(dup.errors.some((e) => /duplicate rule id 'R1' \(3x\)/.test(e)), '文案含 id 与次数: ' + dup.errors.join(' | '));
  assert.equal(validateRuleTable([{ ...rule('R1'), id: '' }]).ok, false, '空 id 拒绝');
  assert.equal(validateRuleTable([{ ...rule('R1'), id: 42 }]).ok, false, '非 string id 拒绝');
  assert.equal(validateRuleTable([null]).ok, false, '非对象拒绝');
});

// ── T-3 resolve preset 装载语义（预设单测，无 IO；warn 经 opts 注入捕获断言）──

// 全默认期望（与 governance-config.test.js EXPECT_DEFAULTS 同构——无 preset 键零行为差回归基准）
const EXPECT_DEFAULTS = {
  enabled: true,
  rules: [],
  toolBan: [],
  defaults: { deny: 'DENY' },
  flags: { pause: false, narrow: false, defer: false },
  escalation: { enabled: false, threshold: 3, windowMs: 600000, primitives: ['DENY', 'NARROW'] },
};

test('T3-1 无 preset 键零行为差：resolve({}) / resolve({rules}) 与 EXPECT_DEFAULTS / 既有语义一致（回归）', () => {
  assert.deepEqual(resolveGovernanceConfig(undefined), EXPECT_DEFAULTS);
  assert.deepEqual(resolveGovernanceConfig({}), EXPECT_DEFAULTS);
  // 传 presetTable 也不改变无引用形态（表注入零副作用）
  assert.deepEqual(resolveGovernanceConfig({}, { presetTable: TABLE }), EXPECT_DEFAULTS);
  const c = resolveGovernanceConfig({ rules: [rule('R1')] }, { presetTable: TABLE });
  assert.equal(c.rules.length, 1);
  assert.equal(c.enabled, true);
  // enabled:false + preset 展开不抛错（rules 仍解析；hook 不挂由 wiring 语义负责）
  const off = resolveGovernanceConfig({ enabled: false, preset: ['l1-sensitive'] }, { presetTable: TABLE });
  assert.equal(off.enabled, false);
  assert.equal(off.rules.length, 12);
});

test('T3-2 单值字符串形态已废除（单选遗产）：preset:"l1-sensitive" → 形态非法回退空表 + warn；数组形态照常展开', () => {
  const warns = [];
  const single = resolveGovernanceConfig({ preset: 'l1-sensitive' }, { presetTable: TABLE, warn: (m) => warns.push(m) });
  assert.deepEqual(single.rules, [], '单值形态 → 回退空表（宁空勿半，不静默兼容）');
  assert.ok(warns.some((m) => /单值字符串形态已废除/.test(m)), 'warn 说明形态废除与数组写法（实际: ' + warns.join(' | ') + '）');
  // 数组形态（多选）= 唯一合法形态：逐条等价展开
  const c = resolveGovernanceConfig({ preset: ['l1-sensitive'] }, { presetTable: TABLE });
  assert.equal(c.rules.length, 12);
  assert.deepEqual(c.rules, [...TABLE['l1-sensitive']]);
  assert.deepEqual(c.rules.map((r) => r.id), TABLE['l1-sensitive'].map((r) => r.id));
});

test('T3-3 preset string[] 展开保序：["l1-sensitive","l2-resource"] → 18 条（L1 前 12 / L2 后 6，文件序）', () => {
  const c = resolveGovernanceConfig({ preset: ['l1-sensitive', 'l2-resource'] }, { presetTable: TABLE });
  assert.equal(c.rules.length, 18, '12 + 6 保序拼接（compose 组合项已废除，组合由数组引用表达）');
  // 保序断言：前 12 为 l1 文件序、后 6 为 l2 文件序
  assert.deepEqual(c.rules.slice(0, 12).map((r) => r.id), TABLE['l1-sensitive'].map((r) => r.id));
  assert.deepEqual(c.rules.slice(12, 18).map((r) => r.id), TABLE['l2-resource'].map((r) => r.id));
});

test('T3-4 preset + inline 共存：preset:l2-resource + inline 1 条 → 6+1 保序拼接（preset 展开前、inline 后）', () => {
  const inline = rule('MY-INLINE');
  const c = resolveGovernanceConfig({ preset: ['l2-resource'], rules: [inline] }, { presetTable: TABLE });
  assert.equal(c.rules.length, 7);
  assert.equal(c.rules[0].id, 'L2-R01');
  assert.equal(c.rules[5].id, 'L2-R06');
  assert.equal(c.rules[6].id, 'MY-INLINE', 'inline 规则拼在 preset 展开之后');
});

test('T3-5 未知 id：preset:no-such → 装载失败回退 rules:[] + warn 含未知 preset id（opts.warn 捕获断言）', () => {
  const warns = [];
  const c = resolveGovernanceConfig({ preset: ['no-such'] }, { presetTable: TABLE, warn: (m) => warns.push(m) });
  assert.deepEqual(c.rules, [], '未知 id → 回退空表（宁空勿半）');
  assert.ok(warns.some((m) => m.includes("未知 preset id 'no-such'")), 'warn 应被调用并含未知 id（实际: ' + warns.join(' | ') + '）');
});

test('T3-6 跨引用重复 id：同一 preset 引用两次 → 展开后 rule id 撞车 → validateRuleTable 拒绝回退空表 + warn', () => {
  const warns = [];
  const c = resolveGovernanceConfig(
    { preset: ['l1-sensitive', 'l1-sensitive'] },
    { presetTable: TABLE, warn: (m) => warns.push(m) },
  );
  assert.deepEqual(c.rules, [], '重复 id（引用误用）→ 回退空表');
  assert.ok(warns.some((m) => /duplicate rule id 'L1-D01'/.test(m)), 'warn 列重复 id（实际: ' + warns.join(' | ') + '）');
});

test('T3-7 preset×inline 重复：preset:l1-sensitive + inline rules 含同 id L1-D01 → 拒绝回退空表 + warn', () => {
  const warns = [];
  const c = resolveGovernanceConfig(
    { preset: ['l1-sensitive'], rules: [rule('L1-D01')] },
    { presetTable: TABLE, warn: (m) => warns.push(m) },
  );
  assert.deepEqual(c.rules, [], 'preset×inline 重复 id → 回退空表');
  assert.ok(warns.some((m) => /duplicate rule id 'L1-D01'/.test(m)));
});

test('T3-8 引用形态非法：preset 数字 / 数组含非 string / 空串 / 空数组 → 回退空表 + warn；presetTable 缺省引用任何 id → 拒绝', () => {
  const warns = [];
  const table2 = { 'l1-sensitive': [...TABLE['l1-sensitive']] }; // 仅注册 l1 的自定义表（缺 id 探测）
  // 数字 → 类型非法
  const c1 = resolveGovernanceConfig({ preset: 42 }, { presetTable: table2, warn: (m) => warns.push(m) });
  assert.deepEqual(c1.rules, [], '数字引用拒绝');
  // 数组含非 string
  const c2 = resolveGovernanceConfig({ preset: ['l1-sensitive', 7] }, { presetTable: table2, warn: (m) => warns.push(m) });
  assert.deepEqual(c2.rules, [], '数组含非 string → 回退空表（部分有效引用不半装载）');
  assert.ok(warns.some((m) => /元素非法/.test(m)));
  // 空串
  const c3 = resolveGovernanceConfig({ preset: '' }, { presetTable: table2, warn: (m) => warns.push(m) });
  assert.deepEqual(c3.rules, []);
  // 空数组
  const c4 = resolveGovernanceConfig({ preset: [] }, { presetTable: table2, warn: (m) => warns.push(m) });
  assert.deepEqual(c4.rules, [], '空数组无意义引用 → 回退空表');
  assert.ok(warns.length >= 4, '每形态各 warn 一次（实际 ' + warns.length + ' 次）');
  // 表缺注册 id（未知 id 语义）：自定义表只含 l1 的 rules，引用 l3-tool-ban（table/banTable 皆无）→ 拒绝
  const c5 = resolveGovernanceConfig({ preset: 'l3-tool-ban' }, { presetTable: table2, warn: (m) => warns.push(m) });
  assert.deepEqual(c5.rules, [], 'presetTable 缺该 id → 判未知 id 拒绝（缺省/部分表不识别）');
  // presetTable 完全不注入（缺省 opts）→ 任何引用都拒绝（设计：缺省表 = 所有 id 未注册）
  const warns2 = [];
  const c6 = resolveGovernanceConfig({ preset: ['l1-sensitive'] }, { warn: (m) => warns2.push(m) });
  assert.deepEqual(c6.rules, [], 'presetTable 缺省 → 引用判未注册回退空表');
  assert.ok(warns2.some((m) => m.includes('未知 preset id')));
});

test('T3-9 装载成功无 warn：合法展开零 warn（防误报回归——成功路径不污染日志）', () => {
  const warns = [];
  resolveGovernanceConfig({ preset: ['l1-sensitive'] }, { presetTable: TABLE, warn: (m) => warns.push(m) });
  resolveGovernanceConfig({ preset: ['l1-sensitive', 'l2-resource'], rules: [rule('MY-INLINE')] }, { presetTable: TABLE, warn: (m) => warns.push(m) });
  assert.deepEqual(warns, [], '合法装载/展开零 warn');
});
