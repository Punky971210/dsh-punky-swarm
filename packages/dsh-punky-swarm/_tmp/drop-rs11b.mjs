// 临时：删 watch-state-surface-red.test.js 的 RS-11b (b) 段（显式撤销入口）
import fs from 'node:fs';

const p = 'test/watch-state-surface-red.test.js';
const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
console.log('510:', JSON.stringify(lines[509] || '').slice(0, 50));
console.log('511:', JSON.stringify(lines[510] || '').slice(0, 50));
console.log('517:', JSON.stringify(lines[516] || '').slice(0, 60));
console.log('518:', JSON.stringify(lines[517] || '').slice(0, 50));
// 删 511..517（0-based 510..516）共 7 行
lines.splice(510, 7, '  // 【P1 · 2026-11-05】**原 (b) 显式撤销入口子段已删** —— `store.revokeLaneExempt` 随撤销面整体移除',
  '  //   （用户裁决「删掉 revokeExempt」）。(a) 的「结算终态仍清退」是独立语义（design §6.2），保留。');
fs.writeFileSync(p, lines.join('\n'), 'utf8');
console.log('完成，行数:', lines.length);
