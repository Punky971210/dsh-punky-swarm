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

// test/vocabulary.test.js —— R1「契约三小件」·词表与契约面（exec-1 lane）
// ─────────────────────────────────────────────────────────────────────────────
// 被检面 = `lib/state/vocabulary.json`（新，词表真源）+ `lib/state/vocabulary.js`（新，唯一读端）。
// 判据来源：`docs/r1-blueprint-spec.md` §2.1(e) 读取器冻结契约 4 条 + §3 S-④ + §2.1(b)(c) 条目 schema/状态机。
//
// 覆盖口径（逐条可机检，**全部纯函数级 / 临时根级**，不碰包内 `lib/state/vocabulary.json` 交付物文件）：
//   A. 交付物本体：schema 自洽、`entries` 判据（R1 冻结空表）、meta.counts、键序、sources 证据锚在场
//   B. 读端契约 1 fail-closed：缺失 / JSON 坏 / schema 不过 ⇒ `ok:false` 且不抛
//   C. 读端契约 2 单例缓存：key = 绝对路径 + mtime + size（同 flows.js:66 CACHE 形），改文件即时生效
//   D. 读端契约 3 停用≠删除：`tokensOfKind` **含** `enabled:false`（S-④ ①）；写端过滤两态可分（S-④ ②）
//   E. 读端契约 4 零副作用：只读往返后交付物文件字节不变，且返回形态极简（无写句柄）
//   F. `validateVocabulary` 内部一致性：唯一性 / 字段缺失 / 枚举 / pending 一致性 / 未知 kind / replacedBy 悬空
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  VOCABULARY_REL,
  VOCABULARY_KINDS,
  loadVocabulary,
  tokensOfKind,
  gateCodeKnown,
  reasonTokenKnown,
  validateVocabulary,
} from '../lib/state/vocabulary.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VOCAB_ABS = path.join(PKG_ROOT, 'lib', 'state', 'vocabulary.json');

// ── 夹具：临时根下造一份**隔离词表**（绝不写包内交付物文件）────────────────────
const TMP_ROOTS = [];
function tempRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-vocab-'));
  TMP_ROOTS.push(r);
  return r;
}
test.after(() => {
  for (const r of TMP_ROOTS) fs.rmSync(r, { recursive: true, force: true });
});

/** 写一份词表到临时根；`entries` 为本用例私有夹具（含 `enabled:false` 停用条目）。 */
function seedVocab(entries, metaOverride = {}) {
  const root = tempRoot();
  const doc = {
    $schema: 'dsh-punky-swarm/vocabulary@1',
    meta: {
      version: 1,
      updated: '2026-09-19',
      counts: { gateCodes: 86, reasonTokens: 45, ...metaOverride },
    },
    sources: [{ id: 'gate-entry', path: 'lib/state/gates.ts', line: 598, note: 'GATE_* 拒码面（Entry 门）' }],
    entries,
  };
  const abs = path.join(root, VOCABULARY_REL);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(doc, null, 2), 'utf8');
  return { root, abs, doc };
}

const ENTRY_ACTIVE = {
  id: 'reason-no-such-token', code: 'no_such_token', label: '新增用例码', kind: 'reason',
  enabled: true, since: '0.4.4', deprecatedIn: null, replacedBy: null,
};
const ENTRY_RETIRED = {
  id: 'reason-legacy-token', code: 'legacy_token', label: '已停用码', kind: 'reason',
  enabled: false, since: '0.3.0', deprecatedIn: '0.4.4', replacedBy: 'reason-no-such-token',
  note: '停用而非删除：既有产物仍解析通过',
};
const ENTRY_GATE = {
  id: 'gate-token-unknown', code: 'GATE_TOKEN_UNKNOWN', label: '未登记 token', kind: 'gate',
  enabled: true, since: '0.4.4', deprecatedIn: null, replacedBy: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// A. 交付物本体（`lib/state/vocabulary.json`）
// ─────────────────────────────────────────────────────────────────────────────

test('A1 交付物在场且 JSON 可解析（UTF-8 无 BOM / LF）', () => {
  assert.ok(fs.existsSync(VOCAB_ABS), '须存在交付物 ' + VOCAB_ABS);
  const raw = fs.readFileSync(VOCAB_ABS);
  assert.notDeepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], '须 UTF-8 无 BOM');
  assert.equal(raw.includes(0x0d), false, '须 LF 行尾（不得含 CR）');
  assert.ok(JSON.parse(raw.toString('utf8')));
});

