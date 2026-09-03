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

// M5-a 护栏违规计数升级（governance-escalate）测试。
// 段边界契约（plan §1，防双写）：本文件以「段」划分——
//   §1 纯函数段（T1-T5）：countGovernanceRefusals 窗口评估——exec-count lane 落地（本段）；
//   §2 集成段（T10-T21）：store 方法 + 桥接归属升级链——exec-tester lane 拥有文件整合权并落地；
//   任何 lane 不得越段改写。T6-T9 编号空缺（设计编号从 T5 跳 T10），勿重排编号。
// 纯函数段纪律：零 IO / 零副作用——直接以构造事件序列测 countGovernanceRefusals（不建 store）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { countGovernanceRefusals, DEFAULT_ESCALATION_WINDOW_MS, DEFAULT_ESCALATION_PRIMITIVES } from '../lib/governance/escalation.js';
import { EVT_GOVERNANCE_REFUSAL } from '../lib/state/event-types.js';

// 固定评估基准（epoch ms）——纯函数确定性：now 显式注入，不依赖 Date.now()
const NOW = Date.parse('2026-09-02T00:10:00.000Z');
const WINDOW_MS = DEFAULT_ESCALATION_WINDOW_MS; // 600000（10 分钟）

// 事件构造 helper：ts 用 ISO 串（批事件流 newEvent 基座形态 store.js:113）；相对 now 偏移秒数
const refusal = (offsetSec, primitive = 'DENY') => ({
  ts: new Date(NOW - offsetSec * 1000).toISOString(),
  type: EVT_GOVERNANCE_REFUSAL,
  primitive,
});
const mkEvent = (type, fields = {}) => ({ ts: new Date(NOW - 5000).toISOString(), type, ...fields });

// ---- §1 纯函数段：countGovernanceRefusals（C5 窗口评估 + primitive 过滤）----

test('T1: 空/undefined events → count=0', () => {
  assert.equal(countGovernanceRefusals([], { now: NOW }), 0);
  assert.equal(countGovernanceRefusals(undefined, { now: NOW }), 0);
  assert.equal(countGovernanceRefusals(null, { now: NOW }), 0);
});

test('T2: 窗内 3 条 DENY → 3；窗口外不计（边界：ts === now-windowMs 计、ts < now-windowMs 不计）', () => {
  // 窗内 3 条：距 now 60s / 300s / 边界恰为 600s（ts === now - windowMs → 计）
  const events = [
    refusal(60),
    refusal(300),
    refusal(WINDOW_MS / 1000), // ts === now - windowMs 边界 → 计
    // 窗口外：距 now 600s + 1ms（ts < now - windowMs → 不计）
    { ...refusal((WINDOW_MS + 1) / 1000), ts: new Date(NOW - WINDOW_MS - 1).toISOString() },
  ];
  assert.equal(countGovernanceRefusals(events, { now: NOW, windowMs: WINDOW_MS }), 3);
  // 显式边界核对：仅边界一条 + 窗外一条 → 1
  assert.equal(
    countGovernanceRefusals(
      [
        { ...refusal(WINDOW_MS / 1000), ts: new Date(NOW - WINDOW_MS).toISOString() }, // 边界 → 计
        { ...refusal((WINDOW_MS + 1) / 1000), ts: new Date(NOW - WINDOW_MS - 1).toISOString() }, // 窗外 → 不计
      ],
      { now: NOW, windowMs: WINDOW_MS },
    ),
    1,
  );
});

test('T3: primitive 过滤——primitives=[DENY] 时 NARROW/DEFER 不计，只数 DENY', () => {
  const events = [
    refusal(60, 'DENY'),
    refusal(120, 'NARROW'),
    refusal(180, 'DEFER'),
  ];
  assert.equal(countGovernanceRefusals(events, { now: NOW, primitives: ['DENY'] }), 1);
  // 默认 primitives = ['DENY','NARROW']：DENY+NARROW 计、DEFER 不计
  assert.equal(countGovernanceRefusals(events, { now: NOW }), 2);
  assert.deepEqual(DEFAULT_ESCALATION_PRIMITIVES, ['DENY', 'NARROW']);
});

test('T4: 非目标事件不打断——穿插 member.settled/worktree.checkpoint/batch.phase，窗口计数不受干扰', () => {
  const events = [
    refusal(60),
    mkEvent('member.settled', { lane: 'l1', from: 'pending', to: 'merged' }),
    refusal(120),
    mkEvent('worktree.checkpoint', { lane: 'l1', step: 1, total: 2 }),
    refusal(180),
    mkEvent('batch.phase', { from: 'running', to: 'paused', reason: 'manual' }),
  ];
  assert.equal(countGovernanceRefusals(events, { now: NOW }), 3);
});

