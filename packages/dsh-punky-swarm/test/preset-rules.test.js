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

// Step1 预设片段测试（T-1/T-2）：presets/hook-rules/ 三文件结构/形状/唯一性/防误拦静态 +
//   kernel.decide 裁决 fixture（F-01~F-15）+ 防误拦运行期回归（R-1~R-4）。
// 依据：preset-impl-design.md §1/§3/§4（Step1 零引擎改动）；acceptance.md C1（F-14 reason 仅 hard 档 message 修正）。
// 纪律：fixture 期望按实际 kernel 行为写（先读 kernel.js/classify.js 再断言，不盲从早期设计文本）。
// 直引 ../lib/governance/*.js 编译产物（npm run build 回拷 .js，与既有 governance-*.test.js 同一模式）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGovernanceKernel } from '../lib/governance/kernel.js';
import { resolveGovernanceConfig } from '../lib/governance/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const presetsDir = join(__dirname, '..', 'presets', 'hook-rules');

function loadPreset(file) {
  const raw = readFileSync(join(presetsDir, file), 'utf8');
  assert.ok(!raw.startsWith('\uFEFF'), `${file} 不应含 UTF-8 BOM`);
  return JSON.parse(raw);
}

const L1 = loadPreset('l1-sensitive.json');
const L2 = loadPreset('l2-resource.json');
const COMPOSE = loadPreset('compose.json');

// ── T-1 P-1 结构 ──

test('P-1 结构：wrapper{_meta,rules} + 条数 12/6/18 + compose 保序等价 l1∪l2', () => {
  for (const p of [L1, L2, COMPOSE]) {
    assert.ok(p && typeof p === 'object');
    assert.ok(p._meta && typeof p._meta === 'object', '_meta 存在');
    assert.ok(Array.isArray(p.rules), 'rules 数组存在');
    assert.equal(typeof p._meta.presetId, 'string');
    assert.equal(p._meta.schemaVersion, 1);
    assert.equal(p._meta.ruleCount, p.rules.length);
    assert.ok(Array.isArray(p._meta.tools) && p._meta.tools.length > 0);
    assert.ok(p._meta.notes && typeof p._meta.notes === 'object');
    assert.equal(typeof p._meta.boundary, 'string');
  }
  assert.equal(L1.rules.length, 12);
  assert.equal(L2.rules.length, 6);
  assert.equal(COMPOSE.rules.length, 18);
  assert.equal(L1._meta.presetId, 'l1-sensitive');
  assert.equal(L2._meta.presetId, 'l2-resource');
  assert.equal(COMPOSE._meta.presetId, 'compose');
  // compose = l1 展开在前 + l2 展开在后（保序逐条深度相等）
  assert.deepEqual(COMPOSE.rules.slice(0, 12), L1.rules);
  assert.deepEqual(COMPOSE.rules.slice(12, 18), L2.rules);
});

// ── T-1 P-2 形状（对齐引擎 Rule/Violation/match/narrow 契约，零依赖守卫）──

const VALID_OPS = new Set(['eq', 'gt', 'gte', 'lt', 'lte', 'in', 'regex']);
const VALID_CATEGORIES = new Set(['hard', 'pausable', 'narrowable', 'soft', 'manual_review', 'ftra', 'unknown']);

