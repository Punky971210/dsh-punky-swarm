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

// F3 · `claimAsset` 写面收敛（F2-G01）验收套件 —— spec AC-4 / AC-5。
//
// 缺陷形态（修前）：`path.resolve(dest).startsWith(base)` 是**纯词法**判据 ⇒ 产物根内建一个指向根外的
//   junction 会被判「在根内」，随后 `copyFileSync` 跟随重解析点**真实写到根外**。
//
// 判据形态纪律：
//   · 负数断言（junction → 根外必拒）配**同输入形态的阳性对照**（只换目录性质 ⇒ 正常落盘）；
//   · 「根外零落盘」必须同时断言「批次未被写」（rev / 事件数逐字不变）—— 只判文件不在场会漏掉
//     「先写根外、再回滚事件」这类假绿；
//   · 静态单点判据：`startsWith(base)` 在全 `lib/` **0 命中**（含注释：注释复述该字面量同样会污染判据）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { tempRoot } from './helpers/gate-fixture.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB_ROOT = path.join(PKG_ROOT, 'lib');
const S = 'sess-f3-claim';

function batchFileOf(root, batchId) {
  return path.join(root, 'sessions', S, 'batches', batchId + '.json');
}
function readDisk(root, batchId) {
  return JSON.parse(fs.readFileSync(batchFileOf(root, batchId), 'utf8'));
}
function claimEventCount(root, batchId) {
  return (readDisk(root, batchId).events ?? []).filter((e) => e && e.type === 'asset.claimed').length;
}
function newBatch(store, batchId) {
  return store.createBatch(S, { batchId, wavePlan: buildWavePlan({ batchId, tasks: [{ id: 'x' }] }) });
}
/** 递归列出目录下全部文件（只读；用于静态字面量判据）。 */
function walkFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(abs, out);
    else out.push(abs);
  }
  return out;
}
/** 统计若干文件内某**字面量**出现次数（逐文件逐处计数，含注释）。 */
function countLiteral(files, literal) {
  const hits = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    let from = 0;
    for (;;) {
      const at = text.indexOf(literal, from);
      if (at === -1) break;
      hits.push(path.relative(PKG_ROOT, file) + '@' + text.slice(0, at).split('\n').length);
      from = at + literal.length;
    }
  }
  return hits;
}

test('T-2/AC-5 根内 junction → 根外：必拒 + 根外零落盘 + 批次未被写；阳性对照：正常 claim 可写', () => {
  const root = tempRoot('f3-claim-');
  const store = createStore(root);
  newBatch(store, 'b-a');
  const artifacts = store.artifactsDirOf(S, 'b-a');
  fs.mkdirSync(artifacts, { recursive: true });

  // 根外目录（真实不存在的写入面），根内建 junction 指向它
  const outside = tempRoot('f3-claim-outside-');
  const link = path.join(artifacts, 'link');
  fs.symlinkSync(outside, link, 'junction');
  assert.equal(fs.existsSync(link), true, '前置：junction 必须建成功（否则本用例不构成逃逸构造）');

  const src = path.join(root, 'claim-src.md');
  fs.writeFileSync(src, 'ESCAPE-PAYLOAD');
  const revBefore = readDisk(root, 'b-a').__rev;
  const evBefore = claimEventCount(root, 'b-a');

  let err = null;
  try { store.claimAsset(S, 'b-a', { source: src, target: 'link/escaped.md' }); } catch (e) { err = e; }

  // ① 必拒（文案为单点统一文案）
  assert.ok(err, 'junction → 根外必须拒（修前此处静默写成根外文件）');
  assert.match(String(err.message), /writeTo escapes artifacts dir/, '文案须为写面单点文案');
  // ② 根外零落盘
  assert.equal(fs.existsSync(path.join(outside, 'escaped.md')), false, '根外零落盘（判据必须在 copy 之前）');
  // ③ 批次未被写（rev / 事件数逐字不变）——防「先写后回滚」式假绿
  assert.equal(readDisk(root, 'b-a').__rev, revBefore, '被拒档不得推进 rev');
  assert.equal(claimEventCount(root, 'b-a'), evBefore, '被拒档不得落 asset.claimed 事件');

  // ④ 阳性对照：同输入形态，只换目录性质（普通子目录）⇒ 必成功
  const okClaim = store.claimAsset(S, 'b-a', { source: src, target: 'plain/ok.md' });
  assert.equal(okClaim.ok, true);
  assert.equal(okClaim.claimedPath, 'plain/ok.md');
  assert.equal(fs.readFileSync(path.join(artifacts, 'plain', 'ok.md'), 'utf8'), 'ESCAPE-PAYLOAD', '内容逐字相等');
  assert.equal(readDisk(root, 'b-a').__rev, revBefore + 1, '成功档 rev +1（写面确经 commitBatch）');
  assert.equal(claimEventCount(root, 'b-a'), evBefore + 1, '成功档恰 1 条 asset.claimed');
});

