// 临时：提取 member-tools.js 里所有工具的参数/输出 schema 与 required 分布（出 U-3 建议表用）
import { readFileSync } from 'node:fs';

const lines = readFileSync('lib/tools/member-tools.js', 'utf8').split('\n');
const META = new Set(['type', 'properties', 'required', 'additionalProperties', 'description', 'enum', 'items']);

function toolNameAtOrBefore(idx) {
  for (let i = idx; i >= 0; i--) {
    const m = lines[i].match(/name:\s*["']([a-z_]+)["']/);
    if (m) return m[1];
  }
  return '(未知)';
}

function parseShape(seg) {
  // 只取 properties 里的直接字段：形如 "x":{"type":...
  const props = [];
  const req = [];
  const re = /"([A-Za-z][A-Za-z0-9]*)":\{(?:"type":"[^"]*")?([^{}]*)\}/g;
  let m;
  while ((m = re.exec(seg))) {
    const key = m[1];
    if (META.has(key)) continue;
    const rest = m[2] || '';
    if (!props.includes(key)) props.push(key);
    if (/"required":true/.test(rest) && !req.includes(key)) req.push(key);
  }
  return { props, req };
}

const rows = [];
lines.forEach((raw, i) => {
  const pAt = raw.indexOf('parameters:');
  const sAt = raw.indexOf('schema:');
  if (pAt >= 0) {
    const { props, req } = parseShape(raw.slice(pAt));
    rows.push({ line: i + 1, name: toolNameAtOrBefore(i), kind: 'parameters', props, req });
  }
  if (sAt >= 0) {
    const { props, req } = parseShape(raw.slice(sAt));
    rows.push({ line: i + 1, name: toolNameAtOrBefore(i), kind: 'output', props, req });
  }
});

console.log('schema 总数: ' + rows.length + ' | 字段内 required:true 总处数: ' + rows.reduce((a, r) => a + r.req.length, 0));
console.log('');
for (const r of rows) {
  const optional = r.props.filter((p) => !r.req.includes(p));
  console.log('--- ' + r.name + ' [' + r.kind + '] 行 ' + r.line + ' ---');
  console.log('  字段(' + r.props.length + '): ' + (r.props.length ? r.props.join(', ') : '(无)'));
  console.log('  字段内 required:true(' + r.req.length + '): ' + (r.req.length ? r.req.join(', ') : '(无)'));
  console.log('  非 required: ' + (optional.length ? optional.join(', ') : '(无)'));
  console.log('');
}
