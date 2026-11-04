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

// scripts/docs-consistency.mjs —— 文档一致性守卫（批 `punky-three-tasks-20261103` · lane `impl-doc`）
//
// 三条判据（spec §3.1，**只读、零依赖、不写任何文件**）：
//   A · 旧词归零   A-1 `lib/capabilities.js` 的 `degraded` 计数 = **1**（且该行含「已废除」）
//                  A-2 `plan/drift-audit.md` 的失效句式 `/仍写[\s\S]{0,20}degraded|HEAD 仍/g` = **0**
//   B · Impact List  `--impact <word>` ⇒ 打印全仓 `.md` 命中清单到 **stdout**（**不落盘**）
//   C · 计数一致性 中文数字归一 + **作用域限定**（全文还有「AC-1 恰 4 条」等无关计数，裸跑会假红）
//
// 用法：
//   node scripts/docs-consistency.mjs                 # 跑判据（退出码 0 全绿 / 1 违规）
//   node scripts/docs-consistency.mjs --json          # 机读输出
//   node scripts/docs-consistency.mjs --impact 三条   # 只打印 Impact List（不判、不落盘）
//   node scripts/docs-consistency.mjs --root <repo>   # 指定仓库根（缺省 cwd）
//   node scripts/docs-consistency.mjs --doc <path>    # 指定 drift-audit.md（缺省自动定位）
//   node scripts/docs-consistency.mjs --strict        # 文档缺失 ⇒ 判红（缺省 = 响亮 SKIP 且不判红）
//
// ⚠ 关于 `drift-audit.md` 的位置：它**不在被测仓内**（在 `~/.dsh/punky-preset/sessions/*/artifacts/**`）。
//    ⇒ 定位顺序：`--doc` > 环境变量 `PUNKY_DRIFT_AUDIT` > `<root>/plan/drift-audit.md` >
//      在 `~/.dsh/punky-preset/sessions/*/artifacts/*/plan/drift-audit.md` 里取**最新 mtime** 的一份。
//    ⇒ 都找不到时**默认 SKIP 并打印醒目提示**（CI/他机不该因文档不在仓库里而假红）；
//      要把它当硬门请加 `--strict`。**SKIP 不冒充通过**：输出明确写 `SKIP`，不进 green 计数。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};

const ROOT = path.resolve(opt('--root', process.cwd()));
const JSON_OUT = flag('--json');
const STRICT = flag('--strict');
const IMPACT_WORD = opt('--impact', null);

const read = (p) => fs.readFileSync(p, 'utf8');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

/** 递归收集 `.md`（**跳过** node_modules / .git / artifacts 之外的噪声目录）。 */
function walkMd(dir, acc = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { walkMd(abs, acc); continue; }
    if (/\.md$/i.test(e.name)) acc.push(abs);
  }
  return acc;
}

/** 定位 `drift-audit.md`（见文件头定位顺序）。 */
function locateDriftDoc() {
  const explicit = opt('--doc', null);
  if (explicit) return { path: path.resolve(explicit), via: '--doc' };
  if (process.env.PUNKY_DRIFT_AUDIT) return { path: path.resolve(process.env.PUNKY_DRIFT_AUDIT), via: 'env' };
  const inRepo = path.join(ROOT, 'plan', 'drift-audit.md');
  if (fs.existsSync(inRepo)) return { path: inRepo, via: '<root>/plan' };
  // 兜底：会话产物根里找最新的 drift-audit.md
  const base = path.join(os.homedir(), '.dsh', 'punky-preset', 'sessions');
  let best = null;
  try {
    for (const s of fs.readdirSync(base, { withFileTypes: true })) {
      if (!s.isDirectory()) continue;
      const arts = path.join(base, s.name, 'artifacts');
      let names = [];
      try { names = fs.readdirSync(arts, { withFileTypes: true }); } catch { continue; }
      for (const a of names) {
        if (!a.isDirectory()) continue;
        const cand = path.join(arts, a.name, 'plan', 'drift-audit.md');
        if (!fs.existsSync(cand)) continue;
        const mt = fs.statSync(cand).mtimeMs;
        if (!best || mt > best.mtimeMs) best = { path: cand, mtimeMs: mt, via: 'session-artifacts' };
      }
    }
  } catch { /* 无产物根 ⇒ 走 SKIP */ }
  return best ? { path: best.path, via: best.via } : null;
}

