/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/assign-deviation-structured.test.js —— **G5-L-A 验收**：偏离三要素**结构化**（乙改）。
//
// 判据源：`plan/p1-pack.md`（L-AC）＋ `e1-deviation` handoff 断言基线。
// 语义：`override` 为真时 `deviation:{feature,counterpoint,direction}` 必填；`tier`/`channel` **共用同一形状**
//   （唯一入口，禁按偏离种类另立字段）；三子键 `trim()` 后各 ≥4 字、禁纯空白；`override:false` 时不参与校验。
//
// ⚠ 本文件的**核心判据 D-old**：一段把**旧关键词全写进去**的 rationale、而 `deviation` 缺省 ⇒ **必须拒**。
//   这条直接证明「不再靠自由文本判」；若实现回退成关键词正则，它必红。
//
// 可红形态：
//   D1 若缺子键不指名 ⇒ D1 红；D2 若纯空白/trim<4 被放过 ⇒ D2 红；
//   D3 若通道支与档位支文案不可区分 ⇒ D3 红；D4 若 `override=false` 也强制 deviation ⇒ D4 红；
//   D-old 若回退成文本判定 ⇒ D-old 红；D6 若 `difficulty=B` 无 deviation 被放过 ⇒ D6 红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { tempRoot } from './helpers/gate-fixture.mjs';

const R_C = '测试：命中多线并行判据（≥2 条可并行推进的任务线），需 wave_plan 建批';
const R_B = '测试：需独立上下文，评 B 派单个 subagent（单步调研）';
const R_A = '测试：单线程直做（无并行任务线、无依赖链）';
// ★ 旧机制的「满分话术」：把历史上所有靠关键词过的词**全**写进来（并行/多角色/门禁/…/直做）
const R_LEGACY_FULL = '解释：并行 多角色 门禁 可恢复 独立上下文 例外 反例 不适用 升档 降档 上限 不低于 门槛 直做 '
  + '通道 durable 席位 roster team 事件队列 而非 subagent 不泛化为全批 显式降级为 C';

const CHANNEL_DEVIATION = {
  feature: '通道偏离：需 durable 席位 + team 事件队列（通道轴 dispatch 为机械推导结果）',
  counterpoint: '例外：一次性 subagent 无法承载跨轮席位与事件交接 ⇒ 机械推导不成立',
  direction: '仅本批使用，不泛化为全批；team 面缺失时显式降级为 C（禁静默降级）',
};
const TIER_DEVIATION = {
  feature: '依据面：本任务 parallel 判据命中（≥2 条可并行任务线）',
  counterpoint: '例外：这些线其实强串行（后一条读前一条产物）⇒ 机械升档不成立',
  direction: '偏离方向：降为 B（单 subagent）；上限：本批内有效，不泛化为全批',
};

function harness(prefix) {
  const root = tempRoot(prefix);
  const store = createStore(root);
  const ctx = { tools: { register: () => {}, guard: () => () => {} }, logger: { info() {}, warn() {}, error() {}, debug() {} } };
  const { tools } = createTools(ctx, { store, root });
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  const sess = (id) => ({ agent: { session: { id, header: {} } } });
  const call = (id, args) => by.assign_check.execute({ scope: 'full', ...args }, sess(id));
  const fails = async (id, args) => call(id, args).then(() => null).catch((e) => e);
  return { store, call, fails };
}

