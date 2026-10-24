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

// 判定面收口批 `punky-judging-face-20261024` · lane `c1-toolcount` · 规格 M-01 机检。
//
// 存在理由：同一个「注册面工具总数」读数在活面留了多值——三档（裸配置 / patch 全开 / 显式关）各写一份，
//   且逐版改数（改数史见 `test/tool-descriptor.test.js` 的注释块）。真源常量**已在位**：
//   `scripts/smoke/lib/checks-k.mjs` 的 `EXPECTED_TOOLS_BARE` / `EXPECTED_TOOLS_FULL`，
//   但没有任何机检拦「下一版再把旧读数抄回注释/标题/文案」——恒真不了的机检就是本件。
//
// 本件守三条（规格 AC-01 / AC-02 ＋「反向构造」硬要求）：
//   ① 不写死计数：**已登记活面锚点**不命中四类计数形态（总数名词 + 数字 / 数字 + 工具 / 两档比分 / 派生 = 数字）；
//   ② 真源自洽：两档常量 == **运行期**注册面实测数（`createTools().register()`，本件不写死任何绝对值）；
//   ③ 判据非恒真：同一规则对**修前原文逐字夹具**必命中，且对**「临时写回旧读数」的镜像**必报违规。
//
// 口径：静态只读（读源码文本）＋ 注册面运行期计数 ＋ 临时目录镜像。**不改任何被测文件**、不 spawn 子进程；
//   装载的只有 `createTools` 的注册面（不触 `apply()` 引擎装配 ⇒ 不落任何真实 home 写点）。
//   反向构造与两档实测读数见 `exec/change-toolcount.md`（本 lane 产物）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 缺省 = 本包根；`PUNKY_JUDGING_TOOLCOUNT_ROOT` 只服务「反向构造」实测（把扫描根指向镜像副本），
// 缺省路径不受影响（正常 `node --test` 不会设它）。
const ROOT = process.env.PUNKY_JUDGING_TOOLCOUNT_ROOT
  ? path.resolve(process.env.PUNKY_JUDGING_TOOLCOUNT_ROOT)
  : path.resolve(HERE, '..');
const CHECKS_K = 'scripts/smoke/lib/checks-k.mjs';

/**
 * 四类「写死计数」形态。`COUNT` 是规格 AC-01 的正则**逐字**；
 * 其余三条覆盖同一病灶的另三种写法（规格只给了 COUNT，而活面实测还有这三种形态，见 progress 01 §S-2）。
 */
const RULE = {
  COUNT: /(裸配置|patch 全开|显式关|工具总数)[^\n]{0,12}\d+/,
  // 前置否定环视排除 id 片段（否则「H-03 工具注册面」里的 `03 工具` 会假命中）
  DIGIT_TOOL: /(?<![\w-])\d+\s*工具/,
  RATIO: /\d+\s*\/\s*\d+/,
  DERIVED_LITERAL: /(?:=|⇒)\s*\d+/,
};

/**
 * 已登记活面锚点（本 lane 规格实测过的 8 处；`locate` 必须命中，**命中不到即红**——
 * 防「改写后锚点漂走 ⇒ 断言空跑」的假绿）。
 * `span` = 自命中行起连续扫描的行数（缺省 1），只用于跨两行的注释块。
 *
 * ⚠ **不做全仓 `grep 数字` 普查**：`lib/aip/agent-descriptor.js` 的「必填 14 键」是 AIP **字段数**，
 *   与本项「注册面工具总数」**非同源**（真值，非旧读数）⇒ 按字面扫数字必误伤。口径锚**语义**，不锚数字。
 */
