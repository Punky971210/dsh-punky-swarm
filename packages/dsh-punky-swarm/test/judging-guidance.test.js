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

// 批次 `punky-judging-face-20261024` · lane c2-guidance：**判定面收口**的静态一致性回归锁
// （M-02 deny 面 / M-03 难度档 / M-04 §13 判据数）。
//
// 存在理由（M-04 的必答问题，实测答案）：**人把 §13 改回「三条」时，没有任何已存在判据会红**——
//   `test/accept-pack1-guidance.test.js` / `test/guidance-id-coverage.test.js` /
//   `test/skills-sync.test.js` 全部只锁 `scripts/check-guidance-sync.mjs` 的**行为**，
//   无一处解析正文里「N 条判据」这句话。而这条失配**已经在 `1daa964` 上实际发生**
//   （正文三条 vs 脚本五条）⇒ 「靠人工同源」在 §13 自己的元规则上已失效，必须有机检。
//
// 边界（防误读为「新造脚本判据」）：**不是** `scripts/check-guidance-sync.mjs` 的新判据
//   —— 该脚本本批**零变更**、判据仍五条；本件读的是脚本**头部自述** + 正文措辞，两者分叉即红。
//   §13 既有裁决「不新增脚本判据」约束的是 `scripts/` 判据面，不被本件触犯。
//
// 口径：**只读静态断言**（读源码 / 正文文本）＋ **反向构造夹具**（证明判据非恒真）；
//   零副作用：不装载引擎、不 spawn 子进程、不写盘。
//   **真值全部运行期算**：代码侧集合从 `lib/engine/suite.js` 的 `entry()` 表**解析**（单点真源，
//   `SUITE_DENY_TOOLS` / `MODE_GATED_TOOLS` 即其派生），文档侧的数与名从正文解析，
//   两侧相等才绿 ⇒ 本件**不写死 17 / 11 / 3 / 5**（改数即由解析面自动跟随，写错数即红）。
//
// 映射（对齐规格 `plan/fix-spec-judging.md` §验收标准）：
//   j2-1 ← AC-07 正向（§13 判据编码集合相等）      j2-2 ← AC-07 反向夹具
//   j2-3 ← AC-05（§0p 动因行已删 + 现役规范句仍在）  j2-4 ← AC-03（deny 项数与名集合）+ D1b（modeGate）
//   j2-5 ← AC-04（「未列入」两件正确）              j2-6 ← AC-06（难度档枚举含 D）
//   ※ AC-08（两份注入面逐字相同）按规格定为**人工核对项**（Q-2 未裁前不升级为机检），故不在本件。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const DISCIPLINE_REL = 'presets/punky-preset/references/discipline.md';
const SUITE_REL = 'lib/engine/suite.js';
const SYNC_SCRIPT_REL = 'scripts/check-guidance-sync.mjs';
const ASSIGN_TOOLS_REL = 'lib/tools/assign-tools.js';

const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 中文数词 / 阿拉伯数字 → int（只覆盖「N 条判据」「N 件」这类小数量词；无法解析 ⇒ NaN）。 */
const CN_DIGITS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function toInt(token) {
  if (!token) return NaN;
  if (/^\d+$/.test(token)) return Number(token);
  return CN_DIGITS[token] ?? NaN;
}

// ── 代码侧真源：`lib/engine/suite.js` 的 `entry()` 表 ────────────────────────────────

/**
 * `entry(name, kind, modeGate, memberDeny, write)` 单条解析。
 * ⚠ 该表是**单点真源**：`SUITE_DENY_TOOLS` / `MODE_GATED_TOOLS` 都是它的派生，
 * 故「以代码为准」= 从这张表算，而不是从任何导出或文档抄数。
 */
const ENTRY_RE = /entry\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*(true|false)\s*,\s*(true|false)\s*,\s*(true|false)\s*\)/g;

