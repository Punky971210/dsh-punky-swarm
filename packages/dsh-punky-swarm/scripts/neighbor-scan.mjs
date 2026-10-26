#!/usr/bin/env node
/**
 * neighbor-scan.mjs —— 邻位身份断言前置过滤器（只读）
 *
 * 两档口径（不得混用）：
 *   --mode L  PREF-L：逐字复刻参考实现（含其 5 个口径缺口），用于「可被独立实现复算」的回归证据
 *   --mode A  PREF-A：权威口径（锚点校验 + 同 test 块内 ±window + F1/F2/F3 + 三层取根 + 整词匹配）
 *
 * 只读：不改任何 .test.js、不就地修改输入表（输出一律新文件）、不写 baselines。
 *
 * 退出码：
 *   0  正常
 *   1  守恒式不成立（我方账不平）
 *   2  F-类：输入表/文件/行号/解码/重复键 任一坏 ⇒ 不产出任何输出
 *   3  A-类：存在 blocked（ambiguous/stale）⇒ 不中断，但 blocking 化
 *
 * 用法：
 *   node scripts/neighbor-scan.mjs --table plan/census-table.v2.json --mode A \
 *        --out exec/census-table.v3.json --tsv exec/prefilter.tsv --summary-json exec/prefilter-summary.json
 *   node scripts/neighbor-scan.mjs --table ... --mode L --window 0   # 负控
 *
 * ⚠ **--domain 与 --window 必写**（两者都无默认语义，缺一即拒跑并以 2 退出）：
 *   · `--domain <token>`：按域（文件名去 .test.js 后首个 `-` 前 token）限定读数面；
 *   · `--window <n>`：邻位域半径（帧内 ±n 行）；`--window 0` = 负控。
 * ⚠ **裸跑（不给 --domain）的「全量 362」与域内读数不可比、禁混引**：
 *   · 引用任一读数时必须同时带**三件**：`table 版本` / `domain` / `window`；
 *   · 缺任一件的引用一律视为无效读数（跨域混引会把「域内成熟」误读成「全库退步」）。
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO_DEFAULT = 'D:/dsh/Punky-plugin-onto/packages/dsh-punky-swarm';

// ───────────────────────────── 参考实现（PREF-L）口径：逐字复刻 ─────────────────────────────
// 缺口①：IDENT 11 个 token，含 .map( / match( / includes( / ackId 等非身份形态
const IDENT_L = /deepEqual\(|\.sort\(\)|Object\.keys|\[0\]\.|\.map\(|match\(|includes\(|ackId|\.lane\b|\.type\b/;
// 成员链允许 `[N]` 下标（规格「末段规则」：`r.rows[1].count` → 末段 `rows`）
const MEMBER_ROOT = /([A-Za-z_$][\w$]*(?:\[\d+\])?(?:\.[A-Za-z_$][\w$]*(?:\[\d+\])?)*)\s*\.\s*(length|size|count)\b/;
// PREF-L 专用：逐字复刻参考实现的取根正则（**不允许 `[N]`**，这是它的缺口之一）
const MEMBER_ROOT_L = /([A-Za-z_$][\w$.]*)\s*\.\s*(length|size|count)\b/;
const KNOWN_FUNCS =
  /(?:readUnacked|eventsOf|refEvs|escEvs|listReceiptFiles|handlesOf|dispatchesOf|pendingIntents)\s*\(/;

// ───────────────────────────── PREF-A 形态判定（F1/F2/F3）─────────────────────────────
const F1_CALL = /(?:deepEqual|deepStrictEqual|toEqual)\s*\(/;
const F3_KEYS = /Object\.keys\s*\(/;
const F2_INDEX = /\[\d+\]\./;

function formOf(line) {
  if (F1_CALL.test(line) && F3_KEYS.test(line)) return 'F3';
  if (F1_CALL.test(line) && (line.includes('.sort(') || line.includes('['))) return 'F1';
  if (F2_INDEX.test(line)) return 'F2';
  return null;
}

function domainOf(file) {
  let base = path.basename(file);
  if (base.endsWith('.test.js')) base = base.slice(0, -'.test.js'.length);
  return base.split('-')[0];
}

function rootOfText(text, variant = 'A') {
  const m = (variant === 'L' ? MEMBER_ROOT_L : MEMBER_ROOT).exec(text);
  if (m) return { root: m[1], layer: 'L1' };
  const f = KNOWN_FUNCS.exec(text);
  if (f) return { root: f[0].slice(0, -1), layer: 'L2' };
  return { root: null, layer: 'none' };
}

/** 同文件内单层别名/解构展开（PREF-A 的 L3） */
function aliasMapOf(lines) {
  const map = new Map();
  for (const raw of lines) {
    const s = raw.trim();
    let m = /^const\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;/.exec(s);
    if (m) {
      map.set(m[1], m[2]);
      continue;
    }
    m = /^const\s*\{([^}]*)\}\s*=\s*([A-Za-z_$][\w$]*)\s*;/.exec(s);
    if (m) {
      for (const part of m[1].split(',')) {
        const name = part.split(':').pop().trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) map.set(name, m[2]);
      }
    }
  }
  return map;
}

