/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/binding-zero-write-e2e.test.js —— **QT-4 / I-04 端到端零写入真跑**：绑定不匹配时**一个字节都不落盘**。
//
// 判据源：`plan/p1-pack.md` QT-4 ＋ `e1-binding` handoff 断言基线。
// 与 `test/binding-mismatch.test.js`（纯函数面）互补：本文件走**真实写入口**
//   （`buildWavePlan` + `store.createBatch` 造批 → `store.appendEvent` 登记派发 → `member_settle` 真写）。
//
// 三指纹判据（缺一不可）：
//   · `sha256` —— 整文件内容指纹；
//   · `__rev`  —— 批级 CAS 版本号（成功写入必 +1）；
//   · `mtimeMs` —— **最强**：任何 `atomicWrite`（含"写完改回"）都会改 mtime ⇒ 排除「先写后回滚」。
//
// ⚠ 夹具两坑（前两位踩过）：
//   ① `member` 写面的档位判据落在**调用方会话** ⇒ 每个调用方各写一条 C 档治理记录，否则先撞 GATE_MEMBER_REQUIRES_C；
//   ② `running→merged` 非法 ⇒ 阳性对照前先把 lane 置 `review`。
//
// 跑法（必须带 preload）：
//   node --import ./test/helpers/isolated-home.preload.mjs --test test/binding-zero-write-e2e.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { createTools } from '../lib/tools/register.js';
import { tempRoot, seedArtifacts } from './helpers/gate-fixture.mjs';

const S = 'sess-bzw';
const WORKER_E1 = 'sess-worker-e1';
const WORKER_A1 = 'sess-worker-a1';
const sha256Of = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const revOf = (f) => JSON.parse(fs.readFileSync(f, 'utf8')).__rev;

/** 真写入口造批（**禁裸 JSON**）：buildWavePlan + createBatch，照 api-batch-keys 的 makeBatch 形态。 */
function bedOf(tag) {
  const root = tempRoot('punky-bzw-' + tag + '-');
  const store = createStore(root);
  const batchId = 'b-bzw';
  const tasks = [
    { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], outputs: ['plan/spec.md'], cmd: 'survey' },
    { id: 'e1', layer: 'exec', consume: ['plan/spec.md'], produce: ['exec/e1.md'], outputs: ['exec/e1.md'], cmd: 'do' },
    {
      id: 'a1', layer: 'audit', consume: ['plan/spec.md', 'exec/e1.md'],
      produce: ['audit/a1.md'], outputs: ['audit/a1.md'], cmd: 'review', deps: ['e1'],
    },
  ];
  const plan = buildWavePlan({ batchId, team: 'software-team', tasks });
  store.createBatch(S, { batchId, wavePlan: plan, assembly: { auditLane: 'a1' } });

  // 产物种子：lane 迁移有 entry 门（GATE_ENTRY_MISSING: plan/spec.md）⇒ 必须先落下游要消费的产物
  seedArtifacts(root, S, batchId, ['e1', 'a1']);

  // 登记「谁被派发到哪条 lane」：真源 = batch.events 的 member.dispatch（`expectedWorkerSessionOf` 只读它）
  store.appendEvent(S, batchId, 'member.dispatch', { lane: 'e1', workerSessionId: WORKER_E1 });
  store.appendEvent(S, batchId, 'member.dispatch', { lane: 'a1', workerSessionId: WORKER_A1 });

  // 坑②：running→merged 非法 ⇒ 先置 review
  store.setMember(S, batchId, 'e1', 'running');
  store.setMember(S, batchId, 'e1', 'review');

  // 坑①：档位判据落在**调用方会话** ⇒ 两个调用方各写 C 档记录
  for (const sid of [WORKER_E1, WORKER_A1]) {
    store.writeGovernance(sid, {
      lastAssign: { form: 'C', difficulty: 'C', rationale: 'I-04 绑定零写入真跑夹具', at: new Date().toISOString() },
    });
  }

  const ctx = { tools: { register() {}, guard() {} }, logger: { info() {}, warn() {}, error() {}, debug() {} } };
  const { tools } = createTools(ctx, { store, root });
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  const file = path.join(root, 'sessions', S, 'batches', batchId + '.json');
  const settle = (caller, extra = {}) => by.member_settle.execute(
    { batchId, lane: 'e1', status: 'merged', session: S, ...extra },
    { agent: { session: { id: caller } } },
  );
  return { root, store, by, file, batchId, settle };
}

async function fingerprintsAfter(fn) {
  const bed = bedOf('fp');
  const before = { sha: sha256Of(bed.file), rev: revOf(bed.file), mtime: fs.statSync(bed.file).mtimeMs };
  let thrown = null;
  try { await fn(bed); } catch (e) { thrown = e; }
  const after = { sha: sha256Of(bed.file), rev: revOf(bed.file), mtime: fs.statSync(bed.file).mtimeMs };
  return { bed, before, after, thrown };
}

