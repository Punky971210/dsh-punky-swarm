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

// Step2 preset 装载集成测试：装配级 preset 生效（静态 config preset 键 → hook 用展开 rules 拦截）+
//   T-4 热更四态（runtime.json overlay：启/换/错/撤，⑤ 通道 dispose+重挂即时生效）+
//   C3（acceptance 条件）：preset 规则命中 DENY → escalation 计数联动断言（开启可计入 / 出厂关零记录）。
// 依据：preset-impl-design.md §2.5/§2.6/§4 T-4；acceptance.md C2/C3。
// harness 形态对齐 governance-hotconfig.test.js（assemblyCtx/freshRoot/writeRuntime/execOf）与
//   governance-escalate.test.js §2（seedBatch + member.dispatch 登记模拟映射命中，T20a 同法）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { EVT_GOVERNANCE_REFUSAL, EVT_BATCH_GOVERNANCE_ESCALATE, EVT_BATCH_PHASE } from '../lib/state/event-types.js';
import { readRefusals } from '../lib/governance/receipt-store.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOT_SLEEP = 1000;
const HOT_SETTLE = 200;

// ── 装配级 fake ctx（追加式注册 + logger 留痕；镜像 hotconfig/escalate 先例）──
function assemblyCtx() {
  const listeners = new Map();
  const calls = { info: [], warn: [], error: [] };
  const logger = {
    info: (...a) => calls.info.push(a.join(' ')),
    warn: (...a) => calls.warn.push(a.join(' ')),
    error: (...a) => calls.error.push(a.join(' ')),
  };
  const ctx = {
    listeners, calls, logger,
    tools: { register() {} },
    emit() {},
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => { listeners.get(event)?.delete(fn); };
    },
  };
  ctx.preCount = () => listeners.get('tools/pre-execute')?.size ?? 0;
  return ctx;
}
function freshRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'punky-preset-cfg-'));
}
function writeRuntime(root, overlay) {
  const dir = path.join(root, 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify(overlay, null, 2));
}
function execOf(name, args, sessionId) {
  return {
    name, arguments: args,
    callId: 'call-' + name + '-' + Math.random().toString(36).slice(2, 8),
    ...(sessionId ? { agent: { session: { id: sessionId } } } : {}),
  };
}
// 预置 running 批（辅助 createStore 与 apply 内部 store 同 root 文件系统互见）
function seedBatch(root, sessionId, batchId, laneId = 'l1') {
  const aux = createStore(root);
  aux.createBatch(sessionId, { batchId, wavePlan: buildWavePlan({ batchId, tasks: [{ id: laneId }] }), phase: 'running' });
  return aux;
}

// 装配级静态 preset 生效：apply config.governance.hook.preset 展开装载（loader 从包 PRESETS_DIR 读真实三 JSON）
test('装配-1 preset 键生效：apply 静态 preset:l1-sensitive → pre 命中 L1-D09（web_search 带凭据 URL DENY）', async () => {
  const root = freshRoot();
  writeRuntime(root, {});
  const ctx = assemblyCtx();
  const disposer = apply(ctx, { root, governance: { hook: { preset: 'l1-sensitive' } } });
  try {
    await sleep(HOT_SETTLE);
    assert.equal(ctx.preCount(), 1, 'hook 已挂（preset 展开规则就位）');
    const pre = [...(ctx.listeners.get('tools/pre-execute') ?? [])][0];
    // L1-D09：web_search queries 带凭据 URL → DENY（hard）——仅 preset 展开能命中（yml 空表无此规则）
    const out = await pre(execOf('web_search', { queries: ['https://u:p@example.com/q'] }), () => {});
    assert.equal(out.kind, 'deny');
    assert.match(out.reason, /^\[governance:DENY\]/);
    const receipts = readRefusals(root, 'cli');
    assert.equal(receipts.length, 1, '收据落盘');
    assert.deepEqual(receipts[0].ruleRefs, ['L1-D09'], 'ruleRefs 溯源到 preset 规则 id');
    // 干净参数 → ALLOW 透传（preset 规则按工具/内容精确命中）
    let next = 0;
    await pre(execOf('web_search', { queries: ['deepseek api pricing'] }), () => { next++; });
    assert.equal(next, 1, '不命中 → ALLOW 透传');
  } finally {
    disposer();
  }
});

