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

// F3 · 注释锚点清零（F2-G03 / F2-G04）＋ TOCTOU 锤点结构面（F2-G10）验收套件 —— spec AC-8 / AC-9。
//
// 判据形态纪律：
//   · 「死锚点清零」以 **`lib/` 面**为硬判据（spec AC-9(1)(2) 的原文判据就是 `grep -rn … lib/`）；
//     包内其余命中单独列出并断言**只落在 `progress/`**（coder 历史叙述，不是代码面/文档面）。
//   · **新锚点可核**用脚本化判据（AC-9(3)）：抽 `lib/**.js|ts:<行号>` 与 `lib/**.js|ts#<符号>` 两种形态，
//     逐个断言「文件存在 ∧ 行号在界内」/「文件含该符号」。
//   · 存量死锚点（本批开工前**已在 HEAD 版本中存在**、且不在本批写域）登记为基线集合，
//     判据取 **子集** 语义：**只禁新增**、不禁它们被顺手修好（修好 ⇒ 集合变小，仍绿）。
//   · TOCTOU：本批是**收窄**不是闭合 ⇒ 只判结构面（判据点数 / 锤点唯一性 / 四要素在场），
//     **不**判「已闭合」（P6 残余窗口在 e2 探针里如实为 RED）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB_ROOT = path.join(PKG_ROOT, 'lib');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.cache']);

function walkFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(abs, out);
    else out.push(abs);
  }
  return out;
}
const relOf = (abs) => path.relative(PKG_ROOT, abs).replace(/\\/g, '/');
/** 全量字面量命中（含注释；逐处返回 `相对路径:行号`）。 */
function literalHits(files, literal) {
  const hits = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    let from = 0;
    for (;;) {
      const at = text.indexOf(literal, from);
      if (at === -1) break;
      hits.push(relOf(file) + ':' + (text.slice(0, at).split('\n').length));
      from = at + literal.length;
    }
  }
  return hits;
}

// ── AC-9(1)(2) 死锚点清零 ─────────────────────────────────────────────────────
const DEAD_ANCHORS = [
  'core.js:712',
  'core.js:612',
  'core.js:619',
  'store.js:541',
  'store.js:527',
  'store.js:463',
];

test('T-4/AC-9(2) 六个死行号锚点在 lib/ 全量 0 命中', () => {
  const libFiles = walkFiles(LIB_ROOT);
  assert.ok(libFiles.length > 100, '前置：lib/ 文件枚举成功（实测 ' + libFiles.length + ' 件）');
  for (const anchor of DEAD_ANCHORS) {
    assert.deepEqual(literalHits(libFiles, anchor), [], 'lib/ 内不得再出现死锚点 `' + anchor + '`');
  }
});

test('T-4/AC-9(2) 包内其它命中只允许落在 progress/（历史叙述），不得落代码面/文档面', () => {
  const all = walkFiles(PKG_ROOT);
  // 判据的**载体**文件必然包含这些字面量（`DEAD_ANCHORS` 常量）⇒ 白名单 = {progress/**, 本文件自身}。
  const self = relOf(fileURLToPath(import.meta.url));
  const outside = all.filter((f) => {
    const rel = relOf(f);
    return !rel.startsWith('progress/') && rel !== self;
  });
  for (const anchor of DEAD_ANCHORS) {
    assert.deepEqual(literalHits(outside, anchor), [], '死锚点 `' + anchor + '` 只允许在 progress/（历史叙述）出现');
  }
});

test('T-4/AC-9(1) tier-gate.js 内 `cordis.yml:293-304` 0 命中；`cordis.yml:770-780` 仅允许 D4b 测试面约束处', () => {
  const tierGate = path.join(LIB_ROOT, 'tools', 'tier-gate.js');
  assert.equal(fs.existsSync(tierGate), true);
  assert.deepEqual(literalHits([tierGate], 'cordis.yml:293-304'), [], '不可复核的宿主行号区段必须拔净');

  // `cordis.yml:770-780` = **允许保留**的仓库外锚点（`test/f2-dispatch-desc-and-docs.test.js` D4b 硬要求在场）
  //   ⇒ 本判据只钉「不许扩散」：tier-gate 内至多 1 处；且全 lib/ 内出现处必须 ⊆ 已登记的三处载体。
  const hitsInTierGate = literalHits([tierGate], 'cordis.yml:770-780');
  assert.ok(hitsInTierGate.length <= 1, '`cordis.yml:770-780` 在 tier-gate 内至多 1 处（实测 ' + JSON.stringify(hitsInTierGate) + '）');
  const libHits = literalHits(walkFiles(LIB_ROOT), 'cordis.yml:770-780');
  const allowed = new Set([
    'lib/tools/tier-gate.js',
    'lib/engine/dispatch.js',
    'lib/bridge/dispatch-register.js',
  ]);
  const unexpected = libHits.map((h) => h.split(':')[0]).filter((f) => !allowed.has(f));
  assert.deepEqual(unexpected, [], '`cordis.yml:770-780` 不得扩散到新文件（followup 面，见批次报告）');
});

