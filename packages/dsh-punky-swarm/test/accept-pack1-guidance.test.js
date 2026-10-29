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
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PKG_ROOT, '..', '..');
const BASELINE = 'bfb9b0c';
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

// 【G04③ 死码已删（批 `punky-g1-gapfix-2026-10-29` · lane `t1-verify`）】
//   原「已退役脚本的路径常量」与两个为 spawn 它而写的包装函数（一为直接 spawn、一为 JSON 版）整链删除：
//   两个包装函数在本文件**均无调用点**（实测 grep 仅命中定义与彼此调用）⇒ 路径常量随之无活引用。
//   删的是死链，**不动任何活断言**（C-6）。G04② 历史注释保留（见下方一行），标「已废」。

/** 与实现同源的注入面条目解析（`scripts/check-guidance-sync.mjs#inlineEntriesOf`，缩进 ≥6）。（已废：该脚本已退役，本行仅存历史） */
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

// 【G04③ 死码已删】原「负例临时根夹具」整函数删除：
//   该夹具在本文件**无任何调用点**（实测 grep 仅命中定义），其体内复制已退役脚本的一行是死引用 ⇒ 随链删除。
//   `TMP` / `test.after` 保留（活钩子，不属本类）。

// ═══════════════════════════════════════════════════════════════════════════════
// AC-2 三新节在场且标题以 `## §` 起（唯一性用守恒式，不断条数）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack1-2 三新节 §0i/§0s/§0t 在场且小节标题 id 不重复', () => {
  // 失败条件：任一新节缺失、重复，或写成 `### §0i` / `**§0i**` 等非 `## ` 形态
  //           （标题形态变了，判据 ②/③/②b 的解析器都读不到 ⇒ 静默失效）。
  // 判据形态：存在性（缺哪节点名哪节）＋ 守恒式（id 无重复）——不锚定条数。
  const body = readRel(DISCIPLINE_REL);
  const ids = (body.match(/^## §[0-9]{1,2}[a-z]?/gm) ?? []).map((h) => h.slice(4).trim());
  const missing = ['0i', '0s', '0t'].filter((id) => !ids.includes(id));
  assert.deepEqual(missing, [], '三新节须各以 `## §<id> ` 形态在场，缺：' + JSON.stringify(missing));
  assert.deepEqual(ids, [...new Set(ids)], '小节标题 id 不得重复（重复会让解析器只读第一个 ⇒ 静默失效）');
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-6 注意事项面不复制操作原文（Q-B）：最长公共窗口 = 0 且每节 ≥ 120 字
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack1-6 注入面条目与对应正文小节：24 字窗命中 = 0，且每节正文 ≥ 120 字', () => {
  // 失败条件：任一节出现 ≥24 字的连续公共串（= 把操作面整句抄进正文，Q-B 硬阈值被破），
  //           或任一节正文 < 120 字（= 用一行抄过去再改名绕过阈值）。
  // 已解绑 §0t：其「何时必须做」于 2026-10-28 迁入 `member_settle` 工具定义（Q-3），
  //   注入面不再有条目 ⇒ 只核仍留在注入面的两节（§0i / §0s）。
  const body = readRel(DISCIPLINE_REL);
  const entries = new Map(inlineEntriesOf(readRel(GUIDANCE_REL)).map((e) => [e.id, e.text]));
  const report = [];
  for (const id of ['0i', '0s']) {
    const sec = sectionOf(body, id);
    assert.ok(sec, `§${id} 小节缺失（无法核 AC-6）`);
    const entryText = entries.get(id);
    assert.ok(entryText, `注入面缺条目 ${id}（无法核 AC-6）`);
    const hits = windowHits(sec.body, entryText, 24);
    const len = [...normWs(sec.body)].length;
    report.push(`§${id}: 正文长度=${len}｜24 字窗命中=${hits.length}${hits.length ? ' → ' + JSON.stringify(hits.slice(0, 3)) : ''}`);
    assert.deepEqual(hits, [], `§${id} 与注入面条目存在 ≥24 字连续公共串（Q-B 阈值被破）：${JSON.stringify(hits.slice(0, 3))}`);
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
// AC-12 禁区黑名单（W8：baselines/docs/reports 单写者 = Leader）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack1-12 禁区（baselines/docs/reports）不得出现未提交变更', () => {
  // 已解绑：原「五件 repo↔live 同 sha256」由校验器承载；该校验器于 2026-10-28 退役（用户裁决：
  //   指引维护不常做、不需要绑测试锚定），该面改由 `scripts/sync-guidance.mjs` 的复制动作承担（无判定结论）。
  //   保留的是**常驻不变量**：禁区目录不得出现在未提交变更里（W8：基线单写者 = Leader）。

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
