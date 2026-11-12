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

import fs from 'node:fs';
import path from 'node:path';
import { SESSION_RE } from '../state/constants.js';
import { hashContent, makeAnchor } from './hash-utils.js';

export function refusalDirOf(root, sessionId) {
  const sid = String(sessionId ?? 'cli');
  if (!SESSION_RE.test(sid)) throw new Error('invalid sessionId: ' + sessionId);
  return path.join(root, 'governance', 'refusals', sid);
}

// 【④ 同名不同物改名】本函数与 `lib/verify/evidence.js` 的同名函数曾共用一名但落点不同
//   （本处 `governance/refusals/ledger-<sid>.jsonl`；那边 `verify/ledger-<sid>.jsonl`）。按「谁更窄谁改名」
//   本处改 `refusalsLedgerFileOf`（带域前缀），两侧各自独立、**禁合并**（旧名与依据见 map.json G4-3）。
function refusalsLedgerFileOf(root, sessionId) {
  const sid = String(sessionId ?? 'cli');
  if (!SESSION_RE.test(sid)) throw new Error('invalid sessionId: ' + sessionId);
  return path.join(root, 'governance', 'refusals', 'ledger-' + sid + '.jsonl');
}

export function eventStreamFileOf(root, sessionId) {
  const sid = String(sessionId ?? 'cli');
  if (!SESSION_RE.test(sid)) throw new Error('invalid sessionId: ' + sessionId);
  return path.join(root, 'governance', 'events', 'refusal-' + sid + '.jsonl');
}

export function appendRefusalEvent(root, sessionId, receipt) {
  const file = eventStreamFileOf(root, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entry = {
    type: 'governance.refusal.recorded',
    ts: receipt?.ts ?? new Date().toISOString(),
    sessionId: receipt?.sessionId ?? sessionId ?? 'cli',
    receiptId: receipt?.receiptId ?? null,
    primitive: receipt?.decision?.primitive ?? null,
    tool: receipt?.tool ?? null,
    callId: receipt?.callId ?? null,
  };
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  return file;
}

function chainKey(r) {
  return { ts: r?.ts ?? '', id: r?.receiptId ?? '' };
}
function keyLt(a, b) {
  return a.ts < b.ts || (a.ts === b.ts && a.id < b.id);
}

function sortForChain(list) {
  return [...list].sort((a, b) => {
    const ka = chainKey(a);
    const kb = chainKey(b);
    if (ka.ts < kb.ts) return -1;
    if (ka.ts > kb.ts) return 1;
    return ka.id < kb.id ? -1 : ka.id > kb.id ? 1 : 0;
  });
}

function readDirReceipts(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    } catch {  }
  }
  return out;
}

function chainTail(dir) {
  const ordered = sortForChain(readDirReceipts(dir));
  for (let i = ordered.length - 1; i >= 0; i--) {
    const a = ordered[i]?.anchor;
    if (a && typeof a.hash === 'string' && a.alg === 'sha256') return ordered[i];
  }
  return null;
}

// ── 【⑥-3 · 2026-11-08 裁决甲】链尾缓存：把「每次写都重读全目录」降到 O(1) ──────────────
//   为什么必须做（实测）：`chainTail` 走 `readDirReceipts`，即**每次都读+parse 目录下全部收据**
//   （为了算锚链前驱）⇒ 单次写入 3.6ms@5 条 / 23.9ms@100 条 / 44.1ms@115 条，随收据数劣化。
//   收据写入在工具护栏路径上（每次拒绝一次），这个劣化会直接变成护栏延迟。
//   失效判据（不是"信任缓存"）：缓存键 = 收据目录，附 **目录 mtimeMs** 快照 —— 任何新增/重写
//   文件都会改目录 mtime（含**其它进程**写入、`patchRefusalAsk` 的改写）⇒ 命中即复用、漂移即重建。
//   单进程假设之外的场景由这条 mtime 判据兜住；`verifyRefusals` 始终全量重算，不受缓存影响。
const chainTailCache = new Map();

