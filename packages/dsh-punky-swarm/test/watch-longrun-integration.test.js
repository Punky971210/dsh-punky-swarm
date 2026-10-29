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
// B1：lib/tools/mailbox-tools.js 已整件删除（createMailboxTools 随之消失）
import {
  // B1：createLongrunTools 已随工具删除
  resolveLongrunConfig, LONGRUN_DEFAULTS, LONGRUN_REASON,
} from '../lib/watch/lane-heartbeat.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { EVT_LANE_LONGRUN_CANDIDATE, EVT_MEMBER_DISPATCH, EVT_MEMBER_SETTLED, EVT_WORKTREE_CHECKPOINT } from '../lib/state/event-types.js';
import { laneHeartbeat } from './helpers/watch-fixture.mjs';

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
  const e = laneHeartbeat(store, root, config, { now: () => base + off });
  return { base, engine: e, at: (offsetMs) => { off = offsetMs; return e; } };
}
// Manager 读侧工具（mailbox_read/mailbox_ack 真面；sessionOf 直取 args.session）
function managerTools(root, store) {
  const [send, read, ack] = createMailboxTools({}, { root, store, config: {} });
  return { send, read, ack };
}
const EXEC = { agent: { session: { id: 'cli' } } }; // args.session 优先生效，EXEC 仅兜底

// ---- IT-A Manager 读面：mailbox_read(broadcast) 可达 + ack 后不再返回（T16 工具面）----
// ---- IT-B 方向（D-3 双通道后修订）：候选入 broadcast + supervisor/inbox 双通道；outbox 无候选 ----
// 契约变更注记（本批 D-3）：原断言为「候选只入 broadcast，inbox 绝无候选」（单通道设计）。
//   用户裁决 D-3 = 候选除 broadcast 外**同时投 supervisor/inbox**（spec §3.7.2），本条断言随契约更新：
//   inbox 现应有**恰 1 条** longrun.candidate（channel:'inbox'，ackId 与 broadcast 那条独立），
//   broadcast 仍**恰 1 条**（既有单通道计数不因双投递变成 2 —— spec 验收 G28/G30）。
test('IT-B 方向（D-3 修订）：候选双通道 = broadcast + supervisor/inbox 各恰 1 条；outbox 无候选', () => {
  const { root, store, S, batchId, lane } = setup();
  const { base, engine, at } = timedEngine(store, root, { capabilities: { watch: { enabled: true } } });
  at(0).tick();
  at(26 * MIN).tick(); // 产候选 + 心跳首拍无活动 → probe 下行追问（tier0 ≥10min）
  assert.equal((candEvents(store, S, batchId, lane).map((e) => Date.parse(e.runningSince))).length, 1);
  // inbox：既有 probe（下行追问）+ D-3 新增的候选副本（channel:'inbox'）
  const inb = inboxItems(root, S, batchId);
  const inbCand = candOf(inb);
  assert.deepEqual(inbCand.map((m) => m.message?.lane), [lane], 'inbox 候选身份 = 本次 lane（D-3 双通道；期望取自 setup）');
  assert.equal(inbCand[0].message.channel, 'inbox', 'inbox 那条带 channel 标记（可辨通道）');
  assert.ok(inbCand[0].ackId, 'inbox 候选带自身 ackId（记录级；与 broadcast 独立）');
  assert.ok(inb.some((m) => m.message?.kind === 'probe' && m.message.lane === lane), 'inbox 仍含既有 probe 追问（方向对照）');
  // outbox：worker 未回执 → 空 → 无候选
  const outb = outboxItems(root, S, batchId, lane);
  assert.deepEqual(outb, [], 'outbox 空（空集契约：整数组逐项，不数个数）');
  assert.deepEqual(candOf(outb), [], 'outbox 无候选（空集契约）');
  // broadcast：恰 1 条候选（D-3 不改变既有单通道计数）
  const bc = candOf(bcastItems(root, S, batchId));
  assert.deepEqual(bc.map((m) => m.message?.lane), [lane], 'broadcast 候选身份 = 本次 lane（D-3 不改变单通道语义）');
  assert.notEqual(bc[0].ackId, inbCand[0].message.ackId, '两通道 ackId 独立');
  assert.equal(base > 0, true);
});

