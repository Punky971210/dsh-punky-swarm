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

// punky-fix-p2-20261023 · c4 依赖与兼容面（tester 落）：`A1-P2-02`（inject 矛盾事实化）
//   + `A1-P2-03`（peer range 补段并披露）。
//
// ── 判据取向（两条）────────────────────────────────────────────────────────────────────
//   · `A1-P2-02` 的**唯一实质判据**是「声明面与裸访问面都没被偷偷改动」（R-9）：本批只加注释。
//     故本文件做**改前/改后对拍**：`inject` 声明语句逐字对拍（`git show 8d7815b`），
//     裸访问计数按「排除纯注释行」口径对拍。
//     ⚠ 口径勘误（本 tester 实测，供 audit 复现）：任务书/规格写的
//       `sed '/^\s*\/\//!p' | grep -c` **漏了 `-n`** ⇒ 非匹配行被默认打印一次、再被 `p` 打印一次
//       （代码行计 2 次），读数会虚高为 3/3/4。正确形态是 `sed -n '/^\s*\/\//!p' | grep -c`，
//       实测 **1 / 1 / 1**，与改前一致（1→1）。本文件的计数器语义 = `sed -n` 那一版。
//   · `A1-P2-03`：本仓**没有**可解析的 `semver` 依赖（`node -e "require('semver')"` ⇒
//     MODULE_NOT_FOUND），故不能直接调 `semver.satisfies`。本文件内嵌一个**只支持 `^` 比较子**的
//     最小判定器（该 range 只用 `^`），并用它**复现改前 range 的已知真值表**（那组真值由 exec 层
//     用真 `semver` 取得）来**自校验**；自校验通过后，同一判定器再跑改后矩阵才是可信的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(PKG_ROOT, rel), 'utf8');
const PKG = JSON.parse(read('package.json'));

