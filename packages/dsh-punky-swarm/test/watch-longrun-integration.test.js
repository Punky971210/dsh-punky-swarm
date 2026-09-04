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

// lane_longrun 探针集成测试补足（exec 层 tester 独立文件，不改产品代码、不改 coder 既有单测文件）
// 覆盖（task lane_longrun 集成项，engine/mailbox 工具/配置真面）：
//   IT-A  Manager 读面：候选经 mailbox_read(box='broadcast') 可达（T16 工具面），载荷齐全；ack 后不再返回；
//   IT-B  broadcast 方向：候选只入 broadcast，inbox/outbox 无候选（inbox 仅含既有 probe 下行追问）；
//   IT-C  默认开零误报：短任务（duration < maxDuration）不触发、无 broadcast 噪音；
//   IT-D  默认开零误报：活跃长跑（时长超阈值但近窗有新 checkpoint 事件）不触发（reason=checkpoint-fresh）；
//   IT-E  严格 AND 边界：有活动（outbox 未 ack）无 checkpoint → 不触发（reason=activity-fresh，定案 AND）；
//   IT-F  stint 重派重置：新 dispatch（runningSince 更新）后计时归零；再超时可再次候选（去重按 stint）；
//   IT-G  出厂默认开：空配置（无 capabilities.watch.longrun）tick 即探针可用（引擎路径 + lane_longrun 注册/查询）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import * as mailbox from '../lib/comms/mailbox.js';
import { createMailboxTools } from '../lib/tools/mailbox-tools.js';
import {
  createLaneHeartbeat, createLongrunTools,
  resolveLongrunConfig, LONGRUN_DEFAULTS, LONGRUN_REASON,
} from '../lib/watch/lane-heartbeat.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { EVT_LANE_LONGRUN_CANDIDATE, EVT_MEMBER_DISPATCH, EVT_MEMBER_SETTLED, EVT_WORKTREE_CHECKPOINT } from '../lib/state/event-types.js';

const MAX_D = LONGRUN_DEFAULTS.maxDurationMs; // 1200000（20min）
const WINDOW = LONGRUN_DEFAULTS.noProgressWindowMs; // 300000（5min）
const MIN = 60_000;

// ---- fixtures（与 watch-longrun.test.js 同构：真实 store + 真实 mailbox + 注入时钟）----
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-lri-'));
  const store = createStore(root);
  const S = 'sess-lri';
  const plan = buildWavePlan({ batchId: 'b-lri', tasks: [{ id: 'l1', outputs: ['exec/l1/out.txt'], cmd: 'work' }] });
  store.createBatch(S, { batchId: 'b-lri', wavePlan: plan, phase: 'running' });
  store.setMember(S, 'b-lri', 'l1', 'running'); // 首次派发：写 member.settled{to:running}，stint 起点 ≈ 真实 now
  return { root, store, S, batchId: 'b-lri', lane: 'l1' };
}
function hb(store, root, config = {}, opts = {}) {
  return createLaneHeartbeat({ store, mailbox, config, root, ...opts });
}
function candEvents(store, S, batchId, lane) {
  return (store.readBatch(S, batchId)?.events ?? []).filter((e) => e.type === EVT_LANE_LONGRUN_CANDIDATE && e.lane === lane);
}
function bcastItems(root, S, batchId) {
  return mailbox.readUnacked(path.join(root, 'sessions', S, 'mailbox', batchId), { type: 'broadcast' });
}
function inboxItems(root, S, batchId) {
  return mailbox.readUnacked(path.join(root, 'sessions', S, 'mailbox', batchId), { type: 'inbox' });
}
function outboxItems(root, S, batchId, lane) {
  return mailbox.readUnacked(path.join(root, 'sessions', S, 'mailbox', batchId), { type: 'outbox', lane });
}
function candOf(items) {
  return items.filter((m) => m.message?.kind === 'longrun.candidate');
}
// 批次 JSON 直写补丁（store.readBatch 每次读文件 = 唯一事实源）：追加指定 ts 的事件（伪造时钟场景用）
function appendEventAt(store, S, batchId, type, lane, atMs, extra = {}) {
  const f = store.batchFile(S, batchId);
  const b = JSON.parse(fs.readFileSync(f, 'utf8'));
  b.events.push({ ts: new Date(atMs).toISOString(), type, lane, ...extra });
  fs.writeFileSync(f, JSON.stringify(b, null, 2));
  return b;
}
// 同一引擎实例 + 可变偏移时钟（多拍场景保持内存表连续）
function timedEngine(store, root, config) {
  let off = 0;
  const base = Date.now();
  const e = hb(store, root, config, { now: () => base + off });
  return { base, engine: e, at: (offsetMs) => { off = offsetMs; return e; } };
}
// Manager 读侧工具（mailbox_read/mailbox_ack 真面；sessionOf 直取 args.session）
function managerTools(root, store) {
  const [send, read, ack] = createMailboxTools({}, { root, store, config: {} });
  return { send, read, ack };
}
const EXEC = { agent: { session: { id: 'cli' } } }; // args.session 优先生效，EXEC 仅兜底

