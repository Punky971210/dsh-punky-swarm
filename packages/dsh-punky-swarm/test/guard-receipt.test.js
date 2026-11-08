/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// 【⑥-1 · 2026-11-08 裁决乙1b】守卫通道拒绝留痕。
//
// 被测面：`tools/tier-gate.js#installDifficultyGuard`（B）与
//        `tools/write-provenance-guard.js#installWriteProvenanceGuard`（C）的拒绝
//        经 `governance/guard-receipt.js` 落**链式收据** + **拒因事件流**。
// 不测什么：不测「拒绝串长什么样」（那是既有判据）；不测升级链（裁决明确 乙1b 不接升级）。
// 判据形态：身份集合 + 字段值，不用命中计数。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  recordGuardRefusal, sourceOfGuardReason, GUARD_SOURCE,
} from '../lib/governance/guard-receipt.js';
import { readRefusals, eventStreamFileOf } from '../lib/governance/receipt-store.js';
import { installDifficultyGuard } from '../lib/tools/tier-gate.js';
import { installWriteProvenanceGuard } from '../lib/tools/write-provenance-guard.js';
import { tempRoot } from './helpers/gate-fixture.mjs';

/** 承接 guard 回调的假宿主：`ctx.tools.guard(fn)` 只把 fn 交出来（判据在本测试里手动触发）。 */
function fakeHost() {
  const captured = [];
  const ctx = { tools: { guard: (fn) => { captured.push(fn); } }, logger: { warn: () => {}, info: () => {} } };
  return { ctx, guard: () => captured[captured.length - 1] };
}

/** 难度门的依赖桩：一切「未评估」⇒ 必拒（不构造复杂治理状态）。 */
function storeStub() {
  return {
    readGovernance: () => ({}),
    stale: () => true,
    listBatches: () => [],
    readBatch: () => null,
    bumpExecCount: () => {},
  };
}

const EXEC_PW = { name: 'pwsh', callId: 'call-b1', arguments: { command: 'rm -rf build' }, agent: { session: { id: 'sess-g' } } };

// ── ① 来源映射（B 的子门 → 审计可定位的标识）──────────────────────────────────────
test('sourceOfGuardReason：按拒因前缀映射来源（mode / D 通道 / allowlist / approval / 只读 / 默认难度门）', () => {
  assert.equal(sourceOfGuardReason('mode-inactive: 本会话所属模式…'), GUARD_SOURCE.MODE);
  assert.equal(sourceOfGuardReason('GATE_DIFFICULTY_CHANNEL_UNRESOLVED: 本会话声明 difficulty=D…'), GUARD_SOURCE.CHANNEL);
  assert.equal(sourceOfGuardReason('allowlist-denied: pwsh'), GUARD_SOURCE.ALLOWLIST);
  assert.equal(sourceOfGuardReason('x [errorFamily=allowlist errorCode=allowlist-not-permitted]'), GUARD_SOURCE.ALLOWLIST);
  assert.equal(sourceOfGuardReason('approval-needed-409: pwsh'), GUARD_SOURCE.APPROVAL);
  assert.equal(sourceOfGuardReason('approval-args-mismatch: pwsh'), GUARD_SOURCE.APPROVAL);
  assert.equal(sourceOfGuardReason('[task-difficulty-gate] 本回合尚未进行任务难度评估'), GUARD_SOURCE.DIFFICULTY);
});