test('A2 `loadVocabulary()`（缺省 root=包根）读到交付物且 schema 自洽', () => {
  const d = loadVocabulary();
  assert.equal(d.ok, true, 'problems=' + JSON.stringify(d.problems));
  const v = validateVocabulary(d);
  assert.deepEqual(v, { ok: true, problems: [] });
});

test('A3 `entries` R1 冻结为**空数组**（存量不追溯 = 零条目即零校验面）', () => {
  const d = loadVocabulary();
  assert.ok(Array.isArray(d.entries));
  assert.equal(d.entries.length, 0);
  // 附带判据：meta.counts 以复算口径登记存量规模（不建条、只记数）。
  // ⚠ 不断言具体数值：该数会随各 lane 新增 `GATE_*` / `reason` token 而单调上升
  //   （本 lane 自身即新引入 `GATE_TOKEN_UNKNOWN`）⇒ 写死数值会让邻居 lane 合法新增误红。
  //   数值口径的机检归**产物**（`exec/vocabulary-layer.md` 的复算读数 + audit 复跑）。
  assert.ok(Number.isInteger(d.meta.counts.gateCodes) && d.meta.counts.gateCodes > 0, 'counts.gateCodes 须为正整数');
  assert.ok(Number.isInteger(d.meta.counts.reasonTokens) && d.meta.counts.reasonTokens > 0, 'counts.reasonTokens 须为正整数');
});

test('A4 顶层键序 = $schema→meta→sources→entries（避免清单抖动）', () => {
  const d = loadVocabulary();
  // 读端返回 = 判定位（ok/problems 在前）+ 词表四键（**原序**：blueprint §2.1(a) 冻结，防清单抖动）
  assert.deepEqual(Object.keys(d), ['ok', 'problems', '$schema', 'meta', 'sources', 'entries']);
  assert.equal(d.$schema, 'dsh-punky-swarm/vocabulary@1');
  assert.equal(d.meta.version, 1);
});

test('A5 `sources` 为**非空**证据锚数组（id/path/line/note 四字段齐）', () => {
  const d = loadVocabulary();
  assert.ok(Array.isArray(d.sources) && d.sources.length > 0);
  for (const s of d.sources) {
    assert.equal(typeof s.id, 'string');
    assert.match(s.id, /^[a-z][a-z0-9-]*$/);
    assert.equal(typeof s.path, 'string');
    assert.ok(fs.existsSync(path.join(PKG_ROOT, s.path)), '证据锚须在场：' + s.path);
    assert.equal(typeof s.line, 'number');
    assert.ok(s.line >= 1);
    assert.equal(typeof s.note, 'string');
    assert.ok(s.note.length > 0);
  }
});

