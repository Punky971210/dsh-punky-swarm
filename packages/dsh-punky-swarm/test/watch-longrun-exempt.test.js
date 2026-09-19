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

// watch 域 longrun 档「长程豁免 + D-2/D-3/D-4 + AN-3 假阳性修复」单测（本批新增）
// 按 plan/spec.md 的「验收标准」D/E/F/G/H/I 组逐条覆盖：
//   D 探针判定（豁免倍率 / exempt-active / noProgressWindowMs 未被放宽 / 查询透出）；
//   E stalled 豁免（不追问不标记、仍写 checkpoint、非豁免 lane 不受波及、tracked 保留）；
//   F D-2 候选消费超时（isAcked 判据 / 单次纪律 / 0 关闭）；
//   G D-3 双通道投递（broadcast + supervisor/inbox 各 1 条、ackId 独立、事件载荷锚 broadcast）；
//   H D-4 僵尸批过滤（末事件超阈 → 整批跳过 / 缺 events 回退 updatedAt / 0 = 逃生阀）；
//   I 配置面（两新键透传 / 非法回退 / 显式 0 不被当非法）；
//   AN-3 假阳性修复（磁盘进度快照 mtime 计入活跃度与 checkpoint 新鲜度——「有快照无 checkpoint 事件」不判候选）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import * as mailbox from '../lib/comms/mailbox.js';
import {
  createLaneHeartbeat, createLongrunTools,
  judgeLongrun, lastProgressTsOf, isStaleBatch, lastEventTsOf,
  hasLongrunUnconsumed, longrunCandidateOf,
  resolveLongrunConfig, LONGRUN_DEFAULTS,
} from '../lib/watch/lane-heartbeat.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import {
  EVT_LANE_LONGRUN_CANDIDATE, EVT_LANE_LONGRUN_UNCONSUMED, EVT_LANE_STALLED,
  EVT_MEMBER_DISPATCH, EVT_WORKTREE_CHECKPOINT,
} from '../lib/state/event-types.js';
import {
  LANE_EXEMPT_TIERS, EXEMPT_GATE_CODES,
} from '../lib/state/lane-exempt.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const MAX_D = LONGRUN_DEFAULTS.maxDurationMs; // 1_200_000
const WINDOW = LONGRUN_DEFAULTS.noProgressWindowMs; // 300_000
const mkEv = (tsMs, type, fields = {}) => ({ ts: new Date(tsMs).toISOString(), type, ...fields });

// ── 夹具 ──
function tmpRoot(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'punky-lrex-' + tag + '-')); }
function hb(store, root, config = {}, opts = {}) {
  return createLaneHeartbeat({ store, mailbox, config, root, ...opts });
}
const boxRoot = (root, S, batchId) => path.join(root, 'sessions', S, 'mailbox', batchId);
const inboxItems = (root, S, batchId) => mailbox.readUnacked(boxRoot(root, S, batchId), { type: 'inbox' });
const bcastItems = (root, S, batchId) => mailbox.readUnacked(boxRoot(root, S, batchId), { type: 'broadcast' });
const candOf = (items) => items.filter((m) => m.message?.kind === 'longrun.candidate');
const evsOf = (store, S, batchId, type, lane) =>
  (store.readBatch(S, batchId)?.events ?? []).filter((e) => e.type === type && (lane === undefined || e.lane === lane));

// 直写批次（伪造时间轴；setMember 的真实 ts 会覆盖伪造事件轴，故 lanes/events 直接写文件——沿用既有 seedDispatch 先例）
function seedBatch(root, { S, batchId, lanes, events, updatedAt = null, laneExempt = undefined }) {
  const store = createStore(root);
  const plan = buildWavePlan({
    batchId,
    tasks: Object.keys(lanes).map((id) => ({ id, outputs: ['exec/' + id + '/out.txt'], cmd: 'work' })),
  });
  store.createBatch(S, { batchId, wavePlan: plan, phase: 'running' });
  const bf = store.batchFile(S, batchId);
  const b = JSON.parse(fs.readFileSync(bf, 'utf8'));
  b.lanes = { ...lanes };
  b.events.push(...events);
  if (updatedAt !== null) b.updatedAt = new Date(updatedAt).toISOString();
  if (laneExempt !== undefined) b.laneExempt = laneExempt;
  fs.writeFileSync(bf, JSON.stringify(b, null, 2));
  return store;
}

// ── D 组：探针判定纳入豁免（验收 D16-D19）──
test('D16 豁免倍率放宽时长阈值：60s 阈值 + multiplier 4 → 200s 不候选（reason=exempt-active）、250s 候选', () => {
  const now = 1_800_000_000_000;
  const mk = (durS) => judgeLongrun({
    batch: { phase: 'running', lanes: { l1: 'running' }, events: [mkEv(now - durS * 1000, EVT_MEMBER_DISPATCH, { lane: 'l1' })] },
    lane: 'l1', nowTs: now, maxDurationMs: 60_000, noProgressWindowMs: 30_000,
    lastActivityAtMs: null, exempt: { type: 'ai-render', multiplier: 4, tierMultiplier: 8, stalled: true },
  });
  const v200 = mk(200);
  assert.equal(v200.candidate, false, '200s < 60s×4=240s → 不候选');
  assert.equal(v200.reason, 'exempt-active', 'reason 区分「豁免生效中」与「时长未超」（可观测性）');
  assert.equal(v200.effectiveMaxDurationMs, 240_000);
  assert.equal(v200.thresholdMultiplier, 4);
  assert.equal(v200.maxDurationMs, 60_000, '基础阈值字段保留（只增不改）');
  const v250 = mk(250);
  assert.equal(v250.candidate, true, '250s > 240s 且无 checkpoint/活动 → 候选');
  assert.equal(v250.reason, 'duration-exceeded-no-progress', '既有 reason 值一字不改（回归锚）');
});

