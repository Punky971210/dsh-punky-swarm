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

// 批 `punky-g2-adapter-2026-10-30` · lane `t1-verify`（tester）—— **契约面护栏**：
//   ① 泄漏面 ④ 端口纯类型 ③ 受控 build 快照比对 ＋ AC-11/AC-13 的机械判据。
//
// 判据源 = `plan/p2-pack-g2.md` §2.2（块一）／§2.4（受控 build 护栏）／§2.7（块四泄漏枚举）＋ `## 验收标准`：
//   · AC-3 三字段各 ≥1 · AC-4 零运行期 import · AC-5 `stopReason` 字段位 0 命中
//   · AC-9 build 护栏（快照 diff ⊆ 白名单、白名单外改动 = ∅）· AC-10 生成物纪律
//   · AC-11 `lib/bus/**` 全 `.js` · AC-13 三域只引用不复制 · AC-16 泄漏零命中
//
// 写法纪律（C-14）：**禁数量断言** —— 判据主体 = 集合相等 / 集合为空 / 匹配存在性 / 读文件内容。
//   **泄漏面一律用「读文件」断言**，不以外部 `grep` 的退出码当唯一依据（退出码会被转义/管道吃掉）。
//
// ⚠ 一条重要口径（包 §7.1 X-2）：**`L-6` 只查 `stopReason`**。
//   `retryNotBefore` 是 I-03 **要求必须在** `ports.ts` 的合规字段 —— 对它断言「零命中」会**假红**，
//   故本文件反过来**断言它必须在场**（把「合规字段」与「泄漏字段」区分开）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');

/** 快照真源 = **仓内 fixture**（`test/fixtures/<批次>/exec/`）：原默认按 `os.homedir()` 派生，
 *  而隔离 HOME 下家目录被重定向（`test/helpers/isolated-home.preload.mjs`）⇒ 原路径必不存在 ⇒ B1 恒红。
 *  仍可用 `PUNKY_G2_BATCH_ARTIFACTS` 覆盖取原件（与 `test/accept-pack1-guidance.test.js` 的同类夹具同形）。 */
const BATCH_ID = 'punky-g2-adapter-2026-10-30';
const ARTIFACTS_DIR = process.env.PUNKY_G2_BATCH_ARTIFACTS
  ?? path.join(PKG_ROOT, 'test', 'fixtures', BATCH_ID);

const absOf = (rel) => path.join(PKG_ROOT, ...rel.split('/'));
const readRel = (rel) => fs.readFileSync(absOf(rel), 'utf8');

/** 递归收集目录下所有文件（相对路径，POSIX 分隔）。 */
function listFiles(relDir) {
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      out.push(path.relative(PKG_ROOT, p).split(path.sep).join('/'));
    }
  };
  const abs = absOf(relDir);
  assert.ok(fs.existsSync(abs), relDir + ' 不存在（e2-bus 未交付？）');
  walk(abs);
  return out;
}

const LINES = (src) => src.split(/\r?\n/);

// ── ① AC-16 · 泄漏面：`agentTeams` / `ctx.get(` 在 ports.ts 与 lib/bus/** 零命中 ────────────
test('L1 泄漏面：agentTeams 与 ctx.get( 在 lib/ports.ts 与 lib/bus/** 各 0（读文件断言）', () => {
  const targets = ['lib/ports.ts', ...listFiles('lib/bus')];
  const hits = [];
  for (const rel of targets) {
    const src = readRel(rel);
    LINES(src).forEach((line, i) => {
      if (line.includes('agentTeams')) hits.push(rel + ':' + (i + 1) + ' → agentTeams');
      if (line.includes('ctx.get(')) hits.push(rel + ':' + (i + 1) + ' → ctx.get(');
    });
  }
  assert.deepEqual(hits, [], '泄漏面必须零命中（宿主专有服务名 / 宿主取值通道）\n实际：\n' + hits.join('\n'));
});

