// W2 施工批 · 审计留痕：重建 test/chain-v2-declaration.test.js 的**改前**内容并出哈希
// （Leader 裁决 A′ 授权改 :63/:64 两处；本脚本只做「改前态重建 + 哈希」，不改任何源文件）
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const p = 'test/chain-v2-declaration.test.js';
const s = readFileSync(p, 'utf8');
const NEW1 = [
  "test('V2-2 版本白名单：1|2|3 合法，其余拒（BAD_TYPE，零新造码）', () => {",
  "  assert.deepEqual([...CHAIN_VERSIONS], [1, 2, 3], '版本白名单 = [1,2,3]（W2 规格 §5 修订①：v3 装配图入册）');",
  "  for (const bad of [4, '2', null, undefined]) {",
].join('\n');
const OLD1 = [
  "test('V2-2 版本白名单：1|2 合法，其余拒（BAD_TYPE，零新造码）', () => {",
  "  assert.deepEqual([...CHAIN_VERSIONS], [1, 2], '版本白名单 = [1,2]');",
  "  for (const bad of [3, '2', null, undefined]) {",
].join('\n');
if (!s.includes(NEW1)) { console.log('RECONSTRUCT-FAIL'); process.exit(1); }
const pre = s.replace(NEW1, OLD1);
const h = (t) => createHash('sha256').update(Buffer.from(t, 'utf8')).digest('hex').toUpperCase().slice(0, 16);
writeFileSync('.wip-backup/w2v3/test__chain-v2-declaration.test.js.pre', pre);
console.log('pre  sha256(16)=' + h(pre) + ' lines=' + pre.split('\n').length);
console.log('post sha256(16)=' + h(s) + ' lines=' + s.split('\n').length);
