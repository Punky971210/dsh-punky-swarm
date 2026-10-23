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

// punky-fix-p2-20261023 · c3 死代码与可证伪面（tester 落）：`A1-P2-11`（verify enforce 不再静默）
//   + `A1-P2-12`（死常量清退）。
//   【2026-10-23 · 批 punky-closeout-20261023 判据更新】**原口径**为「只删 1 枚、4 枚 FORWARD_* 保留并改注释」
//   （= 2026-09-21 冻结裁定①）；该裁定已被 **Q-9@closeout** 显式覆盖（用户裁决「7 条全删」）⇒ `FORWARD_*_DEFAULT`
//   现已 **0 枚**，本轮把该用例从「保留 4 枚」改写为「已删净 0 枚」。**这是判据更新，不是改测试凑绿**。
//
// ── 两条判据取向 ──────────────────────────────────────────────────────────────────────
//   · `A1-P2-11` 的**核心是「判定语义未变」**（R-5）：只加日志与注释。故本文件的断言成对出现 ——
//     一手测「warn 恰 1 条 / 不越界 / 在 inert 之前」，另一手测「advisory 与 enforce 的
//     `status`/`defects` 逐字相同，唯一差异是既有设计里的 `intercepted`」。
//   · `A1-P2-12` 的删除项**在测试里不得出现字面量**：该符号的验收判据是「全仓 grep 空输出」，
//     测试自己写一次字面量就会把该判据打红（假红）。故用 `['REASON','EXEMPT','CLEARED'].join('_')`
//     构造标识符再扫 —— 这是**为让判据可执行**而做的构造，不是隐藏证据（值 `exempt-cleared` 仍在
//     `gen-register` 的批注里可检索）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { mountVerify } from '../lib/verify/mount.js';
import { createCompletionGate } from '../lib/verify/gate.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(PKG_ROOT, rel), 'utf8');

/** warn 汇集器（模拟 logger 面；只收 warn，info/error 不参与判据）。 */
function warnSpy() {
  const warns = [];
  return { warns, logger: { warn: (m) => warns.push(String(m)), info: () => {}, error: () => {} } };
}

const VERIFY_CFG = (verify) => ({ capabilities: { verify } });

// ── T-3a · verify: enforce 的诚实面 ───────────────────────────────────────────────────
test('A1-P2-11 · enforce + 可订阅 host ⇒ warn **恰 1 条**，文案含 enforce / 未接线 / advisory 且无 GATE_ 前缀', () => {
  const spy = warnSpy();
  const host = { on: () => () => {} };
  const r = mountVerify(host, { root: path.join(os.tmpdir(), 'p2-verify'), config: VERIFY_CFG({ enabled: true, mode: 'enforce' }), logger: spy.logger });
  assert.equal(spy.warns.length, 1, 'enforce 必须恰 1 条告警（多条 = 噪音/重复挂载未去重属既有语义，此处锁装配一次）');
  const msg = spy.warns[0];
  assert.match(msg, /enforce/, '文案必须点名配置项取值');
  assert.match(msg, /NOT wired|未接线/, '文案必须声明「未接线」（AC-5.1 三要素之二）');
  assert.match(msg, /advisory/, '文案必须说明实际按 advisory 生效（AC-5.1 三要素之三）');
  assert.equal(msg.includes('GATE_'), false, '零新造拒码：告警不是拒码，不得带 GATE_ 前缀');
  assert.equal(r.mode, 'enforce', '返回值仍回传 mode（判定面语义未变）');
});

test('A1-P2-11 · warn 在 inert 提前返回**之前**：ctx.on 缺失 + enforce ⇒ 仍恰 1 条（专打错实现）', () => {
  const spy = warnSpy();
  const r = mountVerify({}, { root: path.join(os.tmpdir(), 'p2-verify'), config: VERIFY_CFG({ enabled: true, mode: 'enforce' }), logger: spy.logger });
  assert.equal(r.installed, false, '本用例的 ctx 无 on ⇒ 走 inert 降级路径');
  assert.equal(r.reason, 'ctx.on unavailable', '降级成因可辨（未变）');
  assert.equal(spy.warns.length, 1, '若把 warn 放在 inert 之后，该宿主上真相永不可见 —— 本断言即其护栏');
});

