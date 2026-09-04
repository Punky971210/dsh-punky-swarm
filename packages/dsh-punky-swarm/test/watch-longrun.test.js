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

// lane_longrun 超时重派探针单测（watch 域，longrun 档）——覆盖 longrun-probe-design T1-T16（按定案修订）
// 覆盖：judgeLongrun 纯函数边界（恰达阈值不触发/窗沿/无 checkpoint 历史/非 running 不判/AND 双无）；
//       runningSince 推导与重派重置（T8）；resolveLongrunConfig 默认开（用户定案）/非法回退（T13）；
//       tick 产候选（事件+broadcast 双通道载荷齐全，T9）；同 stint 去重 + 跨重启幂等（T10/T11）；
//       stint 重置后可再候选（T12）；探针不改 lane 状态（验收 5）；lane_longrun 工具门控与查询（对齐 W6）。
//       默认开已定案：本文件断言 capabilities.watch.longrun.enabled 出厂缺省 true（旧设计「默认关」为旧行为）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import * as mailbox from '../lib/comms/mailbox.js';
import {
  createLaneHeartbeat, createHeartbeatTools, createLongrunTools,
  judgeLongrun, stintRunningSinceOf, lastCheckpointTsOf, hasLongrunCandidate,
  resolveLongrunConfig, LONGRUN_DEFAULTS, LONGRUN_REASON,
} from '../lib/watch/lane-heartbeat.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { EVT_LANE_LONGRUN_CANDIDATE, EVT_MEMBER_DISPATCH, EVT_MEMBER_SETTLED, EVT_WORKTREE_CHECKPOINT } from '../lib/state/event-types.js';

const MAX_D = LONGRUN_DEFAULTS.maxDurationMs; // 1200000
const WINDOW = LONGRUN_DEFAULTS.noProgressWindowMs; // 300000

// 造事件（镜像 failed-escalate mkEvent：ts ISO / type / 附加字段）
const mkEv = (tsMs, type, fields = {}) => ({ ts: new Date(tsMs).toISOString(), type, ...fields });
// 基准批次夹具：phase=running、lane l1=running、事件含 dispatch（stint 起点）
function makeBatch({ nowMs, lane = 'l1', withDispatch = true, dispatchOffset = 0, checkpoint = null, extra = [] } = {}) {
  const events = [];
  if (withDispatch) events.push(mkEv(nowMs - MAX_D - dispatchOffset, EVT_MEMBER_DISPATCH, { lane, workerSessionId: 'w1' }));
  if (checkpoint) events.push(mkEv(nowMs - checkpoint, EVT_WORKTREE_CHECKPOINT, { lane, message: 'cp' }));
  events.push(...extra);
  return { phase: 'running', lanes: { [lane]: 'running' }, events };
}

// 真实 store 夹具：running 批次 + running lane（输出目录声明，供 artifact 活动信号复用）
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-lr-'));
  const store = createStore(root);
  const S = 'sess-lr';
  const plan = buildWavePlan({ batchId: 'b-lr', tasks: [{ id: 'l1', outputs: ['exec/l1/out.txt'], cmd: 'work' }] });
  store.createBatch(S, { batchId: 'b-lr', wavePlan: plan, phase: 'running' });
  store.setMember(S, 'b-lr', 'l1', 'running');
  return { root, store, S, batchId: 'b-lr', lane: 'l1' };
}
function hb(store, root, config = {}, opts = {}) {
  return createLaneHeartbeat({ store, mailbox, config, root, ...opts });
}
function inboxItems(root, S, batchId) { return mailbox.readUnacked(path.join(root, 'sessions', S, 'mailbox', batchId), { type: 'inbox' }); }
function bcastItems(root, S, batchId) { return mailbox.readUnacked(path.join(root, 'sessions', S, 'mailbox', batchId), { type: 'broadcast' }); }
function candEvents(store, S, batchId, lane) {
  return (store.readBatch(S, batchId)?.events ?? []).filter((e) => e.type === EVT_LANE_LONGRUN_CANDIDATE && e.lane === lane);
}

