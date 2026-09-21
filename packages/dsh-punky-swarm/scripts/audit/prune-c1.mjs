// 批 3 · 未接线导出删除器（一次性工具，N2/C1 激进档）
// 用法：node .tmp-run/prune.mjs —— 逐文件删除 PRUNE 清单中的导出块（注释头一并删），
//   边界 = 从块注释/`export` 行起，至括号深度归零且语句结束（`;` 或独立 `}`）。
import { readFileSync, writeFileSync } from 'node:fs';

const PRUNE = [
  ['lib/engine/dispatch.js', 'parseLabel'],
  ['lib/bridge/lane-handle.js', 'sweepExpiredHandles'],
  ['lib/governance/state-store.js', 'clearSessionState'],
  ['lib/governance/escalation.js', 'DEFAULT_ESCALATION_WINDOW_MS'],
  ['lib/auditlog/sink.js', 'auditlogStats'],
  ['lib/auditlog/sink.js', 'sinkFilePath'],
  ['lib/acps/registry-client.js', 'decryptEabCredential'],
  ['lib/acps/registry-client.js', 'API_BASE_PATH'],
  ['lib/acps/registry-client.js', 'ATR_BASE_PATH'],
  ['lib/acps/discovery-client.js', 'flattenAgentSkills'],
  ['lib/aip/agent-descriptor.js', 'ACS_REQUIRED_FIELDS'],
  ['lib/aip/agent-descriptor.js', 'ACS_SKILL_REQUIRED_FIELDS'],
  ['lib/aip/identity.js', 'isEntityAic'],
  ['lib/assembly/audit-blind-review.js', 'BLIND_REVIEW_ORDER'],
  ['lib/state/lane-exempt.js', 'DEFAULT_THRESHOLD_MULTIPLIER'],
  ['lib/state/machine.js', 'RATCHET_RULES'],
  ['lib/wave-plan.ts', 'MANAGER_PLANS'],
  ['lib/schema.ts', 'assertMemberTransition'],
  ['lib/schema.ts', 'assertBatchTransition'],
  ['lib/artifact-types.js', 'artifactTypeOf'],
  ['lib/artifact-types.js', 'typesOfLayer'],
];

const byFile = new Map();
for (const [f, s] of PRUNE) {
  if (!byFile.has(f)) byFile.set(f, []);
  byFile.get(f).push(s);
}

function blockEnd(lines, start) {
  let depth = 0, seen = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{' || ch === '(' || ch === '[') { depth++; seen = true; }
      else if (ch === '}' || ch === ')' || ch === ']') { depth--; }
    }
    const trimmed = lines[i].trimEnd();
    const statementEnd = trimmed.endsWith(';') || trimmed.endsWith('}') || trimmed.endsWith('])');
    if (seen && depth <= 0 && (statementEnd || trimmed === '}')) return i;
    if (!seen && (statementEnd || trimmed === '')) return i; // 单行常量/空行
  }
  return lines.length - 1;
}

for (const [file, symbols] of byFile) {
  let lines = readFileSync(file, 'utf8').split('\n');
  for (const sym of symbols) {
    let idx = lines.findIndex((l) => new RegExp('export (async )?(function|const) ' + sym + '\\b').test(l));
    if (idx < 0) { console.log('SKIP(未找到 export) ' + file + ' :: ' + sym); continue; }
    // 向上吞并紧邻的块注释（/** ... */）与同段单行注释
    let start = idx;
    while (start > 0 && /^\s*(\/\/|\*|\/\*\*|\*\/)/.test(lines[start - 1])) start--;
    const end = blockEnd(lines, idx);
    const removed = end - start + 1;
    lines.splice(start, removed);
    // 清理因删除产生的连续空行（>2 压到 1）
    for (let i = start; i < lines.length - 1; i++) {
      if (lines[i].trim() === '' && lines[i + 1].trim() === '') { lines.splice(i + 1, 1); i--; } else break;
    }
    console.log('DEL ' + file + ' :: ' + sym + '（' + removed + ' 行，起 ' + (start + 1) + '）');
  }
  writeFileSync(file, lines.join('\n'), 'utf8');
}
console.log('done');
