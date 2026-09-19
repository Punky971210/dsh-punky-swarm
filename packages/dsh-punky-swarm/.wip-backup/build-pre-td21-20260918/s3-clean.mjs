// S3 前置：清空 `.tsbuild/`（免陈旧产物混入 re-emit diff），随后由调用方跑 `npx tsc -p tsconfig.build.json`。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..', '..');
const built = path.join(pkgRoot, '.tsbuild');
fs.rmSync(built, { recursive: true, force: true });
console.log('S3 cleaned: .tsbuild removed (exists=' + fs.existsSync(built) + ')');
