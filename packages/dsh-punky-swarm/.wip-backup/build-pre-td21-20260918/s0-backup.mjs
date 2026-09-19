// S0：改前备份——把 live 回拷清单（scripts/copy-ts-built.mjs 的 files[]）里的 30 个产物
// 备份到本目录（保持 lib/ 下的相对结构）。清单**运行期从 live 脚本提取**（禁手抄，防清单漂移）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..', '..');
const copyScript = path.join(pkgRoot, 'scripts', 'copy-ts-built.mjs');
const text = fs.readFileSync(copyScript, 'utf8');
const names = [...text.matchAll(/'([^']+\.(?:js|d\.ts))'/g)].map((m) => m[1]);
if (names.length !== 30) {
  console.error('FAIL 回拷清单读数异常：期望 30，实测 ' + names.length);
  process.exit(1);
}
let n = 0;
for (const f of names) {
  const src = path.join(pkgRoot, 'lib', f);
  const dest = path.join(here, f);
  if (!fs.existsSync(src)) { console.error('FAIL 源缺失: lib/' + f); process.exit(1); }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  n += 1;
}
console.log('S0 backed up ' + n + ' files -> ' + path.relative(pkgRoot, here));
