/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/deny-zero-write.test.js —— **I-26 验收**：写前拒绝 ⇒ **拒态零落盘**（sha256 + rev + mtimeMs 逐位相同）。
//
// 文件名按计划 T-cmd 原文（`node --test test/deny-zero-write.test.js`）。
// 判据源：`plan/p1-pack.md` I-26。`e3-deny` 实证：`atomicWrite` 必改 mtime ⇒ **mtimeMs 是最强指纹**。
//
// 拒态两条（`lib/state/store.js#assertBatchWriteAllowed`）：
//   D-1 盘上已**终态**（`complete`）时改相位 ⇒ 拒；
//   D-2 策略放宽/擦除 ⇒ 拒（判定单点 = `policy.js#isAtLeastAsTight`）。
//
// 可红形态：若拒态仍落盘（写后才拒/回滚）⇒ P1 的 sha256+mtimeMs 比对红；
//   若「一律拒」⇒ P2 成功路径（sha 变、rev+1）红；若判定不在 policy.js 单点 ⇒ P3 grep 红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { createTools } from '../lib/tools/register.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const sha256Of = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const revOf = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).__rev;

function bedOf(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-i26-' + tag + '-'));
  const store = createStore(root);
  store.createBatch('sess-i26', {
    batchId: 'b-i26',
    wavePlan: buildWavePlan({ batchId: 'b-i26', tasks: [{ id: 'e1', layer: 'exec' }, { id: 'a1', layer: 'audit', deps: ['e1'] }] }),
    phase: 'planning',
  });
  const ctx = { tools: { register() {}, guard() {} }, logger: { info() {}, warn() {}, error() {}, debug() {} } };
  const { tools } = createTools(ctx, { store, root, config: {} });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const file = path.join(root, 'sessions', 'sess-i26', 'batches', 'b-i26.json');
  const EXEC = { agent: { session: { id: 'sess-i26' } } };
  return { root, store, byName, file, EXEC };
}

test('P1 拒态逐字节（D-2 策略放宽）：抛 deny-zero-write:，且 sha256 / __rev / mtimeMs **逐位相同**', async () => {
  const bed = bedOf('p1');
  // 【白盒构造的理由（写进判据）】I-26 的**被测对象就是 store 层那道守卫**（`assertBatchWriteAllowed`）：
  //   公开工具只写相位、不带 `policy` ⇒ 造不出「策略放宽」；而**为测试给生产加一个「可写 policy」入口
  //   等于扩大攻击面**（那条入口自己还得再过门禁）。故直接用 store 的白盒写入口 `commitBatchLocked`
  //   （= `withBatchRowLock` → `commitBatch` → CAS → assertBatchWriteAllowed → atomicWrite）驱动 D-2。
  //   注意：**不去结算 audit lane 换终态**（那会污染真实批状态）。
  const strict = { allowed: ['run-1'], denied: ['evil'], limits: { hops: 3 } };
  const b0 = JSON.parse(fs.readFileSync(bed.file, 'utf8'));
  b0.policy = strict;
  await bed.store.commitBatchLocked('sess-i26', 'b-i26', b0); // 首次写：盘上无 policy ⇒ D-2 不触发（合法）

  const onDisk = JSON.parse(fs.readFileSync(bed.file, 'utf8'));
  assert.deepEqual(onDisk.policy, strict, '前置：严格策略必须**真的落盘**（读回确认，防「场景没触发」）');

  const before = { sha: sha256Of(bed.file), rev: revOf(bed.file), mtime: fs.statSync(bed.file).mtimeMs };
  // 放宽：allowed 追加剧（快照须取自**盘上**对象，否则 CAS 会先报版本冲突而非 D-2）
  const loosened = JSON.parse(fs.readFileSync(bed.file, 'utf8'));
  loosened.policy = { allowed: ['run-1', 'evil'], denied: ['evil'], limits: { hops: 3 } };
  let thrown = null;
  try {
    await bed.store.commitBatchLocked('sess-i26', 'b-i26', loosened);
  } catch (e) { thrown = e; }
  assert.ok(thrown, '策略放宽必须被拒（D-2）');
  assert.equal(String(thrown.message).startsWith('deny-zero-write:'), true,
    '拒因前缀必须为 deny-zero-write:；实际=' + String(thrown.message).slice(0, 160));

  const after = { sha: sha256Of(bed.file), rev: revOf(bed.file), mtime: fs.statSync(bed.file).mtimeMs };
  assert.equal(after.sha, before.sha, '拒态：sha256 必须逐位相同（零落盘）');
  assert.equal(after.rev, before.rev, '拒态：__rev 必须不变');
  assert.equal(after.mtime, before.mtime, '拒态：mtimeMs 必须逐位相同（atomicWrite 必改 mtime ⇒ 最强指纹）');
});

test('P2 成功路径阳性对照：合法写入 ⇒ sha256 变、__rev +1（排除「一律拒」的假绿）', async () => {
  const bed = bedOf('p2');
  const before = { sha: sha256Of(bed.file), rev: revOf(bed.file) };
  const r = await bed.byName.batch_phase.execute({ batchId: 'b-i26', phase: 'running', sourceRunId: 'run-1' }, bed.EXEC);
  assert.equal(r.ok ?? true, true, '合法写入应成功');
  const after = { sha: sha256Of(bed.file), rev: revOf(bed.file) };
  assert.notEqual(after.sha, before.sha, '成功写入 ⇒ sha256 必须变化（否则等于没写）');
  assert.equal(after.rev, String(Number(before.rev ?? 0) + 1) === String(after.rev) ? after.rev : Number(before.rev ?? 0) + 1,
    '成功写入 ⇒ __rev 必须 +1；实际 ' + before.rev + ' → ' + after.rev);
});

test('P3 判定单点：单调判定只在 `lib/governance/policy.js`，store 不重写判据', () => {
  const policySrc = fs.readFileSync(path.join(PKG, 'lib', 'governance', 'policy.js'), 'utf8');
  assert.equal(/export function isAtLeastAsTight/.test(policySrc), true, '判定须定义在 policy.js（单点）');
  const storeSrc = fs.readFileSync(path.join(PKG, 'lib', 'state', 'store.js'), 'utf8');
  assert.equal(/isAtLeastAsTight/.test(storeSrc), true, 'store 必须**引用**该单点（不重写判据）');
  // store 内不得出现第二份实现（即不得自行比较 allowed/denied/limits 三轴）
  assert.equal(/allowed\.(includes|some)|denied\.(includes|some)/.test(storeSrc), false,
    'store 不得内联三轴比较逻辑（判据唯一实现点 = policy.js）');
});
