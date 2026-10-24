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

// 判据 ②b（注入面**每一条目**必须有正文小节）的**牙**（2026-10-24 批 `punky-iter-a-20261024`｜pack1｜Q-A + Q-H）。
//
// 为什么需要本文件：判据 ②b 与既有 ①③ 的差别只在「无指针时也判」，改前态**本来就是红的**
//   （0i/0s/0t 在注入面在册、正文无节）⇒ 只跑真仓态拿到 GREEN，无法证明「判据真的会红」。
//   故必须有**必失败构造**（N1）与**同输入阳性对照**（N2）；没有 N2，N1 的红不可证伪（可能是环境/路径问题）。
//
// 口径纪律（K-7 / F-6 复用既有能力）：
//   **不在本文件重建解析器**——判据的唯一实现是 `scripts/check-guidance-sync.mjs`。
//   做法 = 把**脚本本体**与两件输入（注入面 + 正文）复制进临时目录，让脚本按自身 ROOT 推导去判**副本**，
//   于是「判据实现」永远只有一份，测的是真脚本、不是测的替身。
//
// 三例：
//   N1 必失败：副本内删掉 `## §0t …` 的 `## ` 前缀 ⇒ 必 `exit 1`，`forward-id` **恰 1 条**且 detail 含 `0t`
//   N2 正例对照：**同一副本不删任何节** ⇒ `exit 0`（证明 N1 的红来自删除动作，不是环境）
//   N3 全域覆盖：真仓态 ⇒ `forward-id` 失败数 = 0、`inlineEntries` = 27、`bodySections` = 32
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const SCRIPT = join(PKG_ROOT, 'scripts', 'check-guidance-sync.mjs');
const PRESET = join(PKG_ROOT, 'presets', 'punky-preset');
const GUIDANCE = join(PRESET, 'agent.cordis.yml');
const BODY = join(PRESET, 'references', 'discipline.md');

const INLINE_ENTRIES = 27;
const BODY_SECTIONS = 32;

/** 跑一次判据脚本（`--no-live`：不依赖 live 部署，CI/新机同结论）。返回 `{status, stdout, stderr, json}`。 */
function judgeRepo(scriptPath, cwd) {
  const r = spawnSync(process.execPath, [scriptPath, '--no-live', '--json'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* 解析失败由调用方按 stdout 断言 */ }
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json };
}

/** 只统计 `forward-id` 一族失败（判据 ②b 的专属载荷），供「恰 N 条」类断言使用。 */
const forwardIdFailuresOf = (json) => (json?.failures ?? []).filter((f) => f.check === 'forward-id');

/**
 * 造一份**可判的临时副本**：脚本按 `<副本根>/scripts` 推导 ROOT ⇒ 只需三件
 *   ① `scripts/check-guidance-sync.mjs`（真脚本本体）
 *   ② `presets/punky-preset/agent.cordis.yml`（注入面）
 *   ③ `presets/punky-preset/references/discipline.md`（正文，可选被改写）
 * `mutateBody(text)` 返回替换后的正文（`null` = 不改）。
 */
function makeTempJudgedTree(mutateBody) {
  const root = mkdtempSync(join(tmpdir(), 'guidance-id-coverage-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'presets', 'punky-preset', 'references'), { recursive: true });
  copyFileSync(SCRIPT, join(root, 'scripts', 'check-guidance-sync.mjs'));
  copyFileSync(GUIDANCE, join(root, 'presets', 'punky-preset', 'agent.cordis.yml'));
  const bodyText = readFileSync(BODY, 'utf8');
  const nextBody = mutateBody ? mutateBody(bodyText) : bodyText;
  writeFileSync(join(root, 'presets', 'punky-preset', 'references', 'discipline.md'), nextBody, 'utf8');
  return { root, script: join(root, 'scripts', 'check-guidance-sync.mjs'), bodyText, nextBody };
}

// ── N3 全域覆盖（真仓态）────────────────────────────────────────────────────────

test('N3 真仓态：注入面每条目都有正文小节（forward-id 失败 = 0）', () => {
  const r = judgeRepo(SCRIPT, PKG_ROOT);
  assert.ok(r.json, `判据脚本输出不可解析为 JSON：${r.stdout}\n${r.stderr}`);
  const forwardId = forwardIdFailuresOf(r.json);
  assert.deepEqual(forwardId, [], `真仓态 forward-id 应为 0 条，实得 ${forwardId.length} 条：${JSON.stringify(forwardId)}`);
  assert.equal(r.json.inlineEntries, INLINE_ENTRIES, '注入面条目数应 = 27（R-06 订正后的实测值）');
  assert.equal(r.json.bodySections, BODY_SECTIONS, '正文 `## §` 小节数应 = 32（基线 29 + 新增 3）');
  assert.equal(r.status, 0, `真仓态判据应 exit 0，实得 ${r.status}；stderr=${r.stderr}`);
});

// ── N2 正例对照（同一副本、不删任何节）──────────────────────────────────────────

test('N2 正例对照：临时副本不删任何节 ⇒ exit 0', () => {
  const tree = makeTempJudgedTree(null);
  try {
    const r = judgeRepo(tree.script, tree.root);
    assert.ok(r.json, `判据脚本输出不可解析为 JSON：${r.stdout}\n${r.stderr}`);
    assert.equal(r.json.bodySections, BODY_SECTIONS, '副本应与真仓同形（32 节）');
    assert.equal(r.status, 0, `未删节的副本应 exit 0，实得 ${r.status}；stderr=${r.stderr}`);
    assert.deepEqual(forwardIdFailuresOf(r.json), [], '未删节的副本不应有 forward-id 失败');
  } finally {
    rmSync(tree.root, { recursive: true, force: true });
  }
});

// ── N1 必失败（判据的牙）──────────────────────────────────────────────────────

test('N1 必失败：删掉 `## §0t` 标题前缀 ⇒ exit 1 且 forward-id 恰 1 条命中 0t', () => {
  const tree = makeTempJudgedTree((text) => text.replace(/^## §0t /m, '§0t '));
  try {
    assert.notEqual(tree.nextBody, tree.bodyText, '构造失效：副本内没找到 `## §0t ` 标题行（判据对象已改名？）');
    const r = judgeRepo(tree.script, tree.root);
    assert.ok(r.json, `判据脚本输出不可解析为 JSON：${r.stdout}\n${r.stderr}`);
    assert.equal(r.status, 1, `删节后应 exit 1，实得 ${r.status}`);
    const forwardId = forwardIdFailuresOf(r.json);
    assert.equal(forwardId.length, 1, `应恰 1 条 forward-id 失败，实得 ${forwardId.length} 条：${JSON.stringify(forwardId)}`);
    assert.match(forwardId[0].detail, /0t/, `失败文案应点名 0t，实得：${forwardId[0].detail}`);
    assert.equal(forwardId[0].detail, '注入面 0t 无正文小节 §0t', '失败载荷形制应与其他判据同款 `{check, detail}`');
    assert.equal(r.json.bodySections, BODY_SECTIONS - 1, '删掉一节后正文小节数应 −1');
  } finally {
    rmSync(tree.root, { recursive: true, force: true });
  }
});