// ---- judgeLongrun 纯函数（T1-T7）----
test('T1 正常触发：duration 超 maxDuration + 近窗无 checkpoint 无活动 → candidate', () => {
  const now = 1_800_000_000_000;
  const batch = makeBatch({ nowMs: now }); // dispatch at now-MAX_D → runningSince 固定
  // nowTs 推进 1min → duration = MAX_D+60s > 阈值（严格 >）
  const v = judgeLongrun({ batch, lane: 'l1', nowTs: now + 60_000, maxDurationMs: MAX_D, noProgressWindowMs: WINDOW, lastActivityAtMs: now - MAX_D - 1 });
  assert.equal(v.candidate, true);
  assert.equal(v.reason, LONGRUN_REASON);
  assert.equal(v.durationMs, MAX_D + 60_000, 'duration 超阈值 1min');
});

test('T2 边界：durationMs 恰 == maxDurationMs → 不候选（严格 >）', () => {
  const now = 1_800_000_000_000;
  const batch = makeBatch({ nowMs: now, dispatchOffset: 0 }); // runningSince = now-MAX_D → durationMs == MAX_D
  const v = judgeLongrun({ batch, lane: 'l1', nowTs: now, maxDurationMs: MAX_D, noProgressWindowMs: WINDOW, lastActivityAtMs: null });
  assert.equal(v.candidate, false);
  assert.equal(v.reason, 'duration-not-exceeded');
});

test('T3 边界：checkpoint 恰在窗沿（== noProgressWindowMs）→ checkpointFresh=false（严格 <）；窗内 → fresh → 不候选', () => {
  const now = 1_800_000_000_000;
  // dispatch 提前 60s 保证 duration 严格 > MAX_D（消除 duration 边界干扰）；checkpoint 恰在 5min 窗沿
  const atEdge = judgeLongrun({ batch: makeBatch({ nowMs: now, dispatchOffset: 60_000, checkpoint: WINDOW }), lane: 'l1', nowTs: now, maxDurationMs: MAX_D, noProgressWindowMs: WINDOW, lastActivityAtMs: null });
  assert.equal(atEdge.checkpointFresh, false, '窗沿 ==window 不判 fresh（严格 <）');
  assert.equal(atEdge.candidate, true);
  // 窗内（4min 前）：checkpointFresh=true → 不候选
  const inWin = judgeLongrun({ batch: makeBatch({ nowMs: now, dispatchOffset: 60_000, checkpoint: WINDOW - 60_000 }), lane: 'l1', nowTs: now, maxDurationMs: MAX_D, noProgressWindowMs: WINDOW, lastActivityAtMs: null });
  assert.equal(inWin.checkpointFresh, true);
  assert.equal(inWin.candidate, false);
});

test('T4 近窗有新 checkpoint（checkpointFresh）→ 不候选（AND 之一）', () => {
  const now = 1_800_000_000_000;
  const v = judgeLongrun({ batch: makeBatch({ nowMs: now, dispatchOffset: 60_000, checkpoint: 60_000 }), lane: 'l1', nowTs: now, maxDurationMs: MAX_D, noProgressWindowMs: WINDOW, lastActivityAtMs: null });
  assert.equal(v.checkpointFresh, true);
  assert.equal(v.candidate, false);
  assert.equal(v.reason, 'checkpoint-fresh');
});

test('T5 近窗有活动（activityFresh）→ 不候选（AND 之二）', () => {
  const now = 1_800_000_000_000;
  const v = judgeLongrun({ batch: makeBatch({ nowMs: now, dispatchOffset: 60_000 }), lane: 'l1', nowTs: now, maxDurationMs: MAX_D, noProgressWindowMs: WINDOW, lastActivityAtMs: now - 60_000 });
  assert.equal(v.activityFresh, true);
  assert.equal(v.candidate, false);
  assert.equal(v.reason, 'activity-fresh');
});

test('T6 无 checkpoint 历史 + 无活动 + 超时 → 候选（lastCheckpointTs=null）', () => {
  const now = 1_800_000_000_000;
  const v = judgeLongrun({ batch: makeBatch({ nowMs: now, withDispatch: true }), lane: 'l1', nowTs: now + MAX_D + 60_000, maxDurationMs: MAX_D, noProgressWindowMs: WINDOW, lastActivityAtMs: null });
  assert.equal(v.lastCheckpointTs, null);
  assert.equal(v.candidate, true);
});

