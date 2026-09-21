// 批 3 · 测试剥离器（一次性工具）：删除引用已删符号的整 test 块 + 清 import 残留
import { readFileSync, writeFileSync } from 'node:fs';

const SYMBOLS = [
  'parseLabel', 'sweepExpiredHandles', 'clearSessionState', 'DEFAULT_ESCALATION_WINDOW_MS',
  'auditlogStats', 'sinkFilePath', 'decryptEabCredential', 'API_BASE_PATH', 'ATR_BASE_PATH',
  'flattenAgentSkills', 'ACS_REQUIRED_FIELDS', 'ACS_SKILL_REQUIRED_FIELDS', 'isEntityAic',
  'BLIND_REVIEW_ORDER', 'DEFAULT_THRESHOLD_MULTIPLIER', 'RATCHET_RULES', 'MANAGER_PLANS',
  'artifactTypeOf', 'typesOfLayer',
];
const HAS = (s) => SYMBOLS.some((y) => s.includes(y));

// 找到 `test(` 起点，返回匹配的右括号 index（含字符串字面量感知：跳过 ' " ` 内容）
function findBlockEnd(src, start) {
  let depth = 0, i = start, inStr = null, esc = false;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

const file = process.argv[2];
let src = readFileSync(file, 'utf8');

// ① 删除引用符号的 test 块（自底向上）
let removed = 0;
for (let pass = 0; pass < 3; pass++) {
  let i = 0; let any = false;
  while (i < src.length) {
    const at = src.indexOf('test(', i);
    if (at < 0) break;
    // 确认是语句首（前一字符非标识符）
    const prev = src[at - 1] || '\n';
    if (!/[^\w$]/.test(prev)) { i = at + 5; continue; }
    const end = findBlockEnd(src, at + 4);
    if (end < 0) break;
    const block = src.slice(at, end + 1);
    if (HAS(block)) {
      // 吞掉块后紧随的换行
      let e = end + 1;
      while (src[e] === '\n' || src[e] === ' ') e++;
      src = src.slice(0, at) + src.slice(e);
      removed++; any = true;
      i = at;
    } else {
      i = end;
    }
  }
  if (!any) break;
}

// ② 清 import：从 import {...} from '...schema.js' 等具名导入中移除符号（含多行）
const importRe = /import\s*\{([^}]*)\}\s*from\s*(['"][^'"]+['"]);?/g;
src = src.replace(importRe, (full, names, from) => {
  const parts = names.split(',').map((x) => x.trim()).filter(Boolean);
  const kept = parts.filter((x) => !SYMBOLS.some((y) => x === y || x.startsWith(y + ' as ')));
  if (kept.length === parts.length) return full;
  if (kept.length === 0) return '';
  return full.replace(names, ' ' + kept.join(', ') + ' ');
});

writeFileSync(file, src, 'utf8');
console.log(file + ' :: 删除 test 块 ' + removed + ' 个');
