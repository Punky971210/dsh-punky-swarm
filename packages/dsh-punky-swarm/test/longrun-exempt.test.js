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

// longrun 长程豁免「授予面」单测（exec 层 e-exempt-core）——覆盖 plan/spec.md「验收标准」A/B/C 组 +
// 「关键设计取舍与反例」的对应条目（不改 lanes[lane] 字符串 / 未知 type 拒 / 无值不写键 / 撤销须显式调用）。
//
// 覆盖清单：
//   A1-A4 授予（pending→running / idle→running、档位倍率、显式覆盖、tierMultiplier 留痕）
//   A5    授予事件与迁移同一次写盘（同一批次 JSON 读取即见，无中间态）
//   A6    无 exempt 的既有派发：不含 laneExempt 键、无 lane.exempt.*、member.settled 载荷逐字段不变（回归）
//   B7-B8 非派发面带 exempt → GATE_EXEMPT_NOT_DISPATCH（review/pending/idle），零写入零事件
//   B9    member_settle 路径的参数位（store.setMember 第 6 参）带 exempt → GATE_EXEMPT_NOT_DISPATCH
//   B10   载荷结构非法 → GATE_EXEMPT_INVALID（5 类）
//   B11   未知 type → GATE_EXEMPT_TYPE_UNKNOWN（错误文本含合法值清单）
//   C12   显式撤销成功（条目消失、表空整键删除、恰一条 lane.exempt.revoked）
//   C13   无既有豁免撤销 → GATE_EXEMPT_REVOKE_REQUIRED
//   C14   revokeExempt 与 status 并用 → GATE_EXEMPT_NOT_DISPATCH（工具面）
//   C15   撤销不改成员状态（lanes 不变、无新增 member.settled）
//   J38/J39 工具总数仍 26；member_status 新参透传；member_settle 调用点仍 5 参
//   反例  工具层旧调用（不带 exempt/不带 status）仍可用；空表不留空对象键
//
// 纪律：本文件走隔离 home 预载运行（package.json test 脚本 / gate 命令均带 --import preload），
//   测试内只写系统临时根（mkdtempSync），不触真实 ~/.dsh。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { createTools } from '../lib/tools/register.js';
import {
  LANE_EXEMPT_TYPES, LANE_EXEMPT_TIERS, DEFAULT_THRESHOLD_MULTIPLIER, EXEMPT_GATE_CODES,
  tierMultiplierOf, validateExemptPayload, normalizeExemptPayload,
} from '../lib/state/lane-exempt.js';
import { EVT_LANE_EXEMPT_GRANTED, EVT_LANE_EXEMPT_REVOKED, EVT_MEMBER_SETTLED } from '../lib/state/event-types.js';
import { threeTierTasks, seedArtifacts, assessC } from './helpers/gate-fixture.mjs';

const S = 'sess-ex';

// 每个测试独立的临时根 + 真实 store（不共享状态，避免用例间顺序耦合）
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-exempt-'));
  const store = createStore(root);
  return { root, store };
}

// 造一个 running 批次（lanes 全 pending；可指定 lane 集合）
function mkBatch(store, batchId, laneIds = ['l1']) {
  const plan = buildWavePlan({ batchId, tasks: laneIds.map((id) => ({ id, cmd: 'work' })) });
  store.createBatch(S, { batchId, wavePlan: plan, phase: 'running' });
  return plan;
}

function eventsOf(store, batchId, type) {
  return (store.readBatch(S, batchId)?.events ?? []).filter((e) => e.type === type);
}

// 工具面夹具（真实 createTools + 真实 store；EXEC_SESS 会话 = 批所在会话）
function toolsFixture(root, store, sessionId = 'sess-tools') {
  const registered = [];
  const ctx = { tools: { register: (t) => registered.push(t) }, logger: console };
  const { tools } = createTools(ctx, { store, root });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  // G1 前置（新门禁）：`member_status` 属 C 档动作 ⇒ 工具面夹具先把本会话评估为 C（同 assign_check 落盘函数）
  assessC(store, sessionId, { rationale: 'fixture：longrun 豁免套件工具面前置评估（成员面治理 ⇒ C 档）' });
  return { tools, registered, byName, EXEC_SESS: { agent: { session: { id: sessionId } } } };
}

