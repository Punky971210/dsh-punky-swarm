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

// test/worker-notify-wake.test.js —— worker → Leader **唤醒**能力的常驻判据（测试锁）
//
// 判据源：`plan/notify-spec.md`（G-1…G-12）＋ `exec/notify-impl.md`（D-1…D-4 偏离登记）。
// 实现落点（只读依赖，本文件**不改** `lib/**`）：`lib/tools/core.js`
//   `:551-647` 唤醒区块（`WAKE_MIN_INTERVAL_MS` / `LEADER_WAKE_WINDOWS` / `wakeLeaderForReport`）、
//   `:1522` `swarm_report.output.schema` 的 `wake` 键、`:1543-1553` handler 接入点。
//
// 本文件承载的六组判据（编号 = 任务包「任务」面）：
//   ① GREEN     —— handler 被调（`type ∈ {blocked,settle-request}`）⇒ 唤醒路径被触发（可观测信号：
//                    `wake.woke=true` + `followup` 被调用 + 真宿主分片内 Leader `idle→running`）；
//   ② RED①      —— 不调 handler ⇒ 不唤醒（阴性基线）；触发集外（`progress`）⇒ 亦不唤醒；
//   ③ RED②      —— `ctx.get('agents')` 缺失（服务未挂 / `ctx` 无 `get`）⇒ **不抛**且 fail-safe 降级；
//   ④ 节流/合并 —— 同键窗内连发 N=10 条 ⇒ 唤醒次数 **= 1**（上限 ⌈跨度/W⌉+1，与 N 解耦）；跨窗累计 2 次，
//                    且被合并条数随下次唤醒**可见**；
//   ⑤ 防自激    —— `caller === leader` ⇒ `reason='self'`、零 `followup`；唤醒路径**零批面写**（不产生新
//                    `swarm.report` 事件 ⇒ 不自构成触发源）；
//   ⑥ 不回归    —— 既有 `swarm_report` 行为逐字不变：**留痕先于唤醒**（次序可观测）、唤醒失败不损留痕、
//                    同一窗内不产生第二条 wake `user/message`（id 唯一）。
//
// ⚠ 边界声明（如实）：
//   1. 「①GREEN」的**宿主级**读数（真 `Agent` 的 `status idle→running` / `turn/start` / `user/message`）
//      由本文件末组在**本进程自建的真实宿主分片**内取得（复刻 `test/s2-prime-wake-probe.test.js` 装配），
//      **不触碰本会话、不触碰运行中宿主的任何 Leader 会话**；被唤醒的是本进程内新建的探针 Agent。
//      宿主包根不可解析时**该组整组 skip**（不失败）——其余六组**无条件**执行，判据不会因 skip 静默失效。
//   2. 本文件只读 `lib/**`、只写 `test/**`；不 `git commit`、不跑 `npm test`（build 相位会重写 `lib/*.js`）。
//   3. 节流组的 `now` 注入经**测试专属注入缝**（实现 D-2 明确导出 `wakeLeaderForReport` / `LEADER_WAKE_WINDOWS`
//      / `WAKE_MIN_INTERVAL_MS`）；工具面**无第二消费者**，生产路径不传 `now`。
//
// 跑法（**禁 `npm test`**）：
//   cd packages/dsh-punky-swarm
//   node --import ./test/helpers/isolated-home.preload.mjs --test test/worker-notify-wake.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createCoreTools, WAKE_MIN_INTERVAL_MS, LEADER_WAKE_WINDOWS, wakeLeaderForReport,
} from '../lib/tools/core.js';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { EVT_MEMBER_DISPATCH, EVT_SWARM_REPORT } from '../lib/state/event-types.js';

// ── 原始读数（供 audit 逐字引用；不走断言失败路径） ─────────────────────────────
function reading(tag, value) {
  console.log('[notify-wake] ' + tag + ' = ' + JSON.stringify(value));
}

// ── 宿主核心包根（宿主分片组用；不可解析 ⇒ 该组 skip） ──────────────────────────
const HOST_ROOT_CANDIDATES = [
  process.env.DSH_CORE_ROOT,
  'D:/Program Files/npm-global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
];

function resolveHostRoot() {
  for (const root of HOST_ROOT_CANDIDATES) {
    if (!root) continue;
    try {
      if (fs.existsSync(path.join(root, 'dsh-agent-loop', 'lib', 'index.js'))) return root;
    } catch { /* 候选无效，继续 */ }
  }
  return null;
}

const HOST_ROOT = resolveHostRoot();
const HOST_SKIP = HOST_ROOT === null;
const HOST_SKIP_REASON = '宿主核心包根不可解析（需 dsh 发行目录含 dsh-agent-loop）⇒ 宿主分片组 skip；其余六组无条件执行';
const loadHost = (pkg) => import(pathToFileURL(path.join(HOST_ROOT, pkg, 'lib', 'index.js')).href);

// ── 夹具：批次 + `member.dispatch` 绑定（与 `lib/engine/dispatch.js#laneBindingOf` 同源） ──
const OWNER = 'sess-leader';
const WORKER = 'sess-worker';
const LANE = 'e1';

