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

// 批 `punky-g1-declare-2026-10-29` · lane `t1-verify`（tester）—— **roster 面 + 护栏正交**测试。
//
// 判据源 = `plan/p2-pack-g1.md`：
//   · §2.5 roster 面导出面（**钉死**：`BUILTIN_ROLES` + `reconcileRoster`，后者**纯函数、无 I/O、无 ctx**）
//   · §2.6 类型面「名实分界」（零运行期 import / 不被任何 .js 引用 / 「运行仍拒派」须写明 / 禁「已支持收窄」）
//   · `## 验收标准`：AC-11（roster 三集合语义）/ AC-15（护栏正交：零外部框架名）/ AC-8 + AC-9（类型面，t1 侧交叉读数）
//   · `## 约束`：C-10（禁外部框架名）/ C-14（禁数量断言 —— 判据主体一律为**集合关系 / 存在性 / 捕获到的消息内容**）
//
// 写域自证（C-13）：本文件是 t1 的**唯一**写码面之二；只消费 `lib/roster.js` 的公开导出面与**读回原文**面。
//
// 动态 import 的理由同 `test/no-agentTeams-batch.test.js`：`e2-sync-roster` 与本 lane 并行，被测文件交付前不存在；
//   静态 import 会让整文件在加载期 ERR_MODULE_NOT_FOUND，把「roster 未交付」与「护栏面未交付」混成同一条报错。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const abs = (p) => path.join(PKG_ROOT, p);

function sourceOf(relPath) {
  const absPath = abs(relPath);
  assert.ok(fs.existsSync(absPath), relPath + ' 不存在（对应 coder lane 未交付？）');
  return fs.readFileSync(absPath, 'utf8');
}

async function loadRoster() {
  const mod = await import('../lib/roster.js').catch((err) => {
    throw new Error('lib/roster.js 不可加载（e2-sync-roster 未交付？原始错：' + String(err?.message ?? err) + '）');
  });
  for (const name of ['BUILTIN_ROLES', 'reconcileRoster']) {
    assert.ok(name in mod, '导出面缺 ' + name + '（包 §2.5 钉死两项）');
  }
  return mod;
}

const asArray = (v) => (Array.isArray(v) ? v : []);

/** 内建职位表的**期望名集合**（批 `punky-g1-gapfix-2026-10-29` §2.4(a)，9 名显式枚举；`docManager` 已统一为 `doc-manager`）。
 *  纪律：这是**独立侧常量名单**（不是从 `BUILTIN_ROLES` 反推），否则等于「枚举 == 枚举」自证。 */
const EXPECTED_BUILTIN_ROLES = [
  'coordinator', 'designer', 'coder', 'tester', 'reviewer', 'supervisor', 'doc-manager', 'manager', 'lead',
];

/** 内建职位表的**集合相等**判据（抽成函数 ⇒ 可对「注入第 10 项」的输入复用，证明判据有杀伤力）。 */
function assertBuiltinRoleSet(actual) {
  assert.deepEqual(
    [...asArray(actual)].sort(),
    [...EXPECTED_BUILTIN_ROLES].sort(),
    'BUILTIN_ROLES 必须**逐名等于** 9 席期望集合（集合相等；注入第 10 项 / 改名 / 缺席 均应判红）',
  );
}