test('T-2/AC-5 词法逃逸仍拒（纵深防御不减）：.. / 根外绝对 / 盘符 / . 段 / 反斜杠 ..', () => {
  const root = tempRoot('f3-claim-lex-');
  const store = createStore(root);
  newBatch(store, 'b-lex');
  const src = path.join(root, 'lex-src.md');
  fs.writeFileSync(src, 'x');
  const bad = ['../evil.txt', 'a/../../evil.txt', 'C:\\abs.txt', '/abs.txt', 'C:x.txt', 'a/./b.txt', 'a\\..\\b.txt'];
  const artifacts = store.artifactsDirOf(S, 'b-lex');
  for (const target of bad) {
    assert.throws(() => store.claimAsset(S, 'b-lex', { source: src, target }), '词法逃逸必须仍拒：' + target);
  }
  // 逃逸未在产物根的父层留下文件（旧断言形态，逐字保留）
  assert.equal(fs.existsSync(path.join(artifacts, '..', 'evil.txt')), false);
  // 阳性对照：合法相对路径可写
  assert.equal(store.claimAsset(S, 'b-lex', { source: src, target: 'a/b.txt' }).ok, true);
});

test('T-2/AC-5 artifacts 根尚不存在档：allowMissing 不误拒（首次 claim 可写）', () => {
  const root = tempRoot('f3-claim-missing-');
  const store = createStore(root);
  newBatch(store, 'b-new');
  const artifacts = store.artifactsDirOf(S, 'b-new');
  fs.rmSync(artifacts, { recursive: true, force: true }); // 前置：根不存在
  assert.equal(fs.existsSync(artifacts), false);
  const src = path.join(root, 'missing-src.md');
  fs.writeFileSync(src, 'FIRST-CLAIM');
  const r = store.claimAsset(S, 'b-new', { source: src, target: 'sub/ok.md' });
  assert.equal(r.ok, true, 'artifacts 根不存在时不得误判为逃逸');
  assert.equal(fs.readFileSync(path.join(artifacts, 'sub', 'ok.md'), 'utf8'), 'FIRST-CLAIM');
});

test('T-2/AC-8③ 静态单点：`startsWith(base)` 在全 lib/ 0 命中（含注释）', () => {
  const files = walkFiles(LIB_ROOT);
  assert.ok(files.length > 100, '前置：lib/ 文件枚举成功（实测 ' + files.length + ' 件）');
  const hits = countLiteral(files, 'startsWith(base)');
  assert.deepEqual(hits, [], '旧词法判据必须拔净（命中处 = ' + JSON.stringify(hits) + '）；'
    + '注意：注释里复述该字面量同样计入命中（本判据按字面量计，不看语法位置）');
});

// ── RED 基线（修前形态的可复现证据；不改仓库，只读 HEAD 与自己的临时根）────────────────
test('T-2 RED 基线：HEAD 仍是纯词法判据，且该判据真的把 junction 判「根内」并写到根外', () => {
  // ① 静态 RED：HEAD 版本 `claimAsset` 的判据 = 纯词法前缀比较
  const headSrc = execFileSync('git', ['show', 'HEAD:./lib/state/store/batch.js'], { cwd: PKG_ROOT, encoding: 'utf8' });
  assert.ok(headSrc.includes('startsWith(base)'),
    'RED 基线：HEAD 必须在场（若不成立 ⇒ 本组判据的「修前红」不成立，须重定基线）');

  // ② 运行期 RED 复现：用**旧判据的等价表达式**判 junction 路径 ⇒ 判「根内」；
  //    再按旧代码的后续步骤直接 copy ⇒ 根外**真的**出现文件（这就是 F2-G01 的实测形态）。
  const root = tempRoot('f3-claim-red-');
  const store = createStore(root);
  newBatch(store, 'b-red');
  const artifacts = store.artifactsDirOf(S, 'b-red');
  fs.mkdirSync(artifacts, { recursive: true });
  const outside = tempRoot('f3-claim-red-outside-');
  const link = path.join(artifacts, 'link');
  fs.symlinkSync(outside, link, 'junction');
  const src = path.join(root, 'red-src.md');
  fs.writeFileSync(src, 'RED-PAYLOAD');

  const dest = path.join(artifacts, 'link', 'legacy-escaped.md');
  const base = path.resolve(artifacts) + path.sep;
  assert.equal(path.resolve(dest).startsWith(base), true, '旧纯词法判据对 junction 路径判「根内」（放行）');
  fs.copyFileSync(src, dest); // 旧代码在该判据之后的动作：跟随重解析点写入
  assert.equal(fs.existsSync(path.join(outside, 'legacy-escaped.md')), true,
    'RED 复现：按旧判据的写入**真的**落到产物根外（F2-G01 缺陷形态成立）');

  // ③ 同一构造、目标换成新目标名 ⇒ GREEN：claimAsset 必须拒（判据已归一写面单点）
  let err = null;
  try { store.claimAsset(S, 'b-red', { source: src, target: 'link/green-escaped.md' }); } catch (e) { err = e; }
  assert.ok(err, 'GREEN：同一 junction 构造下 claimAsset 必须拒');
  assert.match(String(err.message), /writeTo escapes artifacts dir/);
  assert.equal(fs.existsSync(path.join(outside, 'green-escaped.md')), false, 'GREEN：根外零落盘');
});

