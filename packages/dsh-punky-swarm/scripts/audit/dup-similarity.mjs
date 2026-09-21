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

// 夹具审计 · ③ 重复的**强度证据**（F3/F4 的排序线索）。
//
// 口径：同一函数名在 `test/**` 的**顶层 `function` 定义**，两两比较**函数体**的
//   「行集合 Jaccard」（去空行 / 去 `//` `*` `/*` 注释行）。
//   ⚠ **只作排序线索**（短函数易虚高、长函数易虚低）⇒ 合并前必须人眼 diff。
//   ⚠ 同名**不同物**的情形真实存在（`makeHarness` 26 处仅 2 对相似）⇒ **禁按名批量合并**。
//
// 用法：
//   node scripts/audit/dup-similarity.mjs              # 表（默认 top 25）
//   node scripts/audit/dup-similarity.mjs --min 3 --top 40
//   node scripts/audit/dup-similarity.mjs --fn writeRuntime   # 单函数全定义对照（含文件与行号）
//   node scripts/audit/dup-similarity.mjs --group assemblyCtx # 单函数按**归一化函数体**分组（= 实际有几个形状）
//   node scripts/audit/dup-similarity.mjs --group freshRoot --body   # 附带各形状的函数体（人眼 diff）
//   node scripts/audit/dup-similarity.mjs --group freshRoot --struct # 抹平字面量后分组（暴露「仅常量不同」的族）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TEST_DIR = path.join(ROOT, 'test');

function argOf(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
}

function listTestFiles(dir = TEST_DIR, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) listTestFiles(abs, out);
    else if (/\.js$/.test(e.name)) out.push(path.relative(ROOT, abs).split(path.sep).join('/'));
  }
  return out.sort();
}

/** 提取某函数名的全部顶层定义（含起始行号与函数体）。
 *  ⚠ 函数体起点**不能**用 `indexOf('{')`：形参默认值里的 `{}`（如 `config = {}`）会被误判为函数体，
 *    导致 `function f(a, b = {}) { … }` 被截成「1 行」。正解 = 先配平**圆括号**找到形参表结束，
 *    其后的第一个 `{` 才是函数体起点。 */
function extractBodies(src, name) {
  const out = [];
  const re = new RegExp('^(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'gm');
  let m;
  while ((m = re.exec(src)) !== null) {
    // ① 从第一个 `(` 起配平圆括号（跳过字符串/模板串里的括号：本仓测试夹具无此类极端形态）
    const parenAt = src.indexOf('(', m.index);
    if (parenAt < 0) continue;
    let pd = 0;
    let parenEnd = -1;
    for (let j = parenAt; j < src.length; j += 1) {
      const c = src[j];
      if (c === '(') pd += 1;
      else if (c === ')') {
        pd -= 1;
        if (pd === 0) { parenEnd = j; break; }
      }
    }
    if (parenEnd < 0) continue;
    // ② 其后的第一个 `{` = 函数体起点
    const braceAt = src.indexOf('{', parenEnd);
    if (braceAt < 0) continue;
    let depth = 0;
    let end = -1;
    for (let j = braceAt; j < src.length; j += 1) {
      const c = src[j];
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) { end = j + 1; break; }
      }
    }
    if (end < 0) continue;
    const line = src.slice(0, m.index).split('\n').length;
    out.push({ line, body: src.slice(m.index, end) });
  }
  return out;
}

const strip = (s) => s.split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'))
  .join('\n');

/** 结构归一：把字符串/模板串字面量与数字抹平 ⇒ 暴露「同一结构、仅常量不同」的族。
 *  ⚠ 用途：判定能否**参数化后合并**（如 `freshRoot` 各文件只差硬编码的 tmp 前缀）。 */
