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

// R-1 在册**观察面**（`seatReason` / `mismatch`）—— lane `w5-r1-event`。
//
// 裁决前提（2026-10-31）：
//   · **AQ-1 乙**：在册真源 = 引擎自建表 `batch.managerSeat`；宿主 roster 只对账；
//   · **NQ-1 丙**：表空 = **常态**（只有显式 `batch_phase({manager})` 才填表）⇒ 不得当缺口；
//   · **E-1（本 lane 获裁）**：两个 reason **只做回显面、不落事件**。理由 = 建批期表**结构性恒空**
//     （`store/batch.js:64` 同 `batchId` 不可重建 ⇒ `wave_plan` 每次都是全新落盘），
//     把「定义性状态」落成 `gate.*` 事件会让审计**无法区分常态与异常**。
//   · **W-1（本 lane 获裁）**：`wave_plan` 端 `managerRoster.source` **保持 `'roster'`**（读取面标签，
//     承载 `service-unavailable` / `not-a-team-member:` 两档降级可辨性）；`batch_status` 端顶层 = 在册真源标签。
//
// 覆盖：
//   F-1 表空 + roster 有 manager ⇒ `seat-not-registered` + `{rosterOnly:['manager']}`；**零事件副作用**
//   F-2 表在册 + roster 无 manager ⇒ `tableOnly:['manager']`、`seatReason:null`
//   F-3 两侧一致 ⇒ 双空差集（含「两侧都说没有」）
//   F-4 roster 不可读 ⇒ `mismatch:null`（**不伪造差集**，禁把环境事实写成本批事实）
//   F-5 `wave_plan` 端：`source` 保持 `'roster'` + 两键在场（W-1）
//   F-6 结构性锁（E-1）：两键**不得**出现在发射点判据行（接进去即死代码）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import * as EVT from '../lib/state/event-types.js';
import { assessC } from './helpers/gate-fixture.mjs';
import { codeOnly, findRepoRoot } from '../scripts/baseline-snapshot-core.mjs';

const SESS = { agent: { session: { id: 'sess-seatface' } } };
const SID = SESS.agent.session.id;

function mkCtx(rosterService) {
  const ctx = { tools: { register() {}, guard() {} }, logger: { warn() {}, info() {}, error() {} } };
  if (rosterService !== undefined) ctx.get = () => rosterService;
  return ctx;
}

function makeHarness(prefix, rosterService) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const store = createStore(root);
  const tools = createTools(mkCtx(rosterService), { store, root });
  const byName = Object.fromEntries(tools.tools.map((t) => [t.name, t]));
  assessC(store, SID, { rationale: 'fixture：R-1 在册观察面套件（三层批 ⇒ C 档）' });
  return { root, store, byName };
}

