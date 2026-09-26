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

// 【F2 台账】团队资产夹具的**单一写入面**与**显式白名单**（夹具审计 `docs/fixture-audit-2026-09-21.md` §3.2）。
//
// 为什么需要它（承 R4-1d「结构性保证取代断言」+ F1「桩须显式声明」）：
//   F2 收敛前，**29 个测试文件**各自 `mkdirSync + writeFileSync('team-asset.…')`。形态散落导致两类风险：
//     · 骨架漂移——「以真实资产为骨架」的用例若被悄悄改成手搓小对象，测的就不再是真实资产；
//     · 合成资产混入——自造的层/流程声明与真实资产脱节，却看不出「这是自造」。
//   收敛后所有**行为类**套件走 `helpers/team-fixture.mjs`（`writeTempTeam` 真实骨架 / `writeSyntheticTeam` 合成）；
//   只有**loader/边界自测族**需要直接写（它们必须造「坏 JSON / 缺字段 / 缺文件 / 字符串原文」，
//   而 `writeSyntheticTeam` 的形状下限校验会挡住这类输入）。
//
// 本台账锁两件事：
//   ① **双向**：直接写 team-asset 的文件集合 ≡ 白名单（新增一处直接写 ⇒ 立刻红，逼你走单点或显式登记）；
//   ② **显式**：每个白名单文件必须带 `【F2 白名单】` 标记（登记是「被审阅过的决定」，不是沉默）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { packageRootOf, declaredSkillsOf } from './helpers/skill-paths.mjs';
import {
  writeTempTeam, writeRealTeam, writeSyntheticTeam, threeTierSyntheticTeam,
  readRealTeamAsset, SKELETON_TEAM,
} from './helpers/team-fixture.mjs';

const PKG = packageRootOf();
const TEST_DIR = path.join(PKG, 'test');

/** 免扫：单点写入面自身（用变量文件名写）+ 本判据文件自身（含规则字面量，自指命中）。 */
const SCANNER_EXEMPT = ['helpers/team-fixture.mjs', 'fixture-team-ledger.test.js'];

/**
 * 显式白名单：**loader/边界自测族**——它们的命题就是「坏资产/缺文件被正确拒」，必须直接写。
 * 维护：若确需新增，请同时在该文件加 `【F2 白名单】` 注释说明理由。
 */
const DIRECT_WRITE_ALLOWLIST = [
  'team-asset-snapshot.test.js',
  'team-asset.test.js',
  'teams-root.test.js',
  // 2026-09-26 移除（用户裁决「团队内容只是模版、不再作为组件 ⇒ 相关测试不再检验」，
  //   三件已整体删除并归档于 reports/archived-tests-20260926/）：
  //   'team-assets-fill.test.js' / 'writing-team-asset.test.js'
];

/** `withDefaultTeam` 的允许名单：只允许「建批是手段、被检面是别的门禁」的套件（F2 台账化）。 */
const WITH_DEFAULT_TEAM_ALLOWLIST = [
  'assembly-gate-extra.test.js',
  'assembly-gate.test.js',
  'batch-control.test.js',
  'budget.test.js',
  // G7 下沉（2026-09-22）：两文件改为委托 helpers/dispatch-fixture.mjs ⇒ 不再直接命中（使用者 = helper 本体）
  'governance.test.js',
  'helpers/dispatch-fixture.mjs', // G7 下沉（2026-09-22）：dispatch 面统一 harness——建批是手段，不断言 team 门禁
  'merge-agent.test.js',
  'mode-gate.test.js',
  'resume.test.js',
  'suite-consistency-and-hot.test.js',
  'tool-schema-conformance.test.js',
  'tools.test.js',
  'worktree-tools.test.js',
];

/** 递归收集 `test/**` 下的 `.js` / `.mjs`，返回相对 `test/` 的 POSIX 路径。 */
function collectTestFiles(dir = TEST_DIR) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collectTestFiles(abs));
    else if (/\.(js|mjs)$/.test(e.name)) out.push(path.relative(TEST_DIR, abs).split(path.sep).join('/'));
  }
  return out.sort();
}

