#!/usr/bin/env node
// arch-check.mjs — 架构越界门（棘轮口径：白名单外的新增跨域依赖即拒）
//
// 定位：把 `.punky/arch.yml` 里的架构规则变成**可执行、fail-closed** 的判定：
//   退出码 0 = 无新增越界；1 = 有违规；2 = 用法/配置错误。
//   本脚本**零第三方依赖**（不用 yaml 包），用针对性行扫描解析 arch.yml 的本文件子集；
//   脚本本身随仓库提交 ⇒ 可在 lane worktree 内执行（引擎命令门的 cwd 契约）。
//
// 用法：
//   node scripts/arch-check.mjs [--root <repoRoot>] [--arch <.punky/arch.yml>] [--json]
//   node scripts/arch-check.mjs --self-test          # 自检：解析器 + 判定器正/负向对照
//   node scripts/arch-check.mjs --context <file>     # 输出该文件的架构上下文（供任务包注入）
//
// 引擎侧接线（P0，零引擎改动）：lane 产物写两行 ——
//   gate: node scripts/arch-check.mjs
//   gate-script-sha256: scripts/arch-check.mjs=<64hex>
// （第二行使门自身受脚本信任锚定保护；缺锚定仅告警放行，不影响本脚本逻辑。）

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// 包根 = 本脚本所在目录的上一级。**必须**由脚本自身位置推导，不能用 cwd ——
// 因为引擎命令门在 lane worktree 根执行，cwd ≠ 包目录（否则配置与 lib 都找不到）。
export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 从 start 起向上查找 `.punky/arch.yml`（最多 5 层），兼容"真源在仓库根"的布局。 */
export function findArch(start) {
  let d = start;
  for (let i = 0; i < 5; i++) {
    const p = join(d, '.punky', 'arch.yml');
    if (existsSync(p)) return p;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

const CODE_RE = /\.(ts|js|mjs)$/;
const SKIP_RE = /\.d\.ts$|\.map$/;
const SPEC_RE = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;

// ── arch.yml 子集解析（只取本脚本需要的三样：mode / domains / rules.allowed）────────
export function parseArch(text) {
  const out = { mode: null, domains: [], allowed: new Set(), debtPairs: [], errors: [] };
  let section = null;   // 顶层段名
  let sub = null;       // 二级段名（rules.* / context.*）
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#(?![^"']*["'][^"']*$).*$/, ''); // 去行内注释（保守）
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const t = line.trim();
    const indent0 = indent === 0;

    const top = t.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (indent0 && top) {
      section = top[1];
      sub = null;
      if (top[1] === 'mode') out.mode = stripQ(top[2]);
      continue;
    }
    if (!indent0 && section === 'rules') {
      const m2 = t.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (m2 && !t.startsWith('-')) {
        sub = m2[1];
        if (sub === 'mode' && m2[2]) out.mode = stripQ(m2[2]);
        continue;
      }
      if (sub === 'allowed' && t.startsWith('-')) {
        const v = stripQ(t.replace(/^-\s*/, ''));
        if (v) out.allowed.add(v); else out.errors.push('empty allowed entry');
        continue;
      }
      if (sub === 'debt' && t.startsWith('-')) continue;
    }
    if (!indent0 && section === 'domains' && !t.startsWith('-')) {
      const m3 = t.match(/^("?)([^":]+)\1:\s*(.*)$/);
      if (m3) out.domains.push(m3[2]);
    }
  }
  return out;
}
const stripQ = (s) => String(s ?? '').trim().replace(/^["']|["']$/g, '').trim();

// ── 扫描：lib/** 静态 import → 域级边 ─────────────────────────────────────────────
export function scanEdges(repoRoot, libSub = 'lib') {
  const libRoot = join(repoRoot, libSub);
  if (!existsSync(libRoot)) return { error: `lib 目录不存在：${libRoot}` };
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
      else if (CODE_RE.test(e.name) && !SKIP_RE.test(e.name)) files.push(p);
    }
  })(libRoot);

  const areaOf = (abs) => {
    const r = relative(libRoot, abs);
    if (r.startsWith('..')) return '(outside-lib)';
    const parts = r.split(sep);
    return parts.length > 1 ? parts[0] : '(lib-root)';
  };

  const edges = [];
  const unresolved = [];
  let specifiers = 0;
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    let m;
    SPEC_RE.lastIndex = 0;
    while ((m = SPEC_RE.exec(src)) !== null) {
      specifiers++;
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      const base = resolve(dirname(f), spec);
      let hit = null;
      for (const c of [base, base + '.ts', base + '.js', base + '.mjs',
                       join(base, 'index.ts'), join(base, 'index.js')]) {
        try { if (statSync(c).isFile()) { hit = c; break; } } catch { /* next */ }
      }
      if (!hit) { unresolved.push({ file: relative(repoRoot, f), spec }); continue; }
      const from = areaOf(f), to = areaOf(hit);
      if (from === to) continue;
      edges.push({ from, to, pair: `${from} -> ${to}`, file: relative(repoRoot, f), target: relative(repoRoot, hit) });
    }
  }
  return { files: files.length, specifiers, edges, unresolved };
}

