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

// test/manager-seat-inroster.test.js —— R-1 **在册判定面**（R1-3）的判别力用例。
//
// 判据源（批 `punky-adapter-split-20261031` · lane `w5-r1-port`）：
//   · `exec/r1-field.md`：在册真源 = **引擎自建表** `batch.managerSeat`（五键冻结，唯一写点
//     `lib/state/store/batch.js#markManagerRaised`）；宿主 roster **仅对账**。
//   · `plan/r1-recon.md` C-1：三面（① 只对账 ② 匹配即判定 ③ 匹配即真源）必须**互斥收敛**。
//     本 lane 收敛 ②：`host-surface.js` 的 `inRoster` 三处（主判定 + 两处提前 return）改读表。
//
// ## 为什么单独成文件、而不是往既有用例里加断言
//
// 本仓对**既有**测试文件实行**逐文件 6 metric 冻结**（`tests/asserts/tautologies/lines/blankLines`…，
// 判据为「有无变化」，**连增加也判红**：`test-baseline.test.js` 的 `e2-1` / 三条「基线对账」门）。
// ⇒ 新增**判别力**只能落成**新增文件**（`added` 由 `e2-11` 放行）。
//   既有文件里唯一的改动是「对象已变的那一条断言的期望值翻转」（`gate-lite-batch2.test.js:140`，单行等量）。
//
// ## 六件（每件都是「旧实现会给出相反读数」的形态；防「改了但没判别力」）
//
//   N-1 表**在册** + roster **服务不可用** ⇒ `inRoster:true`  ← 关键反转（原两处提前 return 硬写 false）
//   N-2 表**在册** + roster 可读但**无 manager** ⇒ `inRoster:true`  ← 证明不再依赖 roster 匹配
//   N-3 表**空** + roster **有** manager ⇒ `inRoster:false`  ← 与旧语义**相反**（旧实现此处为 true）
//   N-4 **不传 batch**（建批期面）⇒ 仍按 roster 匹配  ← R1-4 未改的中间态，**显式登记防误删**
//   N-5 表行 `source ≠ 'engine-registry'` / `seatId` 空 ⇒ 不算在册  ← 真源判别子有效，防伪造
//   N-6 `managerViewOf` **透传 batch** ⇒ 与 N-1/N-2 同结论  ← 防「改了函数没接线」
import test from 'node:test';
import assert from 'node:assert/strict';
import { managerRosterOf, managerViewOf } from '../lib/tools/host-surface.js';

/** 表行（五键冻结；与 `store/batch.js` 的写入形态逐字一致）。 */
const SEAT = {
  seatId: 'mgr-1', role: 'manager', source: 'engine-registry',
  registeredAt: '2026-11-01T00:00:00.000Z', registeredBy: 'batch_phase',
};
/** 构造 batch：`undefined` ⇒ **空表**（有批但无表行，**不是**「无 batch」）。 */
const batchWith = (seat) => (seat === undefined ? {} : { managerSeat: seat });
/** 构造 ctx：`undefined` ⇒ 无 `get`（roster 服务不可用的基线态）。 */
const ctxWith = (svc) => (svc === undefined ? {} : { get: () => svc });
const rosterOf = (names) => ({
  listMembers: () => names.map((n, i) => ({ id: 'sess-' + i, name: n, role: n === 'lead' ? 'lead' : 'teammate', status: 'running' })),
});
const EXEC = { agent: { session: { id: 'sess-x' } } };

test('N-1 表在册 + roster 服务不可用 ⇒ inRoster:true（关键反转：原两处提前 return 硬写 false）', () => {
  const out = managerRosterOf(ctxWith(undefined), EXEC, batchWith(SEAT));
  assert.equal(out.ok, false, 'roster 侧仍是降级态（服务不可用）');
  assert.equal(out.reason, 'service-unavailable', '降级档位与文案面不变');
  assert.equal(out.inRoster, true, '⚠ 在册判定读表 ⇒ 表在册即 true（即便 roster 完全不可用）');
});

