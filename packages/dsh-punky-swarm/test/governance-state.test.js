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

// P1 组 S（harden-plan §6，8 条新增）：DEFER/PAUSE 文件态简版状态机 + REQUIRE_APPROVAL ask 接线。
// 载体：test/governance-state.test.js（新增文件）。
// 覆盖：S1 ask+收据 ask.initiated / S2 无 approval→降级 deny 复现+outcome 补记 / S3 post 补记 ask 终态 /
//       S4 DEFER 窗口内重试 deny+过期重裁 / S5 PAUSE 同 session 后续 deny+过期恢复（含跨 session 隔离）/
//       S6 flag-off 折叠无状态副作用 / S7 状态文件落盘/读回幂等+惰性过期 / S8 双版本 ask 契约。
// 宿主模拟口径（P1 ask 接线）：
//   pre 返回 {kind:'ask'} 后由宿主 serviceAsk（HOST:3303-3354）解析——无审批服务 → 降级 deny（reason 保留
//   ask.reason）；降级路径 result 经 HOST:3117-3128 materialize 为 isError:true 的 post-result，
//   仍触发 tools/post-execute waterfall（HOST:3008 → finalizeScheduledExecution → postExecute，宿主源码复核）。
//   故本组以 fake ctx + 宿主最小链替身驱动（对齐 governance-proto.test.js P1-6 载体，先例已审）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installGovernanceHook } from '../lib/governance/wiring.js';
import { readRefusals } from '../lib/governance/receipt-store.js';
import {
  readSessionState, setDeferred, setPaused, clearSessionState, stateFileOf,
  DEFER_RETRY_MS, PAUSE_WINDOW_MS,
} from '../lib/governance/state-store.js';

// ── fake ctx（对齐 governance-wiring.test.js fakeCtx）──
function fakeCtx() {
  const listeners = new Map();
  return {
    listeners,
    on(event, fn) {
      listeners.set(event, fn);
      return () => { listeners.delete(event); };
    },
    logger: { info: () => {}, warn: () => {} },
  };
}

