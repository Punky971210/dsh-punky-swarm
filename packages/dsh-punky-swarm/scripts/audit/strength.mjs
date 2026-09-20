// ── 断言强度分析（scores: title / exact / weak / other）───────────────────────
// 动机（R3-2 实证）：台账的 `testHits` 是**覆盖代理量**而非断言强度证明 ——
//   **测试标题里写码也算命中**（`test('should throw GATE_X', …)`）。它与 `testHits === 0`
//   对 audit 的意义完全不同：后者是「完全没覆盖」，前者是「看着覆盖了、但一行断言都没有」。
// 故此处把每个测试文件内的命中按**出现位置**分四类：
//   title = 落在 `test()/describe()/it()` 的**标题字面量**内  ⇒ 零证明力
//   exact = 落在 `assert.*(` 的**语句窗口**内，且窗口存在**整码字面量**（`'GATE_X'` / `/GATE_X/`）
//   weak  = 落在 `assert.*(` 窗口内，但窗口里没有整码字面量（例如只断言了 `legacy === true`）
//   other = 其余位置（夹具数据 / 常量声明 / 辅助字符串）⇒ 非断言
// ⚠ 判别力自证见 `strengthSelfTest()`（cmd：`node scripts/audit/gates.mjs --selftest`）。
//   任何" detector "类工具都必须自带判别力自证，否则它本身可能就是空转（R3-4 教训）。

/** 断言窗口长度：覆盖多行 `assert.rejects(() => …, { message: /CODE/ })` 的常见形态。 */
const WINDOW = 400;