test('T7 非 running 不判：lane 非 running / batch.phase≠running → 不候选', () => {
  const now = 1_800_000_000_000;
  const idle = judgeLongrun({ batch: { phase: 'running', lanes: { l1: 'idle' }, events: [mkEv(now - MAX_D, EVT_MEMBER_DISPATCH, { lane: 'l1' })] }, lane: 'l1', nowTs: now, maxDurationMs: MAX_D, noProgressWindowMs: WINDOW, lastActivityAtMs: null });
  assert.equal(idle.candidate, false);
  assert.equal(idle.reason, 'lane-not-running');
  const paused = judgeLongrun({ batch: { phase: 'paused', lanes: { l1: 'running' }, events: [mkEv(now - MAX_D, EVT_MEMBER_DISPATCH, { lane: 'l1' })] }, lane: 'l1', nowTs: now, maxDurationMs: MAX_D, noProgressWindowMs: WINDOW, lastActivityAtMs: null });
  assert.equal(paused.candidate, false);
  assert.equal(paused.reason, 'batch-not-running');
});

// ---- runningSince 推导 / 重派重置（T8）----
test('T8a runningSince：dispatch 与 settled→running 取较新；无二者 → null → 不候选（防御）', () => {
  const t0 = 1_800_000_000_000;
  const b1 = { phase: 'running', lanes: { l1: 'running' }, events: [mkEv(t0 - 100_000, EVT_MEMBER_DISPATCH, { lane: 'l1' }), mkEv(t0 - 50_000, EVT_MEMBER_SETTLED, { lane: 'l1', from: 'pending', to: 'running' })] };
  assert.equal(stintRunningSinceOf(b1, 'l1'), t0 - 50_000, 'settled(较新) 胜出');
  const b2 = { phase: 'running', lanes: { l1: 'running' }, events: [mkEv(t0 - 100_000, EVT_MEMBER_SETTLED, { lane: 'l1', to: 'running' }), mkEv(t0 - 20_000, EVT_MEMBER_DISPATCH, { lane: 'l1' })] };
  assert.equal(stintRunningSinceOf(b2, 'l1'), t0 - 20_000, 'dispatch(较新) 胜出');
  const b3 = { phase: 'running', lanes: { l1: 'running' }, events: [mkEv(t0 - 100_000, 'gate.passed', { lane: 'l1' })] };
  assert.equal(stintRunningSinceOf(b3, 'l1'), null, '无 dispatch/settled-running → null');
  const v = judgeLongrun({ batch: b3, lane: 'l1', nowTs: t0, maxDurationMs: MAX_D, noProgressWindowMs: WINDOW, lastActivityAtMs: null });
  assert.equal(v.candidate, false);
  assert.equal(v.reason, 'no-running-since');
});

test('T8b 重派重置：新 dispatch（runningSince 更新）→ 计时重置，可再次候选', () => {
  const t0 = 1_800_000_000_000;
  // 第一 stint：dispatch at t0-25min；红派后新 dispatch at t0-2min → duration 仅 2min → 不候选
  const b = {
    phase: 'running', lanes: { l1: 'running' },
    events: [
      mkEv(t0 - MAX_D - 300_000, EVT_MEMBER_DISPATCH, { lane: 'l1', workerSessionId: 'old' }),
      mkEv(t0 - 2 * 60_000, EVT_MEMBER_DISPATCH, { lane: 'l1', workerSessionId: 'new' }), // 重派
    ],
  };
  assert.equal(stintRunningSinceOf(b, 'l1'), t0 - 2 * 60_000, '重派后 runningSince 取最新 dispatch');
  const v = judgeLongrun({ batch: b, lane: 'l1', nowTs: t0, maxDurationMs: MAX_D, noProgressWindowMs: WINDOW, lastActivityAtMs: null });
  assert.equal(v.candidate, false, '重派后 2min 未超阈值 → 计时重置（不接续旧 stint 时长）');
  assert.equal(v.durationMs, 2 * 60_000);
  // 重派后再超时 → 可再次候选（T12 纯函数层）
  const v2 = judgeLongrun({ batch: b, lane: 'l1', nowTs: t0 + MAX_D + 60_000, maxDurationMs: MAX_D, noProgressWindowMs: WINDOW, lastActivityAtMs: null });
  assert.equal(v2.candidate, true);
});

