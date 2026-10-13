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

// test/replay-verify.test.js —— 事件重放校验腿（L1）单元/端到端测试
// ─────────────────────────────────────────────────────────────────────────────
// 覆盖面：
//   · 纯函数面：lane 末态视图 / 相位视图 / 裁决（零差异不变量、退化不抛、只出差异项）
//   · 可达反例（RED-1 / RED-2）：在**临时目录的批次副本**上改坏 `lanes` / `phase` ⇒ 必报差异
//   · 只读性：CLI 运行前后状态文件 `sha256` / `mtimeMs` / `size` 三项逐项不变（诊断件另为产出）
//   · 推导源单点：本模块**不另立**成员态字面量表（静态自检 + 运行期行为双证）
// 所有临时落盘均在 `os.tmpdir()` 下，**不触碰任何在册批次**。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { laneStatesViewOf, phaseViewOf, replayVerifyVerdict } from '../lib/engine/replay-verify.js';
import { MEMBER_STATES, isMemberTerminal } from '../lib/schema.js';
import { REPLAY_VERIFY_SCHEMA, runReplayVerify } from '../scripts/replay-verify.mjs';

const INITIAL_STATE = MEMBER_STATES[0];
const moduleFile = fileURLToPath(new URL('../lib/engine/replay-verify.js', import.meta.url));
const moduleSrc = fs.readFileSync(moduleFile, 'utf8');

/**
 * 构造样例批：`lanes` 申报值 + `events[]` 事件流 + 相位，均可独立指定（便于造差异）。
 * @param {{lanes?: Record<string,string>, events?: unknown, phase?: string}} spec
 */
function batchOf(spec = {}) {
  const b = {};
  if ('lanes' in spec) b.lanes = spec.lanes;
  if ('events' in spec) b.events = spec.events;
  if ('phase' in spec) b.phase = spec.phase;
  return b;
}

/** 事件构造（形状对齐 `newEvent`：`{ts, type, ...fields}`）；`ts` 递增以固定顺序语义。 */
function ev(type, fields = {}, seq = 0) {
  return { ts: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(), type, ...fields };
}

/** 建批事件 + 两组 lane 结算事件的「正常批」样例（事件流与状态文件一致）。 */
function consistentBatch() {
  return batchOf({
    phase: 'running',
    lanes: { l1: 'merged', l2: 'review' },
    events: [
      ev('batch.created', { batchId: 'b1', sessionId: 's1' }, 0),
      ev('batch.phase', { from: 'planning', to: 'running' }, 1),
      ev('member.settled', { lane: 'l1', from: 'running', to: 'merged', note: null }, 2),
      ev('member.settled', { lane: 'l2', from: 'pending', to: 'running', note: null }, 3),
      ev('member.settled', { lane: 'l2', from: 'running', to: 'review', note: null }, 4),
    ],
  });
}