// ── AC-8 TOCTOU 锤点 + 判据点数（结构面，不判「已闭合」）─────────────────────────
const TOCTOU_FILES = [
  'lib/tools/log-tools.js',
  'lib/state/store/batch.js',
];
const TOCTOU_ELEMENTS = ['F2-G10', '未闭合', 'openat', '不构成提权'];

test('T-4/AC-8② 两处 TOCTOU 锤点各恰 1 处，且四要素在场（F2-G10 / 未闭合 / openat / 不构成提权）', () => {
  for (const rel of TOCTOU_FILES) {
    const file = path.join(PKG_ROOT, rel);
    assert.equal(fs.existsSync(file), true, '锤点文件必须存在：' + rel);
    const text = fs.readFileSync(file, 'utf8');
    const count = text.split('TOCTOU-RESIDUAL').length - 1;
    assert.equal(count, 1, rel + ' 内 `TOCTOU-RESIDUAL` 必须恰 1 处（实测 ' + count + '）');
    for (const element of TOCTOU_ELEMENTS) {
      assert.ok(text.includes(element), rel + ' 的锤点注释必须含要素 `' + element + '`（残余登记四要素）');
    }
    // 措辞纪律：残余面不得表述为「已修复 / 已根治 / 彻底解决」
    for (const banned of ['已修复', '已根治', '彻底解决']) {
      const at = text.indexOf(banned);
      const inResidual = at !== -1 && text.slice(Math.max(0, at - 400), at).includes('TOCTOU-RESIDUAL');
      assert.equal(inResidual, false, rel + ' 不得用 `' + banned + '` 描述残余窗口');
    }
  }
});

test('T-4/AC-8① log-tools 的写面判据恰 2 次（首判 + mkdir 后复判）；旧文案已拔净、单点文案在场', () => {
  const logTools = fs.readFileSync(path.join(LIB_ROOT, 'tools', 'log-tools.js'), 'utf8');
  const callCount = logTools.split('resolveWriteTargetIn(').length - 1;
  assert.equal(callCount, 2, '写面判据调用点必须恰 2 次（首判 + 复判；import 行不算调用点）');
  // 复判必须在 `mkdirSync` 之后（顺序不可调：复判的意义就是看 mkdir 新建的中间段）
  const mkdirAt = logTools.indexOf('fs.mkdirSync(path.dirname(dest)');
  const secondCallAt = logTools.indexOf('resolveWriteTargetIn(', logTools.indexOf('resolveWriteTargetIn(') + 1);
  assert.ok(mkdirAt !== -1 && secondCallAt > mkdirAt, '复判必须在 mkdir 之后（否则收窄不成立）');

  // 判据单点：旧文案（claimAsset 本地词法判据的）已拔净；单点文案只出自 batch-paths.js
  const libFiles = walkFiles(LIB_ROOT);
  assert.deepEqual(literalHits(libFiles, 'target escapes artifacts dir'), [], '旧词法判据文案必须拔净（判据已归一单点）');
  const singlePoint = literalHits(libFiles, "writeTo escapes artifacts dir: ");
  const fromBatchPaths = singlePoint.filter((h) => h.startsWith('lib/state/batch-paths.js'));
  assert.ok(fromBatchPaths.length >= 1, '单点文案必须出自 lib/state/batch-paths.js（实测 ' + JSON.stringify(singlePoint) + '）');
});