test('lastCheckpointTsOf / hasLongrunCandidate：checkpoint 最新 ts 读取 + 同 stint 候选去重', () => {
  const t0 = 1_800_000_000_000;
  const b = {
    phase: 'running', lanes: { l1: 'running' },
    events: [
      mkEv(t0 - 100_000, EVT_WORKTREE_CHECKPOINT, { lane: 'l1' }),
      mkEv(t0 - 30_000, EVT_WORKTREE_CHECKPOINT, { lane: 'l1' }),
      mkEv(t0 - 10_000, EVT_WORKTREE_CHECKPOINT, { lane: 'other' }),
    ],
  };
  assert.equal(lastCheckpointTsOf(b, 'l1'), t0 - 30_000, 'checkpoint 取该 lane 最新一条');
  assert.equal(hasLongrunCandidate(b, 'l1', t0 - 100_000), false);
  b.events.push(mkEv(t0, EVT_LANE_LONGRUN_CANDIDATE, { lane: 'l1', runningSince: new Date(t0 - 100_000).toISOString() }));
  assert.equal(hasLongrunCandidate(b, 'l1', t0 - 100_000), true, '同 stint（runningSince 匹配）已产候选');
  assert.equal(hasLongrunCandidate(b, 'l1', t0 - 30_000), false, '不同 stint runningSince 不误判');
});

// ---- resolveLongrunConfig（T13，按定案修订：出厂默认开）----
test('T13 resolveLongrunConfig：缺省默认开（定案修订）+ 显式关 + 非法回退', () => {
  const d = resolveLongrunConfig({});
  assert.equal(d.enabled, true, '出厂默认开（用户定案修订：非设计默认关）');
  assert.equal(d.maxDurationMs, 1_200_000);
  assert.equal(d.noProgressWindowMs, 300_000);
  const off = resolveLongrunConfig({ capabilities: { watch: { longrun: { enabled: false } } } });
  assert.equal(off.enabled, false);
  const custom = resolveLongrunConfig({ capabilities: { watch: { longrun: { enabled: true, maxDurationMs: 3_600_000, noProgressWindowMs: 600_000 } } } });
  assert.equal(custom.maxDurationMs, 3_600_000);
  assert.equal(custom.noProgressWindowMs, 600_000);
  const bad = resolveLongrunConfig({ capabilities: { watch: { longrun: { enabled: true, maxDurationMs: 0, noProgressWindowMs: -5 } } } });
  assert.equal(bad.maxDurationMs, 1_200_000, '0 → 回退默认');
  assert.equal(bad.noProgressWindowMs, 300_000, '负数 → 回退默认');
  const nan = resolveLongrunConfig({ capabilities: { watch: { longrun: { maxDurationMs: 'abc', noProgressWindowMs: NaN } } } });
  assert.equal(nan.maxDurationMs, 1_200_000, 'NaN/非数 → 回退默认');
});

// ---- 引擎集成（T9/T10/T11/T12 + 验收 5：不改 lane 状态）----
// 注入时钟驱动时长：dispatch 在真实 now 落下（事件 ts），引擎 now = 基准 + 偏移。
function engineAt({ root, store, config, base, offsetMs }) {
  return hb(store, root, config, { now: () => base + offsetMs });
}

test('T9 tick 命中 → 恰 1 事件 + 1 broadcast（载荷齐全）；不改 lane 状态', () => {
  const { root, store, S, batchId, lane } = setup();
  const base = Date.now();
  const config = { capabilities: { watch: { enabled: true } } }; // longrun 缺省默认开
  // 先 tick 一拍建立心跳 entry（fresh grace 不会误杀——见 longrunLastActivityAt 基线兜底）
  const e1 = engineAt({ root, store, config, base, offsetMs: 0 });
  e1.tick();
  // 推进 26min：duration 超 20min、5min 窗内无 checkpoint/活动
  const e2 = engineAt({ root, store, config, base, offsetMs: 26 * 60_000 });
  e2.tick();
  const evs = candEvents(store, S, batchId, lane);
  assert.equal(evs.length, 1, '恰 1 条 lane.longrun.candidate');
  const ev = evs[0];
  assert.equal(ev.lane, lane);
  assert.equal(ev.reason, 'duration-exceeded-no-progress');
  assert.equal(typeof ev.runningSince, 'string');
  assert.equal(ev.durationMs > 1_200_000, true, 'duration 超 20min');
  assert.equal(ev.maxDurationMs, 1_200_000);
  assert.equal(ev.noProgressWindowMs, 300_000);
  assert.equal(ev.checkpointFresh, false);
  assert.equal(ev.activityFresh, false);
  // broadcast 双通道：恰 1 条候选消息（kind=longrun.candidate，载荷齐全）
  const bc = bcastItems(root, S, batchId);
  const cand = bc.filter((m) => m.message?.kind === 'longrun.candidate' && m.message.lane === lane);
  assert.equal(cand.length, 1, 'broadcast 恰 1 条候选');
  assert.equal(cand[0].message.batchId, batchId);
  assert.equal(cand[0].message.durationMs, ev.durationMs);
  assert.equal(cand[0].message.reason, 'duration-exceeded-no-progress');
  // 验收 5：探针不改 lane 状态（batch.lanes[lane] 仍 running；无成员迁移事件新增）
  const b = store.readBatch(S, batchId);
  assert.equal(b.lanes[lane], 'running');
  assert.equal(store.readBatch(S, batchId).events.filter((x) => x.type === EVT_MEMBER_SETTLED && x.lane === lane).length, 1, '无新增 settle（不改状态）');
});

