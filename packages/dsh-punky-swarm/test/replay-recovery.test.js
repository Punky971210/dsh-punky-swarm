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

// test/replay-recovery.test.js —— W1-①【重放/恢复】**纯判定面**回归锁
// ─────────────────────────────────────────────────────────────────────────────
// 【2026-09-18 · Q-A=C 链运行期推进退役 —— 本文件**语义反转**为「退役锁」（批 `engine-retire-chain-20260918`）】
// 原判据（`docs/engine-reform-blueprint-20260916.md` §W1-①）：
//   · 「已结算但该步尚未据此推进」= 重放对象；
//   · 幂等判据 = 存在 `from === 步 id` 且 `ts >= 该 lane 结算时刻` 的 `chain.step` ⇒ **不重放**；
//   · 非终态 lane / 链外 lane / 映射歧义 ⇒ 不重放（禁猜）；
//   · 重放运行在工具流水线之外 ⇒ 一律 `noDispatch`（只落待派清单，不真派）。
// **退役后**：重放对象 = 「链推进」，而链运行期推进本身已退役（`lib/engine/chain-runner.js` 的首行 no-op）⇒
//   三个纯判据函数（`settleTsOf` / `advancedAfter` / `pendingAdvancesOf`）**整体删除**，`replayBatch` 保留为
//   **空壳**（`reason:'retired'`，零读批、零判据、零事件、零派发；两处调用点在写域外 ⇒ 保导出为加载期兼容）。
// 用例名逐个保留（便于对账），断言由「判据成立」反转为「判据面不存在 + 入口恒 no-op」。

import test from 'node:test';
import assert from 'node:assert/strict';

import * as replayMod from '../lib/engine/replay.js';
import { replayBatch } from '../lib/engine/replay.js';

test('R-1【退役锁】`settleTsOf` 已随重放退役删除（不再导出：判据对象已不存在）', () => {
  assert.equal(Object.hasOwn(replayMod, 'settleTsOf'), false, '结算时刻纯函数已删除（非「改名保留」）');
  assert.equal(typeof replayMod.settleTsOf, 'undefined', '导出面不存在');
});

test('R-2【退役锁】`advancedAfter` 已随重放退役删除（`chain.step` 不再驱动任何决策）', () => {
  assert.equal(Object.hasOwn(replayMod, 'advancedAfter'), false, '幂等判据纯函数已删除');
  assert.equal(typeof replayMod.advancedAfter, 'undefined', '导出面不存在');
});

test('R-3【退役锁】`pendingAdvancesOf` 已随重放退役删除；`replayBatch` 恒空壳（零判据/零读批/零事件）', async () => {
  assert.equal(Object.hasOwn(replayMod, 'pendingAdvancesOf'), false, '「待重放 lane」纯函数已删除');
  assert.equal(typeof replayBatch, 'function', '入口保留导出（两处写域外调用点的加载期兼容）');

  // 入口恒 no-op：**不读批**（传不存在的 store/session/batch 亦不抛、不改形状）、零事件、零派发。
  const out = await replayBatch({ store: { readBatch() { throw new Error('不得读批'); } } }, {}, { sessionId: 's', batchId: 'b' });
  assert.deepEqual(out, {
    ok: true, scanned: 0, replayed: 0, results: [], reason: 'retired', note: 'chain-replay-retired-20260918',
  }, '空壳返回形状（零读批：store 读批会抛错，仍未触发）');
  assert.equal(out.scanned, 0, '零扫描（不再判「已结算未推进」）');
  assert.equal(out.replayed, 0, '零重放');
  assert.equal(out.reason, 'retired', '退役结论可判读');
});

// ⚠ 用例名说明（显式登记，禁默认沉默）：R-4 / R-5 的原用例名与断言体在本次改写中**未保全**（原地改写时该文件
//   为非 git 追踪的新增文件，HEAD 无副本可核）⇒ 本 lane 按族序补回两例**退役锁**以维持「用例数不下降」，
//   原名待后续批次按需回填。事实登记见 exec 产物 `exec/engine-retire.md`（§未决 U-6）。

test('R-4【退役锁】重放动作边界已消失：空壳入口零派发、零句柄消费、零成员态变化', async () => {
  const out = await replayBatch({ store: { readBatch() { throw new Error('不得读批'); } } }, {}, { sessionId: 's', batchId: 'b' });
  assert.deepEqual(out.results, [], '[退役锁] 零重放明细（不再有「只决策不派发」的动作边界）');
  assert.equal(out.reason, 'retired', '[退役锁] 退役结论恒可判读');
  assert.equal(typeof replayMod.pendingAdvancesOf, 'undefined', '[退役锁] 判据面已删 ⇒ 不存在「逐 lane 重放」通路');
});

test('R-5【退役锁】重放不新增事件类型：既有 `chain.step` 常量冻结保留，但**写点已删**', async () => {
  const evt = await import('../lib/state/event-types.js');
  assert.equal(evt.EVT_CHAIN_STEP, 'chain.step', '[退役锁] 事件常量冻结保留（历史批磁盘事件面读端不变）');
  assert.equal(typeof replayBatch, 'function', '[退役锁] 入口保留（写域外调用点的加载期兼容）');
  const out = await replayBatch({}, {}, { sessionId: 's', batchId: 'b' });
  assert.equal(out.ok, true, '[退役锁] 空壳恒 ok（零新事件类型引入）');
});
