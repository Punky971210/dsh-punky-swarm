// I-05 契约链 ＋ I-10 续跑上界（行为面；两条计划 T-cmd 都是 grep 型弱判据，故本文件承接真实判据）
//
// 计划 T-cmd 经实测不可满足，**本文件按「正确判据」写**（不照字面凑）：
//   · I-05 `grep -c -e canonicalSha256 -e supersedesContractId -e completionAuthority = 3`
//     实测 16（`grep -c` 计含任一 token 的**行数**）⇒ 改为「三个名字逐个存在」＋ 三组两态。
//   · I-10 `grep -c MAX_LIVENESS_CONTINUATION = 1` 与「常量被引用」**算术上不可兼得**
//     ⇒ 改为「唯一定义 = 1」＋「比较处不硬写 2」＋ 三态行为。
//
// 每条判据都配反向构造（变异 + 两态）：只给「通过」等于没给证据。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalSha256, contractIdOf, registerContract, chainOf, completionAuthorityOf, SUPERSEDES_MISSING,
} from '../lib/state/contract.js';
import {
  continuationDecision, MAX_LIVENESS_CONTINUATION, CONTINUABLE_REASONS,
} from '../lib/state/liveness.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_SRC = join(ROOT, 'lib', 'state', 'contract.js');
const LIVENESS_SRC = join(ROOT, 'lib', 'state', 'liveness.js');

// ─────────────────────────── I-05 ───────────────────────────

const C1_BODY = { batchId: 'b1', task: 'build', completionAuthority: 'audit', done: ['x', 'y'] };

test('I-05-A 摘要稳定性：键序打乱 ⇒ 相同；改值 ⇒ 不同；数组顺序 ⇒ 不同', () => {
  const reordered = { done: ['x', 'y'], completionAuthority: 'audit', task: 'build', batchId: 'b1' };
  assert.equal(canonicalSha256(reordered), canonicalSha256(C1_BODY),
    '同内容异键序必须同摘要（禁 JSON.stringify 直接哈希）');

  assert.notEqual(canonicalSha256({ ...C1_BODY, task: 'build2' }), canonicalSha256(C1_BODY),
    '改字段值必须改变摘要（否则摘要对内容不敏感 = 假判据）');

  assert.notEqual(canonicalSha256({ ...C1_BODY, done: ['y', 'x'] }), canonicalSha256(C1_BODY),
    '数组顺序是语义 ⇒ 必须改变摘要');

  // 两态对照：同对象重复计算稳定
  assert.equal(canonicalSha256(C1_BODY), canonicalSha256(C1_BODY), '重复计算必须稳定');
});

test('I-05-B 版本链 fail-closed：链可解析；断链在**登记期**抛且零写入', () => {
  const table = new Map();
  const r1 = registerContract(table, { batchId: 'b1', version: 1 });
  const r2 = registerContract(table, { batchId: 'b1', version: 2, supersedesContractId: r1.id });

  const chain = chainOf(table, r2.id);
  assert.equal(chain.length, 2, 'chainOf(C2) 必须含两条');
  assert.equal(chain[0].version, 2, '链首 = 最新');
  assert.equal(chain[1].version, 1, '链尾 = 被取代者（顺序即新→旧）');

  // 反例：supersedes 指向不存在的契约 ⇒ 抛 + 零写入
  const before = table.size;
  assert.throws(
    () => registerContract(table, { batchId: 'b1', version: 9, supersedesContractId: 'sha256:' + 'f'.repeat(64) }),
    (e) => String(e.message).startsWith(SUPERSEDES_MISSING),
    '断链必须抛且前缀为 supersedes-missing:',
  );
  assert.equal(table.size, before, '断链登记必须零写入（禁「标记 broken 后放行」）');
});

test('I-05-B2 读时也 fail-closed：外部删掉被取代者 ⇒ chainOf 抛（不用空数组冒充完整链）', () => {
  const table = new Map();
  const q1 = registerContract(table, { batchId: 'b2', version: 1 });
  const q2 = registerContract(table, { batchId: 'b2', version: 2, supersedesContractId: q1.id });

  // 两态对照：删之前可解析
  assert.equal(chainOf(table, q2.id).length, 2, '删之前链完整');

  table.delete(q1.id);
  assert.throws(() => chainOf(table, q2.id), (e) => String(e.message).startsWith(SUPERSEDES_MISSING),
    '登记期校验不足以自证：读期同样必须拒');
  assert.throws(() => chainOf(table, 'sha256:' + '0'.repeat(64)),
    (e) => String(e.message).startsWith(SUPERSEDES_MISSING), '未知 id ⇒ 抛，不得返回空数组');
});

test('I-05-C 完成归属逐契约读回：不同声明 ⇒ 不同值；未知契约 ⇒ null（查询语义不抛）', () => {
  const table = new Map();
  const k1 = registerContract(table, { batchId: 'b3', completionAuthority: 'audit-supervisor' });
  const k2 = registerContract(table, { batchId: 'b3', completionAuthority: 'leader' });

  const a1 = completionAuthorityOf(table, k1.id);
  const a2 = completionAuthorityOf(table, k2.id);
  assert.equal(a1, 'audit-supervisor');
  assert.equal(a2, 'leader');
  assert.notEqual(a1, a2, '两份契约不同声明必须读回不同值（恒同值 = 红）');
  assert.equal(completionAuthorityOf(table, 'sha256:' + '0'.repeat(64)), null, '未知契约 ⇒ null');
});