function seedBatch(store, root, { ownerSession = OWNER, batchId, lane = LANE, workerSessionId = WORKER } = {}) {
  const artifactsRoot = path.join(root, 'sessions', ownerSession, 'artifacts', batchId);
  fs.mkdirSync(path.join(artifactsRoot, 'plan'), { recursive: true });
  fs.writeFileSync(path.join(artifactsRoot, 'plan', 'spec.md'), '# 规格夹具\n## 验收标准\n- 夹具\n', 'utf8');
  store.createBatch(ownerSession, {
    batchId,
    wavePlan: buildWavePlan({
      batchId,
      tasks: [
        { id: 'p1', cmd: 'plan 规格（夹具）', layer: 'plan', role: 'coordinator', produce: ['plan/spec.md'], outputs: ['plan/spec.md'] },
        { id: lane, cmd: '实现 X（夹具）', layer: 'exec', role: 'coder', deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/' + lane + '/x.md'] },
        { id: 'a-' + lane, cmd: '按验收标准逐条核对（夹具）', layer: 'audit', role: 'supervisor', deps: [lane], consume: ['plan/spec.md'] },
      ],
    }),
    phase: 'running',
  });
  store.appendEvent(ownerSession, batchId, EVT_MEMBER_DISPATCH, { lane, workerSessionId });
  return artifactsRoot;
}

/** 桩分片：真 `createCoreTools` + 真 `store`，`agents` 服务由参数注入（可缺、可抛）。 */
function stubShard({ agents, batchId = 'b-stub', label = 'stub' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-notify-' + label + '-'));
  const store = createStore(root);
  const artifactsRoot = seedBatch(store, root, { batchId });
  const ctx = {
    on() { return () => {}; },
    tools: { register() {} },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get: (name) => (name === 'agents' ? agents : undefined),
  };
  const byName = Object.fromEntries(createCoreTools(ctx, { store, root, config: {} }).map((t) => [t.name, t]));
  assert.ok(byName.swarm_report, '夹具：createCoreTools 须暴露 swarm_report');
  return { root, store, ctx, report: byName.swarm_report, artifactsRoot, batchId, ownerSession: OWNER, workerSession: WORKER, lane: LANE };
}

/** 调用方 `exec`（`agent.session.id` = 调用方会话；可选 `header.parentSession`）。 */
const execOf = (sessionId, header) => ({ agent: { session: header ? { id: sessionId, header } : { id: sessionId } } });

/** 桩 Leader 句柄（记录 `followup` 入参；零宿主依赖）。 */
function stubLeader() {
  const messages = [];
  return { status: 'idle', messages, followup(msg) { messages.push(msg); this.status = 'running'; } };
}

const reportEventsOf = (store, sessionId, batchId) => (store.readBatch(sessionId, batchId)?.events ?? []).filter((e) => e.type === EVT_SWARM_REPORT);

// ══════════════════════════════════════════════════════════════════════════════
// ① GREEN：handler 被调 ⇒ 唤醒路径被触发（可观测信号 = followup 被调用 + 消息形态）
// ══════════════════════════════════════════════════════════════════════════════
test('① GREEN：swarm_report(blocked) ⇒ wake.woke=true 且 followup 被调用恰 1 次（消息只含元数据）', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const leader = stubLeader();
  const s = stubShard({ agents: { get: (id) => (id === OWNER ? leader : undefined) }, batchId: 'b-green', label: 'green' });

  const before = reportEventsOf(s.store, OWNER, s.batchId).length;
  const r = await s.report.execute({ type: 'blocked', summary: '上游产物缺失', artifactPath: 'exec/e1/out.md', lane: LANE }, execOf(WORKER));
  reading('① GREEN 返回值', r);
  reading('① GREEN followup 次数', leader.messages.length);
  reading('① GREEN 唤醒消息', leader.messages[0] ?? null);

  assert.equal(r.wake.woke, true, '① GREEN：handler 被调 ⇒ 唤醒路径被触发');
  assert.equal(r.wake.attempted, true, '① GREEN：attempted=true（进入唤醒路径）');
  assert.equal(r.wake.reason, 'woke', '① GREEN：reason=woke');
  assert.equal(leader.messages.length, 1, '① GREEN：唯一唤醒动作 followup 被调用恰 1 次');
  assert.equal(r.delivered, true, '① GREEN：既有投递语义不变');
  assert.equal(r.eventWritten, true, '① GREEN：既有留痕语义不变');

  const msg = leader.messages[0];
  assert.equal(msg.role, 'user', '① GREEN：唤醒消息为 user 消息（dsh-llm createUserMessage 形状）');
  assert.ok(Array.isArray(msg.content) && msg.content.length === 1 && msg.content[0].type === 'text',
    '① GREEN：消息体 = 单条 text 块（零工具/推理块）');
  assert.equal(typeof msg.id, 'string', '① GREEN：id 必填（inbox pending 去重）');
  assert.equal(msg.source.kind, 'user', '① GREEN：source.kind=user');
  const text = msg.content[0].text;
  assert.ok(text.startsWith('[swarm] ' + s.batchId + '/' + LANE + ' blocked：'), '① GREEN：消息首行 = 元数据摘要前缀');
  assert.ok(text.includes('产物：exec/e1/out.md'), '① GREEN：artifactPath 在场时以「产物：」行追加');
  assert.equal(reportEventsOf(s.store, OWNER, s.batchId).length, before + 1, '① GREEN：批事件恰 +1（无自增）');
});

test('① GREEN：命中「服务在但取不到 live 句柄」⇒ leader-not-live（不唤醒、不抛）', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const s = stubShard({ agents: { get: () => undefined }, batchId: 'b-notlive', label: 'notlive' });
  const r = await s.report.execute({ type: 'blocked', summary: 'x', lane: LANE }, execOf(WORKER));
  reading('① 无 live 句柄', r.wake);
  assert.equal(r.wake.attempted, true, '服务可用 ⇒ attempted=true');
  assert.equal(r.wake.woke, false, '取不到句柄 ⇒ 不唤醒');
  assert.equal(r.wake.reason, 'leader-not-live', '降级码 = leader-not-live（与 service-unavailable 分开）');
});

// ══════════════════════════════════════════════════════════════════════════════
// ② RED①：不调 handler ⇒ 不唤醒；触发集外 ⇒ 亦不唤醒
// ══════════════════════════════════════════════════════════════════════════════
test('② RED①：不调 handler ⇒ 零 followup（阴性基线，证 GREEN 非空转）', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const leader = stubLeader();
  const s = stubShard({ agents: { get: () => leader }, batchId: 'b-red1', label: 'red1' });
  await new Promise((res) => setTimeout(res, 300)); // 观测窗
  reading('② RED① 观测窗内', { followupCalls: leader.messages.length, leaderStatus: leader.status, events: reportEventsOf(s.store, OWNER, s.batchId).length });

  assert.equal(leader.messages.length, 0, '② RED①：不调 handler ⇒ 零唤醒（观测窗内 followup 未被调用）');
  assert.equal(leader.status, 'idle', '② RED①：不调 handler ⇒ Leader 保持 idle');
  assert.equal(reportEventsOf(s.store, OWNER, s.batchId).length, 0, '② RED①：不调 handler ⇒ 零批事件（基线干净）');
});

