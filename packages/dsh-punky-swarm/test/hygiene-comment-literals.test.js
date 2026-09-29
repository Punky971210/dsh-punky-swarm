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

// 归一化退役码守卫（批 `cleanup-settle-20260929` · lane `exec-hygiene` · 判据 G-1）：
//   **把匹配从「纯逐字 includes」升级为「剥离转义反斜杠后逐字比对」**。
//
// 动机（实测漏网，已复发 2 次）：退役码若以**转义变体**写进注释（正则源码形态：每个分隔符前带反斜杠），
//   旧锁的 `String.includes(code)` 返回 **false** ⇒ 锁仍绿，而退役码已写进注释 ⇒ **防回生有洞**。
//   实证漏网点（清障前）：`lib/panel/panel-model.js` 与其拼装产物 `lib/client.js` 各 1 处。
//
// 口径（判据源 `## 需求` §一）：
//   · 扫描面 = `lib/**` 递归，只收 `*.js` / `*.ts`，排除 `*.d.ts` / `node_modules` / `.tsbuild`（与旧锁同口径）；
//   · 码表 = **只读解析** `test/retired-codes-lock.test.js` 的 `RETIRED_CODES`（**唯一真源**；
//     不另立第二份码表 —— 判据 D-10）；解析失败或条数异常即 fail（防「静默空表」假绿）；
//   · 归一化 = 剥离「紧邻 `.` / `-` / `/` 的转义反斜杠」⇒ 转义变体回落为逐字形态后比对；
//   · 断言 = 命中数 **= 0**（**断言**，非 warn）。
//
// ⚠ 本文件自身位于 `test/**`（**不在**扫描面内）⇒ 其中出现码值示例不影响守卫。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCK_REL = join('test', 'retired-codes-lock.test.js');

/** 只读解析锁用例的 `RETIRED_CODES`（跳过 `//` 注释行，仅取数组块内的单引号字面量）。 */
function retiredCodesOf(lockPath) {
  const text = readFileSync(lockPath, 'utf8');
  const start = text.indexOf('const RETIRED_CODES = [');
  assert.ok(start >= 0, '未能定位 RETIRED_CODES（锁用例结构已变）');
  const end = text.indexOf('];', start);
  assert.ok(end > start, 'RETIRED_CODES 数组未闭合（锁用例结构已变）');
  const block = text.slice(start, end);
  const out = [];
  for (const line of block.split('\n')) {
    if (line.trim().startsWith('//')) continue;
    for (const m of line.matchAll(/'([^']*)'/g)) out.push(m[1]);
  }
  return out;
}

/** 扫描面（与 `retired-codes-lock.test.js` 的 `libSources` 同口径）。 */
function libSources(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.tsbuild') continue;
      libSources(p, out);
    } else if (/\.(js|ts)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** 转义归一化：剥离「紧邻 `.` / `-` / `/` 的反斜杠」⇒ 转义变体回落为逐字形态。 */
function unescapeSeparators(text) {
  return text.replace(/\\(?=[.\-/])/g, '');
}

test('归一化退役码守卫：lib/** 内退役码（含转义变体）命中数 = 0', () => {
  const codes = retiredCodesOf(join(process.cwd(), LOCK_REL));
  assert.ok(codes.length >= 30, '码表解析异常（应 ≥30 条）：' + codes.length);
  const sources = libSources(join(process.cwd(), 'lib'));
  assert.ok(sources.length > 100, 'lib 源文件扫描面异常（应 >100 件）：' + sources.length);

  const normalized = sources.map((f) => ({ f, t: unescapeSeparators(readFileSync(f, 'utf8')) }));
  const hits = [];
  for (const code of codes) {
    for (const { f, t } of normalized) {
      if (t.includes(code)) hits.push(code + ' @ ' + f);
    }
  }
  assert.equal(
    hits.length, 0,
    '退役码（含**转义变体**）不得出现在 lib/**（含注释）—— 命中 ' + hits.length + ' 处：\n  ' + hits.join('\n  '),
  );
});
