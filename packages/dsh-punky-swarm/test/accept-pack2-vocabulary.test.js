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

// test/accept-pack2-vocabulary.test.js —— 批 `punky-iter-a-20261024` · **pack2 验收套件**（lane `t1-tests`）
// ─────────────────────────────────────────────────────────────────────────────
// 判据来源 = `plan/p2-taskpack-2.md` 的 `## 验收标准`（AC-1..AC-12），逐条一对一编号 `AC-pack2-N`。
//
// 只读纪律：
//   · 本件**不改**任何仓内文件；夹具（词表 / 团队资产 / 产物）一律落 `os.tmpdir()`。
//   · **禁跑** `npm run build` / `npm test`（build 窗口归 pack2 coder；tester 只在单文件粒度跑 `node --test`）
//     —— 但**读** build 产物（`lib/types/contracts.d.ts`）是本件判据的一部分（AC-10）。
//   · 执行方式：`node --test test/accept-pack2-vocabulary.test.js`
//
// 独立计算原则（对齐 `scripts/evidence-guard.mjs:44`「禁写期望值」）：
//   AC-3/AC-4/AC-10 的集合**本件自行运行期计算**（不读 `check-vocab-counts.mjs` 的自报结论），
//   以免「脚本自证自己」。两侧口径与 pack2 K-4 职责 1 同源：`code: 'GATE_…'` 字面量 ∪ `throw new Error('GATE_…` 字面量。
//
// 四态纪律：每条用例正文首行写明**失败条件**；`AC-pack2-1` 的「改前 RED」是时点读数（本件只能断言其机制在场），
//   真实读数由 exec 报告原样贴出。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createGates } from '../lib/state/gates.js';
import {
  VOCABULARY_REL, loadVocabulary, gateCodeKnown, reasonTokenKnown,
} from '../lib/state/vocabulary.js';
import { writeSyntheticTeam } from './helpers/team-fixture.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PKG_ROOT, '..', '..');
// 【本批删除】原 `const BASELINE = 'bfb9b0c';` —— 全文件**零引用**（`grep -c BASELINE` = 1，即定义行本身），
//   属死常量；且它误导读者以为本件「锚历史基线字节」（本件的窗口判据在 `AC-pack2-12`，与 bfb9b0c 无关）。
//   删除性检验：零引用 ⇒ 不承载任何判据；删后本件 12/12 仍绿（见 progress/02）。
const VOCAB_JSON_REL = 'lib/state/vocabulary.json';
// 【TR1 出清后删除】原 `const VOCAB_JS_REL = 'lib/state/vocabulary.js';` —— AC-8 改为行为面后**零引用**
//   （读源码文本的路径已不再需要）；留着会误导读者以为本件仍在数注释字面。删后本件 12/12 仍绿。
const CONTRACTS_TS_REL = 'lib/types/contracts.ts';
const CONTRACTS_DTS_REL = 'lib/types/contracts.d.ts';
const CONTRACTS_JS_REL = 'lib/types/contracts.js';
const SCRIPT_REL = 'scripts/check-vocab-counts.mjs';
const BATCH_ARTIFACTS = process.env.PUNKY_BATCH_ARTIFACTS
  ?? path.join('C:\\', 'Users', 'Administrator', '.dsh', 'punky-preset', 'sessions',
    'aa_8dbc24d193cde729_sess_Io1QHlQjQQDFxw', 'artifacts', 'punky-iter-a-20261024');

const TMP = [];
test.after(() => { for (const d of TMP) fs.rmSync(d, { recursive: true, force: true }); });
const mkTmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP.push(d); return d; };

const absOf = (rel) => path.join(PKG_ROOT, ...rel.split('/'));
const readRel = (rel) => fs.readFileSync(absOf(rel), 'utf8');
const existsRel = (rel) => fs.existsSync(absOf(rel));

/** K-1 的 12 码（`plan/p2-taskpack-2.md` 原文逐字）。 */
const K1_CODES = [
  'GATE_COMPLETE_NO_TIER', 'GATE_EXIT_NO_DECLARATION',
  'GATE_LANE_LAYER_MISSING', 'GATE_LANE_NOT_IN_PLAN',
  'GATE_NO_DECLARATION', 'GATE_ORPHAN_PRODUCT',
  'GATE_PAIRING_CARDINALITY_DRIFT', 'GATE_PLAN_NO_DECLARATION',
  'GATE_ROLE_ASSEMBLY_MISSING', 'GATE_ROLE_INVALID',
  'GATE_ROLE_MANAGER_AS_LANE', 'GATE_STANDALONE_UNJUSTIFIED',
];

