// 取证探针：`test/test-baseline.test.js` e2-1/e2-2 两条红的**根因归属**——
// 证明漂移**只**来自本 lane 新增的 `test/api-batch-keys.test.js`（排除该文件后基线自洽 ok:true / 零 filesChanged）。
// 只读：读基线 + 扫描测试树，零写盘。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASELINE_REL_PATH, compareBaseline, readBaseline, scanTree,
} from '../../scripts/baseline-snapshot-core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const NEW_FILE = 'test/api-batch-keys.test.js';

const base = readBaseline(ROOT);
const scan = scanTree(ROOT);
const cmp = compareBaseline(base, scan);
console.log('baseline path   :', BASELINE_REL_PATH);
console.log('base.totals     :', JSON.stringify(base.totals));
console.log('scan.totals     :', JSON.stringify(scan.totals));
console.log('filesChanged    :', JSON.stringify(cmp.filesChanged));
console.log('warnings        :', JSON.stringify(cmp.warnings));
console.log('new file entry  :', JSON.stringify(scan.files[NEW_FILE]));

const nf = scan.files[NEW_FILE];
if (nf) {
  const totalsWithoutNew = { ...scan.totals };
  for (const k of ['files', 'tests', 'todos', 'asserts', 'tautologies', 'lines', 'blankLines']) {
    if (typeof nf[k] === 'number' && typeof totalsWithoutNew[k] === 'number') totalsWithoutNew[k] -= nf[k];
  }
  const filesWithoutNew = { ...scan.files };
  delete filesWithoutNew[NEW_FILE];
  const cmpW = compareBaseline(base, { ...scan, totals: totalsWithoutNew, files: filesWithoutNew });
  console.log('--- 排除新文件后的对照 ---');
  console.log('ok              :', cmpW.ok);
  console.log('filesChanged    :', JSON.stringify(cmpW.filesChanged));
  console.log('warnings        :', JSON.stringify(cmpW.warnings));
  console.log('asserts.delta   :', cmpW.asserts?.delta);
  console.log('tests.delta     :', cmpW.tests?.delta);
}