test('A1-P2-11 · warn 不越界：advisory / enabled:false / 全缺省 / 大写 ENFORCE ⇒ 0 条', () => {
  const cases = [
    ['advisory', VERIFY_CFG({ enabled: true, mode: 'advisory' })],
    ['enabled:false + enforce', VERIFY_CFG({ enabled: false, mode: 'enforce' })],
    ['全缺省（无 verify 键）', {}],
    ['大写 ENFORCE', VERIFY_CFG({ enabled: true, mode: 'ENFORCE' })],
  ];
  for (const [label, cfg] of cases) {
    const spy = warnSpy();
    mountVerify({ on: () => () => {} }, { root: path.join(os.tmpdir(), 'p2-verify'), config: cfg, logger: spy.logger });
    assert.equal(spy.warns.length, 0, label + ' 不得告警（防无脑告警噪音）');
  }
});

// ── T-3b · R-5 判定语义未变（本条是任务书点名要求的证明）──────────────────────────────
const EVIDENCE = Object.freeze({
  none: { bindingsFor: () => [], readBlob: () => null },
  success: { bindingsFor: () => [{ selectorRef: 's', blobKey: 'k' }], readBlob: () => ({ ok: true }) },
});

test('A1-P2-11 / R-5 · advisory 与 enforce 的 status+defects **逐字相同**，仅既有设计里的 intercepted 不同', () => {
  const cases = [
    ['1 AC / 零绑定', { acBindings: [{ acId: 'ac1' }], evidence: EVIDENCE.none }],
    ['1 AC / 有成功证据', { acBindings: [{ acId: 'ac1' }], evidence: EVIDENCE.success }],
    ['空 AC 清单', { acBindings: [], evidence: EVIDENCE.none }],
  ];
  for (const [label, args] of cases) {
    const gateOf = (mode) => createCompletionGate({ config: VERIFY_CFG({ enabled: true, mode }) });
    const a = gateOf('advisory').evaluate(args);
    const e = gateOf('enforce').evaluate(args);
    assert.deepEqual(e.status, a.status, label + '：status 必须逐字相同');
    assert.deepEqual(e.defects, a.defects, label + '：defects 必须逐字相同');
    assert.equal(a.intercepted, false, label + '：advisory 恒不拦截');
    assert.equal(e.intercepted, e.status !== 'done', label + '：enforce 的 intercepted 语义 = 既有设计（status!==done）');
  }
});

test('A1-P2-11 / R-5 · createCompletionGate 的 mode 读取面未变；enabled:false ⇒ skipped（既有语义）', () => {
  assert.equal(createCompletionGate({ config: VERIFY_CFG({ enabled: true, mode: 'enforce' }) }).mode, 'enforce');
  assert.equal(createCompletionGate({ config: VERIFY_CFG({ enabled: true, mode: 'advisory' }) }).mode, 'advisory');
  const skipped = createCompletionGate({ config: VERIFY_CFG({ enabled: false, mode: 'enforce' }) })
    .evaluate({ acBindings: [{ acId: 'x' }], evidence: EVIDENCE.none });
  assert.equal(skipped.skipped, true, 'enabled:false ⇒ 无裁决、零开销（既有行为）');
  assert.equal(skipped.status, 'done');
  assert.equal(skipped.intercepted, false);
});

// ── T-3c · A1-P2-12 · 死常量清退（Q-9@closeout 版：7 条全删，`FORWARD_*_DEFAULT` 0 枚）──────
/** 被删符号的标识符（**构造**而非字面量：该符号的验收判据就是全仓 grep 空输出）。 */
const DELETED_REASON_CONST = ['REASON', 'EXEMPT', 'CLEARED'].join('_');
const SCAN_DIRS = ['lib', 'scripts', 'test'];
const SCAN_EXT = /\.(js|mjs|ts)$/;

function walkFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walkFiles(p, out);
    } else if (SCAN_EXT.test(e.name)) out.push(p);
  }
  return out;
}