// ── AC-4 rev 冲突后的有界重试（claimAsset 内建 REV_RETRY_MAX=3）──────────────────
test('T-2/AC-4 冲突后重试成功：asset.claimed 恰 1 条（冲突那次未落盘）、内容正确、rev 前进 2', () => {
  const root = tempRoot('f3-claim-retry-');
  let storeB;
  let armed = false;
  let hookCalls = 0;
  const storeA = createStore(root, {
    revRaceHook: ({ sessionId, batchId }) => {
      hookCalls += 1;
      if (!armed) return;
      armed = false; // 只在第 1 次提交前制造一次冲突（模拟对手抢先）
      storeB.appendEvent(sessionId, batchId, 'probe.opponent', {});
    },
  });
  storeB = createStore(root);
  newBatch(storeB, 'b-retry');

  const artifacts = storeB.artifactsDirOf(S, 'b-retry');
  fs.mkdirSync(artifacts, { recursive: true });
  const src = path.join(root, 'retry-src.md');
  fs.writeFileSync(src, 'RETRY-BODY');
  const rev0 = readDisk(root, 'b-retry').__rev;

  armed = true;
  const r = storeA.claimAsset(S, 'b-retry', { source: src, target: 'explore/retry.md' });

  assert.equal(r.ok, true, '冲突后重读再写 ⇒ 必须成功（内建重试）');
  assert.equal(r.claimedPath, 'explore/retry.md');
  // 冲突那次未落盘 ⇒ 事件不得重复（不得 2 条）
  assert.equal(claimEventCount(root, 'b-retry'), 1, 'asset.claimed 恰 1 条（冲突那次零落盘，否则会 2 条）');
  assert.equal(readDisk(root, 'b-retry').events.filter((e) => e.type === 'probe.opponent').length, 1);
  // 内容逐字相等
  assert.equal(fs.readFileSync(path.join(artifacts, 'explore', 'retry.md'), 'utf8'), 'RETRY-BODY');
  // rev == 基线 + 2（对手 1 + 本次 1）
  assert.equal(readDisk(root, 'b-retry').__rev, rev0 + 2);
  assert.equal(hookCalls, 2, 'commitBatch 恰被调用 2 次（首试冲突 + 重试成功）');
});

test('T-2/AC-4 越界重试有界放弃：对手每次抢先 ⇒ 抛冲突且零事件（不无限循环）', () => {
  const root = tempRoot('f3-claim-retry-cap-');
  let storeB;
  let armed = false;
  let hookCalls = 0;
  const storeA = createStore(root, {
    revRaceHook: ({ sessionId, batchId }) => {
      hookCalls += 1;
      if (!armed) return; // **每次**都提交：永不 disarm
      storeB.appendEvent(sessionId, batchId, 'probe.opponent', {});
    },
  });
  storeB = createStore(root);
  newBatch(storeB, 'b-cap');
  const artifacts = storeB.artifactsDirOf(S, 'b-cap');
  fs.mkdirSync(artifacts, { recursive: true });
  const src = path.join(root, 'cap-src.md');
  fs.writeFileSync(src, 'CAP');

  armed = true;
  let err = null;
  try { storeA.claimAsset(S, 'b-cap', { source: src, target: 'explore/cap.md' }); } catch (e) { err = e; }

  assert.ok(err, '重试耗尽必须抛（不得无限循环、不得静默成功）');
  assert.equal(err.code, 'BATCH_VERSION_CONFLICT');
  assert.equal(hookCalls, 3, '有界重试：commitBatch 恰 3 次（REV_RETRY_MAX=3，后放弃）');
  assert.equal(claimEventCount(root, 'b-cap'), 0, '耗尽档零 asset.claimed（每次冲突都未落盘）');
  // 残余 R-3（spec S3-2 明列）：copy 在重试循环外 ⇒ 失败档可能留孤儿产物。
  //   本用例**不断言**其在场/不在场（那是规格已登记的取舍，不是本批判据）；只断言语义面（抛错 + 零事件）。
});
