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

// 结算与状态推进解耦（原 `lib/engine/settle.js` 已内联进 `member_settle`，本文件改为**工具面判据**）：
//   S1 阳性对照：结算成功 ⇒ settled:true 且状态已推进
//   S2【最关键】结算旁挂 throw ⇒ ①工具不抛 ②状态仍推进 ③settled:false
//   S3【防过度解耦】`setMember` 抛 ⇒ **照旧向上抛**（解耦只针对「批收口」这一旁挂，不针对状态写）
//   S4 幂等：同态重复结算 ⇒ 零写、settled:true、不再调 setMember
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLaneTools } from '../lib/tools/member-tools.js';

const SID = 'sess-settle';
const BID = 'b-settle';
const EXEC = { agent: { session: { id: SID } } };

/** 最小 stub store：只提供 member_settle 走到的面（治理档位 / 读批 / 写成员 / 批收口）。 */
function makeHarness({ laneStatus = 'review', throwOn = null } = {}) {
  const calls = { setMember: 0, batchSettled: 0 };
  let batch = {
    batchId: BID, sessionId: SID, phase: 'running',
    lanes: { e1: laneStatus }, events: [], handoffs: {},
  };
  const store = {
    readGovernance: () => ({ lastAssign: { difficulty: 'C' } }),
    readBatch: () => batch,
    artifactsDirOf: () => '/tmp/punky-settle-artifacts',
    setMember: (sid, bid, lane, status, note) => {
      calls.setMember += 1;
      if (throwOn === 'setMember') throw new Error('GATE_MEMBER_REQUIRES_C: stub 拒写');
      batch = { ...batch, lanes: { ...batch.lanes, [lane]: status }, events: [...batch.events, { type: 'member.status', lane, status }] };
      return batch;
    },
    batchSettled: (b) => {
      calls.batchSettled += 1;
      if (throwOn === 'batchSettled') throw new Error('settle hook 崩了');
      return b.lanes.e1 === 'merged';
    },
  };
  const tools = buildLaneTools({ ctx: {}, deps: {}, store, root: '/tmp/punky-settle' });
  const settle = tools.find((t) => t.name === 'member_settle');
  return { store, calls, settle, batchOf: () => batch };
}

const settleArgs = (status) => ({ batchId: BID, lane: 'e1', status, note: 'n1' });

test('S1 结算成功（阳性对照）：settled:true、状态已推进', async () => {
  const h = makeHarness();
  const out = await h.settle.execute(settleArgs('merged'), EXEC);
  assert.equal(out.status, 'merged');
  assert.equal(out.settled, true);
  assert.equal(h.calls.setMember, 1, '状态写一次');
});

test('S2【最关键】结算旁挂 throw ⇒ 工具不抛、状态仍推进、settled:false', async () => {
  const h = makeHarness({ throwOn: 'batchSettled' });
  let out;
  await assert.doesNotReject(async () => { out = await h.settle.execute(settleArgs('merged'), EXEC); }, '结算旁挂失败不得上抛');
  assert.equal(out.status, 'merged', '状态仍推进（解耦的核心）');
  assert.equal(out.settled, false, '批未收口 ⇒ settled:false（不假装成功）');
  assert.equal(h.batchOf().lanes.e1, 'merged', '持久态已推进');
});

test('S3【防过度解耦】`setMember` 抛 ⇒ 照旧向上抛', async () => {
  const h = makeHarness({ throwOn: 'setMember' });
  await assert.rejects(() => h.settle.execute(settleArgs('merged'), EXEC), /GATE_MEMBER_REQUIRES_C/, '状态写失败必须可见');
});

test('S4 幂等：同态重复结算 ⇒ 零写、settled:true、不再调 setMember', async () => {
  const h = makeHarness({ laneStatus: 'merged' });
  const out = await h.settle.execute(settleArgs('merged'), EXEC);
  assert.equal(out.settled, true);
  assert.equal(out.status, 'merged');
  assert.equal(h.calls.setMember, 0, '同态重复不得重写（零事件、零相位抖动）');
});