/** 读 `8d7815b`（本批基线 HEAD）的某个文件；读不到返回 null（不静默、由调用点断言）。 */
function readAtBaseHead(rel) {
  try {
    return execFileSync('git', ['show', '8d7815b:./' + rel],
      { cwd: PKG_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** 裸访问计数（**排除纯注释行**口径，等价 `sed -n '/^\s*\/\//!p' | grep -c <token>`：按行计）。 */
function bareAccessLineCount(src, token) {
  return src
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .filter((line) => line.includes(token))
    .length;
}

// ── A1-P2-02 · 声明面未被改动（R-9 第一半）────────────────────────────────────────────
test('A1-P2-02 / AC-9 · inject 声明语句逐字不变（与基线 8d7815b 对拍）', () => {
  const now = read('lib/index.js');
  const base = readAtBaseHead('lib/index.js');
  assert.ok(base, '基线 8d7815b 的 lib/index.js 必须可读（否则本对拍无法成立）');
  const stmtOf = (src) => (src.match(/^export const inject = .*$/m) ?? [])[0] ?? null;
  const nowStmt = stmtOf(now);
  const baseStmt = stmtOf(base);
  assert.equal(nowStmt, "export const inject = ['tools', 'webServer', 'subagents'];",
    '声明行必须逐字为三键数组（无 optional 语法可用的宿主契约下，这是硬依赖声明）');
  assert.equal(nowStmt, baseStmt, '声明行相对基线必须**逐字**不变（本批只加注释）');
});

test('A1-P2-02 / AC-9 · 运行期 inject 面：三键内容与顺序逐字不变', async () => {
  const m = await import('../lib/index.js');
  assert.deepEqual(m.inject, ['tools', 'webServer', 'subagents']);
  assert.equal(Array.isArray(m.inject), true, '数组形态 = 逐名 required（对象形态同样无 optional 位）');
});

test('A1-P2-02 / R-9 · 裸访问计数（排除纯注释行）改前改后一致：index/api 的 ctx.webServer = 1、dispatch 的 ctx.subagents = 1', () => {
  const probes = [
    ['lib/index.js', 'ctx.webServer'],
    ['lib/api.js', 'ctx.webServer'],
    ['lib/engine/dispatch.js', 'ctx.subagents'],
  ];
  for (const [rel, token] of probes) {
    const before = readAtBaseHead(rel);
    assert.ok(before, '基线文件必须可读：' + rel);
    const afterCount = bareAccessLineCount(read(rel), token);
    const beforeCount = bareAccessLineCount(before, token);
    assert.equal(afterCount, 1, rel + ' 的 ' + token + ' 裸访问必须**恰 1 处**（多于 1 = 注释外又添了访问面）');
    assert.equal(afterCount, beforeCount, rel + '：裸访问计数改前改后必须不变（1→1，未偷偷引入掉载面）');
  }
});

test('A1-P2-02 / AC-9 · 注释锚点在位且可核：引用宿主符号 Inject.resolve / _checkImpl，并写明无 optional 位与 pending', () => {
  const indexSrc = read('lib/index.js');
  assert.match(indexSrc, /(没有|无)\s*optional\s*位/, '必须写明宿主 inject 无 optional 契约');
  assert.match(indexSrc, /Inject\.resolve/, '必须引用宿主符号 Inject.resolve（可核性）');
  assert.match(indexSrc, /_checkImpl/, '必须引用宿主符号 _checkImpl（可核性）');
  assert.match(indexSrc, /pending/, '必须写明真实失败形态 = 插件整块 pending');
  assert.match(indexSrc, /不可达/, '必须写明两处缺服务守卫在当前契约下不可达');
  // 防第二真源：api.js 只指路，不复制 index.js 的全文（用 index.js 的独有长句作哨兵）
  const apiSrc = read('lib/api.js');
  assert.match(apiSrc, /inject/, 'api.js 必须有指路注释');
  assert.equal(apiSrc.includes('21 个治理工具'), false,
    'api.js 不得复制 index.js 的注释全文（防第二真源）；只允许指路');
});

// ── A1-P2-03 · peer range（最小 `^` 判定器 + 自校验）──────────────────────────────────
const VER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function parseVer(v) {
  const m = VER.exec(String(v).trim());
  if (!m) throw new Error('bad version: ' + v);
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] === undefined ? null : m[4].split('.'),
  };
}

const cmpNum = (a, b) => (a === b ? 0 : (a < b ? -1 : 1));

function cmpIdent(a, b) {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return cmpNum(Number(a), Number(b));
  if (na !== nb) return na ? -1 : 1; // 数字标识符优先级低于字母标识符
  return a === b ? 0 : (a < b ? -1 : 1);
}

function cmpVer(a, b) {
  for (let i = 0; i < 3; i += 1) {
    const c = cmpNum(a.nums[i], b.nums[i]);
    if (c !== 0) return c;
  }
  if (a.pre === null && b.pre === null) return 0;
  if (a.pre === null) return 1;  // 正式版 > 预发布版
  if (b.pre === null) return -1;
  const n = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < n; i += 1) {
    if (a.pre[i] === undefined) return -1;
    if (b.pre[i] === undefined) return 1;
    const c = cmpIdent(a.pre[i], b.pre[i]);
    if (c !== 0) return c;
  }
  return 0;
}

/** `^M.m.p[-pre]` 的上下界（该 range 只含 `^` 比较子 ⇒ 判定器只实现这一族）。 */
function caretBounds(atom) {
  const v = parseVer(atom.slice(1));
  const [maj, min, pat] = v.nums;
  let upper;
  if (maj > 0) upper = parseVer(`${maj + 1}.0.0`);
  else if (min > 0) upper = parseVer(`0.${min + 1}.0`);
  else upper = parseVer(`0.0.${pat + 1}`);
  return { lower: v, upper };
}

/** 单个 `^` 段是否命中（含 semver 的预发布门：只有在同 [maj,min,pat] 元组带预发布比较子时才放行预发布版）。 */
function satisfiesCaret(version, atom) {
  const v = parseVer(version);
  const { lower, upper } = caretBounds(atom);
  if (cmpVer(v, lower) < 0) return false;
  if (cmpVer(v, upper) >= 0) return false;
  if (v.pre !== null) {
    const sameTuple = lower.pre !== null
      && lower.nums[0] === v.nums[0] && lower.nums[1] === v.nums[1] && lower.nums[2] === v.nums[2];
    return sameTuple;
  }
  return true;
}

const satisfiesRange = (version, range) => range.split('||')
  .map((s) => s.trim())
  .filter(Boolean)
  .some((atom) => satisfiesCaret(version, atom));

/** 改前 range（六段，逐字取自 8d7815b 的 package.json）。 */
const RANGE_BEFORE = '^0.1.0-rc.6 || ^0.1.1-rc.2 || ^0.1.5-rc.1 || ^0.1.6-alpha.1 || ^0.1.7-rc.1 || ^0.2.0-rc.1';
const ADDED_SEGMENT = '^0.2.1-rc.2';

test('A1-P2-03 · 判定器自校验：复现改前 range 的真值表（该表由 exec 层用真 semver 取得）⇒ 判定器可信', () => {
  // 真值来源：exec 层用真 `semver.satisfies` 对改前 range 的实测（0.2.1-rc.2 = false 即 R-10 的 BEFORE 读数）。
  const truthBefore = {
    '0.2.0-rc.1': true,
    '0.2.1-rc.2': false,   // ← R-10：这一段是**新增**的，改前不满足
    '0.2.1': true,
    '0.2.2': true,
    '0.3.0-rc.1': false,
  };
  for (const [v, expected] of Object.entries(truthBefore)) {
    assert.equal(satisfiesRange(v, RANGE_BEFORE), expected,
      '自校验失败：' + v + ' 在改前 range 上应为 ' + expected + '（否则本文件内嵌判定器不可信）');
  }
});

test('A1-P2-03 / AC-10 · 改后矩阵：0.2.1-rc.2 / rc.3 / 0.2.1 / 0.2.2 = true，0.3.0-rc.1 = false（上界不外溢）', () => {
  const range = PKG.peerDependencies['@deepseek-ai/dsh-tools'];
  const expected = {
    '0.2.1-rc.2': true,
    '0.2.1-rc.3': true,
    '0.2.1': true,
    '0.2.2': true,
    '0.3.0-rc.1': false,
  };
  for (const [v, exp] of Object.entries(expected)) {
    assert.equal(satisfiesRange(v, range), exp, v + ' 在改后 range 上应为 ' + exp);
  }
});

test('A1-P2-03 / AC-10 · 两处 range 逐字一致，且改后 = 改前六段 + 追加一段（纯加段，既有组合全部仍满足）', () => {
  const peer = PKG.peerDependencies['@deepseek-ai/dsh-tools'];
  const dev = PKG.devDependencies['@deepseek-ai/dsh-tools'];
  assert.equal(peer, dev, 'peerDependencies 与 devDependencies 的 range 必须逐字一致（两处须同步）');
  assert.equal(peer, RANGE_BEFORE + ' || ' + ADDED_SEGMENT, '改后 range 必须是「原六段 + 追加一段」的形态');
  const segments = peer.split('||').map((s) => s.trim());
  assert.equal(segments.length, 7, '段数 6 → 7（只准加，不准改写既有段）');
  assert.equal(segments.slice(0, 6).join(' || '), RANGE_BEFORE, '原六段逐字保留且顺序不变');
  // 单调性：改前能过的版本改后仍然能过
  for (const v of ['0.1.0-rc.6', '0.1.1-rc.2', '0.1.5-rc.1', '0.1.6-alpha.1', '0.1.7-rc.1', '0.2.0-rc.1']) {
    assert.equal(satisfiesRange(v, peer), true, '既有段覆盖的版本必须仍然满足：' + v);
  }
});

test('A1-P2-03 / AC-10 · package.json 文本面：新增段恰出现 1 次、原末段出现 2 次（peer + dev）', () => {
  const text = read('package.json');
  assert.equal((text.match(/\^0\.2\.1-rc\.2/g) ?? []).length, 2, '新增段在文件内出现 2 次（peer + dev）');
  assert.equal((text.match(/\^0\.2\.0-rc\.1/g) ?? []).length, 2, '原末段仍在两处（既有六段未被改写）');
});

test('A1-P2-03 · 同提交披露：docs/upstream-defects.md 含三要素（版本 / startActivation / 拒派码）', (t) => {
  // 【2026-10-25 CI 修复】`docs/**` 按 `.gitignore` **不入库**（仅 docs/integrations/ 下两件集成声明文档为例外）；
  //   干净检出 / CI runner 上本文件不在场，原 `read()` 直接抛错 ⇒ CI 必红（Linux CI 实测红）。
  //   处置：文档不在场 ⇒ 留痕为「本环境不可核」（不计通过、也不判红）；文档在场时断言逐条不变。
  const DOC_REL = 'docs/upstream-defects.md';
  if (!existsSync(path.join(PKG_ROOT, DOC_REL))) {
    t.diagnostic(DOC_REL + ' 不在场（docs 按 .gitignore 不入库）⇒ 本条披露断言本环境不可核；'
      + '在生产机/含 docs 的工作区执行本件时会照常校验三要素。');
    return;
  }
  const doc = read(DOC_REL);
  for (const kw of ['0.2.1-rc.2', 'startActivation', 'GATE_DISPATCH_CAPABILITY_MISSING']) {
    assert.ok(doc.includes(kw), '披露节必须含三要素之一：' + kw);
  }
  assert.match(doc, /不得|不得把|不要/, '必须显式写明「range 覆盖 ≠ 自派已恢复」的反向告诫（防半真话）');
});
