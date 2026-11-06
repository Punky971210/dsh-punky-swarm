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

// test/roster-unknown.test.js —— 已裁 B-2（F-8）行为锁：`gate.roster_unknown` **只告警不拒建批**
// （批 `punky-engine-fix-20261106` · lane `e3-fix-roster`）
//
// 两个面必须分清（混为一谈就是本文件的全部意义）：
//   · `GATE_ROSTER_INVALID` = roster **词法**非法（含空格/大写）⇒ 建批期 **throw**（既有，`lib/wave-plan.ts:1130-1135`）
//     —— 本文件 RU-3 是它的**不得放宽**锁。
//   · `GATE_ROSTER_UNKNOWN` = 词法合法但**不在 `BUILTIN_ROLES`** ⇒ **只落告警 + 事件，建批成功**（本文件 RU-1/RU-2/RU-4）。
//
// 基准口径（用户裁决 Q-3=乙）：比对基准**只取** `lib/roster.js:44 BUILTIN_ROLES`；
//   **不碰宿主 roster**（`reconcileRoster` 不参与本判定）——RU-5 用「源码面零宿主 roster 标识符」反锁这一点。
//
// 断言口径（纪律 15 / C-10）：**身份集合**判覆盖，不判裸计数（不写 `length === 1`）；
//   失败消息点名「哪个码 / 哪个席位名 / 哪个 lane」，不报「期望 N 实得 M」。
//
// 夹具：`smoke: true`（产物契约类门豁免）+ 最小 2-lane 批 —— 本文件被检面是**建批期告警与事件**，
//   与 produce/consume/plan 契约门无关；smoke 豁免**不涉**行为安全门（派发准入/单写者锁/终态冻结/needHuman/
//   命令门/验收判据门一字不减），故不影响本文件判别力。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildWavePlan } from '../lib/wave-plan.js';
import { BUILTIN_ROLES } from '../lib/roster.js';
import { createStore } from '../lib/state/store.js';
import { createTools } from '../lib/tools/register.js';
import { assessC } from './helpers/gate-fixture.mjs';

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 告警码（**告警事件名不是拒码**：不进 `GateErrorCode` union —— RU-5 反锁）。 */
const ROSTER_UNKNOWN = 'GATE_ROSTER_UNKNOWN';
/** 事件类型（字面量单点 = `lib/tools/wave-plan-tools.js#WARN_EVENT_OF`；RU-1 直接核对事件流）。 */
const ROSTER_UNKNOWN_EVT = 'gate.roster_unknown';

const SESS_ID = 'sess-roster-unknown';
const SESS = { agent: { session: { id: SESS_ID } } };

const unknownWarningsOf = (plan) => (plan.warnings ?? []).filter((w) => w.code === ROSTER_UNKNOWN);
const unknownSeatsOf = (plan) => unknownWarningsOf(plan).map((w) => w.roster);

function makeHarness(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-roster-unknown-' + tag + '-'));
  const store = createStore(root);
  const ctx = { tools: { register: () => {}, guard: () => {} }, logger: console };
  const { tools } = createTools(ctx, { store, root });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  // G1 前置：`wave_plan` 属 C 档动作 ⇒ 先落「已评估为 C」
  assessC(store, SESS_ID, { rationale: 'F-8 回归锁：wave_plan 属 C 档动作（建批期告警面）' });
  return { root, store, byName };
}

const batchFileOf = (root, batchId) => path.join(root, 'sessions', SESS_ID, 'batches', batchId + '.json');
const eventsOf = (store, batchId) => store.readBatch(SESS_ID, batchId)?.events ?? [];
const unknownEventsOf = (store, batchId) => eventsOf(store, batchId).filter((e) => e && e.type === ROSTER_UNKNOWN_EVT);

