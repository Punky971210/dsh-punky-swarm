// scripts/audit/gates.mjs —— 门禁台账：每个 GATE_* 码的生产抛出点 / 测试断言点
//   用法：cd packages/dsh-punky-swarm
//     node scripts/audit/gates.mjs            # 生成台账（scripts/audit/out/gate-ledger.json）
//     node scripts/audit/gates.mjs --check    # 与留档基线比对漂移（**默认不阻断**，退出码恒 0）
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';import { join, relative } from 'node:path';

const ROOT = process.cwd();
const OUT = join(ROOT, 'scripts', 'audit', 'out');
const SKIP = new Set(['node_modules', '.git', '.tsbuild', '.wip-backup', 'backups', 'baselines', 'out']);
const SELF_AUDIT = join(ROOT, 'scripts', 'audit');
const BASELINE = join(ROOT, 'docs', 'audit-2026-09-21-gate-ledger.json');
const CHECK = process.argv.includes('--check');

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

// ── 前缀伪影剔除（2026-09-21 勘误）──────────────────────────────────────────────
// 源码里存在 ① 模板拼接 `'GATE_EXIT_MISSING_' + layer.toUpperCase()`（真实码是 GATE_EXIT_MISSING_EXEC/AUDIT）
//   与 ② 注释里的 `GATE_TEAMS_ROOT_*`（真实码是 GATE_TEAMS_ROOT_INVALID / _ASSET_NOT_FOUND）。
// 正则 `\bGATE_[A-Z0-9_]+\b` 会把这两处**截成前缀**当独立码收录 ⇒ 台账虚增。
// 判据：凡**严格前缀**于同集合内另一码者，一律归伪影，不计入任何分类（真实性优先于覆盖率）。
function analyze(list) {
  const idSet = new Set(list.map((r) => r.id));
  for (const r of list) r.aliasOf = r.aliasOf ?? [...idSet].sort().find((o) => o !== r.id && o.startsWith(r.id)) ?? null;
  const real = list.filter((r) => !r.aliasOf);
  const ghosts = list.filter((r) => r.aliasOf);
  // 无断言门禁口径：真实码 + 有生产引用 + 测试零命中 + 非 `_RE` 正则常量
  const libOnly = real.filter((r) => r.prod.length > 0 && r.testHits === 0 && !/_RE$/.test(r.id));
  return { real, ghosts, libOnly };
}
const { real, ghosts, libOnly } = analyze(rows);

if (CHECK) {
  if (!existsSync(BASELINE)) {
    console.log('!! 无留档基线：' + rel(BASELINE) + '（跳过 --check）');
  } else {
    const base = analyze(JSON.parse(readFileSync(BASELINE, 'utf8')));
    const bIds = new Set(base.real.map((r) => r.id));
    const nIds = new Set(real.map((r) => r.id));
    const added = [...nIds].filter((x) => !bIds.has(x)).sort();
    const gone = [...bIds].filter((x) => !nIds.has(x)).sort();
    const bLib = new Set(base.libOnly.map((r) => r.id));
    const nLib = new Set(libOnly.map((r) => r.id));
    const newUntested = [...nLib].filter((x) => !bLib.has(x)).sort();
    const fixed = [...bLib].filter((x) => !nLib.has(x)).sort();
    console.log('=== 门禁台账漂移比对（基线：' + rel(BASELINE) + '）===');
    console.log('真实码：基线 ' + base.real.length + ' → 现 ' + real.length);
    console.log('新增门禁码 (' + added.length + ')：' + (added.join(' ') || '—'));
    console.log('消失门禁码 (' + gone.length + ')：' + (gone.join(' ') || '—'));
    console.log('新增「无断言」项 (' + newUntested.length + ')：' + (newUntested.join(' ') || '—'));
    console.log('已消除「无断言」项 (' + fixed.length + ')：' + (fixed.join(' ') || '—'));
    console.log('（提示：漂移≠错误；冻结项会随新引擎形态合法变更。本模式**不阻断**、退出码恒 0。）');
  }
}

console.log(`GATE_* 符号 ${rows.length} 个（真实码 ${real.length} + 前缀伪影 ${ghosts.length}；真实码内含 *_RE 正则常量 ${real.filter((r) => /_RE$/.test(r.id)).length} 个）`);
console.log(`\n### 前缀伪影（非门禁码，已剔除） (${ghosts.length})`);
ghosts.forEach((r) => console.log(`  ${r.id}  -> 实为 ${r.aliasOf} 的前缀`));
console.log(`\n### 孤儿：无生产引用且无测试断言 (${real.filter((r) => r.prod.length === 0 && r.testHits === 0 && !/_RE$/.test(r.id)).length})`);
real.filter((r) => r.prod.length === 0 && r.testHits === 0 && !/_RE$/.test(r.id)).forEach((r) => console.log(`  ${r.id}  (gates 内出现 ${r.selfDef})`));
console.log(`\n### 有生产引用但无测试断言 (${libOnly.length})`);
libOnly.forEach((r) => console.log(`  ${r.id}  prod=[${r.prod.join(' ')}]`));
console.log(`\n### 无生产引用但有测试断言 (${real.filter((r) => r.prod.length === 0 && r.testHits > 0 && !/_RE$/.test(r.id)).length})`);
real.filter((r) => r.prod.length === 0 && r.testHits > 0 && !/_RE$/.test(r.id)).forEach((r) => console.log(`  ${r.id}  testHits=${r.testHits}`));
console.log('\n### 全量台账（testHits=0 的标 ⚠；伪影标 ⊘）');
rows.sort((a, b) => a.testHits - b.testHits);
for (const r of rows) console.log(`  ${r.aliasOf ? '⊘' : r.testHits === 0 ? '⚠' : ' '} ${r.id.padEnd(38)} gates=${String(r.selfDef).padStart(3)}  prodFiles=${String(r.prod.length).padStart(2)}  testFiles=${String(r.testFiles).padStart(2)}  testHits=${String(r.testHits).padStart(4)}`);

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'gate-ledger.json'), JSON.stringify(rows, null, 2));
console.log('\n-> scripts/audit/out/gate-ledger.json');
