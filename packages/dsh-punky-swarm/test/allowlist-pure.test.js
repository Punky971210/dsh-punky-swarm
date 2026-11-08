// I-24 · 策略纯函数（T-cmd：node --test test/allowlist-pure.test.js）
//
// 判据纪律：
//   · **纯** ⇒ 同输入同输出 + 入参不被改 + 零隐式取值（不读盘/环 境/时钟/随机）；
//   · **单点** ⇒ `decide` 定义只此一处，工具层只调用、不内联匹配；
//   · **摘要单点** ⇒ `canonicalDigest` 全仓一份，且对「键序 / 类型 / 数组顺序」的敏感度**方向正确**。
// 反例方向（每条都能红）：把 canonicalFormOf 的键排序去掉 ⇒ 键序用例红；
//   去掉类型前缀 ⇒ `1` vs `'1'` 用例红；把数组当集合先排序 ⇒ 数组顺序用例红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  decide, canonicalDigest, ALLOWLIST_DENIED, ASK_REQUIRED,
} from '../lib/governance/allowlist.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST_SRC = join(ROOT, 'lib', 'governance', 'allowlist.js');
const TIER_GATE_SRC = join(ROOT, 'lib', 'tools', 'tier-gate.js');
const WIRING_SRC = join(ROOT, 'lib', 'governance', 'wiring.js');

/** 递归收集 lib/ 下的 .js（用于「定义只此一处」的仓级判定）。 */
function jsFilesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...jsFilesUnder(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('I-24-1 纯函数性：同一输入连续 5 次结果全同（deepEqual），且入参未被修改', () => {
  const input = {
    toolName: 'write',
    args: { path: 'a.md', content: 'hello' },
    allowlist: [{ tool: 'write', requireApproval: true }],
    facts: {},
  };
  const snapshot = JSON.stringify(input);
  const runs = Array.from({ length: 5 }, () => decide(input));
  for (const r of runs) assert.deepEqual(r, runs[0], '同输入必须同输出（无隐藏状态）');
  assert.equal(JSON.stringify(input), snapshot, '判定不得修改入参');
});

test('I-24-2 零隐式取值：不读盘 / 不读环境 / 不取时钟 / 不用随机（源码级 + 行为级）', () => {
  const src = readFileSync(ALLOWLIST_SRC, 'utf8');
  // 源码级：任何外部读取/时钟/随机的痕迹都不许有
  const forbidden = /(fs\.|store\.|ctx\.|process\.env|Date\.now|Math\.random|randomUUID)/;
  assert.equal(forbidden.test(src), false, '纯度：不得出现外部取值痕迹');
  // 依赖面：只允许 node:crypto 的确定性哈希（无 IO）
  const imports = src.split('\n').filter((l) => l.startsWith('import '));
  assert.deepEqual(imports, ["import { createHash } from 'node:crypto';"], '唯一 import 必须是确定性哈希');
  // 行为级：判定结果与「当前时间/环境」无关 —— 环境变量变化后结果不变
  const before = decide({ toolName: 'write', args: {}, allowlist: ['write'] });
  process.env.PUNKY_ALLOWLIST_PROBE = 'changed';
  const after = decide({ toolName: 'write', args: {}, allowlist: ['write'] });
  delete process.env.PUNKY_ALLOWLIST_PROBE;
  assert.deepEqual(after, before, '环境变化不得影响判定（证明没读环境）');
});

test('I-24-3 单点判定：decide 定义仅 1 处；判据落点 = wiring（⑥-2 起）、无内联匹配或摘要重写', () => {
  const definers = jsFilesUnder(join(ROOT, 'lib')).filter((p) => /^(export )?function decide\b/m.test(readFileSync(p, 'utf8')));
  // 路径归一化（Windows 反斜杠 ⇒ 断言面向逻辑路径，不面向平台分隔符）
  assert.deepEqual(definers.map((p) => p.slice(ROOT.length + 1).replace(/\\/g, '/')), ['lib/governance/allowlist.js'],
    'decide 定义必须只此一处（第二份判定即第二真源）');

  // 【⑥-2 · 2026-11-08 裁决丙】判据落点从 `tools/tier-gate.js` 迁到 `governance/wiring.js`
  //   （只有 hook 能产真正的审批态）。断言随之改指新落点 —— 若谁把判定搬回工具层，这里立刻红。
  const wiring = readFileSync(WIRING_SRC, 'utf8');
  assert.ok(wiring.includes('decideAllowlist('), 'wiring 必须实际调用纯函数（判据唯一落点）');
  assert.equal(/allowlist[A-Za-z]*\.(includes|some|filter)/.test(wiring), false, 'wiring 内不得内联白名单匹配');
  assert.equal(/\.includes\(allowlist/.test(wiring), false, 'wiring 内不得自写命中判断');
  assert.ok(/^import \{[^}]*canonicalDigest[^}]*\} from '\.\/allowlist\.js';$/m.test(wiring),
    '摘要必须从单点模块 import（禁自造第二份摘要）');
  assert.equal(/^(export )?function canonicalDigest\b/m.test(wiring), false, 'wiring 内不得再定义摘要函数');

  // 反向：工具层不得再持有判据（搬迁的防回生面）
  const gate = readFileSync(TIER_GATE_SRC, 'utf8');
  assert.equal(/decideAllowlist|canonicalDigest/.test(gate), false,
    'tier-gate 不得再引 allowlist 判据（⑥-2 起判据归 wiring；回迁即双真源）');
});