test('A6 导出面 = 冻结 6 符号 + 2 常量（`node --check` 之外的形状判据）', () => {
  assert.equal(VOCABULARY_REL, 'lib/state/vocabulary.json');
  assert.deepEqual([...VOCABULARY_KINDS], ['gate', 'event', 'reason', 'role', 'section', 'element']);
  assert.ok(Object.isFrozen(VOCABULARY_KINDS), 'VOCABULARY_KINDS 须冻结');
  for (const f of [loadVocabulary, tokensOfKind, gateCodeKnown, reasonTokenKnown, validateVocabulary]) {
    assert.equal(typeof f, 'function');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// B. 读端契约 1 —— fail-closed（缺失 / JSON 坏 / schema 不过 ⇒ ok:false 且不抛）
// ─────────────────────────────────────────────────────────────────────────────

test('B1 缺文件 ⇒ ok:false（不抛）；fail-closed 不等于「无词表则任意码合法」', () => {
  const root = tempRoot();
  const d = loadVocabulary({ root });
  assert.equal(d.ok, false);
  assert.ok(d.problems.length > 0, '须给出可读 problems');
  // fail-closed 的收紧面：词表不可用 ⇒ 未知 token **不**被判 known（调用方走告警通道，不得放宽）
  assert.notEqual(reasonTokenKnown('no_such_token', { root }).known, true);
});

test('B2 JSON 解析失败 ⇒ ok:false（不抛）', () => {
  const root = tempRoot();
  const abs = path.join(root, VOCABULARY_REL);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '{ "entries": [ , not json', 'utf8');
  const d = loadVocabulary({ root });
  assert.equal(d.ok, false);
  assert.ok(d.problems.some((p) => /JSON/i.test(p)), 'problems 须点明 JSON 解析失败：' + JSON.stringify(d.problems));
});

test('B3 schema 不过（bogus kind）⇒ ok:false 且 problems 指明条目', () => {
  const { root } = seedVocab([{ ...ENTRY_ACTIVE, kind: 'bogus' }]);
  const d = loadVocabulary({ root });
  assert.equal(d.ok, false);
  assert.ok(d.problems.some((p) => p.includes('bogus')));
});

test('B4 `entries` 缺字段（无 deprecatedIn）⇒ ok:false', () => {
  const bad = { ...ENTRY_ACTIVE };
  delete bad.deprecatedIn;
  const { root } = seedVocab([bad]);
  assert.equal(loadVocabulary({ root }).ok, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// C. 读端契约 2 —— 单例缓存 key = 绝对路径 + mtime + size（改文件即时生效）
// ─────────────────────────────────────────────────────────────────────────────

test('C1 命中缓存：同根两次加载返回**同一实例**（单例，省 IO）', () => {
  const { root } = seedVocab([ENTRY_ACTIVE]);
  const a = loadVocabulary({ root });
  const b = loadVocabulary({ root });
  assert.equal(a.ok, true);
  assert.equal(a, b, '同 key 须命中单例缓存');
});

test('C2 改文件即时生效（无需重启）：size 变 ⇒ 缓存失效、读到新内容', () => {
  const { root, abs } = seedVocab([ENTRY_ACTIVE]);
  assert.equal(loadVocabulary({ root }).entries.length, 1);
  const doc = JSON.parse(fs.readFileSync(abs, 'utf8'));
  doc.entries.push(ENTRY_RETIRED);
  fs.writeFileSync(abs, JSON.stringify(doc, null, 2), 'utf8');
  const after = loadVocabulary({ root });
  assert.notEqual(after, undefined);
  assert.equal(after.entries.length, 2, 'size/mtime 变 ⇒ 必须重读');
  assert.equal(after.ok, true);
});

test('C3 改文件即时生效：**同 size** 仅内容变（mtime 变）⇒ 缓存仍失效', () => {
  const { root, abs } = seedVocab([ENTRY_ACTIVE]);
  const before = loadVocabulary({ root });
  const raw = fs.readFileSync(abs, 'utf8');
  const next = raw.replace('新增用例码', '新增用例条'); // 同长度替换（CJK 5 字 ↔ 5 字 ⇒ 同字节数）
  assert.notEqual(next, raw, '夹具须真的改到内容');
  assert.equal(Buffer.byteLength(next, 'utf8'), Buffer.byteLength(raw, 'utf8'), '夹具须保持同 size（只验 mtime 维度）');
  fs.writeFileSync(abs, next, 'utf8');
  const after = loadVocabulary({ root });
  assert.notEqual(after, before, 'mtime 变 ⇒ 缓存必须失效');
});

test('C4 `force` 清缓存：同一文件强制重读得到新实例', () => {
  const { root } = seedVocab([ENTRY_ACTIVE]);
  const a = loadVocabulary({ root });
  const b = loadVocabulary({ root, force: true });
  assert.equal(b.ok, true);
  assert.notEqual(a, b, 'force 须绕过单例缓存');
});

test('C5 缓存按 root 隔离：两个临时根互不串味（key 含绝对路径）', () => {
  const x = seedVocab([ENTRY_ACTIVE]);
  const y = seedVocab([]);
  assert.equal(loadVocabulary({ root: x.root }).entries.length, 1);
  assert.equal(loadVocabulary({ root: y.root }).entries.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// D. 读端契约 3 —— 停用≠删除（S-④ 两态可分）
// ─────────────────────────────────────────────────────────────────────────────

test('S-④① `tokensOfKind` **含** enabled:false 的 token（历史产物仍解析通过）', () => {
  const { root } = seedVocab([ENTRY_ACTIVE, ENTRY_RETIRED, ENTRY_GATE]);
  const reasons = tokensOfKind('reason', { root });
  assert.ok(reasons.has('no_such_token'));
  assert.ok(reasons.has('legacy_token'), '停用条目必须仍在读端索引内 ⇒ 禁用≠删除');
  assert.equal(tokensOfKind('gate', { root }).has('GATE_TOKEN_UNKNOWN'), true);
  assert.equal(tokensOfKind('event', { root }).has('whatever'), false);
});

test('S-④① `reasonTokenKnown(停用 token)` ⇒ known:true + restated:true（读端不拒）', () => {
  // 夹具须**自洽**：停用条目的 replacedBy 必须指向本表已存在的 id（否则 schema 先拒 ⇒ ok:false ⇒ 零索引）
  const { root } = seedVocab([ENTRY_ACTIVE, ENTRY_RETIRED]);
  assert.equal(loadVocabulary({ root }).ok, true, '夹具自身须通过 schema（防「用坏夹具测出假绿/假红」）');
  const r = reasonTokenKnown('legacy_token', { root });
  assert.equal(r.known, true);
  assert.equal(r.restated, true, '停用条目须以 restated 位告知调用方「告警而非拒绝」');
  assert.equal(r.entry.id, 'reason-legacy-token');
});

test('S-④① 在用条目 ⇒ known:true + restated:false', () => {
  const { root } = seedVocab([ENTRY_ACTIVE]);
  const r = reasonTokenKnown('no_such_token', { root });
  assert.equal(r.known, true);
  assert.equal(r.restated, false);
});

test('S-④② 两态可分：**未登记** token ⇒ known:false（新写点被同一单点拒）', () => {
  const { root } = seedVocab([ENTRY_ACTIVE, ENTRY_RETIRED]);
  const r = reasonTokenKnown('never_registered', { root });
  assert.equal(r.known, false, '未登记即 unknown（Q-3=B 的收紧面）');
  assert.equal(r.entry, null);
  assert.equal(r.restated, false);
});

test('S-④② 空表（R1 交付形态）⇒ 任何 token 都 unknown（零条目即零校验面）', () => {
  const { root } = seedVocab([]);
  assert.equal(reasonTokenKnown('no_such_token', { root }).known, false);
  assert.equal(gateCodeKnown('GATE_TOKEN_UNKNOWN', { root }).known, false);
  assert.equal(tokensOfKind('reason', { root }).size, 0);
});

test('`gateCodeKnown` 只认 kind=gate（跨 kind 不串味）', () => {
  const { root } = seedVocab([ENTRY_ACTIVE, ENTRY_GATE, ENTRY_RETIRED]);
  assert.equal(gateCodeKnown('GATE_TOKEN_UNKNOWN', { root }).known, true);
  assert.equal(gateCodeKnown('no_such_token', { root }).known, false, 'kind=reason 的码不得被 gate 判定面认领');
  assert.equal(reasonTokenKnown('GATE_TOKEN_UNKNOWN', { root }).known, false, 'kind=gate 的码不得被 reason 判定面认领');
});

test('入参非字符串 / 空串 ⇒ known:false（零副作用，不抛）', () => {
  const { root } = seedVocab([ENTRY_ACTIVE, ENTRY_GATE]);
  for (const bad of [null, undefined, 42, {}, '', '   ']) {
    assert.equal(gateCodeKnown(bad, { root }).known, false);
    assert.equal(reasonTokenKnown(bad, { root }).known, false);
  }
  assert.equal(tokensOfKind('bogus', { root }).size, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// E. 读端契约 4 —— 零副作用（不写盘 / 不发事件 / 不改状态）
// ─────────────────────────────────────────────────────────────────────────────

test('E1 只读往返后交付物文件**逐字节不变**（零副作用）', () => {
  const before = fs.readFileSync(VOCAB_ABS);
  const st1 = fs.statSync(VOCAB_ABS);
  loadVocabulary({ force: true });
  tokensOfKind('reason', { force: true });
  gateCodeKnown('GATE_TOKEN_UNKNOWN', { force: true });
  reasonTokenKnown('no_such_token', { force: true });
  validateVocabulary(loadVocabulary({ force: true }));
  const after = fs.readFileSync(VOCAB_ABS);
  const st2 = fs.statSync(VOCAB_ABS);
  assert.equal(Buffer.compare(before, after), 0, '读端不得写盘');
  assert.equal(st1.mtimeMs, st2.mtimeMs, '读端不得触碰 mtime');
});

test('E2 返回形态极简：loadVocabulary 无写句柄、无事件出口（纯数据）', () => {
  const d = loadVocabulary();
  for (const k of Object.keys(d)) {
    const v = d[k];
    assert.ok(['string', 'number', 'object', 'boolean'].includes(typeof v) || Array.isArray(v));
    assert.notEqual(typeof v, 'function', '不得返回函数型句柄：' + k);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// F. `validateVocabulary` 内部一致性（纯函数，夹具直传对象）
// ─────────────────────────────────────────────────────────────────────────────

function docOf(entries) {
  return {
    $schema: 'dsh-punky-swarm/vocabulary@1',
    meta: { version: 1, updated: '2026-09-19', counts: { gateCodes: 86, reasonTokens: 45 } },
    sources: [{ id: 'gate-entry', path: 'lib/state/gates.ts', line: 598, note: 'GATE_* 拒码面（Entry 门）' }],
    entries,
  };
}

test('F1 合规 doc ⇒ {ok:true, problems:[]}（含停用条目）', () => {
  assert.deepEqual(validateVocabulary(docOf([ENTRY_ACTIVE, ENTRY_RETIRED, ENTRY_GATE])), { ok: true, problems: [] });
  assert.deepEqual(validateVocabulary(docOf([])), { ok: true, problems: [] });
});

test('F2 非对象 / $schema 版本锚错 ⇒ ok:false', () => {
  assert.equal(validateVocabulary(null).ok, false);
  assert.equal(validateVocabulary('x').ok, false);
  assert.equal(validateVocabulary({}).ok, false);
  const d = docOf([]);
  d.$schema = 'dsh-punky-swarm/vocabulary@2';
  assert.equal(validateVocabulary(d).ok, false);
});

test('F3 id / code 重复 ⇒ ok:false（唯一性）', () => {
  assert.equal(validateVocabulary(docOf([ENTRY_ACTIVE, { ...ENTRY_GATE, id: ENTRY_ACTIVE.id }])).ok, false);
  assert.equal(validateVocabulary(docOf([ENTRY_ACTIVE, { ...ENTRY_GATE, code: ENTRY_ACTIVE.code }])).ok, false);
});

test('F4 id 非 kebab-case / label 超 40 字 / since 非版本号 ⇒ ok:false', () => {
  assert.equal(validateVocabulary(docOf([{ ...ENTRY_ACTIVE, id: 'Bad_Id' }])).ok, false);
  assert.equal(validateVocabulary(docOf([{ ...ENTRY_ACTIVE, label: 'x'.repeat(41) }])).ok, false);
  assert.equal(validateVocabulary(docOf([{ ...ENTRY_ACTIVE, since: 'v0.4' }])).ok, false);
});

test('F5 kind ∉ 6 值枚举 ⇒ ok:false；enabled 非布尔 ⇒ ok:false', () => {
  assert.equal(validateVocabulary(docOf([{ ...ENTRY_ACTIVE, kind: 'nope' }])).ok, false);
  assert.equal(validateVocabulary(docOf([{ ...ENTRY_ACTIVE, enabled: 'true' }])).ok, false);
});

test('F6 enabled:false 但 deprecatedIn:null ⇒ ok:false（停用必须有停用版本）', () => {
  assert.equal(validateVocabulary(docOf([{ ...ENTRY_ACTIVE, enabled: false, deprecatedIn: null }])).ok, false);
});

test('F7 replacedBy 悬空（指向不存在的 id）⇒ ok:false', () => {
  assert.equal(validateVocabulary(docOf([{ ...ENTRY_ACTIVE, replacedBy: 'ghost-entry' }])).ok, false);
  // 反向：replacedBy 指向**本表已存在**的 id ⇒ 合规
  assert.equal(validateVocabulary(docOf([ENTRY_ACTIVE, ENTRY_RETIRED])).ok, true);
});

test('F8 meta.counts 缺项 / sources 空 ⇒ ok:false', () => {
  const d1 = docOf([]);
  delete d1.meta.counts.reasonTokens;
  assert.equal(validateVocabulary(d1).ok, false);
  const d2 = docOf([]);
  d2.sources = [];
  assert.equal(validateVocabulary(d2).ok, false);
});