test('N-2 表在册 + roster 可读但无 manager ⇒ inRoster:true（不再依赖 roster 匹配）', () => {
  const out = managerRosterOf(ctxWith(rosterOf(['lead', 'worker'])), EXEC, batchWith(SEAT));
  assert.equal(out.ok, true, 'roster 可读');
  assert.equal(out.memberCount, 2, 'roster 对账数据照常回显（对账面不因判定面翻转而丢）');
  assert.equal(out.member, null, 'roster 无约定名 ⇒ member 行为 null（纯对账面事实）');
  assert.equal(out.inRoster, true, '⚠ 表在册 ⇒ true；若退回读 roster 匹配即红');
});

test('N-3 表空 + roster 有 manager ⇒ inRoster:false（roster 命中不再是依据 ← 与旧语义相反）', () => {
  const out = managerRosterOf(ctxWith(rosterOf(['lead', 'manager'])), EXEC, batchWith(undefined));
  assert.equal(out.ok, true, 'roster 可读');
  assert.equal(out.member.name, 'manager', '对账面仍能看见该成员（对账能力未削）');
  assert.equal(out.inRoster, false, '⚠ 表空 ⇒ 不算在册；**旧实现此处为 true** ⇒ 本条即语义翻转的锚');
});

test('N-4 建批期面（不传 batch）⇒ 仍按 roster 匹配（R1-4 未改的中间态，防误删）', () => {
  // 该面 = `wave_plan` 的 `gate.manager_roster_gap` 发射点（`wave-plan-tools.js` 不传 batch）。
  // 建批期表**必空**；若此处也改读表 ⇒ 每条 `raise` 批都落 gap 事件（事件量激增 + 越界实现分级）。
  assert.equal(managerRosterOf(ctxWith(rosterOf(['lead', 'manager'])), EXEC).inRoster, true,
    '无 batch + roster 有 manager ⇒ true（legacy 面原语义保留）');
  assert.equal(managerRosterOf(ctxWith(rosterOf(['lead'])), EXEC).inRoster, false,
    '无 batch + roster 无 manager ⇒ false（legacy 面原语义保留）');
  assert.equal(managerRosterOf(ctxWith(undefined), EXEC).inRoster, false,
    '无 batch + 服务不可用 ⇒ false（legacy 面原语义保留）');
});

test('N-5 表行 source ≠ engine-registry / seatId 空 ⇒ 不算在册（真源判别子有效，防伪造）', () => {
  assert.equal(managerRosterOf(ctxWith(rosterOf(['lead', 'manager'])), EXEC, batchWith({ ...SEAT, source: 'roster' })).inRoster, false,
    '⚠ source 非 `engine-registry` ⇒ 不认（否则任意来源都能伪装成在册）');
  assert.equal(managerRosterOf(ctxWith(rosterOf(['lead', 'manager'])), EXEC, batchWith({ ...SEAT, seatId: '' })).inRoster, false,
    'seatId 为空 ⇒ 不认（表行不完整不算在座）');
  assert.equal(managerRosterOf(ctxWith(rosterOf(['lead', 'manager'])), EXEC, batchWith(null)).inRoster, false,
    'managerSeat 显式 null ⇒ 不认（防「有键即真」的粗判）');
});

test('N-6 managerViewOf 透传 batch ⇒ 与 N-1/N-2 同结论（接线正确，防「改了函数没接线」）', () => {
  const v = managerViewOf(ctxWith(undefined), EXEC, batchWith(SEAT));
  assert.equal(v.roster.inRoster, true, '⚠ 接线正确：view 层同样读到表在册（若漏传 batch 此处会退化为 false）');
  assert.equal(v.legacy, null, 'legacy 字段面不变（未写 `batch.manager` ⇒ null）');
  assert.equal(v.managerPlan, null, 'assembly 面不变（无 assembly ⇒ null）');
  assert.equal(typeof v.roster.rosterName, 'string', '原有键面仍在（导出形态零破坏；服务不可用档无 memberCount 属原形态）');
});
