import fs from 'node:fs';
const NL = '\n';
let bad = 0;

/** 括号平衡提取整块：返回 [startIdx, endIdx]（含）；校验首行含 headSub、块内含 tailSub。 */
function findBalanced(L, headSub, tailSub) {
  const a = L.findIndex((l) => l.includes(headSub));
  if (a < 0) return null;
  let bal = 0, seen = false, hasTail = false;
  for (let i = a; i < L.length; i++) {
    if (L[i].includes(tailSub)) hasTail = true;
    for (const ch of L[i]) { if (ch === '{') { bal++; seen = true; } else if (ch === '}') bal--; }
    if (seen && bal <= 0) {
      if (!hasTail) { console.log('  块内未含尾标: ' + JSON.stringify(L[i].slice(0, 60))); return null; }
      return [a, i];
    }
  }
  return null;
}
function edit(p, fn) {
  const L = fs.readFileSync(p, 'utf8').split(NL);
  const r = fn(L);
  if (r === false) { console.log('FAIL ' + p); bad++; return; }
  fs.writeFileSync(p, L.join(NL), 'utf8');
  console.log('ok ' + p);
}

// ① dispatch-failure-rollback
edit('test/dispatch-failure-rollback.test.js', (L) => {
  const blk = findBalanced(L, 'async function harness(start)', 'return { by, exec, store };');
  if (!blk) return false;
  L.splice(blk[0], blk[1] - blk[0] + 1);
  // 吸收紧随的空行
  while (L[blk[0]] === '' && L[blk[0] + 1] === '') L.splice(blk[0], 1);
  const a = L.findIndex((l) => l.includes("from './helpers/host-skills.mjs'"));
  if (a < 0) return false;
  L.splice(a + 1, 0, '',
    '// G7 下沉（2026-09-22）：harness 体迁入 helpers/dispatch-fixture.mjs；本文件一行适配（id 沿用原值）。',
    "import { makeDispatchHarness } from './helpers/dispatch-fixture.mjs';",
    'const harness = (start) => makeDispatchHarness({ SID: \'sess-dr\', batchId: \'b-dr\', start });');
  return 1;
});

// ② dispatch-prompt-compose
edit('test/dispatch-prompt-compose.test.js', (L) => {
  const blk = findBalanced(L, 'async function harness()', 'return { by, exec, captured };');
  if (!blk) return false;
  L.splice(blk[0], blk[1] - blk[0] + 1);
  while (L[blk[0]] === '' && L[blk[0] + 1] === '') L.splice(blk[0], 1);
  const a = L.findIndex((l) => l.includes("from './helpers/host-skills.mjs'"));
  if (a < 0) return false;
  L.splice(a + 1, 0, '',
    '// G7 下沉（2026-09-22）：harness 体迁入 helpers/dispatch-fixture.mjs；本文件一行适配（markCmd 断言标记）。',
    "import { makeDispatchHarness } from './helpers/dispatch-fixture.mjs';",
    'const harness = () => makeDispatchHarness({ SID: \'sess-dp\', batchId: \'b-dp\', markCmd: true });');
  return 1;
});

// ③ governance-escalate
edit('test/governance-escalate.test.js', (L) => {
  const blk = findBalanced(L, 'function seedBatch(root, sessionId, batchId) {', 'return aux;');
  if (!blk) return false;
  L.splice(blk[0], blk[1] - blk[0] + 1);
  while (L[blk[0]] === '' && L[blk[0] + 1] === '') L.splice(blk[0], 1);
  const a = L.findIndex((l) => /^import /.test(l));
  const last = L.map((l, i) => [/^import /.test(l), i]).filter(([x]) => x).pop()[1];
  if (a < 0 || last < 0) return false;
  L.splice(last + 1, 0, '',
    '// G7 下沉（2026-09-22）：seedBatch 并入 helpers/governance-fixture.mjs（与 preset-config 同形单轴差）；别名导入保持调用点零改动。',
    "import { seedGovernanceBatch as seedBatch } from './helpers/governance-fixture.mjs';");
  return 1;
});

// ④ governance-preset-config
edit('test/governance-preset-config.test.js', (L) => {
  const blk = findBalanced(L, "function seedBatch(root, sessionId, batchId, laneId = 'l1') {", 'return aux;');
  if (!blk) return false;
  L.splice(blk[0], blk[1] - blk[0] + 1);
  while (L[blk[0]] === '' && L[blk[0] + 1] === '') L.splice(blk[0], 1);
  const last = L.map((l, i) => [/^import /.test(l), i]).filter(([x]) => x).pop()[1];
  if (last < 0) return false;
  L.splice(last + 1, 0, '',
    '// G7 下沉（2026-09-22）：seedBatch 并入 helpers/governance-fixture.mjs；别名导入保持调用点零改动。',
    "import { seedGovernanceBatch as seedBatch } from './helpers/governance-fixture.mjs';");
  return 1;
});

console.log(bad === 0 ? 'ALL OK' : 'FAILURES=' + bad);