const lastSeg = (r) =>
  String(r ?? '')
    .replace(/\[\d+\]/g, '')
    .split('.')
    .filter(Boolean)
    .pop();

// PREF-L 的末段规则 = 参考实现原样（**不剥下标**，缺口之二）
const lastSegL = (r) => String(r ?? '').split('.').pop();

function isCommentLineA(s) {
  return s.startsWith('//') || s.startsWith('*') || s.startsWith('/*');
}

function isCommentLineL(s) {
  return s.startsWith('//');
}

/** PREF-L 单记录扫描（复刻参考实现：无块界、仅 [0].、子串根、缺失文件=[]、越界 continue） */
function scanLegacy(ctx, rec, window) {
  const lines = ctx.lines(rec.file);
  const { root } = rootOfText(rec.text, 'L');
  if (window > 0) {
    for (let d = -window; d <= window; d++) {
      if (d === 0) continue;
      const i = rec.line - 1 + d;
      if (i < 0 || i >= lines.length) continue; // 缺口⑤：越界静默跳过
      const s = lines[i].trim();
      if (!s || isCommentLineL(s)) continue;
      const hasRoot = Boolean(root && s.includes(lastSegL(root))); // 缺口④：子串包含
      if (IDENT_L.test(s) && (hasRoot || s.includes('[0].') || s.includes('sort()'))) {
        return { hit: true, neighborLine: rec.line + d, neighborText: s, level: hasRoot ? 'strong' : 'weak', form: null };
      }
    }
  }
  return { hit: false, neighborLine: null, neighborText: '', level: null, form: null };
}

/** 锚点校验：ok / drift-relocated / ambiguous / stale */
function anchorOf(lines, rec) {
  const N = 25;
  const norm = (x) => x.replace(/\s+/g, ' ').trim();
  const needle = norm(rec.text).slice(0, N);
  if (!needle) return { anchor: 'stale', relocatedLine: null };
  const idx = rec.line - 1;
  if (idx >= 0 && idx < lines.length && norm(lines[idx]).includes(needle)) {
    return { anchor: 'ok', relocatedLine: null };
  }
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (norm(lines[i]).includes(needle)) hits.push(i + 1);
  }
  if (hits.length === 1) return { anchor: 'drift-relocated', relocatedLine: hits[0] };
  if (hits.length >= 2) return { anchor: 'ambiguous', relocatedLine: null };
  return { anchor: 'stale', relocatedLine: null };
}

/** 块界：上界=上方最近 test(/it( 行；下界=下方首个 `});` 行（不含端点） */
function blockBounds(lines, anchorLine) {
  const i = anchorLine - 1;
  let top = 0;
  let bottom = lines.length - 1;
  for (let k = i; k >= 0; k--) {
    if (/^\s*(await\s+)?(test|it)\s*\(/.test(lines[k])) {
      top = k;
      break;
    }
  }
  for (let k = i + 1; k < lines.length; k++) {
    if (/^\}\);?\s*$/.test(lines[k])) {
      bottom = k;
      break;
    }
  }
  return { top, bottom }; // 0-based，均不含
}

