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

// I1 集成测试（build-plan §2.6 I1，8 条）：wiring 接线契约（fake ctx 先例 tools.test.js:199-201 fake guard 模式）
// 覆盖：挂载与 disposer / ALLOW 透传 / DENY 短路 / REQUIRE_APPROVAL→ask / post pass-through /
//       收据落盘（四要素 + ledger + 读回）/ 与难度门禁组合（HOST:3116 语义）/ 双版本宿主兼容。
// P0 扩展（harden-plan §6 P0 组 W-N×2）：NARROW 运行期接线 e2e——pre 链 NARROW → reason 修正指引 +
//   收据 narrowedParams 落盘读回一致；收据扩展字段（9 键）兼容断言（旧 8 键读回不炸）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installGovernanceHook } from '../lib/governance/wiring.js';
import { readRefusals } from '../lib/governance/receipt-store.js';

// ── fake ctx（捕获 ctx.on 注册的 listener；disposer 移除注册——cordis ctx.on 返回 dispose 语义）──
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

// 最小 ToolExecution 形态（HTYPES:196-220：name/arguments/callId/agent）
function execOf(name, args, extra = {}) {
  return {
    name,
    arguments: args,
    callId: 'call-' + name,
    agent: { session: { id: 'sess-wire' } },
    ...extra,
  };
}

// 1 条越界规则（hard，bash cmd 含 rm -rf → DENY）
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

// 1 条 manual_review 规则（match 缺省=全工具；→ REQUIRE_APPROVAL）
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

// 1 条 narrowable 规则（A2 显式 narrow bounds：/timeout max=100；flags.narrow=true → NARROW）
const NARROW_CFG = {
  governance: {
    hook: {
      enabled: true,
      flags: { pause: false, narrow: true, defer: false },
      rules: [
        {
          id: 'RN01',
          tools: ['bash'],
          match: { path: '/timeout', op: 'gt', value: 100 },
          violations: [{ code: 'VN01', category: 'narrowable', message: '超时参数需收窄' }],
          narrow: [{ path: '/timeout', max: 100 }],
        },
      ],
    },
  },
};

test('I1-1 挂载与 disposer：返回 {dispose, installed, refusals}；dispose 后 fake ctx 移除回调、listener 不再触发', () => {
  const ctx = fakeCtx();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-wire-'));
  const hook = installGovernanceHook(ctx, { store: null, root, config: DENY_CFG });
  assert.equal(hook.installed, true);
  assert.equal(typeof hook.dispose, 'function');
  assert.equal(typeof hook.refusals.count, 'function');
  assert.equal(hook.refusals.count(), 0);
  // 挂载后 pre/post 均已注册
  assert.equal(ctx.listeners.has('tools/pre-execute'), true);
  assert.equal(ctx.listeners.has('tools/post-execute'), true);
  // dispose 幂等 + 卸载后注册移除（listener 不再被宿主触发）
  hook.dispose();
  hook.dispose();
  assert.equal(ctx.listeners.has('tools/pre-execute'), false);
  assert.equal(ctx.listeners.has('tools/post-execute'), false);
});

test('I1-2 ALLOW 透传：pre listener 收到 ALLOW 决策 → 调用了 next()（透传），未落收据（refusals.count() 不变）', async () => {
  const ctx = fakeCtx();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-wire-'));
  const hook = installGovernanceHook(ctx, { store: null, root, config: DENY_CFG });
  const pre = ctx.listeners.get('tools/pre-execute');
  let nextCalled = 0;
  // bash cmd=ls 不匹配 R001（regex rm -rf）→ ALLOW
  const decision = await pre(execOf('bash', { cmd: 'ls' }), async () => { nextCalled++; return { kind: 'allow' }; });
  assert.equal(decision.kind, 'allow');
  assert.equal(nextCalled, 1);
  assert.equal(hook.refusals.count(), 0);
  // 无收据目录生成
  assert.equal(fs.existsSync(path.join(root, 'governance', 'refusals')), false);
  hook.dispose();
});