test('装配-2 preset 双引用 + 超限窄域：preset:[l1,l2] → pwsh timeoutMs 超限命中 L2-R01（flag-off DENY 回退）', async () => {
  const root = freshRoot();
  writeRuntime(root, {});
  const ctx = assemblyCtx();
  const disposer = apply(ctx, { root, governance: { hook: { preset: ['l1-sensitive', 'l2-resource'] } } });
  try {
    await sleep(HOT_SETTLE);
    const pre = [...(ctx.listeners.get('tools/pre-execute') ?? [])][0];
    const out = await pre(execOf('pwsh', { command: 'Get-Process', timeoutMs: 600001 }), () => {});
    assert.equal(out.kind, 'deny', 'L2-R01 超限 flag-off → DENY');
    assert.match(out.reason, /钳制明细：\/timeoutMs: 600001 → 600000/, 'DENY 含窄域钳制指引（L2 preset 规则生效）');
  } finally {
    disposer();
  }
});

// ── T-4 热更四态（runtime.json overlay，⑤ 通道 dispose+重挂）──

test('T4-1 启：overlay 下发 preset:[l1,l2] → remount 生效（pwsh 超限 DENY + l1 规则同命中）', async () => {
  const root = freshRoot();
  writeRuntime(root, {});
  const ctx = assemblyCtx();
  const disposer = apply(ctx, { root, governance: { hook: { enabled: true } } }); // 静态无规则空表
  try {
    await sleep(HOT_SETTLE);
    const pre0 = [...(ctx.listeners.get('tools/pre-execute') ?? [])][0];
    let n0 = 0;
    await pre0(execOf('pwsh', { command: 'Get-Process', timeoutMs: 600001 }), () => { n0++; });
    assert.equal(n0, 1, '启用前空表 → ALLOW');
    // 热启 preset 双引用
    writeRuntime(root, { governance: { hook: { preset: ['l1-sensitive', 'l2-resource'] } } });
    await sleep(HOT_SLEEP);
    assert.equal(ctx.preCount(), 1, 'remount 后 hook 仍挂');
    const pre = [...(ctx.listeners.get('tools/pre-execute') ?? [])][0];
    const out = await pre(execOf('pwsh', { command: 'Get-Process', timeoutMs: 600001 }), () => {});
    assert.equal(out.kind, 'deny', 'preset 展开 18 条生效：L2-R01 命中');
    assert.match(out.reason, /L2-R01|timeoutMs/, 'reason 溯源 preset 规则');
    // 热更留痕日志
    assert.ok(ctx.calls.info.some((l) => l.includes('re-mounted')), 'remount 留痕');
  } finally {
    disposer();
  }
});

test('T4-2 换：overlay 换 preset:l2-resource → remount rules=6（l1 规则失效、l2 仍生效）', async () => {
  const root = freshRoot();
  writeRuntime(root, {});
  const ctx = assemblyCtx();
  const disposer = apply(ctx, { root, governance: { hook: { preset: ['l1-sensitive', 'l2-resource'] } } });
  try {
    await sleep(HOT_SETTLE);
    // 换引用为单 l2
    writeRuntime(root, { governance: { hook: { preset: 'l2-resource' } } });
    await sleep(HOT_SLEEP);
    const pre = [...(ctx.listeners.get('tools/pre-execute') ?? [])][0];
    // l1 规则不再命中：web_search 带凭据 URL（L1-D09 属 l1）→ ALLOW
    let n1 = 0;
    await pre(execOf('web_search', { queries: ['https://u:p@example.com/q'] }), () => { n1++; });
    assert.equal(n1, 1, 'l1 规则已撤（L1-D09 不再命中）');
    // l2 仍命中：pwsh timeoutMs 超限 → DENY
    const out = await pre(execOf('pwsh', { command: 'Get-Process', timeoutMs: 600001 }), () => {});
    assert.equal(out.kind, 'deny', 'l2 规则仍生效（L2-R01 命中）');
  } finally {
    disposer();
  }
});

