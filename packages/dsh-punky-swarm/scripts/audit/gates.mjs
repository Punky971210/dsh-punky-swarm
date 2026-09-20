// scripts/audit/gates.mjs —— 门禁台账：每个 GATE_* 码的生产抛出点 / 测试断言点
//   用法：cd packages/dsh-punky-swarm && node scripts/audit/gates.mjs
//   注意：`state/gates.{ts,js}` 内出现次数记为 selfDef（定义面），其余 lib 文件记为 prod（抛出/承接点）。
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
const rel = (f) => relative(ROOT, f);

const libFiles = walk(join(ROOT, 'lib')).filter((f) => /\.(ts|js)$/.test(f) && !/\.d\.ts$/.test(f));
const testFiles = walk(join(ROOT, 'test'));

const gateRe = /\bGATE_[A-Z0-9_]+\b/g;
const ids = new Set();
for (const f of libFiles) for (const m of readFileSync(f, 'utf8').match(gateRe) || []) ids.add(m);

const rows = [];
for (const id of [...ids].sort()) {
  const re = new RegExp(`\\b${id}\\b`, 'g');
  const prod = [];
  const tst = [];
  let selfDef = 0;
  for (const f of libFiles) {
    const t = readFileSync(f, 'utf8');
    const n = (t.match(re) || []).length;
    if (!n) continue;
    if (rel(f).endsWith('state/gates.ts') || rel(f).endsWith('state/gates.js')) selfDef += n;
    else prod.push(`${rel(f)}×${n}`);
  }
  for (const f of testFiles) {
    const t = readFileSync(f, 'utf8');
    const n = (t.match(re) || []).length;
    if (n) tst.push(`${rel(f)}×${n}`);
  }
  rows.push({ id, selfDef, prod, testFiles: tst.length, testHits: tst.reduce((a, s) => a + Number(s.split('×')[1]), 0) });
}

const orphans = rows.filter((r) => r.prod.length === 0 && r.testHits === 0 && !/_RE$/.test(r.id));
const libOnly = rows.filter((r) => r.prod.length > 0 && r.testHits === 0);
const testOnly = rows.filter((r) => r.prod.length === 0 && r.testHits > 0 && !/_RE$/.test(r.id));

console.log(`GATE_* 符号 ${rows.length} 个（含 *_RE 正则常量 ${rows.filter((r) => /_RE$/.test(r.id)).length} 个）`);
console.log(`\n### 孤儿：无生产引用且无测试断言 (${orphans.length})`);
orphans.forEach((r) => console.log(`  ${r.id}  (gates 内出现 ${r.selfDef})`));
console.log(`\n### 有生产引用但无测试断言 (${libOnly.length})`);
libOnly.forEach((r) => console.log(`  ${r.id}  prod=[${r.prod.join(' ')}]`));
console.log(`\n### 无生产引用但有测试断言 (${testOnly.length})`);
testOnly.forEach((r) => console.log(`  ${r.id}  testHits=${r.testHits}`));
console.log('\n### 全量台账（testHits=0 的标 ⚠）');
rows.sort((a, b) => a.testHits - b.testHits);
for (const r of rows) console.log(`  ${r.testHits === 0 ? '⚠' : ' '} ${r.id.padEnd(34)} gates=${String(r.selfDef).padStart(3)}  prodFiles=${String(r.prod.length).padStart(2)}  testFiles=${String(r.testFiles).padStart(2)}  testHits=${String(r.testHits).padStart(4)}`);

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'gate-ledger.json'), JSON.stringify(rows, null, 2));
console.log('\n-> scripts/audit/out/gate-ledger.json');