// ---- IT-C 默认开零误报：短任务（duration < maxDuration）不触发 ----
test('IT-C 默认开零误报：短任务（<maxDuration）不触发、无候选事件无 broadcast 噪音', () => {
  const { root, store, S, batchId, lane } = setup();
  const { engine, at } = timedEngine(store, root, { capabilities: { watch: { enabled: true } } });
  at(0).tick();
  const candBefore = candEvents(store, S, batchId, lane).length; // 时点基线（P2 增量；M-2 授权）
  at(10 * MIN).tick(); // 10min < 20min
  assert.equal(candEvents(store, S, batchId, lane).length - candBefore, 0, '相对基线**增量 0**（10min 未触发；两时点差，不写死总数）');
  at(19 * MIN).tick(); // 19min < 20min（仍低于阈值）
  assert.equal(candEvents(store, S, batchId, lane).length, 0, '19min 仍不触发（严格 >）');
  assert.deepEqual(candOf(bcastItems(root, S, batchId)), [], 'broadcast 无候选消息（空集契约）');
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
  const e = laneHeartbeat(store, root, { capabilities: { watch: { enabled: true } } }, { now: () => base + 21 * MIN });
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
  const candBefore2 = candEvents(store, S, batchId, lane).length; // 时点基线（P2 增量；M-2 授权）
  at(2 * MIN).tick(); // 心跳扫描检出 outbox → reset（lastActivityAt=+2min）
  at(4 * MIN).tick();
  at(18 * MIN).tick(); // 持续刷新活动（18min 仍 < 阈值，仅建活动记忆）
  at(21 * MIN).tick(); // 时长 21min > 20min，但近 3min 有活动 → AND 抑制
  assert.equal(candEvents(store, S, batchId, lane).length - candBefore2, 0, '相对基线**增量 0**（有活动无 checkpoint ⇒ AND 抑制；两时点差）');
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
  assert.equal((candEvents(store, S, batchId, lane).map((e) => Date.parse(e.runningSince))).length, 1);
  assert.deepEqual(candOf(bcastItems(root, S, batchId)).map((m) => m.message?.lane), [lane], 'broadcast 候选身份 = 本次 lane');
  // 重派：Leader 中断旧 worker 后新 dispatch（dispatch-register 同款事件；伪造 ts 对齐注入时钟）
  appendEventAt(store, S, batchId, EVT_MEMBER_DISPATCH, lane, base + 22 * MIN, { workerSessionId: 'w2' });
  at(24 * MIN).tick(); // 新 stint 仅 2min → 计时归零，不产新候选
  assert.equal((candEvents(store, S, batchId, lane).map((e) => Date.parse(e.runningSince))).length, 1, '重派后 2min 不接续旧 stint 时长');
  const st1 = engine.longrunStatus(S, batchId, lane, base + 24 * MIN);
  assert.equal(st1.candidate, false);
  assert.ok(st1.durationMs < 3 * MIN, '重派后 duration 归零量级（' + st1.durationMs + 'ms）');
  assert.ok(st1.runningSinceTs >= base + 22 * MIN, 'runningSince 更新为新 dispatch');
  at(43 * MIN).tick(); // 新 stint 21min（43-22）再超阈值 → 候选 #2（新 stint 去重键）
  const evs2 = candEvents(store, S, batchId, lane);
  // 期望值来自输入侧：两期 stint（base+0 与 appendEventAt 的 base+22min 重派）⇒ runningSince 身份集须两期互异
  const stints = evs2.map((e) => Date.parse(e.runningSince));
  // 第一期 runningSince 的**精确值由引擎时钟决定**（实测比 base 晚 2ms）⇒ 不写死；只锁「存在且早于重派时点」
  assert.deepEqual(stints.length > 1 ? [stints[1]] : [], [base + 22 * MIN], '第二期 runningSince = 重派注入的 base+22min（输入侧精确值）');
  assert.equal(stints.length === 2 && stints[0] < base + 22 * MIN, true, '第一期 runningSince 存在且早于重派时点（两期互异；精确值不写死）');
  assert.notEqual(stints[0], stints[1], '两期候选 runningSince 必须互异（同一 stint 重复产两期 ⇒ 两值相同 ⇒ 红；不数个数）');
  const bcStints = candOf(bcastItems(root, S, batchId)).map((m) => m.message?.runningSince);
  assert.deepEqual([...new Set(bcStints)].sort(), [...new Set(stints.map((t) => new Date(t).toISOString()))].sort(), 'broadcast 两期身份集合 === 事件流两期集合（跨面一致；换一条即红）');
  // 已删：new Set(bcast runningSince).size === 2 —— 邻近 :237 的跨面集合断言（broadcast 集合 === 事件流集合）已覆盖同一职能（本条只是它的单侧计数形式）
  assert.deepEqual([...new Set(evs2.map((e2) => Date.parse(e2.runningSince)))].sort(), [...new Set(stints)].sort(), '两期 runningSince 去重后的身份集合 === 原始两值（同值去重会变 1 ⇒ 红）');
  assert.equal(stints.every((t) => Number.isFinite(t)), true, '两期 runningSince 均可解析为有限时间戳（Date.parse 非 NaN）');
});

// ---- IT-G 出厂默认开：空配置（无 capabilities.watch.longrun）tick 即探针可用 ----
