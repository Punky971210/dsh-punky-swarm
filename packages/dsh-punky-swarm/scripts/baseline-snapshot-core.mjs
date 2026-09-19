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

// 批次 `core-techdebt-close-20260915` · lane e2：测试基线快照机制的**共享内核**。
//
// 为什么单独成文件：生成器（`scripts/baseline-snapshot.mjs`）与校验用例（`test/test-baseline.test.js`）
// 必须用**同一份**词法/统计口径——否则「生成时看到的数」与「校验时看到的数」会出现无法解释的漂移，
// 机制就失去可信度（这正是本 lane 要消灭的那类间接举证）。
//
// 位置说明：本文件是**共享库**而非可执行脚本（放 `scripts/` 是因为两个消费方一个在 `scripts/`、
// 一个在 `test/`，此处是共同父级；`lib/` 全树是 `tsc` 构建产物，手写 `.mjs` 不得混入）。
//
// 统计口径（**源码词法计数**，非运行器计数，理由见 lane 产物「设计取舍」节）：
//   - `tests`       : 顶层 `test(` 调用点（`test.todo(` 不计入，单列）
//   - `todos`       : `test.todo(` 调用点
//   - `asserts`     : `assert.<方法>(` 调用点（含 `assert.strictEqual(` 这类简写；`test` 回调面的 `t.` 形式不在此列）
//   - `lines`       : 文件物理行数（`\n` 切分）
//   - `blankLines`  : 去首尾空白后为空的行数（辅助表述「有效密度」，不参与门禁）
//
// 关键前提：**注释与字符串里的 `test(` / `assert.` 不计**——否则一段说明文字（本仓测试文件头部有大量
// 解释性注释）就能让计数虚高，机制对「删断言」反而失敏。故下面先做一遍轻量词法扫描把「代码区」取出来。
import fs from 'node:fs';
import path from 'node:path';

/** 基线文件名（仓根相对路径）。 */
export const BASELINE_REL_PATH = 'baselines/test-baseline.json';

/** 扫描根（仓根相对路径）。 */
export const TEST_DIR_REL_PATH = 'test';

/**
 * 词法扫描：把源码切成「代码区」与「非代码区」。
 * 逐字符走，识别 行注释 / 块注释 / 单引号 / 双引号 / 模板串 / 正则字面量；返回等长的布尔掩码。
 * **模板串的 `${...}` 插值体内部按代码处理**（回归修复：首版把整段反引号区当字符串屏蔽，
 * 而本仓测试常用 `assert.x(...)` 出现在 `` `${...}` `` 之后的行、或用反引号包住含 `{` 的文本，
 * 导致该行剩余部分被整体误屏蔽——实测 `test/gate-techdebt-red.test.js` 一度少计 38 条断言）。
 * 正则字面量与除号用「前一个有效代码字符」启发式区分（`=`/`(`/`,`/`[`/`!`/`&`/`|`/`?`/`{`/`;`/`:`/运算符 ⇒ 正则）。
 * 启发式不是 AST：本函数只服务「数调用点」，误判只会让个别正则体里的文本被当成代码或反之。
 */
