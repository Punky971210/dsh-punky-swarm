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

// 收据签名/哈希锚定（证据信封简版）。
// 载体：test/governance-receipt-anchor.test.js。
// 覆盖：H1 单收据 anchor / H2 多收据哈希链（prevHash 衔接）/ H3 canonical 确定性 /
//       H4 篡改检测（brokenAt 定位）/ H5 旧收据无 anchor 兼容 / H6 删中间收据缺链检测。
// 直接驱动 receipt-store.writeRefusal/verifyRefusals + hash-utils（收据构造直写，不绕 wiring）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeRefusal, readRefusals, verifyRefusals, refusalDirOf } from '../lib/governance/receipt-store.js';
import { canonicalize, sha256Hex, hashContent, makeAnchor } from '../lib/governance/hash-utils.js';
import { tempRoot } from './helpers/gate-fixture.mjs';


// 直写收据对象（绕过 wiring/kernel；ts 显式传——控制链序，隔离时钟噪声）
function receiptOf(id, ts, over = {}) {
  return {
    receiptId: id,
    ts,
    tool: 'bash',
    callId: 'call-' + id,
    sessionId: 'sess-h',
    decision: { primitive: 'DENY', priority: 2, reason: 'tamper-test ' + id },
    attemptedParams: { cmd: 'rm -rf /' },
    ruleRefs: ['R001'],
    ...over,
  };
}