test('② RED①（G-2）：触发集外 type=progress ⇒ 不唤醒，但留痕面不变', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const leader = stubLeader();
  const s = stubShard({ agents: { get: () => leader }, batchId: 'b-progress', label: 'progress' });
  const r = await s.report.execute({ type: 'progress', summary: '进度 50%', lane: LANE }, execOf(WORKER));
  reading('② RED① progress', r);
  assert.equal(r.wake.attempted, false, '② progress：未进入唤醒路径');
  assert.equal(r.wake.woke, false, '② progress：不唤醒');
  assert.equal(r.wake.reason, 'type-not-in-wake-set', '② progress：reason=type-not-in-wake-set（触发集 = {blocked,settle-request}）');
  assert.equal(leader.messages.length, 0, '② progress：零 followup');
  assert.equal(r.delivered, true, '② progress：留痕面不变（progress 高频，保持「留痕不打扰」）');
  assert.equal(r.eventWritten, true, '② progress：事件照落');
});

test('② 触发集自证：settle-request 在唤醒集内（与 blocked 同集）', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const leader = stubLeader();
  const s = stubShard({ agents: { get: () => leader }, batchId: 'b-settle-wake', label: 'settlewake' });
  const r = await s.report.execute({ type: 'settle-request', summary: '交付', lane: LANE }, execOf(WORKER));
  reading('② settle-request 唤醒读数', { wake: r.wake, settle: r.settle ?? null, followupCalls: leader.messages.length });
  assert.equal(r.wake.attempted, true, 'settle-request 属唤醒触发集（attempted=true）');
  assert.notEqual(r.wake.reason, 'type-not-in-wake-set', 'settle-request 不被触发集拦下');
  assert.equal(leader.messages.length >= 1, true, 'settle-request ⇒ 走唤醒路径（followup 被调用）');
});

// ══════════════════════════════════════════════════════════════════════════════
// ③ RED②：ctx.get('agents') 缺失 ⇒ 不抛 + fail-safe 降级
// ══════════════════════════════════════════════════════════════════════════════
test('③ RED②-a：服务未挂（ctx.get("agents") 返回 undefined）⇒ 不抛、reason=service-unavailable、留痕不变', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const s = stubShard({ agents: undefined, batchId: 'b-red2a', label: 'red2a' });
  const before = reportEventsOf(s.store, OWNER, s.batchId).length;
  let thrown = null;
  let r = null;
  try {
    r = await s.report.execute({ type: 'blocked', summary: '服务缺失构造', lane: LANE }, execOf(WORKER));
  } catch (e) { thrown = String(e?.message ?? e); }
  reading('③ RED②-a', { thrown, wake: r?.wake, delivered: r?.delivered, eventWritten: r?.eventWritten });

  assert.equal(thrown, null, '③ RED②：handler 不得抛（fail-safe 硬约束）');
  assert.equal(r.wake.attempted, true, '③ RED②：服务缺失发生在 attempted 之后（窗口/句柄判定序不变）');
  assert.equal(r.wake.woke, false, '③ RED②：服务缺失 ⇒ 不唤醒');
  assert.equal(r.wake.reason, 'service-unavailable', '③ RED②：降级码 = service-unavailable（实现 D-1，G-3 优先于规格骨架同码）');
  assert.equal(r.delivered, true, '③ RED②：既有投递不受影响（与改前逐字一致）');
  assert.equal(r.eventWritten, true, '③ RED②：既有留痕不受影响');
  assert.equal(reportEventsOf(s.store, OWNER, s.batchId).length, before + 1, '③ RED②：事件照落（唤醒失败不损留痕）');
});

test('③ RED②-b：ctx 连 get 方法都没有（宿主形态差异）⇒ 同样降级、不抛', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const s = stubShard({ agents: undefined, batchId: 'b-red2b', label: 'red2b' });
  s.ctx.get = undefined; // 非注入读前置判定：typeof ctx.get !== 'function' ⇒ svc=null
  let thrown = null;
  let r = null;
  try {
    r = await s.report.execute({ type: 'blocked', summary: 'ctx 无 get', lane: LANE }, execOf(WORKER));
  } catch (e) { thrown = String(e?.message ?? e); }
  reading('③ RED②-b', { thrown, wake: r?.wake });
  assert.equal(thrown, null, '③ RED②-b：ctx 无 get ⇒ 不得抛');
  assert.equal(r.wake.reason, 'service-unavailable', '③ RED②-b：同一降级码面');
  assert.equal(r.wake.woke, false, '③ RED②-b：不唤醒');
});

test('③ RED②-c：ctx.get("agents") 自身抛错 ⇒ 不抛（catch 收敛）、降级 service-unavailable', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const s = stubShard({ agents: undefined, batchId: 'b-red2c', label: 'red2c' });
  s.ctx.get = () => { throw new Error('BOOM-ctx-get'); };
  let thrown = null;
  let r = null;
  try {
    r = await s.report.execute({ type: 'blocked', summary: 'get 抛错', lane: LANE }, execOf(WORKER));
  } catch (e) { thrown = String(e?.message ?? e); }
  reading('③ RED②-c', { thrown, wake: r?.wake });
  assert.equal(thrown, null, '③ RED②-c：ctx.get 抛错须被 leaderAgentOf 吞掉（永不抛）');
  assert.equal(r.wake.reason, 'service-unavailable', '③ RED②-c：收敛为同一降级码');
});