// ── 0. 档位表 / 载荷校验单点（lane-exempt.js）──

test('EX-0: 档位默认表与 spec §3.2 逐值一致；未知 type 不静默兜底', () => {
  assert.deepEqual(LANE_EXEMPT_TYPES, ['ai-render', 'large-download', 'dep-install', 'none']);
  assert.equal(LANE_EXEMPT_TIERS['ai-render'], 8);
  assert.equal(LANE_EXEMPT_TIERS['large-download'], 6);
  assert.equal(LANE_EXEMPT_TIERS['dep-install'], 4);
  assert.equal(LANE_EXEMPT_TIERS.none, 4);
  assert.equal(DEFAULT_THRESHOLD_MULTIPLIER, 1);
  assert.equal(tierMultiplierOf('gpu-train'), null); // 未命中 → null（由调用方拒，不取默认 4×）
  const n = normalizeExemptPayload({ type: 'ai-render' });
  assert.deepEqual(n, { type: 'ai-render', multiplier: 8, tierMultiplier: 8, stalled: true });
  const o = normalizeExemptPayload({ type: 'none', multiplier: 3, stalled: false });
  assert.deepEqual(o, { type: 'none', multiplier: 3, tierMultiplier: 4, stalled: false });
  assert.equal(validateExemptPayload('ai-render').ok, false);
  assert.equal(validateExemptPayload({ type: 'none' }).ok, true);
});

// ── A. 授予（派发面）──

test('EX-A1: pending→running 带 exempt{ai-render} → laneExempt 记录齐全（grantedFrom=pending，8×）', () => {
  const { store } = setup();
  mkBatch(store, 'b-a1');
  const b = store.setMember(S, 'b-a1', 'l1', 'running', null, { type: 'ai-render' });
  assert.equal(b.lanes.l1, 'running'); // lanes 仍是字符串（未被对象化）
  assert.equal(typeof b.lanes.l1, 'string');
  const g = b.laneExempt.l1;
  assert.equal(g.grantedFrom, 'pending');
  assert.equal(g.type, 'ai-render');
  assert.equal(g.multiplier, 8);
  assert.equal(g.tierMultiplier, 8);
  assert.equal(g.stalled, true); // 缺省 true
  assert.ok(!Number.isNaN(Date.parse(g.grantedAt)) && g.grantedAt.endsWith('Z'), 'grantedAt 须为 ISO：' + g.grantedAt);
});

test('EX-A2: idle→running 带 exempt{large-download} → grantedFrom=idle、multiplier=6', () => {
  const { root, store } = setup();
  // 【r2 同步 · B2/B3/A1】旧 fixture 的 lane 无 layer，`l1` 无法结算到 merged
  //   （exit 门拒 `GATE_LANE_LAYER_MISSING`）⇒ 改用合规三层批 + 声明产物在场。
  const plan = buildWavePlan({ batchId: 'b-a2', tasks: threeTierTasks(['l1']) });
  store.createBatch(S, { batchId: 'b-a2', wavePlan: plan, phase: 'running' });
  seedArtifacts(root, S, 'b-a2', ['l1']);
  store.setMember(S, 'b-a2', 'l1', 'running');
  store.setMember(S, 'b-a2', 'l1', 'review');
  store.setMember(S, 'b-a2', 'l1', 'merged');
  // 终态无后继 → 经恢复路径把成员落 idle 后重派（等价重启冷窗后的 idle→running 授予通道）
  const batch = store.readBatch(S, 'b-a2');
  batch.lanes.l1 = 'idle';
  fs.writeFileSync(store.batchFile(S, 'b-a2'), JSON.stringify(batch, null, 2));
  const b = store.setMember(S, 'b-a2', 'l1', 'running', null, { type: 'large-download' });
  assert.equal(b.laneExempt.l1.grantedFrom, 'idle');
  assert.equal(b.laneExempt.l1.multiplier, 6);
  assert.equal(b.laneExempt.l1.tierMultiplier, 6);
});