function readReceipt(root, sessionId, receiptId) {
  const file = path.join(refusalDirOf(root, sessionId), receiptId + '.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ── H1：单收据 anchor（version/alg/prevHash=null/hash 非空且自洽）──
test('H1 single receipt anchor: version=1 alg=sha256 prevHash=null hash non-empty and self-consistent', () => {
  const root = tempRoot('gov-h1-');
  const receipt = receiptOf('h1-r1', '2026-08-31T00:00:00.000Z');
  writeRefusal(root, receipt);
  const onDisk = readReceipt(root, 'sess-h', 'h1-r1');
  assert.equal(onDisk.anchor.version, 1);
  assert.equal(onDisk.anchor.alg, 'sha256');
  assert.equal(onDisk.anchor.prevHash, null, '首收据 prevHash=null');
  assert.match(onDisk.anchor.hash, /^[0-9a-f]{64}$/, 'hash sha256 hex');
  // 自洽：重算一致
  assert.equal(hashContent(onDisk, null), onDisk.anchor.hash, 'hash 重算一致（覆盖除 anchor 外全部字段含 prevHash）');
  const vr = verifyRefusals(root, 'sess-h');
  assert.equal(vr.ok, true);
  assert.equal(vr.brokenAt, null);
  // 数量 → 身份集合（G1，外部锚 = 用例内已知 receiptId h1-r1）
  assert.deepEqual(vr.receipts.filter((x) => x.anchored).map((x) => x.receiptId), ['h1-r1'],
    '锚定收据集须恰为 [h1-r1]（实际: [' + vr.receipts.filter((x) => x.anchored).map((x) => x.receiptId).join(', ') + ']）');
  assert.equal(vr.receipts[0].ok, true);
  assert.equal(vr.receipts[0].anchored, true);
});

// ── H2：多收据哈希链（prevHash 衔接：第二条 prevHash=首条 hash，第三条=第二条 hash）──
test('H2 multi-receipt chain: prevHash links to previous hash in ts order', () => {
  const root = tempRoot('gov-h2-');
  writeRefusal(root, receiptOf('h2-r1', '2026-08-31T00:00:00.000Z'));
  writeRefusal(root, receiptOf('h2-r2', '2026-08-31T00:00:01.000Z'));
  writeRefusal(root, receiptOf('h2-r3', '2026-08-31T00:00:02.000Z'));
  const r1 = readReceipt(root, 'sess-h', 'h2-r1');
  const r2 = readReceipt(root, 'sess-h', 'h2-r2');
  const r3 = readReceipt(root, 'sess-h', 'h2-r3');
  assert.equal(r1.anchor.prevHash, null);
  assert.equal(r2.anchor.prevHash, r1.anchor.hash, '第二条 prevHash = 首条 hash');
  assert.equal(r3.anchor.prevHash, r2.anchor.hash, '第三条 prevHash = 第二条 hash');
  // 链序 = ts 序（readRefusals 升序一致）
  const all = readRefusals(root, 'sess-h');
  assert.deepEqual(all.map((r) => r.receiptId), ['h2-r1', 'h2-r2', 'h2-r3']);
  const vr = verifyRefusals(root, 'sess-h');
  assert.equal(vr.ok, true);
  // 数量 → 身份集合（G1，外部锚 = h2-r1..h2-r3）
  assert.deepEqual(vr.receipts.filter((x) => x.anchored).map((x) => x.receiptId).sort(), ['h2-r1', 'h2-r2', 'h2-r3'].sort(),
    '锚定收据集须恰为三份（实际: [' + vr.receipts.filter((x) => x.anchored).map((x) => x.receiptId).join(', ') + ']）');
  assert.ok(vr.receipts.every((x) => x.ok === true));
});

// ── H3：canonical 确定性（同对象两次一致 / 键序无关 / 哈希覆盖 body+prevHash 且不含 anchor 自身）──
test('H3 canonical determinism: same object twice same; key order independent; hash covers body+prevHash excluding anchor', () => {
  const obj = { b: 1, a: { d: [1, 2, { f: null, e: 'x' }], c: true } };
  assert.equal(canonicalize(obj), canonicalize(obj), '同对象两次序列化一致');
  // 键序无关（RFC8785 简版：键排序）
  const reordered = JSON.parse(JSON.stringify(obj));
  // 重新插入键序打乱：canonical 排序 → 与原文一致
  const shuffled = { a: obj.a, b: obj.b };
  assert.equal(canonicalize(reordered), canonicalize(shuffled), '键插入序不影响 canonical');
  assert.equal(canonicalize({ x: 1, y: undefined }), canonicalize({ x: 1 }), 'undefined 键跳过（对齐 JSON.stringify）');
  // 保留（不改数量形态）：`sha256Hex` 的输出长度是**算法契约常量**（hex 摘要定长 64 字符），
  // 与「对象规模快照」不同——它不随语料增长而变、无假红风险，改成存在性断言反而更弱（丢掉「定长」这条契约）。
  assert.equal(sha256Hex('abc').length, 64, 'sha256 hex 摘要定长 64 字符（算法契约，非规模快照）');
  // hash 覆盖除 anchor 外全部字段（含 prevHash）：改 prevHash → hash 变；anchor 自身字段不参与
  const base = receiptOf('h3-r1', '2026-08-31T00:00:00.000Z');
  const hNull = hashContent(base, null);
  const hOther = hashContent(base, 'a'.repeat(64));
  assert.notEqual(hNull, hOther, 'prevHash 参与哈希');
  assert.equal(hashContent(base, null), hashContent(base, null), '确定性：同输入同输出');
  // anchor 自身剥离：带 anchor 与不带 anchor 同 hash（anchor 不参与）
  const anchored = { ...base, anchor: { version: 1, alg: 'sha256', prevHash: null, hash: 'x'.repeat(64) } };
  assert.equal(hashContent(anchored, null), hNull, 'anchor 自身字段不参与哈希');
  // makeAnchor 自洽
  const anchor = makeAnchor(base, null);
  assert.equal(anchor.version, 1);
  assert.equal(anchor.prevHash, null);
  assert.equal(anchor.hash, hNull);
});

// ── H4：篡改检测（改 attemptedParams → verify ok:false + brokenAt 定位 + 后续链联动破坏）──
test('H4 tamper detection: modifying attemptedParams breaks verify with brokenAt locating tampered receipt', () => {
  const root = tempRoot('gov-h4-');
  writeRefusal(root, receiptOf('h4-r1', '2026-08-31T00:00:00.000Z'));
  writeRefusal(root, receiptOf('h4-r2', '2026-08-31T00:00:01.000Z'));
  writeRefusal(root, receiptOf('h4-r3', '2026-08-31T00:00:02.000Z'));
  assert.equal(verifyRefusals(root, 'sess-h').ok, true, '篡改前链完整');
  // 篡改中间收据 attemptedParams（盘上直改，不重锚）
  const file2 = path.join(refusalDirOf(root, 'sess-h'), 'h4-r2.json');
  const tampered = JSON.parse(fs.readFileSync(file2, 'utf8'));
  tampered.attemptedParams = { cmd: 'rm -rf / --tampered' };
  fs.writeFileSync(file2, JSON.stringify(tampered, null, 2), 'utf8');
  const vr = verifyRefusals(root, 'sess-h');
  assert.equal(vr.ok, false, '篡改后校验失败');
  assert.equal(vr.brokenAt, 'h4-r2', 'brokenAt 定位被篡改收据');
  const entry2 = vr.receipts.find((x) => x.receiptId === 'h4-r2');
  assert.equal(entry2.ok, false);
  assert.equal(entry2.issue, 'hash-mismatch', '篡改 → hash-mismatch');
  // 后续链联动：r2 若被重锚伪造（hash 同步改）→ r3 prevHash 指向旧 r2 hash → link-break
  const forged = { ...tampered, anchor: { ...tampered.anchor, hash: hashContent(tampered, tampered.anchor.prevHash) } };
  fs.writeFileSync(file2, JSON.stringify(forged, null, 2), 'utf8');
  const vr2 = verifyRefusals(root, 'sess-h');
  assert.equal(vr2.ok, false, '重锚伪造 r2 仍破坏链（r3 link-break）');
  assert.equal(vr2.brokenAt, 'h4-r3', 'r3 prevHash 指向旧 hash → 首个失败 = r3');
  assert.equal(vr2.receipts.find((x) => x.receiptId === 'h4-r3').issue, 'link-break');
});

// ── H5：旧收据无 anchor 兼容（混入无 anchor 旧收据 → verify 不炸、不参与链、不判失败；readRefusals 读回）──
test('H5 legacy receipt without anchor: readRefusals fine, verify skips legacy (no false failure)', () => {
  const root = tempRoot('gov-h5-');
  // 旧收据（无 anchor，P2 前形态）手动落盘
  const legacy = receiptOf('h5-legacy', '2026-08-30T00:00:00.000Z', { sessionId: 'sess-h' });
  delete legacy.anchor; // 明确无 anchor（旧收据无字段）
  const dir = refusalDirOf(root, 'sess-h');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'h5-legacy.json'), JSON.stringify(legacy, null, 2), 'utf8');
  // 新收据（writeRefusal 锚定）
  writeRefusal(root, receiptOf('h5-r1', '2026-08-31T00:00:00.000Z'));
  writeRefusal(root, receiptOf('h5-r2', '2026-08-31T00:00:01.000Z'));
  // readRefusals 全读回（含旧收据，不炸）
  const all = readRefusals(root, 'sess-h');
  // 数量 → 集合身份：读回 id 集须恰为「1 旧 + 2 新」（三件都按 id 点名，不漏不多）
  assert.deepEqual(all.map((r) => r.receiptId).sort(), ['h5-legacy', 'h5-r1', 'h5-r2'].sort(),
    'readRefusals 须读回 legacy + r1 + r2 三件（实际: [' + all.map((r) => r.receiptId).join(', ') + ']）');
  assert.ok(all.some((r) => r.receiptId === 'h5-legacy' && r.anchor === undefined), 'legacy 读回无 anchor');
  // verify：legacy 不参与链（anchored=false），链从首个锚定收据起（h5-r1 prevHash=null），整体 ok
  const vr = verifyRefusals(root, 'sess-h');
  assert.equal(vr.ok, true, '旧收据混入不破坏链校验');
  // 数量 → 集合身份（替代 `vr.count === 2`）：`vr.receipts` 含全部收据（旧收据以 anchored:false 在场），
  // `vr.count` 只数 anchored。故按 **anchored 子集** 断言「谁在链内」、按 **非 anchored 子集** 断言「谁被排除」——
  // 这比 `count===2` 更强：既锁链内身份，也锁旧收据仍被列出且明确不入链。
  const anchoredIds = vr.receipts.filter((x) => x.anchored).map((x) => x.receiptId).sort();
  const unanchoredIds = vr.receipts.filter((x) => !x.anchored).map((x) => x.receiptId);
  assert.deepEqual(anchoredIds, ['h5-r1', 'h5-r2'].sort(),
    '链内（anchored=true）须恰为两个锚定收据（实际: [' + anchoredIds.join(', ') + ']）');
  assert.deepEqual(unanchoredIds, ['h5-legacy'],
    '旧收据须在场但标 anchored=false（实际: [' + unanchoredIds.join(', ') + ']）');
  assert.equal(vr.count, anchoredIds.length, 'count 须等于 anchored 条目数（不得把旧收据计入链）');
  const legacyEntry = vr.receipts.find((x) => x.receiptId === 'h5-legacy');
  assert.equal(legacyEntry.anchored, false);
  assert.equal(legacyEntry.ok, true);
  const r1 = readReceipt(root, 'sess-h', 'h5-r1');
  assert.equal(r1.anchor.prevHash, null, '链自首个锚定收据起（prevHash=null）');
});

