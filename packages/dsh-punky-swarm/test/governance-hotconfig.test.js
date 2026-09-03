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

// P3 组（harden-plan §6 P3 组，7 条）：governance 键热更新 + 示例规则可执行
//   T1 ALLOWED_TOP_KEYS 含 governance（config-watch 白名单，harden-plan §5.4 A.1）
//   T2 validateOverlay 接受 governance / 拒绝未知顶层键与未知 capabilities 键
//   T3 applyConfigChange ⑤ enabled 翻转 → dispose+重挂（装配级：apply + runtime.json 热写，pre listener 卸载/重注册）
//   T4 rules 覆盖 → 新规则生效（重挂后 decide 用新 rules；docs/guardrails-hook.md §3 示例规则 1 装配链路命中 → DENY + 收据 + 桥接事件流随动）
//   T5 既有 ①-④ 分支回归：非 governance 键热变更不触发重挂、不抛错（④ resolveVerifyConfig 缺陷修复回归——
//      基线 index.js 未导入 resolveVerifyConfig，任何 hot 变更在 ④ 抛 ReferenceError 阻断后续分支）
//   T6 示例规则 1 命中（docs/guardrails-hook.md §3：hard → DENY；含示例 3 manual_review → REQUIRE_APPROVAL 佐证）
//   T7 示例规则 2 命中（docs/guardrails-hook.md §3：narrowable + flag.narrow → NARROW + narrowedParams 钳制；flag-off 回退 DENY）
// 装配级形态（apply + runtime.json 热写）对齐 legacy-fix.test.js（fake ctx 先例）与 hot-config.test.js H8
// （真实 fs.watch + 防抖等待先例）；governance hook 单点语义回归由 governance-wiring/state/proto 组覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALLOWED_TOP_KEYS, validateOverlay } from '../lib/hot/config-watch.js';
import { apply } from '../lib/index.js';
import { createGovernanceKernel } from '../lib/governance/kernel.js';
import { resolveGovernanceConfig } from '../lib/governance/config.js';
import { readRefusals } from '../lib/governance/receipt-store.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fs.watch 事件 → 防抖 300ms（apply 内 createConfigWatcher 默认 debounceMs）→ reload → onChange；
// 等待窗口 1000ms（防抖 + 事件 + 解析余量，hot-config H8 先例放宽）
const HOT_SLEEP = 1000;
const HOT_SETTLE = 200;

// ── 装配级 fake ctx：ctx.on 追加式注册（可多个 listener，返回按身份 disposer；热重挂需旧 listener 移除）──
function assemblyCtx() {
  const listeners = new Map(); // event -> Set<fn>
  const calls = { info: [], warn: [], error: [] };
  const logger = {
    info: (...a) => calls.info.push(a.join(' ')),
    warn: (...a) => calls.warn.push(a.join(' ')),
    error: (...a) => calls.error.push(a.join(' ')),
  };
  const ctx = {
    listeners,
    calls,
    logger,
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'punky-hotgov-'));
}

function writeRuntime(root, overlay) {
  const dir = path.join(root, 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify(overlay, null, 2));
}

// 最小 ToolExecution 形态（无 agent → sessionId 'cli'，与 receipt-store 缺省口径一致）
function execOf(name, args) {
  return { name, arguments: args, callId: 'call-' + name + '-' + Math.random().toString(36).slice(2, 8) };
}

