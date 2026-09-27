/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// 批次 `core-techdebt-close-20260915` · lane e2：**测试基线校验用例**。
//
// 为什么需要它：`test/gates.test.js` / `test/gate-flows.test.js` / `test/gate-techdebt-red.test.js`
// 在本仓 **git untracked** ⇒ 没有历史 diff，「删断言」这类退化只能在事后靠人工回忆间接举证。
// 本用例把 `baselines/test-baseline.json` 变成不依赖 git 追踪状态的对照线：**断言调用数低于基线即红**，
// 并打印逐文件 diff（谁少了多少）。它不是替代代码评审，只兜住「静默删断言」这一种退化。
// 批次 `engine-review-fix-a-20260915` · lane e6 补第二条腿（B5）：**恒真形态命中数高于基线即红**——
// 原口径只看调用数，`assert.equal(x, 期望)` 换成 `assert.ok(true)` 时调用数不变 ⇒ 0 漂移、全绿；
// 现在同参自比 / 常量真值会被记进 `tautologies` 指标并点名到行（见 §7）。
//
// 口径（与生成器共用 `scripts/baseline-snapshot-core.mjs`，避免两边算法漂移）：
//   tests/asserts/todos 均为**源码词法调用点数**（注释与字符串内的同名字样不计），不是运行器计数。
//   故本文件**不写死总量常量**——基线会因合法新增而更新，写死常量会让用例因自身或邻居 lane 的改动而失效。
//
// 显式更新通道（防静默；三条同时满足才生效）：
//   1. 环境变量 `BASELINE_UPDATE=1`（或 `true`）
//   2. 环境变量 `BASELINE_UPDATE_REASON="<变更事由>"`（人类可读，写进基线 `reason` 字段）
//   3. 本进程不是 `node:test` 的用例子进程（`NODE_TEST_CONTEXT` 未设）
//   或直接跑生成器：`node scripts/baseline-snapshot.mjs --reason "<事由>"`
//   —— 更新时**打印完整变化清单**（逐文件 + 总量），不静默。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASELINE_REL_PATH,
  compareBaseline,
  countSource,
  diffBaseline,
  findRepoRoot,
  listTestFiles,
  readBaseline,
  scanTree,
  serializeBaseline,
  sortKeysDeep,
} from '../scripts/baseline-snapshot-core.mjs';

const ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const BASELINE_ABS = path.join(ROOT, BASELINE_REL_PATH);

/** 合成基线：只带 totals/files，够 `compareBaseline` 判读即可（不碰真实基线文件）。 */
function syntheticBaseline(totals, files = {}) {
  return { schema: 1, kind: 'test-baseline', totals, files };
}

/** 归一化更新事由（留痕纪律的实现点：空事由不落盘）。 */
function normalizeUpdateReason(reason) {
  return String(reason ?? '').trim();
}

/** 变化清单渲染（更新通道与失败信息共用，保证「看得懂」）。 */
function renderChanges(changes) {
  return changes
    .map((f) => `${f.kind} ${f.file} ${Object.entries(f.delta).map(([k, v]) => k + '=' + v).join(' ')}`)
    .join('\n');
}

// ── 1. 基线自洽：与真实测试树逐文件一致 ─────────────────────────────────
test('e2-1 基线自洽：baselines/test-baseline.json 与当前 test/ 树逐文件一致（0 漂移 / 0 告警）', () => {
  assert.ok(fs.existsSync(BASELINE_ABS), `${BASELINE_REL_PATH} 必须入库存在`);
  const raw = fs.readFileSync(BASELINE_ABS, 'utf8');
  assert.ok(!raw.startsWith('\uFEFF'), 'UTF-8 无 BOM');
  assert.ok(!raw.includes('\r\n'), 'LF 行尾');
  assert.equal(raw, serializeBaseline(JSON.parse(raw)), '键排序稳定（重新序列化后逐字节一致，可 diff）');
  assert.ok(raw.endsWith('\n'), '末尾保留单个 LF');

  const baseline = readBaseline(ROOT);
  assert.equal(baseline.schema, 1);
  assert.equal(baseline.kind, 'test-baseline');

  const scan = scanTree(ROOT);
  const cmp = compareBaseline(baseline, scan);
  assert.deepEqual(cmp.filesChanged, [], `逐文件无漂移；实际差异：\n${renderChanges(cmp.filesChanged)}`);
  assert.deepEqual(cmp.warnings, [], '无用例数 / test.todo 数下降告警');
  assert.equal(cmp.ok, true);
  assert.equal(cmp.asserts.current, baseline.totals.asserts, '断言总数与基线一致');
  assert.equal(typeof baseline.totals.tautologies, 'number', '基线含恒真形态指标（B5 新增口径，缺则旧基线未重生成）');
  assert.equal(cmp.tautologies.current, baseline.totals.tautologies, '恒真形态命中数与基线一致');
  assert.equal(baseline.totals.files, listTestFiles(ROOT).length, '文件计数与扫描结果一致');
  const sum = Object.values(scan.files).reduce((a, f) => a + f.asserts, 0);
  assert.equal(baseline.totals.asserts, sum, '逐文件断言数之和 == 总量');
});

