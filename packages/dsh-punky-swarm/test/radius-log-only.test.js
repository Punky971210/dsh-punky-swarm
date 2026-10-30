/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/radius-log-only.test.js —— **I-21 验收**：`log_only` **只观测不阻止**（与 `enforce` 成对）。
//
// 文件名按计划 T-cmd 原文（`node --test test/radius-log-only.test.js`）。
// 判据源：`plan/p1-pack.md` I-21 ＋ `e3-radius` handoff 断言基线。
//
// ⚠ 本文件的核心判据是**态2**：超限时 `over:true` 与 `blocked:false` **同时出现** ——
//   `over:true` 证明「超限事实被观测到」，`blocked:false` 证明「没有阻止」；缺任一条都测不出「只观测不阻止」。
//
// 可红形态：
//   R1 若 `log_only` 顺手也拦（`blocked:true`）⇒ 态2 红（最重）；
//   R2 若 `enforce` 不拦 ⇒ 态3 红；若 `enforce` 未超限也拦 ⇒ 态3 对照红；
//   R3 若上限硬写 `20`（不引用常量）⇒ 常量 grep 判据红；
//   R4 若同 `(runId,taskId)` 重复计数 ⇒ 幂等红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createRadiusCounter, MAX_RADIUS_CHANGED_TASKS, RADIUS_MODES,
} from '../lib/engine/radius.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const SRC = path.join(PKG, 'lib', 'engine', 'radius.js');

test('I21-态1 log_only 达上限（20 件）：第 20 件仍在界内 over:false / blocked:false', () => {
  const c = createRadiusCounter();
  assert.equal(c.mode(), 'log_only', '缺省模式必须是 log_only（观测优先）');
  let last = null;
  for (let i = 1; i <= MAX_RADIUS_CHANGED_TASKS; i += 1) last = c.record('run-A', 'task-' + i);
  assert.deepEqual(last, { count: MAX_RADIUS_CHANGED_TASKS, over: false, blocked: false },
    '严格大于才算超 ⇒ 达上限仍在界内；实际=' + JSON.stringify(last));
});

test('I21-态2【关键】log_only 超限：**over:true 且 blocked:false 同时出现**（只观测不阻止）', () => {
  const c = createRadiusCounter({ mode: 'log_only' });
  for (let i = 1; i <= MAX_RADIUS_CHANGED_TASKS; i += 1) c.record('run-B', 'task-' + i);
  const r = c.record('run-B', 'task-over'); // 第 21 件
  assert.equal(r.count, MAX_RADIUS_CHANGED_TASKS + 1, '第 21 件必须被**计数**（观测面不能静默）');
  assert.equal(r.over, true, '**over:true** —— 超限事实必须被观测到');
  assert.equal(r.blocked, false, '**blocked:false** —— log_only 不得阻止（若实现顺手也拦 ⇒ 此处必红）');
  // 成对性：同一状态下 snapshot 也必须显示超限（观测面一致）
  const snap = c.snapshot('run-B');
  assert.deepEqual(snap, { count: r.count, over: true }, 'snapshot 必须与 record 的观测一致');
});

test('I21-态3 enforce 两态对照：超限才阻 / 未超限不阻', () => {
  // ① 超限 ⇒ blocked:true
  const c = createRadiusCounter({ mode: 'enforce' });
  for (let i = 1; i <= MAX_RADIUS_CHANGED_TASKS; i += 1) c.record('run-C', 'task-' + i);
  const over = c.record('run-C', 'task-over');
  assert.equal(over.over, true); assert.equal(over.blocked, true, 'enforce 超限必须阻止；实际=' + JSON.stringify(over));
  // ② 未超限（全新 counter，只 5 件）⇒ 不阻
  const c2 = createRadiusCounter({ mode: 'enforce' });
  let last = null;
  for (let i = 1; i <= 5; i += 1) last = c2.record('run-D', 't-' + i);
  assert.deepEqual(last, { count: 5, over: false, blocked: false }, 'enforce 未超限**不得**阻止；实际=' + JSON.stringify(last));
});

test('I21-态4 幂等 ＋ 跨任务累加：同 (runId,taskId) 计数恒 1；混合序列 [1,2,3,3,4,4,5]', () => {
  const c = createRadiusCounter();
  const first = c.record('run-E', 'task-1');
  const again = c.record('run-E', 'task-1');
  assert.equal(again.count, 1, '同 (runId,taskId) 重复记录计数恒 1（幂等）；实际=' + JSON.stringify([first, again]));

  const seq = [];
  for (const t of ['x1', 'x2', 'x3', 'x1', 'x4', 'x2', 'x5']) seq.push(c.record('run-F', t).count);
  assert.deepEqual(seq, [1, 2, 3, 3, 4, 4, 5], '跨任务累加序列必须精确；实际=' + JSON.stringify(seq));
  assert.deepEqual(c.snapshot('run-unknown'), { count: 0, over: false }, '未记录的 run ⇒ {count:0,over:false}（不抛）');
});

test('I21-上限走常量：唯一定义 1 处、判定处无字面比较、limit 可注入', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.equal((src.match(/^export const MAX_RADIUS_CHANGED_TASKS\s*=/gm) ?? []).length, 1,
    '上限必须唯一定义（导出常量）');
  assert.equal(MAX_RADIUS_CHANGED_TASKS, 20, '常量取值 20');
  assert.equal((src.match(/(>=|>|<=|<|===|==)\s*20\b/g) ?? []).length, 0,
    '判定处不得出现字面量 20 比较（必须引用常量）');
  assert.deepEqual(RADIUS_MODES, ['log_only', 'enforce'], '模式闭集两值');
  assert.equal(Object.isFrozen(RADIUS_MODES), true, '模式闭集必须冻结');
  // limit 可注入 ⇒ 证明比较确实走 limit 而非硬常量
  const c = createRadiusCounter({ limit: 2 });
  assert.equal(c.limit(), 2);
  assert.equal(c.record('run-G', 'a').over, false, '1/2 不超');
  assert.equal(c.record('run-G', 'b').over, false, '2/2 不超（严格大于才算超）');
  assert.equal(c.record('run-G', 'c').over, true, '3/2 必超');
});

test('I21-非法值 fail-fast：模式/输入非法必须抛且不改状态', () => {
  assert.throws(() => createRadiusCounter({ mode: 'block' }), /radius-mode-invalid:/, '未知模式必须抛（不得静默降级）');
  const c = createRadiusCounter();
  assert.throws(() => c.setMode('nope'), /radius-mode-invalid:/);
  assert.equal(c.mode(), 'log_only', '抛后模式不得被改动（fail-fast 不产生半改）');
  assert.throws(() => createRadiusCounter({ limit: 0 }), /radius-input-invalid:/, 'limit 非正必须抛');
  assert.throws(() => c.record('', 'x'), /radius-input-invalid:/, 'runId 空串必须抛（调用缺陷）');
  assert.throws(() => c.record('run-H', ''), /radius-input-invalid:/, 'taskId 空串必须抛');
});