// ══════════════════════════════════════════════════════════════════════════════
// ④ 节流 / 合并：N 次连续 report ⇒ 唤醒次数 ≤ 上限（给数值与依据）
// ══════════════════════════════════════════════════════════════════════════════
test('④ 窗内连发 N=10 条 ⇒ 唤醒恰 1 次（上限 ⌈跨度/W⌉+1=1，与 N 解耦）', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const leader = stubLeader();
  const s = stubShard({ agents: { get: (id) => (id === OWNER ? leader : undefined) }, batchId: 'b-throttle', label: 'throttle' });

  const N = 10;
  const wakes = [];
  for (let i = 0; i < N; i += 1) {
    // eslint-disable-next-line no-await-in-loop —— 连发须串行（同一窗内的真实时序）
    const r = await s.report.execute({ type: 'blocked', summary: '窗内 #' + i, lane: LANE }, execOf(WORKER));
    wakes.push(r.wake);
  }
  const wokeCount = wakes.filter((w) => w.woke).length;
  const throttled = wakes.filter((w) => w.reason === 'throttled');
  const spanMs = 0; // 真实时钟窗：N 条在 <W 内完成 ⇒ 上限 = ⌈0/W⌉+1 = 1
  reading('④ 窗内 N=10 唤醒读数', wakes);
  reading('④ 汇总', { N, wokeCount, throttledCount: throttled.length, followupCalls: leader.messages.length, spanMs, upperBound: 1 });

  assert.equal(wokeCount, 1, '④：N=10 次连续 report ⇒ 唤醒次数恰 1');
  assert.equal(leader.messages.length, 1, '④：followup 总调用次数 = 1（≠ N）');
  assert.equal(throttled.length, N - 1, '④：其余 ' + (N - 1) + ' 条 = throttled');
  assert.deepEqual(throttled.map((w) => w.merged), Array.from({ length: N - 1 }, (_, i) => i + 1),
    '④：合并计数逐条累加 1…' + (N - 1) + '（合并不丢信息，可核）');
  assert.ok(wokeCount <= Math.ceil(spanMs / WAKE_MIN_INTERVAL_MS) + 1, '④：唤醒次数 ≤ ⌈跨度/W⌉+1（上限与报告条数解耦）');
  assert.equal(WAKE_MIN_INTERVAL_MS, 30_000, '④：窗常量 = 30s（实现单点定义，禁第二套口径）');
});

test('④ 跨窗（now 注入）：累计 2 次唤醒 + 第 2 次消息携带合并计数（与 N 解耦）', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const leader = stubLeader();
  const ctx = { get: () => ({ get: () => leader }) };
  const base = { callerSessionId: WORKER, leaderSessionId: OWNER, batchId: 'b-cross', lane: LANE, type: 'blocked', summary: 'S' };

  const seq = [
    { now: 0, expect: 'woke' },
    { now: 1_000, expect: 'throttled' },
    { now: 2_000, expect: 'throttled' },
    { now: WAKE_MIN_INTERVAL_MS + 1, expect: 'woke' },
  ];
  const out = seq.map(({ now }) => wakeLeaderForReport(ctx, { ...base, now }));
  reading('④ 跨窗序列读数', out);
  const wokeCount = out.filter((w) => w.woke).length;
  const spanMs = seq.at(-1).now;
  reading('④ 跨窗汇总', { wokeCount, spanMs, upperBound: Math.ceil(spanMs / WAKE_MIN_INTERVAL_MS) + 1, followupCalls: leader.messages.length });

  assert.deepEqual(out.map((w) => w.reason), seq.map((s) => s.expect), '④ 跨窗：woke/throttled 序列与 now 序列一致（leading-edge）');
  assert.equal(wokeCount, 2, '④ 跨窗：累计唤醒 = 2（4 条报告 ⇒ 2 次，仍与条数解耦）');
  assert.ok(wokeCount <= Math.ceil(spanMs / WAKE_MIN_INTERVAL_MS) + 1, '④ 跨窗：≤ 上限 2');
  assert.equal(leader.messages.length, 2, '④ 跨窗：followup 总次数 = 2');
  assert.equal(out.at(-1).merged, 2, '④ 跨窗：第 2 次唤醒回显「另合并 2 条」');
  assert.ok(leader.messages.at(-1).content[0].text.includes('（另合并 2 条同类回报）'),
    '④ 跨窗：被合并条数随下次唤醒**可见**（消息文本含合并计数）');
  assert.notEqual(leader.messages[0].id, leader.messages[1].id, '④ 跨窗：两条唤醒消息 id 不同（inbox pending 去重前提）');
});

test('④ 窗键隔离：同 Leader 不同 batchId 各自独立成窗（键 = leader\\0batch）', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const leader = stubLeader();
  const ctx = { get: () => ({ get: () => leader }) };
  const common = { callerSessionId: WORKER, leaderSessionId: OWNER, lane: LANE, type: 'blocked', summary: 'S' };
  const a = wakeLeaderForReport(ctx, { ...common, batchId: 'b-A', now: 0 });
  const b = wakeLeaderForReport(ctx, { ...common, batchId: 'b-B', now: 1_000 });
  const a2 = wakeLeaderForReport(ctx, { ...common, batchId: 'b-A', now: 2_000 });
  reading('④ 窗键隔离', { a, b, a2, followupCalls: leader.messages.length });
  assert.equal(a.woke, true, '④ 窗键：A 批首报唤醒');
  assert.equal(b.woke, true, '④ 窗键：B 批同刻**不受 A 窗抑制**（键含 batchId）');
  assert.equal(a2.reason, 'throttled', '④ 窗键：A 批第 2 条仍被自己的窗节流');
});