/**
 * 明文规则：**同一行**同时出现写入调用与 `team-asset.<ext>` 文件名 ⇒ 直接写。
 * ⚠ 用 `team-asset.`（带点）而非裸 `team-asset` —— 后者会误命中目录名 `sessions/…/team-assets`。
 * ⚠ 已知边界：把路径拆成多行书写的调用可绕过本判据（本仓当前无此形态；`scripts/audit/fixtures.mjs` 另有线索面）。
 */
function directTeamAssetWriters() {
  const hit = [];
  for (const rel of collectTestFiles()) {
    if (SCANNER_EXEMPT.includes(rel)) continue;
    const lines = fs.readFileSync(path.join(TEST_DIR, rel), 'utf8').split('\n');
    if (lines.some((l) => /(writeFileSync|copyFileSync|appendFileSync)/.test(l) && l.includes('team-asset.'))) {
      hit.push(rel);
    }
  }
  return hit;
}

// ── ① 双向：直接写集合 ≡ 白名单 ───────────────────────────────────────────────

test('F2-1 团队资产直接写：集合 ≡ 白名单（新增直接写 ⇒ 红；逼走单点或显式登记）', () => {
  const actual = directTeamAssetWriters();
  assert.deepEqual(actual, DIRECT_WRITE_ALLOWLIST,
    '团队资产的直接写入者必须与白名单**双向相等**。\n'
    + '  若你新增了一处直接写：请改用 `helpers/team-fixture.mjs` 的 `writeTempTeam`（真实骨架）'
    + '或 `writeSyntheticTeam`（合成）；\n'
    + '  若确属 loader/边界自测（须造坏 JSON / 缺字段 / 字符串原文）⇒ 加进白名单**并**在该文件加 `【F2 白名单】` 注释。\n'
    + '实际：' + JSON.stringify(actual));
});

test('F2-2 白名单是**显式**决定：每个白名单文件都带 `【F2 白名单】` 标记', () => {
  const missing = [];
  for (const rel of DIRECT_WRITE_ALLOWLIST) {
    const src = fs.readFileSync(path.join(TEST_DIR, rel), 'utf8');
    if (!src.includes('【F2 白名单】')) missing.push(rel);
  }
  assert.deepEqual(missing, [], '白名单文件必须显式声明理由（缺标记：' + JSON.stringify(missing) + '）');
});

// ── ② 白名单的**理由**可验证：writeSyntheticTeam 确实拒绝这些形态 ─────────────

test('F2-3 白名单理由自证：`writeSyntheticTeam` 拒绝 loader 自测所需的坏形态', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || process.env.TEMP || '/tmp'), 'f2-ledger-'));
  const cases = [
    ['根非对象', 'not-an-object'],
    ['根为数组', []],
    ['层集合为空', { team: 'x', layers: {} }],
    ['role 集为空', { team: 'x', layers: { plan: { roles: [], skills: {} } } }],
    ['缺 skills 对象', { team: 'x', layers: { plan: { roles: ['r'] } } }],
  ];
  for (const [label, bad] of cases) {
    assert.throws(() => writeSyntheticTeam(root, 'syn-team', bad), /fixture: writeSyntheticTeam/,
      label + ' ⇒ 须被形状下限校验拒（这正是 loader 自测必须直接写的原因）');
  }
  // 团队名非空是**前置**（不能靠 asset.team 顶替）
  assert.throws(() => writeSyntheticTeam(root, '', { team: 'x', layers: { plan: { roles: ['r'], skills: {} } } }),
    /非空团队名/, '团队名须非空');
});

// ── ③ 真实骨架保真：未 mutate 时与包内资产**深等**（防骨架被悄悄改小） ─────────