// ── H6：删中间收据 → 缺链检测（后继 prevHash 指向已删 hash → link-break 定位）──
test('H6 deleted middle receipt: verify detects missing link at successor', () => {
  const root = tempRoot('gov-h6-');
  writeRefusal(root, receiptOf('h6-r1', '2026-08-31T00:00:00.000Z'));
  writeRefusal(root, receiptOf('h6-r2', '2026-08-31T00:00:01.000Z'));
  writeRefusal(root, receiptOf('h6-r3', '2026-08-31T00:00:02.000Z'));
  assert.equal(verifyRefusals(root, 'sess-h').ok, true);
  // 删中间收据 r2
  fs.unlinkSync(path.join(refusalDirOf(root, 'sess-h'), 'h6-r2.json'));
  const vr = verifyRefusals(root, 'sess-h');
  assert.equal(vr.ok, false, '缺链检测触发');
  assert.equal(vr.brokenAt, 'h6-r3', 'r3 prevHash 指向已删 r2 hash → 首个失败 = r3');
  assert.equal(vr.receipts.find((x) => x.receiptId === 'h6-r3').issue, 'link-break');
  // 数量 → 身份集合（G1）：删掉 h6-r2 后须恰剩 h6-r1/h6-r3（删错份也红）
  assert.deepEqual(vr.receipts.filter((x) => x.anchored).map((x) => x.receiptId).sort(), ['h6-r1', 'h6-r3'].sort(),
    '现存锚定收据集须恰为 h6-r1/h6-r3（实际: [' + vr.receipts.filter((x) => x.anchored).map((x) => x.receiptId).join(', ') + ']）');
});

