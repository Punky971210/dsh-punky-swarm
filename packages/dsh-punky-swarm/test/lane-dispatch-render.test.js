// test/lane-dispatch-render.test.js
//
// 【批 `punky-audit-fix-20261105` · lane `impl` · U-1】**`lane_dispatch` 的渲染层直测**。
//
// ## 为什么必须有这条
// 假测试审核（`faketest` 线，FT-1）实测：`test/` 里直接调 `.output.render(` 的只有 6 处，
// **全在别的工具**（batch_phase / batch_control / assign_helper / assign_check）⇒ `lane_dispatch` **零直接调用**。
// 后果：`render` 原先只看 `value.spawned` ⇒ `rejected`（`spawned:false`）被渲染成「仅发句柄」，
// 与 `degraded` **不可区分** —— **用户看到的与引擎实际做的相反**，而测试全绿也照样存在。
//
// ## 三态判据
//   ① `mode:'rejected'`  ⇒ 渲染含「拒派」
//   ② 成功（`spawned:true`，**无 mode 键**）⇒ 渲染含「引擎自派」  ← 同时锁住 U-2 的语义
//   ③ `mode:'degraded'`  ⇒ 渲染含「仅发句柄」
// ⚠ 三者必须**两两可区分**（不只各自含词，还要互不含对方的特征词）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDispatchTools } from '../lib/tools/member-tools.js';

const toolOf = () => buildDispatchTools({ ctx: {}, deps: {}, store: {}, root: '' })
  .find((x) => x.name === 'lane_dispatch');

/** 把 render 的返回值归一成纯文本（`TEXT_OUTPUT` 可能返回数组/对象）。 */
const renderTextOf = (value) => {
  const out = toolOf().output.render({}, value);
  if (Array.isArray(out)) return out.map((x) => (x && typeof x.text === 'string' ? x.text : String(x))).join('');
  if (out && typeof out.text === 'string') return out.text;
  return String(out ?? '');
};

test('U-1 ① rejected ⇒ 渲染含「拒派」（旧实现会误渲染成「仅发句柄」）', () => {
  const text = renderTextOf({ lane: 'l1', mode: 'rejected', spawned: false, spawnNote: '收窄不可核' });
  assert.ok(text.includes('拒派'), 'rejected 必须渲染成「拒派」；实际=' + text);
  assert.ok(!text.includes('仅发句柄'), 'rejected **不得**被渲染成「仅发句柄」（与 degraded 混淆）；实际=' + text);
});

test('U-1 ② 成功（spawned:true 且无 mode 键）⇒ 渲染含「引擎自派」', () => {
  const text = renderTextOf({ lane: 'l1', spawned: true, workerSessionId: 'ws-1' });
  assert.ok(text.includes('引擎自派'), '成功路径必须渲染成「引擎自派」；实际=' + text);
  assert.ok(!text.includes('拒派'), '成功路径不得含「拒派」；实际=' + text);
});

test('U-1 ③ degraded ⇒ 渲染含「仅发句柄」', () => {
  const text = renderTextOf({ lane: 'l1', mode: 'degraded', spawned: false, spawnNote: '面不可用' });
  assert.ok(text.includes('仅发句柄'), 'degraded 必须渲染成「仅发句柄」；实际=' + text);
  assert.ok(!text.includes('拒派'), 'degraded 不得含「拒派」；实际=' + text);
});

test('U-1 ④ 三态两两可区分（防「都含同一个词」式假绿）', () => {
  const rejected = renderTextOf({ lane: 'l1', mode: 'rejected', spawned: false, spawnNote: 'x' });
  const degraded = renderTextOf({ lane: 'l1', mode: 'degraded', spawned: false, spawnNote: 'x' });
  const ok = renderTextOf({ lane: 'l1', spawned: true, workerSessionId: 'ws-1' });
  assert.notEqual(rejected, degraded, 'rejected 与 degraded 渲染文本必须不同（这正是原缺陷）');
  assert.notEqual(rejected, ok, 'rejected 与成功渲染文本必须不同');
  assert.notEqual(degraded, ok, 'degraded 与成功渲染文本必须不同');
});