test('T5: 窗口语义 vs 连续语义——DENY→merged→DENY→DENY（非连续但窗内）→ count=3', () => {
  const events = [
    refusal(60), // DENY
    mkEvent('member.settled', { lane: 'l1', from: 'review', to: 'merged' }), // 打断「连续」但不打断窗口
    refusal(120), // DENY
    refusal(180), // DENY
  ];
  // 3 条全部在窗内且均计入 → 窗口语义证明（若按「连续」语义会因 merged 中断而归 0/1）
  assert.equal(countGovernanceRefusals(events, { now: NOW }), 3);
});

// ---- §2 集成段（T10-T21）：store 方法 + 桥接归属升级链 ----
// 语义依据：design §6.2 表（T10-T21，设计编号从 T5 跳 T10，T6-T9 空缺勿重排）/ plan §5 / §3.5 摘要。
// 分层测法：
//   - store 层（T10-T15/T17/T18）：直引 createStore + store.recordGovernanceRefusal（C4-C6 升级链在
//     store 方法内闭环——记录/窗口评估/棘轮升级单次原子写 store.js:226-273）；
//   - R2 层（T19）：topic 全链（createStore onStateChange → topic runtime → subscribeTopic，镜像
//     topic-wiring.test.js T7:169-182 形态——governance-escalate 的 batch.phase 一并 emitStateChange）；
//   - 装配层（T16/T20a/T21）：apply + fake ctx 全链路（lib/index.js refusalEventBridge：归属映射 /
//     关态零路径 / 抛错隔离，镜像 governance-hotconfig.test.js assemblyCtx 先例）；
//   - config 层（T12 配置侧 / T20b）：resolveGovernanceConfig escalation 校验回退 + 快照感知（D-5）。
// D-1 依赖标注（如实、不伪造通过）：真实登记点（写 member.dispatch）写侧 D-1 未决（用户裁决中，
//   exec-wiring manifest §2 早报）——读侧骨架 dispatchIndex 就绪、登记点落地形态端到端已验证；
//   本段 T16（映射 miss 静默降级）即当前无登记点下的真实出厂语义；T20a/T21 的「映射命中」形态
//   经 member.dispatch 事件直写模拟（dispatchIndex 读侧重建入口，与 wiring-manifest §2 端到端同法）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { EVT_BATCH_PHASE, EVT_BATCH_GOVERNANCE_ESCALATE, EVT_BATCH_FAILED_ESCALATE } from '../lib/state/event-types.js';
import { apply } from '../lib/index.js';
import { eventStreamFileOf } from '../lib/governance/receipt-store.js';
import { resolveGovernanceConfig } from '../lib/governance/config.js';
import { createTopicRuntime } from '../lib/comms/topic-runtime.js';
import { subscribeTopic } from '../lib/comms/topic.js';

// ── §2 helpers（store 层宿主：独立临时 root，与 §1 纯函数段零 IO 纪律互不干扰）──
const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-gesc-'));
const S2 = 'sess-gesc';
const gStore = createStore(root2);
// 默认 escalation 注入形态（对齐 config resolve 显式开启：enabled:true + 默认阈值/窗口/计入集）
const ESC_ON = { enabled: true, threshold: 3, windowMs: DEFAULT_ESCALATION_WINDOW_MS, primitives: DEFAULT_ESCALATION_PRIMITIVES };

function makeRunningBatch(batchId, lanes) {
  const plan = buildWavePlan({ batchId, tasks: lanes.map((id) => ({ id })) });
  gStore.createBatch(S2, { batchId, wavePlan: plan, phase: 'running' });
  return batchId;
}
// 可计入 refusal 记录（C4 入口直调；第 i 条 receiptId=ri、lane l1、DENY、ruleRefs=['R1']）
function record(batchId, i, over = {}) {
  return gStore.recordGovernanceRefusal(S2, batchId, {
    lane: 'l1', receiptId: 'r' + i, primitive: 'DENY', ruleRefs: ['R1'], tool: 'bash', escalation: ESC_ON, ...over,
  });
}
const escEvs = (batchId) => gStore.readBatch(S2, batchId).events.filter((e) => e.type === EVT_BATCH_GOVERNANCE_ESCALATE);
const phaseEvs = (batchId) => gStore.readBatch(S2, batchId).events.filter((e) => e.type === EVT_BATCH_PHASE);
const refEvs = (batchId) => gStore.readBatch(S2, batchId).events.filter((e) => e.type === EVT_GOVERNANCE_REFUSAL);