test('④ 失败不重置窗（实现 D-3）：唤起失败既不开新窗、也不清零已累计的合并计数', async () => {
  const leader = stubLeader();
  const okCtx = { get: () => ({ get: () => leader }) };
  const badCtx = { get: () => undefined };
  const common = { callerSessionId: WORKER, leaderSessionId: OWNER, batchId: 'b-fail-win', lane: LANE, type: 'blocked', summary: 'S' };

  // (a) 无窗时失败 ⇒ 不得「开一个窗」把随后 30s 内的成功唤醒压掉
  LEADER_WAKE_WINDOWS.clear();
  const fail1 = wakeLeaderForReport(badCtx, { ...common, now: 0 });
  const windowsAfterFail = [...LEADER_WAKE_WINDOWS.entries()]; // ⚠ 须在 ok1 之前读：ok1 成功会自己开窗
  const ok1 = wakeLeaderForReport(okCtx, { ...common, now: 1_000 });
  reading('④ D-3(a) 失败不开窗', { fail1, windowsAfterFail, ok1, windowsAfterOk: [...LEADER_WAKE_WINDOWS.entries()] });
  assert.equal(fail1.reason, 'service-unavailable', '④ D-3(a)：服务缺失 ⇒ 失败读数');
  assert.deepEqual(windowsAfterFail, [], '④ D-3(a)：失败不写窗（失败后窗集合仍为空）');
  assert.equal(ok1.woke, true, '④ D-3(a)：失败未开窗 ⇒ 随后的成功唤醒不被抑制（无 30s 级静默）');

  // (b) 窗过期后失败 ⇒ 不得清零已累计的 merged（合并不丢信息）
  LEADER_WAKE_WINDOWS.clear();
  const t0 = wakeLeaderForReport(okCtx, { ...common, now: 0 });
  const t1 = wakeLeaderForReport(okCtx, { ...common, now: 1_000 });
  const t2 = wakeLeaderForReport(okCtx, { ...common, now: 2_000 });
  const fail2 = wakeLeaderForReport(badCtx, { ...common, now: WAKE_MIN_INTERVAL_MS + 1 });
  const ok2 = wakeLeaderForReport(okCtx, { ...common, now: WAKE_MIN_INTERVAL_MS + 2 });
  reading('④ D-3(b) 失败不清零计数', { t0, t1, t2, fail2, ok2 });
  assert.deepEqual([t0.reason, t1.reason, t2.reason], ['woke', 'throttled', 'throttled'], '④ D-3(b) 前置：1 唤醒 + 2 合并');
  assert.equal(fail2.reason, 'service-unavailable', '④ D-3(b)：窗过期后的失败读数（此调用不写窗）');
  assert.equal(ok2.woke, true, '④ D-3(b)：随后的成功唤醒生效');
  assert.equal(ok2.merged, 2, '④ D-3(b)：失败未清零 merged ⇒ 第 2 次唤醒仍如实回显「另合并 2 条」');
});

// ══════════════════════════════════════════════════════════════════════════════
// ⑤ 防自激：self 闸 + 零回环 + 唤醒路径零批面写
// ══════════════════════════════════════════════════════════════════════════════
test('⑤ 防自激-a（可达构造）：caller === leader（session.header 无 parentSession）⇒ reason=self、零 followup', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const leader = stubLeader();
  const s = stubShard({ agents: { get: (id) => (id === OWNER ? leader : undefined) }, batchId: 'b-self', label: 'self' });

  // 可达构造（规格 §4.1）：无 `member.dispatch` 绑定 + `session.header` 无 `parentSession`
  //   ⇒ `reportTargetOf` 的 `sessionId = header.parentSession ?? caller` 恰等于 caller 自身。
  const r = await s.report.execute({ type: 'blocked', summary: '自激构造', lane: LANE }, execOf(OWNER));
  reading('⑤ self 闸', { wake: r.wake, followupCalls: leader.messages.length, leaderStatus: leader.status });

  assert.equal(r.unbound, true, '⑤ 可达构造成立：无绑定 ⇒ 走未绑定分支');
  assert.equal(r.wake.attempted, false, '⑤ self 闸在 attempted 之前生效（不进入唤醒路径）');
  assert.equal(r.wake.woke, false, '⑤ caller===leader ⇒ 不唤醒');
  assert.equal(r.wake.reason, 'self', '⑤ reason=self');
  assert.equal(leader.messages.length, 0, '⑤ 零 followup（唤醒自己的路径被闸拦）');
  assert.equal(leader.status, 'idle', '⑤ Leader 保持 idle（无自激轮回）');
});

test('⑤ 零回环：连发 N=5 次 report ⇒ 批事件恰 = N（唤醒路径不自产生触发源）', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const leader = stubLeader();
  const s = stubShard({ agents: { get: () => leader }, batchId: 'b-loop', label: 'loop' });
  const before = reportEventsOf(s.store, OWNER, s.batchId).length;
  const N = 5;
  for (let i = 0; i < N; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await s.report.execute({ type: 'blocked', summary: '回环探针 #' + i, lane: LANE }, execOf(WORKER));
  }
  const after = reportEventsOf(s.store, OWNER, s.batchId).length;
  reading('⑤ 零回环读数', { N, before, after, delta: after - before, followupCalls: leader.messages.length });

  assert.equal(after - before, N, '⑤：N 次 report ⇒ EVT_SWARM_REPORT 恰 +N（≠ N+K，无自增/回环）');
  assert.equal(leader.messages.length, 1, '⑤：同一窗内 followup ≤ 1（唤醒本身不放大报告量）');
});

test('⑤ 唤醒路径零批面写：直接调 wakeLeaderForReport ⇒ 批事件增量 = 0', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const leader = stubLeader();
  const s = stubShard({ agents: { get: () => leader }, batchId: 'b-zerowrite', label: 'zerowrite' });
  const before = (s.store.readBatch(OWNER, s.batchId)?.events ?? []).length;

  const w = wakeLeaderForReport(s.ctx, {
    callerSessionId: WORKER, leaderSessionId: OWNER, batchId: s.batchId, lane: LANE,
    type: 'blocked', summary: '零批面写构造',
  });
  const after = (s.store.readBatch(OWNER, s.batchId)?.events ?? []).length;
  reading('⑤ 零批面写读数', { wake: w, eventsBefore: before, eventsAfter: after, followupCalls: leader.messages.length });

  assert.equal(w.woke, true, '⑤ 前置：唤醒成功（确有 followup 发生）');
  assert.equal(after - before, 0, '⑤：唤醒路径零批面写（不调 appendEvent / 不调 swarm_report ⇒ 不构成新触发源）');
  assert.equal(leader.messages.length, 1, '⑤：唤醒动作只有 followup 一处');
});

