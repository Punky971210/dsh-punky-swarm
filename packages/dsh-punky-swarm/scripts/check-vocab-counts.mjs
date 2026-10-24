#!/usr/bin/env node
// 只读机检：**词表底料**（`lib/state/vocabulary.json`）与**发射码**（`lib/**/*.ts`）的一致性。
//
// 用法：
//   node scripts/check-vocab-counts.mjs            人读输出
//   node scripts/check-vocab-counts.mjs --json     机读输出
//
// 退出码（与 `scripts/check-guidance-sync.mjs` 同档）：0 = 全绿；1 = 有缺口；2 = 参数错误。
//
// 职责**恰好两条**（多一条即越界，见 `plan/p2-taskpack-2.md` K-4）：
//   ① **发射码 ⊆ 词表**：解析 `lib/**/*.ts` 的 `code: 'GATE_…'` 字面量与
//      `throw new Error('GATE_…: …')` 发射点，得发射码集；与 `vocabulary.json` 中 `kind:'gate'`
//      的 `code` 集比对 ⇒ 缺口必须为 0（缺一个 = 真实发射的拒码没登记进词表）。
//   ② **底料不含标识符**：底料 code 集 ∩「仅标识符」token 集必须为 ∅。
//      「仅标识符」= 在 `lib/**/*.ts` 里**只以裸标识符形态**出现、从不以字符串字面量形态出现的
//      `GATE_*` token（正则名 / 常量名 / 前缀 / 开关名）——按正则全量灌词表正是从这类 token 灌进来的。
//
// 计数纪律（对齐 `scripts/evidence-guard.mjs:44`「A/B 两侧一律运行期计算，禁写期望值」）：
//   本件**不写任何期望码数、不写词表条目数**，两侧集合全部运行期解析；缺口集非空时逐码打印
//   （注释可照码自救灾），**不静默**。
//
// 【口径边界 · 刻意不判】`vocabulary.json` 的 `meta.counts` 是**声明值**，本件**不读、不比对**：
//   该面设计上不做真值比对（`test/vocabulary.test.js` 的 A3 已明记「写死数值会让邻居 lane 合法新增误红」），
//   把声明值升成判据会造出「必假红的第二真源」。本件对该面**零判定性引用**（不以它作任何比较的操作数），
//   即 AC-9 的机检口径。
//
// 扫描面：`lib/**` 下的 `.ts` 源，**排除** `*.d.ts`（生成物的注释里满是码名，纳入即污染集合）
//   与 `node_modules` / `.git` / `.tsbuild` / `out`。`lib/**` 的 `.js` 是 `tsc` 产物（`.ts` 的镜像），
//   唯一例外 `lib/state/vocabulary.js` 无 `.ts` 源但其内容不含 `GATE_*` 发射位 ⇒ 两侧口径一致。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SCAN_ROOT = path.join(ROOT, 'lib');
const VOCAB_ABS = path.join(ROOT, 'lib', 'state', 'vocabulary.json');
const VOCAB_KIND = 'gate';

// 目录剪枝：产物目录 / 依赖目录 / VCS 目录一律不进扫描面。
const PRUNE_DIRS = new Set(['node_modules', '.git', '.tsbuild', 'out']);

// ── 参数解析（fail-closed：未知参数 ⇒ 用法打 stderr、exit 2）────────────────────────────
function parseArgs(argv) {
  const args = { json: false };
  for (const a of argv) {
    if (a === '--json') { args.json = true; continue; }
    return { error: `unknown argument: ${a}` };
  }
  return { args };
}

// ── 扫描面：`lib/**/*.ts`（排 `*.d.ts`）──────────────────────────────────────────────
function collectTs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (PRUNE_DIRS.has(e.name)) continue;
      collectTs(p, out);
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