// 时间旅行（窗口过期模拟）：直读批文件改写目标事件 ts 后写回（单测串行、无并发写者，原子写语义不必须）
function rewriteEventTs(batchId, type, newTs) {
  const file = gStore.batchFile(S2, batchId);
  const batch = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const e of batch.events) if (e.type === type) e.ts = newTs;
  fs.writeFileSync(file, JSON.stringify(batch, null, 2));
}
// 注入一条历史 refusal 事件（直写——recordGovernanceRefusal 只追加「当下」ts，窗外形态需直写构造）
function injectRefusal(batchId, { receiptId, ts }) {
  const file = gStore.batchFile(S2, batchId);
  const batch = JSON.parse(fs.readFileSync(file, 'utf8'));
  batch.events.push({ ts, type: EVT_GOVERNANCE_REFUSAL, lane: 'l1', receiptId, primitive: 'DENY', ruleRefs: ['R1'], tool: 'bash' });
  fs.writeFileSync(file, JSON.stringify(batch, null, 2));
}

// ── §2 装配层 helper（镜像 governance-hotconfig.test.js assemblyCtx：追加式注册 + logger 留痕）──
function assemblyCtx() {
  const listeners = new Map(); // event -> Set<fn>
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'punky-gesc-assem-'));
}
function writeRuntime(root, overlay) {
  const dir = path.join(root, 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify(overlay, null, 2));
}
// 最小 ToolExecution（带 agent 会话 id——收据 sessionId 来源 = exec.agent.session.id，wiring.js:98）
function execOf(name, args, sessionId) {
  return {
    name, arguments: args,
    callId: 'call-' + name + '-' + Math.random().toString(36).slice(2, 8),
    agent: { session: { id: sessionId } },
  };
}
// 1 条 hard 越界规则（bash + rm -rf → DENY，ruleRefs=['R001'] 非空 → 可计入，T12 之外的正常收据形态）
const RULE_RM_RF = {
  id: 'R001',
  tools: ['bash'],
  match: { path: '/cmd', op: 'regex', pattern: 'rm -rf' },
  violations: [{ code: 'V001', category: 'hard', message: '强制删除命令被护栏禁止' }],
};
// 装配批预置（辅助 createStore 与 apply 内部 store 同 root 文件系统互见；buildWavePlan 建 running 批）
function seedBatch(root, sessionId, batchId) {
  const aux = createStore(root);
  aux.createBatch(sessionId, { batchId, wavePlan: buildWavePlan({ batchId, tasks: [{ id: 'l1' }] }), phase: 'running' });
  return aux;
}

// ---- §2 T10-T15：store 方法升级链（记录/评估/棘轮升级/phase 闸/resume）----

test('T10: escalation.enabled 且窗内 3 条可计入 refusal → phase paused + batch.phase(reason=governance-escalate) + batch.governance-escalate{count:3} 各 1 条', () => {
  makeRunningBatch('b-t10', ['l1']);
  record('b-t10', 1);
  record('b-t10', 2);
  record('b-t10', 3);
  const b = gStore.readBatch(S2, 'b-t10');
  assert.equal(b.phase, 'paused', '升级触发 → paused');
  const esc = escEvs('b-t10');
  assert.equal(esc.length, 1, 'batch.governance-escalate 恰 1 条');
  assert.deepEqual(
    { count: esc[0].count, windowMs: esc[0].windowMs, lane: esc[0].lane, receiptIds: esc[0].receiptIds },
    { count: 3, windowMs: DEFAULT_ESCALATION_WINDOW_MS, lane: 'l1', receiptIds: ['r1', 'r2', 'r3'] },
    '升级载荷 {count:3, windowMs, lane, receiptIds}（C6）',
  );
  const ph = phaseEvs('b-t10').filter((e) => e.reason === 'governance-escalate');
  assert.equal(ph.length, 1, 'batch.phase reason=governance-escalate 恰 1 条');
  assert.deepEqual({ from: ph[0].from, to: ph[0].to }, { from: 'running', to: 'paused' });
  assert.equal(refEvs('b-t10').length, 3, '3 条 refusal 记录齐备（C4）');
});

