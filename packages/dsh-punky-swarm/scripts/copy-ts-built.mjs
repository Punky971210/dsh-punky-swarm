// copy-ts-built.mjs —— 编译产物回拷（设计 §5.2 双配置方案）
// tsc -p tsconfig.build.json 把 lib 下 6 个 .ts（5 模块 + types/contracts）emit 到 .tsbuild/lib/；
// 本脚本把其中 5 个转换模块 + contracts 的 .js/.d.ts 回拷到 lib/ 原位（main/exports/相对 import 路径契约零变化），
// 随后删除 .tsbuild（未转 .js 的复制被丢弃——lib 下唯一覆盖/新增就是 6 组产物）。
import { cpSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const built = join(root, '.tsbuild'); // rootDir:lib → 产物相对 lib 的结构直接落在 .tsbuild 根（lib/schema.ts → .tsbuild/schema.js）

// 回拷清单：5 个转换模块 + contracts（.js + .d.ts）；未转 .js 原样保留在 lib，不回拷
const files = [
  'schema.js', 'schema.d.ts',
  'state/schema-v3.js', 'state/schema-v3.d.ts',
  'state/machine-rules.js', 'state/machine-rules.d.ts',
  'state/gates.js', 'state/gates.d.ts',
  'wave-plan.js', 'wave-plan.d.ts',
  'types/contracts.js', 'types/contracts.d.ts',
];

for (const f of files) {
  const src = join(built, f);
  const dest = join(root, 'lib', f);
  if (!existsSync(src)) throw new Error('missing built artifact: ' + src);
  cpSync(src, dest);
  console.log('copy -> lib/' + f);
}

rmSync(join(root, '.tsbuild'), { recursive: true, force: true });
console.log('removed .tsbuild');