test('F2-4 真实骨架保真：`writeTempTeam` 未 mutate 的产物 ≡ 包内真实资产（防漂移）', () => {
  const team = 'f2-fidelity-team';
  const root = writeTempTeam('f2-fidelity-', team);
  const written = JSON.parse(fs.readFileSync(path.join(root, 'presets', team, 'team-asset.yml'), 'utf8'));
  const packaged = readRealTeamAsset(SKELETON_TEAM).asset;
  assert.deepEqual(written, packaged,
    '「真实骨架」用例产出的资产须与 `presets/' + SKELETON_TEAM + '/team-asset.yml` **逐字段相等**；'
    + '若你要的是另一形态 ⇒ 那是**合成**资产，请改用 `writeSyntheticTeam`（并接受「与真实资产脱节」已被显式标注）');
  // 缺省**不**改 `asset.team`（读端不校验它与目录名一致，见 helper 注释）⇒ 保留源团队名
  assert.equal(written.team, SKELETON_TEAM, '缺省保留源 team 字段（零行为变更）');
  // 显式 `setTeam` 才同步
  const root2 = writeTempTeam('f2-fidelity2-', 'other-team', () => {}, { setTeam: true });
  const w2 = JSON.parse(fs.readFileSync(path.join(root2, 'presets', 'other-team', 'team-asset.yml'), 'utf8'));
  assert.equal(w2.team, 'other-team', '`setTeam: true` ⇒ 同步 asset.team');
});

test('F2-4b 写入面可写入调用方给定的根（`writeRealTeam`）且可回读', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || process.env.TEMP || '/tmp'), 'f2-real-'));
  const asset = writeRealTeam(root, 'r-team', (a) => { a.flows.exec.produce_field = 'produce'; });
  assert.equal(asset.flows.exec.produce_field, 'produce', 'mutate 生效');
  const back = JSON.parse(fs.readFileSync(path.join(root, 'presets', 'r-team', 'team-asset.yml'), 'utf8'));
  assert.deepEqual(back, asset, '落盘内容 ≡ 返回对象');
});

// ── ④ 合成资产：声明面齐备（可被 declaredSkillsOf 正常消费） ─────────────────

test('F2-5 合成资产：`threeTierSyntheticTeam` 声明面齐备（三层三角色 + 可解析技能名形状）', () => {
  const a = threeTierSyntheticTeam('syn-team');
  assert.equal(a.team, 'syn-team');
  assert.deepEqual(Object.keys(a.layers).sort(), ['audit', 'exec', 'plan']);
  for (const [layer, def] of Object.entries(a.layers)) {
    assert.ok(Array.isArray(def.roles) && def.roles.length > 0, layer + ' 有角色');
    for (const r of def.roles) {
      assert.ok(Array.isArray(def.skills[r]) && def.skills[r].length > 0, layer + '.' + r + ' 有技能名');
    }
  }
  assert.deepEqual(declaredSkillsOf(a).sort(), ['dev-coder', 'dev-designer', 'report-blind-audit'],
    '声明技能集合稳定（这些名是**合成**的）');
});

// ── ⑤ `withDefaultTeam` 允许名单：双向 ──────────────────────────────────────

test('F2-6 `withDefaultTeam` 使用者 ≡ 允许名单（双向；断言 team 必填的套件不得误用）', () => {
  const actual = collectTestFiles()
    .filter((rel) => {
      const src = fs.readFileSync(path.join(TEST_DIR, rel), 'utf8');
      return /withDefaultTeam\s*\(/.test(src) && !/function withDefaultTeam/.test(src);
    })
    .sort();
  assert.deepEqual(actual, WITH_DEFAULT_TEAM_ALLOWLIST,
    '`withDefaultTeam` 会注入 `team` ⇒ 遮蔽「team 必填」门禁，只允许「建批是手段」的套件使用。\n'
    + '  若新增使用：确认该套件**不**断言 team 相关门禁，然后登记进允许名单。\n'
    + '实际：' + JSON.stringify(actual));
});

// ── F2-7 已删（2026-09-26）───────────────────────────────────────────────────
// 原测对象 `team-asset-mandatory.test.js` / `team-assets-fill.test.js` /
//   `writing-team-asset.test.js` 三件已整体删除（用户裁决「团队内容只是模版、不再作为组件
//   ⇒ 相关测试不再检验」；归档于 reports/archived-tests-20260926/）
//   ⇒ 该测试**无对象可测**，且其 `fs.readFileSync` 会对不存在的文件抛错。
// ⚠ **其语义未失效**：原命题 = 「断言 `team` 必填/无资产的套件**不得**误用 `withDefaultTeam`」
//   （`withDefaultTeam` 会注入 `team` ⇒ 遮蔽「team 必填」门禁 ⇒ 命题恒真）。
//   ⇒ 若日后新增同类套件，**应恢复本测试**并把文件名重新登记。
