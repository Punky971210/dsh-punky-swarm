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

// selfcheck-install.mjs —— 安装三面**只读自检**（批 onekey-install-20260927 · lane exec-smoke · I-6）
//
// 为什么需要它（判据源 `plan/install-spec.md` §问题 §四）：DSH 0.1.7-rc.x 对非必需条目是
//   **per-entry fail-soft**（`exec/failsoft.md` §一 实测）——某一行坏只落 stderr warning，**进程照起**。
//   于是「模式静默消失」无人察觉。本入口把三面状态变成**可主动查询的事实**。
//
// 三面（与判据源 §概述 三面映射 ①②③ 一一对应）：
//   engine 面①：`<home>/.dsh/profiles/<profile>/package.json` 的 `dependencies` 与 `dsh.profile.bundles`
//                **都含** `dsh-punky-swarm`（`dsh plugin add` 写两处，取证②）。
//   preset 面②：同 manifest 的 `dependencies` 与 `dsh.profile.bundles` **都含**上游聚合包
//                `@deepseek-ai/dsh-experimental-agent-team-profile`；且指引正档
//                `<home>/.dsh/.agent-presets/punky-preset/preset.yml` 存在。
//   skills 面③：`<home>/.agents/skills/<8 名>/SKILL.md` **八件全在**，且
//                `<home>/.dsh/.agent-presets/punky-preset/references/` **非空**。
//
// 只读纪律（D-4 污染红线 · I-6(a)）：
//   · home 只从 `--home` 或 `os.homedir()` 取 —— **不读任何宿主 home 环境变量**（`lib/assets.js:210` 亦只读
//     `opts.home ?? homedir()`；本脚本连该变量的名字都不出现，可由 grep 断言，见 I-6(d)）。
//   · 当 home 解析到**真实用户主目录**（真源 = `os.userInfo().homedir`，系统账户 API，不受 USERPROFILE /
//     HOME 改写影响）⇒ 强制 `read-only` 模式：**不调用资产同步写路径**，三面仅由只读文件事实判定。
//   · 只有 home **不是**真实主目录（例如 `--home <tmp>`）时才调用 `syncAssets({home})`，并把其
//     `{results, manifest}` **原样透出**（I-6(b) 要求底层读数可见）。
//
// 用法：
//   node scripts/selfcheck-install.mjs [--home <dir>] [--profile <name>] [--json]
//   exit 0 ⟺ 三面齐备（且同步模式下无 failed / missing-source 条目）；否则非 0 并列出缺口项。
//
// 本脚本**不 import 任何宿主内部包**（D-6）：只走 `fs` / `os` / `path` + 本包 `lib/assets.js`。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncAssets } from '../lib/assets.js';

const PKG_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** 八个团队技能指针目录（与判据源 §概述 三面映射 ③ 逐字一致）。 */
const SKILL_NAMES = [
  'acceptance-gate', 'design-team', 'engine-team', 'research-team',
  'retro-and-memory', 'review-execution', 'software-team', 'writing-team',
];

/** 上游聚合包名（面② 的载体；其 dependencies 自动带出另三件团队包，见取证④）。 */
const TEAM_PROFILE_PKG = '@deepseek-ai/dsh-experimental-agent-team-profile';

/** 本引擎包名（面① 的载体）。 */
const ENGINE_PKG = 'dsh-punky-swarm';

function realUserHome() {
  try { return os.userInfo().homedir; } catch { return ''; }
}

