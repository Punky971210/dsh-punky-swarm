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

const ASSET_PRESET = { rel: 'presets/punky-preset', target: { root: 'preset', subpath: 'punky-preset' } };
// 【P1 同步 · 清单条目 9 → 10】`presets/engine-team` 随 P1 入库，并同步登进 `asset-manifest.json` 与
//   `lib/assets.js` 的 DEFAULT_ASSETS（清单是**单向同步**的真源：包内 → 用户机实装面）。
const ASSET_ENGINE = { rel: 'presets/engine-team', target: { root: 'preset', subpath: 'engine-team' } };
const ASSET_SOFTWARE = { rel: 'skills/software-team', target: { root: 'skill', subpath: 'software-team' } };
// 【P1 同步 · 清单条目 10 → 11】`skills/engine-team` 随 P1 入库（源树由文档链建立），并同步登进
//   `asset-manifest.json` 与 `lib/assets.js` 的 DEFAULT_ASSETS（清单是**单向同步**的真源：包内 → 用户机实装面）。
const ASSET_SKILL_ENGINE = { rel: 'skills/engine-team', target: { root: 'skill', subpath: 'engine-team' } };
const ASSET_DESIGN = { rel: 'skills/design-team', target: { root: 'skill', subpath: 'design-team' } };
// 【清单条目 11 → 10（2026-09-17）】原「团队装配资产说明」技能条目随该技能目录**整体退役**删除：
//   其内容并入 `skills/software-team/SKILL.md` 的「装配资产（team-asset）说明与用途」章节，
//   故本条不再登进 `asset-manifest.json` 与 `lib/assets.js` 的 DEFAULT_ASSETS（两处必须与源树同形）。
const ASSET_REVIEW = { rel: 'skills/review-execution', target: { root: 'skill', subpath: 'review-execution' } };
const ASSET_ACCEPTANCE = { rel: 'skills/acceptance-gate', target: { root: 'skill', subpath: 'acceptance-gate' } };
const ASSET_RETRO = { rel: 'skills/retro-and-memory', target: { root: 'skill', subpath: 'retro-and-memory' } };
const ASSET_RESEARCH = { rel: 'skills/research-team', target: { root: 'skill', subpath: 'research-team' } };
const ASSET_WRITING = { rel: 'skills/writing-team', target: { root: 'skill', subpath: 'writing-team' } };

/** 清单条目集（与包内 `asset-manifest.json` 同序；P1 起 11 条 → 本批退役 1 条 = **10 条**）。 */
const ALL_ASSETS = [ASSET_PRESET, ASSET_ENGINE, ASSET_SOFTWARE, ASSET_SKILL_ENGINE, ASSET_DESIGN, ASSET_REVIEW, ASSET_ACCEPTANCE, ASSET_RETRO, ASSET_RESEARCH, ASSET_WRITING];

/** 落点冻结表（Q-2 枚举 + v3 自建手册三件（review-execution / acceptance-gate / retro-and-memory，原四件之一已退役）+ research-team/writing-team + P1 engine-team 双条）：根枚举 → home 下相对段 → 该资产源树内的代表性文件。 */
const ALL_TARGETS = [
  { asset: ASSET_PRESET, rel: ['.dsh', '.agent-presets', 'punky-preset'], file: 'preset.yml' },
  { asset: ASSET_ENGINE, rel: ['.dsh', '.agent-presets', 'engine-team'], file: 'team-asset.yml' },
  { asset: ASSET_SOFTWARE, rel: ['.agents', 'skills', 'software-team'], file: 'SKILL.md' },
  { asset: ASSET_SKILL_ENGINE, rel: ['.agents', 'skills', 'engine-team'], file: 'SKILL.md' },
  { asset: ASSET_DESIGN, rel: ['.agents', 'skills', 'design-team'], file: 'SKILL.md' },
  { asset: ASSET_REVIEW, rel: ['.agents', 'skills', 'review-execution'], file: 'SKILL.md' },
  { asset: ASSET_ACCEPTANCE, rel: ['.agents', 'skills', 'acceptance-gate'], file: 'SKILL.md' },
  { asset: ASSET_RETRO, rel: ['.agents', 'skills', 'retro-and-memory'], file: 'SKILL.md' },
  { asset: ASSET_RESEARCH, rel: ['.agents', 'skills', 'research-team'], file: 'SKILL.md' },
  { asset: ASSET_WRITING, rel: ['.agents', 'skills', 'writing-team'], file: 'SKILL.md' },
];