// ── docs/guardrails-hook.md §3 示例规则（governance-hotconfig 与 docs/guardrails-hook.md 同源：T6/T7/T4 断言即文档预期行为）──
const EX_RULE_FORBID_DELETE = {
  id: 'example-forbid-force-delete',
  tools: ['bash', 'pwsh'],
  match: { path: '/cmd', op: 'regex', pattern: 'rm -rf|Remove-Item -Recurse|del /f /s /q' },
  violations: [{ code: 'EX1', category: 'hard', message: '强制删除命令被护栏禁止（rm -rf / Remove-Item -Recurse / del /f /s /q）' }],
};
const EX_RULE_TIMEOUT_NARROW = {
  id: 'example-timeout-narrow',
  tools: ['bash'],
  match: { path: '/timeout', op: 'gt', value: 3600 },
  violations: [{ code: 'EX2', category: 'narrowable', message: '超时参数超过 3600s，需收窄' }],
  narrow: [{ path: '/timeout', max: 3600 }],
};
const EX_RULE_ADMIN_APPROVAL = {
  id: 'example-admin-approval',
  match: { path: '/scope', op: 'eq', value: 'admin' },
  violations: [{ code: 'EX3', category: 'manual_review', message: '高危管理操作需人工复核' }],
};

test('T1 ALLOWED_TOP_KEYS 含 governance（热更白名单，harden-plan §5.4 A.1）', () => {
  assert.equal(ALLOWED_TOP_KEYS.has('governance'), true, 'governance 顶层键已纳入 runtime.json 白名单');
  // 既有键不被破坏（回归）
  for (const k of ['aip', 'acps', 'capabilities', 'mailbox', 'resume', 'ratchet', 'escalation']) {
    assert.equal(ALLOWED_TOP_KEYS.has(k), true, '既有顶层键保留: ' + k);
  }
});

test('T2 validateOverlay 接受 governance、拒绝未知键', () => {
  // governance 顶层键接受（子键不校验——与 mailbox 等非能力段同口径，deepMerge 传播）
  assert.equal(validateOverlay({ governance: { hook: { enabled: false } } }).ok, true);
  assert.equal(validateOverlay({ governance: { hook: { enabled: true, rules: [{ id: 'r' }] } } }).ok, true);
  // governance 与其他合法键共存
  assert.equal(validateOverlay({ governance: {}, capabilities: { topic: { enabled: true } } }).ok, true);
  // 未知顶层键仍拒（含 governance 拼写漂移）
  assert.equal(validateOverlay({ governancex: { enabled: true } }).ok, false);
  assert.equal(validateOverlay({ governance: {}, capabilities: { topicx: { enabled: true } } }).ok, false, '未知 capabilities 子键仍拒');
});

test('T3 applyConfigChange ⑤ enabled 翻转 → dispose+重挂（pre listener 卸载/重注册）', async () => {
  const root = freshRoot();
  writeRuntime(root, {}); // 预建 runtime.json（watcher 直 watch 文件需存在；初始 overlay {} 零变化）
  const ctx = assemblyCtx();
  const disposer = apply(ctx, { root, governance: { hook: { enabled: true, rules: [] } } });
  try {
    await sleep(HOT_SETTLE); // watcher 建立余量
    assert.equal(ctx.preCount(), 1, '初始装配 governance hook 已挂（pre listener 1 个）');
    // ① enabled: false → 热切卸载（pre 不再触发）
    writeRuntime(root, { governance: { hook: { enabled: false } } });
    await sleep(HOT_SLEEP);
    assert.equal(ctx.preCount(), 0, 'enabled=false 热切卸载：pre listener 移除');
    assert.ok(ctx.calls.info.some((l) => l.includes('hot config: governance hook') && l.includes('unmounted')),
      '卸载留痕日志（实际: ' + ctx.calls.info.filter((l) => l.includes('governance hook')).join(' | ') + '）');
    // ② 写回 enabled: true → 重挂（pre listener 恢复）
    writeRuntime(root, { governance: { hook: { enabled: true } } });
    await sleep(HOT_SLEEP);
    assert.equal(ctx.preCount(), 1, 'enabled=true 热切重挂：pre listener 恢复');
    assert.ok(ctx.calls.info.some((l) => l.includes('hot config: governance hook') && l.includes('re-mounted')),
      '重挂留痕日志');
  } finally {
    disposer();
  }
});

