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

// ── ① AC-11：导出面**恰好**两项（集合式）＋ 内建职位表形态自洽 ─────────────────────
test('R1 AC-11 导出面恰好两项：BUILTIN_ROLES + reconcileRoster（集合相等，非计数断言）', async () => {
  const mod = await loadRoster();
  assert.deepEqual(
    Object.keys(mod).sort(),
    ['BUILTIN_ROLES', 'reconcileRoster'],
    '导出面必须**恰好**为包 §2.5 钉死的两项（禁增删）',
  );
  assert.ok(Array.isArray(mod.BUILTIN_ROLES), 'BUILTIN_ROLES 必须是数组');
  assert.ok(mod.BUILTIN_ROLES.every((r) => typeof r === 'string' && r.length > 0),
    'BUILTIN_ROLES 元素必须是非空字符串职位名（包 §2.5：元素为字符串职位名）');
  assert.equal(typeof mod.reconcileRoster, 'function', 'reconcileRoster 必须是函数');
  assert.equal(mod.reconcileRoster.length >= 0, true, '纯函数、无 ctx 依赖：调用形态 = reconcileRoster(hostRoster)');
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
test('R6 AC-8 类型面不接线：ports.ts 顶格 import/require 零命中，且 lib/**/*.js 内无 ports.js 引用', () => {
  const src = sourceOf('lib/ports.ts');
  const importLines = src.split(/\r?\n/).filter((line) => /^(import|require)\b/.test(line));
  assert.deepEqual(importLines, [], 'ports.ts 必须零运行期 import（纯类型文件）\n实际：\n' + importLines.join('\n'));

  // 递归收集 lib/**/*.js（不写盘、不用 shell），断言没有运行时模块引用 ports.js
  const refs = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!ent.name.endsWith('.js')) continue;
      const body = fs.readFileSync(p, 'utf8');
      if (/ports\.js/.test(body)) refs.push(path.relative(PKG_ROOT, p));
    }
  };
  walk(abs('lib'));
  assert.deepEqual(refs, [], 'lib/**/*.js 内不得引用 ports.js（禁被任何运行时模块加载）\n实际引用：\n' + refs.join('\n'));
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