test('T4-3 错：overlay 含未知 id → 装载失败回退空表 + warn 留痕、不炸装配（hook 空表继续 ALLOW）', async () => {
  const root = freshRoot();
  writeRuntime(root, {});
  const ctx = assemblyCtx();
  const disposer = apply(ctx, { root, governance: { hook: { preset: 'l1-sensitive' } } });
  try {
    await sleep(HOT_SETTLE);
    // 热写未知 id（runtime overlay 不校验 governance 子键 → 传播到 resolve）
    writeRuntime(root, { governance: { hook: { preset: 'no-such-preset' } } });
    await sleep(HOT_SLEEP);
    // C2：装载失败 warn 显式留痕（非静默——防以为武装实则裸奔）
    assert.ok(
      ctx.calls.warn.some((w) => w.includes('未知 preset id') && w.includes('no-such-preset')),
      'warn 留痕含未知 id（实际: ' + ctx.calls.warn.join(' | ') + '）',
    );
    assert.equal(ctx.preCount(), 1, 'hook 仍挂（回退空表快照继续，不炸装配）');
    const pre = [...(ctx.listeners.get('tools/pre-execute') ?? [])][0];
    // 空表 → 原 l1 规则不再命中（回退零拦截 = 出厂默认安全形态，错误显式可修）
    let n = 0;
    await pre(execOf('web_search', { queries: ['https://u:p@example.com/q'] }), () => { n++; });
    assert.equal(n, 1, '回退空表 → ALLOW（宁空勿半）');
  } finally {
    disposer();
  }
});

test('T4-4 撤：overlay 移除 preset 键 → 回出厂空表零拦截（deepMerge 叠加语义：静态无 preset，overlay 撤键即回静态）', async () => {
  const root = freshRoot();
  writeRuntime(root, {});
  const ctx = assemblyCtx();
  const disposer = apply(ctx, { root, governance: { hook: { enabled: true } } }); // 静态无 preset（出厂形态）
  try {
    await sleep(HOT_SETTLE);
    // ① overlay 热启 preset
    writeRuntime(root, { governance: { hook: { preset: 'l1-sensitive' } } });
    await sleep(HOT_SLEEP);
    const preOn = [...(ctx.listeners.get('tools/pre-execute') ?? [])][0];
    const outOn = await preOn(execOf('web_search', { queries: ['https://u:p@example.com/q'] }), () => {});
    assert.equal(outOn.kind, 'deny', 'overlay 启用 preset 生效（L1-D09 命中）');
    // ② overlay 移除 preset 键（空对象 → 快照回静态无 preset）→ 出厂空表
    writeRuntime(root, { governance: { hook: {} } });
    await sleep(HOT_SLEEP);
    assert.equal(ctx.preCount(), 1, '撤后 hook 仍挂');
    const pre = [...(ctx.listeners.get('tools/pre-execute') ?? [])][0];
    let n = 0;
    await pre(execOf('web_search', { queries: ['https://u:p@example.com/q'] }), () => { n++; });
    assert.equal(n, 1, '撤 preset 键 → 回出厂空表零拦截（L1-D09 不再命中）');
  } finally {
    disposer();
  }
});

// ── C3 preset×escalation 联动（acceptance 条件）：preset 规则命中 DENY → escalation 计数——
//   开启（enabled=true + 映射命中 + 3 次 DENY）→ 批 paused（governance-escalate）；
//   出厂关（escalation 缺省）→ 零批事件、phase 不误暂停。

// preset 规则命中 DENY 的调用（l1-sensitive 的 L1-D01：subagent prompt 私钥块 → hard DENY）
const PEM_RSA = '-----BEGIN RSA PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw\\n-----END RSA PRIVATE KEY-----';

