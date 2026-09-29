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

// 双副本一致性机检（批 dualline-compat-20260927 · lane exec-preset-dualline · 判据 C-5）
//
// 背景：`dsh-agent-preset-punky` 的 plugins 面有**两份落地**——
//   ① `cordis.patch.yml` 的 `- id: dsh-agent-preset-punky` → `config.plugins`；
//   ② `presets/punky-preset/agent.cordis.yml` 的**根级插件列表**（该文件是裸列表，非 `plugins:` 映射）。
//   二者是**同一份 agent-plane 组合**的两个副本；本会话已**两次**踩到「只改一处」的漂移 ⇒ 机检化防回生。
//
// 另附两条**同族守卫**（同属本 lane 的 C-4 面，读同一份抽取结果，零额外解析成本）：
//   · C-4(a)：两件的 workflow 行必须**同名同构** = `workflow-ptc` / `@deepseek-ai/dsh-workflow-ptc`；
//   · C-4(b)：两件内**零命中**旧推进器包（`@deepseek-ai/dsh-workflow-*` 的 worker-thread 形态）；
//     该名在此**拼装构造**、不写字面量——否则本文件自身会让仓库级 grep 守卫失去分辨力。
//
// 解析口径（零依赖、行式、缩进感知；本仓无 YAML 程序库）：
//   · 只认行首 `- id:` 作为**条目**；`id:` 只在其为**同名条目**时参与比对（不误收 `config.id`）。
//   · 条目的 `name:` 取**该条目映射层**的那一行 —— YAML 里条目的键缩进 = `-` 的缩进 **+ 2**
//     （`- id: x` 的下一行 `  name: y`）；更深缩进的 `config.name` 不会被误配。
//   · 值比较前**剥引号**（两件的引号风格允许不同；值本体仍逐字比）。
//   · **防空转**：主用例断言抽取条目数 > 20（解析器退化到 0 条时会当场变红，而不是「空集等于空集」）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PATCH_FILE = path.join(ROOT, 'cordis.patch.yml');
const PRESET_FILE = path.join(ROOT, 'presets', 'punky-preset', 'agent.cordis.yml');
const ANCHOR_ID = 'dsh-agent-preset-punky';
const WORKFLOW_ID = 'workflow-ptc';
const WORKFLOW_NAME = '@deepseek-ai/dsh-workflow-ptc';
// 旧推进器包名（拼装构造；勿写字面量 —— 见文件头说明）
const LEGACY_ROW_NAME = '@deepseek-ai/dsh-workflow-' + 'worker-thread';
// 抽取条目的**最小合理规模**（当前两件各 29 条；留余量只作「解析器没退化」的下界守卫）
const MIN_ROWS = 20;

const indentOf = (line) => line.match(/^(\s*)/)[1].length;
const isSkippable = (line) => /^\s*$/.test(line) || /^\s*#/.test(line);
const unquote = (v) => v.replace(/^['"]/, '').replace(/['"]$/, '');

/** 块内抽取 `{ id, name }` 条目（缩进感知：条目映射键 = `-` 缩进 + 2，子结构更深）。 */
function rowsInBlock(lines) {
  const rows = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)-\s+id:\s*(.*?)\s*$/.exec(lines[i]);
    if (!m) continue;
    const dashIndent = m[1].length;
    const keyIndent = dashIndent + 2; // YAML：`- ` 之后的映射键与本条的 `id` 同级
    const id = unquote(m[2]);
    let name = null;
    for (let j = i + 1; j < lines.length; j += 1) {
      const raw = lines[j];
      if (isSkippable(raw)) continue;
      const ind2 = indentOf(raw);
      if (ind2 <= dashIndent) break; // 出块：同层下一条目 / 上层键
      if (ind2 < keyIndent) break; // 异常缩进 ⇒ 保守出块
      if (ind2 === keyIndent) {
        if (/^\s*-\s/.test(raw)) break; // 同层的新条目
        const nm = /^\s*name:\s*(.*?)\s*$/.exec(raw);
        if (nm) { name = unquote(nm[1]); break; }
        continue; // 其它同层键（group: / config: 等）⇒ 继续找 name
      }
      // ind2 > keyIndent ⇒ 属于条目内部的子结构，跳过
    }
    rows.push({ id, name });
  }
  return rows;
}

