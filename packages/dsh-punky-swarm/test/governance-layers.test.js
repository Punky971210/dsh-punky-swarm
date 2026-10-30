// I-25 · 四层否决面（补 grep=4 的弱判据 ⇒ 行为面为主判据）
//
// 为什么 grep 不算：`grep -c -e processLayer -e runLayer …= 4` 在**注释里出现**也算数 ——
//   四个同名的别名实现（四层都调同一个函数）同样能过 grep，却让四层退化成一层。
// 故本文件的主判据是**集合**：五场景各自的「拒层名集」必须恰好等于目标层。
//
// 反例方向（每条都能红）：把四层改成同一别名 ⇒ S1 得四层同拒 ⇒ S1 用例红；
//   反过来把判据写成「拒层集 ⊇ 目标层」也会红 —— 因为 S1 会多出三层。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  processLayer, runLayer, environmentLayer, transactionLayer,
} from '../lib/governance/layers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LAYERS_SRC = join(ROOT, 'lib', 'governance', 'layers.js');

/** 四层按声明顺序（层序即执行序；集合断言不依赖顺序，但遍历要固定）。 */
const LAYERS = [
  ['process', processLayer],
  ['run', runLayer],
  ['environment', environmentLayer],
  ['transaction', transactionLayer],
];

/** 组合判据：给定 facts ⇒ 返回「拒绝」的层名集（升序，便于 deepEqual）。 */
function deniedLayersOf(facts) {
  return LAYERS.filter(([, fn]) => fn(facts).allowed === false).map(([name]) => name).sort();
}

test('I-25-1 四层各自单独可调：单层函数独立导出、独立返回 {allowed, layer, reason?}', () => {
  for (const [name, fn] of LAYERS) {
    assert.equal(typeof fn, 'function', name + ' 必须是可独立调用的函数');
    const ok = fn({});
    assert.deepEqual(Object.keys(ok).sort(), ['allowed', 'layer'], name + ' 放行形态只含 allowed/layer');
    assert.equal(ok.allowed, true);
    assert.equal(ok.layer, name, name + ' 必须自报层名（不是别名冒充）');
  }
});

test('I-25-2 五场景拒层集合 deepEqual（主判据）：每场景恰命中目标层，且不误伤其它层', () => {
  const scenarios = [
    ['S1 进程占用', { processOccupied: true }, ['process']],
    ['S2 run 配额耗尽', { runQuotaExhausted: true }, ['run']],
    ['S3 路径越界', { pathInsideWorkspace: false }, ['environment']],
    ['S4 非事务写前', { inTransaction: false }, ['transaction']],
    ['S5 全正常', {}, []],
  ];
  for (const [label, facts, expected] of scenarios) {
    assert.deepEqual(deniedLayersOf(facts), expected,
      label + ' 的拒层集合必须恰好等于 ' + JSON.stringify(expected) + '（多出/缺少都红）');
  }
});

test('I-25-3 判据非恒真：同一场景「拒 ⇒ 放」两态（去掉坏事实即放行）', () => {
  assert.deepEqual(deniedLayersOf({ processOccupied: true }), ['process']);
  assert.deepEqual(deniedLayersOf({ processOccupied: false }), [], 'processOccupied=false 是正常事实，不拒');
  assert.deepEqual(deniedLayersOf({ pathInsideWorkspace: false }), ['environment']);
  assert.deepEqual(deniedLayersOf({ pathInsideWorkspace: true }), [], '在工作区内 ⇒ 放行');
  assert.deepEqual(deniedLayersOf({ inTransaction: false }), ['transaction']);
  assert.deepEqual(deniedLayersOf({ inTransaction: true }), [], '在事务内 ⇒ 放行');
  assert.deepEqual(deniedLayersOf({ runQuotaExhausted: true }), ['run']);
  assert.deepEqual(deniedLayersOf({ runQuotaExhausted: false }), [], '配额未耗尽 ⇒ 放行');
});

test('I-25-4 别名反例可红（两态）：四层若指向同一实现 ⇒ S1 变成四层同拒，集合断言必红', () => {
  // 第一态：真实实现 ⇒ S1 恰 ['process']
  assert.deepEqual(deniedLayersOf({ processOccupied: true }), ['process']);

  // 第二态：**模拟别名实现**（四层都是 processLayer 的替身）⇒ S1 得四层同拒
  const aliased = [['process', processLayer], ['run', processLayer], ['environment', processLayer], ['transaction', processLayer]];
  const aliasedDenied = aliased.filter(([, fn]) => fn({ processOccupied: true }).allowed === false).map(([name]) => name).sort();
  assert.deepEqual(aliasedDenied, ['environment', 'process', 'run', 'transaction'],
    '别名实现必须产出四层同拒');
  assert.notDeepEqual(aliasedDenied, ['process'],
    '别名实现与真实实现的集合必须不同 —— 这才是「grep=4 不足以证明四层存在」的证明');
});

test('I-25-5 grep=4 仅作必要不充分（源码在册，但判据归上一条集合断言）', () => {
  const src = readFileSync(LAYERS_SRC, 'utf8');
  for (const name of ['processLayer', 'runLayer', 'environmentLayer', 'transactionLayer']) {
    assert.ok(src.includes(name), name + ' 必须在源码中出现（必要不充分）');
  }
  assert.equal(/^export function processLayer\b/m.test(src), true, '四层各自是独立导出函数（非别名）');
  assert.equal(/^export function runLayer\b/m.test(src), true);
  assert.equal(/^export function environmentLayer\b/m.test(src), true);
  assert.equal(/^export function transactionLayer\b/m.test(src), true);
});