test('T11: 未达阈值不触发（2 条 < 默认阈值 3 → 仍 running、无升级事件）；threshold 键真实生效（=2 时 2 条即触发）', () => {
  makeRunningBatch('b-t11a', ['l1']);
  record('b-t11a', 1);
  record('b-t11a', 2);
  const b = gStore.readBatch(S2, 'b-t11a');
  assert.equal(b.phase, 'running', '2 条未达阈值 3 → 不触发');
  assert.equal(escEvs('b-t11a').length, 0, '无 batch.governance-escalate');
  assert.equal(phaseEvs('b-t11a').filter((e) => e.reason === 'governance-escalate').length, 0);
  // threshold 键可配（防阈值硬编码回归）：threshold=2 → 2 条即达阈值
  makeRunningBatch('b-t11b', ['l1']);
  for (let i = 1; i <= 2; i++) {
    gStore.recordGovernanceRefusal(S2, 'b-t11b', {
      lane: 'l1', receiptId: 'r' + i, primitive: 'DENY', ruleRefs: ['R1'], tool: 'bash',
      escalation: { ...ESC_ON, threshold: 2 },
    });
  }
  assert.equal(gStore.readBatch(S2, 'b-t11b').phase, 'paused', 'threshold=2 → 2 条即触发');
});

test('T12: 全排除——状态门收据（ruleRefs=[]）/ REQUIRE_APPROVAL / DEFER / PAUSE 默认不计入（零记录零升级）；不可配原语配置侧剔除回退', () => {
  makeRunningBatch('b-t12', ['l1']);
  const arg = (over) => ({ lane: 'l1', receiptId: 'rx', primitive: 'DENY', ruleRefs: ['R1'], tool: 'bash', escalation: ESC_ON, ...over });
  // 逐类排除（store 方法守卫与 C3 计入过滤同标准：返回 null、零事件、零升级）
  assert.equal(gStore.recordGovernanceRefusal(S2, 'b-t12', arg({ ruleRefs: [] })), null, '状态门收据（ruleRefs=[]）永不计数（T12）');
  assert.equal(gStore.recordGovernanceRefusal(S2, 'b-t12', arg({ primitive: 'REQUIRE_APPROVAL' })), null, 'REQUIRE_APPROVAL ask（initiated）不计（§1.5）');
  assert.equal(gStore.recordGovernanceRefusal(S2, 'b-t12', arg({ primitive: 'DEFER' })), null, 'DEFER 默认不计（primitives 不含）');
  assert.equal(gStore.recordGovernanceRefusal(S2, 'b-t12', arg({ primitive: 'PAUSE' })), null, 'PAUSE 默认不计（primitives 不含）');
  const b = gStore.readBatch(S2, 'b-t12');
  assert.equal(refEvs('b-t12').length, 0, '排除类全部零记录');
  assert.equal(b.phase, 'running', '无升级');
  assert.equal(escEvs('b-t12').length, 0);
  // 正例对照（可计入 DENY 记录 1 条——证明排除是类别过滤而非全拒）
  assert.ok(record('b-t12', 9));
  assert.equal(refEvs('b-t12').length, 1);
  // 配置侧：REQUIRE_APPROVAL/状态门不可配入（resolveEscalationConfig 剔除非法、剔空回退默认、warn 留痕）
  const warns = [];
  const c1 = resolveGovernanceConfig({ escalation: { primitives: ['DENY', 'REQUIRE_APPROVAL'] } }, { warn: (m) => warns.push(m) });
  assert.deepEqual(c1.escalation.primitives, ['DENY'], '非法原语剔除、合法保留（REQUIRE_APPROVAL 不可配入）');
  const c2 = resolveGovernanceConfig({ escalation: { primitives: ['REQUIRE_APPROVAL', 'ALLOW'] } }, { warn: (m) => warns.push(m) });
  assert.deepEqual(c2.escalation.primitives, ['DENY', 'NARROW'], '全非法剔空 → 回退默认计入集');
  assert.ok(warns.length >= 2, '非法原语 warn 留痕');
  // threshold/windowMs 非法回退默认（§4 校验）
  const c3 = resolveGovernanceConfig({ escalation: { threshold: 0, windowMs: 500 } }, { warn: (m) => warns.push(m) });
  assert.equal(c3.escalation.threshold, 3, 'threshold <1 回退默认 3');
  assert.equal(c3.escalation.windowMs, 600000, 'windowMs <1000 回退默认 600000');
});

