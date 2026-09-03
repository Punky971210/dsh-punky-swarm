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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import * as schema from '../lib/schema.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-rework-'));
const store = createStore(root);
const S = 'sess-rw';

test('schema allows review -> running (rework)', () => {
  assert.equal(schema.canTransitionMember('review', 'running'), true);
  assert.equal(schema.canTransitionMember('running', 'review'), true);
});

test('rework cycle: pending->running->review->running(x2)->review->merged', () => {
  const plan = buildWavePlan({ batchId: 'b-rework', tasks: [{ id: 't1' }] });
  store.createBatch(S, { batchId: 'b-rework', wavePlan: plan, phase: 'running' });
  store.setMember(S, 'b-rework', 't1', 'running');   // 派发
  store.setMember(S, 'b-rework', 't1', 'review');    // 提交评审
  store.setMember(S, 'b-rework', 't1', 'running');   // REWORK 打回返工（attempt 1）
  store.setMember(S, 'b-rework', 't1', 'review');    // 再提交
  store.setMember(S, 'b-rework', 't1', 'running');   // REWORK 打回返工（attempt 2）
  store.setMember(S, 'b-rework', 't1', 'review');    // 三审
  store.setMember(S, 'b-rework', 't1', 'merged');    // 通过
  const b = store.readBatch(S, 'b-rework');
  assert.equal(b.lanes.t1, 'merged');
  const reworks = b.events.filter((e) => e.type === 'member.settled' && e.lane === 't1' && e.from === 'review' && e.to === 'running').length;
  assert.equal(reworks, 2);
  assert.equal(store.batchAutoReleaseable(b), true);
});

test('autoReleaseable false when conflict/failed present', () => {
  const plan = buildWavePlan({ batchId: 'b-cf', tasks: [{ id: 'a' }, { id: 'b' }] });
  store.createBatch(S, { batchId: 'b-cf', wavePlan: plan, phase: 'running' });
  store.setMember(S, 'b-cf', 'a', 'running');
  store.setMember(S, 'b-cf', 'a', 'review');
  store.setMember(S, 'b-cf', 'a', 'merged');
  store.setMember(S, 'b-cf', 'b', 'running');
  store.setMember(S, 'b-cf', 'b', 'review');
  store.setMember(S, 'b-cf', 'b', 'failed');
  assert.equal(store.batchAutoReleaseable(store.readBatch(S, 'b-cf')), false);
});

test('3-retreat escalation marker derivable from events (attempt >= 3)', () => {
  const plan = buildWavePlan({ batchId: 'b-esc', tasks: [{ id: 'x' }] });
  store.createBatch(S, { batchId: 'b-esc', wavePlan: plan, phase: 'running' });
  for (let i = 0; i < 4; i++) {
    store.setMember(S, 'b-esc', 'x', 'running');
    store.setMember(S, 'b-esc', 'x', 'review');
  }
  const b = store.readBatch(S, 'b-esc');
  const reworks = b.events.filter((e) => e.type === 'member.settled' && e.lane === 'x' && e.from === 'review' && e.to === 'running').length;
  assert.equal(reworks, 3);
  assert.equal(reworks >= 3, true);
});
