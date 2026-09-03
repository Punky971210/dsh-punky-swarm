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
*/

// P2 组 B（harden-plan §6，4 条新增）：双层桥接（收据事件 → 批级事件流，仅事件可见性）。
// 载体：test/governance-bridge.test.js（新增文件）。
// 覆盖：B1 onRefusal 同步回调收到收据 / B2 回调抛错隔离不阻断 / B3 批级事件流文件与收据一致 /
//       B4 dispose 后回调断开。
// 装配形态（harden-plan §5.3 B）：installGovernanceHook({onRefusal}) —— 收据落盘成功 → 同步回调；
//   lib/index.js 注入 appendRefusalEvent 写 <root>/governance/events/refusal-<sessionId>.jsonl（B3 载体同款）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installGovernanceHook } from '../lib/governance/wiring.js';
import { readRefusals, appendRefusalEvent, eventStreamFileOf } from '../lib/governance/receipt-store.js';

// ── fake ctx（对齐 governance-state.test.js fakeCtx）──
function fakeCtx() {
  const listeners = new Map();
  return {
    listeners,
    on(event, fn) {
      listeners.set(event, fn);
      return () => { listeners.delete(event); };
    },
    logger: { info: () => {}, warn: (msg) => { global.__govWarn = (global.__govWarn || []).concat([String(msg)]); } },
  };
}

function execOf(name, args, extra = {}) {
  return {
    name,
    arguments: args,
    callId: 'call-' + name,
    agent: { session: { id: 'sess-b' } },
    ...extra,
  };
}

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// 1 条越界规则（hard → DENY）
const DENY_CFG = {
  governance: {
    hook: {
      enabled: true,
      rules: [
        {
          id: 'R001',
          tools: ['bash'],
          match: { path: '/cmd', op: 'regex', pattern: 'rm -rf' },
          violations: [{ code: 'V001', category: 'hard', message: '禁止删除命令' }],
        },
      ],
    },
  },
};

// ── B1：onRefusal 同步回调收到收据（pre 链内触发；收据含 id/primitive，与落盘一致）──
test('B1 onRefusal sync callback receives recorded receipt', async () => {
  const ctx = fakeCtx();
  const root = tempRoot('gov-b1-');
  const seen = [];
  const hook = installGovernanceHook(ctx, { store: null, root, config: DENY_CFG, onRefusal: (r) => seen.push(r) });
  const pre = ctx.listeners.get('tools/pre-execute');
  const decision = await pre(execOf('bash', { cmd: 'rm -rf /' }), async () => ({ kind: 'allow' }));
  assert.equal(decision.kind, 'deny');
  assert.equal(seen.length, 1, '收据落盘成功 → onRefusal 收到 1 条');
  assert.equal(seen[0].decision.primitive, 'DENY');
  assert.ok(seen[0].receiptId, 'receiptId present');
  assert.ok(seen[0].anchor?.hash, 'P2: 回调收据已含 anchor（writeRefusal 落盘后回调）');
  // 与盘上一致
  const back = readRefusals(root, 'sess-b');
  assert.equal(back.length, 1);
  assert.equal(back[0].receiptId, seen[0].receiptId, '回调收据 = 落盘收据');
  hook.dispose();
});

// ── B2：回调抛错隔离（warn 留痕，不阻断 pre 裁决 / 后续收据照常）──
test('B2 onRefusal throw is isolated: decision still deny, further refusals still recorded', async () => {
  const ctx = fakeCtx();
  const root = tempRoot('gov-b2-');
  const hook = installGovernanceHook(ctx, {
    store: null, root, config: DENY_CFG,
    onRefusal: () => { throw new Error('bridge boom'); },
  });
  const pre = ctx.listeners.get('tools/pre-execute');
  const d1 = await pre(execOf('bash', { cmd: 'rm -rf /' }), async () => ({ kind: 'allow' }));
  assert.equal(d1.kind, 'deny', '回调抛错不阻断裁决');
  const d2 = await pre(execOf('bash', { cmd: 'rm -rf /tmp' }), async () => ({ kind: 'allow' }));
  assert.equal(d2.kind, 'deny', '后续调用照常裁决');
  assert.equal(readRefusals(root, 'sess-b').length, 2, '收据照常落盘');
  assert.equal(hook.refusals.count(), 2);
  assert.ok((global.__govWarn || []).some((m) => m.includes('bridge callback failed')), 'warn 留痕');
  hook.dispose();
});

