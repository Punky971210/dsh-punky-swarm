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

// P1 原型演示（build-plan §3.2，6 条）：M2「工具调用被拦截 → 原语裁决 → 拒绝收据落盘」链路
// 载体：最小宿主管线替身（fake ctx + 按 HOST:3105/3116/3305 语义的最小 waterfall/ask 链驱动）。
// 覆盖：P1-1 模拟 ctx 挂载 / P1-2 规则命中 / P1-3 裁决断言（DENY + 统一拒绝正文格式）/
//       P1-4 收据落盘（8 键 + 内容四要素）/ P1-5 readRefusals 读回一致性 / P1-6 ask 降级 deny（HOST:3305-3311）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installGovernanceHook } from '../lib/governance/wiring.js';
import { readRefusals, refusalDirOf } from '../lib/governance/receipt-store.js';

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
    agent: { session: { id: 'sess-proto' } },
    ...extra,
  };
}

// P1 演示配置：1 条越界规则（hard，bash cmd 含 rm -rf → DENY，P2 档）
const PROTO_CFG = {
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

// 1 条 manual_review 规则（→ REQUIRE_APPROVAL，P1 档；P1-6 ask 降级演示用）
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

// 宿主最小 pre 链替身（HOST:3105-3137 语义）：waterfall 结果 → ask 解析 → denialReason → dispatch/短路
// HOST:3116：denialReason = decision.kind === "allow" ? guardReason(exec) : decision.reason
// HOST:3305-3311：ask 且无 approval 服务 → 降级 {kind:'deny'}
async function hostChain(pre, exec, { approvalService = false } = {}) {
  const gate = await pre(exec, async () => ({ kind: 'allow' }));
  let decision = gate;
  if (gate.kind === 'ask') {
    if (!approvalService) decision = { kind: 'deny', reason: gate.reason + '（无审批服务，降级拒绝）' };
    // 有 approval 服务时：allowed-once → allow（HOST:3327-3330），此处仅演示无服务路径
  }
  if (decision.kind === 'allow') return { dispatched: true };
  return { dispatched: false, reason: decision.reason };
}

test('P1-1 模拟 ctx 挂载：fake ctx + installGovernanceHook(temp root, 越界规则) → {dispose, installed, refusals}', () => {
  const ctx = fakeCtx();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-proto-'));
  const hook = installGovernanceHook(ctx, { store: null, root, config: PROTO_CFG });
  assert.equal(hook.installed, true);
  assert.equal(typeof hook.dispose, 'function');
  assert.equal(typeof hook.refusals.count, 'function');
  assert.equal(ctx.listeners.has('tools/pre-execute'), true);
  assert.equal(ctx.listeners.has('tools/post-execute'), true);
  hook.dispose();
});

test('P1-2 规则命中：bash {cmd:rm -rf /} 命中 R001 → pre 返回 {kind:deny}（调用被拦截）', async () => {
  const ctx = fakeCtx();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-proto-'));
  const hook = installGovernanceHook(ctx, { store: null, root, config: PROTO_CFG });
  const pre = ctx.listeners.get('tools/pre-execute');
  let nextCalled = 0;
  const decision = await pre(execOf('bash', { cmd: 'rm -rf /' }), async () => { nextCalled++; return { kind: 'allow' }; });
  assert.equal(decision.kind, 'deny', '调用被拦截（deny 短路）');
  assert.equal(nextCalled, 0, '未透传（next 未被调用）');
  hook.dispose();
});

test('P1-3 裁决断言：decision=DENY（P2 硬违）、拒绝正文统一格式 [governance:DENY] ...', async () => {
  const ctx = fakeCtx();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-proto-'));
  const hook = installGovernanceHook(ctx, { store: null, root, config: PROTO_CFG });
  const pre = ctx.listeners.get('tools/pre-execute');
  const decision = await pre(execOf('bash', { cmd: 'rm -rf /' }), async () => ({ kind: 'allow' }));
  assert.match(decision.reason, /^\[governance:DENY\] /, '拒绝正文带 [governance:DENY] 前缀（§6.3 统一格式）');
  assert.match(decision.reason, /禁止删除命令/, 'reason 含违规明细（模型可据此修正参数）');
  hook.dispose();
});

test('P1-4 收据落盘：<root>/governance/refusals/<sessionId>/<receiptId>.json 存在，8 键 + 内容四要素（attempted_params/裁决/理由/ts）', async () => {
  const ctx = fakeCtx();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-proto-'));
  const hook = installGovernanceHook(ctx, { store: null, root, config: PROTO_CFG });
  const pre = ctx.listeners.get('tools/pre-execute');
  await pre(execOf('bash', { cmd: 'rm -rf /' }), async () => ({ kind: 'allow' }));
  // 收据目录 + 单 json
  const dir = refusalDirOf(root, 'sess-proto');
  assert.equal(fs.existsSync(dir), true, '收据目录存在');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1, '恰 1 份收据');
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  // P2 硬化（harden-plan §5.3）：writeRefusal 锚定 → 9 键（8 基础 + anchor）；anchor 字段断言（sha256 链首 prevHash=null）
  const keys = Object.keys(receipt).sort();
  assert.deepEqual(keys, ['anchor', 'attemptedParams', 'callId', 'decision', 'receiptId', 'ruleRefs', 'sessionId', 'tool', 'ts']);
  assert.equal(receipt.anchor.version, 1, 'anchor.version=1');
  assert.equal(receipt.anchor.alg, 'sha256', 'anchor.alg=sha256');
  assert.equal(receipt.anchor.prevHash, null, '链首收据 prevHash=null');
  assert.match(receipt.anchor.hash, /^[0-9a-f]{64}$/, 'anchor.hash 为 sha256 hex（64 字符）');
  // 内容四要素（design.md:115）
  assert.deepEqual(receipt.attemptedParams, { cmd: 'rm -rf /' }, 'attempted_params');
  assert.equal(receipt.decision.primitive, 'DENY', '裁决 primitive');
  assert.equal(receipt.decision.priority, 2, '裁决 priority（P2）');
  assert.ok(receipt.decision.reason.length > 0, '裁决 reason');
  assert.ok(receipt.ts, 'ts ISO 时间戳');
  assert.match(receipt.ts, /^\d{4}-\d{2}-\d{2}T/, 'ts 为 ISO 格式');
  assert.ok(receipt.receiptId.length > 0, 'receiptId uuid');
  assert.deepEqual(receipt.ruleRefs, ['R001'], 'ruleRefs 溯源');
  assert.equal(receipt.tool, 'bash');
  assert.equal(receipt.callId, 'call-bash');
  assert.equal(receipt.sessionId, 'sess-proto');
  hook.dispose();
});

