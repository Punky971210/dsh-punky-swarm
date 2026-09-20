// scripts/audit/gates.mjs —— 门禁台账：以**拒码真源**为口径，逐码统计生产抛出点 / 测试断言点
//   用法：cd packages/dsh-punky-swarm
//     node scripts/audit/gates.mjs            # 生成台账（scripts/audit/out/gate-ledger.json）
//     node scripts/audit/gates.mjs --check    # 与留档基线比对漂移（**默认不阻断**，退出码恒 0）
//
// ── 口径演进（2026-09-21，两次勘误，均由「乐观污染」触发）────────────────────────
// v1（原始）：在**源码原文**上数 `\bGATE_[A-Z0-9_]+\b`，把一切 `GATE_*` 标识符当门禁码。
//   三重失真：① 注释里提到某码 = 「有断言/有生产引用」；② 模板拼接前缀（`'GATE_EXIT_MISSING_' + layer`）
//   被截成码；③ **非码标识符**（环境变量名 / 正则常量 / 已退役码的提及）被当码收录。
//   实测后果：在新增测试的注释里写一句 `GATE_ARTIFACT_MISSING`，其 `testHits` 由 0 变非 0
//   ⇒ `--check` 误报「已消除无断言项」。**乐观方向的污染比漏报危险**：它让「没覆盖」看起来像「已覆盖」。
// v2：**注释屏蔽**（见 `shieldComments`；刻意**不**屏蔽字符串——断言普遍写成 `'GATE_X'` 字面量，必须计入）。
// v3（本版）：**拒码真源 = `lib/types/contracts.ts` 的 `GateErrorCode` union**；正则只作**候选收集器**，
//   候选再按**出现上下文**分类，非码一律移出「门禁码」口径：
//     · `typed`        —— union 成员（类型化拒码，随 `GateFail.code` 载荷）
//     · `thrown`       —— 不在 union，但有 `throw new Error('X…')` 抛点（直抛族，无 GateResult 载荷）
//     · `regexConst`   —— `const GATE_X_RE = /…/` 声明的**正则常量**（不是码）
//     · `envVar`       —— `process.env.GATE_X` / `envNumber('GATE_X')` 之类**环境变量名**（不是码）
//     · `ghost`        —— 严格前缀于同集合内另一码者（正则从模板拼接处截出的残片）
//     · `mention`      —— 只在字符串/日志文本里被提及，既无抛点也不在 union（多为**已退役码**的留痕说明）
//   「无断言门禁」判定面 = `kind ∈ {typed, thrown}` 且有生产引用但测试零命中。
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const OUT = join(ROOT, 'scripts', 'audit', 'out');
const SKIP = new Set(['node_modules', '.git', '.tsbuild', '.wip-backup', 'backups', 'baselines', 'out']);
const SELF_AUDIT = join(ROOT, 'scripts', 'audit');
const BASELINE = join(ROOT, 'docs', 'audit-2026-09-21-gate-ledger.json');
const CHECK = process.argv.includes('--check');

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const f = join(dir, e.name);
    if (f === SELF_AUDIT) continue;
    if (e.isDirectory()) walk(f, out);
    else out.push(f);
  }
  return out;
}
// 统一正斜杠：原实现用 `rel(f).endsWith('state/gates.ts')` 做判定，在 Windows 上 `rel` 返回反斜杠
//   ⇒ 该判定**恒假**，`selfDef` 长期恒 0（静默失效的度量）。本版统一 normalize。
const rel = (f) => relative(ROOT, f).split(sep).join('/');

// ── 词法屏蔽：只去注释，保留字符串 ──────────────────────────────────────────────
// 单趟状态机（code / 行注释 / 块注释 / 字符串）；注释体替换为等长空格，**保留换行**（行号不漂）。
function shieldComments(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out[i] = ' '; i++; }
      continue;
    }
    if (c === '/' && d === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] !== '\n') out[i] = ' '; i++; }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        if (src[i] === '\n' && q !== '`') break;
        i++;
      }
      continue;
    }
    i++;
  }
  return out.join('');
}

// ── 拒码真源：`GateErrorCode` union ────────────────────────────────────────────
// 刻意从**屏蔽注释后**的正文里取：union 内被注销的成员是以注释形式留痕的（`//   \`'GATE_X'\` 已删除`），
//   屏蔽后它们自然不入选 ⇒ 真源与「已删」留痕自动一致，不需另写退役名单。
const CONTRACTS = join(ROOT, 'lib', 'types', 'contracts.ts');
function unionMembers() {
  if (!existsSync(CONTRACTS)) return new Set();
  const src = shieldComments(readFileSync(CONTRACTS, 'utf8'));
  const m = src.match(/export type GateErrorCode\s*=\s*([\s\S]*?);/);
  if (!m) return new Set();
  return new Set((m[1].match(/'GATE_[A-Z0-9_]+'/g) || []).map((s) => s.slice(1, -1)));
}
const UNION = unionMembers();

