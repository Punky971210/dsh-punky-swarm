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

// test/ts-gate-face.test.js —— **AC-T4 落地件**（批 `punky-adapter-split-20261031` · lane `w4-ts-gate`）
// ─────────────────────────────────────────────────────────────────────────────
// 判据来源：`plan/ts-gate-spec.md`（批 `punky-adapter-p0-20261031` · lane `p0-7-ts-gate`）的
//   `## AC-T4 定义` —— **面集合相等，不是计数**。
//
// 为什么是「集合相等」而不是「文件数 = N」：
//   · 写死件数时，任何**合法**新增源件都会误红（把合法动作判成缺陷）；
//   · 反过来，按扩展名排除的实现只要件数凑巧对上就会误绿 —— 而当前缺陷正是「按扩展名排除」。
//   故判据 = `set(面) === set(应读面)`，两个方向分列：`missing`（应读没读）与 `extra`（读了不该读）。
//
// 两条实现纪律（缺一则判据恒真）：
//   ① **E（应读面）与 A（实际面）由两条独立路径得到**：E 在本件内自建遍历 + 自建扩展名白名单；
//      A 取生产单点 `scripts/lib/source-face.mjs#collectSourceFiles`。若两侧共用同一函数 ⇒ 恒真。
//   ② 本件**不写任何期望件数**（不写 `expect 179` 之类）：件数只打印，不进断言。
//
// 可达构造（判据有鉴别力的证明，全部零磁盘合成）：
//   `filterSourceFace` 是纯函数 ⇒ 可以喂合成路径表，证明
//     · 扩展名白名单退回 `['.js']` ⇒ `.ts` 件全部缺席（**回退式变异**必被点名）；
//     · `*.d.ts` 即使被写进白名单也仍被排除（类型位不是发射位，恒定排除）；
//     · 豁免不靠扩展名，靠「`*.ts` 孪生」：镜像 `.js` 落 `dropped.mirrorJs`，其 `.ts` 侧仍在面内。
//   这三条不需要改生产实现就能跑 —— 是「可达构造」而不是「事后声称」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SOURCE_EXTS,
  collectSourceFiles,
  filterSourceFace,
  isDeclarationFile,
  listLibFiles,
  posixRel,
  sourceFaceReport,
} from '../scripts/lib/source-face.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 面内扩展名白名单（本件自建，**不** import 生产的 SOURCE_EXTS —— 独立路径得到 E 的第一要件）。 */
const EXPECTED_EXTS = ['.js', '.mjs', '.ts'];
/** 一律不进的目录（本件自建，同源要求见上）。 */
const EXPECTED_PRUNE = new Set(['node_modules', '.git', '.tsbuild', 'out']);

/**
 * **E（应读面）的独立实现**：自建遍历 + 自建扩展名白名单 + 自建孪生判定。
 * 刻意不复用 `lib/source-face.mjs` 的任何遍历函数。
 * @returns {{kept: string[], mirrorJs: string[], declaration: string[]}}
 */
function expectedFace() {
  const rels = [];
  const walk = (absDir) => {
    for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (EXPECTED_PRUNE.has(ent.name)) continue;
      const abs = path.join(absDir, ent.name);
      if (ent.isDirectory()) { walk(abs); continue; }
      rels.push(posixRel(PKG_ROOT, abs));
    }
  };
  walk(path.join(PKG_ROOT, 'lib'));
  const relSet = new Set(rels);
  const kept = [];
  const mirrorJs = [];
  const declaration = [];
  for (const rel of rels) {
    if (isDeclarationFile(rel)) { declaration.push(rel); continue; }
    if (!EXPECTED_EXTS.some((e) => rel.endsWith(e))) continue;
    const isPlainJs = rel.endsWith('.js') && !isDeclarationFile(rel);
    if (isPlainJs && relSet.has(rel.replace(/\.js$/, '.ts'))) { mirrorJs.push(rel); continue; }
    kept.push(rel);
  }
  return { kept: kept.sort(), mirrorJs: mirrorJs.sort(), declaration: declaration.sort() };
}