/** p1 §2.4「仅标识符（非码）」30 项（逐字抄自 `plan/p1-recon.md` §2.4 该行）。 */
const IDENTIFIER_ONLY = [
  'GATE_ASSEMBLY_', 'GATE_AUDIT_CONTRACT_', 'GATE_CLASS', 'GATE_COMPLETE_', 'GATE_COMPLETE_BLOCKED',
  'GATE_CONCURRENCY_BLOCKED', 'GATE_CONTRACT_MISSING', 'GATE_DEGRADE', 'GATE_DIFFICULTY_',
  'GATE_DISPATCH_', 'GATE_ESCAPE', 'GATE_EXIT_BLOCKED',
  'GATE_MANAGER_', 'GATE_MANAGER_NOT_RAISED', 'GATE_MANAGER_ROSTER_GAP', 'GATE_NEEDHUMAN_BLOCKED',
  'GATE_R', 'GATE_RO', 'GATE_ROLE_', 'GATE_ROW_HEADROOM', 'GATE_SCRIPT_SHA_RE', 'GATE_SIG_',
  'GATE_SIG_DUPLICATE', 'GATE_TARGET_BLOCKED', 'GATE_TARGET_PASSED', 'GATE_TEAMS_ROOT_',
  'GATE_TEAM_ASSET_', 'GATE_X_RE', 'GATE_X_Y',
];

// ── 独立解析：union / 发射码 / 词表 / 退役锁 ────────────────────────────────