test('I-24-4 canonicalDigest 敏感性（方向正确）：键序无关、类型与数组顺序敏感', () => {
  const base = canonicalDigest({ a: 1, b: 'x' });
  assert.match(base, /^sha256:[0-9a-f]{64}$/, '摘要形状 = sha256:<64 hex>');

  // 键序变化 ⇒ **相同**（规范化：键排序）
  assert.equal(canonicalDigest({ b: 'x', a: 1 }), base, '键序不得影响摘要（否则同一组参数会有两个身份）');
  // 类型变化 ⇒ **必变**
  assert.notEqual(canonicalDigest({ a: '1', b: 'x' }), base, '类型 1 → "1" 必须改变摘要');
  // 数组顺序 ⇒ **必变**
  assert.notEqual(canonicalDigest({ a: [1, 2] }), canonicalDigest({ a: [2, 1] }), '数组顺序必须敏感');
  // 稳定性
  assert.equal(canonicalDigest({ a: 1, b: 'x' }), base, '重复调用必须稳定');
});

test('I-24-5 default deny：空白名单 / 未命中 均拒，且拒因带前缀与工具名', () => {
  const empty = decide({ toolName: 'write', args: {}, allowlist: [] });
  assert.equal(empty.decision, 'deny', '空白名单 = 无任何工具被许可（default deny，禁「空即放行」）');
  assert.ok(empty.reason.startsWith(ALLOWLIST_DENIED), '拒因前缀必须是 ALLOWLIST_DENIED');
  assert.ok(empty.reason.includes('write'), '拒因必须带工具名');

  const miss = decide({ toolName: 'subagent', args: {}, allowlist: ['write'] });
  assert.equal(miss.decision, 'deny');
  assert.ok(miss.reason.includes('subagent'));

  // 两态对照：命中同一白名单 ⇒ 放行（证「拒」不是恒真）
  assert.deepEqual(decide({ toolName: 'write', args: {}, allowlist: ['write'] }), { decision: 'allow' });
});

test('I-24-6 ask 语义两态：需批准且无批准事实 ⇒ ask；带批准事实 ⇒ allow', () => {
  const needApproval = [{ tool: 'write', requireApproval: true }];
  const ask = decide({ toolName: 'write', args: {}, allowlist: needApproval });
  assert.equal(ask.decision, 'ask');
  assert.ok(ask.reason.startsWith(ASK_REQUIRED), 'ask 前缀必须是 ASK_REQUIRED');
  assert.ok(ask.reason.includes('write'));

  assert.deepEqual(decide({ toolName: 'write', args: {}, allowlist: needApproval, facts: { approval: true } }),
    { decision: 'allow' }, '已获批准 ⇒ 放行（否则 ask 就是永远拒）');
});

test('I-24-7 参数约束两态：命中但参数越界 ⇒ 拒；参数相符 ⇒ 放行', () => {
  const constrained = [{ tool: 'write', args: { path: 'in.md' } }];
  assert.equal(decide({ toolName: 'write', args: { path: 'out.md' }, allowlist: constrained }).decision, 'deny',
    '参数越界必须拒（白名单写明的参数范围就是许可边界）');
  assert.equal(decide({ toolName: 'write', args: { path: 'in.md' }, allowlist: constrained }).decision, 'allow');
});