function execOf(name, args, extra = {}) {
  return {
    name,
    arguments: args,
    callId: 'call-' + name,
    agent: { session: { id: 'sess-wire' } },
    ...extra,
  };
}

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// 单收据读取（<sessionId>/ 下唯一 json，或按 receiptId 找）
function readReceipt(root, sessionId, receiptId) {
  const dir = path.join(root, 'governance', 'refusals', sessionId);
  const file = path.join(dir, receiptId + '.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listReceiptFiles(root, sessionId) {
  const dir = path.join(root, 'governance', 'refusals', sessionId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
}

// 状态文件路径
function statePath(root, sessionId) {
  return stateFileOf(root, sessionId);
}

function stateExists(root, sessionId) {
  return fs.existsSync(statePath(root, sessionId));
}

// 模拟宿主将 until 改写为过去（惰性过期窗口流逝，免真实等待）
function expireStateFile(root, sessionId) {
  const file = statePath(root, sessionId);
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  st.until = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(st, null, 2), 'utf8');
}

// ── 配置 ──

// manual_review 规则 → REQUIRE_APPROVAL（P1 档；S1/S2/S3/S8）
const ASK_CFG = {
  governance: {
    hook: {
      enabled: true,
      rules: [
        {
          id: 'R002',
          match: { path: '/scope', op: 'eq', value: 'admin' },
          violations: [{ code: 'V002', category: 'manual_review', message: '高危操作需人工复核' }],
        },
      ],
    },
  },
};

// soft 规则 + flags.defer=true → DEFER（P5 档；S4）
const DEFER_CFG = {
  governance: {
    hook: {
      enabled: true,
      flags: { pause: false, narrow: false, defer: true },
      rules: [
        {
          id: 'RD01',
          match: { path: '/cmd', op: 'eq', value: 'hydrate' },
          violations: [{ code: 'VD01', category: 'soft', message: '数据水合前软违规（低置信度延后）' }],
        },
      ],
    },
  },
};

// pausable 规则 + flags.pause=true → PAUSE（P3 档；S5）
const PAUSE_CFG = {
  governance: {
    hook: {
      enabled: true,
      flags: { pause: true, narrow: false, defer: false },
      rules: [
        {
          id: 'RP01',
          match: { path: '/mode', op: 'eq', value: 'bulk' },
          violations: [{ code: 'VP01', category: 'pausable', message: '批量操作可暂停' }],
        },
      ],
    },
  },
};

// pausable 规则 + flags.pause=false → 折叠 DENY（S6 用例 1）
const PAUSE_OFF_CFG = {
  governance: {
    hook: {
      enabled: true,
      flags: { pause: false, narrow: false, defer: false },
      rules: PAUSE_CFG.governance.hook.rules,
    },
  },
};

// soft 规则 + flags.defer=false → 折叠 DENY（S6 用例 2）
const DEFER_OFF_CFG = {
  governance: {
    hook: {
      enabled: true,
      flags: { pause: false, narrow: false, defer: false },
      rules: DEFER_CFG.governance.hook.rules,
    },
  },
};

// ── S1：REQUIRE_APPROVAL → {kind:'ask'} + 收据 ask.initiated 同步落盘 ──
test('S1 REQUIRE_APPROVAL → ask + receipt ask.initiated (channel/initiated/requestId)', async () => {
  const ctx = fakeCtx();
  const root = tempRoot('gov-s1-');
  const hook = installGovernanceHook(ctx, { store: null, root, config: ASK_CFG });
  const pre = ctx.listeners.get('tools/pre-execute');
  const decision = await pre(execOf('edit', { scope: 'admin' }), async () => ({ kind: 'allow' }));
  assert.equal(decision.kind, 'ask', 'REQUIRE_APPROVAL → {kind:ask}');
  assert.match(decision.reason, /^\[governance:REQUIRE_APPROVAL\] /);
  // 收据 ask.initiated 已同步落盘（pre 内完成，不依赖 post）
  const files = listReceiptFiles(root, 'sess-wire');
  assert.equal(files.length, 1);
  const receipt = readReceipt(root, 'sess-wire', files[0].replace('.json', ''));
  assert.equal(receipt.decision.primitive, 'REQUIRE_APPROVAL');
  assert.ok(receipt.ask, 'receipt carries ask meta');
  assert.equal(receipt.ask.channel, 'host-serviceAsk');
  assert.ok(receipt.ask.initiated, 'ask.initiated present at pre time');
  assert.equal(Number.isNaN(Date.parse(receipt.ask.initiated)), false, 'initiated is ISO ts');
  assert.equal(receipt.ask.requestId, 'call-edit', 'requestId = callId (host approval correlation)');
  assert.equal(receipt.ask.outcome, undefined, 'outcome not yet patched at pre');
  assert.equal(receipt.ts, receipt.ask.initiated, 'initiated === receipt.ts (同一时刻)');
  assert.equal(hook.refusals.count(), 1);
  hook.dispose();
});

// ── S2：无 approval 服务 → 宿主降级 deny 复现（HOST:3305-3311）+ post 补记 outcome ──
test('S2 no approval service → host degrade deny reproduced + post patches ask.outcome=denied-no-approval', async () => {
  const ctx = fakeCtx();
  const root = tempRoot('gov-s2-');
  const hook = installGovernanceHook(ctx, { store: null, root, config: ASK_CFG });
  const pre = ctx.listeners.get('tools/pre-execute');
  const post = ctx.listeners.get('tools/post-execute');
  // 宿主最小链（HOST:3105-3128 + 3305-3311 语义）：pre waterfall → ask → 无 approval 服务 → 降级 deny
  //   （approval === void 0 → decision {kind:'deny', reason: ask.reason}）→ materialize isError result → post
  const exec = execOf('edit', { scope: 'admin' });
  const gate = await pre(exec, async () => ({ kind: 'allow' }));
  assert.equal(gate.kind, 'ask');
  const degraded = { kind: 'deny', reason: gate.reason }; // HOST:3305-3311（reason 保留 ask.reason）
  const result = {
    content: [{ type: 'text', text: `Error: ${degraded.reason}` }],
    isError: true,
    error: { message: degraded.reason },
  };
  let nextCalled = 0;
  const postDecision = await post(exec, result, async () => { nextCalled++; return { kind: 'accept' }; });
  // post pass-through 不变（§4.4）
  assert.equal(postDecision.kind, 'accept');
  assert.equal(nextCalled, 1);
  // outcome 尽力补记：默认（无审批服务，宿主保留 ask.reason 无特征文本）→ denied-no-approval
  const files = listReceiptFiles(root, 'sess-wire');
  assert.equal(files.length, 1);
  const receipt = readReceipt(root, 'sess-wire', files[0].replace('.json', ''));
  assert.equal(receipt.ask.channel, 'host-serviceAsk');
  assert.equal(receipt.ask.outcome, 'denied-no-approval', 'degrade patched outcome');
  // readRefusals 读回一致（收据读回契约）
  const back = readRefusals(root, 'sess-wire');
  assert.equal(back.length, 1);
  assert.equal(back[0].ask.outcome, 'denied-no-approval');
  hook.dispose();
});

// ── S3：post 补记 ask 终态（isError → denied-no-approval）+ 幂等（已终态不二次改写）──
test('S3 post patches ask outcome on isError result (default denied-no-approval); idempotent once resolved', async () => {
  const ctx = fakeCtx();
  const root = tempRoot('gov-s3-');
  const hook = installGovernanceHook(ctx, { store: null, root, config: ASK_CFG });
  const pre = ctx.listeners.get('tools/pre-execute');
  const post = ctx.listeners.get('tools/post-execute');
  const exec = execOf('edit', { scope: 'admin' });
  await pre(exec, async () => ({ kind: 'allow' }));
  // post 收到宿主 materialize 的降级 Error result（无特征文本 → denied-no-approval）
  const result = { content: [{ type: 'text', text: 'Error: something failed' }], isError: true };
  await post(exec, result, async () => ({ kind: 'accept' }));
  const files = listReceiptFiles(root, 'sess-wire');
  const receipt = readReceipt(root, 'sess-wire', files[0].replace('.json', ''));
  assert.equal(receipt.ask.outcome, 'denied-no-approval');
  // 幂等：再次 post（同 callId 已出队；即使再触发 patch，outcome 已存在 → no-op 不炸）
  const before = JSON.stringify(readRefusals(root, 'sess-wire'));
  await post(exec, result, async () => ({ kind: 'accept' }));
  const after = JSON.stringify(readRefusals(root, 'sess-wire'));
  assert.equal(after, before, 'outcome already resolved → no double patch');
  hook.dispose();
});

// ── S4：DEFER 触发 → 窗口内重试 deny（retry-after + 原 deferId，gate 收据 ruleRefs=[]）→ 过期重裁（新窗口）──
test('S4 DEFER: trigger writes state+deferMeta; in-window retry denied with retry-after; expiry re-decides fresh window', async () => {
  const ctx = fakeCtx();
  const root = tempRoot('gov-s4-');
  const hook = installGovernanceHook(ctx, { store: null, root, config: DEFER_CFG });
  const pre = ctx.listeners.get('tools/pre-execute');
  const exec = execOf('bash', { cmd: 'hydrate' });
  // 1) 首次触发：DENY + 写 deferred 状态 + 收据 deferMeta（trigger 收据 ruleRefs=['RD01']）
  const d1 = await pre(exec, async () => ({ kind: 'allow' }));
  assert.equal(d1.kind, 'deny');
  assert.match(d1.reason, /^\[governance:DEFER\] /, '统一前缀 DEFER（flag-on 真实生效，非折叠 DENY）');
  assert.match(d1.reason, /deferId=/);
  assert.match(d1.reason, /until=/);
  assert.equal(stateExists(root, 'sess-wire'), true, 'DEFER 触发写状态文件');
  const st = JSON.parse(fs.readFileSync(statePath(root, 'sess-wire'), 'utf8'));
  assert.equal(st.status, 'deferred');
  let files = listReceiptFiles(root, 'sess-wire');
  assert.equal(files.length, 1);
  const r1 = readReceipt(root, 'sess-wire', files[0].replace('.json', ''));
  assert.equal(r1.decision.primitive, 'DEFER');
  assert.deepEqual(r1.ruleRefs, ['RD01'], 'trigger receipt has ruleRefs');
  assert.ok(r1.deferMeta, 'trigger receipt carries deferMeta');
  assert.equal(r1.deferMeta.deferId, st.deferId, 'receipt deferId === state deferId（同源）');
  assert.equal(r1.deferMeta.retryAfterMs, DEFER_RETRY_MS);
  assert.equal(r1.deferMeta.until, st.until);
  // 2) 窗口内重试：状态门 deny（reason 含 retry-after + 原 deferId）；gate 收据 ruleRefs=[]，deferId 不变
  const d2 = await pre(exec, async () => ({ kind: 'allow' }));
  assert.equal(d2.kind, 'deny');
  assert.match(d2.reason, /^\[governance:DEFER\] /);
  assert.match(d2.reason, /retry-after/);
  assert.match(d2.reason, new RegExp(st.deferId), 'gate deny 携带原 deferId');
  files = listReceiptFiles(root, 'sess-wire');
  assert.equal(files.length, 2);
  const r2 = readReceipt(root, 'sess-wire', files[0].replace('.json', ''));
  const r2b = readReceipt(root, 'sess-wire', files[1].replace('.json', ''));
  const gateReceipt = [r2, r2b].find((x) => x.ruleRefs.length === 0);
  assert.ok(gateReceipt, 'gate receipt present');
  assert.equal(gateReceipt.decision.primitive, 'DEFER');
  assert.equal(gateReceipt.deferMeta.deferId, st.deferId, 'gate 不延长窗口（deferId 同源）');
  // 状态文件 until 未被重写延长（仍为首次 until）
  const st2 = JSON.parse(fs.readFileSync(statePath(root, 'sess-wire'), 'utf8'));
  assert.equal(st2.until, st.until, 'retry 不延长窗口');
  // 3) 过期（改写 until 为过去）→ 状态门读到过期即清理 → kernel 重裁 → 新窗口（新 deferId）
  expireStateFile(root, 'sess-wire');
  const d3 = await pre(exec, async () => ({ kind: 'allow' }));
  assert.equal(d3.kind, 'deny');
  assert.match(d3.reason, /^\[governance:DEFER\] /);
  const st3 = JSON.parse(fs.readFileSync(statePath(root, 'sess-wire'), 'utf8'));
  assert.equal(st3.status, 'deferred');
  assert.notEqual(st3.deferId, st.deferId, '过期后重裁 = 新窗口新 deferId');
  assert.ok(Date.parse(st3.until) > Date.now(), '新 until 在未来');
  hook.dispose();
});

// ── S5：PAUSE 触发 → 同 session 任意调用 deny（含 pauseToken/until）→ 过期自动恢复；跨 session 隔离 ──
test('S5 PAUSE: trigger pauses session; any same-session call denied; expiry auto-recovers; other session unaffected', async () => {
  const ctx = fakeCtx();
  const root = tempRoot('gov-s5-');
  const hook = installGovernanceHook(ctx, { store: null, root, config: PAUSE_CFG });
  const pre = ctx.listeners.get('tools/pre-execute');
  // 1) 触发：pausable 命中 + flag.pause → PAUSE + 写 paused 状态 + pauseMeta
  const d1 = await pre(execOf('bash', { mode: 'bulk' }), async () => ({ kind: 'allow' }));
  assert.equal(d1.kind, 'deny');
  assert.match(d1.reason, /^\[governance:PAUSE\] /, 'flag-on 真实生效 PAUSE');
  assert.match(d1.reason, /pauseToken=/);
  const st = JSON.parse(fs.readFileSync(statePath(root, 'sess-wire'), 'utf8'));
  assert.equal(st.status, 'paused');
  let files = listReceiptFiles(root, 'sess-wire');
  const r1 = readReceipt(root, 'sess-wire', files[0].replace('.json', ''));
  assert.equal(r1.decision.primitive, 'PAUSE');
  assert.ok(r1.pauseMeta, 'trigger receipt carries pauseMeta');
  assert.equal(r1.pauseMeta.pauseToken, st.pauseToken);
  assert.equal(r1.pauseMeta.until, st.until);
  assert.equal(r1.pauseMeta.until !== undefined && Date.parse(r1.pauseMeta.until) > Date.now(), true);
  // 2) 同 session 任意调用（非违规 ls）→ 状态门 deny [governance:PAUSE]（reason 含 pauseToken/until）
  const d2 = await pre(execOf('bash', { cmd: 'ls' }), async () => ({ kind: 'allow' }));
  assert.equal(d2.kind, 'deny');
  assert.match(d2.reason, /^\[governance:PAUSE\] /);
  assert.match(d2.reason, new RegExp(st.pauseToken));
  assert.match(d2.reason, /until=/);
  files = listReceiptFiles(root, 'sess-wire');
  assert.equal(files.length, 2, 'gate 亦落收据');
  // 3) 跨 session 隔离：其他会话不受本会话 paused 影响
  const dOther = await pre(execOf('bash', { cmd: 'ls' }, { agent: { session: { id: 'sess-other' } } }), async () => ({ kind: 'allow' }));
  assert.equal(dOther.kind, 'allow', 'per-session 状态，其他会话不 gate');
  // 4) 过期（改写 until）→ 自动恢复：非违规调用 ALLOW；违规调用重新触发 PAUSE
  expireStateFile(root, 'sess-wire');
  const d4 = await pre(execOf('bash', { cmd: 'ls' }), async () => ({ kind: 'allow' }));
  assert.equal(d4.kind, 'allow', '过期恢复 → 正常裁决（ls 不违规）');
  const d5 = await pre(execOf('bash', { mode: 'bulk' }), async () => ({ kind: 'allow' }));
  assert.equal(d5.kind, 'deny');
  assert.match(d5.reason, /^\[governance:PAUSE\] /, '违规调用恢复后重新触发 PAUSE');
  hook.dispose();
});

// ── S6：flag-off 折叠 DENY 无状态副作用（与 deny 区分：不写状态文件、收据无 deferMeta/pauseMeta）──
test('S6 flag-off folding DENY has no state side-effect (no state file, no deferMeta/pauseMeta in receipt)', async () => {
  // pausable + flag.pause=false → 折叠 DENY
  const ctxA = fakeCtx();
  const rootA = tempRoot('gov-s6a-');
  const hookA = installGovernanceHook(ctxA, { store: null, root: rootA, config: PAUSE_OFF_CFG });
  const preA = ctxA.listeners.get('tools/pre-execute');
  const da = await preA(execOf('bash', { mode: 'bulk' }), async () => ({ kind: 'allow' }));
  assert.equal(da.kind, 'deny');
  assert.match(da.reason, /^\[governance:DENY\] /, 'flag-off → 折叠 DENY（原语标签 DENY 非 PAUSE）');
  assert.equal(stateExists(rootA, 'sess-wire'), false, '无状态副作用：不写 paused 状态');
  let files = listReceiptFiles(rootA, 'sess-wire');
  const ra = readReceipt(rootA, 'sess-wire', files[0].replace('.json', ''));
  assert.equal(ra.decision.primitive, 'DENY');
  assert.equal(ra.pauseMeta, undefined, '折叠收据无 pauseMeta');
  hookA.dispose();
  // soft + flag.defer=false → 折叠 DENY
  const ctxB = fakeCtx();
  const rootB = tempRoot('gov-s6b-');
  const hookB = installGovernanceHook(ctxB, { store: null, root: rootB, config: DEFER_OFF_CFG });
  const preB = ctxB.listeners.get('tools/pre-execute');
  const db = await preB(execOf('bash', { cmd: 'hydrate' }), async () => ({ kind: 'allow' }));
  assert.equal(db.kind, 'deny');
  assert.match(db.reason, /^\[governance:DENY\] /, 'flag-off → 折叠 DENY');
  assert.equal(stateExists(rootB, 'sess-wire'), false, '无状态副作用：不写 deferred 状态');
  files = listReceiptFiles(rootB, 'sess-wire');
  const rb = readReceipt(rootB, 'sess-wire', files[0].replace('.json', ''));
  assert.equal(rb.decision.primitive, 'DENY');
  assert.equal(rb.deferMeta, undefined, '折叠收据无 deferMeta');
  hookB.dispose();
});

// ── S7：状态文件落盘/读回幂等 + 惰性过期（读时清理）+ 损坏自愈 + 会话名校验 ──
test('S7 state file: write/read-back idempotent, lazy expiry cleans on read, corrupt file self-heals, sessionId validated', async () => {
  const root = tempRoot('gov-s7-');
  // setDeferred → 落盘 + 读回一致 + 幂等读
  const m1 = setDeferred(root, 'sess-s7', {});
  assert.equal(m1.retryAfterMs, DEFER_RETRY_MS);
  const st = readSessionState(root, 'sess-s7');
  assert.equal(st.status, 'deferred');
  assert.equal(st.deferId, m1.deferId);
  assert.equal(st.until, m1.until);
  const st2 = readSessionState(root, 'sess-s7');
  assert.deepEqual(st2, st, '读回幂等（不消费不清理）');
  assert.equal(stateExists(root, 'sess-s7'), true);
  // setPaused → 覆盖语义
  const m2 = setPaused(root, 'sess-s7');
  assert.equal(Number.isNaN(Date.parse(m2.until)), false);
  const st3 = readSessionState(root, 'sess-s7');
  assert.equal(st3.status, 'paused');
  assert.equal(st3.pauseToken, m2.pauseToken);
  // clearSessionState 幂等
  clearSessionState(root, 'sess-s7');
  assert.equal(stateExists(root, 'sess-s7'), false);
  assert.equal(readSessionState(root, 'sess-s7').status, 'idle');
  clearSessionState(root, 'sess-s7'); // 不存在不抛
  // 惰性过期：短窗口 → 等窗口过 → 读即 idle + 文件清理（无定时器，读时惰性）
  const m3 = setDeferred(root, 'sess-s7', { retryAfterMs: 20 });
  assert.equal(m3.retryAfterMs, 20);
  assert.equal(readSessionState(root, 'sess-s7').status, 'deferred', '窗口内未过期');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(readSessionState(root, 'sess-s7').status, 'idle', '过期 → idle');
  assert.equal(stateExists(root, 'sess-s7'), false, '过期文件读时清理');
  // 损坏状态文件 → 自愈（idle + 删除）
  fs.mkdirSync(path.dirname(statePath(root, 'sess-s7')), { recursive: true });
  fs.writeFileSync(statePath(root, 'sess-s7'), '{broken json', 'utf8');
  assert.equal(readSessionState(root, 'sess-s7').status, 'idle');
  assert.equal(stateExists(root, 'sess-s7'), false, '损坏文件清理');
  // 会话名校验
  assert.throws(() => stateFileOf(root, '../evil'), /invalid sessionId/);
});

// ── S8：双版本 ask 契约（0.1.0-rc.6 / 0.1.1-rc.2 各跑一遍：ask.initiated + 降级补记；wiring 零宿主 import §4.6）──
test('S8 dual-version ask contract: both host versions get ask.initiated receipt + degrade outcome patch', async () => {
  for (const ver of ['0.1.0-rc.6', '0.1.1-rc.2']) {
    const ctx = fakeCtx();
    const root = tempRoot('gov-s8-');
    const hook = installGovernanceHook(ctx, { store: null, root, config: ASK_CFG });
    const pre = ctx.listeners.get('tools/pre-execute');
    const post = ctx.listeners.get('tools/post-execute');
    const exec = execOf('edit', { scope: 'admin' });
    const gate = await pre(exec, async () => ({ kind: 'allow' }));
    assert.equal(gate.kind, 'ask', ver);
    const files = listReceiptFiles(root, 'sess-wire');
    assert.equal(files.length, 1, ver);
    const r = readReceipt(root, 'sess-wire', files[0].replace('.json', ''));
    assert.equal(r.ask.channel, 'host-serviceAsk', ver);
    assert.ok(r.ask.initiated, ver);
    assert.equal(r.ask.outcome, undefined, ver + ' pre 阶段未补记');
    // 无审批服务降级 → post 补记
    const result = { content: [{ type: 'text', text: 'Error: ' + gate.reason }], isError: true };
    const pd = await post(exec, result, async () => ({ kind: 'accept' }));
    assert.equal(pd.kind, 'accept', ver + ' post pass-through');
    const r2 = readReceipt(root, 'sess-wire', files[0].replace('.json', ''));
    assert.equal(r2.ask.outcome, 'denied-no-approval', ver);
    hook.dispose();
  }
});
