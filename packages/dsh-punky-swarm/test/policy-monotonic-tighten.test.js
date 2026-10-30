/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/policy-monotonic-tighten.test.js —— **I-23 验收**：策略**只可收紧**（三轴单调 ＋ 幂等 ＋ 历史不洗）。
//
// 文件名按计划 T-cmd 原文（`node --test test/policy-monotonic-tighten.test.js`）。
// 判据源：`plan/p1-pack.md` I-23（AC：三轴各自两态 / 幂等 / 历史不洗）。
// 判定单点 = `lib/governance/policy.js#tightenPolicy`（测试**不重写**判定，只驱动它）。
//
// 语义（实现实测）：`allowed` **只减不增**、`denied` **只增不减**、`limits` **只降不升** ⇒
//   · 收紧（allowed 削减 / denied 追加 / limits 下调）⇒ 通过；
//   · 放宽（allowed 追加 / denied 削减 / limits 上调）⇒ 抛 `policy-not-monotonic:`。
//
// 可红形态：任一轴放宽若被放行 ⇒ 对应「拒」断言红；若无幂等 ⇒ `changed===false` 断言红；
//   若「已削减的历史项被洗回」⇒ 历史不洗用例红。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tightenPolicy, isAtLeastAsTight, normalizePolicy, POLICY_NOT_MONOTONIC,
} from '../lib/governance/policy.js';

const P = (o) => normalizePolicy(o);
const BASE = P({ allowed: ['a', 'b'], denied: ['x', 'y'], limits: { n: 5, m: 2 } });

test('M1 三轴各自两态：收紧三向全部通过', () => {
  // allowed 削减（b 移除）⇒ 更紧
  const r1 = tightenPolicy(BASE, P({ allowed: ['a'], denied: ['x', 'y'], limits: { n: 5, m: 2 } }));
  assert.deepEqual(r1.policy.allowed, ['a'], 'allowed 削减应被接受');
  assert.equal(r1.changed, true, '发生收紧 ⇒ changed:true');
  // denied 追加（z）⇒ 更紧
  const r2 = tightenPolicy(BASE, P({ allowed: ['a', 'b'], denied: ['x', 'y', 'z'], limits: { n: 5, m: 2 } }));
  assert.deepEqual(r2.policy.denied, ['x', 'y', 'z'], 'denied 追加应被接受');
  // limits 下调（n 5→1）⇒ 更紧
  const r3 = tightenPolicy(BASE, P({ allowed: ['a', 'b'], denied: ['x', 'y'], limits: { n: 1, m: 2 } }));
  assert.equal(r3.policy.limits.n, 1, 'limits 下调应被接受');
});

test('M2 三轴各自两态：放宽三向**逐个被拒**，且拒因前缀 = policy-not-monotonic:', () => {
  const cases = [
    ['allowed 追加（放宽）', { allowed: ['a', 'b', 'c'], denied: ['x', 'y'], limits: { n: 5, m: 2 } }],
    ['denied 削减（擦历史）', { allowed: ['a', 'b'], denied: ['x'], limits: { n: 5, m: 2 } }],
    ['limits 上调（放宽）', { allowed: ['a', 'b'], denied: ['x', 'y'], limits: { n: 9, m: 2 } }],
  ];
  for (const [tag, next] of cases) {
    assert.throws(() => tightenPolicy(BASE, P(next)), (e) => {
      assert.equal(String(e.message).startsWith(POLICY_NOT_MONOTONIC), true,
        tag + '：拒因必须带前缀 ' + POLICY_NOT_MONOTONIC + '；实际=' + e.message);
      return true;
    }, tag + ' 必须被拒');
  }
});

test('M3 幂等：再次提交同一策略 ⇒ changed:false 且策略**深等**（不重复追加、不 phantom 变更）', () => {
  const once = tightenPolicy(BASE, P({ allowed: ['a'], denied: ['x', 'y', 'z'], limits: { n: 1, m: 2 } }));
  const twice = tightenPolicy(once.policy, P({ allowed: ['a'], denied: ['x', 'y', 'z'], limits: { n: 1, m: 2 } }));
  assert.equal(twice.changed, false, '同值再提 ⇒ changed:false（幂等）');
  assert.deepEqual(twice.policy, once.policy, '幂等路径必须深等（不改写内容）');
});

test('M4 历史不洗：先放宽(拒) → 收紧 → 再放宽 ⇒ 仍拒；且**未触及字段不被写没**', () => {
  // ① 先尝试放宽（allowed 追加）⇒ 拒
  assert.throws(() => tightenPolicy(BASE, P({ allowed: ['a', 'b', 'evil'], denied: ['x', 'y'], limits: { n: 5, m: 2 } })));
  // ② 合法收紧（denied 追加 z，limits n 降 1）
  const tightened = tightenPolicy(BASE, P({ allowed: ['a', 'b'], denied: ['x', 'y', 'z'], limits: { n: 1, m: 2 } }));
  assert.deepEqual(tightened.policy.denied, ['x', 'y', 'z']);
  // ③ 在收紧后的策略上再放宽 ⇒ 仍拒（历史不被洗回）
  assert.throws(() => tightenPolicy(tightened.policy, P({ allowed: ['a', 'b', 'c'], denied: ['x', 'y', 'z'], limits: { n: 1, m: 2 } })),
    '收紧后仍不得放宽（历史不洗）');
  assert.throws(() => tightenPolicy(tightened.policy, P({ allowed: ['a', 'b'], denied: ['x', 'y'], limits: { n: 1, m: 2 } })),
    '已追加的 denied 不得被擦除');
  // ④ 未触及字段不得被写没：收紧只改 limits.n ⇒ limits.m 必须原值保留
  const onlyLimits = tightenPolicy(BASE, P({ allowed: ['a', 'b'], denied: ['x', 'y'], limits: { n: 1, m: 2 } }));
  assert.equal(onlyLimits.policy.limits.m, 2, '未触及字段（m）不得被写没；实际=' + JSON.stringify(onlyLimits.policy.limits));
  assert.deepEqual(onlyLimits.policy.allowed, ['a', 'b'], '未触及轴（allowed）必须原样保留');
  assert.deepEqual(onlyLimits.policy.denied, ['x', 'y'], '未触及轴（denied）必须原样保留');
});

test('M5 单点判定：`isAtLeastAsTight` 与 `tightenPolicy` 同向（同一判据，两入口一致）', () => {
  const tighter = P({ allowed: ['a'], denied: ['x', 'y', 'z'], limits: { n: 1, m: 2 } });
  assert.equal(isAtLeastAsTight(BASE, tighter), true, '收紧 ⇒ isAtLeastAsTight=true');
  assert.equal(isAtLeastAsTight(BASE, P({ allowed: ['a', 'b', 'c'], denied: ['x', 'y'], limits: { n: 5, m: 2 } })), false,
    '放宽（allowed 追加）⇒ isAtLeastAsTight=false');
});