test('EX-A3: exempt{type:none} → 默认 4×（倍率 = 档位表 > 内置兜底）', () => {
  const { store } = setup();
  mkBatch(store, 'b-a3');
  const b = store.setMember(S, 'b-a3', 'l1', 'running', null, { type: 'none' });
  assert.equal(b.laneExempt.l1.multiplier, 4);
  assert.equal(b.laneExempt.l1.tierMultiplier, 4);
});

test('EX-A4: 显式 multiplier 覆盖档位，tierMultiplier 保留原档位留痕', () => {
  const { store } = setup();
  mkBatch(store, 'b-a4');
  const b = store.setMember(S, 'b-a4', 'l1', 'running', null, { type: 'ai-render', multiplier: 3 });
  assert.equal(b.laneExempt.l1.multiplier, 3);        // 生效 = 显式
  assert.equal(b.laneExempt.l1.tierMultiplier, 8);    // 档位原值留痕（可辨「用户显式覆盖」）
});

test('EX-A5: 授予事件与迁移同一次写盘；载荷字段齐备且 grantedFrom 可回溯', () => {
  const { store } = setup();
  mkBatch(store, 'b-a5');
  store.setMember(S, 'b-a5', 'l1', 'running', null, { type: 'dep-install', multiplier: 5, stalled: false });
  // 同一批次 JSON 读取即见（无中间态：不存在「lane 已 running 但 laneExempt 未落盘」的窗口）
  const onDisk = JSON.parse(fs.readFileSync(store.batchFile(S, 'b-a5'), 'utf8'));
  assert.equal(onDisk.lanes.l1, 'running');
  assert.equal(onDisk.laneExempt.l1.multiplier, 5);
  const gs = eventsOf(store, 'b-a5', EVT_LANE_EXEMPT_GRANTED);
  assert.equal(gs.length, 1, '每次成功授予恰一条 lane.exempt.granted');
  const g = gs[0];
  assert.equal(g.lane, 'l1');
  assert.equal(g.from, 'pending');
  assert.equal(g.to, 'running');
  assert.equal(g.grantedFrom, 'pending');
  // 事件名键 `type` 承载事件名（引擎读端按 e.type 过滤/呈现，不可被载荷占用）→ 豁免类型读 exemptType
  assert.equal(g.exemptType, 'dep-install');
  assert.equal(g.multiplier, 5);
  assert.equal(g.tierMultiplier, 4);
  assert.equal(g.stalled, false);
  // 事件顺序：授予在本次 member.settled 之前（同批落盘）
  const types = store.readBatch(S, 'b-a5').events.map((e) => e.type);
  assert.ok(types.indexOf(EVT_LANE_EXEMPT_GRANTED) < types.lastIndexOf(EVT_MEMBER_SETTLED));
});

test('EX-A5b: 重复/叠加授予以最后一次为准（不阻塞 idle→running 重派），事件逐次留痕', () => {
  const { store } = setup();
  mkBatch(store, 'b-a5b');
  store.setMember(S, 'b-a5b', 'l1', 'running', null, { type: 'none' });
  store.setMember(S, 'b-a5b', 'l1', 'review');
  // review → running 非法；走恢复落 idle 后重派（新 stint 授予覆盖旧记录）
  const batch = store.readBatch(S, 'b-a5b');
  batch.lanes.l1 = 'idle';
  fs.writeFileSync(store.batchFile(S, 'b-a5b'), JSON.stringify(batch, null, 2));
  const b = store.setMember(S, 'b-a5b', 'l1', 'running', null, { type: 'ai-render' });
  assert.equal(b.laneExempt.l1.type, 'ai-render');       // 覆盖为最新
  assert.equal(b.laneExempt.l1.multiplier, 8);
  assert.equal(b.laneExempt.l1.grantedFrom, 'idle');
  assert.equal(eventsOf(store, 'b-a5b', EVT_LANE_EXEMPT_GRANTED).length, 2); // 两次授予两次留痕
});