const ANCHORS = [
  { file: CHECKS_K, locate: 'H-03 工具注册面', rules: ['COUNT'], note: 'H-03 判据 docstring（曾写「裸配置 20 / patch 全开 21」）' },
  { file: CHECKS_K, locate: "id: 'H-03', title:", rules: ['RATIO'], note: 'H-03 清单 title（曾把两档读数以字面量写进标题）' },
  { file: 'scripts/smoke/lib/checks-s.mjs', locate: '阳性对照失败：wave_plan 未注册', rules: ['COUNT'], note: 'H-05 阳性对照文案（曾写「裸配置应含 20 工具」）' },
  { file: 'test/tool-descriptor.test.js', locate: '缺省默认开：', span: 2, rules: ['DERIVED_LITERAL', 'DIGIT_TOOL'], note: '缺省面派生注释块（两行；曾写「= 26」/「⇒ 27」/「旧 14 工具」）' },
  { file: 'test/api.test.js', locate: '/tools 端点：catalog 非空时注册并返回', rules: ['DIGIT_TOOL'], note: '/tools 端点用例标题（曾写「14 工具 6 属性」）' },
  { file: 'test/log-export.test.js', locate: 'T3.1 默认关', rules: ['COUNT'], note: '文件头 T3.1 注释（曾写「工具总数 14」）' },
  { file: 'test/worktree-tools.test.js', locate: 'T5 git 依赖', rules: ['COUNT'], note: '文件头 T5 注释（曾写「工具总数 14 不变」）' },
  { file: 'lib/index.js', locate: '生成 catalog', rules: ['DIGIT_TOOL'], note: 'installWatchRuntime 注释（曾写「14 工具 6 属性快照」）' },
];

const DOMAIN_FILES = [...new Set(ANCHORS.map((a) => a.file))];

function readSource(rel, rootDir = ROOT) {
  return fs.readFileSync(path.join(rootDir, rel), 'utf8');
}

/**
 * 扫描全部已登记锚点。返回 { located, violations }：
 *   located    = 实际被扫到的位置（用于「锚点必须命中」的非空证明）
 *   violations = 命中计数形态的位置（空 = GREEN）
 */
function scanAnchors(rootDir = ROOT) {
  const located = [];
  const violations = [];
  for (const anchor of ANCHORS) {
    const lines = readSource(anchor.file, rootDir).split('\n');
    const starts = [];
    lines.forEach((line, i) => { if (line.includes(anchor.locate)) starts.push(i); });
    assert.ok(starts.length > 0,
      `锚点定位失败：${anchor.file} 内找不到「${anchor.locate}」（${anchor.note}）——锚点漂走会让本断言空跑，故直接判红`);
    for (const start of starts) {
      const end = Math.min(lines.length, start + (anchor.span ?? 1));
      for (let i = start; i < end; i += 1) {
        located.push({ file: anchor.file, line: i + 1 });
        for (const ruleName of anchor.rules) {
          const hit = lines[i].match(RULE[ruleName]);
          if (hit) violations.push({ file: anchor.file, line: i + 1, rule: ruleName, hit: hit[0], note: anchor.note });
        }
      }
    }
  }
  return { located, violations };
}

function formatViolations(list) {
  return list.map((v) => `${v.file}:${v.line} [${v.rule}] 命中「${v.hit}」— ${v.note}`).join('\n  ') || '(无)';
}

/**
 * ⚠ 修前原文**逐字夹具**：故意保留旧读数形态，只用来证明「同一规则真的抓得住写死计数」，
 *   **不是**任何读数来源，也不得被当成待同步的文档。
 */