// ══════════════════════════════════════════════════════════════════════════════
// ⑥ 不回归：留痕先于唤醒 / 唤醒失败不损留痕 / 幂等
// ══════════════════════════════════════════════════════════════════════════════
test('⑥ 留痕先于唤醒：调用次序 = [appendEvent, followup]（次序可观测）', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const order = [];
  const leader = { status: 'idle', followup() { order.push('wake'); } };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-notify-order-'));
  const realStore = createStore(root);
  seedBatch(realStore, root, { batchId: 'b-order' });
  // 次序探针：包装真 store 的 appendEvent（不改变语义，只追加观测）
  const store = Object.create(realStore);
  store.appendEvent = (...args) => { order.push('event'); return realStore.appendEvent(...args); };

  const ctx = { on() { return () => {}; }, tools: { register() {} }, logger: { info() {}, warn() {}, error() {}, debug() {} }, get: () => ({ get: () => leader }) };
  const report = Object.fromEntries(createCoreTools(ctx, { store, root, config: {} }).map((t) => [t.name, t])).swarm_report;

  const r = await report.execute({ type: 'blocked', summary: '次序探针', lane: LANE }, execOf(WORKER));
  reading('⑥ 次序读数', { order, wake: r.wake, delivered: r.delivered, eventWritten: r.eventWritten });

  assert.deepEqual(order, ['event', 'wake'], '⑥：留痕（appendEvent）先于唤醒（followup）——次序逐字可核');
  assert.equal(r.eventWritten, true, '⑥：事件面成立');
  assert.equal(r.wake.woke, true, '⑥：唤醒面亦成立（两者在一次调用内并存）');
});

test('⑥ 唤醒失败不损留痕：followup 抛错 ⇒ handler 不抛、delivered/eventWritten 仍为 true', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const leader = { status: 'idle', followup() { throw new Error('BOOM-followup'); } };
  const s = stubShard({ agents: { get: () => leader }, batchId: 'b-wakefail', label: 'wakefail' });
  const before = reportEventsOf(s.store, OWNER, s.batchId).length;

  let thrown = null;
  let r = null;
  try {
    r = await s.report.execute({ type: 'blocked', summary: '唤醒抛错', lane: LANE }, execOf(WORKER));
  } catch (e) { thrown = String(e?.message ?? e); }
  reading('⑥ 唤醒抛错读数', { thrown, wake: r?.wake, delivered: r?.delivered, eventWritten: r?.eventWritten });

  assert.equal(thrown, null, '⑥：唤醒抛错不得外溢到 handler（fail-safe 硬约束）');
  assert.equal(r.wake.woke, false, '⑥：唤醒失败 ⇒ woke=false');
  assert.equal(r.wake.reason.startsWith('error: '), true, '⑥：reason 收敛为 error: （异常已隔离）');
  assert.equal(r.delivered, true, '⑥：消息投递事实不受损');
  assert.equal(r.eventWritten, true, '⑥：批次事件照落（留痕先于唤醒 + 失败不回溯）');
  assert.equal(reportEventsOf(s.store, OWNER, s.batchId).length, before + 1, '⑥：事件恰 +1');
});

test('⑥ 幂等：同一窗内第 2…N 条不产生第二条唤醒（followup 次数不随条数增长）', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const leader = stubLeader();
  const s = stubShard({ agents: { get: () => leader }, batchId: 'b-idem', label: 'idem' });
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await s.report.execute({ type: 'blocked', summary: '幂等 #' + i, lane: LANE }, execOf(WORKER));
  }
  reading('⑥ 幂等读数', { followupCalls: leader.messages.length, ids: leader.messages.map((m) => m.id) });
  assert.equal(leader.messages.length, 1, '⑥：窗内 3 条 ⇒ 唤醒恰 1 条（幂等：同一事实不重复生效）');
  assert.equal(new Set(leader.messages.map((m) => m.id)).size, leader.messages.length, '⑥：唤醒消息 id 互不相同');
});

test('⑥ 不回归：未绑定且未自报 batchId ⇒ 仍 best-effort 放行（Q-G2 语义逐字不变）', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const leader = stubLeader();
  const s = stubShard({ agents: { get: () => leader }, batchId: 'b-unbound', label: 'unbound' });
  const r = await s.report.execute({ type: 'blocked', summary: '孤儿会话', lane: LANE }, execOf('sess-orphan'));
  reading('⑥ 未绑定放行读数', r);
  assert.equal(r.delivered, true, '⑥：未绑定仍投递（不再因身份未绑定而拒）');
  assert.equal(r.unbound, true, '⑥：如实回显 unbound:true');
  assert.equal(r.eventWritten, false, '⑥：无批次可解析 ⇒ 事件未落（如实回显，不静默）');
  assert.equal(r.batchId, '(unbound)', '⑥：批次占位 (unbound) 可读');
  assert.equal(r.wake.woke, false, '⑥：无 Leader 会话可解析 ⇒ 不唤醒');
  // 结构事实（规格 §4.1 的可达构造在此亦成立）：未绑定且 `session.header` 无 `parentSession`
  //   ⇒ `tgt.sessionId` 退化为 caller 自身 ⇒ 被 `self` 闸拦下。此处是「孤儿会话」形态下的同一闸面。
  assert.equal(r.wake.reason, 'self', '⑥：未绑定 + 无 parentSession ⇒ sessionId 退化 = caller ⇒ self 闸生效（零误唤醒）');
});

// ══════════════════════════════════════════════════════════════════════════════
// ⑦ 宿主分片端到端：真 Agent 的 status idle→running / turn/start / user/message
//    （判据源 G-1 / G-2；不可用时整组 skip —— 其余六组无条件执行，判据不静默失效）
// ══════════════════════════════════════════════════════════════════════════════
async function mountHostShard({ withAgents, store, root }) {
  const { Context } = await loadHost('cordis');
  const Sessions = (await loadHost('dsh-session')).default;
  const LlmMod = await loadHost('dsh-llm');
  const Tools = (await loadHost('dsh-tools')).default;
  const SysPrompt = (await loadHost('dsh-system-prompt')).default;
  const Proj = (await loadHost('dsh-session-projection')).default;

  const app = new Context();
  await app.plugin(Sessions, {});
  await app.plugin(Proj, {});
  await app.plugin(LlmMod.default, {});
  await app.plugin(Tools, { mode: 'native' });
  await app.plugin(SysPrompt, {});
  if (withAgents) {
    const Agents = (await loadHost('dsh-agent')).default;
    await app.plugin(Agents, {});
    const AgentLoop = (await loadHost('dsh-agent-loop')).default;
    await app.plugin(AgentLoop, { maxParallelToolCalls: 10, agents: [] });
  }
  // onto 真工具经**独立 fiber**注册：`inject` 不含 `agents`（复刻 lib/index.js:86 注入面）
  //   ⇒ handler 必须走 `ctx.get('agents')` 非注入读（这正是被测判据面）。
  await app.plugin({
    name: 'onto-notify-wake-under-test',
    inject: ['tools'],
    apply(ctx) {
      for (const t of createCoreTools(ctx, { store, root, config: {} })) ctx.tools.register(t);
    },
  }, {});
  return { app, LlmMod, defineTool: (await loadHost('dsh-tools')).defineTool };
}

