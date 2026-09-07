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

// V1-V6 拒绝可见性（受控补正）单测：宿主 serviceAsk 在 4 个泛化分支把 ask.reason 覆盖为工具名级泛化文本
// （Agent 只见 the user rejected tool "X"，无护栏标识/无命中规则）→ wiring post 受控补正 Agent 可见文本。
// 短路条件严格收窄：仅本插件 ask（pendingAsks 命中）+ GENERIC_DENIAL_OUTCOMES 四分支，其余场景恒 next()。
//   V1 rejected 泛化文本补正：短路 accept+content（护栏标注/命中规则/preset 归属/违规 message/查阅路径），
//      收据 ask.outcome 补记 denied-rejected、哈希链不破；next 未被调用。
//   V2 四泛化分支参数化：rejected/cancelled/unavailable/no-agent 均补正，outcome 分类与 inferAskOutcome 一致。
//   V3 无审批服务降级（denied-no-approval）不补正：宿主保留 ask.reason（含护栏前缀）→ 恒 next() 不重复标注。
//   V4 无 pending 登记（非本插件 ask / 未 pre 触发）→ 恒 next()，零行为变化。
//   V5 补记失败降级：收据缺失 → patchRefusalAsk 抛错 → warn 后恒 next()，不抛、不破坏结果。
//   V6 短路不破坏同包前序 listener：evidence → dispatch-reg → wiring post 顺序契约（宿主装配序）；
//      短路后宿主取 wiring 决策，accept+content 替换保 isError（dsh-tools postExecute merge 语义）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installGovernanceHook } from '../lib/governance/wiring.js';
import { readRefusals, verifyRefusals } from '../lib/governance/receipt-store.js';

// ── fake ctx（捕获 ctx.on 注册的 listener；warn 收集供 V5 断言）──
function fakeCtx() {
  const listeners = new Map();
  const warns = [];
  return {
    listeners,
    warns,
    on(event, fn) {
      listeners.set(event, fn);
      return () => { listeners.delete(event); };
    },
    logger: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
  };
}

// 最小 ToolExecution 形态（name/arguments/callId/agent）
function execOf(name, args, session = 'sess-dv') {
  return {
    name,
    arguments: args,
    callId: 'call-' + name,
    agent: { session: { id: session } },
  };
}

// 宿主 materializeFinalResult 形态（HOST:3113-3121：content text 'Error: ' + denialReason，isError:true）
function hostDenialResult(denialReason) {
  return {
    content: [{ type: 'text', text: `Error: ${denialReason}` }],
    isError: true,
    error: { message: denialReason },
  };
}

// 触发配置：pwsh /command 内联凭据 → manual_review → REQUIRE_APPROVAL（语义对齐预设 L1-A10 单条；
// 规则 id 前缀 L1- → 补正文案 preset 归属 l1-sensitive）。
const APPROVAL_CFG = {
  governance: {
    hook: {
      enabled: true,
      rules: [
        {
          id: 'L1-A10',
          tools: ['pwsh'],
          match: { path: '/command', op: 'regex', pattern: 'sk-[A-Za-z0-9_-]{20,}' },
          violations: [
            {
              code: 'L1-A10',
              category: 'manual_review',
              path: '/command',
              message: '[preset L1] pwsh 命令疑似内联凭据（令牌/secret/带凭据 URL）：建议改经凭证存储引用，执行需人工确认',
            },
          ],
        },
      ],
    },
  },
};

const INLINE_SECRET_CMD = "$env:GH_TOKEN='sk-abcDEF0123456789abcdef'"; // 命中 /command regex（凭据签名）

// 宿主 serviceAsk 4 泛化分支 reason 文本（dsh-tools L3308/3327/3334/3341 同构；tool 名按 exec.name 插值）
const GENERIC_CASES = [
  { outcome: 'denied-rejected', text: (t) => `the user rejected tool "${t}"` },
  { outcome: 'denied-cancelled', text: (t) => `approval for tool "${t}" was cancelled` },
  { outcome: 'unavailable', text: (t) => `tool "${t}" requires approval, but no approval channel is available` },
  { outcome: 'denied-no-agent', text: (t) => `tool "${t}" requires approval, but the call has no agent to route it through` },
];