test('D17 回归锚：无豁免 lane 同条件 61s 即候选（豁免不改未豁免 lane 的行为）', () => {
  const now = 1_800_000_000_000;
  const v = judgeLongrun({
    batch: { phase: 'running', lanes: { l1: 'running' }, events: [mkEv(now - 61_000, EVT_MEMBER_DISPATCH, { lane: 'l1' })] },
    lane: 'l1', nowTs: now, maxDurationMs: 60_000, noProgressWindowMs: 30_000, lastActivityAtMs: null,
  });
  assert.equal(v.candidate, true);
  assert.equal(v.exempt, null);
  assert.equal(v.effectiveMaxDurationMs, 60_000, '无豁免 → 有效阈值 = 基础阈值');
  assert.equal(v.thresholdMultiplier, 1);
});

test('D18 反例对照：豁免只放宽时长、不放宽 noProgressWindowMs（超有效阈值但 checkpoint 新鲜 → 不候选）', () => {
  const now = 1_800_000_000_000;
  const v = judgeLongrun({
    batch: {
      phase: 'running', lanes: { l1: 'running' },
      events: [
        mkEv(now - 500_000, EVT_MEMBER_DISPATCH, { lane: 'l1' }), // duration 500s > 240s（超有效阈值）
        mkEv(now - 60_000, EVT_WORKTREE_CHECKPOINT, { lane: 'l1' }), // 60s 前 checkpoint < 300s 窗 → fresh
      ],
    },
    lane: 'l1', nowTs: now, maxDurationMs: 60_000, noProgressWindowMs: WINDOW,
    lastActivityAtMs: null, exempt: { type: 'none', multiplier: 4, tierMultiplier: 4, stalled: true },
  });
  assert.equal(v.checkpointFresh, true);
  assert.equal(v.candidate, false);
  assert.equal(v.reason, 'checkpoint-fresh');
});

test('D19 lane_longrun 查询透出豁免态：豁免 lane 含 exempt/effectiveMaxDurationMs/thresholdMultiplier；未豁免为 null/基础/1', async () => {
  const root = tmpRoot('d19');
  const S = 's-d19';
  const batchId = 'b-d19';
  const now = Date.now();
  const store = seedBatch(root, {
    S, batchId, lanes: { l1: 'running', l2: 'running' },
    events: [mkEv(now - MAX_D - MIN, EVT_MEMBER_DISPATCH, { lane: 'l1' }), mkEv(now - MAX_D - MIN, EVT_MEMBER_DISPATCH, { lane: 'l2' })],
    laneExempt: { l1: { grantedAt: new Date(now).toISOString(), grantedFrom: 'pending', type: 'ai-render', multiplier: 8, tierMultiplier: 8, stalled: true } },
  });
  const engine = hb(store, root, {});
  const ctx = { tools: { register: () => {} } };
  const [tool] = createLongrunTools(ctx, { store, root, heartbeat: engine });
  const exec = { agent: { session: { id: S } } };
  const q = await tool.execute({ batchId }, exec);
  const r1 = q.lanes.find((r) => r.lane === 'l1');
  const r2 = q.lanes.find((r) => r.lane === 'l2');
  assert.equal(r1.exempt.type, 'ai-render');
  assert.equal(r1.exempt.multiplier, 8);
  assert.equal(r1.thresholdMultiplier, 8);
  assert.equal(r1.effectiveMaxDurationMs, MAX_D * 8);
  assert.equal(r2.exempt, null, '未豁免 lane：exempt = null');
  assert.equal(r2.thresholdMultiplier, 1);
  assert.equal(r2.effectiveMaxDurationMs, MAX_D, '未豁免 lane：有效阈值 = 基础阈值');
  engine.dispose();
});

// ── E 组：stalled 追问豁免（验收 E20-E23）──
// 引擎级场景：60s 阈值 + 0ms 追问档（每拍即追问），豁免 lane 连续 4 拍无活动
const FAST = { capabilities: { watch: { enabled: true, intervalsMinutes: [0, 0, 0], maxMissed: 3, longrun: { maxDurationMs: 60_000, noProgressWindowMs: 30_000 } } } };

test('E20/E23 豁免 lane（stalled:true）连续 ≥4 拍无活动：无 lane.stalled、inbox 无 probe、仍 tracked 且 missed=0', () => {
  const root = tmpRoot('e20');
  const S = 's-e20';
  const batchId = 'b-e20';
  const base = Date.now();
  const store = seedBatch(root, {
    S, batchId, lanes: { l1: 'running' },
    events: [mkEv(base - 10 * MIN, EVT_MEMBER_DISPATCH, { lane: 'l1' })],
    laneExempt: { l1: { grantedAt: new Date(base).toISOString(), grantedFrom: 'pending', type: 'large-download', multiplier: 6, tierMultiplier: 6, stalled: true } },
  });
  const e = hb(store, root, FAST, { now: () => base + 5 * MIN });
  e.tick(); // 首拍建 entry（活动基线对齐历史事件 ts → 不立即追问）
  for (let i = 0; i < 5; i++) e.tick(); // 连续多拍：豁免 lane 不得累计 missed/不得追问
  const b = store.readBatch(S, batchId);
  assert.equal(b.events.filter((x) => x.type === EVT_LANE_STALLED).length, 0, '豁免 lane 不写 lane.stalled（R-4）');
  assert.equal(inboxItems(root, S, batchId).filter((m) => m.message?.kind === 'probe').length, 0, '豁免 lane 不发 inbox 追问');
  const st = e.status(`${S}/${batchId}/l1`);
  assert.equal(st.tracked, true, '仍在心跳表内（仍可观测——不许因豁免变不可观测）');
  assert.equal(st.missed, 0, 'missed 不累计');
  assert.equal(st.stalled, false);
  e.dispose();
});