// ── 【⑥-3 · 2026-11-08 裁决甲】链尾缓存 ─────────────────────────────────────────────
//   背景：`writeRefusal` 每次都经 `chainTail` → `readDirReceipts` 把目录下全部收据读一遍
//   （为算锚链前驱）⇒ 实测 3.6ms@5 / 23.9ms@100 / 44.1ms@115，而护栏每次拒绝都走一次。
//   缓存口径 = 「链尾 + 该目录 mtimeMs 快照」，任何目录内容变化都会让 mtime 漂移 ⇒ 自动重建。

test('C1 缓存下锚链仍完整：连续写 50 条 ⇒ verifyRefusals().ok（缓存不得改变链序语义）', () => {
  const root = tempRoot('gov-c1-');
  const base = Date.parse('2026-09-01T00:00:00.000Z');
  for (let i = 0; i < 50; i++) {
    writeRefusal(root, receiptOf('c1-r' + i, new Date(base + i * 1000).toISOString()));
  }
  const vr = verifyRefusals(root, 'sess-h');
  assert.equal(vr.ok, true, '50 条连续写入后锚链必须完整（brokenAt=' + String(vr.brokenAt) + '）');
  assert.equal(vr.receipts.filter((x) => x.anchored).length, 50, '50 条全部锚定');
});

test('C2 缓存按目录 mtime 失效：外部进程写入后，下一条必须锚到外部那条（否则链断）', () => {
  const root = tempRoot('gov-c2-');
  const dir = refusalDirOf(root, 'sess-h');
  writeRefusal(root, receiptOf('c2-r1', '2026-09-02T00:00:00.000Z')); // 触发缓存 priming
  // 模拟「另一个进程」直接落一条合法收据（绕过 writeRefusal ⇒ 只改目录 mtime，不改本进程缓存）
  const r1 = readReceipt(root, 'sess-h', 'c2-r1');
  const external = receiptOf('c2-ext', '2026-09-02T00:00:01.000Z');
  external.anchor = makeAnchor(external, r1.anchor.hash);
  fs.writeFileSync(path.join(dir, 'c2-ext.json'), JSON.stringify(external, null, 2), 'utf8');
  writeRefusal(root, receiptOf('c2-r3', '2026-09-02T00:00:02.000Z'));
  const r3 = readReceipt(root, 'sess-h', 'c2-r3');
  assert.equal(r3.anchor.prevHash, external.anchor.hash,
    '缓存未按 mtime 失效时 r3 会锚到 c2-r1（跳过外部那条）⇒ 链断；实际 prevHash=' + r3.anchor.prevHash);
  const vr = verifyRefusals(root, 'sess-h');
  assert.equal(vr.ok, true, '三节点链必须可验证（c2-r1 → c2-ext → c2-r3），brokenAt=' + String(vr.brokenAt));
});

test('C3 缓存命中不重扫目录：primed 之后再写一条，readdirSync 调用数为 0', (t) => {
  const root = tempRoot('gov-c3-');
  writeRefusal(root, receiptOf('c3-r1', '2026-09-03T00:00:00.000Z')); // priming（首次允许全量）
  const spy = t.mock.method(fs, 'readdirSync');
  writeRefusal(root, receiptOf('c3-r2', '2026-09-03T00:00:01.000Z'));
  assert.equal(spy.mock.callCount(), 0,
    '缓存命中时不得重新扫描收据目录（O(N) → O(1) 的判据；实测调用 ' + spy.mock.callCount() + ' 次）');
  assert.equal(verifyRefusals(root, 'sess-h').ok, true, '旁路：链仍完整');
});