function ruleShapeErrors(rule, fileTag) {
  const errs = [];
  const tag = (msg) => `${fileTag} ${rule.id}: ${msg}`;
  if (!rule || typeof rule !== 'object') return [tag('规则非对象')];
  if (typeof rule.id !== 'string' || rule.id.length === 0) errs.push(tag('id 缺失/非 string'));
  // 内容规则必须显式 tools 白名单（缺省=全工具会命中治理族，语义约束）
  if (!Array.isArray(rule.tools) || rule.tools.length === 0 || !rule.tools.every((t) => typeof t === 'string' && t.length > 0)) {
    errs.push(tag('tools 缺失/非空 string 数组（内容规则必须显式白名单）'));
  }
  const m = rule.match;
  if (!m || typeof m !== 'object') { errs.push(tag('match 缺失')); return errs; }
  if (typeof m.path !== 'string' || m.path.length === 0 || !m.path.startsWith('/')) {
    errs.push(tag('match.path 必须为锚定实参的 JSON Pointer（非空、以 / 开头，root path 不用）'));
  }
  if (m.op !== undefined && !VALID_OPS.has(m.op)) errs.push(tag(`match.op 非法: ${m.op}`));
  if (m.op === 'regex') {
    if (typeof m.pattern !== 'string' || m.pattern.length === 0) errs.push(tag('regex 规则 pattern 缺失'));
    else { try { new RegExp(m.pattern); } catch { errs.push(tag(`regex pattern 不可编译: ${m.pattern}`)); } }
  }
  if (!Array.isArray(rule.violations) || rule.violations.length === 0) {
    errs.push(tag('violations 缺失/为空'));
    return errs;
  }
  for (const v of rule.violations) {
    if (!v || typeof v !== 'object') { errs.push(tag('violation 非对象')); continue; }
    if (typeof v.code !== 'string' || v.code.length === 0) errs.push(tag('violation.code 缺失'));
    else if (v.code !== rule.id) errs.push(tag(`violation.code(${v.code}) !== 规则 id(${rule.id})`));
    if (!VALID_CATEGORIES.has(v.category)) errs.push(tag(`violation.category 非法: ${v.category}`));
    if (typeof v.message !== 'string' || v.message.length === 0) errs.push(tag('violation.message 缺失'));
    if (v.path !== undefined && (typeof v.path !== 'string' || !v.path.startsWith('/'))) errs.push(tag('violation.path 非法'));
  }
  if (rule.narrow !== undefined) {
    if (!Array.isArray(rule.narrow) || rule.narrow.length === 0) errs.push(tag('narrow 必须为非空数组'));
    else for (const b of rule.narrow) {
      if (!b || typeof b !== 'object' || typeof b.path !== 'string' || b.path.length === 0) errs.push(tag('narrow 项 path 缺失'));
    }
  }
  return errs;
}

test('P-2 形状：18 条逐条对齐 Rule/Violation/match/narrow 契约', () => {
  const all = [...L1.rules, ...L2.rules];
  for (const [fileTag, rules] of [['l1-sensitive', L1.rules], ['l2-resource', L2.rules], ['compose', COMPOSE.rules]]) {
    for (const rule of rules) {
      const errs = ruleShapeErrors(rule, fileTag);
      assert.deepEqual(errs, [], `形状校验失败: ${errs.join(' | ')}`);
    }
  }
  assert.equal(all.length, 18);
});

test('P-2b 正则可编译 + hard/manual/narrowable 档分布符合设计', () => {
  const l1D = L1.rules.filter((r) => r.violations.some((v) => v.category === 'hard'));
  const l1A = L1.rules.filter((r) => r.violations.some((v) => v.category === 'manual_review'));
  assert.equal(l1D.length, 5); // L1-D01~D04/D09
  assert.equal(l1A.length, 7); // L1-A05~A08/A10~A12
  assert.equal(L2.rules.filter((r) => r.violations.every((v) => v.category === 'narrowable')).length, 6);
  // L2 全部规则必须带 narrow max 指引
  for (const r of L2.rules) {
    assert.ok(Array.isArray(r.narrow) && r.narrow.length >= 1 && typeof r.narrow[0].max === 'number');
  }
  // regex 规则全部可编译（含共享签名长正则）
  for (const r of [...l1D, ...l1A]) {
    if (r.match.op === 'regex') assert.doesNotThrow(() => new RegExp(r.match.pattern), `${r.id} pattern 编译`);
  }
});

// ── T-1 P-3 唯一性 ──

test('P-3 文件内规则 id 全局唯一（3 文件各自）', () => {
  for (const [tag, rules] of [['l1-sensitive', L1.rules], ['l2-resource', L2.rules], ['compose', COMPOSE.rules]]) {
    const ids = rules.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, `${tag} 含重复 id`);
  }
});

// ── T-1 P-4 防误拦静态 ──

