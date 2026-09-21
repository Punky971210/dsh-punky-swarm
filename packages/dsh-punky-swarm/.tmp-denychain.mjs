import fs from 'node:fs';
import path from 'node:path';
const lib = [];
(function walk(d, depth) {
  if (depth > 3) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (/node_modules|\.tsbuild/.test(e.name)) continue; walk(p, depth + 1); }
    else if (/\.(js|ts)$/.test(e.name)) lib.push(p.replace(/\\/g, '/'));
  }
})('lib', 0);

console.log('=== ① memberDeny 全消费点（lib，含定义文件）===');
for (const f of lib) {
  fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((l, i) => {
    if (l.includes('memberDeny')) console.log('  ' + f + ':' + (i + 1) + '| ' + l.trim().slice(0, 145));
  });
}
console.log('');
console.log('=== ② SUITE_DENY_TOOLS 全消费点（lib）===');
for (const f of lib) {
  fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((l, i) => {
    if (l.includes('SUITE_DENY_TOOLS')) console.log('  ' + f + ':' + (i + 1) + '| ' + l.trim().slice(0, 145));
  });
}
console.log('');
console.log('=== ③ toolFilter 在引擎内的装配与使用 ===');
for (const f of lib) {
  fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((l, i) => {
    if (l.includes('toolFilter') && /deny|filter/.test(l)) console.log('  ' + f + ':' + (i + 1) + '| ' + l.trim().slice(0, 145));
  });
}
