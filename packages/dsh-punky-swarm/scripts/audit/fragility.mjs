#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// scripts/audit/fragility.mjs — 重构脆性审计器（判据里的「写死字面量」）
//
// 【一句话】把「判据里写死路径 / 行号 / 名单 / 数量」这四类字面量，从「重构时
//   靠人撞出来」变成「重构前一次机扫列清」——每条给出「会在什么改动下失效（假红）」
//   与「对什么改动失明（假绿）」，并带白名单登记（registry）。
//
// 【核心精度原则（贯穿全文，非可选）】本器**只报「会静默失效」的判据**。
//   失效时**响亮**的耦合（ENOENT / SyntaxError / 阳性对照在场 / 模块系统加载失败）
//   **不报或降 P3**——那种债在执行时自己会叫，不属「脆性」。这条原则同时承担
//   去误报主责：见 loudness gate（§方案 3.2 ①）。
//
// 【族集（7 候选 → 默认 4 + opt-in 1 + 裁 2）】
//   F-path        ✅ 默认   按字面路径把仓内源文件当数据读（P1 无守卫 / P3 有守卫）
//   F-line        ✅ 默认   `路径:NNN` 行号引用（P1 stale-missing / P2 stale-out-of-range / P3 at-risk）
//   F-list        ✅ 默认   硬编码身份名单（P2；identity gate 命中降 P3）
//   F-count       ✅ 默认   具名数量常量 / 期望表项（P1；identity gate 命中降 P3）
//   F-count-prose ⚙️ opt-in 注释里的「N 行 / 余量 N / ≤N / 上限 N」（P3，默认关）
//   F-symbol      ❌ 裁掉   命名导入面缺失 0、命名空间面误报 ≈100%（退役锁同形不可区分）
//   F-name        ❌ 裁掉   未知蛇形串 67 个中真旧名 ≈1 ⇒ 误报 ≈98%
//
// 【与既有扫描器的边界（各自只管一轴，本器不重做）】
//   scripts/audit/reachability.mjs   门禁码 union / 迁移边的 prod-test 命中次数
//   scripts/audit/strength.mjs       断言强度四分（title/exact/weak/other）
//   scripts/readings-consistency.mjs runner 与 guard 的用例数恒等式
//   scripts/neighbor-scan.mjs        **运行期** `.length/.size` 的邻位身份（F1/F2/F3）
//     → 边界：neighbor-scan 判「运行期这条计数断言旁边有没有身份兜底」；
//       本器判「源码里这个数量/名单字面量从哪来、会在什么改动下失真」。
//       本器**不做邻位判定、不产 census-table**（identity gate 只降级，不裁决）。
//   scripts/evidence-guard.mjs       用例覆盖完整性（目标集 ≡ 完成事件集）
//   scripts/docs-consistency.mjs     `.md` 文档面的旧词归零 + 计数一致性（本器扫 .md 一律排除）
//   scripts/build-sync-guard.mjs     `.ts ↔ .js` 源↔产物符号同步
//   scripts/tool-face-*.mjs          工具定义三面（声明↔注册↔消费）
//     本器不碰工具定义语义，只在「工具名被写进字面名单」时报 F-list。
//
// 【纪律】单文件、只读、零第三方依赖、不启子进程、不调 git（HEAD 由 .git 文件直读）。
//   register/更新 registry 是**人工**动作，本器绝不代劳（防「自动登记」把脆点洗白）。
//
// 【判别力自证（硬性）】本仓铁律见 scripts/audit/strength.mjs:10-11：
//   「任何 detector 类工具都必须自带**判别力自证**，否则它本身可能就是空转（R3-4 教训）」。
//   `--selftest` 对内联固定样本集（正 / 负 / 干扰项）双向断言，并用 `--mutate <k>`
//   证明自测有杀伤力（关掉第 k 条去误报规则 ⇒ 自测必须转红并点名）。
// ════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ── 契约常量 ────────────────────────────────────────────────────────────────
const SCHEMA_VERSION = 1;
const FAMILIES = ['path', 'line', 'list', 'count', 'count-prose'];
const FAMILY_NAME = {
  path: 'F-path',
  line: 'F-line',
  list: 'F-list',
  count: 'F-count',
  'count-prose': 'F-count-prose',
};
const DEFAULT_FAMILIES = ['path', 'line', 'list', 'count'];
const FAMILY_NAME_REVERSE = Object.fromEntries(Object.entries(FAMILY_NAME).map(([k, v]) => [v, k]));
const SCAN_ROOTS = ['test', 'scripts'];
const SCAN_EXTS = ['.js', '.mjs', '.ts'];
const TEXT_EXTS = ['.js', '.mjs', '.ts', '.json', '.md'];
const SCAN_SKIP_DIRS = new Set(['node_modules', '.git', '.tsbuild', '.wip-backup', 'out', 'baselines', 'reports', 'docs']);
const INDEX_SKIP_DIRS = new Set(['node_modules', '.git', '.tsbuild', '.wip-backup', 'out']);