// ── 判据 B：Impact List（**只打印，不落盘**）──────────────────────────────────────────────
function impactList(root, word) {
  const out = [];
  for (const f of walkMd(root)) {
    const lines = read(f).split(/\r?\n/);
    lines.forEach((ln, i) => { if (ln.includes(word)) out.push(`${rel(f)}:${i + 1}: ${ln.trim().slice(0, 120)}`); });
  }
  return out;
}

// ── 判据 C 的中文数字归一（spec §3.1.4 逐字）──────────────────────────────────────────────
const CN_DIGIT = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function cnToInt(s) {
  if (s.length === 1) return CN_DIGIT[s] ?? null;
  if (s === '十一') return 11;
  if (s[0] === '十') return 10 + (CN_DIGIT[s[1]] ?? 0);                              // 十二 … 十九
  if (s[1] === '十') return (CN_DIGIT[s[0]] ?? 0) * 10 + (s[2] ? (CN_DIGIT[s[2]] ?? 0) : 0); // 二十 …
  return null;
}

/** 取 `### 标题` 起、到下一个 `## ` / `### ` 之前的内容（**作用域限定**的唯一实现）。 */
function sectionOf(doc, headingPrefix) {
  const lines = doc.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(headingPrefix));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{2,3} /.test(lines[i])) { end = i; break; }
  }
  return { text: lines.slice(start, end).join('\n'), startLine: start + 1 };
}

// ── 主流程 ────────────────────────────────────────────────────────────────────────────────
const results = [];
const expect = (id, label, actual, want, extra = '') => {
  const ok = actual === want;
  results.push({ id, label, actual, want, ok, extra });
  return ok;
};

// B 模式：只打印清单后退出（**不判定、不落盘**）
if (IMPACT_WORD) {
  const hits = impactList(ROOT, IMPACT_WORD);
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ mode: 'impact', word: IMPACT_WORD, root: ROOT, count: hits.length, hits }, null, 2) + '\n');
  } else {
    process.stdout.write(`[impact] word=${IMPACT_WORD} root=${ROOT} count=${hits.length}\n`);
    for (const h of hits) process.stdout.write(h + '\n');
  }
  process.exit(0);
}

// ── A-1：代码侧旧词归零（计数 = 1，且该行必含「已废除」）──────────────────────────────────
const capsPath = path.resolve(opt('--caps', path.join(ROOT, 'lib', 'capabilities.js')));
if (!fs.existsSync(capsPath)) {
  results.push({ id: 'A-1', label: 'lib/capabilities.js 不存在', actual: null, want: 1, ok: false, extra: capsPath });
} else {
  const caps = read(capsPath);
  const hits = caps.match(/degraded/g) || [];
  expect('A-1', 'capabilities.js 的 degraded 计数', hits.length, 1);
  // 断言语义：**剩下的那一处必须就是「已废除」那句**（删到 0 会丢失「为什么不用它」的依据）
  const linesWith = caps.split(/\r?\n/).filter((l) => l.includes('degraded'));
  const semantic = linesWith.length === 1 && /已废除/.test(linesWith[0]);
  expect('A-1·语义', '唯一一处 degraded 所在行含「已废除」', semantic, true);
}