// ═══════════════════════════════════════════════════════════════════════════════
// RU-1 · 未知席位名（词法合法、不在 BUILTIN_ROLES）⇒ 落 gate.roster_unknown 事件 + **建批成功**
// ═══════════════════════════════════════════════════════════════════════════════
test('RU-1 未知席位名 ⇒ warnings 携 GATE_ROSTER_UNKNOWN（身份集合）+ 事件 gate.roster_unknown 落地 + 批次 JSON 照常落盘', async () => {
  const { root, store, byName } = makeHarness('unknown');
  const tasks = [
    { id: 'a', cmd: 'x', roster: 'ghost-seat' },
    { id: 'b', cmd: 'x', roster: 'coder' },
  ];
  // 前提（不是断言被检面）：ghost-seat 词法合法却查无此席；coder 在表内
  assert.equal(BUILTIN_ROLES.includes('coder'), true, '前提：coder 须在 BUILTIN_ROLES 内（基准取自 lib/roster.js:44）');
  assert.equal(BUILTIN_ROLES.includes('ghost-seat'), false, '前提：ghost-seat 不在 BUILTIN_ROLES 内');

  const out = await byName.wave_plan.execute({ batchId: 'b-unknown', tasks, smoke: true }, SESS);

  // ① 返回面：恰一条，身份集合 = [ghost-seat]，且归属 lane = a（coder 那条不得告警）
  assert.deepEqual(unknownSeatsOf(out), ['ghost-seat'],
    '未知席位身份集合须恰为 [ghost-seat]（表内 coder 不得告警）；实测=' + JSON.stringify(unknownWarningsOf(out)));
  assert.deepEqual(unknownWarningsOf(out).map((w) => w.task), ['a'], '告警须归属 lane a（不得连带 lane b）');
  assert.equal(unknownWarningsOf(out)[0].basis, 'BUILTIN_ROLES', '载荷带 basis=BUILTIN_ROLES（供 audit 区分「真未知席位」与「成员名形态」）');

  // ② 建批必须成功（告警不得变成拒建批）
  assert.equal(fs.existsSync(batchFileOf(root, 'b-unknown')), true, '未知席位名**不得**阻断建批：批次 JSON 须在场');
  assert.deepEqual(Object.keys(out.lanes).sort(), ['a', 'b'], '两条 lane 均正常入册；实测=' + JSON.stringify(Object.keys(out.lanes)));

  // ③ 事件面：落 gate.roster_unknown（不是 catch-all 的 gate.role_invalid）
  const evs = unknownEventsOf(store, 'b-unknown');
  assert.equal(evs.length > 0, true, '须落 ' + ROSTER_UNKNOWN_EVT + ' 事件；实测事件类型集合='
    + JSON.stringify([...new Set(eventsOf(store, 'b-unknown').map((e) => e.type))]));
  assert.deepEqual(evs.map((e) => e.roster), ['ghost-seat'], '事件载荷 roster 须点名席位名');
  assert.deepEqual(evs.map((e) => e.code), [ROSTER_UNKNOWN], '事件载荷 code 须为告警码');
  assert.deepEqual(evs.map((e) => e.task), ['a'], '事件载荷 task 须归属 lane a');
  assert.deepEqual(evs.map((e) => e.basis), ['BUILTIN_ROLES'], '事件载荷 basis 须为 BUILTIN_ROLES（比对基准可核）');
});

// ═══════════════════════════════════════════════════════════════════════════════
// RU-2 · 席位名在 BUILTIN_ROLES 内 ⇒ 零告警、零事件（阳性对照）
// ═══════════════════════════════════════════════════════════════════════════════
test('RU-2 BUILTIN_ROLES 内的席位名 ⇒ 零 GATE_ROSTER_UNKNOWN 告警且零 gate.roster_unknown 事件', async () => {
  const { store, byName } = makeHarness('known');
  const tasks = [
    { id: 'a', cmd: 'x', roster: 'coder' },
    { id: 'b', cmd: 'x', roster: 'supervisor' },
    { id: 'c', cmd: 'x', roster: '  doc-manager  ' }, // trim 后合法且在内建表内
  ];
  const out = await byName.wave_plan.execute({ batchId: 'b-known', tasks, smoke: true }, SESS);
  assert.deepEqual(unknownSeatsOf(out), [],
    '表内席位名不得告警；实测=' + JSON.stringify(unknownWarningsOf(out)));
  assert.deepEqual(unknownEventsOf(store, 'b-known'), [],
    '表内席位名不得落 ' + ROSTER_UNKNOWN_EVT + ' 事件');
});

// ═══════════════════════════════════════════════════════════════════════════════
// RU-3 · 词法非法 ⇒ 仍被 GATE_ROSTER_INVALID **拒**（本改动不得放宽 fail-closed 面）
// ═══════════════════════════════════════════════════════════════════════════════
test('RU-3 反例：词法非法（含空格 / 大写）⇒ 仍抛 GATE_ROSTER_INVALID，且零批次落盘', async () => {
  const { root, byName } = makeHarness('invalid');
  assert.throws(() => buildWavePlan({ batchId: 'b-invalid-1', tasks: [{ id: 'a', cmd: 'x', roster: 'Coder One' }] }),
    /GATE_ROSTER_INVALID/, '含空格/大写 ⇒ 词法拒（不得退化为 GATE_ROSTER_UNKNOWN 告警）');
  assert.throws(() => buildWavePlan({ batchId: 'b-invalid-2', tasks: [{ id: 'a', cmd: 'x', roster: 'Coder' }] }),
    /GATE_ROSTER_INVALID/, '大写 ⇒ 词法拒（GATE_ROSTER_INVALID 是 fail-closed 面，不得放宽）');

  // 工具面同址：拒在建批之前 ⇒ 批次 JSON 零落盘
  await assert.rejects(
    () => byName.wave_plan.execute({ batchId: 'b-invalid-3', tasks: [{ id: 'a', cmd: 'x', roster: 'coder one' }], smoke: true }, SESS),
    /GATE_ROSTER_INVALID/,
    '工具面同样以 GATE_ROSTER_INVALID 拒（词法面先于未知席位面）',
  );
  assert.equal(fs.existsSync(batchFileOf(root, 'b-invalid-3')), false, '词法拒时批次 JSON 必须零落盘');
});