test('E21 豁免 lane 仍写 checkpoint：lane_checkpoint 写面零特判（worktree.checkpoint 事件照常落盘）', () => {
  const root = tmpRoot('e21');
  const S = 's-e21';
  const batchId = 'b-e21';
  const base = Date.now();
  const store = seedBatch(root, {
    S, batchId, lanes: { l1: 'running' },
    events: [mkEv(base - 10 * MIN, EVT_MEMBER_DISPATCH, { lane: 'l1' })],
    laneExempt: { l1: { grantedAt: new Date(base).toISOString(), grantedFrom: 'pending', type: 'ai-render', multiplier: 8, tierMultiplier: 8, stalled: true } },
  });
  const e = hb(store, root, FAST, { now: () => base + 5 * MIN });
  e.tick();
  for (let i = 0; i < 4; i++) e.tick();
  // 探针路径零改动 checkpoint 写面：直接 appendEvent（lane_checkpoint 工具的同一落点）照常可写
  store.appendEvent(S, batchId, EVT_WORKTREE_CHECKPOINT, { lane: 'l1', message: 'step 1/3' });
  assert.equal(evsOf(store, S, batchId, EVT_WORKTREE_CHECKPOINT, 'l1').length, 1, '豁免 lane 的 checkpoint 事件照常落盘');
  assert.equal(store.readBatch(S, batchId).events.filter((x) => x.type === EVT_LANE_STALLED).length, 0, '仍无 lane.stalled');
  e.dispose();
});

test('E22 回归锚：非豁免 lane 同设置下仍追问（≥maxMissed 拍）并写 lane.stalled；豁免不波及其他 lane', () => {
  const root = tmpRoot('e22');
  const S = 's-e22';
  const batchId = 'b-e22';
  const base = Date.now();
  const store = seedBatch(root, {
    S, batchId, lanes: { l1: 'running', l2: 'running' },
    events: [mkEv(base - 10 * MIN, EVT_MEMBER_DISPATCH, { lane: 'l1' }), mkEv(base - 10 * MIN, EVT_MEMBER_DISPATCH, { lane: 'l2' })],
    laneExempt: { l1: { grantedAt: new Date(base).toISOString(), grantedFrom: 'pending', type: 'dep-install', multiplier: 4, tierMultiplier: 4, stalled: true } },
  });
  const e = hb(store, root, FAST, { now: () => base + 5 * MIN });
  for (let i = 0; i < 4; i++) e.tick();
  const stalled = evsOf(store, S, batchId, EVT_LANE_STALLED);
  assert.equal(stalled.length, 1, '仅非豁免 lane l2 落 stalled');
  assert.equal(stalled[0].lane, 'l2');
  const probes = inboxItems(root, S, batchId).filter((m) => m.message?.kind === 'probe');
  assert.ok(probes.length >= 1, '非豁免 lane 追问照发');
  assert.equal(probes.every((m) => m.message.lane === 'l2'), true, '追问不波及豁免 lane');
  e.dispose();
});

// ── F 组：D-2 候选消费超时（验收 F24-F27）──
const D2CFG = (over = {}) => ({
  capabilities: { watch: { enabled: true, intervalsMinutes: [9999], longrun: { maxDurationMs: 60_000, noProgressWindowMs: 30_000, unconsumedTimeoutMs: 60_000, ...over } } },
});

test('F24/F29 D-2 产 unconsumed 事件（isAcked 判据）+ 事件载荷含 runningSince/emittedAt/elapsedMs/ackId（= broadcast 那条）', () => {
  const root = tmpRoot('f24');
  const S = 's-f24';
  const batchId = 'b-f24';
  const base = Date.now();
  const store = seedBatch(root, {
    S, batchId, lanes: { l1: 'running' },
    events: [mkEv(base - 90_000, EVT_MEMBER_DISPATCH, { lane: 'l1' })],
  });
  const e1 = hb(store, root, D2CFG(), { now: () => base });
  e1.tick(); // duration 90s > 60s → 产候选（broadcast + inbox 双投递）
  const cand = evsOf(store, S, batchId, EVT_LANE_LONGRUN_CANDIDATE, 'l1');
  assert.equal(cand.length, 1, 'D-3/G29：候选事件恰 1 条且带 ackId');
  assert.ok(cand[0].ackId, '候选事件载荷含 ackId（D-2 的句柄）');
  const bc = candOf(bcastItems(root, S, batchId));
  assert.equal(bc.length, 1);
  assert.equal(cand[0].ackId, bc[0].ackId, '事件载荷的 ackId = broadcast 那条（spec §3.7.2 锚定口径）');
  assert.equal(hasLongrunUnconsumed(store.readBatch(S, batchId), 'l1', Date.parse(cand[0].runningSince)), false, '未超时前无 unconsumed');
  // 推进时钟 61s > unconsumedTimeoutMs（不 ack）→ 独立趟产 unconsumed
  // 时基锚定：候选 ts 由 appendEvent 打真实 ts（≈ base + 十余 ms 落盘开销），故断言不写死
  // [61000,61500) 这种「把 base 当候选时刻」的假区间——下界须锚定候选 ts 自身（tick 时刻 - ts ≥ 60000）。
  const e2 = hb(store, root, D2CFG(), { now: () => base + 61_000 });
  e2.tick();
  const un = evsOf(store, S, batchId, EVT_LANE_LONGRUN_UNCONSUMED, 'l1');
  assert.equal(un.length, 1, '超时未 ack → 恰 1 条 lane.longrun.unconsumed');
  assert.equal(un[0].runningSince, cand[0].runningSince);
  assert.equal(un[0].emittedAt, cand[0].ts, 'emittedAt = 候选事件 ts');
  assert.ok(un[0].elapsedMs >= 60_000, 'elapsedMs ≥ unconsumedTimeoutMs（触发阈值的硬下界）');
  assert.ok(un[0].elapsedMs <= 61_000, 'elapsedMs ≤ 本拍推进量（上界 = now − base，实测 ' + un[0].elapsedMs + '）');
  assert.equal(un[0].elapsedMs, base + 61_000 - Date.parse(cand[0].ts), 'elapsedMs 逐字 = now − 候选事件 ts');
  assert.equal(un[0].unconsumedTimeoutMs, 60_000);
  assert.equal(un[0].ackId, cand[0].ackId);
  assert.equal(store.readBatch(S, batchId).lanes.l1, 'running', 'D-2 不改成员状态');
  e1.dispose(); e2.dispose();
});