test('P1-5 读回验证：readRefusals(root, sessionId, {limit}) 读回与落盘一致；refusals.count() 断言', async () => {
  const ctx = fakeCtx();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-proto-'));
  const hook = installGovernanceHook(ctx, { store: null, root, config: PROTO_CFG });
  const pre = ctx.listeners.get('tools/pre-execute');
  await pre(execOf('bash', { cmd: 'rm -rf /' }), async () => ({ kind: 'allow' }));
  assert.equal(hook.refusals.count(), 1, 'count()=1');
  // 读回（无 limit → 全部）
  const back = readRefusals(root, 'sess-proto');
  assert.equal(back.length, 1);
  // 与落盘文件逐字段一致
  const dir = refusalDirOf(root, 'sess-proto');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  assert.deepEqual(back[0], onDisk, '读回与落盘一致');
  assert.equal(back[0].decision.primitive, 'DENY');
  assert.deepEqual(back[0].attemptedParams, { cmd: 'rm -rf /' });
  // limit 语义：写 2 份 → limit=1 返回最近 1 条
  await pre(execOf('bash', { cmd: 'rm -rf /tmp/x' }), async () => ({ kind: 'allow' }));
  assert.equal(hook.refusals.count(), 2);
  const latest = readRefusals(root, 'sess-proto', { limit: 1 });
  assert.equal(latest.length, 1);
  assert.notEqual(latest[0].receiptId, onDisk.receiptId, 'limit=1 返回最近一条（第二次写，id 与首条不同）');
  assert.deepEqual(latest[0].attemptedParams, { cmd: 'rm -rf /tmp/x' }, '最近一条为第二次调用');
  hook.dispose();
});

test('P1-6 ask 降级：REQUIRE_APPROVAL 规则 → pre 返回 {kind:ask} → 无审批服务 → 降级 deny（HOST:3305-3311）；收据照常落盘', async () => {
  const ctx = fakeCtx();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-proto-'));
  const hook = installGovernanceHook(ctx, { store: null, root, config: ASK_CFG });
  const pre = ctx.listeners.get('tools/pre-execute');
  // pre 层：REQUIRE_APPROVAL → {kind:'ask'}（wiring 契约，I1-4 同）
  const gate = await pre(execOf('edit', { scope: 'admin' }), async () => ({ kind: 'allow' }));
  assert.equal(gate.kind, 'ask');
  assert.match(gate.reason, /^\[governance:REQUIRE_APPROVAL\] /);
  // 宿主链：ask + 无 approval 服务 → 降级 deny（HOST:3305-3311「approval === void 0 → {kind:'deny'}」）
  const out = await hostChain(pre, execOf('edit', { scope: 'admin' }), { approvalService: false });
  assert.equal(out.dispatched, false, '无审批服务 → 降级拒绝，不 dispatch');
  assert.match(out.reason, /^\[governance:REQUIRE_APPROVAL\] /, '降级拒绝保留原 reason');
  // 收据照常落盘（ask 决策同样留痕，count=1——同一调用仅触发一次 pre，此处演示独立调用）
  assert.equal(hook.refusals.count(), 2, '两次 ask 调用各落 1 份收据');
  const back = readRefusals(root, 'sess-proto');
  assert.equal(back.length, 2);
  assert.ok(back.every((r) => r.decision.primitive === 'REQUIRE_APPROVAL'), '收据 primitive=REQUIRE_APPROVAL');
  hook.dispose();
});
