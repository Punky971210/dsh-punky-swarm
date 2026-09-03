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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncDir, syncAssets } from '../lib/assets.js';

function makeTree(root, spec) {
  for (const [rel, content] of Object.entries(spec)) {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
}

test('syncDir: 缺失目标 -> synced 并写入', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'punky-assets-'));
  try {
    makeTree(join(tmp, 'src'), { 'a.md': 'A', 'sub/b.md': 'B' });
    const status = syncDir(join(tmp, 'src'), join(tmp, 'dst'));
    assert.equal(status, 'synced');
    assert.equal(readFileSync(join(tmp, 'dst', 'a.md'), 'utf8'), 'A');
    assert.equal(readFileSync(join(tmp, 'dst', 'sub', 'b.md'), 'utf8'), 'B');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('syncDir: 目标一致 -> current（幂等）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'punky-assets-'));
  try {
    makeTree(join(tmp, 'src'), { 'a.md': 'A' });
    syncDir(join(tmp, 'src'), join(tmp, 'dst'));
    const status = syncDir(join(tmp, 'src'), join(tmp, 'dst'));
    assert.equal(status, 'current');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('syncDir: 目标不一致 -> synced 并覆盖（含多余文件清除）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'punky-assets-'));
  try {
    makeTree(join(tmp, 'src'), { 'a.md': 'A', 'b.md': 'B' });
    makeTree(join(tmp, 'dst'), { 'a.md': 'OLD', 'stale.md': 'X' });
    const status = syncDir(join(tmp, 'src'), join(tmp, 'dst'));
    assert.equal(status, 'synced');
    assert.equal(readFileSync(join(tmp, 'dst', 'a.md'), 'utf8'), 'A');
    assert.equal(readFileSync(join(tmp, 'dst', 'b.md'), 'utf8'), 'B');
    assert.equal(existsSync(join(tmp, 'dst', 'stale.md')), false);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('syncAssets: 双资产同步到模拟 home + 二次幂等', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'punky-assets-'));
  try {
    const root = join(tmp, 'pkg');
    makeTree(join(root, 'presets/jiufeng'), { 'preset.yml': 'p', 'agent.cordis.yml': 'a' });
    makeTree(join(root, 'skills/jiufeng-team'), { 'SKILL.md': 's' });
    const home = join(tmp, 'home');
    const r1 = syncAssets({ home, packageRoot: root });
    assert.deepEqual(r1.map((x) => x.status), ['synced', 'synced']);
    assert.equal(existsSync(join(home, '.dsh', '.agent-presets', 'jiufeng', 'preset.yml')), true);
    assert.equal(existsSync(join(home, '.agents', 'skills', 'jiufeng-team', 'SKILL.md')), true);
    const r2 = syncAssets({ home, packageRoot: root });
    assert.deepEqual(r2.map((x) => x.status), ['current', 'current']);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('syncAssets: 源缺失 -> missing-source 不报错', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'punky-assets-'));
  try {
    const root = join(tmp, 'empty');
    mkdirSync(root, { recursive: true });
    const r = syncAssets({ home: join(tmp, 'home'), packageRoot: root });
    assert.deepEqual(r.map((x) => x.status), ['missing-source', 'missing-source']);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