test('Q4-1 **不匹配 ⇒ 拒**：本批另一条 lane 的 worker 冒名结算 ⇒ 抛 binding-mismatch，三指纹逐位相同', async () => {
  const { before, after, thrown } = await fingerprintsAfter((bed) => bed.settle(WORKER_A1));
  assert.ok(thrown, '另一 lane 的已登记 worker 冒名结算 ⇒ 必须拒');
  assert.match(String(thrown.message), /binding-mismatch:/, '拒因前缀须为 binding-mismatch:；实际=' + String(thrown.message).slice(0, 160));
  assert.match(String(thrown.message), /member_settle\(lane=e1\)/, '拒因须含调用点');
  assert.equal(after.sha, before.sha, '**sha256 必须逐位相同**（零写入：拒发生在 store.setMember 之前）');
  assert.equal(after.rev, before.rev, '**__rev 必须不变**');
  assert.equal(after.mtime, before.mtime, '**mtimeMs 必须逐位相同**（atomicWrite 必改 mtime ⇒ 排除「写完改回」）');
});

test('Q4-2 同构造**放行对照**：本 lane 的 worker 结算 ⇒ 成功，且 sha256 变、__rev +1', async () => {
  const bed = bedOf('ok');
  const before = { sha: sha256Of(bed.file), rev: revOf(bed.file), mtime: fs.statSync(bed.file).mtimeMs };
  const out = await bed.settle(WORKER_E1);
  assert.equal(out.settled !== undefined, true, '放行路径必须真的走到结算（返回 settled 字段）');
  const after = { sha: sha256Of(bed.file), rev: revOf(bed.file), mtime: fs.statSync(bed.file).mtimeMs };
  assert.notEqual(after.sha, before.sha, '**sha256 必须变化**（成功写入的反向证据：排除「一律不写」的假绿）');
  assert.equal(Number(after.rev), Number(before.rev ?? 0) + 1, '**__rev 必须 +1**；实际 ' + before.rev + ' → ' + after.rev);
  assert.notEqual(after.mtime, before.mtime, '成功写入必然改 mtime（与 Q4-1 的「不变」成对）');
});

test('Q4-3 拒的可审计性：拒因回显 expected / actual 两个身份（谁被谁顶替）', async () => {
  const { thrown } = await fingerprintsAfter((bed) => bed.settle(WORKER_A1));
  const msg = String(thrown?.message ?? '');
  assert.equal(msg.includes(WORKER_E1), true, '须含 expected（被顶替方）：' + msg.slice(0, 200));
  assert.equal(msg.includes(WORKER_A1), true, '须含 actual（冒名方）：' + msg.slice(0, 200));
});

test('Q4-4 治理面**不误伤**：批归属会话（Leader）结算本 lane ⇒ 放行；陌生会话带 session 覆写 ⇒ 拒且零写入', async () => {
  const bed = bedOf('gov');
  // 【批 `punky-prerelease-scan` · lane `e1-session-plane` · **D-01 已修 ⇒ 契约变更，非回归**】
  //   旧断言把「陌生会话 `sess-leader` + 显式 `session:S` 覆写」当作**治理面放行**——那正是 D-01 的
  //   越权原语（与 AC-10 的攻击面逐字同形）；AC-10 落地后二者不可能同时成立。
  //   治理面的正确含义 = **批归属会话本身**（本夹具 `S = 'sess-bzw'`），不是「任意非 worker 会话」。
  //   「不误伤」的检测力照旧保留：归属会话必须放行、且必须**真写入**（sha 变化）。
  // 坑①延伸：档位判据落在**调用方** ⇒ 两个调用方各写一条 C 档记录（否则先撞 GATE_MEMBER_REQUIRES_C，
  //   测不到本用例要测的那道门）。
  for (const sid of [S, 'sess-stranger']) {
    bed.store.writeGovernance(sid, {
      lastAssign: { form: 'C', difficulty: 'C', rationale: 'I-04 治理面放行夹具', at: new Date().toISOString() },
    });
  }
  const before = { sha: sha256Of(bed.file) };
  const out = await bed.settle(S);                        // 归属会话 ⇒ 放行
  assert.equal(out.settled !== undefined, true, '治理面调用必须放行（不得因绑定误拦）');
  assert.notEqual(sha256Of(bed.file), before.sha, '治理面放行 ⇒ 真写入（sha 变化）');
  // 反向锁（与 AC-10 / RQ-1 同形）：陌生会话带 `session:S` ⇒ 属主门拒且零写入
  const shaAfter = sha256Of(bed.file);
  const revAfter = revOf(bed.file);
  await assert.rejects(() => bed.settle('sess-stranger'), /GATE_SESSION_UNAUTHORIZED/);
  assert.equal(sha256Of(bed.file), shaAfter, '属主门拒 ⇒ 零写入（sha256 逐位不变）');
  assert.equal(revOf(bed.file), revAfter, '属主门拒 ⇒ __rev 不变');
});
