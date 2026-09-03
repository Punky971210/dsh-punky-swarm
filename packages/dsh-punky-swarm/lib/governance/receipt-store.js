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

// governance/receipt-store.js —— 拒绝收据落盘（G9，JS 文件 IO，对齐 evidence.js 模式）
// 位置：<root>/governance/refusals/<sessionId>/<receiptId>.json（原子写 tmp+rename，对齐 evidence.js:115-132 writeBlobAtomic）
//      + <root>/governance/refusals/ledger-<sessionId>.jsonl 追加（对齐 evidence.js:171-180 appendLedger）
// root = 引擎根（~/.dsh/jiufeng，PK lib/index.js:59-60）。
// 内容四要素（design.md:115）：attempted_params（attemptedParams）/ 裁决（decision.primitive+priority+reason）/
//   理由（decision.reason）/ ts；另含 receiptId、tool、callId、sessionId、ruleRefs（§2.1 G1 类型）。
// P2 硬化（harden-plan §5.3 A，M5-d 证据信封简版）：哈希锚定——writeRefusal 写 anchor
//   （sha256 内容哈希链：同 session 按 ts 序串链，prevHash 链接前一收据；篡改任一收据破坏后续链）；
//   verifyRefusals 验链/篡改定位；patchRefusalAsk 事后回写与链交互 = 级联重锚（改收据 → 后续链收据
//   prevHash/hash 级联重算 + ledger 演化快照）。canonical 序列化见 hash-utils.js（RFC8785 简版，零依赖）。
//   WORM（N-11）不做；真签名/完整 RFC8785 归 M5（注释留痕）。
import fs from 'node:fs';
import path from 'node:path';
import { SESSION_RE } from '../state/constants.js';
import { hashContent, makeAnchor } from './hash-utils.js';

// 拒绝收据目录：<root>/governance/refusals/<sessionId>/（sessionId 缺省 'cli'）
export function refusalDirOf(root, sessionId) {
  const sid = String(sessionId ?? 'cli');
  if (!SESSION_RE.test(sid)) throw new Error('invalid sessionId: ' + sessionId);
  return path.join(root, 'governance', 'refusals', sid);
}

function ledgerFileOf(root, sessionId) {
  const sid = String(sessionId ?? 'cli');
  if (!SESSION_RE.test(sid)) throw new Error('invalid sessionId: ' + sessionId);
  return path.join(root, 'governance', 'refusals', 'ledger-' + sid + '.jsonl');
}

// P2 双层桥接事件流（harden-plan §5.3 B，批级可观测，零依赖）：<root>/governance/events/refusal-<sessionId>.jsonl
//   （独立于 refusals 收据目录的批级事件流；只做事件可见性，不触发批级状态迁移——状态联动归 M5-a）。
//   行形态：{ type:'governance.refusal.recorded', ts, sessionId, receiptId, primitive, tool, callId }（含收据 id/原语/时间戳）。
export function eventStreamFileOf(root, sessionId) {
  const sid = String(sessionId ?? 'cli');
  if (!SESSION_RE.test(sid)) throw new Error('invalid sessionId: ' + sessionId);
  return path.join(root, 'governance', 'events', 'refusal-' + sid + '.jsonl');
}

// 收据落盘事件追加（装配层 onRefusal 回调消费；尽力而为——失败上抛由调用方观察者纪律 catch warn）
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

// 链序键比较：ts 主序 + receiptId 破平（确定性链序；平 ts 场景以 receiptId 排序，审计可复现）。
// 注意：ts 由宿主时钟生成（ms 精度），同 session 快速连续写可能同 ms——writeRefusal 以 ts 唯一化守卫
// （见下）保证链序 = 严格 ts 序，receiptId 破平仅兜底（守卫后不触发）。
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

// 读目录现有收据（跳过损坏；供 writeRefusal 取链尾 / verifyRefusals 全量验链）
function readDirReceipts(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    } catch { /* 跳过损坏收据（单文件仍可直查） */ }
  }
  return out;
}