// ── 判定：白名单外的新增跨域边 = 违规 ─────────────────────────────────────────────
export function judge(scan, arch) {
  const violations = [];
  const pairCount = new Map();
  for (const e of scan.edges) pairCount.set(e.pair, (pairCount.get(e.pair) || 0) + 1);
  for (const e of scan.edges) {
    if (!arch.allowed.has(e.pair)) violations.push(e);
  }
  const newPairs = [...pairCount.keys()].filter((p) => !arch.allowed.has(p)).sort();
  return { violations, newPairs, pairCount };
}

// ── 诊断输出（蟛蜞 diag 形态：code: message @ subject → 修复: fix）──────────────────
function renderReport(scan, arch, verdict, json) {
  if (json) {
    return JSON.stringify({
      ok: verdict.violations.length === 0,
      mode: arch.mode,
      files: scan.files,
      specifiers: scan.specifiers,
      cross_edges: scan.edges.length,
      allowed_pairs: arch.allowed.size,
      violated_edges: verdict.violations.length,
      new_pairs: verdict.newPairs,
      violations: verdict.violations.slice(0, 50),
      unresolved: scan.unresolved,
    }, null, 1);
  }
  const L = [];
  L.push(`[arch-check] mode=${arch.mode} files=${scan.files} specifiers=${scan.specifiers} crossEdges=${scan.edges.length} allowedPairs=${arch.allowed.size}`);
  if (verdict.violations.length === 0) {
    L.push('[ok] 无新增跨域依赖（棘轮基线未被突破）');
  } else {
    L.push(`[error] arch/layer-violation: 新增 ${verdict.newPairs.length} 个未授权域对，共 ${verdict.violations.length} 条边`);
    for (const p of verdict.newPairs) L.push(`  · 未授权域对: ${p}（${verdict.pairCount.get(p)} 条）`);
    for (const v of verdict.violations.slice(0, 20)) {
      L.push(`[error] arch/edge: ${v.pair} @ ${v.file} → ${v.target}`);
      L.push(`        修复: 改为依赖白名单内的域，或（确属有意）在 .punky/arch.yml 的 rules.allowed 增列该域对并说明理由`);
    }
    if (verdict.violations.length > 20) L.push(`  …（其余 ${verdict.violations.length - 20} 条省略）`);
  }
  if (scan.unresolved.length) L.push(`[warn] unresolved specifiers = ${scan.unresolved.length}（不判定，避免误报）`);
  return L.join('\n');
}

