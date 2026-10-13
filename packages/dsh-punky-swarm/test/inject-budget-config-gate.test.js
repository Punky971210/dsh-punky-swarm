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

// C-5 · 坏配置加载期 fail-closed（消除静默降级）—— 本 lane（`e5-c5-quietfix`）单测。
//
// **判据是双向的**（本件的骨架即按此组织）：
//   A. 坏配置**被拒**：单字段 / 五字段×多种坏值矩阵 / **热更通道同判** / 非对象形态；
//   B. **契约行为不变**：合法值与缺省**不得误伤**；`enabled:false` 仍为零校验（冻结语义）；
//      未超限注入面输出零回归（该项由既有 `test/inject-budget.test.js` 的 17+ 条锁承担，本件只锁「配置面」）。
//
// 语义边界（防后人误改）：`lib/comms/inject-budget.js` 的「未超限 / 开关关 / 无可用阈值 ⇒ 返回入参原值本身」
//   是**文档化契约**（该件 `:165`），**不是**本 lane 要消除的对象 ⇒ 本 lane **一字不动**该文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCapabilities,
  injectBudgetValueErrors,
  INJECT_BUDGET_LIMIT_FIELDS,
  readCapability,
} from '../lib/assembly/schema.js';
import { validateOverlay } from '../lib/hot/config-watch.js';
import { memberDispatchBudgetKeyOf } from '../lib/engine/dispatch.js';

/** 合法五值（对齐注册表默认）。 */
const GOOD_LIMITS = Object.freeze({
  perItemBytes: 3072,
  perBlockBytes: 12288,
  totalBytes: 32768,
  headBytes: 2048,
  tailBytes: 1024,
});

/** 坏值类矩阵（T-2 口径：0 / 负数 / NaN / Infinity / 字符串）。 */
const BAD_VALUES = Object.freeze([
  ['zero', 0],
  ['negative', -1],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['string', '3072'],
]);

const capsWith = (injectBudget) => ({ capabilities: { injectBudget } });
const overlayWith = (injectBudget) => ({ capabilities: { injectBudget } });

// ═════════════════════════════════════════════════════════════════════════════
// A. 坏配置被拒
// ═════════════════════════════════════════════════════════════════════════════

test('[T-1/AC-21] 单字段坏值 totalBytes:-1 ⇒ 加载期报错（文案含 DEP-6 与字段名）', () => {
  const { errors } = validateCapabilities(capsWith({ enabled: true, totalBytes: -1 }));
  assert.equal(errors.length, 1, '应恰报一条，实得 ' + JSON.stringify(errors));
  assert.match(errors[0], /^DEP-6: /, '文案须以 DEP-6 标识开头（与 DEP-1..DEP-5 同形）');
  assert.ok(errors[0].includes('totalBytes'), '文案须含**字段名**：' + errors[0]);
  assert.ok(errors[0].includes('-1'), '文案须含**实得值**：' + errors[0]);
});

test('[T-2/AC-21] 五字段 × 五种坏值矩阵 ⇒ 逐格被拒（25 格全拒且指向该字段）', () => {
  let checked = 0;
  for (const field of INJECT_BUDGET_LIMIT_FIELDS) {
    for (const [kind, bad] of BAD_VALUES) {
      const { errors } = validateCapabilities(capsWith({ enabled: true, [field]: bad }));
      assert.equal(errors.length, 1,
        '字段 ' + field + ' / 坏值类 ' + kind + ' 应恰报一条，实得 ' + JSON.stringify(errors));
      assert.match(errors[0], /^DEP-6: /, field + '/' + kind + ' 标识不符：' + errors[0]);
      assert.ok(errors[0].includes(field),
        '字段 ' + field + ' / 坏值类 ' + kind + ' 的文案未点名该字段：' + errors[0]);
      checked += 1;
    }
  }
  assert.equal(checked, INJECT_BUDGET_LIMIT_FIELDS.length * BAD_VALUES.length,
    '矩阵格数须为 5 × 5 = 25');
});

test('[T-2] 矩阵走**纯判定点**亦同判（injectBudgetValueErrors 与 validateCapabilities 同源）', () => {
  for (const field of INJECT_BUDGET_LIMIT_FIELDS) {
    for (const [kind, bad] of BAD_VALUES) {
      const viaPoint = injectBudgetValueErrors({ enabled: true, [field]: bad });
      const viaCap = validateCapabilities(capsWith({ enabled: true, [field]: bad })).errors;
      assert.deepEqual(viaPoint, viaCap,
        '两入口须逐字同源（' + field + '/' + kind + '）');
    }
  }
});