test('F25 isAcked 判据：ack 候选 broadcast 后同条件 → 不产 unconsumed（对照 readUnacked 会永久误报）', () => {
  const root = tmpRoot('f25');
  const S = 's-f25';
  const batchId = 'b-f25';
  const base = Date.now();
  const store = seedBatch(root, {
    S, batchId, lanes: { l1: 'running' },
    events: [mkEv(base - 90_000, EVT_MEMBER_DISPATCH, { lane: 'l1' })],
  });
  const e1 = hb(store, root, D2CFG(), { now: () => base });
  e1.tick();
  const cand = evsOf(store, S, batchId, EVT_LANE_LONGRUN_CANDIDATE, 'l1')[0];
  // 消费方 ack broadcast 那条（ack 默认删原消息文件）
  mailbox.ack(boxRoot(root, S, batchId), { type: 'broadcast' }, cand.ackId);
  assert.equal(mailbox.isAcked(boxRoot(root, S, batchId), { type: 'broadcast' }, cand.ackId), true);
  assert.equal(mailbox.readUnacked(boxRoot(root, S, batchId), { type: 'broadcast' }).length, 0, 'ack 后 readUnacked 读不到（故不可用 readUnacked 判「未消费」）');
  const e2 = hb(store, root, D2CFG(), { now: () => base + 61_000 });
  e2.tick();
  assert.equal(evsOf(store, S, batchId, EVT_LANE_LONGRUN_UNCONSUMED).length, 0, '已消费 → 不产 unconsumed');
  e1.dispose(); e2.dispose();
});

test('F26 单次纪律：同 (lane,runningSince) 连续多拍仍只 1 条 unconsumed（跨引擎重建幂等）', () => {
  const root = tmpRoot('f26');
  const S = 's-f26';
  const batchId = 'b-f26';
  const base = Date.now();
  const store = seedBatch(root, {
    S, batchId, lanes: { l1: 'running' },
    events: [mkEv(base - 90_000, EVT_MEMBER_DISPATCH, { lane: 'l1' })],
  });
  hb(store, root, D2CFG(), { now: () => base }).tick();
  const e = hb(store, root, D2CFG(), { now: () => base + 61_000 });
  e.tick();
  e.tick();
  hb(store, root, D2CFG(), { now: () => base + 120_000 }).tick(); // 新引擎实例（模拟重建）
  assert.equal(evsOf(store, S, batchId, EVT_LANE_LONGRUN_UNCONSUMED, 'l1').length, 1, '同 stint 只产一次');
  e.dispose();
});

test('F27 逃生阀：unconsumedTimeoutMs=0 → D-2 关闭（永不产 unconsumed）；阈值非法回退默认', () => {
  const root = tmpRoot('f27');
  const S = 's-f27';
  const batchId = 'b-f27';
  const base = Date.now();
  const store = seedBatch(root, {
    S, batchId, lanes: { l1: 'running' },
    events: [mkEv(base - 90_000, EVT_MEMBER_DISPATCH, { lane: 'l1' })],
  });
  hb(store, root, D2CFG({ unconsumedTimeoutMs: 0 }), { now: () => base }).tick();
  assert.equal(evsOf(store, S, batchId, EVT_LANE_LONGRUN_CANDIDATE).length, 1, '候选照产（D-2 关闭不影响候选档）');
  hb(store, root, D2CFG({ unconsumedTimeoutMs: 0 }), { now: () => base + 10 * MIN }).tick();
  assert.equal(evsOf(store, S, batchId, EVT_LANE_LONGRUN_UNCONSUMED).length, 0, 'unconsumedTimeoutMs=0 → D-2 关闭');
});

// ── G 组：D-3 双通道投递（验收 G28-G30）──
test('G28/G30 候选双通道：broadcast 恰 1 条 + supervisor/inbox 恰 1 条（ackId 独立；broadcast 计数不因双投递变 2）', () => {
  const root = tmpRoot('g28');
  const S = 's-g28';
  const batchId = 'b-g28';
  const base = Date.now();
  const store = seedBatch(root, {
    S, batchId, lanes: { l1: 'running' },
    events: [mkEv(base - 90_000, EVT_MEMBER_DISPATCH, { lane: 'l1' })],
  });
  const e = hb(store, root, D2CFG(), { now: () => base });
  e.tick();
  const bc = candOf(bcastItems(root, S, batchId));
  const inb = candOf(inboxItems(root, S, batchId));
  assert.equal(bc.length, 1, 'broadcast 恰 1 条候选（D-3 不使既有计数变 2）');
  assert.equal(inb.length, 1, 'supervisor/inbox 恰 1 条候选（D-3 新增通道）');
  assert.equal(inb[0].message.channel, 'inbox', 'inbox 那条带通道标记');
  assert.notEqual(bc[0].ackId, inb[0].ackId, '两条投递各自 ackId 独立');
  assert.equal(bc[0].message.lane, inb[0].message.lane);
  assert.equal(bc[0].message.durationMs, inb[0].message.durationMs);
  e.dispose();
});

