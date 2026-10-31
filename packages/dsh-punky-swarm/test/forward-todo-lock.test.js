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

// test/forward-todo-lock.test.js —— **前向 todo 的四道机检防呆**（批 `punky-adapter-split-20261031` · lane `w0-todo-lock`）
//
// ## 为什么这个文件必须存在（实物证据，不是形式主义）
//
// P0-3 把 4 条前向要求写成「内联预期红」todo，a1 判**可接受（有条件）**（`audit/a1-pre-gate.md` 核对点 2）。
// 条件的理由在本仓有实物：`test/gate-techdebt-red.test.js:552/580/600/620` 有 **4 条模块级
// `test.todo(name)`（无回调 ⇒ 永不执行 ⇒ 无法自动转绿）**，自 2026-09 起在位至今未清；
// 同形态的另一批靠一次**专门的复活批**（`core-debt-parallel-20260915`）才收口。
// ⇒ 结论：**没有硬门的 todo 就是不会清的**。下面 4 道即 a1 要求的闭口。
//
// ## ⚠ 两个机制必须**分开数**（混用会让棘轮拿错基线）
//
//   · A「内联预期红」= 第二参数对象形态的 todo：本仓 **4** 条（P0-3 引入，**有回调 ⇒ 执行并留失败原文**）
//   · B「模块级待办」= `test.todo(name)` 形态：本仓 **4** 条（历史遗留，**无回调 ⇒ 永不执行**）
//   运行期 `todo N` = A + B（当前 8）⇒ **运行期数字不得当棘轮基线**；
//   棘轮基线 = `registry.ratchet.openMax`（只描述 A 面）。
//
// ## 四道防呆（编号沿用 a1 的 1–4；本文件的用例号 L1–L5）
//
//   L1 = 第 1 道 **登记表锁**：内联 todo 的 id 集合 ≡ `registry.open` 的 id 集合（**双向**）
//   L2 + L4 = 第 2 道 **数量棘轮**（+ 第 4 道「每条必挂 AC + lane」一并落在这里）
//   L3 = 第 2 道④ **禁止回退到无回调形态**：模块级 todo 只允许白名单内既有条目
//   L5 = 第 3 道 **AC-T5 退场硬门**（根治项）：`OPEN_TODOS = ∅`，武装跑必红/必绿
//
// ## 计数口径（**复用仓内唯一内核**，不新造第二套）
//
// `countSource(src).todos` 走 `codeOnly()` —— 注释与字符串里的同形文本**不计**（与测试基线同口径）。
// 本文件的内联 todo 扫描同款：先在 `codeOnly(src)` 上定位**代码位**，再从**原始源**同位取消息
// （字符串内容被 mask 掉了，所以消息只能回原文取）。
//
// ## 跑法
//
//   node --import ./test/helpers/isolated-home.preload.mjs --test test/forward-todo-lock.test.js
//   # 退场硬门武装跑（AC-T5）：
//   PUNKY_AC_T5=1 node --import ./test/helpers/isolated-home.preload.mjs --test test/forward-todo-lock.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOnly, countSource, listTestFiles } from '../scripts/baseline-snapshot-core.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_REL = 'test/forward-todo-registry.json';
const registry = JSON.parse(fs.readFileSync(path.join(PKG, REGISTRY_REL), 'utf8'));

/**
 * 内联 todo 的**头部**识别式（在 `codeOnly` 结果上跑 ⇒ 注释/字符串内的同形文本不计）。
 * ⚠ 这里刻意不写完整字面量：本文件自身也在扫描面内，写出完整字面量会把 `grep -rc` 的口径污染掉。
 */
const INLINE_HEAD_RE = /\{\s*todo\s*:/g;
/** 从**原始源**同位取消息（mask 会抹掉字符串内容，故只能回原文取）。 */
const INLINE_FULL_RE = /\{\s*todo\s*:\s*'((?:[^'\\]|\\.)*)'/;
/** 登记表要求的 id 前缀形态：消息必须以 `[<registry id>] ` 起头。 */
const ID_PREFIX_RE = /^\[([^\]]+)\]\s+/;