test('I-05 身份语义：id = 内容哈希（同内容同 id；改字段 id 必变）', () => {
  const reordered = { done: ['x', 'y'], completionAuthority: 'audit', task: 'build', batchId: 'b1' };
  assert.equal(contractIdOf(reordered), contractIdOf(C1_BODY), '同内容（异键序）⇒ 同 id');
  assert.notEqual(contractIdOf({ ...C1_BODY, task: 'changed' }), contractIdOf(C1_BODY),
    '改字段 ⇒ id 必变（不允许"同 id 不同内容"）');
  assert.equal(contractIdOf(C1_BODY), canonicalSha256(C1_BODY), 'contractIdOf ≡ canonicalSha256');
});

test('I-05 正确判据（替代不可满足的 grep = 3）：三个名字逐个在场', () => {
  const src = readFileSync(CONTRACT_SRC, 'utf8');
  for (const token of ['canonicalSha256', 'supersedesContractId', 'completionAuthority']) {
    assert.ok(src.includes(token), '实现必须真实包含 ' + token + '（grep -q 语义）');
  }
  // 注：**不**断言行数恰 3 —— 实测 16，且「恰 3」只能靠删注释/合并防御分支达成（那是削实现凑数）。
});

// ─────────────────────────── I-10 ───────────────────────────

test('I-10-1 三态：count 1 允许 / 2 允许 / 3 必拒（拒因 liveness-limit:）', () => {
  const d1 = continuationDecision({ stopReason: 'empty_response', continuationCount: 1 });
  assert.deepEqual(d1, { continueAllowed: true }, '第 1 次续跑允许');

  const d2 = continuationDecision({ stopReason: 'empty_response', continuationCount: 2 });
  assert.deepEqual(d2, { continueAllowed: true }, '第 2 次续跑允许（上界 2 ⇒ 正好用满）');

  const d3 = continuationDecision({ stopReason: 'empty_response', continuationCount: 3 });
  assert.equal(d3.continueAllowed, false, '第 3 次必拒（空转不产第 3 次 run）');
  assert.ok(String(d3.reason).startsWith('liveness-limit:'), '次数门拒因前缀 liveness-limit:，收到：' + d3.reason);
});

test('I-10-2 否证态：stopReason=completed 即使次数未到上界也拒（原因门先于次数门）', () => {
  const denied = continuationDecision({ stopReason: 'completed', continuationCount: 0 });
  assert.equal(denied.continueAllowed, false, 'completed 不可续跑 —— 即便次数为 0');
  assert.ok(String(denied.reason).startsWith('liveness-not-continuable:'),
    '原因门拒因前缀 liveness-not-continuable:，收到：' + denied.reason);

  // 两态对照：同一次数、换成可续原因 ⇒ 放行（证明不是"恒拒"）
  assert.deepEqual(continuationDecision({ stopReason: 'empty_response', continuationCount: 0 }),
    { continueAllowed: true }, '同一夹具换 empty_response ⇒ 放行');
});

test('I-10-3 上界取值与常量绑定：MAX_LIVENESS_CONTINUATION === 2，且行为与常量一致', () => {
  assert.equal(MAX_LIVENESS_CONTINUATION, 2, '上界取值必须是 2');
  assert.deepEqual([...CONTINUABLE_REASONS], ['empty_response'], '唯一可续原因是 empty_response');
  // 行为与常量绑定：把 count 提到上界 ⇒ 允许；上界 +1 ⇒ 拒
  assert.equal(continuationDecision({ stopReason: 'empty_response', continuationCount: MAX_LIVENESS_CONTINUATION }).continueAllowed,
    true, 'count === 上界 ⇒ 允许');
  assert.equal(continuationDecision({ stopReason: 'empty_response', continuationCount: MAX_LIVENESS_CONTINUATION + 1 }).continueAllowed,
    false, 'count > 上界 ⇒ 拒（比较走常量而非硬写）');
});

test('I-10 正确判据（替代不可兼得的 grep = 1）：唯一定义 = 1 ＋ 比较处不硬写 2', () => {
  const src = readFileSync(LIVENESS_SRC, 'utf8');
  const defs = src.split('\n').filter((l) => /^export const MAX_LIVENESS_CONTINUATION\b/.test(l));
  assert.equal(defs.length, 1, '常量必须**唯一**定义一次');
  assert.ok(src.includes('= 2'), '定义行取值必须是 2');

  // 「不要硬写 2」：去掉注释后，比较/等值运算里不得再出现字面量 2
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for (const bad of [/[\w\)\]]\s*>\s*2\b/, /[\w\)\]]\s*>=\s*2\b/, /[\w\)\]]\s*===\s*2\b/]) {
    assert.equal(bad.test(code), false, '比较不得硬写字面量 2：' + bad);
  }
  // 且常量必须被引用（定义之外的第二次出现）
  const occurrences = code.split('MAX_LIVENESS_CONTINUATION').length - 1;
  assert.ok(occurrences >= 2, '常量必须被实际引用（定义 + 使用 ≥ 2 次），实测 ' + occurrences);
});