// 链尾（锚定收据，链序最后一条）；无锚定收据 → null。只认「落盘即锚定」的收据——旧收据
// （P2 前，无 anchor）不参与链（§5.3 A.5），链从首个锚定收据起。
function chainTail(dir) {
  const ordered = sortForChain(readDirReceipts(dir));
  for (let i = ordered.length - 1; i >= 0; i--) {
    const a = ordered[i]?.anchor;
    if (a && typeof a.hash === 'string' && a.alg === 'sha256') return ordered[i];
  }
  return null;
}

// ts 唯一化守卫（链序确定性）：本收据链序键若不严格大于链尾（同 ms 碰撞且 receiptId 更小 /
//   时钟回拨），把 ts nudge 到链尾 ts +1ms——保证链序 = 严格 ts 序（verify 同序重算不误报）。
//   副作用：同 ms 碰撞时收据 ts 微调 +1ms（记录时间语义不变，仅链序键微调）；ask.initiated 同步跟随
//   （保持 S1/S8「initiated === ts 同一时刻」契约）。返回守卫后 receipt（原地改 ts/ask.initiated）。
function ensureStrictTsAfterTail(receipt, tail) {
  if (!tail) return receipt;
  const tailKey = chainKey(tail);
  const selfKey = chainKey(receipt);
  if (keyLt(selfKey, tailKey) || (selfKey.ts === tailKey.ts && selfKey.id === tailKey.id)) {
    const bumped = new Date(Date.parse(tail.ts) + 1).toISOString();
    if (receipt.ask && typeof receipt.ask.initiated === 'string') receipt.ask.initiated = bumped; // 同源跟随
    receipt.ts = bumped;
  }
  return receipt;
}

// 拒绝收据原子写：json 落盘（tmp+rename，写后读校验 receiptId + anchor 一致，fail closed 不留半成品）+ ledger 追加。
// P2：写入前计算 anchor（prevHash = 链尾锚定收据 hash，首收据 null；hash = sha256(canonical(body+prevHash))），
//   anchor 字段随 json 与 ledger 同行（§5.3 A.6）。返回落盘文件绝对路径。
// ledger 追加失败向上抛（调用方 wiring 按观察者纪律 catch → warn，不阻断裁决）。
export function writeRefusal(root, receipt) {
  if (!receipt || typeof receipt.receiptId !== 'string' || !receipt.receiptId.length) {
    throw new Error('writeRefusal: receiptId required');
  }
  const sessionId = receipt.sessionId ?? 'cli';
  const dir = refusalDirOf(root, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  // P2 锚定：prevHash = 现链尾（本收据尚不在盘上）；hash 覆盖除 anchor 自身外全部字段（含 prevHash）
  const tail = chainTail(dir);
  ensureStrictTsAfterTail(receipt, tail);
  receipt.anchor = makeAnchor(receipt, tail?.anchor?.hash ?? null);
  const file = path.join(dir, receipt.receiptId + '.json');
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(receipt, null, 2), 'utf8');
  try {
    // 写后读校验（fail closed）：可解析 + receiptId 一致 + anchor 重算一致（P2 §5.3 A.6）
    const written = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    if (written.receiptId !== receipt.receiptId) throw new Error('write verify failed: receiptId mismatch');
    verifyAnchorConsistent(written);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败忽略 */ }
    throw new Error('refusal write failed (fail closed): ' + receipt.receiptId + ' — ' + String(e?.message ?? e));
  }
  appendLedger(root, sessionId, receipt);
  return file;
}

// anchor 一致性校验（写后读 / verify 共用）：anchor 存在且 hash = 按盘上内容重算（含 anchor.prevHash）。
//   alg 非 sha256 / version 非 1 的旧锚定方案 → 上抛（本批只认 sha256 简版链）。
function verifyAnchorConsistent(r) {
  const a = r?.anchor;
  if (!a || typeof a.hash !== 'string' || a.alg !== 'sha256' || a.version !== 1) {
    throw new Error('anchor verify failed: unsupported anchor shape');
  }
  const recomputed = hashContent(r, a.prevHash); // hashContent 内部剥离 anchor
  if (recomputed !== a.hash) throw new Error('anchor verify failed: hash mismatch');
  return true;
}