test('T10 去重：同 stint 后续 tick 不再产事件/消息', () => {
  const { root, store, S, batchId, lane } = setup();
  const base = Date.now();
  const config = { capabilities: { watch: { enabled: true } } };
  engineAt({ root, store, config, base, offsetMs: 0 }).tick(); // 建 entry
  const e = engineAt({ root, store, config, base, offsetMs: 27 * 60_000 });
  e.tick(); // 产候选
  e.tick(); // 同 stint 再扫（+0 秒）
  assert.equal(candEvents(store, S, batchId, lane).length, 1);
  assert.equal(bcastItems(root, S, batchId).filter((m) => m.message?.kind === 'longrun.candidate').length, 1);
});

test('T11 跨重启幂等：状态表清空后重扫同 stint → 事件流去重，不再产', () => {
  const { root, store, S, batchId, lane } = setup();
  const base = Date.now();
  const config = { capabilities: { watch: { enabled: true } } };
  engineAt({ root, store, config, base, offsetMs: 0 }).tick();
  engineAt({ root, store, config, base, offsetMs: 28 * 60_000 }).tick(); // 产候选（引擎 A）
  assert.equal(candEvents(store, S, batchId, lane).length, 1);
  // 引擎 B（新状态表 = 模拟重启）：先 tick 建 entry，再推进——事件流已有同 runningSince 候选 → skip
  const b1 = engineAt({ root, store, config, base, offsetMs: 0 });
  b1.tick();
  const b2 = engineAt({ root, store, config, base, offsetMs: 40 * 60_000 });
  b2.tick();
  assert.equal(candEvents(store, S, batchId, lane).length, 1, '跨重启不重复产候选');
  assert.equal(bcastItems(root, S, batchId).filter((m) => m.message?.kind === 'longrun.candidate').length, 1);
});

test('T12 引擎层 stint 重置：结算后重派（新 dispatch）再超时 → 可再次产候选', () => {
  const { root, store, S, batchId, lane } = setup();
  const base = Date.now();
  const config = { capabilities: { watch: { enabled: true } } };
  engineAt({ root, store, config, base, offsetMs: 0 }).tick();
  const e1 = engineAt({ root, store, config, base, offsetMs: 26 * 60_000 });
  e1.tick(); // stint1 候选
  assert.equal(candEvents(store, S, batchId, lane).length, 1);
  // 模拟恢复 + 重派：running→idle（system.recovered）→ idle→running（新 settled-running 事件 = 新 stint 起点）
  store.recoverBatches();
  store.setMember(S, batchId, lane, 'running');
  const base2 = Date.now();
  engineAt({ root, store, config, base: base2, offsetMs: 0 }).tick();
  const e2 = engineAt({ root, store, config, base: base2, offsetMs: 26 * 60_000 });
  e2.tick();
  assert.equal(candEvents(store, S, batchId, lane).length, 2, '新 stint 再超时可再次产候选');
});