const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ── AC-T4-a 面集合相等（双向，非计数）────────────────────────────────────────────
test('AC-T4-a 面集合相等：生产面 ≡ 独立枚举的应读面（missing/extra 双向均空）', () => {
  // 失败条件：生产面按扩展名漏件（missing 非空）或把声明文件/镜像/面外件纳入（extra 非空）。
  const e = expectedFace();
  const a = collectSourceFiles(PKG_ROOT).map((abs) => posixRel(PKG_ROOT, abs)).sort();
  const missing = e.kept.filter((r) => !a.includes(r));
  const extra = a.filter((r) => !e.kept.includes(r));
  assert.deepEqual(missing, [], '应读面缺件（禁按扩展名排除源件）：' + JSON.stringify(missing.slice(0, 20)));
  assert.deepEqual(extra, [], '面内含了不该读的件：' + JSON.stringify(extra.slice(0, 20)));
  assert.ok(a.length > 0, '面为空 ⇒ 遍历写错会静默通过（假绿）');
  process.stdout.write(`[AC-T4-a] 面=${a.length} 件｜镜像 .js 排除=${e.mirrorJs.length}｜.d.ts 排除=${e.declaration.length}\n`);
});

// ── AC-T4-b 面的三条排除各自成立（对真实仓的真值断言）─────────────────────────────
test('AC-T4-d `*.d.ts` 恒定排除：即使白名单显式含 `.d.ts` 也不入面（类型位不是发射位）', () => {
  // 失败条件：有人靠「往白名单里加 .d.ts」把声明文件拉进面 ⇒ 假发射（样本 lib/wave-plan.d.ts 的类型字面量）。
  const e = expectedFace();
  const withDts = filterSourceFace(e.declaration, { exts: ['.ts', '.js', '.mjs', '.d.ts'], hasTsTwin: () => false });
  assert.deepEqual(withDts.kept, [], '声明文件不得因白名单而进面');
  assert.deepEqual(withDts.dropped.declaration, e.declaration, '它们应逐件落在 dropped.declaration');
});

// ── AC-T4-e 豁免按「孪生」不按扩展名（正例不误杀）──────────────────────────────────
test('AC-T4-e 镜像豁免按孪生判定：有 `.ts` 孪生的 `.js` 落 mirrorJs，无孪生的 `.js` 留在面内', () => {
  // 失败条件：把「排 .js」当成排镜像（那会把 147 件手写 .js 一起排掉 ⇒ 回到加宽前的假绿）。
  const sample = ['lib/a.ts', 'lib/a.js', 'lib/b.js', 'lib/c.mjs'];
  const out = filterSourceFace(sample, { exts: SOURCE_EXTS, hasTsTwin: (rel) => rel === 'lib/a.js' });
  assert.deepEqual(out.kept, ['lib/a.ts', 'lib/b.js', 'lib/c.mjs'], '无孪生的手写 .js 必须在面内');
  assert.deepEqual(out.dropped.mirrorJs, ['lib/a.js'], '有孪生的镜像 .js 只该落 mirrorJs');
});

// ── AC-T4-f 三处消费同源（面单点）────────────────────────────────────────────────
test('AC-T4-f 面单点：两个消费方（生产脚本 / 验收用例）都从 `scripts/lib/source-face.mjs` 取面', () => {
  // 失败条件：某一处又就地写扩展名过滤 ⇒ 两份面各自漂移（本次漏检的根因形态）。
  const scriptSrc = fs.readFileSync(path.join(PKG_ROOT, 'scripts/check-vocab-counts.mjs'), 'utf8');
  const acceptSrc = fs.readFileSync(path.join(PKG_ROOT, 'test/accept-pack2-vocabulary.test.js'), 'utf8');
  assert.match(scriptSrc, /from '\.\/lib\/source-face\.mjs'/, '生产脚本须 import 面单点');
  assert.match(acceptSrc, /from '\.\.\/scripts\/lib\/source-face\.mjs'/, '验收用例须 import 面单点');
  assert.match(scriptSrc, /collectSourceFiles\(ROOT\)/, '生产脚本须以单点取面（不得自带 walk）');
  assert.match(acceptSrc, /collectSourceFiles\(PKG_ROOT\)/, '验收用例须以单点取面（不得自带 walk）');
});

// ── AC-T4-g 面读数自洽（分开计，不写死）──────────────────────────────────────────