// scripts/audit/dead-code2.mjs —— 导出面甄别（第二版，替代已删除的 audit-dead-code.mjs 第一版）
//   A/B 类（同一次扫描的两个视角，见下方声明）：
//     A 类 = 有 export 但全仓（含本文件）零使用 ⇒ 真死代码
//     B 类 = 仅本文件内使用 ⇒ 多余 export（可去 export 关键字，符号仍活）
//     C 类 = 仅被 test 引用 ⇒ 测试专用面（生产未接线）
//   扫描域：lib（源）+ test + scripts + presets。scripts/audit 自身**排除**（含符号名字面量，会污染计数）。
//   用法：cd packages/dsh-punky-swarm && node scripts/audit/dead-code2.mjs
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const OUT = join(ROOT, 'scripts', 'audit', 'out');
const SKIP = new Set(['node_modules', '.git', '.tsbuild', '.wip-backup', 'backups', 'baselines', 'out']);
const SELF_AUDIT = join(ROOT, 'scripts', 'audit');

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const f = join(dir, e.name);
    if (f === SELF_AUDIT) continue;
    if (e.isDirectory()) walk(f, out);
    else out.push(f);
  }
  return out;
}

const isSrc = (f) => /\.(ts|js|mjs)$/.test(f) && !/\.d\.ts$/.test(f);
const lib = walk(join(ROOT, 'lib')).filter(isSrc);
const test = walk(join(ROOT, 'test')).filter((f) => /\.(ts|js|mjs)$/.test(f));
const scripts = walk(join(ROOT, 'scripts')).filter(isSrc);
const presets = walk(join(ROOT, 'presets'));

const logicalName = (f) => f.replace(/\.(ts|js|mjs)$/, '').replace(/\\/g, '/');
const corpus = [...lib, ...test, ...scripts, ...presets].map((f) => ({
  f,
  key: logicalName(f),
  isLib: lib.includes(f),
  isTest: test.includes(f),
  t: readFileSync(f, 'utf8'),
}));

const declRe = /^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;

const A = []; // 真死
const B = []; // 仅本文件用（多余 export）
const C = []; // 仅 test 用
const rows = [];
let total = 0;

for (const c of corpus.filter((x) => x.isLib)) {
  const names = [];
  let m;
  const r = new RegExp(declRe.source, 'gm');
  while ((m = r.exec(c.t))) names.push(m[1]);
  for (const n of [...new Set(names)]) {
    total++;
    const re = new RegExp(`\\b${n.replace(/\$/g, '\\$')}\\b`, 'g');
    // 本文件内（同名 ts/js 兄弟文件算同一逻辑文件；排除 export 声明行本身）
    let selfUse = 0;
    for (const o of corpus) {
      if (o.key !== c.key) continue;
      const lines = o.t.split('\n').filter((l) => !new RegExp(`^\\s*export\\s+.*\\b${n}\\b`).test(l));
      selfUse += (lines.join('\n').match(re) || []).length;
    }
    let prod = 0;
    let testUse = 0;
    let other = 0;
    for (const o of corpus) {
      if (o.key === c.key) continue;
      const hits = (o.t.match(re) || []).length;
      if (!hits) continue;
      if (o.isLib) prod += hits;
      else if (o.isTest) testUse += hits;
      else other += hits;
    }
    const rel = relative(ROOT, c.f);
    rows.push({ file: rel, name: n, selfUse, prod, testUse, other });
    if (prod + testUse + other === 0) {
      if (selfUse > 0) B.push({ file: rel, name: n });
      else A.push({ file: rel, name: n });
    } else if (prod === 0 && other === 0 && testUse > 0) {
      C.push({ file: rel, name: n, testUse });
    }
  }
}

const group = (arr, keyFn) => {
  const m = {};
  for (const x of arr) (m[keyFn(x)] = m[keyFn(x)] || []).push(x.name || x);
  return Object.entries(m).sort((a, b) => b[1].length - a[1].length);
};

console.log(`导出符号总数=${total}`);
console.log(`A 类 真死代码 = ${A.length}`);
for (const [f, ns] of group(A, (x) => x.file)) console.log(`   ${String(ns.length).padStart(3)}  ${f}  ::  ${ns.join(', ')}`);
console.log(`\nB 类 多余 export（仅本文件用） = ${B.length}`);
for (const [f, ns] of group(B, (x) => x.file)) console.log(`   ${String(ns.length).padStart(3)}  ${f}  ::  ${ns.join(', ')}`);
console.log(`\nC 类 仅 test 引用（生产未接线） = ${C.length}`);
for (const [f, ns] of group(C, (x) => x.file)) console.log(`   ${String(ns.length).padStart(3)}  ${f}  ::  ${ns.join(', ')}`);

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'dead-code-classified.json'), JSON.stringify({ A, B, C, rows }, null, 2));
console.log('\n-> scripts/audit/out/dead-code-classified.json');