// 读动词（§3.3 判据 ①）。readFileSync 必须排在 readFile 之前（交替式有序）。
const READ_VERB_RE = /\b(readFileSync|readFile|readSrc|read|head|gitShow|countIn)\s*\(/g;
// 仓内路径字面量（§3.3 判据 ②）
const PATH_LITERAL_RE = /['"`]((?:\.\.\/)*(?:\.\/)?(?:lib|test|scripts)\/[\w./-]+\.(?:js|mjs|ts|json|md))['"`]/g;
// path.join(<PKG|PKG_ROOT|ROOT|repoRoot>, '<lib|test|scripts>', …) 形态
const PATH_JOIN_RE = /\bpath\.join\(\s*(PKG_ROOT|PKG|ROOT|repoRoot)\s*,/g;
const PATH_JOIN_ROOTS = new Set(['PKG_ROOT', 'PKG', 'ROOT', 'repoRoot']);
const PATH_JOIN_FIRST = new Set(['lib', 'test', 'scripts']);
// F-line（§3.4 判据）。前向否定式 lookbehind：禁止在被截断的 token 里起匹配
//   （`xxx.test.js:46` 不得截成 `test.js:46`）；`/` 不在排除类内 ⇒ `./lib/x.js:1` 可正常起匹。
const FLINE_RE = /(?<![\w.\-])((?:\.\.\/)*(?:[\w.-]+\/)*[\w-]+\.(?:d\.ts|js|mjs|ts|json|md)):(\d+)(?:-(\d+))?/g;
const FLINE_ANY_RE = /(?<![\w.\-])([\w.\-/]+):(\d+)(?:-(\d+))?/g; // 仅 --mutate 2 用（去掉扩展名要求）
// F-count 具名数量常量（§3.6）
const COUNT_NAME_RE = /(EXPECTED|COUNT|TOTAL|LIMIT|SIZE|_N$|NUMBER|AMOUNT)/;
const COL0_COUNT_CONST_RE = /^const\s+([A-Z][A-Z0-9_]*)\s*=\s*(\d+)\s*;/;
// F-count-prose（§3.7）
const PROSE_PATTERNS = [/\d+\s*(?:逻辑)?行/, /余量\s*\d+/, /≤\s*\d+/, /上限\s*\d+/];
// 内联行为计数（只进 --stats，不作判据）
const INLINE_COUNT_RE = /\.(?:length|size)\s*,\s*\d+/g;
// registry reason 闭集（§4.5）
const REGISTRY_REASONS = new Set(['authoritative-source', 'behavior-count', 'fixture', 'loud-guard', 'superseded']);

const USAGE = `用法：node scripts/audit/fragility.mjs [选项]

  --root <dir>                 仓根（缺省 process.cwd()；须含 package.json 与 lib/）
  --family <csv>               启用族：path,line,list,count,count-prose（缺省 path,line,list,count）
  --json                       stdout 输出全量 JSON（不落盘）
  --check                      门禁语义：存在未登记 P1 ⇒ 退出码 1（P2/P3 不影响）
  --strict-all                 P2/P3 也影响退出码（仅人工排查用）
  --stats                      额外打印「有意不报」面的汇总计数
  --registry <path>            白名单文件（缺省 scripts/audit/fragility-registry.json；不存在=空表）
  --print-registry-candidates  把全部未登记命中打印成 registry 骨架到 stdout（不落盘）
  --top <n>                    人读模式每族最多展开 n 条（缺省 20；-1 = 全部）
  --selftest                   跑判别力自证（不得与 --check 并用）
  --mutate <1..5>              仅与 --selftest 连用：关掉第 k 条去误报规则，断言自测转红
  -h, --help                   本用法（零副作用）

退出码：0 = 无未登记 P1（或 --selftest 全绿）｜1 = 有未登记命中 / 自测红｜2 = 用法错或环境不适用`;

// ── 小工具 ──────────────────────────────────────────────────────────────────
function fail(msg) {
  process.stderr.write(`用法错：${msg}\n`);
  process.exit(2);
}

function walkFiles(dir, skipDirNames, exts, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (skipDirNames.has(e.name)) continue;
      walkFiles(p, skipDirNames, exts, out);
    } else if (exts.includes(path.extname(e.name))) {
      out.push(p);
    }
  }
  return out;
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function readHeadSha(root) {
  // 不调 git：直接读 .git/HEAD（含 packed-refs 回退）。判据面在包内、`.git` 常在仓根，故向上溯 5 级。
  let dir = path.resolve(root);
  for (let i = 0; i < 5; i += 1) {
    const gitDir = path.join(dir, '.git');
    if (fs.existsSync(gitDir)) return readGitHead(gitDir);
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function readGitHead(gitDir) {
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head.slice(0, 7);
    const m = /^ref:\s*(.+)$/.exec(head);
    if (!m) return null;
    const refFile = path.join(gitDir, m[1]);
    if (fs.existsSync(refFile)) return fs.readFileSync(refFile, 'utf8').trim().slice(0, 7);
    const packedPath = path.join(gitDir, 'packed-refs');
    if (!fs.existsSync(packedPath)) return null;
    const packed = fs.readFileSync(packedPath, 'utf8');
    const hit = packed.split(/\r?\n/).find((ln) => ln.endsWith(' ' + m[1]));
    return hit ? hit.slice(0, 7) : null;
  } catch {
    return null;
  }
}

function sha8Of(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
}

// ── 文件索引（扫描面 + 解析目标面）─────────────────────────────────────────────
function buildIndex(root) {
  const indexAbs = walkFiles(root, INDEX_SKIP_DIRS, TEXT_EXTS, []);
  const scanAbs = SCAN_ROOTS.flatMap((d) => walkFiles(path.join(root, d), SCAN_SKIP_DIRS, SCAN_EXTS, []));
  const baseCount = new Map();
  const byBase = new Map();
  for (const abs of indexAbs) {
    const b = path.basename(abs);
    baseCount.set(b, (baseCount.get(b) || 0) + 1);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(abs);
  }
  return { root, indexAbs, scanAbs, baseCount, byBase, lineCache: new Map() };
}

function lineCountOf(index, abs) {
  if (index.lineCache.has(abs)) return index.lineCache.get(abs);
  let n = -1;
  try {
    n = fs.readFileSync(abs, 'utf8').split(/\r?\n/).length;
  } catch {
    n = -1;
  }
  index.lineCache.set(abs, n);
  return n;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// 目标解析（§3.4「半可验证」面）：
//   有目录 ⇒ 从文件所在目录 / 仓根依次 resolve；解析不到再按「全仓同名唯一」回解。
//   裸文件名且全仓同名 >1 ⇒ ambiguous（不报，防跨包同名误指）。
function resolveTarget(index, rel, fromAbs) {
  const candidates = [];
  if (rel.startsWith('../')) candidates.push(path.resolve(path.dirname(fromAbs), rel));
  candidates.push(path.resolve(index.root, rel.replace(/^(\.\.\/)+/, '')));
  candidates.push(path.resolve(path.dirname(fromAbs), rel));
  let abs = candidates.find((c) => isFile(c));
  if (!abs) {
    const base = path.basename(rel);
    const count = index.baseCount.get(base) || 0;
    if (!rel.includes('/') && count > 1) {
      return { path: rel, resolved: false, lines: null, lineInRange: null, status: 'ambiguous', abs: null };
    }
    if (count === 1) abs = index.byBase.get(base)[0];
  }
  if (!abs) {
    const repoish = /^(?:(?:\.\.\/)*(?:lib|test|scripts|docs)\/)/.test(rel);
    return { path: rel, resolved: false, lines: null, lineInRange: null, status: repoish ? 'stale-missing' : 'out-of-repo', abs: null };
  }
  return { path: rel, resolved: true, lines: lineCountOf(index, abs), lineInRange: null, status: 'at-risk', abs };
}

// ── 文本切分：代码面 / 注释面（同长掩码，行号与列位对齐）──────────────────────
function splitCodeAndComment(raw) {
  const n = raw.length;
  const codeChars = new Array(n);
  const commentChars = new Array(n);
  const blankChars = new Array(n); // 代码面但**字符串内容抹空**（用于标识符消费判定，防 `'x.ts'` 里的 `ts` 冒充变量）
  let state = 'code'; // code | line-comment | block-comment | sq | dq | bt
  for (let i = 0; i < n; i++) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        codeChars[i] = ' ';
        commentChars[i] = ch;
        blankChars[i] = ' ';
        state = 'line-comment';
        continue;
      }
      if (ch === '/' && next === '*') {
        codeChars[i] = ' ';
        commentChars[i] = ch;
        blankChars[i] = ' ';
        state = 'block-comment';
        continue;
      }
      codeChars[i] = ch;
      commentChars[i] = ch === '\n' ? '\n' : ' ';
      blankChars[i] = ch;
      if (ch === "'") state = 'sq';
      else if (ch === '"') state = 'dq';
      else if (ch === '`') state = 'bt';
      continue;
    }
    if (state === 'line-comment') {
      codeChars[i] = ch === '\n' ? '\n' : ' ';
      commentChars[i] = ch;
      blankChars[i] = ch === '\n' ? '\n' : ' ';
      if (ch === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      codeChars[i] = ch === '\n' ? '\n' : ' ';
      commentChars[i] = ch;
      blankChars[i] = ch === '\n' ? '\n' : ' ';
      if (ch === '*' && next === '/') {
        codeChars[i + 1] = ' ';
        commentChars[i + 1] = next;
        blankChars[i + 1] = ' ';
        i += 1;
        state = 'code';
      }
      continue;
    }
    // 字符串态（'…' / "…" / `…`）：code 保留原文（路径/行号可能就写在字符串里），blank 全部抹空
    codeChars[i] = ch;
    commentChars[i] = ch === '\n' ? '\n' : ' ';
    blankChars[i] = ch === '\n' ? '\n' : ' ';
    if (ch === '\\') {
      if (i + 1 < n) {
        codeChars[i + 1] = raw[i + 1];
        commentChars[i + 1] = raw[i + 1] === '\n' ? '\n' : ' ';
        blankChars[i + 1] = raw[i + 1] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    if ((state === 'sq' && ch === "'") || (state === 'dq' && ch === '"') || (state === 'bt' && ch === '`')) {
      state = 'code';
    }
  }
  return { code: codeChars.join(''), comment: commentChars.join(''), blank: blankChars.join('') };
}

function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function offsetToLine(starts, off) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= off) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

// 从 '(' 起做括号配对取实参窗口（上限 maxLen 字符，可跨行）。§3.3 判据 ①
function parenBody(text, openIdx, maxLen) {
  let depth = 0;
  const limit = Math.min(text.length, openIdx + maxLen + 1);
  for (let i = openIdx; i < limit; i++) {
    const ch = text[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { start: openIdx + 1, end: i, body: text.slice(openIdx + 1, i) };
    }
  }
  return null;
}

// ── 文件上下文 ──────────────────────────────────────────────────────────────
function buildContext(index, abs, rawOverride) {
  const raw = rawOverride !== undefined ? rawOverride : fs.readFileSync(abs, 'utf8');
  const { code, comment, blank } = splitCodeAndComment(raw);
  const starts = lineStartsOf(raw);
  const lines = raw.split(/\r?\n/);
  const rel = rawOverride !== undefined ? abs : toPosix(path.relative(index.root, abs));
  const ctx = {
    abs: rawOverride !== undefined ? path.resolve(index.root, abs) : abs,
    file: rel,
    raw,
    code,
    comment,
    blank,
    blankLines: blank.split(/\r?\n/),
    lines,
    codeLines: code.split(/\r?\n/),
    commentLines: comment.split(/\r?\n/),
    starts,
    _verbWindows: null,
  };
  return ctx;
}

function lineOfOffset(ctx, off) {
  return offsetToLine(ctx.starts, off);
}

function lineText(ctx, n) {
  return (ctx.lines[n - 1] || '').trim();
}

// ── 语句头 / 用途分类（§3.3 判据 ③ 的「用途排除」面）────────────────────────
// 逐行向上回溯到语句起点（遇 import/export 行或已闭合的 `;` 即停），再判用途。
//   注意：不能用「上一个 ;{}」切，否则 `import { x } from '…'` 会在 `}` 处被切开。
function usageOfSite(ctx, off) {
  const line = lineOfOffset(ctx, off);
  let stmtStart = line;
  for (let i = line; i >= Math.max(1, line - 6); i -= 1) {
    const t = ctx.codeLines[i - 1] || '';
    // 上一行已闭合（语句结束）⇒ 站点的语句起于其下一行，不得再往上并入 import 语句
    if (i < line && /;\s*$/.test(t)) break;
    stmtStart = i;
    if (/^\s*(import|export)\b/.test(t)) break;
  }
  const stmt = ctx.codeLines.slice(stmtStart - 1, line).join('\n');
  if (/^\s*(import|export)\b/.test(stmt)) return 'import-specifier';
  if (/^\s*\}?\s*from\b/.test(ctx.codeLines[line - 1] || '')) return 'import-specifier';
  if (/\bpathToFileURL\s*\(/.test(stmt)) return 'url-import';
  if (/\bimport\s*\(/.test(stmt)) return 'url-import';
  if (/\brequire\s*\(/.test(stmt)) return 'cjs-require';
  return 'read-candidate';
}

// 读动词窗口（每文件算一次）
function verbWindowsOf(ctx) {
  if (ctx._verbWindows) return ctx._verbWindows;
  const windows = [];
  const re = READ_VERB_RE;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(ctx.code))) {
    const open = ctx.code.indexOf('(', m.index);
    if (open < 0) continue;
    const body = parenBody(ctx.code, open, 400);
    if (!body) continue;
    const bodyBlank = parenBody(ctx.blank, open, 400);
    windows.push({ verb: m[1], start: body.start, end: body.end, body: body.body, bodyBlank: bodyBlank ? bodyBlank.body : '', line: lineOfOffset(ctx, m.index) });
  }
  ctx._verbWindows = windows;
  return windows;
}

// 仓内路径字面量站点（含 path.join 组装形态）
function pathSitesOf(ctx) {
  const sites = [];
  const litRe = PATH_LITERAL_RE;
  litRe.lastIndex = 0;
  let m;
  while ((m = litRe.exec(ctx.code))) {
    sites.push({ offset: m.index, path: m[1], kind: 'literal' });
  }
  const joinRe = PATH_JOIN_RE;
  joinRe.lastIndex = 0;
  while ((m = joinRe.exec(ctx.code))) {
    if (!PATH_JOIN_ROOTS.has(m[1])) continue;
    const open = ctx.code.indexOf('(', m.index);
    if (open < 0) continue;
    const body = parenBody(ctx.code, open, 400);
    if (!body) continue;
    const strings = [];
    const strRe = /'([^']*)'|"([^"]*)"/g;
    let s;
    while ((s = strRe.exec(body.body))) strings.push(s[1] !== undefined ? s[1] : s[2]);
    if (strings.length >= 2 && PATH_JOIN_FIRST.has(strings[0])) {
      sites.push({ offset: m.index, path: strings.join('/'), kind: 'join' });
    }
  }
  sites.sort((a, b) => a.offset - b.offset);
  return sites;
}

// 模块级/局部 const 绑定到仓内路径表达式（FP-2 一跳传播源）
function constBindingsOf(ctx, sites) {
  const bindings = [];
  for (const site of sites) {
    const lineStart = ctx.starts[lineOfOffset(ctx, site.offset) - 1];
    const prefix = ctx.code.slice(lineStart, site.offset);
    const m = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;]*$/.exec(prefix);
    if (m) bindings.push({ name: m[1], site, line: lineOfOffset(ctx, site.offset) });
  }
  return bindings;
}

