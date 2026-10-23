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

// punky-fix-p2-20261023 · c1 状态面（tester 落）：`A1-P2-08`（入 idle 单点豁免入口）
//   + `A1-P2-07`（autoSettle 开关判定式单点）。
//
// ── 判据取向（先读这条，避免把本文件读成「补了一条假覆盖」）────────────────────────────
//   · `laneIdleOnRecovery` 按契约**私有、不导出**（`lib/state/store/lifecycle.js` 模块级）⇒ 测试**不能**
//     `import` 它。本文件取的是**仓内源码字节**：从该文件抽出函数原文（括号扫描），以**真实** `schema`
//     命名空间作为唯一依赖求值 ⇒ 被执行的是仓库里的实现，不是本测试手抄的副本。
//   · 每条**阴性**断言（非法 from 必 throw）都配有**同输入阳性对照**（合法 from 通过并返回原态），
//     且额外配一条「旧实现变异体」：把守卫拿掉的**无判定直写**在 `'merged'` 上**不会** throw
//     ⇒ 证明「throw」这条断言真的能区分修复前/后，不是恒真。
//   · `MEMBER_TRANSITIONS` 侧**零放宽**是本条的核心不变量（棘轮地板不得下移），故单独成例断言
//     「整张表没有任何 `→ idle` 入边」，而不是只断言一个 `('running','idle')` 对。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import * as schema from '../lib/schema.js';
import { installAutoSettle } from '../lib/engine/auto-settle.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(PKG_ROOT, rel), 'utf8');

/** 从源码文本里抽出 `function laneIdleOnRecovery(batch, lane) { … }` 的**原文**（括号扫描）。 */
function extractLaneIdleOnRecovery() {
  const src = read('lib/state/store/lifecycle.js');
  const head = 'function laneIdleOnRecovery(batch, lane) {';
  const start = src.indexOf(head);
  assert.notEqual(start, -1, '单点写入口 `laneIdleOnRecovery` 必须在 lifecycle.js 内以函数声明形态存在');
  let depth = 0;
  let end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  assert.ok(end > start, '`laneIdleOnRecovery` 的函数体必须能完整括到大括号闭合');
  return { body: src.slice(start, end), start, end };
}

/** 以真实 `schema` 为唯一依赖求值抽出的函数原文 ⇒ 返回可调用的单点写入口。 */
function loadLaneIdleOnRecovery() {
  const { body } = extractLaneIdleOnRecovery();
  // eslint-disable-next-line no-new-func -- 求值的是仓库源码原文（见文件头「判据取向」）
  const factory = new Function('schema', body + '\nreturn laneIdleOnRecovery;');
  return factory(schema);
}

/** 旧实现变异体（修复前形态）：**无任何判定**的原地直写。用于证明阴性断言可证伪。 */
function legacyUnconditionalIdleWriter(batch, lane) {
  batch.lanes[lane] = 'idle';
  return 'running';
}

// ── T-1a · 单点豁免入口的行为面 ────────────────────────────────────────────────────────
test('A1-P2-08 · 非法 from（merged）⇒ 单点写入口必 throw（阴性判据）', () => {
  const laneIdleOnRecovery = loadLaneIdleOnRecovery();
  const batch = { lanes: { l1: 'merged' } };
  assert.throws(() => laneIdleOnRecovery(batch, 'l1'), /recovery idle edge not declared/,
    '来自 `merged` 的入 idle 必须被显式拒绝（比两份直写更严）');
  assert.equal(batch.lanes.l1, 'merged', '被拒时不得留下任何写入（fail-closed 不得半改）');
});

test('A1-P2-08 · 同输入阳性对照：合法 from（running / review）通过且返回原态、成功落 idle', () => {
  const laneIdleOnRecovery = loadLaneIdleOnRecovery();
  for (const from of ['running', 'review']) {
    const batch = { lanes: { l1: from } };
    assert.equal(laneIdleOnRecovery(batch, 'l1'), from, '返回值必须是原态（`detail[].from` 的值域来源）');
    assert.equal(batch.lanes.l1, 'idle', '合法 from ⇒ 落 idle');
  }
});