// ── A-2 + C：文档侧 ──────────────────────────────────────────────────────────────────────
const docLoc = locateDriftDoc();
if (!docLoc) {
  if (STRICT) {
    results.push({ id: 'A-2/C', label: 'drift-audit.md 未找到（--strict）', actual: null, want: 1, ok: false, extra: 'locate 失败' });
  } else {
    process.stdout.write('[SKIP] drift-audit.md 未找到（不在仓库内且会话产物根无匹配）'
      + ' —— A-2 / C 两条判据**未执行**；要当硬门请加 `--strict` 或 `--doc <path>`。\n');
    results.push({ id: 'A-2', label: 'drift-audit.md 未找到', actual: 'SKIP', want: 0, ok: true, skipped: true });
    results.push({ id: 'C', label: 'drift-audit.md 未找到', actual: 'SKIP', want: 4, ok: true, skipped: true });
  }
} else {
  const doc = read(docLoc.path);

  // A-2：失效句式归零
  const stale = (doc.match(/仍写[\s\S]{0,20}degraded|HEAD 仍/g) || []).length;
  expect('A-2', '失效描述计数（仍写…degraded / HEAD 仍）', stale, 0, 'doc=' + docLoc.path);

  // C：① 从列表派生实际数（唯一真源）
  const actual = (doc.match(/^\| \*\*B1-\d\*\*/gm) || []).length;

  // C：② **作用域限定** —— 只在 §3.1 内找计数词（避免全文「AC-1 恰 4 条」等无关计数假红）
  const sec = sectionOf(doc, '### 3.1 B1 未溯源实施项');
  if (!sec) {
    expect('C·作用域', '未找到 `### 3.1 B1 未溯源实施项` 标题', false, true);
  } else {
    const declaredInScope = [...sec.text.matchAll(/([一二两三四五六七八九十]+)\s*(条|处)/g)]
      .map((m) => ({ raw: m[0], n: cnToInt(m[1]) }))
      .filter((x) => x.n !== null);
    for (const d of declaredInScope) {
      expect('C', `§3.1 内声明「${d.raw}」`, d.n, actual);
    }
    if (declaredInScope.length === 0) {
      expect('C·作用域', '§3.1 内至少应有 1 处计数声明（否则判据空转）', 0, false);
    }
  }

  // C：③ 作用域**之外**但显式带 B1 前缀的声明（REQ-1 / AC-1）—— 同样必须等于派生数
  const b1Decls = [...doc.matchAll(/B1\s*(?:恰\s*)?([一二两三四五六七八九十\d]+)\s*条/g)]
    .map((m) => ({ raw: m[0], n: /^\d+$/.test(m[1]) ? Number(m[1]) : cnToInt(m[1]) }))
    .filter((x) => x.n !== null);
  for (const d of b1Decls) expect('C·B1 前缀', `声明「${d.raw}」`, d.n, actual);

  // C：④ 禁模糊量词（约 N 条 / 若干条）
  const vague = (doc.match(/约\s*[一二三四五六七八九十\d]+\s*[条处]|若干\s*[条处]/g) || []).length;
  expect('C·禁模糊量词', '约/若干 类模糊计数', vague, 0);
}

// ── 输出 ─────────────────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
if (JSON_OUT) {
  process.stdout.write(JSON.stringify({
    guard: 'docs-consistency', root: ROOT, doc: docLoc ? docLoc.path : null, via: docLoc?.via ?? null,
    total: results.length, failed: failed.length, results,
  }, null, 2) + '\n');
} else {
  for (const r of results) {
    const mark = r.skipped ? 'SKIP' : (r.ok ? 'PASS' : 'FAIL');
    process.stdout.write(`[${mark}] ${r.id} · ${r.label} ⇒ 期望 ${JSON.stringify(r.want)} 实得 ${JSON.stringify(r.actual)}`
      + (r.extra ? '  (' + r.extra + ')' : '') + '\n');
  }
  process.stdout.write(`\n[summary] ${results.length - failed.length}/${results.length} 通过`
    + (docLoc ? ` · doc=${docLoc.path} (via ${docLoc.via})` : ' · doc=未定位') + '\n');
}
process.exit(failed.length === 0 ? 0 : 1);