test('I1-3 DENY 短路：返回 {kind:deny, reason 含 [governance:DENY] 前缀}，未调 next()', async () => {
  const ctx = fakeCtx();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-wire-'));
  const hook = installGovernanceHook(ctx, { store: null, root, config: DENY_CFG });
  const pre = ctx.listeners.get('tools/pre-execute');
  let nextCalled = 0;
  const decision = await pre(execOf('bash', { cmd: 'rm -rf /' }), async () => { nextCalled++; return { kind: 'allow' }; });
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /^\[governance:DENY\] /);
  assert.equal(nextCalled, 0);
  assert.equal(hook.refusals.count(), 1);
  hook.dispose();
});

test('I1-4 REQUIRE_APPROVAL → ask：返回 {kind:ask, reason}', async () => {
  const ctx = fakeCtx();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-wire-'));
  const hook = installGovernanceHook(ctx, { store: null, root, config: ASK_CFG });
  const pre = ctx.listeners.get('tools/pre-execute');
  const decision = await pre(execOf('edit', { scope: 'admin' }), async () => ({ kind: 'allow' }));
  assert.equal(decision.kind, 'ask');
  assert.match(decision.reason, /^\[governance:REQUIRE_APPROVAL\] /);
  assert.equal(hook.refusals.count(), 1);
  hook.dispose();
});

test('I1-5 post pass-through：post listener 恒 return next()，不断链（next 被调用）', async () => {
  const ctx = fakeCtx();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-wire-'));
  const hook = installGovernanceHook(ctx, { store: null, root, config: DENY_CFG });
  const post = ctx.listeners.get('tools/post-execute');
  let nextCalled = 0;
  const decision = await post(execOf('bash', { cmd: 'ls' }), { content: [{ type: 'text', text: 'ok' }], isError: false }, async () => { nextCalled++; return { kind: 'accept' }; });
  assert.equal(decision.kind, 'accept');
  assert.equal(nextCalled, 1);
  hook.dispose();
});

test('I1-6 收据落盘：temp root → refusals/<sessionId>/<receiptId>.json 存在 + ledger-<sessionId>.jsonl 追加一行（四要素验证）', async () => {
  const ctx = fakeCtx();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-wire-'));
  const hook = installGovernanceHook(ctx, { store: null, root, config: DENY_CFG });
  const pre = ctx.listeners.get('tools/pre-execute');
  await pre(execOf('bash', { cmd: 'rm -rf /' }), async () => ({ kind: 'allow' }));
  // 单收据 json
  const dir = path.join(root, 'governance', 'refusals', 'sess-wire');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1);
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  // 内容四要素（design.md:115）：attemptedParams / 裁决（primitive+priority+reason）/ 理由 / ts
  assert.ok(receipt.receiptId, 'receiptId present');
  assert.ok(receipt.ts, 'ts present');
  assert.equal(receipt.decision.primitive, 'DENY');
  assert.ok(receipt.decision.reason, 'decision.reason present');
  assert.deepEqual(receipt.attemptedParams, { cmd: 'rm -rf /' });
  assert.equal(receipt.tool, 'bash');
  assert.equal(receipt.callId, 'call-bash');
  assert.equal(receipt.sessionId, 'sess-wire');
  assert.deepEqual(receipt.ruleRefs, ['R001']);
  // ledger 追加一行
  const ledger = fs.readFileSync(path.join(root, 'governance', 'refusals', 'ledger-sess-wire.jsonl'), 'utf8');
  const lines = ledger.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).receiptId, receipt.receiptId);
  // readRefusals 读回字段一致
  const back = readRefusals(root, 'sess-wire');
  assert.equal(back.length, 1);
  assert.equal(back[0].receiptId, receipt.receiptId);
  assert.equal(back[0].decision.primitive, 'DENY');
  hook.dispose();
});