/** 深冻结（只测「不改入参」；冻结后再调用，任何写入会抛）。 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const k of Object.keys(value)) deepFreeze(value[k]);
    Object.freeze(value);
  }
  return value;
}

// ── AC-1｜零差异不变量 ───────────────────────────────────────────────────────
test('AC-1 零差异不变量：事件流与状态文件一致 ⇒ ok=true / laneDiffs=[] / phaseDiff=null', () => {
  const v = replayVerifyVerdict(consistentBatch());
  assert.equal(v.ok, true);
  assert.deepEqual(v.laneDiffs, []);
  assert.equal(v.phaseDiff, null);
  assert.equal(v.eventsScanned, 5);
  assert.equal(v.phaseView, 'running');
  assert.deepEqual(v.lanesView, { l1: 'merged', l2: 'review' });
  assert.equal(Object.hasOwn(v, 'degraded'), false, '非退化路径不出现 degraded 键');
});

// ── AC-2｜推导源单点（禁第二套表）─────────────────────────────────────────────
test('AC-2 推导源单点：引 lib/schema.js 的 MEMBER_STATES / isMemberTerminal，且无成员态字面量数组', () => {
  assert.ok(moduleSrc.includes('isMemberTerminal'), '须引 isMemberTerminal');
  assert.ok(moduleSrc.includes('MEMBER_STATES'), '须引 MEMBER_STATES');
  // 「禁第二套表」的运行期等价判据：模块内不得出现成员态字面量数组
  assert.equal(/\[\s*'pending'/.test(moduleSrc), false, "不得出现 ['pending'…] 形式的字面量数组");
  assert.equal(/\[\s*"pending"/.test(moduleSrc), false, '双引号变体同样禁');
  // 缺省态派生自单点（非硬编码）：MEMBER_STATES[0] 作视图缺省，可直接观察
  const v = replayVerifyVerdict(batchOf({ lanes: { lx: INITIAL_STATE }, events: [] }));
  assert.deepEqual(v.lanesView, {}, '无事件 ⇒ 视图为空（缺省值由推导侧补，不由视图侧造）');
  assert.deepEqual(v.laneDiffs, [], '视图缺省 == 状态文件缺省 ⇒ 零差异');
});

test('AC-2b 终态判定透传单点：isMemberTerminal 与 lib/schema.js 同源', () => {
  for (const s of MEMBER_STATES) {
    assert.equal(isMemberTerminal(s), ['merged', 'failed', 'skipped', 'conflict'].includes(s), '单点口径自洽：' + s);
  }
});

// ── AC-3｜相位视图起点正确 ───────────────────────────────────────────────────
test('AC-3 相位视图：仅 batch.created ⇒ planning；含 batch.phase{to:paused} ⇒ paused', () => {
  assert.equal(phaseViewOf([ev('batch.created', { batchId: 'b1', sessionId: 's1' }, 0)]), 'planning');
  assert.equal(phaseViewOf([
    ev('batch.created', { batchId: 'b1', sessionId: 's1' }, 0),
    ev('batch.phase', { from: 'planning', to: 'running' }, 1),
    ev('batch.phase', { from: 'running', to: 'paused', reason: 'manual:test' }, 2),
  ]), 'paused', '取最后一次 to');
  assert.equal(phaseViewOf([]), 'planning', '空事件流 ⇒ 起点');
  assert.equal(phaseViewOf(undefined), 'planning', '缺失 ⇒ 起点');
  // 相位视图只折叠 batch.phase：其余事件（含 member.settled 的 to）不得污染
  assert.equal(phaseViewOf([
    ev('batch.phase', { from: 'planning', to: 'running' }, 0),
    ev('member.settled', { lane: 'l1', from: 'running', to: 'merged' }, 1),
  ]), 'running');
});

// ── AC-4｜退化不抛（fail-safe）───────────────────────────────────────────────
test('AC-4 退化不抛：events 缺失 / 非数组 / 空 ⇒ eventsScanned=0 + 空差异 + degraded=no-events', () => {
  const cases = [
    batchOf({ lanes: { l1: 'pending' }, phase: 'planning' }),                       // 缺失
    batchOf({ lanes: { l1: 'pending' }, phase: 'planning', events: 'nope' }),        // 非数组
    batchOf({ lanes: { l1: 'pending' }, phase: 'planning', events: null }),          // null
    batchOf({ lanes: { l1: 'pending' }, phase: 'planning', events: {} }),            // 非数组（对象）
    batchOf({ lanes: { l1: 'pending' }, phase: 'planning', events: [] }),            // 空
  ];
  for (const b of cases) {
    let v;
    assert.doesNotThrow(() => { v = replayVerifyVerdict(b); });
    assert.equal(v.eventsScanned, 0, '零扫描计数');
    assert.deepEqual(v.laneDiffs, [], '空差异');
    assert.equal(v.phaseDiff, null, '相位零差异（起点即申报值）');
    assert.equal(v.degraded, 'no-events', '退化可判读（不静默）');
  }
  // 连 batch 本体缺失 / 非对象也不抛
  assert.doesNotThrow(() => replayVerifyVerdict(undefined));
  assert.doesNotThrow(() => replayVerifyVerdict(null));
  assert.doesNotThrow(() => replayVerifyVerdict('not-a-batch'));
  const none = replayVerifyVerdict(undefined);
  assert.equal(none.ok, true, '无输入 ⇒ 无差异可报（ok=true，非异常态）');
  assert.equal(none.eventsScanned, 0);
});

test('AC-4b 事件数组内的畸形项被跳过（不抛、不污染视图）', () => {
  const v = replayVerifyVerdict(batchOf({
    lanes: { l1: 'merged' },
    events: [
      null,
      'junk',
      ev('member.settled', { lane: 'l1', from: 'running', to: 'merged' }, 0),
      ev('member.settled', { lane: '', to: 'merged' }, 1),          // lane 非空串校验
      ev('member.settled', { lane: 'l2' }, 2),                       // 缺 to ⇒ 跳过
      ev('batch.phase', { from: 'planning' }, 3),                    // 缺 to ⇒ 跳过
    ],
  }));
  assert.deepEqual(v.lanesView, { l1: 'merged' }, '仅合法项入视图');
  assert.equal(v.phaseView, 'planning', '缺 to 的相位事件不推进');
  assert.equal(v.eventsScanned, 6, '计数含畸形项（扫描面 = 数组长度，不按合法性过滤）');
});

// ── 只出差异项 ──────────────────────────────────────────────────────────────
test('只出差异项：零差异 lane 不入 laneDiffs；孤儿 lane（仅事件流申报）单列', () => {
  const v = replayVerifyVerdict(batchOf({
    lanes: { l1: 'merged', l2: 'review' },
    events: [
      ev('member.settled', { lane: 'l1', from: 'running', to: 'merged' }, 0),
      ev('member.settled', { lane: 'l2', from: 'running', to: 'review' }, 1),
      ev('member.settled', { lane: 'l9', from: 'pending', to: 'running' }, 2),
    ],
  }));
  assert.equal(v.ok, false);
  assert.deepEqual(v.laneDiffs, [{ lane: 'l9', stateFile: null, fromEvents: 'running' }], '仅列差异项（含孤儿 lane）');
});

test('输入不被修改（零副作用）：深冻结入参后调用不抛，且语义不变', () => {
  const b = deepFreeze(consistentBatch());
  const snapshot = JSON.stringify(b);
  const v = replayVerifyVerdict(b);
  assert.equal(v.ok, true);
  assert.equal(JSON.stringify(b), snapshot, '入参逐字节不变');
});

// ── RED-1｜可达反例 · lane 末态（红）─────────────────────────────────────────
test('RED-1 改坏 lanes ⇒ ok=false 且 laneDiffs 恰含该 lane 一项（stateFile/fromEvents 原值）', () => {
  const b = consistentBatch();
  b.lanes.l1 = 'running'; // 事件流末次 to === 'merged' ⇒ 状态文件被改坏
  const v = replayVerifyVerdict(b);
  assert.equal(v.ok, false);
  assert.equal(v.laneDiffs.length, 1, '恰含一项');
  assert.deepEqual(v.laneDiffs[0], { lane: 'l1', stateFile: 'running', fromEvents: 'merged' });
  assert.equal(v.phaseDiff, null, '相位未被改坏 ⇒ 零差异');
  assert.equal(v.eventsScanned, 5, '扫描面不受改坏影响');
});

// ── RED-2｜可达反例 · 相位（红）─────────────────────────────────────────────
test('RED-2 改坏 phase ⇒ phaseDiff 非 null 且两字段为改坏值/推导值', () => {
  const b = consistentBatch();
  b.phase = 'planning'; // 事件流末次 to === 'running'
  const v = replayVerifyVerdict(b);
  assert.equal(v.ok, false);
  assert.deepEqual(v.phaseDiff, { stateFile: 'planning', fromEvents: 'running' });
  assert.deepEqual(v.laneDiffs, [], 'lane 面未被改坏 ⇒ 零差异');
});

// ── AC-5 / AC-6｜CLI 端到端 · 只读性 + 不写事件流 ────────────────────────────
/** 造临时引擎根（<tmp>/sessions/<session>/batches/<batch>.json），返回路径组。 */
function makeTempRoot(batch) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-verify-'));
  const session = 's1';
  const batchId = 'b1';
  const dir = path.join(root, 'sessions', session, 'batches');
  fs.mkdirSync(dir, { recursive: true });
  const batchFile = path.join(dir, batchId + '.json');
  fs.writeFileSync(batchFile, JSON.stringify(batch, null, 2) + '\n', 'utf8');
  return { root, session, batchId, batchFile };
}

