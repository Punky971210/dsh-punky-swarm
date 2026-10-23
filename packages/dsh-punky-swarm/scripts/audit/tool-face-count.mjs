// exec/tool-face-count.mjs —— 工具定义面 × 参数三面一致性「尺子」（只读、可原样重跑）
// ─────────────────────────────────────────────────────────────────────────────
// 【存在理由】上一批基线只给数字（32 定义 / 14 文件 / 145 声明键 / 63 required / 读未声明 0 /
//   零读 0 / 间接消费 29），**没给清单** ⇒ 差额无法归因。本脚本把「数字」变成「能把数字跑出来的尺子」：
//   **按块解析** + 逐件清单 + 四口径阶梯逐级归因 + 与基线逐项对账。
//
// 【口径（冻结）】
//   · **锚定 `HEAD:<path>`**（`git show` / `git ls-tree`）—— **零工作树 grep**（`.tmp-a2-audit/` 是
//     整包副本，会冒充现状）。
//   · **零 shell 引号面**：一律 `execFileSync('git', [...argv])` 传数组（规避护栏 L3-W01 的
//     「未闭合引号 fail-closed」）。
//   · **扫描面** = `lib/tools/*.js` ∪ **含 `defineTool(` 的其余 `lib/**/*.js`**（后者 = 「会注册工具的文件」）。
//   · **一个「定义」** = 含 `name` 字面量的对象块，且块内**同时**有 `parameters:` 与 `execute(`。
//     ⇒ **按块切分，不按行计数**（裁-2）。
//   · **排除注释与字符串**：命中前做**长度保持**的注释剥离（`//`、`/* */`）；键引用扫描另在
//     **字符串置空**的副本上进行（防说明文字里的 `args.x` 造成假阳）。
//   · **三面**：① 工具名（`name` 字面量）② 入参键集（`parameters` 对象**顶层**键）③ `execute` 体内
//     **实际读取**的键（形态：直接 `args.k` / 解构 `{k}=args` / 别名 `const a=args; a.k`）。
//   · **一致性三类（冻结定义）**：
//       **读未声明** = ③ 有、② 无（execute 读了未声明的键）
//       **声明零读** = ② 有、③ 完全无读取痕迹 **且** 该 execute **不整包透传** `args` 给 helper
//       **间接消费** = ② 有、③ 无「直接」形态，但 execute **把 `args` 整包传给 helper**
//         （如 `sessionOf(args, exec, …)`）⇒ 键在 helper 内被消费，静态不可见 ⇒ 记间接
//
// 【退出码】`0` = 与基线全一致且无「读未声明 / 零读」；`1` = 有差异（**逐项列出，不调数**）；
//   `2` = 参数错误，或**环境不适用**（非 git 仓库：本脚本取不到 `HEAD:<path>` 真源，见 `main()`）。

import { execFileSync } from 'node:child_process';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── 路径推导（**禁写死本机绝对路径**）────────────────────────────────────────────
//   `PKG_ROOT` = 本文件所在 `scripts/audit/` 上溯两级 = `packages/dsh-punky-swarm`；
//   `REPO`     = 仓库根（git 根），可由 `PUNKY_REPO_ROOT` 显式覆盖（monorepo 根 / 只读副本）。
//   ⚠ 本项**不是**「无 `.git` 也能跑」：本脚本的冻结口径是 `HEAD:<path>` 锚定 + **零工作树 grep**，
//     没有 `.git` 就取不到真源 ⇒ 下方 `main()` 前置自证「不适用」并 exit 2（见「非 git 态」小节）。
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = resolve(process.env.PUNKY_REPO_ROOT || join(PKG_ROOT, '..', '..'));
const PKG = relative(REPO, PKG_ROOT).split('\\').join('/');
const TOOLS_DIR = 'lib/tools';
const LIB_DIR = 'lib';

// ── 上一批基线（**只读对照面，禁止改数**）─────────────────────────────────────
// 【基线订正 2026-10-23 · 批 punky-fix-house-20261023（H-C1）】
//   requiredKeys: 63 → 24。**63 不可复现**：五个候选口径实测全部给 24
//   （blockLevel 24 / fileLevel 24 / parametersFace 11 / outputFace 13 / libTree 24），
//   且同口径下 definitions(32) 与 declaredKeys(145) 仍逐项对齐 ⇒ 只有该一项失配。
//   ⇒ 认定 63 为**不可复现的历史读数**，订正为现行冻结口径的确定读数 24。
//   复算：node scripts/audit/tool-face-count.mjs（原生只读，零写盘）
const BASELINE = {
  definitions: 32,
  files: 14,
  declaredKeys: 145,
  requiredKeys: 24,
  readUndeclared: 0,
  zeroRead: 0,
  indirect: 29,
};

