// S1/S3 通用：dry-emit 逐文件 diff —— 比对 `.tsbuild/`（tsc 产物）与 `lib/`（在役回拷产物），
// **只读比对、零回拷**（两阶段落地制的第一阶段自检）。
// 输出：逐组 PASS/DIFF（含字节数与首个差异偏移）+ 汇总 `DIFF=n / IDENTICAL=m / MISSING=k`。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..', '..');
const text = fs.readFileSync(path.join(pkgRoot, 'scripts', 'copy-ts-built.mjs'), 'utf8');
const names = [...text.matchAll(/'([^']+\.(?:js|d\.ts))'/g)].map((m) => m[1]);

const label = process.argv[2] ?? 'diff';
let same = 0, diff = 0, missing = 0;
const diffs = [];
for (const f of names) {
  const built = path.join(pkgRoot, '.tsbuild', f);
  const live = path.join(pkgRoot, 'lib', f);
  if (!fs.existsSync(built)) { console.log('MISSING built -> lib/' + f); missing += 1; continue; }
  const a = fs.readFileSync(built);
  const b = fs.readFileSync(live);
  if (a.equals(b)) { same += 1; console.log('PASS  lib/' + f + ' (' + a.length + ' B)'); continue; }
  diff += 1;
  let off = 0;
  while (off < Math.min(a.length, b.length) && a[off] === b[off]) off += 1;
  const rows = { built: a, live: b };
  console.log('DIFF  lib/' + f + ' (built ' + rows.built.length + ' B / live ' + rows.live.length + ' B, first-diff@' + off + ')');
  diffs.push(f);
}
console.log('[' + label + '] DIFF=' + diff + ' / IDENTICAL=' + same + ' / MISSING=' + missing + ' / TOTAL=' + names.length);
if (diffs.length) console.log('[' + label + '] diff files: ' + diffs.join(', '));
