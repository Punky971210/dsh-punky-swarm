#!/usr/bin/env node
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

// 夹具审计扫描器（与 `scripts/audit/reachability.mjs` 同族的**工序**，不是一次性脚本）
// ─────────────────────────────────────────────────────────────────────────────
// 定位：回答「测试夹具本身是否在稀释门禁语义 / 是否冗余」——可达性审计查的是**守卫**，
//   本扫描器查的是**夹具**（`test/helpers/**` + 各测试文件的本地夹具）。
//
// 四分类（判读口径见 `docs/fixture-audit-2026-09-21.md`）：
//   ① 必要夹具   —— 造的是被测系统真正需要的输入，且不掩盖任何门禁 ⇒ 保留
//   ② 空壳夹具   —— 为让门禁通过而造**假前置**（如空壳技能桩）⇒ 门禁语义被稀释 ⇒ 替换/显式化
//   ③ 重复夹具   —— 同一语义在 N 处各写一份（语义漂移风险）⇒ 收敛到单点
//   ④ 死夹具     —— 无任何消费者 ⇒ 删
//
// 本脚本只做**机器可判**的部分（枚举 + 消费者计数 + 桩分支检测 + 重复度统计），
//   分类结论由人工写进台账（`docs/fixture-audit-*.md`，与可达性审计同样的「机器证据 + 人工判读」两层）。
//
// 用法：
//   node scripts/audit/fixtures.mjs            写骨架到 scripts/audit/out/fixture-skeleton.md
//   node scripts/audit/fixtures.mjs --check    只比「夹具 API 集合」漂移（不改文件）
//   node scripts/audit/fixtures.mjs --json     机器可读输出（stdout）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT_DIR = path.join(ROOT, 'scripts', 'audit', 'out');
const SKELETON = path.join(OUT_DIR, 'fixture-skeleton.md');
/** 夹具 API 集合基线（`--check` 比对；集合变化 ⇒ 提示重跑人工判读）。 */
const BASELINE = path.join(OUT_DIR, 'fixture-api-baseline.json');

const HELPERS_DIR = path.join(ROOT, 'test', 'helpers');

/** 读文件（失败 ⇒ 空串，不阻断扫描）。 */
function read(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

/** 列目录下指定后缀的文件（相对 ROOT 的 POSIX 风格路径）。 */
function listFiles(dir, re) {
  const abs = path.join(ROOT, dir);
  let ents = [];
  try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return []; }
  return ents
    .filter((e) => e.isFile() && re.test(e.name))
    .map((e) => dir + '/' + e.name)
    .sort();
}

/** 测试夹具 API（`test/helpers/**` 的导出）+ 其消费者统计。 */
function scanFixtureApis() {
  const helperFiles = listFiles('test/helpers', /\.(mjs|js)$/);
  const testFiles = listFiles('test', /\.(js|mjs)$/);
  const apis = [];
  for (const hf of helperFiles) {
    const src = read(path.join(ROOT, hf));
    const names = [...src.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z_][A-Za-z0-9_]*)/gm)]
      .map((m) => m[1]);
    for (const name of names) {
      // 直接消费者：测试文件里出现了该标识符
      const consumers = [];
      for (const tf of testFiles) {
        if (new RegExp('\\b' + name + '\\b').test(read(path.join(ROOT, tf)))) consumers.push(tf);
      }
      // 间接加载：只认**显式**形态（`register('<file>')` / `--import <file>` / 字符串路径引用），
      //   避免「文件里出现 helper 文件名」被误判（首版判据过宽：一个文件被 import 就等于全库间接加载）。
      const base = path.basename(hf);
      const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const RE_INDIRECT = new RegExp(
        "(register\\(\\s*['\"][^'\"]*" + esc + "|--import\\s+\\S*" + esc
        + "|['\"]\\.?/?helpers/" + esc + "['\"])",
      );
      const indirect = [];
      for (const f of [...testFiles, ...helperFiles]) {
        if (f === hf) continue;
        if (RE_INDIRECT.test(read(path.join(ROOT, f)))) indirect.push(f);
      }
      // helper 内部自用：除 `export` 定义行外还有调用/引用 ⇒ 对外 API（非死夹具）
      const uses = [...src.matchAll(new RegExp('\\b' + name + '\\b', 'g'))].length;
      const selfUse = uses > 1;
      apis.push({ helper: hf, name, consumers, indirect, selfUse });
    }
  }
  return { helperFiles, testFiles, apis };
}