// ── H 组：D-4 僵尸批次过滤（验收 H31-H33）──
test('H31 僵尸批过滤：末事件 25h 前（A）与缺 events 但 updatedAt 25h 前（C）零候选；末事件 5min 前（B）照常产候选', () => {
  const root = tmpRoot('h31');
  const S = 's-h31';
  const now = Date.now();
  const lane = 'l1';
  const mkLane = () => ({ [lane]: 'running' });
  // A：末事件 25h 前（updatedAt 现刻 → 以末事件判定）
  seedBatch(root, { S, batchId: 'b-h31-a', lanes: mkLane(), events: [mkEv(now - 25 * HOUR, EVT_MEMBER_DISPATCH, { lane })], updatedAt: now });
  // B：末事件 5min 前（活跃批，同 lane 超时长阈值）
  seedBatch(root, { S, batchId: 'b-h31-b', lanes: mkLane(), events: [mkEv(now - 5 * MIN, EVT_MEMBER_DISPATCH, { lane })], updatedAt: now });
  // C：无 events 数组但 updatedAt 25h 前（回退路径）
  seedBatch(root, { S, batchId: 'b-h31-c', lanes: mkLane(), events: [], updatedAt: now - 25 * HOUR, laneExempt: undefined });
  const store = createStore(root);
  const cfg = { capabilities: { watch: { enabled: true, longrun: { maxDurationMs: 60_000, noProgressWindowMs: 30_000 } } } };
  hb(store, root, cfg, { now: () => now }).tick();
  assert.equal(evsOf(store, S, 'b-h31-a', EVT_LANE_LONGRUN_CANDIDATE).length, 0, 'A 僵尸批整批跳过（零候选）');
  assert.equal(evsOf(store, S, 'b-h31-b', EVT_LANE_LONGRUN_CANDIDATE).length, 1, 'B 活跃批照常产候选');
  assert.equal(evsOf(store, S, 'b-h31-c', EVT_LANE_LONGRUN_CANDIDATE).length, 0, 'C 缺 events → 回退 updatedAt 判僵尸');
});

test('H32 逃生阀：staleBatchMs=0 → 关闭过滤，僵尸批照常参与（候选照产）', () => {
  const root = tmpRoot('h32');
  const S = 's-h32';
  const now = Date.now();
  const store = seedBatch(root, {
    S, batchId: 'b-h32', lanes: { l1: 'running' },
    events: [mkEv(now - 25 * HOUR, EVT_MEMBER_DISPATCH, { lane: 'l1' })], updatedAt: now,
  });
  const cfg = { capabilities: { watch: { enabled: true, longrun: { maxDurationMs: 60_000, noProgressWindowMs: 30_000, staleBatchMs: 0 } } } };
  hb(store, root, cfg, { now: () => now }).tick();
  assert.equal(evsOf(store, S, 'b-h32', EVT_LANE_LONGRUN_CANDIDATE, 'l1').length, 1, 'staleBatchMs=0 → 过滤关闭（逃生阀有效）');
});

test('H33 回归：phase !== running 的批次与未超时的活跃批行为不变（不因 D-4 误跳）', () => {
  const root = tmpRoot('h33');
  const S = 's-h33';
  const now = Date.now();
  const lane = 'l1';
  const st = seedBatch(root, { S, batchId: 'b-h33-run', lanes: { [lane]: 'running' }, events: [mkEv(now - 5 * MIN, EVT_MEMBER_DISPATCH, { lane })], updatedAt: now });
  seedBatch(root, { S, batchId: 'b-h33-idle', lanes: { [lane]: 'idle' }, events: [mkEv(now - 5 * MIN, EVT_MEMBER_DISPATCH, { lane })], updatedAt: now });
  // 活跃批（末事件 5min 前）在默认 24h 阈值下不被判僵尸
  assert.equal(isStaleBatch(st.readBatch(S, 'b-h33-run'), now, LONGRUN_DEFAULTS.staleBatchMs), false);
  assert.equal(isStaleBatch(st.readBatch(S, 'b-h33-idle'), now, LONGRUN_DEFAULTS.staleBatchMs), false);
  const cfg = { capabilities: { watch: { enabled: true, longrun: { maxDurationMs: 60_000, noProgressWindowMs: 30_000 } } } };
  hb(st, root, cfg, { now: () => now }).tick();
  assert.equal(evsOf(st, S, 'b-h33-run', EVT_LANE_LONGRUN_CANDIDATE, lane).length, 1);
  assert.equal(evsOf(st, S, 'b-h33-idle', EVT_LANE_LONGRUN_CANDIDATE, lane).length, 0, '非 running lane 不扫');
  // 纯函数层：lastEventTsOf 回退 updatedAt
  assert.equal(lastEventTsOf({ events: [], updatedAt: new Date(12345).toISOString() }), 12345);
});

// ── I 组：配置面（验收 I35）──
test('I35 resolveLongrunConfig 两新键：合法透传 / 非法回退默认 / 显式 0 不被当非法（逃生阀）', () => {
  const d = resolveLongrunConfig({});
  assert.equal(d.staleBatchMs, 86_400_000);
  assert.equal(d.unconsumedTimeoutMs, 1_800_000);
  const custom = resolveLongrunConfig({ capabilities: { watch: { longrun: { staleBatchMs: 3_600_000, unconsumedTimeoutMs: 60_000 } } } });
  assert.equal(custom.staleBatchMs, 3_600_000);
  assert.equal(custom.unconsumedTimeoutMs, 60_000);
  const zero = resolveLongrunConfig({ capabilities: { watch: { longrun: { staleBatchMs: 0, unconsumedTimeoutMs: 0 } } } });
  assert.equal(zero.staleBatchMs, 0, '显式 0 = 关闭（不走 posMs 的 ≥1 判据回退默认）');
  assert.equal(zero.unconsumedTimeoutMs, 0, '显式 0 = 关闭');
  const bad = resolveLongrunConfig({ capabilities: { watch: { longrun: { staleBatchMs: -1, unconsumedTimeoutMs: 'abc' } } } });
  assert.equal(bad.staleBatchMs, 86_400_000, '负数非法 → 回退默认');
  assert.equal(bad.unconsumedTimeoutMs, 1_800_000, '非数非法 → 回退默认');
  const frac = resolveLongrunConfig({ capabilities: { watch: { longrun: { staleBatchMs: 1.5 } } } });
  assert.equal(frac.staleBatchMs, 1, '有限正数取整（与 posMs 同风格）');
});