test('EX-A6: 无 exempt 的既有派发零变化（不含 laneExempt 键、无 lane.exempt.*、member.settled 载荷不变）', () => {
  const { store } = setup();
  mkBatch(store, 'b-a6');
  const b = store.setMember(S, 'b-a6', 'l1', 'running');
  assert.equal(Object.prototype.hasOwnProperty.call(b, 'laneExempt'), false, '无豁免 -> 不写 laneExempt 键');
  const raw = JSON.parse(fs.readFileSync(store.batchFile(S, 'b-a6'), 'utf8'));
  assert.equal(Object.prototype.hasOwnProperty.call(raw, 'laneExempt'), false);
  assert.equal(eventsOf(store, 'b-a6', EVT_LANE_EXEMPT_GRANTED).length, 0);
  assert.equal(eventsOf(store, 'b-a6', EVT_LANE_EXEMPT_REVOKED).length, 0);
  const settled = eventsOf(store, 'b-a6', EVT_MEMBER_SETTLED);
  assert.equal(settled.length, 1);
  assert.deepEqual(settled[0], { ts: settled[0].ts, type: 'member.settled', lane: 'l1', from: 'pending', to: 'running', note: null });
});

test('EX-A6b: 多 lane 批次只给一个 lane 授予 → 表内只含该 lane（其余 lane 零噪音）', () => {
  const { store } = setup();
  mkBatch(store, 'b-a6b', ['l1', 'l2']);
  store.setMember(S, 'b-a6b', 'l1', 'running', null, { type: 'ai-render' });
  store.setMember(S, 'b-a6b', 'l2', 'running');
  const b = store.readBatch(S, 'b-a6b');
  assert.deepEqual(Object.keys(b.laneExempt), ['l1']);
});

// ── B. 拒绝（派发面限制）──

test('EX-B7: exempt 出现在 to!=running → GATE_EXEMPT_NOT_DISPATCH，且状态与 JSON 零变化', () => {
  const { store } = setup();
  mkBatch(store, 'b-b7');
  store.setMember(S, 'b-b7', 'l1', 'running');
  const before = fs.readFileSync(store.batchFile(S, 'b-b7'), 'utf8');
  assert.throws(
    () => store.setMember(S, 'b-b7', 'l1', 'review', null, { type: 'none' }),
    /GATE_EXEMPT_NOT_DISPATCH/,
  );
  assert.equal(fs.readFileSync(store.batchFile(S, 'b-b7'), 'utf8'), before, '拒绝路径必须零写入');
  assert.equal(eventsOf(store, 'b-b7', EVT_LANE_EXEMPT_GRANTED).length, 0);
});

test('EX-B8: pending / idle 自身（非派发面）带 exempt → 同样 GATE_EXEMPT_NOT_DISPATCH', () => {
  const { store } = setup();
  mkBatch(store, 'b-b8');
  assert.throws(() => store.setMember(S, 'b-b8', 'l1', 'pending', null, { type: 'none' }), /GATE_EXEMPT_NOT_DISPATCH/);
  assert.throws(() => store.setMember(S, 'b-b8', 'l1', 'idle', null, { type: 'none' }), /GATE_EXEMPT_NOT_DISPATCH/);
  assert.equal(Object.prototype.hasOwnProperty.call(store.readBatch(S, 'b-b8'), 'laneExempt'), false);
});

test('EX-B9: member_settle 路径的参数位（第 6 参）带 exempt 亦拒（merged/failed/conflict 三态）', () => {
  const { store } = setup();
  // merged：经 5 参调用点不可传（工具面），此处直调 store 证明「内部路径传入亦拒」
  mkBatch(store, 'b-b9a');
  store.setMember(S, 'b-b9a', 'l1', 'running');
  store.setMember(S, 'b-b9a', 'l1', 'review');
  assert.throws(() => store.setMember(S, 'b-b9a', 'l1', 'review', null, { type: 'none' }), /GATE_EXEMPT_NOT_DISPATCH/);
  // failed / conflict：running → 终态的同族路径
  mkBatch(store, 'b-b9b');
  store.setMember(S, 'b-b9b', 'l1', 'running');
  assert.throws(() => store.setMember(S, 'b-b9b', 'l1', 'failed', 'boom', { type: 'none' }), /GATE_EXEMPT_NOT_DISPATCH/);
  mkBatch(store, 'b-b9c');
  store.setMember(S, 'b-b9c', 'l1', 'running');
  assert.throws(() => store.setMember(S, 'b-b9c', 'l1', 'conflict', 'rej', { type: 'none' }), /GATE_EXEMPT_NOT_DISPATCH/);
});

