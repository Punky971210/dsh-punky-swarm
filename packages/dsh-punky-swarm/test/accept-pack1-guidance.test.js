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

// test/accept-pack1-guidance.test.js —— 批 `punky-iter-a-20261024` · **pack1 验收套件**（lane `t1-tests`）
// ─────────────────────────────────────────────────────────────────────────────
// 判据来源 = `plan/p2-taskpack-1.md` 的 `## 验收标准`（AC-1..AC-12），**逐条一对一**编号 `AC-pack1-N`。
// 与 coder 的 `test/guidance-id-coverage.test.js` 分工：那是**实现侧**的单文件回归（判据自身有没有牙），
//   本件是**验收侧**的独立探针（规格条目有没有兑现），两者同源不同向、可互相证伪。
//
// 只读纪律：
//   · 本件不写目标仓任何文件（读文本 + 只读命令 `spawnSync`）；负例副本一律落 `os.tmpdir()`。
//   · **禁跑** `npm run build` / `npm test`（首段 build 会重写全量 `lib/**` = pack2 的独占窗口）。
//   · 执行方式：`node --test test/accept-pack1-guidance.test.js`
//
// 四态纪律：每条用例正文首行写明**失败条件**；报告侧四态（通过/失败/跳过/未验证）逐位留档，
//   跳过只用于「并行窗口内结构性不可判」，**不折算**为通过。
//
// 时点纪律：`AC-pack1-1` 的「改前 RED」是**时点读数**（正文补齐前才存在），本件只能断言其**机制可达**
//   （负例 N1），真实改前读数须由 exec 报告原样贴出（我方已独立取得，见 exec/t1-test-suite.md §二）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PKG_ROOT, '..', '..');
const BASELINE = 'bfb9b0c';
const SCRIPT_REL = 'scripts/check-guidance-sync.mjs';
const DISCIPLINE_REL = 'presets/punky-preset/references/discipline.md';
const GUIDANCE_REL = 'presets/punky-preset/agent.cordis.yml';
const CODER_TEST_REL = 'test/guidance-id-coverage.test.js';
const BATCH_ARTIFACTS = process.env.PUNKY_BATCH_ARTIFACTS
  ?? path.join('C:\\', 'Users', 'Administrator', '.dsh', 'punky-preset', 'sessions',
    'aa_8dbc24d193cde729_sess_Io1QHlQjQQDFxw', 'artifacts', 'punky-iter-a-20261024');

const TMP = [];
test.after(() => { for (const d of TMP) fs.rmSync(d, { recursive: true, force: true }); });

const absOf = (rel) => path.join(PKG_ROOT, ...rel.split('/'));
const readRel = (rel) => fs.readFileSync(absOf(rel), 'utf8');
const normWs = (s) => s.replace(/\s+/g, ' ').trim();

/** 子进程 env：剥掉「本进程作为 `--test` 子上下文」时注入的变量——
 *  否则被 spawn 的 `node --test` 会改走 TAP 通道，`ℹ tests/pass/fail` 摘要行读不到（实测踩过）。 */
function childEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST_')) delete env[k];
  return env;
}