// ── AC-9(3) 新锚点可核（脚本化）───────────────────────────────────────────────
// 本批触碰的 9 个文件（注释面改动集中在这里）。
const TOUCHED = [
  'lib/state/store.js',
  'lib/state/store/batch.js',
  'lib/tools/member-tools.js',
  'lib/tools/log-tools.js',
  'lib/engine/auto-settle.js',
  'lib/types/contracts.ts',
  'lib/engine/dispatch.js',
  'lib/bridge/dispatch-register.js',
  'lib/tools/tier-gate.js',
];
// **存量**死锚点基线（已用 `git show HEAD:<file>` 逐条确认：本批开工前就在 HEAD 里存在，
//   且落点不在本批写域 ⇒ 登记 followup，不许顺手改）。判据取**子集**语义 ⇒ 只禁新增。
const KNOWN_DEAD = new Set([
  'lib/engine/auto-settle.js -> lib/state/gates.ts:1220', // gates.ts 实为 304 行
  'lib/engine/auto-settle.js -> lib/state/store.js:569',  // store.js 实为 441 行
  'lib/engine/auto-settle.js -> lib/engine/chain-runner.js:111', // 该文件已随链退役删除
  'lib/types/contracts.ts -> lib/sig-fingerprint.js#recordSigDuplicate', // 符号已不存在
  'lib/engine/dispatch.js -> lib/engine/chain-runner.js:51', // 同上（文件已删）
  'lib/engine/dispatch.js -> lib/tools/core.js#reportTargetOf', // 符号已不存在
]);

test('T-4/AC-9(3) 本批触碰文件内的锚点可核：不得新增死锚点（存量 6 条已登记 followup）', () => {
  // 前置：`lib/...` 必须是路径起点（排除 `node_modules/x/lib/index.js:3155` 这类**包内路径片段**的误抽）
  const lineRe = /(?<![\/\w.])lib\/[\w.\/-]+\.(?:js|ts):(\d+)/g;
  const symRe = /(?<![\/\w.])lib\/[\w.\/-]+\.(?:js|ts)#([A-Za-z_$][\w$]*)/g;
  const dead = [];
  let total = 0;
  for (const rel of TOUCHED) {
    const text = fs.readFileSync(path.join(PKG_ROOT, rel), 'utf8');
    for (const m of text.matchAll(lineRe)) {
      total += 1;
      const ref = m[0].slice(0, m[0].lastIndexOf(':'));
      const lineNo = Number(m[1]);
      const abs = path.join(PKG_ROOT, ref);
      const lineCount = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').split('\n').length : -1;
      if (lineCount === -1 || lineNo > lineCount) dead.push(rel + ' -> ' + m[0]);
    }
    for (const m of text.matchAll(symRe)) {
      total += 1;
      const ref = m[0].slice(0, m[0].indexOf('#'));
      const sym = m[1];
      const abs = path.join(PKG_ROOT, ref);
      const ok = fs.existsSync(abs) && fs.readFileSync(abs, 'utf8').includes(sym);
      if (!ok) dead.push(rel + ' -> ' + m[0]);
    }
  }
  assert.ok(total >= 30, '前置：锚点抽取有效（实测 ' + total + ' 条）');
  const introduced = dead.filter((d) => !KNOWN_DEAD.has(d));
  assert.deepEqual(introduced, [], '不得新增不可复核锚点（本批新写锚点必须「文件存在 ∧ 行号在界内」或「文件含该符号」）');
});

