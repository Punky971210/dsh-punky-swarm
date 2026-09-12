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
import { syncDir, syncAssets, resolveTarget, MANIFEST_REL } from '../lib/assets.js';

function makeTree(root, spec) {
  for (const [rel, content] of Object.entries(spec)) {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
}

function writeManifest(presetDir, manifest) {
  writeFileSync(join(presetDir, 'asset-manifest.json'), JSON.stringify(manifest));
}

function baseManifest(assets) {
  return { manifestVersion: 1, description: '测试清单', assets };
}

const ASSET_PRESET = { rel: 'presets/jiufeng', target: { root: 'preset', subpath: 'jiufeng' } };
const ASSET_SOFTWARE = { rel: 'skills/software-team', target: { root: 'skill', subpath: 'software-team' } };
const ASSET_DESIGN = { rel: 'skills/design-team', target: { root: 'skill', subpath: 'design-team' } };

/** 三资产齐全的同构包树（清单由调用方决定是否写入）。 */
function makePkg(root, { software = true, design = true } = {}) {
  makeTree(join(root, 'presets/jiufeng'), { 'preset.yml': 'p', 'agent.cordis.yml': 'a' });
  if (software) makeTree(join(root, 'skills/software-team'), { 'SKILL.md': 's' });
  if (design) makeTree(join(root, 'skills/design-team'), { 'SKILL.md': 'd' });
}

/** 三落点存在性断言（落点冻结 Q-2）。 */
function assertThreeTargets(home) {
  assert.equal(existsSync(join(home, '.dsh', '.agent-presets', 'jiufeng', 'preset.yml')), true);
  assert.equal(existsSync(join(home, '.agents', 'skills', 'software-team', 'SKILL.md')), true);
  assert.equal(existsSync(join(home, '.agents', 'skills', 'design-team', 'SKILL.md')), true);
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

test('syncAssets: 三资产同步到模拟 home + 二次幂等', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'punky-assets-'));
  try {
    const root = join(tmp, 'pkg');
    makeTree(join(root, 'presets/jiufeng'), { 'preset.yml': 'p', 'agent.cordis.yml': 'a' });
    makeTree(join(root, 'skills/software-team'), { 'SKILL.md': 's' });
    makeTree(join(root, 'skills/design-team'), { 'SKILL.md': 'd' });
    const home = join(tmp, 'home');
    const { results: r1 } = syncAssets({ home, packageRoot: root });
    assert.deepEqual(r1.map((x) => x.status), ['synced', 'synced', 'synced']);
    assert.equal(existsSync(join(home, '.dsh', '.agent-presets', 'jiufeng', 'preset.yml')), true);
    assert.equal(existsSync(join(home, '.agents', 'skills', 'software-team', 'SKILL.md')), true);
    assert.equal(existsSync(join(home, '.agents', 'skills', 'design-team', 'SKILL.md')), true);
    const { results: r2 } = syncAssets({ home, packageRoot: root });
    assert.deepEqual(r2.map((x) => x.status), ['current', 'current', 'current']);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('syncAssets: 源缺失 -> missing-source 不报错', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'punky-assets-'));
  try {
    const root = join(tmp, 'empty');
    mkdirSync(root, { recursive: true });
    const { results: r } = syncAssets({ home: join(tmp, 'home'), packageRoot: root });
    assert.deepEqual(r.map((x) => x.status), ['missing-source', 'missing-source', 'missing-source']);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ——新增：清单驱动（T-1 … T-7）——

test('T-1 syncAssets: 清单存在且合法 -> manifest=ok 且三落点齐备', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'punky-assets-'));
  try {
    const root = join(tmp, 'pkg');
    makePkg(root);
    writeManifest(join(root, 'presets/jiufeng'), baseManifest([ASSET_PRESET, ASSET_SOFTWARE, ASSET_DESIGN]));
    const home = join(tmp, 'home');
    const { results, manifest } = syncAssets({ home, packageRoot: root });
    assert.equal(manifest, 'ok');
    assert.deepEqual(results.map((x) => x.asset), ['presets/jiufeng', 'skills/software-team', 'skills/design-team']);
    assert.equal(results[0].status, 'synced');
    assertThreeTargets(home);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('T-2 syncAssets: 清单驱动生效 -> 未声明条目不同步', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'punky-assets-'));
  try {
    const root = join(tmp, 'pkg');
    makePkg(root);
    // 只声明预设本体；skills/software-team 在源树中存在但未声明 -> 必须不同步
    writeManifest(join(root, 'presets/jiufeng'), baseManifest([ASSET_PRESET]));
    const home = join(tmp, 'home');
    const { results } = syncAssets({ home, packageRoot: root });
    assert.deepEqual(results.map((x) => x.asset), ['presets/jiufeng']);
    assert.equal(existsSync(join(home, '.agents', 'skills', 'software-team', 'SKILL.md')), false);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('T-3 syncAssets: 清单缺失 -> 内置默认 3 条 + manifest=missing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'punky-assets-'));
  try {
    const root = join(tmp, 'pkg');
    makePkg(root);
    const home = join(tmp, 'home');
    const { results, manifest } = syncAssets({ home, packageRoot: root });
    assert.equal(manifest, 'missing');
    assert.equal(results.length, 3);
    assert.deepEqual(results.map((x) => x.asset), ['presets/jiufeng', 'skills/software-team', 'skills/design-team']);
    assertThreeTargets(home);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('T-4 syncAssets: 清单 JSON 非法 -> 降级 parse-error 且三落点仍同步', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'punky-assets-'));
  try {
    const root = join(tmp, 'pkg');
    makePkg(root);
    makeTree(join(root, 'presets/jiufeng'), { 'asset-manifest.json': '{ not json' });
    const home = join(tmp, 'home');
    const { results, manifest } = syncAssets({ home, packageRoot: root });
    assert.equal(manifest, 'parse-error');
    assert.equal(results.length, 3);
    assertThreeTargets(home);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('T-5 syncAssets: 清单 schema 非法 -> 降级 schema-invalid:… 且不越界写', () => {
  const cases = [
    ['manifestVersion', { manifestVersion: 2, description: 'x', assets: [ASSET_PRESET] }],
    ['assets', { manifestVersion: 1, description: 'x', assets: [] }],
    ['target.root', baseManifest([{ rel: 'presets/jiufeng', target: { root: 'home', subpath: 'x' } }])],
    ['target.subpath', baseManifest([{ rel: 'presets/jiufeng', target: { root: 'preset', subpath: '../../etc' } }])],
    ['bootstrap-cycle', baseManifest([{ rel: MANIFEST_REL, target: { root: 'preset', subpath: 'jiufeng' } }])],
  ];
  for (const [field, bad] of cases) {
    const tmp = mkdtempSync(join(tmpdir(), 'punky-assets-'));
    try {
      const root = join(tmp, 'pkg');
      makePkg(root);
      writeManifest(join(root, 'presets/jiufeng'), bad);
      const home = join(tmp, 'home');
      const { results, manifest } = syncAssets({ home, packageRoot: root });
      assert.equal(manifest, 'schema-invalid:' + field);
      assert.equal(results.length, 3);
      assert.equal(existsSync(join(tmp, 'etc')), false);
      assert.equal(existsSync(join(tmp, 'home', 'etc')), false);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  // D-6 防御性兜底：逃逸分支（schema 已使其经 syncAssets 不可达）直调覆盖
  const tmp2 = mkdtempSync(join(tmpdir(), 'punky-assets-'));
  try {
    const home = join(tmp2, 'home');
    const escaped = resolveTarget(home, { root: 'preset', subpath: '../../escape' });
    assert.equal(escaped.ok, false);
    assert.equal(escaped.reason, 'target.escape');
    assert.equal(resolveTarget(home, { root: 'skill', subpath: 'software-team' }).ok, true);
  } finally { rmSync(tmp2, { recursive: true, force: true }); }
});

test('T-6 syncAssets: 清单条 rel 缺失 -> 该条 missing-source，其余继续', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'punky-assets-'));
  try {
    const root = join(tmp, 'pkg');
    makePkg(root, { design: false });
    writeManifest(join(root, 'presets/jiufeng'), baseManifest([ASSET_PRESET, ASSET_SOFTWARE, ASSET_DESIGN]));
    const home = join(tmp, 'home');
    const { results, manifest } = syncAssets({ home, packageRoot: root });
    assert.equal(manifest, 'ok');
    assert.equal(results.length, 3);
    assert.deepEqual(results.map((x) => x.status), ['synced', 'synced', 'missing-source']);
    assert.deepEqual(results[2], { asset: 'skills/design-team', status: 'missing-source' });
    // 补充断言：自举条落盘且与包内清单字节一致（B 层文件粒度生效）
    const destManifest = join(home, '.dsh', '.agent-presets', 'jiufeng', 'asset-manifest.json');
    assert.equal(existsSync(destManifest), true);
    assert.equal(readFileSync(destManifest, 'utf8'), readFileSync(join(root, MANIFEST_REL), 'utf8'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('T-7 syncAssets: 双路径等价 + 幂等（自举条不进 results）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'punky-assets-'));
  try {
    const rootManifest = join(tmp, 'pkg-manifest');
    const rootDefault = join(tmp, 'pkg-default');
    makePkg(rootManifest);
    makePkg(rootDefault);
    writeManifest(join(rootManifest, 'presets/jiufeng'), baseManifest([ASSET_PRESET, ASSET_SOFTWARE, ASSET_DESIGN]));
    const homeManifest = join(tmp, 'home-manifest');
    const homeDefault = join(tmp, 'home-default');
    const first = syncAssets({ home: homeManifest, packageRoot: rootManifest });
    const second = syncAssets({ home: homeManifest, packageRoot: rootManifest });
    const degraded = syncAssets({ home: homeDefault, packageRoot: rootDefault });
    assert.equal(first.manifest, 'ok');
    assert.equal(degraded.manifest, 'missing');
    assert.deepEqual(first.results.map((x) => x.status), ['synced', 'synced', 'synced']);
    assert.deepEqual(second.results.map((x) => x.status), ['current', 'current', 'current']);
    assert.deepEqual(first.results.map((x) => x.asset), degraded.results.map((x) => x.asset));
    assert.equal(first.results.length, 3);
    assert.equal(degraded.results.length, 3);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