// ── 逐字符状态机：区分「字符串字面量内」与「裸标识符」，并给出注释区间 ────────────────────
// 为什么要状态机而不是正则：拒码既可以是整条字面量（`code: 'GATE_X'`，token 两侧都是引号），
//   也可以是字面量的**前缀**（`throw new Error('GATE_X: msg')`，token 后面是冒号）。
//   「两侧都是引号」的判法会把后者误判成标识符 —— 那正是 R-02 之外的另一类假红/假绿来源。
// 返回值：[{sym, inString, index}]
function classify(text) {
  const occurrences = [];
  let i = 0;
  let state = 'code'; // code | line-comment | block-comment | single | double | template
  const symAt = (at) => {
    const m = /^GATE_[A-Z0-9_]*[A-Z0-9_]/.exec(text.slice(at));
    return m ? m[0] : null;
  };
  const prevIsWord = (at) => at > 0 && /[A-Za-z0-9_]/.test(text[at - 1]);

  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];

    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line-comment'; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block-comment'; i += 2; continue; }
      if (c === "'") { state = 'single'; i++; continue; }
      if (c === '"') { state = 'double'; i++; continue; }
      if (c === '`') { state = 'template'; i++; continue; }
      if (text.startsWith('GATE_', i) && !prevIsWord(i)) {
        const sym = symAt(i);
        if (sym) { occurrences.push({ sym, inString: false, index: i }); i += sym.length; continue; }
      }
      i++; continue;
    }

    if (state === 'line-comment') {
      if (c === '\n') state = 'code';
      i++; continue;
    }

    if (state === 'block-comment') {
      if (c === '*' && n === '/') {
        state = 'code';
        i += 2; continue;
      }
      i++; continue;
    }

    // 三种字符串状态
    if (c === '\\') { i += 2; continue; }
    if ((state === 'single' && c === "'") || (state === 'double' && c === '"')
      || (state === 'template' && c === '`')) {
      state = 'code';
      i++; continue;
    }
    if (text.startsWith('GATE_', i) && !prevIsWord(i)) {
      const sym = symAt(i);
      if (sym) { occurrences.push({ sym, inString: true, index: i }); i += sym.length; continue; }
    }
    i++; continue;
  }
  return occurrences;
}

// 发射位扫描：只认**代码位置**的两类形态。用 classify 的 inString 位做守卫（而非裸正则），
//   因为 `code: 'GATE_X'` 里的 token 一定在字符串内；注释里的同名文本不会出现在 inString 集合。
const CODE_LITERAL_RE = /code\s*:\s*'((?:GATE)_[A-Z0-9_]+)'/g;
const THROW_LITERAL_RE = /throw\s+new\s+Error\(\s*'((?:GATE)_[A-Z0-9_]+)\s*:/g;

function emissionsOf(files) {
  const inStringByFile = new Map();
  const bareByFile = new Map();
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const occurrences = classify(text);
    const inString = new Set();
    const bare = new Set();
    for (const o of occurrences) (o.inString ? inString : bare).add(o.sym);
    inStringByFile.set(f, { text, inString });
    bareByFile.set(f, bare);
  }

  // 发射码集 = `code: 'GATE_…'` ∪ `throw new Error('GATE_…: …')`，且该码在本文件内确有字符串形态。
  const emitted = new Map(); // code -> [relpath:line]
  for (const [f, { text, inString }] of inStringByFile) {
    for (const re of [CODE_LITERAL_RE, THROW_LITERAL_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const code = m[1];
        if (!inString.has(code)) continue; // 命中在注释里（该码在本文件无字符串形态）⇒ 非发射位
        const line = text.slice(0, m.index).split('\n').length;
        if (!emitted.has(code)) emitted.set(code, []);
        const where = `${rel(f)}:${line}`;
        if (!emitted.get(code).includes(where)) emitted.get(code).push(where);
      }
    }
  }

  // 「仅标识符」token 集 = 全扫描面内**从无**字符串形态的 `GATE_*` token。
  const inStringAll = new Set();
  const bareAll = new Set();
  for (const [, v] of inStringByFile) for (const s of v.inString) inStringAll.add(s);
  for (const [, v] of bareByFile) for (const s of v) bareAll.add(s);
  const identifierOnly = [...bareAll].filter((s) => !inStringAll.has(s)).sort();
  return { emitted, identifierOnly, fileCount: files.length };
}