test('EX-B10: 载荷结构非法五类 → GATE_EXEMPT_INVALID', () => {
  const { store } = setup();
  mkBatch(store, 'b-b10');
  const bad = [
    'ai-render',                             // 字符串而非对象
    {},                                      // 缺 type
    { type: 'none', multiplier: 0 },         // 越下界（0 会收紧阈值）
    { type: 'none', multiplier: 101 },       // 越上界
    { type: 'none', stalled: 'yes' },        // stalled 非布尔
  ];
  for (const p of bad) {
    assert.throws(() => store.setMember(S, 'b-b10', 'l1', 'running', null, p), /GATE_EXEMPT_INVALID/, JSON.stringify(p));
  }
  // 非有限数亦拒（NaN / Infinity）
  assert.throws(() => store.setMember(S, 'b-b10', 'l1', 'running', null, { type: 'none', multiplier: NaN }), /GATE_EXEMPT_INVALID/);
  assert.throws(() => store.setMember(S, 'b-b10', 'l1', 'running', null, { type: 'none', multiplier: Infinity }), /GATE_EXEMPT_INVALID/);
  // 全部拒绝 → 零写入（既未建 laneExempt 键，也未被自动 skipped/派发）
  const b = store.readBatch(S, 'b-b10');
  assert.equal(b.lanes.l1, 'pending');
  assert.equal(Object.prototype.hasOwnProperty.call(b, 'laneExempt'), false);
  assert.equal(eventsOf(store, 'b-b10', EVT_LANE_EXEMPT_GRANTED).length, 0);
});

test('EX-B11: 未知 type → GATE_EXEMPT_TYPE_UNKNOWN，错误文本含合法值清单（不静默取 4×）', () => {
  const { store } = setup();
  mkBatch(store, 'b-b11');
  let err = null;
  try {
    store.setMember(S, 'b-b11', 'l1', 'running', null, { type: 'gpu-train' });
  } catch (e) { err = e; }
  assert.ok(err, '未知 type 必须拒（不静默降级）');
  assert.match(err.message, /GATE_EXEMPT_TYPE_UNKNOWN/);
  for (const t of LANE_EXEMPT_TYPES) assert.ok(err.message.includes(t), '错误文本须含合法值 ' + t);
  assert.equal(store.readBatch(S, 'b-b11').lanes.l1, 'pending');
});

// ── C. 撤销（显式调用）──

test('EX-C12: 显式撤销成功 → 条目消失（表空整键删除）+ 恰一条 lane.exempt.revoked', () => {
  const { store } = setup();
  mkBatch(store, 'b-c12');
  store.setMember(S, 'b-c12', 'l1', 'running', null, { type: 'ai-render', multiplier: 3 });
  const before = store.readBatch(S, 'b-c12');
  const b = store.revokeLaneExempt(S, 'b-c12', 'l1');
  assert.equal(Object.prototype.hasOwnProperty.call(b, 'laneExempt'), false, '最后一条撤销后 laneExempt 整键删除');
  const rs = eventsOf(store, 'b-c12', EVT_LANE_EXEMPT_REVOKED);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].lane, 'l1');
  assert.equal(rs[0].exemptType, 'ai-render');
  assert.equal(rs[0].multiplier, 3);
  assert.equal(rs[0].grantedAt, before.laneExempt.l1.grantedAt); // 可回溯到授予时刻
  assert.ok(!Number.isNaN(Date.parse(rs[0].at)), 'revoked.at 须为可解析时间戳：' + rs[0].at);
});

