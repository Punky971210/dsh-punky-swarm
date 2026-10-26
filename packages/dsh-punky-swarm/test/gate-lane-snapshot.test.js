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

// P2-1 · `gate.*` 事件载荷附 lane 态快照（批 `punky-guidance-teams-20261025` · lane `c6-gate-snapshot`）
//
// 被测对象：`lib/state/store.js#commitBatch` 内的 `stampGateLaneSnapshot(batch)`（唯一写盘点戳记）。
// 判据源：规格 `plan/guidance-p1p2-spec.md` REQ-7 / AC-7 / AC-8：
//   · REQ-7 `gate.*` 事件载荷含 `lanes` 快照，与 `batch_status` **同刻一致**；
//   · AC-7  **拿掉快照 ⇒ 红**；**快照与真值不一致 ⇒ 红**（两条负控都必须可达）；
//   · AC-8  `GATE_*` 集合净增 0（集合相等，不按计数）。
//
// ⚠ 本文件的负控纪律（沿用仓内 `mc-negative-controls` / `arch-check --self-test` 同法）：
//   「必须能红」**不是**在注释里声明，而是**真的把判据跑在残废数据上并断言它失败**。
//   为避免「判据恒真」，正例与负控**共用同一个判据实现**（`assertSnapshotMatches`）——
//   两套口径的负控证明的是另一套判据会红，等于没证。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { laneStateOf } from '../lib/state/lane-state.js';
import { threeTierTasks, seedArtifacts } from './helpers/gate-fixture.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 判据单点：`batch_status.lanesState` 的**逐字同源复算** ─────────────────────────────
// 来源：`lib/tools/query-tools.js:76-77`（`Object.keys(b.lanes ?? {})` → `laneStateOf(b, l)`）。
// 为什么在测试里复算而不 import 工具层：被测面是「事件快照 == 该派生视图」；若直接复用工具层实现，
//   被测方与判据方共用一个函数会掩盖口径漂移（`batch_status` 自身改口径时本测试静默跟随）。
function lanesStateOf(batch) {
  const lanesState = {};
  for (const laneId of Object.keys(batch?.lanes ?? {})) lanesState[laneId] = laneStateOf(batch, laneId);
  return lanesState;
}

/** 判据（**正例与两条负控共用**）：事件自带 `lanes` 且与同刻 `batch_status.lanesState` 深等。 */
function assertSnapshotMatches(event, lanesState) {
  assert.ok(event && typeof event === 'object', '被判对象须为事件对象');
  assert.ok(
    Object.prototype.hasOwnProperty.call(event, 'lanes'),
    event.type + ' 缺 `lanes` 快照 —— P2-1 要求 `gate.*` 事件自带采样时刻 lane 态',
  );
  assert.deepEqual(
    event.lanes, lanesState,
    event.type + ' 的 `lanes` 与同刻 `batch_status.lanesState` 不一致：'
    + JSON.stringify(event.lanes) + ' !== ' + JSON.stringify(lanesState),
  );
}

// ── 夹具：合规三层批（plan / exec / audit），走真实 store 写路径 ────────────────────────
function makeBatch(prefix, execLanes = ['e1']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const store = createStore(root);
  const session = 'sess-c6';
  const batchId = 'b-c6';
  const plan = buildWavePlan({ batchId, tasks: threeTierTasks(execLanes) });
  seedArtifacts(root, session, batchId, execLanes);
  store.createBatch(session, { batchId, wavePlan: plan });
  const settle = (lane) => {
    store.setMember(session, batchId, lane, 'running');
    store.setMember(session, batchId, lane, 'review');
    store.setMember(session, batchId, lane, 'merged');
  };
  return { root, store, session, batchId, settle };
}

/** 一次写入产生的新事件（按写入前后 `events.length` 取差集）——「同刻」的定义载体。 */
function newEventsOf(before, after) {
  return after.events.slice((before.events ?? []).length);
}

// ═══════════════════════════════════════════════════════════════════════════════
// AC-7 主判据：同刻一致（正例）
// ═══════════════════════════════════════════════════════════════════════════════