/**
 * 桩分支检测（②空壳夹具的机器线索，两路）：
 *   ① 字面短语（`桩` / `placeholder` / `最小 frontmatter` / `否则写` …）
 *   ② **形态**：同一处（±6 行窗口）既查真实资源存在性（`existsSync`）又写文件（`writeFileSync`）
 *      ／或写以 `---` 开头的 frontmatter 文本 —— 典型「真资源缺失 ⇒ 造最小桩」分支。
 */
function scanStubBranches(helperFiles) {
  const out = [];
  const PHRASES = /桩|placeholder|stub|fallback body|最小\s*frontmatter|否则写|缺省写/;
  for (const hf of helperFiles) {
    const lines = read(path.join(ROOT, hf)).split('\n');
    lines.forEach((l, i) => {
      if (PHRASES.test(l)) {
        out.push({ file: hf, line: i + 1, kind: 'phrase', text: l.trim().slice(0, 160) });
        return;
      }
      if (!/existsSync/.test(l)) return;
      const win = lines.slice(Math.max(0, i - 6), i + 7).join('\n');
      if (!/writeFileSync/.test(win)) return;
      if (!/(['"]---|桩|placeholder|stub)/.test(win)) return;
      out.push({ file: hf, line: i + 1, kind: 'shape', text: l.trim().slice(0, 160) });
    });
  }
  return out;
}

/** 技能空壳量化：团队资产声明的技能名 vs 包内 `skills/<name>/SKILL.md` 是否存在。 */
function scanSkillShells() {
  const rows = [];
  const presets = path.join(ROOT, 'presets');
  let teams = [];
  try { teams = fs.readdirSync(presets, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); }
  catch { return { rows, real: 0, shell: 0 }; }
  let real = 0; let shell = 0;
  for (const team of teams) {
    for (const f of ['team-asset.json', 'team-asset.yml']) {
      const p = path.join(presets, team, f);
      if (!fs.existsSync(p)) continue;
      let asset = null;
      try { asset = JSON.parse(read(p)); } catch { continue; }
      const names = new Set();
      for (const layer of Object.values(asset.layers ?? {})) {
        for (const arr of Object.values(layer?.skills ?? {})) for (const s of arr ?? []) names.add(s);
      }
      for (const n of [...names].sort()) {
        const hasReal = fs.existsSync(path.join(ROOT, 'skills', n, 'SKILL.md'));
        if (hasReal) real += 1; else shell += 1;
        rows.push({ team, skill: n, real: hasReal });
      }
    }
  }
  return { rows, real, shell };
}

/** 重复夹具（③）：跨测试文件重复定义的本地函数（≥3 处即列入候选）。 */
function scanDuplicateLocals(testFiles) {
  const defs = new Map();
  for (const tf of testFiles) {
    const t = read(path.join(ROOT, tf));
    for (const m of t.matchAll(/^(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
      const n = m[1];
      if (!defs.has(n)) defs.set(n, []);
      defs.get(n).push(tf);
    }
  }
  return [...defs.entries()]
    .filter(([, v]) => v.length >= 3)
    .map(([name, files]) => ({ name, files: files.sort() }))
    .sort((a, b) => b.files.length - a.files.length);
}

/** 自建团队资产（②/③ 混合面）：哪些测试文件自己写 team-asset / 临时 team 目录。 */
function scanLocalTeamAssets(testFiles) {
  const out = [];
  for (const tf of testFiles) {
    const t = read(path.join(ROOT, tf));
    const marks = [];
    if (/writeTempTeam/.test(t)) marks.push('writeTempTeam');
    if (/team-asset\.(yml|json)/.test(t) && /writeFileSync/.test(t)) marks.push('写 team-asset');
    if (/function\s+(teamAsset|makeTeam|tempTeam)\b/.test(t)) marks.push('本地 teamAsset()');
    if (marks.length) out.push({ file: tf, marks });
  }
  return out;
}

const { helperFiles, testFiles, apis } = scanFixtureApis();
const stubs = scanStubBranches(helperFiles);
const shells = scanSkillShells();
const dups = scanDuplicateLocals(testFiles);
const locals = scanLocalTeamAssets(testFiles);

/** 夹具 API 集合指纹（`--check` 用）。 */
const apiSet = apis
  .filter((a) => a.consumers.length > 0 || a.indirect.length > 0)
  .map((a) => a.helper + '#' + a.name)
  .sort();

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify({
    helpers: helperFiles, apiSet, apis, stubs, skillShells: shells, duplicateLocals: dups, localTeamAssets: locals,
  }, null, 2) + '\n');
  process.exit(0);
}

if (process.argv.includes('--check')) {
  const prev = read(BASELINE).trim();
  const cur = JSON.stringify(apiSet);
  if (!prev) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(BASELINE, cur + '\n', 'utf8');
    console.log('[fixtures] 未找到基线 ⇒ 已写入 ' + path.relative(ROOT, BASELINE) + '（' + apiSet.length + ' 个活夹具 API）');
    process.exit(0);
  }
  const a = JSON.parse(prev);
  const added = apiSet.filter((x) => !a.includes(x));
  const removed = a.filter((x) => !apiSet.includes(x));
  if (added.length === 0 && removed.length === 0) {
    console.log('[fixtures] --check：夹具 API 集合零漂移（' + apiSet.length + ' 个活夹具 API）');
    process.exit(0);
  }
  console.log('[fixtures] --check：夹具 API 集合漂移 ⇒ 人工判读需重跑');
  if (added.length) console.log('  + ' + added.join('\n  + '));
  if (removed.length) console.log('  - ' + removed.join('\n  - '));
  console.log('  （确认后跑 `node scripts/audit/fixtures.mjs --accept` 更新基线）');
  process.exit(1);
}

if (process.argv.includes('--accept')) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify(apiSet) + '\n', 'utf8');
  console.log('[fixtures] 基线已更新（' + apiSet.length + ' 个活夹具 API）');
  process.exit(0);
}

