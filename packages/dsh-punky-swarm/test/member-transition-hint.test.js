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

// D-4（2026-09-16 清债）回归：状态机**保持严格**，但非法迁移的报错必须**自带下一步**。
//   活体高频踩点：`running -> merged/skipped` 被拒（结算前须先经 review），旧报错只有
//   「invalid member transition: running -> merged」，Leader 得猜一步再试（本轮已多次发生）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { threeTierTasks, seedArtifacts } from './helpers/gate-fixture.mjs';

const S = 's-trans';

function freshStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-d4-'));
  const store = createStore(root);
  store.createBatch(S, {
    batchId: 'b-d4',
    wavePlan: buildWavePlan({ batchId: 'b-d4', tasks: threeTierTasks(['e1'], { auditId: 'a1' }), team: 'generic' }),
  });
  // 夹具前置：e1 的 entry 门要求 consume 件在场（plan/spec.md），否则 setMember(running) 先被
  // GATE_ENTRY_MISSING 拦下，根本走不到「状态迁移」这一被验面（本测试第一版即踩此坑）。
  seedArtifacts(root, S, 'b-d4', ['e1'], { planProduct: 'plan/spec.md' });
  return store;
}

test('D4-1 running→merged 被拒（严格性不放松），但报错自带 review 中转与调用样例', () => {
  const store = freshStore();
  store.setMember(S, 'b-d4', 'e1', 'running');
  let msg = '';
  try { store.setMember(S, 'b-d4', 'e1', 'merged'); } catch (e) { msg = e.message; }
  assert.match(msg, /invalid member transition: running -> merged/, '仍须是非法迁移拒态');
  assert.match(msg, /下一步：先 `member_status/, '须给下一步调用样例');
  assert.match(msg, /status: "review"/, '须点名 review 中转');
  assert.match(msg, /member_settle\(\{ batchId, lane, status: "merged" \}\)/, '须给结算样例');
  assert.equal(store.readBatch(S, 'b-d4').lanes.e1, 'running', '被拒后 lane 状态不得变化');
});

test('D4-2 合法路径 running→review→merged 正常，不产生无关提示', () => {
  const store = freshStore();
  store.setMember(S, 'b-d4', 'e1', 'running');
  // running → skipped 属**合法迁移**（另有「condition unmet」分支），本用例不对其断言。
  store.setMember(S, 'b-d4', 'e1', 'review');
  assert.equal(store.readBatch(S, 'b-d4').lanes.e1, 'review');
  store.setMember(S, 'b-d4', 'e1', 'merged');
  assert.equal(store.readBatch(S, 'b-d4').lanes.e1, 'merged');
  const evs = store.readBatch(S, 'b-d4').events.filter((e) => e.type === 'member.settled' && e.lane === 'e1');
  assert.ok(evs.some((e) => e.to === 'merged'), '合并事件须落盘');
});