// 三层批（含 audit lane）⇒ `assembly` 必备 ⇒ `managerPlan` 缺省 `raise` ⇒ 触发建批期消费点
const threeTier = () => [
  { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
  { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1/o.md'], deps: ['p1'], cmd: 'code' },
  { id: 'a1', layer: 'audit', role: 'supervisor', consume: ['plan/spec.md', 'exec/e1/o.md'], produce: ['audit/a.md'], deps: ['e1'], cmd: 'accept' },
];

const buildBatch = (byName, batchId) => byName.wave_plan.execute({
  batchId, team: 'probe-team', tasks: threeTier(), assembly: { auditLane: 'a1' },
}, SESS);

const rosterService = (names) => ({ listMembers: () => names.map((n, i) => ({ id: 'sess-' + i, name: n, role: n === 'lead' ? 'lead' : 'teammate', status: 'running' })) });
const gapEvents = (store, batchId) => store.readBatch(SID, batchId).events.filter((e) => e.type === EVT.EVT_GATE_MANAGER_ROSTER_GAP);

test('F-1 表空 + roster 有 manager ⇒ seat-not-registered + rosterOnly；观察面零事件副作用', async () => {
  const { store, byName } = makeHarness('punky-seatface-1-', rosterService(['lead', 'manager']));
  await buildBatch(byName, 'f1');
  const st = await byName.batch_status.execute({ batchId: 'f1' }, SESS);

  assert.equal(st.managerRoster.seatReason, 'seat-not-registered',
    '表空 = 观察级诊断（NQ-1 丙 常态，不是缺口）');
  assert.deepEqual(st.managerRoster.mismatch, { tableOnly: [], rosterOnly: ['manager'] },
    '真信号：roster 说 `manager` 在座，表说从未登记');
  // C-5：两个 `source` 是**不同层不同义**，禁统一
  assert.equal(st.managerRoster.source, 'engine-registry', '顶层 = 在册真源标签');
  assert.equal(st.managerRoster.roster.source, 'roster', '嵌套 = roster 读取面标签（承载两档降级可辨性）');
  // E-1：观察面**不落事件**（本批 raise + roster 有 manager ⇒ 旧口径本就不落；此处锁定「两键没有副作用」）
  assert.equal(gapEvents(store, 'f1').length, 0, '观察面不得有任何事件副作用');
});

test('F-2 表在册 + roster 无 manager ⇒ tableOnly；seatReason 归 null', async () => {
  const { store, byName } = makeHarness('punky-seatface-2-', rosterService(['lead']));
  await buildBatch(byName, 'f2');
  store.markManagerRaised(SID, 'f2', { agentId: 'mgr-1' }); // 显式登记 ⇒ 入表（唯一写通道）
  const st = await byName.batch_status.execute({ batchId: 'f2' }, SESS);

  assert.equal(st.managerRoster.seatReason, null, '表在册 ⇒ 无未登记 reason');
  assert.equal(st.managerRoster.roster.inRoster, true, 'R1-3：在册判定读表（roster 无 manager 不干扰）');
  assert.deepEqual(st.managerRoster.mismatch, { tableOnly: ['manager'], rosterOnly: [] },
    '真信号：表说在册，roster 说没这个人');
});

test('F-3 两侧一致 ⇒ 双空差集（含「两侧都说没有」的常态）', async () => {
  const { store, byName } = makeHarness('punky-seatface-3-', rosterService(['lead', 'manager']));
  await buildBatch(byName, 'f3');
  store.markManagerRaised(SID, 'f3', { agentId: 'mgr-1' });
  const st = await byName.batch_status.execute({ batchId: 'f3' }, SESS);
  assert.deepEqual(st.managerRoster.mismatch, { tableOnly: [], rosterOnly: [] }, '表与 roster 都认这一席 ⇒ 无差集');
  assert.equal(store.readBatch(SID, 'f3').managerSeat.seatId, 'mgr-1', '前置：表行确在');
});

test('F-4 roster 不可读 ⇒ mismatch 为 null（不伪造差集），seatReason 仍按表给', async () => {
  const { byName } = makeHarness('punky-seatface-4-', undefined); // 无 ctx.get ⇒ service-unavailable
  await buildBatch(byName, 'f4');
  const st = await byName.batch_status.execute({ batchId: 'f4' }, SESS);
  assert.equal(st.managerRoster.roster.ok, false, '前置：roster 不可用');
  assert.equal(st.managerRoster.roster.reason, 'service-unavailable');
  assert.equal(st.managerRoster.mismatch, null, '对账面无事实 ⇒ null（禁把环境事实写成本批事实）');
  assert.equal(st.managerRoster.seatReason, 'seat-not-registered', '表侧事实独立于 roster 可用性');
});

test('F-5 wave_plan 端（W-1）：source 保持 roster 读取面标签，两键以观察面并入', async () => {
  const { byName } = makeHarness('punky-seatface-5-', rosterService(['lead', 'manager']));
  const out = await buildBatch(byName, 'f5');
  assert.equal(out.managerRoster.ok, true);
  assert.equal(out.managerRoster.source, 'roster',
    'W-1：本端 source = roster **读取面**标签（覆盖即抹掉服务不可用/非成员两档可辨性）');
  assert.equal(out.managerRoster.seatReason, 'seat-not-registered', '建批期表必空 ⇒ 观察面如实标常态');
  assert.deepEqual(out.managerRoster.mismatch, { tableOnly: [], rosterOnly: ['manager'] }, '观察面差集在场');
  assert.equal(out.managerRoster.inRoster, true,
    '本端 inRoster 仍走 roster（r1-port 的 N-4 边界：无 batch 建批期面不动）—— 与 seatReason 的差异是**过渡期已知形态**');
});

test('F-6 结构性锁（E-1）：两键不得出现在发射点判据行', () => {
  const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
  const src = fs.readFileSync(path.join(repoRoot, 'lib/tools/wave-plan-tools.js'), 'utf8');
  const code = codeOnly(src); // 剥注释/字符串：注释里讨论这两键**不算**违例
  // ⚠ 锚点**不能带 `'raise'` 字面量**：`codeOnly` 把字符串抹成空格（`managerPlan ===        `）——
  //   这是 masking 的应有行为（注释/字符串不该参与判定），故锚在比较前缀上。
  const judgeLines = code.split('\n').filter((l) => l.includes('managerPlan ==='));
  assert.ok(judgeLines.length > 0, '前置：判据行在场（否则本锁无对象、形同虚设）');
  for (const line of judgeLines) {
    assert.equal(line.includes('mismatch'), false,
      '判据行**禁**出现 mismatch：建批期表恒空 ⇒ 它结构性不可达，接进来即死代码');
    assert.equal(line.includes('seatReason'), false,
      '判据行**禁**出现 seatReason：表空是定义性状态，落成事件 = 让审计无法区分常态与异常');
  }
  assert.equal(code.includes('managerSeatFaceOf'), true, '观察面必须已接线（否则两键永不出现、F-1..F-5 假绿）');
});
