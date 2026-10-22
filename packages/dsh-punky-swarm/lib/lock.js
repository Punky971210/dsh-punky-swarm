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

// O_EXCL 单写者锁（fencing 版）：原子创建锁文件；冲突先拒绝（wait/force 可选）。
// force = **受控接管**（不再 `unlink`）：读旧锁 → 票号 `O_EXCL` 选举出同代唯一胜者 →
//   `fence = 旧值 + 1` → `renameSync` 原子替换（不出现「锁文件缺失」的中间态）。
// 旧锁不可解析 / 旧格式（缺 `token` 或 缺 `fence`）⇒ 一律拒接管且**零删除**（fail-closed）。
// 【fence 的真实失效面（勿拔高）】本模块只保证三件事：① 凭证失效（`release` 按 token 配平）
//   ② 接管后旧 token 在盘上已不存在（其后续 `release` 必 `token-mismatch`）③ 锁文件 `fence` + `warn`
//   留痕可核。**本仓没有「批 JSON 写前校验 fence」的落点**：`state/store.commitBatch` 为无锁物理直写 ⇒
//   **不得**表述为「旧持有者的批 JSON 写入会被拒」（K-1 残余，写面 fencing 非本批范围）。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 拒绝原因（**普通字符串**，不是拒码）：零新造 `GATE_*`（不变量 4）
const REASON_UNPARSEABLE = 'lock-unparseable';
const REASON_LEGACY = 'lock-legacy-format';
const REASON_CONTENDED = 'takeover-contended';
const REASON_TOKEN_REQUIRED = 'token-required';

// Windows 上 `renameSync` 覆盖既有文件时，若目标被抓有并发读句柄，`MoveFileEx` 会抛这些**瞬时**码
// （实测 EPERM，约 10% 触发率）⇒ 一律按「接管受阻」fail-closed 收口，**不抛、不删锁**。
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ETXTBSY']);

// 锁记录合规判据（单点）：`token` 非空串 且 `fence` 为 ≥1 的有限数。
// 缺任一 ⇒ 按「旧格式」处理（v0.5.2 写出的锁**有 token 无 fence**）⇒ 拒接管/拒释放、零删除。
function isWellFormedLock(record) {
  return record !== null
    && typeof record === 'object'
    && !Array.isArray(record)
    && typeof record.token === 'string'
    && record.token.length > 0
    && typeof record.fence === 'number'
    && Number.isFinite(record.fence)
    && record.fence >= 1;
}

// 持有者活性分类（**单点**，仅用于接管留痕，**不参与放行**）：
// pid 存活或 EPERM ⇒ `alive`；ESRCH ⇒ `inactive`；无/非法 pid ⇒ `unknown`。
function holderStateOf(record) {
  const pid = record !== null && typeof record === 'object' ? record.pid : undefined;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (e) {
    return e?.code === 'ESRCH' ? 'inactive' : 'alive'; // EPERM 等「判不出已死」⇒ 按存活处理（保守）
  }
}