function parseArgs(argv) {
  const out = { home: '', profile: 'web', json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--home') { out.home = String(argv[i + 1] ?? ''); i += 1; continue; }
    if (a === '--profile') { out.profile = String(argv[i + 1] ?? ''); i += 1; continue; }
    if (a === '--json') { out.json = true; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
  }
  return out;
}

/** 同一路径判定（大小写不敏感；`path.resolve` 归一化，避免相对/尾斜杠造成假阴性）。 */
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 面① / 面②：profile manifest 的 dependencies 与 dsh.profile.bundles 两处**都**含目标包名。 */
function faceOfManifest(home, profile, pkgName, label) {
  const gaps = [];
  const manifestPath = path.join(home, '.dsh', 'profiles', profile, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    gaps.push(label + '.profile-missing：' + manifestPath + ' 不存在（profile 未安装）');
    return { ok: false, gaps, manifestPath, inDependencies: false, inBundles: false };
  }
  const doc = readJson(manifestPath);
  if (doc === null) {
    gaps.push(label + '.profile-unreadable：' + manifestPath + ' 不是合法 JSON');
    return { ok: false, gaps, manifestPath, inDependencies: false, inBundles: false };
  }
  const deps = doc.dependencies ?? {};
  const bundles = doc.dsh?.profile?.bundles ?? [];
  const inDependencies = Object.prototype.hasOwnProperty.call(deps, pkgName);
  const inBundles = Array.isArray(bundles) && bundles.includes(pkgName);
  if (!inDependencies) gaps.push(label + '.not-in-dependencies：' + pkgName);
  if (!inBundles) gaps.push(label + '.not-in-bundles：' + pkgName);
  return { ok: inDependencies && inBundles, gaps, manifestPath, inDependencies, inBundles };
}

/** 面② 附加位：指引正档（`preset.yml`）必须在场 —— 面①/② 的 plugin 行注册成功之外，正档也要落地。 */
function faceOfPresetFiles(home, label) {
  const gaps = [];
  const presetDir = path.join(home, '.dsh', '.agent-presets', 'punky-preset');
  const presetYml = path.join(presetDir, 'preset.yml');
  if (!fs.existsSync(presetYml)) gaps.push(label + '.preset-yml-missing：' + presetYml);
  return { ok: gaps.length === 0, gaps, presetDir, presetYml };
}

/** 面③：八个技能指针 + `references/` 非空。 */
function faceOfSkills(home) {
  const gaps = [];
  const skillsRoot = path.join(home, '.agents', 'skills');
  const found = [];
  for (const name of SKILL_NAMES) {
    const f = path.join(skillsRoot, name, 'SKILL.md');
    if (fs.existsSync(f)) found.push(name);
    else gaps.push('skills.skill-missing：' + f);
  }
  const refs = path.join(home, '.dsh', '.agent-presets', 'punky-preset', 'references');
  let refEntries = 0;
  if (!fs.existsSync(refs)) gaps.push('skills.references-missing：' + refs);
  else refEntries = fs.readdirSync(refs).length;
  if (fs.existsSync(refs) && refEntries === 0) gaps.push('skills.references-empty：' + refs);
  return { ok: gaps.length === 0, gaps, skillsRoot, found, refEntries };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('用法: node scripts/selfcheck-install.mjs [--home <dir>] [--profile <name>] [--json]\n');
    return 0;
  }
  const realHome = realUserHome();
  const home = path.resolve(args.home || os.homedir());
  const readOnly = samePath(home, realHome);

  // 同步（仅限非真实 home）：把资产写路径的底层读数透出；真实 home 一律不走该路径。
  let sync = { results: null, manifest: null };
  if (!readOnly) sync = syncAssets({ home, packageRoot: PKG_ROOT });

  const engine = faceOfManifest(home, args.profile, ENGINE_PKG, 'engine');
  const presetRow = faceOfManifest(home, args.profile, TEAM_PROFILE_PKG, 'preset');
  const presetFiles = faceOfPresetFiles(home, 'preset');
  const preset = {
    ok: presetRow.ok && presetFiles.ok,
    gaps: [...presetRow.gaps, ...presetFiles.gaps],
    inDependencies: presetRow.inDependencies,
    inBundles: presetRow.inBundles,
    presetYml: presetFiles.presetYml,
  };
  const skills = faceOfSkills(home);

  const syncGaps = [];
  if (Array.isArray(sync.results)) {
    for (const r of sync.results) {
      if (r && (r.status === 'failed' || r.status === 'missing-source')) {
        syncGaps.push('assets.' + r.status + '：' + String(r.asset) + (r.error ? '（' + r.error + '）' : ''));
      }
    }
    if (syncGaps.length > 0) skills.gaps.push(...syncGaps);
  }
  if (Array.isArray(sync.results) && syncGaps.length > 0) skills.ok = false;

  const ok = engine.ok && preset.ok && skills.ok;
  const doc = {
    home,
    profile: args.profile,
    mode: readOnly ? 'read-only' : 'sync',
    ok,
    engine: { ok: engine.ok, gaps: engine.gaps, manifestPath: engine.manifestPath, inDependencies: engine.inDependencies, inBundles: engine.inBundles },
    preset: { ok: preset.ok, gaps: preset.gaps, inDependencies: preset.inDependencies, inBundles: preset.inBundles, presetYml: preset.presetYml },
    skills: { ok: skills.ok, gaps: skills.gaps, skillsRoot: skills.skillsRoot, found: skills.found, refEntries: skills.refEntries },
    results: sync.results,
    manifest: sync.manifest,
  };

  if (args.json) {
    process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
  } else {
    process.stdout.write('[selfcheck] home=' + home + ' profile=' + args.profile + ' mode=' + doc.mode + '\n');
    for (const [name, face] of [['engine', doc.engine], ['preset', doc.preset], ['skills', doc.skills]]) {
      process.stdout.write('[selfcheck]   ' + (face.ok ? 'OK  ' : 'GAP ') + name
        + (face.gaps.length > 0 ? '（' + face.gaps.length + ' 项缺口）' : '') + '\n');
      for (const g of face.gaps) process.stdout.write('[selfcheck]       - ' + g + '\n');
    }
    process.stdout.write('[selfcheck] ' + (ok ? 'GREEN 三面齐备' : 'RED 存在缺口（见上）') + '\n');
  }
  return ok ? 0 : 1;
}

process.exit(main());
