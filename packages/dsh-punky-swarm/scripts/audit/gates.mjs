// scripts/audit/gates.mjs —— 门禁台账：以**拒码真源**为口径，逐码统计生产抛出点 / 测试断言点
//   用法：cd packages/dsh-punky-swarm
//     node scripts/audit/gates.mjs            # 生成台账（scripts/audit/out/gate-ledger.json）
//     node scripts/audit/gates.mjs --check    # 与留档基线比对漂移（**默认不阻断**，退出码恒 0）
//                                             #   **唯一只读形态**：--check 之下不写盘
//     node scripts/audit/gates.mjs --check --write   # 比对**并**落盘（显式要求写盘时用）
//     node scripts/audit/gates.mjs --strict-drift    # 同上，但 KNOWN_DRIFT 短码校验失败 ⇒ exit 1
//                                             #   （默认 / --check 只打印读数、退出码不变；失败档不写盘）
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
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { classifyHits, strengthSelfTest } from './strength.mjs';

const ROOT = process.cwd();
const OUT = join(ROOT, 'scripts', 'audit', 'out');
const SKIP = new Set(['node_modules', '.git', '.tsbuild', '.wip-backup', 'backups', 'baselines', 'out']);
const SELF_AUDIT = join(ROOT, 'scripts', 'audit');
const BASELINE = join(ROOT, 'docs', 'audit-2026-09-21-gate-ledger.json');
const CHECK = process.argv.includes('--check');
const SELFTEST = process.argv.includes('--selftest');
// 唯一写闸（**D′ 取向**：只有 `--check` 只读）——
//   默认（无 --check）仍生成台账 ⇒ `gen-register.mjs` 的生成链零破坏；
//   `--check` 是审计比对形态，事故面（缺陷 A1-P3-06：只读审计环境被污染）只在这一档
//   ⇒ 本闸精确消灭该事故面，`--write` 可显式要求「比对 + 落盘」。
const WRITE = !CHECK || process.argv.includes('--write');

// 已登记漂移（**纯标注面**：不参与任何判定、不改退出码、不进 `codes`/`libOnly` 口径）
//   来源：2026-10-23 批 punky-fix-house-20261023（H-C2）逐码亲核 ——
//     新增 10 项：`git log --reverse --format='%h %s' -S <码> -- lib` 取引入提交；
//     消失 7 项：同法取末次变更提交（后 4 项为**注释留痕**态：已不在 union、无抛点，
//               以注释自陈的退役批 + 末次码面变更为据，可复算复核）。
//   ⚠ 本表**只允许追加**，且每条必须带 commit 短码（否则漂移会被"合法化"成不可归因）。
//   · `gone` 口径（A3-G04）= **不在 `lib/types/contracts.ts` 的 `GateErrorCode` union，且 `lib/**` 无
//     `throw new Error('<码>…` 抛点**；**不**表示「字面零提及」——该码仍可能以 `mention`（注释 / 日志 /
//     事件名）或 `ghost`（前缀残片）形态留在仓内。本表 7 条中 4 条即属此态（逐条读数见其 commit 短码行）。
//   · 短码取法**两类不同**（A3-G10）：`added` 用「引入提交」（`git log --reverse --format='%h' -S <码> -- lib`
//     的首条）；`gone` 后 4 项用「码面末次变更 / 退役提交」（该码可能从未有过独立引入提交）。
//     两类首 token **一律**参与 `assertDriftCommits()` 的机器校验 —— 口径混用不等于免检。
const KNOWN_DRIFT = {
  added: {
    GATE_CHANNEL_INVALID: '7e33f90 channel 通道归属',
    GATE_CHANNEL_UNRESOLVED: '7e33f90 channel 通道归属',
    GATE_HANDOFF_IDENTITY_UNKNOWN: '7e33f90 channel 通道归属',
    GATE_HANDOFF_OVERWRITE_UNDECLARED: '7e33f90 channel 通道归属（R-2 覆盖保护）',
    GATE_HANDOFF_UNAUTHORIZED: '7e33f90 channel 通道归属',
    GATE_ROSTER_INVALID: '7e33f90 channel 通道归属',
    GATE_DIFFICULTY_CHANNEL_UNRESOLVED: 'a4a2779 规格体系 P0/P1/P2 三波',
    GATE_SCRIPT_CHANGED: 'a4a2779 规格体系 P0/P1/P2 三波',
    GATE_CONSUME_DEPS_ASYMMETRY: 'c2bd46e consume×deps 建批期硬门',
    GATE_ROLE_UNRESOLVED: 'c2bd46e role 注入与指引重构',
  },
  gone: {
    GATE_TEAMS_ROOT_INVALID: '6922a0e 码退役',
    GATE_TEAMS_ROOT_ASSET_NOT_FOUND: '6922a0e 码退役',
    GATE_SKILL_MISSING: 'b8380a8 技能 recommend 不再设门禁',
    GATE_AUDIT_CONTRACT_EXEMPT: 'ec4efc2 团队资产退役（仅提及残留）',
    GATE_AUDIT_CONTRACT_MISSING: 'ec4efc2 团队资产退役（仅提及残留）',
    GATE_EXEC_INPUT_MISSING: 'ec4efc2 团队资产退役（仅提及残留）',
    GATE_ROLE_MISSING: 'cdfe509 cleanup-tail E-5 退役收尾（仅提及残留）',
  },
};