// ── AN-3 假阳性修复（本批核心；实证「有磁盘 progress 快照但无 checkpoint 事件」不判候选）──
// 夹具口径：lane 起点 = base - 10min，引擎时钟 = base（duration 恰 10min ≫ 1min 阈值）；
//   快照 mtime = base - 2min，落在 5min 窗内 → 快照新鲜而**事件流零 checkpoint**。
//   对照（无快照）判候选 = 复现假阳性；实证（有快照）不判候选 = 修复生效。三用例（a/b/c/d）共用此口径。
test('AN3-a 纯函数：lastProgressTsOf 扫描 lane 产物目录（含子目录）取最新 mtime；缺目录/空目录 → null', () => {
  const root = tmpRoot('an3a');
  assert.equal(lastProgressTsOf(path.join(root, 'nope')), null, '目录不存在 → null（静默）');
  const dir = path.join(root, 'b-x', 'exec', 'lane1');
  fs.mkdirSync(path.join(dir, 'progress'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'progress', '01.md'), 'a');
  fs.writeFileSync(path.join(dir, 'progress', '12.md'), 'b');
  const t1 = 1_700_000_000_000;
  fs.utimesSync(path.join(dir, 'progress', '01.md'), new Date(t1), new Date(t1));
  fs.utimesSync(path.join(dir, 'progress', '12.md'), new Date(t1 + 5000), new Date(t1 + 5000));
  assert.equal(lastProgressTsOf(dir), t1 + 5000, '取最新快照 mtime');
  // 深度语义（修正上一轮的坏断言）：夹具在 dir 顶层只有 progress/ **目录**、没有文件，故 maxDepth:0
  //   （= 只读本目录文件、不下钻）返回 null 才是正确行为。要验「深度受限仍能读到顶层文件」，
  //   必须先在该层放一个文件——用顶层 *.md 补足前置条件后再断言。
  assert.equal(lastProgressTsOf(dir, { maxDepth: 0 }), null, '顶层无文件 → null（不下钻读 progress/）');
  const topMd = path.join(dir, '99-report.md');
  fs.writeFileSync(topMd, 'top');
  fs.utimesSync(topMd, new Date(t1 + 7000), new Date(t1 + 7000));
  assert.equal(lastProgressTsOf(dir, { maxDepth: 0 }) >= t1, true, '深度受限仍能读到顶层文件');
  assert.equal(lastProgressTsOf(dir, { maxDepth: 0 }), t1 + 7000, '顶层文件 mtime 命中');
  assert.equal(lastProgressTsOf(dir, { maxDepth: 0, onlyMarkdown: false }), t1 + 7000, 'default onlyMarkdown=false 不改变口径');
  assert.equal(lastProgressTsOf(dir), t1 + 7000, '默认深度扫描（含子树）取全树最新 = 顶层新文件');
  // onlyMarkdown 收窄口径：非 *.md 文件不计入（lane 根兜底扫描专用）
  const bin = path.join(dir, 'blob.bin');
  fs.writeFileSync(bin, 'bin');
  fs.utimesSync(bin, new Date(t1 + 9000), new Date(t1 + 9000));
  assert.equal(lastProgressTsOf(dir, { maxDepth: 0, onlyMarkdown: true }), t1 + 7000, 'onlyMarkdown 跳过非 .md');
  // 条目预算语义（实测）：预算按**遍历到的条目**扣（含目录项），readdir 顺序由实现决定（实测为字典序、
  //   非创建序），故断言只锁「预算耗尽 → 读数收敛到已遍历范围」这一可观察语义，不锁具体条目身份。
  assert.equal(lastProgressTsOf(dir, { maxEntries: 1 }), t1 + 7000, '预算 1 → 只读首个条目（99-report.md）');
  assert.equal(lastProgressTsOf(dir, { maxEntries: 2 }), t1 + 9000, '预算 2 → 已覆盖 blob.bin（全树最新）');
  assert.equal(lastProgressTsOf(dir, { maxEntries: 10 }), t1 + 9000, '预算充足 → 全树最新（blob.bin，默认不筛扩展名）');
});

test('AN3-b 判据：豁免 lane 与实际在跑的 lane 相同场景（无 checkpoint 事件 + 快照新鲜）→ 不判候选、reason=checkpoint-fresh【假阳性回归】', () => {
  const base = Date.now();
  const noProgress = 5 * MIN;
  const batch = {
    phase: 'running', lanes: { l1: 'running' },
    events: [mkEv(base - 10 * MIN, EVT_MEMBER_DISPATCH, { lane: 'l1' })], // 无任何 worktree.checkpoint
  };
  // ① 前（假阳性条件）：无快照信号 + 无活动 → 判候选（复现本批 e-exempt-core 的实测误报）
  const before = judgeLongrun({
    batch, lane: 'l1', nowTs: base, maxDurationMs: 60_000, noProgressWindowMs: noProgress, lastActivityAtMs: null,
  });
  assert.equal(before.candidate, true, '复现：只读事件流时（无 checkpoint 事件、无活动）判候选 = 假阳性');
  assert.equal(before.lastCheckpointTs, null);
  assert.equal(before.checkpointFresh, false);
  // ② 后（修复条件）：同一批次 + 磁盘进度快照 mtime 落在窗内（2min 前）→ 不判候选
  const after = judgeLongrun({
    batch, lane: 'l1', nowTs: base, maxDurationMs: 60_000, noProgressWindowMs: noProgress,
    lastActivityAtMs: null, progressTsMs: base - 2 * MIN,
  });
  assert.equal(after.candidate, false, '固定：有磁盘进度快照 → 不再误报候选（AN-3）');
  assert.equal(after.checkpointFresh, true);
  assert.equal(after.progressFresh, true, 'progressFresh 单独透出（可辨「只有快照」这条通道）');
  assert.equal(after.reason, 'checkpoint-fresh');
  assert.equal(after.lastProgressTs, new Date(base - 2 * MIN).toISOString());
  assert.equal(after.lastCheckpointTs, new Date(base - 2 * MIN).toISOString(), 'checkpoint 信号 = 事件流 ∨ 快照（取较新）');
  // ③ 窗沿语义与既有 checkpoint 一致（严格 <）：快照恰在窗沿 → 不 fresh → 仍判候选
  const edge = judgeLongrun({
    batch, lane: 'l1', nowTs: base, maxDurationMs: 60_000, noProgressWindowMs: noProgress,
    lastActivityAtMs: null, progressTsMs: base - noProgress,
  });
  assert.equal(edge.progressFresh, false, '窗沿不判 fresh（严格 <，与既有口径一致）');
  assert.equal(edge.candidate, true, '快照超窗 + 无事件 checkpoint + 无活动 → 候选（探针不被稀释）');
});