// ── ① AC-11 + AC-10：导出面**恰好**两项 ｜ 内建职位表**集合相等** ｜ 空名册行为断言 ──────────
test('R1 AC-11 导出面恰好两项 + 内建职位表集合相等（9 席显式判定，非计数断言）', async () => {
  const mod = await loadRoster();
  assert.deepEqual(
    Object.keys(mod).sort(),
    ['BUILTIN_ROLES', 'reconcileRoster'],
    '导出面必须**恰好**为包 §2.5 钉死的两项（禁增删）',
  );
  assert.ok(Array.isArray(mod.BUILTIN_ROLES), 'BUILTIN_ROLES 必须是数组');

  // 元素判据（原「非空字符串」已被本批替换为集合相等 —— 原判据下「第 10 项任意字符串」可静默通过）
  assertBuiltinRoleSet(mod.BUILTIN_ROLES);

  // 命名统一（D-2）：`doc-manager` 必须在场，且旧拼写 `docManager` 不得出现
  assert.ok(mod.BUILTIN_ROLES.includes('doc-manager'),
    '命名统一：内建表须含 `doc-manager`（与 VALID_ROLES / REQUIRED_ROLES 同名在场）');
  assert.equal(mod.BUILTIN_ROLES.includes('docManager'), false,
    '命名统一：不得残留 `docManager` 旧拼写（跨面比对会恒误判该席）');

  assert.equal(typeof mod.reconcileRoster, 'function', 'reconcileRoster 必须是函数');

  // 跨面同名（AC-10 交叉读数）：`doc-manager` 必须与 wave-plan 的 VALID_ROLES、assembly 的 REQUIRED_ROLES 同名在场
  //   —— 否则 `reconcileRoster` 跨面对比时该席恒「两边各缺」（命名漂移的原始缺陷面）。
  const { VALID_ROLES } = await import('../lib/wave-plan.js');
  const { REQUIRED_ROLES } = await import('../lib/assembly/schema.js');
  assert.ok(asArray(VALID_ROLES).includes('doc-manager'), '跨面同名：`VALID_ROLES` 须含 `doc-manager`');
  assert.ok(asArray(REQUIRED_ROLES).includes('doc-manager'), '跨面同名：`REQUIRED_ROLES` 须含 `doc-manager`');
  assert.equal(asArray(VALID_ROLES).includes('docManager'), false, '跨面同名：`VALID_ROLES` 不得残留 `docManager`');
});

// ── ①-b AC-12：消除恒真断言 —— 空名册 ⇒ matched=∅ ∧ hostOnly=∅ ∧ builtinOnly=全量 ──────────
//   ⚠ 包 AC-12 原表述为「`reconcileRoster([])` 三键皆空」，与三集合语义**冲突**：
//     空宿主名册下「内建有、宿主无」必然是全量 ⇒ `builtinOnly` 不可能为空（写「三键皆空」要么恒假，
//     要么逼实现把语义改错）。经 Leader 裁决，按语义正确版落地，并由本用例给出可判别面。
test('R1b AC-12 空宿主名册行为断言：matched=∅ ∧ hostOnly=∅ ∧ builtinOnly=BUILTIN_ROLES（替代原恒真断言）', async () => {
  const { BUILTIN_ROLES, reconcileRoster } = await loadRoster();
  const diff = reconcileRoster([]);

  assert.ok(diff && typeof diff === 'object', 'reconcileRoster([]) 必须返回对象');
  for (const key of ['matched', 'builtinOnly', 'hostOnly']) {
    assert.ok(key in diff, '返回值缺集合 ' + key + '（包 §2.5 → {matched, builtinOnly, hostOnly}）');
  }
  // 三个断言各自独立、各有判别力：把任一集合写错（例如让 builtinOnly 也返回空）都会红
  assert.deepEqual(asArray(diff.matched), [], '空宿主名册 ⇒ matched 必须为空集');
  assert.deepEqual(asArray(diff.hostOnly), [], '空宿主名册 ⇒ hostOnly 必须为空集（无宿主侧额外席位）');
  assert.deepEqual(
    [...asArray(diff.builtinOnly)].sort(),
    [...BUILTIN_ROLES].sort(),
    '空宿主名册 ⇒ builtinOnly 必须等于**全量内建表**（「内建有、宿主无」）',
  );
});

// ── ①-c AC-11 杀伤力实验：**注入第 10 项** ⇒ 同一条集合判据必红 ──────────────────────
//   存在理由：R1 若恒绿则无判别力（本批之前它确实近乎恒绿 —— 元素判据只查「非空字符串」）。
//   本用例把「注入第 10 项」的输入喂给**同一个** `assertBuiltinRoleSet`，断言它抛出。
test('R1c AC-11 杀伤力实验：注入第 10 席 ⇒ 集合相等判据必红（证明判据非恒真）', async () => {
  const { BUILTIN_ROLES } = await loadRoster();
  const injected = [...BUILTIN_ROLES, 'tenth-seat-should-be-rejected'];

  assert.throws(
    () => assertBuiltinRoleSet(injected),
    (err) => err instanceof assert.AssertionError,
    '注入第 10 席后，集合相等判据**必须**判红（否则该判据恒绿、无杀伤力）',
  );
  // 阴性对照：未注入的原集合必须通过（证明红来自注入，不是判据本身永久失败）
  assert.doesNotThrow(() => assertBuiltinRoleSet(BUILTIN_ROLES), '未注入的原集合必须通过（阴性对照）');
});