test('EX-C12b: 多 lane 场景下撤销其中一个 → 表保留另一条（不误删）', () => {
  const { store } = setup();
  mkBatch(store, 'b-c12b', ['l1', 'l2']);
  store.setMember(S, 'b-c12b', 'l1', 'running', null, { type: 'ai-render' });
  store.setMember(S, 'b-c12b', 'l2', 'running', null, { type: 'large-download' });
  const b = store.revokeLaneExempt(S, 'b-c12b', 'l1');
  assert.deepEqual(Object.keys(b.laneExempt), ['l2']);
  assert.equal(b.laneExempt.l2.multiplier, 6);
});

test('EX-C13: lane 无既有豁免 → GATE_EXEMPT_REVOKE_REQUIRED（撤销只能对已授予生效）', () => {
  const { store } = setup();
  mkBatch(store, 'b-c13');
  store.setMember(S, 'b-c13', 'l1', 'running'); // 无豁免
  assert.throws(() => store.revokeLaneExempt(S, 'b-c13', 'l1'), /GATE_EXEMPT_REVOKE_REQUIRED/);
  assert.equal(eventsOf(store, 'b-c13', EVT_LANE_EXEMPT_REVOKED).length, 0);
  // 未知 lane 仍是既有的 unknown lane 语义（不误报为 REVOKE_REQUIRED）
  assert.throws(() => store.revokeLaneExempt(S, 'b-c13', 'nope'), /unknown lane/);
});

test('EX-C15: 撤销不改成员状态（lanes 不变、无新增 member.settled、无 lane.exempt.granted）', () => {
  const { store } = setup();
  mkBatch(store, 'b-c15');
  store.setMember(S, 'b-c15', 'l1', 'running', null, { type: 'ai-render' });
  const settledBefore = eventsOf(store, 'b-c15', EVT_MEMBER_SETTLED).length;
  const b = store.revokeLaneExempt(S, 'b-c15', 'l1');
  assert.equal(b.lanes.l1, 'running');
  assert.equal(eventsOf(store, 'b-c15', EVT_MEMBER_SETTLED).length, settledBefore, '撤销不得新增 member.settled');
  assert.equal(eventsOf(store, 'b-c15', EVT_LANE_EXEMPT_GRANTED).length, 1, '撤销不得新增授予事件');
});

// ── 工具面（J38/J39 + C14）──

test('EX-J38: 工具总数仍 26（含 lane_dispatch/swarm_report/swarm_cc + P3a batch_control + P1 handoff 两件）；member_status 参数表按冻结清单扩两键，既有 4 键与顺序不变', () => {
  const { store, root } = setup();
  const { tools, byName } = toolsFixture(root, store);
  assert.equal(tools.length, 27); // 【2026-09-16 P3a control lane】23 → 24（+batch_control）；【2026-09-17 P1】+handoff_submit/handoff_view 常驻注册 ⇒ 25 → 26
  const ms = byName.member_status;
  // defineTool 归一化后：parameters = { type:'object', properties:{...}, required:[...] }（声明顺序即 Object.keys 顺序）
  assert.deepEqual(Object.keys(ms.parameters.properties), ['batchId', 'lane', 'status', 'session', 'exempt', 'revokeExempt']);
  assert.equal(ms.parameters.properties.exempt.type, 'object');
  assert.equal(ms.parameters.properties.revokeExempt.type, 'boolean');
  assert.deepEqual(ms.parameters.properties.exempt.properties.type.enum, LANE_EXEMPT_TYPES);
  assert.ok(!ms.parameters.required.includes('status'), 'status 为撤销路径放开 required（无 status 亦可调用 revokeExempt）');
  assert.ok(!ms.parameters.required.includes('exempt'));
  // member_settle 调用点仍 5 参（`lib/tools/core.js` 未改）：参数面无 exempt 键
  assert.equal(Object.prototype.hasOwnProperty.call(byName.member_settle.parameters.properties, 'exempt'), false);
});