const libFiles = walk(join(ROOT, 'lib')).filter((f) => /\.(ts|js)$/.test(f) && !/\.d\.ts$/.test(f));
const testFiles = walk(join(ROOT, 'test'));

const libSrc = libFiles.map((f) => ({ f, rel: rel(f), text: shieldComments(readFileSync(f, 'utf8')) }));

const gateRe = /\bGATE_[A-Z0-9_]+\b/g;
const ids = new Set();
for (const { text } of libSrc) for (const m of text.match(gateRe) || []) ids.add(m);
for (const id of UNION) ids.add(id); // 真源兜底：union 里声明但本仓暂无字面量的码也要在册

// 出现上下文（判 kind 用）——全部在屏蔽注释后的正文上判
// 环境变量名：**限定 env 系助手名**（`envNumber` / `envString` / …）或 `process.env.X`。
//   ⚠ 早期版本写成「任意 `f('GATE_X')` 调用」，会把 `someFn('GATE_X')` 这类真实码用法误判为环境变量。
const ENV_CALL_RE = (id) => new RegExp(`\\b(?:[a-z]*[Ee]nv[A-Za-z_$]*)\\s*\\(\\s*['"\`]${id}['"\`]`);
const ENV_MEMBER_RE = (id) => new RegExp(`process\\.env(?:\\.${id}\\b|\\[\\s*['"\`]${id}['"\`]\\s*\\])`);
const REGEX_CONST_RE = (id) => new RegExp(`\\b(?:const|let|var)\\s+${id}\\s*=\\s*/`);
// 码值常量：`const <任意名> = 'GATE_X'`（单点声明的**真实码**；写点用标识符而非字面量 ⇒ 字面量检测看不到，
//   漏判会把真码误贬为「仅提及」。两个实测来源：`lib/state/store.js` 的 `GATE_EVENT_CONST_MISSING`（同名常量）、
//   `lib/engine/dispatch.js` 的 `MODE_INACTIVE_CODE = 'GATE_MODE_INACTIVE'`（**异名常量**，故不限定常量名）。
const CODE_CONST_RE = (id) => new RegExp(`\\b(?:const|let|var)\\s+[A-Za-z_$][\\w$]*\\s*=\\s*['"\`]${id}['"\`]`);
// 「被当作码值使用」三形态：① `throw new Error('X…')` ② 同行内 `code`/`codes`/`…Code` 附近出现该字面量
//   ③ `order = [... 'X']` / `.includes('X')` 等码表成员。②③ 用「同行邻域」近似（本仓风格高度一致）。
const CODE_USE_RE = (id) => new RegExp(
  `new\\s+Error\\(\\s*['"\`]${id}`
  + `|(?:^|[^A-Za-z0-9_$])codes?[A-Za-z_$]*\\b[^\\n]{0,60}?['"\`]${id}['"\`]`,
);

const rows = [];
for (const id of [...ids].sort()) {
  const re = new RegExp(`\\b${id}\\b`, 'g');
  const prod = [];
  let selfGates = 0;
  let envHits = 0;
  let codeUseHits = 0;
  let regexConstHits = 0;
  let codeConstHits = 0;
  for (const { rel: r, text } of libSrc) {
    const n = (text.match(re) || []).length;
    if (n) {
      prod.push(`${r}×${n}`);
      if (r.startsWith('lib/state/gates.')) selfGates += n;
    }
    envHits += (text.match(ENV_CALL_RE(id)) || []).length + (text.match(ENV_MEMBER_RE(id)) || []).length;
    codeUseHits += (text.match(CODE_USE_RE(id)) || []).length;
    regexConstHits += (text.match(REGEX_CONST_RE(id)) || []).length;
    codeConstHits += (text.match(CODE_CONST_RE(id)) || []).length;
  }
  const tst = [];
  for (const f of testFiles) {
    const n = (shieldComments(readFileSync(f, 'utf8')).match(re) || []).length;
    if (n) tst.push(`${rel(f)}×${n}`);
  }
  const idSet = [...ids];
  const aliasOf = idSet.sort().find((o) => o !== id && o.startsWith(id)) ?? null;
  let kind;
  if (UNION.has(id)) kind = 'typed';
  else if (codeConstHits > 0) kind = 'thrown';
  else if (regexConstHits > 0) kind = 'regexConst';
  else if (envHits > 0) kind = 'envVar';
  else if (aliasOf && id.endsWith('_')) kind = 'ghost';
  else if (codeUseHits > 0) kind = 'thrown';
  else if (aliasOf) kind = 'ghost';
  else kind = 'mention';
  rows.push({
    id, kind, inUnion: UNION.has(id), aliasOf: kind === 'ghost' ? aliasOf : null,
    selfGates, prod, prodFiles: prod.length,
    testFiles: tst.length, testHits: tst.reduce((a, s) => a + Number(s.split('×')[1]), 0),
    envHits, codeUseHits, codeConstHits, regexConstHits,
  });
}