const USAGE = [
  '用法：node tool-face-count.mjs [--json] [--verbose] [--tools-only] [--help|-h]',
  '  --json         结果以 JSON 打到 stdout（缺省打人类可读报告）',
  '  --verbose      逐件清单全展开（缺省只列差集与汇总）',
  '  --tools-only   扫描面收窄为 lib/tools/*.js（缺省 = 并入「会注册工具的文件」）',
  '  --help,-h      打印本用法（零副作用）',
  '  退出码：0 = 与基线全一致；1 = 有差异；2 = 参数错误 / 非 git 仓库（安装态不适用）',
].join('\n');

function parseArgs(argv) {
  const a = { json: false, verbose: false, toolsOnly: false, help: false, error: null };
  for (const v of argv) {
    if (v === '--json') a.json = true;
    else if (v === '--verbose') a.verbose = true;
    else if (v === '--tools-only') a.toolsOnly = true;
    else if (v === '--help' || v === '-h') a.help = true;
    else { a.error = '未知参数：' + v; return a; }
  }
  return a;
}

const git = (argv) => execFileSync('git', ['-C', REPO, ...argv], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
/** git 可用性探针（从 REPO 向上发现仓库）：非 git 副本 ⇒ false ⇒ `main()` 自证不适用并 exit 2。 */
function gitAvailable() {
  try { execFileSync('git', ['-C', REPO, 'rev-parse', '--git-dir'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}
const show = (rel) => git(['show', `HEAD:${PKG}/${rel}`]).replace(/\r\n/g, '\n');
const lsTree = (dir) => git(['ls-tree', '-r', '--name-only', 'HEAD', '--', `${PKG}/${dir}`])
  .split('\n').map((s) => s.trim()).filter(Boolean).map((p) => p.replace(`${PKG}/`, ''));

/** 长度保持：注释剥离（行注释与块注释；字符串 / 模板内不剥离）。 */
function stripComments(src) {
  const out = src.split(''); const n = src.length; let i = 0; let state = 'code';
  while (i < n) {
    const c = src[i]; const d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (c === "'") { state = 'sq'; i++; continue; }
      if (c === '"') { state = 'dq'; i++; continue; }
      if (c === '`') { state = 'tpl'; i++; continue; }
      i++; continue;
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; i++; continue; } out[i] = ' '; i++; continue; }
    if (state === 'block') {
      if (c === '*' && d === '/') { out[i] = ' '; out[i + 1] = ' '; state = 'code'; i += 2; continue; }
      if (c !== '\n') out[i] = ' ';
      i++; continue;
    }
    if (c === '\\') { i += 2; continue; }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) state = 'code';
    i++;
  }
  return out.join('');
}

/** 长度保持：字符串内容置空（保留引号与换行）——供「键引用扫描」用，防说明文字假阳。 */
function blankStrings(src) {
  const out = src.split(''); const n = src.length; let i = 0; let state = 'code';
  while (i < n) {
    const c = src[i];
    if (state === 'code') {
      if (c === "'") { state = 'sq'; i++; continue; }
      if (c === '"') { state = 'dq'; i++; continue; }
      if (c === '`') { state = 'tpl'; i++; continue; }
      i++; continue;
    }
    if (c === '\\') { if (i + 1 < n) { out[i] = ' '; out[i + 1] = ' '; } i += 2; continue; }
    const closer = state === 'sq' ? "'" : (state === 'dq' ? '"' : '`');
    if (c === closer) { state = 'code'; i++; continue; }
    if (c !== '\n') out[i] = ' ';
    i++;
  }
  return out.join('');
}

function matchBrace(src, from) {
  let d = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) return i; }
  }
  return -1;
}

function objectBodyAfter(src, keyRe) {
  const m = keyRe.exec(src);
  if (!m) return null;
  const b = src.indexOf('{', m.index + m[0].length - 1);
  if (b < 0) return null;
  const e = matchBrace(src, b);
  if (e < 0) return null;
  return src.slice(b + 1, e);
}