function readSuiteTable() {
  const src = readText(SUITE_REL);
  const rows = [...src.matchAll(ENTRY_RE)].map((m) => ({
    name: m[1],
    kind: m[2],
    modeGate: m[3] === 'true',
    memberDeny: m[4] === 'true',
    write: m[5] === 'true',
  }));
  assert.ok(rows.length > 0, `${SUITE_REL} 必须仍以 entry() 表声明套件工具（本件真源面）`);
  // `entry(` 出现次数 = 表条目数（构造器定义写作 `entry = (`，不含 `entry(`）⇒ 双重计数即报错，
  // 防注释里写示例语法悄悄把条目数放大。
  const occurrences = (src.match(/\bentry\(/g) ?? []).length;
  assert.equal(occurrences, rows.length, `${SUITE_REL} 内 entry( 的出现次数须全为表条目（防注释示例污染解析）`);
  return {
    rows,
    names: rows.map((r) => r.name),
    deny: rows.filter((r) => r.memberDeny).map((r) => r.name),
    modeGate: rows.filter((r) => r.modeGate).map((r) => r.name),
  };
}

// ── 正文侧解析（解析契约失败即红，不静默返回空） ─────────────────────────────────────

/** 取反引号内的工具名（小写 snake_case）；区域外的一切标点/中文标签都不进集合。 */
const backtickedNames = (text) => [...text.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]);

/** §0m deny 面声明：`SUITE_DENY_TOOLS`（**N 项，逐字**）＝ <逐字枚举>。 */
function denyFaceFromDoc(doc) {
  const m = doc.match(/`SUITE_DENY_TOOLS`（\*\*(\d+) 项[^）]*）＝([\s\S]*?)。/);
  assert.ok(m, `${DISCIPLINE_REL} §0m 必须仍以「\`SUITE_DENY_TOOLS\`（**N 项…）＝ <逐字枚举>。」形态声明 deny 面（本件解析契约）`);
  return { declared: Number(m[1]), names: backtickedNames(m[2]) };
}

/** §0l 区：`MODE_GATED_TOOLS`，**现 N 件**：<逐字枚举>—— */
function modeGateFaceFromDoc(doc) {
  const m = doc.match(/`MODE_GATED_TOOLS`，\*\*现 (\d+) 件\*\*：([\s\S]*?)——/);
  assert.ok(m, `${DISCIPLINE_REL} 必须仍以「\`MODE_GATED_TOOLS\`，**现 N 件**：<逐字枚举>——」形态声明模式门集（本件解析契约）`);
  return { declared: Number(m[1]), names: backtickedNames(m[2]) };
}

/** §0m：未列入 deny 面的 **N 件**（如实登记）：<名字…>（均可… */
function unlistedFaceFromDoc(doc) {
  const m = doc.match(/未列入 deny 面的(\S+?)件（如实登记）\*\*：([\s\S]*?)（均可/);
  assert.ok(m, `${DISCIPLINE_REL} §0m 必须仍以「未列入 deny 面的 N 件（如实登记）：<名字…>（均可…」形态登记（本件解析契约）`);
  return { declared: toInt(m[1]), names: backtickedNames(m[2]) };
}

