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

// 批 `punky-g2-tail-2026-10-30` · lane `t1-test`（tester）—— **T-4 / AC-9：`SETTLEABLE_STOP_REASONS` 口径三分**。
//
// 背景（包 §问题 T-4，实测）：原表述「全仓定义**恰 1 处**」**字面不成立** —— 实测 2 处：
//   · **手写源** = `lib/schema.ts` 的 `export const SETTLEABLE_STOP_REASONS = …`（1 处；**按内容定位，不锁行号**）
//   · **build 生成物** = `lib/schema.js`（1 处，由 `copy-ts-built` 回拷）
//   · （另有 `lib/schema.d.ts` 的 `export declare const` = **声明**，非定义）
// ⇒ 正确口径 = **三分**：手写源 1 ＋ 生成物**不计入**（但不得假装它不存在）＋ `auto-settle` 零本地副本。
//
// 【B2 驳回 blocking① 修复】本文件原先**冻结了 `lib/schema.ts:501` 这个行号**：B2 在 schema.ts 上方
//   净 +1 行注释（内容一字未变）就把 T4-a 打红 —— 行号是**位移**，不是语义。现改为**内容锚定**：
//   定位「定义语句本身」，断言 文件集 / 逐字内容 / 白名单值集 / 与 StopReason 的先后顺序；
//   行号只进**诊断**输出、不参与相等比较。判据单点实现见 `helpers/stop-reason-source.mjs`。
//
// 判据源 = `plan/p1-pack.md` §2.4 ＋ AC-9 ＋ C-7（**禁**用全仓单一总数混算 —— 那正是这条 AC 原字面失败的成因）。
// 写法纪律（C-12）：这里的「1 / 0」是**定义位计数（存在性）**，不是用例条数断言；每条分项**各自独立断言**。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  judgeSchemaSource, EXPECTED_DEFINITION_LINE,
} from './helpers/stop-reason-source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const NAME = 'SETTLEABLE_STOP_REASONS';

const absOf = (rel) => path.join(PKG_ROOT, ...rel.split('/'));
const readRel = (rel) => fs.readFileSync(absOf(rel), 'utf8');
const linesOf = (src) => src.split(/\r?\n/);

/** 递归收集 `lib/**` 下指定后缀的文件（相对路径，POSIX 分隔）。 */
function listLibFiles(suffix) {
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (p.endsWith(suffix)) out.push(path.relative(PKG_ROOT, p).split(path.sep).join('/'));
    }
  };
  walk(absOf('lib'));
  return out;
}

/** 某文件内「**定义位**」所在行号（`export const <NAME> =` / `const <NAME> =`）。 */
function definitionLines(src) {
  const re = new RegExp('(?:export\\s+)?const\\s+' + NAME + '\\s*=');
  return linesOf(src)
    .map((line, i) => ({ line: line.trim(), no: i + 1 }))
    .filter(({ line }) => re.test(line));
}

// ── ① AC-9 分项一：**手写源**（`lib/**/*.ts`）内定义位**恰 1 处** ────────────────────────────
//   口径：扫描面 = 手写 `.ts` 源（**不含** build 生成物 `.js` / 声明 `.d.ts`）⇒ 与生成物天然分离。
test('T4-b AC-9 分项③：auto-settle.js 本地副本 = 0（集合为空）且 import ≥1（单点真源）', () => {
  const src = readRel('lib/engine/auto-settle.js');

  const local = definitionLines(src);
  assert.deepEqual(local, [], 'AC-9 分项③：auto-settle.js **不得**保留本地副本（禁双真源）\n实际：\n'
    + local.map((h) => 'lib/engine/auto-settle.js:' + h.no + ' → ' + h.line).join('\n'));

  const importLines = linesOf(src).filter((line) => new RegExp('^import\\b[^;]*' + NAME).test(line.trim()));
  assert.ok(importLines.length >= 1, 'AC-9 分项③：auto-settle.js 必须 import 该常量（单点真源的另一半）；实际 import 行 = '
    + JSON.stringify(importLines));
  assert.ok(
    /from\s+['"][^'"]*schema\.js['"]/.test(importLines.join('\n')),
    'AC-9 分项③：`import` 须来自 `schema.js`（手写源 schema.ts 的回拷产物）；实际=' + JSON.stringify(importLines),
  );
});

// ── ② AC-9 分项二：**生成物明确排除**，但**必须写明它存在**（不得假装只有一处）────────────────────
//   本用例不断言「总数」，只断言「生成物那一处**确实在场**且**不参与分项①**」——
//   分项①的扫描面是 `.ts`，生成物是 `.js`，两者天然不混；此处把该事实**显式取证**下来，防"假装不存在"。