test('[T-3/AC-22] **热更通道同判**：同一坏值经 validateOverlay ⇒ 同样被拒（与静态通道对照）', () => {
  const bad = { enabled: true, totalBytes: -1 };
  const staticVerdict = validateCapabilities(capsWith(bad));
  const hotVerdict = validateOverlay(overlayWith(bad));
  assert.equal(staticVerdict.errors.length, 1, '静态通道应报一条');
  assert.equal(hotVerdict.ok, false, '热更通道须**拒**（ok:false），实得 ' + JSON.stringify(hotVerdict));
  assert.equal(hotVerdict.errors.length, 1, '热更通道应报一条，实得 ' + JSON.stringify(hotVerdict.errors));
  assert.deepEqual(hotVerdict.errors, staticVerdict.errors,
    '两通道文案须**同源**（共用单一判定点）');
});

test('[T-3] 热更通道矩阵：五字段 × 五坏值 ⇒ 逐格 ok:false', () => {
  let checked = 0;
  for (const field of INJECT_BUDGET_LIMIT_FIELDS) {
    for (const [kind, bad] of BAD_VALUES) {
      const v = validateOverlay(overlayWith({ enabled: true, [field]: bad }));
      assert.equal(v.ok, false, '热更 ' + field + '/' + kind + ' 应被拒，实得 ' + JSON.stringify(v));
      assert.ok(v.errors.some((e) => e.includes(field)),
        '热更 ' + field + '/' + kind + ' 的拒因未点名字段：' + JSON.stringify(v.errors));
      checked += 1;
    }
  }
  assert.equal(checked, 25, '热更矩阵格数须为 25');
});

test('[AC-25] DEP-6 报错形态与 DEP-1..DEP-5 **同形**（前缀 + got 渲染）', () => {
  const dep6 = validateCapabilities(capsWith({ enabled: true, headBytes: 0 })).errors[0];
  const dep4 = validateCapabilities({ capabilities: { budget: { enabled: true, maxChainHops: 0 } } }).errors[0];
  assert.match(dep4, /^DEP-4: /);
  assert.match(dep6, /^DEP-6: /);
  // 两族形态：`DEP-<n>: capabilities.<键>.<字段> must be ... (got <JSON>)`
  assert.match(dep6, /^DEP-6: capabilities\.injectBudget\.[A-Za-z]+ must be .+ \(got .+\)$/);
  assert.match(dep4, /^DEP-4: capabilities\.budget\.[A-Za-z]+ must be .+ \(got .+\)$/);
});

