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

// lib/state/vocabulary.js —— R1「契约三小件」·词表真源唯一读端
// ─────────────────────────────────────────────────────────────────────────────
// 定位：`lib/state/vocabulary.json`（词表真源）的**唯一读端**（纯函数 + 单例缓存）。
// 语义：登记义务——**新增**的 `GATE_*` 码 / `reason` token 必须先入表（`enabled:true`）再落代码；
//   未登记的新 token 由门禁面拒 `GATE_TOKEN_UNKNOWN`。**存量不追溯**由词表内容承载
//   （R1 `entries:[]` ⇒ 零条目即零校验面），**不**由批次年龄分支承载（不设 env 阀 / 不做按批龄分流）。
//
// 读取器冻结契约 4 条（blueprint §2.1(e)，逐条实现）：
//   1. fail-closed：缺失 / JSON 坏 / schema 不过 ⇒ `loadVocabulary().ok === false`，**且不抛**
//      （调用方降级告警 + 留痕，不得因此拒批；加载失败 **不等于**「无词表则任意码合法」）；
//   2. 零缓存穿透：单例缓存 key = 绝对路径 + mtimeNs + size ⇒ 改文件即时生效、不需重启；
//   3. 禁用不等于删除：`tokensOfKind` / `*Known` 的索引**包含** `enabled:false` 的词条
//      ⇒ 历史产物仍解析通过；「停用」只对新写点生效（`restated:true` 是给调用方的告警位）；
//   4. 零副作用：**不写盘、不发事件、不改任何状态**（本文件只调 `fs.statSync` / `fs.readFileSync` /
//      `fs.existsSync` 三个只读 API）。
//
// 依赖纪律（防环）：**只依赖 `node:fs` / `node:path` / `node:url`**——不得 import `gates.ts` / `store.js`。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 词表在包内的相对路径（冻结；单一真源，禁在别处硬编码）。 */
export const VOCABULARY_REL = 'lib/state/vocabulary.json';

/** 冻结的 6 个词条分类（blueprint §2.1(b) `kind` 枚举）。 */
export const VOCABULARY_KINDS = Object.freeze(['gate', 'event', 'reason', 'role', 'section', 'element']);

/** 冻结的版本锚（`$schema` 恒此字面量）。 */
const VOCABULARY_SCHEMA = 'dsh-punky-swarm/vocabulary@1';

/** 包根（本文件位于 `<pkg>/lib/state/`）——缺省 root。 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── 字段形态（冻结 regex）────────────────────────────────────────────────────
const ID_RE = /^[a-z][a-z0-9-]*$/;                      // id：kebab-case
const CODE_RE = /^[A-Za-z][A-Za-z0-9_.:-]*$/;           // code：机器码原文
const VERSION_RE = /^v?\d+\.\d+\.\d+$/;                 // since / deprecatedIn：引入版本口径
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;                  // meta.updated：YYYY-MM-DD
const LABEL_MAX = 40;

// ── 单例缓存：key = 绝对路径 + mtimeNs + size（同 flows.js:66 `CACHE` 形）────────
const CACHE = new Map();

function rootOf(opts) {
  const root = opts?.root;
  return (root == null || root === '') ? PACKAGE_ROOT : path.resolve(String(root));
}

/**
 * 词表绝对路径（供读端自证「读的是哪一份」；零副作用）。
 * @param {{root?: string|null}} [opts]
 * @returns {string}
 */
function vocabularyAbsPath(opts = {}) {
  return path.join(rootOf(opts), ...VOCABULARY_REL.split('/'));
}

/** 读文件指纹（mtimeNs 取纳秒级，防同毫秒内两次写盘被误判「未变」）。失败 ⇒ null。 */
function fingerprintOf(abs) {
  try {
    const st = fs.statSync(abs, { bigint: true });
    return { mtimeNs: st.mtimeNs, size: st.size };
  } catch {
    return null;
  }
}

/**
 * 加载词表（进程内单例；**读取/schema 失败 → fail-closed 返回 `ok:false`，不抛**）。
 * @param {{root?: string|null, force?: boolean}} [opts]
 * @returns {{ok: boolean, problems: string[], $schema?: string, meta?: object, sources?: object[], entries?: object[]}}
 */
export function loadVocabulary({ root = null, force = false } = {}) {
  const abs = vocabularyAbsPath({ root });
  const fp = fingerprintOf(abs);
  if (fp == null) return { ok: false, problems: [`词表不可读（缺文件或权限不足）：${abs}`] };

  const key = `${abs}|${fp.mtimeNs}|${fp.size}`;
  if (!force) {
    const hit = CACHE.get(key);
    if (hit !== undefined) return hit;
    // 文件已换版 ⇒ 逐出旧指纹，防同一路径多份缓存堆叠
    for (const k of [...CACHE.keys()]) if (k.startsWith(`${abs}|`)) CACHE.delete(k);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    return { ok: false, problems: [`词表 JSON 解析失败：${abs}（${(e && e.message) || String(e)}）`] };
  }

  const schemaCheck = validateVocabulary(parsed);
  if (!schemaCheck.ok) return { ok: false, problems: schemaCheck.problems };

  const doc = Object.freeze({
    ok: true,
    problems: [],
    $schema: parsed.$schema,
    meta: parsed.meta,
    sources: parsed.sources,
    entries: parsed.entries,
  });
  CACHE.set(key, doc);
  return doc;
}