function runScript(args, cwd = PKG_ROOT) {
  const r = spawnSync(process.execPath, [SCRIPT_REL, ...args], { cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function runScriptJson(args, cwd = PKG_ROOT) {
  const r = runScript([...args, '--json'], cwd);
  let doc = null;
  try { doc = JSON.parse(r.stdout); } catch { /* 交给调用方 assert.fail */ }
  return { ...r, doc };
}

/** 与实现同源的注入面条目解析（`scripts/check-guidance-sync.mjs#inlineEntriesOf`，缩进 ≥6）。 */
function inlineEntriesOf(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s{6,}([0-9]{1,2}[a-z]?)\.\s+(\S.*)$/.exec(line);
    if (!m) continue;
    out.push({ id: m[1], text: m[2], pointers: [...m[2].matchAll(/#§([0-9]+[a-z]?)/g)].map((x) => x[1]) });
  }
  return out;
}

const SECTION_RE = /^## §([0-9]+[a-z]?)\s/;

/** 取 `## §<id> ` 小节（body 不含标题行、止于下一条 h2/h1）。 */
function sectionOf(text, id) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => {
    const m = SECTION_RE.exec(l);
    return m !== null && m[1] === id;
  });
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,2}\s/.test(lines[i])) { end = i; break; }
  }
  return { heading: lines[start], body: lines.slice(start + 1, end).join('\n').trimEnd() };
}

/** 归一后「长度 24 的滑窗」在对方文本中出现的个数（AC-6 的可跑算法）。 */
function windowHits(subject, corpus, size = 24) {
  const a = normWs(subject);
  const b = normWs(corpus);
  const hits = [];
  for (let i = 0; i + size <= a.length; i += 1) {
    const w = a.slice(i, i + size);
    if (b.includes(w)) hits.push(w);
  }
  return hits;
}

/** porcelain 路径（`XY <path>`：状态位恰 2 字符 + 1 空格；**不得先 trim**，否则首行状态位被吃掉）。 */
function porcelainPaths() {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, 'git status 必须可用：' + (r.stderr ?? ''));
  return (r.stdout ?? '').split(/\r?\n/).filter((l) => l.length > 0).map((line) => {
    const m = /^(..)\s(.*)$/.exec(line);
    assert.ok(m, `porcelain 行无法解析（格式变了？）：${JSON.stringify(line)}`);
    let p = m[2];
    if (p.includes(' -> ')) p = p.split(' -> ').pop();
    return p.replace(/^"|"$/g, '');
  });
}

/** 禁区黑名单（**常驻不变量**，**不是**批窗口写域）：任何**未提交**变更都不许落在这些面上 ——
 *  `baselines/**` 单写者 = Leader；`docs/**`、`reports/**` 为只读记录面。
 *  注入面（`presets/punky-preset/**`）**不列入**本黑名单：它的判据是「repo ↔ live 同 sha256」
 *  （见 `AC-pack1-12` 首段），改一份即改另一件属**合法**演进 ⇒ 列入会与判据⑦ 造双口径。 */
const FORBIDDEN_ZONES = [
  /^packages\/dsh-punky-swarm\/baselines\//,
  /^packages\/dsh-punky-swarm\/docs\//,
  /^packages\/dsh-punky-swarm\/reports\//,
];

