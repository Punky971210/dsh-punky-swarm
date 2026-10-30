/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/batch-preview-shape.test.js —— **I-20 验收**：`batch_control` 的 `preview:true` = **opt-in 纯读前置**。
//
// 文件名按计划 T-cmd 原文（`node --test test/batch-preview-shape.test.js`）。
// 判据源：`plan/p1-pack.md` I-20（零写入 / 真值 / 缺省形状逐字不变 / 确认后执行）。
//
// ⚠ 主证用 **sha256**（`e1-preview` 自报 `rev` 当前不存在，I-26 才引入）⇒ 「零写入」= 文件字节逐位不变。
//
// 可红形态（实现若写错 ⇒ 本文件哪条红）：
//   P1 若 preview 仍执行了写（哪怕只落一条事件）⇒ P1 的 sha256 比对红；
//   P2 若 `affected`/`skipped`/`totals` 只是复制而非预测 ⇒ P2 的真值断言红；
//   P3 若缺省返回**多出** `preview` 键 / 键集变化 ⇒ P3 的键集 deepEqual 红；
//   P4 若「确认后执行」也变成零写入（一律只预演）⇒ P4 的终态断言红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { createTools } from '../lib/tools/register.js';
import { threeTierTasks, seedArtifacts } from './helpers/gate-fixture.mjs';

const sha256Of = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** 隔离床：临时根 + 临时批（**绝不碰真实批**）。批含 exec + audit 两 lane（三层批最小骨架）。 */
function bedOf(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-i20-' + tag + '-'));
  const store = createStore(root);
  store.createBatch('sess-i20', {
    batchId: 'b-i20',
    wavePlan: buildWavePlan({ batchId: 'b-i20', tasks: threeTierTasks(['l1', 'l2']) }),
    phase: 'running',
  });
  seedArtifacts(root, 'sess-i20', 'b-i20', ['l1', 'l2']);
  store.setMember('sess-i20', 'b-i20', 'l1', 'running');
  const ctx = { tools: { register() {}, guard() {} }, logger: { info() {}, warn() {}, error() {}, debug() {} } };
  const { tools } = createTools(ctx, { store, root, config: {} });
  const file = path.join(root, 'sessions', 'sess-i20', 'batches', 'b-i20.json');
  const run = (args) => tools.find((t) => t.name === 'batch_control').execute(args, { agent: { session: { id: 'sess-i20' } } });
  return { root, store, file, run };
}

test('P1 preview:true ⇒ **零写入**：批文件 sha256 逐位不变，且 store 读回的 phase 不变', async () => {
  const bed = bedOf('p1');
  const before = sha256Of(bed.file);
  const r = await bed.run({ batchId: 'b-i20', action: 'pause', preview: true, session: 'sess-i20' });
  const after = sha256Of(bed.file);
  assert.equal(after, before, 'preview 前后批文件 sha256 必须逐位相同（零写入）；实际 ' + before + ' → ' + after);
  assert.equal(bed.store.readBatch('sess-i20', 'b-i20').phase, 'running', 'preview 不得改相位');
  assert.equal(typeof r.preview, 'object', '预演必须返回 preview 面（不抛即成功）；实际键=' + JSON.stringify(Object.keys(r)));
});

test('P2 预演真值：键集与 §2.2 spec 同形（affected/skipped/warnings/totals），且为**精确集合**', async () => {
  const bed = bedOf('p2');
  const r = await bed.run({ batchId: 'b-i20', action: 'pause', preview: true, session: 'sess-i20' });
  const p = r.preview;
  // spec §2.2：preview = { affected, skipped, warnings, totals }
  assert.deepEqual(Object.keys(p).sort(), ['affected', 'skipped', 'totals', 'warnings'], '键集必须与 spec §2.2 同形');
  assert.deepEqual([...p.affected].sort(), ['a1', 'l1', 'l2', 'p1'], 'affected 必须**精确等于**非终态 lane 集（不是 >=1）');
  assert.deepEqual(p.skipped, [], '无终态 lane ⇒ skipped 必须为空');
  assert.deepEqual(p.warnings, [], '本构造无告警 ⇒ warnings 必须为空');
  assert.deepEqual(p.totals, { affected: 4, skipped: 0 }, 'totals 必须精确');
  // 构造一条终态 lane（l2：running → review → merged）⇒ 必须从 affected 移入 skipped（精确集合，非 includes）
  bed.store.setMember('sess-i20', 'b-i20', 'l2', 'running');
  bed.store.setMember('sess-i20', 'b-i20', 'l2', 'review');
  bed.store.setMember('sess-i20', 'b-i20', 'l2', 'merged');
  const r2 = await bed.run({ batchId: 'b-i20', action: 'pause', preview: true, session: 'sess-i20' });
  assert.deepEqual([...r2.preview.affected].sort(), ['a1', 'l1', 'p1'], '终态 lane 必须移出 affected');
  assert.deepEqual(r2.preview.skipped, ['l2'], '终态 lane 必须精确进入 skipped');
  assert.deepEqual(r2.preview.totals, { affected: 3, skipped: 1 }, 'totals 必须随之精确变化');
});

test('P3 缺省形状**逐字不变**：键集 deepEqual ["action","batchId","phase"]，且**无 preview 键**', async () => {
  const bed = bedOf('p3');
  const r = await bed.run({ batchId: 'b-i20', action: 'pause', session: 'sess-i20' });
  const keys = Object.keys(r).filter((k) => r[k] !== undefined && k !== 'noop' && k !== 'danglingLanes').sort();
  assert.deepEqual(keys, ['action', 'batchId', 'phase'], '缺省返回键集必须逐字为三键；实际=' + JSON.stringify(Object.keys(r)));
  assert.equal(Object.prototype.hasOwnProperty.call(r, 'preview'), false, '缺省路径**不得**出现 preview 键（opt-in）');
});

test('P4 确认后执行：不带 preview ⇒ 真改相位；返回键集精确 3 键（不引入 preview）', async () => {
  const bed = bedOf('p4');
  const applied = await bed.run({ batchId: 'b-i20', action: 'pause', session: 'sess-i20' });
  assert.equal(bed.store.readBatch('sess-i20', 'b-i20').phase, 'paused', '确认后相位必须真变 paused（预演是预演、执行是执行）');
  // 非 preview 返回面按 spec 只有 {batchId, phase, action} —— `ok` 不在契约内（我原来的断言是自造要求，已删）
  const keys = Object.keys(applied).filter((k) => k !== 'noop' && k !== 'danglingLanes').sort();
  assert.deepEqual(keys, ['action', 'batchId', 'phase'], '非 preview 返回键集必须精确 3 键');
  assert.equal(Object.prototype.hasOwnProperty.call(applied, 'preview'), false, '执行路径不得带 preview 键');
});