// ── ② AC-11(a)：**宿主名册缺一席** ⇒ `builtinOnly` 含该席、`hostOnly` = ∅ ─────────
test('R2 AC-11(a) 宿主名册缺一席 ⇒ builtinOnly 含该席、hostOnly = ∅（宿主名册缺位可识别）', async () => {
  const { BUILTIN_ROLES, reconcileRoster } = await loadRoster();
  const seat = BUILTIN_ROLES[0];
  assert.ok(typeof seat === 'string' && seat.length > 0, '夹具前提：内建表非空，取首席作受试对象');

  // 构造：宿主名册 = 内建表**去掉该席**（其余全在）⇒ 该席「内建有、宿主无」
  const hostRoster = asArray(BUILTIN_ROLES).filter((r) => r !== seat);
  const diff = reconcileRoster(hostRoster);

  assert.ok(diff && typeof diff === 'object', 'reconcileRoster 必须返回对象');
  for (const key of ['matched', 'builtinOnly', 'hostOnly']) {
    assert.ok(key in diff, '返回值缺集合 ' + key + '（包 §2.5 → {matched, builtinOnly, hostOnly}）');
  }
  assert.ok(diff.builtinOnly.includes(seat),
    '缺失席位须落在 builtinOnly；期望含 ' + seat + '，实际 builtinOnly=' + JSON.stringify(diff.builtinOnly));
  assert.deepEqual(asArray(diff.hostOnly), [], '宿主名册是内建表的子集 ⇒ hostOnly 必须为空集（集合式判据）');
  assert.equal(diff.matched.includes(seat), false, '该席在宿主侧缺位 ⇒ 不得出现在 matched');
  for (const name of hostRoster) {
    assert.ok(diff.matched.includes(name), '两侧都有的席位须落 matched：' + name);
  }
});

// ── ③ AC-11(b)：**宿主多一席** ⇒ `hostOnly` 含该席、`builtinOnly` = ∅ ────────────
test('R3 AC-11(b) 宿主名册多一席 ⇒ hostOnly 含该未知席、builtinOnly = ∅（未知席位可识别）', async () => {
  const { BUILTIN_ROLES, reconcileRoster } = await loadRoster();
  const ghost = 'ghost-seat-not-in-builtin';
  assert.equal(BUILTIN_ROLES.includes(ghost), false, '夹具前提：该席位名不得已在内建表内');

  const hostRoster = [...asArray(BUILTIN_ROLES), ghost];
  const diff = reconcileRoster(hostRoster);

  assert.ok(diff.hostOnly.includes(ghost),
    '未知席位须落在 hostOnly；实际 hostOnly=' + JSON.stringify(diff.hostOnly));
  assert.deepEqual(asArray(diff.builtinOnly), [], '内建表是宿主名册的子集 ⇒ builtinOnly 必须为空集（集合式判据）');
  for (const name of BUILTIN_ROLES) {
    assert.ok(diff.matched.includes(name), '两侧都有的席位须落 matched：' + name);
  }
});

// ── ④ AC-11(c)：三集合**互斥**且不重不漏（纯函数、无 I/O：同一输入两次调用结果相等）──
test('R4 AC-11(c) 三集合互斥（同一席位不得同时出现在两侧）+ 纯函数幂等（无 I/O 副作用）', async () => {
  const { BUILTIN_ROLES, reconcileRoster } = await loadRoster();
  const hostRoster = [...asArray(BUILTIN_ROLES).slice(1), 'ghost-seat-not-in-builtin'];
  const diff = reconcileRoster(hostRoster);

  for (const name of asArray(diff.builtinOnly)) {
    assert.equal(asArray(diff.matched).includes(name), false, 'builtinOnly 与 matched 必须互斥：' + name);
    assert.equal(asArray(diff.hostOnly).includes(name), false, 'builtinOnly 与 hostOnly 必须互斥：' + name);
  }
  for (const name of asArray(diff.hostOnly)) {
    assert.equal(asArray(diff.matched).includes(name), false, 'hostOnly 与 matched 必须互斥：' + name);
  }
  // 纯函数：同一输入两次调用 ⇒ 三集合逐项相等（无 I/O、无缓存态）
  const again = reconcileRoster(hostRoster);
  assert.deepEqual(again, diff, 'reconcileRoster 必须是纯函数（同输入同输出；包 §2.5「纯函数、无 I/O、无 ctx 依赖」）');
  // 入参不得被就地改写（纯函数的另一面）
  assert.deepEqual(hostRoster, [...asArray(BUILTIN_ROLES).slice(1), 'ghost-seat-not-in-builtin'],
    'reconcileRoster 不得就地改写入参数组');
});