// ---- IT-A Manager 读面：mailbox_read(broadcast) 可达 + ack 后不再返回（T16 工具面）----
test('IT-A Manager 读面：候选经 mailbox_read broadcast 可达且载荷齐全；ack 后不再返回', async () => {
  const { root, store, S, batchId, lane } = setup();
  const base = Date.now();
  const config = { capabilities: { watch: { enabled: true } } };
  hb(store, root, config, { now: () => base }).tick(); // 首拍建心跳 entry
  hb(store, root, config, { now: () => base + 26 * MIN }).tick(); // 26min：超阈值且无 checkpoint/活动 → 产候选
  const evs = candEvents(store, S, batchId, lane);
  assert.equal(evs.length, 1, '事件流恰 1 条候选');
  const ev = evs[0];
  const { read, ack } = managerTools(root, store);
  const r1 = await read.execute({ batchId, box: 'broadcast', session: S }, EXEC);
  const cand = candOf(r1.items).find((m) => m.message.lane === lane);
  assert.ok(cand, 'mailbox_read broadcast 能读到候选（Manager 读面）');
  const msg = cand.message;
  assert.equal(msg.kind, 'longrun.candidate');
  assert.equal(msg.sessionId, S);
  assert.equal(msg.batchId, batchId);
  assert.equal(msg.lane, lane);
  assert.equal(msg.reason, LONGRUN_REASON);
  assert.equal(msg.durationMs, ev.durationMs, 'broadcast 与事件载荷一致');
  assert.equal(msg.maxDurationMs, MAX_D);
  assert.equal(msg.noProgressWindowMs, WINDOW);
  assert.equal(typeof msg.runningSince, 'string');
  assert.equal(msg.checkpointFresh, false);
  assert.equal(msg.activityFresh, false);
  assert.ok(cand.ackId, '候选消息带 ackId');
  const a = await ack.execute({ batchId, box: 'broadcast', ackId: cand.ackId, session: S }, EXEC);
  assert.equal(a.ok, true);
  const r2 = await read.execute({ batchId, box: 'broadcast', session: S }, EXEC);
  assert.equal(candOf(r2.items).filter((m) => m.message.lane === lane).length, 0, 'ack 后不再返回');
  assert.equal(candEvents(store, S, batchId, lane).length, 1, '事件留痕不受 ack 影响（Leader/审计面仍在）');
});

// ---- IT-B broadcast 方向：候选只入 broadcast；inbox/outbox 无候选 ----
test('IT-B 方向正确：候选只入 broadcast；inbox 仅既有 probe、outbox 无候选', () => {
  const { root, store, S, batchId, lane } = setup();
  const { base, engine, at } = timedEngine(store, root, { capabilities: { watch: { enabled: true } } });
  at(0).tick();
  at(26 * MIN).tick(); // 产候选 + 心跳首拍无活动 → probe 下行追问（tier0 ≥10min）
  assert.equal(candEvents(store, S, batchId, lane).length, 1);
  // inbox：可能有心跳 probe（下行流），但绝无 longrun.candidate
  const inb = inboxItems(root, S, batchId);
  assert.equal(candOf(inb).length, 0, 'inbox 无候选（下行流不混入）');
  assert.ok(inb.some((m) => m.message?.kind === 'probe' && m.message.lane === lane), 'inbox 含既有 probe 追问（方向对照）');
  // outbox：worker 未回执 → 空 → 无候选
  const outb = outboxItems(root, S, batchId, lane);
  assert.equal(outb.length, 0, 'outbox 空（无 worker 回执）');
  assert.equal(candOf(outb).length, 0, 'outbox 无候选');
  // broadcast：恰 1 条候选（唯一去向）
  assert.equal(candOf(bcastItems(root, S, batchId)).length, 1, 'broadcast 恰 1 条候选');
  assert.equal(base > 0, true);
});