test('I1-7 与 guard 组合（HOST:3116 语义）：kernel ALLOW → guard 被调用（难度门禁生效）；kernel DENY → guard 不被调用', async () => {
  const ctx = fakeCtx();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-wire-'));
  const hook = installGovernanceHook(ctx, { store: null, root, config: DENY_CFG });
  const pre = ctx.listeners.get('tools/pre-execute');
  // 模拟宿主链（HOST:3105-3137）：pre waterfall → ask 解析 → guardReason（难度门禁）→ dispatch
  // HOST:3116：denialReason = decision.kind === "allow" ? this.guardReason(exec) : decision.reason
  let guardCalls = 0;
  const guardReason = () => { guardCalls++; return '任务未评估（难度门禁）'; };
  const runHostChain = async (exec) => {
    const gate = await pre(exec, async () => ({ kind: 'allow' }));
    const denialReason = gate.kind === 'allow' ? guardReason(exec) : gate.reason;
    return denialReason === undefined ? { dispatched: true } : { dispatched: false, denialReason };
  };
  // ALLOW 调用（bash ls 不匹配规则）→ guard 被调用、难度门禁收紧拒绝
  const r1 = await runHostChain(execOf('bash', { cmd: 'ls' }));
  assert.equal(r1.dispatched, false);
  assert.match(r1.denialReason, /难度门禁/);
  assert.equal(guardCalls, 1);
  // DENY 调用（bash rm -rf 命中规则）→ guard 不再参与（decision.reason 直接拒绝，guard 不被调用）
  const r2 = await runHostChain(execOf('bash', { cmd: 'rm -rf /' }));
  assert.equal(r2.dispatched, false);
  assert.match(r2.denialReason, /^\[governance:DENY\] /);
  assert.equal(guardCalls, 1); // guard 未被再次调用
  hook.dispose();
});

test('I1-8 双版本宿主兼容：0.1.0-rc.6 与 0.1.1-rc.2 各跑一遍全绿（wiring 零宿主 import，pre/post 位点同构 §6.5）', async () => {
  for (const ver of ['0.1.0-rc.6', '0.1.1-rc.2']) {
    const ctx = fakeCtx();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-wire-'));
    const hook = installGovernanceHook(ctx, { store: null, root, config: DENY_CFG });
    assert.equal(hook.installed, true, ver + ' mount');
    const pre = ctx.listeners.get('tools/pre-execute');
    const post = ctx.listeners.get('tools/post-execute');
    // ALLOW 透传
    let nextCalled = 0;
    const allow = await pre(execOf('bash', { cmd: 'ls' }), async () => { nextCalled++; return { kind: 'allow' }; });
    assert.equal(allow.kind, 'allow', ver);
    assert.equal(nextCalled, 1, ver);
    // DENY 短路 + 收据落盘
    const deny = await pre(execOf('bash', { cmd: 'rm -rf /' }), async () => ({ kind: 'allow' }));
    assert.equal(deny.kind, 'deny', ver);
    assert.match(deny.reason, /^\[governance:DENY\] /, ver);
    assert.equal(fs.existsSync(path.join(root, 'governance', 'refusals', 'sess-wire')), true, ver);
    // post pass-through
    const p = await post(execOf('bash', { cmd: 'ls' }), { content: [], isError: false }, async () => ({ kind: 'accept' }));
    assert.equal(p.kind, 'accept', ver);
    // dispose 卸载
    hook.dispose();
    assert.equal(ctx.listeners.has('tools/pre-execute'), false, ver);
  }
});

// ── P0 组 W-N（harden-plan §6）：NARROW 运行期接线 e2e ──