// ── 生成人工判读骨架 ────────────────────────────────────────────────────────
const L = [];
L.push('# 夹具审计 · 判读骨架（机器生成，勿手改）');
L.push('');
L.push('> 生成：`node scripts/audit/fixtures.mjs` ｜ 判读结论写 `docs/fixture-audit-2026-09-21.md`。');
L.push('');
L.push('## A. 夹具 API（`test/helpers/**` 导出）与消费者');
L.push('');
L.push('| helper | API | 直接消费者 | 间接加载点 | 初判 |');
L.push('|---|---|---|---|---|');
for (const a of apis) {
  const direct = a.consumers.length;
  const ind = a.indirect.length;
  const guess = direct > 0
    ? (direct >= 20 ? '① 主力夹具' : '① 在用')
    : ind > 0 ? '① 间接加载（动态 / --import）'
      : a.selfUse ? '① 模块内部或对外 API（待人工确认消费者）'
        : '④ 死夹具候选（待人工确认）';
  L.push('| `' + a.helper + '` | `' + a.name + '` | ' + direct + ' | ' + ind + ' | ' + guess + ' |');
}
L.push('');
L.push('## B. 桩分支线索（②空壳夹具）');
L.push('');
L.push('| 文件 | 行 | 检出方式 | 内容 |');
L.push('|---|---|---|---|');
for (const s of stubs) L.push('| `' + s.file + '` | ' + s.line + ' | ' + s.kind + ' | `' + s.text.replace(/\|/g, '\\|') + '` |');
L.push('');
L.push('## C. 技能空壳量化（团队资产声明 vs 包内真实技能）');
L.push('');
L.push('合计：真实命中 **' + shells.real + '** / 空壳 **' + shells.shell + '**（空壳率 '
  + (shells.real + shells.shell === 0 ? 0 : Math.round((shells.shell / (shells.real + shells.shell)) * 100)) + '%）');
L.push('');
L.push('| 团队 | 技能 | 包内有真实 SKILL.md? |');
L.push('|---|---|---|');
for (const r of shells.rows) L.push('| ' + r.team + ' | `' + r.skill + '` | ' + (r.real ? '✅' : '❌ **空壳**') + ' |');
L.push('');
L.push('## D. 重复夹具候选（③：同名本地函数跨文件重复定义）');
L.push('');
L.push('| 函数名 | 定义处数 | 文件 |');
L.push('|---|---|---|');
for (const d of dups) L.push('| `' + d.name + '` | ' + d.files.length + ' | ' + d.files.join(', ') + ' |');
L.push('');
L.push('## E. 自建团队资产（②/③ 混合面）');
L.push('');
L.push('| 测试文件 | 形态 |');
L.push('|---|---|');
for (const r of locals) L.push('| `' + r.file + '` | ' + r.marks.join(' + ') + ' |');
L.push('');

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(SKELETON, L.join('\n'), 'utf8');
console.log('[fixtures] 骨架已写入 ' + path.relative(ROOT, SKELETON));
console.log('[fixtures] 夹具 API ' + apis.length + ' · 桩分支线索 ' + stubs.length
  + ' · 技能空壳 ' + shells.shell + '/' + (shells.real + shells.shell)
  + ' · 重复函数候选 ' + dups.length + ' · 自建团队资产文件 ' + locals.length);