// ── ② 留痕本体：收据 + 事件流，且与 A 的收据同 schema ───────────────────────────────
test('recordGuardRefusal：落链式收据（可 verifyRefusals）+ 拒因事件流，source 标通道、ruleRefs 标来源', () => {
  const root = tempRoot('guard-r-');
  const receipt = recordGuardRefusal(root, EXEC_PW, { reason: 'source-run-id-missing: lane_claim', source: GUARD_SOURCE.PROVENANCE });
  assert.ok(receipt, '必须返回落盘收据');
  assert.equal(receipt.source, GUARD_SOURCE.PROVENANCE);
  assert.equal(receipt.decision.primitive, 'DENY', '守卫拒态一律按 DENY 留痕');
  assert.deepEqual(receipt.ruleRefs, [GUARD_SOURCE.PROVENANCE], 'ruleRefs 承载来源标识（A 承载规则 id；收据 schema 里在顶层）');
  assert.equal(receipt.tool, 'pwsh');
  assert.equal(receipt.sessionId, 'sess-g');

  const onDisk = readRefusals(root, 'sess-g');
  assert.deepEqual(onDisk.map((r) => r.receiptId), [receipt.receiptId], '收据目录须恰有这一条');
  assert.ok(onDisk[0].anchor && onDisk[0].anchor.alg === 'sha256', '必须带锚（与 A 同 schema，可链式校验）');

  const jsonl = eventStreamFileOf(root, 'sess-g');
  assert.ok(fs.existsSync(jsonl), '拒因事件流文件必须存在');
  const entries = fs.readFileSync(jsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(entries.map((e) => e.type), ['governance.refusal.recorded'], '事件类型单点');
  assert.equal(entries[0].primitive, 'DENY');
  assert.equal(entries[0].receiptId, receipt.receiptId, '事件与收据同 id（可互相定位）');
});

// ── ③ 观察者纪律：留痕失败不得改变裁决 ─────────────────────────────────────────────
test('recordGuardRefusal：非法 sessionId / 无 root ⇒ 返回 null 且不抛（裁决照旧）', () => {
  const root = tempRoot('guard-x-');
  const badSession = { ...EXEC_PW, agent: { session: { id: '../escape' } } };
  assert.equal(recordGuardRefusal(root, badSession, { reason: 'x' }), null, '非法 sessionId ⇒ 留痕放弃，不抛');
  assert.equal(recordGuardRefusal(null, EXEC_PW, { reason: 'x' }), null, '无 root ⇒ 留痕放弃，不抛');
  assert.equal(recordGuardRefusal(root, EXEC_PW, { reason: '' }), null, '空拒因 ⇒ 不落空收据');
});

// ── ④ 通道 B（tier-gate）：拒绝后收据可见，且拒绝串逐字不变 ──────────────────────────
test('通道 B：难度门拒绝 ⇒ 收据落盘（source=guard-difficulty），且返回的拒绝串与原判据一致', () => {
  const root = tempRoot('guard-b-');
  const { ctx, guard } = fakeHost();
  installDifficultyGuard(ctx, { store: storeStub(), config: {}, root });
  const fn = guard();
  assert.equal(typeof fn, 'function', '守卫须已注册');
  const reason = fn(EXEC_PW);
  assert.match(String(reason), /^\[task-difficulty-gate\]/, '拒绝串形态不变（留痕是观察者，不改裁决）');
  const rows = readRefusals(root, 'sess-g');
  assert.deepEqual(rows.map((r) => r.source), [GUARD_SOURCE.DIFFICULTY], '收据须标 guard-difficulty');
  assert.equal(rows[0].decision.reason, String(reason), '收据里存的是同一句拒绝原因');
});

// ── ⑤ 通道 C（write-provenance）：拒绝后收据可见 ───────────────────────────────────
test('通道 C：写族工具缺来源 ⇒ 收据落盘（source=guard-write-provenance），且返回串逐字不变', () => {
  const root = tempRoot('guard-c-');
  const { ctx, guard } = fakeHost();
  assert.equal(installWriteProvenanceGuard(ctx, { root }), true, '守卫须注册成功');
  const fn = guard();
  // 判据：写族工具 + 无 `sourceRunId` + **无会话 id** ⇒ 拒（有会话 id 时视作溯源在场，放行）
  const decision = fn({ name: 'lane_claim', arguments: { batchId: 'b1', lane: 'l1' }, agent: { session: {} } });
  assert.equal(decision, 'source-run-id-missing: lane_claim', '拒绝串逐字不变');
  const rows = readRefusals(root, 'cli');
  assert.deepEqual(rows.map((r) => r.source), [GUARD_SOURCE.PROVENANCE]);
  assert.equal(rows[0].tool, 'lane_claim');
});

// ── ⑥ 阴性：放行不落收据（留痕只记拒态，不做「全量调用审计」）────────────────────────
test('阴性：守卫放行（undefined）⇒ 零收据（留痕只记拒态）', () => {
  const root = tempRoot('guard-n-');
  const { ctx, guard } = fakeHost();
  installWriteProvenanceGuard(ctx, { root });
  const fn = guard();
  assert.equal(fn({ name: 'batch_status', arguments: {}, agent: { session: { id: 'sess-g' } } }), undefined, '非写族 ⇒ 放行');
  assert.deepEqual(readRefusals(root, 'sess-g'), [], '放行不得产生收据');
});