const LEGACY_FIXTURES = [
  { rule: 'COUNT', text: '实测工具总数：裸配置 20 / patch 全开 21 / 显式关（worktree+watch 关）14' },
  { rule: 'COUNT', text: '/** H-03 工具注册面：裸配置 20 / patch 全开 21，差集恰 = log_export；member_status 枚举不含 idle。 */' },
  { rule: 'COUNT', text: "expect(wavePlan, '阳性对照失败：wave_plan 未注册（裸配置应含 20 工具）');" },
  { rule: 'COUNT', text: '// T3.1 默认关：logs 未配置/disabled → log_export 不注册，工具总数 14（T0 断言保持）' },
  { rule: 'COUNT', text: '// T5 git 依赖：git 不可用 → 工具返回清晰错误不挂起；enabled=false → 不注册（工具总数 14 不变）' },
  { rule: 'DERIVED_LITERAL', text: '// 缺省默认开：14（core 12 + mailbox 3）+ … = 26；【2026-09-21 N1-R4-1a】+`task_pool` ⇒ 27。' },
  { rule: 'DIGIT_TOOL', text: "test('/tools 端点：catalog 非空时注册并返回 14 工具 6 属性', () => {" },
  { rule: 'DIGIT_TOOL', text: '  // enabled=true 时 register() 生成 catalog（14 工具 6 属性快照），传给 createApi 挂 /tools 端点' },
  { rule: 'RATIO', text: "{ id: 'H-03', title: '工具注册面 40/41（钉 HEAD 基线）+ 差集 = log_export' }" },
];

/** 目标态文案（反例夹具：必须**不**命中 —— 证明规则不靠「见数字就红」）。 */
const CLEAN_SAMPLES = [
  '/** H-03 工具注册面：两档真值 = 本文件 :36-37 的 EXPECTED_TOOLS_BARE / EXPECTED_TOOLS_FULL，差集恰 = log_export。 */',
  '// 缺省默认开：总数一律取 `TOOL_NAMES.length`（派生，勿写字面量）',
  '// logs 缺省关（log_export 不在缺省清单，全开面 = 缺省面 + 1）',
  "expect(wavePlan, '阳性对照失败：wave_plan 未注册（裸配置应注册 wave_plan）');",
  "test('/tools 端点：catalog 非空时注册并返回「全量工具 × 6 属性」', () => {",
  '  // enabled=true 时 register() 生成 catalog（注册面全量 × 6 属性快照），传给 createApi 挂 /tools 端点',
  '// 该组四件不注册（总数面权威 = 冻结名单派生）—— 含数字词但无读数形态，不得命中',
];

test('j1-1 活面不写死计数：已登记锚点不命中任一计数形态（规格 AC-01 正向）', () => {
  const { located, violations } = scanAnchors(ROOT);
  assert.ok(located.length >= ANCHORS.length,
    `已登记锚点必须全部命中（实际 ${located.length} 处 < 锚点数 ${ANCHORS.length}）`);
  assert.equal(violations.length, 0,
    '活面仍写死工具总数读数（合法手法只有三种：A 改指真源 / B 删数字 / C 加锚；禁逐处改数）：\n  '
    + formatViolations(violations));
});

test('j1-2 样本自检（防恒真）：修前逐字夹具必命中、目标态文案必不命中', () => {
  const missed = LEGACY_FIXTURES.filter((f) => !RULE[f.rule].test(f.text));
  assert.equal(missed.length, 0,
    '判据恒真（修前形态未被同一规则抓到 ⇒ 本件守不住任何东西）：\n  '
    + missed.map((f) => `[${f.rule}] ${f.text}`).join('\n  '));
  for (const ruleName of Object.keys(RULE)) {
    assert.ok(LEGACY_FIXTURES.some((f) => f.rule === ruleName),
      `规则 ${ruleName} 缺少修前夹具 ⇒ 该规则未被证明非恒真（零规则豁免）`);
  }
  const falsePositives = [];
  for (const text of CLEAN_SAMPLES) {
    for (const [ruleName, re] of Object.entries(RULE)) {
      const hit = text.match(re);
      if (hit) falsePositives.push(`[${ruleName}] ${text} ⇒ 命中「${hit[0]}」`);
    }
  }
  assert.equal(falsePositives.length, 0,
    '判据过敏（目标态文案被判成写死读数 ⇒ 合法改法也会被拦）：\n  ' + falsePositives.join('\n  '));
});