if (SELFTEST) {
  const n = strengthSelfTest();
  console.log(`[strength] 判别力自证通过：${n} 个用例（标题/整码/多行/弱/夹具/跨界边界）`);
  console.log('（探测器必须自证有分辨率；否则它本身可能空转 —— R3-4 教训。）');
  process.exit(0);
}

// ── KNOWN_DRIFT 短码**机器校验**（A3-G09/G10）────────────────────────────────────
//   判据 = 每条 value 的**首个 token** 必须是能在 git 中解析到的 commit
//   ⇒ 消灭「往表里塞个码/编个短码就把漂移合法化」这条路径（此前只靠人守，无机器校验）。
//   两档（默认不咬人、显式才阻断，避免破坏既有契约）：
//     · 默认 / `--check` —— 跑校验、打印读数，**退出码不变**（`--check` 既有契约：漂移≠错误、恒 0）；
//     · `--strict-drift` —— 校验失败 ⇒ **exit 1**，且**在写盘前**退出（失败档不留产物）。
//   无 `.git`（安装态 / npm 整包副本）⇒ **fail-open**：打印 skipped、不改退出码。理由同
//   `arch-check.mjs` 的「缺真源 = **不适用**而非错」：该形态下短码**无法核**，不是漂移。
//   ⚠ 判据用 `git rev-parse --git-dir` 而**不是** `existsSync(join(ROOT,'.git'))`：本仓是 monorepo，
//     `.git` 在**仓库根**、而本脚本的 `ROOT` = `process.cwd()` = **包目录**（用法行即 `cd packages/dsh-punky-swarm`）
//     ⇒ 探 `.git` 目录会恒为假，整条校验变成**永不开火的死代码**（静默失效的度量，正是本批要消灭的形态）。
//     `rev-parse` 从 cwd 向上发现仓库，两种布局（单包 / monorepo）都给正确读数。
const STRICT_DRIFT = process.argv.includes('--strict-drift');

