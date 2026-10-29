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

// 批 `punky-g0-clear-2026-10-29` · lane `e2-verify` —— G0 工具面权威账的**独立复算与集合断言**。
//
// 判据源：`plan/p2-pack-g0.md`
//   · §2.4  差集脚本契约（`diffToolFace` 返回面 / DELETED_5 / SUITE_ONLY_BASELINE / D1..D3）
//   · §2.9  护栏面正交的**修正版**三条判据（lane cmd 原文「两集合无交集」不可成立 ⇒ 已按 §7.1 X-2 修正）
//   · §2.8  D-3 三处注册点的事实基线
//   · AC-6 / AC-7 / AC-12 / AC-16 / AC-17
//   · C-9   **禁数量断言**：断言主体一律为「集合相等 / 集合为空 / 元素在场」；
//           `39/34/31/26/37/30` 只作展示位，本文件**不**出现任何以计数为条件的断言。
//   · C-10  写域互斥：本文件是 e2 唯一写码面；e1 的脚本/账/蓝图一律不碰（缺陷只进报告）。
//   · C-13  禁第二套判据：差集判定**只用** `diffToolFace`，本文件不重算 D1/D2/D3。
//
// 单点口径说明（重要，勿误读）：本文件用**任务包 §2.4 规定的抽取正则**独立复算 `S1`（源码全集），
//   用途仅限「独立核 ledger / 核护栏面」；差集**判定**一律取 `diffToolFace`（C-13）。
//   两者是否一致由独立用例交叉核对（`diffToolFace().s1` vs 本文件正则）——不一致即报缺陷，不静默取其一。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(readText(rel));
const sha256Of = (rel) => createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');

// ── 集合常量（与任务包 §2.4 逐字同源；集合，非计数）────────────────────────────
const DELETED_5 = ['mailbox_send', 'mailbox_read', 'mailbox_ack', 'lane_heartbeat', 'lane_longrun'];
const SUITE_ONLY_BASELINE = [
  'log_export', 'subagent', 'subagent_fork', 'send_message',
  'interrupt_agent', 'list_agents', 'wait_agent', 'spawn_teammate',
];
// 本批开工时护栏资产的 sha256（AC-12：本批只读它 ⇒ 前后必须一致）
const GUARD_ASSET_SHA_AT_START = '78125558daf53165c42cb2bb0e565e35336e8f364b1a068e36be56f476af1e80';
const GUARD_ASSET = 'presets/hook-rules/l5-wait-ban.json';
const LEDGER = 'docs/tool-face-ledger.md';
const DIFF_SCRIPT = 'scripts/tool-face-diff.mjs';

