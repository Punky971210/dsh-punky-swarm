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

// test/swarm-wake-addressing.test.js —— 批 `lane-wake-mainpath-fix-20261010` / lane `e01-impl`
//   的**常驻进仓回归锁**（判据源 `plan/scope.md` §方案 W-5；验收项 L-AC-1..L-AC-16）。
//
// ── 为什么必须**新增**本文件（判据源 P-5 / R-4 / §约束 6）────────────────────────────────
//   既有三套 wake 夹具（`lane-wake-autodispatch` / `worker-notify-wake` / `s2-prime-wake-probe`）
//   的**批 owner 会话本身就是 live 桩**（`agentsOf(leader)` 恰把批会话键映射到活句柄）
//   ⇒ 「批归属键 ≠ 活 agent 会话」（命名黑板批）这一形态**从未被建模**——这正是缺陷潜伏的根因。
//   本文件**自建**该形态：`store.createBatch(<黑板名>)` 且黑板名**不在**活表内、
//   真 agent 会话**在**活表内；**不修改**任何既有夹具（§约束 6 明令禁止改夹具迁就）。
//
// ── 读数口径 ────────────────────────────────────────────────────────────────────────────
//   · 「唤醒是否发生」= 桩 Leader 的 `followup` **入参条数**（`followup` 是唯一唤醒动作，约束 C-5）。
//   · 「寻址到哪个会话」= `agents` 桩记录的 **lookup 序列**（`ctx.get('agents').get(id)` 的实参）。
//     这是本文件**唯一**能直接观测寻址值的面：唤醒单点丢弃返回值（`lib/index.js` 只 `wakeLeaderForReport(...)`
//     不接返回值）⇒ `reason='woke'` 与「lookup 命中活句柄 ∧ followup 被调用」在 `wakeLeaderForReport`
//     内**等价**（见该函数 `:194-204`：唯一调用 `followup` 的分支即置 `woke:true, reason:'woke'`）。
//     需要逐字读 `reason` 的用例（T-5 / T-11）改为**直接调 `wakeLeaderForReport`** 取返回值。
//
// ── 读法（本仓纪律，见 `lane-wake-autodispatch.test.js:31-33`）─────────────────────────────
//   只读 `lib/**`、只写 `test/**`；**禁 `npm test`**（build 相位会重写 `lib/*.js`）。跑法：
//     node --import ./test/helpers/isolated-home.preload.mjs \
//          --import file:///<pkg>/test/helpers/host-dep-fallback.mjs --test test/swarm-wake-addressing.test.js
//
// ── 判别力（L-AC-7）──────────────────────────────────────────────────────────────────────
//   T-1 在**改前 HEAD（dd1fbf0）床**上必须失败，且失败点 = **零 `followup`**
//   （改前：`lib/index.js:633` 传 `leaderSessionId: hit.sessionId` = 黑板名 ⇒ `agents.get(黑板名)` = undefined
//   ⇒ `leader-not-live`、静默）。判定力实证读数见 `exec/evidence/`。
//
// ── 新增符号的取用方式 ───────────────────────────────────────────────────────────────────
//   解析单点（`ownerSessionIdOf` / `ownerSessionIdOfExec` / `wakeAddressOf`）经**动态 import** 取用，
//   不用静态具名 import：改前床上这些导出尚不存在，静态具名 import 会让本文件**整体链接失败**
//   （＝环境/语法类失败，L-AC-7 明文不算判别力）⇒ 必须让改前床上的失败落在**断言**上。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply } from '../lib/index.js';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { createCoreTools } from '../lib/tools/core.js';
import { WAKE_MIN_INTERVAL_MS, LEADER_WAKE_WINDOWS, reportTargetOf, wakeLeaderForReport } from '../lib/tools/swarm-comms.js';
import { poolViewOf } from '../lib/tools/task-tools.js';
import { installDispatchRegistration } from '../lib/bridge/dispatch-register.js';
import { __resetLaneHandles } from '../lib/bridge/lane-handle.js';
import { EVT_MEMBER_DISPATCH, EVT_SWARM_REPORT } from '../lib/state/event-types.js';
import { tempRoot, seedArtifacts } from './helpers/gate-fixture.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(PKG, rel), 'utf8');
const reading = (tag, v) => console.log('[wake-addr] ' + tag + ' = ' + JSON.stringify(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 形态常量（命名黑板批 = 本批要建模的缺陷形态）──────────────────────────────────────────
const BOARD = 'punky-wake-board-20261010'; // 批归属键 = **黑板名**（引擎自派批的治理落点）
const LEADER = 'sess-wake-leader';         // **发起派发的 agent 会话**（真 live 桩挂此键）
const PARENT = 'sess-wake-parent';         // 甲路形态下的父会话（`session.header.parentSession`）
const LANE = 'e2';
const WORKER = 'ws-wake-1';

// ══════════════════════════════════════════════════════════════════════════════════════════
// 夹具（**本文件自建**；既有三套夹具一字未改）
// ══════════════════════════════════════════════════════════════════════════════════════════

/** 三层批任务表：p1（plan，owner=真 agent）/ e1（exec，出池候选）/ e2=LANE（exec，在跑，owner=真 agent）/ a1（audit，deps=[e2]）。 */
function boardTasksOf(owner = LEADER) {
  return [
    { id: 'p1', layer: 'plan', role: 'coordinator', cmd: '定规格', produce: ['plan/spec.md'], outputs: ['plan/spec.md'], owner },
    { id: 'e1', layer: 'exec', role: 'coder', cmd: '待派实现', consume: ['plan/spec.md'], outputs: ['exec/e1.md'] },
    { id: LANE, layer: 'exec', role: 'tester', cmd: '在跑验证', consume: ['plan/spec.md'], outputs: ['exec/e2.md'], owner },
    { id: 'a1', layer: 'audit', role: 'supervisor', cmd: '审计', deps: [LANE], consume: ['plan/spec.md', 'exec/e2.md'] },
  ];
}

/** 三层批 + `LANE` 置 running（结算主路要求非终态；唤醒路不读成员态）。产物先于成员态迁移落盘（entry 门）。 */
function seedBoardBatch(store, root, { batchKey, batchId, owner = LEADER }) {
  const plan = buildWavePlan({ batchId, tasks: boardTasksOf(owner) });
  store.createBatch(batchKey, { batchId, wavePlan: plan, phase: 'running' });
  seedArtifacts(root, batchKey, batchId, [LANE]);
  store.setMember(batchKey, batchId, LANE, 'running');
  return plan;
}

/** `member.dispatch` 登记（`hasOwner:false` ⇒ **不写** `ownerSessionId` 键 = 既有登记形态）。 */
function registerDispatch(store, batchKey, batchId, { workerSessionId = WORKER, hasOwner = true, owner = LEADER } = {}) {
  const payload = hasOwner ? { lane: LANE, workerSessionId, ownerSessionId: owner } : { lane: LANE, workerSessionId };
  store.appendEvent(batchKey, batchId, EVT_MEMBER_DISPATCH, payload);
  return payload;
}

/** 装配级 fake ctx（形状对齐既有 wake 套件；`get('agents')` 为**非注入读**面）。 */
function assemblyCtxOf({ agents }) {
  const listeners = new Map();
  const calls = { info: [], warn: [], error: [] };
  const logger = {
    info: (...a) => calls.info.push(a.join(' ')),
    warn: (...a) => calls.warn.push(a.join(' ')),
    error: (...a) => calls.error.push(a.join(' ')),
  };
  return {
    listeners, calls, logger,
    tools: { register() {}, guard: () => () => {} },
    webServer: { register: () => () => {} },
    subagents: { start: async () => ({ id: 'w-stub', result: Promise.resolve({ output: [], stopReason: 'completed' }) }) },
    emit() {},
    get: (name) => (name === 'agents' ? agents : undefined),
    on(event, fn, opts) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add({ fn, opts });
      return () => { for (const e of listeners.get(event) ?? []) if (e.fn === fn) listeners.get(event).delete(e); };
    },
  };
}

/** 桩 Leader 句柄（记录 `followup` 入参；零宿主依赖）。 */
function stubLeader() {
  const messages = [];
  return { status: 'idle', messages, followup(msg) { messages.push(msg); this.status = 'running'; } };
}

/** `agents` 服务桩：记录**寻址查询序列**（唯一可观测的寻址值面）。 */
function agentsStubOf(live) {
  const lookups = [];
  return {
    live, lookups,
    get(id) { lookups.push(id); return Object.prototype.hasOwnProperty.call(live, id) ? live[id] : undefined; },
  };
}

/** 装配一个真 `apply()` 的批次床（真 store + 真插件装配，仅 ctx 为桩）。 */
async function mountOf({ batchId, batchKey = BOARD, agents, label, dispatches = [{ workerSessionId: WORKER }] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-wakeaddr-' + label + '-'));
  const store = createStore(root);
  seedBoardBatch(store, root, { batchKey, batchId });
  for (const d of dispatches) registerDispatch(store, batchKey, batchId, d);
  const ctx = assemblyCtxOf({ agents });
  const disposer = apply(ctx, { root });
  await sleep(60);
  return { root, store, ctx, disposer, batchId, batchKey };
}

const endHooksOf = (ctx) => [...(ctx.listeners.get('subagent/end') ?? [])];
/** 唤醒路 = `hooks[1]`（`hooks[0]` = 结算主路；注册序 `lib/index.js:576` → `:662`，既有套件 `乙-1/乙-2` 同口径）。 */
function wakeHookOf(ctx) {
  const hooks = endHooksOf(ctx);
  assert.equal(hooks.length, 2, '前置：`subagent/end` 面须为两路订阅（结算路 + 唤醒路）');
  return hooks[1];
}
/** 逐个投递（模拟宿主广播；调用面同既有套件 `emitSubagentEnd`）。 */
async function emitAll(ctx, info) {
  for (const { fn } of endHooksOf(ctx)) await fn(info);
}
const endInfoOf = (id, stopReason = 'completed') => ({ runId: 'run-' + id, provider: 'spawn', id, local: false, stopReason });
const eventsOf = (m) => (m.store.readBatch(m.batchKey, m.batchId)?.events ?? []);
const batchFileOf = (root, sessionKey, batchId) => path.join(root, 'sessions', sessionKey, 'batches', batchId + '.json');
/** 「唤醒读数」四项（L-AC-8 的量词面）：woke / followup 次数 / 目标会话 id 序列 / 窗键。 */
const wakeReadingOf = (leader, agentSvc, key) => ({
  woke: leader.messages.length > 0,
  followups: leader.messages.length,
  targets: [...agentSvc.lookups],
  window: LEADER_WAKE_WINDOWS.has(key) ? key : null,
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// T-1 【L-AC-3 主判据 + L-AC-7 判别力】：命名黑板批 + worker **不主动回报** ⇒ 主路定向到发起派发的 agent
// ══════════════════════════════════════════════════════════════════════════════════════════
test('T-1 【L-AC-3/L-AC-7】命名黑板批 + worker 不回报 ⇒ 主路唤醒**发起派发的 agent 会话**（≠ 黑板名）', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const leader = stubLeader();
  const agentSvc = agentsStubOf({ [LEADER]: leader }); // 黑板名**不在**活表内（缺陷形态）
  const m = await mountOf({ batchId: 'b-t1', agents: agentSvc, label: 't1' });
  try {
    assert.equal(Object.prototype.hasOwnProperty.call(agentSvc.live, BOARD), false, '前置：黑板名**不是**活 agent 会话（缺陷形态成立）');
    assert.equal(m.store.readBatch(BOARD, 'b-t1') !== null, true, '前置：批文件落在黑板名下');
    const eventsBefore = eventsOf(m).length;
    // 成员态基线取**装配后**读数（`apply()` 的启动恢复会归一化非终态 lane，属既有行为，与本路无关）
    const lanesBefore = { ...m.store.readBatch(BOARD, 'b-t1').lanes };

    // 只调**唤醒路**那一个 listener（归因纪律同 `乙-2`：两路并行，整轮各调一次会把结算路的事件记到唤醒路头上）
    await wakeHookOf(m.ctx).fn(endInfoOf(WORKER));
    await sleep(20);

    reading('T-1 followup 次数', leader.messages.length);
    reading('T-1 寻址查询序列', agentSvc.lookups);
    reading('T-1 窗键', [...LEADER_WAKE_WINDOWS.keys()]);

    // ★ 判别点：改前 HEAD 床 = 0（寻址取黑板名 ⇒ leader-not-live ⇒ 静默）
    assert.equal(leader.messages.length, 1, '命名黑板批 + worker 不回报 ⇒ 主路须唤醒**恰 1 次**（worker 忘了回报时本路是唯一通道）');
    assert.deepEqual(agentSvc.lookups, [LEADER], '寻址查询**恰 1 次**且落在**发起派发的 agent 会话**上（≠ 黑板名；禁「候选逐个试」的松弛实现）');

    const text = leader.messages[0].content[0].text;
    reading('T-1 唤醒消息', text);
    assert.ok(text.startsWith('[swarm] b-t1/' + LANE + ' completed：'), '唤醒消息首行 = 元数据摘要（批/lane/终态）；实测=' + text);
    assert.ok(text.includes('可派发候选'), '候选面（只读，D-3 甲）照常附上');
    assert.equal(LEADER_WAKE_WINDOWS.has(BOARD + '\0b-t1'), false, '窗键**不得**落在黑板名下（那等于寻址回了治理落点）');
    assert.equal(LEADER_WAKE_WINDOWS.has(LEADER + '\0b-t1'), true, '合并窗键 = 寻址值 + \\0 + batchId（L-AC-10）');

    assert.equal(eventsOf(m).length, eventsBefore, '唤醒路**零批面写**（不落事件；约束 C-9）');
    assert.deepEqual(m.store.readBatch(BOARD, 'b-t1').lanes, lanesBefore, '唤醒 ≠ 结算：成员态逐字不变');
  } finally { m.disposer(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// T-1b 【L-AC-3 阴性侧】：目标不可解 ⇒ 零 followup，且**不得**改试别的候选（查询恰 1 次）
// ══════════════════════════════════════════════════════════════════════════════════════════
test('T-1b 【L-AC-3 阴性侧】记录到的 owner 非活 ⇒ 零 followup，**不得**二次改试（寻址查询恰 1 次）', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const leader = stubLeader();
  const agentSvc = agentsStubOf({ [LEADER]: leader });
  const m = await mountOf({
    batchId: 'b-t1b', agents: agentSvc, label: 't1b',
    dispatches: [{ workerSessionId: WORKER, owner: 'sess-owner-gone' }],
  });
  try {
    await wakeHookOf(m.ctx).fn(endInfoOf(WORKER));
    await sleep(20);
    reading('T-1b 读数', { followups: leader.messages.length, lookups: agentSvc.lookups });
    assert.equal(leader.messages.length, 0, '目标句柄取不到 ⇒ 零 followup（唤醒单点 fail-safe，不抛）');
    assert.deepEqual(agentSvc.lookups, ['sess-owner-gone'], '寻址查询**恰 1 次**（禁松弛实现：不得再拿 `hit.sessionId` 或其它候选重试）');
  } finally { m.disposer(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// T-2 【L-AC-8】：冷索引（惰性重建路径）与热索引读数**逐字相同**
// ══════════════════════════════════════════════════════════════════════════════════════════
test('T-2 【L-AC-8】冷索引（结算路惰性重建）与热索引四项读数逐字相同', async () => {
  const key = LEADER + '\0b-t2';
  // ① 热索引：登记先于 `apply()` ⇒ 启动重建即填
  LEADER_WAKE_WINDOWS.clear();
  const hotLeader = stubLeader();
  const hotSvc = agentsStubOf({ [LEADER]: hotLeader });
  const hot = await mountOf({ batchId: 'b-t2', agents: hotSvc, label: 't2hot' });
  let hotReading = null;
  try {
    await wakeHookOf(hot.ctx).fn(endInfoOf(WORKER));
    await sleep(20);
    hotReading = wakeReadingOf(hotLeader, hotSvc, key);
    reading('T-2 热索引读数', hotReading);
  } finally { hot.disposer(); }

  // ② 冷索引：`apply()` 之后才登记 ⇒ 启动重建扫不到，索引只能靠**结算主路**的惰性重建补齐
  LEADER_WAKE_WINDOWS.clear();
  const coldLeader = stubLeader();
  const coldSvc = agentsStubOf({ [LEADER]: coldLeader });
  const cold = await mountOf({ batchId: 'b-t2', agents: coldSvc, label: 't2cold', dispatches: [] });
  try {
    const hook = wakeHookOf(cold.ctx);
    // ②-1 前置读数：只调唤醒路（不跑结算路）⇒ 索引确实**冷**（唤醒路刻意不复制第二套重建）
    await hook.fn(endInfoOf(WORKER));
    await sleep(20);
    reading('T-2 冷索引·仅唤醒路', { followups: coldLeader.messages.length, lookups: coldSvc.lookups });
    assert.equal(coldLeader.messages.length, 0, '前置：索引冷且唤醒路先跑 ⇒ 零唤醒（本仓已登记的窄窗；证明 ② 的分辨面未被启动重建偷填）');

    // ②-2 真冷路径：登记下落 + 整轮投递 ⇒ 结算主路惰性重建（**重建必须复制该字段**，W-4 的判别面）
    registerDispatch(cold.store, BOARD, 'b-t2');
    coldSvc.lookups.length = 0;
    LEADER_WAKE_WINDOWS.clear();
    await emitAll(cold.ctx, endInfoOf(WORKER));
    await sleep(40);
    const coldReading = wakeReadingOf(coldLeader, coldSvc, key);
    reading('T-2 冷索引读数', coldReading);

    assert.equal(coldLeader.messages.length, 1, '冷索引路径下唤醒**不得**静默回退（W-4 漏改即在此暴露：重建丢掉字段 ⇒ 寻址回退黑板名）');
    assert.deepEqual(coldSvc.lookups, [LEADER], '冷索引路径的寻址值 = 发起派发的 agent 会话');
    assert.deepEqual(coldReading, hotReading, 'L-AC-8：冷/热索引四项读数（woke/followup/目标会话 id/窗键）逐字相同');
  } finally { cold.disposer(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// T-3 【L-AC-4】：真会话批既有行为**逐字不变**（有/无 `ownerSessionId` 两种登记形态同读数）
// ══════════════════════════════════════════════════════════════════════════════════════════
test('T-3 【L-AC-4】真会话批（批归属键 = 活会话）：既有形态与新增形态**同读数**、目标逐字不变', async () => {
  for (const [tag, hasOwner] of [['既有登记形态（无 ownerSessionId 键）', false], ['新增登记形态（带 ownerSessionId）', true]]) {
    LEADER_WAKE_WINDOWS.clear();
    const leader = stubLeader();
    const agentSvc = agentsStubOf({ [LEADER]: leader });
    const m = await mountOf({
      batchId: 'b-t3', batchKey: LEADER, agents: agentSvc, label: 't3',
      dispatches: [{ workerSessionId: WORKER, hasOwner }],
    });
    try {
      await wakeHookOf(m.ctx).fn(endInfoOf(WORKER));
      await sleep(20);
      reading('T-3 ' + tag, { followups: leader.messages.length, lookups: agentSvc.lookups });
      assert.equal(leader.messages.length, 1, tag + '：真会话批照常唤醒');
      assert.deepEqual(agentSvc.lookups, [LEADER], tag + '：目标会话 id **逐字** = 批归属会话（既有可用行为零漂移）');
    } finally { m.disposer(); }
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// T-4 【约束 C-3 回退语义】：缺失 / 空串 / 非字符串 ⇒ 寻址值**恰等于** `hit.sessionId`
// ══════════════════════════════════════════════════════════════════════════════════════════
test('T-4 【C-3】`ownerSessionId` 缺失/空串/非字符串 ⇒ 寻址恰等于 `hit.sessionId`（**禁 `??` 放行空串**）', async () => {
  // 用**真会话批**作回退面：`hit.sessionId` = LEADER（活）⇒ 若回退正确则必唤醒；
  //   空串形态尤其关键：`??` 会放行 `''` ⇒ `leaderSessionId=''` ⇒ `no-leader-session`、零唤醒（RED）。
  const variants = [
    ['缺失（不写该键）', { hasOwner: false }, LEADER, 1],
    ['空串', { owner: '' }, LEADER, 1],
    ['数字', { owner: 123 }, LEADER, 1],
    ['null', { owner: null }, LEADER, 1],
    ['对象', { owner: { sessionId: LEADER } }, LEADER, 1],
    // 纯空白 = **非空字符串** ⇒ 不属 C-3 回退族（批1 L-AC-1 量词；本卡 §约束 5「不 trim」）
    //   ⇒ 逐字当地址用 ⇒ 不可解 ⇒ 零唤醒（L-AC-13 同口径；已在 T-11 锁甲路面，此处锁主路面）
    ['纯空白（逐字保留为地址）', { owner: '   ' }, '   ', 0],
  ];
  LEADER_WAKE_WINDOWS.clear();
  const leader = stubLeader();
  const agentSvc = agentsStubOf({ [LEADER]: leader });
  const m = await mountOf({
    batchId: 'b-t4', batchKey: LEADER, agents: agentSvc, label: 't4',
    dispatches: variants.map(([, v], i) => ({ workerSessionId: 'ws-t4-' + i, hasOwner: v.hasOwner !== false, owner: v.owner })),
  });
  try {
    for (let i = 0; i < variants.length; i++) {
      const [tag, , expected, expectedFollowups] = variants[i];
      leader.messages.length = 0;
      agentSvc.lookups.length = 0;
      LEADER_WAKE_WINDOWS.clear();
      await wakeHookOf(m.ctx).fn(endInfoOf('ws-t4-' + i));
      await sleep(20);
      reading('T-4 ' + tag, { followups: leader.messages.length, lookups: agentSvc.lookups, expected });
      assert.equal(leader.messages.length, expectedFollowups, '形态「' + tag + '」的唤醒次数');
      assert.deepEqual(agentSvc.lookups, [expected], '形态「' + tag + '」的寻址值 = ' + JSON.stringify(expected));
    }
  } finally { m.disposer(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// T-5 【L-AC-9】：`self` 防自激闸**先于**任何寻址取值
// ══════════════════════════════════════════════════════════════════════════════════════════
test('T-5 【L-AC-9】`self` 闸：登记 worker === 解析出的目标 ⇒ 零 followup 且**零寻址查询**', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const leader = stubLeader();
  const agentSvc = agentsStubOf({ [LEADER]: leader });
  // 命名黑板批 + owner = LEADER + workerSessionId = LEADER ⇒ 解析出的寻址值恰 = callerSessionId ⇒ self
  const m = await mountOf({
    batchId: 'b-t5', agents: agentSvc, label: 't5',
    dispatches: [{ workerSessionId: LEADER, owner: LEADER }],
  });
  try {
    await wakeHookOf(m.ctx).fn(endInfoOf(LEADER));
    await sleep(20);
    reading('T-5 读数', { followups: leader.messages.length, lookups: agentSvc.lookups });
    assert.equal(leader.messages.length, 0, 'self 闸：不得唤醒自己（零自激）');
    assert.deepEqual(agentSvc.lookups, [], '判定序未改：`self` 闸**先于**寻址取值（`swarm-comms.js:174-182` 的判定序）');

    // 逐字读 `reason`：同入参直调唤醒单点（主路丢弃返回值 ⇒ 只能这样读）
    const out = wakeLeaderForReport({ get: () => agentSvc }, {
      callerSessionId: LEADER, leaderSessionId: LEADER, batchId: 'b-t5', lane: LANE, type: 'completed', summary: 'x',
    });
    assert.equal(out.reason, 'self', 'self 形态的 reason 逐字 = `self`');
    assert.equal(out.woke, false, 'self 形态不得唤醒');
  } finally { m.disposer(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// T-6 【L-AC-5】：治理落点零改动（批文件 / 候选面 / 结算入参 / 载荷既有键）
// ══════════════════════════════════════════════════════════════════════════════════════════
test('T-6 【L-AC-5】治理落点逐字不动：批文件仍在黑板名下 + 候选面可读 + 结算入参仍取批归属键', async () => {
  // (a) 唤醒面：同一次投递内**同时**核「批文件仍在黑板名下」与「候选面 `poolViewOf` 可读」
  LEADER_WAKE_WINDOWS.clear();
  const leader = stubLeader();
  const agentSvc = agentsStubOf({ [LEADER]: leader });
  const m = await mountOf({ batchId: 'b-t6', agents: agentSvc, label: 't6' });
  try {
    await wakeHookOf(m.ctx).fn(endInfoOf(WORKER));
    await sleep(20);
    assert.equal(leader.messages.length, 1, '前置：命名黑板批的唤醒须先成立（本用例只核**落点**面）');
    assert.equal(fs.existsSync(batchFileOf(m.root, BOARD, 'b-t6')), true, '批文件路径仍 = `<root>/sessions/<批归属键=黑板名>/batches/<batchId>.json`');
    assert.equal(fs.existsSync(batchFileOf(m.root, LEADER, 'b-t6')), false, '**不得**因寻址改动而把批文件迁到 agent 会话名下');
    const view = poolViewOf(m.store.readBatch(BOARD, 'b-t6'));
    const expected = view.pool.filter((t) => t.dispatchable).map((t) => t.id);
    const blocked = view.pool.filter((t) => !t.dispatchable).map((t) => t.id);
    const listed = (leader.messages[0].content[0].text.split('可派发候选（引擎只建议，派发仍由 Leader 决定）：')[1] ?? '').split('\n')[0].split(', ').filter(Boolean);
    reading('T-6 候选面', { expected, blocked, listed });
    assert.ok(expected.includes('e1'), '前置：e1（deps 已满足 + owner null + lane pending）可派发');
    assert.ok(blocked.includes('a1'), '前置：a1（deps e2 未终态）被拦 —— 负控非空转');
    assert.deepEqual(listed, expected, '候选面取自 **`hit.sessionId`（黑板名）** 的批（单点判据，无第二套口径）');
  } finally { m.disposer(); }

  // (b) 结算面：冷索引 + 整轮 ⇒ 结算事件仍落在**黑板名下**的批里（`auto-settle.js` 的 `sessionId: hit.sessionId`）
  LEADER_WAKE_WINDOWS.clear();
  const leader2 = stubLeader();
  const m2 = await mountOf({ batchId: 'b-t6c', agents: agentsStubOf({ [LEADER]: leader2 }), label: 't6c', dispatches: [] });
  try {
    registerDispatch(m2.store, BOARD, 'b-t6c');
    await emitAll(m2.ctx, endInfoOf(WORKER));
    await sleep(40);
    const types = eventsOf(m2).map((e) => e.type);
    reading('T-6 结算落点事件类型', types);
    assert.ok(types.some((t) => String(t).startsWith('auto.settle')), '结算主路同一事件上仍生效（且写在黑板名下的批里）');
    assert.equal(fs.existsSync(batchFileOf(m2.root, LEADER, 'b-t6c')), false, '结算**不得**在 agent 会话名下另建批文件');
  } finally { m2.disposer(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// T-7 【L-AC-10】：节流口径与订阅结构零变更
// ══════════════════════════════════════════════════════════════════════════════════════════
test('T-7 【L-AC-10】两路订阅均 `{global:true}`；节流口径 = 既有单点常量；窗内合并按**寻址值**计数', async () => {
  LEADER_WAKE_WINDOWS.clear();
  const leader = stubLeader();
  const agentSvc = agentsStubOf({ [LEADER]: leader });
  const m = await mountOf({
    batchId: 'b-t7', agents: agentSvc, label: 't7',
    dispatches: [{ workerSessionId: 'ws-t7-a' }, { workerSessionId: 'ws-t7-b' }],
  });
  try {
    const hooks = endHooksOf(m.ctx);
    reading('T-7 订阅', hooks.map((h) => h.opts));
    assert.equal(hooks.length, 2, '`subagent/end` 面仍为 2 路订阅（新增订阅结构未变）');
    for (const h of hooks) assert.deepEqual(h.opts, { global: true }, '两路均须 `{global:true}`');
    assert.equal(WAKE_MIN_INTERVAL_MS, 30_000, '合并窗 = 既有单点常量（未另写第二套节流口径）');

    await wakeHookOf(m.ctx).fn(endInfoOf('ws-t7-a'));
    await wakeHookOf(m.ctx).fn(endInfoOf('ws-t7-b'));
    await sleep(20);
    reading('T-7 窗内两 worker', { followups: leader.messages.length, lookups: agentSvc.lookups, windows: [...LEADER_WAKE_WINDOWS.keys()] });
    assert.equal(leader.messages.length, 1, '窗内（30s）合并 ⇒ 唤醒恰 1 次（leading-edge 语义不变）');
    assert.equal(LEADER_WAKE_WINDOWS.has(LEADER + '\0b-t7'), true, '窗键 = 寻址值 + \\0 + batchId（同批同 Leader 共一窗）');
  } finally { m.disposer(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// T-8 【L-AC-6】：甲路（批1 修的 `wakeSessionId`）不受本批影响
// ══════════════════════════════════════════════════════════════════════════════════════════
test('T-8 【L-AC-6】甲路逐字不动：`reportTargetOf` 仍按 agent 亲缘给 `wakeSessionId`，治理落点仍取批归属键', async () => {
  const commsSrc = read('lib/tools/swarm-comms.js');
  const toolsSrc = read('lib/tools/swarm-tools.js');
  assert.ok(commsSrc.includes("const wakeSessionId = (typeof parentSession === 'string' && parentSession.length > 0) ? parentSession : bind.sessionId;"),
    '甲路 `reportTargetOf` 的 `wakeSessionId` 判定式**一字未动**（批1 语义；本批未回退）');
  assert.ok(commsSrc.includes("exec?.agent?.session?.header?.parentSession"), '甲路的父会话取值式在场');
  assert.ok(toolsSrc.includes('leaderSessionId: tgt.wakeSessionId ?? tgt.sessionId'), '甲路唤醒目标取值式一字未动');
  assert.ok(toolsSrc.includes('sessionId: tgt.sessionId'), '甲路治理写入（结算入参）仍取治理落点 `tgt.sessionId`');

  // 运行期：命名黑板批 + worker 带 `parentSession` ⇒ sessionId 仍是黑板名、wakeSessionId 是父会话
  const root = tempRoot('punky-wakeaddr-t8-');
  const store = createStore(root);
  seedBoardBatch(store, root, { batchKey: BOARD, batchId: 'b-t8' });
  registerDispatch(store, BOARD, 'b-t8', { workerSessionId: WORKER, hasOwner: false });
  const tgt = reportTargetOf(store, { agent: { session: { id: WORKER, header: { parentSession: PARENT } } } }, {});
  reading('T-8 甲路读数', tgt);
  assert.equal(tgt.sessionId, BOARD, '治理落点 = 批归属键（黑板名）逐字不变');
  assert.equal(tgt.wakeSessionId, PARENT, '唤醒寻址 = agent 亲缘（父会话）—— 批1 语义');
  assert.equal(tgt.batchId, 'b-t8', '批次键不变');
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// T-9 【L-AC-11/L-AC-15 + C-2】：载荷纯加法 + 两写点落值一致 + 唯一解析单点
// ══════════════════════════════════════════════════════════════════════════════════════════
test('T-9a 【L-AC-11】写点 B（装配层登记点）：载荷 = 既有 2 键 + `ownerSessionId`；`cli` 兜底**不入载荷**（R-7）', async () => {
  const root = tempRoot('punky-wakeaddr-t9b-');
  const aux = createStore(root);
  aux.createBatch(BOARD, { batchId: 'b-t9b', wavePlan: buildWavePlan({ batchId: 'b-t9b', tasks: boardTasksOf() }), phase: 'running' });
  const ctx = assemblyCtxOf({ agents: undefined });
  const index = new Map();
  const reg = installDispatchRegistration(ctx, {
    store: createStore(root), dispatchIndex: index, config: {}, logger: ctx.logger,
    resolveBatchContext: () => ({ sessionId: BOARD, batchId: 'b-t9b', lane: LANE }),
  });
  assert.equal(reg.installed, true);
  const postAll = async (exec, result) => { for (const { fn } of [...(ctx.listeners.get('tools/post-execute') ?? [])]) await fn(exec, result, () => 'NEXT'); };
  try {
    await postAll({ name: 'subagent', arguments: {}, agent: { session: { id: LEADER } } }, { isError: false, value: { kind: 'continuable', subagentId: 'ws-t9-1' } });
    const ev = aux.readBatch(BOARD, 'b-t9b').events.filter((e) => e.type === EVT_MEMBER_DISPATCH)[0];
    reading('T-9a 写点 B 载荷', ev);
    assert.deepEqual(Object.keys(ev).filter((k) => !['ts', 'type'].includes(k)).sort(), ['lane', 'ownerSessionId', 'workerSessionId'], '载荷 = 既有 2 键 + 恰 1 新键');
    assert.equal(ev.ownerSessionId, LEADER, '写点 B 的记录值 = 发起派发的 agent 会话 id');
    assert.equal(index.get('ws-t9-1').ownerSessionId, LEADER, '索引值同步携带该字段（热路径即时生效）');

    // R-7：取不到 `exec.agent` ⇒ `caller` 兜底 `'cli'` **不得**进载荷（否则「cli」成为永不可能 live 的唤醒目标）
    await postAll({ name: 'subagent', arguments: {} }, { isError: false, value: { kind: 'continuable', subagentId: 'ws-t9-2' } });
    const ev2 = aux.readBatch(BOARD, 'b-t9b').events.filter((e) => e.type === EVT_MEMBER_DISPATCH).find((e) => e.workerSessionId === 'ws-t9-2');
    reading('T-9a 无 agent 形态载荷', ev2);
    assert.equal('ownerSessionId' in ev2, false, '取不到会话 ⇒ **不写**该键（走 C-3 回退），不得写入 `cli`');
  } finally { reg.dispose?.(); }
});

test('T-9b 【L-AC-11/L-AC-15】写点 A（引擎自派唯一写路径）：载荷同样 = 既有 2 键 + `ownerSessionId`', async () => {
  __resetLaneHandles();
  const SESSION = 'sess-t9c';
  const root = tempRoot('punky-wakeaddr-t9a-');
  const store = createStore(root);
  fs.mkdirSync(path.join(root, 'sessions', SESSION, 'artifacts', 'b-t9c', 'plan'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sessions', SESSION, 'artifacts', 'b-t9c', 'plan', 'spec.md'), '# 规格夹具\n', 'utf8');
  store.createBatch(SESSION, {
    batchId: 'b-t9c',
    wavePlan: buildWavePlan({
      batchId: 'b-t9c',
      tasks: [
        { id: 'p1', layer: 'plan', role: 'coordinator', cmd: '定规格', produce: ['plan/spec.md'], outputs: ['plan/spec.md'] },
        { id: 'l1', layer: 'exec', role: 'coder', cmd: '实现 X', deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/l1/x.md'] },
        { id: 'a1', layer: 'audit', role: 'supervisor', cmd: '审计', deps: ['l1'], consume: ['plan/spec.md'] },
      ],
    }),
    phase: 'running',
  });
  store.writeGovernance(SESSION, {
    lastAssign: { difficulty: 'C', form: 'C', scope: 'full', rationale: 'fixture：引擎自派前置评估（三层批 ⇒ C）', reasons: [], at: new Date().toISOString(), execCallsSince: 0 },
  });
  const ctx = assemblyCtxOf({ agents: undefined });
  ctx.subagents = { start: async () => ({ id: 'ws-t9c', result: Promise.resolve({ output: [], stopReason: 'completed' }) }) };
  const tools = createCoreTools(ctx, { store, root, config: { dispatch: { provider: 'spawn-in-process' } } });
  const ld = tools.find((t) => t.name === 'lane_dispatch');
  try {
    const r = await ld.execute({ batchId: 'b-t9c', lane: 'l1', prompt: '要点：夹具' }, { agent: { session: { id: SESSION } } });
    assert.equal(r.spawned, true, '前置：引擎自派成功');
    const ev = store.readBatch(SESSION, 'b-t9c').events.filter((e) => e.type === EVT_MEMBER_DISPATCH)[0];
    reading('T-9b 写点 A 载荷', ev);
    assert.deepEqual(Object.keys(ev).filter((k) => !['ts', 'type'].includes(k)).sort(), ['lane', 'ownerSessionId', 'workerSessionId'], '载荷 = 既有 2 键 + 恰 1 新键');
    assert.equal(ev.ownerSessionId, SESSION, '写点 A 的记录值 = 发起派发的 agent 会话 id');
    assert.equal(ev.workerSessionId, 'ws-t9c', '既有键 `workerSessionId` 逐字不变');
    assert.equal(ev.lane, 'l1', '既有键 `lane` 逐字不变');
  } finally { __resetLaneHandles(); }
});

test('T-9c 【约束 C-2】唯一解析单点：字段名只在 `lib/engine/dispatch.js` 内解析；三读点共用该单点', async () => {
  const mod = await import('../lib/engine/dispatch.js');
  reading('T-9c 单点导出', {
    ownerSessionIdOf: typeof mod.ownerSessionIdOf,
    ownerSessionIdOfExec: typeof mod.ownerSessionIdOfExec,
    wakeAddressOf: typeof mod.wakeAddressOf,
    dispatchIndexEntryOf: typeof mod.dispatchIndexEntryOf,
  });
  assert.equal(typeof mod.ownerSessionIdOf, 'function', '读侧解析单点 `ownerSessionIdOf` 在场（事件/索引值 → 记录值）');
  assert.equal(typeof mod.ownerSessionIdOfExec, 'function', '写侧取值单点 `ownerSessionIdOfExec` 在场（exec → 发起派发的 agent 会话 id）');
  assert.equal(typeof mod.wakeAddressOf, 'function', '唤醒寻址单点 `wakeAddressOf` 在场（含回退语义，**不**在调用点写 `??`）');
  assert.equal(typeof mod.dispatchIndexEntryOf, 'function', '索引值构造单点 `dispatchIndexEntryOf` 在场（三写点共用同一形状）');

  // 回退语义单点自证（禁 `??` 放行空串）
  assert.equal(mod.wakeAddressOf({ sessionId: 's', ownerSessionId: '' }), 's', '空串 ⇒ 回退 `sessionId`（`??` 会放行空串 ⇒ 此断言即硬化面）');
  assert.equal(mod.wakeAddressOf({ sessionId: 's', ownerSessionId: 123 }), 's', '非字符串 ⇒ 回退');
  assert.equal(mod.wakeAddressOf({ sessionId: 's' }), 's', '缺失 ⇒ 回退');
  assert.equal(mod.wakeAddressOf({ sessionId: 's', ownerSessionId: 'o' }), 'o', '合法值 ⇒ 取该值（逐字）');
  assert.equal(mod.ownerSessionIdOfExec({ agent: { session: { id: 'a' } } }), 'a', '写侧取值 = `exec.agent.session.id`（与派发面 `parent: exec.agent` 同源）');
  assert.equal(mod.ownerSessionIdOfExec({ agent: {} }), null, '取不到 ⇒ null（**不**落 `cli` 兜底）');
  assert.equal(mod.ownerSessionIdOfExec(null), null, '无 exec ⇒ null（不抛）');

  // 三读点不得各自读字段名
  for (const rel of ['lib/index.js', 'lib/engine/auto-settle.js', 'lib/bridge/dispatch-register.js']) {
    const src = read(rel);
    const direct = src.match(/\.ownerSessionId\b/g) ?? [];
    assert.equal(direct.length, 0, rel + ' 不得直接读 `.ownerSessionId` 字段（唯一解析单点；实测命中 ' + direct.length + ' 处）');
  }
  assert.ok(read('lib/index.js').includes('ownerSessionIdOf(') && read('lib/index.js').includes('wakeAddressOf('),
    '`lib/index.js` 的两读点（重建 + 唤醒本体）经单点取值');
  assert.ok(read('lib/engine/auto-settle.js').includes('ownerSessionIdOf('), '`auto-settle.js` 的惰性重建经单点取值（W-4）');
  assert.ok(read('lib/bridge/dispatch-register.js').includes('ownerSessionIdOfExec('), '`dispatch-register.js` 的写点经写侧单点取值');
  assert.ok(read('lib/engine/dispatch.js').includes('ownerSessionIdOfExec('), '`dispatch.js` 的写点经同一写侧单点取值');
  for (const rel of ['lib/index.js', 'lib/engine/auto-settle.js', 'lib/bridge/dispatch-register.js']) {
    assert.ok(read(rel).includes('dispatchIndexEntryOf('), rel + ' 的索引写入经**同一**值构造单点（形状与附加读数两处口径都不许分叉）');
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// T-9d 【L-AC-11 形状冻结】：索引值既有 3 键形状逐字保持；附加读数**非枚举**（可见、可读、不改形状）
// ══════════════════════════════════════════════════════════════════════════════════════════
test('T-9d 【L-AC-11】索引值形状冻结：既有 3 键形状逐字不变，附加读数为非枚举自有属性（未遮蔽）', async () => {
  const mod = await import('../lib/engine/dispatch.js');
  const entry = mod.dispatchIndexEntryOf('s', 'b', 'l', 'owner-1');
  reading('T-9d 索引值三面', {
    keys: Object.keys(entry), ownNames: Object.getOwnPropertyNames(entry), json: JSON.stringify(entry), read: entry.ownerSessionId,
  });
  assert.deepEqual(Object.keys(entry).sort(), ['batchId', 'lane', 'sessionId'], '既有形状逐字不变（`test/dispatch-register.test.js` R2/R2b/R6/R10 的 `deepEqual` 形状锁）');
  assert.deepEqual({ ...entry }, { sessionId: 's', batchId: 'b', lane: 'l' }, '展开面同样只见既有 3 键');
  assert.equal(JSON.stringify(entry), '{"sessionId":"s","batchId":"b","lane":"l"}', 'JSON 序列化面形状不变（面板/回显/日志零漂移）');
  assert.ok(Object.getOwnPropertyNames(entry).includes('ownerSessionId'), '附加读数**未遮蔽**：`getOwnPropertyNames` 可见该字段');
  assert.equal(mod.ownerSessionIdOf(entry), 'owner-1', '取值面经唯一解析单点可达（三读点读数一致）');
  assert.equal(mod.wakeAddressOf(entry), 'owner-1', '寻址单点取到该值');
  const bare = mod.dispatchIndexEntryOf('s', 'b', 'l', null);
  assert.equal(Object.getOwnPropertyNames(bare).includes('ownerSessionId'), false, '未记录 ⇒ 不附加（「缺失」形态 ⇒ 走 C-3 回退）');
  assert.equal(mod.wakeAddressOf(bare), 's', '未记录 ⇒ 寻址回退 `sessionId`');
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// T-10 【L-AC-14】：净增 0 与写域外冻结
// ══════════════════════════════════════════════════════════════════════════════════════════
test('T-10 【L-AC-14】导出面 / 事件常量 / `GATE_*` 码净增 0；写域外文件不被本批触碰', () => {
  const exportNamesOf = (src) => [...src.matchAll(/^export\s+(?:const|function|class|let)\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]).sort();
  assert.deepEqual(exportNamesOf(read('lib/index.js')), ['apply', 'inject', 'name'], '装配入口导出面逐字不变');
  assert.deepEqual(exportNamesOf(read('lib/tools/swarm-comms.js')),
    ['LEADER_WAKE_WINDOWS', 'UNBOUND_BATCH_KEY', 'WAKE_MIN_INTERVAL_MS', 'WAKE_TYPES',
      'appendSwarmEventOf', 'deliverSwarmMessage', 'reportTargetOf', 'wakeLeaderForReport'],
    '唤醒单点模块导出面逐字不变（净增 0）');
  assert.deepEqual(exportNamesOf(read('lib/tools/swarm-tools.js')), ['buildSwarmTools'], '工具面导出净增 0');
  assert.equal(read('lib/state/event-types.js').includes('swarm.wake'), false, '不新增唤醒类事件常量');
  assert.deepEqual([...new Set(read('lib/index.js').match(/GATE_[A-Z0-9_]+/g) ?? [])].sort(), ['GATE_ENABLED'], '装配段不新增任何 `GATE_*` 码');
  // 治理面文件：本批**未触碰**（其内容仍在场，且未见本批的解析单点符号泄漏进去）
  for (const rel of ['lib/tools/swarm-comms.js', 'lib/tools/swarm-tools.js', 'lib/state/event-types.js']) {
    assert.equal(read(rel).includes('ownerSessionIdOf'), false, rel + ' 不在写域内（不得出现本批符号）');
  }
  assert.ok(EVT_SWARM_REPORT === 'swarm.report', '唤醒路不自构成触发源（`swarm.report` 仍只由成员回报产生）');
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// T-11 【L-AC-13 / F-03】：纯空白 `parentSession` 不炸、不误唤醒（口径 = **不 trim**）
// ══════════════════════════════════════════════════════════════════════════════════════════
test('T-11 【L-AC-13】F-03：`parentSession === \'   \'` ⇒ 不抛、零 followup、reason=`leader-not-live`（**不 trim**）', async () => {
  const root = tempRoot('punky-wakeaddr-t11-');
  const store = createStore(root);
  seedBoardBatch(store, root, { batchKey: BOARD, batchId: 'b-t11' });
  registerDispatch(store, BOARD, 'b-t11', { workerSessionId: WORKER, hasOwner: false });
  const exec = { agent: { session: { id: WORKER, header: { parentSession: '   ' } } } };
  const tgt = reportTargetOf(store, exec, {});
  reading('T-11 甲路读数', tgt);
  assert.equal(tgt.wakeSessionId, '   ', '**不 trim**：非空字符串 ⇒ `wakeSessionId` 逐字等于 `parentSession`（批1 L-AC-1 量词）');

  // 黑板名**挂活桩** ⇒ 若发生 trim 或回退到治理落点，就会「误唤醒」——这是「不误唤醒」的判别面
  const boardStub = stubLeader();
  const agentSvc = agentsStubOf({ [BOARD]: boardStub });
  let out = null;
  let thrown = null;
  try {
    out = wakeLeaderForReport({ get: () => agentSvc }, {
      callerSessionId: WORKER, leaderSessionId: tgt.wakeSessionId ?? tgt.sessionId,
      batchId: 'b-t11', lane: LANE, type: 'completed', summary: 'x',
    });
  } catch (e) { thrown = String(e?.message ?? e); }
  reading('T-11 唤醒读数', { thrown, out, lookups: agentSvc.lookups, followups: boardStub.messages.length });
  assert.equal(thrown, null, '纯空白形态**不得**抛（不炸）');
  assert.equal(out.woke, false, '不得误唤醒');
  assert.equal(out.reason, 'leader-not-live', 'reason 逐字 = `leader-not-live`（地址不可解，且**未**回退到治理落点）');
  assert.equal(boardStub.messages.length, 0, '黑板名虽为活桩，仍**零** followup');
  assert.deepEqual(agentSvc.lookups, ['   '], '寻址查询用的是**原值** `\'   \'`（未 trim；不可达畸形输入，已登记边界）');
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// T-12 【L-AC-12】：`auto-settle.js` 未被改造成唤醒路（批1 静态断言面续锁）
// ══════════════════════════════════════════════════════════════════════════════════════════
test('T-12 【L-AC-12】`auto-settle.js` 零唤醒符号；`lib/index.js` 不引用 `dispatchLaneCore`', () => {
  const settleSrc = read('lib/engine/auto-settle.js');
  for (const needle of ['wakeLeaderForReport', 'poolViewOf', 'leaderWake']) {
    assert.equal(settleSrc.includes(needle), false, '结算主路不得被改造成唤醒路（实测命中 ' + needle + '）');
  }
  assert.equal(read('lib/index.js').includes('dispatchLaneCore('), false, 'D-3 甲：引擎只建议不派发（禁真派）');
});