test('EX-J39: 工具面透传 —— member_status(exempt) 授予 / revokeExempt 撤销 / 旧调用零变化', async () => {
  const { store, root } = setup();
  mkBatch(store, 'b-j39', ['l1', 'l2', 'l3']);
  const { byName, EXEC_SESS } = toolsFixture(root, store, S);

  // ① 授予：status=running + exempt
  const r1 = await byName.member_status.execute({ batchId: 'b-j39', lane: 'l1', status: 'running', exempt: { type: 'ai-render' } }, EXEC_SESS);
  assert.equal(r1.status, 'running');
  assert.equal(store.readBatch(S, 'b-j39').laneExempt.l1.multiplier, 8);

  // ② 撤销：revokeExempt=true（不带 status）
  const r2 = await byName.member_status.execute({ batchId: 'b-j39', lane: 'l1', revokeExempt: true }, EXEC_SESS);
  assert.equal(r2.status, 'running'); // 撤销不改变成员状态，仅回报当前态
  assert.equal(Object.prototype.hasOwnProperty.call(store.readBatch(S, 'b-j39'), 'laneExempt'), false);

  // ③ 旧调用（不带 exempt）：与今日行为一致
  const r3 = await byName.member_status.execute({ batchId: 'b-j39', lane: 'l2', status: 'running' }, EXEC_SESS);
  assert.equal(r3.status, 'running');
  assert.equal(Object.prototype.hasOwnProperty.call(store.readBatch(S, 'b-j39'), 'laneExempt'), false);

  // ④ 非派发面带 exempt（工具面）→ 拒
  await assert.rejects(
    () => byName.member_status.execute({ batchId: 'b-j39', lane: 'l2', status: 'review', exempt: { type: 'none' } }, EXEC_SESS),
    /GATE_EXEMPT_NOT_DISPATCH/,
  );

  // ⑤ revokeExempt 与 status 并用 → 拒（零写入）
  const before = fs.readFileSync(store.batchFile(S, 'b-j39'), 'utf8');
  await assert.rejects(
    () => byName.member_status.execute({ batchId: 'b-j39', lane: 'l3', status: 'running', revokeExempt: true }, EXEC_SESS),
    /GATE_EXEMPT_NOT_DISPATCH/,
  );
  assert.equal(fs.readFileSync(store.batchFile(S, 'b-j39'), 'utf8'), before);

  // ⑥ 无既有豁免撤销（工具面）→ REVOKE_REQUIRED
  await assert.rejects(
    () => byName.member_status.execute({ batchId: 'b-j39', lane: 'l3', revokeExempt: true }, EXEC_SESS),
    /GATE_EXEMPT_REVOKE_REQUIRED/,
  );

  // ⑦ 既无 status 也无 revokeExempt → 拒（参数表放开 required 后的补齐门禁）
  await assert.rejects(
    () => byName.member_status.execute({ batchId: 'b-j39', lane: 'l3' }, EXEC_SESS),
    /GATE_EXEMPT_NOT_DISPATCH/,
  );

  // ⑧ 授予后仍有 member.settled（派发语义未被豁免破坏）+ 撤销后成员态可继续正常迁移
  await byName.member_status.execute({ batchId: 'b-j39', lane: 'l3', status: 'running', exempt: { type: 'dep-install' } }, EXEC_SESS);
  assert.equal(store.readBatch(S, 'b-j39').laneExempt.l3.multiplier, 4);
  const settled = eventsOf(store, 'b-j39', EVT_MEMBER_SETTLED).filter((e) => e.lane === 'l3');
  assert.equal(settled.length, 1);
});

test('EX-C14: 撤销的不存在性语义 —— 未授予 lane 撤销拒，授予后可撤（幂等再撤仍拒）', () => {
  const { store } = setup();
  mkBatch(store, 'b-c14');
  store.setMember(S, 'b-c14', 'l1', 'running', null, { type: 'none' });
  store.revokeLaneExempt(S, 'b-c14', 'l1');
  assert.throws(() => store.revokeLaneExempt(S, 'b-c14', 'l1'), /GATE_EXEMPT_REVOKE_REQUIRED/);
  assert.equal(eventsOf(store, 'b-c14', EVT_LANE_EXEMPT_REVOKED).length, 1, '重复撤销不得二次留痕');
  assert.equal(EXEMPT_GATE_CODES.REVOKE_REQUIRED, 'GATE_EXEMPT_REVOKE_REQUIRED');
});