/** PREF-A 单记录扫描 */
function scanAuth(ctx, rec, window, useBlockBound) {
  const lines = ctx.lines(rec.file);
  const anchor = anchorOf(lines, rec);
  if (anchor.anchor === 'ambiguous' || anchor.anchor === 'stale') {
    return { status: 'blocked', anchor: anchor.anchor, relocatedLine: null, level: null, form: null, neighborLine: null, neighborText: '', sameLine: false, reason: anchor.anchor === 'ambiguous' ? '锚点头部多义（≥2 处），不猜' : '锚点 text 不在树上（已被改写或删除）' };
  }
  const aLine = anchor.anchor === 'ok' ? rec.line : anchor.relocatedLine;

  // 取根（三层）
  let { root, layer } = rootOfText(rec.text);
  const aliases = aliasMapOf(lines);
  if (root && aliases.has(lastSeg(root))) {
    root = aliases.get(lastSeg(root));
    layer = 'L3';
  }
  const rootSeg = root ? lastSeg(root) : null;
  const singleChar = rootSeg !== null && rootSeg.length === 1;

  const { top, bottom } = useBlockBound ? blockBounds(lines, aLine) : { top: -1, bottom: lines.length };

  // 同行信号（d=0，单列，不进 hit）
  const sameIdx = aLine - 1;
  let sameLine = false;
  if (sameIdx >= 0 && sameIdx < lines.length) {
    const s0 = lines[sameIdx].trim();
    if (s0 && !isCommentLineA(s0) && formOf(s0)) sameLine = true;
  }

  if (window <= 0) {
    return { status: 'nohit', anchor: anchor.anchor, relocatedLine: anchor.relocatedLine, level: null, form: null, neighborLine: null, neighborText: '', sameLine, reason: 'window=0（负控：邻位域为空）' };
  }

  let best = null;
  for (let d = -window; d <= window; d++) {
    if (d === 0) continue; // 同行不计（AC-10）
    const idx = aLine - 1 + d;
    if (idx <= top || idx >= bottom) continue; // 块界（AC-9）
    if (idx < 0 || idx >= lines.length) continue;
    const s = lines[idx].trim();
    if (!s || isCommentLineA(s)) continue; // 注释面（AC-13）
    const form = formOf(s);
    if (!form) continue;
    // 对象名整词匹配（禁子串）
    let level = 'weak';
    if (rootSeg && !singleChar) {
      const wordRe = new RegExp(`(^|[^A-Za-z0-9_$])${rootSeg.replace(/[$]/g, '\\$')}([^A-Za-z0-9_$]|$)`);
      if (wordRe.test(s)) level = 'strong';
    }
    const cand = { line: aLine + d, text: s, level, form, d: Math.abs(d) };
    if (!best || cand.d < best.d || (cand.d === best.d && cand.line < best.line)) best = cand;
  }
  if (!best) {
    return { status: 'nohit', anchor: anchor.anchor, relocatedLine: anchor.relocatedLine, level: null, form: null, neighborLine: null, neighborText: '', sameLine, reason: '邻位（同块 ±window）内无 F1/F2/F3 形态' };
  }
  return {
    status: 'hit',
    anchor: anchor.anchor,
    relocatedLine: anchor.relocatedLine,
    level: best.level,
    form: best.form,
    neighborLine: best.line,
    neighborText: best.text,
    sameLine,
    reason: `${best.form} 形态 ∧ ${best.level === 'strong' ? '对象名整词匹配' : '对象名未匹配/单字符根'}`,
  };
}

// ───────────────────────────── 输入校验（F-类 fail-closed）─────────────────────────────
const REQ_FIELDS = ['file', 'line', 'seq', 'stableKey', 'keyText', 'text', 'type', 'numSource', 'disposition', 'evidence'];

function fail(msg) {
  process.stderr.write(`FAIL-CLOSED: ${msg}\n`);
  process.exit(2);
}

