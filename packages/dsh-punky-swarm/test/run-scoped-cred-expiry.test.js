/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/run-scoped-cred-expiry.test.js —— **B4 / I-18 验收**：run-scoped 凭据的过期与吊销（双路）。
//
// 文件名按**计划 T-cmd 原文**：`node --test test/run-scoped-cred-expiry.test.js`（名字不对就跑不到 = 0 测试）。
//
// 判据源：`plan/p1-pack.md` AC-3/AC-4/AC-2/AC-5。
// 纪律：时钟**注入**（禁真等 45 分钟）；每条判据给两态；**禁数量断言**（`size()` 只作展示位，不作判据）。
//
// 每条判据的**可红形态**（实现若写错 ⇒ 本文件哪条红）：
//   E1 若 `resolve` 用 `now() > expiresAt`（而非 `>=`）⇒ 恰 `expiresAt` 处仍有值 ⇒ 红；
//   E2 若 `resolve` 在过期时**抛错**（而非返回 null）⇒ `assert.doesNotThrow` 处红；
//   R1 若 `revoke` 不判 id、直接吊销全部 ⇒ 「另一 run 不误伤」红；
//   R2 若钩子按 `runId` 取而不是 `info.id` ⇒ 吊销后 `resolve` 仍有值 ⇒ 红；
//   T1 若 `ctx.on` 不可用时抛错 ⇒ `installed:false 且不抛` 红；
//   T2 若只做钩子、不做惰性 `expiresAt` ⇒ 「无钩子仅推时钟」红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createRunScopedCredentials, installRunScopedCredentialRevoker,
  CREDENTIAL_EXPIRED, DEFAULT_TTL_MS,
} from '../lib/credentials/run-scoped.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');

/** 可推进时钟（模块时钟注入；禁真等）。 */
function clockOf(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; return t; }, set: (v) => { t = v; return t; } };
}

test('E1 过期两态：expiresAt **早 1ms** 仍有值；恰 expiresAt 及之后 ⇒ null 且**不抛**', () => {
  const clock = clockOf();
  const store = createRunScopedCredentials({ now: clock.now });
  const issued = store.issue('run-a', { secret: 's' });
  assert.equal(issued.expiresAt, issued.issuedAt + DEFAULT_TTL_MS, 'TTL 缺省 45min（2700000ms）');

  clock.set(issued.expiresAt - 1); // ← 早 1ms
  const before = store.resolve('run-a');
  assert.ok(before, '早 1ms 必须有值（边界正确）；实际=' + JSON.stringify(before));
  assert.equal(before.secret, 's', '凭据值随视图返回');

  clock.set(issued.expiresAt); // ← 恰 expiresAt（>= 即过期）
  assert.doesNotThrow(() => store.resolve('run-a'), '过期**不得抛错**（返回 null 即可）');
  assert.equal(store.resolve('run-a'), null, '恰 expiresAt ⇒ null');

  clock.advance(1); // ← 过后 1ms
  assert.equal(store.resolve('run-a'), null, '过 expiresAt ⇒ null');
});

test('E1b CREDENTIAL_EXPIRED 前缀常量在场且形状可辨（供调用方区分「过期」与「不存在」）', () => {
  assert.equal(typeof CREDENTIAL_EXPIRED, 'string');
  assert.ok(CREDENTIAL_EXPIRED.length > 0);
  assert.equal(CREDENTIAL_EXPIRED.startsWith('credential-expired'), true, '实际=' + CREDENTIAL_EXPIRED);
});