// ── ⑤ AC-15 + C-10：护栏正交 —— 能力面 / roster 面**零外部框架名** ────────────────
test('R5 AC-15 护栏正交：capabilities.js 与 roster.js 内 agentTeams / AgentScope / dsh-agent 零命中', () => {
  const targets = ['lib/capabilities.js', 'lib/roster.js'];
  const forbidden = [/agentTeams/, /AgentScope/, /dsh-agent/];
  const hits = [];
  for (const relPath of targets) {
    const src = sourceOf(relPath);
    src.split(/\r?\n/).forEach((line, i) => {
      for (const re of forbidden) {
        if (re.test(line)) hits.push(relPath + ':' + (i + 1) + ' → ' + line.trim().slice(0, 120));
      }
    });
  }
  assert.deepEqual(hits, [], '外部框架名须零命中（用户口径：不做外部框架适配）\n实际命中：\n' + hits.join('\n'));
});

// ── ⑥ AC-8：`ports.ts` 零运行期 import 且不被任何 `.js` 引用（类型面**不接线**的机械判据）──
// ── AC-8 判据实现（R6 与 R6b 阳性对照**共用同一份**，防「改完变恒绿」）──────────────────────────
//   判据对象 = **加载语句**，不是「文件名出现过」：
//     `require('…/ports.js')` / `from '…/ports.js'` / 动态 `import('…/ports.js')`。
//   ⚠ 为什么不能再用「裸文件名」写法（本用例 2026-10-30 修正的历史缺陷）：
//     G1 时 `lib/ports.js` **不存在**；G2 的受控 build **首次生成**了它（未跟踪的 build 回拷产物，与
//     `lib/schema.js` 同性质，**允许存在**）⇒ 旧写法扫 `lib/**/*.js` 里有没有出现 `ports.js` 字面时，
//     **生成物自己命中自己** ⇒ 假红。意图是「禁被任何**运行时模块加载**」，实现必须落在加载语句上。
const PORTS_LOAD_RES = [
  /require\(\s*['"][^'"]*ports\.js['"]/,
  /from\s+['"][^'"]*ports\.js['"]/,
  /import\(\s*['"][^'"]*ports\.js['"]/,
];

/** 一段源码是否**加载** ports.js（含 `require` / 静态 `from` / 动态 `import` 三形态）。 */
function runtimeLoadsPorts(body) {
  return PORTS_LOAD_RES.some((re) => re.test(body));
}

/** 在给定目录树内收集「**加载** ports.js 的运行时模块」（相对 dir 的路径，POSIX 分隔）。 */
function runtimeModulesLoadingPorts(dir) {
  const refs = [];
  const walk = (cur) => {
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!ent.name.endsWith('.js') && !ent.name.endsWith('.mjs')) continue; // .mjs 同样是运行期模块
      if (runtimeLoadsPorts(fs.readFileSync(p, 'utf8'))) refs.push(path.relative(dir, p).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return refs;
}

// ── ⑥ AC-8：`ports.ts` 零运行期 import ＋ **无任何运行时模块加载** `ports.js` ─────────────────────
//   ⚠ `lib/ports.js` 是受控 build 的**回拷产物**（与 `lib/schema.js` 同性质）⇒ 它**允许存在**；
//     本判据只禁「被加载」，不禁「文件存在」。（旧写法禁的是文件名出现 ⇒ 生成物自身假红，见上方说明。）
test('R6 AC-8 类型面不接线：ports.ts 顶格 import/require 零命中，且无运行时模块**加载** ports.js', () => {
  const src = sourceOf('lib/ports.ts');
  const importLines = src.split(/\r?\n/).filter((line) => /^(import|require)\b/.test(line));
  assert.deepEqual(importLines, [], 'ports.ts 必须零运行期 import（纯类型文件）\n实际：\n' + importLines.join('\n'));

  const refs = runtimeModulesLoadingPorts(abs('lib'));
  assert.deepEqual(refs, [], 'lib/ 内不得有运行时模块**加载** ports.js（查加载语句，不是查文件名）\n实际：\n' + refs.join('\n'));
});

// ── ⑥-b AC-8 阳性对照：构造「加载 ports.js 的运行时模块」⇒ 同一判据**必须红** ─────────────────────
//   存在理由：判据从「文件名」改成「加载语句」后，若写坏（例如正则永假）会变成**恒绿**。
//   本用例在临时目录造四种样本：三种真实加载形态（必被抓）+ 一种「只提及不加载」（必不漏抓误报）。
test('R6b AC-8 阳性对照：加载 ports.js 的三种形态必被同一判据抓出，仅字面提及者不得误判', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g2-ports-load-'));
  try {
    fs.writeFileSync(path.join(dir, 'loads-require.js'), "const p = require('./ports.js');\n", 'utf8');
    fs.writeFileSync(path.join(dir, 'loads-from.js'), "import { KernelPorts } from '../../lib/ports.js';\n", 'utf8');
    fs.writeFileSync(path.join(dir, 'loads-dynamic.mjs'), "const m = await import('./ports.js');\n", 'utf8');
    // 阴性对照：只**提及**文件名、不加载 —— 旧写法的镜像，必须**不**被抓（否则又是「查字面」）
    fs.writeFileSync(path.join(dir, 'mentions-only.js'), "// 见 lib/ports.js（仅注释提及，不加载）\nconst name = 'ports.js';\n", 'utf8');

    const hits = runtimeModulesLoadingPorts(dir).sort();
    assert.deepEqual(
      hits,
      ['loads-dynamic.mjs', 'loads-from.js', 'loads-require.js'],
      'AC-8 阳性对照：三种加载形态（require / 静态 from / 动态 import）必须全部被抓出；实际=' + JSON.stringify(hits),
    );
    assert.equal(hits.includes('mentions-only.js'), false, 'AC-8 阴性对照：仅字面提及不算加载 ⇒ 不得被误判（这正是旧写法的缺陷面）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── ⑦ AC-9 正向面（t1 侧交叉读数）：名实分界「写明了」—— 两键在位 + 「运行仍拒派」写明 ──────
test('R7 AC-9 正向面：ports.ts 命中「本批不接线 / 运行仍拒派」，且 agentPreset / composition 两个表达位在位', () => {
  const src = sourceOf('lib/ports.ts');

  assert.ok(/本批不接线|运行仍拒派/.test(src),
    'ports.ts 须写明「本批不接线」或「运行仍拒派」（包 §2.6 硬约束 3：类型支持 ≠ 运行支持）');

  // 两键名须在文件内可 grep 到（包 §2.6：agentPreset / composition 两个表达位）
  for (const key of ['agentPreset', 'composition']) {
    assert.ok(new RegExp(key + '\\s*\\??\\s*:').test(src), 'ports.ts 内须命中表达位键名 ' + key);
  }
});

// ── ⑧ AC-9 反向面（字面判据）：**禁**出现「已支持收窄 / 已接线」类表述，0 命中 ──────────────
//   判据出处：包 `## 验收标准` AC-9 末句「「已支持收窄」/「已接线」类表述 **0 命中**」，复核读数 = `grep`。
//   ⚠ 本用例**刻意按字面**判（同 grep 口径）：**禁止性表述里出现该字面同样命中** —— 这是包给的可判口径，
//     若实现想规避，只能改写措辞（例如「不得据此字段声称能力位已生效」），不能靠「语义上不是宣称」豁免。
test('R8 AC-9 反向面：ports.ts 内「已支持收窄 / 已接线 / narrowing supported」字面 0 命中', () => {
  const src = sourceOf('lib/ports.ts');
  const overclaims = ['已支持收窄', 'narrowing supported', '已接线'];
  const hits = src.split(/\r?\n/)
    .map((line, i) => ({ line: line.trim(), no: i + 1 }))
    .filter(({ line }) => overclaims.some((w) => line.includes(w)))
    .map(({ line, no }) => 'lib/ports.ts:' + no + ' → ' + line.slice(0, 160));
  assert.deepEqual(
    hits,
    [],
    'AC-9 要求「已支持收窄 / 已接线」类表述 **0 命中**（字面判据，与 grep 同口径）。\n'
      + '命中项（若为「禁止性表述」亦须改写措辞，否则与本条判据冲突）：\n' + hits.join('\n'),
  );
});