/** 负例夹具：临时根（`scripts/` + `presets/punky-preset/{agent.cordis.yml,references/discipline.md}`）。 */
function mkTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-p1-'));
  TMP.push(root);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(absOf(SCRIPT_REL), path.join(root, 'scripts', 'check-guidance-sync.mjs'));
  const dst = path.join(root, 'presets', 'punky-preset');
  fs.mkdirSync(path.join(dst, 'references'), { recursive: true });
  fs.copyFileSync(absOf(GUIDANCE_REL), path.join(dst, 'agent.cordis.yml'));
  fs.copyFileSync(absOf(DISCIPLINE_REL), path.join(dst, 'references', 'discipline.md'));
  return root;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AC-1 判据 ②b 在场（源码级）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack1-1 判据 ②b（forward-id，按 id 强制）在场且未引入白名单占位', () => {
  // 失败条件：脚本内无 `check: 'forward-id'`（②b 未实现），或出现 `SELF_SUFFICIENT` 之类可豁免白名单
  //           （Q-H 已裁「废除自足条目机制、不保留空白名单」）。
  const src = readRel(SCRIPT_REL);
  assert.ok(src.includes("check: 'forward-id'"),
    '②b 判据必须在场：脚本内缺 `check: \'forward-id\'` ⇒ 注入面条目无正文小节时不会判红');
  assert.equal((src.match(/SELF_SUFFICIENT/g) ?? []).length, 0,
    'Q-H：禁引入 `SELF_SUFFICIENT_ENTRIES` 之类白名单占位（宁可将来真自足条目时判红）');
  // ②b 必须复用既有集合、零新解析器（K-4）：`sectionIds.has(e.id)` 形态
  assert.ok(/sectionIds\s*\.\s*has\(\s*e\.id\s*\)/.test(src),
    '②b 须复用既有 `sectionIds` 集合（禁在判据里重建解析器 ⇒ 双口径）');
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-2 三新节各恰 1 处且标题以 `## §` 起
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack1-2 三新节 §0i/§0s/§0t 各恰 1 处（`## §` 二级标题）', () => {
  // 失败条件：任一新节缺失、重复，或写成 `### §0i` / `**§0i**` 等非 `## ` 形态
  //           （标题形态变了，判据 ②/③/②b 的解析器都读不到 ⇒ 静默失效）。
  const body = readRel(DISCIPLINE_REL);
  for (const id of ['0i', '0s', '0t']) {
    const n = (body.match(new RegExp('^## §' + id + '[ \\t]', 'gm')) ?? []).length;
    assert.equal(n, 1, `§${id} 须恰 1 处 \`## §${id} \` 标题，实测 ${n}`);
  }
  const trio = (body.match(/^## §0(i|s|t)/gm) ?? []).length;
  assert.equal(trio, 3, `\`^## §0(i|s|t)\` 命中须 = 3，实测 ${trio}`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-3 正文小节总数 = 32（基线 29 + 3）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack1-3 正文 `## §` 小节总数 = 32', () => {
  // 失败条件：少于 32（三节未全落/落成了非 `## §` 形态），或多于 32（顺手删/增了别的小节 ⇒ 越界改动）。
  const n = (readRel(DISCIPLINE_REL).match(/^## §/gm) ?? []).length;
  assert.equal(n, 32, `正文 §小节须 = 32（基线 29 + 新增 3），实测 ${n}`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-4 判据全绿（含 ②b）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack1-4 `check-guidance-sync --no-live` 全绿：exit 0 / 条目 27 / 小节 32 / forward-id 失败 0', () => {
  // 失败条件：三节任一缺失（②b 报 forward-id）、正文小节数与注入面不对称（③ 报 reverse）、
  //           或脚本自身回归（退出码非 0）。这是 pack1 的**唯一收口读数**（AC-1 的 GREEN 侧）。
  const r = runScriptJson(['--no-live']);
  assert.ok(r.doc, 'no JSON 输出，脚本可能崩了：stderr=' + r.stderr.slice(0, 400));
  assert.equal(r.doc.inlineEntries, 27, '注入面条目须 = 27');
  assert.equal(r.doc.bodySections, 32, '正文 §小节须 = 32');
  const byCheck = (name) => (r.doc.failures ?? []).filter((f) => f.check === name);
  assert.deepEqual(byCheck('forward-id'), [], 'forward-id（②b）失败数须 = 0');
  assert.equal(r.doc.ok, true, 'ok 须为 true；failures=' + JSON.stringify(r.doc.failures));
  assert.equal(r.status, 0, 'exit 须 = 0；stderr=' + r.stderr.slice(0, 400));
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-5a 负例 N1：删掉/降级一个新节 ⇒ 判据必红（Q-A「判据必须有牙」）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack1-5a 负例 N1：副本里降级 `## §0t` 标题 ⇒ forward-id 恰 1 条且含 0t（必失败构造）', () => {
  // 失败条件：删节后判据仍 GREEN（= 新判据没牙，Q-A 的核心要求落空），
  //           或红得过多（>1 条 forward-id ⇒ 判据面污染、定位不到 0t）。
  const root = mkTempRoot();
  const rel = path.join(root, 'presets', 'punky-preset', 'references', 'discipline.md');
  const original = fs.readFileSync(rel, 'utf8');
  const demoted = original.replace(/^## (§0t\s)/m, '$1');
  assert.notEqual(demoted, original, '构造失败：副本里找不到 `## §0t` 标题行（三节未落？）');
  fs.writeFileSync(rel, demoted, 'utf8');

  const r = runScriptJson(['--no-live'], root);
  assert.ok(r.doc, 'no JSON：' + r.stderr.slice(0, 400));
  const fwd = (r.doc.failures ?? []).filter((f) => f.check === 'forward-id');
  assert.equal(r.status, 1, '降级后 exit 须 = 1');
  assert.equal(fwd.length, 1, 'forward-id 须恰 1 条，实测 ' + fwd.length + '：' + JSON.stringify(fwd));
  assert.match(fwd[0].detail, /0t/, 'detail 须点名 0t：' + fwd[0].detail);
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-5b 正例 N2：同一夹具、同输入、不删任何节 ⇒ 红只来自删除（可证伪性）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack1-5b 正例 N2：同夹具不删节 ⇒ 失败集 = N1 失败集 ∖ {0t} 的对称差为空', () => {
  // 失败条件：未删节的副本也报 0t（⇒ N1 的红不是删除导致，而是夹具/环境导致，N1 不可证伪）；
  //           或未删节的副本报出 N1 之外的失败（⇒ 夹具不干净，两读数不可比）。
  const clean = mkTempRoot();
  const cleanRun = runScriptJson(['--no-live'], clean);
  assert.ok(cleanRun.doc, 'no JSON：' + cleanRun.stderr.slice(0, 400));

  const dirty = mkTempRoot();
  const rel = path.join(dirty, 'presets', 'punky-preset', 'references', 'discipline.md');
  fs.writeFileSync(rel, fs.readFileSync(rel, 'utf8').replace(/^## (§0t\s)/m, '$1'), 'utf8');
  const dirtyRun = runScriptJson(['--no-live'], dirty);
  assert.ok(dirtyRun.doc, 'no JSON：' + dirtyRun.stderr.slice(0, 400));

  const keyOf = (f) => f.check + '|' + f.detail;
  const cleanSet = new Set((cleanRun.doc.failures ?? []).map(keyOf));
  const dirtySet = new Set((dirtyRun.doc.failures ?? []).map(keyOf));
  const added = [...dirtySet].filter((k) => !cleanSet.has(k));
  const removed = [...cleanSet].filter((k) => !dirtySet.has(k));

  assert.deepEqual(removed, [], '同输入对照：不删节不得**减少**失败项（夹具不干净）');
  assert.equal(added.length, 1, '删一节须**恰**新增 1 条失败，实测 ' + added.length + '：' + JSON.stringify(added));
  assert.match(added[0], /forward-id\|.*0t/, '新增的失败须是 §0t 的 forward-id：' + added[0]);
  // 夹具自洽：退出码与失败集一致（防「有失败却 exit 0」的静默）
  assert.equal(cleanRun.status, (cleanRun.doc.failures ?? []).length === 0 ? 0 : 1,
    '未删节副本的 exit 须与 failures.length 一致');
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-5c 负例 N3：注入面有、正文无 ⇒ 判据必红（Q-H 废除自足条目后的核心语义）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack1-5c 负例 N3：向注入面注入一条无正文小节的条目 ⇒ forward-id 必红且点名该条目', () => {
  // 失败条件：注入面新增条目后判据仍 GREEN（⇒ 「自足条目」豁免口子还在，R-05/Q-H 未真正落地）。
  const root = mkTempRoot();
  const gRel = path.join(root, 'presets', 'punky-preset', 'agent.cordis.yml');
  const lines = fs.readFileSync(gRel, 'utf8').split('\n');
  const idx = lines.findIndex((l) => /^\s{6,}0u\.\s+\S/.test(l));
  assert.ok(idx >= 0, '构造失败：注入面找不到 0u 条目行');
  const indent = /^\s*/.exec(lines[idx])[0];
  lines.splice(idx + 1, 0, `${indent}0z. 验收套件负例注入条目：该条仅有注入面、无正文小节 §0z。`);
  fs.writeFileSync(gRel, lines.join('\n'), 'utf8');

  const r = runScriptJson(['--no-live'], root);
  assert.ok(r.doc, 'no JSON：' + r.stderr.slice(0, 400));
  const fwd = (r.doc.failures ?? []).filter((f) => f.check === 'forward-id');
  assert.equal(r.doc.inlineEntries, 28, '注入面条目数须随注入变为 28（证明构造生效）');
  assert.equal(fwd.length, 1, 'forward-id 须恰 1 条，实测 ' + fwd.length + '：' + JSON.stringify(fwd));
  assert.match(fwd[0].detail, /0z/, 'detail 须点名注入的条目 0z：' + fwd[0].detail);
  assert.equal(r.status, 1, 'exit 须 = 1');
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-6 注意事项面不复制操作原文（Q-B）：最长公共窗口 = 0 且每节 ≥ 120 字
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack1-6 三新节与对应注入面条目：24 字窗命中 = 0，且每节正文 ≥ 120 字', () => {
  // 失败条件：任一节出现 ≥24 字的连续公共串（= 把操作面整句抄进正文，Q-B 硬阈值被破），
  //           或任一节正文 < 120 字（= 用一行抄过去再改名绕过阈值）。
  const body = readRel(DISCIPLINE_REL);
  const entries = new Map(inlineEntriesOf(readRel(GUIDANCE_REL)).map((e) => [e.id, e.text]));
  const report = [];
  for (const id of ['0i', '0s', '0t']) {
    const sec = sectionOf(body, id);
    assert.ok(sec, `§${id} 小节缺失（无法核 AC-6）`);
    const entryText = entries.get(id);
    assert.ok(entryText, `注入面缺条目 ${id}（无法核 AC-6）`);
    const hits = windowHits(sec.body, entryText, 24);
    const len = [...normWs(sec.body)].length;
    report.push(`§${id}: 正文长度=${len}｜24 字窗命中=${hits.length}${hits.length ? ' → ' + JSON.stringify(hits.slice(0, 3)) : ''}`);
    assert.equal(hits.length, 0, `§${id} 与注入面条目存在 ≥24 字连续公共串（Q-B 阈值被破）：${JSON.stringify(hits.slice(0, 3))}`);
    assert.ok(len >= 120, `§${id} 正文须 ≥ 120 字，实测 ${len}`);
  }
  process.stdout.write('[AC-pack1-6] ' + report.join(' ； ') + '\n');
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-7 §0k 含机读行与 4 档强度，且未新增 verdict 值
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack1-7 §0k 有 `SUMMARY:` 机读行 ＋ 4 档强度，且 `{pass, fail, skip}` 未被改写、强度未进 verdict', () => {
  // 失败条件：§0k 无 `SUMMARY:` 行 / 缺任一顿（PROVED·SEMI_PROVED·VIOLATED·UNKNOWN）/
  //           `pass, fail, skip` 表述被改坏（下游 verdict 白名单会失配）/ 强度被写成 verdict 的取值。
  const body = readRel(DISCIPLINE_REL);
  const sec = sectionOf(body, '0k');
  assert.ok(sec, '§0k 小节缺失');
  assert.ok((sec.body.match(/SUMMARY:/g) ?? []).length >= 1, '§0k 须含 ≥1 处 `SUMMARY:` 机读结论行');
  for (const tier of ['PROVED', 'SEMI_PROVED', 'VIOLATED', 'UNKNOWN']) {
    const n = (sec.body.match(new RegExp('\\b' + tier + '\\b', 'g')) ?? []).length;
    assert.ok(n >= 1, `§0k 须含强度档 \`${tier}\`（实测 ${n}）`);
  }
  assert.ok(body.includes('pass, fail, skip'),
    '`verdict ∈ {pass, fail, skip}` 表述须仍在场且未被改写（Q-C 禁区：强度不是 verdict）');
  // 禁区（赋值形态）：整篇禁 `verdict: 'PROVED'` / `verdict = PROVED` 之类
  const assign = body.match(/verdict\s*[:=∈]\s*['"`]?\s*(?:SEMI_PROVED|PROVED|VIOLATED|UNKNOWN)/g) ?? [];
  assert.deepEqual(assign, [], '禁把强度写进 verdict 取值位：' + JSON.stringify(assign));
  // 同行邻域：允许「禁把 PROVED 写进 verdict」这类**禁令句**，但不允许非禁令句共现
  const cooc = body.split(/\r?\n/)
    .filter((l) => /\b(?:SEMI_PROVED|PROVED|VIOLATED|UNKNOWN)\b/.test(l) && l.includes('verdict'));
  const notProhibition = cooc.filter((l) => !/(禁|不得|不是|非|勿)/.test(l));
  assert.deepEqual(notProhibition, [],
    '强度与 verdict 同行出现时必须是否禁令句（否则易被读成 verdict 取值）：' + JSON.stringify(notProhibition));
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-8 头注判据计数同步（四条 → 五条；无白名单占位）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack1-8 脚本头注 = 「五条判据」、旧「四条判据」清零、无 SELF_SUFFICIENT', () => {
  // 失败条件：头注仍写四条（判据数与实现脱节，审计面失真）/ 旧表述残留 / 出现白名单占位。
  const src = readRel(SCRIPT_REL);
  assert.ok((src.match(/五条判据/g) ?? []).length >= 1, '须出现「五条判据」≥1');
  assert.equal((src.match(/四条判据/g) ?? []).length, 0, '旧「四条判据」须 = 0');
  assert.equal((src.match(/SELF_SUFFICIENT/g) ?? []).length, 0, '`SELF_SUFFICIENT` 须 = 0（Q-H）');
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-9 R-06 数值订正（26 → 27）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack1-9 R-06：注释「放宽得 27 条」在场、「26 条」清零，且实测 inlineEntries = 27', () => {
  // 失败条件：注释仍写 26（陈述值与实测不符）/ 无 27 表述 / 实测条目数与 27 不符。
  const src = readRel(SCRIPT_REL);
  assert.ok((src.match(/放宽得 27 条/g) ?? []).length >= 1, '须出现「放宽得 27 条」≥1');
  assert.equal((src.match(/放宽得 26 条/g) ?? []).length, 0, '旧「放宽得 26 条」须 = 0');
  const r = runScriptJson(['--no-live']);
  assert.ok(r.doc, 'no JSON：' + r.stderr.slice(0, 300));
  assert.equal(r.doc.inlineEntries, 27, '实测 inlineEntries 须 = 27');
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-10 R-11 悬空引用清理（命中 = 0，或逐处登记）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack1-10 R-11：`§0f/§0g/§0h` 悬空引用 = 0，或每处均在 exec/e1-disc.md 逐条登记', () => {
  // 失败条件：仍有悬空引用且报告未逐处登记（「部分登记」= 按 AC 判红）——
  //           指到不存在的节会让读者/审计找不到定义面，比悬空更糟的是「改指了别的现役小节」。
  const body = readRel(DISCIPLINE_REL);
  const hits = [...body.matchAll(/§0([fgh])\b/g)].map((m) => '§0' + m[1]);
  if (hits.length === 0) return;
  const reportPath = path.join(BATCH_ARTIFACTS, 'exec', 'e1-disc.md');
  assert.ok(fs.existsSync(reportPath),
    `仍有 ${hits.length} 处 §0f/g/h 引用（${JSON.stringify(hits)}），但报告 ${reportPath} 不存在 ⇒ 无法核「逐处登记」`);
  const report = fs.readFileSync(reportPath, 'utf8');
  const perToken = (t) => (report.match(new RegExp(t + '(?![0-9a-z])', 'g')) ?? []).length;
  for (const t of new Set(hits)) {
    const need = hits.filter((x) => x === t).length;
    const got = perToken(t);
    assert.ok(got >= need, `${t} 正文命中 ${need} 处，报告仅登记 ${got} 处（禁「部分登记」）`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-11 单文件测试（coder 侧用例：只读路径，不跑 npm test）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack1-11 coder 用例 `node --test test/guidance-id-coverage.test.js` 全绿且用例数 ≥ 3', () => {
  // 失败条件：用例文件缺失（负例未交付）/ 有用例失败（判据侧回归）/ 用例数 < 3（覆盖不足）。
  assert.ok(fs.existsSync(absOf(CODER_TEST_REL)), '缺 ' + CODER_TEST_REL);
  const r = spawnSync(process.execPath, ['--test', CODER_TEST_REL], { cwd: PKG_ROOT, encoding: 'utf8', env: childEnv() });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const num = (label) => {
    const m = new RegExp('(?:ℹ|#)\\s*' + label + '\\s+(\\d+)').exec(out);
    return m ? Number(m[1]) : null;
  };
  const tests = num('tests');
  const fails = num('fail');
  assert.equal(r.status, 0, '单文件测试须 exit 0；尾部输出：' + out.slice(-1200));
  assert.ok(tests !== null && tests >= 3, `用例数须 ≥ 3，实测 ${tests}`);
  assert.equal(fails, 0, `fail 须 = 0，实测 ${fails}`);
  // 用例文件须自带「必失败构造」（Q-A）——判据有牙的最小证据
  assert.ok(readRel(CODER_TEST_REL).includes('forward-id'),
    'coder 用例须至少断言 forward-id（否则负例未覆盖新判据）');
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-12 五件注入面 repo↔live 同 sha256（引擎真不变量）＋ 禁区黑名单（提交面口径）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack1-12 注入面 repo↔live 逐件同 sha256；baselines/docs/reports 零提交（禁区黑名单）', (t) => {
  // 失败条件：
  //   ① 任一注入面文件 repo 侧与 live 副本 sha256 不同（改了 repo 未同步 live，或反之）；
  //   ② 提交面（`git diff --name-only <窗口基线>...HEAD`）出现禁区命中（W8：`baselines/**` 单写者 = Leader）；
  //   ③ 引擎既无 `sync` 行又不声明 live 缺位 ⇒ 判据⑦ 静默失效（如实判红，不是 skip）。
  //
  // 【AD-02（本批替换）】原断言 = `git hash-object` vs `git rev-parse bfb9b0c:<path>` 的两件 blob 比对，
  //   判据对象是「2026-10-24 那个 commit 的字节」⇒ 被 `0419b22` **合法**改动后**永久必红**
  //   （实测 actual `43af080d…` vs expected `b4ee3f32…`）。引擎真不变量在
  //   `scripts/check-guidance-sync.mjs:337-345`：对**当前两份副本**逐件求 sha256 比对，与历史 commit 无关；
  //   有牙实证：只改 live 侧 `references/manager.md` 一行 ⇒ `DIFF` + `FAIL sync` + exit 1。
  //   **禁**「把 BASELINE 换成一个更新的 sha 救绿」= 削判据（规格 C-1② 明令）。
  const r = runScriptJson([]); // 含 live（不带 --no-live）
  assert.ok(r.doc, 'no JSON 输出，脚本可能崩了：stderr=' + r.stderr.slice(0, 400));
  const rows = r.doc.sync ?? [];
  if (rows.length === 0) {
    // 引擎自陈降级（`:334-335` live preset 不存在 ⇒ note、不判红）⇒ 该面未执行，**skip 并留痕**；
    //   但「既无行、又无声明」= 判据静默失效，必须红（不得一并跳过）。
    const note = (r.doc.notes ?? []).find((n) => n.includes('live preset 不存在'));
    if (note) return t.skip(`live preset 未部署（引擎自陈：${note}）—— 判据⑦ 需 live 副本在位；部署后复跑`);
    assert.fail('引擎未产出任何 sync 行，也未声明 live preset 缺位（判据⑦ 静默失效）：notes=' + JSON.stringify(r.doc.notes));
  }
  const diverged = rows.filter((x) => !x.same).map((x) => `${x.file} repo=${x.repo} live=${x.live}`);
  assert.deepEqual(diverged, [], '注入面 repo↔live 必须逐件同 sha256（改一份即改另一件）：' + JSON.stringify(diverged));
  const syncFail = (r.doc.failures ?? []).filter((f) => f.check === 'sync');
  assert.deepEqual(syncFail, [], '判据① 失败项须 = 0（缺副本与不一致都落这里）：' + JSON.stringify(syncFail));

  // 【AD-11（本批替换）】原 `PACK_DOMAINS` 冻结 `punky-iter-a-20261024` 那五个**历史批名**的写域，
  //   任何后续合法改动都「不可归属」⇒ 本 lane 自己的修复文件全部不可归属（修了就红 = 自伤）。
  //   换成本批裁定的 ② 口径的**工作树半段**：只判「禁区黑名单是否被未提交变更动过」，
  //   **不判**通用写域归属（工作树脏项不判红）。
  //   **禁**「扩写写域表把本批路径塞进去」= 削判据（规格需求 8 乙类）。
  //
  //   ⚠ **②的「提交面为主」半段实测不可用（本 lane 弃用，须 Leader 复核）**：`baselines/**` 是
  //   **Leader 每批重冻面**，实测 `git log --oneline bfb9b0c..HEAD -- baselines/` ⇒ `0419b22`
  //   （本批起点 HEAD，合法引擎修复提交）已重冻 `baselines/test-baseline.json`。
  //   任何「自某历史 base 起禁区内零提交」的提交面断言 ⇒ 下一次合法重冻即**永久必红**，
  //   与本批要修的 C-1②（历史状态冻结）同病。工作树面则常驻可判：合法重冻必以**提交**形态落盘，
  //   不进工作树面 ⇒ 该判据不会因流程内动作变红。
  const forbiddenDirty = porcelainPaths().filter((p) => FORBIDDEN_ZONES.some((re) => re.test(p)));
  assert.deepEqual(forbiddenDirty, [], '禁区（baselines/docs/reports）不得出现未提交变更（W8：基线单写者 = Leader）：'
    + JSON.stringify(forbiddenDirty));
});