test('T13: phase 非 running（planning / manual paused）→ refusal 记录照写、不升级（无 governance 升级事件）', () => {
  // planning（createBatch 缺省 phase）：3 条记录照写、零升级
  gStore.createBatch(S2, { batchId: 'b-t13a', wavePlan: buildWavePlan({ batchId: 'b-t13a', tasks: [{ id: 'l1' }] }) });
  for (let i = 1; i <= 3; i++) record('b-t13a', i);
  assert.equal(gStore.readBatch(S2, 'b-t13a').phase, 'planning');
  assert.equal(refEvs('b-t13a').length, 3, '记录照写（C4 不受 phase 闸挡）');
  assert.equal(escEvs('b-t13a').length, 0, '不升级（C5 评估仅 running）');
  // manual paused（running → setPhase paused，非升级路径）：记录照写、无 governance 升级事件
  makeRunningBatch('b-t13b', ['l1']);
  gStore.setPhase(S2, 'b-t13b', 'paused');
  for (let i = 1; i <= 3; i++) record('b-t13b', i);
  const bb = gStore.readBatch(S2, 'b-t13b');
  assert.equal(bb.phase, 'paused');
  assert.equal(refEvs('b-t13b').length, 3, 'paused 期间记录照写');
  assert.equal(escEvs('b-t13b').length, 0, '不升级');
  assert.equal(phaseEvs('b-t13b').filter((e) => e.reason === 'governance-escalate').length, 0, '手动 paused 无 governance reason 事件');
});

test('T14: paused 后继续 refusal → 记录照写、升级事件仍 1 条（phase 闸不重复，镜像 failed-escalate.test.js:127-138）', () => {
  makeRunningBatch('b-t14', ['l1']);
  record('b-t14', 1);
  record('b-t14', 2);
  record('b-t14', 3);
  assert.equal(gStore.readBatch(S2, 'b-t14').phase, 'paused');
  record('b-t14', 4); // paused 后继续可计入 refusal（phase 非 running → 只记不评）
  const b = gStore.readBatch(S2, 'b-t14');
  assert.equal(b.phase, 'paused', 'phase 保持 paused');
  assert.equal(refEvs('b-t14').length, 4, '记录照写（第 4 条已追加）');
  assert.equal(escEvs('b-t14').length, 1, '升级事件仍 1 条（不重复）');
});

test('T15: 人工 resume 后重评估——窗口内残留再达阈值 → 再次 paused（第 2 条事件）；窗口过期（改写 ts 模拟）→ 残留不计数不触发', () => {
  // (a) resume 后窗口内残留：3 条 → paused → resume → 第 4 条（全窗内 count=4）→ 再次 paused
  makeRunningBatch('b-t15a', ['l1']);
  for (let i = 1; i <= 3; i++) record('b-t15a', i);
  assert.equal(gStore.readBatch(S2, 'b-t15a').phase, 'paused');
  gStore.setPhase(S2, 'b-t15a', 'running'); // 人工 resume（恢复=人工 batch_phase(running)，C7）
  record('b-t15a', 4);
  assert.equal(gStore.readBatch(S2, 'b-t15a').phase, 'paused', 'resume 后窗口内残留再达阈值 → 再次 paused');
  const esc = escEvs('b-t15a');
  assert.equal(esc.length, 2, '第 2 条升级事件');
  assert.deepEqual(esc[1].receiptIds, ['r1', 'r2', 'r3', 'r4'], '重评估从当前事件流（含历史残留）');
  // (b) 窗口过期：resume 后历史 refusal 全部改写至窗外（ts < now-windowMs）→ 残留不计数 → 追加 1 条不足阈值 → 不触发
  makeRunningBatch('b-t15b', ['l1']);
  for (let i = 1; i <= 3; i++) record('b-t15b', i);
  assert.equal(gStore.readBatch(S2, 'b-t15b').phase, 'paused');
  gStore.setPhase(S2, 'b-t15b', 'running');
  const farPast = new Date(Date.now() - DEFAULT_ESCALATION_WINDOW_MS - 1).toISOString(); // 窗外（窗口同界：ts < now-windowMs 不计）
  rewriteEventTs('b-t15b', EVT_GOVERNANCE_REFUSAL, farPast);
  record('b-t15b', 4); // 追加 1 条窗内 → count=1 < 3
  const bb = gStore.readBatch(S2, 'b-t15b');
  assert.equal(bb.phase, 'running', '窗口过期残留不计数 → 不触发');
  assert.equal(escEvs('b-t15b').length, 1, '仍只有触发前 1 条升级事件');
});