test('A1-P2-08 · 非法 from 面穷举：pending / done / idle / 缺 lane / 空 batch 全部 throw', () => {
  const laneIdleOnRecovery = loadLaneIdleOnRecovery();
  for (const from of ['pending', 'done', 'idle', 'blocked', '']) {
    assert.throws(() => laneIdleOnRecovery({ lanes: { l1: from } }, 'l1'),
      /recovery idle edge not declared/, 'from=' + JSON.stringify(from) + ' 不在合法面内 ⇒ throw');
  }
  assert.throws(() => laneIdleOnRecovery({ lanes: {} }, 'ghost'), /recovery idle edge not declared/);
  assert.throws(() => laneIdleOnRecovery(null, 'l1'), /recovery idle edge not declared/);
});

test('A1-P2-08 / REVERSE · 旧实现变异体：无判定直写对 merged **不 throw** ⇒ 上述阴性断言可证伪', () => {
  // 旧形态（两处 `batch.lanes[lane] = 'idle'` 直写）对非法 from 无任何判定 ⇒ 静默改 idle。
  const batch = { lanes: { l1: 'merged' } };
  assert.doesNotThrow(() => legacyUnconditionalIdleWriter(batch, 'l1'),
    '变异体必须复现「修前不 zod throw」这一事实，否则阴性断言就是恒真');
  assert.equal(batch.lanes.l1, 'idle', '变异体把 merged 静默改成 idle —— 这正是本批要消灭的形态');
  // 对照：当前单点实现同一输入必 throw
  assert.throws(() => loadLaneIdleOnRecovery()({ lanes: { l1: 'merged' } }, 'l1'),
    /recovery idle edge not declared/);
});

// ── T-1b · 合法面声明与迁移表零放宽 ────────────────────────────────────────────────────
test('A1-P2-08 · RECOVERY_IDLE_FROM 冻结且值 = [running, review]（唯一声明面）', () => {
  assert.ok(Array.isArray(schema.RECOVERY_IDLE_FROM), '合法面必须是数组');
  assert.equal(Object.isFrozen(schema.RECOVERY_IDLE_FROM), true, '合法面必须冻结（防运行期被扩写）');
  assert.deepEqual([...schema.RECOVERY_IDLE_FROM], ['running', 'review']);
});

test('A1-P2-08 · MEMBER_TRANSITIONS 零放宽：整张表**没有任何** `→ idle` 入边', () => {
  // 逐 from-state 扫，而不是只测一个 (running, idle) 对 —— 加边可能加在任意一态上。
  const inboundIdle = [];
  for (const [from, tos] of Object.entries(schema.MEMBER_TRANSITIONS)) {
    if (Array.isArray(tos) && tos.includes('idle')) inboundIdle.push(from);
  }
  assert.deepEqual(inboundIdle, [], '迁移表不得出现任何入 idle 的边（棘轮地板不放宽）');
});

test('A1-P2-08 · canTransitionMember 判据不变：(`running`,`idle`) false（阴性）+ 合法对 true（阳性对照）', () => {
  assert.equal(schema.canTransitionMember('running', 'idle'), false, '迁移表未放宽（idle 无入边）');
  assert.equal(schema.canTransitionMember('review', 'idle'), false, '迁移表未放宽（review → idle 也不放行）');
  assert.equal(schema.canTransitionMember('running', 'review'), true,
    '阳性对照：判据函数本身仍放行既有合法迁移（否则「false」可能只是函数坏了）');
});