// ── B3：批级事件流文件与收据一致（appendRefusalEvent 载体 = lib/index.js 装配注入实现）──
test('B3 batch event stream file matches receipts (eventStreamFileOf lines align with readRefusals)', async () => {
  const ctx = fakeCtx();
  const root = tempRoot('gov-b3-');
  // 装配注入同款：onRefusal → appendRefusalEvent（governance/events/refusal-<sessionId>.jsonl）
  const hook = installGovernanceHook(ctx, {
    store: null, root, config: DENY_CFG,
    onRefusal: (r) => appendRefusalEvent(root, r.sessionId ?? 'cli', r),
  });
  const pre = ctx.listeners.get('tools/pre-execute');
  await pre(execOf('bash', { cmd: 'rm -rf /' }), async () => ({ kind: 'allow' }));
  await pre(execOf('bash', { cmd: 'rm -rf /tmp' }), async () => ({ kind: 'allow' }));
  // 事件流文件存在 + 行数与收据一致
  const streamFile = eventStreamFileOf(root, 'sess-b');
  assert.equal(fs.existsSync(streamFile), true, '批级事件流文件存在');
  const lines = fs.readFileSync(streamFile, 'utf8').trim().split('\n').filter(Boolean);
  const back = readRefusals(root, 'sess-b');
  assert.equal(lines.length, back.length, '事件行数 = 收据数');
  // 逐行形态：type=governance.refusal.recorded + receiptId/primitive/ts 与收据一致（含收据 id/原语/时间戳）
  for (let i = 0; i < lines.length; i++) {
    const ev = JSON.parse(lines[i]);
    assert.equal(ev.type, 'governance.refusal.recorded');
    assert.equal(ev.receiptId, back[i].receiptId, '事件 receiptId 与收据一致');
    assert.equal(ev.primitive, back[i].decision.primitive, '事件原语与收据一致');
    assert.equal(ev.ts, back[i].ts, '事件时间戳与收据一致');
    assert.equal(ev.sessionId, 'sess-b');
  }
  hook.dispose();
});

// ── B4：dispose 后回调断开（幂等；卸载后不再触发）──
test('B4 dispose disconnects bridge callback (idempotent)', async () => {
  const ctx = fakeCtx();
  const root = tempRoot('gov-b4-');
  const seen = [];
  const hook = installGovernanceHook(ctx, { store: null, root, config: DENY_CFG, onRefusal: (r) => seen.push(r) });
  const pre = ctx.listeners.get('tools/pre-execute');
  await pre(execOf('bash', { cmd: 'rm -rf /' }), async () => ({ kind: 'allow' }));
  assert.equal(seen.length, 1, 'dispose 前回调触发');
  hook.dispose();
  hook.dispose(); // 幂等
  // 卸载后 listener 移除 → 宿主不再触发（I1-8 同断言模式）
  assert.equal(ctx.listeners.has('tools/pre-execute'), false, 'pre listener 已卸载');
  assert.equal(ctx.listeners.has('tools/post-execute'), false, 'post listener 已卸载');
  // 再手动驱动（模拟残留引用）也不应触发回调（refusalCb 置空）
  const preRef = ctx.listeners.get('tools/pre-execute');
  if (preRef) {
    await preRef(execOf('bash', { cmd: 'rm -rf /x' }), async () => ({ kind: 'allow' }));
  }
  assert.equal(seen.length, 1, 'dispose 后回调不再触发');
});