test('P2-1 · 每次写入新增的 gate.* 事件，其 lanes 快照与该刻 batch_status.lanesState 深等', () => {
  const { store, session, batchId, settle } = makeBatch('punky-c6-same-instant-');

  // 逐步结算，**每一步**都取「写入后即刻」的批次快照做同刻比对 —— 这是判据的唯一正确时点。
  //   （若拿「最终 lanes」去比早先事件，会因后续 lane 迁移而**误报不一致**，属判据口径错。）
  const steps = [
    () => store.setMember(session, batchId, 'p1', 'running'),
    () => store.setMember(session, batchId, 'p1', 'review'),
    () => store.setMember(session, batchId, 'p1', 'merged'),
    () => store.setMember(session, batchId, 'e1', 'running'),
    () => store.setMember(session, batchId, 'e1', 'review'),
    () => store.setMember(session, batchId, 'e1', 'merged'),
  ];

  let checked = 0;
  for (const step of steps) {
    const before = store.readBatch(session, batchId);
    step();
    const after = store.readBatch(session, batchId);
    const lanesState = lanesStateOf(after);
    for (const e of newEventsOf(before, after)) {
      if (typeof e.type !== 'string' || !e.type.startsWith('gate.')) continue;
      assertSnapshotMatches(e, lanesState);
      checked += 1;
    }
  }
  assert.ok(checked > 0, '本夹具应至少产生 1 条 gate.* 事件（含 gate.passed），实测 ' + checked);
});

