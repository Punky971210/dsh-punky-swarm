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

// 源件扫描面单点（`lib/**` 的「哪些文件算源」）。
//
// 存在理由（批 `punky-adapter-split-20261031` · lane `w4-ts-gate`；判据来源 `plan/ts-gate-spec.md`）：
//   词表校验与 `accept-pack2` 各自就地写扫描面，两份面各自漂移 —— 加宽前两边都只认 `lib/**/*.ts`，
//   而 `lib/engine/dispatch.js`、`lib/tools/assign-tools.js`、`lib/state/store/*.js` 等**手写 `.js`**
//   的 `GATE_*` 发射点恒在面外 ⇒ 「发射码 ⊆ 词表」那一族**恒真**（假绿，实测 12 个真发射码未登记）。
//   本模块把「面」变成单点，面变更只需改一处；两处消费方（`scripts/check-vocab-counts.mjs`、
//   `test/accept-pack2-vocabulary.test.js#emittedCodes`）由此同源。
//
// 「面」的三条判定（每条都有实测理由，见 `exec/ts-gate.md`）：
//   ① **收** `{.ts, .js, .mjs}`：手写 `.js`（147 件）是源不是产物 —— 实测 `tsc -p tsconfig.build.json`
//      重建后与之逐字节**全部不同**；`.mjs`（`lib/bus/selftest.mjs`）同样手写。
//   ② **排** `*.d.ts`：它的 `code:` 命中是**类型位**不是发射位（实测样本 `lib/wave-plan.d.ts:43` 的
//      `code: 'GATE_ROLE_ASSEMBLY_MISSING';` 是函数返回类型字面量）⇒ 纳入即**假发射**。且实测纳入增量 **0**。
//   ③ **排**「有同名 `.ts` 孪生」的 `.js`：那 31 件是 `tsc` 逐字节可重建的镜像（实测 `same=62`：
//      31 `.js` + 31 `.d.ts`），同 stem 再计入 `.js` 会把同一码数两次。
//
// 刻意**不设**豁免面：宿主服务名的豁免只属于**泄漏门**（H4 / L1 / L2 / R5，`lib/provider-dsh/**` 允许
//   出现宿主名），不属于本门 —— 本门判的是「这个码有没有登记进词表」，provider 包内的码同样必须登记。
//   实测 `lib/provider-dsh/**` 当前 **0** 个发射位 ⇒ 不设豁免不改变任何现存读数，但未来 provider 内新增
//   拒码不会静默落在面外。
import fs from 'node:fs';
import path from 'node:path';

/** 面的扩展名白名单（顺序即报告里的列序）。 */
export const SOURCE_EXTS = Object.freeze(['.ts', '.js', '.mjs']);

/** 一律不进面的目录（产物 / 依赖 / VCS）。 */
export const PRUNE_DIRS = Object.freeze(['node_modules', '.git', '.tsbuild', 'out']);

/** 声明文件后缀：类型位不是发射位 ⇒ 恒定排除（不可被 opts 覆盖）。 */
const DECL_SUFFIX = '.d.ts';

/** POSIX 化（跨平台读数一致，报告与断言都用同一形态）。 */
export function posixRel(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

/** 是否声明文件（`.d.ts`）。 */
export function isDeclarationFile(nameOrRel) {
  return String(nameOrRel).endsWith(DECL_SUFFIX);
}

/** 是否 `.js`（含 `.d.ts` 之外的普通 `.js`）。 */
function isPlainJs(nameOrRel) {
  return String(nameOrRel).endsWith('.js') && !isDeclarationFile(nameOrRel);
}

/**
 * **纯函数**：把一批仓根相对路径过滤成「源件面」。
 *
 * 抽成纯函数是为了让判据有**可达构造**：测试可以喂一份合成路径表，证明
 *   · 扩展名白名单退回 `['.js']` ⇒ `.ts` 件全部缺席（回退式变异必被检出）；
 *   · `.d.ts` / 镜像 `.js` / 非法扩展名一律不入面。
 * 不依赖真实磁盘，故这些构造不需要改生产实现。
 *
 * @param {string[]} relPaths 仓根相对 POSIX 路径（已走过目录剪枝）
 * @param {{exts?: readonly string[], hasTsTwin?: (rel: string) => boolean}} [opts]
 * @returns {{kept: string[], dropped: {declaration: string[], mirrorJs: string[], foreignExt: string[]}}}
 */
export function filterSourceFace(relPaths, opts = {}) {
  const exts = opts.exts ?? SOURCE_EXTS;
  const hasTsTwin = opts.hasTsTwin ?? (() => false);
  const kept = [];
  const dropped = { declaration: [], mirrorJs: [], foreignExt: [] };
  for (const rel of relPaths) {
    if (isDeclarationFile(rel)) { dropped.declaration.push(rel); continue; }
    if (!exts.some((e) => rel.endsWith(e))) { dropped.foreignExt.push(rel); continue; }
    if (isPlainJs(rel) && hasTsTwin(rel)) { dropped.mirrorJs.push(rel); continue; }
    kept.push(rel);
  }
  return { kept, dropped };
}

/** 递归枚举 `lib/**` 下全部文件（仓根相对 POSIX 路径，已剪枝，按字典序）。 */
export function listLibFiles(root) {
  const base = path.join(root, 'lib');
  const out = [];
  const walk = (abs) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (PRUNE_DIRS.includes(e.name)) continue;
      const child = path.join(abs, e.name);
      if (e.isDirectory()) walk(child);
      else out.push(posixRel(root, child));
    }
  };
  walk(base);
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * 源件面（绝对路径，按字典序）。面定义 = `filterSourceFace` + 真磁盘孪生判定。
 * @param {string} root 包根
 * @param {{exts?: readonly string[]}} [opts] 仅供变异测试收窄白名单用
 * @returns {string[]}
 */
export function collectSourceFiles(root, opts = {}) {
  const rels = listLibFiles(root);
  const relSet = new Set(rels);
  const { kept } = filterSourceFace(rels, {
    exts: opts.exts,
    // 孪生判定走**同一份**枚举结果，不额外 stat：面内一致性优先于绝对精确。
    hasTsTwin: (rel) => relSet.has(rel.replace(/\.js$/, '.ts')),
  });
  return kept.map((rel) => path.join(root, ...rel.split('/')));
}

/**
 * 面读数（供脚本输出「分开计」，不参与任何 assert 期望值）。
 * @param {string} root 包根
 * @returns {{total:number, ts:number, handJs:number, mjs:number, mirrorJs:number, declaration:number, foreignExt:number}}
 */
export function sourceFaceReport(root) {
  const rels = listLibFiles(root);
  const relSet = new Set(rels);
  const { kept, dropped } = filterSourceFace(rels, {
    hasTsTwin: (rel) => relSet.has(rel.replace(/\.js$/, '.ts')),
  });
  const count = (pred) => kept.filter(pred).length;
  return {
    total: kept.length,
    ts: count((r) => r.endsWith('.ts')),
    handJs: count((r) => isPlainJs(r)),
    mjs: count((r) => r.endsWith('.mjs')),
    mirrorJs: dropped.mirrorJs.length,
    declaration: dropped.declaration.length,
    foreignExt: dropped.foreignExt.length,
  };
}