// ── 2. 判红：断言调用数下降 ⇒ 逐文件 diff 点名 ──────────────────────────
test('e2-2 判红：断言总数低于基线 ⇒ ok:false，且逐文件 diff 点名到文件与数量', () => {
  const scan = scanTree(ROOT);
  const base = readBaseline(ROOT);
  // 【2026-09-27 漂移免疫】合成基线锚到 **live scan**（`scan.totals.asserts + 1`）而非落盘基线值：
  //   本用例测的是**比较器**的判红语义（「基线高于实测 ⇒ 必须红」），与「基线文件是否与当前测试树逐字节一致」
  //   是两件事——后者由 e2-1 单点负责。锚落盘基线会让本用例在**基线尚未重生成的窗口**里假红（断言数只会增），
  //   命题未变、断言未删，只是把合成输入改成自洽形态。
  // 合成输入同时锚定 tests/tautologies（与 live scan 一致）⇒ 「只把 asserts 抬高 1」这一**单变量**成立，
  //   下方 `cmp.tests.delta === 0`（用例数未变不误报）才是在测比较器、而不是在测基线是否新鲜。
  const lowered = {
    ...base,
    totals: { ...base.totals, asserts: scan.totals.asserts + 1, tests: scan.totals.tests, tautologies: scan.totals.tautologies },
  };
  const cmp = compareBaseline(lowered, scan);
  assert.equal(cmp.ok, false, '断言数低于基线必须判红');
  assert.equal(cmp.asserts.delta, -1, '差值如实为 -1');
  assert.equal(cmp.tests.delta, 0, '用例数未变时不误报');

  // diff 点名：把基线某文件的断言数调高 3 ⇒ 该文件出现在 filesChanged 且 delta.asserts = -3
  const victim = Object.keys(scan.files).sort()[0];
  const raised = {
    ...base,
    totals: { ...base.totals, asserts: base.totals.asserts + 3 },
    files: { ...base.files, [victim]: { ...base.files[victim], asserts: base.files[victim].asserts + 3 } },
  };
  const cmp2 = compareBaseline(raised, scan);
  const hit = cmp2.filesChanged.find((f) => f.file === victim);
  assert.ok(hit, `diff 必须点名 ${victim}`);
  assert.equal(hit.delta.asserts, -3, '点名文件给出断言缺口数量');
});

// ── 3. 误报边界（规格 §2.3）：合法重构不误红 ────────────────────────────
test('e2-3 误报边界：用例合并（tests/test.todo 减少、断言总数不变）只告警不判红', () => {
  const current = syntheticBaseline({ files: 1, tests: 4, todos: 0, asserts: 10, lines: 40, blankLines: 0 }, {
    'test/merged.test.js': { tests: 4, todos: 0, asserts: 10, lines: 40, blankLines: 0 },
  });
  const baseline = syntheticBaseline({ files: 1, tests: 12, todos: 2, asserts: 10, lines: 90, blankLines: 5 }, {
    'test/merged.test.js': { tests: 12, todos: 2, asserts: 10, lines: 90, blankLines: 5 },
  });
  const cmp = compareBaseline(baseline, current);
  assert.equal(cmp.ok, true, '用例数 / test.todo 下降而断言总数不变 ⇒ 不判红（合并用例是合法重构）');
  assert.equal(cmp.warnings.length, 2, '仍如实列 2 条告警（可见但不阻断）');
  assert.ok(cmp.warnings.some((w) => w.includes('用例数')));
  assert.ok(cmp.warnings.some((w) => w.includes('test.todo')));
});