test('P2-1 · gate.passed 落盘后自带快照，且与重新读盘的 batch.lanes 派生视图一致', () => {
  const { store, session, batchId, settle } = makeBatch('punky-c6-persisted-');
  settle('p1');
  settle('e1');

  const batch = store.readBatch(session, batchId); // 从**盘上**读，不是内存对象
  const passed = batch.events.filter((e) => e.type === 'gate.passed');
  assert.deepEqual(passed.map((e) => e.lane).sort(), ['p1', 'e1'].sort(),
    'plan / exec 各一条 gate.passed（实际 lane: ' + JSON.stringify(passed.map((e) => e.lane)) + '）');
  const latesState = lanesStateOf(batch);
  // 末条 gate.passed 是 e1 结算时落的 ⇒ 其快照须等于末态（此后无 lane 迁移）
  assertSnapshotMatches(passed[passed.length - 1], latesState);
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-7 负控 A：**拿掉快照 ⇒ 红**（可达构造）
// ═══════════════════════════════════════════════════════════════════════════════

test('P2-1【负控A】拿掉 lanes 快照 ⇒ 同一判据必红（判据有鉴别力，非恒真）', () => {
  const { store, session, batchId, settle } = makeBatch('punky-c6-negctl-a-');
  settle('p1');

  const batch = store.readBatch(session, batchId);
  const passed = batch.events.find((e) => e.type === 'gate.passed');
  assert.ok(passed, '夹具须先产出 gate.passed');
  const lanesState = lanesStateOf(batch);

  // ① 正例：原样通过
  assert.doesNotThrow(() => assertSnapshotMatches(passed, lanesState), '带快照的事件应通过判据');

  // ② 负控：**把快照拿掉**（模拟「机制不存在」/「存量事件」）⇒ 判据必须失败
  const stripped = { ...passed };
  delete stripped.lanes;
  assert.throws(
    () => assertSnapshotMatches(stripped, lanesState),
    /缺 `lanes` 快照/,
    '拿掉快照后判据仍通过 ⇒ 判据恒真，鉴别力未证，本条即判不合格',
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-7 负控 B：**快照与 batch_status 不一致 ⇒ 红**（可达构造）
// ═══════════════════════════════════════════════════════════════════════════════

test('P2-1【负控B】快照与 batch_status 派生视图不一致 ⇒ 同一判据必红', () => {
  const { store, session, batchId, settle } = makeBatch('punky-c6-negctl-b-');
  settle('p1');

  const batch = store.readBatch(session, batchId);
  const passed = batch.events.find((e) => e.type === 'gate.passed');
  const lanesState = lanesStateOf(batch);

  // ① 正例
  assert.doesNotThrow(() => assertSnapshotMatches(passed, lanesState));

  // ② 负控 B-1：快照把某 lane 的值改掉（形状对、值错 —— 这是最危险的失真形态：
  //    事后读「有没有 running」正是靠这个值，值错 ⇒ 判读结论直接反向）
  const wrongValue = { ...passed, lanes: { ...passed.lanes, p1: 'running' } };
  assert.throws(
    () => assertSnapshotMatches(wrongValue, lanesState),
    /不一致/,
    '值被篡改后判据仍通过 ⇒ 判据只校验了形状未校验取值',
  );

  // ② 负控 B-2：快照缺一个 lane 键（少 lane ⇒ 无法回答「其余 lane 是否 running」）
  const shortKeys = { ...passed };
  delete shortKeys.lanes.p1;
  assert.throws(
    () => assertSnapshotMatches(shortKeys, lanesState),
    /不一致/,
    '少 lane 键后判据仍通过 ⇒ 判据未校验键集完整性',
  );

  // ② 负控 B-3：真值侧漂移（事件不变、batch 的 lane 态变了）⇒ 同样必须红。
  //   这一支证明判据不是「自己跟自己比」：两侧任一变化都可被检出。
  const drifted = { ...batch, lanes: { ...batch.lanes, p1: 'review' } };
  assert.throws(
    () => assertSnapshotMatches(passed, lanesStateOf(drifted)),
    /不一致/,
    '真值侧漂移未检出 ⇒ 判据两侧同源，鉴别力未证',
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 幂等冻结：首落盘语义（不随后续提交改写）
// ═══════════════════════════════════════════════════════════════════════════════

test('P2-1 · 首落盘冻结：早先 gate.* 事件的快照不被后续 commitBatch 改写', () => {
  const { store, session, batchId, settle } = makeBatch('punky-c6-freeze-');
  settle('p1');
  const afterP1 = store.readBatch(session, batchId);
  const early = afterP1.events.find((e) => e.type === 'gate.passed');
  assert.ok(early, 'plan 结算须产出 gate.passed');
  const earlySnapshot = JSON.parse(JSON.stringify(early.lanes));
  assert.equal(earlySnapshot.e1, 'pending', 'p1 结算时 e1 应仍为 pending');

  // 后续两次 lane 迁移（e1 running / review / merged）会多次 commitBatch —— 累积数组里的
  //   同一条早先事件必须**逐字不变**（否则「采样时刻」语义失效，快照退化为「最后状态的副本」）。
  settle('e1');
  const afterE1 = store.readBatch(session, batchId);
  const sameEvent = afterE1.events.find((e) => e.type === 'gate.passed' && e.lane === early.lane
    && e.ts === early.ts);
  assert.ok(sameEvent, '须能定位到同一条历史事件');
  assert.deepEqual(sameEvent.lanes, earlySnapshot,
    '早先事件快照被后续提交改写 ⇒ 幂等守卫失效（快照不再代表采样时刻）');
  assert.equal(afterE1.lanes.e1, 'merged', '对照：批次当前态确实已前进（说明上面的不变是守卫的功劳，不是没变化）');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 纯增量 + 范围精确
// ═══════════════════════════════════════════════════════════════════════════════

test('P2-1 · 纯增量：gate.passed 既有字段逐字不变（只多一个 lanes）', () => {
  const { store, session, batchId, settle } = makeBatch('punky-c6-additive-');
  settle('p1');
  const batch = store.readBatch(session, batchId);
  const passed = batch.events.find((e) => e.type === 'gate.passed');
  assert.ok(passed);
  // 键集 = 既有 {ts,type,lane,gate} + 新增 {lanes}（键序亦保持：新键追加在末尾）
  assert.deepEqual(Object.keys(passed), ['ts', 'type', 'lane', 'gate', 'lanes']);
  assert.equal(passed.lane, 'p1', '既有 lane 字段不得变');
  assert.equal(passed.gate, 'exit', '既有 gate 字段不得变（gate.passed 的 gate="exit"）');
  assert.equal(typeof passed.ts, 'string', '既有 ts 字段不得变');
});

test('P2-1 · 范围精确：非 gate.* 事件**不得**被加 lanes（未越界到 newEvent 层）', () => {
  const { store, session, batchId, settle } = makeBatch('punky-c6-scope-');
  settle('p1');
  settle('e1');
  const batch = store.readBatch(session, batchId);
  const nonGate = batch.events.filter((e) => typeof e.type === 'string' && !e.type.startsWith('gate.'));
  assert.ok(nonGate.length > 0, '本夹具应含 member.settled 等非 gate 事件');
  for (const e of nonGate) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(e, 'lanes'), false,
      e.type + ' 被加了 lanes ⇒ 戳记越界（应为 gate.* 专用；在 newEvent 层注入即污染全事件族）',
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 源码面锚：机制被删 ⇒ 本测试红（覆盖「实现整段被移除」这一负控盲区）
// ═══════════════════════════════════════════════════════════════════════════════

test('P2-1【源码面锚】戳记调用须落在 commitBatch 内、且在统一 atomicWrite 之前', () => {
  const src = fs.readFileSync(path.join(PKG_ROOT, 'lib/state/store.js'), 'utf8');
  const fnAt = src.indexOf('function commitBatch(');
  const callAt = src.indexOf('stampGateLaneSnapshot(batch);');
  const writeAt = src.lastIndexOf('atomicWrite(batchFile(sessionId, batchId), batch)');
  assert.notEqual(fnAt, -1, 'commitBatch 须仍在 lib/state/store.js（唯一写盘点）');
  assert.notEqual(callAt, -1,
    'commitBatch 内找不到 `stampGateLaneSnapshot(batch);` 调用 ⇒ 快照机制已被移除（P2-1 失效）');
  assert.notEqual(writeAt, -1, '统一写盘点须仍在（R3-2④ 锚点）');
  assert.ok(fnAt < callAt, '戳记须在 commitBatch 函数体内（不得提到函数外）');
  assert.ok(callAt < writeAt, '戳记须早于 atomicWrite（否则快照会晚于落盘、落不进本次字节）');
  // 单点复用：快照读端必须走 laneStateOf，不得在本文件另写一套 lane 态取值
  assert.match(src, /laneStateOf\(batch, laneId\)/,
    '快照须经 `laneStateOf` 单点取值（禁第二套 lane 态口径）');
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-8：零新造 GATE_*（集合相等，不按计数）
// ═══════════════════════════════════════════════════════════════════════════════

test('P2-1 · 零新造 GATE_*：union 集合身份不变，且本 lane 写域内无 union 外的码', () => {
  const contracts = fs.readFileSync(path.join(PKG_ROOT, 'lib/types/contracts.ts'), 'utf8');
  const unionStart = contracts.indexOf('export type GateErrorCode');
  assert.notEqual(unionStart, -1, 'GateErrorCode union 须仍在 lib/types/contracts.ts');
  const unionBlock = contracts.slice(unionStart, contracts.indexOf(';', unionStart));
  const union = new Set((unionBlock.match(/'GATE_[A-Z0-9_]+'/g) ?? []).map((s) => s.slice(1, -1)));

  // 集合身份相等（规格 §方案 2 形态 1）——替代 `union.size === 51`：
  // 只断个数时，失败消息只能报「期望 51 实得 52」，**证不出是哪个码**；断集合则双向差集直接点名。
  // 冻结名集由 lib/types/contracts.ts 机械导出（生成命令见产物处置记录），非手抄。
  const EXPECTED_GATE_CODES = new Set([
    'GATE_ENTRY_MISSING', 'GATE_HANDOFF_MISSING', 'GATE_AUDIT_INPUT_MISSING', 'GATE_AUDIT_CRITERIA_MISSING',
    'GATE_BATCH_REQUIRES_C', 'GATE_MEMBER_REQUIRES_C', 'GATE_PLAN_CONTRACT', 'GATE_TOKEN_UNKNOWN',
    'GATE_VOCAB_INVALID', 'GATE_EXIT_MISSING_EXEC', 'GATE_EXIT_MISSING_AUDIT', 'GATE_NEEDHUMAN_PENDING',
    'GATE_EXIT_NO_COMMAND', 'GATE_EXIT_FORBIDDEN', 'GATE_EXIT_TIMEOUT', 'GATE_EXIT_SPAWN_FAIL',
    'GATE_EXIT_NONZERO', 'GATE_SCRIPT_CHANGED', 'GATE_TARGET_MISSING', 'GATE_TARGET_UNCHANGED',
    'GATE_COMPLETE_NO_AUDIT', 'GATE_EXIT_PENDING_AUDIT', 'GATE_COMPLETE_AUDIT_FAILED', 'GATE_COMPLETE_EXEC_PENDING',
    'GATE_COMPLETE_OUTCOMES_EMPTY', 'GATE_SETTLE_NOTE_MISSING', 'GATE_EXEMPT_NOT_DISPATCH', 'GATE_EXEMPT_INVALID',
    'GATE_EXEMPT_TYPE_UNKNOWN', 'GATE_EXEMPT_REVOKE_REQUIRED', 'GATE_HANDOFF_UNAUTHORIZED', 'GATE_HANDOFF_IDENTITY_UNKNOWN',
    'GATE_HANDOFF_OVERWRITE_UNDECLARED', 'GATE_ROSTER_INVALID', 'GATE_CHANNEL_INVALID', 'GATE_CHANNEL_UNRESOLVED',
    'GATE_CONSUME_DEPS_ASYMMETRY', 'GATE_COMPLETE_NO_TIER', 'GATE_ORPHAN_PRODUCT', 'GATE_LANE_NOT_IN_PLAN',
    'GATE_LANE_LAYER_MISSING', 'GATE_EXIT_NO_DECLARATION', 'GATE_NO_DECLARATION', 'GATE_PLAN_NO_DECLARATION',
    'GATE_PLAN_PRESENCE_MISSING', 'GATE_STANDALONE_UNJUSTIFIED', 'GATE_ASSEMBLY_INVALID', 'GATE_ROLE_ASSEMBLY_MISSING',
    'GATE_ROLE_INVALID', 'GATE_ROLE_MANAGER_AS_LANE', 'GATE_PAIRING_CARDINALITY_DRIFT',
  ]);
  const addedCodes = [...union].filter((c) => !EXPECTED_GATE_CODES.has(c));
  const removedCodes = [...EXPECTED_GATE_CODES].filter((c) => !union.has(c));
  assert.deepEqual([addedCodes, removedCodes], [[], []],
    'GateErrorCode 集合漂移（本批零新造）：新增 [' + addedCodes.join(', ') + '] 消失 [' + removedCodes.join(', ') + ']');

  // 本 lane 写域内出现的 GATE_ 字面量：只允许 union 成员 + 冻结的既有例外。
  // `GATE_EVENT_CONST_MISSING` = fail-closed 守卫码，**在 10d6db1 之前即存在**（`git show 10d6db1:…/store.js` 实测 :68），
  // 且刻意不进 GateErrorCode（它不参与门禁判定，属写端守卫）⇒ 登记为冻结例外，不构成「新造」。
  const FROZEN_EXCEPTIONS = new Set(['GATE_EVENT_CONST_MISSING']);
  // 负向前瞻排除 `EVT_GATE_*`（事件常量名含 GATE_ 子串，不是拒码）
  const literals = new Set(
    (fs.readFileSync(path.join(PKG_ROOT, 'lib/state/store.js'), 'utf8')
      .match(/(?<![A-Z0-9_])GATE_[A-Z0-9_]+/g) ?? []),
  );
  const outside = [...literals].filter((c) => !union.has(c) && !FROZEN_EXCEPTIONS.has(c));
  assert.deepEqual(outside, [], 'lib/state/store.js 引入了 union 之外的新 GATE_* 码：' + outside.join(', '));
});