// ── gate ────────────────────────────────────────────────────────────────────
// ① loudness gate（「静默才报」）：语句窗口内出现存在性/形状守卫 ⇒ 失效会响亮红 ⇒ 降 P3
const LOUD_MARKERS = [
  /expect\(\s*Boolean\(/,
  /assert\.ok\(/,
  /existsSync/,
  /未找到/,
  /not found/i,
  /\?\./,
  /if\s*\(\s*!\s*[A-Za-z_$][\w$]*\s*\)/,
];
function loudnessGate(lines, line) {
  const from = Math.max(1, line - 6);
  const to = Math.min(lines.length, line + 6);
  const window = lines.slice(from - 1, to).join('\n');
  if (LOUD_MARKERS.some((re) => re.test(window))) return true;
  if (/try\s*\{/.test(window) && /catch\b/.test(window)) return true;
  return false;
}

// ② identity gate（「有身份兜底就降级」）：同断言块 ±10 行内已有集合身份兜底 ⇒ 降 P3
//   注意：被报的字面数组**本身**就是 deepEqual 的期望侧时不算兜底（字面量即真值）。
const IDENTITY_MARKERS = [/frozenToolNames\s*\(/, /TOOL_NAMES\.slice\(\)\.sort\(\)/];
function identityGate(lines, line) {
  const from = Math.max(1, line - 10);
  const to = Math.min(lines.length, line + 10);
  const windowLines = [];
  for (let i = from; i <= to; i++) windowLines.push({ n: i, text: lines[i - 1] || '' });
  const window = windowLines.map((x) => x.text).join('\n');
  if (IDENTITY_MARKERS.some((re) => re.test(window))) return true;
  // 被报站点本身已是「集合比对」的字面期望侧（deepEqual(...sort(), [字面…])）⇒ 字面量即真值，
  //   不当有兜底 ⇒ 只认**显式派生真源**（沿用上面的 IDENTITY_MARKERS 结论 false）。
  const hitLineText = lines[line - 1] || '';
  if (/deep(?:Strict)?Equal\s*\(/.test(hitLineText) && /\.sort\s*\(/.test(hitLineText)) return false;
  // 其余情形：同断言块 ±10 行内另有集合身份兜底（deepEqual + .sort 同时在场）⇒ 降级
  for (const w of windowLines) {
    if (w.n === line) continue;
    if (/deep(?:Strict)?Equal\s*\(/.test(w.text) && /\.sort\s*\(/.test(w.text)) return true;
  }
  return false;
}

// ── 命中构造 ────────────────────────────────────────────────────────────────
function breaksWhenOf(family, status) {
  if (family === 'F-path') {
    return ['把目标文件拆成多文件 / 改名 / 移动（read 动词抛 ENOENT，或仍读到已缩小的旧基座）', '对目标文件做「掏空式」重构：路径不变、内容与规模已变'];
  }
  if (family === 'F-line') {
    if (status === 'stale-missing') return ['目标文件已不存在 / 被移动 ⇒ 引用彻底悬空', '读者按该行号查不到任何内容'];
    if (status === 'stale-out-of-range') return ['目标文件行数已少于该行号 ⇒ 行号引用与事实矛盾', '重构删行后行号漂移，读者被指向无关内容'];
    return ['目标文件行数变化 ⇒ 行号指向错误内容（复审者被误导）', '文件被拆/改名后引用悬空'];
  }
  if (family === 'F-list') {
    return ['名单成员被拆 / 改名 / 合法新增 ⇒ 集合断言失配（假红）', '名单被「顺手改宽」以过红 ⇒ 判据失效'];
  }
  if (family === 'F-count') {
    return ['集合合法增减（新增工具 / 拆出文件）⇒ 数量断言失配', '换文件：拆文件后仍数旧文件 ⇒ 覆盖面静默失守'];
  }
  return ['注释/标题里的数字与实现脱钩 ⇒ 事实矛盾（假绿或假红）'];
}

function blindToOf(family) {
  if (family === 'F-path') return '路径不变而内容/规模变化时无感（读到的仍是该文件本身）';
  if (family === 'F-line') return '本器只验存在性与范围，不验内容：行号仍在范围内但内容已换 ⇒ 无感';
  if (family === 'F-list') return '名单只用于计数而不做集合比对时，改名后总数不变 ⇒ 计数照绿';
  if (family === 'F-count') return '改名漂移：总数不变 ⇒ 计数断言全程绿；换文件后仍数旧文件';
  return '与功能阈值（如「≤ 300 行」）同形，不可机械区分';
}

function mkHit(ctx, family, line, target, gates, extra) {
  const hit = {
    family,
    severity: extra && extra.severity,
    file: ctx.file,
    line,
    hit: lineText(ctx, line),
    target: target || { path: null, resolved: null, lines: null, lineInRange: null, status: 'n/a' },
    breaksWhen: breaksWhenOf(family, target && target.status === 'n/a' ? null : target && target.status),
    blindTo: blindToOf(family),
    gates: gates || { loudness: false, identity: false },
    registered: null,
  };
  if (extra && extra.hash8) hit.hash8 = extra.hash8;
  return hit;
}

// ── F-path 检测器（§3.3）────────────────────────────────────────────────────
function detectPath(index, ctx, opts, out) {
  const windows = verbWindowsOf(ctx);
  const sites = pathSitesOf(ctx);
  if (!sites.length && !windows.length) return;
  const bindings = constBindingsOf(ctx, sites);
  const reported = new Set();

  for (const site of sites) {
    const line = lineOfOffset(ctx, site.offset);
    const usage = opts.vetoUsage === false ? 'read-candidate' : usageOfSite(ctx, site.offset);
    if (usage !== 'read-candidate') {
      out.excluded.push({ file: ctx.file, line, path: site.path, usage, reason: usage });
      continue;
    }
    // 直接联动：字面量落在某个读动词窗口内（窗口含首字符 ⇒ `read('lib/x.ts')` 必须算命中）
    let link = windows.find((w) => site.offset >= w.start && site.offset < w.end);
    let hitLine = link ? link.line : null;
    if (link) hitLine = line; // 站点所在行即命中行（多行实参下取站点行，便于人工复核）
    let linkage = link ? 'direct' : null;
    // FP-2 一跳传播：模块级/局部 `const NAME = <仓内路径表达式>` 且 NAME 在同文件被读动词消费。
    //   消费判定用**抹空字符串**的代码面 + 标识符边界，避免 `'x.ts'` 里的 `ts` 冒充变量名。
    if (!linkage) {
      const binding = bindings.find((b) => b.site === site);
      if (binding) {
        const nameRe = new RegExp(`(?<![\\w.$])${binding.name.replace(/[$]/g, '\\$')}\\b`);
        const consumer = windows.find((w) => nameRe.test(w.bodyBlank));
        if (consumer) {
          linkage = 'const';
          hitLine = binding.line;
        }
      }
    }
    if (!linkage) continue;
    const key = `F-path|${ctx.file}|${hitLine}|${site.path}`;
    if (reported.has(key)) continue;
    reported.add(key);
    const target = resolveTarget(index, site.path, ctx.abs);
    const gates = { loudness: opts.loudnessGate !== false ? loudnessGate(ctx.lines, hitLine) : false, identity: false };
    const severity = gates.loudness ? 'P3' : 'P1';
    const hit = mkHit(ctx, 'F-path', hitLine, {
      path: target.path,
      resolved: target.resolved,
      lines: target.lines,
      lineInRange: null,
      status: 'n/a',
    }, gates, { severity });
    hit.linkage = linkage; // 内部读数（jsonReport 不序列化）：direct = 字面量在 read 窗口；const = FP-2 一跳传播
    hit.siteKind = site.kind; // literal | join
    out.hits.push(hit);
  }
}

// （index 由 scanContext 显式下传：本器无模块级可变状态）

// 规则 ③（URL 排除）：匹配点落在同行 URL 的**跨度内** ⇒ 该路径不是仓内引用（是 URL 的一部分）。
//   精度说明：只排除「匹配点在 URL 内」的情况，不因同行别处出现 URL 就丢掉整行——
//   否则「注释里既贴链接又引仓内行号」会静默漏报（去误报不能以漏报为代价）。
function insideUrlOf(text, idx) {
  const u = text.indexOf('://');
  if (u < 0 || idx < u) return false;
  let end = text.length;
  for (let i = u + 3; i < text.length; i++) {
    if (/[\s'"`()<>[\]{},;，。；、]/.test(text[i])) {
      end = i;
      break;
    }
  }
  return idx < end;
}

// ── F-line 检测器（§3.4）────────────────────────────────────────────────────
function detectLine(index, ctx, opts, out) {
  const re = opts.mutate === 2 ? FLINE_ANY_RE : FLINE_RE;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(ctx.raw))) {
    const line = lineOfOffset(ctx, m.index);
    // 规则 ③：URL 端口 / URL 内嵌路径 ⇒ 丢弃
    if (opts.mutate !== 3) {
      const lineStart = ctx.starts[line - 1];
      const lineEnd = line < ctx.starts.length ? ctx.starts[line] : ctx.raw.length;
      const lineText = ctx.raw.slice(lineStart, lineEnd);
      if (insideUrlOf(lineText, m.index - lineStart)) continue;
    }
    // 规则 ①：冒号前 token 无源码扩展名（端口 / 时间 / 对象 key / 版本号）在正则层已出局；
    //   规则 ⑤：冒号后必须纯数字（git rev `HEAD:<path>` 天然出局）。
    const rel = m[1];
    const n = Number(m[2]);
    out.lineCandidates.push({ file: ctx.file, line, path: rel, n });
    const target = resolveTarget(index, rel, ctx.abs);
    if (target.status === 'ambiguous') {
      out.stats.ambiguousBasenames += 1;
      continue;
    }
    if (target.status === 'out-of-repo') {
      out.stats.outOfRepoRefs += 1;
      continue;
    }
    let status;
    let severity;
    if (target.status === 'stale-missing') {
      status = 'stale-missing';
      severity = 'P1';
    } else if (n > target.lines) {
      status = 'stale-out-of-range';
      severity = 'P2';
    } else {
      status = 'at-risk';
      severity = 'P3';
    }
    out.hits.push(mkHit(ctx, 'F-line', line, {
      path: target.path,
      resolved: target.resolved,
      lines: target.lines,
      lineInRange: target.resolved ? n <= target.lines : null,
      status,
    }, { loudness: false, identity: false }, { severity }));
  }
}

// ── F-list 检测器（§3.5）────────────────────────────────────────────────────
const QUOTED_ITEM_RE = /^(?:'([^']*)'|"([^"]*)"|`([^`]*)`)$/;
function unquoteItem(item) {
  const m = QUOTED_ITEM_RE.exec(item.trim());
  if (!m) return null;
  return m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
}

function parseArrayItems(code, openIdx) {
  let depth = 1; // openIdx 处的 '[' 已计入
  let quote = null;
  let cur = '';
  const items = [];
  const limit = Math.min(code.length, openIdx + 4000);
  for (let i = openIdx + 1; i < limit; i++) {
    const ch = code[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') {
        cur += code[i + 1] || '';
        i += 1;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '[' || ch === '(' || ch === '{') depth += 1;
    else if (ch === ']' || ch === ')' || ch === '}') {
      depth -= 1;
      if (depth === 0) {
        items.push(cur);
        return items;
      }
    }
    if (ch === ',' && depth === 1) {
      items.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  return null;
}

function detectList(ctx, opts, out) {
  const candidates = [];
  const preRe = /\[\s*['"`]/g;
  let pm;
  while ((pm = preRe.exec(ctx.code))) candidates.push(pm.index);
  for (const openIdx of candidates) {
    const items = parseArrayItems(ctx.code, openIdx);
    if (!items) continue;
    const names = [];
    let allQuoted = true;
    for (const it of items) {
      if (!it.trim()) continue;
      const v = unquoteItem(it);
      if (v === null) {
        allQuoted = false;
        break;
      }
      names.push(v);
    }
    if (!allQuoted || !names.length) continue;
    const fileNames = names.filter((x) => /^(?:\.\.\/)*(?:[\w.-]+\/)*[\w-]+\.(?:js|mjs|ts)$/.test(x));
    const snakeNames = names.filter((x) => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(x));
    let kind = null;
    if (fileNames.length >= 3) kind = '①字面文件名数组';
    else if (snakeNames.length >= 4) kind = '②字面蛇形标识符数组';
    if (!kind) continue;
    const line = lineOfOffset(ctx, openIdx);
    out.hits.push(...emitListHit(ctx, opts, out, line, kind));
  }
  detectPathKeyTables(ctx, opts, out);
}

function emitListHit(ctx, opts, out, line, kind) {
  const gates = { loudness: false, identity: opts.identityGate !== false ? identityGate(ctx.lines, line) : false };
  const severity = gates.identity ? 'P3' : 'P2';
  const hit = mkHit(ctx, 'F-list', line, null, gates, { severity });
  hit.detail = kind;
  return [hit];
}

// ③ 对象表：key 为仓内源码路径（≥2 项；或单 key + ≥2 条正则期望 = 事故 #3 的精确形态）
function detectPathKeyTables(ctx, opts, out) {
  const keyRe = /^(\s*)['"`]((?:\.\.\/)*(?:lib|test|scripts)\/[\w./-]+\.(?:js|mjs|ts|json|md))['"`]\s*:\s*(.*)$/;
  const entries = [];
  ctx.codeLines.forEach((text, i) => {
    const m = keyRe.exec(text);
    if (m) entries.push({ line: i + 1, path: m[2], value: m[3] });
  });
  // 相邻路径 key 归为一个「表」（行间隔 ≤ 2）
  const runs = [];
  for (const e of entries) {
    const last = runs[runs.length - 1];
    if (last && e.line - last[last.length - 1].line <= 2) last.push(e);
    else runs.push([e]);
  }
  const countValue = (v) => /^\d+\s*,?\s*(?:\/\/.*)?$/.test(v.trim());
  // 「数据记录」判定：值为对象字面量 ⇒ 该表是 fixture/数据载荷（path → 记录），不是「期望表」（path → 判据）。
  //   精度依据：本器只报会静默失效的**判据**；数据载荷表变动不会让某条断言的语义失真。
  const objectValue = (v) => /^\{/.test(v.trim());
  const regexArrayValue = (v) => {
    const inner = /^\[(.*)\]/s.exec(v.trim());
    if (!inner) return false;
    const parts = inner[1].split(',').map((x) => x.trim()).filter(Boolean);
    return parts.filter((x) => /^\/.*\/[gimsuy]*$/.test(x)).length >= 2;
  };
  for (const run of runs) {
    if (run.some((e) => objectValue(e.value))) continue; // 数据载荷表 ⇒ 不是身份判据
    const hasNonCount = run.some((e) => !countValue(e.value));
    if (run.length >= 2 && hasNonCount) {
      const line = run[0].line;
      const gates = { loudness: false, identity: opts.identityGate !== false ? identityGate(ctx.lines, line) : false };
      const hit = mkHit(ctx, 'F-list', line, null, gates, { severity: gates.identity ? 'P3' : 'P2' });
      hit.detail = '③期望表 key 为仓内路径';
      out.hits.push(hit);
      continue;
    }
    if (run.length === 1 && regexArrayValue(run[0].value)) {
      const line = run[0].line;
      const gates = { loudness: false, identity: opts.identityGate !== false ? identityGate(ctx.lines, line) : false };
      const hit = mkHit(ctx, 'F-list', line, null, gates, { severity: gates.identity ? 'P3' : 'P2' });
      hit.detail = '③期望表 key 为仓内路径（单 key + 正则期望表）';
      out.hits.push(hit);
    }
  }
}

// ── F-count 检测器（§3.6）───────────────────────────────────────────────────
function detectCount(ctx, opts, out) {
  // ① 具名数量常量：模块级（列 0）`const NAME = <int>;` 且 NAME 命中数量词表
  ctx.codeLines.forEach((text, i) => {
    const m = COL0_COUNT_CONST_RE.exec(text);
    if (!m) return;
    if (!COUNT_NAME_RE.test(m[1])) return;
    const line = i + 1;
    const gates = { loudness: false, identity: opts.identityGate !== false ? identityGate(ctx.lines, line) : false };
    out.hits.push(mkHit(ctx, 'F-count', line, null, gates, { severity: gates.identity ? 'P3' : 'P1' }));
  });
  // ② 期望表项：对象表 key 为文件名/仓内路径 + 纯整数值（`LIMITS` 形态，≥2 项成表）
  const keyRe = /^(\s*)['"`]((?:\.\.\/)*(?:[\w.-]+\/)*[\w-]+\.(?:js|mjs|ts|json|md))['"`]\s*:\s*(\d+)\s*,?\s*(?:\/\/.*)?$/;
  const entries = [];
  ctx.codeLines.forEach((text, i) => {
    const m = keyRe.exec(text);
    if (m) entries.push({ line: i + 1, path: m[2], n: Number(m[3]) });
  });
  const runs = [];
  for (const e of entries) {
    const last = runs[runs.length - 1];
    if (last && e.line - last[last.length - 1].line <= 2) last.push(e);
    else runs.push([e]);
  }
  for (const run of runs) {
    if (run.length < 2) continue;
    for (const e of run) {
      const gates = { loudness: false, identity: opts.identityGate !== false ? identityGate(ctx.lines, e.line) : false };
      out.hits.push(mkHit(ctx, 'F-count', e.line, null, gates, { severity: gates.identity ? 'P3' : 'P1' }));
    }
  }
  // --mutate 5：把「具名常量 / 期望表项」放宽为「内联字面量」（可达构造，非生产行为）
  if (opts.mutate === 5) {
    ctx.codeLines.forEach((text, i) => {
      if (!/\bassert\./.test(text)) return;
      INLINE_COUNT_RE.lastIndex = 0;
      if (!INLINE_COUNT_RE.test(text)) return;
      const line = i + 1;
      out.hits.push(mkHit(ctx, 'F-count', line, null, { loudness: false, identity: false }, { severity: 'P1' }));
    });
  }
}

// ── F-count-prose 检测器（§3.7，opt-in）─────────────────────────────────────
function detectCountProse(ctx, opts, out) {
  ctx.commentLines.forEach((text, i) => {
    if (!text.trim()) return;
    if (!PROSE_PATTERNS.some((re) => re.test(text))) return;
    const line = i + 1;
    out.stats.countProseSites += 1;
    if (opts.familiesEnabled && !opts.familiesEnabled.has('count-prose')) return;
    out.hits.push(mkHit(ctx, 'F-count-prose', line, null, { loudness: false, identity: false }, { severity: 'P3' }));
  });
}

// ── 单文件扫描 ──────────────────────────────────────────────────────────────
function scanContext(index, ctx, opts) {
  const out = { hits: [], excluded: [], lineCandidates: [], stats: { ambiguousBasenames: 0, outOfRepoRefs: 0, countProseSites: 0 } };
  const families = opts.familiesEnabled;
  if (!families || families.has('path')) detectPath(index, ctx, opts, out);
  if (!families || families.has('line')) detectLine(index, ctx, opts, out);
  if (!families || families.has('list')) detectList(ctx, opts, out);
  if (!families || families.has('count')) detectCount(ctx, opts, out);
  // count-prose 的**统计面**恒跑（证明「不报」是判定而非漏看）；命中面受 familiesEnabled 约束
  detectCountProse(ctx, opts, out);
  return out;
}

function dedupeHits(hits) {
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    const key = `${h.family}|${h.file}|${h.line}|${(h.target && h.target.path) || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

// ── registry（§4.5）────────────────────────────────────────────────────────
function loadRegistry(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    return { present: true, schemaVersion: parsed.schemaVersion || null, entries };
  } catch {
    return { present: false, schemaVersion: null, entries: [] };
  }
}

function registryIdOf(hit) {
  const sha8 = hit.hash8 || sha8Of(hit.hit);
  return { id: `${hit.file}#${sha8}#${hit.family}`, sha8 };
}

function attachRegistry(hits, registry) {
  const byKey = new Map();
  for (const e of registry.entries) {
    if (!e || !e.file || !e.hitSha8) continue;
    byKey.set(`${e.file}#${e.hitSha8}`, e);
  }
  const today = new Date().toISOString().slice(0, 10);
  let expired = 0;
  for (const h of hits) {
    const { id, sha8 } = registryIdOf(h);
    h.hash8 = sha8;
    const entry = byKey.get(`${h.file}#${sha8}`) || null;
    h.registered = entry
      ? {
          id,
          reason: entry.reason || null,
          note: entry.note || null,
          addedAt: entry.addedAt || null,
          addedBy: entry.addedBy || null,
          review: entry.review || null,
        }
      : null;
    if (h.registered && h.registered.review && h.registered.review < today) expired += 1;
    if (h.registered && (!h.registered.note || !REGISTRY_REASONS.has(h.registered.reason || ''))) {
      h.registryWarning = 'incomplete';
    }
  }
  return { expired };
}

// ── 扫描主流程 ──────────────────────────────────────────────────────────────
function runScan(index, opts) {
  const started = process.hrtime.bigint();
  const rawHits = [];
  const excluded = [];
  const stats = { excludedImportSpecifiers: 0, excludedCjsRequires: 0, inlineCountLiterals: 0, countProse: 0, outOfRepoRefs: 0, ambiguousBasenames: 0, scannedFiles: 0 };
  const excludedKeys = new Set();
  for (const abs of index.scanAbs) {
    let ctx;
    try {
      ctx = buildContext(index, abs);
    } catch {
      continue;
    }
    stats.scannedFiles += 1;
    const out = scanContext(index, ctx, opts);
    rawHits.push(...out.hits);
    for (const ex of out.excluded) {
      const key = `${ex.file}|${ex.line}|${ex.path}`;
      if (excludedKeys.has(key)) continue;
      excludedKeys.add(key);
      excluded.push(ex);
      if (ex.usage === 'import-specifier' || ex.usage === 'url-import') stats.excludedImportSpecifiers += 1;
      else if (ex.usage === 'cjs-require') stats.excludedCjsRequires += 1;
    }
    stats.outOfRepoRefs += out.stats.outOfRepoRefs;
    stats.ambiguousBasenames += out.stats.ambiguousBasenames;
    INLINE_COUNT_RE.lastIndex = 0;
    const inlineMatches = ctx.code.match(INLINE_COUNT_RE);
    if (inlineMatches) stats.inlineCountLiterals += inlineMatches.length;
    stats.countProse += out.stats.countProseSites;
  }
  const hits = dedupeHits(rawHits).sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.family < b.family ? -1 : 1)));
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  return { hits, excluded, stats, durationMs };
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
function summarize(hits) {
  const byFamily = {};
  const bySeverity = { P1: 0, P2: 0, P3: 0 };
  let registered = 0;
  for (const h of hits) {
    byFamily[h.family] = (byFamily[h.family] || 0) + 1;
    bySeverity[h.severity] = (bySeverity[h.severity] || 0) + 1;
    if (h.registered) registered += 1;
  }
  return { total: hits.length, byFamily, bySeverity, registered, unregistered: hits.length - registered };
}

function unregisteredOf(hits, severitySet) {
  return hits.filter((h) => !h.registered && (!severitySet || severitySet.has(h.severity)));
}

// ── 输出：人读 ──────────────────────────────────────────────────────────────
function humanReport(report, opts) {
  const lines = [];
  const head = report.head ? `@ ${report.head}` : '@ (no-git)';
  lines.push(`fragility ${head} (root=${report.root})`);
  lines.push(`  扫描面 ${report.stats.scannedFiles} 文件 · families = ${report.families.map((f) => FAMILY_NAME[f]).join(',')} · ${report.durationMs.toFixed(0)}ms`);
  const order = ['F-path', 'F-line', 'F-list', 'F-count', 'F-count-prose'];
  const sevLabel = { 'F-path': 'P1/P3', 'F-line': 'P1..P3', 'F-list': 'P2/P3', 'F-count': 'P1/P3', 'F-count-prose': 'P3' };
  const notes = {
    'F-path': '读源文件当数据',
    'F-line': report.lineStatus ? `其中 ${report.lineStatus['stale-missing'] || 0} stale-missing / ${report.lineStatus['stale-out-of-range'] || 0} stale-out-of-range / ${report.lineStatus['at-risk'] || 0} at-risk` : '',
    'F-list': '硬编码身份名单',
    'F-count': '具名数量常量 / 期望表项',
    'F-count-prose': 'opt-in：注释里的计数声明',
  };
  for (const fam of order) {
    const n = report.summary.byFamily[fam] || 0;
    if (!report.families.includes(FAMILY_NAME_REVERSE[fam])) continue;
    const reg = report.hits.filter((h) => h.family === fam && h.registered).length;
    lines.push(`  ${fam.padEnd(14)}(${sevLabel[fam]}) ${String(n).padStart(4)} 站点   registered ${reg}    ← ${notes[fam]}`);
  }
  const unregP1 = unregisteredOf(report.hits, new Set(['P1'])).length;
  const unregP23 = unregisteredOf(report.hits, new Set(['P2', 'P3'])).length;
  lines.push(`  ── 未登记 P1 = ${unregP1}${unregP23 ? `（另有 P2/P3 未登记 ${unregP23}）` : ''}（--check 将 exit ${unregP1 > 0 ? 1 : 0}）`);
  lines.push(`  ── 有意不报：import 说明符 ${report.stats.excludedImportSpecifiers} ｜ CJS require ${report.stats.excludedCjsRequires} ｜ 内联计数字面量 ${report.stats.inlineCountLiterals} ｜ count-prose ${report.stats.countProse} ｜ 仓外目标 ${report.stats.outOfRepoRefs} ｜ 同名歧义 ${report.stats.ambiguousBasenames}`);
  if (report.registry.expired > 0) lines.push(`  WARN: ${report.registry.expired} 条登记已过复审期（不影响退出码）`);
  const incomplete = report.hits.filter((h) => h.registryWarning).length;
  if (incomplete > 0) lines.push(`  WARN: ${incomplete} 条登记缺 reason/note（无 note 的登记视为无效）`);

  const top = opts.top;
  for (const fam of order) {
    if (!report.families.includes(FAMILY_NAME_REVERSE[fam])) continue;
    const famHits = report.hits.filter((h) => h.family === fam && !h.registered);
    if (!famHits.length) continue;
    const shown = top < 0 ? famHits : famHits.slice(0, top);
    if (opts.top !== 0) lines.push(`  ${fam} 前 ${shown.length} 条（未登记）：`);
    for (const h of shown) {
      const tgt = h.target && h.target.path ? ` → ${h.target.path}${h.target.status && h.target.status !== 'n/a' ? `(${h.target.status}${h.target.lines !== null ? `, ${h.target.lines} 行` : ''})` : ''}` : '';
      lines.push(`    ${h.file}:${h.line}  [${h.severity}]${tgt}  ${h.hit.slice(0, 110)}`);
    }
  }
  lines.push('  提示：全量用 --json；登记骨架用 --print-registry-candidates');
  return lines.join('\n');
}

// ── 输出：JSON（§4.3 契约）──────────────────────────────────────────────────
function jsonReport(report) {
  return JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      root: report.root,
      head: report.head,
      families: report.families,
      summary: report.summary,
      hits: report.hits.map((h) => ({
        family: h.family,
        severity: h.severity,
        file: h.file,
        line: h.line,
        hit: h.hit,
        target: h.target,
        breaksWhen: h.breaksWhen,
        blindTo: h.blindTo,
        gates: h.gates,
        registered: h.registered,
      })),
      stats: report.stats,
      durationMs: Number(report.durationMs.toFixed(1)),
    },
    null,
    2,
  );
}

function registryCandidatesReport(report) {
  const entries = report.hits
    .filter((h) => !h.registered)
    .map((h) => {
      const { id, sha8 } = registryIdOf(h);
      return {
        id,
        file: h.file,
        family: h.family,
        hitSha8: sha8,
        lineAtRegistration: h.line,
        reason: '<authoritative-source|behavior-count|fixture|loud-guard|superseded>',
        note: '<必填：为什么这条脆点可接受（无 note 的登记视为无效）>',
        addedAt: new Date().toISOString().slice(0, 10),
        addedBy: '<batch/xxx>',
        review: '<YYYY-MM-DD>',
      };
    });
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, entries }, null, 2);
}

// ── 判别力自证样本（§3.11）──────────────────────────────────────────────────
// text 为**逐字**片段（H = 现 HEAD；P = 父提交 d5f7b69^）；块级族样本含逐字上下文。
const SELFTEST_SAMPLES = [
  // ── 正样本 13（10 H + 3 P）────────────────────────────────────────────────
  {
    id: 'SP-1',
    kind: 'positive',
    family: 'F-path',
    file: 'test/api-evt.test.js',
    expectSeverity: 'P1',
    text: "const apiSrc = fs.readFileSync(new URL('../lib/api.js', import.meta.url), 'utf8');",
  },
  {
    id: 'SP-2',
    kind: 'positive',
    family: 'F-path',
    file: 'test/consume-deps-asymmetry-gate.test.js',
    expectSeverity: 'P1',
    text: "  const ts = read('lib/wave-plan.ts');",
  },
  {
    id: 'SP-3',
    kind: 'positive',
    family: 'F-path',
    file: 'test/merge-agent.test.js',
    source: 'd5f7b69^',
    text: "const src = fs.readFileSync(fileURLToPath(new URL('../lib/tools/lane-tools.js', import.meta.url)), 'utf8');",
  },
  {
    id: 'SP-4',
    kind: 'positive',
    family: 'F-line',
    file: 'test/artifact-types.test.js',
    expectStatus: 'stale-out-of-range',
    expectSeverity: 'P2',
    text: '//          `lib/tools/core.js:996`（`artifact_types` 工具）。',
  },
  {
    id: 'SP-5',
    kind: 'positive',
    family: 'F-line',
    file: 'test/ac16-push-unconfirmed.test.js',
    expectStatus: 'at-risk',
    expectSeverity: 'P3',
    text: '//   **不是**失败也不是成功；上层（`lib/engine/dispatch.js:1333-1335`）据此**不写 member.dispatch**',
  },
  {
    id: 'SP-6',
    kind: 'positive',
    family: 'F-line',
    file: 'test/worktree-merge-fail-escapes.test.js',
    source: 'd5f7b69^',
    text: '//   `ensureOrch` 用 `mainRepoDir(root, sessionId, batchId)` = `<batchWtRoot>/_repo`（见 lib/tools/lane-tools.js:75）',
  },
  {
    id: 'SP-7',
    kind: 'positive',
    family: 'F-list',
    file: 'test/lane-session-bind.test.js',
    expectSeverity: 'P2',
    text: "  assert.deepEqual(pureWired.slice().sort(), ['asset-tools.js', 'handoff-tools.js', 'lane-worktree-tools.js', 'log-tools.js', 'member-tools.js', 'query-tools.js', 'shared.js'], '已接线且零两参的文件集（现算）');",
  },
  {
    id: 'SP-8',
    kind: 'positive',
    family: 'F-list',
    file: 'test/suite-consistency-and-hot.test.js',
    expectSeverity: 'P2',
    text: "const POST_LEGACY_DENY_ADDED = ['batch_control', 'batch_tasks_add', 'task_update', 'interrupt_agent', 'list_agents', 'wait_agent', 'spawn_teammate'];",
  },
  {
    id: 'SP-9',
    kind: 'positive',
    family: 'F-list',
    file: 'test/lane-session-bind.test.js',
    source: 'd5f7b69^',
    text: "'lib/tools/lane-tools.js': [/lane_worktree_create/, /lane_checkpoint'/, /lane_checkpoint_status/, /lane_worktree_merge/],",
  },
  {
    id: 'SP-10',
    kind: 'positive',
    family: 'F-count',
    file: 'scripts/smoke/lib/checks-k.mjs',
    expectLine: 1,
    expectSeverity: 'P3',
    // 逐字 5 行（:47-51）：identity gate 的派生层声明就在同一断言块内
    text: [
      'const EXPECTED_TOOLS_BARE = 26;',
      'const EXPECTED_TOOLS_FULL = 27;',
      '',
      '/** 冻结名单（唯一权威 = `test/tools.test.js` 的 `TOOL_NAMES`）。派生而非手抄 ⇒ 双源不一致即红。 */',
      'function frozenToolNames(repoRoot) {',
    ].join('\n'),
  },
  {
    id: 'SP-11',
    kind: 'positive',
    family: 'F-count',
    file: 'test/merge-agent.test.js',
    expectLine: 2,
    expectSeverity: 'P1',
    // 逐字 5 行（:274-278）：LIMITS 期望表
    text: [
      '  const LIMITS = Object.freeze({',
      "    'lane-tools.js': 51,",
      "    'lane-worktree-ops.js': 182,",
      "    'lane-worktree-tools.js': 237,",
      '  });',
    ].join('\n'),
  },
  {
    id: 'SP-12',
    kind: 'positive',
    family: 'F-count',
    file: 'test/auditlog-mount.test.js',
    expectSeverity: 'P1',
    text: 'const ROW_PROBE_COUNT = 16;   // PUNKY_PROBE_MULTIROW 造出的 row-* 条数',
  },
  {
    id: 'SP-13',
    kind: 'positive',
    family: 'F-count-prose',
    file: 'test/worktree-merge-fail-escapes.test.js',
    expectSeverity: 'P3',
    text: '//   物理层 `lib/tools/lane-worktree-ops.js` 182 逻辑行 = T2.6 上限、余量 0；契约层 `lane-worktree-tools.js` 237；',
  },

  // ── 负样本 5（本仓既有「加固形态」，必须零命中）────────────────────────────
  {
    id: 'SN-1',
    kind: 'negative',
    file: 'test/tools.test.js',
    text: '  assert.deepEqual(tools.map((t) => t.name).slice().sort(), TOOL_NAMES.slice().sort(),',
  },
  {
    id: 'SN-2',
    kind: 'negative',
    file: 'scripts/smoke/lib/checks-k.mjs',
    // 派生真源：F-list 不得报；F-path 可报但必须 P3（loudness gate：:53 existsSync 阳性对照在场）
    text: [
      'function frozenToolNames(repoRoot) {',
      "  const p = path.join(repoRoot, 'test', 'tools.test.js');",
      "  expect(fs.existsSync(p), '阳性对照失败：冻结名单定义点不存在（' + p + '）');",
      "  const src = fs.readFileSync(p, 'utf8');",
      '  const m = src.match(/const TOOL_NAMES\\s*=\\s*\\[([\\s\\S]*?)\\]/);',
      "  expect(Boolean(m), '阳性对照失败：test/tools.test.js 未找到 `const TOOL_NAMES = [...]`（冻结名单定义点）');",
    ].join('\n'),
    alsoPresent: { family: 'F-path', line: 2, severity: 'P3' },
  },
  {
    id: 'SN-3',
    kind: 'negative',
    file: 'scripts/readings-consistency.mjs',
    text: [
      '//   N = |D\\A|，**运行期算**。本件源码刻意**不含任何数量常量**（连期望差额也不写）：',
      '//       写死必致「加/删 helper ⇒ 假绿或假红」。',
    ].join('\n'),
  },
  {
    id: 'SN-4',
    kind: 'negative',
    file: 'test/concurrency-gate.test.js',
    text: "  assert.equal(dispatchMod.concurrencyLimitOf, undefined, '[退役锁] `limit` 归一纯函数已删除');",
  },
  {
    id: 'SN-5',
    kind: 'negative',
    file: 'scripts/check-vocab-counts.mjs',
    // 取 :19-20 逐字（:18 含 `scripts/evidence-guard.mjs:44`，那是真 F-line 站点，纳入会自相矛盾）
    text: [
      '//   本件**不写任何期望码数、不写词表条目数**，两侧集合全部运行期解析；缺口集非空时逐码打印',
      '//   （注释可照码自救灾），**不静默**。',
    ].join('\n'),
  },

  // ── 干扰项 7（看着像但不是；全部必须零命中 + 零候选）────────────────────────
  {
    id: 'SF-1',
    kind: 'noise',
    file: 'test/f2-lock-takeover.test.js',
    expectExcluded: { path: 'lib/lock.js', usage: 'url-import' },
    text: "const LOCK_MODULE_URL = pathToFileURL(fileURLToPath(new URL('../lib/lock.js', import.meta.url))).href;",
  },
  {
    id: 'SF-2',
    kind: 'noise',
    file: 'scripts/audit/tool-face-count.mjs',
    expectNoCandidate: true,
    text: '//   · **锚定 `HEAD:<path>`**（`git show` / `git ls-tree`）—— **零工作树 grep**（`.tmp-a2-audit/` 是',
  },
  {
    id: 'SF-3',
    kind: 'noise',
    file: 'test/ac16-push-unconfirmed.test.js',
    text: "  assert.equal(fx.calls.length, 1, '工具面必须恰被调用 1 次；实测=' + fx.calls.length);",
  },
  {
    id: 'SF-4',
    kind: 'noise',
    file: 'test/api-config.test.js',
    expectNoCandidate: true,
    text: "const TRUSTED_HEADERS = { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:3080' };",
  },
  {
    id: 'SF-5',
    kind: 'noise',
    file: 'test/aip-format.test.js',
    expectNoCandidate: true,
    text: "    ts: '2026-08-21T10:00:00.000Z',",
  },
  {
    id: 'SF-6',
    kind: 'noise',
    file: 'test/gate-lite-smoke.test.js',
    text: '  if (hits.length === 0) return;',
  },
  {
    // spec 的 6 条之外的第 7 条：`--mutate 3`（关掉 `://` 排除）的可达构造需要
    //   「URL 内嵌 `文件:NNN`」形态；本仓无天然样本，故按同形态构造（非逐字引用）。
    id: 'SF-7',
    kind: 'noise',
    file: 'test/fixtures/noise-url.js',
    expectNoCandidate: true,
    text: "const DOC_LINK = 'https://example.com/repo/lib/tools/core.js:996';",
  },
];

const MUTATE_DESCRIPTION = {
  1: '关掉 loudness gate（守卫在场也报 P1）',
  2: '关掉 F-line 的扩展名要求（端口/时间进候选）',
  3: '关掉 F-line 的 `://` 排除（URL 内嵌路径进候选）',
  4: '关掉 F-path 的用途排除（import/URL 说明符进候选）',
  5: '把 F-count 放宽为内联字面量（行为计数进命中）',
};

function runSelftest(index, opts) {
  const failures = [];
  const counts = { positive: [0, 0], negative: [0, 0], noise: [0, 0] };
  const byFamily = {}; // 展示位（不作判据）：各族正样本通过数
  const mutate = opts.mutate || 0;
  const detOpts = {
    familiesEnabled: new Set(FAMILIES),
    loudnessGate: mutate !== 1,
    identityGate: true,
    vetoUsage: mutate !== 4,
    mutate,
  };
  for (const sample of SELFTEST_SAMPLES) {
    const ctx = buildContext(index, sample.file, sample.text);
    const res = scanContext(index, ctx, detOpts);
    const hits = dedupeHits(res.hits);
    const bucket = sample.kind;
    counts[bucket][1] += 1;
    const problems = [];
    if (bucket === 'positive') {
      const wantLine = sample.expectLine || 1;
      const got = hits.find((h) => h.family === sample.family && h.line === wantLine);
      if (!got) {
        problems.push(`期望 ${sample.family} 命中第 ${wantLine} 行，实测命中 = ${JSON.stringify(hits.map((h) => `${h.family}@${h.line}`))}`);
      } else {
        if (sample.expectSeverity && got.severity !== sample.expectSeverity) problems.push(`期望 severity=${sample.expectSeverity}，实测=${got.severity}`);
        if (sample.expectStatus && got.target.status !== sample.expectStatus) problems.push(`期望 status=${sample.expectStatus}，实测=${got.target.status}`);
      }
      // 断言 C：族间不串味（不得靠别的族「蒙对」）
      const others = [...new Set(hits.map((h) => h.family).filter((f) => f !== sample.family))];
      if (others.length) problems.push(`族间串味：另命中 ${others.join(',')}`);
      // opt-in 语义：count-prose 关掉时该样本必须不命中
      if (sample.family === 'F-count-prose') {
        const offOpts = { ...detOpts, familiesEnabled: new Set(DEFAULT_FAMILIES) };
        const off = dedupeHits(scanContext(index, buildContext(index, sample.file, sample.text), offOpts).hits);
        if (off.some((h) => h.family === sample.family)) problems.push('默认关的 count-prose 在关闭态仍命中');
      }
    } else {
      const allowed = sample.alsoPresent
        ? hits.filter((h) => h.family === sample.alsoPresent.family && h.line === sample.alsoPresent.line)
        : [];
      const unexpected = hits.filter((h) => !allowed.includes(h));
      if (unexpected.length) problems.push(`期望零命中（除声明的附带命中外），实测 = ${JSON.stringify(unexpected.map((h) => `${h.family}@${h.line}`))}`);
      if (sample.expectNoCandidate && res.lineCandidates.length) {
        problems.push(`期望零 F-line 候选，实测候选 = ${JSON.stringify(res.lineCandidates.map((c) => `${c.path}:${c.n}`))}`);
      }
      if (sample.expectExcluded) {
        const found = res.excluded.some((e) => e.path.endsWith(sample.expectExcluded.path) && e.usage === sample.expectExcluded.usage);
        if (!found) problems.push(`期望被用途排除（${sample.expectExcluded.path} / ${sample.expectExcluded.usage}），实测排除集 = ${JSON.stringify(res.excluded.map((e) => `${e.path}/${e.usage}`))}`);
      }
      if (sample.alsoPresent) {
        const ap = sample.alsoPresent;
        const got = hits.find((h) => h.family === ap.family && h.line === ap.line);
        if (!got) problems.push(`期望附带 ${ap.family} 命中第 ${ap.line} 行（受守卫约束），实测未命中`);
        else if (ap.severity && got.severity !== ap.severity) problems.push(`期望附带 ${ap.family} 第 ${ap.line} 行 severity=${ap.severity}，实测=${got.severity}`);
      }
    }
    if (problems.length) failures.push({ id: sample.id, problems });
    else {
      counts[bucket][0] += 1;
      if (bucket === 'positive') {
        byFamily[sample.family] = byFamily[sample.family] || [0, 0];
        byFamily[sample.family][0] += 1;
      }
    }
    if (bucket === 'positive') {
      byFamily[sample.family] = byFamily[sample.family] || [0, 0];
      byFamily[sample.family][1] += 1;
    }
  }
  return { failures, counts, byFamily, mutate };
}

function selftestReport(result, opts) {
  const lines = [];
  const mutate = result.mutate;
  lines.push(`fragility selftest${mutate ? `（--mutate ${mutate}：${MUTATE_DESCRIPTION[mutate]}）` : ''}`);
  lines.push(`  正样本 ${result.counts.positive[0]}/${result.counts.positive[1]} · 负样本 ${result.counts.negative[0]}/${result.counts.negative[1]} · 干扰项 ${result.counts.noise[0]}/${result.counts.noise[1]}`);
  const famLine = Object.keys(result.byFamily)
    .map((f) => `${f} ${result.byFamily[f][0]}/${result.byFamily[f][1]}`)
    .join(' · ');
  if (famLine) lines.push(`  按族（正样本）：${famLine}`);
  lines.push('  断言面：A 正样本全覆盖（族+行+severity/status）｜B 负样本零命中｜C 族间不串味｜D 干扰项零命中+零候选｜E 变异可达');
  if (mutate) {
    if (result.failures.length) {
      lines.push(`  变异态生效：自测按预期转红，点名 ${result.failures.map((f) => f.id).join(', ')}`);
      for (const f of result.failures) lines.push(`    FAIL ${f.id}: ${f.problems.join('；')}`);
      lines.push('  ⇒ 结论：该去误报规则是承重的（自证非恒真）。退出码按「断言红 ⇒ 1」返回，调用方以本行为通过标志');
      return { text: lines.join('\n'), ok: false, red: true, named: result.failures.map((f) => f.id) };
    }
    lines.push('  变异态未生效：自测仍全绿 ⇒ 该去误报规则不是承重的，自证无杀伤力（红）');
    return { text: lines.join('\n'), ok: false, red: false, named: [] };
  }
  if (result.failures.length) {
    for (const f of result.failures) lines.push(`    FAIL ${f.id}: ${f.problems.join('；')}`);
    lines.push('  结论：自测红（判别力不足，禁止提交）');
    return { text: lines.join('\n'), ok: false };
  }
  lines.push('  结论：全绿（正样本必中 / 负样本与干扰项零命中 / 族间不串味）');
  return { text: lines.join('\n'), ok: true };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    root: process.cwd(),
    families: null,
    json: false,
    check: false,
    strictAll: false,
    stats: false,
    registry: null,
    printCandidates: false,
    top: 20,
    selftest: false,
    mutate: 0,
    help: false,
  };
  // 支持 `--opt value` 与 `--opt=value` 两种写法（AC-4 与 §4.1 分别使用过两种形态）
  const VALUE_OPTS = new Set(['--root', '--family', '--registry', '--top', '--mutate']);
  for (let i = 0; i < argv.length; i += 1) {
    let a = argv[i];
    let inline;
    const eq = a.indexOf('=');
    if (/^--[^=]+=/.test(a)) {
      inline = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    const need = () => {
      if (inline !== undefined) return inline;
      if (i + 1 >= argv.length) fail(`参数 ${a} 缺值`);
      i += 1;
      return argv[i];
    };
    if (VALUE_OPTS.has(a)) {
      const v = need();
      if (a === '--root') opts.root = path.resolve(v);
      else if (a === '--family') opts.families = v;
      else if (a === '--registry') opts.registry = path.resolve(v);
      else if (a === '--top') opts.top = Number(v);
      else if (a === '--mutate') opts.mutate = Number(v);
      continue;
    }
    if (a === '--json') opts.json = true;
    else if (a === '--check') opts.check = true;
    else if (a === '--strict-all') opts.strictAll = true;
    else if (a === '--stats') opts.stats = true;
    else if (a === '--print-registry-candidates') opts.printCandidates = true;
    else if (a === '--selftest') opts.selftest = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else fail(`未知参数 ${a}`);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (!Number.isInteger(opts.top) || opts.top < -1) fail('--top 须为整数（≥ -1）');
  if (opts.mutate && !Number.isInteger(opts.mutate)) fail('--mutate 须为整数');
  if (opts.mutate && (opts.mutate < 1 || opts.mutate > 5)) fail('--mutate 取值域 1..5');
  if (opts.mutate && !opts.selftest) fail('--mutate 只能与 --selftest 连用');
  if (opts.selftest && opts.check) fail('--selftest 不得与 --check 同用');
  const familyTokens = (opts.families || DEFAULT_FAMILIES.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  const unknownFamily = familyTokens.find((t) => !FAMILIES.includes(t));
  if (unknownFamily) fail(`未知 --family token：${unknownFamily}（合法值：${FAMILIES.join(',')}）`);

  const root = opts.root;
  if (!fs.existsSync(path.join(root, 'package.json')) || !fs.existsSync(path.join(root, 'lib'))) {
    fail(`--root 非适用环境（须含 package.json 与 lib/）：${root}`);
  }
  const index = buildIndex(root);

  if (opts.selftest) {
    const result = runSelftest(index, opts);
    const report = selftestReport(result, opts);
    process.stdout.write(`${report.text}\n`);
    process.exit(report.ok ? 0 : 1);
  }

  const families = familyTokens; // JSON 契约 §4.3：families 为 token 列表（path/line/list/…）
  const scanOpts = {
    familiesEnabled: new Set(familyTokens),
    loudnessGate: true,
    identityGate: true,
    vetoUsage: true,
    mutate: 0,
  };
  const scan = runScan(index, scanOpts);
  const registry = loadRegistry(opts.registry || path.join(root, 'scripts', 'audit', 'fragility-registry.json'));
  const registryInfo = attachRegistry(scan.hits, registry);
  const summary = summarize(scan.hits);
  const lineStatus = {};
  for (const h of scan.hits) {
    if (h.family !== 'F-line') continue;
    lineStatus[h.target.status] = (lineStatus[h.target.status] || 0) + 1;
  }
  const report = {
    root,
    head: readHeadSha(root),
    families,
    summary,
    hits: scan.hits,
    stats: scan.stats,
    durationMs: scan.durationMs,
    lineStatus,
    registry: { present: registry.present, expired: registryInfo.expired, entries: registry.entries.length },
  };

  if (opts.printCandidates) {
    process.stdout.write(`${registryCandidatesReport(report)}\n`);
    process.exit(0);
  }
  if (opts.json) {
    process.stdout.write(`${jsonReport(report)}\n`);
  } else {
    process.stdout.write(`${humanReport(report, opts)}\n`);
    if (opts.stats) {
      process.stdout.write(`  stats: ${JSON.stringify(report.stats)}\n`);
    }
  }

  // 退出码（§4.2 / AC-10）：门禁语义只在 --check / --strict-all 下生效；
  //   默认人读模式为信息面（AC-9①：缺省无 registry ⇒ 不因缺表而失败）。
  const gateSet = opts.strictAll ? new Set(['P1', 'P2', 'P3']) : new Set(['P1']);
  const blocking = unregisteredOf(scan.hits, gateSet).length;
  process.exit(opts.check || opts.strictAll ? (blocking > 0 ? 1 : 0) : 0);
}

main();