test('e2-4 误报边界：文件拆分/重命名（断言总数不变）不误红，且不产生告警', () => {
  const current = syntheticBaseline({ files: 2, tests: 3, todos: 0, asserts: 9, lines: 30, blankLines: 0 }, {
    'test/big-part-a.test.js': { tests: 2, todos: 0, asserts: 5, lines: 20, blankLines: 0 },
    'test/big-part-b.test.js': { tests: 1, todos: 0, asserts: 4, lines: 10, blankLines: 0 },
  });
  const baseline = syntheticBaseline({ files: 1, tests: 3, todos: 0, asserts: 9, lines: 30, blankLines: 0 }, {
    'test/big.test.js': { tests: 3, todos: 0, asserts: 9, lines: 30, blankLines: 0 },
  });
  const cmp = compareBaseline(baseline, current);
  assert.equal(cmp.ok, true, '断言总数持平 ⇒ 拆文件不该红（文件名是组织方式，不是覆盖度）');
  assert.deepEqual(cmp.warnings, [], '新增/移除文件不产生「用例数下降」告警');
  assert.deepEqual(
    cmp.filesChanged.map((f) => f.kind).sort(),
    ['added', 'added', 'removed'],
    '变化如实列出（2 新增 1 移除）但不阻断',
  );
});

test('e2-5 误报边界：同一测试树自身对照时整批 diff 为空（机制不引入噪声）', () => {
  const scan = scanTree(ROOT);
  const cmp = compareBaseline(scan, scan);
  assert.equal(cmp.ok, true);
  assert.deepEqual(cmp.filesChanged, [], '同源对照 ⇒ 零差异');
  assert.deepEqual(cmp.warnings, []);
  assert.equal(cmp.asserts.delta, 0);
});

// ── 4. 更新通道留痕：变化清单人可读，不静默 ─────────────────────────────
test('e2-6 更新通道留痕：diffBaseline 给出逐文件 + 总量两级变化清单', () => {
  const before = syntheticBaseline({ files: 1, tests: 1, todos: 0, asserts: 4, lines: 10, blankLines: 1 }, {
    'test/x.test.js': { tests: 1, todos: 0, asserts: 4, lines: 10, blankLines: 1 },
  });
  const after = syntheticBaseline({ files: 2, tests: 2, todos: 1, asserts: 7, lines: 22, blankLines: 2 }, {
    'test/x.test.js': { tests: 1, todos: 0, asserts: 3, lines: 12, blankLines: 1 },
    'test/y.test.js': { tests: 1, todos: 1, asserts: 4, lines: 10, blankLines: 1 },
  });
  const d = diffBaseline(before, after);
  assert.deepEqual(
    d.totals,
    { tests: 1, todos: 1, asserts: 3, tautologies: 0, lines: 12, blankLines: 1 },
    '总量级 delta 齐备',
  );
  assert.deepEqual(
    d.files,
    [
      { file: 'test/x.test.js', kind: 'changed', delta: { asserts: -1, lines: 2 } },
      { file: 'test/y.test.js', kind: 'added', delta: { tests: 1, todos: 1, asserts: 4, lines: 10, blankLines: 1 } },
    ],
    '逐文件级 delta 只列真正变化的指标，且按路径排序',
  );
  assert.deepEqual(
    renderChanges(d.files),
    'changed test/x.test.js asserts=-1 lines=2\nadded test/y.test.js tests=1 todos=1 asserts=4 lines=10 blankLines=1',
    '留痕文本人可读（更新通道原样打印这段）',
  );
  assert.deepEqual(
    diffBaseline(after, after),
    { files: [], totals: { tests: 0, todos: 0, asserts: 0, tautologies: 0, lines: 0, blankLines: 0 } },
    '无变化 ⇒ 空清单',
  );
});

