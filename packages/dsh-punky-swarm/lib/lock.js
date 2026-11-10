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

// 【N-01 · 纵深防御，**不改锁语义**】`acquire` 是全仓**唯一**对 lockPath 做 `mkdirSync` 的入口：
//   `fs.mkdirSync(path.dirname(lockPath), { recursive: true })` + `openSync(lockPath,'wx')`
//   ⇒ 一条含 `..` 的 lockPath 就能在 `sessions/` 之外**建目录 + 落锁文件**（实测：`<root>/.locks/…`）。
//   上游 `lib/tools/tier-gate.js#lockPath` 已按组件逐个校验（RQ-3 单点）；本函数做**第二道形态兜底**，
//   保证「即使将来有人绕过 lockPath 直接调 acquire」也不会逃出根：判据只看路径**段**，不解释语义。
//   只在校验通过后才 mkdir —— 拒绝路径**零落盘**。token / fence / 接管 / fail-closed 语义一律不动。
function assertLockPathShape(lockPath) {
  if (typeof lockPath !== 'string' || lockPath.length === 0 || lockPath.includes('\u0000')) {
    throw new Error('invalid lockPath: ' + JSON.stringify(lockPath === undefined ? null : lockPath));
  }
  const segments = lockPath.split(/[\\/]+/);
  if (segments.some((s) => s === '..' || s === '.')) {
    throw new Error('invalid lockPath（路径穿越段，拒于 mkdir 之前）: ' + lockPath);
  }
  return lockPath;
}

export async function acquire(lockPath, { waitMs = 0, pollMs = 50, force = false, warn = null, ticketTtlMs = 30000 } = {}) {
  assertLockPathShape(lockPath);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + Math.max(0, waitMs);
  let takeoverAttempted = false;
  for (;;) {
    const token = randomUUID();
    try {
      const fd = fs.openSync(lockPath, 'wx');
      // 【B-03 根因修复】`openSync(...,'wx')` 已成功 ⇒ 该文件是**本进程本次新建**。原实现里
      //   `writeSync` 一旦抛错（ENOSPC / 半写 / 同步异常），盘上就留下空或半截文件：它 parse 不动
      //   ⇒ force 接管与 release 双双 `lock-unparseable` ⇒ 该 lane 锁**永久不可解**；且同路径 fd
      //   从未 close（泄漏）。这里把 write 单列一层 try / finally：finally 是**唯一 close 点**
      //   （成功与失败都关，杜绝泄漏）；写失败 ⇒ close 之后 unlink 本次新建的残骸
      //   （`'wx'` 保证它不可能是任何对手的锁），异常随后自然上抛 —— 不吞异常、不留半截文件。
      let lockWritten = false;
      try {
        fs.writeSync(fd, JSON.stringify({ token, ts: Date.now(), pid: process.pid, fence: 1 }));
        lockWritten = true;
      } finally {
        try { fs.closeSync(fd); } catch {}
        if (!lockWritten) {
          // 失败分支：先关 fd（上一行）再清残骸 —— Windows 上先关再删才稳定
          try { fs.unlinkSync(lockPath); } catch {}
        }
      }
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
      if (cur === null) {
        // 【B-03 提示面】返回体键值与形态**逐字不变**（`f2:118-125`、`f3:90-100` 钉死）；只在返回前
        //   补一条**带锁路径全文**的修复指引 —— 否则调用方只拿到一个 reason 字面量，无路可走。
        if (typeof warn === 'function') {
          warn('[dsh-punky-swarm] lane lock 不可解析（' + REASON_UNPARSEABLE + '）⇒ 拒接管、零删除：' + lockPath
            + ' · 修复：先调 repairUnparseableLock(' + JSON.stringify(lockPath)
            + ') 把残骸移存为 .broken-*（内容零丢失），再重试 acquire');
        }
        return { ok: false, conflict: true, lockPath, reason: REASON_UNPARSEABLE };
      }
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

// 【B-03 提示面】第 3 参可选（向后兼容：全仓既有调用点均为 2 参）。
export function release(lockPath, token, { warn = null } = {}) {
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
  if (cur === null) {
    // 【B-03 提示面】返回体 `{ok:false, reason:'lock-unparseable'}` 逐字不变；只补带路径的修复指引。
    if (typeof warn === 'function') {
      warn('[dsh-punky-swarm] lane lock 不可解析（' + REASON_UNPARSEABLE + '）⇒ 拒释放、零删除：' + lockPath
        + ' · 修复：先调 repairUnparseableLock(' + JSON.stringify(lockPath)
        + ') 把残骸移存为 .broken-*（内容零丢失），再由持有者重试 release 或重新 acquire');
    }
    return { ok: false, reason: REASON_UNPARSEABLE }; // 零删除
  }
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

// 【B-03 修复面】显式修复入口（**新增而非放宽**）：把**不可解析**的锁文件 `rename` 到
//   `<lockPath>.broken-<ISO>`（内容零丢失），之后下一次 `acquire` 即可重建锁。
//   纪律：**不自动调用** —— `acquire(force)` / `release` 对 unparseable 的拒绝与返回值逐字不变
//   （`test/f2-lock-takeover.test.js:107`/`:118-125`、`test/f3-lane-claim-reason.test.js:90-100` 钉死），
//   修复必须由调用方显式发起（或手工删文件）；本函数**幂等**：文件可解析（含 legacy 形态）⇒ 零副作用。
export function repairUnparseableLock(lockPath, { warn = null } = {}) {
  // 复用 acquire 的同一条形态单点（`:106-115`，其语义不动）：拒绝 `..` / `.` / NUL，拒绝路径零落盘。
  //   本函数是全仓**第二条**会动 lockPath 的路径（rename），没有这道兜底就会变成「任意文件搬运」原语。
  assertLockPathShape(lockPath);
  let raw;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { ok: false, reason: 'lock-missing' }; // 没有残骸可修
    throw e;
  }
  if (lockRecordOrNull(raw) !== null) return { ok: false, reason: 'not-unparseable' }; // 幂等：可解析即不动
  // ISO 时间戳含 `:`（Windows 文件名非法）⇒ 换成 `-`，仍可读且毫秒级唯一
  const parked = lockPath + '.broken-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.renameSync(lockPath, parked); // 移动而非删除：残骸内容逐字保留，供事后取证
  const hint = '已移存不可解析锁到 ' + parked + '；下次 acquire 将重建';
  if (typeof warn === 'function') warn('[dsh-punky-swarm] lane lock 修复：' + lockPath + ' ⇒ ' + parked);
  return { ok: true, repaired: true, parked, hint };
}

export function isLocked(lockPath) {
  return fs.existsSync(lockPath);
}
