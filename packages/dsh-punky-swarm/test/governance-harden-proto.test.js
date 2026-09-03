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

// M2 硬化原型演示扩展（harden-plan §5.5 B，tester lane 产物）：P0-P3 关键能力端到端演示
//   A. NARROW 实际钳制（P0）：narrowable 规则 + flag.narrow → wiring pre deny + 收据 narrowedParams
//      （钳制后参数 + clamped 明细）落盘；模型按指引修正重发合规参数 → ALLOW（双调用对比——
//      证明「钳制指引可落地」；exec.arguments 未被改写，宿主禁输入改写 N-8 保持）。
//   B. ask 双路径（P1）：REQUIRE_APPROVAL → pre {kind:'ask'} + 收据 ask.initiated；两路径——
//      ① fake approval 服务 allowed-once → 放行执行 + post 补记 ask.outcome=allowed-once；
//      ② 无审批服务 → 宿主降级 deny + post 补记 ask.outcome=denied-no-approval。
//      （实现事实：两路径收据均落盘——ask.initiated pre 同步落盘；outcome 演化不同。
//       harden-plan §5.5 B「allow（无收据）」文案与实现有出入，tester-report §B 记录偏差。）
//   C. 签名篡改检测（P2）：writeRefusal ×3（sha256 链锚定）→ verifyRefusals ok → 篡改中链收据
//      1 字节 → verifyRefusals ok=false + brokenAt 定位（hash-mismatch）+ 链上后继联动失败（link-break）
//      → 恢复原字节 → ok=true（自愈回归）。
//   D. 热更新实测（P3，真装配级）：apply + 真 fs.watch + 真 runtime.json——enabled 翻转（卸载/重挂）
//      + 规则热更即时生效（示例 1 DENY → 示例 2 NARROW 钳制收据 → rules:[] 零拦截恢复）+ 桥接事件流随动。
//   E. 回归（harden-plan §5.5 E）：原 P1 六步原型链（拦截→裁决→收据→读回→ask 降级→count/limit）
//      保持绿（全量断言在 governance-proto.test.js P1-1..P1-6，此处最小复演快照互指）。
// 载体：node --test 随全量回归（与 governance-proto.test.js 同形态：fake ctx + 最小宿主链驱动）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installGovernanceHook } from '../lib/governance/wiring.js';
import { writeRefusal, readRefusals, verifyRefusals, refusalDirOf } from '../lib/governance/receipt-store.js';
import { makeAnchor } from '../lib/governance/hash-utils.js';
import { apply } from '../lib/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── fake ctx（捕获 ctx.on 注册的 listener；disposer 移除注册——cordis ctx.on 返回 dispose 语义）──
function fakeCtx() {
  const listeners = new Map();
  return {
    listeners,
    on(event, fn) {
      listeners.set(event, fn);
      return () => { listeners.delete(event); };
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

// ── 装配级 fake ctx（hotconfig 同款：事件→Set，可多 listener；preCount 观察）──
function assemblyCtx() {
  const listeners = new Map();
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

function freshRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeRuntime(root, overlay) {
  const dir = path.join(root, 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify(overlay, null, 2));
}

// 最小 ToolExecution 形态（HTYPES:196-220）；callId 每次唯一（B 步骤同调用 pre/post 复用同一 exec）
function execOf(name, args, extra = {}) {
  return {
    name,
    arguments: args,
    callId: 'harden-' + Math.random().toString(36).slice(2, 10),
    agent: { session: { id: 'sess-harden' } },
    ...extra,
  };
}

// 宿主最小 pre 链替身（HOST:3105-3137 语义）：pre 决策 → ask 解析（有/无 approval 服务）→ dispatch/短路。
// 返回 { decision, dispatched, finalResult }——finalResult 供调用方按宿主语义触发 post（isError 形态）。
async function hostChain(pre, exec, { approvalService = false } = {}) {
  const gate = await pre(exec, async () => ({ kind: 'allow' }));
  if (gate.kind === 'ask') {
    if (approvalService) {
      // HOST:3327-3330 allowed-once → 宿主放行 dispatch（工具体执行）→ result 非错误
      return { decision: gate, dispatched: true, finalResult: { isError: false, value: { ok: true } } };
    }
    // HOST:3305-3311 无 approval 服务 → 降级 deny → materializeFinalResult 为 Error（reason 保留 ask.reason）
    return { decision: gate, dispatched: false, finalResult: { isError: true, error: { message: gate.reason } } };
  }
  if (gate.kind === 'allow') return { decision: gate, dispatched: true, finalResult: { isError: false, value: null } };
  return { decision: gate, dispatched: false, finalResult: { isError: true, error: { message: gate.reason } } };
}

// ── README ② 示例规则（hotconfig 同源常量；A/D 步骤装配）──
const EX_RULE_TIMEOUT_NARROW = {
  id: 'example-timeout-narrow',
  tools: ['bash'],
  match: { path: '/timeout', op: 'gt', value: 3600 },
  violations: [{ code: 'EX2', category: 'narrowable', message: '超时参数超过 3600s，需收窄' }],
  narrow: [{ path: '/timeout', max: 3600 }],
};
const EX_RULE_FORBID_DELETE = {
  id: 'example-forbid-force-delete',
  tools: ['bash', 'pwsh'],
  match: { path: '/cmd', op: 'regex', pattern: 'rm -rf|Remove-Item -Recurse|del /f /s /q' },
  violations: [{ code: 'EX1', category: 'hard', message: '强制删除命令被护栏禁止' }],
};
const EX_RULE_ADMIN_APPROVAL = {
  id: 'example-admin-approval',
  match: { path: '/scope', op: 'eq', value: 'admin' },
  violations: [{ code: 'EX3', category: 'manual_review', message: '高危管理操作需人工复核' }],
};

// ═══ A. NARROW 实际钳制（P0，wiring 全链）═══
test('A NARROW 实际钳制：narrowable+flag.narrow → pre deny + 收据 narrowedParams（钳制明细落盘）；修正重发合规参数 → ALLOW（双调用对比）', async () => {
  const root = freshRoot('gov-harden-A-');
  const ctx = fakeCtx();
  const cfg = {
    governance: {
      hook: {
        enabled: true,
        rules: [EX_RULE_TIMEOUT_NARROW],
        flags: { narrow: true },
      },
    },
  };
  const hook = installGovernanceHook(ctx, { store: null, root, config: cfg });
  assert.equal(hook.installed, true);
  const pre = ctx.listeners.get('tools/pre-execute');
  assert.equal(typeof pre, 'function');

  // 调用 1：超限参数（timeout 7200 > 3600）→ NARROW deny + reason 含钳制明细；arguments 未被改写
  const exec1 = execOf('bash', { cmd: 'sleep', timeout: 7200 });
  let next1 = 0;
  const d1 = await pre(exec1, async () => { next1++; return { kind: 'allow' }; });
  assert.equal(d1.kind, 'deny', '超限调用被拦截');
  assert.equal(next1, 0, 'deny 短路不透传');
  assert.match(d1.reason, /^\[governance:NARROW\]/, '裁决原语 NARROW（统一拒绝格式）');
  assert.match(d1.reason, /参数修正指引/, 'reason 含参数修正指引（宿主禁止输入改写语义）');
  assert.match(d1.reason, /钳制明细：\/timeout: 7200 → 3600/, 'reason 含钳制明细（path: from → to，模型可解析）');
  assert.equal(exec1.arguments.timeout, 7200, 'exec.arguments 未被实际改写（N-8 宿主禁输入改写保持）');

  // 收据 narrowedParams 真实落盘（含钳制明细）
  const back1 = readRefusals(root, 'sess-harden');
  assert.equal(back1.length, 1, '恰 1 份收据');
  assert.equal(back1[0].decision.primitive, 'NARROW');
  assert.deepEqual(back1[0].ruleRefs, ['example-timeout-narrow']);
  assert.ok(back1[0].narrowedParams, '收据含 narrowedParams（P0 接线落盘）');
  assert.equal(back1[0].narrowedParams.narrowed.timeout, 3600, '钳制后 timeout=3600');
  const clamped = back1[0].narrowedParams.clamped.find((c) => c.path === '/timeout');
  assert.ok(clamped && clamped.from === 7200 && clamped.to === 3600, 'clamped 明细 7200 → 3600（审计）');
  assert.equal(back1[0].narrowedParams.changed, true, 'changed=true（实际发生钳制）');
  assert.ok(back1[0].anchor && /^[0-9a-f]{64}$/.test(back1[0].anchor.hash), '收据已锚定（sha256）');
  assert.equal(hook.refusals.count(), 1);

  // 调用 2：模型按指引修正重发合规参数（timeout 600 ≤ 3600）→ ALLOW 透传（钳制指引可落地）
  const exec2 = execOf('bash', { cmd: 'sleep', timeout: 600 });
  let next2 = 0;
  const d2 = await pre(exec2, async () => { next2++; }); // next 只计数不返回值（wiring ALLOW 时 return next()）
  assert.equal(d2, undefined, '合规调用走 next() 透传（ALLOW）');
  assert.equal(next2, 1, 'next 被调用（放行）');
  assert.equal(hook.refusals.count(), 1, '合规调用不产生新收据（count 仍 1）——双调用对比：越界拒 + 修正放行');

  // 证据输出（演示记录）：decision reason 全文 + 收据钳制明细
  console.log('[proto-A] deny reason: ' + d1.reason);
  console.log('[proto-A] receipt.narrowedParams: ' + JSON.stringify({ narrowed: back1[0].narrowedParams.narrowed, clamped: back1[0].narrowedParams.clamped, changed: back1[0].narrowedParams.changed }));
  console.log('[proto-A] 修正重发合规参数 → next 放行（exec.arguments.timeout=600 未触发规则）');
  hook.dispose();
});

// ═══ B. ask 双路径（P1：REQUIRE_APPROVAL 有/无审批服务）═══
test('B ask 双路径：REQUIRE_APPROVAL → pre ask + 收据 ask.initiated；① fake approval allowed-once → post 补记 outcome=allowed-once；② 无审批服务 → 降级 deny + outcome=denied-no-approval', async () => {
  const root = freshRoot('gov-harden-B-');
  const ctx = fakeCtx();
  const cfg = {
    governance: {
      hook: {
        enabled: true,
        rules: [EX_RULE_ADMIN_APPROVAL],
      },
    },
  };
  const hook = installGovernanceHook(ctx, { store: null, root, config: cfg });
  assert.equal(hook.installed, true);
  const pre = ctx.listeners.get('tools/pre-execute');
  const post = ctx.listeners.get('tools/post-execute');
  assert.equal(typeof pre, 'function');
  assert.equal(typeof post, 'function');

  // 路径①：有审批服务 → allowed-once → 宿主放行执行 → post 补记 outcome=allowed-once
  const execA = execOf('edit', { scope: 'admin', cmd: 'userdel alice' });
  const a1 = await hostChain(pre, execA, { approvalService: true });
  assert.equal(a1.decision.kind, 'ask', 'REQUIRE_APPROVAL → pre {kind:ask}');
  assert.match(a1.decision.reason, /^\[governance:REQUIRE_APPROVAL\]/, '统一拒绝格式 REQUIRE_APPROVAL 前缀');
  assert.equal(a1.dispatched, true, 'allowed-once → 宿主放行 dispatch（工具体执行）');
  await post(execA, a1.finalResult, async () => ({})); // post 尽力补记（pass-through）
  const backA = readRefusals(root, 'sess-harden');
  assert.equal(backA.length, 1, 'ask 收据 pre 已落盘（initiated）');
  assert.equal(backA[0].ask.channel, 'host-serviceAsk', 'ask.channel=host-serviceAsk');
  assert.equal(backA[0].ask.requestId, execA.callId, 'ask.requestId=callId（宿主审批关联）');
  assert.equal(backA[0].ask.outcome, 'allowed-once', '路径① post 补记 outcome=allowed-once');
  assert.ok(backA[0].ask.initiated, 'ask.initiated 存在（pre 同步落盘时间戳）');

  // 路径②：无审批服务 → 宿主降级 deny → post 补记 outcome=denied-no-approval
  const execB = execOf('edit', { scope: 'admin', cmd: 'userdel bob' });
  const b2 = await hostChain(pre, execB, { approvalService: false });
  assert.equal(b2.decision.kind, 'ask', 'pre 层仍返回 ask（显式化）');
  assert.equal(b2.dispatched, false, '无审批服务 → 宿主降级 deny，不 dispatch（HOST:3305-3311）');
  await post(execB, b2.finalResult, async () => ({})); // 降级 Error result → infer denied-no-approval
  const backB = readRefusals(root, 'sess-harden');
  assert.equal(backB.length, 2, '两份收据（每路径 1 份）');
  const rB = backB.find((r) => r.callId === execB.callId);
  assert.ok(rB, '路径②收据存在');
  assert.equal(rB.ask.outcome, 'denied-no-approval', '路径② post 补记 outcome=denied-no-approval（无审批服务降级）');
  assert.equal(rB.ask.channel, 'host-serviceAsk');

  // 双路径收据 ask 字段不同（outcome 演化分支）——harden-plan §5.5 B 断言口径
  const rA = backA.find((r) => r.callId === execA.callId);
  assert.notEqual(rA.ask.outcome, rB.ask.outcome, '两路径 ask.outcome 不同');
  // verifyRefusals 仍 ok（post 补记走级联重锚，链不破——p2 移交① 处置验证）
  const v = verifyRefusals(root, 'sess-harden');
  assert.equal(v.ok, true, '级联重锚后链完整（patchRefusalAsk × anchor 交互处置）');
  assert.equal(v.count, 2);

  // 证据输出：两路径收据 ask 字段
  console.log('[proto-B] 路径① allowed-once 收据 ask: ' + JSON.stringify(rA.ask));
  console.log('[proto-B] 路径② denied-no-approval 收据 ask: ' + JSON.stringify(rB.ask));
  console.log('[proto-B] verifyRefusals: ' + JSON.stringify({ ok: v.ok, count: v.count }));
  hook.dispose();
});

// ═══ C. 签名篡改检测（P2：收据写→验→篡改 1 字节→verifyRefusals 定位→恢复）═══
test('C 签名篡改检测：写 3 份锚定收据 verify ok；篡改中链 1 字节 → verifyRefusals ok=false brokenAt 定位（hash-mismatch）+ 链上后继 link-break 联动失败；恢复原字节 → ok=true', async () => {
  const root = freshRoot('gov-harden-C-');
  const sessionId = 'sess-harden-C';
  // 3 份手工收据（ts 递增 10ms 保证链序确定；writeRefusal 自动锚定 sha256 链）
  const base = Date.parse('2026-08-31T00:00:00.000Z');
  const mk = (i, cmd) => ({
    receiptId: 'C-r' + i,
    ts: new Date(base + i * 10).toISOString(),
    sessionId,
    tool: 'bash',
    callId: 'C-call-' + i,
    decision: { primitive: 'DENY', priority: 2, reason: 'demo denial ' + i },
    attemptedParams: { cmd },
    ruleRefs: ['C-R' + i],
  });
  writeRefusal(root, mk(1, 'rm -rf /data/1'));
  writeRefusal(root, mk(2, 'rm -rf /data/2'));
  writeRefusal(root, mk(3, 'rm -rf /data/3'));

  // ① 未篡改 → verify ok（链完整，3/3 锚定）
  const v0 = verifyRefusals(root, sessionId);
  assert.equal(v0.ok, true, '未篡改链完整');
  assert.equal(v0.count, 3, '3 份收据参与链校验');

  // ② 篡改中链收据（C-r2）attemptedParams 尾字符 +1（'rm -rf /data/2' → 'rm -rf /data/2X'，1 字节）→ verify 失败
  const dir = refusalDirOf(root, sessionId);
  const r2file = path.join(dir, 'C-r2.json');
  const r2raw = JSON.parse(fs.readFileSync(r2file, 'utf8'));
  const tampered = JSON.parse(JSON.stringify(r2raw));
  tampered.attemptedParams.cmd += 'X'; // 1 字节篡改（内容哈希锚定域）
  fs.writeFileSync(r2file, JSON.stringify(tampered, null, 2), 'utf8');
  const v1 = verifyRefusals(root, sessionId);
  assert.equal(v1.ok, false, '篡改后验链失败');
  assert.equal(v1.brokenAt, 'C-r2', 'brokenAt 定位首个失败收据 C-r2');
  const e2 = v1.receipts.find((x) => x.receiptId === 'C-r2');
  assert.equal(e2.ok, false);
  assert.equal(e2.issue, 'hash-mismatch', 'C-r2 自身内容哈希不匹配（篡改定位）');
  const e1 = v1.receipts.find((x) => x.receiptId === 'C-r1');
  assert.equal(e1.ok, true, '前驱 C-r1 不受影响');
  // 链语义（简版证据信封）：朴素篡改只破坏被篡改收据自身（后继链接的是 hash 非 body——r3.prevHash 仍指
  //   r2 盘上旧 anchor.hash，链上前一推进值同为旧 hash → r3 自洽不联动失败）。后继联动失败需「伪造重锚」
  //   （见 ③）。tester-report §C 记录此链语义与 harden-plan §5.5 步骤 C 文案的精确化。

  // ③ 伪造重锚（改 body + 重算自身 anchor.hash 伪装自洽）→ 链上后继 C-r3 link-break 联动失败
  //    （攻击者若改 body+重算自己 hash，后继 prevHash 指向旧 hash → link-break，篡改不可藏匿）
  const forged = JSON.parse(JSON.stringify(tampered)); // 保留篡改后 body
  forged.anchor = makeAnchor(forged, r2raw.anchor.prevHash); // 重锚伪装自洽（prevHash 不变——前驱未动）
  fs.writeFileSync(r2file, JSON.stringify(forged, null, 2), 'utf8');
  const v2 = verifyRefusals(root, sessionId);
  assert.equal(v2.ok, false, '伪造重锚后验链仍失败');
  assert.equal(v2.brokenAt, 'C-r3', 'brokenAt 定位后继 C-r3（link-break）');
  const f2 = v2.receipts.find((x) => x.receiptId === 'C-r2');
  assert.equal(f2.ok, true, '伪造重锚的 C-r2 自身自洽（hash 重算匹配）');
  const f3 = v2.receipts.find((x) => x.receiptId === 'C-r3');
  assert.equal(f3.ok, false, '链上后继 C-r3 联动失败');
  assert.equal(f3.issue, 'link-break', 'C-r3 prevHash 与链上前一不符（伪造重锚破坏后续链）');

  // ④ 恢复原字节 → verify ok（自愈回归）
  fs.writeFileSync(r2file, JSON.stringify(r2raw, null, 2), 'utf8');
  const v3 = verifyRefusals(root, sessionId);
  assert.equal(v3.ok, true, '恢复原字节 → 链重新完整');

  // 证据输出：篡改各阶段 verify 明细
  console.log('[proto-C] 篡改前 verify: ' + JSON.stringify({ ok: v0.ok, count: v0.count }));
  console.log('[proto-C] 朴素篡改 attemptedParams.cmd（+1 字节，不动 anchor）后 verify: ' + JSON.stringify({
    ok: v1.ok, brokenAt: v1.brokenAt,
    receipts: v1.receipts.map((x) => ({ receiptId: x.receiptId, ok: x.ok, issue: x.issue ?? null })),
  }));
  console.log('[proto-C] 伪造重锚（body+anchor.hash 自洽）后 verify: ' + JSON.stringify({
    ok: v2.ok, brokenAt: v2.brokenAt,
    receipts: v2.receipts.map((x) => ({ receiptId: x.receiptId, ok: x.ok, issue: x.issue ?? null })),
  }));
  console.log('[proto-C] 恢复后 verify: ' + JSON.stringify({ ok: v3.ok, count: v3.count }));
});

// ═══ D. 热更新实测（P3：真装配级 apply + 真 fs.watch + 真 runtime.json）═══
test('D 热更新实测：runtime.json 写 governance.hook.enabled=false → pre 卸载（不再拦截）；写回 true + 规则热更 → 重挂新规则即时生效（示例 1 DENY → 示例 2 NARROW 收据钳制）；rules:[] → 零拦截恢复', async () => {
  const root = freshRoot('gov-harden-D-');
  writeRuntime(root, {}); // 预建 runtime.json（watcher 需文件存在；初始 overlay {} 零变化）
  const ctx = assemblyCtx();
  const disposer = apply(ctx, { root, governance: { hook: { enabled: true, rules: [] } } });
  const HOT_SLEEP = 1000;
  const HOT_SETTLE = 200;
  try {
    await sleep(HOT_SETTLE); // watcher 建立余量
    assert.equal(ctx.preCount(), 1, '初始装配 governance hook 已挂（pre listener 1 个）');
    const preOf = () => [...(ctx.listeners.get('tools/pre-execute') ?? [])][0];

    // ① enabled=false → 热切卸载（免重启；pre 不再触发）
    writeRuntime(root, { governance: { hook: { enabled: false } } });
    await sleep(HOT_SLEEP);
    assert.equal(ctx.preCount(), 0, 'enabled=false 热切卸载（pre listener 移除）');
    assert.ok(ctx.calls.info.some((l) => l.includes('hot config: governance hook') && l.includes('unmounted')),
      '卸载留痕日志: ' + ctx.calls.info.filter((l) => l.includes('governance hook')).join(' | '));

    // ② enabled=true + 规则热更（README 示例 1 禁止强制删除）→ 重挂后即时生效
    writeRuntime(root, { governance: { hook: { enabled: true, rules: [EX_RULE_FORBID_DELETE] } } });
    await sleep(HOT_SLEEP);
    assert.equal(ctx.preCount(), 1, 'enabled=true + rules 热更 → 重挂（pre listener 恢复）');
    assert.ok(ctx.calls.info.some((l) => l.includes('hot config: governance hook') && l.includes('re-mounted')), '重挂留痕日志');
    let next1 = 0;
    const out1 = await preOf()({ name: 'bash', arguments: { cmd: 'rm -rf /data' }, callId: 'D-1' }, () => { next1++; });
    assert.equal(out1.kind, 'deny', '示例规则 1 热更命中 → DENY');
    assert.match(out1.reason, /^\[governance:DENY\]/);
    assert.equal(next1, 0);
    let r1 = readRefusals(root, 'cli');
    assert.equal(r1.length, 1);
    assert.deepEqual(r1[0].ruleRefs, ['example-forbid-force-delete']);

    // ③ 规则再热更（示例 2 超时收窄 + flags.narrow=true）→ 即时生效（NARROW 收据钳制）
    writeRuntime(root, { governance: { hook: { enabled: true, rules: [EX_RULE_TIMEOUT_NARROW], flags: { narrow: true } } } });
    await sleep(HOT_SLEEP);
    assert.equal(ctx.preCount(), 1, '规则+flags 再热更 → hook 仍挂载');
    let next2 = 0;
    const out2 = await preOf()({ name: 'bash', arguments: { cmd: 'sleep', timeout: 7200 }, callId: 'D-2' }, () => { next2++; });
    assert.equal(out2.kind, 'deny', '示例规则 2 热更命中 → 拦截');
    assert.match(out2.reason, /^\[governance:NARROW\]/, 'flags.narrow=true 热更生效 → NARROW 原语');
    assert.match(out2.reason, /钳制明细：\/timeout: 7200 → 3600/, '钳制明细热更后即时生效');
    assert.equal(next2, 0);
    r1 = readRefusals(root, 'cli');
    assert.equal(r1.length, 2, '两次拦截共 2 份收据');
    const rNarrow = r1.find((r) => r.decision.primitive === 'NARROW');
    assert.ok(rNarrow && rNarrow.narrowedParams.narrowed.timeout === 3600, 'NARROW 收据钳制落盘（热更链路完整：重挂 → kernel 新 cfg → wiring → receipt）');
    // 桥接事件流随动（重挂后 refusalEventBridge 重新注入）：与收据一致（2 行）
    const evFile = path.join(root, 'governance', 'events', 'refusal-cli.jsonl');
    assert.equal(fs.existsSync(evFile), true, '桥接事件流文件存在（重挂随动）');
    const evLines = fs.readFileSync(evFile, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(evLines.length, 2, '事件流 2 行 = 2 份收据');
    assert.equal(JSON.parse(evLines[1]).receiptId, rNarrow.receiptId, '事件流末行 = NARROW 收据');

    // ④ rules:[] 热更 → 零拦截恢复（ALLOW 透传）
    writeRuntime(root, { governance: { hook: { enabled: true, rules: [] } } });
    await sleep(HOT_SLEEP);
    assert.equal(ctx.preCount(), 1, 'rules:[] 热更后 hook 仍挂载（零拦截 = 空表 ALLOW）');
    let next3 = 0;
    const out3 = await preOf()({ name: 'bash', arguments: { cmd: 'rm -rf /data', timeout: 7200 }, callId: 'D-3' }, () => { next3++; });
    assert.equal(out3, undefined, 'rules:[] 热更 → 调用透传（不再拦截）');
    assert.equal(next3, 1, 'next 被调用（零拦截恢复）');

    // 证据输出：热更闭环日志
    console.log('[proto-D] hot config governance hook 日志: ' + ctx.calls.info.filter((l) => l.includes('governance hook')).join(' || '));
    console.log('[proto-D] 闭环：挂载(1 listener) → enabled=false 卸载(0) → 示例1 DENY 收据1 → 示例2 NARROW 收据2+事件流2行 → rules:[] ALLOW 透传');
  } finally {
    disposer();
  }
});

// ═══ E. 回归（原 P1 六步原型链快照；全量断言在 governance-proto.test.js P1-1..P1-6）═══
test('E 回归：原 P1 六步原型链保持绿（挂载/拦截/裁决/收据落盘/读回/ask 降级/count+limit）', async () => {
  const root = freshRoot('gov-harden-E-');
  const ctx = fakeCtx();
  const cfg = {
    governance: {
      hook: {
        enabled: true,
        rules: [
          { id: 'R-E1', tools: ['bash'], match: { path: '/cmd', op: 'regex', pattern: 'rm -rf' }, violations: [{ code: 'E1', category: 'hard', message: '禁止删除' }] },
          EX_RULE_ADMIN_APPROVAL,
        ],
      },
    },
  };
  const hook = installGovernanceHook(ctx, { store: null, root, config: cfg });
  const pre = ctx.listeners.get('tools/pre-execute');
  const post = ctx.listeners.get('tools/post-execute');
  assert.equal(hook.installed, true, 'E1 挂载');
  assert.equal(typeof pre, 'function');
  assert.equal(typeof post, 'function');

  // E2 拦截 + E3 裁决（DENY 统一格式）——P1-2/P1-3 快照
  const exec1 = execOf('bash', { cmd: 'rm -rf /tmp/e' });
  const d1 = await pre(exec1, async () => ({ kind: 'allow' }));
  assert.equal(d1.kind, 'deny', 'E2 拦截');
  assert.match(d1.reason, /^\[governance:DENY\]/, 'E3 统一拒绝格式 [governance:DENY]');

  // E4 收据落盘 + 读回——P1-4/P1-5 快照
  const back = readRefusals(root, 'sess-harden');
  assert.equal(back.length, 1, 'E4 收据落盘 1 份');
  assert.equal(back[0].decision.primitive, 'DENY');
  assert.ok(back[0].anchor, '收据锚定（P2 扩展兼容）');
  assert.equal(hook.refusals.count(), 1, 'E5 count()=1');

  // E6 ask 降级（REQUIRE_APPROVAL → pre ask → 无审批 → 降级 deny）——P1-6 快照
  //   注意：hostChain 内部已调一次 pre（gate）；此处不重复直调 pre，避免重复落收据（同一 callId 一次调用）
  const exec2 = execOf('edit', { scope: 'admin' });
  const hostOut = await hostChain(pre, exec2, { approvalService: false });
  assert.equal(hostOut.decision.kind, 'ask', 'E6 pre 层 ask');
  assert.equal(hostOut.dispatched, false, 'E6 无审批服务 → 降级 deny');
  await post(exec2, hostOut.finalResult, async () => ({}));
  assert.equal(hook.refusals.count(), 2, 'E6 收据 count=2（deny 1 + ask 1）');
  const latest = readRefusals(root, 'sess-harden', { limit: 1 });
  assert.equal(latest.length, 1, 'limit=1 最近一条');
  assert.equal(latest[0].decision.primitive, 'REQUIRE_APPROVAL');
  assert.equal(latest[0].ask.outcome, 'denied-no-approval', '降级补记 outcome（S2 同款语义）');

  // 证据输出
  console.log('[proto-E] P1 六步快照：挂载→DENY 拦截(收据1)→读回一致→ask 降级(收据2 outcome=denied-no-approval)→count=2/limit=1');
  hook.dispose();
});