// ── 5. 更新通道的准入判据（空事由不许静默更新） ─────────────────────────
test('e2-7 更新通道准入：事由为空即拒（禁止静默更新基线）', () => {
  assert.equal(normalizeUpdateReason('  '), '', '空白事由归一化为空');
  assert.equal(normalizeUpdateReason(undefined), '');
  assert.equal(normalizeUpdateReason(' 合法重构：拆分 gates 用例 '), '合法重构：拆分 gates 用例');
  assert.equal(normalizeUpdateReason('x').length > 0, true);
});

// ── 6. 内核口径可判（词法屏蔽 + 四指标） ────────────────────────────────
test('e2-8 内核口径：注释与字符串里的 test(/assert. 不计，test.todo 与顶层 test 分列', () => {
  const src = [
    "// test('注释里的不算', () => { assert.ok(1) });",
    "const s = \"test('字符串里的也不算', () => { assert.equal(1, 1) });\";",
    "test.todo('待办：不算用例但单独计 todo');",
    "test('真用例', () => {",
    '  assert.ok(true);',
    '  assert.strictEqual(1, 1);',
    '});',
    '',
  ].join('\n');
  const stat = countSource(src);
  assert.equal(stat.tests, 1, '只有顶层真 test 计数');
  assert.equal(stat.todos, 1, 'test.todo 单列');
  assert.equal(stat.asserts, 2, '注释/字符串里的 assert 不计，真断言 2 条');
  assert.equal(stat.lines, 8, '四指标之一：物理行数');
  assert.equal(stat.blankLines, 1, '空白行单列');
});

test('e2-9 内核口径：模板串插值体内外分别处理（回归：整段反引号区被误屏蔽会让计数假降）', () => {
  const src = "const a = `文本 assert.equal(1, 1); 不是代码`; assert.ok(a, `${a} 插值内的 assert.ok(1) 也不是代码`);\n";
  const stat = countSource(src);
  assert.equal(stat.asserts, 1, '模板串文本与插值串内的 assert 均不计，串外真断言计 1');
  assert.equal(stat.lines, 2, '单个 LF ⇒ 2 行（词法口径不影响行数指标）');
  assert.equal(stat.tests, 0, '模板串里的 test( 字样同样不计');
});

test('e2-10 内核：sortKeysDeep 递归排序（基线可 diff 的实现前提）', () => {
  assert.deepEqual(Object.keys(sortKeysDeep({ z: 1, a: { y: 2, b: 3 } })), ['a', 'z']);
  assert.deepEqual(Object.keys(sortKeysDeep({ z: 1, a: { y: 2, b: 3 } }).a), ['b', 'y']);
  const text = serializeBaseline({ b: 1, a: 2 });
  assert.ok(text.indexOf('"a"') < text.indexOf('"b"'), '序列化后键名升序');
  assert.deepEqual(sortKeysDeep([{ b: 1, a: 2 }]), [{ a: 2, b: 1 }], '数组内对象同样排序');
});

// ── 7. 恒真形态启发式（B5：等价替换绕过护栏） ───────────────────────────
// 来源（对抗评审实测）：把 `assert.equal(x, 期望)` 换成 `assert.ok(true)` ⇒ 断言调用数不变、
// 基线 0 漂移、用例全绿——护栏只兜「删断言」，不兜「把断言写成恒真」。
// 本组用例把「恒真形态命中数」并入判据：① 命中要能被**点名到行**（RED 面）；② 正常断言不得误报（GREEN 面）。

/** 构造样本源码：数组元素都是字符串字面量 ⇒ 本文件自身不会被启发式自计（与 §6 同款手法）。 */
function sample(lines) {
  return lines.concat(['']).join('\n');
}

test('e6-1 恒真形态命中：assert.ok(恒真常量) ⇒ 计入 tautologies（调用数不变也被看见）', () => {
  const stat = countSource(
    sample(["test('t', () => {", '  assert.ok(true);', '  assert.ok(1);', '  assert.ok(!false);', '});']),
  );
  assert.equal(stat.asserts, 3, '调用数照旧 3 条——这正是原护栏看不见的绕过机理');
  assert.equal(stat.tautologies, 3, '三条恒真常量全部命中');
  assert.deepEqual(
    stat.tautologyHits.map((h) => h.kind),
    ['ok-const-true', 'ok-const-true', 'ok-const-true'],
    '形态名可读，供 --check 打印',
  );
  assert.deepEqual(
    stat.tautologyHits.map((h) => h.line),
    [2, 3, 4],
    '命中点名到行（退化可定位，不必人工翻文件）',
  );
});