/** 取「已加载且 schema 通过」的词条表；未通过 ⇒ 空数组（fail-closed：不产索引、不放宽）。 */
function entriesOf(opts) {
  const doc = loadVocabulary(opts);
  if (!doc.ok) return [];
  return Array.isArray(doc.entries) ? doc.entries : [];
}

/**
 * 按 kind 建 token 索引。
 * **含 `enabled:false` 的词条**（「禁用≠删除」：历史产物仍解析通过）。
 * @param {string} kind ∈ {@link VOCABULARY_KINDS}
 * @param {{root?: string|null, force?: boolean}} [opts]
 * @returns {Set<string>} code 集合（词表不可用 ⇒ 空集）
 */
export function tokensOfKind(kind, opts = {}) {
  const set = new Set();
  if (typeof kind !== 'string' || !VOCABULARY_KINDS.includes(kind)) return set;
  for (const e of entriesOf(opts)) {
    if (e && e.kind === kind && typeof e.code === 'string') set.add(e.code);
  }
  return set;
}

/** 判定单点（`gateCodeKnown` / `reasonTokenKnown` 共用，防两套口径）。 */
function knownOf(kind, token, opts) {
  const unknown = { known: false, entry: null, restated: false };
  if (typeof token !== 'string' || token.trim() === '') return unknown;
  for (const e of entriesOf(opts)) {
    if (!e || e.kind !== kind || e.code !== token) continue;
    const restated = e.enabled !== true;   // 停用 ⇒ true（调用方据此告警而非拒绝）
    return { known: true, entry: e, restated };
  }
  return unknown;
}

/**
 * 校验一条 `kind:'gate'` 的码字面量（**未登记即 unknown** —— Q-3=B 的收紧面）。
 * @param {string} code
 * @param {{root?: string|null, force?: boolean}} [opts]
 * @returns {{known: boolean, entry: object|null, restated: boolean}}
 */
export function gateCodeKnown(code, opts = {}) {
  return knownOf('gate', code, opts);
}

/**
 * 校验一条 `kind:'reason'` 的 token 原文（与 {@link gateCodeKnown} 同返回形、同判定单点）。
 * @param {string} token
 * @param {{root?: string|null, force?: boolean}} [opts]
 * @returns {{known: boolean, entry: object|null, restated: boolean}}
 */
export function reasonTokenKnown(token, opts = {}) {
  return knownOf('reason', token, opts);
}

// ── 内部一致性自检（schema + 唯一性 + deprecatedIn/enabled 一致性）────────────

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

function checkSources(sources, repoRoot, problems) {
  if (!Array.isArray(sources) || sources.length === 0) {
    problems.push('sources 必填且非空（每条 = 一个待收敛读端的证据锚）');
    return;
  }
  const seen = new Set();
  for (const [i, s] of sources.entries()) {
    const at = `sources[${i}]`;
    if (!isPlainObject(s)) { problems.push(`${at} 须为对象`); continue; }
    if (!isNonEmptyString(s.id)) problems.push(`${at}.id 必填（非空字符串）`);
    else if (!ID_RE.test(s.id)) problems.push(`${at}.id 须为 kebab-case：${s.id}`);
    else if (seen.has(s.id)) problems.push(`${at}.id 重复：${s.id}`);
    else seen.add(s.id);
    if (!isNonEmptyString(s.path)) problems.push(`${at}.path 必填（包根相对路径）`);
    else if (!fs.existsSync(path.join(repoRoot, s.path))) problems.push(`${at}.path 证据锚不在场：${s.path}`);
    if (typeof s.line !== 'number' || !Number.isInteger(s.line) || s.line < 1) problems.push(`${at}.line 必填（1-based 整数）`);
    if (!isNonEmptyString(s.note)) problems.push(`${at}.note 必填（非空）`);
  }
}