test('AN3-c 引擎级实证：worker 只写磁盘 progress 快照（零 checkpoint 事件、零事件流活动、零 outbox）→ tick 不产候选', () => {
  const root = tmpRoot('an3c');
  const S = 's-an3c';
  const batchId = 'b-an3c';
  const lane = 'l1';
  const base = Date.now();
  const store = seedBatch(root, {
    S, batchId, lanes: { [lane]: 'running' },
    events: [mkEv(base - 10 * MIN, EVT_MEMBER_DISPATCH, { lane })], // 唯一事件 = 派发（stint 起点，10min 前）
    updatedAt: base,
  });
  const cfg = { capabilities: { watch: { enabled: true, intervalsMinutes: [9999], longrun: { maxDurationMs: 60_000, noProgressWindowMs: 5 * MIN } } } };
  // 时基（实测教训，两侧同口径）：**引擎时钟必须早于批次创建时刻**（取 base - 2min）。
  //   根因：seedBatch 伪造的派发事件 ts 早于 `batch.created` 的现刻 ts → baselineTs 被现刻顶高
  //   → activityFresh=true → 「无快照」对照被误吞成「有活动」，RED 侧静默失效（本 lane 首跑即踩此坑）。
  //   引擎时钟取 base-2min 后：baselineTs = 派发 ts（10min 前），duration = 8min ≫ 1min 阈值。
  const engineNow = () => base - 2 * MIN;
  // ① 对照（RED）：无快照 → 判候选（复现假阳性条件）
  const e1 = hb(store, root, cfg, { now: engineNow });
  e1.tick();
  assert.equal(evsOf(store, S, batchId, EVT_LANE_LONGRUN_CANDIDATE, lane).length, 1, '对照：无快照 → 判候选（复现假阳性）');
  e1.dispose();
  // ② 实证（GREEN）：同构批次（stint 起点同为 10min 前 → duration 10min ≫ 1min 阈值），但 worker 只在
  //    <artifacts>/<batchId>/<lane>/progress/ 下逐子步骤写快照（不调 lane_checkpoint）
  const S2 = 's-an3c2';
  const batchId2 = 'b-an3c2';
  const store2 = seedBatch(root, {
    S: S2, batchId: batchId2, lanes: { [lane]: 'running' },
    events: [mkEv(base - 10 * MIN, EVT_MEMBER_DISPATCH, { lane })],
    updatedAt: base,
  });
  const progressDir = path.join(store2.artifactsDirOf(S2, batchId2), lane, 'progress');
  fs.mkdirSync(progressDir, { recursive: true });
  for (const n of ['01-plan.md', '02-impl.md', '03-gate.md']) {
    const p = path.join(progressDir, n);
    fs.writeFileSync(p, 'step snapshot');
    fs.utimesSync(p, new Date(base - 2 * MIN), new Date(base - 2 * MIN)); // 窗内（2min 前 < 5min 窗）
  }
  assert.equal(evsOf(store2, S2, batchId2, EVT_WORKTREE_CHECKPOINT, lane).length, 0, '前置：零 worktree.checkpoint 事件（worker 未调 lane_checkpoint）');
  const e2 = hb(store2, root, cfg, { now: engineNow });
  e2.tick();
  assert.equal(evsOf(store2, S2, batchId2, EVT_LANE_LONGRUN_CANDIDATE, lane).length, 0, '实证：有磁盘 progress 快照但无 checkpoint 事件 → 不再判 candidate（AN-3 修复生效）');
  assert.equal(candOf(bcastItems(root, S2, batchId2)).length, 0, '零候选消息（无噪音）');
  // 查询面同样可见快照通道
  const st = e2.longrunStatus(S2, batchId2, lane, base - 2 * MIN);
  assert.equal(st.candidate, false);
  assert.equal(st.progressFresh, true);
  assert.equal(st.checkpointFresh, true);
  assert.equal(st.reason, 'checkpoint-fresh');
  e2.dispose();
});