test('e6-2 恒真形态命中：同参自比 assert.equal(a, a) / strictEqual / 成员链', () => {
  const stat = countSource(
    sample([
      "test('t', () => {",
      '  assert.equal(v, v);',
      '  assert.strictEqual(v, v);',
      '  assert.deepEqual(o.a, o.a);',
      '});',
    ]),
  );
  assert.equal(stat.asserts, 3);
  assert.equal(stat.tautologies, 3, '无副作用可复现表达式两侧自比 ⇒ 求值必然相同');
  assert.deepEqual(stat.tautologyHits.map((h) => h.kind), ['eq-same-ident', 'eq-same-ident', 'eq-same-ident']);
});

test('e6-3 恒真形态命中：同字面量自比（strictEqual(1, 1) / 同字符串）', () => {
  const stat = countSource(sample(["test('t', () => {", '  assert.strictEqual(1, 1);', "  assert.equal('x', 'x');", '});']));
  assert.equal(stat.tautologies, 2, '两侧同一字面量 ⇒ 恒真');
  assert.deepEqual(stat.tautologyHits.map((h) => h.kind), ['eq-same-literal', 'eq-same-literal']);
  assert.equal(stat.tautologyHits[1].text, "assert.equal('x', 'x')", '命中原文可读（--check 点名用）');
});

test('e6-4 放行：正常断言（不同标识符 / 动态条件 / 带副作用调用）不误报', () => {
  const stat = countSource(
    sample([
      "test('t', () => {",
      '  assert.equal(actual, expected);',
      '  assert.ok(count > 0);',
      '  assert.deepEqual(r.body, EXPECTED);',
      '  assert.equal(nextId(), nextId());',
      '  assert.strictEqual(list.length, 2);',
      '});',
    ]),
  );
  assert.equal(stat.asserts, 5, '正常断言照常计数');
  assert.equal(stat.tautologies, 0, 'GREEN：零误报（含 assert.ok(x > 0) 这类动态条件）');
  assert.deepEqual(stat.tautologyHits, [], '无命中明细');
});

test('e6-5 口径一致：注释 / 字符串 / 模板串文本里的恒真形态不计（与 asserts 同款屏蔽）', () => {
  const stat = countSource(
    sample([
      "test('t', () => {",
      '  // assert.ok(true); 注释里的同形字样不算',
      '  const s = "assert.equal(v, v)";',
      '  const t = `assert.ok(1) 模板串文本`;',
      '  assert.ok(real);',
      '});',
    ]),
  );
  assert.equal(stat.asserts, 1, '只有真断言计数');
  assert.equal(stat.tautologies, 0, '非代码区的恒真形态不计（防「写段说明文字就误红」）');
});

test('e6-6 判红：恒真形态命中数高于基线 ⇒ ok:false，且逐文件点名', () => {
  const base = syntheticBaseline(
    { files: 1, tests: 1, todos: 0, asserts: 4, tautologies: 0, lines: 10, blankLines: 0 },
    { 'test/x.test.js': { tests: 1, todos: 0, asserts: 4, tautologies: 0, lines: 10, blankLines: 0 } },
  );
  const current = {
    ...base,
    totals: { ...base.totals, tautologies: 1 },
    files: { 'test/x.test.js': { ...base.files['test/x.test.js'], tautologies: 1 } },
  };
  const cmp = compareBaseline(base, current);
  assert.equal(cmp.ok, false, '恒真形态增加 ⇒ 判红（等价替换不得静默通过）');
  assert.deepEqual(cmp.tautologies, { baseline: 0, current: 1, delta: 1 }, '缺口数量如实给出');
  assert.equal(cmp.asserts.delta, 0, '断言调用数不变——绕过机理如实呈现');
  assert.deepEqual(
    cmp.filesChanged,
    [{ file: 'test/x.test.js', kind: 'changed', delta: { tautologies: 1 } }],
    '逐文件点名到「谁新增了恒真断言」',
  );
});

