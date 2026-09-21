// scripts/audit/reachability.mjs —— **可达性审计（工序）扫描器**
//   定位：为「三分类判读表」提供**机器侧证据**，人工只填「归类 + 依据」两列（判读口径见
//   `docs/reachability-audit-2026-09-21.md` §1/§2）。
//
//   枚举域（守卫全集）：
//     A. 门禁码   = `lib/types/contracts.ts` 的 `GateErrorCode` union（66）
//     B. 成员迁移边 = `lib/schema.js` 的 `MEMBER_TRANSITIONS`（from→to）
//     C. 批次相位边 = `lib/schema.js` 的 `BATCH_TRANSITIONS`（from→to）
//
//   采集证据（每条）：
//     · prod   = `lib/**` 内命中次数（排除 `.d.ts`）——零命中 ⇒ 未被生产引用
//     · test   = `test/**` 内命中次数（断言/用例引用）
//     · 关联提示：test=0 ⇒ 高信号候补（但**不等于**不可达，R3 教训：有断言≠可达、无断言≠不可达）
//
//   ⚠ 本脚本**不做**归类判定（是否「被更严一层遮蔽 / 输入可构造 / 结构不可能」只能人工判读），
//     只保证：清单完整、证据可复核、漂移可比对。
//
//   用法：
//     node scripts/audit/reachability.mjs            # 生成骨架 scripts/audit/out/reachability-skeleton.md
//     node scripts/audit/reachability.mjs --check    # 与基线快照比对守卫集合漂移
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const OUT = join(ROOT, 'scripts', 'audit', 'out');
const SNAP = join(OUT, 'reachability-snapshot.json');
mkdirSync(OUT, { recursive: true });

const SKIP = new Set(['node_modules', '.git', '.tsbuild', '.wip-backup']);
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const f = join(dir, e.name);
    if (e.isDirectory()) walk(f, out);
    else out.push(f);
  }
  return out;
}
const isSrc = (f) => /\.(ts|js|mjs)$/.test(f) && !/\.d\.ts$/.test(f);
const libFiles = walk(join(ROOT, 'lib')).filter(isSrc);
const testFiles = walk(join(ROOT, 'test')).filter((f) => /\.(ts|js|mjs)$/.test(f));

function countHits(files, needle) {
  let n = 0;
  for (const f of files) {
    try {
      const t = readFileSync(f, 'utf8');
      if (t.includes(needle)) n += t.split(needle).length - 1;
    } catch { /* 忽略不可读 */ }
  }
  return n;
}