/** 可控 LLM：每轮流被外部 release 阻塞 ⇒ 可稳定观测「唤醒是否开了新轮」。 */
function installBlockingLlm(LlmMod, app, held) {
  class BlockingAdapter extends LlmMod.LlmAdapter {
    stream() {
      const release = Promise.withResolvers();
      held.push(release);
      return (async function* () {
        await release.promise;
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'ok' };
        yield { type: 'finish', reason: 'stop' };
      })();
    }
  }
  app.llm.registerAdapter(['notifywake'], new BlockingAdapter());
}

const settleAll = (held) => { held.forEach((r) => r.resolve()); held.length = 0; };
async function drain(agentsList, held, budgetMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    settleAll(held);
    if (agentsList.every((a) => a.status === 'idle')) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 20));
  }
  return agentsList.every((a) => a.status === 'idle');
}

test('⑦ 宿主分片端到端（真 Agent）', { skip: HOST_SKIP && HOST_SKIP_REASON, concurrency: false }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-notify-host-'));
  const store = createStore(root);
  const BATCH = 'b-host';
  const SENTINEL = 'WORKER_BODY_SENTINEL_MUST_NOT_APPEAR_IN_WAKE_MSG';
  const artifactsRoot = seedBatch(store, root, { batchId: BATCH });
  fs.writeFileSync(path.join(artifactsRoot, 'plan', 'worker-body.md'), SENTINEL, 'utf8');

  const { app, LlmMod } = await mountHostShard({ withAgents: true, store, root });
  const held = [];
  installBlockingLlm(LlmMod, app, held);

  const leaderHandle = await app.agents.create({ sessionId: OWNER, agentOptions: { provider: 'notifywake', model: 'notifywake-model' } });
  const leader = leaderHandle.agent;
  const callerHandle = await app.agents.create({ sessionId: WORKER, agentOptions: { provider: 'notifywake', model: 'notifywake-model' } });
  const statusTrail = [];
  leader.ctx.on('agent/status', (p) => statusTrail.push(p?.status ?? null));

  const turnStarts = () => leader.session.snapshotEvents().filter((e) => e.type === 'turn/start').length;
  const userMsgs = () => leader.session.snapshotEvents().filter((e) => e.type === 'user/message');
  const execReport = (args, agent, callId) => app.tools.execute({
    name: 'swarm_report', arguments: args, callId, signal: new AbortController().signal, agent,
  });

  reading('⑦ 宿主分片装配', { hostRoot: HOST_ROOT, agentsService: typeof app.get('agents'), leaderRegistered: app.agents.get(OWNER) === leader, leaderStatus: leader.status });
  assert.equal(app.agents.get(OWNER), leader, '⑦ 前置：Leader 已登记为 live Agent');
  assert.equal(leader.status, 'idle', '⑦ 前置：Leader 初始 idle');

  // ── ① 阴性基线：不调 handler ⇒ 不唤醒 ────────────────────────────────────────
  LEADER_WAKE_WINDOWS.clear();
  await new Promise((r) => setTimeout(r, 300));
  const baseTurn = turnStarts();
  const baseMsg = userMsgs().length;
  reading('⑦ RED① 不调 handler（300ms 观测窗）', { status: leader.status, turnStarts: baseTurn, userMessages: baseMsg, llmCalls: held.length });
  assert.equal(leader.status, 'idle', '⑦ RED①：不调 handler ⇒ Leader 仍 idle');
  assert.equal(baseTurn, 0, '⑦ RED①：零 turn/start');
  assert.equal(baseMsg, 0, '⑦ RED①：零 user/message');
  assert.equal(held.length, 0, '⑦ RED①：零 LLM 轮');

  // ── ② 触发集外 progress ⇒ 不唤醒（G-2） ─────────────────────────────────────
  const prog = await execReport({ type: 'progress', summary: '进度', lane: LANE }, callerHandle.agent, 'host-prog');
  await new Promise((r) => setTimeout(r, 300));
  reading('⑦ RED①-b progress', { isError: prog.isError, wake: prog.value.wake, statusAfterWindow: leader.status, turnStarts: turnStarts(), llmCalls: held.length });
  assert.equal(prog.isError, false, '⑦ progress：工具面无错');
  assert.equal(prog.value.wake.reason, 'type-not-in-wake-set', '⑦ progress：触发集外');
  assert.equal(leader.status, 'idle', '⑦ progress：Leader 保持 idle');
  assert.equal(turnStarts(), 0, '⑦ progress：turn/start Δ=0');
  assert.equal(held.length, 0, '⑦ progress：零 LLM 轮');

  // ── ③ 防自激（真 Agent 版）：caller === leader ⇒ 不唤醒 ──────────────────────
  LEADER_WAKE_WINDOWS.clear();
  const selfRes = await execReport({ type: 'blocked', summary: '自激构造', lane: LANE }, leader, 'host-self');
  await new Promise((r) => setTimeout(r, 300));
  reading('⑦ 防自激（真 Agent）', { wake: selfRes.value.wake, status: leader.status, turnStarts: turnStarts(), llmCalls: held.length });
  assert.equal(selfRes.value.wake.reason, 'self', '⑦ 防自激：caller===leader ⇒ reason=self（真 Agent 路径同判）');
  assert.equal(turnStarts(), 0, '⑦ 防自激：turn/start Δ=0');
  assert.equal(held.length, 0, '⑦ 防自激：零 LLM 轮');

  // ── ④ GREEN：真 Agent idle→running（可观测信号） ─────────────────────────────
  LEADER_WAKE_WINDOWS.clear();
  const turnBefore = turnStarts();
  const msgBefore = userMsgs().length;
  const green = await execReport({ type: 'blocked', summary: '上游阻塞', artifactPath: 'plan/worker-body.md', lane: LANE }, callerHandle.agent, 'host-green');
  const opened = await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 4_000) { if (held.length >= 1) return true; await new Promise((r) => setTimeout(r, 20)); } return false; })();
  const wakeEvt = userMsgs().at(-1);
  const wakeText = wakeEvt ? (wakeEvt.data?.content ?? []).map((b) => b.text ?? '').join('') : '';
  reading('⑦ GREEN（真 Agent）', {
    isError: green.isError, wake: green.value.wake, statusSynchronously: leader.status,
    opened, turnStarts: turnStarts(), userMessages: userMsgs().length, llmCalls: held.length,
    wakeMessageText: wakeText, statusTrail: [...statusTrail],
  });

  assert.equal(green.isError, false, '⑦ GREEN：真 ToolRuntime 不判错（`wake` 键已在 output.schema 同改）');
  assert.equal(green.value.wake.woke, true, '⑦ GREEN：handler 被调 ⇒ 唤醒路径被触发');
  assert.equal(opened, true, '⑦ GREEN：观测到 Leader 开了新 turn（LLM 轮已发起）');
  assert.equal(turnStarts(), turnBefore + 1, '⑦ GREEN：会话 turn/start Δ=+1');
  assert.equal(userMsgs().length, msgBefore + 1, '⑦ GREEN：会话 user/message Δ=+1（唤醒留痕）');
  assert.ok([...statusTrail].includes('running'), '⑦ GREEN：agent/status 观测到 running');
  assert.ok(wakeText.startsWith('[swarm] ' + BATCH + '/' + LANE + ' blocked：'), '⑦ GREEN：唤醒消息文本 = 元数据摘要');
  assert.equal(wakeText.includes(SENTINEL), false, '⑦ G-11：消息**零复制 worker 产物正文**（哨兵在产物文件内，不得进消息）');
  assert.equal(wakeText.includes('产物：plan/worker-body.md'), true, '⑦ G-11：artifactPath 属允许元数据（以「产物：」行给出）');

  reading('⑦ GREEN 收尾前读数', { turnStarts: turnStarts(), userMessages: userMsgs().length, wakeText });
  assert.equal(await drain([leader], held), true, '⑦ 收尾：GREEN 的轮跑完回到 idle（后续组基线干净）');
  reading('⑦ GREEN 收尾', { status: leader.status, turnStarts: turnStarts(), llmCalls: held.length });

  // ── ⑤ 窗内节流（真 Agent 版）：N=10 ⇒ 唤醒 1 次、turn/start +1 ───────────────
  LEADER_WAKE_WINDOWS.clear();
  const beforeTurn = turnStarts();
  const beforeCalls = held.length;
  const wakes = [];
  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await execReport({ type: 'blocked', summary: '窗内 #' + i, lane: LANE }, callerHandle.agent, 'host-w' + i);
    wakes.push(r.value.wake);
  }
  await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 4_000) { if (held.length > beforeCalls) return; await new Promise((r) => setTimeout(r, 20)); } })();
  reading('⑦ 窗内 N=10（真 Agent）', {
    wakes, wokeCount: wakes.filter((w) => w.woke).length,
    turnStartsDelta: turnStarts() - beforeTurn, llmTurnsDelta: held.length - beforeCalls,
  });
  assert.equal(wakes.filter((w) => w.woke).length, 1, '⑦ 节流：N=10 ⇒ 唤醒恰 1 次（真 Agent 路径同判）');
  assert.equal(turnStarts() - beforeTurn, 1, '⑦ 节流：Leader turn/start 仅 +1（N 报 ≠ N 轮）');
  assert.equal(held.length - beforeCalls, 1, '⑦ 节流：LLM 轮仅 +1');

  // ── ⑥ 无回环：批事件计数 = 绑定路 handler 调用次数 ───────────────────────────
  const evtCount = reportEventsOf(store, OWNER, BATCH).length;
  reading('⑦ 批事件计数', { evtCount, boundCallsExpected: 1 /*progress*/ + 1 /*GREEN*/ + 10 /*throttle*/ });
  assert.equal(evtCount, 12, '⑦ 无回环：绑定路 12 次 handler ⇒ EVT_SWARM_REPORT 恰 12（无自增）');

  // ── ⑦ 生产形态：lane worker **自身 running** 时回报（`swarm_report` 的真实调用时序） ──
  assert.equal(await drain([leader], held), true, '⑦ 前置：Leader 回 idle（窗可再开）');
  LEADER_WAKE_WINDOWS.clear();
  const waitFor = async (pred, budgetMs = 4_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < budgetMs) {
      if (pred()) return true;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 20));
    }
    return pred();
  };
  callerHandle.agent.followup(LlmMod.createUserMessage({ content: [{ type: 'text', text: 'worker 轮（seed）' }], source: { kind: 'user' } }));
  const callerRunning = await waitFor(() => callerHandle.agent.status === 'running');
  const midTurn = await execReport({ type: 'blocked', summary: 'worker mid-turn 回报', lane: LANE }, callerHandle.agent, 'host-midturn');
  reading('⑦ 生产形态（调用方 running）', {
    callerRunning, callerStatus: callerHandle.agent.status, batchId: midTurn.value.batchId,
    unbound: midTurn.value.unbound, wake: midTurn.value.wake,
  });
  assert.equal(callerRunning, true, '⑦ 生产形态：worker 确在 running（真实时序 = mid-turn 内调工具）');
  assert.equal(midTurn.value.batchId, BATCH, '⑦ 生产形态：running 期 `exec.agent` 仍解析出绑定 ⇒ 批次/Leader 会话可解析');
  assert.equal(midTurn.value.unbound, false, '⑦ 生产形态：绑定命中（`member.dispatch` 反查不因 caller running 失效）');
  assert.equal(midTurn.value.wake.woke, true, '⑦ 生产形态：running 期回报同样唤醒 Leader');

  assert.equal(await drain([leader, callerHandle.agent], held), true, '⑦ 最终收尾：全部 Agent 回 idle');
});