// ---- IT-C 默认开零误报：短任务（duration < maxDuration）不触发 ----
test('IT-C 默认开零误报：短任务（<maxDuration）不触发、无候选事件无 broadcast 噪音', () => {
  const { root, store, S, batchId, lane } = setup();
  const { engine, at } = timedEngine(store, root, { capabilities: { watch: { enabled: true } } });
  at(0).tick();
  at(10 * MIN).tick(); // 10min < 20min
  assert.equal(candEvents(store, S, batchId, lane).length, 0, '10min 不触发');
  at(19 * MIN).tick(); // 19min < 20min（仍低于阈值）
  assert.equal(candEvents(store, S, batchId, lane).length, 0, '19min 仍不触发（严格 >）');
  assert.equal(candOf(bcastItems(root, S, batchId)).length, 0, 'broadcast 无候选消息');
  const b = store.readBatch(S, batchId);
  assert.equal(b.lanes[lane], 'running', 'lane 状态不变');
  assert.equal(b.events.filter((e) => e.type === EVT_LANE_LONGRUN_CANDIDATE).length, 0, '事件流零候选事件');
});

// ---- IT-D 默认开零误报：活跃长跑（时长超阈值但近窗有新 checkpoint）不触发 ----
test('IT-D 默认开零误报：长跑超阈值但近窗有新 checkpoint → 不候选（reason=checkpoint-fresh）', () => {
  const { root, store, S, batchId, lane } = setup();
  const base = Date.now();
  // 注入近窗 checkpoint（事件流直写：真实 tick 引擎读事件流，时间轴用伪造 ts 对齐注入时钟）
  appendEventAt(store, S, batchId, EVT_WORKTREE_CHECKPOINT, lane, base + 20 * MIN, { message: 'cp-progress' });
  const e = hb(store, root, { capabilities: { watch: { enabled: true } } }, { now: () => base + 21 * MIN });
  e.tick(); // 时长 21min > 20min；checkpoint 在 1min 前（<5min 窗）→ 有进展 → AND 抑制
  assert.equal(candEvents(store, S, batchId, lane).length, 0, '近窗 checkpoint → 不误报');
  assert.equal(candOf(bcastItems(root, S, batchId)).length, 0, 'broadcast 无噪音');
  const st = e.longrunStatus(S, batchId, lane, base + 21 * MIN);
  assert.equal(st.candidate, false);
  assert.equal(st.reason, 'checkpoint-fresh', '进展信号 = checkpoint（reason 归因正确）');
  assert.equal(st.checkpointFresh, true);
  assert.equal(store.readBatch(S, batchId).lanes[lane], 'running');
});

// ---- IT-E 严格 AND 边界：有活动（outbox 未 ack）无 checkpoint → 不触发（reason=activity-fresh）----
test('IT-E 严格 AND 边界：有活动无 checkpoint → 不触发（定案 AND；reason=activity-fresh）', () => {
  const { root, store, S, batchId, lane } = setup();
  const { engine, at } = timedEngine(store, root, { capabilities: { watch: { enabled: true } } });
  at(0).tick();
  // worker 经 outbox 回执（未 ack = 活动信号；lane 无任何 checkpoint 事件）
  mailbox.send(path.join(root, 'sessions', S, 'mailbox', batchId), { type: 'outbox', lane }, { kind: 'worker.report', lane, text: 'working…' });
  at(2 * MIN).tick(); // 心跳扫描检出 outbox → reset（lastActivityAt=+2min）
  at(4 * MIN).tick();
  at(18 * MIN).tick(); // 持续刷新活动（18min 仍 < 阈值，仅建活动记忆）
  at(21 * MIN).tick(); // 时长 21min > 20min，但近 3min 有活动 → AND 抑制
  assert.equal(candEvents(store, S, batchId, lane).length, 0, '有活动无 checkpoint → 不候选（AND）');
  assert.equal(candOf(bcastItems(root, S, batchId)).length, 0, 'broadcast 无噪音');
  assert.ok(outboxItems(root, S, batchId, lane).length > 0, 'outbox 未 ack 回执仍在（活动信号来源）');
  const st = engine.longrunStatus(S, batchId, lane, null);
  assert.equal(st.candidate, false);
  assert.equal(st.reason, 'activity-fresh', 'AND 归因：活动新鲜（非 checkpoint）');
  assert.equal(st.activityFresh, true);
  assert.equal(st.checkpointFresh, false, '无 checkpoint 历史（活动单独不足以触发）');
});