/** `test/it/describe` 声明：`(\.(skip|only|todo))?` 覆盖修饰符；组 1 = 引号，组 2 = 标题正文。 */
const DECL_RE = /\b(?:test|it|describe)(?:\.[A-Za-z]+)?\s*\(\s*(['"`])([\s\S]*?)\1/g;

/** `assert.<method>(` 起点：`assert.rejects(` / `assert.match(` / `assert(` 均命中。 */
// ⚠ 必须是 `assert` **开头的任意标识符**：本仓大量用例走自定义助手（`assertRejected(`）；
//   只认 `assert.*(` 会把整类真实断言漏判成缺口（假阴）。
const ASSERT_RE = /\bassert[A-Za-z0-9_$]*(?:\.[A-Za-z]+)?\s*\(/g;

const occurrenceCount = (src, re) => (src.match(re) || []).length;

/**
 * 判定窗口内是否含**整码字面量**（`'GATE_X'` / `/GATE_X/` / `/^GATE_X$/`）。
 * 允许 `^ $` 锚：那仍是"把全码作为期望值"的严格断言；**不允许**更宽的串（`/GATE_/` 这类前缀 == 非整码）。
 */
function hasExactLiteral(windowText, id) {
  // ⚠ `^` / `$` 必须转义成字面量再给量词 —— 直接写 `^?` 是把量词加在零宽断言上 ⇒ JS 抛
  //   `Nothing to repeat`（本文件的这条就是在自证里被抓出来的，不是想明白的）。
  const anchors = new RegExp(`[/'"\`]\\s*\\^?\\s*${id}\\s*\\$?\\s*[/'"\`]`);
  // ⚠ ` (?![A-Za-z0-9_])` 必须保留：否则 `GATE_X_Y` 会被当作 `GATE_X` 的证据（串味）。
  return new RegExp(`[/'"\`]\\s*\\^?\\s*${id}(?![A-Za-z0-9_])\\s*(?::|：)?[^'"/\`]*[/'"\`]`).test(windowText);
}

/**
 * 对单个【已屏蔽注释】的源码文本做code-level 强度分类。
 * @param {string} text  comment-shielded source
 * @param {string} id    code identifier, e.g. `GATE_EXEC_INPUT_MISSING`
 * @returns {{total:number,title:number,exact:number,weak:number,other:number}}
 */
export function classifyHits(text, id) {
  // ── ⓿ 常量别名：`const CODE_X = 'GATE_X'`（本仓 R3-1 / R3-4 的真实形态）─────────────
  //   不解析这一层 ⇒ 断言写 `{ message: CODE_X }` 会被判成"没断言"（**假阴**），
  //   其危害与"假阳"同级：把有覆盖的门报成缺口，会诱发无效补测。
  const aliasDeclRe = new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*['"\`]${id}['"\`]`, 'g');
  const aliasDecls = [...text.matchAll(aliasDeclRe)];
  const aliasDeclHits = aliasDecls.length; // 每处声明计 1 次命中，归类 other（声明 ≠ 断言）
  const aliases = aliasDecls.map((m) => m[1]);

  let prepared = text.split('');
  for (const d of aliasDecls) {
    for (let i = d.index; i < d.index + d[0].length; i += 1) prepared[i] = ' ';
  }
  text = prepared.join('');

  const tokens = [id, ...aliases];
  const hitRe = new RegExp(`\\b(?:${tokens.join('|')})\\b`, 'g');
  if (occurrenceCount(text, hitRe) === 0 && aliasDeclHits === 0) {
    return { total: 0, title: 0, exact: 0, weak: 0, other: 0 };
  }

  // ── ① 标题字面量：先定位、计数，再**掩码**（避免后续窗口把标题误算成断言）──────────
  const decls = [...text.matchAll(DECL_RE)].map((m) => ({
    start: m.index,
    // 匹配串 = 前缀 + 引号 + 正文 + 引号 ⇒ 正文起止由 m[2] 长度反推（避免依赖 indexOf 猜测）
    bodyStart: m.index + m[0].length - m[2].length - 1,
    bodyEnd: m.index + m[0].length - 1,
  }));
  let title = 0;
  for (const d of decls) title += occurrenceCount(text.slice(d.bodyStart, d.bodyEnd), hitRe);

  let masked = text.split('');
  for (const d of decls) {
    for (let i = d.bodyStart; i < d.bodyEnd; i += 1) masked[i] = ' ';
  }
  masked = masked.join('');
  const nonTitleTotal = occurrenceCount(masked, hitRe);
  const total = title + nonTitleTotal + aliasDeclHits;

  // ── ② 断言窗口：按起始位置升序，重叠者**合并**（避免嵌套 assert 重复计数）────────────
  const declStarts = decls.map((d) => d.start).sort((a, b) => a - b);
  const clipTo = (p) => {
    const next = declStarts.find((s) => s > p);
    return Math.min(p + WINDOW, next ?? text.length);
  };
  const windows = [];
  for (const m of masked.matchAll(ASSERT_RE)) {
    const start = m.index;
    const end = clipTo(start);
    const last = windows[windows.length - 1];
    if (last && start < last.end) last.end = Math.max(last.end, end); // 重叠 ⇒ 合并
    else if (start < end) windows.push({ start, end });
  }

  let exact = 0;
  let weak = 0;
  let inWindow = 0;
  for (const w of windows) {
    const slice = masked.slice(w.start, w.end);
    const n = occurrenceCount(slice, hitRe);
    if (n === 0) continue;
    inWindow += n;
    // 整码 = 窗口内含「值就是该码」的证据：① 整码字面量；② 指向它的常量别名标识符
    if (hasExactLiteral(slice, id) || aliases.some((a) => new RegExp(`\\b${a}\\b`).test(slice))) exact += n;
    else weak += n;
  }
  const other = nonTitleTotal - inWindow + aliasDeclHits;

  return { total, title, exact, weak, other };
}

/** 判别力自证：探测器必须证明自己能区分四类位置（否则它就是空转的"永远绿"工具）。 */
export function strengthSelfTest() {
  const ID = 'GATE_SELFTEST';
  const cases = [
    {
      name: '标题点名 ⇒ title 命中、exact 为 0',
      src: "test('should throw GATE_SELFTEST on empty input', () => {});",
      want: { total: 1, title: 1, exact: 0, weak: 0, other: 0 },
    },
    {
      name: 'assert.rejects 整码正则 ⇒ exact 命中',
      src: "await assert.rejects(() => f(), /GATE_SELFTEST/);",
      want: { total: 1, title: 0, exact: 1, weak: 0, other: 0 },
    },
    {
      name: '多行断言：期望值在下一行仍在窗口内 ⇒ exact 命中',
      src: [
        'test("noise", () => {});',
        'await assert.rejects(',
        '  () => f(),',
        '  { message: /GATE_SELFTEST/ },',
        ');',
      ].join('\n'),
      want: { total: 1, title: 0, exact: 1, weak: 0, other: 0 },
    },
    {
      name: 'assert 窗口内但非整码（只断言附带标记）⇒ weak 命中',
      src: "assert.equal(payload.causedBy, 'upstream-GATE_SELFTEST-ish');",
      want: { total: 1, title: 0, exact: 0, weak: 1, other: 0 },
    },
    {
      name: '夹具常量（既非标题也非断言）⇒ other 命中',
      src: "const EXPECTED = 'GATE_SELFTEST';",
      want: { total: 1, title: 0, exact: 0, weak: 0, other: 1 },
    },
    {
      name: '常量别名：断言用**标识符**而非字面量 ⇒ 仍须判为 exact',
      // 真实形态（本仓 R3-1 / R3-4 均如此）：文件顶部 `const CODE_X = 'GATE_X';`，
      // 断言里写 `{ message: CODE_X }` ⇒ 只看字面量会**漏判为真缺口**（假阴）。
      src: [
        "const CODE_X = 'GATE_SELFTEST';",
        'test("rejects on pending exec", async () => {',
        '  await assert.rejects(() => f(), { message: CODE_X });',
        '});',
      ].join('\n'),
      want: { total: 2, title: 0, exact: 1, weak: 0, other: 1 },
    },
    {
      name: '前缀锚定的消息正则（`/^CODE: …/`）⇒ 算整码断言',
      src: "await assert.rejects(() => f(), /^GATE_SELFTEST: flows\\.x not satisfied/);",
      want: { total: 1, title: 0, exact: 1, weak: 0, other: 0 },
    },
    {
      name: '自定义断言助手 `assertRejected(...)` ⇒ 算整码断言',
      src: "assertRejected(R.b, ['GATE_SELFTEST'], 'why');",
      want: { total: 1, title: 0, exact: 1, weak: 0, other: 0 },
    },
    {
      name: '窗口不许跨界到下一个 test 标题 ⇒ 标题命中不被计入 exact',
      src: [
        'await assert.match(msg, /whatever/);',
        "test('GATE_SELFTEST boundary', () => {});",
      ].join('\n'),
      want: { total: 1, title: 1, exact: 0, weak: 0, other: 0 },
    },
  ];

  const failures = [];
  for (const c of cases) {
    const got = classifyHits(c.src, ID);
    for (const k of ['total', 'title', 'exact', 'weak', 'other']) {
      if (got[k] !== c.want[k]) {
        failures.push(`${c.name}：${k} 期望 ${c.want[k]}，实得 ${got[k]}`);
      }
    }
  }
  if (failures.length > 0) {
    throw new Error('[strength] 判别力自证失败（探测器失去分辨率，后续结论不可信）：\n  - ' + failures.join('\n  - '));
  }
  return cases.length;
}