// ── ① 三例分别缺失：各拒，且**各断言缺的子键名** ────────────────────────────────────────
test('D1 三例分别缺失 feature / counterpoint / direction ⇒ 各拒且拒因**逐子键**指名', async () => {
  const h = harness('punky-dev-miss-');
  const cases = [
    ['feature', { counterpoint: CHANNEL_DEVIATION.counterpoint, direction: CHANNEL_DEVIATION.direction }],
    ['counterpoint', { feature: CHANNEL_DEVIATION.feature, direction: CHANNEL_DEVIATION.direction }],
    ['direction', { feature: CHANNEL_DEVIATION.feature, counterpoint: CHANNEL_DEVIATION.counterpoint }],
  ];
  for (const [missing, partial] of cases) {
    const e = await h.fails('s-dev', { difficulty: 'D', rationale: R_LEGACY_FULL, parallel: true, deviation: partial });
    assert.ok(e, missing + ' 缺失 ⇒ 必须拒（不得因 rationale 写得好而放过）');
    const msg = String(e.message);
    assert.match(msg, new RegExp('deviation\\.' + missing), '拒因必须指名缺失子键 deviation.' + missing + '；实际=' + msg.slice(0, 220));
    // 逐子键：不得把「缺哪一个」笼统化成「deviation 非法」
    const others = ['feature', 'counterpoint', 'direction'].filter((k) => k !== missing);
    for (const ok of others) {
      assert.doesNotMatch(msg, new RegExp('deviation\\.' + ok),
        '已提供的子键 ' + ok + ' 不得被误报为缺失；实际=' + msg.slice(0, 220));
    }
  }
});

// ── ② 纯空白 / trim < 4 ────────────────────────────────────────────────────────────
test('D2 纯空白（"    "）与 trim<4 的短值 ⇒ 各拒（各子键独立校验）', async () => {
  const h = harness('punky-dev-blank-');
  for (const bad of ['    ', '  a  ', 'abc', '\t\n  ']) {
    for (const key of ['feature', 'counterpoint', 'direction']) {
      const deviation = { ...CHANNEL_DEVIATION, [key]: bad };
      const e = await h.fails('s-blank', { difficulty: 'D', rationale: R_C, parallel: true, deviation });
      assert.ok(e, key + ' 取值 ' + JSON.stringify(bad) + ' ⇒ 必须拒（trim 后须 ≥4 字、禁纯空白）');
      assert.match(String(e.message), new RegExp('deviation\\.' + key),
        key + ' 拒因须指名该子键；实际=' + String(e.message).slice(0, 200));
    }
  }
});

// ── ③ 通道支 vs 档位支：文案可区分 ────────────────────────────────────────────────────
test('D3 通道支（overrideKind=channel）与档位支（tier）拒因文案**可区分**', async () => {
  const h = harness('punky-dev-kind-');
  // 通道支：difficulty=D 而通道轴=dispatch ⇒ channel 偏离
  const eChannel = await h.fails('s-ch', { difficulty: 'D', rationale: R_C, parallel: true });
  assert.ok(eChannel, '通道变体缺 deviation ⇒ 拒');
  const mChannel = String(eChannel.message);
  assert.match(mChannel, /通道/, '通道支拒因须出现「通道」字样；实际=' + mChannel.slice(0, 240));
  // 档位支：difficulty=B 而 derived=A（无 needIsolation）⇒ tier 偏离
  const eTier = await h.fails('s-ti', { difficulty: 'B', rationale: R_A });
  assert.ok(eTier, '档位偏离缺 deviation ⇒ 拒');
  const mTier = String(eTier.message);
  // 两支必须可区分：档位支不得以「通道偏离」为主词（否则裁决者会拿错整改方向）
  assert.notEqual(mChannel, mTier, '两支拒因文案必须不同（否则无法区分偏离种类）');
  assert.equal(/通道偏离/.test(mTier), false, '档位支拒因不得写成「通道偏离」；实际=' + mTier.slice(0, 240));
});

// ── ④ override=false 阳性对照 ──────────────────────────────────────────────────────
test('D4 阳性对照：difficulty=A（override=false）无 deviation ⇒ 通过', async () => {
  const h = harness('punky-dev-ok-');
  const out = await h.call('s-ok', { difficulty: 'A', rationale: R_A });
  assert.ok(out, 'A 档机械一致 ⇒ override:false ⇒ deviation 可缺省（不得强制）');
  const g = h.store.readGovernance('s-ok');
  assert.equal(g.lastAssign.difficulty, 'A');
  assert.equal(g.lastAssign.override, false, 'A 档应为非偏离（override:false）');
});