const relAbs = (rel) => path.join(PKG, ...rel.split('/'));

/** 扫全 `test/**\/*.test.js`，收内联 todo：`{ file, line, id, message, hasIdPrefix }`。 */
function scanInlineTodos() {
  const out = [];
  for (const rel of listTestFiles(PKG)) {
    const raw = fs.readFileSync(relAbs(rel), 'utf8');
    const masked = codeOnly(raw);
    for (const head of masked.matchAll(INLINE_HEAD_RE)) {
      const tail = raw.slice(head.index);
      const full = tail.match(INLINE_FULL_RE);
      const message = full ? full[1] : null;
      out.push({
        file: rel,
        line: raw.slice(0, head.index).split('\n').length,
        message,
        id: message ? (message.match(ID_PREFIX_RE)?.[1] ?? null) : null,
        hasIdPrefix: Boolean(message && ID_PREFIX_RE.test(message)),
      });
    }
  }
  return out;
}

/** 模块级 `test.todo(name)` 的每文件计数（内核口径：code-masked ⇒ 注释/字符串不计）。 */
function moduleLevelTodoCounts() {
  const out = {};
  for (const rel of listTestFiles(PKG)) {
    const n = countSource(fs.readFileSync(relAbs(rel), 'utf8')).todos;
    if (n > 0) out[rel] = n;
  }
  return out;
}

// ══ 第 1 道 · 登记表锁（集合相等，双向）══════════════════════════════════════════
test('L1 登记表锁：内联 todo 的 id 集合 ≡ registry.open 的 id 集合（双向相等）', () => {
  const actual = scanInlineTodos();
  const unPrefixed = actual.filter((x) => !x.hasIdPrefix);
  assert.deepEqual(unPrefixed.map((x) => x.file + ':' + x.line), [],
    '每条内联 todo 的消息必须以 `[<registry id>] ` 起头（否则无法与登记表对齐 ⇒ 视为未登记）');

  const actualIds = actual.map((x) => x.id).sort();
  const regIds = registry.open.map((x) => x.id).sort();
  assert.deepEqual(actualIds, regIds,
    '双向集合相等：① 新增内联 todo 但未登记 ⇒ 红（防「悄悄加」）'
    + '；② registry 残留已转正的条目 ⇒ 红（防「悄悄收」）'
    + '\n实际=' + JSON.stringify(actualIds) + '\n登记=' + JSON.stringify(regIds));
});

// ══ 第 2 道 · 数量棘轮 + 第 4 道 · 每条必挂 AC + lane ═══════════════════════════════
test('L2 棘轮 + 每条挂 AC/dueLane：OPEN ≤ openMax、id 唯一、必填字段非空、file 与登记一致', () => {
  const open = registry.open;
  assert.ok(Array.isArray(open), 'registry.open 必须是数组');

  // 第 2 道 ①：棘轮上限
  assert.ok(open.length <= registry.ratchet.openMax,
    'OPEN 数不得增长（棘轮只许收紧）：openMax=' + registry.ratchet.openMax + ' 实际=' + open.length);

  // 第 2 道 ② + 第 4 道：必挂 AC 与 lane（禁「以后再说」）
  for (const item of open) {
    assert.ok(typeof item.id === 'string' && item.id.trim().length > 0, 'id 必须非空字符串');
    assert.ok(Array.isArray(item.ac) && item.ac.length > 0
      && item.ac.every((a) => typeof a === 'string' && a.trim().length > 0),
      item.id + '：ac 必须是非空字符串数组（每条 todo 必挂 AC —— 让「todo 未清」在 audit 时表现为某条 AC 不绿）');
    for (const key of ['file', 'title', 'dueLane', 'dueBatch', 'greenWhen']) {
      assert.ok(typeof item[key] === 'string' && item[key].trim().length > 0,
        item.id + '：`' + key + '` 必须非空（禁「以后再说」；dueLane 点名责任 lane，greenWhen 点名转正条件）');
    }
  }

  const ids = open.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'registry 内 id 不得重复：' + JSON.stringify(ids));

  // 第 2 道 ③：内联条数 = registry OPEN 数（与 L1 的集合相等互为交叉核对）
  const inline = scanInlineTodos();
  assert.equal(inline.length, open.length,
    '内联 todo 条数必须 = registry OPEN 数：inline=' + inline.length + ' open=' + open.length);

  // 定位一致性：登记表里的 file 必须与该 todo 实际所在文件一致（防「登记了但指错文件」）
  for (const x of inline) {
    const item = open.find((o) => o.id === x.id);
    assert.ok(item, x.id + ' 不在 registry');
    assert.equal(x.file, item.file,
      x.id + '：file 与登记不一致（registry=' + item.file + ' 实际=' + x.file + '）');
  }
});