// ── 上下文裁剪（供 P2 注入：给定文件 → 该文件所属域的架构约束）────────────────────
function renderContext(repoRoot, arch, targetFile) {
  const maybeAbs = resolve(repoRoot, targetFile);
  const area = (() => {
    const rel = relative(join(repoRoot, 'lib'), maybeAbs);
    const parts = rel.split(sep);
    return parts.length > 1 ? parts[0] : '(lib-root)';
  })();
  const allowedFrom = [...arch.allowed].filter((p) => p.startsWith(`${area} -> `));
  const allowedTo = [...arch.allowed].filter((p) => p.endsWith(` -> ${area}`));
  const L = [];
  L.push(`## 架构约束（本 lane 涉及域：${area}）`);
  L.push(`- 你正在改的域：\`${area}\``);
  L.push(`- 允许依赖（白名单）：${allowedFrom.map((p) => p.split(' -> ')[1]).join(', ') || '（无）'}`);
  L.push(`- 允许被这些域依赖：${allowedTo.map((p) => p.split(' -> ')[0]).join(', ') || '（无）'}`);
  L.push(`- 其他任何域间依赖 = 违规，门会拒绝 merged`);
  L.push(`- 真源：.punky/arch.yml（改动须显式说明理由）`);
  return L.join('\n');
}

// ── 自检（正/负向对照：解析器 + 判定器）───────────────────────────────────────────
function selfTest() {
  const cases = [];
  const archText = [
    'version: 1',
    'mode: ratchet',
    'domains:',
    '  alpha: "域 A"',
    '  beta: "域 B"',
    'rules:',
    '  mode: ratchet',
    '  allowed:',
    '    - "alpha -> beta"',
  ].join('\n');
  const arch = parseArch(archText);
  cases.push(['解析 mode', arch.mode === 'ratchet']);
  cases.push(['解析 domains', arch.domains.length === 2 && arch.domains.includes('beta')]);
  cases.push(['解析 allowed', arch.allowed.has('alpha -> beta')]);

  const mk = (from, to) => ({ from, to, pair: `${from} -> ${to}`, file: `lib/${from}/x.ts`, target: `lib/${to}/y.ts` });
  // 负向对照：白名单内的边**不得**被判违规
  const ok = judge({ edges: [mk('alpha', 'beta')], files: 2, specifiers: 1, unresolved: [] }, arch);
  cases.push(['负向对照：白名单内边放行', ok.violations.length === 0]);
  // 正向：白名单外的边**必须**被判违规
  const bad = judge({ edges: [mk('beta', 'alpha')], files: 2, specifiers: 1, unresolved: [] }, arch);
  cases.push(['正向：白名单外边判违规', bad.violations.length === 1]);
  const mixed = judge({ edges: [mk('alpha', 'beta'), mk('beta', 'alpha')], files: 2, specifiers: 2, unresolved: [] }, arch);
  cases.push(['混合：仅计数越界边', mixed.violations.length === 1 && mixed.newPairs.length === 1]);

  let pass = 0;
  for (const [name, okFlag] of cases) {
    console.log(`${okFlag ? 'PASS' : 'FAIL'}  ${name}`);
    if (okFlag) pass++;
  }
  console.log(`[self-test] ${pass}/${cases.length} ${pass === cases.length ? 'GREEN' : 'RED'}`);
  process.exit(pass === cases.length ? 0 : 1);
}

// ── main ─────────────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();

  const getArg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const repoRoot = resolve(getArg('--root') || PKG_ROOT);
  const archPath = resolve(getArg('--arch') || findArch(PKG_ROOT) || join(PKG_ROOT, '.punky', 'arch.yml'));
  const json = argv.includes('--json');

  if (!existsSync(archPath)) {
    console.error(`[error] arch/config-missing: 找不到架构真源 ${archPath}`);
    console.error('        修复: 在仓库根创建 .punky/arch.yml（可复用 arch-probe.mjs 生成白名单）');
    process.exit(2);
  }
  const arch = parseArch(readFileSync(archPath, 'utf8'));
  if (arch.errors.length) {
    console.error(`[error] arch/parse: ${arch.errors.join('; ')}`);
    process.exit(2);
  }

  const ctxTarget = getArg('--context');
  const scan = scanEdges(repoRoot);
  if (scan.error) { console.error(`[error] arch/scan: ${scan.error}`); process.exit(2); }

  if (ctxTarget) { console.log(renderContext(repoRoot, arch, ctxTarget)); process.exit(0); }

  const verdict = judge(scan, arch);
  console.log(renderReport(scan, arch, verdict, json));
  process.exit(verdict.violations.length === 0 ? 0 : 1);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('arch-check.mjs');
if (invokedDirectly) main();