test('e6-7 边界：存量恒真形态与命中数下降都不判红（判据是「上升」而非「存在」）', () => {
  const base = syntheticBaseline(
    { files: 1, tests: 1, todos: 0, asserts: 4, tautologies: 2, lines: 10, blankLines: 0 },
    { 'test/x.test.js': { tests: 1, todos: 0, asserts: 4, tautologies: 2, lines: 10, blankLines: 0 } },
  );
  assert.equal(compareBaseline(base, base).ok, true, '与基线持平 ⇒ 不红（存量入库后不再阻断前进）');
  const lower = {
    ...base,
    totals: { ...base.totals, tautologies: 0 },
    files: { 'test/x.test.js': { ...base.files['test/x.test.js'], tautologies: 0 } },
  };
  assert.equal(compareBaseline(base, lower).ok, true, '命中数下降 ⇒ 不红');
  assert.equal(compareBaseline(base, lower).tautologies.delta, -2, '下降幅度如实为 -2');
});

test('e6-8 真实树：基线 tautologies 自洽，且命中明细可点名（文件 + 行 + 形态）', () => {
  const baseline = readBaseline(ROOT);
  const scan = scanTree(ROOT);
  assert.equal(baseline.totals.tautologies, scan.totals.tautologies, '总量与基线一致（0 漂移的一部分）');
  const sum = Object.values(scan.files).reduce((a, f) => a + f.tautologies, 0);
  assert.equal(sum, scan.totals.tautologies, '逐文件命中数之和 == 总量');
  const hitFiles = Object.keys(scan.tautologyHits);
  assert.equal(
    hitFiles.length,
    Object.values(scan.files).filter((f) => f.tautologies > 0).length,
    '有命中的文件与明细视图一一对应（明细不入基线 JSON，避免换行抖动）',
  );
  for (const rel of hitFiles) {
    assert.equal(scan.tautologyHits[rel].length, scan.files[rel].tautologies, `${rel} 明细条数 == 计数`);
    for (const h of scan.tautologyHits[rel]) {
      assert.ok(h.line >= 1 && typeof h.kind === 'string' && h.text.startsWith('assert.'), `${rel}:${h.line} 明细字段齐备`);
    }
  }
});

// ── 8. 更新通道的实际执行（仅在本进程 + 已武装 + 有事由时） ──────────────
const UPDATE_ARMED = process.env.BASELINE_UPDATE === '1' || process.env.BASELINE_UPDATE === 'true';
if (UPDATE_ARMED && process.env.NODE_TEST_CONTEXT === undefined) {
  const reason = normalizeUpdateReason(process.env.BASELINE_UPDATE_REASON);
  if (reason === '') {
    throw new Error('BASELINE_UPDATE 需要 BASELINE_UPDATE_REASON（拒绝静默更新基线）');
  }
  const before = fs.existsSync(BASELINE_ABS)
    ? readBaseline(ROOT)
    : syntheticBaseline({ files: 0, tests: 0, todos: 0, asserts: 0, lines: 0, blankLines: 0 });
  const scan = scanTree(ROOT);
  const after = {
    ...before,
    files: scan.files,
    totals: scan.totals,
    reason,
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  fs.writeFileSync(BASELINE_ABS, serializeBaseline(after), 'utf8');
  const d = diffBaseline(before, after);
  const signed = (n) => (n >= 0 ? '+' : '') + n;
  process.stdout.write('[test-baseline] 显式更新基线（留痕）：' + reason + '\n');
  process.stdout.write(
    `[test-baseline]   totals: tests=${signed(d.totals.tests)} asserts=${signed(d.totals.asserts)} ` +
      `todos=${signed(d.totals.todos)} lines=${signed(d.totals.lines)}\n`,
  );
  if (d.files.length === 0) process.stdout.write('[test-baseline]   （逐文件无变化）\n');
  for (const f of d.files) {
    process.stdout.write(`[test-baseline]   ${f.kind} ${f.file} ${JSON.stringify(f.delta)}\n`);
  }
}
