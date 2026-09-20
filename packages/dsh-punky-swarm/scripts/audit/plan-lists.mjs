// scripts/audit/plan-lists.mjs —— 把 out/unwired-summary.json 归一为「施工清单」
//   作用：.ts/.js 双产物同符号去重 → 逻辑项，并标注哪些是 .ts 源（改源后须 `npm run build` 回拷）。
//   用法：cd packages/dsh-punky-swarm && node scripts/audit/dead-code2.mjs && node scripts/audit/classify.mjs && node scripts/audit/plan-lists.mjs
import fs from 'node:fs';
import { join } from 'node:path';

const OUT = join(process.cwd(), 'scripts', 'audit', 'out');
const u = JSON.parse(fs.readFileSync(join(OUT, 'unwired-summary.json'), 'utf8'));
const norm = (s) => s.replace(/\\/g, '/');

// ts 源 → js 产物的映射（scripts/copy-ts-built.mjs 回拷白名单，共 15 个）
const TS_BACKED = new Set([
  'lib/schema', 'lib/state/schema-v3', 'lib/state/machine-rules', 'lib/state/gates',
  'lib/wave-plan', 'lib/types/contracts',
  'lib/governance/types', 'lib/governance/decisions', 'lib/governance/classify',
  'lib/governance/narrow', 'lib/governance/tool-ban', 'lib/governance/config',
  'lib/governance/kernel', 'lib/governance/preset-loader', 'lib/governance/index',
]);

const dedupe = (arr) => {
  const m = new Map();
  for (const r of arr) {
    const f = norm(r.file).replace(/\.(d\.ts|ts|js)$/, '');
    const key = f + '::' + r.name;
    if (!m.has(key)) m.set(key, { base: f, file: norm(r.file), name: r.name, ts: TS_BACKED.has(f) });
  }
  return [...m.values()];
};

const summarize = (title, arr) => {
  const d = dedupe(arr);
  console.log(`\n===== ${title} 去重后 ${d.length} 逻辑项 =====`);
  const g = {};
  for (const x of d) (g[x.base] = g[x.base] || []).push(x);
  Object.entries(g).sort((a, b) => b[1].length - a[1].length).forEach(([f, xs]) => {
    console.log(`${String(xs.length).padStart(3)}  ${f}.js${xs[0].ts ? '  [ts源]' : ''}  ::  ${xs.map((x) => x.name).join(', ')}`);
  });
  return d;
};

const b1 = summarize('B1 真死', u.B1);
const b2 = summarize('B2 多余 export', u.B2);
const c1 = summarize('C1 生产未接线（仅测试引用）', u.C1);

console.log('\n--- 计数 ---');
console.log('B1=' + b1.length + ' B2=' + b2.length + ' C1=' + c1.length);
console.log('B2 中 ts 源文件数=' + new Set(b2.filter((x) => x.ts).map((x) => x.base)).size + ' 纯 js 文件数=' + new Set(b2.filter((x) => !x.ts).map((x) => x.base)).size);

fs.writeFileSync(join(OUT, 'plan-lists.json'), JSON.stringify({ b1, b2, c1 }, null, 2));
console.log('-> scripts/audit/out/plan-lists.json');
