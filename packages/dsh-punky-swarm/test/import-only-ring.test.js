/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/import-only-ring.test.js —— **S-2 环收敛**：`query-tools` 必须**直接 import 真源**，不得再经转发单。
//
// ★ 本文件的核心不是「环没了」，而是 **判据层必须只看 import 行**：
//   本批已三次被**注释污染**（`e2` 目录级脚本把 `query-tools.js` 误报为仍引用——因为解环注释里写了那个字符串；
//   `e1` 的 S-3 判据读到 `narrowVia ===` 2 次——全在自己新写的注释里）。
//   ⇒ 判据 = **解析 import 语句**（`^import … from '<spec>'`），**绝不全文匹配字样**。
//
// 跑法（必须带 preload）：node --import ./test/helpers/isolated-home.preload.mjs --test test/import-only-ring.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUERY_TOOLS = path.join(PKG, 'lib', 'tools', 'query-tools.js');

/**
 * 只抽取 **import 语句**里的模块 spec（静态 `import … from 'x'` ＋ `import 'x'` ＋ `export … from 'x'`）。
 * 注释、字符串字面量、普通代码里的同名文本**一律不计**（这是本判据的立身之本）。
 * @returns {string[]} 模块 spec 列表
 */
function importedSpecsOf(src) {
  const specs = [];
  for (const line of src.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    // 只认行首的 import/export-from（行内注释与普通代码不参与）
    if (!/^(import|export)\b/.test(trimmed)) continue;
    // 该行**最后一个**引号串就是模块 spec（`import 'p'` / `import … from 'p'` / `export … from 'p'` 三者同形）
    const quoted = [...trimmed.matchAll(/(['"])([^'"]+)\1/g)];
    if (quoted.length > 0) specs.push(quoted[quoted.length - 1][2]);
  }
  return specs;
}

const spec = fs.readFileSync(QUERY_TOOLS, 'utf8');
const specs = importedSpecsOf(spec);

test('S-2a 元用例（反向自检）：**只有注释里**出现目标字符串 ⇒ 判定必须为「否（未 import）」', () => {
  const sample = [
    "// 说明：本文件过去从 './host-surface.js' import handoffGateStateOf（现已直取真源）",
    '/* 块注释里也写一次：from "../wave-plan.js" */',
    "import { laneStateOf } from '../state/lane-state.js';",
    "const hint = \"from './host-surface.js'\"; // 字符串里出现也不算 import",
  ].join('\n');
  const got = importedSpecsOf(sample);
  assert.deepEqual(got, ['../state/lane-state.js'],
    '**注释/字符串里的同名文本必须不计**（本批已三次踩此坑）；实际解析=' + JSON.stringify(got));
  assert.equal(got.includes('./host-surface.js'), false, '注释里出现 ./host-surface.js 不得被判为 import');
  assert.equal(got.includes('../wave-plan.js'), false, '块注释里出现 ../wave-plan.js 不得被判为 import');
});

test('S-2b 真实文件：`query-tools` **直接 import 真源** `lib/state/lane-state.js`（阳性）', () => {
  assert.equal(specs.includes('../state/lane-state.js'), true,
    'query-tools 必须直接 import 真源（laneStateOf/isDanglingLane）；实际 imports=' + JSON.stringify(specs));
});

test('S-2c 真实文件：`query-tools` **不再**经转发单取 `laneStateOf`/`isDanglingLane`（只查 import 行）', () => {
  // 转发单 = 原先把 laneStateOf/isDanglingLane 再导出的那个入口。按 import 行判定：
  //   若任何 import 里同时出现这两个符号的**来源**是同一个非真源模块 ⇒ 仍是转发消费。
  const laneStateImporters = specs.filter((s) => !/state\/lane-state\.js$/.test(s) && /host-surface|shared|wave-plan/.test(s));
  // 这些模块仍可被 import（用于其它符号），**关键是 laneStateOf/isDanglingLane 不得从它们来**：
  for (const s of laneStateImporters) {
    const re = new RegExp('import\\s*\\{[^}]*\\b(laneStateOf|isDanglingLane)\\b[^}]*\\}\\s*from\\s*[\'"]' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\'"]');
    assert.equal(re.test(spec), false,
      'laneStateOf/isDanglingLane 不得从转发单 ' + s + ' 取（环的成因就是这条转发）');
  }
  // 正面证据：真源那行的 import 必须**真的带着这两个符号名**
  const realLine = spec.split(/\r?\n/).find((l) => /^import\b/.test(l.trimStart()) && l.includes('../state/lane-state.js'));
  assert.ok(realLine, '必须存在指向 ../state/lane-state.js 的 import 行');
  assert.match(realLine, /\blaneStateOf\b/, '真源 import 必须带 laneStateOf');
  assert.match(realLine, /\bisDanglingLane\b/, '真源 import 必须带 isDanglingLane');
});