/** `GateErrorCode` union 成员（止于终结该 type 别名的 `;` 行）。 */
function unionMembers() {
  const ts = readRel(CONTRACTS_TS_REL);
  const start = ts.indexOf('export type GateErrorCode =');
  assert.ok(start >= 0, 'contracts.ts 内找不到 `export type GateErrorCode =`');
  const body = [];
  for (const line of ts.slice(start).split(/\r?\n/)) {
    body.push(line);
    if (/;\s*$/.test(line)) break;
  }
  return new Set([...body.join('\n').matchAll(/['"](GATE_[A-Z0-9_]+)['"]/g)].map((m) => m[1]));
}

/** 发射码集（`code:` 字面量 ∪ throw 字面量），递归扫 `lib/` 下的 `.ts`（排 `.d.ts`）。 */
function emittedCodes() {
  const set = new Set();
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', '.tsbuild', 'out'].includes(d.name)) continue;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { walk(p); continue; }
      if (!d.name.endsWith('.ts') || d.name.endsWith('.d.ts')) continue;
      const text = fs.readFileSync(p, 'utf8');
      for (const m of text.matchAll(/code:\s*['"](GATE_[A-Z0-9_]+)['"]/g)) set.add(m[1]);
      for (const m of text.matchAll(/throw new Error\(\s*['"](GATE_[A-Z0-9_]+)/g)) set.add(m[1]);
    }
  };
  walk(path.join(PKG_ROOT, 'lib'));
  return set;
}

function vocabEntries() {
  return JSON.parse(readRel(VOCAB_JSON_REL)).entries ?? [];
}
const vocabCodes = (kind) => new Set(vocabEntries().filter((e) => !kind || e.kind === kind).map((e) => e.code));

/** 退役锁的 31 码（从用例文件 `const RETIRED_CODES = [ … ];` 原文提取；本件只读它、不改它）。 */
function retiredCodes() {
  const text = readRel('test/retired-codes-lock.test.js');
  const start = text.indexOf('const RETIRED_CODES = [');
  assert.ok(start >= 0, 'retired-codes-lock 内找不到 RETIRED_CODES');
  const end = text.indexOf('];', start);
  assert.ok(end > start, 'RETIRED_CODES 数组未闭合');
  return new Set([...text.slice(start, end).matchAll(/['"]([A-Z][A-Z0-9_]*)['"]/g)].map((m) => m[1]));
}

/** 子进程 env：剥掉「本进程作为 `--test` 子上下文」时注入的变量，
 *  否则被 spawn 的 `node --test` 会改走 TAP 通道 ⇒ `ℹ tests/pass/fail` 摘要行读不到（实测踩过）。 */
function childEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST_')) delete env[k];
  return env;
}

function runNodeTest(files) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: PKG_ROOT, encoding: 'utf8', env: childEnv() });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const num = (label) => {
    const m = new RegExp('^\\s*(?:ℹ|#)\\s*' + label + '\\s+(\\d+)\\s*$', 'm').exec(out);
    return m ? Number(m[1]) : null;
  };
  return { status: r.status, out, tests: num('tests'), pass: num('pass'), fail: num('fail') };
}

// ── 夹具：临时包根（flows 声明根 + 词表根 = `createGates` 的两个 DI 缝）──────────

function mkPkg() {
  const p = mkTmp('accept-p2-pkg-');
  fs.mkdirSync(path.join(p, 'presets'), { recursive: true });
  return p;
}

const SESS = 'sess-accept-p2';
const TEAM = 'accept-p2-team';

function writeTeam(pkg) {
  return writeSyntheticTeam(pkg, TEAM, {
    team: TEAM,
    layers: { plan: { roles: ['designer'], skills: { designer: ['dev-designer'] } } },
    flows: {
      plan: {
        produce_field: 'produce',
        entry_requires: [],
        contract: {
          artifact_globs: ['plan/*spec.md'],
          required_sections: ['## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准', '## 约束'],
        },
      },
      exec: { produce_field: 'outputs', entry_requires: ['consume'] },
      audit: {
        produce_field: 'produce',
        entry_requires: ['consume'],
        audit_contract: { criteria_from: 'plan/**', consumes_required: ['plan/', 'exec/'], verdict: ['pass', 'skip'] },
      },
    },
  }, { filename: 'team-asset.yml' });
}

function seedVocab(pkg, entries) {
  const abs = path.join(pkg, ...VOCABULARY_REL.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify({
    $schema: 'dsh-punky-swarm/vocabulary@1',
    meta: { version: 1, updated: '2026-10-24', counts: { gateCodes: 0, reasonTokens: 0 } },
    // `sources` 是 schema 必检面（`checkSources`：id/path/line/note 四项齐、path 须在**真包根**在场）
    sources: [{ id: 'gate-entry', path: 'lib/state/gates.ts', line: 1, note: 'GATE_* 拒码面（Entry 门）' }],
    entries,
  }, null, 2), 'utf8');
  return abs;
}

function writeArt(state, batchId, rel, content) {
  const abs = path.join(state, 'sessions', SESS, 'artifacts', batchId, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

const batchOf = (tasks) => ({
  batchId: 'b1', team: TEAM, createdAt: '2026-10-24T00:00:00.000Z', lanes: {}, events: [], wavePlan: [{ wave: 1, tasks }],
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-1 机检脚本在场且两条职责齐备（「改前 RED」为时点读数，见报告）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack2-1 `check-vocab-counts.mjs` 在场，两条职责（发射码扫描 ＋ 标识符排除）齐备', () => {
  // 失败条件：脚本缺失（K-4 未交付）/ 只扫一条发射面（漏 throw 形态 ⇒ R-15 的「混用扫描面」陷阱）/
  //           未排除 `.d.ts`（注释污染集合 ⇒ 缺口恒非零的假红）。
  assert.ok(existsRel(SCRIPT_REL), '缺 ' + SCRIPT_REL);
  const src = readRel(SCRIPT_REL);
  assert.ok(/code:/.test(src), '职责 1 须扫 `code:` 字面量发射面');
  assert.ok(/throw new Error/.test(src), '职责 1 须同时扫 `throw new Error(` 发射面（R-15：两口都扫且明写口径）');
  assert.ok(/\.d\.ts/.test(src), '扫描面须显式排除 `*.d.ts`（否则注释会污染集合）');
  assert.ok(/node_modules/.test(src), '扫描面须显式排除 `node_modules`');
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-2 发射码 ⊆ 词表（改后）：脚本 exit 0 ＋ 本件独立复算缺口 = 0
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack2-2 `node scripts/check-vocab-counts.mjs` exit 0；独立复算「发射码 ∖ 词表」= ∅', () => {
  // 失败条件：脚本 exit≠0（机检自报缺口）/ 独立复算仍有缺口码（= 底料漏登记，转拦截后会批量误拒 R-01）。
  const r = spawnSync(process.execPath, [SCRIPT_REL], { cwd: PKG_ROOT, encoding: 'utf8' });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  assert.equal(r.status, 0, '脚本须 exit 0；原始输出尾部：\n' + out.slice(-1500));
  const emit = emittedCodes();
  const vocab = vocabCodes('gate');
  const gap = [...emit].filter((c) => !vocab.has(c)).sort();
  assert.deepEqual(gap, [], `发射码未入词表（缺口须 = 0）：${JSON.stringify(gap)}`);
  assert.ok(emit.size > 0, '发射码集不得为空（扫描面写错会静默通过 ⇒ 假绿）');
  process.stdout.write(`[AC-pack2-2] 发射码=${emit.size}｜词表 gate=${vocab.size}｜缺口=${gap.length}\n`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-3 底料 = union 成员（**双向**）＋ 12 码在 union 内
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack2-3 双向：词表 gate ⊇ union 且 union ⊇ 词表 gate；K-1 的 12 码逐码在 union 内', () => {
  // 失败条件：单向只证一半 ——
  //   ① 词表缺 union 成员 ⇒ 「合法码被拒」误伤；② 词表多出 union 外的码 ⇒ 给非码开白（R-02 同源风险）；
  //   ③ K-1 的 12 码有任一未进 union ⇒ 底料来源（union 单一源）本身漏码，AC-2 的 GREEN 就是假绿。
  const union = unionMembers();
  const gate = vocabCodes('gate');
  const missing = [...union].filter((c) => !gate.has(c)).sort();
  const extra = [...gate].filter((c) => !union.has(c)).sort();
  assert.deepEqual(missing, [], `union ⊄ 词表：缺 ${JSON.stringify(missing)}`);
  assert.deepEqual(extra, [], `词表 ⊄ union：多 ${JSON.stringify(extra)}`);
  const notInUnion = K1_CODES.filter((c) => !union.has(c));
  assert.deepEqual(notInUnion, [], `K-1 的 12 码须全部进 ` + '`GateErrorCode` union，缺 ' + JSON.stringify(notInUnion));
  process.stdout.write(`[AC-pack2-3] union=${union.size}｜词表 gate=${gate.size}｜缺=${missing.length}｜多=${extra.length}\n`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-4 底料不含标识符（R-02）：与「仅标识符」清单交集 = 0（清单自检改为三条不依赖总数的不变量）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack2-4 词表 code 集 ∩「仅标识符」清单 = ∅（清单自检：无重复 / 形态合法 / 判别力 / 下界棘轮 ≥ 30）', () => {
  // 失败条件：任一把标识符/正则名/前缀灌进词表（= 给非码开白，R-02）。
  //   注：本断言在「空词表」时**天然为真**（惰性通过）——空表的非空性由 AC-pack2-3 承担，二者必须同绿。
  const codes = vocabCodes();
  // 交集判定抽成**可喂入任意集合**的函数：既用于真词表，也用于下面的鉴别力自证。
  const intersect = (set) => IDENTIFIER_ONLY.filter((id) => set.has(id)).sort();
  const hit = intersect(codes);
  assert.deepEqual(hit, [], `词表含「仅标识符」项（禁）：${JSON.stringify(hit)}`);

  // ── 清单自检：原写法是 `IDENTIFIER_ONLY.length === 30`（规模精确等值 —— 它同时咬「少抄」与「合法补项」两件事）。 ──
  //    现改为「三条不变量 ＋ 一条下界棘轮」并存：不变量兜住重复/形态/判别力，棘轮**只**兜「不得静默少抄」。
  // ① 无重复：重复项会让交集检查重复计，掩盖真实覆盖
  const dup = [...new Set(IDENTIFIER_ONLY.filter((id, i, arr) => arr.indexOf(id) !== i))].sort();
  assert.deepEqual(dup, [], `清单不得有重复项：${JSON.stringify(dup)}`);
  // ② 形态合法：拼写噪声会让「不在词表」恒真 ⇒ 假绿
  const malformed = IDENTIFIER_ONLY.filter((id) => !/^GATE_[A-Z0-9_]*$/.test(id));
  assert.deepEqual(malformed, [], `清单每项须为 \`GATE_[A-Z0-9_]*\` 形态：${JSON.stringify(malformed)}`);
  // ③ 判别力自证：把清单首项喂进「伪词表」必须被点名。
  //    ⇒ 若 `intersect` 被改成恒空（判据失效），本条立刻红；也顺带保证清单**非空**。
  assert.deepEqual(intersect(new Set([IDENTIFIER_ONLY[0]])), [IDENTIFIER_ONLY[0]],
    '交集检查须能点名被塞入词表的项（否则 AC-pack2-4 恒绿 = 无鉴别力）');
  // ④ 下界棘轮（单调棘轮）：只锁「不得静默少抄」，允许将来补项。
  //    **下界来源**：本清单在仓内的唯一载体就是本文件（无第二真源可对齐），其建立时的规模为 **30 项**
  //    （逐字转录自 recon §2.4 该行）；**W4 `codename` 有 1 项转正**（`GATE_DIFFICULTY_CHANNEL_UNRESOLVED` 已登记词表 ⇒ 不再是「仅标识符」）⇒ 下界同步 30 → **29**。
  //    语义：`28 >= 29` 为假 ⇒ **删项必红**；`30 >= 29` 为真 ⇒ 合法补项不红（这正是本件要的「只拆咬合法改动的那一半」）。
  assert.ok(IDENTIFIER_ONLY.length >= 29,
    `清单不得少于下界 29 项（现 ${IDENTIFIER_ONLY.length} 项）：本清单是仓内唯一载体，少抄一项会让交集检查静默变弱`);
  process.stdout.write(`[AC-pack2-4] 清单=${IDENTIFIER_ONLY.length}（下界 29）｜词表命中=${JSON.stringify(hit)}\n`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-5 负例：未登记 token **必拒**（Q-D 的核心风险面）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack2-5 负例：未登记 token 必拒 —— 判定单点 ＋ 命令门 C3 端到端，含同输入阳性对照', () => {
  // 失败条件：
  //   ① 未登记 code 被判 known（= 拦截没生效，词表形同虚设）；
  //   ② 已登记 code 亦被判 unknown（= 拦过头，会误拒全部合法产物）；
  //   ③ 产物声明未登记 `reason:` token 时命令门不返回 GATE_TOKEN_UNKNOWN（= 「转拦截」未落到门禁面）。
  const PROBE = 'GATE_ACCEPT_SUITE_UNREGISTERED_PROBE';
  // ① 真仓词表：探测码必未登记
  assert.equal(gateCodeKnown(PROBE).known, false, '未登记 code 不得被判 known：' + PROBE);
  assert.equal(reasonTokenKnown('accept-suite-unregistered-probe').known, false,
    '未登记 reason token 不得被判 known');
  // ② 阳性对照（临时根）：同判据、同形状，只让「是否登记」不同 ⇒ 证明拒绝是**针对性**的
  const okPkg = mkPkg();
  seedVocab(okPkg, [{
    id: 'gate-accept-fixture-ok', code: 'GATE_ACCEPT_FIXTURE_OK', label: '夹具：已登记码',
    kind: 'gate', enabled: true, since: '0.5.3', deprecatedIn: null, replacedBy: null,
  }]);
  assert.equal(gateCodeKnown('GATE_ACCEPT_FIXTURE_OK', { root: okPkg, force: true }).known, true,
    '同夹具下已登记码须被判 known（阳性对照）');
  assert.equal(gateCodeKnown(PROBE, { root: okPkg, force: true }).known, false,
    '同夹具下未登记码仍须被判 unknown（排除「一律 unknown」的假拦截）');
  // ③ 端到端：命令门 C3（产物声明未登记 reason token ⇒ GATE_TOKEN_UNKNOWN）
  const pkg = mkPkg();
  writeTeam(pkg);
  seedVocab(pkg, [{
    id: 'reason-known-fixture', code: 'known_fixture_token', label: '夹具：已登记 reason',
    kind: 'reason', enabled: true, since: '0.5.3', deprecatedIn: null, replacedBy: null,
  }]);
  assert.equal(loadVocabulary({ root: pkg, force: true }).ok, true, '夹具词表须 schema 自洽（否则 C3 走 fail-open，测出假绿）');
  const state = mkTmp('accept-p2-state-');
  const g = createGates(state, { flowsRoot: pkg, vocabularyRoot: pkg });
  writeArt(state, 'b1', 'exec/e1.md', 'out\nreason: never_registered_token\n');
  const b = batchOf([{ id: 'e1', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e1.md'] }]);
  const r = g.checkCommandGate(SESS, 'b1', b, 'e1');
  assert.equal(r.ok, false, '未登记 token 须被拒：' + JSON.stringify(r));
  assert.equal(r.code, 'GATE_TOKEN_UNKNOWN', '拒码须恒为 GATE_TOKEN_UNKNOWN：' + JSON.stringify(r));
  assert.equal(r.token, 'never_registered_token');
  process.stdout.write(`[AC-pack2-5] C3 回显 code=${r.code} token=${r.token} source=${r.source}\n`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-6 正例：存量 token 不被误拒 ＋ 两个词表测试文件全 pass
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack2-6 正例：仓内 `^reason:` 声明 token 全部已登记；两词表测试文件 fail = 0', () => {
  // 失败条件：生产面（非 test/）出现未登记 token（⇒ 上线即误拒）/ 既有词表用例回归。
  const tokens = new Set();
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', '.tsbuild', 'out', 'test'].includes(d.name)) continue;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs|cjs|ts|md|json|yml|yaml)$/.test(d.name)) continue;
      let text = '';
      try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
      for (const m of text.matchAll(/^\s*reason:\s*([A-Za-z0-9_.:-]+)\s*$/gm)) tokens.add(m[1]);
    }
  };
  walk(PKG_ROOT);
  const unknown = [...tokens].filter((t) => !reasonTokenKnown(t).known).sort();
  assert.deepEqual(unknown, [],
    `生产面 ` + '`reason:` 声明了未登记 token（须先登记再落代码）：' + JSON.stringify(unknown));
  process.stdout.write(`[AC-pack2-6] 盘点 reason token=${tokens.size}：${JSON.stringify([...tokens])}\n`);
  const r = runNodeTest(['test/gates-vocabulary-contract.test.js', 'test/vocabulary.test.js']);
  assert.equal(r.status, 0, '两词表测试文件须全 pass；尾部输出：\n' + r.out.slice(-1500));
  assert.equal(r.fail, 0, `fail 须 = 0，实测 ${r.fail}`);
  assert.ok(r.tests !== null && r.tests >= 1, '用例数须可解析且 ≥ 1（防「跑了 0 条也算绿」）');
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-7 与退役锁关系举证（锁 GREEN ＋ 交集可算 ＋ 两枚幽灵码显式归属）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack2-7 退役锁 GREEN；词表∩退役锁可算且逐码有理由；两枚幽灵码各有显式归属', (t) => {
  // 失败条件：锁用例回归（退役码回生）/ 交集非空却无理由（两本账）/ 幽灵码被悄悄漏掉（R-09、R-14 要求「禁悄悄漏掉」）。
  const r = runNodeTest(['test/retired-codes-lock.test.js']);
  assert.equal(r.status, 0, '退役锁须仍 GREEN；尾部输出：\n' + r.out.slice(-800));
  const retired = retiredCodes();
  const codes = vocabCodes();
  const inter = [...codes].filter((c) => retired.has(c)).sort();
  const reportPath = path.join(BATCH_ARTIFACTS, 'exec', 'e2-vocab.md');
  const reportOnDisk = fs.existsSync(reportPath);
  // 【2026-10-25 CI 修复】批次产物是**会话态**（`PUNKY_BATCH_ARTIFACTS`，默认指向某个本机 session 目录），
  //   干净检出 / CI runner 上不存在。原写法把「报告不在场」直接判红 ⇒ CI 必红（Linux CI 实测红）。
  //   正确处置：报告不在场 = 该环境**不可核**（不是不合格）⇒ 逐项留痕 + 只退掉「报告内容」类断言，
  //   结构性断言（退役锁 GREEN、交集可算、幽灵码登记态）照常执行，不静默丢失守卫面。
  if (!reportOnDisk) {
    t.diagnostic('批次产物不在场（' + BATCH_ARTIFACTS + '）⇒ 「报告内逐码理由 / 幽灵码书面说明」类断言本环境不可核；'
      + '结构性断言（锁 GREEN / 交集可算 / 登记态）仍已执行。用 PUNKY_BATCH_ARTIFACTS 指向该批产物可补核。');
  }
  if (inter.length > 0 && reportOnDisk) {
    const report = fs.readFileSync(reportPath, 'utf8');
    for (const c of inter) {
      assert.ok(report.includes(c), `交集码 ${c} 未在报告内逐码说明（禁口头说明）`);
    }
  } else if (inter.length > 0) {
    t.diagnostic('交集非空 ' + JSON.stringify(inter) + '，但报告不在场 ⇒ 逐码理由未核（不计通过，亦不判红）。');
  }
  // 两枚幽灵/不可达码：登记（enabled:false ＋ deprecatedIn ＋ note）或明确不登记并给理由
  const report = reportOnDisk ? fs.readFileSync(reportPath, 'utf8') : '';
  for (const ghost of ['GATE_MANAGER_NOT_RAISED', 'GATE_EXIT_MISSING_PLAN']) {
    const entry = vocabEntries().find((e) => e.code === ghost) ?? null;
    const registered = entry !== null && entry.enabled === false
      && typeof entry.deprecatedIn === 'string' && entry.deprecatedIn.length > 0
      && typeof entry.note === 'string' && entry.note.trim().length > 0;
    const documented = report.includes(ghost);
    if (!reportOnDisk && !registered) {
      t.diagnostic(ghost + ' 既未登记、报告又不在场 ⇒ 归属本环境不可核（不计通过）。');
      continue;
    }
    assert.ok(registered || documented,
      `${ghost} 须有显式归属：登记为 enabled:false＋deprecatedIn＋note，或在 exec/e2-vocab.md 明确说明不登记的理由`);
  }
  process.stdout.write(`[AC-pack2-7] 退役锁=${retired.size} 码｜词表∩退役锁=${inter.length}：${JSON.stringify(inter)}｜报告在场=${reportOnDisk}\n`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-8 `vocabulary.js` 注释订正（R-03：空表 ⇒ 全拒，非放行）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack2-8 空表语义（**行为面**）：真仓词表 known:true ／ 空表副本 known:false（空表不是放行）', () => {
  // 【TR1 出清 · 2026-11-01】原断言读的是**注释文本**（`src.match(/空表/)` ≥1、旧表述 = 0）。
  //   变异实测（副本 + 读路径重定向；真仓 lib 零改动）：
  //     · 改实现「空表 ⇒ 全放行」而注释一字不动 ⇒ 旧断言**仍绿**（J-1：不保护行为）
  //     · 只改注释措辞、实现不动 ⇒ 旧断言**变红**（J-2：实际在测文本）
  //   ⇒ 改为钉**实际判定结果**（两态）：真仓词表 ⇒ known:true；同 schema/meta/sources 的空表副本 ⇒ known:false。
  const realDoc = JSON.parse(readRel(VOCABULARY_REL));
  const sample = realDoc.entries.find((e) => e.kind === 'gate' && typeof e.code === 'string');
  assert.ok(sample, '前置：真仓词表须含至少一条 gate 词条（否则本判据无样例可取）');

  // 态① 真仓词表：该码已登记 ⇒ known:true（放行档；防「恒拒」把本判据变恒真）
  assert.equal(gateCodeKnown(sample.code).known, true,
    '真仓词表下 ' + sample.code + ' 必须 known:true（对照态）');

  // 态② 空表副本（**保留 schema/meta/sources，仅 entries: []**）⇒ known:false（全拒档）
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-tr1-empty-'));
  const abs = path.join(root, VOCABULARY_REL);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify({ ...realDoc, entries: [] }));
  const load = loadVocabulary({ root, force: true });
  assert.equal(load.ok, true,
    '空表本身必须**合法**（否则测到的是「词表不可用 ⇒ fail-open」那档，两档会互读）；problems='
    + JSON.stringify(load.problems ?? []));
  assert.equal(gateCodeKnown(sample.code, { root, force: true }).known, false,
    '**空表 ⇒ 全拒**：空表不是放行（若实现把空表当放行 ⇒ 本断言必红）');
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-9 `meta.counts` 未被升为判据（K-6 硬）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack2-9 机检脚本对 `counts` 零判定性引用；test/ 内无「counts vs 数值」真值比对', () => {
  // 失败条件：新脚本拿 counts 当真值判据（⇒ 邻居 lane 合法增条目即误红，造出必假红的第二真源）。
  //   口径（判据对象 = **判定性引用**，不是「出现过 counts」）：`counts`（可带 `.key`）紧邻比较符
  //   且右侧是**字面数值** ⇒ 命中；`[vocab-counts] GAP ${c} <= …` 这类**日志文本**不算（打印/形状读允许）。
  const src = readRel(SCRIPT_REL);
  const scriptCmp = src.match(/counts(?:\.\w+)?\s*(?:===|!==|==|!=|>=|<=|>|<)\s*\d/g) ?? [];
  assert.deepEqual(scriptCmp, [], '脚本内对 counts 的判定性引用须 = 0：' + JSON.stringify(scriptCmp));
  const bad = [];
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { walk(p); continue; }
      if (!d.name.endsWith('.test.js') && !d.name.endsWith('.mjs')) continue;
      const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (!/counts/.test(line)) return;
        if (/\bcounts(?:\.\w+)?\s*(?:===|!==|==|!=)\s*\d/.test(line) || /\d\s*(?:===|!==|==|!=)\s*[^\n]{0,20}\bcounts\b/.test(line)) {
          bad.push(`${path.relative(PKG_ROOT, p)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  };
  walk(path.join(PKG_ROOT, 'test'));
  assert.deepEqual(bad, [], 'test/ 内出现 counts 与字面数值的真值比对（禁）：' + JSON.stringify(bad));
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-10 build 产物归属（生成物同批，禁只改源）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack2-10 `contracts.d.ts` 已重生成并含 K-1 的 12 码；`contracts.js` 内零 `GATE_` 字面量（无手改）', () => {
  // 失败条件：`.d.ts` 未重生成（类型面仍读旧产物 ⇒ 消费方 TS 编译看不见新码）/
  //           `.js` 里凭空出现 `GATE_` 字面量（= 有人手改了 tsc 产物，K-7 禁）。
  //   口径说明（防空断言）：`GateErrorCode` 是**纯类型别名**，tsc 会把它整段擦除 ⇒ `contracts.js`
  //     本就不含 `GATE_` 字面量（实测 0 处）。因此 `.js` 侧的正确判据不是「含 12 码」，而是「仍为 0」。
  assert.ok(existsRel(CONTRACTS_DTS_REL), `缺生成物 ${CONTRACTS_DTS_REL}（须由 pack2 的 build 窗口产出）`);
  const dts = readRel(CONTRACTS_DTS_REL);
  const miss = K1_CODES.filter((c) => !dts.includes(c));
  assert.deepEqual(miss, [], `contracts.d.ts 缺 K-1 的码（禁只改 .ts 不重生成）：${JSON.stringify(miss)}`);
  assert.ok(existsRel(CONTRACTS_JS_REL), `缺生成物 ${CONTRACTS_JS_REL}`);
  const jsGates = [...new Set([...readRel(CONTRACTS_JS_REL).matchAll(/GATE_[A-Z0-9_]+/g)].map((m) => m[0]))];
  assert.deepEqual(jsGates, [], 'contracts.js 内不得出现 GATE_ 字面量（出现即疑似手改 tsc 产物）：' + JSON.stringify(jsGates));
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-11 面不变式（防误伤）：三件词表/契约用例全 pass
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack2-11 `retired-codes-lock` ＋ `gates-vocabulary-contract` ＋ `vocabulary` 三件 fail = 0', () => {
  // 失败条件：填表/补码后既有词表面回归（= 转拦截把存量误拒，Q-D 的最高风险）。
  const r = runNodeTest([
    'test/retired-codes-lock.test.js',
    'test/gates-vocabulary-contract.test.js',
    'test/vocabulary.test.js',
  ]);
  assert.equal(r.status, 0, '三件须全 pass；尾部输出：\n' + r.out.slice(-2000));
  assert.equal(r.fail, 0, `fail 须 = 0，实测 ${r.fail}`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-12 越界检查（无条件不变的禁区 ＋ porcelain 可归属）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack2-12 `baselines/ docs/ reports/` 零变更；porcelain 每行可归属声明写域', () => {
  // 失败条件：写了基线/文档/报告（W8：基线单写者 = Leader；docs/reports 本批只读）/
  //           出现无法归属声明写域的脏项（越界，须 Leader 裁）。
  //   注：`presets/**` `skills/**` `package.json` 等**同批他包**会合法变更 ⇒ 本件不用它们判 pack2 越界，
  //   改用「联合写域可归属」＋「四包都不碰的绝对禁区」，以免并行窗口假红。
  // 目录约定分类器（R-27 根治，取代原 `PACK_DOMAINS` 批次清单）
  // 判据面 = 「脏项是否落在某个**已知面**内」。**不判**「归属哪一批 / 哪一 lane」——
  //   跨批归属由 audit / handoff 承载（本判据不承担，也不应承担：它没有批次账本可读）。
  // 为什么换掉清单：那张表已连续 4 次把新出现的合法路径误判成「无法归属 = 越界」，
  //   每次补救都是「再塞一条」⇒ 判据本身成了维护负担，且判据面与真实写域永远追不上。
  //
  // ⚠ **有意放宽，逐条登记**（2026-10-25 r1 实测：旧表 × 新分类器对 22 条路径 ≈ 旧红→新放行 6 类、
  //   收紧 0 类。这不是回归，是换机制的必然结果——那 6 类在老表下红的唯一原因是「还没人改过、
  //   所以没被塞进清单」，属**待发假红**）。各类的兜底在右：
  //   ① `presets/**`（含**注入面** `agent.cordis.yml`）→ 指引面放行。兜底：改动必然进 porcelain 并
  //      暴露在 audit 面；注入面另有 repo↔live 一致性门（`AC-pack1-12` / `AC-pack3-10`）。
  //   ② `scripts/**` 任意新脚本 → 引擎脚本面放行（旧表只放行 2 个精确文件）。兜底：脚本是引擎可执行面，
  //      任何脚本改动都会进 review/audit 证据面；**本判据不再承担「脚本白名单」职责**。
  //   ③ `skills/<其他 team>/**` → 能力层放行。兜底：`check-guidance-sync` 校 repo↔live 逐字节。（已废：该脚本已退役，本行仅存历史）
  //   ④ `test/helpers/**`、`test/nested/**` → 测试面放行（旧 `test-maintenance` 只放行单层 `test/<x>.test.js`）。
  //      兜底：新增/删除 test 文件仍撞 `baselines/test-baseline.json` 计数棘轮。
  //   ⑤ `baselines/**` → 分类器判「基线面」放行，**唯一拦住它的是下方 `forbidden`**（r1 反向构造已证该行承重：
  //      停用它 ⇒ 脏基线变绿）。⇒ **`forbidden` 是独立第二防线，勿当死代码删**。
  // ⑥ 已知盲区：包内 `docs/**` 被 `.gitignore:50` 整体忽略 ⇒ 变更**不进** `git status` ⇒ 本判据与
  //   `forbidden` 都**结构上收不到**该路径（非本批引入，改 `--ignored` 会拖入 49 件既有 docs 致恒红）。
  const FACE_RULES = [
    { face: '能力层',     prefix: 'packages/dsh-punky-swarm/skills/' },
    { face: '测试面',     prefix: 'packages/dsh-punky-swarm/test/' },
    { face: '引擎脚本面', prefix: 'packages/dsh-punky-swarm/scripts/' },
    { face: '引擎面',     prefix: 'packages/dsh-punky-swarm/lib/' },
    { face: '基线面',     prefix: 'packages/dsh-punky-swarm/baselines/' },
    // 2026-10-25 Lead 裁决（选项 B）：`presets/**` 是**指引面**，属常规已知面。
    //   依据：改 `presets/…/references/discipline.md` 在 `punky-iter-a-20261024` 是**合法批次动作**；
    //   若按越界处理，新判据会对合法动作**恒红**，而补救方式是「Leader 显式裁 ＋ 加一行规则」——
    //   那正是本判据要根治的「每批塞一条」。⇒ 视为常规面，不再需要每次开闸。
    //   `docs/` `reports/` **仍维持越界**（这两处确实从不该改，且由下方 `forbidden` 禁区额外兜底）。
    { face: '指引面',     prefix: 'packages/dsh-punky-swarm/presets/' },
    // 2026-11-01 Lead 裁定（窄规则，必须**窄到文件**）：`cordis.patch.yml` 是**注入面副本之一**，
    //   与 `presets/punky-preset/agent.cordis.yml` 同族（两者都由脚本同步进宿主 preset）。
    //   ⇒ 分类学上它属「**注入面**」，不是「发行面」（发行面 = package.json / CHANGELOG / README 这类元数据）。
    //
    // 为什么以前漏登（**结构性原因，不是笔误**）：这张表是**前缀维**而非文件维，而两件注入面副本
    //   **深度不同** —— 一件在 `presets/` 下（命中上面的『指引面』前缀，属"碰巧合规"），
    //   一件在**包根**（不落任何前缀，也不匹配 RELEASE_RE）⇒ 判越界。
    //   该文件历史上**从未被改过** ⇒ 从未进 porcelain ⇒ 本判据从未跑过它 ⇒ **潜伏假红**
    //   （本文件 :495-500 已自述「待发假红」模式；`punky-g5l-deviation-2026-10-31` 的 `e2-guidance`
    //   首次改它 —— AC 明列的合法批次动作 —— 红才浮出。**合法动作被判越界 = 判据错，不是动作错**）。
    //   另：`assembly-schema` / `governance-config` / `hot-config` / `patch-preset-duplicate-consistency`
    //   四个测试都已把该文件当一等产物引用。
    //
    // ⚠ 反「改判据换绿」约束：前缀写**整路径** ⇒ `startsWith` 语义下等同**精确文件**；
    //   **禁**写成 `packages/dsh-punky-swarm/`（开目录）或 `cordis.patch.*`（开模式）。
    //   判据 = 除该文件外任何未知路径仍必须判越界（已用「临时未知文件」反例验证过）。
    { face: '注入面',     prefix: 'packages/dsh-punky-swarm/cordis.patch.yml' },
  ];
  const RELEASE_RE = /^(packages\/dsh-punky-swarm\/)?(package\.json|CHANGELOG\.md|README\.md|README\.en\.md)$/;
  // 长前缀优先：**显式按字面前缀长度降序排序**，不依赖书写顺序（防后人插队改变语义）。
  const FACE_ORDER = [...FACE_RULES].sort((a, b) => b.prefix.length - a.prefix.length);
  const KNOWN_FACES = [...FACE_RULES.map((r) => r.face), '发行面'];
  /** @returns {string|null} 命中的面名；null = 不在任何已知面内（越界） */
  const classifyFace = (p) => {
    if (RELEASE_RE.test(p)) return '发行面';
    for (const r of FACE_ORDER) if (p.startsWith(r.prefix)) return r.face;
    return null;
  };
  const r = spawnSync('git', ['status', '--porcelain', '-uall'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, 'git status 必须可用');
  const paths = (r.stdout ?? '').split(/\r?\n/).filter(Boolean).map((line) => {
    const m = /^(..)\s(.*)$/.exec(line);
    assert.ok(m, 'porcelain 行无法解析：' + JSON.stringify(line));
    let p = m[2];
    if (p.includes(' -> ')) p = p.split(' -> ').pop();
    return p.replace(/^"|"$/g, '');
  });
  const forbidden = paths.filter((p) => /^packages\/dsh-punky-swarm\/(baselines|docs|reports)\//.test(p));
  assert.deepEqual(forbidden, [], '禁区内出现变更（baselines/docs/reports 本批只读）：' + JSON.stringify(forbidden));
  const unrouted = paths.filter((p) => classifyFace(p) === null);
  assert.deepEqual(
    unrouted,
    [],
    `越界：以下路径不落在任何已知面内。\n  已知面：${KNOWN_FACES.join(' / ')}\n  越界项：${JSON.stringify(unrouted)}`,
  );
});