const structOf = (s) => s
  .replace(/'(?:[^'\\]|\\.)*'/g, "'·'")
  .replace(/"(?:[^"\\]|\\.)*"/g, '"·"')
  .replace(/`(?:[^`\\]|\\.)*`/g, '`·`')
  .replace(/\b\d+(?:\.\d+)?\b/g, '0');

/** 行集合 Jaccard（去空行/注释）。 */
function jaccard(a, b) {
  const A = new Set(strip(a).split('\n'));
  const B = new Set(strip(b).split('\n'));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

const files = listTestFiles();
const defs = new Map();
for (const rel of files) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
    const name = m[1];
    if (!defs.has(name)) defs.set(name, []);
    defs.get(name).push(rel);
  }
}

// ── 单函数模式：列出全部定义（文件:行 + 行数），便于人眼 diff ──
const only = argOf('--fn', null);
if (only) {
  const hits = [];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const b of extractBodies(src, only)) hits.push({ rel, ...b });
  }
  if (hits.length === 0) {
    console.log('(无定义) ' + only);
    process.exit(0);
  }
  console.log('## ' + only + '（' + hits.length + ' 处定义）\n');
  for (const h of hits) {
    console.log('- ' + h.rel + ':' + h.line + '  (' + h.body.split('\n').length + ' 行)');
  }
  console.log('\n### 两两相似度');
  for (let i = 0; i < hits.length; i += 1) {
    for (let k = i + 1; k < hits.length; k += 1) {
      const s = jaccard(hits[i].body, hits[k].body);
      if (s >= 0.7) console.log('  ' + Math.round(s * 100) + '%  ' + hits[i].rel + ':' + hits[i].line + ' ⇄ ' + hits[k].rel + ':' + hits[k].line);
    }
  }
  process.exit(0);
}

// ── 分组模式：把单函数的全部定义按「归一化函数体」聚类 ⇒ 直接看出**实际有几个形状** ──
//   用途：判定「能不能合」。形状数 = 1 ⇒ 纯复制可直接抽单点；形状数 > 1 ⇒ 先看差异轴是**加性**还是**多维**
//   （加性 ⇒ 拆名/工厂；多维 ⇒ 按变体拆名，见台账 §3.3 纪律）。
const groupOf = argOf('--group', null);
if (groupOf) {
  const showBody = process.argv.includes('--body');
  const structMode = process.argv.includes('--struct');
  const hits = [];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const b of extractBodies(src, groupOf)) hits.push({ rel, ...b });
  }
  if (hits.length === 0) {
    console.log('(无定义) ' + groupOf);
    process.exit(0);
  }
  const groups = new Map();
  for (const h of hits) {
    const key = structMode ? structOf(strip(h.body)) : strip(h.body);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(h);
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  console.log('## ' + groupOf + '：' + hits.length + ' 处定义 → **' + sorted.length + ' 个形状**\n');
  sorted.forEach(([key, list], i) => {
    console.log('### [' + i + '] ×' + list.length + '（归一化 ' + key.split('\n').length + ' 行）');
    console.log('  ' + list.map((h) => h.rel + ':' + h.line).join('\n  '));
    if (showBody) {
      console.log('  ```js');
      console.log(key.split('\n').slice(0, 60).map((l) => '  ' + l).join('\n'));
      console.log('  ```');
    }
    console.log('');
  });
  process.exit(0);
}

// ── 表模式 ──
const minDefs = Number(argOf('--min', '3'));
const top = Number(argOf('--top', '25'));
const rows = [];
for (const [name, fsList] of defs) {
  if (fsList.length < minDefs) continue;
  const bodies = [];
  for (const rel of fsList) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const b of extractBodies(src, name)) bodies.push({ rel, ...b });
  }
  let maxSim = 0;
  let hi = 0;
  let tot = 0;
  for (let i = 0; i < bodies.length; i += 1) {
    for (let k = i + 1; k < bodies.length; k += 1) {
      const s = jaccard(bodies[i].body, bodies[k].body);
      tot += 1;
      if (s >= 0.7) hi += 1;
      if (s > maxSim) maxSim = s;
    }
  }
  rows.push({ name, n: fsList.length, maxSim: Math.round(maxSim * 100), hi, tot, maxLines: Math.max(...bodies.map((b) => b.body.split('\n').length)) });
}
rows.sort((a, b) => (b.hi - a.hi) || (b.maxSim - a.maxSim) || (b.n - a.n));

const pad = (s, w) => String(s).padStart(w);
console.log('## ③ 重复候选（≥' + minDefs + ' 处定义；行集合 Jaccard，≥70% 记为「高相似对」）\n');
console.log('| 函数 | 定义数 | 最高相似 | 高相似对/总对 | 最长行数 | 档 |');
console.log('|---|---|---|---|---|---|');
for (const r of rows.slice(0, top)) {
  const tier = r.hi === 0 ? '禁按名合（同名不同物）'
    : r.hi / Math.max(1, r.tot) >= 0.5 ? '**必合**' : '选合';
  console.log('| `' + r.name + '` | ' + r.n + ' | ' + r.maxSim + '% | ' + r.hi + '/' + r.tot + ' | ' + r.maxLines + ' | ' + tier + ' |');
}
const withHi = rows.filter((r) => r.hi > 0);
console.log('\n· 候选 ' + rows.length + ' 个函数；含高相似对 ' + withHi.length + ' 个；高相似对合计 ' + withHi.reduce((a, b) => a + b.hi, 0));
console.log('· 单函数下钻：`node scripts/audit/dup-similarity.mjs --fn <name>`');
console.log('· ⚠ 提示：相似度只是**排序线索**；合并前必须人眼 diff（同名不同物真实存在）');