// ledger 追加写（每会话台账；审计/回放消费）。json 已原子落盘，ledger 追加尽力而为。
function appendLedger(root, sessionId, entry) {
  const file = ledgerFileOf(root, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
}

// 读回收据：<sessionId>/ 下 *.json 全量解析（损坏行跳过——单文件仍可直查），按 ts 升序；
// limit 给定时返回最近 N 条（slice(-limit)）。保持兼容：不校验 anchor（读回不炸，§5.3 A.5/§4.2）。
export function readRefusals(root, sessionId, { limit } = {}) {
  const dir = refusalDirOf(root, sessionId);
  const out = readDirReceipts(dir);
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  if (typeof limit === 'number' && Number.isFinite(limit) && limit >= 0) return out.slice(-limit);
  return out;
}

// P2 验链/篡改定位（harden-plan §5.3 A.5）：重算链、定位首个不匹配/缺链收据。
//   返回 { ok, brokenAt?, count, receipts }：
//     - count：参与链校验的锚定收据数（旧无 anchor 收据不参与，见下）
//     - receipts：逐条校验结果 [{ receiptId, ts, anchored, ok, issue? }]——ok=false 者为不匹配/缺链收据
//       （issue: 'hash-mismatch' = 内容哈希不匹配（篡改）；'link-break' = prevHash 与链上前一收据不符（缺链））
//     - brokenAt：首个失败收据 receiptId（ok=true 时 null）
//   语义：篡改任一锚定收据 → 其自身 hash-mismatch；删中间收据 → 其后继 link-break（prevHash 指向已删 hash）。
//   旧收据（无 anchor）不参与链校验、不判失败（§5.3 A.5——P2 前收据兼容）。
export function verifyRefusals(root, sessionId) {
  const dir = refusalDirOf(root, sessionId);
  const ordered = sortForChain(readDirReceipts(dir));
  const receipts = [];
  let ok = true;
  let brokenAt = null;
  let prevHash = null; // 链上前一「锚定」收据的 hash（旧无 anchor 收据不推进）
  for (const r of ordered) {
    const a = r?.anchor;
    if (!a || typeof a.hash !== 'string' || a.alg !== 'sha256' || a.version !== 1) {
      receipts.push({ receiptId: r.receiptId, ts: r.ts, anchored: false, ok: true });
      continue; // 旧收据（无 anchor）：不参与链，不判失败
    }
    const recomputed = hashContent(r, a.prevHash);
    const hashOk = recomputed === a.hash;
    const linkOk = a.prevHash === prevHash; // 链序前一锚定收据 hash 必须衔接（删中间收据 → 此处断裂）
    const entryOk = hashOk && linkOk;
    let issue;
    if (!entryOk) {
      ok = false;
      if (brokenAt === null) brokenAt = r.receiptId; // 首个失败
      issue = hashOk ? 'link-break' : 'hash-mismatch';
    }
    receipts.push({ receiptId: r.receiptId, ts: r.ts, anchored: true, ok: entryOk, issue });
    prevHash = a.hash; // 锚定收据推进链（含失败者——其 hash 仍为后继 prevHash 指向）
  }
  return { ok, brokenAt, count: receipts.filter((x) => x.anchored).length, receipts };
}

// 单收据 json 原子改写（tmp+rename + 写后读校验 fail closed）——供 patchRefusalAsk 级联重锚复用。
function rewriteReceiptJson(dir, file, receipt, receiptId) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(receipt, null, 2), 'utf8');
  try {
    const written = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    if (written.receiptId !== receiptId) throw new Error('rewrite verify failed: receiptId mismatch');
    verifyAnchorConsistent(written);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败忽略 */ }
    throw new Error('refusal rewrite failed (fail closed): ' + receiptId + ' — ' + String(e?.message ?? e));
  }
}