function lockRecordOrNull(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

// 票号回收（**只回收票号，绝不删锁**）：须**同时**满足「票号已过期」+「lockPath.fence 未变」
// （fence 变了 ⇒ 票号已被安装成锁 ⇒ 不是崩溃残留 ⇒ 不回收）。返回是否回收及票龄。
function reclaimStaleTicket(ticketPath, lockPath, expectedFence, ticketTtlMs) {
  if (typeof ticketTtlMs !== 'number' || !(ticketTtlMs > 0)) return { reclaimed: false, ageMs: null };
  let stat;
  try {
    stat = fs.statSync(ticketPath);
  } catch (e) {
    if (e?.code === 'ENOENT') return { reclaimed: false, ageMs: null }; // 对手刚完成安装/回收
    throw e;
  }
  const ageMs = Date.now() - stat.mtimeMs;
  if (!(ageMs > ticketTtlMs)) return { reclaimed: false, ageMs };
  let lockRaw;
  try {
    lockRaw = fs.readFileSync(lockPath, 'utf8');
  } catch {
    return { reclaimed: false, ageMs };
  }
  const lockRecord = lockRecordOrNull(lockRaw);
  if (lockRecord === null || lockRecord.fence !== expectedFence) return { reclaimed: false, ageMs };
  try {
    fs.unlinkSync(ticketPath); // 唯一允许的 unlink 面：过期票号（瞬时临时文件），永不是锁
  } catch (e) {
    if (e?.code === 'ENOENT') return { reclaimed: false, ageMs };
    throw e;
  }
  return { reclaimed: true, ageMs };
}

export async function acquire(lockPath, { waitMs = 0, pollMs = 50, force = false, warn = null, ticketTtlMs = 30000 } = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + Math.max(0, waitMs);
  // S-3：force 在**一个调用内最多一次接管尝试**（防 livelock 与「反复抢占」）；失败即返回，重试归调用方。
  let takeoverAttempted = false;
  for (;;) {
    const token = randomUUID();
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify({ token, ts: Date.now(), pid: process.pid, fence: 1 }));
      fs.closeSync(fd);
      return { ok: true, token, lockPath, fence: 1 };
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      if (force !== true) {
        // 非 force 路径：行为**逐字不变**（deadline/pollMs/`{ok:false,conflict:true,lockPath}`）
        if (Date.now() >= deadline) {
          return { ok: false, conflict: true, lockPath };
        }
        await sleep(Math.max(10, pollMs));
        continue;
      }
      // ── force 分支：受控接管 ────────────────────────────────────────────────
      if (takeoverAttempted) return { ok: false, conflict: true, lockPath };
      takeoverAttempted = true;
      let raw;
      try {
        raw = fs.readFileSync(lockPath, 'utf8');
      } catch (e2) {
        if (e2?.code === 'ENOENT') continue; // 对手刚释放 ⇒ 重入步骤 1 一次（之后不再重试）
        throw e2;
      }
      // 条件① 旧锁可解析
      const cur = lockRecordOrNull(raw);
      if (cur === null) return { ok: false, conflict: true, lockPath, reason: REASON_UNPARSEABLE };
      // 条件② 旧格式（缺 token / 缺 fence）⇒ 拒接管，零删除零写入零票号
      if (!isWellFormedLock(cur)) return { ok: false, conflict: true, lockPath, reason: REASON_LEGACY };

      // 条件③ 接管后 fence = 旧值 + 1；同代唯一胜者由票号 O_EXCL 决定
      const next = cur.fence + 1;
      const ticketPath = lockPath + '.takeover-' + next;
      let fd;
      try {
        fd = fs.openSync(ticketPath, 'wx');
      } catch (e3) {
        if (e3?.code !== 'EEXIST') throw e3;
        const reclaimed = reclaimStaleTicket(ticketPath, lockPath, cur.fence, ticketTtlMs);
        if (!reclaimed.reclaimed) {
          return { ok: false, conflict: true, lockPath, reason: REASON_CONTENDED, fence: cur.fence };
        }
        if (typeof warn === 'function') {
          warn('[dsh-punky-swarm] lane lock 回收过期票号：' + ticketPath
            + ' · ageMs=' + reclaimed.ageMs + ' · lockPath fence 仍为 ' + cur.fence + '（仅回收票号，未删锁）');
        }
        try {
          fd = fs.openSync(ticketPath, 'wx'); // 回收后重试一次
        } catch (e4) {
          if (e4?.code === 'EEXIST') {
            return { ok: false, conflict: true, lockPath, reason: REASON_CONTENDED, fence: cur.fence };
          }
          throw e4;
        }
      }
      // 安装（含两处 fail-closed 自证）。票号在 `rename` 后即消失（S-4：不留持久文件），
      // 故落后者可能拿着**过期的 fence 读数**重建同名票号 ⇒ 下面两处复核把这条窗口收窄到 syscall 级。
      let installed = false;
      try {
        // ① 安装前 CAS 复核：票号建好到安装之间，同代对手可能已安装成锁（fence 已前进）⇒
        //    本票基于过期代数，**不得安装**（否则会以同一 fence 覆盖对手已提升的锁 = 「双持有」窗口）。
        //    只清自己刚建的票号，**零删除锁**。
        let verifyRaw;
        try {
          verifyRaw = fs.readFileSync(lockPath, 'utf8');
        } catch (e5) {
          if (e5?.code === 'ENOENT') return { ok: false, conflict: true, lockPath, reason: REASON_CONTENDED, fence: null };
          throw e5;
        }
        const verifyRec = lockRecordOrNull(verifyRaw);
        if (verifyRec === null || verifyRec.fence !== cur.fence || verifyRec.token !== cur.token) {
          return { ok: false, conflict: true, lockPath, reason: REASON_CONTENDED, fence: verifyRec?.fence ?? cur.fence };
        }
        const holderState = holderStateOf(cur);
        const kind = holderState === 'inactive' ? 'stale-takeover' : 'forced-takeover';
        fs.writeSync(fd, JSON.stringify({ token, ts: Date.now(), pid: process.pid, fence: next }));
        fs.closeSync(fd);
        fd = null;
        try {
          fs.renameSync(ticketPath, lockPath); // 原子替换旧锁（**不 unlink**，无缺失窗口）
        } catch (e6) {
          // 【Windows 实测】`MoveFileEx(REPLACE_EXISTING)` 在目标被抓有并发读句柄时会抛 EPERM/EBUSY
          //   （**不是** EEXIST）⇒ 按「接管受阻」fail-closed 收口：清自己刚建的票号、**零删除锁**、
          //   **不把异常抛给调用方**（保持 `lane_claim` 无异常面；同代另一次尝试同样按 contended 收口，
          //   最坏结果是本次无人胜出，由调用方重试 —— 宁可不胜，不可双持有）。
          if (TRANSIENT_RENAME_CODES.has(e6?.code)) {
            if (typeof warn === 'function') {
              warn('[dsh-punky-swarm] lane lock 安装受阻：' + lockPath + ' · 票号 ' + ticketPath
                + ' · code=' + String(e6?.code) + '（按 takeover-contended 收口，锁未被改动）');
            }
            return { ok: false, conflict: true, lockPath, reason: REASON_CONTENDED, fence: cur.fence };
          }
          throw e6;
        }
        installed = true;
        // ② 安装后自证：盘上必须仍是本 token 且 fence = next；被覆盖 ⇒ 如实报冲突、**不删锁**（锁归对手）
        let postRec = null;
        try { postRec = lockRecordOrNull(fs.readFileSync(lockPath, 'utf8')); } catch {}
        if (postRec === null || postRec.token !== token || postRec.fence !== next) {
          return { ok: false, conflict: true, lockPath, reason: REASON_CONTENDED, fence: postRec?.fence ?? null };
        }
        if (typeof warn === 'function') {
          warn('[dsh-punky-swarm] lane lock 接管：' + lockPath
            + ' · fence ' + cur.fence + '→' + next
            + ' · from token=' + cur.token + ' pid=' + String(cur.pid)
            + ' holderState=' + holderState + ' · kind=' + kind
            + ' · prevTs=' + String(cur.ts));
        }
        return {
          ok: true,
          token,
          lockPath,
          fence: next,
          takeover: {
            from: { token: cur.token, pid: cur.pid ?? null, fence: cur.fence },
            to: { fence: next },
            kind,
            holderState,
          },
        };
      } finally {
        if (!installed) {
          if (fd !== null && fd !== undefined) { try { fs.closeSync(fd); } catch {} }
          try { fs.unlinkSync(ticketPath); } catch {} // 只清自己刚建的残票，不碰锁
        }
      }
    }
  }
}

export function release(lockPath, token) {
  // 顺序硬要求：token 合法性判定**早于任何读/删**（缺省即拒，杜绝「先读到锁再短路」的越权路径）
  if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: REASON_TOKEN_REQUIRED };
  let raw;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { ok: true }; // 锁不存在：现状语义保留
    throw e;
  }
  const cur = lockRecordOrNull(raw);
  if (cur === null) return { ok: false, reason: REASON_UNPARSEABLE }; // 零删除
  if (!isWellFormedLock(cur)) return { ok: false, reason: REASON_LEGACY }; // 旧格式无法证明持有权 ⇒ fail-closed
  // 仅当持有者 token 匹配时释放（防 force 接管后误释放）；字面量 `token-mismatch` 冻结
  if (cur.token !== token) return { ok: false, reason: 'token-mismatch' };
  try {
    fs.unlinkSync(lockPath);
  } catch (e) {
    if (e?.code === 'ENOENT') return { ok: true }; // unlink 竞态：对手已释放
    throw e;
  }
  return { ok: true };
}

export function isLocked(lockPath) {
  return fs.existsSync(lockPath);
}