// ═══════════════════════════════════════════════════════════════════════════════
// RU-4 · dispatch 批（roster 恒 null）⇒ 零告警、零事件
// ═══════════════════════════════════════════════════════════════════════════════
test('RU-4 dispatch 批（零条 lane 写 roster）⇒ 零 GATE_ROSTER_UNKNOWN 告警且零 gate.roster_unknown 事件', async () => {
  const { store, byName } = makeHarness('dispatch');
  const tasks = [
    { id: 'a', cmd: 'x' },
    { id: 'b', cmd: 'x', roster: null },
    { id: 'c', cmd: 'x', roster: '   ' },
    { id: 'd', cmd: 'x', roster: 7 },
  ];
  const out = await byName.wave_plan.execute({ batchId: 'b-dispatch', tasks, smoke: true }, SESS);
  assert.deepEqual(unknownSeatsOf(out), [],
    'dispatch 批（roster 归一为 null）不得告警；实测=' + JSON.stringify(unknownWarningsOf(out)));
  assert.deepEqual(unknownEventsOf(store, 'b-dispatch'), [], 'dispatch 批不得落 ' + ROSTER_UNKNOWN_EVT + ' 事件');
});

// ═══════════════════════════════════════════════════════════════════════════════
// RU-5 · 两把「不得误用」的锁：告警码不进 GateErrorCode union；基准不碰宿主 roster
// ═══════════════════════════════════════════════════════════════════════════════
test('RU-5 GATE_ROSTER_UNKNOWN 只作告警事件名：不进 GateErrorCode union，且建批面不引宿主 roster 读端', () => {
  const contractsSrc = fs.readFileSync(path.join(PKG_ROOT, 'lib/types/contracts.ts'), 'utf8');
  const unionStart = contractsSrc.indexOf('export type GateErrorCode');
  assert.notEqual(unionStart, -1, 'GateErrorCode union 须仍在 lib/types/contracts.ts');
  const unionBlock = contractsSrc.slice(unionStart, contractsSrc.indexOf(';', unionStart));
  assert.equal(unionBlock.includes(ROSTER_UNKNOWN), false,
    ROSTER_UNKNOWN + ' 是**告警事件名**不是拒码 —— 一旦进 GateErrorCode union，test/gate-lane-snapshot.test.js 的精确集合断言必红，'
    + '且语义从「只告警」漂移成「可拒」');

  // 基准面锁（Q-3=乙）：`reconcileRoster` / `hostRoster` = 宿主名册**对账读端**的两个标识符，
  //   建批面出现任一即证明有人把基准换成了宿主 roster（F8 判红④）。
  //   ⚠ 刻意**不**把 `agentTeams` / `listMembers` 列进判据：`lib/tools/wave-plan-tools.js` 里那处
  //   `agentTeams` 是**既有的** Manager 在册读端注释（与本判定无关），列入即为一个假红源。
  const planSrc = fs.readFileSync(path.join(PKG_ROOT, 'lib/wave-plan.ts'), 'utf8');
  const toolSrc = fs.readFileSync(path.join(PKG_ROOT, 'lib/tools/wave-plan-tools.js'), 'utf8');
  const hostRosterTokens = ['reconcileRoster', 'hostRoster'];
  const leaked = hostRosterTokens.filter((t) => planSrc.includes(t) || toolSrc.includes(t));
  assert.deepEqual(leaked, [],
    '本判定基准**只取** BUILTIN_ROLES（Q-3=乙）：建批面不得出现宿主 roster 对账读端；实测残留=' + JSON.stringify(leaked));
  assert.equal(planSrc.includes('BUILTIN_ROLES'), true,
    'lib/wave-plan.ts 须直接引用 BUILTIN_ROLES（基准单一来源 = lib/roster.js:44）');
});