function cachedChainTail(dir) {
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    return null; // 目录不存在 = 无链尾（写入前会 mkdir）
  }
  const hit = chainTailCache.get(dir);
  if (hit && hit.dirMtimeMs === st.mtimeMs) return hit.tail;
  const tail = chainTail(dir);
  chainTailCache.set(dir, { tail, dirMtimeMs: st.mtimeMs });
  return tail;
}

function primeChainTailCache(dir, receipt) {
  try {
    const st = fs.statSync(dir);
    chainTailCache.set(dir, { tail: receipt ?? null, dirMtimeMs: st.mtimeMs });
  } catch {
    chainTailCache.delete(dir); // 取不到 mtime ⇒ 不缓存（下次重建）
  }
}

// ts 唯一化守卫（链序确定性）：本收据链序键若不严格大于链尾（同 ms 碰撞且 receiptId 更小 /
//   时钟回拨），把 ts nudge 到链尾 ts +1ms——保证链序 = 严格 ts 序（verify 同序重算不误报）。
function ensureStrictTsAfterTail(receipt, tail) {
  if (!tail) return receipt;
  const tailKey = chainKey(tail);
  const selfKey = chainKey(receipt);
  if (keyLt(selfKey, tailKey) || (selfKey.ts === tailKey.ts && selfKey.id === tailKey.id)) {
    const bumped = new Date(Date.parse(tail.ts) + 1).toISOString();
    if (receipt.ask && typeof receipt.ask.initiated === 'string') receipt.ask.initiated = bumped;
    receipt.ts = bumped;
  }
  return receipt;
}

export function writeRefusal(root, receipt) {
  if (!receipt || typeof receipt.receiptId !== 'string' || !receipt.receiptId.length) {
    throw new Error('writeRefusal: receiptId required');
  }
  const sessionId = receipt.sessionId ?? 'cli';
  const dir = refusalDirOf(root, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const tail = cachedChainTail(dir); // 【⑥-3】O(1) 命中（目录 mtime 漂移时自动重建）
  ensureStrictTsAfterTail(receipt, tail);
  receipt.anchor = makeAnchor(receipt, tail?.anchor?.hash ?? null);
  const file = path.join(dir, receipt.receiptId + '.json');
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(receipt, null, 2), 'utf8');
  try {
    const written = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    if (written.receiptId !== receipt.receiptId) throw new Error('write verify failed: receiptId mismatch');
    verifyAnchorConsistent(written);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {  }
    throw new Error('refusal write failed (fail closed): ' + receipt.receiptId + ' — ' + String(e?.message ?? e));
  }
  primeChainTailCache(dir, receipt); // 新收据即新链尾（rename 后目录 mtime 已更新）
  appendLedger(root, sessionId, receipt);
  return file;
}

function verifyAnchorConsistent(r) {
  const a = r?.anchor;
  if (!a || typeof a.hash !== 'string' || a.alg !== 'sha256' || a.version !== 1) {
    throw new Error('anchor verify failed: unsupported anchor shape');
  }
  const recomputed = hashContent(r, a.prevHash);
  if (recomputed !== a.hash) throw new Error('anchor verify failed: hash mismatch');
  return true;
}