// 治理族参考名单（audit 核实的注册工具：core 11 + lane 5 + log 1 + mailbox 3 + heartbeat 1 + longrun 1 = 21；
// 另有只读治理查询工具 compat_status 等——口径为「白名单结构性排除 + 参考名单」，非固定封闭总数）
const GOVERNANCE_TOOLS = [
  'wave_plan', 'batch_phase', 'batch_status', 'artifact_types', 'assign_check', 'asset_claim',
  'gate_status', 'lane_claim', 'lane_release', 'member_settle', 'member_status',
  'lane_worktree_create', 'lane_checkpoint', 'lane_checkpoint_status', 'lane_worktree_merge',
  'log_export', 'mailbox_send', 'mailbox_read', 'mailbox_ack', 'lane_heartbeat', 'lane_longrun',
  'compat_status',
];
// 覆盖工具并集（用户侧内容/资源面工具，10 个，与源设计 §8 一致）
const EXPECTED_COVERAGE = [
  'subagent', 'subagent_fork', 'send_message', 'workflow', 'ralph', 'web_search',
  'pwsh', 'ssh_exec', 'ssh_cluster', 'create_goal',
];

test('P-4 防误拦静态：规则 tools ∩ 治理族 = ∅；覆盖并集 = 用户侧 10 工具', () => {
  const all = [...L1.rules, ...L2.rules, ...COMPOSE.rules];
  for (const r of all) {
    for (const t of r.tools) {
      assert.ok(!GOVERNANCE_TOOLS.includes(t), `${r.id} 白名单含治理工具 ${t}`);
    }
  }
  // 反方向：3 文件 _meta.tools 并集 == 覆盖工具并集（无治理工具漏入、无缺失）
  const coverageUnion = new Set([...L1._meta.tools, ...L2._meta.tools, ...COMPOSE._meta.tools]);
  assert.deepEqual([...coverageUnion].sort(), [...EXPECTED_COVERAGE].sort());
});

// ── T-1 P-5 kernel 裁决 fixture F-01~F-15（compose 全量）──

function makeKernel(flags = {}) {
  return createGovernanceKernel(resolveGovernanceConfig({ rules: COMPOSE.rules, flags }));
}

// 工具函数：核验 decision 主字段 + 可选 reason/narrowedParams 断言
function checkDecision(d, expect) {
  assert.equal(d.primitive, expect.primitive, `primitive（${expect.label ?? ''}）`);
  assert.equal(d.priority, expect.priority, `priority（${expect.label ?? ''}）`);
  assert.deepEqual(d.ruleRefs, expect.ruleRefs, `ruleRefs（${expect.label ?? ''}）`);
  if (expect.reasonIncludes) assert.ok(d.reason.includes(expect.reasonIncludes), `reason 应含「${expect.reasonIncludes}」（${expect.label ?? ''}）实际: ${d.reason}`);
  if (expect.reasonExcludes) assert.ok(!d.reason.includes(expect.reasonExcludes), `reason 不应含「${expect.reasonExcludes}」（${expect.label ?? ''}）实际: ${d.reason}`);
  if (expect.narrowedClamped !== undefined) {
    assert.ok(d.narrowedParams, `narrowedParams 应存在（${expect.label ?? ''}）`);
    assert.deepEqual(d.narrowedParams.clamped, expect.narrowedClamped, `clamped（${expect.label ?? ''}）`);
  } else if (expect.noNarrowed) {
    assert.equal(d.narrowedParams, undefined, `narrowedParams 应缺省（${expect.label ?? ''}）`);
  }
  return d;
}

const PEM_RSA = '-----BEGIN RSA PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw\\n-----END RSA PRIVATE KEY-----';
const GH_40 = 'ghp_' + 'A'.repeat(36) + 'B'.repeat(4); // ghp_ + 40 位 [A-Za-z0-9]
const SK_24 = 'sk-' + 'a1B2c3D4e5F6g7H8i9J0kLmN'; // sk- + 24 位 [A-Za-z0-9_-]