// ---- §2 T16-T18：归属静默降级（装配层）/ 双源并存 / 载荷摘要 ----

test('T16: 归属失败（无 member.dispatch 登记，D-1 当前出厂语义）→ 仅 governance jsonl 有行、批事件流零新增、零升级（静默降级不误暂停）', async () => {
  const root = freshRoot();
  writeRuntime(root, {});
  // 预置 running 批但无登记 → dispatchIndex miss（apply 启动重建全扫可见）
  seedBatch(root, 'sess-g16', 'b16');
  const ctx = assemblyCtx();
  const disposer = apply(ctx, {
    root,
    governance: { hook: { enabled: true, rules: [RULE_RM_RF], escalation: { enabled: true, threshold: 3 } } },
  });
  try {
    const pre = [...(ctx.listeners.get('tools/pre-execute') ?? [])][0];
    assert.equal(typeof pre, 'function');
    const sid = 'sess-ws16';
    let nextCalled = 0;
    for (let i = 0; i < 3; i++) {
      const out = await pre(execOf('bash', { cmd: 'rm -rf /data' }, sid), () => { nextCalled++; });
      assert.equal(out.kind, 'deny', 'deny 裁决照常（桥接不阻断）');
    }
    assert.equal(nextCalled, 0, 'DENY 短路不透传');
    // 仅 governance jsonl 事件流可见（3 行——C1 事件可见性保留）
    const evFile = eventStreamFileOf(root, sid);
    assert.equal(fs.existsSync(evFile), true, 'governance jsonl 有行');
    const lines = fs.readFileSync(evFile, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 3, 'jsonl 3 行');
    // 批事件流零新增（零 governance.refusal / 零升级事件）、phase 仍 running（不误暂停）
    const aux = createStore(root);
    const b = aux.readBatch('sess-g16', 'b16');
    assert.equal(b.events.filter((e) => e.type === EVT_GOVERNANCE_REFUSAL).length, 0, '批事件流零 governance.refusal');
    assert.equal(b.events.filter((e) => e.type === EVT_BATCH_GOVERNANCE_ESCALATE).length, 0, '零升级事件');
    assert.equal(b.phase, 'running', 'phase 不误暂停');
    // 全程零抛错（无隔离 warn——桥接未进入记录段）
    assert.equal(ctx.calls.warn.filter((w) => w.includes('governance escalation bridge failed')).length, 0);
  } finally {
    disposer();
  }
});

test('T17: 与 failed-escalate 双源并存——先到者 paused、后到者被 phase 闸挡（仅 1 条 paused 事件、reason 与先到者一致）', () => {
  // (a) failed-escalate 先到 → governance refusal 后到被挡（记录照写不升级）
  makeRunningBatch('b-t17a', ['f1', 'f2', 'f3', 'f4']);
  gStore.setMember(S2, 'b-t17a', 'f1', 'failed');
  gStore.setMember(S2, 'b-t17a', 'f2', 'failed');
  gStore.setMember(S2, 'b-t17a', 'f3', 'failed');
  assert.equal(gStore.readBatch(S2, 'b-t17a').phase, 'paused', 'failed-escalate 先触发');
  for (let i = 1; i <= 3; i++) record('b-t17a', i); // escalation 开启下 refusal 记录照写
  const ba = gStore.readBatch(S2, 'b-t17a');
  assert.equal(refEvs('b-t17a').length, 3, 'refusal 记录照写（C4 不受另一源 paused 挡）');
  assert.equal(escEvs('b-t17a').length, 0, 'governance 升级被 phase 闸挡（C9 不叠加）');
  const pausedA = phaseEvs('b-t17a').filter((e) => e.to === 'paused');
  assert.equal(pausedA.length, 1, '仅 1 条 paused 事件');
  assert.equal(pausedA[0].reason, 'failed-escalate', 'reason 与先到者一致');
  // (b) governance-escalate 先到 → failed 结算后到被挡（结算照写不升级）
  makeRunningBatch('b-t17b', ['f1', 'f2', 'f3']);
  for (let i = 1; i <= 3; i++) record('b-t17b', i);
  assert.equal(gStore.readBatch(S2, 'b-t17b').phase, 'paused', 'governance-escalate 先触发');
  gStore.setMember(S2, 'b-t17b', 'f1', 'failed');
  gStore.setMember(S2, 'b-t17b', 'f2', 'failed');
  gStore.setMember(S2, 'b-t17b', 'f3', 'failed'); // 结算照写（lanes failed）但不升级（phase 非 running）
  const bb = gStore.readBatch(S2, 'b-t17b');
  assert.equal(bb.lanes.f3, 'failed', 'failed 结算照常写入（paused 期间不阻断结算）');
  assert.equal(escEvs('b-t17b').length, 1, 'governance 升级事件仍 1 条');
  const pausedB = phaseEvs('b-t17b').filter((e) => e.to === 'paused');
  assert.equal(pausedB.length, 1, '仅 1 条 paused 事件');
  assert.equal(pausedB[0].reason, 'governance-escalate', 'reason 与先到者一致');
  assert.equal(bb.events.filter((e) => e.type === EVT_BATCH_FAILED_ESCALATE).length, 0, 'failed-escalate 零事件（phase 闸挡第二源）');
});

