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

// P2 组 H（harden-plan §6，6 条新增）：收据签名/哈希锚定（M5-d 证据信封简版）。
// 载体：test/governance-receipt-anchor.test.js（新增文件）。
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

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

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
  assert.equal(vr.count, 1);
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
  assert.equal(vr.count, 3);
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
  assert.equal(sha256Hex('abc').length, 64);
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
  assert.equal(all.length, 3);
  assert.ok(all.some((r) => r.receiptId === 'h5-legacy' && r.anchor === undefined), 'legacy 读回无 anchor');
  // verify：legacy 不参与链（anchored=false），链从首个锚定收据起（h5-r1 prevHash=null），整体 ok
  const vr = verifyRefusals(root, 'sess-h');
  assert.equal(vr.ok, true, '旧收据混入不破坏链校验');
  assert.equal(vr.count, 2, '仅锚定收据计入链');
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
  assert.equal(vr.count, 2, '现存锚定收据 2 条');
});