test('L4 棘轮基线 = 内联面（**不是**运行期 todo 数）：openMax ≡ OPEN 数，且显式记录两者不等', () => {
  // 第 2 道「两机制分开数」的机检形态：棘轮上限必须**等于内联面条数**（冻结时点），
  // 且必须**不等于**运行期 todo 总数 —— 后者是 A+B 之和，拿它当基线会让棘轮口径漂移。
  assert.equal(registry.ratchet.openMax, registry.open.length,
    'openMax 必须等于当前 OPEN 数（清零 todo 时须**同步收紧** openMax：棘轮只许收紧，不许上调）');
  assert.notEqual(registry.ratchet.runtimeTodoTotal, registry.ratchet.openMax,
    '运行期 todo 总数（A+B）不得等于棘轮基线（A）—— 若相等，说明两个机制被混成了一个计数');

  const inline = scanInlineTodos().length;
  const moduleLevel = Object.values(moduleLevelTodoCounts()).reduce((a, b) => a + b, 0);
  process.stdout.write('[forward-todo] 分列读数：inline(A)=' + inline
    + ' moduleLevel(B)=' + moduleLevel
    + ' runtime(A+B)=' + (inline + moduleLevel)
    + ' openMax=' + registry.ratchet.openMax + '\n');
  assert.equal(inline, registry.ratchet.openMax, '实测内联条数必须 = openMax');
});

// ══ 第 2 道 ④ · 禁止回退到「无回调 test.todo」形态 ══════════════════════════════════
test('L3 禁止回退到无回调形态：模块级 test.todo 只允许白名单内既有条目（新增即红）', () => {
  const counts = moduleLevelTodoCounts();
  assert.deepEqual(counts, registry.ratchet.moduleLevelTodoWhitelist,
    '模块级 test.todo 只允许白名单内的既有条目（白名单只许减不许增）'
    + '\n白名单=' + JSON.stringify(registry.ratchet.moduleLevelTodoWhitelist)
    + '\n实测=' + JSON.stringify(counts));
});

// ══ 第 3 道 · AC-T5 拆分批退场硬门（根治项）════════════════════════════════════════
const AC_T5_ARMED = process.env[registry.acT5.armEnv] === '1';
test('L5 AC-T5 拆分批退场硬门：OPEN_TODOS = ∅',
  { skip: AC_T5_ARMED ? false : '未武装（退场时以 ' + registry.acT5.armEnv + '=1 运行本文件）' },
  () => {
    assert.deepEqual(registry.open.map((x) => x.id), [],
      'AC-T5（根治项）：拆分批退场时 OPEN_TODOS 必须为 ∅ —— 4 条全部转成正式断言并删除登记表条目，'
      + '否则拆分批**不得判绿**。当前未清零的条目=' + JSON.stringify(registry.open.map((x) => x.id)));
  });
