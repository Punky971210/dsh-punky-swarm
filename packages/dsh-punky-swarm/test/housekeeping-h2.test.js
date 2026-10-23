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

// 内务批 `punky-housekeeping-20261023` · lane c2 · H-2 用例面：**工具总数不得写死在注释里**。
//
// 存在理由：`lib/tools/register.js` 的 `createLogTools` 注册行曾把三档工具计数写死在注释里
//   （裸配置 / patch 全开 / 显式关），而实测早已漂到别的数（差集仍恰 = `log_export`）。
//   把「会变的读数」当常量写进注释 ⇒ 每加一个工具就多一处必然过期的事实源
//   （同族注释已留下 14→23→…→31 的改数史，见 `test/tool-descriptor.test.js`）。
//
// 本件守两条：
//   ① **不写死**：该注释块不出现「裸配置 / patch 全开 / 显式关 + 数字」的计数形态
//      （含**反向构造**：同一正则对修前原文必命中 ⇒ 证明判据不是恒真）；
//   ② **语义不丢**：块内保留 `log_export` 与「差集」语义，并指向真源常量（冒烟 H-03 / `checks-k.mjs`）。
//
// 口径：**只读静态断言**——读源码文本，不装载引擎、不 spawn 子进程、零副作用。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REGISTER_REL = 'lib/tools/register.js';
const CHECKS_K_REL = 'scripts/smoke/lib/checks-k.mjs';

/** 计数形态正则（AC-H2-1 的判据本体）：三档计数的名词 + 12 字以内的数字。 */
const COUNT_PATTERN = /(裸配置|patch 全开|显式关)[^\n]{0,12}\d+/;

/**
 * ⚠ 本串是**反向构造夹具**（修前注释的片段），不是任何读数来源——故意保留原始形态，
 * 用来证明 COUNT_PATTERN 真的能抓「写死计数」这件事（判据不得是恒真）。
 */
const LEGACY_COUNT_SNIPPET = '实测工具总数：裸配置 20 / patch 全开 21 / 显式关（worktree+watch 关）14';

/** 取出 `createLogTools` 注册行及其紧随的连续 `//` 注释行 = H-2 的注释块。 */
function readLogToolsCommentBlock() {
  const lines = fs.readFileSync(path.join(ROOT, REGISTER_REL), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.includes('createLogTools(ctx, deps)'));
  assert.ok(start >= 0, `${REGISTER_REL} 必须仍含 createLogTools 注册行（本项定位锚点）`);
  const block = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (!lines[i].trim().startsWith('//')) break;
    block.push(lines[i]);
  }
  return { code: lines[start], block, text: block.join('\n') };
}

test('h2-1 不写死：注册注释块不出现「裸配置 / patch 全开 / 显式关 + 计数」形态', () => {
  const { text } = readLogToolsCommentBlock();
  const hit = text.match(COUNT_PATTERN);
  assert.equal(hit, null, `注释块不得写死工具计数（命中：${hit ? hit[0] : ''}）`);
});

test('h2-2 反向构造：同一正则对修前原文必命中（判据不得是恒真）', () => {
  assert.ok(COUNT_PATTERN.test(LEGACY_COUNT_SNIPPET), '修前形态（三档计数 + 数字）必须被同一正则抓到');
  assert.equal(LEGACY_COUNT_SNIPPET.match(COUNT_PATTERN)?.[0], '裸配置 20', '命中片段可读（供失败信息点名；同一串里三档计数都会被抓到）');
});

test('h2-3 语义不丢：块内保留 log_export / 差集 / 勿写死 与真源指针，注册行代码逐字未变', () => {
  const { code, text } = readLogToolsCommentBlock();
  assert.ok(text.includes('log_export'), '块内必须仍含 log_export（差集的那一个工具名）');
  assert.ok(text.includes('差集'), '块内必须仍含「差集」语义判据');
  assert.ok(text.includes('勿在此写死'), '块内必须写明「工具数随工具面与配置而变，勿在此写死」');
  assert.ok(text.includes('EXPECTED_TOOLS_BARE'), '块内必须指向真源常量 EXPECTED_TOOLS_BARE');
  assert.ok(text.includes('EXPECTED_TOOLS_FULL'), '块内必须指向真源常量 EXPECTED_TOOLS_FULL');
  assert.ok(text.includes('checks-k.mjs'), '块内必须点名真源文件（scripts/smoke/lib/checks-k.mjs）');
  assert.equal(code.trim().startsWith('...createLogTools(ctx, deps),'), true, '注册语句本身逐字未变（本项只改注释）');
  assert.ok(code.includes("readCapability(config,'logs')"), '注册门控说明仍在（logs 默认关 ⇒ 缺省不注册）');
});

test('h2-4 真源自洽：冒烟 H-03 仍以常量给出两档工具数，且差集断言点名 log_export', () => {
  const src = fs.readFileSync(path.join(ROOT, CHECKS_K_REL), 'utf8');
  const bare = src.match(/EXPECTED_TOOLS_BARE\s*=\s*(\d+)/);
  const full = src.match(/EXPECTED_TOOLS_FULL\s*=\s*(\d+)/);
  assert.ok(bare, `${CHECKS_K_REL} 必须仍声明 EXPECTED_TOOLS_BARE（本注释指向的真源）`);
  assert.ok(full, `${CHECKS_K_REL} 必须仍声明 EXPECTED_TOOLS_FULL`);
  assert.equal(Number(full[1]) - Number(bare[1]), 1, '两档差 1 = 差集恰为 1 个工具（注释语义的数值推论，不写死绝对值）');
  assert.ok(src.includes('onlyFull'), 'H-03 仍用 onlyFull 作差集变量');
  assert.ok(src.includes("onlyFull[0] === 'log_export'"), "H-03 的差集断言仍点名 log_export（证明该开关是真开关）");
});