test('[扩展·登记] 非对象 injectBudget（5 / "on" / true）⇒ 拒（超出包内字面冻结范围的扩展）', () => {
  // 登记理由：非对象经 deepMerge 后 `?.enabled` 取不到 ⇒ 预算被**静默禁用且无痕**，与 totalBytes:-1 同类。
  // 实测全仓零处传非对象（仅注册表默认 / readCapability / 形参缺省）⇒ 无误伤面。
  for (const bad of [5, 'on', true]) {
    const { errors } = validateCapabilities(capsWith(bad));
    assert.equal(errors.length, 1, JSON.stringify(bad) + ' 应被拒，实得 ' + JSON.stringify(errors));
    assert.match(errors[0], /^DEP-6: capabilities\.injectBudget must be an object/);
    assert.equal(validateOverlay(overlayWith(bad)).ok, false,
      '热更通道亦须拒非对象：' + JSON.stringify(bad));
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// B. 契约行为不变（**不得误伤**）
// ═════════════════════════════════════════════════════════════════════════════

test('[T-6] 缺省不误伤：完全不声明 injectBudget ⇒ 零报错（注册表默认本身合法）', () => {
  assert.deepEqual(validateCapabilities({}).errors, [], '空配置不得报错');
  assert.deepEqual(validateCapabilities({ capabilities: {} }).errors, [], '空 capabilities 不得报错');
  const def = readCapability({}, 'injectBudget');
  assert.deepEqual(injectBudgetValueErrors(def), [],
    '注册表默认值须合法（否则缺省即被误伤）：' + JSON.stringify(def));
});

test('[零回归] 合法显式值 ⇒ 零报错（静态 + 热更两通道）', () => {
  assert.deepEqual(validateCapabilities(capsWith({ enabled: true, ...GOOD_LIMITS })).errors, []);
  assert.deepEqual(validateOverlay(overlayWith({ enabled: true, ...GOOD_LIMITS })), { ok: true, errors: [] });
});

test('[零回归·冻结语义] enabled:false + 坏值 ⇒ **零报错**（禁用能力零校验零开销，与 DEP-1..5 同形）', () => {
  const { errors } = validateCapabilities(capsWith({ enabled: false, totalBytes: -1 }));
  assert.deepEqual(errors, [], '禁用态不得因坏值报错（冻结语义：enabled===true 才校验）');
  assert.equal(validateOverlay(overlayWith({ enabled: false, totalBytes: -1 })).ok, true,
    '热更通道同样遵守：禁用态零校验');
});

test('[零回归] 字段**缺省**不误伤：只声明部分字段且均合法 ⇒ 零报错', () => {
  assert.deepEqual(validateCapabilities(capsWith({ enabled: true, totalBytes: 4096 })).errors, []);
  assert.deepEqual(validateOverlay(overlayWith({ enabled: true, totalBytes: 4096 })), { ok: true, errors: [] });
});

test('[零回归·防越界] 其他 capabilities 键的**部分覆盖层**不得因本 lane 被误拒', () => {
  // 作用域刻意收窄到 injectBudget：validateOverlay 只拿到覆盖层片段（拿不到 base 配置）⇒
  // 若在此对全部键重跑 validateCapabilities，`{trajectory:{autoFail:true}}` 会被 DEP-2 误拒 = 存量行为变化。
  const partial = { capabilities: { trajectory: { autoFail: true } } };
  assert.equal(validateOverlay(partial).ok, true,
    '部分覆盖层不得被误拒（本 lane 不得扩面），实得 ' + JSON.stringify(validateOverlay(partial)));
  assert.deepEqual(validateOverlay({ capabilities: { budget: { maxChainHops: 4 } } }).errors, [],
    'budget 部分覆盖层亦不得被误拒');
  assert.equal(validateOverlay({ capabilities: { injectBudget: { enabled: true } } }).ok, true,
    'injectBudget 只写 enabled 的覆盖层合法（字段缺省不误伤）');
});

test('[零回归] 未知 capabilities 键仍报既有文案（既有行为不得回归）', () => {
  const v = validateOverlay({ capabilities: { injectBudgetX: { enabled: true } } });
  assert.equal(v.ok, false);
  assert.ok(v.errors[0].startsWith('unknown capabilities key: injectBudgetX'),
    '未知键仍走既有文案，实得 ' + JSON.stringify(v.errors));
});

// ═════════════════════════════════════════════════════════════════════════════
// C. 消费侧静默面（④）—— 单一判定点两态
// ═════════════════════════════════════════════════════════════════════════════

test('[T-5/AC-24] 消费侧留痕键：enabled:false ⇒ 写 budgetEnabled:false；其余形态 ⇒ **不写键**', () => {
  assert.deepEqual(memberDispatchBudgetKeyOf({ enabled: false }), { budgetEnabled: false },
    'enabled:false ⇒ 须留痕（消除「perItem 层整条跳过、无留痕」的静默面）');
  // 非空才写键（冻结口径 C-5）：以下所有形态均**不得**追加任何键
  assert.deepEqual(memberDispatchBudgetKeyOf({ enabled: true }), {});
  assert.deepEqual(memberDispatchBudgetKeyOf(null), {});
  assert.deepEqual(memberDispatchBudgetKeyOf(undefined), {});
  assert.deepEqual(memberDispatchBudgetKeyOf({}), {});
  assert.deepEqual(memberDispatchBudgetKeyOf({ enabled: 'false' }), {}, '字符串 "false" 不得视为 false');
});

test('[T-5] 载荷合成形态：既有键序不变 + 追加键仅在 enabled:false 时出现', () => {
  const base = { lane: 'e1', workerSessionId: 'ws-1' };
  const withOwner = { lane: 'e1', workerSessionId: 'ws-1', ownerSessionId: 's-owner' };
  const onPayload = { ...base, ...memberDispatchBudgetKeyOf({ enabled: true }) };
  assert.deepEqual(Object.keys(onPayload), ['lane', 'workerSessionId'], 'enabled:true ⇒ 键集逐字不变');
  assert.deepEqual(Object.keys({ ...withOwner, ...memberDispatchBudgetKeyOf({ enabled: true }) }),
    ['lane', 'workerSessionId', 'ownerSessionId'], '含 ownerSessionId 时键序亦不变');
  const offPayload = { ...base, ...memberDispatchBudgetKeyOf({ enabled: false }) };
  assert.deepEqual(Object.keys(offPayload), ['lane', 'workerSessionId', 'budgetEnabled'],
    'enabled:false ⇒ 追加末位键 budgetEnabled');
  assert.equal(offPayload.budgetEnabled, false);
});