// ── A. 门禁码 ────────────────────────────────────────────────────────────────
const contracts = readFileSync(join(ROOT, 'lib/types/contracts.ts'), 'utf8');
const m = contracts.match(/GateErrorCode[\s\S]*?=\s*([\s\S]*?);/);
const typed = [...new Set([...(m ? m[1] : '').matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map((x) => x[1]))];
// thrown 侧：`lib/**` 内出现的 `GATE_*` 字面量（含模板拼接的基类，如 `GATE_EXIT_MISSING_<LAYER>`）
//   —— 拒码真源 = typed（union）∪ thrown（实现面），台账口径 66 = 两者合计。
const thrown = new Set();
for (const f of libFiles) {
  const t = readFileSync(f, 'utf8');
  // 只取**拒码**字面量（以 `GATE_` 开头）；`EVT_GATE_*` 等事件常量不属于守卫，排除
  for (const x of t.matchAll(/'?(GATE_[A-Z0-9_]+)'?/g)) thrown.add(x[1]);
}
// 噪声过滤（两轮）：
//   ① `_RE` 结尾 = **正则常量**（非守卫，如 `GATE_FORBIDDEN_RE`），不进判读集；
//   ② 【N 类白名单（2026-09-22 02:3x 用户裁决，docs/gate-code-classification-2026-09-22.md）】
//      非守卫字面量（配置键/解析器常量/兼容标记/常量片段）⇒ 从门禁码统计口径剔除（常量本体生产在用，只剔口径）。
const NON_GUARD = new Set([
  'GATE_ENABLED', 'GATE_ENV', 'GATE_TIMEOUT_MS', 'GATE_RETRY', 'GATE_MAX_OUTPUT_BYTES',
  'GATE_MAX_WINDOW_MS', 'GATE_WINDOW_MS',
  'GATE_LINE_RE', 'GATE_EMPTY_LINE_RE', 'GATE_OFF_LINE_RE', 'GATE_FORBIDDEN_RE',
  'GATE_TARGETS_MODE', 'GATE_CODES', 'GATE_REPO_ROOT', 'GATE_MARKER', 'GATE_KINDS',
  'GATE_COUNT_FILE', 'GATE_RUNTIME_JS', 'GATE_PASSED', 'GATE_EXIT',
  'GATE_HANDOFF_LEGACY_PASSTHROUGH', 'GATE_HANDOFF_SETTLE_LEGACY_PASSTHROUGH',
]);
const codes = [...new Set([...typed, ...thrown])]
  .filter((c) => !/_RE$/.test(c))
  .filter((c) => !NON_GUARD.has(c))
  .sort();
const DEF_FILES = new Set(['lib/types/contracts.ts', 'lib/types/contracts.js']);
const libNonDef = libFiles.filter((f) => !DEF_FILES.has(relative(ROOT, f).replace(/\\/g, '/')));

// ── B/C. 迁移边 ──────────────────────────────────────────────────────────────
const schemaJs = readFileSync(join(ROOT, 'lib/schema.js'), 'utf8');
function edgesOf(name) {
  const mm = schemaJs.match(new RegExp(name + String.raw`\s*=\s*\{([\s\S]*?)\n\};`));
  if (!mm) return [];
  const out = [];
  for (const line of mm[1].split('\n')) {
    const lm = line.match(/^\s*([a-z]+):\s*\[([^\]]*)\]/);
    if (!lm) continue;
    const from = lm[1];
    const tos = [...lm[2].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
    for (const to of tos) out.push(from + '→' + to);
  }
  return out;
}
const memberEdges = edgesOf('MEMBER_TRANSITIONS');
const batchEdges = edgesOf('BATCH_TRANSITIONS');

// ── 生成条目 ─────────────────────────────────────────────────────────────────
const rows = [];
for (const c of codes) {
  rows.push({
    kind: typed.includes(c) ? 'gate(typed)' : 'gate(thrown)', id: c, needle: c,
    prod: countHits(libNonDef, c), test: countHits(testFiles, c),
  });
}
for (const e of memberEdges) {
  const [from, to] = e.split('→');
  // 迁移边证据：统计 lib/test 内 `setMember(..., '<to>'` 形态与 `<from>` 的组合不易静态化 ⇒ 只统计 to 的引用
  rows.push({
    kind: 'member-edge', id: e, needle: `'${to}'`,
    prod: countHits(libFiles, `'${to}'`), test: countHits(testFiles, `'${to}'`),
  });
}
for (const e of batchEdges) {
  const [, to] = e.split('→');
  rows.push({
    kind: 'batch-edge', id: e, needle: `'${to}'`,
    prod: countHits(libFiles, `'${to}'`), test: countHits(testFiles, `'${to}'`),
  });
}

// ── --context 证据输出（供人工判读：每个守卫的首个生产命中上下文）────────────────
function contextOf(needle, files) {
  for (const f of files) {
    const t = readFileSync(f, 'utf8').split('\n');
    for (let i = 0; i < t.length; i++) {
      if (t[i].includes(needle)) {
        const from = Math.max(0, i - 1);
        const to = Math.min(t.length, i + 2);
        return {
          file: relative(ROOT, f), line: i + 1,
          text: t.slice(from, to).map((l) => l.trim().slice(0, 120)).join(' ⏎ '),
        };
      }
    }
  }
  return null;
}
// ── --classify 净化分类（把「疑似守卫」分成真守卫 / 各类噪声）──────────────────────
//   判读前必须净化：命中集合里混有环境变量、事件常量、模板前缀碎片、已删码的注释残留——
//   它们**不是守卫**，把它们当守卫判读会得出错误结论（本轮实测教训）。
function classify(id, ctx) {
  const txt = ctx ? ctx.text : '';
  if (/_$/.test(id)) return 'noise:模板前缀碎片';
  if (/EVT_GATE/.test(txt)) return 'noise:事件常量(命中 EVT_GATE_*)';
  if (/envNumber\(|process\.env|GATE_ENABLED|GATE_ENV\b/.test(txt)) return 'noise:环境变量/配置';
  if (/已删|已移除|不再存在|已删除/.test(txt)) return 'retired:码已退役(仅注释残留)';
  if (/export const [A-Z_]+ =/.test(txt) && txt.includes(id + "'")) return 'const:常量表条目';
  if (txt === '') return 'candidate:lib 内零命中(需人工)';
  return 'guard:真守卫(需判读)';
}
if (process.argv.includes('--classify')) {
  const buckets = new Map();
  const out = ['# 可达性审计 · 净化分类（机器启发式，人工复核）', ''];
  for (const r of rows) {
    const c = contextOf(r.needle, libNonDef);
    const k = classify(r.id, c);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push({ r, c });
  }
  for (const [k, list] of [...buckets.entries()].sort()) {
    out.push('## ' + k + '（' + list.length + '）');
    out.push('');
    for (const { r, c } of list) {
      out.push('- `' + r.id + '`（prod=' + r.prod + ', test=' + r.test + '）'
        + (c ? ' — ' + c.file + ':' + c.line : ' — lib 内零命中'));
    }
    out.push('');
  }
  writeFileSync(join(OUT, 'reachability-classify.md'), out.join('\n'), 'utf8');
  for (const [k, list] of [...buckets.entries()].sort()) {
    console.log('[classify] ' + k + ' = ' + list.length);
  }
  console.log('[classify] -> ' + relative(ROOT, join(OUT, 'reachability-classify.md')));
  process.exit(0);
}

if (process.argv.includes('--context')) {
  const out = ['# 可达性审计 · 生产命中上下文（机器生成，供人工判读）', ''];
  for (const r of rows) {
    const c = contextOf(r.needle, libNonDef);
    out.push('## ' + r.kind + ' · `' + r.id + '`（prod=' + r.prod + ', test=' + r.test + '）');
    out.push(c ? ('- ' + c.file + ':' + c.line + ' — ' + c.text) : '- （lib 内零命中）');
    out.push('');
  }
  writeFileSync(join(OUT, 'reachability-context.md'), out.join('\n'), 'utf8');
  console.log('[reachability] 上下文 -> ' + relative(ROOT, join(OUT, 'reachability-context.md')));
  process.exit(0);
}

// ── --check 漂移比对 ─────────────────────────────────────────────────────────
const ids = rows.map((r) => r.kind + ':' + r.id).sort();
if (process.argv.includes('--check')) {
  if (!existsSync(SNAP)) {
    console.log('[reachability] 无基线快照，先跑一次不带 --check 生成');
    process.exit(0);
  }
  const prev = JSON.parse(readFileSync(SNAP, 'utf8')).ids ?? [];
  const added = ids.filter((x) => !prev.includes(x));
  const gone = prev.filter((x) => !ids.includes(x));
  console.log('=== 可达性审计 · 守卫集合漂移比对 ===');
  console.log('守卫总数：基线 ' + prev.length + ' → 现 ' + ids.length);
  console.log('新增守卫 (' + added.length + ')：' + (added.join(', ') || '—'));
  console.log('消失守卫 (' + gone.length + ')：' + (gone.join(', ') || '—'));
  process.exit(0);
}

// ── 骨架输出 ─────────────────────────────────────────────────────────────────
const lines = [];
lines.push('# 可达性审计 · 判读表骨架（机器生成，勿手改本段）');
lines.push('');
lines.push('> 生成：`node scripts/audit/reachability.mjs`（证据列 = 机器采集；**归类/依据 = 人工判读**）。');
lines.push('> 判读口径见 `docs/reachability-audit-2026-09-21.md` §1。判读顺序：**先判 `test=0` 的高信号子集**。');
lines.push('');
lines.push('| # | 类 | 守卫 | prod 引用 | test 命中 | 归类（①可达/②被遮蔽/③输入可构造/④结构不可能） | 依据（行号 / 调用点 / 反例构造） |');
lines.push('|---|---|---|---|---|---|---|');
rows.forEach((r, i) => {
  lines.push(`| ${i + 1} | ${r.kind} | \`${r.id}\` | ${r.prod} | ${r.test} | 待判 |  |`);
});
const skeleton = lines.join('\n') + '\n';
writeFileSync(join(OUT, 'reachability-skeleton.md'), skeleton, 'utf8');
writeFileSync(SNAP, JSON.stringify({ generatedAt: new Date().toISOString(), ids }, null, 2), 'utf8');

const zeroTest = rows.filter((r) => r.test === 0);
const zeroProd = rows.filter((r) => r.prod === 0);
console.log('[reachability] 守卫总数 ' + rows.length
  + '（门禁码 ' + codes.length + ' / 成员边 ' + memberEdges.length + ' / 相位边 ' + batchEdges.length + '）');
console.log('[reachability] test 零命中 ' + zeroTest.length + '：' + zeroTest.map((r) => r.id).join(', '));
console.log('[reachability] prod 零引用 ' + zeroProd.length + '：' + zeroProd.map((r) => r.id).join(', '));
console.log('[reachability] 骨架 -> ' + relative(ROOT, join(OUT, 'reachability-skeleton.md')));