test('A1-P2-12 · 删除项全仓 0 命中（lib / scripts / test，js+mjs+ts）', () => {
  const hits = [];
  for (const dir of SCAN_DIRS) {
    for (const f of walkFiles(path.join(PKG_ROOT, dir))) {
      const src = readFileSync(f, 'utf8');
      if (src.includes(DELETED_REASON_CONST)) hits.push(path.relative(PKG_ROOT, f));
    }
  }
  assert.deepEqual(hits, [], '死常量必须零命中（若有命中，说明删除未落净或本测试自造字面量）');
});

test('A1-P2-12 · 保留项在位：在用的事件字面量与私有 `_MIN` 常量未被误删', () => {
  const laneHeartbeat = read('lib/watch/lane-heartbeat.js');
  assert.match(laneHeartbeat, /EVT_LANE_EXEMPT_CLEARED_LITERAL/, '在用的读端字面量必须在位（删它就是删功能）');
  const discovery = read('lib/discovery/schema.js');
  assert.match(discovery, /FORWARD_DEPTH_LIMIT_MIN/, '私有 `_MIN` 常量必须保留（请求校验在用）');
  assert.match(discovery, /FORWARD_DEPTH_LIMIT_MAX/, '私有 `_MAX` 常量必须保留');
});

// 【判据更新 · 留痕】原断言编码 **2026-09-21 冻结裁定①**（「4 枚 `FORWARD_*_DEFAULT` 保留，不删」＋
//   注释须承载「外部规范对齐表 / 仓内零消费 / 勿据以推断行为」三段声明）。该裁定已被
//   **Q-9@closeout 显式覆盖**（批 `punky-closeout-20261023`，用户 2026-10-23 裁决「7 条全删」）
//   ⇒ 原断言的四枚声明被删 ⇒ 本用例由「保留 4 枚」改写为「已删净 0 枚 + 删除依据留痕」。
//   **这是判据更新，不是改测试凑绿**：红因是「实现按新裁决前进」，而非「实现退化」。
test('A1-P2-12 · FORWARD_*_DEFAULT 已删净（0 枚）且删除依据留痕（Q-9@closeout 覆盖 2026-09-21 裁定①）', () => {
  const discovery = read('lib/discovery/schema.js');
  const decls = discovery.split('\n').filter((l) => /^export const FORWARD_\w+_DEFAULT\s*=/.test(l.trim()));
  assert.equal(decls.length, 0, '`FORWARD_*_DEFAULT` 必须 0 枚（Q-9@closeout：7 条全删）');
  // 删除依据必须由**注释承载**，否则下一位读者会把这次删除读成事故（「与参考实现对齐」的声明面消失无痕）。
  // 容忍 Markdown 强调符 ⇒ 用「短语间允许少量强强调符」的宽松形态匹配语义，而非逐字匹配排版。
  assert.match(discovery, /Q-9@closeout/, '注释必须显式标注删除依据 `Q-9@closeout`');
  assert.match(discovery, /2026-09-21/, '注释必须点名被覆盖的 2026-09-21 冻结裁定①（显式覆盖，非静默推翻）');
  assert.match(discovery, /诱导面/, '注释必须保留「这类声明面是诱导面」的告诫（删符号的理由须可读，不作静默删除）');
  // 正向对照（负数断言必配阳性面）：删除只落在 `_DEFAULT` 四枚，**校验区间** `_MIN`/`_MAX` 未被误伤。
  assert.match(discovery, /FORWARD_DEPTH_LIMIT_MIN/, '`_MIN` 校验常量必须在位（删它就是删请求校验）');
  assert.match(discovery, /FORWARD_FANOUT_LIMIT_MAX/, '`_MAX` 校验常量必须在位');
  // 反向：全 `lib/` 零残留（不只本文件）——`_DEFAULT` 声明面必须整体消失，否则「归零」判据不可达。
  const residue = [];
  for (const f of walkFiles(path.join(PKG_ROOT, 'lib'))) {
    const rel = path.relative(PKG_ROOT, f).split(path.sep).join('/');
    if (/FORWARD_\w+_DEFAULT/.test(readFileSync(f, 'utf8'))) residue.push(rel);
  }
  assert.deepEqual(residue, [], '全 `lib/` 不得残留 `FORWARD_*_DEFAULT`（含注释里的符号写法；若复现，须先重评 Q-9）');
});