const FIXTURES = [
  // F-01~F-07/F-12：单规则命中（源设计 T1-1~T1-12 转录，prefix 改为 F-）
  { label: 'F-01 subagent prompt 私钥块', tool: 'subagent', args: { prompt: `deploy? ${PEM_RSA}` },
    expect: { primitive: 'DENY', priority: 2, ruleRefs: ['L1-D01'] } },
  { label: 'F-02 subagent_fork prompt 含 ghp_ 令牌', tool: 'subagent_fork', args: { prompt: `use token ${GH_40}` },
    expect: { primitive: 'REQUIRE_APPROVAL', priority: 1, ruleRefs: ['L1-A05'] } },
  { label: 'F-03 send_message 内联 token 赋值', tool: 'send_message', args: { message: 'set token = "abc1234567" now' },
    expect: { primitive: 'REQUIRE_APPROVAL', priority: 1, ruleRefs: ['L1-A06'] } },
  { label: 'F-04 workflow script 带凭据 URL', tool: 'workflow', args: { script: 'const r = await fetch("https://user:pass@example.com/api")' },
    expect: { primitive: 'REQUIRE_APPROVAL', priority: 1, ruleRefs: ['L1-A07'] } },
  { label: 'F-05 ralph objective 私钥块', tool: 'ralph', args: { objective: `objective\n${PEM_RSA}` },
    expect: { primitive: 'DENY', priority: 2, ruleRefs: ['L1-D04'] } },
  { label: 'F-06 web_search 带凭据 URL', tool: 'web_search', args: { queries: ['https://u:p@example.com/q'] },
    expect: { primitive: 'DENY', priority: 2, ruleRefs: ['L1-D09'] } },
  { label: 'F-07 pwsh 内联 GH_TOKEN', tool: 'pwsh', args: { command: `$env:GH_TOKEN='${GH_40}'` },
    expect: { primitive: 'REQUIRE_APPROVAL', priority: 1, ruleRefs: ['L1-A10'] } },
  // F-08：narrowable flag-off → DENY(P4 回退)+clamped；flag-on → NARROW
  { label: 'F-08 pwsh timeoutMs 超限 flag-off', tool: 'pwsh', args: { command: 'Get-Process', timeoutMs: 600001 }, flags: {},
    expect: { primitive: 'DENY', priority: 4, ruleRefs: ['L2-R01'], narrowedClamped: [{ path: '/timeoutMs', from: 600001, to: 600000 }] } },
  { label: 'F-08b pwsh timeoutMs 超限 flag-on', tool: 'pwsh', args: { command: 'Get-Process', timeoutMs: 600001 }, flags: { narrow: true },
    expect: { primitive: 'NARROW', priority: 4, ruleRefs: ['L2-R01'], narrowedClamped: [{ path: '/timeoutMs', from: 600001, to: 600000 }] } },
  // F-09：gt 严格大于，等值不命中 → ALLOW
  { label: 'F-09 pwsh timeoutMs 等值上限', tool: 'pwsh', args: { command: 'Get-Process', timeoutMs: 600000 },
    expect: { primitive: 'ALLOW', priority: -1, ruleRefs: [] } },
  // F-10：ssh_cluster maxWorkers 边界（16 放行 / 17 命中 L2-R04）
  { label: 'F-10a ssh_cluster maxWorkers=16', tool: 'ssh_cluster', args: { command: 'uptime', maxWorkers: 16 },
    expect: { primitive: 'ALLOW', priority: -1, ruleRefs: [] } },
  { label: 'F-10b ssh_cluster maxWorkers=17', tool: 'ssh_cluster', args: { command: 'uptime', maxWorkers: 17 },
    expect: { primitive: 'DENY', priority: 4, ruleRefs: ['L2-R04'], narrowedClamped: [{ path: '/maxWorkers', from: 17, to: 16 }] } },
  // F-11：create_goal max_goal_rounds 边界（50 放行 / 51 命中 L2-R05）
  { label: 'F-11a create_goal max_goal_rounds=50', tool: 'create_goal', args: { objective: 'x', max_goal_rounds: 50 },
    expect: { primitive: 'ALLOW', priority: -1, ruleRefs: [] } },
  { label: 'F-11b create_goal max_goal_rounds=51', tool: 'create_goal', args: { objective: 'x', max_goal_rounds: 51 },
    expect: { primitive: 'DENY', priority: 4, ruleRefs: ['L2-R05'], narrowedClamped: [{ path: '/max_goal_rounds', from: 51, to: 50 }] } },
  // F-12：ralph maxRounds 边界（20 放行 / 21 命中 L2-R06）
  { label: 'F-12a ralph maxRounds=20', tool: 'ralph', args: { objective: 'x', maxRounds: 20 },
    expect: { primitive: 'ALLOW', priority: -1, ruleRefs: [] } },
  { label: 'F-12b ralph maxRounds=21', tool: 'ralph', args: { objective: 'x', maxRounds: 21 },
    expect: { primitive: 'DENY', priority: 4, ruleRefs: ['L2-R06'], narrowedClamped: [{ path: '/maxRounds', from: 21, to: 20 }] } },
  // F-13：manual_review × narrowable 同现 → REQUIRE_APPROVAL(P1)（hard 不在场），
  //   ruleRefs=[L1-A10,L2-R01] 保序；narrowedParams 缺省（REQUIRE_APPROVAL 命中不下发钳制指引，F3 固化）
  { label: 'F-13 pwsh 凭据+超限同现（flag-on）', tool: 'pwsh',
    args: { command: `export GH_TOKEN='${GH_40}'`, timeoutMs: 600001 }, flags: { narrow: true },
    expect: { primitive: 'REQUIRE_APPROVAL', priority: 1, ruleRefs: ['L1-A10', 'L2-R01'], noNarrowed: true } },
  // F-14：hard × manual_review 同现 → DENY(P2) hard 优先；reason 仅 hard 档 message（C1 修正），
  //   ruleRefs=[L1-D01,L1-A05] 保序两 id
  { label: 'F-14 subagent prompt PEM+sk- 同现', tool: 'subagent',
    args: { prompt: `${PEM_RSA}\nfallback key ${SK_24}` },
    expect: { primitive: 'DENY', priority: 2, ruleRefs: ['L1-D01', 'L1-A05'],
      reasonIncludes: '私钥材料禁止传入子代理/委托上下文', reasonExcludes: '疑似携带凭据' } },
  // F-15：ssh_cluster timeoutMs 超限 flag-off → DENY(P4 回退) + clamped to=300000
  { label: 'F-15 ssh_cluster timeoutMs 超限 flag-off', tool: 'ssh_cluster', args: { command: 'uptime', timeoutMs: 300001 },
    expect: { primitive: 'DENY', priority: 4, ruleRefs: ['L2-R03'], narrowedClamped: [{ path: '/timeoutMs', from: 300001, to: 300000 }] } },
];