// ── S1：源码全集（任务包 §2.4 规定的抽取正则：`/^\s{2}entry\('([a-z_]+)'/gm`）──────
function sourceToolNames() {
  const names = new Set();
  for (const m of readText('lib/engine/suite.js').matchAll(/^\s{2}entry\('([a-z_]+)'/gm)) names.add(m[1]);
  return names;
}

// ── 冻结名单（`test/tools.test.js` 的 `TOOL_NAMES`；只读，C-4 禁改它）──────────────
function frozenToolNames() {
  const m = readText('test/tools.test.js').match(/const TOOL_NAMES\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(m, 'test/tools.test.js 须含 `const TOOL_NAMES = [...]`（冻结名单的定义点）');
  return new Set([...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
}

// ── ledger 解析：按「表头同时含 `工具名` 与 `处置`」定位表（不写死节号/列位置）──────
function splitRowCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  return trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function ledgerRows() {
  const lines = readText(LEDGER).split(/\r?\n/);
  let headerAt = -1;
  let header = null;
  for (let i = 0; i < lines.length; i++) {
    const cells = splitRowCells(lines[i]);
    if (cells && cells.includes('工具名') && cells.includes('处置')) { headerAt = i; header = cells; break; }
  }
  assert.ok(
    headerAt >= 0,
    'ledger 的 §2 逐名表头（同时含「工具名」与「处置」两列）缺失 ⇒ 待 e1 按任务包 §2.2 重排权威账后复查',
  );
  const rows = new Map();
  for (let i = headerAt + 1; i < lines.length; i++) {
    const cells = splitRowCells(lines[i]);
    if (!cells) { if (rows.size > 0) break; continue; } // 表体结束
    const name = (cells[0] ?? '').replace(/[`*]/g, '').trim();
    if (!/^[a-z][a-z_0-9]*$/.test(name)) continue; // 跳过 `|---|` 分隔行与说明行
    rows.set(name, { cells, header });
  }
  return rows;
}

function cellOf(row, label) {
  const idx = row.header.findIndex((c) => c.includes(label));
  return idx < 0 ? null : (row.cells[idx] ?? '');
}

// ── 护栏资产（只读 JSON；C-2 禁改它）────────────────────────────────────────────
function guardRules() {
  return readJson(GUARD_ASSET).toolBan ?? [];
}

// ── `CONTROL_PLANE_TOOLS`（D-3 的文件级事实，只读；C-11 禁改 lib）───────────────
function controlPlaneTools() {
  const m = readText('lib/verify/evidence.js').match(/CONTROL_PLANE_TOOLS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(m, 'lib/verify/evidence.js 须含 `CONTROL_PLANE_TOOLS = new Set([...])` 定义');
  return new Set([...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
}

// ── `diffToolFace` 载入（AC-7 的可复用前提）────────────────────────────────────
async function loadDiffToolFace() {
  const file = path.join(ROOT, DIFF_SCRIPT);
  assert.ok(
    fs.existsSync(file),
    DIFF_SCRIPT + ' 不在盘 ⇒ 四类必测①/口径交叉核对待 e1 落脚本后复查（AC-7 / AC-16①）',
  );
  const mod = await import(pathToFileURL(file).href);
  assert.equal(typeof mod.diffToolFace, 'function', 'AC-7：脚本须导出纯函数 `diffToolFace`');
  return mod.diffToolFace;
}

// ═════════════════════════════════════════════════════════════════════════════
// AC-7：脚本可复用 —— 导出 `diffToolFace` 且 import **不执行 CLI**
// ═════════════════════════════════════════════════════════════════════════════
test('AC-7 脚本可复用：导出 diffToolFace，且 import 该脚本不产生任何 CLI 输出', () => {
  const file = path.join(ROOT, DIFF_SCRIPT);
  assert.ok(fs.existsSync(file), DIFF_SCRIPT + ' 不在盘 ⇒ 待 e1 落脚本后复查');

  const probe = [
    'import(' + JSON.stringify(pathToFileURL(file).href) + ').then((m) => {',
    '  if (typeof m.diffToolFace !== "function") { console.error("MISSING_EXPORT"); process.exit(3); }',
    '}).catch((e) => { console.error("IMPORT_FAILED: " + e.message); process.exit(4); });',
  ].join('\n');

  let stdout;
  try {
    stdout = execFileSync(process.execPath, ['-e', probe], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    assert.fail('import 探针非零退出（import 即执行 CLI / 未导出 diffToolFace）：' + (err.stderr || err.message));
  }
  assert.equal(stdout, '', 'AC-7：import 该脚本不得产生 stdout（import 即执行 CLI ⇒ 必红）');
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-6 / AC-16①：双向差集空（两种投影各一次；判定复用 diffToolFace，C-13）
// ═════════════════════════════════════════════════════════════════════════════
test('AC-6/AC-16① 双向差集空：current 与 after-delete 两投影 ok，forward = 基线集合、backward = ∅', async () => {
  const diffToolFace = await loadDiffToolFace();

  for (const project of ['current', 'after-delete']) {
    const res = diffToolFace(project);
    assert.equal(res.ok, true, `投影 ${project}：两向差集须同时合格（ok=true）`);
    assert.equal(res.checks.D1, true, `投影 ${project}：D1 (S1∖S2) 须集合相等`);
    assert.equal(res.checks.D2, true, `投影 ${project}：D2 (S2∖S1) 须为空集`);
    assert.equal(res.checks.D3, true, `投影 ${project}：D3 B 须集合等于冻结名单 TOOL_NAMES`);

    // 直接用脚本暴露的 s1/s2 交叉核（不重算抽取，只重算集合关系）
    const s1 = new Set(res.s1);
    const s2 = new Set(res.s2);
    const forward = new Set([...s1].filter((n) => !s2.has(n)));
    const backward = new Set([...s2].filter((n) => !s1.has(n)));
    assert.deepEqual(forward, new Set(SUITE_ONLY_BASELINE), `投影 ${project}：(S1∖S2) 须恰为 8 名基线集合`);
    assert.deepEqual(backward, new Set(), `投影 ${project}：(S2∖S1) 须为空集`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-16②：口径一致性 —— ledger ↔ 源码 双向存在性
// ═════════════════════════════════════════════════════════════════════════════
test('AC-16② 口径一致性：S1 ∖ ledger = ∅；且 ledger 每名可溯源到源码或标「非工具」', () => {
  const s1 = sourceToolNames();
  const rows = ledgerRows();

  const missingRows = [...s1].filter((name) => !rows.has(name));
  assert.deepEqual(missingRows, [], 'S1（源码全集）中未在 ledger 逐名表立行的工具名');

  const untraceable = [...rows.keys()].filter((name) => {
    if (s1.has(name)) return false;
    const disposition = cellOf(rows.get(name), '处置');
    return !(disposition && disposition.includes('非工具'));
  });
  assert.deepEqual(
    untraceable, [],
    'ledger 中既未出现在 `lib/engine/suite.js` 的 entry(...) 里、也未把处置标为「非工具」的名字',
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-16③：删除面 —— 5 名处置 = 删，且不在「保留」集
// ═════════════════════════════════════════════════════════════════════════════
test('AC-16③ 删除面：5 个已裁删除名在 ledger 处置为「删」且不属于保留集', () => {
  const rows = ledgerRows();
  for (const name of DELETED_5) {
    assert.ok(rows.has(name), `已裁删除名须在 ledger 逐名表有行 ⇒ ${name}`);
    const disposition = cellOf(rows.get(name), '处置');
    assert.ok(disposition !== null, `ledger 逐名表须有「处置」列 ⇒ ${name}`);
    assert.ok(disposition.includes('删'), `处置须为「删」⇒ ${name}（实际="${disposition}"）`);
    assert.equal(/保留/.test(disposition), false, `处置不得同时含「保留」⇒ ${name}（实际="${disposition}"）`);
  }

  const kept = new Set(
    [...rows.entries()].filter(([, row]) => /保留/.test(cellOf(row, '处置') ?? '')).map(([name]) => name),
  );
  assert.deepEqual([...DELETED_5].filter((n) => kept.has(n)), [], 'DELETED_5 ∩ 保留集 必须为空');
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-12 / AC-16④：护栏面三条（任务包 §2.9 修正版；**不是**「两集合无交集」）
// ═════════════════════════════════════════════════════════════════════════════
test('AC-12/AC-16④-1 护栏①：rule id 集合与工具名集合正交（交集 = ∅）', () => {
  const ruleIds = new Set(guardRules().map((r) => r.id));
  const toolNames = new Set([...sourceToolNames(), ...frozenToolNames()]);
  assert.deepEqual(
    [...ruleIds].filter((id) => toolNames.has(id)), [],
    '护栏 rule id 与工具名集合（S1 ∪ 冻结名单）交集须为空',
  );
});

test('AC-12/AC-16④-2 护栏②：sleep 三条的工具 = {pwsh,bash,ops_bash}，且三者不属源码全集', () => {
  const byId = new Map(guardRules().map((r) => [r.id, r]));
  for (const id of ['L5-W02', 'L5-W03', 'L5-W04']) assert.ok(byId.has(id), `护栏资产须含 ${id}`);

  const sleepTools = new Set(['L5-W02', 'L5-W03', 'L5-W04'].map((id) => byId.get(id).tool));
  assert.deepEqual(sleepTools, new Set(['pwsh', 'bash', 'ops_bash']), 'sleep 三条规则绑定的工具集合');
  assert.equal(byId.get('L5-W04').tool, 'ops_bash', 'L5-W04 须逐条断言绑定 `ops_bash`');

  const s1 = sourceToolNames();
  assert.deepEqual([...sleepTools].filter((t) => s1.has(t)), [], 'sleep 三条的工具不得属源码全集 S1（39 名）');
});

test('AC-12/AC-16④-3 护栏③：护栏资产 sha256 与本批开工时一致（本批只读它，C-2）', () => {
  assert.equal(
    sha256Of(GUARD_ASSET), GUARD_ASSET_SHA_AT_START,
    GUARD_ASSET + ' 的 sha256 变动 ⇒ 违反 C-2（本批只同步文档，不改护栏资产）',
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-17：D-3 的事实面 —— `CONTROL_PLANE_TOOLS ∩ DELETED_5` 逐名（名字出现点 ≠ 注册点）
// ═════════════════════════════════════════════════════════════════════════════
test('AC-17 CONTROL_PLANE_TOOLS ∩ DELETED_5 = 4 名（lane_longrun 不在其中）', () => {
  const controlPlane = controlPlaneTools();
  const hit = DELETED_5.filter((name) => controlPlane.has(name));
  // 这是**事实钉**：删除落地批必须同步该名单；本批禁改 lib（C-11）⇒ 只登记，不改。
  assert.deepEqual(
    new Set(hit), new Set(['mailbox_send', 'mailbox_read', 'mailbox_ack', 'lane_heartbeat']),
    'lib/verify/evidence.js 的 CONTROL_PLANE_TOOLS 与 DELETED_5 的交集（逐名）',
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 交叉核对：本文件独立复算的 S1 vs 脚本暴露的 s1（不一致 ⇒ 口径分叉，属缺陷）
// ═════════════════════════════════════════════════════════════════════════════
test('口径交叉核对：diffToolFace().s1 与源码正则复算的 S1 集合相等', async () => {
  const diffToolFace = await loadDiffToolFace();
  const fromScript = new Set(diffToolFace('current').s1);
  const fromSource = sourceToolNames();
  assert.deepEqual(fromScript, fromSource, '脚本抽取的 S1 与任务包 §2.4 正则复算的 S1 须集合相等');
});