test('T18: 升级事件载荷 receiptIds 摘要（窗口同界——窗外收据不入摘要，可回查收据目录）', () => {
  makeRunningBatch('b-t18', ['l1']);
  // 预置 1 条窗外 refusal（直写：ts 早于 now-windowMs）——计数与摘要均应排除
  injectRefusal('b-t18', { receiptId: 'r-old', ts: new Date(Date.now() - DEFAULT_ESCALATION_WINDOW_MS - 1).toISOString() });
  record('b-t18', 1);
  record('b-t18', 2);
  record('b-t18', 3); // 3 条窗内 → count=3 达阈值
  const b = gStore.readBatch(S2, 'b-t18');
  assert.equal(b.phase, 'paused');
  const esc = escEvs('b-t18');
  assert.equal(esc.length, 1);
  assert.equal(esc[0].count, 3, '窗外 r-old 不计数（4 条事件中仅窗内 3 条）');
  assert.deepEqual(esc[0].receiptIds, ['r1', 'r2', 'r3'], '摘要仅含窗内收据（r-old 窗口外不入摘要——与计数窗口同界）');
  assert.equal(esc[0].windowMs, DEFAULT_ESCALATION_WINDOW_MS);
  assert.equal(esc[0].lane, 'l1');
  // 摘要可回查：批事件流中 governance.refusal 记录 4 条全在（含窗外 r-old——记录不受窗口挡，仅评估/摘要排除）
  assert.deepEqual(refEvs('b-t18').map((e) => e.receiptId), ['r-old', 'r1', 'r2', 'r3']);
});

// ---- §2 T19-T21：R2 发布（topic 全链）/ 关态零路径 + 热更感知 / 抛错隔离 ----

test('T19: R2 事件发布——governance-escalate 的 batch.phase 一并 emitStateChange（topic 订阅收到，镜像 topic-wiring.test.js T7）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-gesc-topic-'));
  const rt = createTopicRuntime({}, { root });
  rt.start();
  const store19 = createStore(root, { onStateChange: (ev) => rt.publishStateChange(ev) });
  const S19 = 'sess-t19';
  const bid = 't19';
  store19.createBatch(S19, { batchId: bid, wavePlan: buildWavePlan({ batchId: bid, tasks: [{ id: 'l1' }] }), phase: 'running' });
  const phases = [];
  const up = subscribeTopic('swarm.batch.phase.' + S19 + '.' + bid, (p) => phases.push(p));
  for (let i = 1; i <= 3; i++) {
    store19.recordGovernanceRefusal(S19, bid, {
      lane: 'l1', receiptId: 'r' + i, primitive: 'DENY', ruleRefs: ['R1'], tool: 'bash', escalation: ESC_ON,
    });
  }
  const b = store19.readBatch(S19, bid);
  assert.equal(b.phase, 'paused', '升级触发');
  const paused = phases.filter((p) => p.to === 'paused');
  assert.equal(paused.length, 1, 'batch.phase running→paused 发布恰 1 条');
  assert.equal(paused[0].reason, 'governance-escalate', '发布载荷 reason 区分双源');
  assert.equal(paused[0].type, 'batch.phase');
  up();
  rt.stop();
});