// ── ①-b AC-16 · L-1（宿主专有服务名硬编码）与 L-5（可选端口被当必需直用）───────────────
test('L2 L-1 / L-5 精确正则零命中：lib/bus/** 内不出现宿主服务名取值，也不裸取可选端口', () => {
  const targets = listFiles('lib/bus');
  const L1 = /ctx\.get\(\s*['"](agentTeams|agents|tools|webServer|subagents)['"]/;
  const L5 = /ports\.(roster|tools|http)\./;
  const hits = [];
  for (const rel of targets) {
    LINES(readRel(rel)).forEach((line, i) => {
      if (L1.test(line)) hits.push(rel + ':' + (i + 1) + ' → L-1');
      if (L5.test(line)) hits.push(rel + ':' + (i + 1) + ' → L-5');
    });
  }
  assert.deepEqual(hits, [], 'L-1 / L-5 必须零命中\n实际：\n' + hits.join('\n'));
});

// ── ④ AC-5 / AC-4 · 端口纯类型：零运行期 import；`stopReason` 字段位 0；三字段各 ≥1 ──────
test('P1 端口纯类型：ports.ts 零运行期 import、stopReason 不在字段位、errorFamily/retryNotBefore/usageBasis 逐个在场', () => {
  const src = readRel('lib/ports.ts');

  // ① 零运行期 import（顶格 import/require）
  const importLines = LINES(src).filter((line) => /^(import|require)\b/.test(line));
  assert.deepEqual(importLines, [], 'ports.ts 必须零运行期 import（纯类型文件）\n实际：\n' + importLines.join('\n'));

  // ② L-6（**只查 stopReason**）：字段位 0 命中（形如 `stopReason?: …` / `stopReason: …`）
  const fieldHits = LINES(src)
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => /^\s*stopReason\s*[?:]/.test(line))
    .map(({ line, no }) => 'lib/ports.ts:' + no + ' → ' + line.trim());
  assert.deepEqual(fieldHits, [], 'L-6：stopReason **不得**进 ports 字段位（只查 stopReason，不查 retryNotBefore）\n实际：\n' + fieldHits.join('\n'));

  // ③ 相反方向（X-2 口径）：这三字段是**合规字段**，必须逐个在场 —— 尤其 retryNotBefore
  for (const field of ['errorFamily', 'retryNotBefore', 'usageBasis']) {
    assert.ok(
      new RegExp('^\\s*' + field + '\\s*[?:]', 'm').test(src),
      field + ' 是 I-03 要求必须在 ports.ts 的合规字段 ⇒ 必须出现在字段位（断言它零命中即为假红，见包 §7.1 X-2）',
    );
  }

  // ④ 两处否定式注释仍在（与实际一致：注释说「不含」⇒ 事实确实不含）
  const negativeComments = LINES(src).filter((line) => /stopReason/.test(line));
  assert.ok(negativeComments.length >= 1, 'ports.ts 内应有说明「不含 stopReason」的否定式注释（保留面）');
  assert.ok(
    negativeComments.every((line) => !/^\s*stopReason\s*[?:]/.test(line)),
    '凡提到 stopReason 的行都必须是注释/说明，不得是字段声明',
  );
});

// ── ③ AC-9 / AC-10 · 受控 build 护栏：**只读**两份快照做比对，禁跑 build ───────────────────
test('B1 受控 build 护栏：after∖before ⊆ 白名单（4 项生成物），且生成物在 before 中尚未改动', () => {
  const beforePath = path.join(ARTIFACTS_DIR, 'exec', 'build-before.porcelain.txt');
  const afterPath = path.join(ARTIFACTS_DIR, 'exec', 'build-after.porcelain.txt');
  for (const p of [beforePath, afterPath]) {
    assert.ok(fs.existsSync(p), '缺少 build 快照文件（e1-ports 未交付？）：' + p);
  }
  const before = LINES(fs.readFileSync(beforePath, 'utf8')).filter(Boolean);
  const after = LINES(fs.readFileSync(afterPath, 'utf8')).filter(Boolean);

  // build 引入了什么 = after 里有、before 里没有的行（逐行集合差，不用计数）
  const added = after.filter((line) => !before.includes(line));
  const removed = before.filter((line) => !after.includes(line));

  // 白名单：**成对显式列举**（.ts 源 + 其生成物），禁「全部 lib/」
  const GENERATED = ['lib/ports.js', 'lib/ports.d.ts', 'lib/schema.js', 'lib/schema.d.ts'];
  const addedPaths = added.map((line) => line.slice(3).trim());
  const outOfWhitelist = addedPaths.filter((p) => !GENERATED.some((g) => p.endsWith(g)));
  assert.deepEqual(outOfWhitelist, [], 'build 新增行必须 ⊆ 白名单（4 项生成物）；白名单外改动 = ∅\n实际：\n' + added.join('\n'));
  assert.deepEqual(removed, [], 'build 不应删除任何既有 porcelain 行（after 必须 ⊇ before）\n实际：\n' + removed.join('\n'));

  // AC-10 生成物纪律：快照 before 里这些生成物**必须尚未改动** ⇒ 改动只能来自 build
  const preModified = before.filter((line) => GENERATED.some((g) => line.slice(3).trim().endsWith(g)));
  assert.deepEqual(preModified, [], 'build 前快照不得已含生成物改动（否则视为手改生成物）\n实际：\n' + preModified.join('\n'));

  // 反向可判性：before 必须非空（否则「⊆ 白名单」恒真、判据无杀伤力）
  assert.ok(before.length >= 1, 'build 前快照为空 ⇒ 本判据恒真、无判别力（须至少有 .ts 源改动行）');
});

// ── AC-11 · `lib/bus/**` 全手写 `.js`；入口两件在场 ──────────────────────────────────────
test('B2 lib/bus/** 全手写 .js：.ts 集合 = ∅，index.js 与 selftest.mjs 在场', () => {
  const files = listFiles('lib/bus');
  const tsFiles = files.filter((f) => f.endsWith('.ts'));
  assert.deepEqual(tsFiles, [], 'lib/bus/** 不得出现 .ts（A 路线：回拷清单是显式枚举，.ts 永不回拷 ⇒ 运行期 ERR_MODULE_NOT_FOUND）');
  for (const need of ['lib/bus/index.js', 'lib/bus/selftest.mjs']) {
    assert.ok(files.includes(need), '缺少入口文件：' + need);
  }
  // 反向佐证（解释而非判据）：回拷清单里不得登记 bus 条目（登记了说明走了被禁的 .ts 路线）
  const copySrc = readRel('scripts/copy-ts-built.mjs');
  const busEntries = LINES(copySrc).filter((line) => /bus\//.test(line) && /['"]/.test(line));
  assert.deepEqual(busEntries, [], 'copy-ts-built 清单不得登记 bus 条目（本批禁走 .ts 路线）');
});

// ── AC-13 · 三域只引用不复制：bus 引用 capabilities.js / roster.js，且无表字面量复制 ────────
test('B3 三域只引用不复制：bus 内引用两域模块 ≥1 处，且无能力键/职位名硬编码表', () => {
  const src = readRel('lib/bus/index.js');

  assert.ok(/from\s+['"][^'"]*capabilities\.js['"]/.test(src), 'AC-13：bus 须 import 能力域模块（禁自建能力表）');
  assert.ok(/from\s+['"][^'"]*roster\.js['"]/.test(src), 'AC-13：bus 须 import 职位域模块（禁自造职位名单）');
  // 【P0-3 门禁解冻 · 批 `punky-adapter-p0-20261031`】原断言用正则要求 bus **引用 `HOST_INJECTIONS`**
  //   —— 那是「宿主服务名词表」。J6-d 整改会把 bus 的能力名域从宿主服务名换成**功能面名**，
  //   该要求会先把整改判红（上游 `gap-list.md` AG-32 = 本行）。
  //   语义等价改写：不冻结**具体导出名**，改为核「bus 从能力域模块 import 的每个名字**逐个真实存在**」
  //   —— 既保住「只引用不复制」（必须真 import，不得自建表），又新增一层「不得引用幻符号」。
  const capImportBlock = (src.match(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*capabilities\.js['"]/) ?? [])[1] ?? '';
  const capImportedNames = capImportBlock.split(',')
    .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
  const capExportedNames = new Set(
    [...readRel('lib/capabilities.js').matchAll(/^export\s+(?:const|function|class)\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]),
  );
  assert.ok(capImportedNames.length >= 1,
    'AC-13：bus 须从能力域模块 import ≥1 个导出（禁自建能力表）；实际=' + JSON.stringify(capImportedNames));
  assert.deepEqual(capImportedNames.filter((n) => !capExportedNames.has(n)), [],
    'AC-13：bus 引用的能力域导出必须逐个真实存在（禁引用幻符号）；能力域实际导出=' + JSON.stringify([...capExportedNames].sort()));
  assert.ok(/BUILTIN_ROLES|reconcileRoster/.test(src), 'AC-13：须引用职位域的具体导出');

  // 无复制：不得出现「连续 ≥5 个能力键名」或「9 项职位名单」的硬编码数组
  const CAP_KEYS = ['aip', 'acps', 'identity', 'discovery', 'verify', 'watch', 'worktree', 'budget', 'injectBudget', 'trajectory', 'logs', 'topic', 'auditlog'];
  const ROLES = ['coordinator', 'designer', 'coder', 'tester', 'reviewer', 'supervisor', 'doc-manager', 'manager', 'lead'];
  const hasRun = (keys, need) => LINES(src).some((line) => {
    let run = 0;
    for (const k of keys) {
      if (new RegExp('[\'"]' + k + '[\'"]').test(line)) { run += 1; if (run >= need) return true; } else run = 0;
    }
    return false;
  });
  assert.equal(hasRun(CAP_KEYS, 5), false, 'AC-13：bus 内不得出现连续 ≥5 个能力键名的硬编码表（应引用 CAPABILITY_KEYS）');
  assert.equal(hasRun(ROLES, 9), false, 'AC-13：bus 内不得出现 9 项职位名单的硬编码数组（应引用 BUILTIN_ROLES）');
});