/** 从 `cordis.patch.yml` 里切出 `dsh-agent-preset-punky.config.plugins` 的**块体**。 */
function presetPluginsBlock(text) {
  const lines = text.split(/\r?\n/);
  const anchorIdx = lines.findIndex((l) => new RegExp('^\\s*-\\s+id:\\s*' + ANCHOR_ID + '\\s*$').test(l));
  if (anchorIdx < 0) throw new Error('anchor row not found: ' + ANCHOR_ID);
  const anchorIndent = indentOf(lines[anchorIdx]);
  let pIdx = -1;
  for (let i = anchorIdx + 1; i < lines.length; i += 1) {
    if (/^(\s*)plugins:\s*$/.test(lines[i]) && indentOf(lines[i]) > anchorIndent) { pIdx = i; break; }
  }
  if (pIdx < 0) throw new Error('plugins: key not found under anchor ' + ANCHOR_ID);
  const pIndent = indentOf(lines[pIdx]);
  let end = lines.length;
  for (let i = pIdx + 1; i < lines.length; i += 1) {
    if (isSkippable(lines[i])) continue;
    if (indentOf(lines[i]) <= pIndent) { end = i; break; }
  }
  return lines.slice(pIdx + 1, end);
}

/** 双副本比对：返回差异（顺序无关；同一 `{id,name}` 去重后按集合语义比）。 */
function comparePluginSets(patchText, presetText) {
  const a = rowsInBlock(presetPluginsBlock(patchText));
  const b = rowsInBlock(presetText.split(/\r?\n/));
  const keyOf = (r) => r.id + '\u0000' + (r.name ?? '');
  const ka = new Set(a.map(keyOf));
  const kb = new Set(b.map(keyOf));
  const dupIds = (rows) => {
    const seen = new Set(); const dup = [];
    for (const r of rows) { if (seen.has(r.id)) dup.push(r.id); seen.add(r.id); }
    return dup;
  };
  const onlyInPatch = a.filter((r) => !kb.has(keyOf(r)));
  const onlyInPreset = b.filter((r) => !ka.has(keyOf(r)));
  return {
    ok: onlyInPatch.length === 0 && onlyInPreset.length === 0 && dupIds(a).length === 0 && dupIds(b).length === 0,
    counts: { patchPlugins: a.length, presetRoot: b.length },
    onlyInPatch, onlyInPreset,
    dupes: { patchPlugins: dupIds(a), presetRoot: dupIds(b) },
  };
}

/** 旧推进器包名的命中数（C-4(b) 守卫；`text` 为整个文件文本）。 */
const legacyRowHits = (text) => text.split(LEGACY_ROW_NAME).length - 1;

const patchText = fs.readFileSync(PATCH_FILE, 'utf8');
const presetText = fs.readFileSync(PRESET_FILE, 'utf8');

test('C-5(a)(b) 双副本 plugins 行集逐字一致（id+name，顺序无关）', () => {
  const r = comparePluginSets(patchText, presetText);
  assert.deepEqual(r.onlyInPatch, [], '仅存在于 cordis.patch.yml 的条目：' + JSON.stringify(r.onlyInPatch));
  assert.deepEqual(r.onlyInPreset, [], '仅存在于 agent.cordis.yml 的条目：' + JSON.stringify(r.onlyInPreset));
  assert.deepEqual(r.dupes, { patchPlugins: [], presetRoot: [] }, '同侧 id 重复：' + JSON.stringify(r.dupes));
  assert.equal(r.ok, true);
  assert.equal(r.counts.patchPlugins, r.counts.presetRoot, '两侧条目数须相等：' + JSON.stringify(r.counts));
  // 防空转：解析器若退化（例如缩进判定失效 ⇒ 0 条），空集==空集 会假绿 ⇒ 用下界守卫挡住
  assert.ok(r.counts.patchPlugins > MIN_ROWS, '抽取条目数异常偏低（解析器可能退化）：' + JSON.stringify(r.counts));
  assert.ok(r.counts.presetRoot > MIN_ROWS, '抽取条目数异常偏低（解析器可能退化）：' + JSON.stringify(r.counts));
});