for (const fx of FIXTURES) {
  test(`${fx.label}`, () => {
    const kernel = makeKernel(fx.flags ?? {});
    const d = kernel.decide({ name: fx.tool, arguments: fx.args });
    checkDecision(d, { ...fx.expect, label: fx.label });
  });
}

// ── T-2 R-1 防误拦：治理信道运行期不命中 ──

test('R-1 治理信道：mailbox/wave_plan/batch/member/log/heartbeat/gate 调用恒 ALLOW', () => {
  const kernel = makeKernel(); // 默认 flag（narrow=false）
  const govCalls = [
    { name: 'mailbox_send', arguments: { box: 'outbox', lane: 'x', message: `密钥 ${PEM_RSA} token ${GH_40}` } },
    { name: 'wave_plan', arguments: { batchId: 'b1', tasks: [{ id: 't1', cmd: `export TOKEN='${GH_40}'` }] } },
    { name: 'batch_phase', arguments: { batchId: 'b1', phase: 'running' } },
    { name: 'member_status', arguments: { batchId: 'b1', lane: 'l1', status: 'pending' } },
    { name: 'log_export', arguments: { batchId: 'b1', format: 'json' } },
    { name: 'lane_heartbeat', arguments: { batchId: 'b1' } },
    { name: 'gate_status', arguments: { batchId: 'b1' } },
    { name: 'assign_check', arguments: { scope: 'full' } },
    { name: 'compat_status', arguments: {} },
  ];
  for (const call of govCalls) {
    const d = kernel.decide(call);
    assert.equal(d.primitive, 'ALLOW', `${call.name} 应 ALLOW`);
    assert.equal(d.priority, -1);
    assert.deepEqual(d.ruleRefs, [], `${call.name} ruleRefs 应为空`);
  }
});