/** 状态文件快照（与 CLI 内同口径：sha256 / mtimeMs / size 三项）。 */
function snapshotOf(file) {
  const st = fs.statSync(file);
  return { sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'), mtimeMs: st.mtimeMs, size: st.size };
}

test('AC-5 只读性：CLI 前后状态文件 sha256/mtimeMs/size 三项逐项不变；诊断件落产物根', () => {
  const { root, session, batchId, batchFile } = makeTempRoot(consistentBatch());
  const before = snapshotOf(batchFile);
  const res = runReplayVerify({ root, session, batch: batchId, out: 'replay-verify' });
  const after = snapshotOf(batchFile);

  assert.equal(res.status, 'ok');
  assert.deepEqual(after, before, '三项逐项不变（内容 + mtime + 大小）');
  assert.equal(res.unchanged, true);
  assert.deepEqual(res.artifact.stateFileDigest, { before, after, unchanged: true });

  // 诊断件 = 产出（批次产物根下 replay-verify/），落点与 schema 冻结
  const expected = path.join(root, 'sessions', session, 'artifacts', batchId, 'replay-verify', batchId + '.json');
  assert.equal(res.outFile, expected);
  assert.equal(fs.existsSync(expected), true);
  const artifact = JSON.parse(fs.readFileSync(expected, 'utf8'));
  assert.equal(artifact.schema, REPLAY_VERIFY_SCHEMA);
  assert.equal(artifact.schema, 'punky-replay-verify@1');
  assert.equal(artifact.ok, true);
  assert.deepEqual(artifact.laneDiffs, []);
  assert.equal(artifact.phaseDiff, null);
  assert.equal(artifact.eventsScanned, 5);
  assert.equal(typeof artifact.generatedAt, 'string');
  assert.equal(artifact.stateFileDigest.unchanged, true);
  // 只读性对照：被校验对象（批次 JSON）与产出（诊断件）是**两个不同对象**
  assert.notEqual(path.resolve(res.outFile), path.resolve(batchFile));
});

test('AC-5b CLI 只读性不因「有差异」而变：改坏副本 ⇒ ok=false 但状态文件三项仍不变', () => {
  const b = consistentBatch();
  b.lanes.l1 = 'running'; // 改坏**副本**
  const { root, session, batchId, batchFile } = makeTempRoot(b);
  const before = snapshotOf(batchFile);
  const res = runReplayVerify({ root, session, batch: batchId, out: 'replay-verify' });
  const after = snapshotOf(batchFile);

  assert.equal(res.artifact.ok, false);
  assert.deepEqual(res.artifact.laneDiffs, [{ lane: 'l1', stateFile: 'running', fromEvents: 'merged' }]);
  assert.deepEqual(after, before, '报差异不伴随任何写动作');
  assert.equal(res.artifact.stateFileDigest.unchanged, true);
});

test('AC-6 不写事件流：CLI 前后被测批次 events.length 相等、且无新增事件', () => {
  const { root, session, batchId, batchFile } = makeTempRoot(consistentBatch());
  const beforeLen = JSON.parse(fs.readFileSync(batchFile, 'utf8')).events.length;
  runReplayVerify({ root, session, batch: batchId, out: 'replay-verify' });
  const afterLen = JSON.parse(fs.readFileSync(batchFile, 'utf8')).events.length;
  assert.equal(afterLen, beforeLen, '事件流长度逐字不变');
  assert.equal(beforeLen, 5);
  const typesAfter = JSON.parse(fs.readFileSync(batchFile, 'utf8')).events.map((e) => e.type);
  assert.deepEqual(typesAfter, ['batch.created', 'batch.phase', 'member.settled', 'member.settled', 'member.settled'],
    '无任何新增事件（含不得出现 inject.omitted 等）');
});

test('AC-1b CLI 零差异 + 批不存在时不写盘、不抛（恒可用）', () => {
  const { root, session } = makeTempRoot(consistentBatch());
  const missing = runReplayVerify({ root, session, batch: 'nonexistent-batch', out: 'replay-verify' });
  assert.equal(missing.status, 'batch-missing');
  assert.equal(missing.wrote, null, '不写盘');
  const artifactsDir = path.join(root, 'sessions', session, 'artifacts');
  assert.equal(fs.existsSync(artifactsDir), false, '未创建任何产物目录');
});