test('T20: escalation.enabled=false 零路径（映射命中仍零计数零记录零升级）；resolve 快照感知 escalation 子键变化（热更生效前提，D-5）', async () => {
  // (a) 装配级关态零路径：不传 escalation（出厂默认关）——即使映射命中（member.dispatch 登记在案）也零记录
  const root = freshRoot();
  writeRuntime(root, {});
  const aux = seedBatch(root, 'sess-g20', 'b20');
  aux.appendEvent('sess-g20', 'b20', 'member.dispatch', { lane: 'l1', workerSessionId: 'sess-ws20' }); // 登记落地形态（读侧索引命中）
  const ctx = assemblyCtx();
  const disposer = apply(ctx, { root, governance: { hook: { enabled: true, rules: [RULE_RM_RF] } } }); // escalation 缺省 → enabled:false
  try {
    const pre = [...(ctx.listeners.get('tools/pre-execute') ?? [])][0];
    const sid = 'sess-ws20';
    for (let i = 0; i < 3; i++) {
      const out = await pre(execOf('bash', { cmd: 'rm -rf /data' }, sid), () => {});
      assert.equal(out.kind, 'deny');
    }
    // C1 jsonl 事件可见性保留（3 行），但批事件流零 governance.refusal（enabled 门先挡——映射命中也不记录）
    const evFile = eventStreamFileOf(root, sid);
    assert.equal(fs.readFileSync(evFile, 'utf8').trim().split('\n').filter(Boolean).length, 3, 'jsonl 3 行');
    const b = aux.readBatch('sess-g20', 'b20');
    assert.equal(b.events.filter((e) => e.type === EVT_GOVERNANCE_REFUSAL).length, 0, '关态零记录（T20 零路径）');
    assert.equal(b.events.filter((e) => e.type === EVT_BATCH_GOVERNANCE_ESCALATE).length, 0, '零升级');
    assert.equal(b.phase, 'running', 'phase 不误暂停');
  } finally {
    disposer();
  }
  // (b) resolve 快照感知（D-5：remount JSON 比较器感知 escalation 任一子键变化——热更生效前提）
  const base = JSON.stringify(resolveGovernanceConfig({}));
  assert.notEqual(JSON.stringify(resolveGovernanceConfig({ escalation: { threshold: 5 } })), base, 'threshold 变化可感知');
  assert.notEqual(JSON.stringify(resolveGovernanceConfig({ escalation: { enabled: true } })), base, 'enabled 翻转可感知');
  assert.notEqual(JSON.stringify(resolveGovernanceConfig({ escalation: { windowMs: 300000, primitives: ['DENY', 'DEFER'] } })), base, 'windowMs/primitives 变化可感知');
  // 同值零感知（幂等比较基准：显式全默认 → 与基准相等，不触发无谓重挂）
  assert.equal(JSON.stringify(resolveGovernanceConfig({ escalation: { enabled: false, threshold: 3, windowMs: 600000, primitives: ['DENY', 'NARROW'] } })), base, '全默认显式同值 → 快照相等（零重挂）');
});

test('T21: 观察者纪律——记录抛错（批次缺失）→ 桥接 warn 隔离、deny 裁决不受阻（C8，失败仅 warn 不阻断）', async () => {
  const root = freshRoot();
  writeRuntime(root, {});
  const aux = seedBatch(root, 'sess-g21', 'b21');
  aux.appendEvent('sess-g21', 'b21', 'member.dispatch', { lane: 'l1', workerSessionId: 'sess-ws21' }); // 登记 → 启动重建索引命中
  const ctx = assemblyCtx();
  const disposer = apply(ctx, {
    root,
    governance: { hook: { enabled: true, rules: [RULE_RM_RF], escalation: { enabled: true, threshold: 3 } } },
  });
  try {
    // apply 启动重建索引已命中 b21；随后删除批次文件 → recordGovernanceRefusal readBatch missing → throw
    fs.rmSync(path.join(root, 'sessions', 'sess-g21', 'batches', 'b21.json'));
    const pre = [...(ctx.listeners.get('tools/pre-execute') ?? [])][0];
    let nextCalled = 0;
    // 直接 await（桥接已 catch 隔离——真抛错则本测试自然失败并暴露错误）；无 doesNotThrow 包 async（其不同步 await）
    const out = await pre(execOf('bash', { cmd: 'rm -rf /data' }, 'sess-ws21'), () => { nextCalled++; });
    assert.equal(out.kind, 'deny', 'deny 裁决不受记录抛错阻断');
    assert.equal(nextCalled, 0, 'DENY 短路不透传');
    // 抛错 warn 留痕（观察者纪律：失败仅 warn，审计可查）
    assert.ok(
      ctx.calls.warn.some((w) => w.includes('governance escalation bridge failed')),
      '隔离 warn 留痕（实际: ' + ctx.calls.warn.join(' | ') + '）',
    );
  } finally {
    disposer();
  }
});