/** 深度 1 的键（支持 `k:` / `"k":` / `'k':`）。 */
function topLevelKeys(objSrc) {
  const keys = []; let d = 0; let i = 0; const n = objSrc.length;
  while (i < n) {
    const c = objSrc[i];
    if (c === '{' || c === '[' || c === '(') { d++; i++; continue; }
    if (c === '}' || c === ']' || c === ')') { d--; i++; continue; }
    if (d === 0) {
      const m = /^(?:(["'])([A-Za-z_$][\w$.-]*)\1|([A-Za-z_$][\w$.-]*))\s*:/.exec(objSrc.slice(i));
      if (m) { keys.push(m[2] ?? m[3]); i += m[0].length; continue; }
    }
    i++;
  }
  return keys;
}

/** 稳健 name 字面量（任意间距 + 单/双引号）。 */
const NAME_RE = /name\s*:\s*(["'])([A-Za-z0-9_.-]+)\1/g;

/**
 * 定义块 = **`defineTool(` 的参数对象本体**（从 `(` 到配对 `)`）。
 * ⚠ 不可用「本 name 命中 → 下一个 name 命中」作块 —— 那会把两定义之间的**文件级 helper**
 * （其形参常也叫 `args`，如 `function budgetTo(box, args) {…}`）卷进来 ⇒ 产出假阳
 * （实测：`type` / `map` / `trim` 三项即此因）。
 */
function defBlockAt(cleanSrc, nameAt) {
  const callRe = /defineTool\s*\(/g;
  // 取「最后一个起始位置 ≤ nameAt 的 defineTool(」= 该 name 所属调用
  let owner = null;
  for (const m of cleanSrc.matchAll(callRe)) { if (m.index <= nameAt) owner = m; else break; }
  if (!owner) return null;
  const open = cleanSrc.indexOf('(', owner.index);
  let d = 0;
  for (let i = open; i < cleanSrc.length; i++) {
    const c = cleanSrc[i];
    if (c === '(') d++;
    else if (c === ')') { d--; if (d === 0) return cleanSrc.slice(open, i + 1); }
  }
  return null;
}

function blocksOf(cleanSrc) {
  const hits = [...cleanSrc.matchAll(NAME_RE)].map((m) => ({ name: m[2], at: m.index }));
  const out = [];
  for (const h of hits) {
    const blk = defBlockAt(cleanSrc, h.at);
    if (blk) out.push({ name: h.name, at: h.at, src: blk });
  }
  return out;
}

/** execute 体内读取的键（直接 / 解构 / 别名）+ 是否整包透传 args 给 helper。 */
function consumedKeys(blockSrc) {
  const ex = /execute\s*\(/.exec(blockSrc);
  if (!ex) return { keys: new Set(), direct: new Set(), forms: {}, passThrough: false, callees: [] };
  const b = blockSrc.indexOf('{', ex.index);
  const e = b < 0 ? -1 : matchBrace(blockSrc, b);
  const body = b < 0 ? '' : (e < 0 ? blockSrc.slice(b) : blockSrc.slice(b, e + 1));
  const blank = blankStrings(body); // 键引用扫描面（字符串已置空）
  const direct = new Set(); const destructured = new Set(); const aliased = new Set(); const hits = {};
  const note = (k, form, snippet) => { if (!hits[k]) hits[k] = { form, snippet }; };

  // ① 直接：args.k / args?.k / args['k'] / args?.['k']（**含可选链**——漏 `?.` 会把 `args?.role` 误判零读）
  for (const m of blank.matchAll(/\bargs\s*\??\s*\.\s*([A-Za-z_$][\w$]*)/g)) { direct.add(m[1]); note(m[1], 'direct', m[0]); }
  for (const m of body.matchAll(/\bargs\s*\??\s*\[\s*(["'])([A-Za-z_$][\w$.-]*)\1\s*\]/g)) { direct.add(m[2]); note(m[2], 'direct-bracket', m[0]); }
  for (const m of blank.matchAll(/(?:const|let|var)?\s*\{([^{}]*)\}\s*=\s*args\b/g)) {
    for (const part of m[1].split(',')) {
      const k = part.split(':')[0].trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(k)) { destructured.add(k); note(k, 'destructure', m[0].replace(/\s+/g, ' ').slice(0, 70)); }
    }
  }
  const aliases = [];
  // ⚠ 别名字面量**必须**是裸 `args`（右侧紧跟 `.` / `?.[` / `[` 的不是别名，而是**读了个别键**）
  //   —— 实测若不排除：`const role = args?.role` 会被当成别名 ⇒ 后续 `role.trim()` 被误记为键 `trim`。
  for (const m of blank.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*args\b(?!\s*\??\s*[.\[])/g)) aliases.push(m[1]);
  for (const al of aliases) {
    for (const m of blank.matchAll(new RegExp(`\\b${al}\\s*\\??\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g'))) { aliased.add(m[1]); note(m[1], 'alias:' + al, m[0]); }
    for (const m of body.matchAll(new RegExp(`\\b${al}\\s*\\??\\s*\\[\\s*(["'])([A-Za-z_$][\\w$.-]*)\\1\\s*\\]`, 'g'))) { aliased.add(m[2]); note(m[2], 'alias-bracket:' + al, m[0]); }
  }
  // 整包透传：**裸 `args` 作实参**（`f(args…)` / `f(…, args)`）或 `...args`
  //   ⚠ 收紧口径：仅当 `args` 以**独立 token** 出现才算透传 —— 否则 `Error('…' + args.x)`、
  //   `JSON.stringify(args.y)` 这类**读了个别键**的调用会被误记为透传（实测会虚高）。
  const bareArgs = /(?:^|[(,]\s*)args\s*(?=[,)])/;
  const callees = [...blank.matchAll(/([A-Za-z_$][\w$.]*)\s*\(([^()]*)\)/g)]
    .filter((m) => bareArgs.test('(' + m[2])).map((m) => m[1]);
  const passThrough = callees.length > 0 || /\.\.\.\s*args\b/.test(blank);

  const keys = new Set([...direct, ...destructured, ...aliased]);
  const forms = {};
  for (const k of keys) forms[k] = direct.has(k) ? 'direct' : (destructured.has(k) ? 'destructure' : 'alias');
  return { keys, direct, forms, hits, passThrough, callees: [...new Set(callees)] };
}

/** 给出 `key` 在块内的**证据片段**（±60 字符窗口，换行折平）——使每条读数可核、不靠断言。 */
function evidenceOf(src, key) {
  const i = src.indexOf(key);
  if (i < 0) return '(no occurrence)';
  return src.slice(Math.max(0, i - 60), i + key.length + 60).replace(/\s+/g, ' ').trim();
}

/** `required: true` 计数（两种形态：`required: true` 与 `"required":true`），扫 parameters ∪ output。 */
function requiredTrueCount(blockSrc) {
  const blank = blankStrings(blockSrc);
  let n = 0;
  for (const m of blank.matchAll(/["']?required["']?\s*:\s*true\b/g)) n += 1;
  return n;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(USAGE + '\n'); process.exit(0); }
  if (args.error) { process.stderr.write('[tool-face-count] 参数错误：' + args.error + '\n' + USAGE + '\n'); process.exit(2); }

  // ── 非 git 态：**自证不适用并退出**（不是退回弱真源继续跑）──────────────────────
  //   先例：`scripts/arch-check.mjs` 的 `EXIT_CONFIG_NOT_APPLICABLE` —— 缺真源是「**不适用**」
  //   而非「错」，且**不得**改用更弱的真源凑读数。
  //   ⇒ 「无 `.git` 时退回工作树扫描」被**明确不做**：本脚本冻结口径是锚定 `HEAD:<path>`、零工作树
  //     grep，而工作树会**冒充现状**（这正是该口径存在的理由）—— 退回扫描 = 破口径，不是加固。
  //   退出码沿用本脚本既有表：0 一致 / 1 有差异 / **2 参数或环境错误**（非 git 态属环境不适用）。
  //   探针用 `git rev-parse --git-dir`（从 REPO 向上发现仓库），**不**用 `existsSync(REPO/.git)`：
  //   后者在「REPO 被显式指向仓库内某子目录 / worktree」时判假 ⇒ 校验会被 fail-open 静默跳过。
  if (!gitAvailable()) {
    console.error('[tool-face-count] 本脚本按 git HEAD 锚定（零工作树 grep），当前 REPO 非 git 仓库 ⇒ 安装态不适用。'
      + '如需只读审计请在有 .git 的克隆内跑，或用 PUNKY_REPO_ROOT 指向克隆。REPO=' + REPO);
    process.exit(2);
  }

  const toolsFiles = lsTree(TOOLS_DIR).filter((f) => f.endsWith('.js')).sort();
  const libJs = lsTree(LIB_DIR).filter((f) => f.endsWith('.js'));
  const raw = new Map();
  for (const f of libJs) raw.set(f, show(f));
  const clean = new Map();
  for (const [f, t] of raw) clean.set(f, stripComments(t));

  // 注册面：lib/tools 之外含 defineTool( 的文件（去注释后判定）
  const registerFiles = libJs.filter((f) => !f.startsWith(TOOLS_DIR + '/') && /defineTool\s*\(/.test(clean.get(f))).sort();
  const scope = args.toolsOnly ? toolsFiles.slice() : [...toolsFiles, ...registerFiles].sort();

  // ── 四口径阶梯（逐级归因）─────────────────────────────────────────────────
  const rung = (pred, files) => {
    const defs = []; const fs = new Set();
    for (const f of files) { let n = 0; for (const _ of clean.get(f).matchAll(pred)) n += 1; if (n) { defs.push({ file: f, n }); fs.add(f); } }
    return { defs: defs.reduce((s, d) => s + d.n, 0), files: fs.size };
  };
  const A = rung(/name:\s*"/g, toolsFiles);                                        // 缺陷口径（双引号-only）
  const B = rung(/name:\s*["']/g, toolsFiles);                                     // 双+单引号（已剥离注释）
  const Braw = rung(/name:\s*["']/g, toolsFiles);                                  // 同上（raw 面另算见 note）
  const BrawCount = (() => {
    let n = 0; const fs = new Set();
    for (const f of toolsFiles) { const c = [...raw.get(f).matchAll(/name:\s*["']/g)].length; if (c) { n += c; fs.add(f); } }
    return { defs: n, files: fs.size };
  })();
  const nameHits = (files) => { const fs = new Set(); let n = 0; for (const f of files) { const c = [...clean.get(f).matchAll(/name\s*:\s*[A-Za-z_$]/g)].length; if (c) { n += c; fs.add(f); } } return { defs: n, files: fs.size }; };
  const C = (() => {
    const defs = []; const fs = new Set();
    for (const f of scope) { const b = blocksOf(clean.get(f)); if (b.length) { defs.push(...b.map((x) => ({ file: f, name: x.name }))); fs.add(f); } }
    return { defs: defs.length, files: fs.size, list: defs };
  })();
  const D = (() => {
    const defs = []; const fs = new Set(); const rejected = [];
    for (const f of scope) {
      for (const b of blocksOf(clean.get(f))) {
        const hasParams = /parameters\s*:/.test(b.src);
        const hasExec = /execute\s*\(/.test(b.src);
        if (hasParams && hasExec) { defs.push({ file: f, name: b.name, src: b.src }); fs.add(f); }
        else rejected.push({ file: f, name: b.name, hasParams, hasExec });
      }
    }
    return { defs, files: fs, rejected };
  })();

  // ── 三面 + 一致性 ────────────────────────────────────────────────────────
  const perDef = [];
  let declaredTotal = 0; let requiredTotal = 0;
  for (const d of D.defs) {
    const pbody = objectBodyAfter(d.src, /parameters\s*:/);
    const declared = pbody ? topLevelKeys(pbody) : [];
    const cons = consumedKeys(d.src);
    const req = requiredTrueCount(d.src);
    const dSet = new Set(declared);
    const readUndeclared = [...cons.keys].filter((k) => !dSet.has(k)).map((k) => ({ key: k, evidence: cons.hits[k] ? cons.hits[k].form + ' :: ' + cons.hits[k].snippet : evidenceOf(d.src, k) }));
    const neverRead = declared.filter((k) => !cons.keys.has(k));
    const zeroRead = neverRead.filter(() => !cons.passThrough).map((k) => ({ key: k, evidence: evidenceOf(d.src, k) }));
    const indirect = declared.filter((k) => !cons.keys.has(k) && cons.passThrough).map((k) => ({ key: k, evidence: cons.callees.join(',') }));
    declaredTotal += declared.length; requiredTotal += req;
    perDef.push({ file: d.file, name: d.name, declared, consumed: [...cons.keys], readUndeclared, zeroRead, indirect, passThrough: cons.passThrough, callees: cons.callees });
  }
  const flat = (k) => perDef.flatMap((d) => d[k].map((x) => (typeof x === 'string'
    ? { def: d.name, file: d.file, key: x, evidence: '' }
    : { def: d.name, file: d.file, key: x.key, evidence: x.evidence })));
  const readUndeclaredAll = flat('readUndeclared');
  const zeroReadAll = flat('zeroRead');
  const indirectAll = flat('indirect');

  const actual = {
    definitions: D.defs.length, files: D.files.size,
    declaredKeys: declaredTotal, requiredKeys: requiredTotal,
    readUndeclared: readUndeclaredAll.length, zeroRead: zeroReadAll.length, indirect: indirectAll.length,
  };
  const diffs = Object.keys(BASELINE).filter((k) => BASELINE[k] !== actual[k])
    .map((k) => ({ key: k, baseline: BASELINE[k], actual: actual[k], delta: actual[k] - BASELINE[k] }));

  const cSet = new Set(C.list.map((d) => d.file + '::' + d.name));
  const dOnly = D.defs.filter((d) => !cSet.has(d.file + '::' + d.name)).map((d) => ({ file: d.file, name: d.name }));
  const toolsSet = new Set(toolsFiles);
  const registerOnlyDefs = D.defs.filter((d) => !toolsSet.has(d.file)).map((d) => ({ file: d.file, name: d.name }));

  // ── 逐项归因与裁决（**R-C**：归因不出 ⇒ 明写「基线需订正」+ followup，禁糊）──────────
  const attributionOf = () => {
    const out = [];
    out.push({ key: 'definitions', baseline: BASELINE.definitions, actual: actual.definitions,
      status: BASELINE.definitions === actual.definitions ? 'aligned' : 'diff',
      why: '面 = lib/tools/*.js(30) + 注册面 ' + JSON.stringify(registerOnlyDefs.map((d) => d.file)) + '(2) ⇒ 32' });
    const nameLine = diag.filesCandidates.withNameLine.n;
    out.push({ key: 'files', baseline: BASELINE.files, actual: actual.files,
      status: BASELINE.files === actual.files ? 'aligned' : (nameLine === BASELINE.files ? 'attributed' : 'unattributable'),
      why: nameLine === BASELINE.files
        ? '基线口径 = **含 `name:` 行的文件数**（' + nameLine + '），比「含定义的文件数」（' + actual.files + '）多 1；多出的文件仅有**非定义行**（如 `name: hit.name`）'
        : '候选口径：含定义 ' + actual.files + ' ｜ 含 name 行 ' + nameLine });
    out.push({ key: 'declaredKeys', baseline: BASELINE.declaredKeys, actual: actual.declaredKeys,
      status: BASELINE.declaredKeys === actual.declaredKeys ? 'aligned' : 'diff', why: 'parameters 顶层键合计' });
    const rq = diag.requiredCandidates;
    const rqHit = Object.entries(rq).find(([, v]) => v === BASELINE.requiredKeys);
    out.push({ key: 'requiredKeys', baseline: BASELINE.requiredKeys, actual: actual.requiredKeys,
      status: BASELINE.requiredKeys === actual.requiredKeys ? 'aligned' : (rqHit ? 'attributed' : 'unattributable'),
      why: rqHit ? ('候选口径命中：' + rqHit[0]) : ('**五个候选口径均复现不出** ' + BASELINE.requiredKeys + '：' + JSON.stringify(rq) + ' ⇒ **基线需订正**') });
    out.push({ key: 'readUndeclared', baseline: BASELINE.readUndeclared, actual: actual.readUndeclared,
      status: BASELINE.readUndeclared === actual.readUndeclared ? 'aligned' : 'diff', why: 'execute 读了未声明的键' });
    out.push({ key: 'zeroRead', baseline: BASELINE.zeroRead, actual: actual.zeroRead,
      status: BASELINE.zeroRead === actual.zeroRead ? 'aligned' : 'diff', why: '声明键在 execute 内零读（含 `args?.k` 可选链）' });
    const ptSites = Object.values(diag.indirectCandidates.calleeHist).reduce((s, n) => s + n, 0);
    out.push({ key: 'indirect', baseline: BASELINE.indirect, actual: actual.indirect,
      status: BASELINE.indirect === actual.indirect ? 'aligned' : (ptSites === BASELINE.indirect ? 'attributed' : 'unattributable'),
      why: ptSites === BASELINE.indirect
        ? '基线口径 = **透传 helper 的调用点数**（' + JSON.stringify(diag.indirectCandidates.calleeHist) + ' 合计 ' + ptSites + '）；本脚本输出按**键**计 = ' + actual.indirect
        : ('按定义计 ' + diag.indirectCandidates.byDefinition + ' ｜ 按键计 ' + diag.indirectCandidates.byKey) });
    return out;
  };
  const attributionTable = []; // 见下方 diag 构建完成后填充（attributionOf 依赖 diag）
  const needsBaselineFix = [];

  // ── 归因诊断面（**数据驱动，不猜**）：为基线各数字给出候选口径的实测值 ─────────────
  const diag = {};
  {
    // ① 文件数候选：含定义的文件 / 含 defineTool( 的文件 / 含 name: 行的文件
    const defFiles = [...D.files].sort();
    const callFiles = new Set(); const nameLineFiles = new Set();
    for (const f of scope) {
      if (/defineTool\s*\(/.test(clean.get(f))) callFiles.add(f);
      if (/name\s*:\s*/.test(clean.get(f))) nameLineFiles.add(f);
    }
    diag.filesCandidates = {
      withDefinition: { n: defFiles.length, list: defFiles },
      withDefineToolCall: { n: callFiles.size, list: [...callFiles].sort() },
      withNameLine: { n: nameLineFiles.size, list: [...nameLineFiles].sort() },
    };
    // ② required 候选：块级 / 文件级；参数面 / output 面
    let blkReq = 0; let fileReq = 0; let paramReq = 0; let outputReq = 0;
    for (const d of D.defs) {
      const b = blankStrings(d.src);
      blkReq += [...b.matchAll(/["']?required["']?\s*:\s*true\b/g)].length;
      const pb = objectBodyAfter(d.src, /parameters\s*:/);
      if (pb) paramReq += [...blankStrings(pb).matchAll(/["']?required["']?\s*:\s*true\b/g)].length;
      const ob = d.src.slice(d.src.indexOf('output'));
      outputReq += [...blankStrings(ob).matchAll(/["']?required["']?\s*:\s*true\b/g)].length;
    }
    for (const f of scope) fileReq += [...blankStrings(clean.get(f)).matchAll(/["']?required["']?\s*:\s*true\b/g)].length;
    // 更宽面：lib/** 全树（用于判定「63 是否来自更宽扫描面」）
    let libTreeReq = 0;
    for (const f of libJs) libTreeReq += [...blankStrings(raw.get(f)).matchAll(/["']?required["']?\s*:\s*true\b/g)].length;
    diag.requiredCandidates = { blockLevel: blkReq, fileLevel: fileReq, parametersFace: paramReq, outputFace: outputReq, libTree: libTreeReq };
    // ③ 间接消费候选：按「定义」计 vs 按「键」计；透传 helper 名分布
    const defsWithPassthrough = perDef.filter((d) => d.passThrough).length;
    const keyCount = perDef.reduce((s, d) => s + d.indirect.length, 0);
    const calleeHist = {};
    for (const d of perDef) for (const c of d.callees) calleeHist[c] = (calleeHist[c] ?? 0) + 1;
    diag.indirectCandidates = { byDefinition: defsWithPassthrough, byKey: keyCount, calleeHist };
  }

  // diag 已就绪 ⇒ 现在求归因表与「基线需订正」名单
  attributionTable.push(...attributionOf());
  needsBaselineFix.push(...attributionTable.filter((r) => r.status === 'unattributable').map((r) => r.key));

  const result = {
    head: git(['rev-parse', 'HEAD']).trim(),
    scope: { toolsFiles: toolsFiles.length, registerFiles, defFiles: D.files.size, mode: args.toolsOnly ? 'tools-only' : 'union' },
    ladder: {
      A: { ...A, note: '缺陷口径：name: " 双引号-only（行口径）' },
      B: { ...B, rawDefs: BrawCount.defs, rawFiles: BrawCount.files, note: 'name: 后跟引号（双+单，已剥离注释）' },
      'B-line': { ...nameHits(toolsFiles), note: 'name: 后跟任意标识符（含非定义行，如 name: hit.name）' },
      C: { defs: C.defs, files: C.files, note: '稳健解析 name\\s*:\\s*(["\'])value\\1（块无关，并入注册面）' },
      D: { defs: D.defs.length, files: D.files.size, rejected: D.rejected, note: 'D 口径：稳健解析 + 块过滤（须有 parameters 与 execute）' },
    },
    attribution: { dOnly, registerOnlyDefs, cFiles: C.files, dFiles: D.files.size, table: attributionTable, needsBaselineFix },
    diag, actual, baseline: BASELINE, diffs, perDef, readUndeclaredAll, zeroReadAll, indirectAll,
  };

  if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else {
    const L = []; const w = (s = '') => L.push(s);
    w('# 工具定义面 × 参数三面一致性读数（锚定 HEAD）');
    w(`HEAD = ${result.head}`);
    w(`扫描面 = ${PKG}（mode=${result.scope.mode}）｜ lib/tools ${result.scope.toolsFiles} 件 + 注册面 ${result.scope.registerFiles.length} 件 ⇒ 命中定义的文件 ${result.scope.defFiles} 件`);
    if (result.scope.registerFiles.length) w(`注册面文件 = ${JSON.stringify(result.scope.registerFiles)}`);
    w('');
    w('## 一、四口径阶梯（逐级归因）');
    w(`  A  缺陷口径（name: " 双引号-only）            定义 ${result.ladder.A.defs} ｜ 文件 ${result.ladder.A.files}`);
    w(`  B  name: 后跟引号（双+单，已剥离注释）          定义 ${result.ladder.B.defs} ｜ 文件 ${result.ladder.B.files}   (raw 未剥注释 = ${result.ladder.B.rawDefs} / ${result.ladder.B.rawFiles})`);
    w(`  B' name: 后跟标识符（含非定义行 name: hit.name）定义 ${result.ladder['B-line'].defs} ｜ 文件 ${result.ladder['B-line'].files}`);
    w(`  C  稳健解析（块无关，并入注册面）              定义 ${result.ladder.C.defs} ｜ 文件 ${result.ladder.C.files}`);
    w(`  D  按块解析（须 parameters+execute）          定义 ${result.ladder.D.defs} ｜ 文件 ${result.ladder.D.files}`);
    w(`  块过滤剔除 = ${result.ladder.D.rejected.length} 项 ${JSON.stringify(result.ladder.D.rejected)}`);
    w(`  C→D 仅在 D = ${JSON.stringify(result.attribution.dOnly)}`);
    w(`  注册面贡献（lib/tools 之外） = ${JSON.stringify(result.attribution.registerOnlyDefs)}`);
    w('');
    w('## 二、三面汇总与基线对账');
    const row = (label, k) => w(`  ${label.padEnd(14, ' ')} = ${actual[k]}（基线 ${BASELINE[k]}）${BASELINE[k] === actual[k] ? ' ✔' : ' ✖ Δ' + (actual[k] - BASELINE[k] > 0 ? '+' : '') + (actual[k] - BASELINE[k])}`);
    row('定义数', 'definitions'); row('文件数', 'files'); row('声明键数', 'declaredKeys');
    row('required', 'requiredKeys'); row('读未声明', 'readUndeclared'); row('声明零读', 'zeroRead'); row('间接消费', 'indirect');
    w('');
    w('## 三、差异清单（逐项，**不调数**）');
    if (!diffs.length) w('  （无差异：七项全部与基线一致）');
    for (const d of diffs) w(`  ✖ ${d.key}：基线 ${d.baseline} → 实测 ${d.actual}（Δ ${d.delta > 0 ? '+' : ''}${d.delta}）`);
    for (const x of readUndeclaredAll) w(`  ✖ 读未声明：${x.def}（${x.file}）读了未声明的键 ${x.key}\n      证据: ${x.evidence}`);
    for (const x of zeroReadAll.slice(0, 20)) w(`  ✖ 声明零读：${x.def}（${x.file}）声明键 ${x.key} 在 execute 内零读\n      证据: ${x.evidence}`);
    if (zeroReadAll.length > 20) w(`  …（声明零读共 ${zeroReadAll.length} 项）`);
    w('');
    w('## 四、间接消费清单（与基线 29 对照）');
    for (const x of indirectAll) w(`  · ${x.def}（${x.file}）键 ${x.key}`);
    w(`  合计 = ${indirectAll.length}`);
    w('');
    w('## 五、归因诊断面（为每个基线数字给候选口径的实测值，**不调数**）');
    const dc = result.diag.filesCandidates;
    w(`  文件数候选：含定义 ${dc.withDefinition.n} ｜ 含 defineTool( ${dc.withDefineToolCall.n} ｜ 含 name: 行 ${dc.withNameLine.n}`);
    const rc = result.diag.requiredCandidates;
    w(`  required 候选：块级 ${rc.blockLevel} ｜ 文件级 ${rc.fileLevel} ｜ 仅 parameters 面 ${rc.parametersFace} ｜ 仅 output 面 ${rc.outputFace}`);
    const ic = result.diag.indirectCandidates;
    w(`  间接消费候选：按定义计 ${ic.byDefinition} ｜ 按键计 ${ic.byKey} ｜ 透传调用点合计 ${Object.values(ic.calleeHist).reduce((s, n) => s + n, 0)}`);
    w(`  透传 helper 分布：${JSON.stringify(ic.calleeHist)}`);
    w('');
    w('## 六、逐项归因与裁决（**R-C**：归因不出 ⇒ 明写「基线需订正」+ followup，禁糊）');
    for (const r of attributionTable) {
      const tag = { aligned: '✔ 对齐', attributed: '◐ 已归因（口径差异）', diff: '✖ 差异', unattributable: '⚠ **不可归因 ⇒ 基线需订正**' }[r.status];
      w(`  ${tag} ｜ ${r.key}：基线 ${r.baseline} → 实测 ${r.actual}`);
      w(`      ${r.why}`);
    }
    w('');
    if (needsBaselineFix.length) {
      w(`  ⇒ **D 基线需订正**：${JSON.stringify(needsBaselineFix)}（**不得**以「差异可忽略」或「口径不同」带过）`);
      w('  ⇒ followup：该数字**不得**带未归因差额进发布面；订正需在后续批次带清单重出。');
    } else {
      w('  ⇒ 七项**全部可归因**（对齐或口径差异）⇒ 基线数字无需订正，但**必须**按本脚本携带清单。');
    }
    if (args.verbose) {
      w(''); w('## 五、逐件清单（verbose）');
      for (const f of [...D.files].sort()) w(`  ${f} ⇒ ${JSON.stringify(perDef.filter((d) => d.file === f).map((d) => d.name))}`);
    }
    process.stdout.write(L.join('\n') + '\n');
  }
  process.exit(diffs.length === 0 && actual.readUndeclared === 0 && actual.zeroRead === 0 ? 0 : 1);
}

main();