// ── 词表底料读端（只读：本件不改词表、不比对 meta.counts）─────────────────────────────
function vocabularyGateCodes() {
  const raw = fs.readFileSync(VOCAB_ABS, 'utf8');
  const doc = JSON.parse(raw);
  const entries = Array.isArray(doc.entries) ? doc.entries : [];
  const codes = new Set();
  for (const e of entries) {
    if (e && e.kind === VOCAB_KIND && typeof e.code === 'string') codes.add(e.code);
  }
  return { codes, entryCount: entries.length };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`[vocab] usage error: ${parsed.error}\n`);
    process.stderr.write('[vocab] usage: node scripts/check-vocab-counts.mjs [--json]\n');
    process.exit(2);
  }
  const { json } = parsed.args;

  if (!fs.existsSync(SCAN_ROOT)) {
    process.stderr.write(`[vocab] scan root missing: ${SCAN_ROOT}\n`);
    process.exit(2);
  }

  const failures = [];
  let vocab;
  try {
    vocab = vocabularyGateCodes();
  } catch (e) {
    process.stderr.write(`[vocab] vocabulary unreadable: ${VOCAB_ABS}（${(e && e.message) || String(e)}）\n`);
    process.exit(1);
  }

  const files = collectTs(SCAN_ROOT);
  const { emitted, identifierOnly } = emissionsOf(files);

  // ① 发射码 ⊆ 词表
  const gapCodes = [...emitted.keys()].filter((c) => !vocab.codes.has(c)).sort();
  for (const c of gapCodes) {
    failures.push({
      check: 'emission-subset',
      detail: `${c} 由 ${emitted.get(c).join(', ')} 发射，但未登记进词表 kind:'gate'`,
      code: c,
    });
  }

  // ② 底料不含标识符
  const identInVocab = [...vocab.codes].filter((c) => identifierOnly.includes(c)).sort();
  for (const c of identInVocab) {
    failures.push({
      check: 'no-identifier',
      detail: `${c} 在 lib/**/*.ts 内只有裸标识符形态（无字符串形态）⇒ 不是码，不得进词表`,
      code: c,
    });
  }

  const result = {
    ok: failures.length === 0,
    scan: { root: rel(SCAN_ROOT), tsFiles: files.length, excludes: [...PRUNE_DIRS].sort().concat(['*.d.ts']) },
    emission: { total: emitted.size, codes: [...emitted.keys()].sort() },
    vocabulary: { path: rel(VOCAB_ABS), kind: VOCAB_KIND, total: vocab.codes.size },
    identifierOnly: { total: identifierOnly.length, codes: identifierOnly },
    gap: gapCodes,
    failures,
  };

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(`[vocab] 扫描面 lib/**/*.ts 文件数=${files.length}（排 *.d.ts / node_modules / .git / .tsbuild / out）\n`);
    process.stdout.write(`[vocab] 发射码=${emitted.size}｜词表 kind:'gate' 条码=${vocab.codes.size}（entries=${vocab.entryCount}）\n`);
    process.stdout.write(`[vocab] 仅标识符 token=${identifierOnly.length}\n`);
    process.stdout.write(`[vocab] ① 发射码 ⊆ 词表：缺口=${gapCodes.length}\n`);
    for (const c of gapCodes) process.stdout.write(`[vocab]   GAP ${c}  <= ${emitted.get(c).join(', ')}\n`);
    process.stdout.write(`[vocab] ② 底料不含标识符：命中=${identInVocab.length}\n`);
    for (const c of identInVocab) process.stdout.write(`[vocab]   BAD ${c}\n`);
    process.stdout.write(`[vocab] ${failures.length === 0 ? 'GREEN' : 'RED'} failures=${failures.length}\n`);
  }

  process.exit(failures.length === 0 ? 0 : 1);
}

main();