function loadTable(tablePath) {
  let raw;
  try {
    raw = fs.readFileSync(tablePath, 'utf8');
  } catch (e) {
    fail(`输入表不可读：${tablePath}（${e.message}）`);
  }
  let table;
  try {
    table = JSON.parse(raw);
  } catch (e) {
    fail(`输入表 JSON 非法：${e.message}`);
  }
  const records = Array.isArray(table) ? table : table.records;
  if (!Array.isArray(records)) fail('输入表缺少 records[]');
  const seenKey = new Set();
  const seenLine = new Set();
  for (const [i, r] of records.entries()) {
    for (const f of REQ_FIELDS) {
      if (!(f in r)) fail(`records[${i}] 缺字段 ${f}`);
    }
    if (typeof r.file !== 'string' || typeof r.text !== 'string' || typeof r.stableKey !== 'string') {
      fail(`records[${i}] 字段类型非法（file/text/stableKey 须为 string）`);
    }
    if (!Number.isInteger(r.line)) fail(`records[${i}].line 须为整数`);
    if (seenKey.has(r.stableKey)) fail(`stableKey 重复：${r.stableKey}`);
    seenKey.add(r.stableKey);
    const lk = `${r.file}\u0000${r.line}\u0000${r.text}`;
    if (seenLine.has(lk)) fail(`(file,line,text) 重复：${r.file}:${r.line}`);
    seenLine.add(lk);
  }
  return { table, records };
}

function makeCtx(repo) {
  const cache = new Map();
  return {
    lines(file) {
      if (cache.has(file)) return cache.get(file);
      const p = path.join(repo, file);
      let txt;
      try {
        txt = fs.readFileSync(p, 'utf8');
      } catch (e) {
        fail(`记录指向的文件不可读：${file}（${e.message}）`);
      }
      const arr = txt.split('\n');
      cache.set(file, arr);
      return arr;
    },
  };
}

// ───────────────────────────── 主流程 ─────────────────────────────
function parseArgs(argv) {
  const o = {
    table: null,
    mode: 'A',
    window: 4,
    repo: REPO_DEFAULT,
    disposition: '改',
    out: null,
    tsv: null,
    summaryJson: null,
    domain: null,
    blockBound: true,
    debugJson: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`参数 ${a} 缺值`);
      return v;
    };
    if (a === '--help' || a === '-h') {
      o.help = true;
    } else if (a === '--table') o.table = next();
    else if (a === '--mode') o.mode = next().toUpperCase();
    else if (a === '--window') o.window = Number(next());
    else if (a === '--repo') o.repo = next();
    else if (a === '--disposition') o.disposition = next();
    else if (a === '--out') o.out = next();
    else if (a === '--tsv') o.tsv = next();
    else if (a === '--summary-json') o.summaryJson = next();
    else if (a === '--domain') {
      const list = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) list.push(argv[++i]);
      o.domain = list.length ? list : null;
    } else if (a === '--no-block-bound') o.blockBound = false;
    else if (a === '--debug-json') o.debugJson = next();
    else fail(`未知参数：${a}`);
  }
  return o;
}