// P1 ask outcome 补记（harden-plan §5.2 B.2）+ P2 级联重锚（harden-plan §5.3 A / p1-manifest 移交①）：
//   REQUIRE_APPROVAL 收据 pre 落盘只含 ask.initiated；post 观察者经本函数尽力补记 ask.outcome
//   （读-改-写原子 tmp+rename，写后读校验 fail closed）。
//   幂等：收据无 ask 或 ask.outcome 已存在 → no-op（不二次改写）；json 不存在/损坏 → 上抛（调用方 catch warn）。
//   P2 交互（移交①）：补记 = 收据体事后改写（ts 不变，字段增量）→ 若收据已锚定，重算本收据 anchor.hash
//   （prevHash 不变——链上前驱未动）；hash 变了 → 链上所有后继收据 prevHash/hash 级联重算（级联重锚，
//   json 原子改写 + ledger 演化快照追加）。链尾补记（常见：post 紧随 pre，无后继）→ 仅本收据重锚。
//   旧收据（无 anchor，P2 前）→ 维持纯补记（不锚定不级联，§4.2 兼容）。
export function patchRefusalAsk(root, sessionId, receiptId, outcome) {
  if (!receiptId || typeof receiptId !== 'string' || !receiptId.length) {
    throw new Error('patchRefusalAsk: receiptId required');
  }
  if (typeof outcome !== 'string' || !outcome.length) {
    throw new Error('patchRefusalAsk: outcome required');
  }
  const dir = refusalDirOf(root, sessionId);
  const file = path.join(dir, receiptId + '.json');
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8')); // 不存在/损坏 → 上抛（尽力补记，写失败仅 warn）
  if (!receipt.ask || typeof receipt.ask.outcome === 'string') return file; // 无 ask / 已终态 → 幂等 no-op
  const updated = { ...receipt, ask: { ...receipt.ask, outcome } };
  const prevAnchor = receipt.anchor ?? null;
  if (prevAnchor && prevAnchor.alg === 'sha256' && prevAnchor.version === 1) {
    // P2：级联重锚。本收据重算 hash（prevHash 不变）；其后继 prevHash/hash 逐跳重算至链尾。
    updated.anchor = makeAnchor(updated, prevAnchor.prevHash);
    rewriteReceiptJson(dir, file, updated, receiptId);
    appendLedger(root, sessionId, updated); // 本收据演化快照（终态）
    // 级联：链序中 prevHash === 旧 hash 的后继（旧收据无 anchor 不参与）
    let oldHash = prevAnchor.hash;
    let newHash = updated.anchor.hash;
    for (const succ of sortForChain(readDirReceipts(dir))) {
      const sa = succ?.anchor;
      if (!sa || sa.alg !== 'sha256' || sa.version !== 1 || succ.receiptId === receiptId) continue;
      if (sa.prevHash === oldHash) {
        const re = { ...succ, anchor: makeAnchor(succ, newHash) };
        rewriteReceiptJson(dir, path.join(dir, succ.receiptId + '.json'), re, succ.receiptId);
        appendLedger(root, sessionId, re); // 级联重锚演化快照（ledger 每行=完整收据形态，同 id 多行=演化）
        oldHash = sa.hash;
        newHash = re.anchor.hash;
      }
    }
  } else {
    // 旧收据（无 anchor）：维持 P1 纯补记行为（不锚定不级联）
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(updated, null, 2), 'utf8');
    try {
      const written = JSON.parse(fs.readFileSync(tmp, 'utf8'));
      if (written.receiptId !== receiptId || written.ask?.outcome !== outcome) {
        throw new Error('patch verify failed: ask outcome mismatch');
      }
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* 清理失败忽略 */ }
      throw new Error('refusal ask patch failed (fail closed): ' + receiptId + ' — ' + String(e?.message ?? e));
    }
    appendLedger(root, sessionId, updated); // ledger 追加终态快照（审计演化留痕）
  }
  return file;
}