test('C3-1 escalation 开启：preset 规则命中 DENY（L1-D01）3 次达阈值 → 批 paused reason=governance-escalate + refusal 记录', async () => {
  const root = freshRoot();
  writeRuntime(root, {});
  const S = 'sess-c3on';
  const aux = seedBatch(root, S, 'b-c3on');
  aux.appendEvent(S, 'b-c3on', 'member.dispatch', { lane: 'l1', workerSessionId: 'sess-ws-c3on' }); // 登记 → apply 启动索引命中
  const ctx = assemblyCtx();
  const disposer = apply(ctx, {
    root,
    governance: { hook: { preset: 'l1-sensitive', escalation: { enabled: true, threshold: 3 } } },
  });
  try {
    const pre = [...(ctx.listeners.get('tools/pre-execute') ?? [])][0];
    assert.equal(typeof pre, 'function');
    for (let i = 0; i < 3; i++) {
      const out = await pre(execOf('subagent', { prompt: `deploy? ${PEM_RSA}` }, 'sess-ws-c3on'), () => {});
      assert.equal(out.kind, 'deny', 'L1-D01 DENY 裁决照常');
    }
    const b = aux.readBatch(S, 'b-c3on');
    assert.equal(b.phase, 'paused', 'preset DENY 3 次达阈值 → 批 paused');
    const esc = b.events.filter((e) => e.type === EVT_BATCH_GOVERNANCE_ESCALATE);
    assert.equal(esc.length, 1, 'batch.governance-escalate 恰 1 条');
    assert.deepEqual({ count: esc[0].count, lane: esc[0].lane }, { count: 3, lane: 'l1' });
    assert.deepEqual(esc[0].receiptIds.length, 3, '摘要含 3 收据');
    assert.equal(b.events.filter((e) => e.type === EVT_GOVERNANCE_REFUSAL).length, 3, 'refusal 记录 3 条');
    const paused = b.events.filter((e) => e.type === EVT_BATCH_PHASE && e.to === 'paused');
    assert.equal(paused.length, 1);
    assert.equal(paused[0].reason, 'governance-escalate');
  } finally {
    disposer();
  }
});

test('C3-2 出厂关（escalation 缺省）：preset DENY 命中 → 仅 jsonl、批事件流零 governance.refusal、零升级、phase 不误暂停', async () => {
  const root = freshRoot();
  writeRuntime(root, {});
  const S = 'sess-c3off';
  const aux = seedBatch(root, S, 'b-c3off');
  aux.appendEvent(S, 'b-c3off', 'member.dispatch', { lane: 'l1', workerSessionId: 'sess-ws-c3off' });
  const ctx = assemblyCtx();
  const disposer = apply(ctx, { root, governance: { hook: { preset: 'l1-sensitive' } } }); // escalation 缺省关
  try {
    const pre = [...(ctx.listeners.get('tools/pre-execute') ?? [])][0];
    for (let i = 0; i < 3; i++) {
      const out = await pre(execOf('subagent', { prompt: `deploy? ${PEM_RSA}` }, 'sess-ws-c3off'), () => {});
      assert.equal(out.kind, 'deny', 'preset 规则裁决照常（关态只影响计数）');
    }
    const b = aux.readBatch(S, 'b-c3off');
    assert.equal(b.events.filter((e) => e.type === EVT_GOVERNANCE_REFUSAL).length, 0, '出厂关 → 批事件流零 governance.refusal');
    assert.equal(b.events.filter((e) => e.type === EVT_BATCH_GOVERNANCE_ESCALATE).length, 0, '零升级');
    assert.equal(b.phase, 'running', 'phase 不误暂停（出厂默认零计数零记录零升级）');
    // C1 jsonl 事件可见性保留（桥接照常）
    const evFile = path.join(root, 'governance', 'events', 'refusal-sess-ws-c3off.jsonl');
    assert.equal(fs.existsSync(evFile), true);
    assert.equal(fs.readFileSync(evFile, 'utf8').trim().split('\n').filter(Boolean).length, 3, 'jsonl 3 行（事件可见性保留）');
  } finally {
    disposer();
  }
});
