// 临时：删 longrun-exempt.test.js 里 5 个撤销用例 + 修 EX-A6 的常量引用
import fs from 'node:fs';

const p = 'test/longrun-exempt.test.js';
let lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);

// ① 改 :189（0-based 188）：用字面量替代已删常量
lines[188] = "  assert.equal(eventsOf(store, 'b-a6', 'lane.exempt.revoked').length, 0);  // 撤销面已删（用字面量，不再引常量）";

// ② 从后往前删
// C14: 405..413 → 0-based 404..412（9 行）
lines.splice(404, 9);
// C12/C12b/C13/C15: 281..329 → 0-based 280..328（49 行）
lines.splice(280, 49);

fs.writeFileSync(p, lines.join('\n'), 'utf8');
console.log('剩余行数:', lines.length);
