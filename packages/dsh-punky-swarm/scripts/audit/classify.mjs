// scripts/audit/classify.mjs —— 对 out/dead-code-classified.json 细分 C 类，产出「生产未接线」四档清单
//   C1 = 仅 test 引用 且 本文件内也无使用 ⇒ 真·未接线（死符号，声明面先行、运行面欠账）
//   C2 = 仅 test 引用 但 本文件内被使用 ⇒ 内部已消费，仅 export 多余（去 export 会断测试，勿动）
//   B1 = 内外皆零引用 ⇒ 真死（可删）
//   B2 = 内部消费但外零引用 ⇒ 多余 export（可去 export 关键字）
//   用法：cd packages/dsh-punky-swarm && node scripts/audit/dead-code2.mjs && node scripts/audit/classify.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(process.cwd(), 'scripts', 'audit', 'out');
const data = JSON.parse(readFileSync(join(OUT, 'dead-code-classified.json'), 'utf8'));
const rows = data.rows;

const C1 = [], C2 = [], B1 = [], B2 = [];
for (const r of rows) {
  const ext = r.prod + r.testUse + r.other;
  if (ext === 0) {
    if (r.selfUse > 0) B2.push(r);
    else B1.push(r);
  } else if (r.prod === 0 && r.other === 0 && r.testUse > 0) {
    if (r.selfUse > 0) C2.push(r);
    else C1.push(r);
  }
}

const grp = (arr) => {
  const m = {};
  for (const x of arr) (m[x.file] = m[x.file] || []).push(x.name);
  return Object.entries(m).sort((a, b) => b[1].length - a[1].length);
};
const dump = (title, arr) => {
  console.log(`\n### ${title}  (${arr.length})`);
  for (const [f, ns] of grp(arr)) console.log(`${String(ns.length).padStart(3)}  ${f}\n       ${ns.join(', ')}`);
};

dump('C1 真·生产未接线（本文件亦不用、仅 test 引用）', C1);
dump('C2 仅 test 引用但内部已消费（export 多余）', C2);
dump('B1 真死（内外皆零引用）', B1);
dump('B2 内部消费但外零引用（export 多余）', B2);

// 汇总文件级：每个 lib 文件的「未接线密度」
const dens = {};
for (const r of rows) {
  dens[r.file] = dens[r.file] || { total: 0, unwired: 0, selfOnly: 0 };
  dens[r.file].total++;
  if (r.prod === 0 && r.other === 0) {
    dens[r.file].unwired++;
    if (r.selfUse > 0) dens[r.file].selfOnly++;
  }
}
console.log('\n### 文件级未接线密度（export 中生产零引用占比 ≥50% 且 export≥5）');
const list = Object.entries(dens)
  .filter(([, v]) => v.total >= 5 && v.unwired / v.total >= 0.5)
  .map(([f, v]) => ({ f, ...v, pct: Math.round((v.unwired / v.total) * 100) }))
  .sort((a, b) => b.pct - a.pct || b.unwired - a.unwired);
for (const x of list) console.log(`  ${String(x.pct).padStart(3)}%  ${x.unwired}/${x.total}  ${x.f}`);

mkdirSync(OUT, { recursive: true });
writeFileSync(
  join(OUT, 'unwired-summary.json'),
  JSON.stringify({ counts: { C1: C1.length, C2: C2.length, B1: B1.length, B2: B2.length }, C1, C2, B1, B2, dens }, null, 2),
);
console.log('\n-> scripts/audit/out/unwired-summary.json');
