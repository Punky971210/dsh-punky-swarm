// I-06 · 幂等回执（T-cmd：node --test test/receipt-idempotent.test.js）
//
// 判据纪律：幂等的**唯一**可信证据是「执行计数停住」+「换参数必须重新跑」这一对。
//   只断言「第二次 run:false」不够 —— 一个永远 `run:false` 的假实现也能过；
//   只断言「计数 ≤ 1」也不够 —— 0 也满足。故：计数**等值 1**，且**改任一参数必须重新可跑**。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  receiptFingerprint, shouldRun, recordReceipt, RECEIPT_ALREADY_APPLIED,
} from '../lib/state/receipt.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'lib', 'state', 'receipt.js');
const read = () => readFileSync(SRC, 'utf8');

const OP = { name: 'lane_claim', args: { batchId: 'b1', lane: 'l1' } };

test('I-06-1 幂等两态：首次可跑 ⇒ 登记 ⇒ 第二次被拒且理由带前缀；执行计数等值 1', () => {
  let ledger = { receipts: {}, execCount: 0 };
  const fp = receiptFingerprint(OP);

  const first = shouldRun(ledger, fp);
  assert.deepEqual(first, { run: true }, '首次必须可跑（否则幂等变成永久拒）');
  ledger = recordReceipt(ledger, fp, { lane: 'l1' });
  assert.equal(ledger.execCount, 1, '登记后计数必须等值 1');

  const second = shouldRun(ledger, fp);
  assert.equal(second.run, false, '同指纹第二次必须拒');
  assert.ok(String(second.reason).startsWith(RECEIPT_ALREADY_APPLIED),
    '拒因前缀必须是 RECEIPT_ALREADY_APPLIED，收到：' + second.reason);

  // 重放不得重跑：再次登记同一指纹 ⇒ 计数仍然等值 1（不是 2）
  const again = recordReceipt(ledger, fp, { lane: 'l1' });
  assert.equal(again.execCount, 1, '同指纹重复登记不得再计数（否则重放会重复执行）');
});

test('I-06-2 args 敏感四向（否则分不清「真幂等」与「恒拒」）', () => {
  const base = receiptFingerprint(OP);

  // ① 改值 ⇒ 指纹变 + 重新可跑
  const changedValue = receiptFingerprint({ name: 'lane_claim', args: { batchId: 'b1', lane: 'l2' } });
  assert.notEqual(changedValue, base, '改 args 值必须改变指纹');
  assert.deepEqual(shouldRun(recordReceipt({ receipts: {}, execCount: 0 }, base), changedValue), { run: true },
    '改参数后必须重新可跑（否则幂等退化成"同工具只能跑一次"）');

  // ② 改类型（'1' vs 1）⇒ 指纹变
  assert.notEqual(receiptFingerprint({ name: 'x', args: { v: 1 } }), receiptFingerprint({ name: 'x', args: { v: '1' } }),
    '类型 1 与 "1" 必须不同指纹');

  // ③ 改操作名 ⇒ 指纹变
  assert.notEqual(receiptFingerprint({ name: 'lane_release', args: OP.args }), base, '改操作名必须改变指纹');

  // ④ 键序 ⇒ 指纹**相同**（刻意语义：参数书写顺序不是语义）
  assert.equal(receiptFingerprint({ name: 'lane_claim', args: { lane: 'l1', batchId: 'b1' } }), base,
    '键序不得影响指纹（否则同一调用会有两个身份）');
});

test('I-06-3 指纹形状与稳定性：带 sha256: 前缀、重复计算稳定', () => {
  const fp = receiptFingerprint(OP);
  assert.match(fp, /^sha256:[0-9a-f]{64}$/, '指纹形状必须是 sha256:<64 hex>（不是裸 hex）');
  assert.equal(receiptFingerprint(OP), fp, '同输入必须稳定');
});

test('I-06-4 不可变性：recordReceipt 不修改入参 ledger（纯函数）', () => {
  const ledger = { receipts: {}, execCount: 0 };
  const snapshot = JSON.stringify(ledger);
  const fp = receiptFingerprint(OP);
  const next = recordReceipt(ledger, fp, { lane: 'l1' });
  assert.equal(JSON.stringify(ledger), snapshot, '入参 ledger 不得被修改');
  assert.notEqual(next, ledger, '必须返回新账（不是原地改）');
  assert.equal(next.execCount, 1, '新账计数 1');
});

test('I-06-5 零 IO：不读盘 / 不读环境 / 不取时钟 / 不用随机（源码级）', () => {
  const src = read();
  for (const pattern of [/fs\./, /process\.env/, /Date\.now/, /Math\.random/]) {
    assert.equal(pattern.test(src), false, '回执层不得出现外部取值：' + pattern);
  }
  const imports = src.split('\n').filter((l) => l.startsWith('import '));
  assert.ok(imports.every((l) => l.includes("'node:crypto'")), '唯一允许的依赖是确定性哈希，实际：' + JSON.stringify(imports));
});

test('I-06-6 零重叠边界：不 import 既有 receipt-store（本模块不做持久化）', () => {
  const src = read();
  assert.equal(src.includes('receipt-store'), false, '本模块不得引用 governance/receipt-store（持久化面不重叠）');
  assert.equal(/^(import|export)[^\n]*\bwriteFileSync\b/.test(src), false, '不得写盘');
});