export function codeMask(src) {
  const mask = new Uint8Array(src.length);

  /** 从 i 起跳过字符串/注释/正则/模板串，返回下一个待处理位置；不写 mask 的字符即「非代码区」。 */
  function skipAtom(start) {
    const c = src[start];
    const n = src[start + 1];
    if (c === '/' && n === '/') {
      let j = start;
      while (j < src.length && src[j] !== '\n') j += 1;
      return j;
    }
    if (c === '/' && n === '*') {
      let j = start + 2;
      while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j += 1;
      return j + 2;
    }
    if (c === '"' || c === "'") {
      let j = start + 1;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === c) return j + 1;
        if (src[j] === '\n') return j; // 未闭合字符串（语法错误源码）：止损，不吞掉后续行
        j += 1;
      }
      return j;
    }
    if (c === '`') return skipTemplate(start);
    if (c === '/') {
      const p = prevSigChar(start);
      const regexOk = p === '' || '=(,[{;:!&|?+-*%^~<>'.includes(p);
      if (regexOk) {
        let j = start + 1;
        let inClass = false;
        while (j < src.length) {
          if (src[j] === '\\') {
            j += 2;
            continue;
          }
          if (src[j] === '[') inClass = true;
          else if (src[j] === ']') inClass = false;
          else if (src[j] === '/' && !inClass) return j + 1;
          else if (src[j] === '\n') return j; // 未闭合 ⇒ 当除号处理，止损
          j += 1;
        }
        return j;
      }
    }
    return -1; // 不是「可跳过原子」⇒ 调用方按代码处理
  }

  /** 模板串：串体屏蔽，`${...}` 插值体回到代码扫描（支持嵌套模板串/对象字面量花括号）。 */
  function skipTemplate(start) {
    let j = start + 1;
    while (j < src.length) {
      if (src[j] === '\\') {
        j += 2;
        continue;
      }
      if (src[j] === '`') return j + 1;
      if (src[j] === '$' && src[j + 1] === '{') {
        j = scanCode(j + 2, true);
        continue;
      }
      j += 1;
    }
    return j;
  }

  function prevSigChar(at) {
    for (let k = at - 1; k >= 0; k -= 1) {
      if (mask[k] === 0) return ''; // 上一段是字符串/注释 ⇒ 视作表达式起点（正则更可能）
      const ch = src[k];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
      return ch;
    }
    return '';
  }

  /**
   * 代码区扫描。`stopAtBrace` = true 时在遇到**未配对** `}` 处停下（模板插值体边界），
   * 返回该 `}` 的下一位；普通根扫描返回源长度。
   */
  function scanCode(from, stopAtBrace) {
    let i = from;
    let depth = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '}' && stopAtBrace && depth === 0) return i + 1;
      if (ch === '{') {
        depth += 1;
        mask[i] = 1;
        i += 1;
        continue;
      }
      if (ch === '}') {
        depth -= 1;
        mask[i] = 1;
        i += 1;
        continue;
      }
      const skip = skipAtom(i);
      if (skip >= 0) {
        // `${` 之前已消费 `$`，此处只处理 `{` 之后的插值体起点
        i = skip;
        continue;
      }
      mask[i] = 1;
      i += 1;
    }
    return i;
  }

  scanCode(0, false);
  return mask;
}

/** 代码区文本（非代码区替换为等长空格，保持行列位置）。 */
export function codeOnly(src) {
  const mask = codeMask(src);
  let out = '';
  for (let i = 0; i < src.length; i += 1) out += mask[i] ? src[i] : ' ';
  return out;
}

const countMatches = (text, re) => (text.match(re) || []).length;

// ── 恒真形态静态启发式（批次 `engine-review-fix-a-20260915` · lane e6） ──────
//
// 为什么需要它（本 lane 的问题陈述）：原判红口径只看**断言调用数下降**，兜不住「等价替换」——
// 把 `assert.equal(x, 期望)` 改成 `assert.ok(true)`，调用数不变 ⇒ 0 漂移、用例全绿，护栏形同虚设。
// 故在词法口径上补一层**恒真形态**识别：命中计入 `tautologies` 指标，**高于基线即判红**。
//
// 口径边界（**启发式，不是 AST，也不是运行器语义**）：
//   - 只在**代码区**识别（复用 `codeOnly`）⇒ 注释 / 字符串 / 模板串文本里的同形字样不计，与 `asserts` 同款；
//   - 只认**源码字面**上恒真的形态：常量真值（`assert.ok(true)` / `assert.ok(1)` / `assert.ok(!false)`）、
//     同参自比（`assert.equal(a, a)` / `assert.strictEqual(o.a, o.a)`）、同字面量自比（`assert.equal('x', 'x')`）；
//     形如 `assert.ok(x > 0)` / `assert.ok(Boolean(1))` / `assert.ok(x === x)` 等需运行期求值的形态**不认**；
//   - 带副作用的表达式（`assert.equal(f(), f())`）**不认**：两次调用可能返回不同值，判它恒真是过度承诺；
//   - 判红是**相对基线**的（`tautologies` 上升即红），故存量恒真形态只需如实入库，不阻断面向前进。
/** 支持「同参自比」判定的断言方法（两侧同文本 ⇒ 求值必然相同）。 */
const EQ_METHODS = new Set(['equal', 'strictEqual', 'deepEqual', 'deepStrictEqual']);