function checkEntryShape(e, at, problems) {
  if (!isPlainObject(e)) { problems.push(`${at} 须为对象`); return false; }
  if (!isNonEmptyString(e.id)) problems.push(`${at}.id 必填（非空字符串）`);
  else if (!ID_RE.test(e.id)) problems.push(`${at}.id 须为 kebab-case：${e.id}`);
  if (!isNonEmptyString(e.code)) problems.push(`${at}.code 必填（非空字符串）`);
  else if (!CODE_RE.test(e.code)) problems.push(`${at}.code 形态不合法：${e.code}`);
  if (!isNonEmptyString(e.label)) problems.push(`${at}.label 必填（非空）`);
  else if (e.label.length > LABEL_MAX) problems.push(`${at}.label 超长（>${LABEL_MAX} 字）：${e.label.length}`);
  if (typeof e.kind !== 'string' || !VOCABULARY_KINDS.includes(e.kind)) {
    problems.push(`${at}.kind 须 ∈ ${VOCABULARY_KINDS.join('|')}（实得：${JSON.stringify(e.kind)}）`);
  }
  if (typeof e.enabled !== 'boolean') problems.push(`${at}.enabled 必填（布尔）`);
  if (!isNonEmptyString(e.since)) problems.push(`${at}.since 必填（非空字符串）`);
  else if (!VERSION_RE.test(e.since)) problems.push(`${at}.since 须为版本号：${e.since}`);
  if (e.deprecatedIn !== null && !isNonEmptyString(e.deprecatedIn)) problems.push(`${at}.deprecatedIn 必填（版本号或 null）`);
  else if (typeof e.deprecatedIn === 'string' && !VERSION_RE.test(e.deprecatedIn)) problems.push(`${at}.deprecatedIn 须为版本号：${e.deprecatedIn}`);
  if (e.replacedBy !== null && !isNonEmptyString(e.replacedBy)) problems.push(`${at}.replacedBy 必填（id 或 null）`);
  else if (typeof e.replacedBy === 'string' && !ID_RE.test(e.replacedBy)) problems.push(`${at}.replacedBy 须为 id 形态：${e.replacedBy}`);
  if (e.note !== undefined && !isNonEmptyString(e.note)) problems.push(`${at}.note 若在场须非空`);
  // 「停用而非删除」一致性：enabled:false ⇒ 必须有停用版本
  if (e.enabled === false && e.deprecatedIn == null) {
    problems.push(`${at} enabled:false 时 deprecatedIn 必须非 null（停用而非删除：登记停用版本）`);
  }
  return true;
}

/**
 * 内部一致性自检（schema + 唯一性 + `deprecatedIn`/`enabled` 一致性）。
 * **纯函数**：只看传入对象，不读盘、不写盘、不改缓存。
 * @param {any} doc
 * @returns {{ok: boolean, problems: string[]}}
 */
export function validateVocabulary(doc) {
  const problems = [];
  if (!isPlainObject(doc)) return { ok: false, problems: ['词表根须为对象'] };

  if (doc.$schema !== VOCABULARY_SCHEMA) {
    problems.push(`$schema 须恒为 ${JSON.stringify(VOCABULARY_SCHEMA)}（实得：${JSON.stringify(doc.$schema)}）`);
  }

  // `sources` 证据锚（非空 + id 唯一 + path 在场 + line 1-based）：与 `entries` 判据并列，必检。
  checkSources(doc.sources, PACKAGE_ROOT, problems);

  const meta = doc.meta;
  if (!isPlainObject(meta)) problems.push('meta 必填（对象）');
  else {
    if (typeof meta.version !== 'number' || !Number.isInteger(meta.version) || meta.version < 1) {
      problems.push('meta.version 必填（≥1 整数）');
    }
    if (!isNonEmptyString(meta.updated) || !DATE_RE.test(meta.updated)) problems.push('meta.updated 必填（YYYY-MM-DD）');
    if (!isPlainObject(meta.counts)) problems.push('meta.counts 必填（对象，只读统计）');
    else {
      for (const k of ['gateCodes', 'reasonTokens']) {
        const v = meta.counts[k];
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) problems.push(`meta.counts.${k} 必填（≥0 整数）`);
      }
    }
  }

  if (!Array.isArray(doc.entries)) {
    problems.push('entries 必填（数组；R1 冻结为空数组）');
    return { ok: problems.length === 0, problems };
  }

  const ids = new Set();
  const codes = new Set();
  const pendingReplacedBy = [];
  for (const [i, e] of doc.entries.entries()) {
    const at = `entries[${i}]`;
    if (!checkEntryShape(e, at, problems)) continue;
    if (ids.has(e.id)) problems.push(`${at}.id 全表唯一性冲突：${e.id}`);
    else ids.add(e.id);
    if (codes.has(e.code)) problems.push(`${at}.code 全表唯一性冲突：${e.code}`);
    else codes.add(e.code);
    if (typeof e.replacedBy === 'string') pendingReplacedBy.push([at, e.replacedBy]);
  }
  // 唯一性 / 引用须在**全表**收齐后判（防「先见后引用」误报）
  for (const [at, ref] of pendingReplacedBy) {
    if (!ids.has(ref)) problems.push(`${at}.replacedBy 悬空（本表不存在该 id）：${ref}`);
  }

  return { ok: problems.length === 0, problems };
}