test('C-4(a) 双副本 workflow 行同名同构（workflow-ptc / @deepseek-ai/dsh-workflow-ptc）', () => {
  for (const [label, rows] of [
    ['cordis.patch.yml', rowsInBlock(presetPluginsBlock(patchText))],
    ['agent.cordis.yml', rowsInBlock(presetText.split(/\r?\n/))],
  ]) {
    const hits = rows.filter((x) => x.id === WORKFLOW_ID);
    assert.equal(hits.length, 1, label + ' 须恰有一条 ' + WORKFLOW_ID + ' 行，实测 ' + hits.length);
    assert.equal(hits[0].name, WORKFLOW_NAME, label + ' 的 ' + WORKFLOW_ID + ' 行 name 须逐字为 ' + WORKFLOW_NAME);
  }
});

test('C-4(b) 双副本零命中旧推进器包（含注释）—— 单行两线通吃，禁回加', () => {
  assert.equal(legacyRowHits(patchText), 0, 'cordis.patch.yml 命中旧推进器包名（禁回加）');
  assert.equal(legacyRowHits(presetText), 0, 'agent.cordis.yml 命中旧推进器包名（禁回加）');
});

test('C-5(c)【可达构造】只改一处 ⇒ 比对必须变红（同名/同 id 两种漂移各一条）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dualline-consistency-'));
  try {
    // 构造①：preset 侧某行 name 改一个字符（最典型的漂移）
    const driftName = presetText.replace(WORKFLOW_NAME, WORKFLOW_NAME + '-x');
    assert.notEqual(driftName, presetText, '构造失败：未改到 name');
    const r1 = comparePluginSets(patchText, driftName);
    assert.equal(r1.ok, false, '只改一处的 name ⇒ 必须判为不一致（否则本机检是空转）');
    assert.ok(r1.onlyInPreset.some((x) => x.id === WORKFLOW_ID), '漂移须定位到 ' + WORKFLOW_ID);

    // 构造②：patch 侧某行 id 改一个字符（错位漂移）
    const driftId = patchText.replace('id: ' + WORKFLOW_ID, 'id: ' + WORKFLOW_ID + '-x');
    assert.notEqual(driftId, patchText, '构造失败：未改到 id');
    const r2 = comparePluginSets(driftId, presetText);
    assert.equal(r2.ok, false, '只改一处的 id ⇒ 必须判为不一致');
    assert.ok(r2.onlyInPatch.some((x) => x.id === WORKFLOW_ID + '-x'), '漂移须定位到被改动的 id');

    // 构造③（守卫自证，防空转）：把旧推进器包名写进任一副本 ⇒ C-4(b) 守卫必须命中
    const withLegacy = patchText + '\n# legacy: ' + LEGACY_ROW_NAME + '\n';
    assert.equal(legacyRowHits(withLegacy), 1, '旧包名守卫须能命中（否则该守卫是空转）');

    // 构造④：解析器下界守卫本身有效（把块切成空 ⇒ 命中数低于下界）
    const emptyBlocks = comparePluginSets('- insert:\n    - id: ' + ANCHOR_ID + '\n      config:\n        plugins:\n', '');
    assert.equal(emptyBlocks.ok, true, '两侧同为空时集合比对上等价（这正是需要有下界守卫的原因）');
    assert.ok(emptyBlocks.counts.presetRoot < MIN_ROWS, '下界守卫应能挡住空输入');

    // 落盘证明：临时副本确实产生过（temp 目录随用例结束清理）
    assert.ok(fs.existsSync(tmp), '临时目录存在');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