/** 全部清单条落点存在性断言（落点冻结 Q-2 + v3 自建手册三件 + research-team + writing-team + P1 engine-team）。 */
function assertAllTargets(home) {
  for (const { rel, file } of ALL_TARGETS) {
    assert.equal(existsSync(join(home, ...rel, file)), true, `落点缺失：${rel.join('/')}/${file}`);
  }
}

/** 同构包树（清单由调用方决定是否写入）；`presets/engine-team` 与 `skills/engine-team` 随 P1 一并入包。 */
function makePkg(root, { software = true, engine = true, design = true } = {}) {
  makeTree(join(root, 'presets/punky-preset'), { 'preset.yml': 'p', 'agent.cordis.yml': 'a' });
  makeTree(join(root, 'presets/engine-team'), { 'team-asset.yml': '{"team":"engine-team"}' });
  if (software) makeTree(join(root, 'skills/software-team'), { 'SKILL.md': 's' });
  if (engine) makeTree(join(root, 'skills/engine-team'), { 'SKILL.md': 'e' });
  if (design) makeTree(join(root, 'skills/design-team'), { 'SKILL.md': 'd' });
  // 夹具树按**资产名**而非表索引驱动（P1 改造）：开关（software/engine/design）能逐条跳过对应源树，
  //   与落点表长度/顺序解耦 —— 增删 `ALL_TARGETS` 表项不会再让夹具树静默错位。
  //   三个特殊条（上面已显式建树/受开关控制）跳过；其余技能树一律补齐。
  //   T-6 的 `{design:false}` 依赖此处如实跳过 design-team 源树（漏造/多造都会让 missing-source 断言反转）。
  const byFlag = { 'skills/software-team': software, 'skills/engine-team': engine, 'skills/design-team': design };
  for (const { asset, file } of ALL_TARGETS) {
    const rel = asset.rel;
    if (rel === 'presets/punky-preset' || rel === 'presets/engine-team') continue;
    if (Object.hasOwn(byFlag, rel)) { if (byFlag[rel]) makeTree(join(root, ...rel.split('/')), { [file]: rel }); continue; }
    makeTree(join(root, ...rel.split('/')), { [file]: rel });
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

test('syncAssets: 十资产同步到模拟 home + 二次幂等', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'punky-assets-'));
  try {
    const root = join(tmp, 'pkg');
    makePkg(root);
    const home = join(tmp, 'home');
    const { results: r1 } = syncAssets({ home, packageRoot: root });
    assert.deepEqual(r1.map((x) => x.status), Array(ALL_ASSETS.length).fill('synced'));
    assert.equal(ALL_ASSETS.length, 10, '【清单条目 11 → 10】原「团队装配资产说明」技能退役，条目随目录删除');
    assertAllTargets(home);
    const { results: r2 } = syncAssets({ home, packageRoot: root });
    assert.deepEqual(r2.map((x) => x.status), Array(ALL_ASSETS.length).fill('current'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('syncAssets: 源缺失 -> missing-source 不报错', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'punky-assets-'));
  try {
    const root = join(tmp, 'empty');
    mkdirSync(root, { recursive: true });
    const { results: r } = syncAssets({ home: join(tmp, 'home'), packageRoot: root });
    assert.deepEqual(r.map((x) => x.status), Array(ALL_ASSETS.length).fill('missing-source'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ——新增：清单驱动（T-1 … T-7）——

test('T-1 syncAssets: 清单存在且合法 -> manifest=ok 且全部落点齐备（本批起 10 条）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'punky-assets-'));
  try {
    const root = join(tmp, 'pkg');
    makePkg(root);
    writeManifest(join(root, 'presets/punky-preset'), baseManifest(ALL_ASSETS));
    const home = join(tmp, 'home');
    const { results, manifest } = syncAssets({ home, packageRoot: root });
    assert.equal(manifest, 'ok');
    assert.deepEqual(results.map((x) => x.asset), ALL_ASSETS.map((a) => a.rel));
    assert.equal(results[0].status, 'synced');
    assertAllTargets(home);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('T-2 syncAssets: 清单驱动生效 -> 未声明条目不同步', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'punky-assets-'));
  try {
    const root = join(tmp, 'pkg');
    makePkg(root);
    // 只声明预设本体；skills/software-team 在源树中存在但未声明 -> 必须不同步
    writeManifest(join(root, 'presets/punky-preset'), baseManifest([ASSET_PRESET]));
    const home = join(tmp, 'home');
    const { results } = syncAssets({ home, packageRoot: root });
    assert.deepEqual(results.map((x) => x.asset), ['presets/punky-preset']);
    assert.equal(existsSync(join(home, '.agents', 'skills', 'software-team', 'SKILL.md')), false);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('T-3 syncAssets: 清单缺失 -> 内置默认 10 条 + manifest=missing（P1 同步：+presets/engine-team、+skills/engine-team；本批 11 → 10）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'punky-assets-'));
  try {
    const root = join(tmp, 'pkg');
    makePkg(root);
    const home = join(tmp, 'home');
    const { results, manifest } = syncAssets({ home, packageRoot: root });
    assert.equal(manifest, 'missing');
    assert.equal(results.length, ALL_ASSETS.length);
    assert.deepEqual(results.map((x) => x.asset), ALL_ASSETS.map((a) => a.rel));
    assertAllTargets(home);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('T-4 syncAssets: 清单 JSON 非法 -> 降级 parse-error 且全部落点仍同步', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'punky-assets-'));
  try {
    const root = join(tmp, 'pkg');
    makePkg(root);
    makeTree(join(root, 'presets/punky-preset'), { 'asset-manifest.json': '{ not json' });
    const home = join(tmp, 'home');
    const { results, manifest } = syncAssets({ home, packageRoot: root });
    assert.equal(manifest, 'parse-error');
    assert.equal(results.length, ALL_ASSETS.length);
    assertAllTargets(home);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('T-5 syncAssets: 清单 schema 非法 -> 降级 schema-invalid:… 且不越界写', () => {
  const cases = [
    ['manifestVersion', { manifestVersion: 2, description: 'x', assets: [ASSET_PRESET] }],
    ['assets', { manifestVersion: 1, description: 'x', assets: [] }],
    ['target.root', baseManifest([{ rel: 'presets/punky-preset', target: { root: 'home', subpath: 'x' } }])],
    ['target.subpath', baseManifest([{ rel: 'presets/punky-preset', target: { root: 'preset', subpath: '../../etc' } }])],
    ['bootstrap-cycle', baseManifest([{ rel: MANIFEST_REL, target: { root: 'preset', subpath: 'punky-preset' } }])],
  ];
  for (const [field, bad] of cases) {
    const tmp = mkdtempSync(join(tmpdir(), 'punky-assets-'));
    try {
      const root = join(tmp, 'pkg');
      makePkg(root);
      writeManifest(join(root, 'presets/punky-preset'), bad);
      const home = join(tmp, 'home');
      const { results, manifest } = syncAssets({ home, packageRoot: root });
      assert.equal(manifest, 'schema-invalid:' + field);
      assert.equal(results.length, ALL_ASSETS.length);
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
    writeManifest(join(root, 'presets/punky-preset'), baseManifest(ALL_ASSETS));
    const home = join(tmp, 'home');
    const { results, manifest } = syncAssets({ home, packageRoot: root });
    assert.equal(manifest, 'ok');
    assert.equal(results.length, ALL_ASSETS.length);
    // design-team 源树缺失（makePkg({design:false})）⇒ 该条 missing-source，其余照旧（表序与 ALL_ASSETS 同序）
    assert.deepEqual(results.map((x) => x.status),
      ALL_ASSETS.map((a) => (a.rel === 'skills/design-team' ? 'missing-source' : 'synced')));
    assert.deepEqual(results.find((x) => x.asset === 'skills/design-team'), { asset: 'skills/design-team', status: 'missing-source' });
    // 补充断言：自举条落盘且与包内清单字节一致（B 层文件粒度生效）
    const destManifest = join(home, '.dsh', '.agent-presets', 'punky-preset', 'asset-manifest.json');
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
    writeManifest(join(rootManifest, 'presets/punky-preset'), baseManifest(ALL_ASSETS));
    const homeManifest = join(tmp, 'home-manifest');
    const homeDefault = join(tmp, 'home-default');
    const first = syncAssets({ home: homeManifest, packageRoot: rootManifest });
    const second = syncAssets({ home: homeManifest, packageRoot: rootManifest });
    const degraded = syncAssets({ home: homeDefault, packageRoot: rootDefault });
    assert.equal(first.manifest, 'ok');
    assert.equal(degraded.manifest, 'missing');
    assert.deepEqual(first.results.map((x) => x.status), Array(ALL_ASSETS.length).fill('synced'));
    assert.deepEqual(second.results.map((x) => x.status), Array(ALL_ASSETS.length).fill('current'));
    assert.deepEqual(first.results.map((x) => x.asset), degraded.results.map((x) => x.asset));
    assert.equal(first.results.length, ALL_ASSETS.length);
    assert.equal(degraded.results.length, ALL_ASSETS.length);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
