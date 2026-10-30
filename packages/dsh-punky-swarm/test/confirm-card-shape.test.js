/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/confirm-card-shape.test.js —— **I-29 验收**：变更卡**形状稳定**（同形状、非同一张卡）。
//
// 文件名按计划 T-cmd 原文（`node --test test/confirm-card-shape.test.js`）。
// 判据源：`plan/p1-pack.md` I-29 ＋ `e3-card` handoff 断言基线。
//
// ⚠ 「同一形状」**不是**「同一内容」：键集与**类型**必须一致，**值必须不同**（否则就是把三种变更糊成一张卡）。
//
// 可红形态：
//   C1 若不同场景返回**不同键集** ⇒ C1 红；
//   C2 若某字段为空壳（空串/null）⇒ C2 红（有键无值无法裁决）；
//   C3 若三个场景返回**同一张卡**（值也相同）⇒ C3 红（说明 kind/summary 没被采纳）；
//   C4 若实现读时钟/随机 ⇒ 同输入两次结果不同 ⇒ C4 红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import pathSync from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfirmCard, CARD_FIELDS } from '../lib/engine/confirm-card.js';

const SCENES = {
  phase: { kind: 'phase', title: '暂停批次 b-1', summary: '把 b-1 从 running 改为 paused', options: ['confirm', 'cancel'], authority: 'batch-owner', createdAt: 1_700_000_000_000 },
  member: { kind: 'member', title: '结算 lane e1', summary: '把 e1 结算为 merged', options: ['confirm', 'cancel'], authority: 'lane-worker', createdAt: 1_700_000_000_001 },
  third: { kind: 'third', title: '第三方裁决', summary: '需要人工裁决 use1 的冲突', options: ['accept', 'reject'], authority: 'supervisor', createdAt: 1_700_000_000_002 },
};

test('C1 两（三）不同场景 ⇒ 键集 sort 后 **deepEqual 相同**，且恒等于 CARD_FIELDS', () => {
  const keysets = Object.values(SCENES).map((s) => Object.keys(buildConfirmCard(s)).sort());
  const base = keysets[0];
  for (let i = 1; i < keysets.length; i += 1) {
    assert.deepEqual(keysets[i], base, '不同场景的键集必须**完全相同**（第 ' + i + ' 个场景不符）');
  }
  assert.deepEqual(base, [...CARD_FIELDS].sort(), '键集必须恒等于 CARD_FIELDS（7 键）');
});

test('C2 字段非空且类型一致：title/summary/authority 恒非空；options 是数组；cardId 是字符串', () => {
  const types = new Set();
  for (const [name, scene] of Object.entries(SCENES)) {
    const card = buildConfirmCard(scene);
    assert.equal(typeof card.title === 'string' && card.title.length > 0, true, name + '：title 非空字符串');
    assert.equal(typeof card.summary === 'string' && card.summary.length > 0, true, name + '：summary 非空字符串');
    assert.equal(typeof card.authority === 'string' && card.authority.length > 0, true, name + '：authority 非空字符串');
    assert.equal(Array.isArray(card.options), true, name + '：options 必须是数组');
    assert.equal(typeof card.cardId === 'string' && card.cardId.length > 0, true, name + '：cardId 非空字符串');
    types.add(Object.keys(card).sort().map((k) => k + ':' + (Array.isArray(card[k]) ? 'array' : card[k] === null ? 'null' : typeof card[k])).join('|'));
  }
  assert.equal(types.size, 1, '三种场景的「键 + 类型」指纹必须**唯一**（类型漂移说明形状不稳）；实际=' + [...types].join(' ; '));
});

test('C3 「同一形状」≠「同一张卡」：值必须不同，且各自采纳输入（防糊成一张）', () => {
  const cards = Object.entries(SCENES).map(([name, s]) => [name, buildConfirmCard(s)]);
  const ids = new Set(cards.map(([, c]) => c.cardId));
  assert.equal(ids.size, cards.length, '每张卡的 cardId 必须唯一；实际=' + [...ids].join(','));
  for (const [name, card] of cards) {
    const scene = SCENES[name];
    assert.equal(card.kind, scene.kind, name + '：kind 必须采纳输入');
    assert.equal(card.title, scene.title, name + '：title 必须采纳输入（不得一律用同一文案）');
    assert.deepEqual(card.options, scene.options, name + '：options 必须采纳输入');
    assert.equal(card.authority, scene.authority, name + '：authority 必须采纳输入');
  }
});

test('C4 纯函数：同一入参两次 ⇒ **逐字相同**（禁读时钟/随机）', () => {
  const card1 = buildConfirmCard(SCENES.phase);
  const card2 = buildConfirmCard(SCENES.phase);
  assert.deepEqual(card1, card2, '同输入必须同输出（读时钟/随机会让两次不等 ⇒ 本断言红）');
  assert.equal(JSON.stringify(card1), JSON.stringify(card2), '连键序也必须一致（可复算）');
  // 空壳输入：仍须给出非空 title/summary/authority（结构性排除「有键无值」）
  const bare = buildConfirmCard({});
  assert.equal(bare.title.length > 0 && bare.summary.length > 0 && bare.authority.length > 0, true,
    '缺省输入也不得产出空壳卡（无值无法裁决）');
  assert.equal(bare.createdAt, null, '未给 createdAt ⇒ null（不得偷偷读时钟）');
});

test("C5 不读时钟/随机：源码层面零时钟与随机调用（形状稳定性的前提）", () => {
  // 读源码做一次补充判据（行为面已由 C4 覆盖）：本文件不得引入时间/随机源
  const srcPath = pathSync.join(pathSync.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'engine', 'confirm-card.js');
  const src = fsSync.readFileSync(srcPath, 'utf8');
  assert.equal(/Date.now|new Date|Math.random|performance.now/.test(src), false,
    'confirm-card 不得读时钟或随机（否则「同输入同卡」不成立）');
});
