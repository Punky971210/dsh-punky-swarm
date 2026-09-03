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
import { acquire, release, isLocked } from '../lib/lock.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-lock-'));
const lock = path.join(dir, 'b.lock');

test('acquire creates the lock file exclusively', async () => {
  const r = await acquire(lock);
  assert.equal(r.ok, true);
  assert.ok(r.token);
  assert.equal(isLocked(lock), true);
  assert.equal(release(lock, r.token).ok, true);
  assert.equal(isLocked(lock), false);
});

test('second acquire conflicts without wait', async () => {
  const a = await acquire(lock);
  const b = await acquire(lock, { waitMs: 0 });
  assert.equal(b.ok, false);
  assert.equal(b.conflict, true);
  release(lock, a.token);
});

test('wait acquires after release', async () => {
  const a = await acquire(lock);
  const p = acquire(lock, { waitMs: 2000, pollMs: 20 });
  setTimeout(() => release(lock, a.token), 100);
  const r = await p;
  assert.equal(r.ok, true);
  release(lock, r.token);
});

test('wait times out', async () => {
  const a = await acquire(lock);
  const r = await acquire(lock, { waitMs: 120, pollMs: 30 });
  assert.equal(r.ok, false);
  release(lock, a.token);
});

test('force takes over and token mismatch blocks stale release', async () => {
  const a = await acquire(lock);
  const f = await acquire(lock, { force: true });
  assert.equal(f.ok, true);
  // 旧 token 释放被拒（token 不匹配）
  assert.equal(release(lock, a.token).ok, false);
  release(lock, f.token);
});