/** 运行期注册面读数：`createTools(...).register()` 的在册工具名（本件不写死任何绝对值）。 */
function runtimeToolNames(config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-judging-toolcount-'));
  try {
    const store = createStore(root);
    const registered = [];
    createTools({ tools: { register: (t) => registered.push(t) }, logger: console }, { store, root, config }).register();
    return registered.map((t) => t?.name).filter(Boolean);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** 与冒烟 H-03 的「patch 全开」面同形（同一组能力开关 ⇒ 必须是同一读数面）。 */
const FULL_CONFIG = {
  capabilities: {
    logs: { enabled: true }, worktree: { enabled: true }, watch: { enabled: true },
    discovery: { enabled: true }, trajectory: { enabled: true }, budget: { enabled: true }, verify: { enabled: true },
  },
  aip: { enabled: true },
  dispatch: { provider: 'spawn' },
};

test('j1-3 真源自洽：两档常量 == 运行期注册面实测数（规格 AC-02）', () => {
  const src = readSource(CHECKS_K);
  const bareDecl = src.match(/EXPECTED_TOOLS_BARE\s*=\s*(\d+)/);
  const fullDecl = src.match(/EXPECTED_TOOLS_FULL\s*=\s*(\d+)/);
  assert.ok(bareDecl, `${CHECKS_K} 必须仍声明 EXPECTED_TOOLS_BARE（M-01 的唯一真源）`);
  assert.ok(fullDecl, `${CHECKS_K} 必须仍声明 EXPECTED_TOOLS_FULL`);
  const bare = runtimeToolNames({});
  const full = runtimeToolNames(FULL_CONFIG);
  assert.equal(Number(bareDecl[1]), bare.length,
    'EXPECTED_TOOLS_BARE 与运行期缺省注册面不一致（真源漂了）：实测 ' + bare.slice().sort().join(','));
  assert.equal(Number(fullDecl[1]), full.length,
    'EXPECTED_TOOLS_FULL 与运行期 patch 全开注册面不一致：实测 ' + full.slice().sort().join(','));
  assert.deepEqual(full.filter((n) => !bare.includes(n)), ['log_export'], '全开面相对缺省面**只多** log_export');
  assert.equal(full.length - bare.length, 1, '两档差必须恰为 1（那一件 = log_export；差值派生，不写死绝对值）');
});

test('j1-4 反向构造（扫描器级）：把某处写回旧读数 ⇒ 同一扫描器必报违规', () => {
  const mirror = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-judging-mirror-'));
  try {
    for (const rel of DOMAIN_FILES) {
      const dest = path.join(mirror, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), dest);
    }
    const baseline = scanAnchors(mirror).violations;
    assert.equal(baseline.length, 0,
      '镜像基线必须干净（否则下面的「+1 条违规」不成立）：\n  ' + formatViolations(baseline));

    // 临时把 `checks-s.mjs` 的阳性对照文案**写回旧读数**（修前原文逐字，含裸配置的旧数）
    const target = path.join(mirror, 'scripts/smoke/lib/checks-s.mjs');
    fs.appendFileSync(target,
      "\n    expect(wavePlan, '阳性对照失败：wave_plan 未注册（裸配置应含 20 工具）');\n", 'utf8');

    const after = scanAnchors(mirror).violations;
    assert.equal(after.length, 1,
      '写回旧读数后扫描器必须报出**恰一条**违规（判据恒真则会 0 条）：\n  ' + formatViolations(after));
    assert.equal(after[0].file, 'scripts/smoke/lib/checks-s.mjs', '违规必须点名被回写的文件');
    assert.equal(after[0].rule, 'COUNT', '违规必须归到 COUNT 形态');
    assert.match(after[0].hit, /20/, '违规必须点名被写死的读数：' + after[0].hit);
  } finally {
    fs.rmSync(mirror, { recursive: true, force: true });
  }
});