const CODE_KINDS = new Set(['typed', 'thrown']);
function analyze(list) {
  const codes = list.filter((r) => CODE_KINDS.has(r.kind));
  const nonCodes = list.filter((r) => !CODE_KINDS.has(r.kind));
  const orphans = codes.filter((r) => r.prod.length === 0 && r.testHits === 0);
  const libOnly = codes.filter((r) => r.prod.length > 0 && r.testHits === 0);
  return { codes, nonCodes, orphans, libOnly };
}
const { codes, nonCodes, orphans, libOnly } = analyze(rows);
const byKind = (k) => nonCodes.filter((r) => r.kind === k);

if (CHECK) {
  if (!existsSync(BASELINE)) {
    console.log('!! 无留档基线：' + rel(BASELINE) + '（跳过 --check）');
  } else {
    const base = analyze(JSON.parse(readFileSync(BASELINE, 'utf8')));
    const bIds = new Set(base.codes.map((r) => r.id));
    const nIds = new Set(codes.map((r) => r.id));
    const added = [...nIds].filter((x) => !bIds.has(x)).sort();
    const gone = [...bIds].filter((x) => !nIds.has(x)).sort();
    const bLib = new Set(base.libOnly.map((r) => r.id));
    const nLib = new Set(libOnly.map((r) => r.id));
    const newUntested = [...nLib].filter((x) => !bLib.has(x)).sort();
    const fixed = [...bLib].filter((x) => !nLib.has(x)).sort();
    console.log('=== 门禁台账漂移比对（基线：' + rel(BASELINE) + '）===');
    console.log('拒码（typed+thrown）：基线 ' + base.codes.length + ' → 现 ' + codes.length);
    console.log('新增拒码 (' + added.length + ')：' + (added.join(' ') || '—'));
    console.log('消失拒码 (' + gone.length + ')：' + (gone.join(' ') || '—'));
    console.log('新增「无断言」项 (' + newUntested.length + ')：' + (newUntested.join(' ') || '—'));
    console.log('已消除「无断言」项 (' + fixed.length + ')：' + (fixed.join(' ') || '—'));
    console.log('（提示：漂移≠错误；冻结项会随新引擎形态合法变更。本模式**不阻断**、退出码恒 0。）');
  }
}

console.log(`GATE_* 标识符共 ${rows.length} 个：**拒码 ${codes.length}**（typed ${codes.filter((r) => r.kind === 'typed').length} + thrown ${codes.filter((r) => r.kind === 'thrown').length}）`
  + ` + 非码 ${nonCodes.length}（正则常量 ${byKind('regexConst').length} · 环境变量名 ${byKind('envVar').length} · 前缀伪影 ${byKind('ghost').length} · 仅提及 ${byKind('mention').length}）`);
console.log(`拒码真源：\`lib/types/contracts.ts\` 的 \`GateErrorCode\` union（${UNION.size} 成员）`);

console.log(`\n### 非码 GATE_* 标识符（**不得**计入门禁口径） (${nonCodes.length})`);
for (const k of ['regexConst', 'envVar', 'ghost', 'mention']) {
  const g = byKind(k);
  if (!g.length) continue;
  console.log(`  — ${k} (${g.length})`);
  for (const r of g) console.log(`      ${r.id.padEnd(34)} ${r.aliasOf ? '前缀 → ' + r.aliasOf : 'env=' + r.envHits + ' re=' + r.regexConstHits + ' prodFiles=' + r.prodFiles + ' testHits=' + r.testHits}`);
}

console.log(`\n### 无断言拒码：有生产引用但测试零命中 (${libOnly.length})`);
libOnly.forEach((r) => console.log(`  ${r.id.padEnd(34)} [${r.kind}]  prod=[${r.prod.join(' ')}]`));

console.log(`\n### 孤儿拒码：无生产引用且无测试断言 (${orphans.length})`);
orphans.forEach((r) => console.log(`  ${r.id}  [${r.kind}]`));

console.log('\n### 全量台账（⚠ = 测试零命中；非码标 kind）');
rows.sort((a, b) => (CODE_KINDS.has(a.kind) ? 0 : 1) - (CODE_KINDS.has(b.kind) ? 0 : 1) || a.testHits - b.testHits || a.id.localeCompare(b.id));
for (const r of rows) {
  const mark = !CODE_KINDS.has(r.kind) ? '·' : r.testHits === 0 ? '⚠' : ' ';
  console.log(`  ${mark} ${r.id.padEnd(34)} [${r.kind.padEnd(10)}] gates=${String(r.selfGates).padStart(3)}  prodFiles=${String(r.prodFiles).padStart(2)}  testFiles=${String(r.testFiles).padStart(2)}  testHits=${String(r.testHits).padStart(4)}`);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'gate-ledger.json'), JSON.stringify(rows, null, 2));
console.log('\n-> scripts/audit/out/gate-ledger.json');