/** git 可用性探针（向上发现仓库；非 git 副本 ⇒ false）。 */
function gitAvailable() {
  try {
    execFileSync('git', ['-C', ROOT, 'rev-parse', '--git-dir'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function assertDriftCommits() {
  if (!gitAvailable()) {
    console.log('[KNOWN_DRIFT] skipped：非 git 环境（安装态不适用，短码无法核）');
    return { ok: true, skipped: true, bad: [] };
  }
  const bad = [];
  let checked = 0;
  for (const bucket of ['added', 'gone']) {
    for (const [code, note] of Object.entries(KNOWN_DRIFT[bucket])) {
      const sha = String(note).trim().split(/\s+/)[0];
      checked += 1;
      try {
        execFileSync('git', ['-C', ROOT, 'cat-file', '-e', sha + '^{commit}'], { stdio: 'ignore' });
      } catch {
        bad.push(code + ' -> ' + sha);
      }
    }
  }
  if (bad.length) {
    console.log('[KNOWN_DRIFT] **短码不可解析** (' + bad.length + '/' + checked + ')：' + bad.join(' | '));
  } else {
    console.log('[KNOWN_DRIFT] 短码可解析：added ' + Object.keys(KNOWN_DRIFT.added).length
      + ' / gone ' + Object.keys(KNOWN_DRIFT.gone).length + ' 全部在场');
  }
  return { ok: bad.length === 0, skipped: false, bad };
}

const driftCheck = assertDriftCommits();
if (STRICT_DRIFT && !driftCheck.ok) {
  console.error('[KNOWN_DRIFT] --strict-drift：短码校验失败 ⇒ exit 1（本次未写盘）');
  process.exit(1);
}

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
  // 命中分类：标题点名 / 载荷断言 / 窗口内弱断言 / 其余位置（详见 strength.mjs）
  const tst = [];
  let nameHits = 0;
  let exactHits = 0;
  let weakHits = 0;
  let otherHits = 0;
  for (const f of testFiles) {
    const cls = classifyHits(shieldComments(readFileSync(f, 'utf8')), id);
    if (cls.total) tst.push(`${rel(f)}×${cls.total}`);
    nameHits += cls.title;
    exactHits += cls.exact;
    weakHits += cls.weak;
    otherHits += cls.other;
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
    nameHits, exactHits, weakHits, otherHits,
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
    // ── 漂移分档（**只读标注面**：不改 added/gone 判定，不动退出码）──────────────
    const regAdded = added.filter((x) => x in KNOWN_DRIFT.added);
    const regGone = gone.filter((x) => x in KNOWN_DRIFT.gone);
    const unreg = [...added.filter((x) => !(x in KNOWN_DRIFT.added)),
      ...gone.filter((x) => !(x in KNOWN_DRIFT.gone))].sort();
    console.log('基线时点 = R3-1（2026-09-21，' + rel(BASELINE) + ' 刻意停在此刻度）');
    console.log('已登记漂移 = 新增 ' + regAdded.length + ' / 消失 ' + regGone.length + '（来源 KNOWN_DRIFT）');
    console.log('未登记漂移 = ' + unreg.length + (unreg.length ? '（点名：' + unreg.join(' ') + '）' : ''));
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

// ── 断言强度：`testHits > 0` 但**一行载荷断言都没有**的拒码 ────────────────────────
//   ⚠ 与「无断言」是不同缺陷：后者台账已列出（`libOnly`）；前者**看起来被覆盖了**，
//     但命中的全部落在测试标题 / 夹具常量 / 非整码断言上 ⇒ 绳子没拴住任何行为。
const NAME_ONLY = codes.filter((r) => r.testHits > 0 && r.exactHits === 0 && r.nameHits > 0);
const WEAK_ONLY = codes.filter((r) => r.testHits > 0 && r.exactHits === 0 && r.nameHits === 0);
console.log(`\n### ⚑ 点名但无载荷断言（${NAME_ONLY.length}）：测试标题里写了码，正文无整码断言`);
NAME_ONLY.forEach((r) => console.log(`  ${r.id.padEnd(34)} hits=${r.testHits} title=${r.nameHits} weak=${r.weakHits} other=${r.otherHits}  files=${r.testFiles}`));
console.log(`\n### ⚑ 有命中但无载荷断言（${WEAK_ONLY.length}）：码出现在非断言位置（夹具/常量/宽正则）`);
WEAK_ONLY.forEach((r) => console.log(`  ${r.id.padEnd(34)} hits=${r.testHits} title=${r.nameHits} weak=${r.weakHits} other=${r.otherHits}  files=${r.testFiles}`));

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

// 写盘受唯一写闸约束：`--check` 之下**不创建、不改写** `scripts/audit/out/`
//   （该目录被 `.gitignore` 覆盖 ⇒ 污染在 `git status` 里看不出来，故必须由代码闸住，不能靠人自律）。
if (WRITE) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'gate-ledger.json'), JSON.stringify(rows, null, 2));
  console.log('\n-> scripts/audit/out/gate-ledger.json');
} else {
  console.log('\n(未写盘：--check 为只读形态；需落盘请加 --write)');
}