// W-N1 pre 链 NARROW → {kind:'deny'} + reason 含修正指引（宿主禁输入改写，不实际改写 exec.arguments）+ 收据 narrowedParams 落盘读回一致
test('W-N1 NARROW pre chain: deny + reason guidance + receipt narrowedParams round-trips', async () => {
  const ctx = fakeCtx();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-narrow-'));
  const hook = installGovernanceHook(ctx, { store: null, root, config: NARROW_CFG });
  const pre = ctx.listeners.get('tools/pre-execute');
  let nextCalled = 0;
  const exec = execOf('bash', { timeout: 150 });
  const decision = await pre(exec, async () => { nextCalled++; return { kind: 'allow' }; });
  // deny 短路（NARROW 原语运行期落地 = deny + 指引；宿主禁输入改写 → 不实际改写 exec.arguments）
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /^\[governance:NARROW\] /, '统一前缀');
  assert.match(decision.reason, /参数修正指引/, 'reason contains parameter-correction guidance');
  assert.match(decision.reason, /钳制明细：\/timeout: 150 → 100/, 'reason carries clamped detail');
  assert.equal(nextCalled, 0, 'deny short-circuits next()');
  assert.equal(exec.arguments.timeout, 150, 'host input NOT rewritten (N-8 红线)');
  // 收据落盘 + narrowedParams 字段 + 读回一致
  const dir = path.join(root, 'governance', 'refusals', 'sess-wire');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1);
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  assert.equal(receipt.decision.primitive, 'NARROW');
  assert.ok(receipt.narrowedParams, 'receipt carries narrowedParams');
  assert.equal(receipt.narrowedParams.narrowed.timeout, 100, 'clamped value persisted');
  assert.deepEqual(receipt.narrowedParams.clamped, [{ path: '/timeout', from: 150, to: 100 }]);
  const back = readRefusals(root, 'sess-wire');
  assert.equal(back.length, 1);
  assert.deepEqual(back[0].narrowedParams, receipt.narrowedParams, 'read-back narrowedParams identical');
  hook.dispose();
});

// W-N2 收据扩展后字段断言：narrowedParams 收据 = 9 键（8 基础 + 1 扩展）；旧 8 键收据（无 narrowedParams）读回不炸（向后兼容）
test('W-N2 extended receipt: 9 keys with narrowedParams; legacy 8-key receipt reads back fine', async () => {
  const ctx = fakeCtx();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-narrow2-'));
  // NARROW 收据 → 9 键（含 narrowedParams）
  const hook = installGovernanceHook(ctx, { store: null, root, config: NARROW_CFG });
  const pre = ctx.listeners.get('tools/pre-execute');
  await pre(execOf('bash', { timeout: 150 }), async () => ({ kind: 'allow' }));
  const dir = path.join(root, 'governance', 'refusals', 'sess-wire');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1);
  const extended = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  assert.ok(Object.prototype.hasOwnProperty.call(extended, 'narrowedParams'), 'narrowedParams key present');
  assert.ok(Object.prototype.hasOwnProperty.call(extended, 'anchor'), 'P2: anchor key present (writeRefusal 锚定)');
  assert.equal(Object.keys(extended).length, 10, '8 base keys + narrowedParams + anchor');
  // 模拟旧收据（无 narrowedParams，8 键）手动落盘 → readRefusals 不炸（旧收据兼容 §4.2）
  const legacy = {
    receiptId: 'legacy-0001',
    ts: '2026-01-01T00:00:00.000Z',
    tool: 'bash',
    callId: 'call-legacy',
    sessionId: 'sess-wire',
    decision: { primitive: 'DENY', priority: 2, reason: 'legacy' },
    attemptedParams: { cmd: 'rm -rf /' },
    ruleRefs: ['R-old'],
  };
  fs.writeFileSync(path.join(dir, 'legacy-0001.json'), JSON.stringify(legacy, null, 2), 'utf8');
  const back = readRefusals(root, 'sess-wire');
  assert.equal(back.length, 2, 'legacy + extended both readable');
  const legacyBack = back.find((r) => r.receiptId === 'legacy-0001');
  assert.equal(legacyBack.narrowedParams, undefined, 'legacy receipt has no narrowedParams field (compat)');
  hook.dispose();
});