// ── RED 基线：六个死锚点在 HEAD 版本里真实存在（⇒ 同一条判据在修前必红）────────────────
//   ⚠ 例外（如实登记）：`cordis.yml:293-304` 在 `tier-gate.js` 的**引入**发生在 F1/F2 的未提交改动里
//   （`git show HEAD:./lib/tools/tier-gate.js` 内 0 命中）⇒ 该项**不能**用 HEAD 作 RED 基线，
//   RED 证据 = `exec/change-desc.md` §一.4 的改前原文（人工核对，不在本件伪造断言）。
test('T-4 RED 基线：六条死锚点在 HEAD 版本中存在（同一 grep 在修前为红）', () => {
  const head = (file) => execFileSync('git', ['show', '294b4f9:./' + file], { cwd: PKG_ROOT, encoding: 'utf8' });
  const headAutoSettle = head('lib/engine/auto-settle.js');
  const headContracts = head('lib/types/contracts.ts');
  const headTierGate = head('lib/tools/tier-gate.js');
  assert.ok(headAutoSettle.includes('core.js:712'), 'RED：HEAD 的 auto-settle.js 引了死锚点 core.js:712');
  for (const anchor of ['store.js:541', 'store.js:527', 'store.js:463']) {
    assert.ok(headContracts.includes(anchor), 'RED：HEAD 的 contracts.ts 引了死锚点 ' + anchor);
  }
  // `core.js:612` / `:619` 在 HEAD 里是**连写形态**（`lib/tools/core.js:612/619`）⇒ 按原文形态断言：
  assert.ok(headContracts.includes('core.js:612'), 'RED：HEAD 的 contracts.ts 引了死锚点 core.js:612');
  assert.ok(headContracts.includes('core.js:612/619'), 'RED：HEAD 的 :619 以连写形态 `612/619` 出现（本批已整段改写）');
  // 反向证据：HEAD 的 tier-gate 里 **没有** 这两个 cordis 锚点 ⇒ 该项的 RED 基线取 change-desc，不取 HEAD
  assert.equal(headTierGate.includes('cordis.yml:293-304'), false);
  assert.equal(headTierGate.includes('cordis.yml:770-780'), false);
});

// ── 本批锚点修正的「可核性」阳性对照（不是恒真：这些符号/文件必须真的在）────────────────
test('T-4/AC-9(3) 阳性对照：本批新引的符号锚点逐个可核', () => {
  const expectations = [
    ['lib/state/task-utils.js', 'findTask'],                     // C-14 新锚点
    ['lib/tools/member-tools.js', 'GATE_EXEMPT_NOT_DISPATCH'],   // C-15 新锚点（两处 throw 的码字面量）
    ['lib/state/store/member.js', 'setMember'],                  // contracts.ts 新锚点
    ['lib/state/store/member-exempt.js', 'buildMemberExempt'],   // contracts.ts 新锚点
    ['presets/punky-preset/agent.cordis.yml', 'tool-subagent'],  // C-11/C-13 新锚点（preset 层可核文件）
  ];
  for (const [rel, symbol] of expectations) {
    const abs = path.join(PKG_ROOT, rel);
    assert.equal(fs.existsSync(abs), true, '锚点文件必须存在：' + rel);
    assert.ok(fs.readFileSync(abs, 'utf8').includes(symbol), rel + ' 必须含符号原文：' + symbol);
  }
  // 死锚点归属的另一半证据：`lib/tools/core.js` 里确实没有那两个符号（防止「符号写错但文件对」的假绿）
  const core = fs.readFileSync(path.join(LIB_ROOT, 'tools', 'core.js'), 'utf8');
  assert.equal(core.includes('reportTargetOf'), false, '前置：core.js 内确无 reportTargetOf（存量死锚点确为死锚点）');
  // `lib/engine/chain-runner.js` 已被删除（链退役）⇒ 引用它的存量锚点结构性不可核
  assert.equal(fs.existsSync(path.join(LIB_ROOT, 'engine', 'chain-runner.js')), false);
});

// ── 读数辅助：git 侧确认存量死锚点「非本批引入」（只读 git，不写仓库）─────────────────
test('T-4/AC-9(3) 存量死锚点在 HEAD 版本中已存在（证明非本批引入，只读 git show）', () => {
  const probes = [
    ['lib/engine/auto-settle.js', 'lib/state/gates.ts:1220'],
    ['lib/engine/auto-settle.js', 'lib/state/store.js:569'],
    ['lib/engine/auto-settle.js', 'lib/engine/chain-runner.js:111'],
    ['lib/types/contracts.ts', 'lib/sig-fingerprint.js#recordSigDuplicate'],
    ['lib/engine/dispatch.js', 'lib/engine/chain-runner.js:51'],
    ['lib/engine/dispatch.js', 'lib/tools/core.js#reportTargetOf'],
  ];
  for (const [file, anchor] of probes) {
    const headSource = execFileSync('git', ['show', '294b4f9:./' + file], { cwd: PKG_ROOT, encoding: 'utf8' });
    assert.ok(headSource.includes(anchor), '存量死锚点 `' + anchor + '` 必须已存在于 HEAD 的 ' + file + '（否则它就是本批引入的）');
  }
});