test('A1-P2-08 · 静态单点：lifecycle.js 内 `= \'idle\'` 恰 1 处且落在 laneIdleOnRecovery 函数体内', () => {
  const src = read('lib/state/store/lifecycle.js');
  const hits = src.split('\n').map((line, i) => ({ line, i })).filter((x) => x.line.includes("= 'idle'"));
  assert.equal(hits.length, 1, '两处直写必须收敛为一处（否则仍是双写点）');
  const { start, end } = extractLaneIdleOnRecovery();
  const offset = src.split('\n').slice(0, hits[0].i).join('\n').length;
  assert.ok(offset > start && offset < end, '唯一写点必须落在单点写入口函数体内');
});

test('A1-P2-08 · 静态单点：单点写入口被两处调用点复用（recoverBatches / recycleStalledLane）', () => {
  const src = read('lib/state/store/lifecycle.js');
  const calls = src.match(/laneIdleOnRecovery\(/g) ?? [];
  // 1 次定义签名 + 2 次调用
  assert.equal(calls.length, 3, '恰 1 处定义 + 2 处调用（调用点数变化必须显式复核）');
});

// ── T-1c · autoSettle 开关判定式单点 ───────────────────────────────────────────────────
const AUTO_SETTLE_STATES = Object.freeze([
  // [标签, 入参形态, 期望]；`undefined`（键在值为 undefined）与「不传参」（键缺失）分列两例
  ['显式 false', { call: () => schema.autoSettleEnabledOf(false) }, false],
  ['显式 true', { call: () => schema.autoSettleEnabledOf(true) }, true],
  ['值为 undefined', { call: () => schema.autoSettleEnabledOf(undefined) }, true],
  ['不传参（键缺失）', { call: () => schema.autoSettleEnabledOf() }, true],
  ['0（越权关停回归）', { call: () => schema.autoSettleEnabledOf(0) }, true],
  ['空串（越权关停回归）', { call: () => schema.autoSettleEnabledOf('') }, true],
  ['null（越权关停回归）', { call: () => schema.autoSettleEnabledOf(null) }, true],
]);

test('A1-P2-07 · 判定式三态 + 越权关停回归：只有显式 false 停用（禁真值判断）', () => {
  for (const [label, spec, expected] of AUTO_SETTLE_STATES) {
    assert.equal(spec.call(), expected, label + ' ⇒ 期望 ' + expected);
  }
});

test('A1-P2-07 / REVERSE · 变异体 `(e) => !!e` 必红 ⇒ 上述三态断言可证伪（R-2）', () => {
  const mutant = (e) => !!e;
  const deviations = [];
  for (const [label, spec, expected] of AUTO_SETTLE_STATES) {
    // 同输入：把入参从调用闭包里取出，喂给变异体
    const actual = label === '不传参（键缺失）' ? mutant() : mutant(argOf(label));
    if (actual !== expected) deviations.push(label + '：期望 ' + expected + ' 实得 ' + actual);
  }
  assert.equal(deviations.length, 5, '真值判断会把 undefined（×2）/ 0 / 空串 / null 判成停用 ⇒ 偏离 5 条');
  assert.ok(deviations.length > 0, '断言集必须能抓住真值判断实现（否则只是恒真套话）');
});

/** 与 AUTO_SETTLE_STATES 同序的入参（供变异体复用同一组输入）。 */
function argOf(label) {
  switch (label) {
    case '显式 false': return false;
    case '显式 true': return true;
    case '值为 undefined': return undefined;
    case '0（越权关停回归）': return 0;
    case '空串（越权关停回归）': return '';
    case 'null（越权关停回归）': return null;
    default: return undefined;
  }
}

test('A1-P2-07 · 三处消费点一致：全仓只有 schema.js 一处定义，三个消费方均 import 单点且无 `!== false` 残留', () => {
  const consumers = ['lib/engine/auto-settle.js', 'lib/index.js', 'lib/tools/swarm-tools.js'];
  for (const rel of consumers) {
    const src = read(rel);
    assert.ok(/autoSettleEnabledOf/.test(src), rel + ' 必须引用单点 `autoSettleEnabledOf`');
    assert.ok(/import[^;]*autoSettleEnabledOf[^;]*from '[^']*schema\.js'/.test(src),
      rel + ' 必须从 schema.js import 单点（不得自持第二份定义）');
    assert.equal(src.includes('enabled !== false'), false,
      rel + ' 不得残留内联判定式 `enabled !== false`（第二套开关口径）');
  }
  // 定义点唯一：仓内 `function autoSettleEnabledOf` 恰 1 处
  const defsIn = (rel) => (read(rel).match(/function autoSettleEnabledOf\s*\(/g) ?? []).length;
  assert.equal(defsIn('lib/schema.js'), 1, '单点定义必须在 schema.js 且恰 1 处');
  assert.equal(defsIn('lib/engine/auto-settle.js'), 0, 'auto-settle.js 的私有同形函数必须删净');
  assert.equal(defsIn('lib/index.js'), 0, 'index.js 的本地镜像必须删净');
  assert.equal(defsIn('lib/tools/swarm-tools.js'), 0, 'swarm-tools.js 的内联镜像必须删净');
  // 读源保留（规格明确「只收判定式、不收读源」）：index.js 的包装仍在，swarm-tools 仍读 readLiveConfig。
  // 【判据更新 · 留痕】原断言逐字钉住改前的**内联取面字面量**
  //   `autoSettleEnabledOf(cfg?.autoSettle?.enabled)` / `autoSettleEnabledOf(readLiveConfig(deps)?.autoSettle?.enabled)`，
  //   它编码的形状是「取面仍在消费方内联」；该形状已被**本批 C3（A2-G12：投影单点 `autoSettleSwitchOf`）覆盖**
  //   ⇒ 任何符合 C3 的实现都必然把这两条断言打红（红因 = 实现前进，不是退化）。新判据**双面**：
  //     ① 正向：两处读源都经投影单点取面（`autoSettleSwitchOf(...)` 包住原表达式）；
  //     ② 反向：三消费点**不再出现** `?.autoSettle?.enabled` 内联取面（取面只许在 `lib/schema.*` 单点本体）。
  const indexSrc = read('lib/index.js');
  assert.ok(/const autoSettleEnabledOfConfig = \(cfg\) => autoSettleEnabledOf\(autoSettleSwitchOf\(cfg\)\)/
    .test(indexSrc), 'index.js 必须保留读源包装，且取面经投影单点 `autoSettleSwitchOf(cfg)`（C3）');
  assert.ok(/autoSettleEnabledOf\(autoSettleSwitchOf\(readLiveConfig\(deps\)\)\)/
    .test(read('lib/tools/swarm-tools.js')), 'swarm-tools.js 必须保留热更快照读源，且取面经 `autoSettleSwitchOf(readLiveConfig(deps))`（C3）');
  for (const rel of consumers) {
    assert.equal(/\?\.autoSettle\?\.enabled/.test(read(rel)), false,
      rel + ' 不得残留内联取面 `?.autoSettle?.enabled`（C3：取面归 `autoSettleSwitchOf` 单点）');
  }
});

test('A1-P2-07 · 行为面接线：装配期 enabled=false ⇒ 停用分支；undefined ⇒ 走既有启用路', () => {
  // 停用分支**先于**宿主能力闸 ⇒ 无 ctx.on 也能观测（这正是「策略 vs 能力缺失」可辨的判据）
  const off = installAutoSettle({}, { store: {}, enabled: false });
  assert.equal(off.installed, false);
  assert.equal(off.reason, 'auto-settle-disabled', '字面量逐字不变（既有可辨成因）');
  // 启用路需要一个可订阅的宿主位：给一个最小 ctx.on + store
  const host = { on: () => () => {} };
  const on = installAutoSettle(host, { store: {}, enabled: undefined });
  assert.equal(on.installed, true, 'undefined 不是停用（禁真值判断的端到端证据）');
  assert.notEqual(on.reason, 'auto-settle-disabled', 'undefined 不得落到停用分支');
});