// AN3-d 受控 RED→GREEN 对照（本 lane 接管轮补正：上一轮此用例只写了 GREEN 侧，且实现侧判据
//   「晚于基线」在 stall 路径下恒 false → 用例真红。现补 RED 侧作对照，并把两侧锁在同一夹具口径上）。
//   RED 侧 = 无快照 → 该 lane 必经 missed 累计 → 第 3 拍落 lane.stalled + inbox probe（既有语义回归锚）；
//   GREEN 侧 = 同构批次 + 只在 <lane>/progress/ 写快照（零事件流活动、零 outbox）→ 不 stalled、不追问。
//   两侧差异**只有快照这一个变量**，故 GREEN 只能由 AN-3 的进度快照信号解释（排除「探针本来就哑」）。
test('AN3-d 受控对照：RED 无快照 → 判 stalled/追问；GREEN 有 progress 快照 → 不 stalled/不追问（同夹具仅快照变量不同）', () => {
  const lane = 'l1';
  const base = Date.now();
  const cfg = { capabilities: { watch: { enabled: true, intervalsMinutes: [0, 0, 0], maxMissed: 3, longrun: { enabled: false } } } };
  const mkBatch = (root, S, batchId) => seedBatch(root, {
    S, batchId, lanes: { [lane]: 'running' },
    events: [mkEv(base - 20 * MIN, EVT_MEMBER_DISPATCH, { lane })], // 唯一事件 = 20min 前派发
    updatedAt: base,
  });
  const run = (root, S, batchId, store) => {
    const e = hb(store, root, cfg, { now: () => base - 2 * MIN }); // 引擎时钟早于 batch.created（同 AN3-c 口径）
    for (let i = 0; i < 4; i++) e.tick();
    const out = {
      stalled: store.readBatch(S, batchId).events.filter((x) => x.type === EVT_LANE_STALLED),
      probes: inboxItems(root, S, batchId).filter((m) => m.message?.kind === 'probe'),
      st: e.status(`${S}/${batchId}/${lane}`),
    };
    e.dispose();
    return out;
  };
  // ── RED 对照：完全不写快照 → 判 stalled + 追问（证明探针在本夹具下确实会响）──
  const rootRed = tmpRoot('an3d-red');
  const SRed = 's-an3d-red';
  const bRed = 'b-an3d-red';
  const stRed = mkBatch(rootRed, SRed, bRed);
  const red = run(rootRed, SRed, bRed, stRed);
  assert.equal(red.stalled.length, 1, 'RED：无快照 → 落 lane.stalled（探针会响，对照成立）');
  assert.equal(red.stalled[0].lane, lane);
  assert.equal(red.probes.length >= 1, true, 'RED：无快照 → 发 inbox 追问');
  assert.equal(red.st.stalled, true, 'RED：状态面 stalled=true');
  assert.equal(red.st.missed >= 3, true, 'RED：missed 累计达硬停拍数');
  // ── GREEN 实证：同构夹具 + 只写 progress 快照（mtime 落窗内）→ 不 stalled、不追问 ──
  const root = tmpRoot('an3d');
  const S = 's-an3d';
  const batchId = 'b-an3d';
  const store = mkBatch(root, S, batchId);
  const progressDir = path.join(store.artifactsDirOf(S, batchId), lane, 'progress');
  fs.mkdirSync(progressDir, { recursive: true });
  const p = path.join(progressDir, '05-gate.md');
  fs.writeFileSync(p, 'snapshot');
  fs.utimesSync(p, new Date(base - MIN), new Date(base - MIN)); // 1min 前，远在 5min 默认窗内
  const green = run(root, S, batchId, store);
  assert.equal(green.stalled.length, 0, 'GREEN：有快照 → 有活动 → 不 stalled（AN-3 修复生效；修复前此断言实测为 1）');
  assert.equal(green.probes.length, 0, 'GREEN：不追问');
  assert.equal(green.st.tracked, true, 'GREEN：仍在心跳表内（可观测性不变）');
  assert.equal(green.st.missed, 0, 'GREEN：missed 不累计');
  // ── 反向对照：快照超窗（早于 noProgressWindowMs）→ 回到既有判据，仍判 stalled ──
  const rootStale = tmpRoot('an3d-stale');
  const SStale = 's-an3d-stale';
  const bStale = 'b-an3d-stale';
  const stStale = mkBatch(rootStale, SStale, bStale);
  const staleDir = path.join(stStale.artifactsDirOf(SStale, bStale), lane, 'progress');
  fs.mkdirSync(staleDir, { recursive: true });
  const sp = path.join(staleDir, '05-gate.md');
  fs.writeFileSync(sp, 'snapshot');
  fs.utimesSync(sp, new Date(base - 30 * MIN), new Date(base - 30 * MIN)); // 30min 前 ≫ 5min 窗 → 非新鲜
  const stale = run(rootStale, SStale, bStale, stStale);
  assert.equal(stale.stalled.length, 1, '对照：快照超窗 → 仍判 stalled（快照信号不稀释探针）');
  assert.equal(stale.probes.length >= 1, true, '对照：超窗仍追问');
});

// ── 事件常量与冻结面自查 ──
test('冻结面：D-2 事件常量 + 候选载荷只增不改 + 豁免档位表未被本 lane 改动', () => {
  assert.equal(EVT_LANE_LONGRUN_UNCONSUMED, 'lane.longrun.unconsumed');
  assert.deepEqual(LANE_EXEMPT_TIERS, { 'ai-render': 8, 'large-download': 6, 'dep-install': 4, none: 4 });
  assert.equal(EXEMPT_GATE_CODES.TYPE_UNKNOWN, 'GATE_EXEMPT_TYPE_UNKNOWN');
  // 候选载荷既有字段全保留（只增 ackId/effectiveMaxDurationMs/thresholdMultiplier/lastProgressTs/progressFresh）
  const root = tmpRoot('frozen');
  const S = 's-frozen';
  const batchId = 'b-frozen';
  const base = Date.now();
  const store = seedBatch(root, {
    S, batchId, lanes: { l1: 'running' },
    events: [mkEv(base - 90_000, EVT_MEMBER_DISPATCH, { lane: 'l1' })],
  });
  hb(store, root, D2CFG(), { now: () => base }).tick();
  const ev = evsOf(store, S, batchId, EVT_LANE_LONGRUN_CANDIDATE, 'l1')[0];
  for (const k of ['lane', 'runningSince', 'durationMs', 'maxDurationMs', 'noProgressWindowMs', 'lastCheckpointTs', 'lastActivityAt', 'checkpointFresh', 'activityFresh', 'reason']) {
    assert.equal(k in ev, true, '既有载荷字段保留：' + k);
  }
  assert.equal(typeof longrunCandidateOf(store.readBatch(S, batchId), 'l1', Date.parse(ev.runningSince)), 'object');
});