test('T4 rules 覆盖 → 新规则生效（重挂后 decide 用新 rules；docs/guardrails-hook.md §3 示例规则 1 装配链路命中）', async () => {
  const root = freshRoot();
  writeRuntime(root, {}); // 预建 runtime.json
  const ctx = assemblyCtx();
  const disposer = apply(ctx, { root, governance: { hook: { enabled: true, rules: [] } } });
  try {
    await sleep(HOT_SETTLE);
    // 热写 docs/guardrails-hook.md §3 示例规则 1（rules 数组整体替换）
    writeRuntime(root, { governance: { hook: { rules: [EX_RULE_FORBID_DELETE] } } });
    await sleep(HOT_SLEEP);
    assert.equal(ctx.preCount(), 1, 'rules 热更后 hook 仍挂载（重挂后 pre listener 1 个）');
    const pre = [...(ctx.listeners.get('tools/pre-execute') ?? [])][0];
    assert.equal(typeof pre, 'function');
    // bash + rm -rf → DENY（示例规则 1 命中，docs/guardrails-hook.md §3 预期行为）
    let nextCalled = 0;
    const out = await pre(execOf('bash', { cmd: 'rm -rf /data' }), () => { nextCalled++; });
    assert.equal(out.kind, 'deny');
    assert.match(out.reason, /^\[governance:DENY\]/);
    assert.equal(nextCalled, 0, 'DENY 短路不透传');
    // 收据落盘（重挂链路完整：kernel → wiring → receipt-store）
    const receipts = readRefusals(root, 'cli');
    assert.equal(receipts.length, 1, '拒绝收据已落盘（sessionId=cli）');
    assert.deepEqual(receipts[0].ruleRefs, ['example-forbid-force-delete']);
    // 桥接随动：remount 后 onRefusal 重新注入 → 批级事件流文件与收据一致（p2 桥接交互处置断言）
    const evFile = path.join(root, 'governance', 'events', 'refusal-cli.jsonl');
    assert.equal(fs.existsSync(evFile), true, '重挂后桥接事件流随动（events/refusal-cli.jsonl 已写）');
    const evLines = fs.readFileSync(evFile, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(evLines.length, 1);
    assert.equal(JSON.parse(evLines[0]).receiptId, receipts[0].receiptId, '事件流与收据一致');
    // 不命中（bash + ls）→ ALLOW 透传
    let next2 = 0;
    const out2 = await pre(execOf('bash', { cmd: 'ls -la' }), () => { next2++; });
    assert.equal(out2, undefined, 'ALLOW 走 next() 透传（返回 undefined）');
    assert.equal(next2, 1);
  } finally {
    disposer();
  }
});

test('T5 既有 ①-④ 分支回归：非 governance 键热变更零重挂、零抛错（④ resolveVerifyConfig 缺陷修复）', async () => {
  const root = freshRoot();
  writeRuntime(root, {});
  const ctx = assemblyCtx();
  const disposer = apply(ctx, { root, governance: { hook: { enabled: true, rules: [] } } });
  try {
    await sleep(HOT_SETTLE);
    const preBefore = ctx.preCount();
    assert.equal(preBefore, 1);
    // mailbox 顶层键热变更（applyConfigChange ①-⑤ 全分支经手：watch/trajectory/topic/verify/governance 均无生效变化）
    writeRuntime(root, { mailbox: { sweepOnStart: false } });
    await sleep(HOT_SLEEP);
    assert.equal(ctx.preCount(), preBefore, '非 governance 键变更不触发 governance 重挂');
    // ④ 分支回归：基线缺陷 = resolveVerifyConfig 未导入 → 任何 hot 变更在 ④ 抛 ReferenceError 被 onChange
    // catch 为 'hot config onChange failed' warn；修复后零此类 warn（①-④ 分支全部无抛错执行）
    const changeFailed = ctx.calls.warn.filter((w) => w.includes('hot config onChange failed'));
    assert.equal(changeFailed.length, 0, '④ 分支无 ReferenceError（resolveVerifyConfig 已导入）：' + changeFailed.join(' | '));
    // governance 未受影响（仍拦截默认规则表外无规则 → 空表 ALLOW；hook 存活）
    const pre = [...(ctx.listeners.get('tools/pre-execute') ?? [])][0];
    let next = 0;
    await pre(execOf('bash', { cmd: 'ls' }), () => { next++; });
    assert.equal(next, 1, '空规则表 hook 存活：ALLOW 透传');
  } finally {
    disposer();
  }
});

test('T6 示例规则 1 命中（docs/guardrails-hook.md §3：hard → DENY；示例 3 → REQUIRE_APPROVAL）', () => {
  const cfg = resolveGovernanceConfig({ rules: [EX_RULE_FORBID_DELETE, EX_RULE_ADMIN_APPROVAL] });
  const kernel = createGovernanceKernel(cfg);
  // 示例 1：bash + rm -rf → DENY（priority 2，ruleRefs 溯源）
  const d1 = kernel.decide({ name: 'bash', arguments: { cmd: 'rm -rf /data' } });
  assert.equal(d1.primitive, 'DENY');
  assert.equal(d1.priority, 2);
  assert.deepEqual(d1.ruleRefs, ['example-forbid-force-delete']);
  // pwsh + Remove-Item -Recurse 亦命中（tools 白名单含 pwsh）
  const d2 = kernel.decide({ name: 'pwsh', arguments: { cmd: 'Remove-Item -Recurse -Force C:\\tmp' } });
  assert.equal(d2.primitive, 'DENY');
  // 不命中 → ALLOW
  const d3 = kernel.decide({ name: 'bash', arguments: { cmd: 'ls -la' } });
  assert.equal(d3.primitive, 'ALLOW');
  // 示例 3：scope=admin → REQUIRE_APPROVAL（manual_review；docs/guardrails-hook.md §3 说明 ask 依赖宿主通道，无则降级 deny）
  const d4 = kernel.decide({ name: 'bash', arguments: { scope: 'admin', cmd: 'userdel alice' } });
  assert.equal(d4.primitive, 'REQUIRE_APPROVAL');
  assert.equal(d4.priority, 1);
});

test('T7 示例规则 2 命中（docs/guardrails-hook.md §3：narrowable + flag.narrow → NARROW + narrowedParams 钳制；flag-off 回退 DENY）', () => {
  // flag.narrow=true → NARROW + narrowedParams（/timeout 7200 → 3600）
  const cfgOn = resolveGovernanceConfig({
    rules: [EX_RULE_TIMEOUT_NARROW],
    flags: { pause: false, narrow: true, defer: false },
  });
  const kOn = createGovernanceKernel(cfgOn);
  const dn = kOn.decide({ name: 'bash', arguments: { timeout: 7200 } });
  assert.equal(dn.primitive, 'NARROW');
  assert.equal(dn.priority, 4);
  assert.deepEqual(dn.ruleRefs, ['example-timeout-narrow']);
  assert.ok(dn.narrowedParams, 'NARROW 必填 narrowedParams');
  assert.equal(dn.narrowedParams.narrowed.timeout, 3600, '钳制后 timeout=3600');
  const clamped = dn.narrowedParams.clamped.find((c) => c.path === '/timeout');
  assert.ok(clamped && clamped.from === 7200 && clamped.to === 3600, 'clamped 明细 7200 → 3600');
  // 未超限 → ALLOW
  assert.equal(kOn.decide({ name: 'bash', arguments: { timeout: 300 } }).primitive, 'ALLOW');
  // flag-off（默认）→ DENY 回退 + 收窄指引仍填充（P0 契约：DENY 含 narrowable 亦填充 narrowedParams）
  const cfgOff = resolveGovernanceConfig({ rules: [EX_RULE_TIMEOUT_NARROW] });
  const kOff = createGovernanceKernel(cfgOff);
  const dOff = kOff.decide({ name: 'bash', arguments: { timeout: 7200 } });
  assert.equal(dOff.primitive, 'DENY');
  assert.equal(dOff.priority, 4);
  assert.ok(dOff.narrowedParams, 'flag-off 回退 DENY 仍携带收窄指引（docs/guardrails-hook.md §3 预期行为注）');
});