/** 无副作用可复现表达式：标识符 / 成员链 / 简单下标 —— 同文本两处求值必然相同。 */
const REPRODUCIBLE_EXPR = /^[A-Za-z_$][\w$]*(?:(?:\.[A-Za-z_$][\w$]*)|(?:\[(?:[A-Za-z_$][\w$]*|\d+|'[^']*'|"[^"]*")\]))*$/;

/** 数值字面量（十/八/十六/二进制，允许小数与下划线分隔）。 */
const NUMBER_LITERAL = /^-?(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|\d[\d_]*(?:\.\d+)?|\d[\d_]*\.)$/;

/** 单引号/双引号字符串字面量（模板串不算：其插值体在代码区被单独处理，形态不稳定）。 */
const isStringLiteral = (t) => /^'(?:[^'\\]|\\.)*'$/.test(t) || /^"(?:[^"\\]|\\.)*"$/.test(t);

/** 源码字面上恒为真的常量文本：`true` / 非零数字 / 非空字符串 / `!false` 类否定常量。 */
function isConstTruthy(t) {
  if (t === 'true') return true;
  if (t === '!false' || t === '!0' || t === '!null' || t === '!undefined' || t === "!''" || t === '!""') return true;
  if (NUMBER_LITERAL.test(t)) return Number(t.replace(/_/g, '')) !== 0;
  return isStringLiteral(t) && t.length > 2; // 非空字符串字面量（`''` 恒假，不在此列）
}

/** 与 `open` 处的 `(` 配对的 `)` 下标（字符串/注释已屏蔽 ⇒ 括号是结构性的）；未闭合返回 -1。 */
function matchParen(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 顶层逗号切分实参：`{code, raw}` 双视图（code 屏蔽字符串/注释用于结构判定，raw 取原文用于字面量取值）。 */
function splitArgs(code, src, from, to) {
  const out = [];
  let depth = 0;
  let start = from;
  for (let i = from; i <= to; i += 1) {
    const ch = code[i];
    if (i === to || (ch === ',' && depth === 0)) {
      out.push({ code: code.slice(start, i), raw: src.slice(start, i) });
      start = i + 1;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
  }
  return out;
}

/** 实参的「可复现身份」：可复现表达式 / 数值字面量 / 整段字符串字面量；其余（含副作用调用）返回 null。 */
function reproducible(arg) {
  const codeT = arg.code.trim();
  if (codeT !== '') {
    if (NUMBER_LITERAL.test(codeT) || /^(true|false|null|undefined)$/.test(codeT)) {
      return { key: codeT, kind: 'eq-same-literal' };
    }
    if (REPRODUCIBLE_EXPR.test(codeT)) return { key: codeT, kind: 'eq-same-ident' };
    return null;
  }
  const rawT = arg.raw.trim();
  return isStringLiteral(rawT) ? { key: 'lit:' + rawT, kind: 'eq-same-literal' } : null;
}

/** 命中归类：返回形态名（`ok-const-true` / `eq-same-ident` / `eq-same-literal`）或 null（= 放行）。 */
function classifyTautology(method, args) {
  if (method === 'ok') {
    if (args.length < 1) return null;
    const codeT = args[0].code.trim();
    return isConstTruthy(codeT !== '' ? codeT : args[0].raw.trim()) ? 'ok-const-true' : null;
  }
  if (!EQ_METHODS.has(method) || args.length < 2) return null;
  const a = reproducible(args[0]);
  const b = reproducible(args[1]);
  if (!a || !b || a.key !== b.key) return null;
  return a.kind;
}

/**
 * 恒真形态扫描（代码区）。返回命中清单，供**计数**（`countSource.tautologies`）与**点名到行**两种用途。
 * @param {string} src 源码原文
 * @returns {Array<{line:number, kind:string, text:string}>}
 */
export function scanTautologies(src) {
  const code = codeOnly(src);
  const hits = [];
  const re = /(^|[^\w$.])assert\.([A-Za-z_$][\w$]*)\s*\(/g;
  let m = re.exec(code);
  while (m !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(code, open);
    if (close >= 0) {
      const kind = classifyTautology(m[2], splitArgs(code, src, open + 1, close));
      if (kind) {
        const at = m.index + m[1].length;
        hits.push({
          line: src.slice(0, at).split('\n').length,
          kind,
          text: src.slice(at, close + 1).replace(/\s+/g, ' ').trim(),
        });
      }
    }
    m = re.exec(code);
  }
  return hits;
}

/**
 * 单文件统计。`text` 已是**源码原文**；函数内部自行屏蔽注释/字符串。
 * `tautologies` 为恒真形态命中数（`tautologyHits` 为命中明细，只供点名，不入基线）。
 * @param {string} src 源码原文
 * @returns {{tests:number, todos:number, asserts:number, tautologies:number, lines:number, blankLines:number, tautologyHits:Array<{line:number,kind:string,text:string}>}}
 */
export function countSource(src) {
  const code = codeOnly(src);
  const rawLines = src.split('\n');
  const tautologyHits = scanTautologies(src);
  return {
    tests: countMatches(code, /(^|[^\w$.])test\s*\(/g),
    todos: countMatches(code, /(^|[^\w$.])test\.todo\s*\(/g),
    asserts: countMatches(code, /(^|[^\w$.])assert\.[A-Za-z_$][\w$]*\s*\(/g),
    tautologies: tautologyHits.length,
    lines: rawLines.length,
    blankLines: rawLines.filter((l) => l.trim() === '').length,
    tautologyHits,
  };
}

/** 仓根推导：从给定起点向上找含 `package.json` 的最近目录。 */
export function findRepoRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

/** 递归枚举 `test/` 下的测试文件（返回仓根相对 POSIX 路径，已排序）。 */
export function listTestFiles(root) {
  const base = path.join(root, TEST_DIR_REL_PATH);
  const out = [];
  const walk = (abs) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(abs, e.name);
      if (e.isDirectory()) walk(child);
      else if (e.name.endsWith('.test.js')) out.push(path.relative(root, child).split(path.sep).join('/'));
    }
  };
  walk(base);
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * 扫描整棵测试树。
 * 返回的 `files` / `totals` 只含**数值指标**（`tautologyHits` 明细单独挂在顶层：它是「点名到行」的
 * 辅助视图，不进基线 JSON，避免基线随注释/换行抖动）。
 * @param {string} root 仓根
 * @returns {{files: Record<string, {tests:number,todos:number,asserts:number,tautologies:number,lines:number,blankLines:number}>, totals: {files:number,tests:number,todos:number,asserts:number,tautologies:number,lines:number,blankLines:number}, tautologyHits: Record<string, Array<{line:number,kind:string,text:string}>>}}
 */
export function scanTree(root) {
  const files = {};
  const tautologyHits = {};
  const totals = { files: 0, tests: 0, todos: 0, asserts: 0, tautologies: 0, lines: 0, blankLines: 0 };
  for (const rel of listTestFiles(root)) {
    const stat = countSource(fs.readFileSync(path.join(root, rel), 'utf8'));
    const { tautologyHits: hits, ...counts } = stat;
    files[rel] = counts;
    if (hits.length > 0) tautologyHits[rel] = hits;
    totals.files += 1;
    totals.tests += stat.tests;
    totals.todos += stat.todos;
    totals.asserts += stat.asserts;
    totals.tautologies += stat.tautologies;
    totals.lines += stat.lines;
    totals.blankLines += stat.blankLines;
  }
  return { files, totals, tautologyHits };
}

/** 递归键排序（JSON.stringify 的 replacer 不排序，故先重建）。 */
export function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort((a, b) => a.localeCompare(b))) out[k] = sortKeysDeep(value[k]);
    return out;
  }
  return value;
}

/** 稳定序列化：键排序 + 两空格缩进 + 末尾 LF（UTF-8 无 BOM 由调用方保证）。 */
export function serializeBaseline(doc) {
  return JSON.stringify(sortKeysDeep(doc), null, 2) + '\n';
}

/** 读写基线（写口只在生成器/更新通道调用）。 */
export function readBaseline(root, relPath = BASELINE_REL_PATH) {
  return JSON.parse(fs.readFileSync(path.join(root, relPath), 'utf8'));
}

export function writeBaseline(root, doc, relPath = BASELINE_REL_PATH) {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, serializeBaseline(doc), 'utf8');
  return abs;
}

/** 变更清单（`--update` 留痕用）：返回**逐文件**与**总量**两级 delta，只列真正变化的项。 */
export function diffBaseline(before, after) {
  const metrics = ['tests', 'todos', 'asserts', 'tautologies', 'lines', 'blankLines'];
  const keys = [...new Set([...Object.keys(before.files || {}), ...Object.keys(after.files || {})])].sort((a, b) =>
    a.localeCompare(b),
  );
  const files = [];
  const totals = {};
  for (const m of metrics) totals[m] = (after.totals?.[m] ?? 0) - (before.totals?.[m] ?? 0);
  for (const rel of keys) {
    const b = before.files?.[rel];
    const a = after.files?.[rel];
    const delta = {};
    let changed = false;
    for (const m of metrics) {
      const d = (a?.[m] ?? 0) - (b?.[m] ?? 0);
      if (d !== 0) {
        delta[m] = d;
        changed = true;
      }
    }
    if (!changed) continue;
    files.push({ file: rel, kind: b === undefined ? 'added' : a === undefined ? 'removed' : 'changed', delta });
  }
  return { files, totals };
}

/**
 * 校验：把「当前扫描结果」与基线对照。
 *
 * 判红口径（规格 §2.2「断言数下降即红」+ 本 lane B5「等价替换即红」）：
 *   - **断言总数**低于基线 ⇒ `ok:false`（本次交付/重构确实少了一条断言，不论发生在哪个文件）；
 *   - **恒真形态命中数**高于基线 ⇒ `ok:false`（等价替换绕过：调用数不变，但把断言写成了恒真）；
 *   - 用例数/`test.todo` 数下降只进 `warnings`（合法重构会合并/拆分用例，硬红会误报）；
 *   - 文件新增/重命名不算红（**理由**：文件名是组织方式不是覆盖度；拆文件后断言总数不变 ⇒ 不该红）。
 * 逐文件 delta 一并返回，供调用方打印「谁少了多少 / 谁新增了恒真断言」。
 */
export function compareBaseline(baseline, current) {
  const diff = diffBaseline(baseline, current);
  const baseAsserts = baseline.totals?.asserts ?? 0;
  const curAsserts = current.totals?.asserts ?? 0;
  const baseTests = baseline.totals?.tests ?? 0;
  const curTests = current.totals?.tests ?? 0;
  const baseTaut = baseline.totals?.tautologies ?? 0;
  const curTaut = current.totals?.tautologies ?? 0;
  const warnings = [];
  for (const d of diff.files) {
    if (d.kind === 'added' || d.kind === 'removed') continue;
    if ((d.delta.tests ?? 0) < 0) warnings.push(`${d.file}: 用例数 ${d.delta.tests}`);
    if ((d.delta.todos ?? 0) < 0) warnings.push(`${d.file}: test.todo 数 ${d.delta.todos}`);
  }
  return {
    ok: curAsserts >= baseAsserts && curTaut <= baseTaut,
    asserts: { baseline: baseAsserts, current: curAsserts, delta: curAsserts - baseAsserts },
    tautologies: { baseline: baseTaut, current: curTaut, delta: curTaut - baseTaut },
    tests: { baseline: baseTests, current: curTests, delta: curTests - baseTests },
    filesChanged: diff.files,
    warnings,
  };
}