test('R1 吊销态：打桩 subagent/end{id} ⇒ resolve(id)=null；**另一 run 不误伤**；无 id 帧不抛', () => {
  const clock = clockOf();
  const store = createRunScopedCredentials({ now: clock.now });
  store.issue('run-a', { secret: 'a' });
  store.issue('run-b', { secret: 'b' });

  // 打桩 ctx.on：捕获注册的回调，由测试**驱动真实钩子**
  let handler = null;
  const ctx = { on: (event, fn) => { assert.equal(event, 'subagent/end', '须挂在 subagent/end'); handler = fn; return () => {}; } };
  const inst = installRunScopedCredentialRevoker(ctx, store);
  assert.equal(inst.installed, true, '有 ctx.on ⇒ installed:true');
  assert.equal(typeof handler, 'function', '必须真注册回调');

  assert.ok(store.resolve('run-a'), '吊销前有值');
  handler({ id: 'run-a' }); // ← 驱动钩子（payload 取 info.id）
  assert.equal(store.resolve('run-a'), null, '吊销后 ⇒ null');
  assert.ok(store.resolve('run-b'), '**另一 run 不得被误伤**');

  assert.doesNotThrow(() => handler({}), '无 id 帧不得抛');
  assert.doesNotThrow(() => handler(undefined), '空帧不得抛');
  assert.ok(store.resolve('run-b'), '无 id 帧不影响任何 run');
});

test('R2 反例（关键）：**拿宿主 runId 当键** ⇒ 取不到（键名唯一 sourceRunId，禁第二身份源）', () => {
  const clock = clockOf();
  const store = createRunScopedCredentials({ now: clock.now });
  store.issue('run-a', { secret: 'a' });
  // 若实现允许第二身份源（runId/任意键），这里会取到值 ⇒ 本断言红
  assert.equal(store.resolve('some-host-run-id'), null, '宿主 runId 不是身份键 ⇒ 必须取不到');
  assert.equal(store.resolve(undefined), null);
  assert.equal(store.resolve(null), null);
  // 机核：模块里不得出现宿主 runId 这个词
  const dir = path.join(PKG, 'lib', 'credentials');
  const src = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.equal((src.match(/\brunId\b/g) ?? []).length, 0, 'lib/credentials/** 不得出现宿主 runId（第二身份源）');
});

test('T1 无钩子兜底：ctx.on 不可用 ⇒ installed:false（不抛）；且**仅推时钟**越过 expiresAt ⇒ null', () => {
  const clock = clockOf();
  const store = createRunScopedCredentials({ now: clock.now });
  const issued = store.issue('run-z', { secret: 'z' });

  const inst = installRunScopedCredentialRevoker({}, store); // ← 无 ctx.on
  assert.equal(inst.installed, false, '无 ctx.on ⇒ installed:false');
  assert.equal(inst.reason, 'no-ctx.on', '必须给出可读理由：实际=' + inst.reason);

  // 路 2（惰性兜底）：全程无钩子，仅推时钟 ⇒ null
  assert.ok(store.resolve('run-z'), '时钟未越界时有值');
  clock.set(issued.expiresAt + 1);
  assert.equal(store.resolve('run-z'), null, '仅推时钟越过 expiresAt ⇒ null（不依赖任何钩子）');
});

test('T2 未知 id 吊销：revoke(未知)=false、幂等（二次 revoke=false），均**不抛**', () => {
  const clock = clockOf();
  const store = createRunScopedCredentials({ now: clock.now });
  store.issue('run-a');
  assert.equal(store.revoke('nope'), false, '未知 id ⇒ false（不抛）');
  assert.equal(store.revoke('run-a'), true, '首次吊销 ⇒ true');
  assert.equal(store.revoke('run-a'), false, '幂等：二次吊销 ⇒ false');
});

test('S1 红线：凭据层**零门禁策略码**（不做判定，只存凭据）', () => {
  const dir = path.join(PKG, 'lib', 'credentials');
  const src = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  const tokens = ['gateDecision', 'judge', 'matchToolBan', 'SUITE_DENY_TOOLS', 'MODE_GATED_TOOLS', 'assertModeActive'];
  const hits = tokens.filter((t) => new RegExp('\\b' + t + '\\b').test(src));
  assert.deepEqual(hits, [], 'lib/credentials/** 不得出现门禁/策略码；命中=' + JSON.stringify(hits));
});