function appendLedger(root, sessionId, entry) {
  const file = refusalsLedgerFileOf(root, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
}

export function readRefusals(root, sessionId, { limit } = {}) {
  const dir = refusalDirOf(root, sessionId);
  const out = readDirReceipts(dir);
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  if (typeof limit === 'number' && Number.isFinite(limit) && limit >= 0) return out.slice(-limit);
  return out;
}

export function verifyRefusals(root, sessionId) {
  const dir = refusalDirOf(root, sessionId);
  const ordered = sortForChain(readDirReceipts(dir));
  const receipts = [];
  let ok = true;
  let brokenAt = null;
  let prevHash = null;
  for (const r of ordered) {
    const a = r?.anchor;
    if (!a || typeof a.hash !== 'string' || a.alg !== 'sha256' || a.version !== 1) {
      receipts.push({ receiptId: r.receiptId, ts: r.ts, anchored: false, ok: true });
      continue;
    }
    const recomputed = hashContent(r, a.prevHash);
    const hashOk = recomputed === a.hash;
    const linkOk = a.prevHash === prevHash;
    const entryOk = hashOk && linkOk;
    let issue;
    if (!entryOk) {
      ok = false;
      if (brokenAt === null) brokenAt = r.receiptId;
      issue = hashOk ? 'link-break' : 'hash-mismatch';
    }
    receipts.push({ receiptId: r.receiptId, ts: r.ts, anchored: true, ok: entryOk, issue });
    prevHash = a.hash;
  }
  return { ok, brokenAt, count: receipts.filter((x) => x.anchored).length, receipts };
}

function rewriteReceiptJson(dir, file, receipt, receiptId) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(receipt, null, 2), 'utf8');
  try {
    const written = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    if (written.receiptId !== receiptId) throw new Error('rewrite verify failed: receiptId mismatch');
    verifyAnchorConsistent(written);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {  }
    throw new Error('refusal rewrite failed (fail closed): ' + receiptId + ' — ' + String(e?.message ?? e));
  }
}

export function patchRefusalAsk(root, sessionId, receiptId, outcome) {
  if (!receiptId || typeof receiptId !== 'string' || !receiptId.length) {
    throw new Error('patchRefusalAsk: receiptId required');
  }
  if (typeof outcome !== 'string' || !outcome.length) {
    throw new Error('patchRefusalAsk: outcome required');
  }
  const dir = refusalDirOf(root, sessionId);
  const file = path.join(dir, receiptId + '.json');
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!receipt.ask || typeof receipt.ask.outcome === 'string') return file;
  const updated = { ...receipt, ask: { ...receipt.ask, outcome } };
  const prevAnchor = receipt.anchor ?? null;
  if (prevAnchor && prevAnchor.alg === 'sha256' && prevAnchor.version === 1) {
    updated.anchor = makeAnchor(updated, prevAnchor.prevHash);
    rewriteReceiptJson(dir, file, updated, receiptId);
    appendLedger(root, sessionId, updated);
    let oldHash = prevAnchor.hash;
    let newHash = updated.anchor.hash;
    for (const succ of sortForChain(readDirReceipts(dir))) {
      const sa = succ?.anchor;
      if (!sa || sa.alg !== 'sha256' || sa.version !== 1 || succ.receiptId === receiptId) continue;
      if (sa.prevHash === oldHash) {
        const re = { ...succ, anchor: makeAnchor(succ, newHash) };
        rewriteReceiptJson(dir, path.join(dir, succ.receiptId + '.json'), re, succ.receiptId);
        appendLedger(root, sessionId, re);
        oldHash = sa.hash;
        newHash = re.anchor.hash;
      }
    }
  } else {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(updated, null, 2), 'utf8');
    try {
      const written = JSON.parse(fs.readFileSync(tmp, 'utf8'));
      if (written.receiptId !== receiptId || written.ask?.outcome !== outcome) {
        throw new Error('patch verify failed: ask outcome mismatch');
      }
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {  }
      throw new Error('refusal ask patch failed (fail closed): ' + receiptId + ' — ' + String(e?.message ?? e));
    }
    appendLedger(root, sessionId, updated);
  }
  // 【⑥-3】patch 会改写本条并级联重算后继锚 ⇒ 链尾可能变化：**主动失效缓存**（下次写入重建）。
  //   这里刻意不做「重算后 prime」——patch 本身已经是 O(N) 的全量遍历，省这一次重建没有收益，
  //   而缓存一步错算会让后续锚链整条断（不可逆的审计损伤），宁保守。
  chainTailCache.delete(dir);
  return file;
}
