#!/usr/bin/env node
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

// 根目录 package.json 生成器（发布形态 C：GitHub 仓库根即可安装，无需 `&path:`）
//
// ── 为什么需要它 ───────────────────────────────────────────────────────────────────────────
// 本仓是「包住在 packages/dsh-punky-swarm/ 里」的布局，而 C 方案要求**仓库根**也能被
//   `dsh plugin add "git+https://…/dsh-punky-swarm.git#<tag>"` 直接装成包 ⇒ 根必须有一份
//   package.json 指向包内实现。于是出现两份 package.json，字段大量重复（实测 15 组）。
//
// ── 真源归属（重要）─────────────────────────────────────────────────────────────────────────
// **真源 = packages/dsh-punky-swarm/package.json**，本脚本产出的是**派生层**（根那份）。
//   理由：包内那份是历史真源 —— 14 个测试文件读它、`npm ci` / `npm test` 在它目录里跑、
//   `lib/aip/tool-descriptor.js:22` 也用相对路径读它取版本。反过来让真源去迁就适配层，
//   等于动 14 个测试的依赖面，风险远大于收益。
//   ⇒ **禁手改根 package.json**：改包内那份，然后跑本脚本重新生成。
//
// ── 用法 ────────────────────────────────────────────────────────────────────────────────
//   node scripts/gen-root-pkg.mjs            # 重写根 package.json
//   node scripts/gen-root-pkg.mjs --check    # 只比对；不一致打印差异并 exit 1（CI 用）
//
// ── 前缀转换规则 ──────────────────────────────────────────────────────────────────────────
//   · 字段级：icon / main / exports / files / dsh.bundle.patch 统一加 `packages/dsh-punky-swarm/`
//   · scripts：值里的 `./x` 或裸 `x`（x ∈ test|scripts|lib|tsconfig.json）逐处加前缀
//   · **不复制** devDependencies（根不需要；使用者不装开发依赖）
//   · 原样透传：name / version / type / description / license / engines / keywords /
//     peerDependencies / peerDependenciesMeta / dsh.engines / dsh.client / repository
//
// ⚠ 已知边界（R2 的残余风险，如实登记）：`dsh.engines.dsh` 等**标量字段**若在包内改了值，
//   `--check` 能抓到；但若包内**新增**了本项目当前未收录的字段（例如新的顶层键），
//   本脚本不会自动搬运 —— 表现为「包内有、根没有」。新增字段时请同步扩本文件，
//   否则 `--check` 仍会绿而实际缺字段。这是派生式方案的固有代价。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const SRC = path.join(REPO_ROOT, 'packages', 'dsh-punky-swarm', 'package.json');
const DST = path.join(REPO_ROOT, 'package.json');
const PKG_DIR = 'packages/dsh-punky-swarm/';

/** 产出 `./packages/dsh-punky-swarm/...` 形态（用于 icon / main / exports / dsh.bundle.patch）。 */
function relPrefixed(p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  const bare = p.startsWith('./') ? p.slice(2) : p;
  return './' + PKG_DIR + bare;
}

/** 产出 `packages/dsh-punky-swarm/...` 裸形态（用于 files 白名单；`!` 取反项保留叹号）。 */
function barePrefixed(p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  if (p.startsWith('!')) return '!' + barePrefixed(p.slice(1));
  return PKG_DIR + p;
}

/** scripts 值里的路径逐处加前缀。 */
function prefixedScript(cmd) {
  if (typeof cmd !== 'string') return cmd;
  return cmd
    .replace(/(^|[\s=])(?:\.\/)?(test|scripts|lib)\//g, (_m, lead, dir) => lead + './' + PKG_DIR + dir + '/')
    .replace(/(^|[\s=])(?:\.\/)?(tsconfig\.json)/g, (_m, lead, file) => lead + './' + PKG_DIR + file);
}

function buildRootPkg(src) {
  const exportsOut = {};
  for (const [key, value] of Object.entries(src.exports ?? {})) {
    // `./package.json` 保持指向**根**：外部 `import 'dsh-punky-swarm/package.json'` 读到的
    //   应是安装包的元数据（根那份），而非内层副本。
    if (key === './package.json') { exportsOut[key] = './package.json'; continue; }
    exportsOut[key] = (typeof value === 'string')
      ? relPrefixed(value)
      : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, relPrefixed(v)]));
  }

  const scriptsOut = {};
  for (const [key, value] of Object.entries(src.scripts ?? {})) scriptsOut[key] = prefixedScript(value);

  // files 白名单：包内 files 逐项加前缀，并**强制补内层 package.json**。
  //   为什么必须补：`npm publish` 时 package.json 由 npm 自动包含，包内 files 不写也有；
  //   但 C 方案是「pnpm 按**根** package.json 的 files 从仓库树过滤后才装」⇒ 根 files 若不列
  //   内层 package.json，装出来就没有它。而 `lib/aip/tool-descriptor.js:22` 恰恰用
  //   `new URL('../../package.json', import.meta.url)` 读它取版本 ⇒ 缺了就抛 ENOENT。
  //   实测证据：漏补时装出内层 9 项、独缺 package.json；补回后 10 项齐。
  const filesOut = [...new Set([...(src.files ?? []).map((f) => barePrefixed(f)), PKG_DIR + 'package.json'])];

  return {
    name: src.name,
    version: src.version,
    type: src.type,
    description: src.description,
    license: src.license,
    icon: relPrefixed(src.icon),
    main: relPrefixed(src.main),
    exports: exportsOut,
    files: filesOut,
    engines: src.engines,
    scripts: scriptsOut,
    keywords: src.keywords,
    peerDependencies: src.peerDependencies,
    peerDependenciesMeta: src.peerDependenciesMeta,
    dsh: {
      ...src.dsh,
      bundle: { ...src.dsh?.bundle, patch: relPrefixed(src.dsh?.bundle?.patch) },
    },
    repository: src.repository,
  };
}

const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const expected = JSON.stringify(buildRootPkg(src), null, 2) + '\n';

const checkMode = process.argv.includes('--check');

if (checkMode) {
  const actual = fs.existsSync(DST) ? fs.readFileSync(DST, 'utf8') : '';
  if (actual === expected) {
    console.log('[gen-root-pkg] OK：根 package.json 与真源一致');
    process.exit(0);
  }
  const a = actual.split('\n');
  const e = expected.split('\n');
  const diffs = [];
  for (let i = 0; i < Math.max(a.length, e.length); i++) {
    if (a[i] !== e[i]) diffs.push('  L' + (i + 1) + '\n    - ' + (a[i] ?? '<缺行>') + '\n    + ' + (e[i] ?? '<缺行>'));
    if (diffs.length >= 20) { diffs.push('  …（差异超过 20 行已截断）'); break; }
  }
  console.error('[gen-root-pkg] FAIL：根 package.json 已与真源漂移。');
  console.error('  真源 = ' + path.relative(REPO_ROOT, SRC));
  console.error('  修法 = node scripts/gen-root-pkg.mjs   （重新生成后再提交）');
  console.error(diffs.join('\n'));
  process.exit(1);
}

fs.writeFileSync(DST, expected, 'utf8');
console.log('[gen-root-pkg] 已重写 ' + path.relative(REPO_ROOT, DST) + '（真源：' + path.relative(REPO_ROOT, SRC) + '）');