// ---- IT-F stint 重派重置：新 dispatch 后计时归零；再超时可再次候选（去重按 stint）----
test('IT-F stint 重派重置：新 dispatch → 计时归零；再超时按新 stint 再次候选', () => {
  const { root, store, S, batchId, lane } = setup();
  const { base, engine, at } = timedEngine(store, root, { capabilities: { watch: { enabled: true } } });
  at(0).tick();
  at(21 * MIN).tick(); // stint1：21min 超阈值 → 候选 #1
  assert.equal(candEvents(store, S, batchId, lane).length, 1);
  assert.equal(candOf(bcastItems(root, S, batchId)).length, 1);
  // 重派：Leader 中断旧 worker 后新 dispatch（dispatch-register 同款事件；伪造 ts 对齐注入时钟）
  appendEventAt(store, S, batchId, EVT_MEMBER_DISPATCH, lane, base + 22 * MIN, { workerSessionId: 'w2' });
  at(24 * MIN).tick(); // 新 stint 仅 2min → 计时归零，不产新候选
  assert.equal(candEvents(store, S, batchId, lane).length, 1, '重派后 2min 不接续旧 stint 时长');
  const st1 = engine.longrunStatus(S, batchId, lane, base + 24 * MIN);
  assert.equal(st1.candidate, false);
  assert.ok(st1.durationMs < 3 * MIN, '重派后 duration 归零量级（' + st1.durationMs + 'ms）');
  assert.ok(st1.runningSinceTs >= base + 22 * MIN, 'runningSince 更新为新 dispatch');
  at(43 * MIN).tick(); // 新 stint 21min（43-22）再超阈值 → 候选 #2（新 stint 去重键）
  const evs2 = candEvents(store, S, batchId, lane);
  assert.equal(evs2.length, 2, '新 stint 再超时可再次候选');
  assert.equal(candOf(bcastItems(root, S, batchId)).length, 2, 'broadcast 两期各 1 条');
  const sinceSet = new Set(evs2.map((e2) => Date.parse(e2.runningSince)));
  assert.equal(sinceSet.size, 2, '两期候选 runningSince 互异（按 stint 去重）');
});

// ---- IT-G 出厂默认开：空配置（无 capabilities.watch.longrun）tick 即探针可用 ----
test('IT-G 出厂默认开：resolveLongrunConfig({}) enabled=true；空配置引擎 tick 产候选 + lane_longrun 注册/查询可用', async () => {
  const d = resolveLongrunConfig({});
  assert.equal(d.enabled, true, '缺省 enabled=true（定案默认开）');
  // 空配置 + 25min 前派发的 running stint：直写批次文件（不经 setMember——其真实 settled ts ≈ now 会覆盖伪造时间轴）
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-lrig-'));
  const store = createStore(root);
  const S = 'sess-lri-g';
  const batchId = 'b-lri-g';
  const lane = 'l1';
  const plan = buildWavePlan({ batchId, tasks: [{ id: lane, outputs: ['exec/l1/out.txt'], cmd: 'work' }] });
  store.createBatch(S, { batchId, wavePlan: plan, phase: 'running' });
  const bf = store.batchFile(S, batchId);
  const b0 = JSON.parse(fs.readFileSync(bf, 'utf8'));
  b0.lanes[lane] = 'running'; // plan 初态 pending → running（直写）
  b0.events.push({ ts: new Date(Date.now() - 25 * MIN).toISOString(), type: EVT_MEMBER_DISPATCH, lane, workerSessionId: 'w1' });
  fs.writeFileSync(bf, JSON.stringify(b0, null, 2));
  const engine = hb(store, root, {}); // 空配置：出厂默认开路径（无 capabilities.watch.longrun 键）
  engine.tick();
  assert.equal(candEvents(store, S, batchId, lane).length, 1, '空配置 tick 即产候选（默认开）');
  assert.equal(candOf(bcastItems(root, S, batchId)).length, 1);
  // lane_longrun 注册可用 + 查询回显 emitted
  const ctx = { tools: { register: () => {} } };
  const tools = createLongrunTools(ctx, { store, root, config: {}, heartbeat: engine });
  assert.equal(tools.length, 1, '空配置 → lane_longrun 注册（默认开）');
  assert.equal(tools[0].name, 'lane_longrun');
  const q = await tools[0].execute({ batchId, session: S }, EXEC);
  assert.equal(q.sessionId, S);
  const row = q.lanes.find((x) => x.lane === lane);
  assert.ok(row, '查询返回探针状态行');
  assert.equal(row.enabled, true, '空配置 → longrun 默认开');
  assert.equal(row.maxDurationMs, MAX_D, '默认阈值 20min 生效');
  assert.equal(row.noProgressWindowMs, WINDOW, '默认无进展窗 5min 生效');
  assert.equal(row.emitted, true, '事件流已产候选 → emitted=true');
  // 注：tick 产候选后心跳扫描已建 fresh entry（重启宽限，lastActivityAt≈now）→ 查询即时判定 candidate 可为 false
  //（activity-fresh 属既有宽限语义，非回归）；候选事实由事件流 + emitted 回显保证。
  assert.equal(candEvents(store, S, batchId, lane).length, 1, '事件流恰 1 条候选（最终事实源）');
});