// ── T-2 R-2 每规则反例：同工具同 path 干净值 → ALLOW ──

test('R-2 反例：内容/资源面干净参数不命中（正反成对）', () => {
  const kernel = makeKernel();
  const cleanCalls = [
    { name: 'subagent', arguments: { prompt: '帮我把目录结构列出来并写总结' } },
    { name: 'subagent_fork', arguments: { prompt: 'review the diff in the repo' } },
    { name: 'send_message', arguments: { message: '任务完成，产物在 exec 目录' } },
    { name: 'workflow', arguments: { script: 'const out = items.map(x => x + 1); return out;' } },
    { name: 'ralph', arguments: { objective: 'verify the report structure' } },
    { name: 'web_search', arguments: { queries: ['deepseek api pricing'] } },
    { name: 'pwsh', arguments: { command: 'Get-ChildItem' } },
    { name: 'ssh_exec', arguments: { alias: 'web', command: 'uptime' } },
    { name: 'ssh_cluster', arguments: { command: 'date', timeoutMs: 300000, maxWorkers: 16 } },
    { name: 'create_goal', arguments: { objective: 'x', max_goal_rounds: 50 } },
  ];
  for (const call of cleanCalls) {
    const d = kernel.decide(call);
    assert.equal(d.primitive, 'ALLOW', `${call.name} 干净参数应 ALLOW: ${JSON.stringify(call.arguments).slice(0, 60)}`);
    assert.deepEqual(d.ruleRefs, []);
  }
});

// ── T-2 R-3 同 id 重复（F1 修正后断言：kernel 收据层去重、violations 不去重如实固化）──

test('R-3 同 id 重复规则：ruleRefs 单条（收据层去重）、reason 双份（violations 不去重）', () => {
  const dupRule = (id) => ({
    id,
    tools: ['bash'],
    match: { path: '/cmd', op: 'regex', pattern: 'rm -rf' },
    violations: [{ code: id, category: 'hard', message: '危险命令 rm -rf' }],
  });
  const kernel = createGovernanceKernel(resolveGovernanceConfig({ rules: [dupRule('R-DUP'), dupRule('R-DUP')] }));
  const d = kernel.decide({ name: 'bash', arguments: { cmd: 'rm -rf /' } });
  assert.equal(d.primitive, 'DENY');
  assert.deepEqual(d.ruleRefs, ['R-DUP']); // 收据层去重：只一条
  const occurrences = d.reason.split('危险命令 rm -rf').length - 1;
  assert.equal(occurrences, 2, `reason 应含重复 message 两次（violations 不去重）: ${d.reason}`);
});

// ── T-2 R-4 大小写：正则自含大小写容忍（引擎无 flags）──

test('R-4 大小写：Password=/password= 与 sk-/SK- 变体命中一致', () => {
  const kernel = makeKernel();
  // [Pp]assword 字面容忍首字母大小写（引擎 regex 无 flags，规则自含）
  for (const message of ['Password = abc1234567 now', 'password=abc1234567']) {
    const d = kernel.decide({ name: 'send_message', arguments: { message } });
    assert.equal(d.primitive, 'REQUIRE_APPROVAL', `大小写变体 ${message.slice(0, 12)} 应命中 A06`);
    assert.deepEqual(d.ruleRefs, ['L1-A06']);
  }
  // 字符类 [A-Za-z] 天然容忍全大小写：sk- 签名尾串大小写变体均命中 A05
  const skLower = 'sk-abcdefghijklmnopqrstuvwx';
  const skUpper = 'sk-ABCDEFGHIJKLMNOPQRSTUVWX';
  for (const prompt of [`key ${skLower}`, `key ${skUpper}`]) {
    const d = kernel.decide({ name: 'subagent', arguments: { prompt } });
    assert.equal(d.primitive, 'REQUIRE_APPROVAL', `sk- 大小写变体应命中 A05`);
    assert.deepEqual(d.ruleRefs, ['L1-A05']);
  }
});