test('验收 5b：lane 状态与 schema 零改动（无新增成员态；stalled 档行为不受影响）', () => {
  const { root, store, S, batchId, lane } = setup();
  const base = Date.now();
  const config = { capabilities: { watch: { enabled: true } } };
  engineAt({ root, store, config, base, offsetMs: 0 }).tick();
  const e = engineAt({ root, store, config, base, offsetMs: 26 * 60_000 });
  e.tick();
  const b = store.readBatch(S, batchId);
  assert.equal(b.lanes[lane], 'running');
  // stalled 档不受 longrun 影响：无 lane.stalled（时长长但不在心跳退避追问语义内多次触发）
  assert.equal(b.events.filter((x) => x.type === 'lane.stalled').length, 0);
  // 引擎状态只读 API 可用
  const st = e.longrunStatus(S, batchId, lane, Date.now());
  assert.equal(st.candidate, false); // 查询即时判定：当前未再超（时间点在候选后不久）
  assert.equal(typeof st.emitted, 'boolean');
});

// ---- 工具面（lane_longrun：对齐 lane_heartbeat 形态；出厂默认开；显式关不注册）----
test('T14 lane_longrun 注册门控：缺省默认开注册（并列 1 件）；longrun 显式关不注册；watch 关亦不注册', () => {
  const { root, store } = setup();
  const ctx = { tools: { register: () => {} } };
  const def = createLongrunTools(ctx, { store, root, config: {} });
  assert.equal(def.length, 1, '出厂默认开 → lane_longrun 注册');
  assert.equal(def[0].name, 'lane_longrun');
  assert.deepEqual(createLongrunTools(ctx, { store, root, config: { capabilities: { watch: { longrun: { enabled: false } } } } }), [], 'longrun.enabled=false 不注册');
  assert.deepEqual(createLongrunTools(ctx, { store, root, config: { capabilities: { watch: { enabled: false } } } }), [], 'watch 关 → 不注册');
  // lane_heartbeat 输出零变化（对照基线：仍恰 1 件 lane_heartbeat）
  const hbTools = createHeartbeatTools(ctx, { store, root, config: {} });
  assert.equal(hbTools.length, 1);
  assert.equal(hbTools[0].name, 'lane_heartbeat');
});

test('lane_longrun 查询：返回探针状态；beat=true 手动触发一拍（并列 stalled+longrun）', async () => {
  const { root, store, S, batchId, lane } = setup();
  const base = Date.now();
  const config = { capabilities: { watch: { enabled: true } } };
  const engine = engineAt({ root, store, config, base, offsetMs: 0 });
  const ctx = { tools: { register: () => {} } };
  const [tool] = createLongrunTools(ctx, { store, root, config, heartbeat: engine });
  const exec = { agent: { session: { id: S } } };
  const q = await tool.execute({ batchId }, exec);
  assert.equal(q.sessionId, S);
  assert.equal(q.lanes.length, 1);
  assert.equal(q.lanes[0].lane, lane);
  assert.equal(typeof q.lanes[0].candidate, 'boolean');
  // beat 手动一拍后仍可查询（无异常、零状态破坏）
  const qb = await tool.execute({ batchId, beat: true }, exec);
  assert.equal(qb.lanes.length, 1);
});

// ---- 回归锚点：默认开不影响既有 heartbeat/watch 行为（T15 局部锚；全套回归见 watch-heartbeat.test.js）----
test('T15 回归锚：longrun 默认开 + 活跃 lane（近窗活动）→ 不产候选、无 broadcast 噪音', () => {
  const { root, store, S, batchId, lane } = setup();
  const base = Date.now();
  const config = { capabilities: { watch: { enabled: true } } };
  const e = engineAt({ root, store, config, base, offsetMs: 0 });
  e.tick();
  // 声明产物 mtime 落在引擎 nowTs(=base+21min) 的近窗内（base+20min，即 1min 前）→ 活动信号新鲜 → AND 抑制候选
  const out = path.join(store.artifactsDirOf(S, batchId), 'exec', 'l1', 'out.txt');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'v1');
  fs.utimesSync(out, new Date(base + 20 * 60_000), new Date(base + 20 * 60_000));
  const e2 = engineAt({ root, store, config, base, offsetMs: 21 * 60_000 });
  e2.tick();
  assert.equal(candEvents(store, S, batchId, lane).length, 0, '近窗有活动 → 不误报');
  assert.equal(bcastItems(root, S, batchId).filter((m) => m.message?.kind === 'longrun.candidate').length, 0);
});