function usage() {
  return `neighbor-scan.mjs —— 邻位身份断言前置过滤器（只读）

用法：
  node scripts/neighbor-scan.mjs --table <v2表.json> [选项]

必填：
  --table <path>         v2 普查表（{meta, records[]}）
  --domain <a> [b ...]   域名过滤 —— **必写**（裸跑 = 全量 362，与域内读数不可比）
  --window <n>           邻位窗口 —— **必写**（0 = 负控）

⚠ **读数引用纪律**：引用任何读数必须同时带**三件**——「table 版本」/「domain」/「window」；
   缺任一件即视为无效引用。裸跑（不给 --domain）的「全量 362」与域内读数**不可比、禁混引**。

选项：
  --mode A|L             口径（缺省 A=权威；L=逐字复刻参考实现，用于回归复算）
  --window <n>           邻位窗口（**必写**：缺省 4 仅为兼容旧调用；0 = 负控，须 hit=0）
  --repo <path>          被扫仓库根（缺省 ${REPO_DEFAULT}）
  --disposition <s>      只扫该处置（缺省『改』；传 "" 关闭过滤）
  --domain <a> [b ...]   域名过滤（**必写**：不写 = 全量读数，禁与域内读数混引）
  --out <path>           filtered census 输出（新文件，UTF-8；原表永不就地改）
                         ⚠ PF-4：--out 输出的是**全表 1522 条**（非「改」的 711 条原样保留、不带 prefilter）；
                           而 summary / TSV **只涉 disposition=改 的 811 条** —— 1522 与 811 之差是设计，不是 bug
  --tsv <path>           九列 TSV：file,line,text,hit,neighborLine,neighborText,decision,level,anchor
                         decision ∈ {hit, nohit, blocked-ambiguous, blocked-stale}｜level ∈ {strong, weak, -}｜anchor ∈ {ok, relocated, ambiguous, stale}
  --summary-json <path>  汇总 JSON 输出
  --no-block-bound       关闭 test 块界（仅用于 AC-9 对照）

退出码：0 正常｜1 守恒式不成立｜2 F-类输入坏（不产出）｜3 存在 blocked
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (!args.table) fail('缺 --table');
  if (args.mode !== 'A' && args.mode !== 'L') fail(`--mode 须为 A 或 L（收到 ${args.mode}）`);

  const { table, records } = loadTable(args.table);
  const ctx = makeCtx(args.repo);

  const targets = records.filter(
    (r) => (!args.disposition || r.disposition === args.disposition) && (!args.domain || args.domain.includes(domainOf(r.file))),
  );

  // 行号越界 = F-类（fail-closed，不得静默跳过）
  for (const r of targets) {
    const lines = ctx.lines(r.file);
    if (r.line < 1 || r.line > lines.length) fail(`行号越界：${r.file}:${r.line}（文件 ${lines.length} 行）`);
  }

  const rows = [];
  let strong = 0,
    weak = 0,
    hit = 0,
    blocked = 0,
    stale = 0,
    ambiguous = 0,
    anchorOk = 0,
    relocated = 0,
    sameLineCount = 0;

  for (const r of targets) {
    if (args.mode === 'L') {
      const res = scanLegacy(ctx, r, args.window);
      const isHit = res.hit;
      if (isHit) {
        hit++;
        if (res.level === 'strong') strong++;
        else weak++;
      }
      rows.push({
        rec: r,
        tsv: {
          file: r.file,
          line: r.line,
          text: r.text,
          hit: isHit ? 1 : 0,
          neighborLine: res.neighborLine ?? '',
          neighborText: res.neighborText ?? '',
        },
        prefilter: {
          status: isHit ? 'hit' : 'nohit',
          level: res.level,
          form: res.form,
          neighborLine: res.neighborLine,
          neighborKey: res.neighborLine ? `${r.file}#L${res.neighborLine}` : null,
          anchor: 'ok',
          relocatedLine: null,
          sameLineIdentity: false,
          reason: isHit ? 'PREF-L（参考口径）：邻位内 11-token IDENT 命中' : 'PREF-L：邻位内无 IDENT 命中',
        },
      });
    } else {
      const res = scanAuth(ctx, r, args.window, args.blockBound);
      if (res.status === 'blocked') blocked++;
      else if (res.status === 'hit') hit++;
      if (res.level === 'strong') strong++;
      else if (res.level === 'weak') weak++;
      if (res.anchor === 'ok') anchorOk++;
      else if (res.anchor === 'drift-relocated') relocated++;
      else if (res.anchor === 'stale') stale++;
      else if (res.anchor === 'ambiguous') ambiguous++;
      if (res.sameLine) sameLineCount++;
      rows.push({
        rec: r,
        tsv: {
          file: r.file,
          line: r.line,
          text: r.text,
          hit: res.status === 'hit' ? 1 : 0,
          neighborLine: res.neighborLine ?? '',
          neighborText: res.neighborText ?? '',
        },
        prefilter: {
          status: res.status,
          level: res.level,
          form: res.form,
          neighborLine: res.neighborLine,
          neighborKey: res.neighborLine ? `${r.file}#L${res.neighborLine}` : null,
          anchor: res.anchor,
          relocatedLine: res.relocatedLine,
          sameLineIdentity: res.sameLine,
          reason: String(res.reason).slice(0, 120),
        },
      });
    }
  }

  const nohit = args.mode === 'A' ? targets.length - hit - blocked : targets.length - hit;
  const total = targets.length;

  // 九列 TSV：PF-3 决策码 —— 后三列为决策面（可逐条复核 strong/weak/blocked 原因）
  // decision: hit | nohit | blocked-ambiguous | blocked-stale
  // level:    strong | weak | -（非 hit）
  // anchor:   ok | relocated | ambiguous | stale
  const tsvLines = ['file\tline\ttext\thit\tneighborLine\tneighborText\tdecision\tlevel\tanchor'];
  const anchorLabel = (a) => (a === 'drift-relocated' ? 'relocated' : a ?? 'ok');
  for (const row of rows) {
    const t = row.tsv;
    const pf = row.prefilter;
    let decision;
    if (pf.status === 'hit') decision = 'hit';
    else if (pf.status === 'nohit') decision = 'nohit';
    else decision = pf.anchor === 'ambiguous' ? 'blocked-ambiguous' : 'blocked-stale';
    const levelCol = pf.status === 'hit' ? pf.level ?? '-' : '-';
    tsvLines.push(
      [
        t.file,
        t.line,
        String(t.text).replace(/\t/g, ' ').replace(/\n/g, ' ').slice(0, 200),
        t.hit,
        t.neighborLine,
        String(t.neighborText).replace(/\t/g, ' ').slice(0, 200),
        decision,
        levelCol,
        anchorLabel(pf.anchor),
      ].join('\t'),
    );
  }
  const tsvText = tsvLines.join('\n') + '\n';
  if (args.tsv) fs.writeFileSync(args.tsv, tsvText, 'utf8');

  // filtered census（新文件；原表绝不就地改；非「改」记录不带 prefilter 键）
  if (args.out) {
    const byKey = new Map(rows.map((r) => [r.rec.stableKey, r.prefilter]));
    const clone = JSON.parse(JSON.stringify(table));
    const cloneRecs = Array.isArray(clone) ? clone : clone.records;
    for (const r of cloneRecs) {
      if (r.disposition !== args.disposition) continue;
      const pf = byKey.get(r.stableKey);
      if (!pf) continue;
      r.prefilterHit = pf.status === 'hit';
      r.prefilter = pf;
    }
    fs.writeFileSync(args.out, JSON.stringify(clone, null, 2), 'utf8');
  }

  // 汇总
  const summary = {
    mode: args.mode,
    window: args.window,
    disposition: args.disposition || '*',
    records: total,
    hit,
    nohit,
    blocked,
    strong,
    weak,
    sameLine: sameLineCount,
    stale,
    ambiguous,
    anchorOk,
    relocated,
  };
  if (args.summaryJson) fs.writeFileSync(args.summaryJson, JSON.stringify(summary, null, 2), 'utf8');
  if (args.debugJson) {
    fs.writeFileSync(
      args.debugJson,
      JSON.stringify(rows.map((r) => ({ stableKey: r.rec.stableKey, file: r.rec.file, line: r.rec.line, text: r.rec.text, ...r.prefilter })), null, 2),
      'utf8',
    );
  }

  const summaryLine =
    `records=${total} hit=${hit} nohit=${nohit} blocked=${blocked} strong=${strong} weak=${weak} ` +
    `sameLine=${sameLineCount} stale=${stale} ambiguous=${ambiguous} anchorOk=${anchorOk} relocated=${relocated} ` +
    `window=${args.window} mode=${args.mode}`;
  process.stdout.write(summaryLine + '\n');

  // 守恒式（仅 PREF-A 有 blocked 语义；L 档 records=hit+nohit）
  if (args.mode === 'A') {
    const c1 = total === hit + nohit + blocked;
    const c2 = hit === strong + weak;
    const c3 = hit + nohit === anchorOk + relocated;
    if (!c1 || !c2 || !c3) {
      process.stderr.write(`CONSERVATION-BROKEN: c1=${c1} c2=${c2} c3=${c3}\n`);
      return 1;
    }
    if (blocked > 0) return 3;
    return 0;
  }
  return 0;
}

process.exitCode = main();