/** 取 `## §<id>` 小节全文（至下一个 `## §` 头）。 */
function sectionText(doc, id) {
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^## §${id}\\s`).test(l));
  assert.ok(start >= 0, `正文必须仍含 ## §${id} 小节（本件定位锚点）`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## §/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

// ── 判据编码集合（① ② ②b ③ ④ …）──────────────────────────────────────────────────
// ⚠ 词表**不写死**：取 U+2460–U+2473（①..⑳）为基数、后缀可选一个小写字母（②b 这种变体）
// ⇒ 脚本日后加 ⑤ / ②c 也自动纳入，不靠本件维护。
const CRITERION_CODE_RE = /([\u2460-\u2473])([a-z])?/g;
const criterionCodes = (text) => {
  const set = new Set();
  for (const m of text.matchAll(CRITERION_CODE_RE)) set.add(m[1] + (m[2] ?? ''));
  return [...set].sort();
};
const declaredCriterionCount = (text) => {
  const m = text.match(/([一二三四五六七八九十\d]+)\s*条判据/);
  assert.ok(m, '必须仍以「N 条判据」自述条数（本件解析契约）');
  return toInt(m[1]);
};

/** 脚本头部注释块（跳 shebang；首个非注释行即止）——只管**自述面**，不扫实现段注释。 */
function scriptHeaderLines(src) {
  const out = [];
  for (const line of src.split('\n')) {
    if (/^#!/.test(line)) continue;
    const t = line.trim();
    if (t === '' || t.startsWith('//')) { out.push(line); continue; }
    break;
  }
  return out;
}

/** 头部逐条判据行（每条以编码开头）⇒ 脚本**实际声明的编码清单**。 */
const HEADER_ITEM_RE = /^\s*\/\/\s+([\u2460-\u2473])([a-z])?(?:\s|$)/;
function scriptCriterionItems(src) {
  const items = [];
  for (const line of scriptHeaderLines(src)) {
    const m = line.match(HEADER_ITEM_RE);
    if (m) items.push(m[1] + (m[2] ?? ''));
  }
  return items;
}

// ── 反向构造夹具（故意保留修前原文形态；⚠ **不是**任何读数来源，只证判据非恒真）──────
// 扫描面纪律（§15.8）：M-02/M-04 的零命中类判据**扫描面 = discipline.md**，
// 本夹具**不在**任何「零命中」扫描面内；repo 全域 grep 该类字面量须自行排除 test/ 夹具面。

/** 修前 §13 收口命令行（三条判据：①②③）——j2-2 的反向夹具。 */
const LEGACY_S13_LINE = '- **收口命令（硬）**：`node scripts/check-guidance-sync.mjs` —— 三条判据：① repo↔live 五件同 sha ② 注入面指针 `#§X` 在正文真实存在 ③ **反向**：正文每个 `## §X` 都在注入面有条目（白名单除外）。**GREEN（exit 0）才算收口**；未跑即视为未收口。';

/** 修前 §0m deny 面枚举（20 项，含 4 个已放开项、缺 `spawn_teammate`）——j2-4 的反向夹具。 */
const LEGACY_DENY_ENUM = '治理套件 `assign_check` / `wave_plan` / `member_status` / `member_settle` / `batch_phase` / `batch_control` / `asset_claim` / `batch_tasks_add` / `task_update` ｜ 派发与锁 `lane_dispatch` / `lane_claim` / `lane_release` ｜ 只读治理面 `gate_status` / `artifact_types` ｜ 宿主子代理 `subagent` / `subagent_fork` ｜ 官方 roster 面 `send_message` / `interrupt_agent` / `list_agents` / `wait_agent`';

/** 修前 §0m「未列入 deny 面的三件」行（含 `spawn_teammate`）——j2-5 的反向夹具。 */
const LEGACY_UNLISTED_CLAIM = '**未列入 deny 面的三件（如实登记）**：`spawn_teammate` / `workflow` / `ralph`（均可产子代理 / 并行代理）**不在** `SUITE_DENY_TOOLS` 内';

/** 修前 §0p 动因行（22/22、deny 19 件）——j2-3 的反向夹具。 */
const LEGACY_DRIFT_SNIPPET = '- **实测背景（2026-09-24）**：teammate 席位当前**完全开放**（**22/22** 蟛蜞工具在场，含上述治理写面），而 dispatch worker 被 deny **19 件** ⇒ **两轨治理面不对称**是本节的直接动因。';

/** 修前 §0b 难度枚举行（A/B/C，缺 D）——j2-6 的反向夹具。 */
const LEGACY_DIFFICULTY_LINE = '- 委派前用 `assign_check({ difficulty, rationale, scope: "full" })` **主动写入**难度 A/B/C（档位定义与判据契约见 §0）；**C 类必须 `wave_plan` 建批**。';

/** 「会漂的动因读数」检测器（M-02 D3 的判据本体）。 */
const DRIFT_EVIDENCE_RE = /22\/22|deny \*\*19 件\*\*/;

/** 难度枚举缺陷检测器（M-03 的判据本体）：`难度 A/B/C` 后**不是** `/D` 即命中。 */
const STALE_DIFFICULTY_RE = /难度[ \t]*A\/B\/C(?!\/D)/;

// ── j2-1 / j2-2：§13 判据条数（AC-07）────────────────────────────────────────────────

test('j2-1 §13 自述的判据条数与编码集合 == 脚本头部实际声明的（运行期算，不写死 3 / 5）', () => {
  const script = readText(SYNC_SCRIPT_REL);
  const scriptItems = scriptCriterionItems(script);
  assert.ok(scriptItems.length > 0, `${SYNC_SCRIPT_REL} 头部必须仍以「① …」逐条自述判据（本件真值来源）`);

  // 脚本自洽：头部「N 条判据」的 N == 逐条条目的条数
  const scriptDeclared = declaredCriterionCount(scriptHeaderLines(script).join('\n'));
  assert.equal(scriptDeclared, scriptItems.length,
    `${SYNC_SCRIPT_REL} 头部自述「${scriptDeclared} 条判据」与其逐条条目数 ${scriptItems.length} 不一致`);

  const doc = readText(DISCIPLINE_REL);
  const s13 = sectionText(doc, '13');
  const line = s13.split('\n').find((l) => /条判据/.test(l));
  assert.ok(line, '§13 必须仍有一条自述「N 条判据」的收口命令行（本件定位锚点）');

  // 正文自述条数 == 脚本解析出的判据数（**这一条**是 M-04 的核心：改回三条必红）
  const bodyDeclared = declaredCriterionCount(line);
  assert.equal(bodyDeclared, scriptItems.length,
    `§13 自述「${bodyDeclared} 条判据」，而 ${SYNC_SCRIPT_REL} 实际声明 ${scriptItems.length} 条`);

  // 编码集合相等（正文枚举的编码集合 == 脚本头部的编码集合）
  const bodyCodes = criterionCodes(line);
  assert.deepEqual(bodyCodes, criterionCodes(scriptItems.join('')),
    `§13 枚举的判据编码 [${bodyCodes}] 与脚本头部 [${criterionCodes(scriptItems.join(''))}] 不集合相等`);

  // 正文自洽：自述条数 == 该行真正枚举出的编码条数（防「写五条却只列三条」）
  assert.equal(bodyCodes.length, bodyDeclared,
    `§13 自述 ${bodyDeclared} 条，但该行实际枚举了 ${bodyCodes.length} 个编码 [${bodyCodes}]`);
});

test('j2-2 反向夹具：修前 §13「三条判据：①②③」必须被同一解析器判红（判据不得恒真）', () => {
  const scriptItems = scriptCriterionItems(readText(SYNC_SCRIPT_REL));
  const legacyDeclared = declaredCriterionCount(LEGACY_S13_LINE);
  const legacyCodes = criterionCodes(LEGACY_S13_LINE);

  assert.equal(legacyDeclared, 3, '夹具读数：修前正文自述三条');
  assert.deepEqual(legacyCodes, ['①', '②', '③'].sort(), '夹具读数：修前正文只枚举 ①②③');
  // 三点必红（这正是 j2-1 的失败路径；三者任一成立即「三条 vs 五条」不可通过）
  assert.notEqual(legacyDeclared, scriptItems.length, '修前条数必须与脚本条数不等（否则 j2-1 恒真）');
  assert.notDeepEqual(legacyCodes, criterionCodes(scriptItems.join('')), '修前编码集合必须与脚本集合不等');
  assert.ok(!legacyCodes.includes('②b'), '修前缺 ②b');
  assert.ok(!legacyCodes.includes('④'), '修前缺 ④');
});

// ── j2-3：§0p 动因行已删（AC-05）────────────────────────────────────────────────────

test('j2-3 动因读数已删且现役规范句仍在（§0p 不再留会漂的 22/22 / deny 19 件）', () => {
  const doc = readText(DISCIPLINE_REL);

  assert.equal(doc.match(DRIFT_EVIDENCE_RE), null,
    `正文仍含会漂的动因读数（命中：${doc.match(DRIFT_EVIDENCE_RE)?.[0] ?? ''}）——该类读数是纯动因解释，不构成现役规范`);

  // 零信息损失：两条现役规范句仍在（D-1 红线 + MCP 全量开放）
  assert.ok(doc.includes('成员**不得再行派发**'), '现役规范句「成员不得再行派发」必须仍在');
  assert.ok(doc.includes('**MCP 等普通工具对成员全量开放**'), '现役规范句「MCP 等普通工具对成员全量开放」必须仍在');
});

test('j2-3b 反向夹具：同一检测器对修前动因行必命中（判据不得恒真）', () => {
  const hit = LEGACY_DRIFT_SNIPPET.match(DRIFT_EVIDENCE_RE);
  assert.ok(hit, '修前原文必须被同一检测器抓到');
  assert.equal(hit[0], '22/22', '命中片段可读（点名到底哪一处会漂）');
  assert.ok(DRIFT_EVIDENCE_RE.test(LEGACY_DRIFT_SNIPPET.replace('22/22', 'x')),
    '夹具读数：去掉 22/22 后「deny **19 件**」仍单独命中 ⇒ 两个检测分支都非空');
});

// ── j2-4：deny 面 / 模式门集（AC-03 + D1b）──────────────────────────────────────────

test('j2-4 §0m deny 面的项数与名集合 == suite.js 的 entry() 表（运行期算）', () => {
  const table = readSuiteTable();
  const face = denyFaceFromDoc(readText(DISCIPLINE_REL));

  assert.equal(face.declared, table.deny.length,
    `§0m 声明 ${face.declared} 项，而 ${SUITE_REL} 的 entry() 表算出 memberDeny=${table.deny.length} 项`);
  assert.equal(face.names.length, face.declared,
    `§0m 声明 ${face.declared} 项，但正文实际枚举了 ${face.names.length} 个名字`);
  assert.deepEqual(face.names.slice().sort(), table.deny.slice().sort(),
    `§0m deny 枚举与代码集合不等：正文多列 [${face.names.filter((n) => !table.deny.includes(n))}]，正文少列 [${table.deny.filter((n) => !face.names.includes(n))}]`);
});

test('j2-4b 模式门集（`MODE_GATED_TOOLS`）项数与名集合 == entry() 表 modeGate（D1b）', () => {
  const table = readSuiteTable();
  const face = modeGateFaceFromDoc(readText(DISCIPLINE_REL));

  assert.equal(face.declared, table.modeGate.length,
    `正文声明 ${face.declared} 件，而 entry() 表算出 modeGate=${table.modeGate.length} 件`);
  assert.equal(face.names.length, face.declared,
    `正文声明 ${face.declared} 件，但实际枚举了 ${face.names.length} 个名字`);
  assert.deepEqual(face.names.slice().sort(), table.modeGate.slice().sort(),
    `模式门枚举与代码集合不等：正文多列 [${face.names.filter((n) => !table.modeGate.includes(n))}]，正文少列 [${table.modeGate.filter((n) => !face.names.includes(n))}]`);
});

test('j2-4c 反向夹具：修前 20 项枚举必与代码集合不等（判据不得恒真）', () => {
  const table = readSuiteTable();
  const legacy = backtickedNames(`\`SUITE_DENY_TOOLS\`（**20 项**）＝${LEGACY_DENY_ENUM}。`);
  assert.equal(legacy.length, 20, '夹具读数：修前正文枚举 20 名');
  assert.notDeepEqual(legacy.slice().sort(), table.deny.slice().sort(), '修前集合必须与代码不等');
  assert.deepEqual(legacy.filter((n) => !table.deny.includes(n)).sort(),
    ['artifact_types', 'asset_claim', 'gate_status', 'send_message'], '修前多列 4 项（可精确对账）');
  assert.deepEqual(table.deny.filter((n) => !legacy.includes(n)), ['spawn_teammate'], '修前少列 1 项');
});

// ── j2-5：「未列入 deny 面」两件（AC-04）────────────────────────────────────────────

test('j2-5 「未列入 deny 面」清单如实登记（`spawn_teammate` 已在 deny 内，不得再被登记为未列入）', () => {
  const table = readSuiteTable();
  const face = unlistedFaceFromDoc(readText(DISCIPLINE_REL));

  assert.equal(face.declared, face.names.length,
    `正文自述 ${face.declared} 件，但实际登记 ${face.names.length} 个名字 [${face.names}]`);
  assert.ok(!face.names.includes('spawn_teammate'),
    '`spawn_teammate` 在代码 deny 面内 ⇒ 不得登记为「未列入」');
  assert.ok(table.deny.includes('spawn_teammate'),
    `夹具读数：${SUITE_REL} 的 memberDeny 必须含 spawn_teammate（正文口径的代码依据）`);

  // 登记项的两条性质：不在 deny 内、也结构性不在 SUITE_TOOLS 表内
  for (const name of face.names) {
    assert.ok(!table.deny.includes(name), `登记为「未列入」的 ${name} 不得出现在 deny 面`);
    assert.ok(!table.names.includes(name), `${name} 不在 SUITE_TOOLS 表内（⇒ 结构性不可能入 deny）`);
  }
});

test('j2-5b 反向夹具：修前「三件含 spawn_teammate」必被同一判据抓红（判据不得恒真）', () => {
  const legacy = unlistedFaceFromDoc(`${LEGACY_UNLISTED_CLAIM}（均可产子代理 / 并行代理）`);
  assert.ok(legacy.names.includes('spawn_teammate'), '修前原文把 spawn_teammate 登记为未列入 ⇒ 必被上述断言拒绝');
  assert.equal(legacy.declared, 3, '夹具读数：修前自述三件');

  // 计数类断言非恒真：修前自述条数与现状条数不等 ⇒ 未来任何一个「沿用旧数」的改动都会红
  const current = unlistedFaceFromDoc(readText(DISCIPLINE_REL));
  assert.notEqual(legacy.declared, current.declared,
    `修前「${legacy.declared} 件」与现状「${current.declared} 件」必须不等（否则条数断言无判别力）`);
});

// ── j2-6：难度档枚举含 D（AC-06）────────────────────────────────────────────────────

test('j2-6 难度枚举档位集合 == assign_check 的 difficulty enum（含 D，运行期算）', () => {
  const doc = readText(DISCIPLINE_REL);
  assert.equal(doc.match(STALE_DIFFICULTY_RE), null,
    `正文仍残留旧枚举「难度 A/B/C」（命中：${doc.match(STALE_DIFFICULTY_RE)?.[0] ?? ''}）`);

  const docEnum = doc.match(/难度[ \t]*([A-D](?:\/[A-D])+)/);
  assert.ok(docEnum, '正文必须仍写明难度档位枚举（本件解析契约）');
  const docTiers = docEnum[1].split('/');

  const src = readText(ASSIGN_TOOLS_REL);
  const m = src.match(/"difficulty":\s*\{[^}]*?"enum":\s*\[([^\]]*)\]/);
  assert.ok(m, `${ASSIGN_TOOLS_REL} 必须仍以 difficulty.enum 声明档位闭集（本件真源面）`);
  const codeTiers = [...m[1].matchAll(/"([A-Z])"/g)].map((x) => x[1]);

  assert.ok(codeTiers.includes('D'), `代码 difficulty.enum 必须含 D（实际 [${codeTiers}]）`);
  assert.deepEqual(docTiers.slice().sort(), codeTiers.slice().sort(),
    `正文枚举 [${docTiers}] 与代码 enum [${codeTiers}] 不等`);
});

test('j2-6b 反向夹具：修前 §0b「难度 A/B/C」必被同一检测器命中（判据不得恒真）', () => {
  const hit = LEGACY_DIFFICULTY_LINE.match(STALE_DIFFICULTY_RE);
  assert.ok(hit, '修前原文必须被同一检测器抓到（否则 j2-6 恒真）');
  assert.ok(hit[0].startsWith('难度'), `命中片段可读：${hit[0]}`);
});