// ── V1 rejected 泛化文本补正 ──
test('V1 rejected 泛化文本补正：短路 accept+content（护栏标注/命中规则/preset/违规 message/查阅路径）；收据 outcome 补记；next 未调用', async () => {
  const ctx = fakeCtx();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-dv-v1-'));
  const hook = installGovernanceHook(ctx, { store: null, root, config: APPROVAL_CFG });
  const pre = ctx.listeners.get('tools/pre-execute');
  const post = ctx.listeners.get('tools/post-execute');
  const exec = execOf('pwsh', { command: INLINE_SECRET_CMD });
  // pre：REQUIRE_APPROVAL → ask（收据落盘 + pendingAsks 登记 decision 快照）
  const gate = await pre(exec, async () => ({ kind: 'allow' }));
  assert.equal(gate.kind, 'ask', 'pre REQUIRE_APPROVAL → ask');
  assert.equal(hook.refusals.count(), 1);
  // post：宿主 rejected 泛化 Error result → 受控补正
  const result = hostDenialResult(GENERIC_CASES[0].text('pwsh'));
  let nextCalled = 0;
  const decision = await post(exec, result, async () => { nextCalled++; return { kind: 'accept' }; });
  // 短路语义：返回 {kind:accept, content:[补正文本]}，next 未透传默认
  assert.equal(decision.kind, 'accept');
  assert.equal(nextCalled, 0, '泛化分支受控短路（next 未被调用）');
  assert.ok(Array.isArray(decision.content) && decision.content.length === 1, 'content 替换为补正文本');
  const text = decision.content[0].text;
  assert.ok(typeof text === 'string' && text.length > 0, '补正文本非空');
  assert.match(text, /^Error: \[governance:REQUIRE_APPROVAL/, '护栏行为标注（Error: 形态 + [governance:…] 前缀）');
  assert.match(text, /L1-A10/, '命中规则 id 可见');
  assert.match(text, /preset l1-sensitive/, 'preset 归属可见');
  assert.match(text, /pwsh 命令疑似内联凭据/, '违规 message 可见（decision.reason 携带）');
  assert.match(text, /refusals\/sess-dv\//, '收据查阅路径可见（<root>/governance/refusals/<sessionId>/）');
  // 审计面不破：收据 ask.outcome 补记 + 哈希链完整 + 补正文本引用收据 id（可追溯链）
  const back = readRefusals(root, 'sess-dv');
  assert.equal(back.length, 1);
  assert.equal(back[0].ask.outcome, 'denied-rejected', '收据 ask.outcome=denied-rejected');
  assert.ok(text.includes(back[0].receiptId), '补正文本引用收据 id（可见文本 → 审计明细可追溯）');
  assert.equal(verifyRefusals(root, 'sess-dv').ok, true, 'outcome 补记级联重锚后哈希链仍完整');
  hook.dispose();
});

// ── V2 四泛化分支参数化 ──
test('V2 四泛化分支参数化：rejected/cancelled/unavailable/no-agent 均受控补正，outcome 分类与 inferAskOutcome 一致', async () => {
  for (const c of GENERIC_CASES) {
    const ctx = fakeCtx();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-dv-v2-'));
    const hook = installGovernanceHook(ctx, { store: null, root, config: APPROVAL_CFG });
    const pre = ctx.listeners.get('tools/pre-execute');
    const post = ctx.listeners.get('tools/post-execute');
    const exec = execOf('pwsh', { command: INLINE_SECRET_CMD });
    const gate = await pre(exec, async () => ({ kind: 'allow' }));
    assert.equal(gate.kind, 'ask', `${c.outcome} pre ask`);
    let nextCalled = 0;
    const decision = await post(exec, hostDenialResult(c.text('pwsh')), async () => { nextCalled++; return { kind: 'accept' }; });
    assert.equal(decision.kind, 'accept', `${c.outcome} 短路 accept`);
    assert.equal(nextCalled, 0, `${c.outcome} next 未调用（受控短路）`);
    assert.match(decision.content[0].text, /\[governance:REQUIRE_APPROVAL/, `${c.outcome} 补正含护栏标注`);
    assert.match(decision.content[0].text, /L1-A10/, `${c.outcome} 补正含命中规则 id`);
    const back = readRefusals(root, 'sess-dv');
    assert.equal(back.length, 1);
    assert.equal(back[0].ask.outcome, c.outcome, `${c.outcome} outcome 分类与 inferAskOutcome 一致`);
    hook.dispose();
  }
});

// ── V3 无审批服务降级不补正 ──
test('V3 无审批服务降级（denied-no-approval）不补正：宿主保留 ask.reason（含护栏前缀）→ 恒 next()，不重复标注', async () => {
  const ctx = fakeCtx();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-dv-v3-'));
  const hook = installGovernanceHook(ctx, { store: null, root, config: APPROVAL_CFG });
  const pre = ctx.listeners.get('tools/pre-execute');
  const post = ctx.listeners.get('tools/post-execute');
  const exec = execOf('pwsh', { command: INLINE_SECRET_CMD });
  const gate = await pre(exec, async () => ({ kind: 'allow' }));
  assert.equal(gate.kind, 'ask');
  // HOST:3298-3304 无审批服务 → 降级 deny，reason 保留 ask.reason（= 本 wiring 护栏前缀正文，无特征文本）
  const result = hostDenialResult(gate.reason);
  let nextCalled = 0;
  const decision = await post(exec, result, async () => { nextCalled++; return { kind: 'accept' }; });
  assert.equal(nextCalled, 1, 'denied-no-approval 恒 next()（pass-through）');
  assert.equal(decision.kind, 'accept');
  assert.equal(decision.content, undefined, '无 content 覆盖（不重复标注——宿主已保留护栏文案）');
  const back = readRefusals(root, 'sess-dv');
  assert.equal(back[0].ask.outcome, 'denied-no-approval', 'outcome=denied-no-approval（既有断言回归：governance-state S2/S3）');
  hook.dispose();
});

// ── V4 无 pending 登记 → 恒 next ──
test('V4 无 pending 登记（非本插件 ask / 未 pre 触发）→ 恒 next()，零行为变化', async () => {
  const ctx = fakeCtx();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-dv-v4-'));
  const hook = installGovernanceHook(ctx, { store: null, root, config: APPROVAL_CFG });
  const post = ctx.listeners.get('tools/post-execute');
  const exec = execOf('pwsh', { command: 'Get-ChildItem' });
  let nextCalled = 0;
  const decision = await post(exec, hostDenialResult('the user rejected tool "pwsh"'), async () => { nextCalled++; return { kind: 'accept' }; });
  assert.equal(nextCalled, 1, '无 pending 登记恒 next()');
  assert.equal(decision.kind, 'accept');
  assert.equal(decision.content, undefined, '不补正（零行为变化）');
  assert.equal(hook.refusals.count(), 0, '未 pre 触发不产生收据');
  assert.equal(fs.existsSync(path.join(root, 'governance', 'refusals')), false, '无收据目录生成');
  hook.dispose();
});

// ── V5 补记失败降级 → 恒 next ──
test('V5 补记失败降级：收据缺失 → patchRefusalAsk 抛错 → warn 后恒 next()，不抛、不破坏结果', async () => {
  const ctx = fakeCtx();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-dv-v5-'));
  const hook = installGovernanceHook(ctx, { store: null, root, config: APPROVAL_CFG });
  const pre = ctx.listeners.get('tools/pre-execute');
  const post = ctx.listeners.get('tools/post-execute');
  const exec = execOf('pwsh', { command: INLINE_SECRET_CMD });
  const gate = await pre(exec, async () => ({ kind: 'allow' }));
  assert.equal(gate.kind, 'ask');
  // 构造补记异常：删除收据 json → patchRefusalAsk 读收据抛错（尽力补记失败路径）
  const dir = path.join(root, 'governance', 'refusals', 'sess-dv');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1);
  fs.unlinkSync(path.join(dir, files[0]));
  let nextCalled = 0;
  const decision = await post(exec, hostDenialResult('the user rejected tool "pwsh"'), async () => { nextCalled++; return { kind: 'accept' }; });
  assert.equal(nextCalled, 1, '补记失败 → 降级恒 next()（不短路）');
  assert.equal(decision.kind, 'accept', '结果未被破坏');
  assert.equal(decision.content, undefined, '结果未被改写');
  assert.ok(ctx.warns.some((w) => w.includes('backfill/correction failed')), '失败 warn 留痕（degraded to pass-through）');
  hook.dispose();
});

// ── V6 短路不破坏同包前序 listener（宿主装配序契约）──
test('V6 短路不破坏同包前序 listener：evidence → dispatch-reg 先执行、wiring post 补正短路后宿主取 wiring 决策（accept+content 保 isError）', async () => {
  const ctx = fakeCtx();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-dv-v6-'));
  const hook = installGovernanceHook(ctx, { store: null, root, config: APPROVAL_CFG });
  const pre = ctx.listeners.get('tools/pre-execute');
  const wiringPost = ctx.listeners.get('tools/post-execute');
  const exec = execOf('pwsh', { command: INLINE_SECRET_CMD });
  const gate = await pre(exec, async () => ({ kind: 'allow' }));
  assert.equal(gate.kind, 'ask', 'pre 登记 pendingAsks');
  // 模拟宿主 postExecute waterfall（cordis：listener 不调 next = 短路）装配序：
  //   evidence（宿主 L406）→ dispatch-reg（L489）→ wiring post（L517）→ 宿主默认 {kind:'accept'}
  const result = hostDenialResult('the user rejected tool "pwsh"');
  const order = [];
  const listeners = [
    async (e, r, next) => { order.push('evidence'); return next(); },
    async (e, r, next) => { order.push('dispatch-reg'); return next(); },
    wiringPost,
    async () => { order.push('host-default'); return { kind: 'accept' }; },
  ];
  const step = async () => {
    const fn = listeners.shift();
    if (!fn) return { kind: 'accept' };
    return fn(exec, result, step);
  };
  const decision = await step();
  // 顺序契约：同包前序 listener（evidence/dispatch-reg）先于 wiring 执行且未受影响；wiring 短路后宿主默认未达
  assert.deepEqual(order, ['evidence', 'dispatch-reg'], 'evidence → dispatch-reg 顺序执行；host-default 未被调用（短路）');
  // 宿主取 wiring 决策并 merge：accept + content 替换，isError / error.message 原样保留（dsh-tools L3383-3387）
  assert.equal(decision.kind, 'accept');
  const merged = { ...result, content: decision.content };
  assert.equal(merged.isError, true, 'isError 保留（不翻转错误语义）');
  assert.equal(merged.error.message, result.error.message, 'error.message 保留');
  assert.match(merged.content[0].text, /\[governance:REQUIRE_APPROVAL/, '展示 content 替换为护栏补正文本');
  hook.dispose();
});