// ── ★ ⑤ 旧机制已死：旧关键词全含但无 deviation ⇒ 必须拒 ─────────────────────────────
test('D-old ★ 旧机制已死：rationale 含**全部**旧关键词但 deviation 缺省 ⇒ 必须拒', async () => {
  const h = harness('punky-dev-old-');
  const legacy = await h.fails('s-old', { difficulty: 'D', rationale: R_LEGACY_FULL, parallel: true });
  assert.ok(legacy, '旧关键词写满也不得通过 —— 这直接证明不再靠自由文本判定');
  assert.match(String(legacy.message), /GATE_DIFFICULTY_MISMATCH/, '拒码须为 GATE_DIFFICULTY_MISMATCH');
  assert.match(String(legacy.message), /deviation/, '拒因须指向 deviation（而非指责 rationale 不够长）');
  // 同构造放行对照：同一 rationale 但**补上** deviation ⇒ 通过（证明拒的是「缺结构化字段」，不是「文案不好」）
  const out = await h.call('s-old', { difficulty: 'D', rationale: R_LEGACY_FULL, parallel: true, deviation: CHANNEL_DEVIATION });
  assert.ok(out, '补上 deviation 后必须放行（同构造对照，排除「D 一律拒」）');
  assert.equal(h.store.readGovernance('s-old').lastAssign.difficulty, 'D');
});

// ── ⑥ difficulty=B 无 deviation ⇒ 拒（B 相对机械推导 A 本身就是偏离）────────────────
test('D6 difficulty=B 且无 needIsolation/无 deviation ⇒ 拒（B 相对机械推导 A 是偏离）', async () => {
  const h = harness('punky-dev-b-');
  const e = await h.fails('s-b', { difficulty: 'B', rationale: R_B });
  assert.ok(e, 'B 档机械推导为 A（无 needIsolation）⇒ override 为真 ⇒ 缺 deviation 必须拒');
  assert.match(String(e.message), /deviation/, '拒因须指向 deviation');
  // 同构造放行对照：显式声明 needIsolation（⇒ 机械推导即 B，override:false）⇒ 无须 deviation
  const out = await h.call('s-b', { difficulty: 'B', rationale: R_B, needIsolation: true });
  assert.ok(out, 'needIsolation:true ⇒ derived=B ⇒ 非偏离 ⇒ 放行（对照，排除「B 一律拒」）');
  // 另一条放行路径：tier 偏离 + 合法 deviation
  const out2 = await h.call('s-b2', { difficulty: 'B', rationale: R_A, deviation: TIER_DEVIATION });
  assert.ok(out2, 'tier 偏离补上合法 deviation ⇒ 放行');
  assert.equal(h.store.readGovernance('s-b2').lastAssign.overrideKind, 'tier', 'tier 偏离须落 overrideKind=tier');
});

// ── ⑦ 唯一入口：tier 与 channel 共用同一形状（无第二字段）─────────────────────────
test('D7 唯一入口：同一 deviation 形状对 tie/channel 两支都生效，无第二入口字段', async () => {
  const h = harness('punky-dev-single-');
  const tierOk = await h.call('s-x', { difficulty: 'B', rationale: R_A, deviation: TIER_DEVIATION });
  const chanOk = await h.call('s-y', { difficulty: 'D', rationale: R_C, parallel: true, deviation: CHANNEL_DEVIATION });
  assert.ok(tierOk); assert.ok(chanOk);
  assert.equal(h.store.readGovernance('s-x').lastAssign.overrideKind, 'tier');
  assert.equal(h.store.readGovernance('s-y').lastAssign.overrideKind, 'channel');
  // 未知子键 ⇒ 拒（形状收窄，防"加个字段就过"）
  const e = await h.fails('s-z', {
    difficulty: 'B', rationale: R_A,
    deviation: { ...TIER_DEVIATION, extra: '多塞一个子键' },
  });
  assert.ok(e, 'deviation 含未知子键 ⇒ 必须拒');
  assert.match(String(e.message), /未知子键|deviation/, '拒因须指出未知子键；实际=' + String(e.message).slice(0, 200));
});
